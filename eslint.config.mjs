import    globals             from 'globals';
import    eslint              from '@eslint/js';
import  { defineConfig }      from 'eslint/config';
import    tseslint            from 'typescript-eslint';
import    pluginPromise       from 'eslint-plugin-promise';


export default defineConfig(

  {
    ignores: [
      'node_modules',
      'src/js/db.js',
      'src/js/html2canvas.min.js',
    ],
  },

  { name: '--- eslint js recommended' },
  eslint.configs.recommended,
  tseslint.configs.eslintRecommended,     // This is recommended to be used after eslint.configs.recommended
  tseslint.configs.strictTypeChecked,     // strictTypeChecked contains recommended, recommendedTypeChecked, and strict
  tseslint.configs.stylisticTypeChecked,
  // pluginPromise.configs['flat/recommended'],   // @TODO: Enable this plugin eventually, or consider the full airbnb config

  {
    name: '--- languageOptions',
    languageOptions: {
      ecmaVersion: 2022,   // 2015=ES6, 2017 for async, 2020 for optional chain and nullish and global spread below
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        ...globals.serviceworker,
        ...globals.node,
      },
      parserOptions: {
        projectService: {
        },
        tsconfigRootDir: process.cwd(),
      },
    },

  },

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
      'no-async-promise-executor'                                 : ['off'],
      'no-prototype-builtins'                                     : ['off'],
      'no-redeclare'                                              : ['off'],
      '@typescript-eslint/dot-notation'                           : ['off'],  // revert to override below
      '@typescript-eslint/no-confusing-void-expression'           : ['off'],
      '@typescript-eslint/no-dynamic-delete'                      : ['off'],
      '@typescript-eslint/no-empty-function'                      : ['off'],
      '@typescript-eslint/no-floating-promises'                   : ['off'],  // @NEXT turn this back on
      '@typescript-eslint/no-misused-promises'                    : ['off'],  // @NEXT turn this back on
      '@typescript-eslint/no-this-alias'                          : ['off'],
      '@typescript-eslint/no-unnecessary-condition'               : ['off'],
      '@typescript-eslint/no-unsafe-argument'                     : ['off'],
      '@typescript-eslint/no-unsafe-assignment'                   : ['off'],
      '@typescript-eslint/no-unsafe-call'                         : ['off'],
      '@typescript-eslint/no-unsafe-member-access'                : ['off'],
      '@typescript-eslint/no-unsafe-return'                       : ['off'],
      '@typescript-eslint/no-unused-expressions'                  : ['off'],
      '@typescript-eslint/no-unused-vars'                         : ['off'],  // revert to override below
      '@typescript-eslint/prefer-for-of'                          : ['off'],
      '@typescript-eslint/prefer-includes'                        : ['off'],
      '@typescript-eslint/prefer-nullish-coalescing'              : ['off'],
      '@typescript-eslint/prefer-optional-chain'                  : ['off'],
      '@typescript-eslint/prefer-promise-reject-errors'           : ['off'],
      '@typescript-eslint/require-await'                          : ['off'],
      '@typescript-eslint/restrict-plus-operands'                 : ['off'],
      '@typescript-eslint/restrict-template-expressions'          : ['off'],
      '@typescript-eslint/unbound-method'                         : ['off'],
      '@typescript-eslint/use-unknown-in-catch-callback-variable' : ['off'],

      // Prefer typescript extended rules over default eslint rules
      // https://typescript-eslint.io/rules/dot-notation/
      // https://typescript-eslint.io/rules/no-unused-vars/
      'dot-notation'                      : ['off'],
      'no-unused-vars'                    : ['off'],
      // '@typescript-eslint/dot-notation'   : ['error'],
      // '@typescript-eslint/no-unused-vars' : ['error', {
      //   'vars'                : 'all',
      //   'args'                : 'none',
      //   // 'args'                : 'after-used',
      //   'ignoreRestSiblings'  : false,
      //   'caughtErrors'        : 'none',
      //   'argsIgnorePattern'   : '^_',
      // }],

      '@typescript-eslint/prefer-regexp-exec'             : ['off'],

      // original rules, but slightly more strict
      'no-console'                    : ['error'],
      'no-proto'                      : ['error'],
      'no-undef'                      : ['error'],
      'prefer-spread'                 : ['error'],
      'semi'                          : ['error'],

    }
  },
);
