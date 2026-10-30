> Adopted from `docs/plans/NOTES_SPINE_IMAGES_UI_PLAN.md` phase 2. Source: `.workflows/plan/notes-spine-images-ui/phase-2.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 2: Notes service, MCP server and tools, notesd daemon

**Plan set:** `NOTES_SPINE_IMAGES_UI_PLAN.md`
**Analysis:** `docs/analyzer/20261030-092006-K7N3_code_analyzer.md`
**Satisfies:** R1 (the daemon, the MCP note tools and their tests); R3 (only the repo-level `hasImage` list/search option the 3-way visibility needs: owner commit `30a58fd`, assigned to P2 by the index Decisions so P6 can serve `has_image` without waiting on P5). It is **not** exposed in MCP schemas here.
**Depends on:** Phase 1
**Difficulty:** HARD
**Package:** `src/notes`, `src/mcp`, `src/http`, `src/` (daemon entry)

---

## Goal

After this phase `node dist/main.js` is a working `notesd`: it creates the data dirs, connects to
Postgres, binds `127.0.0.1` only, serves `GET /health` and a stateless MCP streamable-HTTP endpoint
at `POST /mcp` with the eleven note tools and server instructions written for Claude. All note
writes go through one `NotesService` that writes revisions in the same transaction as every body
change and emits on an in-process event bus. The empty routers and no-op hooks that phases 4, 5 and
6 fill (`api.ts`, `images.ts`, `static.ts`, `imageTools.ts`, `background.ts`) exist and are
already mounted/called in their final order, so those phases never edit `app.ts`, `server.ts`,
`daemon.ts` or `main.ts`.

## Verification of the SDK API (done while planning)

Everything below was typechecked (`tsc --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes`)
and run (unit + integration, 48 tests green) in a scratch project against a throwaway `postgres:16`,
with the latest versions on 2026-10-30: `@modelcontextprotocol/sdk@1.32.2`, `hono@4.13.14`,
`@hono/node-server@2.1.5`, `drizzle-orm@0.45.4`, `zod@4.6.7`, `pg@8.23.1`, `vitest@5.0.5`,
`typescript@5.9.3`. Facts the code relies on:

- `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js` exports
  `WebStandardStreamableHTTPServerTransport` with `handleRequest(req: Request): Promise<Response>`:
  Hono hands it `c.req.raw` directly; no Node `req/res` shim. Leaving `sessionIdGenerator` out means
  stateless mode (passing `sessionIdGenerator: undefined` fails under `exactOptionalPropertyTypes`).
  `enableJsonResponse: true` returns plain JSON, so the server can be closed right after.
- `McpServer#registerTool(name, { title, description, inputSchema: <zod raw shape>, annotations }, cb)`.
  zod 4 shapes are accepted (`peerDependencies.zod: ^3.25 || ^4.0`). Input validation failures and
  thrown errors come back as `isError: true` results, not protocol errors.
- `new McpServer(info, { instructions })` → `client.getInstructions()` returns it.
- `StreamableHTTPClientTransport(url, { fetch })` accepts a custom `FetchLike`
  (`(url, init) => Promise<Response>`), so tests drive the **real** `/mcp` route in-process with
  `fetch: async (u, i) => app.request(String(u), i)`. The client's follow-up `GET /mcp` gets 405 and
  the client tolerates it.
- `@hono/node-server@2`: `serve({ fetch, hostname, port }) → http.Server`.
- The transport's own `allowedHosts`/`enableDnsRebindingProtection` options are **deprecated**
  ("use external middleware"), hence the `loopbackOnly` Hono middleware below.

**Pinned versions win (reconciler).** Phase 1 owns dependencies (invariant 8) and pins
`drizzle-orm@0.45.2`, `zod@4.4.3`, `vitest@4.1.2` (the rest as above). The code in this plan uses
only APIs present in those pins: zod `z.string/number/boolean/array` with `.min/.int/.positive/
.optional/.describe` (all zod 4.0), drizzle `sql`/`and`/`or`/`eq`/`transaction`/`$inferSelect`
(0.45.x), vitest `describe/it/expect/beforeAll/afterAll/beforeEach/afterEach` with no config of
its own (phase 1's `vitest.config.ts` is the only config). Nothing here needs zod 4.6, drizzle
0.45.4 or vitest 5. The implementer re-runs `npm run typecheck` and the int tests against the
pins; nothing else changes. Phase 1's `tsconfig.json` does not set `exactOptionalPropertyTypes`;
the code passes with or without it, so do not add it.

## Phase 1 exports this plan imports (reconciled against the phase-1 plan)

| Phase-1 export | Exact shape |
|---|---|
| `src/config.ts` | `interface Config { databaseUrl: string; port: number; host: '127.0.0.1'; dataDir: string }`, `loadConfig(options?: { env?; envFile? }): Config` (refuses a non-loopback host; `dataDir` absolute; never creates it) |
| `src/db/client.ts` | `type Db = NodePgDatabase<typeof schema> & { $client: pg.Pool }` (has `.transaction`, `.select`, `.insert`, `.update`, `.execute`), `createDb(url: string): Db`, `closeDb(db: Db): Promise<void>` |
| `src/db/schema.ts` | `notes` (`id, body, tags, imagePath, imageMeta, origin, createdAt, updatedAt, deletedAt`), `noteRevisions` (`id` bigserial number, `noteId, body, savedAt`), `type ImageMeta`, `type NoteOrigin`, `NoteRow`; all indexes incl. `notes_image_sha256_live_uniq` |
| `src/notes/ids.ts` | `generateId(random?): string`, `normalizeId(input: string): string \| null`, `parseId`, `InvalidIdError` |
| `src/notes/tags.ts` | `parseTags(body): string[]`, `normalizeTag(input): string \| null`, `tagSpans` |
| `tests/integration/setup.ts` | `testDatabaseUrl(): string`, `openTestDb(): Db`, `closeTestDb(db): Promise<void>`, `migrateTestDb()`, `truncateAll(db)` |
| `vitest.config.ts` | unit: `tests/unit/**/*.test.ts` + `web/src/**/*.test.tsx`; int (`VITEST_INTEGRATION=1`): `tests/integration/**/*.int.test.ts`, `globalSetup` migrates, **`fileParallelism: false`** (confirmed in phase 1 Step 5) |
| `package.json` deps | all present; Phase 2 adds none (invariant 8) |

## Interface Contract

**Deletes:** none (greenfield).
**Renames:** none.

**Creates:**

- `src/notes/types.ts`: `Origin`, `ImageMeta`, `NoteImage`, `Note` (wire shape, exactly the index's), `NoteRow` (= `typeof notes.$inferSelect`), `Revision`, `TagCount`, `NotePage`, `NoteErrorCode`, `class NoteError { code }`, `cleanOrigin(value)`, `imageAvailable(dataDir, imagePath)`, `rowToNote(row, dataDir)`.
- `src/notes/dates.ts`: `parseDateBound(value, 'from' | 'to'): Date` (phase 5 reuses it for `taken_from`/`taken_to`).
- `src/notes/events.ts`: `NoteOp`, `NoteEvent = { type: 'note'; op; id }`, `NoteEventListener`, `class NoteEvents { emit(op, id); on(listener): () => void; listenerCount() }`.
- `src/notes/repo.ts`: `Tx`, `Executor`, `DEFAULT_LIMIT` (50), `MAX_LIMIT` (5000), `interface NoteFilter`, `RowPage`, `TagRow`, `RevisionRow`, `InsertNote`, `normalizeTagInput`, `encodeCursor`, `decodeCursor`, `clampLimit`, `filterConditions(filter): SQL[]`, `listNotes`, `searchNotes`, `findNotesByIds`, `findNoteById`, `lockNote`, `findNoteBySha256`, `insertNote`, `idExists`, `setBody`, `setOrigin`, `setDeleted`, `insertRevision`, `listRevisions`, `getRevision`, `listTags`.
- `src/notes/service.ts`: `class NotesService`, `NotesServiceDeps`, `CreateNoteInput`, `UpdateOptions`, `GetOptions`, `GetResult`, `MAX_ID_ATTEMPTS`.
- `src/mcp/instructions.ts`: `localTimeZone()`, `buildInstructions(timeZone?)`.
- `src/mcp/tools.ts`: `ToolDeps { service; dataDir; db }` (`db` added by the reconciler: phase 5's image tools read image records through it), `MCP_MAX_LIMIT` (200), `MCP_DEFAULT_LIMIT` (50), `noteFilterShape`, `FilterArgs`, `toFilter(args)`, `jsonResult`, `errorResult`, `run`, `registerNoteTools(server, deps)`.
- `src/mcp/imageTools.ts`: `registerImageTools(server: McpServer, deps: ToolDeps): void` (no-op).
- `src/mcp/server.ts`: `SERVER_NAME`, `SERVER_VERSION`, `createMcpServer(deps)`, `handleMcpRequest(req, deps): Promise<Response>`.
- `src/deps.ts`: `interface AppDeps { config: Config; db: Db; events: NoteEvents; service: NotesService }`.
- `src/http/app.ts`: `loopbackOnly` middleware, `createApp(deps: AppDeps): Hono`.
- `src/http/api.ts`: `apiRoutes(deps: AppDeps): Hono` (empty router).
- `src/http/images.ts`: `imageRoutes(deps: AppDeps): Hono` (empty router).
- `src/http/static.ts`: `staticRoutes(deps: AppDeps): Hono` (empty router).
- `src/background.ts`: `type StopBackground = () => Promise<void>`, `startBackground(deps: AppDeps): Promise<StopBackground>` (no-op).
- `src/daemon.ts`: `DATA_SUBDIRS`, `RunningDaemon { deps; port; stop }`, `ensureDataDirs(dataDir)`, `startDaemon(config): Promise<RunningDaemon>`.
- `src/main.ts`: process entry (no exports).
- MCP tools: `create, get, update, append, delete, restore, list, search, tags, revisions, revert`.

**Notes service API (binding for phases 4, 5, 6: they call it and never edit it):**

```ts
class NotesService {
  constructor(deps: { db: Db; dataDir: string; events: NoteEvents });
  requireId(input: string): string;                         // canonical id or NoteError('invalid_id')
  newId(): Promise<string>;                                 // an id no note (live or deleted) has: P4 names the file with it
  create(input: {
    body: string;
    origin?: Origin | null;
    image?: { path: string; meta: ImageMeta } | null;       // P4: path relative to dataDir
    allowEmpty?: boolean;                                   // P4 image notes, P6 "+" (MCP never sets it)
    id?: string;                                            // P4: from newId(); taken -> NoteError('conflict')
  }): Promise<Note>;                                        // emits 'created'; live sha256 clash -> NoteError('duplicate_image')
  getOne(id: string, opts?: { includeDeleted?: boolean }): Promise<Note | null>;
  get(ids: readonly string[], opts?: { includeDeleted?: boolean }): Promise<{ notes: Note[]; missing: string[]; deleted: string[] }>;
  findBySha256(sha256: string, opts?: { includeDeleted?: boolean }): Promise<Note | null>; // live first, then newest deleted
  list(filter?: NoteFilter): Promise<NotePage>;             // { notes, next_cursor }
  search(query: string, filter?: NoteFilter): Promise<NotePage>;
  tags(): Promise<TagCount[]>;                              // [{ tag, count, last_used }]
  revisions(id: string): Promise<Revision[]>;               // newest first
  update(id: string, body: string, opts?: { origin?: Origin | null; allowEmpty?: boolean }): Promise<Note>; // P6 PATCH may pass allowEmpty
  append(id: string, text: string, opts?: { origin?: Origin | null }): Promise<Note>;
  delete(id: string): Promise<Note>;                        // soft; idempotent; emits 'deleted'
  restore(id: string): Promise<Note>;                       // idempotent; emits 'restored'
  revert(id: string, revision: number): Promise<Note>;
}

interface NoteFilter {
  tagsAny?: string[]; tagsAll?: string[];
  dateField?: 'created' | 'updated'; from?: string; to?: string;
  hasImage?: boolean;                 // true = image_path is not null, false = image_path is null, undefined = all
  deleted?: 'exclude' | 'include' | 'only';
  limit?: number;                     // 1..5000, default 50 (P6 passes 2000)
  cursor?: string;                    // opaque, from next_cursor
}
```

`NoteError.code` values for HTTP mapping (phase 6/5): `invalid_id`, `invalid_input` → 400;
`not_found` → 404; `deleted`, `conflict`, `duplicate_image` → 409; `empty_body`,
`invalid_revision` → 400/422 (phase 6 chooses).

Events: exactly one `{ type: 'note', op, id }` per mutation that changed something, emitted after
commit. No-op calls (unchanged update, delete of a deleted note, restore of a live note, revert to
the current body) emit nothing.

**Signature changes:** none (greenfield).

**Requires (from earlier phases):** Phase 1's `loadConfig`/`Config`, `createDb`/`Db`, `notes`/`noteRevisions`, `generateId`/`normalizeId`, `parseTags`, the migrated test DB and `TEST_DATABASE_URL` from `npm run test:int`, with int files run serially (see "Phase 1 exports" above), and `openTestDb`/`closeTestDb`/`testDatabaseUrl`/`truncateAll` from `tests/integration/setup.ts`.

**Leaves alone (owned by others):** `package.json`, `package-lock.json`, `tsconfig*.json`, `vitest.config.ts`, `drizzle.config.ts`, `drizzle/**`, `src/config.ts`, `src/db/**`, `src/notes/{ids,tags}.ts`, `tests/integration/setup.ts`, `scripts/test-int.sh` (Phase 1); `claude/`, `deploy/`, `scripts/install.sh`, `scripts/windows/`, `docs/INSTALL.md` (Phase 3); `src/images/**` and the body of `startBackground` (Phase 4); the bodies of `imageRoutes`/`registerImageTools`, `takenFrom`/`takenTo` in `NoteFilter`, MCP `has_image`/`taken_*` fields (Phase 5); the bodies of `apiRoutes`/`staticRoutes`, `src/chat/**` (Phase 6); `web/**` (Phases 7, 8).

## Files

| File | Action | What changes |
|---|---|---|
| `src/notes/types.ts` | create | wire `Note`, `ImageMeta`, `Origin`, `NoteError`, row → wire mapping with `image.available` |
| `src/notes/dates.ts` | create | `parseDateBound` (local-day / ISO bounds) |
| `src/notes/events.ts` | create | typed in-process `NoteEvents` bus |
| `src/notes/repo.ts` | create | all SQL: filters (incl. `hasImage`), list, search, tags, revisions, locks, inserts |
| `src/notes/service.ts` | create | `NotesService`: the only writer; transactions; events |
| `src/mcp/instructions.ts` | create | server instructions for Claude |
| `src/mcp/tools.ts` | create | the 11 tools, shared filter shape, result helpers |
| `src/mcp/imageTools.ts` | create | no-op `registerImageTools` (P5 fills) |
| `src/mcp/server.ts` | create | per-request stateless `McpServer` + web-standard transport |
| `src/deps.ts` | create | `AppDeps` shared by routes and background jobs |
| `src/http/app.ts` | create | `/health`, guarded `/mcp`, then api → images → static |
| `src/http/api.ts` | create | empty router factory (P6 fills) |
| `src/http/images.ts` | create | empty router factory (P5 fills) |
| `src/http/static.ts` | create | empty router factory (P6 fills) |
| `src/background.ts` | create | no-op `startBackground` (P4 fills) |
| `src/daemon.ts` | create | `startDaemon(config)`: data dirs → db → service → app → listen → background; `stop()` |
| `src/main.ts` | create | entry: `loadConfig` → `startDaemon`; SIGINT/SIGTERM graceful shutdown |
| `tests/unit/notes.helpers.test.ts` | create | dates, cursor, limit, tag input, origin, `rowToNote`, `imageAvailable`, events |
| `tests/unit/mcp.instructions.test.ts` | create | instructions content, `toFilter`, `loopbackOnly` |
| `tests/integration/notes.service.int.test.ts` | create | service against real Postgres |
| `tests/integration/mcp.tools.int.test.ts` | create | SDK client over the real `/mcp` route (in-process) |
| `tests/integration/daemon.int.test.ts` | create | `startDaemon` on port 0: dirs, `/health`, raw MCP `initialize` over TCP |

All files are new, so every "line reference" below is `:1` (whole file).

## Implementation Steps

### Step 1: Wire types and errors
**File:** `src/notes/types.ts:1`
**Change:** create. `NoteRow` is derived from phase 1's table so the mapping can't drift from the
schema. `image` is computed here, so P5/P6 never change the shape. `imageAvailable` refuses paths
that escape `dataDir`. `Origin` fields are `?: string | undefined` so spreads of zod output type-check
under `exactOptionalPropertyTypes`.
**Code:**
```ts
import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { notes } from '../db/schema.js';

/** Where a note was saved from. Every field is optional; unknown keys are dropped. */
export interface Origin {
  cwd?: string | undefined;
  repo?: string | undefined;
  claude_session?: string | undefined;
  /** Free-form channel, e.g. 'mcp', 'web', 'inbox', 'upload'. */
  source?: string | undefined;
}

/** Stored in notes.image_meta. Written by the image ingest (phase 4). Owned by phase 1's schema. */
export type { ImageMeta } from '../db/schema.js';
import type { ImageMeta } from '../db/schema.js';

/** The `image` field of the wire Note. */
export interface NoteImage {
  mime: string;
  width: number;
  height: number;
  bytes: number;
  taken_at: string | null;
  original_name: string | null;
  host: string | null;
  /** The original file exists under this machine's data dir. */
  available: boolean;
}

/** Wire shape shared by MCP, HTTP and the UI. */
export interface Note {
  id: string;
  body: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  deleted_at?: string;
  origin: Origin | null;
  image: NoteImage | null;
}

export type NoteRow = typeof notes.$inferSelect;

export interface Revision {
  revision: number;
  note_id: string;
  body: string;
  saved_at: string;
}

export interface TagCount {
  tag: string;
  count: number;
  last_used: string;
}

export interface NotePage {
  notes: Note[];
  next_cursor: string | null;
}

export type NoteErrorCode =
  | 'invalid_id'
  | 'invalid_input'
  | 'not_found'
  | 'deleted'
  | 'empty_body'
  | 'conflict'
  | 'duplicate_image'
  | 'invalid_revision';

/** The only error type the notes service throws on purpose. HTTP maps `code` to a status. */
export class NoteError extends Error {
  readonly code: NoteErrorCode;

  constructor(code: NoteErrorCode, message: string) {
    super(message);
    this.name = 'NoteError';
    this.code = code;
  }
}

const ORIGIN_KEYS = ['cwd', 'repo', 'claude_session', 'source'] as const;

/** Keeps only the known string fields of an origin; returns null when nothing is left. */
export function cleanOrigin(value: unknown): Origin | null {
  if (value === null || typeof value !== 'object') return null;
  const src = value as Record<string, unknown>;
  const out: Origin = {};
  for (const key of ORIGIN_KEYS) {
    const v = src[key];
    if (typeof v === 'string' && v.trim() !== '') out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** True when `imagePath` (relative to dataDir) names an existing file inside dataDir. */
export function imageAvailable(dataDir: string, imagePath: string): boolean {
  const root = resolve(dataDir);
  const full = resolve(root, imagePath);
  const rel = relative(root, full);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
  return existsSync(full);
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toImage(row: NoteRow, dataDir: string): NoteImage | null {
  if (row.imagePath === null || row.imageMeta === null || typeof row.imageMeta !== 'object') return null;
  const meta = row.imageMeta as Partial<ImageMeta>;
  return {
    mime: typeof meta.mime === 'string' ? meta.mime : 'application/octet-stream',
    width: typeof meta.width === 'number' ? meta.width : 0,
    height: typeof meta.height === 'number' ? meta.height : 0,
    bytes: typeof meta.bytes === 'number' ? meta.bytes : 0,
    taken_at: typeof meta.taken_at === 'string' ? meta.taken_at : null,
    original_name: typeof meta.original_name === 'string' ? meta.original_name : null,
    host: typeof meta.host === 'string' ? meta.host : null,
    available: imageAvailable(dataDir, row.imagePath),
  };
}

/** DB row -> wire Note. `deleted_at` is present only on deleted notes. */
export function rowToNote(row: NoteRow, dataDir: string): Note {
  const note: Note = {
    id: row.id,
    body: row.body,
    tags: row.tags,
    created_at: toIso(row.createdAt),
    updated_at: toIso(row.updatedAt),
    origin: cleanOrigin(row.origin),
    image: toImage(row, dataDir),
  };
  if (row.deletedAt !== null) note.deleted_at = toIso(row.deletedAt);
  return note;
}
```
**Impact:** none outside this phase.

### Step 2: Date bounds
**File:** `src/notes/dates.ts:1`
**Change:** create. One rule for every date filter: compare `col >= from` and `col < to`.
`YYYY-MM-DD` is a local day (the daemon's TZ; WIB on this machine), datetimes are exact and the
`to` bound is made inclusive with +1 ms.
**Code:**
```ts
import { NoteError } from './types.js';

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Turns a user-supplied date filter into an instant.
 *
 * - `YYYY-MM-DD` is a whole day in the process's local timezone: a `from` bound is that day's
 *   local midnight, a `to` bound is the next day's local midnight (so the day is included).
 * - Anything else must parse as an ISO 8601 datetime. A `to` bound gets 1 ms added so the
 *   given instant is included.
 *
 * Callers compare with `column >= from` and `column < to`.
 */
export function parseDateBound(value: string, bound: 'from' | 'to'): Date {
  const v = value.trim();
  const m = DATE_ONLY.exec(v);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const d = Number(m[3]);
    const start = new Date(y, mo, d);
    if (start.getFullYear() !== y || start.getMonth() !== mo || start.getDate() !== d) {
      throw new NoteError('invalid_input', `"${value}" is not a valid date (expected YYYY-MM-DD).`);
    }
    return bound === 'from' ? start : new Date(y, mo, d + 1);
  }
  const t = Date.parse(v);
  if (Number.isNaN(t) || !/^\d{4}-\d{2}-\d{2}T/.test(v)) {
    throw new NoteError(
      'invalid_input',
      `"${value}" is not a date. Use YYYY-MM-DD or an ISO 8601 datetime like 2026-10-30T14:00:00+07:00.`,
    );
  }
  return new Date(bound === 'from' ? t : t + 1);
}
```
**Impact:** phase 5 calls it for `takenFrom`/`takenTo`: phase 1 stores `image_meta.taken_at` as a
UTC ISO string ending in `Z` (`Date#toISOString()` form), so phase 5 compares
`(image_meta->>'taken_at')` as text against `parseDateBound(...).toISOString()`.

### Step 3: Event bus
**File:** `src/notes/events.ts:1`
**Change:** create.
**Code:**
```ts
import { EventEmitter } from 'node:events';

export type NoteOp = 'created' | 'updated' | 'deleted' | 'restored';

export interface NoteEvent {
  type: 'note';
  op: NoteOp;
  id: string;
}

export type NoteEventListener = (event: NoteEvent) => void;

/**
 * In-process bus for note changes. The notes service is the only emitter; SSE (phase 6) and
 * anything else that wants to react to writes subscribe with `on`.
 */
export class NoteEvents {
  private readonly emitter = new EventEmitter();

  constructor() {
    // One listener per open SSE connection; no artificial cap.
    this.emitter.setMaxListeners(0);
  }

  emit(op: NoteOp, id: string): void {
    const event: NoteEvent = { type: 'note', op, id };
    this.emitter.emit('note', event);
  }

  /** Subscribes and returns the unsubscribe function. */
  on(listener: NoteEventListener): () => void {
    this.emitter.on('note', listener);
    return () => {
      this.emitter.off('note', listener);
    };
  }

  listenerCount(): number {
    return this.emitter.listenerCount('note');
  }
}
```
**Impact:** phase 6 SSE subscribes with `deps.events.on(...)` and calls the returned function on disconnect.

### Step 4: Repository (all SQL)
**File:** `src/notes/repo.ts:1`
**Change:** create. Decisions:
- `filterConditions` is the one place filters become SQL; `listNotes` and `searchNotes` both use it.
  `hasImage` lives here now (R3 visibility, owner commit `30a58fd`); phase 5 adds `takenFrom`/`takenTo`
  in the same function.
- Paging is an opaque base64url offset cursor (`{"o":n}`): search is ranked, so keyset paging
  can't work there, and one cursor format for both keeps the tools uniform.
- List sorts by the filtered date column (`created` by default) desc, then id desc. Search ranks by
  `ts_rank`, then `updated_at` desc, then id.
- The tsvector expression is `to_tsvector('simple', "notes"."body")`, which matches phase 1's GIN
  index expression.
- `insertNote` uses `onConflictDoNothing({ target: notes.id })` so only an id clash returns `null`
  (retried by the service); a clash on the sha256 unique index still throws and becomes
  `NoteError('duplicate_image')` (pg code `23505`, looked up through drizzle's `cause` chain).
- `listTags` reads `last_used` as epoch milliseconds (`extract(epoch ...)::float8`): a raw
  `max(timestamptz)` comes back as a driver-specific string that `new Date()` does not reliably parse.
- `lockNote` uses `SELECT ... FOR UPDATE` so concurrent edits of one note serialise and every
  revision holds the body that was actually replaced.
**Code:**
```ts
import { and, arrayContains, arrayOverlaps, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { noteRevisions, notes } from '../db/schema.js';
import { parseDateBound } from './dates.js';
import { NoteError, type ImageMeta, type NoteRow, type Origin } from './types.js';

/** A transaction handle, as passed to the callback of `db.transaction`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Anything a query can run on: the pool-backed db or an open transaction. */
export type Executor = Db | Tx;

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 5000;

/**
 * Filters shared by list and search. Phase 5 adds `takenFrom` / `takenTo` here and in
 * `filterConditions`; nothing else needs to change.
 */
export interface NoteFilter {
  /** Notes carrying at least one of these tags. `#` prefix and case are ignored. */
  tagsAny?: string[];
  /** Notes carrying every one of these tags. */
  tagsAll?: string[];
  /** Which timestamp `from` / `to` apply to (and list sorts by). Default 'created'. */
  dateField?: 'created' | 'updated';
  /** Inclusive lower bound: YYYY-MM-DD (local day) or ISO datetime. */
  from?: string;
  /** Inclusive upper bound: YYYY-MM-DD (local day) or ISO datetime. */
  to?: string;
  /** true = image notes only, false = text notes only, undefined = both. */
  hasImage?: boolean;
  /** Default 'exclude'. */
  deleted?: 'exclude' | 'include' | 'only';
  /** 1..MAX_LIMIT, default DEFAULT_LIMIT. */
  limit?: number;
  /** Opaque value from a previous page's `next_cursor`. */
  cursor?: string;
}

export interface RowPage {
  rows: NoteRow[];
  nextCursor: string | null;
}

export interface TagRow {
  tag: string;
  count: number;
  lastUsed: Date;
}

export interface RevisionRow {
  id: number;
  noteId: string;
  body: string;
  savedAt: Date;
}

export interface InsertNote {
  id: string;
  body: string;
  tags: string[];
  origin: Origin | null;
  imagePath: string | null;
  imageMeta: ImageMeta | null;
}

/** `#Seer`, ` seer ` and `SEER` all become `seer`; empty entries are dropped. */
export function normalizeTagInput(tags: readonly string[] | undefined): string[] {
  if (!tags) return [];
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim().replace(/^#+/, '').toLowerCase();
    if (t !== '' && !out.includes(t)) out.push(t);
  }
  return out;
}

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === '') return 0;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (parsed !== null && typeof parsed === 'object') {
      const o = (parsed as { o?: unknown }).o;
      if (typeof o === 'number' && Number.isInteger(o) && o >= 0) return o;
    }
  } catch {
    // fall through
  }
  throw new NoteError('invalid_input', 'cursor is not valid; pass the next_cursor from a previous result unchanged.');
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

function dateColumn(filter: NoteFilter) {
  return filter.dateField === 'updated' ? notes.updatedAt : notes.createdAt;
}

/** WHERE conditions for a filter (paging excluded). */
export function filterConditions(filter: NoteFilter): SQL[] {
  const conds: SQL[] = [];
  const deleted = filter.deleted ?? 'exclude';
  if (deleted === 'exclude') conds.push(isNull(notes.deletedAt));
  if (deleted === 'only') conds.push(isNotNull(notes.deletedAt));

  const any = normalizeTagInput(filter.tagsAny);
  if (any.length > 0) conds.push(arrayOverlaps(notes.tags, any));
  const all = normalizeTagInput(filter.tagsAll);
  if (all.length > 0) conds.push(arrayContains(notes.tags, all));

  const col = dateColumn(filter);
  if (filter.from !== undefined && filter.from !== '') conds.push(gte(col, parseDateBound(filter.from, 'from')));
  if (filter.to !== undefined && filter.to !== '') conds.push(lt(col, parseDateBound(filter.to, 'to')));

  if (filter.hasImage === true) conds.push(isNotNull(notes.imagePath));
  if (filter.hasImage === false) conds.push(isNull(notes.imagePath));
  return conds;
}

function page(rows: NoteRow[], limit: number, offset: number): RowPage {
  if (rows.length > limit) return { rows: rows.slice(0, limit), nextCursor: encodeCursor(offset + limit) };
  return { rows, nextCursor: null };
}

export async function listNotes(db: Executor, filter: NoteFilter): Promise<RowPage> {
  const limit = clampLimit(filter.limit);
  const offset = decodeCursor(filter.cursor);
  const col = dateColumn(filter);
  const rows = await db
    .select()
    .from(notes)
    .where(and(...filterConditions(filter)))
    .orderBy(desc(col), desc(notes.id))
    .limit(limit + 1)
    .offset(offset);
  return page(rows, limit, offset);
}

export async function searchNotes(db: Executor, query: string, filter: NoteFilter): Promise<RowPage> {
  const limit = clampLimit(filter.limit);
  const offset = decodeCursor(filter.cursor);
  // Must match the expression of phase 1's GIN index so the planner can use it.
  const vector = sql`to_tsvector('simple', ${notes.body})`;
  const tsquery = sql`websearch_to_tsquery('simple', ${query})`;
  const rows = await db
    .select()
    .from(notes)
    .where(and(sql`${vector} @@ ${tsquery}`, ...filterConditions(filter)))
    .orderBy(desc(sql`ts_rank(${vector}, ${tsquery})`), desc(notes.updatedAt), desc(notes.id))
    .limit(limit + 1)
    .offset(offset);
  return page(rows, limit, offset);
}

export async function findNotesByIds(db: Executor, ids: readonly string[]): Promise<NoteRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(notes).where(inArray(notes.id, [...ids]));
}

export async function findNoteById(db: Executor, id: string): Promise<NoteRow | null> {
  const rows = await db.select().from(notes).where(eq(notes.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Reads a note and locks its row until the transaction ends. */
export async function lockNote(tx: Tx, id: string): Promise<NoteRow | null> {
  const rows = await tx.select().from(notes).where(eq(notes.id, id)).for('update');
  return rows[0] ?? null;
}

/** Live notes first, then the most recently changed deleted one. */
export async function findNoteBySha256(db: Executor, sha256: string, includeDeleted: boolean): Promise<NoteRow | null> {
  const conds: SQL[] = [sql`${notes.imageMeta}->>'sha256' = ${sha256}`];
  if (!includeDeleted) conds.push(isNull(notes.deletedAt));
  const rows = await db
    .select()
    .from(notes)
    .where(and(...conds))
    .orderBy(sql`${notes.deletedAt} is not null`, desc(notes.updatedAt))
    .limit(1);
  return rows[0] ?? null;
}

function pgErrorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur !== null && typeof cur === 'object'; depth += 1) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Inserts a note. Returns null when the id is already taken (the caller retries with a new id).
 * A clash on the live-image sha256 unique index throws NoteError('duplicate_image').
 */
export async function insertNote(db: Executor, values: InsertNote): Promise<NoteRow | null> {
  try {
    const rows = await db
      .insert(notes)
      .values({
        id: values.id,
        body: values.body,
        tags: values.tags,
        origin: values.origin,
        imagePath: values.imagePath,
        imageMeta: values.imageMeta,
        createdAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .onConflictDoNothing({ target: notes.id })
      .returning();
    return rows[0] ?? null;
  } catch (err) {
    if (pgErrorCode(err) === '23505') {
      throw new NoteError('duplicate_image', 'A live note already holds an image with the same sha256.');
    }
    throw err;
  }
}

export async function idExists(db: Executor, id: string): Promise<boolean> {
  const rows = await db.select({ id: notes.id }).from(notes).where(eq(notes.id, id)).limit(1);
  return rows.length > 0;
}

/** Replaces body and tags (and origin when given), bumping updated_at. */
export async function setBody(
  tx: Executor,
  id: string,
  body: string,
  tags: string[],
  origin: Origin | null | undefined,
): Promise<NoteRow> {
  const values: { body: string; tags: string[]; updatedAt: SQL; origin?: Origin | null } = {
    body,
    tags,
    updatedAt: sql`now()`,
  };
  if (origin !== undefined) values.origin = origin;
  const rows = await tx.update(notes).set(values).where(eq(notes.id, id)).returning();
  const row = rows[0];
  if (!row) throw new NoteError('not_found', `Note ${id} does not exist.`);
  return row;
}

export async function setOrigin(tx: Executor, id: string, origin: Origin | null): Promise<NoteRow> {
  const rows = await tx.update(notes).set({ origin, updatedAt: sql`now()` }).where(eq(notes.id, id)).returning();
  const row = rows[0];
  if (!row) throw new NoteError('not_found', `Note ${id} does not exist.`);
  return row;
}

export async function setDeleted(tx: Executor, id: string, deleted: boolean): Promise<NoteRow> {
  const rows = await tx
    .update(notes)
    .set({ deletedAt: deleted ? sql`now()` : null })
    .where(eq(notes.id, id))
    .returning();
  const row = rows[0];
  if (!row) throw new NoteError('not_found', `Note ${id} does not exist.`);
  return row;
}

export async function insertRevision(tx: Executor, noteId: string, body: string): Promise<void> {
  await tx.insert(noteRevisions).values({ noteId, body });
}

/** Newest first. */
export async function listRevisions(db: Executor, noteId: string): Promise<RevisionRow[]> {
  return db
    .select({ id: noteRevisions.id, noteId: noteRevisions.noteId, body: noteRevisions.body, savedAt: noteRevisions.savedAt })
    .from(noteRevisions)
    .where(eq(noteRevisions.noteId, noteId))
    .orderBy(desc(noteRevisions.savedAt), desc(noteRevisions.id));
}

export async function getRevision(db: Executor, noteId: string, revisionId: number): Promise<RevisionRow | null> {
  const rows = await db
    .select({ id: noteRevisions.id, noteId: noteRevisions.noteId, body: noteRevisions.body, savedAt: noteRevisions.savedAt })
    .from(noteRevisions)
    .where(and(eq(noteRevisions.noteId, noteId), eq(noteRevisions.id, revisionId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Every tag on a live note, most used first, with the newest updated_at among its notes. */
export async function listTags(db: Executor): Promise<TagRow[]> {
  const sub = db
    .select({ tag: sql<string>`unnest(${notes.tags})`.as('tag'), updatedAt: notes.updatedAt })
    .from(notes)
    .where(isNull(notes.deletedAt))
    .as('t');
  const rows = await db
    .select({
      tag: sub.tag,
      count: sql<number>`count(*)::int`,
      // Epoch milliseconds: driver-independent, unlike a raw timestamptz string.
      lastUsedMs: sql<number>`(extract(epoch from max(${sub.updatedAt})) * 1000)::float8`,
    })
    .from(sub)
    .groupBy(sub.tag)
    .orderBy(desc(sql`count(*)`), asc(sub.tag));
  return rows.map((r) => ({
    tag: r.tag,
    count: Number(r.count),
    lastUsed: new Date(Number(r.lastUsedMs)),
  }));
}
```
**Impact:** phase 5 edits `NoteFilter` + `filterConditions` (adds `takenFrom`/`takenTo`); nothing else.

### Step 5: Notes service
**File:** `src/notes/service.ts:1`
**Change:** create. The only writer. Every body change (update, append, revert, delete) runs
`lockNote` → `insertRevision(previous body)` → write, in **one** `db.transaction`. Events fire after
commit via `finish()`. Ids are collision-retried up to 20 times (`onConflictDoNothing` → new id).
Restore changes no body, so it writes no revision.
**Code:**
```ts
import type { Db } from '../db/client.js';
import type { NoteEvents, NoteOp } from './events.js';
import { generateId, normalizeId } from './ids.js';
import * as repo from './repo.js';
import type { NoteFilter } from './repo.js';
import { parseTags } from './tags.js';
import {
  NoteError,
  cleanOrigin,
  rowToNote,
  type ImageMeta,
  type Note,
  type NotePage,
  type NoteRow,
  type Origin,
  type Revision,
  type TagCount,
} from './types.js';

export const MAX_ID_ATTEMPTS = 20;

export interface NotesServiceDeps {
  db: Db;
  dataDir: string;
  events: NoteEvents;
}

export interface CreateNoteInput {
  /** May be empty only when `allowEmpty` is true. */
  body: string;
  origin?: Origin | null;
  /** Image notes (phase 4): `path` is relative to dataDir, e.g. images/2026/10/A-B32.jpg. */
  image?: { path: string; meta: ImageMeta } | null;
  /** HTTP "+" (phase 6) and image notes create with an empty body; MCP never sets this. */
  allowEmpty?: boolean;
  /**
   * Use this id instead of generating one (phase 4 names the image file before inserting).
   * Get it from `newId()`. A taken id throws NoteError('conflict'); no retry.
   */
  id?: string;
}

export interface UpdateOptions {
  /** Replaces the stored origin when given. */
  origin?: Origin | null;
  /** HTTP inline edit may empty a note; MCP never sets this. */
  allowEmpty?: boolean;
}

export interface GetOptions {
  includeDeleted?: boolean;
}

export interface GetResult {
  /** In the order the ids were asked for, without duplicates. */
  notes: Note[];
  /** Inputs that are not ids, or ids no note has. */
  missing: string[];
  /** Ids of soft-deleted notes, reported here when includeDeleted is false. */
  deleted: string[];
}

interface Mutation {
  row: NoteRow;
  op: NoteOp | null;
}

/** The only writer of notes. Every mutation is atomic and emits one event after commit. */
export class NotesService {
  private readonly db: Db;
  private readonly dataDir: string;
  private readonly events: NoteEvents;

  constructor(deps: NotesServiceDeps) {
    this.db = deps.db;
    this.dataDir = deps.dataDir;
    this.events = deps.events;
  }

  /** Canonical id or NoteError('invalid_id'). */
  requireId(input: string): string {
    const id = normalizeId(input);
    if (id === null) {
      throw new NoteError('invalid_id', `"${input}" is not a note id. Ids look like A-B32 (case and the dash are optional).`);
    }
    return id;
  }

  /** An id no note (live or deleted) currently has. */
  async newId(): Promise<string> {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const id = generateId();
      if (!(await repo.idExists(this.db, id))) return id;
    }
    throw new NoteError('conflict', 'Could not find a free note id.');
  }

  async create(input: CreateNoteInput): Promise<Note> {
    const body = input.body;
    if (!input.allowEmpty && body.trim() === '') {
      throw new NoteError('empty_body', 'A note needs some text.');
    }
    const values = {
      body,
      tags: parseTags(body),
      origin: cleanOrigin(input.origin ?? null),
      imagePath: input.image?.path ?? null,
      imageMeta: input.image?.meta ?? null,
    };

    let row: NoteRow | null = null;
    if (input.id !== undefined) {
      const id = this.requireId(input.id);
      row = await repo.insertNote(this.db, { id, ...values });
      if (row === null) throw new NoteError('conflict', `Note id ${id} is already taken.`);
    } else {
      for (let attempt = 0; attempt < MAX_ID_ATTEMPTS && row === null; attempt += 1) {
        row = await repo.insertNote(this.db, { id: generateId(), ...values });
      }
      if (row === null) throw new NoteError('conflict', 'Could not find a free note id.');
    }
    return this.finish({ row, op: 'created' });
  }

  async getOne(idInput: string, opts: GetOptions = {}): Promise<Note | null> {
    const id = normalizeId(idInput);
    if (id === null) return null;
    const row = await repo.findNoteById(this.db, id);
    if (row === null) return null;
    if (row.deletedAt !== null && !opts.includeDeleted) return null;
    return this.toNote(row);
  }

  async get(idInputs: readonly string[], opts: GetOptions = {}): Promise<GetResult> {
    const wanted: string[] = [];
    const missing: string[] = [];
    for (const input of idInputs) {
      const id = normalizeId(input);
      if (id === null) missing.push(input);
      else if (!wanted.includes(id)) wanted.push(id);
    }
    const rows = await repo.findNotesByIds(this.db, wanted);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const notes: Note[] = [];
    const deleted: string[] = [];
    for (const id of wanted) {
      const row = byId.get(id);
      if (row === undefined) missing.push(id);
      else if (row.deletedAt !== null && !opts.includeDeleted) deleted.push(id);
      else notes.push(this.toNote(row));
    }
    return { notes, missing, deleted };
  }

  async findBySha256(sha256: string, opts: GetOptions = {}): Promise<Note | null> {
    const row = await repo.findNoteBySha256(this.db, sha256, opts.includeDeleted ?? false);
    return row === null ? null : this.toNote(row);
  }

  async list(filter: NoteFilter = {}): Promise<NotePage> {
    const page = await repo.listNotes(this.db, filter);
    return { notes: page.rows.map((r) => this.toNote(r)), next_cursor: page.nextCursor };
  }

  async search(query: string, filter: NoteFilter = {}): Promise<NotePage> {
    if (query.trim() === '') throw new NoteError('invalid_input', 'search needs a non-empty query.');
    const page = await repo.searchNotes(this.db, query, filter);
    return { notes: page.rows.map((r) => this.toNote(r)), next_cursor: page.nextCursor };
  }

  async tags(): Promise<TagCount[]> {
    const rows = await repo.listTags(this.db);
    return rows.map((r) => ({ tag: r.tag, count: r.count, last_used: r.lastUsed.toISOString() }));
  }

  async revisions(idInput: string): Promise<Revision[]> {
    const id = this.requireId(idInput);
    if (!(await repo.idExists(this.db, id))) throw new NoteError('not_found', `Note ${id} does not exist.`);
    const rows = await repo.listRevisions(this.db, id);
    return rows.map((r) => ({ revision: r.id, note_id: r.noteId, body: r.body, saved_at: r.savedAt.toISOString() }));
  }

  /** Full body replace. The previous body becomes a revision in the same transaction. */
  async update(idInput: string, body: string, opts: UpdateOptions = {}): Promise<Note> {
    const id = this.requireId(idInput);
    if (!opts.allowEmpty && body.trim() === '') {
      throw new NoteError('empty_body', 'update needs a non-empty body. To remove a note use delete.');
    }
    const origin = opts.origin === undefined ? undefined : cleanOrigin(opts.origin);
    const result = await this.db.transaction(async (tx): Promise<Mutation> => {
      const cur = await this.lockLive(tx, id);
      if (cur.body === body) {
        if (origin === undefined) return { row: cur, op: null };
        return { row: await repo.setOrigin(tx, id, origin), op: 'updated' };
      }
      await repo.insertRevision(tx, id, cur.body);
      return { row: await repo.setBody(tx, id, body, parseTags(body), origin), op: 'updated' };
    });
    return this.finish(result);
  }

  /** Adds text at the end, separated from the existing body by a blank line. */
  async append(idInput: string, text: string, opts: Pick<UpdateOptions, 'origin'> = {}): Promise<Note> {
    const id = this.requireId(idInput);
    if (text.trim() === '') throw new NoteError('empty_body', 'append needs some text.');
    const origin = opts.origin === undefined ? undefined : cleanOrigin(opts.origin);
    const result = await this.db.transaction(async (tx): Promise<Mutation> => {
      const cur = await this.lockLive(tx, id);
      const head = cur.body.replace(/\s+$/, '');
      const body = head === '' ? text : `${head}\n\n${text}`;
      await repo.insertRevision(tx, id, cur.body);
      return { row: await repo.setBody(tx, id, body, parseTags(body), origin), op: 'updated' };
    });
    return this.finish(result);
  }

  /** Soft delete. The body is kept as a revision. Deleting a deleted note is a no-op. */
  async delete(idInput: string): Promise<Note> {
    const id = this.requireId(idInput);
    const result = await this.db.transaction(async (tx): Promise<Mutation> => {
      const cur = await repo.lockNote(tx, id);
      if (cur === null) throw new NoteError('not_found', `Note ${id} does not exist.`);
      if (cur.deletedAt !== null) return { row: cur, op: null };
      await repo.insertRevision(tx, id, cur.body);
      return { row: await repo.setDeleted(tx, id, true), op: 'deleted' };
    });
    return this.finish(result);
  }

  /** Undoes a soft delete. Restoring a live note is a no-op. */
  async restore(idInput: string): Promise<Note> {
    const id = this.requireId(idInput);
    const result = await this.db.transaction(async (tx): Promise<Mutation> => {
      const cur = await repo.lockNote(tx, id);
      if (cur === null) throw new NoteError('not_found', `Note ${id} does not exist.`);
      if (cur.deletedAt === null) return { row: cur, op: null };
      return { row: await repo.setDeleted(tx, id, false), op: 'restored' };
    });
    return this.finish(result);
  }

  /** Brings back a revision's body; the body it replaces becomes a new revision. */
  async revert(idInput: string, revision: number): Promise<Note> {
    const id = this.requireId(idInput);
    const result = await this.db.transaction(async (tx): Promise<Mutation> => {
      const cur = await this.lockLive(tx, id);
      const rev = await repo.getRevision(tx, id, revision);
      if (rev === null) {
        throw new NoteError('invalid_revision', `Note ${id} has no revision ${revision}. Call revisions("${id}") to see them.`);
      }
      if (rev.body === cur.body) return { row: cur, op: null };
      await repo.insertRevision(tx, id, cur.body);
      return { row: await repo.setBody(tx, id, rev.body, parseTags(rev.body), undefined), op: 'updated' };
    });
    return this.finish(result);
  }

  private async lockLive(tx: repo.Tx, id: string): Promise<NoteRow> {
    const cur = await repo.lockNote(tx, id);
    if (cur === null) throw new NoteError('not_found', `Note ${id} does not exist.`);
    if (cur.deletedAt !== null) {
      throw new NoteError('deleted', `Note ${id} is deleted. Call restore("${id}") first if you want to change it.`);
    }
    return cur;
  }

  private finish(result: Mutation): Note {
    if (result.op !== null) this.events.emit(result.op, result.row.id);
    return this.toNote(result.row);
  }

  private toNote(row: NoteRow): Note {
    return rowToNote(row, this.dataDir);
  }
}
```
**Impact:** this is the API phases 4, 5, 6 call (see Interface Contract).

### Step 6: Server instructions
**File:** `src/mcp/instructions.ts:1`
**Change:** create. Covers what mcp-notes is, one text field, hashtags as tags, id format,
case-insensitive dash-tolerant lookup, write semantics, revisions, soft delete, filters, date rules
with the daemon's timezone, and that comparisons are Claude's job from list/search.
**Code:**
```ts
/** Local IANA timezone of the daemon, e.g. Asia/Jakarta. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * MCP server instructions: Claude reads these once per session. Phase 5 appends one paragraph
 * about image notes to `sections`.
 */
export function buildInstructions(timeZone: string = localTimeZone()): string {
  const sections = [
    `mcp-notes is the user's personal note store: plain-text notes kept in Postgres and shared by every Claude Code session on this machine (and the user's other laptop, which uses the same database). Use these tools whenever the user asks to save, find, read, change, summarise or compare their notes, usually through the /n skill.`,

    `Notes. A note is a single plain-text body: no title, no fields, no other structure. Put everything in the body. Tags are the #hashtags written in the body (#seer, #v250, #from_phone); the server re-parses them from the body on every write and lower-cases them. To tag a note, write the hashtag into its body (update or append); to untag it, remove the hashtag from the body. Tag filters accept "seer" or "#seer". Every note returned has id, body, tags, created_at and updated_at (ISO 8601, UTC), origin (where it was saved from: cwd, repo, claude_session; may be null) and image (null for text notes).`,

    `Ids. Ids look like A-B32: one character from 0-9/A-Z, a dash, three characters from 0-9/A-Z. The server generates them; never invent one. Lookup is case-insensitive and tolerates a missing dash, so "ab32", "a-b32" and "AB32" all find A-B32. When you mention a note to the user, quote its id in the canonical A-B32 form.`,

    `Writing. create needs a non-empty body; when saving from a repository pass origin {cwd, repo, claude_session} so the note remembers where it came from. update replaces the whole body (read the note first with get, then send the full new text); append adds text at the end after a blank line. Every body change keeps the previous body as a revision: revisions(id) lists them and revert(id, revision) brings one back, keeping the body it replaces as a new revision. delete is soft: the note leaves list, search and tags but restore(id) brings it back; list with deleted="only" finds deleted notes.`,

    `Reading. get takes one or several ids. list returns notes newest first, filtered by tags (tags_any: at least one; tags_all: every one) and a date range (from/to, on the created or updated date), with paging via limit and next_cursor. search adds full-text matching on the body with the "simple" configuration: exact words and code tokens, no stemming; it understands "quoted phrases", OR and -exclusions, and ranks by relevance, then recency. tags lists every tag with its note count and the time it was last used.`,

    `Dates. from and to accept YYYY-MM-DD or a full ISO 8601 datetime. A YYYY-MM-DD value means the whole day in the daemon's local timezone, ${timeZone}: from starts at that day's midnight and to includes the whole day. Datetimes are exact.`,

    `Comparisons and summaries ("this week vs last week", "#seer vs #v250", "what was my last note about X") are your job, not the server's: call list or search once per side with the right filters, page with next_cursor if needed, then compare or summarise the results yourself.`,
  ];
  return sections.join('\n\n');
}
```
**Impact:** phase 5 appends one image paragraph to `sections`.

### Step 7: The eleven note tools
**File:** `src/mcp/tools.ts:1`
**Change:** create. Every tool returns pretty JSON text; every failure becomes an `isError` result
whose text starts with the `NoteError` code (`not_found: Note Z-ZZZ does not exist.`), so Claude can
act on it. MCP `create`/`update` require a non-empty body (zod `min(1)`) and never pass `allowEmpty`.
Origins from MCP get `source: 'mcp'`. MCP page size is capped at 200 (default 50). `has_image` is
**not** in `noteFilterShape` in this phase (coordinator instruction; phase 5 adds it with
`taken_from`/`taken_to` and maps it in `toFilter`).
**Code:**
```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import type { NoteFilter } from '../notes/repo.js';
import type { NotesService } from '../notes/service.js';
import { NoteError } from '../notes/types.js';

export interface ToolDeps {
  service: NotesService;
  dataDir: string;
  /** Read-only use by phase 5's image tools (raw image records); writes still go through `service`. */
  db: Db;
}

export const MCP_MAX_LIMIT = 200;
export const MCP_DEFAULT_LIMIT = 50;

const idField = z
  .string()
  .min(1)
  .describe('Note id like A-B32. Case-insensitive; the dash may be omitted ("ab32" works).');

const originField = z
  .object({
    cwd: z.string().optional().describe('Absolute working directory of the Claude Code session.'),
    repo: z.string().optional().describe('Repository name or remote, e.g. "seer" or "github.com/me/seer".'),
    claude_session: z.string().optional().describe('Claude Code session id, if known.'),
  })
  .optional()
  .describe('Where this note is being saved from. Pass it whenever you save from inside a repository.');

/**
 * Filter fields shared by list and search. Phase 5 adds has_image, taken_from and taken_to here
 * and maps them in `toFilter`.
 */
export const noteFilterShape = {
  tags_any: z
    .array(z.string())
    .optional()
    .describe('Notes that carry at least one of these tags. "seer" and "#seer" are the same.'),
  tags_all: z.array(z.string()).optional().describe('Notes that carry every one of these tags.'),
  date_field: z
    .enum(['created', 'updated'])
    .optional()
    .describe('Which date from/to filter on, and (for list) the sort order. Default "created".'),
  from: z
    .string()
    .optional()
    .describe('Inclusive start: YYYY-MM-DD (start of that local day) or an ISO 8601 datetime.'),
  to: z
    .string()
    .optional()
    .describe('Inclusive end: YYYY-MM-DD (the whole local day is included) or an ISO 8601 datetime.'),
  deleted: z
    .enum(['exclude', 'include', 'only'])
    .optional()
    .describe('Soft-deleted notes: "exclude" (default), "include", or "only" (to find something to restore).'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MCP_MAX_LIMIT)
    .optional()
    .describe(`Page size, 1-${MCP_MAX_LIMIT}. Default ${MCP_DEFAULT_LIMIT}.`),
  cursor: z
    .string()
    .optional()
    .describe('next_cursor from the previous page, unchanged. Omit for the first page.'),
};

export interface FilterArgs {
  tags_any?: string[] | undefined;
  tags_all?: string[] | undefined;
  date_field?: 'created' | 'updated' | undefined;
  from?: string | undefined;
  to?: string | undefined;
  deleted?: 'exclude' | 'include' | 'only' | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

/** Maps MCP snake_case filter args to the repo filter. */
export function toFilter(args: FilterArgs): NoteFilter {
  const filter: NoteFilter = { limit: args.limit ?? MCP_DEFAULT_LIMIT };
  if (args.tags_any !== undefined) filter.tagsAny = args.tags_any;
  if (args.tags_all !== undefined) filter.tagsAll = args.tags_all;
  if (args.date_field !== undefined) filter.dateField = args.date_field;
  if (args.from !== undefined) filter.from = args.from;
  if (args.to !== undefined) filter.to = args.to;
  if (args.deleted !== undefined) filter.deleted = args.deleted;
  if (args.cursor !== undefined) filter.cursor = args.cursor;
  return filter;
}

export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export function errorResult(err: unknown): CallToolResult {
  const text = err instanceof NoteError ? `${err.code}: ${err.message}` : `error: ${err instanceof Error ? err.message : String(err)}`;
  return { isError: true, content: [{ type: 'text', text }] };
}

/** Runs a handler and turns any thrown error into an MCP error result Claude can read. */
export async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return jsonResult(await fn());
  } catch (err) {
    return errorResult(err);
  }
}

export function registerNoteTools(server: McpServer, deps: ToolDeps): void {
  const { service } = deps;

  server.registerTool(
    'create',
    {
      title: 'Create note',
      description:
        'Save a new note. The body is plain text; put #hashtags in it to tag the note (tags are parsed from the body). Returns the created note with its new id (like A-B32) - quote that id to the user. Pass origin when saving from inside a repository.',
      inputSchema: {
        body: z.string().min(1).describe('The full note text, including any #hashtags. Must not be empty.'),
        origin: originField,
      },
    },
    async ({ body, origin }) =>
      run(async () => ({ note: await service.create({ body, origin: { ...origin, source: 'mcp' } }) })),
  );

  server.registerTool(
    'get',
    {
      title: 'Get notes',
      description:
        'Fetch one or several notes by id. Returns { notes, missing, deleted }: missing lists inputs that are not ids or match no note; deleted lists ids of soft-deleted notes (pass include_deleted=true to see their bodies, or restore them).',
      inputSchema: {
        ids: z.array(idField).min(1).max(100).describe('One or more note ids, e.g. ["A-B32"] or ["ab32", "7-QX0"].'),
        include_deleted: z.boolean().optional().describe('Also return soft-deleted notes (they carry deleted_at). Default false.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ ids, include_deleted }) => run(() => service.get(ids, { includeDeleted: include_deleted ?? false })),
  );

  server.registerTool(
    'update',
    {
      title: 'Replace note body',
      description:
        'Replace the whole body of a note with new text. Read the note with get first and send the complete new text: anything you leave out is removed. Tags are re-parsed from the new body, so keep the #hashtags you want (add one to tag the note). The previous body is kept as a revision. Fails on a deleted note.',
      inputSchema: {
        id: idField,
        body: z.string().min(1).describe('The complete new note text. Must not be empty; use delete to remove a note.'),
        origin: originField,
      },
      annotations: { idempotentHint: true },
    },
    async ({ id, body, origin }) =>
      run(async () => ({
        note: await service.update(id, body, origin === undefined ? {} : { origin: { ...origin, source: 'mcp' } }),
      })),
  );

  server.registerTool(
    'append',
    {
      title: 'Append to note',
      description:
        'Add text to the end of a note, after a blank line, leaving the existing text untouched. Hashtags in the appended text become tags. The previous body is kept as a revision. Fails on a deleted note.',
      inputSchema: {
        id: idField,
        text: z.string().min(1).describe('Text to add at the end.'),
      },
    },
    async ({ id, text }) => run(async () => ({ note: await service.append(id, text) })),
  );

  server.registerTool(
    'delete',
    {
      title: 'Delete note',
      description:
        'Soft-delete a note: it disappears from list, search and tags, but its text is kept and restore brings it back. Deleting an already deleted note changes nothing.',
      inputSchema: { id: idField },
      annotations: { idempotentHint: true },
    },
    async ({ id }) => run(async () => ({ note: await service.delete(id) })),
  );

  server.registerTool(
    'restore',
    {
      title: 'Restore note',
      description:
        'Undo a delete. Use list with deleted="only" to find deleted notes. Restoring a note that is not deleted changes nothing.',
      inputSchema: { id: idField },
      annotations: { idempotentHint: true },
    },
    async ({ id }) => run(async () => ({ note: await service.restore(id) })),
  );

  server.registerTool(
    'list',
    {
      title: 'List notes',
      description:
        'List notes newest first, optionally filtered by tags and a date range. Use it for "my notes on #seer this week", "my last note about #v250" (tags_any=["v250"], limit=1) or one side of a comparison (call it once per side, then compare yourself). Returns { notes, next_cursor }; when next_cursor is not null there are more notes - pass it back as cursor to get the next page.',
      inputSchema: noteFilterShape,
      annotations: { readOnlyHint: true },
    },
    async (args) => run(() => service.list(toFilter(args))),
  );

  server.registerTool(
    'search',
    {
      title: 'Search notes',
      description:
        'Full-text search over note bodies, with the same tag and date filters as list. Words match exactly (no stemming), so code identifiers and version strings work; supports "quoted phrases", OR, and -word to exclude. Results are ranked by relevance, then recency. Returns { notes, next_cursor }.',
      inputSchema: {
        query: z.string().min(1).describe('Words to look for, e.g. "retry backoff" or "\\"connection pool\\" -redis".'),
        ...noteFilterShape,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, ...filter }) => run(() => service.search(query, toFilter(filter))),
  );

  server.registerTool(
    'tags',
    {
      title: 'List tags',
      description:
        'Every tag used by a live note, most used first, with its note count and last_used (the newest updated_at among its notes). Use it to discover what the user tags things with before filtering.',
      annotations: { readOnlyHint: true },
    },
    async () => run(async () => ({ tags: await service.tags() })),
  );

  server.registerTool(
    'revisions',
    {
      title: 'List revisions',
      description:
        'Earlier bodies of a note, newest first. Each has a revision number, the body as it was, and saved_at (when it was replaced). Pass a revision number to revert to restore that text.',
      inputSchema: { id: idField },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => run(async () => ({ revisions: await service.revisions(id) })),
  );

  server.registerTool(
    'revert',
    {
      title: 'Revert to revision',
      description:
        'Make a note\'s body equal to one of its earlier revisions (numbers come from revisions). The body being replaced is kept as a new revision, so a revert can itself be undone.',
      inputSchema: {
        id: idField,
        revision: z.number().int().positive().describe('Revision number from revisions(id).'),
      },
    },
    async ({ id, revision }) => run(async () => ({ note: await service.revert(id, revision) })),
  );
}
```
**Impact:** phase 5 adds fields to `noteFilterShape`/`FilterArgs`/`toFilter`.

### Step 8: Image tools placeholder
**File:** `src/mcp/imageTools.ts:1`
**Change:** create (no-op, so `server.ts` already calls it).
**Code:**
```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './tools.js';

/** Image tools (create_image, view_images) arrive in phase 5. Registers nothing yet. */
export function registerImageTools(server: McpServer, deps: ToolDeps): void {
  void server;
  void deps;
}
```
**Impact:** phase 5 replaces the body.

### Step 9: MCP server and stateless transport
**File:** `src/mcp/server.ts:1`
**Change:** create. A new `McpServer` + `WebStandardStreamableHTTPServerTransport` per POST, JSON
responses, closed in `finally` (safe: with `enableJsonResponse` the Response is complete when
`handleRequest` resolves; verified in the int tests).
**Code:**
```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { registerImageTools } from './imageTools.js';
import { buildInstructions } from './instructions.js';
import { registerNoteTools, type ToolDeps } from './tools.js';

export const SERVER_NAME = 'mcp-notes';
export const SERVER_VERSION = '0.1.0';

export function createMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: buildInstructions() },
  );
  registerNoteTools(server, deps);
  registerImageTools(server, deps);
  return server;
}

/**
 * Stateless streamable HTTP: a fresh server and transport per POST, JSON responses (no SSE
 * stream). Nothing is kept between requests, so a daemon restart never strands a client.
 */
export async function handleMcpRequest(req: Request, deps: ToolDeps): Promise<Response> {
  const server = createMcpServer(deps);
  // No sessionIdGenerator: session management off (stateless mode).
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  try {
    await server.connect(transport);
    return await transport.handleRequest(req);
  } finally {
    await server.close();
  }
}
```
**Impact:** none.

### Step 10: Shared deps type
**File:** `src/deps.ts:1`
**Code:**
```ts
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { NoteEvents } from './notes/events.js';
import type { NotesService } from './notes/service.js';

/** Everything the daemon wires together once at startup and hands to routes and background jobs. */
export interface AppDeps {
  config: Config;
  db: Db;
  events: NoteEvents;
  service: NotesService;
}
```
**Impact:** phases 4, 5, 6 take `AppDeps` in their router/background factories.

### Step 11: HTTP app with fixed mount order
**File:** `src/http/app.ts:1`
**Change:** create. `/health`; `/mcp` behind `loopbackOnly` (Host must be loopback, a present
`Origin` must be loopback; blocks DNS rebinding from a browser page); `POST /mcp` handled,
`GET`/`DELETE /mcp` → 405 (stateless: no standalone SSE stream, no sessions); then
`apiRoutes` → `imageRoutes` → `staticRoutes` mounted at `/` in that order.
**Code:**
```ts
import { Hono, type MiddlewareHandler } from 'hono';
import type { AppDeps } from '../deps.js';
import { handleMcpRequest } from '../mcp/server.js';
import { apiRoutes } from './api.js';
import { imageRoutes } from './images.js';
import { staticRoutes } from './static.js';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isLoopbackUrl(value: string): boolean {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * DNS-rebinding guard for /mcp. The request URL (built from the Host header by the node adapter)
 * must name loopback, and a browser Origin, when present, must be a loopback origin too.
 * Claude Code sends no Origin header.
 */
export const loopbackOnly: MiddlewareHandler = async (c, next) => {
  if (!isLoopbackUrl(c.req.url)) {
    return c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Forbidden host.' }, id: null }, 403);
  }
  const origin = c.req.header('origin');
  if (origin !== undefined && !isLoopbackUrl(origin)) {
    return c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Forbidden origin.' }, id: null }, 403);
  }
  await next();
};

/**
 * The whole HTTP surface, mounted in this order (later phases fill the routers, never this file):
 * /health, /mcp, apiRoutes (P6), imageRoutes (P5), staticRoutes (P6, last: it owns the SPA fallback).
 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const toolDeps = { service: deps.service, dataDir: deps.config.dataDir, db: deps.db };

  app.get('/health', (c) => c.json({ ok: true, service: 'notesd' }));

  app.use('/mcp', loopbackOnly);
  app.post('/mcp', (c) => handleMcpRequest(c.req.raw, toolDeps));
  // Stateless server: no standalone SSE stream (GET) and no sessions to end (DELETE).
  app.on(['GET', 'DELETE'], '/mcp', (c) =>
    c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }, 405, { Allow: 'POST' }),
  );

  app.route('/', apiRoutes(deps));
  app.route('/', imageRoutes(deps));
  app.route('/', staticRoutes(deps));
  return app;
}
```
**Impact:** later phases never edit this file.

### Step 12: Empty routers for phases 5 and 6
**File:** `src/http/api.ts:1`
**Code:**
```ts
import { Hono } from 'hono';
import type { AppDeps } from '../deps.js';

/** UI JSON API (/api/notes, /api/tags, /api/events, /api/chat). Phase 6 fills this router. */
export function apiRoutes(deps: AppDeps): Hono {
  void deps;
  return new Hono();
}
```
**File:** `src/http/images.ts:1`
**Code:**
```ts
import { Hono } from 'hono';
import type { AppDeps } from '../deps.js';

/** Image upload and serving (/api/images, /api/notes/:id/{original,display,thumb,preview}). Phase 5 fills this router. */
export function imageRoutes(deps: AppDeps): Hono {
  void deps;
  return new Hono();
}
```
**File:** `src/http/static.ts:1`
**Code:**
```ts
import { Hono } from 'hono';
import type { AppDeps } from '../deps.js';

/** The built SPA from web/dist (/, /full/:id, /assets/*). Phase 6 fills this router. Mounted last. */
export function staticRoutes(deps: AppDeps): Hono {
  void deps;
  return new Hono();
}
```
**Impact:** phases 5/6 replace the bodies (keeping the factory names and the `(deps: AppDeps): Hono` signature). Routers define full paths (`/api/notes`, ...) because they are mounted at `/`.

### Step 13: Background hook
**File:** `src/background.ts:1`
**Code:**
```ts
import type { AppDeps } from './deps.js';

export type StopBackground = () => Promise<void>;

/** Background jobs started after the HTTP server listens. Phase 4 starts the inbox watcher here. */
export async function startBackground(deps: AppDeps): Promise<StopBackground> {
  void deps;
  return async () => {};
}
```
**Impact:** phase 4 replaces the body with the inbox watcher and returns its stop function.

### Step 14: Daemon lifecycle
**File:** `src/daemon.ts:1`
**Change:** create. Testable composition root (the int test runs it on port 0 with a temp data dir).
Refuses any host but `127.0.0.1` even if config was hand-built. Creates
`<dataDir>/{images,cache,inbox,inbox/failed}`. Order: data dirs → db → events → service → app →
listen → `startBackground`. `stop()` is idempotent: background → HTTP server (also drops keep-alive
connections) → db pool.
**Code:**
```ts
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { startBackground } from './background.js';
import type { Config } from './config.js';
import { closeDb, createDb } from './db/client.js';
import type { AppDeps } from './deps.js';
import { createApp } from './http/app.js';
import { NoteEvents } from './notes/events.js';
import { NotesService } from './notes/service.js';

export const DATA_SUBDIRS = ['images', 'cache', 'inbox', join('inbox', 'failed')] as const;

export interface RunningDaemon {
  deps: AppDeps;
  /** The bound port (useful when config.port is 0). */
  port: number;
  stop: () => Promise<void>;
}

export async function ensureDataDirs(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  for (const sub of DATA_SUBDIRS) await mkdir(join(dataDir, sub), { recursive: true });
}

function listen(server: ServerType): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: ServerType): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    if ('closeAllConnections' in server && typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
  });
}

/** config -> data dirs -> db -> service -> app -> listen on loopback -> background jobs. */
export async function startDaemon(config: Config): Promise<RunningDaemon> {
  if (config.host !== '127.0.0.1') {
    throw new Error(`notesd binds 127.0.0.1 only (got host ${config.host}).`);
  }
  await ensureDataDirs(config.dataDir);
  const db = createDb(config.databaseUrl);
  const events = new NoteEvents();
  const service = new NotesService({ db, dataDir: config.dataDir, events });
  const deps: AppDeps = { config, db, events, service };
  const app = createApp(deps);

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port });
  let port: number;
  try {
    port = await listen(server);
  } catch (err) {
    await closeDb(db);
    throw err;
  }
  const stopBackground = await startBackground(deps);

  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      await stopBackground();
      await closeServer(server);
      await closeDb(db);
    })();
    return stopping;
  };
  return { deps, port, stop };
}
```
**Impact:** none.

### Step 15: Process entry
**File:** `src/main.ts:1`
**Change:** create. `dist/main.js` is what systemd (phase 3) runs. Graceful shutdown on SIGINT/SIGTERM
with a 10 s force-exit.
**Code:**
```ts
import { loadConfig } from './config.js';
import { startDaemon } from './daemon.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const daemon = await startDaemon(config);
  console.log(`notesd listening on http://${config.host}:${daemon.port} (data ${config.dataDir})`);

  const shutdown = (signal: NodeJS.Signals): void => {
    console.log(`notesd: ${signal}, shutting down`);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    daemon.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error('notesd: shutdown failed', err);
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error('notesd: failed to start', err);
  process.exit(1);
});
```
**Impact:** none.

### Step 16: Unit tests
**File:** `tests/unit/notes.helpers.test.ts:1`
**Code:**
```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseDateBound } from '../../src/notes/dates.js';
import { NoteEvents, type NoteEvent } from '../../src/notes/events.js';
import { clampLimit, decodeCursor, encodeCursor, MAX_LIMIT, normalizeTagInput } from '../../src/notes/repo.js';
import { cleanOrigin, imageAvailable, NoteError, rowToNote, type NoteRow } from '../../src/notes/types.js';

const dataDir = mkdtempSync(join(tmpdir(), 'notes-unit-'));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

function row(overrides: Partial<NoteRow> = {}): NoteRow {
  return {
    id: 'A-B32',
    body: 'hello #seer',
    tags: ['seer'],
    imagePath: null,
    imageMeta: null,
    origin: null,
    createdAt: new Date('2026-10-30T01:02:03.004Z'),
    updatedAt: new Date('2026-10-30T02:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

describe('parseDateBound', () => {
  it('treats YYYY-MM-DD as a whole local day', () => {
    expect(parseDateBound('2026-10-30', 'from').getTime()).toBe(new Date(2026, 9, 30).getTime());
    expect(parseDateBound('2026-10-30', 'to').getTime()).toBe(new Date(2026, 9, 31).getTime());
    expect(parseDateBound('2026-12-31', 'to').getTime()).toBe(new Date(2027, 0, 1).getTime());
  });

  it('treats datetimes as exact, with an inclusive upper bound', () => {
    expect(parseDateBound('2026-10-30T10:00:00Z', 'from').toISOString()).toBe('2026-10-30T10:00:00.000Z');
    expect(parseDateBound('2026-10-30T10:00:00Z', 'to').toISOString()).toBe('2026-10-30T10:00:00.001Z');
    expect(parseDateBound('2026-10-30T17:00:00+07:00', 'from').toISOString()).toBe('2026-10-30T10:00:00.000Z');
  });

  it('rejects anything else', () => {
    for (const bad of ['yesterday', '2026-02-30', '30/10/2026', '2026-10', '']) {
      expect(() => parseDateBound(bad, 'from')).toThrow(NoteError);
    }
  });
});

describe('repo helpers', () => {
  it('normalises tag filter input', () => {
    expect(normalizeTagInput(['#Seer', ' seer ', 'V250', '##x', '', '#'])).toEqual(['seer', 'v250', 'x']);
    expect(normalizeTagInput(undefined)).toEqual([]);
  });

  it('round-trips cursors and rejects garbage', () => {
    expect(decodeCursor(encodeCursor(150))).toBe(150);
    expect(decodeCursor(undefined)).toBe(0);
    expect(decodeCursor('')).toBe(0);
    expect(() => decodeCursor('not-a-cursor')).toThrow(NoteError);
    expect(() => decodeCursor(Buffer.from('{"o":-1}').toString('base64url'))).toThrow(NoteError);
  });

  it('clamps limits', () => {
    expect(clampLimit(undefined)).toBe(50);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(10.7)).toBe(10);
    expect(clampLimit(1e9)).toBe(MAX_LIMIT);
  });
});

describe('wire mapping', () => {
  it('keeps only known origin string fields', () => {
    expect(cleanOrigin({ cwd: '/x', repo: '', extra: 'y', claude_session: 3 })).toEqual({ cwd: '/x' });
    expect(cleanOrigin({})).toBeNull();
    expect(cleanOrigin('nope')).toBeNull();
    expect(cleanOrigin(null)).toBeNull();
  });

  it('maps a text note', () => {
    expect(rowToNote(row({ origin: { repo: 'seer' } }), dataDir)).toEqual({
      id: 'A-B32',
      body: 'hello #seer',
      tags: ['seer'],
      created_at: '2026-10-30T01:02:03.004Z',
      updated_at: '2026-10-30T02:00:00.000Z',
      origin: { repo: 'seer' },
      image: null,
    });
  });

  it('adds deleted_at only for deleted notes', () => {
    const n = rowToNote(row({ deletedAt: new Date('2026-10-31T00:00:00Z') }), dataDir);
    expect(n.deleted_at).toBe('2026-10-31T00:00:00.000Z');
  });

  it('maps image meta and checks the file under dataDir', () => {
    mkdirSync(join(dataDir, 'images/2026/10'), { recursive: true });
    writeFileSync(join(dataDir, 'images/2026/10/A-B32.jpg'), 'x');
    const meta = { sha256: 'h', mime: 'image/jpeg', width: 4, height: 3, bytes: 1, taken_at: '2026-10-29T08:00:00.000Z', original_name: 'IMG_1.jpg', host: 'lenovo' };
    const here = rowToNote(row({ imagePath: 'images/2026/10/A-B32.jpg', imageMeta: meta }), dataDir);
    expect(here.image).toEqual({ mime: 'image/jpeg', width: 4, height: 3, bytes: 1, taken_at: '2026-10-29T08:00:00.000Z', original_name: 'IMG_1.jpg', host: 'lenovo', available: true });
    const away = rowToNote(row({ imagePath: 'images/2026/10/missing.jpg', imageMeta: meta }), dataDir);
    expect(away.image?.available).toBe(false);
  });

  it('never reports a path outside dataDir as available', () => {
    expect(imageAvailable(dataDir, '../../etc/passwd')).toBe(false);
    expect(imageAvailable(dataDir, '/etc/passwd')).toBe(false);
    expect(imageAvailable(dataDir, '')).toBe(false);
  });
});

describe('NoteEvents', () => {
  it('delivers events and unsubscribes', () => {
    const events = new NoteEvents();
    const got: NoteEvent[] = [];
    const off = events.on((e) => got.push(e));
    events.emit('created', 'A-B32');
    off();
    events.emit('deleted', 'A-B32');
    expect(got).toEqual([{ type: 'note', op: 'created', id: 'A-B32' }]);
    expect(events.listenerCount()).toBe(0);
  });
});
```
**File:** `tests/unit/mcp.instructions.test.ts:1`
**Code:**
```ts
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { loopbackOnly } from '../../src/http/app.js';
import { buildInstructions } from '../../src/mcp/instructions.js';
import { toFilter } from '../../src/mcp/tools.js';

describe('buildInstructions', () => {
  it('explains ids, lookup, tags, dates and who does comparisons', () => {
    const text = buildInstructions('Asia/Jakarta');
    expect(text).toContain('A-B32');
    expect(text).toMatch(/case-insensitive/);
    expect(text).toMatch(/missing dash/);
    expect(text).toMatch(/#hashtags/);
    expect(text).toContain('Asia/Jakarta');
    expect(text).toMatch(/Comparisons and summaries/);
  });
});

describe('toFilter', () => {
  it('maps snake_case args and applies the MCP default limit', () => {
    expect(toFilter({})).toEqual({ limit: 50 });
    expect(
      toFilter({ tags_any: ['a'], tags_all: ['b'], date_field: 'updated', from: '2026-10-01', to: '2026-10-31', deleted: 'only', limit: 5, cursor: 'c' }),
    ).toEqual({ tagsAny: ['a'], tagsAll: ['b'], dateField: 'updated', from: '2026-10-01', to: '2026-10-31', deleted: 'only', limit: 5, cursor: 'c' });
  });
});

describe('loopbackOnly', () => {
  const app = new Hono();
  app.use('*', loopbackOnly);
  app.post('/mcp', (c) => c.text('ok'));

  it('allows loopback hosts without or with a loopback Origin', async () => {
    expect((await app.request('http://localhost:7317/mcp', { method: 'POST' })).status).toBe(200);
    expect((await app.request('http://127.0.0.1:7317/mcp', { method: 'POST', headers: { origin: 'http://localhost:7317' } })).status).toBe(200);
  });

  it('blocks other hosts and foreign origins', async () => {
    expect((await app.request('http://notes.attacker.test/mcp', { method: 'POST' })).status).toBe(403);
    expect((await app.request('http://localhost:7317/mcp', { method: 'POST', headers: { origin: 'https://attacker.test' } })).status).toBe(403);
    expect((await app.request('http://localhost:7317/mcp', { method: 'POST', headers: { origin: 'null' } })).status).toBe(403);
  });
});
```
**Impact:** none. These import `repo.ts`/`tools.ts`, which import the schema module but open no DB connection.

### Step 17: Integration test — service
**File:** `tests/integration/notes.service.int.test.ts:1`
**Change:** create. Self-contained: needs only `TEST_DATABASE_URL` (migrated by `npm run test:int`)
and phase 1's `tests/integration/setup.ts` helpers (`openTestDb`, `closeTestDb`, `truncateAll`);
truncates both tables before each test.
**Code:**
```ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { noteRevisions } from '../../src/db/schema.js';
import { NoteEvents, type NoteEvent } from '../../src/notes/events.js';
import { NotesService } from '../../src/notes/service.js';
import { NoteError, type ImageMeta } from '../../src/notes/types.js';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

const db = openTestDb();
const dataDir = mkdtempSync(join(tmpdir(), 'notes-svc-'));
const events = new NoteEvents();
const service = new NotesService({ db, dataDir, events });
const seen: NoteEvent[] = [];
events.on((e) => seen.push(e));

async function expectNoteError(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(NoteError);
  expect((err as NoteError).code).toBe(code);
}

async function revisionCount(id: string): Promise<number> {
  const rows = await db.select().from(noteRevisions).where(sql`${noteRevisions.noteId} = ${id}`);
  return rows.length;
}

/** Sets created_at and updated_at of a note directly, for date-filter tests. */
async function backdate(id: string, iso: string): Promise<void> {
  await db.execute(sql`update notes set created_at = ${iso}::timestamptz, updated_at = ${iso}::timestamptz where id = ${id}`);
}

const meta = (sha256: string): ImageMeta => ({
  sha256,
  mime: 'image/png',
  width: 2,
  height: 1,
  bytes: 70,
  taken_at: null,
  original_name: 'shot.png',
  host: 'lenovo',
});

beforeEach(async () => {
  await truncateAll(db);
  seen.length = 0;
});

afterAll(async () => {
  await closeTestDb(db);
  rmSync(dataDir, { recursive: true, force: true });
});

describe('NotesService create/get', () => {
  it('creates a note with a canonical id, parsed tags and cleaned origin, and emits created', async () => {
    const note = await service.create({
      body: 'Fixed the #Seer retry loop, see #v250 and #seer',
      origin: { cwd: '/home/m/seer', repo: 'seer', claude_session: 'abc' },
    });
    expect(note.id).toMatch(/^[0-9A-Z]-[0-9A-Z]{3}$/);
    expect(note.tags).toEqual(['seer', 'v250']);
    expect(note.origin).toEqual({ cwd: '/home/m/seer', repo: 'seer', claude_session: 'abc' });
    expect(note.image).toBeNull();
    expect(note.deleted_at).toBeUndefined();
    expect(new Date(note.created_at).toISOString()).toBe(note.created_at);
    expect(seen).toEqual([{ type: 'note', op: 'created', id: note.id }]);
  });

  it('rejects an empty body unless allowEmpty', async () => {
    await expectNoteError(service.create({ body: '   ' }), 'empty_body');
    const empty = await service.create({ body: '', allowEmpty: true });
    expect(empty.body).toBe('');
    expect(empty.tags).toEqual([]);
  });

  it('uses a caller-chosen id from newId and refuses a taken one', async () => {
    const id = await service.newId();
    const note = await service.create({ id: id.toLowerCase().replace('-', ''), body: 'x' });
    expect(note.id).toBe(id);
    await expectNoteError(service.create({ id, body: 'y' }), 'conflict');
  });

  it('finds notes case-insensitively and without the dash, reporting missing and deleted ids', async () => {
    const a = await service.create({ body: 'alpha' });
    const b = await service.create({ body: 'beta' });
    await service.delete(b.id);
    const res = await service.get([a.id.toLowerCase().replace('-', ''), b.id, 'nope!', 'Z-ZZZ']);
    expect(res.notes.map((n) => n.id)).toEqual([a.id]);
    expect(res.deleted).toEqual([b.id]);
    expect(res.missing).toContain('nope!');
    const withDeleted = await service.get([b.id], { includeDeleted: true });
    expect(withDeleted.notes[0]?.deleted_at).toBeDefined();
    expect(await service.getOne(b.id)).toBeNull();
    expect((await service.getOne(b.id, { includeDeleted: true }))?.id).toBe(b.id);
  });
});

describe('NotesService body changes write revisions in the same transaction', () => {
  it('update keeps the previous body, re-parses tags and emits updated', async () => {
    const n = await service.create({ body: 'first #a' });
    seen.length = 0;
    const u = await service.update(n.id, 'second #b');
    expect(u.body).toBe('second #b');
    expect(u.tags).toEqual(['b']);
    const revs = await service.revisions(n.id);
    expect(revs.map((r) => r.body)).toEqual(['first #a']);
    expect(seen).toEqual([{ type: 'note', op: 'updated', id: n.id }]);
  });

  it('an unchanged update writes no revision and emits nothing', async () => {
    const n = await service.create({ body: 'same' });
    seen.length = 0;
    await service.update(n.id, 'same');
    expect(await revisionCount(n.id)).toBe(0);
    expect(seen).toEqual([]);
  });

  it('update refuses an empty body unless allowEmpty', async () => {
    const n = await service.create({ body: 'x' });
    await expectNoteError(service.update(n.id, ''), 'empty_body');
    const u = await service.update(n.id, '', { allowEmpty: true });
    expect(u.body).toBe('');
  });

  it('append adds after a blank line and keeps a revision', async () => {
    const n = await service.create({ body: 'line one\n' });
    const a = await service.append(n.id, 'line two #agentic');
    expect(a.body).toBe('line one\n\nline two #agentic');
    expect(a.tags).toEqual(['agentic']);
    expect(await revisionCount(n.id)).toBe(1);
  });

  it('delete is soft, keeps the body as a revision, and is idempotent', async () => {
    const n = await service.create({ body: 'to delete' });
    seen.length = 0;
    const d = await service.delete(n.id);
    expect(d.deleted_at).toBeDefined();
    expect(await revisionCount(n.id)).toBe(1);
    await service.delete(n.id);
    expect(await revisionCount(n.id)).toBe(1);
    expect(seen).toEqual([{ type: 'note', op: 'deleted', id: n.id }]);
    await expectNoteError(service.update(n.id, 'nope'), 'deleted');
    await expectNoteError(service.append(n.id, 'nope'), 'deleted');
  });

  it('restore brings a deleted note back and emits restored', async () => {
    const n = await service.create({ body: 'back' });
    await service.delete(n.id);
    seen.length = 0;
    const r = await service.restore(n.id);
    expect(r.deleted_at).toBeUndefined();
    expect(seen).toEqual([{ type: 'note', op: 'restored', id: n.id }]);
    await service.restore(n.id);
    expect(seen).toHaveLength(1);
  });

  it('revert restores a revision body and saves the replaced body as a new revision', async () => {
    const n = await service.create({ body: 'v1 #one' });
    await service.update(n.id, 'v2 #two');
    const [rev] = await service.revisions(n.id);
    expect(rev?.body).toBe('v1 #one');
    const r = await service.revert(n.id, rev!.revision);
    expect(r.body).toBe('v1 #one');
    expect(r.tags).toEqual(['one']);
    const revs = await service.revisions(n.id);
    expect(revs.map((x) => x.body)).toEqual(['v2 #two', 'v1 #one']);
    await expectNoteError(service.revert(n.id, 999999), 'invalid_revision');
  });

  it('a failed transaction leaves no revision behind', async () => {
    const n = await service.create({ body: 'atomic' });
    await expectNoteError(service.revert(n.id, 424242), 'invalid_revision');
    expect(await revisionCount(n.id)).toBe(0);
  });

  it('unknown and invalid ids give not_found and invalid_id', async () => {
    await expectNoteError(service.update('Z-ZZZ', 'x'), 'not_found');
    await expectNoteError(service.delete('Z-ZZZ'), 'not_found');
    await expectNoteError(service.revisions('Z-ZZZ'), 'not_found');
    await expectNoteError(service.update('???', 'x'), 'invalid_id');
  });
});

describe('NotesService list/search/tags', () => {
  it('lists newest first with tag any/all filters and paging', async () => {
    const a = await service.create({ body: 'a #seer #v250' });
    const b = await service.create({ body: 'b #seer' });
    const c = await service.create({ body: 'c #v250' });
    await backdate(a.id, '2026-10-01T10:00:00Z');
    await backdate(b.id, '2026-10-02T10:00:00Z');
    await backdate(c.id, '2026-10-03T10:00:00Z');

    const all = await service.list();
    expect(all.notes.map((n) => n.id)).toEqual([c.id, b.id, a.id]);
    expect(all.next_cursor).toBeNull();

    expect((await service.list({ tagsAny: ['#SEER'] })).notes.map((n) => n.id)).toEqual([b.id, a.id]);
    expect((await service.list({ tagsAll: ['seer', 'v250'] })).notes.map((n) => n.id)).toEqual([a.id]);

    const p1 = await service.list({ limit: 2 });
    expect(p1.notes.map((n) => n.id)).toEqual([c.id, b.id]);
    expect(p1.next_cursor).not.toBeNull();
    const p2 = await service.list({ limit: 2, cursor: p1.next_cursor! });
    expect(p2.notes.map((n) => n.id)).toEqual([a.id]);
    expect(p2.next_cursor).toBeNull();
  });

  it('filters by created or updated date range', async () => {
    const a = await service.create({ body: 'old' });
    const b = await service.create({ body: 'new' });
    await backdate(a.id, '2026-09-01T12:00:00Z');
    await backdate(b.id, '2026-10-20T12:00:00Z');
    const r = await service.list({ from: '2026-10-01T00:00:00Z', to: '2026-10-31T00:00:00Z' });
    expect(r.notes.map((n) => n.id)).toEqual([b.id]);
    const upd = await service.list({ dateField: 'updated', to: '2026-09-02T00:00:00Z' });
    expect(upd.notes.map((n) => n.id)).toEqual([a.id]);
    await expectNoteError(service.list({ from: 'last tuesday' }), 'invalid_input');
  });

  it('filters by hasImage and by deleted state', async () => {
    const text = await service.create({ body: 'text note' });
    const img = await service.create({ body: '', allowEmpty: true, image: { path: 'images/2026/10/x.png', meta: meta('aa') } });
    const gone = await service.create({ body: 'gone' });
    await service.delete(gone.id);
    expect((await service.list({ hasImage: true })).notes.map((n) => n.id)).toEqual([img.id]);
    expect((await service.list({ hasImage: false })).notes.map((n) => n.id)).toEqual([text.id]);
    expect((await service.list({ deleted: 'only' })).notes.map((n) => n.id)).toEqual([gone.id]);
    expect((await service.list({ deleted: 'include' })).notes).toHaveLength(3);
  });

  it('searches with the simple config, ranked, with filters', async () => {
    const a = await service.create({ body: 'pgx connection pool tuning #seer' });
    const b = await service.create({ body: 'pool pool pool notes #v250' });
    await service.create({ body: 'unrelated' });
    const r = await service.search('pool');
    expect(r.notes.map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
    expect(r.notes[0]?.id).toBe(b.id);
    expect((await service.search('pool', { tagsAny: ['seer'] })).notes.map((n) => n.id)).toEqual([a.id]);
    expect((await service.search('pgx')).notes.map((n) => n.id)).toEqual([a.id]);
    expect((await service.search('"connection pool" -redis')).notes.map((n) => n.id)).toEqual([a.id]);
    expect((await service.search('pool', { hasImage: true })).notes).toEqual([]);
    await expectNoteError(service.search('  '), 'invalid_input');
  });

  it('counts tags on live notes with last_used', async () => {
    const a = await service.create({ body: '#seer one' });
    await service.create({ body: '#seer two #v250' });
    const d = await service.create({ body: '#gone' });
    await service.delete(d.id);
    await backdate(a.id, '2026-01-01T00:00:00Z');
    const tags = await service.tags();
    expect(tags.map((t) => [t.tag, t.count])).toEqual([
      ['seer', 2],
      ['v250', 1],
    ]);
    expect(new Date(tags[0]!.last_used).getTime()).toBeGreaterThan(new Date('2026-01-01T00:00:00Z').getTime());
  });
});

describe('NotesService image notes', () => {
  it('computes image.available from the file under dataDir', async () => {
    const rel = 'images/2026/10/present.png';
    mkdirSync(join(dataDir, 'images/2026/10'), { recursive: true });
    writeFileSync(join(dataDir, rel), 'png');
    const here = await service.create({ body: 'shot #ai_image', image: { path: rel, meta: meta('s1') } });
    const away = await service.create({ body: '', allowEmpty: true, image: { path: 'images/2026/10/absent.png', meta: meta('s2') } });
    expect(here.image).toMatchObject({ mime: 'image/png', width: 2, height: 1, host: 'lenovo', available: true });
    expect(away.image?.available).toBe(false);
  });

  it('findBySha256 sees live notes, and deleted ones only when asked', async () => {
    const n = await service.create({ body: '', allowEmpty: true, image: { path: 'images/a.png', meta: meta('dup') } });
    expect((await service.findBySha256('dup'))?.id).toBe(n.id);
    await expectNoteError(
      service.create({ body: '', allowEmpty: true, image: { path: 'images/b.png', meta: meta('dup') } }),
      'duplicate_image',
    );
    await service.delete(n.id);
    expect(await service.findBySha256('dup')).toBeNull();
    const deleted = await service.findBySha256('dup', { includeDeleted: true });
    expect(deleted?.id).toBe(n.id);
    expect(deleted?.deleted_at).toBeDefined();
  });
});
```

### Step 18: Integration test — MCP over the real `/mcp` route
**File:** `tests/integration/mcp.tools.int.test.ts:1`
**Code:**
```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import type { AppDeps } from '../../src/deps.js';
import { createApp } from '../../src/http/app.js';
import { NoteEvents, type NoteEvent } from '../../src/notes/events.js';
import { NotesService } from '../../src/notes/service.js';
import type { Note } from '../../src/notes/types.js';
import { closeTestDb, openTestDb, testDatabaseUrl, truncateAll } from './setup.js';

const url = testDatabaseUrl();
const db = openTestDb();
const dataDir = mkdtempSync(join(tmpdir(), 'notes-mcp-'));
const config: Config = { databaseUrl: url, port: 0, host: '127.0.0.1', dataDir };
const events = new NoteEvents();
const service = new NotesService({ db, dataDir, events });
const deps: AppDeps = { config, db, events, service };
const app: Hono = createApp(deps);
const seen: NoteEvent[] = [];
events.on((e) => seen.push(e));

let client: Client;

/** The real /mcp route, in process: the SDK client's fetch goes straight to app.request. */
async function connect(): Promise<Client> {
  const c = new Client({ name: 'mcp-notes-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    fetch: async (input, init) => app.request(String(input), init),
  });
  await c.connect(transport);
  return c;
}

function text(result: unknown): string {
  const r = result as CallToolResult;
  const first = r.content[0];
  if (!first || first.type !== 'text') throw new Error('expected text content');
  return first.text;
}

async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  if (result.isError) throw new Error(text(result));
  return JSON.parse(text(result)) as T;
}

async function callError(name: string, args: Record<string, unknown>): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  expect(result.isError).toBe(true);
  return text(result);
}

beforeAll(async () => {
  client = await connect();
});

beforeEach(async () => {
  await truncateAll(db);
  seen.length = 0;
});

afterEach(() => {
  seen.length = 0;
});

afterAll(async () => {
  await client.close();
  await closeTestDb(db);
  rmSync(dataDir, { recursive: true, force: true });
});

describe('MCP over the real /mcp route', () => {
  it('exposes the eleven note tools and the server instructions', async () => {
    const { tools } = await client.listTools();
    // arrayContaining, not toEqual: phase 5 adds create_image and view_images to the same server.
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['append', 'create', 'delete', 'get', 'list', 'restore', 'revert', 'revisions', 'search', 'tags', 'update']),
    );
    for (const t of tools) expect(t.description?.length ?? 0).toBeGreaterThan(40);
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('A-B32');
    expect(instructions).toContain('case-insensitive');
    expect(instructions).toMatch(/Comparisons/);
  });

  it('create -> get (case-insensitive, no dash) -> update -> append -> revisions -> revert', async () => {
    const { note } = await call<{ note: Note }>('create', {
      body: 'session insights #seer',
      origin: { cwd: '/home/m/seer', repo: 'seer' },
    });
    expect(note.origin).toEqual({ cwd: '/home/m/seer', repo: 'seer', source: 'mcp' });
    expect(seen).toEqual([{ type: 'note', op: 'created', id: note.id }]);

    const loose = note.id.toLowerCase().replace('-', '');
    const got = await call<{ notes: Note[]; missing: string[]; deleted: string[] }>('get', { ids: [loose] });
    expect(got.notes[0]?.id).toBe(note.id);

    const upd = await call<{ note: Note }>('update', { id: loose, body: 'plain text now #seer #agentic' });
    expect(upd.note.tags).toEqual(['seer', 'agentic']);
    const app2 = await call<{ note: Note }>('append', { id: note.id, text: 'one more line' });
    expect(app2.note.body).toBe('plain text now #seer #agentic\n\none more line');

    const { revisions } = await call<{ revisions: { revision: number; body: string }[] }>('revisions', { id: note.id });
    expect(revisions.map((r) => r.body)).toEqual(['plain text now #seer #agentic', 'session insights #seer']);
    const reverted = await call<{ note: Note }>('revert', { id: note.id, revision: revisions[1]!.revision });
    expect(reverted.note.body).toBe('session insights #seer');
  });

  it('delete, list deleted=only, restore', async () => {
    const { note } = await call<{ note: Note }>('create', { body: 'temp' });
    await call('delete', { id: note.id });
    expect((await call<{ notes: Note[] }>('list')).notes).toEqual([]);
    expect((await call<{ notes: Note[] }>('list', { deleted: 'only' })).notes.map((n) => n.id)).toEqual([note.id]);
    const got = await call<{ deleted: string[] }>('get', { ids: [note.id] });
    expect(got.deleted).toEqual([note.id]);
    await call('restore', { id: note.id });
    expect((await call<{ notes: Note[] }>('list')).notes.map((n) => n.id)).toEqual([note.id]);
  });

  it('list and search filter by tags; tags counts them', async () => {
    await call('create', { body: 'first #v250' });
    await call('create', { body: 'second #v250 #seer pool' });
    await call('create', { body: 'third #seer' });
    const v = await call<{ notes: Note[]; next_cursor: string | null }>('list', { tags_any: ['#v250'], limit: 1 });
    expect(v.notes[0]?.body).toBe('second #v250 #seer pool');
    expect(v.next_cursor).not.toBeNull();
    const s = await call<{ notes: Note[] }>('search', { query: 'pool', tags_all: ['seer', 'v250'] });
    expect(s.notes).toHaveLength(1);
    const { tags } = await call<{ tags: { tag: string; count: number; last_used: string }[] }>('tags');
    expect(tags.map((t) => [t.tag, t.count])).toEqual([
      ['seer', 2],
      ['v250', 2],
    ]);
  });

  it('returns readable errors', async () => {
    expect(await callError('get', { ids: [] })).toMatch(/ids/);
    expect(await callError('create', { body: '' })).toMatch(/body/);
    expect(await callError('update', { id: 'Z-ZZZ', body: 'x' })).toMatch(/^not_found:/);
    expect(await callError('update', { id: '!!', body: 'x' })).toMatch(/^invalid_id:/);
    expect(await callError('list', { from: 'yesterday' })).toMatch(/^invalid_input:/);
  });
});

describe('/mcp HTTP guard and methods', () => {
  it('rejects GET and DELETE with 405', async () => {
    expect((await app.request('http://localhost/mcp', { method: 'GET' })).status).toBe(405);
    expect((await app.request('http://localhost/mcp', { method: 'DELETE' })).status).toBe(405);
  });

  it('rejects a non-loopback Host or Origin with 403', async () => {
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    };
    expect((await app.request('http://evil.example/mcp', init)).status).toBe(403);
    expect((await app.request('http://127.0.0.1:7399/mcp', init)).status).toBe(200);
    const withOrigin = { ...init, headers: { ...init.headers, origin: 'https://evil.example' } };
    expect((await app.request('http://localhost/mcp', withOrigin)).status).toBe(403);
  });

  it('serves /health', async () => {
    const res = await app.request('http://localhost/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'notesd' });
  });
});
```

### Step 19: Integration test — daemon on port 0
**File:** `tests/integration/daemon.int.test.ts:1`
**Code:**
```ts
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDaemon, type RunningDaemon } from '../../src/daemon.js';
import { testDatabaseUrl } from './setup.js';

const url = testDatabaseUrl();

const dataDir = join(mkdtempSync(join(tmpdir(), 'notesd-')), 'data');
let daemon: RunningDaemon;

beforeAll(async () => {
  // Port 0: never the installed daemon's 7317.
  daemon = await startDaemon({ databaseUrl: url, port: 0, host: '127.0.0.1', dataDir });
});

afterAll(async () => {
  await daemon.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('startDaemon', () => {
  it('creates the data dirs', () => {
    for (const sub of ['images', 'cache', 'inbox', 'inbox/failed']) expect(existsSync(join(dataDir, sub))).toBe(true);
  });

  it('listens on 127.0.0.1 and answers /health', async () => {
    expect(daemon.port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${daemon.port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'notesd' });
  });

  it('answers an MCP initialize over real HTTP', async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'curl', version: '0' } },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { serverInfo?: { name?: string }; instructions?: string } };
    expect(body.result?.serverInfo?.name).toBe('mcp-notes');
    expect(body.result?.instructions).toContain('A-B32');
  });

  it('refuses a non-loopback host', async () => {
    await expect(startDaemon({ databaseUrl: url, port: 0, host: '0.0.0.0', dataDir })).rejects.toThrow(/127\.0\.0\.1/);
  });
});
```
**Impact:** binds an ephemeral port on 127.0.0.1 only (invariant 10); data dir under `os.tmpdir()` (invariant 11).

## Verification

**Build:** `npm run typecheck && npm run build`
**Tests:** `npm test && npm run test:int`
**Manual check:**
```bash
npm run build
NOTESD_PORT=7399 NOTES_DATA_DIR=$(mktemp -d) node dist/main.js &
curl -s http://127.0.0.1:7399/health                      # {"ok":true,"service":"notesd"}
curl -s -X POST http://127.0.0.1:7399/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 400   # lists the 11 tools
kill %1                                                    # logs "shutting down", exits 0
```
This run uses the pooled Neon URL `loadConfig` picks from `.env.local` (read-only calls only above). Never use
port 7317.
**Exit criteria:** typecheck, build, unit and int suites green; `node dist/main.js` with
`NOTESD_PORT=7399` serves `/health` and a `/mcp` that lists the eleven tools; `GET /mcp` → 405;
a request with `Host: evil.example` → 403.

## Handoffs

- **Phase 1 (resolved by the reconciler):** phase 1's `vitest.config.ts` sets
  `fileParallelism: !integration`, so int files run serially; names are aligned to phase 1's
  exports (`createDb(url): Db` + `closeDb(db)`, `openTestDb`/`closeTestDb`/`truncateAll`).
- **Phase 4:** dedupe = `service.findBySha256(sha, { includeDeleted: true })`; if `deleted_at` is set,
  `service.restore(id)`; else return it. New image: `id = await service.newId()`, write the file to
  `images/YYYY/MM/<id>.<ext>`, then `service.create({ id, body, origin, image: { path, meta }, allowEmpty: true })`.
  Catch `NoteError('duplicate_image')` (concurrent ingest of the same bytes) and re-run the dedupe
  lookup; on `NoteError('conflict')` delete the written file and retry with a new id. Replace the body
  of `startBackground` in `src/background.ts`.
- **Phase 5:** add `takenFrom`/`takenTo` to `NoteFilter` and `filterConditions` (`src/notes/repo.ts`);
  add `has_image`, `taken_from`, `taken_to` to `noteFilterShape`, `FilterArgs` and `toFilter`
  (`src/mcp/tools.ts`) mapping `has_image` → the existing `hasImage`; append an images paragraph to
  `buildInstructions` sections; fill `registerImageTools` and `imageRoutes`. `ImageMeta` and
  `rowToNote` already produce the final `image` shape.
- **Phase 6:** fill `apiRoutes(deps)` and `staticRoutes(deps)`; use `deps.service` (POST with
  `allowEmpty: true`, PATCH with `{ allowEmpty: true }`, `list({ limit: 2000, hasImage, cursor })`,
  `tags()`), `deps.events.on(...)` for SSE, and map `NoteError.code` to statuses (table in the
  Interface Contract). Use `origin: { source: 'web' }`.
- **Phase 3:** the systemd unit runs `node <repo>/dist/main.js`; the daemon logs one
  "notesd listening on ..." line and exits non-zero on startup failure (good for `Restart=on-failure`).

## Rollback

`git revert` the phase-2 commit(s). Every file is new and only this phase's own; no migration, no
dependency and no config changes to undo. Phases 3–6 depend on it and must be reverted first if
they have landed.
