// selftest.ts — run: node selftest.ts   (Node >= 23.6, native TS type stripping)
import http from "node:http";
import { hashPassword, verifyPassword, issueToken, cookieHeader, clearCookieHeader, tokenFromCookie, sanitizeEntry, diffLeaf, startServer, type AnyRec, LOGIN_PAGE, CHAT_PAGE } from "./index.ts";

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
      meta: { cwd: "/tmp", model: "p/m", sessionName: null, leafId: entries.length ? entries[entries.length - 1].id as string : null },
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

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);