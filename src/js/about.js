/* global chrome, XMLHttpRequest, gsUtils, gsStorage */
(function(global) {
  'use strict';

  try {
    chrome.extension.getBackgroundPage().tgs.setViewGlobals(global);
  } catch (e) {
    window.setTimeout(() => window.location.reload(), 1000);
    return;
  }

  gsUtils.documentReadyAndLocalisedAsPromised(document).then(() => {
    //Set theme
    gsStorage.getOption(gsStorage.THEME).then((theme) => {
      document.body.classList.add(theme === 'dark' ? 'dark' : null);
    });

    var versionEl = document.getElementById('aboutVersion');
    versionEl.innerHTML = 'v' + chrome.runtime.getManifest().version;

    //hide incompatible sidebar items if in incognito mode
    if (chrome.extension.inIncognitoContext) {
      Array.prototype.forEach.call(
        document.getElementsByClassName('noIncognito'),
        function(el) {
          el.style.display = 'none';
        },
      );
    }
  });

})(this);
