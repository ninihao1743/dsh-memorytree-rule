// lib/ingest.mjs — 把 AGENTS.md（主干正本）解析成 trunk 枝条目。
//
// 原则：
//  - 文件永远是正本；插件只做「可检索的索引副本」，每条都带 source=AGENTS.md#Lx-Ly 与逐字证据。
//  - 文件里删掉/改写的规则：改写→原位更新（uid 不变，保留引用）；删除→归档（不硬删）。
//  - 这里只解析 §1 主干（其他枝的内容属于 memories.db 的职责，不是文件里的规则）。
import fs from "node:fs";
import { checksum, truncate } from "./text.mjs";
import { setMeta, getMeta, bumpIndexVersion, tx } from "./db.mjs";

const RULE_RE = /^\s*[-*]\s+\*\*(§[\d\-–]+)[\s\u3000]+([^*]+?)\*\*\s*[：:；]\s*(.*)$/;
const HEADING_RE = /^(#{2,4})\s+(.+?)\s*$/;

/**
 * 纯函数解析，方便单测。
 * @returns {{trunk:string, rules:Array<{uid:string,num:string,title:string,text:string,section:string,group:string,startLine:number,endLine:number}>, headings:string[]}}
 */
export function parseAgents(text) {
  const src = String(text ?? "").replace(/\r\n?/g, "\n");
  const lines = src.split("\n");
  const rules = [];
  const unparsed = [];
  const stack = []; // {level, title}
  let trunkTitle = null;
  let trunkName = null;
  let trunkFound = false;
  let cur = null;

  const headingPath = () => stack.map((s) => s.title).filter(Boolean).join(" / ");
  const groupOf = () => {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const t = stack[i].title;
      if (/^§1-\d+/.test(t)) return t.replace(/^§[\d\-–]+\s*/, "").trim();
    }
    const h1 = stack.find((s) => /^§1[\s\u3000]/.test(s.title));
    return h1 ? h1.title.replace(/^§1[\s\u3000]*/, "").replace(/（.*$/, "").trim() : "主干";
  };

  const flush = () => {
    if (!cur) return;
    const body = cur.lines.join("\n").trim();
    if (body.length > 0) {
      rules.push({
        uid: "trunk:" + cur.num,
        num: cur.num,
        title: cur.title,
        text: cur.title + "：" + body,
        section: cur.section,
        group: cur.group,
        startLine: cur.startLine,
        endLine: cur.endLine,
      });
    } else {
      unparsed.push({ line: cur.startLine, text: "规则正文为空：" + cur.title });
    }
    cur = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const h = HEADING_RE.exec(line);
    if (h) {
      flush();
      const level = h[1].length;
      const title = h[2].trim();
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title });
      if (level === 2 && /^§1[\s\u3000]/.test(title)) {
        trunkTitle = title;
        trunkName = title;
        trunkFound = true;
      }
      if (level === 2 && /^§[2-5][\s\u3000]/.test(title)) trunkTitle = null;
      continue;
    }
    // 只收 §1 下的规则
    if (!trunkTitle) {
      if (cur) flush();
      continue;
    }
    const m = RULE_RE.exec(line);
    if (m) {
      if (!/^§1-/.test(m[1].replace(/[–]/g, "-"))) {
        unparsed.push({ line: i + 1, text: "§1 下出现了非 §1 编号：" + line.trim().slice(0, 160) });
        if (cur) flush();
        continue;
      }
      flush();
      cur = {
        num: m[1].replace(/[–]/g, "-"),
        title: m[2].trim(),
        lines: [m[3].trim()],
        startLine: i + 1,
        endLine: i + 1,
        section: headingPath(),
        group: groupOf(),
      };
      continue;
    }
    // 形似 §1 规则但格式没解析出来：记下来让同步拒绝，避免它被当成「文件里已删除」而归档。
    if (/^\s*[-*]\s+\*\*\s*§1-\d+/.test(line)) {
      unparsed.push({ line: i + 1, text: line.trim().slice(0, 160) });
      continue;
    }
    if (cur) {
      if (line.trim() === "") {
        cur.lines.push("");
        cur.endLine = i + 1;
        continue;
      }
      // 顶格的新列表/普通段落＝规则结束；缩进或嵌套列表属于本条规则
      if (/^\S/.test(line) && !/^\s/.test(line)) {
        flush();
        continue;
      }
      cur.lines.push(line);
      cur.endLine = i + 1;
    }
  }
  flush();
  return { trunk: trunkFound ? trunkName || "§1 主干" : null, rules, unparsed, headings: stack.map((s) => s.title) };
}

/** 把解析结果同步进库，返回变更统计。 */
export function syncTrunk(store, agentsPath, opts = {}) {
  let raw;
  try {
    raw = fs.readFileSync(agentsPath, "utf8");
  } catch (err) {
    return { ok: false, reason: "读不到主干文件：" + (err && err.message ? err.message : String(err)), path: agentsPath };
  }
  const parsed = parseAgents(raw);
  if (!parsed.trunk) {
    return { ok: false, reason: "文件里没有找到 §1 主干章节，未同步（避免把别的文件内容当规则）", path: agentsPath, ruleCount: parsed.rules.length };
  }
  if (parsed.unparsed && parsed.unparsed.length > 0) {
    const first = parsed.unparsed[0];
    return {
      ok: false,
      reason: "AGENTS.md 第 " + first.line + " 行像 §1 规则但格式无法解析（" + first.text + "），已拒绝同步；" +
        "格式应为 `- **§1-x-x　标题**：正文`。",
      path: agentsPath,
      ruleCount: parsed.rules.length,
      unparsed: parsed.unparsed.slice(0, 10),
    };
  }
  const fileChecksum = checksum(raw);
  const prevChecksum = getMeta(store.db, "agents_checksum", null);
  if (parsed.rules.length === 0 && opts.allowEmpty !== true) {
    // 文件格式全坏 / §1 被清空时，继续同步会把库里所有 active 主干规则静默归档。
    // 只有显式 allowEmpty 才允许这么做（目前没有调用方传）。
    return {
      ok: false,
      reason: prevChecksum
        ? "AGENTS.md 里解析到 0 条 §1 规则，已拒绝同步以保护现有主干索引；请检查文件格式。"
        : "§1 主干下没有解析到规则条目（格式应为 `- **§1-x-x　标题**：正文`）",
      path: agentsPath,
      ruleCount: 0,
    };
  }

  const scope = opts.scope ?? "user";
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let restored = 0;
  const seen = new Set();
  let archived = 0;

  const seenUids = new Set();
  for (const r of parsed.rules) {
    if (seenUids.has(r.uid)) {
      return { ok: false, path: agentsPath, checksum: fileChecksum, rules: parsed.rules.length, error: "AGENTS.md 里编号重复：" + r.uid };
    }
    seenUids.add(r.uid);
  }

  tx(store.db, () => {
    for (const r of parsed.rules) {
    seen.add(r.uid);
    const existing = store.get(r.uid);
    if (existing && (existing.layer !== "trunk" || existing.scope !== scope)) {
      throw new Error("编号 " + r.uid + " 已被非主干条目占用，拒绝同步");
    }
    const source = "AGENTS.md#L" + r.startLine + "-L" + r.endLine;
    const tags = ["主干", r.group];
    if (existing) {
      if (existing.checksum === checksum(r.text)) {
        unchanged += 1;
        // 文件里仍在的规则就是 active；如果副本被归档/取代，按文件恢复，
        // 避免「看板显示已归档、DSH 每轮还在执行这条规则」的不一致。
        if (existing.status !== "active") {
          store.db
            .prepare("UPDATE node SET status='active', superseded_by=NULL, updated_at=? WHERE id=?")
            .run(store.now(), existing.id);
          store.revision("trunk:restored", existing.id, existing.uid, { source });
          bumpIndexVersion(store.db);
          restored += 1;
        }
        // 行号可能变了，顺手修正 source（不产生新版本）
        if (existing.source !== source || existing.subject !== r.group) {
          store.db.prepare("UPDATE node SET source=?, subject=?, updated_at=? WHERE id=?").run(source, r.group, store.now(), existing.id);
        }
        continue;
      }
      store.update(
        existing.id,
        {
          text: r.text,
          title: truncate(r.title, 80),
          subject: r.group,
          tags,
          source,
          evidence: r.text,
          status: "active",
          importance: 0.9,
          trust: 100,
        },
        { allowActiveTrunk: true, skipRedact: true },
      );
      updated += 1;
      continue;
    }
    store.add({
      uid: r.uid,
      scope,
      layer: "trunk",
      kind: "rule",
      status: "active",
      subject: r.group,
      title: truncate(r.title, 80),
      text: r.text,
      tags,
      source,
      evidence: r.text,
      importance: 0.9,
      trust: 100,
      halfLifeDays: 0,
      skipRedact: true,
    });
    added += 1;
  }

  // 文件里已不存在的旧规则 → 归档（不硬删，保留可追溯）
  const stale = store.db.prepare("SELECT id,uid,source FROM node WHERE layer='trunk' AND status='active' AND scope=?").all(scope);
  for (const n of stale) {
    if (!String(n.source || "").startsWith("AGENTS.md")) continue;
    if (seen.has(n.uid)) continue;
    store.db.prepare("UPDATE node SET status='archived', updated_at=? WHERE id=?").run(store.now(), n.id);
    store.db.prepare("DELETE FROM trunk_bucket WHERE uid=?").run(n.uid);
    store.revision("trunk:removed", n.id, n.uid, { source: n.source });
    archived += 1;
  }

  setMeta(store.db, "agents_checksum", fileChecksum);
  setMeta(store.db, "agents_sync_at", String(store.now()));
  setMeta(store.db, "agents_path", agentsPath);
  setMeta(store.db, "agents_rules", String(parsed.rules.length));
  store.audit("ingest", {
    scope,
    query: agentsPath,
    hits: parsed.rules.length,
    detail: { added, updated, unchanged, restored, archived, changed: prevChecksum !== fileChecksum },
  });
  });
  return {
    ok: true,
    path: agentsPath,
    checksum: fileChecksum,
    changed: prevChecksum !== fileChecksum,
    rules: parsed.rules.length,
    added,
    updated,
    unchanged,
    restored,
    archived,
    groups: Array.from(new Set(parsed.rules.map((r) => r.group))),
  };
}
