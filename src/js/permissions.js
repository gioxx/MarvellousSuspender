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
    const setFilePermissionsBtn = document.getElementById('setFilePermissiosnBtn');

    // chrome.permissions.request() requires an actual user gesture to show its prompt, so
    // returning from chrome://extensions can't just silently retry it - the button below
    // needs a second real click once the toggle is on. Nothing pointed the user back at
    // it (Codex review, #514): once this page regains visibility after being sent there,
    // pulse the button so the required next step is visible instead of a silent dead end.
    let awaitingReturnFromSettings = false;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !awaitingReturnFromSettings) return;
      awaitingReturnFromSettings = false;
      setFilePermissionsBtn.classList.add('pulse-attention');
      setFilePermissionsBtn.addEventListener(
        'animationend',
        () => setFilePermissionsBtn.classList.remove('pulse-attention'),
        { once: true },
      );
    });

    setFilePermissionsBtn.onclick = async function(e) {
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
          awaitingReturnFromSettings = true;
          await gsChrome.tabsCreate({
            url: 'chrome://extensions?id=' + chrome.runtime.id,
          });
        }
      }
    };
  });
})();
