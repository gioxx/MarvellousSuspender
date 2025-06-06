// import  { gsStorage }             from './gsStorage.js';
import  { gsUtils }               from './gsUtils.js';
// import  { tgs }                   from './tgs.js';

(function(global) {
  'use strict';

  // try {
  //   tgs.setViewGlobals(global);
  // } catch (e) {
  //   setTimeout(() => window.location.reload(), 1000);
  //   return;
  // }

  gsUtils.documentReadyAndLocalisedAsPromised(document).then(function() {
    // var notice = tgs.requestNotice();
    // if (
    //   notice &&
    //   notice.hasOwnProperty('text') &&
    //   notice.hasOwnProperty('version')
    // ) {
    //   var noticeContentEl = document.getElementById('gsNotice');
    //   noticeContentEl.innerHTML = notice.text;
    //   //update local notice version
    //   gsStorage.setNoticeVersion(notice.version);
    // }

    // //clear notice (to prevent it showing again)
    // tgs.clearNotice();
  });
})(this);
