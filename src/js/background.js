/*
 * The Great Suspender
 * Copyright (C) 2017 Dean Oemcke
 * Available under GNU GENERAL PUBLIC LICENSE v2
 * http://github.com/greatsuspender/thegreatsuspender
 * ༼ つ ◕_◕ ༽つ
*/

import  { gsChrome }              from './gsChrome.js';
import  { gsFavicon }             from './gsFavicon.js';
// import  { gsIndexedDb }           from './gsIndexedDb.js';
// import  { gsMessages }            from './gsMessages.js';
import  { gsSession }             from './gsSession.js';
import  { gsStorage }             from './gsStorage.js';
// import  { gsSuspendedTab }        from './gsSuspendedTab.js';
import  { gsTabSuspendManager }   from './gsTabSuspendManager.js';
import  { gsTabCheckManager }     from './gsTabCheckManager.js';
import  { gsTabDiscardManager }   from './gsTabDiscardManager.js';
import  { gsUtils }               from './gsUtils.js';
import  { tgs }                   from './tgs.js';


const background = (() => {

  function backgroundScriptsReadyAsPromised(retries) {
    retries = retries || 0;
    if (retries > 300) {
      // allow 30 seconds :scream:
      chrome.tabs.create({ url: chrome.runtime.getURL('broken.html') });
      return Promise.reject('Failed to initialise background scripts');
    }
    return new Promise(function(resolve) {
      const isReady = tgs.getExtensionGlobals() !== null;
      resolve(isReady);
    }).then(function(isReady) {
      if (isReady) {
        return Promise.resolve();
      }
      return new Promise(function(resolve) {
        setTimeout(resolve, 100);
      }).then(function() {
        retries += 1;
        return backgroundScriptsReadyAsPromised(retries);
      });
    });
  }


  function messageRequestListener(request, sender, sendResponse) {
    gsUtils.log(
      sender.tab.id,
      'background messageRequestListener',
      request.action,
    );

    if (request.action === 'reportTabState') {
      var contentScriptStatus =
        request && request.status ? request.status : null;
      if (
        contentScriptStatus === 'formInput' ||
        contentScriptStatus === 'tempWhitelist'
      ) {
        chrome.tabs.update(sender.tab.id, { autoDiscardable: false });
      } else if (!sender.tab.autoDiscardable) {
        chrome.tabs.update(sender.tab.id, { autoDiscardable: true });
      }
      // If tab is currently visible then update popup icon
      if (sender.tab && tgs.isCurrentFocusedTab(sender.tab)) {
        tgs.calculateTabStatus(sender.tab, contentScriptStatus, function(status) {
          tgs.setIconStatus(status, sender.tab.id);
        });
      }
      sendResponse();
      return false;
    }

    if (request.action === 'savePreviewData') {
      gsTabSuspendManager.handlePreviewImageResponse(
        sender.tab,
        request.previewUrl,
        request.errorMsg,
      ); // async. unhandled promise
      sendResponse();
      return false;
    }

    // Fallback to empty response to ensure callback is made
    sendResponse();
    return false;
  }

  function externalMessageRequestListener(request, sender, sendResponse) {
    gsUtils.log('background', 'external message request: ', request, sender);

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

        tgs.unsuspendTab(tab);
        sendResponse();
        return;
      }
    })();
    return true;
  }


  // Listeners must part of the top-level evaluation of the service worker
  function addContextListeners() {
    chrome.contextMenus.onClicked.addListener((info, tab) => {
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
        default:
          break;
      }
    });
  }

  // Listeners must part of the top-level evaluation of the service worker
  function addCommandListeners() {
    chrome.commands.onCommand.addListener(function(command) {
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
      }
    });
  }

  function addMessageListeners() {
    chrome.runtime.onMessage.addListener(messageRequestListener);
    //attach listener to runtime for external messages, to allow
    //interoperability with other extensions in the manner of an API
    chrome.runtime.onMessageExternal.addListener(
      externalMessageRequestListener,
    );
  }

  // Listeners must part of the top-level evaluation of the service worker
  function addChromeListeners() {
    chrome.windows.onFocusChanged.addListener(function(windowId) {
      tgs.handleWindowFocusChanged(windowId);
    });
    chrome.tabs.onActivated.addListener(function(activeInfo) {
      tgs.handleTabFocusChanged(activeInfo.tabId, activeInfo.windowId); // async. unhandled promise
    });
    chrome.tabs.onReplaced.addListener(function(addedTabId, removedTabId) {
      tgs.updateTabIdReferences(addedTabId, removedTabId);
    });
    chrome.tabs.onCreated.addListener(async function(tab) {
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
    chrome.tabs.onRemoved.addListener(function(tabId, removeInfo) {
      gsUtils.log(tabId, 'tab removed.');
      tgs.queueSessionTimer();
      tgs.removeTabIdReferences(tabId);
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
        gsUtils.log(tabId, 'tab url changed. changeInfo: ', changeInfo);
        tgs.checkForTriggerUrls(tab, changeInfo.url);
        tgs.queueSessionTimer();
      }

      if (gsUtils.isSuspendedTab(tab)) {
        tgs.handleSuspendedTabStateChanged(tab, changeInfo);
      } else if (gsUtils.isNormalTab(tab)) {
        tgs.handleUnsuspendedTabStateChanged(tab, changeInfo);
      }
    });
    chrome.windows.onCreated.addListener(function(window) {
      gsUtils.log(window.id, 'window created.');
      tgs.queueSessionTimer();

      var noticeToDisplay = tgs.requestNotice();
      if (noticeToDisplay) {
        chrome.tabs.create({ url: chrome.runtime.getURL('notice.html') });
      }
    });
    chrome.windows.onRemoved.addListener(function(windowId) {
      gsUtils.log(windowId, 'window removed.');
      tgs.queueSessionTimer();
    });
  }

  // Listeners must part of the top-level evaluation of the service worker
  function addMiscListeners() {
    //add listener for battery state changes
    if (navigator.getBattery) {
      navigator.getBattery().then(function(battery) {
        tgs.setCharging(battery.charging);

        battery.onchargingchange = async () => {
          tgs.setCharging(battery.charging);
          gsUtils.log('background', `isCharging: ${tgs.isCharging()}`);
          tgs.setIconStatusForActiveTab();
          //restart timer on all normal tabs
          //NOTE: some tabs may have been prevented from suspending when computer was charging
          if (
            !tgs.isCharging() &&
            await gsStorage.getOption(gsStorage.IGNORE_WHEN_CHARGING)
          ) {
            tgs.resetAutoSuspendTimerForAllTabs();
          }
        };
      });
    }

  }

  function initAsPromised() {
    return new Promise(async (resolve) => {
      gsUtils.log('background', 'PERFORMING BACKGROUND INIT...');
      addContextListeners();
      addCommandListeners();
      addMessageListeners();
      addChromeListeners();
      addMiscListeners();

      //initialise unsuspended tab props
      tgs.resetAutoSuspendTimerForAllTabs();

      //add context menu items
      //TODO: Report chrome bug where adding context menu in incognito removes it from main windows
      if (!chrome.extension.inIncognitoContext) {
        tgs.buildContextMenu(false);
        var contextMenus = await gsStorage.getOption(gsStorage.ADD_CONTEXT);
        tgs.buildContextMenu(contextMenus);
      }

      //initialise currentStationary and currentFocused vars
      const activeTabs = await gsChrome.tabsQuery({ active: true });
      const currentWindow = await gsChrome.windowsGetLastFocused();
      for (let activeTab of activeTabs) {
        tgs.getCurrentStationaryTabIdByWindowId()[activeTab.windowId] = activeTab.id;
        tgs.getCurrentFocusedTabIdByWindowId()[activeTab.windowId] = activeTab.id;
        if (currentWindow && currentWindow.id === activeTab.windowId) {
          tgs.setCurrentStationaryWindowId(activeTab.windowId);
          tgs.setCurrentFocusedWindowId(activeTab.windowId);
        }
      }
      gsUtils.log('background', 'init successful');
      resolve();
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


  return {
    backgroundScriptsReadyAsPromised,
    initAsPromised,
  };

})();


Promise.resolve()
  .then(background.backgroundScriptsReadyAsPromised) // wait until all gsLibs have loaded
  .then(gsStorage.initSettingsAsPromised) // ensure settings have been loaded and synced
  .then(() => {
    // initialise other gsLibs
    return Promise.all([
      gsFavicon.initAsPromised(),
      gsTabSuspendManager.initAsPromised(),
      gsTabCheckManager.initAsPromised(),
      gsTabDiscardManager.initAsPromised(),
      gsSession.initAsPromised(),
    ]);
  })
  .catch(error => {
    gsUtils.error('background init error: ', error);
  })
  .then(gsSession.runStartupChecks) // performs crash check (and maybe recovery) and tab responsiveness checks
  .catch(error => {
    gsUtils.error('background startup checks error: ', error);
  })
  .then(background.initAsPromised) // adds handle(Un)SuspendedTabChanged listeners!
  .catch(error => {
    gsUtils.error('background init error: ', error);
  });
