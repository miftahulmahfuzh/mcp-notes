> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/session-fork-awareness/PLAN.md` phase 2. Source: `.workflows/plan/session-fork-awareness/phase-2.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 2: Ingest detects forks and cuts the copied prefix

**Plan set:** `SESSION_FORK_AWARENESS_PLAN.md`
**Analysis:** `.workflows/analyze/20261111-093332-K7F2_code_analyzer.md`
**Satisfies:** R1, R2 — a fork is its own node linked to its parent with source `fork`, and the history it copied from that parent is not counted again
**Criteria:** R1.1, R1.2, R1.4, R1.5, R2.1, R2.3
**Depends on:** Phase 1
**Difficulty:** HARD
**Package:** `src/sessions`

---

## Goal

After this phase, every transcript the tail ingester reads from byte 0 goes through fork detection
first: a background job's `state.json`, else the rows of this host whose transcript begins with the
same uuid. A detected fork is linked to its parent with source `fork`, its `head_uuid` and fork
columns are written in the same transaction as its row, and every record it copied from its parent
(a record with a uuid that starts before the cut) is left out of its tokens, models, commits, files,
plan docs, prompts, replies, first prompt, final message, start time and the observers' batches.
A fork that so far holds only the copy has zero counts and is re-read from byte 0 on each change
until its own records arrive. A session whose fork source cannot be determined is ingested exactly
as before.

## Interface Contract

**Deletes:** none.

**Renames:** none.

**Creates:**
- `src/sessions/forkDetect.ts`: `scanFork(file, sessionId, deps): Promise<ForkScan>`, `isPendingCut(cutOffset, readTo): boolean`, types `ForkScan`, `ForkScanDeps`
- `src/sessions/transcript.ts`: method `TranscriptAccumulator.addCopied(record)` (`isCopiedRecord` and `readJsonlFrom`'s `lineStart` are Phase 1's, moved there by the reconciler)
- `src/sessions/repo.ts`: `SessionsRepo.forkCandidates(host, headUuid, excludeSessionId): Promise<ForkCandidateRow[]>`; const `FORK_CANDIDATE_LIMIT` (16)
- `src/sessions/types.ts`: `ForkCandidateRow`
- inside `startSessionIngest` (`src/sessions/ingest.ts`): closure `scanForkSafely(file, sessionId): Promise<ForkScan | null>` (never throws), sets `pendingCuts`, `forkErrorsLogged`
- `tests/fixtures/make-fork-fixtures.mjs` and the generated `tests/fixtures/claude-home-forks/**`
- `tests/helpers/forkFixtures.ts`
- `tests/unit/sessions/ingestForks.test.ts`, `tests/unit/sessions/transcriptCut.test.ts`, `tests/integration/sessions.forks.int.test.ts`
- `MemoryIngestStore.forkCandidates`, `MemoryIngestStore.setParent` (`tests/helpers/memoryIngestStore.ts`)

**Signature changes:**
- `TranscriptPatch` gains `headUuid?: string | null` and `fork?: ForkInfo | null` (both honoured only when `fromOffset === 0`)
- `TranscriptSet` gains `headUuid`, `forkCutOffset`, `forkedAt`, `forkPromptCount`, `forkDetectedBy`
- `TranscriptOffset` gains `forkCutOffset?: number | null`; `SessionsRepo.offsets(host)` fills it
- `TranscriptUpsertResult` applied branch: `{ applied: true; row }` -> `{ applied: true; row; forkLink?: SetParentResult | null }`
- `IngestStore` optional picks gain `'forkCandidates'`
- `SessionsRepo.upsertFromTranscript`: on `fromOffset 0` with `patch.fork`, ensures the parent row exists, writes the fork columns, and calls `setParentIn(tx, sid, parent, 'fork')` in the same transaction
- `mergeTranscriptPatch`: a 0-read of a fork drops a stored `started_at` at or before `forkedAt`, and a stored first prompt / final message the read does not replace

**Requires (from earlier phases):** Phase 1, exactly as its plan writes them:
- `src/sessions/fork.ts`: `jobStateFor(claudeHome, sid): Promise<ForkJobState | null>` (`{ parentSessionId, boundaryAt: Date | null, jobId, parentTranscript: string | null }`), `headUuid(file): Promise<string | null>`, `readUuidSet(file): Promise<Set<string> | null>` (null when missing), `findForkCut(file, CopiedEvidence): Promise<ForkCut>` (`{ cutOffset, final, forkedAt, promptCount, copiedRecords }`; pending `cutOffset` = end of the last complete line read; throws ENOENT), `rankForkCandidates(forkFile, ForkCandidate[]): Promise<RankedForkCandidate[]>` (best first; `ForkCandidate = { sessionId, transcriptPath, startedAt, isFork }`), types `CopiedEvidence`, `ForkJobState`
- `src/sessions/types.ts`: `ForkInfo { parentSessionId; detectedBy; cutOffset: number; final; forkedAt: Date | null; promptCount }`, `ForkDetectedBy`, `PARENT_LINK_RANK.fork = 4`, `ParentLinkSource` includes `'fork'`
- `src/db/schema.ts`: `ccSessions.headUuid`, `forkCutOffset` (bigint mode number), `forkedAt`, `forkPromptCount`, `forkDetectedBy`; check `cc_sessions_fork_info_check` (detected_by, cut_offset, prompt_count all null or all set)
- `tests/helpers/memoryIngestStore.ts blankSessionRow` already sets the five fork columns to null (Phase 1 Step 7)
- `src/sessions/transcript.ts` (Phase 1 Step 7b): `readJsonlFrom`'s `onLine(line, lineStart)` hands the raw byte offset each line starts at, and `isCopiedRecord(record, lineStart, forkCutOffset: number | null)` is exported. `fork.ts readRecordsWithOffsets` counts offsets from the same `lineStart`, so `findForkCut`'s `cutOffset` and this phase's skip agree byte for byte.

**Leaves alone (owned by others):** `ingest.ts backfillSession`/`backfillPrompts` and the fork backfill, `links.ts`, `background.ts`, README, CLAUDE.md (Phase 3); `registry.ts`, `resume.ts`, `http/sessionResume.ts` (Phase 4); `view.ts`, `readModel.ts`, `search.ts`, `transcriptSearch.ts`, `http/sessionsApi.ts`, `mcp/sessionTools.ts` (Phase 5); `web/src/*` (Phase 6); `src/sessions/fork.ts`, `schema.ts`, the migration, `STORED_RANK`, `LIST_COLUMNS` (Phase 1). `.claude/skills/verify-notesd/features/projects.md`: this phase appends its own bullet and block; Phases 5 and 6 append theirs.

## Files

| File | Action | What changes |
|---|---|---|
| `src/sessions/transcript.ts` | modify | `TranscriptAccumulator.addCopied` (after `add`, `:540` before Phase 1; anchor on the method) |
| `src/sessions/types.ts:143-197, :303-331, :336-338, :448-452` | modify | `TranscriptPatch.headUuid/fork`, `ForkCandidateRow`, `TranscriptSet` fork columns, `TranscriptUpsertResult.forkLink`, `TranscriptOffset.forkCutOffset` |
| `src/sessions/merge.ts:286-342` | modify | `mergeTranscriptPatch` writes head uuid and fork columns; a fork's 0-read drops copied start/first prompt/final message |
| `src/sessions/repo.ts:44-77, :141, :426-492` | modify | import `ForkCandidateRow`; `FORK_CANDIDATE_LIMIT`; `upsertFromTranscript` fork link; `offsets` carries `forkCutOffset`; new `forkCandidates` |
| `src/sessions/forkDetect.ts` | create | `scanFork`, `isPendingCut` |
| `src/sessions/ingest.ts:1-18, :44-45, :82-93, :356-361, :397-409, :473-544` | modify | imports, header, `IngestStore`, state, seed, `scanForkSafely`, `readFile` 0-read path |
| `tests/helpers/memoryIngestStore.ts:16-35, :166-200` | modify | `offsets` carries the cut; `upsertFromTranscript` links forks; `forkCandidates`, `setParent` |
| `tests/fixtures/make-fork-fixtures.mjs` | create | generator of the fork fixture home |
| `tests/fixtures/claude-home-forks/**` | create (generated) | parent, job fork, terminal fork, fork of a fork, pending fork (+ its own records to append), unrelated session, job dirs |
| `tests/helpers/forkFixtures.ts` | create | staging helpers and constants |
| `tests/unit/sessions/transcriptCut.test.ts` | create | line offsets, `isCopiedRecord`, `addCopied` |
| `tests/unit/sessions/ingestForks.test.ts` | create | ingest with the memory store over the fork fixtures |
| `tests/integration/sessions.forks.int.test.ts` | create | the same against Postgres, plus `forkCandidates` SQL |
| `.claude/skills/verify-notesd/features/projects.md` | modify | "Forks" sub-feature bullet and "Forks at ingest" driving block |

## Implementation Steps

### Step 1: (moved to Phase 1) `readJsonlFrom` line offsets
No edit here. Phase 1 Step 7b already changed `readJsonlFrom` so `onLine` gets `(line, lineStart)`, the raw byte offset the line starts at. This phase assumes that state.

### Step 2: (moved to Phase 1) the copied-record predicate
No edit here. Phase 1 Step 7b already exports `isCopiedRecord(record, lineStart, forkCutOffset)` from `transcript.ts` (invariant 7: a uuid record whose line starts before the cut). This phase imports it in Step 8a.

### Step 3: `TranscriptAccumulator.addCopied`
**File:** `src/sessions/transcript.ts`, insert directly after the `add(record)` method (after line 540, before `delta()`)
**Change:** A copied record feeds only the session's identity: launch cwd and entry point (first seen; Claude Code rewrites `cwd` to the fork's and keeps `entrypoint`), and branch and version (latest wins, so the fork's own records, which always follow the copy, overwrite them). It counts nothing and moves no timestamp. Without this, a fork that so far holds only the copy would have no entry point and ingest would defer it with no row (R2.3 needs the row).
**Code:**
```ts
  /**
   * A record a fork copied from its parent (`isCopiedRecord`). It fills only what identifies the
   * session itself: the launch cwd and entry point (first seen), and branch and version (the
   * fork's own records come after the copy and overwrite them). Tokens, models, prompts, replies,
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
  }
```
**Impact:** new method; `add` unchanged, so non-fork reads are byte for byte as before (invariant 4).

### Step 4: Types
**File:** `src/sessions/types.ts`
**Change 4a** (`:194-197`): inside `TranscriptPatch`, replace
```ts
  /** Union, first-seen order, capped to MAX_PLAN_DOCS. */
  planDocs?: string[];
}
```
with
```ts
  /** Union, first-seen order, capped to MAX_PLAN_DOCS. */
  planDocs?: string[];
  /**
   * uuid of the transcript's first record that has one (src/sessions/fork.ts headUuid). Honoured
   * only on fromOffset 0; undefined or null keeps the stored value.
   */
  headUuid?: string | null;
  /**
   * The read is of a fork (src/sessions/forkDetect.ts scanFork). Honoured only on fromOffset 0:
   * the repo writes the fork columns and links the parent with source `fork` in the same
   * transaction (the parent row is created if missing), and the merge drops a stored start, first
   * prompt and final message that an earlier, uncut read took from the copy. Undefined or null
   * keeps the stored fork columns.
   */
  fork?: ForkInfo | null;
}

/**
 * A row that may be a fork's parent (SessionsRepo.forkCandidates): same host, same head uuid, not
 * the fork itself, not one of its descendants, created no later than it, with a transcript path.
 */
export interface ForkCandidateRow {
  sessionId: string;
  transcriptPath: string;
  startedAt: Date | null;
  createdAt: Date;
  /** Non-null when the candidate is itself a known fork (it loses a ranking tie to an original). */
  forkDetectedBy: ForkDetectedBy | null;
}
```
**Change 4b** (`:303-331`): replace the whole `TranscriptSet` definition with
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
>;
```
**Change 4c** (`:336-338`): replace `TranscriptUpsertResult` with
```ts
/** `forkLink`: what linking the fork's parent did (only for an applied 0-read that carried `fork`). */
export type TranscriptUpsertResult =
  | { applied: true; row: SessionRef; forkLink?: SetParentResult | null }
  | { applied: false; reason: 'offset_mismatch' | 'other_host'; storedOffset: number; row: SessionRef };
```
**Change 4d** (`:448-452`): replace `TranscriptOffset` with
```ts
export interface TranscriptOffset {
  offset: number;
  size: number | null;
  path: string | null;
  /**
   * The row's `fork_cut_offset` (null: not a fork). At or past `offset` the fork's cut is still
   * pending, so the ingester reads it from byte 0 again (forkDetect.ts isPendingCut).
   */
  forkCutOffset?: number | null;
}
```
**Impact:** additive. `ForkInfo`, `ForkDetectedBy` and `SetParentResult` are already declared in this file (the first two by Phase 1).

### Step 5: Merge writes the fork columns and drops copied leftovers
**File:** `src/sessions/merge.ts:286-342`
**Change:** Replace the doc comment and the whole `mergeTranscriptPatch` function with the version below. For every non-fork patch the result is identical to today's plus the five fork columns echoing the row (a 0-read may set `headUuid`). For a fork's 0-read (`patch.fork` set) the fork columns come from the patch, and three scalars stop falling back to stored values an uncut read took from the copy: `started_at` (dropped when at or before `forkedAt`), `first_prompt` and `final_message` (null when the read has none). A start the SessionStart hook wrote (the fork's own launch, after `forkedAt`) is kept.
**Code:**
```ts
/**
 * The column values `row` takes after applying `patch`. Pure; the caller (SessionsRepo) has
 * already checked the offset precondition. See TranscriptPatch for the rules. A re-read from byte 0
 * replaces tokens, models and commits, starting from `subagents` (the session's subagent share,
 * which lives in other files) instead of from zero. Every prompt text written (excerpts, first and
 * last prompt) is redacted, so a row written before redaction existed is cleaned on its next write.
 *
 * Forks: a re-read from byte 0 carrying `patch.fork` writes the fork columns, and leaves out what
 * an earlier read without the cut stored from the parent's copied records: a `started_at` at or
 * before the fork point, and a first prompt or final message this read does not replace.
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
  const fork = reset ? (patch.fork ?? null) : null;
  const copiedStart =
    fork !== null && fork.forkedAt !== null && row.startedAt !== null && row.startedAt.getTime() <= fork.forkedAt.getTime();
  const headUuid = reset && patch.headUuid !== undefined && patch.headUuid !== null ? patch.headUuid : row.headUuid;
  return {
    repo: patch.repo ?? row.repo,
    cwd: patch.cwd ?? row.cwd,
    branch: patch.branch ?? row.branch,
    name: clipOrKeep(patch.name, MAX_TITLE_CHARS) ?? row.name,
    customTitle: clipOrKeep(patch.customTitle, MAX_TITLE_CHARS) ?? row.customTitle,
    aiTitle: clipOrKeep(patch.aiTitle, MAX_TITLE_CHARS) ?? row.aiTitle,
    firstPrompt: reset ? (firstPrompt ?? (fork !== null ? null : storedFirst)) : (storedFirst ?? firstPrompt ?? null),
    lastPrompt: excerptOrKeep(patch.lastPrompt) ?? redactStored(row.lastPrompt),
    entrypoint: patch.entrypoint ?? row.entrypoint,
    version: patch.version ?? row.version,
    finalMessage: clipOrKeep(patch.finalMessage, MAX_FINAL_MESSAGE_CHARS) ?? (fork !== null ? null : row.finalMessage),
    startedAt: earliest(copiedStart ? null : row.startedAt, patch.startedAt),
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
    headUuid,
    forkCutOffset: fork === null ? row.forkCutOffset : fork.cutOffset,
    forkedAt: fork === null ? row.forkedAt : fork.forkedAt,
    forkPromptCount: fork === null ? row.forkPromptCount : fork.promptCount,
    forkDetectedBy: fork === null ? row.forkDetectedBy : fork.detectedBy,
  };
}
```
**Impact:** the three fork columns that `cc_sessions_fork_info_check` keeps together are always written together (all from `fork`, or all from the row).

### Step 6: Repo: fork link in the upsert, cut in `offsets`, `forkCandidates`
**File:** `src/sessions/repo.ts`
**Change 6a** (`:44-77`, the `./types.js` import list): add `type ForkCandidateRow,` (alphabetical position after `type HookStartResult,` is fine; any position compiles).

**Change 6b** (after line 141, `const MAX_SESSION_ID_CHARS = 128;`): add
```ts
/** At most this many rows share a head uuid in practice (a session and its forks); more is noise. */
const FORK_CANDIDATE_LIMIT = 16;
```

**Change 6c** (`:426-478`): replace the doc comment and the whole `upsertFromTranscript` method with
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
   *
   * A read from byte 0 of a fork (`patch.fork`) also writes the fork columns and links the parent
   * with source `fork` through setParentIn (self and cycle checks, rank) in the same transaction.
   * The parent row is created first when missing, as the hook path does: a fork may be read
   * before its parent.
   */
  async upsertFromTranscript(patch: TranscriptPatch): Promise<TranscriptUpsertResult> {
    assertSessionId(patch.sessionId);
    assertHost(patch.host);
    assertOffset(patch.fromOffset, 'fromOffset');
    assertOffset(patch.toOffset, 'toOffset');
    assertOffset(patch.size, 'size');
    if (patch.toOffset < patch.fromOffset) throw new RangeError('toOffset is before fromOffset');
    const fork = patch.fromOffset === 0 ? (patch.fork ?? null) : null;
    if (fork !== null) {
      assertSessionId(fork.parentSessionId, 'fork parent session id');
      assertOffset(fork.cutOffset, 'fork cutOffset');
    }
    await this.ensureSessionRow(patch.sessionId, patch.host);
    if (fork !== null && fork.parentSessionId !== patch.sessionId) await this.ensureSessionRow(fork.parentSessionId, patch.host);
    const prompts = storedPrompts(patch.prompts);
    const replies = storedReplies(patch.prompts, patch.replies);
    const leading = patch.fromOffset === 0 ? null : storedLeadingReply(patch.leadingReply);
    const promptImages = await this.ingestPromptImages(prompts);
    return this.db.transaction(async (tx) => {
      const row = await this.lock(tx, patch.sessionId);
      if (row.host !== patch.host) {
        return { applied: false, reason: 'other_host', storedOffset: row.transcriptOffset, row: toRef(row) } as const;
      }
      if (patch.fromOffset !== 0 && row.transcriptOffset !== patch.fromOffset) {
        return { applied: false, reason: 'offset_mismatch', storedOffset: row.transcriptOffset, row: toRef(row) } as const;
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
        .returning(REF_COLUMNS);
      const next = updated[0];
      if (!next) throw new Error(`cc_sessions row ${patch.sessionId} disappeared`);
      const forkLink = fork === null ? null : await this.setParentIn(tx, patch.sessionId, fork.parentSessionId, 'fork');
      return { applied: true, row: next, forkLink } as const;
    });
  }
```

**Change 6d** (`:479-492`): replace the `offsets` method with
```ts
  /** session_id -> stored offset/size/path and fork cut, for every row of `host`. The ingester's resume point. */
  async offsets(host: string): Promise<Map<string, TranscriptOffset>> {
    const rows = await this.db
      .select({
        sessionId: ccSessions.sessionId,
        offset: ccSessions.transcriptOffset,
        size: ccSessions.transcriptSize,
        path: ccSessions.transcriptPath,
        forkCutOffset: ccSessions.forkCutOffset,
      })
      .from(ccSessions)
      .where(eq(ccSessions.host, host));
    return new Map(rows.map((r) => [r.sessionId, { offset: r.offset, size: r.size, path: r.path, forkCutOffset: r.forkCutOffset }]));
  }

  /**
   * Rows that may be the parent of the fork `excludeSessionId`: same host, a transcript whose first
   * uuid record is `headUuid`, a transcript path, never the session itself or one of its
   * descendants (a later fork of this session holds all of its records too), and created no later
   * than it (or than now, before it has a row). The last rule keeps an original that is read from
   * byte 0 again from turning into a fork of a fork made from it that was ingested without a link:
   * the original's row is always the older one on a host whose daemon saw both start. Oldest
   * first; src/sessions/fork.ts rankForkCandidates decides.
   */
  async forkCandidates(host: string, headUuid: string, excludeSessionId: string): Promise<ForkCandidateRow[]> {
    assertHost(host);
    assertSessionId(excludeSessionId);
    if (headUuid.length === 0) return [];
    const now = this.now().toISOString();
    const rows = await this.db
      .select({
        sessionId: ccSessions.sessionId,
        transcriptPath: ccSessions.transcriptPath,
        startedAt: ccSessions.startedAt,
        createdAt: ccSessions.createdAt,
        forkDetectedBy: ccSessions.forkDetectedBy,
      })
      .from(ccSessions)
      .where(
        and(
          eq(ccSessions.host, host),
          eq(ccSessions.headUuid, headUuid),
          ne(ccSessions.sessionId, excludeSessionId),
          isNotNull(ccSessions.transcriptPath),
          sql`${ccSessions.sessionId} not in (
            with recursive down(id, depth) as (
              select d.session_id, 1 from cc_sessions d where d.parent_session_id = ${excludeSessionId}
              union all
              select s.session_id, down.depth + 1 from cc_sessions s join down on s.parent_session_id = down.id where down.depth < 64
            )
            select id from down
          )`,
          sql`${ccSessions.createdAt} <= coalesce((select c.created_at from cc_sessions c where c.session_id = ${excludeSessionId}), ${now}::timestamptz)`,
        ),
      )
      .orderBy(asc(ORDER_AT), asc(ccSessions.sessionId))
      .limit(FORK_CANDIDATE_LIMIT);
    return rows.flatMap((r) => (r.transcriptPath === null ? [] : [{ ...r, transcriptPath: r.transcriptPath }]));
  }
```
**Impact:** `ne`, `isNotNull`, `asc`, `and`, `sql` are already imported (`:2`). `ORDER_AT` exists (`:136`). Uses Phase 1's `(host, head_uuid)` index.

### Step 7: The fork detector
**File:** `src/sessions/forkDetect.ts` (new)
**Change:** Create. It composes Phase 1's primitives; it reads files and calls the store's candidate lookup, writes nothing.
**Code:**
```ts
/**
 * Fork detection for one transcript read from byte 0, composed from the src/sessions/fork.ts
 * primitives. The tail ingester runs it before every read from byte 0 (ingest.ts readFile, through
 * `scanForkSafely`), and the one-time fork backfill (Phase 3) runs it the same way.
 *
 * Evidence, best first:
 * 1. A background job's `<claudeHome>/jobs/<short>/state.json` names the parent (`jobStateFor`).
 *    The copy is the uuids of the job's parent snapshot (else of the parent row's own transcript)
 *    together with the job's `forkBoundaryAt` when it has one: `job`. The boundary alone when no
 *    uuid set is readable: `time`. With neither, the fork is linked with nothing cut.
 * 2. No job: the rows of this host whose transcript begins with the same uuid
 *    (`IngestStore.forkCandidates`, which already leaves out this session's descendants and rows
 *    created after it), ranked by the longest copied prefix (`rankForkCandidates`). The winner's
 *    uuid set gives the cut: `uuid`. A fork of a fork thus goes to the fork it was copied from.
 * A file with no uuid record yet, or no candidate sharing its head, is not a fork. Anything that
 * throws after the head uuid was read comes back as `error` with `fork: null`.
 */
import { findForkCut, headUuid as readHeadUuid, jobStateFor, rankForkCandidates, readUuidSet, type CopiedEvidence, type ForkJobState } from './fork.js';
import type { ForkCandidateRow, ForkDetectedBy, ForkInfo } from './types.js';

/** What a scan of one transcript found. `fork` null: not a fork, or not determinable (`error` says which). */
export interface ForkScan {
  /** uuid of the file's first record that has one; null when it has none yet. */
  headUuid: string | null;
  fork: ForkInfo | null;
  /** Why detection gave up after reading the head uuid; null when it did not. */
  error: string | null;
}

export interface ForkScanDeps {
  /** `config.sessions.claudeHome`: job records are under `<claudeHome>/jobs`. */
  claudeHome: string;
  /** This machine (`os.hostname()`): candidates are rows of this host only. */
  host: string;
  /** SessionsRepo.forkCandidates. Absent: only job state can find a fork. */
  forkCandidates?: (host: string, headUuid: string, excludeSessionId: string) => Promise<ForkCandidateRow[]>;
}

/**
 * True while a fork's cut is not final: the read (or the stored offset) reaches no further than
 * the cut, so no record of the fork's own has been read past it. Such a fork is read from byte 0
 * again on its next change.
 */
export function isPendingCut(cutOffset: number, readTo: number): boolean {
  return readTo <= cutOffset;
}

/** Fork detection for `file`, the transcript of `sessionId`. Throws only if reading the head uuid throws. */
export async function scanFork(file: string, sessionId: string, deps: ForkScanDeps): Promise<ForkScan> {
  const head = await readHeadUuid(file);
  if (head === null) return { headUuid: null, fork: null, error: null };
  try {
    const candidates = deps.forkCandidates === undefined ? [] : await deps.forkCandidates(deps.host, head, sessionId);
    const job = await jobStateFor(deps.claudeHome, sessionId);
    const fork =
      job !== null && job.parentSessionId.toLowerCase() !== sessionId
        ? await jobFork(file, job, candidates)
        : await uuidFork(file, candidates);
    return { headUuid: head, fork, error: null };
  } catch (err) {
    return { headUuid: head, fork: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** A background fork: the job names the parent; the copy is the parent's uuids, the boundary, or both. */
async function jobFork(file: string, job: ForkJobState, candidates: readonly ForkCandidateRow[]): Promise<ForkInfo> {
  const parentSessionId = job.parentSessionId.toLowerCase();
  const parentFile = job.parentTranscript ?? candidates.find((c) => c.sessionId === parentSessionId)?.transcriptPath ?? null;
  const uuids = parentFile === null ? null : await readUuidSet(parentFile);
  let evidence: CopiedEvidence;
  let detectedBy: ForkDetectedBy = 'job';
  if (job.boundaryAt !== null) {
    evidence = uuids === null ? { boundaryAt: job.boundaryAt } : { boundaryAt: job.boundaryAt, uuids };
    if (uuids === null) detectedBy = 'time';
  } else {
    // No boundary and no readable parent: nothing is known to be copied, so nothing is cut.
    evidence = uuids ?? new Set<string>();
  }
  const cut = await findForkCut(file, evidence);
  return {
    parentSessionId,
    detectedBy,
    cutOffset: cut.cutOffset,
    final: cut.final,
    forkedAt: job.boundaryAt ?? cut.forkedAt,
    promptCount: cut.promptCount,
  };
}

/** No job: the candidate sharing the longest copied prefix is the parent. Null when none shares anything. */
async function uuidFork(file: string, candidates: readonly ForkCandidateRow[]): Promise<ForkInfo | null> {
  if (candidates.length === 0) return null;
  const ranked = await rankForkCandidates(
    file,
    candidates.map((c) => ({ sessionId: c.sessionId, transcriptPath: c.transcriptPath, startedAt: c.startedAt, isFork: c.forkDetectedBy !== null })),
  );
  const best = ranked[0];
  if (best === undefined) return null;
  const copied = await readUuidSet(best.transcriptPath);
  if (copied === null) return null;
  const cut = await findForkCut(file, copied);
  if (cut.copiedRecords === 0) return null;
  return {
    parentSessionId: best.sessionId,
    detectedBy: 'uuid',
    cutOffset: cut.cutOffset,
    final: cut.final,
    forkedAt: cut.forkedAt,
    promptCount: cut.promptCount,
  };
}
```
**Impact:** new module. `src/sessions/fork.ts` (Phase 1) stays as written.

### Step 8: Ingest wires detection into the 0-read
**File:** `src/sessions/ingest.ts`
**Change 8a** (`:1-18`, imports): replace the `./transcript.js` import block with the block below, which also adds the `./forkDetect.js` import above it.
```ts
import { isPendingCut, scanFork, type ForkScan } from './forkDetect.js';
import {
  buildTranscriptPatch,
  EXCLUDED_ENTRYPOINTS,
  isCopiedRecord,
  parseRecord,
  readJsonlFrom,
  TranscriptAccumulator,
  type TranscriptCarry,
  type TranscriptRecord,
} from './transcript.js';
```

**Change 8b** (`:44-45`, header): replace
```ts
 * - Rows are written only through `SessionsRepo.upsertFromTranscript` (phase 1), with
 *   `host = os.hostname()`. Ingest never writes parent links, tmux or summaries.
```
with
```ts
 * - Rows are written only through `SessionsRepo.upsertFromTranscript` (phase 1), with
 *   `host = os.hostname()`. Ingest writes no tmux or summaries, and one kind of parent link only:
 *   `fork`, in the same transaction as the fork's row (see Forks).
 * - Forks: every read from byte 0 runs fork detection first (forkDetect.ts scanFork: a background
 *   job's state.json, else the rows of this host that share the file's head uuid). In a fork,
 *   records that have a uuid and start before the cut (transcript.ts isCopiedRecord) are the
 *   parent's copied history: they feed only cwd, entry point, branch and version, and are left out
 *   of the row's counts and of the observers' batch records. Records without a uuid are always
 *   read. While a fork holds only copied records its cut is pending: the read stops where
 *   detection stopped and every later read starts at byte 0 again until its first own record
 *   arrives (after a restart, a stored `fork_cut_offset >= transcript_offset` says so). Detection
 *   never fails a read: an error reads the file as an ordinary session and is logged once, except
 *   for a fork whose cut is pending, which waits for its next change.
```

**Change 8c** (`:82-93`): replace the `IngestStore` doc and type with
```ts
/**
 * The `SessionsRepo` methods ingest uses. Unit tests pass an in-memory implementation; one without
 * the subagent methods leaves subagent transcripts unread; one without the three prompts methods
 * skips the prompts backfill; one without `forkCandidates` finds forks from job state only.
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
    >
  >;
```

**Change 8d** (`:360-361`, inside `startSessionIngest`): after
```ts
  /** Files with no entry point yet and no row: size at the last look, re-read only when it changes. */
  const deferred = new Map<string, number>();
```
insert
```ts
  /** Forks whose cut is not final yet (only copied records read so far): every read starts at byte 0. */
  const pendingCuts = new Set<string>();
  /** Sessions whose failed fork detection was already logged (once each). */
  const forkErrorsLogged = new Set<string>();
  const forkCandidates = options.store.forkCandidates?.bind(options.store);
```

**Change 8e** (`:397-409`): replace `seed` with
```ts
  const seed = (): Promise<void> => {
    seeded ??= Promise.all([options.store.offsets(host), options.store.subagentOffsets?.(host)]).then(
      ([stored, storedSubs]) => {
        for (const [sessionId, entry] of stored) {
          offsets.set(sessionId, entry.offset);
          const cut = entry.forkCutOffset ?? null;
          if (cut !== null && entry.offset > 0 && isPendingCut(cut, entry.offset)) pendingCuts.add(sessionId);
        }
        for (const [file, offset] of storedSubs ?? []) subOffsets.set(file, offset);
      },
      (err: unknown) => {
        seeded = null; // retry on the next pass
        throw err;
      },
    );
    return seeded;
  };
```

**Change 8f** (`:473-544`): replace the `readFile` doc comment and function with the code below, which also defines `scanForkSafely` just above it. For a read that does not start at byte 0 nothing changes: no scan, the cut is null, `isCopiedRecord` is always false, and the patch and batch are as before.
```ts
  /**
   * Fork detection for a read from byte 0 (forkDetect.ts scanFork). Never throws. Null: the head
   * uuid could not be read (logged once per session). A scan with `error` set: the head uuid is
   * known, the fork is not (logged once per session). Phase 3's backfill asks the same question
   * through this function.
   */
  const scanForkSafely = async (file: string, sessionId: string): Promise<ForkScan | null> => {
    const failed = (message: string): void => {
      if (forkErrorsLogged.has(sessionId)) return;
      forkErrorsLogged.add(sessionId);
      log(`[notesd] sessions: fork detection for ${sessionId} failed, reading it as an ordinary session: ${message.slice(0, LOG_ERROR_CHARS)}`);
    };
    try {
      const scan = await scanFork(file, sessionId, { claudeHome: options.claudeHome, host, ...(forkCandidates !== undefined ? { forkCandidates } : {}) });
      if (scan.error !== null) failed(scan.error);
      return scan;
    } catch (err) {
      failed(errorMessage(err));
      return null;
    }
  };

  /**
   * Reads what is new in one file and writes the row. Returns the bytes consumed (0: nothing
   * written). A compare-and-set miss (`offset_mismatch`) adopts the repo's offset and reads once more.
   * A read from byte 0 runs fork detection first and leaves a fork's copied records out (header, Forks).
   */
  const readFile = async (file: string): Promise<number> => {
    const subagent = subagentFromPath(file);
    if (subagent !== null) return readSubagentFile(file, subagent.sessionId, subagent.agentId);
    const sessionId = sessionIdFromPath(file);
    if (sessionId === null) return 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (excluded.has(file) || closed) return 0;
      let size: number;
      try {
        size = (await stat(file)).size;
      } catch {
        return 0; // deleted (Claude Code prunes old transcripts)
      }
      const known = offsets.get(sessionId) ?? 0;
      if (size === known || deferred.get(file) === size) return 0;
      // A fork whose cut is pending is read whole again: the bytes after its stored offset may be
      // the rest of the copy rather than its own records.
      const fromOffset = size < known || pendingCuts.has(sessionId) ? 0 : known;
      let scan: ForkScan | null = null;
      if (fromOffset === 0) {
        scan = await scanForkSafely(file, sessionId);
        // Read without its cut, a pending fork would count the copy: wait for the next change or sweep.
        if ((scan === null || scan.error !== null) && pendingCuts.has(sessionId)) return 0;
      }
      const fork = scan?.fork ?? null;
      const cutOffset = fork?.cutOffset ?? null;
      const acc = new TranscriptAccumulator(sessionId, fromOffset === 0 ? undefined : carries.get(sessionId));
      const keepRecords = [...observers].some((o) => o.onBatch !== undefined);
      const records: TranscriptRecord[] = [];
      const read = await readJsonlFrom(
        file,
        fromOffset,
        (line, lineStart) => {
          const record = parseRecord(line);
          if (record === null) return;
          if (isCopiedRecord(record, lineStart, cutOffset)) {
            acc.addCopied(record);
            return;
          }
          acc.add(record);
          if (keepRecords) records.push(record);
        },
        {
          shouldStop: () => closed,
          // A pending cut ends where detection stopped reading: what follows may be more of the copy.
          ...(fork !== null && !fork.final ? { until: fork.cutOffset } : {}),
          ...(options.chunkBytes !== undefined ? { chunkBytes: options.chunkBytes } : {}),
        },
      );
      if (read.endOffset <= fromOffset) {
        if (size < known) offsets.set(sessionId, read.endOffset);
        return 0;
      }
      const delta = acc.delta();
      let repo: string | null = null;
      if (fromOffset === 0) {
        if (delta.entrypoint !== null && EXCLUDED_ENTRYPOINTS.has(delta.entrypoint)) {
          excluded.add(file);
          return 0;
        }
        if (delta.entrypoint === null && !offsets.has(sessionId)) {
          // Only bookkeeping records so far and no row: wait for the first message.
          deferred.set(file, size);
          return 0;
        }
        repo = await resolver.resolve(delta.cwd, path.basename(path.dirname(file)));
      }
      const patch = buildTranscriptPatch(delta, { host, transcriptPath: file, fromOffset, toOffset: read.endOffset, size: read.size, repo });
      patch.commits = await withRangeCommits(delta.commits, delta.commitRanges, gitLog);
      if (scan !== null && scan.headUuid !== null) patch.headUuid = scan.headUuid;
      if (fork !== null) patch.fork = fork;
      const result = await options.store.upsertFromTranscript(patch);
      if (result.applied) {
        offsets.set(sessionId, read.endOffset);
        carries.set(sessionId, acc.carry());
        deferred.delete(file);
        if (fromOffset === 0) {
          if (fork !== null && isPendingCut(fork.cutOffset, read.endOffset)) pendingCuts.add(sessionId);
          else pendingCuts.delete(sessionId);
        }
        if (fork !== null && (result.forkLink === 'cycle' || result.forkLink === 'missing')) {
          log(`[notesd] sessions: fork ${sessionId} not linked to ${fork.parentSessionId}: ${result.forkLink}`);
        }
        notifyBatch({ sessionId, host, transcriptPath: file, fromOffset, toOffset: read.endOffset, records });
        return Math.max(1, read.endOffset - fromOffset);
      }
      if (result.reason === 'other_host') {
        excluded.add(file);
        log(`[notesd] sessions: ${sessionId} belongs to host ${result.row.host}; not ingesting ${file}`);
        return 0;
      }
      offsets.set(sessionId, result.storedOffset);
      carries.delete(sessionId);
    }
    return 0;
  };
```
No `ForkInfo` import is needed in `ingest.ts`: `scan.fork` is typed through `ForkScan`.
**Impact:** a non-fork 0-read costs one extra head read (until the first uuid record), one `stat` of `<claudeHome>/jobs/<short>/state.json` and one indexed query, and its patch gains `headUuid`; counts, prompts and batches are unchanged (invariant 4). A `close()` during a fork read leaves `endOffset <= cutOffset`, which `isPendingCut` treats as pending, so the next read starts at 0 again.

### Step 9: Memory store mirrors the repo
**File:** `tests/helpers/memoryIngestStore.ts`
**Change 9a** (`:16-35`, the `../../src/sessions/types.js` import): replace it with
```ts
import {
  PARENT_LINK_RANK,
  PROMPTS_VERSION,
  PROMPTS_VERSION_EXCERPTS,
  REPLIES_VERSION,
  type ForkCandidateRow,
  type ParentLinkSource,
  type PromptsBackfillCandidate,
  type PromptsReplacement,
  type RedactStoredPromptsResult,
  type ReplacePromptsResult,
  type ReplyContent,
  type SessionRow,
  type SetParentResult,
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
**Change 9b** (`:166-200`): replace `offsets` and `upsertFromTranscript` with the code below, and add `forkCandidates` and `setParent` right after `upsertFromTranscript`.
```ts
  async offsets(host: string): Promise<Map<string, TranscriptOffset>> {
    const out = new Map<string, TranscriptOffset>();
    for (const row of this.rows.values()) {
      if (row.host === host) {
        out.set(row.sessionId, { offset: row.transcriptOffset, size: row.transcriptSize, path: row.transcriptPath, forkCutOffset: row.forkCutOffset });
      }
    }
    return out;
  }

  async upsertFromTranscript(patch: TranscriptPatch): Promise<TranscriptUpsertResult> {
    this.patches.push(patch);
    const row = this.rows.get(patch.sessionId) ?? blankSessionRow(patch.sessionId, patch.host);
    this.rows.set(patch.sessionId, row);
    if (row.host !== patch.host) return { applied: false, reason: 'other_host', storedOffset: row.transcriptOffset, row };
    if (patch.fromOffset !== 0 && row.transcriptOffset !== patch.fromOffset) {
      return { applied: false, reason: 'offset_mismatch', storedOffset: row.transcriptOffset, row };
    }
    const reset = patch.fromOffset === 0;
    const fork = reset ? (patch.fork ?? null) : null;
    if (fork !== null && fork.parentSessionId !== patch.sessionId && !this.rows.has(fork.parentSessionId)) {
      this.rows.set(fork.parentSessionId, blankSessionRow(fork.parentSessionId, patch.host));
    }
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
    const forkLink = fork === null ? null : this.setParent(patch.sessionId, fork.parentSessionId, 'fork');
    return { applied: true, row: next, forkLink };
  }

  /** SessionsRepo.forkCandidates over the Map: same host and head, no descendants, none created later. */
  async forkCandidates(host: string, headUuid: string, excludeSessionId: string): Promise<ForkCandidateRow[]> {
    const descendants = new Set<string>();
    let frontier = [excludeSessionId];
    for (let depth = 0; depth < 64 && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const r of this.rows.values()) {
        if (r.parentSessionId !== null && frontier.includes(r.parentSessionId) && !descendants.has(r.sessionId)) {
          descendants.add(r.sessionId);
          next.push(r.sessionId);
        }
      }
      frontier = next;
    }
    const selfCreated = (this.rows.get(excludeSessionId)?.createdAt ?? new Date()).getTime();
    return [...this.rows.values()].flatMap((r) =>
      r.host === host &&
      r.headUuid === headUuid &&
      r.sessionId !== excludeSessionId &&
      r.transcriptPath !== null &&
      !descendants.has(r.sessionId) &&
      r.createdAt.getTime() <= selfCreated
        ? [{ sessionId: r.sessionId, transcriptPath: r.transcriptPath, startedAt: r.startedAt, createdAt: r.createdAt, forkDetectedBy: r.forkDetectedBy }]
        : [],
    );
  }

  /** SessionsRepo.setParentIn over the Map: self and cycles refused, a better stored source kept. */
  setParent(childId: string, parentId: string, source: ParentLinkSource): SetParentResult {
    if (childId === parentId) return 'self';
    let id: string | null = parentId;
    for (let depth = 0; id !== null && depth <= 64; depth += 1) {
      if (id === childId) return 'cycle';
      id = this.rows.get(id)?.parentSessionId ?? null;
    }
    const child = this.rows.get(childId);
    if (child === undefined) return 'missing';
    const stored = child.parentLinkSource === null ? 0 : PARENT_LINK_RANK[child.parentLinkSource];
    if (stored > PARENT_LINK_RANK[source]) return 'kept';
    this.rows.set(childId, { ...child, parentSessionId: parentId, parentLinkSource: source });
    return 'set';
  }
```
**Impact:** every existing unit test that uses `MemoryIngestStore` now runs content detection too (no fixture shares a head uuid, so none is a fork).

### Step 10: Fork fixtures (a generator, then its output)
**File:** `tests/fixtures/make-fork-fixtures.mjs` (new). Run it once (`node tests/fixtures/make-fork-fixtures.mjs`) and commit `tests/fixtures/claude-home-forks/` with it. It is a separate fixture home on purpose: adding these sessions to `tests/fixtures/claude-home` would change the counts that existing ingest tests and the verify map assert.
**Code:**
```js
#!/usr/bin/env node
// Writes tests/fixtures/claude-home-forks: a parent session and its forks, shaped like Claude Code
// 2.1.3xx forks as measured on 2026-11-11 (fork JM-UJ of DM-OV): a fork's transcript starts with
// records written for it without a uuid (ai-title, agent-name, mode), then a copy of the parent's
// conversation (same uuid, parentUuid, timestamp, message.id and usage; sessionId rewritten), then
// its own records. A background fork also has <home>/jobs/<first 8 of its id>/state.json and
// parent-transcript.jsonl. Deterministic: rerun it and `git diff` shows nothing. Constants are
// mirrored in tests/helpers/forkFixtures.ts.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-home-forks');
const DIR = '-home-u-mcp-notes';
const CWD = '/home/u/mcp-notes';
const SID = {
  parent: 'f0a0a001-0000-4000-8000-000000000001',
  job: 'f0b0b001-0000-4000-8000-000000000002',
  terminal: 'f0c0c001-0000-4000-8000-000000000003',
  forkOfFork: 'f0d0d001-0000-4000-8000-000000000004',
  pending: 'f0f0f001-0000-4000-8000-000000000005',
  unrelated: 'f0e0e001-0000-4000-8000-000000000006',
};
const BOUNDARY = '2026-11-01T01:05:05.000Z';
const PARENT_MODEL = 'claude-haiku-4-5';
const FORK_MODEL = 'claude-opus-5-5';
const PLAN = '/home/u/mcp-notes/docs/plans/fork-plan.md';

const uuid = (series, n) => `${series}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const usage = (input, output, cacheRead = 0, cacheWrite = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
});

function prompt(id, parent, at, text) {
  return { type: 'user', uuid: id, parentUuid: parent, timestamp: at, message: { role: 'user', content: text } };
}
function reply(id, parent, at, msgId, model, text, use, before = []) {
  return {
    type: 'assistant',
    uuid: id,
    parentUuid: parent,
    timestamp: at,
    message: { id: msgId, type: 'message', model, role: 'assistant', content: [...before, { type: 'text', text }], usage: use },
  };
}
function commitCall(id, parent, at, msgId, model, toolId, use) {
  return {
    type: 'assistant',
    uuid: id,
    parentUuid: parent,
    timestamp: at,
    message: {
      id: msgId,
      type: 'message',
      model,
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command: 'git commit -m "x"' } }],
      usage: use,
    },
  };
}
function commitResult(id, parent, at, toolId, sha, subject) {
  const out = `[main ${sha}] ${subject}\n 1 file changed, 1 insertion(+)`;
  return {
    type: 'user',
    uuid: id,
    parentUuid: parent,
    timestamp: at,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: out }] },
    toolUseResult: { stdout: out, stderr: '', interrupted: false },
  };
}

const P = 'a1';
const parentBefore = [
  prompt(uuid(P, 1), null, '2026-11-01T01:00:00.000Z', 'parent prompt one: build the fork fixture'),
  commitCall(uuid(P, 2), uuid(P, 1), '2026-11-01T01:00:05.000Z', 'msg_p1', PARENT_MODEL, 'toolu_p1', usage(100, 10, 1000, 50)),
  commitResult(uuid(P, 3), uuid(P, 2), '2026-11-01T01:00:06.000Z', 'toolu_p1', 'a1b2c3d', 'feat: parent work before the fork'),
  reply(uuid(P, 4), uuid(P, 3), '2026-11-01T01:00:10.000Z', 'msg_p2', PARENT_MODEL, 'Parent reply one.', usage(200, 20, 2000, 0), [
    { type: 'tool_use', id: 'toolu_p2', name: 'Edit', input: { file_path: PLAN, old_string: 'a', new_string: 'b' } },
  ]),
  prompt(uuid(P, 5), uuid(P, 4), '2026-11-01T01:05:00.000Z', 'parent prompt two: wrap up'),
  reply(uuid(P, 6), uuid(P, 5), BOUNDARY, 'msg_p3', PARENT_MODEL, 'Parent reply two.', usage(300, 30)),
];
const parentAfter = [
  prompt(uuid(P, 7), uuid(P, 6), '2026-11-01T02:00:00.000Z', 'parent prompt three: after the fork'),
  reply(uuid(P, 8), uuid(P, 7), '2026-11-01T02:00:05.000Z', 'msg_p4', PARENT_MODEL, 'Parent reply three.', usage(400, 40)),
];
const jobOwn = [
  prompt(uuid('b2', 1), uuid(P, 6), '2026-11-01T01:20:00.000Z', 'job fork prompt: try the other approach'),
  commitCall(uuid('b2', 2), uuid('b2', 1), '2026-11-01T01:20:05.000Z', 'msg_j1', FORK_MODEL, 'toolu_j1', usage(60, 6)),
  commitResult(uuid('b2', 3), uuid('b2', 2), '2026-11-01T01:20:06.000Z', 'toolu_j1', '0d0e0f1', 'fix: job fork work'),
  reply(uuid('b2', 4), uuid('b2', 3), '2026-11-01T01:20:10.000Z', 'msg_j2', FORK_MODEL, 'Job fork reply.', usage(70, 7)),
];
const terminalOwn = [
  prompt(uuid('c3', 1), uuid(P, 6), '2026-11-01T01:30:00.000Z', 'terminal fork prompt: compare the two'),
  reply(uuid('c3', 2), uuid('c3', 1), '2026-11-01T01:30:05.000Z', 'msg_t1', FORK_MODEL, 'Terminal fork reply.', usage(50, 5)),
];
const forkOfForkOwn = [
  prompt(uuid('d4', 1), uuid('c3', 2), '2026-11-01T01:40:00.000Z', 'fork of a fork prompt: go deeper'),
  reply(uuid('d4', 2), uuid('d4', 1), '2026-11-01T01:40:05.000Z', 'msg_ff1', FORK_MODEL, 'Fork of a fork reply.', usage(7, 7)),
];
const pendingOwn = [
  prompt(uuid('e5', 1), uuid(P, 6), '2026-11-01T01:50:00.000Z', 'pending fork prompt: now it has its own work'),
  reply(uuid('e5', 2), uuid('e5', 1), '2026-11-01T01:50:05.000Z', 'msg_e1', FORK_MODEL, 'Pending fork reply.', usage(11, 1)),
];
const unrelated = [
  prompt(uuid('f6', 1), null, '2026-11-01T03:00:00.000Z', 'unrelated session prompt'),
  reply(uuid('f6', 2), uuid('f6', 1), '2026-11-01T03:00:05.000Z', 'msg_u1', FORK_MODEL, 'Unrelated reply.', usage(9, 9)),
];

const envelope = (sessionId, record) => ({
  parentUuid: null,
  isSidechain: false,
  userType: 'external',
  cwd: CWD,
  sessionId,
  version: '2.1.311',
  gitBranch: 'main',
  entrypoint: 'cli',
  ...record,
});
const stamp = (sessionId, chain) => chain.map((record) => envelope(sessionId, record));
const lines = (records) => records.map((r) => `${JSON.stringify(r)}\n`).join('');
const forkHead = (sessionId) => [
  { type: 'ai-title', aiTitle: 'fork-parent ⑂', sessionId },
  { type: 'agent-name', agentName: 'fork-parent ⑂', sessionId },
  { type: 'mode', mode: 'normal', sessionId },
];
const parentTitle = { type: 'custom-title', customTitle: 'fork-parent', sessionId: SID.parent };

function write(rel, text) {
  const file = path.join(ROOT, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}
const transcript = (sid) => `projects/${DIR}/${sid}.jsonl`;

rmSync(ROOT, { recursive: true, force: true });
write(transcript(SID.parent), lines([parentTitle, ...stamp(SID.parent, [...parentBefore, ...parentAfter])]));
write(transcript(SID.job), lines([...forkHead(SID.job), ...stamp(SID.job, [...parentBefore, ...jobOwn])]));
write(transcript(SID.terminal), lines(stamp(SID.terminal, [...parentBefore, ...terminalOwn])));
write(transcript(SID.forkOfFork), lines(stamp(SID.forkOfFork, [...parentBefore, ...terminalOwn, ...forkOfForkOwn])));
write(transcript(SID.pending), lines([...forkHead(SID.pending), ...stamp(SID.pending, parentBefore)]));
write(transcript(SID.unrelated), lines(stamp(SID.unrelated, unrelated)));
// Not under projects/: tests and the verify drive append it to the pending fork's transcript.
write(`appends/${SID.pending}.own.jsonl`, lines(stamp(SID.pending, pendingOwn)));

const jobState = (sid) => ({
  state: 'working',
  template: 'bg',
  forkSourceAlive: true,
  forkBoundaryAt: BOUNDARY,
  forkSessionId: sid,
  forkParentSessionId: SID.parent,
  interactiveLineage: true,
  intent: '(forked)',
  name: 'fork-parent ⑂',
  nameSource: 'auto',
  sessionId: sid,
  resumeSessionId: sid,
  daemonShort: sid.slice(0, 8),
  cwd: CWD,
  createdAt: '2026-11-01T01:10:00.000Z',
  updatedAt: '2026-11-01T01:10:01.000Z',
  backend: 'daemon',
});
for (const sid of [SID.job, SID.pending]) {
  write(`jobs/${sid.slice(0, 8)}/state.json`, `${JSON.stringify(jobState(sid), null, 2)}\n`);
  write(`jobs/${sid.slice(0, 8)}/parent-transcript.jsonl`, lines([parentTitle, ...stamp(SID.parent, parentBefore)]));
}
// A job record Claude Code was in the middle of rewriting: unreadable, so not evidence of anything.
write(`jobs/${SID.unrelated.slice(0, 8)}/state.json`, '{"state": "work\n');
```
**Impact:** test data only. Values the tests rely on: parent tokens 1000/100/3000/50, commit `a1b2c3d`, plan doc `docs/plans/fork-plan.md`; job fork own 130/13, commit `0d0e0f1`; terminal fork own 50/5; fork of a fork own 7/7; pending fork own 11/1; unrelated 9/9.

### Step 11: Fixture helpers
**File:** `tests/helpers/forkFixtures.ts` (new)
**Code:**
```ts
import { access, appendFile, cp, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The committed fork fixture home (written by tests/fixtures/make-fork-fixtures.mjs; keep in step). */
export const FORK_FIXTURE_HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/claude-home-forks');
export const FORK_PROJECT_DIR = 'projects/-home-u-mcp-notes';

export const FORKS = {
  parent: 'f0a0a001-0000-4000-8000-000000000001',
  /** Background-job fork of the parent (has jobs/f0b0b001/state.json). */
  job: 'f0b0b001-0000-4000-8000-000000000002',
  /** `claude --resume <parent> --fork-session` in a terminal: no job record. */
  terminal: 'f0c0c001-0000-4000-8000-000000000003',
  /** Terminal fork of the terminal fork. */
  forkOfFork: 'f0d0d001-0000-4000-8000-000000000004',
  /** Background-job fork that holds only the copy (its own records are in appends/). */
  pending: 'f0f0f001-0000-4000-8000-000000000005',
  /** An ordinary session with an unreadable job record. */
  unrelated: 'f0e0e001-0000-4000-8000-000000000006',
} as const;

/** The job record's forkBoundaryAt, and the timestamp of the parent's last copied record. */
export const FORK_BOUNDARY = new Date('2026-11-01T01:05:05.000Z');
/** The parent's first uuid, which every fork's transcript starts with too. */
export const PARENT_HEAD_UUID = 'a1000000-0000-4000-8000-000000000001';
/** The first record each fork wrote itself: its cut. */
export const OWN_UUID = {
  job: 'b2000000-0000-4000-8000-000000000001',
  terminal: 'c3000000-0000-4000-8000-000000000001',
  forkOfFork: 'd4000000-0000-4000-8000-000000000001',
  pending: 'e5000000-0000-4000-8000-000000000001',
} as const;

/** A temp Claude home with an empty project dir. Never the real ~/.claude. */
export async function emptyClaudeHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notes-fork-home-'));
  await mkdir(path.join(dir, FORK_PROJECT_DIR), { recursive: true });
  return dir;
}

export function forkTranscript(home: string, sessionId: string): string {
  return path.join(home, FORK_PROJECT_DIR, `${sessionId}.jsonl`);
}

/** The fixture transcript of `sessionId`, as committed. */
export function fixtureTranscript(sessionId: string): string {
  return path.join(FORK_FIXTURE_HOME, FORK_PROJECT_DIR, `${sessionId}.jsonl`);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Copies each session's job dir (all of them first), then its transcript, into `home`. */
export async function stageForks(home: string, ...sessionIds: string[]): Promise<void> {
  for (const sid of sessionIds) {
    const jobDir = path.join(FORK_FIXTURE_HOME, 'jobs', sid.slice(0, 8));
    if (await exists(jobDir)) await cp(jobDir, path.join(home, 'jobs', sid.slice(0, 8)), { recursive: true });
  }
  for (const sid of sessionIds) await cp(fixtureTranscript(sid), forkTranscript(home, sid));
}

/** Appends the pending fork's own records (its first prompt and reply) to its transcript in `home`. */
export async function appendPendingOwn(home: string): Promise<void> {
  const own = await readFile(path.join(FORK_FIXTURE_HOME, 'appends', `${FORKS.pending}.own.jsonl`), 'utf8');
  await appendFile(forkTranscript(home, FORKS.pending), own);
}

/** Byte offset of the line of `file` whose record has `uuid`. */
export async function offsetOfUuid(file: string, uuid: string): Promise<number> {
  const text = await readFile(file, 'utf8');
  let offset = 0;
  for (const line of text.split('\n')) {
    if (line.includes(`"uuid":"${uuid}"`)) return offset;
    offset += Buffer.byteLength(line, 'utf8') + 1;
  }
  throw new Error(`no record ${uuid} in ${file}`);
}
```

### Step 12: Unit tests for the reader and the accumulator
**File:** `tests/unit/sessions/transcriptCut.test.ts` (new)
**Code:**
```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isCopiedRecord, readJsonlFrom, TranscriptAccumulator } from '../../../src/sessions/transcript.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'notes-cut-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readJsonlFrom line offsets', () => {
  it('hands every complete line the byte offset it starts at, across chunk borders and multi-byte text', async () => {
    const file = path.join(dir, 't.jsonl');
    await writeFile(file, 'a\n⑂b\nccc\npartial');
    const seen: Array<[string, number]> = [];
    const read = await readJsonlFrom(file, 0, (line, lineStart) => seen.push([line, lineStart]), { chunkBytes: 3 });
    expect(seen).toEqual([
      ['a', 0],
      ['⑂b', 2],
      ['ccc', 7],
    ]);
    expect(read.endOffset).toBe(11);
    const tail: number[] = [];
    await readJsonlFrom(file, 2, (_line, lineStart) => tail.push(lineStart));
    expect(tail).toEqual([2, 7]);
  });
});

const ENV = { cwd: '/home/u/x', entrypoint: 'cli', gitBranch: 'main', version: '2.1.311' };
const copiedPrompt = { ...ENV, type: 'user', uuid: 'u1', timestamp: '2026-11-01T01:00:00.000Z', message: { role: 'user', content: 'copied prompt' } };
const copiedReply = {
  ...ENV,
  type: 'assistant',
  uuid: 'u2',
  timestamp: '2026-11-01T01:00:05.000Z',
  message: { id: 'msg_c', model: 'claude-haiku-4-5', role: 'assistant', content: [{ type: 'text', text: 'copied reply' }], usage: { input_tokens: 100, output_tokens: 10 } },
};
const ownPrompt = { type: 'user', uuid: 'u3', timestamp: '2026-11-01T02:00:00.000Z', cwd: '/home/u/x', message: { role: 'user', content: 'own prompt' } };
const ownReply = {
  type: 'assistant',
  uuid: 'u4',
  timestamp: '2026-11-01T02:00:05.000Z',
  cwd: '/home/u/x',
  message: { id: 'msg_o', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'own reply' }], usage: { input_tokens: 7, output_tokens: 1 } },
};

describe('fork cut', () => {
  it('treats a record as copied only when it has a uuid and starts before the cut', () => {
    expect(isCopiedRecord(copiedPrompt, 0, 100)).toBe(true);
    expect(isCopiedRecord(copiedPrompt, 100, 100)).toBe(false);
    expect(isCopiedRecord({ type: 'ai-title', aiTitle: 'x ⑂' }, 0, 100)).toBe(false);
    expect(isCopiedRecord(copiedPrompt, 0, null)).toBe(false);
  });

  it("takes only identity from copied records and counts the fork's own", () => {
    const acc = new TranscriptAccumulator('s');
    acc.addCopied(copiedPrompt);
    acc.addCopied(copiedReply);
    acc.add(ownPrompt);
    acc.add(ownReply);
    const d = acc.delta();
    expect(d.tokens).toEqual({ inputTokens: 7, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(Object.keys(d.models)).toEqual(['claude-opus-5-5']);
    expect(d.prompts.map((p) => p.text)).toEqual(['own prompt']);
    expect(d.replies.map((r) => r.text)).toEqual(['own reply']);
    expect(d.firstAt?.toISOString()).toBe('2026-11-01T02:00:00.000Z');
    expect(d).toMatchObject({ firstPrompt: 'own prompt', finalMessage: 'own reply', cwd: '/home/u/x', entrypoint: 'cli', branch: 'main', version: '2.1.311' });
  });

  it('a read of copied records alone reports identity and nothing else', () => {
    const acc = new TranscriptAccumulator('s');
    acc.addCopied(copiedPrompt);
    acc.addCopied(copiedReply);
    expect(acc.delta()).toMatchObject({
      prompts: [],
      replies: [],
      firstPrompt: null,
      finalMessage: null,
      firstAt: null,
      lastAt: null,
      commits: [],
      models: {},
      tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      cwd: '/home/u/x',
      entrypoint: 'cli',
    });
  });
});
```

### Step 13: Unit tests for fork ingest
**File:** `tests/unit/sessions/ingestForks.test.ts` (new)
**Code:**
```ts
import { appendFile, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startSessionIngest, type IngestBatch, type SessionIngester, type SessionIngestOptions } from '../../../src/sessions/ingest.js';
import { createRepoResolver } from '../../../src/sessions/repoResolve.js';
import type { SessionRow } from '../../../src/sessions/types.js';
import {
  appendPendingOwn,
  emptyClaudeHome,
  fixtureTranscript,
  FORK_BOUNDARY,
  forkTranscript,
  FORKS,
  offsetOfUuid,
  OWN_UUID,
  PARENT_HEAD_UUID,
  stageForks,
} from '../../helpers/forkFixtures.js';
import { MemoryIngestStore } from '../../helpers/memoryIngestStore.js';

const HOST = 'test-host';
const PLAN = '/home/u/mcp-notes/docs/plans/fork-plan.md';
let home: string;
let store: MemoryIngestStore;
let logs: string[];
const running: SessionIngester[] = [];

function start(over: Partial<SessionIngestOptions> = {}): SessionIngester {
  const ingester = startSessionIngest({
    claudeHome: home,
    worktreesDir: '/home/u/.worktrees',
    homeDir: '/home/u',
    store,
    hostname: () => HOST,
    resolver: createRepoResolver({
      homeDir: '/home/u',
      worktreesDir: '/home/u/.worktrees',
      isDirectory: async () => false,
      gitRoots: async () => null,
      listRepoNames: async () => ['mcp-notes'],
    }),
    watch: false,
    sweepMs: 0,
    log: (line) => logs.push(line),
    gitLog: async () => [],
    ...over,
  });
  running.push(ingester);
  return ingester;
}

/** The parent alone first, so it has a row and a head uuid before any fork is read. */
async function startWithParent(over: Partial<SessionIngestOptions> = {}): Promise<SessionIngester> {
  await stageForks(home, FORKS.parent);
  const ingester = start(over);
  await ingester.ready;
  return ingester;
}

function row(sessionId: string): SessionRow {
  const r = store.rows.get(sessionId);
  if (r === undefined) throw new Error(`no row ${sessionId}`);
  return r;
}
const shas = (r: SessionRow): string[] => r.commits.map((c) => c.sha);
const promptTexts = (r: SessionRow): string[] => r.prompts.map((p) => p.text);
const replyTexts = (sessionId: string): string[] => [...(store.sideReplies.get(sessionId)?.values() ?? [])].map((r) => r.text);
const uuidsOf = (b: IngestBatch): string[] => b.records.flatMap((r) => (typeof r.uuid === 'string' ? [r.uuid] : []));

function expectParentUntouched(): void {
  const p = row(FORKS.parent);
  expect(p).toMatchObject({
    parentSessionId: null,
    forkDetectedBy: null,
    forkCutOffset: null,
    headUuid: PARENT_HEAD_UUID,
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 3000,
    cacheWriteTokens: 50,
    filesEdited: [PLAN],
    planDocs: [PLAN],
  });
  expect(shas(p)).toEqual(['a1b2c3d']);
  expect(promptTexts(p)).toHaveLength(3);
}

beforeEach(async () => {
  home = await emptyClaudeHome();
  store = new MemoryIngestStore();
  logs = [];
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((i) => i.close()));
  await rm(home, { recursive: true, force: true });
});

describe('ingest: background-job forks', () => {
  it('links the fork to the parent its job state names, with source fork, and counts only its own records', async () => {
    const batches: IngestBatch[] = [];
    const ingester = await startWithParent({ observers: [{ onBatch: (b) => batches.push(b) }] });
    await stageForks(home, FORKS.job);
    expect((await ingester.sweep()).failed).toBe(0);

    const job = row(FORKS.job);
    expect(job).toMatchObject({
      parentSessionId: FORKS.parent,
      parentLinkSource: 'fork',
      forkDetectedBy: 'job',
      forkedAt: FORK_BOUNDARY,
      forkPromptCount: 2,
      headUuid: PARENT_HEAD_UUID,
      inputTokens: 130,
      outputTokens: 13,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      filesEdited: [],
      planDocs: [],
      firstPrompt: 'job fork prompt: try the other approach',
      finalMessage: 'Job fork reply.',
      startedAt: new Date('2026-11-01T01:20:00.000Z'),
      name: 'fork-parent ⑂',
      cwd: '/home/u/mcp-notes',
      entrypoint: 'cli',
    });
    expect(Object.keys(job.models)).toEqual(['claude-opus-5-5']);
    expect(job.forkCutOffset).toBe(await offsetOfUuid(forkTranscript(home, FORKS.job), OWN_UUID.job));
    expect(shas(job)).toEqual(['0d0e0f1']);
    expect(promptTexts(job)).toEqual(['job fork prompt: try the other approach']);
    expect(replyTexts(FORKS.job)).toEqual(['Job fork reply.']);

    const batch = batches.find((b) => b.sessionId === FORKS.job);
    if (batch === undefined) throw new Error('no batch for the job fork');
    expect(uuidsOf(batch).filter((u) => u.startsWith('a1'))).toEqual([]);
    expect(uuidsOf(batch)).toContain(OWN_UUID.job);
    expectParentUntouched();
  });

  it('replaces an env link the SessionStart hook wrote first', async () => {
    store.seedRow(FORKS.job, HOST, { parentSessionId: FORKS.unrelated, parentLinkSource: 'env' });
    const ingester = await startWithParent();
    await stageForks(home, FORKS.job);
    await ingester.sweep();
    expect(row(FORKS.job)).toMatchObject({ parentSessionId: FORKS.parent, parentLinkSource: 'fork' });
  });
});

describe('ingest: forks without a job record', () => {
  it('links a terminal fork to the session it shares the copied prefix with', async () => {
    const ingester = await startWithParent();
    await stageForks(home, FORKS.terminal);
    expect((await ingester.sweep()).failed).toBe(0);
    const t = row(FORKS.terminal);
    expect(t).toMatchObject({
      parentSessionId: FORKS.parent,
      parentLinkSource: 'fork',
      forkDetectedBy: 'uuid',
      forkedAt: FORK_BOUNDARY,
      forkPromptCount: 2,
      inputTokens: 50,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      filesEdited: [],
      planDocs: [],
      firstPrompt: 'terminal fork prompt: compare the two',
      startedAt: new Date('2026-11-01T01:30:00.000Z'),
    });
    expect(shas(t)).toEqual([]);
    expect(t.forkCutOffset).toBe(await offsetOfUuid(forkTranscript(home, FORKS.terminal), OWN_UUID.terminal));
    expectParentUntouched();
  });

  it('links a fork of a fork to the fork it was copied from, not to the original', async () => {
    const ingester = await startWithParent();
    await stageForks(home, FORKS.job, FORKS.terminal, FORKS.pending);
    await ingester.sweep();
    await stageForks(home, FORKS.forkOfFork);
    expect((await ingester.sweep()).failed).toBe(0);
    const ff = row(FORKS.forkOfFork);
    expect(ff).toMatchObject({
      parentSessionId: FORKS.terminal,
      parentLinkSource: 'fork',
      forkDetectedBy: 'uuid',
      forkedAt: new Date('2026-11-01T01:30:05.000Z'),
      forkPromptCount: 3,
      inputTokens: 7,
      outputTokens: 7,
      firstPrompt: 'fork of a fork prompt: go deeper',
    });
    expect(promptTexts(ff)).toEqual(['fork of a fork prompt: go deeper']);
    expect(ff.forkCutOffset).toBe(await offsetOfUuid(forkTranscript(home, FORKS.forkOfFork), OWN_UUID.forkOfFork));
  });

  it('never turns an original read again from byte 0 into a fork of its own fork', async () => {
    const first = await startWithParent();
    await stageForks(home, FORKS.terminal);
    await first.sweep();
    await first.close();
    store.rows.set(FORKS.parent, { ...row(FORKS.parent), transcriptOffset: 0 });
    await start().ready;
    expectParentUntouched();
    expect(row(FORKS.terminal)).toMatchObject({ parentSessionId: FORKS.parent, parentLinkSource: 'fork' });
  });
});

describe('ingest: a fork that holds only its copy', () => {
  it('reports zero, then counts its own records once they arrive', async () => {
    const ingester = await startWithParent();
    await stageForks(home, FORKS.pending);
    expect((await ingester.sweep()).failed).toBe(0);
    const before = row(FORKS.pending);
    expect(before).toMatchObject({
      parentSessionId: FORKS.parent,
      parentLinkSource: 'fork',
      forkDetectedBy: 'job',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      prompts: [],
      commits: [],
      filesEdited: [],
      firstPrompt: null,
      finalMessage: null,
      startedAt: null,
    });
    expect(before.forkCutOffset).toBe(before.transcriptOffset);

    await appendPendingOwn(home);
    await ingester.sweep();
    const after = row(FORKS.pending);
    expect(after).toMatchObject({ inputTokens: 11, outputTokens: 1, commits: [], firstPrompt: 'pending fork prompt: now it has its own work' });
    expect(promptTexts(after)).toEqual(['pending fork prompt: now it has its own work']);
    expect(after.forkCutOffset).toBe(await offsetOfUuid(forkTranscript(home, FORKS.pending), OWN_UUID.pending));
    expect(after.transcriptOffset).toBeGreaterThan(after.forkCutOffset ?? Number.POSITIVE_INFINITY);
  });

  it('a restart while the cut is pending still reads the fork from byte 0', async () => {
    const first = await startWithParent();
    await stageForks(home, FORKS.pending);
    await first.sweep();
    await first.close();
    await appendPendingOwn(home);
    await start().ready;
    const after = row(FORKS.pending);
    expect(after).toMatchObject({ inputTokens: 11, outputTokens: 1 });
    expect(after.forkCutOffset).toBe(await offsetOfUuid(forkTranscript(home, FORKS.pending), OWN_UUID.pending));
  });

  it('a copy half written when first read is never counted', async () => {
    const ingester = await startWithParent();
    await stageForks(home, FORKS.pending);
    const all = (await readFile(fixtureTranscript(FORKS.pending), 'utf8')).split('\n').filter((l) => l !== '');
    // ai-title, agent-name, mode, then the parent's first prompt and its commit call: the rest of the copy comes later.
    await writeFile(forkTranscript(home, FORKS.pending), all.slice(0, 5).map((l) => `${l}\n`).join(''));
    await ingester.sweep();
    expect(row(FORKS.pending)).toMatchObject({ inputTokens: 0, commits: [], prompts: [] });

    await appendFile(forkTranscript(home, FORKS.pending), all.slice(5).map((l) => `${l}\n`).join(''));
    await appendPendingOwn(home);
    await ingester.sweep();
    const after = row(FORKS.pending);
    expect(after).toMatchObject({ inputTokens: 11, outputTokens: 1, cacheReadTokens: 0, commits: [], filesEdited: [] });
    expect(promptTexts(after)).toEqual(['pending fork prompt: now it has its own work']);
  });

  it('drops a start, first prompt and final message an uncut read had taken from the copy', async () => {
    store.seedRow(FORKS.pending, HOST, {
      startedAt: new Date('2026-11-01T01:00:00.000Z'),
      firstPrompt: 'parent prompt one: build the fork fixture',
      finalMessage: 'Parent reply two.',
    });
    const ingester = await startWithParent();
    await stageForks(home, FORKS.pending);
    await ingester.sweep();
    expect(row(FORKS.pending)).toMatchObject({ startedAt: null, firstPrompt: null, finalMessage: null, inputTokens: 0 });
  });
});

describe('ingest: fork source not determinable', () => {
  it("reads a session whose only candidate parent's transcript is gone as an ordinary unlinked node", async () => {
    const ingester = await startWithParent();
    await unlink(forkTranscript(home, FORKS.parent));
    await stageForks(home, FORKS.terminal);
    expect((await ingester.sweep()).failed).toBe(0);
    const t = row(FORKS.terminal);
    expect(t).toMatchObject({ parentSessionId: null, parentLinkSource: null, forkDetectedBy: null, forkCutOffset: null, headUuid: PARENT_HEAD_UUID });
    // Nothing could be cut: the copy counts, as before fork handling.
    expect(t).toMatchObject({ inputTokens: 650, outputTokens: 65, cacheReadTokens: 3000, cacheWriteTokens: 50 });
  });

  it('reads a session with an unreadable job record as an ordinary node, every record in its batch', async () => {
    const batches: IngestBatch[] = [];
    const ingester = await startWithParent({ observers: [{ onBatch: (b) => batches.push(b) }] });
    await stageForks(home, FORKS.unrelated);
    expect((await ingester.sweep()).failed).toBe(0);
    expect(row(FORKS.unrelated)).toMatchObject({ parentSessionId: null, forkDetectedBy: null, inputTokens: 9, outputTokens: 9 });
    const batch = batches.find((b) => b.sessionId === FORKS.unrelated);
    if (batch === undefined) throw new Error('no batch for the unrelated session');
    expect(uuidsOf(batch)).toEqual(['f6000000-0000-4000-8000-000000000001', 'f6000000-0000-4000-8000-000000000002']);
  });
});
```

### Step 14: Integration test against Postgres
**File:** `tests/integration/sessions.forks.int.test.ts` (new)
**Code:**
```ts
import { rm, unlink } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { startSessionIngest, type SessionIngester } from '../../src/sessions/ingest.js';
import { SessionsRepo } from '../../src/sessions/repo.js';
import { createRepoResolver } from '../../src/sessions/repoResolve.js';
import type { SessionRow } from '../../src/sessions/types.js';
import {
  appendPendingOwn,
  emptyClaudeHome,
  FORK_BOUNDARY,
  forkTranscript,
  FORKS,
  offsetOfUuid,
  OWN_UUID,
  PARENT_HEAD_UUID,
  stageForks,
} from '../helpers/forkFixtures.js';
import { closeTestDb, openTestDb } from './setup.js';

const HOST = 'test-host';
const IDS = Object.values(FORKS);
let db: Db;
let repo: SessionsRepo;
let home: string;
const running: SessionIngester[] = [];

function start(): SessionIngester {
  const ingester = startSessionIngest({
    claudeHome: home,
    worktreesDir: '/home/u/.worktrees',
    homeDir: '/home/u',
    store: repo,
    hostname: () => HOST,
    resolver: createRepoResolver({
      homeDir: '/home/u',
      worktreesDir: '/home/u/.worktrees',
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

async function row(sessionId: string): Promise<SessionRow> {
  const r = await repo.getBySessionId(sessionId);
  if (r === null) throw new Error(`no row ${sessionId}`);
  return r;
}
const shas = (r: SessionRow): string[] => r.commits.map((c) => c.sha);

/** Parent first, then the job and terminal forks, then the fork of the terminal fork. */
async function ingestChain(): Promise<SessionIngester> {
  await stageForks(home, FORKS.parent);
  const ingester = start();
  await ingester.ready;
  await stageForks(home, FORKS.job, FORKS.terminal);
  expect((await ingester.sweep()).failed).toBe(0);
  await stageForks(home, FORKS.forkOfFork);
  expect((await ingester.sweep()).failed).toBe(0);
  return ingester;
}

beforeAll(() => {
  db = openTestDb();
  repo = new SessionsRepo(db);
});

afterAll(async () => {
  await closeTestDb(db);
});

beforeEach(async () => {
  await db.execute(sql`delete from cc_sessions where session_id in (${sql.join(IDS.map((id) => sql`${id}`), sql`, `)})`);
  home = await emptyClaudeHome();
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((i) => i.close()));
  await rm(home, { recursive: true, force: true });
});

describe('fork ingest into cc_sessions', () => {
  it('links job, terminal and fork-of-fork forks with source fork and stores only their own records', async () => {
    // The SessionStart hook of a background fork may carry an unrelated CC_PARENT_SESSION.
    await repo.upsertFromHook({ sessionId: FORKS.job, host: HOST, parentSessionId: FORKS.unrelated });
    await ingestChain();

    const job = await row(FORKS.job);
    expect(job).toMatchObject({
      parentSessionId: FORKS.parent,
      parentLinkSource: 'fork',
      forkDetectedBy: 'job',
      forkedAt: FORK_BOUNDARY,
      forkPromptCount: 2,
      headUuid: PARENT_HEAD_UUID,
      inputTokens: 130,
      outputTokens: 13,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      filesEdited: [],
      planDocs: [],
      firstPrompt: 'job fork prompt: try the other approach',
      finalMessage: 'Job fork reply.',
      startedAt: new Date('2026-11-01T01:20:00.000Z'),
    });
    expect(shas(job)).toEqual(['0d0e0f1']);
    expect(Object.keys(job.models)).toEqual(['claude-opus-5-5']);
    expect(job.forkCutOffset).toBe(await offsetOfUuid(forkTranscript(home, FORKS.job), OWN_UUID.job));
    const prompts = await db.execute<{ text: string }>(sql`select text from cc_session_prompts where session_id = ${FORKS.job} order by seq`);
    expect(prompts.rows.map((r) => r.text)).toEqual(['job fork prompt: try the other approach']);
    const replies = await db.execute<{ text: string }>(sql`select text from cc_session_replies where session_id = ${FORKS.job} order by seq`);
    expect(replies.rows.map((r) => r.text)).toEqual(['Job fork reply.']);

    expect(await row(FORKS.terminal)).toMatchObject({
      parentSessionId: FORKS.parent,
      parentLinkSource: 'fork',
      forkDetectedBy: 'uuid',
      forkPromptCount: 2,
      inputTokens: 50,
      outputTokens: 5,
      commits: [],
    });
    expect(await row(FORKS.forkOfFork)).toMatchObject({
      parentSessionId: FORKS.terminal,
      parentLinkSource: 'fork',
      forkDetectedBy: 'uuid',
      forkPromptCount: 3,
      inputTokens: 7,
      outputTokens: 7,
    });

    const parent = await row(FORKS.parent);
    expect(parent).toMatchObject({ parentSessionId: null, forkDetectedBy: null, headUuid: PARENT_HEAD_UUID, inputTokens: 1000, outputTokens: 100 });
    expect(shas(parent)).toEqual(['a1b2c3d']);
  });

  it('offers as candidates only rows with the same head that are neither descendants nor newer', async () => {
    await ingestChain();
    // Every other fixture row descends from the parent.
    expect(await repo.forkCandidates(HOST, PARENT_HEAD_UUID, FORKS.parent)).toEqual([]);
    const forFf = await repo.forkCandidates(HOST, PARENT_HEAD_UUID, FORKS.forkOfFork);
    expect(forFf.map((c) => c.sessionId).sort()).toEqual([FORKS.parent, FORKS.job, FORKS.terminal].sort());
    expect(forFf.find((c) => c.sessionId === FORKS.terminal)?.forkDetectedBy).toBe('uuid');
    expect(forFf.find((c) => c.sessionId === FORKS.parent)?.forkDetectedBy).toBeNull();
    expect(await repo.forkCandidates('another-host', PARENT_HEAD_UUID, FORKS.forkOfFork)).toEqual([]);
  });

  it('keeps a fork that holds only its copy at zero, then counts its own records, across a restart', async () => {
    await stageForks(home, FORKS.parent);
    const first = start();
    await first.ready;
    await stageForks(home, FORKS.pending);
    await first.sweep();
    const before = await row(FORKS.pending);
    expect(before).toMatchObject({
      parentSessionId: FORKS.parent,
      parentLinkSource: 'fork',
      inputTokens: 0,
      outputTokens: 0,
      prompts: [],
      commits: [],
      firstPrompt: null,
      startedAt: null,
    });
    expect(before.forkCutOffset).toBe(before.transcriptOffset);
    await first.close();

    await appendPendingOwn(home);
    await start().ready;
    const after = await row(FORKS.pending);
    expect(after).toMatchObject({ inputTokens: 11, outputTokens: 1, firstPrompt: 'pending fork prompt: now it has its own work' });
    expect(after.forkCutOffset).toBe(await offsetOfUuid(forkTranscript(home, FORKS.pending), OWN_UUID.pending));
  });

  it("ingests a session whose candidate parent's transcript is gone as an ordinary unlinked node", async () => {
    await stageForks(home, FORKS.parent);
    const ingester = start();
    await ingester.ready;
    await unlink(forkTranscript(home, FORKS.parent));
    await stageForks(home, FORKS.terminal);
    expect((await ingester.sweep()).failed).toBe(0);
    expect(await row(FORKS.terminal)).toMatchObject({ parentSessionId: null, forkDetectedBy: null, inputTokens: 650, outputTokens: 65 });
  });
});
```

### Step 15: Feature map
**File:** `.claude/skills/verify-notesd/features/projects.md`

**Shared file (reconciled):** `features/projects.md` gets append-only edits from phases 2, 4, 5 and 6 (and one sentence from phase 3 inside phase 2's bullet). Order, top to bottom, in both `## Sub-features` and the blocks before `## Gotchas`: phase 4's section (wave 1), then phase 2's, then phase 5's, then phase 6's. Phases 2 and 5 can run at the same time and anchor at the same spot; whoever merges second keeps both sides in that order (an append-append conflict, never a rewrite of the other phase's lines).
**Change 15a:** append this bullet at the end of `## Sub-features` (after the "Expand prompts (R2)" bullet; Phases 5 and 6 append their own bullets after it):
```markdown
- Forks at ingest (`claude --resume X --fork-session`, background jobs): a fork is its own node,
  linked to the session it was copied from with parent link source `fork`, which no other source
  replaces. The parent comes from `<CLAUDE_HOME>/jobs/<first 8 of the fork's id>/state.json`
  (`fork_detected_by` `job`; `time` when only the job's `forkBoundaryAt` could cut it) or, with no
  job, from the rows of this host whose transcript starts with the same uuid (`uuid`; the longest
  shared prefix wins, so a fork of a fork links to that fork). The records the fork copied from its
  parent count nowhere in it: tokens, models, commits, files edited, plan docs, prompts, replies,
  first prompt, final message and start all come from its own records (`fork_cut_offset` is the
  byte its own records start at; `forked_at` and `fork_prompt_count` say where it split). A fork
  that so far holds only the copy shows 0 tokens and no prompts until its own records arrive. A
  session whose source cannot be found is an ordinary unlinked node. Proof:
  `tests/unit/sessions/ingestForks.test.ts`, `tests/integration/sessions.forks.int.test.ts`, and
  the "Forks at ingest" drive below. Fixture: `tests/fixtures/claude-home-forks` (generator
  `tests/fixtures/make-fork-fixtures.mjs`), a separate home so the main fixture's counts stay put.
```
**Change 15b:** insert this block directly before `## Gotchas`:
````markdown
Forks at ingest. The fork fixtures are copied into the run's `CLAUDE_HOME` in order, parent first,
because a fork without a job record is found through its parent's row:
```sh
NOTESD_CLAUDE_BIN=/nonexistent/claude $V up --sessions      # note RUN and URL
CH="$HOME/.local/state/notesd-verify/$RUN/claude"; FX=tests/fixtures/claude-home-forks; PD=projects/-home-u-mcp-notes
P=f0a0a001-0000-4000-8000-000000000001; J=f0b0b001-0000-4000-8000-000000000002; T=f0c0c001-0000-4000-8000-000000000003
TT=f0d0d001-0000-4000-8000-000000000004; PEND=f0f0f001-0000-4000-8000-000000000005; U=f0e0e001-0000-4000-8000-000000000006
seen() { for i in $(seq 90); do curl -sf "$URL/api/projects/mcp-notes/sessions" | jq -e --arg s "$1" '.nodes[] | select(.session_id == $s)' >/dev/null && return 0; sleep 1; done; echo "timed out: $1"; return 1; }
cp "$FX/$PD/$P.jsonl" "$CH/$PD/" && seen $P
cp -r "$FX/jobs" "$CH/" && cp "$FX/$PD/$J.jsonl" "$FX/$PD/$T.jsonl" "$FX/$PD/$PEND.jsonl" "$FX/$PD/$U.jsonl" "$CH/$PD/" && seen $J && seen $T && seen $PEND && seen $U
cp "$FX/$PD/$TT.jsonl" "$CH/$PD/" && seen $TT
$V sql $RUN "select session_id, parent_session_id, parent_link_source, fork_detected_by, fork_prompt_count, input_tokens, output_tokens, jsonb_path_query_array(commits, '\$[*].sha')::text as shas from cc_sessions where session_id like 'f0%' order by session_id"
```
Expected: `f0b0…` (job) → parent `f0a0…`, `fork`, `job`, 2, 130/13, `["0d0e0f1"]`; `f0c0…` (terminal) → `f0a0…`,
`fork`, `uuid`, 2, 50/5, `[]`; `f0d0…` (fork of a fork) → `f0c0…`, `fork`, `uuid`, 3, 7/7; `f0f0…` (pending) →
`f0a0…`, `fork`, `job`, 2, 0/0, `[]`; `f0e0…` (unrelated, unreadable job record) → no parent, 9/9; `f0a0…`
(parent) → no parent, 1000/100, `["a1b2c3d"]`. Then give the pending fork its own records:
`cat "$FX/appends/$PEND.own.jsonl" >> "$CH/$PD/$PEND.jsonl"` and its node's `tokens.input` becomes 11.
````
**Impact:** docs only.

## Principles applied

- Make illegal states unrepresentable: no "cut is final" column. A pending cut is derived from data the row already holds (`fork_cut_offset >= transcript_offset`, `isPendingCut`), so a stored flag can never disagree with the offsets; and `TranscriptPatch.fork` is Phase 1's `ForkInfo`, whose `cutOffset` is a number, so a fork can never be written without the three columns `cc_sessions_fork_info_check` keeps together (Step 5 writes all of them from one value).
- Laziness protocol: the line start offset is a second argument of the existing `readJsonlFrom` (Phase 1 Step 7b) instead of a second reader; the fork link reuses `setParentIn` inside the existing upsert transaction (Step 6c) instead of a new repo method; detection runs only on reads from byte 0. The candidate filter is one SQL predicate (descendants and newer rows out), not a per-candidate file read: Phase 1's ranking already prefers an original on a tie.
- Boundary discipline: every error from the filesystem or the candidate query is caught once, in `scanForkSafely` (Step 8f), and turned into "not a fork" (or "wait" for a pending fork); nothing below it re-checks. The job's parent id is lower-cased where it enters (`forkDetect.ts`).
- Build the lever: the fork fixtures are produced by `tests/fixtures/make-fork-fixtures.mjs` (Step 10), so every expected number in the tests and the verify drive comes from one readable generator, and it can be rerun to prove the committed JSONL is what it says.
- Test behavior, not implementation: the tests assert rows, side-table rows and observer batches a caller sees (Steps 13, 14), and the half-written-copy test fails if the re-read-from-0 rule is dropped, without inspecting `pendingCuts`.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` and `npm run test:int` (this phase writes SQL)
**Proof:** the real daemon, built from this checkout, ingests the fork fixtures dropped into its Claude home; the rows are read back with SQL and the graph API.
- Harness: `.claude/skills/verify-notesd`
- Feature-map entries: `.claude/skills/verify-notesd/features/projects.md`
- Setup for J1-J5 (run once, from `/home/miftah/.worktrees/mcp-notes/session-fork-awareness`): `V=.claude/skills/verify-notesd/scripts/verify.sh; NOTESD_CLAUDE_BIN=/nonexistent/claude $V up --sessions`, set `RUN` and `URL` from its output, then run the `CH=… FX=… PD=…`, the six id assignments, `seen()`, and the three `cp … && seen …` lines of the "Forks at ingest" block of `features/projects.md` exactly as written (each `seen` must return 0)
  - **J1** · traces R1.1, R2.1 — `$V sql $RUN "select parent_session_id, parent_link_source, fork_detected_by, fork_prompt_count, forked_at = '2026-11-01T01:05:05Z' as forked_ok, fork_cut_offset < transcript_offset as cut_final, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, models::text, jsonb_path_query_array(commits, '\$[*].sha')::text as shas, files_edited::text, plan_docs::text, first_prompt, final_message, started_at = '2026-11-01T01:20:00Z' as started_ok, jsonb_array_length(prompts) as n_prompts from cc_sessions where session_id = '$J'"` then `$V sql $RUN "select (select count(*) from cc_session_prompts where session_id = '$J') as prompts, (select string_agg(text, '|') from cc_session_replies where session_id = '$J') as replies"` then `$V sql $RUN "select input_tokens, jsonb_path_query_array(commits, '\$[*].sha')::text as shas, files_edited::text from cc_sessions where session_id = '$P'"` → passes when the first row reads `f0a0a001-0000-4000-8000-000000000001 | fork | job | 2 | t | t | 130 | 13 | 0 | 0` with `models` holding only `claude-opus-5-5`, `shas` `["0d0e0f1"]`, `files_edited` and `plan_docs` `[]`, `first_prompt` `job fork prompt: try the other approach`, `final_message` `Job fork reply.`, `started_ok` `t`, `n_prompts` 1; the second reads `1 | Job fork reply.`; the parent reads `1000 | ["a1b2c3d"] | ["/home/u/mcp-notes/docs/plans/fork-plan.md"]`
  - **J2** · traces R1.2, R2.1 — `$V sql $RUN "select parent_session_id, parent_link_source, fork_detected_by, fork_prompt_count, forked_at = '2026-11-01T01:05:05Z' as forked_ok, input_tokens, output_tokens, cache_read_tokens, jsonb_array_length(commits) as n_commits, files_edited::text, first_prompt, started_at = '2026-11-01T01:30:00Z' as started_ok from cc_sessions where session_id = '$T'"` → passes when it reads `f0a0a001-0000-4000-8000-000000000001 | fork | uuid | 2 | t | 50 | 5 | 0 | 0 | [] | terminal fork prompt: compare the two | t` (the terminal fork has no job record, so the link came from the shared prefix)
  - **J3** · traces R1.4 — `$V sql $RUN "select parent_session_id, parent_link_source, fork_detected_by, fork_prompt_count, forked_at = '2026-11-01T01:30:05Z' as forked_ok, input_tokens, output_tokens from cc_sessions where session_id = '$TT'"` → passes when it reads `f0c0c001-0000-4000-8000-000000000003 | fork | uuid | 3 | t | 7 | 7` (the terminal fork, not the original `f0a0…`)
  - **J4** · traces R2.3 — `$V sql $RUN "select parent_session_id, parent_link_source, input_tokens, output_tokens, jsonb_array_length(prompts) as n_prompts, jsonb_array_length(commits) as n_commits, first_prompt, started_at, fork_cut_offset = transcript_offset as pending from cc_sessions where session_id = '$PEND'"`, then `cat "$FX/appends/$PEND.own.jsonl" >> "$CH/$PD/$PEND.jsonl"; for i in $(seq 90); do curl -sf "$URL/api/projects/mcp-notes/sessions" | jq -e --arg s $PEND '.nodes[] | select(.session_id == $s and .tokens.input == 11)' >/dev/null && break; sleep 1; done`, then the same `$V sql` again → passes when the first read is `f0a0a001-0000-4000-8000-000000000001 | fork | 0 | 0 | 0 | 0 | (null) | (null) | t` and the second is `f0a0a001-0000-4000-8000-000000000001 | fork | 11 | 1 | 1 | 0 | pending fork prompt: now it has its own work | 2026-11-01 01:50:00+00 (same instant in the server zone) | f`
  - **J5** · traces R1.5 — `$V sql $RUN "select parent_session_id, parent_link_source, fork_detected_by, fork_cut_offset, input_tokens, output_tokens from cc_sessions where session_id = '$U'"` then `grep -cE '\[notesd\] sessions: (watch|sweep|backfill) .* [1-9][0-9]* failed' "$HOME/.local/state/notesd-verify/$RUN/daemon.log"` → passes when the row reads `(null) | (null) | (null) | (null) | 9 | 9` (its job record is unreadable and no other transcript starts with its uuid) and the grep prints `0` (no ingest pass failed while the six fork fixtures were read)
  - **J6** · traces R1.1, R1.2, R1.4, R1.5, R2.1, R2.3 — `npx vitest run tests/unit/sessions/ingestForks.test.ts tests/unit/sessions/transcriptCut.test.ts` → passes when vitest reports every test in both files passed, including "a copy half written when first read is never counted" and "reads a session whose only candidate parent's transcript is gone as an ordinary unlinked node"
  - **J7** · traces R1.1, R1.2, R1.4, R1.5, R2.1, R2.3 — `bash scripts/test-int.sh tests/integration/sessions.forks.int.test.ts` (the script forwards its args to `vitest run`) → passes when the four tests of `sessions.forks.int.test.ts` pass against the pgvector Postgres
- Neighbor check: ordinary sessions still ingest as before. In the same run, before `down`: `$V sql $RUN "select count(*) as fixture_rows, count(*) filter (where fork_detected_by is null and parent_link_source is distinct from 'fork' and head_uuid is not null) as plain from cc_sessions where session_id like '5e55a001%'"` → `fixture_rows` = `plain` (3: …001, …002, …005), and `$V api $RUN GET /api/projects` lists `mcp-notes` and `wall-editing`. Also `npx vitest run tests/unit/sessions/ingest.test.ts` passes unchanged. Then `$V down $RUN`
- Cost: none (summaries off via `NOTESD_CLAUDE_BIN`, embeddings off by default, no chat)
**Exit criteria:** `npm run typecheck`, `npm test` and `npm run test:int` pass; J1-J7 pass; the existing `tests/unit/sessions/ingest.test.ts` and `tests/integration/sessions.ingest.int.test.ts` pass without edits.

## Handoffs

- **Phase 3 (R2.2, R5.1):** this phase provides `scanForkSafely(file, sessionId): Promise<ForkScan | null>` (never throws; Step 8f). Phase 3's backfill calls it directly, `(await scanForkSafely(file, sessionId))?.fork ?? null` (reconciled: no `detectFork` wrapper). Originals come back null because `forkCandidates` leaves out a session's descendants and every row created after it. Phase 3 still detects job-state forks before uuid-only candidates (index Decisions), so a job fork is linked, and so excluded as a descendant, before its original is examined.
- **Phase 3:** `isCopiedRecord(record, lineStart, forkCutOffset: number | null)` and `readJsonlFrom`'s `onLine(line, lineStart)` are exactly the shapes Phase 3's Requires quote. Re-ingest from byte 0 through `readFile` re-runs detection, writes `head_uuid`, the fork columns and the link, and the merge drops a copied `started_at` / first prompt / final message (Step 5), which is what Phase 3's backfill relies on. A row ingested before this phase has `head_uuid` null until a 0-read or Phase 3's `fillHeadUuids`, so a terminal fork of such a parent is found only after Phase 3's backfill.
- **Phase 3:** on a fresh database, the link worker's one-time `scanTranscriptForIntents` would read a fork's copied spawn intents if it ran before the cut is stored. Reconciled: Phase 3 makes that scan apply the stored cut and wait for `forkBackfill` (`LinkWorkerOptions.backfillAfter`). The live `onBatch` path already gets only the fork's own records from this phase.
- **Phase 1 (reconciled):** the `lineStart` argument and `isCopiedRecord` moved into Phase 1 (Step 7b there), and `readRecordsWithOffsets` uses `lineStart`, so offsets are raw bytes everywhere.
- **Phase 1's unowned note (`sessionHooks.ts:166`):** decided by the reconciler: not changed by any phase (index Decisions).
- **Phase 5 (R2.4):** `transcriptSearch.ts` imports `isCopiedRecord` from `transcript.ts` (Phase 1's, reconciled) instead of its own `hasUuid` check. `fork_cut_offset` is non-null on every detected fork (pending ones included) and null on every non-fork, as Phase 5 assumes.
- **Phases 5 and 6:** both also append to `features/projects.md`; this phase's bullet and "Forks at ingest" block are separate and should stay separate.

## Rollback

Revert this phase's commit. No schema change is in it. Rows it wrote keep their `fork` links and fork columns (valid under Phase 1's checks) and their cut counts; a session re-read from byte 0 by the reverted code is counted whole again, which is the pre-phase behaviour. To clear what this phase wrote without reverting Phase 1: `update cc_sessions set parent_session_id = null, parent_link_source = null where parent_link_source = 'fork'; update cc_sessions set fork_cut_offset = null, forked_at = null, fork_prompt_count = null, fork_detected_by = null, transcript_offset = 0 where fork_detected_by is not null;` (offset 0 makes the next ingest re-read those rows whole).
