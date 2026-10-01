import { afterEach, describe, expect, it, vi } from 'vitest';
import { gsChrome } from '../src/js/gsChrome.js';
import { gsSession } from '../src/js/gsSession.js';

const suspendedUrl = chrome.runtime.getURL('suspended.html#ttl=Example&pos=0&uri=https://example.com/');
const extensionIcon = chrome.runtime.getURL('img/ic_suspendy_16x16.webp');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('favicon repair backstop count (#523)', () => {
  it('counts loaded placeholders with a missing or extension favicon, not discarded ones', async () => {
    vi.spyOn(gsChrome, 'tabsQuery').mockResolvedValue([
      { id: 1, url: suspendedUrl, discarded: false, favIconUrl: extensionIcon },
      { id: 2, url: suspendedUrl, discarded: false, favIconUrl: '' },
      { id: 3, url: suspendedUrl, discarded: false, favIconUrl: 'data:image/png;base64,AAAA' },
      { id: 4, url: suspendedUrl, discarded: true, favIconUrl: extensionIcon },
      { id: 5, url: 'https://example.com/', discarded: false, favIconUrl: '' },
    ]);
    expect(await gsSession.countTabsWithBrokenSuspendedFavicon()).toBe(2);
  });
});
