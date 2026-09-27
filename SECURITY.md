# Security policy

The Marvellous Suspender runs with broad permissions inside a lot of browsers.
If you find a way to abuse that, we want to hear from you first.

## Reporting a vulnerability

Use GitHub's private reporting:
**https://github.com/gioxx/MarvellousSuspender/security/advisories/new**

If you cannot use GitHub, email **gioxx@marvellouscode.works** with "TMS security" in the
subject.

Both channels are private: an advisory is visible to the repository maintainers,
the mailbox is read by the lead maintainer. Please do not open a public issue, a
discussion or a pull request for a security problem.

Include, as far as you can:

- The extension version (Options → About) and the browser.
- What an attacker gains, and what they need to start (a visited web page? another
  extension? local access?).
- Steps to reproduce or a proof of concept.
- Whether the issue is, to your knowledge, already public or being exploited.

## What we commit to

This is a volunteer-maintained project. These are targets, not a service-level
agreement, but we take them seriously.

| Stage | Target |
|---|---|
| Acknowledgement | 5 days |
| Initial assessment shared with you | 14 days |
| Fix or mitigation for a confirmed issue | 90 days, sooner if exploitation is observed |
| Public disclosure | Coordinated with you, after a fixed version is on the Chrome Web Store |

We will keep you informed while we work on it and credit you in the release
notes unless you prefer otherwise.

## Scope

**In scope:** the extension as published on the Chrome Web Store and the source in
this repository, including its build and release process.

**Out of scope:** findings from automated scanners with no demonstrated impact;
issues in Chrome itself, in Google Drive or in other services we do not operate;
denial of service by volume; anything that requires an already compromised
browser profile or operating system.

## Safe harbour

We will not pursue or support legal action against anyone who researches this
extension in good faith: who tests only on their own browser and accounts, who
does not access or destroy other people's data, and who gives us reasonable time
to respond before going public.

## Supported versions

Only the latest version on the Chrome Web Store receives fixes. Older versions
and local builds are not supported.

---

*Last reviewed: 2026-09-26 · Owner: the maintainers listed in `.github/CODEOWNERS`*
