# AGENTS.md

Policy for anyone, human or coding agent, changing this repository. It says what
is mandatory, what is out of bounds, and what "done" means. What a change has to
meet is stated here, once. `CONTRIBUTING.md` covers the process around it (issues,
branches, review) and how to set up; the pull request template turns part of this
file into a checklist.

The Marvellous Suspender is a Chrome extension (Manifest V3, plain JavaScript ES
modules under `src/js`, no bundler, no framework). It runs inside 100,000+ people's
browsers with the `tabs`, `history`, `scripting` and broad host permissions, and an
update reaches all of them at once.

## Definition of done

A change is done only when all of these are true and the PR says so:

- [ ] `npm test` passes (Vitest, `tests/`).
- [ ] `npm run lint` exits 0 (warnings are tolerated, errors are not).
- [ ] If `src/_locales/en/messages.json` changed, `npm run check-locales` was run and
      the PR lists the keys it newly flags. The script is informational: it fails on
      `master` today until the flagged locales catch up on Crowdin.
- [ ] `npx grunt zip` builds.
- [ ] A change to anything a user sees or clicks was loaded unpacked in Chrome and
      exercised by hand, in a profile kept for that (`CONTRIBUTING.md` says why);
      the PR says what was tried.
- [ ] The PR body states what changed, why, and how it was tested.

## Mandatory

- **Every bug fix and every feature ships with at least one test** under `tests/`.
  For a bug, the test is written first and fails before the fix.
- **No new dependency, runtime or dev, without a maintainer saying yes in the PR
  or issue** before it is added. The extension ships no npm runtime dependency:
  `src/js/idb.js` and `src/js/snapdom.js` are vendored copies. The `idb` entry in
  `package.json` exists only so audit tooling sees its version; keep it equal to
  the version named in the header of `src/js/idb.js`.
- **Never write page-, tab-, backup- or locale-derived data into HTML.** No
  `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write` with such
  data; use `textContent`, `createElement` and `setAttribute`. Locale strings
  count as data: they arrive from Crowdin.
- **Never widen `permissions`, `optional_permissions`, `host_permissions`,
  `web_accessible_resources` or the `content_security_policy` in
  `src/manifest.json` without an issue that states why.** Narrowing is welcome.
- **Contributors edit `src/_locales/en/messages.json` only.** Every other locale
  comes from Crowdin through the `l10n_master` branch; a PR that edits them
  directly will be asked to move the change to Crowdin.
- **Vendored files are replaced, never patched:** `src/js/idb.js`, `src/js/snapdom.js`.
  An upgrade replaces the whole file and names the upstream version in the commit.
- **A change to what is stored in `chrome.storage` or IndexedDB carries a migration
  for existing installs** and an entry in `CHANGELOG.md`.
- **Nothing secret enters git or the zip.** Signing keys (`*.pem`), any
  `*.local.js` and OAuth client secrets stay out; `.gitignore` and the Gruntfile
  copy task exclude both patterns, and `tests/build.test.js` holds the copy task
  to it. A new kind of local override goes into those three places first.
- **A vulnerability is reported in private**, the way `SECURITY.md` describes, never
  in a public issue, discussion or pull request.
- **One pull request, one logical change.** Refactors and drive-by cleanups go in
  their own PR.
- **Commits:** `type(scope): imperative subject` or `type: imperative subject`,
  subject at most 72 characters, English, and a body that says why. Types in use:
  `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `ci`, `chore`.
- **Every user-visible change gets a line under `## [Unreleased]` in
  `CHANGELOG.md`.** `src/CHANGELOG_USER.md` is rewritten by the maintainer at
  release time; do not edit it in a feature PR.
- **Language:** everything that lands in the repo is English.

## Working with AI tools

Contributions produced with AI assistance are welcome under one condition: the
person opening the PR has read every line, has run the tests and the extension
themselves, and can answer review questions about it. The PR body says which
parts were AI-assisted. A PR whose author cannot explain it will be closed
without review. One already in review will be closed if its comments get answers
pasted from a chat window without being checked.

## Not yours to edit

The rules above still apply to these; what a contributor or an agent does not do
is change them by hand.

- `build/`, `node_modules/`: generated.
- `src/js/idb.js`, `src/js/snapdom.js`: third-party, replaced whole as said above.
- `src/_locales/*` except `en`: owned by Crowdin.
- Releases, tagging and the Chrome Web Store listing: maintainers only.

## Orientation

- `src/js/background.js` is the service worker entry; `src/js/tgs.js` holds the
  suspend and unsuspend logic; `src/js/gsUtils.js` the shared helpers, including
  the suspended-url encode/decode that every other module relies on.
- `src/suspended.html` is web-accessible. Anything reachable from its URL hash is
  attacker-controlled; treat it as such.
- `tests/setup/chrome-stub.js` is the only `chrome.*` stand-in. It implements what
  the modules touch at load time and nothing more; extend it explicitly rather
  than with a catch-all.
