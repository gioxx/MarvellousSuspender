import  { gsChrome }              from './gsChrome.js';
import  { gsSession }             from './gsSession.js';
import  { gsStorage }             from './gsStorage.js';
import  { gsTabSuspendManager }   from './gsTabSuspendManager.js';
import  { gsTabCheckManager }     from './gsTabCheckManager.js';
import  { gsTabDiscardManager }   from './gsTabDiscardManager.js';
import  { gsUtils }               from './gsUtils.js';
import  { tgs }                   from './tgs.js';
/// <reference lib="webworker" />


(() => {

  let startupDone = false;  // This global is safe because we only use it at startup.  It does not need to survive service worker suspend.

  function startupOnce() {
    gsUtils.log('startupOnce');
    if (startupDone) return;
    startupDone = true;

    tgs.resetAutoSuspendTimerForAllTabs();

    Promise.resolve()
      .then(gsStorage.initSettingsAsPromised)   // ensure settings have been loaded and synced
      .then(gsStorage.saveStorage('session', 'gsInitialisationMode', true))
      .then(gsSession.runStartupChecks)         // performs crash check (and maybe recovery) and tab responsiveness checks
      .catch(error => {
        gsUtils.error('background startup checks error: ', error);
      });

  }

  if (self instanceof ServiceWorkerGlobalScope) {
    self.addEventListener("install", (event) => {
      gsUtils.log('1 service worker install', event);
    });
  }

  chrome.runtime.onInstalled.addListener(async (details) => {
    gsUtils.log('2 runtime.onInstalled', details);
    // Fired when the extension is first installed, when the extension is updated to a new version, and when Chrome is updated to a new version.
    // Fired when an unpacked extension is reloaded

    //add context menu items
    if (!chrome.extension.inIncognitoContext) {
      tgs.buildContextMenu(false);
      var contextMenus = await gsStorage.getOption(gsStorage.ADD_CONTEXT);
      tgs.buildContextMenu(contextMenus);
    }

    // remove update message after extension has been updated
    if (details.reason == "update") {
      await gsStorage.setOptionAndSync(gsStorage.UPDATE_AVAILABLE, false);
    }

    // gsUtils.debugInfo   = true;
    // gsUtils.debugError  = true;
    // if (gsUtils.debugInfo) {
    //   // await gsStorage.setOptionAndSync(gsStorage.UPDATE_AVAILABLE, true);
    //   // chrome.storage.local.set({'gsVersion': '"8.0.0"'});
    //   chrome.storage.local.remove([gsStorage.LAST_EXTENSION_RECOVERY]);
    //   setTimeout(() => {
    //     // chrome.tabs.create({ url: `${getSuspendURL()}#ttl=Google+1&uri=https://www.google.com` });
    //     // chrome.tabs.create({ url: `${getSuspendURL()}#ttl=GitHub+3&uri=https://www.github.com` });
    //     // chrome.tabs.create({ url: chrome.runtime.getURL('debug.html') });
    //     // chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
    //   }, 200);
    //   // setTimeout(() => {
    //   //   gsSession.prepareForUpdate({ version: 'new version'});
    //   // }, 5000);
    // }

  });

  if (self instanceof ServiceWorkerGlobalScope) {
    self.addEventListener("activate", (event) => {
      gsUtils.log('3 service worker activate', event);
      startupOnce();
    });
  }

  chrome.runtime.onStartup.addListener(function () {
    gsUtils.log('4 runtime.onStartup');
    // Fired when a profile that has this extension installed first starts up.
    // This event is not fired when an incognito profile is started, even if this extension is operating in 'split' incognito mode.

    startupOnce();

  });

  chrome.runtime.onSuspend.addListener(function () {
    gsUtils.log('5 runtime.onSuspend');
  });
  chrome.runtime.onSuspendCanceled.addListener(function () {
    gsUtils.log('6 runtime.onSuspendCanceled');
  });


  // function backgroundScriptsReadyAsPromised(retries) {
  //   retries = retries || 0;
  //   if (retries > 300) {
  //     // allow 30 seconds :scream:
  //     chrome.tabs.create({ url: chrome.runtime.getURL('broken.html') });
  //     return Promise.reject('Failed to initialise background scripts');
  //   }
  //   return new Promise(function(resolve) {
  //     const isReady = tgs.getExtensionGlobals() !== null;
  //     resolve(isReady);
  //   }).then(function(isReady) {
  //     if (isReady) {
  //       return Promise.resolve();
  //     }
  //     return new Promise(function(resolve) {
  //       setTimeout(resolve, 100);
  //     }).then(function() {
  //       retries += 1;
  //       return backgroundScriptsReadyAsPromised(retries);
  //     });
  //   });
  // }


  async function messageRequestListener(request, sender, sendResponse) {
    gsUtils.log('background', 'messageRequestListener', request.action, request, sender);

    switch (request.action) {
      case 'reportTabState' : {
        var contentScriptStatus = request && request.status ? request.status : null;
        if (
          contentScriptStatus === 'formInput' ||
          contentScriptStatus === 'tempWhitelist'
        ) {
          chrome.tabs.update(sender.tab.id, { autoDiscardable: false });
        }
        else if (!sender.tab.autoDiscardable) {
          chrome.tabs.update(sender.tab.id, { autoDiscardable: true });
        }
        // If tab is currently visible then update popup icon
        if (sender.tab && await tgs.isCurrentFocusedTab(sender.tab)) {
          tgs.calculateTabStatus(sender.tab, contentScriptStatus, function(status) {
            tgs.setIconStatus(status, sender.tab.id);
          });
        }
        break;
      }
      case 'savePreviewData' : {
        gsTabSuspendManager.handlePreviewImageResponse(sender.tab, request.previewUrl, request.errorMsg); // async. unhandled promise
        break;
      }

      case 'suspendOne' : {
        tgs.suspendHighlightedTab();
        break;
      }
      case 'unsuspendOne' : {
        tgs.unsuspendHighlightedTab();
        break;
      }
      case 'suspendAll' : {
        tgs.suspendAllTabs(false);
        break;
      }
      case 'unsuspendAll' : {
        tgs.unsuspendAllTabs();
        break;
      }
      case 'suspendSelected' : {
        tgs.suspendSelectedTabs();
        break;
      }
      case 'unsuspendSelected' : {
        tgs.unsuspendSelectedTabs();
        break;
      }
      case 'whitelistDomain' : {
        tgs.whitelistHighlightedTab(false);
        break;
      }
      case 'whitelistPage' : {
        tgs.whitelistHighlightedTab(true);
        break;
      }
      case 'sessionManagerLink': {
        chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
        break;
      }
      case 'settingsLink' : {
        chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
        break;
      }
      default: {
        gsUtils.warning('background', 'messageRequestListener', `Unknown message action: ${request.action}`);
        break;
      }
    }
    sendResponse();
    return false;
  }

  function externalMessageRequestListener(request, sender, sendResponse) {
    gsUtils.log('background', 'externalMessageRequestListener', request, sender);

    if (!request.action || !['suspend', 'unsuspend'].includes(request.action)) {
      sendResponse('Error: unknown request.action: ' + request.action);
      return;
    }

    // wrap this in an anonymous async function so we can use await
    (async function() {
      let tab;
      if (request.tabId) {
        if (typeof request.tabId !== 'number') {
          sendResponse('Error: tabId must be an int');
          return;
        }
        tab = await gsChrome.tabsGet(request.tabId);
        if (!tab) {
          sendResponse('Error: no tab found with id: ' + request.tabId);
          return;
        }
      } else {
        tab = await new Promise(r => {
          tgs.getCurrentlyActiveTab(r);
        });
      }
      if (!tab) {
        sendResponse('Error: failed to find a target tab');
        return;
      }

      if (request.action === 'suspend') {
        if (gsUtils.isSuspendedTab(tab, true)) {
          sendResponse('Error: tab is already suspended');
          return;
        }

        gsTabSuspendManager.queueTabForSuspension(tab, 1);
        sendResponse();
        return;
      }

      if (request.action === 'unsuspend') {
        if (!gsUtils.isSuspendedTab(tab)) {
          sendResponse('Error: tab is not suspended');
          return;
        }

        await tgs.unsuspendTab(tab);
        sendResponse();
        return;
      }
    })();
    return true;
  }


  // Listeners must part of the top-level evaluation of the service worker
  function contextMenuListener(info, tab) {
    switch (info.menuItemId) {
      case 'open_link_in_suspended_tab':
        tgs.openLinkInSuspendedTab(tab, info.linkUrl);
        break;
      case 'toggle_suspend_state':
        tgs.toggleSuspendedStateOfHighlightedTab();
        break;
      case 'toggle_pause_suspension':
        tgs.requestToggleTempWhitelistStateOfHighlightedTab();
        break;
      case 'never_suspend_page':
        tgs.whitelistHighlightedTab(true);
        break;
      case 'never_suspend_domain':
        tgs.whitelistHighlightedTab(false);
        break;
      case 'suspend_selected_tabs':
        tgs.suspendSelectedTabs();
        break;
      case 'unsuspend_selected_tabs':
        tgs.unsuspendSelectedTabs();
        break;
      case 'soft_suspend_other_tabs_in_window':
        tgs.suspendAllTabs(false);
        break;
      case 'force_suspend_other_tabs_in_window':
        tgs.suspendAllTabs(true);
        break;
      case 'unsuspend_all_tabs_in_window':
        tgs.unsuspendAllTabs();
        break;
      case 'soft_suspend_all_tabs':
        tgs.suspendAllTabsInAllWindows(false);
        break;
      case 'force_suspend_all_tabs':
        tgs.suspendAllTabsInAllWindows(true);
        break;
      case 'unsuspend_all_tabs':
        tgs.unsuspendAllTabsInAllWindows();
        break;
      case 'open_session_history':
        chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
        break;
      default:
        break;
    }
  }

  // Listeners must part of the top-level evaluation of the service worker
  function commandListener(command) {
    switch (command) {
      case '1-suspend-tab':
        tgs.toggleSuspendedStateOfHighlightedTab();
        break;
      case '2-toggle-temp-whitelist-tab':
        tgs.requestToggleTempWhitelistStateOfHighlightedTab();
        break;
      case '2a-suspend-selected-tabs':
        tgs.suspendSelectedTabs();
        break;
      case '2b-unsuspend-selected-tabs':
        tgs.unsuspendSelectedTabs();
        break;
      case '3-suspend-active-window':
        tgs.suspendAllTabs(false);
        break;
      case '3b-force-suspend-active-window':
        tgs.suspendAllTabs(true);
        break;
      case '4-unsuspend-active-window':
        tgs.unsuspendAllTabs();
        break;
      case '4b-soft-suspend-all-windows':
        tgs.suspendAllTabsInAllWindows(false);
        break;
      case '5-suspend-all-windows':
        tgs.suspendAllTabsInAllWindows(true);
        break;
      case '6-unsuspend-all-windows':
        tgs.unsuspendAllTabsInAllWindows();
        break;
      case '7-open_session_history':
        chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
        break;
    }
  }

  /** @param { chrome.alarms.Alarm } alarm */
  async function alarmListener(alarm) {
    gsUtils.log('background', 'alarmListener', alarm);
    const tabId = parseInt(alarm.name);
    const tab = await gsChrome.tabsGet(tabId);
    if (!tab) {
      gsUtils.warning(tabId, 'Tab not found. Aborting suspension.');
      return;
    }
    gsUtils.log( tabId, 'TIMER queueTabForSuspension' );
    gsTabSuspendManager.queueTabForSuspension(tab, 3);
  }

  // Listeners must be part of the top-level evaluation of the service worker
  function addChromeListeners() {
    chrome.windows.onFocusChanged.addListener(async (windowId) => {
      await tgs.handleWindowFocusChanged(windowId);
    });
    chrome.tabs.onActivated.addListener(async (activeInfo) => {
      await tgs.handleTabFocusChanged(activeInfo.tabId, activeInfo.windowId); // async. unhandled promise
    });
    chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
      // await tgs.updateTabIdReferences(addedTabId, removedTabId);
      tgs.queueSessionTimer();
      await tgs.removeTabIdReferences(removedTabId);
      // @TODO: Do we need to do anything here?  Seems like onCreated doesn't
    });
    chrome.tabs.onCreated.addListener(async (tab) => {
      gsUtils.log(tab.id, 'tab created. tabUrl: ' + tab.url);
      tgs.queueSessionTimer();

      // It's unusual for a suspended tab to be created. Usually they are updated
      // from a normal tab. This usually happens when using 'reopen closed tab'.
      if (gsUtils.isSuspendedTab(tab) && !tab.active) {
        // Queue tab for check but mark it as sleeping for 5 seconds to give
        // a chance for the tab to load
        gsTabCheckManager.queueTabCheck(tab, {}, 5000);
      }
    });
    chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
      gsUtils.log(tabId, 'tab removed.');
      tgs.queueSessionTimer();
      await tgs.removeTabIdReferences(tabId);
    });

    function isItOurUrl(url) {
      // return true is suspended.html follows extenstion's id immediately
      // which means that this url is likely belongs to our extenstion (no other extensions handle it now)
      return url.match('^chrome-extension://[^/]*/suspended\\.html');
    }

    async function claimTab(tabId) {
      const tabs = await gsChrome.tabsQuery();
      for (const tab of tabs) {
        if (
          tab.id == tabId &&
          isItOurUrl(tab.url) &&
          gsUtils.isSuspendedTab(tab, true) &&
          tab.url.indexOf(chrome.runtime.id) < 0
        ) {
          const newUrl = tab.url.replace(
            gsUtils.getRootUrl(tab.url),
            chrome.runtime.id,
          );
          await gsChrome.tabsUpdate(tab.id, { url: newUrl });
        }
      }
    };

    chrome.tabs.onUpdated.addListener(async function(tabId, changeInfo, tab) {
      if (!changeInfo) return;

      if (await gsStorage.getOption(gsStorage.CLAIM_BY_DEFAULT) && changeInfo.status === 'complete') {
        claimTab(tabId);
      }

      // if url has changed
      if (changeInfo.url) {
        gsUtils.log(tabId, 'background', 'tab url changed', changeInfo);
        tgs.checkForTriggerUrls(tab, changeInfo.url);
        tgs.queueSessionTimer();
      }

      if (gsUtils.isSuspendedTab(tab)) {
        await tgs.handleSuspendedTabStateChanged(tab, changeInfo);
      } else if (gsUtils.isNormalTab(tab)) {
        await tgs.handleUnsuspendedTabStateChanged(tab, changeInfo);
      }
    });
    chrome.windows.onCreated.addListener(async (window) => {
      gsUtils.log(window.id, 'background', 'window created.');
      tgs.queueSessionTimer();

      var noticeToDisplay = await tgs.requestNotice();
      if (noticeToDisplay) {
        chrome.tabs.create({ url: chrome.runtime.getURL('notice.html') });
      }
    });
    chrome.windows.onRemoved.addListener(function(windowId) {
      gsUtils.log(windowId, 'background', 'window removed.');
      tgs.queueSessionTimer();
    });
  }

  // Listeners must part of the top-level evaluation of the service worker
  function addMiscListeners() {
    //add listener for battery state changes
    if (navigator.getBattery) {
      navigator.getBattery().then(async (battery) => {
        await tgs.setCharging(battery.charging);

        battery.onchargingchange = async () => {
          await tgs.setCharging(battery.charging);
          gsUtils.log('background', `isCharging: ${await tgs.isCharging()}`);
          tgs.setIconStatusForActiveTab();
          //restart timer on all normal tabs
          //NOTE: some tabs may have been prevented from suspending when computer was charging
          if (
            !(await tgs.isCharging()) &&
              await gsStorage.getOption(gsStorage.IGNORE_WHEN_CHARGING)
          ) {
            tgs.resetAutoSuspendTimerForAllTabs();
          }
        };
      });
    }

    // These listeners must be in the main execution path for service workers
    addEventListener('online', async () => {
      gsUtils.log('background', 'Internet is online.');
      //restart timer on all normal tabs
      //NOTE: some tabs may have been prevented from suspending when internet was offline
      if (await gsStorage.getOption(gsStorage.IGNORE_WHEN_OFFLINE)) {
        tgs.resetAutoSuspendTimerForAllTabs();
      }
      tgs.setIconStatusForActiveTab();
    });
    addEventListener('offline', function() {
      gsUtils.log('background', 'Internet is offline.');
      tgs.setIconStatusForActiveTab();
    });

  }

  function initAsPromised() {
    return new Promise(async (resolve) => {
      gsUtils.log('background', 'PERFORMING BACKGROUND INIT...');

      //initialise currentStationary and currentFocused vars
      const activeTabs = await gsChrome.tabsQuery({ active: true });
      const currentWindow = await gsChrome.windowsGetLastFocused();
      for (let activeTab of activeTabs) {
        (await tgs.getCurrentStationaryTabIdByWindowId())[activeTab.windowId] = activeTab.id;
        (await tgs.getCurrentFocusedTabIdByWindowId())[activeTab.windowId] = activeTab.id;
        if (currentWindow && currentWindow.id === activeTab.windowId) {
          await tgs.setCurrentStationaryWindowId(activeTab.windowId);
          await tgs.setCurrentFocusedWindowId(activeTab.windowId);
        }
      }
      gsUtils.log('background', 'init successful');
      resolve();
    });
  }


  // Listeners get added every time the service worker restarts
  chrome.runtime.onMessage.addListener(messageRequestListener);
  chrome.runtime.onMessageExternal.addListener(externalMessageRequestListener);
  chrome.commands.onCommand.addListener(commandListener);
  chrome.contextMenus.onClicked.addListener(contextMenuListener);
  chrome.alarms.onAlarm.addListener(alarmListener);
  addChromeListeners();
  addMiscListeners();

  Promise.resolve()
    // .then(backgroundScriptsReadyAsPromised) // wait until all gsLibs have loaded
    .then(() => {
      // initialise other gsLibs
      return Promise.all([
        // gsFavicon.initAsPromised(),          // gsFavicon cannot be initialized in the background because it requires a DOM.  So, we'll init JIT.
        gsTabSuspendManager.initAsPromised(),
        gsTabCheckManager.initAsPromised(),
        gsTabDiscardManager.initAsPromised(),
        gsSession.initAsPromised(),
      ]);
    })
    .catch(error => {
      gsUtils.error('background init error: ', error);
    })
    .then(initAsPromised)
    .catch(error => {
      gsUtils.error('background init error: ', error);
    });


})();
