### Task 6: SSE streaming (snapshot, append, resync, broadcast)

**Files:**
- Modify: `index.ts` (replace the whole server section from Task 5 with the version below)
- Modify: `selftest.ts` (extend import — none needed; append SSE test block inside the same file)

**Interfaces:**
- Modifies: `WebServer` becomes `{ port: number; stop(): void; broadcast(name: string, data: unknown): void; onSessionChanged(newLeaf: string | null): void }`.
- `GET /events` (token-gated) now: writes `retry: 2000`, then `event: snapshot` with `{entries, meta}` from `api.getSnapshot()`, registers the client with `lastLeaf = meta.leafId`, sends `: hb` keep-alive every 15 s, removes the client on socket close.
- `onSessionChanged(newLeaf)`: per client, `diffLeaf(api.allEntries(), client.lastLeaf, newLeaf)` → `append` (sanitized entries) / `resync` (full `api.getSnapshot()` payload) / nothing.
- `stop()` also closes all open SSE connections.

- [ ] **Step 1: Write the failing tests** — in `selftest.ts`, append this block before the final `console.log` (after `httpTests()`; it starts its own server instance):

```typescript
// ---------- SSE streaming ----------
async function sseTests(): Promise<void> {
  const entries: Record<string, unknown>[] = [
    { type: "message", id: "a", parentId: null, timestamp: "1", message: { role: "user", content: "hi" } },
    { type: "message", id: "b", parentId: "a", timestamp: "2", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
  ];
  const byId = new Map(entries.map((e) => [e.id as string, e]));
  const api = {
    getSnapshot: () => ({
      entries: entries.map((e) => sanitizeEntry(e) as AnyRec),
      meta: { cwd: "/tmp", model: "p/m", sessionName: null, leafId: entries.length ? entries[entries.length - 1].id as string : null },
    }),
    allEntries: () => byId,
    sendInput: async () => ({ queued: false }),
    stopAgent: () => ({ aborted: false }),
  };
  const ws = await startServer({
    host: "127.0.0.1", port: 0,
    passwordHash: hashPassword("testpw123"), tokens: new Set<string>(), api,
  });
  const base = "http://127.0.0.1:" + ws.port;
  const login = await fetch(base + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "testpw123" }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  // keep an SSE connection open and accumulate everything it receives
  const client = await new Promise<{ get: () => string; close: () => void }>((resolve, reject) => {
    const chunks: string[] = [];
    const req = http.get(base + "/events", { headers: { cookie } }, (res) => {
      res.on("data", (c: Buffer) => chunks.push(c.toString()));
      resolve({ get: () => chunks.join(""), close: () => req.destroy() });
    });
    req.on("error", reject);
  });
  const waitUntil = (needle: string, ms: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      const t = setInterval(() => {
        if (client.get().includes(needle)) { clearInterval(t); resolve(); }
        else if (Date.now() - t0 > ms) { clearInterval(t); reject(new Error("timeout waiting for: " + needle)); }
      }, 20);
    });

  try {
    await waitUntil("event: snapshot", 3000);
    const m = client.get().match(/event: snapshot\ndata: (.+)/);
    const snap = m ? (JSON.parse(m[1]) as { entries: unknown[]; meta: { model: string } }) : null;
    check("sse: snapshot delivered with 2 entries + meta", !!snap && snap.entries.length === 2 && snap.meta.model === "p/m");
    check("sse: retry hint sent", client.get().includes("retry: 2000"));

    ws.broadcast("status", { busy: true });
    await waitUntil("event: status", 3000);
    check("sse: broadcast reaches client", client.get().includes('"busy":true'));

    entries.push({ type: "message", id: "c", parentId: "b", timestamp: "3", message: { role: "user", content: "again" } });
    byId.set("c", entries[2]);
    ws.onSessionChanged("c");
    await waitUntil("event: append", 3000);
    check("sse: descendant leaf -> append containing new entry",
      client.get().includes("event: append") && client.get().includes('"id":"c"'));

    ws.onSessionChanged("unknown-leaf");
    await waitUntil("event: resync", 3000);
    check("sse: non-descendant leaf -> resync snapshot", client.get().includes("event: resync"));
  } finally {
    client.close();
    ws.stop();
  }
}

await sseTests();
```

also add `import http from "node:http";` at the top of `selftest.ts` (used by `http.get` in the SSE client).

- [ ] **Step 2: Run to verify it fails**

Run: `node selftest.ts`
Expected: `ws.broadcast is not a function` (red).

- [ ] **Step 3: Implement** — in `index.ts`, replace the entire server section (from `// Web server (spec §5)` to the end of file) with:

```typescript
// ---------------------------------------------------------------------------
// Web server (spec §5). Zero-dependency node:http.
// ---------------------------------------------------------------------------

const BODY_LIMIT = 100 * 1024;   // spec: 100 KB body limit
const INPUT_LIMIT = 32 * 1024;   // spec: input text 32 KB
const KEEPALIVE_MS = 15000;      // spec: SSE keep-alive comment every 15s

export interface SnapshotMeta {
  cwd: string;
  model: string;
  sessionName: string | null;
  leafId: string | null;
}

/** Pi-side dependency seam. Task 7 implements this against a live session. */
export interface WebApi {
  getSnapshot(): { entries: AnyRec[]; meta: SnapshotMeta };
  allEntries(): Map<string, AnyRec>;
  sendInput(text: string): Promise<{ queued: boolean }>;
  stopAgent(): { aborted: boolean };
}

export interface WebServer {
  port: number; // actual bound port (may differ from requested)
  stop(): void;
  /** Push one SSE event to every authenticated, connected client. */
  broadcast(name: string, data: unknown): void;
  /** Session leaf moved: per-client append / resync (spec §5 change-detection). */
  onSessionChanged(newLeaf: string | null): void;
}

interface SseClient {
  res: http.ServerResponse;
  hb: ReturnType<typeof setInterval>;
  lastLeaf: string | null;
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        const err = new Error("body too large");
        (err as { code?: string }).code = "BODY_TOO_LARGE";
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, obj: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(obj));
}

function html(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

function parseJsonBody(raw: string): AnyRec | null {
  try { return JSON.parse(raw) as AnyRec; } catch { return null; }
}

function safeWrite(res: http.ServerResponse, s: string): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try { res.write(s); return true; } catch { return false; }
}

/** One SSE frame. JSON.stringify keeps data on a single line (newlines escaped). */
function writeSse(res: http.ServerResponse, name: string, data: unknown): boolean {
  return safeWrite(res, "event: " + name + "\ndata: " + JSON.stringify(data) + "\n\n");
}

export function startServer(opts: {
  host?: string;
  port: number;
  passwordHash: string;
  tokens: Set<string>;
  api: WebApi;
}): Promise<WebServer> {
  const { passwordHash, tokens, api } = opts;
  const clients = new Set<SseClient>();
  let closed = false;
  const server = http.createServer((req, res) => { void handle(req, res); });

  function openSse(res: http.ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    safeWrite(res, "retry: 2000\n\n");
    const snap = api.getSnapshot();
    writeSse(res, "snapshot", { entries: snap.entries, meta: snap.meta });
    const client: SseClient = {
      res,
      hb: setInterval(() => { if (!safeWrite(res, ": hb\n\n")) res.end(); }, KEEPALIVE_MS),
      lastLeaf: snap.meta.leafId,
    };
    clients.add(client);
    res.on("close", () => { clearInterval(client.hb); clients.delete(client); });
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = (req.url || "/").split("?")[0];
    const token = tokenFromCookie(req.headers.cookie);
    const authed = token !== null && tokens.has(token);
    try {
      // --- public: page + login ---
      if (req.method === "GET" && url === "/") {
        html(res, 200, authed ? CHAT_PAGE : LOGIN_PAGE);
        return;
      }
      if (req.method === "POST" && url === "/login") {
        const raw = await readBody(req, BODY_LIMIT);
        const body = parseJsonBody(raw);
        const pw = typeof body?.password === "string" ? (body.password as string) : "";
        if (!verifyPassword(pw, passwordHash)) { json(res, 401, { error: "bad password" }); return; }
        const t = issueToken();
        tokens.add(t);
        json(res, 200, { ok: true }, { "Set-Cookie": cookieHeader(t) });
        return;
      }
      // --- everything below requires a valid token cookie ---
      if (!authed) { json(res, 401, { error: "unauthenticated" }); return; }

      if (req.method === "GET" && url === "/events") {
        openSse(res);
        return;
      }
      if (req.method === "POST" && url === "/input") {
        const raw = await readBody(req, BODY_LIMIT);
        const body = parseJsonBody(raw);
        if (!body) { json(res, 400, { error: "bad json" }); return; }
        const text = typeof body.text === "string" ? (body.text as string).trim() : "";
        if (!text) { json(res, 400, { error: "empty message" }); return; }
        if (text.length > INPUT_LIMIT) { json(res, 400, { error: "message too long" }); return; }
        const r = await api.sendInput(text);
        json(res, 200, { ok: true, queued: r.queued });
        return;
      }
      if (req.method === "POST" && url === "/stop") {
        json(res, 200, api.stopAgent());
        return;
      }
      if (req.method === "POST" && url === "/logout") {
        if (token) tokens.delete(token);
        json(res, 200, { ok: true }, { "Set-Cookie": clearCookieHeader() });
        return;
      }
      json(res, 404, { error: "not found" });
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (res.headersSent) { res.end(); return; }
      if (e.code === "BODY_TOO_LARGE") { json(res, 413, { error: "body too large" }); return; }
      if (e.code === "NO_CTX") { json(res, 503, { error: "session is ending" }); return; }
      json(res, 500, { error: e.message || "server error" });
    }
  }

  const web: WebServer = {
    port: opts.port,
    stop() {
      closed = true;
      const cs = [...clients];
      clients.clear();
      for (const c of cs) { clearInterval(c.hb); c.res.end(); }
      server.close();
    },
    broadcast(name, data) {
      if (closed) return;
      for (const c of [...clients]) {
        if (!writeSse(c.res, name, data)) c.res.end();
      }
    },
    onSessionChanged(newLeaf) {
      if (closed) return;
      const byId = api.allEntries();
      for (const c of [...clients]) {
        const diff = diffLeaf(byId, c.lastLeaf, newLeaf);
        if (diff.kind === "append") {
          writeSse(c.res, "append", {
            entries: diff.entries.map(sanitizeEntry).filter((x): x is AnyRec => x !== null),
          });
          c.lastLeaf = newLeaf;
        } else if (diff.kind === "resync") {
          const snap = api.getSnapshot();
          writeSse(c.res, "resync", { entries: snap.entries, meta: snap.meta });
          c.lastLeaf = snap.meta.leafId ?? newLeaf;
        } else {
          c.lastLeaf = newLeaf;
        }
        if (c.res.writableEnded || c.res.destroyed) c.res.end();
      }
    },
  };

  return new Promise<WebServer>((resolve, reject) => {
    server.once("error", reject); // surfaces EADDRINUSE to the caller
    server.listen(opts.port, opts.host ?? "0.0.0.0", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") web.port = addr.port;
      resolve(web);
    });
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node selftest.ts && npx tsc -p tsconfig.json`
Expected: all `ok` (unit + http + sse blocks), `0 failed`, tsc silent.

---

