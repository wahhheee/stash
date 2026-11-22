# 阶段一宿主契约与工程取舍

日期：2026-11-11。参照源码 fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159，实测 npm 0.2.2-rc.1。

1. **Remote 元数据。** WorkspaceTypertGenerator 在外部仓库报告“publishes Remote artifacts but has no Remote methods”。analyzer.isTypeMetaSymbol 只识别工作区注册或 ambient module 的声明，npm 声明不满足条件。使用公开 TypertRemoteSpec 与 createTypertRemoteInfo 定义共享契约，保留官方 decoratorPlugin 编译装饰器。真实 Gateway 验证参数拒绝、结果与卸载，无需修改宿主。
2. **SDK 命令。** SDK queryCommand 只识别 compact、permission、plan、goal 的内置身份。/stash 会作为模型提示。因此诊断使用 commands.execute 与 Web 协议，SDK 只驱动对话。
3. **请求一致性。** dsh_session_log 和 dsh_plugin_packages 随会话与安装清单变化。确定性对照显式关闭这两项以及时间和指导文件注入，再比较完整请求。生产插件不改变这些宿主设置。
4. **客户端格式。** 浏览器实测 ESM 产物导致“Cannot use import statement outside a module”。DSH 需要 classic script 的模块工厂；构建按其契约封装 CommonJS，React 使用宿主模块表。
5. **双面行。** dsh.client 让同一包进入浏览器清单，无需重复插入客户端行。
6. **热重载。** SDK 关闭 HMR，Web 默认仅监视配置，Host 模块目录须另配。因此基线是重建、重启 profile、刷新页面。Cordis 卸载重载已测试，不承诺任意外部源码热更新。
7. **报告。** 单份结构化报告采用 gzip JSON，避免归档解包路径问题；当前不附会话日志。后续多文件报告再引入版本化归档。

8. **桌面安装。** CLI 明确拒绝修改 desktop profile。实测通过 Desktop 插件管理器安装绝对目录并启用，侧栏成功连接；开发手册分别说明 Web 与 Desktop 入口。
9. **CI 与依赖。** pnpm 12 在 Windows、Linux、macOS 均可采用原生可执行入口，夹具只把 .js/.cjs/.mjs 入口交给 Node。Zod 与宿主使用相同的 ^4.4.3 范围，锁文件固定基线；next 巡检同步更新共享 schema 依赖，避免同一工作区新旧 Zod 声明冲突。
