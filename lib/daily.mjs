// lib/daily.mjs — 每日分拣的报告与「一次性提交决定」。
//
// 分工（有意为之）：插件不调 LLM、不存任何 key；报告只做事实汇总与聚类建议，
// 真正的「分到哪里」由宿主模型读报告后决定，再调 memory_daily action=apply 或 memory_write/forget。
import { truncate } from "./text.mjs";

const STALE_DAYS = 30;

export function buildDailyReport(store, opts = {}) {
  const now = store.now();
  const hours = Math.max(1, Number(opts.hours ?? 24));
  const since = now - hours * 3600 * 1000;
  const scopes = opts.scopes ?? ["user"];
  const limit = Math.max(1, Number(opts.limit ?? 30));

  const leafTotal = store.count({ scope: scopes, layers: ["leaf"], status: "active" });
  const recentTotal = store.count({ scope: scopes, layers: ["leaf"], status: "active", since });
  const allLeaves = store.list({ scope: scopes, layers: ["leaf"], status: "active", since, limit: 2000, order: "created" });
  const pending = allLeaves;
  const items = pending.slice(0, limit).map((n) => ({
    id: n.id,
    uid: n.uid,
    text: truncate(n.text.replace(/\s+/g, " "), 400),
    tags: n.tags,
    subject: n.subject,
    scope: n.scope,
    updatedAt: n.updatedAt,
    ageHours: Math.round((now - n.updatedAt) / 3600000),
    source: n.source,
  }));

  // 聚类：同 subject 的直接一组；没 subject 的按「共享 tag」分组；都没有就单独。
  const groups = new Map();
  for (const n of pending) {
    const keys = [];
    if (n.subject) keys.push("subject:" + n.subject);
    for (const t of n.tags) if (t !== "已脱敏") keys.push("tag:" + t);
    if (keys.length === 0) keys.push("solo:" + n.id);
    for (const k of keys) {
      if (!groups.has(k)) groups.set(k, new Set());
      groups.get(k).add(n.id);
    }
  }
  const clusters = [...groups.entries()]
    .filter(([, ids]) => ids.size >= 2)
    .map(([key, ids]) => ({ key, ids: [...ids].sort((a, b) => a - b) }))
    .sort((a, b) => b.ids.length - a.ids.length)
    .slice(0, 8);

  const staleBefore = now - STALE_DAYS * 86400 * 1000;
  const staleCards = store
    .list({ scope: scopes, layers: ["task"], status: "active", limit: 5000, order: "updated" })
    .filter((n) => n.updatedAt < staleBefore)
    .slice(0, 10)
    .map((n) => ({ id: n.id, subject: n.subject, title: n.title, updatedAt: n.updatedAt, days: Math.round((now - n.updatedAt) / 86400000) }));

  const expired = store
    .list({ scope: scopes, status: "active", limit: 5000, order: "updated" })
    .filter((n) => n.validUntil !== null && n.validUntil < now)
    .slice(0, 10)
    .map((n) => ({ id: n.id, layer: n.layer, title: n.title || truncate(n.text, 60), validUntil: n.validUntil }));

  const candidates = store.list({ scope: scopes, layers: ["trunk"], status: "candidate", limit: 20, order: "created" })
    .map((n) => ({ id: n.id, title: n.title || truncate(n.text, 60), createdAt: n.createdAt, source: n.source }));

  return {
    generatedAt: now,
    scope: scopes,
    scopes,
    hours,
    pendingCount: recentTotal,
    pendingTruncated: Math.max(0, recentTotal - pending.length),
    pendingOlderThanWindow: Math.max(0, leafTotal - recentTotal),
    items,
    clusters,
    staleCards,
    staleDays: STALE_DAYS,
    expired,
    candidates,
    stats: store.stats(scopes),
  };
}

/**
 * decisions: [{id, to:'trunk'|'emotion'|'task'|'leaf'|'forget', subject?, title?, text?, importance?, halfLifeDays?, tags?}]
 */
export function applyDailyDecisions(store, decisions, opts = {}) {
  const scopes = opts.scopes ?? ["user"];
  const results = [];
  let candidates = 0;
  for (const d of decisions) {
    const id = d && d.id !== undefined ? Number(d.id) : NaN;
    if (!Number.isFinite(id)) {
      results.push({ id: d?.id ?? null, ok: false, error: "缺少有效 id" });
      continue;
    }
    const node = store.get(id, { scope: scopes });
    if (!node) {
      results.push({ id, ok: false, error: "找不到这条记忆，或它不在当前作用域" });
      continue;
    }
    const to = String(d.to ?? "");
    try {
      if (to === "forget" || to === "archive") {
        store.forget(id, { reason: d.reason ?? "daily triage" });
        results.push({ id, ok: true, to: "forget" });
        continue;
      }
      if (!["trunk", "emotion", "task", "leaf"].includes(to)) {
        results.push({ id, ok: false, error: "to 只能是 trunk/emotion/task/leaf/forget" });
        continue;
      }
      if (to === "leaf") {
        results.push({ id, ok: true, to: "leaf", note: "保留在判断叶，未做转移" });
        continue;
      }
      const tags = Array.from(new Set([...(node.tags ?? []), ...(Array.isArray(d.tags) ? d.tags : []), "已分拣"]));
      const input = {
        layer: to,
        scope: to === "emotion" || to === "trunk" ? "user" : node.scope,
        text: d.text ? String(d.text) : node.text,
        subject: d.subject !== undefined ? String(d.subject) : node.subject,
        title: d.title !== undefined ? String(d.title) : node.title,
        tags,
        source: "triage",
        evidence: node.evidence,
        importance: d.importance !== undefined ? d.importance : undefined,
        halfLifeDays: d.halfLifeDays !== undefined ? d.halfLifeDays : node.halfLifeDays,
      };
      // 分拣允许把工作区判断叶提升到 user 主干候选，跨作用域是这里的正常动作。
      const res = store.supersede([id], { ...input, status: "active" }, { allowCrossScope: true });
      if (res.node.status === "candidate") candidates += 1;
      results.push({ id, ok: true, to, newId: res.node.id, newStatus: res.node.status });
    } catch (err) {
      results.push({ id, ok: false, error: err && err.message ? err.message : String(err) });
    }
  }
  store.audit("daily:apply", { hits: results.filter((r) => r.ok).length, detail: { total: decisions.length, candidates } });
  return { results, candidates, applied: results.filter((r) => r.ok).length };
}
