// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import { TextEncoder, TextDecoder } from 'node:util';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { expect, it, vi } from 'vitest';

it('客户端产物仅使用宿主静态模块表中的 React 和原生差异组件', async () => {
  const require = createRequire(import.meta.url);
  const dependencies: string[] = [];
  const source = await readFile(resolve('packages/plugin/lib/client.js'), 'utf8');
  let loaded = false;
  new Script(source).runInNewContext({
    window: {
      addEventListener: vi.fn(),
      __ModuleLoader__: {
        load(definition: {
          id: string;
          factory: (load: (name: string) => unknown) => { apply: unknown };
        }) {
          expect(definition.id).toBe('@wahhheee/dsh-stash');
          const plugin = definition.factory((name) => {
            dependencies.push(name);
            if (name === '@deepseek-ai/dsh-client-ui-primitives') return { DiffBlock: vi.fn() };
            if (!['react', 'react/jsx-runtime', 'react-dom'].includes(name))
              throw new Error('意外的浏览器外部依赖：' + name);
            return require(name) as unknown;
          });
          expect(plugin.apply).toBeTypeOf('function');
          loaded = true;
        },
      },
    },
    TextEncoder,
    TextDecoder,
    document,
    console,
  });
  expect(loaded).toBe(true);
  expect(dependencies).toContain('react');
  expect(dependencies).toContain('@deepseek-ai/dsh-client-ui-primitives');
});
