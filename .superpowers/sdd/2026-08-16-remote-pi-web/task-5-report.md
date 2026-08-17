# Task 5 Report — HTTP server core (auth, pages, input, stop, logout)

## What I implemented

Per `task-5-brief.md`, verbatim:

1. **`index.ts`** — added `import http from "node:http";` as the second import line; appended the
   "Web server (spec §5)" section at the end of the file: `BODY_LIMIT = 100*1024`,
   `INPUT_LIMIT = 32*1024`, exported interfaces `SnapshotMeta`, `WebApi`, `WebServer`,
   helpers `readBody` / `json` / `html` / `parseJsonBody`, and `startServer(opts)` which:
   - resolves with `{ port: <actual bound port>, stop() }` when listening; rejects on listen error (EADDRINUSE)
   - `GET /` → chat page if the cookie token is in the tokens Set, else login page
   - `POST /login` → constant-time password check against `passwordHash`; 200 + `Set-Cookie`
     (`cookieHeader(token)`) on success, 401 otherwise (incl. non-JSON body → empty password → 401)
   - everything else requires a valid token cookie (401 without)
   - `POST /input` → 400 bad JSON / 400 empty / 400 > 32 KB text; else `api.sendInput`, 200 `{ok, queued}`
   - `POST /stop` → 200 `api.stopAgent()`
   - `POST /logout` → removes token from Set, 200 + `clearCookieHeader()` (Max-Age=0)
   - anything else → 404 (so `/events` is unhandled in this task, as specified); error mapping:
     `BODY_TOO_LARGE` → 413, `NO_CTX` → 503, else 500
2. **`selftest.ts`** — extended the import list with `startServer`; appended the async
   `httpTests()` block (14 checks against a REAL server bound to an ephemeral port on 127.0.0.1,
   driven by global `fetch`, with a fake `WebApi`) and top-level `await httpTests()` before the
   unchanged final summary lines.

No other files touched. No new files. Zero new runtime deps (`node:http` is a built-in). Not a git
repo — no commits/staging possible.

## TDD Evidence

### RED

Command: `node selftest.ts` (with the new test block in place, before `startServer` existed)

```
SyntaxError: The requested module './index.ts' does not provide an export named 'startServer'
    at ModuleJob._instantiate (node:internal/modules/esm/module_job:182:21)
... exit=1
```

Why expected: the brief's step-1 import (`import { ..., startServer } from "./index.ts"`) names an
export that doesn't exist yet, and ESM validates named exports at link time, so the failure is a
link-time `SyntaxError` — the same "startServer doesn't exist yet" family as the brief's predicted
"`startServer is not a function`" (Node would only produce that TypeError for a namespace import).
Consequence of ESM all-or-nothing linking: in the RED run the 26 pre-existing checks cannot execute
(the module never evaluates). They are byte-unchanged by this task's edits and all pass in GREEN.
Corroborating RED at the type level: `npx tsc -p tsconfig.json` → exactly one error,
`selftest.ts(2,127): error TS2305: Module '"./index.ts"' has no exported member 'startServer'.` —
notably, the rest of the verbatim test block already type-checked.

### GREEN

Command (brief step 4): `node selftest.ts && npx tsc -p tsconfig.json`

```
ok   password: ... (6)
ok   token/cookie: ... (8)
ok   sanitize/diffLeaf: ... (7)
ok   page: ... (5)
ok   server: binds to requested (ephemeral) port
ok   http: / unauthenticated serves login page
ok   http: login wrong password -> 401
ok   http: login ok -> 200 + Set-Cookie
ok   http: / with cookie serves chat page
ok   http: bad json login -> 401 (empty password)
ok   http: /input ok -> 200 queued
ok   http: /input without cookie -> 401
ok   http: /input blank -> 400
ok   http: /input bad json -> 400
ok   http: /input oversized -> 413
ok   http: /stop -> 200 + stopAgent called
ok   http: /logout -> 200 + clears cookie
ok   http: token invalid after logout

40 passed, 0 failed
```

`node selftest.ts` exit 0; `npx tsc -p tsconfig.json` exit 0, silent. Output is pristine apart from
Node's environmental `ExperimentalWarning: Type Stripping` stderr notice. Repeated the full run
twice more: both `40 passed, 0 failed` (no flakiness). Each run completes in ~0.2 s (no keep-alive hang).

## Files changed

- `index.ts` — +`import http from "node:http"`; appended "Web server" section (lines 395–536).
- `selftest.ts` — import list gains `startServer`; appended `httpTests()` + `await httpTests();`
  (lines 87–160); final summary lines unchanged.

## Deviations from the brief (both minimal, both documented in code comments)

1. **`selftest.ts`: two `check(..., (async () => {...})())` calls rewritten as direct awaits**
   ("/input ok -> 200 queued" and "/logout -> 200 + clears cookie").
   *Cause:* `check(name, cond: boolean)` receives a `Promise<boolean>` — a hard tsc error
   (TS2345: `Promise<boolean>` not assignable to `boolean`), so the brief's block cannot compile as
   written. It was also wrong at runtime: a Promise is always truthy, so `check()` would log "ok"
   unconditionally (false positive), and the logout IIFE raced the following
   "token invalid after logout" check. Fix: hoist the `fetch` into the already-async `httpTests()`
   and check the awaited result synchronously. Check names and asserted conditions are unchanged.
   Related: `(await r.json()).queued` would fail tsc (undici-types `Response.json(): Promise<unknown>`),
   so the one `.queued` read uses a local `as { queued?: boolean }` cast of the awaited JSON.
2. **`index.ts` `readBody`: removed the `req.destroy()` call after the over-limit reject.**
   *Cause (bug):* destroying the IncomingMessage destroys the underlying socket, so the server's
   413 response could never be written — the first GREEN attempt crashed with
   `TypeError: fetch failed / cause: ECONNRESET` on the 200 KB `/input` test. Fix: reject the promise
   but let the request stream keep flowing (it drains the body; `chunks` stops growing once the limit
   is exceeded, so memory stays bounded), then the 413 is delivered normally. This is the standard
   early-reject-and-drain pattern for body limits.

## Self-review findings

- Implemented exactly what the brief specifies, nothing more: no `/events` handling (falls to 404 —
  Task 6), no new exports beyond the brief's, no config, no helpers beyond the brief's four.
- The new tests verify real behavior over real HTTP, against a live `node:http` server on an ephemeral
  127.0.0.1 port: ephemeral bind, login page vs chat page gating by cookie, wrong-password 401,
  successful login 200 + `Set-Cookie` prefix, non-JSON login 401, input OK (200 + `queued` + fake api
  received the exact text), unauthenticated 401, blank 400, bad-JSON 400, oversized 413, stop 200 +
  `stopAgent` invoked, logout 200 + `Max-Age=0`, and token invalidation after logout (401).
- Status codes, limits (100 KB body / 32 KB text), cookie header reuse (`cookieHeader()` /
  `clearCookieHeader()`), and auth-via-token-Set all match the brief exactly.
- `description.md`: no such file exists anywhere in the repo, so nothing to update; creating one is
  out of this task's scope.

## Issues / concerns

- The RED manifest is a link-time SyntaxError (not the brief's predicted TypeError) because Node ESM
  validates named exports at link time; in RED the 26 pre-existing checks therefore don't execute.
  They are untouched by this task and all pass in GREEN. If the controller specifically requires the
  26 to be observable in the RED run, the import would need a non-breaking form (e.g. namespace
  import), which would deviate from the brief's verbatim step 1 — flagging for awareness only.
- `ws.stop()` calls `server.close()` per the brief; in practice the process exits promptly (~0.2 s),
  so no keep-alive tail was observed.
- Task 6 will extend `WebServer` with `broadcast`/`onSessionChanged` and add `/events`.