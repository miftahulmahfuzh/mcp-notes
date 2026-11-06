> Adopted from `/home/miftah/.worktrees/mcp-notes/session-search-context/.workflows/plan/SESSION_SEARCH_CONTEXT_PLAN.md` phase 3. Source: `.workflows/plan/session-search-context/phase-3.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 3: Persist Claude's replies (cc_session_replies), tail + backfill

**Plan set:** `SESSION_SEARCH_CONTEXT_PLAN.md`
**Analysis:** `.workflows/analyze/20261106-145826-SSC7_code_analyzer.md`
**Satisfies:** R2 — Claude's answers to the user in a session are persisted per node
**Depends on:** Phase 2 (migration 0013 and its drizzle snapshot must exist before 0014 is generated; `schema.ts` is quoted as it looks after Phase 2)
**Difficulty:** HARD
**Package:** `src/sessions` (+ `src/db/schema.ts`, `drizzle/`)

---

## Goal

After this phase, every human prompt of a session that Claude answered has one row in the new
`cc_session_replies` table: the assistant text after the last tool call of that turn, redacted
with `redactSecrets`, capped at 16 KiB, keyed to the prompt's `seq`, with a generated `simple`
tsvector. The tail ingester writes it in the same transaction as the prompts. A turn that is split
across two reads, or across a daemon restart, ends with the same row a single read from byte 0
gives. Sessions ingested before this phase are filled once by the existing prompts backfill
(new `cc_sessions.replies_version`). The empty table `cc_session_reply_embeddings` is created for
Phase 4's worker. Nothing reads replies yet: no search, API, MCP or web change.

## Interface Contract

**Deletes:** nothing.

**Renames:** nothing.

**Creates:**
- Table `cc_session_replies` (migration `drizzle/0014_session_replies.sql`, journal idx 14, tag `0014_session_replies`):
  `session_id text not null` (FK `cc_session_replies_session_id_cc_sessions_session_id_fk` → `cc_sessions.session_id` on delete cascade),
  `seq integer not null` (= the `cc_session_prompts.seq` of the prompt it answers; no FK to `cc_session_prompts`, on purpose, see Step 6),
  `at timestamptz` (timestamp of the record holding the reply's last text block),
  `text text not null` (redacted, never blank, at most `MAX_REPLY_STORE_CHARS` UTF-16 units),
  `truncated boolean not null default false`,
  `search_tsv tsvector generated always as (to_tsvector('simple', "text")) stored`.
  PK constraint `cc_session_replies_session_id_seq_pk (session_id, seq)`; index `cc_session_replies_search_gin` (gin on `search_tsv`).
- Table `cc_session_reply_embeddings` (same migration), empty until Phase 4:
  `session_id text not null`, `seq integer not null`, `embedding vector(1536)` (nullable), `sha text not null`, `model text not null`,
  `attempts integer not null default 0`, `last_error text`, `next_attempt_at timestamptz`, `embedded_at timestamptz`,
  `updated_at timestamptz not null default now()`. No `created_at`.
  PK constraint `cc_session_reply_embeddings_session_id_seq_pk (session_id, seq)`;
  FK `cc_session_reply_embeddings_reply_fk (session_id, seq)` → `cc_session_replies (session_id, seq)` on delete cascade;
  indexes `cc_session_reply_embeddings_embedding_hnsw_idx` (hnsw, `vector_cosine_ops`) and `cc_session_reply_embeddings_next_attempt_idx` (btree `next_attempt_at`).
- Column `cc_sessions.replies_version integer not null default 0` (same migration).
- Drizzle exports (`src/db/schema.ts`): `ccSessionReplies`, `ccSessionReplyEmbeddings`, types `CcSessionReplyRow`, `NewCcSessionReplyRow`, `CcSessionReplyEmbeddingRow`; `ccSessions.repliesVersion`.
- `src/sessions/types.ts`: constants `REPLIES_VERSION = 1`, `MAX_REPLY_STORE_CHARS = 16 * 1024`; types `PatchReply`, `LeadingReply`, `ReplyContent`, `StoredReply`, `StoredLeadingReply`; re-exports `CcSessionReplyRow`, `CcSessionReplyEmbeddingRow`.
- `src/sessions/merge.ts`: `replyCut`, `storedReplies`, `storedLeadingReply`, `nextLeadingReply`, `sameReply`.
- `src/sessions/transcript.ts`: `TranscriptDelta.replies: PatchReply[]`, `TranscriptDelta.leadingReply: LeadingReply | null`.
- `src/sessions/repo.ts`: private `writeReplyRows`, `writeLeadingReply` (no new public method).

**Signature changes:**
- `TranscriptPatch` gains optional `replies?: PatchReply[]` and `leadingReply?: LeadingReply | null` (additive).
- `PromptsReplacement` gains optional `replies?: PatchReply[]` (additive).
- `PromptsBackfillCandidate` gains required `promptsVersion: number`.
- `SessionRow` (= `Omit<CcSessionRow, 'searchTsv'>`) gains `repliesVersion: number` (every full `SessionRow` literal must set it).
- private `SessionsRepo.writePromptRows(tx, sessionId, prompts, images, replace)` → `writePromptRows(tx, sessionId, prompts, images, replies, leading, replace)`.
- Behavior: `SessionsRepo.promptsBackfillCandidates(host)` now also returns rows with `replies_version < REPLIES_VERSION`; `replacePrompts` and a from-byte-0 `upsertFromTranscript` set `replies_version = REPLIES_VERSION`; `redactStoredPrompts` deletes the session's replies.

**Requires (from earlier phases):** Phase 2's `drizzle/0013_session_commit_search.sql`, `drizzle/meta/0013_snapshot.json` and journal entry 13 exist, and `src/db/schema.ts` carries Phase 2's `ccSessions.searchTsv` and `ccSessionEmbeddings.textVersion` edits. This phase does not touch those definitions.

**Leaves alone (owned by others):** `src/sessions/search.ts` (Phases 1, 5); `src/search/blend.ts` (Phase 5); the reply embedding worker, `src/sessions/replyEmbeddings.ts`, `src/background.ts` and any write to `cc_session_reply_embeddings` (Phase 4); `src/sessions/readModel.ts`, `view.ts`, `src/mcp/*`, `src/http/*`, `src/chat/*`, `README.md`, `.claude/skills/verify-notesd/features/*` (Phase 5); `ccSessions.searchTsv`, `ccSessionEmbeddings`, `summarize.ts`, `summaryWorker.ts` (Phase 2); everything under `web/` (R5).

## Files

| File | Action | What changes |
|---|---|---|
| `src/db/schema.ts:45-49` | modify | header comment: one sentence for migration 0014 (after Phase 2's 0013 sentence) |
| `src/db/schema.ts:553-559` | modify | `ccSessions.repliesVersion` column after `promptsVersion` |
| `src/db/schema.ts:663` (after `ccSessionPromptImages`) | modify | new tables `ccSessionReplies`, `ccSessionReplyEmbeddings` |
| `src/db/schema.ts:836` (after `NewCcSessionPromptImageRow`) | modify | row types |
| `drizzle/0014_session_replies.sql` | create (generated) | two tables, one column, FKs, indexes |
| `drizzle/meta/0014_snapshot.json` | create (generated) | drizzle snapshot |
| `drizzle/meta/_journal.json` | modify (generated) | entry idx 14 |
| `src/sessions/types.ts:10-17,99,104,156,186,198-213` | modify | constants, reply types, patch/replacement/candidate fields |
| `src/sessions/transcript.ts:2-16,44,116-150,431-458,512-539,605-610,638-664,700-730` | modify | reply capture in `TranscriptAccumulator`, delta + patch fields |
| `src/sessions/merge.ts:3-19,158` | modify | reply redaction/cap/merge helpers |
| `src/sessions/repo.ts:2,6,12-67,120-122,173-178,291-327,342-373,391-465` | modify | replies written with prompts; backfill candidates; versions |
| `src/sessions/ingest.ts:7,47-56,134-137,600-637` | modify | backfill passes replies; skips gone transcripts without a lock |
| `tests/helpers/memoryIngestStore.ts:1-28,77,95,164-209` | modify | in-memory replies with the same pure helpers |
| `tests/integration/setup.ts:50` | modify | `truncateAll` includes both new tables |
| `tests/unit/sessions/merge.test.ts:57` | modify | `repliesVersion: 0` in the row literal |
| `tests/unit/sessions/schema.test.ts:8` | modify | reply vector width assertion |
| `tests/unit/sessions/replies.test.ts` | create | accumulator, helpers, split-at-every-line equivalence lever |
| `tests/integration/sessions.replies.int.test.ts` | create | schema, ingest, straddle + restart, redaction, cap, sidechain, backfill |
| `CLAUDE.md:41` | modify | sessions paragraph mentions `cc_session_replies` / `drizzle/0014` |

No committed fixture changes. The existing fixtures already hold every reply shape the phase
needs: `…0001` (narration, then tool calls, then the final text "Done: the plan is written.", a
peer message and an interrupt in between), `…0002` (a thinking block, then text) and `…0005`
(106 text-only turns). Adding a fixture file would change the file and row counts that
`tests/unit/sessions/ingest.test.ts` (`files: 5, upserted: 4`, `rows.size` 3) and
`sessions.ingest.int.test.ts` assert. Straddle, sidechain, redaction and cap cases append lines to
the per-test copy made by `copyFixtureClaudeHome()`.

## Implementation Steps

### Step 0: Install dependencies if the worktree has none
**File:** none (worktree root)
**Change:** the worktree has no `node_modules` until a phase installs them. Run once, before anything else:
```sh
cd /home/miftah/.worktrees/mcp-notes/session-search-context
[ -d node_modules ] || npm ci
```
**Impact:** none on the tree.

### Step 1: Schema — `cc_session_replies`, `cc_session_reply_embeddings`, `cc_sessions.replies_version`

**File:** `src/db/schema.ts:45-49` (header comment). Insert after Phase 2's "Migration 0013 ..."
sentence (if Phase 2's sentence is absent, after the 0011 sentence ending "...never written to
Seer."), before "Change a table here, then `npm run db:generate`":

```ts
 * Migration 0014 (session replies) adds `cc_session_replies` (Claude's reply to each prompt of a
 * session, redacted), `cc_session_reply_embeddings` (one vector per reply, filled in the
 * background) and `cc_sessions.replies_version`; src/sessions/repo.ts is their only writer.
```

**File:** `src/db/schema.ts:553-559` — replace the `promptsVersion` doc + column with:

```ts
    /**
     * Which prompt storage this row's prompts follow (migration 0010). 0 = legacy: `prompts`
     * holds truncated, unredacted excerpts and `cc_session_prompts` is empty. Higher versions are
     * defined by src/sessions/types.ts; the owning host's backfill raises it once.
     */
    promptsVersion: integer('prompts_version').notNull().default(0),
    /**
     * Whether `cc_session_replies` was written by a read of the whole transcript (migration 0014).
     * 0 = ingested before replies were stored. src/sessions/types.ts REPLIES_VERSION; the owning
     * host's prompts backfill raises it once while the transcript is still on disk.
     */
    repliesVersion: integer('replies_version').notNull().default(0),
```

**File:** `src/db/schema.ts:663` — insert after the closing `)` of `ccSessionPromptImages` and before the `noteSessionLinks` doc comment:

```ts
/**
 * Claude's reply to each prompt of a session (migration 0014): the assistant text after the last
 * tool call of the turn the prompt started, i.e. what Claude said back to the user. Narration
 * between tool calls and subagent (sidechain) text are never stored. `seq` is the
 * `cc_session_prompts.seq` of the prompt it answers; a prompt whose turn ended in a tool call has
 * no row. `text` is stored only after src/sessions/redact.ts `redactSecrets` and is cut at
 * MAX_REPLY_STORE_CHARS (`truncated`). There is deliberately no foreign key to
 * `cc_session_prompts`: a from-byte-0 replace deletes and reinserts every prompt row, and a cascade
 * from it would drop every reply and its vector each time. Written only by src/sessions/repo.ts, in
 * the same transaction as the prompts. Removing the session drops its replies.
 */
export const ccSessionReplies = pgTable(
  'cc_session_replies',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => ccSessions.sessionId, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    at: timestamp('at', { withTimezone: true, mode: 'date' }),
    text: text('text').notNull(),
    truncated: boolean('truncated').notNull().default(false),
    /** Full text (`simple`) over the reply. Never selected by the app. */
    searchTsv: tsvector('search_tsv').generatedAlwaysAs(sql`to_tsvector('simple', "text")`),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] }), index('cc_session_replies_search_gin').using('gin', t.searchTsv)],
)

/**
 * One vector per reply (migration 0014), mirroring `cc_session_embeddings`: current iff
 * `embedding is not null`, `sha` equals the sha256 of the reply's current `text`, and `model`
 * equals the embedder's model. A reply whose text changes keeps its row (stale by sha) until the
 * background worker re-embeds it; deleting the reply drops the vector. Width =
 * EMBEDDING_DIMENSIONS (a unit test asserts it).
 */
export const ccSessionReplyEmbeddings = pgTable(
  'cc_session_reply_embeddings',
  {
    sessionId: text('session_id').notNull(),
    seq: integer('seq').notNull(),
    /** Null while the latest attempt for `sha` failed. */
    embedding: vector('embedding', { dimensions: 1536 }),
    sha: text('sha').notNull(),
    model: text('model').notNull(),
    attempts: integer('attempts').notNull().default(0),
    /** At most 500 chars, keys redacted (src/embeddings/state.ts `clampError`). */
    lastError: text('last_error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'date' }),
    embeddedAt: timestamp('embedded_at', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.seq] }),
    foreignKey({
      name: 'cc_session_reply_embeddings_reply_fk',
      columns: [t.sessionId, t.seq],
      foreignColumns: [ccSessionReplies.sessionId, ccSessionReplies.seq],
    }).onDelete('cascade'),
    index('cc_session_reply_embeddings_embedding_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('cc_session_reply_embeddings_next_attempt_idx').on(t.nextAttemptAt),
  ],
)
```

**File:** `src/db/schema.ts:836` — after `export type NewCcSessionPromptImageRow = ...`:

```ts
export type CcSessionReplyRow = typeof ccSessionReplies.$inferSelect
export type NewCcSessionReplyRow = typeof ccSessionReplies.$inferInsert
export type CcSessionReplyEmbeddingRow = typeof ccSessionReplyEmbeddings.$inferSelect
```

**Impact:** `SessionRow` gains `repliesVersion`; `tests/helpers/memoryIngestStore.ts` and
`tests/unit/sessions/merge.test.ts` build full `SessionRow` literals and are fixed in Steps 8/9.
`repo.ts` `SESSION_COLUMNS` (all columns but `searchTsv`) now selects `replies_version`, so **the
daemon must not run this code against an unmigrated database** (see Handoffs, "Landing").

### Step 2: Generate migration 0014

**Files:** `drizzle/0014_session_replies.sql`, `drizzle/meta/0014_snapshot.json`, `drizzle/meta/_journal.json`

Run in the worktree after Phase 2 has landed (its 0013 snapshot is the diff base). `drizzle.config.ts`
throws without a direct (non-pooler) URL even for `generate`, which never connects:

```sh
cd /home/miftah/.worktrees/mcp-notes/session-search-context
test -f drizzle/meta/0013_snapshot.json || { echo "Phase 2 has not landed: stop"; exit 1; }
DATABASE_URL_UNPOOLED=postgres://gen:gen@127.0.0.1:5432/gen npx drizzle-kit generate --name session_replies
```

The generated SQL must be exactly these statements (order of the last lines may differ; nothing
else may appear — in particular nothing touching `cc_sessions.search_tsv` or `cc_session_embeddings`,
which would mean the 0013 snapshot was missing or stale):

```sql
CREATE TABLE "cc_session_replies" (
	"session_id" text NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone,
	"text" text NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"search_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', "text")) STORED,
	CONSTRAINT "cc_session_replies_session_id_seq_pk" PRIMARY KEY("session_id","seq")
);
--> statement-breakpoint
CREATE TABLE "cc_session_reply_embeddings" (
	"session_id" text NOT NULL,
	"seq" integer NOT NULL,
	"embedding" vector(1536),
	"sha" text NOT NULL,
	"model" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"embedded_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cc_session_reply_embeddings_session_id_seq_pk" PRIMARY KEY("session_id","seq")
);
--> statement-breakpoint
ALTER TABLE "cc_sessions" ADD COLUMN "replies_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cc_session_replies" ADD CONSTRAINT "cc_session_replies_session_id_cc_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."cc_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cc_session_reply_embeddings" ADD CONSTRAINT "cc_session_reply_embeddings_reply_fk" FOREIGN KEY ("session_id","seq") REFERENCES "public"."cc_session_replies"("session_id","seq") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cc_session_replies_search_gin" ON "cc_session_replies" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "cc_session_reply_embeddings_embedding_hnsw_idx" ON "cc_session_reply_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "cc_session_reply_embeddings_next_attempt_idx" ON "cc_session_reply_embeddings" USING btree ("next_attempt_at");
```

Checks (each must print the stated value):
```sh
jq -r '.entries[-1].tag' drizzle/meta/_journal.json            # 0014_session_replies
grep -c 'search_tsv' drizzle/0014_session_replies.sql           # 2 (the column and its index)
grep -c 'cc_session_embeddings\|"cc_sessions" DROP' drizzle/0014_session_replies.sql   # 0
```
Never hand-edit an applied migration; this one is new, so a mismatch means regenerate, not edit.

**Impact:** additive only (two new tables, one column with a default). An older daemon on the
other laptop keeps working against the migrated DB (it never selects the new column).

### Step 3: Types and constants

**File:** `src/sessions/types.ts:10-17` — re-exports become:

```ts
export type {
  CcSessionPromptRow,
  CcSessionReplyEmbeddingRow,
  CcSessionReplyRow,
  ModelUsage,
  NewCcSessionPromptRow,
  ParentLinkSource,
  SessionCommit,
  SessionPrompt,
} from '../db/schema.js';
```

**File:** `src/sessions/types.ts:99` — after `export const PROMPTS_VERSION = 3;` insert:

```ts
/**
 * `cc_sessions.replies_version` of a row whose `cc_session_replies` were written by a read of its
 * transcript from byte 0 (the tail ingester's first read of a file, or the one-time backfill;
 * migration 0014). 0 = ingested before replies were stored: the owning host's prompts backfill
 * re-reads such a row once (`SessionsRepo.replacePrompts` writes prompts and replies together).
 * A row whose transcript is gone stays at 0 with no replies: Claude Code pruned the only copy.
 *
 * Its own counter rather than a PROMPTS_VERSION bump: `GET /api/sessions/:nodeId/prompts` reports a
 * row below PROMPTS_VERSION as `transcript_pruned`, so a bump would mislabel every complete row
 * whose transcript is gone, and every row of a host that has not upgraded yet (a UI change, R5).
 */
export const REPLIES_VERSION = 1;
```

**File:** `src/sessions/types.ts:104` — after `export const MAX_FINAL_MESSAGE_CHARS = 8000;` insert:

```ts
/**
 * Ceiling on one stored reply (`cc_session_replies.text`, UTF-16 code units), applied after
 * redaction; a longer reply is cut here and stored with `truncated = true`. Measured 2026-11-06
 * over 2511 replies: median 1.4k chars, p90 3.2k, max 20k.
 */
export const MAX_REPLY_STORE_CHARS = 16 * 1024;
```

**File:** `src/sessions/types.ts:151-156` — in `TranscriptPatch`, after the `prompts?: PatchPrompt[];` member insert:

```ts
  /**
   * Claude's reply to prompts of this read (each the assistant text after its turn's last
   * tool_use), raw: SessionsRepo redacts and caps them. `prompt` indexes `prompts`. Written to
   * `cc_session_replies` with that prompt's seq, in the same transaction as the prompts (the whole
   * list on fromOffset 0).
   */
  replies?: PatchReply[];
  /**
   * What this read does to the reply of the last prompt stored before it, when a turn straddles
   * two reads. Ignored on fromOffset 0.
   */
  leadingReply?: LeadingReply | null;
```

**File:** `src/sessions/types.ts:186` — after the `PatchPrompt` interface insert:

```ts
/** Claude's reply to one prompt, as ingest read it: raw text, not redacted, not capped. */
export interface PatchReply {
  /** 0-based index of the prompt it answers in the same patch's `prompts`. */
  prompt: number;
  /** The turn's final text blocks, each trimmed, joined by a blank line. Never blank. */
  text: string;
  /** Timestamp of the record that holds the reply's last text block. */
  at: string | null;
}

/**
 * The reply to the session's last stored prompt, as a read that starts mid-turn sees it.
 * `append`: only assistant text came before this read's first prompt (or its end), so it continues
 * the stored reply. `replace`: a tool_use came first, so the stored reply was narration; `reply`
 * (the text after that tool_use) replaces it, and null deletes it.
 */
export type LeadingReply =
  | { kind: 'append'; text: string; at: string | null }
  | { kind: 'replace'; reply: { text: string; at: string | null } | null };

/** One `cc_session_replies` row's content, redacted and capped, as SessionsRepo writes it. */
export interface ReplyContent {
  text: string;
  at: Date | null;
  truncated: boolean;
}

/** A reply ready to write. `prompt` indexes the stored prompts (`storedPrompts`) it answers. */
export interface StoredReply extends ReplyContent {
  prompt: number;
}

/** A LeadingReply redacted. An `append` text is capped only once it is joined to the stored reply. */
export type StoredLeadingReply =
  | { kind: 'append'; text: string; at: Date | null }
  | { kind: 'replace'; reply: ReplyContent | null };
```

**File:** `src/sessions/types.ts:197-213` — replace `PromptsBackfillCandidate` and `PromptsReplacement` with:

```ts
/**
 * A row of this host below PROMPTS_VERSION (legacy, or redacted in place from excerpts) or below
 * REPLIES_VERSION (ingested before replies were stored).
 */
export interface PromptsBackfillCandidate {
  sessionId: string;
  transcriptPath: string | null;
  transcriptOffset: number;
  /** The row's prompts_version when listed: a gone transcript at PROMPTS_VERSION_EXCERPTS or above is skipped without a write. */
  promptsVersion: number;
}

/** The prompts (and replies) of a transcript re-read from byte 0 up to `upToOffset` (the row's stored offset). */
export interface PromptsReplacement {
  /** Must equal the stored transcript_offset when the write happens (compare-and-set). */
  upToOffset: number;
  prompts: PatchPrompt[];
  /** Claude's replies to `prompts` (`prompt` indexes it); they replace every stored reply of the session. */
  replies?: PatchReply[];
  /** First human prompt of the file; null keeps the stored one (redacted). */
  firstPrompt: string | null;
  /** Latest `last-prompt` record of the file; null keeps the stored one (redacted). */
  lastPrompt: string | null;
}
```

**Impact:** typecheck fails in `ingest.ts` and `memoryIngestStore.ts` (`promptsVersion` on
candidates) until Steps 7/8 land; they are in the same phase.

### Step 4: Capture replies in `TranscriptAccumulator`

**File:** `src/sessions/transcript.ts:2-16` — the import becomes:

```ts
import {
  MAX_COMMITS,
  MAX_FILES_EDITED,
  MAX_FINAL_MESSAGE_CHARS,
  MAX_IMAGES_PER_PROMPT,
  MAX_PLAN_DOCS,
  MAX_PROMPT_STORE_CHARS,
  MAX_TITLE_CHARS,
  type LeadingReply,
  type ModelUsage,
  type PatchPrompt,
  type PatchPromptImage,
  type PatchReply,
  type SessionCommit,
  type TokenCounts,
  type TranscriptPatch,
} from './types.js';
```

**File:** `src/sessions/transcript.ts:44` — add a bullet to the header comment, after the
"`api-request*`, `file-history-*` ..." bullet:

```ts
 * - Claude's reply to a prompt is the assistant text after the last tool_use of its turn (the same
 *   `segment` that gives finalMessage), taken when the next prompt is recorded or the read ends.
 *   Narration before a tool call and sidechain text are never a reply. A read that starts mid-turn
 *   reports what it does to the earlier read's last reply (`leadingReply`): text alone continues
 *   it, a tool_use first supersedes it. Nothing about the segment is carried between reads, so a
 *   daemon restart mid-turn stores the same rows a single read would.
```

**File:** `src/sessions/transcript.ts:116-150` — `TranscriptDelta`: after the `finalMessage` member add:

```ts
  /**
   * Claude's reply to prompts of this read: for each prompt, the assistant text after the last
   * tool_use of its turn (the last prompt's reply is what the read has so far). `prompt` indexes
   * `prompts`; a turn that ended in a tool call has none. Always empty for a sidechain accumulator.
   */
  replies: PatchReply[];
  /**
   * What this read does to the reply of the last prompt of an earlier read (assistant records
   * before this read's first prompt); null when it leaves it alone. Meaningful only for a read that
   * does not start at byte 0. Always null for a sidechain accumulator.
   */
  leadingReply: LeadingReply | null;
```

**File:** `src/sessions/transcript.ts:453-458` — in the class fields, replace
`private segment: string[] = [];` with the block below (the other fields stay as they are):

```ts
  private segment: string[] = [];
  /** Timestamp of the record that added the segment's latest text block. */
  private segmentAt: string | null = null;
  /** Index in `prompts` of the prompt the current segment answers; -1 while it answers a prompt of an earlier read. */
  private replyOwner = -1;
  /** A tool_use came in this read before its first prompt: the earlier read's stored reply was narration. */
  private leadingCleared = false;
  /** What this read does to the earlier read's last reply, fixed when this read's first prompt arrives. */
  private leading: LeadingReply | null = null;
  /** Replies of prompts of this read whose turn has ended (a later prompt was recorded). */
  private readonly replies: PatchReply[] = [];
```

**File:** `src/sessions/transcript.ts:512-539` — `delta()` becomes:

```ts
  delta(): TranscriptDelta {
    const models: Record<string, ModelUsage> = {};
    for (const [model, usage] of this.models) models[model] = { ...usage };
    const tail = this.sidechain ? null : this.segmentReply();
    const replies =
      this.sidechain ? [] : this.replyOwner >= 0 && tail !== null ? [...this.replies, { prompt: this.replyOwner, ...tail }] : [...this.replies];
    const leadingReply = this.sidechain ? null : this.replyOwner >= 0 ? this.leading : this.leadingFrom(tail);
    return {
      sessionId: this.sessionId,
      records: this.records,
      cwd: this.cwd,
      entrypoint: this.entrypoint,
      branch: this.branch,
      version: this.version,
      name: this.name,
      customTitle: this.customTitle,
      aiTitle: this.aiTitle,
      lastPrompt: this.lastPrompt,
      firstAt: this.firstMs === null ? null : new Date(this.firstMs),
      lastAt: this.lastMs === null ? null : new Date(this.lastMs),
      firstPrompt: this.firstPrompt,
      prompts: [...this.prompts],
      tokens: { ...this.tokens },
      models,
      costUsd: this.costUsd,
      commits: [...this.commits.values()].slice(-MAX_COMMITS),
      commitRanges: [...this.commitRanges.values()],
      filesEdited: [...this.filesEdited],
      planDocs: [...this.planDocs],
      finalMessage: this.segment.length > 0 ? cut(this.segment.join('\n\n').trim(), MAX_FINAL_MESSAGE_CHARS) : null,
      replies,
      leadingReply,
    };
  }
```

**File:** `src/sessions/transcript.ts:605-610` — `recordPrompt` becomes, followed by three new private methods:

```ts
  private recordPrompt(text: string, at: string | null, images: PatchPromptImage[] = []): void {
    this.closeReply();
    const stored = storeCut(text);
    this.firstPrompt ??= stored.text;
    this.prompts.push({ text: stored.text, at, truncated: stored.truncated, ...(images.length > 0 ? { images } : {}) });
    this.replyOwner = this.prompts.length - 1;
    this.segment = [];
    this.segmentAt = null;
  }

  /** A new prompt ends the current turn: its segment becomes the reply of the prompt it answers. */
  private closeReply(): void {
    if (this.sidechain) return;
    const reply = this.segmentReply();
    if (this.replyOwner >= 0) {
      if (reply !== null) this.replies.push({ prompt: this.replyOwner, ...reply });
      return;
    }
    this.leading = this.leadingFrom(reply);
  }

  /** The segment as a reply: each text block trimmed, joined by a blank line. Null when empty. */
  private segmentReply(): { text: string; at: string | null } | null {
    if (this.segment.length === 0) return null;
    return { text: this.segment.map((s) => s.trim()).join('\n\n'), at: this.segmentAt };
  }

  /** What `reply` (text before this read's first prompt) does to the earlier read's last reply. */
  private leadingFrom(reply: { text: string; at: string | null } | null): LeadingReply | null {
    if (this.leadingCleared) return { kind: 'replace', reply };
    return reply === null ? null : { kind: 'append', text: reply.text, at: reply.at };
  }
```

**File:** `src/sessions/transcript.ts:638-664` — `addAssistant` becomes:

```ts
  private addAssistant(record: TranscriptRecord): void {
    const message = record.message;
    if (!isObject(message)) return;
    const rawModel = nonEmpty(message.model);
    const model = rawModel === '<synthetic>' ? null : rawModel;
    const id = nonEmpty(message.id);
    if (id === null) {
      this.addUsage(model, message.usage);
    } else if (!this.recentMessageIds.includes(id)) {
      this.addUsage(model, message.usage);
      this.recentMessageIds.push(id);
      if (this.recentMessageIds.length > RECENT_MESSAGE_IDS * 2) {
        this.recentMessageIds.splice(0, this.recentMessageIds.length - RECENT_MESSAGE_IDS);
      }
    }
    const at = typeof record.timestamp === 'string' ? record.timestamp : null;
    const content = message.content;
    const blocks: unknown[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    for (const block of blocks) {
      if (!isObject(block)) continue;
      if (block.type === 'tool_use') {
        this.segment = [];
        this.segmentAt = null;
        // Text before this tool call answered an earlier read's prompt: it was narration, not the reply.
        if (this.replyOwner < 0) this.leadingCleared = true;
        this.addToolUse(block);
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        this.segment.push(block.text);
        this.segmentAt = at ?? this.segmentAt;
      }
    }
  }
```

**File:** `src/sessions/transcript.ts:700-730` — `buildTranscriptPatch` becomes (doc comment gains one sentence):

```ts
/**
 * The `SessionsRepo.upsertFromTranscript` patch for one read. Accumulators are this read's deltas
 * (the repo adds them, or replaces on `fromOffset === 0`). cwd, entrypoint and repo are sent only
 * for a read from byte 0, where the first cwd is the launch dir; a later read's first cwd may be a
 * `cd` target. Null scalars leave the stored value alone (repo merge rule). `leadingReply` is sent
 * only for a read that does not start at byte 0: a read from 0 has every reply in `replies`.
 */
export function buildTranscriptPatch(delta: TranscriptDelta, ctx: PatchContext): TranscriptPatch {
  const fromStart = ctx.fromOffset === 0;
  return {
    sessionId: delta.sessionId,
    host: ctx.host,
    transcriptPath: ctx.transcriptPath,
    fromOffset: ctx.fromOffset,
    toOffset: ctx.toOffset,
    size: ctx.size,
    repo: fromStart ? ctx.repo : null,
    cwd: fromStart ? delta.cwd : null,
    entrypoint: fromStart ? delta.entrypoint : null,
    branch: delta.branch,
    name: delta.name,
    customTitle: delta.customTitle,
    aiTitle: delta.aiTitle,
    firstPrompt: delta.firstPrompt,
    lastPrompt: delta.lastPrompt,
    version: delta.version,
    finalMessage: delta.finalMessage,
    startedAt: delta.firstAt,
    lastActiveAt: delta.lastAt,
    tokens: delta.tokens,
    models: delta.models,
    costUsd: delta.costUsd,
    prompts: delta.prompts,
    replies: delta.replies,
    leadingReply: fromStart ? null : delta.leadingReply,
    commits: delta.commits,
    filesEdited: delta.filesEdited,
    planDocs: delta.planDocs,
  };
}
```

**Impact:** `finalMessage` is unchanged (it still joins the raw segment). Replies live in their own
array indexed into `prompts`, so `PatchPrompt`/`StoredPrompt` keep their shapes and the existing
`toEqual` assertions on prompts (`transcript.test.ts:104,232,292,298`, `merge.test.ts:200`,
`ingest.test.ts:511,523`) still pass.

### Step 5: Pure reply helpers (redaction, cap, merge)

**File:** `src/sessions/merge.ts:3-19` — the types import becomes:

```ts
import {
  MAX_COMMITS,
  MAX_FILES_EDITED,
  MAX_FINAL_MESSAGE_CHARS,
  MAX_IMAGES_PER_PROMPT,
  MAX_PLAN_DOCS,
  MAX_PROMPT_CHARS,
  MAX_PROMPTS,
  MAX_REPLY_STORE_CHARS,
  MAX_TITLE_CHARS,
  type LeadingReply,
  type PatchPrompt,
  type PatchReply,
  type PromptsReplacement,
  type ReplyContent,
  type SessionRow,
  type StoredLeadingReply,
  type StoredPrompt,
  type StoredReply,
  type SubagentTotals,
  type TranscriptPatch,
  type TranscriptSet,
} from './types.js';
```

**File:** `src/sessions/merge.ts:158` — after `storedPromptsFromExcerpts` insert:

```ts
/** `text` cut to MAX_REPLY_STORE_CHARS, never through a surrogate pair. No ellipsis: `truncated` records the cut. */
export function replyCut(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_REPLY_STORE_CHARS) return { text, truncated: false };
  let end = MAX_REPLY_STORE_CHARS;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

/** Already-redacted reply text as a row's content: capped. */
function replyContent(redacted: string, at: Date | null): ReplyContent {
  const cut = replyCut(redacted);
  return { text: cut.text, at, truncated: cut.truncated };
}

/**
 * `cc_session_replies` content for one read's replies: redacted, then capped (redacting first, so a
 * cut never leaves the head of a secret too short to match). This is the one place reply text is
 * redacted. `prompt` is re-indexed onto `storedPrompts(prompts)`, which drops blank prompts; a reply
 * to a dropped prompt (or a blank reply) is dropped too.
 */
export function storedReplies(prompts: readonly PatchPrompt[] | undefined, replies: readonly PatchReply[] | undefined): StoredReply[] {
  const position = new Map<number, number>();
  let kept = 0;
  (prompts ?? []).forEach((p, i) => {
    if (p.text.trim().length === 0) return;
    position.set(i, kept);
    kept += 1;
  });
  const out: StoredReply[] = [];
  for (const r of replies ?? []) {
    const prompt = position.get(r.prompt);
    if (prompt === undefined || r.text.trim().length === 0) continue;
    out.push({ prompt, ...replyContent(redactSecrets(r.text), parseAt(r.at)) });
  }
  return out;
}

/** A read's LeadingReply, redacted. An `append` is capped later, once joined to the stored reply. */
export function storedLeadingReply(leading: LeadingReply | null | undefined): StoredLeadingReply | null {
  if (leading === null || leading === undefined) return null;
  if (leading.kind === 'replace') {
    const r = leading.reply;
    return { kind: 'replace', reply: r === null || r.text.trim().length === 0 ? null : replyContent(redactSecrets(r.text), parseAt(r.at)) };
  }
  if (leading.text.trim().length === 0) return null;
  return { kind: 'append', text: redactSecrets(leading.text), at: parseAt(leading.at) };
}

/**
 * The reply the last prompt stored before a read holds after it. `stored`: that prompt's reply row
 * (null: none). A null result means the prompt has no reply. An append joins with a blank line, the
 * separator one read uses between text blocks, so a turn split across reads stores what one read
 * of the whole file stores (redaction is per pattern match, so redacting the halves equals
 * redacting the whole).
 */
export function nextLeadingReply(stored: ReplyContent | null, leading: StoredLeadingReply): ReplyContent | null {
  if (leading.kind === 'replace') return leading.reply;
  const at = leading.at ?? stored?.at ?? null;
  if (stored === null) return replyContent(leading.text, at);
  if (stored.truncated) return { ...stored, at };
  return replyContent(`${stored.text}\n\n${leading.text}`, at);
}

/** True when two reply contents would store the same row. */
export function sameReply(a: ReplyContent, b: ReplyContent): boolean {
  return a.text === b.text && a.truncated === b.truncated && (a.at?.getTime() ?? null) === (b.at?.getTime() ?? null);
}
```

**Impact:** none outside sessions; the helpers are shared by `SessionsRepo` and the test store.

### Step 6: `SessionsRepo` writes replies with prompts

**File:** `src/sessions/repo.ts:2` — import line becomes:

```ts
import { and, asc, desc, eq, getTableColumns, gte, inArray, isNotNull, isNull, lt, lte, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
```

**File:** `src/sessions/repo.ts:6`:

```ts
import { appSettings, ccPendingSpawns, ccSessionEmbeddings, ccSessionPromptImages, ccSessionPrompts, ccSessionReplies, ccSessions, ccSubagentTranscripts } from '../db/schema.js';
```

**File:** `src/sessions/repo.ts:12-25` — merge import becomes:

```ts
import {
  clip,
  earliest,
  latest,
  mergeCommits,
  mergeModels,
  mergeTranscriptPatch,
  nextLeadingReply,
  normalizeCwd,
  redactedPromptColumns,
  replacedPromptColumns,
  sameReply,
  storedLeadingReply,
  storedPrompts,
  storedPromptsFromExcerpts,
  storedReplies,
  subtractModels,
} from './merge.js';
```

**File:** `src/sessions/repo.ts:26-67` — in the types import add `REPLIES_VERSION,` after `PROMPTS_VERSION_EXCERPTS,` and add `type ReplyContent,`, `type StoredLeadingReply,`, `type StoredReply,` in alphabetical position (after `type ReplacePromptsResult,`, after `type SpawnClaimResult,`/before `type StoredPrompt,`, and after `type StoredPrompt,` respectively). The full import:

```ts
import {
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  MAX_TITLE_CHARS,
  NODE_ID_ATTEMPTS,
  PARENT_LINK_RANK,
  PENDING_SPAWN_SKEW_MS,
  PENDING_SPAWN_WINDOW_MS,
  PROMPTS_VERSION,
  PROMPTS_VERSION_EXCERPTS,
  REPLIES_VERSION,
  SELECTED_PROJECT_KEY,
  type HookStart,
  type HookStartResult,
  type ListByNameOptions,
  type ListForRepoOptions,
  type ParentLinkSource,
  type PendingSpawnInput,
  type PendingSpawnRow,
  type ProjectSummary,
  type PromptImageLink,
  type PromptsBackfillCandidate,
  type PromptsReplacement,
  type RedactStoredPromptsResult,
  type ReplacePromptsResult,
  type ReplyContent,
  type SessionEmbeddingFailure,
  type SessionEmbeddingInput,
  type SessionListItem,
  type SessionRow,
  type SessionsRepoOptions,
  type SetParentResult,
  type SpawnClaim,
  type SpawnClaimResult,
  type StoredLeadingReply,
  type StoredPrompt,
  type StoredReply,
  type SubagentTotals,
  type SubagentTranscriptPatch,
  type SubagentUpsertResult,
  type SummaryInput,
  type SummaryRequest,
  type TranscriptOffset,
  type TranscriptPatch,
  type TranscriptUpsertResult,
} from './types.js';
```
(Keep any type Phase 2 added to this import, e.g. for `saveEmbedding`.)

**File:** `src/sessions/repo.ts:120-122` — after `PROMPT_INSERT_CHARS` add:

```ts
/** Rows per insert into cc_session_replies; each is at most MAX_REPLY_STORE_CHARS, so a statement stays under ~3.2 MB. */
const REPLY_INSERT_ROWS = 200;
```

**File:** `src/sessions/repo.ts:173-178` — class doc becomes (Phase 4 later extends this list with `cc_session_reply_embeddings`, quoting this version):

```ts
/**
 * The only writer of `cc_sessions`, `cc_session_prompts`, `cc_session_replies`,
 * `cc_subagent_transcripts`, `cc_session_embeddings`, `cc_pending_spawns` and `app_settings`.
 * Ingest, the heuristic linker, the hook endpoints, the summary worker, the Summarize request route
 * and the read API all go through it; nothing else writes these tables.
 */
```

**File:** `src/sessions/repo.ts:291-327` — `writePromptRows` is replaced by these three methods:

```ts
  /**
   * Writes a session's `cc_session_prompts` rows, their `cc_session_prompt_images` links and their
   * `cc_session_replies` rows. The caller holds the cc_sessions row lock, which every writer of a
   * session's prompt rows takes, so seq cannot race. `replace`: the rows become exactly `prompts`,
   * seq 1..n (their old images are dropped by the FK cascade; `images` relinks them, free of charge
   * when the same bytes dedupe), and the replies exactly `replies`. Otherwise `leading` is applied
   * to the reply of the highest stored seq, then `prompts` are appended after it. `images[i]` are
   * prompts[i]'s images; `replies[j].prompt` indexes `prompts`.
   */
  private async writePromptRows(
    tx: Tx,
    sessionId: string,
    prompts: readonly StoredPrompt[],
    images: readonly PromptImageLink[][],
    replies: readonly StoredReply[],
    leading: StoredLeadingReply | null,
    replace: boolean,
  ): Promise<void> {
    let next = 1;
    if (replace) {
      await tx.delete(ccSessionPrompts).where(eq(ccSessionPrompts.sessionId, sessionId));
    } else {
      if (prompts.length === 0 && leading === null) return;
      const top = await tx
        .select({ max: sql<number>`coalesce(max(${ccSessionPrompts.seq}), 0)`.mapWith(Number) })
        .from(ccSessionPrompts)
        .where(eq(ccSessionPrompts.sessionId, sessionId));
      next = (top[0]?.max ?? 0) + 1;
      if (leading !== null && next > 1) await this.writeLeadingReply(tx, sessionId, next - 1, leading);
    }
    const first = next;
    let index = 0;
    for (const batch of promptBatches(prompts)) {
      const values = batch.map((p, i) => ({ sessionId, seq: next + i, at: p.at, text: p.text, truncated: p.truncated }));
      await tx.insert(ccSessionPrompts).values(values);
      const imageValues = batch.flatMap((_, i) =>
        (images[index + i] ?? []).map((img, position) => ({ sessionId, promptSeq: next + i, position, imageId: img.imageId, pasteId: img.pasteId })),
      );
      if (imageValues.length > 0) await tx.insert(ccSessionPromptImages).values(imageValues);
      next += batch.length;
      index += batch.length;
    }
    await this.writeReplyRows(tx, sessionId, first, replies, replace);
  }

  /**
   * `cc_session_replies` for prompts written from seq `first`. Upserts by (session_id, seq) and
   * rewrites a row only when its content changed, so a from-byte-0 replace that finds the same
   * reply keeps the row and its `cc_session_reply_embeddings` row (which cascades only on delete).
   * `replace`: replies of every other seq of the session are deleted.
   */
  private async writeReplyRows(tx: Tx, sessionId: string, first: number, replies: readonly StoredReply[], replace: boolean): Promise<void> {
    const rows = replies.map((r) => ({ sessionId, seq: first + r.prompt, at: r.at, text: r.text, truncated: r.truncated }));
    if (replace) {
      const keep = rows.map((r) => r.seq);
      await tx
        .delete(ccSessionReplies)
        .where(
          keep.length === 0
            ? eq(ccSessionReplies.sessionId, sessionId)
            : and(eq(ccSessionReplies.sessionId, sessionId), notInArray(ccSessionReplies.seq, keep)),
        );
    }
    for (let i = 0; i < rows.length; i += REPLY_INSERT_ROWS) {
      await tx
        .insert(ccSessionReplies)
        .values(rows.slice(i, i + REPLY_INSERT_ROWS))
        .onConflictDoUpdate({
          target: [ccSessionReplies.sessionId, ccSessionReplies.seq],
          set: { at: sql`excluded.at`, text: sql`excluded.text`, truncated: sql`excluded.truncated` },
          setWhere: sql`${ccSessionReplies.text} is distinct from excluded.text or ${ccSessionReplies.truncated} is distinct from excluded.truncated or ${ccSessionReplies.at} is distinct from excluded.at`,
        });
    }
  }

  /** Applies a read's `leading` to the reply of prompt `seq`, the last one stored before the read. */
  private async writeLeadingReply(tx: Tx, sessionId: string, seq: number, leading: StoredLeadingReply): Promise<void> {
    const where = and(eq(ccSessionReplies.sessionId, sessionId), eq(ccSessionReplies.seq, seq));
    const found = await tx
      .select({ text: ccSessionReplies.text, at: ccSessionReplies.at, truncated: ccSessionReplies.truncated })
      .from(ccSessionReplies)
      .where(where);
    const stored: ReplyContent | null = found[0] ?? null;
    const next = nextLeadingReply(stored, leading);
    if (next === null) {
      if (stored !== null) await tx.delete(ccSessionReplies).where(where);
      return;
    }
    if (stored !== null && sameReply(stored, next)) return;
    await tx
      .insert(ccSessionReplies)
      .values({ sessionId, seq, at: next.at, text: next.text, truncated: next.truncated })
      .onConflictDoUpdate({
        target: [ccSessionReplies.sessionId, ccSessionReplies.seq],
        set: { at: next.at, text: next.text, truncated: next.truncated },
      });
  }
```

**File:** `src/sessions/repo.ts:331-373` — `upsertFromTranscript` becomes:

```ts
  /**
   * Applies one ingest pass. Compare-and-set on transcript_offset: see TranscriptPatch. Replaying
   * a patch is a no-op (`offset_mismatch`); the caller then resumes from `storedOffset`.
   *
   * The pass's prompts go to `cc_session_prompts` in the same transaction, redacted: appended after
   * the highest seq, or replacing every row on fromOffset 0. Their replies go to
   * `cc_session_replies` in the same transaction, redacted and capped, keyed to the prompt's seq;
   * an appending pass first applies `leadingReply` to the reply of the last prompt stored before
   * it. Only a read from byte 0 has seen every prompt and reply, so only it marks the row
   * `prompts_version = PROMPTS_VERSION` and `replies_version = REPLIES_VERSION`. An append to a row
   * below PROMPTS_VERSION (0: written before full prompts existed; PROMPTS_VERSION_EXCERPTS:
   * rebuilt from excerpts) adds its prompts but leaves the versions, so the prompts backfill still
   * replaces that row's side rows whole.
   */
  async upsertFromTranscript(patch: TranscriptPatch): Promise<TranscriptUpsertResult> {
    assertSessionId(patch.sessionId);
    assertHost(patch.host);
    assertOffset(patch.fromOffset, 'fromOffset');
    assertOffset(patch.toOffset, 'toOffset');
    assertOffset(patch.size, 'size');
    if (patch.toOffset < patch.fromOffset) throw new RangeError('toOffset is before fromOffset');
    await this.ensureSession(patch.sessionId, patch.host);
    const prompts = storedPrompts(patch.prompts);
    const replies = storedReplies(patch.prompts, patch.replies);
    const leading = patch.fromOffset === 0 ? null : storedLeadingReply(patch.leadingReply);
    const promptImages = await this.ingestPromptImages(prompts);
    return this.db.transaction(async (tx) => {
      const row = await this.lock(tx, patch.sessionId);
      if (row.host !== patch.host) {
        return { applied: false, reason: 'other_host', storedOffset: row.transcriptOffset, row } as const;
      }
      if (patch.fromOffset !== 0 && row.transcriptOffset !== patch.fromOffset) {
        return { applied: false, reason: 'offset_mismatch', storedOffset: row.transcriptOffset, row } as const;
      }
      const reset = patch.fromOffset === 0;
      const set = mergeTranscriptPatch(row, patch, reset ? await this.subagentTotals(tx, patch.sessionId) : null);
      await this.writePromptRows(tx, patch.sessionId, prompts, promptImages, replies, leading, reset);
      const now = this.now();
      const updated = await tx
        .update(ccSessions)
        .set(
          reset
            ? { ...set, promptsVersion: PROMPTS_VERSION, repliesVersion: REPLIES_VERSION, updatedAt: now }
            : { ...set, updatedAt: now },
        )
        .where(eq(ccSessions.sessionId, patch.sessionId))
        .returning(SESSION_COLUMNS);
      const next = updated[0];
      if (!next) throw new Error(`cc_sessions row ${patch.sessionId} disappeared`);
      return { applied: true, row: next } as const;
    });
  }
```

**File:** `src/sessions/repo.ts:389-407` — `promptsBackfillCandidates` becomes:

```ts
  // ---------- full prompts (and replies) backfill ----------

  /**
   * Rows of `host` below PROMPTS_VERSION or below REPLIES_VERSION, most recently active first:
   * legacy rows (0), rows redacted in place from excerpts (PROMPTS_VERSION_EXCERPTS), which upgrade
   * if their transcript is readable again, and rows ingested before replies were stored.
   */
  async promptsBackfillCandidates(host: string): Promise<PromptsBackfillCandidate[]> {
    assertHost(host);
    return this.db
      .select({
        sessionId: ccSessions.sessionId,
        transcriptPath: ccSessions.transcriptPath,
        transcriptOffset: ccSessions.transcriptOffset,
        promptsVersion: ccSessions.promptsVersion,
      })
      .from(ccSessions)
      .where(and(eq(ccSessions.host, host), or(lt(ccSessions.promptsVersion, PROMPTS_VERSION), lt(ccSessions.repliesVersion, REPLIES_VERSION))))
      .orderBy(desc(sql`coalesce(${ccSessions.lastActiveAt}, ${ccSessions.createdAt})`), asc(ccSessions.sessionId));
  }
```

**File:** `src/sessions/repo.ts:409-433` — `replacePrompts` becomes:

```ts
  /**
   * Replaces a session's prompts and replies with those of its transcript re-read from byte 0 to
   * `upToOffset`. Compare-and-set on transcript_offset and host, under the row lock. Writes
   * `cc_session_prompts` (redacted, seq 1..n), `cc_session_replies` (redacted, capped, unchanged
   * rows kept), the excerpt list, first_prompt, last_prompt, prompts_version, replies_version and
   * updated_at, and no other column.
   */
  async replacePrompts(sessionId: string, host: string, input: PromptsReplacement): Promise<ReplacePromptsResult> {
    assertSessionId(sessionId);
    assertHost(host);
    assertOffset(input.upToOffset, 'upToOffset');
    const prompts = storedPrompts(input.prompts);
    const replies = storedReplies(input.prompts, input.replies);
    const promptImages = await this.ingestPromptImages(prompts);
    return this.db.transaction(async (tx): Promise<ReplacePromptsResult> => {
      const row = await this.lockIfExists(tx, sessionId);
      if (row === null) return { status: 'missing' };
      if (row.host !== host) return { status: 'other_host' };
      if (row.transcriptOffset !== input.upToOffset) return { status: 'offset_mismatch', storedOffset: row.transcriptOffset };
      await this.writePromptRows(tx, sessionId, prompts, promptImages, replies, null, true);
      await tx
        .update(ccSessions)
        .set({ ...replacedPromptColumns(row, input), promptsVersion: PROMPTS_VERSION, repliesVersion: REPLIES_VERSION, updatedAt: this.now() })
        .where(eq(ccSessions.sessionId, sessionId));
      return { status: 'applied' };
    });
  }
```

**File:** `src/sessions/repo.ts:435-465` — `redactStoredPrompts` becomes:

```ts
  /**
   * For a row of `host` whose transcript is gone: redacts the stored excerpts, first_prompt and
   * last_prompt in place, rebuilds `cc_session_prompts` from the redacted excerpts (the full text
   * cannot be recovered; `truncated` where an excerpt ends in `…`), deletes the session's replies
   * (their seqs pointed at the old prompt rows, and a pruned transcript keeps none), and marks the
   * row PROMPTS_VERSION_EXCERPTS, never PROMPTS_VERSION: the list is not complete. replies_version
   * is left as it was. Same columns as replacePrompts. A row already at PROMPTS_VERSION_EXCERPTS or
   * above is left alone ('current'), so a pruned transcript costs one locked read per daemon start,
   * not a rewrite.
   */
  async redactStoredPrompts(sessionId: string, host: string): Promise<RedactStoredPromptsResult> {
    assertSessionId(sessionId);
    assertHost(host);
    return this.db.transaction(async (tx): Promise<RedactStoredPromptsResult> => {
      const row = await this.lockIfExists(tx, sessionId);
      if (row === null) return 'missing';
      if (row.host !== host) return 'other_host';
      if (row.promptsVersion >= PROMPTS_VERSION_EXCERPTS) return 'current';
      const prompts = storedPromptsFromExcerpts(row.prompts);
      await this.writePromptRows(
        tx,
        sessionId,
        prompts,
        prompts.map(() => []),
        [],
        null,
        true,
      );
      await tx
        .update(ccSessions)
        .set({ ...redactedPromptColumns(row), promptsVersion: PROMPTS_VERSION_EXCERPTS, updatedAt: this.now() })
        .where(eq(ccSessions.sessionId, sessionId));
      return 'applied';
    });
  }
```

**Impact:** every caller of `writePromptRows` is in this file and updated above. A from-byte-0
read now rewrites `cc_session_replies` for the session; unchanged rows are not rewritten.

### Step 7: Ingest — backfill passes replies, gone transcripts skip without a lock

**File:** `src/sessions/ingest.ts:7` — becomes:

```ts
import { PROMPTS_VERSION_EXCERPTS, type PromptsBackfillCandidate, type PromptsReplacement, type RedactStoredPromptsResult, type ReplacePromptsResult } from './types.js';
```

**File:** `src/sessions/ingest.ts:47-56` — the "Full prompts" header bullet becomes:

```ts
 * - Full prompts and replies: every write carries every prompt of the bytes it read and Claude's
 *   reply to each (SessionsRepo stores them, redacted, in `cc_session_prompts` and
 *   `cc_session_replies`; a turn split across reads is joined or superseded there, see
 *   `TranscriptDelta.leadingReply`). Once the startup pass is done, `promptsBackfill` runs once:
 *   each row of this host still below PROMPTS_VERSION or REPLIES_VERSION has its transcript re-read
 *   from 0 to its stored offset for prompts and replies only (no tokens, commits, links or
 *   observers) and its prompt columns and replies replaced (`SessionsRepo.replacePrompts`, a
 *   compare-and-set on the offset), under the same per-file hold as the tail reads. A row whose
 *   transcript is gone has its stored excerpts redacted in place (`redactStoredPrompts`,
 *   PROMPTS_VERSION_EXCERPTS) and keeps no replies; it stays a candidate, is skipped without a
 *   write (or a lock) while the file is missing, and is filled if the file is readable again. Only
 *   transcripts under `<claudeHome>/projects` are read. One log line, only when a row changed,
 *   was deferred or failed.
```

**File:** `src/sessions/ingest.ts:134-137` — `PromptsBackfillReport.candidates` doc becomes:

```ts
  /** Rows of this host below PROMPTS_VERSION or REPLIES_VERSION when it started. */
  candidates: number;
```

**File:** `src/sessions/ingest.ts:595-637` — `backfillSession` becomes:

```ts
  /**
   * One candidate of the prompts backfill. Re-reads the transcript from 0 to the stored offset,
   * collecting prompts and replies only, and replaces the row's prompt columns and replies. An
   * offset miss (a tail write landed first) retries once with the stored offset; a second miss
   * waits for the next start.
   */
  const backfillSession = async (c: PromptsBackfillCandidate, fill: PromptsFill): Promise<PromptsBackfillOutcome> => {
    let upTo = c.transcriptOffset;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (closed) return 'deferred';
      const file = c.transcriptPath;
      if (file !== null && !isUnder(projectsDir, file)) return 'deferred';
      const size = file === null ? null : await fileSize(file);
      if (file === null || size === null) {
        // Transcript gone. Nothing is left to redact at PROMPTS_VERSION_EXCERPTS or above, and the
        // replies cannot be recovered: skip without a write or a row lock.
        if (c.promptsVersion >= PROMPTS_VERSION_EXCERPTS) return 'skipped';
        const redacted = await fill.redact(c.sessionId, host);
        if (redacted === 'applied') return 'redacted';
        return redacted === 'current' ? 'skipped' : 'deferred';
      }
      // A file shorter than its offset is re-read from 0 by the tail ingester, which fills the prompts.
      if (size < upTo) return 'deferred';
      const acc = new TranscriptAccumulator(c.sessionId);
      const read = await readJsonlFrom(
        file,
        0,
        (line) => {
          const record = parseRecord(line);
          if (record !== null) acc.add(record);
        },
        { until: upTo, shouldStop: () => closed, ...(options.chunkBytes !== undefined ? { chunkBytes: options.chunkBytes } : {}) },
      );
      if (read.stopped || read.endOffset !== upTo) return 'deferred';
      const delta = acc.delta();
      const result = await fill.replace(c.sessionId, host, {
        upToOffset: upTo,
        prompts: delta.prompts,
        replies: delta.replies,
        firstPrompt: delta.firstPrompt,
        lastPrompt: delta.lastPrompt,
      });
      if (result.status === 'applied') return 'filled';
      if (result.status !== 'offset_mismatch') return 'deferred';
      upTo = result.storedOffset;
    }
    return 'deferred';
  };
```

**Impact:** `readFile` needs no change: `buildTranscriptPatch` carries `replies` and
`leadingReply`. One-time cost on the owning host's next start: every row at `replies_version 0`
whose transcript exists is re-read from 0 (the startup pass already reads all of them; measured
2-5 s for 628 files) and its prompts rewritten (same content; images dedupe by sha256).

### Step 8: In-memory store follows the repo

**File:** `tests/helpers/memoryIngestStore.ts:1-28` — imports become:

```ts
import type { IngestStore } from '../../src/sessions/ingest.js';
import {
  latest,
  mergeCommits,
  mergeModels,
  mergeTranscriptPatch,
  nextLeadingReply,
  redactedPromptColumns,
  replacedPromptColumns,
  storedLeadingReply,
  storedPrompts,
  storedPromptsFromExcerpts,
  storedReplies,
  subtractModels,
} from '../../src/sessions/merge.js';
import {
  PROMPTS_VERSION,
  PROMPTS_VERSION_EXCERPTS,
  REPLIES_VERSION,
  type PromptsBackfillCandidate,
  type PromptsReplacement,
  type RedactStoredPromptsResult,
  type ReplacePromptsResult,
  type ReplyContent,
  type SessionRow,
  type StoredLeadingReply,
  type StoredPrompt,
  type StoredReply,
  type SubagentTotals,
  type SubagentTranscriptPatch,
  type SubagentUpsertResult,
  type TranscriptOffset,
  type TranscriptPatch,
  type TranscriptUpsertResult,
} from '../../src/sessions/types.js';
```

**File:** `tests/helpers/memoryIngestStore.ts:77` — in `blankSessionRow`, after `promptsVersion: 0,` add:

```ts
    repliesVersion: 0,
```

**File:** `tests/helpers/memoryIngestStore.ts:95` — after `readonly sidePrompts = ...` add:

```ts
  /** `cc_session_replies` by session id, then seq. */
  readonly sideReplies = new Map<string, Map<number, ReplyContent>>();
```

**File:** `tests/helpers/memoryIngestStore.ts:164-209` — `upsertFromTranscript`, `promptsBackfillCandidates`, `replacePrompts`, `redactStoredPrompts` become, plus a private `writeReplies`:

```ts
  async upsertFromTranscript(patch: TranscriptPatch): Promise<TranscriptUpsertResult> {
    this.patches.push(patch);
    const row = this.rows.get(patch.sessionId) ?? blankSessionRow(patch.sessionId, patch.host);
    this.rows.set(patch.sessionId, row);
    if (row.host !== patch.host) return { applied: false, reason: 'other_host', storedOffset: row.transcriptOffset, row };
    if (patch.fromOffset !== 0 && row.transcriptOffset !== patch.fromOffset) {
      return { applied: false, reason: 'offset_mismatch', storedOffset: row.transcriptOffset, row };
    }
    const reset = patch.fromOffset === 0;
    const subagents = reset ? this.subagentTotals(patch.sessionId) : null;
    const added = storedPrompts(patch.prompts);
    const before = reset ? [] : (this.sidePrompts.get(patch.sessionId) ?? []);
    this.writeReplies(
      patch.sessionId,
      before.length + 1,
      storedReplies(patch.prompts, patch.replies),
      reset ? null : storedLeadingReply(patch.leadingReply),
      reset,
    );
    this.sidePrompts.set(patch.sessionId, [...before, ...added]);
    const next: SessionRow = {
      ...row,
      ...mergeTranscriptPatch(row, patch, subagents),
      ...(reset ? { promptsVersion: PROMPTS_VERSION, repliesVersion: REPLIES_VERSION } : {}),
    };
    this.rows.set(patch.sessionId, next);
    return { applied: true, row: next };
  }

  /** The repo's writeLeadingReply + writeReplyRows over a Map, with the same pure helpers. */
  private writeReplies(sessionId: string, first: number, replies: readonly StoredReply[], leading: StoredLeadingReply | null, replace: boolean): void {
    const map = replace ? new Map<number, ReplyContent>() : new Map(this.sideReplies.get(sessionId) ?? []);
    if (leading !== null && first > 1) {
      const next = nextLeadingReply(map.get(first - 1) ?? null, leading);
      if (next === null) map.delete(first - 1);
      else map.set(first - 1, next);
    }
    for (const r of replies) map.set(first + r.prompt, { text: r.text, at: r.at, truncated: r.truncated });
    this.sideReplies.set(sessionId, map);
  }

  async promptsBackfillCandidates(host: string): Promise<PromptsBackfillCandidate[]> {
    return [...this.rows.values()]
      .filter((r) => r.host === host && (r.promptsVersion < PROMPTS_VERSION || r.repliesVersion < REPLIES_VERSION))
      .map((r) => ({ sessionId: r.sessionId, transcriptPath: r.transcriptPath, transcriptOffset: r.transcriptOffset, promptsVersion: r.promptsVersion }));
  }

  async replacePrompts(sessionId: string, host: string, input: PromptsReplacement): Promise<ReplacePromptsResult> {
    const row = this.rows.get(sessionId);
    if (!row) return { status: 'missing' };
    if (row.host !== host) return { status: 'other_host' };
    if (row.transcriptOffset !== input.upToOffset) return { status: 'offset_mismatch', storedOffset: row.transcriptOffset };
    this.sidePrompts.set(sessionId, storedPrompts(input.prompts));
    this.writeReplies(sessionId, 1, storedReplies(input.prompts, input.replies), null, true);
    this.rows.set(sessionId, { ...row, ...replacedPromptColumns(row, input), promptsVersion: PROMPTS_VERSION, repliesVersion: REPLIES_VERSION });
    return { status: 'applied' };
  }

  async redactStoredPrompts(sessionId: string, host: string): Promise<RedactStoredPromptsResult> {
    const row = this.rows.get(sessionId);
    if (!row) return 'missing';
    if (row.host !== host) return 'other_host';
    if (row.promptsVersion >= PROMPTS_VERSION_EXCERPTS) return 'current';
    this.sidePrompts.set(sessionId, storedPromptsFromExcerpts(row.prompts));
    this.sideReplies.delete(sessionId);
    this.rows.set(sessionId, { ...row, ...redactedPromptColumns(row), promptsVersion: PROMPTS_VERSION_EXCERPTS });
    return 'applied';
  }
```

**Impact:** existing unit tests keep their meaning: fixture rows are ingested from 0 and so land at
`REPLIES_VERSION`; `candidates` counts in `ingest.test.ts:444-538` are unchanged.

### Step 9: Small test fixes and `truncateAll`

**File:** `tests/integration/setup.ts:50` — `truncateAll` body becomes:

```ts
  await db.execute(sql`truncate table adversary_reviews, note_session_links, cc_session_reply_embeddings, cc_session_replies, cc_session_prompt_images, cc_session_prompts, cc_subagent_transcripts, cc_session_embeddings, cc_pending_spawns, cc_sessions, app_settings, chat_message_attachments, chat_message_revisions, chat_messages, chat_threads, note_image_embeddings, chat_images, note_files, note_images, note_embeddings, note_revisions, notes restart identity cascade`)
```

**File:** `tests/unit/sessions/merge.test.ts:57` — after `promptsVersion: 0,` in the row literal add:

```ts
    repliesVersion: 0,
```

**File:** `tests/unit/sessions/schema.test.ts` — import becomes
`import { ccSessionEmbeddings, ccSessionReplyEmbeddings, PARENT_LINK_SOURCES } from '../../../src/db/schema.js'`
and after the first `it(...)` add:

```ts
  it('reply vectors have the note embedding width', () => {
    expect(ccSessionReplyEmbeddings.embedding.getSQLType()).toBe(`vector(${EMBEDDING_DIMENSIONS})`)
  })
```

### Step 10: Unit tests and the split-point lever

**File:** `tests/unit/sessions/replies.test.ts` (new). The "every split point" tests are the lever:
they prove, for every way the ingester can cut this transcript into two or three reads, that the
stored replies equal one read from byte 0. Rerun them instead of reasoning about the diff.

```ts
import { describe, expect, it } from 'vitest';
import { nextLeadingReply, replyCut, storedLeadingReply, storedReplies } from '../../../src/sessions/merge.js';
import { accumulateText, buildTranscriptPatch, parseRecord, TranscriptAccumulator, type PatchContext } from '../../../src/sessions/transcript.js';
import { MAX_REPLY_STORE_CHARS, type ReplyContent } from '../../../src/sessions/types.js';
import { MemoryIngestStore } from '../../helpers/memoryIngestStore.js';

const SID = '5e55a001-0000-4000-8000-0000000000f1';
const KEY = 'sk-ant-api03-FAKE-not-a-real-key-0000000000';
const usage = { input_tokens: 1, output_tokens: 1 };
const at = (s: number): string => `2026-11-06T00:00:${String(s).padStart(2, '0')}.000Z`;
const prompt = (s: number, text: string): string =>
  JSON.stringify({ type: 'user', sessionId: SID, cwd: '/home/u/mcp-notes', entrypoint: 'cli', origin: { kind: 'human' }, message: { role: 'user', content: text }, timestamp: at(s) });
const say = (s: number, id: string, ...texts: string[]): string =>
  JSON.stringify({ type: 'assistant', sessionId: SID, message: { id, model: 'claude-opus-5-5', role: 'assistant', content: texts.map((text) => ({ type: 'text', text })), usage }, timestamp: at(s) });
const tool = (s: number, id: string, toolId: string): string =>
  JSON.stringify({
    type: 'assistant',
    sessionId: SID,
    message: { id, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'Read', input: { file_path: '/home/u/mcp-notes/README.md' } }], usage },
    timestamp: at(s),
  });
const result = (s: number, toolId: string): string =>
  JSON.stringify({ type: 'user', sessionId: SID, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'ok' }] }, toolUseResult: { stdout: 'ok' }, timestamp: at(s) });
const side = (s: number, text: string): string =>
  JSON.stringify({ type: 'assistant', isSidechain: true, sessionId: SID, message: { id: `side_${s}`, model: 'claude-haiku-5-5', role: 'assistant', content: [{ type: 'text', text }], usage }, timestamp: at(s) });

/** Four turns: tool use then a two-block answer; a text-only answer; a turn that ends in a tool call; an answer in two records. */
const LINES = [
  prompt(0, 'why does resume break?'),
  say(1, 'm1', 'Let me check the resume code.'),
  tool(2, 'm1', 't1'),
  result(3, 't1'),
  say(4, 'm2', 'Resume breaks because the tmux target is stale.', `Fix: re-read it on attach. ${KEY}`),
  prompt(5, 'and the hook?'),
  say(6, 'm3', 'The hook only fires on SessionStart.'),
  side(7, 'subagent chatter that is not a reply'),
  prompt(8, 'run the tests'),
  tool(9, 'm4', 't2'),
  result(10, 't2'),
  prompt(11, 'summarize'),
  say(12, 'm5', 'First part.'),
  say(13, 'm6', 'Second part.'),
];

const chunk = (lines: readonly string[]): string => lines.map((l) => `${l}\n`).join('');

function ctx(fromOffset: number, toOffset: number): PatchContext {
  return { host: 'h', transcriptPath: '/t.jsonl', fromOffset, toOffset, size: toOffset, repo: null };
}

/** Ingests LINES as consecutive reads cut at `cuts` (line indexes), each with a fresh accumulator (as after a restart). */
async function repliesAfterReads(cuts: readonly number[]): Promise<Array<[number, ReplyContent]>> {
  const store = new MemoryIngestStore();
  const bounds = [0, ...cuts, LINES.length];
  let offset = 0;
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    const text = chunk(LINES.slice(bounds[i], bounds[i + 1]));
    const toOffset = offset + Buffer.byteLength(text);
    const res = await store.upsertFromTranscript(buildTranscriptPatch(accumulateText(SID, text).delta(), ctx(offset, toOffset)));
    expect(res.applied).toBe(true);
    offset = toOffset;
  }
  return [...(store.sideReplies.get(SID) ?? new Map<number, ReplyContent>()).entries()].sort((a, b) => a[0] - b[0]);
}

describe('TranscriptAccumulator replies', () => {
  it('gives each prompt the text after its last tool call, from byte 0', () => {
    const d = accumulateText(SID, chunk(LINES)).delta();
    expect(d.prompts.map((p) => p.text)).toEqual(['why does resume break?', 'and the hook?', 'run the tests', 'summarize']);
    expect(d.replies).toEqual([
      { prompt: 0, text: `Resume breaks because the tmux target is stale.\n\nFix: re-read it on attach. ${KEY}`, at: at(4) },
      { prompt: 1, text: 'The hook only fires on SessionStart.', at: at(6) },
      { prompt: 3, text: 'First part.\n\nSecond part.', at: at(13) },
    ]);
    expect(d.leadingReply).toBeNull();
  });

  it('gives the main fixture session its final message, not the narration before its tool calls', async () => {
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const { FIXTURE, FIXTURE_CLAUDE_HOME } = await import('../../helpers/claudeHome.js');
    const d = accumulateText(FIXTURE.main, await readFile(path.join(FIXTURE_CLAUDE_HOME, FIXTURE.mainFile), 'utf8')).delta();
    expect(d.replies).toEqual([{ prompt: 0, text: 'Done: the plan is written.', at: '2026-11-02T02:23:10.000Z' }]);
  });

  it('reports what a read that starts mid-turn does to the earlier reply', () => {
    const lead = (from: number, to: number) => accumulateText(SID, chunk(LINES.slice(from, to))).delta();
    expect(lead(1, 2).leadingReply).toEqual({ kind: 'append', text: 'Let me check the resume code.', at: at(1) });
    expect(lead(2, 4).leadingReply).toEqual({ kind: 'replace', reply: null });
    expect(lead(2, 5).leadingReply).toEqual({
      kind: 'replace',
      reply: { text: `Resume breaks because the tmux target is stale.\n\nFix: re-read it on attach. ${KEY}`, at: at(4) },
    });
    expect(lead(3, 4).leadingReply).toBeNull();
    const toNextPrompt = lead(1, 6);
    expect(toNextPrompt.leadingReply).toMatchObject({ kind: 'replace' });
    expect(toNextPrompt.replies).toEqual([]);
  });

  it('never produces a reply from a subagent transcript', () => {
    const acc = new TranscriptAccumulator(SID, undefined, { sidechain: true });
    for (const line of [side(0, 'subagent says hi'), side(1, 'and more')]) {
      const record = parseRecord(line);
      if (record !== null) acc.add(record);
    }
    expect(acc.delta().replies).toEqual([]);
    expect(acc.delta().leadingReply).toBeNull();
  });

  it('sends leadingReply only for a read that does not start at byte 0', () => {
    const d = accumulateText(SID, chunk(LINES.slice(1, 2))).delta();
    expect(buildTranscriptPatch(d, ctx(0, 10)).leadingReply).toBeNull();
    expect(buildTranscriptPatch(d, ctx(50, 60)).leadingReply).toEqual({ kind: 'append', text: 'Let me check the resume code.', at: at(1) });
  });
});

describe('stored replies equal one read from byte 0, however the reads are cut', () => {
  it('stores redacted replies keyed to their prompt seq', async () => {
    const whole = await repliesAfterReads([]);
    expect(whole.map(([seq, r]) => [seq, r.text, r.truncated])).toEqual([
      [1, 'Resume breaks because the tmux target is stale.\n\nFix: re-read it on attach. [redacted]', false],
      [2, 'The hook only fires on SessionStart.', false],
      [4, 'First part.\n\nSecond part.', false],
    ]);
  });

  it('at every single split point', async () => {
    const whole = await repliesAfterReads([]);
    for (let k = 1; k < LINES.length; k += 1) {
      expect(await repliesAfterReads([k]), `split at line ${k}`).toEqual(whole);
    }
  });

  it('at every pair of split points', async () => {
    const whole = await repliesAfterReads([]);
    for (let a = 1; a < LINES.length - 1; a += 1) {
      for (let b = a + 1; b < LINES.length; b += 1) {
        expect(await repliesAfterReads([a, b]), `split at lines ${a}, ${b}`).toEqual(whole);
      }
    }
  });
});

describe('reply helpers', () => {
  it('redacts, caps, and follows the prompts that are kept', () => {
    const long = 'word '.repeat(MAX_REPLY_STORE_CHARS);
    const out = storedReplies(
      [{ text: 'a', at: null }, { text: '   ', at: null }, { text: 'b', at: null }],
      [
        { prompt: 0, text: `use ${KEY} now`, at: '2026-11-06T00:00:00.000Z' },
        { prompt: 1, text: 'answer to a blank prompt', at: null },
        { prompt: 2, text: long, at: null },
      ],
    );
    expect(out).toEqual([
      { prompt: 0, text: 'use [redacted] now', at: new Date('2026-11-06T00:00:00.000Z'), truncated: false },
      { prompt: 1, text: long.slice(0, MAX_REPLY_STORE_CHARS), at: null, truncated: true },
    ]);
  });

  it('never cuts through a surrogate pair', () => {
    const text = `${'a'.repeat(MAX_REPLY_STORE_CHARS - 1)}\u{1F600}`;
    expect(replyCut(text)).toEqual({ text: 'a'.repeat(MAX_REPLY_STORE_CHARS - 1), truncated: true });
  });

  it('appends to, replaces or deletes the earlier reply', () => {
    const t1 = new Date('2026-11-06T00:00:01.000Z');
    const t2 = new Date('2026-11-06T00:00:02.000Z');
    const stored: ReplyContent = { text: 'first', at: t1, truncated: false };
    const append = storedLeadingReply({ kind: 'append', text: 'second', at: t2.toISOString() });
    if (append === null) throw new Error('no leading reply');
    expect(nextLeadingReply(stored, append)).toEqual({ text: 'first\n\nsecond', at: t2, truncated: false });
    expect(nextLeadingReply(null, append)).toEqual({ text: 'second', at: t2, truncated: false });
    expect(nextLeadingReply({ text: 'x'.repeat(MAX_REPLY_STORE_CHARS), at: t1, truncated: true }, append)).toEqual({
      text: 'x'.repeat(MAX_REPLY_STORE_CHARS),
      at: t2,
      truncated: true,
    });
    const replace = storedLeadingReply({ kind: 'replace', reply: { text: `new ${KEY}`, at: t2.toISOString() } });
    if (replace === null) throw new Error('no leading reply');
    expect(nextLeadingReply(stored, replace)).toEqual({ text: 'new [redacted]', at: t2, truncated: false });
    const drop = storedLeadingReply({ kind: 'replace', reply: null });
    if (drop === null) throw new Error('no leading reply');
    expect(nextLeadingReply(stored, drop)).toBeNull();
    expect(storedLeadingReply(null)).toBeNull();
  });
});
```

**Impact:** new file only. `npm test` picks it up (`tests/unit/**`).

### Step 11: Integration tests against real Postgres

**File:** `tests/integration/sessions.replies.int.test.ts` (new)

```ts
import { readFileSync } from 'node:fs';
import { appendFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { ccSessionReplies } from '../../src/db/schema.js';
import { startSessionIngest, type SessionIngester } from '../../src/sessions/ingest.js';
import { SessionsRepo } from '../../src/sessions/repo.js';
import { createRepoResolver } from '../../src/sessions/repoResolve.js';
import { MAX_REPLY_STORE_CHARS, PROMPTS_VERSION, REPLIES_VERSION, type TranscriptPatch } from '../../src/sessions/types.js';
import { copyFixtureClaudeHome, FIXTURE, MANY_PROMPTS } from '../helpers/claudeHome.js';
import { MIGRATIONS_DIR, closeTestDb, openTestDb, truncateAll } from './setup.js';

const HOST = 'test-host';
const KEY = MANY_PROMPTS.fakeKey;
const MP = FIXTURE.manyPrompts;

let db: Db;
let repo: SessionsRepo;
let home: string;
const running: SessionIngester[] = [];

function start(): SessionIngester {
  const ingester = startSessionIngest({
    claudeHome: home,
    worktreesDir: FIXTURE.worktreesDir,
    homeDir: FIXTURE.homeDir,
    store: repo,
    hostname: () => HOST,
    resolver: createRepoResolver({
      homeDir: FIXTURE.homeDir,
      worktreesDir: FIXTURE.worktreesDir,
      isDirectory: async () => false,
      gitRoots: async () => null,
      listRepoNames: async () => ['mcp-notes'],
    }),
    watch: false,
    sweepMs: 0,
    log: () => undefined,
    gitLog: async () => [],
  });
  running.push(ingester);
  return ingester;
}

async function replies(sessionId: string) {
  return db
    .select({ seq: ccSessionReplies.seq, text: ccSessionReplies.text, at: ccSessionReplies.at, truncated: ccSessionReplies.truncated })
    .from(ccSessionReplies)
    .where(eq(ccSessionReplies.sessionId, sessionId))
    .orderBy(asc(ccSessionReplies.seq));
}

const pairs = async (sessionId: string) => (await replies(sessionId)).map((r) => [r.seq, r.text]);

let tick = 0;
/** One record of the main fixture session, timestamped after everything already in its file. */
function rec(r: Record<string, unknown>): string {
  tick += 1;
  return `${JSON.stringify({ sessionId: FIXTURE.main, cwd: '/home/u/mcp-notes', timestamp: new Date(Date.UTC(2026, 10, 2, 3, 0, tick)).toISOString(), ...r })}\n`;
}
const usage = { input_tokens: 1, output_tokens: 1 };
const human = (text: string): string => rec({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: text } });
const say = (id: string, text: string, extra: Record<string, unknown> = {}): string =>
  rec({ type: 'assistant', ...extra, message: { id, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text }], usage } });
const toolUse = (id: string, toolId: string): string =>
  rec({ type: 'assistant', message: { id, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'Read', input: { file_path: '/home/u/mcp-notes/README.md' } }], usage } });
const toolResult = (toolId: string): string =>
  rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'ok' }] }, toolUseResult: { stdout: 'ok' } });

function patch(sessionId: string, over: Partial<TranscriptPatch> = {}): TranscriptPatch {
  return { sessionId, host: HOST, transcriptPath: `/nowhere/${sessionId}.jsonl`, fromOffset: 0, toOffset: 100, size: 100, ...over };
}

beforeAll(() => {
  db = openTestDb();
  repo = new SessionsRepo(db);
});

afterAll(async () => {
  await closeTestDb(db);
});

beforeEach(async () => {
  await truncateAll(db);
  home = await copyFixtureClaudeHome();
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((i) => i.close()));
  await rm(home, { recursive: true, force: true });
});

describe('migration 0014 (cc_session_replies)', () => {
  it('is journal entry 14', () => {
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.find((e) => e.idx === 14)?.tag).toBe('0014_session_replies');
  });

  it('creates both tables with their keys and indexes', async () => {
    const res = await db.execute<{ indexname: string }>(
      sql`select indexname from pg_indexes where schemaname = 'public' and tablename in ('cc_session_replies', 'cc_session_reply_embeddings')`,
    );
    expect(res.rows.map((r) => r.indexname).sort()).toEqual(
      [
        'cc_session_replies_search_gin',
        'cc_session_replies_session_id_seq_pk',
        'cc_session_reply_embeddings_embedding_hnsw_idx',
        'cc_session_reply_embeddings_next_attempt_idx',
        'cc_session_reply_embeddings_session_id_seq_pk',
      ].sort(),
    );
  });

  it('defaults replies_version to 0, indexes reply words, and cascades deletes', async () => {
    await repo.ensureSession('s-1', HOST);
    expect((await repo.getBySessionId('s-1'))?.repliesVersion).toBe(0);
    await repo.upsertFromTranscript(patch('s-1', { prompts: [{ text: 'q', at: null }], replies: [{ prompt: 0, text: 'the zebrafish migration is done', at: null }] }));
    const hit = await db.execute<{ seq: number }>(
      sql`select seq from cc_session_replies where session_id = 's-1' and search_tsv @@ plainto_tsquery('simple', 'zebrafish')`,
    );
    expect(hit.rows.map((r) => Number(r.seq))).toEqual([1]);
    await db.execute(sql`insert into cc_session_reply_embeddings (session_id, seq, sha, model) values ('s-1', 1, 'sha', 'm')`);
    // The same reply re-read from byte 0 keeps its row, so its vector survives.
    await repo.upsertFromTranscript(patch('s-1', { prompts: [{ text: 'q', at: null }], replies: [{ prompt: 0, text: 'the zebrafish migration is done', at: null }] }));
    expect(Number((await db.execute<{ n: number }>(sql`select count(*)::int as n from cc_session_reply_embeddings`)).rows[0]?.n)).toBe(1);
    // A re-read without that reply deletes it, and its vector with it.
    await repo.upsertFromTranscript(patch('s-1', { prompts: [{ text: 'q', at: null }] }));
    expect(await replies('s-1')).toEqual([]);
    expect(Number((await db.execute<{ n: number }>(sql`select count(*)::int as n from cc_session_reply_embeddings`)).rows[0]?.n)).toBe(0);
    await repo.upsertFromTranscript(patch('s-1', { prompts: [{ text: 'q', at: null }], replies: [{ prompt: 0, text: 'back', at: null }] }));
    await db.execute(sql`delete from cc_sessions where session_id = 's-1'`);
    expect(await replies('s-1')).toEqual([]);
  });
});

describe('ingest stores Claude replies', () => {
  it('stores the final text of each turn of the fixtures, never the narration, and marks rows current', async () => {
    const ingester = start();
    await ingester.ready;
    expect(await ingester.promptsBackfill).toMatchObject({ candidates: 0 });
    expect(await replies(FIXTURE.main)).toEqual([{ seq: 1, text: 'Done: the plan is written.', at: new Date('2026-11-02T02:23:10.000Z'), truncated: false }]);
    expect(await pairs(FIXTURE.worktreeChild)).toEqual([[1, 'Phase 1 implemented.']]);
    const many = await replies(MP);
    expect(many.map((r) => r.seq)).toEqual(Array.from({ length: MANY_PROMPTS.count }, (_, i) => i + 1));
    expect(many[0]).toMatchObject({ text: 'Done with step 1.', at: new Date('2026-10-20T01:01:30.000Z') });
    expect(many.at(-1)?.text).toBe(`Done with step ${MANY_PROMPTS.count}.`);
    const narration = await db.execute<{ n: number }>(sql`select count(*)::int as n from cc_session_replies where text like '%I will read the swarm code first%'`);
    expect(Number(narration.rows[0]?.n)).toBe(0);
    const versions = await db.execute<{ v: number }>(sql`select distinct replies_version as v from cc_sessions`);
    expect(versions.rows.map((r) => Number(r.v))).toEqual([REPLIES_VERSION]);
  });

  it('gives straddling reads and a restart mid-turn the rows a single read gives, redacted', async () => {
    const main = path.join(home, FIXTURE.mainFile);
    let ingester = start();
    await ingester.ready;
    await appendFile(main, human('why does resume break?') + say('msg_r1', 'Let me check the resume code.'));
    await ingester.sweep();
    expect(await pairs(FIXTURE.main)).toEqual([
      [1, 'Done: the plan is written.'],
      [2, 'Let me check the resume code.'],
    ]);
    // A restart mid-turn: the next ingester starts with no carry, and its first read opens with the tool call.
    await ingester.close();
    await appendFile(main, toolUse('msg_r2', 'tu_r1') + toolResult('tu_r1') + say('msg_r3', 'Resume breaks because the tmux target is stale.'));
    ingester = start();
    await ingester.ready;
    expect(await pairs(FIXTURE.main)).toEqual([
      [1, 'Done: the plan is written.'],
      [2, 'Resume breaks because the tmux target is stale.'],
    ]);
    // Text alone across the next boundary continues the stored reply.
    await appendFile(main, say('msg_r4', `Fix: re-read it on attach. ${KEY}`));
    await ingester.sweep();
    await appendFile(main, human('and the hook?') + toolUse('msg_r5', 'tu_r2') + toolResult('tu_r2'));
    await ingester.sweep();
    const incremental = await replies(FIXTURE.main);
    expect(incremental.map((r) => [r.seq, r.text])).toEqual([
      [1, 'Done: the plan is written.'],
      [2, 'Resume breaks because the tmux target is stale.\n\nFix: re-read it on attach. [redacted]'],
    ]);
    const leaked = await db.execute<{ n: number }>(sql`select count(*)::int as n from cc_session_replies where text like ${`%${KEY}%`}`);
    expect(Number(leaked.rows[0]?.n)).toBe(0);
    await ingester.close();
    await truncateAll(db);
    await start().ready;
    expect(await replies(FIXTURE.main)).toEqual(incremental);
  });

  it('caps a long reply and marks it truncated', async () => {
    const main = path.join(home, FIXTURE.mainFile);
    const ingester = start();
    await ingester.ready;
    await appendFile(main, human('write a lot') + say('msg_long', 'word '.repeat(MAX_REPLY_STORE_CHARS)));
    await ingester.sweep();
    const row = (await replies(FIXTURE.main)).find((r) => r.seq === 2);
    expect(row?.truncated).toBe(true);
    expect(row?.text.length).toBe(MAX_REPLY_STORE_CHARS);
  });

  it('never stores sidechain text as a reply', async () => {
    const main = path.join(home, FIXTURE.mainFile);
    const sub = path.join(home, `projects/-home-u-mcp-notes/${FIXTURE.main}/subagents/agent-a1.jsonl`);
    const ingester = start();
    await ingester.ready;
    await appendFile(main, human('ask the subagent') + say('msg_s1', 'sidechain chatter', { isSidechain: true }) + say('msg_s2', 'The subagent finished.'));
    await appendFile(sub, say('msg_s3', 'subagent says hi', { isSidechain: true }));
    await ingester.sweep();
    expect(await pairs(FIXTURE.main)).toEqual([
      [1, 'Done: the plan is written.'],
      [2, 'The subagent finished.'],
    ]);
    const side = await db.execute<{ n: number }>(sql`select count(*)::int as n from cc_session_replies where text like '%sidechain chatter%' or text like '%subagent says hi%'`);
    expect(Number(side.rows[0]?.n)).toBe(0);
  });
});

describe('replies backfill', () => {
  it('fills the replies of a row ingested before them, once', async () => {
    await start().ready;
    await db.execute(sql`update cc_sessions set replies_version = 0 where session_id = ${MP}`);
    await db.execute(sql`delete from cc_session_replies where session_id = ${MP}`);
    const second = start();
    await second.ready;
    expect(await second.promptsBackfill).toMatchObject({ candidates: 1, filled: 1, failed: 0 });
    expect(await replies(MP)).toHaveLength(MANY_PROMPTS.count);
    expect(await repo.getBySessionId(MP)).toMatchObject({ promptsVersion: PROMPTS_VERSION, repliesVersion: REPLIES_VERSION });
    const third = start();
    await third.ready;
    expect(await third.promptsBackfill).toMatchObject({ candidates: 0 });
  });

  it('keeps no replies for a pruned transcript and skips it without a write', async () => {
    const gone = path.join(home, 'projects/-home-u-mcp-notes/5e55a001-0000-4000-8000-0000000000aa.jsonl');
    const current = '5e55a001-0000-4000-8000-0000000000aa';
    await repo.upsertFromTranscript(patch(current, { transcriptPath: gone, toOffset: 50, size: 50, prompts: [{ text: 'q', at: null }] }));
    await db.execute(sql`update cc_sessions set replies_version = 0 where session_id = ${current}`);
    const legacy = '5e55a001-0000-4000-8000-0000000000ab';
    const legacyPath = path.join(home, `projects/-home-u-mcp-notes/${legacy}.jsonl`);
    await repo.upsertFromTranscript(patch(legacy, { transcriptPath: legacyPath, toOffset: 50, size: 50, prompts: [{ text: 'q', at: null }], replies: [{ prompt: 0, text: 'a', at: null }] }));
    await db.execute(sql`update cc_sessions set prompts_version = 0, replies_version = 0 where session_id = ${legacy}`);
    const ingester = start();
    await ingester.ready;
    expect(await ingester.promptsBackfill).toMatchObject({ skipped: 1, redacted: 1, filled: 0, failed: 0 });
    expect(await replies(current)).toEqual([]);
    expect(await replies(legacy)).toEqual([]);
    expect((await repo.getBySessionId(current))?.repliesVersion).toBe(0);
  });
});
```

Note for the implementer: `rec()` timestamps use `Date.UTC(2026, 10, 2, 3, 0, tick)` (2026-11-02T03:00:NNZ),
after the main fixture's last record (02:23:20Z). `tick` is module-level and only grows, so a
re-read of the same file sees the same timestamps.

**Impact:** new file; `npm run test:int` picks it up.

### Step 12: CLAUDE.md sessions paragraph

**File:** `CLAUDE.md:41` — insert this sentence after "...`SessionsRepo` (`src/sessions/repo.ts`) is the only writer of the session tables." (Phase 2 edits other words of the same paragraph; keep both):

```md
Claude's reply to each prompt (the assistant text after the turn's last tool call; never the narration between tool calls or subagent text) is stored redacted in `cc_session_replies` (`drizzle/0014`), keyed to the prompt's seq, capped at `MAX_REPLY_STORE_CHARS` and full-text indexed, next to `cc_session_reply_embeddings` for its vector; a turn split across reads or a restart stores what one read would, rows ingested before it are filled once by the prompts backfill (`REPLIES_VERSION`), and a pruned transcript keeps none.
```

## Principles applied

- Laziness protocol: the one-time backfill reuses `promptsBackfill` / `replacePrompts` (which now writes replies with prompts) instead of a second backfill loop, store method and report; the only addition is the `replies_version` counter and one more `or` in the candidate query.
- Make illegal states unrepresentable: `LeadingReply` is a union (`append` with text | `replace` with a reply or null) instead of a `replace` flag plus nullable text, so "append nothing" cannot be built; replies live in their own array indexed into `prompts` rather than an optional field on `PatchPrompt`, so the prompt shape and its tests stay untouched.
- Boundary discipline: reply text is redacted and capped in exactly one place, `storedReplies` / `storedLeadingReply` in `merge.ts`, at the repo boundary. The accumulator hands over raw text, and nothing downstream redacts again.
- Build the lever: `tests/unit/sessions/replies.test.ts` ingests the transcript cut at every single line and every pair of lines (each read with a fresh accumulator, the same as a restart) and asserts the stored rows equal a single read from 0. A reviewer reruns that test instead of reasoning through append and replace by hand.
- Prove it works: the Proof drives a real verify-notesd daemon over the real fixtures, appends a turn in halves to the run's live transcript, and reads the rows back with `$V sql`.
- Subtract before you add (decision against): bumping `PROMPTS_VERSION` would have avoided a column, but `toPromptsPayload` labels every row below it `transcript_pruned`. That is a visible change in the Prompts modal (R5), so the version is a separate counter.

## Verification

**Build:** `cd /home/miftah/.worktrees/mcp-notes/session-search-context && (test -d node_modules || npm ci) && npm run typecheck`
**Tests:** `npm test` (includes `tests/unit/sessions/replies.test.ts`), `npm run test:int` (includes `tests/integration/sessions.replies.int.test.ts`); one file: `npm run test:int -- tests/integration/sessions.replies.int.test.ts`
**Proof:**
- Harness: `.claude/skills/verify-notesd` (`V=$PWD/.claude/skills/verify-notesd/scripts/verify.sh`, run from the worktree root)
- Feature-map entries: none. This phase adds no user-visible behavior: nothing reads replies until Phase 5, which owns the `features/projects.md` entry.
- Journeys:

  **J1. Fresh ingest stores each turn's final text, not narration.**
  ```sh
  cd /home/miftah/.worktrees/mcp-notes/session-search-context
  V=$PWD/.claude/skills/verify-notesd/scripts/verify.sh
  NOTESD_CLAUDE_BIN=/nonexistent/claude $V up --sessions     # note RUN=... and URL=...
  curl -sf --retry 30 --retry-delay 1 --retry-all-errors "$URL/api/projects/mcp-notes/sessions" >/dev/null
  timeout 60 bash -c "until $V sql $RUN \"select count(*) from cc_session_replies where session_id = '5e55a001-0000-4000-8000-000000000005'\" | grep -qw 106; do sleep 2; done"
  $V sql $RUN "select session_id, seq, text, truncated from cc_session_replies where session_id in ('5e55a001-0000-4000-8000-000000000001','5e55a001-0000-4000-8000-000000000002') order by 1, 2"
  $V sql $RUN "select count(*) from cc_session_replies where text like '%I will read the swarm code first%'"
  $V sql $RUN "select prompts_version, replies_version, count(*) from cc_sessions group by 1, 2"
  $V note $RUN "J1: fixture replies stored, narration excluded, rows at replies_version 1"
  ```
  Passes when the 106 wait succeeds, and the second query returns exactly `…0001 | 1 | Done: the plan is written. | f` and `…0002 | 1 | Phase 1 implemented. | f`. The narration count must be `0`, and every `cc_sessions` row must be `3 | 1`.

  **J2. A turn split across two live reads: the tool call supersedes the narration, the secret is redacted, the words are searchable, and a text-only continuation is appended.**
  ```sh
  S=5e55a001-0000-4000-8000-000000000001
  F="$HOME/.local/state/notesd-verify/$RUN/claude/projects/-home-u-mcp-notes/$S.jsonl"
  printf '%s\n' \
    '{"type":"user","sessionId":"'$S'","cwd":"/home/u/mcp-notes","origin":{"kind":"human"},"message":{"role":"user","content":"why does resume break?"},"timestamp":"2026-11-02T03:00:01.000Z"}' \
    '{"type":"assistant","sessionId":"'$S'","message":{"id":"msg_v1","model":"claude-opus-5-5","role":"assistant","content":[{"type":"text","text":"Let me check the resume code."}],"usage":{"input_tokens":1,"output_tokens":1}},"timestamp":"2026-11-02T03:00:02.000Z"}' >> "$F"
  timeout 90 bash -c "until $V sql $RUN \"select text from cc_session_replies where session_id = '$S' and seq = 2\" | grep -q 'Let me check the resume code.'; do sleep 2; done"
  printf '%s\n' \
    '{"type":"assistant","sessionId":"'$S'","message":{"id":"msg_v2","model":"claude-opus-5-5","role":"assistant","content":[{"type":"tool_use","id":"tu_v1","name":"Read","input":{"file_path":"/home/u/mcp-notes/README.md"}}],"usage":{"input_tokens":1,"output_tokens":1}},"timestamp":"2026-11-02T03:00:03.000Z"}' \
    '{"type":"user","sessionId":"'$S'","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_v1","content":"ok"}]},"toolUseResult":{"stdout":"ok"},"timestamp":"2026-11-02T03:00:04.000Z"}' \
    '{"type":"assistant","sessionId":"'$S'","message":{"id":"msg_v3","model":"claude-opus-5-5","role":"assistant","content":[{"type":"text","text":"The zebrafish fix: the tmux target is stale. Token sk-ant-api03-FAKE-not-a-real-key-0000000000"}],"usage":{"input_tokens":1,"output_tokens":1}},"timestamp":"2026-11-02T03:00:05.000Z"}' >> "$F"
  timeout 90 bash -c "until $V sql $RUN \"select text from cc_session_replies where session_id = '$S' and seq = 2\" | grep -q 'zebrafish'; do sleep 2; done"
  printf '%s\n' \
    '{"type":"assistant","sessionId":"'$S'","message":{"id":"msg_v4","model":"claude-opus-5-5","role":"assistant","content":[{"type":"text","text":"Second paragraph of the answer."}],"usage":{"input_tokens":1,"output_tokens":1}},"timestamp":"2026-11-02T03:00:06.000Z"}' >> "$F"
  timeout 90 bash -c "until $V sql $RUN \"select text from cc_session_replies where session_id = '$S' and seq = 2\" | grep -q 'Second paragraph'; do sleep 2; done"
  $V sql $RUN "select seq, text, at from cc_session_replies where session_id = '$S' order by seq"
  $V sql $RUN "select count(*) from cc_session_replies where text like '%sk-ant-%'"
  $V sql $RUN "select seq from cc_session_replies where session_id = '$S' and search_tsv @@ plainto_tsquery('simple', 'zebrafish')"
  $V note $RUN "J2: straddling turn superseded then appended, redacted, full-text indexed"
  ```
  Passes when all three waits succeed and the final listing holds exactly two rows. Seq 1 is `Done: the plan is written.`. Seq 2 is `The zebrafish fix: the tmux target is stale. Token [redacted]`, then a blank line, then `Second paragraph of the answer.`, with `at` = 2026-11-02T03:00:06Z (however psql renders that instant), and it no longer contains `Let me check`. The `sk-ant-` count must be `0`, and the tsquery must return `2`.

  **J3. Backfill and daemon restart mid-turn.** Not drivable on a run: `$V down` drops the run's database, so a daemon cannot be restarted against the same rows. Run instead:
  `npm run test:int -- tests/integration/sessions.replies.int.test.ts`. This is a real Postgres and the real ingester, and a new ingester is a restart. It passes when the `replies backfill` tests (fills once, then `candidates: 0`; pruned transcript `skipped`, legacy `redacted`, no replies) and the test `gives straddling reads and a restart mid-turn the rows a single read gives, redacted` all pass. Then run `npm test -- tests/unit/sessions/replies.test.ts`, which passes when every split point and every pair of split points passes.

- Neighbor check: the prompt writer changed, so prove the Prompts modal API and session search on the same run:
  ```sh
  NODE=$(curl -sf "$URL/api/projects/mcp-notes/sessions" | jq -r '.nodes[] | select(.session_id=="5e55a001-0000-4000-8000-000000000001") | .node_id')
  $V api $RUN GET /api/sessions/$NODE/prompts
  BIG=$(curl -sf "$URL/api/projects/mcp-notes/sessions" | jq -r '.nodes[] | select(.session_id=="5e55a001-0000-4000-8000-000000000005") | .node_id')
  $V api $RUN GET /api/sessions/$BIG/prompts
  $V mcp $RUN sessions_search '{"query":"project session graph"}'
  $V down $RUN
  ```
  Passes when `$NODE`'s prompts return `complete: true` with exactly 2 prompts (`sketch the project-session-graph feature`, `why does resume break?`, `n` 1..2). `$BIG` must return `complete: true` with 106 prompts. `sessions_search` must return hits with the unchanged shape (`node_id`, `score`, `via_notes`) and no new field.
- Cost: none (no `--embed`, summarizer off via `NOTESD_CLAUDE_BIN=/nonexistent/claude`, no chat).

**Exit criteria:** `npm run typecheck`, `npm test` and `npm run test:int` pass. On a verify run over
`tests/fixtures/claude-home`, each fixture prompt that Claude answered has exactly one redacted
`cc_session_replies` row holding the turn's final text. A turn appended in two halves while the
daemon runs ends with the row a from-0 read gives. A row at `replies_version 0` is filled by the
backfill exactly once.

## Handoffs

- **Phase 4 (R3):** `cc_session_reply_embeddings` exists and is empty, with the columns listed in the contract (no `created_at`). Reply `text` is already redacted, so the sha and the embed input come from the stored text (`encode(sha256(convert_to("cc_session_replies"."text", 'UTF8')), 'hex')`). A changed reply is **updated in place** (same `(session_id, seq)`, the vector row kept), so the worker must detect staleness by sha. Only a deleted reply loses its vector, through the cascade. A from-byte-0 re-read whose replies did not change rewrites nothing. The worker should embed only replies of sessions whose `host` is this machine, if it wants to mirror ingest ownership; replies of both hosts sit in one table. Phase 4 also adds `cc_session_reply_embeddings` to the `SessionsRepo` class doc list this phase edits (`repo.ts:173-178`).
- **Phase 5 (R3, R4):** the full-text source is `cc_session_replies.search_tsv` (`simple`, GIN `cc_session_replies_search_gin`), joined to `cc_sessions` on `session_id`, with `seq` and `text` available for `via_replies [{seq, excerpt}]`. A prompt with no reply has no row. README, `features/projects.md` and the final CLAUDE.md wording for search over replies are Phase 5's.
- **Phase 2 (R1):** this phase's `schema.ts` header sentence goes after Phase 2's 0013 sentence, and its CLAUDE.md sentence goes into the same paragraph Phase 2 edits. The reconciler keeps both.
- **Landing (whoever ships the set):** `npm run db:migrate` (0013 and 0014) must run **before** the rebuilt daemon restarts. `SessionsRepo`'s `SESSION_COLUMNS` selects `replies_version`, so new code against an unmigrated DB fails every session read and write. The old daemon on the other laptop is safe against the migrated DB. After the restart, each host backfills its own rows once (a re-read of its transcripts, a few seconds).
- **Drive-by noticed, not done:** `formatPromptsReport` still says "prompts backfill" though it now also counts replies. Renaming the log text is cosmetic, so it is left alone.

## Rollback

Revert this phase's commit. Then drop what 0014 created, because drizzle has no down migrations:
```sql
drop table if exists cc_session_reply_embeddings;
drop table if exists cc_session_replies;
alter table cc_sessions drop column if exists replies_version;
delete from drizzle.__drizzle_migrations where created_at = (select max(created_at) from drizzle.__drizzle_migrations);  -- only if 0014 is the latest applied
```
Run the SQL through the direct (unpooled) URL. Do it before restarting a daemon built from the
reverted code, which does not know the column (harmless) or the tables (harmless). The data is
derived, so a later re-apply rebuilds it through the backfill (`replies_version` starts at 0
again).
