# stash

stash 是 DeepSeek Harness（DSH）的本地记忆插件。它让同一工作区的聊天共享规则和笔记，也为每个会话保留独立的记忆。模型可以检索原始对话，引用能定位到具体轮次或事件范围。

## 工作原理

| 内容             | 保存在何处                     | 模型何时读取                                                                       |
| ---------------- | ------------------------------ | ---------------------------------------------------------------------------------- |
| 工作区规则和笔记 | 本机记忆目录中的 Markdown 文件 | 同一工作区的会话共享。规则和笔记索引进入上下文，正文按需读取，也可由规则直接引用。 |
| 会话规则和笔记   | DSH 会话日志                   | 仅在所属会话生效。分叉继承分叉点之前的记忆，之后各自编辑。                         |
| 原始对话         | DSH 原始会话记录               | 模型按范围、时间或文字检索，通过引用读取原文。                                     |

stash 在模型请求前比较当前记忆与对话中已经可见的内容。首次加载和上下文压缩后提供完整的规则和索引，后续请求按变化补充。启用「压缩对话时补记笔记」时，模型还可以在 DSH 生成摘要前保存结论。

## 安装

### DSH Desktop

1. 将 stash 离线包（`.tgz`）解压到长期保留的目录。打开解压后的 `package` 文件夹，里面应有 `package.json`、`lib` 和 `node_modules`。
2. 在 DSH Desktop 打开 **插件 → 添加插件**，输入这个 `package` 文件夹的绝对路径。Windows 可从资源管理器地址栏复制完整路径。
3. 启用 **stash**，在会话右侧栏打开 **stash**。DSH 会持续从所选目录加载插件。

离线包自带运行依赖。插件清单的 `engines.dsh` 指明所需的 DSH 版本。

### DSH Web

在已有 Web profile 中，用 DSH CLI 安装离线包。将 `PROFILE` 替换为 profile 名称，最后一个参数填入本机的包路径。

```sh
dsh plugin --profile PROFILE add /path/to/stash.tgz
```

### 从源码安装

Node.js 和 pnpm 的版本要求见根目录 `package.json` 的 `engines.node` 和 `packageManager`。在仓库根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm build
```

在 Desktop 中添加构建好的 `packages/plugin` 目录即可。要生成可分发的离线包，运行 `pnpm --dir packages/plugin pack --pack-destination ../..`，生成的 `.tgz` 位于仓库根目录。

## 查看与管理

在右侧栏选择 **工作区** 或 **本会话**，可以查看和编辑规则、笔记及其来源。在设置中可以控制记忆是否启用、是否允许模型写入，以及会话是否继承工作区记忆、是否出现在其他会话的搜索结果中。

工作区的整理功能提供差异审阅、自动应用和按次回滚。对话压缩前的补记由 **DSH 设置 → stash** 中的全局开关控制。

在仓库中可以继续阅读 `CONTRIBUTING.md`、`docs/design.md` 和 `docs/debugging.md`。
