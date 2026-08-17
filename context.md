# Code Context — `remote_pi_ext/index.ts` (single-file pi extension)

## Current State (2026-08-17, ~1550 lines — details below partially predate the ask bridge; re-verify line numbers)

Features, in file order: auth/cookie+token helpers → CHAT_PAGE (login+chat, incl. header with live context usage, web `/new`/`/compact`/`/model`/`/tree`, and the **ask modal**) → server (`askWaiters`/`askUser`/`settleAsk`/`clientCount`, `/ask-answer` route, `stop()` settles pending asks) → ask bridge (`extractAskQuestions`, `buildAskEnvelope`, `AskTuiComponent`) → factory (`session_*` handlers, web-side commands, `usage` tracking, **`tool_call` hook: ask first-answer-wins**).

- **Ask bridge**: `tool_call` hook intercepts `ask_user_question` when a web client is connected; races the web modal (SSE `ask` + POST `/ask-answer`) against a minimal TUI overlay (`ctx.ui.custom` + pi-tui `Component`); first real answer wins; returns `{block: true, reason: <rpiv-worded envelope>}` (word-for-word parity with `@juicesharp/rpiv-ask-user-question/tool/response-envelope.ts` verified against the installed extension). No web client → `undefined` → rpiv's own flow unchanged. `@earendil-works/pi-tui` is the only non-node: import (resolved from pi's own tree at runtime; devDep for tsc/selftest).
- **Tests**: `selftest.ts` — 120 checks (unit + HTTP protocol + live SSE + fake-pi wiring incl. ask first-wins both directions and the /model command paths), `npx tsc` strict-clean. Reviewed by independent reviewer 2026-08-17; fixes applied: space-in-TUI-type-mode, stale-waiter guard in `askUser`, `wrapText` ellipsis, resync closes ask modal, README Files table.
- **Installed copy is a SYMLINK** (`~/.pi/agent/extensions/remote-pi-ext -> here`); live pi picks up changes on `/reload`/restart.
- pi marks blocked tool calls as `isError` results (api limitation); the web view renders answered/declined envelopes without error styling.

---

# (Below: pre-ask-bridge structural notes, 909-line file state — line numbers stale)


SSE web viewer for the current pi session. Zero runtime deps (`node:http`/`crypto`/`os`/`fs`); the `@earendil-works/pi-coding-agent` import is type-only (line 11). Module-scope state (lines 723–727: `server`, `tokens`, `passwordHash`, `curCtx`, `curPi`) survives across factory re-invocations on `/new`, `/resume`, `/fork`, `/reload` (comment at lines 706–713) because pi re-invokes the factory with a fresh closure but imports the module once.

## Files Retrieved
1. `/home/jc1da/Programs/LanyTek/remote_pi_ext/index.ts` (entire file, lines 1–909) — the only file in scope

## 1. Subscribed pi events (all inside the extension factory, lines 784–831)

| Event | Line(s) | Handler summary |
|---|---|---|
| `session_start` | 784 | Rebind `curCtx = ctx`; `server?.resyncAll()` — full resync of all SSE clients to the (new) session |
| `session_shutdown` | 785–804 | `curCtx = null`; stop server on reason `quit`/`reload`; on `resume` with a *different-cwd* target session file (checked via `sessionFileCwd`, lines 689–705) also stop server (re-import would orphan it); otherwise keep server, awaiting the next `session_start` resync |
| `message_update` | 807–810 | Rebind `curCtx`; `broadcast("update", e.message)` — streams assistant text deltas to clients |
| `message_end` | 811–814 | Rebind `curCtx`; `changed()` → per-client append/resync of the leaf |
| `tool_execution_start` | 815–817 | `broadcast("toolstart", { id: e.toolCallId, name: e.toolName, args: e.args })` |
| `tool_execution_end` | 818–821 | Rebind `curCtx`; `changed()` |
| `model_select` | 822–826 | Rebind `curCtx`; `broadcast("meta", { model: "provider/id" })`; then `changed()` |
| `session_compact` | 827 | Rebind `curCtx`; `changed()` |
| `session_tree` | 828 | Rebind `curCtx`; `changed()` |
| `session_info_changed` | 829 | Rebind `curCtx`; `changed()` |
| `agent_start` | 830 | Rebind `curCtx`; `broadcast("status", { busy: true })` |
| `agent_settled` | 831 | Rebind `curCtx`; `broadcast("status", { busy: false })` |

Also registers commands (not events): `new` (line 837), `compact` (line 844), `webserve` (line 858). `changed()` is defined at line 781 as `() => server?.onSessionChanged(leaf())`.

## 2. Model tracking

- **Event:** `model_select`, line 822. Payload gives a full model object as `e.model`; the handler reads only `provider` and `id`:
```ts
pi.on("model_select", (e, ctx) => {
  curCtx = ctx;
  server?.broadcast("meta", { model: (e.model as { provider: string; id: string }).provider + "/" + (e.model as { provider: string; id: string }).id });
  changed();
});
```
(lines 822–826)
- **Stored:** Nothing is *stored* — the handler only broadcasts the concatenated `"provider/id"` string. The only persistent source of the current model is `ctx.model` on the live `ExtensionContext` (`curCtx`), read at snapshot time:
```ts
meta: {
  cwd: sm.getCwd(),
  model: ctx.model ? (ctx.model as { provider: string; id: string }).provider + "/" + (ctx.model as { provider: string; id: string }).id : "",
  sessionName: sm.getSessionName() ?? null,
  leafId: sm.getLeafId(),
},
```
(lines 747–752, inside `api.getSnapshot()`)
- **Full model object?** The full object is *transiently* available at `ctx.model` (line 750) and in the `model_select` payload `e.model` (line 824), but the code never retains it and never reads any field other than `provider` and `id`. Nowhere in the file is `contextWindow`, `maxTokens`, `cost`, or any usage field touched.

## 3. Web header state: build + push

- **Shape:** `SnapshotMeta` interface, lines 447–452: `{ cwd: string; model: string; sessionName: string | null; leafId: string | null }`. Built in `api.getSnapshot()` lines 740–756 (quoted above) from `sessionManager.getCwd()`, `ctx.model`, `sessionManager.getSessionName()`, `sessionManager.getLeafId()`.
- **SSE envelope:** `writeSse`, lines 522–528:
```ts
function writeSse(res: http.ServerResponse, name: string, data: unknown): boolean {
  ...
  return safeWrite(res, "event: " + name + "\ndata: " + payload + "\n\n");
}
```
- **Event names used server→client:** `snapshot` (on connect), `resync` (full re-send), `append` (leaf delta), `update` (text delta), `toolstart`, `status` (`{busy}`), `meta` (`{model}` — the *only* live header update), `note` (`{text}`).
- **Where header state is updated/broadcast:**
  - Connect: `openSse` lines 541–556 writes `snapshot` with full meta (see item 5).
  - Session replacement: `resyncAll()` lines 631–640 → `writeSse(res, "resync", { entries, meta })` to every client, then `c.lastLeaf = snap.meta.leafId`.
  - Leaf resync path: `onSessionChanged` lines 641–666, resync branch lines 652–658, same `resync` event.
  - Live model change only: line 824 `broadcast("meta", { model: ... })` — no other meta field ever changes live.
- **Client-side header rendering:** `updateMetaLine` lines 276–279 renders it into the `<span id="meta">` header element:
```js
function updateMetaLine() {
  metaEl.textContent = (curMeta.sessionName || 'pi session') + '  ·  ' + (curMeta.model || '') + '  ·  ' + (curMeta.cwd || '');
  if (curMeta.sessionName) document.title = curMeta.sessionName;
}
```
Called from `renderSnapshot` (line 379, after `curMeta = d.meta`) and from the `meta` SSE listener (line 408: `curMeta.model = ...; updateMetaLine()`).

## 4. Token usage / context size / context window

- **Nothing computed, stored, or sent.** Grep for `usage`, `contextWindow`, `maxTokens`, `cost`: zero matches for those concepts.
- The only token-related data is:
  - `tokensBefore` on `compaction` entries — whitelisted in `ENTRY_FIELDS` (line 77) and rendered client-side as a note (line 371): `— compacted (N tokens before) —`.
  - "tokens" as 256-bit auth-cookie strings (lines 40–67, 533, 724, 880) — unrelated to LLM usage.
- So context-window size, current context fill, and per-message usage are entirely absent today; adding them would require new reads on `ctx.model`/usage fields plus meta/SSE changes.

## 5. Initial sync + resync

- **On connect:** `GET /events` (line 583) → `openSse` (lines 541–556):
```ts
safeWrite(res, "retry: 2000\n\n");
const snap = api.getSnapshot();
writeSse(res, "snapshot", { entries: snap.entries, meta: snap.meta });
const client: SseClient = { res, hb: setInterval(...), lastLeaf: snap.meta.leafId };
```
Entries come from `sessionManager.buildContextEntries()` sanitized through the `ENTRY_FIELDS` whitelist (lines 75–99, 129–140; unknown types dropped, `parentId` never sent). `lastLeaf` is the client's baseline for later appends.
- **After `/new` / `/fork` / `/resume`:** `session_shutdown` (lines 785–804) nulls `curCtx` (server kept except quit/reload/cross-cwd resume); pi then re-invokes the factory (module state survives), and the new closure's `session_start` handler (line 784) fires `server?.resyncAll()`, which re-reads the fresh snapshot and sends every connected client a `resync` event with full `{ entries, meta }` (lines 631–640), resetting each client's `lastLeaf`.
- **Incremental leaf moves** (normal message/tool traffic) go through `onSessionChanged` (lines 641–666) + `diffLeaf` (lines 101–128): walk `parentId` from new leaf back to the client's `lastLeaf`; contiguous → `append` (sanitized entries only), any chain break (tree nav, resume, re-root) → per-client `resync`.

## 6. HTML/JS location + header rendering

- **`LOGIN_PAGE`:** lines 149–186 (single-file HTML: password form → `POST /login`).
- **`CHAT_PAGE`:** lines 187–437 (embedded `<style>` lines 193–220; header DOM lines 221–227: `<div class="dot" id="dot">`, `<span class="meta" id="meta">`, `#stop`, `#logout`; client JS lines 229–435: `esc`, `addMsg`, `toolEl`, `renderEntry`, `renderSnapshot`, EventSource listeners lines 388–409, `send`/`stop`/`logout` handlers).
- **Header rendering (client):** header is a static 3-part meta line: `sessionName · model · cwd` written by `updateMetaLine` (lines 276–279) into `#meta`; busy dot is a CSS class toggle on `#dot` via `setBusy` (lines 280–284, driven by the `status` SSE event, line 407). There is no tokens/context gauge in the header — a new meta field would need: server `SnapshotMeta` (line 447) + `getSnapshot` (lines 747–752) + optionally a new SSE event or piggybacking on `meta`/`snapshot` + client `curMeta` consumers (lines 276–279, 378–379, 408).

## Architecture (one paragraph)
`/webserve start` (line 858) prompts for a password (SHA-256 hashed, line 879/880), then `startServer` (lines 529–690) binds an `http.Server` (port scan +1..+9 on EADDRINUSE, lines 883–890). Auth is a 256-bit cookie token set at `/login`. `GET /events` opens one SSE stream per authenticated client; all other routes (`/input`, `/stop`, `/logout`) are plain JSON POSTs. The server's `WebApi` seam (lines 454–460) is implemented in the factory closure against module-level `curCtx`/`curPi` so every call routes through the *current* pi instance. Events from pi flow: direct broadcasts (`update`, `toolstart`, `meta`, `status`, `note`) or leaf-diffed append/resync via `onSessionChanged`.

## Start Here
Open `/home/jc1da/Programs/LanyTek/remote_pi_ext/index.ts` at lines 447–452 (`SnapshotMeta`) and 740–756 (`getSnapshot`) — that's the header/meta model where any new context-window or usage field would be added; lines 822–826 (`model_select`) show the existing live model-change broadcast pattern to mirror.