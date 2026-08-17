# Fix: toolEl remove+recreate discarded `input:` child

## What changed

Single change in `index.ts` — the `toolEl(id, name, state)` function body inside the CHAT_PAGE template literal (page JS).

Before: looked up `#call-<id>`, removed it if present, always created a new `<details>` with `innerHTML` summary, appended it. When `toolstart` re-ran `toolEl` for a tool whose assistant message had already rendered `input:` via `renderEntry`, the remove+recreate destroyed the `input:` child — finished cards showed only output.

After (verbatim from the approved spec): reuses the existing element when present (preserving the `input:` child), creates the `<details>` only when absent (fresh connect / snapshot / toolstart-first orderings still work), updates the `<summary>` in place via `textContent` (inherently XSS-safe, replacing the `innerHTML` + `esc` construction), and inserts the `<summary>` before `firstChild` if one is missing. Aligns with the existing `toolResult` branch, which also updates summaries in place.

No other lines touched. No backticks or `${...}` introduced in the embedded page JS (constraint holds; the "page: no template literals leak into pages" selftest confirms).

## Gate output

Command: `cd /home/jc1da/Programs/LanyTek/remote_pi_ext && node selftest.ts && npx tsc -p tsconfig.json`

Result: `46 passed, 0 failed`, exit code 0, tsc produced no output. The only stderr was Node's `ExperimentalWarning: Type Stripping is an experimental feature` — environmental, not a defect.

Notable checks that pass:
- `page: chat script syntax valid` — the edited embedded script still parses.
- `page: no template literals leak into pages`
- `sse: snapshot delivered with 2 entries + meta`, `sse: broadcast reaches client`, `sse: descendant leaf -> append containing new entry` — the render paths `toolEl` participates in remain covered.

## Self-review

- Change is exactly the approved function-body swap; diff confined to `index.ts` lines 267–278.
- No new files, no test changes (existing page-syntax selftest validates the embedded script; a 3-line-logic function swap needs no new test).
- XSS: summary is now set via `textContent` only; `name`/`state` never touch `innerHTML`. Strictly safer than the removed `innerHTML` + `esc` path.
- Behavior: first call creates the card (autoScroll on creation only, matching prior behavior of one scroll per tool), subsequent calls update the summary in place, all other children (`input:`, `output:` `<pre>` blocks) are preserved.
- No scope drift: `esc` is still used elsewhere in the page JS and was left as-is; selftest.ts untouched.