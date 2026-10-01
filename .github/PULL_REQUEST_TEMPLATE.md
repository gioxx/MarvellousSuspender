<!-- One PR, one logical change. Rules: AGENTS.md. Practical guide: CONTRIBUTING.md. -->

## What changed

<!-- Two to five sentences. What a reviewer will see in the diff. -->

## Why

<!-- The problem or the request. Link the issue: Fixes #123 / Refs #123. -->

## How it was tested

<!-- What you ran and what you clicked. Be concrete: browser, version, steps, result. -->

- [ ] `npm test` green
- [ ] `npm run lint` exits 0
- [ ] If `en` strings changed: `npm run check-locales` run, newly flagged keys listed below
- [ ] `npx grunt zip` builds
- [ ] Loaded unpacked in Chrome and exercised by hand (say what)

## Checklist

- [ ] Test added or updated under `tests/` (bug fixes: the test failed before the fix)
- [ ] No new dependency, or a maintainer agreed to it in the linked issue
- [ ] No edits to `src/_locales/*` other than `en`
- [ ] `src/manifest.json` permissions, host permissions, CSP and web-accessible resources unchanged, or an issue explains why
- [ ] No change to what is stored in `chrome.storage` or IndexedDB, or it carries a migration for existing installs
- [ ] `CHANGELOG.md` has a line under `[Unreleased]` if a user would notice this change
- [ ] AI-assisted parts are named below, and I have read, run and can explain them

## Notes for the reviewer

<!-- Behaviour changes, trade-offs, follow-ups you deliberately left out, AI-assisted parts. -->
