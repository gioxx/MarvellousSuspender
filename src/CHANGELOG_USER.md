# What's new

This file only ever holds the current release's changes, written for people using the extension — not for developers. It gets wiped and rewritten from scratch at every release.

For the full technical changelog (every fix, every review round, every detail), see [CHANGELOG.md on GitHub](https://github.com/gioxx/MarvellousSuspender/blob/master/CHANGELOG.md).

## [9.1.0]

### New

- **Sharper previews of suspended tabs**: when you suspend the tab you're looking at, the extension now takes a real browser screenshot of it, in a few milliseconds. Pages that used to come out blank or broken, YouTube and GitHub among them, now get a proper preview. Choose how previews are made under Options → Screen capturing → "Capture method"; Automatic is the default and the right choice for most people.
- **Better previews for background tabs, if you want them**: the new option "Keep a recent screenshot of tabs as I use them" (off by default) saves a picture of each tab while you're looking at it, so when it's suspended later in the background it still gets a real preview. It asks for access to all sites when you turn it on, never captures incognito or allowlisted tabs, keeps one image per open tab and deletes it when the tab closes.
- **Never suspend a tab group**: right-click a named group and pick "Never suspend this group" to keep its tabs awake however long you leave them, handy for dashboards; "Allow suspending this group" undoes it, and Options lists them. Groups are matched by name and colour, so name the group first. A separate option, "Never suspend tabs in a tab group" (off by default), does the same for every group.
- **Suspend or unsuspend all tabs that aren't in a group**: new right-click items and two keyboard shortcuts you can assign, for the loose tabs outside your groups.
- **Ukrainian** is now available, and Ukrainian and Sinhala no longer show in English when the language follows the browser.
- **Choose how many suspended tabs are checked at once after a restart**: Options → Suspended tabs, from 1 to 8 (default 3). A higher number fills in titles and icons sooner, but can bring back the startup freezes fixed in this release, so raise it only if your computer can take it.

### Fixed

- **Browser freezing or the extension crashing after a restart with lots of suspended tabs**, reported on Brave and Chrome on Linux. Startup now checks a few tabs at a time, the one you're looking at first, and leaves sleeping tabs asleep. Favicons and titles may take a moment longer to fill in after a restart: that's intended, and you can tune it with the new setting above.
- **Paused tabs are easy to spot again in the toolbar**: the icon shows a small orange pause badge when a tab won't be suspended (paused, allowed, pinned and so on), and on pages that can't be suspended at all, such as Chrome's own pages. The classic artwork keeps its grey icon.
- **Slow suspension with screen capturing on**: a tab Chrome had already put to sleep was reloaded in full just to take its preview. It isn't any more.
- **Local files (file:// pages) could not be suspended from the popup** even with "Allow access to file URLs" turned on. The Permissions page now asks for the access the extension actually needs.
- **The right-click menu could disappear** on some browsers (Opera GX among them) until the next update. It now comes back on its own.
- **Tab Health flagged healthy suspended tabs in groups as broken** on recent Chrome versions.
- **Google Drive automatic backups** now retry a few minutes later after a temporary network or server error, instead of waiting for the next scheduled backup.
- **Translations**: every language has been reviewed for consistent wording, and a few outright mistranslations are gone.
- Various smaller fixes to how previews, favicons and tab information are stored, to never-suspended tab groups renamed right after a restart, to the suspension queue and to the Settings page.

### Curious for more detail?

- Every single change, fix-by-fix: [CHANGELOG.md on GitHub](https://github.com/gioxx/MarvellousSuspender/blob/master/CHANGELOG.md)
