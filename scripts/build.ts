import { copyFile, readFile, writeFile } from 'node:fs/promises';
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
  css: { inject: false },
  deps: {
    neverBundle: ['react', 'react/jsx-runtime', 'react-dom'],
    alwaysBundle: ['zod', '@deepseek-ai/dsh-typert-protocol/remote-info'],
    onlyBundle: false,
  },
  outputOptions: {
    entryFileNames: 'client.js',
  },
});

// 宿主加载 classic script；CSS 随插件作用域安装和释放，不保留 ESM 样式导入。
const [client, styles] = await Promise.all([
  readFile('packages/plugin/lib/client.js', 'utf8'),
  readFile('packages/plugin/lib/style.css', 'utf8'),
]);

await writeFile(
  'packages/plugin/lib/client.js',
  `window.__ModuleLoader__.load({ id: "@wahhheee/dsh-stash", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
${client}
return { ...module.exports, apply(ctx) {
  ctx.effect(() => {
    const style = document.createElement("style");
    style.dataset.stash = "client";
    style.textContent = ${JSON.stringify(styles)};
    document.head.append(style);
    return () => style.remove();
  }, "stash: client styles");
  return module.exports.apply(ctx);
} };
} });
`,
);

await copyFile('LICENSE', 'packages/plugin/LICENSE');
await copyFile('README.md', 'packages/plugin/README.md');
