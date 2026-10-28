import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createChromeStub } from './setup/chrome-stub.js';

// What addFaviconMeta() hands to the store. There is no IndexedDB under Node, so the
// write is caught at _replaceByUrl(); the end-to-end suite runs the same path against
// the browser's own store ("the stores that keep one row per url").

let originalChrome;
let gsIndexedDb;
let replace;

beforeEach(async () => {
  originalChrome = globalThis.chrome;
  vi.resetModules();
  globalThis.chrome = createChromeStub();
  ({ gsIndexedDb } = await import('../src/js/gsIndexedDb.js'));
  replace = vi.spyOn(gsIndexedDb, '_replaceByUrl').mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.chrome = originalChrome;
});

describe('addFaviconMeta', () => {
  // The root-hostname fallback of gsFavicon saves, for the page url, the row it read for
  // the root url, id included (#549). The id belongs to the root url's row, and the store
  // assigns its own: carried along, add() fails with a ConstraintError every time.
  it('stores a row read for another url under its own url, without that row\'s id', async () => {
    const readForRoot = { id: 7, url: 'example.com', favIconUrl: 'data:image/png;base64,AA==', v: 2 };

    await gsIndexedDb.addFaviconMeta('example.com/watch', readForRoot);

    expect(replace).toHaveBeenCalledTimes(1);
    const [store, url, record] = replace.mock.calls[0];
    expect(store).toBe(gsIndexedDb.DB_FAVICON_META);
    expect(url).toBe('example.com/watch');
    expect(record).toEqual({ url: 'example.com/watch', favIconUrl: 'data:image/png;base64,AA==', v: 2 });
    expect(readForRoot).toEqual({ id: 7, url: 'example.com', favIconUrl: 'data:image/png;base64,AA==', v: 2 });
  });

  // Before the copy, a missing meta threw inside Object.assign() and nothing was written;
  // a bare { url } row would replace a valid one with a row that never validates.
  it.each([undefined, null])('writes nothing when the meta is %s', async (missing) => {
    await gsIndexedDb.addFaviconMeta('example.com/watch', missing);

    expect(replace).not.toHaveBeenCalled();
  });
});
