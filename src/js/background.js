// @ts-check
import  { gsBackup }              from './gsBackup.js';
import  { gsChrome }              from './gsChrome.js';
import  { gsNewsFeed }            from './gsNewsFeed.js';
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

  // Restoring the persisted capture-logs flag on every wake (not just startupOnce, which
  // runs once per browser session) now lives in gsUtils.js itself, so every context gets
  // it, not just this service worker.

  // navigator.getBattery() is a Window-only API, unavailable in this service worker — the
  // offscreen document runs offscreen.js in a real DOM context to read it instead, reporting
  // charging-state changes back via the 'batteryStatus' message above. The document persists
  // independently of SW recycling once created, but this runs on every wake (not just
  // startupOnce, which is once per browser session) to self-heal if it's ever missing —
  // hasDocument() keeps repeat calls cheap, and a concurrent createDocument() call from
  // another SW wake is caught and ignored rather than treated as an error.
  // chrome.offscreen.hasDocument() only exists from Chrome 150+, but manifest.json's
  // minimum_chrome_version is 110 — on 110-149 calling it would throw and this function
  // would never get past that line, silently disabling battery status on every supported
  // version below 150. clients.matchAll() is a standard ServiceWorkerGlobalScope API
  // available across the whole supported range, so it's used as the existence check there.
  async function hasOffscreenDocument() {
    if (typeof chrome.offscreen.hasDocument === 'function') {
      return chrome.offscreen.hasDocument();
    }
    const matchedClients = await self.clients.matchAll();
    return matchedClients.some((client) => client.url.endsWith('offscreen.html'));
  }

  async function ensureOffscreenDocument() {
    if (!chrome.offscreen) return;
    try {
      if (await hasOffscreenDocument()) return;
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['BATTERY_STATUS'],
        justification: 'Read charging state via navigator.getBattery(), unavailable in the service worker.',
      });
    }
    catch (error) {
      gsUtils.log('background', 'ensureOffscreenDocument', 'createDocument failed (likely a concurrent call)', error);
    }
  }
  ensureOffscreenDocument();

  function startupOnce() {
    gsUtils.log('startupOnce');
    if (startupDone) return;
    startupDone = true;

    tgs.resetAutoSuspendTimerForAllTabs();
    tgs.refreshDefaultIcon();

    Promise.resolve()
      .then(gsStorage.initSettingsAsPromised)   // ensure settings have been loaded and synced
      .then(async () => { await gsStorage.saveStorage('session', 'gsInitialisationMode', true); })
      .then(gsSession.runStartupChecks)         // performs crash check (and maybe recovery) and tab responsiveness checks
      .then(gsBackup.retryPendingDriveBackup)   // upload any Drive backup queued by an emergency onSuspend
      .then(gsBackup.reconcileDownloadsPermission) // catch AUTO_BACKUP_ENABLED arriving via sync/import without the downloads grant
      .then(gsBackup.syncBackupNudgeBadge)      // keep the icon badge (nudge, Drive-auth, or missing-permission error) in sync on every restart
      .catch((error) => {
        gsUtils.error('background startup checks error: ', error);
      });

  }

  if (self instanceof ServiceWorkerGlobalScope) {
    self.addEventListener('install', (event) => {
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
      const contextMenus = await gsStorage.getOption(gsStorage.ADD_CONTEXT);
      tgs.buildContextMenu(contextMenus);
    }

    // remove update message after extension has been updated
    if (details.reason == 'update') {
      await gsStorage.setOptionAndSync(gsStorage.UPDATE_AVAILABLE, false);
    }

  });

  if (self instanceof ServiceWorkerGlobalScope) {
    self.addEventListener('activate', (event) => {
      gsUtils.log('3 service worker activate', event);
      // Only fires on install/update, but also marks the session as started so the
      // onStartup fallback below doesn't run the (heavier) checks a second time.
      event.waitUntil(gsStorage.saveStorage('session', 'gsStartupOnceRun', true));
      startupOnce();
    });
  }

  chrome.runtime.onStartup.addListener(() => {
    gsUtils.log('4 runtime.onStartup');
    // Fired when a profile that has this extension installed first starts up.
    // This event is not fired when an incognito profile is started, even if this extension is operating in 'split' incognito mode.

    startupOnce();

  });

  // Fallback for onStartup unreliability (some Chromium builds, notably Brave, never
  // fire it after a normal restart, see #397). chrome.storage.session is cleared at the
  // browser-session boundary, so a missing sentinel here means this is the first service
  // worker wake of a new browser session, regardless of whether onStartup fired.
  gsStorage.getStorage('session', 'gsStartupOnceRun').then((alreadyRun) => {
    if (!alreadyRun) {
      gsUtils.log('sentinel: first SW wake of a new browser session, running startupOnce');
      gsStorage.saveStorage('session', 'gsStartupOnceRun', true);
      startupOnce();
    }
  });

  chrome.runtime.onSuspend.addListener(() => {
    gsUtils.log('5 runtime.onSuspend');
    gsBackup.performEmergencyBackup(); // fire-and-forget: the service worker may be killed before this resolves
  });
  chrome.runtime.onSuspendCanceled.addListener(() => {
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


  function messageRequestListener(request, sender, sendResponse) {
    // gsAppendLogEntries is handled by gsUtils.js's own dedicated listener (registered
    // separately, since it's the sole writer of the log-buffer storage keys), not by
    // the switch below — it still reaches this listener too, since Chrome delivers a
    // broadcast message to every registered listener independently. Logging it here
    // (even at the top-level log() call below, let alone as "unknown action" in the
    // default case) would add a new entry needing its own flush on every flush cycle,
    // forever. Only this one action is skipped here, unlike the equivalent guard in
    // options.js/suspended.js/updated.js, since this switch is where 'clearLogs' (the
    // other entry in INTERNAL_MESSAGE_ACTIONS) is actually meant to be handled.
    //
    // This check has to run before this function does anything async — declaring the
    // whole function `async` (as it used to be) meant even this early `return false`
    // was wrapped in a Promise rather than being the literal `false` Chrome needs to
    // decline the message synchronously. On Chrome versions that treat a returned
    // Promise as an async response, that Promise could resolve (as `false`) before
    // gsUtils.js's own dedicated listener finished its real, slower `{ success: true }`
    // response, and the sender only keeps whichever response arrives first — so
    // _flushNow() would see `false`, requeue an already-persisted batch, and resend
    // (and re-persist) it every 1.5s indefinitely.
    if (request.action === 'gsAppendLogEntries') return false;

    gsUtils.log('background', 'messageRequestListener', request.action, request, sender);

    // The rest of this listener still needs to run async work before responding, so it
    // returns `true` synchronously (see above) and does that work in this IIFE instead.
    (async () => {
      let responseData;
      try {
        switch (request.action) {
          case 'reportTabState' : {
            const contentScriptStatus = request?.status ?? null;
            if (
              contentScriptStatus === 'formInput' ||
          contentScriptStatus === 'tempWhitelist'
            ) {
              await chrome.tabs.update(sender.tab.id, { autoDiscardable: false });
            }
            else if (!sender.tab.autoDiscardable) {
              await chrome.tabs.update(sender.tab.id, { autoDiscardable: true });
            }
        // If tab is currently visible then update popup icon
            if (sender.tab && await tgs.isCurrentFocusedTab(sender.tab)) {
              await tgs.calculateTabStatus(sender.tab, contentScriptStatus, (status) => {
                tgs.setIconStatus(status, sender.tab.id);
              });
            }
            break;
          }
          case 'savePreviewData' : {
            await gsTabSuspendManager.handlePreviewImageResponse(sender.tab, request.previewUrl, request.errorMsg); // async. unhandled promise
            break;
          }
          case 'fetchNewsFeed' : {
            gsNewsFeed.fetchAndCacheIfStale();
            break;
          }

      // navigator.getBattery() doesn't work in this service worker (Window-only API), so
      // offscreen.js reads it from an offscreen document and reports changes here instead.
          case 'batteryStatus' : {
            await tgs.setCharging(request.charging);
            gsUtils.log('background', `isCharging: ${await tgs.isCharging()}`);
            tgs.setIconStatusForActiveTab();
        // Restart timers on all normal tabs: some may have been prevented from suspending
        // while charging, or need to switch to/from the battery-specific timeout now.
            const hasBatterySpecificTimeout =
          (await gsStorage.getOption(gsStorage.SUSPEND_TIME_ON_BATTERY)) !== '';
            if (
              ((await tgs.isCharging()) === false &&
            await gsStorage.getOption(gsStorage.IGNORE_WHEN_CHARGING)) ||
          hasBatterySpecificTimeout
            ) {
              tgs.resetAutoSuspendTimerForAllTabs();
            }
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
          case 'unsuspendWhitelisted' : {
            tgs.unsuspendWhitelistedTabs();
            break;
          }
          case 'forceSuspendAlwaysList' : {
            tgs.forceSuspendAlwaysListedTabs();
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
            await chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
            break;
          }
          case 'settingsLink' : {
            await chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
            break;
          }
          case 'backupNow' : {
            try {
              await gsBackup.performManualBackup();
            }
            catch (e) {
              if (e?.message !== 'TMS_BACKUP_COOLDOWN') throw e;
            }
            break;
          }
          case 'setCaptureLogs' : {
            gsUtils.captureLogs = request.value;
            break;
          }
          case 'repairFavicons' : {
            responseData = await gsSession.performTabChecks();
            break;
          }
          case 'clearLogs' : {
        // The debug page runs in its own context with its own copy of the gsUtils
        // module — clearing chrome.storage from there doesn't touch this service
        // worker's in-memory _logBuffer/_logBufferFull, so the next log entry (or an
        // already-pending debounced flush) would silently write the old buffers back
        // over the just-cleared storage. Route the clear through here instead.
            responseData = { success: await gsUtils.clearLogBuffer() };
            break;
          }
          default: {
            gsUtils.warning('background', 'messageRequestListener', `Unknown message action: ${request.action}`);
            break;
          }
        }
      }
      catch (error) {
        // Without this, an awaited call throwing (performTabChecks(), a manual-backup
        // failure, etc.) would reject this detached IIFE with nothing ever catching it —
        // sendResponse() below never runs, and since the outer listener already returned
        // `true` to keep the channel open, the sender is left waiting until the message
        // port itself eventually tears down instead of promptly seeing the failure.
        gsUtils.error(`messageRequestListener error for action ${request.action}: `, error);
        responseData = undefined;
      }
      sendResponse(responseData);
    })();
    return true;
  }

  async function externalMessageRequestListener(request, sender, sendResponse) {
    gsUtils.log('background', 'externalMessageRequestListener', request, sender);

    if (!request.action || !['suspend', 'unsuspend'].includes(request.action)) {
      sendResponse('Error: unknown request.action:', request.action);
      return;
    }

    let tab;
    if (request.tabId) {
      if (typeof request.tabId !== 'number') {
        sendResponse('Error: tabId must be an int');
        return;
      }
      tab = await gsChrome.tabsGet(request.tabId);
      if (!tab) {
        sendResponse('Error: no tab found with id:', request.tabId);
        return;
      }
    }
    else {
      tab = await new Promise((r) => {
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
    return true;
  }


  // Listeners must part of the top-level evaluation of the service worker
  async function contextMenuListener(info, tab) {
    gsUtils.log('background', 'contextMenuListener', info.menuItemId);
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
      case 'suspend_tab_group':
      case 'tab_suspend_group':
        tgs.suspendTabGroup(tab);
        break;
      case 'unsuspend_tab_group':
      case 'tab_unsuspend_group':
        tgs.unsuspendTabGroup(tab);
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
        await chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
        break;
      case 'tab_toggle_suspend':
        tgs.toggleSuspendStateOfTab(tab);
        break;
      case 'tab_toggle_pause':
        tgs.requestToggleTempWhitelistStateOfTab(tab);
        break;
      case 'tab_never_suspend_domain':
        tgs.whitelistTab(tab, false);
        break;
      case 'tab_never_suspend_page':
        tgs.whitelistTab(tab, true);
        break;
      case 'tab_soft_suspend_other_tabs':
        tgs.suspendAllTabs(false);
        break;
      case 'tab_unsuspend_all_in_window':
        tgs.unsuspendAllTabs();
        break;
      case 'tab_soft_suspend_all':
        tgs.suspendAllTabsInAllWindows(false);
        break;
      case 'tab_unsuspend_all':
        tgs.unsuspendAllTabsInAllWindows();
        break;
      default:
        break;
    }
  }

  // Listeners must part of the top-level evaluation of the service worker
  async function commandListener(command) {
    gsUtils.log('background', 'commandListener', command);
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
      case '2c-suspend-tab-group': {
        const tab = await new Promise((r) => {
          tgs.getCurrentlyActiveTab(r);
        });
        tgs.suspendTabGroup(tab);
        break;
      }
      case '2d-unsuspend-tab-group': {
        const tab = await new Promise((r) => {
          tgs.getCurrentlyActiveTab(r);
        });
        tgs.unsuspendTabGroup(tab);
        break;
      }
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
        await chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
        break;
    }
  }

  /** @param { chrome.alarms.Alarm } alarm */
  async function alarmListener(alarm) {
    gsUtils.log('background', 'alarmListener', alarm);

    if (alarm.name === gsBackup.ALARM_NAME) {
      await gsBackup.performBackup();
      return;
    }
    if (alarm.name === gsBackup.RETRY_ALARM_NAME) {
      await gsBackup.retryPendingDriveBackup();
      return;
    }
    if (alarm.name === gsNewsFeed.ALARM_NAME) {
      await gsNewsFeed.fetchAndCache();
      return;
    }

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
      gsUtils.log(activeInfo.tabId, 'tab onActivated');
      await tgs.handleTabFocusChanged(activeInfo.tabId, activeInfo.windowId); // async. unhandled promise
    });
    chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
      gsUtils.log(removedTabId, 'tab onReplaced', addedTabId, removedTabId);
      tgs.queueSessionTimer();
      await tgs.removeTabIdReferences(removedTabId);
    });
    chrome.tabs.onCreated.addListener(async (tab) => {
      gsUtils.log(tab.id, 'tab onCreated', tab.url);
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

    async function claimTab(tabId) {
      const tabs  = await gsChrome.tabsQuery();
      for (const tab of tabs) {
        const url = tab.url ?? '';
        if (
          tab.id == tabId &&
          url.match('^chrome-extension://[^/]*/suspended\\.html') &&    // Match any extension with suspended.html at the end
          gsUtils.isSuspendedTab(tab, true) &&
          !url.includes(chrome.runtime.id)                              // But exclude our own extension ID
        ) {
          const newUrl = url.replace(
            gsUtils.getRootUrl(tab.url),
            chrome.runtime.id,
          );
          await gsChrome.tabsUpdate(tab.id, { url: newUrl });
        }
      }
    };

    chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
      gsUtils.log(tabId, 'tab onUpdated', changeInfo, tab.url);
      if (!changeInfo) return;

      if (await gsStorage.getOption(gsStorage.CLAIM_BY_DEFAULT) && changeInfo.status === 'complete') {
        await claimTab(tabId);
      }

      // if url has changed
      if (changeInfo.url) {
        gsUtils.log(tabId, 'background', 'tab url changed', changeInfo);
        tgs.checkForTriggerUrls(tab, changeInfo.url);
        tgs.queueSessionTimer();
      }

      if (gsUtils.isSuspendedTab(tab)) {
        await tgs.handleSuspendedTabStateChanged(tab, changeInfo);
      }
      else if (gsUtils.isNormalTab(tab)) {
        await tgs.handleUnsuspendedTabStateChanged(tab, changeInfo);
      }
    });
    chrome.windows.onCreated.addListener(async (window) => {
      gsUtils.log(window.id, 'background', 'window created.');
      tgs.queueSessionTimer();
    });
    chrome.windows.onRemoved.addListener((windowId) => {
      gsUtils.log(windowId, 'background', 'window removed.');
      tgs.queueSessionTimer();
    });
  }

  // Listeners must part of the top-level evaluation of the service worker
  function addMiscListeners() {
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
    addEventListener('offline', () => {
      gsUtils.log('background', 'Internet is offline.');
      tgs.setIconStatusForActiveTab();
    });

  }

  /** @returns { Promise<void> } */
  function initAsPromised() {
    return new Promise(async (resolve) => {
      gsUtils.log('background', 'PERFORMING BACKGROUND INIT...');

      //initialise currentStationary and currentFocused vars
      const activeTabs = await gsChrome.tabsQuery({ active: true });
      const currentWindow = await gsChrome.windowsGetLastFocused();
      for (const activeTab of activeTabs) {
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
    .catch((error) => {
      gsUtils.error('background init error: ', error);
    })
    .then(initAsPromised)
    .catch((error) => {
      gsUtils.error('background init error: ', error);
    })
    .then(() => gsBackup.syncAlarmWithSettings())
    .then(() => gsBackup.reconcileDownloadsPermission())
    .then(() => gsBackup.syncBackupNudgeBadge())
    .catch((error) => {
      gsUtils.error('background backup alarm sync error: ', error);
    })
    .then(() => gsNewsFeed.syncAlarm())
    .then(() => gsNewsFeed.fetchAndCacheIfStale())
    .catch((error) => {
      gsUtils.error('background news feed init error: ', error);
    });


})();
