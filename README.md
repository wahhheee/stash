# stash

stash 是 DeepSeek Harness（DSH）中面向软件开发的本地记忆插件，并非为日常聊天或角色扮演设计。它让同一工作区的开发会话共享规则和笔记，也为每个会话保留独立的记忆。模型可以检索原始对话，引用能定位到具体轮次或事件范围。

## 工作原理

| 内容             | 保存在何处                     | 模型何时读取                                                                       |
| ---------------- | ------------------------------ | ---------------------------------------------------------------------------------- |
| 工作区规则和笔记 | 本机记忆目录中的 Markdown 文件 | 同一工作区的会话共享。规则和笔记索引进入上下文，正文按需读取，也可由规则直接引用。 |
| 会话规则和笔记   | DSH 会话日志                   | 仅在所属会话生效。分叉继承分叉点之前的记忆，之后各自编辑。                         |
| 原始对话         | DSH 原始会话记录               | 模型按范围、时间或文字检索，通过引用读取原文。                                     |

stash 在模型请求前比较当前记忆与对话中已经可见的内容。首次加载和上下文压缩后提供完整的规则和索引，后续请求按变化补充。启用「压缩对话时补记笔记」时，模型还可以在 DSH 生成摘要前保存结论。

## 安装

### DSH Desktop

在 **插件 → 添加插件** 中输入 npm 包名 `@wahhheee/dsh-stash` 并安装。启用 **stash** 后，可在会话右侧栏打开它。如果所选镜像还查不到包，可将安装源切换到 npm 官方源。插件包 `package.json` 中的 `engines.dsh` 标明兼容的 DSH 版本。

### 使用 npx 安装

先打开一次 DSH Desktop，完全退出后运行：

```sh
npx @wahhheee/dsh-stash
```

默认安装到 `desktop`。要装到 Web 或其他 profile，可以指定名称：

```sh
npx @wahhheee/dsh-stash --profile web
```

Windows 上会查找 Desktop 的标准安装目录。自定义安装位置可以通过 `--dsh` 指定，在 Desktop 的命令设置中复制 `dsh.cmd` 的完整路径：

```powershell
npx @wahhheee/dsh-stash --dsh "D:\Apps\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
```

### 使用 DSH CLI 安装

```sh
dsh plugin --profile web add @wahhheee/dsh-stash
```

### 离线安装

离线包（`.tgz`）自带运行依赖。使用 DSH Desktop 时，将它解压到长期保留的目录，在 **插件 → 添加插件** 中输入解压后的 `package` 文件夹的绝对路径，然后启用 **stash**。DSH 会持续从该目录加载插件。

使用 DSH CLI 时，可以直接安装 `.tgz` 文件：

```sh
dsh plugin --profile web add /path/to/stash.tgz
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
