// @ts-check
import  { gsNewsFeed }   from './gsNewsFeed.js';
import  { gsUtils }      from './gsUtils.js';

(() => {
  'use strict';

  function createCard(item) {
    const card = document.createElement('article');
    card.className = 'newsCard';

    if (item.pubDate) {
      const meta = document.createElement('div');
      meta.className = 'newsCard__meta';
      try {
        meta.textContent = new Date(item.pubDate).toLocaleDateString();
      } catch (_e) {
        meta.textContent = item.pubDate;
      }
      card.appendChild(meta);
    }

    const h2   = document.createElement('h2');
    h2.className = 'newsCard__title';
    const link = document.createElement('a');
    link.href   = item.link;
    link.target = '_blank';
    link.rel    = 'noopener';
    link.textContent = item.title;
    h2.appendChild(link);
    card.appendChild(h2);

    if (item.excerpt) {
      const p = document.createElement('p');
      p.className  = 'newsCard__excerpt';
      p.textContent = item.excerpt;
      card.appendChild(p);
    }

    return card;
  }

  gsUtils.documentReadyAndLocalisedAsPromised(window).then(async () => {

    if (chrome.extension.inIncognitoContext) {
      for (const el of document.getElementsByClassName('noIncognito')) {
        el.style.display = 'none';
      }
    }

    const backToTopBtn = document.getElementById('backToTop');
    window.addEventListener('scroll', () => {
      backToTopBtn.classList.toggle('visible', window.scrollY > 200);
    }, { passive: true });
    backToTopBtn.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    const listEl    = document.getElementById('newsFeedList');
    const loadingEl = document.getElementById('newsFeedLoading');
    const emptyEl   = document.getElementById('newsFeedEmpty');

    // fetch directly from this page (CSP allows kb.marvellouscode.works)
    await gsNewsFeed.fetchAndCacheIfStale();

    const feed = await gsNewsFeed.getCachedFeed();
    loadingEl.classList.add('reallyHidden');

    if (!feed.items.length) {
      emptyEl.classList.remove('reallyHidden');
    } else {
      for (const item of feed.items) {
        listEl.appendChild(createCard(item));
      }
      listEl.classList.remove('reallyHidden');
    }

    await gsNewsFeed.markAllSeen();
    const badge = document.getElementById('navNewsBadge');
    if (badge) badge.classList.add('reallyHidden');

  });

})();
