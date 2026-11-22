import { builtinModules } from 'node:module';
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

const nodeImports = [...builtinModules, 'node:*'];
const restrict = (...patterns) => ['error', { patterns }];

export default defineConfig([
  globalIgnores(['.exclude/**', '**/lib/**', '**/coverage/**']),
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommended],
    rules: { '@typescript-eslint/consistent-type-imports': 'error' },
  },
  {
    files: ['packages/*/src/**/*.{ts,tsx}', 'scripts/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },
  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': restrict(
        ...nodeImports,
        '@deepseek-ai/*',
        '@wahhheee/dsh-stash',
        '@wahhheee/stash-devtools',
        '**/plugin/**',
        '**/devtools/**',
      ),
    },
  },
  {
    files: ['packages/plugin/src/client/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': restrict(
        ...nodeImports,
        '**/host/**',
        '**/adapters/**',
        '!**/adapters/remote.ts',
        '!**/adapters/maintenance-schema.ts',
      ),
    },
  },
  {
    files: ['packages/plugin/src/host/**/*.ts'],
    rules: { 'no-restricted-imports': restrict('@deepseek-ai/*') },
  },
]);
