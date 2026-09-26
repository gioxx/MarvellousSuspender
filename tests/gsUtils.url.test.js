import { describe, it, expect } from 'vitest';
import { gsUtils } from '../src/js/gsUtils.js';
import { EXTENSION_ID } from './setup/chrome-stub.js';

// The getRootUrl cases are carried over from the upstream suite that was dropped
// when the project was forked (src/js/tests/test_gsUtils.js, 2018).
describe('gsUtils.getRootUrl', () => {
  const cases = [
    ['https://google.com', 'google.com', 'google.com', 'https://google.com', 'https://google.com'],
    ['https://google.com/', 'google.com', 'google.com', 'https://google.com', 'https://google.com'],
    [
      'https://google.com/search?source=hp&q=rabbits',
      'google.com', 'google.com/search', 'https://google.com', 'https://google.com/search',
    ],
    ['www.google.com', 'www.google.com', 'www.google.com', 'www.google.com', 'www.google.com'],
    [
      'https://github.com/deanoemcke/thegreatsuspender/issues/478#issuecomment-430780678',
      'github.com',
      'github.com/deanoemcke/thegreatsuspender/issues/478',
      'https://github.com',
      'https://github.com/deanoemcke/thegreatsuspender/issues/478',
    ],
    [
      'file:///Users/dean/Downloads/session%20(63).txt',
      '/Users/dean/Downloads',
      '/Users/dean/Downloads/session%20(63).txt',
      'file:///Users/dean/Downloads',
      'file:///Users/dean/Downloads/session%20(63).txt',
    ],
    [
      'https://analytics.google.com/analytics/web/#/report-home/a52338347w84781065p87884368',
      'analytics.google.com',
      'analytics.google.com/analytics/web',
      'https://analytics.google.com',
      'https://analytics.google.com/analytics/web',
    ],
  ];

  it.each(cases)('%s', (url, host, hostPath, schemeHost, schemeHostPath) => {
    expect(gsUtils.getRootUrl(url, false, false)).toBe(host);
    expect(gsUtils.getRootUrl(url, true, false)).toBe(hostPath);
    expect(gsUtils.getRootUrl(url, false, true)).toBe(schemeHost);
    expect(gsUtils.getRootUrl(url, true, true)).toBe(schemeHostPath);
  });
});

describe('gsUtils.isBrowserInternalURL', () => {
  it.each([
    'chrome://settings',
    'about:blank',
    'edge://flags',
    'brave://rewards',
    'vivaldi://startpage',
    'opera://settings',
    'CHROME://extensions',
  ])('is true for %s', (url) => {
    expect(gsUtils.isBrowserInternalURL(url)).toBe(true);
  });

  it.each([
    'https://chrome.google.com/',
    'chrome-extension://abc/page.html',
    'file:///tmp/x.html',
    '',
    undefined,
  ])('is false for %s', (url) => {
    expect(gsUtils.isBrowserInternalURL(url)).toBe(false);
  });
});

describe('gsUtils.isSpecialTab', () => {
  it('is true for a browser-internal page', () => {
    expect(gsUtils.isSpecialTab({ id: 1, url: 'chrome://settings' })).toBe(true);
  });

  it('is true for any chrome-extension page, including other extensions', () => {
    expect(gsUtils.isSpecialTab({ id: 1, url: 'chrome-extension://zzzz/options.html' })).toBe(true);
    expect(gsUtils.isSpecialTab({ id: 1, url: `chrome-extension://${EXTENSION_ID}/options.html` })).toBe(true);
  });

  it('is false for this extension\'s own suspended page', () => {
    const suspended = gsUtils.generateSuspendedUrl('https://a/', 'T', 0);
    expect(gsUtils.isSpecialTab({ id: 1, url: suspended })).toBe(false);
  });

  it('is false for an ordinary https page', () => {
    expect(gsUtils.isSpecialTab({ id: 1, url: 'https://example.com/' })).toBe(false);
  });
});

describe('gsUtils.isFileTab', () => {
  it('is true for file:// urls', () => {
    expect(gsUtils.isFileTab({ id: 1, url: 'file:///Users/me/doc.html' })).toBe(true);
  });

  it('is false for https urls', () => {
    expect(gsUtils.isFileTab({ id: 1, url: 'https://example.com/' })).toBe(false);
  });
});

describe('gsUtils.decodeString / encodeString', () => {
  it('round-trips a string with reserved characters', () => {
    const raw = 'a b&c=d#e%f/g?h';
    expect(gsUtils.decodeString(gsUtils.encodeString(raw))).toBe(raw);
  });

  it('returns malformed percent-encoded input unchanged instead of throwing', () => {
    expect(gsUtils.decodeString('100%')).toBe('100%');
  });
});
