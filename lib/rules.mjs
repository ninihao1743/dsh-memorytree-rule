// lib/rules.mjs — 主干规则的编号、重排与引用改写（纯函数）。
//
// 设计边界：
// - 只处理 AGENTS.md 的 §1 主干；§2–§5 不解析、不改号。
// - 改号是「整段 §1 重排」：先摘出被移动的规则，再按目标号升序插入，
//   最后从 1 开始顺序重编号；正文里的 §1-x-y 引用用占位符一次性映射，避免连环错位。
// - 只改正文、不改编号的补丁走最小改动路径（逐条替换规则块），不重排整段。
// - ### 变更记录 是历史记录，引用替换时跳过。
import { checksum } from "./text.mjs";
import { parseAgents } from "./ingest.mjs";

const RULE_NUM_RE = /^§1-(\d+)-(\d+)$/;
const REF_RE = /§1-(\d+)-(\d+)/g;
const CHANGE_LOG_RE = /^###\s+变更记录\s*$/m;

function normalizeEol(s) {
  return String(s ?? "").replace(/\r\n?/g, "\n");
}

/** 把用户输入的编号归一化为 §1-g-n。接受 trunk:§1-1-3 / §1-1-3 / 1-1-3。 */
export function normalizeNumberInput(input) {
  let s = String(input ?? "").trim();
  if (!s) return { ok: false, error: "库内编号不能为空。" };
  s = s.replace(/[\s\u3000]+/g, "").replace(/^trunk:/i, "").replace(/[–—－]/g, "-");
  if (!/^§/.test(s)) s = "§" + s.replace(/^§+/, "");
  const m = /^§1-(\d+)-(\d+)$/.exec(s);
  if (!m) {
    if (/^§[2-5]-/.test(s)) return { ok: false, error: "v1 只支持 §1 主干的编号；§2–§5 暂不支持改号。" };
    return { ok: false, error: "编号格式应为 trunk:§1-1-3（或 §1-1-3）。" };
  }
  const groupNum = Number(m[1]);
  const index = Number(m[2]);
  if (groupNum < 1 || index < 1) return { ok: false, error: "编号必须从 1 开始。" };
  return {
    ok: true,
    num: "§1-" + groupNum + "-" + index,
    group: "§1-" + groupNum,
    groupNum,
    index,
    uid: "trunk:§1-" + groupNum + "-" + index,
  };
}

/** 解析 §1-g-n；不是这个形状就返回 null。 */
export function parseRuleNum(num) {
  const m = RULE_NUM_RE.exec(String(num ?? "").trim());
  if (!m) return null;
  return { groupNum: Number(m[1]), index: Number(m[2]), group: "§1-" + m[1] };
}

/** 排序权重：组号优先，其次组内序号。 */
export function ruleRank(num) {
  const p = parseRuleNum(num);
  return p ? p.groupNum * 1000 + p.index : 999999;
}

/** §1 下的分组标题（### 或 #### §1-x 标题）。 */
export function trunkGroups(raw) {
  const lines = normalizeEol(raw).split("\n");
  const groups = [];
  let cur = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const h = /^(#{2,4})\s+(.+?)\s*$/.exec(line);
    if (h) {
      const level = h[1].length;
      if (cur && level <= cur.level) {
        cur.endLine = i;
        groups.push(cur);
        cur = null;
      }
      if (level === 3 || level === 4) {
        const m = /^§1-(\d+)[\s\u3000]+(.+)$/.exec(h[2].trim());
        if (m) {
          cur = {
            key: "§1-" + m[1],
            num: Number(m[1]),
            title: m[2].trim(),
            level,
            startLine: i + 1,
            endLine: lines.length,
          };
        }
      }
      continue;
    }
    if (cur && /^##\s+§[2-5][\s\u3000]/.test(line)) {
      cur.endLine = i;
      groups.push(cur);
      cur = null;
    }
  }
  if (cur) groups.push(cur);
  return groups;
}

function splitRuleText(text, fallbackTitle) {
  const src = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  const firstBreak = src.indexOf("\n");
  const first = firstBreak >= 0 ? src.slice(0, firstBreak) : src;
  const rest = firstBreak >= 0 ? src.slice(firstBreak + 1) : "";
  const m = /^([^：:]{1,120})[：:]\s*([\s\S]*)$/.exec(first);
  const title = m ? m[1].trim() : String(fallbackTitle || "").trim();
  const bodyFirst = m ? m[2].trim() : first.trim();
  return { title, bodyFirst, rest };
}

/** 生成一条规则块（不含末尾空行）。num 可以是占位符，渲染后再替换。 */
export function buildRuleBlock(num, title, text) {
  const { title: t, bodyFirst, rest } = splitRuleText(text, title);
  const lines = ["- **" + num + "　" + (t || title || "未命名规则") + "**：" + bodyFirst];
  if (rest !== "") {
    for (const line of rest.split("\n")) {
      if (line.trim() === "") {
        lines.push("");
      } else if (/^\s/.test(line)) {
        lines.push(line);
      } else {
        lines.push("  " + line);
      }
    }
  }
  return lines;
}

function findRule(raw, node) {
  const parsed = parseAgents(raw);
  const num = String(node.uid || "").startsWith("trunk:") ? String(node.uid).slice(6) : "";
  return parsed.rules.find((r) => (num && r.num === num) || r.title === node.title) || null;
}

/** 用编辑后的正文替换 AGENTS.md 中对应规则块，返回新全文。 */
export function replaceRuleInAgents(raw, node, newText) {
  const rule = findRule(raw, node);
  if (!rule) return { ok: false, error: "AGENTS.md 里找不到这条规则（可能已被移动或删除），请先同步再试。" };
  const src = normalizeEol(raw);
  const lines = src.split("\n");
  const start = Math.max(0, rule.startLine - 1);
  const end = Math.min(lines.length, rule.endLine);
  const block = buildRuleBlock(rule.num, rule.title, newText);
  const after = lines.slice(end);
  const before = lines.slice(0, start);
  if (after.length && after[0].trim() !== "") after.unshift("");
  return { ok: true, text: before.concat(block, after).join("\n"), rule };
}

/** 从 AGENTS.md 里删除对应规则块，返回新全文。 */
export function removeRuleFromAgents(raw, node) {
  const rule = findRule(raw, node);
  if (!rule) return { ok: false, error: "AGENTS.md 里找不到这条规则（可能已被移动或删除），请先同步再试。" };
  const src = normalizeEol(raw);
  const lines = src.split("\n");
  const start = Math.max(0, rule.startLine - 1);
  let end = Math.min(lines.length, rule.endLine);
  if (end < lines.length && lines[end].trim() === "") end += 1;
  return { ok: true, text: lines.slice(0, start).concat(lines.slice(end)).join("\n"), rule };
}

const SECTION_HEAD_RE = /^##\s+(§[2-4])\s+(.+?)\s*$/;
const SECTION_RULE_RE = /^-\s+\*\*(§[2-4]-\d+)[\s\u3000]+([^*]+?)\*\*\s*[：:]\s*(.*)$/;

/**
 * 解析 AGENTS.md 的 §2–§4 规则（只读；带行号，供看板展示与编辑使用）。
 * 返回 [{ key:"§2", title:"情感枝", rules:[{num,title,text,startLine,endLine}] }]。
 */
export function parseAgentSections(raw) {
  const lines = normalizeEol(raw).split("\n");
  const sections = [];
  let section = null;
  let rule = null;
  const flushRule = (end) => {
    if (!rule) return;
    let e = end;
    while (e > rule.startLine - 1 && lines[e - 1] && lines[e - 1].trim() === "") e -= 1;
    rule.endLine = e;
    rule.text = rule.title + "：" + rule.body.join("\n").trim();
    delete rule.body;
    rule = null;
  };
  const flushSection = (end) => {
    flushRule(end);
    if (section) sections.push(section);
    section = null;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const h = SECTION_HEAD_RE.exec(line);
    if (h) {
      flushSection(i);
      section = { key: h[1], title: h[2].trim(), rules: [] };
      continue;
    }
    if (/^##\s+§[15]\b/.test(line)) {
      flushSection(i);
      continue;
    }
    if (!section) continue;
    const r = SECTION_RULE_RE.exec(line);
    if (r) {
      flushRule(i);
      rule = { num: r[1], title: r[2].trim(), body: [r[3]], startLine: i + 1 };
      section.rules.push(rule);
      continue;
    }
    if (rule && line.trim()) rule.body.push(line.trim());
  }
  flushSection(lines.length);
  return sections;
}

/** 找 §2–§4 的一条规则；不存在返回 null。 */
export function findAgentSectionRule(raw, num) {
  const want = String(num ?? "").trim();
  if (!/^§[2-4]-\d+$/.test(want)) return null;
  for (const sec of parseAgentSections(raw)) {
    const rule = sec.rules.find((r) => r.num === want);
    if (rule) return { ...rule, section: sec.key, sectionTitle: sec.title };
  }
  return null;
}

/** 替换 AGENTS.md 中一条 §2–§4 规则块，返回新全文。 */
export function replaceAgentSectionRule(raw, num, newText) {
  const rule = findAgentSectionRule(raw, num);
  if (!rule) return { ok: false, error: "AGENTS.md 里找不到 " + num + "（可能已被移动或删除），请刷新看板再试。" };
  const src = normalizeEol(raw);
  const lines = src.split("\n");
  const start = Math.max(0, rule.startLine - 1);
  const end = Math.min(lines.length, rule.endLine);
  const block = buildRuleBlock(rule.num, rule.title, newText);
  const before = lines.slice(0, start);
  const after = lines.slice(end);
  if (after.length && after[0].trim() !== "") after.unshift("");
  return { ok: true, text: before.concat(block, after).join("\n"), rule };
}

/** 从 AGENTS.md 删除一条 §2–§4 规则块，返回新全文。 */
export function removeAgentSectionRule(raw, num) {
  const rule = findAgentSectionRule(raw, num);
  if (!rule) return { ok: false, error: "AGENTS.md 里找不到 " + num + "（可能已被移动或删除），请刷新看板再试。" };
  const src = normalizeEol(raw);
  const lines = src.split("\n");
  const start = Math.max(0, rule.startLine - 1);
  const end = Math.min(lines.length, rule.endLine);
  return { ok: true, text: lines.slice(0, start).concat(lines.slice(end)).join("\n"), rule };
}

function collectRefLines(srcLines, refMap) {
  const out = [];
  let inChangeLog = false;
  for (let i = 0; i < srcLines.length; i += 1) {
    const line = srcLines[i];
    if (/^###\s+变更记录\s*$/.test(line)) {
      inChangeLog = true;
      continue;
    }
    if (inChangeLog) continue;
    if (!/§1-\d+-\d+/.test(line)) continue;
    let changed = false;
    const after = line.replace(REF_RE, (m, g, n) => {
      const old = "§1-" + g + "-" + n;
      const next = refMap.get(old);
      if (next && next !== old) {
        changed = true;
        return next;
      }
      return old;
    });
    if (changed) out.push({ line: i + 1, before: line.trim(), after: after.trim() });
    if (out.length >= 200) break;
  }
  return out;
}

function tokenPlan(valid) {
  const items = valid
    .map((p) => [p.uid, p.newNum, checksum(String(p.newText).trim())])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return checksum(JSON.stringify(items));
}

/**
 * 计算待写入补丁的最终结果。
 * @param {string} raw AGENTS.md 全文
 * @param {Array} patches 待写入补丁（pending_patch 行）
 * @returns {{ok:boolean, mode?:string, newText?:string, mapping?:Array, groups?:Array,
 *   refLines?:Array, refsChanged?:number, conflicts?:Array, planToken?:string, fileChecksum?:string}}
 */
export function planRenumber(raw, patches = []) {
  const src = normalizeEol(raw);
  const srcLines = src.split("\n");
  const parsed = parseAgents(src);
  if (!parsed.trunk) return { ok: false, mode: "blocked", error: "AGENTS.md 里没有 §1 主干。", conflicts: [{ code: "no-trunk", message: "AGENTS.md 里没有 §1 主干。" }] };
  const fileChecksum = checksum(src);
  const groups = trunkGroups(src).sort((a, b) => a.num - b.num);
  const groupByKey = new Map(groups.map((g) => [g.key, g]));
  const ruleByNum = new Map(parsed.rules.map((r) => [r.num, r]));
  const conflicts = [];
  const valid = [];
  const seenUid = new Set();

  for (const p of patches) {
    const uid = String(p.uid ?? p.uid ?? "");
    if (!uid) {
      conflicts.push({ code: "bad-patch", message: "有一条待写入记录缺少规则 uid。" });
      continue;
    }
    if (seenUid.has(uid)) {
      conflicts.push({ code: "duplicate-rule", message: "同一规则有多条待写入：" + uid, uid });
      continue;
    }
    seenUid.add(uid);
    const oldNum = String(p.oldNum ?? p.old_num ?? "");
    const rule = ruleByNum.get(oldNum);
    if (!rule) {
      conflicts.push({ code: "missing-rule", message: "AGENTS.md 里找不到 " + (oldNum || uid) + "（可能已被移动或删除）。", uid });
      continue;
    }
    const baseChecksum = String(p.baseChecksum ?? p.base_checksum ?? "");
    if (baseChecksum && baseChecksum !== fileChecksum) {
      conflicts.push({ code: "stale-file", message: oldNum + " 暂存后 AGENTS.md 被改过；请删除这条待写入后重做。", uid });
      continue;
    }
    if (String(rule.text).trim() !== String(p.oldText ?? p.old_text ?? "").trim()) {
      conflicts.push({ code: "stale-text", message: oldNum + " 的正文在暂存后被改过；请删除这条待写入后重做。", uid });
      continue;
    }
    const nn = normalizeNumberInput(p.newNum ?? p.new_num ?? oldNum);
    if (!nn.ok) {
      conflicts.push({ code: "bad-number", message: nn.error, uid });
      continue;
    }
    if (!groupByKey.has(nn.group)) {
      conflicts.push({ code: "missing-group", message: "目标分组 " + nn.group + " 不存在。", uid });
      continue;
    }
    const newText = String(p.newText ?? p.new_text ?? rule.text).trim();
    if (!newText) {
      conflicts.push({ code: "empty-text", message: oldNum + " 的新正文是空的。", uid });
      continue;
    }
    valid.push({
      uid,
      oldNum: rule.num,
      newNum: nn.num,
      groupNum: nn.groupNum,
      index: nn.index,
      moved: nn.num !== rule.num,
      rule,
      newText,
    });
  }

  // 文件里「看起来是 §1 规则但没被解析」的行：宁可拦下，也不能在重排时漏掉/挪错。
  let inTrunk = false;
  const parsedStarts = new Set(parsed.rules.map((r) => r.startLine));
  for (let i = 0; i < srcLines.length; i += 1) {
    const line = srcLines[i];
    if (/^##\s+§1[\s\u3000]/.test(line)) {
      inTrunk = true;
      continue;
    }
    if (/^##\s+§[2-5][\s\u3000]/.test(line)) {
      inTrunk = false;
      continue;
    }
    if (!inTrunk) continue;
    if (/^\s*[-*]\s+\*\*§1-\d+-\d+/.test(line) && !parsedStarts.has(i + 1)) {
      conflicts.push({
        code: "unparsed-rule",
        line: i + 1,
        message: "第 " + (i + 1) + " 行看起来是 §1 规则，但格式没被解析（`**…**` 后应为中文冒号 `：`）。",
      });
    }
  }

  for (const rule of parsed.rules) {
    const p = parseRuleNum(rule.num);
    if (!p) {
      conflicts.push({ code: "bad-rule-num", message: "无法识别的规则编号：" + rule.num, uid: rule.uid });
      continue;
    }
    if (!groupByKey.has("§1-" + p.groupNum)) {
      conflicts.push({ code: "missing-group", message: "规则 " + rule.num + " 没有对应的 #### §1-" + p.groupNum + " 分组标题。", uid: rule.uid });
    }
  }

  // 同一分组里两条移动补丁争同一个目标序号 → 歧义，必须人工改开。
  const targets = new Map();
  for (const p of valid.filter((x) => x.moved)) {
    const key = p.groupNum + ":" + p.index;
    if (targets.has(key)) {
      conflicts.push({ code: "duplicate-target", message: "两条待写入都要进 " + ("§1-" + p.groupNum + "-" + p.index) + "；请改开其中一条的目标号。", uid: p.uid });
    } else {
      targets.set(key, p);
    }
  }

  const planTokenValue = tokenPlan(valid);
  if (conflicts.length) {
    return {
      ok: false,
      mode: "blocked",
      error: conflicts[0].message,
      conflicts,
      fileChecksum,
      planToken: planTokenValue,
      pendingCount: patches.length,
    };
  }

  if (valid.length === 0) {
    return {
      ok: true,
      mode: "none",
      newText: src,
      mapping: [],
      groups: [],
      refLines: [],
      refsChanged: 0,
      numberChanged: false,
      conflicts: [],
      fileChecksum,
      planToken: planTokenValue,
      pendingCount: patches.length,
    };
  }

  const numberChanged = valid.some((p) => p.moved);
  if (!numberChanged) {
    // 只改正文：逐条替换，保留文件其余格式与行距。
    let next = src;
    for (const p of valid) {
      const replaced = replaceRuleInAgents(next, { uid: p.uid, title: p.rule.title }, p.newText);
      if (!replaced.ok) {
        return {
          ok: false,
          mode: "blocked",
          error: replaced.error,
          conflicts: [{ code: "replace-failed", message: replaced.error, uid: p.uid }],
          fileChecksum,
          planToken: planTokenValue,
          pendingCount: patches.length,
        };
      }
      next = replaced.text;
    }
    const mapping = valid.map((p) => {
      const title = splitRuleText(p.newText, p.rule.title).title;
      return { old: p.oldNum, new: p.oldNum, uid: p.uid, title, changed: false };
    });
    return {
      ok: true,
      mode: "content",
      newText: next,
      mapping,
      groups: [],
      refLines: [],
      refsChanged: 0,
      numberChanged: false,
      conflicts: [],
      fileChecksum,
      planToken: planTokenValue,
      pendingCount: patches.length,
    };
  }

  // 有编号变化：整段 §1 重排。
  const movedOldNums = new Set(valid.filter((p) => p.moved).map((p) => p.oldNum));
  const contentByOld = new Map(valid.filter((p) => !p.moved).map((p) => [p.oldNum, p]));
  const byGroup = new Map(groups.map((g) => [g.num, { group: g, base: [], incoming: [] }]));
  for (const rule of parsed.rules) {
    const p = parseRuleNum(rule.num);
    if (!p) continue;
    const bucket = byGroup.get(p.groupNum);
    if (!bucket) continue;
    if (movedOldNums.has(rule.num)) continue;
    const cp = contentByOld.get(rule.num);
    bucket.base.push({ rule, text: cp ? cp.newText : rule.text, patch: cp || null });
  }
  for (const p of valid.filter((x) => x.moved)) {
    const bucket = byGroup.get(p.groupNum);
    if (!bucket) continue;
    bucket.incoming.push(p);
  }

  for (const [groupNum, bucket] of byGroup) {
    const finalCount = bucket.base.length + bucket.incoming.length;
    const used = new Set();
    for (const p of bucket.incoming) {
      if (p.index > finalCount) {
        return {
          ok: false,
          mode: "blocked",
          error: "§1-" + groupNum + "-" + p.index + " 超出目标分组重排后的范围（最多 §1-" + groupNum + "-" + finalCount + "）。",
          conflicts: [{ code: "target-out-of-range", message: "§1-" + groupNum + "-" + p.index + " 超出目标分组重排后的范围（最多 §1-" + groupNum + "-" + finalCount + "）。", uid: p.uid }],
          fileChecksum,
          planToken: planTokenValue,
          pendingCount: patches.length,
        };
      }
      const key = groupNum + ":" + p.index;
      if (used.has(key)) {
        return {
          ok: false,
          mode: "blocked",
          error: "两条待写入都要进 §1-" + groupNum + "-" + p.index + "；请改开其中一条。",
          conflicts: [{ code: "duplicate-target", message: "两条待写入都要进 §1-" + groupNum + "-" + p.index + "；请改开其中一条。", uid: p.uid }],
          fileChecksum,
          planToken: planTokenValue,
          pendingCount: patches.length,
        };
      }
      used.add(key);
    }
  }

  const firstGroup = groups[0];
  const sec2Index = srcLines.findIndex((l) => /^##\s+§2[\s\u3000]/.test(l));
  // 重排会重建 §1 的规则块；分组内若有说明文字/注释，重建时会丢失。宁可拒绝，也不静默删内容。
  if (firstGroup) {
    const known = new Set();
    for (const r of parsed.rules) {
      for (let ln = r.startLine; ln <= r.endLine; ln += 1) known.add(ln);
    }
    for (const g of groups) known.add(g.startLine);
    const endLine = sec2Index >= 0 ? sec2Index : srcLines.length;
    for (let ln = firstGroup.startLine; ln <= endLine; ln += 1) {
      const text = srcLines[ln - 1] ?? "";
      if (text.trim() === "" || known.has(ln)) continue;
      return {
        ok: false,
        mode: "blocked",
        error: "§1 分组内有非规则文字（第 " + ln + " 行），编号重排会丢失它；请先移出该段或只改正文。",
        conflicts: [{ code: "non-rule-text", message: "非规则文字会丢失", line: ln }],
        fileChecksum,
        planToken: planTokenValue,
        pendingCount: patches.length,
      };
    }
  }
  const prefixEnd = firstGroup ? firstGroup.startLine - 1 : sec2Index >= 0 ? sec2Index : srcLines.length;
  const out = srcLines.slice(0, prefixEnd);
  while (out.length && out[out.length - 1].trim() === "") out.pop();

  const tokenMap = new Map();
  let tokenSeq = 0;
  const refMap = new Map();
  const mapping = [];
  const groupPreview = [];

  for (const group of groups) {
    const bucket = byGroup.get(group.num);
    if (!bucket) continue;
    const list = [...bucket.base].sort((a, b) => (parseRuleNum(a.rule.num)?.index ?? 0) - (parseRuleNum(b.rule.num)?.index ?? 0));
    for (const p of [...bucket.incoming].sort((a, b) => a.index - b.index)) {
      list.splice(Math.max(0, p.index - 1), 0, { rule: p.rule, text: p.newText, patch: p });
    }
    const items = [];
    for (let i = 0; i < list.length; i += 1) {
      const entry = list[i];
      const oldNum = entry.patch ? entry.patch.oldNum : entry.rule.num;
      const newNum = "§1-" + group.num + "-" + (i + 1);
      refMap.set(oldNum, newNum);
      const title = splitRuleText(entry.text, entry.rule.title).title;
      mapping.push({ old: oldNum, new: newNum, uid: entry.patch ? entry.patch.uid : entry.rule.uid, title, changed: oldNum !== newNum });
      const token = "@@MTNUM_" + tokenSeq + "@@";
      tokenSeq += 1;
      tokenMap.set(token, newNum);
      items.push({ oldNum, newNum, title, text: entry.text, token, changed: oldNum !== newNum });
    }
    groupPreview.push({
      key: group.key,
      title: group.title,
      items: items.map((x) => ({ old: x.oldNum, new: x.newNum, title: x.title, changed: x.changed })),
    });
    if (out.length && out[out.length - 1].trim() !== "") out.push("");
    const heading = srcLines[group.startLine - 1] || "#### " + group.key + " " + group.title;
    out.push(heading, "");
    for (const item of items) {
      out.push(...buildRuleBlock(item.token, item.title, item.text));
    }
    if (out.length && out[out.length - 1].trim() !== "") out.push("");
  }

  while (out.length && out[out.length - 1].trim() === "") out.pop();
  if (sec2Index >= 0) {
    out.push("");
    out.push(...srcLines.slice(sec2Index));
  } else {
    out.push("");
  }

  let nextText = out.join("\n");

  // 引用一次性映射：规则编号此时还是 @@MTNUM_n@@ 占位符，不会被联动替换误伤；
  // 先映射正文里的旧引用，再把占位符换成新编号。
  let refsChanged = 0;
  const changeMatch = CHANGE_LOG_RE.exec(nextText);
  const changeAt = changeMatch ? changeMatch.index : -1;
  const head = changeAt >= 0 ? nextText.slice(0, changeAt) : nextText;
  const rest = changeAt >= 0 ? nextText.slice(changeAt) : "";
  const remapped = head.replace(REF_RE, (m, g, n) => {
    const oldNum = "§1-" + g + "-" + n;
    const next = refMap.get(oldNum);
    if (next && next !== oldNum) {
      refsChanged += 1;
      return next;
    }
    return oldNum;
  });
  nextText = remapped + rest;
  nextText = nextText.replace(/@@MTNUM_(\d+)@@/g, (m, i) => tokenMap.get("@@MTNUM_" + i + "@@") ?? m);

  const refLines = collectRefLines(srcLines, refMap);
  return {
    ok: true,
    mode: "renumber",
    newText: nextText,
    mapping,
    groups: groupPreview,
    refLines,
    refsChanged,
    numberChanged: true,
    conflicts: [],
    fileChecksum,
    planToken: planTokenValue,
    pendingCount: patches.length,
  };
}

/** 给看板/测试用：把一条规则正文拆成标题与正文。 */
export function ruleTitleOf(text, fallbackTitle) {
  return splitRuleText(text, fallbackTitle).title;
}
