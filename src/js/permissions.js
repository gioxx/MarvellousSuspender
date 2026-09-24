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
    const returnHint            = document.getElementById('filePermissionsReturnHint');

    // chrome.permissions.request() requires an actual user gesture to show its prompt, so
    // returning from chrome://extensions can't just silently retry it - the button below
    // needs a second real click once the toggle is on. Pulsing the button alone doesn't
    // say why a click that already went to "Open extension settings" needs doing again
    // (Codex review, #514) - a plain-language hint now appears too, once this page regains
    // visibility after being sent there, and is cleared again on the next click either way.
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
      returnHint.classList.remove('hidden');
    });

    setFilePermissionsBtn.onclick = async function(e) {
      returnHint.classList.add('hidden');
      // Requesting the file:///* host permission only succeeds once the user has
      // enabled "Allow access to file URLs" for this extension - Chrome silently
      // resolves the request to false rather than throwing if that toggle is off,
      // it can't be flipped via the API (#514). Try the direct grant first so a
      // user who already has the toggle on isn't sent on a pointless detour.
      const granted = await chrome.permissions.request({ origins: ['file:///*'] }).catch(() => false);
      // Checked regardless of `granted`: if the permission was already held from an
      // earlier grant and the user has since disabled "Allow access to file URLs",
      // request() just re-confirms the still-held permission and resolves true
      // immediately, with no prompt - file tabs are still unusable, but skipping this
      // check whenever granted is true would leave the click doing nothing at all in
      // that case (Codex review, #514).
      await gsSession.ensureFileUrlsStateReady();
      if (!gsSession.isFileUrlsAccessAllowed()) {
        // A denied request also resolves to false when the toggle IS already on and
        // the user simply declined the browser's own permission prompt (Codex review) -
        // only the toggle-off case needs the chrome://extensions redirect; a real
        // decline should leave the user on this page rather than send them somewhere
        // that has nothing left for them to do.
        awaitingReturnFromSettings = true;
        await gsChrome.tabsCreate({
          url: 'chrome://extensions?id=' + chrome.runtime.id,
        });
      }
    };
  });
})();
