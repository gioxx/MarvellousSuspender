// @ts-check
import  { gsChrome }              from './gsChrome.js';
import  { gsFavicon }             from './gsFavicon.js';
import  { gsMessages }            from './gsMessages.js';
import  { gsStorage }             from './gsStorage.js';
import  { gsUtils }               from './gsUtils.js';
import  { tgs }                   from './tgs.js';

(() => {

  const currentTabs   = {};
  const browser       = navigator.userAgent.match(/Chrome\/.*Edg\//i) ? 'edge' : 'chrome';
  // 2026-04: Brave colors appear to match chrome nicely
  // 2026-04: Vivaldi and Opera are doing weird things with Tab Groups.  Ignoring their special colors for now.

  /**
   * @param {{
   *    timerUp   ? : string
   *    windowId  ? : string
   *    tabId     ? : string
   *    tab       ? : chrome.tabs.Tab
   *    status    ? : string
   *    group     ? : {
   *      title   ? : string
   *      color   ? : string
   *    }
   * }} [info]
   * @returns {string}
   */
  function generateTabInfo(info) {
    // gsUtils.log('generateTabInfo', info?.tabId, info);
    const timerStr =
      info?.timerUp && info?.timerUp !== '-'
        // ? new Date(info.timerUp).toLocaleString()
        ? Math.round((new Date(info.timerUp).valueOf() - new Date().valueOf()) / 1000)
        : '-';
    let   html        = '';
    const windowId    = info?.windowId        ?? '?';
    const tabId       = info?.tabId           ?? '?';
    const tabIndex    = info?.tab?.index      ?? '?';
    const tabTitle    = info?.tab ? gsUtils.htmlEncode(info.tab.title) : '?';
    const tabTimer    = timerStr;
    const tabStatus   = info?.status          ?? '?';
    const groupName   = info?.group?.title    ?? '';

    // const groupId     = info && info.groupId ? info.groupId : '?';
    const groupColor  = info?.group?.color    ?? '';
    const groupSpan   = groupName ? `<span class="group ${browser} ${groupColor}">${groupName}</span>` : '';

    let   favicon     = info?.tab?.favIconUrl ?? '';
    favicon   = favicon.startsWith('data') ? favicon : gsFavicon.getChromeFavIconUrl(info?.tab?.url ?? '');

    html += '<tr>';
    html += `<td>${windowId}</td>`;
    html += `<td>${tabId}</td>`;
    html += `<td>${tabIndex}</td>`;
    html += `<td><img src="${favicon}"></td>`;
    html += `<td class="center">${groupSpan}</td>`;
    html += `<td>${tabTitle}</td>`;
    html += `<td>${tabTimer}</td>`;
    html += `<td>${tabStatus}</td>`;
    html += '</tr>';

    return html;
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
        // if (error) {
        //   gsUtils.warning(tab.id, 'tgs', 'getDebugInfo', 'Failed to getDebugInfo', error);
        // }
        if (tabInfo) {
          tgs.calculateTabStatus(tab, tabInfo.status, (status) => {
            info.status = status;
            // callback(info);
          });
        }
        // else {
        // }
        callback(info);
      });
    }
    else {
      tgs.calculateTabStatus(tab, null, (status) => {
        info.status = status;
        callback(info);
      });
    }
  }

  async function fetchInfo() {
    const tabs = await gsChrome.tabsQuery();
    const debugInfoPromises = [];
    for (const [i, curTab] of tabs.entries()) {
      currentTabs[tabs[i].id] = tabs[i];
      debugInfoPromises.push(
        promiseWithTimeout(
          new Promise((resolve) =>
            getDebugInfo(curTab.id, (info) => {
              info.tab = curTab;
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
      );
    }
    const debugInfos = await Promise.all(debugInfoPromises);

    const tabGroupsMap = await gsChrome.tabGroupsMap();
    const rows = [];
    for (const debugInfo of debugInfos) {
      debugInfo.group = tabGroupsMap[debugInfo.groupId];
      rows.push(generateTabInfo(debugInfo));
    }
    const tableEl = document.getElementById('gsProfilerBody');
    if (tableEl) {
      tableEl.innerHTML = rows.join('\n');
    }
  }

  async function addFlagHtml(elementId, getterFn, setterFn) {
    const val   = await getterFn();
    const elem  = document.getElementById(elementId);
    if (elem) {
      elem.innerHTML = val;
      elem.onclick = (event) => {
        const newVal = !val;
        setterFn(newVal);
        elem.innerHTML = String(newVal);
      };
    }
  }

  gsUtils.documentReadyAndLocalisedAsPromised(window).then(async () => {

    addFlagHtml(
      'toggleDebugInfo',
      ()        => gsUtils.isDebugInfo(),
      (newVal)  => gsUtils.setDebugInfo(newVal)
    );
    addFlagHtml(
      'toggleDebugError',
      ()        => gsUtils.isDebugError(),
      (newVal)  => gsUtils.setDebugError(newVal)
    );
    addFlagHtml(
      'toggleDiscardInPlaceOfSuspend',
      async ()        =>    await gsStorage.getOption(gsStorage.DISCARD_IN_PLACE_OF_SUSPEND),
      async (newVal)  => {  await gsStorage.setOptionAndSync(gsStorage.DISCARD_IN_PLACE_OF_SUSPEND, newVal); }
    );

    const claim   = document.getElementById('claimSuspendedTabs');
    if (claim) {
      claim.onclick = async function(e) {
        const tabs  = await gsChrome.tabsQuery();
        for (const tab of tabs) {
          if (
            gsUtils.isSuspendedTab(tab, true) &&
            !(tab.url?.includes(chrome.runtime.id))
          ) {
            const newUrl = tab.url?.replace( gsUtils.getRootUrl(tab.url), chrome.runtime.id );
            await gsChrome.tabsUpdate(tab.id, { url: newUrl });
          }
        }
      };
    }

    const extUrl  = `chrome://extensions/?id=${chrome.runtime.id}`;
    const bgPage  = document.getElementById('backgroundPage');
    if (bgPage) {
      bgPage.setAttribute('href', extUrl);
      bgPage.onclick = function() {
        chrome.tabs.create({ url: extUrl });
      };
    }

    window.onfocus = async () => {
      await fetchInfo();
    };

    await fetchInfo();

  });

})();
