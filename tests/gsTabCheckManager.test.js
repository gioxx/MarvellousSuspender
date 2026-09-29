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

  it('does not discard a page after an init response arrives past the message deadline', async () => {
    let finishInit;
    chrome.tabs.sendMessage.mockImplementation(async (id, message) => message.action === 'initTab'
      ? new Promise((resolve) => { finishInit = resolve; })
      : { sessionId: 'old-session', isVisible: false });
    gsStorage.getOption.mockResolvedValue(true);
    vi.spyOn(tgs, 'isCurrentActiveTab').mockResolvedValue(false);
    const discard = vi.spyOn(gsTabDiscardManager, 'queueTabForDiscardAsPromise').mockResolvedValue(true);
    const result = gsTabCheckManager.performInitialisationTabChecks([suspendedTab(1)]);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await result).toEqual([gsUtils.STATUS_UNKNOWN]);
    finishInit();
    await vi.runAllTimersAsync();
    expect(discard).not.toHaveBeenCalled();
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
