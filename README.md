# Memorytree（dsh-memorytree-rule）

把「主干、情感枝、任务枝、判断叶」放进 DSH 的本地记忆插件。规则以 `AGENTS.md` 为正本，经历、任务卡和待分拣观察落在本地 SQLite；检索在进程内完成，不联网、不调 LLM、不起外部服务。

## 它解决什么

- **四枝分层**：§1 主干 / §2 情感枝 / §3 任务枝 / §4 判断叶，各管一类东西，不混在一起。
- **主干仍以 `AGENTS.md` 为正本**：插件只做可检索的索引副本，主干条目带来源行号和逐字证据；手动写 `trunk` 只会落 `candidate`，不会冒充规则。
- **遗忘不是删除**：默认归档（`archived`），显式 `hard` 才物理删除；取代（`superseded`）保留旧条目和指向关系。
- **单一记忆体系**：不新建与记忆树并行的存储；任务清单仍只记进度。
- **默认全库可见**：四枝默认写 `user`，任务卡和判断叶换工作区也能查到；项目私有内容可显式写 `workspace` 隔离，检索默认跨全库。

## 四枝

| 枝 | 放什么 | 默认作用域 |
|---|---|---|
| 主干 | 每轮都要遵守的长期判据；正本是 `AGENTS.md` | 跨工作区 |
| 情感枝 | 相处经历、情绪对话、工作感受；日记只是索引 | 跨工作区 |
| 任务枝 | 插件/脚本/服务/固定操作的做法卡；一个 subject 一张 | 全库（可显式 `workspace` 隔离） |
| 判断叶 | 还没归类、待验证的规则、解析和零散观察 | 全库（可显式 `workspace` 隔离） |

主干写明「不知道就会做错」的判据；任务枝只写路径、命令、参数和坑；枝叶与主干冲突时改枝叶，主干之间冲突时问用户。

## 安装

用 DSH 自带的插件管理器安装（具体命令随 DSH 版本不同，以「设置 → 插件」或 `dsh plugin --help` 为准）。安装后 9 个 `memory_*` 工具会注册，左侧栏出现「记忆树」入口。

改了插件代码后要完全退出并重启 DSH，宿主才会丢掉内存里的旧模块、加载新代码；只改源码而未重装时，`node bin/mt.mjs` 仍走新代码，插件内的工具与看板可能还是旧模块。

## 第一次使用

1. 先看 `<DSH_HOME>/AGENTS.md` 是否已经存在：没有，就在插件目录运行 `node bin/mt.mjs init`，自动复制 `examples/AGENTS.template.md` 并同步；也可以手动复制模板，按注释把 `<...>` 换成真实值，不需要的条目整条删掉。已经存在时，`init` 默认拒绝覆盖，只把模板里需要的段落合并进去。
2. 在插件目录运行 `node bin/mt.mjs doctor` 看路径与库是否正常；需要强制重同步时运行 `node bin/mt.mjs sync --force`，把 §1 主干同步成可检索的枝条目。
3. 想看四枝长什么样，运行 `node bin/mt.mjs demo`：它在临时目录里建一套带「示例」标签的演示库和看板，不碰真实记忆。

模板里的「示例，可删除」都是案例，不是实际记忆；看懂后可以删，也可以改成你自己的经历。模板不是插件自动写入的规则，插件不会替你生成 `AGENTS.md`。

## 9 个工具

| 工具 | 用途 |
|---|---|
| `memory_search` | 混合检索；命中带分数分解和逐字证据，主干条目另有来源行号；没命中就明确说没有、不编造。 |
| `memory_write` | 写一条记忆（四枝之一）；默认自动脱敏，可传 `redact:false` 保留原文，`trunk` 一律落候选。 |
| `memory_forget` | 遗忘；默认归档可恢复，`hard` 需给出原因。 |
| `memory_tree` | 看四枝全貌、候选、过期、待分拣和库大小。 |
| `memory_card` | 按 `subject` 或 `id` 取一张任务卡及相关条目。 |
| `memory_ingest` | `sync` 把 `AGENTS.md` 的 §1 主干同步成索引；`migrate` 迁移旧库；`status` 看环境。 |
| `memory_daily` | 每日分拣：出报告（待分拣叶、聚类、陈旧卡、过期项），或一次提交去枝/遗忘决定。 |
| `memory_admin` | `doctor` / `stats` / `reindex` / `export` / `import` / `audit` / `report` / `diary` / `placement`。 |
| `memory_emotion` | 情感候选日结：`list` / `mark` / `stats` / `budget` / `report`；只动候选表，不直接写记忆。 |

## 情感候选采集（默认开启，可关闭）

插件默认**开启**本地候选采集：在本地按规则挑出可能值得回顾的片段，先脱敏、截断、打分，存进 `emotion_candidate`。采集到的只是「候选」，不是记忆：30 天后自动清理，真正的记忆仍由 `memory_write` 写入；不想用就设 `emotionCapture: false`，重启 DSH 后停止。

```json
{
  "emotionCapture": true,
  "emotionPluginCwdPatterns": ["my-bot-workspace"],
  "emotionReviewCostCapCny": 0.3,
  "emotionRetentionDays": 30
}
```

- **采集**：监听 `session/event`，只取 user/assistant 的 text 块；本地打分（情绪、记忆、关系、工作挫折、第一人称感受等），≥35 分才入候选；每个会话每天最多 6 条、全局 12 条；正文最多 800 字，另存 240 字上下文；`sha1(session_id + role + day + text)` 去重。
- **分类**：`relationship`（主会话里的相处/情绪/回忆）、`plugin`（cwd 命中 `emotionPluginCwdPatterns` 的插件会话）、`work`（工作复盘与普通会话）。插件 cwd 由用户自己配置，插件不内置任何具体平台。
- **脱敏**：候选正文先过本地脱敏（密钥、邮箱、长数字、`openid`/`qq` 值、访客昵称与 @ 提及）；不保存整段会话，只留节选与上下文。
- **日结**：建议每天固定时间开一个新会话，让模型执行 `memory_emotion stats` → `budget` → `list`，再用 `memory_write` 写 0–6 条**第一人称感受/立场**，然后 `mark` + `report`。候选不足就少写；写不出感受的候选宁可 dismiss，不要写成事件汇报。插件**不会自动创建**这个定时任务，需要你自己在 DSH 里建。
- **成本**：采集在本地完成，0 token、不调 LLM；日结的 token 花在模型读候选和写记忆上，`budget` 会读本机 DSH 成本账本（如果存在），可设 `emotionReviewCostCapCny` 上限。
- **关闭**：`emotionCapture: false` 即停；已采集的候选可用 `memory_emotion mark status=dismissed` 清理，或等 30 天自动过期。

## 看板

`memory_admin action=report` 或 `node bin/mt.mjs report --out report.html` 生成一张自包含 HTML：

- **星图**：四枝各成一簇，每条记忆一颗星，大小一致、颜色按枝区分；悬停读标题，点击开详情抽屉。
- **规则操作**：主干可手动修改或归枝；修改会先进判断叶的「待确定写入」，显式确认后才备份、写 `AGENTS.md`、回读校验并同步索引。
- **判断叶归枝**：主干要过五项核心规则检查；情感枝/任务枝只写本机记忆库；任务枝由 DSH 先判断最合适的卡，用户确认后才落卡。
- **检索与过滤**：页内搜索实时计数、压暗未命中的星；层色标可按枝过滤。
- **深度思考**：把规则原文和改写要求投回 DSH 会话，由 DSH 处理；页面只显示「已发送」，不假装同步返回结果。
- **打印 / PDF**：打印样式去掉交互与背景。
看板不引用外链、不联网；在线看板是同源页面，`file://` 双击的离线快照只读。看板写操作只接受本机回环、同源请求和 `dataDir/board-token` 里的令牌；令牌与本机模式一致，重启后旧链接仍可用。看板是快照，实时数据仍以 `memory.db` 为准。
<img width="2235" height="1339" alt="cf87d01b-c935-496a-94df-d1b264426db4" src="https://github.com/user-attachments/assets/ea0fabf7-be3f-4adc-8250-9bbdcdea3ebd" />
<img width="1258" height="1192" alt="1265439f-eb32-44b6-a8c9-7a8794b703b4" src="https://github.com/user-attachments/assets/65f2a5bb-a4a7-478e-ad70-3b52d7c7a5e3" />
<img width="518" height="1130" alt="2ad3d568-e6a0-4e67-9480-f92d0ad02404" src="https://github.com/user-attachments/assets/88c8e580-cbd0-4333-b247-74797382e424" />

## 作用域

- `user`：跨工作区共享；四枝默认都写这里，任务卡换项目也能直接查到。
- `workspace:<cwd 的 sha1 前 10 位>`：可选的隔离作用域，给某个项目私有的任务卡/判断叶用；显式传 `scope=workspace` 才写当前工作区。

`memory_search` 默认 `scope=all`（全库：`user` + 各 workspace）；也可以只要 `user` 或当前 `workspace`。

## 检索怎么做的（不夸大）

- **BM25**：中文按「单字 + 相邻二字」切，ASCII 按词切；单字只在没有词/bigram 时才参与，避免长句里凑出假命中。
- **向量**：256 维 hashed 字符 n-gram（feature hashing），只用于「措辞相近」的加分，不是神经语义模型，不理解同义改写；默认 `hybrid` 要求至少一个查询词真的出现，纯相似度召回只在显式 `mode=vector` 时使用。
- **修正**：层权重（主干最高）、状态（active > candidate > superseded > archived）、importance、trust、半衰期衰减、过期降权；每条命中都能在 `match` 里看到为什么被召回。

## 数据与隐私

- 库：`<DSH_HOME>/memory-tree/memory.db`（WAL，单文件，可整体备份）。
- 写入默认脱敏：常见密钥、`Bearer`、`password/secret/token/api_key = …`、邮箱、长数字串、`openid`/`qq` 值。
- 全量导出：`memory_admin action=export`（JSONL）；审计：`memory_admin action=audit`。
- 日记：`memory_admin action=diary`；只写「库内当天发生了什么」的索引，不写会话正文；手写日记不会被自动覆盖（`force=true` 才行）。
- 默认在本地按规则挑情感候选：0 token、不联网、不调外部 API；候选先脱敏、只留节选、30 天过期，不写记忆。设 `emotionCapture: false` 可关闭，关闭后不再读会话正文。
- 主干正本始终是 `AGENTS.md`；只有看板里显式确认的「写入正本」才会改它，改前备份、改后回读校验。

## 命令行

以下命令都在插件目录下执行（即 `node_modules/dsh-memorytree-rule`）；装了插件后工具优先用 `memory_admin`，不必手敲路径。

```text
node bin/mt.mjs doctor
node bin/mt.mjs init
node bin/mt.mjs stats
node bin/mt.mjs sync --force
node bin/mt.mjs search "备份 路径" --limit 5
node bin/mt.mjs daily
node bin/mt.mjs demo
node bin/mt.mjs report --out report.html
```

`demo` 用临时目录建隔离示例库，不读写真实库；`--out` 可把演示看板写到指定文件。

## 测试

```text
node --test tests/memory-tree.test.mjs tests/renumber.test.mjs tests/trunk-bucket.test.mjs tests/regressions.test.mjs tests/emotion.test.mjs
```

103 个用例、5 个测试文件，覆盖分词、脱敏、空结果诚实、作用域隔离、默认作用域与全库检索、`init` 备份/拒绝覆盖、主干候选规则、取代、归档/硬删、任务卡唯一、`AGENTS.md` 解析与幂等同步、旧库迁移、每日分拣、过期降权、JSONL 往返、日记自动索引与手写保护、工具渲染内容块契约、看板自包含与关键组件、看板写正本/备份/信任升档、客户端侧栏入口契约、规则归枝，以及情感候选的提取/打分/分类/脱敏/去重/上限/默认开启与显式关闭/预算/迁移。测试全部用临时目录隔离，不碰真实库。

## 明确没做的

- **不做自动注入**：不会每轮把记忆塞进系统提示，避免与「单一注入源」冲突；召回靠模型主动调 `memory_search`。
- **默认只落候选，不自动写记忆**：情感候选默认开启，但只进 `emotion_candidate`，不直接改记忆；设 `emotionCapture: false` 关闭后，入库只走显式 `memory_write` 与每日分拣。
- **不是自动写记忆**：候选要经过日结判断，写不出第一人称感受的候选会被丢弃；插件不替用户决定什么是「值得记的」。
- **不做加密**：库是明文 SQLite，靠脱敏与文件权限；需要加密请用磁盘加密或容器卷。
- **不是神经语义检索**：字符 n-gram 只做措辞相近加分；没命中会如实说没有。

## 许可

MIT。
