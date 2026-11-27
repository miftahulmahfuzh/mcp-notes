> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/stream-play-log/PLAN.md` phase 5. Source: `/home/miftah/mcp-notes/.workflows/orchestration/stream-play-log/phase-5.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 5: Reminders: table, tool, hook, the one-week seed

**Plan set:** `STREAM_PLAY_LOG_PLAN.md`
**Analysis:** `.workflows/analyze/20261127-081756-PL7K_code_analyzer.md`
**Satisfies:** R4: "for no 3, make sure we add a hook reminder or something. after one week, you will automatically remind me about this feature"
**Criteria:** R4.1, R4.2, R4.3, R4.4
**Depends on:** Phase 1 (its migration `0044` and its `src/db/schema.ts` table must be on the branch before `0045` is generated)
**Difficulty:** NORMAL
**Package:** `src/reminders`, `src/http/sessionHooks.ts`, `claude/hooks/notes-session.mjs`, `src/mcp/remindTool.ts`

---

## Goal

A `reminders` table, written only by `RemindersRepo`, holds reminders for the owner with a due time and an optional repository. On a fresh Claude Code start (`startup`, `clear`) the SessionStart hook's reply carries the due, open reminders of that session's repository (and those for every repository), each shown at most once per 20 hours until marked done, and `notes-session` puts them into the session's start context with the instruction to tell the owner. The MCP tool `remind` adds, lists and marks reminders done, and the daemon stores the one-week `play-log-ranking` reminder once at its first start with this change.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- table `reminders` (`src/db/schema.ts`, appended at the end of the file), type `ReminderRow`; migration `drizzle/0045_reminders.sql` (+ `drizzle/meta/0045_snapshot.json`, a `_journal.json` entry)
- `src/reminders/repo.ts`: `RemindersRepo` (`add`, `listOpen`, `done`, `dueFor(repo, now)`, `seed`), `Reminder`, `DueReminder`, `NewReminder`, `ReminderSeedRow`, `REMINDER_REPEAT_MS` (20 h), `MAX_REMINDERS_PER_START` (5), `MAX_REMINDER_BODY` (2000), `MAX_REMINDER_REPO` (200), `DAY_MS`
- `src/reminders/seeds.ts`: `ReminderSeed`, `REMINDER_SEEDS`, `PLAY_LOG_RANKING_SEED`, `seedReminders(store, seeds?)`
- `src/mcp/remindTool.ts`: `REMIND_TOOL_NAME = 'remind'`, `registerRemindTool(server, deps, options?)`, `parseRemindArgs`, `dueFrom`, `RemindArgs`, `RemindRequest`, `MAX_IN_DAYS`
- `src/http/sessionHooks.ts`: `SessionHookReminder`, `REMINDER_REPO_BUDGET_MS`, options `repoOf`, `repoBudgetMs`
- `claude/hooks/notes-session.mjs`: `MAX_REMINDERS`, `remindersOf(reply)`, `reminderContext(reminders)`
- `StartDaemonOptions.now?: () => Date` (`src/daemon.ts`), used by the seed only
**Signature changes:**
- `SessionHookStartReply` gains `reminders: SessionHookReminder[]` (always present; `[]` unless a fresh start found due ones)
- `buildContext(reply)` in `notes-session.mjs`: unchanged output when the reply carries no reminders; with reminders, a blank line and the reminder block follow the node-id sentences
**Requires (from earlier phases):** Phase 1's `stream_play_log` table at the end of `src/db/schema.ts` and `drizzle/0044_*.sql` + `meta/0044_snapshot.json` committed, so `npm run db:generate` numbers this one `0045`.
**Leaves alone (owned by others):** `src/directStream/playLog/*` and every `stream_play_log` read or write (Phases 1, 3); `web/` (Phases 2, 3); the other five hooks; `src/sessions/search.ts` (Phase 4); `SHARED_IMPORT_TABLES` (`reminders` is deliberately not added); `src/chat/status.ts` (`remind` is not added to the chat allow-list, see Step 5); `src/mcp/instructions.ts` (no paragraph added: the tool's own description and the hook's context say how to use it).

**Shared files (reconciled; phase 1 lands before this phase, phase 3 runs at the same time as this one):**
- `src/db/schema.ts`, `drizzle/meta/_journal.json`: phase 1 puts `streamPlayLog` after `streamDownloads` and its row types `StreamPlayLogRow`, `NewStreamPlayLogRow` at the end of the file; this phase appends after `export type NewStreamPlayLogRow = typeof streamPlayLog.$inferInsert` (the file's last line after phase 1). The journal gains `idx: 45` after phase 1's `idx: 44`.
- `src/daemon.ts`: phase 1 adds imports after `import { StreamReporter } from './directStream/report.js';`, the play-log block after the `movieStreams` block, `playLog,` in the `buildDirectStreamService` wiring and in `deps`. This phase adds its imports after `import { SessionEvents } from './sessions/events.js';`, the `now` option at the end of `StartDaemonOptions` and the seed block after the import-merge block (before `const events = new NoteEvents();`). No line is edited by both; the line numbers below are pre-phase-1 and move by the two import lines phase 1 adds above :75, so anchor by text.
- `tests/integration/setup.ts` (`truncateAll`): after phase 1 the list begins `truncate table stream_play_log, stream_downloads, ...`; this phase adds `reminders, ` in front of it (Step 1 quotes the result).
- `CLAUDE.md`: phase 1 rewrites only the streaming **Single writers** line (:102); this phase adds one bullet after the Claude Code integration bullet (:111). Line count unchanged by phase 1.
- `docs/guide/architecture.md`: after phase 1 the one-writer table has a `stream_play_log` row after `stream_trending` and the Direct streaming data-model row lists `stream_play_log`; this phase adds its rows after `adversary_reviews` and before `| Settings |`, which phase 1 does not touch.
- `src/mcp/server.ts` (concurrent with phase 3): this phase owns exactly two lines, the import after `import { registerSubtitleCheckTools } from './subtitleCheckTools.js';` and the register call (with its comment) after `registerSubtitleCheckTools(server, deps);`. Phase 3 owns the import after `import { registerStreamDiskTool } ...` and the register after `registerStreamDiskTool(server, deps);`. On a merge conflict keep both pairs.
- `scripts/docs/httpRoutes.ts` (concurrent with phase 3): this phase rewrites only the `'POST /api/sessions/hook/start'` value (:138-139); phase 3 adds a `Stream health` group after `Cache page` (:350).
- `docs/guide/reference/mcp-tools.md`, `docs/guide/reference/http-api.md` (generated; concurrent with phase 3): never merged by hand. Whichever of phases 3 and 5 lands second, and the integrator after the wave, reruns `npm run docs:gen` so both files hold `remind`, `direct_stream_health`, `GET /api/stream/health` and this phase's start-route text.
- `.claude/skills/verify-notesd/features/README.md`: phase 1 edited the Direct streaming row (:20), phase 3 edits the Movies row (:19); this phase adds a Reminders row after the Projects row (:14).
- `src/chat/status.ts` and `tests/unit/chat-status.test.ts`: not touched here (`remind` stays off the chat list); phase 3 alone adds `+ 1` to the length assertion.

## Files

| File | Action | What changes |
|---|---|---|
| `src/db/schema.ts` | modify (end of file, after Phase 1's table and type) | `reminders` table + `ReminderRow` |
| `drizzle/0045_reminders.sql`, `drizzle/meta/0045_snapshot.json`, `drizzle/meta/_journal.json` | create / generated | `npx drizzle-kit generate --name reminders` |
| `tests/integration/setup.ts:50` | modify | `truncateAll` also empties `reminders` |
| `src/reminders/repo.ts` | create | `RemindersRepo`, the only writer |
| `src/reminders/seeds.ts` | create | `REMINDER_SEEDS`, `seedReminders` |
| `src/daemon.ts:88-111`, `:168` | modify | `now` option; the seed call after the import merge |
| `src/http/sessionHooks.ts:1-9`, `:82-99`, `:125-197` | modify | reply gains `reminders` on a fresh start |
| `claude/hooks/notes-session.mjs:1-47`, `:181-199` | modify | reminder block in `additionalContext` |
| `claude/hooks/notes-session.d.mts` | modify | types for the new exports and `reminders` |
| `src/mcp/remindTool.ts` | create | the `remind` tool |
| `src/mcp/server.ts:15`, `:46` | modify | import and register it |
| `scripts/docs/httpRoutes.ts:138-139` | modify | the start route's reply names `reminders` |
| `docs/guide/reference/mcp-tools.md`, `docs/guide/reference/http-api.md` | regenerate | `npm run docs:gen` |
| `docs/guide/claude-code.md:287`, `:325-329`, after `:337`, `:458-466`, `:469-476` | modify | the hook row and paragraph, a Reminders section, code map, proof |
| `docs/guide/architecture.md` (one-writer table after `adversary_reviews`, data model before `Settings`) | modify | one-writer row and data-model row (after phase 1's `stream_play_log` rows) |
| `CLAUDE.md:111` | modify | one bullet after the Claude Code integration bullet |
| `.claude/skills/verify-notesd/features/reminders.md` | create | feature map entry |
| `.claude/skills/verify-notesd/features/README.md` | modify | one row |
| `tests/integration/reminders.int.test.ts` | create | repo, seed, route, hook end to end, tool |
| `tests/integration/daemon.int.test.ts` | modify | the seed at daemon start, once, clock injected |
| `tests/unit/hooks/notesSession.test.ts` | modify (append tests) | reminder block from a fake reply |
| `tests/unit/mcp.remindTool.test.ts` | create | argument parsing, registration, not a chat tool |
| `tests/unit/reminders.seeds.test.ts` | create | the seed's content and `seedReminders` |

## Implementation Steps

### Step 1: The `reminders` table and migration 0045
**File:** `src/db/schema.ts` (append at the very end of the file, after phase 1's last line `export type NewStreamPlayLogRow = typeof streamPlayLog.$inferInsert`)
**Change:** add the table and its row type. Phase 1 must already be on the branch: check `ls drizzle | tail -2` shows `0044_*.sql` before generating.
**Code:**
```ts
/**
 * Reminders for the owner (migration 0045). Written only by RemindersRepo (src/reminders/repo.ts). The notes-session hook
 * shows a reminder at a fresh Claude Code start once `due_at` has passed, in its `repo` (null: every repository), at most
 * once every 20 hours (`last_shown_at`), until `done_at` is set by the `remind` tool. `seed_key` is set only on the
 * reminders the daemon stores itself at start (src/reminders/seeds.ts), each once. Neon never held it, so it is not in
 * SHARED_IMPORT_TABLES.
 */
export const reminders = pgTable(
  'reminders',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    seedKey: text('seed_key').unique(),
    body: text('body').notNull(),
    repo: text('repo'),
    dueAt: timestamp('due_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    doneAt: timestamp('done_at', { withTimezone: true, mode: 'date' }),
    lastShownAt: timestamp('last_shown_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    check('reminders_body_check', sql`length(${t.body}) between 1 and 2000`),
    check('reminders_repo_check', sql`${t.repo} is null or length(${t.repo}) between 1 and 200`),
    check('reminders_seed_key_check', sql`${t.seedKey} is null or length(${t.seedKey}) between 1 and 100`),
    index('reminders_open_idx').on(t.dueAt).where(sql`${t.doneAt} is null`),
  ],
)

export type ReminderRow = typeof reminders.$inferSelect
```
Then run, from the worktree root:
```sh
npx drizzle-kit generate --name reminders
```
It must write `drizzle/0045_reminders.sql`, `drizzle/meta/0045_snapshot.json` and one `_journal.json` entry, and nothing else. The SQL it writes must be (check it, do not hand-edit unless drizzle-kit wrote something different in substance):
```sql
CREATE TABLE "reminders" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"seed_key" text,
	"body" text NOT NULL,
	"repo" text,
	"due_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone,
	"last_shown_at" timestamp with time zone,
	CONSTRAINT "reminders_seed_key_unique" UNIQUE("seed_key"),
	CONSTRAINT "reminders_body_check" CHECK (length("reminders"."body") between 1 and 2000),
	CONSTRAINT "reminders_repo_check" CHECK ("reminders"."repo" is null or length("reminders"."repo") between 1 and 200),
	CONSTRAINT "reminders_seed_key_check" CHECK ("reminders"."seed_key" is null or length("reminders"."seed_key") between 1 and 100)
);
--> statement-breakpoint
CREATE INDEX "reminders_open_idx" ON "reminders" USING btree ("due_at") WHERE "reminders"."done_at" is null;
```
If the generated SQL also contains statements for `stream_play_log` or any other table, Phase 1's snapshot is missing: stop and fix the order, never commit a migration that re-creates Phase 1's table.

**File:** `tests/integration/setup.ts:50`
**Change:** in `truncateAll`, insert `reminders, ` directly after `truncate table ` (whatever Phase 1 put first). After Phase 1 the statement begins, for example:
```ts
  await db.execute(sql`truncate table reminders, stream_play_log, stream_downloads, stream_torrent_marks, stream_torrents, stream_caches, stream_provider_health, stream_providers, movie_plays, movie_files, movie_episodes, movie_credits, movie_people, movie_title_companies, movie_companies, movie_titles, adversary_reviews, note_session_links, cc_session_reply_embeddings, cc_session_replies, cc_session_prompt_images, cc_session_prompts, cc_subagent_transcripts, cc_session_embeddings, cc_pending_spawns, cc_sessions, app_settings, chat_message_attachments, chat_message_revisions, chat_messages, chat_threads, note_image_embeddings, chat_images, note_files, note_images, note_embeddings, note_revisions, notes restart identity cascade`)
```
(the only change of this phase is the leading `reminders, `; keep Phase 1's own entry exactly as Phase 1 wrote it).
**Impact:** additive table. `npm run typecheck` passes; `npm run test:int` applies 0045 in `globalSetup`.

### Step 2: `RemindersRepo`, the only writer
**File:** `src/reminders/repo.ts` (new)
**Code:**
```ts
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { reminders, type ReminderRow } from '../db/schema.js';

/** A reminder shown at a fresh start is not shown again for this long, until it is done. */
export const REMINDER_REPEAT_MS = 20 * 60 * 60 * 1000;
/** At most this many reminders go into one session's start context; the rest come at the next fresh start. */
export const MAX_REMINDERS_PER_START = 5;
/** The table's CHECKs say the same. */
export const MAX_REMINDER_BODY = 2000;
export const MAX_REMINDER_REPO = 200;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** One reminder as the `remind` tool answers it. Times are ISO 8601 UTC. */
export interface Reminder {
  id: number;
  body: string;
  /** The repository key it is shown in (`mcp-notes`); null: every repository. */
  repo: string | null;
  due_at: string;
  created_at: string;
  done_at: string | null;
  last_shown_at: string | null;
  /** Set on a reminder the daemon stored itself (src/reminders/seeds.ts). */
  seed_key: string | null;
}

/** What a fresh start is shown. */
export interface DueReminder {
  id: number;
  body: string;
  due_at: string;
}

export interface NewReminder {
  body: string;
  dueAt: Date;
  repo: string | null;
}

export interface ReminderSeedRow {
  key: string;
  repo: string | null;
  body: string;
  dueAfterDays: number;
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function view(row: ReminderRow): Reminder {
  return {
    id: row.id,
    body: row.body,
    repo: row.repo,
    due_at: row.dueAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    done_at: row.doneAt === null ? null : row.doneAt.toISOString(),
    last_shown_at: row.lastShownAt === null ? null : row.lastShownAt.toISOString(),
    seed_key: row.seedKey,
  };
}

/**
 * The only writer of `reminders`. Callers validate their input at their own boundary (the `remind` tool, the seed list);
 * the table's CHECKs are the last guard.
 */
export class RemindersRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async add(input: NewReminder): Promise<Reminder> {
    const [row] = await this.db
      .insert(reminders)
      .values({ body: input.body, dueAt: input.dueAt, repo: input.repo, createdAt: this.now() })
      .returning();
    if (row === undefined) throw new Error('insert into reminders returned no row');
    return view(row);
  }

  /** Every reminder not done, soonest first. */
  async listOpen(): Promise<Reminder[]> {
    const rows = await this.db.select().from(reminders).where(isNull(reminders.doneAt)).orderBy(asc(reminders.dueAt), asc(reminders.id));
    return rows.map(view);
  }

  /** Marks one done; `changed: false` when it already was. Null when no reminder has that id. */
  async done(id: number): Promise<{ reminder: Reminder; changed: boolean } | null> {
    const [updated] = await this.db
      .update(reminders)
      .set({ doneAt: this.now() })
      .where(and(eq(reminders.id, id), isNull(reminders.doneAt)))
      .returning();
    if (updated !== undefined) return { reminder: view(updated), changed: true };
    const [row] = await this.db.select().from(reminders).where(eq(reminders.id, id)).limit(1);
    return row === undefined ? null : { reminder: view(row), changed: false };
  }

  /**
   * The reminders a fresh start in `repo` shows at `now`: due (`due_at <= now`), not done, for `repo` or for every
   * repository (a null `repo` matches only those), and not shown in the last 20 hours. Stamps `last_shown_at = now` on
   * exactly the rows it returns, in the same statement; `skip locked` keeps two sessions starting at once from both
   * showing one reminder. Soonest first, at most MAX_REMINDERS_PER_START.
   */
  async dueFor(repo: string | null, now: Date = this.now()): Promise<DueReminder[]> {
    const at = now.toISOString();
    const shownBefore = new Date(now.getTime() - REMINDER_REPEAT_MS).toISOString();
    const res = await this.db.execute<{ id: string | number; body: string; due_at: string | Date }>(sql`
      with picked as (
        select id from reminders
        where done_at is null
          and due_at <= ${at}::timestamptz
          and (repo is null or repo = ${repo}::text)
          and (last_shown_at is null or last_shown_at <= ${shownBefore}::timestamptz)
        order by due_at, id
        limit ${MAX_REMINDERS_PER_START}
        for update skip locked
      )
      update reminders r set last_shown_at = ${at}::timestamptz
      from picked
      where r.id = picked.id
      returning r.id, r.body, r.due_at`);
    return res.rows
      .map((r) => ({ id: Number(r.id), body: r.body, due_at: iso(r.due_at) }))
      .sort((a, b) => a.due_at.localeCompare(b.due_at) || a.id - b.id);
  }

  /** Stores a seed once by its key, due `dueAfterDays` after now. True when this call stored it. */
  async seed(seed: ReminderSeedRow): Promise<boolean> {
    const now = this.now();
    const rows = await this.db
      .insert(reminders)
      .values({
        seedKey: seed.key,
        repo: seed.repo,
        body: seed.body,
        dueAt: new Date(now.getTime() + seed.dueAfterDays * DAY_MS),
        createdAt: now,
      })
      .onConflictDoNothing({ target: reminders.seedKey })
      .returning({ id: reminders.id });
    return rows.length > 0;
  }
}
```
**Impact:** none outside this file yet. Proved in Step 9's integration tests.

### Step 3: The seed list
**File:** `src/reminders/seeds.ts` (new)
**Code:**
```ts
import type { ReminderSeedRow } from './repo.js';

/** A reminder the daemon stores itself, once by `key`, due `dueAfterDays` after the first start that knows it. */
export interface ReminderSeed extends ReminderSeedRow {
  key: string;
  /** The repository key it is shown in; null: every repository. */
  repo: string | null;
  dueAfterDays: number;
  /** Plain text the owner reads. */
  body: string;
}

/** STREAM_PLAY_LOG_PLAN R4: a week after the play log starts, decide proposal item 3 with its data. */
export const PLAY_LOG_RANKING_SEED: ReminderSeed = {
  key: 'play-log-ranking',
  repo: 'mcp-notes',
  dueAfterDays: 7,
  body:
    'The stream play log has been recording for a week. Decide proposal item 3: should real delivery (start failures, ' +
    'time to first frame, stalls, delivered height per torrent index and cloud provider) feed the choice of provider or ' +
    'torrent? Read the data at http://localhost:7317/movies/health or with the direct_stream_health tool. Also retake ' +
    'the movies guide live pictures now that the health page has data: npm run docs:shots -- --live movies (stream.png ' +
    'has a new icon; add health.png to docs/guide/movies.md).',
};

/** Every seed. A key is never reused for another reminder: a stored key is never stored again, even after it is done. */
export const REMINDER_SEEDS: readonly ReminderSeed[] = [PLAY_LOG_RANKING_SEED];

/** Stores each seed not stored yet. Returns the keys this call stored. */
export async function seedReminders(
  store: { seed(seed: ReminderSeedRow): Promise<boolean> },
  seeds: readonly ReminderSeed[] = REMINDER_SEEDS,
): Promise<string[]> {
  const stored: string[] = [];
  for (const seed of seeds) {
    if (await store.seed(seed)) stored.push(seed.key);
  }
  return stored;
}
```
**Impact:** none until Step 4 calls it.

### Step 4: The seed at daemon start
**File:** `src/daemon.ts`
**Change 1** (imports, after line 75 `import { SessionEvents } from './sessions/events.js';`):
```ts
import { RemindersRepo } from './reminders/repo.js';
import { seedReminders } from './reminders/seeds.js';
```
**Change 2** (`StartDaemonOptions`, lines 88-111: add as the last member, after `onRestartWanted`):
```ts
  /** The clock of the reminder seeds (src/reminders/seeds.ts): a seed is due its days after this. Omitted: the wall clock. */
  now?: () => Date;
```
**Change 3** (after the import-merge block that ends at line 168 `  }`, before `const events = new NoteEvents();`):
```ts
  // Reminders (src/reminders/): each seed is stored once by its key, due its days after the first start that knows it.
  // A failure here costs the seed, never the start.
  try {
    const seeded = await seedReminders(new RemindersRepo(db, options.now ?? (() => new Date())));
    if (seeded.length > 0) console.log(`[notesd] reminders: stored ${seeded.join(', ')}`);
  } catch (err) {
    console.error(`[notesd] reminders: could not store the seeds: ${err instanceof Error ? err.message : String(err)}`);
  }
```
**Impact:** every daemon start runs one `insert ... on conflict do nothing` per seed. A fresh database (tests, a throwaway daemon) gets the row due 7 days later, so nothing is shown in its first week: no existing test's expected output changes (see Step 9).

### Step 5: The `remind` MCP tool
**File:** `src/mcp/remindTool.ts` (new)
**Decision (chat allow-list):** not added. The neighbouring Claude-Code-only tools (`direct_stream_update_source`, `direct_stream_cache`, `direct_stream_sync_subtitle`) are kept off the chat bar when the chat prompt does not describe them and the wall has no place for them. Reminders are shown only by the SessionStart hook ("Reminders on the wall" is out of scope in the index), and the chat bar has no repository to file one under. A unit test checks it stays off (`allowedChatTools()` does not contain `mcp__notes__remind`). The name lives in this file, so `src/chat/status.ts` (which Phase 3 edits) is not touched.
**Code:**
```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DAY_MS, MAX_REMINDER_BODY, MAX_REMINDER_REPO, RemindersRepo } from '../reminders/repo.js';
import { run, type ToolDeps } from './tools.js';

/** Claude Code only: not in allowedChatTools() (reminders are shown by the SessionStart hook, never on the wall). */
export const REMIND_TOOL_NAME = 'remind';
/** The furthest `in_days` reaches: ten years. */
export const MAX_IN_DAYS = 3650;

const DUE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DUE_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const REMINDER_ID = /^#?([1-9]\d{0,14})$/;

const DESCRIPTION =
  "Reminders for the owner. A reminder is shown by the notes-session hook at the start of a fresh Claude Code session (startup or /clear) once it is due, " +
  'in the repository it names (or in every repository), at most once every 20 hours, until it is marked done. ' +
  'action add: body (plain text the owner reads), and exactly one of due (an ISO date "2026-12-04", meaning midnight on this machine, or a datetime with its offset "2026-12-04T09:00:00+07:00") ' +
  'and in_days (days from now; 0 is now), and repo (optional: a repository key such as "mcp-notes"; omitted, every repository). Answers {reminder}. ' +
  'action list: every reminder not done, soonest first, each with id, body, repo, due_at and last_shown_at. Answers {reminders}. ' +
  'action done: id (the number, 12 or "#12") marks it done so it is never shown again. Answers {reminder, changed}; changed is false when it was already done. ' +
  'When a session starts with a reminder in its context, tell the owner at the start of your first reply; call done only after the owner says it is handled, and add only when the owner asks to be reminded.';

/** What the tool receives, before validation. */
export interface RemindArgs {
  action: 'add' | 'list' | 'done';
  body?: string;
  due?: string;
  in_days?: number;
  repo?: string;
  id?: number | string;
}

/** A validated request: each action carries exactly what it needs. */
export type RemindRequest =
  | { action: 'add'; body: string; dueAt: Date; repo: string | null }
  | { action: 'list' }
  | { action: 'done'; id: number };

function invalid(message: string): Error {
  return new Error(`invalid_input: ${message}`);
}

/** `due` as a time: a date is midnight on this machine, a datetime needs its offset. */
export function dueFrom(text: string): Date {
  const day = DUE_DATE.exec(text);
  if (day !== null) {
    const year = Number(day[1]);
    const month = Number(day[2]);
    const date = Number(day[3]);
    const at = new Date(year, month - 1, date);
    if (at.getFullYear() !== year || at.getMonth() !== month - 1 || at.getDate() !== date) throw invalid(`due ${text} is not a date`);
    return at;
  }
  if (DUE_INSTANT.test(text) && !Number.isNaN(Date.parse(text))) return new Date(text);
  throw invalid('due must be an ISO date (2026-12-04) or a datetime with its offset (2026-12-04T09:00:00+07:00)');
}

/** Validates and normalizes the tool's arguments once, here at the boundary. Throws `invalid_input: ...`. */
export function parseRemindArgs(args: RemindArgs, now: Date): RemindRequest {
  if (args.action === 'list') return { action: 'list' };
  if (args.action === 'done') {
    const raw = typeof args.id === 'number' ? String(args.id) : (args.id ?? '').trim();
    const match = REMINDER_ID.exec(raw);
    if (match === null) throw invalid('done needs id, the reminder number (12 or "#12")');
    return { action: 'done', id: Number(match[1]) };
  }
  const body = (args.body ?? '').trim();
  if (body === '') throw invalid('add needs body, the text the owner reads');
  if (body.length > MAX_REMINDER_BODY) throw invalid(`body is longer than ${MAX_REMINDER_BODY} characters`);
  const due = (args.due ?? '').trim();
  const hasDue = due !== '';
  const hasDays = args.in_days !== undefined;
  if (hasDue === hasDays) throw invalid('add needs exactly one of due and in_days');
  let dueAt: Date;
  if (hasDue) {
    dueAt = dueFrom(due);
  } else {
    const days = args.in_days as number;
    if (!Number.isFinite(days) || days < 0 || days > MAX_IN_DAYS) throw invalid(`in_days must be between 0 and ${MAX_IN_DAYS}`);
    dueAt = new Date(now.getTime() + days * DAY_MS);
  }
  const repo = (args.repo ?? '').trim();
  if (repo.length > MAX_REMINDER_REPO) throw invalid(`repo is longer than ${MAX_REMINDER_REPO} characters`);
  return { action: 'add', body, dueAt, repo: repo === '' ? null : repo };
}

/** `remind`: add | list | done, through RemindersRepo on `deps.db`. Nothing is read or written at registration. */
export function registerRemindTool(server: McpServer, deps: Pick<ToolDeps, 'db'>, options: { now?: () => Date } = {}): void {
  const now = options.now ?? (() => new Date());
  server.registerTool(
    REMIND_TOOL_NAME,
    {
      title: 'Reminders: add, list, done',
      description: DESCRIPTION,
      inputSchema: {
        action: z.enum(['add', 'list', 'done']).describe('add a reminder, list the open ones, or mark one done.'),
        body: z.string().optional().describe('add: the reminder, plain text the owner reads (at most 2000 characters).'),
        due: z.string().optional().describe('add: when it is due, "2026-12-04" (midnight on this machine) or "2026-12-04T09:00:00+07:00". Not with in_days.'),
        in_days: z.number().optional().describe('add: days from now until it is due (0 is now; fractions allowed). Not with due.'),
        repo: z.string().optional().describe('add: the repository key it is shown in, such as "mcp-notes". Omitted: every repository.'),
        id: z.union([z.number(), z.string()]).optional().describe('done: the reminder number, 12 or "#12".'),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args) =>
      run(async () => {
        const at = now();
        const request = parseRemindArgs(args as RemindArgs, at);
        const repo = new RemindersRepo(deps.db, now);
        if (request.action === 'add') return { reminder: await repo.add({ body: request.body, dueAt: request.dueAt, repo: request.repo }) };
        if (request.action === 'list') return { reminders: await repo.listOpen() };
        const done = await repo.done(request.id);
        if (done === null) throw new Error(`not_found: no reminder #${request.id}`);
        return done;
      }),
  );
}
```
**File:** `src/mcp/server.ts`
**Change:** import after line 15 (`import { registerSubtitleCheckTools } ...`):
```ts
import { registerRemindTool } from './remindTool.js';
```
and register after line 47 (`registerSubtitleCheckTools(server, deps);`), before `return server;`:
```ts
  // Reminders for the owner, shown by the notes-session hook (STREAM_PLAY_LOG_PLAN phase 5). Claude Code only.
  registerRemindTool(server, deps);
```
Phase 3 adds its own import after `registerStreamDiskTool`'s and its register call after `registerStreamDiskTool(server, deps);` (one line above this phase's anchor). Neither phase edits the other's lines; on a merge conflict keep both pairs, phase 3's first.
**Impact:** one more tool on `/mcp`; `docs/guide/reference/mcp-tools.md` drifts until Step 8's `docs:gen` (it falls in the generator's "Notes" group, whose guide is `claude-code.md`).

### Step 6: The start route answers due reminders on a fresh start
**File:** `src/http/sessionHooks.ts`
**Change 1** (imports, lines 1-9): add after `import { SessionsRepo } from '../sessions/repo.js';`
```ts
import { createRepoResolver } from '../sessions/repoResolve.js';
import { RemindersRepo } from '../reminders/repo.js';
```
**Change 2** (after line 22, `export const CLAIMING_SOURCES ...`):
```ts
/** How long a fresh start waits for its cwd's repository key before it shows only the reminders for every repository. */
export const REMINDER_REPO_BUDGET_MS = 1000;
```
**Change 3** (replace `SessionHookOptions`, lines 82-89, and `SessionHookStartReply`, lines 91-99):
```ts
export interface SessionHookOptions {
  /** Host recorded when the hook sends none. Defaults to os.hostname(). */
  hostname?: () => string;
  /** Pending-spawn claim window. Defaults to PENDING_SPAWN_WINDOW_MS. */
  windowMs?: number;
  /** Clock for the prune cutoff and for which reminders are due. Defaults to Date.now. */
  now?: () => number;
  /**
   * The repository key of a cwd, for a session whose row has none yet. Defaults to the ingester's rules
   * (createRepoResolver with the home dir and config.sessions.worktreesDir), so a reminder's `repo` means what a
   * session row's `repo` means. Tests inject one.
   */
  repoOf?: (cwd: string) => Promise<string | null>;
  /** Defaults to REMINDER_REPO_BUDGET_MS. */
  repoBudgetMs?: number;
}

/** A reminder shown at a fresh start (src/reminders/repo.ts, `dueFor`). */
export interface SessionHookReminder {
  id: number;
  body: string;
  due_at: string;
}

export interface SessionHookStartReply {
  session_id: string;
  node_id: string;
  parent_session_id: string | null;
  parent_node_id: string | null;
  parent_link_source: string | null;
  /** True when this call linked the parent by claiming a pending spawn. */
  claimed: boolean;
  /** Due reminders of this session's repository and of every repository; only on a fresh start (`startup`, `clear`), else []. */
  reminders: SessionHookReminder[];
}

/** `work`'s value, or `fallback` when it fails or takes longer than `ms`. */
function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}
```
**Change 4** (the doc comment above `sessionHookRoutes`, lines 107-110): after the sentence ending "`resume` / `compact` only refresh the row." add
```ts
 * A fresh start also answers `reminders`: the due, open reminders of the session's repository (its row's `repo`, else its
 * cwd's, resolved like ingest does within REMINDER_REPO_BUDGET_MS) and of every repository, each stamped as shown so it
 * is not shown again for 20 hours (RemindersRepo.dueFor). A failure there answers `reminders: []` and one log line.
```
**Change 5** (inside `sessionHookRoutes`, after `const now = options.now ?? Date.now;` at line 130):
```ts
  const remindersRepo = new RemindersRepo(deps.db, () => new Date(now()));
  const repoBudgetMs = options.repoBudgetMs ?? REMINDER_REPO_BUDGET_MS;
  const repoOf =
    options.repoOf ??
    (() => {
      const resolver = createRepoResolver({ homeDir: os.homedir(), worktreesDir: deps.config.sessions.worktreesDir });
      return (cwd: string) => resolver.resolve(cwd, '');
    })();
  /** The reminders a fresh start shows; [] and one log line when the lookup fails. */
  const dueReminders = async (rowRepo: string | null, cwd: string | null): Promise<SessionHookReminder[]> => {
    try {
      const repoKey = rowRepo ?? (cwd === null ? null : await within(repoOf(cwd), repoBudgetMs, null));
      return await remindersRepo.dueFor(repoKey, new Date(now()));
    } catch (err) {
      console.error(`[notesd] reminders: the start lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  };
```
**Change 6** (the reply at lines 188-196): replace
```ts
    const reply: SessionHookStartReply = {
      session_id: row.sessionId,
      node_id: row.nodeId,
      parent_session_id: row.parentSessionId,
      parent_node_id: parentRow?.nodeId ?? null,
      parent_link_source: row.parentLinkSource ?? null,
      claimed,
    };
```
with
```ts
    const reply: SessionHookStartReply = {
      session_id: row.sessionId,
      node_id: row.nodeId,
      parent_session_id: row.parentSessionId,
      parent_node_id: parentRow?.nodeId ?? null,
      parent_link_source: row.parentLinkSource ?? null,
      claimed,
      reminders: fresh ? await dueReminders(row.repo, body.cwd) : [],
    };
```
**Impact:** the reply gains a key. Existing route tests use `toMatchObject` (checked: `tests/integration/sessionHooks.int.test.ts:63`, `:69`, `:79`), so they are unaffected; their tables hold no due reminder (truncated, and a seed is 7 days out). The row's `repo` is read, never written: `SessionsRepo` stays the only writer of `cc_sessions`.

### Step 7: `notes-session` puts the reminders in the start context
**File:** `claude/hooks/notes-session.mjs`
**Change 1** (header comment, item 4 at lines 19-20): replace with
```js
 * 4. It prints {hookSpecificOutput:{hookEventName:'SessionStart', additionalContext}} naming the node
 *    id and the parent's node id, then, on a fresh start whose reply carries due reminders, each
 *    reminder's number, due date and text with the instruction to tell the owner and to mark it done
 *    with the `remind` tool. Daemon down, an error, or no node id in the reply: no output.
```
**Change 2** (constants, after line 47 `const MAX_TMUX = 200;`):
```js
/** At most this many reminders are put in the context (the daemon sends at most 5 too). */
export const MAX_REMINDERS = 5;
const MAX_REMINDER_BODY = 2000;
```
**Change 3** (replace `buildContext`, lines 181-199, and add two functions before it):
```js
/** The reply's reminders that are well formed, at most MAX_REMINDERS: {id, body, due} with due as YYYY-MM-DD (UTC). */
export function remindersOf(reply) {
  if (reply === null || typeof reply !== 'object' || !Array.isArray(reply.reminders)) return [];
  const out = [];
  for (const r of reply.reminders) {
    if (out.length >= MAX_REMINDERS) break;
    if (r === null || typeof r !== 'object') continue;
    if (!Number.isSafeInteger(r.id) || r.id <= 0) continue;
    const body = typeof r.body === 'string' ? r.body.replace(/\s+/g, ' ').trim().slice(0, MAX_REMINDER_BODY) : '';
    if (body === '') continue;
    if (typeof r.due_at !== 'string' || Number.isNaN(Date.parse(r.due_at))) continue;
    out.push({ id: r.id, body, due: new Date(r.due_at).toISOString().slice(0, 10) });
  }
  return out;
}

/** The reminder block of the context, or null when there is none. */
export function reminderContext(reminders) {
  if (reminders.length === 0) return null;
  const one = reminders.length === 1;
  return [
    one ? 'A reminder the owner asked for is due:' : `${reminders.length} reminders the owner asked for are due:`,
    ...reminders.map((r) => `- Reminder #${r.id} (due ${r.due}): ${r.body}`),
    `Tell the owner ${one ? 'this reminder' : 'these reminders'} at the start of your first reply, whatever they ask first, with ${one ? 'its' : 'each'} number. ` +
      'When the owner says one is handled, mark it done with the notes MCP tool `remind` (action "done", id the number); until then it is shown again in a fresh session after 20 hours.',
  ].join('\n');
}

/** The additionalContext for a reply carrying this session's node id. */
export function buildContext(reply) {
  const node = reply.node_id;
  const lines = [
    `This Claude Code session is node ${node} in the user's session graph (the Projects page of the mcp-notes wall). ` +
      `Quote ${node} when the user or another session needs to refer to this session.`,
  ];
  const parentNode = typeof reply.parent_node_id === 'string' && NODE_ID.test(reply.parent_node_id) ? reply.parent_node_id : null;
  const parentSession = typeof reply.parent_session_id === 'string' && reply.parent_session_id !== '' ? reply.parent_session_id : null;
  const source = typeof reply.parent_link_source === 'string' ? reply.parent_link_source : null;
  if (parentNode !== null) {
    lines.push(`It was spawned by node ${parentNode}${linkPhrase(source)}.`);
  } else if (parentSession !== null) {
    lines.push(`It was spawned by Claude Code session ${parentSession}${linkPhrase(source)}, which has no node id yet.`);
  } else {
    lines.push('No parent session is recorded for it.');
  }
  const context = lines.join(' ');
  const reminders = reminderContext(remindersOf(reply));
  return reminders === null ? context : `${context}\n\n${reminders}`;
}
```
`runSession` is unchanged: still one POST within `POST_TIMEOUT_MS` (3 s), still `null` (no output) when the daemon is down, answers an error, or sends no node id. No new I/O.

**File:** `claude/hooks/notes-session.d.mts`
**Change:** replace the `StartReply` interface and add the new exports:
```ts
export interface StartReminder {
  id: number;
  body: string;
  due_at: string;
}

export interface StartReply {
  session_id?: string;
  node_id: string;
  parent_session_id?: string | null;
  parent_node_id?: string | null;
  parent_link_source?: string | null;
  claimed?: boolean;
  reminders?: StartReminder[] | null;
}

export interface ContextReminder {
  id: number;
  body: string;
  /** YYYY-MM-DD, UTC. */
  due: string;
}

export const MAX_REMINDERS: number;
export function remindersOf(reply: StartReply): ContextReminder[];
export function reminderContext(reminders: ContextReminder[]): string | null;
```
(the new `export const` goes with the other constants, the two functions next to `buildContext`).
**Impact:** a reply without `reminders` (an older daemon, a resume) gives exactly the context of today.

### Step 8: Docs, generated references, CLAUDE.md, feature map
**File:** `scripts/docs/httpRoutes.ts:138-139`: replace the `'POST /api/sessions/hook/start'` value with
```ts
      'POST /api/sessions/hook/start':
        'From the notes-session hook (SessionStart): `{session, parent?, cwd?, name?, tmux?, host?, started_at?, source?}`. Upserts the session row (the node id is assigned on first sight). On `startup` or `clear` it links `parent` with source `env`; on `startup` in tmux with no better link it claims a pending spawn as `hook`. On `startup` or `clear` it also answers the due reminders of the session\'s repository and of every repository, at most 5, each then not shown again for 20 hours. 200 `{session_id, node_id, parent_session_id, parent_node_id, parent_link_source, claimed, reminders: [{id, body, due_at}]}`.',
```
Then run `npm run docs:gen` (rewrites `docs/guide/reference/http-api.md` and `docs/guide/reference/mcp-tools.md`; never hand-edit them).

**File:** `docs/guide/claude-code.md`
- Line 287, the `notes-session` row: replace "Reports the session and its parent to the daemon; tells Claude its node id" with "Reports the session and its parent to the daemon; tells Claude its node id and the reminders due".
- Lines 325-329, the **notes-session.** paragraph: append after "...are skipped.":
  ```markdown
  On a fresh start (`startup`, `/clear`) the daemon's answer also carries the
  [reminders](#reminders) that are due, and the hook adds them after the node id, with the
  instruction to tell you at the start of the first reply.
  ```
- After line 337 (the "The session side of these hooks ... [sessions.md](sessions.md)." paragraph) and before `### How they are installed`, add:
  ```markdown
  ### Reminders

  A reminder is a line of text with a due time and, optionally, a repository. When a terminal
  session starts fresh (`startup` or `/clear`) in that repository, or anywhere for a reminder
  without one, and the reminder is due and not done, notes-session puts it at the top of the
  session's context with its number, and Claude tells you about it in its first reply. A shown
  reminder is not shown again for 20 hours, so a burst of new sessions mentions it once; it comes
  back the next day until it is marked done. At most five are shown at one start, soonest first.

  The `remind` tool manages them: "remind me in two weeks to look at the Seer twins" is `add` with
  `in_days: 14` (or `due: "2026-12-11"`, midnight on this machine), `list` shows the open ones,
  and "that's handled" is `done` with the number. A reminder's repository is the same key the
  Projects page uses (`mcp-notes`), worked out from the session's working directory the way the
  session graph does it.

  The daemon also stores reminders of its own, once each, when a change asks for one: the play
  log's one-week review (`play-log-ranking`, repository `mcp-notes`, due seven days after the
  first start that had it). A done reminder is never stored again. Reminders live in the
  `reminders` table, written only by `RemindersRepo` (`src/reminders/repo.ts`); the seeds are in
  `src/reminders/seeds.ts`. Nothing on the wall shows them.
  ```
- "Where the code is" table (lines 456-466): add after the `src/mcp/sessionTools.ts` row:
  ```markdown
  | `src/mcp/remindTool.ts`, `src/reminders/` | The `remind` tool; `RemindersRepo` and the seeds the daemon stores at start |
  ```
- "Proving a change" (lines 469-476): in the first bullet, change "`notes.md`, `images-files.md`, `search.md` and `projects.md`" to "`notes.md`, `images-files.md`, `search.md`, `projects.md` and `reminders.md`".

**File:** `docs/guide/architecture.md`
- One-writer table (rows at lines 67-79 after phase 1, which added `` | `stream_play_log` | `PlayLogRepo` ... | `` after `stream_trending`): add after the `adversary_reviews` row:
  ```markdown
  | `reminders` | `RemindersRepo` (`src/reminders/repo.ts`) |
  ```
- Data-model table: add before the `| Settings | ...` row (line 100 after phase 1; phase 1 changed only the Direct streaming row above it):
  ```markdown
  | Reminders | `reminders` | A reminder for the owner: text, due time, an optional repository key, when it was last shown and when it was done. The notes-session hook shows a due one at a fresh start at most once per 20 hours; `seed_key` marks the ones the daemon stored itself, once each. |
  ```

**File:** `CLAUDE.md:111`: add one bullet directly after the "**Claude Code integration lives in `claude/`:** ..." bullet:
```markdown
- **Reminders** (`src/reminders/*`): `RemindersRepo` is the only writer of `reminders` (not in `SHARED_IMPORT_TABLES`). A fresh start's `POST /api/sessions/hook/start` answers the due ones and notes-session tells Claude; each is shown at most once per 20 h until `remind` marks it done. A seed in `REMINDER_SEEDS` is stored once by its key at daemon start; never reuse a key.
```

**File:** `.claude/skills/verify-notesd/features/reminders.md` (new):
````markdown
# Reminders: the `remind` tool and the SessionStart hook

## Sub-features
- MCP `remind`: `add` ({body, due | in_days, repo?} → {reminder}), `list` (open ones, soonest first → {reminders}),
  `done` ({id} → {reminder, changed}; `not_found` for an unknown id). Invalid input answers `invalid_input: ...`.
- The start route `POST /api/sessions/hook/start` answers `reminders: [{id, body, due_at}]` on `startup` and `clear`
  only: due, not done, for the session's repository or for every repository, not shown in the last 20 h; at most 5.
  Answering stamps `last_shown_at`.
- `claude/hooks/notes-session.mjs` appends them to `additionalContext` after the node id sentences, with the
  instruction to tell the owner and to mark it done with `remind`.
- The seed `play-log-ranking` (repository `mcp-notes`) is stored once at daemon start, due 7 days after that start.

## How to get to it (user POV)
Ask Claude Code "remind me in a week to ...", or just start a session after a seeded reminder came due: the first
reply opens with the reminder and its number. "That's handled" marks it done.

## Driving it with verify.sh
```sh
V=.claude/skills/verify-notesd/scripts/verify.sh
$V up                                    # RUN, URL
PORT=${URL##*:}; T=$(mktemp -d); TOP=$(git rev-parse --show-toplevel)
$V sql RUN "select seed_key, repo, round(extract(epoch from due_at - created_at)/86400) as days, done_at from reminders"
ID=$($V mcp RUN remind '{"action":"add","body":"verify: the kettle is on","in_days":0,"repo":"mcp-notes"}' | sed 1d | jq -r .reminder.id)
hook() { printf '{"session_id":"%s","cwd":"%s","source":"%s","hook_event_name":"SessionStart"}' "$1" "$TOP" "$2" \
  | env -i PATH="$PATH" HOME="$T" XDG_STATE_HOME="$T/state" NOTESD_PORT="$PORT" CLAUDE_CODE_ENTRYPOINT=cli node "$TOP/claude/hooks/notes-session.mjs"; }
hook 11111111-1111-4111-8111-000000000001 startup | jq -r .hookSpecificOutput.additionalContext
$V mcp RUN remind "{\"action\":\"done\",\"id\":$ID}"
```
`$V exec RUN "update reminders set last_shown_at = now() - interval '21 hours' where id = $ID"` ages a reminder past
the 20 h window; `... set due_at = now() - interval '1 minute' where seed_key = 'play-log-ranking'` makes the seed due.

## Gotchas
- The repository key comes from the hook's `cwd`, resolved like the session graph (a worktree under
  `NOTES_WORKTREES_DIR`, else the git main checkout's directory name). Run the hook with `cwd` inside a checkout of
  mcp-notes whose main checkout directory is named `mcp-notes`, or add the reminder without `repo`.
- `HOME` and `XDG_STATE_HOME` point at a temp dir so the hook never reads the real `~/.claude`.
- `resume` and `compact` never show reminders; a new `session_id` per fresh start.
- Proof in tests: `tests/integration/reminders.int.test.ts`, `tests/unit/hooks/notesSession.test.ts`,
  `tests/unit/mcp.remindTool.test.ts`, `tests/integration/daemon.int.test.ts` (the seed).
````

**File:** `.claude/skills/verify-notesd/features/README.md`: add a row after the Projects row:
```markdown
| Reminders: `remind` tool, due reminders in a fresh Claude Code session's start context, the daemon's one-week seed | [reminders.md](reminders.md) | MCP, the SessionStart hook route, database |
```
**Impact:** `npm run docs:check` green again after `docs:gen`.

### Step 9: Tests
**File:** `tests/unit/reminders.seeds.test.ts` (new)
```ts
import { describe, expect, it } from 'vitest';
import { MAX_REMINDER_BODY, MAX_REMINDER_REPO, type ReminderSeedRow } from '../../src/reminders/repo.js';
import { PLAY_LOG_RANKING_SEED, REMINDER_SEEDS, seedReminders } from '../../src/reminders/seeds.js';

describe('reminder seeds', () => {
  it('have unique keys and bodies the table accepts', () => {
    const keys = REMINDER_SEEDS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const seed of REMINDER_SEEDS) {
      expect(seed.key.length).toBeGreaterThan(0);
      expect(seed.key.length).toBeLessThanOrEqual(100);
      expect(seed.body.trim().length).toBeGreaterThan(0);
      expect(seed.body.length).toBeLessThanOrEqual(MAX_REMINDER_BODY);
      if (seed.repo !== null) expect(seed.repo.length).toBeLessThanOrEqual(MAX_REMINDER_REPO);
      expect(seed.dueAfterDays).toBeGreaterThan(0);
    }
  });

  it('the play-log reminder is for mcp-notes, a week out, and names proposal item 3 and where its data is', () => {
    expect(PLAY_LOG_RANKING_SEED).toMatchObject({ key: 'play-log-ranking', repo: 'mcp-notes', dueAfterDays: 7 });
    for (const words of ['proposal item 3', 'provider or torrent', 'http://localhost:7317/movies/health', 'direct_stream_health', 'docs:shots -- --live movies', 'health.png']) {
      expect(PLAY_LOG_RANKING_SEED.body).toContain(words);
    }
  });

  it('seedReminders reports only the keys the store took', async () => {
    const seen: string[] = [];
    const store = { seed: async (s: ReminderSeedRow) => (seen.push(s.key), s.key === 'a') };
    const seeds = [
      { key: 'a', repo: null, dueAfterDays: 1, body: 'one' },
      { key: 'b', repo: 'x', dueAfterDays: 2, body: 'two' },
    ];
    expect(await seedReminders(store, seeds)).toEqual(['a']);
    expect(seen).toEqual(['a', 'b']);
  });
});
```

**File:** `tests/unit/mcp.remindTool.test.ts` (new)
```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { allowedChatTools } from '../../src/chat/status.js';
import type { Db } from '../../src/db/client.js';
import { dueFrom, parseRemindArgs, registerRemindTool, REMIND_TOOL_NAME } from '../../src/mcp/remindTool.js';

const NOW = new Date('2026-11-27T01:00:00.000Z');
type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

describe('parseRemindArgs', () => {
  it('add takes in_days from now, trims, and keeps a null repo when none is given', () => {
    expect(parseRemindArgs({ action: 'add', body: '  look at it  ', in_days: 7 }, NOW)).toEqual({
      action: 'add',
      body: 'look at it',
      dueAt: new Date('2026-12-04T01:00:00.000Z'),
      repo: null,
    });
    expect(parseRemindArgs({ action: 'add', body: 'x', in_days: 0, repo: ' mcp-notes ' }, NOW)).toMatchObject({ dueAt: NOW, repo: 'mcp-notes' });
  });

  it('add takes a date as local midnight and a datetime with its offset', () => {
    expect(parseRemindArgs({ action: 'add', body: 'x', due: '2026-12-04' }, NOW)).toMatchObject({ dueAt: new Date(2026, 11, 4) });
    expect(parseRemindArgs({ action: 'add', body: 'x', due: '2026-12-04T09:00:00+07:00' }, NOW)).toMatchObject({
      dueAt: new Date('2026-12-04T02:00:00.000Z'),
    });
  });

  it('add refuses a missing body, both or neither of due and in_days, a bad date, and in_days out of range', () => {
    expect(() => parseRemindArgs({ action: 'add', body: ' ', in_days: 1 }, NOW)).toThrow(/invalid_input: add needs body/);
    expect(() => parseRemindArgs({ action: 'add', body: 'x' }, NOW)).toThrow(/exactly one of due and in_days/);
    expect(() => parseRemindArgs({ action: 'add', body: 'x', in_days: 1, due: '2026-12-04' }, NOW)).toThrow(/exactly one/);
    expect(() => parseRemindArgs({ action: 'add', body: 'x', due: '2026-02-30' }, NOW)).toThrow(/is not a date/);
    expect(() => parseRemindArgs({ action: 'add', body: 'x', due: '2026-12-04T09:00:00' }, NOW)).toThrow(/with its offset/);
    expect(() => parseRemindArgs({ action: 'add', body: 'x', in_days: -1 }, NOW)).toThrow(/in_days/);
    expect(() => parseRemindArgs({ action: 'add', body: 'x'.repeat(2001), in_days: 1 }, NOW)).toThrow(/2000/);
  });

  it('done takes 12 or "#12" and refuses anything else', () => {
    expect(parseRemindArgs({ action: 'done', id: 12 }, NOW)).toEqual({ action: 'done', id: 12 });
    expect(parseRemindArgs({ action: 'done', id: '#12' }, NOW)).toEqual({ action: 'done', id: 12 });
    for (const id of [0, -3, 1.5, 'twelve', '', undefined]) {
      expect(() => parseRemindArgs({ action: 'done', id }, NOW)).toThrow(/invalid_input: done needs id/);
    }
  });

  it('dueFrom rejects free text', () => {
    expect(() => dueFrom('next week')).toThrow(/ISO date/);
  });
});

describe('the remind tool', () => {
  async function connect() {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    // Invalid input is refused before the database is touched, so no database is needed here.
    registerRemindTool(server, { db: {} as Db }, { now: () => NOW });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientSide);
    return { client, close: async () => (await client.close(), await server.close()) };
  }

  it('is registered as a writing tool with a description that names its actions', async () => {
    const c = await connect();
    const { tools } = await c.client.listTools();
    const tool = tools.find((t) => t.name === REMIND_TOOL_NAME);
    expect(tool?.annotations?.readOnlyHint).toBe(false);
    for (const word of ['add', 'list', 'done', '20 hours', 'in_days']) expect(tool?.description).toContain(word);
    await c.close();
  });

  it('answers invalid_input as a tool error', async () => {
    const c = await connect();
    const r = (await c.client.callTool({ name: REMIND_TOOL_NAME, arguments: { action: 'add', body: 'x' } })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(r.content.map((x) => x.text).join('')).toContain('invalid_input');
    await c.close();
  });

  it('is not one of the chat bar\'s tools', () => {
    expect(allowedChatTools()).not.toContain(`mcp__notes__${REMIND_TOOL_NAME}`);
  });
});
```

**File:** `tests/unit/hooks/notesSession.test.ts` (append inside the file, after the `describe('helpers', ...)` block; add `reminderContext` and `remindersOf` to the import list at lines 6-14)
```ts
describe('reminders in the start context', () => {
  const due = { id: 12, body: 'Decide  proposal\nitem 3.', due_at: '2026-12-04T01:17:56.000Z' };

  it('a fresh start reply with a due reminder puts its number, date and text after the node id, with the instruction', async () => {
    const { fetchImpl } = fakeFetch(() => reply({ reminders: [due] }));
    const out = await runSession({ input: input(), env, fetchImpl, readText: files({}), runTmux: noTmux, now: () => NOW, ppid: 4242, hostname: () => 'lenovo' });
    const context = out!.hookSpecificOutput.additionalContext;
    const [head, block] = context.split('\n\n');
    expect(head).toBe(buildContext({ node_id: 'A0-3G' }));
    expect(block).toContain('- Reminder #12 (due 2026-12-04): Decide proposal item 3.');
    expect(block).toContain('at the start of your first reply');
    expect(block).toContain('`remind` (action "done"');
  });

  it('a reply without reminders, or with an empty list, gives the context of before', () => {
    const plain = "This Claude Code session is node A0-3G in the user's session graph (the Projects page of the mcp-notes wall). Quote A0-3G when the user or another session needs to refer to this session. No parent session is recorded for it.";
    expect(buildContext({ node_id: 'A0-3G' })).toBe(plain);
    expect(buildContext({ node_id: 'A0-3G', reminders: [] })).toBe(plain);
    expect(buildContext({ node_id: 'A0-3G', reminders: null })).toBe(plain);
  });

  it('remindersOf keeps well formed reminders only, at most five', () => {
    const bad = [null, { id: 0, body: 'x', due_at: due.due_at }, { id: 3, body: ' ', due_at: due.due_at }, { id: 4, body: 'x', due_at: 'soon' }, { id: '5', body: 'x', due_at: due.due_at }];
    const good = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, body: `r${i + 1}`, due_at: due.due_at }));
    expect(remindersOf({ node_id: 'A0-3G', reminders: [...bad, ...good] } as never).map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
    expect(reminderContext([])).toBeNull();
    expect(reminderContext(remindersOf({ node_id: 'A0-3G', reminders: good.slice(0, 2) }))).toMatch(/^2 reminders the owner asked for are due:/);
  });

  it('daemon down still prints nothing', async () => {
    const out = await runSession({
      input: input(),
      env,
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
      readText: files({}),
      runTmux: noTmux,
      now: () => NOW,
      ppid: 4242,
      hostname: () => 'lenovo',
    });
    expect(out).toBeNull();
  });
});
```
The existing tests of this file are left unchanged and must still pass (their fake reply carries no `reminders`).

**File:** `tests/integration/reminders.int.test.ts` (new)
```ts
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runSession } from '../../claude/hooks/notes-session.mjs';
import { SESSION_HOOK_START_PATH, sessionHookRoutes, type SessionHookStartReply } from '../../src/http/sessionHooks.js';
import { registerRemindTool, REMIND_TOOL_NAME } from '../../src/mcp/remindTool.js';
import { DAY_MS, REMINDER_REPEAT_MS, RemindersRepo } from '../../src/reminders/repo.js';
import { seedReminders } from '../../src/reminders/seeds.js';
import { startHarness, type Harness } from './imageHarness.js';
import { truncateAll } from './setup.js';

const T0 = new Date('2026-11-27T01:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const at = (ms: number) => new Date(T0.getTime() + ms);
const S1 = '11111111-1111-4111-8111-000000000001';
const S2 = '11111111-1111-4111-8111-000000000002';
const S3 = '11111111-1111-4111-8111-000000000003';

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

beforeEach(async () => {
  await h.reset();
  await truncateAll(h.deps.db);
});

afterAll(async () => {
  await h.close();
});

function repoAt(clock: () => Date): RemindersRepo {
  return new RemindersRepo(h.deps.db, clock);
}

describe('RemindersRepo', () => {
  it('adds, lists the open ones soonest first, and marks one done once', async () => {
    const repo = repoAt(() => T0);
    const later = await repo.add({ body: 'later', dueAt: at(HOUR), repo: 'mcp-notes' });
    const sooner = await repo.add({ body: 'sooner', dueAt: at(-DAY_MS), repo: null });
    expect((await repo.listOpen()).map((r) => r.id)).toEqual([sooner.id, later.id]);
    const first = await repo.done(later.id);
    expect(first).toMatchObject({ changed: true, reminder: { id: later.id, done_at: T0.toISOString() } });
    expect((await repo.listOpen()).map((r) => r.id)).toEqual([sooner.id]);
    expect(await repo.done(later.id)).toMatchObject({ changed: false, reminder: { done_at: T0.toISOString() } });
    expect(await repo.done(999_999)).toBeNull();
  });

  it('dueFor shows a due, open reminder of the repo or of every repo, once per 20 hours', async () => {
    const repo = repoAt(() => T0);
    const mine = await repo.add({ body: 'mine', dueAt: at(-HOUR), repo: 'mcp-notes' });
    const everywhere = await repo.add({ body: 'everywhere', dueAt: at(-2 * HOUR), repo: null });
    await repo.add({ body: 'future', dueAt: at(HOUR), repo: 'mcp-notes' });
    await repo.add({ body: 'elsewhere', dueAt: at(-HOUR), repo: 'seer' });
    const done = await repo.add({ body: 'done', dueAt: at(-HOUR), repo: 'mcp-notes' });
    await repo.done(done.id);

    expect(await repo.dueFor('mcp-notes', T0)).toEqual([
      { id: everywhere.id, body: 'everywhere', due_at: at(-2 * HOUR).toISOString() },
      { id: mine.id, body: 'mine', due_at: at(-HOUR).toISOString() },
    ]);
    expect(await repo.dueFor('mcp-notes', at(HOUR / 2))).toEqual([]);
    expect(await repo.dueFor('mcp-notes', at(REMINDER_REPEAT_MS - 1))).toEqual([]);
    const again = await repo.dueFor('mcp-notes', at(REMINDER_REPEAT_MS));
    expect(again.map((r) => r.body)).toEqual(['everywhere', 'mine', 'future']);
    const shown = await h.deps.db.execute<{ body: string; last_shown_at: Date }>(sql`select body, last_shown_at from reminders where last_shown_at is not null order by body`);
    expect(shown.rows.map((r) => r.body)).toEqual(['everywhere', 'future', 'mine']);
  });

  it('dueFor with no repository shows only the reminders for every repository', async () => {
    const repo = repoAt(() => T0);
    await repo.add({ body: 'mine', dueAt: at(-HOUR), repo: 'mcp-notes' });
    await repo.add({ body: 'everywhere', dueAt: at(-HOUR), repo: null });
    expect((await repo.dueFor(null, T0)).map((r) => r.body)).toEqual(['everywhere']);
  });

  it('dueFor shows at most five, soonest first; the rest come at the next start', async () => {
    const repo = repoAt(() => T0);
    for (let i = 7; i >= 1; i -= 1) await repo.add({ body: `r${i}`, dueAt: at(-i * HOUR), repo: null });
    expect((await repo.dueFor(null, T0)).map((r) => r.body)).toEqual(['r7', 'r6', 'r5', 'r4', 'r3']);
    expect((await repo.dueFor(null, T0)).map((r) => r.body)).toEqual(['r2', 'r1']);
  });

  it('two starts at once never both show one reminder', async () => {
    const repo = repoAt(() => T0);
    await repo.add({ body: 'once', dueAt: at(-HOUR), repo: null });
    const [a, b] = await Promise.all([repo.dueFor(null, T0), repo.dueFor(null, T0)]);
    expect(a.length + b.length).toBe(1);
  });
});

describe('seedReminders', () => {
  it('stores the play-log reminder once, due seven days after the first start, and never moves or revives it', async () => {
    expect(await seedReminders(repoAt(() => T0))).toEqual(['play-log-ranking']);
    expect(await seedReminders(repoAt(() => at(3 * DAY_MS)))).toEqual([]);
    const rows = await h.deps.db.execute<{ repo: string; due_at: Date; body: string }>(sql`select repo, due_at, body from reminders where seed_key = 'play-log-ranking'`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.repo).toBe('mcp-notes');
    expect(new Date(rows.rows[0]!.due_at).toISOString()).toBe(at(7 * DAY_MS).toISOString());
    expect(rows.rows[0]?.body).toContain('proposal item 3');

    const repo = repoAt(() => at(8 * DAY_MS));
    const [seeded] = await repo.listOpen();
    await repo.done(seeded!.id);
    expect(await seedReminders(repoAt(() => at(9 * DAY_MS)))).toEqual([]);
    expect(await repo.listOpen()).toEqual([]);
  });

  it('a seed is not due in its first week, so a fresh start then shows nothing', async () => {
    await seedReminders(repoAt(() => T0));
    expect(await repoAt(() => T0).dueFor('mcp-notes', at(7 * DAY_MS - 1))).toEqual([]);
    expect((await repoAt(() => T0).dueFor('mcp-notes', at(7 * DAY_MS))).map((r) => r.body)).toHaveLength(1);
  });
});

describe('POST /api/sessions/hook/start reminders', () => {
  let clock = T0;
  let repoKey: () => Promise<string | null> = async () => 'mcp-notes';
  const app = () => new Hono().route('/', sessionHookRoutes(h.deps, { now: () => clock.getTime(), repoOf: () => repoKey(), repoBudgetMs: 200, hostname: () => 'test-host' }));

  async function start(session: string, source: string, cwd = '/home/u/mcp-notes'): Promise<SessionHookStartReply> {
    const res = await app().request(`http://127.0.0.1${SESSION_HOOK_START_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-notes-capture': '1' },
      body: JSON.stringify({ session, cwd, source, host: 'test-host' }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as SessionHookStartReply;
  }

  beforeEach(() => {
    clock = T0;
    repoKey = async () => 'mcp-notes';
  });

  it('a fresh start answers the due reminders; resume, compact and a second start within 20 h answer none', async () => {
    const repo = repoAt(() => T0);
    const mine = await repo.add({ body: 'mine', dueAt: at(-HOUR), repo: 'mcp-notes' });
    await repo.add({ body: 'elsewhere', dueAt: at(-HOUR), repo: 'seer' });
    await seedReminders(repo);

    expect((await start(S1, 'resume')).reminders).toEqual([]);
    expect((await start(S1, 'startup')).reminders).toEqual([{ id: mine.id, body: 'mine', due_at: at(-HOUR).toISOString() }]);
    expect((await start(S1, 'compact')).reminders).toEqual([]);
    expect((await start(S2, 'startup')).reminders).toEqual([]);
    clock = at(REMINDER_REPEAT_MS);
    expect((await start(S2, 'clear')).reminders.map((r) => r.id)).toEqual([mine.id]);
    clock = at(7 * DAY_MS - 1);
    expect((await start(S3, 'startup')).reminders.map((r) => r.body)).toEqual(['mine']);
    clock = at(7 * DAY_MS + REMINDER_REPEAT_MS);
    expect((await start(S1, 'startup')).reminders.map((r) => r.body)).toEqual(['mine', expect.stringContaining('proposal item 3')]);
  });

  it('a done reminder is never answered again', async () => {
    const repo = repoAt(() => T0);
    const r = await repo.add({ body: 'handled', dueAt: at(-HOUR), repo: null });
    await repo.done(r.id);
    clock = at(30 * DAY_MS);
    expect((await start(S1, 'startup')).reminders).toEqual([]);
  });

  it('a repository that does not resolve in time answers only the reminders for every repository', async () => {
    const repo = repoAt(() => T0);
    await repo.add({ body: 'mine', dueAt: at(-HOUR), repo: 'mcp-notes' });
    await repo.add({ body: 'everywhere', dueAt: at(-HOUR), repo: null });
    repoKey = () => new Promise(() => {});
    expect((await start(S1, 'startup')).reminders.map((r) => r.body)).toEqual(['everywhere']);
  });
});

describe('notes-session end to end against a listening daemon', () => {
  it('puts a due reminder in a fresh session\'s context once, and nothing in the next one', async () => {
    const base = await h.listen();
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'notes-reminders-int-'));
    try {
      const env = { HOME: tmp, XDG_STATE_HOME: path.join(tmp, 'state'), NOTESD_PORT: new URL(base).port, CLAUDE_CODE_ENTRYPOINT: 'cli' };
      const r = await new RemindersRepo(h.deps.db).add({ body: 'the kettle is on', dueAt: new Date(Date.now() - 60_000), repo: null });
      const run = (session: string) =>
        runSession({ input: { session_id: session, cwd: tmp, source: 'startup' }, env, readText: async () => { throw new Error('ENOENT'); }, runTmux: async () => '', ppid: 1, hostname: () => 'test-host' });
      const first = (await run(S1))!.hookSpecificOutput.additionalContext;
      expect(first).toContain(`- Reminder #${r.id} (due `);
      expect(first).toContain('the kettle is on');
      expect(first).toContain('`remind`');
      const second = (await run(S2))!.hookSpecificOutput.additionalContext;
      expect(second).not.toContain('Reminder #');
      expect(second).toMatch(/node [0-9A-Z]{2}-[0-9A-Z]{2}/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('the remind tool on a real database', () => {
  it('adds with a due time, lists the open ones, marks one done so it is never listed or shown again', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerRemindTool(server, { db: h.deps.db }, { now: () => T0 });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientSide);
    const call = async (args: Record<string, unknown>) => {
      const res = (await client.callTool({ name: REMIND_TOOL_NAME, arguments: args })) as { isError?: boolean; content: Array<{ text?: string }> };
      return { isError: res.isError === true, text: res.content.map((c) => c.text ?? '').join('') };
    };
    try {
      const added = JSON.parse((await call({ action: 'add', body: 'look again', in_days: 2, repo: 'mcp-notes' })).text);
      expect(added.reminder).toMatchObject({ body: 'look again', repo: 'mcp-notes', due_at: at(2 * DAY_MS).toISOString(), done_at: null });
      const listed = JSON.parse((await call({ action: 'list' })).text);
      expect(listed.reminders.map((r: { id: number }) => r.id)).toEqual([added.reminder.id]);
      const done = JSON.parse((await call({ action: 'done', id: `#${added.reminder.id}` })).text);
      expect(done).toMatchObject({ changed: true, reminder: { id: added.reminder.id, done_at: T0.toISOString() } });
      expect(JSON.parse((await call({ action: 'list' })).text).reminders).toEqual([]);
      expect(await repoAt(() => T0).dueFor('mcp-notes', at(30 * DAY_MS))).toEqual([]);
      const missing = await call({ action: 'done', id: 999999 });
      expect(missing.isError).toBe(true);
      expect(missing.text).toContain('not_found');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
```
(If `Harness` exposes no `reset()`, drop that line: the existing `tests/integration/sessionHooks.int.test.ts:29` calls `h.reset()`, so it exists.)

**File:** `tests/integration/daemon.int.test.ts` (add `import { sql } from 'drizzle-orm';` to the imports, and this test inside `describe('startDaemon', ...)`, after the "starts and stops with the default (Agent SDK) backend" test at lines 83-95)
```ts
  it('stores the play-log reminder once at start, due seven days after the first start that had it', async () => {
    const t0 = new Date('2026-11-27T01:00:00.000Z');
    await daemon.deps.db.execute(sql`delete from reminders where seed_key = 'play-log-ranking'`);
    const firstDir = join(mkdtempSync(join(tmpdir(), 'notesd-')), 'data');
    const first = await startDaemon(config(firstDir), { chat: createStubChatBackend({ delayMs: 0 }), now: () => t0 });
    await first.stop();
    const againDir = join(mkdtempSync(join(tmpdir(), 'notesd-')), 'data');
    const again = await startDaemon(config(againDir), { chat: createStubChatBackend({ delayMs: 0 }), now: () => new Date('2026-12-01T00:00:00.000Z') });
    try {
      const rows = await again.deps.db.execute<{ repo: string; due_at: Date; done_at: Date | null }>(
        sql`select repo, due_at, done_at from reminders where seed_key = 'play-log-ranking'`,
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.repo).toBe('mcp-notes');
      expect(new Date(rows.rows[0]!.due_at).toISOString()).toBe('2026-12-04T01:00:00.000Z');
      expect(rows.rows[0]?.done_at).toBeNull();
    } finally {
      await again.stop();
      rmSync(firstDir, { recursive: true, force: true });
      rmSync(againDir, { recursive: true, force: true });
    }
  });
```
**Existing expectations checked (no change needed):**
- `tests/unit/hooks/notesSession.test.ts`: its fake `reply()` (line 52-53) carries no `reminders`, and `buildContext` without reminders returns the same string as before.
- `tests/integration/sessionHooks.int.test.ts`: replies are checked with `toMatchObject` (lines 63, 69, 79, 94); `truncateAll` empties `reminders` and nothing there adds one, so the end-to-end runs at lines 167-214 get the same context. A seed stored by another file's daemon is not due for 7 days in any case.
- `tests/integration/daemon.int.test.ts`: the existing tests do not read `reminders`; the daemon's start now logs one `[notesd] reminders: stored play-log-ranking` line when the seed is new.
**Impact:** `npm test` and `npm run test:int` green.

## Principles applied

- Laziness protocol: no new `AppDeps`/`ToolDeps` field and no reminders service; the route and the tool build `RemindersRepo` from the `db` they already have, the seed list is a static array, and no `instructions.ts` paragraph is added (the tool description and the hook's context carry the usage).
- Boundary discipline: the `remind` tool's arguments are validated and normalized once in `parseRemindArgs` into a typed `RemindRequest`; the hook validates the daemon's reply once in `remindersOf`; the repo trusts its typed input and the table's CHECKs are the last guard.
- Make illegal states unrepresentable: `RemindRequest` is a union where `add` always has exactly one due time and `done` an integer id (`due` and `in_days` both or neither cannot be built); "shown and stamped" is one SQL statement (`dueFor`), so a reminder can never be stamped without being returned or returned twice by two concurrent starts (`for update skip locked`); seed idempotence is the `seed_key` unique constraint, not a read-then-write check.
- Test behavior, not implementation: the tests drive the start route over HTTP, the real hook against a listening daemon, the tool through an MCP client and the daemon's real start, with injected clocks, and assert what the session would see.
- Sequence into verifiable units: schema + repo (Steps 1-2) are proved by the repo tests before the route, hook and tool are layered on, each with its own test.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test && npm run test:int && npm run docs:check` (one file: `npx vitest run tests/unit/hooks/notesSession.test.ts`, `npx vitest run tests/unit/mcp.remindTool.test.ts`)
**Proof:** a throwaway daemon from this checkout stores the seed at start, the `remind` tool works over `/mcp`, and the real `notes-session.mjs` against it shows a due reminder in a fresh session once, not on resume, not within 20 h, again after 20 h, never after done.
- Harness: `.claude/skills/verify-notesd` (`V=.claude/skills/verify-notesd/scripts/verify.sh`; `$V up` prints `RUN=` and `URL=`; set `PORT=${URL##*:}`, `T=$(mktemp -d)`, `TOP=$(git rev-parse --show-toplevel)`, and
  `hook() { printf '{"session_id":"%s","cwd":"%s","source":"%s","hook_event_name":"SessionStart"}' "$1" "$TOP" "$2" | env -i PATH="$PATH" HOME="$T" XDG_STATE_HOME="$T/state" NOTESD_PORT="$PORT" CLAUDE_CODE_ENTRYPOINT=cli node "$TOP/claude/hooks/notes-session.mjs"; }`;
  `$V mcp` output's first line is a header, so pipe through `sed 1d` before `jq`). Run from a checkout of mcp-notes whose main checkout directory is `mcp-notes` (the repository key comes from it).
- Feature-map entries: `features/reminders.md` (new), `features/projects.md` (neighbor)
- Journeys:
  - **J1** · traces R4.3 — `$V up`; `$V sql RUN "select seed_key, repo, round(extract(epoch from due_at - created_at)/86400) as days, done_at is null as open, body like '%proposal item 3%' and body like '%provider or torrent%' and body like '%/movies/health%' and body like '%direct_stream_health%' as names_it from reminders"`; `$V restart RUN`; `$V sql RUN "select count(*) from reminders where seed_key = 'play-log-ranking'"` → passes when the first query prints exactly one row `play-log-ranking | mcp-notes | 7 | t | t`, and after the restart the count is still `1`
  - **J2** · traces R4.4 — `A=$($V mcp RUN remind '{"action":"add","body":"verify: later","due":"2030-01-02T09:00:00+07:00"}' | sed 1d)`; `$V mcp RUN remind '{"action":"list"}'`; `ID=$(jq -r .reminder.id <<<"$A")`; `$V mcp RUN remind "{\"action\":\"done\",\"id\":\"#$ID\"}"`; `$V mcp RUN remind '{"action":"list"}'`; `$V mcp RUN remind "{\"action\":\"done\",\"id\":$ID}"`; `$V sql RUN "select done_at is not null from reminders where id = $ID"`; `$V mcp RUN remind '{"action":"add","body":"x"}'` → passes when the add answers `reminder.due_at` `2030-01-02T02:00:00.000Z` and `repo: null`; the first list holds `$ID` and the seed; the first done answers `changed: true`; the second list no longer holds `$ID`; the second done answers `changed: false`; the sql prints `t`; the last call is a tool error containing `invalid_input`
  - **J3** · traces R4.1 — `ID=$($V mcp RUN remind '{"action":"add","body":"verify: the kettle is on","in_days":0,"repo":"mcp-notes"}' | sed 1d | jq -r .reminder.id)`; `$V mcp RUN remind '{"action":"add","body":"verify: another repo only","in_days":0,"repo":"some-other-repo"}'`; `hook 11111111-1111-4111-8111-000000000001 startup > $T/a.json`; `jq -r .hookSpecificOutput.additionalContext $T/a.json`; then `$V exec RUN "update reminders set due_at = now() - interval '1 minute' where seed_key = 'play-log-ranking'"`; `hook 11111111-1111-4111-8111-000000000005 clear | jq -r .hookSpecificOutput.additionalContext` → passes when the first context starts with `This Claude Code session is node ` and, after a blank line, holds `- Reminder #$ID (due `, `verify: the kettle is on`, `at the start of your first reply` and ``mark it done with the notes MCP tool `remind` ``, and does not hold `another repo only` or `proposal item 3`; the second context holds `proposal item 3` and `http://localhost:7317/movies/health`
  - **J4** · traces R4.2 — continuing J3: `hook 11111111-1111-4111-8111-000000000002 startup`; `hook 11111111-1111-4111-8111-000000000001 resume`; `$V exec RUN "update reminders set last_shown_at = now() - interval '21 hours' where id = $ID"`; `hook 11111111-1111-4111-8111-000000000003 startup`; `$V mcp RUN remind "{\"action\":\"done\",\"id\":$ID}"`; `$V exec RUN "update reminders set last_shown_at = now() - interval '21 hours' where id = $ID"`; `hook 11111111-1111-4111-8111-000000000004 startup` → passes when the outputs of session 2 and of the resume hold no `Reminder #` (shown less than 20 h ago; a resume is not fresh), session 3 holds `Reminder #$ID` (20 h passed), and session 4 holds no `Reminder #$ID` (done); together with J3's first context, where the not-yet-due seed was absent, this covers not due, done, and shown less than 20 h ago
- Neighbor check: the session-graph hook still works and stays quiet when the daemon is down — `hook 11111111-1111-4111-8111-000000000009 startup | jq -r .hookSpecificOutput.additionalContext` prints the node-id sentences (`node XX-XX`, `No parent session is recorded for it.`) with no reminder block once J4 is done; `$V sql RUN "select node_id from cc_sessions where session_id = '11111111-1111-4111-8111-000000000009'"` prints that node id; `printf '{"session_id":"11111111-1111-4111-8111-00000000000a","cwd":"/tmp","source":"startup"}' | env -i PATH="$PATH" HOME="$T" XDG_STATE_HOME="$T/state" NOTESD_PORT=1 CLAUDE_CODE_ENTRYPOINT=cli node "$TOP/claude/hooks/notes-session.mjs"; echo "exit=$?"` prints only `exit=0` (feature map: `features/projects.md`, hooks)
- Cost: none (no model call, no network beyond loopback). `$V down RUN` at the end.
**Exit criteria:** `npm run typecheck`, `npm test`, `npm run test:int` and `npm run docs:check` are green; J1-J4 and the neighbor check pass on a throwaway daemon; `drizzle/0045_reminders.sql` creates only `reminders`.

## Handoffs

- **Phase 1:** must land `stream_play_log` in `src/db/schema.ts` and `drizzle/0044_*` (+ snapshot, journal) before Step 1 runs `drizzle-kit generate`; this phase appends after Phase 1's table and adds `reminders, ` to the `truncateAll` statement that Phase 1 also extends. Both phases edit `src/daemon.ts` (different places: this phase only the options interface and one block after the import merge), `CLAUDE.md` (different bullets) and `docs/guide/architecture.md` (different rows).
- **Phase 3:** both phases add one register line to `src/mcp/server.ts`, edit `scripts/docs/httpRoutes.ts` (different entries) and regenerate `docs/guide/reference/mcp-tools.md` and `http-api.md`; whoever merges second re-runs `npm run docs:gen` instead of merging the generated files. Both add a row to `.claude/skills/verify-notesd/features/README.md`. The seeded reminder's text names Phase 3's `/movies/health` page and `direct_stream_health` tool; reconciled: phase 3's plan uses exactly those two names (`/movies/${MOVIES_HEALTH_SEGMENT}` with `MOVIES_HEALTH_SEGMENT = 'health'`, `STREAM_HEALTH_TOOL_NAME = 'direct_stream_health'`), so the body stands. The per-file ownership is under **Shared files** above.
- **Not in this set:** retaking the movies guide's live pictures (`stream.png`, a new `health.png`) and deciding proposal item 3 are what the seeded reminder asks the owner to do; nothing here does them.
- **Untraced criteria:** none.

## Rollback

Revert this phase's commit(s). The code stops reading and writing `reminders`; the table and migration `0045` stay harmless (drop them with a follow-up migration only if wanted). Reverting `notes-session.mjs` returns the start context to the node-id sentences; an older hook ignores the reply's `reminders` key, so the hook and the daemon may be reverted in either order.
