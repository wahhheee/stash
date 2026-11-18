import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const git = promisify(execFile);

export async function readHead(cwd: string) {
  return git('git', ['-C', cwd, 'rev-parse', '--verify', 'HEAD'], {
    windowsHide: true,
    timeout: 2000,
    maxBuffer: 4096,
  })
    .then((r) => r.stdout.trim())
    .catch(() => null);
}
