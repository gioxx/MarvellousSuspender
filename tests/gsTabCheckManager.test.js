import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gsTabCheckManager } from '../src/js/gsTabCheckManager.js';
import { gsChrome } from '../src/js/gsChrome.js';
import { gsSession } from '../src/js/gsSession.js';
import { gsStorage } from '../src/js/gsStorage.js';
import { gsUtils } from '../src/js/gsUtils.js';
import { gsTabDiscardManager } from '../src/js/gsTabDiscardManager.js';
import { tgs } from '../src/js/tgs.js';

const tabs = new Map();
function suspendedTab(id, extra = {}) {
  const tab = {
    id, windowId: 1, index: id, active: false, pinned: false, groupId: -1,
    status: 'complete', discarded: false, frozen: false,
    url: chrome.runtime.getURL(`suspended.html#ttl=Example&pos=0&uri=https://example.com/${id}`),
    title: 'Example', favIconUrl: 'data:image/png;base64,AA==', ...extra,
  };
  tabs.set(id, tab);
  return tab;
}

beforeEach(async () => {
  vi.useFakeTimers();
  tabs.clear();
  vi.spyOn(gsUtils, 'log').mockImplementation(() => {});
  vi.spyOn(gsUtils, 'warning').mockImplementation(() => {});
  vi.spyOn(gsChrome, 'tabsGet').mockImplementation(async (id) => tabs.get(id));
  vi.spyOn(gsChrome, 'contextGetByTabId').mockResolvedValue({});
  vi.spyOn(gsUtils, 'resuspendSuspendedTab').mockResolvedValue(true);
  vi.spyOn(gsSession, 'ensureFileUrlsStateReady').mockResolvedValue();
  vi.spyOn(gsSession, 'isFileUrlsUsable').mockReturnValue(true);
  vi.spyOn(gsSession, 'getSessionId').mockResolvedValue('session');
  vi.spyOn(gsStorage, 'getOption').mockResolvedValue(false);
  chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ sessionId: 'session', isVisible: true });
  await gsTabCheckManager.initAsPromised();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete chrome.tabs.sendMessage;
});

describe('startup suspended-tab checks (#523)', () => {
  it('checks healthy restored pages without reloading all of them', async () => {
    const restored = Array.from({ length: 61 }, (_, i) => suspendedTab(i + 1));
    const result = gsTabCheckManager.performInitialisationTabChecks(restored);
    await vi.runAllTimersAsync();
    expect(await result).toEqual(Array(61).fill(gsUtils.STATUS_SUSPENDED));
    expect(gsUtils.resuspendSuspendedTab).not.toHaveBeenCalled();
  });

  it('leaves discarded and frozen background pages asleep, using fresh tab state', async () => {
    const stale = [suspendedTab(1), suspendedTab(2)];
    tabs.set(1, { ...stale[0], discarded: true });
    tabs.set(2, { ...stale[1], frozen: true });
    const result = gsTabCheckManager.performInitialisationTabChecks(stale);
    await vi.runAllTimersAsync();
    expect(await result).toEqual([gsUtils.STATUS_DISCARDED, gsUtils.STATUS_SUSPENDED]);
    expect(gsUtils.resuspendSuspendedTab).not.toHaveBeenCalled();
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps recovering pages within three slots while reloads are still loading', async () => {
    const restored = Array.from({ length: 12 }, (_, i) => suspendedTab(i + 1));
    gsChrome.contextGetByTabId.mockResolvedValue(null);
    gsUtils.resuspendSuspendedTab.mockImplementation(async (tab) => {
      tabs.set(tab.id, { ...tab, status: 'loading' });
      return true;
    });
    const result = gsTabCheckManager.performInitialisationTabChecks(restored);
    await vi.advanceTimersByTimeAsync(8000);
    expect(gsUtils.resuspendSuspendedTab).toHaveBeenCalledTimes(3);
    // Finish the stalled jobs too, so the temporary listener is removed.
    await vi.runAllTimersAsync();
    await result;
  });

  it('settles an unanswered message promptly without claiming the page is healthy', async () => {
    chrome.tabs.sendMessage.mockImplementation(() => new Promise(() => {}));
    let result;
    gsTabCheckManager.performInitialisationTabChecks([suspendedTab(1)])
      .then((value) => { result = value; });
    await vi.advanceTimersByTimeAsync(10000);
    expect(result).toEqual([gsUtils.STATUS_UNKNOWN]);
  });

  it('does not lengthen an unanswered check when many unrelated tabs are open', async () => {
    chrome.tabs.sendMessage.mockImplementation(() => new Promise(() => {}));
    const normalTabs = Array.from({ length: 1000 }, (_, i) => ({ id: i + 2, url: 'https://example.org/' }));
    let result;
    gsTabCheckManager.performInitialisationTabChecks([suspendedTab(1), ...normalTabs])
      .then((value) => { result = value; });
    await vi.advanceTimersByTimeAsync(10000);
    expect(result).toEqual([gsUtils.STATUS_UNKNOWN]);
  });

  it('checks active pages first and preserves result order', async () => {
    const restored = [suspendedTab(1, { discarded: true }), suspendedTab(2), suspendedTab(3), suspendedTab(4, { active: true })];
    const result = gsTabCheckManager.performInitialisationTabChecks(restored);
    await vi.runAllTimersAsync();
    expect(gsChrome.tabsGet.mock.calls[0][0]).toBe(4);
    expect(await result).toEqual([
      gsUtils.STATUS_DISCARDED, gsUtils.STATUS_SUSPENDED,
      gsUtils.STATUS_SUSPENDED, gsUtils.STATUS_SUSPENDED,
    ]);
  });

  it('recovers a missing page context once and verifies the reloaded page', async () => {
    let reloaded = false;
    gsChrome.contextGetByTabId.mockImplementation(async () => reloaded ? {} : null);
    gsUtils.resuspendSuspendedTab.mockImplementation(async () => { reloaded = true; return true; });
    const result = gsTabCheckManager.performInitialisationTabChecks([suspendedTab(1)]);
    await vi.runAllTimersAsync();
    expect(await result).toEqual([gsUtils.STATUS_SUSPENDED]);
    expect(gsUtils.resuspendSuspendedTab).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ action: 'getSuspendInfo' }));
  });

  it('recovers a restored page with no receiver even when a context fallback claims one', async () => {
    // Lazily restored placeholder: status complete, not discarded or frozen, but its
    // document never ran. The Vivaldi URL fallback still reports a context for it.
    let reloaded = false;
    chrome.tabs.sendMessage.mockImplementation(async () => {
      if (!reloaded) throw new Error('Could not establish connection. Receiving end does not exist.');
      return { sessionId: 'session', isVisible: true };
    });
    gsUtils.resuspendSuspendedTab.mockImplementation(async () => { reloaded = true; return true; });
    const result = gsTabCheckManager.performInitialisationTabChecks([suspendedTab(1, { favIconUrl: '' })]);
    await vi.runAllTimersAsync();
    expect(await result).toEqual([gsUtils.STATUS_SUSPENDED]);
    expect(gsUtils.resuspendSuspendedTab).toHaveBeenCalledTimes(1);
  });

  it('reloads a page with no receiver only once', async () => {
    chrome.tabs.sendMessage.mockRejectedValue(new Error('Could not establish connection. Receiving end does not exist.'));
    const result = gsTabCheckManager.performInitialisationTabChecks([suspendedTab(1)]);
    await vi.runAllTimersAsync();
    expect(await result).toEqual([gsUtils.STATUS_UNKNOWN]);
    expect(gsUtils.resuspendSuspendedTab).toHaveBeenCalledTimes(1);
  });

  it('does not reload a receiverless tab that navigated away before the reload', async () => {
    const tab = suspendedTab(1);
    chrome.tabs.sendMessage.mockImplementation(async () => {
      // The page navigates while getSuspendInfo is in flight, so nobody answers.
      tabs.set(1, { ...tab, url: 'https://example.com/1' });
      throw new Error('Could not establish connection. Receiving end does not exist.');
    });
    const result = gsTabCheckManager.performInitialisationTabChecks([tab]);
    await vi.runAllTimersAsync();
    expect(await result).toEqual([gsUtils.STATUS_UNKNOWN]);
    expect(gsUtils.resuspendSuspendedTab).not.toHaveBeenCalled();
  });

  it('finishes permanently loading checks within a bounded retry window', async () => {
    let result;
    gsTabCheckManager.performInitialisationTabChecks([suspendedTab(1, { status: 'loading' })])
      .then((value) => { result = value; });
    await vi.advanceTimersByTimeAsync(20000);
    expect(result).toEqual([gsUtils.STATUS_UNKNOWN]);
    expect(gsUtils.resuspendSuspendedTab).not.toHaveBeenCalled();
  });

  it('continues after cancellation and removes its temporary listener', async () => {
    const addListener = vi.spyOn(chrome.tabs.onUpdated, 'addListener');
    const removeListener = vi.spyOn(chrome.tabs.onUpdated, 'removeListener');
    const restored = [suspendedTab(1), suspendedTab(2), suspendedTab(3), suspendedTab(4)];
    chrome.tabs.sendMessage.mockImplementation(async (id) => id === 1
      ? new Promise(() => {}) : { sessionId: 'session', isVisible: true });
    const result = gsTabCheckManager.performInitialisationTabChecks(restored);
    await vi.advanceTimersByTimeAsync(100);
    gsTabCheckManager.unqueueTabCheck(restored[0]);
    await vi.runAllTimersAsync();
    expect(await result).toEqual([
      gsUtils.STATUS_UNKNOWN, gsUtils.STATUS_SUSPENDED,
      gsUtils.STATUS_SUSPENDED, gsUtils.STATUS_SUSPENDED,
    ]);
    expect(removeListener).toHaveBeenCalledWith(addListener.mock.calls[0][0]);
  });

  it('bounds a startup check parked behind an ordinary check already running', async () => {
    const tab = suspendedTab(1);
    // The ordinary check keeps finding a page still loading, so it requeues for minutes;
    // the slow refetch keeps it in progress when the startup request arrives.
    gsChrome.tabsGet.mockImplementation((id) => new Promise((resolve) => {
      setTimeout(() => resolve({ ...tabs.get(id), status: 'loading' }), 1000);
    }));
    gsTabCheckManager.queueTabCheck(tab, { refetchTab: true }, 0);
    await vi.advanceTimersByTimeAsync(100);
    let result;
    gsTabCheckManager.performInitialisationTabChecks([tab]).then((value) => { result = value; });
    await vi.advanceTimersByTimeAsync(30000);
    expect(result).toEqual([gsUtils.STATUS_UNKNOWN]);
    gsTabCheckManager.unqueueTabCheck(tab);
  });

  it('still runs a focus check that merges into an expired parked startup request', async () => {
    const tab = suspendedTab(1);
    let loading = true;
    // The ordinary check keeps requeueing while the page loads, outliving the startup wait.
    gsChrome.tabsGet.mockImplementation((id) => new Promise((resolve) => {
      setTimeout(() => resolve({ ...tabs.get(id), status: loading ? 'loading' : 'complete' }), 1000);
    }));
    gsTabCheckManager.queueTabCheck(tab, { refetchTab: true }, 0);
    await vi.advanceTimersByTimeAsync(100);
    let startup;
    gsTabCheckManager.performInitialisationTabChecks([tab]).then((value) => { startup = value; });
    await vi.advanceTimersByTimeAsync(30000);
    expect(startup).toEqual([gsUtils.STATUS_UNKNOWN]);
    // The user focuses the tab: this request joins the stale startup follow-up.
    const focus = gsTabCheckManager.queueTabCheckAsPromise(tab, {}, 0);
    loading = false;
    await vi.runAllTimersAsync();
    expect(await focus).toBe(gsUtils.STATUS_SUSPENDED);
  });

  it('cancels an expired startup check stalled on a browser API before admitting more', async () => {
    const tab = suspendedTab(1);
    // The view lookup stalls well past the startup budget, then reports no view (reload path).
    gsChrome.contextGetByTabId.mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve(null), 40000);
    }));
    let result;
    gsTabCheckManager.performInitialisationTabChecks([tab]).then((value) => { result = value; });
    await vi.advanceTimersByTimeAsync(26000);
    expect(result).toEqual([gsUtils.STATUS_UNKNOWN]);
    expect(gsTabCheckManager.hasPendingTabCheck(tab)).toBe(false);
    await vi.runAllTimersAsync();
    expect(gsUtils.resuspendSuspendedTab).not.toHaveBeenCalled();
  });

  it('does not send initTab from an abandoned check whose session lookup stalled', async () => {
    const tab = suspendedTab(1, { favIconUrl: '' });
    chrome.tabs.sendMessage.mockResolvedValue({ sessionId: 'old-session', isVisible: true });
    let lookups = 0;
    // The first lookup (session comparison) answers; the one before initTab stalls 40s.
    gsSession.getSessionId.mockImplementation(() => {
      lookups += 1;
      if (lookups === 1) return Promise.resolve('session');
      return new Promise((resolve) => setTimeout(() => resolve('session'), 40000));
    });
    const result = gsTabCheckManager.performInitialisationTabChecks([tab]);
    await vi.runAllTimersAsync();
    expect(await result).toEqual([gsUtils.STATUS_UNKNOWN]);
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(1, expect.objectContaining({ action: 'initTab' }));
  });

  it('keeps waiting on a slow page for ordinary (non-startup) checks', async () => {
    const tab = suspendedTab(1);
    chrome.tabs.sendMessage.mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve({ sessionId: 'session', isVisible: true }), 8000);
    }));
    const result = gsTabCheckManager.queueTabCheckAsPromise(tab, { refetchTab: true }, 0);
    await vi.runAllTimersAsync();
    expect(await result).toBe(gsUtils.STATUS_SUSPENDED);
  });

  it('reserves every restored tab until its startup worker picks it up', async () => {
    const restored = Array.from({ length: 5 }, (_, i) => suspendedTab(i + 1));
    chrome.tabs.sendMessage.mockImplementation(() => new Promise(() => {}));
    const result = gsTabCheckManager.performInitialisationTabChecks(restored);
    await vi.advanceTimersByTimeAsync(100);
    expect(gsTabCheckManager.hasPendingTabCheck(restored[4])).toBe(true);
    await vi.runAllTimersAsync();
    await result;
    expect(restored.some((tab) => gsTabCheckManager.hasPendingTabCheck(tab))).toBe(false);
  });

  it('does not spawn follow-up checks when a page completes during an executing check', async () => {
    const addListener = vi.spyOn(chrome.tabs.onUpdated, 'addListener');
    const tab = suspendedTab(1);
    chrome.tabs.sendMessage.mockImplementation(() => new Promise(() => {}));
    const result = gsTabCheckManager.performInitialisationTabChecks([tab]);
    await vi.advanceTimersByTimeAsync(100);
    const listener = addListener.mock.calls[0][0];
    listener(tab.id, { status: 'complete' }, tab);
    await vi.runAllTimersAsync();
    expect(await result).toEqual([gsUtils.STATUS_UNKNOWN]);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('discards without a new check once a slow init finishes past the message deadline', async () => {
    let finishInit;
    chrome.tabs.sendMessage.mockImplementation(async (id, message) => message.action === 'initTab'
      ? new Promise((resolve) => { finishInit = resolve; })
      : { sessionId: 'old-session', isVisible: false });
    gsStorage.getOption.mockResolvedValue(true);
    vi.spyOn(tgs, 'isCurrentActiveTab').mockResolvedValue(false);
    const discard = vi.spyOn(gsTabDiscardManager, 'queueTabForDiscardAsPromise').mockResolvedValue(true);
    const lateDiscard = vi.spyOn(gsTabDiscardManager, 'queueTabForDiscard').mockImplementation(() => {});
    const result = gsTabCheckManager.performInitialisationTabChecks([suspendedTab(1)]);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await result).toEqual([gsUtils.STATUS_UNKNOWN]);
    finishInit();
    await vi.runAllTimersAsync();
    expect(discard).not.toHaveBeenCalled();
    expect(lateDiscard).toHaveBeenCalledTimes(1);
    expect(lateDiscard.mock.calls[0][0].id).toBe(1);
    expect(lateDiscard.mock.calls[0][1]).toEqual({ expectedUrl: lateDiscard.mock.calls[0][0].url });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('skips the late discard when the page changed meanwhile', async () => {
    let finishInit;
    chrome.tabs.sendMessage.mockImplementation(async (id, message) => message.action === 'initTab'
      ? new Promise((resolve) => { finishInit = resolve; })
      : { sessionId: 'old-session', isVisible: false });
    gsStorage.getOption.mockResolvedValue(true);
    vi.spyOn(tgs, 'isCurrentActiveTab').mockResolvedValue(false);
    const lateDiscard = vi.spyOn(gsTabDiscardManager, 'queueTabForDiscard').mockImplementation(() => {});
    const tab = suspendedTab(1);
    const result = gsTabCheckManager.performInitialisationTabChecks([tab]);
    await vi.advanceTimersByTimeAsync(6000);
    await result;
    tabs.set(1, { ...tab, url: 'https://example.com/1' });
    finishInit();
    await vi.runAllTimersAsync();
    expect(lateDiscard).not.toHaveBeenCalled();
  });

  it('skips the late discard when the late init left the page without title or favicon', async () => {
    let finishInit;
    chrome.tabs.sendMessage.mockImplementation(async (id, message) => message.action === 'initTab'
      ? new Promise((resolve) => { finishInit = resolve; })
      : { sessionId: 'old-session', isVisible: false });
    gsStorage.getOption.mockResolvedValue(true);
    vi.spyOn(tgs, 'isCurrentActiveTab').mockResolvedValue(false);
    const lateDiscard = vi.spyOn(gsTabDiscardManager, 'queueTabForDiscard').mockImplementation(() => {});
    const tab = suspendedTab(1);
    const result = gsTabCheckManager.performInitialisationTabChecks([tab]);
    await vi.advanceTimersByTimeAsync(6000);
    await result;
    tabs.set(1, { ...tab, favIconUrl: undefined });
    finishInit({ error: 'initTab failed' });
    await vi.runAllTimersAsync();
    expect(lateDiscard).not.toHaveBeenCalled();
  });

  it('retries the late discard while the favicon has not reached the tab yet', async () => {
    let finishInit;
    chrome.tabs.sendMessage.mockImplementation(async (id, message) => message.action === 'initTab'
      ? new Promise((resolve) => { finishInit = resolve; })
      : { sessionId: 'old-session', isVisible: false });
    gsStorage.getOption.mockResolvedValue(true);
    vi.spyOn(tgs, 'isCurrentActiveTab').mockResolvedValue(false);
    const lateDiscard = vi.spyOn(gsTabDiscardManager, 'queueTabForDiscard').mockImplementation(() => {});
    const tab = suspendedTab(1);
    const result = gsTabCheckManager.performInitialisationTabChecks([tab]);
    await vi.advanceTimersByTimeAsync(6000);
    await result;
    tabs.set(1, { ...tab, favIconUrl: undefined });
    finishInit({});
    await vi.advanceTimersByTimeAsync(4000); // first validation: favicon still missing
    expect(lateDiscard).not.toHaveBeenCalled();
    tabs.set(1, tab); // Chrome catches up
    await vi.runAllTimersAsync();
    expect(lateDiscard).toHaveBeenCalledTimes(1);
  });

  it('does not re-check after a slow init when discarding is off', async () => {
    let finishInit;
    chrome.tabs.sendMessage.mockImplementation(async (id, message) => message.action === 'initTab'
      ? new Promise((resolve) => { finishInit = resolve; })
      : { sessionId: 'old-session', isVisible: false });
    const result = gsTabCheckManager.performInitialisationTabChecks([suspendedTab(1)]);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await result).toEqual([gsUtils.STATUS_UNKNOWN]);
    finishInit();
    await vi.runAllTimersAsync();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('handles blocked file URLs before skipping discarded or frozen pages', async () => {
    gsSession.isFileUrlsUsable.mockReturnValue(false);
    const tab = suspendedTab(1, {
      discarded: true, frozen: true,
      url: chrome.runtime.getURL('suspended.html#ttl=File&pos=0&uri=file:///tmp/example.txt'),
    });
    const update = vi.spyOn(gsChrome, 'tabsUpdate').mockImplementation(async (id, changes) => {
      tabs.set(id, { ...tab, ...changes, discarded: false, frozen: false });
      return tabs.get(id);
    });
    const result = gsTabCheckManager.performInitialisationTabChecks([tab]);
    await vi.runAllTimersAsync();
    expect(await result).toEqual([gsUtils.STATUS_UNKNOWN]);
    expect(update).toHaveBeenCalledWith(1, { url: 'file:///tmp/example.txt' });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });
});
