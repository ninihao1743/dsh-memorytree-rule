// lib/demo.mjs — `mt demo`：在临时目录里生成一套四枝示例，不碰真实记忆库。
//
// 目的：刚装插件的 DSH 打开看板时不是空的，而是能看到「主干/情感枝/任务枝/判断叶」
// 各自长什么样、状态如何流转。所有条目都带「示例」标签；临时目录可随时删除。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryRuntime } from "./runtime.mjs";
import { buildReportHtml } from "./report.mjs";
import { localDate } from "./diary.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO_AGENTS = path.join(HERE, "..", "examples", "AGENTS.demo.md");

function seed(store) {
  const add = (input) => store.add({ source: "demo", tags: ["示例"], ...input });

  // 情感枝：一段叙事 + 一条工作感受。都标「示例」，不是真实经历。
  add({
    layer: "emotion",
    scope: "user",
    subject: "相处",
    title: "示例：用户更在意能不能接上",
    text:
      "示例，不是真实记忆：用户在一次长任务收尾时说「今天先到这，剩下的明天接上」。当时没有催进度，只把未完成项和路径写进任务清单；" +
      "第二天新会话按清单接回，用户说「这样就对了」。这条记的是「用户更在意能不能接上，而不是一次做完」，不是任务日志。测试完可删。",
    evidence: "「今天先到这，剩下的明天接上」——示例原话，非真实记录",
    tags: ["示例", "情感枝", "相处"],
    importance: 0.8,
    trust: 80,
    halfLifeDays: 0,
  });
  add({
    layer: "emotion",
    scope: "user",
    subject: "工作感受",
    title: "示例：先给结论更省沟通",
    text: "示例，不是真实记忆：用户对「先给结论、再给验证方式」的汇报最认可；只报「已完成」会被追问细节。测试完可删。",
    tags: ["示例", "情感枝", "工作感受"],
    importance: 0.6,
    trust: 75,
    halfLifeDays: 180,
  });

  // 任务枝：同一 subject 先放一张旧卡，再放新卡，演示旧卡自动转 superseded。
  add({
    layer: "task",
    scope: "user",
    subject: "memorytree",
    title: "记忆树插件（旧示例卡）",
    text: "示例旧卡：只写了「装完先跑 doctor」。这张卡会被下面的新卡自动取代，但不会删除，方便追溯。",
    tags: ["示例", "任务枝", "memorytree"],
    importance: 0.5,
    trust: 60,
    halfLifeDays: 0,
  });
  add({
    layer: "task",
    scope: "user",
    subject: "memorytree",
    title: "记忆树插件：安装与排障",
    text:
      "示例任务卡：① 装完先跑 `node bin/mt.mjs doctor`，看数据目录、库、AGENTS.md、旧库四项；" +
      "② 改完插件代码要重装/重启 DSH，别只改源码就以为生效；" +
      "③ 不要把 `trunk` 手写成 active，手动写入只会落 candidate，主干 active 只由 AGENTS.md 同步产生；" +
      "④ 不要直接改 `memory.db`，用 `memory_*` 工具或 CLI；" +
      "⑤ 物理删除前先导出或确认有备份。测试完可删。",
    evidence: "本机实测：空 DSH_HOME 下 doctor 正常退出；`mt demo` 可用临时库复现四枝。",
    tags: ["示例", "任务枝", "memorytree", "排障"],
    importance: 0.8,
    trust: 85,
    halfLifeDays: 0,
  });

  // 判断叶：两条待分拣、一条零散观察。
  add({
    layer: "leaf",
    scope: "user",
    title: "示例：先别改 = 暂停，不是撤销",
    text: "示例，待确认：用户说「先别改」时，通常指暂停当前改动，不是撤销已经改好的内容。未验证，先放判断叶。",
    tags: ["示例", "判断叶", "待确认"],
    importance: 0.4,
    trust: 55,
    halfLifeDays: 30,
  });
  add({
    layer: "leaf",
    scope: "user",
    title: "示例：报错先贴原文",
    text: "示例候选规则：报错时先贴原始错误，再给解释和修法。还没验证，先放判断叶，等日结决定去留。",
    tags: ["示例", "判断叶", "候选规则"],
    importance: 0.35,
    trust: 50,
    halfLifeDays: 30,
  });
  add({
    layer: "leaf",
    scope: "user",
    title: "示例：周五更适合整理",
    text: "示例零散观察：周五下午用户更愿意做整理类任务。样本太少，不上升为规则。",
    tags: ["示例", "判断叶", "观察"],
    importance: 0.25,
    trust: 45,
    halfLifeDays: 14,
  });

  // 主干候选：展示「手动写入 trunk 只会是 candidate」。
  add({
    layer: "trunk",
    scope: "user",
    title: "示例候选：收尾写清未完成项",
    text: "示例主干候选：收尾时把未完成项、下一步和关键路径写进任务清单，新会话按清单接回。这条不是 active 规则，等用户点头后才并入主干。",
    tags: ["示例", "主干候选"],
    importance: 0.6,
    trust: 55,
    halfLifeDays: 0,
  });

  store.diaryAdd(
    localDate(),
    "示例日记（不是真实记录）：今天跑了 `mt demo`，看了四枝示例和看板；这一步只写「做了什么、路径」，情感本体不写在这里。",
    "示例",
  );

  return store.stats();
}

/**
 * 生成隔离演示库。
 * @param {{out?: string}} opts
 * @returns {{ok: boolean, dir: string, agentsPath: string, dbFile: string, reportPath: string, stats: object, sync: object}}
 */
export function runDemo(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memorytree-demo-"));
  const agentsPath = path.join(dir, "AGENTS.md");
  fs.copyFileSync(DEMO_AGENTS, agentsPath);

  const rt = new MemoryRuntime({ dataDir: dir, agentsPath, autoSync: false });
  try {
    const store = rt.open();
    const sync = rt.ensureTrunk(null, { force: true });
    if (!sync.ok) throw new Error("演示主干同步失败：" + (sync.reason || "未知原因"));
    const stats = seed(store);
    const html = buildReportHtml(rt, store, null, { board: { base: "", token: "", sessionId: null } });
    const reportPath = opts.out ? path.resolve(String(opts.out)) : path.join(dir, "report.html");
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, html, "utf8");
    return {
      ok: true,
      dir,
      agentsPath,
      dbFile: rt.paths.dbFile,
      reportPath,
      stats,
      sync,
    };
  } finally {
    rt.close();
  }
}
