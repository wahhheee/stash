# 参与开发

## 本地运行

Node.js 与 pnpm 的版本由根目录的 [package.json](package.json) 指定。在仓库根目录运行 `pnpm install --frozen-lockfile`，再运行 `pnpm check`。测试夹具使用临时 DSH 主目录和本地模型服务，无需 API key。

单独运行测试前先执行 `pnpm build`，宿主会从 `packages/plugin/lib` 加载构建产物。可以用 `pnpm test packages/plugin/tests/history-dsh.test.ts` 检查单个模块，用 `pnpm test:e2e e2e/plugin.test.ts` 检查打包、安装和 SDK 请求。

交互调试使用专用 Web profile。修改源码后重新构建，重启该 profile 并刷新页面。

```sh
pnpm exec dsh --profile stash-dev --from-default-profile web --dump-config
pnpm exec dsh plugin --profile stash-dev add ./packages/plugin
pnpm exec dsh --profile stash-dev --no-open
```

## 从哪里改

| 要修改的行为                                 | 入口                                                                                                                                                                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 规则展开、笔记索引、分叉记忆、模型看到的文字 | [领域模型](packages/core/src) 与 [提示模板](packages/core/src/templates)                                                                                                                                                      |
| 读写、查找历史、整理副本                     | [宿主用例](packages/plugin/src/host)                                                                                                                                                                                          |
| DSH 生命周期与工具                           | [服务入口](packages/plugin/src/adapters/dsh.ts)、[会话接入](packages/plugin/src/adapters/memory-dsh.ts)、[工具注册](packages/plugin/src/adapters/memory-tools.ts)、[请求上下文](packages/plugin/src/adapters/resident-dsh.ts) |
| 冷会话、压缩与 Remote 接口                   | [会话观察](packages/plugin/src/adapters/history-dsh.ts)、[压缩器](packages/plugin/src/adapters/compaction.ts)、[Remote 契约](packages/plugin/src/adapters/remote.ts)                                                          |
| 版本冲突、中断恢复和重放                     | [工作区文件存储](packages/plugin/src/adapters/memory-store.ts)、[修改日志](packages/plugin/src/adapters/journal.ts)、[离线工具](packages/devtools/src)                                                                        |
| 右侧栏、菜单与设置                           | [客户端入口](packages/plugin/src/client/index.tsx) 与 [DSH 界面组件入口](packages/plugin/src/client/dsh-ui.ts)                                                                                                                |

[工程设计](docs/design.md) 说明数据如何保存、继承和恢复。[调试手册](docs/debugging.md) 列出诊断命令、日志位置与恢复步骤。[设计方向](docs/roadmap-design.md) 说明可扩展的能力和边界。已有方案的理由在[决策记录](docs/decisions)中。

## 升级 DSH

在升级分支的仓库根目录运行 `pnpm host:prepare <精确版本>`。该命令读取 npm 上该版 Typert 的依赖声明，同步宿主、SDK、测试框架和插件清单中的版本约束。然后运行 `pnpm install --no-frozen-lockfile`，一起审阅清单与锁文件。

`pnpm check` 会经过真实的 Cordis 注册及卸载、SDK 请求、Web Gateway 和离线安装。重点核对宿主的会话观察与投影、原生和嵌套工具结果、压缩摘要钩子、客户端模块加载。预览通道的独立巡检见[兼容工作流](.github/workflows/compatibility.yml)。

## 提交与分发

提交信息使用 Conventional Commits 与简体中文。PR 说明应指出受影响的入口、验证方式，以及已有记忆或会话日志的兼容情况。诊断材料请使用本地夹具生成。

发布物是 `packages/plugin` 的离线包。构建后用 `pnpm --dir packages/plugin pack --pack-destination ../..` 打包，并用 `tar -tf <离线包>` 检查内容。
