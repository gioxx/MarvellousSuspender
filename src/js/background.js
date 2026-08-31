// @ts-check
import  { gsBackup }              from './gsBackup.js';
import  { gsChrome }              from './gsChrome.js';
import  { gsIndexedDb }           from './gsIndexedDb.js';
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

  // Favicon-repair backstop (#474). The startup favicon pass (gsSession.runStartupChecks
  // -> performTabChecks) can be skipped or cut short on Chromium forks whose onStartup is
  // unreliable, or lost to a service-worker recycle mid-run — and gsStartupOnceRun above
  // only records that startup was *attempted*, not that the favicon pass finished. This
  // independent session flag (set by gsSession only once the pass confirms every
  // repairable suspended-tab favicon is good) tracks the favicon pass specifically. While
  // it is unset, each service-worker spawn ensures a one-shot alarm exists to retry the
  // pass; once set, nothing re-arms, so installs where onStartup already works see at most
  // one extra wake. Only create the alarm when none is pending — an unconditional
  // create() replaces the pending one and restarts its ~30s delay, so rapid worker
  // recycling (exactly the environment this targets) could otherwise postpone it forever.
  gsStorage.getStorage('session', 'gsFaviconRepairDone').then(async (done) => {
    if (done) return;
    const existing = await chrome.alarms.get(gsSession.FAVICON_REPAIR_ALARM_NAME);
    if (!existing) {
      chrome.alarms.create(gsSession.FAVICON_REPAIR_ALARM_NAME, { delayInMinutes: 0.5 });
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
            // Through repairFaviconsNow(), not performTabChecks() directly, so a manual
            // repair can't run concurrently with an in-flight favicon-repair backstop
            // cycle (gsTabQueue would double-run a tab).
            responseData = await gsSession.repairFaviconsNow();
            break;
          }
          case 'checkTabResponsiveness' : {
            // Routed through here rather than debug.js calling gsTabCheckManager
            // directly: every page (including debug.html) gets its own separate
            // gsTabCheckManager module instance, and that instance's per-tab
            // deduplication has no visibility into a recovery this service worker's own
            // queue might already be running for the same tab (e.g. tgs.js's own
            // handleTabFocusChanged() reinjecting it). Two independent queues could
            // otherwise both decide to reinject the same tab's content script at once —
            // each execution registers its own runtime listeners, and reinjection is
            // already documented (gsTabCheckManager.js) as leaving old ones active.
            // This service worker's own queue is the single one everything else uses.
            responseData = { status: await gsTabCheckManager.queueTabCheckAsPromise(request.tab) };
            break;
          }
          case 'clearLogs' : {
        // The debug page runs in its own context with its own copy of the gsUtils
        // module — clearing gsIndexedDb's log-entries store from there wouldn't drop
        // this service worker's own not-yet-flushed _pendingEntries, which would
        // otherwise land straight back into the just-cleared store on its next
        // scheduled flush. Route the clear through here instead.
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
    if (alarm.name === gsIndexedDb.LOG_TRIM_ALARM_NAME) {
      await gsIndexedDb.trimLogEntries(gsIndexedDb.LOG_ENTRIES_MAX);
      return;
    }
    if (alarm.name === gsSession.FAVICON_REPAIR_ALARM_NAME) {
      await gsSession.ensureFaviconRepairForSession('alarm');
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

      // Opportunistic favicon-repair backstop (#474): if the session flag shows the
      // startup favicon pass never confirmed success, repair now that the user is
      // actually looking at a suspended tab — no waiting for the alarm above.
      // ensureFaviconRepairForSession() is a no-op once the flag is set, so this costs
      // one chrome.storage.session read per activation until then and nothing afterwards.
      if (!(await gsStorage.getStorage('session', 'gsFaviconRepairDone'))) {
        const activatedTab = await gsChrome.tabsGet(activeInfo.tabId);
        if (activatedTab && gsUtils.isSuspendedTab(activatedTab)) {
          await gsSession.ensureFaviconRepairForSession('tabActivated');
        }
      }
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

    // chrome.tabs.onUpdated fires for every kind of tab-state change this extension
    // cares about ('status', 'url', 'discarded', 'audible', 'pinned' — see the checks
    // below and in tgs.js's handleSuspendedTabStateChanged()/
    // handleUnsuspendedTabStateChanged()), but also for ones it never acts on, chiefly
    // 'frozen'. Live testing found Chrome flips 'frozen' on/off on background/suspended
    // tabs constantly — over 4000 occurrences in a 43-minute session, with dense
    // clusters of dozens within a few seconds — and every single one used to still
    // reach this far, logging (a real cost with captureLogs on: buffering, coalescing,
    // periodic storage flushes) and dispatching into both handler functions before
    // either of them discovered there was nothing to do.
    const RELEVANT_TAB_UPDATE_KEYS = ['status', 'url', 'discarded', 'audible', 'pinned'];
    chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
      if (!changeInfo || !RELEVANT_TAB_UPDATE_KEYS.some((key) => changeInfo.hasOwnProperty(key))) {
        return;
      }
      gsUtils.log(tabId, 'tab onUpdated', changeInfo, tab.url);

      if (changeInfo.status === 'complete' && await gsStorage.getOption(gsStorage.CLAIM_BY_DEFAULT)) {
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
      else {
        // Reaching here at all (isSuspendedTab() read false above) is proof this tab is
        // no longer suspended, regardless of whether isNormalTab() below also accepts it
        // — a queued or already-running _runInitSuspendedTabLimited() job for this tab is
        // stale either way. A tab navigating to a chrome://, another extension's, or
        // otherwise "special" URL (isNormalTab() excludes those) previously fell through
        // both branches entirely, so tgs.js's own cancellation call (only reachable from
        // inside handleUnsuspendedTabStateChanged(), gated on isNormalTab() below) never
        // ran for that case. Cancelling unconditionally here covers every non-suspended
        // case; tgs.js's shared cancellation token (see _runInitSuspendedTabLimited()) then
        // takes care of stopping a job that's already running, not just one still queued.
        tgs.cancelInitSuspendedTab(tabId);
        if (gsUtils.isNormalTab(tab)) {
          await tgs.handleUnsuspendedTabStateChanged(tab, changeInfo);
        }
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

      // Deliberately NOT cleaning up the old chrome.storage.local-backed log buffer's keys
      // (gsLogBuffer, gsLogBufferFull, gsLogBufferVersion, gsLogBufferClearedAt) here or
      // anywhere else. An earlier version of this code did exactly that from this same
      // service-worker init, on the theory that bounding *who* calls remove() (at most the
      // two service worker instances "incognito": "split" creates, rather than every open
      // context) was enough to avoid the broadcast-fanout problem this whole migration
      // exists to eliminate. It wasn't: chrome.storage.local.remove() broadcasts the
      // removed key's full oldValue to *every* context with an onChanged listener
      // regardless of which context called remove() — a profile that had already
      // accumulated a multi-MB gsLogBufferFull under the old design would still deliver
      // that same multi-MB payload to every suspended tab on the one call that actually
      // succeeds, no matter how few contexts attempt it. These keys are genuinely orphaned
      // (nothing reads them any more) and harmless left in place — a few MB of dead data
      // sitting in chrome.storage.local forever is a far better trade than risking that
      // broadcast during exactly the many-suspended-tabs scenario that caused the original
      // crash.

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
    })
    .then(() => gsIndexedDb.syncLogTrimAlarm())
    // The alarm itself only fires every 5 minutes at the soonest — fine for keeping the
    // store bounded during a long session, but a profile that grew past the cap before
    // this alarm mechanism even existed (or during whatever gap it takes this fix to
    // reach a given install) would otherwise sit oversized for up to that same 5 minutes
    // after every single service worker restart in the meantime. One immediate trim here,
    // from the same single place (service worker init) the alarm itself already runs
    // from, catches it up right away instead of waiting on the first periodic tick.
    .then(() => gsIndexedDb.trimLogEntries(gsIndexedDb.LOG_ENTRIES_MAX))
    .catch((error) => {
      gsUtils.error('background log-trim alarm sync error: ', error);
    });


})();
