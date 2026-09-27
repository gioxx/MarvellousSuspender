import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createChromeStub, EXTENSION_ID } from './setup/chrome-stub.js';

// Characterisation of gsTabSuspendManager.executeTabSuspension(): these cases pin what the
// function does today. A case whose name ends in "(defect: see comment)" or "(oddity: see
// comment)" is expected to change when the behaviour it describes is fixed.

const NORMAL_URL = 'https://example.com/page';
const GIVEN_SUSPENDED_URL = `chrome-extension://${EXTENSION_ID}/suspended.html#ttl=Given&pos=120&uri=${NORMAL_URL}`;

let originalChrome;
let gsStorage;
let gsUtils;
let tgs;
let gsTabCheckManager;
let gsTabDiscardManager;
let execute;

function makeTab(overrides = {}) {
  return { id: 5, windowId: 1, url: NORMAL_URL, title: 'Example', ...overrides };
}

// The flag is written to session storage under the tab id; read it back through tgs.
function initialiseFlag(tabId) {
  return tgs.getTabStatePropForTabId(tabId, tgs.STATE_INITIALISE_SUSPENDED_TAB);
}

beforeEach(async () => {
  originalChrome = globalThis.chrome;
  vi.resetModules();
  globalThis.chrome = createChromeStub();
  chrome.tabs.update = vi.fn((tabId, props, callback) => callback({ id: tabId, ...props }));
  chrome.alarms.clear = vi.fn(async () => true);

  ({ gsStorage } = await import('../src/js/gsStorage.js'));
  ({ gsUtils } = await import('../src/js/gsUtils.js'));
  ({ tgs } = await import('../src/js/tgs.js'));
  ({ gsTabCheckManager } = await import('../src/js/gsTabCheckManager.js'));
  ({ gsTabDiscardManager } = await import('../src/js/gsTabDiscardManager.js'));
  const { gsTabSuspendManager } = await import('../src/js/gsTabSuspendManager.js');
  execute = gsTabSuspendManager.executeTabSuspension;

  vi.spyOn(gsTabCheckManager, 'unqueueTabCheck').mockImplementation(() => {});
  vi.spyOn(gsTabDiscardManager, 'queueTabForDiscard').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.chrome = originalChrome;
});

describe('executeTabSuspension', () => {
  it('navigates the tab to the suspended url it was given and resolves true', async () => {
    const tab = makeTab();
    await expect(execute(tab, GIVEN_SUSPENDED_URL)).resolves.toBe(true);
    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.update).toHaveBeenCalledWith(5, { url: GIVEN_SUSPENDED_URL }, expect.any(Function));
    await expect(initialiseFlag(5)).resolves.toBe(true);
  });

  it('rebuilds a missing suspended url from the tab, with scroll position 0', async () => {
    const tab = makeTab();
    await expect(execute(tab, undefined)).resolves.toBe(true);
    const rebuilt = gsUtils.generateSuspendedUrl(NORMAL_URL, 'Example', 0);
    expect(rebuilt).toBe(`chrome-extension://${EXTENSION_ID}/suspended.html#ttl=Example&pos=0&uri=${NORMAL_URL}`);
    expect(chrome.tabs.update).toHaveBeenCalledWith(5, { url: rebuilt }, expect.any(Function));
  });

  it.each([
    ['a plain suspension', false, makeTab(), GIVEN_SUSPENDED_URL, () => true],
    ['a discard', true, makeTab(), GIVEN_SUSPENDED_URL, () => true],
    ['a tab that is already suspended', false, makeTab({ url: GIVEN_SUSPENDED_URL }), undefined, () => true],
    ['a cancelled suspension', false, makeTab(), GIVEN_SUSPENDED_URL, () => false],
  ])('unqueues the pending tab check for %s', async (label, discard, tab, suspendedUrl, isStillCurrent) => {
    await gsStorage.setOption(gsStorage.DISCARD_IN_PLACE_OF_SUSPEND, discard);
    await execute(tab, suspendedUrl, isStillCurrent);
    expect(gsTabCheckManager.unqueueTabCheck).toHaveBeenCalledTimes(1);
    expect(gsTabCheckManager.unqueueTabCheck).toHaveBeenCalledWith(tab);
  });

  it('queues the tab for discard instead when discard replaces suspend', async () => {
    await gsStorage.setOption(gsStorage.DISCARD_IN_PLACE_OF_SUSPEND, true);
    const tab = makeTab();
    await expect(execute(tab, GIVEN_SUSPENDED_URL)).resolves.toBe(true);
    expect(chrome.alarms.clear).toHaveBeenCalledWith('5');
    expect(gsTabDiscardManager.queueTabForDiscard).toHaveBeenCalledWith(tab);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    await expect(initialiseFlag(5)).resolves.toBeUndefined();
  });

  // The discard branch returns before both the already-suspended check and the
  // isStillCurrent check, and reports success without waiting for the discard itself.
  it('discards a suspended tab of a cancelled job and still resolves true (oddity: see comment)', async () => {
    await gsStorage.setOption(gsStorage.DISCARD_IN_PLACE_OF_SUSPEND, true);
    const isStillCurrent = vi.fn(() => false);
    const tab = makeTab({ url: GIVEN_SUSPENDED_URL });
    await expect(execute(tab, undefined, isStillCurrent)).resolves.toBe(true);
    expect(gsTabDiscardManager.queueTabForDiscard).toHaveBeenCalledWith(tab);
    expect(isStillCurrent).not.toHaveBeenCalled();
  });

  it('resolves false for a tab that is already suspended and leaves it alone', async () => {
    const isStillCurrent = vi.fn(() => true);
    await expect(execute(makeTab({ url: GIVEN_SUSPENDED_URL }), undefined, isStillCurrent)).resolves.toBe(false);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(isStillCurrent).not.toHaveBeenCalled();
    await expect(initialiseFlag(5)).resolves.toBeUndefined();
  });

  // Loose matching: the same bare indexOf('suspended.html') > 0 the eligibility check uses.
  // A page can therefore keep itself from ever being suspended by having that text in
  // its url.
  it('takes any url containing suspended.html for a suspended tab (defect: see comment)', async () => {
    const tab = makeTab({ url: 'https://example.com/docs/suspended.html' });
    await expect(execute(tab, GIVEN_SUSPENDED_URL)).resolves.toBe(false);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  // STATE_INITIALISE_SUSPENDED_TAB is written before isStillCurrent() is asked, and nothing
  // clears it on the cancelled path.
  it('resolves false without navigating when the job is no longer current, leaving the initialise flag set (oddity: see comment)', async () => {
    const setState = vi.spyOn(tgs, 'setTabStatePropForTabId');
    const isStillCurrent = vi.fn(() => false);
    await expect(execute(makeTab(), GIVEN_SUSPENDED_URL, isStillCurrent)).resolves.toBe(false);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(isStillCurrent).toHaveBeenCalledTimes(1);
    expect(setState).toHaveBeenCalledWith(5, tgs.STATE_INITIALISE_SUSPENDED_TAB, true);
    expect(setState.mock.invocationCallOrder[0]).toBeLessThan(isStillCurrent.mock.invocationCallOrder[0]);
    await expect(initialiseFlag(5)).resolves.toBe(true);
  });

  it('asks isStillCurrent after the state write and before the navigation', async () => {
    const setState = vi.spyOn(tgs, 'setTabStatePropForTabId');
    const isStillCurrent = vi.fn(() => true);
    await expect(execute(makeTab(), GIVEN_SUSPENDED_URL, isStillCurrent)).resolves.toBe(true);
    expect(setState.mock.invocationCallOrder[0]).toBeLessThan(isStillCurrent.mock.invocationCallOrder[0]);
    expect(isStillCurrent.mock.invocationCallOrder[0]).toBeLessThan(chrome.tabs.update.mock.invocationCallOrder[0]);
  });

  // The success test is `updatedTab !== null`, and chrome hands back undefined, not null,
  // when it has no tab to give.
  it('resolves true when chrome.tabs.update gives back undefined (oddity: see comment)', async () => {
    chrome.tabs.update.mockImplementation((tabId, props, callback) => callback(undefined));
    await expect(execute(makeTab(), GIVEN_SUSPENDED_URL)).resolves.toBe(true);
  });

  it('resolves false when chrome.tabs.update fails with lastError', async () => {
    chrome.tabs.update.mockImplementation((tabId, props, callback) => {
      chrome.runtime.lastError = { message: 'No tab with id: 5.' };
      callback(undefined);
      chrome.runtime.lastError = undefined;
    });
    await expect(execute(makeTab(), GIVEN_SUSPENDED_URL)).resolves.toBe(false);
    await expect(initialiseFlag(5)).resolves.toBe(true);
  });
});
