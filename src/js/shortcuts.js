import  { gsUtils }               from './gsUtils.js';

(() => {

  function render() {
    const shortcutsEl   = document.getElementById('keyboardShortcuts');

    const notSetMessage = chrome.i18n.getMessage('js_shortcuts_not_set');
    const groupingKeys  = [
      '_execute_action',
      '2-toggle-temp-whitelist-tab',
      '2b-unsuspend-selected-tabs',
      '4-unsuspend-active-window',
      '6-unsuspend-all-windows'
    ];

    //populate keyboard shortcuts
    shortcutsEl.innerHTML = '';
    chrome.commands.getAll((commands) => {
      commands.forEach((command) => {
        const shortcut =
          command.shortcut !== ''
            ? gsUtils.formatHotkeyString(command.shortcut)
            : `(${notSetMessage})`;
        const addMarginBottom = groupingKeys.includes(command.name);
        const description     = command.description || chrome.i18n.getMessage('js_shortcuts_default_command'); // eslint-disable-line @typescript-eslint/prefer-nullish-coalescing
        shortcutsEl.innerHTML += `
          <div ${ addMarginBottom ? ' class="bottomMargin"' : '' }>${description}</div>
          <div class="${ command.shortcut ? 'hotkeyCommand' : 'lesserText' }">${shortcut}</div>
          `;
      });
    });
  }

  gsUtils.documentReadyAndLocalisedAsPromised(window).then(() => {

    document.getElementById('configureShortcuts').onclick = function(e) {
      chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    };

    window.onfocus = () => {
      render();
    };
    render();

  });

})();
