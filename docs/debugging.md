# stash 调试手册

## 开发验证

Node.js 22.18+、pnpm 12.18.0。执行 pnpm install --frozen-lockfile，再运行 pnpm check。检查顺序是格式、lint、构建、类型、单元/宿主/客户端和真实进程端到端。仅构建产物位于 packages/plugin/lib；根 README 和 LICENSE 随构建复制，不提交生成文件。

普通测试只使用本地 mock，每个测试使用临时 DSH_HOME、DSH_AGENTS_HOME 和独立工作区，不读取日常 profile 或凭据。链接开发循环为修改、pnpm build、重启专用 profile、刷新页面。Desktop 安装使用插件管理器，不通过 CLI 修改保留的 desktop profile。

## 命令

Web/Desktop 输入框支持：

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

status 展示版本、工作区、记忆目录与预算；context 比较可见状态和当前状态；render 输出现在完整注入的文本；explain 给出当前实例最近的决策、位置、原因及哈希。命令不产生模型消息。

锁定 SDK 只识别内置命令，/stash 会进入模型对话，不应传入 SDK run。自动化的人类命令使用 Web Gateway commands/execute；SDK 验收通过捕获本地 mock 请求验证工具与记忆。SDK 的 /compact 是宿主内置命令，可用于压缩恢复验收。

## 磁盘与故障

memoryRoot/<WorkspaceId>/ 包含 workspace.json、RULES.md、notes/、.journal.jsonl 和 .decisions-<SessionId>.jsonl。先通过 status 确定目标工作区。不要手工改日志或版本字段。

普通文件与目录链接、损坏 YAML、未知版本、损坏日志链、规则超预算或常见凭据会明确失败。请求前按文件清单、mtime 与大小发现外部编辑；有变化才读取正文和计算哈希。保持相同时间与大小的手改可能暂时漏检，可用显式 memory_view 读取目标或重启专用实例重新建缓存。写前目标文件版本校验、doctor 与离线检查不依赖这个缓存。只保留实际观察到的版本，无法重建扫描之间的编辑器中间版本。

.lock 可能是活动写入，也可能来自中断进程。遇到 STASH_LOCKED，先重试并运行 doctor；只有确认访问该目录的所有 DSH 进程都已停止后，才人工移除该工作区的 .lock。保留 .pending.json，让下次请求完成恢复。若 pending 与当前文件同时被外部修改，停止恢复并报冲突，应先备份目录再人工核对，不强行覆盖。

.journal.jsonl 每次只追加新记录。中断留下半条 JSON 时，只有存在匹配 pending 且完整前缀有效才允许恢复；没有 pending 或日志中间损坏会明确失败，不自动丢弃数据。pending 的操作已经记录时不重复追加。doctor、verify、journal 和 reconcile 不修复文件，需由正常宿主访问执行恢复。

单文件上限 32 MiB；修改日志和决策记录当前不自动清理，接近上限时应备份并安排后续维护。追加容量在替换记忆文件前检查。文件系统故障不报告写入成功。该事务处理进程中断，不承诺网络文件系统与突然断电的完整一致性。

## 离线工具

```sh
pnpm devtools verify /path/to/memory
pnpm devtools verify /path/to/report.json.gz
pnpm devtools render /path/to/memory/WORKSPACE_ID
pnpm devtools view /path/to/memory/WORKSPACE_ID /RULES.md
pnpm devtools view /path/to/memory/WORKSPACE_ID ./log/turns /path/to/DSH_HOME/sessions SESSION_ID
pnpm devtools view /path/to/memory/WORKSPACE_ID /sessions /path/to/DSH_HOME/sessions SESSION_ID '{"query":"架构","all":true}'
pnpm devtools journal /path/to/memory/WORKSPACE_ID
pnpm devtools reconcile /path/to/memory/WORKSPACE_ID /path/to/DSH_HOME/sessions SESSION_ID
pnpm devtools fold /path/to/DSH_HOME/sessions SESSION_ID
pnpm devtools view /path/to/memory/WORKSPACE_ID ./RULES.md /path/to/DSH_HOME/sessions SESSION_ID
```

以上命令只读。render 使用默认 1600 token 索引预算；自定义配置下应使用宿主 /stash render 查看精确文本。离线 view 完整输出文件，不给在线工具签发读取凭据。journal 和 fold 包含记忆全文，请只在合适的位置查看。

历史 view 使用同一渲染器，自动续读所有页面。离线会话清单仅按工作区最后已知路径与 cwd 精确匹配，工作区改名后用完整引用读取。STASH_SCOPE_REQUIRED 表示应指定会话或时间窗；STASH_AMBIGUOUS_REF 要求更长 ID；STASH_HISTORY_UNREADABLE 和 STASH_SEARCH_FAILED 表示读取失败，与 no-match 不同。续读 STASH_STALE_READ 时从第一页重新开始。

阶段三扫描基准：pnpm exec tsx packages/devtools/src/benchmark-history.ts [输出目录]。默认写入 .exclude/history-benchmark，生成独立测试日志，不使用日常 DSH_HOME。测量范围和限制见 0004 决策记录。

reconcile 使用宿主 persistence 的 read 句柄和 Session surface 投影，按决策记录引用的修改日志 ID 重建当时的实际记忆，再核对决策与实际消息。需要同时保留会话日志、工作区修改日志和决策记录；不靠当前文件或时间戳猜测历史。输出区分 OK 和没有发出模型请求的尝试，缺失材料明确失败。

verify 检查版本、哈希链、文件与日志的一致性、锁、pending 和 trace。尚未观察到的外部编辑会暂时报不一致，宿主发现并记录后可消除；同时间同大小修改须先显式读取或重建缓存。成功退出 0，检查失败 1，参数错误 2。未知 workspace 格式不覆盖。

正常 memory_write 成功结果只显示路径、预算和 replace 删除的行。若请求与写入之间出现外部规则变化，下一请求可以补发包含自身修改的差异；这是保守确认，不代表写入重复执行。新引入规则引用、嵌套调用也可能补发。排查时使用 context 和 explain 比较可见状态；reconcile 同时支持缺少 trusted 字段的旧记录和新记录。

## 会话记忆故障

会话记忆的正本是 DSH 原始日志，memoryRoot 内没有对应会话 Markdown。fold 逐条列出提交、seq 和折叠后状态；会话日志读取失败、未知提交版本、哈希错误和断链均退出 1。投影缓存不是备份，删除后可以重建，但不要删除会话日志来清理缓存。/stash context 和 render 包含会话层与父规则。

PTC 的会话写入在外层 run_code 结算时由 deferContext 留下通知。多个嵌套调用共享临时状态，最终是否持久化以 fold 输出为准。中断后先检查日志再重试。分叉读取的是切点前提交；原会话之后的变化不会同步。位置通知不确认尚未显示的工作区修改。

会话路径的完整读取资格绑定当前 agent；重启、内容变化或续读参数变化后须重新读取。../<id>/ 仅只读，跨工作区使用完整引用。子代理被拒绝写入时检查 subagentWrite，默认 false。其父会话规则来自父日志；离线 reconcile 缺少父日志时明确失败。

## trace 与报告

trace 默认 off；metadata 只记录白名单元数据，content 允许正文。/stash trace 只改变当前实例，持久配置由插件设置管理。文件按 UTC 日写入 .trace/，按 traceRetentionDays 清理，常见 sk- 和 Bearer 凭据脱敏。

决策记录独立于 trace，始终只包含位置、版本 ID、配置、原因和哈希，没有正文。它用于重放，当前没有自动保留期限。该文件仍完整校验并整体原子替换；追加与 pending 恢复只用于修改日志。长会话的决策记录仍有随历史增长的读写成本。

报告在 .reports/stash-UUID.json.gz，format: 1，包含版本、生效配置、doctor 结果与至多 200 条 trace 元数据。始终剥离正文，不自动附记忆、决策记录或会话日志；文件读取和解压上限各 8 MiB。不要直接对外发送含全文的 journal。

## 行为评估

packages/devtools/src/evaluation.ts 导出四个阶段二任务及 evaluateBehavior。运行器提供隔离会话执行、每次任务的 token/延迟、人工或外部判定的 passed、scopeExpanded、openedBody 和 evidence；框架支持重复执行并汇总遵守率、条件扩大率与索引直接成功率。普通测试只验证框架统计，未运行真实模型评估，也不把 mock 的成功当成真实行为成绩。

## 验证范围

本地 Windows 覆盖核心解析、预算、模板、缓存命中与失效、追加日志残片恢复、两个独立 Node 进程并发、Cordis 生命周期、客户端、真实 SDK、多会话共享、简短写入确认、请求期间的外部编辑与补发、重启、/compact 恢复、离线 reconcile、Web Gateway 和 tarball 安装。Linux/macOS 结果以 CI 为准。阶段四包含标准/PTC 多次嵌套读写、分叉前缀、缓存删除重建、子代理策略、提升和跨会话只读验收。阶段二未执行 Desktop 人工视觉检查；阶段一的隔离 Desktop 安装记录见 0001 决策记录。
