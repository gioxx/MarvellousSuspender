// @ts-check
import { gsStorage } from './gsStorage.js';

(() => {
  'use strict';

  const FEED_KEY = 'tmsNewsFeed';

  function applyBadge(feed) {
    const badge = document.getElementById('navNewsBadge');
    if (!badge) return;
    const seenIds = feed?.seenIds ?? [];
    const hasUnread = feed?.items?.length && feed.items.some(i => !seenIds.includes(i.link));
    badge.classList.toggle('reallyHidden', !hasUnread);
  }

  async function applyNavVisibility() {
    const navItem = document.getElementById('navNewsBadge')?.closest('li');
    if (!navItem) return;
    const enabled = await gsStorage.getOption(gsStorage.NEWS_FEED_ENABLED);
    navItem.classList.toggle('reallyHidden', !enabled);
  }

  applyNavVisibility();
  chrome.storage.local.get(FEED_KEY).then(data => applyBadge(data[FEED_KEY]));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[FEED_KEY]) {
      applyBadge(changes[FEED_KEY].newValue);
    }
    if (changes.gsSettings) {
      applyNavVisibility();
    }
  });
})();
