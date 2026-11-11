import { inspectRoot, readReport } from '../../plugin/src/adapters/diagnostics.ts';

const [command, target, ...extra] = process.argv.slice(2);
try {
  if (command !== 'verify' || !target || extra.length) {
    console.error('用法：pnpm devtools verify <记忆目录或 .json.gz 报告包>');
    process.exitCode = 2;
  } else {
    const checks = target.endsWith('.json.gz')
      ? (await readReport(target)).checks
      : await inspectRoot(target);
    for (const check of checks)
      console.log((check.ok ? 'OK ' : 'FAIL ') + check.name + ': ' + check.detail);
    process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
  }
} catch (error) {
  console.error('校验失败：' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
