### Task 3: Entry sanitizer + leaf diff

**Files:**
- Modify: `index.ts` (append sanitizer + diffLeaf sections)
- Modify: `selftest.ts` (extend import; append test block)

**Interfaces:**
- Produces: `sanitizeEntry(e: AnyRec): AnyRec | null` — keeps only whitelisted fields per entry type (drops `parentId` and unknown types); `message` payload kept intact.
- Produces: `type LeafDiff = { kind: "none" } | { kind: "append"; entries: AnyRec[] } | { kind: "resync" }`.
- Produces: `diffLeaf(byId: Map<string, AnyRec>, lastLeaf: string | null, newLeaf: string | null): LeafDiff` — compares each SSE client's last-seen leaf with the session's current leaf.

Sanitizer whitelist (spec §5):
- `message`: `type, id, timestamp, message`
- `compaction`: `type, id, timestamp, summary, tokensBefore`
- `branch_summary`: `type, id, timestamp, fromId, summary`
- `model_change`: `type, id, timestamp, provider, modelId`
- `thinking_level_change`: `type, id, timestamp, thinkingLevel`
- `session_info`: `type, id, timestamp, name`
- `custom_message`: `type, id, timestamp, customType, content, display`
- `custom`: `type, id, timestamp, customType, data`
- `label`: `type, id, timestamp, targetId, label`
- anything else: dropped (`null`)

- [ ] **Step 1: Write the failing tests** — in `selftest.ts`, extend the import:

```typescript
import { hashPassword, verifyPassword, issueToken, cookieHeader, clearCookieHeader, tokenFromCookie, sanitizeEntry, diffLeaf } from "./index.ts";
```

Append this block before the final `console.log`:

```typescript
// ---------- entry sanitizer + leaf diff ----------
{
  const msg = sanitizeEntry({ type: "message", id: "a", parentId: "p", timestamp: "t",
    message: { role: "user", content: "hi" }, secret: 1 });
  check("sanitize: message keeps whitelisted fields only",
    JSON.stringify(msg) === JSON.stringify({ type: "message", id: "a", timestamp: "t",
      message: { role: "user", content: "hi" } }));
  check("sanitize: unknown type dropped", sanitizeEntry({ type: "???", id: "a" }) === null);

  const tree: Record<string, unknown>[] = [
    { type: "message", id: "a", parentId: null, timestamp: "1", message: { role: "user", content: "m1" } },
    { type: "message", id: "b", parentId: "a", timestamp: "2", message: { role: "assistant", content: [{ type: "text", text: "r1" }] } },
    { type: "message", id: "c", parentId: "b", timestamp: "3", message: { role: "user", content: "m2" } },
    { type: "message", id: "d", parentId: "c", timestamp: "4", message: { role: "assistant", content: [{ type: "text", text: "r2" }] } },
    { type: "model_change", id: "e", parentId: "a", timestamp: "5", provider: "p", modelId: "m2" },
  ];
  const byId = new Map(tree.map((e) => [e.id as string, e]));
  check("diffLeaf: same leaf -> none", diffLeaf(byId, "d", "d").kind === "none");
  const app = diffLeaf(byId, "a", "d");
  check("diffLeaf: descendant -> append [b,c,d] oldest-first",
    app.kind === "append" && (app as { entries: AnyRec[] }).entries.map((x) => x.id).join(",") === "b,c,d");
  check("diffLeaf: non-descendant -> resync", diffLeaf(byId, "d", "e").kind === "resync");
  check("diffLeaf: unknown new leaf -> resync", diffLeaf(byId, "a", "zz").kind === "resync");
  check("diffLeaf: null last leaf -> resync", diffLeaf(byId, null, "d").kind === "resync");
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `node selftest.ts`
Expected: `sanitizeEntry is not a function`-style failure (red).

- [ ] **Step 3: Implement** — in `index.ts`, add after the tokens section:

```typescript
// ---------------------------------------------------------------------------
// Entry sanitizer (spec §5: strip everything except what the web view needs)
// ---------------------------------------------------------------------------

const ENTRY_FIELDS: Record<string, string[]> = {
  message: ["type", "id", "timestamp", "message"],
  compaction: ["type", "id", "timestamp", "summary", "tokensBefore"],
  branch_summary: ["type", "id", "timestamp", "fromId", "summary"],
  model_change: ["type", "id", "timestamp", "provider", "modelId"],
  thinking_level_change: ["type", "id", "timestamp", "thinkingLevel"],
  session_info: ["type", "id", "timestamp", "name"],
  custom_message: ["type", "id", "timestamp", "customType", "content", "display"],
  custom: ["type", "id", "timestamp", "customType", "data"],
  label: ["type", "id", "timestamp", "targetId", "label"],
};

/** Whitelist one entry's fields. `parentId` is never sent; unknown types -> null. */
export function sanitizeEntry(e: AnyRec): AnyRec | null {
  const fields = ENTRY_FIELDS[e.type as string];
  if (!fields) return null;
  const out: AnyRec = {};
  for (const f of fields) {
    if (e[f] !== undefined) out[f] = e[f];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Leaf diff (spec §5 streaming protocol: append vs resync per client)
// ---------------------------------------------------------------------------

export type LeafDiff =
  | { kind: "none" }
  | { kind: "append"; entries: AnyRec[] } // raw entries, oldest-first, excludes lastLeaf
  | { kind: "resync" };                   // caller sends a full snapshot

/**
 * Decide what one SSE client needs when the session leaf moved from
 * `lastLeaf` to `newLeaf`. Walks parentId links from newLeaf back to lastLeaf;
 * any break in the chain (tree nav, resume, compaction re-root, unknown id)
 * means the client must resync. A 100k-step guard defeats pathological cycles.
 */
export function diffLeaf(
  byId: Map<string, AnyRec>,
  lastLeaf: string | null,
  newLeaf: string | null,
): LeafDiff {
  if (!newLeaf || newLeaf === lastLeaf) return { kind: "none" };
  if (!lastLeaf) return { kind: "resync" };
  const path: AnyRec[] = [];
  let cur: string | null = newLeaf;
  let guard = 0;
  while (cur !== lastLeaf) {
    const e = byId.get(cur);
    if (!e) return { kind: "resync" };
    path.push(e);
    cur = (e.parentId as string | null) ?? null;
    if (cur === null) return { kind: "resync" };
    if (++guard > 100000) return { kind: "resync" };
  }
  path.reverse();
  return { kind: "append", entries: path };
}
```

Note: `diffLeaf` returns RAW entries; the server sanitizes them when writing the SSE payload (see Task 6).

- [ ] **Step 4: Run to verify it passes**

Run: `node selftest.ts && npx tsc -p tsconfig.json`
Expected: all `ok`, `0 failed`, tsc silent.

---

