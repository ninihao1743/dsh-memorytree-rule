// tests/renumber.test.mjs — 库内编号编辑、重排、引用联动与待写入池的纯 Node 单测。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openMemoryDb } from "../lib/db.mjs";
import { MemoryStore } from "../lib/store.mjs";
import { syncTrunk } from "../lib/ingest.mjs";
import { normalizeNumberInput, parseRuleNum, parseAgentSections, planRenumber, removeAgentSectionRule, replaceAgentSectionRule, trunkGroups } from "../lib/rules.mjs";
import { runBoardAction } from "../lib/board.mjs";
import { checksum } from "../lib/text.mjs";
import { MemoryRuntime } from "../lib/runtime.mjs";
import { buildReportHtml } from "../lib/report.mjs";

const FIXTURE = [
  "# AGENTS.md",
  "",
  "## §1 主干（大脑）",
  "",
  "#### §1-1 基本判据",
  "",
  "- **§1-1-1　甲**：这是甲，见 §1-1-2。",
  "- **§1-1-2　乙**：这是乙，见 §1-1-1。",
  "- **§1-1-3　丙**：这是丙。",
  "",
  "#### §1-2 决策与授权",
  "",
  "- **§1-2-1　前**：这条在 §1-2。",
  "",
  "## §2 情感枝",
  "",
  "内容。",
  "",
].join("\n");

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-renum-"));
  const db = openMemoryDb(path.join(dir, "memory.db"));
  const store = new MemoryStore(db, { clock: () => Date.now() });
  return { dir, db, store };
}

function patch(overrides = {}) {
  return {
    id: "p1",
    uid: "trunk:§1-1-3",
    title: "丙",
    oldNum: "§1-1-3",
    newNum: "§1-1-1",
    oldText: "丙：这是丙。",
    newText: "丙：这是丙。",
    kind: "number",
    baseChecksum: checksum(FIXTURE),
    ...overrides,
  };
}

test("编号输入：三种写法都能归一化，§2 明确拒绝", () => {
  assert.equal(normalizeNumberInput("trunk:§1-1-3").num, "§1-1-3");
  assert.equal(normalizeNumberInput("§1-1-3").num, "§1-1-3");
  assert.equal(normalizeNumberInput("1-1-3").num, "§1-1-3");
  const rejected = normalizeNumberInput("§2-1");
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /只支持 §1/);
});

test("编号解析：组号/序号/uid", () => {
  assert.deepEqual(parseRuleNum("§1-3-7"), { groupNum: 3, index: 7, group: "§1-3" });
  assert.equal(parseRuleNum("随便"), null);
});

test("分组：#### 标题也能识别，不再只认 ###", () => {
  const groups = trunkGroups(FIXTURE);
  assert.deepEqual(groups.map((g) => g.key), ["§1-1", "§1-2"]);
});

test("重排 + 引用联动：§1-1-3 移到最前，后续编号顺延", () => {
  const plan = planRenumber(FIXTURE, [patch()]);
  assert.equal(plan.ok, true, JSON.stringify(plan.conflicts));
  assert.equal(plan.mode, "renumber");
  assert.equal(plan.refsChanged, 2);
  assert.match(plan.newText, /- \*\*§1-1-1　丙\*\*：这是丙。/);
  assert.match(plan.newText, /- \*\*§1-1-2　甲\*\*：这是甲，见 §1-1-3。/);
  assert.match(plan.newText, /- \*\*§1-1-3　乙\*\*：这是乙，见 §1-1-2。/);
  assert.ok(!plan.newText.includes("@@MTNUM_"));
  assert.ok(plan.planToken);
});

test("仅正文：只改目标规则，不重排、不动引用", () => {
  const plan = planRenumber(FIXTURE, [patch({ newNum: "§1-1-3", kind: "text", newText: "丙：改写后的正文。" })]);
  assert.equal(plan.ok, true, JSON.stringify(plan.conflicts));
  assert.equal(plan.mode, "content");
  assert.equal(plan.numberChanged, false);
  assert.equal(plan.refsChanged, 0);
  assert.match(plan.newText, /§1-1-3　丙\*\*：改写后的正文。/);
  assert.match(plan.newText, /§1-1-2　乙\*\*：这是乙，见 §1-1-1。/);
});

test("跨组移动：源组顺延，目标组插入，引用跟着跨组", () => {
  const plan = planRenumber(FIXTURE, [patch({ oldNum: "§1-1-2", newNum: "§1-2-1", uid: "trunk:§1-1-2", title: "乙", oldText: "乙：这是乙，见 §1-1-1。", newText: "乙：这是乙，见 §1-1-1。" })]);
  assert.equal(plan.ok, true, JSON.stringify(plan.conflicts));
  assert.match(plan.newText, /- \*\*§1-1-1　甲\*\*：这是甲，见 §1-2-1。/);
  assert.match(plan.newText, /- \*\*§1-1-2　丙\*\*：这是丙。/);
  assert.match(plan.newText, /- \*\*§1-2-1　乙\*\*：这是乙，见 §1-1-1。/);
});

test("冲突：目标号重复、越界、文件已变都拒绝", () => {
  const dup = planRenumber(FIXTURE, [
    patch({ id: "p1", uid: "trunk:§1-1-2", oldNum: "§1-1-2", newNum: "§1-1-1", oldText: "乙：这是乙，见 §1-1-1。", newText: "乙：这是乙，见 §1-1-1。" }),
    patch({ id: "p2" }),
  ]);
  assert.equal(dup.ok, false);
  assert.ok(dup.conflicts.some((c) => c.code === "duplicate-target"));

  const out = planRenumber(FIXTURE, [patch({ newNum: "§1-1-9" })]);
  assert.equal(out.ok, false);
  assert.ok(out.conflicts.some((c) => c.code === "target-out-of-range"));

  const stale = planRenumber(FIXTURE, [patch({ baseChecksum: "bad" })]);
  assert.equal(stale.ok, false);
  assert.ok(stale.conflicts.some((c) => c.code === "stale-file"));
});

test("集成：暂存 → 检索冲突 → 确认写入，备份并清空待写入", () => {
  const { dir, db, store } = makeStore();
  const agents = path.join(dir, "AGENTS.md");
  fs.writeFileSync(agents, FIXTURE, "utf8");
  const options = { agentsPath: agents, backupDir: path.join(dir, "backups") };
  try {
    syncTrunk(store, agents, { scope: "user" });
    const tr = store.list({ layers: ["trunk"], status: "active" }).find((n) => n.uid === "trunk:§1-1-3");
    assert.ok(tr, "应先同步出 §1-1-3");
    store.setTrunkBucket("trunk:§1-1-3", "移动组");

    const staged = runBoardAction(store, { op: "stage-patch", id: tr.id, num: "trunk:§1-1-1", text: "丙：这是丙。" }, options);
    assert.equal(staged.ok, true, staged.error);
    assert.equal(store.pendingPatches().length, 1);
    assert.equal(fs.readFileSync(agents, "utf8"), FIXTURE, "暂存时不得改 AGENTS.md");

    const scan = runBoardAction(store, { op: "scan-patches" }, options);
    assert.equal(scan.ok, true);
    assert.equal(scan.conflicts.length, 0);
    assert.ok(scan.planToken);

    const applied = runBoardAction(store, { op: "apply-patches", scanToken: scan.planToken }, options);
    assert.equal(applied.ok, true, applied.error);
    const after = fs.readFileSync(agents, "utf8");
    assert.match(after, /- \*\*§1-1-1　丙\*\*：这是丙。/);
    assert.match(after, /- \*\*§1-1-2　甲\*\*：这是甲，见 §1-1-3。/);
    assert.match(after, /- \*\*§1-1-3　乙\*\*：这是乙，见 §1-1-2。/);
    assert.ok(applied.backup && fs.existsSync(applied.backup), "写文件前应留备份");
    assert.equal(store.pendingPatches().length, 0);
    assert.equal(store.patchBatches(1).length, 1);
    const active = store.list({ layers: ["trunk"], status: "active" });
    assert.deepEqual(active.map((n) => n.uid).sort(), ["trunk:§1-1-1", "trunk:§1-1-2", "trunk:§1-1-3", "trunk:§1-2-1"]);
    const buckets = store.trunkBuckets();
    assert.equal(buckets["trunk:§1-1-1"], "移动组", "编号变化后看板大标题应跟着规则走");
    assert.equal(buckets["trunk:§1-1-3"], undefined);
  } finally {
    try { db.close(); } catch { /* 忽略 */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("看板：渲染编号输入、待确定写入池与检索冲突入口", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-renum-view-"));
  const agents = path.join(dir, "AGENTS.md");
  fs.writeFileSync(agents, FIXTURE, "utf8");
  const rt = new MemoryRuntime({ dataDir: dir, agentsPath: agents, backupDir: path.join(dir, "backups") });
  try {
    const store = rt.open();
    syncTrunk(store, agents, { scope: "user" });
    const tr = store.list({ layers: ["trunk"], status: "active" }).find((n) => n.uid === "trunk:§1-1-3");
    const staged = runBoardAction(store, { op: "stage-patch", id: tr.id, num: "trunk:§1-1-1", text: "丙：这是丙。" }, { agentsPath: agents, backupDir: path.join(dir, "backups") });
    assert.equal(staged.ok, true, staged.error);
    const html = buildReportHtml(rt, store, null);
    assert.match(html, /待确定写入/);
    assert.match(html, /已写入记录/);
    assert.match(html, /检索冲突/);
    assert.match(html, /data-patch-del=/);
    assert.match(html, /id="edit-num"/);
    assert.match(html, /id="scan-modal"/);
    assert.ok(html.includes("/^trunk:§1-\\d+-\\d+$/"), "看板内联正则必须保留 \\d 转义");
    assert.match(html, /§1-1-3 → §1-1-1/);
  } finally {
    try { rt.close(); } catch { /* 忽略 */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const SECTION_FIXTURE = [
  "# AGENTS.md",
  "",
  "## §1 主干（大脑）",
  "",
  "#### §1-1 基本判据",
  "",
  "- **§1-1-1　甲**：这是甲。",
  "",
  "## §2 情感枝",
  "",
  "- **§2-1　相处**：相处正文。",
  "- **§2-2　工作**：工作正文。",
  "",
  "## §3 任务枝",
  "",
  "- **§3-1　任务规则**：任务正文。",
  "",
  "## §4 判断叶",
  "",
  "- **§4-1　判断**：判断正文。",
  "",
].join("\n");

test("§2–§4 解析：三节、行号与全文", () => {
  const sections = parseAgentSections(SECTION_FIXTURE);
  assert.deepEqual(sections.map((s) => s.key), ["§2", "§3", "§4"]);
  assert.deepEqual(sections.map((s) => s.rules.length), [2, 1, 1]);
  const first = sections[0].rules[0];
  assert.equal(first.num, "§2-1");
  assert.equal(first.title, "相处");
  assert.equal(first.text, "相处：相处正文。");
  assert.equal(first.startLine, 11);
  assert.equal(first.endLine, 11);
});

test("§2–§4 编辑/删除：只改目标块，保留其它规则", () => {
  const replaced = replaceAgentSectionRule(SECTION_FIXTURE, "§2-1", "新标题：新正文");
  assert.equal(replaced.ok, true, replaced.error);
  assert.match(replaced.text, /- \*\*§2-1　新标题\*\*：新正文/);
  assert.match(replaced.text, /- \*\*§2-2　工作\*\*：工作正文。/);
  assert.equal((replaced.text.match(/§2-1/g) || []).length, 1);

  const removed = removeAgentSectionRule(SECTION_FIXTURE, "§2-2");
  assert.equal(removed.ok, true, removed.error);
  assert.doesNotMatch(removed.text, /§2-2/);
  assert.match(removed.text, /- \*\*§2-1　相处\*\*：相处正文。/);
  assert.match(removed.text, /## §2 情感枝/);
});

test("§1 分组内的说明文字会让重排拒绝，而不是静默丢失", () => {
  const raw = FIXTURE.replace(
    "- **§1-1-2　乙**：这是乙，见 §1-1-1。",
    "- **§1-1-2　乙**：这是乙，见 §1-1-1。\n\n> 这里是主人写的说明，不属于任何规则。",
  );
  const plan = planRenumber(raw, [patch({ baseChecksum: checksum(raw) })]);
  assert.equal(plan.ok, false);
  assert.match(plan.error, /非规则文字/);
  assert.equal(plan.conflicts[0].code, "non-rule-text");
});

test("§2–§4 看板写操作：编辑/删除都备份并落盘", () => {
  const { dir, db, store } = makeStore();
  const agents = path.join(dir, "AGENTS.md");
  fs.writeFileSync(agents, SECTION_FIXTURE, "utf8");
  const options = { agentsPath: agents, backupDir: path.join(dir, "backups") };
  try {
    const wrote = runBoardAction(store, { op: "write-section-rule", num: "§2-1", text: "新标题：新正文", confirm: true }, options);
    assert.equal(wrote.ok, true, wrote.error);
    assert.ok(wrote.backup && fs.existsSync(wrote.backup));
    let current = fs.readFileSync(agents, "utf8");
    assert.match(current, /- \*\*§2-1　新标题\*\*：新正文/);
    assert.match(current, /- \*\*§3-1　任务规则\*\*：任务正文。/);

    const deleted = runBoardAction(store, { op: "delete-section-rule", num: "§3-1", confirm: true }, options);
    assert.equal(deleted.ok, true, deleted.error);
    current = fs.readFileSync(agents, "utf8");
    assert.doesNotMatch(current, /§3-1/);
    assert.match(current, /- \*\*§2-1　新标题\*\*：新正文/);
    assert.match(current, /- \*\*§4-1　判断\*\*：判断正文。/);
  } finally {
    try { db.close(); } catch { /* 忽略 */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
