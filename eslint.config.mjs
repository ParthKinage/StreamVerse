import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/artifacts/**',
      '**/cache/**',
      '**/typechain-types/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/uploads/**',
      '**/hls-output/**',
      'contracts/deployments/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.mocha } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // The relayer key and server-side adapters must never reach the browser bundle.
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: '@tesor_gp/blockchain', message: 'Server-only. Import ABIs from "@tesor_gp/blockchain/abis".' },
            { name: '@tesor_gp/database', message: 'Server-only. The web app must not access the database package.' },
          ],
          patterns: [{ group: ['**/SETTLEMENT_RELAYER*', '**/relayer*'], message: 'The relayer key is server-only.' }],
        },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'env', message: 'Use import.meta.env in the web app.' },
      ],
    },
  },
  {
    // Build-time config runs in Node, not in the browser bundle.
    files: ['apps/web/vite.config.ts', 'e2e/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-restricted-properties': 'off' },
  },
);
