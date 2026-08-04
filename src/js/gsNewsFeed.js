// @ts-check
import { gsStorage } from './gsStorage.js';

const gsNewsFeed = (() => {
  'use strict';

  const FEED_URL          = 'https://kb.marvellouscode.works/blog/rss.xml';
  const CACHE_KEY         = 'tmsNewsFeed';
  const OFFSET_KEY        = 'tmsNewsFeedMinuteOffset';
  const ALARM_NAME        = 'tms-news-feed';
  const CACHE_TTL_MS      = 24 * 60 * 60 * 1000;
  const MAX_ITEMS         = 10;
  const WINDOW_START_MIN  = 8 * 60;   // 08:00 local
  const WINDOW_SIZE_MIN   = 12 * 60;  // window ends at 20:00 local

  // Regex-based parsing (no DOMParser) so this also works from the service
  // worker context (background.js), which has no DOM APIs available.
  function decodeXmlEntities(str) {
    return str
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;|&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }

  function stripCData(str) {
    const match = str.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
    return match ? match[1] : str;
  }

  function extractTag(xml, tag) {
    const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return match ? stripCData(match[1]).trim() : '';
  }

  function extractAllTags(xml, tag) {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    const result = [];
    let match;
    while ((match = re.exec(xml))) {
      result.push(stripCData(match[1]).trim());
    }
    return result;
  }

  function stripHtmlTags(html) {
    return html.replace(/<[^>]*>/g, ' ');
  }

  function parseRssXml(text) {
    const result  = [];
    const itemRe  = /<item[^>]*>([\s\S]*?)<\/item>/gi;
    let itemMatch;
    while ((itemMatch = itemRe.exec(text))) {
      const itemXml = itemMatch[1];
      const title   = decodeXmlEntities(extractTag(itemXml, 'title'));
      const link    = decodeXmlEntities(extractTag(itemXml, 'link'));
      const pubDate = decodeXmlEntities(extractTag(itemXml, 'pubDate'));
      const categories = extractAllTags(itemXml, 'category').map(c => decodeXmlEntities(c).toLowerCase());
      if (!categories.some(c => c.includes('marvellous suspender'))) continue;
      const rawDesc = decodeXmlEntities(extractTag(itemXml, 'description'));
      const excerpt = stripHtmlTags(rawDesc).replace(/\s+/g, ' ').trim().slice(0, 220);
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
    const enabled = await gsStorage.getOption(gsStorage.NEWS_FEED_ENABLED);
    if (!enabled) return;
    const data   = await chrome.storage.local.get(CACHE_KEY);
    const cached = data[CACHE_KEY];
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return;
    await fetchAndCache();
  }

  async function getCachedFeed() {
    const data = await chrome.storage.local.get(CACHE_KEY);
    return data[CACHE_KEY] ?? { items: [], seenIds: [], fetchedAt: 0 };
  }

  async function markSeen(link) {
    const feed    = await getCachedFeed();
    const seenIds = new Set(feed.seenIds ?? []);
    seenIds.add(link);
    await chrome.storage.local.set({ [CACHE_KEY]: { ...feed, seenIds: [...seenIds] } });
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

  async function getMinuteOffset() {
    const data   = await chrome.storage.local.get(OFFSET_KEY);
    const stored = data[OFFSET_KEY];
    // accept only values inside the current window; regenerate if stale/out-of-range
    if (typeof stored === 'number' && stored >= WINDOW_START_MIN && stored < WINDOW_START_MIN + WINDOW_SIZE_MIN) {
      return stored;
    }
    const offset = WINDOW_START_MIN + Math.floor(Math.random() * WINDOW_SIZE_MIN);
    await chrome.storage.local.set({ [OFFSET_KEY]: offset });
    return offset;
  }

  async function syncAlarm() {
    const enabled = await gsStorage.getOption(gsStorage.NEWS_FEED_ENABLED);
    if (!enabled) {
      await chrome.alarms.clear(ALARM_NAME);
      return;
    }
    const offset   = await getMinuteOffset();
    const offsetMs = offset * 60_000;
    await chrome.alarms.clear(ALARM_NAME);
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const fireTime = midnight.getTime() + offsetMs;
    const when     = fireTime > Date.now() ? fireTime : fireTime + CACHE_TTL_MS;
    chrome.alarms.create(ALARM_NAME, { when, periodInMinutes: 1440 });
  }

  return { ALARM_NAME, fetchAndCache, fetchAndCacheIfStale, getCachedFeed, markSeen, markAllSeen, hasUnread, syncAlarm };
})();

export { gsNewsFeed };
