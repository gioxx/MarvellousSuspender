import  { gsChrome }              from './gsChrome.js';
import  { gsSession }             from './gsSession.js';
import  { gsUtils }               from './gsUtils.js';
import  { historyUtils }          from './historyUtils.js';

(() => {
  'use strict';

  gsUtils.documentReadyAndLocalisedAsPromised(window).then(function() {
    document.getElementById('exportBackupBtn').onclick = async function(e) {
      const currentSession = await gsSession.buildCurrentSession();
      historyUtils.exportSession(currentSession, function() {
        document.getElementById('exportBackupBtn').style.display = 'none';
      });
    };
    document.getElementById('setFilePermissiosnBtn').onclick = async function(
      e
    ) {
      // Requesting the file:///* host permission only succeeds once the user has
      // enabled "Allow access to file URLs" for this extension - Chrome silently
      // resolves the request to false rather than throwing if that toggle is off,
      // it can't be flipped via the API (#514). Try the direct grant first so a
      // user who already has the toggle on isn't sent on a pointless detour.
      const granted = await chrome.permissions.request({ origins: ['file:///*'] }).catch(() => false);
      if (!granted) {
        // A denied request also resolves to false when the toggle IS already on and
        // the user simply declined the browser's own permission prompt (Codex review) -
        // only the toggle-off case needs the chrome://extensions redirect; a real
        // decline should leave the user on this page rather than send them somewhere
        // that has nothing left for them to do.
        await gsSession.ensureFileUrlsStateReady();
        if (!gsSession.isFileUrlsAccessAllowed()) {
          await gsChrome.tabsCreate({
            url: 'chrome://extensions?id=' + chrome.runtime.id,
          });
        }
      }
    };
  });
})();
