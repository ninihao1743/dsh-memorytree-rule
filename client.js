// dsh-memorytree-rule 的客户端半边：在 DSH 左侧栏加一个「记忆树」入口，
// 点开后在主区域用同源 iframe 打开插件的星图看板（写按钮仍走 /memory-tree/action）。
//
// 为什么用 iframe：看板本身是自包含 HTML（星图/主题/抽屉/按钮都在页内），
// 直接复用同一份 /memory-tree/board 产物，避免把 170 KB 的页面逻辑再翻译成 React；
// iframe 与宿主同源，看板里的令牌与写请求都照常工作。页面本身不调 LLM。

window.__ModuleLoader__.load({
  id: "dsh-memorytree-rule",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    const PANEL_ID = "memory-tree";
    const BOARD_PATH = "/memory-tree/board?panel=1";
    const HEALTH_PATH = "/memory-tree/health";

    function MemoryTreeIcon({ size = 18 }) {
      const s = typeof size === "number" ? size : 18;
      return h(
        "svg",
        {
          viewBox: "0 0 24 24",
          width: s,
          height: s,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.6,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": true,
          style: { display: "block", flex: "none" },
        },
        h("path", { d: "M12 20v-7" }),
        h("path", { d: "M12 13 6.5 8.8M12 13l5.5-4.2" }),
        h("circle", { cx: 12, cy: 4.2, r: 1.7 }),
        h("circle", { cx: 5.2, cy: 7.4, r: 1.5 }),
        h("circle", { cx: 18.8, cy: 7.4, r: 1.5 }),
        h("circle", { cx: 12, cy: 13, r: 1.8, fill: "currentColor", stroke: "none" }),
      );
    }

    function ShellMessage({ title, detail }) {
      return h(
        "div",
        {
          style: {
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 32,
            color: "var(--dsw-alias-label-primary, #e8ecf5)",
            background: "var(--dsw-alias-bg-base, #0b1020)",
            font: "13px/1.7 system-ui, -apple-system, 'Segoe UI', sans-serif",
          },
        },
        h(
          "div",
          { style: { maxWidth: 520 } },
          h("div", { style: { fontSize: 16, fontWeight: 600, marginBottom: 8 } }, title),
          h("div", { style: { color: "var(--dsw-alias-label-secondary, #9aa4b8)" } }, detail),
          h(
            "a",
            {
              href: BOARD_PATH,
              target: "_blank",
              rel: "noreferrer",
              style: { display: "inline-block", marginTop: 16, color: "var(--dsw-alias-brand-primary, #6fb6ff)" },
            },
            "在新标签打开看板",
          ),
        ),
      );
    }

    function MemoryTreePage() {
      const [health, setHealth] = useState({ state: "checking" });
      const [nonce, setNonce] = useState(0);
      const wrapRef = useRef(null);

      // DSH 主区域会把非当前面板留在 DOM 里；只 mount 一次的 iframe 会一直显示打开时的旧快照。
      // 每次从隐藏变为可见时重载 iframe，保证「点开记忆树」看到的是当前库。
      useEffect(() => {
        const el = wrapRef.current;
        if (!el || typeof IntersectionObserver === "undefined") return;
        let first = true;
        let visible = false;
        const io = new IntersectionObserver(
          (entries) => {
            const now = entries.some((e) => e.isIntersecting);
            if (now && !visible) {
              if (!first) setNonce((n) => n + 1);
              first = false;
            }
            visible = now;
          },
          { threshold: 0.01 },
        );
        io.observe(el);
        return () => io.disconnect();
      }, []);

      useEffect(() => {
        let alive = true;
        let baseline = null;
        let timer = null;

        const check = () => {
          fetch(HEALTH_PATH, { cache: "no-store" })
            .then((res) => (res.ok ? res.json() : Promise.reject(new Error("HTTP " + res.status))))
            .then((data) => {
              if (!alive) return;
              if (!data || data.ok !== true) {
                setHealth({ state: "error", detail: "看板路由返回了异常状态。" });
                return;
              }
              setHealth({ state: "ok" });
              const version = data.indexVersion ?? data.total;
              if (version === null || version === undefined) return;
              if (baseline === null) {
                baseline = version;
                return;
              }
              if (version !== baseline) {
                baseline = version;
                setNonce((n) => n + 1);
              }
            })
            .catch((err) => {
              if (alive) setHealth({ state: "error", detail: String((err && err.message) || err) });
            });
        };

        check();
        timer = window.setInterval(check, 15000);
        return () => {
          alive = false;
          if (timer) window.clearInterval(timer);
        };
      }, []);

      if (health.state === "error") {
        return h(ShellMessage, {
          title: "记忆树看板暂不可用",
          detail:
            "没有连上本机的 /memory-tree 路由：" +
            health.detail +
            "。确认 dsh-memorytree-rule 插件已启用，然后重新加载 DSH 页面。",
        });
      }

      return h(
        "div",
        {
          ref: wrapRef,
          style: {
            position: "relative",
            height: "100%",
            minHeight: 0,
            display: "flex",
            background: "var(--dsw-alias-bg-base, #0b1020)",
          },
        },
        health.state === "checking"
          ? h(
              "div",
              {
                style: {
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--dsw-alias-label-secondary, #9aa4b8)",
                  font: "12px/1.5 system-ui, sans-serif",
                  pointerEvents: "none",
                },
              },
              "正在打开记忆树看板…",
            )
          : null,
        h("iframe", {
          key: nonce,
          src: BOARD_PATH + "&_=" + nonce,
          title: "记忆树看板",
          onLoad: function (e) {
            // 主区域是常驻 iframe；从别处切回来时浏览器可能恢复上次滚动位置。
            try {
              e.currentTarget.contentWindow.scrollTo(0, 0);
            } catch {
              /* 同源失败时保持原样 */
            }
          },
          style: {
            flex: "1 1 auto",
            width: "100%",
            height: "100%",
            border: 0,
            display: "block",
            background: "#0b1020",
          },
        }),
      );
    }

    function apply(ctx) {
      ctx.slots.inject("main", () =>
        ctx.slots.register({ name: "main", key: PANEL_ID }, MemoryTreePage),
      );
      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register(
          {
            name: "sidebar.panellist",
            id: PANEL_ID,
            order: 30,
            label: () => "记忆树",
          },
          MemoryTreeIcon,
        ),
      );
    }

    return { inject: ["slots"], apply };
  },
});
