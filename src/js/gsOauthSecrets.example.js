// Template for src/js/gsOauthSecrets.js (gitignored, not committed — see that file's header
// comment for why). Copy this to gsOauthSecrets.js and fill in the real value before building:
//
//   cp src/js/gsOauthSecrets.example.js src/js/gsOauthSecrets.js
//
// Value: client secret of the "Desktop app" OAuth client in Google Cloud Console used for the
// PKCE Drive-auth fallback (#437), distinct from the "Chrome App" client_id in manifest.json.
// `grunt`/`grunt tgut` refuse to build without a real (non-placeholder) file here.
export const PKCE_CLIENT_SECRET = 'REPLACE_ME';
