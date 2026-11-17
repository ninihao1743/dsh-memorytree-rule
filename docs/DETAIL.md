# 记忆树

![记忆树四枝星图](DETAIL.svg)

把「主干、情感枝、任务枝、判断叶」放进 DSH 的本地记忆插件：规则以 `AGENTS.md` 为正本，经历、任务卡和待分拣观察落在本地 SQLite，检索在进程内完成。不联网、不调 LLM、不起外部服务。

## 四枝各管什么

| 枝 | 放什么 | 默认作用域 |
|---|---|---|
| 主干 | 每轮都要遵守的长期判据；正本是 `AGENTS.md` | 跨工作区 |
| 情感枝 | 相处经历、情绪对话、工作感受；日记只是索引 | 跨工作区 |
| 任务枝 | 插件/脚本/服务/固定操作的做法卡；一个 subject 一张 | 全库（可显式 `workspace` 隔离） |
| 判断叶 | 还没归类、待验证的规则、解析和零散观察 | 全库（可显式 `workspace` 隔离） |

主干写明「不知道就会做错」的判据；任务枝只写路径、命令、参数和坑；枝叶与主干冲突时改枝叶，主干之间冲突时问用户。

## 第一次使用

1. 在 DSH 里安装插件；安装后左侧栏出现「记忆树」入口。
2. 看 `<DSH_HOME>/AGENTS.md` 是否已经存在：没有，就在插件目录运行 `node bin/mt.mjs init` 自动复制模板并同步；也可以手动复制 `examples/AGENTS.template.md`，按注释替换 `<...>` 占位。已经存在时 `init` 默认拒绝覆盖，只合并需要的段落。
3. 在插件目录运行 `node bin/mt.mjs doctor` 看路径与库是否正常；需要强制重同步时运行 `node bin/mt.mjs sync --force`。
4. 想看四枝长什么样，运行 `node bin/mt.mjs demo`：它在临时目录里建一套带「示例」标签的演示库和看板，不碰真实记忆。

模板里的「示例，可删除」都是案例，不是实际记忆；看懂后可以删，也可以改成你自己的经历。

## 8 个工具

- `memory_search`：混合检索；命中带分数分解和逐字证据，主干条目另有来源行号；没命中就明确说没有。
- `memory_write`：写一条记忆；默认脱敏，可传 `redact:false` 保留原文；`trunk` 一律落候选，不会冒充规则。
- `memory_forget`：默认归档可恢复；物理删除需显式 `hard` 与原因。
- `memory_tree`：看四枝全貌、候选、过期、待分拣和库大小。
- `memory_card`：按 `subject` 或 `id` 取任务卡及相关条目。
- `memory_ingest`：`sync` 同步 `AGENTS.md` §1；`migrate` 迁移旧库；`status` 看环境。
- `memory_daily`：生成待分拣报告，或一次提交去枝/遗忘决定。
- `memory_admin`：`doctor` / `stats` / `reindex` / `export` / `import` / `audit` / `report` / `diary` / `placement`。

## 看板与命令行

`memory_admin action=report` 或 `node bin/mt.mjs report --out report.html` 生成自包含 HTML：四枝星图、检索、详情抽屉、规则归枝、待确定写入、日记索引与打印。看板不引用外链；「深度思考」按钮只把请求投回 DSH 会话，由 DSH 处理。

常用命令：

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

## 数据与隐私

- 库在 `<DSH_HOME>/memory-tree/memory.db`，WAL 单文件，可整体备份。
- 写入默认脱敏：常见密钥、`Bearer`、`password/secret/token/api_key = …`、邮箱、长数字串、`openid`/`qq` 值。
- 不读取会话正文、不监听事件写库、不调外部 API；需要加密请用磁盘加密或容器卷。
- 主干正本始终是 `AGENTS.md`；只有看板里显式确认的「写入正本」才会改它，改前备份、改后回读校验。

## 边界

- 不做自动注入：不会每轮把记忆塞进系统提示，召回靠主动调用 `memory_search`。
- 不做会话正文自动采集：入库走显式 `memory_write` 与每日分拣。
- 向量检索是字符 n-gram 特征哈希，只用于措辞相近加分，不是神经语义模型；没命中不会编造。
- 看板是快照，实时数据仍以 `memory.db` 为准。
