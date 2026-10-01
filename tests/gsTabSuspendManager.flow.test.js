import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createChromeStub } from './setup/chrome-stub.js';
import {
  NORMAL_URL, QUEUE_CHECK_INTERVAL, JOB_TIMEOUT, CANCELLED,
  makeTab, suspendedUrlOf, installFakeTimers, installSuspensionFakes, flush, track, advance, setOptions, queueAndRun, withLastError,
} from './setup/suspend-manager-harness.js';

// Characterisation of the suspension flow of gsTabSuspendManager with screen capture off:
// the private performSuspension() and handleSuspensionException() are run for real, inside
// the real queue, through queueTabForSuspensionAsPromise() after initAsPromised(). A case
// whose name ends in "(defect: see comment)" or "(oddity: see comment)" is expected to
// change when the behaviour it describes is fixed.
//
// What is faked: the chrome.* calls the flow makes (installed on the fresh stub by
// installSuspensionFakes(), see setup/suspend-manager-harness.js), and the gsIndexedDb
// methods, which are spied on. There is no IndexedDB.
//
// handleSuspensionException() is private. It is observed through a wrapper: gsTabQueue.init
// is replaced by an implementation that hands the real init the same properties, with the
// exception function wrapped in a pass-through vi.fn.
//
// The function the YouTube path injects into the page is run by one case only, against a
// stubbed `document`. That says what the function computes, not that it finds the player
// of a real YouTube page: that belongs to the end-to-end suite.

const YOUTUBE_URL = 'https://www.youtube.com/watch?v=abc123';
const START_TIME = new Date('2026-01-01T00:00:00.000Z');
const REQUEUE_DELAY = 3000;

let originalChrome;
let gsStorage;
let gsUtils;
let gsIndexedDb;
let gsTabDiscardManager;
let tgs;
let manager;
let exceptionSpy;

const suspend = (tab, forceLevel) => queueAndRun(manager, tab, forceLevel);

// The callback is the last argument, whether gsMessages passes options or not.
function contentScriptAnswers(tabInfo) {
  chrome.tabs.sendMessage.mockImplementation((...args) => args.at(-1)(tabInfo));
}

function contentScriptFails(message) {
  chrome.tabs.sendMessage.mockImplementation((...args) => {
    withLastError(message, () => args.at(-1)(undefined));
  });
}

function tabsGetGives(...tabs) {
  for (const tab of tabs) {
    chrome.tabs.get.mockImplementationOnce((tabId, callback) => callback(tab));
  }
}

beforeEach(async () => {
  originalChrome = globalThis.chrome;
  installFakeTimers();
  vi.setSystemTime(START_TIME);
  vi.resetModules();
  globalThis.chrome = createChromeStub();
  installSuspensionFakes();

  ({ gsStorage } = await import('../src/js/gsStorage.js'));
  ({ gsUtils } = await import('../src/js/gsUtils.js'));
  ({ gsIndexedDb } = await import('../src/js/gsIndexedDb.js'));
  ({ gsTabDiscardManager } = await import('../src/js/gsTabDiscardManager.js'));
  ({ tgs } = await import('../src/js/tgs.js'));
  const { gsTabQueue } = await import('../src/js/gsTabQueue.js');
  const { gsTabCheckManager } = await import('../src/js/gsTabCheckManager.js');
  ({ gsTabSuspendManager: manager } = await import('../src/js/gsTabSuspendManager.js'));

  const realInit = gsTabQueue.init;
  vi.spyOn(gsTabQueue, 'init').mockImplementation((queueId, queueProps) => {
    exceptionSpy = vi.fn(queueProps.exceptionFn);
    return realInit(queueId, { ...queueProps, exceptionFn: exceptionSpy });
  });
  vi.spyOn(gsIndexedDb, 'addSuspendedTabInfo').mockResolvedValue(undefined);
  vi.spyOn(gsIndexedDb, 'fetchTabInfo').mockResolvedValue(null);
  vi.spyOn(gsIndexedDb, 'addPreviewImage').mockResolvedValue(undefined);
  vi.spyOn(gsTabCheckManager, 'unqueueTabCheck').mockImplementation(() => {});
  vi.spyOn(gsTabDiscardManager, 'queueTabForDiscard').mockImplementation(() => {});
  vi.spyOn(tgs, 'isCurrentFocusedTab').mockResolvedValue(false);
  vi.spyOn(tgs, 'isCharging').mockResolvedValue(undefined);
  // The real one waits up to 3 seconds for a cache that nothing seeds here.
  vi.spyOn(tgs, 'getLastTabGroupKey').mockResolvedValue(null);

  await manager.initAsPromised();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  globalThis.chrome = originalChrome;
});

describe('suspension flow with screen capture off', () => {
  it('asks the content script, saves the tab info, navigates to the suspended url and resolves true', async () => {
    const tab = makeTab();
    const outcome = await suspend(tab, 1);

    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(5, { action: 'requestInfo', tabId: 5 }, { frameId: 0 }, expect.any(Function));
    expect(gsIndexedDb.addSuspendedTabInfo).toHaveBeenCalledTimes(1);
    expect(gsIndexedDb.addSuspendedTabInfo).toHaveBeenCalledWith({
      date: new Date(START_TIME.getTime() + QUEUE_CHECK_INTERVAL),
      title: 'Example',
      url: NORMAL_URL,
      favIconUrl: 'https://example.com/favicon.ico',
      pinned: false,
      index: 3,
      windowId: 1,
    });
    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.update).toHaveBeenCalledWith(5, { url: suspendedUrlOf(NORMAL_URL, 'Example', '0') }, expect.any(Function));
    expect(gsIndexedDb.addSuspendedTabInfo.mock.invocationCallOrder[0]).toBeLessThan(chrome.tabs.update.mock.invocationCallOrder[0]);
    expect(outcome).toEqual({ state: 'resolved', value: true });
    expect(manager.getQueuedTabDetails(tab)).toBeUndefined();

    // Nothing of what only the other branches do.
    expect(chrome.tabs.get).not.toHaveBeenCalled();
    expect(gsIndexedDb.fetchTabInfo).not.toHaveBeenCalled();
    expect(gsIndexedDb.addPreviewImage).not.toHaveBeenCalled();
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(exceptionSpy).not.toHaveBeenCalled();
  });

  it('puts the scroll position and the encoded title in the suspended url', async () => {
    contentScriptAnswers({ status: 'normal', scrollPos: '340' });
    const outcome = await suspend(makeTab({ title: 'Two words & more' }), 1);
    expect(chrome.tabs.update).toHaveBeenCalledWith(
      5,
      { url: suspendedUrlOf(NORMAL_URL, 'Two%20words%20%26%20more', '340') },
      expect.any(Function),
    );
    expect(outcome).toEqual({ state: 'resolved', value: true });
  });

  // Columns: what the content script does, how to arrange it, whether a warning is logged.
  it.each([
    ['fails with lastError', () => contentScriptFails('Could not establish connection. Receiving end does not exist.'), true],
    ['answers nothing', () => contentScriptAnswers(undefined), false],
  ])('assumes status unknown and scroll position 0 when the content script %s, and suspends at level 2', async (label, arrange, warns) => {
    arrange();
    const warning = vi.spyOn(gsUtils, 'warning');
    const outcome = await suspend(makeTab(), 2);
    expect(chrome.tabs.update).toHaveBeenCalledWith(5, { url: suspendedUrlOf(NORMAL_URL, 'Example', '0') }, expect.any(Function));
    expect(gsIndexedDb.addSuspendedTabInfo).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ state: 'resolved', value: true });
    const warned = warning.mock.calls.some((call) => call[2] === 'Failed to get content script info');
    expect(warned).toBe(warns);
  });

  // gsMessages retries without the frame option when the first call throws.
  it('asks the content script again without options when chrome.tabs.sendMessage throws', async () => {
    chrome.tabs.sendMessage.mockImplementationOnce(() => { throw new Error('Invalid arguments'); });
    chrome.tabs.sendMessage.mockImplementationOnce((tabId, message, callback) => callback({ status: 'normal', scrollPos: '12' }));
    const outcome = await suspend(makeTab(), 1);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
    expect(chrome.tabs.sendMessage.mock.calls[1]).toHaveLength(3);
    expect(chrome.tabs.update).toHaveBeenCalledWith(5, { url: suspendedUrlOf(NORMAL_URL, 'Example', '12') }, expect.any(Function));
    expect(outcome).toEqual({ state: 'resolved', value: true });
  });
});

// At level 2. What level 3 adds (offline, charging, suspend time) is decided before the job
// is queued and is pinned with checkTabEligibilityForSuspension(), in the eligibility file.
describe('suspension flow and the status the content script reports', () => {
  it.each([
    ['tempWhitelist', 2],
    ['formInput', 2],
  ])('stops on %s at level %i: resolves false, nothing saved, no navigation', async (status, forceLevel) => {
    contentScriptAnswers({ status, scrollPos: '0' });
    const tab = makeTab();
    const outcome = await suspend(tab, forceLevel);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ state: 'resolved', value: false });
    expect(gsIndexedDb.addSuspendedTabInfo).not.toHaveBeenCalled();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(manager.getQueuedTabDetails(tab)).toBeUndefined();
  });

  it.each([
    ['tempWhitelist'],
    ['formInput'],
  ])('does not stop on %s at level 1', async (status) => {
    contentScriptAnswers({ status, scrollPos: '0' });
    const outcome = await suspend(makeTab(), 1);
    expect(outcome).toEqual({ state: 'resolved', value: true });
    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
  });

  it('suspends on formInput at level 2 when the url is on the always suspend list', async () => {
    await setOptions(gsStorage, { ALWAYS_SUSPEND_LIST: 'example.com' });
    contentScriptAnswers({ status: 'formInput', scrollPos: '0' });
    const outcome = await suspend(makeTab(), 2);
    expect(outcome).toEqual({ state: 'resolved', value: true });
    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
  });

  it('still stops on tempWhitelist at level 2 when the url is on the always suspend list', async () => {
    await setOptions(gsStorage, { ALWAYS_SUSPEND_LIST: 'example.com' });
    contentScriptAnswers({ status: 'tempWhitelist', scrollPos: '0' });
    const outcome = await suspend(makeTab(), 2);
    expect(outcome).toEqual({ state: 'resolved', value: false });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it.each([
    ['normal'],
    ['unknown'],
    ['audible'],
    ['a status that does not exist'],
  ])('does not stop on %s at level 2', async (status) => {
    contentScriptAnswers({ status, scrollPos: '0' });
    const outcome = await suspend(makeTab(), 2);
    expect(outcome).toEqual({ state: 'resolved', value: true });
  });
});

describe('suspension flow for a tab that is loading', () => {
  // The content script is not asked and no tab info is saved: the title comes from the tab
  // info saved by an earlier suspension, and the scroll position is given up.
  it('suspends at once with the saved title and scroll position 0 when tab info was saved for the url', async () => {
    gsIndexedDb.fetchTabInfo.mockResolvedValue({ title: 'Saved title', url: NORMAL_URL });
    const outcome = await suspend(makeTab({ status: 'loading', title: 'example.com/page' }), 2);
    expect(gsIndexedDb.fetchTabInfo).toHaveBeenCalledWith(NORMAL_URL);
    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.update).toHaveBeenCalledWith(5, { url: suspendedUrlOf(NORMAL_URL, 'Saved%20title', '0') }, expect.any(Function));
    expect(outcome).toEqual({ state: 'resolved', value: true });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect(gsIndexedDb.addSuspendedTabInfo).not.toHaveBeenCalled();
  });

  it('waits 3 seconds, refetches the tab and suspends it once loaded when no tab info was saved', async () => {
    const tab = makeTab({ status: 'loading', title: 'example.com/page' });
    tabsGetGives(makeTab({ title: 'Loaded title' }));
    const outcome = await suspend(tab, 1);
    expect(outcome.state).toBe('pending');
    expect(manager.getQueuedTabDetails(tab)).toMatchObject({
      status: 'sleeping',
      requeues: 1,
      executionProps: { forceLevel: 1, refetchTab: true },
    });
    expect(chrome.tabs.get).not.toHaveBeenCalled();

    await advance(REQUEUE_DELAY + QUEUE_CHECK_INTERVAL - 1);
    expect(chrome.tabs.get).not.toHaveBeenCalled();
    await advance(1);
    expect(chrome.tabs.get).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.get).toHaveBeenCalledWith(5, expect.any(Function));
    expect(chrome.tabs.update).toHaveBeenCalledWith(5, { url: suspendedUrlOf(NORMAL_URL, 'Loaded%20title', '0') }, expect.any(Function));
    expect(outcome).toEqual({ state: 'resolved', value: true });
  });

  // Every requeue gives the job a fresh 60 s timeout, so what ends it is the overall
  // deadline of the queue, five job timeouts after the job was first run. The queue then
  // reports a timeout, and the timeout handler suspends the tab while it is still loading,
  // from the tab as it was queued. The queue's other bound, 100 requeues, falls one cycle
  // later with the source's 3 s requeue delay: the case pins when the tab is suspended,
  // not which of the two bounds does it.
  it('suspends a tab that never stops loading after 5 job timeouts (oddity: see comment)', async () => {
    const tab = makeTab({ status: 'loading', title: 'As queued' });
    chrome.tabs.get.mockImplementation((tabId, callback) => callback(makeTab({ status: 'loading', title: 'As refetched' })));
    const outcome = await suspend(tab, 1);

    // The deadline is 5 job timeouts after the first run. The job is still sleeping when it
    // passes; the next run is the one the queue refuses to requeue.
    await advance(5 * JOB_TIMEOUT);
    expect(outcome.state).toBe('pending');
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(manager.getQueuedTabDetails(tab)).toMatchObject({ status: 'sleeping' });

    await advance(REQUEUE_DELAY + QUEUE_CHECK_INTERVAL);
    expect(exceptionSpy).toHaveBeenCalledTimes(1);
    expect(exceptionSpy.mock.calls[0][2]).toBe('timeout');
    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.update).toHaveBeenCalledWith(5, { url: suspendedUrlOf(NORMAL_URL, 'As%20queued', '0') }, expect.any(Function));
    expect(outcome).toEqual({ state: 'resolved', value: true });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });
});

describe('suspension flow for a tab that is already suspended', () => {
  const ALREADY_SUSPENDED = suspendedUrlOf(NORMAL_URL, 'Example', '0');

  it('refetches the tab, waits 3 seconds, refetches it again and resolves false', async () => {
    const tab = makeTab({ url: ALREADY_SUSPENDED });
    chrome.tabs.get.mockImplementation((tabId, callback) => callback(makeTab({ url: ALREADY_SUSPENDED })));
    const outcome = await suspend(tab, 1);
    expect(chrome.tabs.get).toHaveBeenCalledTimes(1);
    expect(outcome.state).toBe('pending');
    expect(manager.getQueuedTabDetails(tab)).toMatchObject({ status: 'sleeping', requeues: 1, executionProps: { refetchTab: true } });

    await advance(REQUEUE_DELAY + QUEUE_CHECK_INTERVAL);
    expect(chrome.tabs.get).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({ state: 'resolved', value: false });
    expect(manager.getQueuedTabDetails(tab)).toBeUndefined();

    await advance(10 * REQUEUE_DELAY);
    expect(chrome.tabs.get).toHaveBeenCalledTimes(2);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('suspends the tab as refetched when it is no longer suspended by then', async () => {
    tabsGetGives(makeTab({ title: 'Reloaded' }));
    const outcome = await suspend(makeTab({ url: ALREADY_SUSPENDED }), 1);
    expect(chrome.tabs.get).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.update).toHaveBeenCalledWith(5, { url: suspendedUrlOf(NORMAL_URL, 'Reloaded', '0') }, expect.any(Function));
    expect(gsIndexedDb.addSuspendedTabInfo).toHaveBeenCalledWith(expect.objectContaining({ url: NORMAL_URL, title: 'Reloaded' }));
    expect(outcome).toEqual({ state: 'resolved', value: true });
  });

  it.each([
    ['gives nothing', (tabId, callback) => callback(undefined)],
    ['fails with lastError', (tabId, callback) => withLastError('No tab with id: 5.', () => callback(undefined))],
  ])('resolves false when the refetch %s, the tab being gone', async (label, tabsGet) => {
    chrome.tabs.get.mockImplementation(tabsGet);
    const tab = makeTab({ url: ALREADY_SUSPENDED });
    const outcome = await suspend(tab, 1);
    expect(chrome.tabs.get).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ state: 'resolved', value: false });
    expect(manager.getQueuedTabDetails(tab)).toBeUndefined();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('resolves false when a loading tab is gone by the time it is refetched', async () => {
    tabsGetGives(undefined);
    const outcome = await suspend(makeTab({ status: 'loading' }), 1);
    await advance(REQUEUE_DELAY + QUEUE_CHECK_INTERVAL);
    expect(chrome.tabs.get).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ state: 'resolved', value: false });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });
});

describe('suspension flow with discard in place of suspend', () => {
  // The flow up to the suspension itself is the one of a real suspension: the content
  // script is asked and the tab info is saved, for a tab that keeps its url.
  it('queues the tab for discard, saving tab info for a tab that is not suspended (oddity: see comment)', async () => {
    await setOptions(gsStorage, { DISCARD_IN_PLACE_OF_SUSPEND: true });
    const tab = makeTab();
    const outcome = await suspend(tab, 1);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
    expect(gsIndexedDb.addSuspendedTabInfo).toHaveBeenCalledWith(expect.objectContaining({ url: NORMAL_URL }));
    expect(chrome.alarms.clear).toHaveBeenCalledWith('5');
    expect(gsTabDiscardManager.queueTabForDiscard).toHaveBeenCalledTimes(1);
    expect(gsTabDiscardManager.queueTabForDiscard).toHaveBeenCalledWith(tab);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(outcome).toEqual({ state: 'resolved', value: true });
  });

  it('does not discard a tab the content script reports as paused at level 2', async () => {
    await setOptions(gsStorage, { DISCARD_IN_PLACE_OF_SUSPEND: true });
    contentScriptAnswers({ status: 'tempWhitelist', scrollPos: '0' });
    const outcome = await suspend(makeTab(), 2);
    expect(gsTabDiscardManager.queueTabForDiscard).not.toHaveBeenCalled();
    expect(outcome).toEqual({ state: 'resolved', value: false });
  });
});

describe('suspension flow for a YouTube tab', () => {
  function injectionGives(result) {
    chrome.scripting.executeScript.mockImplementation((injection, callback) => callback([{ result }]));
  }

  it('asks the page for the playback time and suspends under a url carrying it', async () => {
    injectionGives(83);
    const tab = makeTab({ url: YOUTUBE_URL, title: 'Video' });
    const outcome = await suspend(tab, 1);

    expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
      { target: { tabId: 5 }, func: expect.any(Function), args: [] },
      expect.any(Function),
    );
    const timestamped = `${YOUTUBE_URL}&t=83s`;
    expect(gsIndexedDb.addSuspendedTabInfo).toHaveBeenCalledWith(expect.objectContaining({ url: timestamped, title: 'Video' }));
    expect(chrome.tabs.update).toHaveBeenCalledWith(5, { url: suspendedUrlOf(timestamped, 'Video', '0') }, expect.any(Function));
    expect(outcome).toEqual({ state: 'resolved', value: true });
    // The tab object the caller queued is changed in place.
    expect(tab.url).toBe(timestamped);
  });

  it('replaces a timestamp the url already carries', async () => {
    injectionGives(83);
    await suspend(makeTab({ url: `${YOUTUBE_URL}&t=10s` }), 1);
    expect(chrome.tabs.update).toHaveBeenCalledWith(5, { url: suspendedUrlOf(`${YOUTUBE_URL}&t=83s`, 'Example', '0') }, expect.any(Function));
  });

  // The answer is tested with `!response`, so a playback time of 0 reads as no answer.
  it.each([
    ['the page answers 0', () => injectionGives(0)],
    ['the page answers nothing', () => injectionGives(undefined)],
    ['the injection fails with lastError', () => {
      chrome.scripting.executeScript.mockImplementation((injection, callback) => {
        withLastError('Cannot access contents of the page.', () => callback(undefined));
      });
    }],
  ])('keeps the url as it is when %s, and suspends', async (label, arrange) => {
    arrange();
    const outcome = await suspend(makeTab({ url: `${YOUTUBE_URL}&t=10s` }), 1);
    expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.update).toHaveBeenCalledWith(5, { url: suspendedUrlOf(`${YOUTUBE_URL}&t=10s`, 'Example', '0') }, expect.any(Function));
    expect(outcome).toEqual({ state: 'resolved', value: true });
  });

  it.each([
    ['the option is off', YOUTUBE_URL, false],
    ['the url is not a watch page of www.youtube.com over https', 'https://m.youtube.com/watch?v=abc123', true],
  ])('does not ask the page when %s', async (label, url, option) => {
    await setOptions(gsStorage, { ADD_YOUTUBE_TIMESTAMP: option });
    const outcome = await suspend(makeTab({ url }), 1);
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(chrome.tabs.update).toHaveBeenCalledWith(5, { url: suspendedUrlOf(url, 'Example', '0') }, expect.any(Function));
    expect(outcome).toEqual({ state: 'resolved', value: true });
  });

  // The test is `includes`, so the text anywhere in the url is enough. Setting the
  // parameter also writes the whole query again, which encodes what was not encoded.
  it('asks the page of any url that contains the watch url of YouTube, and rewrites its query (oddity: see comment)', async () => {
    injectionGives(7);
    const url = `https://example.com/redirect?to=${YOUTUBE_URL}`;
    await suspend(makeTab({ url }), 1);
    expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
    const rewritten = 'https://example.com/redirect?to=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabc123&t=7s';
    expect(chrome.tabs.update).toHaveBeenCalledWith(5, { url: suspendedUrlOf(rewritten, 'Example', '0') }, expect.any(Function));
  });

  // Run against a stubbed document: see the header comment.
  it('injects a function that reads the whole seconds of the main video, or 0 without one', async () => {
    injectionGives(83);
    await suspend(makeTab({ url: YOUTUBE_URL }), 1);
    const injected = chrome.scripting.executeScript.mock.calls[0][0].func;

    const querySelector = vi.fn(() => ({ currentTime: 83.9 }));
    vi.stubGlobal('document', { querySelector });
    expect(injected()).toBe(83);
    expect(querySelector).toHaveBeenCalledWith('video.video-stream.html5-main-video');
    querySelector.mockReturnValue(null);
    expect(injected()).toBe(0);
  });
});

describe('unqueueTabForSuspension during the flow', () => {
  it('rejects a job that is still queued, which then never runs', async () => {
    const tab = makeTab();
    const outcome = track(manager.queueTabForSuspensionAsPromise(tab, 1));
    await flush();
    expect(manager.getQueuedTabDetails(tab)).toMatchObject({ status: 'queued' });

    manager.unqueueTabForSuspension(tab);
    await flush();
    expect(outcome).toEqual({ state: 'rejected', value: CANCELLED });

    await advance(2 * JOB_TIMEOUT);
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(exceptionSpy).not.toHaveBeenCalled();
  });

  it('rejects a job that is in progress, and its timeout never fires', async () => {
    chrome.tabs.sendMessage.mockImplementation(() => {});
    const tab = makeTab();
    const outcome = await suspend(tab, 1);
    expect(manager.isSuspensionInProgress(tab)).toBe(true);

    manager.unqueueTabForSuspension(tab);
    await flush();
    expect(outcome).toEqual({ state: 'rejected', value: CANCELLED });
    expect(manager.getQueuedTabDetails(tab)).toBeUndefined();

    await advance(2 * JOB_TIMEOUT);
    expect(exceptionSpy).not.toHaveBeenCalled();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  // With capture off nothing looks at the queue again after the content script has been
  // asked: the executor of the cancelled job goes on when the answer comes, saves the tab
  // info and navigates the tab. Only the capture paths check that the job is still queued.
  it('still suspends the tab of a cancelled job when the content script answers afterwards (defect: see comment)', async () => {
    let answer;
    chrome.tabs.sendMessage.mockImplementation((tabId, message, options, callback) => { answer = callback; });
    const tab = makeTab();
    const outcome = await suspend(tab, 2);

    manager.unqueueTabForSuspension(tab);
    await flush();
    expect(outcome).toEqual({ state: 'rejected', value: CANCELLED });
    expect(chrome.tabs.update).not.toHaveBeenCalled();

    answer({ status: 'normal', scrollPos: '340' });
    await flush();
    expect(gsIndexedDb.addSuspendedTabInfo).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.update).toHaveBeenCalledWith(5, { url: suspendedUrlOf(NORMAL_URL, 'Example', '340') }, expect.any(Function));
    expect(outcome).toEqual({ state: 'rejected', value: CANCELLED });
  });

  it('returns undefined for a tab that is not queued', () => {
    expect(manager.unqueueTabForSuspension(makeTab({ id: 77 }))).toBeUndefined();
  });
});

describe('suspension flow when the queue times the job out', () => {
  // The handler is given the tab as it was queued and suspends it: it does not refetch the
  // tab, does not look at its url and does not ask whether it is still eligible. Here the
  // tab has become the focused tab and its url has been put on the whitelist meanwhile.
  it('suspends the tab with no eligibility check and no refetch (defect: see comment)', async () => {
    chrome.tabs.sendMessage.mockImplementation(() => {});
    const tab = makeTab();
    const outcome = await suspend(tab, 2);
    expect(manager.isSuspensionInProgress(tab)).toBe(true);

    await setOptions(gsStorage, { WHITELIST: 'example.com' });
    tgs.isCurrentFocusedTab.mockResolvedValue(true);
    await expect(manager.checkTabEligibilityForSuspension(tab, 2)).resolves.toBe(false);
    tgs.isCurrentFocusedTab.mockClear();

    await advance(JOB_TIMEOUT - 1);
    expect(outcome.state).toBe('pending');
    expect(exceptionSpy).not.toHaveBeenCalled();

    await advance(1);
    expect(exceptionSpy).toHaveBeenCalledTimes(1);
    expect(exceptionSpy.mock.calls[0].slice(0, 3)).toEqual([tab, { forceLevel: 2 }, 'timeout']);
    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ state: 'resolved', value: true });
    expect(tgs.isCurrentFocusedTab).not.toHaveBeenCalled();
    expect(chrome.tabs.get).not.toHaveBeenCalled();
    expect(gsIndexedDb.addSuspendedTabInfo).not.toHaveBeenCalled();
  });

  // No suspended url had been computed when the job hung, so one is rebuilt from the tab
  // as queued: scroll position 0 and no YouTube timestamp.
  it('uses a url rebuilt from the queued tab when none had been computed', async () => {
    chrome.tabs.sendMessage.mockImplementation(() => {});
    const outcome = await suspend(makeTab({ url: YOUTUBE_URL }), 1);
    await advance(JOB_TIMEOUT);
    expect(exceptionSpy.mock.calls[0][1].suspendedUrl).toBeUndefined();
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(chrome.tabs.update).toHaveBeenCalledWith(5, { url: suspendedUrlOf(YOUTUBE_URL, 'Example', '0') }, expect.any(Function));
    expect(outcome).toEqual({ state: 'resolved', value: true });
  });

  // Here the job hangs in the navigation itself, which chrome never answers. The handler
  // navigates a second time, to the url the executor had computed.
  it('uses the url the executor had computed, navigating a second time', async () => {
    contentScriptAnswers({ status: 'normal', scrollPos: '340' });
    chrome.tabs.update.mockImplementationOnce(() => {});
    const tab = makeTab();
    const outcome = await suspend(tab, 1);
    const computed = suspendedUrlOf(NORMAL_URL, 'Example', '340');
    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
    expect(outcome.state).toBe('pending');

    await advance(JOB_TIMEOUT);
    expect(exceptionSpy.mock.calls[0][1]).toEqual({ forceLevel: 1, precaptureUrl: NORMAL_URL, suspendedUrl: computed });
    expect(chrome.tabs.update).toHaveBeenCalledTimes(2);
    expect(chrome.tabs.update).toHaveBeenNthCalledWith(1, 5, { url: computed }, expect.any(Function));
    expect(chrome.tabs.update).toHaveBeenNthCalledWith(2, 5, { url: computed }, expect.any(Function));
    expect(outcome).toEqual({ state: 'resolved', value: true });
  });

  it('resolves false when the forced navigation fails', async () => {
    chrome.tabs.sendMessage.mockImplementation(() => {});
    chrome.tabs.update.mockImplementation((tabId, props, callback) => {
      withLastError('No tab with id: 5.', () => callback(undefined));
    });
    const outcome = await suspend(makeTab(), 1);
    await advance(JOB_TIMEOUT);
    expect(outcome).toEqual({ state: 'resolved', value: false });
  });
});

describe('suspension flow when the executor throws', () => {
  it('hands the error to the exception handler as the exception type, and resolves false', async () => {
    const boom = new Error('boom');
    gsIndexedDb.addSuspendedTabInfo.mockRejectedValue(boom);
    const warning = vi.spyOn(gsUtils, 'warning');
    const tab = makeTab();
    const outcome = await suspend(tab, 1);

    expect(exceptionSpy).toHaveBeenCalledTimes(1);
    expect(exceptionSpy.mock.calls[0].slice(0, 3)).toEqual([tab, { forceLevel: 1, precaptureUrl: NORMAL_URL }, boom]);
    expect(warning).toHaveBeenCalledWith(5, 'suspensionQueue', 'Failed to suspend tab: Error: boom');
    expect(outcome).toEqual({ state: 'resolved', value: false });
    expect(manager.getQueuedTabDetails(tab)).toBeUndefined();
    expect(chrome.tabs.update).not.toHaveBeenCalled();

    await advance(2 * JOB_TIMEOUT);
    expect(exceptionSpy).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  // An answer that is not an object is read as one: `'busy'.status` is undefined, which no
  // check stops, and `'busy'.scrollPos` is undefined, which the url writes as 0.
  it('suspends when the content script answers a string (oddity: see comment)', async () => {
    contentScriptAnswers('busy');
    const outcome = await suspend(makeTab(), 2);
    expect(exceptionSpy).not.toHaveBeenCalled();
    expect(chrome.tabs.update).toHaveBeenCalledWith(5, { url: suspendedUrlOf(NORMAL_URL, 'Example', '0') }, expect.any(Function));
    expect(outcome).toEqual({ state: 'resolved', value: true });
  });
});

describe('queueTabForSuspension', () => {
  it('returns undefined and suspends the tab', async () => {
    expect(manager.queueTabForSuspension(makeTab(), 1)).toBeUndefined();
    await flush();
    await advance(QUEUE_CHECK_INTERVAL);
    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
  });

  it('logs the rejection of a cancelled job and does not throw', async () => {
    const log = vi.spyOn(gsUtils, 'log');
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const tab = makeTab();
      manager.queueTabForSuspension(tab, 1);
      await flush();
      manager.unqueueTabForSuspension(tab);
      await flush();
      await flush();
      expect(log).toHaveBeenCalledWith(5, 'suspensionQueue', CANCELLED);
      expect(unhandled).not.toHaveBeenCalled();
    }
    finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
