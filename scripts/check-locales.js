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
const REFERENCE_LOCALE = "it";
const SKIP_LOCALES = new Set([SOURCE_LOCALE, REFERENCE_LOCALE]);

// Keys confirmed to be legitimate loanwords/cognates in these locales (the
// local word is spelled the same as the English source), verified manually
// against native usage elsewhere in each file. Not caught by the IT-based
// cognate check since Italian happened to translate these differently.
const KNOWN_COGNATES = {
  de: new Set(["html_about_version_label", "html_options_suspend_theme_system", "js_history_tab", "js_history_tabs"]),
  es: new Set(["html_options_other_title", "html_options_suspend_minute", "html_backup_settings_local_title"]),
  fr: new Set([
    "html_about_version_label",
    "html_sidebar_session_management",
    "html_success_goto_advanced_suffix",
    "html_updated_info_line2_suffix",
    "html_backup_settings_local_title",
  ]),
  "fr-FR": new Set([
    "html_about_version_label",
    "html_success_goto_advanced_suffix",
    "html_updated_info_line2_suffix",
    "html_backup_settings_local_title",
  ]),
  id: new Set(["js_history_tab", "html_backup_drive_label_folder"]),
  pt_BR: new Set(["html_options_suspend_minute", "html_backup_settings_local_title"]),
  pt_PT: new Set(["html_options_suspend_minute", "html_backup_settings_local_title"]),
  cs: new Set(["html_options_suspend_minute"]),
  sk: new Set(["html_options_suspend_minute"]),
};

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
  const reference = loadMessages(REFERENCE_LOCALE);
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
      const referenceMessage = reference[key]?.message;
      const isKnownCognate = referenceMessage === sourceMessage || KNOWN_COGNATES[locale]?.has(key);
      if (targetMessage === sourceMessage && !isKnownCognate) {
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
