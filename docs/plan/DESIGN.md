# Implementation Plan

## Goal

开发独立的 `dsh-shake` 插件，为 DeepSeek Harness Web UI 提供手动上下文减重：

1. 用户在会话空闲时输入 `/shake`。
2. 插件持久化清理请求，不立即调用模型。
3. 下一次正常模型请求发送前，裁剪符合条件的旧工具文本和助手大块文本。
4. 保留原始会话日志，通过一个受限工具按需取回被移除的文本。

**不修改或 fork Harness，不调用模型生成摘要，不直接改写历史日志文件。**

本文保留源码调研和需求决策；原验收要求及历史阶段说明不等于当时完成。C12 已验证、最终五面审查 clean、门禁完成；当前全部 21 项映射以 `CHECKLIST.md` 为准，未发布 npm。下文历史“未勾选／unchecked／待 review／尚未完成”及未选方案不是当前活动任务。

### C12 已观察的交付边界

永久 bundle patch 显式提供 `config: {}`；省略 config 的最初官方启动失败不是可接受结果。当前 root patch/manifest/ESM/声明/map 与三版本矩阵包和实际官方 Web 安装包字节一致，非临时修复。Node 22.19.0、24.21.0、26.10.0 各八文件86 tests、类型、打包、公开真实会话契约和 packed activation 通过；官方隔离 Web 累计47请求、parent235/fork227行证明自然请求移除4 regions、估算节省15016 token、保护非文本/周边/近期历史。重开持久化日志后 parent 与 seeded fork 均实际调用12页 limit4096、完整回取47167 Unicode points，连续 nextOffset 无缺口/重复，终页 nextOffset:null/done:true，拼接精确等于原持久化region0。8192超出公开最大4096，实际拒绝记录保留，无源代码更改。路径、截图和最终 clean 门禁状态见 CHECKLIST。

官方宿主 busy guard 在插件 callback 前拒绝：Web 证据不证明插件中文 busy 文案。ContextMeter 由官方 replay 合成 usage 样本刺激，不能推断真实供应商计费或实测 savings。持久化日志是多帧 `session.v4.jsonl.zstd`，完整读取用 `zstd -dc`。当时使用的 `.verification/c12-web-evidence.mjs` 仅核验固定捕获日志，现已删除；此处保留历史验收结果，不代表当前代码的自动化 Web 回归测试。后续文档更新不等同重新运行新文档 tgz。

**最终审查闭环**：C12 基线 `d79b08b`；FinalAccounting finding “Complete the original Web pagination acceptance before checking it off” 的实际 Web 完整分页证据缺口由 `515929a` 关闭：parent/fork 各12页精确还原持久化原 region0，verifier 检查实际 provider 结果、连续页及 terminal-null/done。FinalSelection、FinalExecution、FinalRecovery、FinalPackage、FinalAccounting 最终均 clean，Package/Accounting 在修复提交后复审 clean，无剩余 findings。原项目 13/13 实施与 8/8 Validation 共21/21完成；活动未勾选任务精确列表 `[]`，可做未完成0、阻塞0。本次仅文档闭环，不运行 checks/tests/build/format，不创建提交。


## Confirmed decisions

| 项目 | 已确定行为 |
|---|---|
| 集成方式 | 纯外部插件，允许将部分助手历史转换为精简摘录，不追求 OMP 的逐项等价移植 |
| 使用入口 | Web UI，复用现有斜杠命令和通用结果展示 |
| 触发方式 | 仅手动 `/shake`，不增加自动清理策略 |
| 生效时机 | 持久化请求，在下一次自然开始的模型请求之前执行 |
| 忙碌状态 | 拒绝命令并提示空闲后重试；不打断、不排队 |
| 最近历史保护 | 保留最近约 **4,000 个估算 token**，按完整消息保护 |
| 工具文本门槛 | 单条工具结果的文本合计至少约 **1,000 个估算 token** |
| 助手大块门槛 | 代码围栏/XML 块至少约 **400 个估算 token** |
| 用户内容 | 用户消息全部保留，不扫描其中的代码/XML |
| 其他保护 | 系统/开发者指令、错误结果不处理；不转换含图片、thinking、工具调用等非文本块的助手消息 |
| 净收益要求 | 加入占位符、摘录说明后仍有净节省，才执行替换 |
| 原文回取 | 增加一个受限工具，只读取当前会话中本插件实际移除的片段，支持分段读取 |
| 取消与撤销 | `/shake cancel` 取消尚未开始的请求；不提供完成后的整次撤销 |
| 交付 | 预构建、可发布的 npm/tgz bundle；以 tgz 安装验收，不包含实际上传 npm |

额外的实现边界：

- 每个会话最多一个待执行请求；重复 `/shake` 不重复创建。
- 只处理提交命令时选中的历史，不顺带清理后来新增的内容。
- 原文保留在宿主日志中，**这不是磁盘清理或敏感数据删除功能**。
- 保护规则只约束本插件，不关闭或改写宿主已有的自动 compaction 策略。

### 交互决策记录（AskUserQuestion）

以下记录三批共九组问答：第一批 D1–D3，第二批 D4–D6，第三批 D7–D9。九组均选择了当时标为推荐的第一个选项；选项名称保留问答原文。

**记录口径**：最终选择来自用户的明确回答；“取舍理由”是讨论中的工程依据，不代表用户另行陈述了个人动机。未选方案仅用于保留比选过程，不是待定分支或承诺的后续功能。同会话请求去重、回取分页数值和具体状态字段等属于既定方案的实现落实，不应记作额外的用户投票。

#### D1. 集成边界（integration_boundary）

**问题**：“不修改 deepseek-harness”与“忠实保留 OMP 的消息结构”，更看重哪一个？

**选择**：纯外部插件，接受历史摘录替换。

| 选项 | 优点 | 代价与限制 | 结果 |
|---|---|---|---|
| 纯外部插件，接受历史摘录替换 | 不维护宿主 fork；通过公开接口安装、升级；仍覆盖工具文本和助手大块文本 | 部分助手内容转换为历史摘录，不能保持原消息角色逐块改写；受宿主持久化接口限制 | 已选 |
| 忠实剪裁，允许补充宿主接口 | 更接近 OMP，可为保留消息角色、工具结构和逐块处理提供专门接口 | 需要宿主补丁与插件配套，并验证事件目录、恢复和版本升级；工程与维护成本更高 | 未选 |
| 缩小范围，仅清理工具结果 | 选择和转换逻辑较少；不改变用户或助手消息 | 明确失去大代码块处理能力；即使只处理工具结果，仍须解决允许写入的 turn 时机 | 未选 |

**取舍理由（工程依据）**：在“不改宿主”的前提下保留工具结果与大块文本两个主要用途，而不是把需求缩成纯工具输出裁剪。接受受控的助手角色转换，不接受日志不可重建或工具调用配对损坏。

#### D2. 功能范围（feature_scope）

**问题**：本次要覆盖哪些 `/shake` 功能？

**选择**：手动文本减重。

| 选项 | 优点 | 代价与限制 | 结果 |
|---|---|---|---|
| 手动文本减重 | 用户明确触发；不增加图片、推理历史或自动调度的处理面；与原有 compaction 边界清楚 | 不移除图片或 thinking，也不会自动发现并处理上下文压力 | 已选 |
| 手动文本、图片和 thinking | 人工控制下可处理更多类型的重内容 | 需要额外验证多模态、推理块、签名及 provider replay 兼容性；移除这些内容的影响更大 | 未选 |
| 手动文本减重，加自动触发 | 不必每次人工判断上下文压力 | 需要定义触发阈值、执行频率以及与宿主自动 compaction 的顺序和重复处理规则 | 未选 |
| 全部模式，并支持自动触发 | 覆盖范围最广 | 同时承担多模态、推理历史、自动调度及交互行为的维护和验证成本 | 未选 |

**取舍理由（工程依据）**：先明确交付的就是手动文本功能，不将图片、thinking 和自动策略混入同一验收范围。保留非文本内容不等于保留所有旧工具文本：D4 确定的执行时机允许在同一工具结果中只替换文本。

#### D3. 使用入口（target_surface）

**问题**：插件的正式使用和验收界面是哪一个？

**选择**：Web UI。

| 选项 | 优点 | 代价与限制 | 结果 |
|---|---|---|---|
| Web UI | 复用已有命令发现、提交和通用结果展示；不新增设置页面或另一套交互协议 | 正式支持和验收只覆盖 Web，不据此宣称 Desktop、SDK 或 ACP 可用 | 已选 |
| Web UI 和桌面版 | 覆盖两种交互入口，可利用共有的 Web 交互机制 | 仍须单独验证桌面版 profile、安装、加载和宿主生命周期；共用 UI 不代表交付自动等价 | 未选 |
| 还要支持 SDK 或 ACP 调用 | 自动化客户端也能显式控制清理 | 需要定义、实现和验证程序调用协议，不能假定已有斜杠命令适配器 | 未选 |

**取舍理由（工程依据）**：把正式支持范围放在已有命令适配器的 Web UI 上，以实际界面和请求证据验收，不用底层能力可复用来替代其他入口的端到端验证。

#### D4. 生效时机（apply_timing）

**问题**：执行 `/shake` 后，什么时候真正修改模型上下文？

**选择**：下一次模型请求前执行。

| 选项 | 优点 | 代价与限制 | 结果 |
|---|---|---|---|
| 下一次模型请求前执行 | 在自然 turn 的合法阶段独立替换工具文本；不额外唤醒模型；可以保留同组 thinking、图片和工具身份 | 命令成功只代表请求已持久化，不代表已经减重；需要待执行状态、恢复、候选重验和取消语义 | 已选 |
| 空闲时立即执行 | 命令结束即可看到已执行的减重结果，没有等待下一次请求的状态 | 空闲时不能直接采用标准工具结果替换路径，只能转成整组历史摘录；为保留非文本内容，含图片或 thinking 的完整工具组必须跳过，可回收量可能很小或为零 | 未选 |

**取舍理由（工程依据）**：标准会话 invariant 要求工具结果替换位于活动 turn 内。利用下一次自然请求的 `agent/pre-step`，比制造虚假 turn、关闭校验或丢弃整组信息更符合宿主契约。

**对 D1 的收敛**：最终方案不是把所有工具调用组转成摘录。工具结果保持原身份和调用/结果配对；只有符合保护条件的助手纯文本消息使用历史摘录替换。这里的“待执行”也不是忙碌命令排队：D9 仍要求空闲时才能受理。

#### D5. 用户内容保护（protection_policy）

**问题**：默认允许处理用户自己发出的代码/XML 大块吗？

**选择**：不处理用户消息。

| 选项 | 优点 | 代价与限制 | 结果 |
|---|---|---|---|
| 不处理用户消息 | 原始需求、验收条件和用户粘贴的代码保持完整；无需猜测哪些用户块已经不重要 | 用户大段输入占用的上下文无法由本插件释放，可回收比例低于 OMP 默认 elide | 已选 |
| 允许处理用户大块 | 更接近 OMP，可释放用户粘贴的大代码/XML 所占上下文；周围文字仍可保留 | 用户给出的关键证据也可能退出模型当前上下文，需要回取才能恢复细节 | 未选 |

**取舍理由（工程依据）**：优先保留需求来源，不以较高的回收比例换取模型忘记用户原文的风险。两个选项都包含最近约 4,000 token、系统/开发者指令及助手非文本内容的保护；选择差异在于是否允许处理用户大块。

#### D6. 原文回取（recovery_behavior）

**问题**：被移出模型上下文的原文，如何按需取回？

**选择**：单个受限原文回取工具。

| 选项 | 优点 | 代价与限制 | 结果 |
|---|---|---|---|
| 单个受限原文回取工具 | 保留模型按需恢复细节的能力；只暴露当前会话的已移除片段；一个 schema，复用已有日志存储 | 需要实现授权凭据校验、分页和恢复兼容性；仍有工具 schema 与回取结果的上下文开销 | 已选 |
| 复用官方会话查询工具组 | 直接复用成熟的五工具工作流，插件自身新增代码较少 | 会增加五个工具及提示开销，并暴露同工作区跨会话读取能力；能力范围大于本功能所需 | 未选 |
| 仅保留日志供人工查看 | 不增加模型工具，代码和固定上下文开销最小 | 不承诺模型能按需取回；后续任务需要细节时依赖人工查阅与重新提供 | 未选 |

**取舍理由（工程依据）**：保留 OMP 式“移出上下文但可找回”的核心价值，同时把能力限制在最小必要范围。只新增受限的工具入口，底层读取仍复用 `ctx.sessionQuery`，不另造存储或通用历史搜索系统。

#### D7. 交付方式（distribution）

**问题**：实现后的交付形式是什么？

**选择**：预构建的可发布 bundle。

| 选项 | 优点 | 代价与限制 | 结果 |
|---|---|---|---|
| 预构建的可发布 bundle | npm/tgz 安装使用已构建文件；不要求用户批准安装期构建脚本；可在独立 profile 验证实际包内容 | 需要维护构建、导出、发布文件清单和打包验收；“可发布”不包含本次实际上传 npm | 已选 |
| 仅本地自用插件 | 本地目录链接或 `--patch` 的开发路径简单，无需公开发布包装 | 缺少面向分发的产物和安装验收，不能等同于可直接交给其他用户的安装包 | 未选 |
| GitHub 源码直接安装 | 用户可按 GitHub 地址及提交安装，无需先发布 npm 包 | 需要自包含 `prepare` 构建、用户批准安装期脚本及相应工具链；供应链与构建维护成本更高 | 未选 |

**取舍理由（工程依据）**：以可重复安装的构建产物作为交付，而不是依赖开发者本地环境。源码仓库与预构建包可以并存，但本方案不把 GitHub 源码安装期构建作为正式安装路径，也不替用户执行 npm 发布。

#### D8. 清理强度（cleanup_intensity）

**问题**：已保护最近约 4,000 token 后，默认清理强度选哪种？

**选择**：只清理大内容。

| 选项 | 优点 | 代价与限制 | 结果 |
|---|---|---|---|
| 只清理大内容 | 工具文本至少约 1,000 token、助手代码/XML 至少约 400 token；保留短结果，减少低收益替换和细节回取 | 回收量比清理所有旧工具文本少，很多零散小结果不会被处理 | 已选 |
| 旧工具文本尽量清理 | 非错误工具文本不设单条大小门槛，更接近 OMP 手动 elide；可释放更多零散历史 | 更容易丢失仍有用的小结果并需要回取，替换及来源记录数量也可能更多 | 未选 |

**取舍理由（工程依据）**：以“去掉重内容”而不是“尽量删历史”为目标。两个选项都要求替换后有净节省、保护错误结果，并保持助手大块约 400-token 门槛；区别是工具文本是否另设约 1,000-token 门槛。净节省是本地估算与文本规模判断，不是 provider 计费保证。

#### D9. 忙碌行为（busy_behavior）

**问题**：用户在模型仍工作时输入 `/shake`，如何处理？

**选择**：拒绝，提示空闲后重试。

| 选项 | 优点 | 代价与限制 | 结果 |
|---|---|---|---|
| 拒绝，提示空闲后重试 | 沿用宿主 `/compact` 的保守交互；可用 `runMaintenance()` 原子确认空闲，不打断当前工具循环 | 用户需要等待任务空闲并重新提交；不能在工作中提前安排清理 | 已选 |
| 受理，等下一个新 turn | 用户可提前表达清理意图，不必等当前任务结束后再输入 | 需要额外区分当前 turn、下一 turn、候选截止位置、取消及恢复状态；不能只等下一个工具 step 就执行 | 未选 |

**取舍理由（工程依据）**：采用已有空闲占用契约，减少与运行中输入、工具循环及恢复边界的竞争。D4 解决“受理后何时生效”，D9 解决“何时允许受理”，两者不矛盾。

**共同确认的取消边界**：该题两个选项都明确包含 `/shake cancel` 取消尚未执行的请求，并排除完成后的整次撤销。回取原文不等于恢复整个历史 surface，也不撤销模型已经基于减重上下文完成的工作。

## Relevant codebase context

### 版本与工程基础

初次调研时本地目录为空；本计划按新建独立插件工程制定。

兼容基线固定为：

- `@deepseek-ai/dsh@0.2.0-rc.2`。
- Harness 源码提交 `639ed015397290b3745d163aafe02ffee4aa3f84`。
- TypeScript、ESM，运行时要求沿用宿主的 Node.js 版本范围。
- Harness 仍处于 developer preview，不声明兼容未经验证的后续版本。

### 已核实的扩展接口

| 接口或规则 | 对实现的影响 |
|---|---|
| [`ctx.commands.register()`](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/interaction/commands/README.md) | 命令及直接返回文本不进入模型历史，可注册 `/shake` |
| [`agent.runMaintenance()`](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/core/agent/src/runtime-types.ts) | 原子占用真正的空闲阶段，适合提交、取消清理请求 |
| [`agent/pre-step`](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/core/agent-loop/src/agent.ts) | 此时 `turn/start` 已落日志、模型请求尚未发送，可合法替换工具结果 |
| [`Session.append()` 与 surface replacement](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/core/session/src/surface.ts) | 通过追加替换记录改变未来上下文，原事件保持不变 |
| [`ctx.sessionQuery`](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/session-query/session-query/src/index.ts) | 提供 `readSurface()`、`readEvent()`、`traceEvent()`，用于选取、恢复和授权核对 |
| [`ctx.sessionProjections`](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/session/session-projection/README.md) | 使用宿主现有状态投影维护待执行请求，避免自行实现第二套日志监听与恢复机制 |
| [`ctx.tokenMeter`](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/llm/token-meter/README.md) | 提供一致的本地估算，不需要调用模型 |

**C02 发布包实证（clean，已放行）**：编排器在隔离目录执行 `npm install --ignore-scripts` 成功（540 个包），`node .verification/contracts/published-contract.mjs` 与 `node .verification/contracts/interfaces.mjs` 均 PASS；运行环境 Node 24.18.0、已安装 CLI `0.2.0-rc.2`。前者组合公开服务、官方 `@deepseek-ai/dsh-llm-replay` 的 `installLlmReplay()` 和真实 invariant companion（公开 `/invariant` 导出），通过生产工具分发及 JSONL 持久化，而非 mock Session 或关闭校验。初始模型调用 2 次、命令增加 0 次、后续自然请求后累计 3 次；实际请求等于当时派生消息。原结果 seq 10、控制记录 seq 17、prune seq 22 / replacement seq 23，满足 `turn/start < prune/replacement < step/start` 和同步相邻追加。JSONL flush/reopen 成功，原日志、来源、派生历史、投影和 token 测量恢复；无持久化监听器 flush 返回 `false`。补充探针证明 maintenance/取消、命令附件/元数据、投影、测量、查询/trace、prepend 顺序及身份拒绝边界。两个 C02 review pool 视角均 clean、无 findings；下一块为 C03。临时探针保留至集成测试复用所需契约后再清理，属于不可发布的夹具，不发布进 tgz；不是插件或 Web 验收。

固定版本实际公开入口与实现约束如下（来源：上述探针及公开接口材料）：

| 公开包 / 服务 | 已调用契约与实现注意事项 |
|---|---|
| `@deepseek-ai/dsh-session` | 默认 SessionStore 服务及公开 `Session`、`SessionSeq`、`SessionId`；`session.append(type,data,{surfaceOp,sourceEventSeqs})`、`deriveEventMessage(event)`、`deriveMessages()`；`ctx.sessions.flush(session)` 有监听器返回 `true`，无监听器返回 `false`。 |
| `@deepseek-ai/dsh-commands` | `CommandRuntime` / 默认服务、`parseCommand(line)`；`register(definition)` 返回 disposer，`execute(agent,line,attachments,signal)` 返回 `{commandId,result}`。`recordInput:false` 不把命令输入加入模型历史；未声明附件时拒绝附件；取消以原 Error reject，并追加 `command/done:error`，不能假设取消会返回已 resolve 的错误结果。 |
| Agent / Cordis | `runMaintenance(task)` 同步占用空闲阶段，竞争调用同步抛错；任务收到 Agent-owned signal。`cancel(cause,{keepInbox:true})`、`followup(message)`、`whenIdle()`；`ctx.on('agent/pre-step',(payload,next)=>Promise<PreStepDecision>,{prepend:true})` 在真实 turn 内、step/start 前执行，flush 后委托 `next()`，保留下游决策。 |
| `@deepseek-ai/dsh-session-query` | `SessionQueryEngine` / 默认服务；`readSession(sessionId)`、`readSurface(sessionId)`、`readEvent({sessionId,seq})` 返回含 `target,events` 的结果；`traceEvent({sessionId,seq})` 含 `sourceEventSeqs,replacedEventSeqs,replacedBy,replacementChain`。trace 是不受权限约束的来源图，回取必须另外验证控制元数据及实际替换凭据。 |
| `@deepseek-ai/dsh-session-projection` | `SessionProjectionRegistry`；`register({key,stateSchema,stateVersion,init,apply})`、`stateOf(session,key)`、`snapshot(session)`、`checkpoint(session)`。Host-only schema-v1 状态可随日志重建；非法/不兼容版本被拒绝，无关事件保持同一状态引用。 |
| `@deepseek-ai/dsh-token-meter` | `TokenMeter` / 默认服务；`measure(session,requestHeader?)` 返回深不可变测量，`surfaceTokens` 等于节点 token 总和；`estimateMessage(message)`。实际组合必须包含 `sessionProjections` 依赖，不能按 README 的可选组合措辞遗漏。重开后的 logRevision 会因合法 `session/end-seed` 边界增加，其他测量保持一致。 |
| `@deepseek-ai/dsh-compaction` | `toolPairingBalancedBefore(session,seq)`、`toolPairingBalancedAfter(session,seq)` 是公开配对边界检查。工具替换须保留身份、source/meta/error 和非文本内容；更改身份、遗漏被 shadow 的 source 或重复 source 均被拒绝且不修改日志。 |
| `@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-tools` | 公开 `createUserMessage(input)` 与 `defineTool()`；控制元数据保存于现有 `user/message` 的合法 `source`，随 JSONL 重开与投影恢复，不新增事件类型。 |

必须遵守两条限制：

1. **模型上下文必须能从日志重建。** 不使用请求发送前的临时消息过滤。
2. **不新增需要宿主认识的持久化事件类型。** 当前事件及消息投影目录是静态组成的；独立插件新增模型相关事件会影响恢复兼容性。采用现有 `user/message`、`tool/result` 等事件，扩展其合法的消息来源元数据。

OMP 的参考实现来自 [`packages/agent/src/compaction/shake.ts`](https://github.com/can1357/oh-my-pi/blob/14c97b555b206231290f46882794c8d8c3c024b1/packages/agent/src/compaction/shake.ts)。只借鉴文本区域识别等纯逻辑，不引入整个 OMP 运行时。

## Recommended approach

### 方案选择

| 方案 | 适配程度与成本 | 结论 |
|---|---|---|
| 直接包装内置工具结果 pruner | 成本低，但其默认策略是压力触发、保留头尾；不覆盖助手大块及受限原文回取 | 不作为完整实现 |
| 临时修改发给模型的 messages | 表面简单，但破坏日志重建、重启一致性和宿主校验 | 排除 |
| 新增持久化消息投影事件 | 能更忠实保留消息结构，但需要修改宿主静态目录 | 不符合纯插件要求 |
| **延迟执行＋原生 surface replacement** | 实现成本中等，复用现有日志、查询、状态投影和命令体系 | **采用** |

### 核心设计

采用一个 Host 插件包，不新增前端应用或设置页面。

- **工具结果**：只替换 `message.content` 中选中的文本，保留工具调用身份、错误字段、元数据及非文本内容。
- **助手消息**：仅处理纯文本消息；将选中的大块替换为占位符，周围文字保留，再以明确标注来源的历史摘录替换原 surface 节点。
- **控制状态**：使用现有 `user/message` 事件承载插件来源元数据，正文只包含简短状态说明。
- **原文存储**：继续使用宿主原始日志，不复制到自建数据库或 artifact 目录。
- **回取授权**：以实际替换事件及其 `sourceEventSeqs` 为凭据，不把一个可猜测的事件编号当作读取权限。

这里使用的是**业务状态投影** `ctx.sessionProjections`，不是受静态目录限制的自定义 `SessionMessageProjection`。

### C03 配置与状态公共 API（已实现，clean，已放行）

- `src/config.ts`：`ShakeConfigSchema`、`ShakeConfig`、`DEFAULT_SHAKE_CONFIG`、`parseShakeConfig(value = {})`。严格配置仅接受数值策略：`protectedTokens=4000`、`toolTextMinTokens=1000`、`assistantBlockMinTokens=400`、`readDefaultLimit=2048`、`readMaxLimit=4096`；读取限额为 1–4096 且默认值不得超过最大值，不提供硬保护开关。
- `src/state.ts`：`ShakeRegionSchema`、`ShakeRequestSchema`、`ShakeResultSchema`、`ShakeControlSchema`、`ShakeExcerptSchema`、`ShakeRefSchema`、`ShakeStateSchema` 及相应类型。`MessageSourceMap` 扩展区分 `dsh-shake-control` 与 `dsh-shake-excerpt`；schema-v1 控制记录携带完整后状态，无原文副本。`shakeProjection` 使用 `dsh-shake` key、`stateVersion: 1`；`registerShakeProjection(registry)` 返回注销函数，`readShakeState(registry, session)` 在未注册时抛错。`applyShakeEvent` 对无关事件返回原引用，拒绝非法自有元数据，仅保留当前请求与最近结果，继承历史时不执行父会话 pending。
- `formatShakeRef` / `parseShakeRef` 使用规范格式 `shake:1:<operationId>:<requestSeq>:<regionIndex>`；引用只能定位元数据，不是授权凭据，实际替换凭据核验留在回取实现阶段。
- **C03 review 修复及 clean 复审**：规范引用必须匹配完整字符串，拒绝尾随 `\n`、`\r`、`\r\n`、U+2028、U+2029，不能依赖允许末尾换行前匹配的正则结束语义。编排器报告修复后 typecheck PASS、`tests/state.test.ts` **10 tests PASS**，以及编译后的公共 `formatShakeRef` / `parseShakeRef` smoke PASS：5 种尾随终止符全部拒绝、合法引用 roundtrip 成功。临时 `.verification/ref-smoke` 输出已清理；`c03-rereview-1` 与 `c03-rereview-2` 两个复审视角均 clean、无 findings，C03 已放行，下一块为 C04；不扩大至回取授权或完整插件验收。
- 区域 `start` / `end` 是原事件单一文本块的半开 **UTF-16** 索引。`checksumShakeText` 对原选中子串的 **UTF-16LE** 字节计算 `sha256:<hex>`，保留包括孤立 surrogate 在内的原始代码单元差异；不能混同未来回取 API 按 **Unicode 码点** 计算的 offset/limit。

### C04 纯文本扫描 API（已实现，clean，已放行）

- `src/blocks.ts` 导出 `scanTextForBlockRanges(text)` 与 `TextBlockRange`：`kind` 为 `fence` / `xml`，`start` / `end` 为单一原文字符串内半开 UTF-16 索引，包含开闭行及缩进、不包含闭合行末 LF；无 I/O、不修改输入、不跨消息/content block。
- 改编固定 OMP 提交 [`14c97b555b206231290f46882794c8d8c3c024b1`](https://github.com/can1357/oh-my-pi/blob/14c97b555b206231290f46882794c8d8c3c024b1/packages/agent/src/compaction/shake.ts) 的 `scanTextForBlockRanges` / `mergeRanges`，新增 kind 标记和单字符串 API；源文件与 `THIRD_PARTY_LICENSES` 保留 MIT 许可及 Copyright (c) 2025 Mario Zechner、Copyright (c) 2025-2026 Can Bölük、Copyright (c) 2026 Stencil Labs, Inc.。不引入 OMP 运行时、tokenizer、Session 类型或工具保护逻辑。
- 基于 OMP 纯逻辑改编并收紧闭合条件，**不是完整 Markdown/XML parser**：围栏闭合须与开头使用相同 delimiter、长度至少等于开头，且后缀仅为空白；未闭合围栏不输出范围并持续抑制 XML。XML 开标签仍须无缩进、整行小写 `[a-z_-]+` 名称，闭标签可缩进；错配闭标签使整个候选失效，后续匹配只排空原栈，不能恢复该候选。原栈未排空时保守抑制后续 XML，排空后可识别独立完整块；literal span 外的独立完整围栏仍可识别。多行注释与 CDATA（包括未闭合 literal span）抑制其中的标签和围栏识别；围栏内部的 literal delimiter 不影响后续 XML。未闭合结构不输出范围，围栏内不识别 XML；输出按原文顺序、不重叠。不得外推为一般 XML 或完整 Markdown 语法支持。
- **第四个 finding：mixed literal 边界**：comments/CDATA 所在行混有 literal span 外内容时，保守使活动 XML 候选失效，避免忽略边界外的畸形结构；合法外层 XML 仍可保留。该 finding 已修复并经 clean 复审，不扩大扫描语法支持范围。
- **C04 review 修复及 clean 复审**：四个 scanner findings（不完整围栏闭合、错配 XML 候选复活、注释/CDATA 内误识别、mixed literal 边界）均已修复，保留 OMP derived/adapted 归属与 MIT 许可。编排器实际报告最新修复后 typecheck PASS、**31 tests PASS**；mixed comment/CDATA 边界 runtime smoke PASS。两个 final rereview 视角均 clean、无 findings；04 保持已勾选，C04 已放行、未提交。C05 的后续实现与证据见下节，不将 C04 结果外推为完整区域验证。

### C05 候选规划与实际引用渲染 API（已实现，完整区域验证通过，clean，已放行）

- `planShakeRegions(session: Session, services: ShakePlannerServices, options: ShakePlanOptions): Promise<ShakePlan>`；services 使用公开 `sessionQuery.readSurface/traceEvent/readEvent` 与 `tokenMeter.measure/estimateMessage`。options 包含 `operationId`、`requestSeq`、可选 `policy`；结果包含 `cutoffSeq: number | null`、`regions`、`protectedEventSeqs`、估算 `savedTokens`。每次一次 surface/测量，完整消息保护、工具文本合计门槛及纯文本助手块选择，不因工具名 skill/plan/useless 或文本 error 改变硬保护。
- `renderShakeMessage(original, eventSeq, selections, reference, meter): RenderedShakeMessage | null`；selections 为 `{ region, regionIndex }[]`，reference 包含 `operationId/requestSeq/sessionId`，meter 使用 `estimateMessage`。保留未选中文字和工具非文本块，以实际规范引用及 `SHAKE_EXCERPT_PREFIX` 计入收益；过期原文或无净收益返回 `null`。C07 必须在真正提交前再次调用，不把本阶段渲染视为实际替换。
- **编排器已执行证据**：最新 typecheck PASS、54 tests PASS（regions 23 + blocks 21 + state 10），包含补齐覆盖及类型正确的宿主事件/消息夹具。保留此前真实公开宿主 smoke exit 0：旧工具结果 seq 10 的 12,427 字符文本被选中，近期 seq 16 完整保护且不变，实际引用渲染后估算 savedTokens 3090，新增模型请求 0。临时 regions-smoke.ts / .mjs 已清理，C02 契约夹具保留。05 的实施完成条件已观察、已勾选；完整区域 Validation 现已勾选。
- **完整区域覆盖已补齐及 clean 放行**：默认最近窗口跨界累计 4,050 时保护完整消息；独立 control/excerpt 来源在零门槛下仍硬保护；工具 999/1,000 与助手 399/400 门槛、无净收益、角色/错误/回取保护、混合消息、未闭合结构和 Unicode 均有断言。多个围栏与嵌套外层 XML 的候选/渲染断言精确保留未选中文字；渲染后助手及带真实控制来源的工具结果不再裁剪。原区域 Validation 全部验收细节已有覆盖；`c05-review-1` 与 `c05-review-2` 两个审查视角均 clean、无 findings，C05 已放行、未提交。05 与完整区域 Validation 已验证并保持勾选；后续 C06 结果见下节。不证明 pre-step/实际替换、回取授权、完整插件、包、运行时矩阵或 Web。本次仅记账，不运行任何检查。

### C06 持久化命令（已验证，clean，已放行）

- 编排器实际 typecheck PASS、59 tests PASS（commands 5 + regions 23 + blocks 21 + state 10）；真实已发布固定宿主包上的插件及 CommandRuntime 启动成功，Session、Agent、AgentLoop、Commands invariant 全部启用，命令 smoke PASS。
- pending 请求 seq 16、cutoff 15，原助手 seq 8、选中原文范围长度 15,009；JSONL flush 后重开恢复完全相同 pending。maintenance 占用时两条命令拒绝；重复 `/shake` 拒绝且不追加请求。取消持久化后再次重开 current=null、lastResult.status=cancelled，原文仍在、无提前替换。命令新增模型请求 0，重开新增 0；初始自然输入的 1 次请求仅用于生成夹具。
- 06 已勾选；`6494fd6` 后两个 C06 审查视角 clean、已放行。完整命令 Validation 保持未勾选，取消信号、维护期间输入顺序及替换开始后的生命周期仍须 C10 验证。C06 临时夹具已清理，C02 契约夹具保留；C07 最新证据见下节。

### C07 durable 替换与自然请求（修复已验证，双复审 clean，已放行）

- 编排器实际 `pnpm install` 完成 compaction 依赖锁文件同步；typecheck PASS、63 tests PASS；经 heavy-gate 的真实已发布宿主插件 pre-step/实际适配器请求 smoke PASS。命令新增请求 0，下一次自然输入新增 1；原工具 seq10、请求 seq17、替换 seq24，removed=2、skipped=0，估算 savedTokens=5598。
- 捕获请求与 `deriveMessages()` 一致；目标重文本退出请求，保护内容不变，工具配对、特殊非文本/offload/元数据、来源以及助手摘录周边未选中文字断言 PASS。`llm/stream` 可见前原始日志及替换已 durable；JSONL 重开 reopenConsistent=true。原文保留在宿主原始日志，业务状态仅保存引用、范围、校验摘要，不存原文副本。
- 公开 `agent/pre-step` waterfall 返回 Promise；`llm/stream` waterfall 返回 AsyncIterable，流监听器须用 async generator 委托，不能返回 Promise 或虚构 `before-step-prepared`。07、08 与原真实请求/日志 Validation 的 criteria 已满足并勾选；`56229af` 后 `c07-rereview-1` 与 `c07-rereview-2` 均 clean、无 findings，两项修复已验证，C07 已放行。临时 execution-smoke.ts / contracts/shake-execution.mjs 已清理，C02 published-contract 公开流契约增强保留；未证明回取授权、中断恢复、生命周期、pack、版本矩阵或 Web。
- **C07 两项 review 修复**：助手替换也同步相邻追加按原助手消息计价的 `compaction/prune`，再追加历史摘录；完成先写 `completed` 且保留 current、flush，再写 completed/current=null 并再次 flush。staged completion 恢复时先确认 flush 再 clear；terminal-null 的 completed 状态也必须 flush 成功后才能放行，避免未确认完成绕过请求门禁。取消/flush rejection 不在取消后补写事件。
- **最新实际证据（编排器）**：typecheck PASS、66 tests PASS；编译后 heavy-gated 真实宿主 smoke PASS（`artifact://254`）：occupied **10033 → 6958 → 5007**，原助手计价的相邻 prune 与实际请求减重均通过；staged/clear 两个完成边界 × live/reopen 四组合在 abort+flush rejection 下均确认无取消后 append、无提前请求，随后自然请求恢复成功。此局部证据不代表 C09/C10 的完整恢复、fork、卸载或生命周期验收。
- **明确代价**：同会话 terminal-null/completed 最近结果存在时，每个后续自然 step 都再次 flush；这是为 live/replay 都确认持久化而选择的保守门禁，不依赖 process-local durability flags，也不是仅失败后的一次重试。C07 双复审 clean、已放行，未发布；仅清理 `.verification/execution-fix-smoke.ts` / `.mjs`，保留 C02 契约夹具。

### C08 受限原文回取（已验证，双复审 clean，已放行）

- 实际实现为 `src/read.ts` 的 `readShakeText` / `registerShakeRead`，由插件注册公共 `defineTool()` 工具。ref 只是 locator；权限来自当前 `exec.agent.session` 的真实原日志与已落地替换，而非占位引用、父会话 metadata 或请求状态本身。
- 所有 `readEvent` / `traceEvent` 都限定捕获的同一 session ID；逐次检查取消与 session identity。核对控制 schema、操作/request/region、原事件身份与范围、SHA-256（UTF-16LE）checksum、实际 replacedBy、替换的精确原文/请求双来源 lineage，以及重渲染后的完整替换消息和助手摘录 metadata。不查询父或兄弟 session；继承请求和替换凭据必须落在真实 seeded inherited prefix 内。
- 分页以 Unicode 码点计数，默认 2048、最多 4096；拒绝负数、非整数、超限及越界，恰好末尾返回合法空页，输出仅选中片段。候选 provenance 保护的前提已落地：planner 的 sessionQuery `Pick` 包含 `readSurface`、`traceEvent`、`readEvent`，追溯来源保护控制/摘录及回取结果。
- 编排器实际 typecheck PASS、六文件 **72 tests PASS**；heavy-gated 已发布宿主真实工具 read smoke PASS：`commandAddedRequests=0`、`cleanupAddedRequests=1`、`readDispatches=237`、`requestsBefore=3`、`requestsAfter=3`、`reopenedRequests=0`，片段长度 **12425 / 7209** 精确拼接，`jsonlReopen=true`、`inheritedForkOnly=true`。此为实际 dispatch，不是 mock 转发；实施 09 与原授权/分页 Validation 已验证勾选。`7e317bd` 后 `c08-review-1` 与 `c08-review-2` 均 clean、无 findings，C08 已放行，下一块 C09 依赖已就绪。C09 未完成，局部重开/继承授权不代替完整中断/fork/compaction/生命周期验收。
- 只清理 `.verification/read-smoke.ts`、`.verification/contracts/read-smoke.mjs` 与其 `.map`；保留 published-contract 夹具。本次 evidence/docs cleanup 不运行检查、测试、构建、lint、格式化或提交。

### C09 中断恢复、fork 与宿主共存（已验证，双复审 clean，已放行）

- **历史阶段说明**：本节及此前 C06/C07/C08 的 C10 未完成、完整 Validation 未勾选措辞是阶段记录；当前完整验收已由下节 C10 补齐，获准的 `fb74f62` 后两个 C10 review 均 clean、已放行。
- 编排器实际 typecheck PASS、七文件 **75 tests PASS**；heavy-gated recovery-smoke **exit 0**（`artifact://297`），所有场景断言通过，最新保留夹具 smoke 见下文 `artifact://322`。实施项 10 已验证勾选；`f49e843` 后 `c09-rereview-1` 与 `c09-rereview-2` 均 clean、无 findings，C09 已放行、未发布。完整持久化/共存 Validation 因 C10 卸载/重载、取消与并发仍未完成而保持未勾选。
- pending JSONL 重开 `pendingReopenRequests=0`，不执行意图，下一自然 turn 完成 **2** 区域。部分替换在真实提交 seq **24** 中断，冻结请求、策略和候选保持一致；重开 `duplicateToolReplacements=0`、完成 **2** 区域。明确失败重开仍 failed，`failedAutomaticRequests=0`、`failedAutomaticReplacements=0`；已提交变更不被描述为回滚。
- fork `inheritedPendingExecuted=false`、`parentUnaffectedByChild=true`、`inheritedReadQueries=6`（全部只查询 child）、`crossOwnerDenied=true`。staged/clear 完成边界分别中断重开，均 `duplicateReplacements=0`，随后 completed/current=null。
- 内置公开 pruner 在 plan 前/后生成 replacement seq **20 / 23**；prune/compact × plan 前/后四组合均原文不复活、prefix 无重复，JSONL 重开派生历史精确一致；plan 后过期候选跳过。公开 `pruneSession` 要求 active natural turn，不能在 idle maintenance 中伪造 turn；`compactNow` 自行占用 maintenance。脚本应计入真实 pruning turn 的模型请求，不将其算成 shake 命令请求。
- 完整 compaction 后控制请求已离开 surface；原日志授权仍返回与 compaction 前精确相同的页，重开同样精确且新增请求 0。损坏原文 checksum 与缺失日志均拒绝；这是场景断言，不增造读取次数或 token 指标。
- 完整已验证场景保留在 `tests/fixtures/recovery.ts`，三个回归测试与导出的 `runRecoverySmoke` 共用；夹具无自动执行副作用。临时调用/输出 wrapper 及生成产物已清理，保留场景与 C02 契约夹具不删除。本次仅更新 tracker，不运行检查、测试、构建、lint、格式化或提交。
- **C09 retained-fixture reviewer fix（双复审 clean，已放行）**：`tests/fixtures/recovery.ts` 的 imports 已修正，三个永久测试和导出的 `runRecoverySmoke` 共用此保留夹具，不依赖临时 wrapper。编排器修复后 typecheck PASS、七文件 **75 tests PASS**；heavy-gated location-preserving fixture smoke **exit 0**（`artifact://322`），上列既有指标与全部场景断言 PASS，作为最新 smoke 证据取代 `artifact://297`。host 依赖 external 时，夹具相对 import 必须同目录编译，不得移置输出到 wrapper 目录。
- 已仅删除 `.verification/recovery-smoke.ts`、`.verification/recovery-smoke.mjs` 与生成的 `tests/fixtures/recovery.mjs`，保留 `tests/fixtures/recovery.ts` 和 C02 夹具。教训：永久测试不得依赖临时 probes；保留共享夹具，清理后验证保留路径。编排器实际清理后 typecheck PASS、七文件 **75 tests PASS** 已记录；不声称清理后重跑 smoke。本次 tracker 更新不运行检查、测试、构建、lint、格式化或提交。`f49e843` 后两个 C09 re-review 均 clean，C09 已放行、未发布；下一块 C10 依赖已就绪，完整生命周期范围仍未完成。

### C10 取消、卸载与并发（已验证，双审查 clean，已放行）

- 编排器实际 full typecheck PASS、八文件 **86 tests PASS**；heavy-gated retained `tests/fixtures/lifecycle.ts` full smoke **exit 0**（`artifact://345`），全部场景断言 PASS。实施项 11、完整命令受理/取消与持久化/中断/共存 Validation 已验证勾选；获准的 `fb74f62` 后 `c10-review-1` 与 `c10-review-2` 均 clean、无 findings，C10 已关闭放行，下一块 C11 依赖已就绪；不声称发布或 Web/包验收。
- `commandAcceptance` 覆盖无候选、idle cancel、非法参数、附件、预取消、去重、maintenance busy；`activeUnload('execution')` 覆盖执行中的重复/取消命令拒绝，冻结选择不变。命令新增模型请求 0；pending 卸载/重开意图保持，reload 完成 2 区域，移除插件后宿主自然请求仍正常。
- UI、公开 `Agent.cancel` 与工具调用取消均被遵守。复用 recovery `partialRestart` 在真正 replacement 提交 seq24 取消：同步相邻 prune/replacement 原子对不被拆断，其后无进度控制 append 或模型请求；重开冻结选择不变、tool replacement 不重复、最终完成 2 区域。
- 生命周期先注销入口，再收集并排空 command、read、execution 已启动操作；三场景 `drained=true`，卸载新增请求和 control append 各 0。命令/投影 absent、工具拒绝、reload 无冲突；同 runtime 两会话独立，取消 A 不修改 B。命令/工具两种既有注册冲突显式失败，清理后可重新注册。
- 无保存监听器或 flush 失败时命令不报告成功；卸载仅作一次有界未确认持久化尝试。公开 `ctx.logger.exporter` 捕获真实 durability 错误；Cordis `dispose()` **resolves，不 reject**，不能用 dispose fulfilled 推断 durable，也不能写成 disposal rejection。
- 维护 inbox 输入逐个进入后续自然请求：实际首个请求有 first，后续请求有 first、second，顺序不变；不要求两个 queued 输入同 turn 或同 request，冻结 cutoff/选择不扩展。
- `automaticCompaction` 用真实自然请求触发公开自动 compaction，而非 `compactNow` 替代；精确回取页、派生历史与 replacement seq 列表经 JSONL 重开保持一致，重开请求 0。与 C09 手动 compaction/pruner/fork/完成边界证据合并满足完整共存验收，不编造 token 或调用次数指标。
- 保留 lifecycle/recovery TypeScript 夹具、永久测试及 C02 契约；仅删除生成的 `tests/fixtures/lifecycle.mjs` 与临时 `.verification/lifecycle-smoke.ts`。本次记账清理不运行检查、测试、构建、lint、格式化或提交；不声称清理后重跑。

### C11 预构建包与使用文档（已验证，双审查 clean，已放行）

- 编排器实际 typecheck PASS、heavy-gated build + pack PASS；tgz 共九文件：`lib/index.mjs`、`lib/index.d.mts`、`lib/index.mjs.map`、`LICENSE`、`THIRD_PARTY_LICENSES`、`README.md`、`cordis.patch.yml`、`package.json`、`CHANGELOG.md`。
- 隔离 `/tmp/dsh-shake-consume-ydWKcz` 实际 `npm install --ignore-scripts`（51 包）PASS，NodeNext `tsc` PASS。heavy-gated packed public runtime corrected replay PASS：`scheduledRequests=0`、`reopenRequests=0`、`naturalRequests=1`、`completedRegions=1`、`readPage=true`。重开回放脚本从 cursor 0 开始，只应提供下一次自然请求所需响应，不重复原 seed/tool 脚本。
- 实施项 12/13 已验证；获准的 `8251193` 后 `c11-review-1` 与 `c11-review-2` 均 clean、无 findings，external/peer 依赖、source/map/declarations 与许可审查已 clear，C11 已关闭放行，C12 依赖已就绪。独立 Node 消费不是 Web profile；原完整类型/构建/包消费 Validation 保持 unchecked，唯一剩余条件为 C12 实际证明 tgz 在隔离 Web profile 安装/加载。运行时矩阵与完整 Web 验收不变，未通过。

### 持久执行顺序与状态

唯一进度账本为 [`CHECKLIST.md`](CHECKLIST.md) 原有 21 项。C01–C12 已验证、clean、已放行，未发布 npm。实施项 01–13 共13/13、全部八项 Validation 共8/8完成，合计21/21；最终五面审查门禁已完成。活动未勾选任务精确列表 `[]`，可做未完成0、阻塞0；早期阶段 unchecked 记载保留为历史，不作为当前任务。本次未创建提交。

执行顺序为：独立工程 → 发布包公共契约 → 状态/配置 → 扫描/许可 → 候选策略 → 持久化命令 → 替换/pre-step → 受限回取 → 中断/fork 恢复 → 生命周期 → 预构建包/使用文档 → 版本矩阵、实际 Web 及完整分拆审查；各阶段已完成。C09 在 `f49e843` 后双复审 clean；C10 `fb74f62` 与 C11 `8251193` 后分别双审查 clean。C12 `d79b08b` 后最终完整审查，`515929a` 关闭完整 Web 分页证据 finding，受影响 Package/Accounting 复审 clean；保留原完整验收边界，不以独立 Node 消费缩窄 Web profile 要求。

### 实施阶段验证命令与证据

下表是阶段命令约定，不等于全部执行记录。C01–C08 实际证据见上节及清单。C02 `.verification/contracts` 公开契约夹具（含流契约增强）保留、不可发布；C07/C08 临时 smoke 已清理。编排器最新实际 typecheck、六文件 72 tests、heavy-gated 已发布宿主回取 smoke PASS；本次记账不运行检查、测试、构建、lint、格式化或提交。区域、真实请求/日志与回取权限/分页 Validation 已勾选。

| 阶段 | 命令 / 场景 | 必须观察的证据 |
|---|---|---|
| C01 | `pnpm install --frozen-lockfile`；`pnpm run typecheck`；`node --experimental-strip-types .verification/foundation-build.ts`；临时最小 ESM 入口由 Node 执行；`pnpm exec tsc --project .verification/tsconfig.json`（首次生成锁文件用 `pnpm install`）；正式入口就绪后才运行 `pnpm run build` | 已观察基础安装、类型检查与 `foundation.mjs` / `foundation.d.mts` / source map 构建、Unicode 执行及严格 NodeNext 最小声明消费（具体类型结果和错误参数）；C01 两个复审视角均 clean、无 findings，已放行，下一块为 C02；不是正式插件产物或完整打包后的包消费。宿主依赖配置外置，完整包消费与宿主契约仍须后续证明。重构建按下述 gate 执行。 |
| C02 | 隔离 `npm install --ignore-scripts`（已成功，540 个包）；`node .verification/contracts/published-contract.mjs`；`node .verification/contracts/interfaces.mjs`（均 PASS） | Node 24.18.0 / CLI 0.2.0-rc.2；真实调用、合法 turn 替换、flush/reopen、请求与派生历史、监听顺序/配对及身份边界均已观察，具体证据见上文和清单 02。02 完成、C02 两个 review pool 视角均 clean、无 findings，已放行，不等于插件集成/完整 Validation；保留不可发布的临时探针夹具至集成测试复用所需契约后再清理。 |
| C03–C05 | 当时 typecheck、regions 23 / blocks 21 / state 10 共 54 tests PASS；真实公开宿主规划/渲染 smoke PASS | seq10 的 12,427 字符被选中，seq16 完整保护，实际引用净估算节省 3,090 token，零新增模型请求；05 与完整区域 Validation 已验证，C05 两个审查视角均 clean、已放行；C06 后续结果见下行。 |
| C06 | 编排器实际 typecheck、59 tests PASS（commands 5 + regions 23 + blocks 21 + state 10）；`node .verification/contracts/commands-smoke.mjs` PASS | 真实插件/CommandRuntime、全部 invariant；pending seq16/cutoff15、原助手 seq8/range15009 JSONL 重开一致；维护占用及重复拒绝；取消 durable、再次重开 last cancelled；零命令/重开模型请求，无提前替换。06 已验证；`6494fd6` 后 `c06-review-1` 与 `c06-review-2` 均 clean、无 findings，C06 已放行，C07 依赖已就绪。临时命令夹具清理，C02 夹具保留。 |
| C07 | 编排器实际 `pnpm install`（compaction 锁同步）、typecheck、63 tests PASS；经 heavy-gate 的 `node .verification/contracts/shake-execution.mjs` PASS；修复后 typecheck、66 tests 与真实宿主 smoke PASS（`artifact://254`） | 真实公开插件 pre-step/实际请求；commandRequests0、nextRequests1、原10/请求17/替换24、removed2/skipped0、估算 saved5598；请求等于派生历史，工具非文本/offload/来源和摘录周边不变，stream 前 durable，JSONL reopenConsistent=true。07/08 与请求/日志 Validation 已验证；两项修复已验证，`56229af` 后 `c07-rereview-1` 与 `c07-rereview-2` 均 clean、无 findings，C07 已放行，C08 依赖已就绪；执行探针已清理，C02 夹具增强保留。 |
| C08 | 编排器实际 typecheck、六文件 72 tests PASS；heavy-gated `node .verification/contracts/read-smoke.mjs` PASS | 真实工具 dispatch237；commandAddedRequests0、cleanupAddedRequests1、requestsBefore/After3、reopenedRequests0；Unicode 片段12425/7209精确拼接，jsonlReopen=true、inheritedForkOnly=true。09 与授权/分页 Validation 已验证；`7e317bd` 后 `c08-review-1` 与 `c08-review-2` 均 clean、无 findings，C08 已放行；C09 最新证据与放行状态见上节。仅 smoke 材料清理，published-contract 夹具保留。 |
| C09–C10 | C09 typecheck、七文件 75 tests 与 retained recovery smoke exit 0（`artifact://322`）；C10 full typecheck、八文件 86 tests PASS，heavy-gated retained lifecycle full smoke exit 0（`artifact://345`），全部断言 PASS | C09 已 clean 放行；获准的 `fb74f62` 后 `c10-review-1` 与 `c10-review-2` 均 clean、无 findings，C10 已验证、clean、已关闭放行，C11 依赖已就绪。真实中断/重开/fork、手动与自然自动 compaction、卸载/reload、三类排空、busy/信号取消、后续请求输入顺序、logger durability diagnostics 与共享 runtime 会话隔离；详见对应证据节，不推断 Web 或包消费。 |
| C11 | `pnpm run typecheck`；`pnpm run build`；`pnpm pack`；`tar -tf <实际生成的tgz>`；临时消费者 `npm install --ignore-scripts <tgz绝对路径>`、`node consume.mjs`、`pnpm exec tsc --noEmit` | 替换尖括号为实际产物；临时 `consume.mjs` 和 NodeNext 类型消费文件使用真实公共包入口。消费成功、发布清单/许可正确，无宿主副本或安装期构建。然后按已验证的官方公开安装方法将同一 tgz 安装到隔离 Web profile。 |
| C12 运行时矩阵 | 分别激活 Node 22.19、24、26，记录 `node --version`；每个运行时执行 `pnpm install --frozen-lockfile` 和 `pnpm exec vitest run tests/regions.test.ts tests/session.test.ts tests/recovery.test.ts` | 三个运行时各自结果，不以一个运行时的报告推断其他版本。运行时管理器由可用环境决定，不假设已经安装。 |
| C12 Web | 先 `free -m`、`~/.omp/bin/heavy-gate --status`；通过 `~/.omp/bin/heavy-gate -n 1 -m 6G -- <已核实的官方隔离Web启动命令>` 启动；浏览器也经 gate；实际 UI 操作见 Validation plan 3 | 官方启动/回放适配器命令须由 C02 公开包/文档核实后记录，不猜 flags 或制造不存在的脚本。服务绑定 `127.0.0.1`，单浏览器、截图和实际请求证据，结束关闭浏览器/自有服务。缺适配器或隔离资源即阻塞，不替换为付费模型或单元测试。 |

预期超过 2 GiB 的构建等命令同样通过 `~/.omp/bin/heavy-gate -n 1 -m 6G -- <command>`；有限 gated 命令使用异步执行且无外层 timeout，不规避槽位。每块提交前核对其原验收细节和作用域，最后按清单五个审查切面审完整实现，再综合核对交叉行为。测试、真实运行证据和审查三者不可互相替代；失败时记录具体前提、命令和错误，不声称验收通过。

## Implementation steps

### 1. 建立固定版本的独立插件工程

采用单包结构：

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件入口、依赖声明、命令与生命周期注册 |
| `src/config.ts` | 阈值及读取限额的配置 schema |
| `src/regions.ts` | 候选区域识别、保护规则、净节省计算 |
| `src/blocks.ts` | 代码围栏/XML 的纯文本扫描 |
| `src/state.ts` | 控制记录 schema、宿主状态投影、恢复判定 |
| `src/shake.ts` | 计划选取、替换提交、持久化与结果统计 |
| `src/recovery.ts` | 受限原文回取工具 |
| `tests/` | 策略、会话恢复、授权边界测试 |
| `cordis.patch.yml` | bundle 插件注册 |
| `package.json`、构建配置 | ESM 构建、类型声明和发布文件清单 |

依赖规则：

- 共享实例的 Cordis、DSH 服务包放入 `peerDependencies`，并镜像到开发依赖。
- DSH peers 固定到已验收版本；不使用宽泛版本范围掩盖预览版兼容风险。
- 构建时将宿主依赖外置，不打包另一份 Cordis 或 Session 服务。
- 使用独立的 TypeScript/tsdown 配置，不依赖 Harness monorepo 的相邻目录。
- 若移植 OMP 扫描代码，保留其 MIT 版权及许可声明。

先用**已发布的 npm 包**核对上述公开导出和最小加载路径；验收对象不能仅是源码 checkout。

### 2. 实现可预测的文本选择策略

一次读取当前 surface，并取得一次 token 测量，避免逐节点反复测量整个会话。

选择流程：

1. 从后向前累计 token，确定完整消息级的最近保护窗口。
2. 排除用户、系统、开发者消息和插件控制记录。
3. 排除错误工具结果、`shake_read` 回取结果及已处理内容。
4. 对工具结果按文本合计估算判断 1,000-token 门槛。
5. 对纯文本助手消息扫描至少 400-token 的完整代码围栏/XML 块。
6. 生成占位符和摘录文本，核算替换后的实际文本规模及估算 token。
7. 净节省不为正则放弃该替换。

扫描边界：

- 不跨消息或 content block 匹配。
- 未闭合结构不处理。
- 不扫描工具参数或普通长段落。
- 保留未选中的文本和原顺序。
- 文本截取不破坏 Unicode 字符。

候选记录只保存原事件编号、块编号、范围及一致性校验信息，不复制原文。

### 3. 实现持久化控制状态和命令

在 `MessageSourceMap` 中定义插件自有来源，区分控制记录与历史摘录；不新增 Session 事件名。

控制元数据包含：

- schema 版本。
- 操作标识、所属会话。
- 选取历史的截止位置。
- 本次策略参数快照。
- 候选区域及原内容校验信息。
- 完整的当前控制状态和最近一次结果摘要。

通过 Host-only 状态投影读取当前待执行请求；历史操作的恢复凭据留在原始日志中，不在内存维护无限增长的操作清单。

`/shake`：

1. 严格检查参数和附件。
2. 使用 `runMaintenance()` 占用空闲阶段。
3. 已有待执行请求时返回现有状态，不重复创建。
4. 没有候选内容时直接返回“无需清理”，不增加控制消息。
5. 追加请求记录并调用 `ctx.sessions.flush(session)`。
6. 确认持久化后返回“已安排，将在下一次模型请求前执行”。

`/shake cancel`：

- 只取消未开始的请求。
- 空闲状态下完成取消和持久化。
- 没有待执行请求时返回明确的无操作结果。
- 不恢复已经发生的替换。

命令忙碌、参数错误或保存失败时返回错误，不伪报成功。

### 4. 在请求发送前提交合法替换

注册 `agent/pre-step` 前置监听器，使本插件先于固定版本的内置自动 compaction 检查执行。

执行流程：

1. 读取属于当前会话的待执行请求。
2. 重新读取当前 surface，核对候选身份、内容校验信息和保护边界。
3. 已被其他操作替换的候选不追着新内容继续裁剪。
4. 识别中断前已经落地的替换，避免重复处理。
5. 提交剩余合法替换。
6. 写入完成结果并 flush。
7. 调用 `next()`，让原有请求流程继续。

两类替换分别处理：

**工具结果**

- 从 `session.deriveEventMessage()` 获取有效内容，保留已有图片 offload 等状态。
- 只修改文本，其他事件数据保持一致。
- 使用原生 `tool/result` 单节点替换。
- 通过 `sourceEventSeqs` 同时引用原结果和本次请求记录，建立可追踪凭据。
- 沿用原生 `compaction/prune` 与替换相邻写入的计量协议。

**助手纯文本**

- 保留非目标文本，目标区域改为带回取引用的占位符。
- 用明确标注“历史助手摘录”的 `user/message` 替换原节点，不伪造新的模型回答或流记录。
- 使用公开的工具配对边界检查，拒绝会破坏调用/结果关系的替换。

不制造虚假 turn，不重写原日志，不直接操作模型缓存；让宿主根据 surface generation 变化建立新的请求序列。

### 5. 实现 `shake_read` 受限回取

使用 `defineTool()` 注册一个工具，输入为：

- `ref`：占位符中的片段引用。
- `offset`：片段内的 Unicode 字符偏移。
- `limit`：默认 2,048，最大 4,096 个 Unicode 字符。

返回原文窗口、当前位置、下一位置和结束标志。

授权流程：

1. 从 `exec.agent` 获取当前会话，不接受调用者传入会话 ID 或文件路径。
2. 读取引用对应的插件请求记录。
3. 验证记录来源、schema 和区域索引。
4. 通过 `traceEvent()` 核实存在实际替换凭据。
5. 只读取该操作实际移除的原文范围。
6. 尊重调用取消信号，并保持输出有界。

拒绝任意事件读取、其他会话引用、待执行但尚未移除的片段和伪造引用。

回取结果不再被本插件清理，避免“读取后又移除”的循环。

### 6. 完成恢复、取消和卸载语义

- **重启恢复**：从宿主日志和状态投影恢复请求；只有下一次自然请求到来时才继续执行。
- **部分完成**：以实际替换事件为准重建进度，不假装拥有跨事件事务或自动回滚。
- **执行失败**：停止此次发送前流程，明确报告已经发生的变更；不静默继续，也不增加自动重试机制。
- **会话 fork**：不在子会话自动执行继承自父会话的待处理意图；已完成的减重历史正常继承。
- **继承后的回取**：只允许读取子会话自身已继承的原文和凭据，不转而查询父会话。
- **插件卸载**：先撤销入口，再等待已启动操作退出；已落地的替换继续可由宿主解释。卸载后原文仍在，但专用回取工具不再可用。
- **后续 compaction**：即使控制消息离开当前 surface，原始日志中的状态与恢复凭据仍有效。

### 7. 完成打包和使用文档

发布内容包括构建后的 JS、类型声明、bundle patch、README 和必要许可文件。

文档明确：

- 安装、启用和移除方法。
- `/shake` 的延迟生效语义。
- `/shake cancel` 的限制。
- 默认阈值、保护内容和估算误差。
- `shake_read` 使用方式。
- 与 OMP、Harness `/compact` 的区别。
- 重启、fork、卸载及部分失败行为。
- 精确支持的宿主版本。

以 `pnpm pack` 生成的 tgz 做安装验收；运行时不要求执行 `prepare` 等安装期构建脚本。更新 CHANGELOG，实际 npm 发布不在本次范围内。

## Validation plan

### 1. 纯逻辑测试

覆盖真正影响用户行为的边界：

- 最近保护窗口边界及跨边界完整消息。
- 1,000/400-token 门槛和占位符导致无净节省。
- 用户、系统、开发者、错误结果和回取结果保护。
- 多块文本与图片混排。
- 含 thinking/tool-call 的助手消息不转换。
- 多个代码块、嵌套 XML、未闭合结构、Unicode 边界。
- 重复处理不产生第二次裁剪。

### 2. 真实 Session 与持久化契约测试

使用固定版本的实际 Session、AgentLoop、命令、持久化和 invariant 组件：

- `/shake` 本身产生 **零模型请求**。
- 下一次请求前替换生效，工具配对完整。
- 实际请求与 `deriveMessages()` 一致。
- 重启前后派生上下文一致。
- 请求记录、部分替换和完成记录附近的中断恢复。
- 重复命令、取消、忙碌拒绝、flush 失败。
- 与内置 pruner、手动/自动 compaction 共存。
- fork、插件卸载与重新加载。
- 回取权限、越界参数、伪造引用及分段原文一致性。

纯逻辑与契约测试覆盖 Node.js 22.19、24、26，沿用宿主已采用的运行时矩阵。

### 3. 实际 Web UI smoke

使用隔离的 Harness home、临时工作区及真实 tgz 安装，运行实际 Web UI；使用官方回放/测试适配器捕获请求，不依赖付费 API。

验收场景：

1. 产生较旧的大工具结果和助手代码块，并保留足够的近期历史。
2. 输入 `/shake`，看到“已安排”，模型请求计数不增加。
3. 发送正常消息，捕获实际发给适配器的上下文。
4. 确认目标大块消失、保护内容不变、文本规模和估算 token 减少。
5. 通过实际工具调用路径执行 `shake_read`，核对分段拼接后的原文。
6. 重启后继续会话，重复确认减重状态及回取功能。
7. 在界面验证忙碌拒绝、取消和无候选内容提示。

记录界面截图与请求证据；不能只凭单元测试宣告功能完成。浏览器与重构建遵守 `heavy-gate`，使用单浏览器串行验证，服务只绑定 `127.0.0.1`。

### 完成标准

- 可在固定版本 Web profile 中安装、发现并执行命令。
- 减重不额外调用模型。
- 所有指定保护规则成立。
- 上下文、日志、重启恢复保持一致。
- 原文回取准确且不能越权。
- 无宿主补丁、私有路径依赖或安装期构建要求。

## Limitations & deviations

### 已接受的功能与运行限制（limitations）

以下是当前方案的边界及代价，不是未解决的问题或承诺的后续功能。日志可重建、工具调用配对和原文回取授权仍是必须满足的正确性要求，不作为兼容性妥协。

| 限制 | 对使用者和实施的具体影响 | 决策依据 |
|---|---|---|
| 不保证一定有内容可清理 | 用户大段输入、最近保护窗口、错误结果、助手混合消息可能占据大部分上下文；返回“无需清理”是合法结果，不应为达到回收量而突破保护规则 | D5、D8 |
| 不是通用长文本压缩器 | 助手侧只识别达到门槛的完整代码围栏/XML；不扫描普通长段落、工具参数或未闭合结构，也不判断某段内容在语义上是否已经无用 | D2、D8及既定扫描边界 |
| 不处理助手混合消息 | 助手消息只要含 thinking、图片、工具调用或其他非文本块，整条不转换；但工具结果中的文本仍可独立处理并保留其非文本块，不能把这两条规则混为一谈 | D2、D4、D5 |
| 生效有等待阶段 | `/shake` 成功表示请求已持久化，不表示上下文已经缩小；没有下一次自然模型请求就不会执行，插件不会为此额外唤醒模型 | D4 |
| 忙碌时不能提前排队 | 命令会拒绝；空闲时受理后进入待执行状态，与“运行中命令排队”是不同概念 | D9 |
| 只有取消，没有完成后撤销 | `/shake cancel` 不恢复已提交的替换；部分完成也不具有跨事件事务回滚。原文仍可读，但没有恢复整个历史 surface 的命令 | D6、D9及既定恢复语义 |
| 不减少原始日志占用，不安全擦除数据 | 原事件保留，追加控制和替换事件还可能增加存储；上下文减重不等于日志变小、进程内存等比例下降或敏感信息被删除 | D1、D6 |
| 模型 surface 与聊天展示不是同一对象 | 原始聊天事件没有被物理删除；不承诺 UI 中的旧输出同步消失或折叠，也不把命令受理提示当作完成提示 | D3、D4 |
| “不调用模型”不等于零新增 token | 命令直接返回不进入模型历史，但控制说明、占位符、摘录及 `shake_read` schema 有开销；回取原文会重新增加上下文，旧前缀改写也可能损失 KV cache 复用 | D2、D6、D8 |
| token 数与收益是估算 | 4,000-token 保护按完整消息执行，不是恰好保留 4,000 个 token；中文、JSON 和不同模型的密度不同。净节省不保证精确计费下降、延迟下降或任务质量不受影响 | D5、D8 |
| 不接管宿主其他减重行为 | 本插件不动用户消息、thinking 等，不代表宿主自身的 compaction 永远不会处理这些内容；清理后仍有压力时，宿主原有压缩行为继续有效 | D2及既定共存边界 |
| 回取能力依赖当前会话日志与插件 | 只读当前会话中有实际替换凭据的片段，包括已继承的原文；不追读父会话或其他会话。卸载插件后专用工具消失，原始日志被删除后也没有插件自建备份可用 | D6及既定 fork/卸载语义 |
| 支持范围与验证范围有限 | 正式支持 Web UI 和固定宿主版本；没有 Desktop、SDK、ACP、图片/thinking 清理或自动触发的交付承诺。当前文档不构成已运行验证的证据 | D1–D3、D7 |

### 相对 OMP `/shake` 的明确偏离（deviations）

比较基线是已调研的 OMP 提交 `14c97b555b206231290f46882794c8d8c3c024b1`，重点为手动默认 `elide`，不是对以后版本的推断。算法依据见前述 [`shake.ts`](https://github.com/can1357/oh-my-pi/blob/14c97b555b206231290f46882794c8d8c3c024b1/packages/agent/src/compaction/shake.ts)，模式、artifact 与持久化行为见 [`session-maintenance.ts`](https://github.com/can1357/oh-my-pi/blob/14c97b555b206231290f46882794c8d8c3c024b1/packages/coding-agent/src/session/session-maintenance.ts)。

| 维度 | OMP 参考行为 | 当前方案 | 偏离原因与代价 |
|---|---|---|---|
| 集成和模式覆盖 | 原生 `AgentSession.shake()`；除默认 elide 外还有独立 images/thinking 模式，并存在自动 shake 路径 | 外部 Host 插件，只交付手动文本减重 | D1、D2；不搬运整个 OMP 运行时，也不宣称功能全集等价 |
| 执行时机 | 手动路径直接执行清理并重建当前上下文 | 空闲时受理，下一次自然模型请求前提交 | D4、D9；遵守 Harness 的 turn 内工具结果替换要求，增加待执行和恢复状态 |
| 大块文本的来源范围 | 可扫描 user、developer、assistant、custom 消息中的符合条件文本块 | 用户、系统、开发者消息不动，只转换合格的助手纯文本消息 | D5；保留用户要求和高优先级指令，回收范围更窄 |
| 助手消息结构 | 在原消息文本内替换选中的区域，不将其转换为 user 角色摘录 | 以标注来源的 `user/message` 历史摘录替换助手节点，保留未选中文字 | D1；复用现有合法持久化形式，但保留字面文字不等于保留消息角色语义 |
| 混合助手消息 | 从消息的 text 块中收集区域；默认 elide 不负责移除非文本块 | 含任何非文本块的助手消息整体跳过 | D2、D5；不把推理或 provider replay 信息转成另一种消息形态，可能留下较大的助手代码块 |
| 工具文本门槛与错误结果 | 手动 elide 对旧的非空工具文本没有单条大小门槛；错误结果并非一律受保护 | 文本合计至少约 1,000 token，错误结果全部保护 | D8；减少低收益替换和证据损失，不能期待与 OMP 相同的回收比例 |
| 净收益条件 | 手动预设 `minSavings: 0`，不等同于每次替换都严格缩小 | 加上占位符和摘录开销后必须有净节省 | D8；必要时不处理小区域，不以增加上下文的替换充数 |
| 最近历史窗口 | 手动预设约 4,000 token、完整 entry 保护；非错误 `useless` 结果可绕过该窗口 | 约 4,000 token、完整消息保护，不引入 `useless` 绕过规则；采用 Harness 估算器 | D5、D8；数值接近但估算器、消息边界和例外不同，不能称为同一组选中区域 |
| 专门保护的工具结果 | 手动预设保护 skill/skill 读取，维护层还保护当前计划引用读取；自动预设另保护 artifact 回取 | 明确保护错误结果、`shake_read` 结果和已处理内容，不直接移植 OMP 的工具名及内部 URL 匹配器 | 当前策略不保证通过普通读取工具返回的技能、计划文本全部受保护；不能把角色级指令保护误写为任意工具载入内容保护 |
| 原文回取 | elide 使用操作级 artifact 保存区域，并在占位符中引用 `artifact://`；普通 elide 可在 artifact 保存失败时使用无回取链接的占位符 | 使用原始 Session 事件、替换凭据和受限 `shake_read` 分段读取，不另建 artifact 文件 | D6；读取范围更窄，新增授权与恢复实现；不承诺跨会话读取，也不把无法回取伪装成成功 |
| 持久化形式 | 持久化会话中改写活动分支条目并调用 `rewriteEntries()`，原文恢复依赖保存的 artifact | 只追加已知事件，通过 surface replacement 隐藏旧节点，原始事件保留 | D1；符合 Harness append-only 和日志重建契约，但存储不会随上下文一起缩小 |
| 收尾与缓存 | 原生维护路径重建消息并处理相关 provider session、advisor 状态 | 由 Harness 的 surface generation 和请求序列机制处理；不复制 OMP 私有缓存收尾代码 | 宿主生命周期不同，按 Harness 的请求重建契约验收，而不是照搬内部实现 |

因此，“类似 `/shake`”在本方案中指**无需摘要模型、机械移出重文本、保留周围信息并允许按需找回原文**；不表示命令时机、覆盖内容、消息角色、保护匹配器、回取协议或持久化格式完全一致。

## Risks and mitigations

| 风险 | 缓解措施 |
|---|---|
| 预览版 API 或持久化契约变化 | 固定宿主版本；新版本通过同一契约与 Web smoke 后才扩大兼容范围 |
| 助手摘录改变角色语义 | 仅转换纯文本助手消息，明确标注历史来源；不转换指令、用户输入或工具调用结构 |
| token 估算不准确，尤其中文和 JSON | 复用宿主估算器，始终标注“估算”；同时检查替换文本规模，不宣称精确计费节省 |
| 原文回取增加固定 schema 开销 | 只注册一个工具，不启用五工具的官方查询工具组；输出分段且有上限 |
| 与 compaction 竞争或候选过期 | 固定版本验证监听顺序；执行前重新核对 surface，只处理原候选，不扩大范围 |
| 崩溃或持久化失败造成部分完成 | 原文不删除；依据原生替换与来源关系恢复进度，报告真实结果，不虚构回滚 |
| 长会话查询成本较高 | 复用宿主状态投影；仅存在待执行请求时做选择和提交，回取按需读取，不在每个 turn 扫描全部历史 |
| 插件卸载后回取入口消失 | 使用宿主认识的事件保存所有结果，保证会话仍可打开；文档说明重新安装或人工查阅日志的方法 |
| 改写旧上下文使 KV cache 失效 | 接受这是手动减重的固有代价；只处理达到门槛且有净收益的内容，不做频繁自动改写 |

**最终交付是一套持久化、可追溯、可按需回取原文的上下文减重插件，而不是 `/compact` 的别名或临时请求过滤器。**
