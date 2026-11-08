> Adopted from `/home/miftah/.worktrees/mcp-notes/neon-egress-reduction/.workflows/orchestration/neon-egress-reduction/PLAN.md` phase 2. Source: `.workflows/plan/neon-egress-reduction/phase-2.md`.
> Written and reconciled by /analyze — edit the source, not this copy.
# Phase 2 — "Changed since" checks: serve unchanged notes and graph polls without re-reading rows

**Satisfies:** R2 · **Depends on:** — · **Package:** `src/notes`, `src/sessions`, `src/http` · **Difficulty:** HARD
**Does not touch:** `web/` (phase 1; the browser's HTTP cache sends `If-None-Match` for `fetch('/api/notes…')` by itself once an `ETag` + `Cache-Control: no-cache` is served), `src/sessions/repo.ts` write paths except the audit below, drizzle schema/migrations (no migration in this set).

## Goal
Today `GET /api/notes?limit=2000` runs three queries returning every note on each call, and `GET /api/projects/:repo/sessions` reads up to 2001 node rows plus `count(*)` before it computes the ETag (`src/http/sessionsApi.ts:159-171`). After this phase an unchanged poll costs one fingerprint query (~100-200 bytes) for each endpoint.

## Part A — notes fingerprint

New file `src/notes/fingerprint.ts`:
```ts
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Db } from '../db/client.js';

type FpRow = Record<string, string | number | Date | null>;

/**
 * Cheap summary of everything `GET /api/notes` and `/api/tags` can show: note rows (body, tags,
 * origin and deletion all move `updated_at` / `deleted_at`), and the image and file rows joined
 * onto each note. Aggregates only: the answer is a few dozen bytes however many notes exist.
 */
export async function notesFingerprint(db: Db): Promise<string> {
  const res = await db.execute<FpRow>(sql`
    select
      (select count(*)::int from notes) as n,
      (select count(*)::int from notes where deleted_at is null) as live,
      (select max(updated_at) from notes) as nu,
      (select max(deleted_at) from notes) as nd,
      (select count(*)::int from note_images) as ni,
      (select count(*)::int from note_images where deleted_at is null) as nil,
      (select max(greatest(created_at, coalesce(deleted_at, created_at))) from note_images) as nit,
      (select count(*)::int from note_files) as nf,
      (select count(*)::int from note_files where deleted_at is null) as nfl,
      (select max(greatest(created_at, coalesce(deleted_at, created_at))) from note_files) as nft`);
  return createHash('sha1').update(JSON.stringify(res.rows[0] ?? {})).digest('hex').slice(0, 20);
}

/** Weak ETag for one list request: the data fingerprint plus the request's own shape. */
export function listEtag(fingerprint: string, requestShape: string): string {
  const shape = createHash('sha1').update(requestShape).digest('hex').slice(0, 8);
  return `W/"n-${fingerprint}-${shape}"`;
}
```
Verify before relying on it: every writer in `src/notes/service.ts` that changes a note's visible content bumps `notes.updated_at` (body/origin) or touches the image/file rows covered above (attach, remove, position, restore). If a path exists that changes a listed field without either (grep `update(notes)` and `update(noteImages)`), add the missing column to the fingerprint instead of changing the writer.

### `src/http/api.ts`
In `api.get('/api/notes', …)`, after parsing the query and before `service.list`:
```ts
const etag = listEtag(await notesFingerprint(deps.db), c.req.url.split('?')[1] ?? '');
c.header('ETag', etag);
c.header('Cache-Control', 'no-cache');
if (c.req.header('if-none-match') === etag) return c.body(null, 304);
```
Same for `api.get('/api/tags', …)` with `requestShape = 'tags'`. Do not add it to `/api/notes/:id`, search, or the MCP tools (per-call, not polled). The fingerprint query's failure must not break the endpoint: wrap in try/catch and fall through to the unconditional path on error (no ETag header then).

## Part B — graph cache keyed by fingerprint

New file `src/sessions/graphCache.ts`:
```ts
export interface GraphDbSnapshot<R> {
  fingerprint: string;
  at: number;
  rows: R[];
  more: boolean;
  total: number;
}

/** Max age of a cached snapshot even when the fingerprint is unchanged (cross-repo parent/child_count moves no row of this repo). */
export const GRAPH_CACHE_MAX_AGE_MS = 5 * 60_000;
const MAX_ENTRIES = 16;

export class GraphCache<R> {
  private readonly map = new Map<string, GraphDbSnapshot<R>>();
  get(key: string, fingerprint: string, now: number): GraphDbSnapshot<R> | null {
    const hit = this.map.get(key);
    if (!hit || hit.fingerprint !== fingerprint || now - hit.at > GRAPH_CACHE_MAX_AGE_MS) return null;
    this.map.delete(key); this.map.set(key, hit); // LRU touch
    return hit;
  }
  set(key: string, snap: GraphDbSnapshot<R>): void {
    this.map.delete(key);
    this.map.set(key, snap);
    while (this.map.size > MAX_ENTRIES) this.map.delete(this.map.keys().next().value as string);
  }
}
```

### `src/sessions/readModel.ts`
Add next to `repoExists`:
```ts
/** Aggregates only. Any ingest, hook, summary, link or title write moves one of these. */
export async function repoFingerprint(rd: SessionsReadDeps, repo: string): Promise<string> {
  const res = await rd.db.execute<Record<string, unknown>>(sql`
    select count(*)::int as n,
           max(updated_at) as u,
           max(last_active_at) as a,
           max(summarized_at) as s,
           count(*) filter (where parent_session_id is not null)::int as p
    from cc_sessions where repo = ${repo}`);
  return JSON.stringify(res.rows[0] ?? {});
}
```
In `graphForRepo`, keep the signature and result shape. Before the two queries:
```ts
const cacheKey = `${repo}|${q.before ?? ''}|${q.limit}`;
const fp = await repoFingerprint(rd, repo);
const hit = graphCache.get(cacheKey, fp, Date.now());
```
If `hit`, skip both `rd.db.execute` calls and build the payload from `hit.rows`/`hit.more`/`hit.total` with the **fresh** `ctx = await nodeContext(rd)` (live registry is a local file read, not DB) via the same `toGraphNode`. Otherwise run the queries as today, then `graphCache.set(cacheKey, { fingerprint: fp, at: Date.now(), rows: rows.rows, more, total })`. `graphCache` is a module-level `new GraphCache<NodeRow>()`; export `resetGraphCache()` for tests. `generated_at` stays per call; `graphEtag` already ignores it, so the route keeps answering 304 for an unchanged graph. Rows are not mutated by `toGraphNode` (verify; if it mutates, clone with `structuredClone`).

Audit (required, small): grep `update(ccSessions)` and raw `update cc_sessions` in `src/sessions/repo.ts`, `links.ts`, and anywhere else; every set that changes a graph-visible column (title, name, repo, parent link, summary, tokens, tmux, branch) must either set `updatedAt` or move a column in `repoFingerprint`. Add `updatedAt: this.now()` where missing and cover each with an assertion in the test below.

## Tests
- `tests/unit/notes.fingerprint.test.ts`: `listEtag` stable for equal inputs, differs on request shape and on fingerprint.
- `tests/unit/sessions.graphCache.test.ts`: hit on same fingerprint, miss on changed fingerprint, miss after `GRAPH_CACHE_MAX_AGE_MS`, LRU eviction at 16.
- `tests/integration/egress.fingerprint.int.test.ts` (pgvector Postgres via `npm run test:int`): create notes, `GET /api/notes` → 200 with ETag; repeat with `If-None-Match` → 304 and a query counter (wrap `db.$client.query`) shows only the fingerprint query ran; update a note body → 200; attach and remove an image → fingerprint moves; soft-delete and restore → fingerprint moves. Graph: ingest a session → `GET /api/projects/:repo/sessions` twice, second call issues no `from cc_sessions s left join` query (assert via the query counter); append to the transcript (or call `SessionsRepo.setSummary`) → next call re-reads.
- Existing `sessionsApi` tests that count queries or assume a fresh read each call: call `resetGraphCache()` in `beforeEach`.

## Verification
```sh
npm run typecheck
npm test
npm run test:int
```
verify-notesd: drive `GET /api/notes` twice with `If-None-Match` and confirm 304 + body-less second response; graph endpoint likewise.

## Exit criteria
`/api/notes`, `/api/tags` and `/api/projects/:repo/sessions` answer an unchanged poll with a fingerprint query only; any write to a note, its image/file rows, or a session row of the repo invalidates; no behaviour change in payloads; all suites green.
