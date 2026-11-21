import { maintenanceActionSchema, maintenanceDataSchema } from './maintenance-schema.ts';
import type { MaintenanceAction, MaintenanceData } from './maintenance-schema.ts';
import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { StashStatus, StashReference } from '../types.ts';
import type {
  PageTarget,
  PageAction,
  MemoryPageData,
  PageMutation,
  PageMutationResult,
} from '../page-types.ts';
import {
  targetSchema,
  actionSchema,
  pageSchema,
  mutationSchema,
  mutationResultSchema,
} from './page-schema.ts';

function parameter(name: string, typeSymbol: string, schema: z.ZodType) {
  const codec = { mode: 'strict' as const, typeSymbol, create: () => schema };
  return { name, source: 'json' as const, codec, strictCodec: codec };
}

const ReferenceSchema: z.ZodType<StashReference> = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/u),
    title: z.string(),
    turn: z.number().int().nonnegative(),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    end: z.iso.datetime(),
  })
  .strict();

export const StatusSchema: z.ZodType<StashStatus> = z
  .object({
    version: z.string(),
    hostVersion: z.string(),
    phase: z.literal(7),
    memoryEnabled: z.boolean(),
    compactionSupported: z.boolean().optional(),
    trace: z.enum(['off', 'metadata', 'content']),
  })
  .strict();

/** 外部包的端点契约由 Host 与 Client 共享，避免两份 wire 描述漂移。 */
export const TYPERT_REMOTE = createTypertRemoteInfo(
  {
    package: '@wahhheee/dsh-stash',
    methods: {
      'stash/maintenance': {
        service: 'stash',
        invocation: { kind: 'direct' },
        parameters: [
          parameter('target', 'PageTarget', targetSchema),
          parameter('action', 'MaintenanceAction', maintenanceActionSchema),
        ],
        result: {
          mode: 'strict',
          typeSymbol: 'MaintenanceData',
          create: () => maintenanceDataSchema,
        },
      },
      'stash/mutateMemory': {
        service: 'stash',
        invocation: { kind: 'direct' },
        parameters: [
          parameter('target', 'PageTarget', targetSchema),
          parameter('request', 'PageMutation', mutationSchema),
        ],
        result: {
          mode: 'strict',
          typeSymbol: 'PageMutationResult',
          create: () => mutationResultSchema,
        },
      },
      'stash/getMemory': {
        service: 'stash',
        invocation: { kind: 'direct' },
        parameters: [parameter('target', 'PageTarget', targetSchema)],
        result: { mode: 'strict', typeSymbol: 'MemoryPageData', create: () => pageSchema },
      },
      'stash/changeMemory': {
        service: 'stash',
        invocation: { kind: 'direct' },
        parameters: [
          parameter('target', 'PageTarget', targetSchema),
          parameter('action', 'PageAction', actionSchema),
        ],
        result: { mode: 'strict', typeSymbol: 'MemoryPageData', create: () => pageSchema },
      },
      'stash/getReference': {
        service: 'stash',
        invocation: { kind: 'direct' },
        parameters: ['sessionId', 'messageId'].map((name) => ({
          name,
          source: 'json' as const,
          codec: {
            mode: 'strict' as const,
            typeSymbol: 'string',
            create: () => z.string().min(1).max(256),
          },
          strictCodec: {
            mode: 'strict' as const,
            typeSymbol: 'string',
            create: () => z.string().min(1).max(256),
          },
        })),
        result: { mode: 'strict', typeSymbol: 'StashReference', create: () => ReferenceSchema },
      },
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
    stash: {
      maintenance(
        target: PageTarget,
        action: MaintenanceAction,
      ): Promise<RemoteResult<MaintenanceData>>;

      getMemory(target: PageTarget): Promise<RemoteResult<MemoryPageData>>;
      changeMemory(target: PageTarget, action: PageAction): Promise<RemoteResult<MemoryPageData>>;

      mutateMemory(
        target: PageTarget,
        request: PageMutation,
      ): Promise<RemoteResult<PageMutationResult>>;

      getStatus(): Promise<RemoteResult<StashStatus>>;
      getReference(sessionId: string, messageId: string): Promise<RemoteResult<StashReference>>;
    };
  }
}
