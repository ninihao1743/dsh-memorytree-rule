// lib/diary.mjs — 日记索引：每天一条，记「今天做了什么、路径」。
//
// 边界（对齐 AGENTS §2-4）：
// - 日记只是索引，不是情感本体；相处情感仍写在 emotion 枝。
// - 自动模式只从库内既有事实（revision / audit）拼装，不调 LLM、不抓会话正文、不联网。
// - 同一天重复 auto 会整体重算覆盖；手写（mood=manual）默认不被自动覆盖。

const ACTION_LABELS = {
  add: "新增",
  update: "更新",
  supersede: "取代",
  "replace-card": "取代",
  "forget:archive": "归档",
  "forget:hard": "删除",
  diary: "日记",
};

const LAYER_LABELS = {
  trunk: "§1 主干",
  emotion: "§2 情感枝",
  task: "§3 任务枝",
  leaf: "§4 判断叶",
};

export function localDate(ms = Date.now()) {
  const d = new Date(Number(ms) || Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function isDateString(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ""));
}

/** 本地时区的一天 [start, end)，毫秒。 */
export function dayRange(date) {
  if (!isDateString(date)) throw new Error("日期格式应为 YYYY-MM-DD：" + String(date));
  const [y, m, d] = String(date).split("-").map((x) => Number(x));
  const start = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0).getTime();
  return { start, end };
}

function itemLabel(row) {
  const name = row.title || row.subject || row.uid || (row.node_id ? "#" + row.node_id : "未命名");
  const layer = LAYER_LABELS[row.layer] ? "（" + LAYER_LABELS[row.layer] + "）" : "";
  return String(name).replace(/\s+/g, " ").slice(0, 90) + layer;
}

/**
 * 拼装一天的日记索引正文。
 * revisions: [{action, ts, node_id, uid, title, subject, layer}]
 * searches:  [{query, hits}]
 */
export function buildDiaryText({ date, revisions = [], searches = [], dbFile = "", agentsPath = "" }) {
  const groups = new Map();
  for (const r of revisions) {
    const action = String(r.action ?? "");
    if (action === "diary") continue; // 日记自己的版本记录不进正文
    const label = ACTION_LABELS[action] ?? action;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(r);
  }

  const lines = [`${date} 记忆树日记（索引）`];
  if (groups.size === 0) {
    lines.push("记忆树今天没有增删改。");
  } else {
    for (const [label, rows] of groups) {
      const names = rows.slice(0, 6).map(itemLabel).join("；");
      const more = rows.length > 6 ? `；等 ${rows.length} 条` : "";
      lines.push(`${label} ${rows.length} 条：${names}${more}`);
    }
    const subjects = [...new Set(revisions.filter((r) => r.layer === "task" && (r.subject || r.title)).map((r) => r.subject || r.title))];
    if (subjects.length) lines.push(`涉及任务卡：${subjects.slice(0, 10).join("、")}${subjects.length > 10 ? " 等" : ""}`);
  }

  const queries = (searches ?? []).filter((s) => s && s.query);
  if (queries.length) {
    const qs = queries.slice(0, 6).map((s) => `「${String(s.query).slice(0, 40)}」${s.hits === null || s.hits === undefined ? "" : "→" + s.hits + " 条"}`);
    lines.push(`今天查过：${qs.join("；")}`);
  }

  const paths = [];
  if (dbFile) paths.push(`库 ${dbFile}`);
  if (agentsPath) paths.push(`主干 ${agentsPath}`);
  if (paths.length) lines.push(paths.join("；"));
  lines.push("（自动索引：只记库内事实，不含会话正文与情感叙事）");
  return lines.join("\n");
}
