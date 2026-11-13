import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { StashStatus } from '../types.ts';

export const StatusSchema: z.ZodType<StashStatus> = z
  .object({
    version: z.string(),
    hostVersion: z.string(),
    phase: z.literal(2),
    memoryEnabled: z.literal(true),
    trace: z.enum(['off', 'metadata', 'content']),
  })
  .strict();

/** 外部包的端点契约由 Host 与 Client 共享，避免两份 wire 描述漂移。 */
export const TYPERT_REMOTE = createTypertRemoteInfo(
  {
    package: '@wahhheee/dsh-stash',
    methods: {
      'stash/getStatus': {
        service: 'stash',
        invocation: { kind: 'direct' },
        parameters: [],
        result: { mode: 'strict', typeSymbol: 'StashStatus', create: () => StatusSchema },
      },
    },
  },
  z,
);

export default TYPERT_REMOTE;

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    stash: { getStatus(): Promise<RemoteResult<StashStatus>> };
  }
}
