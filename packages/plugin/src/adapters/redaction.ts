/** 报告与 trace 使用同一脱敏入口；不会读取环境变量或宿主配置。 */
export function redact(text: string): string {
  return text
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/gu, '[REDACTED]')
    .replace(/(Bearer\s+)[^\s"']+/giu, '$1[REDACTED]');
}
