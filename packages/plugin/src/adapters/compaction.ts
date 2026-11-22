import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Context, Fiber } from '@deepseek-ai/cordis';
import type { MemoryAdapter } from './memory-dsh.ts';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { CompactionNotes, type SummaryInput } from './before-compaction.ts';
import type {} from './dsh.ts';

/** 只读取原装类提供给子类的摘要方法，不创建第二个压缩服务。 */
class StockHooks extends BasicCompactionEngine {
  static readonly summarize = this.prototype.summarize;
}

/** 只装饰原装压缩器。卸载时按方法身份检查所有权，保留其他插件安装的钩子。 */
function attachCompactionNotes(
  ctx: Context,
  memory: MemoryAdapter,
  enabled: () => boolean,
): (() => void) | undefined {
  const engine = ctx.compaction;
  if (
    typeof StockHooks.summarize !== 'function' ||
    !(engine instanceof BasicCompactionEngine) ||
    Object.getPrototypeOf(engine) !== BasicCompactionEngine.prototype
  )
    return;
  let active = true;
  const useNotes = () => active && enabled();
  const notes = new CompactionNotes(ctx, engine.config, memory, useNotes);
  const hooks = {
    summarize(
      this: BasicCompactionEngine,
      input: SummaryInput,
      agent: Agent,
      signal?: AbortSignal,
    ) {
      const original = () => StockHooks.summarize.call(this, input, agent, signal);
      return useNotes() ? notes.summarize(input, agent, signal, original) : original();
    },
  };
  const entries = Object.entries(hooks);
  if (!Object.isExtensible(engine) || entries.some(([key]) => Object.hasOwn(engine, key))) return;
  for (const [key, value] of entries)
    Object.defineProperty(engine, key, { configurable: true, writable: true, value });
  return () => {
    active = false;
    for (const [key, value] of entries) {
      if (Object.getOwnPropertyDescriptor(engine, key)?.value === value)
        Reflect.deleteProperty(engine, key);
    }
  };
}

/** Web 预设隔离了各自的压缩器；SDK 默认只提供根实例，两者共享同一 profile 开关。 */
export function watchCompaction(ctx: Context, memory: MemoryAdapter, enabled: () => boolean) {
  const attached = new Map<Fiber, () => void>();
  const sync = (fiber: Fiber) => {
    const service = [...fiber.provisions].find(
      (p) => p.name === 'compaction' && p.ctx.get('compaction'),
    );
    if (!service) {
      attached.get(fiber)?.();
      attached.delete(fiber);
      return;
    }
    if (attached.has(fiber) || service.ctx.get('stash', false)?.compactionMemory !== memory) return;
    const detach = attachCompactionNotes(service.ctx, memory, enabled);
    if (detach) attached.set(fiber, detach);
  };
  ctx.on('internal/status', sync);
  for (const runtime of ctx.registry.values()) for (const fiber of runtime.fibers) sync(fiber);
  ctx.effect(
    () => () => {
      for (const detach of attached.values()) detach();
      attached.clear();
    },
    'stash: 压缩补记',
  );
  return () => attached.size !== 0;
}
