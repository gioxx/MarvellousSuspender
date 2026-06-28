import { gsIndexedDb } from './gsIndexedDb.js';
import { gsSession }   from './gsSession.js';
import { gsStorage }   from './gsStorage.js';
import { gsUtils }     from './gsUtils.js';

'use strict';

export const gsBackup = (() => {

  const ALARM_NAME        = 'tms-auto-backup';
  const MAX_BACKUPS       = 10;
  const BACKUP_SUBDIR     = 'tms-backups';
  const FILENAME_REGEX    = /tms-session-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}\.json$/;
const DRIVE_API         = 'https://www.googleapis.com/drive/v3';
  const DRIVE_UPLOAD_API  = 'https://www.googleapis.com/upload/drive/v3';

  // ─── shared helpers ────────────────────────────────────────────────────────

  async function buildExportObject(session) {
    const windows = [];
    for (const curWindow of session.windows) {
      const win = { windowId: curWindow.id, tabs: [] };
      for (const curTab of curWindow.tabs) {
        const url = gsUtils.isSuspendedTab(curTab)
          ? gsUtils.getOriginalUrl(curTab.url)
          : curTab.url;
        win.tabs.push({ url, groupId: curTab.groupId });
      }
      windows.push(win);
    }
    return { windows, tabGroups: session.tabGroups };
  }

  function buildTimestamp() {
    const now  = new Date();
    const pad  = (n) => String(n).padStart(2, '0');
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}-${pad(now.getMinutes())}`;
    return `${date}T${time}`;
  }

  // ─── local backup ──────────────────────────────────────────────────────────

  async function cleanupOldLocalBackups() {
    try {
      const results = await chrome.downloads.search({
        filenameRegex : `${BACKUP_SUBDIR}/tms-session-`,
        orderBy       : ['-startTime'],
      });

      const ours = results.filter(item => FILENAME_REGEX.test(item.filename));

      for (const item of ours.slice(MAX_BACKUPS)) {
        try {
          await chrome.downloads.removeFile(item.id);
        } catch (_) {
          // file may have been moved or already deleted — ignore
        }
        await chrome.downloads.erase({ id: item.id });
      }

      gsUtils.log('gsBackup', `Local cleanup: kept ${Math.min(ours.length, MAX_BACKUPS)}, removed ${Math.max(0, ours.length - MAX_BACKUPS)}`);
    } catch (e) {
      gsUtils.error('gsBackup', 'cleanupOldLocalBackups failed:', e);
    }
  }

  async function performLocalBackup(jsonString) {
    // data: URL works from service workers; Blob URLs do not survive SW lifecycle
    const base64     = btoa(unescape(encodeURIComponent(jsonString)));
    const dataUrl    = `data:application/json;base64,${base64}`;
    const filename   = `${BACKUP_SUBDIR}/tms-session-${buildTimestamp()}.json`;

    const downloadId = await chrome.downloads.download({
      url           : dataUrl,
      filename,
      saveAs        : false,
      conflictAction: 'overwrite',
    });

    gsUtils.log('gsBackup', `Local backup saved: ${filename} (id=${downloadId})`);
    await cleanupOldLocalBackups();
    return downloadId;
  }

  // ─── Drive auth ────────────────────────────────────────────────────────────

  async function getAuthToken(interactive = false) {
    return new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive }, (token) => {
        if (chrome.runtime.lastError || !token) {
          reject(chrome.runtime.lastError || new Error('No token returned'));
        } else {
          resolve(token);
        }
      });
    });
  }

  async function revokeAuthToken() {
    try {
      const token = await getAuthToken(false);
      await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`);
      await new Promise((resolve, reject) => {
        chrome.identity.removeCachedAuthToken({ token }, () => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve();
        });
      });
      gsUtils.log('gsBackup', 'Drive token revoked.');
    } catch (e) {
      gsUtils.log('gsBackup', 'revokeAuthToken: nothing to revoke or already expired.', e?.message);
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

  async function cleanupOldDriveBackups(token) {
    try {
      const q   = `'appDataFolder' in parents and name contains 'tms-session-'`;
      const res = await fetch(
        `${DRIVE_API}/files?q=${encodeURIComponent(q)}&orderBy=createdTime&fields=files(id,name)&spaces=appDataFolder`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const data  = await res.json();
      const files = data.files || [];

      const toDelete = files.slice(0, Math.max(0, files.length - MAX_BACKUPS));
      for (const file of toDelete) {
        await fetch(`${DRIVE_API}/files/${file.id}`, {
          method  : 'DELETE',
          headers : { Authorization: `Bearer ${token}` },
        });
      }

      gsUtils.log('gsBackup', `Drive cleanup: kept ${Math.min(files.length, MAX_BACKUPS)}, removed ${toDelete.length}`);
    } catch (e) {
      gsUtils.error('gsBackup', 'cleanupOldDriveBackups failed:', e);
    }
  }

  async function performDriveBackup(jsonString) {
    let token;
    try {
      token = await getAuthToken(false);
    } catch (_) {
      throw new Error('TMS_DRIVE_AUTH_MISSING');
    }
    const filename = `tms-session-${buildTimestamp()}.json`;

    const metadata = JSON.stringify({ name: filename, parents: ['appDataFolder'] });
    const body     = new Blob([jsonString], { type: 'application/json' });

    const form = new FormData();
    form.append('metadata', new Blob([metadata], { type: 'application/json' }));
    form.append('file', body);

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
    gsUtils.log('gsBackup', `Drive backup saved: ${filename} (id=${file.id})`);
    await cleanupOldDriveBackups(token);
    return file.id;
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
    chrome.action.setBadgeText({ text: '' });
  }

  async function performBackup() {
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
      return await performLocalBackup(jsonString);
    } catch (e) {
      gsUtils.error('gsBackup', 'performBackup failed:', e);
      if (e?.message === 'TMS_DRIVE_AUTH_MISSING') {
        await flagDriveAuthError();
      }
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
      `${DRIVE_API}/files?q=${encodeURIComponent(q)}&orderBy=createdTime desc&fields=files(id,name,createdTime)&spaces=appDataFolder`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`Drive list failed: ${res.status}`);
    const data = await res.json();
    return (data.files || []).filter(f => FILENAME_REGEX.test(f.name));
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
      const curWindow = { id: sessionId + '_' + windows.length, tabs: [] };
      for (const tab of win.tabs) {
        curWindow.tabs.push({
          windowId : curWindow.id,
          sessionId,
          id       : curWindow.id + '_' + curWindow.tabs.length,
          url      : tab.url,
          title    : tab.title || tab.url,
          index    : curWindow.tabs.length,
          pinned   : false,
          groupId  : tab.groupId,
        });
      }
      windows.push(curWindow);
    }

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

  return {
    ALARM_NAME,
    performBackup,
    scheduleBackup,
    cancelBackup,
    syncAlarmWithSettings,
    getAuthToken,
    revokeAuthToken,
    getDriveUserInfo,
    getDriveFolderUrl,
    performDriveSettingsBackup,
    listDriveBackups,
    downloadDriveBackupContent,
    getDriveSettingsInfo,
    downloadDriveSettingsContent,
    importBackupJson,
  };

})();
