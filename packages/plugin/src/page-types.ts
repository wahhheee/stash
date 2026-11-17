import type { SwitchRecord } from '@wahhheee/stash-core';
import type { NoteForm, NoteProjection } from '@wahhheee/stash-core';

export interface PageTarget {
  kind: 'workspace' | 'session';
  id: string;
}

export interface PageFile {
  path: string;
  content: string;
  revision: string;
  note?: NoteProjection | null | undefined;
}

export interface MemoryPageData {
  sessionEditable: boolean;
  workspaceId: string;
  title: string;
  sessionId: string | null;
  sessionTitle?: string | undefined;
  globalEnabled: boolean;
  workspace: SwitchRecord;
  session: SwitchRecord;
  effective: {
    enabled: boolean;
    writable: boolean;
    discoverable: boolean;
    inheritWorkspace: boolean;
    source: 'global' | 'workspace' | 'session';
  };
  files: { workspace: PageFile[]; session: PageFile[] };
  revisions: { workspace: string; session: string };
}

export type PageAction =
  | { op: 'switches'; scope: 'workspace' | 'session'; value: SwitchRecord }
  | {
      op: 'save';
      scope: 'workspace' | 'session';
      path: string;
      content: string | null;
      expected: string | null;
    }
  | { op: 'promote'; path: string; destination: string; expected: string }
  | { op: 'clear'; scope: 'workspace' | 'session'; expected: string; confirm: true };

export type PageEdit =
  | PageAction
  | {
      op: 'note';
      scope: 'workspace' | 'session';
      path: string;
      expected: string | null;
      value: NoteForm;
    };

export interface PageMutation {
  id: string;
  action: PageEdit;
}

export type PageMutationResult =
  | { ok: true; scope: 'workspace' | 'session'; file: PageFile | null; cleared: boolean }
  | {
      ok: false;
      code: string;
      field?: string | undefined;
      used?: number | undefined;
      limit?: number | undefined;
    };
