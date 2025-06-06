import  { gsUtils }               from './gsUtils.js';
// import  { tgs }                   from './tgs.js';

(function(global) {
  'use strict';

  // try {
  //   tgs.setViewGlobals(global);
  // } catch (e) {
  //   setTimeout(() => window.location.reload(), 1000);
  //   return;
  // }

  function init() {
    document
      .getElementById('restartExtension')
      .addEventListener('click', function() {
        chrome.runtime.reload();
      });
    document
      .getElementById('sessionManagementLink')
      .addEventListener('click', function() {
        chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
      });
  }
  if (document.readyState !== 'loading') {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', function() {
      init();
    });
  }

  gsUtils.documentReadyAndLocalisedAsPromised(document);

})(this);
