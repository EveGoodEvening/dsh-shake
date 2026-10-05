# Todo List

依据已审查的 [`docs/plan/DESIGN.md`](docs/plan/DESIGN.md)。九组用户决策均已落实；文档中的未选方案仅作为历史记录，不进入实施范围。执行状态以原项目下的验证记录为准。

## Locked decisions

- **交付形式**：独立的 `dsh-shake` Host 插件，提供预构建 npm/tgz bundle；不修改 Harness，不实际上传 npm。
- **兼容基线**：`@deepseek-ai/dsh@0.2.0-rc.2`，对应提交 `639ed015397290b3745d163aafe02ffee4aa3f84`；不声明兼容未经验证的宿主版本。
- **正式入口**：仅 Web UI，复用已有命令发现和通用展示，不新增前端应用或设置页面。
- **命令行为**：空闲时接受 `/shake`，持久化请求，在下一次自然模型请求前执行；忙碌时拒绝，不打断、不排队。
- **请求管理**：每个会话最多一个待执行请求；重复命令不重复创建；`/shake cancel` 只取消尚未执行的请求，不提供完成后撤销。
- **选择范围**：只处理提交命令时选中的历史，不扩展到后来新增或被其他插件改写的内容。
- **默认阈值**：最近约 4,000 个估算 token 按完整消息保护；工具文本合计至少约 1,000 token；助手代码围栏/XML 块至少约 400 token。
- **保护规则**：不处理用户、系统、开发者消息、错误结果、`shake_read` 结果和已处理内容；助手消息含任何非文本块时整条跳过。
- **替换形式**：工具结果仅修改文本内容；合格的助手纯文本转换为明确标注来源的历史摘录。加入占位符和说明后必须仍有净节省。
- **持久化方式**：只追加宿主已认识的事件，复用原始日志、surface replacement 和业务状态投影；不新增 Session 事件类型、数据库或 artifact 存储。
- **原文回取**：只提供一个 `shake_read` 工具，读取当前会话中有实际替换凭据的片段；默认返回 2,048、最多 4,096 个 Unicode 码点。
- **恢复边界**：重启恢复原请求；fork 不自动执行父会话的待处理意图；已继承的原文和替换凭据可在子会话内读取，不追读父会话。
- **非目标**：自动 shake、图片/thinking 清理、摘要模型调用、通用历史搜索、磁盘清理、安全擦除、Desktop/SDK/ACP 支持。
- **共存原则**：不接管宿主已有 compaction；不保证旧聊天展示同步消失、精确计费下降或任务质量完全不变。

## Sequential commit chunks and exact status

**当前状态：C01–C12 均已验证、clean、已放行；C12 最终五面审查门禁完成，未发布 npm。** 原项目实施 01–13 共 13/13、Validation 共 8/8，合计 21/21 完成。C12 基线提交 `d79b08b`，最终 accounting finding 的分页补证修复提交 `515929a`；FinalSelection、FinalExecution、FinalRecovery、FinalPackage、FinalAccounting 最终均 clean，后两者在 `515929a` 后复审 clean。永久 root patch 已有 `config: {}`；矩阵三份包及 Web corrected 包的 patch、manifest、ESM/声明/map 与 root 字节一致，只有 README 历史差异。本次仅文档记账，不改变 exercised runtime，不声称最终新文档 tgz 已重跑，不创建提交。

所有 chunk **严格依次执行**。每一块完成自身可观察验证、范围审查、相应文档/变更记录更新后才可提交和进入下一块；未通过则保留未勾选状态并记录准确阻塞。表中验证名称对应下方原有 Validation 项，其全部细节仍适用。早期仅完成部分覆盖时不能提前勾选整个验证项。

| Chunk / 建议提交主题 | 依赖和原任务 | 独立边界及可观察验证 / 放行条件 |
|---|---|---|
| C01 `chore: establish pinned standalone package` | 起点；01 | 独立工程、锁文件、脚本、外置宿主依赖。隔离安装并构建最小 ESM 入口，消费类型；无 checkout/全局模块依赖。01 仅在独立构建成功后完成。 |
| C02 `chore: verify published host contract` | C01；02，**阻塞门禁** | 隔离消费已发布固定 npm 包，真实调用并重开会话；逐项证明命令、maintenance、pre-step 顺序、合法替换/配对边界、flush/持久化监听、查询、投影、token meter、来源元数据和 invariant。提交兼容性结论到这两个计划文档；02 全通过前不得写宿主相关实现。公开等价入口可用，私有深导入、补丁、关闭校验均不可用。必要能力或可安装的公开依赖缺失即阻塞，不悄悄缩减功能。 |
| C03 `feat: define durable shake state` | C02；03 | 配置、schema-v1、来源类型、范围/引用和 Host-only 投影。真实日志重开恢复相同状态；未知 schema/非法引用不能修改，引用不能单独授权。 |
| C04 `feat: scan closed text blocks` | C03；04；区域验证的扫描部分 | 纯扫描器与 OMP MIT 许可。观察多个围栏、XML、未闭合、Unicode 和不重叠原文范围；不引入运行时。 |
| C05 `feat: select protected profitable regions` | C04；05；区域选择和扫描验证 | 一次 surface/测量、完整消息保护、阈值和实际占位符收益。运行 `tests/regions.test.ts` 全部边界，并用文本夹具展示选中/保留原文与净收益；完整覆盖后才勾选该验证项。 |
| C06 `feat: persist idle shake commands` | C05；06；命令验证的受理部分 | 注册命令、去重、取消、维护占用和 flush。真实命令调用观测零模型请求、零提前替换及落盘后重开待执行状态；错误、无监听器、附件/参数必须按原验收拒绝。并发/信号覆盖在 C10 完成前该验证项仍未完成。 |
| C07 `feat: apply durable replacements before requests` | C06；07、08；真实请求与日志验证 | 替换引擎和 pre-step 同一可运行提交，不暴露未接入的执行入口。捕获真实适配器请求，与 `deriveMessages()` 对照；检查配对、非文本/offload、相邻 prune、来源和净收益。flush 前禁止发送；失败报告已发生变更，不重试。 |
| C08 `feat: authorize bounded shake recovery` | C07；09；回取权限和分页验证 | `shake_read` 与真实工具调用路径。分段拼接精确 Unicode 原文；伪造、跨会话、未执行、缺凭据/日志、非法分页和取消均不泄露。fork 授权在 C09 再复核。 |
| C09 `feat: recover interrupted and forked sessions` | C08；10；持久化/中断/共存验证的恢复部分 | 在请求、部分替换、完成边界中断并重开；比较派生历史和替换数量，compaction 后仍可授权；fork 不执行父意图且不追读父会话。失败不是自动重试，部分完成不是回滚。卸载/重载覆盖等 C10。 |
| C10 `fix: drain cancellable plugin lifecycle` | C09；11；完成命令、持久化/共存、回取验证 | 注销入口后等待已启动操作，尊重所有取消信号，输入顺序不变，注册冲突显式失败。真实卸载/重载并重开宿主日志，观察无退出后写入、重复替换或遗留入口；运行完整 session/recovery 验证，才勾选其相应项目。 |
| C11 `build: deliver prebuilt bundle and usage docs` | C10；12、13；类型/构建/包消费验证 | bundle patch、ESM/声明、发布清单、README/CHANGELOG/许可一致交付。实际 `pnpm pack`，独立 NodeNext 消费和安装 tgz 到隔离 Web profile；核对运行产物、外置依赖、无安装期构建。文档只记录已观察结果，Web 验收声明留到 C12。 |
| C12 `docs: record complete release acceptance` | C11；运行时版本矩阵、实际 Web UI smoke；复核全部 21 项 | 锁文件安装，在 Node 22.19/24/26 完成纯逻辑及真实会话契约；实际 tgz、官方适配器和隔离 Web 完成下方全部 smoke，保存截图/请求/重开/回取证据。完成最终分拆审查后才记录通过并勾选最后验证项；不上传 npm。失败则不交付，不以纯测试替代 Web。 |

**每块审查与状态记录**：提交前按本块边界检查实现/调用者/测试/文档/许可；核对保护规则和原有完成条件，不扩 scope、不留虚假回退，临时探针在相应可观察验证结束后清理；C02 契约夹具保留（包括公开流契约增强），属于不可发布材料。提交号仅在真实提交后记录；C01–C11 已 clean 放行，C09 的两个 re-review 在 `f49e843` 后均 clean，获准的 `fb74f62` 后 `c10-review-1` 与 `c10-review-2` 均 clean、无 findings，获准的 `8251193` 后 `c11-review-1` 与 `c11-review-2` 均 clean、无 findings，不以验证代替审查。本次仅记账，不运行检查、测试、构建、lint、格式化或创建提交。

**最终完整分拆审查**：C12 分别审查 (1) 纯策略与 Unicode 边界，(2) 公共宿主集成、事件配对和发送/flush 时序，(3) 授权/恢复/fork/取消/卸载安全，(4) tgz 内容/依赖/运行时/文档许可，(5) 实际 Web 证据与全部 21 项验收映射。随后综合复核相互作用与九项用户决策；记录具体缺陷和处理，不只复审最后一块。任何未解决的正确性或交付阻塞都禁止最终通过。

**C12 最终审查闭环**：`d79b08b` 后 FinalSelection、FinalExecution、FinalRecovery clean；FinalAccounting finding **“Complete the original Web pagination acceptance before checking it off”** 指出实际 Web 原文完整分页拼接验收缺口，不能把局部回取作为原完成条件通过。`515929a` 补足已安装官方 Web 的 parent 与 seeded fork 各 12 页 limit4096、47167 Unicode points 的真实工具回取，并改保留 verifier 以持久化原事件 region0 为基准，校验实际 provider 工具结果精确拼接、连续 nextOffset、终页 null/done。FinalPackage 与 FinalAccounting 在该提交后均复审 clean、无 findings；五面门禁完整关闭，无未解决正确性或交付阻塞。

**最终活动任务核对**：已逐段重读完整 DESIGN/CHECKLIST；原 13 实施 + 8 Validation 全部已勾选，完成条件映射保留。活动未勾选任务精确列表：`[]`；可做未完成任务 0，阻塞任务 0。历史文字中的 unchecked／未勾选及未选方案仅保留阶段或决策记录，不进入活动清单。

**风险与回退**：C02 是最大前置风险，失败只记录阻塞，不绕过。开发提交可通过后续纠正提交回退本块代码/文档，保持先前已验证边界；未完成块不得装入用户 profile。运行时 `/shake cancel` 仅取消未开始请求；已落地替换不可整次撤销，也不能靠回退代码、卸载、截断日志或编辑原事件假装恢复。中断时保留原日志，报告真实部分完成，以凭据重建；使用隔离验收 profile 避免污染用户会话。打包或 UI 验收失败则不分发该 tgz，修正后重跑受影响验收。

## Implementation tasks

- [x] **01. 建立独立 TypeScript/ESM 工程**
  - **修改位置**：新建 `package.json`、`pnpm-lock.yaml`、`tsconfig.json`、`tsdown.config.ts`、`vitest.config.ts`。
  - 定义 `typecheck`、`test`、`build`、打包所需脚本；构建、测试依赖沿用固定宿主提交的配套版本并锁定。
  - 共享实例的 Cordis、DSH 服务依赖放入 `peerDependencies`，并镜像到开发依赖；DSH peers 固定为 `0.2.0-rc.2`。
  - 构建时外置宿主依赖，不打包另一份 Cordis、Session 或 AgentLoop。
  - **完成条件**：工程可独立安装和构建，不依赖 Harness checkout、相邻 monorepo 目录或开发机全局模块。
  - **已验证（仅 C01 基础）**：编排器运行 `pnpm install` 与 `pnpm install --frozen-lockfile` 成功，安装 118 个依赖；加入 `skipLibCheck` 后 `pnpm run typecheck` 通过。该检查不等于验证宿主依赖声明或公开运行时契约。
  - 使用公开 `tsdown` build API，复用当前配置，仅把入口改为临时 Unicode 工具的绝对路径并设置 `clean: false`；`node --experimental-strip-types .verification/foundation-build.ts` 成功生成 `foundation.mjs`、`foundation.d.mts` 与 source map。Node 实际执行断言 `A😀𠮷Z` 的码点切片 `1:3` 为 `😀𠮷`、`-2` 为 `𠮷Z`。`pnpm exec tsc --project .verification/tsconfig.json` 通过：严格 NodeNext 消费者使用生成的声明，验证具体类型结果及 `@ts-expect-error` 错误参数；`pnpm run typecheck` 通过。这是最小 ESM 工程的构建/运行和声明消费证据，不是插件构建或 `shake_read` 验证。
  - **放行范围及审查状态**：01 按工程基础的安装、最小入口构建与声明消费条件完成；`c01-rereview-1`（验收记账）与 `c01-rereview-2`（工程配置/依赖边界）均复审 clean、无 findings，C01 已放行，下一块为 C02。已补足审查发现的最小类型消费证据；复审为只读审查，未重复运行验证。永久配置仍指向未来的 `src/index.ts`，未添加虚假插件入口。尚未证明正式插件入口构建、完整打包后的独立 NodeNext 包消费、宿主契约、测试或包交付，因此全部 Validation 项保持未勾选。临时 `.verification` 探针与产物已清理，不作为交付文件；未提交。

- [x] **02. 验证发布包的公开接口和持久化契约**
  - **执行位置**：隔离的临时消费项目，使用已发布的固定版本 npm 包。
  - 实际核对命令注册、`runMaintenance()`、`agent/pre-step`、surface replacement、`flush()`、Session 查询、状态投影和 token 估算接口。
  - 验证自定义消息来源元数据能够随现有 `user/message` 保存、恢复；验证工具结果替换在合法 turn 内通过宿主 invariant。
  - **分支规则**：导出位置与源码说明不同但存在公开等价入口时，使用该版本的公开入口；必要能力缺失时，将兼容性检查判为失败并阻止交付，不改用私有路径、关闭校验或修改宿主。
  - **完成条件**：固定发布包上的真实调用和重开会话均成功，而不只是类型声明能够导入。
  - **已验证（C02，clean、已放行）**：编排器报告隔离 `npm install --ignore-scripts` 成功，安装 540 个包；`node .verification/contracts/published-contract.mjs` PASS，Node **24.18.0**、已安装 CLI **0.2.0-rc.2**。真实工具分发产生初始 2 次模型请求，命令产生 0 次，下一次自然输入后累计 3 次；实际适配器请求等于当时派生消息。原工具结果 seq **10**、控制记录 seq **17**、相邻 prune seq **22** / replacement seq **23**；真实 invariant 启用，合法 pre-step 内替换通过，原日志与工具身份保留。JSONL flush 为 `true`，重开后派生历史、来源元数据、投影和 token 测量恢复；无持久化监听器 flush 为 `false`。
  - **公开接口补充探针**：`node .verification/contracts/interfaces.mjs` PASS，真实 maintenance 独占/取消、命令附件拒绝和取消、来源元数据、Host-only schema-v1 投影、不可变 token 测量、查询/trace、prepend 委托顺序与工具身份/来源拒绝边界通过。公开入口和具体返回形状记于 `DESIGN.md`；trace 是来源图，不是授权凭据。
  - **证据与范围**：`.verification/contracts/published-contract.mjs`、`.verification/contracts/interfaces.mjs` 保留至集成测试复用所需契约后再清理，属于不可发布的临时夹具，不进入 tgz；本块只证明固定发布包公共契约，不证明 `/shake` 插件实现、完整 Validation 项、其他 Node 版本或 Web。两个 C02 review pool 视角均 clean、无 findings，C02 已放行，未提交；C03 结果另记于 03。

- [x] **03. 定义配置、持久化状态和片段引用**
  - **修改位置**：`src/config.ts`、`src/state.ts`。
  - 配置默认值落实为 4,000/1,000/400-token 门槛；不暴露绕过用户消息、错误结果等硬保护的开关。
  - 在 `MessageSourceMap` 中区分插件控制记录和助手摘录；schema 从版本 1 开始。
  - 请求记录包含操作标识、所属会话、历史截止位置、策略快照、候选范围及原内容校验信息，不复制原文。
  - 区域记录明确原事件、块编号、范围和校验摘要；内部字符串范围采用首端包含、末端不包含的索引，回取 API 的偏移统一按 Unicode 码点计算。
  - 片段引用包含格式版本、操作标识、请求事件编号和区域编号；引用本身不是授权凭据。
  - 注册 Host-only `ctx.sessionProjections` 单元，保存完整的当前待执行状态及最近结果；无关事件返回原状态引用。
  - **完成条件**：状态可以完全从日志重建；不维护无限增长的内存操作清单；未知 schema 和非法引用不会进入修改路径。
  - **已验证（C03，clean，已放行）**：编排器运行 `pnpm install`，将直接依赖与实际宿主使用的 Zod **4.6.5** 对齐；`pnpm run typecheck` PASS；`pnpm exec vitest run tests/state.test.ts` **5 tests PASS**。未知 schema、非法引用、范围及校验信息等状态边界由本块测试覆盖；不等于回取授权已实现。
  - **真实运行证据**：通过公开 tsdown build API 构建临时 `.verification/state-smoke.ts`，Node 执行 `.verification/state-smoke.mjs` PASS；使用真实公开 Session、SessionProjectionRegistry 和 JSONL 持久化，teardown 后重新打开恢复相同待执行请求；原生 seeded child 会话抑制父会话 pending，**零模型请求**。只证明本块状态恢复/继承边界，不证明 C09 的实际替换、授权或完整 fork 恢复。
  - **范围与清理**：配置默认门槛为 4,000/1,000/400，回取限额默认 2,048、最大 4,096；内部原文范围为半开 UTF-16 索引，SHA-256 校验原选中子串的 UTF-16LE 字节，回取 API 偏移仍为 Unicode 码点。引用只是定位信息，不授予读取权限；投影仅保留当前请求和最近结果，无关事件保持状态引用。临时 `state-smoke.ts` / `state-smoke.mjs` 已清理，C02 probes 保留；本块两个复审视角均 clean、已放行、未提交，所有完整 Validation 项仍未勾选。
  - **C03 review 修复及 clean 复审（已放行）**：修复规范引用正则尾部终止符可被接受的问题，严格拒绝尾随 `\n`、`\r`、`\r\n`、U+2028、U+2029。编排器报告修复后 `pnpm run typecheck` PASS、`pnpm exec vitest run tests/state.test.ts` **10 tests PASS**；编译后的公共 `formatShakeRef` / `parseShakeRef` 运行 smoke PASS，全部 5 种尾随终止符均被拒绝，合法引用 roundtrip 成功。临时 `.verification/ref-smoke` 输出已清理；这些结果只证明 C03 引用边界修复，不代表回取授权或完整 Validation 通过。`c03-rereview-1` 与 `c03-rereview-2` 均 clean、无 findings，C03 已放行，下一块为 C04；未提交。本次仅更新 tracker，未运行测试、构建、lint 或格式化。

- [x] **04. 实现代码围栏/XML 区域扫描**
  - **修改位置**：`src/blocks.ts`，以及对应第三方许可文件。
  - 从固定 OMP 提交提取纯文本扫描逻辑，适配为字符串和区域范围输入输出，保留 MIT 版权及许可。
  - 不引入 OMP 运行时、Session 类型或工具保护匹配器。
  - 不跨消息或 content block 匹配；忽略未闭合结构；围栏内部不重复识别 XML；输出不重叠区域。
  - **完成条件**：扫描器无 I/O、不修改输入，返回稳定的原文范围，能够安全执行倒序替换。
  - **review 修复及 clean 复审（已放行，未提交）**：四个 scanner findings 已修复：围栏闭合须相同 delimiter、长度不少于开头且后缀仅为空白；错配 XML 使整个候选失效，匹配关闭只排空原栈，不能复活候选，原栈未排空时保守抑制后续 XML；comments/CDATA literal span（含未闭合）抑制其中的标签与围栏，围栏内部 literal delimiter 不影响后续 XML；第四个 mixed literal 边界 finding 保守处理 literal span 所在行的边界外内容，使活动 XML 候选失效，拒绝畸形结构而保留合法外层 XML。保留 OMP derived/adapted 归属和 MIT 许可，不声称完整 Markdown/XML parser。编排器实际报告最新修复后 typecheck PASS、**31 tests PASS**；mixed comment/CDATA 边界 runtime smoke PASS，拒绝畸形结构并保留合法外层 XML。`c04-final-rereview-1` 与 `c04-final-rereview-2` 两个复审视角均 clean、无 findings，C04 已放行；04 保持已勾选，下一块为 C05，尚未执行。本次文档记录未重复运行检查、构建、测试、lint 或格式化，未创建提交。完整「运行区域选择和扫描测试」Validation 项保持未勾选。
  - **固定来源及许可**：`src/blocks.ts` 改编 OMP `packages/agent/src/compaction/shake.ts` 的 `scanTextForBlockRanges` / `mergeRanges`，固定提交 `14c97b555b206231290f46882794c8d8c3c024b1`；源文件注明 MIT，`THIRD_PARTY_NOTICES.md` 保留完整许可及 Copyright (c) 2025 Mario Zechner、Copyright (c) 2025-2026 Can Bölük、Copyright (c) 2026 Stencil Labs, Inc.，未引入 OMP 运行时。
  - **扫描限制**：单字符串、半开 UTF-16 原文范围，包含开闭行及缩进、不包含闭合行末 LF。基于固定来源改编并收紧闭合条件，不是完整 Markdown/XML 解析器；XML 开标签仍须无缩进、整行小写 `[a-z_-]+` 名称，闭标签允许缩进。严格围栏闭合、畸形 XML 候选失效和 comments/CDATA 抑制规则见上方 review 修复记录；未闭合结构不输出范围，未排空的畸形 XML 原栈保守抑制后续 XML，literal span 外仍可识别独立完整围栏，围栏内不识别 XML。输出按原文顺序且不重叠。不能据此宣称支持一般 XML、所有 Markdown 围栏语法或候选保护/收益策略。

- [x] **05. 实现候选选择和净收益计算**
  - **修改位置**：`src/regions.ts`。
  - 每次规划读取一次当前 surface、取得一次 token 测量；从尾部累计并保护跨越 4,000-token 边界的完整消息。
  - 工具结果按文本合计判断门槛；助手只扫描纯文本消息中的合格围栏/XML。
  - 排除用户/指令消息、控制记录、宿主标记的错误结果、回取结果和已有处理凭据的区域。
  - 不引入 `useless` 绕过规则，不根据文本中的 “error” 猜错误，也不照搬 OMP 的 skill/plan 工具名保护。
  - 将占位符和摘录说明计入收益；替换不缩小则不选取。执行阶段再使用实际引用文本复核。
  - **完成条件**：选择结果确定、范围有界；无候选是合法结果；不为增加回收量突破保护规则。
  - **C05 clean、已放行，完整区域验证通过，未提交**：`c05-review-1` 与 `c05-review-2` 两个审查视角均 clean、无 findings；05 与完整区域 Validation 已验证并保持勾选；后续 C06 结果见 06。`planShakeRegions` 一次 surface/测量，返回截止位置、候选、完整保护消息和估算净收益；`renderShakeMessage` 使用实际规范引用复核原文校验、码点规模及消息估算收益，无收益或过期返回 `null`。这里只规划/渲染，不追加替换、不接入 pre-step，C07 必须提交前再次复核。
  - **编排器提供的最新实际结果**：typecheck PASS；54 tests PASS（`tests/regions.test.ts` 23、blocks 21、state 10），已包含完整策略覆盖及类型正确的宿主事件/开发者消息夹具。本次记账不重复运行这些命令。
  - **真实公开宿主 smoke PASS（exit 0，编排器已实际执行）**：旧工具结果 seq **10** 的 **12,427** 字符文本被规划选中，近期 seq **16** 被完整保护且保持不变；使用实际引用渲染后估算 `savedTokens=3090`，新增模型请求 **0**。仅证明规划/渲染，不是实际追加替换或下一次请求发送；临时 `.verification/regions-smoke.ts` / `.mjs` 已清理，C02 契约夹具保留。
  - **此前完整验证缺口已补齐**：最近窗口跨界累计 4,050 时保护完整消息；control/excerpt 独立来源夹具在零门槛下仍保护合格文本；渲染后的助手消息与带控制来源的工具结果不再裁剪；多个围栏及嵌套外层 XML 在候选/渲染层精确保留普通 Unicode 文本和未达门槛围栏。工具 999/1,000 与助手 399/400 门槛已明确覆盖；现有无净收益、角色/错误/回取保护、混合消息、未闭合与 Unicode 断言保留。原区域 Validation 的全部 criteria 已覆盖，故该项勾选；C05 两个审查视角均 clean、已放行，不外推其他 Validation。

- [x] **06. 实现 `/shake` 和 `/shake cancel`**
  - **修改位置**：`src/index.ts`、`src/shake.ts`、`src/state.ts`。
  - 通过 `ctx.commands.register()` 注册命令，只接受空参数或 `cancel`，不接受附件；其他输入返回用法错误。
  - 两条路径均使用 `runMaintenance()` 原子占用空闲阶段。
  - `/shake` 对已有请求返回现状；无候选时不追加控制消息；有候选时追加请求并等待 `ctx.sessions.flush()`。
  - `/shake cancel` 持久化取消结果；没有待执行请求时返回明确的无操作结果。
  - 区分“已安排”“无需清理”“已取消”“忙碌”和“保存失败”，不把受理提示写成完成提示。
  - **完成条件**：命令不唤醒模型、不裁剪历史；重复调用不产生重复请求；flush 失败或无持久化监听器时不返回持久化成功。
  - **C06 已验证、clean、已放行**：`6494fd6` 后 `c06-review-1` 与 `c06-review-2` 两个审查视角均 clean、无 findings。编排器实际 typecheck PASS、59 tests PASS（commands 5 + regions 23 + blocks 21 + state 10）。真实已发布固定宿主包上的插件及 CommandRuntime 启动成功，Session、Agent、AgentLoop、Commands invariant 全部启用；命令 smoke PASS。待执行请求 seq **16**、历史 cutoff **15**，原助手事件 seq **8**、选中范围长度 **15,009**；JSONL 持久化并重开后 pending 完全相同。重复命令拒绝，不追加请求；maintenance 占用时 `/shake` 和 `/shake cancel` 均拒绝。取消落盘后再次重开，current 为 null、lastResult 为 cancelled；命令新增模型请求 **0**、重开新增 **0**，原文仍存在，无提前替换。初始自然输入产生的 1 次模型请求不计为命令调用。
  - **历史阶段说明**：以下 C06 范围记录中的完整命令 Validation 未勾选是当时状态；C10 已补齐并验证，见 11 与 Validation。
  - **范围与清理（C06 阶段记录）**：C06 仅验证持久化命令边界；替换/pre-step 的后续 C07 证据见 07、08。完整命令 Validation 保持未勾选，取消信号、维护期间正常输入顺序及替换开始后的生命周期仍待 C10。临时 commands-smoke.ts / contracts/commands-smoke.mjs 已清理，C02 夹具保留；本次记账未运行检查、测试、构建、lint、格式化或创建提交。

- [x] **07. 实现工具结果和助手摘录替换**
  - **修改位置**：`src/shake.ts`。
  - 工具结果从 `session.deriveEventMessage()` 获取有效内容，只修改选中的文本，保留图片 offload 状态、其他非文本块、调用身份、错误字段和元数据。
  - 使用 `tool/result` 单节点替换；`sourceEventSeqs` 同时引用原结果与请求记录。
  - 按宿主协议同步、相邻地追加 `compaction/prune` 和工具结果替换记录，中间不插入异步操作。
  - 助手纯文本保留未选中文字，以标注“历史助手摘录”的 `user/message` 替换原节点；使用公开工具配对边界检查。
  - 每次提交前重验当前节点、原内容校验信息和净收益；过期候选只能跳过，不能重新选取其他内容。
  - **完成条件**：原始事件不变；工具调用配对完整；每个实际移除区域都有可核验的来源关系和回取引用。
  - **C07 已验证、clean、已放行**：编排器实际 `pnpm install` 完成 compaction 锁文件同步，typecheck PASS、63 tests PASS；heavy-gate 下真实已发布宿主插件请求 smoke PASS：`commandRequests=0`、`nextRequests=1`，原工具 seq **10**、请求 seq **17**、替换 seq **24**，`removed=2`、`skipped=0`、估算 `savedTokens=5598`。配对、工具特殊非文本/offload/元数据及助手摘录未选中周边文本断言 PASS；实际移除区域具有原事件/请求来源与引用。原文只在宿主原始日志中保留，状态存引用/范围/校验摘要，不复制原文。
  - **C07 review 修复最新证据与放行**：typecheck PASS、66 tests PASS；编译后 heavy-gated 真实宿主 smoke PASS（`artifact://254`），occupied **10033 → 6958 → 5007**。助手替换前按原助手消息计价的 prune 同步相邻追加，实际请求减重断言通过。两项 reviewer findings 已修复并验证；`56229af` 后 `c07-rereview-1` 与 `c07-rereview-2` 均 clean、无 findings，C07 已放行，下一块 C08 依赖已就绪。

- [x] **08. 接入下一次请求前的执行流程**
  - **修改位置**：`src/index.ts`、`src/shake.ts`。
  - 注册前置 `agent/pre-step` 监听器，在固定版本的内置自动 compaction 检查前处理待执行请求。
  - 无 current 时不读取整份历史；同会话最近结果为 completed 时，仍先 flush 确认 terminal-null 完成状态，再委托。
  - 有请求时重验候选、识别已经落地的替换、提交剩余替换；先写 completed/current 保留并 flush，再写 completed/current=null 并 flush，然后调用 `next()`。
  - 保留原有输入消息和后续监听器的返回决策，不自行调用 `followup()`、构造虚假 turn 或改写发送中的 messages。
  - 失败时停止本次发送前流程并报告真实变更，不静默继续或自动重试。
  - **完成条件**：第一次受影响的实际模型请求已使用减重后的派生历史；持久化完成前不放行发送。
  - **C07 已验证、clean、已放行**：捕获的下一次实际适配器请求与派生历史一致，重文本退出请求、保护内容不变、文本及估算 token 减少；在 `llm/stream` 可见前已确认原始日志及替换 durable，JSONL 重开 `reopenConsistent=true`。实际公共 `agent/pre-step` 是 Promise waterfall，`llm/stream` 是 AsyncIterable waterfall，探针用 async generator 委托；不虚构 `before-step-prepared` 事件。临时 `.verification/execution-smoke.ts` / `.verification/contracts/shake-execution.mjs` 已清理，C02 公开夹具增强保留。无 Web、pack 或回取/中断恢复验收声明。
  - **C07 completion 修复证据与代价**：staged completion 与 clear 两边界 × live/reopen 四组合在 abort+flush rejection 下均无取消后 append、无提前请求，随后自然请求恢复成功。staged 完成恢复先确认 flush 再 clear；同会话 terminal-null/completed 结果存在时，每个后续自然 step 都 flush，而非依赖 process-local durability flags。仅证明本次完成门禁修复，不勾选 C09/C10 恢复、fork 或完整生命周期 Validation。仅删除 `.verification/execution-fix-smoke.ts` / `.mjs`，C02 夹具保留；C07 双复审 clean、已放行，插件未发布。

- [x] **09. 实现 `shake_read`**
  - **实际修改位置**：`src/read.ts`、`src/index.ts`；候选来源保护前提在 `src/regions.ts`。
  - 使用 `defineTool()` 注册一个工具，参数为 `ref`、`offset`、`limit`；默认偏移 0、默认长度 2,048、最大长度 4,096 个 Unicode 码点。
  - 返回原文窗口、当前偏移、下一偏移和结束标志；拒绝负数、非整数、非法长度和超出原文范围的偏移；恰好到达末尾返回空窗口及结束标志。
  - 只从 `exec.agent` 获取当前会话，不接受会话 ID、路径或直接事件编号作为独立读取权限。
  - 使用 `readEvent()`、`traceEvent()` 验证请求来源、schema、区域和实际替换凭据，再读取被移除范围。
  - 尊重 `exec.signal`，不返回整条原事件、其他文本块或邻近内容。
  - **完成条件**：合法引用可分段还原精确原文；伪造、未执行、其他会话引用均不能越权读取。
  - **C08 已验证、clean、已放行**：编排器当时 typecheck PASS、六文件 72 tests PASS；heavy-gated 已发布宿主真实工具 smoke PASS：`commandAddedRequests=0`、`cleanupAddedRequests=1`、`readDispatches=237`、`requestsBefore=3`、`requestsAfter=3`、`reopenedRequests=0`；精确还原两片段长度 **12425 / 7209**，`jsonlReopen=true`、`inheritedForkOnly=true`。`7e317bd` 后 `c08-review-1` 与 `c08-review-2` 均 clean、无 findings；C09 最新恢复证据见 10。
  - **授权实现**：ref 仅定位；捕获 `exec.agent.session`，所有 `readEvent`/`traceEvent` 只查询该 session ID。请求控制 schema、操作/请求/区域身份、原日志、实际替换及原文/请求的精确双来源 lineage、重渲染结果和摘录来源全部匹配；选中 UTF-16 范围的 SHA-256/UTF-16LE checksum 精确核验。继承凭据须在真实 seeded prefix 内，不追查父或兄弟会话。每次 await 后检查取消及 session 未变。
  - **分页与前提**：offset/limit 为 Unicode 码点；默认 2048、最大 4096，非法分页拒绝，末尾合法空页，拼接精确保留 Unicode。候选 provenance 保护依赖 `ShakePlannerServices.sessionQuery` 的 `Pick` 明确包含 `readEvent`（以及 `readSurface`/`traceEvent`），沿实际来源排除控制/摘录和回取内容，不能仅凭名字或 ref 授权。仅清理 read-smoke.ts 与 contracts/read-smoke.mjs/.map，保留 published-contract 夹具；本次不运行检查、测试、构建、lint、格式化或提交。

- [x] **10. 完成重启、部分完成及 fork 恢复**
  - **实际修改位置**：`src/execute.ts`、`tests/recovery.test.ts`；复用状态投影及回取授权。
  - 重启只恢复状态，不立即执行；下一次自然请求到来时恢复原操作。
  - 以实际替换事件识别已完成部分，避免重新提交替换；明确记录过的失败不触发自动重试。
  - 控制消息被后续 compaction 移出 surface 后，仍能通过原始日志恢复状态和授权凭据。
  - 子会话不执行父会话遗留的待处理意图；允许读取自身已继承的原文及凭据，不查询父会话。
  - **完成条件**：恢复不会扩大候选集合、重复裁剪或丢失已发生的变更；部分完成不被描述为整体回滚。
  - **C09 已验证、双复审 clean、已放行**：`f49e843` 后 `c09-rereview-1` 与 `c09-rereview-2` 均 clean、无 findings。编排器实际 typecheck PASS、七文件 **75 tests PASS**；heavy-gated recovery-smoke exit 0（`artifact://297`），全部断言通过，最新保留夹具 smoke 见下文 `artifact://322`。pending 重开 `pendingReopenRequests=0`，下一自然 turn 完成 2 区域；部分替换 `interruptedAt=24`，重开 `duplicateToolReplacements=0`、完成 2 区域，冻结请求保持一致。失败重开 `failedAutomaticRequests=0`、`failedAutomaticReplacements=0`，状态仍 failed；不回滚已提交变更。
  - **fork 与完成边界**：`inheritedPendingExecuted=false`、`parentUnaffectedByChild=true`、`inheritedReadQueries=6` 且全部只查 child、`crossOwnerDenied=true`；staged/clear 两个完成边界重开 `duplicateReplacements=0`，最终 completed/current=null。
  - **共存与原日志授权**：公开 pruner 在 plan 前/后替换 seq **20 / 23**；prune/compact × plan 前/后四场景均无原文复活、无重复 prefix，重开派生历史完全相同，plan 后失效候选被跳过。完整 compaction 后请求控制已不在 surface，读取页与 compaction 前精确相同，JSONL 重开仍相同且新增请求 0；checksum 损坏与缺失日志均拒绝。完整场景保留在 `tests/fixtures/recovery.ts`，供三个回归测试与导出的 `runRecoverySmoke` 共用，无自动执行副作用；临时调用/输出 wrapper 及生成产物已清理，保留场景与 C02 契约夹具不删除。本次仅更新 tracker，不运行检查、测试、构建、lint、格式化或提交。
  - **C09 retained-fixture reviewer fix／双复审 clean、已放行**：`tests/fixtures/recovery.ts` imports 已修正；三个永久回归测试及 `runRecoverySmoke` 共用保留夹具，不依赖临时 probe。编排器修复后 typecheck PASS、七文件 **75 tests PASS**；heavy-gated 保持输出位置的夹具 smoke **exit 0**（`artifact://322`），上述全部既有指标及场景断言 PASS，取代 `artifact://297` 作为最新 smoke 证据。host 依赖 external 时，相对 import 要求在夹具同目录编译，不能把产物移到 wrapper 目录。
  - **历史阶段说明**：以下 C09 清理记录中的“C10 尚未完成”描述当时状态；当前 C10 验证与完整 Validation 状态以 11 和本文件顶部为准。
  - **清理与教训**：已仅删除 `.verification/recovery-smoke.ts`、`.verification/recovery-smoke.mjs` 与生成的 `tests/fixtures/recovery.mjs`；保留 `tests/fixtures/recovery.ts` 和 C02 夹具。永久测试不能依赖临时探针，必须保留共享夹具并在清理后验证保留路径。编排器实际清理后 typecheck PASS、七文件 **75 tests PASS** 已记录，不声称清理后重跑 smoke。本次仅记账，不运行检查、测试、构建、lint、格式化或提交。C09 在 `f49e843` 后双复审 clean、已放行、未发布；C10 依赖已就绪但尚未完成，所有原有勾选及未勾选范围和完成条件不变。

- [x] **11. 完成取消、卸载和并发资源管理**
  - **实际修改位置**：`src/lifecycle.ts`、`src/index.ts`、`src/commands.ts`、`src/execute.ts`、`src/read.ts`、`tests/lifecycle.test.ts`、`tests/fixtures/lifecycle.ts`。
  - 跟踪正在执行的异步操作；卸载时先注销入口，再等待已启动操作退出。
  - 遵守命令、Agent 和工具调用的取消信号，不在操作退出后继续写入。
  - 维护任务期间到来的正常输入由宿主保留并按原顺序处理。
  - 同名命令或工具冲突交由正常注册失败机制报告，不静默覆盖已有实现。
  - **完成条件**：无遗留监听器、悬挂操作或重复注册；卸载后会话仍能由宿主打开，已提交替换不依赖插件解释器。
  - **C10 已验证、双审查 clean、已放行**：获准的 `fb74f62` 后 `c10-review-1` 与 `c10-review-2` 均 clean、无 findings，C10 已关闭，C11 依赖已就绪。编排器实际 full typecheck PASS、八文件 **86 tests PASS**；heavy-gated 保留 lifecycle 夹具 full run **exit 0**（`artifact://345`），全部场景断言 PASS。忙碌与重复拒绝不改变冻结选择；pending 卸载新增请求 0，JSONL 重开仍相同、reload 完成 2 区域，卸载解释器后宿主自然请求仍正常。
  - **取消与排空**：UI、公开 `Agent.cancel`、工具调用信号均退出；between-write 取消允许同步相邻 prune/replacement 原子对完成，不再追加后续进度控制或提交模型请求。重开保留冻结选择、已提交 seq24 不重复，最终完成 2 区域。command/read/execution 三种阻塞操作均在入口注销后被收集并排空；卸载新增模型请求及 control append 各为 0，资源 absent，reload 无注册冲突。
  - **持久化错误与输入**：无保存监听器及 flush 失败命令拒绝；卸载对未确认状态只作一次有界 flush 尝试，公开 `ctx.logger.exporter` 收到真实 durability 错误，Cordis `dispose()` resolves、**不 reject**，不将其写成持久化成功。维护 inbox 中 first 在首个后续请求、second 在后续请求到达且顺序保持；不要求二者同一请求。同 runtime 两会话互相隔离；命令/工具两种冲突显式失败且清理后可重新注册。
  - **自然自动 compaction 与清理**：真实自然请求触发公开自动 compaction；回取页精确相同，JSONL 重开派生历史、替换 seq 列表与页完全一致，重开请求 0。保留 `tests/fixtures/lifecycle.ts`、`tests/lifecycle.test.ts`、recovery 与 C02 契约夹具；仅删除生成的 `tests/fixtures/lifecycle.mjs` 与临时 `.verification/lifecycle-smoke.ts`。本次仅记账清理，不运行检查、测试、构建、lint、格式化或提交；上述证据在清理前，不声称清理后重跑。

- [x] **12. 完成 bundle 和预构建产物（已验证，C11 双审查 clean，已放行）**
  - **修改位置**：`cordis.patch.yml`、`package.json`、`tsdown.config.ts`。
  - 声明 `dsh.bundle.patch`，使用包名加载单个 Host 插件。
  - 导出构建后的 ESM 入口和类型声明；发布清单包含运行产物、patch、README 和许可文件。
  - 不发布测试夹具、临时验证材料或宿主运行时副本。
  - 构建在作者打包阶段完成；安装 tgz 不要求 `prepare`、`install` 或 `postinstall` 构建。
  - **完成条件**：`pnpm pack` 生成的包可在独立 Web profile 中安装和加载，不依赖源码链接。
  - **C11 实际证据**：编排器 typecheck PASS、heavy-gated build + pack PASS。tgz 共 9 文件：`lib/index.mjs`、`lib/index.d.mts`、`lib/index.mjs.map`、`LICENSE`、`THIRD_PARTY_LICENSES`、`README.md`、`cordis.patch.yml`、`package.json`、`CHANGELOG.md`。隔离 `/tmp/dsh-shake-consume-ydWKcz` 的 `npm install --ignore-scripts` 安装 51 包 PASS，NodeNext `tsc` PASS；heavy-gated packed public runtime corrected replay PASS：`scheduledRequests=0`、`reopenRequests=0`、`naturalRequests=1`、`completedRegions=1`、`readPage=true`。
  - **边界**：此勾选记录包实施和独立 Node 消费已验证，不取消上方原 Web profile 完成条件；实际 Web profile 安装/加载仍须 C12 证明。获准的 `8251193` 后 `c11-review-1` 与 `c11-review-2` 均 clean、无 findings，external/peer 依赖、source/map/declarations 与许可审查已 clear，C11 已关闭放行，C12 依赖已就绪；不宣称发布或 Web 验收。保留可提交的预构建 `lib/`；仅清理四个 package-consume probes 与生成 tgz，保留隔离 `/tmp` consumer 供下一任务使用/由 Main 删除。

- [x] **13. 完成使用文档和变更记录（已验证，C11 双审查 clean，已放行）**
  - **修改位置**：`README.md`、`CHANGELOG.md`、第三方许可文件；保留 `docs/plan/DESIGN.md` 的决策记录。
  - 写明安装、移除、延迟生效、取消、保护规则、回取、恢复、fork 和卸载行为。
  - 明确助手混合消息与工具结果混合内容的处理差异。
  - 明确普通读取工具返回的 skill/plan 文本没有额外语义保护。
  - 说明日志不会缩小、不是安全擦除、聊天旧输出不保证消失，以及 schema、回取和 KV cache 的成本。
  - 列出固定宿主版本及与 OMP、`/compact` 的偏离，不把未执行的验证写成已通过。
  - **完成条件**：安装示例使用实际 tgz 验证，文档行为与实现及验收结果一致。
  - **C11 已观察证据**：README 安装示例的实际 tgz 已由上述隔离消费项目以禁用安装脚本方式安装、类型解析及公开宿主加载/重开/自然执行/分页 smoke 验证。文档与许可进入九文件发布清单；获准的 `8251193` 后两份 C11 review 均 clean、无 findings，C11 已关闭放行；不将其描述为 Web 验收或完整交付。

## Validation

- [x] **运行类型、构建和包消费检查**
  - 执行工程定义的 `typecheck`、构建及 `pnpm pack`。
  - 在独立 ESM/NodeNext 消费项目中加载包并解析类型声明。
  - 检查发布文件清单和宿主依赖外置结果。
  - **通过条件**：无类型或导出错误，无 checkout 依赖，无额外宿主实例，无安装期构建要求。
  - **C12 补齐**：C11 类型/清单/external/独立消费证据，加三版本 actual-pack/package-install/package-import/packed-smoke 和官方隔离 Web 安装、加载、卸载重载证据，完成原条件。根运行产物与 exercised 包逐字节相同；完整包 hash 因 README 历史和本次文档更新不同，不声称 hash 相同。

- [x] **运行区域选择和扫描测试**
  - **位置**：`tests/regions.test.ts`。
  - 覆盖最近窗口跨消息边界、门槛上下界、无净收益、保护内容、混合消息、多个围栏、嵌套 XML、未闭合结构、Unicode 和重复处理。
  - **通过条件**：只移除符合规则的区域，未选中文字保持不变；不能通过放宽保护规则让测试通过。
  - **C05 完整证据**：编排器当时 typecheck PASS、regions 23 + blocks 21 + state 10 共 54 tests PASS，原始全部边界已覆盖（详见 05）。C05、C06、C07 已 clean 放行；最新 C07 typecheck 与 66 tests PASS，真实请求/日志 Validation 已验证；不外推其他 Validation。

- [x] **验证命令受理和取消语义**
  - **实际位置**：`tests/commands.test.ts`、`tests/lifecycle.test.ts`、`tests/fixtures/lifecycle.ts`。
  - 覆盖忙碌拒绝、同会话去重、无候选、取消、非法参数、附件、取消信号、flush 失败及无持久化监听器。
  - 验证维护期间到来的正常输入不会丢失或乱序。
  - **通过条件**：`/shake` 本身产生零模型请求，受理成功只表示请求已持久化，不产生提前替换。
  - **完整验收已验证，C10 待 review**：C06 durable/零提前替换与 C10 `commandAcceptance`、`maintenanceInboxOrdering`、`cancellationSignals`、`persistenceFailuresAndConflicts`、`activeUnload('execution')` 合并映射全部 criteria：busy/重复/无候选/idle cancel/非法参数/附件/预取消与进行中 UI、Agent 取消/flush 失败/无监听器均有断言。命令新增请求 0；维护输入保留冻结选择并在后续自然请求中按序到达。最新 full typecheck、八文件 86 tests 与 `artifact://345` 全断言 PASS，不推断 Web 或 package 验收。

- [x] **验证真实请求与日志一致性**
  - **位置**：`tests/session.test.ts`，使用固定版本真实 Session、AgentLoop、命令和 invariant 组件。
  - 捕获实际适配器请求，检查其历史与 `deriveMessages()` 一致。
  - 检查工具调用/结果配对、非文本块、offload 状态及替换来源关系。
  - **通过条件**：目标重文本退出下一次请求，保护内容不变，替换后文本规模及估算 token 减少；无日志重建错误。
  - **实际证据（C07 已验证、clean、已放行）**：真实固定发布包 Session/AgentLoop/命令/invariant 与公开插件路径 smoke PASS；捕获实际适配器请求并与 `deriveMessages()` 比较，工具配对/非文本/offload/来源、保护内容和助手摘录周边文本断言 PASS。命令新增 0、下一次自然输入新增 1 请求；原 seq10、请求 seq17、替换 seq24，移除 2、跳过 0，估算节省 5598 token。发送前原始日志与替换已 durable，JSONL 重开一致，无日志重建错误。该项原始 criteria 已满足；不把完成后的正常重开外推为中断恢复、回取授权、Web 或打包通过。

- [x] **验证持久化、中断恢复和共存**
  - **实际位置**：`tests/recovery.test.ts`、`tests/lifecycle.test.ts`、保留的 recovery/lifecycle 夹具。
  - 在请求落盘、部分替换、完成记录等边界制造中断并重新打开会话。
  - 覆盖手动/自动 compaction、内置 pruner、fork、插件卸载和重新加载。
  - **通过条件**：重开后上下文一致，不重复提交；凭据在 compaction 后仍可读取；父会话待处理请求不在子会话执行。
  - **完整验收已验证，C10 待 review**：C09 请求、部分替换、staged/clear 完成边界重开、失败不自动重试、fork、公开 pruner 与手动 compaction 证据见 10；C10 `pendingUnloadReload`、三类 `activeUnload`、`concurrentSessions`、`automaticCompaction`、`cancellationSignals` 与复用 `partialRestart` 补齐卸载/reload、并发、信号取消及自然自动 compaction。重开派生历史/替换 seq/授权页一致，无重复提交或父意图执行。最新 full typecheck、八文件 86 tests 和 `artifact://345` full run 全断言 PASS；不声称 C10 review clean。

- [x] **验证回取权限和分页**
  - **实际位置**：`tests/read.test.ts`；真实已发布宿主工具 dispatch smoke。
  - 覆盖合法片段、伪造操作标识、区域越界、未执行请求、其他会话引用、无实际替换凭据、缺失原日志、取消及分页边界。
  - 验证混合 Unicode 文本分段拼接后与原文完全一致。
  - **通过条件**：单次输出不超过限额，不泄露其他区域或事件；失败不以空内容伪装成功；回取结果不会再次被清理。
  - **C08 原验收已验证、clean、已放行**：六文件 72 tests 与真实工具回取 smoke PASS；Unicode 分页拼接、限额、授权拒绝、缺凭据/日志、取消、末尾/非法分页及回取来源保护已覆盖。237 次读取不增加模型请求，JSONL 重开和只读当前继承前缀通过。`7e317bd` 后双复审 clean、无 findings。C09 已进一步复核 fork 及手动 compaction 后原日志授权；C10 补齐工具调用取消、active read 排空及自然自动 compaction 后精确回取/reopen（`artifact://345`），C10 待 review。

- [x] **执行运行时版本矩阵**
  - 在 Node.js **22.19、24、26** 上运行纯逻辑与真实会话契约测试。
  - 使用锁文件安装依赖。
  - **通过条件**：三个运行时均通过；未验证的宿主版本不进入兼容声明。
  - **实际结果**：Node 22.19.0、24.21.0、26.10.0 各 frozen install/typecheck/full-test（8 文件 86 tests）/build/actual-pack/consumer-ci/published-contract/interfaces/package-install/package-import/packed-smoke exit 0。指标 `/tmp/c12-node-matrix-6y1a56o5/metrics.json`，日志 `vVERSION-{install,typecheck,full-test,build,actual-pack,consumer-ci,published-contract,interfaces,package-install,package-import,packed-smoke}.log`；初始旧 test/pack 失败保留，后续 corrected harness 通过。三包 SHA-256 均 `08f46181340ccdd3b6984cb7850ebc3a2c8a821a6b88fab326582153eed11797`。

- [x] **完成实际 Web UI smoke**
  - 使用隔离 Harness home、临时工作区、实际 tgz 和官方回放/测试适配器。
  - 生成旧的大工具输出、助手代码块和足够的近期保护历史。
  - 在界面执行 `/shake`，核对“已安排”且请求计数不增加。
  - 发送正常消息，捕获实际请求，核对目标移除、保护内容及净收益。
  - 通过真实工具调用路径执行 `shake_read`，验证原文回取。
  - 重启后继续会话，验证减重状态与回取；再验证忙碌拒绝、取消和无需清理提示。
  - 保存界面截图和请求证据；不要求旧聊天输出从界面消失。
  - 浏览器和重构建通过 `heavy-gate`，先检查内存与槽位，使用单浏览器串行验证，服务仅绑定 `127.0.0.1`。资源隔离不可用时停止验证，不能绕过限制或以单元测试代替。
  - **通过条件**：已安装包在实际 Web 界面完成上述完整流程；没有宿主补丁、私有 API、额外摘要调用或未验证的成功声明。

## C12 全部 21 项验收映射与证据

01–13 对应上方逐项实施证据，C12 未改策略或增加入口；区域、命令、请求一致性、持久化/共存、授权分页五项 Validation 分别复用 C05/C10、C06/C10、C07、C09/C10、C08/C09/C10（本次各版本完整 86 tests 与公共契约均通过）；包消费、运行时矩阵、官方 Web 三项由本次证据补齐。共 13 实施 + 8 Validation = 21；五面最终审查单列，不以测试替代审查。

- **真实 Web 流程**：隔离 `/tmp/dsh-shake-c12-web-7Qmufe`，官方 dsh/Web/frontend 和显式安装官方 replay `0.2.0-rc.2`，无宿主源码补丁。旧工具大文本、助手围栏/XML、足够近期历史来自实际三次 fixture 请求；已安排/已取消不增加请求；第四个请求是下一自然输入。追加完整回取后 `requests.jsonl` 共 47 请求（原 12 + 新 35），`web-metrics.json` 记录 parent 235 / seeded fork 227 行、4 regions、2 prune、15016 estimatedTokensSaved。捕获请求证明图片、助手 prefix/suffix、近期历史保护；不是仅截图推断。
- **重开/工具/fork**：重启官方服务、从持久化 JSONL 重开 parent 与既有 seeded fork，浏览器自然输入实际调用 `shake_read`，两者各 12 页 limit4096、offset 0/4096/…/45056，最后 2111 Unicode points、totalLength47167、done:true、nextOffset:null。逐页连续无缺口/重复，拼接与原始 event16/block0 的 region0 UTF-16 范围原文逐字符精确相等；原宿主大工具结果已有截断标记，不能用未经过宿主的生成器全文代替原事件。偏好8192曾真实调用6次，均被公开最大4096拒绝；另一次 exhausted replay 和一次第二会话未绑定错误保留，不算成功。成功 parent/fork 各13 provider 请求。fork 不重复 prune。日志为多帧 `session.v4.jsonl.zstd`，必须 `zstd -dc`。当时使用 `node .verification/c12-web-evidence.mjs /tmp/dsh-shake-c12-web-7Qmufe` 重算完整原文及 terminal 断言；脚本现已删除，不是当前回归测试入口。
- **UI 生命周期与资格**：官方 Plugins 开关关闭再开启，自动补全恢复；无需清理显示 `无需清理。`。忙碌 `/shake` 被官方 host active-work guard 在 callback 前拒绝，不能声称插件中文 busy 文案在 Web 显示；原 paced 请求 18s 后完成，无排队或重复清理。ContextMeter 实际 8% / ~10K / 131K，system ~1.5K/tools ~5.3K/messages ~7.8K；官方 replay 显式 inputTokens 10000/output 20 是合成 provider usage stimulus，不是计费或实测 savings。
- **截图**：large history `/tmp/omp-sshots-1597939fbf720405.webp`；安排 `159793bdb1320407`；取消 `159793cdd1320408`；自然请求 `159793da18320409`；重开回取 `15979424eb72040a`；禁用 `15979446d832040b`；fork/无需清理 `15979476eb72040c`；reload 自动补全 `1597949babf2040e`；busy `159794d210f2040f`；context `159795cbc8720410`（后九个均 `/tmp/omp-sshots-<id>.webp`）。浏览器网络 trace `artifact://499`；实际 LLM 请求保留 JSONL。
- **资源与包等价**：Web 所属验证先 free/status，再 heavy-gate -n 1 -m 6G 单 CDP 浏览器、显式地址、loopback host；已关闭 tab/browser/services。此前 integration 只核对包等价；本次完整分页补证另重开实际浏览器和官方服务。已安装包、Web corrected tgz、三矩阵 tgz 的运行代码/patch/manifest 与当前 root 相同。Web corrected SHA-256 `10e4af034ca4cabfd87cc68b9920864019684e700c67e3ef131fe82c63b0ebba`，矩阵包仅 README 不同；当前文档变更不伪装为新包 UI 运行。
- **历史 C12 integration 实跑**：完整回取后 `node .verification/c12-web-evidence.mjs /tmp/dsh-shake-c12-web-7Qmufe` PASS：47/235/227/4/15016，parent/fork 各12页、47167 Unicode points、精确拼接、连续 nextOffset 和终页 null/done。新截图 parent 完成 `/tmp/omp-sshots-15979946edccf4c7.webp`、fork 完成 `/tmp/omp-sshots-1597994108ccf4c5.png`、fork trajectory `/tmp/omp-sshots-1597994148ccf4c6.webp`；真实请求追加保留在同一 JSONL，replay 为隔离目录 `replay-pagination.json`。单 gated CDP 浏览器与三次自有 loopback 服务均已停止，profile/请求/截图保留；不删除原证据，不运行全矩阵或全仓库 checks。`515929a` 后受影响两面复审 clean，C12 最终五面门禁完成；本次仅文档闭环，未创建提交。


