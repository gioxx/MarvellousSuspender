import  { gsUtils }               from './gsUtils.js';

(() => {
  'use strict';

  gsUtils.documentReadyAndLocalisedAsPromised(document).then(function() {
    //do nothing
  });
})();
