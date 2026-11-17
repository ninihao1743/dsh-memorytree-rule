// lib/levels.mjs — 信任程度的六档中文名与数值映射。
//
// 界面只显示中文；数字只存在于库里，用来排序与提升候选。
// 「待定修复」「忽略删除」是标记，不会自动删除任何条目。

export const TRUST_LEVELS = [
  { key: "core", label: "信任核心", trust: 100 },
  { key: "high", label: "高等信任", trust: 90 },
  { key: "mid", label: "中等信任", trust: 80 },
  { key: "low", label: "低等信任", trust: 60 },
  { key: "pending", label: "待定修复", trust: 40 },
  { key: "ignore", label: "忽略删除", trust: 10 },
];

function nearest(list, value, field) {
  let best = list[0];
  let gap = Infinity;
  for (const level of list) {
    const d = Math.abs(Number(level[field]) - Number(value));
    if (d < gap) {
      gap = d;
      best = level;
    }
  }
  return best;
}

export function trustLevel(value) {
  return nearest(TRUST_LEVELS, Number(value ?? 0), "trust");
}

export function trustByKey(key) {
  return TRUST_LEVELS.find((l) => l.key === String(key)) || null;
}

/** 候选条目：信任选到「中等信任」或更高，自动转正式。 */
export function shouldPromoteByTrust(key) {
  const i = TRUST_LEVELS.findIndex((l) => l.key === String(key));
  return i >= 0 && i <= 2;
}
