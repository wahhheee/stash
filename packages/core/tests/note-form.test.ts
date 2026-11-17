import { expect, it } from 'vitest';
import { mergeNoteForm, projectNote, parseNote } from '../src/index.ts';

it('结构化表单保留自定义元信息和非字符串来源，正文不变', () => {
  const original =
    '---\ntype: custom\ndescription: 主题 — 结论\nstatus: reviewed\nsources:\n  - seq: 7\ncustom: [a, b]\n---\n# 正文\n';
  const projected = projectNote(original);
  expect(projected.form.sources).toBeUndefined();
  expect(projected.preservedSources).toContain('seq');
  const next = parseNote(
    mergeNoteForm(original, { ...projected.form, description: '新主题（新结论）' }),
  );
  expect(next.fields).toMatchObject({
    type: 'custom',
    status: 'reviewed',
    sources: [{ seq: 7 }],
    custom: ['a', 'b'],
  });
  expect(next.body).toBe('# 正文\n');
});

it('表单写入生成合法笔记，来源标量保持不变，空摘要有准确字段错误', () => {
  const form = {
    type: 'lesson',
    description: '主题 — 关键条件与结论',
    body: '正文',
    index: true,
    status: null,
    sources: [],
  };
  expect(projectNote(mergeNoteForm(null, form)).form).toEqual(form);
  expect(() => mergeNoteForm(null, { ...form, description: '' })).toThrow(
    expect.objectContaining({ detail: { kind: 'note-field', field: 'description' } }),
  );
  const original = '---\ntype: fact\ndescription: 结论\nsources: dsh://session/s\n---\n正文';
  expect(parseNote(mergeNoteForm(original, projectNote(original).form)).fields.sources).toBe(
    'dsh://session/s',
  );
});
