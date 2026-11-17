// lib/paths.mjs — 路径解析：全部跨平台，不写死 D:\ 或 C:\。
//
// 设计取舍：
// - 数据默认放 <DSH_HOME>/memory-tree，而不是插件目录（插件目录更新会被替换）。
// - 备份脚本会把 memories.db 备份走；新库放在同一棵 DSH_HOME 下，用户加一条备份规则即可。
// - 任何路径都允许被行 config / config.json 覆盖，方便测试与多实例。
import os from "node:os";
import path from "node:path";

export function dshHome(env = process.env) {
  const v = env.DSH_HOME;
  return v !== undefined && String(v).trim() !== "" ? String(v).trim() : path.join(os.homedir(), ".dsh");
}

/** 展开 ~ 与 %VAR%（Windows）/$VAR；不展开不存在的变量，原样保留。 */
export function expandPath(p, env = process.env) {
  let s = String(p ?? "").trim();
  if (s === "") return "";
  if (s === "~") return os.homedir();
  if (s.startsWith("~/") || s.startsWith("~\\")) s = path.join(os.homedir(), s.slice(2));
  s = s.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name) => (env[name] !== undefined ? String(env[name]) : m));
  s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b) => {
    const name = a ?? b;
    return env[name] !== undefined ? String(env[name]) : m;
  });
  return s;
}

/**
 * 解析插件用到的全部路径。
 * config 优先级（由调用方合并）：行 config > <dataDir>/config.json > 默认。
 */
export function resolvePaths(config = {}, env = process.env) {
  const home = dshHome(env);
  const dataDirRaw = expandPath(config.dataDir, env);
  const dataDir = path.resolve(dataDirRaw !== "" ? dataDirRaw : path.join(home, "memory-tree"));
  const dbFile = path.resolve(expandPath(config.dbFile, env) || path.join(dataDir, "memory.db"));
  const agentsRaw = expandPath(config.agentsPath, env);
  const agentsPath = path.resolve(agentsRaw !== "" ? agentsRaw : path.join(home, "AGENTS.md"));
  const legacyRaw = expandPath(config.legacyDb, env);
  const legacyDb = path.resolve(legacyRaw !== "" ? legacyRaw : path.join(home, "remembers-data", "memories.db"));
  const backupRaw = expandPath(config.backupDir, env);
  const backupDir = path.resolve(backupRaw !== "" ? backupRaw : path.join(dataDir, "backups"));
  const rootArchive = expandPath(config.rootArchive, env);
  const rootCold = expandPath(config.rootCold, env);
  const boardCwdRaw = expandPath(config.boardCwd, env);
  const boardCwd = boardCwdRaw !== "" ? path.resolve(boardCwdRaw) : "";
  return {
    home,
    dataDir,
    dbFile,
    agentsPath,
    legacyDb,
    backupDir,
    boardCwd,
    rootArchive,
    rootCold,
    configFile: path.join(dataDir, "config.json"),
    exportDir: path.join(dataDir, "exports"),
    reportFile: path.join(dataDir, "report.html"),
  };
}

/** scope 的稳定名字：workspace 用 cwd 的短哈希，避免路径里的用户名/盘符进入字符串比较。 */
import { createHash } from "node:crypto";

export function workspaceScope(cwd) {
  const p = String(cwd ?? "").trim();
  if (p === "") return "workspace:unknown";
  const base = p.replace(/\\/g, "/").replace(/\/+$/, "");
  // Windows / macOS 默认大小写不敏感，统一小写避免同一目录两个 scope；Linux 保留大小写。
  const norm = process.platform === "win32" || process.platform === "darwin" ? base.toLowerCase() : base;
  const h = createHash("sha1").update(norm).digest("hex").slice(0, 10);
  return "workspace:" + h;
}

export function scopeLabel(scope, cwdMap = {}) {
  const s = String(scope ?? "");
  if (s === "user") return "user（全局）";
  if (s.startsWith("workspace:")) {
    const name = cwdMap[s];
    return name ? "workspace（" + name + "）" : s;
  }
  return s;
}
