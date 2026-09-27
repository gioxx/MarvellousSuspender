import { describe, it, expect } from 'vitest';
import { gsUtils } from '../src/js/gsUtils.js';
import { EXTENSION_ID } from './setup/chrome-stub.js';

// suspended.html is web-accessible, so any web page can open
// chrome-extension://<id>/suspended.html#...&uri=<anything> and the extension will treat
// it as one of its own suspended tabs. The recovered "original" url is passed to
// chrome.tabs.update / chrome.tabs.create on unsuspend, restore and recovery, which an
// extension may point at chrome:// and data: urls that web content itself cannot reach.
// Only urls the extension could have suspended in the first place may come back out.

const OWN_PREFIX = `chrome-extension://${EXTENSION_ID}/suspended.html`;
const forged = (uri) => `${OWN_PREFIX}#ttl=Google%20Docs&pos=0&uri=${uri}`;
const forgedLegacy = (url) => `${OWN_PREFIX}#ttl=Google%20Docs&pos=0&url=${encodeURIComponent(url)}`;

describe('gsUtils.getOriginalUrl only returns navigable web or file urls', () => {
  it.each([
    'https://example.com/path?q=1&r=2#frag',
    'http://intranet.local:8080/',
    'file:///Users/me/notes.html',
  ])('keeps %s', (url) => {
    expect(gsUtils.getOriginalUrl(forged(url))).toBe(url);
    expect(gsUtils.getOriginalUrl(forgedLegacy(url))).toBe(url);
  });

  it.each([
    'chrome://settings/resetProfileSettings',
    'chrome://extensions',
    'edge://settings',
    'brave://rewards',
    'about:blank',
    'data:text/html,<h1>hello</h1>',
    'javascript:alert(1)',
    'blob:https://example.com/uuid',
    'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/page.html',
    'devtools://devtools/bundled/inspector.html',
    'view-source:https://example.com/',
  ])('drops %s from the "uri=" parameter', (url) => {
    expect(gsUtils.getOriginalUrl(forged(url))).toBe('');
  });

  it.each([
    'chrome://settings/resetProfileSettings',
    'data:text/html,<h1>hello</h1>',
    'javascript:alert(1)',
  ])('drops %s from the legacy "url=" parameter', (url) => {
    expect(gsUtils.getOriginalUrl(forgedLegacy(url))).toBe('');
  });

  it('drops a value that is not an absolute url at all', () => {
    expect(gsUtils.getOriginalUrl(forged('not a url'))).toBe('');
    expect(gsUtils.getOriginalUrl(forged('/relative/path'))).toBe('');
  });

  it('is scheme-case-insensitive when rejecting', () => {
    expect(gsUtils.getOriginalUrl(forged('CHROME://settings'))).toBe('');
    expect(gsUtils.getOriginalUrl(forged('JavaScript:alert(1)'))).toBe('');
  });

  it('is scheme-case-insensitive when accepting and preserves the original spelling', () => {
    expect(gsUtils.getOriginalUrl(forged('HTTPS://Example.com/A'))).toBe('HTTPS://Example.com/A');
  });
});
