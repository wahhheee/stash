# stash

DSH 工作区记忆插件。当前版本 0.1.0 提供插件加载、状态面板、诊断和离线校验；记忆功能尚未启用。

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
/stash doctor
/stash doctor --bundle
/stash trace metadata
/stash trace off
```

Desktop：在“插件 → 添加插件”中输入 packages/plugin 的绝对目录，安装后启用，再从会话右侧栏打开 stash。desktop profile 由 Electron 管理，不能通过 CLI 修改。

给其他机器试用时打包，并在目标机器安装生成的 tarball：

```sh
pnpm --dir packages/plugin pack --pack-destination ../..
pnpm exec dsh plugin --profile stash-dev add ./wahhheee-dsh-stash-0.1.0.tgz
```

尚未发布 npm 包。唯一分发包为 @wahhheee/dsh-stash；core 和 devtools 均为私有工作区包。

## 配置与诊断

| 配置               | 默认            | 含义                                              |
| ------------------ | --------------- | ------------------------------------------------- |
| trace              | off             | off / metadata / content                          |
| traceRetentionDays | 7               | 保留 1–365 个 UTC 日历日                          |
| memoryRoot         | DSH_HOME/memory | 诊断数据根目录；支持绝对、相对 DSH_HOME 和 ~ 路径 |

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
- [目标设计](docs/roadmap-design.md)、[阶段规划](docs/roadmap-plan.md)仅描述规划；[决策记录](docs/decisions/0001-phase-one-host-contracts.md)记录实际差异。

stash 不注册模型提示、工具或注入钩子。请求一致性测试在固定宿主配置下比较完整请求；宿主默认上传的插件清单和随机会话日志会变化，详见工程设计。

MIT License。
