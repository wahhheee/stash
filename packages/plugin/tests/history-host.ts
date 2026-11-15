import type { Context } from '@deepseek-ai/cordis';
import { join } from 'node:path';
import Query from '@deepseek-ai/dsh-session-query';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import Storage from '@deepseek-ai/dsh-storage';
import * as StorageJson from '@deepseek-ai/dsh-storage-json';
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain';
import Workspace from '@deepseek-ai/dsh-workspace';
import ProjectionCache from '@deepseek-ai/dsh-session-projection-cache';

/** 全文入口在本测试组合中禁用，实际只读观察沿用宿主实现。 */
class ReadOnlyQuery extends Query {
  override async searchSessions(): Promise<never> {
    throw new Error('不应调用全文索引');
  }

  override async searchEvents(): Promise<never> {
    throw new Error('不应调用全文索引');
  }
}

export async function mountHistoryHost(ctx: Context, root: string) {
  await ctx.plugin(Persistence, { root: join(root, 'sessions') });
  await ctx.plugin(Storage);
  await ctx.plugin(StorageJson, { root: join(root, 'storage') });
  await ctx.plugin(StorageDomain, { backend: 'json', routes: {} });
  await ctx.plugin(ProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60000 });
  await ctx.plugin(Workspace);
  await ctx.plugin(ReadOnlyQuery);
}
