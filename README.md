# stash

DSH 工作区记忆插件。当前版本 0.2.1 提供工作区规则与笔记读写、常驻上下文、压缩后恢复、状态面板和离线重放。

## 开发

需要 Node.js 22.18+、pnpm 12.18.0，宿主锁定为 DeepSeek Harness 0.2.2-rc.1。

```sh
pnpm install --frozen-lockfile
pnpm check
```

check 依次执行格式、lint、构建、类型、单元/宿主/客户端和真实进程端到端检查。普通测试只使用本地 mock，不需要 API key，也不读取日常 DSH profile。

仓库默认使用 npmmirror；CI 使用 npm 官方源。可用 npm_config_registry 环境变量覆盖。凭据不要写入源码、配置样例或命令历史；本阶段无需真实模型密钥。

## 安装与使用

先构建，再创建专用 Web profile 并链接本地包：

```sh
pnpm build
pnpm exec dsh --profile stash-dev --from-default-profile web --dump-config
pnpm exec dsh plugin --profile stash-dev add ./packages/plugin
pnpm exec dsh --profile stash-dev --no-open
```

从终端给出的本机地址打开页面，展开右侧栏，选择 stash。在会话输入框中执行：

```text
/stash status
/stash context
/stash render
/stash explain 10
/stash doctor
/stash doctor --bundle
/stash trace metadata
/stash trace off
```

Desktop：在“插件 → 添加插件”中输入 packages/plugin 的绝对目录，安装后启用，再从会话右侧栏打开 stash。desktop profile 由 Electron 管理，不能通过 CLI 修改。

给其他机器试用时打包，并在目标机器安装生成的 tarball：

```sh
pnpm --dir packages/plugin pack --pack-destination ../..
pnpm exec dsh plugin --profile stash-dev add ./wahhheee-dsh-stash-0.2.1.tgz
```

尚未发布 npm 包。唯一分发包为 @wahhheee/dsh-stash；core 和 devtools 均为私有工作区包。

## 工作区记忆

插件启用后固定开启工作区记忆。新会话首次请求注入规则和笔记索引；普通自身写入由简短工具结果确认，不重复发送完整规则。其他会话或编辑器改动在下一请求以增量通知生效；请求与写入交错时允许保守补发包含自身修改的差异。新引入的规则引用和嵌套调用也按保守补发处理。压缩后重新注入最新完整快照。

请求前检查文件清单、mtime 与大小，仅变化文件重新读取和哈希；同时间同大小的外部修改可能暂时漏检。显式读取、写前目标版本校验和离线检查读取真实内容。子 Agent 只读；多个会话基于同一旧版本修改时，冲突者需重新读取，不自动合并。

修改日志直接追加，保留 pending 供中断恢复；无匹配 pending 的残缺日志明确报错。决策日志仍整体原子替换，用于离线重放。故障处理见调试手册。

在插件设置中可配置 rulesBudgetTokens（默认 1600）、indexBudgetTokens（1600）、viewBudgetTokens（4000）及 externalRuleUpdates（next-request 或 next-compaction）。预算为宿主估算值，配置修改后重载生效。

笔记示例：

```markdown
---
type: lesson
description: Windows 构建产物过期时先 clean 再构建，只删 lib 无效
---

记录适用条件、原因与证据；一篇只记一个事实。
```

## 配置与诊断

| 配置               | 默认            | 含义                                                    |
| ------------------ | --------------- | ------------------------------------------------------- |
| trace              | off             | off / metadata / content                                |
| traceRetentionDays | 7               | 保留 1–365 个 UTC 日历日                                |
| memoryRoot         | DSH_HOME/memory | 记忆与诊断数据根目录；支持绝对、相对 DSH_HOME 和 ~ 路径 |

报告在 memoryRoot/.reports，格式为 .json.gz，只含插件配置、检查结果和 trace 元数据，始终剥离正文。

```sh
pnpm devtools verify /path/to/memory
pnpm devtools verify /path/to/stash-report.json.gz
```

当前 SDK 不支持自定义 /stash 命令；不要将它传给 SDK run，否则宿主会当作模型提示。使用 Web/Desktop 命令入口，自动化通过 Web Gateway 调用。

## 代码与文档

- packages/core：宿主无关端口、类型、模板和内存测试实现。
- packages/plugin：Host、Client、DSH 与文件系统适配器。
- packages/devtools：离线校验及隔离宿主测试夹具。
- [工程设计](docs/design.md)、[调试手册](docs/debugging.md)、[开发约定](AGENTS.md)。
- [目标设计](docs/roadmap-design.md)、[阶段规划](docs/roadmap-plan.md)仅描述规划；[阶段二决策记录](docs/decisions/0002-workspace-memory.md)记录实际差异与收尾取舍。

记忆按 DSH 工作区共享。可以对模型说“以后提交信息用简体中文”，由 memory_write 保存到 /RULES.md。笔记位于 /notes/，可用 memory_view 阅读。完整读取后才能覆盖或删除；工具写入和已观察到的外部编辑都有修改历史。会话路径、历史检索、开关界面和回滚尚未提供。

MIT License。
