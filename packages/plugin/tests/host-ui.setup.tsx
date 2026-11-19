import type { DiffBlockProps } from '@deepseek-ai/dsh-client-ui-primitives';
import { vi } from 'vitest';

// Web 外壳提供此模块；组件测试仅观察传给宿主的差异，不重复测试宿主渲染器。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  DiffBlock: ({ diffs }: DiffBlockProps) => <pre>{JSON.stringify(diffs)}</pre>,
}));
