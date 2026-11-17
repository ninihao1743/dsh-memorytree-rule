# 更新记录

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
