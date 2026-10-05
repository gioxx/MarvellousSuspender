import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startFixtureServer } from './lib/server.js';
import { unpackExtension } from './lib/extension.js';
import { launchChrome } from './lib/browser.js';
import { connect } from './lib/cdp.js';
import { waitFor } from './lib/waitFor.js';

// The packaged extension, loaded in a real browser with a throwaway profile. One browser
// for the whole file: every test opens its own tabs and closes them.

// The id the manifest "key" gives the extension, the same as on the Chrome Web Store.
const STORE_ID = 'noogafoofpebimajpfpamcfhoaifemoa';

// How long a forged placeholder is watched after the click. The control right after the
// forged cases goes through the same steps and does navigate, well inside this window.
const INERT_WINDOW = 1500;

let server;
let extension;
let chrome;
let cdp;
let worker;
let manifest;
let base;
let openTabs = [];

const placeholder = (uri, title = 'Fixture') => `${base}suspended.html#ttl=${encodeURIComponent(title)}&pos=0&uri=${uri}`;
const isPlaceholder = (url) => url.startsWith(`${base}suspended.html`);

// Every tab a test opens is closed after it, passed or failed: see afterEach.
async function openTab(url, options) {
  const tab = await cdp.openTab(url, options);
  openTabs.push(tab);
  return tab;
}

async function openPage(name = 'page.html') {
  const tab = await openTab(server.url(name));
  await cdp.waitForUrl(tab.targetId, `${name} to load`, (url) => url === server.url(name));
  await waitFor(`${name} to finish loading`, () => cdp.evaluate(tab.sessionId, 'document.readyState === "complete"'));
  return tab;
}

// An extension page, once chrome.* is there for it to use.
async function openExtensionPage(name, options) {
  const tab = await openTab(`${base}${name}`, options);
  await waitFor(`${name} to finish loading`, () => cdp.evaluate(tab.sessionId, `
    document.readyState === 'complete' && location.href.startsWith(${JSON.stringify(base)}) && !!globalThis.chrome?.runtime?.id
  `));
  return tab;
}

// suspended.js attaches the click handlers, then reveals the page by adding 'visible' to
// the body. Before that a click lands on nothing.
const PLACEHOLDER_READY = `
  document.readyState === 'complete' && document.body.classList.contains('visible')
    && !!document.getElementById('suspendedMsg')
`;

// Sends the tab of a web page to a placeholder url, the way any page can, and waits for
// the placeholder to be ready for a click.
async function navigateToPlaceholder(tab, url) {
  await cdp.evaluate(tab.sessionId, `window.location.assign(${JSON.stringify(url)}); true`);
  await cdp.waitForUrl(tab.targetId, 'the placeholder to load', isPlaceholder);
  const sessionId = await cdp.attach(tab.targetId);
  await waitFor('the placeholder to be ready for a click', () => cdp.evaluate(sessionId, PLACEHOLDER_READY));
  return sessionId;
}

// Resolves with every url the tab was seen at during the window.
async function urlsDuring(tab, duration) {
  const seen = new Set();
  const end = Date.now() + duration;
  while (Date.now() < end) {
    seen.add(await cdp.urlOf(tab.targetId));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return [...seen];
}

beforeAll(async () => {
  server = await startFixtureServer();
  extension = await unpackExtension();
  manifest = JSON.parse(await readFile(join(extension.dir, 'manifest.json'), 'utf8'));
  chrome = await launchChrome({ extensionDir: extension.dir });
  cdp = await connect(chrome.port);

  // The worker's target shows up before its script has run, and a session attached that
  // early has no chrome.* yet: keep looking until one answers with the extension's id.
  const id = await waitFor('the extension service worker to be running', async () => {
    const target = (await cdp.targets())
      .find(({ type, url }) => type === 'service_worker' && url.endsWith('/js/background.js'));
    if (!target) return undefined;
    const sessionId = await cdp.attach(target.targetId);
    const runtimeId = await cdp.evaluate(sessionId, 'globalThis.chrome?.runtime?.id').catch(() => undefined);
    // a session that did not answer would still report the worker's exceptions, twice
    if (runtimeId) worker = sessionId;
    else await cdp.detach(sessionId);
    return runtimeId;
  }, { timeout: 30000 });
  base = `chrome-extension://${id}/`;
});

afterEach(async () => {
  const tabs = openTabs;
  openTabs = [];
  await Promise.allSettled(tabs.map((tab) => cdp.closeTab(tab)));
});

afterAll(async () => {
  // each one on its own: a close that fails must not keep the others from running
  const closed = await Promise.allSettled([
    (async () => {
      await cdp?.close();
      await chrome?.close();
    })(),
    extension?.remove(),
    server?.close(),
  ]);
  const failed = closed.filter(({ status }) => status === 'rejected').map(({ reason }) => reason);
  if (failed.length) throw new AggregateError(failed, 'Could not clean up after the run');
});

describe('the package', () => {
  it('installs under the store id', () => {
    expect(base).toBe(`chrome-extension://${STORE_ID}/`);
  });

  it('runs the version and the content security policy it was packaged with', async () => {
    const running = await cdp.evaluate(worker, 'chrome.runtime.getManifest()');
    expect(running.version).toBe(manifest.version);
    expect(running.content_security_policy.extension_pages).toBe(manifest.content_security_policy.extension_pages);
    expect(running.content_security_policy.extension_pages).toMatch(/(^|;)\s*frame-ancestors 'none'\s*(;|$)/);
  });

  it('opens the options page on first install', async () => {
    const page = await waitFor('the first-install page', async () => (await cdp.targets())
      .find(({ type, url }) => type === 'page' && url.startsWith(`${base}options.html`)));
    expect(page.url).toContain('firstTime');
  });

  it('renders the options page', async () => {
    const tab = await openTab(`${base}options.html`);
    const controls = await waitFor('the options to render', () => cdp.evaluate(tab.sessionId, `
      document.readyState === 'complete' && document.querySelectorAll('input, select').length
    `));
    expect(controls).toBeGreaterThan(5);
  });
});

describe('the context menu', () => {
  // Asking for an id that exists fails with a duplicate-id error: that is how presence is
  // read. 'present', 'absent', or the error when create() failed for any other reason.
  const presenceOf = (id) => cdp.evaluate(worker, `new Promise((resolve) => {
    chrome.contextMenus.create({ id: ${JSON.stringify(id)}, title: 'probe', contexts: ['page'] }, () => {
      const error = chrome.runtime.lastError?.message;
      if (!error) chrome.contextMenus.remove(${JSON.stringify(id)}, () => resolve('absent'));
      else resolve(/duplicate id/i.test(error) ? 'present' : error);
    });
  })`);

  it('is built to the end, once', async () => {
    await waitFor('the rebuild to be recorded as done', () => cdp.evaluate(worker, `
      chrome.storage.session.get('gsContextMenuRebuildDone').then((stored) => stored.gsContextMenuRebuildDone === true)
    `));
    expect(await presenceOf('open_link_in_suspended_tab')).toBe('present');
    expect(await presenceOf('open_session_history')).toBe('present');
    expect(await presenceOf('tms_e2e_no_such_item')).toBe('absent');
  });
});

describe('suspending and unsuspending', () => {
  it('suspends the active tab and brings it back on a click', async () => {
    const tab = await openPage();
    // the popup's own message, sent from an extension page opened behind the fixture
    // page, which stays the active tab of the window
    const sender = await openExtensionPage('about.html', { background: true });
    await cdp.activate(tab);
    await cdp.evaluate(sender.sessionId, 'chrome.runtime.sendMessage({ action: "suspendOne" }).then(() => true)');

    const suspended = await cdp.waitForUrl(tab.targetId, 'the tab to be suspended', isPlaceholder);
    expect(suspended).toContain(`uri=${server.url('page.html')}`);

    const sessionId = await cdp.attach(tab.targetId);
    await waitFor('the placeholder to be ready for a click', () => cdp.evaluate(sessionId, PLACEHOLDER_READY));
    expect(await cdp.evaluate(sessionId, 'document.getElementById("gsTopBarUrl").textContent')).toContain('127.0.0.1');

    await cdp.activate(tab);
    await cdp.click(sessionId, '#suspendedMsg');
    await cdp.waitForUrl(tab.targetId, 'the tab to be unsuspended', (url) => url === server.url('page.html'));

  });
});

describe('a placeholder url forged by a web page', () => {
  it.each([
    ['chrome:', 'chrome://settings/'],
    ['chrome:', 'chrome://extensions/'],
    ['data:', 'data:text/html,<h1>forged</h1>'],
    ['javascript:', 'javascript:alert(1)'],
    ['about:', 'about:blank'],
    ['view-source:', 'view-source:https://example.com/'],
    ['chrome-extension:', 'options.html'],
  ])('stays where it is on a click when it points at a %s url (%s)', async (scheme, uri) => {
    const target = scheme === 'chrome-extension:' ? `${base}${uri}` : uri;
    const tab = await openPage();
    const sessionId = await navigateToPlaceholder(tab, placeholder(target, 'Forged'));

    await cdp.activate(tab);
    await cdp.click(sessionId, '#suspendedMsg');

    const seen = await urlsDuring(tab, INERT_WINDOW);
    expect(seen).toHaveLength(1);
    expect(isPlaceholder(seen[0])).toBe(true);
  });

  it('unsuspends on a click when it points at an http url, through the same steps', async () => {
    const tab = await openPage();
    const sessionId = await navigateToPlaceholder(tab, placeholder(server.url('other.html'), 'Control'));

    await cdp.activate(tab);
    await cdp.click(sessionId, '#suspendedMsg');

    await cdp.waitForUrl(tab.targetId, 'the control to be unsuspended', (url) => url === server.url('other.html'), { timeout: INERT_WINDOW });
  });

  it('cannot be framed by a web page', async () => {
    const tab = await openPage();
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, tab.sessionId);
    const framesBefore = (await cdp.targets()).filter(({ type }) => type === 'iframe').map(({ targetId }) => targetId);

    await cdp.evaluate(tab.sessionId, `(() => {
      const frame = document.createElement('iframe');
      frame.src = ${JSON.stringify(placeholder(server.url('other.html'), 'Framed'))};
      document.body.appendChild(frame);
      return true;
    })()`);

    // the frame's target keeps the url that was asked for; what it loaded is what counts
    const frame = await waitFor('the frame to be there', async () => (await cdp.targets())
      .find(({ type, targetId }) => type === 'iframe' && !framesBefore.includes(targetId)));
    const frameSession = await cdp.attach(frame.targetId);
    const loaded = await waitFor('the frame to settle', () => cdp.evaluate(frameSession, `
      document.readyState === 'complete' && { href: location.href, placeholder: !!document.getElementById('suspendedMsg') }
    `));
    expect(loaded.href).toBe('chrome-error://chromewebdata/');
    expect(loaded.placeholder).toBe(false);
  });
});

describe('the stores that keep one row per url', () => {
  // Run inside an extension page, against the module the package ships and the browser's
  // own IndexedDB: when a transaction commits, and what an abort rolls back, is the
  // browser's to say. Each case writes under urls of its own.
  const STORES_IN_PAGE = `
    const { gsIndexedDb } = await import('/js/gsIndexedDb.js');
    const db = await gsIndexedDb.getDb();
    const stores = {
      previews: {
        name: gsIndexedDb.DB_PREVIEWS,
        field: 'img',
        write: (url, value) => gsIndexedDb.addPreviewImage(url, value),
        read: (url) => gsIndexedDb.fetchPreviewImage(url),
      },
      tabInfo: {
        name: gsIndexedDb.DB_SUSPENDED_TABINFO,
        field: 'title',
        write: (url, value) => gsIndexedDb.addSuspendedTabInfo({ url, title: value }),
        read: (url) => gsIndexedDb.fetchTabInfo(url),
      },
      faviconMeta: {
        name: gsIndexedDb.DB_FAVICON_META,
        field: 'favIconUrl',
        write: (url, value) => gsIndexedDb.addFaviconMeta(url, { favIconUrl: value }),
        read: (url) => gsIndexedDb.fetchFaviconMeta(url),
      },
    };
    const { name, field, write } = stores[key];
    // a row as an earlier version left it, written past the module
    const seed = (url, value) => db.add(name, { url, [field]: value });
    // what is stored for the url, oldest first
    const stored = async (url) => (await db.getAllFromIndex(name, 'url', url)).map((row) => row[field]);
    // what the extension is given when it asks for the url
    const read = async (url) => (await stores[key].read(url))?.[field] ?? null;
  `;
  const STORES = ['previews', 'tabInfo', 'faviconMeta'];

  let urls = 0;
  const newUrl = () => `https://stores.e2e.invalid/${urls += 1}`;

  async function inStore(key, body) {
    const page = await openExtensionPage('about.html');
    return cdp.evaluate(page.sessionId, `(async () => {
      const key = ${JSON.stringify(key)};
      const { url, other } = ${JSON.stringify({ url: newUrl(), other: newUrl() })};
      ${STORES_IN_PAGE}
      ${body}
    })()`);
  }

  it.each(STORES)('keep a single row in %s, the last one, when a url is written ten times at once', async (key) => {
    const result = await inStore(key, `
      await seed(other, 'other');
      await Promise.all(Array.from({ length: 10 }, (_, n) => write(url, 'write ' + n)));
      return { stored: await stored(url), read: await read(url), other: await stored(other) };
    `);
    expect(result).toEqual({ stored: ['write 9'], read: 'write 9', other: ['other'] });
  });

  it.each(STORES)('read the newest of the duplicates left in %s, which the next write removes', async (key) => {
    const result = await inStore(key, `
      await seed(url, 'older');
      await seed(url, 'newer');
      await seed(other, 'other');
      const readBefore = await read(url);
      await write(url, 'fresh');
      return { readBefore, stored: await stored(url), read: await read(url), other: await stored(other) };
    `);
    expect(result).toEqual({ readBefore: 'newer', stored: ['fresh'], read: 'fresh', other: ['other'] });
  });

  // A function cannot be cloned, so add() throws where it is called, and that by itself
  // does not abort the transaction the deletes were issued in.
  it.each(STORES)('keep the row in %s when the one replacing it cannot be stored', async (key) => {
    const result = await inStore(key, `
      await write(url, 'kept');
      await write(url, () => {});
      return { stored: await stored(url), read: await read(url) };
    `);
    expect(result).toEqual({ stored: ['kept'], read: 'kept' });
  });

  // A query for no url at all matches every row: of the three writers, the one for
  // previews is the one that does not check its url before it gets here.
  it.each([
    ['undefined', 'undefined'],
    ['null', 'null'],
  ])('keep every preview when one is written or read for an url that is %s', async (_, missing) => {
    const result = await inStore('previews', `
      await write(url, 'one');
      await write(other, 'another');
      await write(${missing}, 'no url');
      return { stored: await stored(url), other: await stored(other), read: await read(${missing}) };
    `);
    expect(result).toEqual({ stored: ['one'], other: ['another'], read: null });
  });
});

// Uncaught exceptions the extension is known to throw today. Each entry is a defect waiting
// for its own fix: remove it here in the change that fixes it.
const KNOWN_EXCEPTIONS = [
  // Suspending a tab unqueues its pending tab check, whose promise is awaited, without a
  // catch, by the onActivated and onUpdated listeners in background.js.
  /Queued tab job cancelled externally/,
];

describe('the whole run', () => {
  it('cannot reach any host but the fixture server', async () => {
    const reach = (sessionId, url) => cdp.evaluate(sessionId, `
      fetch(${JSON.stringify(url)}, { mode: 'no-cors' }).then(() => 'reached', () => 'failed')
    `);
    // the news feed, which the extension's own policy lets the worker connect to
    expect(await reach(worker, 'https://kb.marvellouscode.works/blog/rss.xml')).toBe('failed');

    const tab = await openPage();
    expect(await reach(tab.sessionId, 'https://example.com/')).toBe('failed');
    expect(await reach(tab.sessionId, server.url('other.html'))).toBe('reached');
  });

  it('threw nothing new in the service worker or in the pages it touched', () => {
    const unexpected = cdp.exceptions().filter((thrown) => !KNOWN_EXCEPTIONS.some((known) => known.test(thrown)));
    expect(unexpected).toEqual([]);
  });
});
