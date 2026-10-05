import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createChromeStub } from './setup/chrome-stub.js';
import {
  NORMAL_URL, QUEUE_CHECK_INTERVAL, JOB_TIMEOUT, CANCELLED,
  makeTab, suspendedUrlOf, installFakeTimers, installSuspensionFakes, flush, track, deferred, advance, setOptions, queueAndRun, withLastError,
} from './setup/suspend-manager-harness.js';

// Characterisation of the suspension flow of gsTabSuspendManager with screen capture on:
// the native capture path and the renderer path, the latter completed by
// handlePreviewImageResponse(). The flow is driven through queueTabForSuspensionAsPromise()
// after initAsPromised(), inside the real queue. A case whose name ends in
// "(defect: see comment)" or "(oddity: see comment)" is expected to change when the
// behaviour it describes is fixed.
//
// NOT covered here: the function that requestGeneratePreviewImage() injects into the page,
// the one that drives snapdom and reads the canvas. It needs a DOM and a real renderer and
// belongs to the end-to-end suite. These cases capture the injection (the file, the
// function, its arguments and the token among them) and never run the function.
//
// Also not covered: gsPrecapture itself. captureVisibleTab() and take() are replaced by
// spies, so nothing here says when a native capture succeeds, only what the flow does with
// what it is given. Previews are "stored" through a spy on gsIndexedDb.addPreviewImage;
// there is no IndexedDB. The chrome.* calls the flow makes are installed on the fresh stub
// by installSuspensionFakes(), see setup/suspend-manager-harness.js.
//
// In production the preview response arrives as a 'savePreviewData' message, and
// background.js calls handlePreviewImageResponse(sender.tab, ...). The cases call it
// directly, with a tab object of their own in place of sender.tab.

const YOUTUBE_URL = 'https://www.youtube.com/watch?v=abc123';
const SUSPENDED_URL = suspendedUrlOf(NORMAL_URL, 'Example', '0');
const PREVIEW = 'data:image/webp;base64,UklGRg==';
const NATIVE_PREVIEW = 'data:image/jpeg;base64,/9j/4A==';
const PRECAPTURE = 'data:image/jpeg;base64,cHJl';
const RENDER_TIMEOUT = 20 * 1000;
const RENDER_TIMEOUT_HIGH_QUALITY = 45 * 1000;

let originalChrome;
let gsStorage;
let gsUtils;
let gsIndexedDb;
let gsPrecapture;
let gsTabDiscardManager;
let gsTabCheckManager;
let tgs;
let manager;
let warning;

// The queue reads the capture options when it is built, so they are set before init.
async function start(options) {
  await setOptions(gsStorage, options);
  await manager.initAsPromised();
}

const suspend = (tab, forceLevel) => queueAndRun(manager, tab, forceLevel);

// What background.js does on a 'savePreviewData' message. The flush lets the promise of
// the queued job, which settles inside the call, reach the outcome that tracks it.
async function respond(tab, previewUrl, errorMsg, previewToken) {
  const result = await manager.handlePreviewImageResponse(tab, previewUrl, errorMsg, previewToken);
  await flush();
  return result;
}

function injections() {
  return chrome.scripting.executeScript.mock.calls.map((call) => call[0]);
}

// The injections of the capture function, which takes three arguments. The one of the
// YouTube timestamp takes none.
function captureInjections() {
  return injections().filter((injection) => injection.func && injection.args.length === 3);
}

// The token the renderer was last given, read from the arguments of the capture function.
function injectedToken() {
  return captureInjections().at(-1).args[2];
}

function warnings(text) {
  return warning.mock.calls.filter((call) => call[2] === text);
}

function expectSuspended(outcome, url = SUSPENDED_URL) {
  expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
  expect(chrome.tabs.update).toHaveBeenCalledWith(5, { url }, expect.any(Function));
  expect(outcome).toEqual({ state: 'resolved', value: true });
}

beforeEach(async () => {
  originalChrome = globalThis.chrome;
  installFakeTimers();
  vi.resetModules();
  globalThis.chrome = createChromeStub();
  installSuspensionFakes();

  ({ gsStorage } = await import('../src/js/gsStorage.js'));
  ({ gsUtils } = await import('../src/js/gsUtils.js'));
  ({ gsIndexedDb } = await import('../src/js/gsIndexedDb.js'));
  ({ gsPrecapture } = await import('../src/js/gsPrecapture.js'));
  ({ gsTabDiscardManager } = await import('../src/js/gsTabDiscardManager.js'));
  ({ tgs } = await import('../src/js/tgs.js'));
  ({ gsTabCheckManager } = await import('../src/js/gsTabCheckManager.js'));
  ({ gsTabSuspendManager: manager } = await import('../src/js/gsTabSuspendManager.js'));

  warning = vi.spyOn(gsUtils, 'warning');
  vi.spyOn(gsIndexedDb, 'addSuspendedTabInfo').mockResolvedValue(undefined);
  vi.spyOn(gsIndexedDb, 'fetchTabInfo').mockResolvedValue(null);
  vi.spyOn(gsIndexedDb, 'addPreviewImage').mockResolvedValue(undefined);
  vi.spyOn(gsPrecapture, 'captureVisibleTab').mockResolvedValue(null);
  vi.spyOn(gsPrecapture, 'take').mockResolvedValue(null);
  vi.spyOn(gsTabCheckManager, 'unqueueTabCheck').mockImplementation(() => {});
  vi.spyOn(gsTabDiscardManager, 'queueTabForDiscard').mockImplementation(() => {});
  vi.spyOn(tgs, 'isCurrentFocusedTab').mockResolvedValue(false);
  vi.spyOn(tgs, 'isCharging').mockResolvedValue(undefined);
  // The real one waits up to 3 seconds for a cache that nothing seeds here.
  vi.spyOn(tgs, 'getLastTabGroupKey').mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  globalThis.chrome = originalChrome;
});

// Holding points shared by the native and the renderer path: each holds the flow at one
// await, returns what lets it go on, and what must not have happened afterwards (the first
// thing the flow does past the check that follows that await).
function holdPreviewSave() {
  const held = deferred();
  gsIndexedDb.addPreviewImage.mockReturnValue(held.promise);
  return {
    release: () => held.resolve(),
    notReached: () => chrome.tabs.get,
  };
}

function holdTabRefetch() {
  let answer;
  chrome.tabs.get.mockImplementation((tabId, callback) => { answer = callback; });
  return {
    release: () => answer(makeTab()),
    notReached: () => gsTabCheckManager.unqueueTabCheck,
  };
}

function holdStateWrite() {
  const held = deferred();
  vi.spyOn(tgs, 'setTabStatePropForTabId').mockReturnValue(held.promise);
  return {
    release: () => held.resolve(),
    notReached: () => chrome.tabs.update,
  };
}

describe('which capture is tried first', () => {
  // Columns: capture mode, capture method, native capture tried, renderer injected.
  it.each([
    ['1', 'native', true, false],
    ['2', 'native', true, false],
    ['1', 'auto', true, true],
    ['2', 'auto', false, true],
    ['1', 'renderer', false, true],
    ['2', 'renderer', false, true],
  ])('with mode %j and method %j: native capture %j, renderer %j, when the native capture gives nothing', async (mode, method, native, renderer) => {
    await start({ SCREEN_CAPTURE: mode, SCREEN_CAPTURE_METHOD: method });
    const tab = makeTab();
    const outcome = await suspend(tab, 1);
    expect(gsPrecapture.captureVisibleTab).toHaveBeenCalledTimes(native ? 1 : 0);
    expect(gsPrecapture.take).toHaveBeenCalledTimes(native ? 1 : 0);
    expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(renderer ? 2 : 0);
    expect(outcome.state).toBe(renderer ? 'pending' : 'resolved');
    manager.unqueueTabForSuspension(tab);
    await flush();
  });

  it('captures nothing with discard in place of suspend, and queues the tab for discard', async () => {
    await start({ SCREEN_CAPTURE: '2', SCREEN_CAPTURE_METHOD: 'auto', DISCARD_IN_PLACE_OF_SUSPEND: true });
    const tab = makeTab();
    const outcome = await suspend(tab, 1);
    expect(gsPrecapture.captureVisibleTab).not.toHaveBeenCalled();
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(gsTabDiscardManager.queueTabForDiscard).toHaveBeenCalledWith(tab);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(outcome).toEqual({ state: 'resolved', value: true });
  });

  // With capture off the same tab is suspended at once: see the flow test file.
  it('waits 3 seconds for a loading tab even when tab info was saved for its url', async () => {
    await start({ SCREEN_CAPTURE: '1', SCREEN_CAPTURE_METHOD: 'native' });
    gsIndexedDb.fetchTabInfo.mockResolvedValue({ title: 'Saved title', url: NORMAL_URL });
    const tab = makeTab({ status: 'loading' });
    const outcome = await suspend(tab, 1);
    expect(outcome.state).toBe('pending');
    expect(manager.getQueuedTabDetails(tab)).toMatchObject({ status: 'sleeping', executionProps: { refetchTab: true } });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    manager.unqueueTabForSuspension(tab);
    await flush();
  });
});

describe('native capture path', () => {
  beforeEach(async () => {
    await start({ SCREEN_CAPTURE: '1', SCREEN_CAPTURE_METHOD: 'native' });
  });

  it('stores the capture under the url of the tab, checks the live tab, suspends and resolves true', async () => {
    gsPrecapture.captureVisibleTab.mockResolvedValue(NATIVE_PREVIEW);
    const tab = makeTab();
    const outcome = await suspend(tab, 1);

    expect(gsPrecapture.captureVisibleTab).toHaveBeenCalledWith(tab);
    expect(gsPrecapture.take).not.toHaveBeenCalled();
    expect(gsIndexedDb.addPreviewImage).toHaveBeenCalledTimes(1);
    expect(gsIndexedDb.addPreviewImage).toHaveBeenCalledWith(NORMAL_URL, NATIVE_PREVIEW);
    expect(chrome.tabs.get).toHaveBeenCalledTimes(1);
    expect(gsIndexedDb.addPreviewImage.mock.invocationCallOrder[0]).toBeLessThan(chrome.tabs.get.mock.invocationCallOrder[0]);
    expectSuspended(outcome);
    expect(manager.getQueuedTabDetails(tab)).toBeUndefined();
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('takes the pre-capture of the tab and url when the capture gives nothing', async () => {
    gsPrecapture.take.mockResolvedValue(PRECAPTURE);
    const outcome = await suspend(makeTab(), 1);
    expect(gsPrecapture.take).toHaveBeenCalledWith(5, NORMAL_URL);
    expect(gsIndexedDb.addPreviewImage).toHaveBeenCalledWith(NORMAL_URL, PRECAPTURE);
    expectSuspended(outcome);
  });

  it('suspends without a preview when neither gives anything', async () => {
    const outcome = await suspend(makeTab(), 1);
    expect(gsIndexedDb.addPreviewImage).not.toHaveBeenCalled();
    expect(chrome.tabs.get).toHaveBeenCalledTimes(1);
    expectSuspended(outcome);
  });

  // The preview is stored before the live tab is looked at, so it stays in the store,
  // under the url the tab has left.
  it.each([
    ['has navigated', makeTab({ url: 'https://example.com/other' })],
    ['is gone', undefined],
  ])('resolves false when the live tab %s, the preview being stored already (oddity: see comment)', async (label, liveTab) => {
    gsPrecapture.captureVisibleTab.mockResolvedValue(NATIVE_PREVIEW);
    chrome.tabs.get.mockImplementation((tabId, callback) => callback(liveTab));
    const outcome = await suspend(makeTab(), 1);
    expect(gsIndexedDb.addPreviewImage).toHaveBeenCalledWith(NORMAL_URL, NATIVE_PREVIEW);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(outcome).toEqual({ state: 'resolved', value: false });
  });

  it('resolves false when the live tab is no longer eligible, judged on the live tab', async () => {
    gsPrecapture.captureVisibleTab.mockResolvedValue(NATIVE_PREVIEW);
    chrome.tabs.get.mockImplementation((tabId, callback) => callback(makeTab({ pinned: true })));
    const tab = makeTab();
    const outcome = await suspend(tab, 2);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(outcome).toEqual({ state: 'resolved', value: false });
    expect(manager.getQueuedTabDetails(tab)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('suspends a tab the queued snapshot of which is not eligible when the live tab is', async () => {
    gsPrecapture.captureVisibleTab.mockResolvedValue(NATIVE_PREVIEW);
    const tab = makeTab();
    const outcome = track(manager.queueTabForSuspensionAsPromise(tab, 2));
    await flush();
    tab.pinned = true;
    await advance(QUEUE_CHECK_INTERVAL);
    expectSuspended(outcome);
  });

  // The native capture has succeeded by the time the shared holding points are reached.
  const afterCapture = (hold) => () => {
    gsPrecapture.captureVisibleTab.mockResolvedValue(NATIVE_PREVIEW);
    return hold();
  };
  const holdingPoints = [
    ['the capture', () => {
      const held = deferred();
      gsPrecapture.captureVisibleTab.mockReturnValue(held.promise);
      return {
        release: () => held.resolve(NATIVE_PREVIEW),
        notReached: () => gsIndexedDb.addPreviewImage,
      };
    }],
    ['the saving of the preview', afterCapture(holdPreviewSave)],
    ['the refetch of the tab', afterCapture(holdTabRefetch)],
    ['the state write of the suspension', afterCapture(holdStateWrite)],
  ];

  it.each(holdingPoints)('goes no further for a tab unqueued during %s', async (label, arrange) => {
    const { release, notReached } = arrange();
    const tab = makeTab();
    const outcome = await suspend(tab, 1);
    expect(outcome.state).toBe('pending');

    manager.unqueueTabForSuspension(tab);
    release();
    await flush();
    expect(outcome).toEqual({ state: 'rejected', value: CANCELLED });
    expect(notReached()).not.toHaveBeenCalled();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(holdingPoints)('goes no further for a job superseded during %s, and leaves the new job queued', async (label, arrange) => {
    const { release, notReached } = arrange();
    const tab = makeTab();
    const first = await suspend(tab, 1);
    manager.unqueueTabForSuspension(tab);
    const second = track(manager.queueTabForSuspensionAsPromise(makeTab(), 1));
    await flush();

    release();
    await flush();
    expect(first).toEqual({ state: 'rejected', value: CANCELLED });
    expect(second.state).toBe('pending');
    expect(manager.getQueuedTabDetails(tab)).toMatchObject({ status: 'queued' });
    expect(notReached()).not.toHaveBeenCalled();
    expect(chrome.tabs.update).not.toHaveBeenCalled();

    manager.unqueueTabForSuspension(tab);
    await flush();
    expect(second).toEqual({ state: 'rejected', value: CANCELLED });
  });

  // The preview is stored under the url with the timestamp, the one the suspended tab will
  // carry, while the live tab is compared with the url the tab really has.
  it('stores the capture of a YouTube tab under the url with the timestamp', async () => {
    chrome.scripting.executeScript.mockImplementationOnce((injection, callback) => callback([{ result: 83 }]));
    chrome.tabs.get.mockImplementation((tabId, callback) => callback(makeTab({ url: YOUTUBE_URL })));
    gsPrecapture.take.mockResolvedValue(PRECAPTURE);
    const outcome = await suspend(makeTab({ url: YOUTUBE_URL }), 1);
    const timestamped = `${YOUTUBE_URL}&t=83s`;
    expect(gsPrecapture.take).toHaveBeenCalledWith(5, YOUTUBE_URL);
    expect(gsIndexedDb.addPreviewImage).toHaveBeenCalledWith(timestamped, PRECAPTURE);
    expectSuspended(outcome, suspendedUrlOf(timestamped, 'Example', '0'));
  });
});

describe('automatic method falling back to the renderer', () => {
  it('injects the renderer when the native capture gives nothing, and does not try the native capture again', async () => {
    await start({ SCREEN_CAPTURE: '1', SCREEN_CAPTURE_METHOD: 'auto' });
    const tab = makeTab();
    const outcome = await suspend(tab, 1);
    expect(gsPrecapture.captureVisibleTab).toHaveBeenCalledTimes(1);
    expect(gsPrecapture.take).toHaveBeenCalledTimes(1);
    expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(2);
    expect(chrome.tabs.get).not.toHaveBeenCalled();
    expect(manager.getQueuedTabDetails(tab).executionProps).toMatchObject({ nativeCaptureTried: true });
    expect(outcome.state).toBe('pending');

    await respond(makeTab(), null, 'Canvas contains no visible pixels', injectedToken());
    expect(gsPrecapture.captureVisibleTab).toHaveBeenCalledTimes(1);
    expect(gsPrecapture.take).toHaveBeenCalledTimes(1);
    expect(gsIndexedDb.addPreviewImage).not.toHaveBeenCalled();
    expectSuspended(outcome);
  });

  it('suspends with the native capture when there is one, the renderer not being injected', async () => {
    await start({ SCREEN_CAPTURE: '1', SCREEN_CAPTURE_METHOD: 'auto' });
    gsPrecapture.captureVisibleTab.mockResolvedValue(NATIVE_PREVIEW);
    const outcome = await suspend(makeTab(), 1);
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(gsIndexedDb.addPreviewImage).toHaveBeenCalledWith(NORMAL_URL, NATIVE_PREVIEW);
    expectSuspended(outcome);
  });
});

describe('renderer path', () => {
  beforeEach(async () => {
    await start({ SCREEN_CAPTURE: '2', SCREEN_CAPTURE_METHOD: 'renderer' });
  });

  it('injects the library, then the capture function with the mode, the force option and a token', async () => {
    const tab = makeTab();
    const outcome = await suspend(tab, 1);
    expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(2);
    expect(chrome.scripting.executeScript).toHaveBeenNthCalledWith(
      1,
      { target: { tabId: 5 }, files: ['js/snapdom.js'] },
      expect.any(Function),
    );
    expect(chrome.scripting.executeScript).toHaveBeenNthCalledWith(
      2,
      { target: { tabId: 5 }, func: expect.any(Function), args: ['2', false, 1] },
      expect.any(Function),
    );
    expect(outcome.state).toBe('pending');
    expect(manager.isSuspensionInProgress(tab)).toBe(true);
    expect(manager.getQueuedTabDetails(tab).executionProps).toEqual({
      forceLevel: 1,
      precaptureUrl: NORMAL_URL,
      suspendedUrl: SUSPENDED_URL,
      resolveFn: expect.any(Function),
    });
    expect(gsIndexedDb.addSuspendedTabInfo).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    manager.unqueueTabForSuspension(tab);
    await flush();
  });

  it('gives every request a token of its own', async () => {
    const first = makeTab();
    const second = makeTab({ id: 6 });
    const outcomes = [track(manager.queueTabForSuspensionAsPromise(first, 1)), track(manager.queueTabForSuspensionAsPromise(second, 1))];
    await flush();
    await advance(QUEUE_CHECK_INTERVAL);
    const tokens = captureInjections().map((injection) => [injection.target.tabId, injection.args[2]]);
    expect(tokens).toEqual([[5, 1], [6, 2]]);
    manager.unqueueTabForSuspension(first);
    manager.unqueueTabForSuspension(second);
    await flush();
    expect(outcomes.map((outcome) => outcome.state)).toEqual(['rejected', 'rejected']);
  });

  it('stores the preview of a response with the right token, checks the live tab, suspends and resolves true', async () => {
    const tab = makeTab();
    const outcome = await suspend(tab, 1);
    await expect(respond(makeTab(), PREVIEW, undefined, injectedToken())).resolves.toBeUndefined();

    expect(gsIndexedDb.addPreviewImage).toHaveBeenCalledTimes(1);
    expect(gsIndexedDb.addPreviewImage).toHaveBeenCalledWith(NORMAL_URL, PREVIEW);
    expect(chrome.tabs.get).toHaveBeenCalledTimes(1);
    expectSuspended(outcome);
    expect(manager.getQueuedTabDetails(tab)).toBeUndefined();
    expect(gsPrecapture.captureVisibleTab).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
    // The render timeout has been cleared, and so has the job timeout.
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['a token that was never given', () => injectedToken() + 1],
    ['no token', () => undefined],
    ['the token as a string', () => String(injectedToken())],
  ])('ignores a response with %s, and the job goes on waiting', async (label, token) => {
    const tab = makeTab();
    const outcome = await suspend(tab, 1);
    await respond(makeTab(), PREVIEW, undefined, token());
    expect(gsIndexedDb.addPreviewImage).not.toHaveBeenCalled();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(outcome.state).toBe('pending');

    await respond(makeTab(), PREVIEW, undefined, injectedToken());
    expectSuspended(outcome);
  });

  it('ignores the response to a job that was unqueued and queued again, and takes the one to the new job', async () => {
    const tab = makeTab();
    const first = await suspend(tab, 1);
    manager.unqueueTabForSuspension(tab);
    const second = await suspend(makeTab(), 1);
    expect(first).toEqual({ state: 'rejected', value: CANCELLED });
    const tokens = captureInjections().map((injection) => injection.args[2]);
    expect(tokens).toEqual([1, 2]);

    await respond(makeTab(), 'data:image/webp;base64,c3RhbGU=', undefined, 1);
    expect(gsIndexedDb.addPreviewImage).not.toHaveBeenCalled();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(second.state).toBe('pending');

    await respond(makeTab(), PREVIEW, undefined, 2);
    expect(gsIndexedDb.addPreviewImage).toHaveBeenCalledWith(NORMAL_URL, PREVIEW);
    expectSuspended(second);
  });

  it('ignores a response for a tab that is not queued', async () => {
    const outcome = await suspend(makeTab(), 1);
    await expect(respond(makeTab({ id: 77 }), PREVIEW, undefined, injectedToken())).resolves.toBeUndefined();
    expect(gsIndexedDb.addPreviewImage).not.toHaveBeenCalled();
    expect(chrome.tabs.get).not.toHaveBeenCalled();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(outcome.state).toBe('pending');

    await respond(makeTab(), PREVIEW, undefined, injectedToken());
    expectSuspended(outcome);
  });

  it('ignores a response with the right token once the tab has been unqueued', async () => {
    const tab = makeTab();
    const outcome = await suspend(tab, 1);
    const token = injectedToken();
    // The job timeout and the render timeout.
    expect(vi.getTimerCount()).toBe(2);
    manager.unqueueTabForSuspension(tab);
    // Unqueueing cleared both.
    expect(vi.getTimerCount()).toBe(0);
    await respond(makeTab(), PREVIEW, undefined, token);
    expect(outcome).toEqual({ state: 'rejected', value: CANCELLED });
    expect(gsIndexedDb.addPreviewImage).not.toHaveBeenCalled();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  // Reached here by building the queue a second time, which drops the first queue without
  // touching the request that is in flight: the manager then looks for the tab in the new
  // queue. The job of the first queue is left to its timeout.
  it('ignores a response with the right token when the tab is not in the queue, the queue having been rebuilt', async () => {
    const outcome = await suspend(makeTab(), 1);
    const token = injectedToken();
    await manager.initAsPromised();
    await expect(respond(makeTab(), PREVIEW, undefined, token)).resolves.toBeUndefined();
    expect(gsIndexedDb.addPreviewImage).not.toHaveBeenCalled();
    expect(chrome.tabs.get).not.toHaveBeenCalled();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(outcome.state).toBe('pending');
  });

  // As above, with the tab queued again in the new queue: the token is the one of the
  // request in flight, the job found under the tab id is another one.
  it('ignores a response with the right token when the job queued for the tab is another one, the queue having been rebuilt', async () => {
    const first = await suspend(makeTab(), 1);
    const token = injectedToken();
    await manager.initAsPromised();
    const tab = makeTab();
    const second = track(manager.queueTabForSuspensionAsPromise(tab, 1));
    await flush();
    expect(manager.getQueuedTabDetails(tab)).toMatchObject({ status: 'queued' });

    await expect(respond(makeTab(), PREVIEW, undefined, token)).resolves.toBeUndefined();
    expect(gsIndexedDb.addPreviewImage).not.toHaveBeenCalled();
    expect(chrome.tabs.get).not.toHaveBeenCalled();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(first.state).toBe('pending');
    expect(second.state).toBe('pending');

    manager.unqueueTabForSuspension(tab);
    await flush();
    expect(second).toEqual({ state: 'rejected', value: CANCELLED });
  });

  it('suspends without a preview, with a warning, when the response carries an error message', async () => {
    const outcome = await suspend(makeTab(), 1);
    await respond(makeTab(), undefined, 'Canvas contains no visible pixels', injectedToken());
    expect(warning).toHaveBeenCalledWith(5, 'suspensionQueue', 'savePreviewData reported an error: ', 'Canvas contains no visible pixels');
    expect(gsPrecapture.captureVisibleTab).not.toHaveBeenCalled();
    expect(gsIndexedDb.addPreviewImage).not.toHaveBeenCalled();
    expectSuspended(outcome);
  });

  // The preview wins: the error message is not looked at when there is a preview.
  it('stores the preview of a response that carries both a preview and an error message', async () => {
    const outcome = await suspend(makeTab(), 1);
    await respond(makeTab(), PREVIEW, 'ignored', injectedToken());
    expect(warning).not.toHaveBeenCalled();
    expect(gsIndexedDb.addPreviewImage).toHaveBeenCalledWith(NORMAL_URL, PREVIEW);
    expectSuspended(outcome);
  });

  // The preview is stored under the url with the timestamp, the one the suspended tab will
  // carry, while the live tab is compared with the url the tab really has.
  it('stores the preview of a YouTube tab under the url with the timestamp', async () => {
    chrome.scripting.executeScript.mockImplementationOnce((injection, callback) => callback([{ result: 83 }]));
    chrome.tabs.get.mockImplementation((tabId, callback) => callback(makeTab({ url: YOUTUBE_URL })));
    const outcome = await suspend(makeTab({ url: YOUTUBE_URL }), 1);
    const timestamped = `${YOUTUBE_URL}&t=83s`;
    expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(3);

    await respond(makeTab({ url: YOUTUBE_URL }), PREVIEW, undefined, injectedToken());
    expect(gsIndexedDb.addPreviewImage).toHaveBeenCalledWith(timestamped, PREVIEW);
    expectSuspended(outcome, suspendedUrlOf(timestamped, 'Example', '0'));
  });

  // The preview is stored before the live tab is looked at, so it stays in the store.
  it.each([
    ['has navigated', makeTab({ url: 'https://example.com/other' })],
    ['is gone', undefined],
  ])('resolves false when the live tab %s, the preview being stored already (oddity: see comment)', async (label, liveTab) => {
    chrome.tabs.get.mockImplementation((tabId, callback) => callback(liveTab));
    const outcome = await suspend(makeTab(), 1);
    await respond(makeTab(), PREVIEW, undefined, injectedToken());
    expect(gsIndexedDb.addPreviewImage).toHaveBeenCalledWith(NORMAL_URL, PREVIEW);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(outcome).toEqual({ state: 'resolved', value: false });
  });

  it('resolves false when the live tab is no longer eligible', async () => {
    chrome.tabs.get.mockImplementation((tabId, callback) => callback(makeTab({ pinned: true })));
    const tab = makeTab();
    const outcome = await suspend(tab, 2);
    await respond(makeTab(), PREVIEW, undefined, injectedToken());
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(outcome).toEqual({ state: 'resolved', value: false });
    expect(manager.getQueuedTabDetails(tab)).toBeUndefined();
  });

  // This first eligibility check is made on the tab that came with the response. When it
  // fails the function logs "Removing tab from suspensionQueue" and returns: it removes
  // nothing and settles nothing. The request is forgotten, so a later response is ignored
  // as well, and the job stays in progress until the queue times it out, 60 seconds after
  // it started. The timeout handler then suspends the tab with no eligibility check: here
  // the tab as queued is not eligible either by then, and chrome is not asked for the tab.
  // Compare with the case above, where the same finding on the live tab resolves false.
  it('leaves the job unsettled when the tab of the response is not eligible, and the job timeout then suspends the tab (defect: see comment)', async () => {
    const tab = makeTab();
    const outcome = await suspend(tab, 2);
    const token = injectedToken();
    const pinned = makeTab({ pinned: true });
    tab.pinned = true;
    await expect(manager.checkTabEligibilityForSuspension(pinned, 2)).resolves.toBe(false);
    await expect(manager.checkTabEligibilityForSuspension(tab, 2)).resolves.toBe(false);

    await expect(respond(pinned, PREVIEW, undefined, token)).resolves.toBeUndefined();
    expect(outcome.state).toBe('pending');
    expect(manager.isSuspensionInProgress(tab)).toBe(true);
    expect(gsIndexedDb.addPreviewImage).not.toHaveBeenCalled();
    expect(chrome.tabs.get).not.toHaveBeenCalled();
    expect(chrome.tabs.update).not.toHaveBeenCalled();

    // The render timeout was cleared and the request forgotten.
    await respond(makeTab(), PREVIEW, undefined, token);
    await advance(RENDER_TIMEOUT);
    expect(outcome.state).toBe('pending');
    expect(chrome.tabs.update).not.toHaveBeenCalled();

    await advance(JOB_TIMEOUT - RENDER_TIMEOUT - 1);
    expect(outcome.state).toBe('pending');
    expect(chrome.tabs.update).not.toHaveBeenCalled();

    await advance(1);
    expectSuspended(outcome);
    expect(gsIndexedDb.addPreviewImage).not.toHaveBeenCalled();
    expect(chrome.tabs.get).not.toHaveBeenCalled();
    expect(manager.getQueuedTabDetails(tab)).toBeUndefined();
  });

  // Columns: label, force level, preview of the response, arrangement.
  //
  // After the saving of the preview the source checks twice, with no await in between:
  // once right after the save and once before the suspension. The case cannot tell which
  // of the two stopped the flow, so either can be removed without it failing.
  //
  // The first row sends no preview. With one, see the case after these.
  const holdingPoints = [
    ['the first eligibility check', 2, undefined, () => {
      const held = deferred();
      tgs.isCurrentFocusedTab.mockReturnValueOnce(held.promise);
      return {
        release: () => held.resolve(false),
        notReached: () => chrome.tabs.get,
      };
    }],
    ['the saving of the preview', 1, PREVIEW, holdPreviewSave],
    ['the refetch of the tab', 1, PREVIEW, holdTabRefetch],
    ['the state write of the suspension', 1, PREVIEW, holdStateWrite],
  ];

  it.each(holdingPoints)('goes no further for a tab unqueued during %s', async (label, forceLevel, preview, arrange) => {
    const tab = makeTab();
    const outcome = await suspend(tab, forceLevel);
    const { release, notReached } = arrange();
    const handled = manager.handlePreviewImageResponse(makeTab(), preview, undefined, injectedToken());
    await flush();
    expect(outcome.state).toBe('pending');

    manager.unqueueTabForSuspension(tab);
    release();
    await handled;
    await flush();
    expect(outcome).toEqual({ state: 'rejected', value: CANCELLED });
    expect(notReached()).not.toHaveBeenCalled();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('renderer path, a preview and a job cancelled at the first check', () => {
  beforeEach(async () => {
    await start({ SCREEN_CAPTURE: '2', SCREEN_CAPTURE_METHOD: 'renderer' });
  });

  // Nothing looks at the queue between the first eligibility check and the saving of the
  // preview, so the preview of a job cancelled during that check is stored all the same.
  // The check after the save then stops the flow.
  it('stores the preview of a job unqueued during the first eligibility check (oddity: see comment)', async () => {
    const tab = makeTab();
    const outcome = await suspend(tab, 2);
    const held = deferred();
    tgs.isCurrentFocusedTab.mockReturnValueOnce(held.promise);
    const handled = manager.handlePreviewImageResponse(makeTab(), PREVIEW, undefined, injectedToken());
    await flush();

    manager.unqueueTabForSuspension(tab);
    held.resolve(false);
    await handled;
    await flush();
    expect(outcome).toEqual({ state: 'rejected', value: CANCELLED });
    expect(gsIndexedDb.addPreviewImage).toHaveBeenCalledTimes(1);
    expect(gsIndexedDb.addPreviewImage).toHaveBeenCalledWith(NORMAL_URL, PREVIEW);
    expect(chrome.tabs.get).not.toHaveBeenCalled();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });
});

describe('renderer path with the automatic method', () => {
  beforeEach(async () => {
    await start({ SCREEN_CAPTURE: '2', SCREEN_CAPTURE_METHOD: 'auto' });
  });

  it('tries the native capture when the response carries no preview, and stores what it gives', async () => {
    const outcome = await suspend(makeTab(), 1);
    expect(gsPrecapture.captureVisibleTab).not.toHaveBeenCalled();
    gsPrecapture.captureVisibleTab.mockResolvedValue(NATIVE_PREVIEW);
    const responseTab = makeTab();

    await respond(responseTab, undefined, 'Failed to generate dataUrl', injectedToken());
    expect(gsPrecapture.captureVisibleTab).toHaveBeenCalledTimes(1);
    expect(gsPrecapture.captureVisibleTab).toHaveBeenCalledWith(responseTab);
    expect(gsIndexedDb.addPreviewImage).toHaveBeenCalledWith(NORMAL_URL, NATIVE_PREVIEW);
    expectSuspended(outcome);
  });

  it('takes the pre-capture when the fallback capture gives nothing, and suspends without a preview when neither does', async () => {
    const outcome = await suspend(makeTab(), 1);
    await respond(makeTab(), undefined, 'Failed to generate dataUrl', injectedToken());
    expect(gsPrecapture.take).toHaveBeenCalledWith(5, NORMAL_URL);
    expect(gsIndexedDb.addPreviewImage).not.toHaveBeenCalled();
    expectSuspended(outcome);
  });

  // The pre-capture is looked up under the url the tab had, not under the url with the
  // timestamp that the tab object carries by then.
  it('takes the pre-capture of a YouTube tab under the url without the timestamp', async () => {
    chrome.scripting.executeScript.mockImplementationOnce((injection, callback) => callback([{ result: 83 }]));
    chrome.tabs.get.mockImplementation((tabId, callback) => callback(makeTab({ url: YOUTUBE_URL })));
    gsPrecapture.take.mockResolvedValue(PRECAPTURE);
    const outcome = await suspend(makeTab({ url: YOUTUBE_URL }), 1);
    const timestamped = `${YOUTUBE_URL}&t=83s`;

    await respond(makeTab({ url: YOUTUBE_URL }), undefined, 'Failed to generate dataUrl', injectedToken());
    expect(gsPrecapture.take).toHaveBeenCalledTimes(1);
    expect(gsPrecapture.take).toHaveBeenCalledWith(5, YOUTUBE_URL);
    expect(gsIndexedDb.addPreviewImage).toHaveBeenCalledWith(timestamped, PRECAPTURE);
    expectSuspended(outcome, suspendedUrlOf(timestamped, 'Example', '0'));
  });

  it('resolves false, storing nothing, when the tab has navigated during the fallback capture', async () => {
    const outcome = await suspend(makeTab(), 1);
    gsPrecapture.captureVisibleTab.mockResolvedValue(NATIVE_PREVIEW);
    chrome.tabs.get.mockImplementation((tabId, callback) => callback(makeTab({ url: 'https://example.com/other' })));
    await respond(makeTab(), undefined, 'Failed to generate dataUrl', injectedToken());
    expect(chrome.tabs.get).toHaveBeenCalledTimes(1);
    expect(gsIndexedDb.addPreviewImage).not.toHaveBeenCalled();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(outcome).toEqual({ state: 'resolved', value: false });
  });

  it('resolves false, storing nothing, when the live tab is no longer eligible after the fallback capture', async () => {
    const outcome = await suspend(makeTab(), 2);
    gsPrecapture.captureVisibleTab.mockResolvedValue(NATIVE_PREVIEW);
    chrome.tabs.get.mockImplementation((tabId, callback) => callback(makeTab({ pinned: true })));
    await respond(makeTab(), undefined, 'Failed to generate dataUrl', injectedToken());
    expect(chrome.tabs.get).toHaveBeenCalledTimes(1);
    expect(gsIndexedDb.addPreviewImage).not.toHaveBeenCalled();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(outcome).toEqual({ state: 'resolved', value: false });
  });

  it('does not navigate a tab unqueued during the fallback capture', async () => {
    const tab = makeTab();
    const outcome = await suspend(tab, 1);
    const held = deferred();
    gsPrecapture.captureVisibleTab.mockReturnValue(held.promise);
    const handled = manager.handlePreviewImageResponse(makeTab(), undefined, 'Failed to generate dataUrl', injectedToken());
    await flush();

    manager.unqueueTabForSuspension(tab);
    held.resolve(NATIVE_PREVIEW);
    await handled;
    expect(outcome).toEqual({ state: 'rejected', value: CANCELLED });
    expect(chrome.tabs.get).not.toHaveBeenCalled();
    expect(gsIndexedDb.addPreviewImage).not.toHaveBeenCalled();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });
});

describe('render timeout', () => {
  // Columns: force option, render timeout, arguments of the injected function.
  it.each([
    [false, RENDER_TIMEOUT, ['1', false, 1]],
    [true, RENDER_TIMEOUT_HIGH_QUALITY, ['1', true, 1]],
  ])('with force %j answers for the page after %i ms, and the tab is suspended without a preview', async (force, timeout, args) => {
    await start({ SCREEN_CAPTURE: '1', SCREEN_CAPTURE_METHOD: 'renderer', SCREEN_CAPTURE_FORCE: force });
    const tab = makeTab();
    const outcome = await suspend(tab, 1);
    expect(injections()[1].args).toEqual(args);

    await advance(timeout - 1);
    expect(outcome.state).toBe('pending');
    expect(warning).not.toHaveBeenCalled();
    expect(chrome.tabs.update).not.toHaveBeenCalled();

    await advance(1);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(5, 'suspensionQueue', 'savePreviewData reported an error: ', `Preview render timed out after ${timeout}ms`);
    expect(gsIndexedDb.addPreviewImage).not.toHaveBeenCalled();
    expectSuspended(outcome);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores the response of the page that comes after the timeout', async () => {
    await start({ SCREEN_CAPTURE: '1', SCREEN_CAPTURE_METHOD: 'renderer' });
    const outcome = await suspend(makeTab(), 1);
    await advance(RENDER_TIMEOUT);
    expectSuspended(outcome);
    await respond(makeTab(), PREVIEW, undefined, injectedToken());
    expect(gsIndexedDb.addPreviewImage).not.toHaveBeenCalled();
    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
  });

  it('does not fire once the page has answered', async () => {
    await start({ SCREEN_CAPTURE: '1', SCREEN_CAPTURE_METHOD: 'renderer' });
    const outcome = await suspend(makeTab(), 1);
    await respond(makeTab(), PREVIEW, undefined, injectedToken());
    expectSuspended(outcome);
    await advance(2 * RENDER_TIMEOUT);
    expect(warnings('savePreviewData reported an error: ')).toHaveLength(0);
    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
  });
});

describe('injection errors', () => {
  beforeEach(async () => {
    await start({ SCREEN_CAPTURE: '1', SCREEN_CAPTURE_METHOD: 'renderer' });
  });

  it('suspends without a preview when the library cannot be injected, and injects nothing else', async () => {
    chrome.scripting.executeScript.mockImplementation((injection, callback) => {
      withLastError('Cannot access contents of the page.', () => callback(undefined));
    });
    const outcome = await suspend(makeTab(), 1);
    expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(5, 'suspensionQueue', 'savePreviewData reported an error: ', 'Failed to executeScriptOnTab');
    expect(gsIndexedDb.addPreviewImage).not.toHaveBeenCalled();
    expectSuspended(outcome);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('suspends without a preview when the capture function cannot be injected', async () => {
    chrome.scripting.executeScript.mockImplementationOnce((injection, callback) => callback([{ result: undefined }]));
    chrome.scripting.executeScript.mockImplementationOnce((injection, callback) => {
      withLastError('The tab was closed.', () => callback(undefined));
    });
    const outcome = await suspend(makeTab(), 1);
    expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith(
      5,
      'suspensionQueue',
      'savePreviewData reported an error: ',
      'Failed to executeCodeOnTab: generatePreviewImgContentScript',
    );
    expectSuspended(outcome);
    expect(vi.getTimerCount()).toBe(0);
  });
});
