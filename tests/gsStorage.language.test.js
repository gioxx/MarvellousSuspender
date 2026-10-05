import { describe, expect, it } from 'vitest';
import { gsStorage } from '../src/js/gsStorage.js';

// saveSettings() also drops the in-memory settings cache, so each case starts from storage.
async function storedLanguage() {
  const settings = await gsStorage.getStorage('local', 'gsSettings');
  return settings[gsStorage.LANGUAGE];
}

describe('gsStorage language codes', () => {
  it.each([
    ['fr-FR', 'fr'],
    ['si-LK', 'si'],
    ['uk-UA', 'uk'],
  ])('rewrites the legacy code %s to %s and saves it', async (legacy, current) => {
    await gsStorage.saveSettings({ [gsStorage.LANGUAGE]: legacy });

    expect(await gsStorage.getOption(gsStorage.LANGUAGE)).toBe(current);
    expect(await storedLanguage()).toBe(current);
  });

  it.each(['auto', 'it', 'pt_BR', 'uk'])('keeps %s as it is', async (language) => {
    await gsStorage.saveSettings({ [gsStorage.LANGUAGE]: language });

    expect(await gsStorage.getOption(gsStorage.LANGUAGE)).toBe(language);
    expect(await storedLanguage()).toBe(language);
  });
});
