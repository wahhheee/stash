import { readFile, writeFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { valid } from 'semver';

// 发布的 Typert 协议声明了跨包使用的 Zod 和 Cordis 版本。
const version = process.argv[2];
if (!version || !valid(version)) throw new Error('用法：pnpm host:prepare <DSH 精确版本>');
const response = await fetch(
  `https://registry.npmjs.org/@deepseek-ai%2fdsh-typert-protocol/${version}`,
);
if (!response.ok)
  throw new Error(`无法读取 DSH ${version} 的 Typert 清单（HTTP ${response.status}）`);
const protocol = z
  .object({
    version: z.literal(version),
    dependencies: z.object({ zod: z.string().min(1) }),
    peerDependencies: z.object({ '@deepseek-ai/cordis': z.string().min(1) }),
  })
  .parse(await response.json());

const versions = z.record(z.string(), z.string());
const manifestSchema = z.looseObject({
  engines: versions.optional(),
  dependencies: versions.optional(),
  devDependencies: versions.optional(),
  peerDependencies: versions.optional(),
});

const paths = ['package.json', 'packages/plugin/package.json', 'packages/devtools/package.json'];
const manifests = await Promise.all(
  paths.map(async (path) => {
    const source = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(await readFile(path, 'utf8')));
    const parsed = manifestSchema.parse(source);
    for (const deps of [parsed.dependencies, parsed.devDependencies, parsed.peerDependencies]) {
      if (!deps) continue;
      for (const name of Object.keys(deps)) {
        if (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
          deps[name] = version;
        if (name === '@deepseek-ai/cordis') deps[name] = protocol.peerDependencies[name];
        if (name === 'zod') deps[name] = protocol.dependencies.zod;
      }
    }
    if (parsed.engines?.dsh) parsed.engines.dsh = version;
    return JSON.stringify({ ...source, ...parsed }, null, 2) + '\n';
  }),
);
const workspacePath = 'pnpm-workspace.yaml';
const workspace = parseDocument(await readFile(workspacePath, 'utf8'));
if (workspace.errors.length) throw workspace.errors[0];
workspace.setIn(['overrides', 'zod'], protocol.dependencies.zod);
for (const [i, path] of paths.entries()) await writeFile(path, manifests[i]!);
await writeFile(workspacePath, workspace.toString());
