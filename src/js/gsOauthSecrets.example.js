// Template for src/js/gsOauthSecrets.js (gitignored, not committed — see that file's header
// comment for why). Copy this to gsOauthSecrets.js and fill in the real value before building:
//
//   cp src/js/gsOauthSecrets.example.js src/js/gsOauthSecrets.js
//
// Value: client secret of the "Web application" OAuth client (#420) in Google Cloud Console,
// reused for the PKCE Drive-auth fallback (#437) — distinct from the "Chrome App" client_id
// in manifest.json. Reused rather than a dedicated "Desktop app" client because Google only
// lets you register an arbitrary https redirect URI (chrome.identity.getRedirectURL()'s
// chromiumapp.org URL) on a "Web application" client; Desktop-app clients rejected it with
// redirect_uri_mismatch when tested against the live authorize endpoint.
// `grunt`/`grunt tgut` refuse to build without a real (non-placeholder) file here.
export const PKCE_CLIENT_SECRET = 'REPLACE_ME';
