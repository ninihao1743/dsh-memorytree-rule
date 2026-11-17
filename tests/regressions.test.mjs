// tests/regressions.test.mjs — 发布前查漏补缺的回归测试。
// 覆盖：跨工作区隔离、作用域过滤、事务回滚、正文上限、halfLife、主干 active 封堵、正本逐字写入。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { migrate, SCHEMA_VERSION } from "../lib/schema.mjs";
import { openMemoryDb } from "../lib/db.mjs";
import { MemoryStore } from "../lib/store.mjs";
import { syncTrunk, parseAgents } from "../lib/ingest.mjs";
import { runBoardAction } from "../lib/board.mjs";
import { applyDailyDecisions } from "../lib/daily.mjs";
import { exportTaskCards } from "../lib/cards.mjs";

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-reg-"));
  const db = openMemoryDb(path.join(dir, "memory.db"));
  const store = new MemoryStore(db, { clock: () => Date.now() });
  return {
    dir,
    db,
    store,
    cleanup() {
      try {
        db.close();
      } catch {
        /* 忽略 */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("跨工作区隔离：同 subject 任务卡互不取代", () => {
  const { store, cleanup } = makeStore();
  try {
    const a = store.add({ layer: "task", scope: "workspace:aaa", subject: "same", text: "A 的卡" }).node;
    const b = store.add({ layer: "task", scope: "workspace:bbb", subject: "same", text: "B 的卡" }).node;
    assert.equal(store.get(a.id).status, "active");
    assert.equal(store.get(b.id).status, "active");
  } finally {
    cleanup();
  }
});

test("appendToTaskCard 只追加到同作用域", () => {
  const { store, cleanup } = makeStore();
  try {
    const a = store.appendToTaskCard({ scope: "workspace:aaa", subject: "same", text: "A1" }).node;
    const b = store.appendToTaskCard({ scope: "workspace:bbb", subject: "same", text: "B1" }).node;
    assert.match(store.get(a.id).text, /A1/);
    assert.doesNotMatch(store.get(a.id).text, /B1/);
    assert.match(store.get(b.id).text, /B1/);
  } finally {
    cleanup();
  }
});

test("replaceCard 缺省作用域只动 user 卡", () => {
  const { store, cleanup } = makeStore();
  try {
    const user = store.add({ layer: "task", scope: "user", subject: "same", text: "user 旧卡" }).node;
    const ws = store.add({ layer: "task", scope: "workspace:aaa", subject: "same", text: "ws 旧卡" }).node;
    const replaced = store.replaceCard("same", { scope: "workspace:aaa", layer: "task", text: "ws 新卡" }).node;
    assert.equal(store.get(user.id).status, "active");
    assert.equal(store.get(ws.id).status, "superseded");
    assert.equal(store.get(replaced.id).scope, "workspace:aaa");
  } finally {
    cleanup();
  }
});

test("get 支持作用域过滤；supersede 拒绝跨作用域", () => {
  const { store, cleanup } = makeStore();
  try {
    const ws = store.add({ layer: "leaf", scope: "workspace:aaa", text: "私有配置" }).node;
    assert.equal(store.get(ws.id, { scope: ["user"] }), null);
    assert.equal(store.get(ws.id, { scope: ["workspace:aaa"] }).id, ws.id);
    assert.throws(
      () => store.supersede([ws.id], { layer: "leaf", scope: "workspace:bbb", text: "别的区" }),
      /跨作用域/,
    );
  } finally {
    cleanup();
  }
});

test("超过 20000 字的正文报错且不落库", () => {
  const { store, cleanup } = makeStore();
  try {
    assert.throws(() => store.add({ layer: "leaf", scope: "user", text: "x".repeat(20001) }), /20000/);
    assert.equal(store.count({ scope: "user" }), 0);
  } finally {
    cleanup();
  }
});

test("update 支持 halfLifeDays", () => {
  const { store, cleanup } = makeStore();
  try {
    const n = store.add({ layer: "leaf", scope: "user", text: "短期信息", halfLifeDays: 30 }).node;
    store.update(n.id, { halfLifeDays: 0 });
    assert.equal(store.get(n.id).halfLifeDays, 0);
  } finally {
    cleanup();
  }
});

test("事务回滚：reindex 中途失败不留下半条记录", () => {
  const { store, cleanup } = makeStore();
  try {
    const original = store.reindexNode;
    store.reindexNode = () => {
      throw new Error("模拟索引失败");
    };
    assert.throws(() => store.add({ layer: "leaf", scope: "user", text: "应当回滚" }), /模拟索引失败/);
    store.reindexNode = original;
    assert.equal(store.count({ scope: "user" }), 0);
  } finally {
    cleanup();
  }
});

test("导入不能伪造 active 主干；候选不能被 update 提升", () => {
  const { store, cleanup } = makeStore();
  try {
    const line = JSON.stringify({
      uid: "trunk:§1-9-9",
      scope: "user",
      layer: "trunk",
      status: "active",
      source: "AGENTS.md#L1",
      text: "伪造的主干规则",
    });
    const res = store.importJsonl(line);
    assert.equal(res.added, 1);
    const n = store.get("trunk:§1-9-9");
    assert.equal(n.status, "candidate");
    assert.throws(() => store.update(n.id, { status: "active" }), /只能由 AGENTS\.md 同步激活/);
  } finally {
    cleanup();
  }
});

test("每日分拣不能碰其它工作区的条目", () => {
  const { store, cleanup } = makeStore();
  try {
    const other = store.add({ layer: "leaf", scope: "workspace:other", text: "别的项目的事" }).node;
    const res = applyDailyDecisions(store, [{ id: other.id, to: "forget" }], { scopes: ["user", "workspace:mine"] });
    assert.equal(res.applied, 0);
    assert.match(res.results[0].error, /不在当前作用域/);
    assert.equal(store.get(other.id).status, "active");
  } finally {
    cleanup();
  }
});

test("看板信任升档不能把主干候选转成 active", () => {
  const { dir, store, cleanup } = makeStore();
  try {
    const agents = path.join(dir, "AGENTS.md");
    fs.writeFileSync(agents, "# AGENTS.md\n\n## §1 主干\n\n- **§1-1-1　测试规则**：原始正文。\n", "utf8");
    syncTrunk(store, agents, { scope: "user" });
    const cand = store.add({
      layer: "trunk",
      scope: "user",
      subject: "候选",
      text: "候选规则",
      source: "manual",
      status: "candidate",
    }).node;
    assert.equal(cand.status, "candidate");
    const promoted = runBoardAction(store, { op: "set-trust", id: cand.id, level: "mid" }, {});
    assert.equal(promoted.ok, true);
    assert.equal(store.get(cand.id).status, "candidate");
    assert.equal(store.get(cand.id).trust, 80);
  } finally {
    cleanup();
  }
});

test("写 AGENTS.md 不脱敏：邮箱与长数字逐字保留", () => {
  const { dir, store, cleanup } = makeStore();
  try {
    const agents = path.join(dir, "AGENTS.md");
    fs.writeFileSync(agents, "# AGENTS.md\n\n## §1 主干\n\n- **§1-1-1　测试规则**：原始正文。\n", "utf8");
    const options = { agentsPath: agents, backupDir: path.join(dir, "backups") };
    syncTrunk(store, agents, { scope: "user" });
    const tr = store.list({ layers: ["trunk"], status: "active" })[0];
    const body = "联系 owner@example.com，工单 1380013800000。";
    const written = runBoardAction(store, { op: "write-trunk", id: tr.id, text: body, confirm: true }, options);
    assert.equal(written.ok, true);
    assert.match(fs.readFileSync(agents, "utf8"), /owner@example\.com/);
    assert.match(fs.readFileSync(agents, "utf8"), /1380013800000/);
    assert.match(store.get(tr.id).text, /owner@example\.com/);
    assert.match(store.get(tr.id).text, /1380013800000/);
    assert.doesNotMatch(fs.readFileSync(agents, "utf8"), /\*\*\*/);
  } finally {
    cleanup();
  }
});

test("脱敏不误伤路径与 13 位时间戳，仍拦手机号/云密钥", () => {
  const { store, cleanup } = makeStore();
  try {
    const text = "路径 C:\\Users\\example\\a.txt，时间 1763300000000，电话 13800138000，AWS AKIAABCDEFGHIJKLMNOP。";
    const node = store.add({ layer: "leaf", scope: "user", text }).node;
    assert.match(node.text, /C:\\Users\\example\\a\.txt/);
    assert.match(node.text, /1763300000000/);
    assert.doesNotMatch(node.text, /13800138000/);
    assert.doesNotMatch(node.text, /AKIAABCDEFGHIJKLMNOP/);
  } finally {
    cleanup();
  }
});

test("标题参与检索：正文不含查询词也能命中", async () => {
  const { store, cleanup } = makeStore();
  try {
    const { searchMemory } = await import("../lib/search.mjs");
    store.add({ layer: "leaf", scope: "user", title: "独有标题词", text: "正文完全没有那个词。" });
    const res = searchMemory(store, { query: "独有标题词", scopes: ["user"], limit: 5 });
    assert.equal(res.hits.length >= 1, true);
    assert.match(res.hits[0].title, /独有标题词/);
  } finally {
    cleanup();
  }
});

test("日记写入也会脱敏手机号与邮箱", () => {
  const a = makeStore();
  try {
    a.store.diaryAdd("2026-11-17", "联系 13800138000 或 owner@example.com", "manual");
    const row = a.store.diaryGet("2026-11-17");
    assert.doesNotMatch(row.text, /13800138000/);
    assert.doesNotMatch(row.text, /owner@example\.com/);
    assert.match(row.text, /\*\*\*/);
  } finally {
    a.cleanup();
  }
});

test("导出/导入包含日记与主干大标题", () => {
  const a = makeStore();
  const b = makeStore();
  try {
    a.store.add({ layer: "leaf", scope: "user", text: "一条记忆" });
    a.store.diaryAdd("2026-11-17", "今天的日记", "auto");
    a.store.setTrunkBucket("trunk:§1-1-1", "机械组");
    const jsonl = a.store.exportJsonl();
    const res = b.store.importJsonl(jsonl, { mode: "merge" });
    assert.equal(res.added, 1);
    assert.equal(res.diary, 1);
    assert.equal(res.buckets, 1);
    assert.equal(b.store.diaryGet("2026-11-17").text, "今天的日记");
    assert.equal(b.store.trunkBuckets()["trunk:§1-1-1"], "机械组");
    const again = b.store.importJsonl(jsonl, { mode: "merge" });
    assert.equal(again.diary, 0);
    assert.equal(again.buckets, 1);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("导出/导入恢复 supersededBy 链", () => {
  const a = makeStore();
  const b = makeStore();
  try {
    const old = a.store.add({ layer: "leaf", scope: "user", text: "旧口径正文" }).node;
    const merged = a.store.supersede([old.id], { layer: "leaf", scope: "user", text: "新口径正文" }).node;
    const res = b.store.importJsonl(a.store.exportJsonl(), { mode: "merge" });
    assert.equal(res.added, 2);
    const importedOld = b.store.get(old.uid);
    const importedNew = b.store.get(merged.uid);
    assert.equal(importedOld.status, "superseded");
    assert.equal(importedOld.supersededBy, importedNew.id);
    assert.equal(importedOld.createdAt, a.store.get(old.uid).createdAt);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("统计支持作用域过滤", () => {
  const { store, cleanup } = makeStore();
  try {
    store.add({ layer: "leaf", scope: "user", text: "用户的" });
    store.add({ layer: "leaf", scope: "workspace:x", text: "工作区的" });
    assert.equal(store.stats(["user"]).total, 1);
    assert.equal(store.stats(["workspace:x"]).total, 1);
    assert.equal(store.stats().total, 2);
  } finally {
    cleanup();
  }
});

test("active 主干只能由 AGENTS.md 同步修改/遗忘", () => {
  const { dir, store, cleanup } = makeStore();
  try {
    const agents = path.join(dir, "AGENTS.md");
    fs.writeFileSync(agents, "# AGENTS.md\n\n## §1 主干\n\n- **§1-1-1　测试规则**：原始正文。\n", "utf8");
    syncTrunk(store, agents, { scope: "user" });
    const tr = store.list({ layers: ["trunk"], status: "active" })[0];
    assert.throws(() => store.update(tr.id, { text: "偷偷改正文" }), /只能由 AGENTS\.md 同步修改/);
    assert.throws(() => store.forget(tr.id), /不能直接遗忘 active 主干/);
    assert.throws(() => store.supersede([tr.id], { layer: "leaf", scope: "user", text: "取代" }), /不能取代 active 主干/);
    assert.equal(store.get(tr.id).text, "测试规则：原始正文。");
    store.update(tr.id, { text: "同步改正文" }, { allowActiveTrunk: true });
    assert.equal(store.get(tr.id).text, "同步改正文");
  } finally {
    cleanup();
  }
});

test("导入拒绝 layer 与 uid 前缀不一致的条目", () => {
  const { store, cleanup } = makeStore();
  try {
    const res = store.importJsonl(
      JSON.stringify({ uid: "trunk:§1-1-1", layer: "leaf", scope: "user", text: "伪造编号" }) + "\n",
      { mode: "merge" },
    );
    assert.equal(res.added, 0);
    assert.equal(res.skipped, 1);
    assert.equal(store.get("trunk:§1-1-1"), null);
  } finally {
    cleanup();
  }
});

test("AGENTS.md 编号重复时拒绝同步，不覆盖现有规则", () => {
  const { dir, store, cleanup } = makeStore();
  try {
    const agents = path.join(dir, "AGENTS.md");
    const body =
      "# AGENTS.md\n\n## §1 主干\n\n- **§1-1-1　规则甲**：甲甲甲甲。\n- **§1-1-1　规则乙**：乙乙乙乙。\n";
    fs.writeFileSync(agents, body, "utf8");
    const res = syncTrunk(store, agents, { scope: "user" });
    assert.equal(res.ok, false);
    assert.match(res.error, /编号重复/);
    assert.equal(store.list({ layers: ["trunk"], status: "active" }).length, 0);
  } finally {
    cleanup();
  }
});

test("空作用域检索返回空结果而不是 SQL 报错", async () => {
  const { store, cleanup } = makeStore();
  try {
    const { searchMemory } = await import("../lib/search.mjs");
    const res = searchMemory(store, { query: "任意", scopes: [], limit: 5 });
    assert.equal(res.hits.length, 0);
    assert.match(res.reason, /没有指定任何作用域/);
    assert.deepEqual(store.list({ scope: [] }), []);
    assert.equal(store.count({ scope: [] }), 0);
  } finally {
    cleanup();
  }
});

test("workspaceScope：Linux 保留大小写，Windows/macOS 归一", async () => {
  const { workspaceScope } = await import("../lib/paths.mjs");
  const a = workspaceScope("/tmp/Alpha");
  const b = workspaceScope("/tmp/alpha");
  if (process.platform === "linux") {
    assert.notEqual(a, b);
  } else {
    assert.equal(a, b);
  }
});

test("导入备份不会覆盖已激活的主干规则（跳过而不是整批失败）", () => {
  const { store, cleanup } = makeStore();
  try {
    const node = store.add({ layer: "trunk", scope: "user", text: "主干规则正文，至少四个字。", title: "主干规则" }).node;
    store.update(node.id, { status: "active" }, { allowActiveTrunk: true });
    const jsonl = store.exportJsonl();
    const res = store.importJsonl(jsonl, { mode: "update" });
    assert.equal(res.skipped >= 1, true, JSON.stringify(res));
    assert.equal(store.get(node.id).status, "active");
  } finally {
    cleanup();
  }
});

test("显式取代：允许 user 与当前工作区互换，仍挡住其它工作区", () => {
  const { store, cleanup } = makeStore();
  try {
    const note = store.add({ layer: "leaf", scope: "user", text: "用户级观察，后续并进任务卡。" }).node;
    const created = store.supersede(
      [note.id],
      { layer: "task", scope: "workspace:mine", subject: "merge", text: "合并后的任务卡正文。" },
      { scopes: ["user", "workspace:mine"] },
    );
    assert.equal(created.node.scope, "workspace:mine");
    assert.equal(store.get(note.id).status, "superseded");

    const foreign = store.add({ layer: "leaf", scope: "workspace:other", text: "别的工作区的条目。" }).node;
    assert.throws(
      () => store.supersede([foreign.id], { layer: "task", scope: "workspace:mine", text: "不该成功。" }, { scopes: ["user", "workspace:mine"] }),
      /不能跨作用域取代/,
    );
    assert.equal(store.get(foreign.id).status, "active");
  } finally {
    cleanup();
  }
});

test("每日分拣：工作区判断叶可以提升为 user 主干候选", () => {
  const { store, cleanup } = makeStore();
  try {
    const leaf = store.add({ layer: "leaf", scope: "workspace:mine", text: "这条观察值得进主干候选。" }).node;
    const res = applyDailyDecisions(
      store,
      [{ id: leaf.id, to: "trunk", title: "候选规则", text: "候选规则正文，至少四个字。" }],
      { scopes: ["workspace:mine"] },
    );
    assert.equal(res.applied, 1, JSON.stringify(res.results));
    assert.equal(res.results[0].ok, true, res.results[0].error);
    const created = store.get(res.results[0].newId);
    assert.equal(created.layer, "trunk");
    assert.equal(created.scope, "user");
    assert.equal(created.status, "candidate");
  } finally {
    cleanup();
  }
});

test("v0 旧库缺列：migrate 补齐 node 列并设置当前版本", () => {  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-v0-"));
  const db = new DatabaseSync(path.join(dir, "old.db"));
  try {
    db.exec("CREATE TABLE node (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL)");
    db.exec("INSERT INTO node (text) VALUES ('旧库里的第一条记忆'), ('旧库里的第二条记忆')");
    const version = migrate(db);
    assert.equal(version, SCHEMA_VERSION);
    const cols = new Set(db.prepare("PRAGMA table_info(node)").all().map((c) => c.name));
    for (const name of ["uid", "scope", "layer", "status", "checksum", "ts", "created_at", "updated_at"]) {
      assert.ok(cols.has(name), "缺少列 " + name);
    }
    const uids = db.prepare("SELECT uid FROM node ORDER BY id").all().map((r) => r.uid);
    assert.equal(new Set(uids).size, uids.length, "补齐后的 uid 必须唯一");
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("脱敏补充：GitHub PAT 与 Slack webhook 不落明文", () => {
  const { store, cleanup } = makeStore();
  try {
    const pat = "github_pat_" + "A".repeat(24);
    const hook = "https://hooks.slack.com/services/T000/B000/XXXXYYYYZZZZ";
    const node = store.add({ layer: "leaf", text: "凭据 " + pat + " 和 " + hook + "。" }).node;
    assert.ok(!node.text.includes(pat), node.text);
    assert.ok(!node.text.includes("hooks.slack.com/services"), node.text);
  } finally {
    cleanup();
  }
});

test("scope 为空或过长时拒绝写入", () => {
  const { store, cleanup } = makeStore();
  try {
    assert.throws(() => store.add({ layer: "leaf", scope: " ", text: "没有作用域。" }), /scope 不能为空/);
    assert.throws(() => store.add({ layer: "leaf", scope: "x".repeat(201), text: "作用域太长。" }), /scope 超过 200 字/);
  } finally {
    cleanup();
  }
});

test("格式像 §1 规则但解析失败时拒绝同步，不归档旧主干", () => {
  const { dir, store, cleanup } = makeStore();
  try {
    const agents = path.join(dir, "AGENTS.md");
    fs.writeFileSync(agents, "# AGENTS.md\n\n## §1 主干\n\n- **§1-1-1　规则甲**：甲甲甲甲。\n", "utf8");
    assert.equal(syncTrunk(store, agents, { scope: "user" }).ok, true);
    fs.writeFileSync(
      agents,
      "# AGENTS.md\n\n## §1 主干\n\n- **§1-1-1　规则甲**：甲甲甲甲。\n- **§1-1-2　坏规则** 少了冒号\n",
      "utf8",
    );
    const res = syncTrunk(store, agents, { scope: "user" });
    assert.equal(res.ok, false);
    assert.match(res.reason, /无法解析/);
    assert.equal(store.get("trunk:§1-1-1").status, "active", "旧规则不能被当成已删除而归档");
  } finally {
    cleanup();
  }
});

test("cards 跨作用域同 subject 都保留，不互相隐藏", () => {
  const { store, cleanup } = makeStore();
  try {
    store.add({ layer: "task", scope: "user", subject: "same", text: "user 卡", title: "user" });
    store.add({ layer: "task", scope: "workspace:aaa", subject: "same", text: "ws 卡", title: "ws" });
    const list = store.cards(["user", "workspace:aaa"]);
    assert.equal(list.length, 2);
    assert.deepEqual(new Set(list.map((n) => n.scope)), new Set(["user", "workspace:aaa"]));
    assert.equal(store.cards(["workspace:aaa"]).length, 1);
  } finally {
    cleanup();
  }
});

test("replaceCard 正文相同但标题变化时刷新元数据", () => {
  const { store, cleanup } = makeStore();
  try {
    const first = store.replaceCard("same", { scope: "user", layer: "task", text: "同一段正文" }).node;
    const second = store.replaceCard("same", { scope: "user", layer: "task", text: "同一段正文", title: "新标题" }).node;
    assert.equal(second.id, first.id);
    assert.equal(second.title, "新标题");
    assert.equal(store.get(first.id).status, "active");
  } finally {
    cleanup();
  }
});

test("replaceCard 命中已取代的同文卡时恢复 active 并降级当前卡", () => {
  const { store, cleanup } = makeStore();
  try {
    const first = store.replaceCard("same", { scope: "user", layer: "task", text: "第一版正文" }).node;
    const second = store.replaceCard("same", { scope: "user", layer: "task", text: "第二版正文" }).node;
    assert.equal(store.get(first.id).status, "superseded");
    const revived = store.replaceCard("same", { scope: "user", layer: "task", text: "第一版正文" }).node;
    assert.equal(revived.id, first.id);
    assert.equal(store.get(first.id).status, "active");
    assert.equal(store.get(second.id).status, "superseded");
    assert.equal(store.cards(["user"]).length, 1);
  } finally {
    cleanup();
  }
});

test("forget hard 清除其它条目的 superseded_by 悬空引用", () => {
  const { store, cleanup } = makeStore();
  try {
    const old = store.add({ layer: "leaf", text: "旧条目正文。" }).node;
    const fresh = store.add({ layer: "leaf", text: "新条目正文。" }).node;
    store.supersede([old.id], { layer: "leaf", text: "新条目正文。", scope: "user" });
    const marked = store.get(old.id);
    assert.equal(marked.status, "superseded");
    assert.ok(marked.supersededBy !== null);
    store.forget(fresh.id, { hard: true, reason: "测试" });
    assert.equal(store.get(old.id).supersededBy, null);
  } finally {
    cleanup();
  }
});

test("diaryAuto 只统计指定作用域的写入", () => {
  const { store, cleanup } = makeStore();
  try {
    store.add({ layer: "leaf", scope: "user", title: "用户区标题", text: "用户区正文。" });
    store.add({ layer: "leaf", scope: "workspace:aaa", title: "工作区标题", text: "工作区正文。" });
    store.audit("search", { scope: "user", query: "用户搜索词", hits: 1 });
    store.audit("search", { scope: "workspace:aaa", query: "工作区搜索词", hits: 1 });
    const res = store.diaryAuto(undefined, { scopes: ["user"] });
    assert.equal(res.skipped, false);
    assert.match(res.record.text, /用户区标题/);
    assert.doesNotMatch(res.record.text, /工作区标题/);
    assert.match(res.record.text, /用户搜索词/);
    assert.doesNotMatch(res.record.text, /工作区搜索词/);
  } finally {
    cleanup();
  }
});

test("count 遇到空 layers/status 返回 0，不拼非法 SQL", () => {
  const { store, cleanup } = makeStore();
  try {
    assert.equal(store.count({ layers: [] }), 0);
    assert.equal(store.count({ status: [] }), 0);
    assert.deepEqual(store.list({ layers: [] }), []);
  } finally {
    cleanup();
  }
});

test("导入超大 trunk_bucket 行被跳过而不是整批回滚", () => {
  const { store, cleanup } = makeStore();
  try {
    const line = JSON.stringify({ _kind: "trunk_bucket", uid: "trunk:§1-1-1", bucket: "x".repeat(61) }) + "\n";
    const res = store.importJsonl(line + JSON.stringify({ text: "正常条目正文。", layer: "leaf", scope: "user" }) + "\n", { mode: "merge" });
    assert.equal(res.buckets, 0);
    assert.equal(res.skipped, 1);
    assert.equal(res.added, 1);
    assert.equal(store.trunkBuckets()["trunk:§1-1-1"], undefined);
  } finally {
    cleanup();
  }
});

test("旧库 legacy:<id> 记忆能导出并重新导入", () => {
  const { store, cleanup } = makeStore();
  const other = makeStore();
  try {
    store.add({ uid: "legacy:7", layer: "task", scope: "user", subject: "旧卡", text: "旧库任务卡正文。" });
    const jsonl = store.exportJsonl();
    const res = other.store.importJsonl(jsonl, { mode: "merge" });
    assert.equal(res.added, 1);
    assert.equal(other.store.get("legacy:7").layer, "task");
  } finally {
    cleanup();
    other.cleanup();
  }
});

test("导入未知 layer 被跳过，不静默改成 leaf", () => {
  const { store, cleanup } = makeStore();
  try {
    const line = JSON.stringify({ uid: "weird:1", layer: "weird", scope: "user", text: "未知层正文。" }) + "\n";
    const res = store.importJsonl(line, { mode: "merge" });
    assert.equal(res.added, 0);
    assert.equal(res.skipped, 1);
  } finally {
    cleanup();
  }
});

test("脱敏保留 QQ/微信字段名，只替换值", () => {
  const { store, cleanup } = makeStore();
  try {
    const node = store.add({ layer: "leaf", text: "联系 QQ:123456789，微信=abcdefg。" }).node;
    assert.ok(!node.text.includes("123456789"), node.text);
    assert.ok(!node.text.includes("abcdefg"), node.text);
    assert.match(node.text, /QQ=\*\*\*/);
    assert.match(node.text, /微信=\*\*\*/);
  } finally {
    cleanup();
  }
});

test("cards.json 不会被 __proto__ 这类 subject 污染，卡片仍然写出", () => {
  const { store, dir, cleanup } = makeStore();
  try {
    store.add({ layer: "task", scope: "user", subject: "__proto__", title: "原型卡", text: "原型正文。" });
    exportTaskCards(store, dir);
    const payload = JSON.parse(fs.readFileSync(path.join(dir, "cards.json"), "utf8"));
    assert.equal(Object.getPrototypeOf(payload.cards), Object.prototype);
    assert.equal(payload.cards["__proto__"].title, "原型卡");
  } finally {
    cleanup();
  }
});

test("cards.json 顶层 user 优先，其它工作区同 subject 仍保留在 scoped", () => {
  const { store, dir, cleanup } = makeStore();
  try {
    store.add({ layer: "task", scope: "user", subject: "same", title: "用户卡", text: "用户正文。" });
    store.add({ layer: "task", scope: "workspace:aaa", subject: "same", title: "工作区卡", text: "工作区正文。" });
    exportTaskCards(store, dir);
    const payload = JSON.parse(fs.readFileSync(path.join(dir, "cards.json"), "utf8"));
    assert.equal(payload.cards.same.scope, "user");
    assert.equal(payload.scoped["workspace:aaa"].same.title, "工作区卡");
  } finally {
    cleanup();
  }
});

test("CLI migrate --db 把旧库当迁移源，不把当前记忆库指到旧库", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-cli-"));
  const oldFile = path.join(dir, "old-memories.db");
  const dataDir = path.join(dir, "data");
  const legacy = new DatabaseSync(oldFile);
  try {
    legacy.exec(
      "CREATE TABLE memory (id INTEGER PRIMARY KEY, text TEXT, layer TEXT, subject TEXT, tags TEXT, summary TEXT, importance REAL, created_at INTEGER, updated_at INTEGER)",
    );
    legacy.prepare("INSERT INTO memory (id,text,layer,subject,tags,summary,importance,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(1, "旧库里的任务卡正文。", "task", "旧卡", "[]", "旧卡", 0.8, Date.now(), Date.now());
  } finally {
    legacy.close();
  }
  const bin = fileURLToPath(new URL("../bin/mt.mjs", import.meta.url));
  const raw = execFileSync(process.execPath, [bin, "migrate", "--db", oldFile, "--data-dir", dataDir, "--apply", "--json"], {
    encoding: "utf8",
  });
  const res = JSON.parse(raw);
  assert.equal(res.ok, true);
  assert.equal(res.added, 1);
  const current = new DatabaseSync(path.join(dataDir, "memory.db"), { readOnly: true });
  try {
    const row = current.prepare("SELECT uid, text, layer FROM node WHERE uid='legacy:1'").get();
    assert.equal(row.layer, "task");
    assert.match(row.text, /旧库里的任务卡正文/);
  } finally {
    current.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI init 创建 AGENTS.md；已存在拒绝；--force 先备份", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-init-"));
  const agents = path.join(dir, "AGENTS.md");
  const dataDir = path.join(dir, "data");
  const bin = fileURLToPath(new URL("../bin/mt.mjs", import.meta.url));
  try {
    const first = spawnSync(process.execPath, [bin, "init", "--agents", agents, "--data-dir", dataDir, "--json"], { encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const created = JSON.parse(first.stdout);
    assert.equal(created.ok, true);
    assert.equal(created.sync.ok, true);
    assert.ok(fs.existsSync(agents));
    assert.match(fs.readFileSync(agents, "utf8"), /§1-1/);

    const again = spawnSync(process.execPath, [bin, "init", "--agents", agents, "--data-dir", dataDir, "--json"], { encoding: "utf8" });
    assert.equal(again.status, 1);
    assert.match(JSON.parse(again.stdout).error, /已存在/);

    fs.writeFileSync(agents, "旧正本内容\n");
    const forced = spawnSync(process.execPath, [bin, "init", "--agents", agents, "--data-dir", dataDir, "--force", "--json"], { encoding: "utf8" });
    assert.equal(forced.status, 0, forced.stderr || forced.stdout);
    const replaced = JSON.parse(forced.stdout);
    assert.ok(replaced.backup);
    assert.match(fs.readFileSync(replaced.backup, "utf8"), /旧正本内容/);
    assert.match(fs.readFileSync(agents, "utf8"), /§1-1/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI 非法 --scope/--status 明确报错，不静默当 all", () => {
  const bin = fileURLToPath(new URL("../bin/mt.mjs", import.meta.url));
  const scope = spawnSync(process.execPath, [bin, "list", "--scope", "bogus"], { encoding: "utf8" });
  assert.notEqual(scope.status, 0);
  assert.match(scope.stderr, /--scope 只能是/);
  const status = spawnSync(process.execPath, [bin, "list", "--status", "bogus", "--json"], { encoding: "utf8" });
  assert.notEqual(status.status, 0);
  assert.match(status.stdout, /未知 status/);
});

test("看板 approve active 主干只改信任，不走 candidate→active 守卫", () => {
  const { store, cleanup } = makeStore();
  try {
    const created = store.add({
      layer: "trunk",
      scope: "user",
      status: "active",
      subject: "§1-1-1",
      title: "规则",
      text: "规则正文。",
      source: "AGENTS.md#L1-L2",
    });
    const res = runBoardAction(store, { op: "approve", id: created.node.id });
    assert.equal(res.ok, true);
    assert.equal(res.mode, "approved");
    const fresh = store.get(created.node.id);
    assert.equal(fresh.status, "active");
    assert.equal(fresh.trust, 100);
  } finally {
    cleanup();
  }
});

test("归档主干候选时清掉它的大标题覆盖", () => {
  const { store, cleanup } = makeStore();
  try {
    const created = store.add({
      layer: "trunk",
      scope: "user",
      uid: "trunk:§1-1-1",
      subject: "§1-1-1",
      title: "候选",
      text: "候选正文。",
      source: "board:manual",
    });
    store.setTrunkBucket(created.node.uid, "临时组");
    store.forget(created.node.id, { hard: false, reason: "测试归档" });
    assert.equal(store.trunkBuckets()[created.node.uid], undefined);
  } finally {
    cleanup();
  }
});

test("§1 下错位编号与空正文规则进入 unparsed，不被静默吞掉", () => {
  const parsed = parseAgents(
    ["## §1 主干", "### §1-1 核心规则", "- **§2-1　错位编号**：正文。", "- **§1-1-1　空正文**："].join("\n"),
  );
  assert.equal(parsed.rules.length, 0);
  assert.ok(parsed.unparsed.some((x) => /非 §1 编号/.test(x.text)));
  assert.ok(parsed.unparsed.some((x) => /正文为空/.test(x.text)));
});

test("看板归枝/待写入/写主干对超长正文给出可读错误", () => {
  const { store, cleanup } = makeStore();
  try {
    const leaf = store.add({ layer: "leaf", scope: "user", text: "短叶。" }).node;
    const huge = "x".repeat(20001);
    const emo = runBoardAction(store, { op: "branch-emotion", id: leaf.id, text: huge });
    assert.equal(emo.ok, false);
    assert.match(emo.error, /20000/);
    const placement = runBoardAction(store, { op: "placement-create", id: leaf.id, text: huge });
    assert.equal(placement.ok, false);
    assert.match(placement.error, /20000/);
    const trunk = runBoardAction(store, {
      op: "write-trunk-new",
      id: leaf.id,
      text: huge,
      confirm: true,
      checks: [true, true, true, true, true],
    });
    assert.equal(trunk.ok, false);
    assert.match(trunk.error, /20000/);
  } finally {
    cleanup();
  }
});

test("CLI apply 决定文件坏 JSON 返回可读错误而不是堆栈", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-apply-"));
  const file = path.join(dir, "bad.json");
  fs.writeFileSync(file, "{ not json", "utf8");
  const bin = fileURLToPath(new URL("../bin/mt.mjs", import.meta.url));
  const res = spawnSync(process.execPath, [bin, "apply", "--file", file, "--json", "--data-dir", path.join(dir, "data")], {
    encoding: "utf8",
  });
  try {
    assert.notEqual(res.status, 0);
    assert.match(res.stdout, /读取或解析决定文件失败/);
    assert.doesNotMatch(res.stderr, /at .*\.mjs/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});





