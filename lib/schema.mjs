// lib/schema.mjs — 库结构、版本迁移。
//
// 设计：
// - node 是唯一「记忆条目」表；layer 表达四枝，status 表达生命周期，scope 表达作用域。
// - term / vec 是派生索引，随时可由 node.text 重建（memory_admin action=reindex）。
// - audit 只追加，用于「谁在什么时候查过什么、命中了什么」的审计，不参与检索。
// - 主干正本仍是 AGENTS.md：trunk 行是从文件同步来的索引副本（source=AGENTS.md#Lx-Ly），
//   不在这里直接编辑（要改就改 AGENTS.md，再 sync）。这样不产生第二个注入源。
export const SCHEMA_VERSION = 5;

export const LAYERS = ["trunk", "emotion", "task", "leaf"];
export const STATUSES = ["active", "candidate", "superseded", "archived"];
export const KINDS = ["rule", "card", "note", "pointer", "section", "session"];

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS node (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,
  layer TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note',
  status TEXT NOT NULL DEFAULT 'active',
  subject TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  summary TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'manual',
  evidence TEXT,
  trust INTEGER NOT NULL DEFAULT 70,
  importance REAL NOT NULL DEFAULT 0.5,
  half_life_days REAL NOT NULL DEFAULT 0,
  valid_until INTEGER,
  superseded_by INTEGER,
  checksum TEXT NOT NULL,
  len REAL NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS node_scope_layer ON node(scope, layer, status);
CREATE INDEX IF NOT EXISTS node_subject ON node(subject);
CREATE INDEX IF NOT EXISTS node_uid ON node(uid);
CREATE INDEX IF NOT EXISTS node_status ON node(status);

CREATE TABLE IF NOT EXISTS term (
  node_id INTEGER NOT NULL,
  term TEXT NOT NULL,
  tf REAL NOT NULL,
  PRIMARY KEY (node_id, term)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS term_term ON term(term);

CREATE TABLE IF NOT EXISTS vec (
  node_id INTEGER PRIMARY KEY,
  dim INTEGER NOT NULL,
  kind TEXT NOT NULL,
  data BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  scope TEXT,
  query TEXT,
  hits INTEGER,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts);

CREATE TABLE IF NOT EXISTS scope_alias (
  scope TEXT PRIMARY KEY,
  cwd TEXT,
  label TEXT,
  last_seen INTEGER
);

CREATE TABLE IF NOT EXISTS revision (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  action TEXT NOT NULL,
  node_id INTEGER,
  uid TEXT,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS diary (
  date TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  mood TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS placement (
  id TEXT PRIMARY KEY,
  node_id INTEGER,
  text TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT 'user',
  kind TEXT NOT NULL DEFAULT 'task',
  status TEXT NOT NULL DEFAULT 'pending',
  recommended_subject TEXT NOT NULL DEFAULT '',
  recommended_title TEXT NOT NULL DEFAULT '',
  recommended_group TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS placement_status ON placement(status, updated_at);

CREATE TABLE IF NOT EXISTS pending_patch (
  id TEXT PRIMARY KEY,
  node_id INTEGER,
  uid TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  old_num TEXT NOT NULL,
  new_num TEXT NOT NULL,
  old_text TEXT NOT NULL,
  new_text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  base_checksum TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  batch_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pending_patch_status ON pending_patch(status, updated_at);
CREATE INDEX IF NOT EXISTS pending_patch_uid ON pending_patch(uid);

CREATE TABLE IF NOT EXISTS patch_batch (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'applied',
  base_checksum TEXT NOT NULL DEFAULT '',
  plan_json TEXT,
  backup TEXT,
  rules INTEGER NOT NULL DEFAULT 0,
  refs INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  applied_at INTEGER
);
CREATE INDEX IF NOT EXISTS patch_batch_created ON patch_batch(created_at);

CREATE TABLE IF NOT EXISTS trunk_bucket (
  uid TEXT PRIMARY KEY,
  bucket TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

const MIGRATIONS = {
  // v2：日记索引表（每天一条，属于情感枝的索引，不是第六枝）。
  2: (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS diary (
      date TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      mood TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  },
  // v3：看板「待写入哪条枝」的持久化请求（跨页面/刷新保留）。
  3: (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS placement (
      id TEXT PRIMARY KEY,
      node_id INTEGER,
      text TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL DEFAULT 'user',
      kind TEXT NOT NULL DEFAULT 'task',
      status TEXT NOT NULL DEFAULT 'pending',
      recommended_subject TEXT NOT NULL DEFAULT '',
      recommended_title TEXT NOT NULL DEFAULT '',
      recommended_group TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS placement_status ON placement(status, updated_at);`);
  },
  // v4：判断叶「待确定写入」补丁 + 已写入批次记录。
  4: (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS pending_patch (
      id TEXT PRIMARY KEY,
      node_id INTEGER,
      uid TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      old_num TEXT NOT NULL,
      new_num TEXT NOT NULL,
      old_text TEXT NOT NULL,
      new_text TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'text',
      base_checksum TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      batch_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pending_patch_status ON pending_patch(status, updated_at);
    CREATE INDEX IF NOT EXISTS pending_patch_uid ON pending_patch(uid);
    CREATE TABLE IF NOT EXISTS patch_batch (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'applied',
      base_checksum TEXT NOT NULL DEFAULT '',
      plan_json TEXT,
      backup TEXT,
      rules INTEGER NOT NULL DEFAULT 0,
      refs INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at INTEGER NOT NULL,
      applied_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS patch_batch_created ON patch_batch(created_at);`);
  },
  // v5：主干大标题（看板折叠分组，由用户指定；不改 AGENTS.md）。
  // 只存「覆盖」：没有记录的规则仍按 §1 编号自动分组。
  5: (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS trunk_bucket (
      uid TEXT PRIMARY KEY,
      bucket TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  },
};

export function currentVersion(db) {
  const row = db.prepare("PRAGMA user_version").get();
  const v = row ? Object.values(row)[0] : 0;
  return Number(v) || 0;
}

function hasTable(db, name) {
  const row = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return Boolean(row);
}

// 旧 v0 库可能只有 node 的一部分列。按当前结构补齐；uid/checksum 这类唯一键单独填值。
function repairNodeColumns(db) {
  const have = new Set(db.prepare("PRAGMA table_info(node)").all().map((c) => c.name));
  const columns = [
    ["uid", "TEXT NOT NULL DEFAULT ''"],
    ["scope", "TEXT NOT NULL DEFAULT 'user'"],
    ["layer", "TEXT NOT NULL DEFAULT 'leaf'"],
    ["kind", "TEXT NOT NULL DEFAULT 'note'"],
    ["status", "TEXT NOT NULL DEFAULT 'active'"],
    ["subject", "TEXT NOT NULL DEFAULT ''"],
    ["title", "TEXT NOT NULL DEFAULT ''"],
    ["text", "TEXT NOT NULL DEFAULT ''"],
    ["summary", "TEXT"],
    ["tags", "TEXT NOT NULL DEFAULT '[]'"],
    ["source", "TEXT NOT NULL DEFAULT 'manual'"],
    ["evidence", "TEXT"],
    ["trust", "INTEGER NOT NULL DEFAULT 70"],
    ["importance", "REAL NOT NULL DEFAULT 0.5"],
    ["half_life_days", "REAL NOT NULL DEFAULT 0"],
    ["valid_until", "INTEGER"],
    ["superseded_by", "INTEGER"],
    ["checksum", "TEXT NOT NULL DEFAULT ''"],
    ["len", "REAL NOT NULL DEFAULT 0"],
    ["ts", "INTEGER NOT NULL DEFAULT 0"],
    ["created_at", "INTEGER NOT NULL DEFAULT 0"],
    ["updated_at", "INTEGER NOT NULL DEFAULT 0"],
  ];
  for (const [name, decl] of columns) {
    if (!have.has(name)) db.exec("ALTER TABLE node ADD COLUMN " + name + " " + decl);
  }
  // 旧行没有 uid/checksum：用主键生成稳定且唯一的值，避免唯一索引失败。
  db.exec("UPDATE node SET uid='legacy-node:'||id||'-'||lower(hex(randomblob(4))) WHERE uid IS NULL OR uid=''");
  db.exec("UPDATE node SET checksum='legacy-'||id WHERE checksum IS NULL OR checksum=''");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS node_uid_unique ON node(uid)");
}

export function migrate(db) {
  let v = currentVersion(db);
  // v0 且已有 node 表：这是未写 user_version 的旧库/半建库。
  // 不能直接把版本设成 5，否则缺列的库会在第一次查询时才炸；先补齐 node 的关键列。
  if (v === 0 && hasTable(db, "node")) {
    repairNodeColumns(db);
  }
  db.exec(SCHEMA_SQL);
  if (v === 0) {
    db.exec("PRAGMA user_version = " + SCHEMA_VERSION);
    v = SCHEMA_VERSION;
  }
  while (v < SCHEMA_VERSION) {
    const next = v + 1;
    const fn = MIGRATIONS[next];
    if (typeof fn !== "function") throw new Error("缺少 v" + next + " 的迁移函数");
    db.exec("BEGIN IMMEDIATE");
    try {
      fn(db);
      db.exec("PRAGMA user_version = " + next);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    v = next;
  }
  if (v > SCHEMA_VERSION) {
    throw new Error(
      "数据库版本 v" + v + " 比插件支持的 v" + SCHEMA_VERSION + " 新：请升级插件，或先备份后另存一份库再打开。",
    );
  }
  try {
    db.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(SCHEMA_VERSION));
  } catch {
    /* meta 写失败不影响主流程 */
  }
  return v;
}
