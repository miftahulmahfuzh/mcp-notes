> Adopted from `.workflows/plan/SESSION_CONTEXT_ROT_PLAN.md` phase 1. Source: `.workflows/plan/session-context-rot/phase-1.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 1: Context capture, window inference, backfill

**Plan set:** `SESSION_CONTEXT_ROT_PLAN.md`
**Analysis:** `.workflows/analyze/20261112-093143-CR7T_code_analyzer.md`
**Satisfies:** R1, R2 (the session's current context fill and the window it is measured against)
**Criteria:** R1.2, R1.3, R1.4, R1.5, R2.1, R2.2, R2.3, R2.4
**Depends on:** none
**Difficulty:** HARD
**Package:** `src/sessions` (+ `src/db`, `drizzle`)

---

## Goal

After this phase every `cc_sessions` row ingested on this host carries its context evidence: the
latest main-chain assistant message's occupancy (input + cache read + cache write + output), its
model and time, the peak, the first own message's occupancy, and whether a main-thread request
used a `context-1m-*` beta. Rows ingested before this phase are filled once per host by a
backfill. A pure module `src/sessions/contextWindow.ts` turns that evidence into a window
(`1_000_000` / `200_000` plus its source) and a colour band, for phases 2–4 to read. No route, view
or UI changes: phase 2 exposes the values.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- Migration `drizzle/0016_session_context.sql` (+ `drizzle/meta/0016_snapshot.json`, journal entry 16, tag `0016_session_context`): `cc_sessions.context_tokens bigint null`, `context_model text null`, `context_at timestamptz null`, `context_peak_tokens bigint null`, `context_first_tokens bigint null`, `context_long_beta boolean not null default false`.
- `ccSessions` columns in `src/db/schema.ts`: `contextTokens`, `contextModel`, `contextAt`, `contextPeakTokens`, `contextFirstTokens`, `contextLongBeta` (so `SessionRow` gains the six fields).
- `src/sessions/types.ts`: `ContextSnapshot { tokens, model, at }`, `ContextEvidence { latest, peakTokens, firstTokens, longBeta }`, `ContextFill` (= `ContextEvidence & { upToOffset }`), `FillContextResult`, `ContextBackfillRow`; `TranscriptPatch.context?: ContextEvidence`; `TranscriptSet` gains the six column names.
- `src/sessions/transcript.ts`: `contextTokensOf(usage)`, `isLongContextRequestLine(line)`, `TranscriptAccumulator.noteLongContextBeta()`, `TranscriptDelta.context: ContextEvidence`.
- `src/sessions/merge.ts`: `ContextColumns` type, `contextColumns(evidence)`, `mergeContext(row, evidence, reset)`, `sameContext(a, b)`.
- `src/sessions/repo.ts`: `SessionsRepo.contextBackfillRows(host)`, `SessionsRepo.fillContext(sessionId, host, fill)`.
- `src/sessions/ingest.ts`: `CONTEXT_BACKFILL_VERSION = 1`, `CONTEXT_MARKER_PREFIX = 'sessions.context_backfill.'`, `ContextBackfillReport`, `formatContextReport`, `SessionIngester.contextBackfill: Promise<ContextBackfillReport>`; `IngestStore` gains optional `contextBackfillRows` / `fillContext`.
- New `src/sessions/contextWindow.ts`: `STANDARD_CONTEXT_WINDOW = 200_000`, `LONG_CONTEXT_WINDOW = 1_000_000`, `LONG_CONTEXT_PEAK_THRESHOLD = 200_000`, `MODEL_CONTEXT_WINDOWS`, `tableWindowOf(model)`, `type ContextWindowSource = 'model' | 'peak' | 'beta' | 'default'`, `ContextWindow`, `ContextWindowInput`, `contextWindowFor({ model, peakTokens, longBeta })`, `type ContextBand = 'green' | 'amber' | 'red'`, `CONTEXT_BANDS = { amberFrom: 40, redFrom: 70 }`, `contextBand(percent)`, `contextPercent(tokens, window)` (one decimal).
- Test helper `MemorySettingsIngestStore` (`tests/helpers/memoryIngestStore.ts`).
**Signature changes:** none of an existing function (new optional field on `TranscriptPatch`; new required field `context` on `TranscriptDelta`, built only by `TranscriptAccumulator.delta()`).
**Requires (from earlier phases):** none.
**Leaves alone (owned by others):** `src/sessions/view.ts`, `src/sessions/readModel.ts`, `src/http/sessionsApi.ts`, `src/sessions/events.ts`, `src/deps.ts`, `src/daemon.ts`, `src/background.ts` (Phase 2); `src/sessions/handoff.ts`, `src/sessions/resume.ts`, `src/http/sessionResume.ts`, `src/mcp/sessionTools.ts`, `claude/hooks/notes-prompt.mjs` (Phase 3); `web/**`, `README.md`, `.claude/skills/verify-notesd/features/projects.md` (Phase 4).

## Files

| File | Action | What changes |
|---|---|---|
| `drizzle/0016_session_context.sql` | create | six `ALTER TABLE cc_sessions ADD COLUMN` statements (generated) |
| `drizzle/meta/0016_snapshot.json` | create | drizzle-kit snapshot (generated) |
| `drizzle/meta/_journal.json` | modify | entry idx 16 `0016_session_context` (generated) |
| `src/db/schema.ts` | modify | six columns on `ccSessions` after `forkDetectedBy` (L575) |
| `src/sessions/types.ts` | modify | context types, `TranscriptPatch.context`, `TranscriptSet` (L159-240, L375-409) |
| `src/sessions/transcript.ts` | modify | `contextTokensOf`, `isLongContextRequestLine`, accumulator capture, `delta().context`, `accumulateText`, `buildTranscriptPatch` |
| `src/sessions/merge.ts` | modify | `contextColumns`, `mergeContext`, `sameContext`; `mergeTranscriptPatch` returns the six columns |
| `src/sessions/repo.ts` | modify | imports; doc on `upsertFromTranscript`; `contextBackfillRows`, `fillContext` |
| `src/sessions/ingest.ts` | modify | raw-line beta detection in `readFile`; one-time context backfill; `contextBackfill` promise; header doc |
| `src/sessions/contextWindow.ts` | create | window inference, band, percent (pure) |
| `tests/helpers/memoryIngestStore.ts` | modify | six blank columns; `contextBackfillRows`, `fillContext`; `MemorySettingsIngestStore` |
| `tests/unit/sessions/merge.test.ts` | modify | six blank columns in `blankRow`; `mergeContext` tests |
| `tests/unit/sessions/transcript.test.ts` | modify | context capture and beta-line tests |
| `tests/unit/sessions/contextWindow.test.ts` | create | every R2 rule, bands, percent |
| `tests/unit/sessions/ingest.test.ts` | modify | context capture through the ingester; context backfill |
| `tests/unit/sessions/ingestForks.test.ts` | modify | fork context (copied snapshot); fork context backfill |
| `tests/integration/sessions.ingest.int.test.ts` | modify | stored context; context backfill against Postgres |
| `tests/integration/sessions.forks.int.test.ts` | modify | fork context against Postgres |
| `tests/integration/sessions.repo.int.test.ts` | modify | merge rules in SQL, `fillContext`, `contextBackfillRows` |
| `tests/integration/sessions.schema.int.test.ts` | modify | migration 0016 shape |

## Implementation Steps

### Step 0: Worktree prerequisites
**File:** — (shell, in `/home/miftah/.worktrees/mcp-notes/session-context-rot`)
**Change:** the worktree has no `node_modules`. Run `npm ci` once before anything else. No other
setup; no `.env.local` is needed for this phase (Step 2 passes a dummy URL to drizzle-kit, which
does not connect when generating).
**Code:**
```sh
cd /home/miftah/.worktrees/mcp-notes/session-context-rot
[ -d node_modules ] || npm ci
```
**Impact:** none on the tree.

### Step 1: Schema columns
**File:** `src/db/schema.ts:575` (right after `forkDetectedBy: text('fork_detected_by').$type<ForkDetectedBy>(),`, before the `prompts` jsonb column's doc comment). `boolean` is already imported (L6).
**Change:** add six columns to `ccSessions`.
**Code:**
```ts
    /**
     * Context occupancy (migration 0016): input + cache read + cache write + output tokens of the
     * latest main-chain assistant message with usage, its `message.model` and its record time.
     * Sidechain records and subagent transcripts never feed these; a fork's copied records do,
     * until the fork's own first message replaces them. Null: no such message yet (readers show
     * "unknown", never 0%). The window is never stored: src/sessions/contextWindow.ts infers it at
     * read time from `context_model`, `context_peak_tokens` and `context_long_beta`.
     */
    contextTokens: bigint('context_tokens', { mode: 'number' }),
    contextModel: text('context_model'),
    contextAt: timestamp('context_at', { withTimezone: true, mode: 'date' }),
    /** Largest context any main-chain assistant message of the session reported (a fork's copied ones included). */
    contextPeakTokens: bigint('context_peak_tokens', { mode: 'number' }),
    /** Context of the session's first own main-chain assistant message: its start-up cost (system prompt, tools, CLAUDE.md, memory). */
    contextFirstTokens: bigint('context_first_tokens', { mode: 'number' }),
    /** A main-thread `api-request` record of the session listed a `context-1m-*` beta: it ran on the 1M window. */
    contextLongBeta: boolean('context_long_beta').notNull().default(false),
```
**Impact:** `SessionRow` (= `Omit<CcSessionRow,'searchTsv'>`) gains six required fields, so every full `SessionRow` literal must list them (Steps 9 and 10 fix the two in tests). `SESSION_COLUMNS` in `repo.ts` picks them up through `getTableColumns`, so every repo read returns them. `LIST_COLUMNS` / `SessionListItem` are unchanged.

### Step 2: Generate migration 0016
**File:** `drizzle/0016_session_context.sql` (new), `drizzle/meta/0016_snapshot.json` (new), `drizzle/meta/_journal.json` (append entry 16)
**Change:** generate with drizzle-kit. `drizzle.config.ts` throws without a direct (non-pooler) URL, but `generate` only diffs snapshots, so a dummy URL is enough.
**Code:**
```sh
cd /home/miftah/.worktrees/mcp-notes/session-context-rot
DATABASE_URL_UNPOOLED=postgres://gen:gen@127.0.0.1:1/gen npx drizzle-kit generate --name session_context
cat drizzle/0016_session_context.sql
```
Expected `drizzle/0016_session_context.sql` (drizzle-kit may order the statements differently; the content must be these six and nothing else, so fail the step if any other table or column appears):
```sql
ALTER TABLE "cc_sessions" ADD COLUMN "context_tokens" bigint;--> statement-breakpoint
ALTER TABLE "cc_sessions" ADD COLUMN "context_model" text;--> statement-breakpoint
ALTER TABLE "cc_sessions" ADD COLUMN "context_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cc_sessions" ADD COLUMN "context_peak_tokens" bigint;--> statement-breakpoint
ALTER TABLE "cc_sessions" ADD COLUMN "context_first_tokens" bigint;--> statement-breakpoint
ALTER TABLE "cc_sessions" ADD COLUMN "context_long_beta" boolean DEFAULT false NOT NULL;
```
Fallback only if drizzle-kit cannot run: write the SQL above by hand; copy `drizzle/meta/0015_snapshot.json` to `0016_snapshot.json`, set `"prevId": "29c1c66e-fce7-4596-8d94-208409e82bbb"` and a fresh `"id"` (`uuidgen`), and insert into `tables["public.cc_sessions"].columns` after `fork_detected_by`:
```json
"context_tokens": { "name": "context_tokens", "type": "bigint", "primaryKey": false, "notNull": false },
"context_model": { "name": "context_model", "type": "text", "primaryKey": false, "notNull": false },
"context_at": { "name": "context_at", "type": "timestamp with time zone", "primaryKey": false, "notNull": false },
"context_peak_tokens": { "name": "context_peak_tokens", "type": "bigint", "primaryKey": false, "notNull": false },
"context_first_tokens": { "name": "context_first_tokens", "type": "bigint", "primaryKey": false, "notNull": false },
"context_long_beta": { "name": "context_long_beta", "type": "boolean", "primaryKey": false, "notNull": true, "default": false },
```
and append to `_journal.json` `entries`:
```json
{ "idx": 16, "version": "7", "when": <Date.now()>, "tag": "0016_session_context", "breakpoints": true }
```
Then re-run `DATABASE_URL_UNPOOLED=postgres://gen:gen@127.0.0.1:1/gen npx drizzle-kit generate --name check` and confirm it reports no changes (delete anything it writes).
**Impact:** additive; nullable / defaulted columns, no backfill in SQL (the data backfill is Step 8).

### Step 3: Context types
**File:** `src/sessions/types.ts`
**Change:** (a) after `TokenCounts` (L159-164) add the context types; (b) in `TranscriptPatch` (L172-239) add `context` after `costUsd` (L201); (c) add the six columns to `TranscriptSet` (L376-409) after `'forkDetectedBy'`; (d) after `HeadUuidFill` (L348-351) add the backfill row and fill types.
**Code:**

(a) after the `TokenCounts` interface:
```ts
/**
 * The context of one main-chain assistant message (R1.2): what the next request starts from.
 * `tokens` = input + cache read + cache write + output tokens of its `message.usage`
 * (transcript.ts contextTokensOf).
 */
export interface ContextSnapshot {
  tokens: number;
  /** Its `message.model`; null when the record carried none. Never `<synthetic>`. */
  model: string | null;
  /** The record's timestamp; null when it had none or it did not parse. */
  at: Date | null;
}

/**
 * What a read of a session transcript learned about its context (migration 0016 columns). Main
 * chain only: sidechain records and subagent transcripts never feed it.
 */
export interface ContextEvidence {
  /** The read's latest main-chain assistant message with usage (a fork's copied ones included); null when the read had none. */
  latest: ContextSnapshot | null;
  /** The largest `tokens` of the read (a fork's copied messages included); null when the read had none. */
  peakTokens: number | null;
  /** `tokens` of the read's first own main-chain assistant message (never a copied one); null when it had none. */
  firstTokens: number | null;
  /** A main-thread `api-request` line of the read listed a `context-1m-*` beta (transcript.ts isLongContextRequestLine). */
  longBeta: boolean;
}
```

(b) in `TranscriptPatch`, after `costUsd?: number | null;`:
```ts
  /**
   * Context evidence of the read (transcript.ts). fromOffset 0 replaces the six context columns
   * with it (undefined clears them). An append: a non-null `latest` replaces the snapshot (tokens,
   * model, at), so a smaller context after a compaction wins, and a null one keeps it; the peak is
   * the max; the first message's context is kept once set; the long-context flag is ORed.
   * Undefined on an append keeps all six (merge.ts mergeContext).
   */
  context?: ContextEvidence;
```

(c) `TranscriptSet` becomes:
```ts
/** Columns a transcript patch writes. */
export type TranscriptSet = Pick<
  SessionRow,
  | 'repo'
  | 'cwd'
  | 'branch'
  | 'name'
  | 'customTitle'
  | 'aiTitle'
  | 'firstPrompt'
  | 'lastPrompt'
  | 'entrypoint'
  | 'version'
  | 'finalMessage'
  | 'startedAt'
  | 'lastActiveAt'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadTokens'
  | 'cacheWriteTokens'
  | 'costUsd'
  | 'models'
  | 'prompts'
  | 'commits'
  | 'filesEdited'
  | 'planDocs'
  | 'transcriptPath'
  | 'transcriptOffset'
  | 'transcriptSize'
  | 'headUuid'
  | 'forkCutOffset'
  | 'forkedAt'
  | 'forkPromptCount'
  | 'forkDetectedBy'
  | 'contextTokens'
  | 'contextModel'
  | 'contextAt'
  | 'contextPeakTokens'
  | 'contextFirstTokens'
  | 'contextLongBeta'
>;
```

(d) after `HeadUuidFill`:
```ts
/** One row of this host as the one-time context backfill sees it (`SessionsRepo.contextBackfillRows`). */
export interface ContextBackfillRow {
  sessionId: string;
  transcriptPath: string;
  transcriptOffset: number;
  /** cc_sessions.fork_cut_offset: records with a uuid before it are the parent's copy (isCopiedRecord). Null: not a fork. */
  forkCutOffset: number | null;
}

/**
 * The context of a transcript re-read from byte 0 to `upToOffset` (the row's stored offset),
 * written whole by `SessionsRepo.fillContext`.
 */
export interface ContextFill extends ContextEvidence {
  /** Must equal the stored transcript_offset when the write happens (compare-and-set). */
  upToOffset: number;
}

export type FillContextResult =
  | { status: 'applied' }
  | { status: 'offset_mismatch'; storedOffset: number }
  | { status: 'other_host' }
  | { status: 'missing' };
```
**Impact:** type-only; `npm run typecheck` fails until Steps 4–5 fill `TranscriptDelta.context` and the merge returns the new `TranscriptSet` columns. Do Steps 3–5 together, then typecheck.

### Step 4: Capture in the accumulator
**File:** `src/sessions/transcript.ts`
**Change:** seven edits, listed with the line each lands on.

(4a) imports, L2-18: add `type ContextEvidence` and `type ContextSnapshot` to the `./types.js` import:
```ts
import {
  MAX_COMMITS,
  MAX_FILES_EDITED,
  MAX_FINAL_MESSAGE_CHARS,
  MAX_IMAGES_PER_PROMPT,
  MAX_PLAN_DOCS,
  MAX_PROMPT_STORE_CHARS,
  MAX_TITLE_CHARS,
  type ContextEvidence,
  type ContextSnapshot,
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

(4b) after `const LEADING_TYPE = /^\{"type":"([^"]{1,64})"/;` (L89) add:
```ts
/** An `api-request` line (not `-blob` / `-shape`): the request Claude Code sent, with `params.betas`. */
const API_REQUEST_LINE = /^\s*\{"type":"api-request",/;
/** `querySource` of the session's own turns (`repl_main_thread`, `repl_main_thread:outputStyle:<name>`); subagent requests are `agent:*`. */
const MAIN_THREAD_SOURCE = /"querySource":"repl_main_thread[":]/;
/**
 * A `context-1m-*` entry inside the `betas` array. `"betas":[` with an unescaped quote can only be
 * a JSON key (quotes inside strings are escaped), so text in the request's messages never matches.
 */
const LONG_CONTEXT_BETA = /"betas":\[[^\]]*"context-1m-/;
```

(4c) in `TranscriptDelta` (L124-170), after `leadingReply: LeadingReply | null;` (L169) add:
```ts
  /** Context evidence of this read (main chain only). All empty for a sidechain accumulator. */
  context: ContextEvidence;
```

(4d) after `addInto` (ends L227) add:
```ts
/**
 * The context one assistant message reports (R1.2): input + cache read + cache write + output
 * tokens of its `message.usage`, the size the next request starts from (the reply is part of the
 * next turn's input). 0 for a missing or malformed usage object; a counter that is not a positive
 * finite number counts 0. This is the one place usage is validated for context.
 */
export function contextTokensOf(usage: unknown): number {
  if (!isObject(usage)) return 0;
  return count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.output_tokens);
}
```
and after `parseRecord` (ends L241) add:
```ts
/**
 * True for a raw transcript line that is a main-thread `api-request` record listing a
 * `context-1m-*` beta (R2.3 evidence). It reads the raw text: these lines (up to ~17 KB) stay
 * unparsed, since parseRecord drops `api-request` before JSON.parse. Every other line costs one
 * anchored prefix test. `api-request` records carry no uuid, so a fork's copies of them count as
 * its own, the isCopiedRecord rule for uuid-less records.
 */
export function isLongContextRequestLine(line: string): boolean {
  return API_REQUEST_LINE.test(line) && line.includes('"context-1m-') && MAIN_THREAD_SOURCE.test(line) && LONG_CONTEXT_BETA.test(line);
}
```

(4e) in `class TranscriptAccumulator`: after `private readonly sidechain: boolean;` (L503) add the fields; after `carry()` (ends L522) add `noteLongContextBeta`; replace `addCopied` (L557-573) whole; in `delta()` (L575-608) add `context` to the returned object.
```ts
  /** Context evidence of this read (ContextEvidence). Never set by a sidechain accumulator. */
  private contextLatest: ContextSnapshot | null = null;
  private contextPeak: number | null = null;
  private contextFirst: number | null = null;
  private longBeta = false;
```
```ts
  /**
   * The read met a main-thread `api-request` line listing a `context-1m-*` beta
   * (isLongContextRequestLine; callers test the raw line, since parseRecord drops it). A sidechain
   * accumulator ignores it.
   */
  noteLongContextBeta(): void {
    if (!this.sidechain) this.longBeta = true;
  }
```
```ts
  /**
   * A record a fork copied from its parent (`isCopiedRecord`). It fills only what identifies the
   * session itself: the launch cwd and entry point (first seen), and branch and version (the
   * fork's own records come after the copy and overwrite them), plus the context snapshot and
   * peak: the copied history really is in the fork's context until its own first message reports
   * anew (R1.4). It never sets the first-message context. Tokens, models, prompts, replies,
   * commits, files, plan docs, the final message and the time range ignore it.
   */
  addCopied(record: TranscriptRecord): void {
    if (record.isSidechain === true && !this.sidechain) return;
    const cwd = nonEmpty(record.cwd);
    if (cwd !== null && this.cwd === null) this.cwd = cwd;
    const entrypoint = nonEmpty(record.entrypoint);
    if (entrypoint !== null && this.entrypoint === null) this.entrypoint = entrypoint;
    const branch = nonEmpty(record.gitBranch);
    if (branch !== null) this.branch = branch;
    const version = nonEmpty(record.version);
    if (version !== null) this.version = version;
    if (record.type === 'assistant') this.observeContext(record, true);
  }
```
`delta()` becomes (only the `context` line is new, last in the object):
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
      context: {
        latest: this.contextLatest === null ? null : { ...this.contextLatest },
        peakTokens: this.contextPeak,
        firstTokens: this.contextFirst,
        longBeta: this.longBeta,
      },
    };
  }
```

(4f) `addAssistant` (L733-764): call `observeContext` right after the `isObject(message)` guard; add the new private method right after `addAssistant`.
```ts
  private addAssistant(record: TranscriptRecord): void {
    const message = record.message;
    if (!isObject(message)) return;
    this.observeContext(record, false);
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

  /**
   * Folds one main-chain assistant record into the context evidence (R1.2): the latest message
   * with usage wins, so a compaction's smaller context replaces a larger one (R1.3); the peak is
   * the largest seen; the first own message's context is kept. A message whose usage sums to 0, or
   * a `<synthetic>` one (Claude Code's local error and interrupt stand-ins), says nothing about the
   * context and is skipped. Every record of one message repeats its usage, so seeing it twice
   * changes nothing. A main accumulator never gets here for a sidechain record (`add` and
   * `addCopied` return first); a sidechain accumulator ignores every record.
   */
  private observeContext(record: TranscriptRecord, copied: boolean): void {
    if (this.sidechain) return;
    const message = record.message;
    if (!isObject(message)) return;
    const model = nonEmpty(message.model);
    if (model === '<synthetic>') return;
    const tokens = contextTokensOf(message.usage);
    if (tokens === 0) return;
    const ms = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN;
    this.contextLatest = { tokens, model, at: Number.isFinite(ms) ? new Date(ms) : null };
    if (this.contextPeak === null || tokens > this.contextPeak) this.contextPeak = tokens;
    if (!copied && this.contextFirst === null) this.contextFirst = tokens;
  }
```

(4g) `accumulateText` (L784-792) and `buildTranscriptPatch` (L801-833):
```ts
/** Folds every complete record of `text` (a whole transcript, or one read of it). For tests and tools. */
export function accumulateText(sessionId: string, text: string, carry?: TranscriptCarry): TranscriptAccumulator {
  const acc = new TranscriptAccumulator(sessionId, carry);
  for (const line of text.split('\n')) {
    if (isLongContextRequestLine(line)) acc.noteLongContextBeta();
    const record = parseRecord(line);
    if (record !== null) acc.add(record);
  }
  return acc;
}
```
```ts
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
    context: delta.context,
    prompts: delta.prompts,
    replies: delta.replies,
    leadingReply: fromStart ? null : delta.leadingReply,
    commits: delta.commits,
    filesEdited: delta.filesEdited,
    planDocs: delta.planDocs,
  };
}
```
Also add one bullet to the module doc comment's "Shapes this relies on" list (after the `api-request*` bullet, L45-46):
```ts
 * - Context (migration 0016): a main-chain assistant message's `message.usage` input + cache read
 *   + cache write + output is the context the next turn starts from; the latest one is the
 *   session's context, so a compaction lowers it with no record-type dependence (no
 *   `compact_boundary` record exists in measured transcripts). `message.model` never carries a
 *   `[1m]` suffix; the 1M beta shows only in main-thread `api-request` lines (`querySource:
 *   repl_main_thread*`, `params.betas`), read raw by isLongContextRequestLine.
```
**Impact:** every main-file read now produces `delta.context`; the subagent reader's `{ sidechain: true }` accumulator always produces the empty evidence. Cumulative tokens, models and every other delta field are unchanged.

### Step 5: Merge rules
**File:** `src/sessions/merge.ts`
**Change:** (a) import `ContextEvidence`; (b) add the context helpers before `mergeTranscriptPatch` (L286); (c) `mergeTranscriptPatch` (L297-355) returns `...mergeContext(row, patch.context, reset)`.

(a) the `./types.js` import (L3-25) gains `type ContextEvidence,` (alphabetical, after `MAX_TITLE_CHARS,`).

(b) insert before the `mergeTranscriptPatch` doc comment:
```ts
/** The six `cc_sessions` context columns (migration 0016). */
export type ContextColumns = Pick<
  SessionRow,
  'contextTokens' | 'contextModel' | 'contextAt' | 'contextPeakTokens' | 'contextFirstTokens' | 'contextLongBeta'
>;

/**
 * The context columns exactly as `evidence` describes them; undefined clears them. For a read that
 * covers the whole transcript: a read from byte 0, or the context backfill (`SessionsRepo.fillContext`).
 */
export function contextColumns(evidence: ContextEvidence | undefined): ContextColumns {
  const latest = evidence?.latest ?? null;
  return {
    contextTokens: latest?.tokens ?? null,
    contextModel: latest?.model ?? null,
    contextAt: latest?.at ?? null,
    contextPeakTokens: evidence?.peakTokens ?? null,
    contextFirstTokens: evidence?.firstTokens ?? null,
    contextLongBeta: evidence?.longBeta === true,
  };
}

/**
 * The context columns after one read (TranscriptPatch.context). `reset` (a read from byte 0)
 * replaces them. An append: a non-null `latest` replaces the snapshot, so the later, smaller
 * context after a compaction is stored (R1.3), and a read with no assistant message keeps it; the
 * peak is the max; the first message's context is kept once set; the long-context flag is ORed.
 * Undefined evidence on an append keeps every column. A row ingested before migration 0016 that
 * gets an append before the context backfill reaches it takes that append's first message as its
 * first-message context; the backfill then rewrites all six from the whole transcript.
 */
export function mergeContext(row: ContextColumns, evidence: ContextEvidence | undefined, reset: boolean): ContextColumns {
  if (reset) return contextColumns(evidence);
  const kept: ContextColumns = {
    contextTokens: row.contextTokens,
    contextModel: row.contextModel,
    contextAt: row.contextAt,
    contextPeakTokens: row.contextPeakTokens,
    contextFirstTokens: row.contextFirstTokens,
    contextLongBeta: row.contextLongBeta,
  };
  if (evidence === undefined) return kept;
  const latest = evidence.latest;
  const peak = evidence.peakTokens;
  return {
    contextTokens: latest === null ? kept.contextTokens : latest.tokens,
    contextModel: latest === null ? kept.contextModel : latest.model,
    contextAt: latest === null ? kept.contextAt : latest.at,
    contextPeakTokens: peak === null ? kept.contextPeakTokens : Math.max(kept.contextPeakTokens ?? 0, peak),
    contextFirstTokens: kept.contextFirstTokens ?? evidence.firstTokens,
    contextLongBeta: kept.contextLongBeta || evidence.longBeta,
  };
}

/** True when two sets of context columns hold the same values. */
export function sameContext(a: ContextColumns, b: ContextColumns): boolean {
  return (
    a.contextTokens === b.contextTokens &&
    a.contextModel === b.contextModel &&
    (a.contextAt?.getTime() ?? null) === (b.contextAt?.getTime() ?? null) &&
    a.contextPeakTokens === b.contextPeakTokens &&
    a.contextFirstTokens === b.contextFirstTokens &&
    a.contextLongBeta === b.contextLongBeta
  );
}
```

(c) in `mergeTranscriptPatch`, add one line at the end of the returned object, after `forkDetectedBy: fork === null ? row.forkDetectedBy : fork.detectedBy,`:
```ts
    ...mergeContext(row, patch.context, reset),
```
and append to its doc comment (L286-296):
```ts
 * Context (migration 0016): see mergeContext; a fork's 0-read replaces the context like every
 * other 0-read, with the copied snapshot the read took (transcript.ts addCopied).
```
**Impact:** `SessionsRepo.upsertFromTranscript` (`.set({ ...set, ... })`, repo.ts L489-494) now writes the six columns with no further change; `MemoryIngestStore.upsertFromTranscript` spreads the same result.

### Step 6: Window inference module
**File:** `src/sessions/contextWindow.ts` (new)
**Change:** pure module, no imports.
**Code:**
```ts
/**
 * Context window inference for a Claude Code session, and the colour band of its fill. Pure: no
 * I/O, no clock.
 *
 * The window is never stored (plan invariant 9). Readers derive it from the evidence ingest keeps
 * on `cc_sessions` (`context_model`, `context_peak_tokens`, `context_long_beta`, migration 0016),
 * so a rule change here needs no migration. First match wins:
 *   1. the model's table entry is 1M                                   -> 1M,   source `model`
 *   2. the session's context has ever exceeded 200,000 tokens (R2.2)   -> 1M,   source `peak`
 *   3. a main-thread request listed a `context-1m-*` beta, or the model
 *      id carries Claude Code's `[1m]` suffix (R2.3)                   -> 1M,   source `beta`
 *   4. the model's table entry (200K)                                  -> 200K, source `model`
 *   5. an unknown or missing model (R2.4)                              -> 200K, source `default`
 *
 * Windows from the claude-api skill (cached 2026-10-06). Claude Code sends the 1M beta for the 4.6
 * models only when the user picks their 1M variant, so they are 200K here unless evidence says
 * otherwise; the 5.x models, Opus 4.7 / 4.8 and Haiku 5.5 run 1M natively (measured 2026-11-12:
 * their sessions pass 200K with no beta). There is no user setting (R2.1).
 */

export const STANDARD_CONTEXT_WINDOW = 200_000;
export const LONG_CONTEXT_WINDOW = 1_000_000;
/** A context above this many tokens cannot fit a standard window: the session runs on 1M. */
export const LONG_CONTEXT_PEAK_THRESHOLD = STANDARD_CONTEXT_WINDOW;

/** Model id prefix -> window. Longest matching prefix wins (`claude-opus-5-5` matches `claude-opus-5`). */
export const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  'claude-fable-5': LONG_CONTEXT_WINDOW,
  'claude-mythos-5': LONG_CONTEXT_WINDOW,
  'claude-opus-5': LONG_CONTEXT_WINDOW,
  'claude-opus-4-8': LONG_CONTEXT_WINDOW,
  'claude-opus-4-7': LONG_CONTEXT_WINDOW,
  'claude-opus-4-6': STANDARD_CONTEXT_WINDOW,
  'claude-sonnet-5': LONG_CONTEXT_WINDOW,
  'claude-sonnet-4-6': STANDARD_CONTEXT_WINDOW,
  'claude-haiku-5-5': LONG_CONTEXT_WINDOW,
  'claude-haiku-4-5': STANDARD_CONTEXT_WINDOW,
};

const PREFIXES = Object.keys(MODEL_CONTEXT_WINDOWS).sort((a, b) => b.length - a.length);
/** Claude Code's model-picker suffix for the 1M variant (`claude-opus-4-6[1m]`). */
const ONE_M_SUFFIX = /\[1m\]$/i;

export type ContextWindowSource = 'model' | 'peak' | 'beta' | 'default';

export interface ContextWindow {
  window: number;
  source: ContextWindowSource;
}

/** The stored evidence: `context_model`, `context_peak_tokens`, `context_long_beta`. */
export interface ContextWindowInput {
  model: string | null;
  peakTokens: number | null;
  longBeta: boolean;
}

/** The table window of a model id (`claude-haiku-4-5-20251001`, `claude-opus-4-6[1m]`), or null when no prefix matches. */
export function tableWindowOf(model: string): number | null {
  const id = model.toLowerCase();
  for (const prefix of PREFIXES) {
    if (id === prefix || id.startsWith(`${prefix}-`) || id.startsWith(`${prefix}[`)) return MODEL_CONTEXT_WINDOWS[prefix] ?? null;
  }
  return null;
}

/** The session's context window and why (see the module comment for the rule order). */
export function contextWindowFor(input: ContextWindowInput): ContextWindow {
  const trimmed = input.model?.trim() ?? '';
  const model = trimmed === '' ? null : trimmed;
  const table = model === null ? null : tableWindowOf(model);
  if (table === LONG_CONTEXT_WINDOW) return { window: LONG_CONTEXT_WINDOW, source: 'model' };
  if (input.peakTokens !== null && input.peakTokens > LONG_CONTEXT_PEAK_THRESHOLD) return { window: LONG_CONTEXT_WINDOW, source: 'peak' };
  if (input.longBeta || (model !== null && ONE_M_SUFFIX.test(model))) return { window: LONG_CONTEXT_WINDOW, source: 'beta' };
  if (table !== null) return { window: table, source: 'model' };
  return { window: STANDARD_CONTEXT_WINDOW, source: 'default' };
}

export type ContextBand = 'green' | 'amber' | 'red';

/** Band thresholds in percent of the window: green below `amberFrom`, amber from it to below `redFrom`, red from `redFrom` (R1.6). */
export const CONTEXT_BANDS = { amberFrom: 40, redFrom: 70 } as const;

/** The band of a fill percent. Pass the same percent that is shown (contextPercent), so the colour and the number agree. */
export function contextBand(percent: number): ContextBand {
  if (percent >= CONTEXT_BANDS.redFrom) return 'red';
  if (percent >= CONTEXT_BANDS.amberFrom) return 'amber';
  return 'green';
}

/** `tokens` as a percent of `window`, one decimal (32,021 of 1M -> 3.2). 0 for a non-positive window or negative tokens. */
export function contextPercent(tokens: number, window: number): number {
  if (!(window > 0) || !(tokens >= 0)) return 0;
  return Math.round((tokens / window) * 1000) / 10;
}
```
**Impact:** new module; phases 2 and 3 import it.

### Step 7: Repo methods
**File:** `src/sessions/repo.ts`
**Change:** (a) imports L13-30: add `contextColumns` and `sameContext` to the `./merge.js` import; add `type ContextBackfillRow`, `type ContextFill`, `type FillContextResult` to the `./types.js` import (L31-80). (b) Append to the `upsertFromTranscript` doc comment (L441-460) the paragraph below. (c) Insert the new section after `fillHeadUuids` (ends ~L695), before `/** What the session's subagent transcripts add up to ... */ private async subagentTotals`.

(b) doc paragraph to add at the end of the `upsertFromTranscript` comment:
```ts
   *
   * The read's context evidence (`patch.context`) goes to the six context columns through
   * mergeTranscriptPatch (merge.ts mergeContext): replaced on fromOffset 0, merged on an append.
   * Subagent writes (upsertFromSubagentTranscript) never touch them.
```
(c) new section:
```ts
  // ---------- one-time context backfill ----------

  /**
   * Every row of `host` with a transcript path, most recently active first: what the one-time
   * context backfill re-reads (rows ingested before migration 0016 have no context columns).
   */
  async contextBackfillRows(host: string): Promise<ContextBackfillRow[]> {
    assertHost(host);
    const rows = await this.db
      .select({
        sessionId: ccSessions.sessionId,
        transcriptPath: ccSessions.transcriptPath,
        transcriptOffset: ccSessions.transcriptOffset,
        forkCutOffset: ccSessions.forkCutOffset,
      })
      .from(ccSessions)
      .where(and(eq(ccSessions.host, host), isNotNull(ccSessions.transcriptPath)))
      .orderBy(desc(sql`coalesce(${ccSessions.lastActiveAt}, ${ccSessions.createdAt})`), asc(ccSessions.sessionId));
    return rows.flatMap((r) => (r.transcriptPath === null ? [] : [{ ...r, transcriptPath: r.transcriptPath }]));
  }

  /**
   * Sets a row's six context columns to what a re-read of its transcript from byte 0 to
   * `fill.upToOffset` found (merge.ts contextColumns). Compare-and-set on transcript_offset and
   * host, under the row lock, so a tail write that landed first wins and the caller re-reads.
   * Writes no other column, not even updated_at: the context is shown in no listing, and moving
   * updated_at would make every session look changed to the summary worker and the graph's
   * fingerprint. Skips the update when the values are already stored.
   */
  async fillContext(sessionId: string, host: string, fill: ContextFill): Promise<FillContextResult> {
    assertSessionId(sessionId);
    assertHost(host);
    assertOffset(fill.upToOffset, 'upToOffset');
    return this.db.transaction(async (tx): Promise<FillContextResult> => {
      const row = await this.lockIfExists(tx, sessionId);
      if (row === null) return { status: 'missing' };
      if (row.host !== host) return { status: 'other_host' };
      if (row.transcriptOffset !== fill.upToOffset) return { status: 'offset_mismatch', storedOffset: row.transcriptOffset };
      const next = contextColumns(fill);
      if (!sameContext(row, next)) await tx.update(ccSessions).set(next).where(eq(ccSessions.sessionId, sessionId));
      return { status: 'applied' };
    });
  }
```
**Impact:** `SessionsRepo` stays the only writer of `cc_sessions` (both new writes are here). `and`, `asc`, `desc`, `eq`, `isNotNull`, `sql` are already imported (L2).

### Step 8: Ingest: raw-line beta detection and the one-time context backfill
**File:** `src/sessions/ingest.ts`
**Change:** eight edits.

(8a) imports. The `./types.js` import (L8-16) becomes:
```ts
import {
  PROMPTS_VERSION_EXCERPTS,
  type ContextBackfillRow,
  type ContextFill,
  type FillContextResult,
  type ForkBackfillRow,
  type HeadUuidFill,
  type PromptsBackfillCandidate,
  type PromptsReplacement,
  type RedactStoredPromptsResult,
  type ReplacePromptsResult,
} from './types.js';
```
and the `./transcript.js` import (L20-30) becomes:
```ts
import {
  buildTranscriptPatch,
  EXCLUDED_ENTRYPOINTS,
  isCopiedRecord,
  isLongContextRequestLine,
  isObject,
  parseRecord,
  readJsonlFrom,
  TranscriptAccumulator,
  type TranscriptCarry,
  type TranscriptRecord,
} from './transcript.js';
```

(8b) header comment: insert this bullet before ` * EXTENSION POINT` (L84):
```ts
 * - Context (migration 0016): every session-file read also gathers the session's context evidence
 *   (TranscriptAccumulator: the latest main-chain assistant message's input + cache + output
 *   tokens, its model and time, the peak, the first own message's context) and, from the raw text
 *   of `api-request` lines that parseRecord drops unparsed, whether a main-thread request listed a
 *   `context-1m-*` beta (transcript.ts isLongContextRequestLine). SessionsRepo merges it
 *   (merge.ts mergeContext). Subagent transcripts never feed it. Rows ingested before it existed
 *   are filled once per host by `contextBackfill` (CONTEXT_BACKFILL_VERSION, app_settings
 *   `${CONTEXT_MARKER_PREFIX}${host}`), after the prompts backfill: each row's transcript is re-read
 *   from 0 to its stored offset under the per-file hold, a fork's copied records feed only the
 *   snapshot and peak as in a tail read, and `SessionsRepo.fillContext` writes the six columns (a
 *   compare-and-set on the offset; no observers, no updated_at). A transcript that is gone is
 *   skipped without a write; the marker is written once nothing was deferred or failed.
 *
```

(8c) `IngestStore` (L106-130): doc and type become:
```ts
/**
 * The `SessionsRepo` methods ingest uses. Unit tests pass an in-memory implementation; one without
 * the subagent methods leaves subagent transcripts unread; one without the three prompts methods
 * skips the prompts backfill; one without `forkCandidates` finds forks from job state only; one
 * without forkBackfillRows, fillHeadUuids, getSetting or putSetting skips the fork backfill; one
 * without contextBackfillRows, fillContext, getSetting or putSetting skips the context backfill.
 */
export type IngestStore = Pick<SessionsRepo, 'offsets' | 'upsertFromTranscript'> &
  Partial<
    Pick<
      SessionsRepo,
      | 'subagentOffsets'
      | 'upsertFromSubagentTranscript'
      | 'promptsBackfillCandidates'
      | 'replacePrompts'
      | 'redactStoredPrompts'
      | 'forkCandidates'
      | 'forkBackfillRows'
      | 'fillHeadUuids'
      | 'contextBackfillRows'
      | 'fillContext'
      | 'getSetting'
      | 'putSetting'
      | 'requestSummary'
    >
  >;
```

(8d) after `emptyForkReport` (ends L237) add:
```ts
/** Bump to make every host run the context backfill once more (e.g. after the capture rules change). */
export const CONTEXT_BACKFILL_VERSION = 1;
/** app_settings key prefix; the full key is `${CONTEXT_MARKER_PREFIX}${host}`. */
export const CONTEXT_MARKER_PREFIX = 'sessions.context_backfill.';

/** What the one-time context backfill did. */
export interface ContextBackfillReport {
  /** False when the marker says it already ran at CONTEXT_BACKFILL_VERSION, or the store lacks the methods. */
  ran: boolean;
  /** Rows of this host with a transcript path. */
  rows: number;
  /** Re-read and written (or found already current). */
  filled: number;
  /** Transcript gone, outside this Claude home, or the row gone or moved host: skipped without a write. */
  missing: number;
  /** Left for the next daemon start: closing, a file shorter than its offset, a second offset miss. */
  deferred: number;
  failed: number;
  ms: number;
}

type ContextBackfillOutcome = 'filled' | 'missing' | 'deferred';
type FillContext = (sessionId: string, host: string, fill: ContextFill) => Promise<FillContextResult>;

function emptyContextReport(): ContextBackfillReport {
  return { ran: false, rows: 0, filled: 0, missing: 0, deferred: 0, failed: 0, ms: 0 };
}
```
and in `SessionIngester` (L271-286), after `promptsBackfill`:
```ts
  /** Settles once the one-time context backfill that follows `promptsBackfill` is done (never rejects). */
  contextBackfill: Promise<ContextBackfillReport>;
```

(8e) `readFile`'s line callback (L625-635) becomes:
```ts
        (line, lineStart) => {
          // parseRecord drops api-request lines unparsed; the one fact a row takes from them, a
          // main-thread 1M beta, is read from the raw text.
          if (isLongContextRequestLine(line)) acc.noteLongContextBeta();
          const record = parseRecord(line);
          if (record === null) return;
          if (isCopiedRecord(record, lineStart, cutOffset)) {
            acc.addCopied(record);
            return;
          }
          acc.add(record);
          if (keepRecords) records.push(record);
        },
```
(The subagent reader `readSubagentFile` is not changed: its accumulator is `sidechain: true`.)

(8f) after `backfillForks` (ends L905), before `const pass = async`, add:
```ts
  /**
   * One row of the context backfill. Re-reads the transcript from 0 to the stored offset, a fork's
   * copied records through addCopied (snapshot and peak only, as the tail read did), and writes the
   * six context columns. An offset miss (a tail write landed first) retries once with the stored
   * offset; a second miss waits for the next start.
   */
  const backfillContextSession = async (r: ContextBackfillRow, fill: FillContext): Promise<ContextBackfillOutcome> => {
    let upTo = r.transcriptOffset;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (closed) return 'deferred';
      if (!isUnder(projectsDir, r.transcriptPath)) return 'missing';
      const size = await fileSize(r.transcriptPath);
      if (size === null) return 'missing';
      // A file shorter than its offset is re-read from 0 by the tail ingester, which writes the context.
      if (size < upTo) return 'deferred';
      const acc = new TranscriptAccumulator(r.sessionId);
      const read = await readJsonlFrom(
        r.transcriptPath,
        0,
        (line, lineStart) => {
          if (isLongContextRequestLine(line)) acc.noteLongContextBeta();
          const record = parseRecord(line);
          if (record === null) return;
          if (isCopiedRecord(record, lineStart, r.forkCutOffset)) acc.addCopied(record);
          else acc.add(record);
        },
        { until: upTo, shouldStop: () => closed, ...(options.chunkBytes !== undefined ? { chunkBytes: options.chunkBytes } : {}) },
      );
      if (read.stopped || read.endOffset !== upTo) return 'deferred';
      const result = await fill(r.sessionId, host, { upToOffset: upTo, ...acc.delta().context });
      if (result.status === 'applied') return 'filled';
      if (result.status !== 'offset_mismatch') return 'missing';
      upTo = result.storedOffset;
    }
    return 'deferred';
  };

  /** The one-time context backfill for this host (see the header). Never notifies observers. */
  const backfillContext = async (): Promise<ContextBackfillReport> => {
    const started = Date.now();
    const report = emptyContextReport();
    const store = options.store;
    const getSetting = store.getSetting?.bind(store);
    const putSetting = store.putSetting?.bind(store);
    const listRows = store.contextBackfillRows?.bind(store);
    const fill = store.fillContext?.bind(store);
    if (getSetting === undefined || putSetting === undefined || listRows === undefined || fill === undefined || closed) return report;
    const key = `${CONTEXT_MARKER_PREFIX}${host}`;
    const marker = await getSetting(key);
    if (isObject(marker) && marker.version === CONTEXT_BACKFILL_VERSION) return report;
    report.ran = true;
    const rows = await listRows(host);
    report.rows = rows.length;
    await forEachLimit(rows, concurrency, async (r) => {
      if (closed) {
        report.deferred += 1;
        return;
      }
      try {
        const outcome = await withFileHeld(r.transcriptPath, () => backfillContextSession(r, fill));
        report[outcome] += 1;
      } catch (err) {
        report.failed += 1;
        log(`[notesd] sessions: context backfill ${r.sessionId}: ${errorMessage(err)}`);
      }
    });
    report.ms = Date.now() - started;
    if (closed) return report; // no marker: the next start runs it again (every write is idempotent)
    if (report.deferred === 0 && report.failed === 0) {
      await putSetting(key, {
        version: CONTEXT_BACKFILL_VERSION,
        finishedAt: new Date().toISOString(),
        rows: report.rows,
        filled: report.filled,
        missing: report.missing,
      });
    }
    if (report.filled + report.deferred + report.failed > 0) log(formatContextReport(report));
    return report;
  };
```

(8g) after the `promptsBackfill` promise (ends L1045) add:
```ts
  // After the prompts backfill, so the one-time re-reads of a host run one after another.
  let contextSettled = false;
  const contextBackfill: Promise<ContextBackfillReport> = promptsBackfill
    .then(() => backfillContext())
    .catch((err: unknown) => {
      log(`[notesd] sessions: context backfill failed: ${errorMessage(err)}`);
      return { ...emptyContextReport(), ran: true, failed: 1 };
    })
    .finally(() => {
      contextSettled = true;
    });
```
and the returned object (L1061-1116) becomes (three changes: `contextBackfill` property, `idle` pending list, `close` pending list):
```ts
  return {
    ready,
    forkBackfill,
    promptsBackfill,
    contextBackfill,
    addObserver(observer) {
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },
    sweep: () => fullSweep('sweep'),
    async idle() {
      for (;;) {
        if (watchTimer !== null) {
          clearTimeout(watchTimer);
          drainWatch();
        }
        const pending = [
          sweeping,
          watchDrain,
          forkSettled ? null : forkBackfill,
          promptsSettled ? null : promptsBackfill,
          contextSettled ? null : contextBackfill,
          ...inflight.values(),
        ].filter((p) => p !== null);
        if (pending.length === 0) return;
        await Promise.allSettled(pending);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      if (timer !== null) clearInterval(timer);
      if (watchTimer !== null) clearTimeout(watchTimer);
      watchTimer = null;
      const closing = watcher?.close().catch(() => undefined);
      const pending = Promise.allSettled([closing, sweeping, watchDrain, forkBackfill, promptsBackfill, contextBackfill, ...inflight.values()]);
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        pending,
        new Promise<void>((resolve) => {
          grace = setTimeout(resolve, closeGraceMs);
          grace.unref();
        }),
      ]);
      if (grace !== undefined) clearTimeout(grace);
    },
  };
```

(8h) at the end of the file, after `formatForkReport`:
```ts
/** e.g. `[notesd] sessions: context backfill 640 sessions, 612 filled, 25 transcripts gone, 0 deferred, 0 failed, 3810ms` */
export function formatContextReport(r: ContextBackfillReport): string {
  return `[notesd] sessions: context backfill ${r.rows} sessions, ${r.filled} filled, ${r.missing} transcripts gone, ${r.deferred} deferred, ${r.failed} failed, ${r.ms}ms`;
}
```
**Impact:** on the first start after this phase each host re-reads every transcript it owns once (measured ~2–5 s for ~900 MB), one file at a time per hold, `concurrency` at once; tail reads of a held file wait for it. Observers see no backfill writes. A subsequent start reads the marker and does nothing.

### Step 9: Test helper
**File:** `tests/helpers/memoryIngestStore.ts`
**Change:** (a) import `contextColumns` from merge and `type ContextBackfillRow, type ContextFill, type FillContextResult` from types; (b) `blankSessionRow` (L49-99) gets the six columns after `forkDetectedBy: null,`; (c) `MemoryIngestStore` gets `contextBackfillRows` and `fillContext` after `redactStoredPrompts` (L297-306); (d) a settings subclass at the end of the file.
**Code:**

(a) the merge import (L2-15) adds `contextColumns,` (first, alphabetical); the types import (L16-39) adds `type ContextBackfillRow,`, `type ContextFill,`, `type FillContextResult,` (after `REPLIES_VERSION,`).

(b) in `blankSessionRow`, after `forkDetectedBy: null,`:
```ts
    contextTokens: null,
    contextModel: null,
    contextAt: null,
    contextPeakTokens: null,
    contextFirstTokens: null,
    contextLongBeta: false,
```
(c) in `MemoryIngestStore`:
```ts
  /** SessionsRepo.contextBackfillRows over the Map: rows of `host` with a transcript path. */
  async contextBackfillRows(host: string): Promise<ContextBackfillRow[]> {
    return [...this.rows.values()].flatMap((r) =>
      r.host === host && r.transcriptPath !== null
        ? [{ sessionId: r.sessionId, transcriptPath: r.transcriptPath, transcriptOffset: r.transcriptOffset, forkCutOffset: r.forkCutOffset }]
        : [],
    );
  }

  /** SessionsRepo.fillContext over the Map: the same compare-and-set, the six context columns only. */
  async fillContext(sessionId: string, host: string, fill: ContextFill): Promise<FillContextResult> {
    const row = this.rows.get(sessionId);
    if (!row) return { status: 'missing' };
    if (row.host !== host) return { status: 'other_host' };
    if (row.transcriptOffset !== fill.upToOffset) return { status: 'offset_mismatch', storedOffset: row.transcriptOffset };
    this.rows.set(sessionId, { ...row, ...contextColumns(fill) });
    return { status: 'applied' };
  }
```
(d) at the end of the file:
```ts
/**
 * MemoryIngestStore plus app_settings. getSetting/putSetting turn on the one-time context backfill
 * (the fork backfill stays off: it also needs forkBackfillRows and fillHeadUuids, which neither
 * store has). Kept separate so the existing ingest tests run without any one-time backfill.
 */
export class MemorySettingsIngestStore extends MemoryIngestStore {
  readonly settings = new Map<string, unknown>();

  async getSetting(key: string): Promise<unknown | null> {
    return this.settings.get(key) ?? null;
  }

  async putSetting(key: string, value: unknown): Promise<void> {
    if (value === null || value === undefined) this.settings.delete(key);
    else this.settings.set(key, value);
  }
}
```
**Impact:** the base `MemoryIngestStore` still has no settings methods, so no existing unit test starts running a backfill.

### Step 10: Unit tests: merge and transcript
**File:** `tests/unit/sessions/merge.test.ts`
**Change:** (a) `blankRow` (L19-67): add after `forkDetectedBy: null,` the same six lines as Step 9b. (b) Imports: the `merge.js` import adds `contextColumns, mergeContext, sameContext`; the types import (L15) becomes `import { MAX_PROMPT_CHARS, MAX_PROMPTS, type ContextEvidence, type SessionRow, type TranscriptPatch } from '../../../src/sessions/types.js'`. (c) Append a describe at the end of the file.
**Code:**
```ts
describe('context columns', () => {
  const ev = (tokens: number | null, peak: number | null, first: number | null, longBeta = false, model = 'claude-opus-5-5'): ContextEvidence => ({
    latest: tokens === null ? null : { tokens, model, at: T(tokens % 50) },
    peakTokens: peak,
    firstTokens: first,
    longBeta,
  })
  const stored = blankRow({
    transcriptOffset: 10,
    contextTokens: 50_000,
    contextModel: 'claude-opus-5-5',
    contextAt: T(1),
    contextPeakTokens: 60_000,
    contextFirstTokens: 40_000,
    contextLongBeta: false,
  })

  it('a read from byte 0 replaces all six, and no evidence clears them', () => {
    expect(mergeContext(stored, ev(500, 700, 300, true, 'claude-sonnet-4-6'), true)).toEqual({
      contextTokens: 500,
      contextModel: 'claude-sonnet-4-6',
      contextAt: T(0),
      contextPeakTokens: 700,
      contextFirstTokens: 300,
      contextLongBeta: true,
    })
    expect(mergeContext(stored, undefined, true)).toEqual(contextColumns(undefined))
    expect(contextColumns(undefined)).toEqual({
      contextTokens: null,
      contextModel: null,
      contextAt: null,
      contextPeakTokens: null,
      contextFirstTokens: null,
      contextLongBeta: false,
    })
  })

  it('an append stores a later, smaller context, keeps the peak and the first message, and ORs the beta (R1.3)', () => {
    expect(mergeContext(stored, ev(9_000, 9_000, 9_000, true, 'claude-sonnet-5-5'), false)).toEqual({
      contextTokens: 9_000,
      contextModel: 'claude-sonnet-5-5',
      contextAt: T(0),
      contextPeakTokens: 60_000,
      contextFirstTokens: 40_000,
      contextLongBeta: true,
    })
    expect(mergeContext(stored, ev(70_000, 70_000, 70_000), false).contextPeakTokens).toBe(70_000)
  })

  it('an append with no assistant message keeps the snapshot; no evidence keeps everything', () => {
    const set = mergeContext(stored, ev(null, null, null, true), false)
    expect(set).toMatchObject({ contextTokens: 50_000, contextModel: 'claude-opus-5-5', contextPeakTokens: 60_000, contextLongBeta: true })
    expect(mergeContext(stored, undefined, false)).toEqual(contextColumns({ latest: { tokens: 50_000, model: 'claude-opus-5-5', at: T(1) }, peakTokens: 60_000, firstTokens: 40_000, longBeta: false }))
  })

  it('an append takes the first message only while none is stored', () => {
    expect(mergeContext(blankRow({ transcriptOffset: 10 }), ev(1_000, 1_000, 1_000), false).contextFirstTokens).toBe(1_000)
  })

  it('mergeTranscriptPatch carries the context columns', () => {
    const set = mergeTranscriptPatch(stored, patch({ fromOffset: 10, toOffset: 20, context: ev(4_011, 4_011, 4_011) }))
    expect(set).toMatchObject({ contextTokens: 4_011, contextPeakTokens: 60_000, contextFirstTokens: 40_000 })
    expect(mergeTranscriptPatch(stored, patch({ fromOffset: 10, toOffset: 20 }))).toMatchObject({ contextTokens: 50_000 })
  })

  it('sameContext compares times by value', () => {
    const a = contextColumns(ev(10, 10, 10))
    expect(sameContext(a, { ...a, contextAt: new Date(a.contextAt?.getTime() ?? 0) })).toBe(true)
    expect(sameContext(a, { ...a, contextLongBeta: true })).toBe(false)
  })
})
```
**File:** `tests/unit/sessions/transcript.test.ts`
**Change:** import adds `isLongContextRequestLine` to the transcript import (L5-15); append a describe at the end of the file.
**Code:**
```ts
describe('context capture', () => {
  const at = (s: number): string => `2026-11-02T00:00:${String(s).padStart(2, '0')}.000Z`;
  const msg = (id: string, usage: Record<string, number>, s: number, extra: Record<string, unknown> = {}, model = 'claude-opus-5-5'): string =>
    JSON.stringify({ type: 'assistant', timestamp: at(s), ...extra, message: { id, model, role: 'assistant', content: [{ type: 'text', text: id }], usage } });
  const request = (querySource: string, betas: string[], tail: unknown[] = []): string =>
    JSON.stringify({ type: 'api-request', sessionId: 's', timestamp: at(0), querySource, params: { model: 'claude-sonnet-4-6', betas }, tail });
  const EMPTY = { latest: null, peakTokens: null, firstTokens: null, longBeta: false };

  it('sums input, cache read, cache write and output of the latest main-chain message (R1.2)', () => {
    const d = accumulateText(
      's',
      [
        msg('m1', { input_tokens: 2, cache_read_input_tokens: 29_065, cache_creation_input_tokens: 20_795, output_tokens: 544 }, 1),
        msg('m2', { input_tokens: 1, cache_read_input_tokens: 32_000, output_tokens: 20 }, 2),
      ].join('\n'),
    ).delta();
    expect(d.context).toEqual({ latest: { tokens: 32_021, model: 'claude-opus-5-5', at: new Date(at(2)) }, peakTokens: 50_406, firstTokens: 50_406, longBeta: false });
  });

  it('ignores sidechain records, zero-usage and <synthetic> messages (R1.2)', () => {
    const d = accumulateText(
      's',
      [
        msg('m1', { input_tokens: 1_000 }, 1),
        msg('side', { input_tokens: 900_000 }, 2, { isSidechain: true }),
        msg('zero', { input_tokens: 0, output_tokens: 0 }, 3),
        msg('none', {}, 4),
        msg('synth', { input_tokens: 5_000 }, 5, {}, '<synthetic>'),
      ].join('\n'),
    ).delta();
    expect(d.context).toEqual({ latest: { tokens: 1_000, model: 'claude-opus-5-5', at: new Date(at(1)) }, peakTokens: 1_000, firstTokens: 1_000, longBeta: false });
  });

  it('keeps the later, smaller context after a compaction (R1.3)', () => {
    const d = accumulateText('s', [msg('m1', { cache_read_input_tokens: 300_000 }, 1), msg('m2', { cache_read_input_tokens: 40_000 }, 2)].join('\n')).delta();
    expect(d.context).toMatchObject({ latest: { tokens: 40_000 }, peakTokens: 300_000, firstTokens: 300_000 });
  });

  it('a sidechain accumulator never gathers context, whatever it reads (R1.2)', () => {
    const acc = new TranscriptAccumulator('s', undefined, { sidechain: true });
    const record = parseRecord(msg('sub', { input_tokens: 5_000 }, 1, { isSidechain: true }));
    if (record === null) throw new Error('unparsed');
    acc.add(record);
    acc.noteLongContextBeta();
    expect(acc.delta().context).toEqual(EMPTY);
  });

  it('copied records set the snapshot and peak, never the first message (R1.4)', () => {
    const acc = new TranscriptAccumulator('s');
    const rec = (line: string) => {
      const r = parseRecord(line);
      if (r === null) throw new Error('unparsed');
      return r;
    };
    acc.addCopied(rec(msg('p2', { input_tokens: 200, cache_read_input_tokens: 2_000, output_tokens: 20 }, 1, {}, 'claude-haiku-4-5')));
    acc.addCopied(rec(msg('p3', { input_tokens: 300, output_tokens: 30 }, 2, {}, 'claude-haiku-4-5')));
    expect(acc.delta().context).toEqual({ latest: { tokens: 330, model: 'claude-haiku-4-5', at: new Date(at(2)) }, peakTokens: 2_220, firstTokens: null, longBeta: false });
    acc.add(rec(msg('own', { input_tokens: 11, output_tokens: 1 }, 3)));
    expect(acc.delta().context).toEqual({ latest: { tokens: 12, model: 'claude-opus-5-5', at: new Date(at(3)) }, peakTokens: 2_220, firstTokens: 12, longBeta: false });
  });

  it('flags a context-1m beta only on a main-thread api-request line (R2.3)', () => {
    expect(isLongContextRequestLine(request('repl_main_thread', ['claude-code-20250219', 'context-1m-2025-08-07']))).toBe(true);
    expect(isLongContextRequestLine(request('repl_main_thread:outputStyle:Explanatory', ['context-1m-2025-08-07']))).toBe(true);
    expect(isLongContextRequestLine(request('agent:builtin:Explore', ['context-1m-2025-08-07']))).toBe(false);
    expect(isLongContextRequestLine(request('repl_main_thread', ['claude-code-20250219']))).toBe(false);
    expect(isLongContextRequestLine(request('repl_main_thread', ['claude-code-20250219'], [{ role: 'user', content: 'why is "context-1m-2025-08-07" set?' }]))).toBe(false);
    expect(isLongContextRequestLine(request('repl_main_thread', ['context-1m-2025-08-07']).replace('"type":"api-request"', '"type":"api-request-blob"'))).toBe(false);
    expect(isLongContextRequestLine(user('turn on "context-1m-2025-08-07"'))).toBe(false);
    expect(parseRecord(request('repl_main_thread', ['context-1m-2025-08-07']))).toBeNull();
    expect(accumulateText('s', request('repl_main_thread', ['context-1m-2025-08-07'])).delta().context).toEqual({ ...EMPTY, longBeta: true });
  });

  it('buildTranscriptPatch sends the context evidence', () => {
    const d = accumulateText('s', msg('m1', { input_tokens: 7 }, 1)).delta();
    const p = buildTranscriptPatch(d, { host: 'h', transcriptPath: '/x/s.jsonl', fromOffset: 40, toOffset: 100, size: 100, repo: null });
    expect(p.context).toEqual(d.context);
  });
});
```
**Impact:** unit tests only.

### Step 11: Unit tests: window module
**File:** `tests/unit/sessions/contextWindow.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_BANDS,
  contextBand,
  contextPercent,
  contextWindowFor,
  LONG_CONTEXT_WINDOW,
  STANDARD_CONTEXT_WINDOW,
} from '../../../src/sessions/contextWindow.js';

const w = (model: string | null, peakTokens: number | null = null, longBeta = false) => contextWindowFor({ model, peakTokens, longBeta });
const LONG_MODEL = { window: LONG_CONTEXT_WINDOW, source: 'model' };
const STANDARD_MODEL = { window: STANDARD_CONTEXT_WINDOW, source: 'model' };
const DEFAULT = { window: STANDARD_CONTEXT_WINDOW, source: 'default' };

describe('contextWindowFor', () => {
  it('reads the window from the model table, longest prefix first, with no user setting (R2.1)', () => {
    for (const m of [
      'claude-opus-5-5',
      'claude-opus-5',
      'claude-sonnet-5-5',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-fable-5-1',
      'claude-mythos-5-1',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-haiku-5-5',
    ]) {
      expect(w(m), m).toEqual(LONG_MODEL);
    }
    for (const m of ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'CLAUDE-HAIKU-4-5']) {
      expect(w(m), m).toEqual(STANDARD_MODEL);
    }
  });

  it('infers 1M once the context has exceeded 200,000 tokens (R2.2)', () => {
    expect(w('claude-sonnet-4-6', 200_001)).toEqual({ window: LONG_CONTEXT_WINDOW, source: 'peak' });
    expect(w('claude-sonnet-4-6', 200_000)).toEqual(STANDARD_MODEL);
    expect(w('glm-5.3', 250_000)).toEqual({ window: LONG_CONTEXT_WINDOW, source: 'peak' });
  });

  it('infers 1M from a context-1m beta or a [1m] model id (R2.3)', () => {
    expect(w('claude-sonnet-4-6', 92_484, true)).toEqual({ window: LONG_CONTEXT_WINDOW, source: 'beta' });
    expect(w('claude-opus-4-6[1m]')).toEqual({ window: LONG_CONTEXT_WINDOW, source: 'beta' });
    expect(w(null, null, true)).toEqual({ window: LONG_CONTEXT_WINDOW, source: 'beta' });
  });

  it('uses 200,000 with source default for a model not in the table and no 1M evidence (R2.4)', () => {
    expect(w('glm-5.3', 6_335)).toEqual(DEFAULT);
    expect(w('claude-opus-6')).toEqual(DEFAULT);
    expect(w(null)).toEqual(DEFAULT);
    expect(w('  ')).toEqual(DEFAULT);
  });

  it('a native 1M model reports source model even with other evidence', () => {
    expect(w('claude-opus-5-5', 500_000, true)).toEqual(LONG_MODEL);
  });
});

describe('contextBand', () => {
  it('is green below 40, amber from 40 to below 70, red from 70', () => {
    expect(CONTEXT_BANDS).toEqual({ amberFrom: 40, redFrom: 70 });
    expect(contextBand(0)).toBe('green');
    expect(contextBand(39.9)).toBe('green');
    expect(contextBand(40)).toBe('amber');
    expect(contextBand(69.9)).toBe('amber');
    expect(contextBand(70)).toBe('red');
    expect(contextBand(100)).toBe('red');
  });
});

describe('contextPercent', () => {
  it('rounds to one decimal and never divides by zero', () => {
    expect(contextPercent(32_021, LONG_CONTEXT_WINDOW)).toBe(3.2);
    expect(contextPercent(150_000, STANDARD_CONTEXT_WINDOW)).toBe(75);
    expect(contextPercent(10, 0)).toBe(0);
  });
});
```

### Step 12: Unit tests: ingest and forks
**File:** `tests/unit/sessions/ingest.test.ts`
**Change:** imports: the ingest import adds `CONTEXT_BACKFILL_VERSION, CONTEXT_MARKER_PREFIX`; add `import { contextWindowFor } from '../../../src/sessions/contextWindow.js';`; the memory-store import becomes `import { MemoryIngestStore, MemorySettingsIngestStore } from '../../helpers/memoryIngestStore.js';`; `rm` is already imported. Append two describes at the end of the file (they reuse `start`, `line`, `mainPath`, `subPath`, `subagentWork`, `store`).
**Code:**
```ts
/** The main fixture's context as ingest reads it: msg_D (1 + 32,000 + 0 + 20) is the latest, msg_A (2 + 29,065 + 20,795 + 544) the first and largest. */
const MAIN_CONTEXT = {
  contextTokens: 32_021,
  contextModel: 'claude-opus-5-5',
  contextAt: new Date('2026-11-02T02:23:10.000Z'),
  contextPeakTokens: 50_406,
  contextFirstTokens: 50_406,
  contextLongBeta: false,
};
const NO_CONTEXT = { contextTokens: null, contextModel: null, contextAt: null, contextPeakTokens: null, contextFirstTokens: null, contextLongBeta: false };

function mainAssistant(id: string, usage: Record<string, number>, at: string, model = 'claude-opus-5-5'): string {
  return line({
    type: 'assistant',
    sessionId: FIXTURE.main,
    uuid: `u-${id}`,
    timestamp: at,
    message: { id, model, role: 'assistant', content: [{ type: 'text', text: `reply ${id}` }], usage },
  });
}

function apiRequest(querySource: string, betas: string[]): string {
  return line({ type: 'api-request', sessionId: FIXTURE.main, id: `req-${querySource}`, timestamp: '2026-11-02T03:00:00.000Z', querySource, params: { model: 'claude-sonnet-4-6', betas }, tail: [] });
}

describe('startSessionIngest: context capture', () => {
  const main = (): SessionRow => {
    const r = store.rows.get(FIXTURE.main);
    if (r === undefined) throw new Error('no main row');
    return r;
  };

  it('stores the latest main-chain context; sidechain records and subagent transcripts never move it (R1.2)', async () => {
    const ingester = start();
    await ingester.ready;
    expect(main()).toMatchObject(MAIN_CONTEXT);
    const inputBefore = main().inputTokens;
    await appendFile(mainPath(), subagentWork(7, 'aaaa111', '2026-11-02T03:00:00.000Z'));
    await appendFile(subPath(), subagentWork(8, 'bbbb222', '2026-11-02T03:00:01.000Z'));
    await ingester.sweep();
    expect(main().inputTokens).toBe(inputBefore + 1); // the subagent transcript was read
    expect(main()).toMatchObject(MAIN_CONTEXT);
  });

  it('stores the later, smaller context after a compaction and keeps the peak and the first message (R1.3)', async () => {
    const ingester = start();
    await ingester.ready;
    await appendFile(mainPath(), mainAssistant('msg_E', { input_tokens: 1, cache_read_input_tokens: 4_000, output_tokens: 10 }, '2026-11-02T03:10:00.000Z'));
    await ingester.sweep();
    expect(main()).toMatchObject({ ...MAIN_CONTEXT, contextTokens: 4_011, contextAt: new Date('2026-11-02T03:10:00.000Z') });
  });

  it('keeps a peak above 200,000 after the context falls, which infers a 1M window (R2.2)', async () => {
    const ingester = start();
    await ingester.ready;
    await appendFile(
      mainPath(),
      mainAssistant('msg_F', { input_tokens: 1, cache_read_input_tokens: 249_000, cache_creation_input_tokens: 999 }, '2026-11-02T03:20:00.000Z', 'claude-sonnet-4-6') +
        mainAssistant('msg_G', { input_tokens: 5_000 }, '2026-11-02T03:21:00.000Z', 'claude-sonnet-4-6'),
    );
    await ingester.sweep();
    const r = main();
    expect(r).toMatchObject({ contextTokens: 5_000, contextModel: 'claude-sonnet-4-6', contextPeakTokens: 250_000, contextLongBeta: false });
    expect(contextWindowFor({ model: r.contextModel, peakTokens: r.contextPeakTokens, longBeta: r.contextLongBeta })).toEqual({ window: 1_000_000, source: 'peak' });
  });

  it('flags a context-1m beta from a main-thread api-request line only, without parsing it into the batch (R2.3)', async () => {
    const batches: IngestBatch[] = [];
    const ingester = start({ observers: [{ onBatch: (b) => batches.push(b) }] });
    await ingester.ready;
    await appendFile(
      mainPath(),
      apiRequest('agent:builtin:Explore', ['claude-code-20250219', 'context-1m-2025-08-07']) +
        line({ type: 'user', sessionId: FIXTURE.main, uuid: 'u-q', timestamp: '2026-11-02T03:30:00.000Z', cwd: '/home/u/mcp-notes', entrypoint: 'cli', message: { role: 'user', content: 'what does "context-1m-2025-08-07" do?' } }) +
        apiRequest('repl_main_thread', ['claude-code-20250219']) +
        mainAssistant('msg_H', { input_tokens: 92_484 }, '2026-11-02T03:30:05.000Z', 'claude-sonnet-4-6'),
    );
    await ingester.sweep();
    expect(main()).toMatchObject({ contextTokens: 92_484, contextLongBeta: false });
    expect(contextWindowFor({ model: main().contextModel, peakTokens: main().contextPeakTokens, longBeta: main().contextLongBeta })).toEqual({ window: 200_000, source: 'model' });

    await appendFile(mainPath(), apiRequest('repl_main_thread:outputStyle:Explanatory', ['claude-code-20250219', 'context-1m-2025-08-07']));
    await ingester.sweep();
    const r = main();
    expect(r).toMatchObject({ contextTokens: 92_484, contextLongBeta: true });
    expect(contextWindowFor({ model: r.contextModel, peakTokens: r.contextPeakTokens, longBeta: r.contextLongBeta })).toEqual({ window: 1_000_000, source: 'beta' });
    expect(batches.flatMap((b) => b.records).some((rec) => rec.type === 'api-request')).toBe(false);
  });
});

describe('startSessionIngest: context backfill', () => {
  const marker = `${CONTEXT_MARKER_PREFIX}test-host`;
  const age = (s: MemorySettingsIngestStore): void => {
    for (const [id, r] of s.rows) s.rows.set(id, { ...r, ...NO_CONTEXT });
  };

  it("fills each of the host's rows once from its transcript and writes its marker (R1.5)", async () => {
    const s = new MemorySettingsIngestStore();
    store = s;
    const first = start();
    expect(await first.contextBackfill).toMatchObject({ ran: true, failed: 0, deferred: 0 });
    await first.close();
    age(s); // what a daemon without context capture left behind
    await s.putSetting(marker, null);

    const second = start();
    expect(await second.contextBackfill).toMatchObject({ ran: true, rows: 3, filled: 3, missing: 0, deferred: 0, failed: 0 });
    expect(s.rows.get(FIXTURE.main)).toMatchObject(MAIN_CONTEXT);
    expect(s.rows.get(FIXTURE.worktreeChild)).toMatchObject({ contextTokens: 370, contextFirstTokens: 370, contextPeakTokens: 370 });
    expect(await s.getSetting(marker)).toMatchObject({ version: CONTEXT_BACKFILL_VERSION, rows: 3, filled: 3 });
    await second.close();

    age(s);
    expect(await start().contextBackfill).toMatchObject({ ran: false });
    expect(s.rows.get(FIXTURE.main)?.contextTokens).toBeNull(); // once per host: the marker stops a second run
  });

  it('skips a transcript that is gone without a write, and still writes the marker', async () => {
    const s = new MemorySettingsIngestStore();
    store = s;
    const first = start();
    await first.contextBackfill;
    await first.close();
    age(s);
    await s.putSetting(marker, null);
    await rm(mainPath());

    const second = start();
    expect(await second.contextBackfill).toMatchObject({ ran: true, rows: 3, filled: 2, missing: 1, failed: 0 });
    expect(s.rows.get(FIXTURE.main)).toMatchObject(NO_CONTEXT);
    expect(await s.getSetting(marker)).toMatchObject({ version: CONTEXT_BACKFILL_VERSION, missing: 1 });
  });
});
```
**File:** `tests/unit/sessions/ingestForks.test.ts`
**Change:** import `MemorySettingsIngestStore` alongside `MemoryIngestStore` (L18) and `CONTEXT_MARKER_PREFIX` from the ingest import (L3); append a describe.
**Code:**
```ts
describe('ingest: fork context', () => {
  it('a fork reports the context it copied until its own first message replaces it (R1.4)', async () => {
    const ingester = await startWithParent();
    await stageForks(home, FORKS.job, FORKS.pending);
    expect((await ingester.sweep()).failed).toBe(0);
    // Parent: msg_p4 (400 + 40) last, msg_p1 (100 + 1,000 + 50 + 10) first, msg_p2 (200 + 2,000 + 20) largest.
    expect(row(FORKS.parent)).toMatchObject({ contextTokens: 440, contextModel: 'claude-haiku-4-5', contextFirstTokens: 1_160, contextPeakTokens: 2_220 });
    // Job fork: copied p1-p3, then its own j1 (66) and j2 (77).
    expect(row(FORKS.job)).toMatchObject({ contextTokens: 77, contextModel: 'claude-opus-5-5', contextFirstTokens: 66, contextPeakTokens: 2_220 });
    // Pending fork: only the copy so far: the last copied message (msg_p3, 300 + 30).
    expect(row(FORKS.pending)).toMatchObject({
      contextTokens: 330,
      contextModel: 'claude-haiku-4-5',
      contextAt: FORK_BOUNDARY,
      contextFirstTokens: null,
      contextPeakTokens: 2_220,
      inputTokens: 0,
    });

    await appendPendingOwn(home);
    await ingester.sweep();
    expect(row(FORKS.pending)).toMatchObject({
      contextTokens: 12,
      contextModel: 'claude-opus-5-5',
      contextAt: new Date('2026-11-01T01:50:05.000Z'),
      contextFirstTokens: 12,
      contextPeakTokens: 2_220,
      inputTokens: 11,
    });
  });

  it('the context backfill re-reads a fork with its cut: the copied snapshot, never a copied first message (R1.4, R1.5)', async () => {
    const s = new MemorySettingsIngestStore();
    store = s;
    const first = await startWithParent();
    await stageForks(home, FORKS.pending);
    await first.sweep();
    await first.contextBackfill;
    await first.close();
    const pending = row(FORKS.pending);
    s.rows.set(FORKS.pending, { ...pending, contextTokens: null, contextModel: null, contextAt: null, contextPeakTokens: null, contextFirstTokens: null });
    await s.putSetting(`${CONTEXT_MARKER_PREFIX}${HOST}`, null);

    const second = start();
    expect(await second.contextBackfill).toMatchObject({ ran: true, failed: 0, deferred: 0 });
    expect(row(FORKS.pending)).toMatchObject({ contextTokens: 330, contextModel: 'claude-haiku-4-5', contextFirstTokens: null, contextPeakTokens: 2_220, inputTokens: 0 });
  });
});
```
**Impact:** unit tests only.

### Step 13: Integration tests
**File:** `tests/integration/sessions.schema.int.test.ts` (append at the end)
**Code:**
```ts
describe('migration 0016 (session context)', () => {
  let db: Db

  beforeAll(() => {
    db = openTestDb()
  })
  afterAll(async () => {
    await closeTestDb(db)
  })
  beforeEach(async () => {
    await truncateAll(db)
  })

  it('is journal entry 16', () => {
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>
    }
    expect(journal.entries.find((e) => e.idx === 16)?.tag).toBe('0016_session_context')
  })

  it('adds five nullable context columns and a long-context flag that defaults to false', async () => {
    const cols = await db.execute<{ column_name: string; is_nullable: string; data_type: string }>(sql`
      select column_name, is_nullable, data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'cc_sessions' and column_name like 'context\_%'
      order by column_name
    `)
    expect(cols.rows).toEqual([
      { column_name: 'context_at', is_nullable: 'YES', data_type: 'timestamp with time zone' },
      { column_name: 'context_first_tokens', is_nullable: 'YES', data_type: 'bigint' },
      { column_name: 'context_long_beta', is_nullable: 'NO', data_type: 'boolean' },
      { column_name: 'context_model', is_nullable: 'YES', data_type: 'text' },
      { column_name: 'context_peak_tokens', is_nullable: 'YES', data_type: 'bigint' },
      { column_name: 'context_tokens', is_nullable: 'YES', data_type: 'bigint' },
    ])
    await db.execute(sql`insert into cc_sessions (session_id, node_id, host) values ('s-1', 'A0-1A', 'h')`)
    const row = await db.execute<{ context_long_beta: boolean; context_tokens: string | null }>(
      sql`select context_long_beta, context_tokens from cc_sessions where session_id = 's-1'`,
    )
    expect(row.rows[0]).toEqual({ context_long_beta: false, context_tokens: null })
  })
})
```
**File:** `tests/integration/sessions.repo.int.test.ts`
**Change:** the types import (L12) adds `type ContextEvidence`; add a describe inside `describe('SessionsRepo', ...)`, after `describe('transcript upserts', ...)` (ends ~L201).
**Code:**
```ts
  describe('context columns', () => {
    const FULL: ContextEvidence = { latest: { tokens: 50_000, model: 'claude-opus-5-5', at: at(1) }, peakTokens: 60_000, firstTokens: 40_000, longBeta: false }
    const NONE: ContextEvidence = { latest: null, peakTokens: null, firstTokens: null, longBeta: false }

    it('a read from byte 0 writes the six context columns, and the next one replaces them', async () => {
      await repo.upsertFromTranscript(patch('s-1', { context: FULL }))
      expect(await repo.getBySessionId('s-1')).toMatchObject({
        contextTokens: 50_000,
        contextModel: 'claude-opus-5-5',
        contextAt: at(1),
        contextPeakTokens: 60_000,
        contextFirstTokens: 40_000,
        contextLongBeta: false,
      })
      await repo.upsertFromTranscript(patch('s-1', { toOffset: 120, size: 120, context: NONE }))
      expect(await repo.getBySessionId('s-1')).toMatchObject({
        contextTokens: null,
        contextModel: null,
        contextAt: null,
        contextPeakTokens: null,
        contextFirstTokens: null,
        contextLongBeta: false,
      })
    })

    it('an append keeps the snapshot without an assistant message, stores a later smaller one, keeps peak and first, ORs the beta', async () => {
      await repo.upsertFromTranscript(patch('s-1', { context: FULL }))
      await repo.upsertFromTranscript(patch('s-1', { fromOffset: 100, toOffset: 150, size: 150, context: { ...NONE, longBeta: true } }))
      expect(await repo.getBySessionId('s-1')).toMatchObject({ contextTokens: 50_000, contextLongBeta: true })
      await repo.upsertFromTranscript(
        patch('s-1', {
          fromOffset: 150,
          toOffset: 200,
          size: 200,
          context: { latest: { tokens: 9_000, model: 'claude-sonnet-5-5', at: at(5) }, peakTokens: 9_000, firstTokens: 9_000, longBeta: false },
        }),
      )
      expect(await repo.getBySessionId('s-1')).toMatchObject({
        contextTokens: 9_000,
        contextModel: 'claude-sonnet-5-5',
        contextAt: at(5),
        contextPeakTokens: 60_000,
        contextFirstTokens: 40_000,
        contextLongBeta: true,
      })
      await repo.upsertFromTranscript(patch('s-1', { fromOffset: 200, toOffset: 210, size: 210 }))
      expect(await repo.getBySessionId('s-1')).toMatchObject({ contextTokens: 9_000, contextPeakTokens: 60_000 })
    })

    it('fillContext writes the six columns under a compare-and-set on the offset and leaves updated_at alone', async () => {
      await repo.upsertFromTranscript(patch('s-1'))
      const before = await repo.getBySessionId('s-1')
      const fill = { upToOffset: 100, ...FULL, longBeta: true }
      expect(await repo.fillContext('s-1', HOST, { ...fill, upToOffset: 90 })).toEqual({ status: 'offset_mismatch', storedOffset: 100 })
      expect(await repo.fillContext('s-1', 'host-b', fill)).toEqual({ status: 'other_host' })
      expect(await repo.fillContext('s-none', HOST, fill)).toEqual({ status: 'missing' })
      expect((await repo.getBySessionId('s-1'))?.contextTokens).toBeNull()
      expect(await repo.fillContext('s-1', HOST, fill)).toEqual({ status: 'applied' })
      const after = await repo.getBySessionId('s-1')
      expect(after).toMatchObject({ contextTokens: 50_000, contextPeakTokens: 60_000, contextFirstTokens: 40_000, contextLongBeta: true, transcriptOffset: 100 })
      expect(after?.updatedAt).toEqual(before?.updatedAt)
    })

    it('contextBackfillRows lists the rows of one host that have a transcript path', async () => {
      await repo.upsertFromTranscript(patch('s-1'))
      await repo.upsertFromTranscript(patch('s-2', { host: 'host-b' }))
      await repo.ensureSession('s-3', HOST)
      expect(await repo.contextBackfillRows(HOST)).toEqual([
        { sessionId: 's-1', transcriptPath: '/home/u/.claude/projects/p/s-1.jsonl', transcriptOffset: 100, forkCutOffset: null },
      ])
    })
  })
```
**File:** `tests/integration/sessions.ingest.int.test.ts`
**Change:** the ingest import (L13) becomes `import { CONTEXT_BACKFILL_VERSION, CONTEXT_MARKER_PREFIX, startSessionIngest, type SessionIngester } from '../../src/sessions/ingest.js';`; add after `const IDS = ...` (L20):
```ts
const MARKER = `${CONTEXT_MARKER_PREFIX}test-host`;
const MAIN_CONTEXT = {
  contextTokens: 32_021,
  contextModel: 'claude-opus-5-5',
  contextAt: new Date('2026-11-02T02:23:10.000Z'),
  contextPeakTokens: 50_406,
  contextFirstTokens: 50_406,
  contextLongBeta: false,
};
```
in `beforeEach` (L65-68), after the delete of `cc_sessions` rows add:
```ts
  await db.execute(sql`delete from app_settings where key = ${MARKER}`);
```
and add two tests inside `describe('session ingest into cc_sessions', ...)` after the existing two:
```ts
  it('stores the latest main-chain context of each session (R1.2)', async () => {
    await start().ready;
    expect(await repo.getBySessionId(FIXTURE.main)).toMatchObject(MAIN_CONTEXT);
    expect(await repo.getBySessionId(FIXTURE.worktreeChild)).toMatchObject({ contextTokens: 370, contextFirstTokens: 370, contextPeakTokens: 370, contextLongBeta: false });
  });

  it("context backfill fills each of the host's rows once from its transcript, without touching updated_at (R1.5)", async () => {
    const first = start();
    await first.contextBackfill;
    await first.close();
    // What a daemon without context capture left behind, and no marker yet.
    await db.execute(sql`update cc_sessions set context_tokens = null, context_model = null, context_at = null,
      context_peak_tokens = null, context_first_tokens = null, context_long_beta = false
      where session_id in (${sql.join(IDS.map((id) => sql`${id}`), sql`, `)})`);
    await db.execute(sql`delete from app_settings where key = ${MARKER}`);
    const before = await repo.getBySessionId(FIXTURE.main);
    expect(before?.contextTokens).toBeNull();

    const second = start();
    expect(await second.contextBackfill).toMatchObject({ ran: true, filled: 3, deferred: 0, failed: 0 });
    const after = await repo.getBySessionId(FIXTURE.main);
    expect(after).toMatchObject(MAIN_CONTEXT);
    expect(after?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
    expect(await repo.getSetting(MARKER)).toMatchObject({ version: CONTEXT_BACKFILL_VERSION });
    await second.close();

    expect(await start().contextBackfill).toMatchObject({ ran: false });
  });
```
(Rows of `test-host` left by other integration files point at deleted temp homes: `isUnder` fails for them, so they count as `missing`, which is why the test asserts `filled: 3` and not `rows`.)
**File:** `tests/integration/sessions.forks.int.test.ts`
**Change:** add one test inside `describe('fork ingest into cc_sessions', ...)`.
**Code:**
```ts
  it('stores each fork the context it copied until its own first message replaces it (R1.4)', async () => {
    const ingester = await ingestChain();
    await stageForks(home, FORKS.pending);
    expect((await ingester.sweep()).failed).toBe(0);
    expect(await row(FORKS.parent)).toMatchObject({ contextTokens: 440, contextModel: 'claude-haiku-4-5', contextFirstTokens: 1_160, contextPeakTokens: 2_220 });
    expect(await row(FORKS.job)).toMatchObject({ contextTokens: 77, contextModel: 'claude-opus-5-5', contextFirstTokens: 66, contextPeakTokens: 2_220 });
    expect(await row(FORKS.terminal)).toMatchObject({ contextTokens: 55, contextFirstTokens: 55, contextPeakTokens: 2_220 });
    // The fork of the terminal fork copied t1 (55) too; its own ff1 is 14.
    expect(await row(FORKS.forkOfFork)).toMatchObject({ contextTokens: 14, contextFirstTokens: 14, contextPeakTokens: 2_220 });
    expect(await row(FORKS.pending)).toMatchObject({ contextTokens: 330, contextModel: 'claude-haiku-4-5', contextAt: FORK_BOUNDARY, contextFirstTokens: null, contextPeakTokens: 2_220 });

    await appendPendingOwn(home);
    await ingester.sweep();
    expect(await row(FORKS.pending)).toMatchObject({ contextTokens: 12, contextModel: 'claude-opus-5-5', contextFirstTokens: 12, contextPeakTokens: 2_220 });
  });
```
**Impact:** tests only. All fixture numbers above were computed from the committed fixtures (see the comments).

## Principles applied

- Make illegal states unrepresentable: tokens, model and time of the snapshot travel as one `ContextSnapshot` (`latest: ContextSnapshot | null`), so no read can produce a token count without its model and time or vice versa; the four evidence fields are one `ContextEvidence` shared by the delta, the patch and the backfill fill instead of four loose optional patch fields.
- Boundary discipline: usage is validated once, in `contextTokensOf` (each counter through `count`), where the transcript is parsed; `mergeContext`, the repo and the memory store trust the typed evidence. No DB CHECK constraint was added, because a failing check would fail a save (plan invariant 2).
- Laziness protocol: the backfill reuses the existing per-file hold, `isCopiedRecord`, the app_settings marker pattern and `fileSize` / `isUnder`; `contextWindow.ts` copies `pricing.ts`'s prefix rule instead of inventing a matcher; one pure `contextColumns` serves the 0-read merge, `fillContext` and the memory store.
- Prove it works: Proof drives the real daemon from the verify-notesd harness and reads the written rows with `$V sql`, and runs inference on the values read back; the one criterion the harness cannot reach (R1.5 needs a daemon restart, which the harness has no command for) is proven against real Postgres by an integration test.
- Test behavior, not implementation: the ingest tests append real transcript lines and assert the stored row, not accumulator internals; the fork tests use the committed fork fixtures.

## Verification

**Build:** `cd /home/miftah/.worktrees/mcp-notes/session-context-rot && npm run typecheck`
**Tests:** `npm test` and `npm run test:int` (integration needs Docker; `scripts/test-int.sh` starts the containers)
**Proof:**
- Harness: `.claude/skills/verify-notesd` (`V=.claude/skills/verify-notesd/scripts/verify.sh`), run from the worktree after `npm ci`. Setup, used by every journey:
  ```sh
  cd /home/miftah/.worktrees/mcp-notes/session-context-rot
  V=.claude/skills/verify-notesd/scripts/verify.sh
  $V up --sessions                       # prints RUN=..., URL=...; set RUN from it
  CH="$HOME/.local/state/notesd-verify/$RUN/claude"; PD=projects/-home-u-mcp-notes
  M=5e55a001-0000-4000-8000-000000000001; MF="$CH/$PD/$M.jsonl"
  ctx() { $V sql $RUN "select coalesce(context_tokens::text,'-')||'|'||coalesce(context_model,'-')||'|'||coalesce(context_peak_tokens::text,'-')||'|'||coalesce(context_first_tokens::text,'-')||'|'||context_long_beta::text as ctx from cc_sessions where session_id='$1'"; }
  wait_ctx() { for i in $(seq 90); do ctx "$1" 2>/dev/null | grep -qF "$2" && { ctx "$1"; return 0; }; sleep 1; done; echo "FAIL: $1 never showed $2"; ctx "$1"; return 1; }
  infer() { ROW=$(ctx "$1" 2>/dev/null | grep -E '^ *[0-9-]+\|' | tail -1 | tr -d ' '); IFS='|' read -r T MODEL PEAK FIRST BETA <<<"$ROW"; npx tsx --eval "import('./src/sessions/contextWindow.ts').then((m) => console.log(JSON.stringify(m.contextWindowFor({ model: '$MODEL', peakTokens: ${PEAK/-/null}, longBeta: $BETA }))))"; }
  asst() { printf '{"type":"assistant","sessionId":"%s","uuid":"v-%s","timestamp":"%s","message":{"id":"%s","model":"%s","role":"assistant","content":[{"type":"text","text":"verify %s"}],"usage":{"input_tokens":%s,"cache_read_input_tokens":%s,"cache_creation_input_tokens":0,"output_tokens":%s}}}\n' "$1" "$2" "$3" "$2" "$4" "$2" "$5" "$6" "$7"; }   # session id, msg id, time, model, input, cache read, output
  ```
- Feature-map entries: none (this phase changes no user-visible behavior; Phase 4 adds the Context Rot entry to `features/projects.md`).
- Journeys:
  - **J1** · traces R1.2 — `wait_ctx $M '32021|claude-opus-5-5|50406|50406|false'`; then `$V sql $RUN "select 'in='||input_tokens from cc_sessions where session_id='$M'"` (note the value N), append one sidechain record to the main file and one to its subagent transcript, both 900,000 tokens: `{ asst $M side1 2026-11-02T03:00:00.000Z claude-haiku-5-5 1 900000 1 | sed 's/^{/{"isSidechain":true,/'; } >> "$MF"; { asst $M sub1 2026-11-02T03:00:01.000Z claude-haiku-5-5 1 900000 1 | sed 's/^{/{"isSidechain":true,/'; } >> "$CH/$PD/$M/subagents/agent-a1.jsonl"`; poll `$V sql $RUN "select 'in='||input_tokens from cc_sessions where session_id='$M'"` until it shows `in=N+1` (the subagent file was ingested), then `ctx $M` → passes when the first `wait_ctx` matched, `input_tokens` rose by exactly 1, and `ctx $M` still prints `32021|claude-opus-5-5|50406|50406|false` (900,000-token sidechain and subagent messages did not move the context or peak).
  - **J2** · traces R1.3 — `asst $M msgE 2026-11-02T03:10:00.000Z claude-opus-5-5 1 4000 10 >> "$MF"; wait_ctx $M '4011|claude-opus-5-5|50406|50406|false'` → passes when the row shows context 4011 (smaller than the stored 32021) with peak and first still 50406.
  - **J3** · traces R2.3, R2.1 — `printf '%s\n' '{"type":"api-request","sessionId":"'$M'","id":"r1","timestamp":"2026-11-02T03:20:00.000Z","querySource":"agent:builtin:Explore","params":{"model":"claude-sonnet-4-6","betas":["claude-code-20250219","context-1m-2025-08-07"]},"tail":[]}' >> "$MF"; asst $M msgH 2026-11-02T03:20:05.000Z claude-sonnet-4-6 92484 0 0 >> "$MF"; wait_ctx $M '92484|claude-sonnet-4-6|92484|50406|false'; infer $M`, then `printf '%s\n' '{"type":"api-request","sessionId":"'$M'","id":"r2","timestamp":"2026-11-02T03:21:00.000Z","querySource":"repl_main_thread","params":{"model":"claude-sonnet-4-6","betas":["claude-code-20250219","context-1m-2025-08-07"]},"tail":[]}' >> "$MF"; wait_ctx $M '92484|claude-sonnet-4-6|92484|50406|true'; infer $M` → passes when the first `infer` prints `{"window":200000,"source":"model"}` (a subagent's beta is ignored), the flag then turns `true`, and the second `infer` prints `{"window":1000000,"source":"beta"}`.
  - **J4** · traces R2.2, R2.1 — `asst $M msgF 2026-11-02T03:30:00.000Z claude-sonnet-4-6 1 249999 0 >> "$MF"; asst $M msgG 2026-11-02T03:31:00.000Z claude-sonnet-4-6 5000 0 0 >> "$MF"; wait_ctx $M '5000|claude-sonnet-4-6|250000|50406|true'; infer $M` → passes when the row keeps peak 250000 after the context fell to 5000 and `infer` prints `{"window":1000000,"source":"peak"}` (peak outranks the beta in the rule order).
  - **J5** · traces R2.4, R2.1 — `W=5e55a001-0000-4000-8000-000000000002; asst $W glm1 2026-10-30T09:00:00.000Z glm-5.3 6335 0 0 >> "$CH/projects/-home-u--worktrees-mcp-notes-wall-editing/$W.jsonl"; wait_ctx $W '6335|glm-5.3|6335|370|false'; infer $W; npx vitest run tests/unit/sessions/contextWindow.test.ts` → passes when `infer` prints `{"window":200000,"source":"default"}` and the vitest file reports all tests passed.
  - **J6** · traces R1.4 — `FX=tests/fixtures/claude-home-forks; P=f0a0a001-0000-4000-8000-000000000001; PEND=f0f0f001-0000-4000-8000-000000000005; cp "$FX/$PD/$P.jsonl" "$CH/$PD/" && wait_ctx $P '440|claude-haiku-4-5|2220|1160|false' && cp -r "$FX/jobs" "$CH/" && cp "$FX/$PD/$PEND.jsonl" "$CH/$PD/" && wait_ctx $PEND '330|claude-haiku-4-5|2220|-|false'; $V sql $RUN "select parent_session_id, fork_detected_by, input_tokens from cc_sessions where session_id='$PEND'"; cat "$FX/appends/$PEND.own.jsonl" >> "$CH/$PD/$PEND.jsonl"; wait_ctx $PEND '12|claude-opus-5-5|2220|12|false'` → passes when the pending fork (linked to `f0a0…`, `job`, 0 input tokens) first shows its last copied message's context 330 with no first-message context, then 12 / first 12 after its own message.
  - **J7** · traces R1.5 — `for i in $(seq 60); do $V sql $RUN "select value->>'version' as v, value->>'filled' as filled from app_settings where key like 'sessions.context_backfill.%'" | grep -qE '^ *1 \|' && break; sleep 1; done; $V sql $RUN "select key, value from app_settings where key like 'sessions.context_backfill.%'"` and `npm run test:int -- tests/integration/sessions.ingest.int.test.ts -t "context backfill"` → passes when the marker row exists with `"version": 1` on the throwaway daemon, and the integration test (rows nulled to their pre-0016 state, marker deleted, a new ingester started against Postgres) passes: all three rows refilled, `updated_at` unchanged, marker written, and a third start reports `ran: false`.
- Neighbor check: cumulative tokens and fork ingest are what this phase edits next to. `$V sql $RUN "select session_id, input_tokens, output_tokens, parent_link_source from cc_sessions where session_id in ('$P','$PEND')"` → passes when the parent shows `1000 | 100 | (null)` and the pending fork `11 | 1 | fork`, the same values `features/projects.md` "Forks at ingest" lists; and `$V api $RUN GET /api/projects/mcp-notes/sessions` answers 200 with the fixture nodes. Then `$V down $RUN`.
- Cost: none (no LLM calls; the harness runs with embeddings off).
**Exit criteria:** `npm run typecheck`, `npm test` and `npm run test:int` pass; J1–J7 and the neighbor check pass on a throwaway daemon built from this worktree; `drizzle/0016_session_context.sql` holds exactly the six `ADD COLUMN` statements.

## Handoffs

- Phase 2 (R3): `SessionInfo.context` should read the six columns and call `contextWindowFor({ model: contextModel, peakTokens: contextPeakTokens, longBeta: contextLongBeta })`, then `contextPercent(contextTokens, window)` and `contextBand(percent)`; `window_source` is `ContextWindowSource`. `contextTokens === null` means unknown (R1.7). Note for its `onBatch` observer: the batch's `records` never contain `api-request` lines (parseRecord drops them), so a write whose only change is `context_long_beta` turning true carries no assistant record; if the stream must reflect a window change from the beta alone, compare the stored row instead of inspecting records. Backfill writes (`fillContext`) notify no observer.
- Phase 3 (R4): for the repo baseline (median `context_first_tokens` of the latest 20 sessions), exclude forks (`fork_detected_by is not null`): a fork's first own message already holds the copied history, so its `context_first_tokens` is not a start-up cost. Use `contextWindowFor` for the target window.
- Phase 4 (R1, docs): README / `features/projects.md` can say the context backfill runs once per host (`sessions.context_backfill.<host>` in app_settings) and that the window is inferred, with `window_source`. CLAUDE.md's Claude Code sessions paragraph could gain one sentence on the context columns and `contextWindow.ts`; not assigned to any phase, left for the reconciler.
- Known limitation (no phase needed): `context_long_beta` is an OR over the whole session, so a session that used a 1M Sonnet 4.6 stretch and later switched to Haiku 4.5 still infers 1M from the beta.

## Rollback

`git revert` this phase's commit(s). The migration only adds nullable / defaulted columns, so the
reverted code ignores them; drop them with a follow-up migration if wanted. Optionally
`delete from app_settings where key like 'sessions.context_backfill.%'` (harmless if left). No other
phase can land without this one (phases 2 and 3 import `contextWindow.ts` and read the columns), so
revert them first.
