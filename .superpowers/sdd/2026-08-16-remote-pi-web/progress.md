# SDD ledger — plan: docs/superpowers/plans/2026-08-16-remote-pi-web.md

## Environment adaptations (no git repo in this project)
- No git commits (user rule + plan Global Constraints): ledger lines record files/gates, not commit SHAs.
- Review packages = full-file snapshots (index.ts, selftest.ts, others touched) written into this workspace; reviewer reads one file.
- Only one model tier available: all builtin subagents inherit `lanytek-home/Qwen3.8-27B-W4A16`. Tiering from SKILL.md Model Selection not applicable; implementer+reviewer both run on it.
- Work happens in-place in /home/jc1da/Programs/LanyTek/remote_pi_ext (not a git repo, fresh directory — no branch isolation needed).

## Pre-flight conflict scan (run before Task 1 dispatch)
| Pair | Produces → Consumes | Finding |
|---|---|---|
| T1 → T2 | T1 import line already contains `randomBytes` (used by T2); T2 appends after password section | consistent, no action |
| T3 → T6 | `diffLeaf` returns raw entries; T6 server sanitizes before writing SSE | consistent (T3 note documents it) |
| T4 → T6 | CHAT_PAGE references `new EventSource('/events')`; T6 implements the route | consistent (page inert until server exists) |
| T5 → T6 | T5 server section (WebServer {port,stop}) replaced wholesale by T6 section | consistent (T6 says "replace from marker to EOF") |
| T5 → T7 | T7 says "replace the import line" but T5 added a SECOND import line (node:http) | AMBIGUOUS — see ruling below |
| T7 → T8 | T8 = one doc file, no code coupling | batch T8 into T7 dispatch (one implementer, one review unit) |
| T7 step 4 | manual TUI+browser e2e cannot run headless | see ruling below |

- Ruling: T7 dispatch states explicitly — remove BOTH existing import lines at top of index.ts (the node:crypto line from T1 and the node:http line from T5) and replace with the exact 4-line block from the brief. — cost if wrong: duplicate import caught by tsc gate anyway.
- Ruling: T7 subagent runs automated gates only (selftest + tsc); the manual e2e checklist (Task 7 step 4) is handed to the user after final review, since it needs an interactive TUI and a browser. — cost if wrong: e2e issues surface at handoff instead of mid-execution; acceptable, user wants the browser check.
- Ruling: T7+T8 execute as ONE dispatch with both briefs; one review covers both (batched small same-shape work per SKILL.md). — cost if wrong: slightly larger review surface.

## Task 1: Scaffolding + password helpers
- dispatch: worker (fresh ctx, lanytek-home/Qwen3.8-27B-W4A16), brief task-1-brief.md, report task-1-report.md- ⚠️ resolved: node_modules verified by controller (tsc, @types/node, pi types all present).
- ⚠️ resolved: Node 23 "ExperimentalWarning: Type Stripping" stderr line is Node's own output for any native .ts run; stdout pristine; inherent to the brief's `node selftest.ts` gate — environmental, not a code defect.
- Task 1: minor (deferred): randomBytes imported unused until Task 2 (as planned)
- Task 1: minor (deferred): >64-char hex hash would verify if first 64 chars match (theoretical; hashes self-produced at exactly 64 chars)
- Task 1: minor (deferred): `expected.length === 0` subsumed by length-compare guard (harmless explicitness)
- Task 1: complete (files: package.json, tsconfig.json, index.ts, selftest.ts; gates: selftest 6/6 + tsc clean; review clean)
- Task 2: DONE (files: index.ts, selftest.ts; selftest 14/14 + tsc clean; verbatim, no deviations; description.md still absent — created in Task 8 per plan)
- ⚠️ resolved: tsconfig.json contents known to controller (Task 1 verified byte-identical to plan); consistent with tsc gate.
- Task 2: minor (deferred): tokenFromCookie rejects OWS around '=' (RFC 6265) — fail-safe, brief-verbatim
- Task 2: minor (deferred): cookie-header test checks prefix+flag substrings, not full-string equality — brief-verbatim
- Task 2: minor (deferred to final review, pre-existing from T1): index.ts header comment references pi import not yet present (lands in Task 7); AnyRec unused until Task 3
- Task 2: complete (files: index.ts, selftest.ts; gates: selftest 14/14 + tsc clean; review clean)
- Ruling: Task 3 brief defect — its import line omitted `AnyRec` that its own test block references (tsc TS2304). Implementer's minimal fix (export `type AnyRec` from index.ts + `type AnyRec` in selftest import) approved: it is the smallest change that compiles, type-only (erased at runtime), and matches the brief's Interfaces section which lists AnyRec as produced. Cost if wrong: an extra type export — zero runtime impact.
- Task 3: DONE (files: index.ts, selftest.ts; selftest 21/21 + tsc clean; 1 documented deviation per ruling above; also resolves T2's deferred "AnyRec unused" note)
- Task 3: minor (deferred): 100k cycle guard untested (brief's test scope)
- Task 3: minor (deferred): only the `message` whitelist row directly sanitize-tested; other rows are data
- Task 3: minor (deferred to T6 review): sanitizeEntry passes explicit null field values through — SSE writer must tolerate nulls (it does: JSON.stringify of null is valid SSE data)
- Task 3: complete (files: index.ts, selftest.ts; gates: selftest 21/21 + tsc clean; review clean; AnyRec-export deviation adjudicated correct)
- Task 4: DONE (files: index.ts, selftest.ts; selftest 26/26 + tsc clean; verbatim, no deviations)
- ⚠️ resolved (T4): tsc gate rests on implementer report (tsconfig known to controller from T1); server payload shapes belong to Task 5/6.
- Task 4: minor (deferred): renderSnapshot leaves detached pendingEl/pendingUserEl refs (self-heal on next event)
- Task 4: minor (deferred): single-slot optimistic user bubble can ghost on rapid double-send (cosmetic)
- Task 4: minor (deferred): assistant text bubble renders after toolCall bubbles regardless of content-part order (cosmetic)
- Task 4: minor (deferred): login fetch has no .catch (unhandled rejection on network failure, no UI feedback)
- Task 4: complete (files: index.ts, selftest.ts; gates: selftest 26/26 + tsc clean; review clean; XSS audit clean)
- Task 5: DONE (files: index.ts, selftest.ts; selftest 40/40 + tsc clean)
- ⚠️ adjudicated (T5): deviation 1 — brief's two IIFE checks rewritten as direct awaits (verbatim form fails tsc: Promise vs boolean; also a runtime false-positive). Correct and minimal.
- ⚠️ adjudicated (T5): deviation 2 — req.destroy() removed in readBody on oversize: it killed the socket so the 413 could never be delivered (client saw ECONNRESET). Draining instead is the minimal correct fix.
- Task 5: review dispatch pending
- Task 5: minor (deferred): unauthenticated unknown paths -> 401 not 404 (brief-verbatim ordering)
- Task 5: minor (deferred to T7): stale header comment (index.ts:8-9) references node:os + pi import; cleanup with T7
- Task 5: minor (deferred to T7): tokens Set unbounded until explicit logout (cookie Max-Age does not evict); lifecycle owner is T7
- Task 5: minor (deferred): no 404/503/message-too-long test cases (brief's block omits them; final review may add)
- Task 5: complete (files: index.ts, selftest.ts; gates: selftest 40/40 + tsc clean; review clean; both adjudicated deviations verified correct)
- Task 6: DONE (files: index.ts, selftest.ts; selftest 45/45 + tsc clean; SSE probes verified headers/retry-first/15s-hb/broadcast-no-throw)
- ⚠️ adjudicated (T6): brief re-introduced req.destroy() in readBody (pre-T5 version); implementer correctly kept the Task-5 no-destroy fix with a documenting comment. Correct.
- ⚠️ adjudicated (T6): brief's predicted RED message differs from actual (snapshot timeout vs broadcast-not-a-function) — same missing feature, earlier failure point. Acceptable; tests are verbatim.
- Task 6: review dispatch pending
- Ruling (T6): keep-alive comment text ratified as `: hb` per plan code (plan line 1155); spec prose ": keep-alive" is descriptive. No change.
- Task 6: minor (folding into T7): writeSse JSON.stringify outside safeWrite try/catch — wrap so broadcast never throws even for non-serializable payloads
- Task 6: minor (folding into T7): onSessionChanged resync calls api.getSnapshot() unguarded — NO_CTX from real WebApi would propagate into pi event handler; guard it
- Task 6: minor (deferred): no test assertions for 15s hb cadence / stop-with-live-client / two-client isolation (probe-verified by implementer)
- Task 6: minor (noted): post-stop keep-alive sockets can delay process exit seconds; irrelevant in pi (server stop != process exit), selftest exits clean
- Task 6: complete (files: index.ts, selftest.ts; gates: selftest 45/45 + tsc clean + clean exit; review clean)
- Task 7: DONE (files: index.ts, selftest.ts; selftest 46/46 + tsc clean; 3 approved hardening items applied; 1 type-assertion deviation documented)
- Task 8: DONE (files: description.md verbatim from brief; selftest 46/46 + tsc clean)
- Task 7: DONE (files: index.ts; selftest 46/46 + tsc clean; manual e2e -> user at handoff)
- ⚠️ adjudicated (T7): brief's `e as AnyRec` ×2 became `e as unknown as AnyRec` — TS2352 (pi SessionEntry members are interfaces w/o index signature); erased at runtime, behavior identical. Correct.
- ⚠️ resolved (T5): "stale" header comment is NOT stale — T7's imports (node:os, type-only pi) make it accurate. No cleanup needed.
- Task 7: hardening 1 DONE (writeSse JSON.stringify try/catch — broadcast can never throw; new circular-payload check added as 46th selftest)
- Task 7: hardening 2 DONE (onSessionChanged resync getSnapshot try/catch — NO_CTX at session end closes one client, never propagates to pi handler)
- Task 8: DONE (description.md created verbatim from brief; gates stay green 46/46 + tsc)
- ALL TASKS COMPLETE — dispatching final whole-project review (full files vs spec + plan + all deferred minor findings)
- Final whole-project review: spec §1-§10 ✅, all 7 SSE names + payload fields line up, security/crash/leak audits clean, all 22 deferred findings accepted, no criticals. ONE Important fix required:
- FINAL FIX (fix dispatch): toolEl() remove+recreate drops the tool card's input <pre> when toolstart arrives after the assistant entry rendered it (normal pi ordering). Fix: reuse existing call-<id>, update summary via textContent. Page JS only.
- FINAL FIX: applied + controller-verified (toolEl reuse-or-create + textContent summary; only index.ts touched; controller re-ran gate: 46/46 + tsc silent, exit 0)
- ALL WORK COMPLETE. Handing to user with manual e2e checklist (Task 7 Step 4).
