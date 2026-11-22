# DSH 会话观察与预览版本巡检

2026-11-22。对照 `dsh-v0.2.2-rc.5` 与 `dsh-v0.2.3-alpha.1`（`d98f5d6851`）时发现，alpha 移除了 `sessionQuery.inspectSession`。两个版本均提供 `observeSession`，返回同一切点的事件、会话头和继承长度。stash 在有 `inspectSession` 的宿主上读取宿主私有投影，在只有观察租约的宿主上用相同的折叠函数计算轮次与会话记忆。两个分支均在读取结束时释放租约。

npm 的 `next` 在此次检查时仍指向 rc.5，更新的预览版位于 `alpha`。兼容工作流分别解析两个通道中的 DSH 精确版本，并使用对应的 SDK、测试工具与 Typert 依赖运行检查。

使用 npm 发布的 alpha 依赖，stash 构建、类型检查及冷会话读取通过。独立临时 `DSH_HOME` 中执行 `dsh --help` 时，`dsh-app-boot` 在加载插件前就因 `@deepseek-ai/cordis-plugin-loader` 缺少 `EntryValidationError` 导出而退出。该包声明的 loader 范围为 `~1.1.0`，此次锁定结果为 `1.1.0`。因此保留插件原有的宿主支持声明。
