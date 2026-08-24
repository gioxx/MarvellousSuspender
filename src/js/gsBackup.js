import { gsIndexedDb }        from './gsIndexedDb.js';
import { gsSession }          from './gsSession.js';
import { gsStorage }          from './gsStorage.js';
import { gsUtils }            from './gsUtils.js';
import { PKCE_CLIENT_SECRET } from './gsOauthSecrets.js';

'use strict';

export const gsBackup = (() => {

  const ALARM_NAME         = 'tms-auto-backup';
  const BACKUP_SUBDIR      = 'tms-backups';
  // Seconds segment is optional so filenames written before second-precision was
  // added (minute-only) still match for migration, cleanup and rotation.
  const FILENAME_REGEX_NEW = /^tms-session-([a-f0-9]{8})-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}(?:-\d{2})?)\.json$/;
  const FILENAME_REGEX_OLD = /^tms-session-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}(?:-\d{2})?)\.json$/;
  const DEVICE_FILE_REGEX  = /^tms-device-([a-f0-9]{8})\.json$/;
  const DRIVE_API          = 'https://www.googleapis.com/drive/v3';
  const DRIVE_UPLOAD_API   = 'https://www.googleapis.com/upload/drive/v3';
  const RETRY_ALARM_NAME      = 'tms-pending-backup-retry';
  const RETRY_BACKOFF_MINUTES = [0.5, 2, 10];

  // Shared across every manual "backup now" trigger (backup.html's button, the popup's
  // menu item) so spamming one doesn't bypass a cooldown enforced only by the other.
  // Does not apply to the scheduled ALARM_NAME auto-backup.
  const MANUAL_BACKUP_COOLDOWN_MS  = 30 * 1000;
  const MANUAL_BACKUP_COOLDOWN_KEY = 'tmsManualBackupCooldownUntil';

  async function getManualBackupCooldownRemainingMs() {
    const r     = await chrome.storage.session.get([MANUAL_BACKUP_COOLDOWN_KEY]);
    const until = r[MANUAL_BACKUP_COOLDOWN_KEY] || 0;
    return Math.max(0, until - Date.now());
  }

  async function startManualBackupCooldown() {
    await chrome.storage.session.set({
      [MANUAL_BACKUP_COOLDOWN_KEY]: Date.now() + MANUAL_BACKUP_COOLDOWN_MS,
    });
  }

  async function performManualBackup() {
    if (await getManualBackupCooldownRemainingMs() > 0) {
      throw new Error('TMS_BACKUP_COOLDOWN');
    }
    try {
      return await performBackup();
    } finally {
      await startManualBackupCooldown();
    }
  }

  // ─── device identity ───────────────────────────────────────────────────────

  async function getOrCreateDeviceId() {
    const r = await chrome.storage.local.get(['gsBackupDeviceId']);
    if (r.gsBackupDeviceId) return r.gsBackupDeviceId;
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    await chrome.storage.local.set({ gsBackupDeviceId: id });
    return id;
  }

  async function getDeviceName() {
    const r = await chrome.storage.local.get(['gsBackupDeviceName']);
    return r.gsBackupDeviceName || '';
  }

  async function setDeviceNameLocal(name) {
    await chrome.storage.local.set({ gsBackupDeviceName: name.trim() });
  }

  // ─── shared helpers ────────────────────────────────────────────────────────

  async function buildExportObject(session) {
    const windows = [];
    for (const curWindow of session.windows) {
      const win = { windowId: curWindow.id, tabs: [] };
      for (const curTab of curWindow.tabs) {
        const url = gsUtils.isSuspendedTab(curTab)
          ? gsUtils.getOriginalUrl(curTab.url)
          : curTab.url;
        const title = gsUtils.getCleanTabTitle(curTab);
        win.tabs.push({ url, title, pinned: curTab.pinned, groupId: curTab.groupId });
      }
      windows.push(win);
    }
    return { windows, tabGroups: session.tabGroups };
  }

  function buildTimestamp() {
    const now  = new Date();
    const pad  = (n) => String(n).padStart(2, '0');
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    // Second precision avoids identical filenames (and duplicate tracked download
    // IDs under conflictAction:'overwrite') when two backups fire in the same minute.
    const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    return `${date}T${time}`;
  }

  async function buildFilename() {
    const deviceId  = await getOrCreateDeviceId();
    const ts        = buildTimestamp();
    return {
      sessionFile : `tms-session-${deviceId}-${ts}.json`,
      localPath   : `${BACKUP_SUBDIR}/tms-session-${deviceId}-${ts}.json`,
      deviceId,
    };
  }

  // ─── local backup ──────────────────────────────────────────────────────────

  // chrome.downloads.search `exists` field is unreliable (stale cache) and the
  // `exists: true` query parameter does not filter reliably either. We maintain
  // our own list of download IDs in chrome.storage.local as the single source
  // of truth for counting and rotation.

  async function getTrackedLocalIds() {
    const r = await chrome.storage.local.get(['tmsLocalBackupIds']);
    return r.tmsLocalBackupIds || null; // null = storage never initialised
  }

  async function initTrackedLocalIds(deviceId) {
    const stored = await getTrackedLocalIds();
    if (stored !== null) return stored;
    // One-time migration: seed from downloads history ordered oldest-first
    try {
      const results = await chrome.downloads.search({
        filenameRegex : `${BACKUP_SUBDIR}[/\\\\]tms-session-`,
        orderBy       : ['startTime'],
      });
      const ids = results
        .filter(item => {
          if (item.exists === false) return false; // skip confirmed-gone entries
          const m = FILENAME_REGEX_NEW.exec(item.filename.replace(/\\/g, '/').split('/').pop());
          return m && m[1] === deviceId;
        })
        .map(item => item.id);
      await chrome.storage.local.set({ tmsLocalBackupIds: ids });
      return ids;
    } catch (_) {
      await chrome.storage.local.set({ tmsLocalBackupIds: [] });
      return [];
    }
  }

  async function cleanupOldLocalBackups(maxFiles) {
    try {
      const deviceId = await getOrCreateDeviceId();
      let ids = await initTrackedLocalIds(deviceId);
      if (ids.length <= maxFiles) return;

      const toRemove = ids.slice(0, ids.length - maxFiles); // oldest first
      for (const id of toRemove) {
        try { await chrome.downloads.removeFile(id); } catch (_) {}
        await chrome.downloads.erase({ id });
      }
      ids = ids.slice(ids.length - maxFiles);
      await chrome.storage.local.set({ tmsLocalBackupIds: ids });

      gsUtils.log('gsBackup', `Local cleanup [${deviceId}]: kept ${ids.length}, removed ${toRemove.length}`);
    } catch (e) {
      gsUtils.error('gsBackup', 'cleanupOldLocalBackups failed:', e);
    }
  }

  async function hasDownloadsPermission() {
    return chrome.permissions.contains({ permissions: ['downloads'] });
  }

  async function performLocalBackup(jsonString) {
    if (!(await hasDownloadsPermission())) {
      throw new Error('TMS_DOWNLOADS_PERMISSION_MISSING');
    }
    // data: URL works from service workers; Blob URLs do not survive SW lifecycle
    const base64                      = btoa(unescape(encodeURIComponent(jsonString)));
    const dataUrl                     = `data:application/json;base64,${base64}`;
    const { localPath: filename, deviceId } = await buildFilename();

    const downloadId = await chrome.downloads.download({
      url           : dataUrl,
      filename,
      saveAs        : false,
      conflictAction: 'overwrite',
    });

    // Register the new download in our tracking list before cleanup runs
    const ids = await initTrackedLocalIds(deviceId);
    ids.push(downloadId);
    const shortName = filename.split('/').pop().split('\\').pop();
    await chrome.storage.local.set({
      tmsLocalBackupIds      : ids,
      tmsLocalLastBackup     : new Date().toISOString(),
      tmsLocalLastBackupFile : shortName,
    });

    gsUtils.log('gsBackup', `Local backup saved: ${filename} (id=${downloadId})`);
    const maxFiles = await gsStorage.getOption(gsStorage.AUTO_BACKUP_MAX_FILES);
    await cleanupOldLocalBackups(maxFiles);
    return downloadId;
  }

  // ─── Drive auth ────────────────────────────────────────────────────────────
  //
  // chrome.identity.getAuthToken() is broken on some non-Google Chromium forks
  // (confirmed on Brave, brave/brave-browser#38066, open since May 2024, unassigned;
  // the same "Error 400: invalid_request" pattern is reported on Vivaldi too): Google's
  // OAuth backend now rejects the custom URI scheme these browsers attach to the request,
  // since it only recognises genuine Google Chrome. There's no reliable way to detect
  // "which browsers are affected" up front, and getAuthToken keeps working fine on real
  // Chrome and Edge, so this is handled as a failure-driven fallback rather than browser
  // sniffing: getAuthToken is always tried first (unchanged behaviour, zero impact for
  // installs where it already works), and chrome.identity.launchWebAuthFlow() is only
  // used as a fallback, the first time it succeeds for an install it's remembered so
  // future calls skip straight to it instead of re-probing a method already known to fail.
  //
  // The fallback (#437) uses an authorization-code + PKCE exchange, not the implicit
  // (response_type=token) flow: a plain access token from launchWebAuthFlow only lives
  // ~1h and renewing it silently means re-running launchWebAuthFlow with prompt=none,
  // which depends on the browser's ambient Google session for that tab — unreliable on
  // Brave/Vivaldi and the reported cause of accounts flipping to "disconnected" after
  // 1-2 backups. PKCE gets a long-lived refresh_token once (interactive, one time only),
  // stored in chrome.storage.local; every renewal after that is a direct POST to
  // oauth2.googleapis.com/token — no tab, no cookies, no browser-specific behaviour.
  // Needs its own OAuth client in Google Cloud Console, type "Desktop app" (installed-app
  // clients are treated as public per RFC 8252, so embedding the issued secret is expected
  // and not a confidentiality requirement the way a "Web application" secret would be).
  // Distinct from both the "Chrome App" client getAuthToken() uses and the old implicit-flow
  // "Web application" client (#420, now unused, kept registered for rollback only).

  const AUTH_METHOD_KEY  = 'gsDriveAuthMethod';
  const AUTH_SESSION_KEY = 'tmsDriveAuthSession';
  const AUTH_REFRESH_KEY = 'tmsDriveRefreshToken';
  const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 60 * 1000;
  const OAUTH_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

  // "Web application" OAuth client (#420), reused for the PKCE fallback (#437) — distinct
  // from the "Chrome App" client_id in manifest.json's oauth2 block (getAuthToken()).
  // Reused (not a new dedicated client) because it's the only client type where Google lets
  // you register an arbitrary https redirect URI: a "Desktop app" client was tried first but
  // rejected chrome.identity.getRedirectURL()'s https://<ext-id>.chromiumapp.org/ redirect
  // with redirect_uri_mismatch (verified against the live authorize endpoint — Desktop-app
  // clients only accept loopback/urn:ietf redirects, not arbitrary https domains). Reusing
  // this client_id only changes which registered app performs the OAuth dance; the grant type
  // is still authorization_code + PKCE + refresh_token here, never the old implicit
  // response_type=token flow that caused the original disconnect bug.
  // Registered redirect URI: https://noogafoofpebimajpfpamcfhoaifemoa.chromiumapp.org/
  // KNOWN, ACCEPTED RISK: this client secret ships inside the packaged extension (the
  // CRX/ZIP is trivially unzippable), and — unlike the exempted "Chrome app"/"Desktop
  // app"/mobile client types Google explicitly documents as not needing real secret
  // confidentiality — a "Web application" client's secret has no such carve-out; Google's
  // installed-app guidance for that exemption applies only to those other types. It can't
  // be swapped for one of those instead: "Chrome app" clients only support
  // chrome.identity.getAuthToken() (the very API failing on Brave/Vivaldi this PR exists
  // to fix), and "Desktop app" clients reject launchWebAuthFlow()'s chromiumapp.org
  // redirect (verified live, see above). Accepted deliberately rather than standing up a
  // separate backend just to broker this exchange: a leaked secret only lets a third
  // party register something that authenticates to Google as "this app" (e.g. for a
  // phishing consent screen impersonating it) — it does not expose any existing TMS
  // user's Drive data or tokens, since each user's own refresh_token/access_token never
  // leaves their own browser's storage.
  // gsOauthSecrets.js is a committed placeholder ('REPLACE_ME') so this static import
  // never fails — a dynamic import() here would silently break in this MV3 service
  // worker context specifically (background.js's non-interactive token-refresh path),
  // unlike interactive calls from backup.html's page context, which would keep working
  // and mask the break until the cached access token next expired. Grunt's build
  // pipeline substitutes the real secret (kept in the gitignored gsOauthSecrets.local.js)
  // into the packaged build's own copy of this file — see Gruntfile.js's
  // 'string-replace:oauthSecret' task and 'checkOauthSecrets' guard.
  const PKCE_CLIENT_ID = '630779328171-mge0g9vebmq4pkihhi6gqs9a2agpu07e.apps.googleusercontent.com';

  async function isLikelyBrokenChromeIdentity() {
    // Brave's own chrome.identity.getAuthToken() implementation opens a native,
    // browser-controlled tab that hits Google's servers and visibly shows the raw
    // "Error 400: invalid_request" page before failing, we have no way to suppress or
    // intercept that from extension code. Detecting Brave up front lets us skip the
    // doomed first attempt entirely instead of showing that failure once no matter what.
    try {
      return !!(navigator.brave && await navigator.brave.isBrave());
    } catch (e) {
      return false;
    }
  }

  async function getAuthMethod() {
    const r = await chrome.storage.local.get([AUTH_METHOD_KEY]);
    if (r[AUTH_METHOD_KEY]) return r[AUTH_METHOD_KEY];

    if (await isLikelyBrokenChromeIdentity()) {
      await setAuthMethod('webauthflow');
      return 'webauthflow';
    }
    return 'chrome';
  }

  async function setAuthMethod(method) {
    await chrome.storage.local.set({ [AUTH_METHOD_KEY]: method });
  }

  function getOAuthScope() {
    return chrome.runtime.getManifest().oauth2.scopes.join(' ');
  }

  async function getCachedAuthSession() {
    const r = await chrome.storage.session.get([AUTH_SESSION_KEY]);
    return r[AUTH_SESSION_KEY] || null;
  }

  async function setCachedAuthSession(session) {
    await chrome.storage.session.set({ [AUTH_SESSION_KEY]: session });
  }

  async function clearCachedAuthSession() {
    await chrome.storage.session.remove([AUTH_SESSION_KEY]);
  }

  // Silent/background calls never legitimately show any UI, so a short timeout is always
  // safe there. Interactive calls can legitimately take a while (picking an account, 2FA,
  // actually reading the consent screen), so that timeout is much more generous, it only
  // exists to eventually recover from a genuinely hung callback, not to rush the user.
  const CHROME_IDENTITY_SILENT_TIMEOUT_MS      = 6000;
  const CHROME_IDENTITY_INTERACTIVE_TIMEOUT_MS = 45000;

  function getAuthTokenViaChromeIdentity(interactive) {
    const attempt = new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive }, (token) => {
        if (chrome.runtime.lastError || !token) {
          reject(chrome.runtime.lastError || new Error('No token returned'));
        } else {
          resolve(token);
        }
      });
    });

    // On some Chromium forks (confirmed on Vivaldi with browser sign-in disabled),
    // getAuthToken's callback is never invoked at all rather than firing with an error,
    // "The user turned off browser signin" only ever shows up as an unread
    // chrome.runtime.lastError in the console. Without a timeout that leaves the promise
    // (and the fallback logic that depends on it rejecting) hanging forever.
    const timeoutMs = interactive ? CHROME_IDENTITY_INTERACTIVE_TIMEOUT_MS : CHROME_IDENTITY_SILENT_TIMEOUT_MS;
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('getAuthToken timed out')), timeoutMs);
    });

    return Promise.race([attempt, timeout]);
  }

  function base64UrlEncode(bytes) {
    let str = '';
    for (const b of bytes) str += String.fromCharCode(b);
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function generateCodeVerifier() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return base64UrlEncode(bytes);
  }

  async function generateCodeChallenge(verifier) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return base64UrlEncode(new Uint8Array(digest));
  }

  async function exchangeTokenEndpoint(params) {
    const res = await fetch(OAUTH_TOKEN_ENDPOINT, {
      method : 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body   : new URLSearchParams(params),
    });
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(`OAuth token endpoint error: ${data.error || res.status}`);
      err.status = res.status;
      throw err;
    }
    const session = {
      accessToken: data.access_token,
      expiresAt  : Date.now() + (data.expires_in || 3600) * 1000,
    };
    await setCachedAuthSession(session);
    if (data.refresh_token) {
      await chrome.storage.local.set({ [AUTH_REFRESH_KEY]: data.refresh_token });
    }
    return session.accessToken;
  }

  // Only ever called interactive:true — this opens a real tab for the user to consent,
  // then trades the returned code for tokens via a direct server call (exchangeTokenEndpoint).
  async function authorizeViaPkce() {
    const redirectUri = chrome.identity.getRedirectURL();
    const verifier     = generateCodeVerifier();
    const challenge    = await generateCodeChallenge(verifier);

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id',             PKCE_CLIENT_ID);
    authUrl.searchParams.set('response_type',         'code');
    authUrl.searchParams.set('redirect_uri',          redirectUri);
    authUrl.searchParams.set('scope',                 getOAuthScope());
    authUrl.searchParams.set('access_type',           'offline');
    authUrl.searchParams.set('prompt',                'consent');
    authUrl.searchParams.set('code_challenge',        challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    const redirectUrl = await new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow(
        { url: authUrl.href, interactive: true },
        (url) => {
          if (chrome.runtime.lastError || !url) {
            reject(chrome.runtime.lastError || new Error('No redirect URL returned'));
          } else {
            resolve(url);
          }
        },
      );
    });

    const responseParams = new URL(redirectUrl).searchParams;
    if (responseParams.has('error')) {
      throw new Error(`OAuth error: ${ responseParams.get('error') }`);
    }
    const code = responseParams.get('code');
    if (!code) throw new Error('No authorization code in OAuth redirect');

    return exchangeTokenEndpoint({
      client_id    : PKCE_CLIENT_ID,
      client_secret: PKCE_CLIENT_SECRET,
      code,
      code_verifier: verifier,
      grant_type   : 'authorization_code',
      redirect_uri : redirectUri,
    });
  }

  // No tab, no cookies — a plain POST using the refresh_token minted once by authorizeViaPkce,
  // so it renews the same way on every browser regardless of ambient Google-session state.
  async function refreshAccessToken() {
    const r = await chrome.storage.local.get([AUTH_REFRESH_KEY]);
    const refreshToken = r[AUTH_REFRESH_KEY];
    if (!refreshToken) throw new Error('No refresh token stored');

    try {
      return await exchangeTokenEndpoint({
        client_id    : PKCE_CLIENT_ID,
        client_secret: PKCE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type   : 'refresh_token',
      });
    } catch (e) {
      // 400/401 here means the refresh_token itself is dead (revoked from the Google account,
      // expired from inactivity) — drop it so the next call falls through to a fresh
      // interactive authorization instead of retrying a token that will never work again.
      if (e.status === 400 || e.status === 401) {
        await chrome.storage.local.remove([AUTH_REFRESH_KEY]);
      }
      throw e;
    }
  }

  async function getAuthTokenViaWebAuthFlow(interactive) {
    const cached = await getCachedAuthSession();
    if (cached && cached.expiresAt - TOKEN_EXPIRY_SAFETY_MARGIN_MS > Date.now()) {
      return cached.accessToken;
    }

    try {
      return await refreshAccessToken();
    } catch (refreshError) {
      if (!interactive) throw refreshError;
    }

    return authorizeViaPkce();
  }

  async function getAuthToken(interactive = false) {
    const method = await getAuthMethod();

    if (method === 'webauthflow') {
      return getAuthTokenViaWebAuthFlow(interactive);
    }

    try {
      return await getAuthTokenViaChromeIdentity(interactive);
    } catch (chromeError) {
      // Only attempt the fallback from an explicit, user-gesture-driven "Connect" click.
      // Silent/background calls that fail with the default method just mean "not
      // connected yet" or "token expired", not "this browser needs the fallback" — retrying
      // those with an interactive-only API would be pointless and could surprise the user
      // with an unexpected popup outside of a click handler.
      if (!interactive) throw chromeError;
      const token = await getAuthTokenViaWebAuthFlow(true);
      await setAuthMethod('webauthflow');
      return token;
    }
  }

  async function revokeAuthToken() {
    const method = await getAuthMethod();
    try {
      if (method === 'webauthflow') {
        const r = await chrome.storage.local.get([AUTH_REFRESH_KEY]);
        const cached = await getCachedAuthSession();
        const token = r[AUTH_REFRESH_KEY] || (cached ? cached.accessToken : null);
        if (token) await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`);
        await clearCachedAuthSession();
        await chrome.storage.local.remove([AUTH_REFRESH_KEY]);
      } else {
        const token = await getAuthTokenViaChromeIdentity(false);
        await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`);
        await new Promise((resolve, reject) => {
          chrome.identity.removeCachedAuthToken({ token }, () => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
            else resolve();
          });
        });
      }
      gsUtils.log('gsBackup', 'Drive token revoked.');
    } catch (e) {
      gsUtils.log('gsBackup', 'revokeAuthToken: nothing to revoke or already expired.', e?.message);
      await clearCachedAuthSession();
      await chrome.storage.local.remove([AUTH_REFRESH_KEY]);
    }
  }

  async function getDriveUserInfo() {
    try {
      const token = await getAuthToken(false);
      const res   = await fetch(`${DRIVE_API}/about?fields=user`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.user || null;
    } catch (_) {
      return null;
    }
  }

  // ─── Drive backup ──────────────────────────────────────────────────────────

  async function cleanupOldDriveBackups(token, maxFiles) {
    try {
      const q   = `'appDataFolder' in parents and name contains 'tms-session-'`;
      const res = await fetch(
        `${DRIVE_API}/files?q=${encodeURIComponent(q)}&orderBy=createdTime&fields=files(id,name)&spaces=appDataFolder`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const data  = await res.json();
      const files = data.files || [];

      // Group by deviceId; legacy files (old format, no deviceId) are not rotated
      const byDevice = new Map();
      for (const f of files) {
        const m = FILENAME_REGEX_NEW.exec(f.name);
        if (!m) continue;
        const did = m[1];
        if (!byDevice.has(did)) byDevice.set(did, []);
        byDevice.get(did).push(f);
      }

      // Files are ordered createdTime ASC — oldest first; delete the excess from the front
      const toDelete = [];
      for (const [, deviceFiles] of byDevice) {
        if (deviceFiles.length > maxFiles) {
          toDelete.push(...deviceFiles.slice(0, deviceFiles.length - maxFiles));
        }
      }

      for (const file of toDelete) {
        await fetch(`${DRIVE_API}/files/${file.id}`, {
          method  : 'DELETE',
          headers : { Authorization: `Bearer ${token}` },
        });
      }

      gsUtils.log('gsBackup', `Drive cleanup: removed ${toDelete.length} file(s) across ${byDevice.size} device(s)`);
    } catch (e) {
      gsUtils.error('gsBackup', 'cleanupOldDriveBackups failed:', e);
    }
  }

  async function performDriveBackup(jsonString) {
    let token;
    try { token = await getAuthToken(false); } catch (_) { throw new Error('TMS_DRIVE_AUTH_MISSING'); }

    const { sessionFile, deviceId } = await buildFilename();
    const metadata = JSON.stringify({ name: sessionFile, parents: ['appDataFolder'] });
    const form     = new FormData();
    form.append('metadata', new Blob([metadata], { type: 'application/json' }));
    form.append('file',     new Blob([jsonString], { type: 'application/json' }));

    const res = await fetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart`, {
      method  : 'POST',
      headers : { Authorization: `Bearer ${token}` },
      body    : form,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Drive upload failed: ${res.status} ${err}`);
    }

    const file = await res.json();
    gsUtils.log('gsBackup', `Drive backup saved: ${sessionFile} (id=${file.id})`);

    const maxFiles = await gsStorage.getOption(gsStorage.AUTO_BACKUP_MAX_FILES);
    await cleanupOldDriveBackups(token, maxFiles);
    await updateDeviceRegistry(token, deviceId);
    return file.id;
  }

  // ─── Device registry ──────────────────────────────────────────────────────

  async function updateDeviceRegistry(token, deviceId) {
    const name    = await getDeviceName();
    const payload = JSON.stringify({ name: name || deviceId, lastSeen: new Date().toISOString() });
    await _writeDriveFile(token, `tms-device-${deviceId}.json`, payload);
    gsUtils.log('gsBackup', `Device registry updated: tms-device-${deviceId}.json`);
  }

  async function listDeviceRegistry() {
    let token;
    try { token = await getAuthToken(false); } catch (_) { return {}; }
    try {
      const q   = `'appDataFolder' in parents and name contains 'tms-device-'`;
      const res = await fetch(
        `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=appDataFolder`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const data  = await res.json();
      const files = data.files || [];
      const map   = {};
      await Promise.all(files.map(async (f) => {
        const m = DEVICE_FILE_REGEX.exec(f.name);
        if (!m) return;
        try {
          const r = await fetch(`${DRIVE_API}/files/${f.id}?alt=media`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const d = await r.json();
          map[m[1]] = { name: d.name || m[1], lastSeen: d.lastSeen || null };
        } catch (_) {
          map[m[1]] = { name: m[1], lastSeen: null };
        }
      }));
      return map;
    } catch (_) {
      return {};
    }
  }

  // ─── Drive settings backup ─────────────────────────────────────────────────

  async function performDriveSettingsBackup(jsonString) {
    const token    = await getAuthToken(false);
    const filename = 'tms-settings.json';

    const existing = await _findDriveSettingsFile(token);

    if (existing) {
      try {
        const prevRes = await fetch(`${DRIVE_API}/files/${existing.id}?alt=media`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (prevRes.ok) {
          const prevContent = await prevRes.text();
          await _writeDriveFile(token, 'tms-settings-prev.json', prevContent);
          gsUtils.log('gsBackup', 'Drive settings: previous copy saved to tms-settings-prev.json');
        }
      } catch (e) {
        gsUtils.error('gsBackup', 'Drive settings: failed to save prev copy (continuing anyway):', e);
      }
    }

    const fileId = await _writeDriveFile(token, filename, jsonString);
    gsUtils.log('gsBackup', `Drive settings written: ${filename} (id=${fileId})`);
    return fileId;
  }

  // ─── public API ────────────────────────────────────────────────────────────

  async function flagDriveAuthError() {
    await chrome.storage.local.set({ tmsBackupDriveError: true });
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#C0392B' });
  }

  async function clearDriveAuthError() {
    await chrome.storage.local.remove('tmsBackupDriveError');
    await syncBackupNudgeBadge();
  }

  async function flagDownloadsPermissionMissing() {
    await chrome.storage.local.set({ tmsBackupDownloadsError: true });
    await syncBackupNudgeBadge();
  }

  async function clearDownloadsPermissionMissing() {
    await chrome.storage.local.remove('tmsBackupDownloadsError');
    await syncBackupNudgeBadge();
  }

  async function reconcileDownloadsPermission() {
    const enabled = await gsStorage.getOption(gsStorage.AUTO_BACKUP_ENABLED);
    if (!enabled) {
      await clearDownloadsPermissionMissing();
      return;
    }
    if (await hasDownloadsPermission()) {
      await clearDownloadsPermissionMissing();
    } else {
      await flagDownloadsPermissionMissing();
    }
  }

  async function shouldShowBackupNudge() {
    const [enabled, optOut, dismissedUntil] = await Promise.all([
      gsStorage.getOption(gsStorage.AUTO_BACKUP_ENABLED),
      gsStorage.getOption(gsStorage.BACKUP_NUDGE_OPTOUT),
      gsStorage.getOption(gsStorage.BACKUP_NUDGE_DISMISSED_UNTIL),
    ]);
    if (enabled || optOut) {
      return false;
    }
    return !dismissedUntil || Date.now() > dismissedUntil;
  }

  async function syncBackupNudgeBadge() {
    const { tmsBackupDriveError, tmsBackupDownloadsError } = await chrome.storage.local.get([
      'tmsBackupDriveError',
      'tmsBackupDownloadsError',
    ]);
    if (tmsBackupDriveError || tmsBackupDownloadsError) {
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#C0392B' });
      return;
    }
    if (await shouldShowBackupNudge()) {
      chrome.action.setBadgeText({ text: 'i' });
      chrome.action.setBadgeBackgroundColor({ color: '#D9822B' });
      return;
    }
    chrome.action.setBadgeText({ text: '' });
  }

  async function dismissBackupNudge() {
    const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;
    await gsStorage.setOptionAndSync(gsStorage.BACKUP_NUDGE_DISMISSED_UNTIL, Date.now() + TEN_DAYS_MS);
    await syncBackupNudgeBadge();
  }

  async function optOutBackupNudge() {
    await gsStorage.setOptionAndSync(gsStorage.BACKUP_NUDGE_OPTOUT, true);
    await syncBackupNudgeBadge();
  }

  async function performBackup() {
    if (chrome.extension.inIncognitoContext) {
      gsUtils.log('gsBackup', 'performBackup: skipped — running in a split-incognito context.');
      return;
    }
    try {
      const currentSessionId = await gsSession.getSessionId();
      const session          = await gsIndexedDb.fetchSessionBySessionId(currentSessionId);

      if (!session || !session.windows || session.windows.length === 0) {
        gsUtils.log('gsBackup', 'Nothing to back up — session is empty.');
        return;
      }

      const exportObj    = await buildExportObject(session);
      const jsonString   = JSON.stringify(exportObj, null, 2);
      const destination  = await gsStorage.getOption(gsStorage.AUTO_BACKUP_DESTINATION);

      if (destination === 'drive') {
        const result = await performDriveBackup(jsonString);
        await clearDriveAuthError();
        return result;
      }
      const result = await performLocalBackup(jsonString);
      await clearDownloadsPermissionMissing();
      return result;
    } catch (e) {
      gsUtils.error('gsBackup', 'performBackup failed:', e);
      if (e?.message === 'TMS_DRIVE_AUTH_MISSING') {
        await flagDriveAuthError();
      } else if (e?.message === 'TMS_DOWNLOADS_PERMISSION_MISSING') {
        await flagDownloadsPermissionMissing();
      }
    }
  }

  async function performEmergencyBackup() {
    if (chrome.extension.inIncognitoContext) {
      gsUtils.log('gsBackup', 'performEmergencyBackup: skipped — running in a split-incognito context.');
      return;
    }
    const enabled = await gsStorage.getOption(gsStorage.AUTO_BACKUP_ENABLED);
    if (!enabled) {
      return;
    }
    try {
      const currentSessionId = await gsSession.getSessionId();
      const session          = await gsIndexedDb.fetchSessionBySessionId(currentSessionId);

      if (!session || !session.windows || session.windows.length === 0) {
        gsUtils.log('gsBackup', 'performEmergencyBackup: nothing to back up — session is empty.');
        return;
      }

      const exportObj  = await buildExportObject(session);
      const jsonString = JSON.stringify(exportObj, null, 2);

      const localDownloadId = await performLocalBackup(jsonString);
      await clearDownloadsPermissionMissing();

      const destination = await gsStorage.getOption(gsStorage.AUTO_BACKUP_DESTINATION);
      if (destination === 'drive') {
        await chrome.alarms.clear(RETRY_ALARM_NAME);
        await chrome.storage.local.set({
          tmsPendingDriveBackup: {
            json           : jsonString,
            createdAt      : new Date().toISOString(),
            attempts       : 0,
            localDownloadId,
          },
        });
        gsUtils.log('gsBackup', 'performEmergencyBackup: queued pending Drive backup for retry on next startup.');
      }
    } catch (e) {
      gsUtils.error('gsBackup', 'performEmergencyBackup failed:', e);
      if (e?.message === 'TMS_DOWNLOADS_PERMISSION_MISSING') {
        await flagDownloadsPermissionMissing();
      }
    }
  }

  async function removeLocalBackupFile(downloadId) {
    if (downloadId == null) return;
    try {
      await chrome.downloads.removeFile(downloadId);
    } catch (_) {
      // already gone (e.g. removed by normal AUTO_BACKUP_MAX_FILES rotation) — nothing to do
    }
    try {
      const { tmsLocalBackupIds = [] } = await chrome.storage.local.get('tmsLocalBackupIds');
      const filtered = tmsLocalBackupIds.filter((id) => id !== downloadId);
      if (filtered.length !== tmsLocalBackupIds.length) {
        await chrome.storage.local.set({ tmsLocalBackupIds: filtered });
      }
    } catch (_) {
      // non-fatal — rotation bookkeeping will self-correct on the next local backup
    }
  }

  async function retryPendingDriveBackup() {
    const r       = await chrome.storage.local.get(['tmsPendingDriveBackup']);
    const pending = r.tmsPendingDriveBackup;
    if (!pending) {
      return;
    }

    try {
      await performDriveBackup(pending.json);
      await chrome.storage.local.remove('tmsPendingDriveBackup');
      await clearDriveAuthError();
      await removeLocalBackupFile(pending.localDownloadId);
      gsUtils.log('gsBackup', 'retryPendingDriveBackup: pending backup uploaded successfully.');
    } catch (e) {
      if (e?.message === 'TMS_DRIVE_AUTH_MISSING') {
        await flagDriveAuthError();
        await chrome.storage.local.remove('tmsPendingDriveBackup');
        gsUtils.error('gsBackup', 'retryPendingDriveBackup: Drive auth missing, giving up.', e);
        return;
      }

      const attempts = (pending.attempts || 0) + 1;
      if (attempts > RETRY_BACKOFF_MINUTES.length) {
        await chrome.storage.local.remove('tmsPendingDriveBackup');
        gsUtils.error('gsBackup', 'retryPendingDriveBackup: giving up after max retries.', e);
        return;
      }

      await chrome.storage.local.set({
        tmsPendingDriveBackup: { ...pending, attempts },
      });
      const delayInMinutes = RETRY_BACKOFF_MINUTES[attempts - 1];
      chrome.alarms.create(RETRY_ALARM_NAME, { delayInMinutes });
      gsUtils.error('gsBackup', `retryPendingDriveBackup: failed (attempt ${attempts}), retrying in ${delayInMinutes}min.`, e);
    }
  }

  async function scheduleBackup(intervalHours) {
    const periodInMinutes = parseFloat(intervalHours) * 60;
    await chrome.alarms.clear(ALARM_NAME);

    let when;
    if (parseFloat(intervalHours) === 24) {
      const dailyTime = await gsStorage.getOption(gsStorage.AUTO_BACKUP_TIME) || '09:00';
      const [h, m]    = dailyTime.split(':').map(Number);
      const next      = new Date();
      next.setHours(h, m, 0, 0);
      if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
      when = next.getTime();
    } else {
      const periodMs = periodInMinutes * 60_000;
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      const elapsed  = Date.now() - midnight.getTime();
      when = midnight.getTime() + Math.ceil(elapsed / periodMs) * periodMs;
    }

    chrome.alarms.create(ALARM_NAME, { when, periodInMinutes });
    gsUtils.log('gsBackup', `Alarm set every ${intervalHours}h (${periodInMinutes}m), first fire: ${new Date(when).toLocaleTimeString()}`);
  }

  async function cancelBackup() {
    await chrome.alarms.clear(ALARM_NAME);
    gsUtils.log('gsBackup', 'Alarm cleared.');
  }

  async function syncAlarmWithSettings() {
    const enabled = await gsStorage.getOption(gsStorage.AUTO_BACKUP_ENABLED);
    const interval = await gsStorage.getOption(gsStorage.AUTO_BACKUP_INTERVAL);
    if (enabled) {
      const existingAlarm = await chrome.alarms.get(ALARM_NAME);
      if (!existingAlarm) {
        await scheduleBackup(interval);
      }
    } else {
      await cancelBackup();
    }
  }

  async function getDriveFolderUrl() {
    return null;
  }

  // ─── Restore from backup ───────────────────────────────────────────────────

  async function listDriveBackups() {
    let token;
    try { token = await getAuthToken(false); } catch (_) { throw new Error('TMS_DRIVE_AUTH_MISSING'); }
    const q   = `'appDataFolder' in parents and name contains 'tms-session-'`;
    const res = await fetch(
      `${DRIVE_API}/files?q=${encodeURIComponent(q)}&orderBy=createdTime desc&fields=files(id,name,createdTime,size)&spaces=appDataFolder`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`Drive list failed: ${res.status}`);
    const data = await res.json();
    return (data.files || [])
      .filter(f => FILENAME_REGEX_NEW.test(f.name) || FILENAME_REGEX_OLD.test(f.name))
      .map(f => {
        const m = FILENAME_REGEX_NEW.exec(f.name);
        return { ...f, deviceId: m ? m[1] : null };
      });
  }

  async function deleteDriveBackup(fileId) {
    let token;
    try { token = await getAuthToken(false); } catch (_) { throw new Error('TMS_DRIVE_AUTH_MISSING'); }
    const res = await fetch(`${DRIVE_API}/files/${fileId}`, {
      method  : 'DELETE',
      headers : { Authorization: `Bearer ${token}` },
    });
    if (!res.ok && res.status !== 204) throw new Error(`Drive delete failed: ${res.status}`);
  }

  async function downloadDriveBackupAsFile(fileId, filename) {
    let token;
    try { token = await getAuthToken(false); } catch (_) { throw new Error('TMS_DRIVE_AUTH_MISSING'); }
    const res = await fetch(`${DRIVE_API}/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Drive download failed: ${res.status}`);
    const text    = await res.text();
    const base64  = btoa(unescape(encodeURIComponent(text)));
    const dataUrl = `data:application/json;base64,${base64}`;
    await chrome.downloads.download({
      url            : dataUrl,
      filename,
      saveAs         : false,
      conflictAction : 'uniquify',
    });
  }

  async function downloadDriveBackupContent(fileId) {
    let token;
    try { token = await getAuthToken(false); } catch (_) { throw new Error('TMS_DRIVE_AUTH_MISSING'); }
    const res = await fetch(`${DRIVE_API}/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Drive download failed: ${res.status}`);
    return await res.text();
  }

  async function _findDriveSettingsFile(token) {
    const q   = `'appDataFolder' in parents and name='tms-settings.json'`;
    const res = await fetch(`${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,modifiedTime)&spaces=appDataFolder`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { files } = await res.json();
    return (files && files.length > 0) ? files[0] : null;
  }

  async function _writeDriveFile(token, filename, jsonString) {
    const q      = `'appDataFolder' in parents and name='${filename}'`;
    const search = await fetch(`${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=appDataFolder`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { files } = await search.json();
    const existing  = files && files[0];

    if (existing) {
      const res = await fetch(`${DRIVE_UPLOAD_API}/files/${existing.id}?uploadType=media`, {
        method  : 'PATCH',
        headers : { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body    : jsonString,
      });
      if (!res.ok) throw new Error(`Drive file update failed (${filename}): ${res.status}`);
      return (await res.json()).id;
    } else {
      const metadata = JSON.stringify({ name: filename, parents: ['appDataFolder'] });
      const form     = new FormData();
      form.append('metadata', new Blob([metadata], { type: 'application/json' }));
      form.append('file', new Blob([jsonString], { type: 'application/json' }));
      const res = await fetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart`, {
        method  : 'POST',
        headers : { Authorization: `Bearer ${token}` },
        body    : form,
      });
      if (!res.ok) throw new Error(`Drive file create failed (${filename}): ${res.status}`);
      return (await res.json()).id;
    }
  }

  async function getDriveSettingsInfo() {
    let token;
    try { token = await getAuthToken(false); } catch (_) { throw new Error('TMS_DRIVE_AUTH_MISSING'); }
    return await _findDriveSettingsFile(token);
  }

  async function downloadDriveSettingsContent() {
    let token;
    try { token = await getAuthToken(false); } catch (_) { throw new Error('TMS_DRIVE_AUTH_MISSING'); }
    const file = await _findDriveSettingsFile(token);
    if (!file) throw new Error('TMS_SETTINGS_NOT_FOUND');
    const download = await fetch(`${DRIVE_API}/files/${file.id}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!download.ok) throw new Error(`Drive settings download failed: ${download.status}`);
    return await download.text();
  }

  function _prettyNameFromSource(sourceName) {
    const m = sourceName.match(/tms-session-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})\.json$/);
    if (m) return `Backup ${m[1]} ${m[2]}:${m[3]}`;
    return sourceName.replace(/\.json$/i, '');
  }

  async function importBackupJson(jsonText, sourceName) {
    let importObj;
    try { importObj = JSON.parse(jsonText); } catch (_) { throw new Error('TMS_IMPORT_INVALID_JSON'); }
    if (!importObj || !Array.isArray(importObj.windows) || importObj.windows.length === 0) {
      throw new Error('TMS_IMPORT_EMPTY');
    }

    const sessionName = _prettyNameFromSource(sourceName);
    const sessionId   = '_' + gsUtils.generateHashCode(sessionName);

    const windows = [];
    for (const win of importObj.windows) {
      if (!win || !Array.isArray(win.tabs)) continue; // skip malformed windows instead of throwing
      const curWindow = { id: sessionId + '_' + windows.length, tabs: [] };
      for (const tab of win.tabs) {
        curWindow.tabs.push({
          windowId : curWindow.id,
          sessionId,
          id       : curWindow.id + '_' + curWindow.tabs.length,
          url      : tab.url,
          title    : tab.title || tab.url,
          index    : curWindow.tabs.length,
          pinned   : tab.pinned || false,
          groupId  : tab.groupId,
        });
      }
      windows.push(curWindow);
    }

    if (windows.length === 0) throw new Error('TMS_IMPORT_EMPTY');

    await gsIndexedDb.addToSavedSessions({
      name      : sessionName,
      sessionId,
      windows,
      tabGroups : importObj.tabGroups || [],
      date      : new Date().toISOString(),
    });

    gsUtils.log('gsBackup', `importBackupJson: imported "${sessionName}" (${windows.length} windows)`);
    return sessionName;
  }

  async function countLocalBackups() {
    try {
      const deviceId = await getOrCreateDeviceId();
      const ids = await initTrackedLocalIds(deviceId);
      return ids.length;
    } catch (_) {
      return 0;
    }
  }

  return {
    ALARM_NAME,
    RETRY_ALARM_NAME,
    performBackup,
    performManualBackup,
    getManualBackupCooldownRemainingMs,
    MANUAL_BACKUP_COOLDOWN_MS,
    performEmergencyBackup,
    retryPendingDriveBackup,
    scheduleBackup,
    cancelBackup,
    syncAlarmWithSettings,
    shouldShowBackupNudge,
    syncBackupNudgeBadge,
    dismissBackupNudge,
    optOutBackupNudge,
    hasDownloadsPermission,
    reconcileDownloadsPermission,
    getAuthToken,
    getDriveAuthMethod : getAuthMethod,
    revokeAuthToken,
    getDriveUserInfo,
    getDriveFolderUrl,
    performDriveSettingsBackup,
    listDriveBackups,
    listDeviceRegistry,
    downloadDriveBackupContent,
    downloadDriveBackupAsFile,
    deleteDriveBackup,
    getDriveSettingsInfo,
    downloadDriveSettingsContent,
    importBackupJson,
    countLocalBackups,
    getLastLocalBackupInfo : async () => {
      const r = await chrome.storage.local.get(['tmsLocalLastBackup', 'tmsLocalLastBackupFile']);
      return {
        time     : r.tmsLocalLastBackup     || null,
        filename : r.tmsLocalLastBackupFile || null,
      };
    },
    getDeviceId   : getOrCreateDeviceId,
    getDeviceName,
    setDeviceName : setDeviceNameLocal,
  };

})();
