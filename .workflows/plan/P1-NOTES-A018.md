> Adopted from `/home/miftah/.worktrees/mcp-notes/semantic-search/.workflows/orchestration/semantic-search/PLAN.md` phase 2. Source: `.workflows/plan/semantic-search/phase-2.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 2: OpenRouter embedder, config, deps wiring, fake embedder

**Plan set:** `SEMANTIC_SEARCH_PLAN.md`
**Analysis:** `docs/analyzer/20261030-140513-S6EM_code_analyzer.md`
**Satisfies:** R1 (the client): embeddings via OpenRouter `/embeddings`, `openai/text-embedding-3-small`, 1536 wide, with run-insights' input cap and error handling. Plus this phase's own R6 tests (fake fetch, config, fake embedder). R6 is listed against every phase in the index.
**Depends on:** Phase 1 (`src/embeddings/constants.ts`, `src/embeddings/state.ts`). Reconciled: the plan set's DAG is 1 → 2 → {3, 4}.
**Difficulty:** NORMAL
**Package:** `src/embeddings`, `src/config.ts`, `src/daemon.ts`

---

## Goal

After this phase the daemon holds an `Embedder | null`. It builds the embedder from `OPENROUTER_API_KEY`, or takes one injected by a test, and hands it to `AppDeps` and to `NotesService`. Nothing calls the embedder yet, so no behavior changes. The OpenRouter client follows run-insights' module and handles batches. Every one of its failure paths is unit-tested against a fake `fetch`. Phases 3 and 4 get a deterministic offline "concept bag" fake embedder in `tests/helpers/fakeEmbedder.ts`.

## Build order

`src/embeddings/openrouter.ts` and `tests/helpers/fakeEmbedder.ts` import `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `EMBEDDING_MAX_CHARS` and `OPENROUTER_EMBEDDINGS_URL` from `src/embeddings/constants.ts`, and `openrouter.ts` imports `embedInput` from `src/embeddings/state.ts`. Both files belong to Phase 1, so this phase starts from a branch where Phase 1 has landed (reconciler decision: Phase 2 depends on Phase 1; no duplicate constants file).

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `src/embeddings/embedder.ts`: `interface Embedder { readonly model; readonly dimensions; embed(inputs, opts?) }`, `interface EmbedOptions { timeoutMs?: number }`, `class EmbeddingError extends Error { readonly detail?: unknown }`, `function embeddingErrorText(cause: unknown): string`
- `src/embeddings/openrouter.ts`: `createOpenRouterEmbedder(opts: OpenRouterEmbedderOptions): Embedder`, `interface OpenRouterEmbedderOptions { apiKey; fetch?; timeoutMs?; maxBatch? }`, `embedderFromConfig(config: EmbeddingsConfig, opts?: { fetch? }): Embedder | null`, `OPENROUTER_EMBED_TIMEOUT_MS = 15_000`, `OPENROUTER_EMBED_MAX_BATCH = 64`, `RESPONSE_SNIPPET_CHARS = 300`
- `src/config.ts`: `interface EmbeddingsConfig { apiKey: string | null }`, `DEFAULT_EMBEDDINGS_CONFIG`, `Config.embeddings`
- `src/deps.ts`: `AppDeps.embedder: Embedder | null` (required field)
- `src/daemon.ts`: `StartDaemonOptions.embedder?: Embedder | null`
- `src/notes/service.ts`: `NotesServiceDeps.embedder?: Embedder | null`, and a private field `NotesService.embedder: Embedder | null` (phase 4 reads it as `this.embedder`)
- `tests/helpers/fakeEmbedder.ts`: `createFakeEmbedder(opts?)`, `class FakeEmbedder implements Embedder` (`calls`, `delayMs`, `failNext(n?, error?)`, `failWhen(pred | null, error?)`, `reset()`, `vectorFor(text)`), `type Lexicon`, `interface FakeEmbedderOptions`, `DEFAULT_LEXICON`, `DEFAULT_STOPWORDS`, `DEFAULT_TAIL_WEIGHT`, `tokenize(text, stopwords?)`, `cosine(a, b)`
- Unit tests: `tests/unit/embeddings/openrouter.test.ts`, `tests/unit/embeddings/fakeEmbedder.test.ts`

**Signature changes:**
- `Config` gains the required field `embeddings: EmbeddingsConfig`. Every `Config` literal must add `embeddings: DEFAULT_EMBEDDINGS_CONFIG`.
- `AppDeps` gains the required field `embedder: Embedder | null`. Every `AppDeps` literal must add `embedder: null`.
- `NotesServiceDeps.embedder` is optional, so the existing `new NotesService({...})` calls compile unchanged.

**Requires (from earlier phases):** Phase 1's `src/embeddings/constants.ts` exporting `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `EMBEDDING_MAX_CHARS`, `OPENROUTER_EMBEDDINGS_URL`, and `src/embeddings/state.ts` exporting `embedInput(body): string | null` (trim, surrogate-safe clamp to `EMBEDDING_MAX_CHARS`, null when blank).

**Contract details later phases rely on:**
- `embed(inputs)` returns one vector per input in input order. It passes each input through Phase 1's `embedInput` (trim, surrogate-safe clamp to `EMBEDDING_MAX_CHARS`), and throws `EmbeddingError` **before any network call** when `inputs` is empty or any input is empty after trim. Inputs larger than `maxBatch` (default 64) go out as sequential requests. If any chunk fails, the whole call rejects and no partial result is returned.
- Every failure is an `EmbeddingError`. `message` never contains the API key. `embeddingErrorText(err)` gives a one-line text suitable for `note_embeddings.last_error`. Phase 1/3 cap it at 500 characters.
- `FakeEmbedder.model === EMBEDDING_MODEL` and `.dimensions === EMBEDDING_DIMENSIONS` by default, so rows it writes count as "current" under Phase 1's predicate.
- `FakeEmbedder.calls` records only calls that would reach the network (validation failures are not recorded). Calls that fail through `failNext`/`failWhen` are recorded.

**Leaves alone (owned by others):** `src/embeddings/constants.ts`, `state.ts`, `repo.ts`, `src/db/schema.ts`, `drizzle/**`, `scripts/test-int.sh`, `tests/integration/setup.ts` (Phase 1); `src/embeddings/worker.ts`, `backfill.ts`, `src/background.ts`, `src/cli/**`, `package.json` (Phase 3); `src/search/**`, `NotesService.search`, `src/notes/repo.ts`, `src/notes/types.ts`, `src/mcp/**` (Phase 4/5); `src/chat/**`; `web/**`; `vitest.config.ts`, `tests/live/embeddings.live.test.ts` (Phase 6).

## Files

| File | Action | What changes |
|---|---|---|
| `src/embeddings/embedder.ts` | create | `Embedder`, `EmbedOptions`, `EmbeddingError`, `embeddingErrorText` |
| `src/embeddings/openrouter.ts` | create | OpenRouter client, batching and index ordering, validation, `embedderFromConfig` |
| `src/config.ts:47-67, 193-222` | modify | `EmbeddingsConfig`, `DEFAULT_EMBEDDINGS_CONFIG`, `Config.embeddings`, `parseEmbeddings`, doc comment |
| `src/deps.ts:1-12` | modify | `AppDeps.embedder` |
| `src/daemon.ts:1-13, 27-30, 56-107` | modify | build or inject the embedder; pass it to `NotesService` and `AppDeps` |
| `src/notes/service.ts:1, 22-26, 69-78` | modify | `NotesServiceDeps.embedder?`, store it in the constructor |
| `tests/helpers/fakeEmbedder.ts` | create | deterministic concept-bag fake |
| `tests/unit/embeddings/openrouter.test.ts` | create | every failure path against a fake `fetch`; order; batching; no key leak |
| `tests/unit/embeddings/fakeEmbedder.test.ts` | create | determinism, synonym closeness, failure controls |
| `tests/unit/config.test.ts:6, 28-46, 173` | modify | defaults include `embeddings`; `OPENROUTER_API_KEY` parsed; new describe block |
| `tests/integration/daemon.int.test.ts:5-18, after 112` | modify | Config literal; injected-embedder test |
| `tests/integration/images.int.test.ts:8, 120-125` | modify | Config + AppDeps literal |
| `tests/integration/helpers/api-harness.ts:9, 44-49` | modify | Config + AppDeps literal |
| `tests/integration/imageHarness.ts:7, 34-39` | modify | Config + AppDeps literal |
| `tests/integration/connectors/mcp.int.test.ts:8, 17, 20` | modify | Config + AppDeps literal |
| `tests/integration/mcp.tools.int.test.ts:9, 20, 23` | modify | Config + AppDeps literal |
| `tests/live/chat.live.test.ts:54` | modify | pass `embedder: null` so the chat live test never reaches OpenRouter once Phase 3's worker exists |

## Implementation Steps

### Step 1: Embedder interface and error
**File:** `src/embeddings/embedder.ts` (new)
**Change:** The provider-neutral seam. Phases 3–6 import only from here, plus `openrouter.ts` for construction.
**Code:**
```ts
/**
 * The one seam between mcp-notes and an embedding provider. Production uses
 * `createOpenRouterEmbedder` (./openrouter.ts); tests use `tests/helpers/fakeEmbedder.ts`.
 * A null `Embedder` everywhere means "semantic features off" (no OPENROUTER_API_KEY): writes are
 * unaffected, search reports its text fallback, the worker idles.
 */

export interface EmbedOptions {
  /** Per-request ceiling in ms, overriding the embedder's default (15 s for OpenRouter). */
  timeoutMs?: number;
}

export interface Embedder {
  /** Model id the vectors come from; stored in note_embeddings.model. */
  readonly model: string;
  /** Width of every returned vector; equals the vector(n) column. */
  readonly dimensions: number;
  /**
   * One vector per input, in input order. Each input is trimmed and clamped to
   * EMBEDDING_MAX_CHARS (phase 1's embedInput). Throws EmbeddingError, and makes no request at all, when `inputs` is
   * empty or any input is empty after trim (callers filter with phase 1's `embedInput`).
   */
  embed(inputs: readonly string[], opts?: EmbedOptions): Promise<number[][]>;
}

/**
 * Every embedding failure: missing key, empty input, transport error, timeout, non-2xx,
 * non-JSON, missing/miscounted/misindexed vectors, wrong width, non-finite element. One class,
 * as in run-insights: no caller branches on which; the worker records and retries, search falls
 * back to text. The response snippet or the thrown cause rides in `message` / `detail`.
 * Never carries the API key.
 */
export class EmbeddingError extends Error {
  override name = 'EmbeddingError';

  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

function detailText(detail: unknown): string {
  if (detail instanceof Error) {
    const inner = detail.cause instanceof Error ? ` (${detail.cause.message})` : '';
    return `${detail.name}: ${detail.message}${inner}`;
  }
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

/**
 * One line for a log or note_embeddings.last_error. `String(err)` alone drops `detail`, which is
 * where the transport cause lives (e.g. "fetch failed (connect ECONNREFUSED ...)").
 */
export function embeddingErrorText(cause: unknown): string {
  if (cause instanceof EmbeddingError) {
    return cause.detail === undefined
      ? `${cause.name}: ${cause.message}`
      : `${cause.name}: ${cause.message} - detail: ${detailText(cause.detail)}`;
  }
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return String(cause);
}
```
**Impact:** new file; nothing imports it yet except the files below.

### Step 2: OpenRouter client
**File:** `src/embeddings/openrouter.ts` (new)
**Change:** Follows `~/run-insights/lib/nina/embedding.ts` (read, not imported): one `fetch` POST, `Authorization: Bearer`, `encoding_format: 'float'`, `AbortSignal.timeout(15_000)`, the body read as text and then JSON-parsed, ≤300-char response snippets in messages, and a width + finite check against the column constant. There are three differences, each deliberate:
1. `input` is an array (batch), and results are placed by `data[i].index`, not by position.
2. A non-2xx status is checked **before** the JSON parse, so a 502 HTML page reports "returned 502: <snippet>" and not "not valid JSON". run-insights does it the other way round, which hides the status.
3. Nothing is logged. run-insights writes an error-log row, but here the caller (Phase 3 worker or Phase 4 search) decides what to record. The key never appears in any message.

**Code:**
```ts
import type { EmbeddingsConfig } from '../config.js';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, OPENROUTER_EMBEDDINGS_URL } from './constants.js';
import { EmbeddingError, type EmbedOptions, type Embedder } from './embedder.js';
import { embedInput } from './state.js';

/**
 * Per request. An embedding is one forward pass with no decode; run-insights measured it well
 * under a second and settled on 15 s as a ceiling with room. Search passes a shorter one per call.
 */
export const OPENROUTER_EMBED_TIMEOUT_MS = 15_000;

/**
 * Inputs per request. 64 notes at the 8 000-char clamp is ~128k tokens, inside the provider's
 * per-request limit; larger `embed()` calls are split into sequential requests.
 */
export const OPENROUTER_EMBED_MAX_BATCH = 64;

/** How much of a bad response body an error message carries (run-insights' 300). */
export const RESPONSE_SNIPPET_CHARS = 300;

export interface OpenRouterEmbedderOptions {
  /** OPENROUTER_API_KEY. Never logged, never put in an error. Blank throws EmbeddingError. */
  apiKey: string;
  /** Injected by unit tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Default per-request timeout; `embed(.., { timeoutMs })` overrides it per call. */
  timeoutMs?: number;
  /** Inputs per request; default OPENROUTER_EMBED_MAX_BATCH. Integer >= 1. */
  maxBatch?: number;
}

function snippet(raw: string): string {
  return raw.slice(0, RESPONSE_SNIPPET_CHARS);
}

/**
 * Trim + clamp each input with phase 1's embedInput (truncate at EMBEDDING_MAX_CHARS, no marker:
 * the marker would be embedded too; never ends on half a surrogate pair). Input the worker already
 * passed through embedInput comes out unchanged.
 */
function prepareInputs(inputs: readonly string[]): string[] {
  if (inputs.length === 0) throw new EmbeddingError('embedding needs at least one input');
  return inputs.map((text, i) => {
    const input = embedInput(text);
    if (input === null) throw new EmbeddingError(`embedding input ${i} is empty`);
    return input;
  });
}

function errorName(cause: unknown): unknown {
  return typeof cause === 'object' && cause !== null ? (cause as { name?: unknown }).name : undefined;
}

/**
 * `data` must hold exactly one vector per input. Each item's `index` (or its position when the
 * provider omits it) places it; a repeated or out-of-range index is an error, never a silent
 * reorder. Width and finiteness are checked here, against the same constant as the column, so a
 * model swap fails with both numbers named instead of as an opaque pgvector INSERT error.
 */
function parseVectors(json: unknown, expected: number, raw: string): number[][] {
  const data =
    typeof json === 'object' && json !== null ? (json as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) {
    throw new EmbeddingError(`embedding response carried no data array: ${snippet(raw)}`);
  }
  if (data.length !== expected) {
    throw new EmbeddingError(
      `embedding response has ${data.length} vector(s) for ${expected} input(s): ${snippet(raw)}`,
    );
  }
  const out: Array<number[] | undefined> = new Array<number[] | undefined>(expected).fill(undefined);
  data.forEach((item: unknown, position: number) => {
    const entry =
      typeof item === 'object' && item !== null
        ? (item as { index?: unknown; embedding?: unknown })
        : {};
    const index = entry.index === undefined ? position : entry.index;
    if (
      typeof index !== 'number' ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= expected ||
      out[index] !== undefined
    ) {
      throw new EmbeddingError(
        `embedding response has a bad or repeated index ${String(index)} at data[${position}]: ${snippet(raw)}`,
      );
    }
    const embedding = entry.embedding;
    if (!Array.isArray(embedding)) {
      throw new EmbeddingError(
        `embedding response carried no vector at data[${position}].embedding: ${snippet(raw)}`,
      );
    }
    if (
      embedding.length !== EMBEDDING_DIMENSIONS ||
      !embedding.every((n: unknown) => typeof n === 'number' && Number.isFinite(n))
    ) {
      throw new EmbeddingError(
        `embedding returned ${embedding.length} value(s) (or a non-finite one) for model ${EMBEDDING_MODEL}; ` +
          `note_embeddings.embedding is vector(${EMBEDDING_DIMENSIONS}). The model id and ` +
          'EMBEDDING_DIMENSIONS must change together, in one migration, with a full re-embed.',
      );
    }
    out[index] = embedding as number[];
  });
  return out as number[][];
}

/**
 * OpenRouter's OpenAI-shaped /embeddings endpoint, one `fetch` per batch, no SDK.
 * Construction never touches the network; a blank key throws here so a misconfigured daemon
 * fails loudly at startup instead of on the first note.
 */
export function createOpenRouterEmbedder(opts: OpenRouterEmbedderOptions): Embedder {
  const apiKey = opts.apiKey.trim();
  if (apiKey === '') {
    throw new EmbeddingError('embeddings are not configured (OPENROUTER_API_KEY is empty)');
  }
  const fetchImpl: typeof fetch = opts.fetch ?? fetch;
  const defaultTimeoutMs = opts.timeoutMs ?? OPENROUTER_EMBED_TIMEOUT_MS;
  const maxBatch = opts.maxBatch ?? OPENROUTER_EMBED_MAX_BATCH;
  if (!Number.isInteger(maxBatch) || maxBatch < 1) {
    throw new RangeError(`maxBatch must be an integer >= 1, got ${maxBatch}`);
  }

  async function request(batch: string[], timeoutMs: number): Promise<number[][]> {
    let res: Response;
    try {
      res = await fetchImpl(OPENROUTER_EMBEDDINGS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        // encoding_format explicit: some providers behind the broker default to base64, which
        // would arrive as a string and fail the array check with a confusing message.
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: batch, encoding_format: 'float' }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      const name = errorName(cause);
      const timedOut = name === 'TimeoutError' || name === 'AbortError';
      throw new EmbeddingError(
        timedOut ? `embedding request timed out after ${timeoutMs} ms` : 'embedding request failed',
        cause,
      );
    }

    // Text first, then parse: a broker's error body is often HTML or a bare string, and the raw
    // snippet is the most useful thing an error can carry.
    let raw: string;
    try {
      raw = await res.text();
    } catch (cause) {
      const timedOut = errorName(cause) === 'TimeoutError' || errorName(cause) === 'AbortError';
      throw new EmbeddingError(
        timedOut
          ? `embedding response timed out after ${timeoutMs} ms`
          : 'embedding response body could not be read',
        cause,
      );
    }

    if (!res.ok) {
      throw new EmbeddingError(`embedding endpoint returned ${res.status}: ${snippet(raw)}`, {
        status: res.status,
      });
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (cause) {
      throw new EmbeddingError(`embedding response was not valid JSON: ${snippet(raw)}`, cause);
    }
    return parseVectors(json, batch.length, raw);
  }

  return {
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    async embed(inputs: readonly string[], callOpts: EmbedOptions = {}): Promise<number[][]> {
      const prepared = prepareInputs(inputs);
      const timeoutMs = callOpts.timeoutMs ?? defaultTimeoutMs;
      const out: number[][] = [];
      for (let start = 0; start < prepared.length; start += maxBatch) {
        const vectors = await request(prepared.slice(start, start + maxBatch), timeoutMs);
        out.push(...vectors);
      }
      return out;
    },
  };
}

/**
 * The daemon's and the CLI's (phase 3) way to get an embedder: null without a key, which turns
 * semantic features off without affecting writes.
 */
export function embedderFromConfig(
  config: EmbeddingsConfig,
  opts: { fetch?: typeof fetch } = {},
): Embedder | null {
  if (config.apiKey === null) return null;
  return createOpenRouterEmbedder({ apiKey: config.apiKey, fetch: opts.fetch });
}
```
**Impact:** new file. It imports `./constants.js` and `./state.js` (Phase 1) and a type from `../config.js` (Step 3).

### Step 3: Config, `Config.embeddings` from `OPENROUTER_API_KEY`
**File:** `src/config.ts`
**Change:** This file has no semicolons, and the new code follows that style.

(a) Insert after `DEFAULT_CHAT_CONFIG` (after line 54, before `export interface Config` at line 56):
```ts
/** OpenRouter embeddings: semantic search, `related`, and the embedding worker. */
export interface EmbeddingsConfig {
  /** `OPENROUTER_API_KEY`, trimmed; null when unset or blank (semantic features off). Never logged. */
  apiKey: string | null
}

/** What `loadConfig` returns for `embeddings` without OPENROUTER_API_KEY. Tests build `Config` literals with it. */
export const DEFAULT_EMBEDDINGS_CONFIG: EmbeddingsConfig = { apiKey: null }
```

(b) Replace `export interface Config` (lines 56-67) with:
```ts
export interface Config {
  /** Runtime connection string: the pooled Neon host in production (see `loadConfig`). */
  databaseUrl: string
  /** `NOTESD_PORT`, default 7317. 0 means "any free port" (tests). */
  port: number
  /** Always 127.0.0.1. The daemon has no auth, so it never listens anywhere else. */
  host: typeof LOOPBACK_HOST
  /** Absolute path. `NOTES_DATA_DIR`, default ~/mcp-notes-data. Not created here. */
  dataDir: string
  /** The chat bar brain (POST /api/chat). */
  chat: ChatConfig
  /** Note embeddings via OpenRouter. `apiKey: null` turns semantic features off. */
  embeddings: EmbeddingsConfig
}
```

(c) Insert after `parseChat` (after line 191):
```ts
function parseEmbeddings(env: Record<string, string | undefined>): EmbeddingsConfig {
  const apiKey = env.OPENROUTER_API_KEY?.trim() ?? ''
  return { apiKey: apiKey === '' ? null : apiKey }
}
```

(d) Replace the `loadConfig` doc comment and function (lines 193-222) with:
```ts
/**
 * Builds the daemon config from `.env.local` plus the process environment.
 * Chat keys: CHAT_BRAIN, CHAT_MAX_TURNS, CHAT_TIMEOUT_MS, NOTESD_CLAUDE_BIN, LLM_BASE_URL,
 * LLM_API_KEY, LLM_MODEL. Embeddings key: OPENROUTER_API_KEY (unset or blank: semantic search and
 * the embedding worker are off, `related` answers only from vectors already stored; note writes are
 * unaffected). Other keys are ignored.
 * Throws `ConfigError` when neither DATABASE_URL nor DATABASE_URL_UNPOOLED is set,
 * on a bad port, on a non-loopback host, on a bad chat key, or on CHAT_BRAIN=glm without LLM_*.
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const fromFile = readEnvFile(options.envFile ?? path.join(REPO_ROOT, '.env.local'))
  const realEnv: Record<string, string | undefined> = options.env ?? process.env
  const env: Record<string, string | undefined> = { ...fromFile, ...realEnv }

  const databaseUrl = pickDatabaseUrl(realEnv, env)
  if (!databaseUrl) {
    throw new ConfigError(
      `DATABASE_URL is not set. Put the Neon connection strings in ${path.join(REPO_ROOT, '.env.local')} ` +
        'or export DATABASE_URL.',
    )
  }

  const dataDirRaw = env.NOTES_DATA_DIR?.trim() || DEFAULT_DATA_DIR

  return {
    databaseUrl,
    port: parsePort(env.NOTESD_PORT),
    host: parseHost(env.NOTESD_HOST),
    dataDir: path.resolve(expandHome(dataDirRaw)),
    chat: parseChat(env),
    embeddings: parseEmbeddings(env),
  }
}
```
**Impact:** `Config` gains a required field. Every `Config` literal breaks until Steps 8–9 land, and they land in the same phase.

### Step 4: `AppDeps.embedder`
**File:** `src/deps.ts:1-12` (whole file)
**Code:**
```ts
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { Embedder } from './embeddings/embedder.js';
import type { NoteEvents } from './notes/events.js';
import type { NotesService } from './notes/service.js';

/** Everything the daemon wires together once at startup and hands to routes and background jobs. */
export interface AppDeps {
  config: Config;
  db: Db;
  events: NoteEvents;
  service: NotesService;
  /** Null without OPENROUTER_API_KEY (or when a test injects null): semantic features off. */
  embedder: Embedder | null;
}
```
**Impact:** `AppDeps` literals in tests break until Step 9 lands. `src/background.ts` receives the field and ignores it in this phase; Phase 3 reads it.

### Step 5: `NotesService` stores the embedder (no behavior change)
**File:** `src/notes/service.ts`
**Change:**
(a) Add an import after line 1 (`import type { Db } from '../db/client.js';`):
```ts
import type { Embedder } from '../embeddings/embedder.js';
```
(b) Replace `NotesServiceDeps` (lines 22-26):
```ts
export interface NotesServiceDeps {
  db: Db;
  dataDir: string;
  events: NoteEvents;
  /**
   * Query embedder for hybrid search and `related` (phases 4-5). Omitted or null: those fall back
   * or report that semantic search is off. Writes never use it.
   */
  embedder?: Embedder | null;
}
```
(c) Replace the field block and constructor (lines 70-78):
```ts
  private readonly db: Db;
  private readonly dataDir: string;
  private readonly events: NoteEvents;
  private readonly embedder: Embedder | null;

  constructor(deps: NotesServiceDeps) {
    this.db = deps.db;
    this.dataDir = deps.dataDir;
    this.events = deps.events;
    this.embedder = deps.embedder ?? null;
  }
```
**Impact:** none at runtime. The field is unused until Phase 4. `tsconfig.json` has no `noUnusedLocals`, so an unread private field compiles. **Phase 4 note:** if Phase 4 needs `embedder` reachable from tests, it can widen the visibility. This phase keeps it `private readonly`.

### Step 6: Daemon builds or injects the embedder
**File:** `src/daemon.ts`
**Change:**
(a) Imports. Replace lines 1-13 (the import block) with:
```ts
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { startBackground } from './background.js';
import { createAgentChatBackend, type AgentChatBackend } from './chat/agent.js';
import type { ChatBackend } from './chat/backend.js';
import type { Config } from './config.js';
import { closeDb, createDb } from './db/client.js';
import type { AppDeps } from './deps.js';
import type { Embedder } from './embeddings/embedder.js';
import { embedderFromConfig } from './embeddings/openrouter.js';
import { createApp } from './http/app.js';
import { NoteEvents } from './notes/events.js';
import { NotesService } from './notes/service.js';
```
(b) Replace `StartDaemonOptions` (lines 27-30):
```ts
export interface StartDaemonOptions {
  /** The brain behind POST /api/chat. Omitted: the Agent SDK backend built from config.chat (tests inject the stub or a scripted fake). */
  chat?: ChatBackend;
  /**
   * The embedder for the worker, hybrid search and `related`. Omitted: built from
   * config.embeddings (null without OPENROUTER_API_KEY). Tests inject the fake embedder, or null
   * to keep the daemon off the network.
   */
  embedder?: Embedder | null;
}
```
(c) Replace `startDaemon` (lines 56-108, the doc line plus the whole function):
```ts
/** config -> data dirs -> embedder -> db -> service -> chat -> app -> listen on loopback -> background jobs. */
export async function startDaemon(config: Config, options: StartDaemonOptions = {}): Promise<RunningDaemon> {
  if (config.host !== '127.0.0.1') {
    throw new Error(`notesd binds 127.0.0.1 only (got host ${config.host}).`);
  }
  await ensureDataDirs(config.dataDir);
  // Before createDb: a blank key throws EmbeddingError here, with no pool to leak.
  const embedder = options.embedder !== undefined ? options.embedder : embedderFromConfig(config.embeddings);
  const db = createDb(config.databaseUrl);
  const events = new NoteEvents();
  const service = new NotesService({ db, dataDir: config.dataDir, events, embedder });
  const deps: AppDeps = { config, db, events, service, embedder };
  // The agent reaches notes through this daemon's own /mcp. The port is known only after
  // listen() (config.port may be 0), and the first chat run can only start after that.
  let boundPort: number | null = null;
  let agent: AgentChatBackend | null = null;
  let chat: ChatBackend;
  if (options.chat !== undefined) {
    chat = options.chat;
  } else {
    agent = createAgentChatBackend({
      chat: config.chat,
      cwd: join(config.dataDir, CHAT_SUBDIR),
      mcpUrl: () => {
        if (boundPort === null) throw new Error('notesd is not listening yet.');
        return `http://${config.host}:${boundPort}/mcp`;
      },
    });
    chat = agent;
  }
  const app = createApp(deps, { chat });

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port });
  let port: number;
  try {
    port = await listen(server);
  } catch (err) {
    await closeDb(db);
    throw err;
  }
  boundPort = port;
  const stopBackground = await startBackground(deps);

  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      agent?.close();
      await stopBackground();
      await closeServer(server);
      await closeDb(db);
    })();
    return stopping;
  };
  return { deps, port, stop };
}
```
**Impact:** `startDaemon` still makes no embedding call. With a key in `.env.local`, `main.ts` → `loadConfig` → a real embedder object sits idle until Phase 3. Nothing is logged about embeddings; Phase 3 owns the "embeddings off" log line.

### Step 7: Deterministic concept-bag fake embedder
**File:** `tests/helpers/fakeEmbedder.ts` (new)
**Change:** Each synonym group in the lexicon is one concept axis. A token that matches no group is hashed (FNV-1a) into a low-weight tail, so a rare code token shared by two texts still adds a little similarity, as it would with the real model. The last axis is a bias axis used only when a text has no tokens, so the vector is never zero (pgvector cosine on a zero vector is NaN). The output is L2-normalised. Everything is pure and deterministic across instances and runs.
**Code:**
```ts
import { EMBEDDING_DIMENSIONS, EMBEDDING_MAX_CHARS, EMBEDDING_MODEL } from '../../src/embeddings/constants.js';
import { EmbeddingError, type EmbedOptions, type Embedder } from '../../src/embeddings/embedder.js';

/**
 * Synonym groups: group i is concept axis i. Entries are matched lower-case against tokens; an
 * entry ending in `*` matches every token with that prefix ("auth*" -> auth, authentication).
 * An exact entry beats a prefix; a longer prefix beats a shorter one; earlier groups win ties.
 */
export type Lexicon = readonly (readonly string[])[];

/**
 * A small default covering the brief's two usage examples, for phase 3's write-path tests.
 * Phase 4's labelled set passes its own lexicon.
 */
export const DEFAULT_LEXICON: Lexicon = [
  ['arango*'],
  ['credential*', 'password*', 'passwd', 'secret*', 'apikey*'],
  ['vault*', 'keychain*', 'bitwarden'],
  ['auth*', 'login*', 'logon', 'signin', 'sso'],
  ['fail*', 'broke', 'broken', 'break*', 'error*', 'crash*', 'accident*', 'incident*', 'outage*'],
  ['resume*', 'sleep*', 'slept', 'suspend*', 'wake*', 'woke', 'hibernat*'],
  ['laptop*', 'notebook*', 'thinkpad'],
  ['tired*', 'fatigue*', 'exhaust*', 'drowsy'],
];

/** Function words dropped before embedding, so they do not make every text look alike. */
export const DEFAULT_STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'in', 'on', 'at', 'of', 'to',
  'for', 'and', 'or', 'but', 'it', 'its', 'this', 'that', 'these', 'those', 'with', 'we', 'have',
  'has', 'had', 'our', 'my', 'me', 'i', 'you', 'do', 'did', 'does', 'any', 'about', 'there',
  'here', 'what', 'which', 'so', 'as', 'by', 'from', 'if', 'not', 'no',
]);

/** Weight of one unknown token relative to one concept hit (1.0). */
export const DEFAULT_TAIL_WEIGHT = 0.25;

export interface FakeEmbedderOptions {
  lexicon?: Lexicon;
  /** Default EMBEDDING_DIMENSIONS, so vectors fit the vector(1536) column. */
  dimensions?: number;
  /** Default EMBEDDING_MODEL, so stored rows count as current. */
  model?: string;
  stopwords?: Iterable<string>;
  tailWeight?: number;
  delayMs?: number;
}

/** Lower-case, NFKC, split on anything that is not a letter or digit, drop stopwords. */
export function tokenize(text: string, stopwords: ReadonlySet<string> = DEFAULT_STOPWORDS): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token !== '' && !stopwords.has(token));
}

/** Cosine similarity; 0 when either vector is all zeros. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error(`cosine: widths differ (${a.length} vs ${b.length})`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

interface ConceptIndex {
  exact: Map<string, number>;
  prefixes: Array<{ prefix: string; axis: number }>;
}

function indexLexicon(lexicon: Lexicon): ConceptIndex {
  const exact = new Map<string, number>();
  const prefixes: Array<{ prefix: string; axis: number }> = [];
  lexicon.forEach((group, axis) => {
    for (const raw of group) {
      const entry = raw.trim().toLowerCase();
      if (entry.endsWith('*')) {
        const prefix = entry.slice(0, -1);
        if (prefix !== '') prefixes.push({ prefix, axis });
      } else if (entry !== '' && !exact.has(entry)) {
        exact.set(entry, axis);
      }
    }
  });
  prefixes.sort((a, b) => b.prefix.length - a.prefix.length || a.axis - b.axis);
  return { exact, prefixes };
}

function conceptAxis(index: ConceptIndex, token: string): number | null {
  const hit = index.exact.get(token);
  if (hit !== undefined) return hit;
  for (const { prefix, axis } of index.prefixes) {
    if (token.startsWith(prefix)) return axis;
  }
  return null;
}

function scriptedFailure(): EmbeddingError {
  return new EmbeddingError('fake embedder: scripted failure');
}

/**
 * Deterministic offline Embedder for unit and integration tests. Same validation as the real
 * client (empty batch / empty input throws before anything is recorded), same clamp, same
 * model id and width by default.
 */
export class FakeEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;
  /** Every batch that would have reached the network, in call order (failed ones included). */
  readonly calls: string[][] = [];
  /** Wait this long inside every recorded call, before failing or answering. */
  delayMs: number;

  private readonly index: ConceptIndex;
  private readonly conceptCount: number;
  private readonly stopwords: ReadonlySet<string>;
  private readonly tailWeight: number;
  private failuresLeft = 0;
  private failure: Error = scriptedFailure();
  private failPredicate: ((input: string) => boolean) | null = null;
  private failPredicateError: Error = scriptedFailure();

  constructor(opts: FakeEmbedderOptions = {}) {
    const lexicon = opts.lexicon ?? DEFAULT_LEXICON;
    this.model = opts.model ?? EMBEDDING_MODEL;
    this.dimensions = opts.dimensions ?? EMBEDDING_DIMENSIONS;
    this.conceptCount = lexicon.length;
    // concept axes + at least one tail axis + the bias axis
    if (!Number.isInteger(this.dimensions) || this.dimensions < this.conceptCount + 2) {
      throw new Error(
        `fake embedder: ${this.dimensions} dimensions cannot hold ${this.conceptCount} concept groups (need >= ${this.conceptCount + 2})`,
      );
    }
    this.index = indexLexicon(lexicon);
    this.stopwords = opts.stopwords === undefined ? DEFAULT_STOPWORDS : new Set(opts.stopwords);
    this.tailWeight = opts.tailWeight ?? DEFAULT_TAIL_WEIGHT;
    this.delayMs = opts.delayMs ?? 0;
  }

  /** The next `n` recorded calls reject with `error` (default: an EmbeddingError). */
  failNext(n = 1, error?: Error): void {
    this.failuresLeft = n;
    this.failure = error ?? scriptedFailure();
  }

  /** While set, a recorded call rejects when any of its inputs matches. Null clears it. */
  failWhen(pred: ((input: string) => boolean) | null, error?: Error): void {
    this.failPredicate = pred;
    this.failPredicateError = error ?? scriptedFailure();
  }

  /** Clears calls, scripted failures and the delay. */
  reset(): void {
    this.calls.length = 0;
    this.failuresLeft = 0;
    this.failPredicate = null;
    this.delayMs = 0;
  }

  /** The vector embed() would return for `text`. Synchronous; records nothing; never fails. */
  vectorFor(text: string): number[] {
    const clamped = text.trim().slice(0, EMBEDDING_MAX_CHARS);
    const v = new Array<number>(this.dimensions).fill(0);
    const tailStart = this.conceptCount;
    const tailSize = this.dimensions - this.conceptCount - 1;
    for (const token of tokenize(clamped, this.stopwords)) {
      const axis = conceptAxis(this.index, token);
      if (axis !== null) {
        v[axis] = (v[axis] ?? 0) + 1;
      } else {
        const tail = tailStart + (fnv1a(token) % tailSize);
        v[tail] = (v[tail] ?? 0) + this.tailWeight;
      }
    }
    const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
    if (norm === 0) {
      v[this.dimensions - 1] = 1;
      return v;
    }
    return v.map((x) => x / norm);
  }

  async embed(inputs: readonly string[], _opts?: EmbedOptions): Promise<number[][]> {
    if (inputs.length === 0) throw new EmbeddingError('embedding needs at least one input');
    inputs.forEach((text, i) => {
      if (text.trim() === '') throw new EmbeddingError(`embedding input ${i} is empty`);
    });
    const batch = [...inputs];
    this.calls.push(batch);
    if (this.delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
    }
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw this.failure;
    }
    const pred = this.failPredicate;
    if (pred !== null && batch.some((input) => pred(input))) throw this.failPredicateError;
    return batch.map((text) => this.vectorFor(text));
  }
}

export function createFakeEmbedder(opts: FakeEmbedderOptions = {}): FakeEmbedder {
  return new FakeEmbedder(opts);
}
```
**Impact:** a test helper; not imported by `src/`.

### Step 8: Config tests
**File:** `tests/unit/config.test.ts`
**Change:**
(a) Line 6, import:
```ts
import { ConfigError, DEFAULT_CHAT_CONFIG, DEFAULT_EMBEDDINGS_CONFIG, DEFAULT_PORT, loadConfig, REPO_ROOT } from '../../src/config.js'
```
(b) Replace the `'applies defaults'` test (lines 28-38):
```ts
  it('applies defaults', () => {
    const cfg = loadConfig({ env: { DATABASE_URL: URL_A }, envFile: false })
    expect(cfg).toEqual({
      databaseUrl: URL_A,
      port: DEFAULT_PORT,
      host: '127.0.0.1',
      dataDir: path.join(homedir(), 'mcp-notes-data'),
      chat: DEFAULT_CHAT_CONFIG,
      embeddings: DEFAULT_EMBEDDINGS_CONFIG,
    })
    expect(cfg.chat).toEqual({ brain: 'claude', maxTurns: 24, timeoutMs: 180_000, claudeBin: 'claude', glm: null })
    expect(cfg.embeddings).toEqual({ apiKey: null })
  })
```
(c) Replace `'reads the env file and lets the real environment win'` (lines 40-46):
```ts
  it('reads the env file and lets the real environment win', () => {
    const file = envFile(
      ['LLM_API_KEY=ignored', 'DATABASE_URL=postgres://file/db', 'NOTESD_PORT=7400', 'OPENROUTER_API_KEY=x'].join('\n'),
    )
    expect(loadConfig({ env: {}, envFile: file })).toMatchObject({ databaseUrl: 'postgres://file/db', port: 7400 })
    expect(loadConfig({ env: {}, envFile: file }).embeddings).toEqual({ apiKey: 'x' })
    expect(loadConfig({ env: { NOTESD_PORT: '7401' }, envFile: file }).port).toBe(7401)
    expect(loadConfig({ env: { OPENROUTER_API_KEY: 'y' }, envFile: file }).embeddings.apiKey).toBe('y')
  })
```
(d) Append at end of file (after line 173):
```ts

describe('loadConfig embeddings', () => {
  function embeddings(env: Record<string, string>) {
    return loadConfig({ env: { DATABASE_URL: URL_A, ...env }, envFile: false }).embeddings
  }

  it('is off without OPENROUTER_API_KEY, or with a blank one', () => {
    expect(embeddings({})).toEqual({ apiKey: null })
    expect(embeddings({ OPENROUTER_API_KEY: '' })).toEqual({ apiKey: null })
    expect(embeddings({ OPENROUTER_API_KEY: '   ' })).toEqual({ apiKey: null })
  })

  it('trims the key', () => {
    expect(embeddings({ OPENROUTER_API_KEY: '  sk-or-v1-abc \n' })).toEqual({ apiKey: 'sk-or-v1-abc' })
  })

  it('keeps DEFAULT_EMBEDDINGS_CONFIG off', () => {
    expect(DEFAULT_EMBEDDINGS_CONFIG).toEqual({ apiKey: null })
  })
})
```

### Step 9: Every `Config` / `AppDeps` literal in tests
Each change below adds `embeddings: DEFAULT_EMBEDDINGS_CONFIG` to a `Config` literal and `embedder: null` to an `AppDeps` literal. No test behavior changes.

**9a. File:** `tests/integration/daemon.int.test.ts`
Line 5:
```ts
import { DEFAULT_CHAT_CONFIG, DEFAULT_EMBEDDINGS_CONFIG, type Config } from '../../src/config.js';
```
Add an import after line 7 (`import { startDaemon, type RunningDaemon } from '../../src/daemon.js';`):
```ts
import { createFakeEmbedder } from '../helpers/fakeEmbedder.js';
```
Lines 17-19:
```ts
function config(dir: string): Config {
  return {
    databaseUrl: url,
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    chat: DEFAULT_CHAT_CONFIG,
    embeddings: DEFAULT_EMBEDDINGS_CONFIG,
  };
}
```
Insert a new test right after the `'serves an injected chat backend'` test (after line 112, inside the same `describe`):
```ts
  it('has no embedder without OPENROUTER_API_KEY, and carries an injected one', async () => {
    // The shared daemon's config has embeddings.apiKey null and no embedder option.
    expect(daemon.deps.embedder).toBeNull();
    // The "with a key" path is unit-tested through embedderFromConfig: a daemon started here with
    // a key would hold a real OpenRouter client, and once phase 3's worker exists it would call it.
    const fakeDir = join(mkdtempSync(join(tmpdir(), 'notesd-')), 'data');
    const fake = createFakeEmbedder();
    const withFake = await startDaemon(config(fakeDir), {
      chat: createStubChatBackend({ delayMs: 0 }),
      embedder: fake,
    });
    try {
      expect(withFake.deps.embedder).toBe(fake);
      const res = await fetch(`http://127.0.0.1:${withFake.port}/health`);
      expect(res.status).toBe(200);
    } finally {
      await withFake.stop();
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });
```

**9b. File:** `tests/integration/images.int.test.ts`
Line 8:
```ts
import { DEFAULT_CHAT_CONFIG, DEFAULT_EMBEDDINGS_CONFIG } from '../../src/config.js';
```
Lines 120-125:
```ts
    const app: AppDeps = {
      config: {
        databaseUrl: testDatabaseUrl(),
        port: 0,
        host: '127.0.0.1',
        dataDir: dir,
        chat: DEFAULT_CHAT_CONFIG,
        embeddings: DEFAULT_EMBEDDINGS_CONFIG,
      },
      db,
      events: new NoteEvents(),
      service: notes,
      embedder: null,
    };
```

**9c. File:** `tests/integration/helpers/api-harness.ts`
Line 9:
```ts
import { DEFAULT_CHAT_CONFIG, DEFAULT_EMBEDDINGS_CONFIG } from '../../../src/config.js';
```
Lines 44-49:
```ts
  const deps: AppDeps = {
    config: {
      databaseUrl: url,
      port: 0,
      host: '127.0.0.1',
      dataDir,
      chat: DEFAULT_CHAT_CONFIG,
      embeddings: DEFAULT_EMBEDDINGS_CONFIG,
    },
    db,
    events,
    service: notes,
    embedder: null,
  };
```

**9d. File:** `tests/integration/imageHarness.ts`
Line 7:
```ts
import { DEFAULT_CHAT_CONFIG, DEFAULT_EMBEDDINGS_CONFIG } from '../../src/config.js';
```
Lines 34-39:
```ts
  const deps: AppDeps = {
    config: {
      databaseUrl: url,
      port: 0,
      host: '127.0.0.1',
      dataDir,
      chat: DEFAULT_CHAT_CONFIG,
      embeddings: DEFAULT_EMBEDDINGS_CONFIG,
    },
    db,
    events,
    service,
    embedder: null,
  };
```

**9e. File:** `tests/integration/connectors/mcp.int.test.ts`
Line 8:
```ts
import { DEFAULT_CHAT_CONFIG, DEFAULT_EMBEDDINGS_CONFIG, type Config } from '../../../src/config.js';
```
Line 17:
```ts
const config: Config = {
  databaseUrl: testDatabaseUrl(),
  port: 0,
  host: '127.0.0.1',
  dataDir,
  chat: DEFAULT_CHAT_CONFIG,
  embeddings: DEFAULT_EMBEDDINGS_CONFIG,
};
```
Line 20:
```ts
const deps: AppDeps = { config, db, events, service, embedder: null };
```

**9f. File:** `tests/integration/mcp.tools.int.test.ts`
Line 9:
```ts
import { DEFAULT_CHAT_CONFIG, DEFAULT_EMBEDDINGS_CONFIG, type Config } from '../../src/config.js';
```
Line 20:
```ts
const config: Config = {
  databaseUrl: url,
  port: 0,
  host: '127.0.0.1',
  dataDir,
  chat: DEFAULT_CHAT_CONFIG,
  embeddings: DEFAULT_EMBEDDINGS_CONFIG,
};
```
Line 23:
```ts
const deps: AppDeps = { config, db, events, service, embedder: null };
```

**9g. File:** `tests/live/chat.live.test.ts:54`
**Change:** This test builds its `Config` through `loadConfig` with the real `.env.local`, so it picks up the real `OPENROUTER_API_KEY`. Passing null keeps invariant 3 (only the embeddings live test reaches OpenRouter) true after Phase 3 adds the worker.
```ts
  daemon = await startDaemon(config, { chat: createStubChatBackend({ delayMs: 0 }), embedder: null });
```

**Final sweep (implementer):** before Step 10, run
`grep -rnE "chat: DEFAULT_CHAT_CONFIG|: AppDeps = \{|const deps: AppDeps|const app: AppDeps" src tests`
and confirm that every hit has `embeddings` / `embedder`. `npm run typecheck` is the backstop: a missing field is a compile error.

### Step 10: OpenRouter unit tests (fake fetch, no network)
**File:** `tests/unit/embeddings/openrouter.test.ts` (new)
**Code:**
```ts
import { describe, expect, it, vi } from 'vitest';
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MAX_CHARS,
  EMBEDDING_MODEL,
  OPENROUTER_EMBEDDINGS_URL,
} from '../../../src/embeddings/constants.js';
import { EmbeddingError, embeddingErrorText } from '../../../src/embeddings/embedder.js';
import {
  OPENROUTER_EMBED_MAX_BATCH,
  OPENROUTER_EMBED_TIMEOUT_MS,
  RESPONSE_SNIPPET_CHARS,
  createOpenRouterEmbedder,
  embedderFromConfig,
} from '../../../src/embeddings/openrouter.js';

const KEY = 'sk-or-v1-TEST-SECRET-0123456789';

interface SentBody {
  model: string;
  input: string[];
  encoding_format: string;
}

/** A 1536-wide vector whose first element is `seed`, so tests can tell vectors apart. */
function vec(seed: number, width = EMBEDDING_DIMENSIONS): number[] {
  return Array.from({ length: width }, (_, i) => (i === 0 ? seed : i / 1_000_000));
}

/** "note 7" -> 7 */
function seedOf(input: string): number {
  return Number(input.replace(/\D/g, ''));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fakeFetch(handler: (body: SentBody, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as SentBody;
    return handler(body, init ?? {});
  });
}

/** Answers every batch correctly, in order, with index set. */
function echoFetch() {
  return fakeFetch((body) =>
    json({ data: body.input.map((input, index) => ({ index, embedding: vec(seedOf(input)) })) }),
  );
}

function embedder(f: unknown, extra: { timeoutMs?: number; maxBatch?: number } = {}) {
  return createOpenRouterEmbedder({ apiKey: KEY, fetch: f as unknown as typeof fetch, ...extra });
}

/** Awaits a rejection, checks it is an EmbeddingError and that the key never leaks. */
async function failure(p: Promise<unknown>): Promise<EmbeddingError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(EmbeddingError);
    expect(embeddingErrorText(err)).not.toContain(KEY);
    expect((err as Error).message).not.toContain(KEY);
    return err as EmbeddingError;
  }
  throw new Error('expected embed() to reject');
}

describe('createOpenRouterEmbedder', () => {
  it('exposes the model and width from the constants', () => {
    const e = embedder(echoFetch());
    expect(e.model).toBe(EMBEDDING_MODEL);
    expect(e.dimensions).toBe(EMBEDDING_DIMENSIONS);
    expect(OPENROUTER_EMBED_TIMEOUT_MS).toBe(15_000);
  });

  it('refuses a blank key at construction, without a request', () => {
    const f = echoFetch();
    expect(() => createOpenRouterEmbedder({ apiKey: '  ', fetch: f as unknown as typeof fetch })).toThrow(EmbeddingError);
    expect(f).not.toHaveBeenCalled();
  });

  it('refuses a bad maxBatch', () => {
    expect(() => embedder(echoFetch(), { maxBatch: 0 })).toThrow(RangeError);
  });

  it('throws before any request on an empty batch or an empty input', async () => {
    const f = echoFetch();
    const e = embedder(f);
    expect((await failure(e.embed([]))).message).toMatch(/at least one input/);
    expect((await failure(e.embed(['note 1', '  \n ']))).message).toMatch(/input 1 is empty/);
    expect(f).not.toHaveBeenCalled();
  });

  it('posts the run-insights request shape', async () => {
    const f = echoFetch();
    await embedder(f).embed(['  note 1  ']);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(OPENROUTER_EMBEDDINGS_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` });
    expect(JSON.parse(String(init.body))).toEqual({ model: EMBEDDING_MODEL, input: ['note 1'], encoding_format: 'float' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('clamps each input to EMBEDDING_MAX_CHARS without a marker', async () => {
    const f = echoFetch();
    await embedder(f).embed([`note 1 ${'x'.repeat(EMBEDDING_MAX_CHARS + 500)}`]);
    const sent = JSON.parse(String((f.mock.calls[0] as [string, RequestInit])[1].body)) as SentBody;
    expect(sent.input[0]).toHaveLength(EMBEDDING_MAX_CHARS);
  });

  it('returns vectors in input order, placed by data[i].index', async () => {
    const f = fakeFetch((body) =>
      json({
        data: body.input
          .map((input, index) => ({ index, embedding: vec(seedOf(input)) }))
          .reverse(),
      }),
    );
    const out = await embedder(f).embed(['note 1', 'note 2', 'note 3']);
    expect(out.map((v) => v[0])).toEqual([1, 2, 3]);
  });

  it('falls back to position when the provider omits index', async () => {
    const f = fakeFetch((body) => json({ data: body.input.map((input) => ({ embedding: vec(seedOf(input)) })) }));
    const out = await embedder(f).embed(['note 4', 'note 5']);
    expect(out.map((v) => v[0])).toEqual([4, 5]);
  });

  it('splits a large call into maxBatch-sized requests and keeps order', async () => {
    const f = echoFetch();
    const inputs = ['note 1', 'note 2', 'note 3', 'note 4', 'note 5'];
    const out = await embedder(f, { maxBatch: 2 }).embed(inputs);
    expect(f).toHaveBeenCalledTimes(3);
    const sizes = f.mock.calls.map((c) => (JSON.parse(String((c as [string, RequestInit])[1].body)) as SentBody).input.length);
    expect(sizes).toEqual([2, 2, 1]);
    expect(out.map((v) => v[0])).toEqual([1, 2, 3, 4, 5]);
    expect(OPENROUTER_EMBED_MAX_BATCH).toBe(64);
  });

  it('fails the whole call when a later chunk fails', async () => {
    let n = 0;
    const f = fakeFetch((body) => {
      n += 1;
      return n === 2
        ? new Response('upstream sad', { status: 500 })
        : json({ data: body.input.map((input, index) => ({ index, embedding: vec(seedOf(input)) })) });
    });
    const err = await failure(embedder(f, { maxBatch: 1 }).embed(['note 1', 'note 2', 'note 3']));
    expect(err.message).toMatch(/returned 500/);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('wraps a transport failure with its cause', async () => {
    const cause = new TypeError('fetch failed');
    const f = vi.fn(async () => {
      throw cause;
    });
    const err = await failure(embedder(f).embed(['note 1']));
    expect(err.message).toBe('embedding request failed');
    expect(err.detail).toBe(cause);
    expect(embeddingErrorText(err)).toContain('fetch failed');
  });

  function hangingFetch() {
    return vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
    );
  }

  it('times out with the configured ceiling', async () => {
    const err = await failure(embedder(hangingFetch(), { timeoutMs: 20 }).embed(['note 1']));
    expect(err.message).toBe('embedding request timed out after 20 ms');
  });

  it('honours a per-call timeout', async () => {
    const err = await failure(embedder(hangingFetch(), { timeoutMs: 60_000 }).embed(['note 1'], { timeoutMs: 15 }));
    expect(err.message).toBe('embedding request timed out after 15 ms');
  });

  it('reports a non-2xx status with a bounded snippet, even for an HTML body', async () => {
    const page = `<html>${'bad gateway '.repeat(200)}</html>`;
    const f = fakeFetch(() => new Response(page, { status: 502 }));
    const err = await failure(embedder(f).embed(['note 1']));
    expect(err.message).toMatch(/^embedding endpoint returned 502: <html>bad gateway/);
    expect(err.message.length).toBeLessThanOrEqual('embedding endpoint returned 502: '.length + RESPONSE_SNIPPET_CHARS);
    expect(err.detail).toEqual({ status: 502 });
  });

  it('reports a 401 without echoing the key', async () => {
    const f = fakeFetch(() => json({ error: { message: 'No auth credentials found', code: 401 } }, 401));
    const err = await failure(embedder(f).embed(['note 1']));
    expect(err.message).toMatch(/returned 401: .*No auth credentials found/);
  });

  it('reports a 200 body that is not JSON', async () => {
    const f = fakeFetch(() => new Response('definitely not json', { status: 200 }));
    expect((await failure(embedder(f).embed(['note 1']))).message).toBe(
      'embedding response was not valid JSON: definitely not json',
    );
  });

  it('reports a 200 JSON body without a data array', async () => {
    const f = fakeFetch(() => json({ error: { message: 'model overloaded' } }));
    expect((await failure(embedder(f).embed(['note 1']))).message).toMatch(/no data array: .*model overloaded/);
  });

  it('reports a vector count that does not match the inputs', async () => {
    const f = fakeFetch(() => json({ data: [{ index: 0, embedding: vec(1) }] }));
    expect((await failure(embedder(f).embed(['note 1', 'note 2']))).message).toMatch(/1 vector\(s\) for 2 input\(s\)/);
  });

  it('reports an item with no embedding array', async () => {
    const f = fakeFetch(() => json({ data: [{ index: 0, embedding: 'AAAA' }] }));
    expect((await failure(embedder(f).embed(['note 1']))).message).toMatch(/no vector at data\[0\]\.embedding/);
  });

  it('reports a repeated or out-of-range index', async () => {
    const dup = fakeFetch(() => json({ data: [{ index: 0, embedding: vec(1) }, { index: 0, embedding: vec(2) }] }));
    expect((await failure(embedder(dup).embed(['note 1', 'note 2']))).message).toMatch(/bad or repeated index 0 at data\[1\]/);
    const out = fakeFetch(() => json({ data: [{ index: 5, embedding: vec(1) }] }));
    expect((await failure(embedder(out).embed(['note 1']))).message).toMatch(/bad or repeated index 5/);
  });

  it('refuses a vector of the wrong width, naming both numbers', async () => {
    const f = fakeFetch(() => json({ data: [{ index: 0, embedding: vec(1, 1024) }] }));
    const err = await failure(embedder(f).embed(['note 1']));
    expect(err.message).toContain('1024 value(s)');
    expect(err.message).toContain(`vector(${EMBEDDING_DIMENSIONS})`);
  });

  it('refuses a non-finite or non-numeric element', async () => {
    const withNull = vec(1);
    (withNull as unknown[])[10] = null;
    const f = fakeFetch(() => json({ data: [{ index: 0, embedding: withNull }] }));
    expect((await failure(embedder(f).embed(['note 1']))).message).toMatch(/non-finite/);
  });
});

describe('embedderFromConfig', () => {
  it('is null without a key', () => {
    expect(embedderFromConfig({ apiKey: null })).toBeNull();
  });

  it('builds the OpenRouter embedder with a key, without a request', () => {
    const f = echoFetch();
    const e = embedderFromConfig({ apiKey: KEY }, { fetch: f as unknown as typeof fetch });
    expect(e).not.toBeNull();
    expect(e?.model).toBe(EMBEDDING_MODEL);
    expect(e?.dimensions).toBe(EMBEDDING_DIMENSIONS);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('embeddingErrorText', () => {
  it('includes the detail of an EmbeddingError', () => {
    const inner = new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 1.2.3.4:443') });
    expect(embeddingErrorText(new EmbeddingError('embedding request failed', inner))).toBe(
      'EmbeddingError: embedding request failed - detail: TypeError: fetch failed (connect ECONNREFUSED 1.2.3.4:443)',
    );
    expect(embeddingErrorText(new EmbeddingError('x', { status: 502 }))).toBe('EmbeddingError: x - detail: {"status":502}');
    expect(embeddingErrorText(new EmbeddingError('plain'))).toBe('EmbeddingError: plain');
  });

  it('formats other errors and non-errors', () => {
    expect(embeddingErrorText(new RangeError('r'))).toBe('RangeError: r');
    expect(embeddingErrorText('s')).toBe('s');
  });
});
```
Notes for the implementer:
- `embedder()` takes `f: unknown` and casts it to `typeof fetch`, so each `vi.fn` keeps its own precise type for `f.mock.calls`.
- The width-error message uses `(or a non-finite one)`, which is how the `/non-finite/` assertion matches.

### Step 11: Fake embedder unit tests
**File:** `tests/unit/embeddings/fakeEmbedder.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from '../../../src/embeddings/constants.js';
import { EmbeddingError } from '../../../src/embeddings/embedder.js';
import { cosine, createFakeEmbedder, tokenize } from '../../helpers/fakeEmbedder.js';

const ARANGO_NOTE = 'arango root password is in the vault';
const ARANGO_QUERY = 'ArangoDB credentials';
const LOGIN_NOTE = 'the login broke after the laptop slept';
const LOGIN_QUERY = 'have we seen auth failures after resume before?';
const UNRELATED = 'bought groceries: rice, eggs, chili';

function norm(v: readonly number[]): number {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

describe('fake embedder', () => {
  it('defaults to the real model id and width', () => {
    const e = createFakeEmbedder();
    expect(e.model).toBe(EMBEDDING_MODEL);
    expect(e.dimensions).toBe(EMBEDDING_DIMENSIONS);
  });

  it('is deterministic across calls and instances, and unit length', async () => {
    const a = createFakeEmbedder();
    const b = createFakeEmbedder();
    const [v1] = await a.embed([ARANGO_NOTE]);
    const [v2] = await b.embed([ARANGO_NOTE]);
    expect(v1).toEqual(v2);
    expect(v1).toEqual(a.vectorFor(ARANGO_NOTE));
    expect(v1).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(norm(v1!)).toBeCloseTo(1, 10);
  });

  it('puts the brief usage examples closest to their notes without word overlap', () => {
    const e = createFakeEmbedder();
    const q1 = e.vectorFor(ARANGO_QUERY);
    const q2 = e.vectorFor(LOGIN_QUERY);
    expect(cosine(q1, e.vectorFor(ARANGO_NOTE))).toBeGreaterThan(cosine(q1, e.vectorFor(LOGIN_NOTE)));
    expect(cosine(q1, e.vectorFor(ARANGO_NOTE))).toBeGreaterThan(cosine(q1, e.vectorFor(UNRELATED)));
    expect(cosine(q2, e.vectorFor(LOGIN_NOTE))).toBeGreaterThan(cosine(q2, e.vectorFor(ARANGO_NOTE)));
    expect(cosine(q2, e.vectorFor(LOGIN_NOTE))).toBeGreaterThan(cosine(q2, e.vectorFor(UNRELATED)));
    expect(cosine(q1, e.vectorFor(ARANGO_NOTE))).toBeGreaterThan(0.5);
  });

  it('gives a shared unknown token a small, non-zero similarity', () => {
    const e = createFakeEmbedder();
    const s = cosine(e.vectorFor('ERR_ZX9_QUUX happened'), e.vectorFor('saw ERR_ZX9_QUUX again'));
    expect(s).toBeGreaterThan(0);
  });

  it('accepts a custom lexicon and width, with prefix entries', () => {
    const e = createFakeEmbedder({ lexicon: [['kube*', 'k8s'], ['cat', 'kitten']], dimensions: 16 });
    expect(e.vectorFor('k8s')).toHaveLength(16);
    expect(cosine(e.vectorFor('kubernetes'), e.vectorFor('k8s'))).toBeCloseTo(1, 10);
    expect(cosine(e.vectorFor('kitten'), e.vectorFor('kubectl'))).toBeCloseTo(0, 10);
  });

  it('refuses a width that cannot hold the lexicon', () => {
    expect(() => createFakeEmbedder({ lexicon: [['a'], ['b'], ['c']], dimensions: 4 })).toThrow(/cannot hold/);
  });

  it('never returns a zero vector', () => {
    const e = createFakeEmbedder();
    const v = e.vectorFor('the and of');
    expect(norm(v)).toBeCloseTo(1, 10);
    expect(v[EMBEDDING_DIMENSIONS - 1]).toBe(1);
  });

  it('tokenizes on non-letters and drops stopwords', () => {
    expect(tokenize('The ArangoDB root-password, is IN vault!')).toEqual(['arangodb', 'root', 'password', 'vault']);
  });

  it('validates like the real client, recording nothing', async () => {
    const e = createFakeEmbedder();
    await expect(e.embed([])).rejects.toBeInstanceOf(EmbeddingError);
    await expect(e.embed(['ok', ' '])).rejects.toThrow(/input 1 is empty/);
    expect(e.calls).toEqual([]);
  });

  it('records batches and fails the next n calls on request', async () => {
    const e = createFakeEmbedder();
    e.failNext(2);
    await expect(e.embed(['a1'])).rejects.toBeInstanceOf(EmbeddingError);
    await expect(e.embed(['a2'])).rejects.toBeInstanceOf(EmbeddingError);
    await expect(e.embed(['a3', 'a4'])).resolves.toHaveLength(2);
    expect(e.calls).toEqual([['a1'], ['a2'], ['a3', 'a4']]);
  });

  it('fails a call whose inputs match failWhen, with a custom error', async () => {
    const e = createFakeEmbedder();
    const boom = new EmbeddingError('boom');
    e.failWhen((input) => input.includes('poison'), boom);
    await expect(e.embed(['fine', 'has poison'])).rejects.toBe(boom);
    await expect(e.embed(['fine'])).resolves.toHaveLength(1);
    e.failWhen(null);
    await expect(e.embed(['has poison'])).resolves.toHaveLength(1);
  });

  it('waits delayMs before answering, and reset clears state', async () => {
    const e = createFakeEmbedder({ delayMs: 30 });
    const started = Date.now();
    await e.embed(['slow']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    e.failNext(5);
    e.reset();
    expect(e.calls).toEqual([]);
    expect(e.delayMs).toBe(0);
    await expect(e.embed(['ok'])).resolves.toHaveLength(1);
  });
});
```
Check for the implementer: the tokenizer test expects `'the'`, `'is'` and `'in'` to be dropped as stopwords, and `'root-password'` to split into two tokens. Both hold with `DEFAULT_STOPWORDS` as written.

## Verification

**Build:** `npm run typecheck` (on top of Phase 1).
**Tests:** `npm test` (unit: config, openrouter, fakeEmbedder, plus everything existing) and `npm run test:int` (every Config/AppDeps literal compiles; the new daemon test).
**Manual check:**
- `grep -rn "OPENROUTER_API_KEY\|apiKey" src | grep -i "console\."` should print nothing (the key is never logged).
- `grep -rn "fetch(" tests/unit/embeddings` should show only fake fetches.
- Optionally, with `.env.local` symlinked, `npm run dev` should start; `deps.embedder` is non-null, and no request leaves the machine because nothing calls it in this phase.
**Exit criteria:** every run-insights error path has a unit test against a fake `fetch`: missing key, empty input, transport failure, timeout, non-2xx, non-JSON, no vector, wrong width, non-finite. Batching keeps input order across chunks and ignores response order. `startDaemon` runs with no key (`deps.embedder === null`) and with an injected embedder (`deps.embedder === fake`). `embedderFromConfig` returns an OpenRouter embedder when a key is set. `npm run typecheck`, `npm test` and `npm run test:int` pass.

## Handoffs

- **Phase 1:** owns `src/embeddings/constants.ts` and `state.ts`. This phase imports `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `EMBEDDING_MAX_CHARS`, `OPENROUTER_EMBEDDINGS_URL` and `embedInput` under exactly those names, and runs after Phase 1 (reconciled).
- **Phase 1 / 3 (R1):** cap `embeddingErrorText(err)` at 500 characters before writing `note_embeddings.last_error`; `recordFailure` owns the cap. The texts carry ≤300-char response snippets and never the key.
- **Phase 3 (R3, R1):** start the worker only when `deps.embedder !== null`. Log the one "embeddings off (no OPENROUTER_API_KEY)" line; this phase logs nothing about embeddings. Keep batch sizes ≤ `OPENROUTER_EMBED_MAX_BATCH` (64), or rely on `embed()` splitting the batch, which makes a failure fail the whole batch. `src/cli/embedBackfill.ts` builds its embedder with `embedderFromConfig(loadConfig().embeddings)` and should exit with a clear message when it returns null. **Startup-time network:** a test that starts a daemon with a real key will make the Phase 3 worker call OpenRouter. This phase already passes `embedder: null` in `tests/live/chat.live.test.ts`; Phase 3 should keep every daemon-starting test on either null or the fake.
- **Phase 4 (R4):** read `this.embedder` in `NotesService.search`. Pass a short per-call `{ timeoutMs }` so a slow provider degrades to text quickly. Use `createFakeEmbedder({ lexicon })` with the labelled set's own lexicon. `tokenize`, `cosine`, `Lexicon` and `DEFAULT_STOPWORDS` are exported for it.
- **Phase 5 (R5):** `related` reads stored vectors only, so it needs no embedder call. If it wants to report "semantic search is off", it can check `this.embedder === null`.
- **Phase 6 (R6):** `tests/live/embeddings.live.test.ts` constructs `createOpenRouterEmbedder({ apiKey })` from `loadConfig().embeddings.apiKey`, or `embedderFromConfig`. README/INSTALL should document `OPENROUTER_API_KEY` as optional (semantic features off without it).
- **Clamp (reconciled):** `embed()` clamps with Phase 1's surrogate-safe `embedInput`, so an 8 000-char cut never splits an emoji pair and there is one clamp rule in the code base.

## Rollback

Revert the phase commit. That removes `src/embeddings/embedder.ts`, `src/embeddings/openrouter.ts` and `tests/helpers/fakeEmbedder.ts`, and restores `Config`/`AppDeps`/`NotesServiceDeps`/`StartDaemonOptions` and the test literals. No data, schema or migration is involved. Phases 3–6 import from this phase, so they must be reverted first.
