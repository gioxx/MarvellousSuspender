import { describe, it, expect } from 'vitest';
import { gsUtils } from '../src/js/gsUtils.js';
import { EXTENSION_ID } from './setup/chrome-stub.js';

const OWN_PREFIX = `chrome-extension://${EXTENSION_ID}/suspended.html`;
const OTHER_PREFIX = 'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/suspended.html';

describe('gsUtils.getHashVariable', () => {
  it('returns false when the URL has no hash', () => {
    expect(gsUtils.getHashVariable('ttl', 'https://example.com/page')).toBe(false);
  });

  it('returns false for a key that is not in the hash', () => {
    expect(gsUtils.getHashVariable('missing', `${OWN_PREFIX}#ttl=Title&pos=0`)).toBe(false);
  });

  it('returns the raw value of an ordinary key', () => {
    expect(gsUtils.getHashVariable('pos', `${OWN_PREFIX}#ttl=Title&pos=120`)).toBe('120');
  });

  it('does not decode the value of an ordinary key', () => {
    expect(gsUtils.getHashVariable('ttl', `${OWN_PREFIX}#ttl=A%20%26%20B&pos=0`)).toBe('A%20%26%20B');
  });

  it('treats everything after "uri=" as the uri, ampersands included', () => {
    const original = 'https://example.com/search?q=a&b=2#frag';
    expect(gsUtils.getHashVariable('uri', `${OWN_PREFIX}#ttl=T&pos=0&uri=${original}`)).toBe(original);
  });

  it('still resolves keys placed before "uri="', () => {
    const url = `${OWN_PREFIX}#ttl=T&pos=42&uri=https://example.com/?x=1&y=2`;
    expect(gsUtils.getHashVariable('pos', url)).toBe('42');
  });
});

describe('gsUtils.generateSuspendedUrl', () => {
  it('builds a suspended.html URL under the extension origin', () => {
    const url = gsUtils.generateSuspendedUrl('https://example.com/', 'Example', 0);
    expect(url.startsWith(`${OWN_PREFIX}#`)).toBe(true);
  });

  it('encodes the title and leaves the original url raw', () => {
    const url = gsUtils.generateSuspendedUrl('https://example.com/?a=1&b=2', 'Tom & Jerry', 10);
    expect(url).toBe(`${OWN_PREFIX}#ttl=Tom%20%26%20Jerry&pos=10&uri=https://example.com/?a=1&b=2`);
  });

  it('defaults the scroll position to 0', () => {
    const url = gsUtils.generateSuspendedUrl('https://example.com/', 'Example');
    expect(gsUtils.getHashVariable('pos', url)).toBe('0');
  });
});

describe('suspended url round-trip', () => {
  const original = 'https://example.com/path?q=a%20b&r=1#section';
  const title = 'Ünïcödé & symbols = #1';
  const suspended = gsUtils.generateSuspendedUrl(original, title, 350);

  it('getOriginalUrl recovers the exact original url', () => {
    expect(gsUtils.getOriginalUrl(suspended)).toBe(original);
  });

  it('getSuspendedTitle recovers the exact title', () => {
    expect(gsUtils.getSuspendedTitle(suspended)).toBe(title);
  });

  it('getSuspendedScrollPosition recovers the scroll position as a string', () => {
    expect(gsUtils.getSuspendedScrollPosition(suspended)).toBe('350');
  });
});

describe('gsUtils.getOriginalUrl', () => {
  it('decodes the legacy "url=" parameter', () => {
    const legacy = `${OWN_PREFIX}#ttl=T&pos=0&url=${encodeURIComponent('https://example.com/?a=1&b=2')}`;
    expect(gsUtils.getOriginalUrl(legacy)).toBe('https://example.com/?a=1&b=2');
  });

  it('prefers "uri=" over the legacy "url=" when both are present', () => {
    const both = `${OWN_PREFIX}#url=${encodeURIComponent('https://legacy.example/')}&uri=https://new.example/`;
    expect(gsUtils.getOriginalUrl(both)).toBe('https://new.example/');
  });

  it('returns an empty string when there is nothing to recover', () => {
    expect(gsUtils.getOriginalUrl(`${OWN_PREFIX}#ttl=T&pos=0`)).toBe('');
    expect(gsUtils.getOriginalUrl('https://example.com/')).toBe('');
  });
});

describe('gsUtils.isSuspendedUrl', () => {
  it('recognises this extension\'s suspended page', () => {
    expect(gsUtils.isSuspendedUrl(`${OWN_PREFIX}#ttl=T&pos=0&uri=https://a/`)).toBe(true);
  });

  it('rejects an ordinary web page', () => {
    expect(gsUtils.isSuspendedUrl('https://example.com/suspended.html')).toBe(false);
  });

  it('rejects undefined and empty input', () => {
    expect(gsUtils.isSuspendedUrl(undefined)).toBe(false);
    expect(gsUtils.isSuspendedUrl('')).toBe(false);
  });

  it('rejects another extension\'s suspended page under strict matching', () => {
    expect(gsUtils.isSuspendedUrl(`${OTHER_PREFIX}#uri=https://a/`)).toBe(false);
  });

  it('accepts another extension\'s suspended page under loose matching', () => {
    expect(gsUtils.isSuspendedUrl(`${OTHER_PREFIX}#uri=https://a/`, true)).toBe(true);
  });
});

describe('gsUtils.isSuspendedTab', () => {
  it('falls back to pendingUrl when url is not set yet', () => {
    expect(gsUtils.isSuspendedTab({ pendingUrl: `${OWN_PREFIX}#uri=https://a/` })).toBe(true);
  });

  it('is false for a tab with neither url nor pendingUrl', () => {
    expect(gsUtils.isSuspendedTab({})).toBe(false);
  });
});

describe('gsUtils.getCleanTabTitle', () => {
  it('returns the tab title when one is set', () => {
    expect(gsUtils.getCleanTabTitle({ url: 'https://a/', title: 'Hello' })).toBe('Hello');
  });

  it('falls back to the url for an untitled ordinary tab', () => {
    expect(gsUtils.getCleanTabTitle({ url: 'https://a/', title: '' })).toBe('https://a/');
  });

  it('recovers the title from the hash for an untitled suspended tab', () => {
    const suspended = gsUtils.generateSuspendedUrl('https://a/', 'Saved title', 0);
    expect(gsUtils.getCleanTabTitle({ url: suspended, title: '' })).toBe('Saved title');
  });

  it('treats the placeholder "Suspended Tab" title as empty', () => {
    const suspended = gsUtils.generateSuspendedUrl('https://a/', 'Real title', 0);
    expect(gsUtils.getCleanTabTitle({ url: suspended, title: 'Suspended Tab' })).toBe('Real title');
  });
});
