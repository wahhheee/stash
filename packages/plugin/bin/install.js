#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { constants, accessSync, readFileSync, statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { URL } from 'node:url';

const usage = `用法：npx @wahhheee/dsh-stash [--profile 名称] [--dsh 可执行文件的绝对路径]
默认安装到 desktop。请先打开一次 DSH Desktop，再完全退出后安装。`;
const windows = process.platform === 'win32';

function executable(file) {
  try {
    accessSync(file, windows ? constants.F_OK : constants.X_OK);
    return statSync(file).isFile();
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return false;
    throw error;
  }
}

function findDsh(profile, explicit) {
  if (explicit !== undefined) {
    if (!isAbsolute(explicit) || !executable(explicit))
      throw new Error('--dsh 需要可执行文件的绝对路径。');
    return explicit;
  }
  const names = windows ? ['dsh.exe', 'dsh.cmd', 'dsh.bat'] : ['dsh'];
  const onPath = (process.env.PATH ?? '')
    .split(delimiter)
    .map((dir) => (windows ? dir.replace(/^"(.*)"$/, '$1') : dir))
    .filter(isAbsolute)
    .flatMap((dir) => names.map((name) => join(dir, name)));
  const desktop = [];
  if (windows) {
    const { LOCALAPPDATA, ProgramFiles, 'ProgramFiles(x86)': programFilesX86 } = process.env;
    const roots = [LOCALAPPDATA && join(LOCALAPPDATA, 'Programs'), ProgramFiles, programFilesX86];
    for (const root of roots) {
      if (root && isAbsolute(root))
        desktop.push(
          join(root, 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
        );
    }
  }
  // desktop 优先使用随桌面版安装的 CLI，以免 npx 或其他项目的 PATH 指向另一套宿主。
  const candidates =
    profile.toLowerCase() === 'desktop' ? [...desktop, ...onPath] : [...onPath, ...desktop];
  const file = candidates.find(executable);
  if (!file)
    throw new Error(
      '找不到 DSH 命令。可用 --dsh 指定路径，或在 DSH Desktop 的「插件 → 添加插件」中输入 @wahhheee/dsh-stash。',
    );
  return file;
}

function install() {
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h' },
      profile: { type: 'string', default: 'desktop' },
      dsh: { type: 'string' },
    },
  });
  if (values.help) {
    process.stdout.write(usage + '\n');
    return 0;
  }
  const profile = values.profile;
  if (
    !profile ||
    profile.startsWith('-') ||
    ['.', '..', 'node_modules'].includes(profile) ||
    profile.includes('\0') ||
    /[\\/\r\n"]/u.test(profile)
  )
    throw new Error('请使用单个 profile 名称。');
  const cli = findDsh(profile, values.dsh);
  const { name, version } = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const spec = `${name}@${version}`;
  process.stdout.write(`使用 ${cli} 安装 ${spec} 到 ${profile}\n`);
  let result;
  if (windows && ['.cmd', '.bat'].includes(extname(cli).toLowerCase())) {
    // cmd 只解析固定命令。带空格的路径及参数通过引号中的环境变量传递，并关闭延迟展开。
    result = spawnSync(
      join(process.env.SystemRoot, 'System32', 'cmd.exe'),
      [
        '/d',
        '/v:off',
        '/s',
        '/c',
        '""%STASH_INSTALL_CLI%" plugin --profile "%STASH_INSTALL_PROFILE%" add "%STASH_INSTALL_PACKAGE%""',
      ],
      {
        windowsVerbatimArguments: true,
        stdio: 'inherit',
        env: {
          ...process.env,
          STASH_INSTALL_CLI: cli,
          STASH_INSTALL_PROFILE: profile,
          STASH_INSTALL_PACKAGE: spec,
        },
      },
    );
  } else {
    result = spawnSync(cli, ['plugin', '--profile', profile, 'add', spec], { stdio: 'inherit' });
  }
  if (result.error) throw result.error;
  return result.status ?? 1;
}

try {
  process.exitCode = install();
} catch (error) {
  process.stderr.write(`stash: ${error.message}\n${usage}\n`);
  process.exitCode = 1;
}
