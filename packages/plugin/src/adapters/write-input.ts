import { StashError, WRITE_OPERATIONS } from '@wahhheee/stash-core';
import type { StashErrorDetail, WriteField, WriteInput } from '@wahhheee/stash-core';

function invalid(detail: StashErrorDetail): never {
  throw new StashError('STASH_INVALID_DATA', '写入参数无效', detail);
}

/** 先按操作限定字段，再验证字段值；空字符串不会被当成省略。 */
export function parseWriteInput(value: unknown): WriteInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid({ kind: 'write-object' });
  const input = value as Record<string, unknown>;
  const fields: readonly WriteField[] = ['path', 'op', 'content', 'old', 'new'];
  if (Object.keys(input).some((key) => !fields.some((field) => field === key)))
    invalid({ kind: 'write-unknown-field' });
  const op = input.op;
  if (typeof op !== 'string' || !Object.hasOwn(WRITE_OPERATIONS, op))
    invalid({ kind: 'write-operation' });
  const operation = op as keyof typeof WRITE_OPERATIONS;
  const required: readonly WriteField[] = ['path', 'op', ...WRITE_OPERATIONS[operation]];
  for (const field of fields)
    if (!required.includes(field) && Object.hasOwn(input, field))
      invalid({ kind: 'write-forbidden', operation, field });
  for (const field of required) {
    if (!Object.hasOwn(input, field)) invalid({ kind: 'write-required', field });
    if (typeof input[field] !== 'string') invalid({ kind: 'write-string', field });
  }
  if (!(input.path as string).trim()) invalid({ kind: 'write-empty', field: 'path' });
  if (operation === 'edit' && input.old === '') invalid({ kind: 'write-empty', field: 'old' });
  // 上面的操作表已验证联合类型中每一分支的全部必需字段。
  return input as WriteInput;
}
