import type { SwitchRecord } from '@wahhheee/stash-core';

export interface PageTarget {
  kind: 'workspace' | 'session';
  id: string;
}

export interface PageFile {
  path: string;
  content: string;
  revision: string;
}

export interface MemoryPageData {
  sessionEditable: boolean;
  workspaceId: string;
  title: string;
  sessionId: string | null;
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
