import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// tgs.js only seeds its tab group key cache in the service worker, which it tells apart by
// this global, and the seed runs once per worker: each test loads a fresh copy of the modules
// with the global defined.
let tgs;
let gsStorage;
let gsTabSuspendManager;
let groups;

async function loadWorker({ incognito = false } = {}) {
  vi.resetModules();
  globalThis.ServiceWorkerGlobalScope = function ServiceWorkerGlobalScope() {};
  chrome.extension.inIncognitoContext = incognito;
  ({ tgs } = await import('../src/js/tgs.js'));
  ({ gsStorage } = await import('../src/js/gsStorage.js'));
  ({ gsTabSuspendManager } = await import('../src/js/gsTabSuspendManager.js'));
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

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
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

async function storedList() {
  const { gsSettings } = await chrome.storage.local.get(['gsSettings']);
  return gsSettings[gsStorage.NEVER_SUSPEND_GROUPS];
}

// The first import transforms the whole module graph: done once here, outside any test's
// timeout, so loadWorker() only has to evaluate it again.
beforeAll(async () => {
  await import('../src/js/tgs.js');
}, 30000);

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
  delete chrome.tabs.query;
  delete chrome.tabs.update;
  chrome.storage.local._reset();
  chrome.storage.session._reset();
});

describe('tab group key cache seed (#501)', () => {
  it('lets reads through while the seed is queued behind a long lock holder', async () => {
    await loadWorker();
    // an Options "remove" holding the tab group lock for as long as its write takes
    const holder = deferred();
    vi.spyOn(gsStorage, 'updateOptionAndSync').mockImplementationOnce(() => holder.promise);
    const removing = tgs.setTabGroupNeverSuspend('red:Inbox', false);

    // one exemption check after another, as a pass over many grouped tabs makes them
    const reads = (async () => {
      for (let i = 0; i < 20; i++) {
        await tgs.getLastTabGroupKey(groups[i % groups.length].id);
      }
    })();
    expect(await stateOf(reads)).toBe('settled');
    // the seed has been started, and is still waiting for its lock turn
    expect(chrome.tabGroups.query).not.toHaveBeenCalled();

    holder.resolve(false);
    await removing;
    await drain();
    expect(chrome.tabGroups.query).toHaveBeenCalledTimes(1);
  });

  it('follows a rename once a read has started the seed, though init has not run', async () => {
    await loadWorker();
    const read = tgs.getLastTabGroupKey(7);
    await vi.advanceTimersByTimeAsync(3000);
    await read;

    groups[0].title = 'Research 2';
    const renaming = tgs.handleTabGroupUpdated({ id: 7 });
    await vi.advanceTimersByTimeAsync(3000);
    await renaming;
    expect(await storedList()).toBe('blue:Research 2');
  });

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

describe('reconciling a group that was just exempted (#501)', () => {
  it('tries every tab, then rejects with the first failure in tab order', async () => {
    await loadWorker();
    await chrome.storage.local.set({
      gsSettings: { ...(await chrome.storage.local.get(['gsSettings'])).gsSettings, [gsStorage.NEVER_SUSPEND_GROUPS]: '' },
    });
    vi.spyOn(gsTabSuspendManager, 'unqueueTabForSuspension').mockImplementation(() => {});
    const suspendedUrl = (n) => chrome.runtime.getURL(`suspended.html#ttl=Page&pos=0&uri=https://example.com/${n}`);
    const tabs = [1, 2, 3, 4].map((id) => ({ id, windowId: 1, groupId: 7, url: suspendedUrl(id) }));
    chrome.tabs.query = vi.fn((queryInfo, callback) => callback(tabs.filter((tab) => tab.groupId === queryInfo.groupId)));
    chrome.tabs.update = vi.fn(async (tabId) => {
      if (tabId === 2 || tabId === 3) {
        throw new Error(`No tab with id: ${tabId}.`);
      }
      return {};
    });

    await expect(tgs.setTabGroupNeverSuspend('blue:Research', true)).rejects.toThrow('No tab with id: 2.');
    expect(chrome.tabs.update.mock.calls.map(([tabId]) => tabId)).toEqual([1, 2, 3, 4]);
    expect(await storedList()).toBe('blue:Research');
  });
});
