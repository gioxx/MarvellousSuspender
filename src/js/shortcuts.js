import  { gsUtils }               from './gsUtils.js';

(() => {
  'use strict';

  gsUtils.documentReadyAndLocalisedAsPromised(window).then(function() {

    var shortcutsEl = document.getElementById('keyboardShortcuts');
    var configureShortcutsEl = document.getElementById('configureShortcuts');

    var notSetMessage = chrome.i18n.getMessage('js_shortcuts_not_set');
    var groupingKeys = [
      '_execute_action',
      '2-toggle-temp-whitelist-tab',
      '2b-unsuspend-selected-tabs',
      '4-unsuspend-active-window',
      '6-unsuspend-all-windows'
    ];

    //populate keyboard shortcuts
    chrome.commands.getAll(commands => {
      commands.forEach(command => {
        const shortcut =
          command.shortcut !== ''
            ? gsUtils.formatHotkeyString(command.shortcut)
            : '(' + notSetMessage + ')';
        var addMarginBottom = groupingKeys.includes(command.name);
        shortcutsEl.innerHTML += `
          <div ${ addMarginBottom ? ' class="bottomMargin"' : '' }>${ command.description || chrome.i18n.getMessage('js_shortcuts_default_command') }</div>
          <div class="${ command.shortcut ? 'hotkeyCommand' : 'lesserText' }">${shortcut}</div>
          `;
      });
    });

    //listener for configureShortcuts
    configureShortcutsEl.onclick = function(e) {
      chrome.tabs.update({ url: 'chrome://extensions/shortcuts' });
    };
  });

})();
