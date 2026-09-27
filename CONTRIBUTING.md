# Contributing to The Marvellous Suspender

Thanks for helping. This page is the practical side; the rules every change must
meet are in [`AGENTS.md`](AGENTS.md), which applies to people and coding agents
alike. Read both before your first PR.

## Before you start

- **Bug:** open an issue with the bug template, or comment on the existing one.
  A reproduction beats a description.
- **Feature or behaviour change:** open an issue first and wait for a maintainer
  to agree on the approach. A PR that lands unannounced may be closed even if the
  code is fine.
- **Translation:** not through this repo. Use
  [Crowdin](https://crowdin.com/project/tms). In the repo, contributors edit
  `src/_locales/en/messages.json` only.
- **Security issue:** do not open an issue. See [`SECURITY.md`](SECURITY.md).

## Setting up

```sh
git clone https://github.com/<you>/MarvellousSuspender.git
cd MarvellousSuspender
npm ci
npm test            # Vitest, must be green
npm run lint        # ESLint, must exit 0
npm run check-locales   # informational: exits 1 on master today, see below
npx grunt zip       # build/zip/tms-<version>.zip, no signing key needed
```

To try the extension, use a separate Chrome profile. `src/manifest.json` carries
the store key, so an unpacked build has the same extension id as the store
version and would work on the same settings, saved sessions and suspended tabs.
In that profile: `chrome://extensions`, enable Developer mode, "Load unpacked",
pick the `src/` folder.

## Branches, commits, pull requests

- Work on a branch in your fork, named `type/short-description-<issue>` when there
  is an issue, e.g. `fix/discard-tooltip-wording-521`.
- One PR, one logical change. Keep refactors separate from fixes and features.
- Commit messages follow `type(scope): imperative subject` (the scope is optional,
  the subject at most 72 characters), with a body that says why. Types: `feat`,
  `fix`, `perf`, `refactor`, `test`, `docs`, `ci`, `chore`. Run
  `git config commit.template .gitmessage` once to get the template in your editor.
- Every fix and feature comes with a test under `tests/`. For a bug, write the
  failing test first; the PR is easier to review when the first commit shows the
  bug and the second shows the fix.
- Add a line under `## [Unreleased]` in `CHANGELOG.md` for anything a user would
  notice. Leave `src/CHANGELOG_USER.md` alone; it is rewritten at release.
- Fill in the PR template. "How to test" is not optional: say what you ran, what
  you clicked, on which browser.
- CI must be green. `check-locales` is informational until the flagged locales
  catch up on Crowdin; everything else blocks. If you changed `en` strings, run it
  and list the keys it newly flags in the PR so the translators know.

## Review

A maintainer reviews every PR. Expect questions about the why, requests for a
test you did not think of, and the occasional "please split this". Review rounds
are cheap; regressions in 100,000 browsers are not. Reply to every comment, even
with "done".

## Using AI tools

You may use AI tools to write code, tests or docs. What does not change: you are
the author. Read what they produced, run it, load the extension and try it, and
be ready to explain any line. Say in the PR which parts were AI-assisted. If a
review comment gets an answer that reads like it was pasted from a chat window
without being checked, the PR will be closed.

Coding agents pointed at this repository read `AGENTS.md`; if you use one, make
sure it does.

## Releases

Maintainers cut releases: version bump in `src/manifest.json`, `CHANGELOG.md`
section dated, `src/CHANGELOG_USER.md` rewritten, tag `vX.Y.Z`, store upload.
Contributors do not need to touch any of that.

## Code of conduct

Be decent. Assume good faith, disagree about code and not about people, and take
"no" as an answer when a maintainer gives one.
