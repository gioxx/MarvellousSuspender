/** @import * as html2canvas from './html2canvas.min.js' */
import  { gsChrome }              from './gsChrome.js';
import  { gsIndexedDb }           from './gsIndexedDb.js';
import  { gsMessages }            from './gsMessages.js';
import  { gsSession }             from './gsSession.js';
import  { gsStorage }             from './gsStorage.js';
import  { gsTabCheckManager }     from './gsTabCheckManager.js';
import  { gsTabDiscardManager }   from './gsTabDiscardManager.js';
import  { gsTabQueue }            from './gsTabQueue.js';
import  { gsUtils }               from './gsUtils.js';
import  { tgs }                   from './tgs.js';

export const gsTabSuspendManager = (function() {

  const DEFAULT_CONCURRENT_SUSPENSIONS = 3;
  const DEFAULT_SUSPENSION_TIMEOUT = 60 * 1000;

  const QUEUE_ID = 'suspensionQueue';

  let   _suspensionQueue;
  const INIT_RESOLVERS = [];
  // Tracks, per tab id, which job's executionProps a preview-generation request is
  // currently in flight for, keyed by a per-request token rather than the tab id alone.
  // handlePreviewImageResponse() is reached from a chrome.runtime message sent by the
  // injected content script (background.js's 'savePreviewData' case) as well as two
  // internal error callbacks below, none of which carry any reference to the specific
  // queue job the request belongs to -- only the tab id, echoed back through the
  // message/callback. A tab-id-only map is not enough: if job A registers here and then
  // gets superseded by job B for the same tab (both requesting a preview) before A's late
  // response arrives, B's own request would overwrite A's entry, so by the time A's
  // response shows up the "expected" props it's compared against are already B's --
  // trivially matching and letting A's stale screenshot resolve B's job instead of being
  // dropped as stale (Codex review round 2, PR #502; the earlier map-only fix from round 7
  // closed the tabDetails-identity gap but not this one, since the correlation itself was
  // what got clobbered by the overwrite). _previewRequestSeq gives every request its own
  // token that a later request for the same tab id can't collide with.
  const _pendingPreviewExecutionPropsByTabId = new Map();
  let   _previewRequestSeq = 0;

  // handlePreviewImageResponse() is the only thing that ever deletes a
  // _pendingPreviewExecutionPropsByTabId entry -- a job that never produces a response
  // (html2canvas hangs until the queue's own jobTimeout forces handleSuspensionException's
  // EXCEPTION_TIMEOUT path, or the tab gets unqueued externally, e.g. on close, while a
  // preview is still in flight) left its entry, holding executionProps and its resolveFn
  // closure, in the map for the rest of the service worker's lifetime (Codex review round
  // 3, PR #502). Called from every other path that can conclude such a job, identity-
  // checked the same way the response handler is so it never removes a newer job's entry.
  function _clearPendingPreview(tabId, executionProps) {
    const pending = _pendingPreviewExecutionPropsByTabId.get(tabId);
    if (pending && pending.executionProps === executionProps) {
      _pendingPreviewExecutionPropsByTabId.delete(tabId);
    }
  }

  function initAsPromised() {
    gsUtils.log('gsTabSuspendManager initAsPromised', _suspensionQueue);
    return new Promise(async (resolve) => {
      const screenCaptureMode   = await gsStorage.getOption(gsStorage.SCREEN_CAPTURE);
      const forceScreenCapture  = await gsStorage.getOption(gsStorage.SCREEN_CAPTURE_FORCE);
      // TODO: This should probably update when the screen capture mode changes
      const concurrentSuspensions = screenCaptureMode === '0' ? 5 : DEFAULT_CONCURRENT_SUSPENSIONS;
      const suspensionTimeout = forceScreenCapture ? 5 * 60 * 1000 : DEFAULT_SUSPENSION_TIMEOUT;
      const queueProps = {
        concurrentExecutors: concurrentSuspensions,
        jobTimeout: suspensionTimeout,
        executorFn: performSuspension,
        exceptionFn: handleSuspensionException,
      };
      _suspensionQueue = gsTabQueue.init(QUEUE_ID, queueProps);
      gsUtils.log(QUEUE_ID, 'init successful');

      let resolveFn;
      while ((resolveFn = INIT_RESOLVERS.pop())) {
        resolveFn();
      }

      resolve();
    });
  }

  /** @returns { Promise<void> } */
  async function queueInitialized() {
    return new Promise((resolve) => {
      if (_suspensionQueue) resolve();  // resolve immediately if the queue exists
      INIT_RESOLVERS.push(resolve);     // otherwise, push our resolve function into a queue that will be processed after initialization
    });
  }

  function queueTabForSuspension(tab, forceLevel) {
    queueTabForSuspensionAsPromise(tab, forceLevel).catch(e => {
      gsUtils.log(tab.id, QUEUE_ID, e);
    });
  }

  async function queueTabForSuspensionAsPromise(tab, forceLevel) {
    if (typeof tab === 'undefined') return Promise.resolve();

    await queueInitialized();
    if (!_suspensionQueue) {
      gsUtils.warning(tab.id, QUEUE_ID, 'queueTabForSuspensionAsPromise', 'Queue not initialized.  This should never fire.');
      return Promise.resolve();
    }

    if (!await checkTabEligibilityForSuspension(tab, forceLevel)) {
      gsUtils.log(tab.id, QUEUE_ID, 'checkTabEligibilityForSuspension', 'Tab not eligible for suspension');
      return Promise.resolve();
    }

    gsUtils.log(tab.id, QUEUE_ID, 'queueTabForSuspensionAsPromise');
    return _suspensionQueue.queueTabAsPromise(tab, { forceLevel });
  }

  function unqueueTabForSuspension(tab) {
    if (!_suspensionQueue) {
      gsUtils.warning(tab.id, QUEUE_ID, 'unqueueTabForSuspension', 'Queue not initialized');
      return;
    }
    // Captured before unqueueTab() below removes the entry -- an external cancellation of
    // a running job rejects its deferredPromise directly, bypassing executionProps.resolveFn
    // (and therefore handleSuspensionException too), so a preview request it had in flight
    // would otherwise never get cleaned up (Codex review round 3, PR #502).
    const tabDetails = getQueuedTabDetails(tab);
    const removed = _suspensionQueue.unqueueTab(tab);
    if (removed) {
      if (tabDetails) {
        _clearPendingPreview(tab.id, tabDetails.executionProps);
      }
      gsUtils.log(tab.id, QUEUE_ID, 'unqueueTabForSuspension', 'Removed tab from suspension queue');
    }
  }

  async function performSuspension(tab, executionProps, resolve, reject, requeue,) {
    if (executionProps.refetchTab || gsUtils.isSuspendedTab(tab)) {
      gsUtils.log(tab.id, QUEUE_ID, 'Tab refetch required. Getting updated tab..');
      const _tab = await gsChrome.tabsGet(tab.id);
      if (!_tab) {
        gsUtils.log(tab.id, QUEUE_ID, 'Could not find tab with id. Will ignore suspension request');
        resolve(false);
        return;
      }
      tab = _tab;
    }

    if (gsUtils.isSuspendedTab(tab)) {
      if (!executionProps.refetchTab) {
        gsUtils.log(tab.id, QUEUE_ID, 'Tab is already suspended. Will check again in 3 seconds');
        requeue(3000, { refetchTab: true });
      }
      else {
        gsUtils.log(tab.id, QUEUE_ID, 'Tab still suspended after 3 seconds. Will ignore tab suspension request');
        resolve(false);
      }
      return;
    }

    // If tab is in loading state, try to suspend early if possible
    // Note: doing so will bypass a few checks below. Namely:
    // - Any temporary pause flag that has been set up on the tab
    // - It may lose any scrollPos value
    // Although if the tab is still loading then pause and scroll pos should
    // not be set?
    // Do not bypass loading state if screen capture is required
    let screenCaptureMode = await gsStorage.getOption(gsStorage.SCREEN_CAPTURE);
    if (tab.status === 'loading') {
      const savedTabInfo = await gsIndexedDb.fetchTabInfo(tab.url);
      if (screenCaptureMode === '0' && savedTabInfo) {
        const suspendedUrl = gsUtils.generateSuspendedUrl(
          tab.url,
          savedTabInfo.title,
          0,
        );
        gsUtils.log(tab.id, QUEUE_ID, 'Interrupting tab loading to resuspend tab');
        const success = await executeTabSuspension(tab, suspendedUrl);
        resolve(success);
      }
      else {
        requeue(3000, { refetchTab: true });
      }
      return;
    }

    const discardInPlaceOfSuspend = await gsStorage.getOption(gsStorage.DISCARD_IN_PLACE_OF_SUSPEND);
    if (discardInPlaceOfSuspend) {
      screenCaptureMode = '0';
    }

    let tabInfo = await getContentScriptTabInfo(tab);

    // If tabInfo is null this is usually due to tab loading, being discarded or 'parked' on chrome restart
    // If we need to make a screen capture and tab is not responding then reload it
    // TODO: This doesn't actually seem to work
    // Tabs that have just been reloaded usually fail to run the screen capture script :(
    if (!tabInfo && screenCaptureMode !== '0' && !executionProps.reloaded) {
      gsUtils.log(tab.id, QUEUE_ID, 'Tab is not responding. Will reload for screen capture.');
      await gsChrome.tabsUpdate(tab.id, { url: tab.url });
      // allow up to 30 seconds for tab to reload and trigger its subsequent suspension request
      // note that this will not reset the DEFAULT_SUSPENSION_TIMEOUT of 60 seconds
      requeue(30000, { reloaded: true });
      return;
    }

    tabInfo = tabInfo || {
      status: 'unknown',
      scrollPos: '0',
    };

    const isEligible = await checkContentScriptEligibilityForSuspension(tabInfo.status, executionProps.forceLevel, tab.url);
    if (!isEligible) {
      gsUtils.log(tab.id, QUEUE_ID, `Content script status of ${ tabInfo.status } not eligible for suspension. Removing tab from suspensionQueue.`,);
      resolve(false);
      return;
    }

    // Temporarily change tab.url to append youtube timestamp
    const timestampedUrl = await generateUrlWithYouTubeTimestamp(tab);
    // NOTE: This does not actually change the tab url, just the current tab object
    tab.url = timestampedUrl;
    await saveSuspendData(tab);

    const suspendedUrl = gsUtils.generateSuspendedUrl(tab.url, tab.title, tabInfo.scrollPos,);
    executionProps.suspendedUrl = suspendedUrl;

    if (screenCaptureMode === '0') {
      const success = await executeTabSuspension(tab, suspendedUrl);
      resolve(success);
      return;
    }

    // Hack. Save handle to resolve function so we can call it later
    executionProps.resolveFn = resolve;
    const previewToken = ++_previewRequestSeq;
    _pendingPreviewExecutionPropsByTabId.set(tab.id, { token: previewToken, executionProps });
    requestGeneratePreviewImage(tab, previewToken); // async
    gsUtils.log(tab.id, QUEUE_ID, 'Preview generation script started successfully.',);
    // handlePreviewImageResponse is called on the 'savePreviewData' message response
    // this will refetch the queued tabDetails and call executionProps.resolveFn(true)
  }

  async function handlePreviewImageResponse(tab, previewUrl, errorMsg, previewToken) {
    const pending = _pendingPreviewExecutionPropsByTabId.get(tab.id);
    // Token, not just tab id: a later preview request for the same tab (job B, superseding
    // job A) overwrites this map entry with its own token/executionProps, so a late
    // response arriving for A after that overwrite must not be mistaken for B's just
    // because it's now the only entry present for this tab id.
    if (!pending || pending.token !== previewToken) {
      gsUtils.log(tab.id, QUEUE_ID, 'Preview response is for a superseded suspension job. Ignoring.',);
      return;
    }
    _pendingPreviewExecutionPropsByTabId.delete(tab.id);
    const expectedExecutionProps = pending.executionProps;

    const queuedTabDetails = getQueuedTabDetails(tab);
    if (!queuedTabDetails) {
      gsUtils.log(tab.id, QUEUE_ID, 'Tab missing from suspensionQueue. Assuming suspension cancelled for this tab.',);
      return;
    }
    // Identity, not just presence: belt-and-suspenders alongside the token check above --
    // a late preview response whose job has since been superseded (a different
    // executionProps object now occupies this tab id's slot) must not be applied to, or
    // resolve, that newer job.
    if (queuedTabDetails.executionProps !== expectedExecutionProps) {
      gsUtils.log(tab.id, QUEUE_ID, 'Preview response is for a superseded suspension job. Ignoring.',);
      return;
    }

    const suspensionForceLevel = queuedTabDetails.executionProps.forceLevel;
    if (!await checkTabEligibilityForSuspension(tab, suspensionForceLevel)) {
      gsUtils.log(tab.id, QUEUE_ID, 'Tab is no longer eligible for suspension. Removing tab from suspensionQueue.',);
      return;
    }

    // Temporarily change tab.url with that from the generated suspended url
    // This is because for youtube tabs we manually change the url to persist timestamp
    const timestampedUrl = gsUtils.getOriginalUrl(
      queuedTabDetails.executionProps.suspendedUrl,
    );
    // NOTE: This does not actually change the tab url, just the current tab object
    tab.url = timestampedUrl;

    if (!previewUrl) {
      gsUtils.warning(tab.id, QUEUE_ID, 'savePreviewData reported an error: ', errorMsg,);
    }
    else {
      await gsIndexedDb.addPreviewImage(tab.url, previewUrl);
    }

    const success = await executeTabSuspension(
      tab,
      queuedTabDetails.executionProps.suspendedUrl,
    );
    queuedTabDetails.executionProps.resolveFn(success);
  }

  function getQueuedTabDetails(tab) {
    if (!_suspensionQueue) {
      gsUtils.warning(tab.id, QUEUE_ID, 'getQueuedTabDetails', 'Queue not initialized.  This should never fire.');
      return;
    }
    return _suspensionQueue.getQueuedTabDetails(tab);
  }

  async function handleSuspensionException(tab, executionProps, exceptionType, resolve, reject, requeue) {
    if (!_suspensionQueue) {
      gsUtils.warning(tab.id, QUEUE_ID, 'handleSuspensionException', 'Queue not initialized.  This should never fire.');
      resolve(false);
      return;
    }
    // This job is concluding here rather than via handlePreviewImageResponse() -- if it
    // had a preview request in flight (only true once performSuspension() got as far as
    // setting executionProps.resolveFn), that request's own eventual response, if it ever
    // arrives, must find nothing to act on rather than resolving a job that's already
    // settled.
    _clearPendingPreview(tab.id, executionProps);
    if (exceptionType === _suspensionQueue.EXCEPTION_TIMEOUT) {
      gsUtils.log(tab.id, QUEUE_ID, `Tab took more than ${ _suspensionQueue.getQueueProperties().jobTimeout }ms to suspend. Will force suspension.`);
      const success = await executeTabSuspension(tab, executionProps.suspendedUrl,);
      resolve(success);
    }
    else {
      gsUtils.warning(tab.id, QUEUE_ID, `Failed to suspend tab: ${exceptionType}`);
      resolve(false);
    }
  }

  function executeTabSuspension(tab, suspendedUrl) {
    return new Promise(async (resolve) => {
      // Remove any existing queued tab checks (this can happen if we try to suspend
      // a tab immediately after it gains focus)
      gsTabCheckManager.unqueueTabCheck(tab);

      // If we want tabs to be discarded instead of suspending them
      const discardInPlaceOfSuspend = await gsStorage.getOption(gsStorage.DISCARD_IN_PLACE_OF_SUSPEND);
      if (discardInPlaceOfSuspend) {
        await tgs.clearAutoSuspendTimerForTabId(tab.id);
        gsTabDiscardManager.queueTabForDiscard(tab);
        resolve(true);
        return;
      }

      if (gsUtils.isSuspendedTab(tab, true)) {
        gsUtils.log(tab.id, 'Tab already suspended');
        resolve(false);
        return;
      }

      if (!suspendedUrl) {
        gsUtils.log(tab.id, 'executionProps.suspendedUrl not set!');
        suspendedUrl = gsUtils.generateSuspendedUrl(tab.url, tab.title, 0);
      }

      gsUtils.log(tab.id, 'Suspending tab');
      await tgs.setTabStatePropForTabId(tab.id, tgs.STATE_INITIALISE_SUSPENDED_TAB, true);
      gsChrome.tabsUpdate(tab.id, { url: suspendedUrl }).then(updatedTab => {
        resolve(updatedTab !== null);
      });
    });
  }

  // forceLevel indicates which users preferences to respect when attempting to suspend the tab
  // 1: Suspend if at all possible
  // 2: Respect whitelist, temporary whitelist, form input, pinned tabs, audible preferences, and exclude current active tab
  // 3: Same as above (2), plus also respect internet connectivity, running on battery, and time to suspend=never preferences.
  async function checkTabEligibilityForSuspension(tab, forceLevel) {
    // gsUtils.log(tab.id, 'gsTabSuspendManager', 'checkTabEligibilityForSuspension', forceLevel);
    if (forceLevel >= 1) {
      // if (gsUtils.isSuspendedTab(tab, true) || gsUtils.isSpecialTab(tab)) {
      // actually allow suspended tabs to attempt suspension in case they are
      // in the process of being reloaded and we have changed our mind and
      // want to suspend them again.
      // isSpecialTab()'s isBlockedFileTab() check reads gsSession's cached file-access
      // state synchronously; refresh it first so a long-lived background worker started
      // before the user enabled file access doesn't keep rejecting file:// tabs as
      // special after a freshly opened popup would already show them as suspendable
      // (Codex review, #514).
      if (gsUtils.isFileTab(tab)) {
        await gsSession.ensureFileUrlsStateReady();
      }
      if (gsUtils.isSpecialTab(tab)) {
        return false;
      }
    }
    if (forceLevel >= 2) {
      if (await gsUtils.isProtectedActiveTab(tab)) {
        return false;
      }
      // Tabs on the "always suspend" list bypass the whitelist/pinned/audible protections
      // below (#103), but still respect the active-tab check above.
      if (!(await gsUtils.checkAlwaysSuspendList(tab.url))) {
        if (
          (await gsUtils.checkWhiteList(tab.url)) ||
          (await gsUtils.isProtectedPinnedTab(tab)) ||
          (await gsUtils.isProtectedAudibleTab(tab)) ||
          (await gsUtils.isProtectedAppWindowTab(tab)) ||
          (await gsUtils.isProtectedGroupedTab(tab)) ||
          (await gsUtils.isProtectedTabGroupTab(tab))
        ) {
          return false;
        }
      }
    }
    if (forceLevel >= 3) {
      if (await gsStorage.getOption(gsStorage.IGNORE_WHEN_OFFLINE) && !navigator.onLine) {
        return false;
      }
      if (await gsStorage.getOption(gsStorage.IGNORE_WHEN_CHARGING) && await tgs.isCharging()) {
        return false;
      }
      // Mirrors the effective-timeout logic in tgs.js's resetAutoSuspendTimerForTab():
      // a battery-specific timeout (#252) can be "on" (non-'0') while the normal
      // timeout is "Never" ('0') — the UI hides the normal-timeout-only options in
      // that state but doesn't clear their stored value, so a stale '0' here must not
      // reject a suspension that was legitimately scheduled off the battery timeout.
      let effectiveSuspendTime = await gsStorage.getOption(gsStorage.SUSPEND_TIME);
      if ((await tgs.isCharging()) === false) {
        const suspendTimeOnBattery = await gsStorage.getOption(gsStorage.SUSPEND_TIME_ON_BATTERY);
        if (suspendTimeOnBattery !== '') {
          effectiveSuspendTime = suspendTimeOnBattery;
        }
      }
      if (effectiveSuspendTime === '0') {
        return false;
      }
    }
    return true;
  }

  async function checkContentScriptEligibilityForSuspension(contentScriptStatus, forceLevel, url) {
    if (forceLevel >= 2 && contentScriptStatus === gsUtils.STATUS_TEMPWHITELIST) {
      // An explicit per-tab pause is a deliberate action, the "always suspend" list does not override it.
      return false;
    }
    if (forceLevel >= 2 && contentScriptStatus === gsUtils.STATUS_FORMINPUT) {
      if (await gsUtils.checkAlwaysSuspendList(url)) {
        return true;
      }
      return false;
    }
    return true;
  }

  function getContentScriptTabInfo(tab) {
    return new Promise(resolve => {
      gsMessages.sendRequestInfoToContentScript(tab.id, (error, tabInfo) => {
        // TODO: Should we wait here for the tab to load? Doesn't seem to matter..
        if (error) {
          gsUtils.warning(tab.id, QUEUE_ID, 'Failed to get content script info', error,);
          // continue here but will lose information about scroll position,
          // temp whitelist, and form input
        }
        resolve(tabInfo);
      });
    });
  }

  async function generateUrlWithYouTubeTimestamp(tab) {
    if (!tab.url.includes('https://www.youtube.com/watch')) {
      return tab.url;
    }

    const addYouTubeTimestamp = await gsStorage.getOption(gsStorage.ADD_YOUTUBE_TIMESTAMP);
    if (!addYouTubeTimestamp) {
      return tab.url;
    }

    return new Promise(resolve => {
      gsMessages.executeCodeOnTab(
        tab.id,
        [], // args for injection
        () => { // code to execute
          const videoEl = document.querySelector('video.video-stream.html5-main-video');
          const timestamp = videoEl ? videoEl.currentTime >> 0 : 0;
          return timestamp;
        },
        (error, response) => {  // callback
          if (error) {
            gsUtils.warning(tab.id, QUEUE_ID, 'Failed to fetch YouTube timestamp', error,);
          }
          if (!response) {
            resolve(tab.url);
            return;
          }

          const timestamp = response;
          const youTubeUrl = new URL(tab.url);
          youTubeUrl.searchParams.set('t', `${timestamp}s`);
          resolve(youTubeUrl.href);
        },
      );
    });
  }

  async function saveSuspendData(tab) {
    const tabProperties = {
      date: new Date(),
      title: tab.title,
      url: tab.url,
      favIconUrl: tab.favIconUrl,
      pinned: tab.pinned,
      index: tab.index,
      windowId: tab.windowId,
    };
    await gsIndexedDb.addSuspendedTabInfo(tabProperties);

    // gsFavicon can't be loaded here since there's no DOM access yet
    // const faviconMeta = await gsFavicon.buildFaviconMetaFromChrome( tab.url );
    // if (faviconMeta) {
    //   await gsFavicon.saveFaviconMetaToCache(tab.url, faviconMeta);
    // }
  }

  async function requestGeneratePreviewImage(tab, previewToken) {
    const screenCaptureMode   = await gsStorage.getOption(gsStorage.SCREEN_CAPTURE);
    const forceScreenCapture  = await gsStorage.getOption(gsStorage.SCREEN_CAPTURE_FORCE);
    const screenCaptureLib = 'js/html2canvas.min.js';
    gsUtils.log(tab.id, QUEUE_ID, `Injecting ${screenCaptureLib} into content script`,);
    gsMessages.executeScriptOnTab(tab.id, screenCaptureLib, error => {
      if (error) {
        handlePreviewImageResponse(tab, null, 'Failed to executeScriptOnTab', previewToken); // async. unhandled promise.
        return;
      }
      gsMessages.executeCodeOnTab(
        tab.id,
        [screenCaptureMode, forceScreenCapture, previewToken],  // args for injection
        async (mode, force, token) => { // code to inject


          // NOTE: This function below is run within the content script scope
          // Therefore it must be self contained and not refer to any external functions
          // such as references to gsUtils etc.
          // @TODO: Can we move this function into the main content script?

          const MAX_CANVAS_HEIGHT = force ? 10000 : 5000;
          const IMAGE_TYPE = 'image/webp';
          const IMAGE_QUALITY = force ? 0.92 : 0.5;

          let height = 0;
          let width = 0;

          // check where we need to capture the whole screen
          if (mode === '2') {
            height = Math.max(
              window.innerHeight,
              document.body.scrollHeight,
              document.body.offsetHeight,
              document.documentElement.clientHeight,
              document.documentElement.scrollHeight,
              document.documentElement.offsetHeight,
            );
            // cap the max height otherwise it fails to convert to a data url
            height = Math.min(height, MAX_CANVAS_HEIGHT);
          }
          else {
            height = window.innerHeight;
          }
          width = document.body.clientWidth;

          // console.log('Generating via html2canvas..');
          const generateCanvas = () => {
            return html2canvas(document.body, {
              height,
              width,
              logging: false,
              imageTimeout: 10000,
              removeContainer: false,
              async: true,
            });
          };


          const isCanvasVisible = canvas => {
            const ctx       = canvas.getContext('2d');
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            for (let i = 0; i < imageData.data.length; i += 4) {
              const isTransparent = imageData.data[i + 3] === 0;
              const isWhite =
                imageData.data[i] === 255 &&
                imageData.data[i + 1] === 255 &&
                imageData.data[i + 2] === 255;
              if (!isTransparent && !isWhite) {
                return true;
              }
            }
            return false;
          };

          const generateDataUrl = canvas => {
            let dataUrl = canvas.toDataURL(IMAGE_TYPE, IMAGE_QUALITY);
            if (!dataUrl || dataUrl === 'data:,') {
              dataUrl = canvas.toDataURL();
            }
            if (dataUrl === 'data:,') {
              dataUrl = null;
            }
            return dataUrl;
          };

          let dataUrl;
          let errorMsg;
          try {
            const canvas = await generateCanvas();
            if (!isCanvasVisible(canvas)) {
              errorMsg = 'Canvas contains no visible pixels';
            }
            else {
              dataUrl = generateDataUrl(canvas);
            }
          }
          catch (err) {
            errorMsg = err.message;
          }
          if (!dataUrl && !errorMsg) {
            errorMsg = 'Failed to generate dataUrl';
          }
          // console.log('saving previewData..');
          chrome.runtime.sendMessage({ action: 'savePreviewData', previewUrl: dataUrl, errorMsg, token, });


        },  // end code to inject
        (error) => {  // callback
          if (error) {
            handlePreviewImageResponse(tab, null, 'Failed to executeCodeOnTab: generatePreviewImgContentScript', previewToken); // async. unhandled promise.
            return;
          }
        },
      );
    });
  }


  return {
    initAsPromised,
    queueTabForSuspension,
    queueTabForSuspensionAsPromise,
    unqueueTabForSuspension,
    handlePreviewImageResponse,
    saveSuspendData,
    checkTabEligibilityForSuspension,
    executeTabSuspension,
    getQueuedTabDetails,
  };
})();
