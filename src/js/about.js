import  { gsUtils }               from './gsUtils.js';

(() => {
  'use strict';

  gsUtils.documentReadyAndLocalisedAsPromised(window).then(() => {

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

})();
