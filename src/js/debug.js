import  { gsChrome }              from './gsChrome.js';
import  { gsFavicon }             from './gsFavicon.js';
import  { gsStorage }             from './gsStorage.js';
import  { gsUtils }               from './gsUtils.js';
import  { tgs }                   from './tgs.js';

(() => {
  'use strict';

  const currentTabs   = {};
  const browser       = navigator.userAgent.match(/Chrome\/.*Edg\//i) ? 'edge' : 'chrome';

  function generateTabInfo(info) {
    // console.log(info.tabId, info);
    const timerStr =
      info && info.timerUp && info && info.timerUp !== '-'
        // ? new Date(info.timerUp).toLocaleString()
        ? Math.round((new Date(info.timerUp).valueOf() - new Date().valueOf()) / 1000)
        : '-';
    let   html        = '';
    const windowId    = info && info.windowId ? info.windowId : '?';
    const tabId       = info && info.tabId ? info.tabId : '?';
    const tabIndex    = info && info.tab ? info.tab.index : '?';
    const tabTitle    = info && info.tab ? gsUtils.htmlEncode(info.tab.title) : '?';
    const tabTimer    = timerStr;
    const tabStatus   = info ? info.status : '?';
    const groupName   = info && info.group ? info.group.title : '';

    // const groupId     = info && info.groupId ? info.groupId : '?';
    const groupColor  = info && info.group ? info.group.color : '';
    const groupSpan   = groupName ? `<span class="group ${browser} ${groupColor}">${groupName}</span>` : '';

    let   favicon   = info && info.tab ? info.tab.favIconUrl : '';
    favicon   = favicon && favicon.indexOf('data') === 0 ? favicon : gsFavicon.getChromeFavIconUrl(info.tab.url);

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

  async function fetchInfo() {
    const tabs = await gsChrome.tabsQuery();
    const debugInfoPromises = [];
    for (const [i, curTab] of tabs.entries()) {
      currentTabs[tabs[i].id] = tabs[i];
      debugInfoPromises.push(
        new Promise((resolve) =>
          tgs.getDebugInfo(curTab.id, (info) => {
            info.tab = curTab;
            resolve(info);
          })
        )
      );
    }

    const tabGroupsMap = await gsChrome.tabGroupsMap();

    const rows = [];
    const debugInfos = await Promise.all(debugInfoPromises);
    for (const debugInfo of debugInfos) {
      debugInfo.group = tabGroupsMap[debugInfo.groupId];
      rows.push(generateTabInfo(debugInfo));
    }
    const tableEl = document.getElementById('gsProfilerBody');
    tableEl.innerHTML = rows.join('\n');
  }

  async function addFlagHtml(elementId, getterFn, setterFn) {
    const val = await getterFn();
    document.getElementById(elementId).innerHTML = val;
    document.getElementById(elementId).onclick = (event) => {
      const newVal = !val;
      setterFn(newVal);
      document.getElementById(elementId).innerHTML = newVal;
    };
  }

  gsUtils.documentReadyAndLocalisedAsPromised(window).then(async function() {

    addFlagHtml(
      'toggleDebugInfo',
      () => gsUtils.isDebugInfo(),
      newVal => gsUtils.setDebugInfo(newVal)
    );
    addFlagHtml(
      'toggleDebugError',
      () => gsUtils.isDebugError(),
      newVal => gsUtils.setDebugError(newVal)
    );
    addFlagHtml(
      'toggleDiscardInPlaceOfSuspend',
      async ()        =>    await gsStorage.getOption(gsStorage.DISCARD_IN_PLACE_OF_SUSPEND),
      async (newVal)  => {  await gsStorage.setOptionAndSync(gsStorage.DISCARD_IN_PLACE_OF_SUSPEND, newVal); }
    );

    document.getElementById('claimSuspendedTabs').onclick = async function(e) {
      const tabs = await gsChrome.tabsQuery();
      for (const tab of tabs) {
        if (
          gsUtils.isSuspendedTab(tab, true) &&
          tab.url.indexOf(chrome.runtime.id) < 0
        ) {
          const newUrl = tab.url.replace( gsUtils.getRootUrl(tab.url), chrome.runtime.id );
          await gsChrome.tabsUpdate(tab.id, { url: newUrl });
        }
      }
    };

    var extensionsUrl = `chrome://extensions/?id=${chrome.runtime.id}`;
    document.getElementById('backgroundPage').setAttribute('href', extensionsUrl);
    document.getElementById('backgroundPage').onclick = function() {
      chrome.tabs.create({ url: extensionsUrl });
    };

    window.onfocus = () => {
      fetchInfo();
    };

    fetchInfo();

  });

})();
