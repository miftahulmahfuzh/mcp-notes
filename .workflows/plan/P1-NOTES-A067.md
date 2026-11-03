> Adopted from `/home/miftah/.worktrees/mcp-notes/node-panel-summarize-prompts/docs/plans/NODE_PANEL_SUMMARIZE_PROMPTS_PLAN.md` phase 3. Source: `.workflows/plan/node-panel-summarize-prompts/phase-3.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 3: Full redacted prompts: ingest into cc_session_prompts + per-host backfill

**Plan set:** `NODE_PANEL_SUMMARIZE_PROMPTS_PLAN.md`
**Analysis:** `docs/analyzer/20261103-150033-K7Q2_code_analyzer.md`
**Satisfies:** R2. Every typed prompt is stored in full and redacted, so the Phase 5 modal has something to show.
**Depends on:** Phase 1 (schema 0010: `cc_session_prompts`, `cc_sessions.prompts_version`)
**Difficulty:** HARD
**Package:** `src/sessions`

---

## Goal

After this phase, ingest keeps every human prompt of a session of this host. Each one is cut only at a 256 KB ceiling (and flagged `truncated` when cut), passed through `redactSecrets`, and written to `cc_session_prompts` in the same transaction and under the same row lock as the `cc_sessions` update. The bounded excerpt list (`cc_sessions.prompts`, newest 100, each ≤ 2000 chars), `first_prompt` and `last_prompt` are redacted too. Once the startup ingest pass ends, a one-time, idempotent backfill runs per host. It re-reads this host's transcripts for rows below `PROMPTS_VERSION` (2) and replaces only their prompt columns (version 2: full + redacted). A row whose transcript is gone gets its stored excerpts redacted in place and is marked `PROMPTS_VERSION_EXCERPTS` (1): no unredacted text is left, but the full text is unrecoverable, so Phase 5 reports it as incomplete. Such a row stays a candidate; later starts skip it cheaply while the transcript is still missing, and upgrade it to 2 if the transcript is readable again. No other column changes, and other hosts' rows are left alone.

## Interface Contract

**Deletes:** the per-read prompt count cap in `TranscriptAccumulator` (`transcript.ts:515` `slice(-MAX_PROMPTS)` and `:459` `prompts.slice(-MAX_PROMPTS)`); the `MAX_PROMPT_CHARS` cut of prompts and `last-prompt` in `transcript.ts:425,512`. `MAX_PROMPTS` / `MAX_PROMPT_CHARS` stay in `types.ts` (they now mean "the excerpt list").

**Renames:** none.

**Creates:**
- `src/sessions/types.ts`: `MAX_PROMPT_STORE_CHARS = 256 * 1024`, `PROMPTS_VERSION_EXCERPTS = 1`, `PROMPTS_VERSION = 2`, `interface PatchPrompt { text; at; truncated? }`, `interface StoredPrompt { text; at: Date | null; truncated }`, `interface PromptsBackfillCandidate { sessionId; transcriptPath: string | null; transcriptOffset }`, `interface PromptsReplacement { upToOffset; prompts: PatchPrompt[]; firstPrompt; lastPrompt }`, `type ReplacePromptsResult = {status:'applied'} | {status:'offset_mismatch'; storedOffset} | {status:'other_host'} | {status:'missing'}`, `type RedactStoredPromptsResult = 'applied' | 'current' | 'other_host' | 'missing'`.
- `src/sessions/transcript.ts`: `storeCut(text)`; `ReadJsonlOptions.until`.
- `src/sessions/merge.ts`: `promptExcerpt`, `storedPrompts`, `storedPromptsFromExcerpts`, `replacedPromptColumns`, `redactedPromptColumns`, `type PromptColumns`.
- `src/sessions/repo.ts`: `SessionsRepo.promptsBackfillCandidates(host)`, `SessionsRepo.replacePrompts(sessionId, host, input)`, `SessionsRepo.redactStoredPrompts(sessionId, host)`; private `lockIfExists`, `writePromptRows`; module `promptBatches`, `PROMPT_INSERT_ROWS`, `PROMPT_INSERT_CHARS`.
- `src/sessions/ingest.ts`: `SessionIngester.promptsBackfill: Promise<PromptsBackfillReport>`, `interface PromptsBackfillReport`, `formatPromptsReport`; private `holdFile`, `withFileHeld`, `backfillSession`, `backfillPrompts`.
- `tests/fixtures/make-many-prompts-fixture.mjs` (generator), `tests/fixtures/claude-home/projects/-home-u-mcp-notes/5e55a001-0000-4000-8000-000000000005.jsonl` (generated, committed).
- `tests/helpers/claudeHome.ts`: `FIXTURE.manyPrompts`, `FIXTURE.manyPromptsFile`, `MANY_PROMPTS`, `manyPromptsText(n)`.
- `tests/integration/sessions.prompts.int.test.ts`.

**Signature changes:**
- `TranscriptPatch.prompts?: SessionPrompt[]` -> `prompts?: PatchPrompt[]` (`PatchPrompt` is assignable from `SessionPrompt`, so every existing caller still compiles).
- `TranscriptDelta.prompts: SessionPrompt[]` -> `PatchPrompt[]` (every entry has `truncated` set).
- `IngestStore` gains the optional `promptsBackfillCandidates | replacePrompts | redactStoredPrompts` picks.
- `SessionIngester` gains the required `promptsBackfill` (only `startSessionIngest` implements it).
- `SessionsRepo.upsertFromTranscript` behavior: it also writes `cc_session_prompts`, and sets `prompts_version = PROMPTS_VERSION` (2) only on a `fromOffset 0` write.
- `SessionsRepo.redactStoredPrompts` sets `prompts_version = PROMPTS_VERSION_EXCERPTS` (1), never 2, and answers `'current'` without writing for a row already at 1 or above.

**Requires (from earlier phases):** Phase 1:
- `ccSessionPrompts` drizzle table exported from `src/db/schema.ts`, shaped like this:
  ```ts
  export const ccSessionPrompts = pgTable('cc_session_prompts', {
    sessionId: text('session_id').notNull().references(() => ccSessions.sessionId, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    at: timestamp('at', { withTimezone: true, mode: 'date' }),
    text: text('text').notNull(),
    truncated: boolean('truncated').notNull().default(false),
  }, (t) => [primaryKey({ columns: [t.sessionId, t.seq] })])
  ```
- `ccSessions.promptsVersion: integer('prompts_version').notNull().default(0)` and `summaryRequestedAt`, so `SessionRow` has `promptsVersion: number` and `summaryRequestedAt: Date | null`.
- `blankSessionRow` (`tests/helpers/memoryIngestStore.ts`) and `blankRow` (`tests/unit/sessions/merge.test.ts`) already set `promptsVersion: 0, summaryRequestedAt: null`. The tree does not typecheck after Phase 1 without that.
- `truncateAll` truncates `cc_sessions ... cascade`, which already empties `cc_session_prompts` through the FK.

**Leaves alone (owned by others):** `src/db/schema.ts`, `drizzle/*` (Phase 1); `requestSummary` / `clearSummaryRequest` / `setSummary` in `repo.ts` (Phase 1); `src/sessions/summaryWorker.ts`, `readModel.ts`, `view.ts`, `src/http/*` (Phases 2 and 5); `web/*` (Phases 4 and 5); `src/sessions/summarize.ts` caps; `.claude/skills/verify-notesd/features/projects.md` (Phases 4 and 5, see Handoffs).

**Semantics Phase 5 relies on:**
- `seq` starts at 1 and has no gaps in a session. A replace writes 1..n, and an append continues from `max(seq)+1`.
- `prompts_version` has three values:
  - `PROMPTS_VERSION` (2): the side table is complete (every prompt, full, redacted). `truncated = true` means the prompt was cut at `MAX_PROMPT_STORE_CHARS`, with no ellipsis added.
  - `PROMPTS_VERSION_EXCERPTS` (1): the transcript was gone when the backfill reached the row. The side rows are the ≤100 stored excerpts, redacted in place, and `truncated` means that excerpt ended in `…`. Older prompts and the full text are lost: never report this row as complete.
  - `0`: legacy. The side table may hold a partial list (appends since the upgrade) that must not be shown; show the `cc_sessions.prompts` excerpts instead.

## Files

| File | Action | What changes |
|---|---|---|
| `src/sessions/types.ts` | modify | new constants and types (after L68, after L128), `TranscriptPatch.prompts` type (L120-121). Line numbers are as Phase 1 leaves the file (its re-export block at L10 adds 7 lines) |
| `src/sessions/transcript.ts` | modify | imports (L2-15), `storeCut` (after L180), `readJsonlFrom` `until` (L207-273), `TranscriptDelta.prompts` (L130-132), accumulator: no cap, ceiling + `truncated` (L376, L423-427, L459, L507-519) |
| `src/sessions/merge.ts` | modify | redact-then-clip excerpts; new pure helpers for the side table and the backfill (whole file below) |
| `src/sessions/repo.ts` | modify | imports (L5, L11-45), batching helpers (after L96), `lockIfExists` + `writePromptRows` (after L207), `upsertFromTranscript` (L211-241), three new methods (after L255). Line numbers are as Phase 1 leaves the file (+1 import line, +1 class-comment line); Phase 1's `setSummary` / `requestSummary` / `clearSummaryRequest` region is not touched |
| `src/sessions/ingest.ts` | modify | header doc (L19-52), `IngestStore` (L71-72), report types (after L114), `SessionIngester` (L148-159), `holdFile`/`runFile` (L487-504), backfill (after L504), `promptsBackfill` wiring (after L604), `idle`/`close` (L629-657), `formatPromptsReport` (after L665) |
| `tests/fixtures/make-many-prompts-fixture.mjs` | create | generator for the fixture |
| `tests/fixtures/claude-home/projects/-home-u-mcp-notes/5e55a001-0000-4000-8000-000000000005.jsonl` | create | generated: 106 prompts, #50 is >2000 chars, multi-line and indented, #60 holds a fake key |
| `tests/helpers/claudeHome.ts` | modify | `FIXTURE.manyPrompts(File)`, `MANY_PROMPTS`, `manyPromptsText` |
| `tests/helpers/memoryIngestStore.ts` | modify | side prompts + version on upsert; the three backfill methods (imports L1-11 and class body L70-end as Phase 1 leaves the file; `blankSessionRow` already carries Phase 1's two fields and is not touched) |
| `tests/unit/sessions/transcript.test.ts` | modify | L93 expects `truncated: false`; L176-182 no-cap test; ceiling test; `until` test |
| `tests/unit/sessions/merge.test.ts` | modify | redaction tests (append a `describe`) |
| `tests/unit/sessions/ingest.test.ts` | modify | fixture counts (L104-105, L140-141, L160, L168, L350-352); new `prompts backfill` describe |
| `tests/integration/sessions.ingest.int.test.ts` | modify | `IDS` (L20) gets the new fixture; `upserted: 3` -> `4` (L80) |
| `tests/integration/sessions.prompts.int.test.ts` | create | side table, append seq, replace, version rule, CAS, backfill (idempotent, other columns frozen, other host untouched, missing transcript) |

`src/background.ts` needs no change: it passes the `SessionsRepo` itself as the ingest store (`background.ts:95`), so the three new methods are picked up as they are.

## Implementation Steps

### Step 1: Types and constants
**File:** `src/sessions/types.ts:67-68` (constants), `:120-121` (`TranscriptPatch.prompts`), after `:128` (new types). Line numbers as Phase 1 leaves the file (Phase 1 turned the one-line re-export at L10 into an 8-line block and added `SummaryRequest` after `SummaryInput`, far below; neither touches these lines).
**Change:** Document the two existing caps as the excerpt list. Add the storage ceiling, the two version markers and the prompt types.
**Code:** replace L67-68 (`export const MAX_PROMPTS = 100;` / `export const MAX_PROMPT_CHARS = 2000;`) with:
```ts
/** `cc_sessions.prompts` is the excerpt list: the newest MAX_PROMPTS prompts, each clipped to MAX_PROMPT_CHARS (redacted first). */
export const MAX_PROMPTS = 100;
export const MAX_PROMPT_CHARS = 2000;
/**
 * Ceiling on one stored prompt (`cc_session_prompts.text`, UTF-16 code units). A longer prompt is cut
 * here and stored with `truncated = true`. Measured 2026-11-03: the largest typed prompt was 46 KB.
 */
export const MAX_PROMPT_STORE_CHARS = 256 * 1024;
/**
 * `cc_sessions.prompts_version` of a row whose transcript was gone when the prompts backfill
 * reached it: the stored excerpts, first and last prompt were redacted in place and
 * `cc_session_prompts` was rebuilt from those excerpts (≤ MAX_PROMPTS, each ≤ MAX_PROMPT_CHARS).
 * Nothing unredacted is left, but the full text is unrecoverable: never report such a row as
 * complete. Still a backfill candidate (below PROMPTS_VERSION): upgraded if the transcript is
 * readable again, otherwise skipped without a write.
 */
export const PROMPTS_VERSION_EXCERPTS = 1;
/**
 * `cc_sessions.prompts_version` of a row whose prompts are stored in full and redacted
 * (`cc_session_prompts` holds every prompt; the excerpts, first and last prompt are redacted).
 * 0 = written before that: truncated, unredacted excerpts only. The owning host's ingester brings
 * such rows up once (`SessionsRepo.replacePrompts`, or `redactStoredPrompts` to
 * PROMPTS_VERSION_EXCERPTS when the transcript is gone).
 */
export const PROMPTS_VERSION = 2;
```
Replace L120-121 (inside `TranscriptPatch`, the `prompts?: SessionPrompt[]` field and its comment) with:
```ts
  /**
   * Every human prompt of the read, full text (cut only at MAX_PROMPT_STORE_CHARS), not yet
   * redacted: SessionsRepo redacts before writing. Appended to `cc_session_prompts` (replacing it on
   * fromOffset 0); the excerpt list keeps the newest MAX_PROMPTS, each clipped to MAX_PROMPT_CHARS.
   */
  prompts?: PatchPrompt[];
```
Insert after the closing `}` of `TranscriptPatch` (after L128):
```ts
/** One human prompt as ingest read it. `truncated`: cut at MAX_PROMPT_STORE_CHARS (absent = false). */
export interface PatchPrompt {
  text: string;
  at: string | null;
  truncated?: boolean;
}

/** One `cc_session_prompts` row's content, redacted, as SessionsRepo writes it. */
export interface StoredPrompt {
  text: string;
  at: Date | null;
  truncated: boolean;
}

/** A row of this host below PROMPTS_VERSION (legacy, or redacted in place from excerpts). */
export interface PromptsBackfillCandidate {
  sessionId: string;
  transcriptPath: string | null;
  transcriptOffset: number;
}

/** The prompts of a transcript re-read from byte 0 up to `upToOffset` (the row's stored offset). */
export interface PromptsReplacement {
  /** Must equal the stored transcript_offset when the write happens (compare-and-set). */
  upToOffset: number;
  prompts: PatchPrompt[];
  /** First human prompt of the file; null keeps the stored one (redacted). */
  firstPrompt: string | null;
  /** Latest `last-prompt` record of the file; null keeps the stored one (redacted). */
  lastPrompt: string | null;
}

export type ReplacePromptsResult =
  | { status: 'applied' }
  | { status: 'offset_mismatch'; storedOffset: number }
  | { status: 'other_host' }
  | { status: 'missing' };

/** `current`: the row was already at PROMPTS_VERSION_EXCERPTS or above, nothing written. */
export type RedactStoredPromptsResult = 'applied' | 'current' | 'other_host' | 'missing';
```
**Impact:** Type-only. `SessionPrompt[]` still assigns to `PatchPrompt[]`, so existing tests that build patches still compile.

### Step 2: Accumulator keeps every prompt, cut only at the ceiling; `readJsonlFrom` can stop at an offset
**File:** `src/sessions/transcript.ts`
**Change (a), L2-15 imports:** `MAX_PROMPT_CHARS`, `MAX_PROMPTS` and `SessionPrompt` are no longer used here.
```ts
import {
  MAX_COMMITS,
  MAX_FILES_EDITED,
  MAX_FINAL_MESSAGE_CHARS,
  MAX_PLAN_DOCS,
  MAX_PROMPT_STORE_CHARS,
  MAX_TITLE_CHARS,
  type ModelUsage,
  type PatchPrompt,
  type SessionCommit,
  type TokenCounts,
  type TranscriptPatch,
} from './types.js';
```
**Change (b), insert after `cut` (after L180):**
```ts
/**
 * A prompt cut to the storage ceiling (MAX_PROMPT_STORE_CHARS), never through a surrogate pair.
 * No ellipsis is added: `truncated` records the cut.
 */
export function storeCut(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_PROMPT_STORE_CHARS) return { text, truncated: false };
  let end = MAX_PROMPT_STORE_CHARS;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}
```
**Change (c), L207-273:** `ReadJsonlOptions` and `readJsonlFrom` replaced whole:
```ts
export interface ReadJsonlOptions {
  /** Bytes per read() call. Default DEFAULT_READ_CHUNK_BYTES (1 MiB). Lines may be longer. */
  chunkBytes?: number;
  /** Checked before every chunk; true stops the read (the result still covers the lines read). */
  shouldStop?: () => boolean;
  /**
   * Read no further than this byte offset (a line boundary, e.g. a stored transcript_offset).
   * Default: the file size when opened.
   */
  until?: number;
}

export interface ReadJsonlResult {
  /** Byte offset just past the last complete line read: where the next read starts. */
  endOffset: number;
  /** File size when the read began. Bytes appended after that are left for the next read. */
  size: number;
  /** Complete lines handed to `onLine`. */
  lines: number;
  /** True when `shouldStop` cut the read short. */
  stopped: boolean;
}

/**
 * Streams the complete lines of `file` from byte `start` to the size it had when opened (or to
 * `options.until`, if smaller), in fixed chunks (memory stays O(chunk + longest line), whatever the
 * file size). A trailing line without its `\n` is still being written: it is not handed out and
 * `endOffset` stops before it.
 */
export async function readJsonlFrom(
  file: string,
  start: number,
  onLine: (line: string) => void,
  options: ReadJsonlOptions = {},
): Promise<ReadJsonlResult> {
  const chunkBytes = options.chunkBytes ?? DEFAULT_READ_CHUNK_BYTES;
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const end = options.until === undefined ? size : Math.min(size, Math.max(0, options.until));
    let endOffset = Math.min(Math.max(start, 0), end);
    let position = endOffset;
    let lines = 0;
    let stopped = false;
    const pending: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(chunkBytes);
    while (position < end) {
      if (options.shouldStop?.() === true) {
        stopped = true;
        break;
      }
      const { bytesRead } = await handle.read(buffer, 0, Math.min(chunkBytes, end - position), position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      let from = 0;
      for (;;) {
        const newline = chunk.indexOf(0x0a, from);
        if (newline === -1) break;
        const piece = chunk.subarray(from, newline);
        const line = pending.length > 0 ? Buffer.concat([...pending, piece]) : piece;
        pending.length = 0;
        onLine(line.toString('utf8'));
        lines += 1;
        endOffset = position + newline + 1;
        from = newline + 1;
      }
      if (from < bytesRead) pending.push(Buffer.from(chunk.subarray(from)));
      position += bytesRead;
    }
    return { endOffset, size, lines, stopped };
  } finally {
    await handle.close();
  }
}
```
**Change (d), `TranscriptDelta` L129-132:**
```ts
  /** First human prompt of this read (cut only at MAX_PROMPT_STORE_CHARS). */
  firstPrompt: string | null;
  /** Every human prompt of this read, oldest first, each cut only at MAX_PROMPT_STORE_CHARS. No count cap. */
  prompts: PatchPrompt[];
```
and in the same interface (L126) the `lastPrompt` field stays `string | null`, now cut only at the ceiling.
**Change (e), accumulator field L376:**
```ts
  private prompts: PatchPrompt[] = [];
```
**Change (f), `last-prompt` case L423-427:**
```ts
      case 'last-prompt': {
        const text = nonEmpty(record.lastPrompt);
        if (text !== null) this.lastPrompt = storeCut(text).text;
        return;
      }
```
**Change (g), `delta()` L459:**
```ts
      prompts: [...this.prompts],
```
**Change (h), `addUser` L507-528, replaced whole:**
```ts
  private addUser(record: TranscriptRecord): void {
    const at = typeof record.timestamp === 'string' ? record.timestamp : null;
    if (isHumanPrompt(record)) {
      const text = promptText(record);
      if (text !== '' && !INTERRUPTED.test(text) && !BARE_COMMAND.test(text)) {
        const stored = storeCut(text);
        this.firstPrompt ??= stored.text;
        this.prompts.push({ text: stored.text, at, truncated: stored.truncated });
        this.segment = [];
      }
      return;
    }
    const message = record.message;
    const content = isObject(message) ? message.content : undefined;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!isObject(block) || block.type !== 'tool_result') continue;
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : null;
      this.scanCommit(id, toolResultText(block.content), record.toolUseResult, at, nonEmpty(record.cwd));
    }
  }
```
`buildTranscriptPatch` (L615-645) is unchanged: `prompts: delta.prompts` now carries `PatchPrompt[]`.
**Impact:** Memory per read grows from ≤200 clipped prompts to all prompts of the read. A whole-file read of the largest local session is a few MB, and reads run 4 files at a time. The excerpt clip moves to `merge.ts` (Step 3), so the stored excerpt values stay the same apart from redaction.

### Step 3: merge.ts: redact then clip the excerpts; pure helpers for side rows and the backfill
**File:** `src/sessions/merge.ts` (whole file; unchanged functions are repeated so the file is complete)
**Code:**
```ts
import type { ModelUsage, SessionCommit, SessionPrompt } from '../db/schema.js';
import { redactSecrets } from './redact.js';
import {
  MAX_COMMITS,
  MAX_FILES_EDITED,
  MAX_FINAL_MESSAGE_CHARS,
  MAX_PLAN_DOCS,
  MAX_PROMPT_CHARS,
  MAX_PROMPTS,
  MAX_TITLE_CHARS,
  type PatchPrompt,
  type PromptsReplacement,
  type SessionRow,
  type StoredPrompt,
  type SubagentTotals,
  type TranscriptPatch,
  type TranscriptSet,
} from './types.js';

/** `value` cut to at most `max` characters, the last one an ellipsis when cut. */
export function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function clipOrKeep(value: string | null | undefined, max: number): string | null | undefined {
  return value === null || value === undefined ? value : clip(value, max);
}

/**
 * A prompt as `cc_sessions` keeps it (the excerpt list, first_prompt, last_prompt): redacted, then
 * clipped to MAX_PROMPT_CHARS. Redacting first means a clip can never leave behind the head of a
 * secret that is too short to match a pattern any more.
 */
export function promptExcerpt(text: string): string {
  return clip(redactSecrets(text), MAX_PROMPT_CHARS);
}

function excerptOrKeep(value: string | null | undefined): string | null | undefined {
  return value === null || value === undefined ? value : promptExcerpt(value);
}

/**
 * A stored prompt text written back. redactSecrets is idempotent: text stored redacted comes back
 * unchanged, text stored before redaction existed comes back redacted.
 */
function redactStored(value: string | null): string | null {
  return value === null ? null : redactSecrets(value);
}

function parseAt(at: string | null | undefined): Date | null {
  if (at === null || at === undefined) return null;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** The earlier of two times; a missing one never wins. */
export function earliest(a: Date | null, b: Date | null | undefined): Date | null {
  if (!b) return a;
  if (!a) return b;
  return b.getTime() < a.getTime() ? b : a;
}

/** The later of two times; a missing one never wins. */
export function latest(a: Date | null, b: Date | null | undefined): Date | null {
  if (!b) return a;
  if (!a) return b;
  return b.getTime() > a.getTime() ? b : a;
}

/** A path without trailing slashes (`/` stays `/`), trimmed. Used for spawn matching. */
export function normalizeCwd(cwd: string): string {
  const t = cwd.trim();
  if (t.length <= 1) return t;
  const stripped = t.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

function count(n: number | undefined): number {
  return n !== undefined && Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

export function mergeModels(
  prev: Record<string, ModelUsage>,
  delta: Record<string, Partial<ModelUsage>> | undefined,
  reset: boolean,
): Record<string, ModelUsage> {
  const out: Record<string, ModelUsage> = reset ? {} : { ...prev };
  for (const [model, d] of Object.entries(delta ?? {})) {
    const base = out[model] ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    out[model] = {
      inputTokens: base.inputTokens + count(d.inputTokens),
      outputTokens: base.outputTokens + count(d.outputTokens),
      cacheReadTokens: base.cacheReadTokens + count(d.cacheReadTokens),
      cacheWriteTokens: base.cacheWriteTokens + count(d.cacheWriteTokens),
    };
  }
  return out;
}

/** `prev` minus `take`, per model and counter, never below zero; models left at all zeros are dropped. */
export function subtractModels(prev: Record<string, ModelUsage>, take: Record<string, ModelUsage>): Record<string, ModelUsage> {
  const out: Record<string, ModelUsage> = { ...prev };
  for (const [model, t] of Object.entries(take)) {
    const base = out[model];
    if (base === undefined) continue;
    const left = {
      inputTokens: Math.max(0, base.inputTokens - count(t.inputTokens)),
      outputTokens: Math.max(0, base.outputTokens - count(t.outputTokens)),
      cacheReadTokens: Math.max(0, base.cacheReadTokens - count(t.cacheReadTokens)),
      cacheWriteTokens: Math.max(0, base.cacheWriteTokens - count(t.cacheWriteTokens)),
    };
    if (left.inputTokens + left.outputTokens + left.cacheReadTokens + left.cacheWriteTokens === 0) delete out[model];
    else out[model] = left;
  }
  return out;
}

/**
 * The excerpt list: the stored excerpts (written back redacted, a no-op for redacted text) then the
 * new prompts as excerpts, keeping the newest MAX_PROMPTS. Blank prompts are dropped.
 */
function mergePrompts(prev: SessionPrompt[], next: readonly PatchPrompt[] | undefined, reset: boolean): SessionPrompt[] {
  const incoming = (next ?? [])
    .filter((p) => p.text.trim().length > 0)
    .map((p) => ({ text: promptExcerpt(p.text), at: p.at ?? null }));
  const kept = reset ? [] : prev.map((p) => ({ text: redactSecrets(p.text), at: p.at ?? null }));
  const all = [...kept, ...incoming];
  return all.length > MAX_PROMPTS ? all.slice(all.length - MAX_PROMPTS) : all;
}

/**
 * `cc_session_prompts` rows for `prompts`, in order: the full text as ingest cut it, redacted.
 * Blank prompts are dropped (the same rule as the excerpt list).
 */
export function storedPrompts(prompts: readonly PatchPrompt[] | undefined): StoredPrompt[] {
  return (prompts ?? [])
    .filter((p) => p.text.trim().length > 0)
    .map((p) => ({ text: redactSecrets(p.text), at: parseAt(p.at), truncated: p.truncated === true }));
}

/**
 * `cc_session_prompts` rows rebuilt from a row's stored excerpts, for a session whose transcript is
 * gone: each excerpt redacted, `truncated` where the excerpt was clipped (it ends in `…`).
 */
export function storedPromptsFromExcerpts(excerpts: readonly SessionPrompt[]): StoredPrompt[] {
  return excerpts
    .filter((p) => p.text.trim().length > 0)
    .map((p) => {
      const text = redactSecrets(p.text);
      return { text, at: parseAt(p.at), truncated: text.endsWith('…') };
    });
}

/** The three `cc_sessions` columns that hold prompt text. */
export type PromptColumns = Pick<SessionRow, 'prompts' | 'firstPrompt' | 'lastPrompt'>;

/**
 * The prompt columns after a transcript was re-read from byte 0 (the prompts backfill). A first or
 * last prompt the re-read did not find keeps the stored one, redacted.
 */
export function replacedPromptColumns(
  row: PromptColumns,
  input: Pick<PromptsReplacement, 'prompts' | 'firstPrompt' | 'lastPrompt'>,
): PromptColumns {
  return {
    prompts: mergePrompts([], input.prompts, true),
    firstPrompt: input.firstPrompt === null ? redactStored(row.firstPrompt) : promptExcerpt(input.firstPrompt),
    lastPrompt: input.lastPrompt === null ? redactStored(row.lastPrompt) : promptExcerpt(input.lastPrompt),
  };
}

/** The prompt columns of a row whose transcript is gone: what is stored, redacted in place. */
export function redactedPromptColumns(row: PromptColumns): PromptColumns {
  return {
    prompts: row.prompts.map((p) => ({ text: redactSecrets(p.text), at: p.at ?? null })),
    firstPrompt: redactStored(row.firstPrompt),
    lastPrompt: redactStored(row.lastPrompt),
  };
}

/**
 * Union by sha, capped to the newest MAX_COMMITS. When every commit has a time they are put in time
 * order (a session's and its subagents' commits interleave); otherwise first-seen order stays.
 */
export function mergeCommits(prev: SessionCommit[], next: SessionCommit[] | undefined, reset: boolean): SessionCommit[] {
  const bySha = new Map<string, SessionCommit>();
  for (const c of [...(reset ? [] : prev), ...(next ?? [])]) {
    if (c.sha.length === 0 || bySha.has(c.sha)) continue;
    bySha.set(c.sha, { sha: c.sha, subject: clip(c.subject, MAX_TITLE_CHARS), at: c.at ?? null });
  }
  const all = [...bySha.values()];
  if (all.every((c) => c.at !== null)) all.sort((a, b) => Date.parse(a.at ?? '') - Date.parse(b.at ?? ''));
  return all.length > MAX_COMMITS ? all.slice(all.length - MAX_COMMITS) : all;
}

function unionStrings(prev: string[], next: string[] | undefined, reset: boolean, max: number): string[] {
  const out = new Set<string>(reset ? [] : prev);
  for (const s of next ?? []) {
    if (out.size >= max) break;
    if (s.length > 0) out.add(s);
  }
  return [...out].slice(0, max);
}

/**
 * The column values `row` takes after applying `patch`. Pure; the caller (SessionsRepo) has
 * already checked the offset precondition. See TranscriptPatch for the rules. A re-read from byte 0
 * replaces tokens, models and commits, starting from `subagents` (the session's subagent share,
 * which lives in other files) instead of from zero. Every prompt text written (excerpts, first and
 * last prompt) is redacted, so a row written before redaction existed is cleaned on its next write.
 */
export function mergeTranscriptPatch(row: SessionRow, patch: TranscriptPatch, subagents: SubagentTotals | null = null): TranscriptSet {
  const reset = patch.fromOffset === 0;
  if (reset && subagents !== null) {
    const t = subagents.tokens;
    row = {
      ...row,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      cacheReadTokens: t.cacheReadTokens,
      cacheWriteTokens: t.cacheWriteTokens,
      models: subagents.models,
      commits: subagents.commits,
    };
  }
  const keep = reset && subagents !== null;
  const tokens = patch.tokens ?? {};
  const firstPrompt = excerptOrKeep(patch.firstPrompt);
  const storedFirst = redactStored(row.firstPrompt);
  return {
    repo: patch.repo ?? row.repo,
    cwd: patch.cwd ?? row.cwd,
    branch: patch.branch ?? row.branch,
    name: clipOrKeep(patch.name, MAX_TITLE_CHARS) ?? row.name,
    customTitle: clipOrKeep(patch.customTitle, MAX_TITLE_CHARS) ?? row.customTitle,
    aiTitle: clipOrKeep(patch.aiTitle, MAX_TITLE_CHARS) ?? row.aiTitle,
    firstPrompt: reset ? (firstPrompt ?? storedFirst) : (storedFirst ?? firstPrompt ?? null),
    lastPrompt: excerptOrKeep(patch.lastPrompt) ?? redactStored(row.lastPrompt),
    entrypoint: patch.entrypoint ?? row.entrypoint,
    version: patch.version ?? row.version,
    finalMessage: clipOrKeep(patch.finalMessage, MAX_FINAL_MESSAGE_CHARS) ?? row.finalMessage,
    startedAt: earliest(row.startedAt, patch.startedAt),
    lastActiveAt: latest(row.lastActiveAt, patch.lastActiveAt),
    inputTokens: (reset && !keep ? 0 : row.inputTokens) + count(tokens.inputTokens),
    outputTokens: (reset && !keep ? 0 : row.outputTokens) + count(tokens.outputTokens),
    cacheReadTokens: (reset && !keep ? 0 : row.cacheReadTokens) + count(tokens.cacheReadTokens),
    cacheWriteTokens: (reset && !keep ? 0 : row.cacheWriteTokens) + count(tokens.cacheWriteTokens),
    costUsd:
      patch.costUsd !== undefined && patch.costUsd !== null && Number.isFinite(patch.costUsd)
        ? patch.costUsd
        : row.costUsd,
    models: mergeModels(row.models, patch.models, reset && !keep),
    prompts: mergePrompts(row.prompts, patch.prompts, reset),
    commits: mergeCommits(row.commits, patch.commits, reset && !keep),
    filesEdited: unionStrings(row.filesEdited, patch.filesEdited, reset, MAX_FILES_EDITED),
    planDocs: unionStrings(row.planDocs, patch.planDocs, reset, MAX_PLAN_DOCS),
    transcriptPath: patch.transcriptPath,
    transcriptOffset: patch.toOffset,
    transcriptSize: patch.size,
  };
}
```
**Impact:** Invariant 4 for `cc_sessions`. Every write of `prompts[].text`, `first_prompt` and `last_prompt` goes through `redactSecrets`. Appends to a legacy row clean its excerpts as a side effect, and that row's `prompts_version` stays 0 (Step 4). `search_tsv` now indexes `[redacted]` instead of secrets.

### Step 4: SessionsRepo writes the side table, plus the three backfill methods
**File:** `src/sessions/repo.ts`
**Change (a), imports L5 and L11-45 (as Phase 1 leaves them; Phase 1's `type SummaryRequest,` is kept):**
```ts
import { appSettings, ccPendingSpawns, ccSessionEmbeddings, ccSessionPrompts, ccSessions, ccSubagentTranscripts } from '../db/schema.js';
```
```ts
import {
  clip,
  earliest,
  latest,
  mergeCommits,
  mergeModels,
  mergeTranscriptPatch,
  normalizeCwd,
  redactedPromptColumns,
  replacedPromptColumns,
  storedPrompts,
  storedPromptsFromExcerpts,
  subtractModels,
} from './merge.js';
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
  SELECTED_PROJECT_KEY,
  type HookStart,
  type HookStartResult,
  type ListByNameOptions,
  type ListForRepoOptions,
  type ParentLinkSource,
  type PendingSpawnInput,
  type PendingSpawnRow,
  type ProjectSummary,
  type PromptsBackfillCandidate,
  type PromptsReplacement,
  type RedactStoredPromptsResult,
  type ReplacePromptsResult,
  type SessionEmbeddingFailure,
  type SessionEmbeddingInput,
  type SessionListItem,
  type SessionRow,
  type SessionsRepoOptions,
  type SetParentResult,
  type SpawnClaim,
  type SpawnClaimResult,
  type StoredPrompt,
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
(`type SummaryRequest,` is Phase 1's line, already present; this list is the post-Phase-1 list plus this phase's names.)

**Change (b), insert after `MAX_SESSION_ID_CHARS` (after L96):**
```ts
/** Rows and characters per insert into cc_session_prompts, so one statement stays small. */
const PROMPT_INSERT_ROWS = 200;
const PROMPT_INSERT_CHARS = 4 * 1024 * 1024;

/** `prompts` in insert-sized groups, in order. */
function promptBatches(prompts: readonly StoredPrompt[]): StoredPrompt[][] {
  const batches: StoredPrompt[][] = [];
  let current: StoredPrompt[] = [];
  let chars = 0;
  for (const p of prompts) {
    if (current.length > 0 && (current.length >= PROMPT_INSERT_ROWS || chars + p.text.length > PROMPT_INSERT_CHARS)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(p);
    chars += p.text.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
```
**Change (c), insert after `lock` (after L207):**
```ts
  /** The row, locked until the transaction ends, or null when the session has no row. */
  private async lockIfExists(tx: Tx, sessionId: string): Promise<SessionRow | null> {
    const rows = await tx.select(SESSION_COLUMNS).from(ccSessions).where(eq(ccSessions.sessionId, sessionId)).for('update');
    return rows[0] ?? null;
  }

  /**
   * Writes a session's `cc_session_prompts` rows. The caller holds the cc_sessions row lock, which
   * every writer of a session's prompt rows takes, so seq cannot race. `replace`: the rows become
   * exactly `prompts`, seq 1..n. Otherwise `prompts` are appended after the highest seq.
   */
  private async writePromptRows(tx: Tx, sessionId: string, prompts: readonly StoredPrompt[], replace: boolean): Promise<void> {
    let next = 1;
    if (replace) {
      await tx.delete(ccSessionPrompts).where(eq(ccSessionPrompts.sessionId, sessionId));
    } else {
      if (prompts.length === 0) return;
      const top = await tx
        .select({ max: sql<number>`coalesce(max(${ccSessionPrompts.seq}), 0)`.mapWith(Number) })
        .from(ccSessionPrompts)
        .where(eq(ccSessionPrompts.sessionId, sessionId));
      next = (top[0]?.max ?? 0) + 1;
    }
    for (const batch of promptBatches(prompts)) {
      const values = batch.map((p, i) => ({ sessionId, seq: next + i, at: p.at, text: p.text, truncated: p.truncated }));
      await tx.insert(ccSessionPrompts).values(values);
      next += batch.length;
    }
  }
```
**Change (d), `upsertFromTranscript` L211-241, replaced whole:**
```ts
  /**
   * Applies one ingest pass. Compare-and-set on transcript_offset: see TranscriptPatch. Replaying
   * a patch is a no-op (`offset_mismatch`); the caller then resumes from `storedOffset`.
   *
   * The pass's prompts go to `cc_session_prompts` in the same transaction, redacted: appended after
   * the highest seq, or replacing every row on fromOffset 0. Only a read from byte 0 has seen every
   * prompt, so only it marks the row `prompts_version = PROMPTS_VERSION`. An append to a row below
   * it (0: written before full prompts existed; PROMPTS_VERSION_EXCERPTS: rebuilt from excerpts)
   * adds its prompts but leaves the version, so the prompts backfill still replaces that row's
   * side rows whole.
   */
  async upsertFromTranscript(patch: TranscriptPatch): Promise<TranscriptUpsertResult> {
    assertSessionId(patch.sessionId);
    assertHost(patch.host);
    assertOffset(patch.fromOffset, 'fromOffset');
    assertOffset(patch.toOffset, 'toOffset');
    assertOffset(patch.size, 'size');
    if (patch.toOffset < patch.fromOffset) throw new RangeError('toOffset is before fromOffset');
    await this.ensureSession(patch.sessionId, patch.host);
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
      await this.writePromptRows(tx, patch.sessionId, storedPrompts(patch.prompts), reset);
      const now = this.now();
      const updated = await tx
        .update(ccSessions)
        .set(reset ? { ...set, promptsVersion: PROMPTS_VERSION, updatedAt: now } : { ...set, updatedAt: now })
        .where(eq(ccSessions.sessionId, patch.sessionId))
        .returning(SESSION_COLUMNS);
      const next = updated[0];
      if (!next) throw new Error(`cc_sessions row ${patch.sessionId} disappeared`);
      return { applied: true, row: next } as const;
    });
  }
```
**Change (e), insert after `offsets` (after L255):**
```ts
  // ---------- full prompts backfill ----------

  /**
   * Rows of `host` below PROMPTS_VERSION, most recently active first: legacy rows (0) and rows
   * redacted in place from excerpts (PROMPTS_VERSION_EXCERPTS), which upgrade if their transcript
   * is readable again.
   */
  async promptsBackfillCandidates(host: string): Promise<PromptsBackfillCandidate[]> {
    assertHost(host);
    return this.db
      .select({
        sessionId: ccSessions.sessionId,
        transcriptPath: ccSessions.transcriptPath,
        transcriptOffset: ccSessions.transcriptOffset,
      })
      .from(ccSessions)
      .where(and(eq(ccSessions.host, host), lt(ccSessions.promptsVersion, PROMPTS_VERSION)))
      .orderBy(desc(sql`coalesce(${ccSessions.lastActiveAt}, ${ccSessions.createdAt})`), asc(ccSessions.sessionId));
  }

  /**
   * Replaces a session's prompts with those of its transcript re-read from byte 0 to `upToOffset`.
   * Compare-and-set on transcript_offset and host, under the row lock. Writes `cc_session_prompts`
   * (redacted, seq 1..n), the excerpt list, first_prompt, last_prompt, prompts_version and
   * updated_at, and no other column.
   */
  async replacePrompts(sessionId: string, host: string, input: PromptsReplacement): Promise<ReplacePromptsResult> {
    assertSessionId(sessionId);
    assertHost(host);
    assertOffset(input.upToOffset, 'upToOffset');
    return this.db.transaction(async (tx): Promise<ReplacePromptsResult> => {
      const row = await this.lockIfExists(tx, sessionId);
      if (row === null) return { status: 'missing' };
      if (row.host !== host) return { status: 'other_host' };
      if (row.transcriptOffset !== input.upToOffset) return { status: 'offset_mismatch', storedOffset: row.transcriptOffset };
      await this.writePromptRows(tx, sessionId, storedPrompts(input.prompts), true);
      await tx
        .update(ccSessions)
        .set({ ...replacedPromptColumns(row, input), promptsVersion: PROMPTS_VERSION, updatedAt: this.now() })
        .where(eq(ccSessions.sessionId, sessionId));
      return { status: 'applied' };
    });
  }

  /**
   * For a row of `host` whose transcript is gone: redacts the stored excerpts, first_prompt and
   * last_prompt in place, rebuilds `cc_session_prompts` from the redacted excerpts (the full text
   * cannot be recovered; `truncated` where an excerpt ends in `…`) and marks the row
   * PROMPTS_VERSION_EXCERPTS, never PROMPTS_VERSION: the list is not complete. Same columns as
   * replacePrompts. A row already at PROMPTS_VERSION_EXCERPTS or above is left alone ('current'),
   * so a pruned transcript costs one locked read per daemon start, not a rewrite.
   */
  async redactStoredPrompts(sessionId: string, host: string): Promise<RedactStoredPromptsResult> {
    assertSessionId(sessionId);
    assertHost(host);
    return this.db.transaction(async (tx): Promise<RedactStoredPromptsResult> => {
      const row = await this.lockIfExists(tx, sessionId);
      if (row === null) return 'missing';
      if (row.host !== host) return 'other_host';
      if (row.promptsVersion >= PROMPTS_VERSION_EXCERPTS) return 'current';
      await this.writePromptRows(tx, sessionId, storedPromptsFromExcerpts(row.prompts), true);
      await tx
        .update(ccSessions)
        .set({ ...redactedPromptColumns(row), promptsVersion: PROMPTS_VERSION_EXCERPTS, updatedAt: this.now() })
        .where(eq(ccSessions.sessionId, sessionId));
      return 'applied';
    });
  }
```
The class doc comment (L128-133) already names `cc_session_prompts`: Phase 1 rewrote it. Do not edit it again.
**Impact:** Invariant 2 (SessionsRepo is the only writer of `cc_session_prompts`). Invariant 4 (all side-table text goes through `storedPrompts` / `storedPromptsFromExcerpts`, so it is redacted). Invariant 6 (both backfill methods `set` only the prompt columns, `prompts_version` and `updated_at`). Invariant 7 (host CAS). No list or graph query in this file reads `cc_session_prompts` (Invariant 5).

### Step 5: Ingest: per-file hold shared by reads and the backfill; the one-time prompts backfill
**File:** `src/sessions/ingest.ts`
**Change (a), imports L9-17:** add `TranscriptAccumulator` (already imported) and the backfill types:
```ts
import type { SessionsRepo } from './repo.js';
import type { PromptsBackfillCandidate, PromptsReplacement, RedactStoredPromptsResult, ReplacePromptsResult } from './types.js';
```
(`readJsonlFrom`, `parseRecord`, `TranscriptAccumulator` are already imported from `./transcript.js`.)

**Change (b), header doc:** insert before the `EXTENSION POINT` paragraph (before L46):
```ts
 * - Full prompts: every write carries every prompt of the bytes it read (SessionsRepo stores them,
 *   redacted, in `cc_session_prompts`). Once the startup pass is done, `promptsBackfill` runs once:
 *   each row of this host still below PROMPTS_VERSION has its transcript re-read from 0 to its
 *   stored offset for prompts only (no tokens, commits, links or observers) and its prompt columns
 *   replaced (`SessionsRepo.replacePrompts`, a compare-and-set on the offset), under the same
 *   per-file hold as the tail reads. A row whose transcript is gone has its stored excerpts redacted
 *   in place (`redactStoredPrompts`, PROMPTS_VERSION_EXCERPTS); it stays a candidate, is skipped
 *   without a write while the file is missing, and is filled if the file is readable again. Only
 *   transcripts under `<claudeHome>/projects` are read. One log line, only when a row changed,
 *   was deferred or failed.
 *
```
**Change (c), `IngestStore` L71-72:**
```ts
export type IngestStore = Pick<SessionsRepo, 'offsets' | 'upsertFromTranscript'> &
  Partial<
    Pick<
      SessionsRepo,
      'subagentOffsets' | 'upsertFromSubagentTranscript' | 'promptsBackfillCandidates' | 'replacePrompts' | 'redactStoredPrompts'
    >
  >;
```
and update its doc (L67-70): "...one without the subagent methods leaves subagent transcripts unread; one without the three prompts methods skips the prompts backfill."

**Change (d), insert after `IngestObserver` (after L114):**
```ts
/** What the one-time prompts backfill did. */
export interface PromptsBackfillReport {
  /** Rows of this host below PROMPTS_VERSION when it started. */
  candidates: number;
  /** Re-read from the transcript and replaced. */
  filled: number;
  /** Transcript gone: stored excerpts redacted in place (PROMPTS_VERSION_EXCERPTS). */
  redacted: number;
  /** Nothing to do when reached: already redacted in place with the transcript still gone, or already current. */
  skipped: number;
  /** Left for the next daemon start: closing, a file that shrank, a second offset miss, a path outside this Claude home. */
  deferred: number;
  failed: number;
  ms: number;
}

type PromptsBackfillOutcome = 'filled' | 'redacted' | 'skipped' | 'deferred';

function emptyPromptsReport(): PromptsBackfillReport {
  return { candidates: 0, filled: 0, redacted: 0, skipped: 0, deferred: 0, failed: 0, ms: 0 };
}

async function fileSize(file: string): Promise<number | null> {
  try {
    return (await stat(file)).size;
  } catch {
    return null;
  }
}

/** True when `file` is inside `dir` (not `dir` itself). */
function isUnder(dir: string, file: string): boolean {
  const rel = path.relative(dir, path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
```
**Change (e), `SessionIngester` L148-159:** add after `ready`:
```ts
  /** Settles once the one-time prompts backfill that follows `ready` is done (never rejects). */
  promptsBackfill: Promise<PromptsBackfillReport>;
```
**Change (f), replace `runFile` L487-504 with:**
```ts
  /**
   * Holds `file` for one task: `first`, then every read asked for meanwhile (`again`), in order.
   * Tail reads and the prompts backfill of a file both go through here, so they never overlap.
   */
  const holdFile = (file: string, first: () => Promise<number>): Promise<number> => {
    const task: Promise<number> = (async () => {
      let bytes = await first();
      while (again.has(file) && !closed) {
        again.delete(file);
        bytes += await readFile(file);
      }
      return bytes;
    })().finally(() => {
      if (inflight.get(file) === task) inflight.delete(file);
    });
    inflight.set(file, task);
    return task;
  };

  /** `readFile`, serialized per file: a request during a read (or a backfill) runs once more right after it. */
  const runFile = (file: string): Promise<number> => {
    const running = inflight.get(file);
    if (running !== undefined) {
      again.add(file);
      return running.then(() => 0);
    }
    return holdFile(file, () => {
      again.delete(file);
      return readFile(file);
    });
  };

  /**
   * Runs `body` with `file` held: after the running read (if any), before any read asked for while
   * it runs. `body()` starts in the same tick the hold is taken, so no read can slip in between.
   */
  const withFileHeld = async <T>(file: string, body: () => Promise<T>): Promise<T> => {
    for (;;) {
      const running = inflight.get(file);
      if (running === undefined) break;
      await running.catch(() => 0);
    }
    const result = body();
    await holdFile(file, () => result.then(() => 0));
    return result;
  };

  interface PromptsFill {
    replace: (sessionId: string, host: string, input: PromptsReplacement) => Promise<ReplacePromptsResult>;
    redact: (sessionId: string, host: string) => Promise<RedactStoredPromptsResult>;
  }

  /**
   * One candidate of the prompts backfill. Re-reads the transcript from 0 to the stored offset,
   * collecting prompts only, and replaces the row's prompt columns. An offset miss (a tail write
   * landed first) retries once with the stored offset; a second miss waits for the next start.
   */
  const backfillSession = async (c: PromptsBackfillCandidate, fill: PromptsFill): Promise<PromptsBackfillOutcome> => {
    let upTo = c.transcriptOffset;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (closed) return 'deferred';
      const file = c.transcriptPath;
      if (file !== null && !isUnder(projectsDir, file)) return 'deferred';
      const size = file === null ? null : await fileSize(file);
      if (file === null || size === null) {
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
        firstPrompt: delta.firstPrompt,
        lastPrompt: delta.lastPrompt,
      });
      if (result.status === 'applied') return 'filled';
      if (result.status !== 'offset_mismatch') return 'deferred';
      upTo = result.storedOffset;
    }
    return 'deferred';
  };

  /** The one-time prompts backfill for this host (see the header). Never notifies observers. */
  const backfillPrompts = async (): Promise<PromptsBackfillReport> => {
    const started = Date.now();
    const report = emptyPromptsReport();
    const store = options.store;
    const list = store.promptsBackfillCandidates?.bind(store);
    const replace = store.replacePrompts?.bind(store);
    const redact = store.redactStoredPrompts?.bind(store);
    if (list === undefined || replace === undefined || redact === undefined || closed) return report;
    const fill: PromptsFill = { replace, redact };
    const candidates = await list(host);
    report.candidates = candidates.length;
    if (candidates.length === 0) return report;
    await forEachLimit(candidates, concurrency, async (c) => {
      if (closed) {
        report.deferred += 1;
        return;
      }
      try {
        const file = c.transcriptPath;
        const outcome = file === null ? await backfillSession(c, fill) : await withFileHeld(file, () => backfillSession(c, fill));
        report[outcome] += 1;
      } catch (err) {
        report.failed += 1;
        log(`[notesd] sessions: prompts backfill ${c.sessionId}: ${errorMessage(err)}`);
      }
    });
    report.ms = Date.now() - started;
    // Rows redacted in place stay candidates and are skipped on every start: say nothing then.
    if (report.filled + report.redacted + report.deferred + report.failed > 0) log(formatPromptsReport(report));
    return report;
  };
```
**Change (g), insert after the `ready` declaration (after L604):**
```ts
  let promptsSettled = false;
  const promptsBackfill: Promise<PromptsBackfillReport> = ready
    .then(() => backfillPrompts())
    .catch((err: unknown) => {
      log(`[notesd] sessions: prompts backfill failed: ${errorMessage(err)}`);
      return { ...emptyPromptsReport(), failed: 1 };
    })
    .finally(() => {
      promptsSettled = true;
    });
```
**Change (h), the returned object (L620-658):** add `promptsBackfill,` after `ready,`. In `idle()` replace the `pending` line with
```ts
        const pending = [sweeping, watchDrain, promptsSettled ? null : promptsBackfill, ...inflight.values()].filter((p) => p !== null);
```
and in `close()` replace the `pending` line with
```ts
      const pending = Promise.allSettled([closing, sweeping, watchDrain, promptsBackfill, ...inflight.values()]);
```
**Change (i), insert after `formatReport` (after L665):**
```ts
/** e.g. `[notesd] sessions: prompts backfill 640 sessions, 612 filled, 25 redacted in place, 0 already done, 3 deferred, 0 failed, 4210ms` */
export function formatPromptsReport(r: PromptsBackfillReport): string {
  return `[notesd] sessions: prompts backfill ${r.candidates} sessions, ${r.filled} filled, ${r.redacted} redacted in place, ${r.skipped} already done, ${r.deferred} deferred, ${r.failed} failed, ${r.ms}ms`;
}
```
**Impact:**
- `runFile` behaves the same as before: `again` is cleared before each read, and a request that arrives during a read runs right after it.
- The backfill's `inflight` entries are counted by `idle()` and `close()`.
- The first start after landing re-reads every local transcript once (measured 2026-11-02: 628 files, ~900 MB, 2-5 s), with 4 at a time. It logs one line, and only when a row was filled, redacted, deferred or failed. Later starts list the rows left at `PROMPTS_VERSION_EXCERPTS` again (one `stat` and one locked read each, no write) and stay silent unless one of them got its transcript back.
- The backfill never calls `notifyBatch` or `notifyPass`.
- `isUnder(projectsDir, …)` means a test daemon never reads a path outside its temp Claude home, even when the test DB has leftover rows with the real hostname (Invariant 9).

### Step 6: Fixture with 106 prompts, a long indented one and a fake key
**File:** `tests/fixtures/make-many-prompts-fixture.mjs` (new). Run `node tests/fixtures/make-many-prompts-fixture.mjs` once, then commit its output `tests/fixtures/claude-home/projects/-home-u-mcp-notes/5e55a001-0000-4000-8000-000000000005.jsonl`.
**Code:**
```js
#!/usr/bin/env node
// Writes the many-prompts fixture transcript into tests/fixtures/claude-home. Deterministic: rerun
// it and `git diff` shows nothing. 106 human prompts (more than the 100-excerpt cap); prompt 50 is a
// multi-line prompt over 2000 chars with indented lines; prompt 60 holds a fake Anthropic key that
// must never be stored. Constants are mirrored in tests/helpers/claudeHome.ts (MANY_PROMPTS).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = '5e55a001-0000-4000-8000-000000000005';
const PROMPTS = 106;
const LONG = 50;
const KEYED = 60;
const FAKE_KEY = 'sk-ant-api03-FAKE-not-a-real-key-0000000000';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'claude-home', 'projects', '-home-u-mcp-notes', `${ID}.jsonl`);
const base = Date.parse('2026-10-20T01:00:00.000Z');
const at = (minute, second = 0) => new Date(base + minute * 60_000 + second * 1_000).toISOString();
const envelope = {
  sessionId: ID,
  cwd: '/home/u/mcp-notes',
  entrypoint: 'cli',
  version: '2.1.311',
  gitBranch: 'main',
  userType: 'external',
  isSidechain: false,
};

function promptText(n) {
  if (n === LONG) {
    const lines = [`fixture prompt ${n}: a long prompt whose layout must survive`];
    for (let i = 1; i <= 40; i += 1) {
      lines.push(`${' '.repeat(2 + (i % 3) * 2)}line ${i}: the quick brown fox jumps over the lazy dog, then naps in the sun`);
    }
    lines.push('end of the long prompt');
    return lines.join('\n');
  }
  if (n === KEYED) return `fixture prompt ${n}: deploy with this key ${FAKE_KEY} then report back\n    keep this indented line exactly as typed`;
  return `fixture prompt ${n}: step ${n} of the long session`;
}

const records = [{ type: 'agent-name', agentName: 'many-prompts-fixture', sessionId: ID }];
for (let n = 1; n <= PROMPTS; n += 1) {
  records.push({
    parentUuid: n === 1 ? null : `mp-a-${n - 1}`,
    ...envelope,
    type: 'user',
    message: { role: 'user', content: promptText(n) },
    uuid: `mp-u-${n}`,
    timestamp: at(n),
  });
  records.push({
    parentUuid: `mp-u-${n}`,
    ...envelope,
    type: 'assistant',
    message: {
      id: `msg_mp_${n}`,
      model: 'claude-opus-5-5',
      role: 'assistant',
      content: [{ type: 'text', text: `Done with step ${n}.` }],
      usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    uuid: `mp-a-${n}`,
    timestamp: at(n, 30),
  });
}
records.push({ type: 'last-prompt', lastPrompt: promptText(PROMPTS), sessionId: ID });
writeFileSync(out, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
console.log(`wrote ${out}`);
```
The prompt texts deliberately avoid anything `redactSecrets` would touch except the key: no `key=`/`token:` assignments and no 32+ character opaque runs. Prompt 50 is ~3.3 KB.

### Step 7: Fixture helpers
**File:** `tests/helpers/claudeHome.ts:1` (imports) and `:10-19` (`FIXTURE`), new exports at the end.
**Code:** imports become
```ts
import { cp, mkdtemp, readFile } from 'node:fs/promises';
```
`FIXTURE` gains two entries (after `sdkTs` and after `worktreeFile`):
```ts
  manyPrompts: '5e55a001-0000-4000-8000-000000000005',
```
```ts
  manyPromptsFile: 'projects/-home-u-mcp-notes/5e55a001-0000-4000-8000-000000000005.jsonl',
```
Append:
```ts
/** The many-prompts fixture (written by tests/fixtures/make-many-prompts-fixture.mjs; keep in step). */
export const MANY_PROMPTS = {
  count: 106,
  /** Prompt number of the multi-line prompt over 2000 chars. */
  long: 50,
  /** Prompt number of the prompt holding `fakeKey`. */
  keyed: 60,
  fakeKey: 'sk-ant-api03-FAKE-not-a-real-key-0000000000',
} as const;

/** Prompt `n` of the many-prompts fixture exactly as typed, read from the committed file. */
export async function manyPromptsText(n: number): Promise<string> {
  const text = await readFile(path.join(FIXTURE_CLAUDE_HOME, FIXTURE.manyPromptsFile), 'utf8');
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const record = JSON.parse(line) as { type?: unknown; message?: { content?: unknown } };
    const content = record.message?.content;
    if (record.type === 'user' && typeof content === 'string' && content.startsWith(`fixture prompt ${n}:`)) return content;
  }
  throw new Error(`no prompt ${n} in the many-prompts fixture`);
}
```

### Step 8: MemoryIngestStore mirrors the side table and the backfill methods
**File:** `tests/helpers/memoryIngestStore.ts`: imports (L1-11) and the class body (L68-end). `blankSessionRow` is Phase 1's; leave it alone.
**Code:** imports become
```ts
import type { IngestStore } from '../../src/sessions/ingest.js';
import {
  latest,
  mergeCommits,
  mergeModels,
  mergeTranscriptPatch,
  redactedPromptColumns,
  replacedPromptColumns,
  storedPrompts,
  storedPromptsFromExcerpts,
  subtractModels,
} from '../../src/sessions/merge.js';
import {
  PROMPTS_VERSION,
  PROMPTS_VERSION_EXCERPTS,
  type PromptsBackfillCandidate,
  type PromptsReplacement,
  type RedactStoredPromptsResult,
  type ReplacePromptsResult,
  type SessionRow,
  type StoredPrompt,
  type SubagentTotals,
  type SubagentTranscriptPatch,
  type SubagentUpsertResult,
  type TranscriptOffset,
  type TranscriptPatch,
  type TranscriptUpsertResult,
} from '../../src/sessions/types.js';
```
In the class, add after `readonly subagents = ...` (L76 as Phase 1 leaves the file):
```ts
  /** `cc_session_prompts` by session id, in seq order. */
  readonly sidePrompts = new Map<string, StoredPrompt[]>();
```
Replace `upsertFromTranscript` (L134-146 as Phase 1 leaves the file) whole:
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
    this.sidePrompts.set(patch.sessionId, reset ? added : [...(this.sidePrompts.get(patch.sessionId) ?? []), ...added]);
    const next: SessionRow = {
      ...row,
      ...mergeTranscriptPatch(row, patch, subagents),
      ...(reset ? { promptsVersion: PROMPTS_VERSION } : {}),
    };
    this.rows.set(patch.sessionId, next);
    return { applied: true, row: next };
  }
```
Add before `seedRow`:
```ts
  async promptsBackfillCandidates(host: string): Promise<PromptsBackfillCandidate[]> {
    return [...this.rows.values()]
      .filter((r) => r.host === host && r.promptsVersion < PROMPTS_VERSION)
      .map((r) => ({ sessionId: r.sessionId, transcriptPath: r.transcriptPath, transcriptOffset: r.transcriptOffset }));
  }

  async replacePrompts(sessionId: string, host: string, input: PromptsReplacement): Promise<ReplacePromptsResult> {
    const row = this.rows.get(sessionId);
    if (!row) return { status: 'missing' };
    if (row.host !== host) return { status: 'other_host' };
    if (row.transcriptOffset !== input.upToOffset) return { status: 'offset_mismatch', storedOffset: row.transcriptOffset };
    this.sidePrompts.set(sessionId, storedPrompts(input.prompts));
    this.rows.set(sessionId, { ...row, ...replacedPromptColumns(row, input), promptsVersion: PROMPTS_VERSION });
    return { status: 'applied' };
  }

  async redactStoredPrompts(sessionId: string, host: string): Promise<RedactStoredPromptsResult> {
    const row = this.rows.get(sessionId);
    if (!row) return 'missing';
    if (row.host !== host) return 'other_host';
    if (row.promptsVersion >= PROMPTS_VERSION_EXCERPTS) return 'current';
    this.sidePrompts.set(sessionId, storedPromptsFromExcerpts(row.prompts));
    this.rows.set(sessionId, { ...row, ...redactedPromptColumns(row), promptsVersion: PROMPTS_VERSION_EXCERPTS });
    return 'applied';
  }
```
Update the class doc comment: "...`SessionsRepo`'s ingest and prompts-backfill methods over Maps..."

### Step 9: Unit tests
**File:** `tests/unit/sessions/transcript.test.ts`
- Imports L15: `import { MAX_PROMPT_STORE_CHARS } from '../../../src/sessions/types.js';` (`MAX_PROMPTS` is no longer used here).
- L93:
```ts
    expect(d.prompts).toEqual([{ text: 'sketch the project-session-graph feature', at: '2026-11-02T02:21:51.300Z', truncated: false }]);
```
- Replace the test at L176-182 with:
```ts
  it('keeps every prompt of a read, in order, with the first one', () => {
    const text = Array.from({ length: 130 }, (_, i) => user(`p${i}`)).join('\n');
    const d = accumulateText('s', text).delta();
    expect(d.prompts).toHaveLength(130);
    expect(d.prompts[0]?.text).toBe('p0');
    expect(d.prompts.at(-1)?.text).toBe('p129');
    expect(d.firstPrompt).toBe('p0');
  });

  it('stores a long prompt whole, cut only at the ceiling and marked truncated', () => {
    const long = `start\n    indented\n${'x'.repeat(5000)}`;
    const huge = 'y'.repeat(MAX_PROMPT_STORE_CHARS + 10);
    const d = accumulateText('s', [user(long), user(huge), JSON.stringify({ type: 'last-prompt', lastPrompt: huge })].join('\n')).delta();
    expect(d.prompts[0]).toEqual({ text: long, at: '2026-11-02T00:00:00Z', truncated: false });
    expect(d.prompts[1]?.text).toHaveLength(MAX_PROMPT_STORE_CHARS);
    expect(d.prompts[1]?.truncated).toBe(true);
    expect(d.firstPrompt).toBe(long);
    expect(d.lastPrompt).toHaveLength(MAX_PROMPT_STORE_CHARS);
  });
```
- In `describe('readJsonlFrom')`, add:
```ts
  it('stops at `until` when it is before the end of the file', async () => {
    const file = path.join(dir, 'w.jsonl');
    await writeFile(file, '{"a":1}\n{"b":2}\n{"c":3}\n');
    const lines: string[] = [];
    const r = await readJsonlFrom(file, 0, (l) => lines.push(l), { until: Buffer.byteLength('{"a":1}\n{"b":2}\n'), chunkBytes: 5 });
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(r.endOffset).toBe(Buffer.byteLength('{"a":1}\n{"b":2}\n'));
    expect(r.size).toBe(Buffer.byteLength('{"a":1}\n{"b":2}\n{"c":3}\n'));
  });
```
- Add the many-prompts fixture case to `describe('TranscriptAccumulator on the fixture')`:
```ts
  it('reads all 106 prompts of the many-prompts fixture, the long one whole', async () => {
    const text = await readFile(path.join(FIXTURE_CLAUDE_HOME, FIXTURE.manyPromptsFile), 'utf8');
    const d = accumulateText(FIXTURE.manyPrompts, text).delta();
    expect(d.prompts).toHaveLength(MANY_PROMPTS.count);
    expect(d.prompts[MANY_PROMPTS.long - 1]?.text).toBe(await manyPromptsText(MANY_PROMPTS.long));
    expect(d.prompts[MANY_PROMPTS.long - 1]?.text.length).toBeGreaterThan(2000);
    expect(d.prompts.every((p) => p.truncated === false)).toBe(true);
  });
```
(import `MANY_PROMPTS, manyPromptsText` from `../../helpers/claudeHome.js`.)

**File:** `tests/unit/sessions/merge.test.ts`: append a describe (imports: add `promptExcerpt, redactedPromptColumns, replacedPromptColumns, storedPrompts, storedPromptsFromExcerpts` from merge, `MAX_PROMPT_CHARS` from types):
```ts
describe('prompt redaction', () => {
  const KEY = 'sk-ant-api03-FAKE-not-a-real-key-0000000000'
  const typed = `line one\n    indented with ${KEY} inside\n\ttabbed tail  `

  it('stores a prompt with a fake key without the key, and the rest byte for byte', () => {
    const [row] = storedPrompts([{ text: typed, at: '2026-11-01T10:00:00.000Z' }])
    expect(row?.text).toBe(`line one\n    indented with [redacted] inside\n\ttabbed tail  `)
    expect(row?.text).not.toContain('sk-ant')
    expect(row?.at?.toISOString()).toBe('2026-11-01T10:00:00.000Z')
    expect(row?.truncated).toBe(false)
  })

  it('keeps the full text in the side rows, the excerpt clipped after redacting', () => {
    const long = `${'a '.repeat(1500)}${KEY} end`
    expect(storedPrompts([{ text: long, at: null, truncated: true }])[0]).toMatchObject({ text: long.replace(KEY, '[redacted]'), truncated: true })
    const excerpt = promptExcerpt(`${'b'.repeat(MAX_PROMPT_CHARS - 5)} ${KEY}`)
    expect(excerpt).toHaveLength(MAX_PROMPT_CHARS)
    expect(excerpt).not.toContain('sk-ant')
    expect(excerpt.endsWith('…')).toBe(true)
  })

  it('redacts the excerpts, first and last prompt on every write, including stored legacy ones', () => {
    const row = blankRow({ transcriptOffset: 10, firstPrompt: `first ${KEY}`, lastPrompt: `last ${KEY}`, prompts: [{ text: `old ${KEY}`, at: null }] })
    const set = mergeTranscriptPatch(row, patch({ fromOffset: 10, toOffset: 20, prompts: [{ text: `new ${KEY}`, at: null }] }))
    expect(set.prompts.map((p) => p.text)).toEqual(['old [redacted]', 'new [redacted]'])
    expect(set.firstPrompt).toBe('first [redacted]')
    expect(set.lastPrompt).toBe('last [redacted]')
    const fresh = mergeTranscriptPatch(blankRow(), patch({ firstPrompt: `x ${KEY}`, lastPrompt: `y ${'z'.repeat(3000)}` }))
    expect(fresh.firstPrompt).toBe('x [redacted]')
    expect(fresh.lastPrompt).toHaveLength(MAX_PROMPT_CHARS)
  })

  it('builds backfill columns: re-read values win, missing ones keep the stored value redacted', () => {
    const row = { prompts: [{ text: `legacy ${KEY}`, at: null }], firstPrompt: `f ${KEY}`, lastPrompt: `l ${KEY}` }
    expect(replacedPromptColumns(row, { prompts: [{ text: 'p1', at: null }], firstPrompt: null, lastPrompt: 'last' })).toEqual({
      prompts: [{ text: 'p1', at: null }],
      firstPrompt: 'f [redacted]',
      lastPrompt: 'last',
    })
    expect(redactedPromptColumns(row)).toEqual({
      prompts: [{ text: 'legacy [redacted]', at: null }],
      firstPrompt: 'f [redacted]',
      lastPrompt: 'l [redacted]',
    })
  })

  it('rebuilds side rows from excerpts, truncated where the excerpt was clipped', () => {
    expect(storedPromptsFromExcerpts([{ text: 'whole', at: null }, { text: `cut ${KEY} …`, at: '2026-11-01T10:00:00.000Z' }, { text: '  ', at: null }])).toEqual([
      { text: 'whole', at: null, truncated: false },
      { text: 'cut [redacted] …', at: new Date('2026-11-01T10:00:00.000Z'), truncated: true },
    ])
  })
})
```
**File:** `tests/unit/sessions/ingest.test.ts`
- L102-105 (helpers test):
```ts
    expect(files.slice(0, 4).sort()).toEqual(
      [FIXTURE.worktreeFile, FIXTURE.mainFile, FIXTURE.manyPromptsFile, `projects/-home-u-mcp-notes/${FIXTURE.sdkCli}.jsonl`].sort(),
    );
    expect(files.slice(4)).toEqual([SUBAGENT_FILE]);
```
- L139-141:
```ts
    // 4 sessions (one sdk, skipped) and the main session's one subagent.
    expect(report).toMatchObject({ reason: 'backfill', files: 5, upserted: 4, failed: 0 });
    expect([...store.rows.keys()].sort()).toEqual([FIXTURE.main, FIXTURE.worktreeChild, FIXTURE.manyPrompts].sort());
```
- L160 and L168: the expected id lists become `[FIXTURE.main, FIXTURE.worktreeChild, FIXTURE.manyPrompts].sort()`.
- L350: `toHaveLength(2)` -> `toHaveLength(3)` (one `onBatch` per written session); L352: `store.rows.size` `2` -> `3`.
- Imports: add `MANY_PROMPTS` from the helper and `PROMPTS_VERSION`, `PROMPTS_VERSION_EXCERPTS` from `../../../src/sessions/types.js`.
- Append:
```ts
describe('startSessionIngest: prompts backfill', () => {
  const KEY = MANY_PROMPTS.fakeKey;
  const withoutPrompts = (r: SessionRow | undefined): Partial<SessionRow> => {
    if (r === undefined) return {};
    const { prompts, firstPrompt, lastPrompt, promptsVersion, ...rest } = r;
    void prompts;
    void firstPrompt;
    void lastPrompt;
    void promptsVersion;
    return rest;
  };

  it('stores every prompt of a fresh session and marks it current, so the backfill has nothing to do', async () => {
    const ingester = start();
    await ingester.ready;
    expect(await ingester.promptsBackfill).toMatchObject({ candidates: 0 });
    expect(store.sidePrompts.get(FIXTURE.manyPrompts)).toHaveLength(MANY_PROMPTS.count);
    expect(store.rows.get(FIXTURE.manyPrompts)?.promptsVersion).toBe(PROMPTS_VERSION);
    expect(store.rows.get(FIXTURE.manyPrompts)?.prompts).toHaveLength(100);
  });

  it("replaces a legacy row's prompts from its transcript and changes nothing else", async () => {
    await start().ready;
    const row = store.rows.get(FIXTURE.manyPrompts);
    if (!row) throw new Error('no row');
    store.rows.set(FIXTURE.manyPrompts, { ...row, promptsVersion: 0, prompts: [{ text: `legacy ${KEY}`, at: null }], lastPrompt: `legacy ${KEY}` });
    store.sidePrompts.delete(FIXTURE.manyPrompts);
    const writes = store.patches.length;
    const second = start();
    await second.ready;
    expect(await second.promptsBackfill).toMatchObject({ candidates: 1, filled: 1, failed: 0 });
    expect(store.patches.length).toBe(writes);
    const after = store.rows.get(FIXTURE.manyPrompts);
    expect(after?.promptsVersion).toBe(PROMPTS_VERSION);
    expect(withoutPrompts(after)).toEqual(withoutPrompts(row));
    expect(store.sidePrompts.get(FIXTURE.manyPrompts)).toHaveLength(MANY_PROMPTS.count);
    expect(JSON.stringify([after, store.sidePrompts.get(FIXTURE.manyPrompts)])).not.toContain(KEY);
  });

  it('retries once with the stored offset after a compare-and-set miss', async () => {
    await start().ready;
    const row = store.rows.get(FIXTURE.manyPrompts);
    if (!row) throw new Error('no row');
    store.rows.set(FIXTURE.manyPrompts, { ...row, promptsVersion: 0 });
    const real = store.replacePrompts.bind(store);
    let calls = 0;
    store.replacePrompts = async (id, host, input) => {
      calls += 1;
      return calls === 1 ? { status: 'offset_mismatch', storedOffset: row.transcriptOffset } : real(id, host, input);
    };
    const second = start();
    await second.ready;
    expect(await second.promptsBackfill).toMatchObject({ filled: 1 });
    expect(calls).toBe(2);
  });

  it('redacts stored prompts in place when the transcript is gone, marks them excerpts-only, and skips them next time', async () => {
    const id = '5e55a001-0000-4000-8000-0000000000dd';
    store.seedRow(id, 'test-host', {
      transcriptPath: path.join(home, `projects/-home-u-mcp-notes/${id}.jsonl`),
      transcriptOffset: 50,
      prompts: [{ text: `use ${KEY} now…`, at: null }],
    });
    const ingester = start();
    await ingester.ready;
    expect(await ingester.promptsBackfill).toMatchObject({ redacted: 1 });
    expect(store.rows.get(id)).toMatchObject({ promptsVersion: PROMPTS_VERSION_EXCERPTS, prompts: [{ text: 'use [redacted] now…', at: null }], transcriptOffset: 50 });
    expect(store.sidePrompts.get(id)).toEqual([{ text: 'use [redacted] now…', at: null, truncated: true }]);
    const second = start();
    await second.ready;
    expect(await second.promptsBackfill).toMatchObject({ candidates: 1, skipped: 1, redacted: 0, filled: 0 });
    expect(store.rows.get(id)?.promptsVersion).toBe(PROMPTS_VERSION_EXCERPTS);
  });

  it('fills a row redacted in place once its transcript is readable again', async () => {
    await start().ready;
    const row = store.rows.get(FIXTURE.manyPrompts);
    if (!row) throw new Error('no row');
    store.rows.set(FIXTURE.manyPrompts, { ...row, promptsVersion: PROMPTS_VERSION_EXCERPTS });
    store.sidePrompts.set(FIXTURE.manyPrompts, [{ text: 'excerpt…', at: null, truncated: true }]);
    const second = start();
    await second.ready;
    expect(await second.promptsBackfill).toMatchObject({ candidates: 1, filled: 1 });
    expect(store.rows.get(FIXTURE.manyPrompts)?.promptsVersion).toBe(PROMPTS_VERSION);
    expect(store.sidePrompts.get(FIXTURE.manyPrompts)).toHaveLength(MANY_PROMPTS.count);
  });

  it("never reads outside its own Claude home and never touches another host's rows", async () => {
    store.seedRow('5e55a001-0000-4000-8000-0000000000de', 'test-host', { transcriptPath: '/elsewhere/x.jsonl', transcriptOffset: 10, prompts: [{ text: `a ${KEY}`, at: null }] });
    store.seedRow('5e55a001-0000-4000-8000-0000000000df', 'other-laptop', { prompts: [{ text: `b ${KEY}`, at: null }] });
    const ingester = start();
    await ingester.ready;
    expect(await ingester.promptsBackfill).toMatchObject({ candidates: 1, deferred: 1 });
    expect(store.rows.get('5e55a001-0000-4000-8000-0000000000de')?.promptsVersion).toBe(0);
    expect(store.rows.get('5e55a001-0000-4000-8000-0000000000df')?.prompts[0]?.text).toBe(`b ${KEY}`);
  });
});
```
(import `type SessionRow` from `../../../src/sessions/types.js`.)

### Step 10: Integration tests
**File:** `tests/integration/sessions.ingest.int.test.ts`
- L20: `const IDS = [FIXTURE.main, FIXTURE.worktreeChild, FIXTURE.manyPrompts, FIXTURE.sdkCli, FIXTURE.sdkTs];`
- L79-80: comment "Three cli sessions, plus the main session's subagent transcript"; `upserted: 4`.

**File:** `tests/integration/sessions.prompts.int.test.ts` (new):
```ts
import { appendFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { ccSessionPrompts } from '../../src/db/schema.js';
import { startSessionIngest, type SessionIngester } from '../../src/sessions/ingest.js';
import { SessionsRepo } from '../../src/sessions/repo.js';
import { createRepoResolver } from '../../src/sessions/repoResolve.js';
import { PROMPTS_VERSION, PROMPTS_VERSION_EXCERPTS, type TranscriptPatch } from '../../src/sessions/types.js';
import { copyFixtureClaudeHome, FIXTURE, MANY_PROMPTS, manyPromptsText } from '../helpers/claudeHome.js';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

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

function patch(sessionId: string, over: Partial<TranscriptPatch> = {}): TranscriptPatch {
  return { sessionId, host: HOST, transcriptPath: `/nowhere/${sessionId}.jsonl`, fromOffset: 0, toOffset: 100, size: 100, ...over };
}

async function sideRows(sessionId: string) {
  return db.select().from(ccSessionPrompts).where(eq(ccSessionPrompts.sessionId, sessionId)).orderBy(asc(ccSessionPrompts.seq));
}

/** Rows anywhere holding the fake key: the side table plus every prompt column of cc_sessions. */
async function keyCount(): Promise<number> {
  const like = `%${KEY}%`;
  const res = await db.execute<{ n: string }>(sql`
    select (select count(*) from cc_session_prompts where text like ${like})
         + (select count(*) from cc_sessions where prompts::text like ${like} or first_prompt like ${like} or last_prompt like ${like}) as n`);
  return Number(res.rows[0]?.n ?? -1);
}

/** Every cc_sessions column the backfill must not change (Invariant 6). */
async function frozen(sessionId: string): Promise<Record<string, unknown> | undefined> {
  const res = await db.execute<Record<string, unknown>>(sql`
    select node_id, host, repo, cwd, branch, name, custom_title, ai_title, entrypoint, version, started_at, last_active_at,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, models, parent_session_id,
           parent_link_source, tmux, transcript_path, transcript_offset, transcript_size, commits, files_edited, plan_docs,
           final_message, summary, summary_sha, summarized_at, summary_requested_at, created_at
    from cc_sessions where session_id = ${sessionId}`);
  return res.rows[0];
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

describe('ingest stores every prompt in full, redacted', () => {
  it('fills cc_session_prompts with all 106 prompts in order: the long one whole, the key redacted', async () => {
    const ingester = start();
    await ingester.ready;
    expect(await ingester.promptsBackfill).toMatchObject({ candidates: 0 });
    const rows = await sideRows(MP);
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: MANY_PROMPTS.count }, (_, i) => i + 1));
    expect(rows[0]?.at?.toISOString()).toBe('2026-10-20T01:01:00.000Z');
    const long = await manyPromptsText(MANY_PROMPTS.long);
    expect(long.length).toBeGreaterThan(2000);
    expect(rows[MANY_PROMPTS.long - 1]).toMatchObject({ text: long, truncated: false });
    const keyed = await manyPromptsText(MANY_PROMPTS.keyed);
    expect(keyed).toContain(KEY);
    expect(rows[MANY_PROMPTS.keyed - 1]?.text).toBe(keyed.replace(KEY, '[redacted]'));
    expect(await keyCount()).toBe(0);

    const row = await repo.getBySessionId(MP);
    expect(row?.promptsVersion).toBe(PROMPTS_VERSION);
    expect(row?.prompts).toHaveLength(100);
    expect(row?.prompts.every((p) => p.text.length <= 2000)).toBe(true);
    expect(row?.prompts[0]?.text).toBe(await manyPromptsText(MANY_PROMPTS.count - 99));
    expect(row?.prompts.find((p) => p.text.startsWith(`fixture prompt ${MANY_PROMPTS.long}:`))?.text.endsWith('…')).toBe(true);
  });

  it('appends prompts typed later after the highest seq', async () => {
    const ingester = start();
    await ingester.ready;
    const user = (content: string, at: string) =>
      `${JSON.stringify({ type: 'user', sessionId: MP, entrypoint: 'cli', cwd: '/home/u/mcp-notes', timestamp: at, message: { role: 'user', content } })}\n`;
    await appendFile(path.join(home, FIXTURE.manyPromptsFile), user('one more', '2026-10-21T00:00:00.000Z') + user(`and ${KEY}`, '2026-10-21T00:01:00.000Z'));
    await ingester.sweep();
    const rows = await sideRows(MP);
    expect(rows).toHaveLength(MANY_PROMPTS.count + 2);
    expect(rows.slice(-2).map((r) => [r.seq, r.text])).toEqual([
      [MANY_PROMPTS.count + 1, 'one more'],
      [MANY_PROMPTS.count + 2, 'and [redacted]'],
    ]);
    expect((await repo.getBySessionId(MP))?.promptsVersion).toBe(PROMPTS_VERSION);
    expect(await keyCount()).toBe(0);
  });
});

describe('SessionsRepo prompt rows', () => {
  it('a read from byte 0 replaces the rows; an append continues the seq', async () => {
    await repo.upsertFromTranscript(patch('s-1', { prompts: [{ text: 'a', at: null }, { text: 'b', at: null }, { text: 'c', at: '2026-11-01T10:00:00.000Z' }] }));
    await repo.upsertFromTranscript(patch('s-1', { fromOffset: 100, toOffset: 150, size: 150, prompts: [{ text: 'd', at: null, truncated: true }] }));
    expect((await sideRows('s-1')).map((r) => [r.seq, r.text, r.truncated])).toEqual([
      [1, 'a', false],
      [2, 'b', false],
      [3, 'c', false],
      [4, 'd', true],
    ]);
    await repo.upsertFromTranscript(patch('s-1', { toOffset: 160, size: 160, prompts: [{ text: 'x', at: null }] }));
    expect((await sideRows('s-1')).map((r) => [r.seq, r.text])).toEqual([[1, 'x']]);
  });

  it('an append to a version-0 row adds its prompts but leaves the version at 0', async () => {
    await repo.upsertFromTranscript(patch('s-2', { prompts: [{ text: 'a', at: null }] }));
    expect((await repo.getBySessionId('s-2'))?.promptsVersion).toBe(PROMPTS_VERSION);
    await db.execute(sql`update cc_sessions set prompts_version = 0 where session_id = 's-2'`);
    await repo.upsertFromTranscript(patch('s-2', { fromOffset: 100, toOffset: 120, size: 120, prompts: [{ text: 'b', at: null }] }));
    expect((await repo.getBySessionId('s-2'))?.promptsVersion).toBe(0);
    expect((await sideRows('s-2')).map((r) => r.text)).toEqual(['a', 'b']);
  });

  it('replacePrompts is a compare-and-set on offset and host and writes only the prompt columns', async () => {
    await repo.upsertFromTranscript(patch('s-3', { tokens: { inputTokens: 7 }, prompts: [{ text: 'old', at: null }] }));
    const before = await frozen('s-3');
    const input = { upToOffset: 100, prompts: [{ text: `new ${KEY}`, at: null }], firstPrompt: 'new', lastPrompt: null };
    expect(await repo.replacePrompts('s-3', HOST, { ...input, upToOffset: 90 })).toEqual({ status: 'offset_mismatch', storedOffset: 100 });
    expect(await repo.replacePrompts('s-3', 'other-laptop', input)).toEqual({ status: 'other_host' });
    expect(await repo.replacePrompts('nope', HOST, input)).toEqual({ status: 'missing' });
    expect(await repo.replacePrompts('s-3', HOST, input)).toEqual({ status: 'applied' });
    expect(await frozen('s-3')).toEqual(before);
    expect((await sideRows('s-3')).map((r) => r.text)).toEqual(['new [redacted]']);
    expect(await repo.getBySessionId('s-3')).toMatchObject({ firstPrompt: 'new', prompts: [{ text: 'new [redacted]', at: null }], promptsVersion: PROMPTS_VERSION });
  });
});

describe('prompts backfill', () => {
  it('replaces legacy prompts with full redacted ones, changes nothing else, and a second run is a no-op', async () => {
    const first = start();
    await first.ready;
    await first.promptsBackfill;
    await first.close();
    // What a row written before this phase looks like: version 0, clipped unredacted excerpts, no side rows.
    const legacy = [{ text: `legacy ${KEY} clipped…`, at: null }];
    await db.execute(sql`update cc_sessions set prompts_version = 0, prompts = ${JSON.stringify(legacy)}::jsonb, last_prompt = ${`legacy ${KEY}`} where session_id = ${MP}`);
    await db.execute(sql`delete from cc_session_prompts where session_id = ${MP}`);
    await repo.setSummary(MP, { summary: 'a summary', sha: 'abc' });
    const before = await frozen(MP);
    expect(await keyCount()).toBe(1);

    const second = start();
    await second.ready;
    expect(await second.promptsBackfill).toMatchObject({ candidates: 1, filled: 1, failed: 0 });
    expect(await frozen(MP)).toEqual(before);
    expect(await sideRows(MP)).toHaveLength(MANY_PROMPTS.count);
    expect(await keyCount()).toBe(0);
    const row = await repo.getBySessionId(MP);
    expect(row).toMatchObject({ promptsVersion: PROMPTS_VERSION, lastPrompt: await manyPromptsText(MANY_PROMPTS.count) });
    expect(row?.prompts).toHaveLength(100);
    await second.close();

    const third = start();
    await third.ready;
    expect(await third.promptsBackfill).toMatchObject({ candidates: 0 });
    expect((await repo.getBySessionId(MP))?.updatedAt.getTime()).toBe(row?.updatedAt.getTime());
  });

  it("leaves another host's rows untouched", async () => {
    await repo.ensureSession('other-host-session', 'other-laptop');
    await db.execute(sql`update cc_sessions set prompts = ${JSON.stringify([{ text: `raw ${KEY}`, at: null }])}::jsonb,
      transcript_path = ${path.join(home, FIXTURE.manyPromptsFile)}, transcript_offset = 10 where session_id = 'other-host-session'`);
    const before = await db.execute(sql`select * from cc_sessions where session_id = 'other-host-session'`);
    const ingester = start();
    await ingester.ready;
    await ingester.promptsBackfill;
    const after = await db.execute(sql`select * from cc_sessions where session_id = 'other-host-session'`);
    expect(after.rows).toEqual(before.rows);
    expect(await sideRows('other-host-session')).toEqual([]);
  });

  it('redacts the stored excerpts in place when the transcript is gone', async () => {
    const id = '5e55a001-0000-4000-8000-0000000000dd';
    await repo.ensureSession(id, HOST);
    const excerpts = [
      { text: 'old one', at: '2026-10-01T00:00:00.000Z' },
      { text: `deploy with ${KEY} and more…`, at: null },
    ];
    await db.execute(sql`update cc_sessions set prompts = ${JSON.stringify(excerpts)}::jsonb, first_prompt = 'old one',
      last_prompt = ${`use ${KEY}`}, transcript_offset = 500,
      transcript_path = ${path.join(home, `projects/-home-u-mcp-notes/${id}.jsonl`)} where session_id = ${id}`);
    const before = await frozen(id);
    const ingester = start();
    await ingester.ready;
    expect(await ingester.promptsBackfill).toMatchObject({ candidates: 1, redacted: 1 });
    expect(await frozen(id)).toEqual(before);
    expect(await repo.getBySessionId(id)).toMatchObject({
      promptsVersion: PROMPTS_VERSION_EXCERPTS,
      firstPrompt: 'old one',
      lastPrompt: 'use [redacted]',
      prompts: [
        { text: 'old one', at: '2026-10-01T00:00:00.000Z' },
        { text: 'deploy with [redacted] and more…', at: null },
      ],
    });
    expect((await sideRows(id)).map((r) => [r.seq, r.text, r.truncated, r.at?.toISOString() ?? null])).toEqual([
      [1, 'old one', false, '2026-10-01T00:00:00.000Z'],
      [2, 'deploy with [redacted] and more…', true, null],
    ]);
    expect(await keyCount()).toBe(0);
    const updatedAt = (await repo.getBySessionId(id))?.updatedAt.getTime();
    await ingester.close();

    // Still gone on the next start: listed again, skipped, nothing written.
    const again = start();
    await again.ready;
    expect(await again.promptsBackfill).toMatchObject({ candidates: 1, skipped: 1, redacted: 0 });
    expect((await repo.getBySessionId(id))?.updatedAt.getTime()).toBe(updatedAt);
  });

  it('upgrades a row redacted in place to full prompts once its transcript is readable', async () => {
    const first = start();
    await first.ready;
    await first.promptsBackfill;
    await first.close();
    await db.execute(sql`update cc_sessions set prompts_version = ${PROMPTS_VERSION_EXCERPTS} where session_id = ${MP}`);
    await db.execute(sql`delete from cc_session_prompts where session_id = ${MP} and seq > 3`);
    const second = start();
    await second.ready;
    expect(await second.promptsBackfill).toMatchObject({ candidates: 1, filled: 1 });
    expect((await repo.getBySessionId(MP))?.promptsVersion).toBe(PROMPTS_VERSION);
    expect(await sideRows(MP)).toHaveLength(MANY_PROMPTS.count);
  });
});
```
**Impact:** The int suite gains one file of about 10 s. The `frozen` check covers Invariant 6 column by column, `keyCount` covers Invariant 4, and the other-host case covers Invariant 7.

## Principles applied

- Laziness protocol / reuse: the backfill re-reads with the existing `TranscriptAccumulator` and keeps only `prompts` / `firstPrompt` / `lastPrompt` from its delta, so prompt rules (human vs peer, bare commands, interrupts) come from one source. For per-file locking it reuses `runFile`'s `inflight`/`again` maps through a shared `holdFile`; no second lock map is added.
- Boundary discipline: redaction happens at one boundary only, the pure helpers in `merge.ts` (`promptExcerpt`, `storedPrompts`, `storedPromptsFromExcerpts`, `replacedPromptColumns`, `redactedPromptColumns`). Every `SessionsRepo` write and the memory store call those helpers. The accumulator stays unredacted, and nobody re-redacts downstream.
- Make illegal states unrepresentable: `ReplacePromptsResult` is a discriminated union, so `storedOffset` exists only on `offset_mismatch`. The version rule (only a byte-0 write marks a row current) lives inside `upsertFromTranscript`, so no caller can mark a partial side table as complete.
- Build the lever: the fixture comes from a deterministic generator (`tests/fixtures/make-many-prompts-fixture.mjs`), and `manyPromptsText` reads expected values from the committed file, so tests never re-type a 3 KB prompt.
- Subtract before you add: the per-read count cap and the 2000-char cut are deleted from the accumulator rather than worked around. The excerpt clip now lives only in `merge.ts`.
- Prove it works: the Proof drives `verify.sh up --sessions` and reads the stored rows back with `md5` against the fixture file. The backfill, which the harness cannot restart into, is proven by the int test against real Postgres.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` (unit), then `npm run test:int`. Focused runs: `npx vitest run tests/unit/sessions`, and `scripts/test-int.sh tests/integration/sessions.prompts.int.test.ts tests/integration/sessions.ingest.int.test.ts tests/integration/sessions.repo.int.test.ts`
**Proof:**
- Harness: `.claude/skills/verify-notesd` (`up --sessions`; no `--web`, since this phase does not touch web/)
- Feature-map entries: `.claude/skills/verify-notesd/features/projects.md` is read only for the drive recipe. Its R2 entry is written by Phase 5 (see Handoffs).
- Setup (from the worktree root):
  ```sh
  V=.claude/skills/verify-notesd/scripts/verify.sh
  $V up --sessions                      # prints RUN=... and URL=...; export both, e.g. RUN=<id>
  # every `$V <cmd> RUN ...` below means the printed run id ("$RUN")
  MP=5e55a001-0000-4000-8000-000000000005
  F=tests/fixtures/claude-home/projects/-home-u-mcp-notes/$MP.jsonl
  DB=$(cat ~/.local/state/notesd-verify/$RUN/db)
  # wait for ingest of the fixture (polling outside the evidence log)
  for i in $(seq 1 30); do n=$(docker exec mcp-notes-pg-verify psql -U postgres -d "$DB" -tAc "select count(*) from cc_session_prompts where session_id='$MP'"); [ "$n" = 106 ] && break; sleep 1; done
  ```
- Journey 1, every prompt stored in order:
  `$V sql RUN "select count(*), min(seq), max(seq), bool_or(truncated) from cc_session_prompts where session_id='5e55a001-0000-4000-8000-000000000005'"`
  Passes when the output is `106 | 1 | 106 | f`.
- Journey 2, the >2000-char prompt is stored byte for byte:
  `$V sql RUN "select length(text), md5(text) from cc_session_prompts where session_id='5e55a001-0000-4000-8000-000000000005' and seq=50"`
  and `jq -j 'select(.type=="user") | .message.content | select(startswith("fixture prompt 50:"))' "$F" | md5sum`.
  Passes when the length is > 2000 and the two md5 values are equal.
- Journey 3, the fake key is never stored and the rest of the prompt is byte for byte:
  `$V sql RUN "select (select count(*) from cc_session_prompts where text like '%sk-ant-api03-FAKE%') as side, (select count(*) from cc_sessions where prompts::text like '%sk-ant-api03-FAKE%' or first_prompt like '%sk-ant-api03-FAKE%' or last_prompt like '%sk-ant-api03-FAKE%') as main"`
  Passes when the output is `0 | 0`. Then compare
  `$V sql RUN "select md5(text) from cc_session_prompts where session_id='5e55a001-0000-4000-8000-000000000005' and seq=60"`
  with `jq -j 'select(.type=="user") | .message.content | select(startswith("fixture prompt 60:"))' "$F" | sed 's/sk-ant-api03-FAKE-not-a-real-key-0000000000/[redacted]/' | md5sum`.
  Passes when the two md5 values are equal.
- Journey 4, the excerpt list stays bounded and the row is current:
  `$V sql RUN "select prompts_version, jsonb_array_length(prompts), (select max(length(e->>'text')) from jsonb_array_elements(prompts) e) from cc_sessions where session_id='5e55a001-0000-4000-8000-000000000005'"`
  Passes when the output is `2 | 100 | 2000` (`PROMPTS_VERSION` = 2).
- Journey 5, the user-visible detail is redacted:
  `NODE=$(docker exec mcp-notes-pg-verify psql -U postgres -d "$DB" -tAc "select node_id from cc_sessions where session_id='$MP'")`, then
  `SG=$($V mcp RUN session_get "{\"node_id\":\"$NODE\"}"); grep -c 'sk-ant-api03-FAKE' <<<"$SG"; grep -c '\[redacted\]' <<<"$SG"`.
  Passes when the first count is `0` and the second is ≥ 1. The evidence file `NN-mcp-session_get.txt` holds the full response.
- Journey 6, the per-host backfill (legacy rows replaced, other columns frozen, idempotent, other host untouched, missing transcript redacted in place at version 1 and skipped next start, a version-1 row upgraded to 2 once its transcript is readable):
  `scripts/test-int.sh tests/integration/sessions.prompts.int.test.ts`
  Passes when all 9 tests pass. The harness has no restart and its `sql` is read-only, so it cannot produce a legacy row and then start the daemon again. This int test runs the real `startSessionIngest` against real Postgres instead.
- Invariant 5 check: `grep -n 'cc_session_prompts\|ccSessionPrompts' src/sessions/summaryWorker.ts src/sessions/view.ts src/sessions/readModel.ts` prints nothing at the end of this phase. Phase 5 later adds the one sanctioned reader in `readModel.ts`.
- Neighbor check: the Projects graph and the main fixture session are unchanged.
  `$V api RUN GET /api/projects/mcp-notes/sessions` returns 200 and lists 3 nodes (main, wall-editing child, many-prompts).
  `$V sql RUN "select first_prompt, jsonb_array_length(prompts), input_tokens, output_tokens from cc_sessions where session_id='5e55a001-0000-4000-8000-000000000001'"` returns `sketch the project-session-graph feature | 1 | 5 | 914`. The tokens include the subagent share, as `tests/integration/sessions.ingest.int.test.ts` expects.
- Cleanup: `$V down RUN`.

**Exit criteria:**
- `npm run typecheck`, `npm test` and `npm run test:int` are green.
- On a verify run with the fixture, `cc_session_prompts` holds 106 rows for the fixture session. Prompt 50 matches the file byte for byte, prompt 60 matches with only the key replaced by `[redacted]`, and the key appears in no table.
- The int test shows the backfill fills a legacy row, leaves every other column equal, is a no-op the second time, leaves other hosts alone, and redacts in place when the transcript is gone, marking that row `PROMPTS_VERSION_EXCERPTS` (1), never `PROMPTS_VERSION` (2); such a row is skipped without a write on the next start and upgraded to 2 when its transcript is readable.

## Handoffs

- **Phase 1 (done there, reconciled).** The `prompts` column comment in `src/db/schema.ts` ("capped and redacted; the full list is `cc_session_prompts`"), the `cc_session_prompts` doc ("`seq` from 1"), the `repo.ts` class doc comment naming `cc_session_prompts`, and the two new fields in `blankSessionRow` / `blankRow` are all Phase 1's edits. This phase quotes those files as Phase 1 leaves them and does not repeat them.
- **Phase 5 (read API and modal).**
  - `complete` = `prompts_version >= PROMPTS_VERSION` (2). Import `PROMPTS_VERSION` and `PROMPTS_VERSION_EXCERPTS` from `src/sessions/types.ts`.
  - Version 2: read `cc_session_prompts` ordered by `seq`, complete. Number prompts by position, not by `seq` (they are equal: 1..n with no gaps).
  - Version 1 (`PROMPTS_VERSION_EXCERPTS`): read `cc_session_prompts` too (the redacted excerpts, `truncated` where they end in `…`), but `complete: false`: older prompts and the full text were lost with the transcript.
  - Version 0: the side table may be partial; serve the `cc_sessions.prompts` excerpts, `complete: false`.
  - `truncated` on a version-2 row means cut at 256 KB.
- **Phase 5, feature map.** `.claude/skills/verify-notesd/features/projects.md`: mention the many-prompts fixture (`5e55a001-…-000000000005`, 106 prompts, #50 > 2000 chars, #60 with a fake key shown as `[redacted]`) in the R2 entry and its proof. This phase leaves the file alone so Phases 4 and 5 stay its only editors. Note: the fixture adds a third node to the mcp-notes graph. Recipes that pick `.nodes[0]` still work, because any node will do there.
- **After landing (whoever restarts the live daemon).** The first start re-reads every local transcript of this host once. Expect one log line `[notesd] sessions: prompts backfill N sessions, ...` in the daemon log. GPD's rows stay at version 0 until GPD's daemon runs this code.

## Rollback

Revert this phase's commit. The code goes back to capped, unredacted excerpts and stops writing `cc_session_prompts`. Rows already written keep their redacted excerpts and their side rows; both are harmless to the old code, which never reads the side table. The old code also never resets `prompts_version`, so if the phase is re-applied later, rows at version 2 that the old code appended to will hold a side table missing those appended prompts. To force a full refill, run `update cc_sessions set prompts_version = 0 where host = '<host>'` and restart that host's daemon. Leave the redaction of excerpts that already happened as it is (plan index: not rolled back on purpose).
