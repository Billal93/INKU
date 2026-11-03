// Lint du Montage uniquement (le site principal garde ses propres règles ES2017, voir CLAUDE.md).
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['montage/vendor/**', 'node_modules/**', 'index.html', 'assets/**'] },
  {
    files: ['montage/**/*.js', 'tests/unit/**/*.mjs', 'tests/perf/**/*.mjs', 'tools/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024, sourceType: 'module',
      globals: { ...globals.browser, ...globals.worker, ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'eqeqeq': ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      'no-implicit-globals': 'error',
      'no-shadow-restricted-names': 'error',
    },
  },
  { files: ['montage/coi-register.js'], languageOptions: { sourceType: 'script' }, rules: { 'no-var': 'off' } },
];
