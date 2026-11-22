import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it } from 'vitest';
import manifest from '../package.json' with { type: 'json' };
import { testEnvironment } from '../../devtools/src/harness.ts';

const windows = process.platform === 'win32';
const bin = resolve('packages/plugin/bin/install.js');
let root: string;
let env: NodeJS.ProcessEnv;
let pathKey: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'stash installer '));
  env = testEnvironment(join(root, 'dsh-home'));
  pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path')!;
  env[pathKey] = join(root, 'path');
  if (windows) {
    env.LOCALAPPDATA = join(root, 'Local AppData');
    env.ProgramFiles = join(root, 'Program Files');
    env['ProgramFiles(x86)'] = join(root, 'Program Files x86');
  }
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function makeCli(dir: string, code = 0) {
  const file = join(dir, windows ? 'dsh.cmd' : 'dsh');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(root, 'record.cjs'),
    `require('node:fs').writeFileSync('received.json', JSON.stringify(process.argv.slice(2))); process.exit(${code});`,
  );
  env.STASH_TEST_NODE = process.execPath;
  const script = windows
    ? '@echo off\r\n"%STASH_TEST_NODE%" record.cjs %*\r\nexit /b %errorlevel%\r\n'
    : '#!/bin/sh\nexec "$STASH_TEST_NODE" record.cjs "$@"\n';
  await writeFile(file, script, { mode: 0o755 });
  return file;
}

function run(...args: string[]) {
  return spawnSync(process.execPath, [bin, ...args], { env, cwd: root, encoding: 'utf8' });
}
async function received() {
  return JSON.parse(await readFile(join(root, 'received.json'), 'utf8')) as string[];
}

it('默认选择 desktop；Windows 在 PATH 缺少命令时找到 Desktop 安装目录', async () => {
  const dir = windows
    ? join(env.LOCALAPPDATA!, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin')
    : env[pathKey]!;
  await makeCli(dir);
  expect(run().status).toBe(0);
  expect(await received()).toEqual([
    'plugin',
    '--profile',
    'desktop',
    'add',
    `${manifest.name}@${manifest.version}`,
  ]);
});

it('显式宿主路径和 profile 按原值传递，并保留宿主退出码', async () => {
  const cli = await makeCli(join(root, 'Custom & DSH'), 23);
  const profile = '我的 & web';
  expect(run('--profile', profile, '--dsh', cli).status).toBe(23);
  expect(await received()).toEqual([
    'plugin',
    '--profile',
    profile,
    'add',
    `${manifest.name}@${manifest.version}`,
  ]);
});

it('帮助无需宿主；缺少宿主时给出手动选择命令的入口', () => {
  expect(run('--help').status).toBe(0);
  const missing = run();
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain('--dsh');
});
