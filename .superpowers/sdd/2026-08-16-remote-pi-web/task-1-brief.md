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

