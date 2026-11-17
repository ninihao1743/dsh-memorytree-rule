// lib/emotion.mjs — 情感枝自动收录（可选）：本地采集、打分、候选表与日结数据。
//
// 边界（说明见 docs/EMOTION.md）：
// - 默认关闭（emotionCapture:false）；用户显式开启后，采集只在本机 SQLite 里做，不调模型、不联网。
// - 候选只留节选（默认 30 天清掉），不是记忆；真正写进 node 的仍走 memory_write，日结时按第一人称感受门槛筛。
// - 采集失败绝不影响会话：captureEmotionEvent 只返回结果，不向调用方抛错。
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { tx } from "./db.mjs";
import { localDate } from "./diary.mjs";
import { redact, truncate } from "./text.mjs";

export const CAPTURE_TEXT_MAX = 800;
export const CONTEXT_MAX = 240;
export const CAPTURE_MIN_SCORE = 35;
export const DAILY_CANDIDATE_LIMIT = 12;
export const SESSION_CANDIDATE_LIMIT = 6;
export const CANDIDATE_RETENTION_DAYS = 30;
export const CATEGORY_LIMITS = { relationship: 6, plugin: 4, work: 6 };

const EMOTION_WORDS = [
  "想你", "难过", "开心", "高兴", "害怕", "生气", "对不起", "谢谢", "陪我", "离开",
  "永远", "喜欢", "讨厌", "孤独", "累", "心疼", "委屈", "感动", "想哭", "眼泪",
  "温暖", "舍不得", "担心", "焦虑", "失望", "骄傲", "安心", "舍不得", "崩了",
];
const MEMORY_WORDS = ["记得", "第一次", "以前", "那时候", "小时候", "当年", "后来", "曾经", "回忆", "忘不了"];
const PROMISE_WORDS = ["以后", "答应", "别忘了", "说好", "约定", "下次", "一直", "陪着你"];
const WORK_FAIL_WORDS = ["崩了", "报错", "失败", "卡住", "踩坑", "不兼容", "挂了", "修不好", "白忙", "没跑通"];
const WORK_DONE_WORDS = ["搞定", "修好", "通过", "跑通", "成功", "完成", "上线", "恢复", "能用了"];
const WORK_CORRECTION_WORDS = ["被骂", "被说", "被纠正", "不对", "返工", "打回"];
const WORK_PRAISE_WORDS = ["被夸", "很好", "不错", "满意", "可以了"];
const PLUGIN_REFLECTION_WORDS = [
  "我觉得", "有点", "其实", "这条不回", "不回", "已发", "看到", "访客", "挑衅",
  "低俗", "可怜", "可笑", "没必要", "算了", "挑事", "不想接",
];

const NOISE_PREFIX = /^(Current runtime context\.|Time sampled while preparing|<system-reminder>|\[SCHEDULE REMINDER\]|<available_skills>)/i;

function hits(text, words) {
  return words.filter((w) => text.includes(w));
}

function sha1(s) {
  return createHash("sha1").update(String(s)).digest("hex");
}

function round4(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

function tsOf(event, fallback = Date.now()) {
  const raw = event?.ts ?? event?.time;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const n = Date.parse(raw);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function textBlocks(content) {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text);
}

/** 从 session/event 事件里判断角色；拿不到返回空串。 */
export function eventRole(event) {
  const type = String(event?.type ?? "");
  if (type === "user/message" || type.endsWith("/user/message")) return "user";
  if (type === "assistant/message" || type.endsWith("/assistant/message")) return "assistant";
  const d = event?.data;
  if (d?.message?.role === "assistant" || d?.role === "assistant") return "assistant";
  if (d?.role === "user" || d?.source) return "user";
  return "";
}

/** 只取 text 块；去掉运行时上下文、身份提示、代码围栏、纯 JSON/工具输出。 */
export function extractText(event) {
  const role = eventRole(event);
  if (!role) return "";
  const data = event?.data;
  const content = role === "assistant" ? data?.message?.content : data?.content;
  let text = textBlocks(content).join("\n").trim();
  if (!text) return "";
  if (NOISE_PREFIX.test(text)) return "";
  // 代码围栏整段是工具/代码时丢掉；夹在叙述里的围栏只去掉围栏本身。
  if (/^```[\s\S]*```$/.test(text)) return "";
  text = text.replace(/```[\s\S]*?```/g, " ").replace(/[ \t]+\n/g, "\n").trim();
  if (/^\s*[{[]/.test(text)) {
    try {
      JSON.parse(text);
      return "";
    } catch {
      /* 不是纯 JSON，继续 */
    }
  }
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

export function sessionCwd(session) {
  const cwd = session?.header?.cwd ?? session?.cwd ?? "";
  return String(cwd ?? "").trim();
}

/**
 * 外部插件会话的 cwd 子串；默认空数组（不把任何 cwd 当访客）。
 * 用户可在配置里加 emotionPluginCwdPatterns: ["plugins", "chat"] 之类。
 */
export function isPluginCwd(cwd, patterns = []) {
  const p = String(cwd ?? "");
  return (Array.isArray(patterns) ? patterns : []).some((x) => String(x).trim() !== "" && p.includes(String(x)));
}

/**
 * 分类：plugin（配置命中的外部插件会话）、work（干活受挫/完成/被纠正）、relationship（与用户相处）。
 * 外部插件会话优先按 cwd 判定；主会话里 user 消息看 source.kind，助手消息看工作词。
 */
export function classifyEvent(session, event, text = extractText(event), options = {}) {
  const role = eventRole(event);
  if (!role) return null;
  const cwd = sessionCwd(session);
  const patterns = options.pluginCwdPatterns ?? [];
  if (isPluginCwd(cwd, patterns)) return { role, category: "plugin", cwd };
  if (role === "user") {
    const kind = String(event?.data?.source?.kind ?? "");
    // 只有用户亲手发的消息才算相处；调度、看板、工具注入的消息是工作消息，不能冒充访客。
    return { role, category: kind === "user" ? "relationship" : "work", cwd };
  }
  if (hits(text, WORK_FAIL_WORDS).length || hits(text, WORK_DONE_WORDS).length || hits(text, WORK_CORRECTION_WORDS).length) {
    return { role, category: "work", cwd };
  }
  return { role, category: "relationship", cwd };
}

/**
 * 0–100 分。分数只用于「值不值得进候选」，不判断艺术质量；35 分以上才入表。
 * reasons 写清楚加分项，方便日结时回看为什么选中它。
 */
export function scoreCandidate(text, role, category) {
  const t = String(text ?? "");
  let score = 0;
  const reasons = [];
  const add = (n, why) => {
    if (!n) return;
    score += n;
    reasons.push(why + (n > 0 ? "+" : "") + n);
  };

  if (t.length < 8) return { score: 0, reasons: ["太短"] };
  const body = t.length > 4000 ? t.slice(0, 4000) : t;

  if (category === "relationship" || category === "plugin") {
    const emo = hits(body, EMOTION_WORDS);
    if (emo.length) add(Math.min(36, emo.length * 15), "情绪词:" + emo.slice(0, 3).join("/"));
    const mem = hits(body, MEMORY_WORDS);
    if (mem.length) add(Math.min(24, mem.length * 12), "回忆词:" + mem.slice(0, 3).join("/"));
    const prom = hits(body, PROMISE_WORDS);
    if (prom.length) add(Math.min(20, prom.length * 10), "约定词:" + prom.slice(0, 3).join("/"));
  }

  if (category === "work") {
    const fail = hits(body, WORK_FAIL_WORDS);
    const done = hits(body, WORK_DONE_WORDS);
    const corr = hits(body, WORK_CORRECTION_WORDS);
    const praise = hits(body, WORK_PRAISE_WORDS);
    if (fail.length) add(Math.min(36, fail.length * 15), "受挫:" + fail.slice(0, 3).join("/"));
    if (done.length) add(Math.min(24, done.length * 12), "完成:" + done.slice(0, 3).join("/"));
    if (corr.length) add(Math.min(24, corr.length * 12), "被纠正:" + corr.slice(0, 3).join("/"));
    if (praise.length) add(Math.min(18, praise.length * 9), "被夸:" + praise.slice(0, 3).join("/"));
    add(6, "工作消息");
  }

  if (category === "plugin") {
    const refl = hits(body, PLUGIN_REFLECTION_WORDS);
    if (refl.length) add(Math.min(30, refl.length * 10), "插件反思:" + refl.slice(0, 3).join("/"));
    if (role === "assistant") add(10, "助手反应");
    else add(4, "访客消息");
  }

  if (/[我咱]|我们/.test(body)) add(8, "第一人称");
  if (/[?？]|吗|呢/.test(body)) add(5, "问句");
  if (body.length >= 40 && body.length <= 800) add(6, "长度适中");
  if (body.length > 1200) add(-12, "过长");
  if (NOISE_PREFIX.test(body)) add(-60, "系统提示");
  if (/^\s*[{[]/.test(body)) {
    try {
      JSON.parse(body);
      add(-60, "纯JSON");
    } catch {
      /* 不是纯 JSON */
    }
  }
  if (/^https?:\/\/\S+$/.test(body.trim())) add(-30, "纯链接");

  return { score: Math.max(0, Math.min(100, score)), reasons: reasons.length ? reasons : ["无加分项"] };
}

/** 候选脱敏：访客消息的 [昵称 (OpenID)] 变 [访客]，长 hex、邮箱、密钥交给 text.mjs。 */
export function redactForCandidate(text) {
  let t = String(text ?? "");
  t = t.replace(/\[([^\]\n]{0,40})\s*\((?:OpenID|openid)?[:：]?\s*[0-9A-Fa-f]{16,}\)\]/g, "[访客]");
  t = t.replace(/\b[0-9A-Fa-f]{32,}\b/g, "[id]");
  t = t.replace(/(?:OpenID|open_id|openid)\s*[:：=]\s*[0-9A-Za-z_-]{8,}/gi, "OpenID ***");
  t = t.replace(/@[A-Za-z0-9_-]{2,}/g, "@某人");
  return redact(t).text;
}

function contextMap(runtime) {
  if (!(runtime._emotionContext instanceof Map)) runtime._emotionContext = new Map();
  return runtime._emotionContext;
}

function noteContext(runtime, sessionId, role, text) {
  if (!sessionId || !text) return;
  const map = contextMap(runtime);
  const cur = map.get(sessionId) ?? { user: "", assistant: "" };
  cur[role] = truncate(text, 500);
  map.delete(sessionId);
  map.set(sessionId, cur);
  if (map.size > 200) {
    const first = map.keys().next().value;
    if (first !== undefined) map.delete(first);
  }
}

function contextOf(runtime, sessionId, role) {
  const cur = contextMap(runtime).get(sessionId);
  if (!cur) return "";
  return role === "user" ? cur.assistant : cur.user;
}

/**
 * 采集一条消息。runtime 需要 open()（MemoryRuntime）与 config。
 * 返回 {ok:true,id,...} 或 {ok:false,skipped/error}；调用方不该因为它失败而中断会话。
 */
export function captureEmotionEvent(runtime, session, event, opts = {}) {
  const cfg = { ...(runtime?.config ?? {}), ...(opts ?? {}) };
  // 公开版默认关闭；只有显式 emotionCapture:true 才采集。
  if (cfg.emotionCapture !== true) return { ok: false, skipped: "disabled" };

  const role = eventRole(event);
  if (!role) return { ok: false, skipped: "not-message" };
  const text = extractText(event);
  const sessionId = String(session?.header?.id ?? session?.id ?? "");
  if (!text || text.length < 8) {
    noteContext(runtime, sessionId, role, text);
    return { ok: false, skipped: "empty" };
  }

  const cls = classifyEvent(session, event, text, { pluginCwdPatterns: cfg.emotionPluginCwdPatterns });
  if (!cls) return { ok: false, skipped: "no-category" };
  const { score, reasons } = scoreCandidate(text, role, cls.category);
  const minScore = Number(cfg.emotionMinScore ?? CAPTURE_MIN_SCORE);

  // 无论是否入选都记上下文，下一条消息才能带上前一句。
  const prev = contextOf(runtime, sessionId, role);
  noteContext(runtime, sessionId, role, text);

  if (score < minScore) return { ok: false, skipped: "low-score", score, category: cls.category };

  const now = Date.now();
  const ts = tsOf(event, now);
  const day = localDate(ts);
  // 用「天 + 会话 + 角色 + 正文」去重：同一条消息被 event 重复投递时只留一次，
  // 同一天同一句话再发一次也视为重复；隔天再发仍可入候选。
  const dedupe = sha1(sessionId + "|" + role + "|" + day + "|" + text).slice(0, 32);
  const candidateText = truncate(redactForCandidate(text), CAPTURE_TEXT_MAX);
  const contextText = truncate(redactForCandidate(prev), CONTEXT_MAX);

  let store;
  try {
    store = runtime.open();
  } catch (err) {
    return { ok: false, error: err?.message ? String(err.message) : String(err) };
  }

  const sessionLimit = Number(cfg.emotionSessionLimit ?? SESSION_CANDIDATE_LIMIT);
  const dayLimit = Number(cfg.emotionDailyLimit ?? DAILY_CANDIDATE_LIMIT);
  const categoryLimit = Number(cfg.emotionCategoryLimits?.[cls.category] ?? CATEGORY_LIMITS[cls.category] ?? dayLimit);

  try {
    return tx(store.db, () => {
      const countSession = store.db
        .prepare("SELECT COUNT(*) AS n FROM emotion_candidate WHERE day=? AND session_id=?")
        .get(day, sessionId).n;
      if (countSession >= sessionLimit) return { ok: false, skipped: "session-cap", score, category: cls.category };
      const countDay = store.db.prepare("SELECT COUNT(*) AS n FROM emotion_candidate WHERE day=?").get(day).n;
      if (countDay >= dayLimit) return { ok: false, skipped: "day-cap", score, category: cls.category };
      const countCategory = store.db
        .prepare("SELECT COUNT(*) AS n FROM emotion_candidate WHERE day=? AND category=?")
        .get(day, cls.category).n;
      if (countCategory >= categoryLimit) return { ok: false, skipped: "category-cap", score, category: cls.category };

      const info = store.db
        .prepare(
          `INSERT OR IGNORE INTO emotion_candidate
            (day, ts, session_id, cwd, role, category, score, reasons, text, context, dedupe, status, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`,
        )
        .run(
          day, ts, sessionId, cls.cwd, role, cls.category, score, JSON.stringify(reasons),
          candidateText, contextText, dedupe, now, now,
        );
      if (info.changes === 0) return { ok: false, skipped: "duplicate", score, category: cls.category };

      // 顺手清掉过期候选；表很小，按 created_at 删不会影响索引。
      store.db
        .prepare("DELETE FROM emotion_candidate WHERE created_at < ?")
        .run(now - (Number(cfg.emotionRetentionDays) || CANDIDATE_RETENTION_DAYS) * 24 * 60 * 60 * 1000);

      return { ok: true, id: Number(info.lastInsertRowid), score, category: cls.category, day };
    });
  } catch (err) {
    return { ok: false, error: err?.message ? String(err.message) : String(err) };
  }
}

function candidateRow(r) {
  let reasons = [];
  try {
    reasons = JSON.parse(String(r.reasons ?? "[]"));
  } catch {
    reasons = [];
  }
  return {
    id: Number(r.id),
    day: String(r.day ?? ""),
    ts: Number(r.ts ?? 0),
    sessionId: String(r.session_id ?? ""),
    cwd: String(r.cwd ?? ""),
    role: String(r.role ?? ""),
    category: String(r.category ?? ""),
    score: Number(r.score ?? 0),
    reasons,
    text: String(r.text ?? ""),
    context: String(r.context ?? ""),
    status: String(r.status ?? "pending"),
    nodeId: r.node_id === null || r.node_id === undefined ? null : Number(r.node_id),
  };
}

export function listCandidates(db, { day, status = "pending", limit = 20 } = {}) {
  const d = String(day || localDate());
  const s = String(status || "pending");
  const lim = Math.max(1, Math.min(50, Number(limit) || 20));
  const rows = db
    .prepare(
      `SELECT * FROM emotion_candidate
       WHERE day=? AND (?='all' OR status=?)
       ORDER BY score DESC, id ASC LIMIT ?`,
    )
    .all(d, s, s, lim);
  return rows.map(candidateRow);
}

export function markCandidates(db, ids, status, nodeIds = []) {
  const want = String(status);
  if (want !== "accepted" && want !== "dismissed") {
    throw new Error("status 只能是 accepted / dismissed");
  }
  const list = (Array.isArray(ids) ? ids : []).map((x) => Number(x)).filter((x) => Number.isFinite(x));
  if (list.length === 0) return { updated: 0, missing: [], status: want };
  const nodeList = (Array.isArray(nodeIds) ? nodeIds : []).map((x) => Number(x));
  return tx(db, () => {
    let updated = 0;
    const missing = [];
    const stmt = db.prepare("UPDATE emotion_candidate SET status=?, node_id=?, updated_at=? WHERE id=?");
    list.forEach((id, i) => {
      const nodeId = want === "accepted" && Number.isFinite(nodeList[i]) ? nodeList[i] : null;
      const info = stmt.run(want, nodeId, Date.now(), id);
      if (info.changes) updated += 1;
      else missing.push(id);
    });
    return { updated, missing, status: want };
  });
}

export function candidateStats(db, day = localDate()) {
  const d = String(day || localDate());
  const rows = db
    .prepare("SELECT category, status, COUNT(*) AS n FROM emotion_candidate WHERE day=? GROUP BY category, status")
    .all(d);
  const byCategory = {};
  const byStatus = {};
  let total = 0;
  for (const r of rows) {
    const n = Number(r.n) || 0;
    total += n;
    byCategory[r.category] = (byCategory[r.category] || 0) + n;
    byStatus[r.status] = (byStatus[r.status] || 0) + n;
  }
  const weekStart = localDate(Date.now() - 6 * 24 * 60 * 60 * 1000);
  const week = db
    .prepare("SELECT COUNT(*) AS n FROM emotion_candidate WHERE day>=?")
    .get(weekStart).n;
  return { day: d, total, byCategory, byStatus, weekStart, week: Number(week) || 0 };
}

export function sessionIdOf(exec) {
  try {
    return String(exec?.agent?.session?.id ?? exec?.agent?.id ?? "");
  } catch {
    return "";
  }
}

/** 读 cost-meter 账本：今日总花费、本会话花费、今日日结累计、上限、是否超。 */
export function budgetFor(runtime, exec = {}) {
  const day = localDate();
  const cap = Number(runtime?.config?.emotionReviewCostCapCny ?? 0.3);
  const file = path.join(String(runtime?.paths?.home ?? ""), "storages", "cost-meter", "ledger.json");
  let ledger = null;
  try {
    ledger = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    ledger = null;
  }
  const sid = sessionIdOf(exec);
  let todayTotal = 0;
  let sessionCost = 0;
  const dayRow = ledger?.days?.[day];
  if (dayRow) {
    todayTotal = Number(dayRow.costCny) || 0;
    for (const s of Array.isArray(dayRow.sessions) ? dayRow.sessions : []) {
      if (sid && String(s?.id ?? "") === sid) sessionCost += Number(s?.costCny) || 0;
    }
  }
  let reviewSpent = 0;
  try {
    reviewSpent = Number(
      runtime.open().db.prepare("SELECT COALESCE(SUM(cost_cny),0) AS n FROM emotion_review WHERE day=?").get(day).n,
    ) || 0;
  } catch {
    reviewSpent = 0;
  }
  return {
    ok: true,
    day,
    capCny: cap,
    todayTotalCny: round4(todayTotal),
    sessionCostCny: round4(sessionCost),
    reviewSpentCny: round4(reviewSpent),
    over: sessionCost + reviewSpent > cap + 1e-9,
    ledger: Boolean(ledger),
  };
}

export function recordReview(db, input = {}) {
  const day = String(input.day || localDate());
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO emotion_review
        (day, session_id, candidates, written, dismissed, cost_cny, tokens, status, note, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      day,
      String(input.sessionId ?? ""),
      Number(input.candidates) || 0,
      Number(input.written) || 0,
      Number(input.dismissed) || 0,
      Number(input.costCny) || 0,
      Number(input.tokens) || 0,
      String(input.status ?? "done"),
      String(input.note ?? ""),
      now,
    );
  return { id: Number(info.lastInsertRowid), day };
}
