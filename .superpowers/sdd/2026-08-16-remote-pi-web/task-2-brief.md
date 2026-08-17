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

