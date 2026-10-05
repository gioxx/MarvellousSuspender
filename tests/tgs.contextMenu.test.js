import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tgs } from '../src/js/tgs.js';
import { gsStorage } from '../src/js/gsStorage.js';
import { gsUtils } from '../src/js/gsUtils.js';

// Chrome 147 and older do not know the 'tab' context (tab strip menu):
// contextMenus.create() throws on it, synchronously. The fake below does the same.

const PAGE_CONTEXTS = ['all', 'page', 'frame', 'selection', 'link', 'editable', 'image', 'video', 'audio'];
const stubbed = ['create', 'removeAll', 'update'];
let original;
let originalTabsQuery;

// holdCallbacks: keep every create() callback back until released, to observe what the
// build waits for. throwOnId: a create() that throws for a reason other than the context.
function installContextMenus({ tabContext, holdCallbacks = false, failingId = null, throwOnId = null }) {
  const created = [];
  const held = [];
  const known = PAGE_CONTEXTS.concat(tabContext ? ['tab'] : []);
  chrome.contextMenus.create = vi.fn((properties, callback) => {
    for (const context of properties.contexts) {
      if (!known.includes(context)) {
        // the browser's own wording, as Chrome 146 gives it
        throw new TypeError('Error in invocation of contextMenus.create(contextMenus.CreateProperties createProperties, '
          + "optional function callback): Error at parameter 'createProperties': Error at property 'contexts': "
          + `Error at index 0: Value must be one of ${known.join(', ')}.`);
      }
    }
    if (properties.id === throwOnId) {
      throw new TypeError(`Error in invocation of contextMenus.create: unexpected property on ${properties.id}.`);
    }
    const report = () => {
      if (properties.id === failingId) {
        chrome.runtime.lastError = { message: `Cannot create item with duplicate id ${properties.id}` };
      }
      else {
        created.push(properties);
      }
      if (callback) callback();
      delete chrome.runtime.lastError;
    };
    if (holdCallbacks) held.push(report);
    else setTimeout(() => report(), 0);
  });
  chrome.contextMenus.removeAll = vi.fn((callback) => {
    created.length = 0;
    if (callback) setTimeout(() => callback(), 0);
  });
  chrome.contextMenus.update = vi.fn();
  return {
    created,
    held,
    releaseAllButLast: () => held.splice(0, held.length - 1).forEach((report) => report()),
    releaseAll: () => held.splice(0).forEach((report) => report()),
  };
}

const idsFor = (created, context) => created.filter((item) => item.contexts.includes(context)).map((item) => item.id);

// Runs the rebuild to its end on fake timers, including the debounced refresh of the
// never-suspend-group items that every build arms.
async function rebuild() {
  const result = tgs.rebuildContextMenu();
  result.catch(() => {});
  await vi.runAllTimersAsync();
  return result;
}

// 'pending' while the promise has not settled, after everything already queued has run.
async function stateOf(promise) {
  await vi.advanceTimersByTimeAsync(0);
  return Promise.race([promise, Promise.resolve('pending')]);
}

describe('tgs.rebuildContextMenu', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    original = Object.fromEntries(stubbed.map((name) => [name, chrome.contextMenus[name]]));
    // the refresh of the never-suspend-group items looks the active tab up: an ungrouped one
    originalTabsQuery = chrome.tabs.query;
    chrome.tabs.query = vi.fn((queryInfo, callback) => callback([{ id: 1, windowId: 1, groupId: -1, url: 'https://example.com/' }]));
    // the constant the browser gives for "in no group"; the stub has none
    chrome.tabGroups.TAB_GROUP_ID_NONE = -1;
    vi.spyOn(gsStorage, 'getOption').mockImplementation(async (option) => option === gsStorage.ADD_CONTEXT);
    vi.spyOn(gsUtils, 'warning').mockImplementation(() => {});
  });

  afterEach(async () => {
    await vi.runAllTimersAsync();
    for (const name of stubbed) {
      if (original[name] === undefined) delete chrome.contextMenus[name];
      else chrome.contextMenus[name] = original[name];
    }
    delete chrome.tabGroups.TAB_GROUP_ID_NONE;
    if (originalTabsQuery === undefined) delete chrome.tabs.query;
    else chrome.tabs.query = originalTabsQuery;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('builds the page menu and resolves where the browser refuses the tab context', async () => {
    const { created } = installContextMenus({ tabContext: false });
    await expect(rebuild()).resolves.toBeUndefined();
    expect(idsFor(created, 'link')).toEqual(['open_link_in_suspended_tab']);
    expect(idsFor(created, 'page')).toContain('open_session_history');
    expect(idsFor(created, 'tab')).toEqual([]);
  });

  it('stops asking for tab items after the first refusal', async () => {
    installContextMenus({ tabContext: false });
    await rebuild();
    const asked = chrome.contextMenus.create.mock.calls.filter(([properties]) => properties.contexts.includes('tab'));
    expect(asked).toHaveLength(1);
  });

  it('builds the page menu and the tab strip menu where the tab context exists', async () => {
    const { created } = installContextMenus({ tabContext: true });
    await expect(rebuild()).resolves.toBeUndefined();
    expect(idsFor(created, 'page')).toContain('open_session_history');
    expect(idsFor(created, 'tab')).toHaveLength(16);
    expect(idsFor(created, 'tab')).toEqual(expect.arrayContaining([
      'tab_toggle_suspend', 'tab_never_suspend_group', 'tab_unsuspend_all',
    ]));
  });

  it('creates the same page items, with the same properties, either way', async () => {
    const without = installContextMenus({ tabContext: false });
    await rebuild();
    const pageItemsWithout = without.created.filter((item) => !item.contexts.includes('tab'));

    const withTab = installContextMenus({ tabContext: true });
    await rebuild();
    const pageItemsWith = withTab.created.filter((item) => !item.contexts.includes('tab'));

    expect(pageItemsWithout.length).toBeGreaterThan(10);
    expect(pageItemsWithout).toEqual(pageItemsWith);
  });

  it.each([false, true])('stays pending until the browser has created the very last item (tab context: %s)', async (tabContext) => {
    const menus = installContextMenus({ tabContext, holdCallbacks: true });
    const result = tgs.rebuildContextMenu();
    await vi.advanceTimersByTimeAsync(10);
    expect(menus.held.length).toBeGreaterThan(0);

    menus.releaseAllButLast();
    expect(await stateOf(result)).toBe('pending');

    menus.releaseAll();
    await expect(result).resolves.toBeUndefined();
    expect(menus.created[menus.created.length - 1].id).toBe(tabContext ? 'tab_unsuspend_all' : 'open_session_history');
  });

  it('says nothing louder than a log line when the refusal is the expected one', async () => {
    const log = vi.spyOn(gsUtils, 'log').mockImplementation(() => {});
    installContextMenus({ tabContext: false });
    await rebuild();
    expect(log).toHaveBeenCalledWith('tgs', expect.stringContaining('not available'), expect.stringContaining("property 'contexts'"));
    expect(gsUtils.warning).not.toHaveBeenCalled();
  });

  it('warns when the first tab item throws for any other reason, and goes without the tab strip menu', async () => {
    const { created } = installContextMenus({ tabContext: true, throwOnId: 'tab_toggle_suspend' });
    await expect(rebuild()).resolves.toBeUndefined();
    expect(idsFor(created, 'tab')).toEqual([]);
    expect(idsFor(created, 'page')).toContain('open_session_history');
    expect(gsUtils.warning).toHaveBeenCalledWith('tgs', expect.stringContaining('tab strip'), expect.stringContaining('tab_toggle_suspend'));
  });

  it('does not hide a create() that throws on a later tab item', async () => {
    installContextMenus({ tabContext: true, throwOnId: 'tab_suspend_group' });
    await expect(rebuild()).rejects.toThrow(/tab_suspend_group/);
  });

  it('does not hide a create() that throws on a page item', async () => {
    installContextMenus({ tabContext: true, throwOnId: 'open_session_history' });
    await expect(rebuild()).rejects.toThrow(/open_session_history/);
  });

  it('logs a create() the browser reports as failed, and still resolves', async () => {
    const { created } = installContextMenus({ tabContext: true, failingId: 'open_session_history' });
    await expect(rebuild()).resolves.toBeUndefined();
    expect(created.map((item) => item.id)).not.toContain('open_session_history');
    expect(gsUtils.warning).toHaveBeenCalledWith('tgs', 'contextMenus.create', 'open_session_history', expect.stringContaining('duplicate id'));
  });

  it('creates nothing when the context menu option is off', async () => {
    gsStorage.getOption.mockImplementation(async () => false);
    const { created } = installContextMenus({ tabContext: true });
    await rebuild();
    expect(chrome.contextMenus.removeAll).toHaveBeenCalled();
    expect(created).toEqual([]);
  });
});
