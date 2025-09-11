import    globals             from 'globals';
import    js                  from '@eslint/js';
// import    pluginPromise       from 'eslint-plugin-promise';

// export default eslint.defineConfig(
export default [

  {
    ignores: [
      'node_modules',
      'src/js/db.js',
      'src/js/html2canvas.min.js',
    ],
  },

  {
    name: '--- languageOptions',
    languageOptions: {
      ecmaVersion: 2020,   // 2015=ES6, 2017 for async, 2020 for optional chain and nullish and global spread below
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        ...globals.serviceworker,
        // ...globals.jest,
        // ...globals.jquery,
        // ...globals.node,
      },
    },

  },

  js.configs.recommended,
  // pluginPromise.configs['flat/recommended'],

  {
    name: '--- main rules',
    rules: {
      'function-call-argument-newline'  : ['error', 'consistent'],
      'no-trailing-spaces'              : ['error'],
      // @TODO: phase 1 - style changes
      // 'brace-style'                     : ['error', 'stroustrup', { 'allowSingleLine': true }],
      // 'indent'                          : ['error', 2],
      // 'quotes'                          : ['error', 'single', { 'avoidEscape': true }],
      // 'space-before-function-paren'     : ['error', { 'anonymous': 'never', 'named': 'never', 'asyncArrow': 'always' }],
      // 'space-in-parens'                 : ['error', 'never'],
      // 'spaced-comment'                  : ['error', 'always'],
      // @TODO: phase 2 - these are safe, but apply 1-by-1
      // 'no-var'                          : ['error'],
      // 'object-shorthand'                : ['error', 'always', { 'ignoreConstructors': false, 'avoidQuotes': true } ],
      // 'prefer-arrow-callback'           : ['error'],
      // 'prefer-const'                    : ['error'],
      // 'prefer-spread'                   : ['error'],
      // 'prefer-template'                 : ['error'],
      // 'strict'                          : ['error'],
      // @TODO: phase 3 remove these overrides
      'no-async-promise-executor'       : ['off'],
      'no-prototype-builtins'           : ['off'],

      // original rules, but slightly more strict
      'no-console'                      : ['error'],
      'no-proto'                        : ['error'],
      'no-undef'                        : ['error'],
      'no-unused-vars'                  : ['error', {
        'vars'                : 'all',
        'args'                : 'none',
        // 'args'                : 'after-used',
        'ignoreRestSiblings'  : false,
        'caughtErrors'        : 'none',
        'argsIgnorePattern'   : '^_',
      }],
      'prefer-spread'                 : ['error'],
      'semi'                          : ['error'],

    }
  },
];
