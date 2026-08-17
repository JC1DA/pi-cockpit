### Task 7: Pi wiring (commands, events, lifecycle) + e2e

**Files:**
- Modify: `index.ts` (extend top imports; append factory + `lanUrls` at the end)

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces: `export default function (pi: ExtensionAPI): void` — registers `/webserve` and all event handlers.
- Behavior (spec §3, §4): server only starts from the command; password via `ctx.ui.input` (min 4 chars); binds 0.0.0.0; auto-increments port up to 10 attempts on EADDRINUSE; `session_shutdown` stops it; web input = `pi.sendUserMessage` (idle → plain, busy → `followUp`); web Stop = `ctx.abort()`.

- [ ] **Step 1: Extend the imports** — replace the import line at the top of `index.ts` with:

```typescript
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
```

- [ ] **Step 2: Implement the factory** — append at the end of `index.ts`:

```typescript
// ---------------------------------------------------------------------------
// Pi wiring (spec §3–§4). Server state lives only in this closure:
// in-memory, per session instance, never persisted (spec §7).
// ---------------------------------------------------------------------------

function lanUrls(port: number): string[] {
  const out = ["http://localhost:" + port];
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) {
      if (i.family === "IPv4" && !i.internal) out.push("http://" + i.address + ":" + port);
    }
  }
  return out;
}

function noCtxError(): Error {
  const e = new Error("session is ending");
  (e as { code?: string }).code = "NO_CTX";
  return e;
}

export default function (pi: ExtensionAPI): void {
  let server: WebServer | null = null;
  let tokens = new Set<string>();
  let passwordHash = "";
  let curCtx: ExtensionContext | null = null;

  const stopServer = (): void => {
    if (!server) return;
    server.stop();
    server = null;
    if (curCtx) curCtx.ui.setStatus("webserve", undefined);
  };

  const api: WebApi = {
    getSnapshot() {
      const ctx = curCtx;
      if (!ctx) throw noCtxError();
      const sm = ctx.sessionManager;
      return {
        entries: sm.buildContextEntries().map((e) => sanitizeEntry(e as AnyRec)).filter((x): x is AnyRec => x !== null),
        meta: {
          cwd: sm.getCwd(),
          model: ctx.model ? (ctx.model as { provider: string; id: string }).provider + "/" + (ctx.model as { provider: string; id: string }).id : "",
          sessionName: sm.getSessionName() ?? null,
          leafId: sm.getLeafId(),
        },
      };
    },
    allEntries() {
      const m = new Map<string, AnyRec>();
      if (curCtx) {
        for (const e of curCtx.sessionManager.getEntries()) m.set(e.id, e as AnyRec);
      }
      return m;
    },
    async sendInput(text) {
      const ctx = curCtx;
      if (!ctx) throw noCtxError();
      if (ctx.isIdle()) {
        pi.sendUserMessage(text);
        return { queued: false };
      }
      pi.sendUserMessage(text, { deliverAs: "followUp" });
      return { queued: true };
    },
    stopAgent() {
      const ctx = curCtx;
      if (!ctx || ctx.isIdle()) return { aborted: false };
      ctx.abort(); // programmatic Esc (spec §5 /stop)
      return { aborted: true };
    },
  };

  const leaf = (): string | null => (curCtx ? curCtx.sessionManager.getLeafId() : null);
  const changed = (): void => { server?.onSessionChanged(leaf()); };

  // --- session lifecycle ---
  pi.on("session_start", (_e, ctx) => { curCtx = ctx; });
  pi.on("session_shutdown", (_e, _ctx) => {
    stopServer();
    curCtx = null;
  });

  // --- live stream (spec §5 SSE events) ---
  pi.on("message_update", (e, ctx) => {
    curCtx = ctx;
    server?.broadcast("update", e.message);
  });
  pi.on("message_end", (_e, ctx) => {
    curCtx = ctx;
    changed();
  });
  pi.on("tool_execution_start", (e, _ctx) => {
    server?.broadcast("toolstart", { id: e.toolCallId, name: e.toolName, args: e.args });
  });
  pi.on("tool_execution_end", (_e, ctx) => {
    curCtx = ctx;
    changed();
  });
  pi.on("model_select", (e, ctx) => {
    curCtx = ctx;
    server?.broadcast("meta", { model: (e.model as { provider: string; id: string }).provider + "/" + (e.model as { provider: string; id: string }).id });
    changed();
  });
  pi.on("session_compact", (_e, ctx) => { curCtx = ctx; changed(); });
  pi.on("session_tree", (_e, ctx) => { curCtx = ctx; changed(); });
  pi.on("session_info_changed", (_e, ctx) => { curCtx = ctx; changed(); });
  pi.on("agent_start", (_e, ctx) => { curCtx = ctx; server?.broadcast("status", { busy: true }); });
  pi.on("agent_settled", (_e, ctx) => { curCtx = ctx; server?.broadcast("status", { busy: false }); });

  // --- commands (spec §3) ---
  pi.registerCommand("webserve", {
    description: "Web session viewer: /webserve start [port] | stop | status",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = parts[0];

      if (sub === undefined || sub === "start") {
        if (server) {
          ctx.ui.notify("web viewer already running on port " + server.port, "info");
          return;
        }
        const reqPort = sub === undefined ? 8765 : Number(parts[1]);
        if (!Number.isInteger(reqPort) || reqPort < 1 || reqPort > 65535) {
          ctx.ui.notify("Usage: /webserve start [port]  (port 1-65535, default 8765)", "warning");
          return;
        }
        const pw = await ctx.ui.input("Web viewer password", "min 4 chars");
        if (!pw || pw.length < 4) {
          ctx.ui.notify("password must be 4+ chars; server not started", "warning");
          return;
        }
        passwordHash = hashPassword(pw);
        tokens = new Set();
        curCtx = ctx; // command ctx is valid for this session; covers the gap before the first event
        let lastErr: { message?: string } | null = null;
        for (let p = reqPort; p < reqPort + 10; p++) {
          try {
            server = await startServer({ host: "0.0.0.0", port: p, passwordHash, tokens, api });
            break;
          } catch (err) {
            lastErr = err as { message?: string };
            if ((err as { code?: string }).code !== "EADDRINUSE") break;
          }
        }
        if (!server) {
          passwordHash = "";
          ctx.ui.notify("web viewer failed to start: " + (lastErr?.message ?? "unknown error"), "error");
          return;
        }
        ctx.ui.notify("web viewer: " + lanUrls(server.port).join("   ") + "  (password required)", "info");
        ctx.ui.setStatus("webserve", "web :" + server.port);
      } else if (sub === "stop") {
        stopServer();
        ctx.ui.notify("web viewer stopped", "info");
      } else if (sub === "status") {
        ctx.ui.notify(server ? "web viewer running on port " + server.port : "web viewer not running", "info");
      } else {
        ctx.ui.notify("Usage: /webserve start [port] | stop | status", "warning");
      }
    },
  });
}
```

- [ ] **Step 3: Gate**

Run: `node selftest.ts && npx tsc -p tsconfig.json`
Expected: all `ok`, `0 failed`, tsc silent.

- [ ] **Step 4: Manual e2e smoke (spec §9)**

Run in one terminal: `cd /home/jc1da/Programs/LanyTek/remote_pi_ext && pi -e ./index.ts`

Then verify, in order (each line = PASS only if the stated observation holds):

1. `/webserve start` → password dialog appears → type a 4+ char password → notification lists `http://localhost:8765` (plus LAN URLs) and footer shows `web :8765`.
2. Open the URL in a browser (LAN machine or the host) → login page → wrong password shows `wrong password` → correct password loads the chat page showing the session so far.
3. Type a prompt in the TUI → in the browser, the assistant text streams live token-by-token in a dashed "pending" bubble; tool calls appear as `name — running...` then `name — done` with input/output.
4. In the browser, type a message and press Send → it appears as a user message in the TUI (as if typed there) and the agent responds; both views show it.
5. While the agent is working, click **Stop** in the browser → the run is interrupted exactly like Esc; busy dot turns green.
6. `/webserve status` → `running on port 8765`; `/webserve stop` → `stopped`; browser page no longer connects.
7. In a SECOND terminal: `pi -e ./index.ts` then `/webserve start` → notification shows port **8766** (auto-increment).

If any step fails: fix the root cause in `index.ts`, re-run `node selftest.ts && npx tsc -p tsconfig.json`, and re-run the failed step.

---

