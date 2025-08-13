import  { gsFavicon }             from './gsFavicon.js';
import  { gsSession }             from './gsSession.js';
import  { gsUtils }               from './gsUtils.js';

export const historyItems = (() => {
  'use strict';

  async function createSessionHtml(session, showLinks) {
    session.windows = session.windows || [];

    const sessionType =
      session.sessionId === (await gsSession.getSessionId())
        ? 'current'
        : session.name
        ? 'saved'
        : 'recent';
    const winCnt = session.windows.length;
    const tabCnt = session.windows.reduce(function(a, b) { return a + b.tabs.length; }, 0);

    let winText   = winCnt > 1 ? 'js_history_windows' : 'js_history_window';
    winText       = chrome.i18n.getMessage(winText).toLowerCase();
    let tabText   = tabCnt > 1 ? 'js_history_tabs' : 'js_history_tab';
    tabText       = chrome.i18n.getMessage(tabText).toLowerCase();

    const sessionIcon   = createEl('i',     { class: 'sessionIcon icon icon-plus-squared-alt' });
    const sessionDiv    = createEl('div',   { class: 'sessionContents' });
    const sessionTitle  = createEl('span',  { class: 'sessionLink' });

    const sessionSave   = createEl('a',     { class: 'groupLink saveLink',      href: '#', }, chrome.i18n.getMessage('js_history_save'));
    const sessionDelete = createEl('a',     { class: 'groupLink deleteLink',    href: '#', }, chrome.i18n.getMessage('js_history_delete'));
    const windowSuspend = createEl('a',     { class: 'groupLink resuspendLink', href: '#', }, chrome.i18n.getMessage('js_history_resuspend'));
    const windowReload  = createEl('a',     { class: 'groupLink reloadLink',    href: '#', }, chrome.i18n.getMessage('js_history_reload'));
    const sessionExport = createEl('a',     { class: 'groupLink exportLink',    href: '#', }, chrome.i18n.getMessage('js_history_export'));
    const sessionDIV    = createEl('div',   { class: 'sessionContainer', });

    const sessionName = (sessionType === 'saved') ? session.name : gsUtils.getHumanDate(session.date);
    sessionTitle.innerHTML = `${sessionName} &nbsp; <small>(${winCnt} ${winText}, ${tabCnt} ${tabText})</small>`;

    sessionDIV.appendChild(sessionIcon);
    sessionDIV.appendChild(sessionTitle);
    if (showLinks && sessionType !== 'current') {
      sessionDIV.appendChild(windowSuspend);
      sessionDIV.appendChild(windowReload);
    }
    if (showLinks) {
      sessionDIV.appendChild(sessionExport);
    }
    if (showLinks && sessionType !== 'saved') {
      sessionDIV.appendChild(sessionSave);
    }
    if (showLinks && sessionType !== 'current') {
      sessionDIV.appendChild(sessionDelete);
    }

    sessionDIV.appendChild(sessionDiv);

    return sessionDIV;
  }

  function createWindowHtml(index, showLinks) {
    let groupHeading, windowContainer, groupUnsuspendCurrent, groupUnsuspendNew;

    groupHeading = createEl('div', { class: 'windowContainer', id: 'main-div-' + index });

    var windowString = chrome.i18n.getMessage('js_history_window');
    windowContainer = createEl( 'span', {}, windowString + ' ' + (index + 1) + ':\u00A0');

    windowContainer.appendChild(createEl('a', { class: 'groupLink exportLink' + index,  href: '#' }, chrome.i18n.getMessage('js_history_export')));
    windowContainer.appendChild(createEl('a', { class: 'groupLink saveLink' + index,    href: '#' }, chrome.i18n.getMessage('js_history_save')));
    groupUnsuspendCurrent = createEl('a',     { class: 'groupLink resuspendLink ',      href: '#main-div-' + index }, chrome.i18n.getMessage('js_history_resuspend'));
    groupUnsuspendNew = createEl('a',         { class: 'groupLink reloadLink',          href: '#main-div-' + index }, chrome.i18n.getMessage('js_history_reload'));

    groupHeading.appendChild(windowContainer);
    if (showLinks) {
      groupHeading.appendChild(groupUnsuspendCurrent);
      groupHeading.appendChild(groupUnsuspendNew);
    }

    return groupHeading;
  }

  async function createTabHtml(tab, showLinks) {
    let linksSpan;

    if (tab.sessionId) {
      linksSpan = createEl('div', { class: 'tabContainer', 'data-tabId': tab.id || tab.url, 'data-url': tab.url });
    }
    else {
      linksSpan = createEl('div', { class: 'tabContainer', 'data-url': tab.url });
    }

    const listHover = createEl( 'span', { class: 'itemHover removeLink' }, '\u274C\uFE0E');

    const faviconMeta = await gsFavicon.getFaviconMeta(tab);
    const favIconUrl = faviconMeta.normalisedDataUrl;
    const listImg = createEl('img', { src: favIconUrl, height: '16px', width: '16px' });
    const listLink = createEl('a', { class: 'historyLink', href: tab.url, target: '_blank' }, tab.title && tab.title.length > 1 ? tab.title : tab.url);

    if (showLinks) {
      linksSpan.appendChild(listHover);
    }

    if (tab.group?.title) {
      const group     = createEl('span',  { class: `group chrome ${tab.group.color}` }, tab.group.title);
      linksSpan.appendChild(group);
    }

    linksSpan.appendChild(listImg);

    if (tab.isSuspended) {
      const suspended = createEl('span', {  });
      suspended.innerHTML = '&nbsp;&#x1F4A4;&#XFE0E;';
      linksSpan.appendChild(suspended);
    }

    linksSpan.appendChild(listLink);

    return linksSpan;
  }

  function createEl(elType, attributes, text) {
    var el = document.createElement(elType);
    attributes = attributes || {};
    el = setElAttributes(el, attributes);
    el.innerHTML = gsUtils.htmlEncode(text || '');
    return el;
  }

  function setElAttributes(el, attributes) {
    for (let key in attributes) {
      if (attributes.hasOwnProperty(key)) {
        el.setAttribute(key, attributes[key]);
      }
    }
    return el;
  }

  return {
    createSessionHtml,
    createWindowHtml,
    createTabHtml,
  };
})();
