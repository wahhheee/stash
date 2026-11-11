import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { expect, it } from 'vitest';

it('客户端产物遵守宿主 classic script 工厂契约，外部依赖仅 React', async () => {
  const require = createRequire(import.meta.url);
  const dependencies: string[] = [];
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  let loaded = false;
  new Script(source).runInNewContext({
    window: {
      __ModuleLoader__: {
        load(definition: {
          id: string;
          factory: (load: (name: string) => unknown) => { apply: unknown };
        }) {
          expect(definition.id).toBe('@wahhheee/dsh-stash');
          const plugin = definition.factory((name) => {
            if (name !== 'react' && name !== 'react/jsx-runtime')
              throw new Error('意外的浏览器外部依赖：' + name);
            dependencies.push(name);
            return require(name) as unknown;
          });
          expect(plugin.apply).toBeTypeOf('function');
          loaded = true;
        },
      },
    },
    TextEncoder,
    TextDecoder,
    console,
  });
  expect(loaded).toBe(true);
  expect(dependencies).toContain('react');
});
