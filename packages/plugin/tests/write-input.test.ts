import { expect, it } from 'vitest';
import { StashError, toolError, validationDetail } from '@wahhheee/stash-core';
import { parseWriteInput } from '../src/adapters/write-input.ts';

function failure(input: unknown): string {
  try {
    parseWriteInput(input);
  } catch (error) {
    if (error instanceof StashError && error.detail)
      return toolError(error.code, validationDetail(error.detail));
    throw error;
  }
  throw new Error('预期校验失败');
}

it('删除和归档拒绝多余正文，错误指出字段并允许省略后重试', () => {
  for (const op of ['delete', 'archive']) {
    for (const field of ['content', 'old', 'new']) {
      for (const value of ['', null, '不应回显的正文']) {
        const text = failure({ path: '/notes/a.md', op, [field]: value });
        expect(text).toContain(`Operation "${op}" does not accept "${field}"`);
        expect(text).toContain('Omit that field and retry. No changes were made.');
        expect(text).not.toContain('Edit requires');
        expect(text).not.toContain('不应回显的正文');
      }
    }
    expect(parseWriteInput({ path: '/notes/a.md', op })).toEqual({ path: '/notes/a.md', op });
  }
});

it('正文操作区分缺失、类型、空值和非法字段', () => {
  for (const op of ['create', 'append', 'replace']) {
    expect(failure({ path: '/RULES.md', op })).toContain('Missing required field "content"');
    expect(failure({ path: '/RULES.md', op, content: null })).toContain(
      '"content" must be a string',
    );
    expect(parseWriteInput({ path: '/RULES.md', op, content: '' })).toMatchObject({ content: '' });
    expect(failure({ path: '/RULES.md', op, content: '', old: '' })).toContain(
      'does not accept "old"',
    );
  }
  expect(failure({ path: '/RULES.md', op: 'edit', old: 'a' })).toContain(
    'Missing required field "new"',
  );
  expect(failure({ path: '/RULES.md', op: 'edit', old: '', new: '' })).toContain(
    '"old" must not be empty',
  );
  expect(parseWriteInput({ path: '/RULES.md', op: 'edit', old: 'a', new: '' })).toMatchObject({
    new: '',
  });
  expect(failure(null)).toContain('requires an object');
  expect(failure({ path: '/RULES.md', op: 'unknown' })).toContain('Choose op from');
  expect(failure({ path: '/RULES.md', op: 'delete', privateText: '不应回显' })).not.toContain(
    '不应回显',
  );
});
