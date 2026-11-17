# 情感候选采集（可选，默认关闭）

这个功能不是「自动写记忆」，而是给情感枝加一个**本地候选池**：插件在会话事件里按规则挑出可能值得回顾的片段，先脱敏、截断、打分，存进 `emotion_candidate`；真正写不写、写成什么，仍由你在日结时用 `memory_write` 决定。

默认关闭。没有显式配置 `emotionCapture: true` 时，插件不读会话正文，只保留原来的显式写入与每日分拣。

## 为什么默认关闭

- 会话正文可能含隐私；自动读正文应该是用户主动选择，不是安装即默认。
- 「值得记」是判断，不是采集。候选只是线索，不是记忆。
- 采集本身不花 token，但日结要花模型 token；默认关闭可以避免用户在不知情时多出这项成本。

## 配置

在 DSH 的插件配置里给 `dsh-memorytree-rule` 加（具体层级以你的 DSH 配置格式为准）：

```yaml
emotionCapture: true
emotionMinScore: 35
emotionPluginCwdPatterns:
  - "my-bot-workspace"
emotionReviewCostCapCny: 0.3
emotionRetentionDays: 30
```

| 配置 | 默认 | 说明 |
|---|---|---|
| `emotionCapture` | `false` | 只有 `true` 才采集；其它值一律当关闭。 |
| `emotionMinScore` | `35` | 候选入池的最低分；调高更严，调低更松。 |
| `emotionPluginCwdPatterns` | `[]` | 插件会话的 cwd 子串列表；命中才把候选归为 `plugin`。不内置任何平台名。 |
| `emotionReviewCostCapCny` | `0.3` | 日结预算上限（元）；`memory_emotion budget` 用。 |
| `emotionRetentionDays` | `30` | 候选保留天数；过期在采集时顺手清理。 |

改完配置后完全退出并重启 DSH，宿主才会把新配置交给插件。

## 采集什么

监听 `session/event`，只取消息里的 text 块（跳过工具调用、代码围栏、运行时上下文、系统提醒、调度包装等噪声）：

- **user 消息**：`source.kind === "user"` 才是用户本人；其它来源（调度、插件注入）归 `work`，不冒充 `plugin`。
- **assistant 消息**：取助手回复的 text 块。
- **打分**：本地关键词/规则打分，≥35 分才入候选；不是语义模型，会漏也会误收。
- **分类**：
  - `relationship`：主会话里的相处、情绪、回忆、约定、第一次。
  - `plugin`：cwd 命中 `emotionPluginCwdPatterns` 的插件会话。
  - `work`：工作复盘、普通会话、调度注入。
- **上限**：每会话每天 6 条、全局 12 条、`plugin` 类别 4 条；同一会话内按分数取前几条。
- **截断**：正文最多 800 字，另存 240 字上下文；不保存整段会话。
- **去重**：`sha1(session_id + role + day + text)`，同一天同一条消息只入一次。
- **脱敏**：候选正文先过本地脱敏（密钥、`Bearer`、邮箱、长数字、`openid`/`qq` 值、访客昵称与 @ 提及）。脱敏是尽力而为，不保证覆盖所有敏感格式；不要在不信任的环境里开启。

## 候选长什么样

`emotion_candidate` 一行大致包含：`day`、`session_id`、`role`、`category`、`score`、`reasons`、`text`、`context`、`sha1`、`status`（pending/accepted/dismissed）、`node_id`、`created_at`、`expires_at`。

候选不是记忆：它不会进 `memory_search`，不会被注入系统提示，也不会自动出现在情感枝；只有 `memory_write` 写进去的才算。

## 日结流程

建议每天固定一个时间，开一个新会话，按这个顺序做：

1. `memory_emotion stats`：看今天有多少候选、分类和状态。
2. `memory_emotion budget`：看今日总花费、本会话花费、是否超过 `emotionReviewCostCapCny`。
3. `memory_emotion list`：读候选（默认 pending，最多 50 条）。
4. `memory_write`：写 0–6 条。每条必须有**第一人称感受/立场**；写不出感受的候选宁可跳过，不要写成「今天发生了什么」的事件汇报。建议 `layer: "emotion"`，`source: "daily-review@YYYY-MM-DD"`。
5. `memory_emotion mark`：把写过的标 `accepted` 并填 `nodeIds`，没写的标 `dismissed`。
6. `memory_emotion report`：记下候选数、写入数、丢弃数、花费；不写也能结束，但 `report` 让下一次知道预算。

候选不足就少写，甚至 0 条；不要为了「每天都有记录」硬凑。

插件**不会自动创建**这个 23:30 的定时任务。需要的话，在 DSH 里自己建一个每天固定时间的会话任务，提示词就是上面 6 步；不建也不影响插件其它功能。

## 成本

- 采集：0 token、0 网络请求、不调 LLM；只在本地 SQLite 写候选。
- 日结：模型读候选 + 写记忆的 token，按你自己的模型价格算；`budget` 会读本机 DSH 成本账本（如果存在），读不到就明确说「账本未读到」，不编造数字。
- 硬上限：`emotionReviewCostCapCny` 只是 `budget` 的提示，不会自动阻止模型调用；要真正停，关闭 `emotionCapture` 或不要建日结任务。

## 关闭与清理

- 关闭：`emotionCapture: false`，重启 DSH；之后不再采集。
- 已采集的候选：`memory_emotion mark ids=... status=dismissed` 只是标记；候选会在 `emotionRetentionDays` 天后由采集时的清理逻辑删除。
- 想立刻清空：关闭采集后，直接删 `memory.db` 里的 `emotion_candidate` / `emotion_review` 行（先备份库），或等过期。
- 卸载插件不会自动删库；库在 `<DSH_HOME>/memory-tree/memory.db`，按你的备份/删除策略处理。

## 边界

- 打分是本地启发式，不是语义理解；会漏掉含蓄的表达，也会把工作抱怨误收成情感候选。
- 只处理 text 块；图片、语音、工具结果不采集。
- 不自动写记忆、不自动归枝、不自动改 `AGENTS.md`。
- 不做跨会话拼接；每条候选只带 240 字上下文。
- 脱敏是尽力而为；开启前请确认你能接受「本地库里有节选」这件事。

## 排障

- 工具没出现：先看 `/memory-tree/health` 的 `tools` 是否含 `memory_emotion`；当前会话的工具清单可能是旧的，新会话才会拿到。
- 有候选但日结看不到：确认 `emotionCapture` 已重启生效、`memory_emotion list` 的 `day` 是本地日期。
- 候选太多噪声：调高 `emotionMinScore`（如果版本支持）或收紧 `emotionPluginCwdPatterns`；也可以在日结里直接 dismiss。
- 预算读不到：`budget` 会返回 `ledger:false`，这是正常的；不代表采集失败。
