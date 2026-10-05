import { describe, it, expect, vi, afterEach } from 'vitest';
import { gsUtils } from '../src/js/gsUtils.js';
import { gsChrome } from '../src/js/gsChrome.js';
import { EXTENSION_ID } from './setup/chrome-stub.js';

// A suspended entry whose original url getOriginalUrl() refuses (forged, or from a scheme the
// extension no longer suspends) must be dropped before restore/recovery, never turned into a
// tab with an empty url.

const OWN_PREFIX = `chrome-extension://${EXTENSION_ID}/suspended.html`;
const forged = (uri) => `${OWN_PREFIX}#ttl=T&pos=0&uri=${uri}`;

function session(...windows) {
  return { windows: windows.map((tabs, i) => ({ id: i + 1, tabs })) };
}

describe('gsUtils.removeInternalUrlsFromSession', () => {
  it('drops a suspended tab whose original url cannot be recovered', () => {
    const s = session([
      { id: 1, url: forged('chrome://settings') },
      { id: 2, url: gsUtils.generateSuspendedUrl('https://keep.example/', 'Keep', 0) },
      { id: 3, url: 'https://plain.example/' },
    ]);
    gsUtils.removeInternalUrlsFromSession(s);
    expect(s.windows[0].tabs.map((t) => t.id)).toEqual([2, 3]);
  });

  it('removes a window left with no tabs', () => {
    const s = session(
      [{ id: 1, url: forged('data:text/html,x') }],
      [{ id: 2, url: 'https://plain.example/' }],
    );
    gsUtils.removeInternalUrlsFromSession(s);
    expect(s.windows.map((w) => w.id)).toEqual([2]);
  });

  it('still drops this extension\'s own internal pages', () => {
    const s = session([
      { id: 1, url: `chrome-extension://${EXTENSION_ID}/options.html` },
      { id: 2, url: 'https://plain.example/' },
    ]);
    gsUtils.removeInternalUrlsFromSession(s);
    expect(s.windows[0].tabs.map((t) => t.id)).toEqual([2]);
  });

  it('tolerates a missing session', () => {
    expect(() => gsUtils.removeInternalUrlsFromSession(undefined)).not.toThrow();
    expect(() => gsUtils.removeInternalUrlsFromSession({})).not.toThrow();
  });
});

describe('gsChrome.tabsCreate', () => {
  afterEach(() => {
    delete chrome.tabs.create;
  });

  it('refuses an empty url and never reaches chrome.tabs.create', async () => {
    chrome.tabs.create = vi.fn();
    await expect(gsChrome.tabsCreate({ url: '' })).resolves.toBeNull();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it('creates a tab for a real url', async () => {
    chrome.tabs.create = vi.fn((details, cb) => cb({ id: 42, ...details }));
    await expect(gsChrome.tabsCreate({ url: 'https://example.com/' })).resolves.toMatchObject({ id: 42 });
  });
});
