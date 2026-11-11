# Phase 3: Re-readers honour the cut, plus the one-time fork backfill

**Plan set:** `SESSION_FORK_AWARENESS_PLAN.md`
**Analysis:** `.workflows/analyze/20261111-093332-K7F2_code_analyzer.md`
**Satisfies:** R2, R5 (a fork's copied records stay out of every count, including forks ingested before fork handling)
**Criteria:** R2.2, R5.1, R5.2
**Depends on:** Phase 2 (and through it Phase 1)
**Difficulty:** HARD
**Package:** `src/sessions`

---

## Goal

After this phase the two readers that re-read a whole transcript outside the tail ingester (the
prompts backfill in `ingest.ts` and the heuristic link worker's backfill scan in `links.ts`) skip
the records a fork copied from its parent, using the `fork_cut_offset` phase 2 stores. On the first
daemon start after the change, a one-time per-host fork backfill fills `head_uuid` for old rows,
finds every fork already ingested on this host with phase 2's detector, and re-reads each one from
byte 0 inside the running ingester, so it gets its `fork` parent link and loses the copied tokens,
commits, prompts and replies. Transcripts that are gone are skipped without a write, and the
backfill is still marked done.

## Interface Contract

**Deletes:** the private `open` / `FileHandle` read loop inside `links.ts scanTranscriptForIntents`
(`src/sessions/links.ts:21`, `:644-665`); the function now streams with `readJsonlFrom`.

**Renames:** none.

**Creates:**
- `FORK_BACKFILL_VERSION` (= 1), `FORK_MARKER_PREFIX` (= `'sessions.forks.backfill.'`),
  `ForkBackfillReport`, `formatForkReport` (`src/sessions/ingest.ts`)
- `SessionIngester.forkBackfill: Promise<ForkBackfillReport>` (`src/sessions/ingest.ts`)
- closure helpers inside `startSessionIngest`: `rereadFromZero(file, sessionId)`, `backfillForks()`
- `SessionsRepo.forkBackfillRows(host): Promise<ForkBackfillRow[]>` (`src/sessions/repo.ts`)
- `SessionsRepo.fillHeadUuids(host, entries): Promise<number>` (`src/sessions/repo.ts`)
- types `ForkBackfillRow`, `HeadUuidFill` (`src/sessions/types.ts`)
- app_settings key `sessions.forks.backfill.<host>` = `{ version, finishedAt, rows, headsFilled, forks, reingested, missing }`
- `tests/integration/sessions.forkBackfill.int.test.ts`

**Signature changes:**
- `PromptsBackfillCandidate` gains required `forkCutOffset: number | null` (`src/sessions/types.ts:272`).
- `TranscriptRef` gains optional `forkCutOffset?: number | null` (`src/sessions/links.ts:95`).
- `LinkWorkerOptions` gains `backfillAfter?: () => Promise<unknown> | null | undefined` (`src/sessions/links.ts`): the link worker's one-time backfill scan awaits it first. `background.ts` passes `() => sessionIngest?.forkBackfill`.
- `scanTranscriptForIntents(file, parentSessionId, opts: { home; shouldStop? })` ->
  `scanTranscriptForIntents(file, parentSessionId, opts: { home; forkCutOffset?: number | null; shouldStop? })`.
- `IngestStore` gains optional `'forkBackfillRows' | 'fillHeadUuids' | 'getSetting' | 'putSetting' | 'requestSummary'`.
- `promptsBackfill` now starts after `forkBackfill` settles (was: after `ready`).

**Requires (from earlier phases).** Reconciled against the phase 1 and 2 plans as written:
- Phase 1, `src/sessions/fork.ts`: `headUuid(file: string): Promise<string | null>` (uuid of the
  first record that has one; null for a missing file or one without uuids) and
  `jobStateFor(claudeHome: string, sessionId: string): Promise<ForkJobState | null>` (null unless
  `<claudeHome>/jobs/<sid first 8>/state.json` names this session as a fork; throws on I/O errors
  other than a missing file).
- Phase 1, `src/db/schema.ts`: `ccSessions.headUuid` (`text('head_uuid')`) and
  `ccSessions.forkCutOffset` (`bigint('fork_cut_offset', { mode: 'number' })`); `SessionRow`
  carries `headUuid: string | null` and `forkCutOffset: number | null`; `ParentLinkSource`
  includes `'fork'`; `tests/helpers/memoryIngestStore.ts blankSessionRow` sets the five fork
  columns to null.
- Phase 1, `src/sessions/transcript.ts` (Phase 1 Step 7b): `readJsonlFrom` hands each line's raw
  byte start as a second argument, `onLine(line: string, lineStart: number)`, and exports
  `isCopiedRecord(record: TranscriptRecord, lineStart: number, forkCutOffset: number | null): boolean`
  (true for a record with a non-empty string `uuid` whose line starts before `forkCutOffset`; false
  when the cut is null). Phase 3 adds no copy of it.
- Phase 2, inside `startSessionIngest` (`ingest.ts`): the closure
  `scanForkSafely(file: string, sessionId: string): Promise<ForkScan | null>` (never throws,
  invariant 5). `ForkScan = { headUuid: string | null; fork: ForkInfo | null; error: string | null }`;
  `fork` is null for an original (`forkCandidates` leaves out the session's descendants and every
  row created after it) and for an undeterminable session. Phase 3 calls it as
  `(await scanForkSafely(file, sessionId))?.fork ?? null` and only tests the result for null.
- Phase 2, `readFile`: a read with `fromOffset === 0` runs `scanForkSafely`, writes `head_uuid`,
  the fork columns and the `fork` parent link in the upsert transaction, and leaves copied records
  out of the patch and out of `IngestBatch.records` (so the link worker's live `onBatch` already
  gets only the fork's own records). The 0-read's merge drops a stored `started_at` at or before
  the fork point and a stored first prompt / final message the read does not replace.
- Phase 2, `SessionsRepo.forkCandidates(host, headUuid, excludeSessionId)` and the `'forkCandidates'`
  key in `IngestStore`: the detector's head-uuid lookup. Phase 3 fills `head_uuid` on old rows so
  that lookup finds originals ingested before this change.

**Leaves alone (owned by others):** `readFile`'s detection and cut logic (phase 2),
`transcript.ts` (`readJsonlFrom`, `isCopiedRecord`: phase 1; `addCopied`: phase 2); `merge.ts`, `forkCandidates`, `STORED_RANK`, `LIST_COLUMNS` (phases 1-2); resume,
`registry.ts` (phase 4); `view.ts`, `search.ts`, `readModel.ts`, `transcriptSearch.ts`,
`http/sessionsApi.ts`, MCP tool text (phase 5); `web/src/*` and
`.claude/skills/verify-notesd/features/projects.md` beyond one sentence inside phase 2's "Forks at
ingest" bullet (phases 2, 4, 5 and 6 own the rest of their own sections). `src/background.ts`: only the link worker's `backfillAfter` wiring (Step 5h).

## Files

| File | Action | What changes |
|---|---|---|
| `src/sessions/types.ts` | modify | `PromptsBackfillCandidate.forkCutOffset` (`:272-278`); new `ForkBackfillRow`, `HeadUuidFill` after it |
| `src/sessions/repo.ts` | modify | type imports (`:31-77`); `promptsBackfillCandidates` selects `forkCutOffset` (`:500-512`); new `forkBackfillRows`, `fillHeadUuids` after `redactStoredPrompts` (`:576`) |
| `tests/helpers/memoryIngestStore.ts` | modify | `promptsBackfillCandidates` returns `forkCutOffset` (`:215-219`) |
| `src/sessions/ingest.ts` | modify | header doc (`:47-60`), imports (`:1-18`), `IngestStore` (`:87-93`), fork backfill report types (after `:157`), `SessionIngester.forkBackfill` (`:205-218`), `backfillSession` applies the cut (`:621-630`), `rereadFromZero` (after `:591`), `backfillForks` (after `:678`), sequencing (`:780-789`), `idle`/`close`/return (`:805-844`), `formatForkReport` (after `:856`) |
| `src/background.ts` | modify | `startLinkWorker` gets `backfillAfter: () => sessionIngest?.forkBackfill` (`:96`) |
| `src/sessions/links.ts` | modify | `LinkWorkerOptions.backfillAfter` (`:147-158`), its await in `onPassComplete` (`:885-892`), imports (`:21-27`), `TranscriptRef` (`:95-98`), `scanTranscriptForIntents` (`:635-667`), `TranscriptRow` (`:684`), `dbLinkStore.transcriptsOnHost` (`:728-735`), backfill call (`:846-848`) |
| `tests/unit/sessions/linkWorker.test.ts` | modify | new `describe('fork cut (R2.2)')` at the end |
| `tests/unit/sessions/ingest.test.ts` | modify | new `describe('startSessionIngest: prompts backfill honours the fork cut (R2.2)')` at the end |
| `tests/integration/sessions.forkBackfill.int.test.ts` | create | R5.1, R5.2 and the R2.2 prompts/link-store checks against Postgres |
| `README.md` | modify | "Who started whom" (`:668-682`) gains the `fork` source and the backfill |
| `.claude/skills/verify-notesd/features/projects.md` | modify | one sentence inside phase 2's "Forks at ingest" bullet |
| `CLAUDE.md` | modify | sessions paragraph (`:41`): `fork > env > hook > heuristic`, the cut, the fork backfill |

Line numbers are as of `8040a46`. Phases 1-2 shift them in `types.ts`, `repo.ts`, `ingest.ts`; anchor
every edit on the named symbol.

## Implementation Steps

### Step 1: Types for the cut-aware prompts backfill and the fork backfill
**File:** `src/sessions/types.ts:272`
**Change:** replace `PromptsBackfillCandidate` and add two types right after it.
**Code:**
```ts
export interface PromptsBackfillCandidate {
  sessionId: string;
  transcriptPath: string | null;
  transcriptOffset: number;
  /** The row's prompts_version when listed: a gone transcript at PROMPTS_VERSION_EXCERPTS or above is skipped without a write. */
  promptsVersion: number;
  /** cc_sessions.fork_cut_offset: the re-read skips records with a uuid before it (copied from the fork's parent). Null: not a fork. */
  forkCutOffset: number | null;
}

/** One row of this host as the one-time fork backfill sees it (`SessionsRepo.forkBackfillRows`). */
export interface ForkBackfillRow {
  sessionId: string;
  transcriptPath: string;
  headUuid: string | null;
  parentLinkSource: ParentLinkSource | null;
  /** Non-null: the row has a summary made from the uncut records, so a re-ingested fork asks for a new one. */
  summarizedAt: Date | null;
}

/** A head uuid read from a transcript, for a row that has none yet (`SessionsRepo.fillHeadUuids`). */
export interface HeadUuidFill {
  sessionId: string;
  headUuid: string;
}
```
**Impact:** `PromptsBackfillCandidate` has two producers (`SessionsRepo`, `MemoryIngestStore`); both
are updated in steps 2 and 3, so the tree compiles.

### Step 2: Repo: list the cut with prompts candidates; rows and head-uuid fill for the fork backfill
**File:** `src/sessions/repo.ts`
**Change 2a (`:31-77`, the `./types.js` import):** add `type ForkBackfillRow,` and `type HeadUuidFill,`
to the list (alphabetical place, after `type ListForRepoOptions,` is fine).

**Change 2b (`:500-512`):** replace `promptsBackfillCandidates`.
**Code:**
```ts
  async promptsBackfillCandidates(host: string): Promise<PromptsBackfillCandidate[]> {
    assertHost(host);
    return this.db
      .select({
        sessionId: ccSessions.sessionId,
        transcriptPath: ccSessions.transcriptPath,
        transcriptOffset: ccSessions.transcriptOffset,
        promptsVersion: ccSessions.promptsVersion,
        forkCutOffset: ccSessions.forkCutOffset,
      })
      .from(ccSessions)
      .where(and(eq(ccSessions.host, host), or(lt(ccSessions.promptsVersion, PROMPTS_VERSION), lt(ccSessions.repliesVersion, REPLIES_VERSION))))
      .orderBy(desc(sql`coalesce(${ccSessions.lastActiveAt}, ${ccSessions.createdAt})`), asc(ccSessions.sessionId));
  }
```

**Change 2c (insert after `redactStoredPrompts`, which ends at `:576`):**
**Code:**
```ts
  // ---------- one-time fork backfill ----------

  /**
   * Every row of `host` with a transcript path, oldest first: what the one-time fork backfill looks
   * at. Rows already linked as forks are listed too: their head uuid is what groups an original
   * with a fork ingested before fork handling.
   */
  async forkBackfillRows(host: string): Promise<ForkBackfillRow[]> {
    assertHost(host);
    const rows = await this.db
      .select({
        sessionId: ccSessions.sessionId,
        transcriptPath: ccSessions.transcriptPath,
        headUuid: ccSessions.headUuid,
        parentLinkSource: ccSessions.parentLinkSource,
        summarizedAt: ccSessions.summarizedAt,
      })
      .from(ccSessions)
      .where(and(eq(ccSessions.host, host), isNotNull(ccSessions.transcriptPath)))
      .orderBy(asc(ORDER_AT), asc(ccSessions.sessionId));
    return rows.flatMap((r) => (r.transcriptPath === null ? [] : [{ ...r, transcriptPath: r.transcriptPath }]));
  }

  /**
   * Sets head_uuid on rows of `host` that have none yet, in one statement; never overwrites a stored
   * one. Writes no other column, not even updated_at: the head uuid is a lookup key, shown nowhere.
   * Returns how many rows changed.
   */
  async fillHeadUuids(host: string, entries: readonly HeadUuidFill[]): Promise<number> {
    assertHost(host);
    if (entries.length === 0) return 0;
    const values = JSON.stringify(entries.map((e) => ({ session_id: e.sessionId, head_uuid: e.headUuid })));
    const res = await this.db.execute<{ session_id: string }>(sql`
      update cc_sessions s set head_uuid = v.head_uuid
      from jsonb_to_recordset(${values}::jsonb) as v(session_id text, head_uuid text)
      where s.session_id = v.session_id and s.host = ${host} and s.head_uuid is null
      returning s.session_id
    `);
    return res.rows.length;
  }
```
**Impact:** two new read/write methods; `SessionsRepo` stays the only writer (invariant 3).
`ORDER_AT` is the existing `const` at `repo.ts:136`; `isNotNull` is already imported (`:2`).

### Step 3: Memory store returns the cut
**File:** `tests/helpers/memoryIngestStore.ts:215`
**Change:** replace `promptsBackfillCandidates`.
**Code:**
```ts
  async promptsBackfillCandidates(host: string): Promise<PromptsBackfillCandidate[]> {
    return [...this.rows.values()]
      .filter((r) => r.host === host && (r.promptsVersion < PROMPTS_VERSION || r.repliesVersion < REPLIES_VERSION))
      .map((r) => ({
        sessionId: r.sessionId,
        transcriptPath: r.transcriptPath,
        transcriptOffset: r.transcriptOffset,
        promptsVersion: r.promptsVersion,
        forkCutOffset: r.forkCutOffset,
      }));
  }
```
**Impact:** test helper only. The memory store implements none of the fork backfill methods, so
every existing unit test sees `forkBackfill` resolve with `ran: false` and nothing else changes.

### Step 4: Ingest: cut-aware prompts backfill, the fork backfill, sequencing
**File:** `src/sessions/ingest.ts`

**Change 4a: header doc (`:47-60`).** After the paragraph that ends "One log line, only when a row
changed, was deferred or failed." add:
```ts
 * - Forks: a fork's row stores `fork_cut_offset` (phase 2). The prompts backfill skips the records
 *   with a uuid before it (`isCopiedRecord`), as the tail ingester did, so a fork never gets its
 *   parent's prompts or replies back. Before the prompts backfill, `forkBackfill` runs once per host
 *   (FORK_BACKFILL_VERSION, app_settings `${FORK_MARKER_PREFIX}${host}`): it fills head_uuid for rows
 *   ingested before it existed, checks every row that shares a head uuid with another row or has a
 *   background-job record with the fork detector, and re-reads each fork from byte 0 under the
 *   per-file hold, which links it (`fork`) and cuts the copied prefix. A transcript that is gone is
 *   skipped without a write; the marker is written once nothing was deferred or failed.
```

**Change 4b: imports (`:1-18`).** Replace the two `./types.js` / `./transcript.js` imports and add `./fork.js`:
```ts
import { headUuid, jobStateFor } from './fork.js';
import {
  PROMPTS_VERSION_EXCERPTS,
  type ForkBackfillRow,
  type HeadUuidFill,
  type PromptsBackfillCandidate,
  type PromptsReplacement,
  type RedactStoredPromptsResult,
  type ReplacePromptsResult,
} from './types.js';
import { createGitRangeLog, withRangeCommits, type GitRangeLog } from './gitRange.js';
import { createRepoResolver, type RepoResolver } from './repoResolve.js';
import {
  buildTranscriptPatch,
  EXCLUDED_ENTRYPOINTS,
  isCopiedRecord,
  isObject,
  parseRecord,
  readJsonlFrom,
  TranscriptAccumulator,
  type TranscriptCarry,
  type TranscriptRecord,
} from './transcript.js';
```
Keep any additional names phase 2 added to these import lists.

**Change 4c: `IngestStore` (`:87-93`).** Add the five optional keys to the `Partial<Pick<…>>`
union, keeping whatever phase 2 added (e.g. `'forkCandidates'`):
```ts
/**
 * The `SessionsRepo` methods ingest uses. Unit tests pass an in-memory implementation; one without
 * the subagent methods leaves subagent transcripts unread; one without the three prompts methods
 * skips the prompts backfill; one without forkBackfillRows, fillHeadUuids, getSetting or putSetting
 * skips the fork backfill.
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
      | 'getSetting'
      | 'putSetting'
      | 'requestSummary'
    >
  >;
```
(`'forkCandidates'` is phase 2's key (its Change 8c), listed so the block is complete.)

**Change 4d: report types (insert after `emptyPromptsReport`, `:155-157`).**
```ts
/** Bump to make every host run the fork backfill once more (e.g. after detection improves). */
export const FORK_BACKFILL_VERSION = 1;
/** app_settings key prefix; the full key is `${FORK_MARKER_PREFIX}${host}`. */
export const FORK_MARKER_PREFIX = 'sessions.forks.backfill.';

/** What the one-time fork backfill did. */
export interface ForkBackfillReport {
  /** False when the marker says it already ran at FORK_BACKFILL_VERSION, or the store lacks the methods. */
  ran: boolean;
  /** Rows of this host with a transcript path. */
  rows: number;
  /** Rows given a head uuid they did not have. */
  headsFilled: number;
  /** Rows the fork detector looked at: a head uuid shared with another row, or a background-job record. */
  candidates: number;
  /** Rows the detector called a fork. */
  forks: number;
  /** Forks re-read from byte 0 (linked `fork`, copied prefix cut). */
  reingested: number;
  /** Transcript gone, or outside this Claude home: skipped without a write. */
  missing: number;
  /** A fork whose re-read wrote nothing (the file changed under it): left for the next start. */
  deferred: number;
  failed: number;
  ms: number;
}

function emptyForkReport(): ForkBackfillReport {
  return { ran: false, rows: 0, headsFilled: 0, candidates: 0, forks: 0, reingested: 0, missing: 0, deferred: 0, failed: 0, ms: 0 };
}
```

**Change 4e: `SessionIngester` (`:205-218`).** Replace the interface.
```ts
export interface SessionIngester {
  /** Settles when the startup backfill pass has finished (never rejects). */
  ready: Promise<IngestReport>;
  /** Settles once the one-time fork backfill that follows `ready` is done (never rejects). */
  forkBackfill: Promise<ForkBackfillReport>;
  /** Settles once the one-time prompts backfill that follows `forkBackfill` is done (never rejects). */
  promptsBackfill: Promise<PromptsBackfillReport>;
  /** Adds an observer (see EXTENSION POINT above). Returns the function that removes it. */
  addObserver(observer: IngestObserver): () => void;
  /** One full sweep now. Concurrent calls share the running sweep. */
  sweep(): Promise<IngestReport>;
  /** Resolves when no sweep, watcher burst or file read is running or scheduled. For tests. */
  idle(): Promise<void>;
  /** Stops watching and sweeping; waits at most `closeGraceMs` for in-flight reads. */
  close(): Promise<void>;
}
```

**Change 4f: `backfillSession` applies the cut (`:621-630`).** Replace the accumulator/read block
(from `const acc = new TranscriptAccumulator(c.sessionId);` through the `readJsonlFrom(...)` call)
with:
```ts
      const acc = new TranscriptAccumulator(c.sessionId);
      const read = await readJsonlFrom(
        file,
        0,
        (line, lineStart) => {
          const record = parseRecord(line);
          // A fork's copied records were left out by the read that wrote the row; leave them out here too.
          if (record !== null && !isCopiedRecord(record, lineStart, c.forkCutOffset)) acc.add(record);
        },
        { until: upTo, shouldStop: () => closed, ...(options.chunkBytes !== undefined ? { chunkBytes: options.chunkBytes } : {}) },
      );
```
The rest of `backfillSession` is unchanged.

**Change 4g: `rereadFromZero` (insert right after `withFileHeld`, `:591`).**
```ts
  /**
   * Re-reads `file` from byte 0 under the per-file hold: the in-memory offset is set to 0 in the
   * same tick the hold is taken, so this read takes `readFile`'s 0-read path (fork detection, the
   * `fork` link and the cut, written in one upsert that replaces the row's counters) and no tail read
   * can slip in first. A read that writes nothing puts the old offset back, so memory keeps matching
   * the row. Returns the bytes written (0: nothing written).
   */
  const rereadFromZero = (file: string, sessionId: string): Promise<number> =>
    withFileHeld(file, async () => {
      const before = offsets.get(sessionId);
      offsets.set(sessionId, 0);
      carries.delete(sessionId);
      deferred.delete(file);
      const bytes = await readFile(file);
      if (bytes === 0 && offsets.get(sessionId) === 0 && before !== undefined) offsets.set(sessionId, before);
      return bytes;
    });
```

**Change 4h: `backfillForks` (insert right after `backfillPrompts`, `:678`).**
```ts
  /** The one-time fork backfill for this host (see the header). */
  const backfillForks = async (): Promise<ForkBackfillReport> => {
    const started = Date.now();
    const report = emptyForkReport();
    const store = options.store;
    const getSetting = store.getSetting?.bind(store);
    const putSetting = store.putSetting?.bind(store);
    const listRows = store.forkBackfillRows?.bind(store);
    const fillHeads = store.fillHeadUuids?.bind(store);
    if (getSetting === undefined || putSetting === undefined || listRows === undefined || fillHeads === undefined || closed) return report;
    const key = `${FORK_MARKER_PREFIX}${host}`;
    const marker = await getSetting(key);
    if (isObject(marker) && marker.version === FORK_BACKFILL_VERSION) return report;
    report.ran = true;
    const rows = await listRows(host);
    report.rows = rows.length;

    // 1. Head uuids. Rows ingested before head_uuid existed have none, so the detector's lookup
    //    could not find them as originals. A transcript that is gone is skipped without a write.
    const heads = new Map<string, string | null>();
    const fills: HeadUuidFill[] = [];
    await forEachLimit(rows, concurrency, async (row) => {
      if (closed) return;
      if (!isUnder(projectsDir, row.transcriptPath) || (await fileSize(row.transcriptPath)) === null) {
        report.missing += 1;
        return;
      }
      if (row.headUuid !== null) {
        heads.set(row.sessionId, row.headUuid);
        return;
      }
      try {
        const head = await headUuid(row.transcriptPath);
        heads.set(row.sessionId, head);
        if (head !== null) fills.push({ sessionId: row.sessionId, headUuid: head });
      } catch (err) {
        report.failed += 1;
        log(`[notesd] sessions: fork backfill ${row.sessionId}: ${errorMessage(err)}`);
      }
    });
    if (closed) return report;
    report.headsFilled = await fillHeads(host, fills);

    // 2. Candidates: rows not already linked as forks that have a background-job record, or that
    //    share their head uuid with another row of this host. Only the detector decides. Job-state
    //    candidates go first (index Decisions): every row here was ingested before the cut, so a
    //    parent and its forks share one polluted started_at; linking the job forks first makes them
    //    descendants, which forkCandidates then leaves out when an original is examined.
    const sharing = new Map<string, number>();
    for (const head of heads.values()) if (head !== null) sharing.set(head, (sharing.get(head) ?? 0) + 1);
    const jobCandidates: ForkBackfillRow[] = [];
    const uuidCandidates: ForkBackfillRow[] = [];
    for (const row of rows) {
      if (closed) return report;
      if (!heads.has(row.sessionId) || row.parentLinkSource === 'fork') continue;
      const job = await jobStateFor(options.claudeHome, row.sessionId).catch(() => null);
      if (job !== null) {
        jobCandidates.push(row);
        continue;
      }
      const head = heads.get(row.sessionId) ?? null;
      if (head !== null && (sharing.get(head) ?? 0) > 1) uuidCandidates.push(row);
    }
    const candidates = [...jobCandidates, ...uuidCandidates];
    report.candidates = candidates.length;

    // 3. Detect, then re-read each fork from byte 0. Originals are never re-read: a 0-read
    //    recomputes push/merge range commits with `git log`, which loses them once a worktree is gone.
    for (const row of candidates) {
      if (closed) return report;
      try {
        if (((await scanForkSafely(row.transcriptPath, row.sessionId))?.fork ?? null) === null) continue;
        report.forks += 1;
        const bytes = await rereadFromZero(row.transcriptPath, row.sessionId);
        if (bytes === 0) {
          report.deferred += 1;
          continue;
        }
        report.reingested += 1;
        // Its summary was written from the parent's copied prompts: ask the summary worker for a new one.
        if (row.summarizedAt !== null) await store.requestSummary?.(row.sessionId);
      } catch (err) {
        report.failed += 1;
        log(`[notesd] sessions: fork backfill ${row.sessionId}: ${errorMessage(err)}`);
      }
    }
    report.ms = Date.now() - started;
    if (closed) return report; // no marker: the next start runs it again (every step is idempotent)
    if (report.deferred === 0 && report.failed === 0) {
      await putSetting(key, {
        version: FORK_BACKFILL_VERSION,
        finishedAt: new Date().toISOString(),
        rows: report.rows,
        headsFilled: report.headsFilled,
        forks: report.forks,
        reingested: report.reingested,
        missing: report.missing,
      });
    }
    if (report.headsFilled + report.forks + report.deferred + report.failed > 0) log(formatForkReport(report));
    return report;
  };
```
`scanForkSafely` is phase 2's closure (see Requires); `backfillForks` is declared after it inside
`startSessionIngest`. `isUnder`, `fileSize`, `forEachLimit`, `errorMessage` already exist in this
file.

**Change 4i: sequencing (`:780-789`).** Replace the `promptsSettled` / `promptsBackfill` block with:
```ts
  let forkSettled = false;
  const forkBackfill: Promise<ForkBackfillReport> = ready
    .then(() => backfillForks())
    .catch((err: unknown) => {
      log(`[notesd] sessions: fork backfill failed: ${errorMessage(err)}`);
      return { ...emptyForkReport(), ran: true, failed: 1 };
    })
    .finally(() => {
      forkSettled = true;
    });

  // After the fork backfill: re-read forks are current and drop out of the prompts candidates.
  let promptsSettled = false;
  const promptsBackfill: Promise<PromptsBackfillReport> = forkBackfill
    .then(() => backfillPrompts())
    .catch((err: unknown) => {
      log(`[notesd] sessions: prompts backfill failed: ${errorMessage(err)}`);
      return { ...emptyPromptsReport(), failed: 1 };
    })
    .finally(() => {
      promptsSettled = true;
    });
```

**Change 4j: returned object (`:805-844`).** Replace the `return { … }` of `startSessionIngest`:
```ts
  return {
    ready,
    forkBackfill,
    promptsBackfill,
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
      const pending = Promise.allSettled([closing, sweeping, watchDrain, forkBackfill, promptsBackfill, ...inflight.values()]);
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

**Change 4k: `formatForkReport` (append after `formatPromptsReport`, `:856`).**
```ts
/** e.g. `[notesd] sessions: fork backfill 640 sessions, 612 head uuids filled, 6 checked, 3 forks, 3 re-read from byte 0, 25 transcripts gone, 0 deferred, 0 failed, 812ms` */
export function formatForkReport(r: ForkBackfillReport): string {
  return `[notesd] sessions: fork backfill ${r.rows} sessions, ${r.headsFilled} head uuids filled, ${r.candidates} checked, ${r.forks} forks, ${r.reingested} re-read from byte 0, ${r.missing} transcripts gone, ${r.deferred} deferred, ${r.failed} failed, ${r.ms}ms`;
}
```
**Impact:** the prompts backfill starts after the fork backfill (one extra settings read on every
start once the marker exists). With a store that lacks the new methods (the unit tests' memory
store) the fork backfill is a no-op. Existing integration tests that use the real repo now also
write the `sessions.forks.backfill.test-host` setting; no existing test counts settings rows
(`grep -rn app_settings tests` shows only the links marker and `projects.selected` lookups).

### Step 5: Link worker: skip copied records in the backfill scan; carry the cut from the DB
**File:** `src/sessions/links.ts`

**Change 5a: imports (`:21-27`).** Delete line 21 (`import { open, type FileHandle } from 'node:fs/promises';`,
whose only user was the scan loop) and add after the `Db` import:
```ts
import { isCopiedRecord, parseRecord, readJsonlFrom } from './transcript.js';
```

**Change 5b: `TranscriptRef` (`:95-98`).**
```ts
export interface TranscriptRef {
  sessionId: string;
  transcriptPath: string;
  /** cc_sessions.fork_cut_offset: records with a uuid before it were copied from the fork's parent. Absent or null: not a fork. */
  forkCutOffset?: number | null;
}
```

**Change 5c: `scanTranscriptForIntents` (`:631-667`; keep `mightCarryIntent` at `:631-633`).** Replace the doc comment and function:
```ts
const UNREADABLE = new Set(['ENOENT', 'EACCES', 'EISDIR', 'ENOTDIR']);

/** An error opening a transcript that means "nothing to read", not "the scan failed". */
function isUnreadable(err: unknown): boolean {
  return isObject(err) && typeof err.code === 'string' && UNREADABLE.has(err.code);
}

/**
 * Streams one transcript and returns its spawn intents. A missing or unreadable file yields [];
 * a trailing partial line is not read. Records copied from a fork's parent (a uuid, on a line that
 * starts before `forkCutOffset`) are skipped, so a fork plans no links from its parent's history.
 * `shouldStop` aborts between chunks.
 */
export async function scanTranscriptForIntents(
  file: string,
  parentSessionId: string,
  opts: { home: string; forkCutOffset?: number | null; shouldStop?: () => boolean },
): Promise<SpawnIntent[]> {
  const cut = opts.forkCutOffset ?? null;
  const out: SpawnIntent[] = [];
  try {
    await readJsonlFrom(
      file,
      0,
      (line, lineStart) => {
        if (!mightCarryIntent(line)) return;
        const record = parseRecord(line);
        if (record === null || isCopiedRecord(record, lineStart, cut)) return;
        out.push(...extractIntents(record, { parentSessionId, home: opts.home }));
      },
      opts.shouldStop === undefined ? {} : { shouldStop: opts.shouldStop },
    );
  } catch (err) {
    if (isUnreadable(err)) return [];
    throw err;
  }
  return out;
}
```
(`isObject` is the module's own helper at `:490`.)

**Change 5d: `TranscriptRow` (`:684`).**
```ts
type TranscriptRow = { session_id: string; transcript_path: string; fork_cut_offset: string | number | null };
```

**Change 5e: `dbLinkStore.transcriptsOnHost` (`:728-735`).** Raw `db.execute` returns a `bigint`
as a string, hence `Number`.
```ts
    async transcriptsOnHost(host) {
      const res = await db.execute<TranscriptRow>(sql`
        select session_id, transcript_path, fork_cut_offset from cc_sessions
        where host = ${host} and transcript_path is not null
        order by started_at asc nulls last, session_id asc
      `);
      return res.rows.map((r) => ({
        sessionId: r.session_id,
        transcriptPath: r.transcript_path,
        forkCutOffset: r.fork_cut_offset === null ? null : Number(r.fork_cut_offset),
      }));
    },
```

**Change 5f: backfill call (`:846-848`).**
```ts
        intents.push(
          ...(await scanTranscriptForIntents(ref.transcriptPath, ref.sessionId, {
            home,
            forkCutOffset: ref.forkCutOffset ?? null,
            shouldStop: () => closed,
          })),
        );
```
**Change 5g: the scan waits for the fork backfill (`LinkWorkerOptions`, `:147-158`; `onPassComplete`, `:885-892`).**
Add to `LinkWorkerOptions`, after `host`:
```ts
  /**
   * Awaited once before the one-time backfill scan: background.ts passes the ingester's
   * `forkBackfill`, so the scan reads every fork's `fork_cut_offset` after the fork backfill wrote
   * it and plans no link from a fork's copied history (R2.2). Absent or null: the scan starts at once.
   */
  backfillAfter?: () => Promise<unknown> | null | undefined;
```
In `onPassComplete`, replace
```ts
      if (!backfillDone) {
        try {
          await backfill();
```
with
```ts
      if (!backfillDone) {
        try {
          // Not inside enqueue(): a pending wait must not hold up drains of live batches.
          await opts.backfillAfter?.();
          await backfill();
```
`forkBackfill` never rejects (step 4i) and the ingester does not await observers' `onPassComplete`
(`notifyPass` only attaches a `.catch`), so the wait cannot deadlock the startup pass.

**Change 5h: wiring (`src/background.ts:96`).** `sessionIngest` is assigned on the next statement,
before any pass can complete, so a thunk reads it:
```ts
    sessionLinks = startLinkWorker({
      store: dbLinkStore(deps.db, sessionsRepo),
      host: sessionsHost,
      backfillAfter: () => sessionIngest?.forkBackfill,
    });
```

**Impact:** `LINKS_BACKFILL_VERSION` stays 1: hosts that already ran the scan do not rescan
~900 MB; the cut applies to every future scan (a new host, or a version bump). The live `onBatch`
path needs no change, because phase 2 hands it only the fork's own records.

### Step 6: Unit tests for the cut in both re-readers
**File:** `tests/unit/sessions/linkWorker.test.ts` (append at the end of the file)
**Code:**
```ts
describe('fork cut (R2.2)', () => {
  const SPAWN = (n: number): string => `python3 ~/.claude/skills/swarm/swarm.py spawn --slug x --phase ${n}`;

  /** header (no uuid) + a copied spawn of p1 (uuid) + a uuid-less spawn of p3 + the fork's own spawn of p2 (cut lands here). */
  async function forkTranscript(): Promise<{ file: string; cut: number }> {
    const header = { type: 'ai-title', aiTitle: 'fork', sessionId: 'fork' };
    const copied = { ...bash('fork', 0, SPAWN(1)), uuid: 'c-1', parentUuid: null };
    const loose = bash('fork', 1_000, SPAWN(3));
    const own = { ...bash('fork', 2_000, SPAWN(2)), uuid: 'o-1', parentUuid: 'c-1' };
    const file = await writeTranscript('fork', [header, copied, loose, own]);
    const cut = Buffer.byteLength([header, copied, loose].map((r) => `${JSON.stringify(r)}\n`).join(''));
    return { file, cut };
  }

  it('scanTranscriptForIntents skips records with a uuid before the cut and reads every other record', async () => {
    const { file, cut } = await forkTranscript();
    const names = async (forkCutOffset: number | null) =>
      (await scanTranscriptForIntents(file, 'fork', { home: HOME, forkCutOffset })).map((i) => i.name);
    expect(await names(cut)).toEqual(['impl-x-p3', 'impl-x-p2']);
    expect(await names(null)).toEqual(['impl-x-p1', 'impl-x-p3', 'impl-x-p2']);
  });

  it("the backfill links no child from a fork's copied history", async () => {
    const { file, cut } = await forkTranscript();
    const sessions = [
      session({ sessionId: 'fork', name: 'orch-x', startedAt: at(-60_000) }),
      session({ sessionId: 'c1', name: 'impl-x-p1', startedAt: at(3_000) }),
      session({ sessionId: 'c2', name: 'impl-x-p2', startedAt: at(5_000) }),
    ];
    const { store, calls } = fakeStore(sessions, [{ sessionId: 'fork', transcriptPath: file, forkCutOffset: cut }]);
    await start(store).onPassComplete({ initial: true });
    expect(calls.setParent).toEqual([['c2', 'fork']]);
  });

  it('the backfill scan waits for backfillAfter, then reads the cut it left', async () => {
    const { file, cut } = await forkTranscript();
    const sessions = [
      session({ sessionId: 'fork', name: 'orch-x', startedAt: at(-60_000) }),
      session({ sessionId: 'c1', name: 'impl-x-p1', startedAt: at(3_000) }),
      session({ sessionId: 'c2', name: 'impl-x-p2', startedAt: at(5_000) }),
    ];
    // The fork backfill stores the cut only when it settles; before that the ref has none.
    const refs = [{ sessionId: 'fork', transcriptPath: file, forkCutOffset: null as number | null }];
    const { store, calls } = fakeStore(sessions, refs);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = () => {
        refs[0]!.forkCutOffset = cut;
        resolve();
      };
    });
    const pass = start(store, { backfillAfter: () => gate }).onPassComplete({ initial: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.setParent).toEqual([]);
    release();
    await pass;
    expect(calls.setParent).toEqual([['c2', 'fork']]);
  });
});
```

**File:** `tests/unit/sessions/ingest.test.ts` (append at the end of the file)
**Code:**
```ts
describe('startSessionIngest: prompts backfill honours the fork cut (R2.2)', () => {
  it('re-reads a fork row without the records copied before fork_cut_offset', async () => {
    const sid = 'f0f0f0f0-0000-4000-8000-00000000f0f0';
    const file = path.join(home, 'projects/-home-u-mcp-notes', `${sid}.jsonl`);
    const base = { sessionId: sid, cwd: '/home/u/mcp-notes', entrypoint: 'cli', version: '2.1.0' };
    const copied = line({ ...base, type: 'user', uuid: 'cp-1', parentUuid: null, timestamp: '2026-11-11T01:00:00.000Z', message: { role: 'user', content: 'copied parent prompt' } });
    const loose = line({ type: 'custom-title', sessionId: sid, customTitle: 'forked work' });
    const own = line({ ...base, type: 'user', uuid: 'own-1', parentUuid: 'cp-1', timestamp: '2026-11-11T01:20:00.000Z', message: { role: 'user', content: 'the fork own prompt' } });
    await writeFile(file, copied + loose + own);
    await start().ready;
    const row = store.rows.get(sid);
    if (!row) throw new Error('no row');
    // A fork row as phase 2 stores it, left below PROMPTS_VERSION so the backfill re-reads it.
    store.rows.set(sid, { ...row, promptsVersion: 0, forkCutOffset: Buffer.byteLength(copied + loose) });
    const second = start();
    await second.ready;
    expect(await second.promptsBackfill).toMatchObject({ candidates: 1, filled: 1, failed: 0 });
    expect(store.sidePrompts.get(sid)?.map((p) => p.text)).toEqual(['the fork own prompt']);
    expect(store.rows.get(sid)?.firstPrompt).toBe('the fork own prompt');
  });
});
```
**Impact:** both tests fail before steps 4f and 5c (the copied prompt / the `c1` link comes back).

### Step 7: Integration test against Postgres
**File:** `tests/integration/sessions.forkBackfill.int.test.ts` (create)
**Code:**
```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { ccSessionPrompts } from '../../src/db/schema.js';
import { FORK_BACKFILL_VERSION, FORK_MARKER_PREFIX, startSessionIngest, type SessionIngester } from '../../src/sessions/ingest.js';
import { dbLinkStore } from '../../src/sessions/links.js';
import { SessionsRepo } from '../../src/sessions/repo.js';
import { createRepoResolver } from '../../src/sessions/repoResolve.js';
import { buildTranscriptPatch, parseRecord, readJsonlFrom, TranscriptAccumulator } from '../../src/sessions/transcript.js';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

const HOST = 'test-host';
const P = '662d31f3-8b12-4345-b9d6-f6fd48caa493'; // DM-OV shape: the parent
const F = 'e3650501-2a9d-432a-b2c0-f2aeff23fdf8'; // JM-UJ shape: forked from P
const FF = 'aa11bb22-0000-4000-8000-0000000000ff'; // forked from F
const GONE = 'dead0000-0000-4000-8000-000000000001';
const P_DIR = '-home-u--worktrees-mcp-notes-dmov';
const F_DIR = '-home-u-claude-commands';
const P_CWD = '/home/u/.worktrees/mcp-notes/dmov';
const F_CWD = '/home/u/claude-commands';
const T0 = Date.parse('2026-11-11T01:00:00.000Z');
const ts = (min: number): string => new Date(T0 + min * 60_000).toISOString();

type Rec = Record<string, unknown>;
const jsonl = (records: readonly Rec[]): string => records.map((r) => `${JSON.stringify(r)}\n`).join('');

let db: Db;
let repo: SessionsRepo;
let home: string;
const running: SessionIngester[] = [];

/** The parent's conversation up to the fork point: a prompt, commit d1b23dc, a reply. Same uuids in every copy. */
function chain(sessionId: string, cwd: string): Rec[] {
  const env = { sessionId, cwd, entrypoint: 'cli', version: '2.1.0' };
  return [
    { ...env, type: 'user', uuid: 'c-1', parentUuid: null, timestamp: ts(0), message: { role: 'user', content: 'build the shared feature' } },
    {
      ...env,
      type: 'assistant',
      uuid: 'c-2',
      parentUuid: 'c-1',
      timestamp: ts(1),
      message: {
        id: 'msg-c2',
        model: 'claude-opus-4-5',
        role: 'assistant',
        usage: { input_tokens: 100, output_tokens: 50 },
        content: [{ type: 'tool_use', id: 'tool-commit', name: 'Bash', input: { command: 'git commit -m "feat: shared work"' } }],
      },
    },
    {
      ...env,
      type: 'user',
      uuid: 'c-3',
      parentUuid: 'c-2',
      timestamp: ts(2),
      toolUseResult: { stdout: '[main d1b23dc] feat: shared work' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-commit', content: '[main d1b23dc] feat: shared work' }] },
    },
    {
      ...env,
      type: 'assistant',
      uuid: 'c-4',
      parentUuid: 'c-3',
      timestamp: ts(3),
      message: { id: 'msg-c4', model: 'claude-opus-4-5', role: 'assistant', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'Committed d1b23dc.' }] },
    },
  ];
}

/** What a session adds after the fork point: one prompt and a reply worth 7 + 3 tokens. */
function own(sessionId: string, cwd: string, tag: string, min: number, parentUuid: string | null): Rec[] {
  const env = { sessionId, cwd, entrypoint: 'cli', version: '2.1.0' };
  return [
    { ...env, type: 'user', uuid: `${tag}-1`, parentUuid, timestamp: ts(min), message: { role: 'user', content: `${tag} own question` } },
    {
      ...env,
      type: 'assistant',
      uuid: `${tag}-2`,
      parentUuid: `${tag}-1`,
      timestamp: ts(min + 1),
      message: { id: `msg-${tag}`, model: 'claude-opus-4-5', role: 'assistant', usage: { input_tokens: 7, output_tokens: 3 }, content: [{ type: 'text', text: `${tag} answer` }] },
    },
  ];
}

/** Claude Code writes these for the new session before the copy: no uuid, so always the fork's own. */
function forkHeader(sessionId: string): Rec[] {
  return [
    { type: 'ai-title', sessionId, aiTitle: 'fork' },
    { type: 'agent-name', sessionId, agentName: 'impl ⑂' },
  ];
}

async function writeTranscript(dir: string, sessionId: string, records: readonly Rec[]): Promise<string> {
  const file = path.join(home, 'projects', dir, `${sessionId}.jsonl`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, jsonl(records));
  return file;
}

/** The background-job record Claude Code keeps for fork F (measured shape, analysis "Measured"). */
async function writeJob(): Promise<void> {
  const dir = path.join(home, 'jobs', F.slice(0, 8));
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'state.json'),
    JSON.stringify({
      jobId: F.slice(0, 8),
      sessionId: F,
      forkSessionId: F,
      forkParentSessionId: P,
      forkBoundaryAt: ts(3),
      backend: 'daemon',
      name: 'impl ⑂',
      intent: '(forked)',
      state: 'running',
    }),
  );
  await writeFile(path.join(dir, 'parent-transcript.jsonl'), jsonl(chain(P, P_CWD)));
}

/** The row the ingester wrote before fork handling: every record counted, no head uuid, no fork link. */
async function legacyRow(file: string, sessionId: string): Promise<void> {
  const acc = new TranscriptAccumulator(sessionId);
  const read = await readJsonlFrom(file, 0, (l) => {
    const r = parseRecord(l);
    if (r !== null) acc.add(r);
  });
  const delta = acc.delta();
  const patch = buildTranscriptPatch(delta, { host: HOST, transcriptPath: file, fromOffset: 0, toOffset: read.endOffset, size: read.size, repo: 'mcp-notes' });
  patch.commits = delta.commits;
  expect((await repo.upsertFromTranscript(patch)).applied).toBe(true);
  await db.execute(sql`
    update cc_sessions set head_uuid = null, fork_cut_offset = null, forked_at = null, fork_prompt_count = null,
      fork_detected_by = null, parent_session_id = null, parent_link_source = null
    where session_id = ${sessionId}`);
}

async function promptTexts(sessionId: string): Promise<string[]> {
  const rows = await db.select().from(ccSessionPrompts).where(eq(ccSessionPrompts.sessionId, sessionId)).orderBy(asc(ccSessionPrompts.seq));
  return rows.map((r) => r.text);
}

const marker = (): Promise<unknown> => repo.getSetting(`${FORK_MARKER_PREFIX}${HOST}`);

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

beforeAll(() => {
  db = openTestDb();
  repo = new SessionsRepo(db);
});

afterAll(async () => {
  await closeTestDb(db);
});

beforeEach(async () => {
  await truncateAll(db);
  home = await mkdtemp(path.join(tmpdir(), 'fork-backfill-'));
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((i) => i.close()));
  await rm(home, { recursive: true, force: true });
});

describe('one-time fork backfill (R5.1)', () => {
  it('links a background fork ingested before fork handling to its parent, cuts the copy, and does nothing on the next start', async () => {
    const pFile = await writeTranscript(P_DIR, P, [...chain(P, P_CWD), ...own(P, P_CWD, 'p', 10, 'c-4')]);
    const copied = [...forkHeader(F), ...chain(F, F_CWD)];
    const cut = Buffer.byteLength(jsonl(copied));
    const fFile = await writeTranscript(F_DIR, F, [...copied, ...own(F, F_CWD, 'f', 20, 'c-4')]);
    await writeJob();
    await legacyRow(pFile, P);
    await legacyRow(fFile, F);
    expect((await repo.getBySessionId(F))?.commits.map((c) => c.sha)).toEqual(['d1b23dc']); // the bug, as stored today
    const pBefore = await repo.getBySessionId(P);

    const first = start();
    expect(await first.forkBackfill).toMatchObject({ ran: true, forks: 1, reingested: 1, missing: 0, deferred: 0, failed: 0 });
    const f = await repo.getBySessionId(F);
    expect(f).toMatchObject({ parentSessionId: P, parentLinkSource: 'fork', headUuid: 'c-1', forkCutOffset: cut, inputTokens: 7, outputTokens: 3, firstPrompt: 'f own question' });
    expect(f?.commits).toEqual([]);
    expect(f?.startedAt?.toISOString()).toBe(ts(20));
    expect(await promptTexts(F)).toEqual(['f own question']);
    const p = await repo.getBySessionId(P);
    expect(p).toMatchObject({ headUuid: 'c-1', parentSessionId: null, inputTokens: 117 });
    expect(p?.updatedAt).toEqual(pBefore?.updatedAt);
    expect(p?.commits.map((c) => c.sha)).toEqual(['d1b23dc']);
    expect(await marker()).toMatchObject({ version: FORK_BACKFILL_VERSION, forks: 1, reingested: 1 });
    await first.close();

    const second = start();
    expect(await second.forkBackfill).toMatchObject({ ran: false, forks: 0, reingested: 0 });
    expect((await repo.getBySessionId(F))?.updatedAt).toEqual(f?.updatedAt);
  });

  it('finds a fork made without a job by its shared head uuid, and links a fork of a fork to the fork', async () => {
    const pFile = await writeTranscript(P_DIR, P, [...chain(P, P_CWD), ...own(P, P_CWD, 'p', 10, 'c-4')]);
    const fFile = await writeTranscript(F_DIR, F, [...forkHeader(F), ...chain(F, F_CWD), ...own(F, F_CWD, 'f', 20, 'c-4')]);
    const ffCopied = [...forkHeader(FF), ...chain(FF, F_CWD), ...own(FF, F_CWD, 'f', 20, 'c-4')];
    const ffCut = Buffer.byteLength(jsonl(ffCopied));
    const ffFile = await writeTranscript(F_DIR, FF, [...ffCopied, ...own(FF, F_CWD, 'ff', 30, 'f-2')]);
    await legacyRow(pFile, P);
    await legacyRow(fFile, F);
    await legacyRow(ffFile, FF);

    expect(await start().forkBackfill).toMatchObject({ ran: true, forks: 2, reingested: 2, failed: 0 });
    expect(await repo.getBySessionId(F)).toMatchObject({ parentSessionId: P, parentLinkSource: 'fork', inputTokens: 7 });
    const ff = await repo.getBySessionId(FF);
    expect(ff).toMatchObject({ parentSessionId: F, parentLinkSource: 'fork', forkCutOffset: ffCut, inputTokens: 7, firstPrompt: 'ff own question' });
    expect(ff?.commits).toEqual([]);
    expect(await repo.getBySessionId(P)).toMatchObject({ parentSessionId: null, parentLinkSource: null });
  });
});

describe('one-time fork backfill: transcript gone (R5.2)', () => {
  it('skips a row whose transcript is gone without a write, still re-links the fork, and marks the backfill done', async () => {
    const goneFile = await writeTranscript(P_DIR, GONE, own(GONE, P_CWD, 'g', 5, null));
    await legacyRow(goneFile, GONE);
    await rm(goneFile);
    const pFile = await writeTranscript(P_DIR, P, [...chain(P, P_CWD), ...own(P, P_CWD, 'p', 10, 'c-4')]);
    const fFile = await writeTranscript(F_DIR, F, [...forkHeader(F), ...chain(F, F_CWD), ...own(F, F_CWD, 'f', 20, 'c-4')]);
    await writeJob();
    await legacyRow(pFile, P);
    await legacyRow(fFile, F);
    const before = await repo.getBySessionId(GONE);

    expect(await start().forkBackfill).toMatchObject({ ran: true, rows: 3, missing: 1, forks: 1, reingested: 1, deferred: 0, failed: 0 });
    expect(await repo.getBySessionId(GONE)).toEqual(before);
    expect(await repo.getBySessionId(F)).toMatchObject({ parentSessionId: P, parentLinkSource: 'fork' });
    expect(await marker()).toMatchObject({ version: FORK_BACKFILL_VERSION, missing: 1, reingested: 1 });
  });

  it('writes the marker even when the only row it reaches has no transcript', async () => {
    const goneFile = await writeTranscript(P_DIR, GONE, own(GONE, P_CWD, 'g', 5, null));
    await legacyRow(goneFile, GONE);
    await rm(goneFile);
    const before = await repo.getBySessionId(GONE);
    expect(await start().forkBackfill).toMatchObject({ ran: true, rows: 1, missing: 1, headsFilled: 0, forks: 0, failed: 0 });
    expect(await repo.getBySessionId(GONE)).toEqual(before);
    expect(await marker()).toMatchObject({ version: FORK_BACKFILL_VERSION, missing: 1 });
  });
});

describe('re-readers honour a stored fork cut (R2.2)', () => {
  it('the prompts backfill and the link store use fork_cut_offset', async () => {
    await writeTranscript(P_DIR, P, [...chain(P, P_CWD), ...own(P, P_CWD, 'p', 10, 'c-4')]);
    const copied = [...forkHeader(F), ...chain(F, F_CWD)];
    const cut = Buffer.byteLength(jsonl(copied));
    await writeTranscript(F_DIR, F, [...copied, ...own(F, F_CWD, 'f', 20, 'c-4')]);
    await writeJob();
    const first = start();
    await first.promptsBackfill; // live ingest (phase 2) linked F and stored its cut
    expect(await repo.getBySessionId(F)).toMatchObject({ parentLinkSource: 'fork', forkCutOffset: cut });
    await first.close();

    await db.execute(sql`update cc_sessions set prompts_version = 0 where session_id = ${F}`);
    const second = start();
    expect(await second.promptsBackfill).toMatchObject({ candidates: 1, filled: 1, failed: 0 });
    expect(await promptTexts(F)).toEqual(['f own question']);

    const refs = await dbLinkStore(db, repo).transcriptsOnHost(HOST);
    expect(refs.find((r) => r.sessionId === F)?.forkCutOffset).toBe(cut);
    expect(refs.find((r) => r.sessionId === P)?.forkCutOffset).toBeNull();
  });
});
```
**Impact:** test only. It relies on phase 2 detecting `F` (job) and `F`/`FF` (head uuid) and on
`scanForkSafely(P)` returning `fork: null`; if those fail the R5.1 assertions name the phase 2 gap directly.

### Step 8: README and CLAUDE.md
**File:** `README.md:668-682` ("### Who started whom")
**Change:** replace the section's intro line and list with:
```markdown
### Who started whom

Links between sessions come from four places, best first, and a better one always wins:

1. **fork:** a session made with `claude --resume X --fork-session`, or a background job forked
   from X, starts with a copy of X's conversation. notesd links it to X from Claude Code's job
   record (`~/.claude/jobs/<id>/state.json`) or, without one, from the message ids it shares with
   X's transcript; a fork of a fork is linked to the fork it was copied from. The copied messages
   are not counted again: the fork's tokens, commits, prompts, replies, title and start time are
   only what it added after the fork point. Forks ingested before notesd knew about forks are found
   once, the first time the daemon starts with fork handling, and re-read from the start with the
   copy cut.
2. **env:** `swarm.py` (in `~/claude-commands`) starts each child with
   `CC_PARENT_SESSION=<its own session id>` in the child's environment, and the notes-session hook
   reports it. A tmux child does not inherit its parent's environment, which is why this has to
   be passed by hand.
3. **hook:** a child started by a Bash command that runs `claude` in a new tmux window, without
   `swarm.py`, claims the record the notes-spawn hook left when its parent ran that command
   (within 30 seconds, same directory, on a fresh start only: a resumed or cleared session claims
   nothing).
4. **heuristic:** sessions from before these hooks existed are linked by reading the parent's
   transcript for `swarm.py launch|spawn --name X` and `SendMessage {to: X}`, and matching a
   child by name, time and directory. A fork's copied messages are not read for this. These links
   are marked "(guessed)" in the panel.
```

**File:** `CLAUDE.md:41` (the "Claude Code sessions" bullet)
**Change:** replace the sentence
`Parent links have a source, \`env\` > \`hook\` > \`heuristic\`, and a worse source never overwrites a better one.`
with:
```markdown
Parent links have a source, `fork` > `env` > `hook` > `heuristic`, and a worse source never overwrites a better one. A fork (`--fork-session`, background jobs) starts with a copy of its parent's records: ingest links it (`fork`, from `<claudeHome>/jobs/<id>/state.json` or a shared `head_uuid`) and stores `fork_cut_offset`, and every reader of a transcript (ingest, the prompts backfill, the link worker, `session_transcript`) skips records that have a uuid and start before that offset (`isCopiedRecord`); records without a uuid are always read. Forks ingested before this are found once per host by the fork backfill (`FORK_BACKFILL_VERSION`, before the prompts backfill), which re-reads each from byte 0 inside the ingester.
```
**File:** `.claude/skills/verify-notesd/features/projects.md` (phase 2's "Forks at ingest" bullet)
**Change:** after its last sentence, `...a separate home so the main fixture's counts stay put.`,
append on the same bullet:
```markdown
  Forks ingested before fork handling are linked and cut once per host on the first daemon start
  with it (the fork backfill, marker `sessions.forks.backfill.<host>` in `app_settings`; proof
  `tests/integration/sessions.forkBackfill.int.test.ts`).
```

**Impact:** docs only.

## Principles applied

- Laziness protocol: the backfill re-ingests a fork by putting the ingester's own in-memory offset to 0 under `withFileHeld` and calling `readFile`, so phase 2's 0-read path does detection, link and cut; no second re-ingest writer, no DB offset reset, no new SessionsRepo method for it (step 4g).
- Laziness protocol: the backfill lives in the ingester, which already has `claudeHome`, the store and the per-file hold; `background.ts` gains only the one-line `backfillAfter` gate (step 5h).
- Fix root causes: on a fresh database (or a host whose link marker is gone) the link worker's one-time scan starts at the first `onPassComplete`, concurrently with the fork backfill. Instead of hoping the cut is stored in time, the scan awaits `forkBackfill` (`backfillAfter`, step 5g), so it always reads `fork_cut_offset` as the backfill left it.
- Subtract before you add: the link scan's private `open`/`readLines` loop is replaced by the ingester's `readJsonlFrom` (which reports line offsets), instead of adding offset bookkeeping to a second reader; the `node:fs/promises` import goes (step 5a, 5c).
- Encode lessons in structure: both re-readers call one shared predicate, `isCopiedRecord` (phase 1's), with the exact invariant-7 rule (uuid and before the cut), instead of each reader starting at the offset. A `custom-title` or `last-prompt` record before the cut is still read; the unit tests pin that (steps 4f, 5c, 6).
- Fix root causes: originals are never re-read. Detection runs first, and only forks are read from byte 0, because a 0-read recomputes push/merge range commits with `git log` and loses them once a worktree is deleted (step 4h, part 3).
- Make illegal states unrepresentable: `PromptsBackfillCandidate.forkCutOffset` is required, not optional, so no producer can drop it silently; `ForkBackfillRow.transcriptPath` is non-null, so the backfill has no "no path" branch (step 1, 2c).
- Prove it works: R5.1 and R5.2 are proven against real Postgres with the real repo and ingester, plus a real throwaway daemon start through verify-notesd for the marker (Verification).

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` and `npm run test:int`
**Proof:** the int test drives the real `startSessionIngest` + `SessionsRepo` against the pgvector
Postgres over JM-UJ/DM-OV-shaped transcripts in a temp `claudeHome`; a throwaway daemon start shows
the marker the backfill writes on the first start.
- Harness: `.claude/skills/verify-notesd` for J6 and the neighbor check. It has no restart
  command, so "a daemon start after the change on a host with old rows" (J3-J5) runs as an
  integration test that starts the real ingester twice against Postgres.
- Feature-map entries: `.claude/skills/verify-notesd/features/projects.md` (read for the
  neighbor check; the fork entry itself is phase 6's)
- Journeys:
  - **J1** · traces R2.2 — `npx vitest run tests/unit/sessions/linkWorker.test.ts -t "fork cut"` → passes when all three tests pass: the scan returns `['impl-x-p3','impl-x-p2']` with the cut and `['impl-x-p1','impl-x-p3','impl-x-p2']` without it; the backfill calls `setParent` exactly once, `['c2','fork']`; and with `backfillAfter` pending no link is made, then after it settles (the cut now stored) exactly `['c2','fork']`
  - **J2** · traces R2.2 — `npx vitest run tests/unit/sessions/ingest.test.ts -t "fork cut"` → passes when the prompts backfill fills 1 row and the fork's stored prompts are exactly `['the fork own prompt']` with `firstPrompt` `'the fork own prompt'`
  - **J3** · traces R2.2 — `npm run test:int -- tests/integration/sessions.forkBackfill.int.test.ts -t "honour a stored fork cut"` → passes when, after `prompts_version` is set to 0 on the fork row, the prompts backfill leaves `cc_session_prompts` for F as exactly `['f own question']`, and `dbLinkStore.transcriptsOnHost` gives F `forkCutOffset` = the byte length of its copied block and P `null`
  - **J4** · traces R5.1 — `npm run test:int -- tests/integration/sessions.forkBackfill.int.test.ts -t "R5.1"` → passes when the legacy F row (stored with commit `d1b23dc`) ends with `parent_session_id` = P, `parent_link_source` `fork`, no commits, 7/3 tokens, prompts `['f own question']`, `started_at` = the fork's first own record; P keeps `d1b23dc`, 117 input tokens and its `updated_at`; the marker holds `version: 1`; the second ingester reports `ran: false` and F's `updated_at` does not move; and in the second test FF links to F (not P) and F to P
  - **J5** · traces R5.2 — `npm run test:int -- tests/integration/sessions.forkBackfill.int.test.ts -t "R5.2"` → passes when the row whose transcript was deleted reads back identical to before (`toEqual`), the report says `missing: 1`, and the `sessions.forks.backfill.test-host` setting exists with `version: 1`, both with and without a fork in the same run
  - **J6** · traces R5.1 — on a real throwaway daemon:
    ```sh
    V=.claude/skills/verify-notesd/scripts/verify.sh
    $V up --sessions                                   # note RUN and URL
    for i in $(seq 30); do
      $V sql RUN "select key, value->>'version' as version, value->>'reingested' as reingested, value->>'rows' as rows from app_settings where key like 'sessions.forks.backfill.%'" | grep -q 'sessions.forks.backfill.' && break
      sleep 1
    done
    $V sql RUN "select key, value->>'version' as version, value->>'reingested' as reingested, value->>'rows' as rows from app_settings where key like 'sessions.forks.backfill.%'"
    $V down RUN
    ```
    → passes when exactly one row `sessions.forks.backfill.<hostname>` shows `version` 1, `reingested` 0 (a fresh daemon's startup ingest already cut every fork through phase 2, so the backfill re-reads nothing) and `rows` equal to `select count(*) from cc_sessions where transcript_path is not null`
- Neighbor check: the session graph still loads after the startup sequence changed (fork backfill before prompts backfill). Within the same J6 run, before `down`: `$V api RUN GET /api/projects` lists both `mcp-notes` and `wall-editing`, and `$V api RUN GET /api/sessions/$BIG/prompts` for the >100-prompt fixture node (found as in `features/projects.md` "Expand prompts") answers `complete: true` with more than 100 prompts
- Cost: none (no LLM turns, no embeddings)
**Exit criteria:** `npm run typecheck`, `npm test` and `npm run test:int` pass; J1-J6 pass; a
second ingester start against the same database reports `forkBackfill.ran === false` and changes no row.

## Handoffs

- **Phase 2 (reconciled):** this phase calls phase 2's `scanForkSafely(file, sessionId)` directly
  (step 4h); its 0-read writes `head_uuid`, the fork columns and the `fork` link, and leaves copied
  records out of `IngestBatch.records`.
- **Phase 1 (reconciled):** `readJsonlFrom`'s `lineStart` and `isCopiedRecord` are phase 1's
  (Step 7b there); `headUuid(file)` and `jobStateFor(claudeHome, sid)` as under Requires;
  `blankSessionRow` sets the fork columns to null.
- **Phase 5 (R2.4):** `session_transcript` (`transcriptSearch.ts`) applies the same cut; not done here.
- **Feature map (reconciled):** this phase adds its one sentence about the fork backfill inside
  phase 2's "Forks at ingest" bullet of `.claude/skills/verify-notesd/features/projects.md`
  (step 8, last change), not at the end of `## Sub-features`, where phase 6 appends in the same
  wave; the two edits touch different lines.
- **`src/background.ts`:** one line (step 5h): the link worker's `backfillAfter` waits for
  `sessionIngest.forkBackfill`. Everything else needs no wiring: the backfill runs inside the
  ingester that `background.ts` already starts with `claudeHome` and the repo; the summary worker
  serves the `requestSummary` calls from the DB; the reply embedding worker's own 60 s sweep
  re-embeds the replaced replies.
- **Not in any phase (follow-up card):** heuristic links that the old scan planted from a fork's
  copied intents (a child linked to the fork rather than the original) are not undone. The link
  backfill skips children that already have a parent, so a re-scan would not fix them either.
  None of R2.2/R5.1/R5.2 requires it; a later fix would clear `heuristic` links whose parent is a
  fork and whose child started before the fork's `forked_at`, then bump `LINKS_BACKFILL_VERSION`.

## Rollback

Revert this phase's commit. Nothing in it changes the schema. Rows the fork backfill already
re-read stay consistent (each was written by one 0-read with the cut). The
`sessions.forks.backfill.<host>` setting can stay or be deleted
(`delete from app_settings where key like 'sessions.forks.backfill.%'`); a later re-apply with
the marker deleted runs the backfill again, and it is idempotent (rows already linked `fork` are
not candidates).
