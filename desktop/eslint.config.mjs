import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['out/', 'dist/', 'node_modules/', 'test-results/', 'playwright-report/'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  { files: ['scripts/**'], rules: { 'no-console': 'off' } },
  // Fixture generators run in a throwaway Electron window with Node access.
  { files: ['tests/fixtures/**'], rules: { 'no-console': 'off', '@typescript-eslint/no-require-imports': 'off' } },
);
