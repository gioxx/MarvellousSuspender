import  { gsUtils }               from './gsUtils.js';

export const gsTabQueue = (function() {

  function init(queueId, queueProps) {
    return (function() {

      const STATUS_QUEUED = 'queued';
      const STATUS_IN_PROGRESS = 'inProgress';
      const STATUS_SLEEPING = 'sleeping';

      const EXCEPTION_TIMEOUT = 'timeout';

      const DEFAULT_CONCURRENT_EXECUTORS = 1;
      const DEFAULT_JOB_TIMEOUT = 1000;
      const DEFAULT_PROCESSING_DELAY = 500;
      const DEFAULT_REQUEUE_DELAY = 5000;
      const PROCESSING_QUEUE_CHECK_INTERVAL = 50;
      // Bounds a job that requeues forever (e.g. a tab permanently stuck 'loading',
      // or one that never gets an internal view) now that each requeue resets the
      // per-attempt timeout below — without this cap, that per-attempt reset would
      // remove the queue's only terminal deadline for such a job.
      const MAX_REQUEUES = 100;
      // A second, complementary bound on wall-clock time, not requeue count: a job
      // legitimately requeuing (see requeueTab()'s per-attempt reset below) well short of
      // MAX_REQUEUES can still run for far longer than a single jobTimeout was ever meant
      // to represent. 5x is deliberately more generous than one attempt — the whole point
      // of the per-attempt reset is not punishing real progress — while still keeping an
      // actual ceiling instead of none at all.
      const OVERALL_TIMEOUT_MULTIPLIER = 5;

      const _queueProperties = {
        concurrentExecutors: DEFAULT_CONCURRENT_EXECUTORS,
        jobTimeout: DEFAULT_JOB_TIMEOUT,
        processingDelay: DEFAULT_PROCESSING_DELAY,
        executorFn: (tab, resolve, reject, requeue) => resolve(true),
        exceptionFn: (tab, resolve, reject, requeue) => resolve(false),
      };
      const _tabDetailsByTabId = {};
      const _queuedTabIds = [];
      let   _processingQueueBufferTimer = null;
      const _queueId = queueId;

      setQueueProperties(queueProps);

      function setQueueProperties(queueProps) {
        for (const propName of Object.keys(queueProps)) {
          _queueProperties[propName] = queueProps[propName];
        }
        if (!isValidInteger(_queueProperties.concurrentExecutors, 1)) {
          throw new Error('concurrentExecutors must be an integer greater than 0');
        }
        if (!isValidInteger(_queueProperties.jobTimeout, 1)) {
          throw new Error('jobTimeout must be an integer greater than 0');
        }
        if (!isValidInteger(_queueProperties.processingDelay, 0)) {
          throw new Error('processingDelay must be an integer of at least 0');
        }
        if (!(typeof _queueProperties.executorFn === 'function')) {
          throw new Error('executorFn must be a function');
        }
        if (!(typeof _queueProperties.exceptionFn === 'function')) {
          throw new Error('executorFn must be a function');
        }
      }

      function getQueueProperties() {
        return _queueProperties;
      }

      function isValidInteger(value, minimum) {
        return value !== null && !isNaN(Number(value) && value >= minimum);
      }

      function getTotalQueueSize() {
        return Object.keys(_tabDetailsByTabId).length;
      }

      function queueTabAsPromise(tab, executionProps, delay) {
        executionProps = executionProps || {};
        let tabDetails = _tabDetailsByTabId[tab.id];
        if (!tabDetails) {
          // gsUtils.log(tab.id, _queueId, 'Queueing new tab.');
          tabDetails = {
            tab,
            executionProps,
            deferredPromise: createDeferredPromise(),
            status: STATUS_QUEUED,
            requeues: 0,
          };
          addTabToQueue(tabDetails);
        }
        else {
          tabDetails.tab = tab;
          applyExecutionProps(tabDetails, executionProps);
          gsUtils.log(tab.id, _queueId, 'Tab already queued.');
        }

        if (delay && isValidInteger(delay, 1)) {
          if (tabDetails.status === STATUS_IN_PROGRESS) {
            // An executor is already running this tab. sleepTab() would flip it
            // IN_PROGRESS -> SLEEPING -> QUEUED after `delay`, and processQueue() would
            // then start a second executor for it alongside the first (double
            // init/discard of the same tab). Leave the running executor to finish; the
            // merged executionProps above ride along, and its own requeue path (or the
            // caller's next scan) covers any follow-up.
            gsUtils.log(tab.id, _queueId, 'Tab already in progress; not re-sleeping.');
          }
          else {
            gsUtils.log(tab.id, _queueId, `Sleeping tab for ${delay}ms`);
            sleepTab(tabDetails, delay);
          }
        }
        else {
          // If tab is already marked as sleeping then wake it up
          if (tabDetails.sleepTimer) {
            gsUtils.log(tab.id, _queueId, 'Removing tab from sleep');
            clearTimeout(tabDetails.sleepTimer);
            delete tabDetails.sleepTimer;
            tabDetails.status = STATUS_QUEUED;
          }
          requestProcessQueue(0);
        }
        return tabDetails.deferredPromise;
      }

      function applyExecutionProps(tabDetails, executionProps) {
        executionProps = executionProps || {};
        for (const prop in executionProps) {
          tabDetails.executionProps[prop] = executionProps[prop];
        }
      }

      function unqueueTab(tab) {
        const tabDetails = _tabDetailsByTabId[tab.id];
        if (tabDetails) {
          // gsUtils.log(tab.id, _queueId, 'Unqueueing tab.');
          clearTimeout(tabDetails.timeoutTimer);
          removeTabFromQueue(tabDetails);
          rejectTabPromise(tabDetails, 'Queued tab job cancelled externally');
          return true;
        }
        else {
          return false;
        }
      }

      function addTabToQueue(tabDetails) {
        const tab = tabDetails.tab;
        _tabDetailsByTabId[tab.id] = tabDetails;
        _queuedTabIds.push(tab.id);
        gsUtils.log(tab.id, _queueId, 'addTabToQueue queue', _queuedTabIds.length);
      }

      function removeTabFromQueue(tabDetails) {
        const tab = tabDetails.tab;
        delete _tabDetailsByTabId[tab.id];
        for (const [i, tabId] of _queuedTabIds.entries()) {
          if (tabId === tab.id) {
            _queuedTabIds.splice(i, 1);
            break;
          }
        }
        gsUtils.log(tab.id, _queueId, 'removeTabFromQueue queue', _queuedTabIds.length);
      }

      function moveTabToEndOfQueue(tabDetails) {
        const tab = tabDetails.tab;
        for (const [i, tabId] of _queuedTabIds.entries()) {
          if (tabId === tab.id) {
            _queuedTabIds.push(_queuedTabIds.splice(i, 1)[0]);
            break;
          }
        }
      }

      function getQueuedTabDetails(tab) {
        return _tabDetailsByTabId[tab.id];
      }

      function createDeferredPromise() {
        let res;
        let rej;
        const promise = new Promise((resolve, reject) => {
          res = resolve;
          rej = reject;
        });
        promise.resolve = o => {
          res(o);
          return promise;
        };
        promise.reject = o => {
          rej(o);
          return promise;
        };
        return promise;
      }

      function requestProcessQueue(processingDelay) {
        setTimeout(() => {
          startProcessQueueBufferTimer();
        }, processingDelay);
      }

      function startProcessQueueBufferTimer() {
        if (_processingQueueBufferTimer === null) {
          _processingQueueBufferTimer = setTimeout(() => {
            _processingQueueBufferTimer = null;
            processQueue();
          }, PROCESSING_QUEUE_CHECK_INTERVAL);
        }
      }

      function processQueue() {
        let inProgressCount = 0;
        for (const tabId of _queuedTabIds) {
          const tabDetails = _tabDetailsByTabId[tabId];
          if (tabDetails.status === STATUS_IN_PROGRESS) {
            inProgressCount += 1;
          }
          else if (tabDetails.status === STATUS_QUEUED) {
            processTab(tabDetails);
            inProgressCount += 1;
          }
          else if (tabDetails.status === STATUS_SLEEPING) {
            // ignore
          }
          if (inProgressCount >= _queueProperties.concurrentExecutors) {
            break;
          }
        }
      }

      function processTab(tabDetails) {
        tabDetails.status = STATUS_IN_PROGRESS;
        gsUtils.log(tabDetails.tab.id, _queueId, 'Executing executorFn for tab.');

        const _resolveTabPromise = r => resolveTabPromise(tabDetails, r);
        const _rejectTabPromise = e => rejectTabPromise(tabDetails, e);
        const _requeueTab = (requeueDelay, executionProps) => {
          requeueTab(tabDetails, requeueDelay, executionProps);
        };

        // Routes an unexpected failure through the queue's own configured exceptionFn
        // (the same one the timeout path below already uses), rather than rejecting the
        // job directly. Some callers (e.g. gsTabCheckManager's
        // performInitialisationTabChecks() at startup) aggregate many of these jobs'
        // promises via Promise.all() — a caller-side rejection there aborts the whole
        // aggregate immediately, skipping that caller's own post-await cleanup (removing
        // its temporary listener, restoring queue properties) and can leave startup
        // permanently stuck in "initialising" state. exceptionFn's own contract already
        // resolves(false) rather than rejecting (see handleTabCheckException), so routing
        // through it here keeps that same caller-safe behaviour for this failure path too.
        const _runExceptionFn = (exceptionType) => {
          Promise.resolve()
            .then(() => _queueProperties.exceptionFn(
              tabDetails.tab,
              tabDetails.executionProps,
              exceptionType,
              _resolveTabPromise,
              _rejectTabPromise,
              _requeueTab
            ))
            .catch((error) => {
              // exceptionFn itself failed — resolve(false) directly as a last resort
              // rather than rejecting, for the same Promise.all()-safety reason above.
              gsUtils.log(tabDetails.tab.id, _queueId, 'exceptionFn threw unexpectedly', error);
              _resolveTabPromise(false);
            });
        };

        // Set once, the very first time this job is ever processed — never touched by
        // requeueTab()'s per-attempt timer reset, so it's what requeueTab() checks
        // against as this job's real overall ceiling regardless of how many requeues it
        // took to get there.
        if (!tabDetails.hasOwnProperty('deadlineAt')) {
          tabDetails.deadlineAt = Date.now() + OVERALL_TIMEOUT_MULTIPLIER * _queueProperties.jobTimeout;
        }

        // If timeout timer has not yet been initiated, then start it now
        if (!tabDetails.hasOwnProperty('timeoutTimer')) {
          tabDetails.timeoutTimer = setTimeout(() => {
            gsUtils.log(tabDetails.tab.id, _queueId, 'Tab job timed out');
            _runExceptionFn(EXCEPTION_TIMEOUT);
          }, _queueProperties.jobTimeout);
        }

        // executorFn is expected to settle this job itself via resolve/reject/requeue —
        // without this catch, a thrown/rejected executorFn (e.g. a tab responding with an
        // unexpected shape, previously observed live as an uncaught "Cannot read
        // properties of undefined" a few layers up) left this slot stuck in
        // STATUS_IN_PROGRESS with nothing to release it until the full jobTimeout elapsed
        // (up to 60s) — this queue only has a handful of concurrent slots to begin with,
        // so repeated occurrences could meaningfully choke its throughput. Routed through
        // the same exceptionFn the timeout path uses, freeing the slot right away.
        Promise.resolve()
          .then(() => _queueProperties.executorFn(
            tabDetails.tab,
            tabDetails.executionProps,
            _resolveTabPromise,
            _rejectTabPromise,
            _requeueTab
          ))
          .catch((error) => {
            gsUtils.log(tabDetails.tab.id, _queueId, 'executorFn threw unexpectedly', error);
            _runExceptionFn(error);
          });
      }

      function resolveTabPromise(tabDetails, result) {
        if (!_tabDetailsByTabId[tabDetails.tab.id]) {
          return;
        }
        gsUtils.log(tabDetails.tab.id, _queueId, 'Queued tab resolved. Result: ', result);
        clearTimeout(tabDetails.timeoutTimer);
        removeTabFromQueue(tabDetails);
        tabDetails.deferredPromise.resolve(result);
        requestProcessQueue(_queueProperties.processingDelay);
      }

      function rejectTabPromise(tabDetails, error) {
        if (!_tabDetailsByTabId[tabDetails.tab.id]) {
          return;
        }
        gsUtils.log(tabDetails.tab.id, _queueId, 'Queued tab rejected. Error: ', error);
        clearTimeout(tabDetails.timeoutTimer);
        removeTabFromQueue(tabDetails);
        tabDetails.deferredPromise.reject(error);
        requestProcessQueue(_queueProperties.processingDelay);
      }

      function requeueTab(tabDetails, requeueDelay, executionProps) {
        requeueDelay = requeueDelay || DEFAULT_REQUEUE_DELAY;
        if (executionProps) {
          applyExecutionProps(tabDetails, executionProps);
        }
        tabDetails.requeues += 1;
        gsUtils.log(tabDetails.tab.id, _queueId, `Requeueing tab. Requeues: ${tabDetails.requeues}`);

        // MAX_REQUEUES alone bounds a job that requeues forever, but not one that requeues
        // a normal, finite number of times while still taking far longer in wall-clock time
        // than jobTimeout was ever meant to allow — each requeue below resets the timer to
        // a fresh full jobTimeout, so 100 requeues at even the default 5s delay could run
        // for the better part of a couple of hours. deadlineAt (set once, the first time
        // this job is ever processed — see processTab()) is untouched by that per-attempt
        // reset, so this catches it regardless of how many requeues it took to get there.
        if (tabDetails.requeues > MAX_REQUEUES || Date.now() >= tabDetails.deadlineAt) {
          gsUtils.log(tabDetails.tab.id, _queueId, `Tab exceeded ${MAX_REQUEUES} requeues or its overall deadline, treating as timed out.`);
          clearTimeout(tabDetails.timeoutTimer);
          delete tabDetails.timeoutTimer;
          _queueProperties.exceptionFn(
            tabDetails.tab,
            tabDetails.executionProps,
            EXCEPTION_TIMEOUT,
            r => resolveTabPromise(tabDetails, r),
            e => rejectTabPromise(tabDetails, e),
            (delay, props) => requeueTab(tabDetails, delay, props)
          ); // async. unhandled promise
          return;
        }

        // A requeue means the job is making legitimate progress (still loading, no
        // context yet, reinitialising, etc), not stuck — so give it a fresh timeout
        // window rather than letting the original attempt's timer (started once in
        // processTab and never touched here) kill it mid-progress. Without this, a
        // job needing several requeues (common under load, e.g. many tabs restored
        // or reinitialised together) can accumulate more elapsed time than jobTimeout
        // even though no single step ever hung. MAX_REQUEUES above still bounds a job
        // that requeues forever without ever resolving.
        clearTimeout(tabDetails.timeoutTimer);
        delete tabDetails.timeoutTimer;
        // moveTabToEndOfQueue(tabDetails);
        sleepTab(tabDetails, requeueDelay);
        requestProcessQueue(_queueProperties.processingDelay);
      }

      function sleepTab(tabDetails, delay) {
        tabDetails.status = STATUS_SLEEPING;
        if (tabDetails.sleepTimer) {
          clearTimeout(tabDetails.sleepTimer);
        }
        tabDetails.sleepTimer = setTimeout(() => {
          delete tabDetails.sleepTimer;
          tabDetails.status = STATUS_QUEUED;
          requestProcessQueue(0);
        }, delay);
      }

      return {
        EXCEPTION_TIMEOUT,
        setQueueProperties,
        getQueueProperties,
        getTotalQueueSize,
        queueTabAsPromise,
        unqueueTab,
        getQueuedTabDetails,
      };
    })();
  }

  return { init };

})();
