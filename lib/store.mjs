// lib/store.mjs — 记忆树的读写核心。
//
// 四枝映射（主干 / 情感枝 / 任务枝 / 判断叶）：
//   trunk    主干：AGENTS.md 的索引副本（只读派生；正本是文件）
//   emotion  情感枝：相处情感/关系记录
//   task     任务枝：插件/脚本/常驻服务的做法卡（一个 subject 一张卡）
//   leaf     判断叶：会话里临时收集的规则解析、观察，待每日分拣
//
// 生命周期：active / candidate / superseded / archived。
// 遗忘默认是 archived（可恢复），hard 删除必须显式传入，且受 tools 层拦截。
import { tx, bumpIndexVersion, getMeta, setMeta } from "./db.mjs";
import { randomUUID } from "node:crypto";
import { LAYERS, STATUSES } from "./schema.mjs";
import { checksum, redact as redactText, stableStringify, truncate } from "./text.mjs";
import { embed, pack, cosine, unpack, VEC_DIM, VEC_KIND } from "./vector.mjs";
import { localDate, isDateString, dayRange, buildDiaryText } from "./diary.mjs";

function boundedTags(v) {
  // 标签只用于检索分面，必须有界：最多 32 个、每个 50 字。
  return Array.from(new Set(parseTags(v))).slice(0, 32).map((t) => truncate(t, 50));
}

function nowMs() {
  return Date.now();
}

function parseTags(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (v === null || v === undefined || v === "") return [];
  const s = String(v).trim();
  if (!s) return [];
  try {
    const a = JSON.parse(s);
    if (Array.isArray(a)) return a.map((x) => String(x).trim()).filter(Boolean);
  } catch {
    /* 不是 JSON，按分隔符切 */
  }
  return s.split(/[,，、;；\s]+/).map((x) => x.trim()).filter(Boolean);
}

function asInt(v, fallback = null) {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

const TEXT_MAX = 20000;
const EVIDENCE_MAX = 20000;

// 以前是静默 slice，用户以为写进去了、其实后半段丢了。宁可报错让调用方拆分。
function boundedText(value, max, label) {
  const t = String(value ?? "").trim();
  if (t.length > max) {
    throw new Error(label + " 超过 " + max + " 字上限（当前 " + t.length + " 字），请拆分后再写");
  }
  return t;
}

function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (c) => "\\" + c);
}

function scopesOf(value) {
  if (value === undefined || value === null) return null;
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function placementRow(r) {
  return {
    id: String(r.id),
    nodeId: r.node_id === null || r.node_id === undefined ? null : Number(r.node_id),
    text: String(r.text ?? ""),
    title: String(r.title ?? ""),
    scope: String(r.scope ?? "user"),
    kind: String(r.kind ?? "task"),
    status: String(r.status ?? "pending"),
    recommendedSubject: String(r.recommended_subject ?? ""),
    recommendedTitle: String(r.recommended_title ?? ""),
    recommendedGroup: String(r.recommended_group ?? ""),
    reason: String(r.reason ?? ""),
    sessionId: String(r.session_id ?? ""),
    createdAt: Number(r.created_at ?? 0),
    updatedAt: Number(r.updated_at ?? 0),
  };
}

function patchRow(r) {
  return {
    id: String(r.id),
    nodeId: r.node_id === null || r.node_id === undefined ? null : Number(r.node_id),
    uid: String(r.uid ?? ""),
    title: String(r.title ?? ""),
    oldNum: String(r.old_num ?? ""),
    newNum: String(r.new_num ?? ""),
    oldText: String(r.old_text ?? ""),
    newText: String(r.new_text ?? ""),
    kind: String(r.kind ?? "text"),
    baseChecksum: String(r.base_checksum ?? ""),
    status: String(r.status ?? "pending"),
    batchId: r.batch_id === null || r.batch_id === undefined ? null : String(r.batch_id),
    createdAt: Number(r.created_at ?? 0),
    updatedAt: Number(r.updated_at ?? 0),
  };
}

function batchRow(r) {
  return {
    id: String(r.id),
    status: String(r.status ?? "applied"),
    baseChecksum: String(r.base_checksum ?? ""),
    planJson: r.plan_json === null || r.plan_json === undefined ? null : String(r.plan_json),
    backup: r.backup === null || r.backup === undefined ? null : String(r.backup),
    rules: Number(r.rules ?? 0),
    refs: Number(r.refs ?? 0),
    error: r.error === null || r.error === undefined ? null : String(r.error),
    createdAt: Number(r.created_at ?? 0),
    appliedAt: r.applied_at === null || r.applied_at === undefined ? null : Number(r.applied_at),
  };
}

export function rowToNode(r) {  if (!r) return null;
  return {
    id: Number(r.id),
    uid: String(r.uid),
    scope: String(r.scope),
    layer: String(r.layer),
    kind: String(r.kind),
    status: String(r.status),
    subject: String(r.subject ?? ""),
    title: String(r.title ?? ""),
    text: String(r.text ?? ""),
    summary: r.summary === null || r.summary === undefined ? null : String(r.summary),
    tags: parseTags(r.tags),
    source: String(r.source ?? ""),
    evidence: r.evidence === null || r.evidence === undefined ? null : String(r.evidence),
    trust: Number(r.trust ?? 70),
    importance: Number(r.importance ?? 0.5),
    halfLifeDays: Number(r.half_life_days ?? 0),
    validUntil: r.valid_until === null || r.valid_until === undefined ? null : Number(r.valid_until),
    supersededBy: r.superseded_by === null || r.superseded_by === undefined ? null : Number(r.superseded_by),
    checksum: String(r.checksum ?? ""),
    len: Number(r.len ?? 0),
    ts: Number(r.ts ?? 0),
    createdAt: Number(r.created_at ?? 0),
    updatedAt: Number(r.updated_at ?? 0),
  };
}

/** 把文本切成词项（存储 tf）。与检索用的是同一个分词器。 */
function termRows(text) {
  const toks = tokenizeInto(text);
  return Array.from(toks.entries());
}

import { tokenize } from "./text.mjs";
function tokenizeInto(text) {
  return tokenize(text);
}

export class MemoryStore {
  constructor(db, opts = {}) {
    this.db = db;
    this.clock = typeof opts.clock === "function" ? opts.clock : nowMs;
    this.redactEnabled = opts.redact !== false;
    this.events = [];
  }

  now() {
    return this.clock();
  }

  emit(event, payload) {
    if (this.events.length > 200) this.events.shift();
    this.events.push({ at: this.now(), event, payload });
  }

  // ── 读 ─────────────────────────────────────────────────────────────
  /**
   * 按 id/uid 取一条。opts.scope（字符串或数组）用于限制可见作用域；
   * 不传则是内部全局取（同步主干、看板管理员操作）。
   */
  get(ref, opts = {}) {
    let row;
    if (typeof ref === "number" || /^\d+$/.test(String(ref))) {
      row = this.db.prepare("SELECT * FROM node WHERE id=?").get(asInt(ref));
    } else {
      row = this.db.prepare("SELECT * FROM node WHERE uid=?").get(String(ref));
    }
    const node = rowToNode(row);
    if (!node) return null;
    const allowed = scopesOf(opts.scope);
    if (allowed && !allowed.includes(node.scope)) return null;
    return node;
  }

  // ── 主干大标题（看板折叠分组；只存覆盖，不改 AGENTS.md）────────────
  trunkBuckets() {
    const out = Object.create(null);
    for (const r of this.db.prepare("SELECT uid,bucket FROM trunk_bucket ORDER BY updated_at, uid").all()) {
      out[String(r.uid)] = String(r.bucket);
    }
    return out;
  }

  setTrunkBucket(uid, bucket) {
    const u = String(uid || "").trim();
    const b = String(bucket || "").trim();
    if (!u) throw new Error("缺少主干规则编号");
    if (!/^trunk:§1-\d+-\d+$/.test(u)) throw new Error("主干规则编号格式应为 trunk:§1-x-x：" + u);
    if (u.length > 200) throw new Error("主干规则编号超过 200 字上限");
    if (!b) throw new Error("大标题不能为空");
    if (b.length > 60) throw new Error("大标题超过 60 字上限");
    this.db
      .prepare(
        "INSERT INTO trunk_bucket(uid,bucket,updated_at) VALUES(?,?,?) ON CONFLICT(uid) DO UPDATE SET bucket=excluded.bucket, updated_at=excluded.updated_at",
      )
      .run(u, b, this.now());
    this.emit("trunk_bucket", { uid: u, bucket: b });
    return { uid: u, bucket: b };
  }

  clearTrunkBucket(uid) {
    const u = String(uid || "").trim();
    if (!u) throw new Error("缺少主干规则编号");
    const info = this.db.prepare("DELETE FROM trunk_bucket WHERE uid=?").run(u);
    return { uid: u, removed: Number(info.changes) > 0 };
  }

  list(filter = {}) {
    const where = [];
    const params = [];
    if (filter.scope !== undefined) {
      const scopes = Array.isArray(filter.scope) ? filter.scope : [filter.scope];
      if (scopes.length === 0) return [];
      where.push("scope IN (" + scopes.map(() => "?").join(",") + ")");
      params.push(...scopes);
    }
    if (filter.layers !== undefined) {
      const layers = Array.isArray(filter.layers) ? filter.layers : [filter.layers];
      if (layers.length === 0) return [];
      where.push("layer IN (" + layers.map(() => "?").join(",") + ")");
      params.push(...layers);
    }
    if (filter.status !== undefined) {
      const sts = Array.isArray(filter.status) ? filter.status : [filter.status];
      if (sts.length === 0) return [];
      where.push("status IN (" + sts.map(() => "?").join(",") + ")");
      params.push(...sts);
    }
    if (filter.subject !== undefined) {
      where.push("subject = ?");
      params.push(String(filter.subject));
    }
    if (filter.kind !== undefined) {
      where.push("kind = ?");
      params.push(String(filter.kind));
    }
    if (filter.tag !== undefined) {
      where.push("tags LIKE ? ESCAPE '\\'");
      params.push('%"' + escapeLike(filter.tag) + '"%');
    }
    if (filter.since !== undefined) {
      where.push("updated_at >= ?");
      params.push(asInt(filter.since, 0));
    }
    const limit = Math.min(Math.max(asInt(filter.limit, 100), 1), 5000);
    const offset = Math.max(asInt(filter.offset, 0), 0);
    const order = filter.order === "created" ? "created_at" : filter.order === "importance" ? "importance DESC, updated_at" : "updated_at";
    const sql =
      "SELECT * FROM node" +
      (where.length ? " WHERE " + where.join(" AND ") : "") +
      " ORDER BY " + order + " DESC LIMIT ? OFFSET ?";
    return this.db.prepare(sql).all(...params, limit, offset).map(rowToNode);
  }

  count(filter = {}) {
    const where = [];
    const params = [];
    if (filter.scope !== undefined) {
      const scopes = Array.isArray(filter.scope) ? filter.scope : [filter.scope];
      if (scopes.length === 0) return 0;
      where.push("scope IN (" + scopes.map(() => "?").join(",") + ")");
      params.push(...scopes);
    }
    if (filter.layers !== undefined) {
      const layers = Array.isArray(filter.layers) ? filter.layers : [filter.layers];
      if (layers.length === 0) return 0;
      where.push("layer IN (" + layers.map(() => "?").join(",") + ")");
      params.push(...layers);
    }
    if (filter.status !== undefined) {
      const sts = Array.isArray(filter.status) ? filter.status : [filter.status];
      if (sts.length === 0) return 0;
      where.push("status IN (" + sts.map(() => "?").join(",") + ")");
      params.push(...sts);
    }
    if (filter.since !== undefined) {
      where.push("updated_at >= ?");
      params.push(asInt(filter.since, 0));
    }
    const sql = "SELECT COUNT(*) AS c FROM node" + (where.length ? " WHERE " + where.join(" AND ") : "");
    return Number(this.db.prepare(sql).get(...params).c);
  }

  /** 库里出现过的全部作用域（user + 各 workspace），用于 scope=all 的全库检索。 */
  scopes() {
    return this.db
      .prepare("SELECT DISTINCT scope FROM node WHERE scope IS NOT NULL AND scope <> '' ORDER BY scope")
      .all()
      .map((r) => String(r.scope));
  }

  /** 任务枝卡：同一 subject 只保留最新的一张 active 卡（旧卡会被 superseded）。 */
  cards(scopes) {
    const rows = this.list({ scope: scopes, layers: ["task"], status: "active", limit: 2000, order: "created" });
    const seen = new Map();
    // list 的 created 是升序；从尾部走，遇到历史遗留的同 subject 重复卡时保留最新那张。
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const n = rows[i];
      const key = n.subject ? String(n.scope) + "\u0000" + String(n.subject) : "id:" + n.id;
      if (!seen.has(key)) seen.set(key, n);
    }
    return Array.from(seen.values());
  }

  // ── 待写入位置请求（看板跨页面/刷新用）────────────────────────────
  /**
   * 记一条“这条规则要写入哪条枝/哪张卡”的请求。
   * 页面只记 id；状态、DSH 建议都落在库里，切走/刷新后还能回来。
   */
  placementCreate(input = {}) {
    const text = String(input.text ?? "").trim();
    if (!text) throw new Error("placement.text 不能为空");
    if (text.length > 20000) throw new Error("placement.text 超过 20000 字上限");
    const id = String(input.id || randomUUID());
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO placement (id,node_id,text,title,scope,kind,status,recommended_subject,
          recommended_title,recommended_group,reason,session_id,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.nodeId === undefined || input.nodeId === null ? null : Number(input.nodeId),
        text,
        String(input.title ?? "").slice(0, 200),
        String(input.scope ?? "user"),
        String(input.kind ?? "task"),
        String(input.status ?? "pending"),
        String(input.recommendedSubject ?? ""),
        String(input.recommendedTitle ?? ""),
        String(input.recommendedGroup ?? ""),
        String(input.reason ?? ""),
        String(input.sessionId ?? ""),
        now,
        now,
      );
    this.revision("placement:create", null, null, { id, kind: String(input.kind ?? "task") });
    return this.placementGet(id);
  }

  placementGet(id) {
    const row = this.db.prepare("SELECT * FROM placement WHERE id=?").get(String(id));
    return row ? placementRow(row) : null;
  }

  placementList(opts = {}) {
    const status = opts.status ? String(opts.status) : "";
    const limit = Math.min(200, Math.max(1, Number(opts.limit) || 50));
    const rows = status
      ? this.db.prepare("SELECT * FROM placement WHERE status=? ORDER BY updated_at DESC LIMIT ?").all(status, limit)
      : this.db.prepare("SELECT * FROM placement ORDER BY updated_at DESC LIMIT ?").all(limit);
    return rows.map(placementRow);
  }

  /** DSH 返回建议，或人工手动指定目标。 */
  placementRecommend(id, patch = {}) {
    const cur = this.placementGet(id);
    if (!cur) throw new Error("找不到这条待写入请求：" + String(id));
    if (cur.status === "confirmed" || cur.status === "cancelled") {
      throw new Error("这条请求已经结束（" + cur.status + "），不能再改目标。");
    }
    const now = this.now();
    this.db
      .prepare(
        `UPDATE placement SET status=?, recommended_subject=?, recommended_title=?,
          recommended_group=?, reason=?, updated_at=? WHERE id=?`,
      )
      .run(
        "recommended",
        String(patch.subject ?? "").trim().slice(0, 200),
        String(patch.title ?? "").trim().slice(0, 200),
        String(patch.group ?? "").trim().slice(0, 200),
        String(patch.reason ?? "").slice(0, 1000),
        now,
        String(id),
      );
    this.revision("placement:recommend", null, null, {
      id: String(id),
      subject: String(patch.subject ?? ""),
      group: String(patch.group ?? ""),
    });
    return this.placementGet(id);
  }

  placementSetStatus(id, status) {
    const cur = this.placementGet(id);
    if (!cur) throw new Error("找不到这条待写入请求：" + String(id));
    const allowed = ["pending", "recommended", "confirmed", "cancelled", "timeout"];
    if (!allowed.includes(String(status))) throw new Error("未知 placement 状态：" + String(status));
    this.db.prepare("UPDATE placement SET status=?, updated_at=? WHERE id=?").run(String(status), this.now(), String(id));
    this.revision("placement:status", null, null, { id: String(id), from: cur.status, to: String(status) });
    return this.placementGet(id);
  }

  /** 超过 maxAgeMs 仍未确认的请求标为 timeout；返回超时条数。 */
  placementExpire(maxAgeMs = 10 * 60 * 1000) {
    const cutoff = this.now() - Math.max(60 * 1000, Number(maxAgeMs) || 0);
    const rows = this.db
      .prepare("SELECT id FROM placement WHERE status IN ('pending','recommended') AND updated_at < ?")
      .all(cutoff);
    for (const row of rows) {
      this.db.prepare("UPDATE placement SET status='timeout', updated_at=? WHERE id=?").run(this.now(), row.id);
    }
    return rows.length;
  }

  // ── 判断叶「待确定写入」补丁 ────────────────────────────────────────
  /** 还没写入 AGENTS.md 的修改；同一规则同一时间只留一条。 */
  pendingPatches() {
    return this.db
      .prepare("SELECT * FROM pending_patch WHERE status='pending' ORDER BY updated_at DESC")
      .all()
      .map(patchRow);
  }

  pendingPatchGet(id) {
    const row = this.db.prepare("SELECT * FROM pending_patch WHERE id=?").get(String(id));
    return row ? patchRow(row) : null;
  }

  pendingPatchStage(input = {}) {
    const uid = String(input.uid ?? "").trim();
    if (!uid) throw new Error("pending_patch.uid 不能为空");
    const oldNum = String(input.oldNum ?? "").trim();
    const newNum = String(input.newNum ?? "").trim();
    if (!oldNum || !newNum) throw new Error("pending_patch 的旧号/新号不能为空");
    const newText = String(input.newText ?? "").trim();
    if (!newText) throw new Error("pending_patch.newText 不能为空");
    if (newText.length > 20000) throw new Error("pending_patch.newText 超过 20000 字上限");
    const id = randomUUID();
    const now = this.now();
    return tx(this.db, () => {
      this.db.prepare("DELETE FROM pending_patch WHERE uid=? AND status='pending'").run(uid);
      this.db
        .prepare(
          `INSERT INTO pending_patch (id,node_id,uid,title,old_num,new_num,old_text,new_text,kind,
            base_checksum,status,batch_id,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.nodeId === undefined || input.nodeId === null ? null : Number(input.nodeId),
          uid,
          String(input.title ?? "").slice(0, 200),
          oldNum,
          newNum,
          String(input.oldText ?? ""),
          newText,
          String(input.kind ?? "text"),
          String(input.baseChecksum ?? ""),
          "pending",
          null,
          now,
          now,
        );
      this.revision("patch:stage", input.nodeId ?? null, uid, { id, oldNum, newNum, kind: String(input.kind ?? "text") });
      return patchRow(this.db.prepare("SELECT * FROM pending_patch WHERE id=?").get(id));
    });
  }

  pendingPatchDelete(id) {
    const info = this.db.prepare("DELETE FROM pending_patch WHERE id=? AND status='pending'").run(String(id));
    const n = Number(info.changes ?? 0);
    if (n > 0) this.revision("patch:delete", null, null, { id: String(id) });
    return n;
  }

  pendingPatchMarkWritten(ids, batchId) {
    const list = (ids || []).map((x) => String(x)).filter(Boolean);
    if (list.length === 0) return 0;
    const sql = "UPDATE pending_patch SET status='written', batch_id=?, updated_at=? WHERE id IN (" + list.map(() => "?").join(",") + ")";
    const info = this.db.prepare(sql).run(String(batchId), this.now(), ...list);
    this.revision("patch:written", null, null, { batchId: String(batchId), count: list.length });
    return Number(info.changes ?? 0);
  }

  patchBatchCreate(input = {}) {
    const id = String(input.id || randomUUID());
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO patch_batch (id,status,base_checksum,plan_json,backup,rules,refs,error,created_at,applied_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        String(input.status ?? "applied"),
        String(input.baseChecksum ?? ""),
        input.planJson === undefined || input.planJson === null ? null : String(input.planJson).slice(0, 12000),
        input.backup === undefined || input.backup === null ? null : String(input.backup),
        Number(input.rules ?? 0),
        Number(input.refs ?? 0),
        input.error === undefined || input.error === null ? null : String(input.error).slice(0, 1000),
        now,
        input.appliedAt === null ? null : input.appliedAt === undefined ? now : Number(input.appliedAt),
      );
    return this.patchBatchGet(id);
  }

  patchBatchGet(id) {
    const row = this.db.prepare("SELECT * FROM patch_batch WHERE id=?").get(String(id));
    return row ? batchRow(row) : null;
  }

  patchBatches(limit = 10) {
    const n = Math.min(Math.max(asInt(limit, 10), 1), 100);
    return this.db.prepare("SELECT * FROM patch_batch ORDER BY created_at DESC LIMIT ?").all(n).map(batchRow);
  }

  /** 把叶子标记为已被某条新条目取代（不删原文）。 */
  linkSuperseded(id, byId, reason = "已分类") {
    return tx(this.db, () => {
      const cur = this.get(id);
      if (!cur) throw new Error("找不到要归档的条目：" + String(id));
      this.db
        .prepare("UPDATE node SET status='superseded', superseded_by=?, updated_at=? WHERE id=?")
        .run(Number(byId) || null, this.now(), cur.id);
      this.revision("supersede", cur.id, cur.uid, { by: Number(byId) || null, reason });
      bumpIndexVersion(this.db);
      return this.get(cur.id);
    });
  }

  /** 写入任务卡：同 subject 的 active 卡存在则追加，不存在则新建。 */
  appendToTaskCard(input = {}) {
    const subject = String(input.subject ?? "").trim();
    if (!subject) throw new Error("任务卡 subject 不能为空");
    const text = String(input.text ?? "").trim();
    if (!text) throw new Error("任务卡正文不能为空");
    const scope = String(input.scope ?? "user");
    return tx(this.db, () => {
      const existing = this.list({ scope, layers: ["task"], status: "active", subject, limit: 1, order: "created" })[0];
      if (existing) {
        const merged = String(existing.text || "").trim() + "\n\n" + text;
        const updated = this.update(existing.id, {
          text: merged,
          title: input.title ? String(input.title).slice(0, 120) : existing.title,
          importance: Math.max(Number(existing.importance) || 0, Number(input.importance) || 0),
          source: input.source ? String(input.source) : existing.source,
        });
        return { node: updated, created: false };
      }
      const added = this.add({
        layer: "task",
        scope,
        subject,
        title: String(input.title || subject).slice(0, 120),
        text,
        tags: input.tags || ["任务枝", "看板归枝"],
        source: String(input.source || "board:branch"),
        importance: input.importance === undefined ? 0.75 : input.importance,
        trust: input.trust === undefined ? 85 : input.trust,
      });
      return { node: added.node, created: true };
    });
  }

  // ── 写 ─────────────────────────────────────────────────────────────
  /**
   * 新增一条记忆。
   * input: {layer, text, subject?, title?, summary?, tags?, scope?, source?, evidence?,
   *         trust?, importance?, halfLifeDays?, validUntil?, ts?, uid?, status?, kind?}
   */
  add(input) {
    const layer = String(input.layer ?? "leaf");
    if (!LAYERS.includes(layer)) throw new Error("未知 layer：" + layer + "（可选 " + LAYERS.join("/") + "）");
    let text = boundedText(input.text, TEXT_MAX, "text");
    if (text === "") throw new Error("text 不能为空");

    const redactions = [];
    if (this.redactEnabled && this.redactEnabled !== "off" && input.skipRedact !== true) {
      const r = redactText(text);
      if (r.redactions.length > 0) {
        text = r.text;
        redactions.push(...r.redactions);
      }
    }

    const scope = String(input.scope ?? "user").trim();
    if (!scope) throw new Error("scope 不能为空（user 或 workspace:<hash>）");
    if (scope.length > 200) throw new Error("scope 超过 200 字上限");
    const subject = truncate(String(input.subject ?? "").trim(), 120);
    const source = truncate(String(input.source ?? "manual"), 500);
    // 主干正本在 AGENTS.md：只有从 AGENTS.md 同步来的才是 active，其余一律落成「候选」。
    let status = String(input.status ?? "active");
    if (layer === "trunk" && status === "active" && !source.startsWith("AGENTS.md")) status = "candidate";
    if (!STATUSES.includes(status)) throw new Error("未知 status：" + status);

    const tags = boundedTags(input.tags);
    let evidence =
      input.evidence === undefined || input.evidence === null ? null : boundedText(String(input.evidence), EVIDENCE_MAX, "evidence");
    if (evidence !== null && this.redactEnabled && input.skipRedact !== true) {
      const er = redactText(evidence);
      evidence = er.text;
      redactions.push(...er.redactions);
    }
    if (redactions.length > 0 && !tags.includes("已脱敏")) tags.push("已脱敏");
    if (layer === "trunk" && status === "candidate" && !tags.includes("主干候选")) tags.push("主干候选");

    const ts = asInt(input.ts, this.now()) ?? this.now();
    const uid =
      (input.uid !== undefined && String(input.uid).trim() !== "" ? String(input.uid).trim() : "") ||
      layer + ":" + checksum(scope + "\u0000" + subject + "\u0000" + text);
    if (uid.length > 200) throw new Error("uid 超过 200 字上限");
    return tx(this.db, () => {
      const existing = this.get(uid);
      if (existing) {
        this.emit("add:duplicate", { uid, id: existing.id });
        return { node: existing, duplicate: true, redactions };
      }

      const now = this.now();
      const checksumValue = checksum(text);
      const rowTitle = truncate(String(input.title ?? "").trim(), 120);
      const len = sumWeights((rowTitle ? rowTitle + "\n" : "") + text);
      const createdAt = asInt(input.createdAt, now) ?? now;
      const updatedAt = asInt(input.updatedAt, now) ?? now;
      const row = {
        uid,
        scope,
        layer,
        kind: truncate(String(input.kind ?? (layer === "trunk" ? "rule" : layer === "task" ? "card" : "note")), 40),
        status,
        subject,
        title: truncate(String(input.title ?? "").trim(), 120),
        text,
        summary: input.summary === undefined || input.summary === null ? null : truncate(String(input.summary), 500),
        tags: JSON.stringify(tags),
        source,
        evidence,
        trust: clampInt(input.trust, 0, 100, status === "candidate" ? 60 : 70),
        importance: clampNum(input.importance, 0, 1, layer === "trunk" ? 0.85 : layer === "task" ? 0.75 : 0.4),
        half_life_days: Math.max(0, Number(input.halfLifeDays ?? 0) || 0),
        valid_until: normalizeWhen(input.validUntil),
        checksum: checksumValue,
        len,
        ts,
        created_at: createdAt,
        updated_at: updatedAt,
      };

      const stmt = this.db.prepare(
        `INSERT INTO node (uid,scope,layer,kind,status,subject,title,text,summary,tags,source,evidence,
          trust,importance,half_life_days,valid_until,checksum,len,ts,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      const info = stmt.run(
        row.uid, row.scope, row.layer, row.kind, row.status, row.subject, row.title, row.text, row.summary,
        row.tags, row.source, row.evidence, row.trust, row.importance, row.half_life_days, row.valid_until,
        row.checksum, row.len, row.ts, row.created_at, row.updated_at,
      );
      const id = Number(info.lastInsertRowid);
      this.reindexNode(id, row.text, row.title);
      // 一张任务卡只留一个 active：新卡落库后，同作用域同 subject 的旧卡转 superseded（不删，可追溯）。
      if (row.layer === "task" && row.status === "active" && row.subject) {
        const olds = this.list({ scope: row.scope, layers: ["task"], status: "active", subject: row.subject, limit: 1000 })
          .filter((n) => n.id !== id);
        for (const old of olds) {
          this.db.prepare("UPDATE node SET status='superseded', superseded_by=?, updated_at=? WHERE id=?").run(id, now, old.id);
          this.revision("supersede", old.id, old.uid, { by: id, auto: true });
        }
      }
      bumpIndexVersion(this.db);
      this.revision("add", id, row.uid, { layer: row.layer, scope: row.scope, redactions });
      return { node: this.get(id), duplicate: false, redactions };
    });
  }

  /** 修改一条记忆；uid 不变，便于引用。opts.allowActiveTrunk 只给 AGENTS.md 同步用。 */
  update(ref, patch = {}, opts = {}) {
    return tx(this.db, () => {
      const cur = this.get(ref);
      if (!cur) throw new Error("找不到要修改的记忆：" + String(ref));
      // 主干 active 的正文/标题/状态只能由 AGENTS.md 同步改，避免库内文本与正本分叉。
      if (
        cur.layer === "trunk" &&
        cur.status === "active" &&
        opts.allowActiveTrunk !== true &&
        (patch.text !== undefined || patch.title !== undefined || patch.subject !== undefined || patch.status !== undefined)
      ) {
        throw new Error("主干规则只能由 AGENTS.md 同步修改；请改正本后执行 memory_ingest action=sync");
      }
      const next = { ...cur };
      if (patch.text !== undefined) {
        let t = boundedText(patch.text, TEXT_MAX, "text");
        if (t === "") throw new Error("text 不能为空");
        const r = this.redactEnabled && opts.skipRedact !== true ? redactText(t) : { text: t, redactions: [] };
        t = r.text;
        next.text = t;
        next.checksum = checksum(next.text);
        if (r.redactions.length > 0 && !next.tags.includes("已脱敏")) next.tags.push("已脱敏");
      }
      if (patch.title !== undefined) next.title = truncate(String(patch.title).trim(), 120);
      if (patch.text !== undefined || patch.title !== undefined) {
        next.len = sumWeights((next.title ? next.title + "\n" : "") + next.text);
      }
      if (patch.subject !== undefined) next.subject = truncate(String(patch.subject).trim(), 120);
      if (patch.summary !== undefined) next.summary = patch.summary === null ? null : truncate(String(patch.summary), 500);
      if (patch.tags !== undefined) next.tags = boundedTags(patch.tags);
      if (patch.trust !== undefined) next.trust = clampInt(patch.trust, 0, 100, next.trust);
      if (patch.importance !== undefined) next.importance = clampNum(patch.importance, 0, 1, next.importance);
      if (patch.halfLifeDays !== undefined) next.halfLifeDays = Math.max(0, Number(patch.halfLifeDays) || 0);
      if (patch.validUntil !== undefined) next.validUntil = normalizeWhen(patch.validUntil);
      if (patch.status !== undefined) {
        if (!STATUSES.includes(String(patch.status))) throw new Error("未知 status：" + patch.status);
        next.status = String(patch.status);
        // 主干 index 只能由 AGENTS.md 同步激活；看板 set-trust / 导入不能把候选变成 active。
        if (next.layer === "trunk" && next.status === "active" && cur.status !== "active" && opts.allowActiveTrunk !== true) {
          throw new Error("主干规则只能由 AGENTS.md 同步激活，候选不能直接改成 active");
        }
      }
      if (patch.evidence !== undefined) {
        let ev = patch.evidence === null ? null : boundedText(patch.evidence, EVIDENCE_MAX, "evidence");
        if (ev !== null && this.redactEnabled && opts.skipRedact !== true) {
          const er = redactText(ev);
          ev = er.text;
          if (er.redactions.length > 0 && !next.tags.includes("已脱敏")) next.tags.push("已脱敏");
        }
        next.evidence = ev;
      }
      if (patch.source !== undefined) next.source = truncate(String(patch.source), 500);

      this.db.prepare(
        `UPDATE node SET text=?, title=?, subject=?, summary=?, tags=?, trust=?, importance=?,
          half_life_days=?, valid_until=?, status=?, evidence=?, source=?, checksum=?, len=?, updated_at=?
         WHERE id=?`,
      ).run(
        next.text, next.title, next.subject, next.summary, JSON.stringify(next.tags), next.trust, next.importance,
        next.halfLifeDays, next.validUntil, next.status, next.evidence, next.source, next.checksum, next.len,
        this.now(), next.id,
      );
      this.reindexNode(next.id, next.text, next.title);
      bumpIndexVersion(this.db);
      this.revision("update", next.id, next.uid, { before: cur.checksum, after: next.checksum });
      return this.get(next.id);
    });
  }

  /**
   * 用一条新记忆取代若干旧条目（合并/改口径的正确做法：旧的不删，标 superseded）。
   * 返回 {node, superseded:[ids]}
   */
  supersede(refs, input, opts = {}) {
    const targetScope = String(input?.scope ?? "user");
    return tx(this.db, () => {
      const all = refs.map((r) => this.get(r));
      const missing = refs.filter((r, i) => !all[i]);
      if (all.filter(Boolean).length === 0) throw new Error("要取代的条目一条都不存在");
      if (missing.length) throw new Error("要取代的条目不存在：" + missing.join("、"));
      const allowed = opts.scopes == null ? null : new Set(Array.isArray(opts.scopes) ? opts.scopes : [opts.scopes]);
      const wrong =
        opts.allowCrossScope === true
          ? []
          : all.filter((n) => n.scope !== targetScope && !(allowed && allowed.has(n.scope)));
      if (wrong.length) {
        throw new Error(
          "不能跨作用域取代：#" + wrong.map((n) => n.id + "（" + n.scope + "）").join("、") + "，新条目作用域是 " + targetScope,
        );
      }
      const activeTrunk = all.filter((n) => n.layer === "trunk" && n.status === "active");
      if (activeTrunk.length && opts.allowActiveTrunk !== true) {
        throw new Error("不能取代 active 主干规则；请改 AGENTS.md 后同步");
      }
      const olds = all;
      let created = this.add(input).node;
      // 同文旧条目可能已被取代/归档；取代动作的本意是让这条内容重新成为当前版本。
      if (created.status !== "active" && created.layer !== "trunk") {
        created = this.update(created.id, { status: "active" });
      }
      for (const o of olds) {
        if (o.id === created.id) continue;
        this.db
          .prepare("UPDATE node SET status='superseded', superseded_by=?, updated_at=? WHERE id=?")
          .run(created.id, this.now(), o.id);
        this.revision("supersede", o.id, o.uid, { by: created.id });
      }
      bumpIndexVersion(this.db);
      return { node: created, superseded: olds.filter((o) => o.id !== created.id).map((o) => o.id) };
    });
  }

  /** 遗忘：默认归档（可恢复）；hard=true 才物理删除。 */
  forget(ref, opts = {}) {
    return tx(this.db, () => {
      const cur = this.get(ref);
      if (!cur) throw new Error("找不到要遗忘的记忆：" + String(ref));
      if (cur.layer === "trunk" && cur.status === "active" && opts.allowActiveTrunk !== true) {
        throw new Error("不能直接遗忘 active 主干规则；请先从 AGENTS.md 删除再同步");
      }
      if (opts.hard === true) {
        this.db.prepare("DELETE FROM term WHERE node_id=?").run(cur.id);
        this.db.prepare("DELETE FROM vec WHERE node_id=?").run(cur.id);
        this.db.prepare("DELETE FROM placement WHERE node_id=?").run(cur.id);
        this.db.prepare("DELETE FROM pending_patch WHERE node_id=? OR uid=?").run(cur.id, cur.uid);
        this.db.prepare("DELETE FROM trunk_bucket WHERE uid=?").run(cur.uid);
        this.db.prepare("UPDATE node SET superseded_by=NULL WHERE superseded_by=?").run(cur.id);
        this.db.prepare("DELETE FROM node WHERE id=?").run(cur.id);
        this.revision("forget:hard", null, cur.uid, { id: cur.id, reason: opts.reason ?? "" });
      } else {
        this.db.prepare("UPDATE node SET status='archived', updated_at=? WHERE id=?").run(this.now(), cur.id);
        if (cur.layer === "trunk") {
          // 归档的主干候选不再出现在看板，对应的大标题覆盖也应一起清掉。
          this.db.prepare("DELETE FROM trunk_bucket WHERE uid=?").run(cur.uid);
        }
        this.revision("forget:archive", cur.id, cur.uid, { reason: opts.reason ?? "" });
      }
      bumpIndexVersion(this.db);
      return { id: cur.id, uid: cur.uid, hard: opts.hard === true };
    });
  }

  /** 把任务枝同 subject 的旧 active 卡降级，保证一张卡只有一个 active 版本。 */
  replaceCard(subject, input) {
    return tx(this.db, () => {
      const scope = String(input.scope ?? "user");
      const rows = this.list({ scope, layers: ["task"], status: "active", subject, limit: 1000, order: "created" });
      // subject 由方法参数决定：调用方即使忘了在 input 里带 subject，也不能建出无主题的卡。
      const added = this.add({ ...input, scope, subject });
      let created = added.node;
      if (added.duplicate) {
        // 正文没变但标题/标签/重要度可能变了：任务卡仍应刷新这些元数据。
        // 若命中的是历史遗留的 superseded/archived 同文卡，恢复为 active，否则新卡“写入成功”却不可见。
        const revive = created.status !== "active";
        created = this.update(created.id, {
          title: input.title,
          tags: input.tags,
          importance: input.importance,
          trust: input.trust,
          status: revive ? "active" : undefined,
        });
        for (const r of rows) {
          if (r.id === created.id) continue;
          this.db.prepare("UPDATE node SET status='superseded', superseded_by=?, updated_at=? WHERE id=?").run(created.id, this.now(), r.id);
          this.revision("replace-card", r.id, r.uid, { by: created.id });
        }
        if (rows.length > 0) bumpIndexVersion(this.db);
        return { node: created, superseded: rows.filter((r) => r.id !== created.id).map((r) => r.id) };
      }
      for (const r of rows) {
        if (r.id === created.id) continue;
        this.db.prepare("UPDATE node SET status='superseded', superseded_by=?, updated_at=? WHERE id=?").run(created.id, this.now(), r.id);
        this.revision("replace-card", r.id, r.uid, { by: created.id });
      }
      if (rows.length > 0) bumpIndexVersion(this.db);
      return { node: created, superseded: rows.map((r) => r.id) };
    });
  }

  // ── 索引维护 ────────────────────────────────────────────────────────
  reindexNode(id, text, title = "") {
    this.db.prepare("DELETE FROM term WHERE node_id=?").run(id);
    this.db.prepare("DELETE FROM vec WHERE node_id=?").run(id);
    const ins = this.db.prepare("INSERT INTO term(node_id,term,tf) VALUES(?,?,?)");
    const corpus = title ? String(title) + "\n" + String(text ?? "") : String(text ?? "");
    for (const [term, tf] of termRows(corpus)) ins.run(id, term, tf);
    const v = embed(corpus);
    this.db.prepare("INSERT INTO vec(node_id,dim,kind,data) VALUES(?,?,?,?)").run(id, VEC_DIM, VEC_KIND, pack(v));
  }

  /** 全量重建派生索引（doctor / 迁移后用）。 */
  reindexAll() {
    const rows = this.db.prepare("SELECT id,text,title FROM node").all();
    tx(this.db, () => {
      this.db.exec("DELETE FROM term");
      this.db.exec("DELETE FROM vec");
      for (const r of rows) this.reindexNode(Number(r.id), String(r.text), String(r.title ?? ""));
    });
    bumpIndexVersion(this.db);
    return rows.length;
  }

  revision(action, nodeId, uid, detail) {
    try {
      this.db
        .prepare("INSERT INTO revision(ts,action,node_id,uid,detail) VALUES(?,?,?,?,?)")
        .run(this.now(), action, nodeId ?? null, uid ?? null, stableStringify(detail ?? {}));
      this.db
        .prepare("DELETE FROM revision WHERE id <= (SELECT id FROM revision ORDER BY id DESC LIMIT 1 OFFSET 5000)")
        .run();
    } catch {
      /* 版本记录失败不能影响主操作 */
    }
  }

  audit(kind, data = {}) {
    try {
      this.db
        .prepare("INSERT INTO audit(ts,kind,scope,query,hits,detail) VALUES(?,?,?,?,?,?)")
        .run(this.now(), String(kind), data.scope ? String(data.scope) : null, data.query ? String(data.query).slice(0, 300) : null,
          data.hits === undefined ? null : Number(data.hits), data.detail === undefined ? null : stableStringify(data.detail).slice(0, 4000));
      this.db
        .prepare("DELETE FROM audit WHERE id <= (SELECT id FROM audit ORDER BY id DESC LIMIT 1 OFFSET 5000)")
        .run();
    } catch {
      /* 审计失败不能挡住检索 */
    }
  }

  recentAudit(limit = 20) {
    return this.db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(Math.min(Math.max(asInt(limit, 20), 1), 200))
      .map((r) => ({
        id: Number(r.id), ts: Number(r.ts), kind: String(r.kind), scope: r.scope, query: r.query,
        hits: r.hits === null ? null : Number(r.hits),
        detail: safeJson(r.detail),
      }));
  }

  recentRevisions(limit = 20) {
    return this.db.prepare("SELECT * FROM revision ORDER BY id DESC LIMIT ?").all(Math.min(Math.max(asInt(limit, 20), 1), 200))
      .map((r) => ({ id: Number(r.id), ts: Number(r.ts), action: String(r.action), nodeId: r.node_id, uid: r.uid, detail: safeJson(r.detail) }));
  }

  /** 作用域别名：把 workspace:<hash> 与真实 cwd 关联，报告和卡片里能看懂。 */
  rememberScope(scope, cwd) {
    if (!scope || !cwd) return;
    try {
      this.db
        .prepare("INSERT INTO scope_alias(scope,cwd,label,last_seen) VALUES(?,?,?,?) ON CONFLICT(scope) DO UPDATE SET cwd=excluded.cwd,label=excluded.label,last_seen=excluded.last_seen")
        .run(String(scope), String(cwd), String(cwd).replace(/\\/g, "/").split("/").filter(Boolean).slice(-1)[0] || "", this.now());
    } catch {
      /* 别名只是展示用 */
    }
  }

  scopeAliases() {
    const out = Object.create(null);
    for (const r of this.db.prepare("SELECT scope,cwd FROM scope_alias").all()) out[String(r.scope)] = String(r.cwd);
    return out;
  }

  /** 看板要展示全部作用域：user + 所有写过条目的 workspace。 */
  allScopes() {
    const set = new Set(["user"]);
    for (const r of this.db.prepare("SELECT DISTINCT scope FROM node").all()) set.add(String(r.scope));
    for (const scope of Object.keys(this.scopeAliases())) set.add(scope);
    return [...set];
  }

  // ── 日记索引（属于情感枝的索引，不是第六枝）──────────────────────────
  diaryAdd(date, text, mood = "manual") {
    const d = String(date ?? "").trim();
    if (!isDateString(d)) throw new Error("日记日期格式应为 YYYY-MM-DD：" + d);
    const body = String(text ?? "").trim();
    if (!body) throw new Error("日记正文不能为空");
    if (body.length > 20000) throw new Error("日记正文超过 20000 字上限，请拆分后再写");
    const safe = redactText(body);
    const stored = safe.text;
    const ts = this.now();
    this.db
      .prepare(
        "INSERT INTO diary(date,text,mood,created_at,updated_at) VALUES(?,?,?,?,?) " +
          "ON CONFLICT(date) DO UPDATE SET text=excluded.text,mood=excluded.mood,updated_at=excluded.updated_at",
      )
      .run(d, stored, truncate(String(mood ?? ""), 40), ts, ts);
    this.revision("diary", null, "diary:" + d, { mood: String(mood ?? ""), chars: stored.length, redactions: safe.redactions.length });
    return this.diaryGet(d);
  }

  diaryGet(date) {
    const r = this.db.prepare("SELECT date,text,mood,created_at,updated_at FROM diary WHERE date=?").get(String(date));
    if (!r) return null;
    return {
      date: String(r.date),
      text: String(r.text),
      mood: String(r.mood ?? ""),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  diaryList(limit = 60) {
    const n = Math.min(Math.max(asInt(limit, 60), 1), 366);
    return this.db
      .prepare("SELECT date,text,mood,created_at,updated_at FROM diary ORDER BY date DESC LIMIT ?")
      .all(n)
      .map((r) => ({
        date: String(r.date),
        text: String(r.text),
        mood: String(r.mood ?? ""),
        createdAt: Number(r.created_at),
        updatedAt: Number(r.updated_at),
      }));
  }

  /**
   * 自动拼装某天的日记索引（只读库内事实）。
   * 默认不覆盖手写日记（mood=manual）；force=true 才覆盖。
   */
  diaryAuto(date = localDate(this.now()), opts = {}) {
    const d = String(date ?? "").trim();
    if (!isDateString(d)) throw new Error("日记日期格式应为 YYYY-MM-DD：" + d);
    const existing = this.diaryGet(d);
    if (existing && existing.mood === "manual" && opts.force !== true) {
      return { skipped: true, reason: "当天已有手写日记，未覆盖；要覆盖请传 force=true", record: existing };
    }
    const { start, end } = dayRange(d);
    const scopeList = opts.scopes === undefined ? null : Array.isArray(opts.scopes) ? opts.scopes : [opts.scopes];
    let revisions = [];
    if (!scopeList || scopeList.length > 0) {
      const scopeSql = scopeList ? " AND n.scope IN (" + scopeList.map(() => "?").join(",") + ")" : "";
      revisions = this.db
        .prepare(
          "SELECT r.action, r.ts, r.node_id, r.uid, n.title, n.subject, n.layer " +
            "FROM revision r LEFT JOIN node n ON n.id=r.node_id WHERE r.ts>=? AND r.ts<?" + scopeSql + " ORDER BY r.id",
        )
        .all(start, end, ...(scopeList ?? []));
    }
    const searchRows = this.db
      .prepare("SELECT query,hits,scope FROM audit WHERE kind='search' AND ts>=? AND ts<? AND query IS NOT NULL ORDER BY id DESC LIMIT 50")
      .all(start, end);
    const allowedScopes = scopeList ? new Set(scopeList) : null;
    const searches = searchRows
      .filter((r) => {
        if (!allowedScopes) return true;
        if (!r.scope) return true;
        return String(r.scope).split(",").some((s) => allowedScopes.has(s));
      })
      .slice(0, 8);
    const text = buildDiaryText({ date: d, revisions, searches, dbFile: opts.dbFile ?? "", agentsPath: opts.agentsPath ?? "" }).slice(0, 20000);
    const record = this.diaryAdd(d, text, "auto");
    return { skipped: false, record, revisions: revisions.length, searches: searches.length };
  }

  // ── 统计 / 树视图 ──────────────────────────────────────────────────
  stats(scopes) {
    const scopeList = scopes === undefined ? null : Array.isArray(scopes) ? scopes : [scopes];
    const emptyScope = Boolean(scopeList && scopeList.length === 0);
    const scopeWhere = scopeList ? (emptyScope ? " WHERE 0" : " WHERE scope IN (" + scopeList.map(() => "?").join(",") + ")") : "";
    const scopeAnd = scopeList ? (emptyScope ? " AND 0" : " AND scope IN (" + scopeList.map(() => "?").join(",") + ")") : "";
    const byLayer = Object.create(null);
    const byStatus = Object.create(null);
    const byScope = Object.create(null);
    for (const r of this.db.prepare("SELECT layer,status,scope,COUNT(*) c FROM node" + scopeWhere + " GROUP BY layer,status,scope").all(...(scopeList ?? []))) {
      const c = Number(r.c);
      byLayer[r.layer] = (byLayer[r.layer] ?? 0) + c;
      byStatus[r.status] = (byStatus[r.status] ?? 0) + c;
      byScope[r.scope] = (byScope[r.scope] ?? 0) + c;
    }
    const now = this.now();
    const expired = Number(
      this.db
        .prepare("SELECT COUNT(*) c FROM node WHERE status='active' AND valid_until IS NOT NULL AND valid_until < ?" + scopeAnd)
        .get(now, ...(scopeList ?? [])).c,
    );
    const pageSize = Number(this.db.prepare("PRAGMA page_size").get().page_size);
    const pageCount = Number(this.db.prepare("PRAGMA page_count").get().page_count);
    return {
      total: scopeList ? this.count({ scope: scopeList }) : this.count({}),
      byLayer,
      byStatus,
      byScope,
      expired,
      pendingLeaves: this.count({ layers: ["leaf"], status: "active", ...(scopeList ? { scope: scopeList } : {}) }),
      candidates: this.count({ layers: ["trunk"], status: "candidate", ...(scopeList ? { scope: scopeList } : {}) }),
      taskCards: this.count({ layers: ["task"], status: "active", ...(scopeList ? { scope: scopeList } : {}) }),
      diaryTotal: Number(this.db.prepare("SELECT COUNT(*) c FROM diary").get().c),
      diaryLastDate: this.db.prepare("SELECT MAX(date) d FROM diary").get()?.d ?? null,
      indexVersion: Number(getMeta(this.db, "index_version", "0")),
      dbBytes: pageSize * pageCount,
      schemaVersion: Number(getMeta(this.db, "schema_version", "0")),
      lastSyncAt: Number(getMeta(this.db, "agents_sync_at", "0")) || null,
      lastAgentsChecksum: getMeta(this.db, "agents_checksum", null),
    };
  }

  /** 树视图：各枝条目、任务卡清单、候选、过期提醒。给 memory_tree 工具用。 */
  tree(opts = {}) {
    const scopes = opts.scopes;
    const aliases = this.scopeAliases();
    const layers = [];
    for (const layer of LAYERS) {
      const rows = this.list({ scope: scopes, layers: [layer], status: "active", limit: 500, order: "importance" });
      const activeTotal = this.count({ scope: scopes, layers: [layer], status: "active" });
      const statusCounts = {};
      for (const s of STATUSES) statusCounts[s] = this.count({ scope: scopes, layers: [layer], status: s });
      layers.push({
        layer,
        active: rows.length,
        activeTotal,
        truncated: activeTotal > rows.length,
        statusCounts,
        items: rows.map((n) => ({
          id: n.id,
          uid: n.uid,
          subject: n.subject,
          title: n.title,
          scope: n.scope,
          importance: n.importance,
          trust: n.trust,
          updatedAt: n.updatedAt,
          preview: truncate(n.text.replace(/\s+/g, " "), 90),
          tags: n.tags,
          expired: n.validUntil !== null && n.validUntil < this.now(),
        })),
      });
    }
    const candidates = this.list({ scope: scopes, layers: ["trunk"], status: "candidate", limit: 100, order: "created" })
      .map((n) => ({ id: n.id, uid: n.uid, title: n.title, text: truncate(n.text, 180), source: n.source }));
    return {
      stats: this.stats(scopes),
      scopes,
      aliases,
      layers,
      candidates,
      taskSubjects: this.list({ scope: scopes, layers: ["task"], status: "active", limit: 200, order: "created" }).map((n) => n.subject),
    };
  }

  // ── 迁移 / 导入导出 ────────────────────────────────────────────────
  exportJsonl() {
    const rows = this.db.prepare("SELECT * FROM node ORDER BY id").all().map(rowToNode);
    // 备份里同时记下「取代者 uid」：恢复后 id 会重排，只有 uid 能稳定重建 supersededBy 链。
    const uidById = new Map(rows.map((n) => [n.id, n.uid]));
    const lines = rows.map((n) => JSON.stringify({
      ...n,
      supersededByUid: n.supersededBy ? uidById.get(n.supersededBy) ?? null : null,
    }));
    for (const d of this.db.prepare("SELECT date,text,mood FROM diary ORDER BY date").all()) {
      lines.push(JSON.stringify({ _kind: "diary", date: d.date, text: d.text, mood: d.mood }));
    }
    for (const b of this.db.prepare("SELECT uid,bucket FROM trunk_bucket ORDER BY uid").all()) {
      lines.push(JSON.stringify({ _kind: "trunk_bucket", uid: b.uid, bucket: b.bucket }));
    }
    return lines.join("\n") + (lines.length ? "\n" : "");
  }

  /** 导入 JSONL；byUid 已存在则跳过（merge）或更新（update）。整批原子，失败全部回滚。 */
  importJsonl(text, opts = {}) {
    const lines = String(text ?? "").split(/\r?\n/).filter((x) => x.trim() !== "");
    return tx(this.db, () => {
      let added = 0;
      let updated = 0;
      let skipped = 0;
      let diary = 0;
      let buckets = 0;
      const supersededLinks = [];
      for (const line of lines) {
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          skipped += 1;
          continue;
        }
        if (obj && obj._kind === "diary") {
          const date = String(obj.date ?? "");
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || typeof obj.text !== "string" || obj.text.length > TEXT_MAX) { skipped += 1; continue; }
          if (this.diaryGet(date) && opts.mode !== "update") { skipped += 1; continue; }
          this.diaryAdd(date, obj.text, String(obj.mood ?? "auto"));
          diary += 1;
          continue;
        }
        if (obj && obj._kind === "trunk_bucket") {
          if (!obj.uid || typeof obj.bucket !== "string" || obj.bucket.trim() === "" || obj.bucket.length > 60 || !/^trunk:§1-\d+-\d+$/.test(String(obj.uid))) { skipped += 1; continue; }
          this.setTrunkBucket(String(obj.uid), String(obj.bucket));
          buckets += 1;
          continue;
        }
        if (obj && obj._kind && obj._kind !== "diary" && obj._kind !== "trunk_bucket") {
          // 未来版本新增的备份行类型：当前版本不认识就跳过，不当成记忆条目写坏库。
          skipped += 1;
          continue;
        }
        if (!obj || typeof obj !== "object" || typeof obj.text !== "string" || obj.text.trim() === "") {
          skipped += 1;
          continue;
        }
        if (obj.text.length > TEXT_MAX) {
          skipped += 1;
          continue;
        }
        const uid = obj.uid ? String(obj.uid) : undefined;
        if (uid && uid.length > 200) {
          skipped += 1;
          continue;
        }
        if (obj.scope !== undefined && (typeof obj.scope !== "string" || obj.scope.trim() === "" || obj.scope.length > 200)) {
          skipped += 1;
          continue;
        }
        if (!LAYERS.includes(obj.layer)) {
          skipped += 1;
          continue;
        }
        const layer = obj.layer;
        // uid 必须与 layer 前缀一致；旧库迁移留下的 legacy:<id> 也允许，保证备份能往返。
        if (uid && !uid.startsWith(layer + ":") && !uid.startsWith("legacy:")) {
          skipped += 1;
          continue;
        }
        const existing = uid ? this.get(uid) : null;
        if (existing) {
          if (existing.layer !== layer) {
            skipped += 1;
            continue;
          }
          if (existing.layer === "trunk" && existing.status === "active") {
            // 正本优先：导入永远不覆盖已激活的主干规则，等 AGENTS.md 同步。
            skipped += 1;
            continue;
          }
          if (existing.layer === "trunk" && String(obj.status) === "active") {
            // 候选也不能借备份导入直接转正；必须走 AGENTS.md 同步。
            skipped += 1;
            continue;
          }
          if (opts.mode === "update") {
            const nextStatus = obj.status === undefined ? undefined : String(obj.status);
            if (nextStatus !== undefined && !STATUSES.includes(nextStatus)) { skipped += 1; continue; }
            this.update(existing.id, {
              text: obj.text, title: obj.title, subject: obj.subject, tags: obj.tags,
              trust: obj.trust, importance: obj.importance, validUntil: obj.validUntil,
              status: nextStatus, halfLifeDays: obj.halfLifeDays,
              summary: obj.summary, evidence: obj.evidence, source: obj.source,
            });
            if (obj.supersededByUid) supersededLinks.push({ uid, byUid: String(obj.supersededByUid) });
            updated += 1;
          } else skipped += 1;
          continue;
        }
        const rawStatus = obj.status === undefined ? "active" : String(obj.status);
        if (!STATUSES.includes(rawStatus)) {
          skipped += 1;
          continue;
        }
        const status = layer === "trunk" && rawStatus === "active" ? "candidate" : rawStatus;
        const res = this.add({
          uid,
          scope: obj.scope ?? "user",
          layer,
          kind: obj.kind,
          status,
          subject: obj.subject,
          title: obj.title,
          text: obj.text,
          summary: obj.summary,
          tags: obj.tags,
          source: obj.source,
          evidence: obj.evidence,
          trust: obj.trust,
          importance: obj.importance,
          halfLifeDays: obj.halfLifeDays,
          validUntil: obj.validUntil,
          ts: obj.ts,
          createdAt: obj.createdAt,
          updatedAt: obj.updatedAt,
        });
        if (res.duplicate) skipped += 1;
        else added += 1;
        if (obj.supersededByUid) supersededLinks.push({ uid, byUid: String(obj.supersededByUid) });
      }
      // 恢复 supersededBy 链：id 会重排，必须等所有 uid 都落库后再按 uid 回填。
      for (const link of supersededLinks) {
        const target = this.get(link.uid);
        const by = this.get(link.byUid);
        if (!target || !by || target.id === by.id || target.status !== "superseded") continue;
        this.db.prepare("UPDATE node SET superseded_by=? WHERE id=?").run(by.id, target.id);
      }
      return { added, updated, skipped, diary, buckets, total: added + updated + skipped + diary + buckets };
    });
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* 已经关了 */
    }
  }
}

export function normalizeWhen(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? Math.trunc(v * 1000) : Math.trunc(v);
  if (v instanceof Date) return v.getTime();
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const t = Date.parse(s + "T23:59:59");
    return Number.isNaN(t) ? null : t;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function sumWeights(text) {
  let n = 0;
  for (const [, w] of tokenizeInto(text)) n += w;
  return n;
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function safeJson(s) {
  if (s === null || s === undefined) return null;
  try {
    return JSON.parse(String(s));
  } catch {
    return String(s);
  }
}

export { cosine, unpack, VEC_DIM };
