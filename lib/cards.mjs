// lib/cards.mjs — 把任务枝卡导出成插件可读的快照。
//
// 为什么要有这个文件：QQ / B站 等插件不在记忆树进程里，不能直接调 memory_* 工具。
// 记忆树把「当前 active 的任务卡」写成一份 JSON，插件启动/组装提示词时读它，
// 这样主人在记忆树里改卡后，插件下一次唤醒就能拿到新规则，不需要改插件配置。
import fs from "node:fs";
import path from "node:path";

export const CARDS_FILE_NAME = "cards.json";

/**
 * 写 <dataDir>/cards.json。
 * 结构：{ version, exportedAt, cards: { [subject]: { id, uid, scope, title, text, updatedAt } } }
 * 同 subject 多张 active 卡时，store.cards() 已按 created_at DESC 取最新一张。
 */
export function exportTaskCards(store, dataDir) {
  const nodes = store.cards();
  const cards = Object.create(null);
  const scoped = Object.create(null);
  for (const n of nodes) {
    const subject = String(n.subject ?? "").trim();
    if (!subject) continue;
    const entry = {
      id: n.id,
      uid: n.uid,
      scope: n.scope,
      title: n.title,
      text: n.text,
      updatedAt: n.updatedAt,
    };
    if (!scoped[n.scope]) scoped[n.scope] = Object.create(null);
    scoped[n.scope][subject] = entry;
    // 顶层 cards 保持「一个 subject 一张」的旧契约：user 优先，其余取较新的一张。
    // 同 subject 的其它工作区版本仍可从 scoped[scope][subject] 取到，不再静默覆盖。
    const prev = cards[subject];
    if (!prev || n.scope === "user" || (prev.scope !== "user" && String(n.updatedAt) > String(prev.updatedAt))) {
      cards[subject] = entry;
    }
  }
  const payload = { version: 1, exportedAt: new Date().toISOString(), cards, scoped };
  const file = path.join(dataDir, CARDS_FILE_NAME);
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return { ok: true, file, count: Object.keys(cards).length, exportedAt: payload.exportedAt };
}

/** 读回快照（给 CLI/诊断用，不供插件热路径调用）。 */
export function readTaskCards(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, CARDS_FILE_NAME), "utf8"));
  } catch {
    return null;
  }
}
