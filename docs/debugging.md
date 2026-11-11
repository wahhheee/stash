# stash 调试手册

## 一次完整验证

```sh
pnpm install --frozen-lockfile
pnpm check
```

构建位于 packages/plugin/lib，打包同时复制根 README 和 LICENSE。它们是生成文件，不提交。check 先构建后做类型与宿主测试，适用于全新检出。

分别运行时：pnpm build、pnpm typecheck、pnpm lint、pnpm test、pnpm test:e2e。修改格式用 pnpm format。

测试使用临时 DSH_HOME、DSH_AGENTS_HOME 和工作区，仅继承启动所需的系统环境变量。模型只连本地 mock，凭据是占位值。SDK 的进程、Web 服务和临时目录由夹具关闭；不要把真实凭据加入夹具。

## 安装与开发循环

Web 的初始化、安装命令见 README。先用 --dump-config 确认 stash 包和配置；遇到加载故障先检查 lib/index.js、lib/client.js 是否存在。

链接安装后：修改源码 → pnpm build → 停止并重新运行该 profile → 刷新页面。SDK 关闭 HMR；Web 默认只监视配置，代码监听需额外配置。基线不依赖外部包源码热重载。真实 Cordis 测试覆盖插件卸载、命令移除和再次挂载。

Desktop 通过插件管理器的“添加插件”输入绝对目录，可选大陆镜像源，安装后点“立即启用”。CLI 拒绝修改保留名称 desktop；不要手工更改用户的桌面 profile。独立验证时，启动进程设置临时 DSH_HOME、DSH_AGENTS_HOME 与 Electron --user-data-dir，确保与日常安装的数据隔离。

插件安装是单条双面记录，客户端由 dsh.client 自动装载。看不到侧栏时依次检查插件已启用、客户端加载错误、Remote 连接。浏览器产物必须是宿主模块工厂，不可直接输出 ESM；bundle.test.ts 会执行产物验证该契约。

## 人类命令与 Web 自动化

在 Web/Desktop 会话输入框直接输入 /stash status、/stash doctor、/stash doctor --bundle。命令通过宿主 commands 执行，只增加 command/run、command/done 事件，不产生模型消息。

SDK 0.2.2-rc.1 只识别内置命令，/stash 会进入模型对话。测试采用计划中的退路：宿主测试直接调用 ctx.commands.execute；端到端通过已认证的 Web Gateway 调用 commands/execute。e2e/web.test.ts 包含本地 token 换取会话 cookie、session/create、commands/execute、报告读取与 CLI verify 的完整示例。token 与 cookie 仅在内存中，不存入仓库。

## trace、报告与故障

trace 默认关闭。/stash trace metadata 开启当前插件实例的元数据记录；content 允许正文，off 停止新记录。命令不写配置文件；持久设置在插件配置中修改。重载后采用配置值。

记录按 UTC 日写入 memoryRoot/.trace/YYYY-MM-DD.jsonl，单实例顺序追加，每天首次写入清理超期普通文件。metadata 使用字段白名单，常见 sk- 密钥和 Bearer 凭据脱敏；这不是任意正文的通用隐私过滤器。当前阶段没有会话正文收集。

写盘失败不会伪装成功；宿主日志和用户错误包含调用 ID，trace 可写时也记录该 ID。flush 保留写入故障，修复权限后应重启插件。日志命名空间为 stash。

doctor 检查支持版本、根目录读写删除权限、trace 格式与版本。尚无记忆文件修改日志、锁、重定向表或投影缓存，因此这些检查留到对应阶段。

--bundle 生成 memoryRoot/.reports/stash-UUID.json.gz。format: 1 包含版本、生效配置、检查结果、最近七个 trace 文件中的至多 200 条元数据；任何 trace 正文都剥离，不附环境变量或会话日志。读文件与解压各限制 8 MiB；未来版本、损坏 JSON、非普通文件明确失败。超限 trace 保留在原位置并报告错误，不自动截断。

```sh
pnpm devtools verify /path/to/memory
pnpm devtools verify /path/to/report.json.gz
```

verify 默认只读。目录不存在返回未初始化；有失败检查或格式错误退出码 1；参数错误 2；全部通过 0。报告校验反映采样时的状态，不代表当前磁盘状态。

## 宿主契约与 CI

锁定 DSH 0.2.2-rc.1。真实宿主契约覆盖 commands、严格 Remote 参数校验、插件卸载重载，以及 agent 作用域提示和工具隔离。分叉、压缩、工具 meta、pre-step 的完整契约将随阶段二至四首次使用时加入；本阶段没有依赖这些行为的生产代码。

SDK 请求对照显式关闭 time-context、agent-instructions、plugin-package-inventory-deepseek 和 session-log-deepseek。相同配置、相同输入、安装前后捕获完整 JSON 请求并比较序列化字节。前两项隔离时间和机器目录；后两项避免宿主插件清单、随机日志 ID 的自然差异。插件不修改生产 profile 的这些设置。

每次 push/PR：Linux 全部检查；Windows 单元、集成、客户端、链接和 tarball 冒烟。夜间/手动：Windows 全量、macOS 安装冒烟、DSH next 通道兼容检查。next 失败记录 warning，不阻止锁定版本交付。CI 覆盖官方 npm 源，国内开发默认 npmmirror；普通流程无 API secret。

## 阶段一实测记录

2026-11-11，Windows，DSH 0.2.2-rc.1：

- Web：全新 profile 本地链接；浏览器 stash 页显示 0.1.0、宿主 0.2.2-rc.1 和已连接。
- Desktop：独立 DSH_HOME 与 Electron 数据目录；插件管理器安装本地目录、启用，stash 页显示相同版本及已连接。
- SDK：本地 mock 对话、安装前后完整请求一致；新 profile tarball 安装后可完成 mock 对话。
- Web Gateway：status、doctor --bundle 成功；导出的报告通过离线 CLI verify。
- 测试没有使用真实 DeepSeek 密钥。

平台 CI 的执行结果以对应提交的 GitHub Actions 为准，本地记录不替代 Linux/macOS 验收。
