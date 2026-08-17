# Task 7 + Task 8 report — remote-pi-ext

Implementer: worker subagent. Worked from `/home/jc1da/Programs/LanyTek/remote_pi_ext` (not a git repo; no git used).

## What was implemented

### Task 7 — pi wiring (commands, events, lifecycle)
1. **Step 1 (imports):** Replaced both existing import lines in `index.ts` (`node:crypto`, `node:http`) with the brief's 4-line block:
   - added `import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"` (type-only — erased by Node's type stripping, so no runtime dependency),
   - kept `node:http` and `node:crypto` in the brief's order,
   - added `import { networkInterfaces } from "node:os"`.
   No duplication (grep: each import appears exactly once). The header comment ("node:http + node:crypto + node:os only. The pi import below is type-only") became accurate as-is and was left untouched, per instruction.
2. **Step 2 (factory, appended verbatim):** `lanUrls()`, `noCtxError()`, and `export default function (pi: ExtensionAPI): void` implementing:
   - `/webserve` command — `start [port]` (password via `ctx.ui.input`, min 4 chars, SHA-256-hashed in memory; bind `0.0.0.0`; default 8765; up to 10 attempts of EADDRINUSE auto-increment; prints localhost+LAN URLs and sets footer status), `stop`, `status`.
   - Lifecycle — `session_start` captures ctx (and the command handler captures it too, covering the gap before the first event); `session_shutdown` stops the server and nulls ctx.
   - Live stream — `message_update`→`update`, `tool_execution_start`→`toolstart`, `model_select`→`meta`, `agent_start`/`agent_settled`→`status` busy on/off; `message_end`/`tool_execution_end`/`session_compact`/`session_tree`/`session_info_changed`→`onSessionChanged(leaf())`.
   - `WebApi` — `getSnapshot()` (sanitized context entries + cwd/model/sessionName/leafId meta, throws `NO_CTX` when no ctx), `allEntries()`, `sendInput()` (idle → plain `pi.sendUserMessage`, busy → `deliverAs: "followUp"`), `stopAgent()` (programmatic `ctx.abort()`).
3. **Controller-approved hardening (both from the T5/T6 review "folding into T7" items):**
   - `writeSse`: `JSON.stringify(data)` wrapped in try/catch; on failure returns `false` (write-failure semantics), so `broadcast` never throws even for circular refs / BigInt. Commented with a one-line `deviation:` rationale.
   - `onSessionChanged` resync branch: `api.getSnapshot()` wrapped in try/catch; on failure (e.g. `NO_CTX` while the session is ending) that one client's keep-alive timer is cleared, its response ended, it is removed from `clients`, and the loop `continue`s — the throw no longer propagates into the pi event handler. Commented with a one-line `deviation:` rationale.
4. **New selftest check (SSE block, same `check()` style):** circular payload — `const circ: Record<string, unknown> = {}; circ.self = circ;` then `ws.broadcast("update", circ)` in a try/catch, asserting no throw.

### Task 8 — description.md
- Created `description.md` by extracting the brief's fenced content programmatically (awk on the ` ```markdown ` fence); verified verbatim by diffing the re-extraction against the written file (clean). 49 lines.

## Gate evidence

### Gate 1 — after Task 7 (before Task 8)
Command: `node selftest.ts && npx tsc -p tsconfig.json` (run as `node selftest.ts` with stderr captured separately, then `npx tsc -p tsconfig.json`)

```
ok   password: hash is 64 hex chars
ok   password: correct password verifies
ok   password: wrong password rejected
ok   password: length mismatch rejected
ok   password: malformed hash rejected
ok   password: empty hash rejected
ok   token: 64 hex chars
ok   token: unique
ok   cookie: header has token + HttpOnly + SameSite=Lax + Max-Age=604800
ok   cookie: clear header has Max-Age=0
ok   cookie: parse finds token among others
ok   cookie: parse missing -> null
ok   cookie: parse undefined header -> null
ok   cookie: parse empty value -> null
ok   sanitize: message keeps whitelisted fields only
ok   sanitize: unknown type dropped
ok   diffLeaf: same leaf -> none
ok   diffLeaf: descendant -> append [b,c,d] oldest-first
ok   diffLeaf: non-descendant -> resync
ok   diffLeaf: unknown new leaf -> resync
ok   diffLeaf: null last leaf -> resync
ok   page: login has password input and posts to /login
ok   page: login script syntax valid
ok   page: chat uses EventSource on /events
ok   page: chat script syntax valid
ok   page: no template literals leak into pages
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
ok   sse: snapshot delivered with 2 entries + meta
ok   sse: retry hint sent
ok   sse: broadcast reaches client
ok   sse: descendant leaf -> append containing new entry
ok   sse: non-descendant leaf -> resync snapshot
ok   sse: broadcast of non-serializable (circular) payload does not throw

46 passed, 0 failed
== selftest exit: 0 ==
(node:2548805) ExperimentalWarning: Type Stripping is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
== tsc ==
== tsc exit: 0 ==
```

### Gate 2 — after Task 8
Command: identical. Output: identical — all 46 `ok` lines (last: `sse: broadcast of non-serializable (circular) payload does not throw`), `46 passed, 0 failed`, selftest exit 0 (only stderr is the environmental Node Type-Stripping warning), `npx tsc -p tsconfig.json` produced no output and exited 0. Documentation change left the gates green.

## Files changed
- `index.ts` — 4 regions: import block (top); `writeSse` stringify guard; `onSessionChanged` resync guard; appended pi wiring (`lanUrls`, `noCtxError`, `export default` factory) at end of file.
- `selftest.ts` — 1 region: new circular-payload broadcast check in the SSE test block.
- `description.md` — new, verbatim from the Task 8 brief.
- `.superpowers/sdd/2026-08-16-remote-pi-web/progress.md` — appended the Task 7 / Task 8 DONE lines, matching the per-task convention already used for Tasks 1–6.

## Deviations
1. **`e as AnyRec` → `e as unknown as AnyRec` (2 sites: `getSnapshot()` and `allEntries()`).**
   - *Cause:* pi's session entry types are all `interface`s (`SessionEntryBase`, `SessionMessageEntry`, `CompactionEntry`, … in `@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts`), and interfaces have no implicit index signature. A direct assertion to `Record<string, unknown>` therefore fails under the project's strict tsconfig with TS2352 ("Index signature for type 'string' is missing in type …"). Verified with a scratch tsc run under the same compiler options before editing.
   - *Fix:* the canonical `as unknown as` double assertion — erased at runtime, zero behavioral change; everything downstream (`sanitizeEntry`, the `Map<string, AnyRec>`) is untouched. Both sites carry a `deviation:` comment naming the cause.
   - Everything else in the brief's Step 2 code compiles verbatim: all 12 event names exist on `ExtensionAPI`; `sub === undefined` is legal (TS always permits `===`/`!==` against null/undefined — confirmed by scratch run); `Model<any> as { provider: string; id: string }` is legal (`provider: ProviderId = KnownProvider | string`, `id: string`); `registerCommand`'s handler signature `(args: string, ctx: ExtensionCommandContext)` matches the brief's `async (args, ctx)`.

## Self-review findings
- Implemented exactly what the briefs specify plus only the three controller-approved additions (2 index.ts hardening guards, 1 selftest check). No other functional changes; no files deleted.
- `node selftest.ts`: **46 passed, 0 failed** (was 45; the new check is the 46th), exit code 0, pristine output — the only stderr is Node's environmental Type-Stripping `ExperimentalWarning`, which is not a defect.
- `npx tsc -p tsconfig.json`: **silent, exit 0**.
- The pi import appears **only** as `import type` (single occurrence, `index.ts:11`; none in `selftest.ts`) — runtime-safe; both gates pass with the pi package absent from the runtime graph (type-only import is erased by type stripping).
- No git repository, no staged files (nothing to stage).
- Task 7 Step 4 (manual e2e with live pi TUI + browser) intentionally not performed — handed to the user at handoff, per scope.

## Residual risks
- A non-serializable broadcast payload ends that one client's SSE connection (write-failure semantics); the browser's `EventSource` auto-reconnects (`retry: 2000`) and re-receives a fresh snapshot, so it self-heals.
- Known/deferred from earlier reviews (unchanged, out of scope): unbounded `tokens` Set until explicit logout; unauthenticated unknown paths return 401 not 404; post-stop keep-alive sockets can delay a bare `node` process exit by seconds (irrelevant in pi, where server stop ≠ process exit; selftest exits clean).