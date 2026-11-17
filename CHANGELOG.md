# 更新记录

## 1.1.0（2026-11-18）

- **情感候选采集改为默认开启**：`emotionCapture` 默认 `true`，装上即可用；不想用设 `emotionCapture:false` 关闭，重启 DSH 生效。采集仍是本机行为（0 token、不调 LLM、不联网），候选只留脱敏节选、30 天过期、不直接写记忆。
- **文档与配置同步**：`cordis.patch.yml` 显式列出 `emotionCapture: true`；README、EMOTION.md、DETAIL.md、AGENTS 模板写清默认开启、关闭方法与边界。
- **测试**：情感用例改为验证「未配置时默认采集、显式 false 关闭」，总数仍 103。

## 1.0.2（2026-11-18）

- **可选情感候选采集**：新增 `emotionCapture`（默认 `false`）。开启后监听 `session/event`，本地按情绪/记忆/关系/工作挫折等规则打分，≥35 分才入候选；每会话每天 6 条、全局 12 条、插件类别 4 条；正文 800 字 + 上下文 240 字；30 天过期。不联网、不调 LLM。
- **新工具 `memory_emotion`**：`list` / `mark` / `stats` / `budget` / `report`；只动候选表，不直接写记忆。日结仍用 `memory_write` 写第一人称感受/立场。
- **schema v6**：新增 `emotion_candidate` / `emotion_review` 两张表与索引；v5 库自动迁移，新库直接建 v6。
- **`memory_write` 可选 `source`**：默认为 `manual`，自动采集/日结写入可回溯来源；supersede 记 `source:merge`。
- **隐私**：插件 cwd 改为 `emotionPluginCwdPatterns` 配置，不内置任何平台；不自动创建日结调度；候选先脱敏、只留节选、30 天清理。
- **健康检查**：`/memory-tree/health` 返回 `tools` 与 `toolErrors`；工具注册逐个 try/catch，单个失败不再中断整组。
- **测试**：103 个用例、5 个测试文件（新增 `tests/emotion.test.mjs`）。

## 1.0.1（2026-11-17）

- **默认更顺手**：四枝默认都写 `user`；任务卡/判断叶换工作区也能直接查到，`workspace:<hash>` 改为显式隔离选项。
- **全库检索**：`scope=all` 现在覆盖 `user` 与所有已出现的工作区，不再只看当前工作区。
- **看板令牌**：恢复本机模式，令牌落在 `dataDir/board-token`，DSH 重启后旧链接仍可用。
- **脱敏开关**：`memory_write` 新增 `redact:false`，需要保留原文时不必再绕开工具。
- **初始化命令**：新增 `node bin/mt.mjs init`，一条命令复制起步模板并同步；已存在默认拒绝，`--force` 先备份再覆盖。
- **测试**：93 个用例、4 个测试文件。

## 1.0.0（2026-11-17）

首个公开版。

- **四枝分层**：主干 / 情感枝 / 任务枝 / 判断叶，各自有写入、检索、状态流转与作用域规则。
- **主干正本**：`AGENTS.md` 是唯一正本；插件只做可检索索引，手动写 `trunk` 一律落候选，主干 `active` 只由同步产生。
- **8 个工具**：`memory_search`、`memory_write`、`memory_forget`、`memory_tree`、`memory_card`、`memory_ingest`、`memory_daily`、`memory_admin`。
- **看板**：四枝星图、检索与过滤、详情抽屉、规则归枝、待确定写入、日记索引、打印/PDF、侧栏入口。
- **离线检索**：BM25 + 字符 n-gram 特征哈希；没命中就如实说没有，不编造。
- **作用域隔离**：`user` 与 `workspace:<hash>`；任务卡与判断叶默认按工作区分开。
- **数据与隐私**：本地 SQLite；默认脱敏；不读会话正文、不监听事件写库、不调外部 API。
- **命令行**：`doctor` / `stats` / `sync` / `search` / `add` / `list` / `card` / `tree` / `daily` / `diary` / `apply` / `forget` / `reindex` / `export` / `import` / `report` / `demo`。
- **首次使用**：附带 `examples/AGENTS.template.md`（中文、去本机化、带可删除案例）与 `mt demo` 隔离演示库；空库时看板给出下一步引导。
- **只面向中文用户**：界面、文档与示例均为中文，不提供英文说明。
- **测试**：91 个用例、4 个测试文件，全部用临时目录隔离，不碰真实库。
