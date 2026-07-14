'use strict';

module.exports = [
  {
    ignores: ['node_modules/**', 'test-results/**', 'playwright-report/**', 'data/**'],
  },
  {
    files: ['**/*.js'],
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },
];
