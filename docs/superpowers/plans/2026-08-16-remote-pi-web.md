# Remote Pi Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single-file pi extension that streams the current pi session to a password-protected web page (SSE) and injects browser-typed messages as real user messages.

**Architecture:** `index.ts` holds pure helpers (password, tokens/cookie, entry sanitizer, leaf diff), two inline HTML pages, a zero-dependency `node:http` server, and the pi extension factory. The server is started by `/webserve start`, tracks per-client leaf pointers, and re-sends snapshots on resync/reconnect.

**Tech Stack:** TypeScript (erasable syntax only — Node ≥ 23.6 native type stripping), `node:http`, `node:crypto`, `node:os`, `import type` from `@earendil-works/pi-coding-agent`. Zero runtime npm dependencies.

**Spec:** `docs/superpowers/specs/2026-08-16-remote-pi-web-design.md`

## Global Constraints

- **No git commits.** The repo is not a git repository and the user has not asked for commits. Each task ends when its gates pass; never run `git commit`.
- **Zero runtime dependencies.** `index.ts` runtime imports: `node:http`, `node:crypto`, `node:os` only. The pi package is `import type` ONLY (erased at runtime, so `node selftest.ts` never resolves it).
- **Node ≥ 23.6** required to run `selftest.ts` (native TS type stripping). Dev-only deps (`typescript`, `@types/node`, pi types) are type-check support only.
- **Values (verbatim from spec):** default port **8765**; port auto-increment up to **10** consecutive ports; password **min 4 chars**; bind host **0.0.0.0**; body limit **100 KB**; input text limit **32 KB**; cookie `Max-Age=604800` (7 days); token = **32 random bytes** hex; SSE keep-alive comment every **15 s**; SSE `retry: 2000`.
- **Web page code rules:** page strings are template literals in `index.ts`; page JS must use NO backticks and NO `${...}` (use `'...'` strings and `+` concatenation) so they nest safely.
- **TS must be erasable:** no `enum`, no `namespace`, no constructor parameter properties.
- **Gates:** every task ends with `node selftest.ts` (all pass, exit 0) AND `npx tsc -p tsconfig.json` (no errors), run from the repo root `/home/jc1da/Programs/LanyTek/remote_pi_ext`.
- Files live at repo root: `index.ts`, `selftest.ts`, `package.json`, `tsconfig.json`, `description.md`.

---

### Task 1: Scaffolding + password helpers

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `index.ts` (header, imports, `AnyRec` type, password section)
- Create: `selftest.ts` (test harness + password tests)

**Interfaces:**
- Produces: `hashPassword(pw: string): string` — SHA-256 hex digest.
- Produces: `verifyPassword(pw: string, hashHex: string): boolean` — constant-time compare; never throws on malformed input.
- Produces: `type AnyRec = Record<string, unknown>` (used by all later sections).

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "remote-pi-ext",
  "private": true,
  "type": "module",
  "pi": { "extensions": ["./index.ts"] },
  "devDependencies": {
    "typescript": "^5.5.0",
    "@types/node": "^22.0.0",
    "@earendil-works/pi-coding-agent": "^0.84.2"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "es2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "types": ["node"]
  },
  "include": ["index.ts", "selftest.ts"]
}
```

- [ ] **Step 3: Install dev deps**

Run: `cd /home/jc1da/Programs/LanyTek/remote_pi_ext && npm install`
Expected: `node_modules/` created, no errors. (If the network is unavailable, note it and continue — the `tsc` gate is skipped for this run, `node selftest.ts` still works.)

- [ ] **Step 4: Write the failing test** — create `selftest.ts`

```typescript
// selftest.ts — run: node selftest.ts   (Node >= 23.6, native TS type stripping)
import { hashPassword, verifyPassword } from "./index.ts";

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

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
```

- [ ] **Step 5: Run test to verify it fails**

Run: `cd /home/jc1da/Programs/LanyTek/remote_pi_ext && node selftest.ts`
Expected: import error — `Cannot find module './index.ts'` (red).

- [ ] **Step 6: Write the minimal implementation** — create `index.ts`

```typescript
/**
 * remote-pi-ext — browse and drive the current pi session from a web browser.
 *
 *   /webserve start [port]   (default 8765) — asks for a password, serves the session
 *   /webserve stop
 *   /webserve status
 *
 * Zero runtime dependencies: node:http + node:crypto + node:os only.
 * The pi import below is type-only (erased at runtime).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

type AnyRec = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Password (spec §7)
// ---------------------------------------------------------------------------

/** SHA-256 hex of the password. The only form of the password ever stored. */
export function hashPassword(pw: string): string {
  return createHash("sha256").update(pw, "utf8").digest("hex");
}

/**
 * Constant-time password check. Never throws: a malformed/short stored hash
 * simply fails (digest is always 32 bytes; Buffer.from("hex") may yield less).
 */
export function verifyPassword(pw: string, hashHex: string): boolean {
  const given = createHash("sha256").update(pw, "utf8").digest();
  const expected = Buffer.from(hashHex, "hex");
  if (expected.length === 0 || expected.length !== given.length) return false;
  return timingSafeEqual(given, expected);
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd /home/jc1da/Programs/LanyTek/remote_pi_ext && node selftest.ts && npx tsc -p tsconfig.json`
Expected: all `ok` lines, `0 failed`, exit 0; tsc silent.

---

### Task 2: Token + cookie helpers

**Files:**
- Modify: `index.ts` (append tokens/cookie section after the password section)
- Modify: `selftest.ts` (extend import; append tokens/cookie test block)

**Interfaces:**
- Produces: `issueToken(): string` — 64-char hex (32 random bytes).
- Produces: `cookieHeader(token: string): string` — `Set-Cookie` value: `remote_pi_session=<token>; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`.
- Produces: `clearCookieHeader(): string` — `remote_pi_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`.
- Produces: `tokenFromCookie(header: string | undefined): string | null` — parses the `Cookie` request header; null if absent/empty.

- [ ] **Step 1: Write the failing tests** — in `selftest.ts`, change the import line to:

```typescript
import { hashPassword, verifyPassword, issueToken, cookieHeader, clearCookieHeader, tokenFromCookie } from "./index.ts";
```

and append this block before the final `console.log`:

```typescript
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node selftest.ts`
Expected: `issueToken is not a function`-style failure (red).

- [ ] **Step 3: Implement** — in `index.ts`, add after the password section:

```typescript
// ---------------------------------------------------------------------------
// Session tokens + cookie (spec §5 Auth)
// ---------------------------------------------------------------------------

const COOKIE_NAME = "remote_pi_session";

/** 32 random bytes, hex — 256-bit unguessable token. */
export function issueToken(): string {
  return randomBytes(32).toString("hex");
}

export function cookieHeader(token: string): string {
  return COOKIE_NAME + "=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800";
}

export function clearCookieHeader(): string {
  return COOKIE_NAME + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
}

/** Extract our token from a `Cookie` request header. Null when absent/empty. */
export function tokenFromCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const kv = part.trim();
    if (kv.startsWith(COOKIE_NAME + "=")) {
      const v = kv.slice(COOKIE_NAME.length + 1);
      return v.length > 0 ? v : null;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node selftest.ts && npx tsc -p tsconfig.json`
Expected: all `ok`, `0 failed`, tsc silent.

---

### Task 3: Entry sanitizer + leaf diff

**Files:**
- Modify: `index.ts` (append sanitizer + diffLeaf sections)
- Modify: `selftest.ts` (extend import; append test block)

**Interfaces:**
- Produces: `sanitizeEntry(e: AnyRec): AnyRec | null` — keeps only whitelisted fields per entry type (drops `parentId` and unknown types); `message` payload kept intact.
- Produces: `type LeafDiff = { kind: "none" } | { kind: "append"; entries: AnyRec[] } | { kind: "resync" }`.
- Produces: `diffLeaf(byId: Map<string, AnyRec>, lastLeaf: string | null, newLeaf: string | null): LeafDiff` — compares each SSE client's last-seen leaf with the session's current leaf.

Sanitizer whitelist (spec §5):
- `message`: `type, id, timestamp, message`
- `compaction`: `type, id, timestamp, summary, tokensBefore`
- `branch_summary`: `type, id, timestamp, fromId, summary`
- `model_change`: `type, id, timestamp, provider, modelId`
- `thinking_level_change`: `type, id, timestamp, thinkingLevel`
- `session_info`: `type, id, timestamp, name`
- `custom_message`: `type, id, timestamp, customType, content, display`
- `custom`: `type, id, timestamp, customType, data`
- `label`: `type, id, timestamp, targetId, label`
- anything else: dropped (`null`)

- [ ] **Step 1: Write the failing tests** — in `selftest.ts`, extend the import:

```typescript
import { hashPassword, verifyPassword, issueToken, cookieHeader, clearCookieHeader, tokenFromCookie, sanitizeEntry, diffLeaf } from "./index.ts";
```

Append this block before the final `console.log`:

```typescript
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node selftest.ts`
Expected: `sanitizeEntry is not a function`-style failure (red).

- [ ] **Step 3: Implement** — in `index.ts`, add after the tokens section:

```typescript
// ---------------------------------------------------------------------------
// Entry sanitizer (spec §5: strip everything except what the web view needs)
// ---------------------------------------------------------------------------

const ENTRY_FIELDS: Record<string, string[]> = {
  message: ["type", "id", "timestamp", "message"],
  compaction: ["type", "id", "timestamp", "summary", "tokensBefore"],
  branch_summary: ["type", "id", "timestamp", "fromId", "summary"],
  model_change: ["type", "id", "timestamp", "provider", "modelId"],
  thinking_level_change: ["type", "id", "timestamp", "thinkingLevel"],
  session_info: ["type", "id", "timestamp", "name"],
  custom_message: ["type", "id", "timestamp", "customType", "content", "display"],
  custom: ["type", "id", "timestamp", "customType", "data"],
  label: ["type", "id", "timestamp", "targetId", "label"],
};

/** Whitelist one entry's fields. `parentId` is never sent; unknown types -> null. */
export function sanitizeEntry(e: AnyRec): AnyRec | null {
  const fields = ENTRY_FIELDS[e.type as string];
  if (!fields) return null;
  const out: AnyRec = {};
  for (const f of fields) {
    if (e[f] !== undefined) out[f] = e[f];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Leaf diff (spec §5 streaming protocol: append vs resync per client)
// ---------------------------------------------------------------------------

export type LeafDiff =
  | { kind: "none" }
  | { kind: "append"; entries: AnyRec[] } // raw entries, oldest-first, excludes lastLeaf
  | { kind: "resync" };                   // caller sends a full snapshot

/**
 * Decide what one SSE client needs when the session leaf moved from
 * `lastLeaf` to `newLeaf`. Walks parentId links from newLeaf back to lastLeaf;
 * any break in the chain (tree nav, resume, compaction re-root, unknown id)
 * means the client must resync. A 100k-step guard defeats pathological cycles.
 */
export function diffLeaf(
  byId: Map<string, AnyRec>,
  lastLeaf: string | null,
  newLeaf: string | null,
): LeafDiff {
  if (!newLeaf || newLeaf === lastLeaf) return { kind: "none" };
  if (!lastLeaf) return { kind: "resync" };
  const path: AnyRec[] = [];
  let cur: string | null = newLeaf;
  let guard = 0;
  while (cur !== lastLeaf) {
    const e = byId.get(cur);
    if (!e) return { kind: "resync" };
    path.push(e);
    cur = (e.parentId as string | null) ?? null;
    if (cur === null) return { kind: "resync" };
    if (++guard > 100000) return { kind: "resync" };
  }
  path.reverse();
  return { kind: "append", entries: path };
}
```

Note: `diffLeaf` returns RAW entries; the server sanitizes them when writing the SSE payload (see Task 6).

- [ ] **Step 4: Run to verify it passes**

Run: `node selftest.ts && npx tsc -p tsconfig.json`
Expected: all `ok`, `0 failed`, tsc silent.

---

### Task 4: Web pages (login + chat)

**Files:**
- Modify: `index.ts` (append `LOGIN_PAGE` + `CHAT_PAGE` sections)
- Modify: `selftest.ts` (extend import; append page test block)

**Interfaces:**
- Produces: `export const LOGIN_PAGE: string` — password form page.
- Produces: `export const CHAT_PAGE: string` — the live session viewer page.

Page rules (Global Constraints): single `<script>` block per page, no backticks, no `${...}`, ES2017-level JS only.

- [ ] **Step 1: Write the failing tests** — in `selftest.ts`, extend the import to add `LOGIN_PAGE, CHAT_PAGE`, and append:

```typescript
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node selftest.ts`
Expected: `LOGIN_PAGE is not exported`/undefined failure (red).

- [ ] **Step 3: Implement** — in `index.ts`, append:

```typescript
// ---------------------------------------------------------------------------
// Pages (spec §6). No backticks / ${...} inside page JS — they nest in
// template literals below.
// ---------------------------------------------------------------------------

export const LOGIN_PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pi remote — login</title>
<style>
body{background:#111;color:#e5e5e5;font:15px ui-monospace,SFMono-Regular,monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
form{background:#1c1c1e;padding:28px;border-radius:12px;display:flex;flex-direction:column;gap:12px;width:280px}
h1{font-size:16px;margin:0}
input{background:#111;border:1px solid #444;color:#e5e5e5;padding:8px;border-radius:8px;font:inherit}
button{background:#2563eb;color:#fff;border:0;padding:8px;border-radius:8px;cursor:pointer;font:inherit}
.err{color:#f87171;font-size:13px;min-height:16px}
</style>
</head>
<body>
<form id="f">
<h1>pi session viewer</h1>
<input id="pw" type="password" placeholder="password" autofocus>
<button>Unlock</button>
<div class="err" id="err"></div>
</form>
<script>
document.getElementById('f').addEventListener('submit', function (e) {
  e.preventDefault();
  fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: document.getElementById('pw').value })
  }).then(function (r) {
    if (r.ok) { location.reload(); }
    else { document.getElementById('err').textContent = 'wrong password'; }
  });
});
</script>
</body>
</html>`;

export const CHAT_PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pi session</title>
<style>
:root{--bg:#111;--panel:#1c1c1e;--user:#2563eb;--asst:#26262c;--tool:#1a1a1c;--text:#e5e5e5;--dim:#8a8a8a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 ui-monospace,SFMono-Regular,monospace;display:flex;flex-direction:column;height:100vh}
header{display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--panel);border-bottom:1px solid #333}
header .dot{width:9px;height:9px;border-radius:50%;background:#4ade80;flex:none}
header .dot.busy{background:#facc15}
header .meta{color:var(--dim);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
header button{background:none;border:1px solid #555;color:var(--text);padding:4px 10px;border-radius:6px;cursor:pointer;font:inherit}
header button#stop{display:none;border-color:#b91c1c}
header button#stop.show{display:inline-block}
#msgs{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
.msg{max-width:85%;padding:8px 10px;border-radius:10px;white-space:pre-wrap;word-break:break-word}
.msg.user{align-self:flex-end;background:var(--user)}
.msg.assistant{align-self:flex-start;background:var(--asst)}
.msg.pending{opacity:.7;border:1px dashed #555}
.msg.pendinguser{opacity:.7;border:1px dashed #555;align-self:flex-end}
details.tool{align-self:flex-start;max-width:85%;background:var(--tool);border:1px solid #333;border-radius:8px;padding:4px 8px}
details.tool.err{border-color:#b91c1c}
details.tool summary{cursor:pointer;color:var(--dim);font-size:12px}
details.tool pre{white-space:pre-wrap;word-break:break-word;margin:6px 0 0;color:#c8c8c8}
.note{align-self:center;color:var(--dim);font-size:12px}
footer{display:flex;gap:8px;padding:10px 12px;background:var(--panel);border-top:1px solid #333}
footer textarea{flex:1;resize:none;height:56px;background:#111;color:var(--text);border:1px solid #444;border-radius:8px;padding:8px;font:inherit}
footer button{background:var(--user);color:#fff;border:0;border-radius:8px;padding:0 16px;cursor:pointer;font:inherit}
</style>
</head>
<body>
<header>
<div class="dot" id="dot"></div>
<span class="meta" id="meta"></span>
<button id="stop">Stop</button>
<button id="logout">Logout</button>
</header>
<div id="msgs"></div>
<footer>
<textarea id="input" placeholder="Message..."></textarea>
<button id="send">Send</button>
</footer>
<script>
var msgs = document.getElementById('msgs'),
    input = document.getElementById('input'),
    dot = document.getElementById('dot'),
    metaEl = document.getElementById('meta'),
    stopBtn = document.getElementById('stop');
var curMeta = {}, pendingEl = null, pendingUserEl = null;

function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function autoScroll() {
  if (msgs.scrollTop + msgs.clientHeight > msgs.scrollHeight - 80) msgs.scrollTop = msgs.scrollHeight;
}
function textOf(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(function (x) { return x && x.type === 'text'; })
    .map(function (x) { return x.text || ''; }).join('');
  return '';
}
function addMsg(role, html, cls) {
  var d = document.createElement('div');
  d.className = 'msg ' + role + (cls ? ' ' + cls : '');
  d.innerHTML = html;
  msgs.appendChild(d);
  autoScroll();
  return d;
}
function addNote(t) {
  var d = document.createElement('div');
  d.className = 'note';
  d.textContent = t;
  msgs.appendChild(d);
  autoScroll();
}
function updateMetaLine() {
  metaEl.textContent = (curMeta.sessionName || 'pi session') + '  ·  ' + (curMeta.model || '') + '  ·  ' + (curMeta.cwd || '');
  if (curMeta.sessionName) document.title = curMeta.sessionName;
}
function setBusy(b) {
  dot.classList.toggle('busy', b);
  stopBtn.classList.toggle('show', b);
  input.placeholder = b ? 'Agent busy — your message will queue...' : 'Message...';
}
function toolEl(id, name, state) {
  var old = document.getElementById('call-' + id);
  if (old) old.remove();
  var el = document.createElement('details');
  el.className = 'tool';
  el.id = 'call-' + id;
  el.innerHTML = '<summary>' + esc(name) + ' — ' + esc(state) + '</summary>';
  msgs.appendChild(el);
  autoScroll();
  return el;
}
function renderEntry(en) {
  if (en.type === 'message' && en.message) {
    var m = en.message;
    if (m.role === 'user') {
      if (pendingUserEl) { pendingUserEl.remove(); pendingUserEl = null; }
      addMsg('user', esc(textOf(m.content)));
    } else if (m.role === 'assistant') {
      var texts = [];
      (Array.isArray(m.content) ? m.content : []).forEach(function (p) {
        if (p.type === 'text') texts.push(p.text || '');
        else if (p.type === 'toolCall') {
          var el = toolEl(p.id, p.name, 'running...');
          var pre = document.createElement('pre');
          pre.className = 'in';
          pre.textContent = 'input: ' + JSON.stringify(p.arguments);
          el.appendChild(pre);
        }
      });
      if (pendingEl) { pendingEl.remove(); pendingEl = null; }
      if (texts.length) addMsg('assistant', esc(texts.join('')));
    } else if (m.role === 'toolResult') {
      var out = textOf(m.content);
      var el2 = document.getElementById('call-' + m.toolCallId);
      if (el2) {
        var s = el2.querySelector('summary');
        if (s) s.textContent = m.toolName + ' — ' + (m.isError ? 'error' : 'done');
        el2.classList.toggle('err', !!m.isError);
        var pre2 = document.createElement('pre');
        pre2.className = 'out';
        pre2.textContent = 'output: ' + out;
        el2.appendChild(pre2);
      } else {
        var el3 = document.createElement('details');
        el3.className = 'tool' + (m.isError ? ' err' : '');
        el3.innerHTML = '<summary>' + esc(m.toolName) + ' — ' + (m.isError ? 'error' : 'done') + '</summary>';
        var pre3 = document.createElement('pre');
        pre3.textContent = out;
        el3.appendChild(pre3);
        msgs.appendChild(el3);
      }
      autoScroll();
    } else if (m.role === 'bashExecution') {
      var el4 = document.createElement('details');
      el4.className = 'tool';
      el4.innerHTML = '<summary>! ' + esc(m.command || '') + '</summary>';
      var pre4 = document.createElement('pre');
      pre4.textContent = m.output || '';
      el4.appendChild(pre4);
      msgs.appendChild(el4);
      autoScroll();
    } else if (m.role === 'custom' || m.role === 'customMessage') {
      addNote('note: ' + textOf(m.content).slice(0, 200));
    }
    return;
  }
  if (en.type === 'compaction') addNote('— compacted (' + (en.tokensBefore || 0) + ' tokens before) —');
  else if (en.type === 'model_change') addNote('model → ' + (en.provider || '') + '/' + (en.modelId || ''));
  else if (en.type === 'thinking_level_change') addNote('thinking → ' + (en.thinkingLevel || ''));
  else if (en.type === 'branch_summary') addNote('branch: ' + String(en.summary || '').slice(0, 120));
  else if (en.type === 'session_info') addNote('name → ' + (en.name || '(cleared)'));
}
function renderSnapshot(d) {
  curMeta = d.meta || {};
  updateMetaLine();
  msgs.innerHTML = '';
  (d.entries || []).forEach(renderEntry);
  autoScroll();
}

var es = new EventSource('/events');
es.addEventListener('snapshot', function (e) { renderSnapshot(JSON.parse(e.data)); });
es.addEventListener('resync', function (e) { renderSnapshot(JSON.parse(e.data)); });
es.addEventListener('update', function (e) {
  var m = JSON.parse(e.data);
  if (!pendingEl) {
    pendingEl = document.createElement('div');
    pendingEl.className = 'msg assistant pending';
    msgs.appendChild(pendingEl);
  }
  pendingEl.textContent = textOf(m.content);
  autoScroll();
});
es.addEventListener('append', function (e) {
  (JSON.parse(e.data).entries || []).forEach(renderEntry);
});
es.addEventListener('toolstart', function (e) {
  var d = JSON.parse(e.data);
  toolEl(d.id, d.name, 'running...');
});
es.addEventListener('status', function (e) { setBusy(!!JSON.parse(e.data).busy); });
es.addEventListener('meta', function (e) { curMeta.model = JSON.parse(e.data).model || ''; updateMetaLine(); });

function send() {
  var t = input.value.trim();
  if (!t) return;
  input.value = '';
  pendingUserEl = addMsg('user', esc(t), 'pendinguser');
  fetch('/input', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: t })
  }).then(function (r) {
    if (!r.ok) return r.json().then(function (d) { alert('send failed: ' + (d.error || r.status)); });
  }).catch(function (err) { alert('send failed: ' + err); });
}
input.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
document.getElementById('send').addEventListener('click', send);
stopBtn.addEventListener('click', function () {
  fetch('/stop', { method: 'POST' }).then(function () { setBusy(false); });
});
document.getElementById('logout').addEventListener('click', function () {
  fetch('/logout', { method: 'POST' }).then(function () { location.reload(); });
});
</script>
</body>
</html>`;
```

- [ ] **Step 4: Run to verify it passes**

Run: `node selftest.ts && npx tsc -p tsconfig.json`
Expected: all `ok`, `0 failed`, tsc silent.

---

### Task 5: HTTP server core (auth, pages, input, stop, logout)

**Files:**
- Modify: `index.ts` (append `import http from "node:http"` at top; append server section)
- Modify: `selftest.ts` (extend import with `startServer, hashPassword` (already); append async HTTP test block + top-level `await httpTests()`)

**Interfaces:**
- Produces: `interface SnapshotMeta { cwd: string; model: string; sessionName: string | null; leafId: string | null }`.
- Produces: `interface WebApi { getSnapshot(): { entries: AnyRec[]; meta: SnapshotMeta }; allEntries(): Map<string, AnyRec>; sendInput(text: string): Promise<{ queued: boolean }>; stopAgent(): { aborted: boolean } }` — the pi-side dependency seam (Task 7 implements it for real).
- Produces: `interface WebServer { port: number; stop(): void }` — Task 6 extends it with `broadcast`/`onSessionChanged`.
- Produces: `startServer(opts: { host?: string; port: number; passwordHash: string; tokens: Set<string>; api: WebApi }): Promise<WebServer>` — resolves when listening (actual port in `port`), rejects on `listen` error (EADDRINUSE included).
- `GET /` serves chat or login page by cookie; `GET /events` NOT handled yet (falls to 404) — Task 6 adds it; `POST /login`, `POST /input`, `POST /stop`, `POST /logout` as spec §5.

- [ ] **Step 1: Write the failing tests** — in `selftest.ts`, extend the import to add `startServer`, and append before the final `console.log`:

```typescript
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

  check("http: /input ok -> 200 queued", (async () => {
    const r = await fetch(base + "/input", { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ text: "hello agent" }) });
    return r.status === 200 && (await r.json()).queued === true && sent[0] === "hello agent";
  })());
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

  check("http: /logout -> 200 + clears cookie", (async () => {
    const r = await fetch(base + "/logout", { method: "POST", headers: { cookie } });
    return r.status === 200 && (r.headers.get("set-cookie") ?? "").includes("Max-Age=0");
  })());
  check("http: token invalid after logout",
    (await fetch(base + "/input", { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ text: "x" }) })).status === 401);

  ws.stop();
}

await httpTests();
```

and change the final lines to:

```typescript
console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
```

(unchanged — `await httpTests()` runs before them, top-level await is fine in ESM).

- [ ] **Step 2: Run to verify it fails**

Run: `node selftest.ts`
Expected: `startServer is not a function`-style failure (red).

- [ ] **Step 3: Implement** — in `index.ts`: add `import http from "node:http";` to the imports at the top, then append this section:

```typescript
// ---------------------------------------------------------------------------
// Web server (spec §5). Zero-dependency node:http.
// ---------------------------------------------------------------------------

const BODY_LIMIT = 100 * 1024;   // spec: 100 KB body limit
const INPUT_LIMIT = 32 * 1024;   // spec: input text 32 KB

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

export function startServer(opts: {
  host?: string;
  port: number;
  passwordHash: string;
  tokens: Set<string>;
  api: WebApi;
}): Promise<WebServer> {
  const { passwordHash, tokens, api } = opts;
  const server = http.createServer((req, res) => { void handle(req, res); });

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
      server.close();
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
Expected: all `ok` (including the http block), `0 failed`, tsc silent.

---

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

### Task 8: `description.md`

**Files:**
- Create: `description.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Create `description.md`** with exactly this content:

```markdown
# remote-pi-ext

Browse and drive the current pi session from a web browser.

## What it does
Starts a password-protected web server that streams the current pi session
(user/assistant messages, tool calls, tool results, model changes, compaction
markers) to a browser via Server-Sent Events, so you can watch the agent work
from another machine on your LAN and type messages back into the agent.

## Commands
- `/webserve start [port]` — asks for a password (min 4 chars), starts the server
  on `0.0.0.0` (default port 8765; if taken, tries the next port, up to 10), and
  prints the URL(s) in the terminal.
- `/webserve stop` — stops the server.
- `/webserve status` — shows running/stopped and the actual port.

## Install / use
1. Put this directory at `~/.pi/agent/extensions/remote-pi-ext/`
   (auto-discovered) or list it in `settings.json` under `extensions`.
2. In a pi session: `/webserve start`, type the password, open the printed URL,
   unlock in the browser.

## Security notes
- HTTP is unencrypted: the password and all session content travel in the clear
  on your LAN. Do not expose this port to the internet. For remote access use
  `ssh -L 8765:localhost:8765 user@pi-host`.
- The password is held in memory only (as a SHA-256 hash) for as long as the
  server runs; it is never written to session files or logs.
- Login issues a random 256-bit token cookie (HttpOnly, 7 days).
- Session content is sensitive (the agent can read your code) — choose the
  password accordingly. No login rate limiting (LAN assumption).

## Behavior
- Messages sent from the web appear in the terminal exactly as if typed there.
  While the agent is busy they queue until it finishes (follow-up delivery).
- The **Stop** button in the web header behaves like Esc in the terminal.
- The server stops when the session ends (exit, /new, /resume, /reload);
  start it again with `/webserve start`.
- Multiple pi terminals each get their own server: 8765, 8766, ...

## Tests
- `npm install` (dev-only type deps), then:
  - `node selftest.ts` — unit + HTTP-protocol checks (password, tokens/cookie,
    sanitizer, leaf diff, page syntax, full server against a fake pi api).
  - `npx tsc -p tsconfig.json` — strict type check.
- Manual e2e checklist: `pi -e ./index.ts` → `/webserve start` → login in a
  browser → watch live streaming → send a message from the web (appears in the
  TUI) → Stop mid-run → `/webserve stop` → second terminal lands on port 8766.
```

- [ ] **Step 2: Gate**

Run: `node selftest.ts && npx tsc -p tsconfig.json`
Expected: all `ok`, `0 failed`, tsc silent. (Documentation change; gates must stay green.)

---

## Self-Review (performed)

1. **Spec coverage:** §3 commands → Task 7; §4 architecture/state → Tasks 5/6/7; §5 endpoints (login/input/stop/logout/SSE incl. snapshot/append/resync/update/toolstart/status/meta, body limits, auth rules) → Tasks 5/6; §6 UI → Task 4; §7 security (hash, timingSafeEqual, token cookie, 0.0.0.0, ponytail TLS/rate-limit notes) → Tasks 1/2/5/7 + description.md; §8 error table → Task 5 handler; §9 tests (selftest + manual e2e incl. two-terminal/8766) → all tasks + Task 7 Step 4 + description.md. No gaps.
2. **Placeholder scan:** every code step contains paste-ready code; the only defined interim state is Task 5's unhandled `/events` (explicitly documented as added in Task 6, no stub).
3. **Type consistency:** `WebApi`/`WebServer`/`SnapshotMeta` names and signatures used identically in Tasks 5/6/7; `sanitizeEntry`/`diffLeaf` signatures match Task 3 in all later uses; page element ids (`dot`, `meta`, `stop`, `logout`, `msgs`, `input`, `send`) consistent within CHAT_PAGE; SSE event names (`snapshot`, `append`, `resync`, `update`, `toolstart`, `status`, `meta`) identical in server, page, and spec.
```