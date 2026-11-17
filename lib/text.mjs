// lib/text.mjs — 归一化、分词、脱敏、摘要、校验和。
//
// 为什么不用 jieba/FTS5：
// - 依赖越少越能独立安装；FTS5 的 unicode61 不切中文（整段当一个词），trigram 又不支持 2 字查询。
// - 中文用「字 + 字二元组（bigram）」在小语料上召回稳定，2 个字也能查（"备份" → b:备份）。
// - 英文/路径用 ASCII 词；权重：词 1.0、bigram 1.0、单字 0.3（单字只做弱匹配，避免噪声）。
import { createHash } from "node:crypto";

const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const SINGLE_CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const ASCII_WORD = /[a-z0-9][a-z0-9_.\-]{1,}/g;

// 高频虚词：单字直接丢；bigram 两侧都是虚词才丢（"备份"里的"份"不是虚词，不受影响）。
const STOP_ZH = new Set(
  "的了是在和与就都也而及或我你他她它这那个们有不上下中为以到由把被让从对于之其并很更最会可要说用做能还没好又再只吗呢吧啊哦嗯".split(""),
);
const STOP_EN = new Set([
  "the", "and", "for", "with", "that", "this", "from", "are", "was", "were", "has", "have", "had",
  "not", "but", "you", "your", "they", "them", "will", "can", "all", "any", "our", "out", "its",
  "of", "to", "in", "on", "at", "by", "as", "is", "be", "or", "if", "we", "he", "she", "do", "does",
  "did", "so", "no", "up", "my", "me", "his", "her", "it", "an", "a", "i",
]);

export function normalize(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .replace(/\u200b|\u200c|\u200d|\ufeff/g, "")
    .replace(/\r\n?/g, "\n")
    .toLowerCase();
}

function bump(map, key, w) {
  map.set(key, (map.get(key) ?? 0) + w);
}

/**
 * 分词：返回 Map<term, weight>。
 * term 前缀 w:（ASCII 词）/ b:（中文 bigram）/ u:（中文单字）。
 */
export function tokenize(text) {
  const out = new Map();
  const s = normalize(text);
  if (s === "") return out;
  for (const m of s.matchAll(ASCII_WORD)) {
    const raw = m[0].replace(/[._\-]+$/, "");
    if (raw.length < 2 || STOP_EN.has(raw)) continue;
    bump(out, "w:" + raw, 1);
    // 形如 restart_dsh.ps1 的复合串再拆一次，方便按 restart 查到
    const parts = raw.split(/[._\-]+/).filter((x) => x.length >= 2 && !STOP_EN.has(x));
    if (parts.length > 1) for (const p of parts) bump(out, "w:" + p, 0.8);
  }
  for (const m of s.matchAll(CJK_RUN)) {
    const run = m[0];
    for (let i = 0; i < run.length; i++) {
      if (!STOP_ZH.has(run[i])) bump(out, "u:" + run[i], 0.3);
    }
    for (let i = 0; i + 1 < run.length; i++) {
      const bg = run.slice(i, i + 2);
      if (STOP_ZH.has(bg[0]) && STOP_ZH.has(bg[1])) continue;
      bump(out, "b:" + bg, 1);
    }
  }
  return out;
}

/** 查询词里的「可读片段」：用于高亮/片段窗口，不含前缀。 */
export function queryFragments(query) {
  const s = normalize(query).trim();
  const frags = [];
  for (const m of s.matchAll(CJK_RUN)) if (m[0].length >= 2) frags.push(m[0]);
  for (const m of s.matchAll(ASCII_WORD)) if (m[0].length >= 2) frags.push(m[0]);
  if (frags.length === 0 && s.length >= 1) frags.push(s);
  return Array.from(new Set(frags));
}

/** 取包含查询片段的一小段；没命中就取开头。 */
export function snippet(text, query, width = 180) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (width <= 0 || s.length <= width) return s;
  const frags = queryFragments(query);
  let at = -1;
  for (const f of frags) {
    const i = s.toLowerCase().indexOf(f.toLowerCase());
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return s.slice(0, width) + "…";
  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(s.length, start + width);
  return (start > 0 ? "…" : "") + s.slice(start, end) + (end < s.length ? "…" : "");
}

const SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9_\-]{16,}\b/g, "sk-***"],
  [/\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g, "sk-***"],
  [/\brk_(?:live|test)_[A-Za-z0-9]{16,}\b/g, "rk-***"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "gh-***"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "gh-***"],
  [/\bglpat-[A-Za-z0-9_\-]{20,}\b/g, "glpat-***"],
  [/\bxox[baprs]-[A-Za-z0-9\-]{10,}\b/g, "xox-***"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "AKIA***"],
  [/\bAIza[0-9A-Za-z_\-]{35}\b/g, "AIza***"],
  [/\bBearer\s+[A-Za-z0-9._\-]{16,}\b/gi, "Bearer ***"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "jwt-***"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[私钥已移除]"],
  [/((?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*)(["']?)[^\s"',;]{6,}\2/gi, "$1***"],
  [/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, "***@***"],
  // 只认中国大陆手机号与明确的 QQ/微信字段；不再把所有 11 位以上数字一律打码（会误伤时间戳、路径、ID）。
  [/\b1[3-9]\d{9}\b/g, "***"],
  [/\b\d{15,19}\b/g, "***"],
  [/(?<![A-Za-z0-9_])(openid|open_id|qq|微信)\s*[:=]\s*[A-Za-z0-9]{5,}\b/gi, "$1=***"],
  [/(?:https?:\/\/)?(?:hooks\.slack\.com\/services|discord(?:app)?\.com\/api\/webhooks)\/[A-Za-z0-9/_-]+/gi, "[webhook 已移除]"],
];

/** 写入前脱敏。返回 {text, redactions}，redactions 是人能看懂的计数说明。 */
export function redact(text) {
  let out = String(text ?? "");
  const hits = [];
  for (const [re, repl] of SECRET_PATTERNS) {
    let n = 0;
    out = out.replace(re, (...args) => {
      n += 1;
      return repl.replace(/\$(\d)/g, (m, i) => String(args[Number(i)] ?? ""));
    });
    if (n > 0) hits.push(re.source.slice(0, 24) + "×" + n);
  }
  return { text: out, redactions: hits };
}

export function checksum(s) {
  return createHash("sha1").update(normalize(s)).digest("hex").slice(0, 16);
}

/** 粗估 token（中文 1 字≈1，英文 4 字符≈1），只用于预算提示，不作为计费依据。 */
export function estimateTokens(s) {
  const t = String(s ?? "");
  let cjk = 0;
  for (const ch of t) if (SINGLE_CJK.test(ch)) cjk += 1;
  return Math.ceil(cjk + (t.length - cjk) / 4);
}

export function truncate(s, max) {
  const t = String(s ?? "");
  return t.length <= max ? t : t.slice(0, Math.max(0, max - 1)) + "…";
}

/**
 * 把工具 render 的返回值规范成宿主要求的「内容块数组」。
 * 宿主（cordis-host-runner 的 sandboxDefineTool）只接受 [{ type: "text", text }]；
 * 直接返回字符串会在下游 content.some 处报错。
 */
export function contentBlocks(value) {
  if (Array.isArray(value)) return value;
  return [{ type: "text", text: String(value ?? "") }];
}

/** 稳定的 JSON 字符串（键排序），用于去重比较与导出。 */
export function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
