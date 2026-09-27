import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createChromeStub, EXTENSION_ID } from './setup/chrome-stub.js';

// Characterisation of gsTabSuspendManager.checkTabEligibilityForSuspension(): these cases
// pin what the function does today, including what looks wrong. A case whose name ends in
// "(defect: see comment)" or "(oddity: see comment)" is expected to change when the
// behaviour it describes is fixed.

const NORMAL_URL = 'https://example.com/page';
const SUSPENDED_URL = `chrome-extension://${EXTENSION_ID}/suspended.html#ttl=Example&pos=0&uri=${NORMAL_URL}`;

let originalChrome;
let gsStorage;
let tgs;
let check;

function makeTab(overrides = {}) {
  return {
    id: 5,
    windowId: 1,
    url: NORMAL_URL,
    title: 'Example',
    active: false,
    pinned: false,
    audible: false,
    groupId: -1,
    ...overrides,
  };
}

// By the name of the constant in gsStorage. A name that is not one fails the case: a
// setting written under `undefined` would leave the default in place and prove nothing.
async function setOptions(options) {
  for (const [key, value] of Object.entries(options)) {
    if (typeof gsStorage[key] !== 'string') throw new Error(`gsStorage has no option named ${key}`);
    await gsStorage.setOption(gsStorage[key], value);
  }
}

beforeEach(async () => {
  originalChrome = globalThis.chrome;
  vi.resetModules();
  globalThis.chrome = createChromeStub();
  chrome.windows.get = vi.fn(async () => ({ id: 1, type: 'normal' }));
  chrome.tabGroups.get = vi.fn((groupId, callback) => callback({ id: groupId, color: 'blue', title: 'Work' }));

  ({ gsStorage } = await import('../src/js/gsStorage.js'));
  ({ tgs } = await import('../src/js/tgs.js'));
  const { gsTabSuspendManager } = await import('../src/js/gsTabSuspendManager.js');
  check = gsTabSuspendManager.checkTabEligibilityForSuspension;

  vi.spyOn(tgs, 'isCurrentFocusedTab').mockResolvedValue(false);
  vi.spyOn(tgs, 'isCharging').mockResolvedValue(undefined);
  // The real one waits up to 3 seconds for a cache that nothing seeds here.
  vi.spyOn(tgs, 'getLastTabGroupKey').mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  globalThis.chrome = originalChrome;
});

describe('checkTabEligibilityForSuspension at force level 1', () => {
  it('accepts a normal web page', async () => {
    await expect(check(makeTab(), 1)).resolves.toBe(true);
  });

  it.each([
    ['a browser page', 'chrome://settings/'],
    ['a blank page', 'about:blank'],
    ['a page of another extension', 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/page.html'],
    ['an own page other than the suspended one', `chrome-extension://${EXTENSION_ID}/options.html`],
    ['a data url', 'data:text/html,hello'],
    ['a view-source url', `view-source:${NORMAL_URL}`],
  ])('rejects %s as a special tab', async (label, url) => {
    await expect(check(makeTab({ url }), 1)).resolves.toBe(false);
  });

  it('reads pendingUrl when the tab has no url', async () => {
    await expect(check(makeTab({ url: undefined, pendingUrl: 'chrome://newtab/' }), 1)).resolves.toBe(false);
    await expect(check(makeTab({ url: '', pendingUrl: NORMAL_URL }), 1)).resolves.toBe(true);
  });

  it('accepts a tab that is already suspended, a suspended tab not being special', async () => {
    await expect(check(makeTab({ url: SUSPENDED_URL }), 1)).resolves.toBe(true);
    await expect(check(makeTab({ url: SUSPENDED_URL }), 3)).resolves.toBe(true);
  });

  // isSpecialTab() asks isSuspendedTab() with loose matching, which is a bare
  // indexOf('suspended.html') > 0, so the text anywhere in any url switches the check off.
  // The tab is not suspended for it: executeTabSuspension() uses the same loose match and
  // refuses it as already suspended (pinned in the execute file).
  it('accepts a browser page whose url merely contains suspended.html (defect: see comment)', async () => {
    await expect(check(makeTab({ url: 'chrome://settings/?q=suspended.html' }), 1)).resolves.toBe(true);
  });

  // isSpecialTab() returns false for a tab it cannot read a url from. With both lists
  // empty, as they are by default, no later check reads the url, and the tab passes every
  // level. With an entry in either list, see the next case.
  it('accepts a tab with no url at all, at every level (oddity: see comment)', async () => {
    const tab = makeTab({ url: undefined });
    await expect(check(tab, 1)).resolves.toBe(true);
    await expect(check(tab, 3)).resolves.toBe(true);
  });

  // The lists are matched against tab.url as it is, with no guard for a tab that has none.
  it.each([
    ['the whitelist', 'WHITELIST'],
    ['the always suspend list', 'ALWAYS_SUSPEND_LIST'],
  ])('throws on a tab with no url once %s has an entry (defect: see comment)', async (label, optionKey) => {
    await setOptions({ [optionKey]: 'example.com' });
    await expect(check(makeTab({ url: undefined }), 2)).rejects.toThrow(TypeError);
    await expect(check(makeTab({ url: undefined }), 1)).resolves.toBe(true);
  });

  it('rejects a file tab while file access is not usable', async () => {
    await expect(check(makeTab({ url: 'file:///tmp/a.txt' }), 1)).resolves.toBe(false);
  });

  it('accepts a file tab once the toggle and the host permission are both on', async () => {
    chrome.extension.isAllowedFileSchemeAccess = (callback) => callback(true);
    chrome.permissions.contains = async () => true;
    await expect(check(makeTab({ url: 'file:///tmp/a.txt' }), 1)).resolves.toBe(true);
  });

  it('ignores every level 2 protection', async () => {
    tgs.isCurrentFocusedTab.mockResolvedValue(true);
    await setOptions({ WHITELIST: 'example.com', IGNORE_GROUPED_TABS: true });
    const tab = makeTab({ active: true, pinned: true, audible: true, groupId: 7 });
    await expect(check(tab, 1)).resolves.toBe(true);
  });
});

describe('checkTabEligibilityForSuspension with a force level that is not 1, 2 or 3', () => {
  // Every gate is `forceLevel >= n`, which is false for undefined, null, NaN and 0, so
  // no check runs at all and the function falls through to `return true`. Nothing relies
  // on this: every call site passes 1, 2 or 3. It is not a way to ask for "force", and a
  // fix would refuse such a level.
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['0', 0],
    ['NaN', NaN],
    ['a non numeric string', 'high'],
    ['a negative number', -1],
  ])('treats a level of %s as "skip every check", so a browser page is eligible (defect: see comment)', async (label, forceLevel) => {
    await expect(check(makeTab({ url: 'chrome://settings/' }), forceLevel)).resolves.toBe(true);
  });

  // `>=` converts its operands, so the level is never checked for being a number.
  it('coerces a numeric string (oddity: see comment)', async () => {
    const pinned = makeTab({ pinned: true });
    await expect(check(pinned, '1')).resolves.toBe(true);
    await expect(check(pinned, '2')).resolves.toBe(false);
  });

  it('applies the checks of level 1 to a level between 1 and 2', async () => {
    await expect(check(makeTab({ pinned: true }), 1.5)).resolves.toBe(true);
    await expect(check(makeTab({ url: 'chrome://settings/' }), 1.5)).resolves.toBe(false);
  });

  it('applies the checks of level 3 to a level above 3', async () => {
    await setOptions({ SUSPEND_TIME: '0' });
    await expect(check(makeTab(), 4)).resolves.toBe(false);
  });
});

describe('checkTabEligibilityForSuspension at force level 2', () => {
  it('accepts a plain background tab under the default options', async () => {
    await expect(check(makeTab(), 2)).resolves.toBe(true);
  });

  it('still rejects a special tab', async () => {
    await expect(check(makeTab({ url: 'chrome://settings/' }), 2)).resolves.toBe(false);
  });

  it('rejects the focused tab even with the active tab option off', async () => {
    tgs.isCurrentFocusedTab.mockResolvedValue(true);
    await setOptions({ IGNORE_ACTIVE_TABS: false });
    await expect(check(makeTab(), 2)).resolves.toBe(false);
  });

  it('rejects the focused tab even when its url is on the always suspend list', async () => {
    tgs.isCurrentFocusedTab.mockResolvedValue(true);
    await setOptions({ ALWAYS_SUSPEND_LIST: 'example.com' });
    await expect(check(makeTab(), 2)).resolves.toBe(false);
  });

  it('rejects an active tab of an unfocused window only while the active tab option is on', async () => {
    const tab = makeTab({ active: true });
    await expect(check(tab, 2)).resolves.toBe(false);
    await setOptions({ IGNORE_ACTIVE_TABS: false });
    await expect(check(tab, 2)).resolves.toBe(true);
  });

  it('rejects a url on the whitelist', async () => {
    await setOptions({ WHITELIST: 'other.example\nexample.com' });
    await expect(check(makeTab(), 2)).resolves.toBe(false);
    await expect(check(makeTab({ url: 'https://unlisted.test/' }), 2)).resolves.toBe(true);
  });

  it.each([
    ['a pinned', { pinned: true }, 'IGNORE_PINNED'],
    ['an audible', { audible: true }, 'IGNORE_AUDIO'],
  ])('rejects %s tab only while its option is on', async (label, tabProps, optionKey) => {
    const tab = makeTab(tabProps);
    await expect(check(tab, 2)).resolves.toBe(false);
    await setOptions({ [optionKey]: false });
    await expect(check(tab, 2)).resolves.toBe(true);
  });

  it('rejects a tab in an app window only while its option is on', async () => {
    chrome.windows.get.mockResolvedValue({ id: 1, type: 'app' });
    await expect(check(makeTab(), 2)).resolves.toBe(false);
    await setOptions({ IGNORE_APP_WINDOWS: false });
    await expect(check(makeTab(), 2)).resolves.toBe(true);
  });

  // isTabInAppWindow() catches the failure and answers "not an app window": the
  // protection fails open.
  it('accepts a tab whose window cannot be fetched (oddity: see comment)', async () => {
    chrome.windows.get.mockRejectedValue(new Error('No window with id: 1.'));
    await expect(check(makeTab(), 2)).resolves.toBe(true);
  });

  it('rejects a grouped tab only while its option is on, which it is not by default', async () => {
    const tab = makeTab({ groupId: 7 });
    await expect(check(tab, 2)).resolves.toBe(true);
    await setOptions({ IGNORE_GROUPED_TABS: true });
    await expect(check(tab, 2)).resolves.toBe(false);
    await expect(check(makeTab({ groupId: -1 }), 2)).resolves.toBe(true);
  });

  it('rejects a tab whose group is on the never suspend list', async () => {
    await setOptions({ NEVER_SUSPEND_GROUPS: 'red:Other\nblue:Work' });
    await expect(check(makeTab({ groupId: 7 }), 2)).resolves.toBe(false);
    expect(chrome.tabGroups.get).toHaveBeenCalledWith(7, expect.any(Function));
    await expect(check(makeTab({ groupId: -1 }), 2)).resolves.toBe(true);
    await setOptions({ NEVER_SUSPEND_GROUPS: 'red:Other' });
    await expect(check(makeTab({ groupId: 7 }), 2)).resolves.toBe(true);
  });

  it.each([
    ['the whitelist', { WHITELIST: 'example.com' }, {}],
    ['the pinned protection', {}, { pinned: true }],
    ['the audible protection', {}, { audible: true }],
    ['the app window protection', {}, { windowId: 2 }],
    ['the grouped tab protection', { IGNORE_GROUPED_TABS: true }, { groupId: 7 }],
    ['the never suspend group list', { NEVER_SUSPEND_GROUPS: 'blue:Work' }, { groupId: 7 }],
  ])('lets a url on the always suspend list bypass %s', async (label, options, tabProps) => {
    chrome.windows.get.mockImplementation(async (windowId) => ({ id: windowId, type: windowId === 2 ? 'app' : 'normal' }));
    const tab = makeTab(tabProps);
    await setOptions(options);
    await expect(check(tab, 2)).resolves.toBe(false);
    await setOptions({ ALWAYS_SUSPEND_LIST: 'example.com' });
    await expect(check(tab, 2)).resolves.toBe(true);
  });

  it('ignores every level 3 condition', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    tgs.isCharging.mockResolvedValue(true);
    await setOptions({ IGNORE_WHEN_OFFLINE: true, IGNORE_WHEN_CHARGING: true, SUSPEND_TIME: '0' });
    await expect(check(makeTab(), 2)).resolves.toBe(true);
  });
});

describe('checkTabEligibilityForSuspension at force level 3', () => {
  it('accepts a plain background tab under the default options', async () => {
    await expect(check(makeTab(), 3)).resolves.toBe(true);
  });

  it('still applies the level 2 protections', async () => {
    await expect(check(makeTab({ pinned: true }), 3)).resolves.toBe(false);
  });

  // navigator.onLine is stubbed in every case: Node's navigator has none, and the
  // `!navigator.onLine` of the source would read that as offline.
  it.each([
    ['rejects', 'offline with the option on', true, false, false],
    ['accepts', 'online with the option on', true, true, true],
    ['accepts', 'offline with the option off', false, false, true],
  ])('%s a tab while %s', async (verb, label, option, onLine, expected) => {
    vi.stubGlobal('navigator', { onLine });
    await setOptions({ IGNORE_WHEN_OFFLINE: option });
    await expect(check(makeTab(), 3)).resolves.toBe(expected);
  });

  it.each([
    ['rejects', 'charging with the option on', true, true, false],
    ['accepts', 'on battery with the option on', true, false, true],
    ['accepts', 'in an unknown charging state with the option on', true, undefined, true],
    ['accepts', 'charging with the option off', false, true, true],
  ])('%s a tab while %s', async (verb, label, option, charging, expected) => {
    tgs.isCharging.mockResolvedValue(charging);
    await setOptions({ IGNORE_WHEN_CHARGING: option });
    await expect(check(makeTab(), 3)).resolves.toBe(expected);
  });

  // Columns: suspend time, suspend time on battery, isCharging(), eligible.
  it.each([
    ['60', '', undefined, true],
    ['0', '', undefined, false],
    ['0', '', false, false],
    ['0', '30', false, true],
    ['0', '30', true, false],
    ['0', '30', undefined, false],
    ['60', '0', false, false],
    ['60', '0', true, true],
    ['60', '0', undefined, true],
  ])('with suspend time %j, battery time %j and charging %j resolves %j', async (suspendTime, batteryTime, charging, expected) => {
    tgs.isCharging.mockResolvedValue(charging);
    await setOptions({ SUSPEND_TIME: suspendTime, SUSPEND_TIME_ON_BATTERY: batteryTime });
    await expect(check(makeTab(), 3)).resolves.toBe(expected);
  });

  // The comparison is `=== '0'`, so "never" stored as a number is not recognised.
  it('does not read a numeric 0 suspend time as "never" (oddity: see comment)', async () => {
    await setOptions({ SUSPEND_TIME: 0 });
    await expect(check(makeTab(), 3)).resolves.toBe(true);
  });

  // The list lifts the level 2 protections, not the level 3 conditions.
  it('applies the suspend time to a url on the always suspend list', async () => {
    await setOptions({ ALWAYS_SUSPEND_LIST: 'example.com' });
    await expect(check(makeTab(), 3)).resolves.toBe(true);
    await expect(check(makeTab({ pinned: true }), 3)).resolves.toBe(true);
    await setOptions({ SUSPEND_TIME: '0' });
    await expect(check(makeTab(), 3)).resolves.toBe(false);
  });
});
