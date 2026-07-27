import  { gsUtils }               from './gsUtils.js';

(() => {

  function render() {
    const shortcutsEl   = document.getElementById('keyboardShortcuts');

    const notSetMessage = gsUtils.getMessage('js_shortcuts_not_set');
    const groupingKeys  = [
      '_execute_action',
      '2-toggle-temp-whitelist-tab',
      '2b-unsuspend-selected-tabs',
      '4-unsuspend-active-window',
      '6-unsuspend-all-windows'
    ];
    // chrome.commands.getAll() (and chrome.runtime.getManifest(), which also
    // substitutes __MSG_x__ placeholders) resolve command descriptions using the
    // browser's UI language, ignoring the extension's own language setting. Map
    // each command name to its manifest.json message key so we can re-resolve it
    // ourselves via gsUtils.getMessage() and respect the selected language.
    const commandMessageKeys = {
      '1-suspend-tab'                  : 'ext_cmd_toggle_tab_suspension_description',
      '2-toggle-temp-whitelist-tab'    : 'ext_cmd_toggle_tab_pause_description',
      '2a-suspend-selected-tabs'       : 'ext_cmd_suspend_selected_tabs_description',
      '2b-unsuspend-selected-tabs'     : 'ext_cmd_unsuspend_selected_tabs_description',
      '3-suspend-active-window'        : 'ext_cmd_soft_suspend_active_window_description',
      '3b-force-suspend-active-window' : 'ext_cmd_force_suspend_active_window_description',
      '4-unsuspend-active-window'      : 'ext_cmd_unsuspend_active_window_description',
      '4b-soft-suspend-all-windows'    : 'ext_cmd_soft_suspend_all_windows_description',
      '5-suspend-all-windows'          : 'ext_cmd_force_suspend_all_windows_description',
      '6-unsuspend-all-windows'        : 'ext_cmd_unsuspend_all_windows_description',
      '7-open_session_history'         : 'html_recovery_go_to_session_manager',
    };

    //populate keyboard shortcuts
    shortcutsEl.innerHTML = '';
    chrome.commands.getAll((commands) => {
      commands.forEach((command) => {
        const shortcut =
          command.shortcut !== ''
            ? gsUtils.formatHotkeyString(command.shortcut)
            : `(${notSetMessage})`;
        const addMarginBottom = groupingKeys.includes(command.name);
        const descriptionKey  = commandMessageKeys[command.name];
        const description     = (descriptionKey && gsUtils.getMessage(descriptionKey)) || command.description || gsUtils.getMessage('js_shortcuts_default_command'); // eslint-disable-line @typescript-eslint/prefer-nullish-coalescing
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

    const backToTopBtn = document.getElementById('backToTop');
    window.addEventListener('scroll', () => {
      backToTopBtn.classList.toggle('visible', window.scrollY > 200);
    }, { passive: true });
    backToTopBtn.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

  });

})();
