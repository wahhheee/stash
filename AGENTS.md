# stash 开发约定

当前版本是阶段二，提供工作区规则与笔记读写、常驻上下文和离线重放；不提供会话记忆与历史检索。产品现状见 docs/design.md，长期目标见 docs/roadmap-design.md。

## 架构

- packages/core：纯 TypeScript 领域契约、模板、trace 类型与内存测试端口，不依赖 Node、DSH、plugin 或 devtools。
- packages/plugin/src/adapters：文件系统、诊断、DSH 注册与 Remote 协议边界。
- packages/plugin/src/host：用例编排；客户端不得引入这里。宿主配置 schema 与路径解析归 adapters。
- packages/plugin/src/client：右侧栏界面与本地化。
- packages/devtools：离线 verify 与隔离的真实宿主测试框架。
- e2e：安装、SDK 请求一致性与 Web Gateway 验收。

依赖方向为 plugin → core、devtools → core/plugin。发布物只有 plugin，core 在构建时内联。测试辅助代码不得进入发布入口。

## 开发

Node.js 22.18+、pnpm 12.18.0。pnpm install --frozen-lockfile 安装依赖，pnpm build 构建，pnpm check 运行完整检查。测试依赖构建产物，先构建再执行 pnpm test 或 pnpm test:e2e。pnpm devtools verify <目录或报告包> 只读校验；失败退出码 1，参数错误 2。

TypeScript 严格模式，禁止 any 逃逸。跨边界输入先校验，失败明确返回，不把不可读伪装成空结果。持久格式必须有版本；未知版本拒绝处理，不覆盖。

代码注释使用简体中文。功能文档和注释只描述现状；变更原因放决策记录、CHANGELOG 和提交信息。提交采用 Conventional Commits + 简体中文。提交前运行 pnpm check 并确保全部通过。

模型可见文字统一放 core/src/templates。工具 schema、快照、增量与错误均由模板导出。凭据不入库，不进入日志、夹具、快照或报告。普通测试只连接本地 mock。临时材料放 .exclude；它由 .git/info/exclude 排除，不在 .gitignore 重复配置。测试使用独立临时 DSH_HOME，不修改日常 profile。

DSH 升级须运行宿主契约和端到端测试。宿主接口改动集中在 adapters。发布前检查 tarball，不发布 core/devtools，不自动公开仓库或发布 npm。
