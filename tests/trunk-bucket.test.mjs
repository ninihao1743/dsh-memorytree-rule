// tests/trunk-bucket.test.mjs — 主干大标题：按编号自动分组 + 用户指定覆盖。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryRuntime } from "../lib/runtime.mjs";
import { syncTrunk } from "../lib/ingest.mjs";
import { buildReportHtml } from "../lib/report.mjs";
import { runBoardAction } from "../lib/board.mjs";

const AGENTS = [
  "# AGENTS.md",
  "",
  "## §1 主干（大脑）",
  "",
  "### §1-1 基本判据",
  "",
  "- **§1-1-1　我是谁**：测试规则甲。",
  "",
  "- **§1-1-2　永久规则**：测试规则乙。",
  "",
  "### §1-6 环境事实",
  "",
  "- **§1-6-1　可信度**：测试规则丙。",
  "",
  "## §2 情感枝",
  "",
  "内容。",
  "",
].join("\n");

function setupWith(agentsText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-bucket-"));
  const agents = path.join(dir, "AGENTS.md");
  fs.writeFileSync(agents, agentsText, "utf8");
  const rt = new MemoryRuntime({ dataDir: dir, agentsPath: agents });
  const store = rt.open();
  syncTrunk(store, agents, { scope: "user" });
  return {
    dir,
    agents,
    rt,
    store,
    options: { agentsPath: agents, backupDir: path.join(dir, "backups") },
    html() {
      return buildReportHtml(rt, store, null);
    },
    cleanup() {
      try {
        rt.close();
      } catch {
        /* 忽略 */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function setup() {
  return setupWith(AGENTS);
}

test("主干大标题：没指定时按 §1 编号自动分组", () => {
  const s = setup();
  try {
    const html = s.html();
    assert.match(html, /<span class="grp">DSH本体规则<\/span><em>2 条<\/em>/);
    assert.match(html, /<span class="grp">本机环境事实<\/span><em>1 条<\/em>/);
    assert.doesNotMatch(html, /<span class="grp">其他规则<\/span>/, "空分组不渲染");
    assert.match(html, /id="bucket-modal"/);
    assert.match(html, /data-act="bucket"/);
  } finally {
    s.cleanup();
  }
});

test("主干大标题：§1-1-4..7 不被特殊分组，整组按编号连续", () => {
  const rules = Array.from({ length: 8 }, (_, i) => `- **§1-1-${i + 1}　规则${i + 1}**：测试内容。`).join("\n\n");
  const agentsText = [
    "# AGENTS.md",
    "",
    "## §1 主干（大脑）",
    "",
    "### §1-1 基本判据",
    "",
    rules,
    "",
    "### §1-5 环境事实",
    "",
    "- **§1-5-1　机器**：测试内容。",
    "",
    "## §2 情感枝",
    "",
    "内容。",
    "",
  ].join("\n");
  const s = setupWith(agentsText);
  try {
    const html = s.html();
    assert.match(html, /<span class="grp">DSH本体规则<\/span><em>8 条<\/em>/);
    assert.match(html, /<span class="grp">本机环境事实<\/span><em>1 条<\/em>/);
    assert.doesNotMatch(html, /<span class="grp">其他规则<\/span>/, "§1-1-4..7 不应落入其他规则");
    const group = html.match(/<span class="grp">DSH本体规则<\/span>[\s\S]*?<\/details>/);
    assert.ok(group, "找到 DSH本体规则 分组");
    const rids = [...group[0].matchAll(/<span class="rid">([^<]+)<\/span>/g)].map((m) => m[1]);
    assert.deepEqual(rids, Array.from({ length: 8 }, (_, i) => `§1-1-${i + 1}`));
  } finally {
    s.cleanup();
  }
});

test("主干大标题：指定后看板按新大标题分组", () => {
  const s = setup();
  try {
    const done = runBoardAction(s.store, { op: "set-trunk-bucket", uid: "trunk:§1-1-1", bucket: "其他规则" }, s.options);
    assert.equal(done.ok, true, done.error);
    assert.equal(s.store.trunkBuckets()["trunk:§1-1-1"], "其他规则");
    const html = s.html();
    assert.match(html, /<span class="grp">其他规则<\/span><em>1 条<\/em>/);
    assert.match(html, /<span class="grp">DSH本体规则<\/span><em>1 条<\/em>/);
  } finally {
    s.cleanup();
  }
});

test("主干大标题：可新建大标题，写进 BOARD 供下拉选择", () => {
  const s = setup();
  try {
    const done = runBoardAction(
      s.store,
      { op: "set-trunk-bucket", uid: "trunk:§1-1-2", bucket: "网络与外部输入" },
      s.options,
    );
    assert.equal(done.ok, true, done.error);
    const html = s.html();
    assert.match(html, /<span class="grp">网络与外部输入<\/span><em>1 条<\/em>/);
    assert.match(html, /"buckets":\[[^\]]*"网络与外部输入"/);
  } finally {
    s.cleanup();
  }
});

test("主干大标题：__default 恢复自动分组", () => {
  const s = setup();
  try {
    runBoardAction(s.store, { op: "set-trunk-bucket", uid: "trunk:§1-1-1", bucket: "其他规则" }, s.options);
    const reset = runBoardAction(s.store, { op: "set-trunk-bucket", uid: "trunk:§1-1-1", bucket: "__default" }, s.options);
    assert.equal(reset.ok, true, reset.error);
    assert.equal(reset.mode, "trunk-bucket-reset");
    assert.equal(s.store.trunkBuckets()["trunk:§1-1-1"], undefined);
    assert.match(s.html(), /<span class="grp">DSH本体规则<\/span><em>2 条<\/em>/);
  } finally {
    s.cleanup();
  }
});

test("主干大标题：只接受带编号的主干规则与合法名字", () => {
  const s = setup();
  try {
    assert.equal(runBoardAction(s.store, { op: "set-trunk-bucket", uid: "leaf:12", bucket: "其他规则" }, s.options).ok, false);
    assert.equal(runBoardAction(s.store, { op: "set-trunk-bucket", uid: "trunk:§2-1", bucket: "其他规则" }, s.options).ok, false);
    assert.equal(runBoardAction(s.store, { op: "set-trunk-bucket", uid: "trunk:§1-1-1", bucket: "  " }, s.options).ok, false);
    assert.equal(runBoardAction(s.store, { op: "set-trunk-bucket", uid: "trunk:§1-1-1", bucket: "x".repeat(25) }, s.options).ok, false);
    const missing = runBoardAction(s.store, { op: "set-trunk-bucket", uid: "trunk:§1-9-9", bucket: "其他规则" }, s.options);
    assert.equal(missing.ok, false);
    assert.match(missing.error, /找不到/);
  } finally {
    s.cleanup();
  }
});

test("主干大标题：归枝写入主干时一起记下大标题", () => {
  const s = setup();
  try {
    const leaf = s.store.add({
      layer: "leaf",
      scope: "user",
      subject: "self",
      title: "新约定",
      text: "每次答复先给结论，再给理由。",
      importance: 0.85,
    }).node;
    const done = runBoardAction(
      s.store,
      {
        op: "write-trunk-new",
        id: leaf.id,
        text: leaf.text,
        confirm: true,
        checks: [true, true, true, true, true],
        group: "§1-1",
        bucket: "其他规则",
      },
      s.options,
    );
    assert.equal(done.ok, true, done.error || JSON.stringify(done));
    assert.equal(done.bucket, "其他规则");
    assert.equal(done.node.uid, "trunk:§1-1-3");
    assert.equal(s.store.trunkBuckets()["trunk:§1-1-3"], "其他规则");
    assert.match(fs.readFileSync(s.agents, "utf8"), /每次答复先给结论/);
    const html = s.html();
    assert.match(html, /<span class="grp">其他规则<\/span><em>1 条<\/em>/);
    assert.match(html, /<span class="grp">DSH本体规则<\/span><em>2 条<\/em>/);
  } finally {
    s.cleanup();
  }
});

test("主干大标题：看板内联脚本可解析", () => {
  const s = setup();
  try {
    const html = s.html();
    const scripts = Array.from(html.matchAll(/<script(?![^>]*type=)[^>]*>([\s\S]*?)<\/script>/g)).map((m) => m[1]);
    assert.ok(scripts.length >= 1, "应该至少有一段内联脚本");
    for (const code of scripts) {
      assert.doesNotThrow(() => new Function(code), "内联脚本有语法错误");
    }
    assert.match(html, /id="trunk-bucket-line"/);
    assert.match(html, /fillBucketSelect/);
    assert.match(html, /openBucketForBranch/);
  } finally {
    s.cleanup();
  }
});
