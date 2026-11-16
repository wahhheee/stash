import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';

/** 子进程仅继承启动所需变量，不读取开发凭据与真实 DSH_HOME。 */
export function testEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (
      /^(path|systemroot|windir|comspec|pathext|temp|tmp|home|userprofile|localappdata|appdata)$/iu.test(
        key,
      )
    )
      env[key] = value;
  return {
    ...env,
    DSH_HOME: home,
    DSH_AGENTS_HOME: join(home, 'agents'),
    DEEPSEEK_API_KEY: 'stash-test-placeholder',
    DSH_PRIMARY_RUNTIME: '',
    npm_config_registry: process.env.npm_config_registry ?? 'https://registry.npmmirror.com/',
  };
}

export async function runNode(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd = resolve('.'),
  executable = process.execPath,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
    }, 120_000);
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(output);
      else reject(new Error('子进程退出 ' + String(code) + '\n' + output.slice(-6000)));
    });
  });
}

export const dshBin = resolve('node_modules/@deepseek-ai/dsh/lib/bin.js');

export async function createHarnessFixture(): Promise<{
  root: string;
  home: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  cli: (...args: string[]) => Promise<string>;
  sdk: (baseURL: string, workspace?: string, patches?: string[]) => DeepSeekHarness;
  close: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'stash-e2e-'));
  const home = join(root, 'home');
  const cwd = join(root, 'workspace');
  await mkdir(cwd, { recursive: true });
  const env = testEnvironment(home);
  const cli = (...args: string[]) => runNode([dshBin, ...args], env, cwd);
  const patch = join(root, 'deterministic.patch.yml');
  // 时间、机器目录提示是宿主提供的非确定性输入；两组实验使用相同显式隔离配置。
  await writeFile(
    patch,
    '- id: time-context\n  disabled: true\n- id: agent-instructions\n  disabled: true\n- id: plugin-package-inventory-deepseek\n  disabled: true\n- id: session-log-deepseek\n  disabled: true\n',
  );
  return {
    root,
    home,
    cwd,
    env,
    cli,
    sdk: (baseURL, workspace = cwd, patches = []) =>
      new DeepSeekHarness({
        dshBin,
        dshHome: home,
        profile: 'test',
        cwd: workspace,
        processCwd: workspace,
        patches: [patch, ...patches],
        env: { ...env, DEEPSEEK_BASE_URL: baseURL },
        initializeTimeoutMs: 30000,
        requestTimeoutMs: 30000,
      }),
    close: () => rm(root, { recursive: true, force: true }),
  };
}
