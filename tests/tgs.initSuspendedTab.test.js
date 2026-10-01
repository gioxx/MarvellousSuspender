import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tgs } from '../src/js/tgs.js';
import { gsSession } from '../src/js/gsSession.js';
import { gsStorage } from '../src/js/gsStorage.js';
import { gsTabCheckManager } from '../src/js/gsTabCheckManager.js';
import { gsTabSuspendManager } from '../src/js/gsTabSuspendManager.js';
import { gsUtils } from '../src/js/gsUtils.js';

const tab = {
  id: 1, windowId: 1, index: 0, active: false, status: 'complete', discarded: false,
  url: chrome.runtime.getURL('suspended.html#ttl=Example&pos=0&uri=https://example.com/'),
};

beforeEach(() => {
  vi.spyOn(gsUtils, 'log').mockImplementation(() => {});
  vi.spyOn(gsUtils, 'warning').mockImplementation(() => {});
  vi.spyOn(gsStorage, 'getOption').mockResolvedValue(false);
  vi.spyOn(gsSession, 'getSessionId').mockResolvedValue('session');
  vi.spyOn(gsTabSuspendManager, 'unqueueTabForSuspension').mockImplementation(() => {});
  chrome.tabs.get = vi.fn().mockResolvedValue(tab);
  chrome.alarms.clear = vi.fn().mockResolvedValue(true);
  chrome.tabs.sendMessage = vi.fn().mockResolvedValue({});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete chrome.tabs.sendMessage;
  delete chrome.tabs.get;
  delete chrome.alarms.clear;
});

describe('suspended page initialisation (#523)', () => {
  it('queues a responsiveness check after initTab', async () => {
    vi.spyOn(gsTabCheckManager, 'hasPendingTabCheck').mockReturnValue(false);
    const queue = vi.spyOn(gsTabCheckManager, 'queueTabCheck').mockImplementation(() => {});
    await tgs.handleSuspendedTabStateChanged(tab, { status: 'complete' });
    expect(queue).toHaveBeenCalledWith(tab, { refetchTab: true }, 3000);
  });

  it('leaves verification to a pending or reserved check for the page', async () => {
    vi.spyOn(gsTabCheckManager, 'hasPendingTabCheck').mockReturnValue(true);
    const queue = vi.spyOn(gsTabCheckManager, 'queueTabCheck').mockImplementation(() => {});
    await tgs.handleSuspendedTabStateChanged(tab, { status: 'complete' });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
    expect(queue).not.toHaveBeenCalled();
  });

  it('skips the check when a startup check was pending as the page loaded', async () => {
    // The startup check settles (dropping its reservation) while initTab is in flight.
    let pending = true;
    vi.spyOn(gsTabCheckManager, 'hasPendingTabCheck').mockImplementation(() => pending);
    chrome.tabs.sendMessage.mockImplementation(async () => { pending = false; return {}; });
    const queue = vi.spyOn(gsTabCheckManager, 'queueTabCheck').mockImplementation(() => {});
    await tgs.handleSuspendedTabStateChanged(tab, { status: 'complete' });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
    expect(queue).not.toHaveBeenCalled();
  });

  it('does not retry an initTab send that timed out', async () => {
    // The page may still be running the first initTab: a retry would start a duplicate.
    vi.useFakeTimers();
    try {
      vi.spyOn(gsTabCheckManager, 'hasPendingTabCheck').mockReturnValue(false);
      const queue = vi.spyOn(gsTabCheckManager, 'queueTabCheck').mockImplementation(() => {});
      chrome.tabs.sendMessage.mockImplementation(() => new Promise(() => {}));
      const handled = tgs.handleSuspendedTabStateChanged(tab, { status: 'complete' });
      await vi.runAllTimersAsync();
      await handled;
      expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
      expect(queue).not.toHaveBeenCalled();
    }
    finally {
      vi.useRealTimers();
    }
  });
});
