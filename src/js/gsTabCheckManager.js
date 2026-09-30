// @ts-check
import  { gsChrome }              from './gsChrome.js';
import  { gsMessages }            from './gsMessages.js';
import  { gsSession }             from './gsSession.js';
import  { gsStorage }             from './gsStorage.js';
import  { gsTabDiscardManager }   from './gsTabDiscardManager.js';
import  { gsTabQueue }            from './gsTabQueue.js';
import  { gsUtils }               from './gsUtils.js';
import  { tgs }                   from './tgs.js';

export const gsTabCheckManager = (function() {

  const DEFAULT_CONCURRENT_TAB_CHECKS = 3;
  const DEFAULT_TAB_CHECK_TIMEOUT = 60 * 1000;
  const DEFAULT_TAB_CHECK_PROCESSING_DELAY = 500;
  const DEFAULT_TAB_CHECK_REQUEUE_DELAY = 3 * 1000;
  const INITIAL_TAB_CHECK_BUDGET = 15 * 1000;
  const SUSPENDED_MESSAGE_TIMEOUT = 5 * 1000;
  const LATE_DISCARD_ATTEMPTS = 3;
  // An attempt started just before the startup deadline can still await two page messages.
  const INITIAL_TAB_CHECK_WAIT_GRACE = 2 * SUSPENDED_MESSAGE_TIMEOUT;
  const MESSAGE_TIMED_OUT = Symbol('suspended tab message timed out');

  const QUEUE_ID = 'checkQueue';
  const _defaultTabTitle = chrome.i18n.getMessage('html_suspended_title');

  let   _tabCheckQueue;
  // Suspended tabs a running startup pass will still check itself (#523).
  const _startupReservedTabIds = new Set();
  const INIT_RESOLVERS = [];

  // NOTE: This mainly checks suspended tabs
  // For unsuspended tabs, there is no guarantee that the content script will
  // be responsive, but seeing as the timer is kept by the background script, it
  // doesn't really matter.
  // However, when a tab gains focus, there is a check to make sure the content
  // script is responsive, as we then need to rely on the form input and scroll behavior.
  function initAsPromised() {
    gsUtils.log('gsTabCheckManager initAsPromised', _tabCheckQueue);
    return new Promise((resolve) => {
      const queueProps = {
        concurrentExecutors: DEFAULT_CONCURRENT_TAB_CHECKS,
        jobTimeout: DEFAULT_TAB_CHECK_TIMEOUT,
        processingDelay: DEFAULT_TAB_CHECK_PROCESSING_DELAY,
        executorFn: handleTabCheck,
        exceptionFn: handleTabCheckException,
      };
      _tabCheckQueue = gsTabQueue.init(QUEUE_ID, queueProps);
      gsUtils.log(QUEUE_ID, 'init successful');

      let resolveFn;
      while ((resolveFn = INIT_RESOLVERS.pop())) {
        resolveFn();
      }

      resolve(null);
    });
  }

  /** @returns { Promise<void> } */
  async function queueInitialized() {
    return new Promise((resolve) => {
      if (_tabCheckQueue) { resolve(); return; }
      INIT_RESOLVERS.push(resolve);     // otherwise, push our resolve function into a queue that will be processed after initialization
    });
  }

  // Suspended tabs that exist or are created before the end of extension
  // initialisation will need to be initialised by this startup script
  async function performInitialisationTabChecks(tabs) {
    // Queue concurrency counts executing attempts, not pages waiting for a reload.
    // Keep at most three whole checks outstanding, including their requeues (#523).
    const suspendedTabs = tabs.filter((tab) => gsUtils.isSuspendedTab(tab));
    const results = new Array(suspendedTabs.length);
    const pending = suspendedTabs.map((tab, index) => ({ tab, index }));
    // Reserve the whole set up front: a restored page loading before its worker reaches it
    // must not get an ordinary check from tgs.initialiseSuspendedTab() outside this budget.
    suspendedTabs.forEach((tab) => _startupReservedTabIds.add(tab.id));
    // Recover visible pages first, retaining input order in the returned results.
    pending.sort((a, b) => Number(b.tab.active) - Number(a.tab.active));
    let next = 0;
    async function checkNextTabs() {
      while (next < pending.length) {
        const { tab, index } = pending[next++];
        try {
          // The deadline starts at admission, not first execution: a request parked behind
          // an ordinary check already running for this tab must not get a fresh budget
          // when it is eventually promoted, nor hold this worker past it (#523).
          const initialDeadline = Date.now() + INITIAL_TAB_CHECK_BUDGET;
          results[index] = await waitUntil(
            queueTabCheckAsPromise(tab, { refetchTab: true, initialCheck: true, initialDeadline }),
            initialDeadline + INITIAL_TAB_CHECK_WAIT_GRACE,
            () => {
              gsUtils.log(tab.id, QUEUE_ID, 'Initial check still pending after its budget. Cancelling.');
              // Free its queue slot before admitting another tab. An executor still awaiting
              // a stalled API stops at its next isStartupCheckAbandoned() guard. A newer
              // request parked behind it (e.g. a focus check) is promoted, not dropped.
              if (getQueuedTabDetails(tab)?.executionProps.initialDeadline === initialDeadline) {
                _tabCheckQueue.unqueueTab(tab, { keepFollowUp: true });
              }
            }
          );
        }
        catch (error) {
          gsUtils.log(tab.id, QUEUE_ID, 'Initial tab check cancelled.', error);
          results[index] = gsUtils.STATUS_UNKNOWN;
        }
        finally {
          _startupReservedTabIds.delete(tab.id);
        }
      }
    }
    const tabUpdatedListener = getTabUpdatedListener();
    chrome.tabs.onUpdated.addListener(tabUpdatedListener);
    try {
      await Promise.all(Array.from({ length: DEFAULT_CONCURRENT_TAB_CHECKS }, checkNextTabs));
    }
    finally {
      chrome.tabs.onUpdated.removeListener(tabUpdatedListener);
      suspendedTabs.forEach((tab) => _startupReservedTabIds.delete(tab.id));
    }
    return results;
  }

  async function waitUntil(promise, deadline, onTimeout) {
    let timer;
    promise.catch(() => {}); // may settle after this wait has given up
    try {
      return await Promise.race([
        promise,
        new Promise((resolve) => {
          timer = setTimeout(() => {
            onTimeout();
            resolve(gsUtils.STATUS_UNKNOWN);
          }, Math.max(0, deadline - Date.now()));
        }),
      ]);
    }
    finally {
      clearTimeout(timer);
    }
  }

  function getTabUpdatedListener() {
    return (tabId, changeInfo, _tab) => {
      if (
        !gsUtils.isSuspendedTab(_tab) ||
        !changeInfo ||
        !changeInfo.hasOwnProperty('status') ||
        changeInfo.status !== 'complete'
      ) {
        return;
      }
      gsUtils.log(_tab.id, 'suspended tab loaded. status === complete');
      const tabQueueDetails = getQueuedTabDetails(_tab);
      // Only wake a check waiting between attempts. Queueing against an executing check
      // spawns a follow-up job outside the startup worker's budget and deadline (#523);
      // the running attempt refetches or requeues on its own.
      if (
        tabQueueDetails &&
        tabQueueDetails.status !== _tabCheckQueue.STATUS_IN_PROGRESS &&
        !tabQueueDetails.pendingFollowUp
      ) {
        // If tab is in check queue, then force it to continue processing immediately
        // This allows us to prevent a timeout -> fetch tab cycle
        tabQueueDetails.tab = _tab;
        // Only a wake-up: keep the queued check's own startup flags.
        queueTabCheck(_tab, { refetchTab: false, initialCheck: tabQueueDetails.executionProps.initialCheck }, 0);
      }
    };
  }

  function queueTabCheck(tab, executionProps, processingDelay) {
    queueTabCheckAsPromise(tab, executionProps, processingDelay).catch((e) => {
      gsUtils.log(tab.id, QUEUE_ID, e);
    });
  }

  async function queueTabCheckAsPromise(tab, executionProps, processingDelay) {
    await queueInitialized();
    if (!_tabCheckQueue) {
      gsUtils.warning(tab.id, QUEUE_ID, 'queueTabCheckAsPromise', 'Queue not initialized.  This should never fire.');
      return Promise.resolve(gsUtils.STATUS_UNKNOWN);
    }
    gsUtils.log(tab.id, QUEUE_ID, 'Queueing tab for responsiveness check.');
    executionProps = executionProps || {};
    // An ordinary request merging into a startup one (queued, or parked as a follow-up
    // behind a running check) must not inherit its startup budget: once expired, that
    // would resolve the merged request, e.g. a focus check, as unknown untried (#523).
    if (!executionProps.initialCheck) {
      executionProps = { ...executionProps, initialCheck: false, initialDeadline: undefined };
    }
    return _tabCheckQueue.queueTabAsPromise(tab, executionProps, processingDelay);
  }

  function unqueueTabCheck(tab) {
    if (!_tabCheckQueue) {
      gsUtils.warning(tab.id, QUEUE_ID, 'unqueueTabCheck', 'Queue not initialized.  This should never fire.');
      return;
    }
    const removed = _tabCheckQueue.unqueueTab(tab);
    if (removed) {
      gsUtils.log(tab.id, QUEUE_ID, 'Removed tab from check queue.');
    }
  }

  // True when a check is queued or running for the tab, or a startup pass will check it.
  function hasPendingTabCheck(tab) {
    return _startupReservedTabIds.has(tab.id) || Boolean(getQueuedTabDetails(tab));
  }

  function getQueuedTabDetails(tab) {
    if (!_tabCheckQueue) {
      gsUtils.warning(tab.id, QUEUE_ID, 'getQueuedTabDetails', 'Queue not initialized.  This should never fire.');
      return;
    }
    return _tabCheckQueue.getQueuedTabDetails(tab);
  }

  async function handleTabCheckException(tab, executionProps, exceptionType, resolve, reject, requeue) {
    gsUtils.warning(tab.id, QUEUE_ID, 'Failed to initialise tab', tab.url, exceptionType);
    resolve(false);
  }

  async function handleTabCheck(tab, executionProps, resolve, reject, requeue) {
    gsUtils.log(tab.id, QUEUE_ID, 'handleTabCheck', tab.url);
    if (executionProps.initialCheck) {
      executionProps.initialDeadline ??= Date.now() + INITIAL_TAB_CHECK_BUDGET;
      if (Date.now() >= executionProps.initialDeadline) {
        gsUtils.log(tab.id, QUEUE_ID, 'Initial check deferred until focus or the repair backstop.');
        resolve(gsUtils.STATUS_UNKNOWN);
        return;
      }
    }
    if (gsUtils.isSuspendedTab(tab)) {
      await checkSuspendedTab(tab, executionProps, resolve, reject, requeue);
    }
    else if (gsUtils.isNormalTab(tab)) {
      await checkNormalTab(tab, executionProps, resolve, reject, requeue);
    }
    else {
      resolve(gsUtils.STATUS_UNKNOWN);
    }
  }

  async function getUpdatedTab(tab) {
    const _tab = await gsChrome.tabsGet(tab.id);
    if (!_tab) {
      gsUtils.warning(tab.id, QUEUE_ID, 'Failed to initialize tab. Tab may have been discarded or removed.');
      // If we are still initialising, then check for potential discarded tab matches
      if (await gsSession.isInitialising()) {
        await queueTabCheckForPotentiallyDiscardedTabs(tab);
      }
    }
    return _tab;
  }

  async function queueTabCheckForPotentiallyDiscardedTabs(tab) {
    // NOTE: For some reason querying by url doesn't work here??
    // TODO: Report chrome bug
    let tabs = await gsChrome.tabsQuery({
      discarded: true,
      windowId: tab.windowId,
    });
    tabs = tabs.filter((o) => o.url === tab.url);
    gsUtils.log(tab.id, QUEUE_ID, 'Searching for discarded tab matching tab: ', tab);
    const matchingTab = tabs.find((o) => o.index === tab.index);
    if (matchingTab) {
      tabs = [matchingTab];
    }
    for (const tab of tabs) {
      await gsUtils.resuspendSuspendedTab(tab);
      queueTabCheck(tab, { refetchTab: true }, 2000);
    }
  }

  // A startup check its worker has given up on (and unqueued) may still be awaiting a
  // stalled browser API. It must not reload, navigate, initialise or discard the tab once
  // it resumes (#523).
  function isStartupCheckAbandoned(executionProps) {
    return Boolean(executionProps.initialCheck) &&
      Date.now() >= executionProps.initialDeadline + INITIAL_TAB_CHECK_WAIT_GRACE;
  }

  async function checkSuspendedTab(tab, executionProps, resolve, reject, requeue) {
    gsUtils.log(tab.id, QUEUE_ID, 'checkSuspendedTab', tab.url);
    const abandoned = () => {
      if (!isStartupCheckAbandoned(executionProps)) return false;
      gsUtils.log(tab.id, QUEUE_ID, 'Startup check abandoned. Skipping recovery work.');
      resolve(gsUtils.STATUS_UNKNOWN);
      return true;
    };
    if (executionProps.resuspend && !executionProps.resuspended) {
      if (abandoned()) return;
      await gsUtils.resuspendSuspendedTab(tab);
      // refetchTab so the next pass re-reads the tab after the resuspend reload rather
      // than trusting this now-stale snapshot (status, frozen, groupId can all have
      // changed). Matches the resuspend requeue in the missing-view branch below.
      requeue(DEFAULT_TAB_CHECK_REQUEUE_DELAY, {
        resuspended: true,
        refetchTab: true,
      });
      return;
    }

    if (executionProps.refetchTab) {
      gsUtils.log(tab.id, QUEUE_ID, 'Tab refetch requested. Getting updated tab..');
      tab = await getUpdatedTab(tab);
      if (!tab) {
        resolve(gsUtils.STATUS_UNKNOWN);
        return;
      }
      gsUtils.log(tab.id, QUEUE_ID, 'Updated tab: ', tab);

      // Ensure tab is still suspended
      if (!gsUtils.isSuspendedTab(tab)) {
        gsUtils.log(tab.id, QUEUE_ID, 'Tab is no longer suspended. Aborting check.');
        resolve(gsUtils.STATUS_UNKNOWN);
        return;
      }

    }

    // If tab is a file:// tab and file is blocked then unsuspend tab. Handled before the
    // frozen-tab shortcut below because this only navigates the tab (no message to the
    // page), so it must still run for a frozen blocked-file tab rather than being
    // pre-empted by that shortcut reporting it as a healthy suspended tab.
    await gsSession.ensureFileUrlsStateReady();
    if (!gsSession.isFileUrlsUsable()) {
      const url = tab.url || tab.pendingUrl;
      const originalUrl = gsUtils.getOriginalUrl(url);
      if (originalUrl && originalUrl.indexOf('file') === 0) {
        if (abandoned()) return;
        gsUtils.log(tab.id, QUEUE_ID, 'Unsuspending blocked local file tab.');
        await gsChrome.tabsUpdate(tab.id, { url: originalUrl });
        requeue(DEFAULT_TAB_CHECK_REQUEUE_DELAY, { refetchTab: true });
        return;
      }
    }

    // A discarded placeholder will initialise through onUpdated when activated. Waking
    // every discarded page here defeats the browser's lazy session restore (#523).
    if (tab.discarded && !tab.active) {
      resolve(gsUtils.STATUS_DISCARDED);
      return;
    }

    // A tab Chrome has frozen (MV3 tab freezing — common for background suspended tabs
    // during a busy cold start) can't answer the getSuspendInfo/initTab messages below:
    // the sendMessage just hangs until the 60s job timeout, which then logs a
    // "Failed to initialise tab … timeout" warning and gives up. Resolve it here instead
    // of stalling a queue slot on that timeout.
    //
    // A frozen tab isn't necessarily a fully initialised one — Chrome can freeze a
    // status:complete page before its initialiseSuspendedTab() work (title/favicon) has
    // run. But a frozen page can't establish those invariants until it thaws, and
    // requeuing until then would just hold performInitialisationTabChecks()'s Promise.all
    // pending (gsInitialisationMode stuck on) until the queue's ~5-minute requeue cap,
    // ending in the same timeout warning and failed tally this avoids. So resolve
    // STATUS_SUSPENDED either way — a still-blank frozen tab is repaired when it is next
    // focused (its own responsiveness check) or, for the favicon, by the #474 backstop.
    if (tab.frozen) {
      const logLine = ensureSuspendedTabTitleAndFaviconSet(tab)
        ? 'Tab is frozen but already initialised. Accepting without a responsiveness check.'
        : 'Tab is frozen before initialisation completed. Accepting; will be re-checked on focus / by the favicon backstop.';
      gsUtils.log(tab.id, QUEUE_ID, logLine);
      resolve(gsUtils.STATUS_SUSPENDED);
      return;
    }

    if (tab.status === 'loading') {
      requeue(DEFAULT_TAB_CHECK_REQUEUE_DELAY, { refetchTab: true });
      return;
    }

    // Make sure tab is registered as a 'view' of the extension
    if (!(await gsChrome.contextGetByTabId(tab.id))) {
      gsUtils.log(tab.id, QUEUE_ID, 'Could not find an internal view for suspended tab.', tab);
      if (abandoned()) return;
      if (!executionProps.resuspended) {
        const resuspendOk = await gsUtils.resuspendSuspendedTab(tab);
        if (resuspendOk) {
          requeue(DEFAULT_TAB_CHECK_REQUEUE_DELAY, { resuspended: true, refetchTab: true });
          return;
        }
        gsUtils.warning(tab.id, QUEUE_ID, 'Failed to resuspend tab');
        resolve(gsUtils.STATUS_UNKNOWN);
        return;
      }
      // Tab was reloaded but still has no active context.
      // Chrome's tab-group replacement bug can navigate the reload to chrome://newtab/
      // instead of restoring the suspended URL. Detect this and recreate the tab fresh.
      if (tab.groupId > 0) {
        const suspendedUrl = tab.url; // original URL before any reload
        const latestTab = await gsChrome.tabsGet(tab.id);
        if (latestTab && !gsUtils.isSuspendedTab(latestTab)) {
          const targetGroupId = latestTab.groupId > 0 ? latestTab.groupId : tab.groupId;
          const { windowId, index, pinned, active } = latestTab;
          const newTab = await gsChrome.tabsCreate({ windowId, url: suspendedUrl, index, pinned, active });
          if (newTab?.id) {
            await gsChrome.tabsGroup(newTab.id, windowId, targetGroupId);
            await gsChrome.tabsRemove(latestTab.id);
            resolve(gsUtils.STATUS_SUSPENDED);
            return;
          }
        }
      }
      // Queue a refresh as tab may no longer exist
      requeue(DEFAULT_TAB_CHECK_REQUEUE_DELAY, { refetchTab: true });
      return;
    }

    const attemptDiscarding =
      await gsStorage.getOption(gsStorage.DISCARD_AFTER_SUSPEND) &&
      !gsUtils.isDiscardedTab(tab) &&
      !(await tgs.isCurrentActiveTab(tab));
    let suspendInfo;
    try {
      suspendInfo = await sendSuspendedTabMessage(tab.id, { action: 'getSuspendInfo', tab }, executionProps.initialCheck);
    } catch (error) {
      if (error === MESSAGE_TIMED_OUT) {
        resolve(gsUtils.STATUS_UNKNOWN);
        return;
      }
      // No listener in the page: a lazily restored placeholder whose document never ran
      // (status 'complete', not discarded or frozen) looks like this. The Vivaldi URL
      // fallback in contextGetByTabId() still reports a view for it, so the missing-view
      // branch above is skipped and requeuing alone would never set title/favicon.
      // Reload it once, like that branch does; the queue's three slots bound the burst (#523).
      if (!executionProps.resuspended && isNoReceiverError(error)) {
        if (abandoned()) return;
        // The same error comes back if the tab navigated or was discarded after the refetch
        // above: only reload the page this check was looking at, still live and suspended.
        const latestTab = await gsChrome.tabsGet(tab.id);
        if (
          !latestTab ||
          latestTab.url !== tab.url ||
          !gsUtils.isSuspendedTab(latestTab) ||
          latestTab.discarded ||
          latestTab.frozen
        ) {
          gsUtils.log(tab.id, QUEUE_ID, 'Receiverless tab changed before reload. Requeueing.');
          requeue(DEFAULT_TAB_CHECK_REQUEUE_DELAY, { refetchTab: true });
          return;
        }
        if (abandoned()) return;
        gsUtils.log(tab.id, QUEUE_ID, 'Suspended tab has no message receiver. Resuspending.');
        if (await gsUtils.resuspendSuspendedTab(latestTab)) {
          requeue(DEFAULT_TAB_CHECK_REQUEUE_DELAY, { resuspended: true, refetchTab: true });
          return;
        }
      }
      gsUtils.log(tab.id, QUEUE_ID, 'Failed to get suspendInfo from tab. Will requeue with refetching.', error?.message ?? error);
      requeue(DEFAULT_TAB_CHECK_REQUEUE_DELAY, { refetchTab: true });
      return;
    }
    // chrome.tabs.sendMessage() can resolve with undefined instead of rejecting — e.g. if
    // the tab navigates/reloads in the narrow window between the message arriving and
    // sendResponse() being called — so a successful resolution isn't a guarantee of a
    // well-formed payload. Live testing found this reaching suspendInfo.sessionId below
    // as an uncaught "Cannot read properties of undefined", and since nothing in
    // gsTabQueue.js's processTab() caught it, the failure had been silently stranding
    // this job's queue slot for the full jobTimeout (up to 60s) instead of retrying
    // promptly like the caught-rejection case just above already does.
    if (!suspendInfo) {
      gsUtils.log(tab.id, QUEUE_ID, 'Got an empty suspendInfo from tab. Will requeue with refetching.');
      requeue(DEFAULT_TAB_CHECK_REQUEUE_DELAY, { refetchTab: true });
      return;
    }
    const tabSessionOk = suspendInfo.sessionId === (await gsSession.getSessionId());
    const tabBasicsOk = ensureSuspendedTabTitleAndFaviconSet(tab);
    const tabVisibleOk = attemptDiscarding || suspendInfo.isVisible;
    const tabChecksOk = tabSessionOk && tabBasicsOk && tabVisibleOk;

    let reinitialised = false;
    if (!tabChecksOk) {
      const tabQueueDetails = getQueuedTabDetails(tab);
      if (!tabQueueDetails) {
        resolve(gsUtils.STATUS_UNKNOWN);
        return;
      }
      // Read before the guard: a stalled storage lookup here must not let an abandoned
      // check send initTab once it resumes.
      const sessionId = await gsSession.getSessionId();
      if (abandoned()) return;
      try {
        gsUtils.log(tab.id, QUEUE_ID, 'Reinitialising suspendedTab: ', tab);
        // If we know that we will discard tab, then just perform a quick init
        const quickInit = attemptDiscarding && !tab.active;
        // initTab can legitimately outlast the deadline (settings, favicon storage). When
        // discarding is due, discard once it finishes so the page doesn't stay loaded.
        const onLateInit = attemptDiscarding ? () => discardAfterLateInit(tab) : undefined;
        await sendSuspendedTabMessage(tab.id, { action: 'initTab', tab, quickInit, sessionId }, executionProps.initialCheck, onLateInit);
        reinitialised = true;
      }
      catch (error) {
        if (error === MESSAGE_TIMED_OUT) {
          resolve(gsUtils.STATUS_UNKNOWN);
          return;
        }
        gsUtils.log(tab.id, QUEUE_ID, 'Failed to reinitialise suspendedTab. Will requeue with refetching.', error);
        requeue(DEFAULT_TAB_CHECK_REQUEUE_DELAY, { refetchTab: true });
        return;
      }
    }

    let discarded = false;
    if (attemptDiscarding) {
      // don't attempt discarding straight away if we have just reinitialised
      // as it seems to take the favicon a while to display and discarding prematurely
      // will break this process
      if (reinitialised) {
        requeue(DEFAULT_TAB_CHECK_REQUEUE_DELAY, { refetchTab: true });
        return;
      }
      if (abandoned()) return;
      discarded = await gsTabDiscardManager.queueTabForDiscardAsPromise(tab);
    }
    resolve(discarded ? gsUtils.STATUS_DISCARDED : gsUtils.STATUS_SUSPENDED);
  }

  // Discards directly rather than queueing another check: a check here would run outside
  // the startup budget that already gave up on this page (#523). Waits like the
  // post-reinitialise requeue does, so the favicon can settle before the discard.
  // Chrome can lag behind the page in reporting the new title/favicon, so a blank snapshot
  // is retried a few times before the discard is given up.
  function discardAfterLateInit(tab, attempt = 1) {
    setTimeout(async () => {
      if (!(await gsStorage.getOption(gsStorage.DISCARD_AFTER_SUSPEND))) return;
      const _tab = await gsChrome.tabsGet(tab.id);
      if (
        !_tab ||
        _tab.url !== tab.url ||
        !gsUtils.isSuspendedTab(_tab) ||
        gsUtils.isDiscardedTab(_tab) ||
        hasPendingTabCheck(_tab)
      ) {
        return;
      }
      // suspended.js answers even when initTab() failed; a blank page must not be discarded.
      if (!ensureSuspendedTabTitleAndFaviconSet(_tab)) {
        if (attempt < LATE_DISCARD_ATTEMPTS) discardAfterLateInit(tab, attempt + 1);
        return;
      }
      gsUtils.log(_tab.id, QUEUE_ID, 'Late initTab reply. Discarding suspended tab.');
      // The discard runs later: let it abort if the tab has navigated since this check.
      gsTabDiscardManager.queueTabForDiscard(_tab, { expectedUrl: _tab.url });
    }, DEFAULT_TAB_CHECK_REQUEUE_DELAY);
  }

  function isNoReceiverError(error) {
    return /Receiving end does not exist/i.test(error?.message ?? '');
  }

  // onLateResponse runs if the page answers after the deadline has already deferred the check.
  // Only startup checks get the short terminal deadline (#523). Ordinary checks (focus,
  // discard) keep waiting on the page, bounded by the queue's own job timeout.
  async function sendSuspendedTabMessage(tabId, message, bounded, onLateResponse) {
    if (!bounded) {
      return chrome.tabs.sendMessage(tabId, message);
    }
    let timer;
    let timedOut = false;
    const request = chrome.tabs.sendMessage(tabId, message);
    try {
      return await Promise.race([
        request,
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            gsUtils.warning(tabId, QUEUE_ID, 'Suspended tab message timed out; deferring check.', message.action);
            reject(MESSAGE_TIMED_OUT);
          }, SUSPENDED_MESSAGE_TIMEOUT);
        }),
      ]);
    }
    finally {
      clearTimeout(timer);
      if (timedOut && onLateResponse) {
        request.then(onLateResponse, () => {});
      }
    }
  }

  // function ensureSuspendedTabVisible(tabView) {
  //   if (!tabView) {
  //     return false;
  //   }
  //   const bodyEl = tabView.document.getElementsByTagName('body')[0];
  //   if (!bodyEl) {
  //     return false;
  //   }
  //   return !bodyEl.classList.contains('hide-initially');
  // }

  function ensureSuspendedTabTitleAndFaviconSet(tab) {
    if (!tab.favIconUrl || tab.favIconUrl.indexOf('data:image') !== 0) {
      gsUtils.log(tab.id, QUEUE_ID, 'Tab favicon not set or not dataUrl.', tab);
      return false;
    }
    if (!tab.title || tab.title === _defaultTabTitle) {
      gsUtils.log(tab.id, QUEUE_ID, 'Tab title not set', tab);
      return false;
    }
    return true;
  }

  async function checkNormalTab(tab, executionProps, resolve, reject, requeue) {
    gsUtils.log(tab.id, QUEUE_ID, 'checkNormalTab', tab.url);
    if (executionProps.refetchTab) {
      gsUtils.log(tab.id, QUEUE_ID, 'Tab refetch requested. Getting updated tab..');
      tab = await getUpdatedTab(tab);
      if (!tab) {
        resolve(gsUtils.STATUS_UNKNOWN);
        return;
      }
      gsUtils.log(tab.id, QUEUE_ID, 'Updated tab: ', tab);

      // Ensure tab is not suspended
      if (gsUtils.isSuspendedTab(tab, true)) {
        gsUtils.log(tab.id, QUEUE_ID, 'Tab is suspended. Aborting check.');
        resolve(gsUtils.STATUS_SUSPENDED);
        return;
      }

      // If tab has a state of loading, then requeue for checking later
      if (tab.status === 'loading') {
        gsUtils.log(tab.id, QUEUE_ID, 'Tab is still loading');
        requeue(DEFAULT_TAB_CHECK_REQUEUE_DELAY, { refetchTab: true });
        return;
      }
    }

    if (gsUtils.isDiscardedTab(tab)) {
      if (tab.active) {
        gsUtils.log(tab.id, QUEUE_ID, 'Tab is discarded but active. Will wait for auto reload.');
        requeue(500, { refetchTab: true });
      }
      else {
        gsUtils.log(tab.id, QUEUE_ID, 'Tab is discarded. Will reload.');
        await gsChrome.tabsReload(tab.id);
        requeue(DEFAULT_TAB_CHECK_REQUEUE_DELAY, { refetchTab: true });
      }
      return;
    }

    let tabInfo = await new Promise((resolve) => {
      gsMessages.sendRequestInfoToContentScript(tab.id, (error, tabInfo) =>
        resolve(tabInfo)
      );
    });

    if (tabInfo) {
      resolve(tabInfo.status);
      return;
    }

    const queuedTabDetails = getQueuedTabDetails(tab);
    if (!queuedTabDetails) {
      gsUtils.log(tab.id, QUEUE_ID, 'Tab missing from suspensionQueue?');
      resolve(gsUtils.STATUS_UNKNOWN);
      return;
    }

    if (tab.active && queuedTabDetails.requeues === 0) {
      gsUtils.log(tab.id, QUEUE_ID, 'Tab is not responding but active. Will wait for potential auto reload.');
      requeue(500, { refetchTab: false });
      return;
    }

    tabInfo = await reinjectContentScriptOnTab(tab);
    if (tabInfo) {
      resolve(tabInfo.status);
    }
    else {
      resolve(gsUtils.STATUS_UNKNOWN);
    }
  }

  // Careful with this function. It seems that these unresponsive tabs can sometimes
  // not return any result after chrome.scripting.executeScript
  // Try to mitigate this by wrapping in a setTimeout
  // TODO: Report chrome bug
  // Unrelated, but reinjecting content scripts has some issues:
  // https://groups.google.com/a/chromium.org/forum/#!topic/chromium-extensions/QLC4gNlYjbA
  // https://bugs.chromium.org/p/chromium/issues/detail?id=649947
  // Notably (for me), the key listener of the old content script remains active
  // if using: window.addEventListener('keydown', formInputListener);
  function reinjectContentScriptOnTab(tab) {
    gsUtils.log(tab.id, 'reinjectContentScriptOnTab');
    return new Promise((resolve) => {
      gsUtils.log(tab.id, QUEUE_ID, 'Reinjecting contentscript into unresponsive unsuspended tab.', tab);
      const executeScriptTimeout = setTimeout(() => {
        gsUtils.log(QUEUE_ID, tab.id, 'chrome.scripting.executeScript failed to trigger callback');
        resolve(null);
      }, 10000);
      gsMessages.executeScriptOnTab(tab.id, 'js/contentscript.js', (error) => {
        clearTimeout(executeScriptTimeout);
        if (error) {
          gsUtils.log(tab.id, 'Failed to execute js/contentscript.js on tab', error);
          resolve(null);
          return;
        }
        tgs.initialiseTabContentScript(tab)
          .then((tabInfo) => {
            resolve(tabInfo);
          })
          .catch((error) => {
            resolve(null);
          });
      });
    });
  }

  return {
    initAsPromised,
    performInitialisationTabChecks,
    queueTabCheck,
    queueTabCheckAsPromise,
    unqueueTabCheck,
    getQueuedTabDetails,
    hasPendingTabCheck,
    // ensureSuspendedTabVisible,
  };
})();
