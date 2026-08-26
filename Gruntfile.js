/* global module */
module.exports = function(grunt) {
  // require('time-grunt')(grunt);

  grunt.initConfig({
    pkg: grunt.file.readJSON('package.json'),
    manifest: grunt.file.readJSON('src/manifest.json'),
    config: {
      tempDir:
        grunt.cli.tasks[0] === 'tgut' ? 'build/tgut-temp/' : 'build/tms-temp/',
      buildName:
        grunt.cli.tasks[0] === 'tgut' ? 'tgut-<%= manifest.version %>' : 'tms-<%= manifest.version %>',
    },
    copy: {
      main: {
        expand: true,
        src: ['src/**', '!src/tests.html', '!src/js/tests/**', '!src/img/*.xcf'],
        dest: '<%= config.tempDir %>',
      },
    },
    'string-replace': {
      debugoff: {
        files: {
          '<%= config.tempDir %>src/js/':
            '<%= config.tempDir %>src/js/gsUtils.js',
        },
        options: {
          replacements: [
            {
              pattern: /debugInfo\s*=\s*true/,
              replacement: 'debugInfo = false',
            },
            {
              pattern: /debugError\s*=\s*true/,
              replacement: 'debugError = false',
            },
          ],
        },
      },
      debugon: {
        files: {
          '<%= config.tempDir %>src/js/':
            '<%= config.tempDir %>src/js/gsUtils.js',
        },
        options: {
          replacements: [
            {
              pattern: /debugInfo\s*=\s*false/,
              replacement: 'debugInfo = true',
            },
            {
              pattern: /debugError\s*=\s*false/,
              replacement: 'debugError = true',
            },
          ],
        },
      },
      localesTgut: {
        files: {
          '<%= config.tempDir %>src/_locales/':
            '<%= config.tempDir %>src/_locales/**',
        },
        options: {
          replacements: [
            {
              pattern: /The Marvellous Suspender/gi,
              replacement: 'The Marvellous Tester',
            },
          ],
        },
      },
      // Patches the real PKCE client secret (read from the gitignored
      // gsOauthSecrets.local.js by checkOauthSecrets below) into the *packaged build's*
      // copy of gsOauthSecrets.js, which starts as the committed 'REPLACE_ME' placeholder.
      // The tracked src/js/gsOauthSecrets.js is never touched.
      oauthSecret: {
        files: {
          '<%= config.tempDir %>src/js/':
            '<%= config.tempDir %>src/js/gsOauthSecrets.js',
        },
        options: {
          replacements: [
            {
              pattern: /REPLACE_ME/,
              replacement: () => grunt.config('oauthSecretValue'),
            },
          ],
        },
      },
    },
    crx: {
      public: {
        src: [
          '<%= config.tempDir %>src/**/*',
          '!**/html2canvas.js',
          '!**/Thumbs.db',
        ],
        dest: 'build/zip/<%= config.buildName %>.zip',
      },
      private: {
        src: [
          '<%= config.tempDir %>src/**/*',
          '!**/html2canvas.js',
          '!**/Thumbs.db',
        ],
        dest: 'build/crx/<%= config.buildName %>.crx',
        options: {
          privateKey: 'key.pem',
        },
      },
    },
    clean: ['<%= config.tempDir %>'],
  });

  grunt.loadNpmTasks('grunt-contrib-copy');
  grunt.loadNpmTasks('grunt-string-replace');
  grunt.loadNpmTasks('grunt-crx');
  grunt.loadNpmTasks('grunt-contrib-clean');

  // Guards against shipping a build where the Drive OAuth client secret was never set up
  // locally (file is gitignored, see src/js/gsOauthSecrets.local.js) — without this the
  // PKCE fallback for Brave/Vivaldi (#437) would silently break in the published
  // extension. src/js/gsOauthSecrets.js itself stays a committed 'REPLACE_ME' placeholder
  // (so gsBackup.js's static import never fails a plain unpacked-from-src/ load); the real
  // value read here is stashed on the grunt config for 'string-replace:oauthSecret' to
  // patch into the packaged build's own copy of that file, further down the task list.
  //
  // KNOWN, ACCEPTED TRADEOFF: this makes `grunt`/`npm run build` fail hard for anyone
  // without the maintainer's private secret, even a contributor who only wants a local
  // zip/crx build unrelated to Drive. Deliberately left this way rather than downgrading
  // to a warning, since the crx:private task a few steps later already has the exact same
  // shape of requirement — a gitignored `key.pem` signing key, also maintainer-only — so
  // this task doesn't introduce a new class of "can't `npm run build` without a project
  // secret" problem, only a second instance of an existing, accepted one. It does not
  // affect testing the PKCE flow itself: "Load unpacked" straight from src/ never invokes
  // Grunt at all, and a contributor can still create their own gsOauthSecrets.local.js
  // locally (see gsOauthSecrets.example.js) to test that path without ever running this.
  grunt.registerTask('checkOauthSecrets', function() {
    const path = 'src/js/gsOauthSecrets.local.js';
    if (!grunt.file.exists(path)) {
      grunt.fail.fatal(
        `\n\n${path} is missing (it's gitignored, not committed).\n` +
        'The build would ship without the Drive OAuth client secret and the PKCE fallback ' +
        '(Brave/Vivaldi, #437) would break at runtime.\n' +
        `Run: cp src/js/gsOauthSecrets.example.js ${path}  and fill in the real secret ` +
        'from the "Web application" OAuth client in Google Cloud Console.\n',
      );
    }
    const contents = grunt.file.read(path);
    const match = /PKCE_CLIENT_SECRET\s*=\s*['"](GOCSPX-[^'"]+)['"]/.exec(contents);
    if (!match) {
      grunt.fail.fatal(`\n\n${path} does not contain a real-looking PKCE_CLIENT_SECRET. Aborting build.\n`);
    }
    grunt.config('oauthSecretValue', match[1]);
  });

  grunt.registerTask('default', [
    'checkOauthSecrets',
    'copy',
    'string-replace:debugoff',
    'string-replace:oauthSecret',
    'crx:public',
    'crx:private',
    'clean',
  ]);
  grunt.registerTask('tgut', [
    'checkOauthSecrets',
    'copy',
    'string-replace:debugon',
    'string-replace:localesTgut',
    'string-replace:oauthSecret',
    'crx:public',
    'crx:private',
    'clean',
  ]);
};
