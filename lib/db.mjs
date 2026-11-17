// lib/db.mjs — 打开库、事务、并发与崩溃恢复相关的 pragma。
//
// 并发：宿主里可能同时有主会话、子代理、面板在读同一个库。
// - WAL：读写不互相阻塞；busy_timeout 让并发写在锁上等待而不是立刻报 SQLITE_BUSY。
// - synchronous=NORMAL：WAL 下仍能扛进程崩溃（不会丢已提交事务，最多丢最近一次 checkpoint）。
// - 所有多步写都在 BEGIN IMMEDIATE 里，避免两个进程各写一半。
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "./schema.mjs";

export function openMemoryDb(file, opts = {}) {
  if (opts.readOnly !== true) mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file, opts.readOnly === true ? { readOnly: true } : {});
  db.exec("PRAGMA busy_timeout = 8000");
  if (opts.readOnly !== true) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA wal_autocheckpoint = 512");
    migrate(db);
  }
  return db;
}

// 每个连接一份嵌套深度；store 的写方法可以互相调用（supersede→add），
// 内层用 SAVEPOINT，外层用 BEGIN IMMEDIATE，避免「cannot start a transaction within a transaction」。
const TX_DEPTH = new WeakMap();
let txSeq = 0;

/** 事务包装：fn 里抛错则整体回滚。支持嵌套（内层 SAVEPOINT）。fn 必须是同步函数。 */
export function tx(db, fn) {
  const depth = TX_DEPTH.get(db) || 0;
  const nested = depth > 0;
  const savepoint = "mt_sp_" + (++txSeq);
  db.exec(nested ? "SAVEPOINT " + savepoint : "BEGIN IMMEDIATE");
  TX_DEPTH.set(db, depth + 1);
  try {
    const out = fn();
    if (nested) db.exec("RELEASE " + savepoint);
    else db.exec("COMMIT");
    TX_DEPTH.set(db, depth);
    return out;
  } catch (e) {
    try {
      if (nested) {
        db.exec("ROLLBACK TO " + savepoint);
        db.exec("RELEASE " + savepoint);
      } else {
        db.exec("ROLLBACK");
      }
    } catch {
      /* 回滚失败也要把原始错误抛出去 */
    }
    TX_DEPTH.set(db, depth);
    throw e;
  }
}

export function getMeta(db, key, fallback = null) {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key=?").get(key);
    return row ? row.value : fallback;
  } catch {
    return fallback;
  }
}

export function setMeta(db, key, value) {
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
    String(key),
    String(value),
  );
}

export function bumpIndexVersion(db) {
  const cur = Number(getMeta(db, "index_version", "0")) || 0;
  setMeta(db, "index_version", String(cur + 1));
  return cur + 1;
}

export function indexVersion(db) {
  return Number(getMeta(db, "index_version", "0")) || 0;
}
