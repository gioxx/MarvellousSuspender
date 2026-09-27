import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createChromeStub, EXTENSION_ID } from './setup/chrome-stub.js';

// Characterisation of gsTabSuspendManager.initAsPromised() and of the queue-facing exports
// around it. A case whose name ends in "(oddity: see comment)" is expected to change when
// the behaviour it describes is fixed.
//
// The queue itself is private to the module. Its properties are observed in two ways, and
// each case says which: through a pass-through spy on gsTabQueue.init (the arguments it was
// given, and getQueueProperties() of the queue it returned), or through behaviour (when the
// job timeout fires).

const NORMAL_URL = 'https://example.com/page';
const REBUILT_SUSPENDED_URL = `chrome-extension://${EXTENSION_ID}/suspended.html#ttl=Example&pos=0&uri=${NORMAL_URL}`;
// gsTabQueue's own PROCESSING_QUEUE_CHECK_INTERVAL, which it does not export: how long
// the queue waits before it starts a job. A change there shows up here.
const QUEUE_CHECK_INTERVAL = 50;

let originalChrome;
let gsStorage;
let gsTabQueue;
let manager;
let initSpy;

function makeTab(overrides = {}) {
  return { id: 5, windowId: 1, url: NORMAL_URL, title: 'Example', status: 'complete', ...overrides };
}

// setImmediate is left real below: it runs once every pending microtask has drained.
const flush = () => new Promise((resolve) => setImmediate(resolve));

// Records how a promise settles without leaving a rejection unhandled.
function track(promise) {
  const outcome = { state: 'pending', value: undefined };
  promise.then(
    (value) => { outcome.state = 'resolved'; outcome.value = value; },
    (error) => { outcome.state = 'rejected'; outcome.value = error; },
  );
  return outcome;
}

beforeEach(async () => {
  originalChrome = globalThis.chrome;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.resetModules();
  globalThis.chrome = createChromeStub();
  chrome.tabs.update = vi.fn((tabId, props, callback) => callback({ id: tabId, ...props }));
  // A content script that never answers keeps a job in progress until something ends it.
  chrome.tabs.sendMessage = vi.fn();

  ({ gsStorage } = await import('../src/js/gsStorage.js'));
  ({ gsTabQueue } = await import('../src/js/gsTabQueue.js'));
  const { gsIndexedDb } = await import('../src/js/gsIndexedDb.js');
  const { gsTabCheckManager } = await import('../src/js/gsTabCheckManager.js');
  ({ gsTabSuspendManager: manager } = await import('../src/js/gsTabSuspendManager.js'));

  initSpy = vi.spyOn(gsTabQueue, 'init');
  vi.spyOn(gsIndexedDb, 'addSuspendedTabInfo').mockResolvedValue(undefined);
  vi.spyOn(gsTabCheckManager, 'unqueueTabCheck').mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  globalThis.chrome = originalChrome;
});

describe('gsTabSuspendManager before initAsPromised', () => {
  // getQueuedTabDetails() returns undefined and so does the STATUS_IN_PROGRESS of a queue
  // that does not exist: undefined === undefined.
  it('reports every tab as having a suspension in progress (oddity: see comment)', () => {
    expect(manager.isSuspensionInProgress(makeTab())).toBe(true);
    expect(manager.isSuspensionInProgress({ id: 999 })).toBe(true);
  });

  it('returns undefined for the queued details of a tab', () => {
    expect(manager.getQueuedTabDetails(makeTab())).toBeUndefined();
  });

  it('returns undefined from unqueueTabForSuspension without throwing', () => {
    expect(manager.unqueueTabForSuspension(makeTab())).toBeUndefined();
  });

  it('resolves undefined for an undefined tab without waiting for init', async () => {
    const outcome = track(manager.queueTabForSuspensionAsPromise(undefined, 1));
    await flush();
    expect(outcome).toEqual({ state: 'resolved', value: undefined });
    expect(initSpy).not.toHaveBeenCalled();
  });

  it('holds a queue request until init, then queues the tab with its force level', async () => {
    const tab = makeTab();
    const outcome = track(manager.queueTabForSuspensionAsPromise(tab, 1));
    await flush();
    expect(outcome.state).toBe('pending');
    expect(manager.getQueuedTabDetails(tab)).toBeUndefined();

    await manager.initAsPromised();
    await flush();
    expect(outcome.state).toBe('pending');
    expect(manager.getQueuedTabDetails(tab)).toMatchObject({
      tab,
      status: 'queued',
      executionProps: { forceLevel: 1 },
    });
  });
});

describe('gsTabSuspendManager.initAsPromised', () => {
  // Observed through the gsTabQueue.init spy.
  it.each([
    ['0', false, 5, 60 * 1000],
    ['1', false, 3, 60 * 1000],
    ['2', false, 3, 60 * 1000],
    ['0', true, 5, 5 * 60 * 1000],
    ['2', true, 3, 5 * 60 * 1000],
  ])('with screen capture %j and force %j builds a queue of %i executors and a %i ms timeout', async (screenCapture, force, executors, timeout) => {
    await gsStorage.setOption(gsStorage.SCREEN_CAPTURE, screenCapture);
    await gsStorage.setOption(gsStorage.SCREEN_CAPTURE_FORCE, force);
    await expect(manager.initAsPromised()).resolves.toBeUndefined();

    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(initSpy).toHaveBeenCalledWith('suspensionQueue', {
      concurrentExecutors: executors,
      jobTimeout: timeout,
      executorFn: expect.any(Function),
      exceptionFn: expect.any(Function),
    });
    const properties = initSpy.mock.results[0].value.getQueueProperties();
    expect(properties).toMatchObject({ concurrentExecutors: executors, jobTimeout: timeout, processingDelay: 500 });
  });

  // The comparison is `=== '0'`, so a numeric 0 is taken for a capturing mode.
  it('gives a numeric 0 screen capture mode the executors of a capturing mode (oddity: see comment)', async () => {
    await gsStorage.setOption(gsStorage.SCREEN_CAPTURE, 0);
    await manager.initAsPromised();
    expect(initSpy.mock.calls[0][1].concurrentExecutors).toBe(3);
  });

  // Observed through the gsTabQueue.init spy. The source carries a TODO saying as much.
  it('does not follow an option changed after init (oddity: see comment)', async () => {
    await manager.initAsPromised();
    await gsStorage.setOption(gsStorage.SCREEN_CAPTURE, '2');
    await gsStorage.setOption(gsStorage.SCREEN_CAPTURE_FORCE, true);
    await flush();
    expect(initSpy).toHaveBeenCalledTimes(1);
    const properties = initSpy.mock.results[0].value.getQueueProperties();
    expect(properties).toMatchObject({ concurrentExecutors: 5, jobTimeout: 60 * 1000 });
  });

  // Observed through behaviour: the content script never answers, so the job only ends
  // when the queue times it out, and the timeout handler suspends the tab regardless.
  it.each([
    [false, 60 * 1000],
    [true, 5 * 60 * 1000],
  ])('with force %j forces the suspension of a stuck job after %i ms', async (force, timeout) => {
    await gsStorage.setOption(gsStorage.SCREEN_CAPTURE_FORCE, force);
    await manager.initAsPromised();
    const tab = makeTab();
    const outcome = track(manager.queueTabForSuspensionAsPromise(tab, 1));
    await flush();

    await vi.advanceTimersByTimeAsync(QUEUE_CHECK_INTERVAL);
    await flush();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
    expect(manager.isSuspensionInProgress(tab)).toBe(true);

    await vi.advanceTimersByTimeAsync(timeout - 1);
    await flush();
    expect(outcome.state).toBe('pending');
    expect(chrome.tabs.update).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(chrome.tabs.update).toHaveBeenCalledWith(5, { url: REBUILT_SUSPENDED_URL }, expect.any(Function));
    expect(outcome).toEqual({ state: 'resolved', value: true });
    expect(manager.getQueuedTabDetails(tab)).toBeUndefined();
  });

  it('reports no suspension in progress for a tab that is not queued', async () => {
    await manager.initAsPromised();
    expect(manager.isSuspensionInProgress(makeTab())).toBe(false);
    expect(manager.getQueuedTabDetails(makeTab())).toBeUndefined();
  });

  it('resolves undefined for an undefined tab', async () => {
    await manager.initAsPromised();
    await expect(manager.queueTabForSuspensionAsPromise(undefined, 1)).resolves.toBeUndefined();
  });

  it('resolves undefined for a tab that is not eligible, without queueing it', async () => {
    await manager.initAsPromised();
    const tab = makeTab({ url: 'chrome://settings/' });
    await expect(manager.queueTabForSuspensionAsPromise(tab, 1)).resolves.toBeUndefined();
    expect(manager.getQueuedTabDetails(tab)).toBeUndefined();
  });

  it('rejects the queued promise when the tab is unqueued', async () => {
    await manager.initAsPromised();
    const tab = makeTab();
    const outcome = track(manager.queueTabForSuspensionAsPromise(tab, 1));
    await flush();
    manager.unqueueTabForSuspension(tab);
    await flush();
    expect(outcome).toEqual({ state: 'rejected', value: 'Queued tab job cancelled externally' });
    expect(manager.getQueuedTabDetails(tab)).toBeUndefined();
  });
});

describe('gsTabSuspendManager.initAsPromised called a second time', () => {
  it('builds a new queue', async () => {
    await manager.initAsPromised();
    await manager.initAsPromised();
    expect(initSpy).toHaveBeenCalledTimes(2);
    expect(initSpy.mock.results[1].value).not.toBe(initSpy.mock.results[0].value);
  });

  // The old queue is dropped, not drained or cancelled: the manager can no longer see or
  // unqueue its jobs, while the timers of the old queue keep running them.
  it('loses sight of a job of the old queue, which still suspends the tab (oddity: see comment)', async () => {
    chrome.tabs.sendMessage.mockImplementation((tabId, message, options, callback) => {
      callback({ status: 'normal', scrollPos: '0' });
    });
    await manager.initAsPromised();
    const tab = makeTab();
    const outcome = track(manager.queueTabForSuspensionAsPromise(tab, 1));
    await flush();
    expect(manager.getQueuedTabDetails(tab)).toBeDefined();

    await manager.initAsPromised();
    const [oldQueue, newQueue] = initSpy.mock.results.map((result) => result.value);
    expect(manager.getQueuedTabDetails(tab)).toBeUndefined();
    expect(manager.isSuspensionInProgress(tab)).toBe(false);
    expect(oldQueue.getTotalQueueSize()).toBe(1);
    expect(newQueue.getTotalQueueSize()).toBe(0);

    manager.unqueueTabForSuspension(tab);
    await flush();
    expect(outcome.state).toBe('pending');
    expect(oldQueue.getTotalQueueSize()).toBe(1);

    await vi.advanceTimersByTimeAsync(QUEUE_CHECK_INTERVAL);
    await flush();
    expect(chrome.tabs.update).toHaveBeenCalledWith(5, { url: REBUILT_SUSPENDED_URL }, expect.any(Function));
    expect(outcome).toEqual({ state: 'resolved', value: true });
    expect(oldQueue.getTotalQueueSize()).toBe(0);
  });
});
