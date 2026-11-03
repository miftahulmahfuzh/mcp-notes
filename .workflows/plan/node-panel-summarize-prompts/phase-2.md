# Phase 2: Summary requests: worker priority, POST route, summary state in detail

**Plan set:** `NODE_PANEL_SUMMARIZE_PROMPTS_PLAN.md`
**Analysis:** `docs/analyzer/20261103-150033-K7Q2_code_analyzer.md`
**Satisfies:** R1, the server half of "Summarize on demand": a request can be recorded, the owning host's worker serves it first, and session detail says why a node has no summary
**Depends on:** Phase 1 (column `cc_sessions.summary_requested_at`, `SessionsRepo.requestSummary` / `clearSummaryRequest`, `setSummary` clearing the request)
**Difficulty:** NORMAL
**Package:** `src/sessions`, `src/http`

---

## Goal

After this phase, a same-origin `POST /api/sessions/:nodeId/summarize` records a summary request
through `SessionsRepo`. It never calls the summarizer. On its next drain, the summary worker of the
host that owns the session serves requested sessions before the idle backlog. It ignores the
15-minute idle wait, the live filter and the in-process `seen` map, and it still respects the
per-session retry backoff, the global failure pause and the summary rate limiter. Session detail
(`GET /api/sessions/:nodeId`, MCP `session_get`, the context endpoint) carries
`summary_requested_at` and a server-computed `summary_state`
(`ready | empty | requested | idle_wait | other_host`), so the web (Phase 4) only has to map the
state to a label.

## Interface Contract

**Deletes:** none
**Renames:** none
**Creates:**
- `SUMMARY_REQUEST_LIMIT` (`src/sessions/summaryWorker.ts`), `= 100`
- `SummaryStore.listRequested(opts: { host: string; limit: number }): Promise<SummaryCandidate[]>` (`src/sessions/summaryWorker.ts`): rows of `host` with `summary_requested_at is not null`, oldest request first. `lastActiveAt` = `coalesce(last_active_at, started_at, summary_requested_at)`
- `SummaryStore.clearRequest(sessionId: string): Promise<void>` (`src/sessions/summaryWorker.ts`), backed by `SessionsRepo.clearSummaryRequest`
- `SummaryState` type `'ready' | 'empty' | 'requested' | 'idle_wait' | 'other_host'` (`src/sessions/view.ts`)
- `SummaryStateInput` interface and `summaryState(s, thisHost)` pure function (`src/sessions/view.ts`)
- `SummaryRequestPayload` `{ node_id: string; summary_state: SummaryState; summary_requested_at: string | null }` (`src/sessions/view.ts`)
- `SessionInfo.summary_requested_at: string | null` (ISO) and `SessionInfo.summary_state: SummaryState` (`src/sessions/view.ts`)
- `DetailRow.summary_requested_at: Date | string | null` (`src/sessions/view.ts`)
- `SummaryRequestWriter` type `(sessionId: string) => Promise<void>` (`src/sessions/readModel.ts`)
- `SessionsReadDeps.requestSummary: SummaryRequestWriter` and `SessionsReadOverrides.requestSummary?` (`src/sessions/readModel.ts`)
- `SummaryRequestOutcome` type and `requestSummaryFor(rd, nodeId)` (`src/sessions/readModel.ts`)
- Route `POST /api/sessions/:nodeId/summarize` (`src/http/sessionsApi.ts`), with `sameOriginOnly`. Wire answers:
  - 200 `{ node_id, summary_state, summary_requested_at }`
  - 400 `{ error: 'invalid_node_id' }`
  - 403 `{ error: 'forbidden_origin' }` (from the guard)
  - 404 `{ error: 'not_found', node_id }`
  - 409 `{ error: 'empty_session', node_id }`

  The route is idempotent: a second call returns the same `summary_requested_at` and writes nothing. When a summary already exists it answers 200 `ready` and writes nothing.
- `DETAIL_SELECT` gains `s.summary_requested_at` (`src/sessions/readModel.ts`)

**Signature changes:** `processOne(row, c, report)` -> `processOne(row, c, report, requested: boolean)` (closure-internal to `startSummaryWorker`, not exported)
**Requires (from earlier phases):**
- Phase 1: `cc_sessions.summary_requested_at timestamptz null` exists (migration 0010)
- Phase 1: `SessionsRepo.requestSummary(sessionId: string): Promise<unknown>` sets `summary_requested_at = now()` only when it is null. It does not check tokens or host. Its return value is ignored here: the read model re-reads the row.
- Phase 1: `SessionsRepo.clearSummaryRequest(sessionId: string): Promise<unknown>` sets it to null. The return value is ignored.
- Phase 1: `SessionsRepo.setSummary(...)` also sets `summary_requested_at = null`, in the same update
- Phase 1: `truncateAll` (tests/integration/setup.ts) still covers `cc_sessions` (it truncates with cascade, so the new side table is included)

**Leaves alone (owned by others):**
- `src/sessions/repo.ts`, `src/db/schema.ts`, `drizzle/*` (Phase 1)
- `src/sessions/ingest.ts`, `transcript.ts`, `merge.ts`, `types.ts`, `tests/fixtures/*` (Phase 3)
- `cc_session_prompts`, `normalizePrompts`, the `prompts` part of `SessionDetail` and every prompts read (Phase 5)
- `web/**` (Phases 4 and 5)
- MCP tools: none are added. `session_get` picks up the two new `session` fields for free.

**Shared file, sequential:** `.claude/skills/verify-notesd/features/projects.md`. This phase adds the API half of the R1 entry (one Sub-features bullet, one driving block, one Gotcha line). Phase 4 lands after this phase (it depends on 2) and replaces that bullet and that Gotcha line with merged API + UI versions, and adds its UI block after this phase's driving block. Phase 3, which runs beside this phase, does not touch the file.

## Files

| File | Action | What changes |
|---|---|---|
| `src/sessions/summaryWorker.ts` | modify | `SUMMARY_REQUEST_LIMIT`; `SummaryStore.listRequested` / `clearRequest`; `dbSummaryStore` implements them; `processOne` gets `requested`; `drainOnce` serves requests first via a new `processAll` |
| `src/sessions/view.ts` | modify | `SummaryState`, `summaryState()`, `SummaryRequestPayload`; `SessionInfo` + `DetailRow` fields; `toSessionInfo` fills them |
| `src/sessions/readModel.ts` | modify | `DETAIL_SELECT` + `s.summary_requested_at`; `requestSummary` dep + override; `requestSummaryFor` |
| `src/http/sessionsApi.ts` | modify | `POST /api/sessions/:nodeId/summarize`; doc-comment route list |
| `tests/unit/sessions/summaryWorker.test.ts` | modify | memory store implements the new methods; new `summary requests` describe |
| `tests/unit/sessions.view.test.ts` | modify | `detail()` helper gets `summary_requested_at`; new `summaryState` describe |
| `tests/unit/sessions/summarizeRoute.test.ts` | create | route: 403 / 400 / 404 / 409 / 200, idempotence, never writes on `ready` |
| `tests/integration/sessions.summaries.int.test.ts` | modify | `listRequested` + requests-first drain against Postgres |
| `tests/integration/sessions.api.int.test.ts` | modify | POST route + detail `summary_state` against Postgres |
| `.claude/skills/verify-notesd/features/projects.md` | modify | R1 API sub-feature + driving commands |

## Implementation Steps

### Step 1: Store contract: requested candidates and clearing a request
**File:** `src/sessions/summaryWorker.ts:27-66`
**Change:** Add `SUMMARY_REQUEST_LIMIT` after `SUMMARY_SCAN_LIMIT` (line 30). Replace the `SummaryStore` interface (lines 48-66) with the version below.
**Code:**
```ts
/** Full rows loaded per round trip. */
export const DEFAULT_SUMMARY_BATCH = 20;
/** Most candidates one sweep looks at. */
export const SUMMARY_SCAN_LIMIT = 5_000;
/** Most requested sessions one sweep serves (each still waits for the summary rate limiter). */
export const SUMMARY_REQUEST_LIMIT = 100;
```
```ts
/** The reads and writes the worker needs. `dbSummaryStore` is the real one; tests use memory. */
export interface SummaryStore {
  /**
   * Idle sessions of `host` (last_active_at < idleBefore) that may need work, newest first.
   * May return rows that turn out up to date; the worker re-checks by sha.
   */
  listIdle(opts: {
    host: string;
    idleBefore: Date;
    limit: number;
    /** Include rows whose summary may be stale. */
    wantSummary: boolean;
    /** Include rows whose embedding for this model may be stale; null = no embedder. */
    embeddingModel: string | null;
  }): Promise<SummaryCandidate[]>;
  /**
   * Sessions of `host` someone asked to summarize (`summary_requested_at` set; the wall's
   * Summarize button), oldest request first. Not filtered by idleness or liveness.
   */
  listRequested(opts: { host: string; limit: number }): Promise<SummaryCandidate[]>;
  load(sessionIds: readonly string[]): Promise<SessionSummarySource[]>;
  /** Saves a summary. The real store goes through SessionsRepo.setSummary, which also clears a pending request. */
  saveSummary(v: { sessionId: string; summary: string; summarySha: string }): Promise<void>;
  saveEmbedding(v: { sessionId: string; sha: string; model: string; embedding: number[] }): Promise<void>;
  /** Drops a request that can never be served (nothing to summarize). Through SessionsRepo. */
  clearRequest(sessionId: string): Promise<void>;
}
```
**Impact:** Every `SummaryStore` implementation must add the two methods. There are two: `dbSummaryStore` (Step 2) and the unit test's `MemoryStore` (Step 8). `npm run typecheck` fails until both are done, so Steps 1, 2 and 8 land together.

### Step 2: `dbSummaryStore`: read requested rows by raw SQL, clear through the repo
**File:** `src/sessions/summaryWorker.ts:108-179`
**Change:** Replace the whole `dbSummaryStore` function. Add a `toCandidates` helper directly above it (after `SourceDbRow`, line 106). It is shared by `listIdle` and `listRequested`. `listIdle` keeps its SQL unchanged.
**Code:**
```ts
function toCandidates(rows: readonly CandidateDbRow[]): SummaryCandidate[] {
  const out: SummaryCandidate[] = [];
  for (const r of rows) {
    const lastActiveAt = toDate(r.last_active_at);
    if (lastActiveAt === null) continue;
    out.push({
      sessionId: r.session_id,
      lastActiveAt,
      summarySha: r.summary_sha,
      summarizedAt: toDate(r.summarized_at),
      embeddingSha: r.embedding_sha,
      embeddingModel: r.embedding_model,
    });
  }
  return out;
}

/** Reads by raw SQL on the phase-1 column names; writes only through SessionsRepo (invariant 3). */
export function dbSummaryStore(db: Db, repo: SessionsRepo): SummaryStore {
  return {
    async listIdle(o) {
      const needSummary = o.wantSummary
        ? sql`(s.summarized_at is null or s.summarized_at < s.last_active_at)`
        : sql`false`;
      const needEmbedding =
        o.embeddingModel !== null
          ? sql`(e.session_id is null or e.embedding is null or e.embedded_at is null or e.model <> ${o.embeddingModel} or e.embedded_at < s.last_active_at or (s.summarized_at is not null and e.embedded_at < s.summarized_at))`
          : sql`false`;
      const res = await db.execute<CandidateDbRow>(sql`
        select s.session_id, s.last_active_at, s.summary_sha, s.summarized_at,
               e.sha as embedding_sha, e.model as embedding_model
        from cc_sessions s
        left join cc_session_embeddings e on e.session_id = s.session_id
        where s.host = ${o.host}
          and s.last_active_at is not null
          and s.last_active_at < ${o.idleBefore.toISOString()}::timestamptz
          and (${needSummary} or ${needEmbedding})
        order by s.last_active_at desc, s.session_id asc
        limit ${Math.max(1, Math.trunc(o.limit))}
      `);
      return toCandidates(res.rows);
    },
    async listRequested(o) {
      // last_active_at can be null on a row that has only just been created; the request time
      // stands in so the candidate (and the `seen` bookkeeping keyed on it) stays well defined.
      const res = await db.execute<CandidateDbRow>(sql`
        select s.session_id,
               coalesce(s.last_active_at, s.started_at, s.summary_requested_at) as last_active_at,
               s.summary_sha, s.summarized_at,
               e.sha as embedding_sha, e.model as embedding_model
        from cc_sessions s
        left join cc_session_embeddings e on e.session_id = s.session_id
        where s.host = ${o.host}
          and s.summary_requested_at is not null
        order by s.summary_requested_at asc, s.session_id asc
        limit ${Math.max(1, Math.trunc(o.limit))}
      `);
      return toCandidates(res.rows);
    },
    async load(sessionIds) {
      if (sessionIds.length === 0) return [];
      const res = await db.execute<SourceDbRow>(sql`
        select session_id, node_id, repo, branch, name, custom_title, ai_title, first_prompt,
               prompts, commits, files_edited, plan_docs, final_message, summary, summary_sha
        from cc_sessions
        where session_id in (${idList(sessionIds)})
      `);
      return res.rows.map((r) => ({
        sessionId: r.session_id,
        nodeId: r.node_id,
        repo: r.repo,
        branch: r.branch,
        name: r.name,
        customTitle: r.custom_title,
        aiTitle: r.ai_title,
        firstPrompt: r.first_prompt,
        prompts: r.prompts,
        commits: r.commits,
        filesEdited: r.files_edited,
        planDocs: r.plan_docs,
        finalMessage: r.final_message,
        summary: r.summary,
        summarySha: r.summary_sha,
      }));
    },
    async saveSummary(v) {
      await repo.setSummary(v.sessionId, { summary: v.summary, sha: v.summarySha });
    },
    async saveEmbedding(v) {
      await repo.saveEmbedding(v.sessionId, { sha: v.sha, model: v.model, embedding: v.embedding });
    },
    async clearRequest(sessionId) {
      await repo.clearSummaryRequest(sessionId);
    },
  };
}
```
**Impact:** None for the existing callers. `listRequested` reads only light columns and never touches `prompts` (invariant 5). The `load` query is unchanged. Invariant 3 (only `SessionsRepo` writes) still holds, because `clearRequest` goes through `repo.clearSummaryRequest`.

### Step 3: `processOne` knows whether the row was requested
**File:** `src/sessions/summaryWorker.ts:278-348`
**Change:** Replace the whole `processOne` closure. There are two differences from today:
- When `buildSummaryInput` returns null and the row is requested, the request is cleared, so the row is not re-listed forever.
- When the stored summary is already up to date (same sha) and the row is requested, it is saved again. `setSummary` clears the request on that save, and no model call is made.

Everything else, the embedding step included, is unchanged.
**Code:**
```ts
  /**
   * One session: its summary (summarizer on and not paused), then its embedding. `requested`: the
   * row carries summary_requested_at. An up-to-date summary is then saved again (setSummary clears
   * the request, no model call), and a row with nothing to summarize has its request dropped.
   */
  async function processOne(
    row: SessionSummarySource,
    c: SummaryCandidate,
    report: SummaryDrainReport,
    requested: boolean,
  ): Promise<void> {
    const id = row.sessionId;
    const signal = abort.signal;
    let summary = row.summary;
    let failure: string | null = null;
    const summarize = summarizer !== null && !summariesPaused();
    const deferred = summarizer !== null && !summarize;

    if (summarize && summarizer !== null) {
      const input = buildSummaryInput(row);
      if (input === null) {
        // No prompts and no final message: a request for this row can never be served.
        if (requested) await store.clearRequest(id);
      } else {
        const sha = summaryInputSha(input);
        if (sha === row.summarySha && row.summary !== null) {
          const stale = c.summarizedAt === null || c.summarizedAt.getTime() < c.lastActiveAt.getTime();
          if (requested || stale) {
            await store.saveSummary({ sessionId: id, summary: row.summary, summarySha: sha });
          }
        } else {
          if (!(await summaryLimiter.acquire(signal))) return;
          try {
            const clean = cleanSummary(await summarizer.summarize({ sessionId: id, input, signal }));
            if (clean === '') throw new Error('the summarizer returned an empty summary');
            await store.saveSummary({ sessionId: id, summary: clean, summarySha: sha });
            summary = clean;
            report.summarized += 1;
            consecutiveSummaryFailures = 0;
          } catch (err) {
            if (signal.aborted) return;
            failure = errorMessage(err);
            consecutiveSummaryFailures += 1;
            if (consecutiveSummaryFailures >= PAUSE_AFTER_FAILURES) {
              const wait = retryDelayMs(consecutiveSummaryFailures - PAUSE_AFTER_FAILURES + 1);
              pausedUntil = clock.now() + wait;
              log(`[notesd] session summaries: ${consecutiveSummaryFailures} failures in a row, pausing summaries for ${Math.round(wait / 1000)} s`);
            }
          }
        }
      }
    }

    if (embedder !== null) {
      const text = buildEmbedText({ ...row, summary });
      if (text !== null) {
        const sha = embedTextSha(text);
        if (sha !== c.embeddingSha || c.embeddingModel !== embedder.model) {
          if (!(await embedLimiter.acquire(signal))) return;
          try {
            const vectors = await embedder.embed([text]);
            const vector = vectors[0];
            if (vector === undefined || vector.length !== EMBEDDING_DIMENSIONS) {
              throw new Error(`the embedder returned ${vector?.length ?? 0} dimensions, expected ${EMBEDDING_DIMENSIONS}`);
            }
            await store.saveEmbedding({ sessionId: id, sha, model: embedder.model, embedding: vector });
            report.embedded += 1;
          } catch (err) {
            if (signal.aborted) return;
            failure ??= embeddingErrorText(err);
          }
        }
      }
    }

    if (failure !== null) {
      fail(report, id, failure);
      return;
    }
    // A row whose summary step was skipped by the pause is picked up again after it.
    if (deferred) return;
    seen.set(id, c.lastActiveAt.getTime());
    attempts.delete(id);
    retryAt.delete(id);
  }
```
**Impact:** A failed summary of a requested row goes through `fail()` exactly like an idle one: per-session backoff, and the global pause after 3 failures in a row. The request stays set until a summary is saved. Embedding a requested live session embeds its "summary so far". It is re-embedded normally once it goes idle, because `embedded_at < last_active_at`.

### Step 4: `drainOnce` serves requests first
**File:** `src/sessions/summaryWorker.ts:350-393` (and the doc comment of `startSummaryWorker`, lines 232-235)
**Change:** Replace `drainOnce` with the two closures below. `processAll` is the old batch loop, factored out so both lists use it. It now walks each batch in candidate order rather than `load()`'s row order, so "requests oldest first, then idle newest first" really holds: Postgres returns `where in (...)` rows in no defined order.

`drainOnce` makes three reads: requests (only when a summarizer exists, since otherwise nothing can serve them), the live set, and the idle candidates. Requested ids are dropped from the idle list so no session is processed twice in one drain. Requested rows skip only the live filter and `seen`; `retryAt` still applies. The idle wait does not apply to them because `listRequested` has no idle cutoff. The pause check at the top of `drainOnce` and in `processAll` covers both lists, and both go through the same `summaryLimiter` inside `processOne`.

Also update the `startSummaryWorker` doc comment.
**Code:**
```ts
/**
 * Summarizes and embeds sessions of this host in the background. Each drain serves requested
 * sessions first (summary_requested_at; no idle wait, live ones included), then the idle backlog,
 * newest first. Starts a drain at once, then one per sweep. Never throws into its caller.
 */
export function startSummaryWorker(opts: SummaryWorkerOptions): SummaryWorker {
```
```ts
  /** Loads and processes `list` in batches, in list order. Stops on abort or once summaries pause. */
  async function processAll(list: readonly SummaryCandidate[], requested: boolean, report: SummaryDrainReport): Promise<void> {
    for (let i = 0; i < list.length && !abort.signal.aborted; i += batchSize) {
      if (summariesPaused()) return;
      const batch = list.slice(i, i + batchSize);
      const rows = new Map((await store.load(batch.map((c) => c.sessionId))).map((r) => [r.sessionId, r]));
      for (const c of batch) {
        if (abort.signal.aborted) return;
        const row = rows.get(c.sessionId);
        if (row === undefined) continue;
        try {
          await processOne(row, c, report, requested);
        } catch (err) {
          if (abort.signal.aborted) return;
          fail(report, row.sessionId, errorMessage(err));
        }
      }
    }
  }

  async function drainOnce(): Promise<void> {
    const started = clock.now();
    if (summariesPaused()) return;
    const report: SummaryDrainReport = { considered: 0, summarized: 0, embedded: 0, failed: 0, failures: [], ms: 0 };
    try {
      // Requests first. They skip the idle wait, the live filter and `seen` (a live session gets a
      // summary so far; one summarized earlier in this process is served again), but not the
      // per-session retry backoff, the global pause or the summary rate limiter. Without a
      // summarizer nothing can serve them, so they wait for a daemon that has one.
      const requested = summarizer === null ? [] : await store.listRequested({ host, limit: SUMMARY_REQUEST_LIMIT });
      const live = await liveSet();
      const candidates = await store.listIdle({
        host,
        idleBefore: new Date(started - idleMs),
        limit: SUMMARY_SCAN_LIMIT,
        wantSummary: summarizer !== null,
        embeddingModel: embedder?.model ?? null,
      });
      const now = clock.now();
      const requestedIds = new Set(requested.map((c) => c.sessionId));
      const dueRequested = requested.filter((c) => (retryAt.get(c.sessionId) ?? 0) <= now);
      const dueIdle = candidates.filter(
        (c) =>
          !requestedIds.has(c.sessionId) &&
          !live.has(c.sessionId) &&
          seen.get(c.sessionId) !== c.lastActiveAt.getTime() &&
          (retryAt.get(c.sessionId) ?? 0) <= now,
      );
      report.considered = dueRequested.length + dueIdle.length;
      await processAll(dueRequested, true, report);
      await processAll(dueIdle, false, report);
    } catch (err) {
      if (!abort.signal.aborted) log(`[notesd] session summaries: drain failed: ${errorMessage(err).slice(0, LOG_ERROR_CHARS)}`);
    }
    report.ms = clock.now() - started;
    if (report.summarized + report.embedded + report.failed > 0) log(formatSummaryReport(report));
  }
```
**Impact:**
- Another host's request is never listed, because `listRequested` filters on `host`, so only the owning host summarizes (invariant 8).
- No kick from the POST route. The app is built before `startBackground` (`src/daemon.ts:107` vs `:128`), and no handle to the worker reaches the routes. The next sweep, within 60 s, serves the request, as the design allows.
- `formatSummaryReport` is unchanged.

### Step 5: Summary state in the view layer
**File:** `src/sessions/view.ts`. Add `SummaryState` / `SummaryRequestPayload` above `SessionInfo` (line 148). Add two fields to `SessionInfo` after `summarized_at` (line 163). Add `summary_requested_at` to `DetailRow` after `summarized_at` (line 284). Add `summaryState` above `toSessionInfo` (line 470). Replace `toSessionInfo` (lines 476-495).
**Change:** One pure function decides the state, and both the detail payload and the POST answer use it.
**Code:** types, placed directly above `export interface SessionInfo extends GraphNode {`:
```ts
/**
 * Why a session has, or has not, a summary. Decided on the server (summaryState) so the web only
 * maps it to a label: ready (has one), empty (0 tokens, nothing to summarize), requested
 * (summary_requested_at set; the owning host's worker serves it on its next sweep), other_host
 * (only that host's worker can read the transcript), idle_wait (this host; summarized once idle
 * 15 min, live or not).
 */
export type SummaryState = 'ready' | 'empty' | 'requested' | 'idle_wait' | 'other_host';

/** POST /api/sessions/:nodeId/summarize answer. */
export interface SummaryRequestPayload {
  node_id: string;
  summary_state: SummaryState;
  /** ISO time of the pending request; null when there is none (ready, or nothing was recorded). */
  summary_requested_at: string | null;
}
```
`SessionInfo`, the full interface after the change:
```ts
export interface SessionInfo extends GraphNode {
  /**
   * True when `cost_usd` is estimated from token counts and model prices (src/sessions/pricing.ts)
   * because the transcript carried no `cost-state` total. A recorded total already includes subagents.
   */
  cost_estimated: boolean;
  /** Subagent transcripts folded into this session (`cc_subagent_transcripts`). */
  subagent_count: number;
  /** Estimated cost of those subagents, part of `cost_usd`; null without subagent usage. */
  subagent_cost_usd: number | null;
  entrypoint: string | null;
  version: string | null;
  models: unknown;
  transcript_path: string | null;
  last_prompt: string | null;
  summary: string | null;
  summarized_at: string | null;
  /** ISO time someone asked for a summary (Summarize button); null when none is pending. */
  summary_requested_at: string | null;
  summary_state: SummaryState;
  final_message: string | null;
}
```
`DetailRow`, the full type after the change:
```ts
/** NODE_SELECT + DETAIL_SELECT. */
export type DetailRow = NodeRow & {
  entrypoint: string | null;
  version: string | null;
  models: unknown;
  transcript_path: string | null;
  first_prompt_full: string | null;
  last_prompt: string | null;
  summary: string | null;
  summarized_at: Date | string | null;
  summary_requested_at: Date | string | null;
  final_message: string | null;
  prompts: unknown;
  commits: unknown;
  files_edited: unknown;
  plan_docs: unknown;
};
```
`summaryState` + `toSessionInfo`:
```ts
export interface SummaryStateInput {
  has_summary: boolean;
  /** input + output + cache read + cache write. */
  total_tokens: number;
  /** ISO, or null when no request is pending. */
  summary_requested_at: string | null;
  /** The host that owns the session (cc_sessions.host). */
  host: string;
}

/** First match wins: ready > empty > requested > other_host > idle_wait. */
export function summaryState(s: SummaryStateInput, thisHost: string): SummaryState {
  if (s.has_summary) return 'ready';
  if (s.total_tokens <= 0) return 'empty';
  if (s.summary_requested_at !== null) return 'requested';
  if (s.host !== thisHost) return 'other_host';
  return 'idle_wait';
}

export function toSessionInfo(row: DetailRow, ctx: NodeContext, subagents: SubagentShare = { count: 0, costUsd: null }): SessionInfo {
  const node = toGraphNode(row, ctx);
  const estimate = node.cost_usd === null ? estimateCostUsd(isRecord(row.models) ? (row.models as Record<string, Partial<ModelUsage>>) : null) : null;
  const summary = clip(row.summary, Number.MAX_SAFE_INTEGER);
  const summaryRequestedAt = iso(row.summary_requested_at);
  return {
    ...node,
    cost_usd: node.cost_usd ?? estimate,
    cost_estimated: estimate !== null,
    subagent_count: subagents.count,
    subagent_cost_usd: subagents.costUsd,
    first_prompt: clip(row.first_prompt_full, DETAIL_TEXT_CHARS),
    entrypoint: nonEmpty(row.entrypoint),
    version: nonEmpty(row.version),
    models: row.models ?? null,
    transcript_path: nonEmpty(row.transcript_path),
    last_prompt: clip(row.last_prompt, DETAIL_TEXT_CHARS),
    summary,
    summarized_at: iso(row.summarized_at),
    summary_requested_at: summaryRequestedAt,
    summary_state: summaryState(
      { has_summary: summary !== null, total_tokens: node.tokens.total, summary_requested_at: summaryRequestedAt, host: row.host },
      ctx.host,
    ),
    final_message: clip(row.final_message, DETAIL_TEXT_CHARS),
  };
}
```
**Impact:**
- `DetailRow` gains a required field. Its only producers are `DETAIL_SELECT` (Step 6) and the unit test helper `detail()` (Step 9).
- `contextFor` uses `DETAIL_SELECT` too, so it gets the column. `formatContext` output is unchanged.
- MCP `session_get` returns the two new `session` fields. They are additive, and no MCP schema validates the output.
- `unfinished.annotate([detail.session])` is unaffected.

### Step 6: Read model: select the column, inject the writer, `requestSummaryFor`
**File:** `src/sessions/readModel.ts`. Changes land at the imports (lines 17-48), `SessionsReadDeps` / `SessionsReadOverrides` (lines 78-102), after `repoSettings` (line 124), `sessionsReadDeps` (lines 140-153), `DETAIL_SELECT` (lines 189-195), and a new block after `sessionDetail` (after line 360).
**Change:**
- Import `summaryState` and the type `SummaryRequestPayload` from `./view.js`. Add `summaryState,` after `numOrNull,` and `type SummaryRequestPayload,` after `type SessionDetail,`. The full block is below.
- Add the writer type and the dep. A function rather than the whole repo, so the read model can do exactly one write, and only through `SessionsRepo`.
- Add `s.summary_requested_at` to `DETAIL_SELECT`.
- Add `requestSummaryFor`.

**Code:** additions to the deps types, which replace lines 78-102:
```ts
/** Records a summary request for one session: SessionsRepo.requestSummary (invariant 2). */
export type SummaryRequestWriter = (sessionId: string) => Promise<void>;

/** Everything the sessions read API and MCP session tools read through. */
export interface SessionsReadDeps {
  db: Db;
  /** os.hostname() of this daemon: decides `available` and which rows can be `live`. */
  host: string;
  /** IANA zone for usage months and context times (the daemon's local zone). */
  timeZone: string;
  /** Wall base URL for node links. */
  wallUrl: string;
  live: LiveSource;
  settings: SettingsStore;
  search: SessionSearchFn;
  /** Forge links for a session's commits (src/sessions/commitLinks.ts). */
  commitLinks: CommitLinker;
  /** The one session write this API makes (POST /api/sessions/:nodeId/summarize). */
  requestSummary: SummaryRequestWriter;
}

/** Test seams; production passes none. */
export interface SessionsReadOverrides {
  host?: string;
  timeZone?: string;
  live?: LiveSource;
  settings?: SettingsStore;
  search?: SessionSearchFn;
  commitLinks?: CommitLinker;
  requestSummary?: SummaryRequestWriter;
}
```
New seam, placed right after `repoSettings` (after line 124):
```ts
/** Summary requests go through SessionsRepo, created on first use (building deps does no I/O). */
function repoSummaryRequests(db: Db): SummaryRequestWriter {
  let repo: SessionsRepo | null = null;
  return async (sessionId) => {
    repo ??= new SessionsRepo(db);
    await repo.requestSummary(sessionId);
  };
}
```
`sessionsReadDeps`, full replacement:
```ts
export function sessionsReadDeps(deps: AppDeps, over: SessionsReadOverrides = {}): SessionsReadDeps {
  const claudeHome = deps.config.sessions?.claudeHome ?? path.join(os.homedir(), '.claude');
  const embedder = deps.embedder ?? null;
  return {
    db: deps.db,
    host: over.host ?? os.hostname(),
    timeZone: over.timeZone ?? localTimeZone(),
    wallUrl: wallUrlForPort(deps.config.port) ?? DEFAULT_WALL_URL,
    live: over.live ?? (() => liveFromRegistry(claudeHome)),
    settings: over.settings ?? repoSettings(deps.db),
    commitLinks: over.commitLinks ?? createCommitLinker({ homeDir: os.homedir() }),
    search: over.search ?? phase6Search(deps.db, embedder),
    requestSummary: over.requestSummary ?? repoSummaryRequests(deps.db),
  };
}
```
`DETAIL_SELECT`, full replacement:
```ts
/** Extra columns for node detail and the context endpoint. */
const DETAIL_SELECT = sql.raw(`
  s.entrypoint, s.version, s.models, s.transcript_path,
  left(s.first_prompt, 4000) as first_prompt_full,
  left(s.last_prompt, 4000) as last_prompt,
  s.summary, s.summarized_at, s.summary_requested_at,
  left(s.final_message, 4000) as final_message,
  s.prompts, s.commits, s.files_edited, s.plan_docs`);
```
New block after `sessionDetail` (after line 360):
```ts
export type SummaryRequestOutcome =
  | { ok: true; payload: SummaryRequestPayload }
  | { ok: false; error: 'not_found'; node_id: string }
  | { ok: false; error: 'empty_session'; node_id: string };

type SummaryStateRow = {
  session_id: string;
  node_id: string;
  host: string;
  has_summary: boolean | null;
  total_tokens: number | string | null;
  summary_requested_at: Date | string | null;
};

/** The light columns summaryState needs; never loads the summary or prompt text. */
async function readSummaryStateRow(rd: SessionsReadDeps, nodeId: string): Promise<SummaryStateRow | null> {
  const res = await rd.db.execute<SummaryStateRow>(sql`
    select s.session_id, s.node_id, s.host,
      (s.summary is not null and btrim(s.summary) <> '') as has_summary,
      ${TOTAL_TOKENS}::float8 as total_tokens,
      s.summary_requested_at
    from cc_sessions s
    where s.node_id = ${nodeId}
    limit 1`);
  return res.rows[0] ?? null;
}

function summaryPayload(row: SummaryStateRow, thisHost: string): SummaryRequestPayload {
  const requestedAt = iso(row.summary_requested_at);
  return {
    node_id: row.node_id,
    summary_state: summaryState(
      { has_summary: row.has_summary === true, total_tokens: num(row.total_tokens), summary_requested_at: requestedAt, host: row.host },
      thisHost,
    ),
    summary_requested_at: requestedAt,
  };
}

/**
 * Records a summary request for a node (the Summarize button). Never calls the summarizer: the
 * owning host's summary worker serves the request on its next sweep. Idempotent: a node already
 * requested or already summarized is answered as it is, without a write. A session with no tokens
 * has nothing to summarize. `nodeId` is already normalized by the caller.
 */
export async function requestSummaryFor(rd: SessionsReadDeps, nodeId: string): Promise<SummaryRequestOutcome> {
  const before = await readSummaryStateRow(rd, nodeId);
  if (before === null) return { ok: false, error: 'not_found', node_id: nodeId };
  const current = summaryPayload(before, rd.host);
  if (current.summary_state === 'empty') return { ok: false, error: 'empty_session', node_id: before.node_id };
  if (current.summary_state === 'ready' || current.summary_state === 'requested') return { ok: true, payload: current };
  await rd.requestSummary(before.session_id);
  const after = await readSummaryStateRow(rd, nodeId);
  return { ok: true, payload: summaryPayload(after ?? before, rd.host) };
}
```
Final import block (lines 17-48), complete:
```ts
import {
  CONTEXT_HEADER,
  DETAIL_MAX_CHILDREN,
  DETAIL_MAX_NOTES,
  formatContext,
  iso,
  normalizeCommits,
  normalizePaths,
  normalizePrompts,
  num,
  numOrNull,
  summaryState,
  toGraphNode,
  toNodeRef,
  toNoteRef,
  toSessionInfo,
  type ContextNode,
  type ContextPayload,
  type DetailRow,
  type GraphPayload,
  type LiveEntry,
  type NodeContext,
  type NodeRow,
  type NoteRefRow,
  type ProjectsPayload,
  type SearchPayload,
  type SessionDetail,
  type SummaryRequestPayload,
  type TranscriptPayload,
  type UsageMonthRow,
  type UsageNodeRow,
  type UsagePayload,
  type UsageTotals,
} from './view.js';
```
**Impact:** `SessionsReadDeps` gains a required field. Its producers are `sessionsReadDeps` (changed above) and `tests/unit/sessions/linkNoteTool.test.ts:48`, which casts a partial literal `as SessionsReadDeps`, so it still compiles. `src/mcp/tools.ts` only passes it through. `TOTAL_TOKENS` is already defined at line 199, before use.

### Step 7: The POST route
**File:** `src/http/sessionsApi.ts`. Changes land at the import list (lines 6-20), the doc comment (lines 110-125), and the new route inserted before `r.get('/api/sessions/:nodeId', ...)` (line 206).
**Change:** Add `requestSummaryFor` to the `../sessions/readModel.js` import, after `repoExists,`. Add the route, guarded by `sameOriginOnly` like `PUT /api/projects/selected`. The node id is normalized here, once (boundary). The read model trusts it.
**Code:** the import:
```ts
import {
  contextFor,
  graphForRepo,
  knownNodes,
  listProjects,
  readSelected,
  readTranscript,
  repoExists,
  requestSummaryFor,
  searchNodes,
  sessionDetail,
  sessionsReadDeps,
  usage,
  writeSelected,
  type SessionsReadOverrides,
} from '../sessions/readModel.js';
```
Doc comment, full replacement:
```ts
/**
 * The sessions read API (iteration 8, phase 7). The web polls GET /api/projects/:repo/sessions
 * (ETag + If-None-Match) instead of an SSE event: session rows change on every transcript append,
 * and the other laptop's ingest never reaches this daemon's event bus anyway.
 *
 * GET  /api/projects                       repo list, counts, live counts, selected repo
 * GET  /api/projects/selected              { repo }
 * PUT  /api/projects/selected              { repo | null }   same-origin only
 * GET  /api/projects/:repo/sessions        graph payload
 * GET  /api/sessions/context?ids=          prompt-hook context   loopback only
 * GET  /api/sessions/known?ids=            which ids exist, with their repo (chat node links)
 * GET  /api/sessions/search?q=&repo=&limit=
 * GET  /api/sessions/usage?by=&repo=&month=&limit=
 * GET  /api/sessions/:nodeId/transcript?query=&limit=   owning host only
 * POST /api/sessions/:nodeId/summarize     records a summary request   same-origin only
 * GET  /api/sessions/:nodeId
 */
```
Route, inserted directly before `r.get('/api/sessions/:nodeId', async (c) => {`:
```ts
  // Records the request only; the owning host's summary worker serves it (never Haiku here).
  r.post('/api/sessions/:nodeId/summarize', sameOriginOnly, async (c) => {
    const nodeId = normalizeNodeId(c.req.param('nodeId'));
    if (nodeId === null) return c.json({ error: 'invalid_node_id' }, 400);
    const out = await requestSummaryFor(rd, nodeId);
    if (out.ok) return c.json(out.payload);
    if (out.error === 'empty_session') return c.json({ error: out.error, node_id: out.node_id }, 409);
    return c.json({ error: out.error, node_id: out.node_id }, 404);
  });
```
**Impact:** One new route. The guard runs first, so a request without the page's Origin gets 403 before any DB read. There is no MCP tool, by the user's decision.

### Step 8: Worker unit tests (memory store + request behavior)
**File:** `tests/unit/sessions/summaryWorker.test.ts`. Replace imports (lines 1-10), `MemRow` + `MemoryStore` (lines 15-87). Append a new `describe` after the existing one (after line 236).
**Change:** The memory store mirrors the real one: `saveSummary` clears the request (Phase 1 `setSummary`), `listRequested` has no idle filter, and `clearRequest` nulls it. The new tests assert what a caller observes: which sessions the summarizer was called for, in which order, and the store's request/summary state.
**Code:** imports:
```ts
import { describe, expect, it } from 'vitest';
import type { Clock } from '../../../src/embeddings/backfill.js';
import type { SessionSummarySource } from '../../../src/sessions/summarize.js';
import {
  startSummaryWorker,
  type SummaryCandidate,
  type SummaryStore,
  type SummaryWorker,
} from '../../../src/sessions/summaryWorker.js';
import { createFakeEmbedder } from '../../helpers/fakeEmbedder.js';
import { createFakeSummarizer } from '../../helpers/fakeSummarizer.js';
```
`MemRow` + `MemoryStore`:
```ts
interface MemRow extends SessionSummarySource {
  host: string;
  lastActiveAt: Date;
  summarizedAt: Date | null;
  requestedAt: Date | null;
  embedding: { sha: string; model: string; vector: number[] } | null;
}

class MemoryStore implements SummaryStore {
  readonly rows = new Map<string, MemRow>();
  summarySaves = 0;
  embeddingSaves = 0;
  requestClears = 0;

  add(over: Partial<MemRow> & { sessionId: string }): MemRow {
    const row: MemRow = {
      nodeId: 'A0-3G',
      repo: 'mcp-notes',
      branch: null,
      name: null,
      customTitle: 'wall editing',
      aiTitle: null,
      firstPrompt: null,
      prompts: ['make the wall editable'],
      commits: [],
      filesEdited: [],
      planDocs: [],
      finalMessage: 'done',
      summary: null,
      summarySha: null,
      host: HOST,
      lastActiveAt: OLD,
      summarizedAt: null,
      requestedAt: null,
      embedding: null,
      ...over,
    };
    this.rows.set(row.sessionId, row);
    return row;
  }

  private candidate(r: MemRow): SummaryCandidate {
    return {
      sessionId: r.sessionId,
      lastActiveAt: r.lastActiveAt,
      summarySha: r.summarySha,
      summarizedAt: r.summarizedAt,
      embeddingSha: r.embedding?.sha ?? null,
      embeddingModel: r.embedding?.model ?? null,
    };
  }

  async listIdle(o: Parameters<SummaryStore['listIdle']>[0]): Promise<SummaryCandidate[]> {
    return [...this.rows.values()]
      .filter((r) => r.host === o.host && r.lastActiveAt < o.idleBefore)
      .sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime())
      .slice(0, o.limit)
      .map((r) => this.candidate(r));
  }

  async listRequested(o: Parameters<SummaryStore['listRequested']>[0]): Promise<SummaryCandidate[]> {
    return [...this.rows.values()]
      .filter((r): r is MemRow & { requestedAt: Date } => r.host === o.host && r.requestedAt !== null)
      .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime())
      .slice(0, o.limit)
      .map((r) => this.candidate(r));
  }

  async load(ids: readonly string[]): Promise<SessionSummarySource[]> {
    return ids.flatMap((id) => {
      const r = this.rows.get(id);
      return r === undefined ? [] : [{ ...r }];
    });
  }

  /** Like SessionsRepo.setSummary: a saved summary also clears a pending request. */
  async saveSummary(v: { sessionId: string; summary: string; summarySha: string }): Promise<void> {
    const r = this.rows.get(v.sessionId)!;
    r.summary = v.summary;
    r.summarySha = v.summarySha;
    r.summarizedAt = new Date();
    r.requestedAt = null;
    this.summarySaves += 1;
  }

  async saveEmbedding(v: { sessionId: string; sha: string; model: string; embedding: number[] }): Promise<void> {
    this.rows.get(v.sessionId)!.embedding = { sha: v.sha, model: v.model, vector: v.embedding };
    this.embeddingSaves += 1;
  }

  async clearRequest(sessionId: string): Promise<void> {
    this.rows.get(sessionId)!.requestedAt = null;
    this.requestClears += 1;
  }
}
```
New describe, appended at the end of the file:
```ts
/** A clock whose sleep only advances time, so rate-limit waits are observable and instant. */
function fakeClock(): Clock & { slept: number[] } {
  let t = Date.now();
  const slept: number[] = [];
  return {
    slept,
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
  };
}

describe('summary requests', () => {
  it('summarizes a requested session that is live and not idle, and clears the request', async () => {
    const store = new MemoryStore();
    store.add({ sessionId: 'live-now', nodeId: 'B1-22', lastActiveAt: new Date(), requestedAt: new Date() });
    const summarizer = createFakeSummarizer();
    const w = start(store, { summarizer, liveSessionIds: async () => new Set(['live-now']) });
    await w.idle();
    expect(summarizer.calls.map((c) => c.sessionId)).toEqual(['live-now']);
    const row = store.rows.get('live-now')!;
    expect(row.summary).toMatch(/^Summary of Node: B1-22/);
    expect(row.requestedAt).toBeNull();
    await w.close();
  });

  it('serves requests before the idle backlog, oldest request first', async () => {
    const store = new MemoryStore();
    store.add({ sessionId: 'idle', nodeId: 'C0-000' });
    store.add({ sessionId: 'asked-second', nodeId: 'D0-000', lastActiveAt: new Date(), requestedAt: new Date(Date.now() - 1_000) });
    store.add({ sessionId: 'asked-first', nodeId: 'E0-000', lastActiveAt: new Date(), requestedAt: new Date(Date.now() - 60_000) });
    const summarizer = createFakeSummarizer();
    const w = start(store, { summarizer });
    await w.idle();
    expect(summarizer.calls.map((c) => c.sessionId)).toEqual(['asked-first', 'asked-second', 'idle']);
    await w.close();
  });

  it("never serves another host's request", async () => {
    const store = new MemoryStore();
    store.add({ sessionId: 'theirs', host: 'gpd', requestedAt: new Date() });
    const summarizer = createFakeSummarizer();
    const w = start(store, { summarizer });
    await w.idle();
    expect(summarizer.calls).toHaveLength(0);
    expect(store.rows.get('theirs')?.requestedAt).not.toBeNull();
    await w.close();
  });

  it('a request on an up-to-date summary is answered by re-saving it, without a model call', async () => {
    const store = new MemoryStore();
    store.add({ sessionId: 's-1' });
    const summarizer = createFakeSummarizer();
    const w = start(store, { summarizer });
    await w.idle();
    expect(summarizer.calls).toHaveLength(1);
    const row = store.rows.get('s-1')!;
    row.requestedAt = new Date();
    w.kick();
    await w.idle();
    expect(summarizer.calls).toHaveLength(1);
    expect(row.requestedAt).toBeNull();
    expect(store.summarySaves).toBe(2);
    await w.close();
  });

  it('drops a request for a session with nothing to summarize', async () => {
    const store = new MemoryStore();
    store.add({ sessionId: 'blank', prompts: [], firstPrompt: null, finalMessage: null, lastActiveAt: new Date(), requestedAt: new Date() });
    const summarizer = createFakeSummarizer();
    const w = start(store, { summarizer });
    await w.idle();
    expect(summarizer.calls).toHaveLength(0);
    expect(store.rows.get('blank')?.requestedAt).toBeNull();
    expect(store.requestClears).toBe(1);
    await w.close();
  });

  it('a failed request keeps the request and waits for its backoff', async () => {
    const store = new MemoryStore();
    store.add({ sessionId: 's-1', lastActiveAt: new Date(), requestedAt: new Date() });
    const summarizer = createFakeSummarizer();
    summarizer.failNext(1);
    const w = start(store, { summarizer });
    await w.idle();
    w.kick();
    await w.idle();
    expect(summarizer.calls).toHaveLength(1);
    expect(store.rows.get('s-1')?.requestedAt).not.toBeNull();
    await w.close();
  });

  it('requests respect the global pause after three failures in a row', async () => {
    const store = new MemoryStore();
    for (const id of ['r-1', 'r-2', 'r-3']) store.add({ sessionId: id, lastActiveAt: new Date(), requestedAt: new Date() });
    const summarizer = createFakeSummarizer();
    summarizer.failNext(3);
    const w = start(store, { summarizer });
    await w.idle();
    expect(summarizer.calls).toHaveLength(3);
    store.add({ sessionId: 'r-4', lastActiveAt: new Date(), requestedAt: new Date() });
    w.kick();
    await w.idle();
    expect(summarizer.calls).toHaveLength(3);
    expect(store.rows.get('r-4')?.requestedAt).not.toBeNull();
    await w.close();
  });

  it('requests go through the summary rate limiter', async () => {
    const store = new MemoryStore();
    store.add({ sessionId: 'r-1', lastActiveAt: new Date(), requestedAt: new Date(Date.now() - 2_000) });
    store.add({ sessionId: 'r-2', lastActiveAt: new Date(), requestedAt: new Date(Date.now() - 1_000) });
    const clock = fakeClock();
    const summarizer = createFakeSummarizer();
    const w = start(store, { summarizer, embedder: null, clock, minIntervalMs: 5_000 });
    await w.idle();
    expect(summarizer.calls.map((c) => c.sessionId)).toEqual(['r-1', 'r-2']);
    expect(clock.slept).toEqual([5_000]);
    await w.close();
  });

  it('without a summarizer a request waits (not cleared)', async () => {
    const store = new MemoryStore();
    store.add({ sessionId: 's-1', lastActiveAt: new Date(), requestedAt: new Date() });
    const w = start(store, { summarizer: null });
    await w.idle();
    expect(store.rows.get('s-1')?.requestedAt).not.toBeNull();
    await w.close();
  });
});
```
**Impact:** The existing tests are unchanged. `requestedAt` defaults to null, so the idle-path behavior they assert is untouched.

### Step 9: View unit tests
**File:** `tests/unit/sessions.view.test.ts`. Change the imports (lines 2-19), the `detail()` helper (lines 51-69), and append a describe at the end of the file (after line 245).
**Change:** The helper must build a full `DetailRow` (the new required field). Add tests for `summaryState` precedence and for `toSessionInfo` carrying both fields.
**Code:** import block:
```ts
import {
  CONTEXT_NODE_MAX_CHARS,
  excerpt,
  formatContext,
  formatLocalTime,
  iso,
  nodeUrl,
  normalizeCommits,
  normalizePaths,
  normalizePrompts,
  sessionTitle,
  summaryState,
  toGraphNode,
  toNoteRef,
  toSessionInfo,
  type DetailRow,
  type LiveEntry,
  type NodeRow,
} from '../../src/sessions/view.js';
```
`detail()`:
```ts
function detail(over: Partial<DetailRow> = {}): DetailRow {
  return {
    ...row(),
    entrypoint: 'cli',
    version: '2.1.0',
    models: null,
    transcript_path: '/home/m/.claude/projects/x/sess-1.jsonl',
    first_prompt_full: 'plan the session graph',
    last_prompt: null,
    summary: null,
    summarized_at: null,
    summary_requested_at: null,
    final_message: null,
    prompts: [],
    commits: [],
    files_edited: [],
    plan_docs: [],
    ...over,
  };
}
```
New describe:
```ts
describe('summaryState', () => {
  const base = { has_summary: false, total_tokens: 10, summary_requested_at: null, host: 'lenovo' };

  it('ready > empty > requested > other_host > idle_wait', () => {
    expect(summaryState({ ...base, has_summary: true, total_tokens: 0 }, 'lenovo')).toBe('ready');
    expect(summaryState({ ...base, total_tokens: 0, summary_requested_at: '2026-11-03T08:00:00.000Z' }, 'lenovo')).toBe('empty');
    expect(summaryState({ ...base, summary_requested_at: '2026-11-03T08:00:00.000Z', host: 'gpd' }, 'lenovo')).toBe('requested');
    expect(summaryState({ ...base, host: 'gpd' }, 'lenovo')).toBe('other_host');
    expect(summaryState(base, 'lenovo')).toBe('idle_wait');
  });

  it('toSessionInfo carries summary_requested_at as ISO and the state', () => {
    const live = new Map<string, LiveEntry>([['sess-1', { sessionId: 'sess-1', status: 'busy', tmux: null }]]);
    expect(toSessionInfo(detail(), { host: 'lenovo', live })).toMatchObject({ summary_requested_at: null, summary_state: 'idle_wait' });
    expect(toSessionInfo(detail({ summary: '   ' }), { host: 'lenovo', live: noLive }).summary_state).toBe('idle_wait');
    expect(toSessionInfo(detail({ summary: 'Built it.' }), { host: 'lenovo', live: noLive }).summary_state).toBe('ready');
    expect(
      toSessionInfo(detail({ summary_requested_at: new Date('2026-11-03T08:00:00Z') }), { host: 'lenovo', live: noLive }),
    ).toMatchObject({ summary_requested_at: '2026-11-03T08:00:00.000Z', summary_state: 'requested' });
    expect(toSessionInfo(detail({ host: 'gpd' }), { host: 'lenovo', live: noLive }).summary_state).toBe('other_host');
    expect(
      toSessionInfo(detail({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }), { host: 'lenovo', live: noLive })
        .summary_state,
    ).toBe('empty');
  });
});
```
**Impact:** None outside this test file.

### Step 10: Route unit test (no Postgres)
**File:** `tests/unit/sessions/summarizeRoute.test.ts` (create)
**Change:** Drive the real Hono route through `sessionsApiRoutes`. The DB is a scripted stand-in for the one light state query, and the writer is injected through the `requestSummary` override, the same seam production uses for `SessionsRepo`. The test asserts on HTTP status and body, and on whether a write happened.
**Code:**
```ts
import { describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../../../src/deps.js';
import { sessionsApiRoutes } from '../../../src/http/sessionsApi.js';

const OWN = 'http://localhost';
const HOST = 'this-host';
const REQUESTED_AT = '2026-11-03T08:00:00.000Z';

type StateRow = {
  session_id: string;
  node_id: string;
  host: string;
  has_summary: boolean;
  total_tokens: number;
  summary_requested_at: string | null;
};

/** One session row behind the state query; requestSummary sets the request like SessionsRepo does (only when null). */
function harness(row: StateRow | null) {
  const state = { row };
  const execute = vi.fn(async () => ({ rows: state.row === null ? [] : [{ ...state.row }] }));
  const requestSummary = vi.fn(async (_sessionId: string): Promise<void> => {
    if (state.row !== null && state.row.summary_requested_at === null) state.row.summary_requested_at = REQUESTED_AT;
  });
  const deps = {
    config: { port: 7317, sessions: { claudeHome: '/nonexistent-claude-home', swarmScript: null } },
    db: { execute },
    embedder: null,
  } as unknown as AppDeps;
  const app = sessionsApiRoutes(deps, {
    host: HOST,
    requestSummary,
    live: async () => [],
    commitLinks: async () => new Map(),
    unfinished: { annotate: async (nodes) => nodes },
  });
  return { app, execute, requestSummary, state };
}

/** `origin: null` sends no Origin header. */
function post(app: ReturnType<typeof sessionsApiRoutes>, nodeId: string, origin: string | null = OWN): Promise<Response> {
  const headers: Record<string, string> = {};
  if (origin !== null) headers.Origin = origin;
  return Promise.resolve(app.request(`/api/sessions/${nodeId}/summarize`, { method: 'POST', headers }));
}

const idleRow: StateRow = {
  session_id: 'sess-b1',
  node_id: 'B1-22',
  host: HOST,
  has_summary: false,
  total_tokens: 30,
  summary_requested_at: null,
};

describe('POST /api/sessions/:nodeId/summarize', () => {
  it('refuses a missing or foreign Origin before reading or writing anything', async () => {
    const h = harness({ ...idleRow });
    for (const origin of [null, 'http://evil.example', 'http://localhost:5173']) {
      const res = await post(h.app, 'B1-22', origin);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden_origin' });
    }
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.requestSummary).not.toHaveBeenCalled();
  });

  it('400 invalid_node_id for something that is not a node id', async () => {
    const h = harness({ ...idleRow });
    const res = await post(h.app, 'A-B32');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_node_id' });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('404 not_found for an unknown node', async () => {
    const h = harness(null);
    const res = await post(h.app, 'ZZ-ZZ');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found', node_id: 'ZZ-ZZ' });
    expect(h.requestSummary).not.toHaveBeenCalled();
  });

  it('409 empty_session for a session with no tokens, without a write', async () => {
    const h = harness({ ...idleRow, total_tokens: 0 });
    const res = await post(h.app, 'B1-22');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'empty_session', node_id: 'B1-22' });
    expect(h.requestSummary).not.toHaveBeenCalled();
  });

  it('records a request once (case-insensitive, dash optional) and is idempotent', async () => {
    const h = harness({ ...idleRow });
    const first = await post(h.app, 'b122');
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ node_id: 'B1-22', summary_state: 'requested', summary_requested_at: REQUESTED_AT });
    expect(h.requestSummary).toHaveBeenCalledWith('sess-b1');

    const again = await post(h.app, 'B1-22');
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ node_id: 'B1-22', summary_state: 'requested', summary_requested_at: REQUESTED_AT });
    expect(h.requestSummary).toHaveBeenCalledTimes(1);
  });

  it('a summarized node answers ready and records nothing', async () => {
    const h = harness({ ...idleRow, has_summary: true });
    const res = await post(h.app, 'B1-22');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ node_id: 'B1-22', summary_state: 'ready', summary_requested_at: null });
    expect(h.requestSummary).not.toHaveBeenCalled();
  });

  it("another host's node can be requested (its own worker serves it)", async () => {
    const h = harness({ ...idleRow, host: 'gpd' });
    const res = await post(h.app, 'B1-22');
    expect(await res.json()).toEqual({ node_id: 'B1-22', summary_state: 'requested', summary_requested_at: REQUESTED_AT });
  });
});
```
**Impact:** None. A new unit file. It runs under `npm test` (no Docker).

### Step 11: Integration: `listRequested` and the requests-first drain on Postgres
**File:** `tests/integration/sessions.summaries.int.test.ts`. Insert a new `it` inside the existing `describe('session summary worker (Postgres)', ...)`, after the first `it` (before the closing `});` at line 91).
**Code:**
```ts
  it('serves this host\'s requests first (fresh ones too), clears them, and leaves another host\'s request alone', async () => {
    const A = '44444444-4444-4444-4444-444444444444';
    const B = '55555555-5555-5555-5555-555555555555';
    const C = '66666666-6666-6666-6666-666666666666';
    const D = '77777777-7777-7777-7777-777777777777';
    const repo = new SessionsRepo(db);
    await insertSession({ sessionId: A, nodeId: 'A0-3G', lastActiveMinutesAgo: 60, prompts: ['idle backlog'] });
    await insertSession({ sessionId: B, nodeId: 'B1-4H', lastActiveMinutesAgo: 1, prompts: ['live work so far'] });
    await insertSession({ sessionId: C, nodeId: 'C2-5J', host: 'other-host', lastActiveMinutesAgo: 60, prompts: ['elsewhere'] });
    await insertSession({ sessionId: D, nodeId: 'D3-6K', lastActiveMinutesAgo: 1, prompts: [] });
    await db.execute(sql`update cc_sessions set final_message = null where session_id = ${D}`);
    await repo.requestSummary(B);
    await repo.requestSummary(C);
    await repo.requestSummary(D);

    const store = dbSummaryStore(db, repo);
    expect((await store.listRequested({ host: HOST, limit: 10 })).map((c) => c.sessionId).sort()).toEqual([B, D].sort());

    const summarizer = createFakeSummarizer();
    const w = startSummaryWorker({ store, summarizer, embedder: null, host: HOST, minIntervalMs: 0, sweepMs: 3_600_000, log: () => {} });
    await w.idle();
    await w.close();

    expect(summarizer.calls.map((c) => c.sessionId)).toEqual([B, A]);
    const rows = await db.execute<{ session_id: string; summary: string | null; requested: boolean }>(sql`
      select session_id, summary, summary_requested_at is not null as requested from cc_sessions order by session_id
    `);
    const byId = new Map(rows.rows.map((r) => [r.session_id, r]));
    expect(byId.get(B)).toMatchObject({ requested: false });
    expect(byId.get(B)?.summary).toMatch(/^Summary of Node: B1-4H/);
    expect(byId.get(A)?.summary).toMatch(/^Summary of Node: A0-3G/);
    expect(byId.get(C)).toMatchObject({ summary: null, requested: true });
    expect(byId.get(D)).toMatchObject({ summary: null, requested: false });
  });
```
**Impact:** None outside the file. It relies on Phase 1's `requestSummary` / `setSummary` / `clearSummaryRequest` against the migrated schema.

### Step 12: Integration: POST route and detail state on Postgres
**File:** `tests/integration/sessions.api.int.test.ts`. Insert a new `describe` after `describe('GET /api/sessions/:nodeId', ...)` closes (line 243), before `describe('GET /api/sessions/:nodeId/transcript', ...)`.
**Change:** It uses the existing seed graph:
- A0-3G: this host, summarized
- B1-22: this host, 30 tokens, live
- C2-33: other host, 0 tokens
- D4-44: this host, idle, tokens

The default `requestSummary` writer goes through the real `SessionsRepo`.
**Code:**
```ts
describe('POST /api/sessions/:nodeId/summarize', () => {
  const summarize = (nodeId: string, headers: Record<string, string> = SAME_ORIGIN): Promise<Response> =>
    Promise.resolve(app.request(`/api/sessions/${nodeId}/summarize`, { method: 'POST', headers }));

  const requestedAt = async (sessionId: string): Promise<string | null> => {
    const res = await h.deps.db.execute<{ at: Date | string | null }>(
      sql`select summary_requested_at as at from cc_sessions where session_id = ${sessionId}`,
    );
    const at = res.rows[0]?.at ?? null;
    return at === null ? null : new Date(at).toISOString();
  };

  it('detail says why there is no summary', async () => {
    expect((await get<SessionDetail>('/api/sessions/A0-3G')).body.session).toMatchObject({ summary_state: 'ready', summary_requested_at: null });
    expect((await get<SessionDetail>('/api/sessions/B1-22')).body.session.summary_state).toBe('idle_wait');
    expect((await get<SessionDetail>('/api/sessions/C2-33')).body.session.summary_state).toBe('empty');
    await h.deps.db.execute(sql`update cc_sessions set input_tokens = 5 where session_id = 'sess-c2'`);
    expect((await get<SessionDetail>('/api/sessions/C2-33')).body.session.summary_state).toBe('other_host');
  });

  it('records a request through SessionsRepo, same-origin only, idempotently, and detail shows it', async () => {
    const noOrigin = await summarize('D4-44', {});
    expect(noOrigin.status).toBe(403);
    expect(await noOrigin.json()).toEqual({ error: 'forbidden_origin' });
    expect(await requestedAt('sess-d4')).toBeNull();

    const first = await summarize('d444');
    expect(first.status).toBe(200);
    const body = (await first.json()) as { node_id: string; summary_state: string; summary_requested_at: string | null };
    expect(body).toMatchObject({ node_id: 'D4-44', summary_state: 'requested' });
    expect(body.summary_requested_at).toBe(await requestedAt('sess-d4'));
    expect(body.summary_requested_at).not.toBeNull();

    const again = await summarize('D4-44');
    expect(await again.json()).toEqual(body);

    expect((await get<SessionDetail>('/api/sessions/D4-44')).body.session).toMatchObject({
      summary_state: 'requested',
      summary_requested_at: body.summary_requested_at,
    });
  });

  it('a live session can be requested; another host\'s session too', async () => {
    expect(((await (await summarize('B1-22')).json()) as { summary_state: string }).summary_state).toBe('requested');
    await h.deps.db.execute(sql`update cc_sessions set input_tokens = 5 where session_id = 'sess-c2'`);
    expect(((await (await summarize('C2-33')).json()) as { summary_state: string }).summary_state).toBe('requested');
    expect(await requestedAt('sess-c2')).not.toBeNull();
  });

  it('ready writes nothing; empty is 409; bad and unknown ids are 400 / 404', async () => {
    const ready = await summarize('A0-3G');
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ node_id: 'A0-3G', summary_state: 'ready', summary_requested_at: null });
    expect(await requestedAt('sess-root')).toBeNull();

    const empty = await summarize('C2-33');
    expect(empty.status).toBe(409);
    expect(await empty.json()).toEqual({ error: 'empty_session', node_id: 'C2-33' });
    expect(await requestedAt('sess-c2')).toBeNull();

    const bad = await summarize('A-B32');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid_node_id' });

    const missing = await summarize('ZZ-ZZ');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found', node_id: 'ZZ-ZZ' });
  });
});
```
**Impact:** None outside the file. `beforeEach` re-seeds the graph, so the `update`s do not leak between tests.

### Step 13: Feature map: the API half of R1
**File:** `.claude/skills/verify-notesd/features/projects.md`. Add one bullet at the end of `## Sub-features` (after the "A session's \"Notes made\"" bullet, around line 16). Add a block at the end of `## Driving it with verify.sh`, before `## Gotchas`. Add one Gotcha line at the end of `## Gotchas`.
**Change:** Document what a user (or the wall) can now do and how to drive it. Phase 4 later adds the button and label selectors to the same entry.
**Code:** the Sub-features bullet:
```md
- Summary on demand (R1). Session detail carries `summary_state` (`ready` | `empty` | `requested` |
  `idle_wait` | `other_host`) and `summary_requested_at`. Same-origin
  `POST /api/sessions/:nodeId/summarize` records a request: 200 `{ node_id, summary_state, summary_requested_at }`,
  idempotent; 409 `empty_session` for a 0-token session; 403 `forbidden_origin` without the page's Origin;
  a summarized node answers `ready` and records nothing. It never calls the model: the summary worker on the
  host that owns the session serves requests first on its next sweep (within 60 s), live sessions included,
  and the request clears when the summary is saved.
```
Driving block, appended before `## Gotchas`:
````md
Summary requests. Start the run with the summarizer off so nothing is billed and the request stays
visible (`NOTESD_CLAUDE_BIN` pointing nowhere turns summaries off; the daemon log says so):
```sh
NOTESD_CLAUDE_BIN=/nonexistent/claude $V up --sessions
S=$(curl -sf --retry 30 --retry-delay 1 --retry-all-errors "$URL/api/projects/mcp-notes/sessions")
NODE=$(jq -r '.nodes[] | select(.session_id=="5e55a001-0000-4000-8000-000000000001") | .node_id' <<<"$S")
$V api RUN GET /api/sessions/$NODE                # session.summary_state "idle_wait"
$V api RUN POST /api/sessions/$NODE/summarize     # 200 summary_state "requested", summary_requested_at set
$V api RUN POST /api/sessions/$NODE/summarize     # same body again (idempotent)
$V api RUN POST /api/sessions/ZZ-ZZ/summarize     # 404 not_found
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL/api/sessions/$NODE/summarize"   # 403: no Origin
$V sql RUN "select node_id, summary_requested_at from cc_sessions where summary_requested_at is not null"
```
No fixture node has 0 tokens (fixture `…0003` is an `sdk-cli` session, which ingest skips), so the
409 `empty_session` answer is proven by `tests/integration/sessions.api.int.test.ts`, not on a run.
````
Gotcha line, appended at the end of `## Gotchas`:
```md
- Do not prove "the worker serves a request" on a run with a real `claude` binary: it bills Haiku. That
  half is proven by `tests/unit/sessions/summaryWorker.test.ts` and `tests/integration/sessions.summaries.int.test.ts`.
```
**Impact:** Documentation only. Phase 4 appends UI selectors to the same file.

## Principles applied

- Laziness protocol: requested rows reuse `processOne` with one `requested` flag and the existing batch loop (`processAll`). There is no second worker and no new candidate type. The route gets no kick hook into the worker, because no handle reaches the routes (`daemon.ts` builds the app before `startBackground`). The design's "next 60 s sweep" is enough.
- Laziness protocol: the read model gets one injected function, `requestSummary: (sessionId) => Promise<void>` (default: lazy `SessionsRepo.requestSummary`), instead of a repo object on `SessionsReadDeps`. That one seam is the only write the sessions read API can make, and tests inject it without Postgres.
- Make illegal states unrepresentable: the state is one server-side enum computed by a single pure function, `summaryState`, used by both detail and the POST answer. The web gets no booleans it has to combine (`summary`, `available`, `live`, tokens), so they cannot contradict each other. `SummaryRequestOutcome` is a discriminated union, so the route cannot answer 200 with an error body.
- Boundary discipline: the node id is normalized once, in the route (`normalizeNodeId`). `requestSummaryFor` trusts it. The same-origin check is the existing `sameOriginOnly` middleware, applied before any read.
- Test behavior, not implementation: the worker tests assert which sessions the summarizer saw, their order, and the request/summary state of the store, never private maps. The route tests assert HTTP status/body and whether a write happened.
- Prove it works: the Proof drives the real daemon (`verify-notesd`). The billed "worker serves it with Haiku" half is proven against Postgres with the fake summarizer instead, and says so.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` (unit, incl. `npx vitest run tests/unit/sessions/summaryWorker.test.ts tests/unit/sessions/summarizeRoute.test.ts tests/unit/sessions.view.test.ts`) and `npm run test:int` (incl. `tests/integration/sessions.summaries.int.test.ts`, `tests/integration/sessions.api.int.test.ts`)
**Proof:** The real daemon records and reports summary requests over HTTP, and the DB row shows the write.
- Harness: `.claude/skills/verify-notesd`. Run from the worktree root with `V=.claude/skills/verify-notesd/scripts/verify.sh`.
- Feature-map entries: `.claude/skills/verify-notesd/features/projects.md` (Summary on demand, added in Step 13)
- Journeys:
  1. **Launch with summaries off.** Run `NOTESD_CLAUDE_BIN=/nonexistent/claude $V up --sessions`, then note `RUN` and `URL`.
     - Pass: `grep -c 'session summaries off' ~/.local/state/notesd-verify/$RUN/daemon.log` prints `1` or more.
  2. **Detail reports the state.**
     ```sh
     S=$(curl -sf --retry 30 --retry-delay 1 --retry-all-errors "$URL/api/projects/mcp-notes/sessions")
     NODE=$(jq -r '.nodes[] | select(.session_id=="5e55a001-0000-4000-8000-000000000001") | .node_id' <<<"$S")
     curl -sf "$URL/api/sessions/$NODE" | jq '.session | {summary_state, summary_requested_at}'
     ```
     - Pass: it prints `{"summary_state":"idle_wait","summary_requested_at":null}`.
  3. **Summarize records a request.** Run `$V api RUN POST /api/sessions/$NODE/summarize`, then `$V sql RUN "select node_id, summary_requested_at from cc_sessions where session_id='5e55a001-0000-4000-8000-000000000001'"`.
     - Pass: the api evidence shows status 200 and body `{"node_id":"<NODE>","summary_state":"requested","summary_requested_at":"<ISO>"}`. The sql evidence shows the same non-null timestamp.
     - Pass: `curl -sf "$URL/api/sessions/$NODE" | jq -r .session.summary_state` prints `requested`.
  4. **Idempotent.** Run `$V api RUN POST /api/sessions/$NODE/summarize` again.
     - Pass: status 200, and the body has the same `summary_requested_at` as journey 3.
  5. **Empty session refused, unknown node 404.** No fixture node has 0 tokens: fixture `…0003` is an `sdk-cli` transcript, which ingest excludes, so it has no row. Run `npm run test:int -- tests/integration/sessions.api.int.test.ts -t "ready writes nothing"` for the 409, and `$V api RUN POST /api/sessions/ZZ-ZZ/summarize` on the run.
     - Pass: the int test passes (409 `{"error":"empty_session","node_id":"C2-33"}`, no write). The api evidence shows status 404 and `{"error":"not_found","node_id":"ZZ-ZZ"}`.
  6. **Same-origin only.** Run `curl -s -w '\n%{http_code}\n' -X POST "$URL/api/sessions/$NODE/summarize"` (no Origin) and `curl -s -w '\n%{http_code}\n' -X POST -H 'Origin: http://evil.example' "$URL/api/sessions/$NODE/summarize"`.
     - Pass: both print `{"error":"forbidden_origin"}` and `403`.
  7. **No model call from HTTP, and the worker side.** The real daemon cannot show this without billing, so run `npx vitest run tests/unit/sessions/summaryWorker.test.ts -t "summary requests"` and `npm run test:int -- tests/integration/sessions.summaries.int.test.ts`.
     - Pass: all `summary requests` tests pass, including: live requested session summarized and cleared; other host's request untouched; pause and limiter respected. The int test "serves this host's requests first" passes.
  8. Run `$V note RUN "R1 server: summary_state in detail, POST summarize records/idempotent/409/403"` and then `$V down RUN`.
- Neighbor check: session detail for the other fields, and the graph poll.
  - Run `curl -sf "$URL/api/sessions/$NODE" | jq '.session | {node_id, tokens, summary, available}, (.prompts|length)'`. Pass: it still returns the node with its tokens and prompts.
  - Run `curl -s -o /dev/null -w '%{http_code}' "$URL/api/projects/mcp-notes/sessions"`. Pass: it prints `200`.
  - The existing `sessions.api.int.test.ts` suites (detail, transcript, context) stay green under `npm run test:int`.

**Exit criteria:**
- A requested live session on this host is summarized on the next drain and its request is cleared.
- A request of another host is never summarized here.
- Requests respect the pause and the limiter.
- The POST is same-origin only and never calls the summarizer.
- Detail carries `summary_state` and `summary_requested_at`.
- `npm run typecheck`, `npm test` and `npm run test:int` are green.
- Journeys 1-7 pass on a verify-notesd run.

## Handoffs

- **Phase 4 (R1 web):** consumes these wire names:
  - `SessionInfo.summary_state`: one of `'ready' | 'empty' | 'requested' | 'idle_wait' | 'other_host'`
  - `SessionInfo.summary_requested_at`: ISO string, or null
  - `POST /api/sessions/:nodeId/summarize`: 200 `{ node_id, summary_state, summary_requested_at }`; 409 `{ error: 'empty_session', node_id }`; 403 `{ error: 'forbidden_origin' }`; 404 `{ error: 'not_found', node_id }`

  Labels: `empty` → "Empty session" (no button), `requested` → "Summary requested", `other_host` → "Will be summarized on <host>" (host is `session.host`), `idle_wait` → "Summarizes once idle". Phase 4 also appends the UI selectors to the "Summary on demand" sub-feature this phase adds to `features/projects.md`.
- **Phase 4:** the panel's re-fetch trigger (`stamp`). A summary landing changes `summary_excerpt` in the graph poll but not `last_active_at`. This phase does not change the graph payload.
- **Phase 5 (R2):** edits `readModel.ts`, `view.ts` and `sessionsApi.ts` after this phase. It should add its `GET /api/sessions/:nodeId/prompts` route next to the new POST route, above `GET /api/sessions/:nodeId`, and extend the doc-comment route list this phase rewrote. `DETAIL_SELECT` now ends its summary line with `s.summary_requested_at`.
- **Phase 1:** if `requestSummary` / `clearSummaryRequest` end up with different names, or `setSummary` does not clear `summary_requested_at`, then Steps 2 and 6 (call sites) and Step 11 (int test) must follow. The worker relies on `setSummary` clearing the request. Otherwise a served request would be re-listed every sweep and re-saved, with no model call but forever. Nothing more is needed in `repo.ts`.
- **Not planned (out of scope):** a log line counting requests served per drain (`formatSummaryReport` is unchanged), and diagnosing GPD's paused worker.

## Rollback

Revert this phase's commit. It has no schema change, so the `summary_requested_at` column (Phase 1) stays and goes unused. Requests recorded meanwhile stay in the column until Phase 1's `setSummary` or a manual `update cc_sessions set summary_requested_at = null` clears them. Without this phase's worker they are simply never served. `features/projects.md` reverts with the commit.
