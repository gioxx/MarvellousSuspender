# Changelog

All notable changes to The Marvellous Suspender are tracked in this file.

Format inspired by [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The project adheres (pragmatically) to [Semantic Versioning](https://semver.org/).

Entries under "Unreleased" live on a feature branch until merged into `master`.

## [Unreleased] — feature/visual-redesign

### Added
- `CHANGELOG.md` to track the visual redesign initiative.
- `src/css/tokens.css`: design system tokens aligned with marvellouscode.works ("Technical Blueprint" palette). Includes:
  - OKLCH color tokens for light and dark modes.
  - Dark mode applied via OS preference (`@media (prefers-color-scheme: dark)`) and via JS-controlled `body.dark` / `body.light` classes.
  - Font stacks: Inter-like sans-serif and JetBrains Mono-like monospace using system fonts.
  - Spacing (4px grid), border-radius, type scale, shadows, motion, and layout tokens.

### Changed
- `src/css/style.css`: full rewrite consuming `tokens.css` variables. Primary accent color changed from `#3477db` (blue) to `oklch(0.45 0.18 158)` (teal-green, matching marvellouscode.works). Settings layout widened to `--content-max` (1120px). Buttons redesigned: monospace font, uppercase tracking, near-zero radius. Dark mode now uses proper token cascade instead of hardcoded hex overrides. Tab group colors preserved unchanged. Added `.brandMark` / `.brandLogo` for settings page header, `.pageTitle` eyebrow, and redesigned `.splash` / `.splash-wrap` as proper card with grid background.
- All 5 settings pages (`options.html`, `about.html`, `health.html`, `shortcuts.html`, `history.html`): unified `pageHeader` with `marvellous.png` brand logo + extension name (monospace h1). Sidebar `<div class="contentNav">` changed to `<nav>`. Each content area gets a `.pageTitle` eyebrow. All JS-hooked IDs and class names preserved.
- All 6 standalone/splash pages (`recovery.html`, `broken.html`, `update.html`, `updated.html`, `permissions.html`, `restoring-window.html`): markup cleaned up, `alt=""` added to decorative images. `recovery.html`: secondary button class changed from `secondary` to `btnNeg` (matches button system). `permissions.html`: heading changed from `h2` to `h1` for correct heading hierarchy.
