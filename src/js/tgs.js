import  { gsChrome }              from './gsChrome.js';
import  { gsFavicon }             from './gsFavicon.js';
import  { gsIndexedDb }           from './gsIndexedDb.js';
import  { gsMessages }            from './gsMessages.js';
import  { gsSession }             from './gsSession.js';
import  { gsStorage }             from './gsStorage.js';
import  { gsSuspendedTab }        from './gsSuspendedTab.js';
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

  // Unsuspended tab props
  const STATE_TIMER_DETAILS = 'timerDetails';

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

  const _tabStateByTabId = {};
  const _currentFocusedTabIdByWindowId = {};
  const _currentStationaryTabIdByWindowId = {};

  let _currentFocusedWindowId;
  let _currentStationaryWindowId;
  let _sessionSaveTimer;
  let _newTabFocusTimer;
  let _newWindowFocusTimer;
  let _noticeToDisplay;
  let _isCharging = false;
  let _triggerHotkeyUpdate = false;
  let _suspensionToggleHotkey;


  function getExtensionGlobals() {
    const globals = {
      tgs,
      gsUtils,
      gsChrome,
      gsStorage,
      gsIndexedDb,
      gsMessages,
      gsSession,
      gsFavicon,
      gsTabCheckManager,
      gsTabSuspendManager,
      gsTabDiscardManager,
      gsSuspendedTab,
    };
    for (const lib of Object.values(globals)) {
      if (!lib) {
        return null;
      }
    }
    return globals;
  }

  function setViewGlobals(_window) {
    const globals = getExtensionGlobals();
    if (!globals) {
      throw new Error('Lib not ready');
    }
    Object.assign(_window, globals);
  }



  function getInternalViewByTabId(tabId) {
    const internalViews = chrome.extension.getViews({ tabId: tabId });
    if (internalViews.length === 1) {
      return internalViews[0];
    }
    return null;
  }

  function getInternalViewsByViewName(viewName) {
    return chrome.extension
      .getViews()
      .filter(o => o.location.pathname.indexOf(viewName) >= 0);
  }

  function getCurrentlyActiveTab(callback) {
    // wrap this in an anonymous async function so we can use await
    (async function() {
      const currentWindowActiveTabs = await gsChrome.tabsQuery({
        active: true,
        currentWindow: true,
      });
      if (currentWindowActiveTabs.length > 0) {
        callback(currentWindowActiveTabs[0]);
        return;
      }

      // Fallback on chrome.windows.getLastFocused
      const lastFocusedWindow = await gsChrome.windowsGetLastFocused();
      if (lastFocusedWindow) {
        const lastFocusedWindowActiveTabs = await gsChrome.tabsQuery({
          active: true,
          windowId: lastFocusedWindow.id,
        });
        if (lastFocusedWindowActiveTabs.length > 0) {
          callback(lastFocusedWindowActiveTabs[0]);
          return;
        }
      }

      // Fallback on _currentStationaryWindowId
      if (_currentStationaryWindowId) {
        const currentStationaryWindowActiveTabs = await gsChrome.tabsQuery({
          active: true,
          windowId: _currentStationaryWindowId,
        });
        if (currentStationaryWindowActiveTabs.length > 0) {
          callback(currentStationaryWindowActiveTabs[0]);
          return;
        }

        // Fallback on currentStationaryTabId
        const currentStationaryTabId =
          _currentStationaryTabIdByWindowId[_currentStationaryWindowId];
        if (currentStationaryTabId) {
          const currentStationaryTab = await gsChrome.tabsGet(
            currentStationaryTabId,
          );
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
  function isCurrentStationaryTab(tab) {
    if (tab.windowId !== _currentStationaryWindowId) {
      return false;
    }
    var lastStationaryTabIdForWindow =
      _currentStationaryTabIdByWindowId[tab.windowId];
    if (lastStationaryTabIdForWindow) {
      return tab.id === lastStationaryTabIdForWindow;
    } else {
      // fallback on active flag
      return tab.active;
    }
  }

  function isCurrentFocusedTab(tab) {
    if (tab.windowId !== _currentFocusedWindowId) {
      return false;
    }
    var currentFocusedTabIdForWindow =
      _currentFocusedTabIdByWindowId[tab.windowId];
    if (currentFocusedTabIdForWindow) {
      return tab.id === currentFocusedTabIdForWindow;
    } else {
      // fallback on active flag
      return tab.active;
    }
  }

  function isCurrentActiveTab(tab) {
    const activeTabIdForWindow = _currentFocusedTabIdByWindowId[tab.windowId];
    if (activeTabIdForWindow) {
      return tab.id === activeTabIdForWindow;
    } else {
      // fallback on active flag
      return tab.active;
    }
  }

  function whitelistHighlightedTab(includePath) {
    includePath = includePath || false;
    getCurrentlyActiveTab(function(activeTab) {
      if (activeTab) {
        if (gsUtils.isSuspendedTab(activeTab)) {
          let url = gsUtils.getRootUrl(
            gsUtils.getOriginalUrl(activeTab.url),
            includePath,
            false,
          );
          gsUtils.saveToWhitelist(url);
          unsuspendTab(activeTab);
        } else if (gsUtils.isNormalTab(activeTab)) {
          let url = gsUtils.getRootUrl(activeTab.url, includePath, false);
          gsUtils.saveToWhitelist(url);
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
        gsUtils.removeFromWhitelist(activeTab.url);
        calculateTabStatus(activeTab, null, function(status) {
          setIconStatus(status, activeTab.id);
          if (callback) callback(status);
        });
      } else {
        if (callback) callback(gsUtils.STATUS_UNKNOWN);
      }
    });
  }

  function requestToggleTempWhitelistStateOfHighlightedTab(callback) {
    getCurrentlyActiveTab(function(activeTab) {
      if (!activeTab) {
        if (callback) callback(status);
        return;
      }
      if (gsUtils.isSuspendedTab(activeTab)) {
        unsuspendTab(activeTab);
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
        gsUtils.warning(
          tab.id,
          'Failed to sendTemporaryWhitelistToContentScript',
          error,
        );
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
        gsUtils.warning(
          tab.id,
          'Failed to sendUndoTemporaryWhitelistToContentScript',
          error,
        );
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
    getCurrentlyActiveTab(activeTab => {
      if (activeTab) {
        if (gsUtils.isSuspendedTab(activeTab)) {
          unsuspendTab(activeTab);
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
    getCurrentlyActiveTab(activeTab => {
      if (activeTab && gsUtils.isSuspendedTab(activeTab)) {
        unsuspendTab(activeTab);
      }
    });
  }

  function suspendAllTabs(force) {
    const forceLevel = force ? 1 : 2;
    getCurrentlyActiveTab(activeTab => {
      if (!activeTab) {
        gsUtils.warning(
          'background',
          'Could not determine currently active window.',
        );
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
        gsUtils.warning(
          'background',
          'Could not determine currently active window.',
        );
        return;
      }
      chrome.windows.get(activeTab.windowId, { populate: true }, curWindow => {
        for (const tab of curWindow.tabs) {
          gsTabSuspendManager.unqueueTabForSuspension(tab);
          if (gsUtils.isSuspendedTab(tab)) {
            unsuspendTab(tab);
          } else if (gsUtils.isNormalTab(tab) && !tab.active) {
            resetAutoSuspendTimerForTab(tab);
          }
        }
      });
    });
  }

  function unsuspendAllTabsInAllWindows() {
    chrome.windows.getLastFocused({}, currentWindow => {
      chrome.tabs.query({}, tabs => {
        // Because of the way that unsuspending steals window focus, we defer the suspending of tabs in the
        // current window until last
        var deferredTabs = [];
        for (const tab of tabs) {
          gsTabSuspendManager.unqueueTabForSuspension(tab);
          if (gsUtils.isSuspendedTab(tab)) {
            if (tab.windowId === currentWindow.id) {
              deferredTabs.push(tab);
            } else {
              unsuspendTab(tab);
            }
          } else if (gsUtils.isNormalTab(tab)) {
            resetAutoSuspendTimerForTab(tab);
          }
        }
        for (const tab of deferredTabs) {
          unsuspendTab(tab);
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
    chrome.tabs.query(
      { highlighted: true, lastFocusedWindow: true },
      selectedTabs => {
        for (const tab of selectedTabs) {
          gsTabSuspendManager.unqueueTabForSuspension(tab);
          if (gsUtils.isSuspendedTab(tab)) {
            unsuspendTab(tab);
          }
        }
      },
    );
  }

  function queueSessionTimer() {
    clearTimeout(_sessionSaveTimer);
    _sessionSaveTimer = setTimeout(function() {
      gsUtils.log('background', 'updating current session');
      gsSession.updateCurrentSession(); //async
    }, 1000);
  }

  function resetAutoSuspendTimerForTab(tab) {
    clearAutoSuspendTimerForTabId(tab.id);

    gsStorage.getOption(gsStorage.SUSPEND_TIME).then((suspendTime) => {
      const timeToSuspend = suspendTime * (1000 * 60);
      if (
        gsUtils.isProtectedActiveTab(tab) ||
        isNaN(suspendTime) ||
        suspendTime <= 0
      ) {
        return;
      }

      const timerDetails = {};
      timerDetails.tabId = tab.id;
      timerDetails.suspendDateTime = new Date(
        new Date().getTime() + timeToSuspend,
      );

      timerDetails.timer = setTimeout(async () => {
        const updatedTabId = timerDetails.tabId; // This may get updated via updateTabIdReferences
        const updatedTab = await gsChrome.tabsGet(updatedTabId);
        if (!updatedTab) {
          gsUtils.warning(updatedTabId, 'Couldnt find tab. Aborting suspension');
          return;
        }
        gsTabSuspendManager.queueTabForSuspension(updatedTab, 3);
      }, timeToSuspend);
      gsUtils.log(
        tab.id,
        'Adding tab timer for: ' + timerDetails.suspendDateTime,
      );

      setTabStatePropForTabId(tab.id, STATE_TIMER_DETAILS, timerDetails);
    });
  }

  function resetAutoSuspendTimerForAllTabs() {
    chrome.tabs.query({}, tabs => {
      for (const tab of tabs) {
        if (gsUtils.isNormalTab(tab)) {
          resetAutoSuspendTimerForTab(tab);
        }
      }
    });
  }

  function clearAutoSuspendTimerForTabId(tabId) {
    const timerDetails = getTabStatePropForTabId(tabId, STATE_TIMER_DETAILS);
    if (!timerDetails) {
      return;
    }
    gsUtils.log(tabId, 'Removing tab timer.');
    clearTimeout(timerDetails.timer);
    setTabStatePropForTabId(tabId, STATE_TIMER_DETAILS, null);
  }

  function getTabStatePropForTabId(tabId, prop) {
    return _tabStateByTabId[tabId] ? _tabStateByTabId[tabId][prop] : undefined;
  }

  function setTabStatePropForTabId(tabId, prop, value) {
    // gsUtils.log(tabId, `Setting tab state prop: ${prop}:`, value);
    const tabState = _tabStateByTabId[tabId] || {};
    tabState[prop] = value;
    _tabStateByTabId[tabId] = tabState;
  }

  function clearTabStateForTabId(tabId) {
    gsUtils.log(tabId, 'Clearing tab state props:', _tabStateByTabId[tabId]);
    clearAutoSuspendTimerForTabId(tabId);
    delete _tabStateByTabId[tabId];
  }

  function unsuspendTab(tab) {
    if (!gsUtils.isSuspendedTab(tab)) return;

    const scrollPosition = gsUtils.getSuspendedScrollPosition(tab.url);
    tgs.setTabStatePropForTabId(tab.id, tgs.STATE_SCROLL_POS, scrollPosition);

    let originalUrl = gsUtils.getOriginalUrl(tab.url);
    if (originalUrl) {
      // Reloading chrome.tabs.update causes a history item for the suspended tab
      // to be made in the tab history. We clean this up on tab updated hook
      setTabStatePropForTabId(tab.id, tgs.STATE_HISTORY_URL_TO_REMOVE, tab.url);
      if (tab.autoDiscardable) {
        setTabStatePropForTabId(tab.id, tgs.STATE_SET_AUTODISCARDABLE, tab.url);
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
      _triggerHotkeyUpdate = true;
    }
  }

  function handleUnsuspendedTabStateChanged(tab, changeInfo) {
    if (
      !changeInfo.hasOwnProperty('status') &&
      !changeInfo.hasOwnProperty('audible') &&
      !changeInfo.hasOwnProperty('pinned') &&
      !changeInfo.hasOwnProperty('discarded')
    ) {
      return;
    }
    gsUtils.log(
      tab.id,
      'unsuspended tab state changed. changeInfo: ',
      changeInfo,
    );

    // Ensure we clear the STATE_UNLOADED_URL flag during load in case the
    // tab is suspended again before loading can finish (in which case on
    // suspended tab complete, the tab will reload again)
    if (
      changeInfo.hasOwnProperty('status') &&
      changeInfo.status === 'loading'
    ) {
      setTabStatePropForTabId(tab.id, STATE_UNLOADED_URL, null);
    }

    // Check if tab has just been discarded
    if (changeInfo.hasOwnProperty('discarded') && changeInfo.discarded) {
      const existingSuspendReason = getTabStatePropForTabId(
        tab.id,
        STATE_SUSPEND_REASON,
      );
      if (existingSuspendReason && existingSuspendReason === 3) {
        // For some reason the discarded changeInfo gets called twice (chrome bug?)
        // As a workaround we use the suspend reason to determine if we've already
        // handled this discard
        //TODO: Report chrome bug
        return;
      }
      gsUtils.log(
        tab.id,
        'Unsuspended tab has been discarded. Url: ' + tab.url,
      );
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
      gsTabSuspendManager.queueTabForSuspension(
        tab,
        queuedTabDetails.executionProps.forceLevel,
      );
      return;
    }

    let hasTabStatusChanged = false;

    // Check for change in tabs audible status
    if (changeInfo.hasOwnProperty('audible')) {
      gsStorage.getOption(gsStorage.IGNORE_AUDIO).then((ignoreAudio) => {
        //reset tab timer if tab has just finished playing audio
        if (!changeInfo.audible && ignoreAudio) {
          resetAutoSuspendTimerForTab(tab);
        }
        hasTabStatusChanged = true;
      })
    }
    if (changeInfo.hasOwnProperty('pinned')) {
      gsStorage.getOption(gsStorage.IGNORE_PINNED).then((ignorePinned) => {
        //reset tab timer if tab has become unpinned
        if (!changeInfo.pinned && ignorePinned) {
          resetAutoSuspendTimerForTab(tab);
        }
        hasTabStatusChanged = true;
      })
    }

    if (changeInfo.hasOwnProperty('status')) {
      if (changeInfo.status === 'complete') {
        const tempWhitelistOnReload = getTabStatePropForTabId(
          tab.id,
          STATE_TEMP_WHITELIST_ON_RELOAD,
        );
        const scrollPos =
          getTabStatePropForTabId(tab.id, STATE_SCROLL_POS) || null;
        const historyUrlToRemove = getTabStatePropForTabId(
          tab.id,
          STATE_HISTORY_URL_TO_REMOVE,
        );
        const setAutodiscardable = getTabStatePropForTabId(
          tab.id,
          STATE_SET_AUTODISCARDABLE,
        );
        clearTabStateForTabId(tab.id);

        if (historyUrlToRemove) {
          removeTabHistoryForUnuspendedTab(historyUrlToRemove);
        }
        if (setAutodiscardable) {
          gsChrome.tabsUpdate(tab.id, { autoDiscardable: true });
        }

        //init loaded tab
        resetAutoSuspendTimerForTab(tab);
        initialiseTabContentScript(tab, tempWhitelistOnReload, scrollPos)
          .catch(error => {
            gsUtils.warning(
              tab.id,
              'Failed to send init to content script. Tab may not behave as expected.',
            );
          })
          .then(() => {
            // could use returned tab status here below
          });
      }

      hasTabStatusChanged = true;
    }

    //if tab is currently visible then update popup icon
    if (hasTabStatusChanged && isCurrentFocusedTab(tab)) {
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
          () => {
          },
        );
      }
    });
  }

  function initialiseTabContentScript(tab, isTempWhitelist, scrollPos) {
    return new Promise(async (resolve, reject) => {
      const ignoreForms = await gsStorage.getOption(gsStorage.IGNORE_FORMS);
      gsMessages.sendInitTabToContentScript(
        tab.id,
        ignoreForms,
        isTempWhitelist,
        scrollPos,
        (error, response) => {
          if (error) {
            reject(error);
          } else {
            resolve(response);
          }
        },
      );
    });
  }

  function handleSuspendedTabStateChanged(tab, changeInfo) {
    if (
      !changeInfo.hasOwnProperty('status') &&
      !changeInfo.hasOwnProperty('discarded')
    ) {
      return;
    }

    gsUtils.log(
      tab.id,
      'suspended tab status changed. changeInfo: ',
      changeInfo,
    );

    if (changeInfo.status && changeInfo.status === 'loading') {
      tgs.setTabStatePropForTabId(
        tab.id,
        tgs.STATE_INITIALISE_SUSPENDED_TAB,
        true,
      );
      return;
    }

    if (
      (changeInfo.status && changeInfo.status === 'complete') ||
      changeInfo.discarded
    ) {
      gsTabSuspendManager.unqueueTabForSuspension(tab); //safety precaution
      const shouldInitTab = getTabStatePropForTabId(
        tab.id,
        STATE_INITIALISE_SUSPENDED_TAB,
      );
      if (shouldInitTab) {
        initialiseSuspendedTab(tab);
      }
    }
  }

  function initialiseSuspendedTab(tab) {
    const unloadedUrl = getTabStatePropForTabId(tab.id, STATE_UNLOADED_URL);
    const disableUnsuspendOnReload = getTabStatePropForTabId(
      tab.id,
      STATE_DISABLE_UNSUSPEND_ON_RELOAD,
    );
    clearTabStateForTabId(tab.id);

    if (isCurrentFocusedTab(tab)) {
      setIconStatus(gsUtils.STATUS_SUSPENDED, tab.id);
    }

    //if a suspended tab is marked for unsuspendOnReload then unsuspend tab and return early
    const suspendedTabRefreshed = unloadedUrl === tab.url;
    if (suspendedTabRefreshed && !disableUnsuspendOnReload) {
      unsuspendTab(tab);
      return;
    }

    const tabView = tgs.getInternalViewByTabId(tab.id);
    gsStorage.getOption(gsStorage.DISCARD_AFTER_SUSPEND).then((discardAfterSuspend) => {
      const quickInit = discardAfterSuspend && !tab.active;
      gsSuspendedTab
        .initTab(tab, tabView, { quickInit })
        .catch(error => {
          gsUtils.warning(tab.id, error);
        })
        .then(() => {
          gsTabCheckManager.queueTabCheck(tab, { refetchTab: true }, 3000);
        });
    })
  }

  function updateTabIdReferences(newTabId, oldTabId) {
    gsUtils.log(oldTabId, 'update tabId references to ' + newTabId);
    for (const windowId of Object.keys(_currentFocusedTabIdByWindowId)) {
      if (_currentFocusedTabIdByWindowId[windowId] === oldTabId) {
        _currentFocusedTabIdByWindowId[windowId] = newTabId;
      }
    }
    for (const windowId of Object.keys(_currentStationaryTabIdByWindowId)) {
      if (_currentStationaryTabIdByWindowId[windowId] === oldTabId) {
        _currentStationaryTabIdByWindowId[windowId] = newTabId;
      }
    }
    if (_tabStateByTabId[oldTabId]) {
      _tabStateByTabId[newTabId] = _tabStateByTabId[oldTabId];
      delete _tabStateByTabId[oldTabId];
    }
    const timerDetails = getTabStatePropForTabId(newTabId, STATE_TIMER_DETAILS);
    if (timerDetails) {
      timerDetails.tabId = newTabId;
    }
  }

  function removeTabIdReferences(tabId) {
    gsUtils.log(tabId, 'removing tabId references to ' + tabId);
    for (const windowId of Object.keys(_currentFocusedTabIdByWindowId)) {
      if (_currentFocusedTabIdByWindowId[windowId] === tabId) {
        _currentFocusedTabIdByWindowId[windowId] = null;
      }
    }
    for (const windowId of Object.keys(_currentStationaryTabIdByWindowId)) {
      if (_currentStationaryTabIdByWindowId[windowId] === tabId) {
        _currentStationaryTabIdByWindowId[windowId] = null;
      }
    }
    clearTabStateForTabId(tabId);
  }

  async function getSuspensionToggleHotkey() {
    if (_suspensionToggleHotkey === undefined) {
      _suspensionToggleHotkey = await buildSuspensionToggleHotkey();
    }
    return _suspensionToggleHotkey;
  }

  function handleWindowFocusChanged(windowId) {
    gsUtils.log(windowId, 'window gained focus');
    if (windowId < 0 || windowId === _currentFocusedWindowId) {
      return;
    }
    _currentFocusedWindowId = windowId;

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
        gsUtils.warning(
          'background',
          `Couldnt find active tab with windowId: ${windowId}. Window may have been closed.`,
        );
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
    gsUtils.log(tabId, 'tab gained focus');

    const focusedTab = await gsChrome.tabsGet(tabId);
    if (!focusedTab) {
      // If focusedTab is null then assume tab has been discarded between the
      // time the chrome.tabs.onActivated event was activated and now.
      // If so, then a subsequeunt chrome.tabs.onActivated event will be called
      // with the new discarded id
      gsUtils.log(
        tabId,
        'Could not find newly focused tab. Assuming it has been discarded',
      );
      return;
    }

    const previouslyFocusedTabId = _currentFocusedTabIdByWindowId[windowId];
    _currentFocusedTabIdByWindowId[windowId] = tabId;

    // If the tab focused before this was the keyboard shortcuts page, then update hotkeys on suspended pages
    if (_triggerHotkeyUpdate) {
      const oldHotkey = _suspensionToggleHotkey;
      _suspensionToggleHotkey = await buildSuspensionToggleHotkey();
      if (oldHotkey !== _suspensionToggleHotkey) {
        const suspendedViews = getInternalViewsByViewName('suspended');
        for (const suspendedView of suspendedViews) {
          gsSuspendedTab.updateCommand(suspendedView, _suspensionToggleHotkey);
        }
      }
      _triggerHotkeyUpdate = false;
    }

    gsTabDiscardManager.unqueueTabForDiscard(focusedTab);

    // If normal tab, then ensure it has a responsive content script
    let contentScriptStatus = null;
    if (gsUtils.isNormalTab(focusedTab, true)) {
      contentScriptStatus = await getContentScriptStatus(focusedTab.id);
      if (!contentScriptStatus) {
        contentScriptStatus = await gsTabCheckManager.queueTabCheckAsPromise(
          focusedTab,
          {},
          0,
        );
      }
      gsUtils.log(
        focusedTab.id,
        'Content script status: ' + contentScriptStatus,
      );
    }

    //update icon
    const status = await new Promise(r => {
      calculateTabStatus(focusedTab, contentScriptStatus, r);
    });
    gsUtils.log(focusedTab.id, 'Focused tab status: ' + status);

    //if this tab still has focus then update icon
    if (_currentFocusedTabIdByWindowId[windowId] === focusedTab.id) {
      setIconStatus(status, focusedTab.id);
    }

    //pause for a bit before assuming we're on a new tab as some users
    //will key through intermediate tabs to get to the one they want.
    queueNewTabFocusTimer(tabId, windowId, focusedTab);

    //test for a save of keyboard shortcuts (chrome://extensions/shortcuts)
    if (focusedTab.url === 'chrome://extensions/shortcuts') {
      _triggerHotkeyUpdate = true;
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
      gsUtils.log(
        previouslyFocusedTabId,
        'Could not find tab. Has probably already been discarded',
      );
      return;
    }
    if (!gsUtils.isSuspendedTab(previouslyFocusedTab)) {
      return;
    }

    //queue tabCheck for previouslyFocusedTab. that will force a discard afterwards
    //but also avoids conflicts if this tab is already scheduled for checking
    gsUtils.log(
      previouslyFocusedTabId,
      'Queueing previously focused tab for discard via tabCheckManager',
    );
    gsTabCheckManager.queueTabCheck(previouslyFocusedTab, {}, 1000);
  }

  function queueNewWindowFocusTimer(tabId, windowId, focusedTab) {
    clearTimeout(_newWindowFocusTimer);
    _newWindowFocusTimer = setTimeout(function() {
      var previousStationaryWindowId = _currentStationaryWindowId;
      _currentStationaryWindowId = windowId;
      var previousStationaryTabId =
        _currentStationaryTabIdByWindowId[previousStationaryWindowId];
      handleNewStationaryTabFocus(tabId, previousStationaryTabId, focusedTab);
    }, focusDelay);
  }

  function queueNewTabFocusTimer(tabId, windowId, focusedTab) {
    clearTimeout(_newTabFocusTimer);
    _newTabFocusTimer = setTimeout(function() {
      var previousStationaryTabId = _currentStationaryTabIdByWindowId[windowId];
      _currentStationaryTabIdByWindowId[windowId] = focusedTab.id;
      handleNewStationaryTabFocus(tabId, previousStationaryTabId, focusedTab);
    }, focusDelay);
  }

  function handleNewStationaryTabFocus(
    focusedTabId,
    previousStationaryTabId,
    focusedTab,
  ) {
    gsUtils.log(focusedTabId, 'new stationary tab focus handled');

    if (gsUtils.isSuspendedTab(focusedTab)) {
      handleSuspendedTabFocusGained(focusedTab); //async. unhandled promise.
    } else if (gsUtils.isNormalTab(focusedTab)) {
      const queuedTabDetails = gsTabSuspendManager.getQueuedTabDetails(
        focusedTab,
      );
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
    } else if (focusedTab.url === chrome.runtime.getURL('options.html')) {
      const optionsView = getInternalViewByTabId(focusedTab.id);
      if (optionsView && optionsView.exports) {
        optionsView.exports.initSettings();
      }
    }

    //Reset timer on tab that lost focus.
    //NOTE: This may be due to a change in window focus in which case the tab may still have .active = true
    if (previousStationaryTabId && previousStationaryTabId !== focusedTabId) {
      chrome.tabs.get(previousStationaryTabId, function(previousStationaryTab) {
        if (chrome.runtime.lastError) {
          //Tab has probably been removed
          return;
        }
        if (
          previousStationaryTab &&
          gsUtils.isNormalTab(previousStationaryTab) &&
          !gsUtils.isProtectedActiveTab(previousStationaryTab)
        ) {
          resetAutoSuspendTimerForTab(previousStationaryTab);
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
        unsuspendTab(focusedTab);
      } else {
        const suspendedView = getInternalViewByTabId(focusedTab.id);
        if (suspendedView) {
          gsSuspendedTab.showNoConnectivityMessage(suspendedView);
        }
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

  function requestNotice() {
    return _noticeToDisplay;
  }

  function clearNotice() {
    _noticeToDisplay = undefined;
  }

  function getCurrentStationaryTabIdByWindowId() {
    return _currentStationaryTabIdByWindowId;
  }

  function getCurrentFocusedTabIdByWindowId() {
    return _currentFocusedTabIdByWindowId;
  }

  function setCurrentStationaryWindowId(value) {
    _currentStationaryWindowId = value;
  }

  function setCurrentFocusedWindowId(value) {
    _currentFocusedWindowId = value;
  }

  function isCharging() {
    return _isCharging;
  }

  function setCharging(value) {
    _isCharging = value;
  }

  function getDebugInfo(tabId, callback) {
    const timerDetails = getTabStatePropForTabId(tabId, STATE_TIMER_DETAILS);
    const info = {
      windowId: '',
      tabId: '',
      status: gsUtils.STATUS_UNKNOWN,
      timerUp: timerDetails ? timerDetails.suspendDateTime : '-',
    };

    chrome.tabs.get(tabId, function(tab) {
      if (chrome.runtime.lastError) {
        gsUtils.error(tabId, chrome.runtime.lastError);
        callback(info);
        return;
      }

      info.windowId = tab.windowId;
      info.tabId = tab.id;
      if (gsUtils.isNormalTab(tab, true)) {
        gsMessages.sendRequestInfoToContentScript(tab.id, function(
          error,
          tabInfo,
        ) {
          if (error) {
            gsUtils.warning(tab.id, 'Failed to getDebugInfo', error);
          }
          if (tabInfo) {
            calculateTabStatus(tab, tabInfo.status, function(status) {
              info.status = status;
              callback(info);
            });
          } else {
            callback(info);
          }
        });
      } else {
        calculateTabStatus(tab, null, function(status) {
          info.status = status;
          callback(info);
        });
      }
    });
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
    if (gsUtils.checkWhiteList(tab.url)) {
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
        if (
          contentScriptStatus &&
          contentScriptStatus !== gsUtils.STATUS_NORMAL
        ) {
          callback(contentScriptStatus);
          return;
        }
        //check running on battery
        if (
          await gsStorage.getOption(gsStorage.IGNORE_WHEN_CHARGING) &&
          _isCharging
        ) {
          callback(gsUtils.STATUS_CHARGING);
          return;
        }
        //check internet connectivity
        if (
          await gsStorage.getOption(gsStorage.IGNORE_WHEN_OFFLINE) &&
          !navigator.onLine
        ) {
          callback(gsUtils.STATUS_NOCONNECTIVITY);
          return;
        }
        //check pinned tab
        if (gsUtils.isProtectedPinnedTab(tab)) {
          callback(gsUtils.STATUS_PINNED);
          return;
        }
        //check audible tab
        if (gsUtils.isProtectedAudibleTab(tab)) {
          callback(gsUtils.STATUS_AUDIBLE);
          return;
        }
        //check active
        if (gsUtils.isProtectedActiveTab(tab)) {
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
    // gsUtils.log(tabId, 'Setting icon status: ', status);
    var path = ![gsUtils.STATUS_NORMAL, gsUtils.STATUS_ACTIVE].includes(status)
      ? ICON_SUSPENSION_PAUSED
      : ICON_SUSPENSION_ACTIVE;
    // gsUtils.log(tabId, 'Setting icon status: ', path);
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
    const allContexts = [
      'page',
      'frame',
      'editable',
      'image',
      'video',
      'audio',
    ]; //'selection',

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
    }
  }







  return {
    STATE_TIMER_DETAILS,
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
    setViewGlobals,
    getInternalViewByTabId,
    getInternalViewsByViewName,
    requestNotice,
    clearNotice,
    buildContextMenu,
    getActiveTabStatus,
    getDebugInfo,
    calculateTabStatus,

    getExtensionGlobals,
    setIconStatus,
    getCurrentlyActiveTab,
    openLinkInSuspendedTab,
    toggleSuspendedStateOfHighlightedTab,
    suspendAllTabsInAllWindows,
    handleWindowFocusChanged,
    handleTabFocusChanged,
    updateTabIdReferences,
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
