// import  { gsStorage }             from './gsStorage.js';
import  { gsUtils }               from './gsUtils.js';
// import  { tgs }                   from './tgs.js';

(function(global) {
  'use strict';

  gsUtils.documentReadyAndLocalisedAsPromised(document).then(function() {
    // var notice = await tgs.requestNotice();
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
    // await tgs.clearNotice();
  });
})(this);
