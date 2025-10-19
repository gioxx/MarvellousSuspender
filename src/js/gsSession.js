import  { gsChrome }              from './gsChrome.js';
import  { gsIndexedDb }           from './gsIndexedDb.js';
import  { gsStorage }             from './gsStorage.js';
import  { gsTabCheckManager }     from './gsTabCheckManager.js';
import  { gsTabDiscardManager }   from './gsTabDiscardManager.js';
import  { gsUtils }               from './gsUtils.js';
import  { tgs }                   from './tgs.js';

export const gsSession = (function() {
  'use strict';

  const tabsToRestorePerSecond  = 15;
  const tabsToGroupPerSecond    = 50;

  const updateUrl   = chrome.runtime.getURL('update.html');
  const updatedUrl  = chrome.runtime.getURL('updated.html');

  let fileUrlsAccessAllowed = false;

  async function initAsPromised() {
    // Set fileUrlsAccessAllowed to determine if extension can work on file:// URLs
    await new Promise((resolve) => {
      chrome.extension.isAllowedFileSchemeAccess((isAllowedAccess) => {
        fileUrlsAccessAllowed = isAllowedAccess;
        resolve();
      });
    });

    //remove any update screens
    await Promise.all([
      gsUtils.removeTabsByUrlAsPromised(updateUrl),
      gsUtils.removeTabsByUrlAsPromised(updatedUrl),
    ]);

    //handle special event where an extension update is available
    chrome.runtime.onUpdateAvailable.addListener(details => {
      prepareForUpdate(details); //async
    });
    gsUtils.log('gsSession', 'init successful');
  }

  async function prepareForUpdate(newVersionDetails) {
    const currentVersion = chrome.runtime.getManifest().version;
    const newVersion = newVersionDetails.version;

    gsUtils.log( 'gsSession', 'A new version is available: ' + currentVersion + ' -> ' + newVersion );

    let sessionRestorePoint;
    const currentSession = await buildCurrentSession();
    if (currentSession) {
      sessionRestorePoint = await gsIndexedDb.createOrUpdateSessionRestorePoint( currentSession, currentVersion );
    }

    const suspendedTabCount = await gsUtils.getSuspendedTabCount();
    if (!sessionRestorePoint || suspendedTabCount > 0) {
      //show update message in suspended.html page
      await gsStorage.setOptionAndSync(gsStorage.UPDATE_AVAILABLE, true);
      // await gsChrome.tabsCreate(updateUrl);

      //ensure we don't leave any windows with no unsuspended tabs
      await unsuspendActiveTabInEachWindow();
    }
    else {
      // if there are no suspended tabs then simply install the update immediately
      chrome.runtime.reload();
    }
  }

  async function getSessionId() {
    let gsSessionId = await gsStorage.getStorageJSON('session', 'gsSessionId');
    if (!gsSessionId) {
      gsSessionId = Date.now() + '';
      await gsStorage.saveStorage('session', 'gsSessionId', gsSessionId);
      gsUtils.log('gsSession', 'gsSessionId', gsSessionId);
    }
    return gsSessionId;
  }

  async function buildCurrentSession() {
    const currentWindows    = await gsChrome.windowsGetAll();
    const currentTabGroups  = await gsChrome.tabGroupsGetAll();
    const tabsExist         = currentWindows.some( window => window.tabs && window.tabs.length );
    if (!tabsExist) {
      gsUtils.warning( 'gsSession', 'Failed to build current session. Could not find any tabs.' );
      return null;
    }
    // gsUtils.log('gsSession', 'buildCurrentSession currentTabGroups', currentTabGroups);
    return {
      sessionId: await getSessionId(),
      windows: currentWindows,
      tabGroups: currentTabGroups,
      date: new Date().toISOString(),
    };
  }

  async function updateCurrentSession() {
    // gsUtils.log('gsSession', 'updateCurrentSession');
    const currentSession = await buildCurrentSession();
    if (currentSession) {
      await gsIndexedDb.updateSession(currentSession);
    }
  }

  async function isUpdated() {
    return gsStorage.getStorageJSON('session', 'gsUpdated');
  }

  async function isInitialising() {
    const gsInitialisationMode = await gsStorage.getStorageJSON('session', 'gsInitialisationMode');
    gsUtils.log('isInitialising', gsInitialisationMode);
    return gsInitialisationMode;
  }

  function isFileUrlsAccessAllowed() {
    return fileUrlsAccessAllowed;
  }

  async function getUpdateType() {
    return gsStorage.getStorageJSON('session', 'gsUpdateType');
  }

  async function setSynchedSettingsOnInit(gsSyncedSettingsOnInit) {
    gsStorage.saveStorage('session', 'gsSyncedSettingsOnInit', gsSyncedSettingsOnInit);
  }

  async function runStartupChecks() {
    await gsStorage.saveStorage('session', 'gsInitialisationMode', true);

    const currentSessionTabs = await gsChrome.tabsQuery();
    const curVersion = chrome.runtime.getManifest().version;
    const gsStartupLastVersion = await gsStorage.fetchLastVersion();
    gsUtils.log('gsSession',`

    ------------------------------------------------
    runStartupChecks
    Current version:  ${curVersion}
    Last version:     ${gsStartupLastVersion}
    ------------------------------------------------
    Open tabs:
    `, currentSessionTabs);

    if (chrome.extension.inIncognitoContext) {
      // do nothing if in incognito context
      // startupType = 'Incognito';
    } else if (gsStartupLastVersion === curVersion) {
      gsUtils.log('gsSession', 'HANDLING NORMAL STARTUP');
      // startupType = 'Restart';
      await handleNormalStartup(currentSessionTabs, curVersion);
    } else if (!gsStartupLastVersion || gsStartupLastVersion === '0.0.0') {
      gsUtils.log('gsSession', 'HANDLING NEW INSTALL');
      // startupType = 'Install';
      await handleNewInstall(curVersion);
    } else {
      gsUtils.log('gsSession', 'HANDLING UPDATE');
      // startupType = 'Update';
      await handleUpdate(currentSessionTabs, curVersion, gsStartupLastVersion);
    }

    await performTabChecks();

    // Ensure currently focused tab is initialised correctly if suspended
    const currentWindowActiveTabs = await gsChrome.tabsQuery({ active: true, currentWindow: true, });
    if (currentWindowActiveTabs.length > 0) {
      gsTabCheckManager.queueTabCheck(currentWindowActiveTabs[0]);
    }

    updateCurrentSession(); //async
    await gsStorage.saveStorage('session', 'gsInitialisationMode', false);
  }

  //make sure the contentscript / suspended script of each tab is responsive
  async function performTabChecks() {
    const initStartTime = Date.now();
    gsUtils.log('gsSession',`

    ------------------------------------------------
    Checking tabs for responsiveness...
    ------------------------------------------------
    `);

    const postRecoverySessionTabs = await gsChrome.tabsQuery();
    gsUtils.log( 'gsSession', 'postRecoverySessionTabs:', postRecoverySessionTabs );

    const tabCheckResults = await gsTabCheckManager.performInitialisationTabChecks( postRecoverySessionTabs );
    const totalTabCheckCount = tabCheckResults.length;
    const successfulTabChecksCount = tabCheckResults.filter(
      o => o === gsUtils.STATUS_SUSPENDED || o === gsUtils.STATUS_DISCARDED,
    ).length;

    const startupTabCheckTimeTakenInSeconds = parseInt( (Date.now() - initStartTime) / 1000 );
    gsUtils.log('gsSession',`

    ------------------------------------------------
    Checking tabs finished. Time taken: ${startupTabCheckTimeTakenInSeconds} sec
    ${successfulTabChecksCount} / ${totalTabCheckCount} initialised successfully
    ------------------------------------------------
    `);
  }

  async function handleNormalStartup(currentSessionTabs, curVersion) {
    // "Normal" startup means the manifest version matches our last stored version
    // So, clear the UPDATE_AVAILABLE flag
    await gsStorage.setOptionAndSync(gsStorage.UPDATE_AVAILABLE, false);

    const shouldRecoverTabs = await checkForCrashRecovery(currentSessionTabs);
    if (shouldRecoverTabs) {
      const lastExtensionRecoveryTimestamp = await gsStorage.fetchLastExtensionRecoveryTimestamp();
      const hasCrashedRecently =
        lastExtensionRecoveryTimestamp &&
        Date.now() - lastExtensionRecoveryTimestamp < 1000 * 60 * 5;
      gsStorage.setLastExtensionRecoveryTimestamp(Date.now());

      if (!hasCrashedRecently) {
        //if this is the first recent crash, then automatically recover lost tabs
        await recoverLostTabs();
      } else {
        //otherwise show the recovery page
        const recoveryUrl = chrome.runtime.getURL('recovery.html');
        await gsChrome.tabsCreate(recoveryUrl);
        //hax0r: wait for recovery tab to finish loading before returning
        //this is so we remain in 'recoveryMode' for a bit longer, preventing
        //the sessionUpdate code from running when this tab gains focus
        await gsUtils.setTimeout(2000);
      }
    } else {
      await gsIndexedDb.trimDbItems();
    }
  }

  async function handleNewInstall(curVersion) {
    gsStorage.setLastVersion(curVersion);

    // Try to determine if this is a new install for the computer or for the whole profile
    // If settings sync contains non-default options, then we can assume it's only
    // a new install for this computer
    const gsSyncedSettingsOnInit = await gsStorage.getStorageJSON('session', 'gsSyncedSettingsOnInit');
    if (
      !gsSyncedSettingsOnInit ||
      Object.keys(gsSyncedSettingsOnInit).length === 0
    ) {
      //show welcome message
      const optionsUrl = chrome.runtime.getURL('options.html?firstTime');
      await gsChrome.tabsCreate(optionsUrl);
    }
  }

  async function handleUpdate(currentSessionTabs, curVersion, lastVersion) {
    gsUtils.log('gsSession', 'handleUpdate');
    gsStorage.setLastVersion(curVersion);
    const lastVersionParts = lastVersion.split('.');
    const curVersionParts = curVersion.split('.');
    let gsUpdateType = null;
    if (lastVersionParts.length >= 2 && curVersionParts.length >= 2) {
      if (parseInt(curVersionParts[0]) > parseInt(lastVersionParts[0])) {
        gsUpdateType = 'major';
      }
      else if (parseInt(curVersionParts[1]) > parseInt(lastVersionParts[1])) {
        gsUpdateType = 'minor';
      }
      else {
        gsUpdateType = 'patch';
      }
    }
    if (gsUpdateType) {
      await gsStorage.saveStorage('session', 'gsUpdateType', gsUpdateType);
    }

    const sessionRestorePoint = await gsIndexedDb.fetchSessionRestorePoint(
      lastVersion,
    );
    if (!sessionRestorePoint) {
      const lastSession = await gsIndexedDb.fetchLastSession();
      if (lastSession) {
        await gsIndexedDb.createOrUpdateSessionRestorePoint(
          lastSession,
          lastVersion,
        );
      } else {
        gsUtils.error(
          'gsSession',
          'No session restore point found, and no lastSession exists!',
        );
      }
    }

    await gsUtils.removeTabsByUrlAsPromised(updateUrl);
    await gsUtils.removeTabsByUrlAsPromised(updatedUrl);

    await gsIndexedDb.performMigration(lastVersion);
    gsStorage.setNoticeVersion('0');
    const shouldRecoverTabs = await checkForCrashRecovery(currentSessionTabs);
    let gsUpdated = false;
    if (shouldRecoverTabs) {
      await gsUtils.createTabAndWaitForFinishLoading(updatedUrl, 10000);

      await recoverLostTabs();
      gsUpdated = true;

      //update updated views
      const contexts = await tgs.getInternalContextsByViewName('updated');
      if (contexts.length > 0) {
        for (const context of contexts) {
          chrome.tabs.sendMessage(context.tabId, { action: 'toggleUpdated', tabId: context.tabId });
        }
      }
      else {
        await gsUtils.removeTabsByUrlAsPromised(updatedUrl);
        await gsChrome.tabsCreate({ url: updatedUrl });
      }
    }
    else {
      gsUpdated = true;
      await gsChrome.tabsCreate({ url: updatedUrl });
    }
    if (gsUpdated) {
      await gsStorage.saveStorage('session', 'gsUpdated', gsUpdated);
    }
  }

  // This function is used only for testing
  async function triggerDiscardOfAllTabs() {
    await new Promise(resolve => {
      chrome.tabs.query({ active: false, discarded: false }, function(tabs) {
        for (let i = 0; i < tabs.length; ++i) {
          if (tabs[i] === undefined || gsUtils.isSpecialTab(tabs[i])) {
            continue;
          }
          gsTabDiscardManager.queueTabForDiscard(tabs[i]);
        }
        resolve();
      });
    });
  }

  async function checkForCrashRecovery(currentSessionTabs) {
    gsUtils.log( 'gsSession', 'Checking for crash recovery: ' + new Date().toISOString() );

    //try to detect whether the extension has crashed as apposed to chrome restarting
    //if it is an extension crash, then in theory all suspended tabs will be gone
    //and all normal tabs will still exist with the same ids
    const currentSessionSuspendedTabs = currentSessionTabs.filter(
      tab => !gsUtils.isSpecialTab(tab) && gsUtils.isSuspendedTab(tab),
    );
    const currentSessionNonExtensionTabs = currentSessionTabs.filter(
      o => o.url.indexOf(chrome.runtime.id) === -1,
    );

    if (currentSessionSuspendedTabs.length > 0) {
      gsUtils.log(
        'gsSession',
        'Aborting tab recovery. Browser has open suspended tabs.' +
        ' Assuming user has "On start-up -> Continue where you left off" set' +
        ' or is restarting with suspended pinned tabs.',
      );
      return false;
    }

    const lastSession = await gsIndexedDb.fetchLastSession();
    if (!lastSession) {
      gsUtils.log( 'gsSession', 'Aborting tab recovery. Could not find last session.' );
      return false;
    }
    gsUtils.log('gsSession', 'lastSession: ', lastSession);

    const lastSessionTabs = lastSession.windows.reduce(
      (a, o) => a.concat(o.tabs),
      [],
    );
    const lastSessionSuspendedTabs = lastSessionTabs.filter(o =>
      gsUtils.isSuspendedTab(o),
    );
    const lastSessionNonExtensionTabs = lastSessionTabs.filter(
      o => o.url.indexOf(chrome.runtime.id) === -1,
    );

    if (lastSessionSuspendedTabs.length === 0) {
      gsUtils.log( 'gsSession', 'Aborting tab recovery. Last session contained no suspended tabs.' );
      return false;
    }

    // Match against all tabIds from last session here, not just non-extension tabs
    // as there is a chance during tabInitialisation of a suspended tab getting reloaded
    // directly and hence keeping its tabId (ie: file:// tabs)
    function matchingTabExists(tab) {
      if (tab.url.indexOf('chrome://newtab') === 0 && tab.index === 0)
        return false;
      return lastSessionTabs.some(o => o.id === tab.id && o.url === tab.url);
    }

    const matchingTabIdsCount = currentSessionNonExtensionTabs.reduce(
      (a, o) => (matchingTabExists(o) ? a + 1 : a),
      0,
    );
    const maxMatchableTabsCount = Math.max(
      lastSessionNonExtensionTabs.length,
      currentSessionNonExtensionTabs.length,
    );
    gsUtils.log( 'gsSession', matchingTabIdsCount + ' / ' + maxMatchableTabsCount + ' tabs have the same id between the last session and the current session.' );
    if (
      matchingTabIdsCount === 0 ||
      maxMatchableTabsCount - matchingTabIdsCount > 1
    ) {
      gsUtils.log('gsSession', 'Aborting tab recovery. Tab IDs do not match.');
      return false;
    }

    return true;
  }

  async function recoverLostTabs() {
    const lastSession = await gsIndexedDb.fetchLastSession();
    if (!lastSession) {
      return;
    }

    const recoveryStartTime = Date.now();
    gsUtils.log('gsSession',`

    ------------------------------------------------
    Recovery mode started.
    ------------------------------------------------
    `);
    gsUtils.log('gsSession', 'lastSession: ', lastSession);
    gsUtils.removeInternalUrlsFromSession(lastSession);

    const currentWindows = await gsChrome.windowsGetAll();
    const matchedCurrentWindowBySessionWindowId = matchCurrentWindowsWithLastSessionWindows( lastSession.windows, currentWindows );

    //attempt to automatically restore any lost tabs/windows in their proper positions
    const lastFocusedWindow = await gsChrome.windowsGetLastFocused();
    const lastFocusedWindowId = lastFocusedWindow ? lastFocusedWindow.id : null;
    for (let sessionWindow of lastSession.windows) {
      const matchedCurrentWindow = matchedCurrentWindowBySessionWindowId[sessionWindow.id];
      await restoreSessionWindow(sessionWindow, matchedCurrentWindow, lastSession.tabGroups, 0);
    }
    if (lastFocusedWindowId) {
      await gsChrome.windowsUpdate(lastFocusedWindowId, { focused: true });
    }

    const startupRecoveryTimeTakenInSeconds = parseInt( (Date.now() - recoveryStartTime) / 1000 );
    gsUtils.log('gsSession', `

    ------------------------------------------------
    Recovery mode finished. Time taken: ${startupRecoveryTimeTakenInSeconds} sec
    ------------------------------------------------
    `);
    updateCurrentSession(); //async
  }

  //try to match session windows with currently open windows
  function matchCurrentWindowsWithLastSessionWindows( unmatchedSessionWindows, unmatchedCurrentWindows ) {
    const matchedCurrentWindowBySessionWindowId = {};

    //if there is a current window open that matches the id of the session window id then match it
    unmatchedSessionWindows.slice().forEach(function(sessionWindow) {
      const matchingCurrentWindow = unmatchedCurrentWindows.find(function( window ) {
        return window.id === sessionWindow.id;
      });
      if (matchingCurrentWindow) {
        matchedCurrentWindowBySessionWindowId[ sessionWindow.id ] = matchingCurrentWindow;
        //remove from unmatchedSessionWindows and unmatchedCurrentWindows
        unmatchedSessionWindows = unmatchedSessionWindows.filter(function( window ) {
          return window.id !== sessionWindow.id;
        });
        unmatchedCurrentWindows = unmatchedCurrentWindows.filter(function( window ) {
          return window.id !== matchingCurrentWindow.id;
        });
      }
    });

    if ( unmatchedSessionWindows.length === 0 || unmatchedCurrentWindows.length === 0 ) {
      return matchedCurrentWindowBySessionWindowId;
    }

    //if we still have session windows that haven't been matched to a current window then attempt matching based on tab urls
    let tabMatchingObjects = generateTabMatchingObjects( unmatchedSessionWindows, unmatchedCurrentWindows );

    //find the tab matching objects with the highest tabMatchCounts
    while ( unmatchedSessionWindows.length > 0 && unmatchedCurrentWindows.length > 0 ) {
      const maxTabMatchCount = Math.max(
        ...tabMatchingObjects.map(function(o) {
          return o.tabMatchCount;
        }),
      );
      const bestTabMatchingObject = tabMatchingObjects.find(function(o) {
        return o.tabMatchCount === maxTabMatchCount;
      });

      matchedCurrentWindowBySessionWindowId[ bestTabMatchingObject.sessionWindow.id ] = bestTabMatchingObject.currentWindow;

      //remove from unmatchedSessionWindows and unmatchedCurrentWindows
      const unmatchedSessionWindowsLengthBefore = unmatchedSessionWindows.length;
      unmatchedSessionWindows = unmatchedSessionWindows.filter(function( window ) {
        return window.id !== bestTabMatchingObject.sessionWindow.id;
      });
      unmatchedCurrentWindows = unmatchedCurrentWindows.filter(function( window ) {
        return window.id !== bestTabMatchingObject.currentWindow.id;
      });
      gsUtils.log( 'gsUtils', 'Matched with tab count of ' + maxTabMatchCount, bestTabMatchingObject.sessionWindow, bestTabMatchingObject.currentWindow );

      //remove from tabMatchingObjects
      tabMatchingObjects = tabMatchingObjects.filter(function(o) {
        return (
          (o.sessionWindow !== bestTabMatchingObject.sessionWindow) &
          (o.currentWindow !== bestTabMatchingObject.currentWindow)
        );
      });

      //safety check to make sure we dont get stuck in infinite loop. should never happen though.
      if ( unmatchedSessionWindows.length >= unmatchedSessionWindowsLengthBefore ) {
        break;
      }
    }

    return matchedCurrentWindowBySessionWindowId;
  }

  function generateTabMatchingObjects(sessionWindows, currentWindows) {
    const unsuspendedSessionUrlsByWindowId = {};
    sessionWindows.forEach(function(sessionWindow) {
      unsuspendedSessionUrlsByWindowId[sessionWindow.id] = [];
      sessionWindow.tabs.forEach(function(curTab) {
        if (gsUtils.isNormalTab(curTab)) {
          unsuspendedSessionUrlsByWindowId[sessionWindow.id].push(curTab.url);
        }
      });
    });
    const unsuspendedCurrentUrlsByWindowId = {};
    currentWindows.forEach(function(currentWindow) {
      unsuspendedCurrentUrlsByWindowId[currentWindow.id] = [];
      currentWindow.tabs.forEach(function(curTab) {
        if (gsUtils.isNormalTab(curTab)) {
          unsuspendedCurrentUrlsByWindowId[currentWindow.id].push(curTab.url);
        }
      });
    });

    const tabMatchingObjects = [];
    sessionWindows.forEach(function(sessionWindow) {
      currentWindows.forEach(function(currentWindow) {
        const unsuspendedSessionUrls =
          unsuspendedSessionUrlsByWindowId[sessionWindow.id];
        const unsuspendedCurrentUrls =
          unsuspendedCurrentUrlsByWindowId[currentWindow.id];
        const matchCount = unsuspendedCurrentUrls.filter(function(url) {
          return unsuspendedSessionUrls.includes(url);
        }).length;
        tabMatchingObjects.push({
          tabMatchCount: matchCount,
          sessionWindow: sessionWindow,
          currentWindow: currentWindow,
        });
      });
    });

    return tabMatchingObjects;
  }

  // suspendMode controls whether the tabs are restored as suspended or unsuspended
  // 0: Leave the urls as they are (suspended stay suspended, ussuspended stay unsuspended)
  // 1: Open all unsuspended tabs as suspended
  // 2: Open all suspended tabs as unsuspended
  async function restoreSessionWindow( sessionWindow, existingWindow, sessionTabGroups, suspendMode ) {

    if (sessionWindow.tabs.length === 0) {
      gsUtils.log('gsUtils', 'SessionWindow contains no tabs to restore');
    }

    const delay       = 1000 / tabsToRestorePerSecond;
    const tabPromises = [];

    let   targetWindowId;
    let   placeholderTab;

    if (existingWindow) {
      // if we have been provided with a current window to recover into
      gsUtils.log( 'gsUtils', 'Restoring into existingWindow: ', sessionWindow, existingWindow );

      const currentTabIds   = [];
      const currentTabUrls  = [];
      for (const currentTab of existingWindow.tabs) {
        currentTabIds.push(currentTab.id);
        currentTabUrls.push(currentTab.url);
      }

      for (const [i, sessionTab] of sessionWindow.tabs.entries()) {
        //if current tab does not exist then recreate it
        if ( !gsUtils.isSpecialTab(sessionTab) && !currentTabUrls.includes(sessionTab.url) && !currentTabIds.includes(sessionTab.id) ) {
          tabPromises.push(
            createNewTabAsPromised({ delay: i * delay, windowId: existingWindow.id, index: sessionTab.index, sessionTab, suspendMode })
          );
        }
      }
      targetWindowId = existingWindow.id;
    }
    else {
      // else restore entire window
      gsUtils.log( 'gsUtils', 'Restoring into new sessionWindow: ', sessionWindow, );

      // Create new window. Important: do not pass in all urls to chrome.windows.create
      // If you load too many windows (or tabs?) like this, then it seems to blow
      // out the GPU memory in the chrome task manager
      // TODO: Report chrome bug
      const restoringUrl    = chrome.runtime.getURL('restoring-window.html');
      const newWindow       = await gsUtils.createWindowAndWaitForFinishLoading( { url: restoringUrl, focused: false }, 500 );
      placeholderTab        = newWindow.tabs[0];
      await gsChrome.tabsUpdate(placeholderTab.id, { pinned: true });

      for (const [i, sessionTab] of sessionWindow.tabs.entries()) {
        tabPromises.push(
          createNewTabAsPromised({ delay: i * delay, windowId: newWindow.id, index: i + 1, sessionTab, suspendMode })
        );
      }
      targetWindowId = newWindow.id;
    }

    // gsUtils.log('gsSession', 'restoreSessionWindow before Promise.all', tabPromises.length);
    const allNewTabs = await Promise.all(tabPromises);
    // gsUtils.log('gsSession', 'restoreSessionWindow after  Promise.all', allNewTabs);

    if (placeholderTab) {
      await gsChrome.tabsRemove(placeholderTab.id);
    }

    // After all tabs have been created, we can assign them to groups
    // We can't create groups on the fly because the new tabs are asynchronous and they'll all create unique groups
    // tabPromises.length = 0;
    const currentTabGroupsMap = await gsChrome.tabGroupsMap();
    const sessionTabGroupsMap = await gsChrome.tabGroupsMap(sessionTabGroups);
    const groupDelay          = 1000 / tabsToGroupPerSecond;
    for (const pair of allNewTabs) {
      await gsUtils.setTimeout(groupDelay);
      await assignTabGroupFromSession(targetWindowId, pair.newTab.id, pair.sessionTab.groupId, currentTabGroupsMap, sessionTabGroupsMap);
    }

  }

  /**
   * @param { {
   *    delay       : number
   *    windowId    : number
   *    index       : number
   *    index       : number
   *    suspendMode : number
   *    sessionTab  : chrome.tabs.Tab
   * } }
   * @returns { Promise<{ sessionTab: chrome.tabs.Tab, newTab: chrome.tabs.Tab }> }
   */
  async function createNewTabAsPromised({ delay, windowId, index, sessionTab, suspendMode }) {
    return new Promise(async (resolve) => {
      await gsUtils.setTimeout(delay);
      const newTab = await createNewTabFromSessionTab( sessionTab, windowId, index, suspendMode );
      resolve({sessionTab, newTab});
    });
  }

  /**
   * @param { number } windowId
   * @param { number } newTabId
   * @param { number } sessionTabGroupId
   * @param { Record<number, chrome.tabGroups.TabGroup> } currentTabGroupsMap
   * @param { Record<number, chrome.tabGroups.TabGroup> } sessionTabGroupsMap
   */
  async function assignTabGroupFromSession(windowId, newTabId, sessionTabGroupId, currentTabGroupsMap, sessionTabGroupsMap) {
    // gsUtils.log('gsUtils', 'assignTabGroupFromSession', newTabId, sessionTabGroupId, currentTabGroupsMap, sessionTabGroupsMap );
    if (sessionTabGroupId > 0) {

        /** @type chrome.tabGroups.TabGroup */
      const sessionTabGroupFromCurrentMap = currentTabGroupsMap[sessionTabGroupId];
      if (sessionTabGroupFromCurrentMap) {
        // The session tab group id exists in the current set, so use it!
        // gsUtils.log('gsUtils', 'assignTabGroupFromSession add to existing group', sessionTabGroupFromCurrentMap.title );
        await gsChrome.tabsGroup([newTabId], windowId, sessionTabGroupFromCurrentMap.id);
      }
      else {
        // The session tab group id does not exist
        // So, assign the tab to a new group
        const newGroupId = await gsChrome.tabsGroup([newTabId], windowId);
        // gsUtils.log('gsUtils', 'assignTabGroupFromSession newGroupId', newGroupId );
        // Then, style the group
        /** @type chrome.tabGroups.TabGroup */
        const sessionTabGroup = sessionTabGroupsMap[sessionTabGroupId];
        await gsChrome.tabGroupsUpdate(newGroupId, {
          collapsed : sessionTabGroup.collapsed,
          color     : sessionTabGroup.color,
          title     : sessionTabGroup.title,
        });
        // Finally we Map the sessionTabGroupId to the newGroupId, so any other tabs with sessionTabGroupId are grouped together
        sessionTabGroup.id = newGroupId;
        currentTabGroupsMap[sessionTabGroupId] = sessionTabGroup;
        // NOTE: We do not group simply by name / title here, as they are not unique
      }

    }
  }

  async function createNewTabFromSessionTab( sessionTab, windowId, index, suspendMode ) {
    let url = sessionTab.url;
    if (suspendMode === 1 && gsUtils.isNormalTab(sessionTab)) {
      url = gsUtils.generateSuspendedUrl(sessionTab.url, sessionTab.title);
    } else if (suspendMode === 2 && gsUtils.isSuspendedTab(sessionTab)) {
      url = gsUtils.getOriginalUrl(sessionTab.url);
    }
    const newTab = await gsChrome.tabsCreate({ windowId: windowId, url: url, index: index, pinned: sessionTab.pinned, active: false });

    // gsUtils.log('gsUtils', 'createNewTabFromSessionTab sessionTab', sessionTab );
    // gsUtils.log('gsUtils', 'createNewTabFromSessionTab newTab', newTab );

    // Update recovery view (if it exists)
    // const contexts = await tgs.getInternalContextsByViewName('recovery');
    // for (const context of contexts) {
    //   // chrome.tabs.sendMessage(context.tabId, { action: 'updateCommand', tabId: context.tabId });
    //   // @TODO update recovery page to receive a message instead of this direct call
    //   // view.exports.removeTabFromList(newTab);
    // }
    return newTab;
  }

  async function unsuspendActiveTabInEachWindow() {
    const activeTabs = await gsChrome.tabsQuery({ active: true });
    const suspendedActiveTabs = activeTabs.filter(tab =>
      gsUtils.isSuspendedTab(tab),
    );
    if (suspendedActiveTabs.length === 0) {
      return;
    }
    for (const suspendedActiveTab of suspendedActiveTabs) {
      await tgs.unsuspendTab(suspendedActiveTab);
    }
    await gsUtils.setTimeout(1000);
    await unsuspendActiveTabInEachWindow();
  }

  return {
    initAsPromised,
    runStartupChecks,
    getSessionId,
    buildCurrentSession,
    updateCurrentSession,
    isInitialising,
    isUpdated,
    isFileUrlsAccessAllowed,
    setSynchedSettingsOnInit,
    recoverLostTabs,
    triggerDiscardOfAllTabs,
    restoreSessionWindow,
    prepareForUpdate,
    getUpdateType,
    unsuspendActiveTabInEachWindow,
  };
})();
