# Context: remote-pi-ext (pi-cockpit) — current surface map

Repo: `/home/jc1da/Programs/LanyTek/remote_pi_ext`
Files: `index.ts` (2574 lines, the whole extension), `selftest.ts` (1542 lines), `README.md`, `description.md`, `package.json`, `tsconfig.json`, `docs/` (empty). No build step; everything ships as `index.ts` + `description.md`.

---

## 1. ARCHITECTURE

### Transport
- **Zero-dependency `node:http`** server (`startServer`, index.ts:1829-2083). No framework, no runtime npm deps.
- **Server → browser: Server-Sent Events** — `GET /events` (index.ts:1884 `openSse`), `Content-Type: text/event-stream`, `retry: 2000` hint, keep-alive comment every 15 s (`KEEPALIVE_MS` 1713). Client uses `new EventSource('/events')` (index.ts:1200).
- **Browser → server: JSON POST routes** — `/login` (1915), `/input` (1932), `/stop` (1946), `/ask-answer` (1950), `/logout` (1983). All except `/` and `/login` require the token cookie.
- SSE event names emitted: `snapshot`, `resync`, `update` (streaming assistant partials), `append` (new session entries), `toolstart`, `bashstart`/`bashout`/`bashend`, `status` (busy), `meta` (model/usage/cost), `note`, `ask`, `ask-resolved`, `modelpick`, `treepick`.
- **Change detection:** every pi event calls `changed()` (2206) → `onSessionChanged(newLeaf)` (2039) → per-client `diffLeaf` (131) walks `parentId` links from the client's last leaf to the new leaf; contiguous → `append`, broken (tree nav / resume / compaction re-root) → full `resync` snapshot (2048-2062). Per-client `lastLeaf` tracked in `SseClient` (1755).
- Body limits: 100 KB general (`BODY_LIMIT` 1705), 12 MB for `/input` (images; `INPUT_BODY_LIMIT` 1708), 32 KB text (`INPUT_LIMIT` 1709).

### How the pi extension hooks in
Module-scope state (2112-2117): `server`, `tokens`, `passwordHash`, `curCtx`, `curPi` — survives pi's factory re-invocation across session replacement. Default export (2123) rebinds `curPi`/`curCtx` and rebinds the *same* server's `api` to the current session (2128-2207 `WebApi`: `getSnapshot` 2129, `allEntries` 2149, `sendInput` 2160, `stopAgent` 2193).

**`pi.on` events (2272-2412):**
| event | line | action |
|---|---|---|
| `session_start` | 2272 | rebind ctx, `resyncAll()` |
| `session_shutdown` | 2273 | quit/reload → stop server; cross-cwd `resume` → stop (module re-import would orphan it, see `sessionFileCwd` 2095); new/fork/same-cwd resume → keep |
| `message_update` | 2295 | broadcast `update` (streaming partials) |
| `message_end` | 2299 | leaf change → append/resync |
| `tool_execution_start` | 2303 | broadcast `toolstart` |
| `tool_execution_end` | 2306 | leaf change |
| `model_select` | 2310 | broadcast `meta` (model + usage + cost) |
| `session_compact` / `session_tree` / `session_info_changed` | 2315-2317 | leaf change |
| `agent_start` / `agent_settled` | 2318/2319 | broadcast `status` busy; on settle broadcast fresh `meta` + flush trailing entry |
| `context` | 2338 | **bash visibility hook**: injects session `bashExecution` entries missing from the live message list (only single-`!`, never `!!`), compaction-aware |
| `tool_call` | 2362 | **ask_user_question bridge**: intercepts the tool before execution; dual-surface race (web modal + terminal `AskTuiComponent`), first answer wins, returns `{block, reason}` with the rpiv tool's exact result wording |

**`pi.registerCommand` (2424-2574):** `new` (2424), `compact` (2431), `model` (2451), `tree` (2492), `webserve` (2523). Names must match `WEB_COMMANDS` (200) — selftest asserts the match.

### Message flow
- **Web → agent:** page `POST /input {text, mode, images}` → `api.sendInput` (2160): bang lines go to `webBash` (2210), everything else `pi.sendUserMessage` with `inputOpts` (184): idle = direct; busy = `steer` (chat, like terminal Enter) or `followUp` (slash commands only); slash input gets `expandPromptTemplates: true` (skills/prompt templates dispatch like terminal).
- **Agent → web:** as above via SSE. Optimistic user bubble ("pendinguser") is solidified when the persisted entry appends; chronological position preserved even though pi 0.84.x persists the user entry *after* the reply starts streaming (comment at 1085-1092).
- **Web `!` bash:** `parseBashLine` (223) → `runWebBash` (276) using pi's own `createLocalBashOperations` + `SettingsManager` shell settings; streams via `bashout` (capped 200 KB, `BASHOUT_STREAM_LIMIT` 254), 10-min timeout (257), one-at-a-time guard (2218-2224), result recorded via `SessionManager.appendMessage` as a pi-format `bashExecution` entry (2246), overflow to temp file, `!!` sets `excludeFromContext`.
- **Ask bridge:** `server.askUser` (1859) broadcasts `ask`, keeps the question with the waiter so (re)connecting clients are **replayed** the pending modal (1884 `openSse`); `POST /ask-answer` settles; first answer wins, duplicate → 409. Terminal side is `AskTuiComponent` (519-638) via `ctx.ui.custom` overlay; no web client → hook stays out of the way, tool's own TUI flow runs.

### Security model
- Password (min 4 chars, asked in terminal) stored **only as SHA-256 hex in memory** for the server's lifetime (`hashPassword` 42, `verifyPassword` 50 with `timingSafeEqual`).
- Login issues a **256-bit random token** in an HttpOnly, SameSite=Lax cookie, 7-day Max-Age (`issueToken` 64, `cookieHeader` 68). Token set per server run; logout removes it.
- Binds **0.0.0.0**, plain **HTTP** — LAN assumption, no rate limiting (both documented in README/description.md; `ssh -L` recommended for remote).
- Content exposure controlled by `sanitizeEntry` (106) field whitelist; `parentId` never leaves the server.

### index.ts top-level layout (line ranges)
| range | section |
|---|---|
| 1-32 | header doc + imports (pi-coding-agent, pi-tui, node:http/crypto/os/fs/path) |
| 35 | `AnyRec` type |
| 37-55 | password: `hashPassword` 42, `verifyPassword` 50 |
| 57-87 | tokens/cookie: 61, 64, 68, 72, 77 |
| 89-115 | `ENTRY_FIELDS` 91, `sanitizeEntry` 106 |
| 116-160 | `LeafDiff` 120, `diffLeaf` 131 |
| 162-182 | `sessionCost` 162 |
| 184-198 | `inputOpts` 184 |
| 200-210 | `WEB_COMMANDS` 200, `entryPreview` 203 |
| 211-368 | web `!` bash: `parseBashLine` 223, ANSI regex 231, `cleanBashText` 237, limits 254/257, `runWebBash` 276, `missingBashMessages` 343, `mergeBashMessages` 357 |
| 370-638 | ask bridge: types 383-409, `extractAskQuestions` 416, `buildAskEnvelope` 446, text helpers 465-516, `AskTuiComponent` 519-638 |
| 639-681 | `LOGIN_PAGE` 644 |
| 682-1700 | `CHAT_PAGE` (inline HTML + CSS + all client JS, see §3) |
| 1701-2083 | web server: limits 1705-1713, `SnapshotMeta` 1715, `WebApi` 1724, `WebServer` 1731, `readBody` 1761, `parseImages` 1788, helpers 1802-1827, `startServer` 1829 (routes 1905-2008, server object 2009-2071, listen 2073-2083) |
| 2084-2574 | pi wiring: `noCtxError` 2085, `sessionFileCwd` 2095, module state 2112-2117, `stopServer` 2119, default export 2123 (api 2128-2207, `webBash` 2210-2267, lifecycle 2272-2290, live events 2295-2331, context hook 2338, tool_call hook 2362-2412, commands 2424-2574) |

---

## 2. FEATURE INVENTORY (all in index.ts unless noted)

| feature | where |
|---|---|
| `/webserve start [port] \| stop \| status` (default 8765, +10 port scan, password prompt, prints LAN URLs, status line "web :port") | 2523-2574, `lanUrls` 2074 |
| Chat bubbles: user (right) / assistant (left), pending dashed → solidified on entry append | `renderEntry` 1075-1188, `sendText` 1567-1594 |
| Steer / queue input: Send steers while busy (terminal-Enter parity); `followUp` mode available in `/input` API (no web Queue button — asserted in selftest) | `inputOpts` 184, `send()` 1607 |
| Slash commands from web: `/new` 2424, `/compact [instructions]` 2431, `/model` 2451, `/tree` 2492, `/webserve` 2523; solid bubble + note below; `WEB_COMMANDS` 200 keeps page in sync |
| `ask_user_question` bridge: web modal (multi-question, options/multi-select/custom/notes/previews) + terminal overlay, first answer wins, replay to reconnecting clients, rpiv-identical result wording | 370-638, 1281-1439 (modal JS), 1859-1882 (server), 2362-2412 (hook) |
| `!` / `!!` web bash: host shell, live card with streaming output, session recording, context injection (`!`) / exclusion (`!!`), 10-min kill, one at a time | 211-368, 2210-2267, 2338-2345, client cards 1243-1270 |
| Tool-output cards: `<details>` per tool call (`input:` / `output:`, error styling), reused for bash cards; toolbar filter All/Errors/Hidden + Collapse-all | `toolEl` 1054, toolResult render 1131-1159, bashExecution 1160-1186, toolbar 1673-1699 |
| Thinking display: live collapsed 💭 box in streaming bubble → folded 💭 block above finalized answer | `thinkHtml` 966, update handler 1203-1231, finalize 1116-1130 |
| Markdown rendering (custom, esc-first, no lib): headings h1-h4, bold/italic/inline code, lists, quotes, links (http/https/mailto only, `target=_blank rel=noopener`), fenced code with language tag + copy button; applied on finalize only | `mdInline` 895, `md` 909-964, copy 1614-1641 |
| Image attachments: 📎 button, paste, drag-drop; max 3 × ~4.5 MB base64 (png/jpeg/webp/gif); thumbnails in bubbles; rides as ImageContent parts | client 811-865, `parseImages` 1788, `sendInput` 2174-2184, thumbs 1089-1098 |
| Cost meter: header session total ($, hidden when 0/unpriced) + per-answer call cost tag | `sessionCost` 162, `fmtCost` 993, meta line 1008-1018, bubble tag 1117-1122, broadcasts 2310/2319 |
| Context-usage meter: header `45k/200k (23%)` (same source as terminal `/context`), updates on run settle + model change, `—` after `/compact` | `usageText` 998, meta 1715/2137, `meta` event client 1272-1278 |
| Mobile adaptations: `@media (max-width:640px)` wraps meta + hides cwd; modals are bottom sheets; ⏳ tab-title as universal busy indicator | CSS 703, `setBusy` 1045 |
| Session-replacement handling: server survives `/new`, `/fork`, same-cwd `/resume` (resyncs all clients); cross-cwd `/resume` stops it (module re-import); quit/`/reload` stop | 2273-2290, `resyncAll` 2025, `sessionFileCwd` 2095 |
| Reconnect/replay: EventSource auto-retry 2 s + `retry: 2000`; on connect client gets full `snapshot` + every pending `ask`; 15 s keep-alive comments | 1884-1903 |
| Finish notifications: 🔔 header button (Notification API, hidden on plain-HTTP LAN), fires when tab hidden with session name + 150-char snippet; click refocuses | `notifyDone` 1026-1043, button 1648-1672 |
| `/model` picker: bare `/model` → `modelpick` event → one-click modal of scoped/available models; bare-id switch; ambiguity + no-API-key notes | 2451-2490, client 1441-1497 |
| `/tree` picker: bare `/tree` → `treepick` event → one-click modal of user-message jump points (current leaf marked); jump via `navigateTree` | 2492-2521, client 1500-1565 |
| Stop button (programmatic Esc) | `/stop` 1946, `stopAgent` 2193, button 1642 |
| Busy indicator: header dot (green/yellow) + Stop visibility + input placeholder | `setBusy` 1045-1052, `status` event 1271 |
| Session-name / model-change / thinking-level / branch-summary / compaction markers as centered notes | 1174-1188, `note` event 1279 |
| npm packaging: `package.json` — name `remote-pi-ext` v0.2.0, `pi.extensions: ./index.ts`, ships `index.ts` + `description.md`, MIT, zero runtime deps | package.json |

---

## 3. CLIENT-SIDE (injected page JS, index.ts:809-1699)

- Vanilla JS, no libraries, no build; **no backticks / `${}` allowed** inside (nested in a TS template literal; selftest checks no leak, 118).
- **Events:** `EventSource /events` with listeners for snapshot/resync/update/append/toolstart/bashstart/bashout/bashend/status/meta/note/ask/ask-resolved/modelpick/treepick (1200-1565).
- **Persistence (localStorage):** `piCockpitNotif` (🔔 on/off, 1020-1025 accessors, 1654/1659), `piCockpitToolFilter` (all/errors/none, 1681-1684). That's all — no chat history persistence, scroll position, or theme stored.
- **State:** `userQ` queue of optimistic user bubbles matched against appended entries (1075-1098); `curMeta` (session name, model, cwd, usage, cost) for the header meta line (1008-1018) and `document.title` (⏳ prefix when busy).
- **Modals:** ask (options, multi-select, "Type something.", notes, live previews, submit → `POST /ask-answer`), model picker, tree picker — all bottom-sheet masks (1281-1565).
- **Clipboard:** `navigator.clipboard` with `execCommand` fallback for plain-HTTP LAN (1614-1641).
- **Notifications:** Notification API with permission-request flow; auto-hides when unavailable/denied (1648-1672).
- **Mobile:** CSS media query only (wrap/hide); no separate mobile code paths.
- **Security in page:** all model text through `esc()` (870) before any HTML insertion; `md()` re-escapes first.

---

## 4. TESTING

- **Command:** `node selftest.ts` — requires Node ≥ 23.6 for native TS type stripping (machine has v23.11.1). No framework, no fixtures; exit code 1 on any failure (selftest.ts:1543). Also `npx tsc -p tsconfig.json` for strict type check (tsconfig: strict, noEmit, nodenext).
- **Result just run:** `231 passed, 0 failed` (README says "231 checks"; the file defines 234 `check()` calls — 3 are abort-guard checks that only execute when a wiring phase's server fails to start: selftest.ts:1131, 1292, 1396).
- **Sections (selftest.ts line ranges):** password 15, tokens/cookie 26, sanitizer+leaf-diff 42, session cost 68, pages (syntax, formatting, wiring assertions) 99, ask envelope+extractor 294, ask TUI component 337, HTTP server vs fake pi api 388, inputOpts 485, web-bash pure helpers 497 (incl. real-shell `runWebBash` runs), SSE streaming 562, server-side askUser 654, pi wiring 762 (factory re-invocation across session replacement, `/resume` cwd policy, `/model` `/tree` `/new` `/webserve` command handlers via a `fakePi` harness, bash wiring end-to-end, ask-hook first-answer-wins matrix, usage/cost refresh on `agent_settled`/`model_select`), client ordering under a DOM stub 1300-1540 (the real page script is extracted and driven with a fake DOM + fake EventSource + fake Notification).
- **Not covered:** no real-browser E2e (DOM stub only — no real SSE over the wire, no real clipboard/notifications), no multi-client concurrent-input race, no token expiry/revocation over time, no HTTPS/TLS, no rate-limit behavior, no `lanUrls` enumeration test, no memory-leak/long-run check, no cross-platform (Windows shell paths), and nothing exercises pi itself (all pi interaction is faked).

---

## 5. GAPS / WEAK SPOTS

**Marked code (only 3 `ponytail:` comments, no TODO/FIXME):**
- index.ts:627 — `AskTuiComponent.close()`: pi's `hideOverlay()` pops the topmost overlay; if the user stacked another overlay over ours, the wrong one is popped (no per-overlay close API in pi).
- index.ts:2225 — fresh `SettingsManager` per web `!` (two small JSON reads); cache if bash gets frequent.
- index.ts:2358 — headless corner case: if the web client leaves and never returns while a question is pending, the agent waits for Stop/abort (tool's own flow can't render headless either); accepted.
- Documented known limitation (description.md): a web `!` running while a terminal resync happens is not shown as a live card in the terminal (entry lands on next sync).

**Structural smells:**
- Model string `provider + "/" + id` built in 4 separate places (getSnapshot 2133, model_select broadcast 2311, /model handler 2459/2470/2481) — drift risk, no shared helper.
- `WEB_COMMANDS` (200) and the five `registerCommand` calls must be kept in sync by hand; selftest pins it, but a new web command requires touching both plus the page's `CMD` injection.
- The ask-bridge result wording is pinned byte-for-byte to the rpiv-ask-user-question extension's output (selftest 307-322) — fragile if that extension changes its wording.
- `docs/` directory is empty — spec references ("spec §3–§7" comments) point to a spec that doesn't live in the repo.
- No login rate limiting (explicit LAN assumption, README Security).
- No HTTPS; clipboard/Notification features silently degrade on plain-HTTP LAN (documented, but a feature gap for phone users away from `ssh -L`).

**Pi-ecosystem features the web UI does NOT expose** (checked index.ts/selftest + `pi-coding-agent/docs` in node_modules):
- **Subagents** — no fleet status, no spawn UI (pi has `subagent/` extension support; this repo only ever drives the one local session).
- **Missions / schedules / watchdog** — no concept anywhere in the repo; pi-coding-agent docs include none of these either, so nothing to mirror, but there is no "agent is stuck / idle for X" watchdog view on the web.
- **Skills** — only indirectly: `/`-prefixed input goes through `expandPromptTemplates` (184), so user-typeable skills/templates dispatch; but there is no skills list/browser in the UI and no way to see which skills exist.
- **Sessions** — no session *list* or resume picker from the web: `/new` and `/tree` (intra-session jumps) exist, but there is no `/resume <file>`, no browse-past-sessions, and cross-cwd `/resume` *stops* the server entirely (2273-2290). No `/fork` from the web (survives but not invokable).
- **Cost/token breakdown** — only session total cost and current context usage; no per-model breakdown, no per-day, no token split (input/output/cache), no `/session`-equivalent stats page in the UI (terminal has it).
- **File tree / files** — no file access at all (no browse/edit files from the web; only bash `!` can touch the filesystem).
- **Terminal access** — no interactive shell; only fire-and-forget `!` lines (one at a time, 10-min cap, no streaming-in of keyboard input).
- **Git integration** — none.
- **Other:** no multi-session side-by-side, no search in history, no export/share of session, no theming (hardcoded dark palette 683-763), no language/locale, no keyboard shortcuts beyond Enter/Shift+Enter.

---

## 6. DEPENDENCIES

**package.json** (v0.2.0, MIT, `type: module`):
- `dependencies`: **none** (zero runtime deps; only node: builtins + pi's bundled packages).
- `peerDependencies`: `@earendil-works/pi-coding-agent: *`, `@earendil-works/pi-tui: *` (provided by the pi host).
- `devDependencies` (type-check only): `@earendil-works/pi-coding-agent ^0.84.2`, `@earendil-works/pi-tui ^0.84.2`, `@types/node ^22`, `typescript ^5.5`.
- `files`: `index.ts`, `description.md`; `pi.extensions`: `./index.ts`.

**node_modules (installed):** `@earendil-works/pi-coding-agent` 0.84.2 (whose own deps: pi-agent-core, pi-ai, pi-client, pi-protocol, pi-tui, photon-node, chalk, cross-spawn, diff, glob, grok-mermaid, highlight.js, hosted-git-info, ignore, jiti, minimatch, proper-lockfile, semver, typebox, undici, yaml), `@earendil-works/pi-tui` 0.84.2 (depends on `marked` 18.0.5 — transitive; the page uses its own custom `md()`, not marked), plus `marked`, `get-east-asian-width`, `undici-types`, `typescript`, `@types/*`, `npx`. README: "node_modules only exists for type checking; pi never loads it."