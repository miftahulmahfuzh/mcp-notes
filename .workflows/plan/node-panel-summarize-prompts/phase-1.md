# Phase 1: Schema 0010 + SessionsRepo summary-request writer

**Plan set:** `NODE_PANEL_SUMMARIZE_PROMPTS_PLAN.md`
**Analysis:** `docs/analyzer/20261103-150033-K7Q2_code_analyzer.md`
**Satisfies:** R1, R2. This phase stores what both features need: the summary request (R1) and the full-prompt side table plus its backfill marker (R2). It adds no user-visible behavior.
**Depends on:** none
**Difficulty:** NORMAL
**Package:** `src/db`, `src/sessions/repo.ts`

---

## Goal

After this phase the database has migration `0010_session_prompts_summary_requests`. It adds `cc_sessions.summary_requested_at`, `cc_sessions.prompts_version` and the empty table `cc_session_prompts`. `SessionsRepo` can record a summary request (`requestSummary`, idempotent, keeps the first request time), drop one (`clearSummaryRequest`), and `setSummary` clears a pending request when a summary lands. Nothing reads the new columns yet and nothing writes `cc_session_prompts` yet. Phases 2, 3 and 5 build on them.

## Interface Contract

**Deletes:** nothing
**Renames:** nothing
**Creates:**
- DB column `cc_sessions.summary_requested_at timestamptz null`, TS `ccSessions.summaryRequestedAt` (`Date | null`) (`src/db/schema.ts`, in `ccSessions` right after `summarizedAt`)
- DB column `cc_sessions.prompts_version integer not null default 0`, TS `ccSessions.promptsVersion` (`number`) (`src/db/schema.ts`, after `summaryRequestedAt`). 0 = legacy excerpts. Phase 3 defines the higher values in `src/sessions/types.ts`: `PROMPTS_VERSION_EXCERPTS = 1` (transcript gone; stored excerpts redacted in place, full text unrecoverable) and `PROMPTS_VERSION = 2` (full + redacted).
- DB table `cc_session_prompts`, TS `ccSessionPrompts` (`src/db/schema.ts`, new `pgTable` placed before `noteSessionLinks`):
  - `session_id text not null references cc_sessions(session_id) on delete cascade` → `sessionId: string`
  - `seq integer not null` → `seq: number`
  - `at timestamptz null` → `at: Date | null`
  - `text text not null` → `text: string`
  - `truncated boolean not null default false` → `truncated: boolean`
  - `primary key (session_id, seq)`, constraint name `cc_session_prompts_session_id_seq_pk`; FK name `cc_session_prompts_session_id_cc_sessions_session_id_fk`. No other index: the PK covers `where session_id = $1 order by seq`.
- Types `CcSessionPromptRow`, `NewCcSessionPromptRow` (`src/db/schema.ts`, end of file), re-exported as types from `src/sessions/types.ts`.
- `SessionRow` (`src/sessions/types.ts`, derived from `CcSessionRow`) gains `summaryRequestedAt: Date | null` and `promptsVersion: number` automatically. `SESSION_COLUMNS` in `repo.ts` therefore returns them. `LIST_COLUMNS` / `SessionListItem` do NOT change.
- Interface `SummaryRequest { requestedAt: Date }` (`src/sessions/types.ts`, after `SummaryInput`)
- `SessionsRepo.requestSummary(sessionId: string): Promise<SummaryRequest | null>` (`src/sessions/repo.ts`). Sets `summary_requested_at` to the repo clock only when it is null, so repeat calls keep the first time. Bumps `updated_at` only when it sets. Returns the stored request time, or `null` when no row has that session id. It does no token, host or summary checks; the caller (Phase 2) decides whether a request is allowed.
- `SessionsRepo.clearSummaryRequest(sessionId: string): Promise<boolean>` (`src/sessions/repo.ts`). Sets `summary_requested_at = null` and bumps `updated_at`, but only when a request is pending. Returns true when a pending request was cleared, false when there was none or no row.
- Migration files `drizzle/0010_session_prompts_summary_requests.sql`, `drizzle/meta/0010_snapshot.json`, journal entry idx 10 tag `0010_session_prompts_summary_requests`, all generated.

**Signature changes:** none. `setSummary(sessionId, input): Promise<boolean>` keeps its signature. Its behavior gains one thing: it also sets `summary_requested_at = null`.
**Requires (from earlier phases):** nothing
**Leaves alone (owned by others):**
- `src/sessions/summaryWorker.ts`, `src/sessions/readModel.ts`, `src/sessions/view.ts`, `src/http/sessionsApi.ts` (Phase 2)
- `src/sessions/ingest.ts`, `src/sessions/transcript.ts`, `src/sessions/merge.ts`, `upsertFromTranscript` and every `cc_session_prompts` write, prompt constants in `types.ts`, `tests/fixtures/**` (Phase 3)
- `web/**`, `.claude/skills/verify-notesd/features/projects.md` (Phases 4, 5)

## Files

| File | Action | What changes |
|---|---|---|
| `src/db/schema.ts` | modify | import `boolean` (L2-18); header comment gains a 0010 line (L36-37); `ccSessions` doc (L479-487); `prompts` column comment (L523); two columns after `summarizedAt` (L532); new `ccSessionPrompts` table before `noteSessionLinks` (L585); row types (L687) |
| `drizzle/0010_session_prompts_summary_requests.sql` | create (generated) | `npm run db:generate -- --name session_prompts_summary_requests` |
| `drizzle/meta/0010_snapshot.json` | create (generated) | same command |
| `drizzle/meta/_journal.json` | modify (generated) | entry idx 10 |
| `src/sessions/types.ts` | modify | re-export the prompt row types (L10); `SummaryRequest` after `SummaryInput` (L272-277) |
| `src/sessions/repo.ts` | modify | import `SummaryRequest` (L12-44); class doc comment (L128-132); `setSummary` clears the request (L597-606); new `requestSummary`, `clearSummaryRequest` right after `setSummary` |
| `tests/helpers/memoryIngestStore.ts` | modify | `blankSessionRow` gains the two new fields (L58), otherwise typecheck fails |
| `tests/unit/sessions/merge.test.ts` | modify | `blankRow` gains the two new fields (L44), otherwise typecheck fails |
| `tests/integration/setup.ts` | modify | `truncateAll` lists `cc_session_prompts` (L50) |
| `tests/integration/migration0010.int.test.ts` | create | 0010 on a 0009 database with data: one migration applied, old rows unchanged, new columns, table, PK, FK cascade |
| `tests/integration/sessions.repo.int.test.ts` | modify | new `describe('summary requests')` after `describe('summaries and embeddings')` (ends before L390-ish; insert after that block's closing `})`) |

## Implementation Steps

### Step 0: Workspace prerequisite
**File:** none
**Change:** The worktree has no `node_modules` and no `.env.local`. Run `npm ci` in `/home/miftah/.worktrees/mcp-notes/node-panel-summarize-prompts` before anything else. `drizzle.config.ts` throws when it finds no direct (non `-pooler`) URL, even for `generate`, which never connects. Step 2 therefore passes a dummy URL instead of copying the user's real `.env.local` into the worktree.
**Impact:** none on the tree.

### Step 1: Schema: two columns on `cc_sessions`, the `cc_session_prompts` table
**File:** `src/db/schema.ts`

1a. Import list (L2-18). Add `boolean` after `bigserial`:
```ts
import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from 'drizzle-orm/pg-core'
```

1b. Header comment (L36-37). Replace the two 0009 lines
```ts
 * Migration 0009 (session note links) adds `note_session_links`; src/notes/sessionLinks.ts,
 * called only by NotesService, is its only writer.
```
with
```ts
 * Migration 0009 (session note links) adds `note_session_links`; src/notes/sessionLinks.ts,
 * called only by NotesService, is its only writer.
 * Migration 0010 (node panel: summarize on demand, full prompts) adds
 * `cc_sessions.summary_requested_at`, `cc_sessions.prompts_version` and `cc_session_prompts`;
 * src/sessions/repo.ts is their only writer.
```

1c. `ccSessions` doc comment (L479-487). Replace the whole block comment above `export const ccSessions` with:
```ts
/**
 * One row per Claude Code session (migration 0007), keyed by Claude Code's session UUID. Written
 * only by src/sessions/repo.ts: the transcript ingester fills most columns, the SessionStart hook
 * fills `name`/`tmux`/parent early, the summarizer fills `summary*`, the node panel's Summarize
 * button sets `summary_requested_at` (migration 0010). `node_id` (`A0-3G`, see
 * src/sessions/ids.ts) is assigned on first insert and never changes. `host` is the machine that
 * holds the transcript (`os.hostname()`); transcript reads and resume work only there.
 * `parent_session_id` has no foreign key: the parent may not be ingested yet.
 * `transcript_offset` is the byte offset just after the last complete JSONL line consumed.
 */
```

1d. In `ccSessions`, right after `summarizedAt` (L532) and before the `/** Full text (`simple`) …` comment of `searchTsv`, insert:
```ts
    /**
     * When someone asked for a summary of this session (the node panel's Summarize button,
     * migration 0010). Set once and kept on repeat requests; cleared when a summary is stored
     * (`SessionsRepo.setSummary`) or the request is dropped (`clearSummaryRequest`). Only the
     * owning host's summary worker serves it.
     */
    summaryRequestedAt: timestamp('summary_requested_at', { withTimezone: true, mode: 'date' }),
    /**
     * Which prompt storage this row's prompts follow (migration 0010). 0 = legacy: `prompts`
     * holds truncated, unredacted excerpts and `cc_session_prompts` is empty. Higher versions are
     * defined by src/sessions/types.ts; the owning host's backfill raises it once.
     */
    promptsVersion: integer('prompts_version').notNull().default(0),
```

1e. New table. Insert directly above the `/** An explicit link from an existing note …` comment of `noteSessionLinks` (L585):
```ts
/**
 * Every typed prompt of a session in full, redacted (migration 0010), one row per prompt in
 * transcript order (`seq` from 1, no gaps). `cc_sessions.prompts` stays the bounded excerpt list that
 * feeds full text, the summarizer and the embed text; this table is read only where the full
 * list is shown, never by the graph or the summary worker. `text` is stored only after
 * src/sessions/redact.ts `redactSecrets`; `truncated` marks a prompt cut at the sanity ceiling.
 * Written only by src/sessions/repo.ts. Removing the session drops its prompts.
 */
export const ccSessionPrompts = pgTable(
  'cc_session_prompts',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => ccSessions.sessionId, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    at: timestamp('at', { withTimezone: true, mode: 'date' }),
    text: text('text').notNull(),
    truncated: boolean('truncated').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] })],
)

```

1g. The `prompts` column comment in `ccSessions` (L523). Replace
```ts
    /** Human prompts, oldest first, capped (src/sessions/types.ts MAX_PROMPTS / MAX_PROMPT_CHARS). */
```
with
```ts
    /**
     * Human prompts, oldest first: the excerpt list, capped and redacted (src/sessions/types.ts
     * MAX_PROMPTS / MAX_PROMPT_CHARS). The full list is `cc_session_prompts`.
     */
```
(Reconciler: Phase 3 asked for this comment; `schema.ts` is Phase 1's file, so it lands here. Comment only, the generated SQL in Step 2 is unaffected.)

1f. Row types (L687). After `export type CcSessionEmbeddingRow = typeof ccSessionEmbeddings.$inferSelect` add:
```ts
export type CcSessionPromptRow = typeof ccSessionPrompts.$inferSelect
export type NewCcSessionPromptRow = typeof ccSessionPrompts.$inferInsert
```
**Impact:** `SessionRow` gains two required fields, so every hand-built `SessionRow` literal must add them (Step 5). Raw-SQL readers (`summaryWorker`, `readModel`, `links`) select named columns and are unaffected.

### Step 2: Generate migration 0010
**File:** `drizzle/0010_session_prompts_summary_requests.sql`, `drizzle/meta/0010_snapshot.json`, `drizzle/meta/_journal.json`
**Change:** generate, never hand-write. Earlier migrations were generated with a descriptive `--name` (`0008_subagent_transcripts`, `0009_note_session_links`) and none of 0007-0009 was hand-edited.
```sh
cd /home/miftah/.worktrees/mcp-notes/node-panel-summarize-prompts
DATABASE_URL_UNPOOLED=postgres://u:p@127.0.0.1:1/unused npm run db:generate -- --name session_prompts_summary_requests
DATABASE_URL_UNPOOLED=postgres://u:p@127.0.0.1:1/unused npm run db:check
```
**Code:** the expected SQL. I ran this exact schema change through `drizzle-kit generate` (0.31.10) in a scratch copy, and the output must match it byte for byte:
```sql
CREATE TABLE "cc_session_prompts" (
	"session_id" text NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone,
	"text" text NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	CONSTRAINT "cc_session_prompts_session_id_seq_pk" PRIMARY KEY("session_id","seq")
);
--> statement-breakpoint
ALTER TABLE "cc_sessions" ADD COLUMN "summary_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cc_sessions" ADD COLUMN "prompts_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cc_session_prompts" ADD CONSTRAINT "cc_session_prompts_session_id_cc_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."cc_sessions"("session_id") ON DELETE cascade ON UPDATE no action;
```
If the generator emits anything else, such as a change to another table, the schema has drifted. Stop and investigate. Do not hand-edit the SQL. The journal gains `{ "idx": 10, "version": "7", "when": <generated>, "tag": "0010_session_prompts_summary_requests", "breakpoints": true }`.
**Impact:** additive only. `ADD COLUMN … DEFAULT 0 NOT NULL` is a metadata-only change on PG ≥ 11 (Neon, the pgvector:pg16 test containers), with no table rewrite. Existing rows read `prompts_version = 0` and `summary_requested_at = null`. Apply it to Neon with `npm run db:migrate` from `/home/miftah/mcp-notes` only after the set lands. That is the landing step, not this phase.

### Step 3: Types
**File:** `src/sessions/types.ts`

3a. L10. Replace
```ts
export type { ModelUsage, ParentLinkSource, SessionCommit, SessionPrompt } from '../db/schema.js';
```
with
```ts
export type {
  CcSessionPromptRow,
  ModelUsage,
  NewCcSessionPromptRow,
  ParentLinkSource,
  SessionCommit,
  SessionPrompt,
} from '../db/schema.js';
```

3b. After `export interface SummaryInput { … }` (L272-277) insert:
```ts
/** A pending summary request (`cc_sessions.summary_requested_at`): when it was first made. */
export interface SummaryRequest {
  requestedAt: Date;
}
```
**Impact:** additive. Phase 3 adds its own constants to this file in other places (prompt ceiling, `PROMPTS_VERSION`). Neither phase touches the other's lines.

### Step 4: SessionsRepo: doc comment, `setSummary`, `requestSummary`, `clearSummaryRequest`
**File:** `src/sessions/repo.ts`

4a. Import block (L12-44). Add `type SummaryRequest,` immediately after `type SummaryInput,`:
```ts
  type SummaryInput,
  type SummaryRequest,
  type TranscriptOffset,
```

4b. Class doc comment (L128-132). Replace
```ts
/**
 * The only writer of `cc_sessions`, `cc_session_embeddings`, `cc_pending_spawns` and
 * `app_settings`. Ingest (Phase 3), the heuristic linker (Phase 4), the hook endpoints
 * (Phase 5), the summarizer (Phase 6) and the read API (Phase 7) all go through it.
 */
```
with
```ts
/**
 * The only writer of `cc_sessions`, `cc_session_prompts`, `cc_subagent_transcripts`,
 * `cc_session_embeddings`, `cc_pending_spawns` and `app_settings`. Ingest, the heuristic linker,
 * the hook endpoints, the summary worker, the Summarize request route and the read API all go
 * through it; nothing else writes these tables.
 */
```

4c. Replace the whole `setSummary` method (L597-606) and add the two new methods right after it, before `/** Stores a vector (clearing any failure). …` of `saveEmbedding`:
```ts
  /**
   * Stores a summary and clears any pending summary request (`summary_requested_at`): the
   * request is served. False when the session has no row.
   */
  async setSummary(sessionId: string, input: SummaryInput): Promise<boolean> {
    const at = input.at ?? this.now();
    const rows = await this.db
      .update(ccSessions)
      .set({ summary: input.summary, summarySha: input.sha, summarizedAt: at, summaryRequestedAt: null, updatedAt: this.now() })
      .where(eq(ccSessions.sessionId, sessionId))
      .returning({ id: ccSessions.sessionId });
    return rows.length > 0;
  }

  /**
   * Records that someone wants this session summarized. Idempotent: the first request time is
   * kept, and only that first call bumps `updated_at`. Never calls a summarizer; the owning
   * host's summary worker serves the request. Null when the session has no row. Whether a
   * request makes sense (an empty session, one already summarized) is the caller's decision.
   */
  async requestSummary(sessionId: string): Promise<SummaryRequest | null> {
    const now = this.now().toISOString();
    const rows = await this.db
      .update(ccSessions)
      .set({
        summaryRequestedAt: sql`coalesce(${ccSessions.summaryRequestedAt}, ${now}::timestamptz)`,
        updatedAt: sql`case when ${ccSessions.summaryRequestedAt} is null then ${now}::timestamptz else ${ccSessions.updatedAt} end`,
      })
      .where(eq(ccSessions.sessionId, sessionId))
      .returning({ requestedAt: ccSessions.summaryRequestedAt });
    const row = rows[0];
    if (!row) return null;
    if (row.requestedAt === null) throw new Error(`summary request on ${sessionId} was not stored`);
    return { requestedAt: row.requestedAt };
  }

  /**
   * Drops a pending summary request without storing a summary (e.g. the session has nothing to
   * summarize). True when a pending request was cleared; false when there was none or no row.
   */
  async clearSummaryRequest(sessionId: string): Promise<boolean> {
    const rows = await this.db
      .update(ccSessions)
      .set({ summaryRequestedAt: null, updatedAt: this.now() })
      .where(and(eq(ccSessions.sessionId, sessionId), isNotNull(ccSessions.summaryRequestedAt)))
      .returning({ id: ccSessions.sessionId });
    return rows.length > 0;
  }
```
Notes for the implementer:
- `and`, `eq`, `isNotNull`, `sql` are already imported from `drizzle-orm` (L2). Nothing new to import from it.
- In an `UPDATE … SET`, Postgres evaluates every right-hand side against the old row, so the `case` in `updatedAt` sees the pre-update `summary_requested_at`. Drizzle renders a column inside `sql` in `.set()` qualified (`"cc_sessions"."summary_requested_at"`). That is valid in a SET expression, and `src/notes/imageRepo.ts:156` already uses the same `coalesce(${col}, …)` pattern.
- The time goes in as an ISO string with `::timestamptz`, the pattern `listByName` already uses (L557-558), so the injected test clock decides it, not the DB's `now()`.
- `setSummary` clears the request unconditionally. If a request comes in while the worker is mid-summary, it is served by that summary. Phase 2's worker is the only `setSummary` caller.

**Impact:** `setSummary` now also nulls `summary_requested_at`. Its existing callers (`summaryWorker.ts` `dbSummaryStore.saveSummary`) need no change.

### Step 5: Hand-built `SessionRow` literals
**File:** `tests/helpers/memoryIngestStore.ts:58` and `tests/unit/sessions/merge.test.ts:44`
**Change:** both functions build a complete `SessionRow` and stop compiling once the type gains the two fields. In each, replace the line
```ts
    summarizedAt: null,
```
with
```ts
    summarizedAt: null,
    summaryRequestedAt: null,
    promptsVersion: 0,
```
Both files use the same indentation (4 spaces). No other line changes.
**Impact:** typecheck only. Phase 3 (sequential, after this phase) also edits `merge.test.ts` and `memoryIngestStore.ts`; its plan quotes these files with the two lines already in place and does not touch `blankRow` / `blankSessionRow`.

### Step 6: Integration test setup truncates the new table
**File:** `tests/integration/setup.ts:50`
**Change:** replace the `truncateAll` statement with:
```ts
  await db.execute(sql`truncate table note_session_links, cc_session_prompts, cc_subagent_transcripts, cc_session_embeddings, cc_pending_spawns, cc_sessions, app_settings, chat_message_attachments, chat_message_revisions, chat_messages, chat_threads, note_image_embeddings, chat_images, note_files, note_images, note_embeddings, note_revisions, notes restart identity cascade`)
```
**Impact:** `cascade` already reached the table through its FK. Listing it states the intent.

### Step 7: Migration test (0010 on a populated 0009 database)
**File:** `tests/integration/migration0010.int.test.ts` (new)
**Code:**
```ts
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, createDb, type Db } from '../../src/db/client.js';
import { MIGRATIONS_DIR, testDatabaseUrl } from './setup.js';

/**
 * Migration 0010 on a 0009-shaped database that already holds sessions: it adds
 * `cc_sessions.summary_requested_at`, `cc_sessions.prompts_version` and `cc_session_prompts`,
 * and changes nothing else. Runs in its own database inside the Docker container.
 */

const DB_PREFIX = 'mcp_notes_mig0010_';

type Journal = { entries: Array<{ idx: number; tag: string }> } & Record<string, unknown>;

function urlForDatabase(name: string): string {
  const u = new URL(testDatabaseUrl());
  u.pathname = `/${name}`;
  return u.toString();
}

async function dropStaleDatabases(admin: Db): Promise<void> {
  const res = await admin.execute<{ datname: string }>(sql`select datname from pg_database where starts_with(datname, ${DB_PREFIX})`);
  for (const row of res.rows) await admin.execute(sql.raw(`drop database if exists "${row.datname}" with (force)`));
}

/** A migrations folder holding the journal entries with idx <= maxIdx. */
async function migrationsUpTo(maxIdx: number): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `mcp-notes-mig0010-${maxIdx}-`));
  await mkdir(path.join(dir, 'meta'));
  const journal = JSON.parse(await readFile(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as Journal;
  const kept = journal.entries.filter((e) => e.idx <= maxIdx);
  if (kept.length !== maxIdx + 1) throw new Error(`drizzle/meta/_journal.json lacks entries 0..${maxIdx}`);
  if (maxIdx >= 10 && kept[10]?.tag !== '0010_session_prompts_summary_requests') {
    throw new Error('journal entry 10 is not 0010_session_prompts_summary_requests');
  }
  await writeFile(path.join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: kept }, null, 2));
  for (const e of kept) await copyFile(path.join(MIGRATIONS_DIR, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  return dir;
}

function pgErrorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  while (cur && typeof cur === 'object') {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return pgErrorCode(err);
  }
}

describe('migration 0010 (summary requests, full prompts)', () => {
  const dbName = `${DB_PREFIX}${process.pid}_${randomBytes(4).toString('hex')}`;
  let admin: Db;
  let mig: Db;
  const dirs: string[] = [];
  let before: unknown[];

  beforeAll(async () => {
    admin = createDb(testDatabaseUrl());
    await dropStaleDatabases(admin);
    await admin.execute(sql.raw(`create database "${dbName}"`));
    mig = createDb(urlForDatabase(dbName));

    const upTo9 = await migrationsUpTo(9);
    dirs.push(upTo9);
    await migrate(mig, { migrationsFolder: upTo9 });

    await mig.execute(sql`insert into cc_sessions
      (session_id, node_id, host, repo, first_prompt, last_prompt, input_tokens, prompts, summary, summary_sha, summarized_at)
      values
      ('s-1', 'A0-3G', 'pc', 'mcp-notes', 'why does resume break', 'ship it', 1200,
       '[{"text":"why does resume break","at":"2026-11-01T10:00:00.000Z"},{"text":"ship it","at":null}]'::jsonb,
       'Fixed resume', 'sha-1', '2026-11-01T11:00:00Z'),
      ('s-2', 'B1-4H', 'GPD', 'seer', null, null, 0, '[]'::jsonb, null, null, null)`);
    before = (await mig.execute(sql`select to_jsonb(s) as j from cc_sessions s order by session_id`)).rows;

    const upTo10 = await migrationsUpTo(10);
    dirs.push(upTo10);
    await migrate(mig, { migrationsFolder: upTo10 });
  });

  afterAll(async () => {
    if (mig) await closeDb(mig);
    if (admin) {
      await admin.execute(sql.raw(`drop database if exists "${dbName}" with (force)`));
      await closeDb(admin);
    }
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it('applies exactly one migration on top of 0000-0009', async () => {
    const res = await mig.execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    expect(res.rows[0]?.n).toBe(11);
  });

  it('leaves every existing session column as it was', async () => {
    const after = await mig.execute(
      sql`select to_jsonb(s) - 'summary_requested_at' - 'prompts_version' as j from cc_sessions s order by session_id`,
    );
    expect(after.rows).toEqual(before);
  });

  it('gives existing sessions no request and the legacy prompts version', async () => {
    const res = await mig.execute<{ session_id: string; summary_requested_at: unknown; prompts_version: number }>(
      sql`select session_id, summary_requested_at, prompts_version from cc_sessions order by session_id`,
    );
    expect(res.rows).toEqual([
      { session_id: 's-1', summary_requested_at: null, prompts_version: 0 },
      { session_id: 's-2', summary_requested_at: null, prompts_version: 0 },
    ]);
  });

  it('adds the two cc_sessions columns with the planned types and defaults', async () => {
    const res = await mig.execute<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(sql`
      select column_name, data_type, is_nullable, column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'cc_sessions' and column_name in ('summary_requested_at', 'prompts_version')
      order by column_name
    `);
    expect(res.rows).toEqual([
      { column_name: 'prompts_version', data_type: 'integer', is_nullable: 'NO', column_default: '0' },
      { column_name: 'summary_requested_at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
    ]);
  });

  it('creates cc_session_prompts with the planned columns, defaults and primary key', async () => {
    const cols = await mig.execute<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(sql`
      select column_name, data_type, is_nullable, column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'cc_session_prompts' order by ordinal_position
    `);
    expect(cols.rows).toEqual([
      { column_name: 'session_id', data_type: 'text', is_nullable: 'NO', column_default: null },
      { column_name: 'seq', data_type: 'integer', is_nullable: 'NO', column_default: null },
      { column_name: 'at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
      { column_name: 'text', data_type: 'text', is_nullable: 'NO', column_default: null },
      { column_name: 'truncated', data_type: 'boolean', is_nullable: 'NO', column_default: 'false' },
    ]);
    const idx = await mig.execute<{ indexname: string }>(
      sql`select indexname from pg_indexes where schemaname = 'public' and tablename = 'cc_session_prompts' order by indexname`,
    );
    expect(idx.rows.map((r) => r.indexname)).toEqual(['cc_session_prompts_session_id_seq_pk']);
    const n = await mig.execute<{ n: number }>(sql`select count(*)::int as n from cc_session_prompts`);
    expect(n.rows[0]?.n).toBe(0);
  });

  it('keys prompts by (session, seq), requires text and a known session, and cascades on session delete', async () => {
    await mig.execute(sql`insert into cc_session_prompts (session_id, seq, at, text) values ('s-2', 0, now(), 'first'), ('s-2', 1, null, 'second')`);
    const t = await mig.execute<{ truncated: boolean }>(sql`select truncated from cc_session_prompts where session_id = 's-2' and seq = 0`);
    expect(t.rows[0]?.truncated).toBe(false);
    expect(await codeOf(mig.execute(sql`insert into cc_session_prompts (session_id, seq, text) values ('s-2', 1, 'dup')`))).toBe('23505');
    expect(await codeOf(mig.execute(sql`insert into cc_session_prompts (session_id, seq, text) values ('s-2', 2, null)`))).toBe('23502');
    expect(await codeOf(mig.execute(sql`insert into cc_session_prompts (session_id, seq, text) values ('nope', 0, 'x')`))).toBe('23503');
    await mig.execute(sql`delete from cc_sessions where session_id = 's-2'`);
    const n = await mig.execute<{ n: number }>(sql`select count(*)::int as n from cc_session_prompts`);
    expect(n.rows[0]?.n).toBe(0);
  });
});
```
**Impact:** new test file only. It uses its own database name prefix, so it runs alongside `migration0004`.

### Step 8: Repo integration tests for summary requests
**File:** `tests/integration/sessions.repo.int.test.ts`. Insert a new `describe` block directly after the closing `})` of `describe('summaries and embeddings', …)` (that block starts at L361). The file uses no semicolons, so match that.
**Code:**
```ts
  describe('summary requests', () => {
    function clockedRepo(start: Date): { repo: SessionsRepo; set: (d: Date) => void } {
      let clock = start
      return { repo: new SessionsRepo(db, { now: () => clock }), set: (d) => { clock = d } }
    }

    it('records the first request time and keeps it on repeat requests', async () => {
      const c = clockedRepo(at(0))
      await c.repo.ensureSession('s-1', HOST)
      c.set(at(5))
      expect(await c.repo.requestSummary('s-1')).toEqual({ requestedAt: at(5) })
      c.set(at(9))
      expect(await c.repo.requestSummary('s-1')).toEqual({ requestedAt: at(5) })
      const row = await c.repo.getBySessionId('s-1')
      expect(row?.summaryRequestedAt).toEqual(at(5))
      expect(row?.updatedAt).toEqual(at(5))
    })

    it('returns null for a session with no row and creates none', async () => {
      expect(await repo.requestSummary('missing')).toBeNull()
      expect(await repo.getBySessionId('missing')).toBeNull()
    })

    it('changes nothing but the request columns', async () => {
      const c = clockedRepo(at(0))
      await c.repo.upsertFromTranscript(
        patch('s-1', { repo: 'mcp-notes', entrypoint: 'cli', firstPrompt: 'why does resume break', tokens: { inputTokens: 40 }, lastActiveAt: at(1) }),
      )
      await c.repo.setSummary('s-1', { summary: 'Fixed resume', sha: 'h1', at: at(2) })
      const before = await c.repo.getBySessionId('s-1')
      c.set(at(7))
      await c.repo.requestSummary('s-1')
      const after = await c.repo.getBySessionId('s-1')
      expect(after).toEqual({ ...before, summaryRequestedAt: at(7), updatedAt: at(7) })
      expect(after?.promptsVersion).toBe(0)
    })

    it('setSummary clears a pending request', async () => {
      const c = clockedRepo(at(0))
      await c.repo.ensureSession('s-1', HOST)
      await c.repo.requestSummary('s-1')
      c.set(at(3))
      expect(await c.repo.setSummary('s-1', { summary: 'Summary so far', sha: 'h2' })).toBe(true)
      expect(await c.repo.getBySessionId('s-1')).toMatchObject({ summary: 'Summary so far', summarizedAt: at(3), summaryRequestedAt: null })
    })

    it('clearSummaryRequest drops a pending request and reports whether there was one', async () => {
      const c = clockedRepo(at(0))
      await c.repo.ensureSession('s-1', HOST)
      expect(await c.repo.clearSummaryRequest('s-1')).toBe(false)
      await c.repo.requestSummary('s-1')
      c.set(at(4))
      expect(await c.repo.clearSummaryRequest('s-1')).toBe(true)
      const row = await c.repo.getBySessionId('s-1')
      expect(row?.summaryRequestedAt).toBeNull()
      expect(row?.updatedAt).toEqual(at(4))
      expect(await c.repo.clearSummaryRequest('s-1')).toBe(false)
      expect(await c.repo.clearSummaryRequest('missing')).toBe(false)
      c.set(at(6))
      expect(await c.repo.requestSummary('s-1')).toEqual({ requestedAt: at(6) })
    })

    it('a request on another host\'s session is stored as is (the owning host serves it)', async () => {
      await repo.ensureSession('s-gpd', 'GPD')
      const req = await repo.requestSummary('s-gpd')
      expect(req?.requestedAt).toBeInstanceOf(Date)
      expect((await repo.getBySessionId('s-gpd'))?.host).toBe('GPD')
    })
  })
```
Notes:
- `patch` is the file's existing helper (L23-32). The test deliberately passes no `prompts`, so the test does not depend on the prompt-entry shape Phase 3 may change.
- `tokens: { inputTokens: 40 }` uses `TranscriptPatch.tokens: Partial<TokenCounts>`, as the existing tests in this file do.
**Impact:** test only.

## Principles applied

- Laziness protocol: no index on `summary_requested_at`. The worker query in Phase 2 already filters by `host` (`cc_sessions_host_idx`), the table is ~1.2k rows, and the PK of `cc_session_prompts` already serves the only read it gets (by session, ordered by seq), so no extra index there either.
- Make illegal states unrepresentable: `prompts_version` is `not null default 0`, not nullable, so "not backfilled" has exactly one encoding. Uniqueness of a prompt position is enforced by the PK `(session_id, seq)`, and a prompt can't outlive its session (FK `on delete cascade`). The "request served" state transition lives inside `setSummary` itself, not in a second call the worker might forget.
- Boundary discipline: `requestSummary` does no 0-token or host check. The HTTP route in Phase 2 is the boundary that decides 409 `empty_session`. The repo only stores the request, and its doc comment says so.
- Prove it works: besides the int tests, Proof drives the real migrated database of a verify-notesd daemon. It checks the fixture sessions there ingested with the new columns and calls the new repo methods against that database.
- Build the lever: the migration SQL is generated (`npm run db:generate --name …`) and checked with `db:check`, and its expected output is pinned in Step 2 from a real scratch run, so a reviewer reruns the generator instead of reading SQL by eye.

## Verification

**Build:** `cd /home/miftah/.worktrees/mcp-notes/node-panel-summarize-prompts && npm ci && npm run typecheck`
**Tests:** `npm test` (unit, must stay green; only the two row literals changed) and `npm run test:int` (Docker pgvector; includes the new `migration0010.int.test.ts` and the `summary requests` block). Single files: `npm run test:int -- tests/integration/migration0010.int.test.ts tests/integration/sessions.repo.int.test.ts`.
**Proof:**
- Harness: `.claude/skills/verify-notesd`. Phase 1 has no route or UI, so the journeys read the run's real migrated database and call the new repo methods against it.
- Feature-map entries: none. This phase is not user-facing; Phases 4 and 5 update `features/projects.md`.
- Journeys (run from the worktree root; `V=.claude/skills/verify-notesd/scripts/verify.sh`; `npm ci` first if `node_modules` is missing):
  1. **Migration applied on a fresh daemon DB, fixture sessions ingested with the new columns.**
     ```sh
     V=.claude/skills/verify-notesd/scripts/verify.sh
     $V up --sessions                      # note RUN= and URL=
     $V doctor $RUN
     curl -sf --retry 30 --retry-delay 1 --retry-all-errors "$URL/api/projects/mcp-notes/sessions" >/dev/null
     $V sql $RUN "select count(*)::int as migrations from drizzle.__drizzle_migrations"
     $V sql $RUN "select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'cc_sessions' and column_name in ('summary_requested_at','prompts_version') order by 1"
     $V sql $RUN "select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'cc_session_prompts' order by ordinal_position"
     $V sql $RUN "select count(*)::int as sessions, count(*) filter (where prompts_version = 0)::int as v0, count(*) filter (where summary_requested_at is null)::int as unrequested from cc_sessions"
     $V sql $RUN "select count(*)::int as n from cc_session_prompts"
     ```
     Pass: `migrations` = 11. The two `cc_sessions` columns are `prompts_version integer NO 0` and `summary_requested_at timestamp with time zone YES null`. `cc_session_prompts` lists `session_id, seq, at, text, truncated` in that order, with `truncated` defaulting to `false`. `sessions` > 0 and `sessions = v0 = unrequested`. `cc_session_prompts` has n = 0, because Phase 1 writes no prompt rows.
  2. **Repo methods against the daemon's real DB.** Write the script below to a scratch file outside the repo (`P=$(mktemp -d)/p1-proof.mts`), and run it from the worktree root:
     ```ts
     const wt = process.env.WT!
     const { createDb, closeDb } = await import(`${wt}/src/db/client.ts`)
     const { SessionsRepo } = await import(`${wt}/src/sessions/repo.ts`)
     const db = createDb(process.env.DATABASE_URL!)
     const repo = new SessionsRepo(db)
     const sid = process.env.SID!
     const first = await repo.requestSummary(sid)
     const again = await repo.requestSummary(sid)
     const missing = await repo.requestSummary('no-such-session')
     console.log(JSON.stringify({ first, sameTime: first?.requestedAt.getTime() === again?.requestedAt.getTime(), missing }))
     await repo.setSummary(sid, { summary: 'phase-1 proof summary', sha: 'phase-1-proof' })
     console.log(JSON.stringify({ requestAfterSetSummary: (await repo.getBySessionId(sid))?.summaryRequestedAt ?? null }))
     await repo.requestSummary(sid)
     console.log(JSON.stringify({ cleared: await repo.clearSummaryRequest(sid), clearedAgain: await repo.clearSummaryRequest(sid) }))
     await closeDb(db)
     ```
     ```sh
     WT=$PWD
     DB=$(cat ~/.local/state/notesd-verify/$RUN/db)
     SID=$(curl -sf "$URL/api/projects/mcp-notes/sessions" | jq -r '.nodes[0].session_id')
     WT=$WT SID=$SID DATABASE_URL="postgres://postgres:mcpnotes@127.0.0.1:55436/$DB" node_modules/.bin/tsx "$P" | tee /dev/stderr
     $V sql $RUN "select summary, summary_requested_at from cc_sessions where session_id = '$SID'"
     $V note $RUN "phase 1: requestSummary idempotent, setSummary clears the request, clearSummaryRequest true then false, against the run DB"
     ```
     Pass: line 1 has `first.requestedAt` as an ISO time, `sameTime: true` and `missing: null`. Line 2 is `{"requestAfterSetSummary":null}`. Line 3 is `{"cleared":true,"clearedAgain":false}`. The final `sql` shows `summary = 'phase-1 proof summary'` and `summary_requested_at` null.
- Neighbor check: session detail and graph still read the rows after the type and columns changed. With the same run:
  ```sh
  NODE=$(curl -sf "$URL/api/projects/mcp-notes/sessions" | jq -r '.nodes[0].node_id')
  $V api $RUN GET /api/projects
  $V api $RUN GET "/api/sessions/$NODE"
  $V down $RUN
  ```
  Pass: `/api/projects` returns 200 listing `mcp-notes` and `wall-editing`. `/api/sessions/$NODE` returns 200 with `summary` = `phase-1 proof summary`, the summary written in journey 2, read back through the unchanged read path. `down` completes.
**Exit criteria:** `npm run typecheck`, `npm test` and `npm run test:int` pass. `drizzle/0010_session_prompts_summary_requests.sql` matches the SQL in Step 2. `db:check` is clean. All three Proof journeys pass with their evidence under `~/.local/state/notesd-verify/<RUN>/evidence/`.

## Handoffs

- **Phase 2 (R1):** reads `summary_requested_at` in its worker query, `listRequested`, and in `DETAIL_SELECT`. It calls `repo.requestSummary(sessionId)` from the POST route. That method returns `{ requestedAt: Date } | null`; null means 404, and the 0-token 409 check is Phase 2's. It calls `repo.clearSummaryRequest(sessionId)` when `buildSummaryInput` is null, and relies on `setSummary` clearing the request (no extra call needed). If Phase 2 wants an index for `listRequested`, it would need a second migration (0011). Phase 1 deliberately adds none.
- **Phase 3 (R2):** owns every `cc_session_prompts` write, `PROMPTS_VERSION_EXCERPTS` / `PROMPTS_VERSION`, and setting `prompts_version`. Seq numbering starts at 1 (the schema comment says so). Its `mergeTranscriptPatch` `TranscriptSet` must not include `summaryRequestedAt`, because an ingest must never clear a pending request. It should keep the two new lines in `tests/unit/sessions/merge.test.ts` `blankRow` and `tests/helpers/memoryIngestStore.ts` `blankSessionRow`. A Phase 3 backfill candidate query can filter `prompts_version < PROMPTS_VERSION and host = $host` and needs no new index at this table size.
- **Phase 5 (R2):** reads `cc_session_prompts` ordered by `seq` (PK covers it) and `cc_sessions.prompts_version`.
- **Landing (coordinator):** apply 0010 to Neon with `npm run db:migrate` from the main checkout after merge, before restarting the live daemon. Both hosts share the DB, and the GPD daemon on old code ignores the new columns, so the migration is safe to run first.

## Rollback

Revert this phase's commit. If the migration was already applied to a database, the columns and table are additive and unused by older code, so they can stay. To remove them:
`drop table cc_session_prompts; alter table cc_sessions drop column summary_requested_at, drop column prompts_version; delete from drizzle.__drizzle_migrations where id = (select max(id) from drizzle.__drizzle_migrations);` Run that last statement only if 0010 is the newest applied migration.
