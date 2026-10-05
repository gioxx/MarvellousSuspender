import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gsStorage } from '../src/js/gsStorage.js';
import { gsUtils } from '../src/js/gsUtils.js';

const LIST = gsStorage.NEVER_SUSPEND_GROUPS;
const withKey = (key) => (list) => [list, key].filter(Boolean).join('\n');

let originalGet;

async function storedList() {
  const { gsSettings } = await chrome.storage.local.get(['gsSettings']);
  return gsSettings[LIST];
}

beforeEach(async () => {
  vi.spyOn(gsUtils, 'log').mockImplementation(() => {});
  originalGet = chrome.storage.local.get;
  chrome.storage.local._reset();
  chrome.storage.sync._reset();
  // through saveSettings(), which also drops this context's cached copy
  await gsStorage.saveSettings({ ...gsStorage.getSettingsDefaults(), [LIST]: '' });
});

afterEach(() => {
  chrome.storage.local.get = originalGet;
  vi.restoreAllMocks();
});

describe('gsStorage.updateOption (#501)', () => {
  it('keeps a write that lands between its read and its save', async () => {
    // A second writer starts while the first is still reading the settings, as a change
    // from the sync listener can. Each must build on the other's result.
    /** @type {Promise<boolean> | undefined} */
    let racing;
    chrome.storage.local.get = vi.fn(async (keys) => {
      const result = await originalGet(keys);
      racing ??= gsStorage.updateOption(LIST, withKey('red:Other'));
      return result;
    });
    await gsStorage.updateOption(LIST, withKey('blue:Research'));
    await racing;
    expect((await storedList()).split('\n').sort()).toEqual(['blue:Research', 'red:Other']);
  });

  it('computes from the stored value, not from a copy cached in this context', async () => {
    await gsStorage.getOption(LIST);
    // another context writes; this one has not been told yet (no onChanged delivered)
    await chrome.storage.local.set({
      gsSettings: { ...gsStorage.getSettingsDefaults(), [LIST]: 'red:Other' },
    });
    const seen = [];
    await gsStorage.updateOption(LIST, (list) => {
      seen.push(list);
      return withKey('blue:Research')(list);
    });
    expect(seen).toEqual(['red:Other']);
    expect(await storedList()).toBe('red:Other\nblue:Research');
  });

  it('writes nothing and pushes nothing when the value comes back unchanged', async () => {
    const localSet = vi.spyOn(chrome.storage.local, 'set');
    const syncSet = vi.spyOn(chrome.storage.sync, 'set');
    await expect(gsStorage.updateOptionAndSync(LIST, (list) => list)).resolves.toBe(false);
    expect(localSet).not.toHaveBeenCalled();
    expect(syncSet).not.toHaveBeenCalled();
  });

  it('writes and pushes the new value to sync when it changed', async () => {
    const syncSet = vi.spyOn(chrome.storage.sync, 'set');
    await expect(gsStorage.updateOptionAndSync(LIST, withKey('blue:Research'))).resolves.toBe(true);
    expect(await storedList()).toBe('blue:Research');
    expect(syncSet).toHaveBeenCalledWith(expect.objectContaining({ [LIST]: 'blue:Research' }));
  });
});
