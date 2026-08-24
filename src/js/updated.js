import  { gsMascot }              from './gsMascot.js';
import  { gsSession }             from './gsSession.js';
import  { gsUtils }               from './gsUtils.js';

(function() {
  'use strict';

  async function toggleUpdated() {
    document.getElementById('updating').style.display = 'none';
    document.getElementById('updated').style.display = 'block';
    document.getElementById('suspendyGuy').src = await gsMascot.resolvePath('img/suspendy-guy-success.webp');
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

  function messageRequestListener(request, sender, sendResponse) {
    // Declared synchronous (not async): an async function's `return false` is still a
    // resolved Promise, and Chrome/Firefox treat a returned Promise as this listener's
    // eventual response, letting its trivial resolved value race the service worker's
    // real, slower response for actions like 'checkTabResponsiveness'.
    // See the matching guard in options.js: these are service-worker-only actions that
    // Chrome still broadcasts here, and gsAppendLogEntries specifically must not be
    // logged or its own "ignored" log entry would need flushing via another one, forever.
    if (gsUtils.INTERNAL_MESSAGE_ACTIONS.has(request.action)) return false;

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
