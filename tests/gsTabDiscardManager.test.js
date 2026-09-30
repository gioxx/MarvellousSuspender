import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gsChrome } from '../src/js/gsChrome.js';
import { gsTabDiscardManager } from '../src/js/gsTabDiscardManager.js';
import { gsUtils } from '../src/js/gsUtils.js';
import { tgs } from '../src/js/tgs.js';

const suspendedUrl = chrome.runtime.getURL('suspended.html#ttl=Example&pos=0&uri=https://example.com/');
const tab = { id: 1, windowId: 1, active: false, status: 'complete', discarded: false, url: suspendedUrl };

beforeEach(async () => {
  vi.useFakeTimers();
  vi.spyOn(gsUtils, 'log').mockImplementation(() => {});
  vi.spyOn(gsUtils, 'warning').mockImplementation(() => {});
  vi.spyOn(tgs, 'isCurrentActiveTab').mockResolvedValue(false);
  chrome.tabs.discard = vi.fn((id, callback) => callback());
  await gsTabDiscardManager.initAsPromised();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete chrome.tabs.discard;
});

describe('discard queue expectedUrl guard', () => {
  it('discards when the tab is still on the expected url', async () => {
    vi.spyOn(gsChrome, 'tabsGet').mockResolvedValue(tab);
    const result = gsTabDiscardManager.queueTabForDiscardAsPromise(tab, { expectedUrl: suspendedUrl });
    await vi.runAllTimersAsync();
    expect(await result).toBe(true);
    expect(chrome.tabs.discard).toHaveBeenCalledTimes(1);
  });

  it('aborts when the tab navigated after it was queued', async () => {
    vi.spyOn(gsChrome, 'tabsGet').mockResolvedValue({ ...tab, url: 'https://example.com/' });
    const result = gsTabDiscardManager.queueTabForDiscardAsPromise(tab, { expectedUrl: suspendedUrl });
    await vi.runAllTimersAsync();
    expect(await result).toBe(false);
    expect(chrome.tabs.discard).not.toHaveBeenCalled();
  });

  it('aborts when the tab navigates while the discard checks are running', async () => {
    vi.spyOn(gsChrome, 'tabsGet')
      .mockResolvedValueOnce(tab)
      .mockResolvedValue({ ...tab, url: 'https://example.com/' });
    const result = gsTabDiscardManager.queueTabForDiscardAsPromise(tab, { expectedUrl: suspendedUrl });
    await vi.runAllTimersAsync();
    expect(await result).toBe(false);
    expect(chrome.tabs.discard).not.toHaveBeenCalled();
  });
});
