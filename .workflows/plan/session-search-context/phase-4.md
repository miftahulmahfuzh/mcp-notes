# Phase 4: Reply embedding worker

**Plan set:** `SESSION_SEARCH_CONTEXT_PLAN.md`
**Analysis:** `.workflows/analyze/20261106-145826-SSC7_code_analyzer.md`
**Satisfies:** R3, the semantic half: every persisted Claude reply gets its own current vector, so phase 5 can search replies by meaning
**Depends on:** Phase 3 (tables `cc_session_replies`, `cc_session_reply_embeddings`, drizzle exports `ccSessionReplies`, `ccSessionReplyEmbeddings`, and the ingester that fills replies). Phase 2 lands before it transitively (3 depends on 2), so `SessionEmbeddingInput` already carries phase 2's required `textVersion`.
**Difficulty:** NORMAL
**Package:** `src/sessions` (+ a small generalization in `src/embeddings/worker.ts`)

---

## Goal

After this phase every non-blank row of `cc_session_replies` belonging to a session of this host has a row in `cc_session_reply_embeddings` holding a vector made by the configured embedder from that reply's current text. The row is keyed by `sha256(text)` and the model id. A reply whose text changes is re-embedded. Failures back off with the note-embedding schedule and are retried. The worker runs in the background, never touches ingest, starts only when an embedder exists and session ingest is on, and `close()` waits at most 5 s. Phase 5 reads the vectors through the exported `isCurrentReplyEmbeddingSql(model)`.

## Interface Contract

**Deletes:** none

**Renames:** none

**Creates:**
- `src/sessions/replyEmbeddings.ts` (new file):
  - `currentReplySha256Sql(): SQL` renders `encode(sha256(convert_to("cc_session_replies"."text", 'UTF8')), 'hex')`. It is the SQL twin of `bodySha256(text)` from `src/embeddings/state.ts`.
  - `isCurrentReplyEmbeddingSql(model: string): SQL` is **the "current vector" predicate phase 5 must use**:
    ```sql
    ("cc_session_reply_embeddings"."embedding" is not null
     and "cc_session_reply_embeddings"."sha" = encode(sha256(convert_to("cc_session_replies"."text", 'UTF8')), 'hex')
     and "cc_session_reply_embeddings"."model" = $model)
    ```
    It returns null (not false) when a left join found no embedding row. The caller must join `cc_session_replies` and `cc_session_reply_embeddings` on `(session_id, seq)` and **must not alias either table**, because the fragment uses table-qualified names. This is the same rule as `isCurrentEmbeddingSql` in `src/embeddings/repo.ts`. Phase 5 passes `embedder.model`.
  - `dbReplyEmbeddingStore(db: Db, repo: SessionsRepo, host: string): EmbeddingStore` reads by raw SQL and writes only through `SessionsRepo`.
  - `ReplyEmbeddingWorkerOptions` (type) and `startReplyEmbeddingWorker(opts): EmbeddingWorker`.
  - `REPLY_EMBEDDINGS_LABEL = 'reply embeddings'`, the log prefix.
- `SessionsRepo.saveReplyEmbedding(sessionId: string, seq: number, input: Omit<SessionEmbeddingInput, 'textVersion'>): Promise<boolean>` (`src/sessions/repo.ts`). Reply vectors have no embed-text layout version (the input is the stored reply text itself), so phase 2's required `textVersion` is omitted rather than faked.
- `SessionsRepo.recordReplyEmbeddingFailure(sessionId: string, seq: number, input: SessionEmbeddingFailure): Promise<void>` (`src/sessions/repo.ts`).
- `NON_BLANK_PATTERN` becomes exported from `src/embeddings/repo.ts`. Only the visibility changes; the value is the same.

**Signature changes (additive, back-compatible):**
- `EmbeddingWorkerOptions.events: NoteEvents` -> `events?: NoteEvents`. Without it, only `kick()` and the sweep start drains.
- `EmbeddingWorkerOptions` gains `label?: string` (default `'embeddings'`) and `itemNoun?: string` (default `'note'`).
- `formatBatch(r)` -> `formatBatch(r, label = 'embeddings', itemNoun = 'note')`. With the defaults the output is byte-identical to today's.

**Decision: who writes `cc_session_reply_embeddings`.** It is `SessionsRepo`, through two new methods. That keeps CLAUDE.md's rule that "`SessionsRepo` is the only writer of the session tables" literally true. `replyEmbeddings.ts` only reads, the same way `dbSummaryStore` in `summaryWorker.ts` reads by raw SQL and writes through the repo.

**Decision: host scope.** Each daemon embeds only the replies of sessions whose `cc_sessions.host` is its own host. This matches the summary/session-embedding worker and invariant 6 (the owning host writes a session's replies). It also means the two machines never pay twice for the same rows or race on them. Vectors live in the shared DB, so both machines can search them.

**Requires (from earlier phases):**
- Phase 3: migration `drizzle/0014_*` creates these tables:
  - `cc_session_replies(session_id text not null, seq integer not null, at timestamptz, text text not null, truncated boolean not null default false, search_tsv generated)`, with primary key `(session_id, seq)` and an FK to `cc_sessions` with on delete cascade.
  - `cc_session_reply_embeddings(session_id text not null, seq integer not null, embedding vector(1536) null, sha text not null, model text not null, attempts integer not null default 0, last_error text, next_attempt_at timestamptz, embedded_at timestamptz, updated_at timestamptz not null default now())`, with primary key `cc_session_reply_embeddings_session_id_seq_pk (session_id, seq)` (the `on conflict` target used here). There is **no `created_at`** column (phase-3.md contract); nothing here writes one.
  - FK `cc_session_reply_embeddings_reply_fk (session_id, seq)` → `cc_session_replies (session_id, seq)` on delete cascade. Saves and failures are `insert ... select from cc_session_replies`, so this phase never tries to write an orphan; tests seed the reply row before any embedding row.
- Phase 3: `src/db/schema.ts` exports `ccSessionReplies` (columns incl. `.text`) and `ccSessionReplyEmbeddings` (columns `.sessionId`, `.seq`, `.sha`, `.model`, `.attempts`, `.embedding`), confirmed against phase-3.md Step 1. The SQL bodies use the table and column names above.
- Phase 3: reply `text` is stored already redacted (`redactSecrets`). The sha and the embed input are taken from the stored text, so nothing unredacted reaches the embedder.
- Phase 3: `tests/integration/setup.ts` `truncateAll` includes both new tables. Truncating `cc_sessions ... cascade` empties them anyway if they reference it.
- Phase 3 edits the `SessionsRepo` class doc comment (`src/sessions/repo.ts:174-178`) to add `cc_session_replies` and adds `ccSessionReplies` to the schema import on `repo.ts:6`. Step 4 below quotes both as they look after phase 3 and adds this phase's names to them.

**Leaves alone (owned by others):**
- `src/sessions/search.ts` and `src/search/blend.ts`: phase 1 and phase 5.
- `src/db/schema.ts`, `drizzle/*`, `src/sessions/transcript.ts`, `ingest.ts`, `merge.ts`, `types.ts`, `tests/integration/setup.ts`: phase 3.
- `summarize.ts` and `summaryWorker.ts`: phase 2.
- `README.md`, `CLAUDE.md` and `.claude/skills/verify-notesd/features/*.md`: phase 5 documents this worker.
- `web/**`: R5; nothing under it changes.

## Files

| File | Action | What changes |
|---|---|---|
| `src/embeddings/worker.ts` | modify (`:27-40`, `:51-63`, `:65-123`) | `events` optional, `label` / `itemNoun` options for log lines; note worker behavior and output unchanged |
| `src/embeddings/repo.ts` | modify (`:40`) | `export const NON_BLANK_PATTERN` |
| `src/sessions/replyEmbeddings.ts` | create | SQL fragments, reply store (reads), `startReplyEmbeddingWorker` |
| `src/sessions/repo.ts` | modify (`:6` imports, `:174-178` doc, insert after `:921`) | `saveReplyEmbedding`, `recordReplyEmbeddingFailure` |
| `src/background.ts` | modify (`:1-16` imports, `:29-40` doc, `:85-101`, `:137-151`) | start the reply worker with session ingest when an embedder exists; kick on ingest passes; close on stop |
| `tests/unit/embeddings/worker.test.ts` | modify (append to the `describe`, after `:194`) | no-events worker; label / noun in log lines |
| `tests/unit/sessions/replyEmbeddings.test.ts` | create | reply worker log prefix, drain-failure log, close grace |
| `tests/integration/sessions.replyEmbeddings.int.test.ts` | create | store + repo + worker + startBackground against Postgres with the fake embedder |

## Implementation Steps

### Step 0: Install dependencies if the worktree has none
**File:** none (worktree root)
**Change:** the worktree has no `node_modules` until a phase installs them. Run once, before anything else:
```sh
cd /home/miftah/.worktrees/mcp-notes/session-search-context
[ -d node_modules ] || npm ci
```
**Impact:** none on the tree.

### Step 1: Let the generic embedding worker run without note events and name itself
**File:** `src/embeddings/worker.ts:1-165` (whole file shown; changes at the options interface `:27-40`, `formatBatch` `:51-63`, the drain-failed log `:90`, and the subscription `:120-122`)
**Change:** This step reuses the existing worker and does not copy it. `events` becomes optional, because replies do not come with note events: they are kicked by the ingest observer and the 60 s sweep. Two optional strings name the worker in its log lines. The defaults keep every existing log line byte-identical, so `tests/unit/embeddings/worker.test.ts` and `tests/integration/embeddings.worker.int.test.ts` pass unchanged.
**Code:**
```ts
import type { NoteEvents } from '../notes/events.js';
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_MIN_INTERVAL_MS,
  RateLimiter,
  errorMessage,
  realClock,
  runBackfill,
  type BatchReport,
  type Clock,
  type EmbeddingStore,
} from './backfill.js';
import type { Embedder } from './embedder.js';

/** Sweep period: the other machine's writes and due retries are picked up within this. */
export const DEFAULT_SWEEP_MS = 60_000;
/** Coalesces a burst of writes (an import, a quick edit loop) into one drain. */
export const DEFAULT_DEBOUNCE_MS = 500;
/**
 * close() waits this long for an in-flight batch. Kept well under src/main.ts's 10 s forced exit
 * (the OpenRouter timeout is 15 s); a call abandoned here loses nothing, its note stays pending.
 */
export const DEFAULT_CLOSE_GRACE_MS = 5_000;
/** Error text in a log line is cut here; the full (≤ 500 char) text is in note_embeddings.last_error. */
const LOG_ERROR_CHARS = 200;

export interface EmbeddingWorkerOptions {
  store: EmbeddingStore;
  /**
   * Note events: `created` / `updated` schedule a drain. Omitted (session replies, which are kicked
   * by the session ingester): only `kick()` and the sweep start drains.
   */
  events?: NoteEvents;
  embedder: Embedder;
  /** Names the worker in log lines: `[notesd] <label>: ...`. Default 'embeddings'. */
  label?: string;
  /** What one input is, for the fallback wording (`per-<itemNoun> fallback`). Default 'note'. */
  itemNoun?: string;
  batchSize?: number;
  minIntervalMs?: number;
  sweepMs?: number;
  debounceMs?: number;
  /** How long close() waits for an in-flight batch. Default DEFAULT_CLOSE_GRACE_MS. */
  closeGraceMs?: number;
  clock?: Clock;
  /** One line per batch that made a call, and per failed drain. Default console.log. */
  log?: (line: string) => void;
}

export interface EmbeddingWorker {
  /** Schedule a drain (debounced). No-op after close. */
  kick(): void;
  /** Resolves once no drain is scheduled or running (a pending debounce runs now). For tests. */
  idle(): Promise<void>;
  /** Stops listening and sweeping, then waits (at most closeGraceMs) for the in-flight batch to finish and save. */
  close(): Promise<void>;
}

/** e.g. `[notesd] embeddings: 15/16 embedded, 1 failed (A-B32: OpenRouter ...), per-note fallback, 17 calls, 2310ms` */
export function formatBatch(r: BatchReport, label = 'embeddings', itemNoun = 'note'): string {
  const parts = [`[notesd] ${label}: ${r.embedded}/${r.notes} embedded`];
  if (r.skipped > 0) parts.push(`${r.skipped} changed meanwhile`);
  if (r.failed > 0) {
    const first = r.failures[0];
    const detail = first === undefined ? '' : ` (${first.id}: ${first.error.slice(0, LOG_ERROR_CHARS)})`;
    parts.push(`${r.failed} failed${detail}`);
  }
  if (r.fellBack) parts.push(`per-${itemNoun} fallback`);
  parts.push(`${r.calls} call${r.calls === 1 ? '' : 's'}, ${r.ms}ms`);
  return parts.join(', ');
}

export function startEmbeddingWorker(opts: EmbeddingWorkerOptions): EmbeddingWorker {
  const log = opts.log ?? ((line: string) => console.log(line));
  const label = opts.label ?? 'embeddings';
  const itemNoun = opts.itemNoun ?? 'note';
  const clock = opts.clock ?? realClock;
  const limiter = new RateLimiter(opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS, clock);
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const closeGraceMs = opts.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
  const abort = new AbortController();
  let closed = false;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let again = false;

  const drainOnce = async (): Promise<void> => {
    try {
      await runBackfill({
        store: opts.store,
        embedder: opts.embedder,
        batchSize,
        limiter,
        clock,
        signal: abort.signal,
        onBatch: (report) => log(formatBatch(report, label, itemNoun)),
      });
    } catch (err) {
      log(`[notesd] ${label}: drain failed: ${errorMessage(err).slice(0, LOG_ERROR_CHARS)}`);
    }
  };

  const drain = (): void => {
    if (closed) return;
    if (running !== null) {
      again = true;
      return;
    }
    running = (async () => {
      do {
        again = false;
        await drainOnce();
      } while (again && !closed);
    })().finally(() => {
      running = null;
    });
  };

  const kick = (): void => {
    if (closed || debounce !== null) return;
    debounce = setTimeout(() => {
      debounce = null;
      drain();
    }, debounceMs);
  };

  const sweep = setInterval(drain, opts.sweepMs ?? DEFAULT_SWEEP_MS);
  sweep.unref();
  const unsubscribe =
    opts.events?.on((event) => {
      if (event.op === 'created' || event.op === 'updated') kick();
    }) ?? ((): void => {});
  drain();

  return {
    kick,
    async idle(): Promise<void> {
      for (;;) {
        if (debounce !== null) {
          clearTimeout(debounce);
          debounce = null;
          drain();
        }
        const current = running;
        if (current === null) return;
        await current;
      }
    },
    async close(): Promise<void> {
      if (!closed) {
        closed = true;
        unsubscribe();
        clearInterval(sweep);
        if (debounce !== null) {
          clearTimeout(debounce);
          debounce = null;
        }
        abort.abort();
      }
      const current = running;
      if (current === null) return;
      // Bounded: a call still in flight after the grace is abandoned; the daemon then closes the
      // pool, its save fails into the drain's catch, and the note stays pending for the next start.
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        current,
        new Promise<void>((resolve) => {
          grace = setTimeout(resolve, closeGraceMs);
          grace.unref();
        }),
      ]);
      clearTimeout(grace);
    },
  };
}
```
Before writing, confirm what `NoteEvents.on` returns (`src/notes/events.ts`). The current code calls it as `const unsubscribe = opts.events.on(...)` and then `unsubscribe()`, so it returns a `() => void`. The `?? (() => {})` fallback has the same type.
**Impact:** None for the note and image workers. `imageWorker.ts` imports only the constants and the `EmbeddingWorker` type. Check now: `npm run typecheck && npx vitest run tests/unit/embeddings/worker.test.ts` passes before you touch anything else.

### Step 2: Export the non-blank pattern
**File:** `src/embeddings/repo.ts:40`
**Change:** Make the existing constant exportable so the reply store skips blank replies exactly the way `embedInput` does. If they were not skipped, a blank row would be listed on every page and could fill the backfill's `limit`.
**Code:**
```ts
/**
 * Postgres regex matching any character JS `String.prototype.trim` keeps, so
 * `body ~ NON_BLANK_PATTERN` is exactly `embedInput(body) !== null`. Bound as a parameter, so
 * the backslash escapes reach the regex engine untouched. Also used by src/sessions/replyEmbeddings.ts.
 */
export const NON_BLANK_PATTERN =
  '[^\\u0009\\u000a\\u000b\\u000c\\u000d\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]';
```
**Impact:** none. Only the visibility changes.

### Step 3: Reply embedding store and worker
**File:** `src/sessions/replyEmbeddings.ts` (new)
**Change:** This file does three things. It defines the sha and "current" SQL fragments that phase 5 imports. It adds an `EmbeddingStore` adapter over `cc_session_replies` / `cc_session_reply_embeddings`, so the existing `runBackfill` drives the batching, the rate limit, the per-item fallback, settle-once and backoff. It adds a thin `startReplyEmbeddingWorker` over `startEmbeddingWorker`. `EmbeddingStore` items carry a string id, so each reply's id is encoded as `<session_id>#<seq>`. Session ids are UUIDs and never contain `#`. The id appears only inside this adapter and in failure log lines.
**Code:**
```ts
import { sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { ccSessionReplies, ccSessionReplyEmbeddings } from '../db/schema.js';
import type { EmbeddingStore } from '../embeddings/backfill.js';
import { NON_BLANK_PATTERN, type PendingNote } from '../embeddings/repo.js';
import { startEmbeddingWorker, type EmbeddingWorker, type EmbeddingWorkerOptions } from '../embeddings/worker.js';
import type { SessionsRepo } from './repo.js';

/**
 * Background embeddings for Claude's replies (`cc_session_replies`, written by the session
 * ingester through SessionsRepo). One vector per reply in `cc_session_reply_embeddings`, keyed
 * by (session_id, seq), tied to the text it was made from by `sha` = sha256 of the stored
 * (already redacted) text, and to the embedder by `model`. The vector is current iff it is not
 * null and both keys still match (`isCurrentReplyEmbeddingSql`). Embed input is the text trimmed
 * and clamped by `embedInput` (8000 chars), exactly like a note body.
 *
 * Reads here, writes only through SessionsRepo (`saveReplyEmbedding`, `recordReplyEmbeddingFailure`).
 * Batching, rate limit, per-reply fallback, retry backoff (`retryDelayMs`) and error clamping
 * (`clampError`) are the note embedding worker's (src/embeddings/backfill.ts, worker.ts): this
 * module only supplies the store. Never blocks or fails ingest: the ingester only kicks it.
 *
 * The SQL fragments name the two tables without an alias. A caller that joins them into its own
 * query (search, phase 5) must not alias `cc_session_replies` or `cc_session_reply_embeddings`.
 */

/** Log prefix: `[notesd] reply embeddings: ...`. */
export const REPLY_EMBEDDINGS_LABEL = 'reply embeddings';

/** `encode(sha256(convert_to(cc_session_replies.text, 'UTF8')), 'hex')`: the SQL twin of `bodySha256(text)`. */
export function currentReplySha256Sql(): SQL {
  return sql`encode(sha256(convert_to(${ccSessionReplies.text}, 'UTF8')), 'hex')`;
}

/**
 * True when the joined `cc_session_reply_embeddings` row holds a vector made from the reply's
 * current text by `model`. Null (not false) when a left join found no row; wrap in
 * `coalesce(..., false)` where that matters. The ONE definition of a usable reply vector.
 */
export function isCurrentReplyEmbeddingSql(model: string): SQL {
  return sql`(${ccSessionReplyEmbeddings.embedding} is not null and ${ccSessionReplyEmbeddings.sha} = ${currentReplySha256Sql()} and ${ccSessionReplyEmbeddings.model} = ${model})`;
}

const KEY_SEPARATOR = '#';

function replyKey(sessionId: string, seq: number): string {
  return `${sessionId}${KEY_SEPARATOR}${seq}`;
}

function parseReplyKey(key: string): { sessionId: string; seq: number } {
  const at = key.lastIndexOf(KEY_SEPARATOR);
  const seq = at > 0 ? Number(key.slice(at + 1)) : Number.NaN;
  if (!Number.isInteger(seq) || seq < 0) throw new Error(`not a reply key: ${key}`);
  return { sessionId: key.slice(0, at), seq };
}

type PendingReplyDbRow = { session_id: string; seq: number | string; text: string; sha: string };

/**
 * The reply store for `runBackfill` / `startEmbeddingWorker`. Pending = a non-blank reply of a
 * session of `host` whose embedding row is missing, stale (other sha or model), or failed for
 * this text and due (`next_attempt_at <= now()`; `ignoreBackoff` makes every failure due).
 * Most recently active sessions first, then session id, then seq.
 */
export function dbReplyEmbeddingStore(db: Db, repo: SessionsRepo, host: string): EmbeddingStore {
  return {
    async listPending(o): Promise<PendingNote[]> {
      const limit = Math.max(1, Math.trunc(o.limit));
      const due = o.ignoreBackoff
        ? sql`true`
        : sql`(cc_session_reply_embeddings.next_attempt_at is null or cc_session_reply_embeddings.next_attempt_at <= now())`;
      const res = await db.execute<PendingReplyDbRow>(sql`
        select cc_session_replies.session_id, cc_session_replies.seq, cc_session_replies.text,
               ${currentReplySha256Sql()} as sha
        from cc_session_replies
        join cc_sessions on cc_sessions.session_id = cc_session_replies.session_id
        left join cc_session_reply_embeddings
          on cc_session_reply_embeddings.session_id = cc_session_replies.session_id
         and cc_session_reply_embeddings.seq = cc_session_replies.seq
        where cc_sessions.host = ${host}
          and cc_session_replies.text ~ ${NON_BLANK_PATTERN}
          and (
            cc_session_reply_embeddings.session_id is null
            or cc_session_reply_embeddings.model <> ${o.model}
            or cc_session_reply_embeddings.sha <> ${currentReplySha256Sql()}
            or (cc_session_reply_embeddings.embedding is null and ${due})
          )
        order by cc_sessions.last_active_at desc nulls last, cc_session_replies.session_id asc, cc_session_replies.seq asc
        limit ${limit}
      `);
      return res.rows.map((r) => ({ id: replyKey(r.session_id, Number(r.seq)), body: r.text, bodySha256: r.sha }));
    },
    async saveEmbedding(v): Promise<boolean> {
      const { sessionId, seq } = parseReplyKey(v.noteId);
      return repo.saveReplyEmbedding(sessionId, seq, { sha: v.bodySha256, model: v.model, embedding: v.embedding });
    },
    async recordFailure(v): Promise<void> {
      const { sessionId, seq } = parseReplyKey(v.noteId);
      await repo.recordReplyEmbeddingFailure(sessionId, seq, { sha: v.bodySha256, model: v.model, error: v.error });
    },
  };
}

/** The note worker's knobs, minus what this worker fixes (no note events, its own log label). */
export type ReplyEmbeddingWorkerOptions = Omit<EmbeddingWorkerOptions, 'events' | 'label' | 'itemNoun'>;

/**
 * Embeds pending replies at start, on `kick()` (the session ingester calls it after a sweep that
 * wrote rows) and every sweep (60 s: catches the watcher's reads, the one-time replies backfill and
 * due retries). `close()` waits at most `closeGraceMs` (5 s) for the in-flight batch.
 */
export function startReplyEmbeddingWorker(opts: ReplyEmbeddingWorkerOptions): EmbeddingWorker {
  return startEmbeddingWorker({ ...opts, label: REPLY_EMBEDDINGS_LABEL, itemNoun: 'reply' });
}
```
**Impact:** It compiles only once phase 3's schema exports exist (`Depends on: 3`). `repo.ts` imports `currentReplySha256Sql` from this file, and this file imports only the *type* `SessionsRepo`, so there is no runtime import cycle.

### Step 4: SessionsRepo writes reply vectors and failures
**File:** `src/sessions/repo.ts`
- `:6`: add `ccSessionReplyEmbeddings` to the schema import.
- After `:9`: add `import { currentReplySha256Sql } from './replyEmbeddings.js';`.
- `:174-178`: the class doc comment.
- Insert the two methods after `recordEmbeddingFailure` ends (`:921`), before `// ---------- settings (Phase 7) ----------`.

**Change:** These are the only writes to `cc_session_reply_embeddings`. They mirror `src/embeddings/repo.ts` `saveEmbedding` / `recordFailure`. A save is conditional on the reply still hashing to `sha`, so a vector made from text that was replaced mid-call is dropped and the new text stays pending. A failure never overwrites a current vector for the same target. Backoff is `retryDelayMs`, and the stored error is `clampError(error)`. Both methods reuse the existing types: `Omit<SessionEmbeddingInput, 'textVersion'>` (phase 2 made `textVersion` required on `SessionEmbeddingInput`; it is the session embed-text layout version and means nothing for a reply) and `SessionEmbeddingFailure` (`src/sessions/types.ts`). No new types are added, and `types.ts` is not edited.

**Code: import line `:6` (phase 3 already added `ccSessionReplies`; this adds `ccSessionReplyEmbeddings`):**
```ts
import { appSettings, ccPendingSpawns, ccSessionEmbeddings, ccSessionPromptImages, ccSessionPrompts, ccSessionReplies, ccSessionReplyEmbeddings, ccSessions, ccSubagentTranscripts } from '../db/schema.js';
```
**Code: new import, placed after `import { clampError, retryDelayMs } from '../embeddings/state.js';`:**
```ts
import { currentReplySha256Sql } from './replyEmbeddings.js';
```
**Code: class doc comment `:174-178` (as phase 3 left it, plus `cc_session_reply_embeddings` and the reply worker):**
```ts
/**
 * The only writer of `cc_sessions`, `cc_session_prompts`, `cc_session_replies`, `cc_subagent_transcripts`,
 * `cc_session_embeddings`, `cc_session_reply_embeddings`, `cc_pending_spawns` and `app_settings`.
 * Ingest, the heuristic linker, the hook endpoints, the summary worker, the reply embedding worker,
 * the Summarize request route and the read API all go through it; nothing else writes these tables.
 */
```
**Code: methods inserted after `recordEmbeddingFailure`:**
```ts
  // ---------- reply embeddings (cc_session_reply_embeddings) ----------

  /**
   * Stores the vector of reply (`sessionId`, `seq`), but only while the reply's text still hashes
   * to `input.sha` (it may have been replaced during the call). Clears any failure. False when
   * skipped (text changed or reply gone). Idempotent.
   */
  async saveReplyEmbedding(sessionId: string, seq: number, input: Omit<SessionEmbeddingInput, 'textVersion'>): Promise<boolean> {
    if (input.embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`embedding has ${input.embedding.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`);
    }
    const literal = toVectorLiteral(input.embedding);
    const res = await this.db.execute<{ session_id: string }>(sql`
      insert into cc_session_reply_embeddings
        (session_id, seq, embedding, sha, model, attempts, last_error, next_attempt_at, embedded_at, updated_at)
      select cc_session_replies.session_id, cc_session_replies.seq, ${literal}::vector, ${input.sha}, ${input.model},
             0, null, null, now(), now()
      from cc_session_replies
      where cc_session_replies.session_id = ${sessionId}
        and cc_session_replies.seq = ${seq}::integer
        and ${currentReplySha256Sql()} = ${input.sha}
      on conflict (session_id, seq) do update set
        embedding = excluded.embedding,
        sha = excluded.sha,
        model = excluded.model,
        attempts = 0,
        last_error = null,
        next_attempt_at = null,
        embedded_at = excluded.embedded_at,
        updated_at = excluded.updated_at
      returning session_id
    `);
    return res.rows.length > 0;
  }

  /**
   * Records a failed attempt for reply (`sessionId`, `seq`): embedding := null, attempts := previous
   * + 1 when the previous row was a failure for the same sha and model, else 1; next_attempt_at :=
   * now() + retryDelayMs(attempts); last_error := clampError(error). No-op when the reply no longer
   * hashes to `input.sha`, or when the row already holds a vector for this sha and model.
   */
  async recordReplyEmbeddingFailure(sessionId: string, seq: number, input: SessionEmbeddingFailure): Promise<void> {
    const prev = await this.db
      .select({
        sha: ccSessionReplyEmbeddings.sha,
        model: ccSessionReplyEmbeddings.model,
        attempts: ccSessionReplyEmbeddings.attempts,
        hasVector: sql<boolean>`${ccSessionReplyEmbeddings.embedding} is not null`,
      })
      .from(ccSessionReplyEmbeddings)
      .where(and(eq(ccSessionReplyEmbeddings.sessionId, sessionId), eq(ccSessionReplyEmbeddings.seq, seq)))
      .limit(1);
    const row = prev[0];
    const sameTarget = row !== undefined && row.sha === input.sha && row.model === input.model;
    if (sameTarget && row.hasVector) return;
    const attempts = sameTarget ? row.attempts + 1 : 1;
    const delayMs = retryDelayMs(attempts);
    await this.db.execute(sql`
      insert into cc_session_reply_embeddings
        (session_id, seq, embedding, sha, model, attempts, last_error, next_attempt_at, embedded_at, updated_at)
      select cc_session_replies.session_id, cc_session_replies.seq, null, ${input.sha}, ${input.model},
             ${attempts}::integer, ${clampError(input.error)},
             now() + ${delayMs}::integer * interval '1 millisecond', null, now()
      from cc_session_replies
      where cc_session_replies.session_id = ${sessionId}
        and cc_session_replies.seq = ${seq}::integer
        and ${currentReplySha256Sql()} = ${input.sha}
      on conflict (session_id, seq) do update set
        embedding = null,
        sha = excluded.sha,
        model = excluded.model,
        attempts = excluded.attempts,
        last_error = excluded.last_error,
        next_attempt_at = excluded.next_attempt_at,
        embedded_at = null,
        updated_at = excluded.updated_at
      where not (
        cc_session_reply_embeddings.embedding is not null
        and cc_session_reply_embeddings.sha = excluded.sha
        and cc_session_reply_embeddings.model = excluded.model
      )
    `);
  }
```
`and`, `eq`, `sql`, `EMBEDDING_DIMENSIONS`, `toVectorLiteral`, `clampError`, `retryDelayMs`, `SessionEmbeddingInput` and `SessionEmbeddingFailure` are already imported in `repo.ts` (`:2`, `:7-9`, `:50-51`).
**Impact:** This only adds methods. Existing behavior is unchanged.

### Step 5: Start and stop the reply worker with session ingest
**File:** `src/background.ts`
- `:1-16`: imports.
- `:29-40`: the doc comment of `startBackground`.
- `:85-101`: the session ingest block.
- `:137-151`: the stop function.

**Change:**
- The reply worker starts only inside the `sessions.enabled` branch, and only when `deps.embedder` is not null. It uses the ingest's own `SessionsRepo` and host.
- The worker is kicked from an `IngestObserver.onPassComplete` whenever a sweep wrote rows. It deliberately does not use `onBatch`, because an `onBatch` observer makes every read keep its parsed records (`ingest.ts:491`). The observer only kicks, so it can neither slow nor fail ingest.
- Watcher reads and phase 3's replies backfill are picked up by the worker's own 60 s sweep.
- On stop, the worker is closed in the parallel `Promise.all`, so its 5 s grace overlaps the others.
- Without a key the branch logs a line that does not contain the substring `embeddings off`. `tests/integration/embeddings.worker.int.test.ts:356` counts that substring, although that test runs with sessions off.

**Code: imports, replacing lines `:1-16`:**
```ts
import { hostname } from 'node:os';
import type { AppDeps } from './deps.js';
import { dbEmbeddingStore } from './embeddings/backfill.js';
import { dbImageEmbeddingStore } from './embeddings/imageBackfill.js';
import { startImageEmbeddingWorker } from './embeddings/imageWorker.js';
import { startEmbeddingWorker, type EmbeddingWorker } from './embeddings/worker.js';
import { imageDeps, ingestImage } from './images/ingest.js';
import { startInboxWatcher } from './images/inbox.js';
import { reconcileLegacyImages } from './images/legacy.js';
import { ensureDataDirs } from './images/store.js';
import { startSessionIngest, type SessionIngester } from './sessions/ingest.js';
import { dbLinkStore, startLinkWorker, type LinkWorker } from './sessions/links.js';
import { readLiveSessions } from './sessions/registry.js';
import { dbReplyEmbeddingStore, startReplyEmbeddingWorker } from './sessions/replyEmbeddings.js';
import { SessionsRepo } from './sessions/repo.js';
import type { Summarizer } from './sessions/summarize.js';
import { dbSummaryStore, startSummaryWorker, type SummaryWorker } from './sessions/summaryWorker.js';
```
**Code: doc comment, replacing `:29-40`:**
```ts
/**
 * Long-running work beside the HTTP server: the inbox watcher (iteration 2) and, when
 * OPENROUTER_API_KEY is set, the note embedding worker (iteration 6) and the image embedding
 * worker (image similarity search); with `config.sessions.enabled`, the Claude Code session
 * ingester (iteration 8: backfill, then tail `<claudeHome>/projects`), its parent linker, the
 * session summary worker (summaries only with `options.sessionSummarizer`) and, with an embedder,
 * the reply embedding worker (one vector per Claude reply of this host's sessions). With
 * `deps.adversary`, the Seer Adversarial reviewer's poll loop.
 * Creates images/, cache/, inbox/, inbox/failed/, chat-images/ under the data dir first (idempotent; the
 * daemon already made them, but tests call this without startDaemon). Then copies any legacy
 * image (notes.image_path/image_meta without a note_images row, e.g. ingested by an older daemon
 * after migration 0002 ran) into note_images, once, before the inbox can dedupe against it.
 */
```
**Code: session ingest block, replacing `:82-101`:**
```ts
  // Session ingest (iteration 8). The backfill runs in the background: startBackground does not
  // wait for it, and a failure is logged, never thrown. Later session work (phase 4 links, phase 6
  // summaries, reply embeddings) hangs off `sessionIngest` / `sessionsRepo` / `sessionsHost` here.
  let sessionIngest: SessionIngester | null = null;
  let sessionLinks: LinkWorker | null = null;
  let replyEmbeddings: EmbeddingWorker | null = null;
  if (!deps.config.sessions.enabled) {
    console.log('[notesd] session ingest off: NOTESD_SESSIONS=off');
  } else {
    const sessionsHost = hostname();
    const sessionsRepo = new SessionsRepo(deps.db, { dataDir: deps.config.dataDir, hostname: () => sessionsHost });
    sessionLinks = startLinkWorker({ store: dbLinkStore(deps.db, sessionsRepo), host: sessionsHost });
    sessionIngest = startSessionIngest({
      claudeHome: deps.config.sessions.claudeHome,
      worktreesDir: deps.config.sessions.worktreesDir,
      store: sessionsRepo,
      hostname: () => sessionsHost,
      observers: [sessionLinks],
    });
    console.log(`[notesd] ingesting Claude Code sessions from ${deps.config.sessions.claudeHome}/projects as ${sessionsHost}`);

    if (deps.embedder === null) {
      console.log('[notesd] session reply vectors off: OPENROUTER_API_KEY is not set, replies are searched by words only');
    } else {
      const worker = startReplyEmbeddingWorker({
        store: dbReplyEmbeddingStore(deps.db, sessionsRepo, sessionsHost),
        embedder: deps.embedder,
      });
      replyEmbeddings = worker;
      // Only a kick: never awaited, never blocks or fails a sweep. Watcher reads and the one-time
      // replies backfill are caught by the worker's own 60 s sweep.
      sessionIngest.addObserver({
        onPassComplete: (pass) => {
          if (pass.sessionIds.length > 0) worker.kick();
        },
      });
      console.log(`[notesd] embedding session replies with ${deps.embedder.model}`);
    }
  }
```
**Code: stop function, replacing `:137-151`:**
```ts
  return async () => {
    await inbox.close();
    // In parallel: each close is bounded by its grace (5 s), well under main.ts's 10 s exit.
    await Promise.all([
      embeddings?.close(),
      imageEmbeddings?.close(),
      // The linker closes after the ingester, once no more batches can arrive.
      (async () => {
        await sessionIngest?.close();
        await sessionLinks?.close();
      })(),
      replyEmbeddings?.close(),
      sessionSummaries?.close(),
      deps.adversary?.close(),
    ]);
  };
```
**Impact:** A daemon with a key and sessions on embeds its replies in the background. The first start after phase 3 costs about $0.02 for about 2.5k replies, in about 160 batches of 16 at 1 call/s, roughly 3 minutes. Without a key nothing new starts. With sessions off nothing changes.

### Step 6: Unit tests for the generalized worker
**File:** `tests/unit/embeddings/worker.test.ts`. Append inside `describe('startEmbeddingWorker', ...)`, after the last test (`:194`).
**Code:**
```ts
  it('runs without note events: drains at start and on kick', async () => {
    const store = new MemoryEmbeddingStore();
    store.setBody('R-1', 'first reply');
    const embedder = new ScriptedEmbedder();
    const w = startEmbeddingWorker({
      store,
      embedder,
      minIntervalMs: 0,
      debounceMs: 0,
      sweepMs: 3_600_000,
      log: () => {},
    });
    worker = w;
    await w.idle();
    expect(store.isCurrent('R-1', embedder.model)).toBe(true);

    store.setBody('R-2', 'second reply');
    w.kick();
    await w.idle();
    expect(store.isCurrent('R-2', embedder.model)).toBe(true);
    expect(embedder.calls).toHaveLength(2);
  });

  it('names itself in log lines with its label and item noun; defaults are unchanged', () => {
    const report = { notes: 2, calls: 3, embedded: 1, failed: 1, skipped: 0, fellBack: true, ms: 5, failures: [{ id: 'x#1', error: 'boom' }] };
    expect(formatBatch(report)).toBe('[notesd] embeddings: 1/2 embedded, 1 failed (x#1: boom), per-note fallback, 3 calls, 5ms');
    expect(formatBatch(report, 'reply embeddings', 'reply')).toBe(
      '[notesd] reply embeddings: 1/2 embedded, 1 failed (x#1: boom), per-reply fallback, 3 calls, 5ms',
    );
  });
```
And change the import at `:2`:
```ts
import { formatBatch, startEmbeddingWorker, type EmbeddingWorker } from '../../../src/embeddings/worker.js';
```
**Impact:** test only.

### Step 7: Unit tests for the reply worker
**File:** `tests/unit/sessions/replyEmbeddings.test.ts` (new)
**Change:** Test the observable worker behavior over the memory store: what gets embedded, the log prefix, that a store outage never throws, and the bounded close. The SQL store is covered by Step 8.
**Code:**
```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { EmbeddingWorker } from '../../../src/embeddings/worker.js';
import { REPLY_EMBEDDINGS_LABEL, startReplyEmbeddingWorker } from '../../../src/sessions/replyEmbeddings.js';
import { MemoryEmbeddingStore, ScriptedEmbedder } from '../../helpers/memoryEmbeddingStore.js';

let worker: EmbeddingWorker | null = null;

afterEach(async () => {
  await worker?.close();
  worker = null;
});

function start(store: MemoryEmbeddingStore, embedder: ScriptedEmbedder, closeGraceMs?: number): { logs: string[]; w: EmbeddingWorker } {
  const logs: string[] = [];
  const w = startReplyEmbeddingWorker({
    store,
    embedder,
    minIntervalMs: 0,
    debounceMs: 0,
    sweepMs: 3_600_000,
    ...(closeGraceMs === undefined ? {} : { closeGraceMs }),
    log: (line) => logs.push(line),
  });
  worker = w;
  return { logs, w };
}

describe('startReplyEmbeddingWorker', () => {
  it('embeds pending replies at start and logs under its own label', async () => {
    const store = new MemoryEmbeddingStore();
    store.setBody('s1#0', 'the adversary shows zero trades because the lease expired');
    store.setBody('s1#1', 'fixed by renewing the lease before the open');
    const embedder = new ScriptedEmbedder();
    const { logs, w } = start(store, embedder);
    await w.idle();
    expect(store.isCurrent('s1#0', embedder.model)).toBe(true);
    expect(store.isCurrent('s1#1', embedder.model)).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(new RegExp(`^\\[notesd\\] ${REPLY_EMBEDDINGS_LABEL}: 2/2 embedded, 1 call, \\d+ms$`));
  });

  it('a failing batch falls back per reply and says so', async () => {
    const store = new MemoryEmbeddingStore();
    store.setBody('s1#0', 'good reply');
    store.setBody('s1#1', 'bad reply');
    const embedder = new ScriptedEmbedder();
    embedder.failIf = (s) => s === 'bad reply';
    const { logs, w } = start(store, embedder);
    await w.idle();
    expect(store.isCurrent('s1#0', embedder.model)).toBe(true);
    expect(store.isCurrent('s1#1', embedder.model)).toBe(false);
    expect(store.rows.get('s1#1')?.attempts).toBe(1);
    expect(logs[0]).toContain('per-reply fallback');
    expect(logs[0]).toContain('1 failed (s1#1:');
  });

  it('a store outage is logged, never thrown', async () => {
    const store = new MemoryEmbeddingStore();
    store.failList = new Error('db down');
    const { logs, w } = start(store, new ScriptedEmbedder());
    await w.idle();
    expect(logs).toEqual([`[notesd] ${REPLY_EMBEDDINGS_LABEL}: drain failed: db down`]);
  });

  it('close gives up on an in-flight call after closeGraceMs', async () => {
    const store = new MemoryEmbeddingStore();
    store.setBody('s1#0', 'stuck');
    const embedder = new ScriptedEmbedder();
    embedder.gate = new Promise<void>(() => {}); // never answers
    let started!: () => void;
    const callStarted = new Promise<void>((r) => {
      started = r;
    });
    embedder.onCall = () => started();
    const { w } = start(store, embedder, 30);
    await callStarted;
    const t0 = Date.now();
    await w.close();
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(store.isCurrent('s1#0', embedder.model)).toBe(false);
  });
});
```
**Impact:** test only.

### Step 8: Integration tests against Postgres with the fake embedder
**File:** `tests/integration/sessions.replyEmbeddings.int.test.ts` (new)
**Change:** These tests prove the store, the repo writes, the phase-5 predicate and the daemon wiring on the real schema. Reply rows are seeded by SQL, standing in for phase 3's ingester, which `sessions.ingest.int.test.ts` / `sessions.prompts.int.test.ts` cover. The matching prompt row is seeded first, in case phase 3 references prompts from replies.
**Code:**
```ts
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startBackground } from '../../src/background.js';
import { ChatService } from '../../src/chat/service.js';
import { DEFAULT_ADVERSARY_CONFIG, DEFAULT_CHAT_CONFIG, DEFAULT_DWORD_CONFIG, type Config } from '../../src/config.js';
import type { Db } from '../../src/db/client.js';
import type { AppDeps } from '../../src/deps.js';
import type { Embedder } from '../../src/embeddings/embedder.js';
import { bodySha256 } from '../../src/embeddings/state.js';
import type { EmbeddingWorker } from '../../src/embeddings/worker.js';
import { NoteEvents } from '../../src/notes/events.js';
import { NotesService } from '../../src/notes/service.js';
import {
  currentReplySha256Sql,
  dbReplyEmbeddingStore,
  isCurrentReplyEmbeddingSql,
  startReplyEmbeddingWorker,
} from '../../src/sessions/replyEmbeddings.js';
import { SessionsRepo } from '../../src/sessions/repo.js';
import { createFakeEmbedder, type FakeEmbedder } from '../helpers/fakeEmbedder.js';
import { OTHER_HOST, THIS_HOST, seedSession } from './helpers/sessionsSeed.js';
import { closeTestDb, openTestDb, testDatabaseUrl, truncateAll } from './setup.js';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';

// A type alias, not an interface: db.execute<T> needs T assignable to Record<string, unknown>.
type ReplyEmbRow = {
  sha: string;
  model: string;
  has_vector: boolean;
  attempts: number;
  last_error: string | null;
  due: boolean;
  current: boolean;
};

let db: Db;
let dataDir: string;
let worker: EmbeddingWorker | null = null;

async function seedReply(sessionId: string, seq: number, text: string): Promise<void> {
  await db.execute(sql`
    insert into cc_session_prompts (session_id, seq, at, text, truncated)
    values (${sessionId}, ${seq}::integer, now(), ${`prompt ${seq}`}, false)
    on conflict do nothing`);
  await db.execute(sql`
    insert into cc_session_replies (session_id, seq, at, text, truncated)
    values (${sessionId}, ${seq}::integer, now(), ${text}, false)`);
}

async function setReplyText(sessionId: string, seq: number, text: string): Promise<void> {
  await db.execute(sql`update cc_session_replies set text = ${text} where session_id = ${sessionId} and seq = ${seq}::integer`);
}

async function embRow(sessionId: string, seq: number, model: string): Promise<ReplyEmbRow | null> {
  const res = await db.execute<ReplyEmbRow>(sql`
    select cc_session_reply_embeddings.sha, cc_session_reply_embeddings.model,
           cc_session_reply_embeddings.embedding is not null as has_vector,
           cc_session_reply_embeddings.attempts, cc_session_reply_embeddings.last_error,
           (cc_session_reply_embeddings.next_attempt_at is null or cc_session_reply_embeddings.next_attempt_at <= now()) as due,
           coalesce(${isCurrentReplyEmbeddingSql(model)}, false) as current
    from cc_session_reply_embeddings
    join cc_session_replies
      on cc_session_replies.session_id = cc_session_reply_embeddings.session_id
     and cc_session_replies.seq = cc_session_reply_embeddings.seq
    where cc_session_reply_embeddings.session_id = ${sessionId}
      and cc_session_reply_embeddings.seq = ${seq}::integer`);
  return res.rows[0] ?? null;
}

function rig(embedder: FakeEmbedder = createFakeEmbedder()): { embedder: FakeEmbedder; logs: string[]; w: EmbeddingWorker } {
  const logs: string[] = [];
  const w = startReplyEmbeddingWorker({
    store: dbReplyEmbeddingStore(db, new SessionsRepo(db), THIS_HOST),
    embedder,
    minIntervalMs: 0,
    debounceMs: 0,
    sweepMs: 3_600_000,
    log: (line) => logs.push(line),
  });
  worker = w;
  return { embedder, logs, w };
}

async function until(cond: () => Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  db = openTestDb();
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'mcp-notes-replyemb-'));
});

afterAll(async () => {
  await closeTestDb(db);
  await rm(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await truncateAll(db);
});

afterEach(async () => {
  await worker?.close();
  worker = null;
});

describe('reply embedding worker against Postgres', () => {
  it('embeds every non-blank reply of this host, keyed by sha256 of its text and the model', async () => {
    await seedSession(db, { sessionId: S1, nodeId: 'A0-3G', host: THIS_HOST, lastActiveAt: '2026-11-01T00:00:00Z' });
    await seedSession(db, { sessionId: S2, nodeId: 'B1-4H', host: OTHER_HOST, lastActiveAt: '2026-11-02T00:00:00Z' });
    await seedReply(S1, 0, 'the arango password lives in the vault');
    await seedReply(S1, 1, 'login broke after the laptop slept; resume fixed it');
    await seedReply(S1, 2, '   \n ');
    await seedReply(S2, 0, 'reply owned by the other machine');

    const { embedder, w } = rig();
    await w.idle();

    for (const [seq, text] of [
      [0, 'the arango password lives in the vault'],
      [1, 'login broke after the laptop slept; resume fixed it'],
    ] as const) {
      expect(await embRow(S1, seq, embedder.model)).toMatchObject({
        sha: bodySha256(text),
        model: embedder.model,
        has_vector: true,
        attempts: 0,
        last_error: null,
        current: true,
      });
    }
    expect(await embRow(S1, 2, embedder.model)).toBeNull();
    expect(await embRow(S2, 0, embedder.model)).toBeNull();
    expect(embedder.calls.flat().sort()).toEqual([
      'login broke after the laptop slept; resume fixed it',
      'the arango password lives in the vault',
    ]);

    // Nothing pending: another drain makes no call.
    const callsBefore = embedder.calls.length;
    w.kick();
    await w.idle();
    expect(embedder.calls.length).toBe(callsBefore);
  });

  it('an edited reply stops counting as current and is re-embedded under its new sha', async () => {
    await seedSession(db, { sessionId: S1, nodeId: 'A0-3G', host: THIS_HOST, lastActiveAt: '2026-11-01T00:00:00Z' });
    await seedReply(S1, 0, 'first answer');
    const { embedder, w } = rig();
    await w.idle();
    expect((await embRow(S1, 0, embedder.model))?.current).toBe(true);

    await setReplyText(S1, 0, 'first answer, extended in a later read');
    // The phase-5 predicate already ignores the stale vector before the worker catches up.
    expect((await embRow(S1, 0, embedder.model))?.current).toBe(false);

    w.kick();
    await w.idle();
    expect(await embRow(S1, 0, embedder.model)).toMatchObject({
      sha: bodySha256('first answer, extended in a later read'),
      current: true,
    });
  });

  it('a failing embedder never throws; the reply backs off and is retried once due', async () => {
    await seedSession(db, { sessionId: S1, nodeId: 'A0-3G', host: THIS_HOST, lastActiveAt: '2026-11-01T00:00:00Z' });
    await seedReply(S1, 0, 'the deploy failed on resume');
    const embedder = createFakeEmbedder();
    embedder.failWhen(() => true);
    const { logs, w } = rig(embedder);
    await w.idle();

    expect(await embRow(S1, 0, embedder.model)).toMatchObject({ has_vector: false, attempts: 1, due: false, current: false });
    expect((await embRow(S1, 0, embedder.model))?.last_error).not.toBeNull();
    expect(logs.some((l) => l.startsWith('[notesd] reply embeddings: 0/1 embedded, 1 failed'))).toBe(true);

    // Not due yet: a drain makes no new call.
    const callsAfterFailure = embedder.calls.length;
    w.kick();
    await w.idle();
    expect(embedder.calls.length).toBe(callsAfterFailure);

    embedder.failWhen(null);
    await db.execute(sql`update cc_session_reply_embeddings set next_attempt_at = now() - interval '1 second'`);
    w.kick();
    await w.idle();
    expect(await embRow(S1, 0, embedder.model)).toMatchObject({ has_vector: true, attempts: 0, last_error: null, current: true });
  });

  it('a second failure for the same text doubles the backoff counter', async () => {
    await seedSession(db, { sessionId: S1, nodeId: 'A0-3G', host: THIS_HOST });
    await seedReply(S1, 0, 'flaky reply');
    const repo = new SessionsRepo(db);
    const sha = bodySha256('flaky reply');
    await repo.recordReplyEmbeddingFailure(S1, 0, { sha, model: 'm', error: 'Bearer sk-or-abc123 timed out' });
    await repo.recordReplyEmbeddingFailure(S1, 0, { sha, model: 'm', error: 'timed out again' });
    const row = await embRow(S1, 0, 'm');
    expect(row).toMatchObject({ attempts: 2, has_vector: false });
    expect(row?.last_error).toBe('timed out again');

    await repo.recordReplyEmbeddingFailure(S1, 0, { sha, model: 'other-model', error: 'Bearer sk-or-abc123 boom' });
    const reset = await embRow(S1, 0, 'other-model');
    expect(reset?.attempts).toBe(1);
    expect(reset?.last_error).not.toContain('sk-or-abc123');
  });

  it('saveReplyEmbedding drops a vector made from text that has since changed, and a failure never clobbers a current vector', async () => {
    await seedSession(db, { sessionId: S1, nodeId: 'A0-3G', host: THIS_HOST });
    await seedReply(S1, 0, 'old text');
    const repo = new SessionsRepo(db);
    const fake = createFakeEmbedder();
    const oldSha = bodySha256('old text');

    await setReplyText(S1, 0, 'new text');
    expect(await repo.saveReplyEmbedding(S1, 0, { sha: oldSha, model: fake.model, embedding: fake.vectorFor('old text') })).toBe(false);
    await repo.recordReplyEmbeddingFailure(S1, 0, { sha: oldSha, model: fake.model, error: 'late failure' });
    expect(await embRow(S1, 0, fake.model)).toBeNull();

    const newSha = bodySha256('new text');
    expect(await repo.saveReplyEmbedding(S1, 0, { sha: newSha, model: fake.model, embedding: fake.vectorFor('new text') })).toBe(true);
    await repo.recordReplyEmbeddingFailure(S1, 0, { sha: newSha, model: fake.model, error: 'the other daemon failed' });
    expect(await embRow(S1, 0, fake.model)).toMatchObject({ has_vector: true, attempts: 0, current: true });
  });

  it('the SQL sha twin equals bodySha256 for non-ASCII text', async () => {
    await seedSession(db, { sessionId: S1, nodeId: 'A0-3G', host: THIS_HOST });
    const text = 'café — 日本語 🚀 [redacted]';
    await seedReply(S1, 0, text);
    const res = await db.execute<{ sha: string }>(sql`
      select ${currentReplySha256Sql()} as sha from cc_session_replies where cc_session_replies.session_id = ${S1}`);
    expect(res.rows[0]?.sha).toBe(bodySha256(text));
  });
});

describe('startBackground and the reply embedding worker', () => {
  function deps(embedder: Embedder | null, claudeHome: string): AppDeps {
    const events = new NoteEvents();
    const config: Config = {
      databaseUrl: testDatabaseUrl(),
      port: 0,
      host: '127.0.0.1',
      dataDir,
      chat: DEFAULT_CHAT_CONFIG,
      embeddings: { apiKey: null },
      sessions: { claudeHome, worktreesDir: claudeHome, enabled: true, swarmScript: null },
      adversary: DEFAULT_ADVERSARY_CONFIG,
      dword: DEFAULT_DWORD_CONFIG,
    };
    return {
      config,
      db,
      events,
      service: new NotesService({ db, dataDir, events }),
      embedder,
      imageEmbedder: null,
      chat: new ChatService({ db }),
      adversary: null,
    };
  }

  async function emptyClaudeHome(): Promise<string> {
    const home = await mkdtemp(path.join(os.tmpdir(), 'mcp-notes-replyemb-home-'));
    await mkdir(path.join(home, 'projects'), { recursive: true });
    return home;
  }

  it('embeds this host\'s replies when an embedder is configured and stops on shutdown', async () => {
    const home = await emptyClaudeHome();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await seedSession(db, { sessionId: S1, nodeId: 'A0-3G', host: os.hostname(), lastActiveAt: '2026-11-01T00:00:00Z' });
    await seedReply(S1, 0, 'reply embedded by the daemon path');
    const embedder = createFakeEmbedder();
    const stop = await startBackground(deps(embedder, home));
    try {
      await until(async () => (await embRow(S1, 0, embedder.model))?.current === true);
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines).toContain(`[notesd] embedding session replies with ${embedder.model}`);
    } finally {
      await stop();
      log.mockRestore();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('without an embedder it logs once and writes no reply vector', async () => {
    const home = await emptyClaudeHome();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await seedSession(db, { sessionId: S1, nodeId: 'A0-3G', host: os.hostname(), lastActiveAt: '2026-11-01T00:00:00Z' });
    await seedReply(S1, 0, 'no key, no vector');
    const stop = await startBackground(deps(null, home));
    try {
      await new Promise((r) => setTimeout(r, 300));
      const count = await db.execute<{ n: number }>(sql`select count(*)::int as n from cc_session_reply_embeddings`);
      expect(count.rows[0]?.n).toBe(0);
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines.filter((l) => l.includes('session reply vectors off'))).toHaveLength(1);
    } finally {
      await stop();
      log.mockRestore();
      await rm(home, { recursive: true, force: true });
    }
  });
});
```
Before writing, check these against the tree as it stands after phase 3:
- the `Config` / `AppDeps` field lists. Copy them from `tests/integration/embeddings.worker.int.test.ts:93-104` and `:321-332` if they have grown.
- the node-id format `seedSession` accepts (`A0-01` matches the session id pattern used in `tests/integration/sessions.search.int.test.ts`; use that file's style if it differs).
- `FakeEmbedder.vectorFor`, `failWhen` and `calls` (`tests/helpers/fakeEmbedder.ts:136-220`).

**Impact:** test only.

## Principles applied

- **Laziness protocol (reuse over new abstraction):** the plan does not write a second drain loop. It reuses `runBackfill` and `startEmbeddingWorker` through an `EmbeddingStore` adapter keyed `<session_id>#<seq>`. The only cost is two optional knobs (`events?`, `label` / `itemNoun`) on the generic worker. The reply-specific code is SQL plus about 10 lines of glue. The adapter reuses `Omit<SessionEmbeddingInput, 'textVersion'>` / `SessionEmbeddingFailure` and does not add reply-specific twins.
- **Make illegal states unrepresentable / one source of truth:** "current reply vector" is defined once, in `isCurrentReplyEmbeddingSql`. Phase 5 must import it rather than re-derive the sha expression. Saves and failures are conditional on the reply still hashing to the sha, so a vector can never be stored against text it was not made from.
- **Boundary discipline:** the only external input is the embedder's output, and it is validated where it enters storage (the dimension check in `saveReplyEmbedding`, plus `runBackfill`'s count check). The worker does not re-validate anywhere else.
- **Test behavior, not implementation:** the tests assert stored rows, the phase-5 predicate's verdict, embedder calls and log lines. They do not assert internal calls. The key-encoding helpers stay private and are exercised through the real store.
- **Prove it works:** the Proof section drives a throwaway daemon with `verify-notesd` (`--sessions`, and a short billed `--embed` run) and reads the rows back with `sql`, beyond the fake-embedder suites.

## Verification

**Build:** `npm run typecheck`

**Tests:**
- `npm test` (includes `tests/unit/embeddings/worker.test.ts` and `tests/unit/sessions/replyEmbeddings.test.ts`).
- `npm run test:int` (includes `tests/integration/sessions.replyEmbeddings.int.test.ts`; the existing `embeddings.worker.int.test.ts` must pass unchanged).
- Single files:
  - `npx vitest run tests/unit/sessions/replyEmbeddings.test.ts tests/unit/embeddings/worker.test.ts`
  - `npm run test:int -- tests/integration/sessions.replyEmbeddings.int.test.ts tests/integration/embeddings.worker.int.test.ts`

**Proof:** a real daemon on the fixture Claude home, with rows read back.

- **Harness:** `.claude/skills/verify-notesd` (`V=.claude/skills/verify-notesd/scripts/verify.sh`, run from the worktree root).
- **Feature-map entries:** `features/projects.md` (read only: phase 5 adds the reply-search lines). This phase changes no feature-map text.

**Journeys:**

**J1. The fake-embedder suites (the primary proof, free).**
- Run `npm run test:int -- tests/integration/sessions.replyEmbeddings.int.test.ts` and `npx vitest run tests/unit/sessions/replyEmbeddings.test.ts`.
- **Pass:** every test passes. In particular:
  - "embeds every non-blank reply of this host…" (current vectors and the host scope),
  - "an edited reply … re-embedded" (new sha),
  - "a failing embedder never throws; … retried once due" (backoff),
  - "close gives up … after closeGraceMs" (grace),
  - "embeds this host's replies when an embedder is configured" (daemon wiring).

**J2. No key: the daemon runs ingest, writes replies and starts no reply worker (free).**
1. `$V up --sessions` and note `RUN=` and `LOG=`.
2. `$V doctor RUN`.
3. Wait for ingest. Repeat `$V sql RUN "select count(*) as replies from cc_session_replies"` until it is above 0 (phase 3 fills it from `tests/fixtures/claude-home`).
4. `$V sql RUN "select count(*) as vectors from cc_session_reply_embeddings"`
5. `grep -c 'session reply vectors off' "$LOG"`
6. `$V note RUN "no key: replies stored, no reply vectors, worker off line logged"`.

**Pass:** the replies count is above 0, the vectors count is 0, and grep prints `1`. `$V api RUN GET /health` answers 200 (ingest not blocked).

**J3. With a key: every fixture reply of this host gets a current vector (billed, see Cost).**
1. `$V up --sessions --embed`.
2. Repeat this query until `pending` is `0` (at most about 90 s: one ingest pass plus at most one 60 s worker sweep):
   ```sh
   $V sql RUN "select count(*) filter (where e.session_id is null or e.embedding is null or e.sha <> encode(sha256(convert_to(r.text,'UTF8')),'hex')) as pending, count(*) as replies from cc_session_replies r join cc_sessions s using (session_id) left join cc_session_reply_embeddings e using (session_id, seq) where r.text ~ '[^[:space:]]'"
   ```
3. `$V sql RUN "select count(*) as current from cc_session_reply_embeddings e join cc_session_replies r using (session_id, seq) where e.embedding is not null and e.sha = encode(sha256(convert_to(r.text,'UTF8')),'hex') and e.model = 'openai/text-embedding-3-small' and e.attempts = 0"`
4. `grep -E '^\[notesd\] (embedding session replies with|reply embeddings: )' "$LOG"`
5. `$V note RUN "with key: all fixture replies have current vectors"`.

**Pass:** `pending = 0`, `current` equals `replies`, and the log shows the start line and at least one `reply embeddings: N/N embedded` line.

**J4. Re-embed on change (billed, same run as J3).**
1. `$V exec RUN "update cc_session_replies set text = text || ' (edited)' where (session_id, seq) = (select session_id, seq from cc_session_replies order by session_id, seq limit 1)"`
2. Repeat J3's pending query until it is `0` again (within about 70 s, one worker sweep).
3. Run J3's `current` query again.

**Pass:** `current` equals `replies` again, and the edited row's `sha` equals `encode(sha256(convert_to(text,'UTF8')),'hex')` of its new text. `$V down RUN` at the end, after J2 and after J3/J4.

**Neighbor check:** note embeddings and session ingest, the two things this phase touches the edges of.
- `npm run test:int -- tests/integration/embeddings.worker.int.test.ts tests/integration/sessions.ingest.int.test.ts` passes unchanged. The note worker's log lines and event-driven kicks are identical.
- In the J3 run, `$V mcp RUN create '{"body":"neighbor check arango vault"}'`, then `$V sql RUN "select count(*) from note_embeddings where embedding is not null"` reaches at least 1 within 10 s.

**Cost:** J3 and J4 use `--embed` (real OpenRouter embeddings, billed). The fixture Claude home holds a handful of replies (under 50k chars), which is well under $0.001. J1 and J2 are free. If the run budget says no billed drives, run J1, J2 and the neighbor check, and report J3/J4 as `inconclusive (billed, skipped)`.

**Exit criteria:**
- `npm run typecheck`, `npm test` and `npm run test:int` pass.
- In J1, and in J3 when billed drives are allowed, every non-blank reply of this host has a current vector (`isCurrentReplyEmbeddingSql`).
- An edited reply is re-embedded under its new sha.
- An embedder failure leaves `attempts >= 1`, a future `next_attempt_at` and a clamped `last_error`, and the reply is re-embedded once due.
- `close()` returns within its grace with a hung call.
- Without a key, nothing new starts and ingest is unaffected (J2).

## Handoffs

- **Phase 5 (R3, R4):**
  - Read reply vectors only through `isCurrentReplyEmbeddingSql(embedder.model)` from `src/sessions/replyEmbeddings.ts`.
  - Join `cc_session_replies` to `cc_session_reply_embeddings` on `(session_id, seq)`, with neither table aliased.
  - Inner-join the replies table so a vector whose reply is gone never counts.
  - Order by `cc_session_reply_embeddings.embedding <=> $query::vector`, using phase 3's HNSW index, with `set local hnsw.iterative_scan = strict_order` as `nearestNotes` does.
  - Documentation is also phase 5's:
    - CLAUDE.md sessions paragraph: "a background worker (`src/sessions/replyEmbeddings.ts`) embeds each reply of this host's sessions into `cc_session_reply_embeddings`, sha256-keyed, written through SessionsRepo; off without `OPENROUTER_API_KEY`".
    - README env/behavior.
    - `features/projects.md`.
- **Phase 3 (R2):**
  - `truncateAll` must list `cc_session_replies` and `cc_session_reply_embeddings`.
  - The `SessionsRepo` class doc comment and schema import (`repo.ts:6`, `:174-178`): reconciled, Step 4 quotes phase 3's version and extends it.
  - Export and column names checked against phase-3.md's contract (`ccSessionReplies`, `ccSessionReplyEmbeddings`, no `created_at`, FK `cc_session_reply_embeddings_reply_fk`): they match.
- **Not done here (no phase):** an `embed:backfill`-style CLI for replies, and reply-embedding stats in any status output. Neither was asked for. The worker's own sweep is the backfill.

## Rollback

Revert this phase's commit. This removes `src/sessions/replyEmbeddings.ts`, the two `SessionsRepo` methods, the background wiring, the worker option knobs and the tests. Phase 3's tables stay. Rows already written to `cc_session_reply_embeddings` are derived data. Leave them, or clear them with `truncate cc_session_reply_embeddings`; nothing reads them until phase 5 lands. Phase 5 depends on `isCurrentReplyEmbeddingSql`, so reverting this phase after phase 5 requires reverting phase 5 first.
