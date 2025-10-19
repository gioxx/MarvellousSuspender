import  { gsChrome }              from './gsChrome.js';
import  { gsMessages }            from './gsMessages.js';
import  { gsSession }             from './gsSession.js';
import  { gsStorage }             from './gsStorage.js';
import  { gsTabSuspendManager }   from './gsTabSuspendManager.js';
import  { gsTabCheckManager }     from './gsTabCheckManager.js';
import  { gsTabDiscardManager }   from './gsTabDiscardManager.js';
import  { gsUtils }               from './gsUtils.js';

export const tgs = (function() {
  'use strict';

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


  async function getInternalContextByTabId(tabId) {
    const contexts = await chrome.runtime.getContexts({ tabIds: [tabId] });
    return contexts.length === 1 ? contexts[0] : null;
  }

  async function getInternalContextsByViewName(viewName, callback) {
    const contexts = await chrome.runtime.getContexts({});
    return contexts.filter((context) => context.documentUrl?.includes(viewName));
  }


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
    } else {
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
    } else {
      // fallback on active flag
      return tab.active;
    }
  }

  async function isCurrentActiveTab(tab) {
    const activeTabIdForWindow = (await getCurrentFocusedTabIdByWindowId())[tab.windowId];
    if (activeTabIdForWindow) {
      return tab.id === activeTabIdForWindow;
    } else {
      // fallback on active flag
      return tab.active;
    }
  }

  function whitelistHighlightedTab(includePath) {
    includePath = includePath || false;
    getCurrentlyActiveTab(async (activeTab) => {
      if (activeTab) {
        if (gsUtils.isSuspendedTab(activeTab)) {
          let url = gsUtils.getRootUrl(
            gsUtils.getOriginalUrl(activeTab.url),
            includePath,
            false,
          );
          await gsUtils.saveToWhitelist(url);
          await unsuspendTab(activeTab);
        }
        else if (gsUtils.isNormalTab(activeTab)) {
          let url = gsUtils.getRootUrl(activeTab.url, includePath, false);
          await gsUtils.saveToWhitelist(url);
          calculateTabStatus(activeTab, null, function(status) {
            setIconStatus(status, activeTab.id);
          });
        }
      }
    });
  }

  function unwhitelistHighlightedTab(callback) {
    getCurrentlyActiveTab(function(activeTab) {
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

      calculateTabStatus(activeTab, null, function(status) {
        if (
          status === gsUtils.STATUS_ACTIVE ||
          status === gsUtils.STATUS_NORMAL
        ) {
          setTempWhitelistStateForTab(activeTab, callback);
        } else if (
          status === gsUtils.STATUS_TEMPWHITELIST ||
          status === gsUtils.STATUS_FORMINPUT
        ) {
          unsetTempWhitelistStateForTab(activeTab, callback);
        } else {
          if (callback) callback(status);
        }
      });
    });
  }

  function setTempWhitelistStateForTab(tab, callback) {
    gsMessages.sendTemporaryWhitelistToContentScript(tab.id, function(
      error,
      response,
    ) {
      if (error) {
        gsUtils.warning( tab.id, 'Failed to sendTemporaryWhitelistToContentScript', error );
      }
      var contentScriptStatus =
        response && response.status ? response.status : null;
      calculateTabStatus(tab, contentScriptStatus, function(newStatus) {
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
    gsMessages.sendUndoTemporaryWhitelistToContentScript(tab.id, function(
      error,
      response,
    ) {
      if (error) {
        gsUtils.warning( tab.id, 'Failed to sendUndoTemporaryWhitelistToContentScript', error );
      }
      var contentScriptStatus =
        response && response.status ? response.status : null;
      calculateTabStatus(tab, contentScriptStatus, function(newStatus) {
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
    chrome.tabs.query({ windowId: chrome.windows.WINDOW_ID_CURRENT }, tabs => {
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
      chrome.tabs.create(newTabProperties, tab => {
        gsTabSuspendManager.queueTabForSuspension(tab, 1);
      });
    });
  }

  function toggleSuspendedStateOfHighlightedTab() {
    getCurrentlyActiveTab(async (activeTab) => {
      if (activeTab) {
        if (gsUtils.isSuspendedTab(activeTab)) {
          await unsuspendTab(activeTab);
        } else {
          gsTabSuspendManager.queueTabForSuspension(activeTab, 1);
        }
      }
    });
  }

  function suspendHighlightedTab() {
    getCurrentlyActiveTab(activeTab => {
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
    getCurrentlyActiveTab(activeTab => {
      if (!activeTab) {
        gsUtils.warning( 'background', 'Could not determine currently active window.' );
        return;
      }
      chrome.windows.get(activeTab.windowId, { populate: true }, curWindow => {
        for (const tab of curWindow.tabs) {
          if (!tab.active) {
            gsTabSuspendManager.queueTabForSuspension(tab, forceLevel);
          }
        }
      });
    });
  }

  function suspendAllTabsInAllWindows(force) {
    const forceLevel = force ? 1 : 2;
    chrome.tabs.query({}, tabs => {
      for (const tab of tabs) {
        gsTabSuspendManager.queueTabForSuspension(tab, forceLevel);
      }
    });
  }

  function unsuspendAllTabs() {
    getCurrentlyActiveTab(function(activeTab) {
      if (!activeTab) {
        gsUtils.warning( 'background', 'Could not determine currently active window.' );
        return;
      }
      chrome.windows.get(activeTab.windowId, { populate: true }, async (curWindow) => {
        for (const tab of curWindow.tabs) {
          gsTabSuspendManager.unqueueTabForSuspension(tab);
          if (gsUtils.isSuspendedTab(tab)) {
            await unsuspendTab(tab);
          } else if (gsUtils.isNormalTab(tab) && !tab.active) {
            await resetAutoSuspendTimerForTab(tab);
          }
        }
      });
    });
  }

  function unsuspendAllTabsInAllWindows() {
    chrome.windows.getLastFocused({}, currentWindow => {
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

  function suspendSelectedTabs() {
    chrome.tabs.query(
      { highlighted: true, lastFocusedWindow: true },
      selectedTabs => {
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
      },
    );
  }

  function queueSessionTimer() {
    clearTimeout(_sessionSaveTimer);
    _sessionSaveTimer = setTimeout(function() {
      gsSession.updateCurrentSession(); //async
    }, 1000);
  }

  async function resetAutoSuspendTimerForTab(tab) {
    await clearAutoSuspendTimerForTabId(tab.id);

    const suspendTime = await gsStorage.getOption(gsStorage.SUSPEND_TIME);
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
        gsUtils.warning(tab.id, 'chrome alarm create failed', error);
      });

    gsUtils.log( tab.id, 'tgs', 'resetAutoSuspendTimerForTab', timeToSuspend, new Date(when) );
  }

  function resetAutoSuspendTimerForAllTabs() {
    gsUtils.log(0, 'tgs', 'resetAutoSuspendTimerForAllTabs');
    chrome.alarms.clearAll(() => {});
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

    const scrollPosition = gsUtils.getSuspendedScrollPosition(tab.url);
    await tgs.setTabStatePropForTabId(tab.id, tgs.STATE_SCROLL_POS, scrollPosition);

    let originalUrl = gsUtils.getOriginalUrl(tab.url);
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
      chrome.tabs.update(tab.id, { url: originalUrl, autoDiscardable: false });
      return;
    }

    gsUtils.log(tab.id, 'Failed to execute unsuspend tab.');
  }

  function buildSuspensionToggleHotkey() {
    return new Promise(resolve => {
      let printableHotkey = '';
      chrome.commands.getAll(commands => {
        const toggleCommand = commands.find(o => o.name === '1-suspend-tab');
        if (toggleCommand && toggleCommand.shortcut !== '') {
          printableHotkey = gsUtils.formatHotkeyString(toggleCommand.shortcut);
          resolve(printableHotkey);
        } else {
          resolve(null);
        }
      });
    });
  }

  function checkForTriggerUrls(tab, url) {
    // test for a save of keyboard shortcuts (chrome://extensions/shortcuts)
    if (url === 'chrome://extensions/shortcuts') {
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
      gsTabDiscardManager.handleDiscardedUnsuspendedTab(tab); //async. unhandled promise.

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
          removeTabHistoryForUnuspendedTab(historyUrlToRemove);
        }
        if (setAutodiscardable) {
          gsChrome.tabsUpdate(tab.id, { autoDiscardable: true });
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
          .catch(error => {
            gsUtils.warning( tab.id, 'Failed to send init to content script. Tab may not behave as expected.', error );
          });
          // .then(() => {
          //   // could use returned tab status here below
          // });
      }

      hasTabStatusChanged = true;
    }

    //if tab is currently visible then update popup icon
    if (hasTabStatusChanged && await isCurrentFocusedTab(tab)) {
      calculateTabStatus(tab, null, function(status) {
        setIconStatus(status, tab.id);
      });
    }
  }

  function removeTabHistoryForUnuspendedTab(suspendedUrl) {
    chrome.history.deleteUrl({ url: suspendedUrl });
    const originalUrl = gsUtils.getOriginalUrl(suspendedUrl);
    chrome.history.getVisits({ url: originalUrl }, visits => {
      //assume history entry will be the second to latest one (latest one is the currently visible page)
      //NOTE: this will break if the same url has been visited by another tab more recently than the
      //suspended tab (pre suspension)
      // const latestVisit = visits.pop();
      const previousVisit = visits.pop();
      if (previousVisit) {
        chrome.history.deleteRange(
          {
            startTime: previousVisit.visitTime - 0.1,
            endTime: previousVisit.visitTime + 0.1,
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
      await unsuspendTab(tab);
      return;
    }

    // const tabView = getInternalViewByTabId(tab.id);
    const discardAfterSuspend = await gsStorage.getOption(gsStorage.DISCARD_AFTER_SUSPEND);
    const quickInit = discardAfterSuspend && !tab.active;
    chrome.tabs.sendMessage(tab.id, { action: 'initTab', tab, quickInit, sessionId: await gsSession.getSessionId() })
      .catch(error => {
        gsUtils.warning(tab.id, error);
      })
      .then(() => {
        gsTabCheckManager.queueTabCheck(tab, { refetchTab: true }, 3000);
      });
  }

  async function removeTabIdReferences(tabId) {
    gsUtils.log(tabId, 'removing tabId references to', tabId);

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

    deleteTabStateForTabId(tabId);
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
    chrome.tabs.query({ active: true }, function(tabs) {
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
        gsUtils.warning( 'background', `Couldnt find active tab with windowId: ${windowId}. Window may have been closed.` );
        return;
      }

      //update icon
      calculateTabStatus(focusedTab, null, function(status) {
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
        const contexts = await getInternalContextsByViewName('suspended');
        for (const context of contexts) {
          chrome.tabs.sendMessage(context.tabId, { action: 'updateCommand', tabId: context.tabId });
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
    const status = await new Promise(resolve => {
      calculateTabStatus(focusedTab, contentScriptStatus, resolve);
    });
    // gsUtils.log(focusedTab.id, 'tgs', 'calculateTabStatus', status);

    //if this tab still has focus then update icon
    if ((await getCurrentFocusedTabIdByWindowId())[windowId] === focusedTab.id) {
      setIconStatus(status, focusedTab.id);
    }

    //pause for a bit before assuming we're on a new tab as some users
    //will key through intermediate tabs to get to the one they want.
    queueNewTabFocusTimer(tabId, windowId, focusedTab);

    //test for a save of keyboard shortcuts (chrome://extensions/shortcuts)
    if (focusedTab.url === 'chrome://extensions/shortcuts') {
      await gsStorage.saveStorage('session', 'gsTriggerHotkeyUpdate', true);
    }

    let discardAfterSuspend = await gsStorage.getOption(gsStorage.DISCARD_AFTER_SUSPEND);
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
      handleNewStationaryTabFocus(tabId, previousStationaryTabId, focusedTab);
    }, focusDelay);
  }

  function queueNewTabFocusTimer(tabId, windowId, focusedTab) {
    clearTimeout(_newTabFocusTimer);
    _newTabFocusTimer = setTimeout(async () => {
      const statTabByWindow = await getCurrentStationaryTabIdByWindowId();
      const previousStationaryTabId = statTabByWindow[windowId];
      statTabByWindow[windowId] = focusedTab.id;
      await gsStorage.saveStorage('session', 'gsCurrentStationaryTabIdByWindowId', statTabByWindow);
      handleNewStationaryTabFocus(tabId, previousStationaryTabId, focusedTab);
    }, focusDelay);
  }

  function handleNewStationaryTabFocus( focusedTabId, previousStationaryTabId, focusedTab, ) {
    gsUtils.log(focusedTabId, 'tgs', 'handleNewStationaryTabFocus');

    if (gsUtils.isSuspendedTab(focusedTab)) {
      handleSuspendedTabFocusGained(focusedTab); //async. unhandled promise.
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
      getInternalContextByTabId(focusedTab.id, (context) => {
        chrome.tabs.sendMessage(context.tabId, { action: 'initSettings', tab: focusedTab });
      });
      // @TODO: This must be a listener in the options page
      // const optionsView = getInternalViewByTabId(focusedTab.id);
      // if (optionsView && optionsView.exports) {
      //   optionsView.exports.initSettings();
      // }
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

    //check for auto-unsuspend
    var autoUnsuspend = await gsStorage.getOption(gsStorage.UNSUSPEND_ON_FOCUS);
    if (autoUnsuspend) {
      if (navigator.onLine) {
        await unsuspendTab(focusedTab);
      }
      else {
        getInternalContextByTabId(focusedTab.id, (context) => {
          chrome.tabs.sendMessage(context.tabId, { action: 'showNoConnectivityMessage', tab: focusedTab });
        });
      }
    }
  }

  function promptForFilePermissions() {
    getCurrentlyActiveTab(activeTab => {
      chrome.tabs.create({
        url: chrome.runtime.getURL('permissions.html'),
        index: activeTab.index + 1,
      });
    });
  }

  async function requestNotice() {
    return gsStorage.getStorageJSON('session', 'gsNoticeToDisplay');
  }

  async function clearNotice() {
    return gsStorage.deleteStorage('session', 'gsNoticeToDisplay');
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
      gsMessages.sendRequestInfoToContentScript(tab.id, ( error, tabInfo ) => {
        // if (error) {
        //   gsUtils.warning(tab.id, 'Failed to getDebugInfo', error);
        // }
        if (tabInfo) {
          calculateTabStatus(tab, tabInfo.status, (status) => {
            info.status = status;
            callback(info);
          });
        }
        else {
          callback(info);
        }
      });
    }
    else {
      calculateTabStatus(tab, null, (status) => {
        info.status = status;
        callback(info);
      });
    }
  }

  function getContentScriptStatus(tabId, knownContentScriptStatus) {
    return new Promise(function(resolve) {
      if (knownContentScriptStatus) {
        resolve(knownContentScriptStatus);
      } else {
        gsMessages.sendRequestInfoToContentScript(tabId, function(error, tabInfo) {
          gsUtils.log(tabId, 'sendRequestInfoToContentScript', error, tabInfo);
          if (error) {
            gsUtils.warning(tabId, 'Failed to getContentScriptStatus', error);
          }
          if (tabInfo) {
            resolve(tabInfo.status);
          } else {
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
    if (await gsStorage.getOption(gsStorage.SUSPEND_TIME) === '0') {
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
    getCurrentlyActiveTab(function(tab) {
      if (!tab) {
        callback(gsUtils.STATUS_UNKNOWN);
        return;
      }
      calculateTabStatus(tab, null, function(status) {
        callback(status);
      });
    });
  }

  //change the icon to either active or inactive
  function setIconStatus(status, tabId) {
    // gsUtils.log(tabId, 'Setting icon status', status);
    var path = ![gsUtils.STATUS_NORMAL, gsUtils.STATUS_ACTIVE].includes(status)
      ? ICON_SUSPENSION_PAUSED
      : ICON_SUSPENSION_ACTIVE;
    // gsUtils.log(tabId, 'Setting icon status', path);
    chrome.action.setIcon({ path, tabId }, () => {
      if (chrome.runtime.lastError) {
        gsUtils.warning(tabId, chrome.runtime.lastError);
      }
    });
  }

  function setIconStatusForActiveTab() {
    getCurrentlyActiveTab(function(tab) {
      if (!tab) {
        return;
      }
      calculateTabStatus(tab, null, function(status) {
        setIconStatus(status, tab.id);
      });
    });
  }

  //HANDLERS FOR RIGHT-CLICK CONTEXT MENU
  function buildContextMenu(showContextMenu) {
    const allContexts = [ 'page', 'frame', 'editable', 'image', 'video', 'audio' ]; //'selection',

    if (!showContextMenu) {
      chrome.contextMenus.removeAll();
    } else {
      chrome.contextMenus.create({
        id: 'open_link_in_suspended_tab',
        title: chrome.i18n.getMessage('js_context_open_link_in_suspended_tab'),
        contexts: ['link'],
        // onclick: (info, tab) => { openLinkInSuspendedTab(tab, info.linkUrl); },
      });

      chrome.contextMenus.create({
        id: 'toggle_suspend_state',
        title: chrome.i18n.getMessage('js_context_toggle_suspend_state'),
        contexts: allContexts,
        // onclick: () => toggleSuspendedStateOfHighlightedTab(),
      });
      chrome.contextMenus.create({
        id: 'toggle_pause_suspension',
        title: chrome.i18n.getMessage('js_context_toggle_pause_suspension'),
        contexts: allContexts,
        // onclick: () => requestToggleTempWhitelistStateOfHighlightedTab(),
      });
      chrome.contextMenus.create({
        id: 'never_suspend_page',
        title: chrome.i18n.getMessage('js_context_never_suspend_page'),
        contexts: allContexts,
        // onclick: () => whitelistHighlightedTab(true),
      });
      chrome.contextMenus.create({
        id: 'never_suspend_domain',
        title: chrome.i18n.getMessage('js_context_never_suspend_domain'),
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
        title: chrome.i18n.getMessage('js_context_suspend_selected_tabs'),
        contexts: allContexts,
        // onclick: () => suspendSelectedTabs(),
      });
      chrome.contextMenus.create({
        id: 'unsuspend_selected_tabs',
        title: chrome.i18n.getMessage('js_context_unsuspend_selected_tabs'),
        contexts: allContexts,
        // onclick: () => unsuspendSelectedTabs(),
      });

      chrome.contextMenus.create({
        id: 'separator2',
        type: 'separator',
        contexts: allContexts,
      });
      chrome.contextMenus.create({
        id: 'soft_suspend_other_tabs_in_window',
        title: chrome.i18n.getMessage('js_context_soft_suspend_other_tabs_in_window'),
        contexts: allContexts,
        // onclick: () => suspendAllTabs(false),
      });
      chrome.contextMenus.create({
        id: 'force_suspend_other_tabs_in_window',
        title: chrome.i18n.getMessage('js_context_force_suspend_other_tabs_in_window'),
        contexts: allContexts,
        // onclick: () => suspendAllTabs(true),
      });
      chrome.contextMenus.create({
        id: 'unsuspend_all_tabs_in_window',
        title: chrome.i18n.getMessage('js_context_unsuspend_all_tabs_in_window'),
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
        title: chrome.i18n.getMessage('js_context_soft_suspend_all_tabs'),
        contexts: allContexts,
        // onclick: () => suspendAllTabsInAllWindows(false),
      });
      chrome.contextMenus.create({
        id: 'force_suspend_all_tabs',
        title: chrome.i18n.getMessage('js_context_force_suspend_all_tabs'),
        contexts: allContexts,
        // onclick: () => suspendAllTabsInAllWindows(true),
      });
      chrome.contextMenus.create({
        id: 'unsuspend_all_tabs',
        title: chrome.i18n.getMessage('js_context_unsuspend_all_tabs'),
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
        title: chrome.i18n.getMessage('html_recovery_go_to_session_manager'),
        contexts: allContexts,
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
    getInternalContextByTabId,
    getInternalContextsByViewName,
    requestNotice,
    clearNotice,
    buildContextMenu,
    getActiveTabStatus,
    getDebugInfo,
    calculateTabStatus,

    setIconStatus,
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
    whitelistHighlightedTab,
    unsuspendAllTabsInAllWindows,
    promptForFilePermissions,
  };

})();
