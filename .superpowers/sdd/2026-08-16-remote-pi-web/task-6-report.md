# Task 6 Report — SSE streaming (/events, broadcast, snapshot/append/resync)

## What was implemented

Per the brief, in TDD order:

1. **selftest.ts**
   - Added `import http from "node:http";` at the top (used by the SSE test client's `http.get`).
   - Appended the brief's verbatim SSE test block between `await httpTests();` and the final summary `console.log`. It starts its own server instance on an ephemeral port, logs in over real HTTP, holds a raw SSE connection via `http.get`, and checks: snapshot on connect (2 sanitized entries + meta), `retry: 2000` hint, `broadcast` reaching the client, descendant leaf → `append` containing the new entry, non-descendant leaf → `resync` snapshot.
2. **index.ts** — replaced the entire web-server section (from the `// Web server (spec §5)` banner to EOF) with the brief's version:
   - `WebServer` interface extended with `broadcast(name, data)` and `onSessionChanged(newLeaf)`.
   - New `SseClient` registry (`Set` of `{ res, hb, lastLeaf }`), `KEEPALIVE_MS = 15000`, `safeWrite`, `writeSse`, and `openSse` (exact SSE headers, `retry: 2000` first frame, snapshot on connect, `: hb` keep-alive every 15 s, client removed on response close).
   - `GET /events` route (token-gated) in `handle()`.
   - `onSessionChanged` per client: `diffLeaf` → `append` (sanitized entries) / `resync` (full `api.getSnapshot()` payload) / no-op, updating `lastLeaf` in each case.
   - `stop()` closes all open SSE connections (clears heartbeat timers, ends responses) before `server.close()`.

## TDD Evidence

### RED

Command: `node selftest.ts` (after the selftest.ts change, before the index.ts change)

Result: **40 pre-existing checks pass**, then the new SSE block fails and the process exits 1 after the 3 s wait:

```
ok   http: /input oversized -> 413
...
ok   http: token invalid after logout
file:///home/jc1da/Programs/LanyTek/remote_pi_ext/selftest.ts:201
        else if (Date.now() - t0 > ms) { clearInterval(t); reject(new Error("timeout waiting for: " + needle)); }
                                                                  ^
Error: timeout waiting for: event: snapshot
    at Timeout.<anonymous> (file:///.../selftest.ts:201:67)
EXIT=1
```

Why expected: the old server has no `/events` route at all — the SSE client's `GET /events` gets a `404 {"error":"not found"}` JSON response, so the `event: snapshot` frame never arrives and the first `waitUntil` times out. Note: the brief predicted the red error would be `ws.broadcast is not a function`, but the test aborts at the earlier snapshot wait; same missing feature, earlier failure point. Test code is verbatim from the brief; no test changes were needed.

### GREEN

Command: `node selftest.ts && npx tsc -p tsconfig.json`

Result: **`45 passed, 0 failed`** (40 pre-existing + 5 new SSE), tsc silent, exit 0, ~1.2 s wall time (process exits cleanly right after tests — no dangling SSE timers or sockets keeping the event loop alive).

```
ok   http: token invalid after logout
ok   sse: snapshot delivered with 2 entries + meta
ok   sse: retry hint sent
ok   sse: broadcast reaches client
ok   sse: descendant leaf -> append containing new entry
ok   sse: non-descendant leaf -> resync snapshot

45 passed, 0 failed
ACCEPT_EXIT=0
```

The only stderr output is Node's environmental `ExperimentalWarning: Type Stripping` notice — test output is otherwise pristine.

## Files changed

- `index.ts` — web-server section replaced with the brief's SSE version (see deviations below).
- `selftest.ts` — `import http from "node:http";` + verbatim SSE test block.

## Deviations (each documented with a comment at the change site)

1. **`readBody` in index.ts** — brief's code calls `req.destroy()` when the body exceeds 100 KB. Applying the brief verbatim and running the tests reproduced the exact failure Task 5 already documented: `req.destroy()` on an `http.IncomingMessage` also destroys the socket, so the `413 body too large` response can never be delivered (the oversized-body test's fetch rejects with `ECONNRESET` and the selftest crashes mid-http-block). Minimal fix: keep the request stream draining (no socket destroy); buffering stops at the limit, so memory stays bounded and the 413 is delivered. This restores the deviation Task 5 already documented at this same site, which the brief's wholesale section replacement would otherwise have silently regressed. Comment at the change site records this.

No other deviations; all other code is the brief's verbatim.

## Self-review findings

- **Exactly what the brief specifies, nothing more**: yes — section replaced 1:1 (one documented deviation above), test block verbatim. No new helpers, flags, or scope.
- **New tests verify real SSE behavior over real HTTP**: yes — real `http.Server` + real `http.get` client: snapshot on connect with sanitized entries + meta, `retry: 2000` first frame, `broadcast` delivery, append-vs-resync semantics driven by `onSessionChanged`, client removal (connection destroyed in `finally`), clean process exit afterward (heartbeat intervals cleared, no dangling handles — full run finishes in ~1.2 s).
- **Constraints verified beyond the brief's tests** (throwaway probe, no project file changes): exact headers `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`; `retry: 2000` as the first frame; `: hb` keep-alive comment arriving at the 15 s cadence; `broadcast`/`onSessionChanged` never throwing after client removal. All passed; probe deleted afterward.
- **Test output pristine**: yes, apart from Node's environmental Type-Stripping stderr warning.
- **Clean exit**: yes (exit 0, ~1.2 s, no timer/socket hang).
- **description.md**: my rules require updating it on feature changes, but no `description.md` exists anywhere in this project (checked root and `docs/`) — nothing to update.

## Issues / concerns

- The brief's *predicted* RED message (`ws.broadcast is not a function`) differs from the actual RED error (`timeout waiting for: event: snapshot`) — the old server 404s `/events` before the test ever reaches `broadcast`. Both are the same missing feature; the test code is the brief's verbatim and the RED→GREEN sequence is intact.
- `description.md` does not exist in this project, so the "always update description.md" rule had nothing to apply to; flag for the controller in case it exists under a different name.