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
    //do nothing
  });
})(this);
