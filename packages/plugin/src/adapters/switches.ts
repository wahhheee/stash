import { switchSchema } from './page-schema.ts';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import type { Context } from '@deepseek-ai/cordis';
import { DEFAULT_SWITCHES, StashError } from '@wahhheee/stash-core';
import type { SwitchRecord, SwitchScope, SwitchStore } from '@wahhheee/stash-core';
import type { FileMemoryStore } from './memory-store.ts';

const spec = defineDomain({
  name: 'stash_switches',
  version: 1,
  tables: { sessions: domainTable<string, SwitchRecord>(switchSchema) },
});

/** 开关正本独立于模型日志；未知格式由宿主存储域拒绝打开。 */
export class DshSwitchStore implements SwitchStore {
  readonly ready: Promise<Domain<typeof spec>>;

  constructor(
    ctx: Context,
    private readonly files: FileMemoryStore,
    private readonly enabled: boolean,
  ) {
    this.ready = ctx.storageDomain.open(spec);
    ctx.effect(async () => {
      const domain = await this.ready;
      return () => domain.close();
    }, 'stash: switches');
  }

  async get(scope: SwitchScope): Promise<SwitchRecord | null> {
    if (scope.kind === 'global') return { ...DEFAULT_SWITCHES, enabled: this.enabled };
    if (scope.kind === 'workspace') return this.files.getSwitches(scope.id);
    return (await this.ready).table('sessions').get(scope.id) ?? null;
  }

  async set(scope: SwitchScope, value: SwitchRecord): Promise<void> {
    const parsed = switchSchema.parse(value);
    if (scope.kind === 'global')
      throw new StashError('STASH_UNSUPPORTED', '请在插件配置修改全局开关');
    if (scope.kind === 'workspace') await this.files.setSwitches(scope.id, parsed);
    else await (await this.ready).table('sessions').put(scope.id, parsed);
  }
}
