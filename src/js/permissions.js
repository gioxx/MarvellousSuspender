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
      await gsChrome.tabsCreate({
        url: 'chrome://extensions?id=' + chrome.runtime.id,
      });
    };
  });
})();
