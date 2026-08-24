// Committed placeholder — always present in the tree so gsBackup.js's static import
// never fails a fresh checkout or "Load unpacked" straight from src/. The real value
// lives only in src/js/gsOauthSecrets.local.js (gitignored, never committed), and
// Gruntfile.js's build pipeline replaces this placeholder with that real value in the
// packaged build's own copy of this file, leaving this tracked copy untouched. See
// src/js/gsOauthSecrets.local.js's own header (or gsOauthSecrets.example.js) for setup.
export const PKCE_CLIENT_SECRET = 'REPLACE_ME';
