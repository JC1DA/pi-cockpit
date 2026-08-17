// selftest.ts — run: node selftest.ts   (Node >= 23.6, native TS type stripping)
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashPassword, verifyPassword, issueToken, cookieHeader, clearCookieHeader, tokenFromCookie, sanitizeEntry, diffLeaf, inputOpts, startServer, default as piCockpit, type AnyRec, LOGIN_PAGE, CHAT_PAGE } from "./index.ts";

let failed = 0, passed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("ok   " + name); }
  else { failed++; console.error("FAIL " + name); }
}

// ---------- password ----------
{
  const h = hashPassword("hunter22");
  check("password: hash is 64 hex chars", /^[0-9a-f]{64}$/.test(h));
  check("password: correct password verifies", verifyPassword("hunter22", h));
  check("password: wrong password rejected", !verifyPassword("hunter23", h));
  check("password: length mismatch rejected", !verifyPassword("x", h));
  check("password: malformed hash rejected", !verifyPassword("hunter22", "nothex"));
  check("password: empty hash rejected", !verifyPassword("hunter22", ""));
}

// ---------- tokens / cookie ----------
{
  const t1 = issueToken(), t2 = issueToken();
  check("token: 64 hex chars", /^[0-9a-f]{64}$/.test(t1));
  check("token: unique", t1 !== t2);
  const ch = cookieHeader(t1);
  check("cookie: header has token + HttpOnly + SameSite=Lax + Max-Age=604800",
    ch.startsWith("remote_pi_session=" + t1) && ch.includes("HttpOnly") &&
    ch.includes("SameSite=Lax") && ch.includes("Max-Age=604800"));
  check("cookie: clear header has Max-Age=0", clearCookieHeader().includes("Max-Age=0"));
  check("cookie: parse finds token among others", tokenFromCookie("a=1; remote_pi_session=abc; b=2") === "abc");
  check("cookie: parse missing -> null", tokenFromCookie("a=1") === null);
  check("cookie: parse undefined header -> null", tokenFromCookie(undefined) === null);
  check("cookie: parse empty value -> null", tokenFromCookie("remote_pi_session=") === null);
}

// ---------- entry sanitizer + leaf diff ----------
{
  const msg = sanitizeEntry({ type: "message", id: "a", parentId: "p", timestamp: "t",
    message: { role: "user", content: "hi" }, secret: 1 });
  check("sanitize: message keeps whitelisted fields only",
    JSON.stringify(msg) === JSON.stringify({ type: "message", id: "a", timestamp: "t",
      message: { role: "user", content: "hi" } }));
  check("sanitize: unknown type dropped", sanitizeEntry({ type: "???", id: "a" }) === null);

  const tree: Record<string, unknown>[] = [
    { type: "message", id: "a", parentId: null, timestamp: "1", message: { role: "user", content: "m1" } },
    { type: "message", id: "b", parentId: "a", timestamp: "2", message: { role: "assistant", content: [{ type: "text", text: "r1" }] } },
    { type: "message", id: "c", parentId: "b", timestamp: "3", message: { role: "user", content: "m2" } },
    { type: "message", id: "d", parentId: "c", timestamp: "4", message: { role: "assistant", content: [{ type: "text", text: "r2" }] } },
    { type: "model_change", id: "e", parentId: "a", timestamp: "5", provider: "p", modelId: "m2" },
  ];
  const byId = new Map(tree.map((e) => [e.id as string, e]));
  check("diffLeaf: same leaf -> none", diffLeaf(byId, "d", "d").kind === "none");
  const app = diffLeaf(byId, "a", "d");
  check("diffLeaf: descendant -> append [b,c,d] oldest-first",
    app.kind === "append" && (app as { entries: AnyRec[] }).entries.map((x) => x.id).join(",") === "b,c,d");
  check("diffLeaf: non-descendant -> resync", diffLeaf(byId, "d", "e").kind === "resync");
  check("diffLeaf: unknown new leaf -> resync", diffLeaf(byId, "a", "zz").kind === "resync");
  check("diffLeaf: null last leaf -> resync", diffLeaf(byId, null, "d").kind === "resync");
}

// ---------- pages ----------
{
  const scriptOf = (page: string): string[] => {
    const out: string[] = [];
    const re = /<script>([\s\S]*?)<\/script>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(page)) !== null) out.push(m[1]);
    return out;
  };
  const syntaxOk = (page: string): boolean => {
    const scripts = scriptOf(page);
    if (scripts.length === 0) return false;
    return scripts.every((s) => { try { new Function(s); return true; } catch { return false; } });
  };
  check("page: login has password input and posts to /login",
    LOGIN_PAGE.includes('type="password"') && LOGIN_PAGE.includes("'/login'"));
  check("page: login script syntax valid", syntaxOk(LOGIN_PAGE));
  check("page: chat uses EventSource on /events", CHAT_PAGE.includes("new EventSource('/events')"));
  check("page: chat script syntax valid", syntaxOk(CHAT_PAGE));
  check("page: no template literals leak into pages",
    !LOGIN_PAGE.includes("`") && !CHAT_PAGE.includes("`") &&
    !LOGIN_PAGE.includes("${") && !CHAT_PAGE.includes("${"));

  const chatScript = scriptOf(CHAT_PAGE)[0] ?? "";
  const fnSrc = (name: string): string | null => {
    const i = chatScript.indexOf("function " + name + "(");
    if (i < 0) return null;
    const j = chatScript.indexOf("\n}", i);
    return j < 0 ? null : chatScript.slice(i, j + 2);
  };
  type UsageInfo = { tokens: number | null; contextWindow: number; percent: number | null };
  const fmtSrc = fnSrc("fmtTok");
  const usageSrc = fnSrc("usageText");
  const fmtTok = fmtSrc ? (new Function(fmtSrc + "; return fmtTok;")() as (n: number) => string) : null;
  const usageText = fmtSrc && usageSrc
    ? (new Function(fmtSrc + "; " + usageSrc + "; return usageText;")() as (u: UsageInfo | null) => string)
    : null;
  check("page: fmtTok compacts token counts",
    !!fmtTok && fmtTok(999) === "999" && fmtTok(45321) === "45k" && fmtTok(200000) === "200k" &&
    fmtTok(1500000) === "1.5M" && fmtTok(2000000) === "2M");
  check("page: usageText renders segment, dash for null tokens, empty for no usage",
    !!usageText && usageText({ tokens: 45321, contextWindow: 200000, percent: 22.66 }) === "45k/200k (23%)" &&
    usageText({ tokens: null, contextWindow: 200000, percent: null }) === "—/200k" &&
    usageText(null) === "");

  check("page: mobile CSS wraps meta and hides cwd",
    CHAT_PAGE.includes("@media (max-width:640px)") && CHAT_PAGE.includes("m-cwd"));

  const metaSegSrc = fnSrc("metaSeg");
  const upMetaSrc = fnSrc("updateMetaLine");
  type FakeEl = { children: FakeEl[]; textContent: string; className: string; appendChild(c: FakeEl): void };
  const fakeEl = (): FakeEl => {
    const children: FakeEl[] = [];
    return { children, textContent: "", className: "", appendChild: (c) => { children.push(c); } };
  };
  const fakeDoc = { title: "", createElement: () => fakeEl() };
  const runMeta = (cm: Record<string, unknown>): FakeEl =>
    (new Function("document", "curMeta", "metaEl",
      fmtSrc + "\n" + usageSrc + "\n" + metaSegSrc + "\n" + upMetaSrc +
      "\nupdateMetaLine(); return metaEl;")(fakeDoc, cm, fakeEl()) as FakeEl);

  const el1 = metaSegSrc && upMetaSrc ? runMeta({ sessionName: "s1", model: "p/m", cwd: "/w", usage: { tokens: 45321, contextWindow: 200000, percent: 22.66 } }) : null;
  check("page: meta line builds segment spans incl. usage",
    !!el1 && el1.children.length === 4 &&
    el1.children[0].className === "m m-session" && el1.children[0].textContent === "s1" &&
    el1.children[3].className === "m m-usage" && el1.children[3].textContent === "45k/200k (23%)");
  const el2 = metaSegSrc && upMetaSrc ? runMeta({ sessionName: null, model: "", cwd: "/w", usage: null }) : null;
  check("page: meta line omits usage segment when absent",
    !!el2 && el2.children.length === 3 && el2.children[0].textContent === "pi session");
}

// ---------- http server (fake pi api) ----------
async function httpTests(): Promise<void> {
  const entries: Record<string, unknown>[] = [
    { type: "message", id: "a", parentId: null, timestamp: "1", message: { role: "user", content: "hi" } },
    { type: "message", id: "b", parentId: "a", timestamp: "2", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
  ];
  const byId = new Map(entries.map((e) => [e.id as string, e]));
  const sent: string[] = [];
  let stopCalls = 0;
  const api = {
    getSnapshot: () => ({
      entries: entries.map((e) => sanitizeEntry(e) as AnyRec),
      meta: { cwd: "/tmp", model: "p/m", sessionName: null, leafId: entries.length ? entries[entries.length - 1].id as string : null, usage: { tokens: null, contextWindow: 200000, percent: null } },
    }),
    allEntries: () => byId,
    sendInput: async (t: string) => { sent.push(t); return { queued: true }; },
    stopAgent: () => { stopCalls++; return { aborted: true }; },
  };
  const tokens = new Set<string>();
  const ws = await startServer({ host: "127.0.0.1", port: 0, passwordHash: hashPassword("testpw123"), tokens, api });
  const base = "http://127.0.0.1:" + ws.port;
  check("server: binds to requested (ephemeral) port", ws.port > 0);

  const loginPage = await fetch(base + "/").then((r) => r.text());
  check("http: / unauthenticated serves login page", loginPage.includes('type="password"'));

  check("http: login wrong password -> 401",
    (await fetch(base + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "wrong" }) })).status === 401);

  const good = await fetch(base + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "testpw123" }) });
  const setCookie = good.headers.get("set-cookie") ?? "";
  check("http: login ok -> 200 + Set-Cookie", good.status === 200 && setCookie.startsWith("remote_pi_session="));
  const cookie = setCookie.split(";")[0];

  const chatPage = await fetch(base + "/", { headers: { cookie } }).then((r) => r.text());
  check("http: / with cookie serves chat page", chatPage.includes("new EventSource('/events')"));

  check("http: bad json login -> 401 (empty password)",
    (await fetch(base + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" })).status === 401);

  // deviation: brief's `(async () => { ... })()` IIFE passes a Promise where check() takes a boolean
  // (fails tsc; truthy-promise also made the check a false positive and raced the next check).
  // Direct await, same condition.
  const inputOk = await fetch(base + "/input", { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ text: "hello agent" }) });
  check("http: /input ok -> 200 queued",
    inputOk.status === 200 && ((await inputOk.json()) as { queued?: boolean }).queued === true && sent[0] === "hello agent");

  check("http: /input without cookie -> 401",
    (await fetch(base + "/input", { method: "POST", body: JSON.stringify({ text: "x" }) })).status === 401);

  check("http: /input blank -> 400",
    (await fetch(base + "/input", { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ text: "   " }) })).status === 400);

  check("http: /input bad json -> 400",
    (await fetch(base + "/input", { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: "{nope" })).status === 400);

  check("http: /input oversized -> 413",
    (await fetch(base + "/input", { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ text: "x".repeat(200000) }) })).status === 413);

  const st = await fetch(base + "/stop", { method: "POST", headers: { cookie } });
  check("http: /stop -> 200 + stopAgent called", st.status === 200 && stopCalls === 1);

  // deviation: same IIFE fix as above
  const logout = await fetch(base + "/logout", { method: "POST", headers: { cookie } });
  check("http: /logout -> 200 + clears cookie",
    logout.status === 200 && (logout.headers.get("set-cookie") ?? "").includes("Max-Age=0"));

  check("http: token invalid after logout",
    (await fetch(base + "/input", { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ text: "x" }) })).status === 401);

  ws.stop();
}

// ---------- input dispatch options ----------
check("inputOpts: slash input always expands (command/skill/template dispatch)",
  inputOpts("/new", true).expandPromptTemplates === true && inputOpts("/compact now", false).expandPromptTemplates === true);
check("inputOpts: non-slash input never expands",
  inputOpts("hello", false).expandPromptTemplates === false && inputOpts("hello", true).expandPromptTemplates === false);
check("inputOpts: busy queues as followUp, idle delivers directly",
  inputOpts("hello", false).deliverAs === "followUp" && inputOpts("hello", true).deliverAs === undefined && inputOpts("/new", true).deliverAs === undefined);

await httpTests();

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
      meta: { cwd: "/tmp", model: "p/m", sessionName: null, leafId: entries.length ? entries[entries.length - 1].id as string : null, usage: { tokens: null, contextWindow: 200000, percent: null } },
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
    const snap = m ? (JSON.parse(m[1]) as { entries: unknown[]; meta: { model: string; usage: { tokens: number | null; contextWindow: number; percent: number | null } | null } }) : null;
    check("sse: snapshot delivered with 2 entries + meta", !!snap && snap.entries.length === 2 && snap.meta.model === "p/m");
    check("sse: snapshot meta carries context usage", !!snap && !!snap.meta.usage && snap.meta.usage.contextWindow === 200000);
    ws.broadcast("meta", { usage: { tokens: 123, contextWindow: 1000, percent: 12 } });
    await waitUntil('"tokens":123', 3000);
    check("sse: meta broadcast with usage reaches client", client.get().includes("event: meta") && client.get().includes('"tokens":123'));
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

    // session replacement (e.g. /new): resyncAll pushes the fresh snapshot
    entries.length = 0;
    entries.push({ type: "message", id: "n1", parentId: null, timestamp: "9", message: { role: "user", content: "fresh" } });
    byId.set("n1", entries[0]);
    ws.resyncAll();
    await waitUntil('"id":"n1"', 3000);
    check("sse: resyncAll pushes the new session's snapshot to clients", client.get().includes('"id":"n1"'));

    // controller-approved: broadcast must never throw, even for a non-serializable payload
    let circThrew = false;
    {
      const circ: Record<string, unknown> = {};
      circ.self = circ;
      try { ws.broadcast("update", circ); } catch { circThrew = true; }
    }
    check("sse: broadcast of non-serializable (circular) payload does not throw", !circThrew);
  } finally {
    client.close();
    ws.stop();
  }
}

await sseTests();

// ---------- pi wiring: session replacement keeps the running server ----------
// pi re-invokes the extension factory with a fresh closure on every session
// replacement and invalidates the old ctx; the fix under test is module-scope
// server state, so the NEW closure's session_start rebinds curCtx and resyncs
// the SAME running server (review finding C1). Phase 2 covers the /resume cwd
// policy: cross-cwd resumes make pi re-IMPORT the module (fresh instance), so
// the shutdown handler must stop the server there; same-cwd keeps it.
async function wiringTests(): Promise<void> {
  type Cmd = { description?: string; handler: (args: string, ctx: unknown) => Promise<void> };
  const makeFakePi = () => {
    const handlers = new Map<string, Array<(e: unknown, ctx: unknown) => unknown>>();
    const commands = new Map<string, Cmd>();
    const sent: Array<{ text: string }> = [];
    return {
      commands,
      sent,
      emit(event: string, e: unknown, ctx: unknown): void {
        for (const h of handlers.get(event) ?? []) h(e, ctx);
      },
      pi: {
        on: (event: string, h: (e: unknown, ctx: unknown) => unknown) => {
          const arr = handlers.get(event) ?? [];
          arr.push(h);
          handlers.set(event, arr);
        },
        registerCommand: (name: string, o: Cmd) => { commands.set(name, o); },
        sendUserMessage: (text: string) => { sent.push({ text }); },
      } as unknown as Parameters<typeof piCockpit>[0],
    };
  };
  const makeCtx = (entries: Record<string, unknown>[], leafId: string | null) => {
    const ui = {
      notes: [] as string[],
      passwords: ["testpw123"],
      notify(msg: string, kind: string): void { this.notes.push(kind + ": " + msg); },
      input(): Promise<string | undefined> { return Promise.resolve(this.passwords.shift()); },
      setStatus(): void {},
    };
    const usage: { tokens: number | null; contextWindow: number; percent: number | null } = { tokens: null, contextWindow: 200000, percent: null };
    return {
      ui,
      usage,
      ctx: {
        ui,
        sessionManager: {
          getEntries: () => entries,
          buildContextEntries: () => entries,
          getCwd: () => "/w",
          getSessionName: () => null,
          getLeafId: () => leafId,
        },
        model: undefined,
        isIdle: () => true,
        abort(): void {},
        compact(): void {},
        newSession: async () => ({ cancelled: false }),
        getContextUsage: () => ({ ...usage }),
      },
    };
  };

  const PORT = 39412;
  const fake1 = makeFakePi();
  piCockpit(fake1.pi);
  const c1 = makeCtx([{
    type: "message", id: "e1", parentId: null, timestamp: "1",
    message: { role: "user", content: "first" },
  }], "e1");
  fake1.emit("session_start", { type: "session_start", reason: "start" }, c1.ctx);

  await fake1.commands.get("webserve")!.handler("start " + PORT, c1.ctx);
  const note = c1.ui.notes.find((n) => n.includes("web viewer:")) ?? "";
  const m = note.match(/localhost:(\d+)/);
  check("wiring: /webserve start binds the shared server", !!m);
  if (!m) { check("wiring: abort, no server started", false); return; }
  const base = "http://127.0.0.1:" + m[1];
  const login = await fetch(base + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "testpw123" }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

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

  let fake2: ReturnType<typeof makeFakePi> | null = null;
  let c2: ReturnType<typeof makeCtx> | null = null;
  try {
    await waitUntil("event: snapshot", 3000);

    const in1 = await fetch(base + "/input", { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ text: "before-new" }) });
    check("wiring: /input works on the first session",
      in1.status === 200 && fake1.sent.some((s) => s.text === "before-new"));

    c1.usage.tokens = 45000;
    c1.usage.percent = 22;
    fake1.emit("agent_settled", { type: "agent_settled" }, c1.ctx);
    await waitUntil('"tokens":45000', 3000);
    check("wiring: agent_settled broadcasts meta with fresh context usage",
      client.get().includes("event: meta") && client.get().includes('"tokens":45000'));

    c1.usage.tokens = 46000;
    c1.usage.percent = 23;
    fake1.emit("model_select", { type: "model_select", model: { provider: "p2", id: "m9" } }, c1.ctx);
    await waitUntil('"tokens":46000', 3000);
    check("wiring: model_select rebroadcasts meta with model + fresh usage",
      client.get().includes('"model":"p2/m9"') && client.get().includes('"tokens":46000'));

    await fake1.commands.get("new")!.handler("", c1.ctx);
    await waitUntil("event: note", 3000);
    check("wiring: web /new command broadcasts a note to clients",
      client.get().includes("/new: new session started"));

    // session replacement: the OLD closure gets shutdown, a NEW factory
    // invocation gets session_start (exactly what pi does on /new)
    fake1.emit("session_shutdown", { type: "session_shutdown", reason: "new" }, c1.ctx);
    fake2 = makeFakePi();
    piCockpit(fake2.pi);
    c2 = makeCtx([{
      type: "message", id: "n1", parentId: null, timestamp: "9",
      message: { role: "user", content: "fresh" },
    }], "n1");
    fake2.emit("session_start", { type: "session_start", reason: "new" }, c2.ctx);

    await waitUntil('"id":"n1"', 3000);
    check("wiring: session replacement resyncs existing clients to the new session",
      client.get().includes("event: resync") && client.get().includes('"id":"n1"'));

    const in2 = await fetch(base + "/input", { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ text: "after-new" }) });
    check("wiring: /input works after replacement via the same server",
      in2.status === 200 && fake2.sent.some((s) => s.text === "after-new"));

    await fake2.commands.get("webserve")!.handler("stop", c2.ctx);
    check("wiring: /webserve stop from the new closure stops the shared server",
      c2.ui.notes.some((n) => n.includes("web viewer stopped")));
    let refused = false;
    try {
      const r = await fetch(base + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "testpw123" }) });
      refused = r.status !== 200;
    } catch { refused = true; }
    check("wiring: port released after stop", refused);
  } finally {
    client.close();
    if (fake2 && c2) { try { await fake2.commands.get("webserve")!.handler("stop", c2.ctx); } catch { /* already stopped */ } }
  }

  // --- phase 2: /resume cwd policy (index.ts session_shutdown) ---
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-cockpit-st-"));
  const writeHead = (f: string, cwd: string): Promise<void> =>
    fs.promises.writeFile(path.join(tmp, f), JSON.stringify({ type: "session", id: "s", cwd }) + "\n");
  let fake3: ReturnType<typeof makeFakePi> | null = null;
  let c3: ReturnType<typeof makeCtx> | null = null;
  try {
    await writeHead("other.jsonl", "/elsewhere");
    await writeHead("same.jsonl", "/w"); // makeCtx's fake cwd

    fake3 = makeFakePi();
    piCockpit(fake3.pi);
    c3 = makeCtx([{
      type: "message", id: "e3", parentId: null, timestamp: "1",
      message: { role: "user", content: "three" },
    }], "e3");
    c3.ui.passwords.push("testpw123"); // second start in this phase
    fake3.emit("session_start", { type: "session_start", reason: "start" }, c3.ctx);
    await fake3.commands.get("webserve")!.handler("start 39413", c3.ctx);
    const note3 = c3.ui.notes.find((n) => n.includes("web viewer:")) ?? "";
    const m3 = note3.match(/localhost:(\d+)/);
    check("wiring: server up for resume-policy phase", !!m3);
    if (!m3) { check("wiring: resume phase abort, no server", false); return; }
    const base3 = "http://127.0.0.1:" + m3[1];
    const up = async (): Promise<boolean> => {
      try { return (await fetch(base3 + "/")).status === 200; } catch { return false; } // GET / serves the login page
    };
    check("wiring: resume phase server serves", await up());

    fake3.emit("session_shutdown", { type: "session_shutdown", reason: "resume", targetSessionFile: path.join(tmp, "other.jsonl") }, c3.ctx);
    check("wiring: cross-cwd /resume stops the shared server", !(await up()));

    await fake3.commands.get("webserve")!.handler("start 39413", c3.ctx);
    check("wiring: restart after cross-cwd stop", await up());

    fake3.emit("session_shutdown", { type: "session_shutdown", reason: "resume", targetSessionFile: path.join(tmp, "same.jsonl") }, c3.ctx);
    check("wiring: same-cwd /resume keeps the server", await up());
  } finally {
    if (fake3 && c3) { try { await fake3.commands.get("webserve")!.handler("stop", c3.ctx); } catch { /* ok */ } }
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
}

await wiringTests();

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);