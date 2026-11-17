// dsh-memorytree-rule — Memorytree 的独立插件入口。
//
// 只做一件事：把 8 个 memory_* 工具与看板写操作路由注册进宿主。所有状态落在 SQLite；
// 看板的「写入正本」在显式确认后会修改 AGENTS.md 并立刻同步，其余写操作只改库。
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { buildTools } from "./lib/tools.mjs";
import { MemoryRuntime } from "./lib/runtime.mjs";
import { buildReportHtml } from "./lib/report.mjs";
import { findAgentSectionRule } from "./lib/rules.mjs";
import {
  BOARD_TOKEN_HEADER,
  buildThinkPrompt,
  ensureBoardToken,
  runBoardAction,
} from "./lib/board.mjs";

export const name = "dsh-memorytree-rule";
export const inject = ["tools"];

const MAX_BODY = 1_000_000;
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "SAMEORIGIN",
};

function sendJson(res, code, body) {
  res.writeHead(code, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** 常量时间比较，避免按字节时序猜令牌。 */
function safeEqual(a, b) {
  const ha = createHash("sha256").update(String(a ?? "")).digest();
  const hb = createHash("sha256").update(String(b ?? "")).digest();
  return timingSafeEqual(ha, hb);
}

/** 只接受本机回环 Host：即使宿主监听 0.0.0.0，也不把看板暴露到局域网。 */
function isLocalHost(hostHeader) {
  const raw = String(hostHeader ?? "").trim();
  if (!raw) return false;
  try {
    const hostname = new URL("http://" + raw).hostname.replace(/^\[|\]$/g, "");
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

function isLoopbackAddress(addr) {
  const s = String(addr ?? "");
  return s === "127.0.0.1" || s === "::1" || s.startsWith("127.") || s === "::ffff:127.0.0.1" || s.startsWith("::ffff:127.");
}

function sameOrigin(req) {
  const origin = String(req.headers.origin ?? "");
  if (!origin) return true; // 命令行/curl 不带 Origin
  try {
    return new URL(origin).host === String(req.headers.host ?? "");
  } catch {
    return false;
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("请求体过大（上限 1 MB）"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function samePath(a, b) {
  try {
    const norm = (p) => path.resolve(String(p)).replace(/[\\/]+$/, "");
    const a2 = norm(a);
    const b2 = norm(b);
    return process.platform === "win32" ? a2.toLowerCase() === b2.toLowerCase() : a2 === b2;
  } catch {
    return false;
  }
}

/** 把看板的“深度思考”请求投回当前 DSH 会话，或新建一个会话再投递。 */
async function wakeSession(webCtx, sessionId, text, options = {}) {
  const sc = webCtx.get?.("sessionController") ?? webCtx.sessionController;
  if (!sc?.resolveAgent) return { ok: false, error: "宿主没有 sessionController，无法把请求发进会话" };
  const requested = options.target === "new" ? "new" : "current";
  let target = requested;
  let sid = sessionId ? String(sessionId) : "";
  let cwd = options.cwd ? path.resolve(String(options.cwd)) : "";
  let redirected = false;
  let currentCwd = "";
  let currentResolved = null;

  if (sid) {
    try {
      currentResolved = await sc.resolveAgent(sid);
      const raw = currentResolved?.agent?.session?.header?.cwd;
      currentCwd = raw ? String(raw) : "";
      if (!cwd && currentCwd) cwd = currentCwd;
    } catch {
      /* 当前会话拿不到目录时，按调用方给的 cwd 兜底 */
    }
  }

  // 看板固定要求把会话落在配置的工作区；当前会话不在该工作区时，
  // 不再往旧会话发，改为在工作区新建一个会话，避免落到【未分组】。
  if (target === "current") {
    if (!sid) {
      target = "new";
      redirected = true;
    } else if (cwd && (!currentCwd || !samePath(currentCwd, cwd))) {
      target = "new";
      redirected = true;
    }
  }

  if (target === "new") {
    if (typeof sc.create !== "function") {
      return { ok: false, error: "当前 DSH 版本不支持从看板新建会话；请先发到当前会话。" };
    }
    if (!cwd) {
      return { ok: false, error: "看板没有配置工作区（memory-tree config.json 的 boardCwd），无法新建会话。" };
    }
    let created;
    try {
      created = await sc.create({ cwd });
    } catch (err) {
      return { ok: false, error: "新建会话失败：" + (err?.message ?? String(err)).slice(0, 200) };
    }
    sid = String(created?.sessionId ?? created?.agent?.id ?? "");
    if (!sid) return { ok: false, error: "新建会话没有返回会话编号" };
  }

  if (!sid) return { ok: false, error: "看板没有绑定 DSH 会话；请在本会话运行 memory_admin action=report 后重试" };
  let resolved = currentResolved;
  if (!resolved || target === "new") {
    try {
      resolved = await sc.resolveAgent(sid);
    } catch (err) {
      return { ok: false, error: "找不到会话：" + (err?.message ?? String(err)) };
    }
  }
  const agent = resolved?.agent;
  if (!agent) return { ok: false, error: "找不到会话：" + String(resolved?.error?.message ?? resolved?.error ?? sid).slice(0, 160) };
  try {
    agent.followup({
      id: randomUUID(),
      role: "user",
      content: [{ type: "text", text: String(text) }],
      source: { kind: "memory-tree-board" },
    });
  } catch (err) {
    return { ok: false, error: "投递到会话失败：" + (err?.message ?? String(err)) };
  }
  try {
    const sessions = webCtx.get?.("sessions") ?? webCtx.sessions;
    if (sessions?.flush) await sessions.flush(agent.session);
  } catch {
    /* followup 已入收件箱；flush 失败不当作致命错误 */
  }
  return {
    ok: true,
    sessionId: sid,
    target,
    cwd: cwd || currentCwd,
    message:
      target === "new"
        ? (redirected
          ? "当前会话不在配置的工作区，已在 " + cwd + " 新建会话并投递；打开左侧新会话查看优化建议。"
          : "已在 " + cwd + " 新建会话并投递；打开左侧新会话查看优化建议。")
        : "已发到当前 DSH 会话，深度分析会出现在会话里；本页不会自动刷新结果。",
  };
}

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {{dataDir?:string,dbFile?:string,agentsPath?:string,legacyDb?:string,redact?:boolean,autoSync?:boolean}} config
 */
export function apply(ctx, config = {}) {
  const runtime = new MemoryRuntime(config ?? {});
  // 与本机版一致：令牌落在 dataDir/board-token，重启后看板链接仍可用。
  runtime.board.token = ensureBoardToken(runtime.paths.dataDir);
  // 插件启动先导出一次任务卡快照；QQ / B站 等插件读 cards.json 拿自己的卡。
  try {
    runtime.exportCards();
  } catch (err) {
    ctx.logger?.warn?.("[dsh-memorytree-rule] 任务卡快照导出失败: " + (err?.message ?? err));
  }

  ctx.effect(() => {
    const disposers = [];
    for (const tool of buildTools(runtime)) {
      disposers.push(ctx.tools.register(tool));
    }
    return () => {
      // 先撤工具再关库，避免卸载过程中还有调用打进来。
      for (const dispose of disposers.reverse()) {
        try {
          if (typeof dispose === "function") dispose();
        } catch {
          /* 卸载阶段忽略单条工具的清理错误 */
        }
      }
      runtime.close();
    };
  });

  // 记住最近活跃的会话：看板从侧栏打开时往往还没有一次工具调用，
  // 只靠 noteExec 会让“深度思考”按钮拿不到 sessionId。
  ctx.effect(() => {
    if (typeof ctx.on !== "function") return () => {};
    try {
      const off = ctx.on("session/event", (session) => {
        const id = session?.header?.id ?? session?.id;
        if (id) runtime.noteSession(id);
      });
      return () => {
        try {
          if (typeof off === "function") off();
        } catch {
          /* 卸载阶段忽略 */
        }
      };
    } catch {
      return () => {};
    }
  });

  // 看板写操作需要 DSH 的本地 Web 服务；没有 webServer 时降级为只读看板。
  if (typeof ctx.inject === "function") {
    ctx.inject(["webServer"], (webCtx) => {
      try {
        const port = webCtx.webServer?.port;
        const host = webCtx.webServer?.host && webCtx.webServer.host !== "0.0.0.0" ? webCtx.webServer.host : "127.0.0.1";
        const protocol = webCtx.webServer?.protocol || "http:";
        if (port) runtime.board.base = `${protocol}//${host}:${port}`;
      } catch {
        /* 端口取不到时保持空，看板按同源相对路径工作 */
      }

      webCtx.effect(
        () =>
          webCtx.webServer.register({
            kind: "prefix",
            path: "/memory-tree",
            handler: async (req, res) => {
              const url = new URL(req.url ?? "/", "http://memory-tree.local");
              const pathname = url.pathname;
              // 看板只服务本机回环地址；POST 还要求同源，挡住局域网访问与 DNS rebinding。
              // Host 头可以被伪造，必须同时看 TCP 连接的真实来源地址。
              if (!isLocalHost(req.headers.host) || !isLoopbackAddress(req.socket?.remoteAddress)) {
                sendJson(res, 403, { ok: false, error: "只允许本机访问看板。" });
                return;
              }
              if (req.method === "POST" && !sameOrigin(req)) {
                sendJson(res, 403, { ok: false, error: "跨站请求被拒绝。" });
                return;
              }
              if (req.method === "OPTIONS") {
                res.writeHead(204, { "cache-control": "no-store" });
                res.end();
                return;
              }
              try {
                if (req.method === "GET" && pathname === "/memory-tree/health") {
                  const store = runtime.open();
                  const stats = store.stats();
                  sendJson(res, 200, {
                    ok: true,
                    plugin: "dsh-memorytree-rule",
                    board: runtime.board.base ? runtime.board.base + "/memory-tree/board" : "/memory-tree/board",
                    hasSession: Boolean(runtime.board.sessionId),
                    indexVersion: stats.indexVersion,
                  });
                  return;
                }
                if (req.method === "GET" && (pathname === "/memory-tree/board" || pathname === "/memory-tree/board/")) {
                  const store = runtime.open();
                  try {
                    runtime.ensureTrunk(runtime.lastExec);
                  } catch {
                    /* 同步失败不阻断看板；看板仍展示库内现状 */
                  }
                  const html = buildReportHtml(runtime, store, runtime.lastExec, {
                    audit: false,
                    board: { base: "", token: runtime.board.token, sessionId: runtime.board.sessionId },
                  });
                  const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";
                  res.writeHead(200, { ...SECURITY_HEADERS, "content-security-policy": csp, "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
                  res.end(html);
                  return;
                }
                if (req.method === "POST" && pathname === "/memory-tree/action") {
                  const token = String(req.headers[BOARD_TOKEN_HEADER] ?? "");
                  if (!runtime.board.token || !safeEqual(token, runtime.board.token)) {
                    sendJson(res, 403, { ok: false, error: "看板写操作令牌无效；请重新生成看板。" });
                    return;
                  }
                  const body = await readJson(req);
                  const store = runtime.open();
                  if (body.op === "think") {
                    let node = null;
                    if (body.ruleNum) {
                      const num = String(body.ruleNum).trim();
                      try {
                        const rule = findAgentSectionRule(fs.readFileSync(runtime.paths.agentsPath, "utf8"), num);
                        if (rule) node = { id: 0, uid: rule.num, title: rule.title, text: rule.text, layer: "trunk", scope: "user" };
                      } catch {
                        node = null;
                      }
                    } else {
                      node = store.get(Number(body.id));
                    }
                    if (!node) {
                      sendJson(res, 404, { ok: false, error: "找不到这条记忆（可能已被删除或归档）" });
                      return;
                    }
                    if (!runtime.board.sessionId) {
                      sendJson(res, 409, { ok: false, error: "看板还没有绑定 DSH 会话；请先在 DSH 里打开一次看板。" });
                      return;
                    }
                    const sessionId = runtime.board.sessionId;
                    const queued = await wakeSession(webCtx, sessionId, buildThinkPrompt(node, body.text), {
                      target: body.target === "new" ? "new" : "current",
                      cwd: runtime.paths.boardCwd,
                    });
                    sendJson(res, queued.ok ? 200 : 409, queued);
                    return;
                  }
                  const result = runBoardAction(store, body, {
                    ...runtime.trunkWriteOptions(),
                    sessionId: runtime.board.sessionId,
                    exportCards: () => runtime.exportCards(),
                  });
                  if (result.ok && result.prompt && result.placement) {
                    const sessionId = runtime.board.sessionId;
                    const queued = await wakeSession(webCtx, sessionId, result.prompt, {
                      target: "current",
                      cwd: runtime.paths.boardCwd,
                    });
                    delete result.prompt;
                    result.session = queued;
                    if (!queued.ok) {
                      result.mode = "placement-manual";
                      result.message =
                        "待写入请求已保存，但没能连到 DSH 会话（" +
                        String(queued.error || "未绑定会话").slice(0, 120) +
                        "）。你可以直接手动选择任务卡。";
                    } else {
                      result.message = "已把归类请求发到 DSH 会话；判断期间你可以手动选择任务卡。";
                    }
                  }
                  sendJson(res, result.ok ? 200 : 400, result);
                  return;
                }
                sendJson(res, 404, { ok: false, error: "not found" });
              } catch (err) {
                sendJson(res, 500, { ok: false, error: "记忆树看板处理失败，请查看 DSH 日志。" });
                try {
                  ctx.logger?.warn?.("memory-tree: board route failed: " + String(err?.stack ?? err));
                } catch {
                  /* 日志失败不影响响应 */
                }
              }
            },
          }),
        "memory-tree: board routes",
      );
    });
  }

  try {
    ctx.logger?.info?.(
      "memory-tree: 已注册 8 个记忆工具与看板路由（数据目录 " + runtime.paths.dataDir +
        (runtime.board.base ? "，看板 " + runtime.board.base + "/memory-tree/board" : "，看板路由待 Web 服务就绪") + "）",
    );
  } catch {
    /* 日志服务形状不同就算了，注册本身已经完成 */
  }
}

export default { name, inject, apply };
