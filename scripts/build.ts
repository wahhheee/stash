import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'tsdown';
import { decoratorPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown';

await build({
  cwd: 'packages/plugin',
  entry: {
    index: 'src/index.ts',
    'typert.host': 'src/adapters/typert.ts',
    'typert.remote-client': 'src/adapters/remote.ts',
    types: 'src/types.ts',
  },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  clean: true,
  fixedExtension: false,
  dts: { tsconfig: resolve('tsconfig.json') },
  plugins: [decoratorPlugin()],
  deps: {
    alwaysBundle: ['@wahhheee/stash-core'],
    neverBundle: [/^@deepseek-ai\//, 'zod', 'semver'],
  },
});
await build({
  cwd: 'packages/plugin',
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  clean: false,
  fixedExtension: false,
  dts: false,
  deps: {
    neverBundle: ['react', 'react/jsx-runtime'],
    alwaysBundle: ['zod', '@deepseek-ai/dsh-typert-protocol/remote-info'],
    onlyBundle: false,
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "@wahhheee/dsh-stash", factory: (require) => {',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
});
await copyFile('LICENSE', 'packages/plugin/LICENSE');
await copyFile('README.md', 'packages/plugin/README.md');
