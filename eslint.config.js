import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import { builtinModules } from 'node:module';
export default tseslint.config(
  { ignores: ['.exclude/**', '**/lib/**', '**/node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: { '@typescript-eslint/consistent-type-imports': 'error' },
  },
  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...builtinModules,
            '@deepseek-ai/*',
            'node:*',
            '@wahhheee/dsh-stash',
            '@wahhheee/stash-devtools',
            '**/plugin/**',
            '**/devtools/**',
          ],
        },
      ],
    },
  },
  {
    files: ['packages/plugin/src/client/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...builtinModules,
            'node:*',
            '**/host/**',
            '**/adapters/config*',
            '**/adapters/diagnostics*',
            '**/adapters/dsh*',
            '**/adapters/trace*',
          ],
        },
      ],
    },
  },
  {
    files: ['packages/plugin/src/host/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: ['@deepseek-ai/*'] }] },
  },
  prettier,
);
