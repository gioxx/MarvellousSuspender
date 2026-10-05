import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// tgs.js only seeds its tab group key cache in the service worker, which it tells apart by
// this global, and the seed runs once per worker: each test loads a fresh copy of the modules
// with the global defined.
let tgs;
let gsStorage;
let groups;

async function loadWorker({ incognito = false } = {}) {
  vi.resetModules();
  globalThis.ServiceWorkerGlobalScope = function ServiceWorkerGlobalScope() {};
  chrome.extension.inIncognitoContext = incognito;
  ({ tgs } = await import('../src/js/tgs.js'));
  ({ gsStorage } = await import('../src/js/gsStorage.js'));
  const { gsUtils } = await import('../src/js/gsUtils.js');
  vi.spyOn(gsUtils, 'log').mockImplementation(() => {});
  vi.spyOn(gsUtils, 'warning').mockImplementation(() => {});
  await chrome.storage.local.set({
    gsSettings: {
      ...gsStorage.getSettingsDefaults(),
      [gsStorage.NEVER_SUSPEND_GROUPS]: 'blue:Research',
      [gsStorage.ADD_CONTEXT]: false,
      [gsStorage.SYNC_SETTINGS]: false,
    },
  });
}

// Runs whatever is queued, timers aside, until `done()` or for long enough that anything
// not waiting on a timer has finished: the storage stub settles in microtasks.
async function drain(done = () => false) {
  for (let i = 0; i < 1000 && !done(); i++) {
    await Promise.resolve();
  }
}

// 'pending' while the promise has not settled once everything queued has run
async function stateOf(promise) {
  let state = 'pending';
  promise.then(() => { state = 'settled'; }, () => { state = 'settled'; });
  await drain(() => state !== 'pending');
  return state;
}

beforeEach(() => {
  vi.useFakeTimers();
  groups = [
    { id: 7, color: 'blue', title: 'Research' },
    { id: 8, color: 'red', title: 'Inbox' },
    { id: 9, color: 'green', title: 'Docs' },
  ];
  chrome.tabGroups.query = vi.fn((queryInfo, callback) => callback(groups.map((group) => ({ ...group }))));
  chrome.tabGroups.get = vi.fn((groupId, callback) => callback({ ...groups.find((group) => group.id === groupId) }));
});

afterEach(async () => {
  await vi.runAllTimersAsync();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete globalThis.ServiceWorkerGlobalScope;
  chrome.extension.inIncognitoContext = false;
  delete chrome.tabGroups.query;
  delete chrome.tabGroups.get;
  chrome.storage.local._reset();
  chrome.storage.session._reset();
});

describe('tab group key cache seed (#501)', () => {
  it('seeds once when a read starts the seed before init gets to it', async () => {
    await loadWorker();
    await tgs.getLastTabGroupKey(7);
    // the seed that read started, finishing on its own
    await vi.advanceTimersByTimeAsync(3000);
    await drain();
    await tgs.initTabGroupKeyCache();
    expect(chrome.tabGroups.query).toHaveBeenCalledTimes(1);
  });

  it('seeds once when init and a read ask for it together', async () => {
    await loadWorker();
    const seeding = tgs.initTabGroupKeyCache();
    const read = tgs.getLastTabGroupKey(7);
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all([seeding, read]);
    await tgs.initTabGroupKeyCache();
    expect(chrome.tabGroups.query).toHaveBeenCalledTimes(1);
    expect(await tgs.getLastTabGroupKey(7)).toBe('blue:Research');
  });

  it('neither seeds nor makes reads wait in the incognito worker', async () => {
    await loadWorker({ incognito: true });
    expect(await stateOf(tgs.getLastTabGroupKey(7))).toBe('settled');
    await tgs.initTabGroupKeyCache();
    expect(chrome.tabGroups.query).not.toHaveBeenCalled();
    expect(await chrome.storage.session.get(null)).toEqual({});
  });
});
