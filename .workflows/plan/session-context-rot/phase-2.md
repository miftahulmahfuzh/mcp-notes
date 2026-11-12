# Phase 2: Context read API and live stream

**Plan set:** `SESSION_CONTEXT_ROT_PLAN.md`
**Analysis:** `.workflows/analyze/20261112-093143-CR7T_code_analyzer.md`
**Satisfies:** R3: the server half of "show live usage increase on a running session"
**Criteria:** R3.2, R3.3
**Depends on:** Phase 1
**Difficulty:** NORMAL
**Package:** `src/http`, `src/sessions`, root wiring (`src/deps.ts`, `src/daemon.ts`, `src/background.ts`)

---

## Goal

After this phase every session read can carry the session's current context fill. Session
detail (`GET /api/sessions/:nodeId`, and MCP `session_get` through it) and a new
`GET /api/sessions/:nodeId/context` return
`{tokens, window, percent, band, model, at, window_source, peak_tokens}`, or `null` when nothing
was captured. The window and band are inferred at read time from phase 1's stored evidence. A new
per-node SSE stream, `GET /api/sessions/:nodeId/context/stream`, sends a `context` event on
connect and another every time ingest commits a write that moves that session's context. An
in-process `SessionEvents` bus, fed by an ingest observer, drives it.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `src/sessions/events.ts` (new file): `SessionEvents` (class: `emitContext(sessionId)`, `on(listener) => unsubscribe`, `listenerCount()`), `SessionContextEvent`, `SessionEventListener`, `ContextBatchLike`, `batchMovesContext(batch)`, `sessionContextObserver(events)`.
- `src/sessions/view.ts`: `SessionContext` (interface), `SessionContextPayload` (interface `{node_id, host, available, context}`), `ContextRow` (row type), `ContextBand`, `ContextWindowSource` (re-exported from phase 1's `contextWindow.ts`), `toSessionContext(row)`; new field `SessionInfo.context: SessionContext | null`; `DetailRow` gains the `ContextRow` columns.
- `src/sessions/readModel.ts`: `readSessionContext(rd, nodeId)`, `SessionContextRead`; `DETAIL_SELECT` gains the context columns.
- `src/http/sessionsApi.ts`: routes `GET /api/sessions/:nodeId/context` and `GET /api/sessions/:nodeId/context/stream`; constants `CONTEXT_STREAM_DEBOUNCE_MS = 250` and `CONTEXT_STREAM_HEARTBEAT_MS = 25_000`; `SessionsApiOptions.contextDebounceMs?` and `SessionsApiOptions.sseHeartbeatMs?` (test seams).
- `src/deps.ts`: optional `AppDeps.sessionEvents?: SessionEvents`.

**Signature changes:** none to existing functions. `toSessionInfo` returns one more field, and `DetailRow` has five more required keys, so every hand-built `DetailRow` must add them (the one in the repo: `tests/unit/sessions.view.test.ts:56`, updated here).

**Requires (from earlier phases):**
- Phase 1: `cc_sessions` columns `context_tokens bigint null`, `context_model text null`, `context_at timestamptz null`, `context_peak_tokens bigint null`, `context_long_beta boolean not null default false` (migration `drizzle/0016_session_context.sql`). This phase reads them with raw SQL only and never writes them. It does not read `context_first_tokens`, which phase 3 uses.
- Phase 1: `src/sessions/contextWindow.ts` exports `contextWindowFor({ model, peakTokens, longBeta })`, returning `{ window: number; source: 'model' | 'peak' | 'beta' | 'default' }`, and `contextBand(percent: number)`. It also exports `contextPercent(tokens, window)` (one decimal, 0..100+, 0 for a non-positive window) and the types `ContextWindowInput { model: string | null; peakTokens: number | null; longBeta: boolean }`, `ContextBand`, `ContextWindowSource`. This phase calls exactly those: `contextWindowFor({ model, peakTokens, longBeta })` with `model: string | null` and `peakTokens: number`, `contextPercent(tokens, window)` for `percent`, and `contextBand(percent)` on that same shown percent (reconciled: no local percent arithmetic). `view.ts` re-exports phase 1's `ContextBand` / `ContextWindowSource` types.
- Phase 1: ingest stores the context in the same `upsertFromTranscript` commit that `notifyBatch` follows. No change to `IngestBatch` / `IngestObserver` (`src/sessions/ingest.ts:151-177`) is needed.

**Leaves alone (owned by others):**
- Phase 1: `src/sessions/transcript.ts`, `types.ts`, `merge.ts`, `repo.ts`, `ingest.ts`, `src/db/schema.ts`, `drizzle/*`, `src/sessions/contextWindow.ts`.
- Phase 3: `src/sessions/resume.ts`, `src/sessions/handoff.ts`, `src/http/sessionResume.ts`, `src/mcp/sessionTools.ts` (not edited: `session_get` spreads `sessionDetail(...)`, `sessionTools.ts:138-149`, so `session.context` flows through untouched), `claude/hooks/*`.
- Phase 4: `web/**`, `README.md`, `.claude/skills/verify-notesd/features/*`.

## Files

| File | Action | What changes |
|---|---|---|
| `src/sessions/events.ts` | create | `SessionEvents` bus, batch filter, ingest observer |
| `src/sessions/view.ts` | modify | `SessionContext`, `SessionContextPayload`, `ContextRow`, `toSessionContext`; `SessionInfo.context` (L187-208); `DetailRow` (L343-358); `toSessionInfo` (L585-611) |
| `src/sessions/readModel.ts` | modify | imports (L18-56); context columns in `DETAIL_SELECT` (L247-253); new `readSessionContext` after `sessionDetail` (after L446) |
| `src/http/sessionsApi.ts` | modify | imports (L1-25); options (L39-42); doc comment (L112-128); two routes before the catch-all `GET /api/sessions/:nodeId` (L228) |
| `src/deps.ts` | modify | optional `sessionEvents` (after L23) |
| `src/daemon.ts` | modify | create the bus (L87), add it to `deps` (L103) |
| `src/background.ts` | modify | add `sessionContextObserver` to the ingest observers (L106) |
| `tests/unit/sessions.view.test.ts` | modify | `detail()` helper gets the context keys (L56-75); new `toSessionContext` describe |
| `tests/unit/sessions/sessionEvents.test.ts` | create | bus, batch filter, observer |
| `tests/unit/sessions/contextRoute.test.ts` | create | JSON route and stream with a fake db and a real bus |
| `tests/integration/sessions.api.int.test.ts` | modify | new describe: detail and JSON route carry the context |
| `tests/integration/sessions.contextStream.int.test.ts` | create | real ingest, real bus, SSE event after an appended assistant record |

## Implementation Steps

### Step 1: The session event bus and the ingest observer
**File:** `src/sessions/events.ts` (new)
**Change:** A copy of the `NoteEvents` pattern (`src/notes/events.ts`) with one event kind. The
observer filter is a pure exported function so it can be tested without ingest. It reads a
structural batch type, as `src/sessions/links.ts:129` does, so this module does not import
`ingest.ts`.
**Code:**
```ts
import { EventEmitter } from 'node:events';

/** A session's stored context may have changed (an ingest write committed). Carries no values: listeners re-read. */
export interface SessionContextEvent {
  type: 'context';
  sessionId: string;
}

export type SessionEventListener = (event: SessionContextEvent) => void;

/**
 * In-process bus for session context changes. The ingest observer below is the only emitter;
 * each open GET /api/sessions/:nodeId/context/stream subscribes with `on`. The other laptop's
 * ingest never reaches this bus: its sessions are polled (phase 4).
 */
export class SessionEvents {
  private readonly emitter = new EventEmitter();

  constructor() {
    // One listener per open context stream; no artificial cap.
    this.emitter.setMaxListeners(0);
  }

  emitContext(sessionId: string): void {
    const event: SessionContextEvent = { type: 'context', sessionId };
    this.emitter.emit('context', event);
  }

  /** Subscribes and returns the unsubscribe function. */
  on(listener: SessionEventListener): () => void {
    this.emitter.on('context', listener);
    return () => {
      this.emitter.off('context', listener);
    };
  }

  listenerCount(): number {
    return this.emitter.listenerCount('context');
  }
}

/** The part of an ingest batch (src/sessions/ingest.ts IngestBatch) the context observer reads. */
export interface ContextBatchLike {
  sessionId: string;
  fromOffset: number;
  /** Parsed records of the batch, copied fork records excluded (ingest drops them before this). */
  records: readonly Record<string, unknown>[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A main-chain (not sidechain) assistant record that carries a usage object. */
function isMainChainAssistantWithUsage(record: Record<string, unknown>): boolean {
  if (record.type !== 'assistant' || record.isSidechain === true) return false;
  const message = record.message;
  return isObject(message) && isObject(message.usage);
}

/**
 * True when a committed batch can have moved the session's stored context:
 * - it holds a main-chain assistant record with usage (the unit of change, phase 1 R1.2), or
 * - it was a read from byte 0 (a first read, a shrunk file, a fork re-read). Such a read replaces
 *   the stored context, and a fork's copied context (R1.4) arrives through records the batch does not list.
 * Sidechain records, user records and bookkeeping never move it.
 */
export function batchMovesContext(batch: ContextBatchLike): boolean {
  if (batch.fromOffset === 0) return true;
  return batch.records.some(isMainChainAssistantWithUsage);
}

/** Ingest observer: after a committed write that can have moved a session's context, tell the bus. Never throws. */
export function sessionContextObserver(events: SessionEvents): { onBatch(batch: ContextBatchLike): void } {
  return {
    onBatch(batch: ContextBatchLike): void {
      if (batchMovesContext(batch)) events.emitContext(batch.sessionId);
    },
  };
}
```
**Impact:** New module, no callers yet. The tree builds.

### Step 2: The context object in the read model's view types
**File:** `src/sessions/view.ts`
**Change:**
1. Imports (L8-9): add the phase 1 module.
2. After `ForkPoint` (after L54): re-export `ContextBand`, `ContextWindowSource`; add `SessionContext`, `SessionContextPayload`.
3. `SessionInfo` (L187-208): add `context`.
4. `NodeRow` / `DetailRow` (L314-358): add `ContextRow` and include it in `DetailRow`.
5. After `tokenCounts` (after L489): add `toSessionContext`.
6. `toSessionInfo` (L585-611): set `context`.

**Code:**

Imports, replacing L8-9:
```ts
import { PARENT_LINK_SOURCES, type ModelUsage, type ParentLinkSource } from '../db/schema.js';
import { contextBand, contextPercent, contextWindowFor, type ContextBand, type ContextWindowSource } from './contextWindow.js';
import { estimateCostUsd } from './pricing.js';
```

New types, inserted after the `ForkPoint` interface (after L54):
```ts
/** Colour band of a context fill (phase 1's contextBand: green < 40%, amber 40-70%, red >= 70%). */
export type { ContextBand, ContextWindowSource };

/**
 * A session's current context fill: the input + cache read + cache write + output tokens of its
 * latest main-chain assistant message (phase 1 capture) against the inferred window. The window
 * is computed at read time from the stored model, peak and long-context beta flag (never stored).
 */
export interface SessionContext {
  tokens: number;
  window: number;
  /** tokens / window * 100, one decimal. */
  percent: number;
  band: ContextBand;
  /** Model of the latest main-chain assistant message, as the transcript wrote it. */
  model: string | null;
  /** ISO time of that message. */
  at: string | null;
  window_source: ContextWindowSource;
  /** The highest context this session ever reported (never below `tokens`). */
  peak_tokens: number;
}

/** GET /api/sessions/:nodeId/context, and each `context` event of its stream. Any host. */
export interface SessionContextPayload {
  node_id: string;
  host: string;
  /** True when the session ran on this daemon's host (its stream can be live). */
  available: boolean;
  /** Null while no main-chain assistant message with usage was captured: unknown, not 0%. */
  context: SessionContext | null;
}
```

`SessionInfo`: add this member right after `final_message: string | null;` (L207):
```ts
  /** Current context fill (see SessionContext); null when none was captured. */
  context: SessionContext | null;
```

`ContextRow`: insert just before the `/** NODE_SELECT + DETAIL_SELECT. */` comment (L342):
```ts
/** readModel's context columns (phase 1's cc_sessions context_*; bigints cast to float8). */
export type ContextRow = {
  context_tokens: number | string | null;
  context_model: string | null;
  context_at: Date | string | null;
  context_peak_tokens: number | string | null;
  context_long_beta: boolean | null;
};
```

`DetailRow`, replacing L342-358:
```ts
/** NODE_SELECT + DETAIL_SELECT (which carries the context columns). */
export type DetailRow = NodeRow &
  ContextRow & {
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

`toSessionContext`, inserted after `tokenCounts` (after L489):
```ts
/**
 * The context columns become a SessionContext, or null when no context was captured. Percent is
 * phase 1's contextPercent (one decimal, 0..100+) and the band is contextBand of that same shown
 * percent, so the number and the colour always agree (79,990 of 200k prints 40.0 and is amber).
 */
export function toSessionContext(row: ContextRow): SessionContext | null {
  const tokens = numOrNull(row.context_tokens);
  if (tokens === null) return null;
  const peak = Math.max(tokens, numOrNull(row.context_peak_tokens) ?? tokens);
  const model = nonEmpty(row.context_model);
  const { window, source } = contextWindowFor({ model, peakTokens: peak, longBeta: row.context_long_beta === true });
  const percent = contextPercent(tokens, window);
  return {
    tokens,
    window,
    percent,
    band: contextBand(percent),
    model,
    at: iso(row.context_at),
    window_source: source,
    peak_tokens: peak,
  };
}
```

`toSessionInfo`: in the returned object, after `final_message: clip(row.final_message, DETAIL_TEXT_CHARS),` (L610) add:
```ts
    context: toSessionContext(row),
```
**Impact:** `SessionInfo` gains `context` everywhere `toSessionInfo` is used: `sessionDetail`, and `contextFor` (the prompt hook's endpoint, which ignores it because `formatContext` does not print it). `DetailRow` gains required keys, so `tests/unit/sessions.view.test.ts` must change in this same step (Step 7) or typecheck fails.

### Step 3: Context columns in the detail SQL, and a narrow context read
**File:** `src/sessions/readModel.ts`
**Change:**
1. View import block (L18-56): add `toSessionContext`, `type ContextRow`, `type SessionContextPayload`.
2. Replace `DETAIL_SELECT` (L246-253) with a shared column list and the extended select.
3. After `sessionDetail` (after L446), add `readSessionContext`.

**Code:**

In the `from './view.js'` import list add (alphabetical order inside the list):
```ts
  toSessionContext,
  type ContextRow,
  type SessionContextPayload,
```

Replacing L246-253:
```ts
/** Phase 1's context columns. Window and band are inferred from them at read time (toSessionContext). */
const CONTEXT_COLUMNS = `
  s.context_tokens::float8 as context_tokens, s.context_model, s.context_at,
  s.context_peak_tokens::float8 as context_peak_tokens, s.context_long_beta`;

const CONTEXT_SELECT = sql.raw(CONTEXT_COLUMNS);

/** Extra columns for node detail and the context endpoint. */
const DETAIL_SELECT = sql.raw(`
  s.entrypoint, s.version, s.models, s.transcript_path,
  left(s.first_prompt, 4000) as first_prompt_full,
  left(s.last_prompt, 4000) as last_prompt,
  s.summary, s.summarized_at, s.summary_requested_at,
  left(s.final_message, 4000) as final_message,
  s.prompts, s.commits, s.files_edited, s.plan_docs,${CONTEXT_COLUMNS}`);
```

After `sessionDetail` (after L446):
```ts
type ContextReadRow = ContextRow & { session_id: string; node_id: string; host: string };

/** One node's context, with the session id the context stream matches SessionEvents against. */
export interface SessionContextRead {
  sessionId: string;
  payload: SessionContextPayload;
}

/**
 * GET /api/sessions/:nodeId/context and every re-read of its stream: one indexed read on node_id,
 * light columns only, any host (the columns live in the shared database). Null: no such node.
 */
export async function readSessionContext(rd: SessionsReadDeps, nodeId: string): Promise<SessionContextRead | null> {
  const res = await rd.db.execute<ContextReadRow>(sql`
    select s.session_id, s.node_id, s.host, ${CONTEXT_SELECT}
    from cc_sessions s
    where s.node_id = ${nodeId}
    limit 1`);
  const row = res.rows[0];
  if (row === undefined) return null;
  return {
    sessionId: row.session_id,
    payload: { node_id: row.node_id, host: row.host, available: row.host === rd.host, context: toSessionContext(row) },
  };
}
```
**Impact:** `sessionDetail` and `contextFor` now select five more columns (a few bytes per row). `readSessionContext` has no callers until Step 4.

### Step 4: The JSON route and the SSE stream
**File:** `src/http/sessionsApi.ts`
**Change:**
1. Imports (L1-25): add `streamSSE`, `readSessionContext`, `SessionContext`, `SessionContextPayload`.
2. Constants after L37 and options (L39-42).
3. A `contextKey` helper after `parseIdList` (after L110).
4. Doc comment (L112-128): drop the "sessions have no SSE" claim and list the new routes.
5. Both routes go right after the `/prompts` route (L219-225), before the catch-all `r.get('/api/sessions/:nodeId', ...)` (L228). Hono's `:nodeId` matches one segment, so the catch-all would not shadow them anyway, but registering them first keeps the order the scope asks for. Remove the stray double blank line at L226-227 while there.

**Code:**

Imports, replacing L1-25 (`streamSSE`, `readSessionContext` and the two view types added):
```ts
import { createHash } from 'node:crypto';
import { Hono, type MiddlewareHandler } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { normalizeNodeId } from '../sessions/ids.js';
import {
  contextFor,
  graphForRepo,
  knownNodes,
  listProjects,
  readSelected,
  readSessionContext,
  readTranscript,
  repoExists,
  requestSummaryFor,
  searchNodes,
  sessionDetail,
  sessionPrompts,
  sessionsReadDeps,
  usage,
  writeSelected,
  type SessionsReadOverrides,
} from '../sessions/readModel.js';
import { TRANSCRIPT_DEFAULT_LIMIT, TRANSCRIPT_MAX_LIMIT } from '../sessions/transcriptSearch.js';
import { createUnfinishedChecker, type UnfinishedChecker } from '../sessions/unfinished.js';
import type { GraphPayload, SelectedProject, SessionContext, SessionContextPayload } from '../sessions/view.js';
import { isLoopbackUrl, sameOriginOnly } from './sameOrigin.js';
```

After `export const MAX_KNOWN_IDS_CHARS = 1000;` (L37):
```ts
/** A burst of ingest writes (one per watcher read) becomes one re-read per stream. */
export const CONTEXT_STREAM_DEBOUNCE_MS = 250;
/** Same cadence as /api/events (SSE_HEARTBEAT_MS in api.ts), kept here so this module does not load api.ts. */
export const CONTEXT_STREAM_HEARTBEAT_MS = 25_000;
```

Options, replacing L39-42:
```ts
export interface SessionsApiOptions extends SessionsReadOverrides {
  /** The orch "unfinished" check (phase 13). Omitted: built from config.sessions.swarmScript. */
  unfinished?: UnfinishedChecker;
  /** Context stream debounce. Defaults to CONTEXT_STREAM_DEBOUNCE_MS. Tests pass a small value. */
  contextDebounceMs?: number;
  /** Context stream heartbeat. Defaults to CONTEXT_STREAM_HEARTBEAT_MS. Tests pass a small value. */
  sseHeartbeatMs?: number;
}
```

After `parseIdList` (after L110):
```ts
/** What makes a context event worth sending: tokens, model or window moved (percent and band follow). */
function contextKey(context: SessionContext | null): string {
  return context === null ? 'null' : `${context.tokens}|${context.model ?? ''}|${context.window}`;
}
```

Doc comment, replacing L112-128:
```ts
/**
 * The sessions read API (iteration 8, phase 7). The web polls GET /api/projects/:repo/sessions
 * (ETag + If-None-Match) for the graph: session rows change on every transcript append, and the
 * other laptop's ingest never reaches this daemon. The one session SSE is the per-node context
 * stream: this host's ingest emits on SessionEvents (src/sessions/events.ts) after a write that
 * can move a session's context, and each open stream re-reads that node's row (debounced) and
 * sends a `context` event when tokens, model or window changed. Another host's node gets its
 * first event and heartbeats only, so the web polls GET /api/sessions/:nodeId/context for those.
 *
 * GET  /api/projects                       repo list, counts, live counts, selected repo
 * GET  /api/projects/selected              { repo }
 * PUT  /api/projects/selected              { repo | null }   same-origin only
 * GET  /api/projects/:repo/sessions        graph payload
 * GET  /api/sessions/context?ids=          prompt-hook context   loopback only
 * GET  /api/sessions/known?ids=            which ids exist, with their repo (chat node links)
 * GET  /api/sessions/search?q=&repo=&limit=    hits carry via_notes and via_replies
 * GET  /api/sessions/usage?by=&repo=&month=&limit=
 * GET  /api/sessions/:nodeId/transcript?query=&limit=   owning host only
 * GET  /api/sessions/:nodeId/prompts      every stored prompt (full when backfilled), from the DB, any host
 * GET  /api/sessions/:nodeId/context      { node_id, host, available, context | null }, any host
 * GET  /api/sessions/:nodeId/context/stream   SSE: `context` on connect, then one per change; heartbeat
 * POST /api/sessions/:nodeId/summarize     records a summary request   same-origin only
 * GET  /api/sessions/:nodeId               detail; session.context is the same object as above
 */
```

At the top of `sessionsApiRoutes`, after `const r = new Hono();` (L134):
```ts
  const debounceMs = options.contextDebounceMs ?? CONTEXT_STREAM_DEBOUNCE_MS;
  const heartbeatMs = options.sseHeartbeatMs ?? CONTEXT_STREAM_HEARTBEAT_MS;
```

Routes, inserted after the `/prompts` route (after L225) and before the catch-all:
```ts
  r.get('/api/sessions/:nodeId/context', async (c) => {
    const nodeId = normalizeNodeId(c.req.param('nodeId'));
    if (nodeId === null) return c.json({ error: 'invalid_node_id' }, 400);
    const read = await readSessionContext(rd, nodeId);
    if (read === null) return c.json({ error: 'not_found', node_id: nodeId }, 404);
    return c.json(read.payload);
  });

  // One `context` event on connect, then one per change of tokens / model / window. Changes come
  // from this host's ingest through deps.sessionEvents; without a bus (sessions off, tests) the
  // stream sends its first event and heartbeats only.
  r.get('/api/sessions/:nodeId/context/stream', async (c) => {
    const nodeId = normalizeNodeId(c.req.param('nodeId'));
    if (nodeId === null) return c.json({ error: 'invalid_node_id' }, 400);
    const first = await readSessionContext(rd, nodeId);
    if (first === null) return c.json({ error: 'not_found', node_id: nodeId }, 404);
    const bus = deps.sessionEvents ?? null;
    return streamSSE(c, async (stream) => {
      let closed = false;
      let lastKey = contextKey(first.payload.context);
      let timer: ReturnType<typeof setTimeout> | null = null;
      let reading = false;
      let pending = false;
      const send = (payload: SessionContextPayload): Promise<void> =>
        stream.writeSSE({ event: 'context', data: JSON.stringify(payload) }).catch(() => undefined);
      const schedule = (): void => {
        if (closed || timer !== null) return;
        timer = setTimeout(() => void refresh(), debounceMs);
      };
      const refresh = async (): Promise<void> => {
        timer = null;
        if (closed) return;
        if (reading) {
          pending = true;
          return;
        }
        reading = true;
        try {
          const next = await readSessionContext(rd, nodeId);
          if (!closed && next !== null) {
            const key = contextKey(next.payload.context);
            if (key !== lastKey) {
              lastKey = key;
              await send(next.payload);
            }
          }
        } catch {
          // A failed read sends nothing; the next change re-reads.
        } finally {
          reading = false;
          if (pending) {
            pending = false;
            schedule();
          }
        }
      };
      const unsubscribe =
        bus === null
          ? (): void => undefined
          : bus.on((event) => {
              if (event.sessionId === first.sessionId) schedule();
            });
      await new Promise<void>((resolve) => {
        const beat = setInterval(() => {
          if (!closed) void stream.write(': heartbeat\n\n').catch(() => undefined);
        }, heartbeatMs);
        stream.onAbort(() => {
          closed = true;
          clearInterval(beat);
          if (timer !== null) clearTimeout(timer);
          unsubscribe();
          resolve();
        });
        void send(first.payload);
        // A write committed between the read above and the subscription is caught by this re-read.
        schedule();
      });
    });
  });
```
**Impact:** Two new public routes, read-only, no origin guard (same as the other GET session
routes). Each open stream holds one bus listener and two timers. All of them are released on abort.

### Step 5: Optional bus on AppDeps, created by the daemon
**Files:** `src/deps.ts:1-24`, `src/daemon.ts:20,87,103`
**Change:** Add the optional field. The daemon always sets it. Test harnesses that build `AppDeps` literals (`tests/integration/helpers/api-harness.ts:55`, many unit fakes) stay valid because it is optional.

`src/deps.ts`: add the import after L8 (`import type { NotesService } ...`):
```ts
import type { SessionEvents } from './sessions/events.js';
```
and the member after `adversary: AdversaryService | null;` (L23):
```ts
  /**
   * Session context changes: this host's ingest emits (src/background.ts), each open
   * GET /api/sessions/:nodeId/context/stream listens. The daemon always sets it; omitted (tests),
   * a context stream sends its first event and heartbeats only.
   */
  sessionEvents?: SessionEvents;
```

`src/daemon.ts`: add after L22 (`import { SUMMARIES_SUBDIR, ... } from './sessions/summarize.js';`):
```ts
import { SessionEvents } from './sessions/events.js';
```
replace L87 `const events = new NoteEvents();` with:
```ts
  const events = new NoteEvents();
  const sessionEvents = new SessionEvents();
```
replace L103 with:
```ts
  const deps: AppDeps = { config, db, events, service, embedder, imageEmbedder, chat: chatHistory, adversary, sessionEvents };
```
**Impact:** The daemon's routes see the bus. Nothing emits on it until Step 6.

### Step 6: Feed the bus from ingest
**File:** `src/background.ts:12,101-107`
**Change:** Import the observer and pass it beside the link worker. `IngestObserver.onBatch` runs synchronously after each committed write. A throw is logged and dropped (`ingest.ts:455-463`), and `emitContext` cannot throw. `keepRecords` (`ingest.ts:611`) is already true because `sessionLinks` has `onBatch`.

Add after L12 (`import { startSessionIngest, ... } from './sessions/ingest.js';`):
```ts
import { sessionContextObserver } from './sessions/events.js';
```
Replace L101-107 with:
```ts
    sessionIngest = startSessionIngest({
      claudeHome: deps.config.sessions.claudeHome,
      worktreesDir: deps.config.sessions.worktreesDir,
      store: sessionsRepo,
      hostname: () => sessionsHost,
      // The context observer feeds GET /api/sessions/:nodeId/context/stream (src/sessions/events.ts).
      observers: deps.sessionEvents === undefined ? [sessionLinks] : [sessionLinks, sessionContextObserver(deps.sessionEvents)],
    });
```
**Impact:** Every committed write that holds a main-chain assistant record with usage, and every
read from byte 0, emits one event. Phase 1's one-time context backfill does not notify observers
(the ingest header says backfills never do), so a stream opened during that backfill sees its
result on the next change or the next connect. That is acceptable because the backfill runs once,
at startup.

### Step 7: Unit tests
**File:** `tests/unit/sessions.view.test.ts`
**Change:** Add `toSessionContext` to the import list (L2-23). In `detail()` (L56-75), add the context keys before `...over`. Append a describe at the end of the file.

Import list: add `toSessionContext,` after `toSessionInfo,` (L19).

`detail()` keys, inserted after `plan_docs: [],` (L72):
```ts
    context_tokens: null,
    context_model: null,
    context_at: null,
    context_peak_tokens: null,
    context_long_beta: false,
```

Appended at the end of the file:
```ts
describe('toSessionContext', () => {
  const none = { context_tokens: null, context_model: null, context_at: null, context_peak_tokens: null, context_long_beta: false };

  it('is null while no context was captured: unknown, not 0%', () => {
    expect(toSessionContext(none)).toBeNull();
    expect(toSessionInfo(detail(), { host: 'lenovo', live: noLive }).context).toBeNull();
  });

  it('an unknown model with no 1M evidence gets the 200k default window', () => {
    expect(
      toSessionContext({ ...none, context_tokens: '50000', context_model: 'glm-5.3', context_at: '2026-11-12T02:00:00Z', context_peak_tokens: '50000' }),
    ).toEqual({
      tokens: 50_000,
      window: 200_000,
      percent: 25,
      band: contextBand(25),
      model: 'glm-5.3',
      at: '2026-11-12T02:00:00.000Z',
      window_source: 'default',
      peak_tokens: 50_000,
    });
  });

  it('a peak above 200k infers a 1M window, after compaction too', () => {
    const c = toSessionContext({ ...none, context_tokens: 150_000, context_model: 'glm-5.3', context_peak_tokens: 250_000 });
    expect(c).toMatchObject({ tokens: 150_000, window: 1_000_000, percent: 15, window_source: 'peak', peak_tokens: 250_000 });
  });

  it('rounds the percent to one decimal (contextPercent) and bands on that shown percent', () => {
    const c = toSessionContext({ ...none, context_tokens: 79_990, context_model: 'glm-5.3', context_peak_tokens: 79_990 });
    expect(c?.percent).toBe(40);
    expect(c?.band).toBe('amber');
  });

  it('a missing peak falls back to the tokens', () => {
    expect(toSessionContext({ ...none, context_tokens: 10, context_model: 'glm-5.3' })?.peak_tokens).toBe(10);
  });

  it('toSessionInfo carries it', () => {
    const s = toSessionInfo(detail({ context_tokens: 50_000, context_model: 'glm-5.3', context_peak_tokens: 50_000 }), { host: 'lenovo', live: noLive });
    expect(s.context).toMatchObject({ tokens: 50_000, window: 200_000, percent: 25 });
  });
});
```
and add at the top of the file, after the view import:
```ts
import { contextBand } from '../../src/sessions/contextWindow.js';
```

**File:** `tests/unit/sessions/sessionEvents.test.ts` (new)
```ts
import { describe, expect, it } from 'vitest';
import { batchMovesContext, sessionContextObserver, SessionEvents, type ContextBatchLike } from '../../../src/sessions/events.js';

const usage = { input_tokens: 1, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 1 };
const assistant = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'assistant',
  isSidechain: false,
  message: { id: 'msg_1', model: 'claude-opus-5-5', role: 'assistant', content: [], usage },
  ...extra,
});
const batch = (records: Record<string, unknown>[], fromOffset = 100): ContextBatchLike => ({ sessionId: 's-1', fromOffset, records });

describe('SessionEvents', () => {
  it('delivers context events to every listener until it unsubscribes', () => {
    const bus = new SessionEvents();
    const a: string[] = [];
    const b: string[] = [];
    const offA = bus.on((e) => a.push(e.sessionId));
    const offB = bus.on((e) => b.push(e.sessionId));
    bus.emitContext('s-1');
    offA();
    bus.emitContext('s-2');
    offB();
    bus.emitContext('s-3');
    expect(a).toEqual(['s-1']);
    expect(b).toEqual(['s-1', 's-2']);
    expect(bus.listenerCount()).toBe(0);
  });
});

describe('batchMovesContext', () => {
  it('a main-chain assistant record with usage moves the context', () => {
    expect(batchMovesContext(batch([{ type: 'user' }, assistant()]))).toBe(true);
    expect(batchMovesContext(batch([assistant({ isSidechain: undefined })]))).toBe(true);
  });

  it('sidechain, usage-less, user and bookkeeping records do not', () => {
    expect(batchMovesContext(batch([assistant({ isSidechain: true })]))).toBe(false);
    expect(batchMovesContext(batch([{ type: 'assistant', message: { id: 'm', content: [] } }]))).toBe(false);
    expect(batchMovesContext(batch([{ type: 'user', message: { role: 'user', content: 'hi' } }, { type: 'ai-title', aiTitle: 't' }]))).toBe(false);
    expect(batchMovesContext(batch([]))).toBe(false);
  });

  it('a read from byte 0 always may (first read, shrunk file, fork re-read)', () => {
    expect(batchMovesContext(batch([], 0))).toBe(true);
  });
});

describe('sessionContextObserver', () => {
  it('emits the batch session id only when the batch can move the context', () => {
    const bus = new SessionEvents();
    const seen: string[] = [];
    bus.on((e) => seen.push(e.sessionId));
    const observer = sessionContextObserver(bus);
    observer.onBatch(batch([assistant({ isSidechain: true })]));
    observer.onBatch({ sessionId: 's-9', fromOffset: 500, records: [assistant()] });
    expect(seen).toEqual(['s-9']);
  });
});
```

**File:** `tests/unit/sessions/contextRoute.test.ts` (new). Routes are driven over `app.request`
against a fake `db.execute`, the same seam `tests/unit/sessions/summarizeRoute.test.ts` uses, with
a real `SessionEvents`. Only the database is faked. Bus, route, debounce and change check are real.
```ts
import { describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../../../src/deps.js';
import { sessionsApiRoutes } from '../../../src/http/sessionsApi.js';
import { contextBand } from '../../../src/sessions/contextWindow.js';
import { SessionEvents } from '../../../src/sessions/events.js';
import type { SessionContextPayload } from '../../../src/sessions/view.js';
import { parseSse, readUntil, waitFor } from '../../integration/helpers/sse.js';

const HOST = 'this-host';

type Row = {
  session_id: string;
  node_id: string;
  host: string;
  context_tokens: number | null;
  context_model: string | null;
  context_at: string | null;
  context_peak_tokens: number | null;
  context_long_beta: boolean;
};

const baseRow: Row = {
  session_id: 'sess-b1',
  node_id: 'B1-22',
  host: HOST,
  context_tokens: 50_000,
  context_model: 'glm-5.3',
  context_at: '2026-11-12T02:00:00.000Z',
  context_peak_tokens: 50_000,
  context_long_beta: false,
};

function harness(row: Row | null, opts: { bus?: boolean; heartbeatMs?: number } = {}) {
  const state = { row };
  const execute = vi.fn(async () => ({ rows: state.row === null ? [] : [{ ...state.row }] }));
  const sessionEvents = opts.bus === false ? undefined : new SessionEvents();
  const deps = {
    config: { port: 7317, sessions: { claudeHome: '/nonexistent-claude-home', swarmScript: null } },
    db: { execute },
    embedder: null,
    ...(sessionEvents !== undefined ? { sessionEvents } : {}),
  } as unknown as AppDeps;
  const app = sessionsApiRoutes(deps, {
    host: HOST,
    live: async () => [],
    commitLinks: async () => new Map(),
    unfinished: { annotate: async (nodes) => nodes },
    contextDebounceMs: 10,
    sseHeartbeatMs: opts.heartbeatMs ?? 60_000,
  });
  return { app, execute, state, sessionEvents };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const contextEvents = (text: string): SessionContextPayload[] =>
  parseSse(text)
    .filter((m) => m.event === 'context')
    .map((m) => m.data as SessionContextPayload);

describe('GET /api/sessions/:nodeId/context', () => {
  it('answers the node context of any host, inferred from the stored evidence', async () => {
    const h = harness({ ...baseRow, host: 'gpd' });
    const res = await h.app.request('/api/sessions/b122/context');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      node_id: 'B1-22',
      host: 'gpd',
      available: false,
      context: {
        tokens: 50_000,
        window: 200_000,
        percent: 25,
        band: contextBand(25),
        model: 'glm-5.3',
        at: '2026-11-12T02:00:00.000Z',
        window_source: 'default',
        peak_tokens: 50_000,
      },
    });
  });

  it('context is null while nothing was captured', async () => {
    const h = harness({ ...baseRow, context_tokens: null, context_model: null, context_at: null, context_peak_tokens: null });
    expect(await (await h.app.request('/api/sessions/B1-22/context')).json()).toEqual({
      node_id: 'B1-22',
      host: HOST,
      available: true,
      context: null,
    });
  });

  it('400 invalid_node_id, 404 not_found', async () => {
    const h = harness(null);
    const bad = await h.app.request('/api/sessions/A-B32/context');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid_node_id' });
    const missing = await h.app.request('/api/sessions/ZZ-ZZ/context');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found', node_id: 'ZZ-ZZ' });
  });
});

describe('GET /api/sessions/:nodeId/context/stream', () => {
  it('sends the context on connect, then once per change of its own session, debounced, and unsubscribes on close', async () => {
    const h = harness({ ...baseRow });
    const bus = h.sessionEvents!;
    const res = await h.app.request('/api/sessions/B1-22/context/stream');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    let text = await readUntil(reader, (t) => contextEvents(t).length >= 1);
    expect(contextEvents(text)[0]).toMatchObject({ node_id: 'B1-22', available: true, context: { tokens: 50_000 } });
    expect(bus.listenerCount()).toBe(1);

    // Another session's write and an unchanged re-read send nothing.
    bus.emitContext('sess-other');
    bus.emitContext('sess-b1');
    await sleep(60);

    // A burst of writes that moved the context sends one event.
    h.state.row = { ...baseRow, context_tokens: 60_000, context_peak_tokens: 60_000, context_at: '2026-11-12T02:01:00.000Z' };
    for (let i = 0; i < 5; i += 1) bus.emitContext('sess-b1');
    text += await readUntil(reader, (t) => contextEvents(t).length >= 1);
    await sleep(60);
    const events = contextEvents(text);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ node_id: 'B1-22', context: { tokens: 60_000, percent: 30 } });

    await reader.cancel();
    await waitFor(() => bus.listenerCount() === 0);
  });

  it('a model change alone is an event; a context that disappears is sent as null', async () => {
    const h = harness({ ...baseRow });
    const bus = h.sessionEvents!;
    const reader = (await h.app.request('/api/sessions/B1-22/context/stream')).body!.getReader();
    await readUntil(reader, (t) => contextEvents(t).length >= 1);
    h.state.row = { ...baseRow, context_model: 'glm-5.4' };
    bus.emitContext('sess-b1');
    const second = contextEvents(await readUntil(reader, (t) => contextEvents(t).length >= 1));
    expect(second[0]?.context?.model).toBe('glm-5.4');
    h.state.row = { ...baseRow, context_tokens: null, context_peak_tokens: null };
    bus.emitContext('sess-b1');
    const third = contextEvents(await readUntil(reader, (t) => contextEvents(t).length >= 1));
    expect(third[0]?.context).toBeNull();
    await reader.cancel();
    await waitFor(() => bus.listenerCount() === 0);
  });

  it('without a bus it still sends the first event and heartbeats', async () => {
    const h = harness({ ...baseRow }, { bus: false, heartbeatMs: 20 });
    const reader = (await h.app.request('/api/sessions/B1-22/context/stream')).body!.getReader();
    const text = await readUntil(reader, (t) => contextEvents(t).length >= 1 && t.includes(': heartbeat'));
    expect(contextEvents(text)[0]?.context?.tokens).toBe(50_000);
    await reader.cancel();
  });

  it('400 / 404 answer JSON, not a stream', async () => {
    const h = harness(null);
    const bad = await h.app.request('/api/sessions/A-B32/context/stream');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid_node_id' });
    const missing = await h.app.request('/api/sessions/ZZ-ZZ/context/stream');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found', node_id: 'ZZ-ZZ' });
    expect(h.sessionEvents!.listenerCount()).toBe(0);
  });
});
```
**Impact:** None on production code. `tests/integration/helpers/sse.ts` is a pure helper (no DB), so a unit test can import it.

### Step 8: Integration tests
**File:** `tests/integration/sessions.api.int.test.ts`
**Change:** Add `contextBand` and `SessionContextPayload` imports and a describe after the `GET /api/sessions/:nodeId` describe (after L246). The rows are seeded by `seedGraph` in `beforeEach`. The context columns are set with SQL, the way the cost test sets `models` (L218-220).

Imports: add after L6:
```ts
import { contextBand } from '../../src/sessions/contextWindow.js';
```
and add `SessionContextPayload,` to the `type` import list from `view.js` (L8-17).

New describe (after L246):
```ts
describe('GET /api/sessions/:nodeId/context', () => {
  beforeEach(async () => {
    await h.deps.db.execute(sql`
      update cc_sessions
      set context_tokens = 300000, context_model = 'glm-5.3', context_at = '2026-11-01T02:00:00Z',
          context_peak_tokens = 300000, context_long_beta = false
      where session_id = 'sess-b1'`);
  });

  const b1Context = {
    tokens: 300_000,
    window: 1_000_000,
    percent: 30,
    band: contextBand(30),
    model: 'glm-5.3',
    at: '2026-11-01T02:00:00.000Z',
    window_source: 'peak',
    peak_tokens: 300_000,
  };

  it('answers the stored context with the inferred window, and detail carries the same object', async () => {
    const { status, body } = await get<SessionContextPayload>('/api/sessions/b122/context');
    expect(status).toBe(200);
    expect(body).toEqual({ node_id: 'B1-22', host: THIS_HOST, available: true, context: b1Context });
    const detail = (await get<SessionDetail>('/api/sessions/B1-22')).body;
    expect(detail.session.context).toEqual(b1Context);
  });

  it('another host\'s node answers too; no captured context is null, never 0%', async () => {
    const { status, body } = await get<SessionContextPayload>('/api/sessions/C2-33/context');
    expect(status).toBe(200);
    expect(body).toEqual({ node_id: 'C2-33', host: OTHER_HOST, available: false, context: null });
    expect((await get<SessionDetail>('/api/sessions/C2-33')).body.session.context).toBeNull();
  });

  it('400 invalid_node_id, 404 not_found', async () => {
    expect((await get<{ error: string }>('/api/sessions/A-B32/context')).body).toEqual({ error: 'invalid_node_id' });
    const missing = await get<{ error: string }>('/api/sessions/ZZ-ZZ/context');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'not_found', node_id: 'ZZ-ZZ' });
  });
});
```

**File:** `tests/integration/sessions.contextStream.int.test.ts` (new). This test runs real
ingest, a real bus, the real routes and the real phase 1 capture. The scope named the sessions.api
int test for this check. It goes in its own file because that suite seeds rows directly and runs
no ingester. It follows the ingester setup of `tests/integration/sessions.replies.int.test.ts:24-45`.
```ts
import { appendFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppDeps } from '../../src/deps.js';
import { sessionsApiRoutes } from '../../src/http/sessionsApi.js';
import { SessionEvents, sessionContextObserver } from '../../src/sessions/events.js';
import { startSessionIngest, type SessionIngester } from '../../src/sessions/ingest.js';
import { SessionsRepo } from '../../src/sessions/repo.js';
import { createRepoResolver } from '../../src/sessions/repoResolve.js';
import type { SessionContextPayload } from '../../src/sessions/view.js';
import { copyFixtureClaudeHome, FIXTURE } from '../helpers/claudeHome.js';
import { createApiHarness, type ApiHarness } from './helpers/api-harness.js';
import { parseSse, readUntil, waitFor } from './helpers/sse.js';
import { truncateAll } from './setup.js';

const HOST = 'test-host';

let h: ApiHarness;
let home: string;
let bus: SessionEvents;
let app: Hono;
const running: SessionIngester[] = [];

function start(): SessionIngester {
  const ingester = startSessionIngest({
    claudeHome: home,
    worktreesDir: FIXTURE.worktreesDir,
    homeDir: FIXTURE.homeDir,
    store: new SessionsRepo(h.deps.db),
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
    observers: [sessionContextObserver(bus)],
  });
  running.push(ingester);
  return ingester;
}

const contextEvents = (text: string): SessionContextPayload[] =>
  parseSse(text)
    .filter((m) => m.event === 'context')
    .map((m) => m.data as SessionContextPayload);

/** A main-chain assistant message of the main fixture session whose usage sums to 300,015 tokens. */
const assistantLine = `${JSON.stringify({
  parentUuid: 'u-9',
  isSidechain: false,
  type: 'assistant',
  uuid: 'ctx-int-1',
  timestamp: '2026-11-02T02:30:00.000Z',
  sessionId: FIXTURE.main,
  cwd: '/home/u/mcp-notes',
  message: {
    id: 'msg_ctx_int_1',
    model: 'claude-opus-5-5',
    role: 'assistant',
    type: 'message',
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 10, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 0, output_tokens: 5 },
  },
})}\n`;

beforeAll(async () => {
  h = await createApiHarness();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await truncateAll(h.deps.db);
  home = await copyFixtureClaudeHome();
  bus = new SessionEvents();
  const deps: AppDeps = { ...h.deps, sessionEvents: bus };
  app = new Hono();
  app.route('/', sessionsApiRoutes(deps, { host: HOST, live: async () => [], commitLinks: async () => new Map(), contextDebounceMs: 20 }));
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((i) => i.close()));
  await rm(home, { recursive: true, force: true });
});

describe('GET /api/sessions/:nodeId/context/stream with real ingest', () => {
  it('sends the stored context on connect, then a new event once ingest commits a main-chain assistant append', async () => {
    const ingester = start();
    await ingester.ready;
    const res0 = await h.deps.db.execute<{ node_id: string }>(sql`select node_id from cc_sessions where session_id = ${FIXTURE.main}`);
    const nodeId = res0.rows[0]?.node_id;
    expect(nodeId).toBeDefined();

    const res = await app.request(`/api/sessions/${nodeId}/context/stream`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = contextEvents(await readUntil(reader, (t) => contextEvents(t).length >= 1));
    expect(first[0]).toMatchObject({ node_id: nodeId, host: HOST, available: true });
    expect(first[0]?.context).not.toBeNull();
    expect(first[0]?.context?.tokens).not.toBe(300_015);
    await waitFor(() => bus.listenerCount() === 1);

    await appendFile(path.join(home, FIXTURE.mainFile), assistantLine);
    await ingester.sweep();
    const next = contextEvents(await readUntil(reader, (t) => contextEvents(t).length >= 1, 5000));
    expect(next[0]).toMatchObject({ node_id: nodeId, context: { tokens: 300_015, model: 'claude-opus-5-5' } });

    await reader.cancel();
    await waitFor(() => bus.listenerCount() === 0);
  });
});
```
**Impact:** None on production code. If phase 1 names the fixture-driven context differently
(for example if the fixture main session's last assistant usage happens to be 300,015), the
`not.toBe(300_015)` guard shows it at once.

## Principles applied

- Laziness protocol: no new route module, no new bus abstraction. The bus copies `NoteEvents`, the stream copies the `/api/events` loop (`api.ts:295-332`), the routes live in `sessionsApi.ts` beside their siblings, and `AppDeps.sessionEvents` is optional so no existing harness or fake changes.
- Make illegal states unrepresentable: `SessionInfo.context` is one nullable object, not five nullable scalars. A window or band without tokens cannot exist. Unknown is `null`, never `{tokens: 0}` (the R1.7 premise, served here by the type).
- Boundary discipline: node ids are normalized once in each handler (`normalizeNodeId`), and the raw row is shaped once in `toSessionContext`. The stream compares the typed `SessionContext` (`contextKey`) and does not re-parse anything.
- Test behavior, not implementation: route tests drive `app.request` and read SSE bytes. They fake only `db.execute` and use the real bus, debounce and change check. "Unchanged sends nothing" is asserted by counting events on the wire, not by spying on `execute`. The integration test proves R3.2 end to end through real ingest.
- Prove it works: the Proof drives a throwaway daemon. It ingests the fixture, reads the JSON route, then appends to the transcript the daemon watches and captures the stream's bytes.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` (adds `tests/unit/sessions/sessionEvents.test.ts`, `tests/unit/sessions/contextRoute.test.ts`, extends `tests/unit/sessions.view.test.ts`), then `npm run test:int` (extends `tests/integration/sessions.api.int.test.ts`, adds `tests/integration/sessions.contextStream.int.test.ts`). One file: `npx vitest run tests/unit/sessions/contextRoute.test.ts`.
**Proof:** a throwaway daemon built from this worktree ingests the fixture Claude home. Its JSON route and session detail return the same context object, and an assistant record appended to the watched transcript produces a second `context` event on an open stream.
- Harness: `.claude/skills/verify-notesd` (`V=.claude/skills/verify-notesd/scripts/verify.sh`, run from `/home/miftah/.worktrees/mcp-notes/session-context-rot`). Setup for every journey: `$V up --sessions` and note `RUN` and `URL`. Wait for ingest with `for i in $(seq 60); do $V sql $RUN "select node_id, context_tokens from cc_sessions where session_id = '5e55a001-0000-4000-8000-000000000001'" | grep -Eq '[0-9]{2,}' && break; sleep 1; done`, then run `$V sql $RUN "select node_id, context_tokens from cc_sessions where session_id = '5e55a001-0000-4000-8000-000000000001'"` and call the printed node id `NODE`. A null `context_tokens` here means phase 1's capture is missing: stop and report `inconclusive`.
- Feature-map entries: none edited in this phase (phase 4 owns `.claude/skills/verify-notesd/features/projects.md`, see Handoffs). The existing entry `features/projects.md` (session detail) is the neighbor.
- Journeys:
  - **J1** · traces R3.3 — `$V api $RUN GET /api/sessions/$NODE/context`, then `$V api $RUN GET /api/sessions/$NODE`, then `$V api $RUN GET /api/sessions/A-B32/context` and `$V api $RUN GET /api/sessions/ZZ-ZZ/context` → passes when the first answers 200 with `node_id` = `NODE`, `available: true`, and a `context` object holding exactly the keys `tokens, window, percent, band, model, at, window_source, peak_tokens`, with `tokens` equal to the `context_tokens` the `sql` step printed and `percent` equal to `round(tokens / window * 1000) / 10`; when the detail's `.session.context` is deep-equal to that object; and when the last two answer 400 `{"error":"invalid_node_id"}` and 404 `{"error":"not_found","node_id":"ZZ-ZZ"}`.
  - **J2** · traces R3.3 — `$V exec $RUN "insert into cc_sessions (session_id, node_id, host, repo, entrypoint) values ('ctx-null-1', 'Q9-99', 'other-box', 'mcp-notes', 'cli')"`, then `$V api $RUN GET /api/sessions/Q9-99/context` and `$V api $RUN GET /api/sessions/Q9-99` → passes when the route answers 200 `{"node_id":"Q9-99","host":"other-box","available":false,"context":null}` (another host's node is answered, an uncaptured context is `null`, not 0) and the detail's `.session.context` is `null`.
  - **J3** · traces R3.2 — save this script as `<scratchpad>/j2-stream.sh` and run `bash <scratchpad>/j2-stream.sh $RUN $URL $NODE`:
    ```bash
    #!/usr/bin/env bash
    set -euo pipefail
    RUN="$1"; URL="$2"; NODE="$3"
    DIR="$HOME/.local/state/notesd-verify/$RUN"
    F="$DIR/claude/projects/-home-u-mcp-notes/5e55a001-0000-4000-8000-000000000001.jsonl"
    OUT="$DIR/evidence/j3-context-stream.txt"
    : > "$OUT"
    timeout 25 curl -sN "$URL/api/sessions/$NODE/context/stream" >> "$OUT" &
    CURL=$!
    for _ in $(seq 50); do grep -q '^event: context' "$OUT" && break; sleep 0.1; done
    grep -q '^event: context' "$OUT" || { echo "FAIL: no initial context event"; kill $CURL; exit 1; }
    START=$(date +%s.%N)
    printf '%s\n' '{"parentUuid":"u-9","isSidechain":false,"type":"assistant","uuid":"ctx-j3","timestamp":"2026-11-02T02:30:00.000Z","sessionId":"5e55a001-0000-4000-8000-000000000001","cwd":"/home/u/mcp-notes","message":{"id":"msg_ctx_j3","model":"claude-opus-5-5","role":"assistant","type":"message","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":10,"cache_read_input_tokens":300000,"cache_creation_input_tokens":0,"output_tokens":5}}}' >> "$F"
    for _ in $(seq 200); do [ "$(grep -c '^event: context' "$OUT")" -ge 2 ] && break; sleep 0.1; done
    END=$(date +%s.%N)
    kill $CURL 2>/dev/null || true
    echo "context events: $(grep -c '^event: context' "$OUT")"
    echo "seconds from append to event: $(awk -v a="$START" -v b="$END" 'BEGIN { printf "%.1f", b - a }')"
    grep '^data:' "$OUT" | tail -1
    ```
    → passes when it prints `context events: 2` (or more), and the last `data:` line has `"node_id":"<NODE>"`, `"tokens":300015` and `"model":"claude-opus-5-5"`. The first event must carry the pre-append tokens (not 300015). The whole stream is kept in `evidence/j3-context-stream.txt`. Then `$V note $RUN "J3: context stream got a second event <N>s after the append"`.
- Neighbor check: session detail and the routes around the new ones still answer as before. `$V api $RUN GET /api/sessions/$NODE` keeps `node_id`, `tokens.total`, `summary_state`, `prompts` and `commits` as the current `features/projects.md` describes, and `$V api $RUN GET /api/sessions/$NODE/prompts` still answers 200 with `prompts`. `$V api $RUN GET /api/projects/mcp-notes/sessions` answers 200 and its nodes carry no `context` key (graph nodes are unchanged).
- Cost: none (no LLM turns, no `--embed`). Finish with `$V down $RUN`.
**Exit criteria:** `npm run typecheck`, `npm test` and `npm run test:int` are green; J1-J3 pass on a throwaway daemon; the detail and JSON route return the same context object; an open stream sees a second `context` event after an appended main-chain assistant record.

## Handoffs

- **Phase 4 (R3.1, R3.4, web):** web types for `SessionContext` / `SessionContextPayload` (copy the shapes from `src/sessions/view.ts` Step 2) on `SessionDetail.session.context`, the `EventSource` client of `/api/sessions/:nodeId/context/stream` (event name `context`, data = `SessionContextPayload`, first event on connect), the 60 s poll of `/api/sessions/:nodeId/context` for `available: false` nodes. The stream does not close by itself for another host's node: it sends its first event and heartbeats, so the client must not open it for those (R3.4).
- **Phase 4 (docs):** README HTTP API rows for `GET /api/sessions/:nodeId/context` and `GET /api/sessions/:nodeId/context/stream`, and the `features/projects.md` sub-feature and proof steps. This phase adds user-visible API surface, but the scope gives the feature map and README to phase 4, so this phase does not edit them. J1-J3 above are ready to copy into the map.
- **Phase 3 (optional, owner's call):** `session_get` in `src/mcp/sessionTools.ts` now returns `session.context` without any edit. If phase 3 touches that tool's description anyway, it may mention the field. Not required for any criterion.
- **Phase 1 (settled by the reconciler):** `contextWindowFor(input: ContextWindowInput)` takes `{ model: string | null; peakTokens: number | null; longBeta: boolean }`, so the call in `toSessionContext` (Step 2) passes the row's values as they are; `percent` is phase 1's `contextPercent` and `band` is `contextBand(percent)`.

## Risks

- **Backfill writes are silent.** Phase 1's one-time context backfill (`fillContext`) notifies no observer, so a stream open during that startup backfill does not get an event for it; the next ingest write or reconnect shows the filled value. Accepted (the backfill runs once per host, at startup).
- **Reads from byte 0 always emit.** `batchMovesContext` returns true for every `fromOffset === 0` batch (first read, shrunk file, fork read whose copied context arrives through records ingest drops before observers). This matches phase 1's ingest: such a read replaces the six context columns (`mergeContext` with `reset`), and `IngestBatch` (`ingest.ts:151-160`) carries `fromOffset`, so `ContextBatchLike` is a structural subset of it. The stream's change check (`contextKey`) drops a no-op event.
- **A beta-only write emits nothing.** `IngestBatch.records` never holds `api-request` lines (phase 1 handoff), so a batch whose only effect is `context_long_beta` turning true does not emit. In practice the request's assistant reply lands in the same or the next batch and that one emits, and the re-read then sees the new window. Accepted.

## Rollback

`git revert` this phase's commit(s). That removes `src/sessions/events.ts`, the two routes, `SessionInfo.context` and the optional `AppDeps.sessionEvents`, and no data migration is involved: this phase writes nothing. Phase 4 depends on this phase's routes and field, so revert phase 4 first if it has landed.
