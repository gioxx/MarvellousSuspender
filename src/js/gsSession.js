// @ts-check
import  { gsChrome }              from './gsChrome.js';
import  { gsIndexedDb }           from './gsIndexedDb.js';
import  { gsMascot }              from './gsMascot.js';
import  { gsStorage }             from './gsStorage.js';
import  { gsTabCheckManager }     from './gsTabCheckManager.js';
import  { gsTabDiscardManager }   from './gsTabDiscardManager.js';
import  { gsUtils }               from './gsUtils.js';
import  { tgs }                   from './tgs.js';

export const gsSession = (function() {

  const tabsToRestorePerSecond  = 15;
  const tabsToGroupPerSecond    = 50;

  const updateUrl   = chrome.runtime.getURL('update.html');
  const updatedUrl  = chrome.runtime.getURL('updated.html');

  let fileUrlsAccessAllowed = false;

  // Favicon-repair backstop (#474). The startup favicon pass (runStartupChecks ->
  // performTabChecks) can be skipped or cut short on Chromium forks whose onStartup is
  // unreliable, or lost to a service-worker recycle mid-run; background.js's
  // gsStartupOnceRun sentinel only records that startup was *attempted*. These keys track
  // the favicon pass specifically so an independent alarm/event backstop can retry it.
  const FAVICON_REPAIR_ALARM_NAME   = 'tms-favicon-repair-backstop';
  const FAVICON_REPAIR_DONE_KEY     = 'gsFaviconRepairDone';     // chrome.storage.session
  const FAVICON_REPAIR_ATTEMPTS_KEY = 'gsFaviconRepairAttempts'; // chrome.storage.session
  const FAVICON_REPAIR_MAX_ATTEMPTS = 3;
  let _faviconRepairInFlight = false; // per-service-worker-instance re-entry guard only

  async function initAsPromised() {
    // Set fileUrlsAccessAllowed to determine if extension can work on file:// URLs
    await new Promise((resolve) => {
      chrome.extension.isAllowedFileSchemeAccess((isAllowedAccess) => {
        fileUrlsAccessAllowed = isAllowedAccess;
        resolve(null);
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

      // show update message in suspended.html page
      // await gsStorage.setOptionAndSync(gsStorage.UPDATE_AVAILABLE, true);

      if (!sessionRestorePoint) {
        await gsChrome.tabsCreate(updateUrl);
      }

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

    // performTabChecks() here doubles as this browser session's first favicon-repair pass.
    // Hold the shared _faviconRepairInFlight guard across it and the verify below so a
    // ~30s backstop alarm or an onActivated firing mid-startup can't launch a second,
    // concurrent performTabChecks() (gsTabQueue would let that start another executor for
    // a tab already in progress). If a backstop trigger got here first, its pass already
    // covers startup's responsiveness check and records the favicon outcome, so skip both.
    const ranStartupFaviconPass = !_faviconRepairInFlight;
    if (ranStartupFaviconPass) _faviconRepairInFlight = true;
    try {
      if (ranStartupFaviconPass) {
        await performTabChecks();
      }

      // Ensure currently focused tab is initialised correctly if suspended
      const currentWindowActiveTabs = await gsChrome.tabsQuery({ active: true, currentWindow: true, });
      if (currentWindowActiveTabs.length > 0) {
        gsTabCheckManager.queueTabCheck(currentWindowActiveTabs[0]);
      }

      updateCurrentSession(); //async
      await gsStorage.saveStorage('session', 'gsInitialisationMode', false);

      // Record whether the pass cleared the repairable favicons, so the backstop
      // (background.js) stands down on installs where onStartup already works. After
      // gsInitialisationMode is cleared: this only reads favicons and writes session
      // flags, and its settle delay shouldn't extend initialisation mode.
      if (ranStartupFaviconPass && !(await gsStorage.getStorage('session', FAVICON_REPAIR_DONE_KEY))) {
        await recordFaviconRepairAttemptAndVerify('startupChecks');
      }
    }
    finally {
      if (ranStartupFaviconPass) _faviconRepairInFlight = false;
    }
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

    const startupTabCheckTimeTakenInSeconds = Math.floor( (Date.now() - initStartTime) / 1000 );
    gsUtils.log('gsSession',`

    ------------------------------------------------
    Checking tabs finished. Time taken: ${startupTabCheckTimeTakenInSeconds} sec
    ${successfulTabChecksCount} / ${totalTabCheckCount} initialised successfully
    ------------------------------------------------
    `);

    return { total: totalTabCheckCount, successful: successfulTabChecksCount };
  }

  // Count open suspended tabs whose favicon is one performTabChecks() can actually fix:
  // missing (favEmpty) or the TMS extension icon (favExtension, the #474 symptom). A
  // valid-but-generic data: favicon (favDefault) is a separate known limitation handled
  // by Tab Health, so it is deliberately not counted here. gsMascot.resolveBothUrls()
  // matches both the current and the legacy-mascot extension-icon URL regardless of the
  // gsLegacyMascot setting: a tab can still carry the other variant after the option was
  // toggled, and gsFavicon's repair path rejects both to match.
  async function countTabsWithBrokenSuspendedFavicon() {
    const extensionFaviconUrls = gsMascot.resolveBothUrls('img/ic_suspendy_16x16.webp');
    const tabs = await gsChrome.tabsQuery();
    let broken = 0;
    for (const tab of tabs) {
      if (!gsUtils.isSuspendedTab(tab)) continue;
      const fav = tab.favIconUrl;
      if (!fav || extensionFaviconUrls.includes(fav)) broken++;
    }
    return broken;
  }

  // Shared tail for every favicon-repair trigger: give Chrome a moment to surface the
  // refreshed favIconUrls, then decide whether the session is repaired, should retry, or
  // has exhausted its retries. Does NOT run performTabChecks() itself.
  async function verifyAndRecordFaviconRepair(reason) {
    await gsUtils.setTimeout(1500);
    const brokenCount = await countTabsWithBrokenSuspendedFavicon();
    const attempts = Number(await gsStorage.getStorage('session', FAVICON_REPAIR_ATTEMPTS_KEY)) || 0;

    if (brokenCount === 0) {
      await gsStorage.saveStorage('session', FAVICON_REPAIR_DONE_KEY, true);
      chrome.alarms.clear(FAVICON_REPAIR_ALARM_NAME);
      gsUtils.log('gsSession', `favicon repair (${reason}): all suspended-tab favicons OK`);
    }
    else if (attempts >= FAVICON_REPAIR_MAX_ATTEMPTS) {
      // Stop auto-retrying; the #449 "Repair favicons now" debug action stays available.
      await gsStorage.saveStorage('session', FAVICON_REPAIR_DONE_KEY, true);
      chrome.alarms.clear(FAVICON_REPAIR_ALARM_NAME);
      gsUtils.warning('gsSession', `favicon repair (${reason}): ${brokenCount} tab(s) still broken after ${attempts} attempts; stopping auto-retry`);
    }
    else {
      gsUtils.log('gsSession', `favicon repair (${reason}): ${brokenCount} tab(s) still broken, backstop will retry`);
      // FAVICON_REPAIR_DONE_KEY left unset -> next service-worker spawn re-arms the alarm.
    }
  }

  // Cap-check, attempt bookkeeping, optional repair pass, then verify. Assumes the caller
  // already holds _faviconRepairInFlight and has confirmed FAVICON_REPAIR_DONE_KEY is
  // unset. `runPass` false is for runStartupChecks(), which has just run performTabChecks()
  // itself under the same guard and only needs the verify-and-record tail.
  async function recordFaviconRepairAttemptAndVerify(reason, { runPass = false } = {}) {
    const priorAttempts = Number(await gsStorage.getStorage('session', FAVICON_REPAIR_ATTEMPTS_KEY)) || 0;
    // Hard cap at entry, not just inside verifyAndRecordFaviconRepair(): if a prior run
    // persisted its attempt count but never reached verification (service-worker recycled
    // mid-pass, or performTabChecks() threw), nothing set the done flag, and without this
    // check every later spawn would launch another full scan indefinitely.
    if (priorAttempts >= FAVICON_REPAIR_MAX_ATTEMPTS) {
      await gsStorage.saveStorage('session', FAVICON_REPAIR_DONE_KEY, true);
      chrome.alarms.clear(FAVICON_REPAIR_ALARM_NAME);
      gsUtils.warning('gsSession', `favicon repair (${reason}): ${priorAttempts} attempts already spent this session, standing down (use "Repair favicons now")`);
      return;
    }

    const attempts = priorAttempts + 1;
    await gsStorage.saveStorage('session', FAVICON_REPAIR_ATTEMPTS_KEY, attempts);
    gsUtils.log('gsSession', `favicon repair: reason=${reason}, attempt ${attempts}${runPass ? '' : ' (verify only)'}`);
    if (runPass) await performTabChecks();
    await verifyAndRecordFaviconRepair(reason);
  }

  // onStartup-independent backstop for the favicon pass, for the alarm and onActivated
  // triggers. Idempotent and cheap: a no-op once FAVICON_REPAIR_DONE_KEY is set (so
  // installs where onStartup works see no extra work), serialised against
  // runStartupChecks() and against each other by _faviconRepairInFlight, and bounded by
  // FAVICON_REPAIR_MAX_ATTEMPTS.
  async function ensureFaviconRepairForSession(reason) {
    // Claim the guard synchronously, before the first await: two triggers arriving close
    // together (e.g. the alarm and an onActivated) would otherwise both see it false,
    // both suspend on the storage read, and both resume into a full pass.
    if (_faviconRepairInFlight) return;
    _faviconRepairInFlight = true;
    try {
      if (await gsStorage.getStorage('session', FAVICON_REPAIR_DONE_KEY)) return;
      await recordFaviconRepairAttemptAndVerify(reason, { runPass: true });
    }
    catch (error) {
      gsUtils.error('gsSession', 'ensureFaviconRepairForSession failed', error);
    }
    finally {
      _faviconRepairInFlight = false;
    }
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
    const shouldRecoverTabs = await checkForCrashRecovery(currentSessionTabs);
    let gsUpdated = false;
    if (shouldRecoverTabs) {
      await gsUtils.createTabAndWaitForFinishLoading(updatedUrl, 10000);

      await recoverLostTabs();
      gsUpdated = true;

      //update updated views
      const contexts = await gsChrome.contextsGetByViewName('updated');
      if (contexts.length > 0) {
        for (const context of contexts) {
          if (context.tabId) {
            chrome.tabs.sendMessage(context.tabId, { action: 'toggleUpdated', tabId: context.tabId });
          }
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
        resolve(null);
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
    // We can't match directly for chrome://newtab any more, since we have lots of chromium browsers using alternate internal protocol strings
    /**
     * @param {chrome.tabs.Tab} tab
     * @returns {boolean}
     */
    function matchingTabExists(tab) {
      const url = String(tab.url);
      if (tab.index === 0 && !(url.match(/^(file|http|https):\/\//i)) && url.match(/:\/\/newtab/i)) return false;
      return lastSessionTabs.some((o) => o.id === tab.id && o.url === tab.url);
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

    const startupRecoveryTimeTakenInSeconds = Math.floor( (Date.now() - recoveryStartTime) / 1000 );
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
          (o.sessionWindow !== bestTabMatchingObject.sessionWindow) &&
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
  // 0: Leave the urls as they are (suspended stay suspended, unsuspended stay unsuspended)
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
      const newTabId = pair.newTab?.id;
      if (newTabId) {
        await gsUtils.setTimeout(groupDelay);
        await assignTabGroupFromSession(targetWindowId, newTabId, pair.sessionTab.groupId, currentTabGroupsMap, sessionTabGroupsMap);
      }
    }

  }

  /**
   * @param { {
   *    delay       : number
   *    windowId    : number
   *    index       : number
   *    sessionTab  : chrome.tabs.Tab
   *    suspendMode : number
   * } } param
   * @returns { Promise<{ sessionTab: chrome.tabs.Tab, newTab: chrome.tabs.Tab | null }> }
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
    // const contexts = await gsChrome.contextsGetByViewName('recovery');
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
    performTabChecks,
    ensureFaviconRepairForSession,
    FAVICON_REPAIR_ALARM_NAME,
  };
})();
