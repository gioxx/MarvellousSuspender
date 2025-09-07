import  { gsSession }             from './gsSession.js';
import  { gsUtils }               from './gsUtils.js';

(function() {
  'use strict';

  function toggleUpdated() {
    document.getElementById('updating').style.display = 'none';
    document.getElementById('updated').style.display = 'block';
  }

  gsUtils.documentReadyAndLocalisedAsPromised(window).then(async () => {
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

  async function messageRequestListener(request, sender, sendResponse) {
    gsUtils.log('updated', 'messageRequestListener', request.action, request, sender);

    switch (request.action) {

      case 'toggleUpdated' : {
        // { action: 'toggleUpdated', tabId: context.tabId }
        toggleUpdated();
        sendResponse();
        break;
      }

      default: {
        // NOTE: All messages sent to chrome.runtime will be delivered here too
        gsUtils.log('updated', 'messageRequestListener', `Ignoring unhandled message: ${request.action}`);
        // sendResponse();
        break;
      }
    }
    return true;
  }

  gsUtils.documentReadyAndLocalisedAsPromised(window).then(function() {
    gsUtils.log('updated', 'documentReadyAndLocalisedAsPromised');
    chrome.runtime.onMessage.addListener(messageRequestListener);
  });

})();
