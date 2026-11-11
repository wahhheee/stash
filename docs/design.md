# stash 0.1.0 工程设计

stash 是 DSH 外部插件。当前提供状态面板、诊断命令、trace 和离线检查，没有记忆读写、历史检索或上下文注入。长期设计保存在 [目标设计](roadmap-design.md)，不代表已实现能力。

## 分层与端口

core 只定义宿主无关的数据和端口。plugin 的 adapters 封装外部接口，host 编排诊断用例，client 展示状态。devtools 复用文件格式校验。

端口包括 SessionLogPort、SurfacePort、WorkspacePort、MemoryStore、CommitCarrier、HistorySearch、TokenEstimator、SwitchStore、TraceSink、Clock、IdGen。core/src/testing 提供内存实现，支持版本比较、完整修改记录与读取隔离。真实磁盘 MemoryStore、会话日志与投影等适配器属于后续阶段；没有返回假成功的占位适配器。

后续领域模块按 namespace、refs、rules、notes、index、resident、commits、history、switches 拆分，在实现首个用例时建立源文件。目录划分与接口按实际使用演进。

## 生命周期与构建

一条 cordis.patch.yml 注册双面插件。Host 注入 commands，注册人类命令与只读 stash/getStatus Remote；Client 由 dsh.client 清单自动加载。命令、服务、语言包、侧栏与连接订阅随 Cordis fiber 释放。卸载重载有集成测试。

Host 构建为 ESM，Client 为 window.**ModuleLoader**.load 工厂，React 由宿主模块表提供。客户端不导入 Node 或 Host 实现。Remote 契约供两端共享，结果有严格 schema。

## 配置

| 配置               | 默认            | 语义                                 |
| ------------------ | --------------- | ------------------------------------ |
| trace              | off             | off、metadata、content               |
| traceRetentionDays | 7               | 1–365 整数，以 UTC 日历日计          |
| memoryRoot         | DSH_HOME/memory | 绝对路径或相对 DSH_HOME 路径，支持 ~ |

配置经 Schemastery 校验，配置变更由宿主重载插件生效。/stash trace 是当前实例覆盖，不写宿主配置。

## 数据与诊断

trace 位于 memoryRoot/.trace/YYYY-MM-DD.jsonl，每行 v: 1。单实例排队追加，写入失败向调用方传播并由 flush 报告。清理仅处理日期命名的普通 trace 文件。metadata 只记白名单字段，content 才包含正文；常见密钥形态与 Bearer 凭据脱敏。

doctor 创建、写入、删除唯一临时文件以检查权限，校验宿主版本和 trace 格式。当前没有工作区修改日志、锁、重定向或投影缓存，因此不声称检查这些数据。

报告为 gzip JSON（.json.gz），format: 1，包含版本、插件生效配置、检查结果和至多 200 条最近 trace 元数据。正文始终剥离，不收集环境变量、宿主凭据或会话日志。单文件读取和解压有 8 MiB 上限；未来版本、损坏结构、非普通文件均报错。

## 模型与兼容

插件不注册 systemPrompt、tools 或 agent/pre-step。模型表面为空，模板快照为 0 tokens。真实 SDK 对照测试在两组相同配置中关闭宿主时间提示、仓库指导注入、会话日志上传、插件清单上传，比较完整 JSON 请求的序列化字节，不删差异字段。

默认宿主上传的插件清单和随机会话日志会变化，不能声称默认 HTTP body 完全不变。模型提示、消息与工具不因 stash 发生变化。

锁定 DSH 0.2.2-rc.1，支持范围 >=0.2.2-rc.1 <0.3.0-0。限制和取舍见 [决策记录](decisions/0001-phase-one-host-contracts.md)。测试分纯领域、文件故障、真实 Cordis/Gateway、React 与真实进程端到端；模型调用仅走本地 mock。
