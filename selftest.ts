// selftest.ts — run: node selftest.ts   (Node >= 23.6, native TS type stripping)
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashPassword, verifyPassword, issueToken, cookieHeader, clearCookieHeader, tokenFromCookie, sanitizeEntry, diffLeaf, inputOpts, startServer, default as piCockpit, type AnyRec, LOGIN_PAGE, CHAT_PAGE, buildAskEnvelope, extractAskQuestions, AskTuiComponent, ASK_RESERVED_LABELS, type AskQuestion, type AskOutcome } from "./index.ts";

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

  check("page: model picker modal wired (modelpick event -> /model command via /input)",
    CHAT_PAGE.includes("addEventListener('modelpick'") && CHAT_PAGE.includes("sendText('/model '") &&
    CHAT_PAGE.includes("'modelmask'"));

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

// ---------- ask_user_question bridge: envelope + extractor ----------
{
  const qs: AskQuestion[] = [
    { question: "Which library?", header: "Library", options: [{ label: "A", description: "da" }, { label: "B", description: "db" }] },
    { question: "Which features?", header: "Scope", multiSelect: true, options: [{ label: "X", description: "" }, { label: "Y", description: "" }] },
  ];
  const full = buildAskEnvelope(qs, {
    cancelled: false,
    answers: [
      { index: 0, kind: "option", answer: "A" },
      { index: 1, kind: "multi", selected: ["X", "Y"] },
    ],
  });
  check("ask envelope: exact rpiv wording for option + multi",
    full === 'User has answered your questions: "Which library?"="A". "Which features?"="X, Y". You can now continue with the user\'s answers in mind.');
  check("ask envelope: cancelled -> canonical decline",
    buildAskEnvelope(qs, { cancelled: true, answers: [] }) === "User declined to answer questions");
  check("ask envelope: unanswered -> canonical decline",
    buildAskEnvelope(qs, { cancelled: false, answers: [] }) === "User declined to answer questions");
  check("ask envelope: partial (unanswered contributes no segment)",
    buildAskEnvelope(qs, { cancelled: false, answers: [{ index: 0, kind: "option", answer: "B" }] }) ===
    'User has answered your questions: "Which library?"="B". You can now continue with the user\'s answers in mind.');
  check("ask envelope: custom text + user notes",
    buildAskEnvelope([qs[0]], { cancelled: false, answers: [{ index: 0, kind: "custom", answer: "my own words", notes: "because" }] }) ===
    'User has answered your questions: "Which library?"="my own words". user notes: because. You can now continue with the user\'s answers in mind.');
  check("ask envelope: empty custom/multi -> (no input)",
    buildAskEnvelope([qs[0], qs[1]], { cancelled: false, answers: [{ index: 0, kind: "custom", answer: null }, { index: 1, kind: "multi", selected: [] }] }) ===
    'User has answered your questions: "Which library?"="(no input)". "Which features?"="(no input)". You can now continue with the user\'s answers in mind.');

  const good = [{ question: "Q?", options: [{ label: "a", description: "" }, { label: "b", description: "" }] }];
  check("ask extract: valid input normalizes",
    (extractAskQuestions(good) as AskQuestion[])[0].options.length === 2);
  check("ask extract: preview capped at 2000",
    (extractAskQuestions([{ question: "Q?", options: [{ label: "a", description: "", preview: "x".repeat(5000) }, { label: "b", description: "" }] }]) as AskQuestion[])[0].options[0].preview?.length === 2000);
  check("ask extract: malformed -> null",
    extractAskQuestions(null) === null &&
    extractAskQuestions([]) === null &&
    extractAskQuestions([{ question: "Q?" }]) === null &&
    extractAskQuestions([{ question: "Q?", options: [{ label: "a" }] }]) === null &&
    extractAskQuestions([{ question: 5, options: [{ label: "a", description: "" }, { label: "b", description: "" }] }]) === null);
  check("ask reserved labels list", JSON.stringify(ASK_RESERVED_LABELS) === '["Other","Type something.","Next"]');
}

// ---------- ask bridge: terminal questionnaire component ----------
{
  const fakeTui = { requestRender(): void { /* noop */ } };
  const two: AskQuestion[] = [{ question: "Which option?", options: [{ label: "A", description: "da" }, { label: "B", description: "db" }] }];

  let result: AskOutcome | null | undefined;
  const c1 = new AskTuiComponent(two, fakeTui, (o) => { result = o; });
  const lines = c1.render(80);
  check("ask tui: renders boxed questionnaire with both options",
    lines[0].codePointAt(0) === 0x250c && lines[lines.length - 1].codePointAt(0) === 0x2514 &&
    lines.some((l) => l.includes("1. A")) && lines.some((l) => l.includes("2. B")) &&
    lines.some((l) => l.includes("Type something.")));
  c1.handleInput("\u001b[B"); // down
  check("ask tui: down moves cursor", c1.render(80).some((l) => />\s+2\. B/.test(l)));
  c1.handleInput("\r"); // enter
  check("ask tui: enter picks option -> answered outcome",
    !!result && !result.cancelled && result.answers.length === 1 &&
    result.answers[0].kind === "option" && result.answers[0].answer === "B");

  let r2: AskOutcome | null | undefined;
  const c2 = new AskTuiComponent(two, fakeTui, (o) => { r2 = o; });
  c2.handleInput("\u001b"); // esc
  check("ask tui: esc cancels the whole questionnaire",
    !!r2 && r2.cancelled === true && r2.answers.length === 0);

  let r3: AskOutcome | null | undefined;
  const c3 = new AskTuiComponent(two, fakeTui, (o) => { r3 = o; });
  c3.handleInput("\u001b[B"); c3.handleInput("\u001b[B"); // down x2 -> Type something. row
  c3.handleInput("\r"); // enter -> typing mode
  c3.handleInput("h"); c3.handleInput(" "); c3.handleInput("i"); c3.handleInput("\x7f"); c3.handleInput("y"); // "h y" — space must survive
  check("ask tui: typing mode edits the draft (space + backspace honored)", c3.render(80).some((l) => l.includes("> h y")));
  c3.handleInput("\r"); // enter -> commit custom
  check("ask tui: custom answer committed (with space)",
    !!r3 && !r3.cancelled && r3.answers[0].kind === "custom" && r3.answers[0].answer === "h y");

  const multi: AskQuestion[] = [{ question: "Pick some?", multiSelect: true, options: [{ label: "X", description: "" }, { label: "Y", description: "" }] }];
  let r4: AskOutcome | null | undefined;
  const c4 = new AskTuiComponent(multi, fakeTui, (o) => { r4 = o; });
  c4.handleInput(" "); // toggle 1
  c4.handleInput("\u001b[B"); // down
  c4.handleInput(" "); // toggle 2
  c4.handleInput("\r"); // enter -> advance
  check("ask tui: multi-select toggles + enter commits selection",
    !!r4 && !r4.cancelled && r4.answers[0].kind === "multi" && JSON.stringify(r4.answers[0].selected) === '["X","Y"]');

  let r5: AskOutcome | null | undefined;
  const c5 = new AskTuiComponent(two, fakeTui, (o) => { r5 = o; });
  c5.close();
  check("ask tui: close() signals no-answer (web side won)", r5 === null);
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

// ---------- ask bridge: server-side askUser ----------
async function askServerTests(): Promise<void> {
  const api = {
    getSnapshot: () => ({
      entries: [] as AnyRec[],
      meta: { cwd: "/tmp", model: "p/m", sessionName: null, leafId: null, usage: null },
    }),
    allEntries: () => new Map<string, AnyRec>(),
    sendInput: async () => ({ queued: false }),
    stopAgent: () => ({ aborted: false }),
  };
  const ws = await startServer({ host: "127.0.0.1", port: 0, passwordHash: hashPassword("testpw123"), tokens: new Set<string>(), api });
  const base = "http://127.0.0.1:" + ws.port;
  const qs: AskQuestion[] = [{ question: "Q?", options: [{ label: "A", description: "" }, { label: "B", description: "" }] }];

  check("ask server: clientCount starts at 0", ws.clientCount() === 0);
  check("ask server: askUser with no client resolves null", (await ws.askUser("n1", qs)) === null);

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
  const waitUntil = (needle: string, ms = 3000): Promise<void> => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const t = setInterval(() => {
      if (client.get().includes(needle)) { clearInterval(t); resolve(); }
      else if (Date.now() - t0 > ms) { clearInterval(t); reject(new Error("timeout: " + needle)); }
    }, 20);
  });

  try {
    check("ask server: clientCount 1 with a connected client", ws.clientCount() === 1);
    const p = ws.askUser("a1", qs);
    await waitUntil("event: ask");
    check("ask server: ask broadcast reaches the client with id + questions",
      client.get().includes('"id":"a1"') && client.get().includes('"question":"Q?"'));
    const r = await fetch(base + "/ask-answer", { method: "POST", headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ id: "a1", cancelled: false, answers: [{ index: 0, kind: "option", answer: "B" }] }) });
    check("ask server: /ask-answer -> 200", r.status === 200);
    const outcome = await p;
    check("ask server: askUser resolves with the posted answer",
      !!outcome && !outcome.cancelled && outcome.answers.length === 1 && outcome.answers[0].answer === "B");
    await waitUntil("ask-resolved");
    check("ask server: ask-resolved broadcast closes client modals", client.get().includes('"id":"a1"'));
    const dup = await fetch(base + "/ask-answer", { method: "POST", headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ id: "a1", cancelled: false, answers: [{ index: 0, kind: "option", answer: "B" }] }) });
    check("ask server: duplicate /ask-answer -> 409", dup.status === 409);
    const bad = await fetch(base + "/ask-answer", { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: "{nope" });
    check("ask server: bad json /ask-answer -> 400", bad.status === 400);

    const p2 = ws.askUser("a2", qs);
    client.close();
    check("ask server: last client leaving resolves pending ask with null", (await p2) === null);
  } finally {
    client.close();
    ws.stop();
  }
}

await askServerTests();

// ---------- pi wiring: session replacement keeps the running server ----------
// pi re-invokes the extension factory with a fresh closure on every session
// replacement and invalidates the old ctx; the fix under test is module-scope
// server state, so the NEW closure's session_start rebinds curCtx and resyncs
// the SAME running server (review finding C1). Phase 2 covers the /resume cwd
// policy: cross-cwd resumes make pi re-IMPORT the module (fresh instance), so
// the shutdown handler must stop the server there; same-cwd keeps it.
async function wiringTests(): Promise<void> {
  type Cmd = { description?: string; handler: (args: string, ctx: unknown) => Promise<void> };
  // Tiny model catalogue for the /model handler: p3/m2 shares its id with
  // p2/m2 (ambiguity test) and the fake setModel rejects p3 (no-API-key path).
  const MODELS = [
    { provider: "p", id: "m" },
    { provider: "p2", id: "m2" },
    { provider: "p3", id: "m2" },
  ];
  const makeFakePi = () => {
    const handlers = new Map<string, Array<(e: unknown, ctx: unknown) => unknown>>();
    const commands = new Map<string, Cmd>();
    const sent: Array<{ text: string }> = [];
    const setModelCalls: Array<{ provider: string; id: string }> = [];
    return {
      commands,
      sent,
      handlers,
      setModelCalls,
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
        setModel: (m: { provider: string; id: string }) => {
          setModelCalls.push(m);
          return Promise.resolve(m.provider !== "p3");
        },
      } as unknown as Parameters<typeof piCockpit>[0],
    };
  };
  type AskTestState = {
    lastComp: null | { handleInput(d: string): void; close?(): void };
    doneCalls: unknown[];
    tuiTypes: boolean;
  };
  const makeCtx = (entries: Record<string, unknown>[], leafId: string | null) => {
    const usage: { tokens: number | null; contextWindow: number; percent: number | null } = { tokens: null, contextWindow: 200000, percent: null };
    const ask: AskTestState = { lastComp: null, doneCalls: [], tuiTypes: false };
    // Emulates pi's custom() plumbing: runs the factory, resolves the returned
    // promise when the component's done() fires. tuiTypes simulates the local
    // user picking option 2 +50ms later.
    const fakeTui = { requestRender(): void {} };
    const ui = {
      notes: [] as string[],
      passwords: ["testpw123"],
      notify(msg: string, kind: string): void { this.notes.push(kind + ": " + msg); },
      input(): Promise<string | undefined> { return Promise.resolve(this.passwords.shift()); },
      setStatus(): void {},
      custom(factory: (t: unknown, th: unknown, kb: unknown, d: (r: unknown) => void) => AskTestState["lastComp"], _opts?: unknown): Promise<unknown> {
        let resolveFn!: (r: unknown) => void;
        const p = new Promise<unknown>((res) => { resolveFn = res; });
        const done = (o: unknown) => { ask.doneCalls.push(o); resolveFn(o); };
        const comp = factory(fakeTui, {}, {}, done);
        ask.lastComp = comp;
        if (ask.tuiTypes) setTimeout(() => { comp?.handleInput("\u001b[B"); comp?.handleInput("\r"); }, 50);
        return p;
      },
    };
    return {
      ui,
      usage,
      ask,
      ctx: {
        ui,
        sessionManager: {
          getEntries: () => entries,
          buildContextEntries: () => entries,
          getCwd: () => "/w",
          getSessionName: () => null,
          getLeafId: () => leafId,
        },
        model: undefined as { provider: string; id: string } | undefined,
        modelRegistry: {
          getAvailable: () => MODELS,
          find: (p: string, id: string) => MODELS.find((x) => x.provider === p && x.id === id),
        },
        scopedModels: [],
        hasUI: true,
        mode: "tui",
        signal: undefined,
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

    // web /model: picker broadcast, switch, ambiguous bare id, unknown, no API key
    c1.ctx.model = MODELS[0];
    await fake1.commands.get("model")!.handler("", c1.ctx);
    await waitUntil("event: modelpick", 3000);
    check("wiring: web /model broadcasts a picker with all choices and the current model",
      client.get().includes('"choices":["p/m","p2/m2","p3/m2"]') && client.get().includes('"current":"p/m"'));

    await fake1.commands.get("model")!.handler("p2/m2", c1.ctx);
    await waitUntil("/model: p2/m2", 3000);
    check("wiring: web /model provider/id calls pi.setModel and notes the switch",
      client.get().includes("/model: p2/m2") && fake1.setModelCalls.length === 1 && fake1.setModelCalls[0].provider === "p2");

    await fake1.commands.get("model")!.handler("m2", c1.ctx);
    await waitUntil("is ambiguous", 3000);
    check("wiring: web /model bare id matching two providers is ambiguous, no setModel",
      client.get().includes("p2/m2, p3/m2") && fake1.setModelCalls.length === 1);

    await fake1.commands.get("model")!.handler("nope/xyz", c1.ctx);
    await waitUntil("unknown model", 3000);
    check("wiring: web /model unknown model notes an error, no setModel",
      client.get().includes("unknown model") && fake1.setModelCalls.length === 1);

    await fake1.commands.get("model")!.handler("p3/m2", c1.ctx);
    await waitUntil("no API key", 3000);
    check("wiring: web /model without API key reports failure",
      client.get().includes("no API key for p3/m2") && fake1.setModelCalls.length === 2);

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

    // pi starts the resumed session right after shutdown: the new closure's
    // session_start rebinds curCtx (without it getSnapshot throws NO_CTX and
    // SSE clients can never connect — exactly what the real runtime does)
    c3 = makeCtx([{
      type: "message", id: "e3", parentId: null, timestamp: "1",
      message: { role: "user", content: "three" },
    }], "e3");
    fake3.emit("session_start", { type: "session_start", reason: "resume" }, c3.ctx);
    // --- phase 3: ask bridge (tool_call hook; web + terminal, first wins) ---
    const askEvent = (id: string) => ({
      type: "tool_call",
      toolName: "ask_user_question",
      toolCallId: id,
      input: {
        questions: [{
          question: "Which option?",
          header: "Choice",
          options: [{ label: "A", description: "da" }, { label: "B", description: "db" }],
        }],
      },
    });
    const toolCallHandler = (fake3 as unknown as { handlers: Map<string, Array<(e: unknown, ctx: unknown) => unknown>> }).handlers.get("tool_call")?.[0];
    check("wiring: ask tool_call handler registered", !!toolCallHandler);
    if (toolCallHandler) {
      // (a) no web client connected yet -> hook stays out of the way
      const r1 = await toolCallHandler(askEvent("tc-a"), c3.ctx) as { block?: boolean; reason?: string } | undefined;
      check("wiring: ask with no web client -> undefined (tool's own TUI flow)", r1 === undefined);

      const login3 = await fetch(base3 + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "testpw123" }) });
      const cookie3 = (login3.headers.get("set-cookie") ?? "").split(";")[0];
      const sse3 = await new Promise<{ get: () => string; close: () => void }>((resolve, reject) => {
        const chunks: string[] = [];
        const req = http.get(base3 + "/events", { headers: { cookie: cookie3 } }, (res) => {
          res.on("data", (c: Buffer) => chunks.push(c.toString()));
          resolve({ get: () => chunks.join(""), close: () => req.destroy() });
        });
        req.on("error", reject);
      });
      const waitIn3 = (needle: string, ms = 3000): Promise<void> => new Promise((resolve, reject) => {
        const t0 = Date.now();
        const t = setInterval(() => {
          if (sse3.get().includes(needle)) { clearInterval(t); resolve(); }
          else if (Date.now() - t0 > ms) { clearInterval(t); reject(new Error("timeout waiting for: " + needle)); }
        }, 20);
      });
      const envelope = (answer: string) =>
        'User has answered your questions: "Which option?"="' + answer + '". You can now continue with the user\'s answers in mind.';

      // (b) web client present, terminal user answers first -> terminal wins
      c3.ask.tuiTypes = true;
      const r2 = await toolCallHandler(askEvent("tc-b"), c3.ctx) as { block?: boolean; reason?: string } | undefined;
      check("wiring: terminal answer wins -> block with rpiv-style envelope",
        r2?.block === true && r2.reason === envelope("B"));
      await waitIn3("ask-resolved");
      check("wiring: web modal closed when terminal wins (ask-resolved broadcast)",
        sse3.get().includes("ask-resolved") && sse3.get().includes('"id":"tc-b"'));

      // (c) web client answers first -> web wins, terminal overlay closed
      c3.ask.tuiTypes = true; // would type at +50ms, after the web POST
      const p3 = toolCallHandler(askEvent("tc-c"), c3.ctx) as Promise<{ block?: boolean; reason?: string } | undefined>;
      await waitIn3('"id":"tc-c"');
      const ans = await fetch(base3 + "/ask-answer", { method: "POST", headers: { "Content-Type": "application/json", cookie: cookie3 },
        body: JSON.stringify({ id: "tc-c", cancelled: false, answers: [{ index: 0, kind: "option", answer: "A" }] }) });
      check("wiring: /ask-answer accepted -> 200", ans.status === 200);
      const r3 = await p3;
      check("wiring: web answer wins -> block with that envelope",
        r3?.block === true && r3.reason === envelope("A"));
      check("wiring: terminal overlay closed when web wins", c3.ask.doneCalls[c3.ask.doneCalls.length - 1] === null);

      const dup = await fetch(base3 + "/ask-answer", { method: "POST", headers: { "Content-Type": "application/json", cookie: cookie3 },
        body: JSON.stringify({ id: "tc-c", cancelled: false, answers: [{ index: 0, kind: "option", answer: "A" }] }) });
      check("wiring: duplicate /ask-answer -> 409", dup.status === 409);

      // (d) decline from the web
      const p4 = toolCallHandler(askEvent("tc-d"), c3.ctx) as Promise<{ block?: boolean; reason?: string } | undefined>;
      await waitIn3('"id":"tc-d"');
      await fetch(base3 + "/ask-answer", { method: "POST", headers: { "Content-Type": "application/json", cookie: cookie3 },
        body: JSON.stringify({ id: "tc-d", cancelled: true, answers: [] }) });
      const r4 = await p4;
      check("wiring: web decline -> block with canonical decline text",
        r4?.block === true && r4.reason === "User declined to answer questions");

      // (e) the only web client leaves mid-question -> terminal side still resolves it
      const p5 = toolCallHandler(askEvent("tc-e"), c3.ctx) as Promise<{ block?: boolean; reason?: string } | undefined>;
      await waitIn3('"id":"tc-e"');
      sse3.close();
      const r5 = await p5;
      check("wiring: client left -> terminal answer still resolves the call",
        r5?.block === true && r5.reason === envelope("B"));
      sse3.close();
    }
  } finally {
    if (fake3 && c3) { try { await fake3.commands.get("webserve")!.handler("stop", c3.ctx); } catch { /* ok */ } }
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
}

await wiringTests();

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);