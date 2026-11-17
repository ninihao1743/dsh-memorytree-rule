// lib/runtime.mjs — 插件运行时：路径、库、作用域、主干同步的调度。
import fs from "node:fs";
import { resolvePaths, workspaceScope } from "./paths.mjs";
import { openMemoryDb, getMeta } from "./db.mjs";
import { MemoryStore } from "./store.mjs";
import { syncTrunk } from "./ingest.mjs";
import { checksum } from "./text.mjs";
import { exportTaskCards } from "./cards.mjs";

const SYNC_THROTTLE_MS = 15000;

/** 去掉空字符串，让「留空 = 默认」在行 config / config.json 里都成立。 */
function stripEmpty(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v === "" || v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}

export class MemoryRuntime {
  constructor(config = {}) {
    // 优先级：行 config > <dataDir>/config.json > 默认值。
    const defaults = { redact: true, autoSync: true };
    let merged = { ...defaults, ...stripEmpty(config) };
    let paths = resolvePaths(merged);
    try {
      if (fs.existsSync(paths.configFile)) {
        const fileCfg = JSON.parse(fs.readFileSync(paths.configFile, "utf8"));
        if (fileCfg && typeof fileCfg === "object") merged = { ...defaults, ...stripEmpty(fileCfg), ...stripEmpty(config) };
        paths = resolvePaths(merged);
      }
    } catch {
      /* 配置文件坏了就用行 config 与默认值，不阻塞插件加载 */
    }
    this.config = merged;
    this.paths = paths;
    this.db = null;
    this.store = null;
    this.lastSyncAt = 0;
    this.lastSyncResult = null;
    this.lastExec = null;
    this.board = { base: "", token: "", sessionId: null };
    this.closed = false;
  }

  /** 惰性打开库；进程内复用同一个连接。 */
  open() {
    if (this.closed) throw new Error("记忆树已关闭（插件卸载后不能再写入）");
    if (!this.store) {
      this.db = openMemoryDb(this.paths.dbFile);
      this.store = new MemoryStore(this.db, {
        redact: this.config.redact !== false,
        clock: this.config.clock,
      });
    }
    return this.store;
  }

  close() {
    this.closed = true;
    if (this.store) this.store.close();
    this.store = null;
    this.db = null;
  }

  /** 记住最近一次工具调用的会话，看板“深度思考”按钮用它把请求送回会话。 */
  noteExec(exec) {
    if (exec) this.lastExec = exec;
    try {
      const id = exec?.agent?.id ?? exec?.agent?.session?.id;
      if (id) this.board.sessionId = String(id);
    } catch {
      /* 形状变化时保持旧值 */
    }
  }

  /** 没有工具调用时，也可以从 session/event 记住最近活跃的会话。 */
  noteSession(sessionId) {
    if (sessionId) this.board.sessionId = String(sessionId);
  }

  /** 从工具执行上下文里拿会话工作目录（拿不到就用进程 cwd）。 */
  cwdOf(exec) {
    try {
      const cwd = exec?.agent?.session?.header?.cwd;
      if (cwd && String(cwd).trim() !== "") return String(cwd);
    } catch {
      /* 上下文形状变化时退回进程 cwd */
    }
    return process.cwd();
  }

  workspaceOf(exec) {
    const cwd = this.cwdOf(exec);
    const scope = workspaceScope(cwd);
    try {
      this.open().rememberScope(scope, cwd);
    } catch {
      /* 别名失败不影响主流程 */
    }
    return { cwd, scope };
  }

  /**
   * 解析要检索/写入的作用域。
   * requested: 'all'(默认，user+当前 workspace) | 'user' | 'workspace'
   */
  scopesFor(exec, requested = "all") {
    const ws = this.workspaceOf(exec);
    const want = String(requested ?? "all");
    if (want === "user" || want === "global") return { scopes: ["user"], cwd: ws.cwd, workspace: ws.scope };
    if (want === "workspace") return { scopes: [ws.scope], cwd: ws.cwd, workspace: ws.scope };
    const list = ws.scope === "user" ? ["user"] : ["user", ws.scope];
    return { scopes: list, cwd: ws.cwd, workspace: ws.scope };
  }

  /** 新写入的默认作用域：规则/情感用 user，任务卡/判断叶按当前工作区分。 */
  defaultScope(layer, exec) {
    if (layer === "trunk" || layer === "emotion") return "user";
    return this.workspaceOf(exec).scope;
  }

  /**
   * 主干同步：AGENTS.md 变了才写库；文件没变时只是读文件校验（很快）。
   * silent=true 时不抛错（工具调用不该因为文件权限失败而整体失败）。
   */
  ensureTrunk(exec, opts = {}) {
    if (this.config.autoSync === false && opts.force !== true) return { skipped: true, reason: "autoSync 已关闭" };
    const now = Date.now();
    if (!opts.force && now - this.lastSyncAt < SYNC_THROTTLE_MS && this.lastSyncResult) return this.lastSyncResult;
    if (!fs.existsSync(this.paths.agentsPath)) {
      this.lastSyncAt = now;
      this.lastSyncResult = { ok: false, reason: "主干文件不存在：" + this.paths.agentsPath };
      return this.lastSyncResult;
    }
    let raw;
    try {
      raw = fs.readFileSync(this.paths.agentsPath, "utf8");
    } catch (err) {
      this.lastSyncAt = now;
      this.lastSyncResult = { ok: false, reason: "读不到主干文件：" + (err && err.message ? err.message : String(err)) };
      return this.lastSyncResult;
    }
    const store = this.open();
    const sum = checksum(raw);
    const prev = getMeta(this.db, "agents_checksum", null);
    if (!opts.force && prev === sum) {
      this.lastSyncAt = now;
      this.lastSyncResult = { ok: true, changed: false, skipped: true, path: this.paths.agentsPath, rules: Number(getMeta(this.db, "agents_rules", "0")) };
      return this.lastSyncResult;
    }
    try {
      this.lastSyncResult = syncTrunk(store, this.paths.agentsPath, { scope: "user" });
    } catch (err) {
      this.lastSyncResult = { ok: false, error: err && err.message ? err.message : String(err) };
    }
    this.lastSyncAt = Date.now();
    return this.lastSyncResult;
  }

  /** 看板写 AGENTS.md 时用的路径与备份目录。 */
  trunkWriteOptions() {
    return { agentsPath: this.paths.agentsPath, backupDir: this.paths.backupDir };
  }

  /**
   * 把任务枝卡导出成 <dataDir>/cards.json，供 QQ / B站 等插件启动时读取。
   * 写成临时文件再 rename，避免插件读到半截 JSON。
   */
  exportCards() {
    return exportTaskCards(this.open(), this.paths.dataDir);
  }

  /** 给报告/状态用的环境信息。 */
  info() {
    const store = this.open();
    const st = store.stats();
    return {
      paths: this.paths,
      config: { redact: this.config.redact !== false, autoSync: this.config.autoSync !== false },
      dbExists: fs.existsSync(this.paths.dbFile),
      dbBytes: fs.existsSync(this.paths.dbFile) ? fs.statSync(this.paths.dbFile).size : 0,
      legacyExists: fs.existsSync(this.paths.legacyDb),
      agentsExists: fs.existsSync(this.paths.agentsPath),
      stats: st,
    };
  }
}
