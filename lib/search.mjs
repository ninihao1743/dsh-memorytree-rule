// lib/search.mjs — 混合检索（BM25 关键词 + 字符 n-gram 向量），带可解释的打分与诚实空结果。
//
// 说明（不夸大）：
//  - BM25 部分：中文按「单字 + 相邻二字」切，ASCII 按单词切，是真正的词频相关度检索。
//  - 向量部分：256 维 hashed 字符 n-gram（feature hashing），不是神经网络语义嵌入，
//    优势是零依赖、可用于找「措辞相近」的条目；它不理解同义改写，报告里如实标注。
//  - 融合：关键词 0.62 + 向量 0.38，再乘 layer/status/importance/trust/半衰期/有效期修正。
//    每条命中都带 match 分解，便于主人判断为什么被召回。
import { normalize, tokenize, snippet, truncate } from "./text.mjs";
import { embed, cosine, unpack } from "./vector.mjs";

const BM25_K1 = 1.35;
const BM25_B = 0.72;
const W_KEYWORD = 0.62;
const W_VECTOR = 0.38;

const LAYER_BOOST = { trunk: 1.18, task: 1.12, emotion: 1.0, leaf: 0.86 };
const STATUS_FACTOR = { active: 1, candidate: 0.82, superseded: 0.5, archived: 0.4 };

/**
 * @param {import("./store.mjs").MemoryStore} store
 * @param {{query:string, scopes?:string[]|string, layers?:string[], status?:string[],
 *          limit?:number, mode?:"hybrid"|"keyword"|"vector", now?:number,
 *          threshold?:number, includeArchived?:boolean}} opts
 */
export function searchMemory(store, opts) {
  const db = store.db;
  const query = String(opts.query ?? "").trim();
  if (query.length > 500) return emptyResult(query.slice(0, 80), "hybrid", "查询过长（上限 500 字），请缩短后再搜");
  const mode = ["keyword", "vector", "hybrid"].includes(opts.mode) ? opts.mode : "hybrid";
  const now = Number(opts.now ?? store.now());
  const limit = Math.min(Math.max(Number(opts.limit ?? 8) || 8, 1), 30);
  const queryTerms = tokenize(normalize(query));
  if (query.trim() === "") {
    return emptyResult(query, mode, "查询为空");
  }
  if (queryTerms.size === 0) {
    return emptyResult(query, mode, "查询没有可检索的字符");
  }
  if (queryTerms.size > 120) {
    return emptyResult(query.slice(0, 80), mode, "查询词太多（上限 120 个），请缩短后再搜");
  }
  // 有词/bigram 时丢掉单字（单字权重 0.3，会在长句里凑出假命中）；只有单字查询时才用单字。
  if ([...queryTerms.keys()].some((t) => t.startsWith("b:") || t.startsWith("w:"))) {
    for (const t of [...queryTerms.keys()]) if (t.startsWith("u:")) queryTerms.delete(t);
  }

  const scopes = opts.scopes === undefined ? undefined : Array.isArray(opts.scopes) ? opts.scopes : [opts.scopes];
  if (scopes && scopes.length === 0) return emptyResult(query, mode, "没有指定任何作用域");
  const layers = opts.layers && opts.layers.length ? opts.layers : undefined;
  const statuses = opts.status && opts.status.length ? opts.status : ["active", "candidate"];

  // 1) 候选集：SQL 过滤 scope/layer/status，之后全部在 JS 里打分。
  const where = [];
  const params = [];
  if (scopes) {
    where.push("scope IN (" + scopes.map(() => "?").join(",") + ")");
    params.push(...scopes);
  }
  if (layers) {
    where.push("layer IN (" + layers.map(() => "?").join(",") + ")");
    params.push(...layers);
  }
  if (statuses) {
    where.push("status IN (" + statuses.map(() => "?").join(",") + ")");
    params.push(...statuses);
  }
  const rows = db
    .prepare("SELECT id,uid,scope,layer,kind,status,subject,title,text,summary,tags,source,evidence,trust,importance,half_life_days,valid_until,updated_at,ts FROM node" + (where.length ? " WHERE " + where.join(" AND ") : ""))
    .all(...params);
  if (rows.length === 0) return emptyResult(query, mode, "该作用域/枝条下还没有记忆");

  const ids = rows.map((r) => Number(r.id));
  const idSet = new Set(ids);
  const N = rows.length;

  // 2) 词项统计：df 用整个候选集，节点长度用存储的 len（加权 token 数）。
  const df = new Map();
  const termStmt = db.prepare("SELECT node_id,term,tf FROM term WHERE term=?");
  // 逐查询词取倒排；查询词很少（<=几十），够快。
  const inverted = new Map();
  for (const term of queryTerms.keys()) {
    const hits = termStmt.all(term).filter((h) => idSet.has(Number(h.node_id)));
    if (hits.length === 0) continue;
    df.set(term, hits.length);
    const m = new Map();
    for (const h of hits) m.set(Number(h.node_id), Number(h.tf));
    inverted.set(term, m);
  }

  const avgLen = rows.reduce((a, r) => a + Number(r.len ?? 0), 0) / N || 1;
  const vecStmt = db.prepare("SELECT data FROM vec WHERE node_id=?");
  const qVec = embed(query);
  const qNorm = normalize(query);
  const qCompact = qNorm.replace(/\s+/g, "");

  const scored = [];
  for (const r of rows) {
    const id = Number(r.id);

    // ── BM25 ──
    let bm25 = 0;
    let matchedTerms = 0;
    const len = Number(r.len ?? 0);
    for (const [term, qw] of queryTerms) {
      const posting = inverted.get(term);
      if (!posting) continue;
      const tf = posting.get(id);
      if (!tf) continue;
      matchedTerms += 1;
      const dfv = df.get(term) ?? 0;
      const idf = Math.log(1 + (N - dfv + 0.5) / (dfv + 0.5));
      const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * len) / avgLen);
      bm25 += idf * ((tf * (BM25_K1 + 1)) / denom) * qw;
    }

    // ── 向量 ──
    let cos = 0;
    if (mode !== "keyword") {
      const vrow = vecStmt.get(id);
      if (vrow && vrow.data) {
        cos = cosine(qVec, unpack(vrow.data));
        if (!Number.isFinite(cos)) cos = 0;
        cos = Math.max(0, cos);
      }
    }

    // 诚实门槛：hash 字符 n-gram 向量不是神经语义，不能单独「猜」出命中。
    // 默认 keyword/hybrid 要求至少有一个查询词真的出现在条目里；只有显式 mode=vector 才允许纯相似度召回。
    if (mode === "vector") {
      if (cos < 0.12) continue;
    } else if (bm25 === 0) {
      continue;
    }

    // ── 归一化与修正 ──
    const kwNorm = Math.min(1, bm25 / 6);
    const vecNorm = Math.min(1, cos / 0.6);
    let score;
    if (mode === "keyword") score = kwNorm;
    else if (mode === "vector") score = vecNorm;
    else score = W_KEYWORD * kwNorm + W_VECTOR * vecNorm;

    // 精确短语（整串出现在正文里）是强信号
    const textNorm = normalize(String(r.text));
    const textCompact = textNorm.replace(/\s+/g, "");
    const phraseHit = qCompact.length >= 2 && textCompact.includes(qCompact);
    if (phraseHit) score += 0.18;

    const layerBoost = LAYER_BOOST[r.layer] ?? 1;
    const statusFactor = STATUS_FACTOR[r.status] ?? 0.8;
    const importance = Number(r.importance ?? 0.5);
    const trust = Number(r.trust ?? 70) / 100;
    let relevance = score * layerBoost * statusFactor * (0.72 + 0.56 * importance) * (0.62 + 0.38 * trust);

    // 半衰期衰减：half_life_days=0 表示不衰减（长期规则），否则按 0.5^(age/halfLife)
    const halfLife = Number(r.half_life_days ?? 0);
    let decay = 1;
    if (halfLife > 0) {
      const ageDays = Math.max(0, (now - Number(r.updated_at ?? now)) / 86400000);
      decay = Math.max(0.35, Math.pow(0.5, ageDays / halfLife));
      relevance *= decay;
    }
    // 过期条目降权并标注
    const expired = r.valid_until !== null && r.valid_until !== undefined && Number(r.valid_until) < now;

    // subject / title 命中也算相关（卡片检索常按 subject 找）
    let fieldHit = false;
    if (r.subject && textContains(normalize(String(r.subject)), queryTerms)) {
      relevance += 0.08;
      fieldHit = true;
    }
    if (expired) relevance *= 0.55;

    scored.push({
      id,
      uid: String(r.uid),
      scope: String(r.scope),
      layer: String(r.layer),
      kind: String(r.kind),
      status: String(r.status),
      subject: String(r.subject ?? ""),
      title: String(r.title ?? ""),
      text: String(r.text ?? ""),
      summary: r.summary === null || r.summary === undefined ? null : String(r.summary),
      tags: safeTags(r.tags),
      source: String(r.source ?? ""),
      evidence: r.evidence === null || r.evidence === undefined ? null : String(r.evidence),
      trust: Number(r.trust ?? 70),
      importance,
      validUntil: r.valid_until === null || r.valid_until === undefined ? null : Number(r.valid_until),
      updatedAt: Number(r.updated_at ?? 0),
      relevance: Number(relevance.toFixed(4)),
      match: {
        keyword: Number(kwNorm.toFixed(3)),
        vector: Number(vecNorm.toFixed(3)),
        bm25: Number(bm25.toFixed(3)),
        cosine: Number(cos.toFixed(3)),
        terms: matchedTerms,
        phrase: phraseHit,
        subject: fieldHit,
        decay: Number(decay.toFixed(3)),
      },
      expired,
      snippet: snippet(String(r.text), query, 180),
    });
  }

  if (scored.length === 0) {
    return emptyResult(query, mode, "没有命中：所有候选记忆条目都不含查询词（不编造；换义词或 mode=vector 可扩大召回）", { candidateCount: N });
  }

  scored.sort((a, b) => b.relevance - a.relevance || b.updatedAt - a.updatedAt);
  const threshold = Number(opts.threshold ?? defaultThreshold(mode));
  let hits = scored.filter((h) => h.relevance >= threshold);
  if (hits.length === 0) {
    return emptyResult(query, mode, "命中强度低于阈值（最相关的条目 " + scored[0].relevance.toFixed(3) + " < " + threshold + "）", {
      candidateCount: N,
      topRejected: scored.slice(0, 3).map((h) => ({ id: h.id, uid: h.uid, score: h.relevance, layer: h.layer, subject: h.subject })),
    });
  }
  const total = hits.length;
  hits = hits.slice(0, limit);
  const out = {
    query,
    mode,
    threshold,
    scope: scopes ?? null,
    hits,
    total,
    returned: hits.length,
    candidateCount: N,
    honest: "结果按相关度排序；向量部分是字符 n-gram 近似，不是语义模型，同义改写可能漏召回。",
  };
  store.audit("search", { scope: scopes ? scopes.join(",") : null, query, hits: total, detail: { mode, candidateCount: N } });
  return out;
}

function emptyResult(query, mode, reason, extra = {}) {
  return { query, mode, threshold: defaultThreshold(mode), hits: [], total: 0, returned: 0, empty: true, reason, ...extra };
}

function defaultThreshold(mode) {
  if (mode === "keyword") return 0.12;
  if (mode === "vector") return 0.3;
  return 0.2;
}

function safeTags(v) {
  try {
    const a = JSON.parse(v ?? "[]");
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

function textContains(normText, terms) {
  for (const t of terms.keys()) {
    const bare = t.slice(2);
    if (normText.includes(bare)) return true;
  }
  return false;
}
