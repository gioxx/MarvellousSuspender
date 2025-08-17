import  { gsUtils }               from './gsUtils.js';

(() => {
  'use strict';

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

  gsUtils.documentReadyAndLocalisedAsPromised(window);

})();
