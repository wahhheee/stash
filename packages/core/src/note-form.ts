import { stringify } from 'yaml';
import { parseNote } from './notes.ts';

/** 表单只修改明确拥有的字段；未提供的可选字段保留原值。 */
export interface NoteForm {
  type: string;
  description: string;
  body: string;
  index: boolean;
  status: string | null;
  sources?: string[] | undefined;
}

export interface NoteProjection {
  form: NoteForm;
  preservedSources: string | null;
  additionalFields: string[];
}

export function projectNote(content: string): NoteProjection {
  const { fields, body } = parseNote(content);
  const sources = fields.sources;
  const editable =
    sources === undefined ||
    typeof sources === 'string' ||
    (Array.isArray(sources) && sources.every((value) => typeof value === 'string'));
  return {
    form: {
      type: String(fields.type),
      description: String(fields.description),
      body,
      index: fields.index !== false,
      status: typeof fields.status === 'string' ? fields.status : null,
      ...(editable
        ? {
            sources:
              sources === undefined
                ? []
                : typeof sources === 'string'
                  ? [sources]
                  : (sources as string[]),
          }
        : {}),
    },
    preservedSources: editable ? null : stringify(sources),
    additionalFields: Object.keys(fields).filter(
      (key) => !['type', 'description', 'index', 'status', 'sources'].includes(key),
    ),
  };
}

export function mergeNoteForm(original: string | null, form: NoteForm): string {
  const fields = original === null ? {} : { ...parseNote(original).fields };
  fields.type = form.type.trim();
  fields.description = form.description.trim();
  if (form.index || fields.index !== undefined) fields.index = form.index;
  else fields.index = false;
  if (form.status === null) delete fields.status;
  else fields.status = form.status;
  if (form.sources !== undefined) {
    const previous = fields.sources;
    const old = previous === undefined ? [] : typeof previous === 'string' ? [previous] : previous;
    if (JSON.stringify(old) !== JSON.stringify(form.sources)) {
      if (form.sources.length) fields.sources = form.sources;
      else delete fields.sources;
    }
  }
  const content = '---\n' + stringify(fields) + '---\n' + form.body;
  parseNote(content);
  return content;
}
