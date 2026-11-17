// lib/import-legacy.mjs — 把旧 Python 版 memories.db 的记忆条目迁进新库（幂等、可重跑）。
//
// 旧库里除了四枝还混着旧插件遗留的人设/梗/词条等表；这里只搬「记忆条目」这一件事：
//   memory.layer='task'                      → task 卡（subject 保留）
//   memory.layer='misc' 且 tags 含 情感枝/relationship → emotion
//   memory.layer='misc' 且 tags 含 任务枝               → task
//   memory.layer='misc' 且 tags 含 主干候选/judge-trunk  → trunk 候选（status=candidate，等主人点头）
//   其余 misc                                   → leaf（待分拣）
// 每条都带 source=legacy:memories.db#<id> 与逐字 evidence，便于回查。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { checksum } from "./text.mjs";
import { tx } from "./db.mjs";

function toMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? Math.trunc(n * 1000) : Math.trunc(n);
}

function parseTags(v) {
  if (Array.isArray(v)) return v.map(String);
  try {
    const a = JSON.parse(v ?? "[]");
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

function classify(row) {
  const tags = parseTags(row.tags);
  const layer = String(row.layer ?? "misc");
  if (layer === "task") return { layer: "task", status: "active", tags, importance: 0.8, trust: 90 };
  const has = (s) => tags.some((t) => t.includes(s));
  if (has("情感枝") || has("relationship")) return { layer: "emotion", status: "active", tags, importance: 0.7, trust: 85 };
  if (has("任务枝")) return { layer: "task", status: "active", tags, importance: 0.75, trust: 85 };
  if (has("主干候选") || has("judge-trunk") || has("judge_trunk")) {
    return { layer: "trunk", status: "candidate", tags: Array.from(new Set([...tags, "主干候选"])), importance: 0.85, trust: 80 };
  }
  return { layer: "leaf", status: "active", tags, importance: 0.4, trust: 60 };
}

function openLegacy(file) {
  try {
    return { db: new DatabaseSync(file, { readOnly: true }), temp: null };
  } catch (err) {
    // 旧服务可能正占着文件：复制一份再读（只读迁移，不动原库）。
    const temp = path.join(os.tmpdir(), "mt-legacy-" + checksum(file + ":" + Date.now()) + ".db");
    fs.copyFileSync(file, temp);
    return { db: new DatabaseSync(temp, { readOnly: true }), temp };
  }
}

export function importLegacy(store, legacyFile, opts = {}) {
  if (!legacyFile || !fs.existsSync(legacyFile)) {
    return { ok: false, reason: "找不到旧库文件：" + String(legacyFile), added: 0 };
  }
  const scope = opts.scope ?? "user";
  const dryRun = opts.dryRun === true;
  let opened;
  try {
    opened = openLegacy(legacyFile);
  } catch (err) {
    return { ok: false, reason: "打不开旧库：" + (err && err.message ? err.message : String(err)), added: 0 };
  }
  const db = opened.db;
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => String(r.name)));
    if (!tables.has("memory")) return { ok: false, reason: "旧库里没有 memory 表，可能不是记忆树库", added: 0, tables: [...tables] };

    const cols = new Set(db.prepare("PRAGMA table_info(memory)").all().map((r) => String(r.name)));
    const rows = db.prepare("SELECT * FROM memory ORDER BY id").all();
    const byLayer = {};
    const skipped = [];
    let added = 0;
    let duplicate = 0;

    const processRows = () => {
    for (const row of rows) {
      const text = String(row.text ?? "").trim();
      if (text === "") {
        skipped.push({ id: Number(row.id), reason: "空文本" });
        continue;
      }
      const c = classify(row);
      const legacyTags = c.tags;
      const uid = "legacy:" + Number(row.id);
      if (store.get(uid)) {
        duplicate += 1;
        continue;
      }
      const subject = String(row.subject ?? "").trim();
      if (dryRun) {
        added += 1;
        byLayer[c.layer] = (byLayer[c.layer] ?? 0) + 1;
        continue;
      }
      const res = store.add({
        uid,
        scope,
        layer: c.layer,
        kind: c.layer === "task" ? "card" : c.layer === "trunk" ? "rule" : "note",
        status: c.status,
        subject,
        title: subject || String(row.summary ?? "").slice(0, 40) || text.slice(0, 40),
        text,
        summary: row.summary ? String(row.summary) : null,
        tags: legacyTags,
        source: "legacy:memories.db#" + Number(row.id),
        evidence: text,
        trust: c.trust,
        importance: c.importance,
        halfLifeDays: cols.has("half_life_days") ? Number(row.half_life_days ?? 0) || 0 : Number(opts.defaultHalfLifeDays ?? 0),
        ts: toMs(row.ts) || undefined,
      });
      if (res.duplicate) duplicate += 1;
      else added += 1;
      byLayer[c.layer] = (byLayer[c.layer] ?? 0) + 1;
    }
    };
    // 非 dryRun 的整批迁移放进一个事务：中途失败不留半批数据。
    if (dryRun) processRows();
    else tx(store.db, processRows);

    // 旧库里的 diary/emotion_log 是日记与旧情绪日志：日记按 §2-4 只是索引，默认不搬。
    const hasDiary = tables.has("diary");
    const otherTables = [...tables].filter((t) => !["memory", "meta"].includes(t));
    if (!dryRun) {
      store.audit("migrate", {
        scope,
        query: legacyFile,
        hits: added,
        detail: { total: rows.length, added, duplicate, skipped: skipped.length, byLayer, dryRun },
      });
    }
    return {
      ok: true,
      dryRun,
      source: legacyFile,
      total: rows.length,
      added,
      duplicate,
      skipped,
      byLayer,
      ignoredTables: otherTables,
      note: hasDiary ? "旧库的 diary 表按「日记只是索引」的规则未搬入；需要时用 memory_admin action=import 手工导入导出文件。" : undefined,
    };
  } catch (err) {
    return { ok: false, reason: "迁移失败：" + (err && err.message ? err.message : String(err)), added: 0 };
  } finally {
    try {
      db.close();
    } catch {
      /* 忽略 */
    }
    if (opened.temp) {
      try {
        fs.rmSync(opened.temp, { force: true });
      } catch {
        /* 忽略 */
      }
    }
  }
}
