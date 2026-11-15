/** 报告与 trace 使用同一脱敏入口；不会读取环境变量或宿主配置。 */
export function redact(text: string): string {
  return text
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/gu, '[REDACTED]')
    .replace(/\bgh[pousr]_[a-zA-Z0-9]{20,}\b/gu, '[REDACTED]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/gu, '[REDACTED]')
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|$)/gu,
      '[REDACTED]',
    )
    .replace(/(Bearer\s+)[^\s"']+/giu, '$1[REDACTED]');
}

/** 常见凭据格式只作拒绝判定，不回传匹配内容。 */
export function containsSecret(text: string): boolean {
  return /\bsk-[a-zA-Z0-9_-]{12,}\b|Bearer\s+[^\s"']+|\bgh[pousr]_[a-zA-Z0-9]{20,}\b|\bAKIA[A-Z0-9]{16}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu.test(
    text,
  );
}
