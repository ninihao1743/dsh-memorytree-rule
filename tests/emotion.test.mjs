// tests/emotion.test.mjs — 情感枝自动收录：采集、打分、脱敏、候选表、预算与迁移。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openMemoryDb } from "../lib/db.mjs";
import { MemoryStore } from "../lib/store.mjs";
import { currentVersion, SCHEMA_VERSION } from "../lib/schema.mjs";
import { MemoryRuntime } from "../lib/runtime.mjs";
import { localDate } from "../lib/diary.mjs";
import {
  budgetFor,
  candidateStats,
  captureEmotionEvent,
  classifyEvent,
  extractText,
  listCandidates,
  markCandidates,
  recordReview,
  redactForCandidate,
  scoreCandidate,
} from "../lib/emotion.mjs";

function makeRuntime(config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-emo-"));
  const rt = {
    config: { emotionCapture: true, emotionMinScore: 35, emotionPluginCwdPatterns: ["plugins"], ...config },
    paths: { home: dir },
    _emotionContext: new Map(),
    open() {
      if (!this._store) {
        const db = openMemoryDb(path.join(dir, "memory.db"));
        this._store = new MemoryStore(db, { clock: () => Date.now() });
      }
      return this._store;
    },
    close() {
      try {
        this._store?.close();
      } catch {
        /* 忽略 */
      }
      this._store = null;
    },
  };
  return {
    rt,
    dir,
    cleanup() {
      rt.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const mainSession = { header: { id: "s-main", cwd: "C:\\work\\main" } };
const pluginSession = { header: { id: "s-plugin", cwd: "C:\\work\\plugins\\chat" } };

function userEvent(text, sourceKind = "user") {
  return { type: "user/message", data: { role: "user", source: { kind: sourceKind }, content: [{ type: "text", text }] } };
}

function assistantEvent(text) {
  return { type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text }] } } };
}

test("提取正文：只取 text 块，跳过运行时上下文与纯代码围栏", () => {
  assert.equal(extractText(userEvent("我今天有点难过")), "我今天有点难过");
  assert.equal(extractText(assistantEvent("我在想，也许你说得对。")), "我在想，也许你说得对。");
  assert.equal(extractText(userEvent("Current runtime context. 当前时间 2026-11-18")), "");
  assert.equal(extractText(userEvent("```\nconst x = 1\n```")), "");
});

test("打分：相处/工作/插件三类都能过 35 分门槛", () => {
  const relationship = scoreCandidate("我今天很难过，想起以前的事，眼泪止不住。", "user", "relationship");
  assert.ok(relationship.score >= 35, JSON.stringify(relationship));
  const work = scoreCandidate("又崩了，搞了一晚上还是失败，白忙。", "assistant", "work");
  assert.ok(work.score >= 35, JSON.stringify(work));
  const plugin = scoreCandidate("这条我不回，太像挑事了，访客又在挑衅。", "assistant", "plugin");
  assert.ok(plugin.score >= 35, JSON.stringify(plugin));
  assert.ok(scoreCandidate("你好", "user", "relationship").score < 35);
});

test("分类：主会话用户 / 插件 cwd / 助手工作复盘", () => {
  assert.equal(classifyEvent(mainSession, userEvent("我今天很难过，想起以前的事。")).category, "relationship");
  assert.equal(classifyEvent(mainSession, userEvent("调度器发来的提醒，今天该做日结了。", "schedule")).category, "work");
  assert.equal(
    classifyEvent(pluginSession, userEvent("[访客甲 (0123456789ABCDEF0123456789ABCDEF)] 你好"), "x", { pluginCwdPatterns: ["plugins"] }).category,
    "plugin",
  );
  assert.equal(classifyEvent(mainSession, assistantEvent("又崩了，报错修了一晚上，还是失败。")).category, "work");
});

test("默认开启：未配置 emotionCapture 时也采集；显式 false 关闭", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-emo-default-"));
  const rt = new MemoryRuntime({ dataDir: dir });
  try {
    assert.equal(rt.config.emotionCapture, true);
    const res = captureEmotionEvent(rt, mainSession, userEvent("我今天很难过，想起以前的事。"));
    assert.equal(res.ok, true, JSON.stringify(res));
  } finally {
    rt.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const offDir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-emo-off-"));
  const offRt = new MemoryRuntime({ dataDir: offDir, emotionCapture: false });
  try {
    assert.equal(offRt.config.emotionCapture, false);
    const res = captureEmotionEvent(offRt, mainSession, userEvent("我今天很难过，想起以前的事。"));
    assert.equal(res.ok, false);
    assert.equal(res.skipped, "disabled");
  } finally {
    offRt.close();
    fs.rmSync(offDir, { recursive: true, force: true });
  }
});

test("噪声：系统提醒与调度包装不进候选", () => {
  assert.equal(extractText(userEvent("<system-reminder>\nThe following workspace instructions may be relevant.")), "");
  assert.equal(extractText(userEvent("[SCHEDULE REMINDER]\nThis is a scheduled message from the user\nreminder_prompt_json: \"...\"")), "");
});

test("脱敏：访客昵称+OpenID 变访客，@提及变某人", () => {
  const out = redactForCandidate("[你好 (0123456789ABCDEF0123456789ABCDEF)] 你好 (@you) 我的邮箱 a@b.com");
  assert.match(out, /\[访客\]/);
  assert.match(out, /@某人/);
  assert.doesNotMatch(out, /0123456789ABCDEF0123456789ABCDEF/);
  assert.doesNotMatch(out, /a@b\.com/);
});

test("采集：入表、去重、列表、标记、统计", () => {
  const { rt, dir, cleanup } = makeRuntime();
  try {
    const event = userEvent("我今天很难过，想起以前的事，眼泪止不住。");
    const first = captureEmotionEvent(rt, mainSession, event);
    assert.equal(first.ok, true, JSON.stringify(first));
    const again = captureEmotionEvent(rt, mainSession, event);
    assert.equal(again.skipped, "duplicate");
    const rows = listCandidates(rt.open().db, { day: first.day });
    assert.equal(rows.length, 1);
    const marked = markCandidates(rt.open().db, [rows[0].id], "accepted", [99]);
    assert.equal(marked.updated, 1);
    const accepted = listCandidates(rt.open().db, { day: first.day, status: "accepted" });
    assert.equal(accepted[0].nodeId, 99);
    const stats = candidateStats(rt.open().db, first.day);
    assert.equal(stats.total, 1);
    assert.equal(stats.byCategory.relationship, 1);
    assert.equal(stats.byStatus.accepted, 1);
    assert.ok(fs.existsSync(path.join(dir, "memory.db")));
  } finally {
    cleanup();
  }
});

test("上限：同一会话最多 6 条，插件类别最多 4 条", () => {
  const { rt, cleanup } = makeRuntime();
  try {
    for (let i = 0; i < 7; i++) {
      captureEmotionEvent(rt, mainSession, userEvent("我今天很难过，想起以前的事，第" + i + "次。"));
    }
    const relationshipRows = listCandidates(rt.open().db, { day: localDate() });
    assert.equal(relationshipRows.length, 6);

    for (let i = 0; i < 6; i++) {
      captureEmotionEvent(rt, pluginSession, assistantEvent("这条我不回，太像挑事了，访客又在挑衅，第" + i + "次。"));
    }
    const all = listCandidates(rt.open().db, { day: localDate() });
    assert.equal(all.length, 10); // 6 relationship + 4 plugin
  } finally {
    cleanup();
  }
});

test("预算与日结记账：账本缺失时不冒充有账本", () => {
  const { rt, cleanup } = makeRuntime();
  try {
    const b = budgetFor(rt, {});
    assert.equal(b.ok, true);
    assert.equal(b.ledger, false);
    assert.equal(b.over, false);
    assert.equal(b.capCny, 0.3);
    const r = recordReview(rt.open().db, {
      day: "2026-11-18",
      candidates: 3,
      written: 1,
      dismissed: 2,
      costCny: 0.01,
      tokens: 123,
      note: "测试",
    });
    assert.ok(r.id > 0);
  } finally {
    cleanup();
  }
});

test("迁移：新库 v6 有候选表/ review 表，v5 空库能升到 v6", () => {
  const { rt, cleanup } = makeRuntime();
  try {
    const store = rt.open();
    assert.equal(currentVersion(store.db), SCHEMA_VERSION);
    assert.equal(SCHEMA_VERSION, 6);
    const tables = new Set(
      store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name),
    );
    assert.ok(tables.has("emotion_candidate"));
    assert.ok(tables.has("emotion_review"));
  } finally {
    cleanup();
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-emo-mig-"));
  const file = path.join(dir, "memory.db");
  const old = new DatabaseSync(file);
  old.exec("PRAGMA user_version = 5");
  old.close();
  const db = openMemoryDb(file);
  try {
    assert.equal(currentVersion(db), 6);
    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    assert.ok(names.has("emotion_candidate"));
    assert.ok(names.has("emotion_review"));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
