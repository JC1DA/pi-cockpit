# Task 4 Report: Web pages (login + chat)

## What I implemented

Per `task-4-brief.md`, verbatim:

1. **`selftest.ts`** — extended the import line to add `LOGIN_PAGE, CHAT_PAGE`; appended the `// ---------- pages ----------` test block (5 checks) before the final `console.log` summary lines. The appended block was verified **byte-for-byte identical** to the brief's Step 1 code block (programmatic `includes()` check against the block extracted from the brief).
2. **`index.ts`** — appended the `Pages (spec §6)` section after the Leaf diff section: `export const LOGIN_PAGE: string` (password form page) and `export const CHAT_PAGE: string` (live session viewer page with `EventSource('/events')`). To guarantee verbatim fidelity, the section was extracted programmatically from the brief's own Step 3 code block (10,943 chars) rather than hand-typed. It appends directly after the `diffLeaf` closing brace (original file had no trailing newline; one `\n` separator added, which is all the brief's block specifies).

## TDD Evidence

### RED

Command: `node selftest.ts` (after Step 1, before implementation)

Output:

```
(node:2252254) ExperimentalWarning: Type Stripping is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
file:///home/jc1da/Programs/LanyTek/remote_pi_ext/selftest.ts:2
import { hashPassword, verifyPassword, issueToken, cookieHeader, clearCookieHeader, tokenFromCookie, sanitizeEntry, diffLeaf,              LOGIN_PAGE, CHAT_PAGE } from "./index.ts";
                                                                                                                                                       ^^^^^^^^^
SyntaxError: The requested module './index.ts' does not provide an export named 'CHAT_PAGE'
    at ModuleJob._instantiate (node:internal/modules/esm/module_job:182:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:266:5)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/esm/loader:644:26)
exit=1
```

Why expected: the brief's Step 2 says "Expected: `LOGIN_PAGE is not exported`/undefined failure (red)". Node ESM enforces named exports at module-link time, so the missing export surfaces as a link-time `SyntaxError` — exactly the anticipated red. (Consequence of ESM linking: the 21 pre-existing checks do not execute in the red state; they are all verified green in Step 4. The brief's expected failure mode is unambiguous here.)

### GREEN

Command: `node selftest.ts && npx tsc -p tsconfig.json` (after Step 3)

Selftest output (Node's Type-Stripping stderr warning appears before the checks):

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

26 passed, 0 failed
```

tsc: silent, exit 0. Selftest exit 0. All 21 pre-existing checks pass; all 5 new page checks pass.

## Files changed

- `index.ts` — appended Pages section (lines 130–392): `LOGIN_PAGE`, `CHAT_PAGE` template literals + section header comment. No other changes (verified by append-only edit; original 128-line content untouched).
- `selftest.ts` — import line extended with `LOGIN_PAGE, CHAT_PAGE`; pages test block (5 checks) appended before the summary lines. File grew 63 → 87 lines.

## Self-review findings

- **Implemented exactly what the brief specifies, nothing more.** Both added blocks match the brief's code verbatim (selftest block verified byte-for-byte programmatically; index.ts block extracted from the brief file itself, so transcription risk is zero).
- **New tests verify real behavior:** page content checks (login has `type="password"` input and posts to `'/login'`; chat uses `new EventSource('/events')`), inline script syntax validity via `new Function` (the embedded JS is plain ES2017, so this genuinely parses each page's single `<script>` body), and the no-template-literal-leakage check (no backticks, no `${` in either page value).
- **Test output pristine** apart from Node v23.11.1's environmental Type-Stripping `ExperimentalWarning` on stderr, which is expected and explicitly anticipated by the task.
- Global constraints hold: zero runtime npm deps (pages are plain strings), erasable TS (only type annotations/imports, all strippable; `new Function` in the test is runtime JS, not TS syntax).

## Issues or concerns

- **Red-state granularity (informational, matches brief):** because ESM checks named exports at link time, the red state is a hard `SyntaxError` before any check runs — the 21 pre-existing checks therefore do not execute in red. The brief explicitly predicted this failure mode ("`LOGIN_PAGE is not exported`"), and all 21 checks pass in green. No action needed.
- **No `description.md` exists in this project** (checked root and `docs/`), so the "keep description.md updated" standing rule has no target here; per the brief's contract I did not create one.
- No other deviations from the brief.