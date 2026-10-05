# dsh-shake

为 **DeepSeek Harness（DSH）** 手动减少上下文占用的插件。它把旧工具输出、助手回答中的大段代码和 XML 换成短占位符；需要时，模型可以通过 `shake_read` 回读原文。

> **第三方插件声明：** dsh-shake 是独立维护的第三方 DeepSeek Harness（DSH）插件，非 DeepSeek 官方产品。文中提及 DeepSeek Harness 仅用于说明兼容性，不表示 DeepSeek 对本项目的认可、赞助或背书。

**不调用模型生成摘要，不删除原始日志。** `/shake` 只安排清理，真正的替换发生在下一次正常对话的模型请求之前。

[安装](#安装) · [使用](#使用) · [清理范围](#清理范围) · [配置](#配置) · [回读原文](#回读原文) · [限制与恢复](#限制与恢复)

## 安装

### 环境要求

| 组件 | 声明支持范围 | 已验证基线 |
| --- | --- | --- |
| DeepSeek Harness（`@deepseek-ai/dsh` 及对应的 `@deepseek-ai/dsh-*` 宿主服务） | `0.2.0-rc.2` | `0.2.0-rc.2` |
| DSH 使用的 Cordis fork（`@deepseek-ai/cordis`） | `~4.0.4`（`>=4.0.4 <4.1.0`） | `4.0.4` |

宿主服务的支持范围以 [package.json](package.json) 的 `peerDependencies` 为准。Cordis 指 `@deepseek-ai/cordis`，不是未加 scope 的 `cordis` 包；不承诺上述范围以外的版本兼容。

- **Node.js：** `^22.19.0 || >=24.0.0`。
- **使用环境：** 已初始化的 DSH Web profile。

可通过 npm 安装 `dsh-shake@latest`。

### 安装到 Web profile

先确认 DSH 版本，再从 npm 安装 `dsh-shake@latest`：

```sh
dsh --version
dsh plugin --profile web add dsh-shake@latest --ignore-scripts
dsh --profile web --dump-config
```

确认配置输出中包含 `dsh-shake`。如果 DSH 已在运行，先停止它，再启动 Web：

```sh
dsh web
```

安装预构建包不需要链接源码或运行构建脚本，默认配置即可使用。

## 使用

1. 等当前会话空闲，在 Web 的消息输入框中发送：

   ```text
   /shake
   ```

2. 收到「已安排，将在下一次模型请求前执行。」后，清理请求已保存。**此时不会调用模型，也不会立即缩小上下文。**
3. 继续发送下一条正常消息。插件先替换符合条件的旧文本，再让 DSH 发出模型请求。

如果还没开始执行，可以取消：

```text
/shake cancel
```

取消只针对待执行请求，**不能撤销已经完成的替换**。

| 遇到的情况 | 含义与处理 |
| --- | --- |
| 提示「无需清理」 | 当前没有符合条件且能节省 token 的文本，无需继续操作。 |
| 会话忙碌或正在维护 | 等会话空闲后重试；命令不会打断现有任务，也不会排队。 |
| 已有待执行请求 | 每个会话最多一个；重复 `/shake` 不会重新选择内容。可先取消，再重新安排。 |
| 带了附件或其他参数 | 只支持 `/shake` 和 `/shake cancel`，均不接受附件。 |

## 清理范围

默认先从最新历史向前累计，保护最近约 **4,000 token**。跨过边界的消息也会整条保留。只在更早的历史中寻找以下内容：

| 内容 | 默认处理条件 |
| --- | --- |
| 成功的工具结果 | 同一结果中的文本合计至少 1,000 token；仅替换文本，保留图片等非文本内容及原有元数据。 |
| 纯文本助手回答 | 单个完整代码围栏块或 XML 块至少 400 token；保留块外文字及其顺序。 |

占位符本身也有成本；替换后没有净收益的内容会跳过。执行时会重新检查，已经被其他操作替换或不再适合清理的片段也会跳过。

**以下内容不会被清理：**

- 用户、系统和开发者消息。
- 错误工具结果、`shake_read` 的结果，以及本插件的控制记录、历史摘录和带这些来源的内容。
- 含图片、thinking、工具调用或其他非文本块的助手消息——整条跳过。
- 助手回答中的普通长段落、工具调用参数，以及未闭合的代码围栏或 XML 结构。

**注意：** 普通读取工具返回的 skill、plan 文本没有额外保护，仍可能按工具结果清理。上述硬性保护不能通过配置关闭。

## 配置

不需要调整时，保留默认值即可。要修改参数，在目标 profile 的 `cordis.patch.yml` 中添加配置覆盖；**不要再插入第二个插件实例**。

下面展示的是默认配置：

```yaml
- id: dsh-shake
  config:
    protectedTokens: 4000
    toolTextMinTokens: 1000
    assistantBlockMinTokens: 400
    readDefaultLimit: 2048
    readMaxLimit: 4096
```

| 参数 | 默认值 | 作用 |
| --- | --- | --- |
| `protectedTokens` | `4000` | 最近历史的保护范围，按本地估算的 token 数累计，整条消息保留。 |
| `toolTextMinTokens` | `1000` | 工具结果的文本总量达到此值，才考虑清理。 |
| `assistantBlockMinTokens` | `400` | 助手回答中的单个代码或 XML 块达到此值，才考虑清理。 |
| `readDefaultLimit` | `2048` | `shake_read` 未指定 `limit` 时的页大小，单位为 Unicode 码点。 |
| `readMaxLimit` | `4096` | `shake_read` 允许的最大页大小，单位同上。 |

前三项必须是非负安全整数；分页配置须满足 `1 ≤ readDefaultLimit ≤ readMaxLimit ≤ 4096`，且均为整数。配置不接受其他字段。

修改后重启 DSH 即可生效。已经安排的请求仍使用安排时保存的配置与候选片段。

## 回读原文

被替换的文本会留下带 `ref` 的占位符。模型可以调用 **`shake_read` 工具**取回该片段；它不是供用户输入的斜杠命令。

调用参数示例（将 `ref` 的示意值替换为占位符中的完整引用）：

```json
{
  "ref": "<从占位符复制完整 ref>",
  "offset": 0,
  "limit": 2048
}
```

返回值包含当前页 `text`、当前偏移 `offset`、片段总长度 `totalLength`、下一页偏移 `nextOffset` 和结束标记 `done`。

- 下一页使用同一个 `ref`，将 `offset` 设为上次返回的 `nextOffset`。
- `done: true`、`nextOffset: null` 表示读完。
- 偏移和长度按 **Unicode 码点**计数，不是字节数或 JavaScript 字符串的 UTF-16 长度。
- `offset` 必须是非负安全整数，不能超过片段总长度；恰好到末尾时允许返回空页。`limit` 必须是正整数，不能超过配置的 `readMaxLimit`。

引用只是定位信息，不是读取权限。工具会核验当前会话中的原文、实际替换记录与校验和，**只能读取真正被移除的片段**，不接受文件路径或其他会话 ID。

## 限制与恢复

### 使用前需要知道

- **不是 `/compact`。** 这是手动文本清理，不生成模型摘要，也不提供 OMP 完整 shake 的自动、images、thinking 模式或 artifact 文件。
- **不是安全擦除。** 原文仍在原始会话日志中，日志文件不会因此缩小，界面上的旧输出也不保证消失。
- **助手消息的角色会变化。** 清理后的助手回答以带来源标记的 `user/message` 历史摘录写入；保留未选中文字，但不保留原助手角色语义。
- **节省量是本地估算。** 不代表服务商账单或保证的节省比例。回读会把原文重新带入上下文，历史变化可能导致 KV cache 重建；没有缓存收益保证。

### 重启、分叉和中断后会怎样？

| 情况 | 行为 |
| --- | --- |
| 重启 DSH 或重新打开会话 | 从日志恢复待执行请求，等下一次正常输入再执行，不会自行调用模型。 |
| 分叉会话（fork） | 不自动执行从父会话继承的待执行请求。只能回读子会话自身已继承的原文与替换凭据，不查询父会话或兄弟会话。 |
| 执行中取消或失败 | 已提交的替换保留，不自动回滚。恢复时以真实日志判断进度，不会悄悄发送模型请求；已记录为失败的清理不会自动重试。 |
| 无法确认会话已保存 | 命令不报告成功；执行阶段也不会放行后续模型请求。请检查宿主保存能力与日志。 |

### 卸载

先停止 DSH，再移除插件：

```sh
dsh plugin --profile web remove dsh-shake
```

如果添加过自定义配置覆盖，也一并移除，然后重新启动：

```sh
dsh web
```

卸载不会撤销已完成的替换，也不会删除原文。DSH 仍能打开会话，但 `shake_read` 不再可用。尚未执行的请求会保留，重新加载插件后可恢复。

<details>
<summary>实现与持久化细节</summary>

- 安装包通过 `dsh.bundle.patch` 加载单个 Host 插件。插件管理器将组合包加入 profile 的 `dsh.profile.bundles`；随包 patch 显式提供 `config: {}` 以启用默认值。固定宿主会拒绝省略整个 `config` 的插件配置。
- 工具结果通过宿主的 surface replacement 替换，身份、错误、来源元数据及 opaque/offload 等非文本块保持不变。插件不删除图片或推理块，也不缩减它们的成本。
- schema-v1 状态只保存引用、范围、校验和与冻结策略，不复制原文。引用格式为 `shake:1:<operationId>:<requestSeq>:<regionIndex>`；持久化范围采用半开 UTF-16 索引和 UTF-16LE SHA-256 校验，不能用作 `shake_read` 的分页偏移。
- 只追加宿主已知事件；后续 compaction 不会自动抹掉原始日志中的回读凭据。状态记录、来源核验和回读都有额外日志或查询成本。
- 为保守确认持久化，同会话最近结果仍为 `completed` 时，每个后续自然 step 都先执行 `flush`，并非只重试一次。
- 卸载先撤销命令、工具和监听入口，再等待已启动操作结束。对未确认的持久化只作一次有界尝试，失败通过宿主 logger 输出；Cordis `dispose` 返回成功不等于保存成功，也不代表硬件级 fsync 保证。

</details>

## 许可

[MIT](LICENSE)。OMP 扫描器的改编归属、固定上游提交及完整许可通知见 [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES)。
