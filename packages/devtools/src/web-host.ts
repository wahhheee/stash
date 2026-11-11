import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dshBin } from './harness.ts';
export async function startWebHost(
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<{ url: string; close: () => Promise<void> }> {
  const child = spawn(
    process.execPath,
    [dshBin, '--profile', 'web-test', '--no-open', '--port', '0'],
    { env: { ...env, DSH_HOME: home }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let tail = '';
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Web 启动超时：' + tail.slice(-3000)));
    }, 30000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('Web 提前退出 ' + String(code) + ': ' + tail.slice(-3000)));
    });
    const onData = (chunk: Buffer) => {
      tail += chunk.toString();
      const match = /dsh web: (http:\/\/[^\s]+)/u.exec(tail);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
  return {
    url,
    close: async () => {
      if (child.exitCode !== null) return;
      const ended = once(child, 'exit');
      child.kill();
      await ended;
    },
  };
}
