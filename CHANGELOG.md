# Changelog

All notable changes to The Marvellous Suspender are tracked in this file.

Format inspired by [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The project adheres (pragmatically) to [Semantic Versioning](https://semver.org/).

Entries under "Unreleased" live on a feature branch until merged into `master`.

## [Unreleased] — feature/visual-redesign

### Fixed
- **CSP violation on suspended tab page**: `suspended.html` uses `style-src 'self'` (no `unsafe-inline`), which caused Chrome to block all `element.style.*` property assignments. Replaced every inline-style mutation in `suspended.js` with CSS-class toggles: `img-preview-mode` / `preview-scrollable` control preview visibility and body overflow; `toast-active` triggers the connectivity-toast animation; `update-available` shows the update banner. Corresponding CSS rules added to `suspended.css`.

### Added
- `CHANGELOG.md` to track the visual redesign initiative.
- `src/css/tokens.css`: design system tokens aligned with marvellouscode.works ("Technical Blueprint" palette). Includes:
  - OKLCH color tokens for light and dark modes.
  - Dark mode applied via OS preference (`@media (prefers-color-scheme: dark)`) and via JS-controlled `body.dark` / `body.light` classes.
  - Self-hosted variable fonts: Inter (sans-serif) and JetBrains Mono (monospace), loaded via `@font-face` with `font-display: swap`. Fallback stacks preserved.
  - Spacing (4px grid), border-radius, type scale, shadows, motion, and layout tokens.
  - `@media (prefers-reduced-motion: reduce)` sets all duration tokens to `0ms`.
- `src/font/inter-variable.woff2` + `src/font/OFL-Inter.txt`: Inter variable font (SIL OFL).
- `src/font/jetbrains-mono-variable.woff2` + `src/font/OFL-JetBrainsMono.txt`: JetBrains Mono variable font (SIL OFL).
- `src/css/history.css`: page-scoped stylesheet for `history.html`. Defines `.migrate-input-row` flex layout for the tab-migration input row.
- `src/css/options.css`: page-scoped stylesheet for `options.html`. Overrides `.welcome-message` to stretch full-width (`max-width: none`).
- `src/_locales/en/messages.json` and `src/_locales/it/messages.json`: added 4 new i18n keys — `html_history_migrate_section_title`, `html_history_migrate_section_desc`, `html_notice_title`, `html_notice_important_notice` — used by the redesigned history page.

### Added
- **Language override**: new dropdown in the General section of Settings lets the user force a specific UI language regardless of the browser's system locale. Implemented via `gsStorage.LANGUAGE` preference (default `'auto'`), `gsUtils.loadLocaleMessages()` (fetches the chosen `_locales/{locale}/messages.json` at page load), and a modified `localiseHtml()` that prefers the cached map over `chrome.i18n.getMessage()`. Changing the language triggers a page reload. Note: the override applies to all extension UI pages (options, popup, suspended tab); manifest-level strings and background-generated tab titles remain under Chrome's locale.
- `en` and `it` locale files: added `html_options_language` and `html_options_language_auto` i18n keys. Other locales will be updated via Crowdin.

### Changed
- All HTML pages: brand subtitle updated from "a project by Marvellous Codeworks" to "a Marvellous Codeworks project".
- `en` and `it` locale files: theme option `html_options_suspend_theme_system` renamed from "Automatic" to "System" / "Sistema". Other locales will be updated via Crowdin.
- `src/options.html`: further reorganised settings sections. "Other" section renamed to "General" (all locales updated) and moved to first position — it now contains the language selector, theme, context menu, and sync settings. "Suspend on low memory" (`suspendInPlaceOfDiscard`) moved from "Other" to "Suspend" (with other suspension triggers). Theme selector moved from "Suspended tabs" to "General" (extension-wide preference).
- `src/css/style.css`: full rewrite consuming `tokens.css` variables. Primary accent color changed from `#3477db` (blue) to `oklch(0.45 0.18 158)` (teal-green, matching marvellouscode.works). Settings layout widened to `--content-max` (1120px). Buttons redesigned: monospace font, uppercase tracking, near-zero radius. Dark mode now uses proper token cascade instead of hardcoded hex overrides. Tab group colors preserved unchanged; dark-mode variants migrated from nested `body.dark { … }` (Chrome-only syntax) to flat `body.dark span.group.…` selectors for broader compatibility. Added `.brandMark` / `.brandLogo` for settings page header, `.pageTitle` eyebrow, and redesigned `.splash` / `.splash-wrap` as proper card with grid background.
- `src/css/popup.css`: rewritten to consume `tokens.css` variables. Hardcoded hex colors (`#3477db`, `#777`, `#fff`, `#222`, `#ccc`) replaced with token references. Dark/light mode handled by token cascade — the previous `@media (prefers-color-scheme: dark)` overrides and explicit `.dark` / `.light` blocks are removed.
- `src/css/suspended.css`: now imports `tokens.css`. Hardcoded values replaced with token references (`--muted-foreground`, `--primary`, `--shadow-md`, `--duration-base`, `--card`, `--border`). `rgba()` shadows replaced with `oklch()` equivalents.
- All 5 settings pages (`options.html`, `about.html`, `health.html`, `shortcuts.html`, `history.html`): unified `pageHeader` with `marvellous.png` brand logo + extension name (monospace h1). Sidebar `<div class="contentNav">` changed to `<nav>`. Each content area gets a `.pageTitle` eyebrow. All JS-hooked IDs and class names preserved.
- All 5 settings pages: `pageHeader` brand mark redesigned — extension icon (`ic_suspendy_128x128.png`, 40 px) leads the left side next to the extension name (`--text-2xl`, bold); official Marvellous Codeworks logo (`marvellous-codeworks-logo.png`, sourced from the marvellouscode.works repo) with "a project by Marvellous Codeworks" label is pinned to the right via `justify-content: space-between`. New CSS classes: `.brandTitle`, `.brandCodeworks`, `.brandSubtitle`; `.brandLogo` at 20 px. `marvellous.png` placeholder no longer used in the header.
- `src/about.html`: revised page content — added extension tagline (from marvellouscode.works), version label with context, compact credits section with `pageTitle` heading, inline links to GitHub repo / official site / KB (with GitHub SVG icon and MC logo), contributor acknowledgment including link to the contributors graph. Removed BrowserStack credit (no longer a dependency). Added new i18n keys: `html_about_version_label`, `html_about_tagline`, `html_about_section_credits`, `html_about_contributors_and`, `html_about_community_thanks_link`. Also removed the three stale `html_about_browserstack_*` keys from `en/messages.json`.
- All 6 standalone/splash pages (`recovery.html`, `broken.html`, `update.html`, `updated.html`, `permissions.html`, `restoring-window.html`): markup cleaned up, `alt=""` added to decorative images. `recovery.html`: secondary button class changed from `secondary` to `btnNeg` (matches button system). `permissions.html`: heading changed from `h2` to `h1` for correct heading hierarchy.

### Changed (continued)
- `src/_locales/it/messages.json`: complete Italian localisation overhaul — translated all ~45 strings that were still in English (entire `html_health_*` section, tooltip blocks for sync/discard/screen-capture/low-memory, update/broken page strings, sidebar labels, migrate success message, shortcut command label); standardised terminology (`tab` → `scheda`, `whitelist` → `lista bianca`, `form` → `campi modulo`); fixed grammatical issues (`po 'di` → `po' di`, `altro.` → `altre.`, `html_broken_title` gender agreement); `html_welcome_title` changed from "Ciao" to "Benvenuto".

### Fixed
- All HTML pages: added `<meta charset="UTF-8">` to `<head>`. The missing declaration caused multi-byte characters (Arabic, Czech, French, Japanese, Portuguese, Russian, Sinhala, Slovak, Turkish, Chinese) in the language selector dropdown to render as mojibake.
- `src/css/popup.css`: aligned popup typography with the rest of the extension. `.menuOption` font explicitly set to `--font-sans` (Inter, same as option labels in `options.html`) and size corrected from `--text-md` (16px) to `--text-base` (14px). `line-height: 2em` replaced with explicit `padding: --space-2 --space-4` + `line-height: 1.5`. Hover state changed from `text-decoration: underline` to `background-color: --accent` (same as sidebar nav). `#header` gains `--font-mono` and a `border-bottom` separator. Padding tightened from `--space-4` to `--space-3 --space-4`.
- All 6 splash pages: added `.splash-header` brand mark (extension icon + name + Codeworks logo/label) as a full-width row spanning the two-column splash grid, bringing visual identity in line with the settings pages.
- `src/debug.html`: restructured with `.debugWrap` container, `.debugHeader` brand mark, `.pageTitle` eyebrow, and semantic wrappers for the controls, instructions, and profiler table — replacing the old bare `<body>` layout.
- `src/css/debug.css`: rewritten to consume `tokens.css` variables (`--content-max`, `--space-*`, `--font-mono`, `--text-*`, `--border`, `--muted-foreground`). Removed hardcoded `font-size: 1.3rem` and `padding: 20px`.
- `src/css/style.css`: added `.splash-header { grid-column: 1 / -1; … }` utility class for the splash brand row.
- `src/js/debug.js`: removed `setAttribute('href', 'chrome://extensions/…')` that caused a "Not allowed to load local resource" console error. Navigation now handled exclusively by the `onclick` handler via `chrome.tabs.create`.
- `src/css/style.css`: added `min-width: 0` to `.splash > div:not(.splash-header)` so the `1fr` content column can actually shrink and constrains its children correctly. Added `overflow: hidden` to `.tabContainer` to create the clipping context required for `a.historyLink`'s `text-overflow: ellipsis` to work; without this, long tab titles/URLs in `recovery.html` (and `history.html`) would overflow the splash card.
- `src/health.html`: removed `sub-section` class from `#scanProgress` (progress bar was picking up `border-bottom + padding + margin` meant for layout sections, creating empty separator rows below the scan bar). Removed `sub-section` class from `#actionIntro` (same reason, caused a dangling border inside `#actionSection`). Removed redundant `<hr />` from `#copySection` (the element already has `.sub-section` border-bottom).
- `src/js/gsTabCheckManager.js`: wrapped `chrome.tabs.sendMessage` call in `try/catch` when fetching `suspendInfo` from a suspended tab. Previously an unhandled messaging error (e.g. tab not ready) would propagate and break the check loop; now the error is logged and the tab is requeued with `refetchTab: true`.

### Changed (continued)
- `src/css/tokens.css`: primary color shifted from green-teal (hue 158°) to cyan-blue (hue 210°) to match the mascot's eye-glow signature color. Affects `--primary`, `--primary-hover`, and `--ring` in all three theme blocks (`:root`, `@media (prefers-color-scheme: dark)`, `body.dark`, `body.light`). Dark-mode chroma reduced from 0.18 to 0.14 to avoid over-saturation on dark backgrounds.
- `src/css/popup.css`: `#header` default state changed from near-white `--muted` background to `--muted` background with `--primary` text, giving the status bar a branded cyan accent without competing with the `willSuspend` (full `--primary` bg) and `blockedFile` (full `--destructive` bg) states. `#statusDetail a` color updated to `--primary-hover` for legibility on the light background.
- All 11 HTML pages: `extensionIcon` image in `.brandTitle` changed from `ic_suspendy_128x128.png` to `suspendy-guy-main.png`.
- `src/css/popup.css`: `#statusDetail a` color changed from `--primary-hover` to `--foreground` with `text-decoration: underline` so links are clearly distinguishable from the surrounding `--primary` status text on the `--muted` background.
- `src/css/popup.css`, `src/popup.html`, `src/js/popup.js`: added `#brand` bar at the top of the popup — robot icon (`suspendy-guy-main.png`, 24 px), extension name (monospace bold), and version number (`vX.Y.Z` read from `chrome.runtime.getManifest().version`, populated in `showPopupContents`). Styled with `--background` fill and a `--border` bottom separator.
- `src/css/debug.css`: removed `max-width` / `margin: auto` centering from `.debugWrap`. Page now starts flush to the left edge with `--space-4` padding on each side and a reduced top margin, giving the profiler table the full horizontal space.

### Meta
- `.gitignore`: added `/.claude` and `/.tokensave` to exclude local AI-tooling directories from version control.
- `README.md`: visual overhaul — centered header with `suspendy-guy-main.png` mascot, tagline, and four shields.io badges (license, Manifest v3, Chrome ≥ 110, Crowdin l10n); Marvellous Codeworks logo (`marvellous-codeworks-logo.png`) with brand attribution below the badges; `suspendy-guy-lotus.png` accent in the Shoutouts section; fixed broken markdown links (permissions bare URL, tab-recovery line break); removed BrowserStack shoutout (no longer a dependency); added Manifest V3 / Chrome 110 requirement callout to install-from-source; minor prose cleanup throughout.

### Removed
- `en/messages.json` and `it/messages.json`: deleted 25 orphaned i18n keys no longer referenced by any HTML or JS file — `html_about_github_title`, `html_about_blog_title`, `html_about_twitter_title`, `html_about_html2canvas{,_prefix,_suffix}`, `html_about_indexedDb{,_prefix,_suffix}`, `html_about_tgs_{prefix,suffix}`, `html_notice_{title,important_notice}`, `html_popup_dont_suspend_now`, `html_suspended_tab_{suspended,reload,whitelist_prefix,whitelist_suffix}`, `html_updated_{detail_header_prefix,detail_header_suffix,new_features_header,bug_fixes_header,release_notes}`, `html_welcome_title`, `js_suspended_remove_from_whitelist`.
