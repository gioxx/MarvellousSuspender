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
        // *.local.js files are maintainer-local overrides, never tracked by git (the
        // historical one, src/js/gsOauthSecrets.local.js, once held the embedded OAuth
        // client secret), and *.pem is a signing key. Untracked files survive git
        // operations untouched, so the .gitignore entries alone don't stop a leftover
        // copy from being packaged: exclude both patterns here too.
        src: ['src/**', '!src/tests.html', '!src/js/tests/**', '!src/img/*.xcf', '!src/**/*.local.js', '!src/**/*.pem'],
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
    },
    crx: {
      public: {
        src: [
          '<%= config.tempDir %>src/**/*',
          '!**/Thumbs.db',
        ],
        dest: 'build/zip/<%= config.buildName %>.zip',
      },
      private: {
        src: [
          '<%= config.tempDir %>src/**/*',
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

  // Every task cleans first as well as last: a run that failed midway leaves its temp
  // dir behind, and copy only adds files, so whatever an earlier run put there would
  // be packaged by the next one regardless of the exclusions above.
  grunt.registerTask('default', [
    'clean',
    'copy',
    'string-replace:debugoff',
    'crx:public',
    'crx:private',
    'clean',
  ]);
  // Keyless build for CI and contributors: the store-ready zip only, no .crx signing.
  grunt.registerTask('zip', [
    'clean',
    'copy',
    'string-replace:debugoff',
    'crx:public',
    'clean',
  ]);
  grunt.registerTask('tgut', [
    'clean',
    'copy',
    'string-replace:debugon',
    'string-replace:localesTgut',
    'crx:public',
    'crx:private',
    'clean',
  ]);
};
