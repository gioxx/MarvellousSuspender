import  { gsUtils }               from './gsUtils.js';
import  { gsStorage }             from './gsStorage.js';

(() => {
  'use strict';

  gsUtils.documentReadyAndLocalisedAsPromised(document).then(async () => {

    //Set theme
    document.body.classList.add(await gsStorage.getOption(gsStorage.THEME) === 'dark' ? 'dark' : null);

  });
})();
