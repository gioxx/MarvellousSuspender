import  { gsSession }             from './gsSession.js';
import  { gsUtils }               from './gsUtils.js';

(function(global) {
  'use strict';

  function toggleUpdated() {
    document.getElementById('updating').style.display = 'none';
    document.getElementById('updated').style.display = 'block';
  }

  gsUtils.documentReadyAndLocalisedAsPromised(document).then(async () => {
    // var versionEl = document.getElementById('updatedVersion');
    // versionEl.innerHTML = 'v' + chrome.runtime.getManifest().version;

    document.getElementById('sessionManagerLink').onclick = function(e) {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
    };

    const updateType = await gsSession.getUpdateType();
    if (updateType === 'major') {
      document.getElementById('patchMessage').style.display = 'none';
      document.getElementById('minorUpdateDetail').style.display = 'none';
    }
    else if (updateType === 'minor') {
      document.getElementById('patchMessage').style.display = 'none';
      document.getElementById('majorUpdateDetail').style.display = 'none';
    }
    else {
      document.getElementById('updateDetail').style.display = 'none';
    }

    if (await gsSession.isUpdated()) {
      toggleUpdated();
    }
  });

  global.exports = {
    toggleUpdated,
  };
})(this);
