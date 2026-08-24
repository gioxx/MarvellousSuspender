// @ts-check
import  { gsBackup }              from './gsBackup.js';
import  { gsChrome }              from './gsChrome.js';
import  { gsFavicon }             from './gsFavicon.js';
import  { gsIndexedDb }           from './gsIndexedDb.js';
import  { gsNewsFeed }            from './gsNewsFeed.js';
import  { gsStorage }             from './gsStorage.js';
import  { gsTabCheckManager }     from './gsTabCheckManager.js';
import  { gsUtils }               from './gsUtils.js';
import  { tgs }                   from './tgs.js';

(() => {

  const browser = navigator.userAgent.match(/Chrome\/.*Edg\//i) ? 'edge' : 'chrome';

  // ── Tab profiler ────────────────────────────────────────────────────────────────────────────────

  function formatTimer(totalSeconds) {
    if (totalSeconds < 0) totalSeconds = 0;
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0
      ? `${h}:${mm}:${ss}`
      : `${mm}:${ss}`;
  }

  function generateTabInfo(info) {
    const rawSeconds =
      info && info.timerUp && info.timerUp !== '-'
        ? Math.round((new Date(info.timerUp).valueOf() - new Date().valueOf()) / 1000)
        : null;
    const timerStr    = rawSeconds !== null ? formatTimer(rawSeconds) : '-';
    const timerTitle  = rawSeconds !== null ? `${rawSeconds}s` : '';
    const windowId   = info && info.windowId  ? info.windowId        : '?';
    const tabId      = info && info.tabId     ? info.tabId           : '?';
    const tabIndex   = info && info.tab       ? info.tab.index       : '?';
    const tabTitle   = info && info.tab       ? gsUtils.htmlEncode(info.tab.title) : '?';
    const tabStatus  = info ? info.status : '?';
    const groupName  = info && info.group     ? info.group.title     : '';
    const groupColor = info && info.group     ? info.group.color     : '';
    const groupSpan  = groupName ? `<span class="group ${browser} ${groupColor}">${groupName}</span>` : '';

    let favicon = info && info.tab ? info.tab.favIconUrl : '';
    favicon = favicon && favicon.indexOf('data') === 0 ? favicon : gsFavicon.getChromeFavIconUrl(info.tab.url);

    return `<tr>
      <td>${windowId}</td>
      <td>${tabId}</td>
      <td>${tabIndex}</td>
      <td><img src="${favicon}"></td>
      <td class="center">${groupSpan}</td>
      <td>${tabTitle}</td>
      <td title="${timerTitle}">${timerStr}</td>
      <td>${tabStatus}</td>
    </tr>`;
  }

  async function promiseWithTimeout(promise, ms, ret) {
    let timeoutId;

    const timeoutPromise = new Promise((resolve) => {
      timeoutId = setTimeout(() => {
        resolve(ret);
      }, ms);
    });

    return Promise.race([promise, timeoutPromise])
      .finally(() => { clearTimeout(timeoutId); });
  }

  async function getDebugInfo(tabId, callback) {

    const alarm = await chrome.alarms.get(String(tabId));
    const tab   = await chrome.tabs.get(tabId);

    const info  = {
      windowId  : tab.windowId,
      tabId     : tab.id,
      groupId   : tab.groupId,
      status    : gsUtils.STATUS_UNKNOWN,
      timerUp   : alarm ? alarm.scheduledTime : '-',
    };

    if (chrome.runtime.lastError) {
      gsUtils.error(tabId, chrome.runtime.lastError);
      callback(info);
      return;
    }

    if (gsUtils.isNormalTab(tab, true)) {
      gsUtils.highlight(tab.id, 'getDebugInfo', tab.url);
      // Routed through the same responsiveness-check queue tgs.js's own periodic checks
      // use (gsTabCheckManager), rather than a one-shot sendRequestInfoToContentScript
      // here: a tab whose content script has genuinely died (page still alive, script
      // just stopped responding — distinct from a discarded tab) previously had no way to
      // recover via this page, since only checkQueue's own scheduled runs ever attempt
      // reinjection, and this call didn't feed into that queue at all. Live testing showed
      // the same handful of tabs stuck reporting "unknown" for many minutes, surviving
      // repeated manual page reloads, because nothing here ever gave them a real second
      // chance. queueTabCheckAsPromise() does (deduping against an already-queued check
      // for the same tab, so calling it on every profiler refresh doesn't pile up
      // duplicate work) — and also means calculateTabStatus() below no longer needs to
      // probe the content script a second time itself, since it skips its own attempt
      // once given a known status.
      gsTabCheckManager.queueTabCheckAsPromise(tab).then((contentScriptStatus) => {
        gsUtils.highlight(tab.id, 'getDebugInfo callback', tab.url);
        tgs.calculateTabStatus(tab, contentScriptStatus, (status) => {
          info.status = status;
          callback(info);
        });
      });
    }
    else {
      tgs.calculateTabStatus(tab, null, (status) => {
        info.status = status;
        callback(info);
      });
    }
  }

  // window's 'focus' listener below has no debounce, and Chrome/the OS can genuinely fire
  // several 'focus' events on this page in quick succession (multi-monitor setups, rapid
  // alt-tabbing, etc.) — without this guard, each one kicks off its own full fetchTabInfo()
  // run, and every one of those calls getDebugInfo() (and, for every "normal" tab among
  // them, a real getRequestInfoToContentScript() round trip) for every currently open tab
  // again, all overlapping. Confirmed via a live debug report: a burst of duplicate
  // "getDebugInfo"/"getDebugInfo callback" log lines for the same tab within the same
  // millisecond, repeated roughly once per stray focus event.
  //
  // A later call arriving while one is already in flight isn't simply dropped, though: the
  // in-flight run's tabsQuery() snapshot was taken before that later call arrived, so if the
  // user left and came back (opened/closed/changed a tab) inside that window, the in-flight
  // run's result is already stale by the time it renders. One follow-up run is queued to
  // pick up the fresh state afterwards — further calls arriving while that follow-up is
  // already queued are still coalesced into it, so a rapid burst still only ever produces at
  // most one extra run, not one per stray event.
  let _fetchingTabInfo = false;
  let _fetchTabInfoPending = false;

  async function fetchTabInfo() {
    if (_fetchingTabInfo) {
      _fetchTabInfoPending = true;
      return;
    }
    _fetchingTabInfo = true;
    try {
      do {
        _fetchTabInfoPending = false;
        const tabs = await gsChrome.tabsQuery();
        const tabGroupsMap = await gsChrome.tabGroupsMap();
        const debugInfos = await Promise.all(
          tabs.map((curTab) =>
            promiseWithTimeout(
              new Promise((resolve) =>
                getDebugInfo(curTab.id, (info) => {
                  info.tab   = curTab;
                  info.group = tabGroupsMap[info.groupId];
                  resolve(info);
                })
              ), 500, {
                windowId  : curTab.windowId,
                tabId     : curTab.id,
                groupId   : curTab.groupId,
                status    : gsUtils.STATUS_UNKNOWN,
                tab       : curTab,
              }
            )
          )
        );

        document.getElementById('gsProfilerBody').innerHTML =
          debugInfos.map(generateTabInfo).join('\n');
      } while (_fetchTabInfoPending);
    }
    finally {
      _fetchingTabInfo = false;
    }
  }

  // ── Log buffer ──────────────────────────────────────────────────────────────

  async function readLogBuffer() {
    const result = await chrome.storage.local.get([gsStorage.LOG_BUFFER]);
    try {
      return JSON.parse(result[gsStorage.LOG_BUFFER] || '[]');
    } catch {
      return [];
    }
  }

  // Report/copy pull from the larger rotating buffer, not the 500-entry one the live
  // view renders — on a heavy profile (hundreds of tabs), background auto-suspend/
  // discard noise alone can evict the 500-entry window in a couple of minutes, well
  // before a reporter gets to actually download it.
  async function readLogBufferFull() {
    const result = await chrome.storage.local.get([gsStorage.LOG_BUFFER_FULL]);
    try {
      return JSON.parse(result[gsStorage.LOG_BUFFER_FULL] || '[]');
    } catch {
      return [];
    }
  }

  function levelLabel(level) {
    if (level === 'E') return '<span class="logLevel logLevel-E">ERR</span>';
    if (level === 'W') return '<span class="logLevel logLevel-W">WRN</span>';
    return '<span class="logLevel logLevel-I">LOG</span>';
  }

  // entry.ts is stored as UTC (new Date().toISOString() in gsUtils.js) so the raw
  // history is unambiguous no matter what machine reads it back; render it in the
  // viewer's own local time here instead, since a debug tester reading the live log
  // wants "when did this just happen on my clock", not a UTC offset they have to do
  // math on.
  function formatLocalTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '??:??:??';
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  }

  function renderLogEntry(entry) {
    const time = entry.ts ? formatLocalTime(entry.ts) : '??:??:??';
    const src  = gsUtils.htmlEncode(String(entry.src || ''));
    const msg  = gsUtils.htmlEncode(String(entry.msg || ''));
    return `<div class="logLine logLine-${entry.level}">${levelLabel(entry.level)}<span class="logTime">${time}</span><span class="logSrc">${src}</span><span class="logMsg">${msg}</span></div>`;
  }

  async function refreshLogs() {
    const [buffer, bufferFull] = await Promise.all([readLogBuffer(), readLogBufferFull()]);
    const output     = document.getElementById('logOutput');
    const counter    = document.getElementById('logCount');
    const counterFull = document.getElementById('logCountFull');
    counter.textContent = buffer.length;
    counterFull.textContent = bufferFull.length;
    if (buffer.length === 0) {
      output.innerHTML = '<div class="logEmpty">No entries. Errors are always captured automatically. Enable <strong>captureLogs</strong> above to also capture warnings and verbose logs, then reproduce the issue.</div>';
    } else if (output.classList.contains('warnErrOnly') && !buffer.some(e => e.level === 'W' || e.level === 'E')) {
      output.innerHTML = '<div class="logEmpty">No warnings or errors in the current buffer.</div>';
    } else {
      output.innerHTML = buffer.map(renderLogEntry).join('');
      output.scrollTop = output.scrollHeight;
    }
  }

  // ── Report generation ───────────────────────────────────────────────────────

  // full=true (Download) pulls the large rotating buffer for a complete history;
  // full=false (Copy) sticks to the 500-entry live buffer — nobody pastes a 10,000-line
  // clipboard payload anywhere useful, so Copy stays cheap and matches what's on screen.
  async function buildReport(full) {
    const manifest = chrome.runtime.getManifest();
    const buffer   = full ? await readLogBufferFull() : await readLogBuffer();
    const tabs     = await gsChrome.tabsQuery();
    const tabGroupsMap = await gsChrome.tabGroupsMap();

    const debugInfos = await Promise.all(
      tabs.map((curTab) =>
        promiseWithTimeout(
          new Promise((resolve) =>
            getDebugInfo(curTab.id, (info) => {
              info.tab   = curTab;
              info.group = tabGroupsMap[info.groupId];
              resolve(info);
            })
          ), 500, {
            windowId  : curTab.windowId,
            tabId     : curTab.id,
            groupId   : curTab.groupId,
            status    : gsUtils.STATUS_UNKNOWN,
            tab       : curTab,
          }
        )
      )
    );

    const lines = [];
    lines.push(`=== The Marvellous Suspender: Diagnostic Report ===`);
    lines.push(`Generated : ${new Date().toISOString()}`);
    lines.push(`Extension : v${manifest.version}`);
    lines.push(`Browser   : ${navigator.userAgent}`);
    lines.push('');
    lines.push('=== Tab Status ===');
    lines.push('WinId\tTabId\tIdx\tStatus\tTimer(s)\tTitle');
    for (const info of debugInfos) {
      if (!info.tab) continue;
      const timer = info.timerUp && info.timerUp !== '-'
        ? Math.round((new Date(info.timerUp).valueOf() - new Date().valueOf()) / 1000)
        : '-';
      lines.push(`${info.windowId}\t${info.tabId}\t${info.tab.index}\t${info.status}\t${timer}\t${info.tab.title}`);
    }
    lines.push('');
    lines.push(`=== Log Buffer (${buffer.length} entries) ===`);
    for (const entry of buffer) {
      lines.push(`[${entry.ts}] [${entry.level}] ${entry.src}: ${entry.msg}`);
    }
    return lines.join('\n');
  }

  // ── Capture toggle ───────────────────────────────────────────────────────────────────────────

  async function renderCaptureToggle() {
    const { gsCaptureVerbose } = await chrome.storage.local.get(['gsCaptureVerbose']);
    const el = document.getElementById('toggleCaptureLogs');
    el.textContent = gsCaptureVerbose ? 'true' : 'false';
    el.dataset.value = gsCaptureVerbose ? 'true' : 'false';
  }

  async function onToggleCaptureLogs(e) {
    e.preventDefault();
    const el      = document.getElementById('toggleCaptureLogs');
    const newVal  = el.dataset.value !== 'true';
    el.textContent   = String(newVal);
    el.dataset.value = String(newVal);
    await chrome.storage.local.set({ gsCaptureVerbose: newVal });
    // Wake the Service Worker and update its in-memory flag
    chrome.runtime.sendMessage({ action: 'setCaptureLogs', value: newVal }).catch(() => {});
  }

  // ── Discard-in-place toggle ─────────────────────────────────────────────────────────────

  async function renderDiscardToggle() {
    const val = await gsStorage.getOption(gsStorage.DISCARD_IN_PLACE_OF_SUSPEND);
    const el  = document.getElementById('toggleDiscardInPlaceOfSuspend');
    el.textContent   = String(val);
    el.dataset.value = String(val);
  }

  async function onToggleDiscard(e) {
    e.preventDefault();
    const el     = document.getElementById('toggleDiscardInPlaceOfSuspend');
    const newVal = el.dataset.value !== 'true';
    el.textContent   = String(newVal);
    el.dataset.value = String(newVal);
    await gsStorage.setOptionAndSync(gsStorage.DISCARD_IN_PLACE_OF_SUSPEND, newVal);
  }

  // ── News feed ────────────────────────────────────────────────────────────────────────────

  async function renderNewsFeedStatus() {
    const feed        = await gsNewsFeed.getCachedFeed();
    const alarm       = await chrome.alarms.get(gsNewsFeed.ALARM_NAME);
    const offsetData  = await chrome.storage.local.get('tmsNewsFeedMinuteOffset');
    const lastFetchEl = document.getElementById('newsFeedLastFetch');
    const unreadEl    = document.getElementById('newsFeedUnread');
    const nextRunEl   = document.getElementById('newsFeedNextRun');
    const jitterEl    = document.getElementById('newsFeedJitter');
    lastFetchEl.textContent = feed.fetchedAt ? new Date(feed.fetchedAt).toLocaleString() : 'never';
    const unreadCount = feed.items.filter(i => !(feed.seenIds ?? []).includes(i.link)).length;
    unreadEl.textContent  = `${unreadCount} / ${feed.items.length}`;
    nextRunEl.textContent = alarm ? new Date(alarm.scheduledTime).toLocaleString() : 'not scheduled';
    const offset = offsetData['tmsNewsFeedMinuteOffset'];
    if (typeof offset === 'number') {
      const h = String(Math.floor(offset / 60)).padStart(2, '0');
      const m = String(offset % 60).padStart(2, '0');
      jitterEl.textContent = `daily at ${h}:${m} local`;
    } else {
      jitterEl.textContent = 'not yet assigned';
    }
  }

  async function onForceNewsFeedRefresh(e) {
    e.preventDefault();
    const link = document.getElementById('forceNewsFeedRefresh');
    link.textContent = 'refreshing…';
    await gsNewsFeed.fetchAndCache();
    await renderNewsFeedStatus();
    link.textContent = 'done!';
    setTimeout(() => { link.textContent = 'force refresh'; }, 2000);
  }

  async function onSimulateUnread(e) {
    e.preventDefault();
    const feed = await gsNewsFeed.getCachedFeed();
    if (!feed.items.length) return;
    const latest  = feed.items[0];
    const seenIds = (feed.seenIds ?? []).filter(id => id !== latest.link);
    await chrome.storage.local.set({ tmsNewsFeed: { ...feed, seenIds } });
    await renderNewsFeedStatus();
    const link = document.getElementById('simulateUnread');
    link.textContent = 'done!';
    setTimeout(() => { link.textContent = 'simulate unread'; }, 2000);
  }

  // ── Power source ──────────────────────────────────────────────────────────────────────────

  // Surfaces the same navigator.getBattery() read tgs.js/background.js rely on for the
  // "never suspend while charging" and battery-specific-timeout options, so it's easy to
  // confirm what the extension currently sees without guessing from behaviour alone.
  function initPowerSourceStatus() {
    const iconEl   = document.getElementById('powerSourceIcon');
    const statusEl = document.getElementById('powerSourceStatus');
    if (!iconEl || !statusEl) return;
    if (!('getBattery' in navigator) || typeof navigator.getBattery !== 'function') {
      statusEl.textContent = 'unavailable in this context';
      return;
    }
    navigator.getBattery().then((battery) => {
      const render = () => {
        iconEl.setAttribute('href', `img/icons.svg#${battery.charging ? 'plug' : 'battery'}`);
        statusEl.textContent = battery.charging ? 'AC power' : 'on battery';
      };
      render();
      battery.onchargingchange = render;
    });
  }

  // ── Backup device identity ────────────────────────────────────────────────────────────────

  async function renderBackupDeviceInfo() {
    const idEl   = document.getElementById('backupDeviceId');
    const nameEl = document.getElementById('backupDeviceNameDebug');
    if (!idEl || !nameEl) return;
    const [id, name] = await Promise.all([gsBackup.getDeviceId(), gsBackup.getDeviceName()]);
    idEl.textContent   = id   || '-';
    nameEl.textContent = name || 'this device (no name set)';
  }

  // ── Claim suspended tabs ─────────────────────────────────────────────────────────────────

  async function onClaimSuspendedTabs(e) {
    e.preventDefault();
    const tabs = await gsChrome.tabsQuery();
    for (const tab of tabs) {
      if (
        gsUtils.isSuspendedTab(tab, true) &&
        tab.url.indexOf(chrome.runtime.id) < 0
      ) {
        const newUrl = tab.url.replace(gsUtils.getRootUrl(tab.url), chrome.runtime.id);
        await gsChrome.tabsUpdate(tab.id, { url: newUrl });
      }
    }
  }

  // ── Favicon cache ─────────────────────────────────────────────────────────────────────────

  async function onClearFaviconCache(e) {
    e.preventDefault();
    const link = document.getElementById('clearFaviconCache');
    await gsIndexedDb.clearFaviconMeta();
    link.textContent = 'cleared!';
    setTimeout(() => { link.textContent = 'clear cache'; }, 2000);
  }

  async function onRepairFavicons(e) {
    e.preventDefault();
    const link = document.getElementById('repairFavicons');
    const prev = link.textContent;
    link.textContent = 'repairing...';
    const result = await chrome.runtime.sendMessage({ action: 'repairFavicons' }).catch(() => null);
    link.textContent = result ? `repaired ${result.successful}/${result.total}` : 'failed';
    setTimeout(() => { link.textContent = prev; }, 3000);
  }

  // ── Changelog modal ───────────────────────────────────────────────────────────────────────

  async function onResetChangelogSeen(e) {
    e.preventDefault();
    const link = document.getElementById('resetChangelogSeen');
    await chrome.storage.local.remove([gsStorage.LAST_SEEN_CHANGELOG_VERSION]);
    link.textContent = 'reset!';
    setTimeout(() => { link.textContent = 'reset "seen" flag'; }, 2000);
  }

  // ── Init ───────────────────────────────────────────────────────────────────────────────────

  gsUtils.documentReadyAndLocalisedAsPromised(window).then(async function() {

    // This page's own gsTabCheckManager module instance (every page gets its own, separate
    // from the service worker's) needs its own queue initialised before getDebugInfo()'s
    // queueTabCheckAsPromise() calls can do anything — without this, that call falls
    // through the "queue not initialized" guard and just resolves STATUS_UNKNOWN
    // immediately, silently skipping the reinjection attempt it's there for.
    await gsTabCheckManager.initAsPromised();

    await renderCaptureToggle();
    await renderDiscardToggle();
    await renderNewsFeedStatus();
    await renderBackupDeviceInfo();
    initPowerSourceStatus();
    await refreshLogs();
    await fetchTabInfo();

    document.getElementById('toggleCaptureLogs').addEventListener('click', onToggleCaptureLogs);
    document.getElementById('toggleDiscardInPlaceOfSuspend').addEventListener('click', onToggleDiscard);
    document.getElementById('claimSuspendedTabs').addEventListener('click', onClaimSuspendedTabs);
    document.getElementById('clearFaviconCache').addEventListener('click', onClearFaviconCache);
    document.getElementById('repairFavicons').addEventListener('click', onRepairFavicons);
    document.getElementById('resetChangelogSeen').addEventListener('click', onResetChangelogSeen);
    const isStoreInstall = !!chrome.runtime.getManifest().update_url;
    const feedRefreshLink = document.getElementById('forceNewsFeedRefresh');
    const simulateUnreadLink = document.getElementById('simulateUnread');
    if (isStoreInstall) {
      feedRefreshLink.classList.add('reallyHidden');
      // simulateUnread stays reallyHidden (already set in HTML)
    } else {
      feedRefreshLink.addEventListener('click', onForceNewsFeedRefresh);
      document.querySelector('.debugToggleSep')?.classList.remove('reallyHidden');
      simulateUnreadLink.classList.remove('reallyHidden');
      simulateUnreadLink.addEventListener('click', onSimulateUnread);
    }

    document.getElementById('btnRefreshLogs').addEventListener('click', refreshLogs);

    document.getElementById('btnFilterWarnErr').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const active = btn.getAttribute('aria-pressed') === 'true';
      btn.setAttribute('aria-pressed', String(!active));
      document.getElementById('logOutput').classList.toggle('warnErrOnly', !active);
      await refreshLogs();
    });

    document.getElementById('btnClearLog').addEventListener('click', async () => {
      // Routed through the service worker (rather than clearing chrome.storage
      // directly from here) so its own in-memory _logBuffer/_logBufferFull get
      // cleared too — otherwise the next log entry, or an already-pending debounced
      // flush over there, would write those still-populated arrays back over the
      // storage this page just cleared.
      const btn = document.getElementById('btnClearLog');
      const prevText = btn.textContent;
      const response = await chrome.runtime.sendMessage({ action: 'clearLogs' }).catch(() => null);
      if (!response || !response.success) {
        // Refreshing below would otherwise silently show the same old entries with no
        // indication Clear didn't actually happen (a transient storage error, or the
        // service worker restarting mid-request).
        btn.textContent = 'clear failed';
        setTimeout(() => { btn.textContent = prevText; }, 3000);
      }
      await refreshLogs();
    });

    document.getElementById('btnCopyReport').addEventListener('click', async () => {
      const report = await buildReport(false);
      await navigator.clipboard.writeText(report);
      const btn = document.getElementById('btnCopyReport');
      const prev = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = prev; }, 1500);
    });

    document.getElementById('btnDownloadReport').addEventListener('click', async () => {
      const report = await buildReport(true);
      const blob   = new Blob([report], { type: 'text/plain' });
      const url    = URL.createObjectURL(blob);
      const a      = document.createElement('a');
      a.href     = url;
      a.download = `tms-debug-${new Date().toISOString().substring(0, 19).replace(/:/g, '-')}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    });

    window.addEventListener('focus', () => {
      fetchTabInfo();
      refreshLogs();
    });

  });

})();
