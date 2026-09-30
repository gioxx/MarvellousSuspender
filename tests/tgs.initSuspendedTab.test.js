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
    vi.spyOn(gsTabCheckManager, 'getQueuedTabDetails').mockReturnValue(undefined);
    const queue = vi.spyOn(gsTabCheckManager, 'queueTabCheck').mockImplementation(() => {});
    await tgs.handleSuspendedTabStateChanged(tab, { status: 'complete' });
    expect(queue).toHaveBeenCalledWith(tab, { refetchTab: true }, 3000);
  });

  it('leaves verification to a check already queued or running for the page', async () => {
    vi.spyOn(gsTabCheckManager, 'getQueuedTabDetails').mockReturnValue({ status: 'inProgress' });
    const queue = vi.spyOn(gsTabCheckManager, 'queueTabCheck').mockImplementation(() => {});
    await tgs.handleSuspendedTabStateChanged(tab, { status: 'complete' });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
    expect(queue).not.toHaveBeenCalled();
  });
});
