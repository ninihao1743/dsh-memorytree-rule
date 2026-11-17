// tests/memory-tree.test.mjs — 纯 Node 单测：不依赖宿主，直接测库、检索、同步、迁移、分拣。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openMemoryDb } from "../lib/db.mjs";
import { MemoryStore } from "../lib/store.mjs";
import { searchMemory } from "../lib/search.mjs";
import { parseAgents, syncTrunk } from "../lib/ingest.mjs";
import { importLegacy } from "../lib/import-legacy.mjs";
import { buildDailyReport, applyDailyDecisions } from "../lib/daily.mjs";
import { contentBlocks, tokenize, redact } from "../lib/text.mjs";
import { localDate } from "../lib/diary.mjs";
import { MemoryRuntime } from "../lib/runtime.mjs";
import { buildReportHtml } from "../lib/report.mjs";
import { buildThinkPrompt, ensureBoardToken, runBoardAction, appendRuleToAgents, trunkGroups } from "../lib/board.mjs";

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-test-"));
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

test("分词：中文能切出二字组，英文按词切", () => {
  const t = tokenize("记忆树插件 memory_tree");
  assert.ok(t.has("b:记忆"));
  assert.ok(t.has("b:插件"));
  assert.ok(t.has("w:memory"));
  assert.ok(t.has("w:tree"));
});

test("脱敏：密钥/邮箱/长数字在写入前被替换", () => {
  const r = redact("token sk-abcdefghijklmnop123456 联系 a@b.com 电话 13800138000");
  assert.match(r.text, /sk-\*\*\*/);
  assert.match(r.text, /\*\*\*@\*\*\*/);
  assert.doesNotMatch(r.text, /13800138000/);
  assert.ok(r.redactions.length >= 2);
});

test("工具渲染：字符串包成宿主可接受的内容块数组", () => {
  const one = contentBlocks("命中 1 条");
  assert.deepEqual(one, [{ type: "text", text: "命中 1 条" }]);
  const passthrough = [{ type: "text", text: "已经是数组" }];
  assert.equal(contentBlocks(passthrough), passthrough);
  assert.deepEqual(contentBlocks(null), [{ type: "text", text: "" }]);
});

test("看板：自包含 HTML 带星图、四主题、详情抽屉与打印入口", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-report-"));
  const rt = new MemoryRuntime({ dataDir: dir, agentsPath: path.join(dir, "AGENTS.md") });
  try {
    const store = rt.open();
    store.add({ layer: "task", subject: "visual", title: "看板测试卡", text: "星图与主题包的自包含页面。" });
    store.add({ layer: "emotion", title: "情感测试", text: "情感枝完整正文-EMOTION" });
    store.add({ layer: "leaf", title: "判断测试", text: "判断叶完整正文-LEAF" });
    fs.writeFileSync(rt.paths.agentsPath, [
      "## §2 情感枝",
      "",
      "- **§2-1　相处情感**：测试 §2 正文。",
      "",
      "## §3 任务枝",
      "",
      "- **§3-1　任务枝规则**：测试 §3 正文。",
      "",
      "## §4 判断叶",
      "",
      "- **§4-1　判断叶是什么**：测试 §4 正文。",
      "",
    ].join("\n"));
    const longText = "这是一条很长的规则正文，用来确认详情抽屉不会只显示摘要。".repeat(8) + "尾部标记：完整正文已显示。";
    store.add({ layer: "task", subject: "visual-long", title: "长规则测试", text: longText });
    const html = buildReportHtml(rt, store, null);
    assert.match(html, /data-theme-set="paper"/);
    assert.match(html, /class="star"/);
    assert.match(html, /id="drawer"/);
    assert.match(html, /打印 \/ PDF/);
    assert.match(html, /四枝构成/);
    assert.match(html, /data-act="edit"/);
    assert.match(html, /data-act="think"/);
    assert.match(html, /data-act="delete"/);
    assert.match(html, /id="edit-modal"/);
    assert.match(html, /id="think-modal"/);
    assert.match(html, /发送至“当前会话”/);
    assert.match(html, /发送至“新会话”/);
    assert.match(html, /id="branch-modal"/);
    assert.match(html, /请选择写入哪条枝/);
    assert.match(html, /id="task-modal"/);
    assert.match(html, /id="trunk-modal"/);
    assert.match(html, /先核对核心规则资格/);
    assert.doesNotMatch(html, /id="trust-value"/);
    assert.doesNotMatch(html, /重要程度/);
    assert.doesNotMatch(html, /id="importance-value"/);
    assert.doesNotMatch(html, /id="level-data"/);
    assert.doesNotMatch(html, /importance/);
    assert.match(html, /id="board-data"/);
    assert.match(html, /id="map-zoom"/);
    assert.match(html, /map-full/);
    assert.match(html, /点击星图空白处放大\/还原/);
    assert.doesNotMatch(html, /08 \/ 根系/);
    assert.doesNotMatch(html, /09 \/ 健康检查/);
    assert.doesNotMatch(html, /根系是什么/);
    assert.doesNotMatch(html, /根系/);
    assert.match(html, /08 \/ 规则/);
    assert.match(html, /09 \/ 审计/);
    assert.match(html, /§2-1/);
    assert.match(html, /class="rule-item searchable"/);
    assert.match(html, /data-node="agent:§2-1"/);
    assert.match(html, /情感枝、任务枝、判断叶规则/);
    assert.match(html, /情感枝、任务枝、判断叶本体规则正文。/);
    assert.match(html, /write-section-rule/);
    assert.match(html, /delete-section-rule/);
    assert.match(html, /<p>星图与主题包的自包含页面。<\/p>/);
    assert.match(html, /情感枝完整正文-EMOTION/);
    assert.match(html, /判断叶完整正文-LEAF/);
    assert.ok(html.includes("尾部标记：完整正文已显示。"), "详情抽屉应带完整正文，而不是截断的 preview");
    assert.doesNotMatch(html, /https?:\/\//);
  } finally {
    try { rt.close(); } catch { /* 忽略 */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("看板按钮：主干修改生成候选，删除归档，通过提升，令牌可复用", () => {
  const { dir, store, cleanup } = makeStore();
  try {
    const tr = store.add({
      layer: "trunk",
      scope: "user",
      subject: "测试规则",
      title: "测试规则",
      text: "原始规则正文。",
      source: "AGENTS.md#L1-L2",
    }).node;
    assert.equal(tr.status, "active");

    const changed = runBoardAction(store, { op: "update", id: tr.id, text: "修改后的规则正文。" });
    assert.equal(changed.ok, true);
    assert.equal(changed.mode, "candidate");
    assert.equal(changed.node.layer, "trunk");
    assert.equal(changed.node.status, "candidate");
    assert.match(changed.node.text, /修改后的规则正文/);
    assert.equal(store.get(tr.id).text, "原始规则正文。", "AGENTS 正本对应条目不能被看板直接改掉");

    const denied = runBoardAction(store, { op: "delete", id: tr.id });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /AGENTS\.md/);

    const candDenied = runBoardAction(store, { op: "delete-trunk", id: changed.node.id, confirm: true });
    assert.equal(candDenied.ok, false);
    assert.match(candDenied.error, /候选/);
    const candDeleted = runBoardAction(store, { op: "delete", id: changed.node.id });
    assert.equal(candDeleted.ok, true);
    assert.equal(store.get(changed.node.id).status, "archived");

    const leaf = store.add({ layer: "leaf", scope: "user", text: "一条临时判断。" }).node;
    const archived = runBoardAction(store, { op: "delete", id: leaf.id });
    assert.equal(archived.ok, true);
    assert.equal(store.get(leaf.id).status, "archived");

    const cand = store.update(leaf.id, { status: "candidate", trust: 40 });
    assert.equal(cand.status, "candidate");
    const approved = runBoardAction(store, { op: "approve", id: leaf.id });
    assert.equal(approved.ok, true);
    assert.equal(store.get(leaf.id).status, "active");
    assert.equal(store.get(leaf.id).trust, 100);

    const prompt = buildThinkPrompt(store.get(tr.id));
    assert.match(prompt, /【规则信息】/);
    assert.match(prompt, /AGENTS\.md/);
    assert.match(prompt, /不写文件、不调用工具/);

    const t1 = ensureBoardToken(dir);
    const t2 = ensureBoardToken(dir);
    assert.match(t1, /^[a-f0-9]{48}$/);
    assert.equal(t1, t2);
    assert.equal(fs.readFileSync(path.join(dir, "board-token"), "utf8").trim(), t1);
  } finally {
    cleanup();
  }
});

test("客户端入口：注册侧栏「记忆树」与主区域 iframe", () => {
  const code = fs.readFileSync(new URL("../client.js", import.meta.url), "utf8");
  assert.match(code, /sidebar\.panellist/);
  assert.match(code, /name:\s*["']main["']/);
  assert.match(code, /key:\s*PANEL_ID/);
  assert.match(code, /\/memory-tree\/board\?panel=1/);
  assert.match(code, /\/memory-tree\/health/);
  assert.match(code, /记忆树看板暂不可用/);
});

test("写入检索：2 个汉字也能召回", () => {
  const { store, cleanup } = makeStore();
  try {
    const { node } = store.add({
      layer: "task",
      subject: "backup",
      title: "备份脚本",
      text: "备份脚本把 memories.db 复制到 D:\\backup\\memory-backup，保留最近 20 份。",
    });
    assert.equal(node.layer, "task");
    const res = searchMemory(store, { query: "备份", scopes: ["user"], limit: 5 });
    assert.equal(res.empty, undefined);
    assert.equal(res.hits[0].id, node.id);
  } finally {
    cleanup();
  }
});

test("检索：没命中时如实返回空结果，不编造", () => {
  const { store, cleanup } = makeStore();
  try {
    store.add({ layer: "task", subject: "x", text: "语音链路走 GPT-SoVITS 9881 端口。" });
    const res = searchMemory(store, { query: "kubernetes 集群升级", scopes: ["user"] });
    assert.equal(res.empty, true);
    assert.equal(res.hits.length, 0);
    assert.ok(res.reason.includes("没有命中"));
  } finally {
    cleanup();
  }
});

test("作用域：workspace 条目不会串到别的工作区", () => {
  const { store, cleanup } = makeStore();
  try {
    const n = store.add({ layer: "leaf", scope: "workspace:aaa", text: "项目甲的私有配置在 config 目录。" }).node;
    assert.equal(searchMemory(store, { query: "私有配置", scopes: ["user", "workspace:bbb"] }).hits.length, 0);
    const hit = searchMemory(store, { query: "私有配置", scopes: ["workspace:aaa"] });
    assert.equal(hit.hits[0].id, n.id);
  } finally {
    cleanup();
  }
});

test("默认作用域：四枝默认 user，all 检索覆盖全库", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-scope-"));
  const agents = path.join(dir, "AGENTS.md");
  fs.writeFileSync(agents, "## §1 主干\n\n- **§1-1　核心规则**：测试规则。\n");
  const rt = new MemoryRuntime({ dataDir: dir, agentsPath: agents });
  try {
    for (const layer of ["trunk", "emotion", "task", "leaf"]) {
      assert.equal(rt.defaultScope(layer, { cwd: dir }), "user");
    }
    const store = rt.open();
    store.add({ layer: "task", scope: "user", subject: "global", text: "全局任务卡" });
    store.add({ layer: "leaf", scope: "workspace:other", text: "别的项目判断叶" });
    const all = rt.scopesFor({ cwd: dir }, "all");
    assert.ok(all.scopes.includes("user"));
    assert.ok(all.scopes.includes("workspace:other"));
    const hit = searchMemory(store, { query: "别的项目", scopes: all.scopes });
    assert.equal(hit.hits.length, 1);
    const current = rt.scopesFor({ cwd: dir }, "workspace");
    assert.deepEqual(current.scopes, [rt.workspaceOf({ cwd: dir }).scope]);
    const raw = store.add({ layer: "leaf", text: "邮箱 raw@example.com", skipRedact: true }).node;
    assert.match(raw.text, /raw@example\.com/);
  } finally {
    rt.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("主干：手工写入只产生候选；AGENTS.md 同步的才是 active", () => {
  const { store, cleanup } = makeStore();
  try {
    const manual = store.add({ layer: "trunk", title: "新规则", text: "每天先看任务清单。" }).node;
    assert.equal(manual.status, "candidate");
    assert.ok(manual.tags.includes("主干候选"));
    const synced = store.add({ layer: "trunk", source: "AGENTS.md#L1-L2", text: "主干的正式规则。" }).node;
    assert.equal(synced.status, "active");
  } finally {
    cleanup();
  }
});

test("取代：旧条目不删除，标 superseded，默认检索不到", () => {
  const { store, cleanup } = makeStore();
  try {
    const old = store.add({ layer: "task", subject: "eac", text: "渲染走旧脚本 render.ps1。" }).node;
    const { node: next, superseded } = store.supersede([old.id], { layer: "task", subject: "eac", text: "渲染改走 eac 插件，旧脚本已停用。" });
    assert.deepEqual(superseded, [old.id]);
    assert.equal(store.get(old.id).status, "superseded");
    const fresh = searchMemory(store, { query: "渲染", scopes: ["user"] });
    assert.equal(fresh.hits.some((h) => h.id === old.id), false);
    const withOld = searchMemory(store, { query: "渲染", scopes: ["user"], status: ["active", "candidate", "superseded", "archived"] });
    assert.ok(withOld.hits.some((h) => h.id === next.id));
  } finally {
    cleanup();
  }
});

test("遗忘：默认归档可恢复，hard 才物理删除", () => {
  const { store, cleanup } = makeStore();
  try {
    const a = store.add({ layer: "leaf", text: "这条要归档。" }).node;
    store.forget(a.id, { reason: "测试" });
    assert.equal(store.get(a.id).status, "archived");
    const b = store.add({ layer: "leaf", text: "这条要删除。" }).node;
    store.forget(b.id, { hard: true, reason: "测试" });
    assert.equal(store.get(b.id), null);
  } finally {
    cleanup();
  }
});

test("任务卡：同 subject 新卡替换旧卡，只留一张 active", () => {
  const { store, cleanup } = makeStore();
  try {
    store.replaceCard("pet-bridge", { layer: "task", subject: "pet-bridge", text: "旧的声音链路说明。" });
    store.replaceCard("pet-bridge", { layer: "task", subject: "pet-bridge", text: "新的声音链路说明：9881 端口。" });
    const actives = store.list({ layers: ["task"], status: "active", subject: "pet-bridge" });
    assert.equal(actives.length, 1);
    assert.match(actives[0].text, /9881/);
    assert.equal(store.count({ layers: ["task"], status: "superseded", subject: "pet-bridge" }), 1);
  } finally {
    cleanup();
  }
});

test("解析 AGENTS.md：只收 §1 规则，多行规则合并且给出行号", () => {
  const md = [
    "# 记忆树",
    "## §1 主干（大脑）",
    "### 核心判据",
    "#### §1-1 基本判据",
    "",
    "- **§1-1-1　我是谁**：我叫「续」。",
    "  第二行是同一条规则的补充。",
    "  - 子条目也属于这条规则。",
    "- **§1-1-2　永久规则**：优先级最高。",
    "",
    "## §2 情感枝",
    "- **§2-1　相处情感**：不在主干里。",
    "",
    "## §3 任务枝",
    "- **§3-1　任务枝规则**：也不在主干里。",
  ].join("\n");
  const p = parseAgents(md);
  assert.equal(p.rules.length, 2);
  assert.equal(p.rules[0].num, "§1-1-1");
  assert.equal(p.rules[0].group, "基本判据");
  assert.ok(p.rules[0].text.includes("补充"));
  assert.ok(p.rules[0].text.includes("子条目"));
  assert.equal(p.rules[0].startLine, 6);

  const { store, cleanup, dir } = makeStore();
  try {
    const agents = path.join(dir, "AGENTS.md");
    fs.writeFileSync(agents, md, "utf8");
    const r1 = syncTrunk(store, agents);
    assert.equal(r1.ok, true);
    assert.equal(r1.added, 2);
    assert.equal(store.count({ layers: ["trunk"], status: "active" }), 2);
    const r2 = syncTrunk(store, agents);
    assert.equal(r2.added + r2.updated, 0);
    assert.equal(r2.unchanged, 2);

    fs.writeFileSync(agents, md.replace("优先级最高。", "优先级最高，任何行为都不能绕过。"), "utf8");
    const r3 = syncTrunk(store, agents);
    assert.equal(r3.updated, 1);

    fs.writeFileSync(agents, md.split("\n").filter((l) => !l.includes("§1-1-2")).join("\n"), "utf8");
    const r4 = syncTrunk(store, agents);
    assert.equal(r4.archived, 1);
    assert.equal(store.count({ layers: ["trunk"], status: "active" }), 1);
  } finally {
    cleanup();
  }
});

test("迁移旧库：task/misc 按标签分流，重跑幂等", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-legacy-"));
  const legacy = path.join(dir, "memories.db");
  const db = new DatabaseSync(legacy);
  db.exec(`CREATE TABLE memory (id INTEGER PRIMARY KEY, layer TEXT, subject TEXT, text TEXT, summary TEXT,
    tags TEXT, ts INTEGER, half_life_days REAL, tier TEXT)`);
  const ins = db.prepare("INSERT INTO memory (id,layer,subject,text,summary,tags,ts,half_life_days,tier) VALUES (?,?,?,?,?,?,?,?,?)");
  ins.run(1, "task", "restart-dsh", "重启只走 restart_dsh.ps1。", null, '["任务枝"]', 1700000000, 0, "L2");
  ins.run(2, "misc", "", "主人说以后先备份再改。", null, '["情感枝","relationship"]', 1700000100, 30, "L2");
  ins.run(3, "misc", "", "备份脚本要带时间戳。", null, '["主干候选"]', 1700000200, 0, "L2");
  ins.run(4, "misc", "", "一个还没分类的观察。", null, "[]", 1700000300, 0, "L2");
  db.close();

  const { store, cleanup } = makeStore();
  try {
    const r = importLegacy(store, legacy);
    assert.equal(r.ok, true);
    assert.equal(r.added, 4);
    assert.equal(r.byLayer.emotion, 1);
    assert.equal(r.byLayer.task, 1);
    assert.equal(r.byLayer.trunk, 1);
    assert.equal(r.byLayer.leaf, 1);
    assert.equal(store.count({ layers: ["trunk"], status: "candidate" }), 1);
    const again = importLegacy(store, legacy);
    assert.equal(again.added, 0);
    assert.equal(again.duplicate, 4);
  } finally {
    cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("每日分拣：报告列待分拣，apply 能把叶转成卡或遗忘", () => {
  const { store, cleanup } = makeStore();
  try {
    const a = store.add({ layer: "leaf", text: "pet-bridge 的 TTS 端口固定 9881。", tags: "语音" }).node;
    store.add({ layer: "leaf", text: "今天先不聊这个。", tags: "语音,闲聊" }).node;
    const rep = buildDailyReport(store, { scopes: ["user"], hours: 24, limit: 10 });
    assert.equal(rep.pendingCount, 2);
    assert.ok(rep.items.some((i) => i.id === a.id));
    assert.ok(rep.clusters.some((c) => c.key === "tag:语音"));

    const res = applyDailyDecisions(
      store,
      [
        { id: a.id, to: "task", subject: "pet-bridge" },
        { id: store.list({ layers: ["leaf"], status: "active" }).find((n) => n.id !== a.id).id, to: "forget" },
      ],
      { scopes: ["user"] },
    );
    assert.equal(res.applied, 2);
    assert.equal(store.get(a.id).status, "superseded");
    const card = store.list({ layers: ["task"], status: "active", subject: "pet-bridge" });
    assert.equal(card.length, 1);
    assert.match(card[0].text, /9881/);
  } finally {
    cleanup();
  }
});

test("同 subject 直接 add 任务卡也会取代旧卡", () => {
  const { store, cleanup } = makeStore();
  try {
    const a = store.add({ layer: "task", subject: "add-card", text: "旧卡：走 8080。" }).node;
    const b = store.add({ layer: "task", subject: "add-card", text: "新卡：走插件。" }).node;
    assert.equal(store.get(a.id).status, "superseded");
    assert.equal(store.get(a.id).supersededBy, b.id);
    assert.equal(store.count({ layers: ["task"], status: "active", subject: "add-card" }), 1);
  } finally {
    cleanup();
  }
});

test("过期条目降权，active 优先", () => {
  const { store, cleanup } = makeStore();
  try {
    const now = Date.now();
    const expired = store.add({ layer: "task", subject: "old", text: "旧路线：走 8080 端口。", validUntil: now - 86400000 }).node;
    const fresh = store.add({ layer: "task", subject: "new", text: "新路线：走 8787 端口。", validUntil: now + 86400000 }).node;
    const res = searchMemory(store, { query: "端口", scopes: ["user"], limit: 5, now });
    assert.equal(res.hits[0].id, fresh.id);
    assert.ok(res.hits.some((h) => h.id === expired.id && h.expired));
  } finally {
    cleanup();
  }
});

test("日记：自动索引只写库内事实，手写不被自动覆盖", () => {
  const { store, cleanup } = makeStore();
  try {
    const today = localDate(Date.now());
    store.add({ layer: "task", subject: "diary-demo", title: "日记测试卡", text: "写一条日记索引，路径 D:\\example\\workspace。" });
    const auto = store.diaryAuto(today, { dbFile: "X:\\memory.db" });
    assert.equal(auto.skipped, false);
    assert.match(auto.record.text, /新增 1 条/);
    assert.match(auto.record.text, /日记测试卡/);
    assert.match(auto.record.text, /X:\\memory\.db/);
    assert.equal(auto.record.mood, "auto");

    store.diaryAdd(today, "手写：今天把日记补回来了。", "manual");
    const again = store.diaryAuto(today);
    assert.equal(again.skipped, true);
    assert.match(again.record.text, /手写/);

    const forced = store.diaryAuto(today, { force: true });
    assert.equal(forced.skipped, false);
    assert.equal(store.diaryList(10).length, 1);
    assert.equal(store.stats().diaryTotal, 1);
  } finally {
    cleanup();
  }
});

test("导入导出：JSONL 往返不丢关键字段", () => {
  const { store, cleanup } = makeStore();
  try {
    store.add({ layer: "emotion", text: "主人说先做插件，再谈别的。", tags: "相处", importance: 0.8, validUntil: Date.now() + 3600000 });
    const jsonl = store.exportJsonl();
    const { store: store2, cleanup: cleanup2 } = makeStore();
    try {
      const r = store2.importJsonl(jsonl);
      assert.equal(r.added, 1);
      const n = store2.list({ limit: 5 })[0];
      assert.equal(n.layer, "emotion");
      assert.ok(n.tags.includes("相处"));
      assert.ok(n.validUntil > Date.now());
    } finally {
      cleanup2();
    }
  } finally {
    cleanup();
  }
});
test("归类：任务推荐落卡、情感归枝、主干五项检查写正本", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-place-"));
  const agents = path.join(dir, "AGENTS.md");
  fs.writeFileSync(
    agents,
    "# AGENTS.md\n\n## §1 主干（大脑）\n\n### §1-1 基本判据\n\n- **§1-1-1　测试规则**：原始规则正文。\n\n## §2 情感枝\n\n内容。\n",
    "utf8",
  );
  const db = openMemoryDb(path.join(dir, "memory.db"));
  const store = new MemoryStore(db, { clock: () => Date.now() });
  const options = { agentsPath: agents, backupDir: path.join(dir, "backups") };
  try {
    syncTrunk(store, agents, { scope: "user" });
    const groups = trunkGroups(fs.readFileSync(agents, "utf8"));
    assert.equal(groups[0].key, "§1-1");
    assert.equal(groups[0].title, "基本判据");

    const leaf = store.add({ layer: "leaf", scope: "user", subject: "self", title: "群规则", text: "群管理档只能查询，不能执行操作。", importance: 0.85 }).node;
    const created = runBoardAction(store, { op: "placement-create", id: leaf.id, text: leaf.text }, options);
    assert.equal(created.ok, true);
    assert.equal(created.placement.status, "pending");
    assert.match(created.prompt, /action=placement, op=recommend/);

    store.placementRecommend(created.placement.id, { subject: "bot", reason: "这是插件操作规则" });
    const task = runBoardAction(store, { op: "branch-task", id: leaf.id, requestId: created.placement.id, subject: "bot" }, options);
    assert.equal(task.ok, true);
    assert.equal(store.get(leaf.id).status, "superseded");
    assert.match(store.cards(["user"]).find((c) => c.subject === "bot").text, /群管理档/);

    const emo = store.add({ layer: "leaf", scope: "user", subject: "self", title: "偏好", text: "用户喜欢安静的环境。" }).node;
    const emoDone = runBoardAction(store, { op: "branch-emotion", id: emo.id, text: emo.text }, options);
    assert.equal(emoDone.ok, true);
    assert.equal(emoDone.node.layer, "emotion");
    assert.equal(store.get(emo.id).status, "superseded");

    const trunkLeaf = store.add({ layer: "leaf", scope: "user", subject: "self", title: "新约定", text: "每次答复先给结论，再给理由。" }).node;
    const denied = runBoardAction(store, { op: "write-trunk-new", id: trunkLeaf.id, text: trunkLeaf.text }, options);
    assert.equal(denied.ok, false);
    const ok = runBoardAction(store, {
      op: "write-trunk-new",
      id: trunkLeaf.id,
      text: trunkLeaf.text,
      confirm: true,
      checks: [true, true, true, true, true],
      group: "§1-1",
    }, options);
    assert.equal(ok.ok, true, ok.error || JSON.stringify(ok));
    assert.match(fs.readFileSync(agents, "utf8"), /每次答复先给结论/);
    assert.ok(ok.backup && fs.existsSync(ok.backup));
    assert.equal(store.get(trunkLeaf.id).status, "superseded");
  } finally {
    try { db.close(); } catch { /* 忽略 */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("看板写正本：确认后备份并改 AGENTS.md；信任升档；添加规则", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-write-"));
  const agents = path.join(dir, "AGENTS.md");
  fs.writeFileSync(agents, "# AGENTS.md\n\n## §1 主干（大脑）\n\n- **§1-1-1　测试规则**：原始规则正文。\n\n## §2 情感枝\n\n内容。\n", "utf8");
  const db = openMemoryDb(path.join(dir, "memory.db"));
  const store = new MemoryStore(db, { clock: () => Date.now() });
  const options = { agentsPath: agents, backupDir: path.join(dir, "backups") };
  try {
    syncTrunk(store, agents, { scope: "user" });
    const tr = store.list({ layers: ["trunk"], status: "active" })[0];
    assert.ok(tr, "应先同步出一条主干");
    const denied = runBoardAction(store, { op: "write-trunk", id: tr.id, text: "改写后的规则正文。" }, options);
    assert.equal(denied.ok, false);

    const written = runBoardAction(store, { op: "write-trunk", id: tr.id, text: "改写后的规则正文。", confirm: true }, options);
    assert.equal(written.ok, true);
    assert.match(fs.readFileSync(agents, "utf8"), /改写后的规则正文/);
    assert.ok(written.backup && fs.existsSync(written.backup), "写文件前应留备份");
    assert.match(store.get(tr.id).text, /改写后的规则正文/);

    const add = runBoardAction(store, { op: "add-rule", text: "新规则：回复先给结论。" }, options);
    assert.equal(add.ok, true);
    assert.equal(add.node.layer, "leaf");

    const leaf = store.add({ layer: "leaf", scope: "user", text: "待评估的候选。" }).node;
    store.update(leaf.id, { status: "candidate" });
    const promoted = runBoardAction(store, { op: "set-trust", id: leaf.id, level: "mid" }, options);
    assert.equal(promoted.ok, true);
    assert.equal(store.get(leaf.id).status, "active");
    assert.equal(store.get(leaf.id).trust, 80);

    const beforeImportance = store.get(leaf.id).importance;
    const imp = runBoardAction(store, { op: "set-importance", id: leaf.id, level: "high" }, options);
    assert.equal(imp.ok, false, "重要程度功能已移除，旧操作应被拒绝");
    assert.match(imp.error, /未知操作/);
    assert.equal(store.get(leaf.id).importance, beforeImportance);

    const del = runBoardAction(store, { op: "delete-trunk", id: tr.id, confirm: true }, options);
    assert.equal(del.ok, true);
    assert.doesNotMatch(fs.readFileSync(agents, "utf8"), /测试规则/);
    assert.equal(store.get(tr.id).status, "archived");
  } finally {
    try { db.close(); } catch { /* 忽略 */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

