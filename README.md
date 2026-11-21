# stash

DSH 工作区记忆插件。当前版本 0.7.0（未发布）提供工作区与会话规则、笔记读写和分叉继承、常驻上下文、压缩前补记与压缩后恢复、原始记录检索、引用复制、三级开关、记忆编辑页、增长指标、工作区整理与回滚、离线重放。

## 第一次用 stash

不用先做笔记。在 DSH 当前工作区里，试着说「以后发给志愿者的通知，用“小灯提醒：”开头」。开一个新聊天，只说「帮我写一条周六八点集合的志愿者通知」。想知道模型记了什么，打开右侧 **stash → 工作区 → 规则**；只想在这一次排练使用的称呼，就说「仅限本次排练」。

问「上次雨天在哪里集合，为什么？」时，可以接一句「给我原话的聊天引用」来核对。模型可能把摘要看错，或者把没写的细节当作事实；重要安排请核对正文或原话。在记忆页可以手工更正；不希望模型再改内容，就到设置关闭「允许模型写入」。这不会删掉旧聊天，也不是保密开关。

## Quick Start (English)

In DSH Desktop, add the local plugin folder under **Plugins**, enable it and open **stash** in the right sidebar. In a workspace chat, try “Start volunteer notices with ‘Team update:’ from now on.” Open a new chat **in the same workspace** and ask for a volunteer notice without repeating the preference. Say “only for this rehearsal” for a session-only exception. You do not need to pick a file or write Markdown.

Use **Workspace → Rules** for standing instructions and **Notes** for supporting details. Ask for a link to the original conversation to check an answer. If two people edit the same note, refresh and compare before saving; stash does not silently overwrite a changed version. To keep the model from editing, turn off model writes in settings. You can still edit the notes yourself. Hiding a chat from search or clearing its notes does not erase its history; do not store passwords or API keys here. For cleanup, use **Workspace → Maintenance** and review the proposed changes before applying them.

## 开发

需要 Node.js 22.18+、pnpm 12.18.0，宿主锁定为 DeepSeek Harness 0.2.2-rc.5。

```sh
pnpm install --frozen-lockfile
pnpm check
```

check 依次执行格式、lint、构建、类型、单元/宿主/客户端和真实进程端到端检查。普通测试只使用本地 mock，不需要 API key，也不读取日常 DSH profile。

仓库默认使用 npmmirror，CI 使用 npm 官方源。可用 npm_config_registry 环境变量覆盖。凭据不要写入源码、配置样例或命令历史。

## 安装与使用

### 在 DSH Desktop 中安装离线包

1. 把 `wahhheee-dsh-stash-0.7.0.tgz` 解压到准备长期保留的位置。
2. 在「插件 → 添加插件」中输入解压后 `package` 文件夹的绝对路径。选中的文件夹里应能直接看到 `package.json`、`lib` 和 `node_modules`。
3. 启用 stash，然后从会话右侧栏打开它。DSH 会从这个目录加载插件，请保留整个文件夹。

离线包已包含 stash 的运行依赖。使用源码开发时，也可以在构建后直接添加本仓库的 `packages/plugin` 目录。

### 从源码构建和打包

按上方「开发」安装依赖后，在仓库根目录执行：

```sh
pnpm build
pnpm --dir packages/plugin pack --pack-destination ../..
```

仓库根目录生成的 `.tgz` 就是可分发的离线包。

### 在 Web profile 中使用

要在本机试用开发版本，创建专用 Web profile 并链接构建好的插件目录：

```sh
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

已有 Web profile 时，也可以直接安装离线包：

```sh
pnpm exec dsh plugin --profile stash-dev add ./wahhheee-dsh-stash-0.7.0.tgz
```

尚未发布 npm 包。唯一分发包为 @wahhheee/dsh-stash；core 和 devtools 均为私有工作区包。

## 开关与记忆页

右侧栏选择 stash，默认打开本会话的笔记列表。顶部选择“本会话”或“工作区”，这个范围同时作用于下方的笔记、规则和设置。工作区右键菜单的“stash 设置”直接打开该工作区的设置；输入框工具行的 stash 菜单提供本会话四项快捷设置及记忆页入口。

- 笔记列表按目录分组并显示数量，点击笔记阅读全文，点击“编辑”修改。新建先进入表单，点击“创建笔记”才保存；创建后直接展示内容，返回列表可再次打开。
- 表单填写类型、索引描述、正文和可选来源，选择是否纳入索引及归档状态，系统生成 YAML 元信息。自定义类型、状态、额外元信息和复杂来源会保留。
- 索引描述用一行结合主题或用途与最重要的事实、结论或经验，尽量避免重复。例如“记忆页的权限说明 — 只读开关限制模型写入，用户仍可在记忆页编辑规则和笔记。”分隔方式不参与解析。
- 保存位置可选择已有目录、新建子目录并填写文件名，也可直接输入当前范围的记忆路径。自动补全 .md，新建目录随笔记保存；已有笔记的位置只读。会话笔记的“更多操作”可创建工作区副本并附上原笔记引用。
- 设置修改后立即保存；规则使用“保存规则”，已有笔记使用“保存修改”。来源可复制，完整会话引用可打开对应会话，HTTP(S) 链接可打开原资料；正文另支持 Markdown 链接和摘录。

- 全局 enabled 在宿主插件设置中修改，宿主重载后生效；关闭时下级开关禁用。
- 工作区与会话的记忆开关、允许模型写入采用三态；全局关闭优先，其余按最近明确设置。
- 关闭“继承工作区记忆”进入干净模式，只加载本会话记忆；用户明确要求时仍可查工作区与历史。
- 关闭“其他会话可检索本会话”后，普通清单与搜索隐藏它；完整引用仍可读取。这不是访问控制或历史擦除。

首请求前切换开关不产生模型通知。会话中途关闭保留当前 agent 已展示的声明并拒绝工具，下一请求告知模型旧快照不再适用；重新打开恢复完整快照。

只读限制模型，不限制用户在页面编辑。保存校验加载时的版本；冲突时可对照最新内容，再选择放弃草稿或保留草稿继续编辑。断线或会话忙碌时保留草稿，保存成功后的刷新失败单独提示。页内切换提供保存、放弃和继续编辑；切换宿主会话或重新打开侧栏时，未保存草稿在当前插件实例内保留，重载插件或刷新浏览器后不保留。空白会话可编辑工作区与开关，首次请求后开放会话记忆编辑，原因见[阶段五决策](docs/decisions/0005-switches-memory-page.md)。

清空本会话记忆和删除工作区记忆均需二次确认。只删除当前规则和笔记，保留原始会话、已有分叉、设置及修改历史；不擦除历史副本。工作区批量删除发生故障时可能部分完成，刷新后可继续。

## 增长与整理

- 在记忆页选择 **工作区 → 整理**。命令 `/stash health` 可查看指标。健康指标是提示，不会自动归档、删除或调用模型。`unreadDays` 默认 90 天；核实提交与 HEAD 不同不等于结论过时。
- 启动后，模型先读取独立的 Markdown 副本，可以边改边读、查看相对基线的累计差异。编辑不会写入正式记忆或项目文件。模型必须明确提交最终副本；没有改动时只标记「无需更改」。
- 默认 **审阅后应用**：同一会话只有一条记录。不满意就回到该会话说「再改」，不用归档；第一次有效修改后旧版不能应用。模型再次提交后，可看最终差异、逐项或全选规则变更，再点 **确认并应用计划**。
- 选择 **自动应用** 并点击 **启动并自动应用**，授权 stash 在本次整理中直接应用通过校验的计划（含规则），不必返回审阅。不需要开启普通会话的「允许模型写入」，也不会改变该开关；不会修改项目文件、执行 Git 提交或改变 DSH 权限。下次新建仍默认审阅。
- 不打算继续时，可直接归档整理会话，或在记录上选 **放弃整理 → 确认归档**。未应用的记录随即移出列表，取消归档可找回。已经应用的整理保留记录及回滚入口。
- 合并与移动保留旧路径跳转；读旧路径不会获得新路径的写权限。拆分保留原路径和来源；归档保留文件并退出索引。
- 可在同一页面回滚，或运行 `/stash rollback <整理会话 ID>`。若该组改过的路径有后续修改，会拒绝整组回滚，不覆盖人工编辑。回滚恢复文件及跳转，不删除会话记录或修改历史。

## 工作区记忆

插件默认开启记忆。全局 enabled 是硬总闸；工作区与会话可选择跟随上级、开或关，会话优先。新会话首次请求注入规则和笔记索引；普通自身写入由简短工具结果确认，不重复发送完整规则。其他会话或编辑器改动在下一请求以增量通知生效；请求与写入交错时允许保守补发包含自身修改的差异。新引入的规则引用和嵌套调用也按保守补发处理。压缩后重新注入最新完整快照。

请求前检查文件清单、mtime 与大小，仅变化文件重新读取和哈希；同时间同大小的外部修改可能暂时漏检。显式读取、写前目标版本校验和离线检查读取真实内容。子 Agent 默认只读，可通过 subagentWrite 配置放开；多个会话基于同一旧版本修改时，冲突者需重新读取，不自动合并。

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

## 会话记忆与分支

./RULES.md 和 ./notes/ 只属于当前会话及之后从它分叉的会话。会话记忆保存在原始会话日志中；压缩和重启后从日志重建。分叉只继承切点前的提交，之后双方独立演进。工作区和会话规则及索引分别使用配置中的预算。

memory_view ../<会话 ID>/RULES.md 或 ../<会话 ID>/notes/ 只读参考另一会话，不把对方规则加入本会话。/sessions 显示规则行数和笔记数，搜索也覆盖当前会话笔记。跨工作区读取使用 dsh://session/<完整 ID>/notes/<文件>.md。

只在本会话或分支成立的内容写到 ./notes/；可复用经验写到 /notes/。提升笔记时先读取原文，再在 /notes/ 新建副本，frontmatter 的 sources 指回原会话完整引用，原笔记保留。记忆页支持直接编辑与提升副本；提升会自动在 sources 中保留原笔记引用。

标准执行与 PTC 嵌套工具均支持会话记忆。子代理常驻上下文包含父会话当前规则，默认拒绝写入；开启 subagentWrite 后可写工作区及自己的会话。

### 可选：在压缩时补记结论

在 **DSH 设置 → stash → 压缩对话时补记笔记** 开启后，模型可以在 DSH 生成摘要前把有用的结论补记到 stash，无需你审核。这是当前 DSH profile 的全局开关，默认关闭。如果你不知道这有什么用，请保持关闭。更改对所有工作区和已有会话的下一次压缩生效，无需重启。关闭不会删除已有笔记。

此功能适用于 DSH 原装压缩器，沿用其模型、输出上限、阈值和保留策略。

手动 `/compact` 和自动压缩采用相同流程。模型可以在副本中查看、修改和复核与这次对话有关的记忆，提交后自动应用。无须通读或整理整个记忆库。对其他会话也有用的结论进工作区，仅对当前会话有用的成果进会话层。例如「已核对两张底单，排除了抄录差错」可以补记；「下一步询问当班人」留给 DSH 摘要交接。

无需补记时仅跳过记忆操作。无论有没有改动，DSH 都用原始对话生成自己的摘要；整理工具的对话不进入摘要输入。开启后会增加模型调用。只读时跳过补记；副本未提交或整理失败不会拦住摘要。已提交的笔记不因 DSH 拒绝过长的摘要而撤销。

## 原始记录与引用

向模型提供历史线索或粘贴引用，可通过 memory_view 查找原文：

```json
{"path":"/sessions","since":"2026-11-14T18:00:00-07:00","until":"2026-11-15T00:00:00-07:00"}
{"path":"/sessions/<完整或唯一短ID>/log/turns"}
{"path":"./log/summaries"}
{"path":"./log","query":"架构"}
{"path":"dsh://session/<完整ID>/10..30","detail":"full"}
```

事件窗口包含已压缩原文。单个事件引用自动展开所属轮次；范围引用严格保留边界。搜索支持中文子串、忽略大小写和宽松空白，工作区全量搜索需明确传 all: true；结果显示扫描范围和分叉去重信息。历史结果是参考材料，不自动成为规则。

每轮助手回复的操作栏提供“复制引用”；会话菜单提供“复制会话引用”。复制内容为 Markdown 链接。工具也接受现有 dsh-session: URI。普通路径仅访问当前工作区；完整引用可只读访问其他工作区。分页保持同一组参数并使用返回的 cursor。

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

记忆按 DSH 工作区共享。可以对模型说“以后提交信息用简体中文”，由 memory_write 保存到 /RULES.md。笔记位于 /notes/，可用 memory_view 阅读。完整读取后才能覆盖或删除；工具写入和已观察到的外部编辑都有修改历史。整理执行与回滚同样保留修改历史。

MIT License。
