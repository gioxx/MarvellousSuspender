# What's new

This file only ever holds the current release's changes, written for people using the extension — not for developers. It gets wiped and rewritten from scratch at every release.

For the full technical changelog (every fix, every review round, every detail), see [CHANGELOG.md on GitHub](https://github.com/gioxx/MarvellousSuspender/blob/master/CHANGELOG.md).

## [9.0.3]

### New

- **Separate auto-suspend timeout for battery power**: set tabs to suspend more aggressively when unplugged, without changing your normal (plugged-in) timeout.
- **"Always reopen suspended tabs scrolled to the top"**: a new option if you'd rather suspended tabs always reopen at the top of the page instead of wherever you left them.
- **Reload also unsuspends background tabs**: reloading a suspended tab you're not currently looking at (e.g. via a multi-tab selection) can now unsuspend it too, if you turn this on.
- **Suspend/unsuspend all tabs in a tab group**: new right-click and keyboard-shortcut options.
- **"What's new" screen**: this very screen! Shown once after an update, so you don't have to go digging for what changed.

### Fixed

- **A rare but real out-of-memory crash**, reproduced live and traced all the way down to its actual cause: a lot of hardening work in how the extension manages memory across many open tabs, especially for people who use the debug page's `captureLogs` option to help us diagnose issues. If you don't use that option, this mostly won't have been visible to you — but the underlying fixes make the extension more resilient regardless.
- **Google Drive backup disconnecting on Brave and Vivaldi** after just one or two automatic backups. If you use Drive backup on one of those browsers, you'll need to reconnect once (Options → Backup → Connect) after updating — after that, it stays connected reliably.
- **The battery-specific timeout not reacting** when you unplugged your computer, requiring a manual trigger to take effect.
- **A bright white flash switching between suspended tabs**, especially noticeable in dark mode/low light — reported as far back as v7.1.6.2, finally tracked down and fixed.
- **The reload link on suspended tabs was too bright/conspicuous in dark mode** — toned down to match the rest of that page's quiet look.
- Various smaller fixes to tab reload/unsuspend behaviour, the debug page's tab list, and the auto-backup flow.

### Curious for more detail?

- Full technical breakdown of the memory/stability work: [blog post](https://kb.marvellouscode.works/blog/tms903-stability-debug-page)
- Full technical breakdown of the Drive fix: [blog post](https://kb.marvellouscode.works/blog/tms903-drive-pkce-refresh-token)
- Every single change, fix-by-fix: [CHANGELOG.md on GitHub](https://github.com/gioxx/MarvellousSuspender/blob/master/CHANGELOG.md)
