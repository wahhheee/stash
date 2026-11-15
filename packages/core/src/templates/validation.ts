import type { StashErrorDetail } from '../errors.ts';
import { WRITE_OPERATIONS } from '../write.ts';

export const WRITE_OPERATION_GUIDE = Object.entries(WRITE_OPERATIONS)
  .map(([op, fields]) =>
    fields.length
      ? `${op}: require ${fields.join(' and ')}; omit other content fields.`
      : `${op}: use only path and op; omit content, old and new, even empty strings or null.`,
  )
  .join('\n');

/** 只渲染已分类的原因和固定字段名，不回显输入正文或底层异常。 */
export function validationDetail(detail: StashErrorDetail): string {
  switch (detail.kind) {
    case 'write-object':
      return 'memory_write requires an object with path and op. No changes were made.';
    case 'write-operation':
      return (
        'Choose op from: ' + Object.keys(WRITE_OPERATIONS).join(', ') + '. No changes were made.'
      );
    case 'write-unknown-field':
      return 'Unknown argument. Use only path, op and the fields required by the selected operation. No changes were made.';
    case 'write-required':
      return `Missing required field "${detail.field}". Supply it and retry. No changes were made.`;
    case 'write-string':
      return `Field "${detail.field}" must be a string, not null or another type. No changes were made.`;
    case 'write-empty':
      return `Field "${detail.field}" must not be empty. No changes were made.`;
    case 'write-forbidden':
      return `Operation "${detail.operation}" does not accept "${detail.field}". Omit that field and retry. No changes were made.`;
    case 'edit-match':
      return detail.count === 0
        ? 'Edit old text was not found. Read the current file and provide an exact match. No changes were made.'
        : `Edit old text matched ${detail.count} locations. Include more surrounding text to select exactly one. No changes were made.`;
    case 'note-unclosed':
      return 'YAML frontmatter is not closed. Add a closing --- line before the note body.';
    case 'note-yaml':
      return 'Invalid YAML frontmatter. Use valid YAML with unique keys and no aliases.';
    case 'note-mapping':
      return 'YAML frontmatter must be a mapping of field names to values.';
    case 'note-field':
      return detail.field === 'type' || detail.field === 'description'
        ? `Note frontmatter requires "${detail.field}" as a non-empty, single-line string.`
        : `Note frontmatter "${detail.field}" must be ${detail.field === 'index' ? 'a boolean' : 'a string'}.`;
  }
}
