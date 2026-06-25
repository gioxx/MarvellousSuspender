// @ts-check
(async () => {
  'use strict';
  const badge = document.getElementById('navNewsBadge');
  if (!badge) return;
  const data = await chrome.storage.local.get('tmsNewsFeed');
  const feed = data.tmsNewsFeed;
  if (!feed?.items?.length) return;
  const seenIds = feed.seenIds ?? [];
  if (feed.items.some(i => !seenIds.includes(i.link))) {
    badge.classList.remove('reallyHidden');
  }
})();
