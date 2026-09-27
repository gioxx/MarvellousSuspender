# Contributing to The Marvellous Suspender

Thanks for helping. This page is the practical side: how to set up, how to send a
change, what happens next. What the change itself has to meet is in
[`AGENTS.md`](AGENTS.md). Read both before your first PR.

## Before you start

- **Bug:** open an issue with the bug template, or comment on the existing one.
  A reproduction beats a description.
- **Feature or behaviour change:** open an issue first and wait for a maintainer
  to agree on the approach. A PR that lands unannounced may be closed even if the
  code is fine.
- **Translation:** through [Crowdin](https://crowdin.com/project/tms), not
  through this repo. The English source strings are the exception: see
  [`AGENTS.md`](AGENTS.md).
- **Security issue:** do not open an issue. See [`SECURITY.md`](SECURITY.md).

## Setting up

```sh
git clone https://github.com/<you>/MarvellousSuspender.git
cd MarvellousSuspender
npm ci
npm test            # Vitest
npm run lint        # ESLint
npm run check-locales   # informational: exits 1 on master today
npx grunt zip       # build/zip/tms-<version>.zip, no signing key needed
```

To try the extension, use a separate Chrome profile. `src/manifest.json` carries
the store key, so an unpacked build has the same extension id as the store
version and would work on the same settings, saved sessions and suspended tabs.
In that profile: `chrome://extensions`, enable Developer mode, "Load unpacked",
pick the `src/` folder.

## End-to-end tests

`npm test` runs the unit tests under Node and needs no browser. `npm run test:e2e`
loads the packaged zip in a real browser and drives it: install, suspend and
unsuspend, forged suspended-page urls, framing, the context menu.

```sh
npm run test:e2e                          # builds the zip, then tests it
TMS_E2E_ZIP=build/zip/tms-9.0.3.zip npm run test:e2e   # tests a zip you already have
```

It needs [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/),
because branded Chrome ignores `--load-extension`. The run uses the one `CHROME_BIN`
points at, otherwise the newest version it finds in the Puppeteer or Playwright
cache. It starts headless, with a profile of its own in the system temp directory,
and serves its pages from `tests/e2e/fixtures/` on `127.0.0.1`. The browser is
started so that no other host resolves, which keeps the run off the network: the
extension's own news feed request fails, as it would offline. Your browser and
your profile are not touched. The temp directories are deleted at the end of a
run; one that is killed halfway leaves them behind (`tms-e2e-*`).

CI runs it on every pull request against the zip it built, on the Chrome for
Testing version pinned in `.github/workflows/ci.yml`. For now it reports and does
not block. If your change is about behaviour in the browser, add a case to
`tests/e2e/`; wait for a condition with `waitFor()`, never for a fixed time.

## Branches, commits, pull requests

- Work on a branch in your fork, named `type/short-description-<issue>` when there
  is an issue, e.g. `fix/discard-tooltip-wording-521`.
- Run `git config commit.template .gitmessage` once: your editor then opens every
  commit on the format `AGENTS.md` asks for.
- For a bug, a PR is easier to review when one commit shows the bug with a
  failing test and the next one fixes it. A suggestion, not a requirement.
- Fill in the PR template. Under "How it was tested", say what you ran, what you
  clicked and on which browser.
- CI runs lint, the locale check, the unit tests and the build on every pull
  request.

## Review

A maintainer reviews every PR. Expect questions about the why, requests for a
test you did not think of, and the occasional "please split this". Review rounds
are cheap; regressions in 100,000 browsers are not. Reply to every comment, even
with "done".

## Using AI tools

You may. What is expected of you when you do is in [`AGENTS.md`](AGENTS.md), under
"Working with AI tools". If you use a coding agent, point it at that file before it
writes anything.

## Releases

Maintainers cut releases: version bump in `src/manifest.json`, `CHANGELOG.md`
section dated, `src/CHANGELOG_USER.md` rewritten, tag `vX.Y.Z`, store upload.
Contributors do not need to touch any of that.

## Code of conduct

Be decent. Assume good faith, disagree about code and not about people, and take
"no" as an answer when a maintainer gives one.
