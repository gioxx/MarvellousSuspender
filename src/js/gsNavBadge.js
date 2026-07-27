// @ts-check
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

  chrome.storage.local.get(FEED_KEY).then(data => applyBadge(data[FEED_KEY]));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[FEED_KEY]) {
      applyBadge(changes[FEED_KEY].newValue);
    }
  });
})();
