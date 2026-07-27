// @ts-check
import  { gsNewsFeed }   from './gsNewsFeed.js';
import  { gsUtils }      from './gsUtils.js';

(() => {
  'use strict';

  function createCard(item, isUnread) {
    const card = document.createElement('article');
    card.className = 'newsCard' + (isUnread ? ' newsCard--unread' : '');
    card.dataset.link = item.link;

    const meta = document.createElement('div');
    meta.className = 'newsCard__meta';

    if (isUnread) {
      const pill = document.createElement('span');
      pill.className = 'newsCard__newPill';
      pill.textContent = gsUtils.getMessage('html_news_new_pill') || 'NEW';
      meta.appendChild(pill);
    }

    if (item.pubDate) {
      const dateSpan = document.createElement('span');
      try {
        dateSpan.textContent = new Date(item.pubDate).toLocaleDateString();
      } catch (_e) {
        dateSpan.textContent = item.pubDate;
      }
      meta.appendChild(dateSpan);
    }

    card.appendChild(meta);

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

  function updateMarkAllVisibility(listEl) {
    const hasUnread = listEl.querySelector('.newsCard--unread') !== null;
    document.getElementById('newsMarkAllRead').classList.toggle('reallyHidden', !hasUnread);
  }

  gsUtils.documentReadyAndLocalisedAsPromised(window).then(async () => {

    if (chrome.extension.inIncognitoContext) {
      for (const el of document.getElementsByClassName('noIncognito')) {
        el.classList.add('hidden');
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

    await gsNewsFeed.fetchAndCacheIfStale();

    const feed    = await gsNewsFeed.getCachedFeed();
    const seenIds = new Set(feed.seenIds ?? []);
    loadingEl.classList.add('reallyHidden');

    if (!feed.items.length) {
      emptyEl.classList.remove('reallyHidden');
    } else {
      for (const item of feed.items) {
        const isUnread = !seenIds.has(item.link);
        const card     = createCard(item, isUnread);

        card.querySelector('a').addEventListener('click', async () => {
          if (card.classList.contains('newsCard--unread')) {
            card.classList.remove('newsCard--unread');
            card.querySelector('.newsCard__newPill')?.remove();
            await gsNewsFeed.markSeen(item.link);
            updateMarkAllVisibility(listEl);
          }
        });

        listEl.appendChild(card);
      }
      listEl.classList.remove('reallyHidden');
      updateMarkAllVisibility(listEl);
    }

    document.getElementById('newsMarkAllRead').addEventListener('click', async (e) => {
      e.preventDefault();
      for (const card of listEl.querySelectorAll('.newsCard--unread')) {
        card.classList.remove('newsCard--unread');
        card.querySelector('.newsCard__newPill')?.remove();
      }
      document.getElementById('newsMarkAllRead').classList.add('reallyHidden');
      await gsNewsFeed.markAllSeen();
    });

  });

})();
