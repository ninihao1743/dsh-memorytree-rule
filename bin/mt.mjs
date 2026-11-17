#!/usr/bin/env node
// bin/mt.mjs — 不进宿主也能用的命令行：排查、迁移、导出、生成看板。
//
// 它和插件共用同一套 lib/（同一个库、同一套检索与分拣逻辑），
// 区别只是没有 agent 上下文：作用域用 --scope 指定，默认 user+当前目录。
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { MemoryRuntime } from "../lib/runtime.mjs";
import { searchMemory } from "../lib/search.mjs";
import { importLegacy } from "../lib/import-legacy.mjs";
import { buildDailyReport, applyDailyDecisions } from "../lib/daily.mjs";
import { buildReportHtml } from "../lib/report.mjs";
import { runDemo } from "../lib/demo.mjs";
import { localDate } from "../lib/diary.mjs";
import { LAYERS, STATUSES } from "../lib/schema.mjs";

class CliError extends Error {}

const SCOPE_NAMES = new Set(["all", "user", "global", "workspace"]);

const HELP = `dsh-memorytree-rule CLI（离线，不联网、不调 LLM）

用法：node bin/mt.mjs <命令> [参数]

常用：
  doctor                         自检：路径、库、主干文件、旧库
  stats                          四枝/状态统计
  sync [--force]                 把 AGENTS.md 的 §1 主干同步成枝条目
  migrate [--apply] [--db 路径]   迁移旧 memories.db（默认只预览）
  search "关键词" [--scope all|user|workspace] [--layer task,trunk] [--limit 8] [--mode keyword|vector|hybrid]
  add --layer task --text "..." [--subject eac] [--title "..."] [--tags a,b] [--scope user|workspace] [--importance 0.7] [--half-life 60] [--valid-until 2027-01-01]
  list [--scope all|user|workspace] [--layer task] [--status active] [--limit 20]
  card --subject eac | --id 12      一张卡 + 相关条目
  tree [--scope all|user|workspace]
  daily [--hours 24] [--limit 30]   待分拣报告（JSON）
  diary [auto|get|list|add] [--date 2026-11-15] [--text "..."] [--mood note] [--force]
                                 日记索引：auto=按库内变动自动拼装（默认），add=手写
  apply --file 决定.json             提交分拣决定（[{id,to,subject,...}]）
  forget --ids 3,4 [--hard] [--reason "..."]   默认归档，--hard 才物理删
  reindex                        重建词表与向量
  export [--out 文件.jsonl]
  import --file 文件.jsonl
  report [--out 文件.html]        自包含 HTML 看板
  demo [--out 文件.html]          生成隔离的四枝示例库与看板，不碰真实记忆

全局：--data-dir <目录> --db <文件> --agents <AGENTS.md> --json
`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function splitList(v) {
  if (v === undefined || v === true || v === "") return [];
  return String(v).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
}

function print(value, asJson = false) {
  if (asJson) {
    process.stdout.write(JSON.stringify(value, null, 2) + "\n");
    return;
  }
  if (typeof value === "string") {
    process.stdout.write(value.endsWith("\n") ? value : value + "\n");
    return;
  }
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function fmtTime(ms) {
  if (!ms) return "-";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function layerLabel(l) {
  return { trunk: "§1 主干", emotion: "§2 情感枝", task: "§3 任务枝", leaf: "§4 判断叶" }[l] ?? l;
}

function makeRuntime(args) {
  const config = { redact: true, autoSync: true };
  if (args["data-dir"]) config.dataDir = String(args["data-dir"]);
  if (args.db) config.dbFile = String(args.db);
  if (args.agents) config.agentsPath = String(args.agents);
  return new MemoryRuntime(config);
}

function resolveScope(rt, requested) {
  const want = String(requested ?? "all");
  if (!SCOPE_NAMES.has(want)) {
    throw new CliError("--scope 只能是 all/user/workspace，收到：" + want);
  }
  return rt.scopesFor(null, want);
}

function pluginVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return String(pkg.version || "unknown");
  } catch {
    return "unknown";
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args._[0] ?? "help";
  const asJson = args.json === true || args.json === "true";

  if (cmd === "help" || args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  // demo 必须走独立临时库：不能先打开真实库，也不能沿用 --data-dir。
  if (cmd === "demo") {
    const res = runDemo({ out: args.out });
    if (asJson) print(res, true);
    else {
      const by = res.stats?.byLayer ?? {};
      const lines = [
        "Memorytree 演示库（隔离，不影响真实记忆）",
        "",
        `临时目录：${res.dir}`,
        `主干文件：${res.agentsPath}`,
        `记忆库：${res.dbFile}`,
        `主干同步：${res.sync.rules ?? 0} 条规则（added ${res.sync.added ?? 0}）`,
        `四枝条目：主干 ${by.trunk ?? 0} / 情感 ${by.emotion ?? 0} / 任务 ${by.task ?? 0} / 判断叶 ${by.leaf ?? 0}`,
        `看板：${res.reportPath}`,
        "",
        "用浏览器打开上面的 HTML 即可；这个目录可以随时删除。",
      ];
      print(lines.join("\n"));
    }
    return res.ok ? 0 : 1;
  }

  // migrate 的 --db 指的是“旧库路径”，不能把它当成当前记忆库打开。
  const runtimeArgs = { ...args };
  if (cmd === "migrate") delete runtimeArgs.db;
  const rt = makeRuntime(runtimeArgs);
  const store = rt.open();

  switch (cmd) {
    case "doctor": {
      const sync = fs.existsSync(rt.paths.agentsPath) ? rt.ensureTrunk(null, { force: true }) : { ok: true, skipped: true, reason: "未找到 AGENTS.md，已跳过主干同步" };
      const info = rt.info();
      const warnings = [];
      const checks = [];
      checks.push({ name: "数据目录", ok: fs.existsSync(rt.paths.dataDir), detail: rt.paths.dataDir });
      checks.push({ name: "记忆库", ok: fs.existsSync(rt.paths.dbFile), detail: rt.paths.dbFile });
      const agentsOk = info.agentsExists === true;
      if (!agentsOk) warnings.push("未找到 AGENTS.md：" + rt.paths.agentsPath + "（可选；创建后可运行 sync）");
      checks.push({ name: "主干文件", ok: true, detail: agentsOk ? rt.paths.agentsPath : "未找到（可选，不影响库）" });
      if (!info.legacyExists) warnings.push("没有旧库 memories.db（正常，全新安装不需要迁移）");
      checks.push({ name: "旧库（可迁移）", ok: true, detail: info.legacyExists ? rt.paths.legacyDb : "不存在（正常）" });
      if (sync.ok !== true) warnings.push("主干同步失败：" + (sync.reason || "未知原因"));
      checks.push({ name: "主干同步", ok: sync.ok === true, detail: sync.ok ? (sync.skipped ? sync.reason : `${sync.rules ?? sync.unchanged ?? 0} 条规则，changed=${sync.changed}`) : sync.reason });
      const st = info.stats;
      const report = {
        version: pluginVersion(),
        node: process.version,
        paths: rt.paths,
        checks,
        warnings,
        stats: st,
        ok: checks.every((c) => c.ok),
      };
      if (asJson) print(report, true);
      else {
        const lines = ["记忆树自检", ""];
        for (const c of checks) lines.push(`${c.ok ? "✔" : "✖"} ${c.name}：${c.detail}`);
        for (const w of warnings) lines.push(`提醒：${w}`);
        lines.push("", `条目：${st.total}（active ${st.byStatus?.active ?? 0} / candidate ${st.byStatus?.candidate ?? 0} / superseded ${st.byStatus?.superseded ?? 0} / archived ${st.byStatus?.archived ?? 0}）`);
        lines.push(`库大小：${(info.dbBytes / 1024).toFixed(1)} KB`);
        print(lines.join("\n"));
      }
      return report.ok ? 0 : 2;
    }

    case "stats": {
      const st = store.stats();
      if (asJson) print(st, true);
      else {
        const lines = [`条目 ${st.total}（${fmtTime(st.newestAt)} 最新）`];
        const byLayer = st.byLayer ?? {};
        for (const l of LAYERS) lines.push(`  ${layerLabel(l)}：${byLayer[l] ?? 0}`);
        const byStatus = st.byStatus ?? {};
        lines.push("状态：" + STATUSES.map((s) => `${s} ${byStatus[s] ?? 0}`).join(" / "));
        lines.push("作用域：" + Object.entries(st.byScope ?? {}).map(([k, v]) => `${k} ${v}`).join(" / "));
        lines.push(`日记：${st.diaryTotal ?? 0} 条` + (st.diaryLastDate ? `（最近 ${st.diaryLastDate}）` : ""));
        print(lines.join("\n"));
      }
      return 0;
    }

    case "sync": {
      const res = rt.ensureTrunk(null, { force: args.force === true });
      print(res, asJson);
      return res.ok ? 0 : 1;
    }

    case "migrate": {
      const legacyFile = args.db ? String(args.db) : rt.paths.legacyDb;
      if (!fs.existsSync(legacyFile)) {
        print({ ok: false, reason: "旧库不存在：" + legacyFile }, asJson);
        return 1;
      }
      const apply = args.apply === true;
      const res = importLegacy(store, legacyFile, { scope: "user", dryRun: !apply });
      if (res.ok && apply) {
        try { rt.exportCards(); } catch { /* 快照失败不影响迁移结果 */ }
      }
      print(res, asJson);
      return res.ok ? 0 : 1;
    }

    case "search": {
      const query = args._[1] ?? args.query;
      if (!query) {
        print({ ok: false, reason: "缺少关键词，例如：mt search \"记忆树\"" }, asJson);
        return 1;
      }
      const sc = resolveScope(rt, args.scope);
      const layers = splitList(args.layer);
      const res = searchMemory(store, {
        query: String(query),
        scopes: sc.scopes,
        layers: layers.length ? layers : undefined,
        limit: Number(args.limit ?? 8),
        mode: String(args.mode ?? "hybrid"),
        status: args["include-archived"] === true ? undefined : ["active", "candidate"],
      });
      if (asJson) print(res, true);
      else if (res.empty) {
        print(`没有命中（${res.reason}）。记忆树里没有与「${query}」匹配的条目——不编造。`);
      } else {
        const lines = [`命中 ${res.hits.length} 条（${res.mode}，作用域 ${sc.scopes.join(" + ")}）`];
        for (const h of res.hits) {
          lines.push("", `#${h.id} [${layerLabel(h.layer)}] ${h.title || h.subject || "(无标题)"} · 分数 ${Number(h.relevance ?? 0).toFixed(3)}${h.expired ? " · 已过期" : ""}`);
          lines.push(`  ${h.snippet || h.text.slice(0, 160)}`);
          lines.push(`  uid ${h.uid}${h.source ? " · 来源 " + h.source : ""}`);
        }
        print(lines.join("\n"));
      }
      return res.empty ? 3 : 0;
    }

    case "add": {
      const layer = String(args.layer ?? "leaf");
      if (!LAYERS.includes(layer)) {
        print({ ok: false, reason: "layer 只能是 " + LAYERS.join("/") }, asJson);
        return 1;
      }
      const text = args.text ?? args._.slice(1).join(" ");
      if (!text) {
        print({ ok: false, reason: "缺少 --text" }, asJson);
        return 1;
      }
      const scopeArg = args.scope === undefined ? null : String(args.scope);
      if (scopeArg !== null && scopeArg !== "user" && scopeArg !== "workspace") {
        print({ ok: false, reason: "scope 只能是 user/workspace：" + scopeArg }, asJson);
        return 1;
      }
      const scope = scopeArg === "user" ? "user" : scopeArg === "workspace" ? rt.workspaceOf(null).scope : rt.defaultScope(layer, null);
      const res = store.add({
        layer,
        scope,
        text: String(text),
        subject: args.subject ? String(args.subject) : null,
        title: args.title ? String(args.title) : null,
        tags: splitList(args.tags),
        evidence: args.evidence ? String(args.evidence) : null,
        importance: args.importance !== undefined ? Number(args.importance) : undefined,
        halfLifeDays: args["half-life"] !== undefined ? Number(args["half-life"]) : undefined,
        validUntil: args["valid-until"] ? Date.parse(String(args["valid-until"])) : null,
      });
      print({ ok: true, duplicate: res.duplicate === true, node: res.node }, asJson);
      return 0;
    }

    case "list": {
      const sc = resolveScope(rt, args.scope);
      const layers = splitList(args.layer);
      const status = splitList(args.status);
      const badLayer = layers.find((x) => !LAYERS.includes(x));
      if (badLayer) {
        print({ ok: false, reason: "未知 layer：" + badLayer + "（可选 " + LAYERS.join("/") + "）" }, asJson);
        return 1;
      }
      const badStatus = status.find((x) => !STATUSES.includes(x));
      if (badStatus) {
        print({ ok: false, reason: "未知 status：" + badStatus + "（可选 " + STATUSES.join("/") + "）" }, asJson);
        return 1;
      }
      const rows = store.list({
        scope: sc.scopes,
        layers: layers.length ? layers : undefined,
        status: status.length ? status : ["active", "candidate"],
        limit: Number(args.limit ?? 20),
        order: args.order ? String(args.order) : "updated",
      });
      if (asJson) print(rows, true);
      else {
        const lines = [`${rows.length} 条（作用域 ${sc.scopes.join(" + ")}）`];
        for (const n of rows) lines.push(`#${n.id} [${layerLabel(n.layer)}/${n.status}] ${n.title || n.subject || ""} · ${n.text.replace(/\s+/g, " ").slice(0, 100)}`);
        print(lines.join("\n"));
      }
      return 0;
    }

    case "card": {
      const sc = resolveScope(rt, args.scope);
      if (args.id) {
        const n = store.get(Number(args.id) || args.id, { scope: sc.scopes });
        if (!n) {
          print({ ok: false, reason: "找不到 #" + args.id + "（或它不在当前作用域）" }, asJson);
          return 1;
        }
        const related = searchMemory(store, { query: n.text.slice(0, 40), scopes: [n.scope], limit: 6, status: ["active", "candidate"] });
        print(asJson ? { node: n, related: related.hits } : formatCard(n, related.hits), asJson);
        return 0;
      }
      const subject = args.subject;
      if (!subject) {
        print({ ok: false, reason: "需要 --subject 或 --id" }, asJson);
        return 1;
      }
      const rows = store.list({ scope: sc.scopes, layers: ["task"], status: ["active", "candidate"], subject: String(subject), limit: 5, order: "updated" });
      const card = rows[0] ?? null;
      print(asJson ? { subject, card } : card ? formatCard(card, []) : `没有「${subject}」的任务卡。`, asJson);
      return card ? 0 : 3;
    }

    case "tree": {
      const sc = resolveScope(rt, args.scope);
      const tree = store.tree({ scopes: sc.scopes });
      if (asJson) print(tree, true);
      else {
        const lines = [`作用域 ${sc.scopes.join(" + ")}`];
        for (const bucket of tree.layers ?? []) {
          lines.push("", `${layerLabel(bucket.layer)}（active ${bucket.active}）`);
          for (const n of bucket.items.slice(0, Number(args.limit ?? 12))) lines.push(`  #${n.id} ${n.title || n.subject || ""} · ${n.preview.slice(0, 80)}`);
        }
        if (tree.candidates?.length) {
          lines.push("", `主干候选（${tree.candidates.length}）`);
          for (const c of tree.candidates.slice(0, Number(args.limit ?? 12))) lines.push(`  #${c.id} ${c.title} ← ${c.source}`);
        }
        print(lines.join("\n"));
      }
      return 0;
    }

    case "daily": {
      const sc = resolveScope(rt, args.scope);
      const rep = buildDailyReport(store, { scopes: sc.scopes, hours: Number(args.hours ?? 24), limit: Number(args.limit ?? 30) });
      if (asJson) print(rep, true);
      else {
        const lines = [`待分拣 ${rep.pendingCount} 条（最近 ${rep.hours} 小时；更早未分拣 ${rep.pendingOlderThanWindow} 条）`];
        for (const it of rep.items) lines.push(`#${it.id} ${it.text.slice(0, 120)}${it.tags.length ? " · " + it.tags.join(",") : ""}`);
        if (rep.clusters.length) lines.push("", "聚类：" + rep.clusters.map((c) => `${c.key}(${c.ids.length})`).join(" "));
        if (rep.staleCards.length) lines.push("", "陈旧任务卡：" + rep.staleCards.map((c) => `${c.subject}(${c.days}天)`).join(" "));
        if (rep.expired.length) lines.push("过期：" + rep.expired.map((e) => `#${e.id} ${e.title}`).join(" "));
        print(lines.join("\n"));
      }
      return 0;
    }

    case "apply": {
      if (!args.file) {
        print({ ok: false, reason: "需要 --file 决定.json" }, asJson);
        return 1;
      }
      let decisions;
      try {
        decisions = JSON.parse(fs.readFileSync(String(args.file), "utf8"));
      } catch (err) {
        print({ ok: false, reason: "读取或解析决定文件失败：" + (err?.message ?? String(err)) }, asJson);
        return 1;
      }
      const list = Array.isArray(decisions) ? decisions : decisions.decisions;
      if (!Array.isArray(list)) {
        print({ ok: false, reason: "文件里需要数组，或 {decisions:[...]}" }, asJson);
        return 1;
      }
      const sc = resolveScope(rt, args.scope);
      const applied = applyDailyDecisions(store, list, { scopes: sc.scopes });
      if (applied.applied > 0) {
        try { rt.exportCards(); } catch { /* 快照失败不影响分拣结果 */ }
      }
      print(applied, asJson);
      return 0;
    }

    case "forget": {
      const ids = splitList(args.ids).map(Number).filter(Number.isFinite);
      if (!ids.length) {
        print({ ok: false, reason: "需要 --ids 1,2,3" }, asJson);
        return 1;
      }
      const res = ids.map((id) => {
        try {
          return { id, ok: true, ...store.forget(id, { hard: args.hard === true, reason: String(args.reason ?? "cli forget") }) };
        } catch (err) {
          return { id, ok: false, error: err?.message ?? String(err) };
        }
      });
      print({ ok: res.every((r) => r.ok), results: res }, asJson);
      return res.every((r) => r.ok) ? 0 : 1;
    }

    case "reindex": {
      print(store.reindexAll(), asJson);
      return 0;
    }

    case "export": {
      const text = store.exportJsonl();
      const out = args.out ? String(args.out) : path.join(rt.paths.exportDir, `memory-${Date.now()}.jsonl`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, text, "utf8");
      print({ ok: true, out, bytes: Buffer.byteLength(text) }, asJson);
      return 0;
    }

    case "import": {
      if (!args.file) {
        print({ ok: false, reason: "需要 --file 文件.jsonl" }, asJson);
        return 1;
      }
      const file = String(args.file);
      const size = fs.statSync(file).size;
      if (size > 50 * 1024 * 1024) {
        print({ ok: false, reason: "导入文件超过 50 MB 上限：" + size + " 字节" }, asJson);
        return 1;
      }
      const res = store.importJsonl(fs.readFileSync(file, "utf8"));
      print(res, asJson);
      return 0;
    }

    case "diary": {
      const op = args._[1] ?? "auto";
      const date = args.date ? String(args.date) : localDate(store.now());
      if (op === "auto") {
        const res = store.diaryAuto(date, { force: args.force === true, dbFile: rt.paths.dbFile, agentsPath: rt.paths.agentsPath, scopes: resolveScope(rt, args.scope).scopes });
        if (asJson) print({ ok: true, op, date, ...res }, true);
        else if (res.skipped) print(`未覆盖 ${date}：${res.reason}`);
        else print(res.record.text);
        return res.skipped ? 0 : 0;
      }
      if (op === "add" || op === "write") {
        if (!args.text) {
          print({ ok: false, reason: "需要 --text \"日记正文\"" }, asJson);
          return 1;
        }
        const rec = store.diaryAdd(date, String(args.text), String(args.mood ?? "manual"));
        print(asJson ? { ok: true, op: "add", record: rec } : `已写入 ${rec.date} 日记（${rec.text.length} 字）`, asJson);
        return 0;
      }
      if (op === "get") {
        const rec = store.diaryGet(date);
        print(asJson ? { ok: true, op, date, record: rec } : rec ? rec.text : `${date} 还没有日记。`, asJson);
        return 0;
      }
      if (op === "list") {
        const rows = store.diaryList(Number(args.limit) || 30);
        if (asJson) print({ ok: true, op, rows }, true);
        else if (!rows.length) print("还没有日记。");
        else print(rows.map((r) => `${r.date}（${r.mood === "manual" ? "手写" : "自动"}）\n${r.text}`).join("\n\n"));
        return 0;
      }
      print({ ok: false, reason: "未知 diary 子命令：" + op + "（auto|get|list|add）" }, asJson);
      return 1;
    }

    case "report": {
      const html = buildReportHtml(rt, store, null);
      const out = args.out ? String(args.out) : rt.paths.reportFile;
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, html, "utf8");
      print({ ok: true, out, bytes: Buffer.byteLength(html) }, asJson);
      return 0;
    }

    default:
      print({ ok: false, reason: "未知命令：" + cmd + "（mt help 看用法）" }, asJson);
      return 1;
  }
}

function formatCard(n, related) {
  const lines = [
    `#${n.id} [${layerLabel(n.layer)}/${n.status}] ${n.title || n.subject || ""}`,
    `作用域 ${n.scope} · uid ${n.uid}`,
    n.subject ? `卡片 ${n.subject}` : "",
    n.source ? `来源 ${n.source}` : "",
    "",
    n.text,
  ].filter((x) => x !== "");
  if (related && related.length) {
    lines.push("", "相关：");
    for (const h of related) lines.push(`  #${h.id} ${layerLabel(h.layer)} · ${h.text.replace(/\s+/g, " ").slice(0, 80)}`);
  }
  return lines.join("\n");
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    const text = err instanceof CliError ? err.message : err && err.stack ? err.stack : String(err);
    process.stderr.write(text + "\n");
    process.exit(1);
  });
