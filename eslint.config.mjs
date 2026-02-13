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
      'brace-style'                     : ['warn', 'stroustrup', { 'allowSingleLine': true }],
      'quotes'                          : ['warn', 'single', { 'avoidEscape': true }],
      'space-before-function-paren'     : ['warn', { 'anonymous': 'never', 'named': 'never', 'asyncArrow': 'always' }],
      'space-in-parens'                 : ['warn', 'never'],
      'spaced-comment'                  : ['warn', 'always'],

      // @TODO: phase 2 - these are safe, but apply 1-by-1
      'no-var'                          : ['warn'],
      'object-shorthand'                : ['warn', 'always', { 'ignoreConstructors': false, 'avoidQuotes': true } ],
      'prefer-arrow-callback'           : ['warn'],
      'prefer-const'                    : ['warn'],
      'prefer-template'                 : ['warn'],
      'strict'                          : ['warn'],

      // @TODO: phase 3 remove these overrides
      'no-async-promise-executor'                                 : ['off'],
      'no-prototype-builtins'                                     : ['off'],
      'no-redeclare'                                              : ['off'],
      '@typescript-eslint/dot-notation'                           : ['off'],  // revert to override below
      '@typescript-eslint/no-confusing-void-expression'           : ['off'],
      '@typescript-eslint/no-dynamic-delete'                      : ['off'],
      '@typescript-eslint/no-empty-function'                      : ['off'],
      '@typescript-eslint/no-floating-promises'                   : ['off'],  // @TODO turn this back on
      '@typescript-eslint/no-misused-promises'                    : ['off'],  // @TODO turn this back on
      // '@typescript-eslint/no-misused-promises'                    : ['error', { "checksVoidReturn": false }], // @TODO adopt this option
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
      '@typescript-eslint/prefer-includes'                        : ['warn'],
      '@typescript-eslint/prefer-nullish-coalescing'              : ['warn'],
      '@typescript-eslint/prefer-optional-chain'                  : ['warn'],
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

      'indent': ['error', 2, {
        'SwitchCase': 1,
        'VariableDeclarator': 1,
        'outerIIFEBody': 1,
        'FunctionDeclaration': { 'parameters': 1, 'body': 1 },
        'FunctionExpression': { 'parameters': 1, 'body': 1 },
        'CallExpression': { 'arguments': 1 },
        'ArrayExpression': 1,
        'ObjectExpression': 1,
        'ImportDeclaration': 1,
        'flatTernaryExpressions': false,
        'ignoreComments': true,             // updated
        'offsetTernaryExpressions': false,
      }],

      // original rules, but slightly more strict
      'no-console'                    : ['error'],
      'no-proto'                      : ['error'],
      'no-undef'                      : ['error'],
      'prefer-spread'                 : ['error'],
      'semi'                          : ['error'],

    }
  },
);
