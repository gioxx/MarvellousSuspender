// @ts-check
import  { gsChrome }              from './gsChrome.js';
import  { gsFavicon }             from './gsFavicon.js';
import  { gsMessages }            from './gsMessages.js';
import  { gsNewsFeed }            from './gsNewsFeed.js';
import  { gsStorage }             from './gsStorage.js';
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
      gsMessages.sendRequestInfoToContentScript(tab.id, ( error, tabInfo ) => {
        gsUtils.highlight(tab.id, 'getDebugInfo callback', tab.url);
        tgs.calculateTabStatus(tab, tabInfo ? tabInfo.status : null, (status) => {
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

  async function fetchTabInfo() {
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

  function levelLabel(level) {
    if (level === 'E') return '<span class="logLevel logLevel-E">ERR</span>';
    if (level === 'W') return '<span class="logLevel logLevel-W">WRN</span>';
    return '<span class="logLevel logLevel-I">LOG</span>';
  }

  function renderLogEntry(entry) {
    const time = entry.ts ? entry.ts.substring(11, 23) : '??:??:??';
    const src  = gsUtils.htmlEncode(String(entry.src || ''));
    const msg  = gsUtils.htmlEncode(String(entry.msg || ''));
    return `<div class="logLine logLine-${entry.level}">${levelLabel(entry.level)}<span class="logTime">${time}</span><span class="logSrc">${src}</span><span class="logMsg">${msg}</span></div>`;
  }

  async function refreshLogs() {
    const buffer  = await readLogBuffer();
    const output  = document.getElementById('logOutput');
    const counter = document.getElementById('logCount');
    counter.textContent = buffer.length;
    if (buffer.length === 0) {
      output.innerHTML = '<div class="logEmpty">No entries. Errors are always captured automatically. Enable <strong>captureLogs</strong> above to also capture warnings and verbose logs, then reproduce the issue.</div>';
    } else {
      output.innerHTML = buffer.map(renderLogEntry).join('');
      output.scrollTop = output.scrollHeight;
    }
  }

  // ── Report generation ───────────────────────────────────────────────────────

  async function buildReport() {
    const manifest = chrome.runtime.getManifest();
    const buffer   = await readLogBuffer();
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
    lines.push(`=== The Marvellous Suspender — Diagnostic Report ===`);
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

  // ── Init ───────────────────────────────────────────────────────────────────────────────────

  gsUtils.documentReadyAndLocalisedAsPromised(window).then(async function() {

    await renderCaptureToggle();
    await renderDiscardToggle();
    await renderNewsFeedStatus();
    await refreshLogs();
    await fetchTabInfo();

    document.getElementById('toggleCaptureLogs').addEventListener('click', onToggleCaptureLogs);
    document.getElementById('toggleDiscardInPlaceOfSuspend').addEventListener('click', onToggleDiscard);
    document.getElementById('claimSuspendedTabs').addEventListener('click', onClaimSuspendedTabs);
    const isStoreInstall = !!chrome.runtime.getManifest().update_url;
    const feedRefreshLink = document.getElementById('forceNewsFeedRefresh');
    const simulateUnreadLink = document.getElementById('simulateUnread');
    if (isStoreInstall) {
      feedRefreshLink.classList.add('reallyHidden');
      // simulateUnread stays reallyHidden (already set in HTML)
    } else {
      feedRefreshLink.addEventListener('click', onForceNewsFeedRefresh);
      simulateUnreadLink.classList.remove('reallyHidden');
      simulateUnreadLink.addEventListener('click', onSimulateUnread);
    }

    document.getElementById('btnRefreshLogs').addEventListener('click', refreshLogs);

    document.getElementById('btnClearLog').addEventListener('click', async () => {
      await chrome.storage.local.remove([gsStorage.LOG_BUFFER]);
      await refreshLogs();
    });

    document.getElementById('btnCopyReport').addEventListener('click', async () => {
      const report = await buildReport();
      await navigator.clipboard.writeText(report);
      const btn = document.getElementById('btnCopyReport');
      const prev = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = prev; }, 1500);
    });

    document.getElementById('btnDownloadReport').addEventListener('click', async () => {
      const report = await buildReport();
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
