import { maintenanceActionSchema } from './maintenance-schema.ts';
import type { MaintenanceAction, MaintenanceData } from './maintenance-schema.ts';
import { createRequire } from 'node:module';
import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-commands';
import { StashRuntime } from '../host/runtime.ts';
import { Config, resolveHostConfig } from './config.ts';
import { watchCompaction } from './compaction.ts';
import type { StashStatus, StashReference } from '../types.ts';
import { StashError } from '@wahhheee/stash-core';
import manifest from '../../package.json' with { type: 'json' };
import { MemoryAdapter } from './memory-dsh.ts';
import { MemoryPage } from './memory-page.ts';
import { targetSchema, actionSchema, mutationSchema } from './page-schema.ts';
import type {
  PageTarget,
  PageAction,
  MemoryPageData,
  PageMutation,
  PageMutationResult,
} from '../page-types.ts';

declare module '@deepseek-ai/cordis' {
  interface Context {
    stash: StashService;
  }
}

/** DSH 服务边界负责注册、生命周期和宿主版本解析。 */
export class StashService extends TypertRemoteService {
  static Config = Config;
  static inject = [
    'commands',
    'agents',
    'tools',
    'systemPrompt',
    'tokenMeter',
    'sessionQuery',
    'sessionProjections',
    'workspaceRegistry',
    'storageDomain',
    'sessions',
  ];
  private readonly runtime: StashRuntime;
  private readonly memory: MemoryAdapter;
  private readonly page: MemoryPage;
  private readonly supportsNotes: () => boolean;

  constructor(ctx: Context, config: ReturnType<typeof Config> = Config({})) {
    super(ctx, 'stash', { namespace: 'stash' });
    const require = createRequire(import.meta.url);
    const host = require('@deepseek-ai/dsh-commands/package.json') as { version: string };
    this.runtime = new StashRuntime(resolveHostConfig(config), manifest.version, host.version);
    const memory = new MemoryAdapter(ctx, this.runtime.config, this.runtime.trace);
    this.memory = memory;
    this.supportsNotes = watchCompaction(ctx, memory, () => config.compactionNotes.get());
    this.page = new MemoryPage(memory);
    const logger = ctx.logger('stash');
    ctx.effect(
      () =>
        ctx.commands.register({
          name: 'stash',
          description: 'stash 状态与诊断',
          input: {
            hint: 'health | rollback <整理会话> | status | context | render | explain [n] | doctor [--bundle] | trace off|metadata|content',
          },
          recordInput: false,
          handler: async (invocation) => {
            try {
              const result = await memory.command(invocation.agent, invocation.rawInput);
              if (result && invocation.rawInput.trim() === 'status')
                return {
                  ...result,
                  text: (await this.runtime.command('status')).text + '\n' + result.text,
                };
              return (
                result ?? (await this.runtime.command(invocation.rawInput, invocation.commandId))
              );
            } catch (error) {
              const code = error instanceof StashError ? error.code : 'STASH_IO_ERROR';
              logger.error(
                'command %s failed: %s (%s)',
                invocation.commandId,
                code,
                error instanceof Error ? error.name : 'unknown',
              );
              try {
                await this.runtime.trace.emit({
                  v: 1,
                  timestamp: new Date().toISOString(),
                  kind: 'error',
                  callId: invocation.commandId,
                  code,
                });
              } catch {
                logger.error('trace write failed for command %s', invocation.commandId);
              }
              return {
                kind: 'error',
                text:
                  'stash 命令失败，请检查目录权限和宿主日志。调用 ID：' +
                  invocation.commandId +
                  '；错误码：' +
                  code,
              };
            }
          },
        }),
      'stash: commands',
    );
    ctx.effect(async () => {
      await this.runtime.trace.emit({
        v: 1,
        timestamp: new Date().toISOString(),
        kind: 'plugin.start',
      });
      logger.info('stash %s ready', manifest.version);
      return async () => {
        await this.runtime.trace.flush();
      };
    }, 'stash: trace');
  }

  /** 用于识别属于本实例的压缩器作用域。 */
  get compactionMemory(): MemoryAdapter {
    return this.memory;
  }

  /** 获取不含敏感信息的插件状态。 */
  @Remote
  getStatus(): StashStatus {
    return { ...this.runtime.status(), compactionSupported: this.supportsNotes() };
  }

  @Remote
  async maintenance(target: PageTarget, action: MaintenanceAction): Promise<MaintenanceData> {
    return this.page.maintenance(targetSchema.parse(target), maintenanceActionSchema.parse(action));
  }

  @Remote
  async getMemory(target: PageTarget): Promise<MemoryPageData> {
    return this.page.read(targetSchema.parse(target));
  }

  @Remote
  async changeMemory(target: PageTarget, action: PageAction): Promise<MemoryPageData> {
    return this.page.change(targetSchema.parse(target), actionSchema.parse(action));
  }

  @Remote
  async mutateMemory(target: PageTarget, request: PageMutation): Promise<PageMutationResult> {
    return this.page.mutate(targetSchema.parse(target), mutationSchema.parse(request));
  }

  /** 从宿主完整日志定位消息所属轮次，客户端不依赖已加载的聊天窗口。 */
  @Remote
  async getReference(sessionId: string, messageId: string): Promise<StashReference> {
    const reference = await (await this.memory.history).reference(sessionId, messageId);
    return {
      id: reference.id,
      title: reference.title,
      turn: reference.turn,
      from: reference.from,
      to: reference.to,
      end: reference.end,
    };
  }
}
