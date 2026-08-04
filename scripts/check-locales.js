#!/usr/bin/env node
/**
 * Compares every non-en/it locale in src/_locales against the en source,
 * flagging keys that are missing or whose message is byte-identical to the
 * English source (untranslated, or a Crowdin fuzzy-match broken by a source
 * string edit). Exits 1 if any locale has flagged keys, so it can be wired
 * into CI later.
 */
const fs = require("fs");
const path = require("path");

const LOCALES_DIR = path.join(__dirname, "..", "src", "_locales");
const SOURCE_LOCALE = "en";
const SKIP_LOCALES = new Set([SOURCE_LOCALE, "it"]);

function loadMessages(locale) {
  const file = path.join(LOCALES_DIR, locale, "messages.json");
  const raw = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  return JSON.parse(raw);
}

function main() {
  const locales = fs
    .readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !SKIP_LOCALES.has(name))
    .sort();

  const source = loadMessages(SOURCE_LOCALE);
  const sourceKeys = Object.keys(source);

  let totalFlagged = 0;

  for (const locale of locales) {
    let target;
    try {
      target = loadMessages(locale);
    } catch (err) {
      console.log(`\n${locale}: FAILED TO READ (${err.message})`);
      totalFlagged++;
      continue;
    }

    const missing = [];
    const untranslated = [];

    for (const key of sourceKeys) {
      const sourceMessage = source[key]?.message;
      if (!(key in target)) {
        missing.push(key);
        continue;
      }
      const targetMessage = target[key]?.message;
      if (targetMessage === sourceMessage) {
        untranslated.push(key);
      }
    }

    if (missing.length || untranslated.length) {
      totalFlagged++;
      console.log(`\n${locale}: ${missing.length} missing, ${untranslated.length} untranslated (identical to en)`);
      for (const key of missing) console.log(`  missing:      ${key}`);
      for (const key of untranslated) console.log(`  untranslated: ${key}`);
    }
  }

  if (totalFlagged === 0) {
    console.log("All locales are in sync with en.");
  } else {
    console.log(`\n${totalFlagged} locale(s) need attention. Re-run the Crowdin sync after fixing.`);
    process.exitCode = 1;
  }
}

main();
