// lib/report.mjs — 生成自包含 HTML 看板（无外部资源、可离线打开/打印）。
//
// 视觉版 v2：星图 + 主题包 + 检索过滤 + 详情抽屉。
// 数据仍只来自本机 memory.db；不联网、不调 LLM、不读取会话正文。
import fs from "node:fs";
import { truncate, estimateTokens } from "./text.mjs";
import { trunkGroups as readTrunkGroups } from "./board.mjs";
import { parseAgentSections } from "./rules.mjs";

// 看板字号整体上调（主人：所有文字在原基础上加大 5 个字号）。
// 只处理显式 px 字号与 font 简写，clamp()/inherit 等保持原样；0 字号（隐藏元素）不动。
const FONT_BOOST = 5;
function boostFontSizes(html, delta = FONT_BOOST) {
  if (!delta) return html;
  const add = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n === 0) return value;
    return String(Math.round((n + delta) * 10) / 10);
  };
  const boost = (css) =>
    css
      .replace(/font-size:\s*([\d.]+)px/g, (m, v) => `font-size:${add(v)}px`)
      .replace(/font:\s*([\d.]+)px/g, (m, v) => `font:${add(v)}px`);
  // 只改 <style> 与 style="" 属性，避免把记忆正文里恰好出现的 "font-size:12px" 一起改掉。
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (block) => boost(block))
    .replace(/style="[^"]*"/gi, (attr) => boost(attr));
}

const LAYER_ORDER = ["trunk", "emotion", "task", "leaf"];
const LAYER_LABEL = { trunk: "主干", emotion: "情感枝", task: "任务枝", leaf: "判断叶" };
const LAYER_DESC = {
  trunk: "AGENTS.md §1 规则的检索副本，正本仍是文件",
  emotion: "相处、关系与感受",
  task: "插件 / 脚本 / 常驻服务的做法卡",
  leaf: "还没分类的观察，等分拣",
};
const LAYER_CLASS = { trunk: "trunk", emotion: "emotion", task: "task", leaf: "leaf" };
const ACTION_LABEL = {
  add: "新增",
  update: "更新",
  supersede: "取代",
  "replace-card": "换卡",
  "forget:archive": "归档",
  "forget:hard": "删除",
  sync: "同步",
  diary: "日记",
  reindex: "重建索引",
  import: "导入",
};
const AUDIT_LABEL = { search: "检索", ingest: "同步 / 迁移", report: "看板", write: "写入", forget: "遗忘", admin: "管理", diary: "日记" };

const CLUSTERS = {
  trunk: { cx: 600, cy: 300, r: 168, labelY: 92 },
  emotion: { cx: 268, cy: 505, r: 88, labelY: 618 },
  task: { cx: 932, cy: 505, r: 88, labelY: 618 },
  leaf: { cx: 382, cy: 126, r: 66, labelY: 38 },
};

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function dt(ms) {
  if (!ms) return "—";
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("zh-CN", { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function rel(ms, now) {
  if (!ms) return "—";
  const diff = Math.max(0, Number(now) - Number(ms));
  if (diff < 60e3) return "刚刚";
  if (diff < 3600e3) return Math.round(diff / 60e3) + " 分钟前";
  if (diff < 86400e3) return Math.round(diff / 3600e3) + " 小时前";
  if (diff < 30 * 86400e3) return Math.round(diff / 86400e3) + " 天前";
  const d = new Date(Number(ms));
  return d.toLocaleDateString("zh-CN");
}

function pct(n, total) {
  return total > 0 ? Math.round((n / total) * 100) : 0;
}

function seeded(uid, salt) {
  let h = 2166136261;
  const s = String(uid ?? "") + ":" + String(salt ?? "");
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

function starLayout(items, meta) {
  const sorted = [...items].sort((a, b) => a.id - b.id);
  const total = sorted.length || 1;
  return sorted.map((it, i) => {
    const angle = seeded(it.uid, 1) * Math.PI * 2 + i * 2.39996;
    const radius = meta.r * Math.sqrt((i + 0.75) / total);
    return {
      it,
      x: meta.cx + Math.cos(angle) * radius * 1.18,
      y: meta.cy + Math.sin(angle) * radius * 0.86,
      rank: i,
    };
  });
}

function starSvg(layer, items, now) {
  const meta = CLUSTERS[layer];
  if (!items.length) {
    const rr = Math.max(24, Math.round(meta.r * 0.34));
    return '<g class="cluster cluster-' + layer + '" data-layer="' + layer + '">' +
      '<ellipse class="cluster-aura" cx="' + meta.cx + '" cy="' + meta.cy + '" rx="' + rr + '" ry="' + Math.round(rr * 0.72) + '"></ellipse>' +
      '<text class="cluster-label" x="' + meta.cx + '" y="' + meta.labelY + '">' + LAYER_LABEL[layer] + ' <tspan>0</tspan></text>' +
      '<text class="cluster-empty" x="' + meta.cx + '" y="' + (meta.cy + 4) + '">—</text></g>';
  }

  const pts = starLayout(items, meta);
  const lines = [];
  const sortedByAngle = [...pts].sort((a, b) => Math.atan2(a.y - meta.cy, a.x - meta.cx) - Math.atan2(b.y - meta.cy, b.x - meta.cx));
  for (let i = 0; i < sortedByAngle.length - 1; i += 1) {
    const a = sortedByAngle[i];
    const b = sortedByAngle[i + 1];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (d < 105) {
      lines.push('<line x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) + '"></line>');
    }
  }

  const stars = pts.map((p) => {
    const r = 4.8;
    return '<g class="star" data-node="' + p.it.id + '" data-layer="' + layer + '" tabindex="0" role="button" aria-label="' + esc(p.it.title || p.it.subject || "记忆条目") + '">' +
      '<title>' + esc(p.it.title || p.it.subject || "") + " · " + LAYER_LABEL[layer] + '</title>' +
      '<circle class="halo" cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="' + (r * 3.1).toFixed(1) + '"></circle>' +
      '<circle class="ring" cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="' + (r + 2.2).toFixed(1) + '"></circle>' +
      '<circle class="core" cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="' + r.toFixed(1) + '"></circle>' +
      "</g>";
  }).join("");

  return '<g class="cluster cluster-' + layer + '" data-layer="' + layer + '">' +
    '<ellipse class="cluster-aura" cx="' + meta.cx + '" cy="' + meta.cy + '" rx="' + (meta.r * 1.34) + '" ry="' + (meta.r * 0.98) + '"></ellipse>' +
    '<g class="constellation">' + lines.join("") + "</g>" +
    stars +
    '<text class="cluster-label" x="' + meta.cx + '" y="' + meta.labelY + '">' + LAYER_LABEL[layer] + ' <tspan>' + items.length + "</tspan></text></g>";
}

function decoStars(now) {
  const out = [];
  for (let i = 0; i < 90; i += 1) {
    const x = seeded("deco-x", i) * 1200;
    const y = seeded("deco-y", i) * 640;
    const r = 0.5 + seeded("deco-r", i) * 1.3;
    const o = 0.10 + seeded("deco-o", i) * 0.30;
    out.push('<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + r.toFixed(1) + '" opacity="' + o.toFixed(2) + '"></circle>');
  }
  return out.join("");
}

function donutStyle(counts, total) {
  if (!total) return "conic-gradient(var(--line) 0 360deg)";
  let acc = 0;
  const parts = [];
  for (const l of LAYER_ORDER) {
    const n = counts[l] || 0;
    if (!n) continue;
    const start = (acc / total) * 360;
    acc += n;
    const end = (acc / total) * 360;
    parts.push("var(--c-" + l + ") " + start.toFixed(2) + "deg " + end.toFixed(2) + "deg");
  }
  return "conic-gradient(" + parts.join(",") + ")";
}

function statCard(label, value, hint) {
  return '<div class="stat"><div class="stat-label">' + esc(label) + '</div><div class="stat-value">' + esc(value) + '</div>' +
    (hint ? '<div class="stat-hint">' + esc(hint) + "</div>" : "") + "</div>";
}

function statCard2(label, value, bottom, layer) {
  return '<div class="stat"><div class="stat-label">' + esc(label) + '</div><div class="stat-value">' + esc(value) + '</div>' +
    '<div class="stat-bottom" style="color:var(--c-' + layer + ')">' + esc(bottom) + "</div></div>";
}

function miniBar(value, max, cls) {
  const w = max > 0 ? Math.max(3, Math.round((value / max) * 100)) : 0;
  return '<span class="mini-track"><i class="mini-fill ' + cls + '" style="width:' + w + '%"></i></span>';
}

export function buildReportHtml(rt, store, exec, opts = {}) {
  const scopes = store.allScopes ? store.allScopes() : rt.scopesFor(exec, "all").scopes;
  const board = opts && typeof opts.board === "object" && opts.board ? opts.board : {};
  let trunkGroupList = [];
  let rawAgents = "";
  try {
    rawAgents = fs.readFileSync(rt.paths.agentsPath, "utf8");
    trunkGroupList = readTrunkGroups(rawAgents).map((g) => ({ key: g.key, title: g.title }));
  } catch {}
  const agentSections = parseAgentSections(rawAgents);
  const TRUNK_BUCKETS = ["DSH本体规则", "本机环境事实", "其他规则"];
  const trunkBucketOf = (it) => {
    const m = String(it.uid || "").match(/§1-(\d+)-(\d+)/);
    if (!m) return "其他规则";
    const group = Number(m[1]);
    const groupTitle = (trunkGroupList.find((g) => String(g.key || "") === "§1-" + group) || {}).title || "";
    if (/环境/.test(groupTitle)) return "本机环境事实";
    return "DSH本体规则";
  };
  let trunkBucketOverrides = {};
  try {
    if (typeof store.trunkBuckets === "function") trunkBucketOverrides = store.trunkBuckets();
  } catch {
    trunkBucketOverrides = {};
  }
  const trunkBucketName = (it) => String(trunkBucketOverrides[it.uid] || "").trim() || trunkBucketOf(it);
  const trunkHeadings = TRUNK_BUCKETS.slice();
  for (const name of Object.values(trunkBucketOverrides)) {
    const b = String(name || "").trim();
    if (b && !trunkHeadings.includes(b)) trunkHeadings.push(b);
  }
  const boardJson = JSON.stringify({
    base: String(board.base || "").replace(/\/+$/, ""),
    token: String(board.token || ""),
    sessionId: board.sessionId ? String(board.sessionId) : null,
    groups: trunkGroupList,
    buckets: trunkHeadings,
  }).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const stats = store.stats();
  const tree = store.tree({ scopes });
  const audits = store.recentAudit(12);
  const revisions = store.recentRevisions(10);
  const info = rt.info();
  const now = store.now();
  const aliases = store.scopeAliases();
  const home = (rt.paths && rt.paths.home) || "";
  const shortPath = (p) => {
    let s = String(p || "");
    if (home && s.toLowerCase().startsWith(String(home).toLowerCase())) s = "~" + s.slice(String(home).length);
    return s;
  };
  const scopeLabel = (s) => {
    const v = String(s || "");
    if (v === "user") return "本机通用";
    if (v.startsWith("workspace:")) return "当前工作区";
    return v || "—";
  };

  const activeItems = {};
  for (const l of tree.layers) activeItems[l.layer] = l.items || [];
  const activeCounts = {};
  for (const l of LAYER_ORDER) activeCounts[l] = (activeItems[l] || []).length;
  const totalActive = LAYER_ORDER.reduce((sum, l) => sum + activeCounts[l], 0);
  // 首次安装时给一条能照做的路径，避免打开看板只看到空壳。
  const firstRunHtml = totalActive === 0
    ? '<section class="panel first-run"><h2 style="font-size:17px;margin:0 0 8px">第一次打开？</h2>' +
      '<p style="margin:0 0 8px">库里还没有正式条目。还没有 <code>&lt;DSH_HOME&gt;/AGENTS.md</code> 时，在插件目录运行 <code>node bin/mt.mjs init</code> 从模板创建；已有正本时只合并模板的 §1 段落，不要整体覆盖。创建后在插件目录运行 <code>node bin/mt.mjs sync --force</code>；' +
      '想看四枝长什么样，运行 <code>node bin/mt.mjs demo</code>——它会建一个隔离示例库，不碰真实记忆。</p>' +
      '<p class="empty" style="margin:0">模板和示例都在插件的 <code>examples/</code> 目录里。</p></section>'
    : "";

  const nodes = {};
  for (const l of LAYER_ORDER) {
    for (const it of activeItems[l] || []) {
      const full = store.get(it.id);
      nodes[it.id] = {
        id: it.id,
        uid: it.uid,
        title: it.title || it.subject || "",
        layer: l,
        subject: it.subject || "",
        scope: it.scope || "",
        trust: Number(it.trust) || 0,
        updatedAt: it.updatedAt || 0,
        preview: it.preview || "",
        text: (full && full.text) || it.preview || "",
        tags: it.tags || [],
        status: "active",
        bucket: l === "trunk" ? trunkBucketName(it) : "",
        bucketOverride: l === "trunk" ? String(trunkBucketOverrides[it.uid] || "") : "",
      };
    }
  }
  for (const c of tree.candidates) {
    const full = store.get(c.id);
    nodes[c.id] = {
      id: c.id,
      uid: c.uid,
      title: c.title || "候选",
      layer: "trunk",
      subject: c.subject || "",
      scope: c.scope || "",
      trust: Number(c.trust) || 0,
      updatedAt: c.updatedAt || 0,
      preview: c.preview || c.text || "",
      text: (full && full.text) || c.text || "",
      tags: [],
      status: "candidate",
    };
  }
  for (const sec of agentSections) {
    for (const r of sec.rules) {
      const id = "agent:" + r.num;
      nodes[id] = {
        id,
        uid: r.num,
        title: r.title,
        layer: "agent",
        section: sec.key,
        sectionTitle: sec.title,
        scope: "AGENTS.md",
        trust: 0,
        updatedAt: 0,
        preview: truncate(r.text, 180),
        text: r.text,
        tags: [],
        status: "active",
        virtual: true,
      };
    }
  }
  const nodeJson = JSON.stringify(nodes)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

  const uidTitle = new Map();
  const displayTitle = (it) => {
    const t = String(it.title || "").trim();
    if (t && t !== "self") return t;
    return it.subject || it.preview || it.text || t || "";
  };
  for (const l of LAYER_ORDER) {
    for (const it of activeItems[l] || []) uidTitle.set(it.uid, displayTitle(it));
  }
  for (const c of tree.candidates) uidTitle.set(c.uid, displayTitle(c));
  for (const r of revisions) {
    if (!r.uid || uidTitle.has(r.uid)) continue;
    try {
      const n = store.get(r.uid);
      if (n) uidTitle.set(r.uid, displayTitle(n));
    } catch {
      // 旧 uid 可能来自已删除节点；保持空标题，退化为 uid 展示。
    }
  }

  const chips = [
    statCard("总条目", stats.total, "含候选、归档与取代"),
    statCard2("候选规则", stats.candidates, "主干", "trunk"),
    statCard2("经历", activeCounts.emotion, "情感枝", "emotion"),
    statCard2("插件\\工具\\脚本卡", stats.taskCards, "任务枝", "task"),
    statCard2("待分拣规则", stats.pendingLeaves, "判断叶", "leaf"),
  ].join("");

  const branchIntro = [
    ["trunk", "主干", "执行意识——每轮都要遵守的判断和底线，比如安全规则、沟通方式和做事原则。"],
    ["emotion", "情感枝", "相处经历——相处中发生的事、关系的变化和真实的感受。"],
    ["task", "任务枝", "执行能力——插件、工具、脚本、常驻服务的做法卡，需要时照着做。"],
    ["leaf", "判断叶", "规则审查——还没归类、等待判断的观察和线索。"],
  ].map(([l, name, text]) => '<div class="branch-row"><span class="branch-name" style="color:var(--c-' + l + ')">' + name + '</span><span class="branch-desc">' + text + "</span></div>").join("");

  const layersLegend = LAYER_ORDER.map((l) => {
    return '<button class="legend-item" data-filter-layer="' + l + '" type="button">' +
      '<i class="dot" style="background:var(--c-' + l + ')"></i><span>' + LAYER_LABEL[l] + '</span><b>' + activeCounts[l] + "</b></button>";
  }).join("");

  const sky = '<svg id="sky" viewBox="0 0 1200 640" preserveAspectRatio="xMidYMid slice" role="img" aria-label="记忆树星图">' +
    '<defs><filter id="glow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="3.2" result="b"></feGaussianBlur><feMerge><feMergeNode in="b"></feMergeNode><feMergeNode in="SourceGraphic"></feMergeNode></feMerge></filter></defs>' +
    '<rect class="sky-bg" x="0" y="0" width="1200" height="640"></rect>' +
    '<g class="grid-lines">' +
    Array.from({ length: 14 }, (_, i) => '<line x1="0" y1="' + (i * 48) + '" x2="1200" y2="' + (i * 48) + '"></line>').join("") +
    Array.from({ length: 24 }, (_, i) => '<line x1="' + (i * 52) + '" y1="0" x2="' + (i * 52) + '" y2="640"></line>').join("") +
    "</g>" +
    '<g class="deco-stars">' + decoStars(now) + "</g>" +
    LAYER_ORDER.map((l) => starSvg(l, activeItems[l] || [], now)).join("") +
    "</svg>";

  const donut = '<div class="donut-wrap"><div class="donut" style="background:' + donutStyle(activeCounts, totalActive) + '"></div>' +
    '<div class="donut-hole"><b>' + totalActive + '</b><span>正式</span></div></div>';

  const layerRows = LAYER_ORDER.map((l) => {
    return '<div class="layer-row"><div class="layer-name"><i class="dot" style="background:var(--c-' + l + ')"></i>' + LAYER_LABEL[l] + '</div>' +
      miniBar(activeCounts[l], Math.max(1, ...Object.values(activeCounts)), "bg-" + l) +
      '<div class="layer-count">' + activeCounts[l] + "</div><div class=\"layer-pct\">" + pct(activeCounts[l], totalActive) + "%</div></div>";
  }).join("");

  const maxCount = Math.max(1, ...Object.values(activeCounts));
  const bars = LAYER_ORDER.map((l) => {
    const n = activeCounts[l];
    return '<div class="bar-row"><div class="bar-label">' + LAYER_LABEL[l] + '</div><div class="bar-track"><div class="bar-fill l-' + l + '" style="width:' + Math.round((n / maxCount) * 100) + '%"></div></div><div class="bar-num">' + n + "</div></div>";
  }).join("");

  const scopeText = Object.entries(stats.byScope || {})
    .map(([s, n]) => '<div class="scope-line"><code>' + esc(scopeLabel(s)) + "</code><span>" + n + " 条" + (aliases[s] ? " · " + esc(aliases[s]) : "") + "</span></div>")
    .join("");

  const trunkGroups = new Map(trunkHeadings.map((name) => [name, []]));
  for (const it of activeItems.trunk || []) {
    const name = trunkBucketName(it);
    if (!trunkGroups.has(name)) {
      trunkHeadings.push(name);
      trunkGroups.set(name, []);
    }
    trunkGroups.get(name).push(it);
  }
  const trunkHtml = trunkHeadings.map((g) => {
    const items = trunkGroups.get(g) || [];
    if (!items.length) return "";
    const sortedItems = items.slice().sort((a, b) => {
      const ma = String(a.uid || "").match(/§1-(\d+)-(\d+)/);
      const mb = String(b.uid || "").match(/§1-(\d+)-(\d+)/);
      if (ma && mb) return Number(ma[1]) - Number(mb[1]) || Number(ma[2]) - Number(mb[2]);
      if (ma) return -1;
      if (mb) return 1;
      return 0;
    });
    return '<details class="rule-group" open><summary><span class="grp">' + esc(g) + '</span><em>' + sortedItems.length + ' 条</em><i class="chev"></i></summary><ul>' +
      sortedItems.map((it) => {
        const rid = String(it.uid || "").replace(/^trunk:/, "");
        return '<li class="searchable" data-node="' + it.id + '" tabindex="0"><span class="rid">' + esc(rid) + "</span><span>" + esc(it.title || it.preview) + "</span></li>";
      }).join("") + "</ul></details>";
  }).join("");

  const agentSectionsHtml = agentSections.length
    ? agentSections.map((sec) => {
      return '<details class="rule-group" open><summary><span class="grp">' + esc(sec.key + " " + sec.title) + '</span><em>' + sec.rules.length + ' 条</em><i class="chev"></i></summary><div class="rule-items">' +
        sec.rules.map((r) => '<div class="rule-item searchable" data-node="agent:' + esc(r.num) + '" tabindex="0" role="button"><span class="rid">' + esc(r.num) + '</span><span>' + esc(r.title) + '</span></div>').join("") +
        "</div></details>";
    }).join("")
    : '<p class="empty">AGENTS.md 里没有 §2–§4 规则。</p>';

  const taskCards = activeItems.task || [];
  const taskHtml = taskCards.length ? taskCards.map((c) => {
    return '<article class="task-card searchable" data-node="' + c.id + '" tabindex="0">' +
      '<div class="task-top"><code>' + esc(c.subject || "—") + '</code><span class="stamp">#' + c.id + '</span></div>' +
      '<h3>' + esc(displayTitle(c) || "（无标题）") + '</h3>' +
      '<p>' + esc(truncate(c.preview || "", 150)) + '</p>' +
      '<div class="task-foot"><time>' + rel(c.updatedAt, now) + "</time></div></article>";
  }).join("") : '<p class="empty">还没有任务卡。用 memory_write layer=task 建一张。</p>';

  const candHtml = tree.candidates.length
    ? '<div class="candidate-list">' + tree.candidates.map((c) => '<div class="candidate searchable" data-node="' + c.id + '" tabindex="0"><span class="pill">待审候选</span><b>' + esc(truncate(displayTitle(c) || c.text, 70)) + '</b><span class="muted">编号 #' + c.id + " · 待审</span></div>").join("") + "</div>"
    : '<p class="empty">没有待审的主干候选。</p>';

  const leafItems = activeItems.leaf || [];
  const leafHtml = leafItems.length
    ? '<div class="chips">' + leafItems.map((i) => '<button class="leaf-chip searchable" data-node="' + i.id + '" type="button">' + esc(truncate(i.preview || i.title || "", 42)) + "</button>").join("") + "</div>"
    : '<p class="empty">近 7 天没有新的判断叶。</p>';
  const leafHistory = store.list({ scope: scopes, layers: ["leaf"], status: ["archived", "superseded"], limit: 100, order: "updated" });
  const leafHistoryHtml = leafHistory.length
    ? '<details class="leaf-history"><summary>历史判断叶 ' + leafHistory.length + ' 条（已归档或被取代，不是待分拣）</summary><div class="leaf-list">' + leafHistory.map((i) => {
      const full = store.get(i.id);
      const status = i.status === "superseded" ? "被取代" : "已归档";
      return '<article class="leaf-card searchable" data-node="' + i.id + '" tabindex="0"><div class="leaf-head"><b>' + esc(displayTitle(i) || "判断叶") + '</b><span><i class="leaf-status">' + status + '</i> #' + i.id + " · " + rel(i.updatedAt, now) + '</span></div><div class="rule-full">' + esc(truncate((full && full.text) || i.preview, 180)) + "</div></article>";
    }).join("") + "</div></details>"
    : "";

  const pendingPatches = store.pendingPatches();
  const patchBatches = store.patchBatches(8);
  const patchKindLabel = { text: "改正文", number: "改编号", both: "编号+正文" };
  const pendingHtml = pendingPatches.length
    ? '<div class="patch-pool">' + pendingPatches.map((p) => {
      const num = p.newNum && p.newNum !== p.oldNum ? p.oldNum + " → " + p.newNum : p.oldNum;
      return '<div class="patch-row"><span class="patch-num">' + esc(num) + '</span>' +
        '<div class="patch-title"><b>' + esc(truncate(p.title || p.newText, 64)) + '</b><span>' +
        esc(patchKindLabel[p.kind] || p.kind) + ' · ' + esc(dt(p.updatedAt)) + '</span></div>' +
        '<button type="button" class="patch-del" data-patch-del="' + esc(p.id) + '">删除</button></div>';
    }).join("") + "</div>"
    : '<p class="empty">没有待确定写入的修改。</p>';
  const batchHtml = patchBatches.length
    ? '<div class="batch-list">' + patchBatches.map((b) => {
      const backupName = b.backup ? String(b.backup).split(/[\\/]/).pop() : "无备份";
      const status = b.status === "sync_failed" ? " · 索引未同步" : "";
      return '<div class="batch-row"><span><b>' + esc(dt(b.createdAt)) + '</b> · ' + Number(b.rules || 0) + ' 条规则 · ' + Number(b.refs || 0) + ' 处引用</span><span>' + esc(backupName + status) + '</span></div>';
    }).join("") + "</div>"
    : '<p class="empty">还没有写入记录。</p>';

  const emotionItems = activeItems.emotion || [];
  const emotionHtml = emotionItems.length
    ? '<div class="quotes">' + emotionItems.slice(0, 8).map((i) => '<figure class="quote searchable" data-node="' + i.id + '" tabindex="0"><blockquote>' + esc(truncate(i.preview || "", 180)) + '</blockquote><figcaption>#' + i.id + " · " + rel(i.updatedAt, now) + "</figcaption></figure>").join("") + "</div>"
    : '<p class="empty">还没有情感枝条目。</p>';


  const auditHtml = audits.length
    ? '<table><thead><tr><th>时间</th><th>动作</th><th>查询</th><th>命中</th></tr></thead><tbody>' +
      audits.map((a) => '<tr class="searchable"><td class="muted">' + dt(a.ts) + "</td><td>" + esc(AUDIT_LABEL[a.kind] || a.kind) + '</td><td class="mono">' + esc(truncate(a.query || "—", 44)) + "</td><td>" + (a.hits ?? "—") + "</td></tr>").join("") + "</tbody></table>"
    : '<p class="empty">还没有审计记录。</p>';

  const revHtml = revisions.length
    ? '<div class="timeline">' + revisions.map((r) => {
      const t = r.uid && uidTitle.has(r.uid) ? uidTitle.get(r.uid) : "";
      const who = t ? '<span class="rev-title">' + esc(truncate(t, 42)) + "</span>" : (r.uid ? " <code>" + esc(r.uid) + "</code>" : "");
      return '<div class="tl-item"><i class="tl-dot"></i><div><time>' + dt(r.ts) + "</time><b>" + esc(ACTION_LABEL[r.action] || r.action || "变更") + "</b>" + who + "</div></div>";
    }).join("") + "</div>"
    : '<p class="empty">还没有版本记录。</p>';

  const kvHtml = [
    ["数据库", shortPath(info.paths.dbFile)],
    ["库大小", (Number(stats.dbBytes || 0) / 1024).toFixed(1) + " KB"],
    ["库结构", "v" + stats.schemaVersion],
    ["索引版本", "v" + stats.indexVersion],
    ["主干同步", stats.lastSyncAt ? dt(stats.lastSyncAt) : "还没同步"],
    ["主干校验", stats.lastAgentsChecksum || "—"],
    ["日记", String(stats.diaryTotal ?? 0) + " 条"],
  ].map(([k, v]) => '<div class="kv-row"><span>' + esc(k) + "</span><code>" + esc(v) + "</code></div>").join("");

  const html = `<!doctype html>
<html lang="zh-CN" data-theme="night"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>记忆树 · 星图看板</title>
<style>
:root {
  color-scheme: dark;
  --bg: #060912; --bg2: #0a1020; --panel: rgba(14, 22, 38, .72); --panel-solid: #0d1524;
  --fg: #e8eefc; --muted: #8ea1bd; --line: rgba(148, 178, 218, .16); --line2: rgba(148, 178, 218, .28);
  --accent: #6ee7ff; --accent2: #ff8fb1; --warm: #ffd479; --shadow: 0 24px 80px rgba(0, 0, 0, .45);
  --c-trunk: #6ee7ff; --c-emotion: #ff8fb1; --c-task: #6ff0b3; --c-leaf: #ffd479;
  --sky: #070d19; --grid: rgba(110, 231, 255, .055); --deco: #b9d7ff; --map-glow: rgba(110, 231, 255, .16);
  --paper: rgba(255, 255, 255, .025);
  --lv-gold: #f5c451; --lv-purple: #b79cff; --lv-blue: #6ea8ff; --lv-green: #6ff0b3; --lv-yellow: #ffd479; --lv-red: #ff6b6b;
}
html[data-theme="paper"] {
  color-scheme: light;
  --bg: #f3eee4; --bg2: #ebe3d5; --panel: rgba(255, 252, 246, .82); --panel-solid: #fffaf2;
  --fg: #27231e; --muted: #776d5f; --line: rgba(86, 68, 44, .16); --line2: rgba(86, 68, 44, .28);
  --accent: #8b5a2b; --accent2: #a54a6a; --warm: #a06b1d; --shadow: 0 24px 70px rgba(72, 52, 30, .14);
  --c-trunk: #2f6f8f; --c-emotion: #b24a6a; --c-task: #2f7d5c; --c-leaf: #a8761f;
  --sky: #f7f1e7; --grid: rgba(70, 55, 35, .06); --deco: #8d7252; --map-glow: rgba(139, 90, 43, .10);
  --paper: rgba(255, 255, 255, .38);
}
html[data-theme="jade"] {
  color-scheme: dark;
  --bg: #05110e; --bg2: #071a15; --panel: rgba(8, 28, 23, .74); --panel-solid: #081b16;
  --fg: #e6f5ee; --muted: #8fb6a8; --line: rgba(140, 200, 180, .16); --line2: rgba(140, 200, 180, .3);
  --accent: #7ef0d0; --accent2: #ffa8c2; --warm: #ffd37a; --shadow: 0 24px 80px rgba(0, 0, 0, .5);
  --c-trunk: #7ef0d0; --c-emotion: #ffa8c2; --c-task: #9ff59a; --c-leaf: #ffd37a;
  --sky: #061511; --grid: rgba(126, 240, 208, .055); --deco: #b9ffe8; --map-glow: rgba(126, 240, 208, .14);
  --paper: rgba(255, 255, 255, .025);
}
html[data-theme="neon"] {
  color-scheme: dark;
  --bg: #0a0614; --bg2: #120a24; --panel: rgba(23, 11, 42, .72); --panel-solid: #150b2a;
  --fg: #f2eaff; --muted: #a99ac4; --line: rgba(190, 150, 255, .18); --line2: rgba(190, 150, 255, .34);
  --accent: #b388ff; --accent2: #ff5fd2; --warm: #ffe66b; --shadow: 0 24px 80px rgba(0, 0, 0, .55);
  --c-trunk: #66f5ff; --c-emotion: #ff6fd8; --c-task: #a6ff6b; --c-leaf: #ffe66b;
  --sky: #0b0618; --grid: rgba(179, 136, 255, .06); --deco: #e6c9ff; --map-glow: rgba(179, 136, 255, .18);
  --paper: rgba(255, 255, 255, .03);
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; color: var(--fg); background: var(--bg); font: 15px/1.72 "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; -webkit-font-smoothing: antialiased; }
body::before { content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 0; background:
  radial-gradient(1100px 620px at 12% -10%, color-mix(in srgb, var(--accent) 16%, transparent), transparent 62%),
  radial-gradient(900px 540px at 96% 2%, color-mix(in srgb, var(--accent2) 12%, transparent), transparent 58%),
  linear-gradient(180deg, var(--bg), var(--bg2)); }
body::after { content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 0; opacity: .22; background-image: radial-gradient(rgba(255,255,255,.16) .6px, transparent .6px); background-size: 4px 4px; }
a { color: var(--accent); }
button { font: inherit; color: inherit; }
code, .mono { font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; }
.wrap { position: relative; z-index: 1; max-width: 1180px; margin: 0 auto; padding: 0 24px 72px; }
.top { position: sticky; top: 0; z-index: 30; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 12px 24px; background: color-mix(in srgb, var(--bg) 76%, transparent); backdrop-filter: blur(18px); border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 11px; letter-spacing: .04em; font-weight: 650; }
.mark { width: 30px; height: 30px; border-radius: 50%; border: 1px solid var(--line2); display: grid; place-items: center; color: var(--accent); background: radial-gradient(circle at 35% 30%, color-mix(in srgb, var(--accent) 32%, transparent), transparent 62%); }
.brand em { display: block; font: 9px/1 ui-monospace, monospace; letter-spacing: .28em; color: var(--muted); font-style: normal; margin-top: 4px; }
.tools { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
.themes { display: flex; gap: 2px; padding: 3px; border: 1px solid var(--line); border-radius: 999px; background: var(--paper); }
.themes button { border: 0; background: transparent; color: var(--muted); font-size: 11.5px; padding: 7px 11px; border-radius: 999px; cursor: pointer; }
.themes button.on { color: var(--bg); background: var(--accent); }
.print-btn { border: 1px solid var(--line); background: var(--paper); color: var(--muted); border-radius: 999px; padding: 6px 10px; font-size: 10.5px; cursor: pointer; }
.search { display: flex; align-items: center; gap: 7px; border: 1px solid var(--line); border-radius: 999px; padding: 8px 14px; background: var(--paper); color: var(--muted); }
.search input { width: 172px; border: 0; outline: 0; background: transparent; color: var(--fg); font: inherit; font-size: 12.5px; }
.search input::placeholder { color: var(--muted); }
.search:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent); }
.hero { display: grid; grid-template-columns: minmax(0, 1fr) 220px; gap: 30px; align-items: end; padding: 76px 0 36px; }
.kicker { font: 10.5px/1.2 ui-monospace, monospace; letter-spacing: .22em; color: var(--accent); text-transform: uppercase; margin-bottom: 18px; }
.hero h1 { margin: 0 0 16px; font-family: "Iowan Old Style", "Songti SC", "STSong", Georgia, serif; font-size: clamp(54px, 8.4vw, 108px); line-height: .95; letter-spacing: .06em; font-weight: 500; }
.hero h1 span { background: linear-gradient(110deg, var(--accent), var(--accent2)); -webkit-background-clip: text; background-clip: text; color: transparent; }
.lede { max-width: 900px; margin: 0 0 20px; color: var(--muted); font-size: 15px; line-height: 1.9; text-wrap: pretty; }
.meta { display: flex; flex-wrap: wrap; gap: 8px 18px; color: var(--muted); font-size: 11.5px; }
.meta code { color: var(--fg); background: var(--paper); border: 1px solid var(--line); padding: 2px 6px; border-radius: 6px; }
.orb { width: 196px; height: 196px; border-radius: 50%; justify-self: end; position: relative; display: grid; place-items: center; background: conic-gradient(var(--c-trunk) 0 64%, var(--c-emotion) 64% 82%, var(--c-task) 82% 96%, var(--c-leaf) 96% 100%); filter: saturate(.9); }
.orb::before { content: ""; position: absolute; inset: 8px; border-radius: 50%; background: var(--bg); }
.orb::after { content: ""; position: absolute; inset: -10px; border: 1px dashed var(--line2); border-radius: 50%; }
.orb-in { position: relative; text-align: center; z-index: 1; }
.orb-in b { display: block; font: 42px/1 "Iowan Old Style", Georgia, serif; letter-spacing: .04em; }
.orb-in span { display: block; color: var(--muted); font: 9px/1.6 ui-monospace, monospace; letter-spacing: .2em; margin-top: 6px; }
.stats { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; margin: 8px 0 40px; }
.stat { border: 1px solid var(--line); border-radius: 14px; padding: 16px 16px 15px; background: var(--panel); backdrop-filter: blur(12px); }
.stat-label { color: var(--muted); font-size: 10.5px; letter-spacing: .08em; }
.stat-value { font-size: 27px; font-weight: 650; letter-spacing: -.02em; margin: 5px 0 4px; font-variant-numeric: tabular-nums; }
.stat-hint { color: var(--muted); font-size: 9.5px; line-height: 1.6; }
section.panel { position: relative; border: 1px solid var(--line); border-radius: 24px; background: var(--panel); backdrop-filter: blur(16px); box-shadow: var(--shadow); padding: 28px; margin: 0 0 18px; }
.panel-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 18px; }
.sec-no { font: 10px/1 ui-monospace, monospace; color: var(--accent); letter-spacing: .2em; }
.panel-head h2 { margin: 6px 0 4px; font-size: 21px; letter-spacing: .03em; font-weight: 600; }
.panel-head p { margin: 0; color: var(--muted); font-size: 12px; }
.legend { display: flex; flex-wrap: wrap; gap: 7px; justify-content: flex-end; max-width: 720px; }
.legend-item { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 999px; padding: 6px 10px; background: var(--paper); font-size: 11px; color: var(--muted); cursor: pointer; }
.legend-item b { color: var(--fg); font-variant-numeric: tabular-nums; }
.legend-item.is-dim { opacity: .38; }
.dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
.sky-wrap { position: relative; border-radius: 18px; overflow: hidden; border: 1px solid var(--line); background: var(--sky); }
#sky { display: block; width: 100%; height: auto; }
.map-zoom-btn { position: absolute; top: 10px; right: 10px; z-index: 2; display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line2); border-radius: 999px; padding: 5px 11px; background: color-mix(in srgb, var(--panel-solid) 82%, transparent); color: var(--fg); font: 11px/1.2 ui-monospace, monospace; letter-spacing: .04em; cursor: pointer; backdrop-filter: blur(8px); }
.map-zoom-btn:hover { border-color: var(--accent); color: var(--accent); }
.map-zoom-btn.zoom-inline { position: static; margin-left: 2px; padding: 5px 10px; font: 11px/1.2 ui-monospace, monospace; background: transparent; backdrop-filter: none; }
.map-zoom-btn.zoom-inline[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
.map-zoom-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
section.panel.map-full { position: fixed; inset: 12px; z-index: 50; margin: 0; display: flex; flex-direction: column; background: var(--panel-solid); }
section.panel.map-full .panel-head { flex: 0 0 auto; }
section.panel.map-full .sky-wrap { flex: 1 1 auto; min-height: 0; }
section.panel.map-full #sky { width: 100%; height: 100%; }
section.panel.map-full .map-note { flex: 0 0 auto; }
body.map-open { overflow: hidden; }
.sky-bg { fill: var(--sky); }
.grid-lines line { stroke: var(--grid); stroke-width: 1; }
.deco-stars circle { fill: var(--deco); }
.cluster-aura { fill: color-mix(in srgb, currentColor 8%, transparent); stroke: currentColor; stroke-opacity: .18; stroke-dasharray: 3 8; }
.cluster-label { fill: var(--muted); font: 11px ui-monospace, monospace; letter-spacing: .18em; text-anchor: middle; }
.cluster-label tspan { fill: var(--fg); font-weight: 700; }
.cluster-empty { fill: var(--muted); font-size: 11px; text-anchor: middle; opacity: .65; }
.constellation line { stroke: currentColor; stroke-opacity: .14; stroke-width: .8; }
.cluster-trunk { color: var(--c-trunk); } .cluster-emotion { color: var(--c-emotion); } .cluster-task { color: var(--c-task); } .cluster-leaf { color: var(--c-leaf); }
.star { cursor: pointer; outline: none; }
.star .core { fill: currentColor; filter: url(#glow); transition: filter .2s ease, opacity .2s ease; }
.star .halo { fill: currentColor; opacity: .18; }
.star .ring { fill: none; stroke: currentColor; stroke-opacity: .35; }
.star:hover .core, .star:focus .core { filter: url(#glow) brightness(1.35); }
.star:hover .halo, .star:focus .halo { opacity: .42; }
.star:focus .ring { stroke-opacity: 1; stroke-width: 2; }
.star-label { fill: var(--muted); font-size: 9.5px; opacity: .8; pointer-events: none; }
.star.is-dim { opacity: .14; }
.cluster.is-muted { opacity: .16; }
.map-note { color: var(--muted); font-size: 10.5px; letter-spacing: .04em; padding: 9px 3px 0; }
.grid2 { display: grid; grid-template-columns: 1.05fr .95fr; gap: 18px; }
.grid3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; }
.donut-wrap { position: relative; width: 178px; height: 178px; margin: 8px auto 18px; }
.donut { width: 100%; height: 100%; border-radius: 50%; filter: saturate(.92); }
.donut-hole { position: absolute; inset: 22px; border-radius: 50%; background: var(--panel-solid); border: 1px solid var(--line); display: grid; place-content: center; text-align: center; }
.donut-hole b { font-size: 30px; line-height: 1; font-variant-numeric: tabular-nums; }
.donut-hole span { color: var(--muted); font: 9px ui-monospace, monospace; letter-spacing: .18em; margin-top: 5px; }
.layer-row { display: grid; grid-template-columns: 74px minmax(0, 1fr) 34px 38px; align-items: center; gap: 10px; margin: 7px 0; font-size: 11.5px; color: var(--muted); }
.layer-name { display: flex; align-items: center; gap: 6px; color: var(--fg); }
.layer-count { text-align: right; color: var(--fg); font-variant-numeric: tabular-nums; }
.layer-pct { text-align: right; font-variant-numeric: tabular-nums; }
.mini-track { display: block; height: 4px; background: var(--line); border-radius: 99px; overflow: hidden; }
.mini-fill { display: block; height: 100%; border-radius: 99px; }
.bg-trunk { background: var(--c-trunk); } .bg-emotion { background: var(--c-emotion); } .bg-task { background: var(--c-task); } .bg-leaf { background: var(--c-leaf); }
.bar-row { display: flex; align-items: center; gap: 10px; margin: 6px 0; font-size: 11.5px; }
.bar-label { width: 62px; color: var(--muted); }
.bar-track { flex: 1; height: 5px; background: var(--line); border-radius: 99px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 99px; }
.l-trunk { background: var(--c-trunk); } .l-emotion { background: var(--c-emotion); } .l-task { background: var(--c-task); } .l-leaf { background: var(--c-leaf); }
.bar-num { width: 28px; text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; }
.scope-line { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-bottom: 1px dashed var(--line); font-size: 11.5px; }
.scope-line code { color: var(--muted); font-size: 11px; }
.section-title { display: flex; align-items: baseline; gap: 10px; margin: 44px 0 16px; }
.section-title h2 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: .03em; }
.section-title .sec-no { margin-right: 2px; }
.section-title em { color: var(--muted); font-style: normal; font-size: 11.5px; }
.tasks { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.task-card { border: 1px solid var(--line); border-radius: 16px; padding: 18px; background: var(--paper); cursor: pointer; transition: transform .18s ease, border-color .18s ease, background .18s ease; }
.task-card:hover { transform: translateY(-2px); border-color: var(--line2); background: color-mix(in srgb, var(--accent) 5%, var(--paper)); }
.task-top { display: flex; justify-content: space-between; gap: 10px; align-items: center; }
.task-top code { font-size: 10.5px; color: var(--accent); border: 1px solid var(--line); border-radius: 999px; padding: 1px 7px; }
.stamp { color: var(--muted); font: 10px ui-monospace, monospace; }
.task-card h3 { font-size: 14px; margin: 11px 0 7px; line-height: 1.45; font-weight: 600; }
.task-card p { color: var(--muted); font-size: 11.5px; line-height: 1.65; margin: 0 0 13px; }
.task-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; color: var(--muted); font-size: 10px; }
.rules-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px 16px; align-items: start; }
.rule-group { border: 1px solid var(--line); border-radius: 13px; padding: 0 15px; margin: 0; background: var(--paper); }
.rule-group[open] { grid-column: 1 / -1; }
.mini-head { margin: 22px 0 8px; color: var(--muted); font: 9.5px ui-monospace, monospace; letter-spacing: .16em; text-transform: uppercase; }
.kv-row { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 12px; align-items: start; padding: 9px 0; border-bottom: 1px dashed var(--line); font-size: 11.5px; }
.kv-row > span { color: var(--muted); }
.kv-row code { color: var(--fg); overflow-wrap: anywhere; font-size: 10.5px; line-height: 1.6; }
.rule-group summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 8px; padding: 11px 0; }
.rule-group summary::-webkit-details-marker { display: none; }
.rule-group summary .grp { font-size: 12.5px; font-weight: 600; }
.rule-group summary em { color: var(--muted); font-style: normal; font-size: 10.5px; }
.chev { width: 7px; height: 7px; border-right: 1.5px solid var(--muted); border-bottom: 1.5px solid var(--muted); transform: rotate(45deg); margin-left: auto; transition: transform .2s ease; }
.rule-group[open] .chev { transform: rotate(-135deg); }
.rule-group ul { margin: 0 0 12px; padding: 0; list-style: none; }
.rule-group li { display: flex; align-items: flex-start; gap: 9px; padding: 6px 0; border-top: 1px dashed var(--line); font-size: 11.5px; color: var(--muted); cursor: pointer; }
.rule-group li .rid { color: var(--accent); font: 10px ui-monospace, monospace; min-width: 54px; flex: 0 0 auto; }
.rule-group li span:last-child { min-width: 0; overflow-wrap: anywhere; line-height: 1.65; }
.rule-group li:hover span:last-child { color: var(--fg); }
.rule-items { margin: 0 0 10px; }
.rule-item { border-top: 1px dashed var(--line); padding: 7px 0; cursor: pointer; }
.rule-item:hover { background: color-mix(in srgb, var(--accent) 6%, transparent); }
.rule-item summary { list-style: none; cursor: pointer; display: flex; align-items: flex-start; gap: 9px; }
.rule-item summary::-webkit-details-marker { display: none; }
.rule-item summary .rid { color: var(--accent); font: 10px ui-monospace, monospace; min-width: 54px; flex: 0 0 auto; padding-top: 2px; }
.rule-item summary span:last-child { min-width: 0; overflow-wrap: anywhere; line-height: 1.65; }
.rule-item .rule-full { padding: 6px 0 2px 63px; }
.candidate-list { display: grid; gap: 8px; }
.candidate { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; align-items: center; padding: 10px 12px; border: 1px solid var(--line); border-radius: 11px; background: var(--paper); cursor: pointer; }
.candidate b { font-size: 12px; font-weight: 600; }
.candidate .muted { grid-column: 2; font-size: 10px; }
.pill { display: inline-block; font: 9.5px ui-monospace, monospace; letter-spacing: .06em; border: 1px solid var(--line2); border-radius: 999px; padding: 1px 7px; color: var(--accent); }
.pill.warn { color: var(--warm); border-color: color-mix(in srgb, var(--warm) 40%, transparent); }
.quotes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.quote { margin: 0; padding: 14px 16px; border-left: 2px solid color-mix(in srgb, var(--c-emotion) 60%, transparent); background: var(--paper); border-radius: 0 12px 12px 0; cursor: pointer; }
.quote blockquote { margin: 0 0 8px; color: var(--fg); font-size: 12px; line-height: 1.7; }
.quote figcaption { color: var(--muted); font: 10px ui-monospace, monospace; }
.chips { display: flex; flex-wrap: wrap; gap: 7px; }
.leaf-chip { border: 1px solid var(--line); border-radius: 999px; padding: 6px 11px; background: var(--paper); font-size: 11px; color: var(--muted); cursor: pointer; }
.leaf-chip:hover { color: var(--fg); border-color: var(--line2); }
.rule-full { color: var(--fg); font-size: 12px; line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; margin: 8px 0 10px; }
.leaf-list { display: grid; gap: 10px; }
.leaf-history { margin-top: 14px; border-top: 1px dashed var(--line); padding-top: 10px; }
.leaf-history summary { cursor: pointer; color: var(--muted); font-size: 15px; }
.leaf-status { font-style: normal; color: var(--warm); margin-right: 6px; }
.leaf-card { border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; background: var(--paper); cursor: pointer; }
.leaf-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
.leaf-head b { font-size: 13px; font-weight: 600; }
.leaf-head span { color: var(--muted); font: 10px ui-monospace, monospace; white-space: nowrap; }
.timeline { border-left: 1px solid var(--line); margin-left: 4px; padding-left: 16px; }
.tl-item { position: relative; padding: 0 0 15px; }
.tl-dot { position: absolute; left: -20px; top: 6px; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent); }
.tl-item time { display: block; color: var(--muted); font: 9.5px ui-monospace, monospace; }
.tl-item b { font-size: 11.5px; font-weight: 600; }
.tl-item code { color: var(--muted); font-size: 9.5px; }
.rev-title { display: block; color: var(--muted); font-size: 10.5px; margin-top: 1px; }
table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
th, td { text-align: left; padding: 8px 7px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: 10px; letter-spacing: .06em; }
td.muted { color: var(--muted); }
.warn-line { display: flex; gap: 8px; align-items: center; padding: 6px 0; border-bottom: 1px dashed var(--line); font-size: 11px; }
.health { display: flex; gap: 8px; align-items: center; color: var(--muted); font-size: 11.5px; padding: 8px 0; }
.ok-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--c-task); box-shadow: 0 0 0 3px color-mix(in srgb, var(--c-task) 14%, transparent); }
.empty { color: var(--muted); font-size: 11.5px; margin: 6px 0; }
.note { color: var(--muted); font-size: 11px; margin: 10px 0 0; }
footer { position: relative; z-index: 1; max-width: 1180px; margin: 0 auto; padding: 10px 24px 44px; color: var(--muted); font-size: 10.5px; line-height: 1.9; }
footer code { color: var(--fg); }
footer b { color: var(--fg); font-weight: 600; }
#tip { position: fixed; z-index: 60; pointer-events: none; padding: 7px 10px; border: 1px solid var(--line2); border-radius: 8px; background: var(--panel-solid); color: var(--fg); font-size: 11px; box-shadow: var(--shadow); opacity: 0; transform: translateY(4px); transition: opacity .12s ease, transform .12s ease; max-width: 280px; }
#tip.on { opacity: 1; transform: translateY(0); }
#tip small { display: block; color: var(--muted); font-size: 9.5px; margin-top: 2px; }
.scrim { position: fixed; inset: 0; background: rgba(2, 5, 10, .46); backdrop-filter: blur(3px); opacity: 0; pointer-events: none; transition: opacity .25s ease; z-index: 70; }
.scrim.open { opacity: 1; pointer-events: auto; }
.drawer { position: fixed; z-index: 80; top: 0; right: 0; height: 100%; width: min(430px, 92vw); background: var(--panel-solid); border-left: 1px solid var(--line2); transform: translateX(102%); transition: transform .28s cubic-bezier(.22, .8, .24, 1); padding: 30px 26px 72px; overflow-y: auto; overscroll-behavior: contain; box-shadow: -30px 0 90px rgba(0,0,0,.35); }
.drawer.open { transform: translateX(0); }
.drawer-close { position: absolute; right: 18px; top: 16px; border: 1px solid var(--line); background: transparent; color: var(--muted); width: 28px; height: 28px; border-radius: 50%; cursor: pointer; font-size: 15px; line-height: 1; }
.drawer-kicker { color: var(--accent); font: 10px ui-monospace, monospace; letter-spacing: .16em; margin-bottom: 12px; }
.drawer h3 { font-size: 20px; line-height: 1.45; margin: 0 0 10px; font-weight: 600; overflow-wrap: anywhere; }
.drawer-meta { color: var(--muted); font-size: 10.5px; line-height: 1.8; margin-bottom: 17px; }
.drawer-preview { font-size: 12.5px; line-height: 1.9; color: var(--fg); white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
.drawer-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 16px; }
.drawer-tags span { color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 2px 8px; font-size: 10px; }
.drawer-uid { display: block; margin-top: 20px; color: var(--muted); font-size: 9.5px; overflow-wrap: anywhere; }
.drawer-actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 22px; padding-top: 16px; border-top: 1px solid var(--line); }
.act { appearance: none; border: 1px solid var(--line); border-radius: 9px; background: var(--paper); color: var(--fg); font: inherit; font-size: 11.5px; line-height: 1.3; padding: 9px 6px; cursor: pointer; transition: border-color .15s ease, background .15s ease, opacity .15s ease; }
.act:hover { border-color: var(--accent); }
.act:disabled { opacity: .5; cursor: wait; }
.act.primary { background: var(--accent); border-color: var(--accent); color: var(--bg); font-weight: 600; grid-column: 1 / -1; font-size: 12px; }
.act.danger { color: #e27373; }
.act.danger:hover { border-color: #e27373; }
.drawer-status { min-height: 16px; margin-top: 12px; color: var(--muted); font-size: 10.5px; line-height: 1.7; overflow-wrap: anywhere; }
.drawer-status.err { color: #e27373; }
.drawer-status.ok { color: var(--c-task); }
.stat-bottom { font-size: 12.5px; font-weight: 700; margin-top: 5px; letter-spacing: .02em; }
.branch-intro { display: grid; gap: 11px; margin: 18px 0 4px; }
.branch-row { display: flex; align-items: baseline; gap: 3px 9px; flex-wrap: wrap; }
.branch-name { font-size: 13px; font-weight: 700; letter-spacing: .02em; flex: 0 0 auto; }
.branch-desc { color: var(--fg); font-size: 10.5px; line-height: 1.6; opacity: .88; flex: 1 0 100%; }
.drawer-actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 22px; padding-top: 16px; border-top: 1px solid var(--line); }
.act.full { grid-column: 1 / -1; }
.act-row { grid-column: 1 / -1; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.warn-text { font-size: 13px; line-height: 1.8; color: var(--fg); margin: 6px 0; }
.rule-add { border: 1px solid var(--line2); background: var(--paper); color: var(--fg); border-radius: 999px; padding: 6px 11px; font-size: 10.5px; cursor: pointer; }
.rule-add:hover { border-color: var(--accent); }
#rule-hint { color: var(--muted); font-size: 11.5px; line-height: 1.8; margin: 10px 0; }
.edit-modal { position: fixed; inset: 0; z-index: 120; display: grid; place-items: center; padding: 20px; background: rgba(2, 5, 10, .58); backdrop-filter: blur(4px); }
.edit-modal[hidden] { display: none; }
.edit-box { width: min(640px, 96vw); max-height: 90vh; overflow-y: auto; border: 1px solid var(--line2); border-radius: 16px; background: var(--panel-solid); padding: 22px; box-shadow: var(--shadow); }
.edit-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.edit-head h3 { margin: 0; font-size: 18px; }
.edit-head .drawer-close { position: static; }
.edit-hint { color: var(--muted); font-size: 11px; line-height: 1.8; margin: 12px 0; }
#edit-text { width: 100%; box-sizing: border-box; min-height: 260px; resize: vertical; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); color: var(--fg); font: 12.5px/1.8 ui-monospace, "Cascadia Mono", monospace; padding: 12px; outline: none; }
#edit-text:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent); }
#rule-text { width: 600px; max-width: 100%; height: 100px; min-height: 100px; box-sizing: border-box; resize: vertical; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); color: var(--fg); font: 12.5px/1.8 ui-monospace, "Cascadia Mono", monospace; padding: 12px; outline: none; }
#rule-text:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent); }
.edit-num-row { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; flex-wrap: wrap; }
.edit-num-row[hidden] { display: none; }
.edit-num-row label { color: var(--muted); font-size: 11px; letter-spacing: .08em; }
.edit-num-row input { flex: 1 1 220px; min-width: 180px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); font: 12.5px/1.6 ui-monospace, "Cascadia Mono", monospace; padding: 8px 10px; outline: none; }
.edit-num-row input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent); }
.edit-num-hint { color: var(--muted); font-size: 10.5px; line-height: 1.6; flex-basis: 100%; }
.patch-pool { display: grid; gap: 8px; margin: 8px 0 0; }
.patch-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: center; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; background: var(--paper); }
.patch-num { font: 12px ui-monospace, "Cascadia Mono", monospace; color: var(--accent); white-space: nowrap; }
.patch-title { min-width: 0; }
.patch-title b { display: block; font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.patch-title span { display: block; color: var(--muted); font-size: 10.5px; margin-top: 3px; }
.patch-del { border: 1px solid var(--line2); background: transparent; color: var(--muted); border-radius: 999px; padding: 4px 9px; font-size: 10.5px; cursor: pointer; }
.patch-del:hover { color: var(--fg); border-color: var(--accent2); }
.patch-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
.patch-note { color: var(--muted); font-size: 10.5px; line-height: 1.6; }
.batch-list { display: grid; gap: 6px; margin-top: 8px; }
.batch-row { display: flex; justify-content: space-between; gap: 10px; border-bottom: 1px solid var(--line); padding: 7px 0; font-size: 11px; color: var(--muted); }
.batch-row b { color: var(--fg); font-weight: 600; }
.scan-summary { display: flex; gap: 16px; flex-wrap: wrap; margin: 6px 0 12px; font-size: 12px; }
.scan-summary b { color: var(--accent); }
.scan-block { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin: 10px 0; background: var(--paper); max-height: 280px; overflow: auto; }
.scan-block h4 { margin: 0 0 8px; font-size: 12px; }
.scan-conflict { color: var(--lv-red); font-size: 11.5px; line-height: 1.6; }
.scan-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.scan-table th, .scan-table td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
.scan-table th { color: var(--muted); font-weight: 500; }
.scan-table code { font-size: 10.5px; }
.scan-ref { font-size: 11px; line-height: 1.6; border-bottom: 1px solid var(--line); padding: 5px 0; }
.scan-ref b { color: var(--muted); font-weight: 500; }
.scan-ref del { color: var(--muted); }
.scan-ref ins { color: var(--accent); text-decoration: none; }
#scan-modal .edit-box { width: min(780px, 96vw); }
.edit-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.edit-foot .act { min-width: 88px; }
.check-row { display:flex; align-items:flex-start; gap:9px; margin:8px 0; font-size:13px; line-height:1.5; cursor:pointer; }
.check-row input { margin-top:2px; flex:0 0 auto; }
#trunk-modal .edit-box, #task-modal .edit-box, #branch-modal .edit-box, #think-modal .edit-box { width:min(460px,96vw); }
#think-modal .act.full { width:100%; display:block; }
#think-modal .edit-box { width: min(440px, 96vw); }
#think-modal .act.full { width: 100%; display: block; }
#think-modal .edit-foot { justify-content: center; }
.is-filtered { display: none !important; }
@media (max-width: 900px) {
  .hero { grid-template-columns: 1fr; padding-top: 52px; }
  .orb { display: none; }
  .stats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .grid2, .grid3, .tasks, .quotes, .rules-grid { grid-template-columns: 1fr; }
  .panel { padding: 20px; border-radius: 18px; }
  .top { padding: 10px 14px; }
  .search input { width: 110px; }
  .legend { justify-content: flex-start; }
  .panel-head { flex-direction: column; }
}
@media (max-width: 560px) {
  .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .wrap { padding: 0 14px 50px; }
  .themes { display: none; }
  .print-btn { display: none; }
  .top { flex-wrap: wrap; gap: 8px; }
  .tools { width: 100%; }
  .search { flex: 1 1 100%; }
  .search input { width: 100%; }
  .panel { padding: 16px 12px; }
  .stat { padding: 10px 11px; }
  h1 { font-size: 56px; }
}
@media print {
  body { background: #fff; color: #111; }
  .top, .hero .orb, .themes, .search, .print-btn, .drawer, .scrim, #tip { display: none !important; }
  .panel, .stat, .task-card, .quote { background: #fff; box-shadow: none; border-color: #ddd; }
  .hero { padding-top: 20px; }
}
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; transition: none !important; animation: none !important; } }
</style></head>
<body>
<header class="top">
  <div class="brand"><span class="mark">✳</span><span>记忆树</span></div>
  <div class="tools">
    <div class="themes" role="group" aria-label="主题">
      <button type="button" data-theme-set="night">夜航</button>
      <button type="button" data-theme-set="paper">纸笺</button>
      <button type="button" data-theme-set="jade">苍青</button>
      <button type="button" data-theme-set="neon">霓虹</button>
    </div>
    <button class="rule-add" id="add-rule" type="button">＋ 如何添加规则</button>
    <button class="print-btn" id="print-btn" type="button">打印 / PDF</button>
    <label class="search">⌕ <input id="q" type="search" placeholder="搜记忆、主题、规则…" autocomplete="off"></label>
  </div>
</header>

<main class="wrap">
  <section class="hero">
    <div>
      <div class="kicker">本机记忆快照 · 四枝一树</div>
      <h1>记忆<span>树</span></h1>
      <p class="lede">主干是意识，情感枝是经历，任务枝是能力，判断叶是审查。</p>
      <div class="meta">
        <span>生成于 ${esc(dt(now))}</span>
        <span>库 <code>${esc(shortPath(info.paths.dbFile))}</code></span>
        <span>索引 v${stats.indexVersion}</span>
        <span>命中 <b id="hit-count">${stats.total}</b> 条</span>
      </div>
    </div>
    <div class="orb" style="background:${donutStyle(activeCounts, totalActive)}"><div class="orb-in"><b>${totalActive}</b><span>正式 / ${stats.total}</span></div></div>
  </section>

  <section class="stats">${chips}</section>
  ${firstRunHtml}

  <section class="panel" id="map">
    <div class="panel-head">
      <div><div class="sec-no">01 / 星图</div><h2>星图</h2><p>每颗星是一条记忆：颜色按枝区分，亮度看新近程度。</p></div>
      <div class="legend"><button class="legend-item on" data-filter-layer="all" type="button">全部 <b>${totalActive}</b></button>${layersLegend}<button class="legend-item map-zoom-btn zoom-inline" id="map-zoom" type="button" aria-pressed="false" title="点击星图空白处也可以放大/还原">⛶ 放大星图</button></div>
    </div>
    <div class="sky-wrap">${sky}</div>
    <div class="map-note">悬停读标题 · 点击开详情 · 点击星图空白处放大/还原 · 上方色标可按枝过滤</div>
  </section>

  <div class="grid2">
    <section class="panel">
      <div class="panel-head"><div><div class="sec-no">02 / 构成</div><h2>四枝构成</h2><p>当前正式条目的分布。</p></div></div>
      ${donut}
      ${layerRows}
      <div class="branch-intro">${branchIntro}</div>
      <div class="mini-head">可见范围</div>
      ${scopeText || '<p class="empty">暂无可见范围记录。</p>'}
      <div class="mini-head">库状态</div>
      <div class="kv-row"><span>库大小</span><code>${(Number(stats.dbBytes || 0) / 1024).toFixed(1)} KB</code></div>
      <div class="kv-row"><span>库结构</span><code>v${stats.schemaVersion} · 索引 v${stats.indexVersion}</code></div>
      <div class="kv-row"><span>主干同步</span><code>${stats.lastSyncAt ? esc(dt(stats.lastSyncAt)) : "还没同步"}</code></div>
      <div class="kv-row"><span>日记</span><code>${stats.diaryTotal ?? 0} 条</code></div>
    </section>
    <section class="panel">
      <div class="panel-head"><div><div class="sec-no">03 / 变化</div><h2>最近变化</h2><p>新增、更新、取代与归档。</p></div></div>
      ${revHtml}
    </section>
  </div>

  <div class="section-title"><span class="sec-no">04 / 主干</span><h2>主干</h2><em>执行意识——每轮都要遵守的判断和底线，比如安全规则、沟通方式和做事原则。</em></div>
  <section class="panel"><div class="rules-grid">${trunkHtml || '<p class="empty">还没有同步主干。执行 memory_ingest action=sync。</p>'}</div></section>

  <div class="section-title"><span class="sec-no">05 / 情感枝</span><h2>情感枝</h2><em>相处经历——相处中发生的事、关系的变化和真实的感受。</em></div>
  <section class="panel">${emotionHtml}</section>

  <div class="section-title"><span class="sec-no">06 / 任务枝</span><h2>任务枝</h2><em>执行能力——插件、工具、脚本、常驻服务的做法卡，需要时照着做。</em></div>
  <section class="panel"><div class="tasks">${taskHtml}</div></section>

  <div class="section-title"><span class="sec-no">07 / 判断叶</span><h2>判断叶</h2><em>规则审查——还没归类、等待判断的观察和线索。</em></div>
  <section class="panel">
    ${leafHtml}
    ${leafHistoryHtml}
    <div class="section-title" style="margin:22px 0 10px"><h2 style="font-size:15px">待确定写入</h2><em>${pendingPatches.length} 条</em></div>
    ${pendingHtml}
    <div class="patch-actions">
      <button type="button" class="act primary" id="patch-scan"${pendingPatches.length ? "" : " disabled"}>检索冲突</button>
      <span class="patch-note">改编号和改正文都先停在这里，不碰 AGENTS.md。检索只查编号重排、全文引用和重复；正文语义冲突不会被自动发现。确认写入前会备份正本。</span>
    </div>
    <div class="section-title" style="margin:22px 0 10px"><h2 style="font-size:15px">已写入记录</h2><em>${patchBatches.length} 批</em></div>
    ${batchHtml}
    <div class="section-title" style="margin:22px 0 10px"><h2 style="font-size:15px">主干候选</h2><em>${stats.candidates} 条</em></div>
    ${candHtml}
    <p class="note">用 memory_daily 查看待分拣条目；分拣失败会保留，不静默丢。</p>
  </section>

  <div class="section-title" id="sec-rules"><span class="sec-no">08 / 规则</span><h2>情感枝、任务枝、判断叶规则</h2><em>情感枝、任务枝、判断叶本体规则正文。</em></div>
  <section class="panel"><div class="rules-grid">${agentSectionsHtml}</div></section>

  <div class="section-title"><span class="sec-no">09 / 审计</span><h2>审计与版本</h2><em>可追溯，但不记录会话正文</em></div>
  <div class="grid2">
    <section class="panel"><div class="panel-head"><div><h2 style="font-size:15px">最近检索 / 写入</h2></div></div>${auditHtml}</section>
    <section class="panel"><div class="panel-head"><div><h2 style="font-size:15px">库与索引</h2></div></div>${kvHtml}</section>
  </div>
</main>

<footer>
  <b>看板是生成时的快照。</b>实时数据以 <code>${esc(shortPath(info.paths.dbFile))}</code> 为准；主干规则的唯一正本仍是 <code>${esc(shortPath(info.paths.agentsPath))}</code>。<br>
  检索方式：关键词匹配 + 字形近似匹配；后者只看字形，不懂同义词，换一种说法可能漏掉。<br>
  插件不联网、不保存任何密钥；本页不含任何外部资源，可离线打开或打印。看板本身不调用大模型；「DSH 深度思考优化」只是把规则正文与问题投回发起看板的 DSH 会话，由 DSH 处理。
</footer>

<div id="tip"></div>
<div class="scrim" id="scrim"></div>
<aside class="drawer" id="drawer" aria-hidden="true" aria-label="记忆详情">
  <button class="drawer-close" id="drawer-close" type="button" aria-label="关闭">×</button>
  <div class="drawer-kicker" id="d-layer">NODE</div>
  <h3 id="d-title"></h3>
  <div class="drawer-meta" id="d-meta"></div>
  <p class="drawer-preview" id="d-preview"></p>
  <div class="drawer-tags" id="d-tags"></div>
  <code class="drawer-uid" id="d-uid"></code>
  <div class="drawer-actions" id="drawer-actions">
    <button type="button" class="act primary full" data-act="think">DSH 深度思考优化</button>
    <button type="button" class="act full" id="branch-btn" data-act="branch" hidden>归入哪条枝</button>
    <button type="button" class="act full" id="bucket-btn" data-act="bucket" hidden>改大标题</button>
    <div class="act-row">
      <button type="button" class="act" data-act="edit">手动修改</button>
      <button type="button" class="act danger" data-act="delete">删除</button>
    </div>
  </div>
  <div class="drawer-status" id="drawer-status" role="status" aria-live="polite"></div>
</aside>

<div class="edit-modal" id="edit-modal" hidden>
  <div class="edit-box" role="dialog" aria-modal="true" aria-labelledby="edit-title">
    <div class="edit-head">
      <div>
        <div class="drawer-kicker">EDIT NODE</div>
        <h3 id="edit-title">手动修改</h3>
      </div>
      <button type="button" class="drawer-close" id="edit-cancel" aria-label="关闭">×</button>
    </div>
    <p class="edit-hint" id="edit-hint"></p>
    <div class="edit-num-row" id="edit-num-row" hidden>
      <label for="edit-num">库内编号</label>
      <input id="edit-num" spellcheck="false" autocomplete="off" placeholder="trunk:§1-1-3">
      <span class="edit-num-hint">保存后先进入判断叶【待确定写入】，点「检索冲突」确认后再写 AGENTS.md；不会立刻生效。</span>
    </div>
    <textarea id="edit-text" spellcheck="false"></textarea>
    <div class="edit-foot">
      <button type="button" class="act" id="edit-cancel-btn">取消</button>
      <button type="button" class="act primary" id="edit-save">保存修改</button>
    </div>
    <div class="drawer-status" id="edit-status" role="status" aria-live="polite"></div>
  </div>
</div>

<div class="edit-modal" id="warn-modal" hidden>
  <div class="edit-box" role="dialog" aria-modal="true" aria-labelledby="warn-title">
    <div class="edit-head">
      <div><div class="drawer-kicker">写入正本前确认</div><h3 id="warn-title">修改 AGENTS.md 规则</h3></div>
      <button type="button" class="drawer-close" id="warn-close" aria-label="关闭">×</button>
    </div>
    <p class="warn-text">用户请勿随意修改规则，未经优化的规则文字表达有误区。</p>
    <p class="warn-text">极易误导DSH的规则读取，DSH会曲解本规则想表达含义。</p>
    <button type="button" class="act primary full" id="warn-think">DSH 深度思考优化</button>
    <div class="edit-foot">
      <button type="button" class="act" id="warn-cancel">取消</button>
      <button type="button" class="act primary" id="warn-confirm">确认修改</button>
    </div>
    <div class="drawer-status" id="warn-status" role="status" aria-live="polite"></div>
  </div>
</div>

<div class="edit-modal" id="scan-modal" hidden>
  <div class="edit-box" role="dialog" aria-modal="true" aria-labelledby="scan-title">
    <div class="edit-head">
      <div><div class="drawer-kicker">写入前检查</div><h3 id="scan-title">检索冲突</h3></div>
      <button type="button" class="drawer-close" id="scan-close" aria-label="关闭">×</button>
    </div>
    <div id="scan-body"></div>
    <div class="edit-foot">
      <button type="button" class="act" id="scan-cancel">取消</button>
      <button type="button" class="act primary" id="scan-apply" disabled>确认写入</button>
    </div>
    <div class="drawer-status" id="scan-status" role="status" aria-live="polite"></div>
  </div>
</div>

<div class="edit-modal" id="think-modal" hidden>
  <div class="edit-box" role="dialog" aria-modal="true" aria-labelledby="think-title">
    <div class="edit-head">
      <div><div class="drawer-kicker">深度思考优化</div><h3 id="think-title">这条请求发到哪里？</h3></div>
      <button type="button" class="drawer-close" id="think-close" aria-label="关闭">×</button>
    </div>
    <p class="note">会带上这条规则的正文，请 DSH 给出优化方案。新会话会在当前工作区里新建；两个选择都不会自动改 AGENTS.md。</p>
    <button type="button" class="act primary full" data-think-target="current">发送至“当前会话”</button>
    <button type="button" class="act full" data-think-target="new" style="margin-top:8px">发送至“新会话”</button>
    <div class="edit-foot"><button type="button" class="act" id="think-cancel">取消</button></div>
    <div class="drawer-status" id="think-status" role="status" aria-live="polite"></div>
  </div>
</div>

<div class="edit-modal" id="branch-modal" hidden>
  <div class="edit-box" role="dialog" aria-modal="true" aria-labelledby="branch-title">
    <div class="edit-head">
      <div><div class="drawer-kicker">规则归类</div><h3 id="branch-title">请选择写入哪条枝</h3></div>
      <button type="button" class="drawer-close" id="branch-close" aria-label="关闭">×</button>
    </div>
    <p class="note" id="branch-hint">这条规则还没有归类。主干会成为 DSH 的核心规则；情感枝/任务枝只写本机记忆库，不需要改 AGENTS.md。归入主干会先选大标题，再勾五项检查。</p>
    <button type="button" class="act primary full" data-branch="trunk">主干</button>
    <button type="button" class="act full" data-branch="emotion" style="margin-top:8px">情感枝</button>
    <button type="button" class="act full" data-branch="task" style="margin-top:8px">任务枝</button>
    <div class="edit-foot"><button type="button" class="act" id="branch-cancel">取消</button></div>
    <div class="drawer-status" id="branch-status" role="status" aria-live="polite"></div>
  </div>
</div>

<div class="edit-modal" id="task-modal" hidden>
  <div class="edit-box" role="dialog" aria-modal="true" aria-labelledby="task-title">
    <div class="edit-head">
      <div><div class="drawer-kicker">归入任务枝</div><h3 id="task-title">放到哪张任务卡？</h3></div>
      <button type="button" class="drawer-close" id="task-close" aria-label="关闭">×</button>
    </div>
    <p class="note" id="task-status-line">正在请 DSH 判断最合适的任务卡…</p>
    <div id="task-recommend" class="note" hidden></div>
    <label class="muted" for="task-subject">选择现有任务卡</label>
    <select id="task-subject" style="width:100%;margin:6px 0 10px;padding:8px;border-radius:8px;background:var(--bg2);color:var(--ink);border:1px solid var(--line2)"></select>
    <label class="muted" for="task-new-subject">或新建一张卡（subject，小写英文/拼音）</label>
    <input id="task-new-subject" placeholder="例如 qqbot" style="width:100%;margin:6px 0 10px;padding:8px;border-radius:8px;background:var(--bg2);color:var(--ink);border:1px solid var(--line2)">
    <div class="edit-foot">
      <button type="button" class="act" id="task-cancel">取消</button>
      <button type="button" class="act primary" id="task-confirm">确认写入任务枝</button>
    </div>
    <div class="drawer-status" id="task-status" role="status" aria-live="polite"></div>
  </div>
</div>

<div class="edit-modal" id="trunk-modal" hidden>
  <div class="edit-box" role="dialog" aria-modal="true" aria-labelledby="trunk-title">
    <div class="edit-head">
      <div><div class="drawer-kicker">归入主干</div><h3 id="trunk-title">先核对核心规则资格</h3></div>
      <button type="button" class="drawer-close" id="trunk-close" aria-label="关闭">×</button>
    </div>
    <p class="note">AGENTS.md 是每轮都要读取的正本。五条全部勾选，才会写入 §1 并备份原文件。</p>
    <div id="trunk-checks">
      <label class="check-row"><input type="checkbox" data-check="0"> 这条规则每轮都必须遵守，不是偶尔用到的操作细节。</label>
      <label class="check-row"><input type="checkbox" data-check="1"> 它跨项目、长期有效，不会过几天就变。</label>
      <label class="check-row"><input type="checkbox" data-check="2"> 它是判断边界或底线，不是某个插件的具体做法。</label>
      <label class="check-row"><input type="checkbox" data-check="3"> 它不和现有 §1 重复、冲突，也不会把别的规则带偏。</label>
      <label class="check-row"><input type="checkbox" data-check="4"> 不写进去，DSH 会在实际事情上犯错。</label>
    </div>
    <p class="note" id="trunk-bucket-line" hidden></p>
    <label class="muted" for="trunk-group">写入哪个分组</label>
    <select id="trunk-group" style="width:100%;margin:6px 0 10px;padding:8px;border-radius:8px;background:var(--bg2);color:var(--ink);border:1px solid var(--line2)"></select>
    <input id="trunk-new-group" placeholder="新分组名，例如：新约定" style="width:100%;margin:0 0 10px;padding:8px;border-radius:8px;background:var(--bg2);color:var(--ink);border:1px solid var(--line2)">
    <div class="edit-foot">
      <button type="button" class="act" id="trunk-cancel">取消</button>
      <button type="button" class="act primary" id="trunk-confirm" disabled>确定添加</button>
    </div>
    <div class="drawer-status" id="trunk-status" role="status" aria-live="polite"></div>
  </div>
</div>

<div class="edit-modal" id="bucket-modal" hidden>
  <div class="edit-box" role="dialog" aria-modal="true" aria-labelledby="bucket-title">
    <div class="edit-head">
      <div><div class="drawer-kicker">主干大标题</div><h3 id="bucket-title">改大标题</h3></div>
      <button type="button" class="drawer-close" id="bucket-close" aria-label="关闭">×</button>
    </div>
    <p class="note" id="bucket-hint"></p>
    <label class="muted" for="bucket-select">放进哪个大标题</label>
    <select id="bucket-select" style="width:100%;margin:6px 0 10px;padding:8px;border-radius:8px;background:var(--bg2);color:var(--ink);border:1px solid var(--line2)"></select>
    <input id="bucket-new" placeholder="新大标题名，例如：网络与外部输入" hidden style="width:100%;margin:0 0 10px;padding:8px;border-radius:8px;background:var(--bg2);color:var(--ink);border:1px solid var(--line2)">
    <div class="edit-foot">
      <button type="button" class="act" id="bucket-cancel">取消</button>
      <button type="button" class="act primary" id="bucket-confirm">确定</button>
    </div>
    <div class="drawer-status" id="bucket-status" role="status" aria-live="polite"></div>
  </div>
</div>

<div class="edit-modal" id="rule-modal" hidden>
  <div class="edit-box" role="dialog" aria-modal="true" aria-labelledby="rule-title">
    <div class="edit-head">
      <div><div class="drawer-kicker">新建规则</div><h3 id="rule-title">如何添加规则</h3></div>
      <button type="button" class="drawer-close" id="rule-close" aria-label="关闭">×</button>
    </div>
    <p id="rule-hint">可在会话窗口中输入“制定新规则：”进行添加新规则。<br>这里写下的规则会先进入判断叶，等分拣后再决定是否升为主干；不会直接改 AGENTS.md。</p>
    <textarea id="rule-text" spellcheck="false" placeholder="例如：以后回复先给结论，再给理由。"></textarea>
    <div class="edit-foot">
      <button type="button" class="act" id="rule-cancel">取消</button>
      <button type="button" class="act primary" id="rule-save">保存到判断叶</button>
    </div>
    <div class="drawer-status" id="rule-status" role="status" aria-live="polite"></div>
  </div>
</div>

<script id="node-data" type="application/json">${nodeJson}</script>
<script id="board-data" type="application/json">${boardJson}</script>
<script>
(function () {
  var NODES = JSON.parse(document.getElementById('node-data').textContent || '{}');
  var root = document.documentElement;
  var tip = document.getElementById('tip');
  var drawer = document.getElementById('drawer');
  var scrim = document.getElementById('scrim');
  var dTitle = document.getElementById('d-title');
  var dLayer = document.getElementById('d-layer');
  var dMeta = document.getElementById('d-meta');
  var dPreview = document.getElementById('d-preview');
  var dTags = document.getElementById('d-tags');
  var dUid = document.getElementById('d-uid');
  var LABEL = { trunk: '主干', emotion: '情感枝', task: '任务枝', leaf: '判断叶', agent: '§2–§4' };
  var STATUS_TEXT = { active: '正式', candidate: '候选', superseded: '已取代', archived: '已归档' };
  function statusName(s) { return STATUS_TEXT[s] || '正式'; }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function scopeName(s) {
    s = String(s || '');
    if (s === 'user') return '本机通用';
    if (s.indexOf('workspace:') === 0) return '当前工作区';
    return s || '—';
  }
  var BOARD = {};
  try { BOARD = JSON.parse(document.getElementById('board-data').textContent || '{}'); } catch (e) {}
  var BOARD_BASE = BOARD.base || '';
  var BOARD_TOKEN = BOARD.token || '';
  var currentId = null;
  var drawerStatus = document.getElementById('drawer-status');
  var editModal = document.getElementById('edit-modal');
  var editText = document.getElementById('edit-text');
  var editStatus = document.getElementById('edit-status');
  var editHint = document.getElementById('edit-hint');
  var editNumRow = document.getElementById('edit-num-row');
  var editNum = document.getElementById('edit-num');
  var editId = null;
  function isNumberedTrunk(n) {
    return !!(n && n.layer === 'trunk' && /^trunk:§1-\\d+-\\d+$/.test(String(n.uid || '')));
  }

  function setStatus(el, msg, kind) {
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'drawer-status' + (kind ? ' ' + kind : '');
  }

  function actionUrl() {
    return BOARD_BASE + '/memory-tree/action';
  }

  async function callAction(payload) {
    if (!BOARD_TOKEN) throw new Error('看板没有绑定写操作令牌。请在本会话运行 memory_admin action=report 重新生成后再试。');
    if (location.protocol === 'file:' && !BOARD_BASE) {
      throw new Error('当前是离线 HTML 快照，没有连接 DSH。请在 DSH 会话里运行 memory_admin action=report 重新生成（会写入本机地址），或打开 DSH 的 /memory-tree/board 页面。');
    }
    var res = await fetch(actionUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mt-token': BOARD_TOKEN },
      body: JSON.stringify(payload),
    });
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok || !data || !data.ok) {
      throw new Error((data && data.error) || ('请求失败（HTTP ' + res.status + '）'));
    }
    return data;
  }


  function theme(name) {
    root.setAttribute('data-theme', name);
    try { localStorage.setItem('mt-theme', name); } catch (e) {}
    var buttons = document.querySelectorAll('[data-theme-set]');
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].classList.toggle('on', buttons[i].getAttribute('data-theme-set') === name);
    }
  }
  var saved = null;
  try { saved = localStorage.getItem('mt-theme'); } catch (e) {}
  if (saved) theme(saved);
  var themeButtons = document.querySelectorAll('[data-theme-set]');
  for (var t = 0; t < themeButtons.length; t += 1) {
    themeButtons[t].addEventListener('click', function () { theme(this.getAttribute('data-theme-set')); });
  }
  var printBtn = document.getElementById('print-btn');
  if (printBtn) printBtn.addEventListener('click', function () { window.print(); });

  function openNode(id) {
    var n = NODES[id];
    if (!n) return;
    currentId = id;
    setStatus(drawerStatus, '', '');
    if (n.virtual) {
      dLayer.textContent = 'AGENTS.md · ' + (n.section || '§2–§4');
      dTitle.textContent = n.title || '（无标题）';
      dMeta.textContent = '编号 ' + n.uid + ' · 规则正文';
    } else {
      dLayer.textContent = (LABEL[n.layer] || n.layer) + ' · ' + statusName(n.status);
      dTitle.textContent = n.title || '（无标题）';
      dMeta.textContent = '编号 #' + n.id + ' · ' + scopeName(n.scope);
    }
    dPreview.textContent = n.text || n.preview || '（这条没有摘要）';
    var branchBtn = document.getElementById('branch-btn');
    if (branchBtn) branchBtn.hidden = !!n.virtual || n.layer !== 'leaf' || n.status === 'archived' || n.status === 'superseded';
    var bucketBtn = document.getElementById('bucket-btn');
    if (bucketBtn) bucketBtn.hidden = !isNumberedTrunk(n) || n.status === 'candidate';
    dTags.textContent = '';
    for (var i = 0; i < (n.tags || []).length; i += 1) {
      var span = document.createElement('span');
      span.textContent = n.tags[i];
      dTags.appendChild(span);
    }
    dUid.textContent = n.uid && !n.virtual ? '库内编号：' + n.uid : '';
    drawer.classList.add('open');
    scrim.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
  }

  function closeDrawer() {
    drawer.classList.remove('open');
    scrim.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
  }

  var mapPanel = document.getElementById('map');
  var mapZoomBtn = document.getElementById('map-zoom');
  var skyWrap = mapPanel ? mapPanel.querySelector('.sky-wrap') : null;

  function setMapZoom(on) {
    if (!mapPanel) return;
    mapPanel.classList.toggle('map-full', !!on);
    document.body.classList.toggle('map-open', !!on);
    if (mapZoomBtn) {
      mapZoomBtn.textContent = on ? '⤡ 缩小星图' : '⛶ 放大星图';
      mapZoomBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  if (mapZoomBtn) {
    mapZoomBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      setMapZoom(!mapPanel.classList.contains('map-full'));
    });
  }

  // 点击星图空白处放大/还原；点星、点簇标签、点按钮都不触发。
  if (skyWrap) {
    skyWrap.addEventListener('click', function (e) {
      var t = e.target;
      if (t && t.closest && (t.closest('.star') || t.closest('.map-zoom-btn') || t.closest('.cluster-label'))) return;
      setMapZoom(!mapPanel.classList.contains('map-full'));
    });
  }

  function openEdit(id) {
    var n = NODES[id];
    if (!n) return;
    editId = id;
    editText.value = n.text || n.preview || '';
    if (n.virtual) {
      editNumRow.hidden = true;
      editNum.value = '';
      editHint.textContent = '这是 AGENTS.md §2–§4 的规则；保存会先备份、再写正本，可先看「DSH 深度思考优化」。';
      editModal.hidden = false;
      editText.focus();
      editText.setSelectionRange(0, 0);
      return;
    }
    var numbered = isNumberedTrunk(n);
    editNumRow.hidden = !numbered;
    editNum.value = numbered ? String(n.uid || '') : '';
    editHint.textContent = n.layer === 'trunk'
      ? (numbered
        ? '主干规则的正本是 AGENTS.md。保存后先进入判断叶【待确定写入】；点「检索冲突」确认后再写正本。'
        : '这条是主干候选，不是 AGENTS.md 正本；保存走原来的候选更新流程。')
      : n.layer === 'leaf'
        ? '保存后先选择写入哪条枝：主干要过五项核心规则检查；情感枝/任务枝只写本机记忆库。'
        : '保存后直接写入本机记忆库（保留版本记录）；删除是归档，不是物理删除。';
    editModal.hidden = false;
    if (numbered) editNum.focus();
    else editText.focus();
    editText.setSelectionRange(0, 0);
  }
  function closeEdit() {
    editModal.hidden = true;
    editId = null;
    setStatus(editStatus, '', '');
  }
  document.getElementById('edit-cancel').addEventListener('click', closeEdit);
  document.getElementById('edit-cancel-btn').addEventListener('click', closeEdit);
  editModal.addEventListener('click', function (e) { if (e.target === editModal) closeEdit(); });
  document.getElementById('edit-save').addEventListener('click', async function () {
    if (!editId) return;
    var n = NODES[editId];
    if (n && n.virtual) {
      openWarn('write-section-rule', editId, editText.value);
      return;
    }
    if (n && n.layer === 'trunk') {
      if (isNumberedTrunk(n)) {
        var numVal = (editNum.value || '').trim();
        if (!numVal) {
          setStatus(editStatus, '请填写库内编号，例如 trunk:§1-1-3。', 'err');
          editNum.focus();
          return;
        }
        var saveBtn = document.getElementById('edit-save');
        saveBtn.disabled = true;
        setStatus(editStatus, '正在暂存到判断叶…', '');
        try {
          var staged = await callAction({ op: 'stage-patch', id: Number(editId), num: numVal, text: editText.value });
          setStatus(editStatus, staged.message || '已暂存到判断叶。', 'ok');
          setTimeout(function () { location.reload(); }, 1000);
        } catch (err) {
          setStatus(editStatus, '暂存失败：' + (err && err.message ? err.message : String(err)), 'err');
        } finally {
          saveBtn.disabled = false;
        }
        return;
      }
      openWarn('write-trunk', Number(editId), editText.value);
      return;
    }
    if (n && n.layer === 'leaf') {
      var branchText = editText.value;
      var branchId = Number(editId);
      closeEdit();
      openBranch(branchId, branchText);
      return;
    }
    var btn = this;
    var text = editText.value;
    btn.disabled = true;
    setStatus(editStatus, '正在写入本机记忆库…', '');
    try {
      var data = await callAction({ op: 'update', id: Number(editId), text: text });
      var node = NODES[editId];
      if (node && data.node) {
        node.text = data.node.text || text;
        dPreview.textContent = node.text;
      }
      setStatus(editStatus, data.message || '已保存。', 'ok');
      setTimeout(closeEdit, 700);
    } catch (err) {
      setStatus(editStatus, '保存失败：' + (err && err.message ? err.message : String(err)), 'err');
    } finally {
      btn.disabled = false;
    }
  });

  var actionBar = document.getElementById('drawer-actions');
  actionBar.addEventListener('click', async function (e) {
    var btn = e.target.closest ? e.target.closest('button[data-act]') : null;
    if (!btn || !currentId) return;
    var act = btn.getAttribute('data-act');
    if (act === 'edit') { openEdit(currentId); return; }
    if (act === 'bucket') { openBucketForNode(currentId); return; }
    if (act === 'branch') {
      var n = NODES[currentId];
      openBranch(Number(currentId), n ? (n.text || n.preview || '') : '');
      return;
    }
    if (act === 'think') {
      var node = NODES[currentId];
      openThink({ id: currentId, ruleNum: node && node.virtual ? node.uid : '', text: node ? (node.text || node.preview || '') : '', status: drawerStatus });
      return;
    }
    if (act === 'delete') {
      var node = NODES[currentId];
      if (node && node.virtual) { openWarn('delete-section-rule', currentId, node.text || ''); return; }
      if (node && node.layer === 'trunk' && node.status !== 'candidate') { openWarn('delete-trunk', Number(currentId), node.text || ''); return; }
      if (!confirm('删除会归档这条记忆（不是物理删除）。确定吗？')) return;
    }
    var buttons = actionBar.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i += 1) buttons[i].disabled = true;
    setStatus(drawerStatus, act === 'think' ? '正在把优化请求发给 DSH 会话…' : '正在处理…', '');
    try {
      var payload = { op: act, id: Number(currentId) };
      var data = await callAction(payload);
      setStatus(drawerStatus, data.message || '已完成。', 'ok');
      if (act === 'delete') setTimeout(closeDrawer, 900);
    } catch (err) {
      setStatus(drawerStatus, '操作失败：' + (err && err.message ? err.message : String(err)), 'err');
    } finally {
      for (var j = 0; j < buttons.length; j += 1) buttons[j].disabled = false;
    }
  });

  // ---- 深度思考：先选发到哪个会话 ----
  var thinkModal = document.getElementById('think-modal');
  var thinkStatus = document.getElementById('think-status');
  var pendingThink = null;
  function openThink(opts) {
    pendingThink = opts || null;
    setStatus(thinkStatus, '', '');
    thinkModal.hidden = false;
  }
  function closeThink() {
    thinkModal.hidden = true;
    pendingThink = null;
    setStatus(thinkStatus, '', '');
  }
  document.getElementById('think-close').addEventListener('click', closeThink);
  document.getElementById('think-cancel').addEventListener('click', closeThink);
  thinkModal.addEventListener('click', function (e) { if (e.target === thinkModal) closeThink(); });
  thinkModal.addEventListener('click', async function (e) {
    var btn = e.target.closest ? e.target.closest('[data-think-target]') : null;
    if (!btn || !pendingThink) return;
    var target = btn.getAttribute('data-think-target');
    var buttons = thinkModal.querySelectorAll('button[data-think-target]');
    for (var i = 0; i < buttons.length; i += 1) buttons[i].disabled = true;
    setStatus(thinkStatus, target === 'new' ? '正在新建会话并投递…' : '正在投递到当前会话…', '');
    try {
      var data = await callAction({ op: 'think', id: pendingThink.id, ruleNum: pendingThink.ruleNum || '', text: pendingThink.text, target: target });
      setStatus(thinkStatus, data.message || '已投递。', 'ok');
      if (pendingThink.status) setStatus(pendingThink.status, data.message || '已投递。', 'ok');
    } catch (err) {
      setStatus(thinkStatus, '发送失败：' + (err && err.message ? err.message : String(err)), 'err');
    } finally {
      for (var j = 0; j < buttons.length; j += 1) buttons[j].disabled = false;
    }
  });

  // ---- 规则归类：主干 / 情感枝 / 任务枝 ----
  var branchModal = document.getElementById('branch-modal');
  var branchStatus = document.getElementById('branch-status');
  var branchCtx = null;
  function openBranch(id, text) {
    branchCtx = { id: Number(id), text: String(text || '') };
    setStatus(branchStatus, '', '');
    branchModal.hidden = false;
  }
  function closeBranch() {
    branchModal.hidden = true;
    branchCtx = null;
    setStatus(branchStatus, '', '');
  }
  document.getElementById('branch-close').addEventListener('click', closeBranch);
  document.getElementById('branch-cancel').addEventListener('click', closeBranch);
  branchModal.addEventListener('click', function (e) { if (e.target === branchModal) closeBranch(); });
  branchModal.addEventListener('click', async function (e) {
    var btn = e.target.closest ? e.target.closest('[data-branch]') : null;
    if (!btn || !branchCtx) return;
    var kind = btn.getAttribute('data-branch');
    if (kind === 'trunk') {
      var ctx = branchCtx;
      closeBranch();
      openBucketForBranch(ctx);
      return;
    }
    if (kind === 'task') {
      var ctx2 = branchCtx;
      closeBranch();
      openTask(ctx2.id, ctx2.text);
      return;
    }
    var buttons = branchModal.querySelectorAll('button[data-branch]');
    for (var i = 0; i < buttons.length; i += 1) buttons[i].disabled = true;
    setStatus(branchStatus, '正在写入情感枝…', '');
    try {
      var data = await callAction({ op: 'branch-emotion', id: branchCtx.id, text: branchCtx.text });
      setStatus(branchStatus, data.message || '已归入情感枝。', 'ok');
      setTimeout(function () { location.reload(); }, 1200);
    } catch (err) {
      setStatus(branchStatus, '写入失败：' + (err && err.message ? err.message : String(err)), 'err');
    } finally {
      for (var j = 0; j < buttons.length; j += 1) buttons[j].disabled = false;
    }
  });

  // ---- 主干大标题：已有规则改分组 / 归枝时先选 ----
  var bucketModal = document.getElementById('bucket-modal');
  var bucketStatus = document.getElementById('bucket-status');
  var bucketSelect = document.getElementById('bucket-select');
  var bucketNew = document.getElementById('bucket-new');
  var bucketHint = document.getElementById('bucket-hint');
  var bucketTitle = document.getElementById('bucket-title');
  var bucketConfirm = document.getElementById('bucket-confirm');
  var bucketCtx = null;
  function fillBucketSelect(current, allowAuto) {
    bucketSelect.innerHTML = '';
    (BOARD.buckets || []).forEach(function (name) {
      var op = document.createElement('option');
      op.value = name;
      op.textContent = name;
      bucketSelect.appendChild(op);
    });
    if (allowAuto) {
      var autoOpt = document.createElement('option');
      autoOpt.value = '__default';
      autoOpt.textContent = '自动分组（按 § 编号）';
      bucketSelect.appendChild(autoOpt);
    }
    var newOpt = document.createElement('option');
    newOpt.value = '__new';
    newOpt.textContent = '新建大标题…';
    bucketSelect.appendChild(newOpt);
    var hit = false;
    for (var i = 0; i < bucketSelect.options.length; i += 1) {
      if (bucketSelect.options[i].value === current) { bucketSelect.value = current; hit = true; break; }
    }
    if (!hit) bucketSelect.value = (BOARD.buckets && BOARD.buckets[0]) || '__new';
    bucketNew.hidden = bucketSelect.value !== '__new';
    bucketNew.value = '';
  }
  function openBucketForNode(id) {
    var n = NODES[id];
    if (!n) return;
    bucketCtx = { mode: 'node', uid: String(n.uid || '') };
    setStatus(bucketStatus, '', '');
    bucketTitle.textContent = '改大标题 · ' + String(n.uid || '').replace(/^trunk:/, '');
    bucketHint.textContent = '大标题只决定看板「主干」里的折叠分组；不改 AGENTS.md 的 § 编号，也不改规则正文。';
    fillBucketSelect(n.bucketOverride || '__default', true);
    bucketModal.hidden = false;
  }
  function openBucketForBranch(ctx) {
    bucketCtx = { mode: 'branch', id: Number(ctx.id), text: String(ctx.text || '') };
    setStatus(bucketStatus, '', '');
    bucketTitle.textContent = '归入主干 · 先选大标题';
    bucketHint.textContent = '这条规则写入 §1 后会显示在这个大标题下；写入哪个 §1 分组在下一步选。';
    fillBucketSelect('', false);
    bucketModal.hidden = false;
  }
  function closeBucket() {
    bucketModal.hidden = true;
    bucketCtx = null;
    setStatus(bucketStatus, '', '');
  }
  document.getElementById('bucket-close').addEventListener('click', closeBucket);
  document.getElementById('bucket-cancel').addEventListener('click', closeBucket);
  bucketModal.addEventListener('click', function (e) { if (e.target === bucketModal) closeBucket(); });
  bucketSelect.addEventListener('change', function () {
    bucketNew.hidden = bucketSelect.value !== '__new';
    if (!bucketNew.hidden) bucketNew.focus();
  });
  bucketConfirm.addEventListener('click', async function () {
    if (!bucketCtx) return;
    var value = bucketSelect.value;
    var name = value === '__new' ? String(bucketNew.value || '').trim() : value;
    if (value === '__new' && !name) { setStatus(bucketStatus, '请填写新大标题名。', 'err'); return; }
    if (name.length > 24) { setStatus(bucketStatus, '大标题最多 24 个字。', 'err'); return; }
    if (bucketCtx.mode === 'branch') {
      var ctx = bucketCtx;
      closeBucket();
      openTrunk(ctx.id, ctx.text, name);
      return;
    }
    var uid = bucketCtx.uid;
    bucketConfirm.disabled = true;
    setStatus(bucketStatus, '正在保存…', '');
    try {
      var data = await callAction({ op: 'set-trunk-bucket', uid: uid, bucket: value === '__default' ? '__default' : name });
      setStatus(bucketStatus, data.message || '已保存。', 'ok');
      setTimeout(function () { location.reload(); }, 900);
    } catch (err) {
      setStatus(bucketStatus, '保存失败：' + (err && err.message ? err.message : String(err)), 'err');
      bucketConfirm.disabled = false;
    }
  });

  // ---- 任务枝：DSH 推荐 + 手动下拉，请求持久化 ----
  var taskModal = document.getElementById('task-modal');
  var taskStatus = document.getElementById('task-status');
  var taskStatusLine = document.getElementById('task-status-line');
  var taskRecommend = document.getElementById('task-recommend');
  var taskSubject = document.getElementById('task-subject');
  var taskNewSubject = document.getElementById('task-new-subject');
  var taskCtx = null;
  var taskTimer = null;
  function clearTaskTimer() {
    if (taskTimer) { clearTimeout(taskTimer); taskTimer = null; }
  }
  function fillTaskCards(cards) {
    taskSubject.innerHTML = '';
    var empty = document.createElement('option');
    empty.value = '';
    empty.textContent = cards.length ? '（从下面选一张，或新建）' : '（还没有任务卡，新建一张）';
    taskSubject.appendChild(empty);
    (cards || []).forEach(function (c) {
      var op = document.createElement('option');
      op.value = c.subject;
      op.textContent = c.subject + '｜' + (c.title || '（无标题）');
      taskSubject.appendChild(op);
    });
  }
  function closeTask() {
    clearTaskTimer();
    taskModal.hidden = true;
    taskCtx = null;
    setStatus(taskStatus, '', '');
  }
  document.getElementById('task-close').addEventListener('click', closeTask);
  document.getElementById('task-cancel').addEventListener('click', closeTask);
  taskModal.addEventListener('click', function (e) { if (e.target === taskModal) closeTask(); });

  function applyPlacement(data) {
    if (!data || !data.placement || !taskCtx) return;
    if (data.cards) fillTaskCards(data.cards);
    var p = data.placement;
    taskCtx.placementId = p.id;
    try { localStorage.setItem('mt-placement-' + taskCtx.id, p.id); } catch (e) {}
    if (p.status === 'recommended') {
      taskStatusLine.textContent = '已收到 DSH 的归类建议。';
      taskRecommend.hidden = false;
      taskRecommend.innerHTML = '<b>DSH 建议：</b>' + escapeHtml(p.recommendedSubject || '（未填写）') +
        (p.reason ? '　<span class="muted">理由：' + escapeHtml(p.reason) + '</span>' : '');
      if (p.recommendedSubject) {
        var found = false;
        for (var i = 0; i < taskSubject.options.length; i += 1) {
          if (taskSubject.options[i].value === p.recommendedSubject) { found = true; break; }
        }
        if (found) taskSubject.value = p.recommendedSubject;
        else taskNewSubject.value = p.recommendedSubject;
      }
      setStatus(taskStatus, '建议已到，确认后写入；不会自动写。', 'ok');
    } else if (p.status === 'timeout') {
      taskStatusLine.textContent = 'DSH 没有在限定时间内回复。';
      setStatus(taskStatus, '请手动选择或新建任务卡。', 'err');
    } else if (p.status === 'confirmed' || p.status === 'cancelled') {
      taskStatusLine.textContent = '这条请求已经结束（' + p.status + '）。';
    } else {
      taskStatusLine.textContent = 'DSH 正在判断最合适的任务卡…（可以先手动选择，或等建议）';
    }
  }
  function pollTask() {
    if (!taskCtx || !taskCtx.placementId || taskModal.hidden) return;
    callAction({ op: 'placement-get', requestId: taskCtx.placementId }).then(function (data) {
      applyPlacement(data);
      if (data.placement && (data.placement.status === 'pending' || data.placement.status === 'recommended')) {
        taskTimer = setTimeout(pollTask, 2500);
      }
    }).catch(function () {
      taskTimer = setTimeout(pollTask, 3000);
    });
  }
  async function openTask(id, text) {
    taskCtx = { id: Number(id), text: String(text || ''), placementId: null };
    taskNewSubject.value = '';
    taskRecommend.hidden = true;
    taskStatusLine.textContent = '正在请求 DSH 判断…';
    setStatus(taskStatus, '', '');
    taskModal.hidden = false;
    var stored = null;
    try { stored = localStorage.getItem('mt-placement-' + id); } catch (e) {}
    if (stored) {
      try {
        var existing = await callAction({ op: 'placement-get', requestId: stored });
        if (existing.placement && (existing.placement.status === 'pending' || existing.placement.status === 'recommended')) {
          applyPlacement(existing);
          pollTask();
          return;
        }
      } catch (e) {}
    }
    try {
      var data = await callAction({ op: 'placement-create', id: Number(id), text: String(text || '') });
      applyPlacement(data);
      if (data.session && data.session.ok === false) {
        setStatus(taskStatus, 'DSH 会话没连上；请手动选择任务卡。', 'err');
      }
      pollTask();
    } catch (err) {
      setStatus(taskStatus, '请求失败：' + (err && err.message ? err.message : String(err)), 'err');
    }
  }
  document.getElementById('task-confirm').addEventListener('click', async function () {
    if (!taskCtx) return;
    var subject = (taskNewSubject.value || '').trim() || (taskSubject.value || '').trim();
    if (!subject) { setStatus(taskStatus, '先选一张卡，或填写新卡的 subject。', 'err'); return; }
    var btn = this;
    btn.disabled = true;
    setStatus(taskStatus, '正在写入任务枝…', '');
    try {
      var data = await callAction({ op: 'branch-task', id: taskCtx.id, requestId: taskCtx.placementId, subject: subject, text: taskCtx.text });
      setStatus(taskStatus, data.message || '已写入任务枝。', 'ok');
      clearTaskTimer();
      setTimeout(function () { location.reload(); }, 1200);
    } catch (err) {
      setStatus(taskStatus, '写入失败：' + (err && err.message ? err.message : String(err)), 'err');
    } finally {
      btn.disabled = false;
    }
  });

  // ---- 主干：五项检查 + 选择分组 ----
  var trunkModal = document.getElementById('trunk-modal');
  var trunkStatus = document.getElementById('trunk-status');
  var trunkGroup = document.getElementById('trunk-group');
  var trunkNewGroup = document.getElementById('trunk-new-group');
  var trunkConfirm = document.getElementById('trunk-confirm');
  var trunkCtx = null;
  (BOARD.groups || []).forEach(function (g) {
    var op = document.createElement('option');
    op.value = g.key;
    op.textContent = g.key + ' ' + g.title;
    trunkGroup.appendChild(op);
  });
  var newGroupOpt = document.createElement('option');
  newGroupOpt.value = '__new';
  newGroupOpt.textContent = '新建分组…';
  trunkGroup.appendChild(newGroupOpt);
  function trunkChecks() {
    return Array.prototype.slice.call(document.querySelectorAll('#trunk-checks input[type=checkbox]'));
  }
  function refreshTrunkConfirm() {
    var all = trunkChecks().every(function (c) { return c.checked; });
    trunkConfirm.disabled = !all;
    trunkNewGroup.hidden = trunkGroup.value !== '__new';
  }
  trunkChecks().forEach(function (c) { c.addEventListener('change', refreshTrunkConfirm); });
  trunkGroup.addEventListener('change', refreshTrunkConfirm);
  function openTrunk(id, text, bucket) {
    trunkCtx = { id: Number(id), text: String(text || ''), bucket: String(bucket || '') };
    trunkChecks().forEach(function (c) { c.checked = false; });
    trunkNewGroup.value = '';
    trunkGroup.value = (BOARD.groups && BOARD.groups[0] && BOARD.groups[0].key) || '__new';
    refreshTrunkConfirm();
    setStatus(trunkStatus, '', '');
    var bucketLine = document.getElementById('trunk-bucket-line');
    if (bucketLine) {
      bucketLine.hidden = !trunkCtx.bucket;
      bucketLine.textContent = trunkCtx.bucket ? '大标题：' + trunkCtx.bucket + '（写入后显示在该组下）' : '';
    }
    trunkModal.hidden = false;
  }
  function closeTrunk() {
    trunkModal.hidden = true;
    trunkCtx = null;
    setStatus(trunkStatus, '', '');
  }
  document.getElementById('trunk-close').addEventListener('click', closeTrunk);
  document.getElementById('trunk-cancel').addEventListener('click', closeTrunk);
  trunkModal.addEventListener('click', function (e) { if (e.target === trunkModal) closeTrunk(); });
  trunkConfirm.addEventListener('click', async function () {
    if (!trunkCtx) return;
    var checks = trunkChecks().map(function (c) { return !!c.checked; });
    if (checks.some(function (v) { return !v; })) return;
    var group = trunkGroup.value;
    var newTitle = (trunkNewGroup.value || '').trim();
    if (group === '__new' && !newTitle) { setStatus(trunkStatus, '请填写新分组名。', 'err'); return; }
    trunkConfirm.disabled = true;
    setStatus(trunkStatus, '正在备份并写入 AGENTS.md…', '');
    try {
      var data = await callAction({
        op: 'write-trunk-new',
        id: trunkCtx.id,
        text: trunkCtx.text,
        confirm: true,
        checks: checks,
        group: group === '__new' ? '' : group,
        newGroupTitle: group === '__new' ? newTitle : '',
        bucket: trunkCtx.bucket || '',
      });
      setStatus(trunkStatus, data.message || '已写入 AGENTS.md。', 'ok');
      setTimeout(function () { location.reload(); }, 1400);
    } catch (err) {
      setStatus(trunkStatus, '写入失败：' + (err && err.message ? err.message : String(err)), 'err');
      trunkConfirm.disabled = false;
    }
  });

  // ---- 写正本确认框 ----
  var warnModal = document.getElementById('warn-modal');
  var warnStatus = document.getElementById('warn-status');
  var warnTitle = document.getElementById('warn-title');
  var warnThink = document.getElementById('warn-think');
  var warnConfirm = document.getElementById('warn-confirm');
  var pendingWarn = null;
  function openWarn(kind, id, text) {
    var n = NODES[id];
    pendingWarn = { kind: kind, id: id, text: text, num: n && n.virtual ? n.uid : '' };
    var section = kind.indexOf('section') >= 0;
    var del = kind.indexOf('delete') === 0;
    warnTitle.textContent = section
      ? (del ? '删除 AGENTS.md §2–§4 规则' : '修改 AGENTS.md §2–§4 规则')
      : (del ? '删除 AGENTS.md 规则' : '修改 AGENTS.md 规则');
    warnConfirm.textContent = del ? '确认删除' : '确认修改';
    setStatus(warnStatus, '', '');
    warnModal.hidden = false;
  }
  function closeWarn() { warnModal.hidden = true; pendingWarn = null; setStatus(warnStatus, '', ''); }
  document.getElementById('warn-close').addEventListener('click', closeWarn);
  document.getElementById('warn-cancel').addEventListener('click', closeWarn);
  warnModal.addEventListener('click', function (e) { if (e.target === warnModal) closeWarn(); });
  warnThink.addEventListener('click', function () {
    if (!pendingWarn) return;
    openThink({ id: pendingWarn.id, ruleNum: pendingWarn.num || '', text: pendingWarn.text, status: warnStatus });
  });
  warnConfirm.addEventListener('click', async function () {
    if (!pendingWarn) return;
    warnConfirm.disabled = true;
    setStatus(warnStatus, '正在备份并写入 AGENTS.md…', '');
    try {
      var kind = pendingWarn.kind;
      var section = kind.indexOf('section') >= 0;
      var payload = { op: kind, id: pendingWarn.id, confirm: true };
      if (kind === 'write-trunk') payload.text = pendingWarn.text;
      if (section) {
        payload.num = pendingWarn.num;
        payload.text = pendingWarn.text;
      }
      var data = await callAction(payload);
      setStatus(warnStatus, data.message || '已写入。', 'ok');
      var node = NODES[pendingWarn.id];
      if (node && (kind === 'write-trunk' || section)) {
        node.text = pendingWarn.text;
        dPreview.textContent = node.text;
      }
      setTimeout(function () {
        var wasDelete = pendingWarn && (pendingWarn.kind === 'delete-trunk' || pendingWarn.kind === 'delete-section-rule');
        closeWarn();
        if (wasDelete) closeDrawer();
        closeEdit();
        if (section) location.reload();
      }, 900);
    } catch (err) {
      setStatus(warnStatus, '写入失败：' + (err && err.message ? err.message : String(err)), 'err');
    } finally {
      warnConfirm.disabled = false;
    }
  });

  // ---- 添加规则 ----
  var ruleModal = document.getElementById('rule-modal');
  var ruleText = document.getElementById('rule-text');
  var ruleStatus = document.getElementById('rule-status');
  function openRule() { ruleText.value = ''; setStatus(ruleStatus, '', ''); ruleModal.hidden = false; ruleText.focus(); }
  function closeRule() { ruleModal.hidden = true; }
  document.getElementById('add-rule').addEventListener('click', openRule);
  document.getElementById('rule-close').addEventListener('click', closeRule);
  document.getElementById('rule-cancel').addEventListener('click', closeRule);
  ruleModal.addEventListener('click', function (e) { if (e.target === ruleModal) closeRule(); });
  document.getElementById('rule-save').addEventListener('click', async function () {
    var text = (ruleText.value || '').trim();
    if (!text) { setStatus(ruleStatus, '先写一条规则再保存。', 'err'); return; }
    var btn = this;
    btn.disabled = true;
    setStatus(ruleStatus, '正在写入判断叶…', '');
    try {
      var data = await callAction({ op: 'add-rule', text: text });
      setStatus(ruleStatus, data.message || '已写入判断叶。', 'ok');
      setTimeout(function () { location.reload(); }, 1200);
    } catch (err) {
      setStatus(ruleStatus, '保存失败：' + (err && err.message ? err.message : String(err)), 'err');
    } finally {
      btn.disabled = false;
    }
  });

  scrim.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (!warnModal.hidden) closeWarn();
      else if (!helpModal.hidden) closeHelp();
      else if (!ruleModal.hidden) closeRule();
      else if (!editModal.hidden) closeEdit();
      else if (drawer.classList.contains('open')) closeDrawer();
      else if (mapPanel && mapPanel.classList.contains('map-full')) setMapZoom(false);
    }
  });
  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-node]') : null;
    if (el) openNode(el.getAttribute('data-node'));
  });
  document.addEventListener('keydown', function (e) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.getAttribute && e.target.getAttribute('data-node')) {
      e.preventDefault();
      openNode(e.target.getAttribute('data-node'));
    }
  });

  var mapButtons = document.querySelectorAll('[data-filter-layer]');
  var clusters = document.querySelectorAll('.cluster');
  for (var b = 0; b < mapButtons.length; b += 1) {
    mapButtons[b].addEventListener('click', function () {
      var pick = this.getAttribute('data-filter-layer');
      for (var i = 0; i < mapButtons.length; i += 1) mapButtons[i].classList.toggle('on', mapButtons[i] === this);
      for (var c = 0; c < clusters.length; c += 1) {
        clusters[c].classList.toggle('is-muted', pick !== 'all' && clusters[c].getAttribute('data-layer') !== pick);
      }
    });
  }

  var q = document.getElementById('q');
  var hit = document.getElementById('hit-count');
  var ruleGroups = Array.prototype.slice.call(document.querySelectorAll('details.rule-group'));
  var ruleOpen = ruleGroups.map(function (g) { return g.open; });
  function applySearch() {
    var v = (q.value || '').trim().toLowerCase();
    var all = document.querySelectorAll('.searchable');
    var n = 0;
    for (var i = 0; i < all.length; i += 1) {
      var ok = !v || (all[i].textContent || '').toLowerCase().indexOf(v) >= 0;
      all[i].classList.toggle('is-filtered', !ok);
      if (ok) n += 1;
    }
    var stars = document.querySelectorAll('.star');
    for (var s = 0; s < stars.length; s += 1) {
      var node = NODES[stars[s].getAttribute('data-node')] || {};
      var text = ((node.title || '') + ' ' + (node.preview || '') + ' ' + (node.subject || '')).toLowerCase();
      stars[s].classList.toggle('is-dim', !!v && text.indexOf(v) < 0);
    }
    for (var g = 0; g < ruleGroups.length; g += 1) {
      if (!v) {
        ruleGroups[g].classList.remove('is-filtered');
        ruleGroups[g].open = !!ruleOpen[g];
        continue;
      }
      var rows = ruleGroups[g].querySelectorAll('li.searchable');
      var any = false;
      for (var r = 0; r < rows.length; r += 1) {
        if (!rows[r].classList.contains('is-filtered')) { any = true; break; }
      }
      ruleGroups[g].classList.toggle('is-filtered', !any);
      if (any) ruleGroups[g].open = true;
    }
    hit.textContent = v ? n : ${stats.total};
  }
  q.addEventListener('input', applySearch);

  document.querySelectorAll('.star').forEach(function (star, idx) {
    var node = NODES[star.getAttribute('data-node')] || {};
    star.addEventListener('mouseenter', function (e) {
      tip.textContent = node.title || '（无标题）';
      var small = document.createElement('small');
      small.textContent = LABEL[node.layer] || '';
      tip.appendChild(small);
      tip.classList.add('on');
      moveTip(e);
    });
    star.addEventListener('mousemove', moveTip);
    star.addEventListener('mouseleave', function () { tip.classList.remove('on'); });
    star.addEventListener('focus', function () {
      tip.textContent = node.title || '';
      tip.classList.add('on');
    });
    star.addEventListener('blur', function () { tip.classList.remove('on'); });
  });
  function moveTip(e) {
    var x = Math.min(window.innerWidth - 300, e.clientX + 14);
    var y = Math.min(window.innerHeight - 80, e.clientY + 16);
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
  // ---- 待确定写入 / 检索冲突 ----
  var scanModal = document.getElementById('scan-modal');
  var scanBody = document.getElementById('scan-body');
  var scanStatus = document.getElementById('scan-status');
  var scanApply = document.getElementById('scan-apply');
  var scanToken = '';
  function h(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function closeScan() {
    scanModal.hidden = true;
    scanToken = '';
    scanApply.disabled = true;
    setStatus(scanStatus, '', '');
  }
  document.getElementById('scan-close').addEventListener('click', closeScan);
  document.getElementById('scan-cancel').addEventListener('click', closeScan);
  scanModal.addEventListener('click', function (e) { if (e.target === scanModal) closeScan(); });
  function renderScan(data) {
    var conflicts = data.conflicts || [];
    var mapping = data.mapping || [];
    var groups = data.groups || [];
    var refs = data.refLines || [];
    var html = '<div class="scan-summary">' +
      '<span>待写入 <b>' + Number(data.pendingCount || 0) + '</b> 条</span>' +
      '<span>编号影响 <b>' + Number(data.numberChanged ? mapping.filter(function (m) { return m.changed; }).length : 0) + '</b> 条</span>' +
      '<span>引用改动 <b>' + Number(data.refsChanged || 0) + '</b> 处</span>' +
      (data.fileChecksum ? '<span>文件校验 <code>' + h(String(data.fileChecksum).slice(0, 12)) + '</code></span>' : '') +
      '</div>';
    if (conflicts.length) {
      html += '<div class="scan-block"><h4>冲突（' + conflicts.length + '）</h4><div class="scan-conflict">' +
        conflicts.map(function (c) { return '· ' + h(c.message || c.code || c) + (c.detail ? '：' + h(c.detail) : ''); }).join('<br>') +
        '</div></div>';
    } else if (data.error) {
      html += '<div class="scan-block"><h4>未通过</h4><div class="scan-conflict">' + h(data.error) + '</div></div>';
    } else {
      html += '<div class="scan-block"><h4>没有发现编号/引用冲突</h4><p class="muted">正文语义是否和别的规则矛盾，插件查不了；写入前请自己过一眼。</p></div>';
    }
    if (mapping.length) {
      html += '<div class="scan-block"><h4>编号映射</h4><table class="scan-table"><thead><tr><th>原编号</th><th>新编号</th><th>标题</th><th>变化</th></tr></thead><tbody>' +
        mapping.map(function (m) {
          return '<tr><td><code>' + h(m.old) + '</code></td><td><code>' + h(m.new) + '</code></td><td>' + h(m.title || '') + '</td><td>' + (m.changed ? '是' : '否') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    if (groups.length) {
      html += '<div class="scan-block"><h4>写入后的 §1 顺序</h4>' +
        groups.map(function (g) {
          return '<div class="scan-ref"><b>' + h(g.key + ' ' + (g.title || '')) + '</b><br>' +
            (g.items || []).map(function (it) { return '<code>' + h(it.new || it.num || '') + '</code> ' + h(it.title || ''); }).join('<br>') + '</div>';
        }).join('') + '</div>';
    }
    if (refs.length) {
      html += '<div class="scan-block"><h4>全文引用改动（' + refs.length + ' 行）</h4>' +
        refs.map(function (r) {
          return '<div class="scan-ref"><b>第 ' + Number(r.line || 0) + ' 行</b><br><del>' + h(r.before || '') + '</del><br><ins>' + h(r.after || '') + '</ins></div>';
        }).join('') + '</div>';
    }
    scanBody.innerHTML = html;
  }
  async function openScan() {
    scanModal.hidden = false;
    scanBody.innerHTML = '<p class="empty">正在检索…</p>';
    setStatus(scanStatus, '正在扫描编号重排、全文引用和冲突…', '');
    scanApply.disabled = true;
    scanToken = '';
    try {
      var data = await callAction({ op: 'scan-patches' });
      renderScan(data);
      if (data.planToken && !(data.conflicts && data.conflicts.length)) {
        scanToken = data.planToken;
        scanApply.disabled = false;
        setStatus(scanStatus, data.message || '检索完成，确认无误后点「确认写入」。', 'ok');
      } else {
        setStatus(scanStatus, data.error || data.message || '检索到冲突，不能写入。', 'err');
      }
    } catch (err) {
      scanBody.innerHTML = '';
      setStatus(scanStatus, '检索失败：' + (err && err.message ? err.message : String(err)), 'err');
    }
  }
  var patchScanBtn = document.getElementById('patch-scan');
  if (patchScanBtn) patchScanBtn.addEventListener('click', openScan);
  scanApply.addEventListener('click', async function () {
    if (!scanToken) return;
    scanApply.disabled = true;
    setStatus(scanStatus, '正在备份并写入 AGENTS.md…', '');
    try {
      var data = await callAction({ op: 'apply-patches', scanToken: scanToken });
      setStatus(scanStatus, data.message || '已写入 AGENTS.md。', 'ok');
      setTimeout(function () { location.reload(); }, 1500);
    } catch (err) {
      setStatus(scanStatus, '写入失败：' + (err && err.message ? err.message : String(err)), 'err');
      scanApply.disabled = false;
    }
  });
  document.addEventListener('click', async function (e) {
    var del = e.target && e.target.closest ? e.target.closest('[data-patch-del]') : null;
    if (!del) return;
    var pid = del.getAttribute('data-patch-del');
    if (!pid) return;
    if (!window.confirm('从待确定写入删除这条？AGENTS.md 不会改动。')) return;
    del.disabled = true;
    try {
      await callAction({ op: 'delete-patch', id: pid });
      location.reload();
    } catch (err) {
      del.disabled = false;
      window.alert('删除失败：' + (err && err.message ? err.message : String(err)));
    }
  });

  var deepParams = new URLSearchParams(location.search);
  var deepId = Number(deepParams.get('node'));
  if (deepId) setTimeout(function () {
    openNode(deepId);
    if (deepParams.get('edit')) openEdit(deepId);
  }, 60);
})();
</script>
</body></html>`;

  if (opts.audit !== false) store.audit("report", { hits: stats.total, detail: { bytes: estimateTokens(html) } });
  return boostFontSizes(html);
}
