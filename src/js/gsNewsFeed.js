// @ts-check
const gsNewsFeed = (() => {
  'use strict';

  const FEED_URL     = 'https://kb.marvellouscode.works/blog/rss.xml';
  const CACHE_KEY    = 'tmsNewsFeed';
  const ALARM_NAME   = 'tms-news-feed';
  const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
  const MAX_ITEMS    = 10;

  function parseRssXml(text) {
    const parser = new DOMParser();
    const doc    = parser.parseFromString(text, 'application/xml');
    const items  = doc.querySelectorAll('channel > item');
    const result = [];
    for (const item of items) {
      const title   = item.querySelector('title')?.textContent?.trim()       ?? '';
      const link    = item.querySelector('link')?.textContent?.trim()        ?? '';
      const pubDate = item.querySelector('pubDate')?.textContent?.trim()     ?? '';
      const categories = [...item.querySelectorAll('category')].map(c => c.textContent?.toLowerCase() ?? '');
      if (!categories.some(c => c.includes('marvellous suspender'))) continue;
      const rawDesc = item.querySelector('description')?.textContent?.trim() ?? '';
      const tmpEl   = new DOMParser().parseFromString(rawDesc, 'text/html');
      const excerpt = (tmpEl.body?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 220);
      if (title && link) result.push({ title, link, pubDate, excerpt });
      if (result.length >= MAX_ITEMS) break;
    }
    return result;
  }

  async function fetchAndCache() {
    try {
      const response = await fetch(FEED_URL);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text     = await response.text();
      const items    = parseRssXml(text);
      const existing = await chrome.storage.local.get(CACHE_KEY);
      const seenIds  = existing[CACHE_KEY]?.seenIds ?? [];
      await chrome.storage.local.set({
        [CACHE_KEY]: { items, seenIds, fetchedAt: Date.now() },
      });
    } catch (_e) {
      // silently fail — cache stays as-is
    }
  }

  async function fetchAndCacheIfStale() {
    const data   = await chrome.storage.local.get(CACHE_KEY);
    const cached = data[CACHE_KEY];
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return;
    await fetchAndCache();
  }

  async function getCachedFeed() {
    const data = await chrome.storage.local.get(CACHE_KEY);
    return data[CACHE_KEY] ?? { items: [], seenIds: [], fetchedAt: 0 };
  }

  async function markAllSeen() {
    const feed    = await getCachedFeed();
    const seenIds = feed.items.map(i => i.link);
    await chrome.storage.local.set({ [CACHE_KEY]: { ...feed, seenIds } });
  }

  async function hasUnread() {
    const feed = await getCachedFeed();
    if (!feed.items.length) return false;
    return feed.items.some(i => !(feed.seenIds ?? []).includes(i.link));
  }

  async function syncAlarm() {
    const existing = await chrome.alarms.get(ALARM_NAME);
    if (!existing) {
      chrome.alarms.create(ALARM_NAME, {
        delayInMinutes: 1,
        periodInMinutes: 360,
      });
    }
  }

  return { ALARM_NAME, fetchAndCache, fetchAndCacheIfStale, getCachedFeed, markAllSeen, hasUnread, syncAlarm };
})();

export { gsNewsFeed };
