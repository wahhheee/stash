import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import stylistic from '@stylistic/eslint-plugin';
import { builtinModules } from 'node:module';

// 大块定义和顶层初始化分开；短类型别名、常量和连续字段可以保持成组。
const separatedStatements = [
  'function',
  'class',
  'interface',
  'enum',
  'multiline-type',
  'multiline-export',
  { selector: 'TSModuleDeclaration' },
  { selector: 'Program > VariableDeclaration', lineMode: 'multiline' },
  { selector: 'Program > ExpressionStatement', lineMode: 'multiline' },
  { selector: ':matches(TSMethodSignature)', lineMode: 'multiline' },
];

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
  {
    plugins: { '@stylistic': stylistic },
    rules: {
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: 'import', next: '*' },
        { blankLine: 'any', prev: 'import', next: 'import' },
        { blankLine: 'always', prev: '*', next: separatedStatements },
        { blankLine: 'always', prev: separatedStatements, next: '*' },
      ],
      '@stylistic/lines-between-class-members': [
        'error',
        {
          enforce: [
            { blankLine: 'always', prev: 'method', next: '*' },
            { blankLine: 'always', prev: '*', next: 'method' },
          ],
        },
      ],
    },
  },
);
