// @ts-check
import  { gsChrome }              from './gsChrome.js';
import  { gsMascot }              from './gsMascot.js';
import  { gsMessages }            from './gsMessages.js';
import  { gsSession }             from './gsSession.js';
import  { gsStorage }             from './gsStorage.js';
import  { gsTabSuspendManager }   from './gsTabSuspendManager.js';
import  { gsTabCheckManager }     from './gsTabCheckManager.js';
import  { gsTabDiscardManager }   from './gsTabDiscardManager.js';
import  { gsUtils }               from './gsUtils.js';

export const tgs = (function() {

  const ICON_SUSPENSION_ACTIVE = {
    '16': '/img/ic_suspendy_16x16.png',
    '32': '/img/ic_suspendy_32x32.png',
  };
  const ICON_SUSPENSION_PAUSED = {
    '16': '/img/ic_suspendy_16x16_grey.png',
    '32': '/img/ic_suspendy_32x32_grey.png',
  };

  // Suspended tab props
  const STATE_TEMP_WHITELIST_ON_RELOAD = 'whitelistOnReload';
  const STATE_DISABLE_UNSUSPEND_ON_RELOAD = 'disableUnsuspendOnReload';
  const STATE_INITIALISE_SUSPENDED_TAB = 'initialiseSuspendedTab';
  const STATE_UNLOADED_URL = 'unloadedUrl';
  const STATE_HISTORY_URL_TO_REMOVE = 'historyUrlToRemove';
  const STATE_SET_AUTODISCARDABLE = 'setAutodiscardable';
  const STATE_SUSPEND_REASON = 'suspendReason'; // 1=auto-suspend, 2=manual-suspend, 3=discarded
  const STATE_SCROLL_POS = 'scrollPos';

  const focusDelay = 500;


  let _sessionSaveTimer;
  let _newTabFocusTimer;
  let _newWindowFocusTimer;


  function getCurrentlyActiveTab(callback) {
    // wrap this in an anonymous async function so we can use await
    (async function() {
      const currentWindowActiveTabs = await gsChrome.tabsQuery({ active: true, currentWindow: true });
      if (currentWindowActiveTabs.length > 0) {
        callback(currentWindowActiveTabs[0]);
        return;
      }

      // Fallback on chrome.windows.getLastFocused
      const lastFocusedWindow = await gsChrome.windowsGetLastFocused();
      if (lastFocusedWindow) {
        const lastFocusedWindowActiveTabs = await gsChrome.tabsQuery({ active: true, windowId: lastFocusedWindow.id });
        if (lastFocusedWindowActiveTabs.length > 0) {
          callback(lastFocusedWindowActiveTabs[0]);
          return;
        }
      }

      // Fallback on gsCurrentStationaryWindowId
      const gsCurrentStationaryWindowId = await gsStorage.getStorageJSON('session', 'gsCurrentStationaryWindowId');
      if (gsCurrentStationaryWindowId) {
        const currentStationaryWindowActiveTabs = await gsChrome.tabsQuery({ active: true, windowId: gsCurrentStationaryWindowId });
        if (currentStationaryWindowActiveTabs.length > 0) {
          callback(currentStationaryWindowActiveTabs[0]);
          return;
        }

        // Fallback on currentStationaryTabId
        const currentStationaryTabId = (await getCurrentStationaryTabIdByWindowId())[gsCurrentStationaryWindowId];
        if (currentStationaryTabId) {
          const currentStationaryTab = await gsChrome.tabsGet( currentStationaryTabId );
          if (currentStationaryTab !== null) {
            callback(currentStationaryTab);
            return;
          }
        }
      }
      callback(null);
    })();
  }

  // NOTE: Stationary here means has had focus for more than focusDelay ms
  // So it may not necessarily have the tab.active flag set to true
  async function isCurrentStationaryTab(tab) {
    if (tab.windowId !== await gsStorage.getStorageJSON('session', 'gsCurrentStationaryWindowId')) {
      return false;
    }
    var lastStationaryTabIdForWindow = (await getCurrentStationaryTabIdByWindowId())[tab.windowId];
    if (lastStationaryTabIdForWindow) {
      return tab.id === lastStationaryTabIdForWindow;
    }
    else {
      // fallback on active flag
      return tab.active;
    }
  }

  async function isCurrentFocusedTab(tab) {
    if (tab.windowId !== await gsStorage.getStorageJSON('session', 'gsCurrentFocusedWindowId')) {
      return false;
    }
    var currentFocusedTabIdForWindow = (await getCurrentFocusedTabIdByWindowId())[tab.windowId];
    if (currentFocusedTabIdForWindow) {
      return tab.id === currentFocusedTabIdForWindow;
    }
    else {
      // fallback on active flag
      return tab.active;
    }
  }

  async function isCurrentActiveTab(tab) {
    const activeTabIdForWindow = (await getCurrentFocusedTabIdByWindowId())[tab.windowId];
    if (activeTabIdForWindow) {
      return tab.id === activeTabIdForWindow;
    }
    else {
      // fallback on active flag
      return tab.active;
    }
  }

  function whitelistHighlightedTab(includePath) {
    includePath = includePath || false;
    getCurrentlyActiveTab(async (activeTab) => {
      if (activeTab) {
        if (gsUtils.isSuspendedTab(activeTab)) {
          const url = gsUtils.getRootUrl(
            gsUtils.getOriginalUrl(activeTab.url),
            includePath,
            false,
          );
          await gsUtils.saveToWhitelist(url);
          await unsuspendTab(activeTab);
        }
        else if (gsUtils.isNormalTab(activeTab)) {
          const url = gsUtils.getRootUrl(activeTab.url, includePath, false);
          await gsUtils.saveToWhitelist(url);
          calculateTabStatus(activeTab, null, (status) => {
            setIconStatus(status, activeTab.id);
          });
        }
      }
    });
  }

  function unwhitelistHighlightedTab(callback) {
    getCurrentlyActiveTab((activeTab) => {
      if (activeTab) {
        gsUtils.removeFromWhitelist(activeTab.url).then(() => {
          calculateTabStatus(activeTab, null, (status) => {
            setIconStatus(status, activeTab.id);
            if (callback) callback(status);
          });
        });
      }
      else {
        if (callback) callback(gsUtils.STATUS_UNKNOWN);
      }
    });
  }

  function requestToggleTempWhitelistStateOfHighlightedTab(callback) {
    getCurrentlyActiveTab(async (activeTab) => {
      if (!activeTab) {
        if (callback) callback(gsUtils.STATUS_UNKNOWN);
        return;
      }
      if (gsUtils.isSuspendedTab(activeTab)) {
        await unsuspendTab(activeTab);
        if (callback) callback(gsUtils.STATUS_UNKNOWN);
        return;
      }
      if (!gsUtils.isNormalTab(activeTab, true)) {
        if (callback) callback(gsUtils.STATUS_UNKNOWN);
        return;
      }

      calculateTabStatus(activeTab, null, (status) => {
        if (
          status === gsUtils.STATUS_ACTIVE ||
          status === gsUtils.STATUS_NORMAL
        ) {
          setTempWhitelistStateForTab(activeTab, callback);
        }
        else if (
          status === gsUtils.STATUS_TEMPWHITELIST ||
          status === gsUtils.STATUS_FORMINPUT
        ) {
          unsetTempWhitelistStateForTab(activeTab, callback);
        }
        else {
          if (callback) callback(status);
        }
      });
    });
  }

  function setTempWhitelistStateForTab(tab, callback) {
    gsMessages.sendTemporaryWhitelistToContentScript(tab.id, (
      error,
      response,
    ) => {
      if (error) {
        gsUtils.warning( tab.id, 'tgs', 'setTempWhitelistStateForTab', 'Failed to sendTemporaryWhitelistToContentScript', error );
      }
      var contentScriptStatus =
        response && response.status ? response.status : null;
      calculateTabStatus(tab, contentScriptStatus, (newStatus) => {
        setIconStatus(newStatus, tab.id);
        //This is a hotfix for issue #723
        if (newStatus === 'tempWhitelist' && tab.autoDiscardable) {
          chrome.tabs.update(tab.id, {
            autoDiscardable: false,
          });
        }
        if (callback) callback(newStatus);
      });
    });
  }

  function unsetTempWhitelistStateForTab(tab, callback) {
    gsMessages.sendUndoTemporaryWhitelistToContentScript(tab.id, (
      error,
      response,
    ) => {
      if (error) {
        gsUtils.warning( tab.id, 'tgs', 'unsetTempWhitelistStateForTab', 'Failed to sendUndoTemporaryWhitelistToContentScript', error );
      }
      var contentScriptStatus =
        response && response.status ? response.status : null;
      calculateTabStatus(tab, contentScriptStatus, (newStatus) => {
        setIconStatus(newStatus, tab.id);
        //This is a hotfix for issue #723
        if (newStatus !== 'tempWhitelist' && !tab.autoDiscardable) {
          chrome.tabs.update(tab.id, {
            //async
            autoDiscardable: true,
          });
        }
        if (callback) callback(newStatus);
      });
    });
  }

  function openLinkInSuspendedTab(parentTab, linkedUrl) {
    //imitate chromes 'open link in new tab' behaviour in how it selects the correct index
    chrome.tabs.query({ windowId: chrome.windows.WINDOW_ID_CURRENT }, (tabs) => {
      var newTabIndex = parentTab.index + 1;
      var nextTab = tabs[newTabIndex];
      while (nextTab && nextTab.openerTabId === parentTab.id) {
        newTabIndex++;
        nextTab = tabs[newTabIndex];
      }
      var newTabProperties = {
        url: linkedUrl,
        index: newTabIndex,
        openerTabId: parentTab.id,
        active: false,
      };
      chrome.tabs.create(newTabProperties, (tab) => {
        gsTabSuspendManager.queueTabForSuspension(tab, 1);
      });
    });
  }

  function toggleSuspendedStateOfHighlightedTab() {
    getCurrentlyActiveTab(async (activeTab) => {
      if (activeTab) {
        if (gsUtils.isSuspendedTab(activeTab)) {
          await unsuspendTab(activeTab);
        }
        else {
          gsTabSuspendManager.queueTabForSuspension(activeTab, 1);
        }
      }
    });
  }

  function suspendHighlightedTab() {
    getCurrentlyActiveTab((activeTab) => {
      if (activeTab) {
        gsTabSuspendManager.queueTabForSuspension(activeTab, 1);
      }
    });
  }

  function unsuspendHighlightedTab() {
    getCurrentlyActiveTab(async (activeTab) => {
      if (activeTab && gsUtils.isSuspendedTab(activeTab)) {
        await unsuspendTab(activeTab);
      }
    });
  }

  function suspendAllTabs(force) {
    const forceLevel = force ? 1 : 2;
    getCurrentlyActiveTab((activeTab) => {
      if (!activeTab) {
        gsUtils.warning( 'tgs', 'suspendAllTabs', 'Could not determine currently active window.' );
        return;
      }
      chrome.windows.get(activeTab.windowId, { populate: true }, (curWindow) => {
        for (const tab of curWindow.tabs ?? []) {
          if (!tab.active) {
            gsTabSuspendManager.queueTabForSuspension(tab, forceLevel);
          }
        }
      });
    });
  }

  function suspendAllTabsInAllWindows(force) {
    const forceLevel = force ? 1 : 2;
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        gsTabSuspendManager.queueTabForSuspension(tab, forceLevel);
      }
    });
  }

  function unsuspendAllTabs() {
    getCurrentlyActiveTab((activeTab) => {
      if (!activeTab) {
        gsUtils.warning( 'tgs', 'unsuspendAllTabs', 'Could not determine currently active window.' );
        return;
      }
      chrome.windows.get(activeTab.windowId, { populate: true }, async (curWindow) => {
        for (const tab of curWindow.tabs ?? []) {
          gsTabSuspendManager.unqueueTabForSuspension(tab);
          if (gsUtils.isSuspendedTab(tab)) {
            await unsuspendTab(tab);
          }
          else if (gsUtils.isNormalTab(tab) && !tab.active) {
            await resetAutoSuspendTimerForTab(tab);
          }
        }
      });
    });
  }

  function unsuspendAllTabsInAllWindows() {
    chrome.windows.getLastFocused({}, (currentWindow) => {
      chrome.tabs.query({}, async (tabs) => {
        // Because of the way that unsuspending steals window focus, we defer the suspending of tabs in the
        // current window until last
        var deferredTabs = [];
        for (const tab of tabs) {
          gsTabSuspendManager.unqueueTabForSuspension(tab);
          if (gsUtils.isSuspendedTab(tab)) {
            if (tab.windowId === currentWindow.id) {
              deferredTabs.push(tab);
            }
            else {
              await unsuspendTab(tab);
            }
          }
          else if (gsUtils.isNormalTab(tab)) {
            await resetAutoSuspendTimerForTab(tab);
          }
        }
        for (const tab of deferredTabs) {
          await unsuspendTab(tab);
        }
      });
    });
  }

  function unsuspendWhitelistedTabs() {
    chrome.windows.getLastFocused({}, (currentWindow) => {
      const currentWindowId = currentWindow?.id;
      gsUtils.log('tgs', 'unsuspendWhitelistedTabs currentWindow', currentWindowId);
      chrome.tabs.query({}, async (tabs) => {
        const whitelist = await gsStorage.getOption(gsStorage.WHITELIST);
        gsUtils.log('tgs', 'unsuspendWhitelistedTabs tabs total', tabs.length, 'whitelist', JSON.stringify(whitelist));
        var deferredTabs = [];
        for (const tab of tabs) {
          if (!gsUtils.isSuspendedTab(tab)) continue;
          const originalUrl = gsUtils.getOriginalUrl(tab.url);
          const isWhitelisted = originalUrl ? gsUtils.checkSpecificWhiteList(originalUrl, whitelist) : false;
          gsUtils.log(tab.id, 'unsuspendWhitelistedTabs check', originalUrl, 'whitelisted:', isWhitelisted);
          if (!originalUrl || !isWhitelisted) continue;
          gsTabSuspendManager.unqueueTabForSuspension(tab);
          if (tab.windowId === currentWindowId) {
            deferredTabs.push(tab);
          } else {
            await unsuspendTab(tab);
          }
        }
        gsUtils.log('tgs', 'unsuspendWhitelistedTabs deferred', deferredTabs.length);
        for (const tab of deferredTabs) {
          await unsuspendTab(tab);
        }
      });
    });
  }

  function forceSuspendAlwaysListedTabs() {
    chrome.tabs.query({}, async (tabs) => {
      const alwaysList = await gsStorage.getOption(gsStorage.ALWAYS_SUSPEND_LIST);
      gsUtils.log('tgs', 'forceSuspendAlwaysListedTabs tabs total', tabs.length, 'alwaysList', JSON.stringify(alwaysList));
      for (const tab of tabs) {
        if (gsUtils.isSuspendedTab(tab)) continue;
        const isListed = gsUtils.checkSpecificAlwaysSuspendList(tab.url, alwaysList);
        gsUtils.log(tab.id, 'forceSuspendAlwaysListedTabs check', tab.url, 'listed:', isListed);
        if (!isListed) continue;
        gsTabSuspendManager.queueTabForSuspension(tab, 1);
      }
    });
  }

  function suspendSelectedTabs() {
    chrome.tabs.query(
      { highlighted: true, lastFocusedWindow: true },
      (selectedTabs) => {
        for (const tab of selectedTabs) {
          gsTabSuspendManager.queueTabForSuspension(tab, 1);
        }
      },
    );
  }

  function unsuspendSelectedTabs() {
    chrome.tabs.query({ highlighted: true, lastFocusedWindow: true }, async (selectedTabs) => {
      for (const tab of selectedTabs) {
        gsTabSuspendManager.unqueueTabForSuspension(tab);
        if (gsUtils.isSuspendedTab(tab)) {
          await unsuspendTab(tab);
        }
      }
    });
  }

  function suspendTabGroup(tab) {
    if (!tab || typeof tab.groupId !== 'number' || tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
      return;
    }
    chrome.tabs.query({ groupId: tab.groupId }, (groupTabs) => {
      for (const groupTab of groupTabs) {
        // forceLevel 2 for the rest of the group, not 1: this suspends every tab in the
        // group in one go, not just the one the user acted on, so whitelist/pinned/audible/
        // active-tab/form-input protections must still apply to the tabs swept up by the
        // group action. The acted-on tab itself stays at forceLevel 1 (matching the
        // single-tab/selected-tabs force-suspend actions): level 2 unconditionally rejects
        // the active tab, so if the user explicitly triggered this on the active tab (e.g.
        // via the keyboard shortcut), it would otherwise never get suspended at all.
        gsTabSuspendManager.queueTabForSuspension(groupTab, groupTab.id === tab.id ? 1 : 2);
      }
    });
  }

  function unsuspendTabGroup(tab) {
    if (!tab || typeof tab.groupId !== 'number' || tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
      return;
    }
    chrome.tabs.query({ groupId: tab.groupId }, (groupTabs) => {
      groupTabs.forEach((groupTab) => {
        gsTabSuspendManager.unqueueTabForSuspension(groupTab);
        if (gsUtils.isSuspendedTab(groupTab)) {
          unsuspendTab(groupTab);
        }
      });
    });
  }

  function queueSessionTimer() {
    clearTimeout(_sessionSaveTimer);
    _sessionSaveTimer = setTimeout(() => {
      gsSession.updateCurrentSession(); //async
    }, 1000);
  }

  async function resetAutoSuspendTimerForTab(tab) {
    await clearAutoSuspendTimerForTabId(tab.id);

    let suspendTime = await gsStorage.getOption(gsStorage.SUSPEND_TIME);
    // A battery-specific timeout (#252) only kicks in when one is actually set and we
    // know for certain we're running unplugged — isCharging() returns undefined (not
    // false) both when navigator.getBattery is unavailable in this MV3 service worker
    // and before its initial promise resolves, so an explicit === false check is
    // required here; treating "unknown" as "unplugged" would apply the override while
    // still on AC.
    if ((await isCharging()) === false) {
      const suspendTimeOnBattery = await gsStorage.getOption(gsStorage.SUSPEND_TIME_ON_BATTERY);
      if (suspendTimeOnBattery !== '') {
        suspendTime = suspendTimeOnBattery;
      }
    }
    if (
      (await gsUtils.isProtectedActiveTab(tab)) ||
      isNaN(suspendTime) ||
      suspendTime <= 0
    ) {
      return;
    }

    const timeToSuspend = suspendTime * (1000 * 60);
    const when          = new Date().getTime() + timeToSuspend;

    chrome.alarms.create( String(tab.id), { when } )
      .catch((error) => {
        gsUtils.warning(tab.id, 'tgs', 'resetAutoSuspendTimerForTab', 'chrome alarm create failed', error);
      });

    gsUtils.log( tab.id, 'tgs', 'resetAutoSuspendTimerForTab', timeToSuspend, new Date(when) );
  }

  function resetAutoSuspendTimerForAllTabs() {
    gsUtils.log(0, 'tgs', 'resetAutoSuspendTimerForAllTabs');
    // Per-tab suspension alarms are named by tab id (a numeric string, see
    // alarmListener's `parseInt(alarm.name)` in background.js) — clear only those,
    // not chrome.alarms.clearAll(), which would also wipe the unrelated named
    // auto-backup/retry/news-feed alarms that this function has nothing to do with.
    chrome.alarms.getAll((alarms) => {
      for (const alarm of alarms) {
        if (/^\d+$/.test(alarm.name)) {
          chrome.alarms.clear(alarm.name);
        }
      }
    });
    chrome.tabs.query({}, async (tabs) => {
      for (const tab of tabs) {
        if (gsUtils.isNormalTab(tab)) {
          await resetAutoSuspendTimerForTab(tab);
        }
      }
    });
  }

  async function clearAutoSuspendTimerForTabId(tabId) {
    gsUtils.log(tabId, 'tgs', 'clearAutoSuspendTimerForTabId');
    return chrome.alarms.clear(String(tabId))
      .catch((error) => {});

  }

  async function getTabStatePropForTabId(tabId, prop) {
    const state = await getTabStateForTabId(tabId);
    const ret = state ? state[prop] : undefined;
    // gsUtils.log(tabId, 'tgs', 'getTabStatePropForTabId', prop, ret);
    return ret;
  }

  async function setTabStatePropForTabId(tabId, prop, value) {
    const state = (await getTabStateForTabId(tabId)) || {};
    state[prop] = value;
    // gsUtils.log(tabId, 'tgs', 'setTabStatePropForTabId', state);
    return gsStorage.saveTabState(tabId, state);
  }

  async function getTabStateForTabId(tabId) {
    const ret = await gsStorage.getTabState(tabId);
    // gsUtils.log(tabId, 'tgs', 'getTabStateForTabId', ret);
    return ret;
  }

  // async function saveTabStateForTabId(tabId, state) {
  //   gsUtils.log(tabId, 'saveTabStateForTabId');
  //   return gsStorage.saveTabState(tabId, state);
  // }

  async function deleteTabStateForTabId(tabId) {
    // gsUtils.log(tabId, 'deleteTabStateForTabId');
    await clearAutoSuspendTimerForTabId(tabId);
    return gsStorage.deleteTabState(tabId);
  }

  async function unsuspendTab(tab) {
    gsUtils.log(tab.id, 'unsuspendTab', tab.url);
    if (!gsUtils.isSuspendedTab(tab)) return;

    const dontRestoreScrollPos = await gsStorage.getOption(gsStorage.IGNORE_SCROLL_POS);
    const scrollPosition = dontRestoreScrollPos ? 'top' : gsUtils.getSuspendedScrollPosition(tab.url);
    await tgs.setTabStatePropForTabId(tab.id, tgs.STATE_SCROLL_POS, scrollPosition);

    const originalUrl = gsUtils.getOriginalUrl(tab.url);
    if (originalUrl) {
      // Reloading chrome.tabs.update causes a history item for the suspended tab
      // to be made in the tab history. We clean this up on tab updated hook
      await setTabStatePropForTabId(tab.id, tgs.STATE_HISTORY_URL_TO_REMOVE, tab.url);
      if (tab.autoDiscardable) {
        await setTabStatePropForTabId(tab.id, tgs.STATE_SET_AUTODISCARDABLE, tab.url);
      }
      // NOTE: Temporarily disable autoDiscardable, as there seems to be a bug
      // where discarded (and frozen?) suspended tabs will not unsuspend with
      // chrome.tabs.update if this is set to true. This gets unset again after tab
      // has reloaded via the STATE_SET_AUTODISCARDABLE flag.
      gsUtils.log(tab.id, 'Unsuspending tab via chrome.tabs.update');
      await chrome.tabs.update(tab.id, { url: originalUrl, autoDiscardable: false });
      return;
    }

    gsUtils.log(tab.id, 'Failed to execute unsuspend tab.');
  }

  function buildSuspensionToggleHotkey() {
    return new Promise((resolve) => {
      let printableHotkey = '';
      chrome.commands.getAll((commands) => {
        const toggleCommand = commands.find((o) => o.name === '1-suspend-tab');
        if (toggleCommand && toggleCommand.shortcut !== '') {
          printableHotkey = gsUtils.formatHotkeyString(toggleCommand.shortcut);
          resolve(printableHotkey);
        }
        else {
          resolve(null);
        }
      });
    });
  }

  /**
   * @param {chrome.tabs.Tab} tab
   * @param {string} url
   */
  function checkForTriggerUrls(tab, url) {
    if (gsUtils.isBrowserInternalURL(url, '://extensions/shortcuts')) {
      gsStorage.saveStorage('session', 'gsTriggerHotkeyUpdate', true);
    }
  }

  async function handleUnsuspendedTabStateChanged(tab, changeInfo) {
    if (
      !changeInfo.hasOwnProperty('status') &&
      !changeInfo.hasOwnProperty('audible') &&
      !changeInfo.hasOwnProperty('pinned') &&
      !changeInfo.hasOwnProperty('discarded')
    ) {
      return;
    }
    gsUtils.log( tab.id, 'unsuspended tab state changed, changeInfo', changeInfo );

    // Ensure we clear the STATE_UNLOADED_URL flag during load in case the
    // tab is suspended again before loading can finish (in which case on
    // suspended tab complete, the tab will reload again)
    if (
      changeInfo.hasOwnProperty('status') &&
      changeInfo.status === 'loading'
    ) {
      await setTabStatePropForTabId(tab.id, STATE_UNLOADED_URL, null);
    }

    // Check if tab has just been discarded
    if (changeInfo.hasOwnProperty('discarded') && changeInfo.discarded) {
      const existingSuspendReason = await getTabStatePropForTabId( tab.id, STATE_SUSPEND_REASON );
      if (existingSuspendReason && existingSuspendReason === 3) {
        // For some reason the discarded changeInfo gets called twice (chrome bug?)
        // As a workaround we use the suspend reason to determine if we've already
        // handled this discard
        //TODO: Report chrome bug
        return;
      }
      gsUtils.log( tab.id, 'Unsuspended tab has been discarded, Url', tab.url );
      await gsTabDiscardManager.handleDiscardedUnsuspendedTab(tab); //async. unhandled promise.

      // When a tab is discarded the tab id changes. We need up-to-date UNSUSPENDED
      // tabIds in the current session otherwise crash recovery will not work
      queueSessionTimer();
      return;
    }

    // Check if tab is queued for suspension
    const queuedTabDetails = gsTabSuspendManager.getQueuedTabDetails(tab);
    if (queuedTabDetails) {
      // Requeue tab to wake it from possible sleep
      delete queuedTabDetails.executionProps.refetchTab;
      gsTabSuspendManager.queueTabForSuspension( tab, queuedTabDetails.executionProps.forceLevel );
      return;
    }

    let hasTabStatusChanged = false;

    // Check for change in tabs audible status
    if (changeInfo.hasOwnProperty('audible')) {
      const ignoreAudio = await gsStorage.getOption(gsStorage.IGNORE_AUDIO);
      //reset tab timer if tab has just finished playing audio
      if (!changeInfo.audible && ignoreAudio) {
        await resetAutoSuspendTimerForTab(tab);
      }
      hasTabStatusChanged = true;
    }
    if (changeInfo.hasOwnProperty('pinned')) {
      const ignorePinned = await gsStorage.getOption(gsStorage.IGNORE_PINNED);
      //reset tab timer if tab has become unpinned
      if (!changeInfo.pinned && ignorePinned) {
        await resetAutoSuspendTimerForTab(tab);
      }
      hasTabStatusChanged = true;
    }

    if (changeInfo.hasOwnProperty('status')) {
      if (changeInfo.status === 'complete') {
        const tempWhitelistOnReload = await getTabStatePropForTabId( tab.id, STATE_TEMP_WHITELIST_ON_RELOAD );
        const scrollPos             = await getTabStatePropForTabId( tab.id, STATE_SCROLL_POS) || null;
        const historyUrlToRemove    = await getTabStatePropForTabId( tab.id, STATE_HISTORY_URL_TO_REMOVE );
        const setAutodiscardable    = await getTabStatePropForTabId( tab.id, STATE_SET_AUTODISCARDABLE );
        await deleteTabStateForTabId(tab.id);

        if (historyUrlToRemove) {
          removeTabHistoryForUnsuspendedTab(historyUrlToRemove);
        }
        if (setAutodiscardable) {
          await gsChrome.tabsUpdate(tab.id, { autoDiscardable: true });
        }

        //init loaded tab
        await resetAutoSuspendTimerForTab(tab);
        if (gsUtils.isNormalTab(tab, true)) {
          let contentScriptStatus = await getContentScriptStatus(tab.id);
          if (!contentScriptStatus) {
            contentScriptStatus = await gsTabCheckManager.queueTabCheckAsPromise( tab, {}, 0 );
          }
          gsUtils.log( tab.id, 'Content script status', contentScriptStatus );
        }
        initialiseTabContentScript(tab, tempWhitelistOnReload, scrollPos)
          .catch((error) => {
            gsUtils.warning( tab.id, 'tgs', 'handleUnsuspendedTabStateChanged', 'Failed to send init to content script. Tab may not behave as expected.', error );
          });
          // .then(() => {
          //   // could use returned tab status here below
          // });
      }

      hasTabStatusChanged = true;
    }

    //if tab is currently visible then update popup icon
    if (hasTabStatusChanged && await isCurrentFocusedTab(tab)) {
      calculateTabStatus(tab, null, (status) => {
        setIconStatus(status, tab.id);
      });
    }
  }

  function removeTabHistoryForUnsuspendedTab(suspendedUrl) {
    chrome.history.deleteUrl({ url: suspendedUrl });
    const originalUrl = gsUtils.getOriginalUrl(suspendedUrl);
    chrome.history.getVisits({ url: originalUrl }, (visits) => {
      //assume history entry will be the second to latest one (latest one is the currently visible page)
      //NOTE: this will break if the same url has been visited by another tab more recently than the
      //suspended tab (pre suspension)
      // const latestVisit = visits.pop();
      const previousVisit = visits.pop();
      if (previousVisit) {
        chrome.history.deleteRange(
          {
            startTime : (previousVisit.visitTime ?? 0) - 0.1,
            endTime   : (previousVisit.visitTime ?? 0) + 0.1,
          },
          () => {},
        );
      }
    });
  }

  function initialiseTabContentScript(tab, isTempWhitelist, scrollPos) {
    return new Promise(async (resolve, reject) => {
      const ignoreForms = await gsStorage.getOption(gsStorage.IGNORE_FORMS);
      gsMessages.sendInitTabToContentScript(tab.id, ignoreForms, isTempWhitelist, scrollPos, (error, response) => {
        if (error) {
          reject(error);
        }
        else {
          resolve(response);
        }
      });
    });
  }

  async function handleSuspendedTabStateChanged(tab, changeInfo) {
    if (
      !changeInfo.hasOwnProperty('status') &&
      !changeInfo.hasOwnProperty('discarded')
    ) {
      return;
    }

    gsUtils.log( tab.id, 'tgs', 'handleSuspendedTabStateChanged', changeInfo );

    // A tab discarded while its own initialiseSuspendedTab() job is queued or already
    // retrying stays isSuspendedTab() === true (the URL never changes on discard), so
    // background.js keeps routing its onUpdated events through this suspended branch
    // instead of the one that already cancels on a non-suspended transition. Without this,
    // a discard landing *after* that job's own one-time freshTab.discarded check (e.g.
    // during one of sendInitTabMessageWithRetry()'s own retry delays) had nothing left able
    // to stop it short of the full ~6s budget, occupying a limiter slot against a page with
    // no live receiver the whole time. Cancelling here reaches the same shared token that
    // retry loop already checks on every attempt, regardless of which one it's currently in.
    if (changeInfo.discarded) {
      _cancelInitSuspendedTab(tab.id);
    }

    // Manifest V3:  This function runs async, and the blank suspended pages load fast enough
    // where the state transitions from 'loading' to 'complete' before we have a chance to
    // write the tab state to session storage.  Instead of delaying or queuing the 'complete'
    // processing, it seems there's no reason to first detect 'loading' before initializing
    // the suspended tab upon 'complete'.  If tab state changes and changeInfo shows 'complete'
    // it seems we will ALWAYS want to initialize the suspended tab

    // For now, we'll keep the tab state save to session storage
    if (changeInfo.status && changeInfo.status === 'loading') {
      // gsUtils.log( tab.id, 'tgs', 'handleSuspendedTabStateChanged loading' );
      await setTabStatePropForTabId( tab.id, tgs.STATE_INITIALISE_SUSPENDED_TAB, true );
      return;
    }

    // NOTE: It's unclear why changeInfo.discarded is needed here.
    // If the tab has transitioned to discarded, we don't want to initialize it?
    if ( (changeInfo.status && changeInfo.status === 'complete') /* || changeInfo.discarded */ ) {
      // gsUtils.log( tab.id, 'tgs', 'handleSuspendedTabStateChanged complete or discarded' );
      gsTabSuspendManager.unqueueTabForSuspension(tab); //safety precaution
      // NOTE: See above as to why this is commented out
      // const shouldInitTab = await getTabStatePropForTabId( tab.id, STATE_INITIALISE_SUSPENDED_TAB );
      // if (shouldInitTab) {
      await initialiseSuspendedTab(tab);
      // }
    }
  }

  // chrome.tabs.onUpdated fires this listener independently per tab, with no throttling
  // of its own — when Chrome un-discards/reloads several suspended tabs at once (e.g. a
  // window regaining focus after being idle long enough for memory pressure to discard
  // them), every one of those tabs fires 'complete' within the same short window, and
  // each one immediately triggers real, memory-heavy work: suspended.js's own 'initTab'
  // handler awaits its full favicon/title/theme setup (IndexedDB reads included) before
  // ever calling sendResponse(), so chrome.tabs.sendMessage() here genuinely blocks on
  // that real work finishing, not just a quick acknowledgement — confirmed by reading
  // suspended.js's handleMessageRequest() directly, not inferred from timing alone,
  // after an earlier version of this fix wrongly assumed sends resolved almost
  // instantly and used a fixed-interval batch release instead of a real concurrency
  // bound, which review caught as still allowing unbounded concurrent in-flight work
  // whenever any single tab's response took longer than the batch interval.
  //
  // This holds a job's slot for its *actual* duration — released only once the real
  // work (message round trip + checkQueue enqueue) resolves, not on a fixed timer — so
  // a burst of many tabs is capped at this many genuinely concurrent in-flight jobs at
  // once, self-throttling harder the heavier the real work turns out to be.
  const INIT_SUSPENDED_TAB_CONCURRENCY = 5;
  let   _initSuspendedTabActive = 0;
  const _initSuspendedTabQueue = []; // { tabId, run, resolve }
  // Six successive review rounds each found a *new* place a queued-or-running job could go
  // stale (re-entry, unsuspending, navigating to a "special" URL, the awaits inside
  // initialiseSuspendedTab() before enqueueing, the awaits inside its closure before
  // sending, and finally the recursive retry delays inside sendInitTabMessageWithRetry()
  // itself) — because every fix so far re-checked freshness at one specific checkpoint,
  // and the job kept running past it into its next await regardless. A checkpoint-based
  // check can never close this off completely: there's always one more await downstream.
  //
  // A cancellation token closes the whole class at once instead: every place that already
  // detects "this tab is no longer suspended" (re-entry, background.js's dispatch,
  // removeTabIdReferences()) flips one shared, mutable token for that tab's current job —
  // queued *or* already running — and every checkpoint along the job's entire lifetime,
  // including inside the retry loop, consults the same token rather than re-deriving
  // freshness locally. One cancellation source of truth per job, checked everywhere that
  // job does anything, instead of a growing pile of point checks that can only ever cover
  // the specific await gaps someone happened to find.
  const _initSuspendedTabTokenByTabId = new Map(); // tabId -> { cancelled: boolean }
  function _runInitSuspendedTabLimited(tabId, fn) {
    // A queued-but-not-yet-started (or still-running) entry for the same tabId means this
    // tab is being re-initialised before its previous entry finished — e.g. an in-place
    // navigation (unsuspend command, address-bar entry) that doesn't fire onRemoved/
    // onReplaced, so removeTabIdReferences() never gets a chance to cancel it. Drop it in
    // favour of this fresh call, which reflects the tab's current state.
    _cancelInitSuspendedTab(tabId);
    const token = { cancelled: false };
    _initSuspendedTabTokenByTabId.set(tabId, token);
    return new Promise((resolve, reject) => {
      const run = () => {
        _initSuspendedTabActive++;
        const release = () => {
          _initSuspendedTabActive--;
          // Only this job's own token, not a newer one a fresh call above already
          // replaced it with for the same tabId.
          if (_initSuspendedTabTokenByTabId.get(tabId) === token) {
            _initSuspendedTabTokenByTabId.delete(tabId);
          }
          const next = _initSuspendedTabQueue.shift();
          if (next) next.run();
        };
        if (token.cancelled) {
          release();
          resolve();
          return;
        }
        fn(token).then(resolve, reject).finally(release);
      };
      if (_initSuspendedTabActive < INIT_SUSPENDED_TAB_CONCURRENCY) run();
      else _initSuspendedTabQueue.push({ tabId, run, resolve });
    });
  }
  // Called on re-entry above, from removeTabIdReferences() (itself invoked from
  // chrome.tabs.onRemoved), and directly from background.js's chrome.tabs.onUpdated
  // dispatch whenever gsUtils.isSuspendedTab(tab) reads false — covering removal,
  // unsuspending, navigating away, and navigating to a "special" URL isNormalTab()
  // excludes alike. Cancels a queued entry outright (nothing to await, so its promise
  // just resolves), and flips the shared token for an already-running one so every
  // checkpoint it passes through from here on — including sendInitTabMessageWithRetry()'s
  // own retry loop — sees the cancellation regardless of which specific await it's
  // currently sitting in.
  function _cancelInitSuspendedTab(tabId) {
    let hadQueuedEntry = false;
    for (let i = _initSuspendedTabQueue.length - 1; i >= 0; i--) {
      if (_initSuspendedTabQueue[i].tabId === tabId) {
        const [entry] = _initSuspendedTabQueue.splice(i, 1);
        entry.resolve(); // never started — nothing to await, resolve so the caller doesn't hang
        hadQueuedEntry = true;
      }
    }
    const token = _initSuspendedTabTokenByTabId.get(tabId);
    if (token) {
      token.cancelled = true;
      // A still-queued (never run()) job's token is never reached by release() inside
      // _runInitSuspendedTabLimited() — that only runs for a job that actually started —
      // so it would otherwise sit in this map for the rest of the service worker's
      // lifetime, one entry per cancelled-while-queued tab across repeated restore/
      // navigation bursts. _runInitSuspendedTabLimited() always calls this function
      // before creating a new token for the same tabId, so a queued entry and an active
      // job's token are never both current for the same tabId at once — finding a queued
      // entry here means this token belongs to that not-yet-started job specifically,
      // safe to delete immediately. An active job's token must stay, though: its own
      // release() still needs to find it there to confirm it's deleting its own, not a
      // newer one.
      if (hadQueuedEntry) _initSuspendedTabTokenByTabId.delete(tabId);
    }
  }

  async function initialiseSuspendedTab(tab) {
    gsUtils.log( tab.id, 'tgs', 'initialiseSuspendedTab' );
    const unloadedUrl = await getTabStatePropForTabId(tab.id, STATE_UNLOADED_URL);
    const disableUnsuspendOnReload = await getTabStatePropForTabId( tab.id, STATE_DISABLE_UNSUSPEND_ON_RELOAD );
    await deleteTabStateForTabId(tab.id);

    if (await isCurrentFocusedTab(tab)) {
      setIconStatus(gsUtils.STATUS_SUSPENDED, tab.id);
    }

    //if a suspended tab is marked for unsuspendOnReload then unsuspend tab and return early
    const suspendedTabRefreshed = unloadedUrl === tab.url;
    if (suspendedTabRefreshed && !disableUnsuspendOnReload) {
      // Deliberately not throttled: this is an explicit user action (reload to unsuspend),
      // which should feel instant regardless of how many other tabs are mid-burst.
      await unsuspendTab(tab);
      return;
    }

    await _runInitSuspendedTabLimited(tab.id, async (token) => {
      // const tabView = getInternalViewByTabId(tab.id);
      const [discardAfterSuspend, sessionId] = await Promise.all([
        gsStorage.getOption(gsStorage.DISCARD_AFTER_SUSPEND),
        gsSession.getSessionId(),
      ]);
      // token.cancelled is flipped by _cancelInitSuspendedTab() the instant this tab is
      // detected as no longer suspended, from wherever that happens to be caught — no
      // longer just at this one checkpoint, since sendInitTabMessageWithRetry() below
      // keeps checking the same token through its own retry loop.
      if (token.cancelled) return;
      // Using a freshly-fetched tab here, not the one this closure captured, also avoids
      // sending a newly-navigated suspended page the previous URL's stale title/favicon.
      const freshTab = await chrome.tabs.get(tab.id).catch(() => null);
      // A tab Chrome discards while still on its suspended URL stays isSuspendedTab() ===
      // true (the URL never changes), so background.js keeps routing its onUpdated events
      // through the suspended branch — cancelInitSuspendedTab() (only called from the
      // non-suspended branch, re-entry, and removeTabIdReferences()) never sees it. Left
      // unchecked here, this would still send 'initTab' to a page with no live receiver
      // for the full retry budget. Bailing out here is enough on its own: discarding a
      // suspended tab doesn't unload its placeholder content permanently — the tab gets
      // its own fresh 'loading'/'complete' cycle (and therefore its own fresh call to this
      // function) whenever it's next reloaded, so nothing needs to be rescheduled from here.
      if (!freshTab || !gsUtils.isSuspendedTab(freshTab) || freshTab.url !== tab.url || freshTab.discarded) return;
      const quickInit = discardAfterSuspend && !freshTab.active;
      const payload = { action: 'initTab', tab: freshTab, quickInit, sessionId };
      await sendInitTabMessageWithRetry(freshTab.id, payload, token)
        .catch((error) => {
          gsUtils.warning(freshTab.id, 'tgs', 'initialiseSuspendedTab', error);
        });
      gsTabCheckManager.queueTabCheck(freshTab, { refetchTab: true }, 3000);
    });
  }

  // This message reaches suspended.html's own page script (not a content script), sent
  // right after the tab's status turns 'complete' — but that page's module script (and
  // therefore its chrome.runtime.onMessage listener) can still be a beat behind that
  // status flip, especially with many suspended tabs loading in the same burst (e.g.
  // browser startup or crash recovery with hundreds of tabs). A single failed send here
  // previously left the page's initTab() never called at all — no title, no favicon,
  // page never shown — until gsTabCheckManager's own recovery pass got to it, which
  // could take well over 10s under load or get lost entirely if a queued check's
  // setTimeout didn't survive a service worker recycle in between.
  //
  // The happy path (the overwhelming majority of tabs) resolves on the very first
  // attempt with zero added delay — retries only fire once a send has actually failed,
  // and every retry is a background message the user never perceives, not something
  // that blocks the page (already visible, just waiting to populate) or other tabs.
  // Under real stress-testing (hundreds of tabs, crash recovery) the previous fixed
  // 3×150ms=450ms budget still wasn't enough for some tabs; exponential backoff spends
  // more of that extra budget on the *later*, rarer retries instead of racing them all
  // at the same short interval, without slowing down anything that only needed 1-2 tries.
  const INIT_TAB_RETRY_DELAYS_MS = [100, 200, 400, 800, 1500, 3000]; // ~6s total budget

  // token (optional, see _runInitSuspendedTabLimited() above) is re-checked before every
  // attempt, including the very first: a tab navigating away during one of this function's
  // own retry delays previously had nothing able to stop the recursion short of the full
  // ~6s budget, since cancellation only ever reached the queue or the job's setup, never
  // this loop itself.
  function sendInitTabMessageWithRetry(tabId, payload, token, attempt = 0) {
    if (token?.cancelled) return Promise.resolve();
    return chrome.tabs.sendMessage(tabId, payload).catch((error) => {
      if (attempt >= INIT_TAB_RETRY_DELAYS_MS.length || token?.cancelled) throw error;
      const delayMs = INIT_TAB_RETRY_DELAYS_MS[attempt];
      return new Promise((resolve) => setTimeout(resolve, delayMs))
        .then(() => sendInitTabMessageWithRetry(tabId, payload, token, attempt + 1));
    });
  }

  async function removeTabIdReferences(tabId) {
    gsUtils.log(tabId, 'removing tabId references to', tabId);

    _cancelInitSuspendedTab(tabId);

    const focusedTabByWindow = await getCurrentFocusedTabIdByWindowId();
    for (const windowId of Object.keys(focusedTabByWindow)) {
      if (focusedTabByWindow[windowId] === tabId) {
        focusedTabByWindow[windowId] = null;
      }
    }
    await gsStorage.saveStorage('session', 'gsCurrentFocusedTabIdByWindowId', focusedTabByWindow);

    const statTabByWindow = await getCurrentStationaryTabIdByWindowId();
    for (const windowId of Object.keys(statTabByWindow)) {
      if (statTabByWindow[windowId] === tabId) {
        statTabByWindow[windowId] = null;
      }
    }
    await gsStorage.saveStorage('session', 'gsCurrentStationaryTabIdByWindowId', statTabByWindow);

    await deleteTabStateForTabId(tabId);
  }

  async function getSuspensionToggleHotkey() {
    let toggle = await gsStorage.getStorageJSON('session', 'gsSuspensionToggleHotkey');
    if (toggle === null) {
      toggle = await buildSuspensionToggleHotkey();
      await gsStorage.saveStorage('session', 'gsSuspensionToggleHotkey', toggle);
    }
    return toggle;
  }

  async function handleWindowFocusChanged(windowId) {
    gsUtils.log(windowId, 'tgs', 'handleWindowFocusChanged');
    if (windowId < 0 || windowId === await gsStorage.getStorageJSON('session', 'gsCurrentFocusedWindowId')) {
      return;
    }
    await setCurrentFocusedWindowId(windowId);

    // Get the active tab in the newly focused window
    chrome.tabs.query({ active: true }, (tabs) => {
      if (!tabs || !tabs.length) {
        return;
      }
      var focusedTab;
      for (var tab of tabs) {
        if (tab.windowId === windowId) {
          focusedTab = tab;
        }
      }
      if (!focusedTab) {
        gsUtils.warning( 'tgs', 'handleWindowFocusChanged', `Could not find active tab with windowId: ${windowId}. Window may have been closed.` );
        return;
      }

      //update icon
      calculateTabStatus(focusedTab, null, (status) => {
        setIconStatus(status, focusedTab.id);
      });

      //pause for a bit before assuming we're on a new window as some users
      //will key through intermediate windows to get to the one they want.
      queueNewWindowFocusTimer(focusedTab.id, windowId, focusedTab);
    });
  }

  async function handleTabFocusChanged(tabId, windowId) {
    gsUtils.log(tabId, 'tgs', 'handleTabFocusChanged');

    const focusedTab = await gsChrome.tabsGet(tabId);
    if (!focusedTab) {
      // If focusedTab is null then assume tab has been discarded between the
      // time the chrome.tabs.onActivated event was activated and now.
      // If so, then a subsequent chrome.tabs.onActivated event will be called
      // with the new discarded id
      gsUtils.log( tabId, 'tgs', 'Could not find newly focused tab. Assuming it has been discarded' );
      return;
    }

    const tabByWindow = await getCurrentFocusedTabIdByWindowId();
    const previouslyFocusedTabId = tabByWindow[windowId];
    tabByWindow[windowId] = tabId;
    await gsStorage.saveStorage('session', 'gsCurrentFocusedTabIdByWindowId', tabByWindow);

    // If the tab focused before this was the keyboard shortcuts page, then update hotkeys on suspended pages
    if (await gsStorage.getStorageJSON('session', 'gsTriggerHotkeyUpdate')) {
      const oldHotkey = await gsStorage.getStorageJSON('session', 'gsSuspensionToggleHotkey');
      const newHotkey = await buildSuspensionToggleHotkey();
      if (oldHotkey !== newHotkey) {
        await gsStorage.saveStorage('session', 'gsSuspensionToggleHotkey', newHotkey);
        const contexts = await gsChrome.contextsGetByViewName('suspended');
        for (const context of contexts) {
          if (context.tabId) {
            await chrome.tabs.sendMessage(context.tabId, { action: 'updateCommand', tabId: context.tabId })
              .catch((error) => {
                gsUtils.warning(context.tabId, 'tgs', 'handleTabFocusChanged', 'Failed to send updateCommand to content script', error);
              });
          }
        }
      }
      await gsStorage.saveStorage('session', 'gsTriggerHotkeyUpdate', false);
    }

    gsTabDiscardManager.unqueueTabForDiscard(focusedTab);

    // If normal tab, then ensure it has a responsive content script
    let contentScriptStatus = null;
    if (gsUtils.isNormalTab(focusedTab, true)) {
      contentScriptStatus = await getContentScriptStatus(focusedTab.id);
      if (!contentScriptStatus) {
        contentScriptStatus = await gsTabCheckManager.queueTabCheckAsPromise( focusedTab, {}, 0 );
      }
      gsUtils.log( focusedTab.id, 'tgs', 'getContentScriptStatus', contentScriptStatus );
    }

    //update icon
    const status = await new Promise(async (resolve) => {
      await calculateTabStatus(focusedTab, contentScriptStatus, resolve);
    });

    //if this tab still has focus then update icon
    if ((await getCurrentFocusedTabIdByWindowId())[windowId] === focusedTab.id) {
      setIconStatus(status, focusedTab.id);
    }

    //pause for a bit before assuming we're on a new tab as some users
    //will key through intermediate tabs to get to the one they want.
    queueNewTabFocusTimer(tabId, windowId, focusedTab);

    if (gsUtils.isBrowserInternalURL(focusedTab.url, '://extensions/shortcuts')) {
      await gsStorage.saveStorage('session', 'gsTriggerHotkeyUpdate', true);
    }

    const discardAfterSuspend = await gsStorage.getOption(gsStorage.DISCARD_AFTER_SUSPEND);
    if (!discardAfterSuspend) {
      return;
    }

    //queue job to discard previously focused tab
    const previouslyFocusedTab = previouslyFocusedTabId
      ? await gsChrome.tabsGet(previouslyFocusedTabId)
      : null;
    if (!previouslyFocusedTab) {
      gsUtils.log( previouslyFocusedTabId, 'tgs', 'Could not find tab. Has probably already been discarded' );
      return;
    }
    if (!gsUtils.isSuspendedTab(previouslyFocusedTab)) {
      return;
    }

    //queue tabCheck for previouslyFocusedTab. that will force a discard afterwards
    //but also avoids conflicts if this tab is already scheduled for checking
    gsUtils.log( previouslyFocusedTabId, 'tgs', 'Queueing previously focused tab for discard via tabCheckManager' );
    gsTabCheckManager.queueTabCheck(previouslyFocusedTab, {}, 1000);
  }

  function queueNewWindowFocusTimer(tabId, windowId, focusedTab) {
    clearTimeout(_newWindowFocusTimer);
    _newWindowFocusTimer = setTimeout(async () => {
      const previousStationaryWindowId = await gsStorage.getStorageJSON('session', 'gsCurrentStationaryWindowId');
      await setCurrentStationaryWindowId(windowId);
      var previousStationaryTabId = (await getCurrentStationaryTabIdByWindowId())[previousStationaryWindowId];
      await handleNewStationaryTabFocus(tabId, previousStationaryTabId, focusedTab);
    }, focusDelay);
  }

  function queueNewTabFocusTimer(tabId, windowId, focusedTab) {
    clearTimeout(_newTabFocusTimer);
    _newTabFocusTimer = setTimeout(async () => {
      const statTabByWindow = await getCurrentStationaryTabIdByWindowId();
      const previousStationaryTabId = statTabByWindow[windowId];
      statTabByWindow[windowId] = focusedTab.id;
      await gsStorage.saveStorage('session', 'gsCurrentStationaryTabIdByWindowId', statTabByWindow);
      await handleNewStationaryTabFocus(tabId, previousStationaryTabId, focusedTab);
    }, focusDelay);   // @WARN: This line is reporting a comms error, from sendMessage below
  }

  async function handleNewStationaryTabFocus( focusedTabId, previousStationaryTabId, focusedTab, ) {
    gsUtils.log(focusedTabId, 'tgs', 'handleNewStationaryTabFocus');

    if (gsUtils.isSuspendedTab(focusedTab)) {
      await handleSuspendedTabFocusGained(focusedTab);
    }
    else if (gsUtils.isNormalTab(focusedTab)) {
      const queuedTabDetails = gsTabSuspendManager.getQueuedTabDetails( focusedTab, );
      //if focusedTab is already in the queue for suspension then remove it.
      if (queuedTabDetails) {
        //although sometimes it seems that this is a 'fake' tab focus resulting
        //from the popup menu disappearing. in these cases the previousStationaryTabId
        //should match the current tabId (fix for issue #735)
        const isRealTabFocus =
          previousStationaryTabId && previousStationaryTabId !== focusedTabId;

        //also, only cancel suspension if the tab suspension request has a forceLevel > 1
        const isLowForceLevel = queuedTabDetails.executionProps.forceLevel > 1;

        if (isRealTabFocus && isLowForceLevel) {
          gsTabSuspendManager.unqueueTabForSuspension(focusedTab);
        }
      }
    }
    else if (focusedTab.url === chrome.runtime.getURL('options.html')) {
      if (await gsChrome.contextGetByTabId(focusedTab.id)) {
        await chrome.tabs.sendMessage(focusedTab.id, { action: 'initSettings', tab: focusedTab })
          .catch((error) => {
            gsUtils.warning(focusedTab.id, 'tgs', 'handleNewStationaryTabFocus', 'Failed to send initSettings to content script', error);
          });
      }
    }

    //Reset timer on tab that lost focus.
    //NOTE: This may be due to a change in window focus in which case the tab may still have .active = true
    if (previousStationaryTabId && previousStationaryTabId !== focusedTabId) {
      chrome.tabs.get(previousStationaryTabId, async (previousStationaryTab) => {
        if (chrome.runtime.lastError) {
          //Tab has probably been removed
          return;
        }
        if (
          previousStationaryTab &&
          gsUtils.isNormalTab(previousStationaryTab) &&
          !(await gsUtils.isProtectedActiveTab(previousStationaryTab))
        ) {
          await resetAutoSuspendTimerForTab(previousStationaryTab);
        }
      });
    }
  }

  async function handleSuspendedTabFocusGained(focusedTab) {
    if (focusedTab.status !== 'loading') {
      //safety check to ensure suspended tab has been initialised
      gsTabCheckManager.queueTabCheck(focusedTab, { refetchTab: false }, 0);
    }

    // check for auto-unsuspend
    var autoUnsuspend = await gsStorage.getOption(gsStorage.UNSUSPEND_ON_FOCUS);
    if (autoUnsuspend) {
      if (navigator.onLine) {
        await unsuspendTab(focusedTab);
      }
      else {
        if (await gsChrome.contextGetByTabId(focusedTab.id)) {
          await chrome.tabs.sendMessage(focusedTab.id, { action: 'showNoConnectivityMessage', tab: focusedTab })
            .catch((error) => {
              gsUtils.warning(focusedTab.id, 'tgs', 'handleSuspendedTabFocusGained', 'Failed to send showNoConnectivityMessage to content script', error);
            });
        }
      }
    }
  }

  function promptForFilePermissions() {
    getCurrentlyActiveTab((activeTab) => {
      chrome.tabs.create({
        url: chrome.runtime.getURL('permissions.html'),
        index: activeTab.index + 1,
      });
    });
  }

  async function getCurrentStationaryTabIdByWindowId() {
    return (await gsStorage.getStorageJSON('session', 'gsCurrentStationaryTabIdByWindowId')) || {};
  }

  async function getCurrentFocusedTabIdByWindowId() {
    return (await gsStorage.getStorageJSON('session', 'gsCurrentFocusedTabIdByWindowId')) || {};
  }

  async function setCurrentStationaryWindowId(value) {
    return gsStorage.saveStorage('session', 'gsCurrentStationaryWindowId', value);
  }

  async function setCurrentFocusedWindowId(value) {
    return gsStorage.saveStorage('session', 'gsCurrentFocusedWindowId', value);
  }

  async function isCharging() {
    return gsStorage.getStorageJSON('session', 'gsIsCharging');
  }

  async function setCharging(value) {
    return gsStorage.saveStorage('session', 'gsIsCharging', value);
  }


  function getContentScriptStatus(tabId, knownContentScriptStatus) {
    return new Promise((resolve) => {
      if (knownContentScriptStatus) {
        resolve(knownContentScriptStatus);
      }
      else {
        gsMessages.sendRequestInfoToContentScript(tabId, (error, tabInfo) => {
          gsUtils.log(tabId, 'sendRequestInfoToContentScript', error, tabInfo);
          if (error) {
            gsUtils.warning(tabId, 'tgs', 'getContentScriptStatus', 'Failed', error);
          }
          if (tabInfo) {
            resolve(tabInfo.status);
          }
          else {
            resolve(null);
          }
        });
      }
    });
  }

  //possible suspension states are:
  //loading: tab object has a state of 'loading'
  //normal: a tab that will be suspended
  //blockedFile: a file:// tab that can theoretically be suspended but is being blocked by the user's settings
  //special: a tab that cannot be suspended
  //suspended: a tab that is suspended
  //discarded: a tab that has been discarded
  //never: suspension timer set to 'never suspend'
  //formInput: a tab that has a partially completed form (and IGNORE_FORMS is true)
  //audible: a tab that is playing audio (and IGNORE_AUDIO is true)
  //active: a tab that is active (and IGNORE_ACTIVE_TABS is true)
  //tempWhitelist: a tab that has been manually paused
  //pinned: a pinned tab (and IGNORE_PINNED is true)
  //whitelisted: a tab that has been whitelisted
  //charging: computer currently charging (and IGNORE_WHEN_CHARGING is true)
  //noConnectivity: internet currently offline (and IGNORE_WHEN_OFFLINE is true)
  //unknown: an error detecting tab status
  async function calculateTabStatus(tab, knownContentScriptStatus, callback) {
    //check for loading
    if (tab.status === 'loading') {
      callback(gsUtils.STATUS_LOADING);
      return;
    }
    //check if it is a blockedFile tab (this needs to have precedence over isSpecialTab)
    if (gsUtils.isBlockedFileTab(tab)) {
      callback(gsUtils.STATUS_BLOCKED_FILE);
      return;
    }
    //check if it is a special tab
    if (gsUtils.isSpecialTab(tab)) {
      callback(gsUtils.STATUS_SPECIAL);
      return;
    }
    //check if tab has been discarded
    if (gsUtils.isDiscardedTab(tab)) {
      callback(gsUtils.STATUS_DISCARDED);
      return;
    }
    //check if it has already been suspended
    if (gsUtils.isSuspendedTab(tab)) {
      callback(gsUtils.STATUS_SUSPENDED);
      return;
    }
    //check whitelist
    if (await gsUtils.checkWhiteList(tab.url)) {
      callback(gsUtils.STATUS_WHITELISTED);
      return;
    }
    //check never suspend
    //should come after whitelist check as it causes popup to show the whitelisting option
    let effectiveSuspendTime = await gsStorage.getOption(gsStorage.SUSPEND_TIME);
    if ((await isCharging()) === false) {
      const suspendTimeOnBattery = await gsStorage.getOption(gsStorage.SUSPEND_TIME_ON_BATTERY);
      if (suspendTimeOnBattery !== '') {
        effectiveSuspendTime = suspendTimeOnBattery;
      }
    }
    if (effectiveSuspendTime === '0') {
      callback(gsUtils.STATUS_NEVER);
      return;
    }

    getContentScriptStatus(tab.id, knownContentScriptStatus).then(
      async (contentScriptStatus) => {
        if ( contentScriptStatus && contentScriptStatus !== gsUtils.STATUS_NORMAL ) {
          callback(contentScriptStatus);
          return;
        }
        //check running on battery
        if ( await gsStorage.getOption(gsStorage.IGNORE_WHEN_CHARGING) && await isCharging() ) {
          callback(gsUtils.STATUS_CHARGING);
          return;
        }
        //check internet connectivity
        if ( await gsStorage.getOption(gsStorage.IGNORE_WHEN_OFFLINE) && !navigator.onLine ) {
          callback(gsUtils.STATUS_NOCONNECTIVITY);
          return;
        }
        //check pinned tab
        if (await gsUtils.isProtectedPinnedTab(tab)) {
          callback(gsUtils.STATUS_PINNED);
          return;
        }
        //check audible tab
        if (await gsUtils.isProtectedAudibleTab(tab)) {
          callback(gsUtils.STATUS_AUDIBLE);
          return;
        }
        //check active
        if (await gsUtils.isProtectedActiveTab(tab)) {
          callback(gsUtils.STATUS_ACTIVE);
          return;
        }
        if (contentScriptStatus) {
          callback(contentScriptStatus); // should be 'normal'
          return;
        }
        callback(gsUtils.STATUS_UNKNOWN);
      },
    );
  }

  function getActiveTabStatus(callback) {
    getCurrentlyActiveTab((tab) => {
      if (!tab) {
        callback(gsUtils.STATUS_UNKNOWN);
        return;
      }
      calculateTabStatus(tab, null, (status) => {
        callback(status);
      });
    });
  }

  //change the icon to either active or inactive
  async function setIconStatus(status, tabId) {
    // gsUtils.log(tabId, 'Setting icon status', status);
    var basePath = ![gsUtils.STATUS_NORMAL, gsUtils.STATUS_ACTIVE].includes(status)
      ? ICON_SUSPENSION_PAUSED
      : ICON_SUSPENSION_ACTIVE;
    var path = {};
    for (const [size, p] of Object.entries(basePath)) {
      path[size] = await gsMascot.resolvePath(p);
    }
    // gsUtils.log(tabId, 'Setting icon status', path);
    chrome.action.setIcon({ path, tabId }, () => {
      if (chrome.runtime.lastError) {
        gsUtils.warning(tabId, 'tgs', 'setIconStatus', chrome.runtime.lastError);
      }
    });
  }

  // Updates the extension-wide default icon (i.e. the icon shown for any tab that
  // doesn't have its own tab-specific icon set via setIconStatus above). This matters
  // for TMS's own pages (options, about, etc.): they're "special" tabs that never go
  // through setIconStatus, and Chrome resets a tab's icon override on navigation, so
  // without this the toolbar icon falls back to the manifest default (always the new
  // mascot) whenever you navigate between TMS pages while the legacy setting is on.
  async function refreshDefaultIcon() {
    const path = {};
    for (const [size, p] of Object.entries(ICON_SUSPENSION_ACTIVE)) {
      path[size] = await gsMascot.resolvePath(p);
    }
    chrome.action.setIcon({ path }, () => {
      if (chrome.runtime.lastError) {
        gsUtils.warning('tgs', 'refreshDefaultIcon', chrome.runtime.lastError);
      }
    });
  }

  function setIconStatusForActiveTab() {
    getCurrentlyActiveTab((tab) => {
      if (!tab) {
        return;
      }
      calculateTabStatus(tab, null, (status) => {
        setIconStatus(status, tab.id);
      });
    });
  }

  async function toggleSuspendStateOfTab(tab) {
    if (!tab) return;
    if (gsUtils.isSuspendedTab(tab)) {
      await unsuspendTab(tab);
    } else {
      gsTabSuspendManager.queueTabForSuspension(tab, 1);
    }
  }

  async function requestToggleTempWhitelistStateOfTab(tab) {
    if (!tab) return;
    if (gsUtils.isSuspendedTab(tab)) {
      await unsuspendTab(tab);
      return;
    }
    if (!gsUtils.isNormalTab(tab, true)) return;
    calculateTabStatus(tab, null, (status) => {
      if (status === gsUtils.STATUS_ACTIVE || status === gsUtils.STATUS_NORMAL) {
        setTempWhitelistStateForTab(tab, null);
      } else if (status === gsUtils.STATUS_TEMPWHITELIST || status === gsUtils.STATUS_FORMINPUT) {
        unsetTempWhitelistStateForTab(tab, null);
      }
    });
  }

  async function whitelistTab(tab, includePath) {
    if (!tab) return;
    if (gsUtils.isSuspendedTab(tab)) {
      const url = gsUtils.getRootUrl(gsUtils.getOriginalUrl(tab.url), includePath, false);
      await gsUtils.saveToWhitelist(url);
      await unsuspendTab(tab);
    } else if (gsUtils.isNormalTab(tab)) {
      const url = gsUtils.getRootUrl(tab.url, includePath, false);
      await gsUtils.saveToWhitelist(url);
      calculateTabStatus(tab, null, (status) => {
        setIconStatus(status, tab.id);
      });
    }
  }

  //HANDLERS FOR RIGHT-CLICK CONTEXT MENU
  function buildContextMenu(showContextMenu) {
    /** @type { chrome.contextMenus.CreateProperties['contexts'] } */
    const allContexts = ['page', 'frame', 'editable', 'image', 'video', 'audio']; //'selection',

    if (!showContextMenu) {
      chrome.contextMenus.removeAll();
    }
    else {
      chrome.contextMenus.create({
        id: 'open_link_in_suspended_tab',
        title: gsUtils.getMessage('js_context_open_link_in_suspended_tab'),
        contexts: ['link'],
        // onclick: (info, tab) => { openLinkInSuspendedTab(tab, info.linkUrl); },
      });

      chrome.contextMenus.create({
        id: 'toggle_suspend_state',
        title: gsUtils.getMessage('js_context_toggle_suspend_state'),
        contexts: allContexts,
        // onclick: () => toggleSuspendedStateOfHighlightedTab(),
      });
      chrome.contextMenus.create({
        id: 'toggle_pause_suspension',
        title: gsUtils.getMessage('js_context_toggle_pause_suspension'),
        contexts: allContexts,
        // onclick: () => requestToggleTempWhitelistStateOfHighlightedTab(),
      });
      chrome.contextMenus.create({
        id: 'never_suspend_page',
        title: gsUtils.getMessage('js_context_never_suspend_page'),
        contexts: allContexts,
        // onclick: () => whitelistHighlightedTab(true),
      });
      chrome.contextMenus.create({
        id: 'never_suspend_domain',
        title: gsUtils.getMessage('js_context_never_suspend_domain'),
        contexts: allContexts,
        // onclick: () => whitelistHighlightedTab(false),
      });

      chrome.contextMenus.create({
        id: 'separator1',
        type: 'separator',
        contexts: allContexts,
      });
      chrome.contextMenus.create({
        id: 'suspend_selected_tabs',
        title: gsUtils.getMessage('js_context_suspend_selected_tabs'),
        contexts: allContexts,
        // onclick: () => suspendSelectedTabs(),
      });
      chrome.contextMenus.create({
        id: 'unsuspend_selected_tabs',
        title: gsUtils.getMessage('js_context_unsuspend_selected_tabs'),
        contexts: allContexts,
        // onclick: () => unsuspendSelectedTabs(),
      });
      chrome.contextMenus.create({
        id: 'suspend_tab_group',
        title: gsUtils.getMessage('js_context_suspend_tab_group'),
        contexts: allContexts,
      });
      chrome.contextMenus.create({
        id: 'unsuspend_tab_group',
        title: gsUtils.getMessage('js_context_unsuspend_tab_group'),
        contexts: allContexts,
      });

      chrome.contextMenus.create({
        id: 'separator2',
        type: 'separator',
        contexts: allContexts,
      });
      chrome.contextMenus.create({
        id: 'soft_suspend_other_tabs_in_window',
        title: gsUtils.getMessage('js_context_soft_suspend_other_tabs_in_window'),
        contexts: allContexts,
        // onclick: () => suspendAllTabs(false),
      });
      chrome.contextMenus.create({
        id: 'force_suspend_other_tabs_in_window',
        title: gsUtils.getMessage('js_context_force_suspend_other_tabs_in_window'),
        contexts: allContexts,
        // onclick: () => suspendAllTabs(true),
      });
      chrome.contextMenus.create({
        id: 'unsuspend_all_tabs_in_window',
        title: gsUtils.getMessage('js_context_unsuspend_all_tabs_in_window'),
        contexts: allContexts,
        // onclick: () => unsuspendAllTabs(),
      });

      chrome.contextMenus.create({
        id: 'separator3',
        type: 'separator',
        contexts: allContexts,
      });
      chrome.contextMenus.create({
        id: 'soft_suspend_all_tabs',
        title: gsUtils.getMessage('js_context_soft_suspend_all_tabs'),
        contexts: allContexts,
        // onclick: () => suspendAllTabsInAllWindows(false),
      });
      chrome.contextMenus.create({
        id: 'force_suspend_all_tabs',
        title: gsUtils.getMessage('js_context_force_suspend_all_tabs'),
        contexts: allContexts,
        // onclick: () => suspendAllTabsInAllWindows(true),
      });
      chrome.contextMenus.create({
        id: 'unsuspend_all_tabs',
        title: gsUtils.getMessage('js_context_unsuspend_all_tabs'),
        contexts: allContexts,
        // onclick: () => unsuspendAllTabsInAllWindows(),
      });

      chrome.contextMenus.create({
        id: 'separator4',
        type: 'separator',
        contexts: allContexts,
      });
      chrome.contextMenus.create({
        id: 'open_session_history',
        title: gsUtils.getMessage('html_recovery_go_to_session_manager'),
        contexts: allContexts,
      });

      // Tab strip context menu items (right-click on tab in tab bar)
      chrome.contextMenus.create({
        id: 'tab_toggle_suspend',
        title: gsUtils.getMessage('js_context_toggle_suspend_state'),
        contexts: ['tab'],
      });
      chrome.contextMenus.create({
        id: 'tab_toggle_pause',
        title: gsUtils.getMessage('js_context_toggle_pause_suspension'),
        contexts: ['tab'],
      });
      chrome.contextMenus.create({
        id: 'tab_never_suspend_domain',
        title: gsUtils.getMessage('js_context_never_suspend_domain'),
        contexts: ['tab'],
      });
      chrome.contextMenus.create({
        id: 'tab_never_suspend_page',
        title: gsUtils.getMessage('js_context_never_suspend_page'),
        contexts: ['tab'],
      });
      chrome.contextMenus.create({
        id: 'tab_suspend_group',
        title: gsUtils.getMessage('js_context_suspend_tab_group'),
        contexts: ['tab'],
      });
      chrome.contextMenus.create({
        id: 'tab_unsuspend_group',
        title: gsUtils.getMessage('js_context_unsuspend_tab_group'),
        contexts: ['tab'],
      });
      chrome.contextMenus.create({
        id: 'tab_separator1',
        type: 'separator',
        contexts: ['tab'],
      });
      chrome.contextMenus.create({
        id: 'tab_soft_suspend_other_tabs',
        title: gsUtils.getMessage('js_context_soft_suspend_other_tabs_in_window'),
        contexts: ['tab'],
      });
      chrome.contextMenus.create({
        id: 'tab_unsuspend_all_in_window',
        title: gsUtils.getMessage('js_context_unsuspend_all_tabs_in_window'),
        contexts: ['tab'],
      });
      chrome.contextMenus.create({
        id: 'tab_separator2',
        type: 'separator',
        contexts: ['tab'],
      });
      chrome.contextMenus.create({
        id: 'tab_soft_suspend_all',
        title: gsUtils.getMessage('js_context_soft_suspend_all_tabs'),
        contexts: ['tab'],
      });
      chrome.contextMenus.create({
        id: 'tab_unsuspend_all',
        title: gsUtils.getMessage('js_context_unsuspend_all_tabs'),
        contexts: ['tab'],
      });
    }
  }







  return {
    STATE_UNLOADED_URL,
    STATE_INITIALISE_SUSPENDED_TAB,
    STATE_HISTORY_URL_TO_REMOVE,
    STATE_TEMP_WHITELIST_ON_RELOAD,
    STATE_DISABLE_UNSUSPEND_ON_RELOAD,
    STATE_SET_AUTODISCARDABLE,
    STATE_SUSPEND_REASON,
    STATE_SCROLL_POS,
    getTabStatePropForTabId,
    setTabStatePropForTabId,

    initialiseTabContentScript,
    buildContextMenu,
    getActiveTabStatus,
    calculateTabStatus,

    setIconStatus,
    refreshDefaultIcon,
    getCurrentlyActiveTab,
    openLinkInSuspendedTab,
    toggleSuspendedStateOfHighlightedTab,
    suspendAllTabsInAllWindows,
    handleWindowFocusChanged,
    handleTabFocusChanged,
    queueSessionTimer,
    removeTabIdReferences,
    checkForTriggerUrls,
    handleSuspendedTabStateChanged,
    handleUnsuspendedTabStateChanged,
    cancelInitSuspendedTab: _cancelInitSuspendedTab,
    setIconStatusForActiveTab,
    getCurrentStationaryTabIdByWindowId,
    getCurrentFocusedTabIdByWindowId,
    setCurrentStationaryWindowId,
    setCurrentFocusedWindowId,
    isCharging,
    setCharging,

    isCurrentStationaryTab,
    isCurrentFocusedTab,
    isCurrentActiveTab,
    clearAutoSuspendTimerForTabId,
    resetAutoSuspendTimerForTab,
    resetAutoSuspendTimerForAllTabs,
    getSuspensionToggleHotkey,

    unsuspendTab,
    unsuspendHighlightedTab,
    unwhitelistHighlightedTab,
    requestToggleTempWhitelistStateOfHighlightedTab,
    suspendHighlightedTab,
    suspendAllTabs,
    unsuspendAllTabs,
    suspendSelectedTabs,
    unsuspendSelectedTabs,
    suspendTabGroup,
    unsuspendTabGroup,
    whitelistHighlightedTab,
    unsuspendAllTabsInAllWindows,
    unsuspendWhitelistedTabs,
    forceSuspendAlwaysListedTabs,
    promptForFilePermissions,

    toggleSuspendStateOfTab,
    requestToggleTempWhitelistStateOfTab,
    whitelistTab,
  };

})();
