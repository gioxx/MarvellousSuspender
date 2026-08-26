// @ts-check
import  { gsUtils } from './gsUtils.js';

const gsChangelog = (() => {
  'use strict';

  // CHANGELOG_USER.md is a real file inside src/ — deliberately separate from the
  // repo-root CHANGELOG.md, which has become a detailed technical log (crash dumps,
  // review rounds, internals) not meant for someone who just wants to know what's new.
  // Wiped and rewritten from scratch at every release with only the handful of changes
  // an actual user of the extension cares about.
  const CHANGELOG_URL = chrome.runtime.getURL('CHANGELOG_USER.md');

  // Extracts the body of a single "## [version] — date" section, up to the next "## [" heading.
  // Slices by heading index rather than a lookahead regex: with the 'm' flag, `$` matches at
  // every line end (not just end-of-string), so a `(?=\n## \[|$)` lookahead would stop the
  // lazy match at the very next line break instead of the next heading.
  function parseSection(markdown, version) {
    const headingRe = /^## \[([^\]]+)\][^\n]*$/gm;
    const positions = [];
    let match;
    while ((match = headingRe.exec(markdown))) {
      positions.push({ version: match[1], index: match.index, headingEnd: headingRe.lastIndex });
    }
    const i = positions.findIndex((p) => p.version === version);
    if (i === -1) return '';
    const start = positions[i].headingEnd;
    const end = i + 1 < positions.length ? positions[i + 1].index : markdown.length;
    return markdown.slice(start, end).trim();
  }

  // No innerHTML anywhere here, so the markdown source itself can never inject markup.
  function renderInlineMarkdown(text, container) {
    const re = /\*\*(.+?)\*\*|`(.+?)`|\[(.+?)\]\((.+?)\)/g;
    let lastIndex = 0;
    let match;
    while ((match = re.exec(text))) {
      if (match.index > lastIndex) {
        container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      if (match[1] !== undefined) {
        const strong = document.createElement('strong');
        strong.textContent = match[1];
        container.appendChild(strong);
      }
      else if (match[2] !== undefined) {
        const code = document.createElement('code');
        code.textContent = match[2];
        container.appendChild(code);
      }
      else {
        const a = document.createElement('a');
        a.textContent = match[3];
        a.href = match[4];
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        container.appendChild(a);
      }
      lastIndex = re.lastIndex;
    }
    if (lastIndex < text.length) {
      container.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }

  function renderSection(container, sectionText) {
    container.textContent = '';
    let list = null;
    for (const rawLine of sectionText.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;

      const catMatch = line.match(/^### (.+)$/);
      if (catMatch) {
        const h3 = document.createElement('h3');
        h3.textContent = catMatch[1];
        container.appendChild(h3);
        list = document.createElement('ul');
        container.appendChild(list);
        continue;
      }

      const bulletMatch = line.match(/^- (.+)$/);
      if (bulletMatch && list) {
        const li = document.createElement('li');
        renderInlineMarkdown(bulletMatch[1], li);
        list.appendChild(li);
      }
    }
    return container.childElementCount > 0;
  }

  // Fetches CHANGELOG.md and renders only the section for `version` into `container`.
  // Returns false (leaving container untouched) if the fetch or the section lookup fails.
  // The modal is only ever shown once per version (options.js marks it "seen" right
  // after calling this, even on failure), so a silent failure here permanently loses
  // that one chance — every early-return logs why, so a failure is diagnosable via
  // captureLogs instead of just "the modal never showed and nobody knows why".
  async function renderVersionChangelog(container, version) {
    try {
      const response = await fetch(CHANGELOG_URL);
      if (!response.ok) {
        gsUtils.warning('gsChangelog', 'renderVersionChangelog', `Fetch failed: ${response.status} ${CHANGELOG_URL}`);
        return false;
      }
      const markdown = await response.text();
      // Basic empty-response sanity check — e.g. a build step that somehow shipped a
      // zero-byte file, or this release's file getting wiped without being refilled.
      if (markdown.length < 20) {
        gsUtils.warning('gsChangelog', 'renderVersionChangelog', `Suspiciously short response (${markdown.length} bytes) from ${CHANGELOG_URL}. Content: ${markdown}`);
        return false;
      }
      const section = parseSection(markdown, version);
      if (!section) {
        gsUtils.warning('gsChangelog', 'renderVersionChangelog', `No "## [${version}]" section found in CHANGELOG_USER.md — did this release forget to update it?`);
        return false;
      }
      return renderSection(container, section);
    } catch (e) {
      gsUtils.warning('gsChangelog', 'renderVersionChangelog', e);
      return false;
    }
  }

  return { renderVersionChangelog };
})();

export { gsChangelog };
