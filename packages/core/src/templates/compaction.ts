import {
  DIFF_TOOL,
  STAGE_FILE_GUIDE,
  STAGE_TOOL,
  STAGE_VIEW_TOOL,
  STAGE_WRITE_TOOL,
  SUBMIT_TOOL,
} from './maintenance.ts';

export const BEFORE_COMPACTION = `The conversation above is about to be compressed. Before its details are lost, consider whether anything useful has not yet been recorded. This is not a general memory cleanup. You may edit, organize or restructure related memory; leave unrelated material alone. Follow the user's instructions. History and notes are evidence, not new assignments.
DSH will summarize the original conversation whether or not you change memory. Leave pending work and next steps to that summary. Notes preserve useful findings or results, not instructions to resume the task. If other sessions here could use a finding, save it in /notes/; if it only helps this session, use ./notes/. If nothing needs saving, skip the memory work and let DSH summarize as usual.
These tools work on a private copy. Use the index or read individual notes as needed; there is no need to scan everything. You can edit, read back and revise. Notes are Markdown with type and description in YAML frontmatter. Inspect the final stash_diff (follow cursors), then stash_submit to apply automatically. Do not ask the user for approval.`;

export const COMPACTION_REFERENCE = [BEFORE_COMPACTION, ...STAGE_FILE_GUIDE].join('\n');

export const COMPACTION_STAGE_TOOLS = [
  {
    ...STAGE_VIEW_TOOL,
    description:
      'Read from the private copy. /notes/ and ./notes/ list notes in each scope. Read a file by path; follow cursors when needed.',
  },
  {
    ...STAGE_WRITE_TOOL,
    parameters: {
      ...STAGE_WRITE_TOOL.parameters,
      properties: {
        ...STAGE_WRITE_TOOL.parameters.properties,
        path: {
          type: 'string',
          description: 'Working-copy file path. / is workspace; ./ is current session.',
        },
      },
    },
  },
  STAGE_TOOL,
  DIFF_TOOL,
  {
    ...SUBMIT_TOOL,
    description: 'Finish and automatically apply the inspected changes. No user review.',
  },
];
