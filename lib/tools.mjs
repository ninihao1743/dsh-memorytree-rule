// lib/tools.mjs — 8 个 memory_* 工具：按需召回、显式写入、日结分拣、维护。
//
// 约定（写给模型看的契约）：
//  - 检索默认覆盖全库（user + 各 workspace）；不用传 scope 也能跨工作区找到任务卡。
//  - 写入必须显式调用；插件不会偷偷记东西（AGENTS.md 的「单一注入源」约束）。
//  - 主干（§1 判据）的正本是 AGENTS.md，这里写 trunk 只会产生「候选」，等主人点头再并入文件。
//  - 遗忘默认归档，hard=true 才物理删除；工具层拒绝无理由的 hard 删除。
import { defineTool } from "@deepseek-ai/dsh-tools";
import { searchMemory } from "./search.mjs";
import { syncTrunk } from "./ingest.mjs";
import { importLegacy } from "./import-legacy.mjs";
import { buildDailyReport, applyDailyDecisions } from "./daily.mjs";
import { buildReportHtml } from "./report.mjs";
import { localDate } from "./diary.mjs";
import { LAYERS } from "./schema.mjs";
import { contentBlocks, estimateTokens, truncate } from "./text.mjs";

const LAYER_LABEL = { trunk: "主干", emotion: "情感枝", task: "任务枝", leaf: "判断叶" };
const LAYER_ORDER = ["trunk", "emotion", "task", "leaf"];

function layerLabel(l) {
  return LAYER_LABEL[l] ?? l;
}

function parseList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v ?? "")
    .split(/[,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function refOf(n) {
  return "#" + n.id;
}

function oneLine(s, max = 160) {
  return truncate(String(s ?? "").replace(/\s+/g, " ").trim(), max);
}

/** 先写临时文件再替换，避免进程中断时把已有备份/报告写成半截。 */
async function writeFileAtomic(file, text) {
  const fs = await import("node:fs");
  const pathMod = await import("node:path");
  const tmp = pathMod.join(
    pathMod.dirname(file),
    "." + pathMod.basename(file) + ".tmp-" + process.pid + "-" + Date.now(),
  );
  try {
    fs.writeFileSync(tmp, text, "utf8");
    try {
      fs.renameSync(tmp, file);
    } catch {
      // Windows 上目标被占用时 rename 会 EPERM，退化为覆盖复制。
      fs.copyFileSync(tmp, file);
    }
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* 临时文件清理失败不影响主结果 */
    }
  }
}

function fmtScore(x) {
  return Number(x).toFixed(2).replace(/^0/, "");
}

// ─────────────────────────────────────────────────────────────────────
// memory_search
// ─────────────────────────────────────────────────────────────────────
const searchTool = {
  name: "memory_search",
  description:
    "按需召回记忆树里的条目（主干规则、情感枝、任务枝卡、判断叶）。混合检索：BM25 关键词 + 字符 n-gram 近似向量，按重要性/信任/衰减加权。任务开始前查一次相关背景；查不到会返回「没有命中」和原因，不会编造。默认搜全库（user + 各 workspace）。",
  parameters: {
    query: { type: "string", required: true, description: "检索词，3-12 个词：主体 + 动作/参数，如「pet-bridge 语音 tts」" },
    scope: { type: "string", enum: ["all", "user", "workspace"], description: "作用域：all=全库（默认），user=只查全局，workspace=只查当前工作区" },
    layers: { type: "string", description: "只查某些枝条，逗号分隔：trunk,emotion,task,leaf；默认全部" },
    limit: { type: "integer", description: "返回条数 1-30，默认 6" },
    mode: { type: "string", enum: ["hybrid", "keyword", "vector"], description: "检索方式，默认 hybrid（关键词+近似向量）" },
    minScore: { type: "number", description: "相关度阈值 0-1，默认按模式自动定；调高更严格" },
    includeArchived: { type: "boolean", description: "连已归档/已取代的旧条目一起看（排查历史口径时用）" },
  },
  output: {
    schema: { type: "json" },
    render(args, v) {
      if (!v || v.ok === false) return "记忆检索失败：" + (v?.error ?? "未知错误");
      const lines = [];
      lines.push(
        "记忆检索「" + v.query + "」：命中 " + v.total + " 条" + (v.returned ? "，显示 " + v.returned : "") +
          "（" + v.mode + "；作用域 " + (v.scope ? v.scope.join("+") : "all") + "；候选 " + v.candidateCount + "）",
      );
      if (v.empty) {
        lines.push(v.reason);
        if (v.topRejected && v.topRejected.length) {
          lines.push("最接近但未过阈值的：" + v.topRejected.map((t) => "#" + t.id + "(" + layerLabel(t.layer) + " " + fmtScore(t.score) + ")").join("、"));
        }
        lines.push("建议：换同义说法再查一次，或直接 memory_write 记下新信息；不要凭猜测补全。");
        return lines.join("\n");
      }
      let n = 0;
      for (const h of v.hits) {
        const flags = [];
        if (h.status !== "active") flags.push(h.status);
        if (h.expired) flags.push("已过期");
        if (h.match.phrase) flags.push("整串命中");
        lines.push(
          ++n + ". [" + layerLabel(h.layer) + "] " + refOf(h) + " " + (h.subject ? h.subject + " · " : "") +
            fmtScore(h.relevance) + (flags.length ? " (" + flags.join(",") + ")" : "") + " — " + oneLine(h.title || h.text, 60),
        );
        lines.push("   " + oneLine(h.snippet, 200));
        if (h.validUntil) lines.push("   有效期至：" + new Date(h.validUntil).toISOString().slice(0, 10));
      }
      if (v.honest) lines.push("（" + v.honest + "）");
      return lines.join("\n");
    },
  },
  timeoutMs: 20000,
  async execute(args, exec) {
    const rt = args.__rt;
    const store = rt.open();
    rt.ensureTrunk(exec);
    const { scopes } = rt.scopesFor(exec, args.scope ?? "all");
    const layers = parseList(args.layers).filter((l) => LAYERS.includes(l));
    const res = searchMemory(store, {
      query: args.query,
      scopes,
      layers: layers.length ? layers : undefined,
      limit: args.limit,
      mode: args.mode,
      threshold: args.minScore,
      status: args.includeArchived === true ? ["active", "candidate", "superseded", "archived"] : ["active", "candidate"],
    });
    return { ok: true, scope: scopes, ...res };
  },
};

// ─────────────────────────────────────────────────────────────────────
// memory_write
// ─────────────────────────────────────────────────────────────────────
const writeTool = {
  name: "memory_write",
  description:
    "往记忆树写一条记忆（唯一正确的新增方式）。layer 选枝条：task=做法/路径/坑的卡片（一个 subject 一张卡，自动替换旧卡），leaf=还没分类的观察（等每日分拣），emotion=相处与关系，trunk=主干规则候选（正本是 AGENTS.md，这里只产生候选）。默认自动脱敏（密钥/邮箱/长数字）；确实要保留原文时传 redact:false。用户说「制定新规则：…」时，按约定写 layer=leaf、tags=新规则、source=chat:rule，进入判断叶等待分拣。",
  parameters: {
    layer: { type: "string", enum: ["trunk", "emotion", "task", "leaf"], required: true, description: "写到哪根枝条" },
    text: { type: "string", required: true, description: "记忆正文（写清楚对象、条件、路径、结论）" },
    subject: { type: "string", description: "主题键：task 卡用插件/脚本名（如 pet-bridge），emotion 可写对象，trunk 可留空" },
    title: { type: "string", description: "一句话标题，便于列表里认出来" },
    tags: { type: "string", description: "标签，逗号分隔，如「语音,踩坑」" },
    scope: { type: "string", enum: ["auto", "user", "workspace"], description: "默认 auto：四枝都进全局（user）；项目私有内容传 workspace" },
    evidence: { type: "string", description: "逐字证据：原话/命令输出/文件行号片段，便于核实" },
    importance: { type: "number", description: "重要性 0-1，默认按枝条给" },
    halfLifeDays: { type: "number", description: "半衰期天数；0=不衰减（长期事实），短期信息填 30/90" },
    validUntil: { type: "string", description: "有效期，ISO 日期（2026-12-31）或毫秒时间戳；过期条目检索会降权" },
    supersedes: { type: "string", description: "要合并/取代的旧条目 id，逗号分隔；旧条目不会被删，只标 superseded" },
    redact: { type: "boolean", description: "默认 true，自动脱敏密钥/邮箱/长数字；传 false 保留原文（敏感信息自行负责）" },
  },
  output: {
    schema: { type: "json" },
    render(args, v) {
      if (!v || v.ok === false) return "写入失败：" + (v?.error ?? "未知错误");
      const n = v.node;
      const lines = [];
      lines.push(
        (v.duplicate ? "已存在（未重复写入）：" : "已写入：") + "[" + layerLabel(n.layer) + "] " + refOf(n) +
          (n.subject ? " " + n.subject : "") + " · " + oneLine(n.title || n.text, 60),
      );
      if (n.status === "candidate") {
        lines.push("状态是 candidate：主干正本是 AGENTS.md，这条要等主人点头才能并入 §1（可用 memory_admin action=report 查看候选）。");
      }
      if (v.redactions && v.redactions.length) lines.push("已自动脱敏：" + v.redactions.join("；") + "（原文未落库）");
      if (v.superseded && v.superseded.length) lines.push("已取代旧条目：" + v.superseded.map((i) => "#" + i).join("、") + "（旧条目保留可追溯）");
      if (v.hint) lines.push(v.hint);
      return lines.join("\n");
    },
  },
  timeoutMs: 20000,
  async execute(args, exec) {
    const rt = args.__rt;
    const store = rt.open();
    rt.ensureTrunk(exec);
    const layer = String(args.layer);
    if (!LAYERS.includes(layer)) return { ok: false, error: "layer 只能是 " + LAYERS.join("/") };
    const requestedScope = args.scope && String(args.scope) !== "auto" ? String(args.scope) : "auto";
    if (!["auto", "user", "workspace"].includes(requestedScope)) {
      return { ok: false, error: "scope 只能是 auto / user / workspace" };
    }
    const scope =
      requestedScope === "auto"
        ? rt.defaultScope(layer, exec)
        : requestedScope === "user"
          ? "user"
          : rt.workspaceOf(exec).scope;
    if (layer === "trunk" && scope !== "user") {
      return { ok: false, error: "主干规则只属于 user 作用域；请用 scope=user 或 auto 写入主干候选。" };
    }
    const tags = parseList(args.tags);
    const input = {
      layer,
      scope,
      text: args.text,
      subject: args.subject,
      title: args.title,
      tags,
      evidence: args.evidence,
      importance: args.importance,
      halfLifeDays: args.halfLifeDays,
      validUntil: args.validUntil,
      source: "manual",
      skipRedact: args.redact === false,
    };
    let hint;
    if (layer === "trunk") hint = "主干候选已入队；并入 AGENTS.md 前不会影响每轮注入（单一注入源不变）。";

    const supersedes = parseList(args.supersedes);
    const tail = { duplicate: false, superseded: [], redactions: [], hint: hint ?? "" };
    let res;
    if (supersedes.length > 0) {
      res = store.supersede(supersedes, { ...input, source: "manual:merge" }, { scopes: rt.scopesFor(exec, "all").scopes });
      if (layer === "task") {
        try { rt.exportCards(); } catch { /* 快照失败不影响写入 */ }
      }
      return { ok: true, node: res.node, ...tail, superseded: res.superseded ?? [] };
    }
    if (layer === "task" && input.subject) {
      const r = store.replaceCard(input.subject, input);
      try { rt.exportCards(); } catch { /* 快照失败不影响写入 */ }
      return { ok: true, node: r.node, ...tail, superseded: r.superseded ?? [] };
    }
    const r = store.add(input);
    if (layer === "task") {
      try { rt.exportCards(); } catch { /* 快照失败不影响写入 */ }
    }
    return { ok: true, node: r.node, ...tail, duplicate: !!r.duplicate, redactions: r.redactions ?? [] };
  },
};

// ─────────────────────────────────────────────────────────────────────
// memory_forget
// ─────────────────────────────────────────────────────────────────────
const forgetTool = {
  name: "memory_forget",
  description:
    "遗忘记忆条目。默认归档（archived，可恢复、不算删除）；只有主人明确要求彻底删除时才传 hard=true，且必须写 reason。分类错误/内容重复优先用 memory_write 的 supersedes 合并，而不是删除。",
  parameters: {
    ids: { type: "string", required: true, description: "条目 id 或 uid，逗号分隔，如「12,13」或「leaf:ab12cd」" },
    hard: { type: "boolean", description: "true=物理删除（不可恢复）。只有主人明确要求时才用" },
    reason: { type: "string", description: "为什么要遗忘/删除，写进审计" },
  },
  output: {
    schema: { type: "json" },
    render(args, v) {
      if (!v || v.ok === false) return "遗忘失败：" + (v?.error ?? "未知错误");
      const parts = v.results.map((r) => (r.ok ? refOf(r) + (r.hard ? " 已物理删除" : " 已归档") : refOf(r) + " 失败：" + r.error));
      return (v.hard ? "已删除：" : "已遗忘（归档）：") + parts.join("；") + (v.hard ? "\n注意：物理删除不可恢复。" : "\n归档条目仍可被 includeArchived 检索到，需要时可恢复。");
    },
  },
  timeoutMs: 20000,
  async execute(args, exec) {
    const rt = args.__rt;
    const store = rt.open();
    const ids = parseList(args.ids);
    if (ids.length === 0) return { ok: false, error: "ids 不能为空" };
    const hard = args.hard === true;
    if (hard && String(args.reason ?? "").trim() === "") {
      return { ok: false, error: "hard=true 必须给出 reason（不可恢复的操作要留痕）" };
    }
    const { scopes } = rt.scopesFor(exec, "all");
    const results = [];
    for (const ref of ids) {
      const n = store.get(ref, { scope: scopes });
      if (!n) {
        results.push({ id: ref, ok: false, error: "找不到这条记忆，或它不在当前作用域" });
        continue;
      }
      try {
        store.forget(n.id, { hard, reason: args.reason ?? "" });
        results.push({ id: n.id, uid: n.uid, ok: true, hard });
      } catch (err) {
        results.push({ id: n.id, ok: false, error: err && err.message ? err.message : String(err) });
      }
    }
    try { rt.exportCards(); } catch { /* 快照失败不影响遗忘 */ }
    return { ok: true, hard, results };
  },
};

// ─────────────────────────────────────────────────────────────────────
// memory_tree
// ─────────────────────────────────────────────────────────────────────
const treeTool = {
  name: "memory_tree",
  description: "看记忆树的整体结构：四枝各自多少条、任务枝有哪些卡、主干候选、过期与待分拣。找东西先 memory_search，想看全貌/盘点再用它。",
  parameters: {
    scope: { type: "string", enum: ["all", "user", "workspace"], description: "默认 all=全库" },
    layer: { type: "string", enum: ["trunk", "emotion", "task", "leaf"], description: "只看一根枝条" },
    limit: { type: "integer", description: "每枝最多列几条，默认 12" },
  },
  output: {
    schema: { type: "json" },
    render(args, v) {
      if (!v || v.ok === false) return "读取失败：" + (v?.error ?? "未知错误");
      const t = v.tree;
      const lines = [];
      const s = t.stats;
      lines.push("记忆树：" + s.total + " 条（active " + (s.byStatus.active ?? 0) + " / candidate " + (s.byStatus.candidate ?? 0) + " / archived " + (s.byStatus.archived ?? 0) + "）｜待分拣叶 " + s.pendingLeaves + "｜主干候选 " + s.candidates + "｜任务卡 " + s.taskCards + "｜过期 " + s.expired);
      lines.push("库：" + v.dbFile + "（" + (s.dbBytes / 1024).toFixed(0) + " KB）；主干文件：" + v.agentsPath + (s.lastSyncAt ? "（上次同步 " + new Date(s.lastSyncAt).toISOString().slice(0, 16).replace("T", " ") + "）" : "（还没同步）"));
      for (const l of t.layers) {
        if (!v.layerFilter || l.layer === v.layerFilter) {
          lines.push("");
          lines.push("§ " + layerLabel(l.layer) + "（" + (l.activeTotal ?? l.active) + " 条 active）");
          if (l.items.length === 0) lines.push("  （空）");
          for (const it of l.items.slice(0, v.limit)) {
            lines.push("  " + refOf(it) + " " + (it.subject ? it.subject + " · " : "") + oneLine(it.title || it.preview, 78) + (it.expired ? " ×过期" : ""));
          }
          const more = Math.max((l.activeTotal ?? l.items.length) - Math.min(v.limit, l.items.length), 0);
          if (more > 0) lines.push("  …还有 " + more + " 条（用 memory_search 或加大 limit 查看）");
        }
      }
      if (t.candidates.length) {
        lines.push("");
        lines.push("主干候选（等主人点头才并入 AGENTS.md）：");
        for (const c of t.candidates.slice(0, 10)) lines.push("  " + refOf(c) + " " + oneLine(c.title || c.text, 90));
      }
      return lines.join("\n");
    },
  },
  timeoutMs: 20000,
  async execute(args, exec) {
    const rt = args.__rt;
    const store = rt.open();
    rt.ensureTrunk(exec);
    const { scopes } = rt.scopesFor(exec, args.scope ?? "all");
    const layer = args.layer && LAYERS.includes(String(args.layer)) ? String(args.layer) : undefined;
    const limit = Math.min(Math.max(Number(args.limit) || 12, 1), 100);
    const tree = store.tree({ scopes });
    return {
      ok: true,
      layerFilter: layer ?? null,
      limit,
      dbFile: rt.paths.dbFile,
      agentsPath: rt.paths.agentsPath,
      tree: layer ? { ...tree, layers: tree.layers.filter((l) => l.layer === layer) } : tree,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────
// memory_card
// ─────────────────────────────────────────────────────────────────────
const cardTool = {
  name: "memory_card",
  description:
    "读一张任务枝卡的完整内容（按 subject 找，或按 id 直接取），可一并看到同主题的相关条目。动手做某个插件/脚本之前先读它的卡，比全文检索更直接。",
  parameters: {
    subject: { type: "string", description: "卡的主题键，如 pet-bridge、restart-dsh" },
    id: { type: "string", description: "也可以直接给条目 id/uid" },
    includeRelated: { type: "boolean", description: "是否附上同 subject 的其他条目（默认 true）" },
    scope: { type: "string", enum: ["all", "user", "workspace"], description: "默认 all=全库" },
  },
  output: {
    schema: { type: "json" },
    render(args, v) {
      if (!v || v.ok === false) return "读取卡片失败：" + (v?.error ?? "未知错误");
      if (!v.card) return "没有找到" + (v.subject ? "「" + v.subject + "」的卡" : "这张卡") + "。" + (v.hint ?? "");
      const c = v.card;
      const lines = [];
      lines.push("[" + layerLabel(c.layer) + "] " + refOf(c) + (c.subject ? " " + c.subject : "") + " · " + (c.title || "（无标题）"));
      lines.push("更新时间：" + new Date(c.updatedAt).toISOString().slice(0, 16).replace("T", " ") + "｜信任 " + c.trust + "｜重要性 " + c.importance + "｜来源 " + c.source);
      if (c.tags.length) lines.push("标签：" + c.tags.join("、"));
      lines.push("");
      lines.push(c.text);
      if (c.evidence) lines.push("", "证据：" + oneLine(c.evidence, 300));
      if (v.related && v.related.length) {
        lines.push("");
        lines.push("同主题的其他条目：");
        for (const r of v.related) lines.push("  " + refOf(r) + " [" + layerLabel(r.layer) + "] " + oneLine(r.title || r.text, 80) + (r.status !== "active" ? " (" + r.status + ")" : ""));
      }
      return lines.join("\n");
    },
  },
  timeoutMs: 20000,
  async execute(args, exec) {
    const rt = args.__rt;
    const store = rt.open();
    rt.ensureTrunk(exec);
    const { scopes } = rt.scopesFor(exec, args.scope ?? "all");
    let card = null;
    if (args.id !== undefined && String(args.id).trim() !== "") {
      card = store.get(String(args.id).trim(), { scope: scopes });
    }
    const subject = String(args.subject ?? "").trim();
    if (!card && subject !== "") {
      const rows = store.list({ scope: scopes, layers: ["task"], status: "active", subject, limit: 2, order: "created" });
      if (rows.length) card = rows[0];
      if (!card) {
        const any = store.list({ scope: scopes, subject, limit: 5, order: "importance" });
        if (any.length) card = any[0];
      }
    }
    if (!card) {
      const subjects = store.list({ scope: scopes, layers: ["task"], status: "active", limit: 200, order: "created" })
        .map((n) => n.subject)
        .filter(Boolean);
      const hint = subjects.length
        ? "任务枝现有的主题键：" + Array.from(new Set(subjects)).slice(0, 40).join("、")
        : "任务枝还没有卡；可用 memory_write layer=task 新建一张，或先用 memory_search 找找。";
      return { ok: true, card: null, subject, hint };
    }
    let related = [];
    if (args.includeRelated !== false) {
      const subj = card.subject;
      related = store.list({ scope: scopes, status: ["active", "candidate", "superseded"], limit: 20, order: "updated" })
        .filter((n) => n.id !== card.id && (subj !== "" ? n.subject === subj : false))
        .slice(0, 8);
    }
    return { ok: true, card, related };
  },
};

// ─────────────────────────────────────────────────────────────────────
// memory_ingest
// ─────────────────────────────────────────────────────────────────────
const ingestTool = {
  name: "memory_ingest",
  description:
    "把外部正本导入成可检索的副本：sync=解析 AGENTS.md 的 §1 主干规则（默认，文件变了才写）；migrate=从旧 Python 版 memories.db 迁记忆条目（幂等）；status=看路径与可迁移状态。不改变 AGENTS.md 本身。",
  parameters: {
    action: { type: "string", enum: ["sync", "migrate", "status"], description: "默认 sync" },
    path: { type: "string", description: "migrate 时可指定旧库路径；默认读 <DSH_HOME>/remembers-data/memories.db" },
    force: { type: "boolean", description: "sync 时强制重建全部主干条目（默认只处理变化的）" },
    dryRun: { type: "boolean", description: "migrate 时默认只预览不落库（true）；主人确认后再传 false 写入" },
  },
  output: {
    schema: { type: "json" },
    render(args, v) {
      if (!v || v.ok === false) return "导入失败：" + (v?.error ?? v?.reason ?? "未知错误");
      if (v.action === "status") {
        return [
          "库：" + v.paths.dbFile,
          "主干正本：" + v.paths.agentsPath + (v.agentsExists ? "" : "（不存在）"),
          "旧库：" + v.paths.legacyDb + (v.legacyExists ? "" : "（不存在，无需迁移）"),
          "条目：" + v.stats.total + "｜索引版本 " + v.stats.indexVersion + "｜上次主干同步 " + (v.stats.lastSyncAt ? new Date(v.stats.lastSyncAt).toISOString().slice(0, 16).replace("T", " ") : "从未"),
        ].join("\n");
      }
      if (v.action === "migrate") {
        return (v.dryRun ? "【预览，未写入】" : "【已写入】") + "迁移 " + v.source + "：读 " + v.total + " 条，新增 " + v.added + "，已存在跳过 " + v.duplicate + "，跳过 " + v.skipped.length +
          "；分布 " + Object.entries(v.byLayer).map(([k, n]) => layerLabel(k) + " " + n).join(" / ") + "。" +
          (v.note ? "\n" + v.note : "");
      }
      if (v.skipped) return "主干未变化，跳过同步（" + v.rules + " 条规则已在库）。";
      return "主干同步：" + v.path + " → " + v.rules + " 条规则（新增 " + v.added + "、更新 " + v.updated + "、未变 " + v.unchanged + "、归档 " + v.archived + "）。";
    },
  },
  timeoutMs: 120000,
  async execute(args, exec) {
    const rt = args.__rt;
    const action = String(args.action ?? "sync");
    if (action === "status") return { ok: true, action, ...rt.info() };
    if (action === "migrate") {
      const store = rt.open();
      const file = args.path && String(args.path).trim() !== "" ? String(args.path) : rt.paths.legacyDb;
      const dryRun = args.dryRun !== false;
      const res = importLegacy(store, file, { scope: "user", dryRun });
      if (!res.ok) return { ok: false, error: res.reason };
      if (!dryRun) {
        try { rt.exportCards(); } catch { /* 快照失败不影响迁移结果 */ }
      }
      return { ok: true, action, dryRun, ...res };
    }
    rt.open();
    const res = rt.ensureTrunk(exec, { force: args.force === true });
    if (!res.ok) return { ok: false, error: res.reason ?? "主干同步失败" };
    return { ok: true, action: "sync", ...res };
  },
};

// ─────────────────────────────────────────────────────────────────────
// memory_daily
// ─────────────────────────────────────────────────────────────────────
const dailyTool = {
  name: "memory_daily",
  description:
    "每日分拣：action=report 生成待分拣判断叶的报告（含聚类、候选主干、过期与陈旧卡提醒），你读完报告后逐条调用 memory_write/memory_forget；action=apply 可一次性提交分拣决定（trunk 只会成为候选）。插件本身不调 LLM、不存 key。",
  parameters: {
    action: { type: "string", enum: ["report", "apply"], description: "默认 report" },
    scope: { type: "string", enum: ["all", "user", "workspace"], description: "默认 all" },
    hours: { type: "integer", description: "回看多少小时内的判断叶，默认 24" },
    limit: { type: "integer", description: "报告里最多列多少条，默认 30" },
    decisions: { type: "string", description: "apply 用：JSON 数组，如 [{\"id\":12,\"to\":\"task\",\"subject\":\"pet-bridge\"},{\"id\":13,\"to\":\"forget\"}]" },
  },
  output: {
    schema: { type: "json" },
    render(args, v) {
      if (!v || v.ok === false) return "分拣失败：" + (v?.error ?? "未知错误");
      if (v.action === "apply") {
        const parts = v.results.map((r) => "#" + r.id + (r.ok ? " → " + (r.to === "forget" ? "遗忘" : layerLabel(r.to)) : " 失败：" + r.error));
        return "分拣完成：" + parts.join("；") + (v.candidates ? "（主干候选 " + v.candidates + " 条等主人点头）" : "");
      }
      const r = v.report;
      const lines = [];
      lines.push("待分拣判断叶：" + r.pendingCount + " 条（回看 " + r.hours + " 小时；作用域 " + r.scopes.join("+") + "）");
      if (r.pendingTruncated) lines.push("另有 " + r.pendingTruncated + " 条在回看窗口内，超过单次展示上限，未列出。");
      if (r.pendingOlderThanWindow) lines.push("更早有 " + r.pendingOlderThanWindow + " 条判断叶不在回看窗口内，可加大 hours 再看。");
      if (r.pendingCount === 0) {
        lines.push("没有新的判断叶。");
      } else {
        for (const it of r.items) {
          lines.push("#" + it.id + " " + new Date(it.updatedAt).toISOString().slice(5, 16).replace("T", " ") + " " + oneLine(it.text, 150) + (it.tags.length ? " [" + it.tags.join(",") + "]" : ""));
        }
      }
      if (r.clusters.length) {
        lines.push("");
        lines.push("可能的聚类（同主题多条，考虑合并成一张卡）：");
        for (const c of r.clusters) lines.push("  " + c.key + "：" + c.ids.map((i) => "#" + i).join("、"));
      }
      if (r.staleCards.length) {
        lines.push("");
        lines.push("超过 " + r.staleDays + " 天没更新的任务卡（确认是否还准确）：" + r.staleCards.map((c) => c.subject + "#" + c.id).join("、"));
      }
      if (r.expired.length) {
        lines.push("");
        lines.push("已过期条目（该续期或归档）：" + r.expired.map((x) => "#" + x.id + " " + oneLine(x.title, 40)).join("、"));
      }
      lines.push("");
      lines.push("分拣做法：逐条判断 → 值得长期保留的用 memory_write（to=task/emotion/trunk）→ 没用的 memory_forget → 也可以把决定写成 decisions 交给 action=apply。trunk 只会成为候选，不动 AGENTS.md。");
      return lines.join("\n");
    },
  },
  timeoutMs: 60000,
  async execute(args, exec) {
    const rt = args.__rt;
    const store = rt.open();
    rt.ensureTrunk(exec);
    const action = String(args.action ?? "report");
    const { scopes } = rt.scopesFor(exec, args.scope ?? "all");
    if (action === "apply") {
      let decisions = [];
      try {
        decisions = typeof args.decisions === "string" ? JSON.parse(args.decisions) : args.decisions;
      } catch (err) {
        return { ok: false, error: "decisions 不是合法 JSON：" + (err && err.message ? err.message : String(err)) };
      }
      if (!Array.isArray(decisions) || decisions.length === 0) return { ok: false, error: "decisions 为空" };
      const res = applyDailyDecisions(store, decisions, { scopes });
      if (res.results.some((r) => r.ok && r.to === "task")) {
        try { rt.exportCards(); } catch { /* 快照失败不影响分拣 */ }
      }
      return { ok: true, action, ...res };
    }
    const report = buildDailyReport(store, {
      scopes,
      hours: Math.min(Math.max(Number(args.hours) || 24, 1), 24 * 30),
      limit: Math.min(Math.max(Number(args.limit) || 30, 1), 100),
    });
    return { ok: true, action: "report", report };
  },
};

// ─────────────────────────────────────────────────────────────────────
// memory_admin
// ─────────────────────────────────────────────────────────────────────
const adminTool = {
  name: "memory_admin",
  description:
    "记忆树维护：doctor=体检（完整性/索引/主干同步/旧库状态），stats=统计，reindex=重建派生索引，export/import=JSONL 备份与恢复（merge=只加新条目，update=同 uid 覆盖），audit=看检索与写入审计，report=生成自包含交互星图看板（四主题/检索/详情抽屉/打印），diary=每日日记索引（op=auto 自动拼装当天库内变动，op=write 手写，op=get/list 读取；自动模式不调 LLM、不覆盖手写），placement=看板“待写入哪条枝”请求（op=get 查看、op=list 列表、op=recommend 回写 DSH 建议、op=cancel 取消）。破坏性操作只有 import 的 update 模式，需要 owner 明确同意。",
  parameters: {
    action: { type: "string", enum: ["doctor", "stats", "reindex", "export", "import", "audit", "report", "diary", "placement"], required: true, description: "维护动作" },
    path: { type: "string", description: "export 的落盘路径 / import 的文件路径" },
    mode: { type: "string", enum: ["merge", "update"], description: "import 模式：merge=只加新条目（默认），update=同 uid 覆盖内容" },
    overwrite: { type: "boolean", description: "export/report 目标文件已存在时是否覆盖，默认 false（防误删旧备份）" },
    limit: { type: "integer", description: "audit/diary list 返回条数，默认 20" },
    op: { type: "string", enum: ["auto", "write", "get", "list"], description: "diary 子动作，默认 auto" },
    date: { type: "string", description: "diary 日期 YYYY-MM-DD，默认今天" },
    text: { type: "string", description: "diary op=write 的正文；按 §2-4 只写索引（做了什么、路径），情感叙事放 emotion 枝" },
    mood: { type: "string", description: "diary 可选标记，默认自动模式为 auto、手写为 manual" },
    force: { type: "boolean", description: "diary op=auto 时覆盖当天手写日记" },
    requestId: { type: "string", description: "placement 请求 id（看板提示里给出的编号）" },
    subject: { type: "string", description: "placement op=recommend 时建议写入的任务卡 subject" },
    title: { type: "string", description: "placement op=recommend 时建议的任务卡标题" },
    reason: { type: "string", description: "placement op=recommend 时的一句话理由" },
  },
  output: {
    schema: { type: "json" },
    render(args, v) {
      if (!v || v.ok === false) return "维护操作失败：" + (v?.error ?? "未知错误");
      switch (v.action) {
        case "doctor":
          return [
            "体检：" + (v.healthy ? "通过" : "有问题"),
            "库：" + v.dbFile + "（" + (v.dbBytes / 1024).toFixed(0) + " KB，完整性 " + v.integrity + "）",
            "条目 " + v.stats.total + "｜索引版本 " + v.stats.indexVersion + "｜缺词项索引 " + v.missingIndex + "｜缺向量 " + v.missingVec,
            "主干：" + (v.agents.ok ? v.agents.rules + " 条规则" + (v.agents.changed ? "（本次已更新）" : "（已是最新）") : "同步失败：" + v.agents.reason),
            v.legacy.exists ? "旧库：" + v.legacy.path + (v.legacy.imported ? "（已迁移）" : "（尚未迁移，可 memory_ingest action=migrate）") : "旧库：不存在",
            v.warnings.length ? "提醒：" + v.warnings.join("；") : "无告警",
          ].join("\n");
        case "stats": {
          const s = v.stats;
          return "共 " + s.total + " 条：" + LAYER_ORDER.map((l) => layerLabel(l) + " " + (s.byLayer[l] ?? 0)).join(" / ") +
            "｜active " + (s.byStatus.active ?? 0) + " / candidate " + (s.byStatus.candidate ?? 0) + " / archived " + (s.byStatus.archived ?? 0) +
            "｜作用域 " + Object.entries(s.byScope).map(([k, n]) => k + ":" + n).join("、") + "｜过期 " + s.expired;
        }
        case "reindex":
          return "已重建派生索引：" + v.nodes + " 条（term/vec 全部重算，索引版本 " + v.indexVersion + "）。";
        case "export":
          return "已导出 " + v.count + " 条记忆" + (v.extras ? "，另含 " + v.extras + " 条日记/大标题记录" : "") + "到 " + v.path + "（" + v.bytes + " 字节；JSONL，可直接用 import 恢复）。";
        case "import":
          return "已从 " + v.path + " 导入：新增 " + v.added + "，更新 " + v.updated + "，跳过 " + v.skipped +
            (v.diary ? "；日记 " + v.diary : "") + (v.buckets ? "；大标题 " + v.buckets : "") + "。";
        case "audit":
          if (v.rows.length === 0) return "还没有审计记录。";
          return v.rows.map((r) => new Date(r.ts).toISOString().slice(5, 16).replace("T", " ") + " " + r.kind + (r.query ? "「" + r.query + "」" : "") + (r.hits === null ? "" : " → " + r.hits + " 条")).join("\n");
        case "report":
          return "已生成星图看板：" + v.path + "（" + (v.bytes / 1024).toFixed(0) + " KB；四枝星座、四主题、检索、详情抽屉、打印）。用浏览器打开即可；数据是生成时的快照。";
        case "diary": {
          if (v.op === "list") {
            if (!v.rows.length) return "还没有日记。";
            return v.rows.map((r) => r.date + "（" + (r.mood === "manual" ? "手写" : "自动") + "）：" + oneLine(r.text, 120)).join("\n");
          }
          if (v.op === "get" && !v.record) return (v.date ?? "该日期") + " 还没有日记。";
          if (v.skipped) return "未覆盖：" + v.reason;
          const r = v.record;
          return "日记 " + r.date + "（" + (r.mood === "manual" ? "手写" : "自动索引") + "，" + r.text.length + " 字）：\n" + r.text;
        }
        case "placement": {
          if (v.op === "list") {
            if (!v.rows.length) return "没有待写入请求。";
            return v.rows.map((p) => p.id + "｜" + (p.status === "pending" ? "待判断" : p.status === "recommended" ? "已推荐 " + p.recommendedSubject : p.status) + "｜" + oneLine(p.text, 80)).join("\n");
          }
          if (v.op === "recommend") return "已回写建议：" + v.placement.recommendedSubject + "（" + (v.placement.reason || "无理由") + "）；等用户在看板确认。";
          if (v.op === "cancel") return "已取消待写入请求 " + v.placement.id + "。";
          if (!v.placement) return "找不到这条待写入请求。";
          return "待写入请求 " + v.placement.id + "：" + v.placement.status + (v.placement.recommendedSubject ? "｜建议 " + v.placement.recommendedSubject : "");
        }
        default:
          return "完成：" + v.action;
      }
    },
  },
  timeoutMs: 60000,
  async execute(args, exec) {
    const rt = args.__rt;
    const store = rt.open();
    const action = String(args.action);
    if (action === "placement") {
      const op = String(args.op ?? "get");
      if (op === "recommend") {
        const requestId = String(args.requestId ?? "").trim();
        if (!requestId) return { ok: false, error: "placement op=recommend 需要 requestId" };
        if (!args.subject || String(args.subject).trim() === "") return { ok: false, error: "placement op=recommend 需要 subject" };
        const placement = store.placementRecommend(requestId, {
          subject: args.subject,
          title: args.title,
          reason: args.reason,
        });
        return { ok: true, action, op, placement };
      }
      if (op === "cancel") {
        const requestId = String(args.requestId ?? "").trim();
        if (!requestId) return { ok: false, error: "placement op=cancel 需要 requestId" };
        return { ok: true, action, op, placement: store.placementSetStatus(requestId, "cancelled") };
      }
      if (op === "list") {
        return { ok: true, action, op, rows: store.placementList({ limit: args.limit }) };
      }
      const requestId = String(args.requestId ?? "").trim();
      if (!requestId) return { ok: false, error: "placement op=get 需要 requestId" };
      return { ok: true, action, op: "get", placement: store.placementGet(requestId) };
    }
    if (action === "diary") {
      const op = String(args.op ?? "auto");
      const date = args.date && String(args.date).trim() !== "" ? String(args.date).trim() : localDate(store.now());
      const paths = rt.paths ?? {};
      if (op === "auto") {
        const res = store.diaryAuto(date, { force: args.force === true, dbFile: paths.dbFile, agentsPath: paths.agentsPath, scopes: rt.scopesFor(exec, "all").scopes });
        return { ok: true, action, op, date, ...res };
      }
      if (op === "write") {
        if (!args.text || String(args.text).trim() === "") return { ok: false, error: "diary op=write 需要 text" };
        const record = store.diaryAdd(date, String(args.text), String(args.mood ?? "manual"));
        return { ok: true, action, op, date, record };
      }
      if (op === "get") {
        return { ok: true, action, op, date, record: store.diaryGet(date) };
      }
      if (op === "list") {
        const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 366);
        return { ok: true, action, op, rows: store.diaryList(limit) };
      }
      return { ok: false, error: "未知 diary op：" + op };
    }
    if (action === "doctor") {
      const integrity = store.db.prepare("PRAGMA integrity_check").get();
      const integrityText = integrity ? String(Object.values(integrity)[0]) : "unknown";
      let agents;
      try {
        agents = rt.ensureTrunk(exec, { force: true });
      } catch (err) {
        agents = { ok: false, reason: err && err.message ? err.message : String(err) };
      }
      const total = store.count({});
      const missingIndex = Number(
        store.db.prepare("SELECT COUNT(*) c FROM node n WHERE NOT EXISTS (SELECT 1 FROM term t WHERE t.node_id=n.id)").get().c,
      );
      const missingVec = Number(
        store.db.prepare("SELECT COUNT(*) c FROM node n WHERE NOT EXISTS (SELECT 1 FROM vec v WHERE v.node_id=n.id)").get().c,
      );
      const warnings = [];
      if (integrityText !== "ok") warnings.push("SQLite 完整性检查返回 " + integrityText);
      if (missingIndex > 0) warnings.push(missingIndex + " 条缺词项索引，可 reindex");
      if (missingVec > 0) warnings.push(missingVec + " 条缺向量，可 reindex");
      if (!agents.ok) warnings.push("主干同步失败：" + (agents.reason || "未知原因"));
      if (total === 0) warnings.push("库里还没有记忆；可先运行 node bin/mt.mjs demo 看四枝示例，或复制 examples/AGENTS.template.md 后 sync");
      const legacyImported = Boolean(
        store.db.prepare("SELECT 1 AS hit FROM node WHERE uid LIKE 'legacy:%' LIMIT 1").get(),
      );
      const agentsOptional = String(agents.reason || "").includes("主干文件不存在");
      return {
        ok: true,
        action,
        healthy: integrityText === "ok" && missingIndex === 0 && missingVec === 0 && (agents.ok || agentsOptional),
        dbFile: rt.paths.dbFile,
        dbBytes: store.stats().dbBytes,
        integrity: integrityText,
        stats: store.stats(),
        missingIndex,
        missingVec,
        agents: agents.ok ? { ok: true, rules: agents.rules, changed: agents.changed === true } : { ok: false, reason: agents.reason, optional: agentsOptional },
        legacy: { exists: rt.info().legacyExists, path: rt.paths.legacyDb, imported: legacyImported },
        warnings,
      };
    }
    if (action === "stats") return { ok: true, action, stats: store.stats() };
    if (action === "reindex") {
      const nodes = store.reindexAll();
      return { ok: true, action, nodes, indexVersion: store.stats().indexVersion };
    }
    if (action === "export") {
      const text = store.exportJsonl();
      const fs = await import("node:fs");
      const pathMod = await import("node:path");
      const dir = rt.paths.exportDir;
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        return { ok: false, error: "创建导出目录失败：" + (err && err.message ? err.message : String(err)) };
      }
      const file = args.path && String(args.path).trim() !== ""
        ? pathMod.resolve(String(args.path))
        : pathMod.join(dir, "memory-tree-" + new Date().toISOString().replace(/[:.]/g, "-") + ".jsonl");
      if (fs.existsSync(file) && args.overwrite !== true) {
        return { ok: false, error: "目标文件已存在，未覆盖：" + file + "。确需覆盖请传 overwrite:true。" };
      }
      try {
        fs.mkdirSync(pathMod.dirname(file), { recursive: true });
        await writeFileAtomic(file, text);
      } catch (err) {
        return { ok: false, error: "导出写入失败：" + (err && err.message ? err.message : String(err)) };
      }
      const lines = text === "" ? [] : text.trimEnd().split("\n");
      let count = 0;
      let extras = 0;
      for (const line of lines) {
        if (line.trim() === "") continue;
        try {
          const obj = JSON.parse(line);
          if (obj && obj._kind) extras += 1;
          else count += 1;
        } catch {
          count += 1;
        }
      }
      return { ok: true, action, path: file, count, extras, bytes: Buffer.byteLength(text, "utf8") };
    }
    if (action === "import") {
      if (!args.path) return { ok: false, error: "import 需要 path（JSONL 文件）" };
      const fs = await import("node:fs");
      const file = String(args.path);
      if (!fs.existsSync(file)) return { ok: false, error: "文件不存在：" + file };
      let stat;
      let text;
      try {
        stat = fs.statSync(file);
        if (stat.size > 50 * 1024 * 1024) return { ok: false, error: "导入文件超过 50 MB，请拆分后再导入。" };
        text = fs.readFileSync(file, "utf8");
      } catch (err) {
        return { ok: false, error: "读取导入文件失败：" + (err && err.message ? err.message : String(err)) };
      }
      try {
        const res = store.importJsonl(text, { mode: args.mode === "update" ? "update" : "merge" });
        try { rt.exportCards(); } catch { /* 快照失败不影响导入结果 */ }
        return { ok: true, action, path: file, ...res };
      } catch (err) {
        return { ok: false, error: "导入失败：" + (err && err.message ? err.message : String(err)) };
      }
    }
    if (action === "audit") {
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
      return { ok: true, action, rows: store.recentAudit(limit), revisions: store.recentRevisions(Math.min(limit, 20)) };
    }
    if (action === "report") {
      // 离线报告不写入看板令牌：HTML 一旦被分享，令牌不能跟着走。
      const html = buildReportHtml(rt, store, exec, {
        board: { base: "", token: "", sessionId: null },
      });
      const fs = await import("node:fs");
      const pathMod = await import("node:path");
      const file = args.path && String(args.path).trim() !== "" ? pathMod.resolve(String(args.path)) : rt.paths.reportFile;
      if (fs.existsSync(file) && args.overwrite !== true) {
        return { ok: false, error: "目标文件已存在，未覆盖：" + file + "。确需覆盖请传 overwrite:true。" };
      }
      try {
        fs.mkdirSync(pathMod.dirname(file), { recursive: true });
        await writeFileAtomic(file, html);
      } catch (err) {
        return { ok: false, error: "报告写入失败：" + (err && err.message ? err.message : String(err)) };
      }
      return { ok: true, action, path: file, bytes: Buffer.byteLength(html, "utf8"), tokens: estimateTokens(html) };
    }
    return { ok: false, error: "未知 action：" + action };
  },
};

export function buildTools(runtime) {
  const specs = [searchTool, writeTool, forgetTool, treeTool, cardTool, ingestTool, dailyTool, adminTool];
  return specs.map((spec) => {
    const rawRender = spec.output.render;
    const wrapped = {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: {
        schema: spec.output.schema,
        // 宿主要求 render 返回内容块数组；内部各 render 仍返回便于阅读的字符串。
        render(args, value) {
          return contentBlocks(rawRender(args, value));
        },
        ...(spec.output.presentationMeta ? { presentationMeta: spec.output.presentationMeta } : {}),
      },
      timeoutMs: spec.timeoutMs,
      async execute(args = {}, exec = {}) {
        // 宿主传进来的 args 可能是冻结对象，不能往上挂字段；复制一份再注入运行时。
        runtime.noteExec(exec);
        const call = { ...args, __rt: runtime };
        return spec.execute(call, exec);
      },
    };
    return defineTool(wrapped);
  });
}

export { syncTrunk };
