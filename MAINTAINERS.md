# Maintainers

Who maintains The Marvellous Suspender, and who decides what. What a change has
to meet is in [`AGENTS.md`](AGENTS.md); how to send one is in
[`CONTRIBUTING.md`](CONTRIBUTING.md). This file only says who acts on it.

| Role | Who |
|---|---|
| Lead maintainer | Giovanni F. Solone ([@gioxx](https://github.com/gioxx)) |
| Maintainer | Rob Kodey ([@rkodey](https://github.com/rkodey)) |
| Maintainer | Andrea Margiovanni ([@amargiovanni](https://github.com/amargiovanni)) |

## Who decides what

**A maintainer acts alone:**

- Triage of issues and discussions: templates, requests for a reproduction,
  duplicates, labels, closing stale threads and threads outside the rules.
- Replies to users on GitHub, on behalf of the project.
- Review and merge of other people's pull requests that are a fix with a test,
  tests, docs, CI or chore.
- Closing pull requests that break `AGENTS.md`.
- Dev dependency updates, replacement of vendored files, CI and end-to-end
  maintenance, Crowdin sync and the locale check.

**A maintainer acts, and reports it to the lead maintainer in the weekly
summary:**

- Merging their own pull requests in the categories above, once CI is green and
  the lead maintainer has not objected within 72 hours of the pull request
  being opened.
- Preparing a release up to the upload: version bump in `src/manifest.json`,
  dated `CHANGELOG.md` section, draft of `src/CHANGELOG_USER.md`, tag `vX.Y.Z`
  and a draft release on GitHub.

**The lead maintainer decides**, on a proposal a maintainer brings with a
recommendation (accept, reject or defer, and why):

- Features and changes of behaviour.
- `permissions`, the manifest and the content security policy.
- New dependencies, runtime or dev.
- Security reports. Maintainers prepare the fix; it is merged and disclosed when
  the lead maintainer says so, whatever its category above.
- Changes to `AGENTS.md`, `SECURITY.md` and this file.
- Anything that goes out in the lead maintainer's name: money, sponsors.

**Held by the lead maintainer only:** the signing key, the Chrome Web Store
account, upload, approval and listing text, the publication of the GitHub
release, the `marvellouscode.works` domain and the knowledge base.

## Changing this file

The lead maintainer can take back any item above at any time, without giving a
reason, by editing this file. A new maintainer, or a new item delegated, is
added through a pull request the lead maintainer approves.

The delegation to @amargiovanni starts as a 30-day trial from the merge of the
pull request that added this file. It continues after the trial unless the lead
maintainer takes it back.
