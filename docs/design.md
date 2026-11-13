# stash 0.2.0 工程设计

stash 是 DSH 外部插件，提供工作区规则与笔记、常驻上下文、状态面板、诊断和离线重放。会话记忆、原始历史查询、开关界面和整理回滚尚未实现。长期设计见 [目标设计](roadmap-design.md)。

## 分层

core 包含宿主无关端口、工作区路径校验、YAML frontmatter、规则展开、索引折叠、可见状态折叠和全部模型模板。YAML 解析使用 yaml；未知字段和类型保留。plugin/adapters 负责宿主协议、配置、文件系统和持久格式；host 编排读写与固定开关策略；client 提供状态面板。devtools 提供离线只读检查、重放与测试夹具。只有 plugin 发布，core 和 yaml 内联进产物。

## 工作区存储

工作区以 DSH WorkspaceId 标识，在 memoryRoot/<WorkspaceId>/ 保存 workspace.json、RULES.md、notes/**/*.md、.journal.jsonl。workspace.json 的 format 为 1，记录 ID、最后已知路径和标题。工作区通过宿主注册表中的会话归属或 cwd 解析；不存在时注册该 cwd。没有 cwd 的会话明确失败。

每次请求扫描内容并计算 SHA-256，记录工具写入和已观察到的外部修改。每条日志 v: 1，包含 ID、时间、工作区、路径、操作、会话与调用 ID、修改前后全文和哈希。未知版本、损坏链和未知 workspace 格式拒绝处理。尚未被扫描观察到的外部中间版本不保证保留。

工作区 .lock 采用排他创建，等待上限 5 秒。临界区覆盖扫描、规则预算、哈希比较、文件替换和日志提交。写入先落 .pending.json，再用临时文件加 rename 替换记忆和日志，最后删除 pending；pending 在下次请求恢复。日志逻辑上只追加，物理上整体原子替换，避免半条 JSONL。文件先 sync，再 rename。残留锁不会自动抢占，需确认进程已停止后人工清理；本地文件系统是当前支持场景，不声称网络文件系统或断电下的完整事务保证。

路径拒绝父目录、反斜杠、百分号、控制字符、Windows 保留名和大小写冲突。目录链接与非普通记忆文件拒绝读取，单文件上限 32 MiB。读取不持有工作区锁；插件间写入有锁，外部编辑器不遵守该锁。

## 规则与笔记

/RULES.md 的正文作为规则；注入时去掉 src 来源注释，文件读取保留。独立成行的 @notes/name.md 并入笔记正文，只展开一层。规则 frontmatter 含 paths 时拒绝。规则预算含全部展开内容；工具写入或外部规则超预算时明确失败，不截断。

笔记 frontmatter 必须包含单行 type 和 description；index: false、status: archived 退出索引。archive 保留未知字段但会重排 YAML 格式。description 写单一结论及其条件；这是提示指导，不做不可靠的自然语言自动判定。

索引按路径稳定排序，超预算依次折叠篇数最多的子目录、根目录笔记类型、剩余目录。折叠目录使用 README.md 的描述；最终保留展开入口与省略组数。

memory_view 支持 /、/RULES.md、/notes/ 及子目录、笔记文件、/.guide.md。长结果按预算分页，cursor 绑定当前 agent、路径、内容哈希与连续读取进度。完整读取后才获得 edit、replace、archive、delete 的修改资格。工具写入不自动授予下次覆盖资格。

memory_write 支持 create、append、edit、replace、archive、delete。create 要求不存在；append 在锁内追加且要求文件存在；edit 要求旧文本唯一；replace 返回被删除的行。规则不可 archive/delete，清空须读取后 replace。子代理只读。常见 API key、Bearer、GitHub token、AWS access key 和私钥头拒绝存储；外部扫描在写入日志前检查，不把匹配正文放入错误。此检查不替代用户的隐私判断。

## 常驻上下文

静态说明和两个工具按 agent 作用域注册，与具体工作区和会话无关。agent/pre-step 在宿主放行请求后读取当前记忆，按 session.surface 的可见顺序折叠完整快照、规则增量与仍可见的成功写入结果。来源类型 stash-memory，元数据 stash.v 为 1，存储所表达的结构化状态。

没有完整快照时注入完整上下文；规则一致时不注入；仅索引变化延后；外部规则变化按连续行差异追加通知；通知超过规则预算一半时改用完整快照。工具成功结果含当前完整有效规则及隐藏状态，保证被确认的规则确实对模型可见；原生调用使用结果 meta，嵌套调用同时使用 deferContext。

压缩删除快照后，最新完整快照重新进入上下文，包含宿主 checkpoint 的源事件范围。范围行不声称可以通过尚未提供的历史工具读取原文。记忆中的尖括号在注入时转义，避免提前闭合模板。

开关由 host/policy 统一提供固定开启策略，界面没有开关。externalRuleUpdates 可选择下次请求或下次完整恢复时生效。无独立私有“已发送”缓存作为事实来源。

## 配置

| 配置                | 默认            | 说明                           |
| ------------------- | --------------- | ------------------------------ |
| memoryRoot          | DSH_HOME/memory | 绝对路径、相对 DSH_HOME 或 ~   |
| rulesBudgetTokens   | 1600            | 128–32000，展开后的规则预算    |
| indexBudgetTokens   | 1600            | 128–32000，索引预算            |
| viewBudgetTokens    | 4000            | 256–64000，单次读取预算        |
| externalRuleUpdates | next-request    | next-request / next-compaction |
| trace               | off             | off / metadata / content       |
| traceRetentionDays  | 7               | 1–365 个 UTC 日历日            |

配置经 Schemastery 校验，变更由宿主重载生效。预算通过 ctx.tokenMeter.estimateMessage 扣除固定消息包装估算；锁定 DSH 的算法为每 4 个 UTF-16 码元约 1 token，并非模型精确分词。devtools 使用同一算法；离线 render 的预算使用默认值。

## 诊断与重放

/stash status 显示版本、记忆目录、预算与固定开关；context 比较可见与实际版本；render 输出现在完整注入的文本；explain [1–100] 显示当前实例最近的决策及哈希。doctor 检查权限、格式、修改链、文件一致性、锁和待提交记录。

每个工作区保存 .decisions-<SessionId>.jsonl，每行 v: 1，仅包含请求前日志位置、修改日志版本 ID、配置、决策、正文哈希和压缩范围，没有正文。它独立于可关闭的 trace，用于精确离线重放；当前不自动清理。reconcile 用 DSH persistence 的 read 句柄读取日志，以 Session 重建各请求前的 surface，并从修改日志版本重建实际记忆，比较决策和实际注入文本。未发出模型请求的尝试单独标注。重放需要完整会话日志、工作区修改日志与决策记录。

trace 按 UTC 日轮转；报告为 format: 1 gzip JSON，兼容阶段一报告，只包含检查结果、生效配置和 trace 元数据，不附记忆或会话正文。宿主版本保持 0.2.2-rc.1，范围 >=0.2.2-rc.1 <0.3.0-0。
