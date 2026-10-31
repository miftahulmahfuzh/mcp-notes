> Adopted from `/home/miftah/.worktrees/mcp-notes/chat-history-files-image-search/.workflows/orchestration/chat-history-files-image-search/PLAN.md` phase 6. Source: `.workflows/plan/chat-history-files-image-search/phase-6.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 6: Image embeddings and `similar_images`

**Plan set:** `CHAT_HISTORY_FILES_IMAGE_SEARCH_PLAN.md`
**Analysis:** `docs/analyzer/20261031-081555-Q4TD_code_analyzer.md`
**Satisfies:** R5 — real image similarity search ("find similar photos as this", and text to image)
**Depends on:** Phase 3 (the `chat_images` table that `upload_id` reads; migration 0003), Phase 4 (migration 0004; this phase's migration is 0005)
**Difficulty:** HARD
**Package:** `src/embeddings` (+ `src/mcp`, `src/db`, `src/cli`, `src/chat`)

---

## Goal

Every note image gets a Gemini Embedding 2 vector (1536 dims, via OpenRouter, same key as the text
embeddings) in a new `note_image_embeddings` table, written by a background worker beside the
existing text-embedding worker and by an explicit `npm run embed:images:backfill`. A new MCP tool
`similar_images` returns the nearest images for an existing image id, a wall-chat upload
(`upload_id`) or a text query, and is on the wall chat agent's allowlist. Images whose file lives
on the other laptop are skipped without being recorded as failures.

## Interface Contract

**Deletes:** nothing.

**Renames:** nothing.

**Creates:**
- `src/embeddings/imageConstants.ts`: `IMAGE_EMBEDDING_MODEL` (`'google/gemini-embedding-2'`), `IMAGE_EMBEDDING_DIMENSIONS` (1536), `IMAGE_EMBED_LONG_EDGE` (1024), `IMAGE_PRICE_USD_PER_M_TOKENS`, `TEXT_PRICE_USD_PER_M_TOKENS`, `IMAGE_TOKENS_PER_TILE`, `IMAGE_SMALL_EDGE`, `IMAGE_TILE_EDGE`, `estimateImageTokens`, `estimateImageCostUsd`
- `src/embeddings/imageEmbedder.ts`: `interface ImageEmbedder { model; dimensions; embedImage(png, opts?); embedText(query, opts?) }`
- `src/embeddings/openrouterImage.ts`: `createOpenRouterImageEmbedder`, `imageEmbedderFromConfig`, `imageRequestBody`, `textRequestBody`, `pngDataUrl`, `fitVector`, `isPng`, `OPENROUTER_IMAGE_EMBED_TIMEOUT_MS`, `MAX_EMBED_PNG_BYTES`, types `EmbeddingContentPart`, `ImageEmbeddingRequestBody`, `OpenRouterImageEmbedderOptions`
- `src/embeddings/imageInput.ts`: `toEmbeddingPng`, `notePngForEmbedding`
- `src/embeddings/imageRepo.ts`: `PendingImage`, `listPendingImages`, `saveImageEmbedding`, `recordImageFailure`, `ImageEmbeddingStats`, `imageEmbeddingStats`, `NearestImageSource`, `NearestImage`, `nearestImages`
- `src/embeddings/imageBackfill.ts`: `ImageEmbeddingStore`, `dbImageEmbeddingStore`, `UnavailableImages`, `runImageBackfill`, `ImageOutcome`, `ImageReport`, `ImageBackfillProgress`, `ImageBackfillResult`, `ImageBackfillOptions`, `DEFAULT_IMAGE_PAGE_SIZE`, `DEFAULT_UNAVAILABLE_RECHECK_MS`
- `src/embeddings/imageWorker.ts`: `startImageEmbeddingWorker`, `formatImageDrain`, `ImageEmbeddingWorkerOptions`, `ImageDrainSummary`
- `src/embeddings/chatUploads.ts`: `ChatUploadFile`, `ChatUploadSource`, `dbChatUploadSource`
- `src/cli/embedImagesBackfill.ts`: `embedImagesBackfill`, `EmbedImagesBackfillIo`, `defaultIo`, `DRY_RUN_MAX_ROWS`
- `src/mcp/similarTools.ts`: `registerSimilarTools`, `countSources`, `bodySnippet`, `SimilarArgs`, `SimilarSource`, `SimilarHit`, `SimilarImagesResult`, `IMAGE_SEARCH_OFF`, `PASTED_IMAGE_NEEDS_HOOK`, `SIMILAR_IMAGES_DEFAULT_LIMIT`, `SIMILAR_IMAGES_MAX_LIMIT`, `SIMILAR_SNIPPET_CHARS`
- `src/db/schema.ts`: `noteImageEmbeddings` table, type `NoteImageEmbeddingRow`
- `drizzle/0005_note_image_embeddings.sql` + `drizzle/meta/0005_snapshot.json` + journal entry (generated)
- `src/embeddings/openrouter.ts`: `postOpenRouterEmbeddings` (extracted from the text embedder's `request`), and `snippet` / `errorName` become exported
- MCP tool `similar_images`; `'similar_images'` in `NOTES_TOOL_NAMES`; caption `'finding similar photos'`
- npm scripts `embed:images:backfill`, `test:live:imageEmbeddings`; env switch `IMAGE_EMBEDDINGS_LIVE_TEST=1` in `vitest.config.ts`
- `tests/helpers/fakeImageEmbedder.ts`: `FakeImageEmbedder`, `vectorForColour`, `vectorForHash`, `COLOUR_WORDS`, `Rgb`

**Signature changes:**
- `interface AppDeps` gains required `imageEmbedder: ImageEmbedder | null` (`src/deps.ts`)
- `interface StartDaemonOptions` gains `imageEmbedder?: ImageEmbedder | null` (`src/daemon.ts`)
- `interface ToolDeps` gains optional `imageEmbedder?: ImageEmbedder | null` and `chatUploads?: ChatUploadSource` (`src/mcp/tools.ts`)
- `mcpToolDeps(deps)` now also returns `imageEmbedder` and `chatUploads` (`src/http/app.ts`)
- `startHarness(options: { chat?: ChatBackend } = {})` (Phase 3) -> `startHarness(options: { chat?: ChatBackend; imageEmbedder?: ImageEmbedder | null } = {})` (`tests/integration/imageHarness.ts`; extends Phase 3's `HarnessOptions`, callers passing `{ chat }` are unchanged)
- `startBackground(deps)` unchanged signature; also starts/stops the image worker
- `createOpenRouterEmbedder` behaviour unchanged (same request body string, same error texts); its `request` now calls `postOpenRouterEmbeddings`

**Requires (from earlier phases):**
- Phase 3: `src/chat/images.ts` exports `locateChatImage(deps: Pick<ChatImageStoreDeps, 'db' | 'dataDir'>, rawId: string): Promise<LocatedChatImage | null>` (`{ row: ChatImageRow; source: { id, mime, originalPath }; available }`, null for a malformed or unknown id); `src/embeddings/chatUploads.ts` wraps it. P3 tags pasted images `[image upload:ID]` in the prompt text (this phase's system prompt sentence relies on that wording).
- Phase 3 and 4: migrations 0003 and 0004 exist, so `npm run db:generate` produces 0005. Their `truncateAll` list entries exist (this phase prepends one table to that list).
- Phases 3 and 4 add no `AppDeps` field (P3 builds its store with `chatImageStoreFor(app)` from `db` + `config.dataDir`), so every `AppDeps` literal listed below is quoted as on `main` plus `imageEmbedder`.

**Leaves alone (owned by others):**
- `claude/hooks/*`, `scripts/install.sh`/`uninstall.sh`, and the real `pasted_image` -> `upload_id` rewrite (Phase 8). This phase accepts `pasted_image` and answers with an `isError` explaining the hook.
- `src/chat/agent.ts`, `src/chat/backend.ts`, `src/http/api.ts`, chat images store/routes (Phase 3); chat persistence (Phase 7).
- every `web/` file (no UI for image similarity in v1).
- `src/embeddings/{backfill,worker,repo,state,constants,embedder}.ts` stay as they are (imported, not modified). The only edit to existing embedding code is the `openrouter.ts` extraction.

## Files

| File | Action | What changes |
|---|---|---|
| `src/embeddings/imageConstants.ts` | create | model id, width, long edge, prices, token estimate |
| `src/embeddings/imageEmbedder.ts` | create | `ImageEmbedder` interface |
| `src/embeddings/openrouter.ts` | modify (lines 32-34, 50-52, 127-178) | export `snippet`, `errorName`; extract `postOpenRouterEmbeddings` |
| `src/embeddings/openrouterImage.ts` | create | OpenRouter Gemini image/text embedder, truncate + renormalise |
| `src/embeddings/imageInput.ts` | create | preview -> PNG <= 1024 px; upload file -> PNG |
| `src/embeddings/imageRepo.ts` | create | pending / save / failure / stats / nearest SQL |
| `src/embeddings/imageBackfill.ts` | create | `runImageBackfill`, db store, unavailable memo |
| `src/embeddings/imageWorker.ts` | create | event-kicked, swept, bounded-close worker |
| `src/embeddings/chatUploads.ts` | create | `upload_id` -> file adapter over P3's `locateChatImage` |
| `src/cli/embedImagesBackfill.ts` | create | CLI with `--dry-run`, `--limit`, `--retry-failed` |
| `src/mcp/similarTools.ts` | create | `similar_images` tool |
| `src/db/schema.ts` | modify (header comment; after `noteEmbeddings`, before P3's `chatImages`; type export at the end) | `noteImageEmbeddings` table |
| `drizzle/0005_note_image_embeddings.sql`, `drizzle/meta/*` | create (generated) | migration 0005 |
| `src/deps.ts` | modify (line 3, 13-14) | `imageEmbedder` field |
| `src/daemon.ts` | modify (imports, `StartDaemonOptions`, `startDaemon` deps) | build/inject image embedder |
| `src/background.ts` | modify (whole file) | start/stop image worker |
| `src/mcp/tools.ts` | modify (lines 1-22) | `ToolDeps.imageEmbedder`, `ToolDeps.chatUploads` |
| `src/mcp/server.ts` | modify (lines 4, 11-21) | register `similar_images` |
| `src/http/app.ts` | modify (imports, `mcpToolDeps`) | `mcpToolDeps` passes embedder + uploads |
| `src/chat/status.ts` | modify (lines 17-35, 48-53, 96-99) | allowlist + caption |
| `src/chat/prompt.ts` | modify (the pictures element, after P4's files sentence) | pasted images + `similar_images` sentence |
| `src/mcp/instructions.ts` | modify (after P4's `Files.` element) | "Similar images." paragraph |
| `claude/skills/n/SKILL.md` | modify (Tools paragraph, `## Images` bullets) | tool list + Images bullets |
| `README.md` | modify (MCP tools table after the `view_images` row; after "Search by meaning") | tool row + paragraph (P3's chat bar paragraph and P4's HTTP API rows / storage block are other sections) |
| `CHANGELOG.md` | modify (top) | Unreleased line |
| `package.json` | modify (scripts) | `embed:images:backfill`, `test:live:imageEmbeddings` |
| `vitest.config.ts` | modify (whole file) | live image routing |
| `tests/helpers/fakeImageEmbedder.ts` | create | deterministic colour/hash fake |
| `tests/integration/setup.ts` | modify (`truncateAll`) | truncate `note_image_embeddings` |
| `tests/integration/imageHarness.ts` | modify (`HarnessOptions`, head of `startHarness`) | `HarnessOptions.imageEmbedder` beside P3's `chat` |
| `tests/integration/helpers/api-harness.ts` | modify (line 44-50) | `imageEmbedder: null` |
| `tests/integration/connectors/mcp.int.test.ts` | modify (line 20) | `imageEmbedder: null` |
| `tests/integration/mcp.tools.int.test.ts` | modify (line 23) | `imageEmbedder: null` |
| `tests/integration/images.int.test.ts` | modify (lines 137-143, 166-172) | `imageEmbedder: null` |
| `tests/integration/related.int.test.ts` | modify (line 44) | `imageEmbedder: null` |
| `tests/integration/embeddings.worker.int.test.ts` | modify (lines 319-328) | `imageEmbedder: null` |
| `tests/integration/daemon.int.test.ts` | modify (lines 114-133) | assert `imageEmbedder` null / injected |
| `tests/live/chat.live.test.ts` | modify (the `startDaemon` line; P3's `images: []` edits elsewhere in the file stay) | `imageEmbedder: null` (keep the live chat test off the image API) |
| `tests/unit/chat-status.test.ts` | modify (lines 8-24, 32-56) | 18 tools, caption |
| `tests/unit/mcp.instructions.test.ts` | modify (append a test in `describe('buildInstructions')`) | Similar images paragraph |
| `tests/unit/chat-prompt.test.ts` | modify (append a test) | prompt sentence |
| `tests/unit/embeddings/openrouterImage.test.ts` | create | request shape, fit, errors |
| `tests/unit/embeddings/fakeImageEmbedder.test.ts` | create | fake determinism |
| `tests/unit/embeddings/imageBackfill.test.ts` | create | drain loop rules |
| `tests/unit/embeddings/imageConstants.test.ts` | create | token estimate, column width |
| `tests/unit/similarTools.test.ts` | create | `bodySnippet`, `countSources`, messages |
| `tests/integration/imageEmbeddings.repo.int.test.ts` | create | repo SQL |
| `tests/integration/imageEmbeddings.worker.int.test.ts` | create | worker, background, CLI |
| `tests/integration/similarImages.mcp.int.test.ts` | create | the tool over MCP |
| `tests/live/imageEmbeddings.live.test.ts` | create | opt-in billed probe |

## Implementation Steps

Worktree setup first (Invariant 10): `npm ci` if `node_modules` is missing; `ln -s ~/mcp-notes/.env.local .env.local` if missing (drizzle-kit's config needs it to load, even for `generate`).

### Step 1: Image embedding constants
**File:** `src/embeddings/imageConstants.ts` (new)
**Change:** constants verified 2026-10-31, plus the token/cost estimate the dry run prints.
**Code:**
```ts
/**
 * Image embedding constants (image similarity search). Separate from ./constants.ts: another
 * model, another vector space, another table (`note_image_embeddings`). Text-embedding vectors
 * (`openai/text-embedding-3-small`) and these are never compared with each other.
 *
 * Verified 2026-10-31 (OpenRouter model page and embeddings guide): `google/gemini-embedding-2`
 * on POST https://openrouter.ai/api/v1/embeddings takes input items
 * `{content: [{type: 'text', text} | {type: 'image_url', image_url: {url: 'data:image/png;base64,...'}}]}`,
 * returns 3072 floats by default, honours `dimensions` for text (Matryoshka), caps one input at
 * 8192 tokens, and costs $0.20 per million text tokens and $0.45 per million image tokens. PNG is
 * the verified image type. Its vectors are incompatible with every other model.
 *
 * pgvector's HNSW index takes at most 2000 dimensions on `vector`, so requests ask for 1536 and
 * the client keeps the first 1536 values (L2-renormalised) of any wider answer: a Matryoshka
 * prefix is a valid smaller embedding. IMAGE_EMBEDDING_DIMENSIONS must equal the `vector(1536)`
 * width of `note_image_embeddings.embedding`; tests/unit/embeddings/imageConstants.test.ts
 * asserts it. Changing the model or the width means a new migration plus
 * `npm run embed:images:backfill`.
 */
export const IMAGE_EMBEDDING_MODEL = 'google/gemini-embedding-2';
export const IMAGE_EMBEDDING_DIMENSIONS = 1536;

/** Long edge, in px, of the PNG sent for one image (bounds token cost; never enlarged). */
export const IMAGE_EMBED_LONG_EDGE = 1024;

export const IMAGE_PRICE_USD_PER_M_TOKENS = 0.45;
export const TEXT_PRICE_USD_PER_M_TOKENS = 0.2;

/**
 * Gemini's published image token rule, used only for the dry-run estimate: an image whose both
 * edges are <= 384 px costs 258 tokens; a larger one is cut into 768x768 tiles of 258 tokens each.
 * The provider's real count is on its invoice; this is an estimate and is labelled as one.
 */
export const IMAGE_TOKENS_PER_TILE = 258;
export const IMAGE_SMALL_EDGE = 384;
export const IMAGE_TILE_EDGE = 768;

/** Estimated tokens for one image of `width` x `height` after the IMAGE_EMBED_LONG_EDGE downscale. */
export function estimateImageTokens(width: number, height: number): number {
  const w = Number.isFinite(width) && width > 0 ? width : 1;
  const h = Number.isFinite(height) && height > 0 ? height : 1;
  const scale = Math.min(1, IMAGE_EMBED_LONG_EDGE / Math.max(w, h));
  const sw = Math.max(1, Math.round(w * scale));
  const sh = Math.max(1, Math.round(h * scale));
  if (sw <= IMAGE_SMALL_EDGE && sh <= IMAGE_SMALL_EDGE) return IMAGE_TOKENS_PER_TILE;
  return IMAGE_TOKENS_PER_TILE * Math.ceil(sw / IMAGE_TILE_EDGE) * Math.ceil(sh / IMAGE_TILE_EDGE);
}

/** USD for `tokens` image tokens at IMAGE_PRICE_USD_PER_M_TOKENS. */
export function estimateImageCostUsd(tokens: number): number {
  return (Math.max(0, tokens) / 1_000_000) * IMAGE_PRICE_USD_PER_M_TOKENS;
}
```
**Impact:** none (new file).

### Step 2: `ImageEmbedder` interface
**File:** `src/embeddings/imageEmbedder.ts` (new)
**Code:**
```ts
import type { EmbedOptions } from './embedder.js';

/**
 * The seam between mcp-notes and an image embedding provider. Separate from `Embedder`
 * (./embedder.ts): another model, another vector space, another table. Production uses
 * `createOpenRouterImageEmbedder` (./openrouterImage.ts); tests use
 * tests/helpers/fakeImageEmbedder.ts. A null `ImageEmbedder` everywhere means "image search
 * off" (no OPENROUTER_API_KEY): writes are unaffected, the image worker does not start,
 * `similar_images` says so.
 *
 * Every failure is an `EmbeddingError` (./embedder.ts) that never carries the API key.
 */
export interface ImageEmbedder {
  /** Model id the vectors come from; stored in note_image_embeddings.model. */
  readonly model: string;
  /** Width of every returned vector; equals the vector(n) column. */
  readonly dimensions: number;
  /**
   * One unit-length vector for one PNG (make it with ./imageInput.ts). Throws EmbeddingError,
   * without a request, when the bytes are not a PNG or are over MAX_EMBED_PNG_BYTES.
   */
  embedImage(png: Uint8Array, opts?: EmbedOptions): Promise<number[]>;
  /**
   * One unit-length vector for a text query, in the same space as embedImage ("red top in a
   * car"). Trimmed and clamped like note text (embedInput); empty throws EmbeddingError without
   * a request.
   */
  embedText(query: string, opts?: EmbedOptions): Promise<number[]>;
}
```

### Step 3: Extract the OpenRouter POST from the text embedder
**File:** `src/embeddings/openrouter.ts` (whole file; today's lines 32-34 `snippet`, 50-52 `errorName`, 127-178 `request`)
**Change:** export `snippet` and `errorName`; move the fetch / read / status / JSON-parse half of `request` into an exported `postOpenRouterEmbeddings` so the image embedder shares the exact error and timeout conventions. The text embedder sends a byte-identical body and keeps every error text, so `tests/unit/embeddings/openrouter.test.ts` passes unchanged.
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

/** The first RESPONSE_SNIPPET_CHARS of a response body, for error messages. */
export function snippet(raw: string): string {
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

/** The `name` of a thrown value (TimeoutError / AbortError tell a timeout apart). */
export function errorName(cause: unknown): unknown {
  return typeof cause === 'object' && cause !== null ? (cause as { name?: unknown }).name : undefined;
}

/**
 * One POST to OpenRouter's /embeddings with `body` as JSON. Returns the parsed JSON and the raw
 * text (for snippets). Every failure is an EmbeddingError: transport error, timeout (named with
 * `timeoutMs`), unreadable body, non-2xx (with a snippet and `{status}` as detail), non-JSON.
 * Shared by the text embedder (below) and the image embedder (./openrouterImage.ts). The key
 * only ever goes into the Authorization header.
 */
export async function postOpenRouterEmbeddings(
  fetchImpl: typeof fetch,
  apiKey: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ json: unknown; raw: string }> {
  let res: Response;
  try {
    res = await fetchImpl(OPENROUTER_EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
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
  return { json, raw };
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
    // encoding_format explicit: some providers behind the broker default to base64, which
    // would arrive as a string and fail the array check with a confusing message.
    const { json, raw } = await postOpenRouterEmbeddings(
      fetchImpl,
      apiKey,
      { model: EMBEDDING_MODEL, input: batch, encoding_format: 'float' },
      timeoutMs,
    );
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
**Impact:** none for callers. `JSON.stringify` of the same object literal yields the same body as before.

### Step 4: OpenRouter image embedder
**File:** `src/embeddings/openrouterImage.ts` (new)
**Change:** one request per image or query; vectors validated (finite), cut to the first 1536 values when wider, always L2-normalised, width asserted. `dimensions: 1536` is sent on both kinds; if the live probe (Step 26) ever shows the provider refusing `dimensions` on image input, delete that property from `imageRequestBody` only: `fitVector` already truncates a 3072-wide answer.
**Code:**
```ts
import type { EmbeddingsConfig } from '../config.js';
import { EmbeddingError, type EmbedOptions } from './embedder.js';
import { IMAGE_EMBEDDING_DIMENSIONS, IMAGE_EMBEDDING_MODEL } from './imageConstants.js';
import type { ImageEmbedder } from './imageEmbedder.js';
import { postOpenRouterEmbeddings, snippet } from './openrouter.js';
import { embedInput } from './state.js';

/** Per request: an image input is larger than a note, so the ceiling is twice the text one. */
export const OPENROUTER_IMAGE_EMBED_TIMEOUT_MS = 30_000;

/**
 * Most PNG bytes one request carries. A 1024 px PNG of a photo is ~1-2 MB; base64 adds a third.
 * Refused before any request, so a pathological PNG never reaches the provider.
 */
export const MAX_EMBED_PNG_BYTES = 8 * 1024 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** True when `bytes` start with the PNG signature and carry more than it. */
export function isPng(bytes: Uint8Array): boolean {
  if (bytes.byteLength <= PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

export type EmbeddingContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** The JSON body POSTed to /api/v1/embeddings for one image or one query. */
export interface ImageEmbeddingRequestBody {
  model: string;
  input: Array<{ content: EmbeddingContentPart[] }>;
  encoding_format: 'float';
  dimensions: number;
}

export interface OpenRouterImageEmbedderOptions {
  /** OPENROUTER_API_KEY. Never logged, never put in an error. Blank throws EmbeddingError. */
  apiKey: string;
  /** Injected by unit tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Default per-request timeout; `embedImage/embedText(.., { timeoutMs })` overrides it. */
  timeoutMs?: number;
}

export function pngDataUrl(png: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(png.buffer, png.byteOffset, png.byteLength).toString('base64')}`;
}

/** An image-only input item: a content array holding just the image_url part. */
export function imageRequestBody(png: Uint8Array): ImageEmbeddingRequestBody {
  return {
    model: IMAGE_EMBEDDING_MODEL,
    input: [{ content: [{ type: 'image_url', image_url: { url: pngDataUrl(png) } }] }],
    encoding_format: 'float',
    dimensions: IMAGE_EMBEDDING_DIMENSIONS,
  };
}

/**
 * A text-only input item: a content array holding just the text part (the multimodal item shape,
 * which the live probe confirms; it also reports whether a plain string input works).
 */
export function textRequestBody(text: string): ImageEmbeddingRequestBody {
  return {
    model: IMAGE_EMBEDDING_MODEL,
    input: [{ content: [{ type: 'text', text }] }],
    encoding_format: 'float',
    dimensions: IMAGE_EMBEDDING_DIMENSIONS,
  };
}

/**
 * The vector we store: the first `width` values (a Matryoshka prefix) of `values`, divided by
 * their L2 norm. Always normalised, so a provider-shortened vector and a client-shortened one
 * compare the same way. Throws EmbeddingError for a narrower vector, a non-finite value or a
 * zero-length prefix; the result's width is asserted.
 */
export function fitVector(values: readonly number[], width: number = IMAGE_EMBEDDING_DIMENSIONS): number[] {
  if (values.length < width) {
    throw new EmbeddingError(
      `image embedding returned ${values.length} value(s) for model ${IMAGE_EMBEDDING_MODEL}; ` +
        `note_image_embeddings.embedding is vector(${width}). The model id and ` +
        'IMAGE_EMBEDDING_DIMENSIONS must change together, in one migration, with a full re-embed ' +
        '(npm run embed:images:backfill).',
    );
  }
  const head = values.slice(0, width);
  let sumSq = 0;
  for (const x of head) {
    if (typeof x !== 'number' || !Number.isFinite(x)) {
      throw new EmbeddingError(`image embedding returned a non-finite value for model ${IMAGE_EMBEDDING_MODEL}`);
    }
    sumSq += x * x;
  }
  const norm = Math.sqrt(sumSq);
  if (!(norm > 0) || !Number.isFinite(norm)) {
    throw new EmbeddingError(`image embedding from ${IMAGE_EMBEDDING_MODEL} has zero length; there is nothing to compare`);
  }
  const out = head.map((x) => x / norm);
  if (out.length !== width) {
    throw new EmbeddingError(`image embedding has ${out.length} dimensions after fitting, expected ${width}`);
  }
  return out;
}

/** `data` must hold exactly one vector (index 0 or absent). */
function parseOne(json: unknown, raw: string): number[] {
  const data =
    typeof json === 'object' && json !== null ? (json as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) {
    throw new EmbeddingError(`image embedding response carried no data array: ${snippet(raw)}`);
  }
  if (data.length !== 1) {
    throw new EmbeddingError(`image embedding response has ${data.length} vector(s) for 1 input: ${snippet(raw)}`);
  }
  const first: unknown = data[0];
  const entry =
    typeof first === 'object' && first !== null ? (first as { index?: unknown; embedding?: unknown }) : {};
  if (entry.index !== undefined && entry.index !== 0) {
    throw new EmbeddingError(
      `image embedding response has a bad index ${String(entry.index)} at data[0]: ${snippet(raw)}`,
    );
  }
  const embedding = entry.embedding;
  if (!Array.isArray(embedding)) {
    throw new EmbeddingError(`image embedding response carried no vector at data[0].embedding: ${snippet(raw)}`);
  }
  if (!embedding.every((n: unknown) => typeof n === 'number' && Number.isFinite(n))) {
    throw new EmbeddingError(`image embedding returned a non-finite value for model ${IMAGE_EMBEDDING_MODEL}`);
  }
  return fitVector(embedding as number[], IMAGE_EMBEDDING_DIMENSIONS);
}

/**
 * Gemini Embedding 2 through OpenRouter: one `fetch` per image or query, no SDK. Construction
 * never touches the network; a blank key throws here.
 */
export function createOpenRouterImageEmbedder(opts: OpenRouterImageEmbedderOptions): ImageEmbedder {
  const apiKey = opts.apiKey.trim();
  if (apiKey === '') {
    throw new EmbeddingError('image embeddings are not configured (OPENROUTER_API_KEY is empty)');
  }
  const fetchImpl: typeof fetch = opts.fetch ?? fetch;
  const defaultTimeoutMs = opts.timeoutMs ?? OPENROUTER_IMAGE_EMBED_TIMEOUT_MS;

  async function send(body: ImageEmbeddingRequestBody, timeoutMs: number): Promise<number[]> {
    const { json, raw } = await postOpenRouterEmbeddings(fetchImpl, apiKey, body, timeoutMs);
    return parseOne(json, raw);
  }

  return {
    model: IMAGE_EMBEDDING_MODEL,
    dimensions: IMAGE_EMBEDDING_DIMENSIONS,
    async embedImage(png: Uint8Array, callOpts: EmbedOptions = {}): Promise<number[]> {
      if (!isPng(png)) {
        throw new EmbeddingError('image embedding needs PNG bytes (re-encode with toEmbeddingPng first)');
      }
      if (png.byteLength > MAX_EMBED_PNG_BYTES) {
        throw new EmbeddingError(
          `image embedding input is ${png.byteLength} bytes, over the ${MAX_EMBED_PNG_BYTES}-byte cap`,
        );
      }
      return send(imageRequestBody(png), callOpts.timeoutMs ?? defaultTimeoutMs);
    },
    async embedText(query: string, callOpts: EmbedOptions = {}): Promise<number[]> {
      const text = embedInput(query);
      if (text === null) throw new EmbeddingError('image search query is empty');
      return send(textRequestBody(text), callOpts.timeoutMs ?? defaultTimeoutMs);
    },
  };
}

/** The daemon's and the CLI's way to get one: null without a key (image search off). */
export function imageEmbedderFromConfig(
  config: EmbeddingsConfig,
  opts: { fetch?: typeof fetch } = {},
): ImageEmbedder | null {
  if (config.apiKey === null) return null;
  return createOpenRouterImageEmbedder({ apiKey: config.apiKey, fetch: opts.fetch });
}
```

### Step 5: What bytes are sent
**File:** `src/embeddings/imageInput.ts` (new)
**Code:**
```ts
import sharp from 'sharp';
import { getPreview, type ImageSource } from '../images/derive.js';
import { IMAGE_EMBED_LONG_EDGE } from './imageConstants.js';

/**
 * The PNG an image is embedded from: EXIF-rotated, long edge <= IMAGE_EMBED_LONG_EDGE (never
 * enlarged), alpha flattened onto white. `input` is a file path or the encoded bytes of any
 * format sharp decodes (JPEG, PNG, WebP, GIF, AVIF, TIFF).
 */
export async function toEmbeddingPng(input: string | Uint8Array): Promise<Buffer> {
  const source = typeof input === 'string' ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  return sharp(source, { failOn: 'none' })
    .rotate()
    .resize({ width: IMAGE_EMBED_LONG_EDGE, height: IMAGE_EMBED_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();
}

/**
 * The PNG for a note image: its `preview` derivative (cache/<id>/preview.jpg, generated on first
 * use; already decoded from HEIC/TIFF, rotated and flattened) re-encoded by toEmbeddingPng.
 * Throws OriginalMissingError (src/images/derive.ts) when the original is not on this machine.
 */
export async function notePngForEmbedding(dataDir: string, src: ImageSource): Promise<Buffer> {
  const preview = await getPreview(dataDir, src);
  return toEmbeddingPng(preview);
}
```

### Step 6: Schema `note_image_embeddings`
**File:** `src/db/schema.ts`
**Change (a), header comment:** replace the whole header comment as Phase 4 left it with (Phase 3's and Phase 4's sentences kept, the 0005 sentence added before "Change a table here"):
```ts
/**
 * The notes schema. Migration 0000 (drizzle/0000_init.sql, iterations 1-3) created `notes` and
 * `note_revisions`; migration 0001 (iteration 6, semantic search) adds the pgvector extension and
 * `note_embeddings`; migration 0002 (iteration 7, wall editing) adds `note_images` and copies every
 * legacy `notes.image_path` / `image_meta` image into it (hand-appended INSERT...SELECT, the same
 * SQL as src/images/legacy.ts `LEGACY_COPY_SQL`); migration 0003 (chat images) adds
 * `chat_images`, the images pasted into a chat; migration 0004 (note files) adds `note_files`:
 * non-image files attached to a note, stored under `files/<noteId>/<safeName>`, with
 * `extracted_text` / `extraction_status` ready for a later text extraction (v1 writes only
 * 'none'); migration 0005 (image similarity search) adds `note_image_embeddings`. Change a table
 * here, then `npm run db:generate`; never edit an applied migration. drizzle-kit does not emit
 * `CREATE EXTENSION`, so 0001 carries a hand-prepended `CREATE EXTENSION IF NOT EXISTS vector`.
 */
```
The pg-core import already has every builder this table uses (`index`, `integer`, `text`, `timestamp`, `vector`; Phase 3 added `check`), so it does not change.
**Change (b):** insert this block directly after the `noteEmbeddings` table and before Phase 3's `ChatImageSource` / `chatImages` block (Phase 4's `noteFiles` sits after `noteImages`, further up). The file has no semicolons; keep that style.
**Code:**
```ts
/**
 * One row per note image that has (or had) an image embedding. Image similarity search,
 * migration 0005. A side table like `note_embeddings`, so no image listing drags 1536 floats.
 * Model `google/gemini-embedding-2`, a vector space separate from `note_embeddings`.
 *
 * The vector is *current* iff `embedding is not null`, `image_sha256` equals the image's
 * `note_images.sha256` and `model` equals IMAGE_EMBEDDING_MODEL (src/embeddings/imageRepo.ts).
 * Removed images and images of deleted notes keep their row, so a restore needs no call.
 * Width = IMAGE_EMBEDDING_DIMENSIONS (a unit test asserts it).
 */
export const noteImageEmbeddings = pgTable(
  'note_image_embeddings',
  {
    imageId: text('image_id')
      .primaryKey()
      .references(() => noteImages.id, { onDelete: 'cascade' }),
    /** Null while the latest attempt for `image_sha256` failed. */
    embedding: vector('embedding', { dimensions: 1536 }),
    /** `note_images.sha256` of the bytes this row refers to (embedded, or whose embedding failed). */
    imageSha256: text('image_sha256').notNull(),
    /** Model id the vector came from, e.g. `google/gemini-embedding-2`. */
    model: text('model').notNull(),
    /** Consecutive failures for this `image_sha256` + `model`; 0 after a success. */
    attempts: integer('attempts').notNull().default(0),
    /** At most 500 chars, keys redacted (src/embeddings/state.ts `clampError`). */
    lastError: text('last_error'),
    /** Failures only: not retried before this time. */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'date' }),
    /** When `embedding` was written. Null on a failure row. */
    embeddedAt: timestamp('embedded_at', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('note_image_embeddings_embedding_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('note_image_embeddings_next_attempt_idx').on(t.nextAttemptAt),
  ],
)
```
**Change (c), type exports:** append at the end of the file, after Phase 3's `NewChatImageRow`:
```ts
export type NoteImageEmbeddingRow = typeof noteImageEmbeddings.$inferSelect
```

### Step 7: Generate migration 0005
**Command:** `npm run db:generate -- --name note_image_embeddings`
**Expected file** `drizzle/0005_note_image_embeddings.sql` (generated; do not hand-edit; the vector extension already exists from 0001):
```sql
CREATE TABLE "note_image_embeddings" (
	"image_id" text PRIMARY KEY NOT NULL,
	"embedding" vector(1536),
	"image_sha256" text NOT NULL,
	"model" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"embedded_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "note_image_embeddings" ADD CONSTRAINT "note_image_embeddings_image_id_note_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."note_images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_image_embeddings_embedding_hnsw_idx" ON "note_image_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "note_image_embeddings_next_attempt_idx" ON "note_image_embeddings" USING btree ("next_attempt_at");
```
If the generated file contains anything else (a change to a P3/P4 table), stop: the P3/P4 schema and their snapshots disagree, and that must be fixed in those phases' migrations, not here. Then `npm run db:check`.

### Step 8: Image embedding repo
**File:** `src/embeddings/imageRepo.ts` (new)
**Code:**
```ts
import { sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import type { Executor } from '../notes/repo.js';
import { IMAGE_EMBEDDING_DIMENSIONS } from './imageConstants.js';
import { toVectorLiteral } from './repo.js';
import { clampError, retryDelayMs } from './state.js';

/**
 * Queries on `note_image_embeddings`. Plain SQL with full table names (no aliases, no Drizzle
 * column interpolation). The vector column is selected only by `nearestImages` for ranking and
 * never leaves this file.
 */

export interface PendingImage {
  id: string;
  noteId: string;
  /** Data-dir-relative original path (`images/YYYY/MM/<id>.<ext>`). */
  path: string;
  mime: string;
  /** `note_images.sha256` as read; pass it back to save / failure unchanged. */
  sha256: string;
  width: number;
  height: number;
  host: string | null;
  /** The image is part of its note and the note is not deleted. */
  live: boolean;
}

/** True when the joined row holds a vector for the image's current bytes from `model`. */
function isCurrentImageEmbeddingSql(model: string): SQL {
  return sql`(note_image_embeddings.embedding is not null and note_image_embeddings.model = ${model} and note_image_embeddings.image_sha256 = note_images.sha256)`;
}

/** `and not (id in ids)`, bound as one jsonb parameter however many ids there are. */
function excludeIdsSql(ids: readonly string[] | undefined): SQL {
  if (ids === undefined || ids.length === 0) return sql``;
  return sql`and not (note_images.id = any(array(select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))))`;
}

// Type aliases, not interfaces: db.execute<T> needs T assignable to Record<string, unknown>.
type PendingRow = {
  id: string;
  note_id: string;
  path: string;
  mime: string;
  sha256: string;
  width: number;
  height: number;
  host: string | null;
  live: boolean;
};

/**
 * Images that need an embedding: every image (live, removed, or in a deleted note, so a restore
 * never needs a call) whose row is missing, from another model, for other bytes, or failed and
 * due (`next_attempt_at <= now()`; `ignoreBackoff` makes every failure due). `excludeIds` are
 * left out (the drain loop's settled set). Live images of live notes first, then newest, then id.
 */
export async function listPendingImages(
  db: Executor,
  opts: { model: string; limit: number; ignoreBackoff?: boolean; excludeIds?: readonly string[] },
): Promise<PendingImage[]> {
  const limit = Math.max(1, Math.trunc(opts.limit));
  const due = opts.ignoreBackoff
    ? sql`true`
    : sql`(note_image_embeddings.next_attempt_at is null or note_image_embeddings.next_attempt_at <= now())`;
  const res = await db.execute<PendingRow>(sql`
    select note_images.id, note_images.note_id, note_images.path, note_images.mime, note_images.sha256,
           note_images.width, note_images.height, note_images.host,
           (note_images.deleted_at is null and notes.deleted_at is null) as live
    from note_images
    join notes on notes.id = note_images.note_id
    left join note_image_embeddings on note_image_embeddings.image_id = note_images.id
    where (
      note_image_embeddings.image_id is null
      or note_image_embeddings.model <> ${opts.model}
      or note_image_embeddings.image_sha256 <> note_images.sha256
      or (note_image_embeddings.embedding is null and ${due})
    )
    ${excludeIdsSql(opts.excludeIds)}
    order by (note_images.deleted_at is null and notes.deleted_at is null) desc,
             note_images.created_at desc,
             note_images.id asc
    limit ${limit}
  `);
  return res.rows.map((r) => ({
    id: r.id,
    noteId: r.note_id,
    path: r.path,
    mime: r.mime,
    sha256: r.sha256,
    width: Number(r.width),
    height: Number(r.height),
    host: r.host,
    live: r.live === true,
  }));
}

/**
 * Stores a vector for `imageId`, but only while the image's bytes still hash to `imageSha256`.
 * Resets attempts, last_error and next_attempt_at. Returns false when skipped (image gone or
 * other bytes). Idempotent: two daemons saving the same vector leave the same row.
 */
export async function saveImageEmbedding(
  db: Executor,
  v: { imageId: string; imageSha256: string; model: string; embedding: number[] },
): Promise<boolean> {
  if (v.embedding.length !== IMAGE_EMBEDDING_DIMENSIONS) {
    throw new Error(`image embedding has ${v.embedding.length} dimensions, expected ${IMAGE_EMBEDDING_DIMENSIONS}`);
  }
  const literal = toVectorLiteral(v.embedding);
  const res = await db.execute<{ image_id: string }>(sql`
    insert into note_image_embeddings
      (image_id, embedding, image_sha256, model, attempts, last_error, next_attempt_at, embedded_at, updated_at)
    select note_images.id, ${literal}::vector, ${v.imageSha256}, ${v.model}, 0, null, null, now(), now()
    from note_images
    where note_images.id = ${v.imageId} and note_images.sha256 = ${v.imageSha256}
    on conflict (image_id) do update set
      embedding = excluded.embedding,
      image_sha256 = excluded.image_sha256,
      model = excluded.model,
      attempts = 0,
      last_error = null,
      next_attempt_at = null,
      embedded_at = excluded.embedded_at,
      updated_at = excluded.updated_at
    returning image_id
  `);
  return res.rows.length > 0;
}

/**
 * Records a failed attempt: embedding := NULL, attempts := previous + 1 when the previous row was
 * already a failure for these bytes and model, else 1; next_attempt_at := now() +
 * retryDelayMs(attempts); last_error := clampError(error). No-op when the image is gone, holds
 * other bytes, or already has a vector for these bytes and model (another daemon succeeded).
 */
export async function recordImageFailure(
  db: Executor,
  v: { imageId: string; imageSha256: string; model: string; error: string },
): Promise<void> {
  const prev = await db.execute<{ image_sha256: string; model: string; attempts: number; has_vector: boolean }>(sql`
    select image_sha256, model, attempts, embedding is not null as has_vector
    from note_image_embeddings
    where image_id = ${v.imageId}
  `);
  const row = prev.rows[0];
  const sameTarget = row !== undefined && row.image_sha256 === v.imageSha256 && row.model === v.model;
  if (sameTarget && row.has_vector) return;
  const attempts = sameTarget ? Number(row.attempts) + 1 : 1;
  const delayMs = retryDelayMs(attempts);
  await db.execute(sql`
    insert into note_image_embeddings
      (image_id, embedding, image_sha256, model, attempts, last_error, next_attempt_at, embedded_at, updated_at)
    select note_images.id, null, ${v.imageSha256}, ${v.model}, ${attempts}::integer, ${clampError(v.error)},
           now() + ${delayMs}::integer * interval '1 millisecond', null, now()
    from note_images
    where note_images.id = ${v.imageId} and note_images.sha256 = ${v.imageSha256}
    on conflict (image_id) do update set
      embedding = null,
      image_sha256 = excluded.image_sha256,
      model = excluded.model,
      attempts = excluded.attempts,
      last_error = excluded.last_error,
      next_attempt_at = excluded.next_attempt_at,
      embedded_at = null,
      updated_at = excluded.updated_at
    where not (
      note_image_embeddings.embedding is not null
      and note_image_embeddings.image_sha256 = excluded.image_sha256
      and note_image_embeddings.model = excluded.model
    )
  `);
}

/** Counts over every image (live, removed, in deleted notes), matching listPendingImages' universe. */
export interface ImageEmbeddingStats {
  images: number;
  /** Images with a current vector for `model`. */
  current: number;
  /** `images - current`: missing, stale or failed (due or not). */
  pending: number;
  /** Of the pending, images whose last attempt for these bytes and model failed. */
  failing: number;
}

export async function imageEmbeddingStats(db: Executor, model: string): Promise<ImageEmbeddingStats> {
  const res = await db.execute<{ images: number; current: number; failing: number }>(sql`
    select
      count(*)::int as images,
      count(*) filter (where coalesce(${isCurrentImageEmbeddingSql(model)}, false))::int as current,
      count(*) filter (
        where note_image_embeddings.embedding is null
          and note_image_embeddings.image_sha256 = note_images.sha256
          and note_image_embeddings.model = ${model}
      )::int as failing
    from note_images
    left join note_image_embeddings on note_image_embeddings.image_id = note_images.id
  `);
  const r = res.rows[0];
  const images = Number(r?.images ?? 0);
  const current = Number(r?.current ?? 0);
  return { images, current, pending: images - current, failing: Number(r?.failing ?? 0) };
}

/** An existing image (its stored vector) or a raw vector (an upload or a text query). */
export type NearestImageSource = { imageId: string } | { vector: readonly number[] };

export interface NearestImage {
  imageId: string;
  noteId: string;
  /** Cosine distance (pgvector `<=>`): 0 = same direction, 2 = opposite. */
  distance: number;
  /** 1 - distance, rounded to 4 decimals (the `related` convention). */
  similarity: number;
}

function roundSimilarity(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

type NearestRow = { image_id: string; note_id: string; distance: number };

/**
 * Live images of live notes nearest to `source`, closest first. Candidates use only current
 * vectors for `model`. An image source is never returned itself.
 *
 * Returns null when an image source has no current vector for `model` (no row, failed, other
 * bytes or other model), so the caller can embed it and ask again. A vector source never
 * returns null.
 *
 * `ORDER BY embedding <=> (source) LIMIT n` is what the HNSW cosine index serves; iterative scan
 * (pgvector >= 0.8) keeps walking past rows the WHERE clause drops (removed, deleted, stale,
 * self), so `limit` rows come back whenever that many exist.
 */
export async function nearestImages(
  db: Db,
  opts: { source: NearestImageSource; model: string; limit: number },
): Promise<NearestImage[] | null> {
  const limit = Math.max(1, Math.trunc(opts.limit));
  return db.transaction(async (tx) => {
    let target: SQL;
    let exclude: SQL = sql``;
    if ('imageId' in opts.source) {
      const id = opts.source.imageId;
      const src = await tx.execute<{ ok: number }>(sql`
        select 1 as ok
        from note_image_embeddings
        join note_images on note_images.id = note_image_embeddings.image_id
        where note_image_embeddings.image_id = ${id} and ${isCurrentImageEmbeddingSql(opts.model)}
        limit 1
      `);
      if (src.rows.length === 0) return null;
      target = sql`(select src.embedding from note_image_embeddings as src where src.image_id = ${id})`;
      exclude = sql`and note_images.id <> ${id}`;
    } else {
      if (opts.source.vector.length !== IMAGE_EMBEDDING_DIMENSIONS) {
        throw new Error(
          `query vector has ${opts.source.vector.length} dimensions, expected ${IMAGE_EMBEDDING_DIMENSIONS}`,
        );
      }
      target = sql`${toVectorLiteral(opts.source.vector)}::vector`;
    }

    await tx.execute(sql`set local hnsw.iterative_scan = strict_order`);

    const res = await tx.execute<NearestRow>(sql`
      select note_images.id as image_id, note_images.note_id,
             (note_image_embeddings.embedding <=> ${target}) as distance
      from note_image_embeddings
      join note_images on note_images.id = note_image_embeddings.image_id
      join notes on notes.id = note_images.note_id
      where note_images.deleted_at is null
        and notes.deleted_at is null
        and ${isCurrentImageEmbeddingSql(opts.model)}
        ${exclude}
      order by note_image_embeddings.embedding <=> ${target}
      limit ${limit}
    `);
    return res.rows.map((r) => {
      const distance = Number(r.distance);
      return { imageId: r.image_id, noteId: r.note_id, distance, similarity: roundSimilarity(1 - distance) };
    });
  });
}
```

### Step 9: Drain loop (backfill) with an image store
**File:** `src/embeddings/imageBackfill.ts` (new)
**Change:** parallel implementation of `runBackfill` for images: one image per call, shared `RateLimiter`/`Clock`, a per-run settled set that is excluded in SQL (so unavailable rows never hide local work), and an optional cross-run `UnavailableImages` memo so a 60 s sweep does not re-scan the other laptop's images each time. An image whose original is missing is never recorded as a failure.
**Code:**
```ts
import type { Db } from '../db/client.js';
import { OriginalMissingError } from '../images/derive.js';
import { fileExists, resolveInDataDir } from '../images/store.js';
import { DEFAULT_MIN_INTERVAL_MS, RateLimiter, errorMessage, realClock, type Clock } from './backfill.js';
import type { ImageEmbedder } from './imageEmbedder.js';
import { notePngForEmbedding } from './imageInput.js';
import { listPendingImages, recordImageFailure, saveImageEmbedding, type PendingImage } from './imageRepo.js';

/** Pending rows read per query. */
export const DEFAULT_IMAGE_PAGE_SIZE = 32;
/** An image found missing on this machine is not looked at again for this long (worker memo). */
export const DEFAULT_UNAVAILABLE_RECHECK_MS = 60 * 60_000;

/** What the drain loop needs. `dbImageEmbeddingStore` is the real one; unit tests use a memory one. */
export interface ImageEmbeddingStore {
  listPending(opts: {
    model: string;
    limit: number;
    ignoreBackoff?: boolean;
    excludeIds: readonly string[];
  }): Promise<PendingImage[]>;
  /** True when the image's original is on this machine. */
  isAvailable(image: PendingImage): Promise<boolean>;
  /** The PNG to send. Throws OriginalMissingError when the original vanished after isAvailable. */
  loadPng(image: PendingImage): Promise<Uint8Array>;
  save(v: { imageId: string; imageSha256: string; model: string; embedding: number[] }): Promise<boolean>;
  recordFailure(v: { imageId: string; imageSha256: string; model: string; error: string }): Promise<void>;
}

export function dbImageEmbeddingStore(db: Db, dataDir: string): ImageEmbeddingStore {
  const originalOf = (image: PendingImage): string | null => {
    try {
      return resolveInDataDir(dataDir, image.path);
    } catch {
      return null;
    }
  };
  return {
    listPending: (opts) => listPendingImages(db, opts),
    async isAvailable(image) {
      const p = originalOf(image);
      return p !== null && (await fileExists(p));
    },
    async loadPng(image) {
      const p = originalOf(image);
      if (p === null) throw new OriginalMissingError(image.id, image.path);
      return notePngForEmbedding(dataDir, { id: image.id, mime: image.mime, originalPath: p });
    },
    save: (v) => saveImageEmbedding(db, v),
    recordFailure: (v) => recordImageFailure(db, v),
  };
}

/** Image ids whose original was missing here, each remembered until `recheckMs` has passed. */
export class UnavailableImages {
  private readonly until = new Map<string, number>();
  private readonly recheckMs: number;
  private readonly clock: Clock;

  constructor(recheckMs: number = DEFAULT_UNAVAILABLE_RECHECK_MS, clock: Clock = realClock) {
    this.recheckMs = Math.max(0, recheckMs);
    this.clock = clock;
  }

  add(id: string): void {
    this.until.set(id, this.clock.now() + this.recheckMs);
  }

  /** Ids still remembered; expired ones are dropped (and so looked at again). */
  ids(): string[] {
    const now = this.clock.now();
    const out: string[] = [];
    for (const [id, until] of this.until) {
      if (until > now) out.push(id);
      else this.until.delete(id);
    }
    return out;
  }
}

export type ImageOutcome = 'embedded' | 'failed' | 'skipped' | 'unavailable';

export interface ImageReport {
  imageId: string;
  outcome: ImageOutcome;
  /** Set when outcome is 'failed'. */
  error?: string;
  ms: number;
}

export interface ImageBackfillProgress {
  /** Embedding calls made. */
  calls: number;
  embedded: number;
  /** Images whose call (or PNG preparation) failed; each got recordFailure. */
  failed: number;
  /** Vectors not saved because the image's bytes changed or it was purged during the call. */
  skipped: number;
  /** Images whose original is not on this machine: left pending, no failure recorded. */
  unavailable: number;
}

export interface ImageBackfillResult extends ImageBackfillProgress {
  /** The signal stopped the run before the queue was empty. */
  aborted: boolean;
  /** maxImages was reached while images were still pending. */
  limited: boolean;
}

export interface ImageBackfillOptions {
  store: ImageEmbeddingStore;
  embedder: ImageEmbedder;
  /** Shared limiter (the worker passes its own so the gap holds across drains). */
  limiter?: RateLimiter;
  /** Used only when `limiter` is not given. */
  minIntervalMs?: number;
  /** Also take failed images whose next_attempt_at is in the future (`--retry-failed`). */
  ignoreBackoff?: boolean;
  /** Checked before every image and before every call; an in-flight call is finished and saved. */
  signal?: AbortSignal;
  clock?: Clock;
  /** Stop after this many embedded + failed + skipped images (`--limit`). */
  maxImages?: number;
  pageSize?: number;
  /** Cross-run memo of missing originals (the worker's). Seeds this run's exclusions. */
  unavailable?: UnavailableImages;
  /** After every image, with its outcome. */
  onImage?: (report: ImageReport) => void;
  /** After every image, with running totals. */
  onProgress?: (progress: ImageBackfillProgress) => void;
}

/**
 * Embeds pending images until none is left on this machine (or the signal aborts, or maxImages
 * is reached). Each image is offered at most once per run; images listed but not on this machine
 * are settled without a failure, and the settled set is excluded in SQL, so a long tail of the
 * other laptop's images never hides a local one. Store errors (database down) reject; embedding
 * and PNG errors never do.
 */
export async function runImageBackfill(opts: ImageBackfillOptions): Promise<ImageBackfillResult> {
  const clock = opts.clock ?? realClock;
  const limiter = opts.limiter ?? new RateLimiter(opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS, clock);
  const pageSize = Math.max(1, Math.floor(opts.pageSize ?? DEFAULT_IMAGE_PAGE_SIZE));
  const maxImages =
    opts.maxImages === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(opts.maxImages));
  const model = opts.embedder.model;
  const settled = new Set<string>(opts.unavailable?.ids() ?? []);
  const totals: ImageBackfillProgress = { calls: 0, embedded: 0, failed: 0, skipped: 0, unavailable: 0 };
  // A function, not the property: TS would narrow `aborted` to false across the awaits.
  const aborted = (): boolean => opts.signal?.aborted === true;
  let limited = false;

  const report = (r: ImageReport): void => {
    opts.onImage?.(r);
    opts.onProgress?.({ ...totals });
  };

  const markUnavailable = (image: PendingImage): void => {
    totals.unavailable += 1;
    opts.unavailable?.add(image.id);
    report({ imageId: image.id, outcome: 'unavailable', ms: 0 });
  };

  const fail = async (image: PendingImage, error: string, started: number): Promise<void> => {
    await opts.store.recordFailure({ imageId: image.id, imageSha256: image.sha256, model, error });
    totals.failed += 1;
    report({ imageId: image.id, outcome: 'failed', error, ms: clock.now() - started });
  };

  drain: while (!aborted()) {
    const page = await opts.store.listPending({
      model,
      limit: pageSize,
      ignoreBackoff: opts.ignoreBackoff === true,
      excludeIds: [...settled],
    });
    let fresh = 0;
    for (const image of page) {
      if (aborted()) break drain;
      if (settled.has(image.id)) continue;
      if (totals.embedded + totals.failed + totals.skipped >= maxImages) {
        limited = true;
        break drain;
      }
      fresh += 1;
      settled.add(image.id);
      const started = clock.now();

      if (!(await opts.store.isAvailable(image))) {
        markUnavailable(image);
        continue;
      }

      let png: Uint8Array;
      try {
        png = await opts.store.loadPng(image);
      } catch (err) {
        if (err instanceof OriginalMissingError) {
          markUnavailable(image);
          continue;
        }
        await fail(image, `could not prepare the image: ${errorMessage(err)}`, started);
        continue;
      }

      // Aborted while waiting for a slot: the image stays pending for the next run.
      if (!(await limiter.acquire(opts.signal))) break drain;
      totals.calls += 1;
      let vector: number[];
      try {
        vector = await opts.embedder.embedImage(png);
      } catch (err) {
        await fail(image, errorMessage(err), started);
        continue;
      }
      const saved = await opts.store.save({ imageId: image.id, imageSha256: image.sha256, model, embedding: vector });
      if (saved) totals.embedded += 1;
      else totals.skipped += 1;
      report({ imageId: image.id, outcome: saved ? 'embedded' : 'skipped', ms: clock.now() - started });
    }
    // Nothing new on this page (empty, or a store that ignored excludeIds): done.
    if (fresh === 0) break;
  }
  return { ...totals, aborted: aborted(), limited };
}
```
**Impact:** none on the text path; `backfill.ts` is imported, not changed.

### Step 10: Image worker
**File:** `src/embeddings/imageWorker.ts` (new)
**Change:** same lifecycle as `startEmbeddingWorker` (debounced kick on `created`/`updated`, 60 s sweep, bounded close), one summary log line per drain that made a call or failed.
**Code:**
```ts
import type { NoteEvents } from '../notes/events.js';
import { DEFAULT_MIN_INTERVAL_MS, RateLimiter, errorMessage, realClock, type Clock } from './backfill.js';
import {
  DEFAULT_UNAVAILABLE_RECHECK_MS,
  UnavailableImages,
  runImageBackfill,
  type ImageBackfillResult,
  type ImageEmbeddingStore,
} from './imageBackfill.js';
import type { ImageEmbedder } from './imageEmbedder.js';
import { DEFAULT_CLOSE_GRACE_MS, DEFAULT_DEBOUNCE_MS, DEFAULT_SWEEP_MS, type EmbeddingWorker } from './worker.js';

/** Error text in a log line is cut here; the full (<= 500 char) text is in note_image_embeddings.last_error. */
const LOG_ERROR_CHARS = 200;

export interface ImageEmbeddingWorkerOptions {
  store: ImageEmbeddingStore;
  events: NoteEvents;
  embedder: ImageEmbedder;
  minIntervalMs?: number;
  sweepMs?: number;
  debounceMs?: number;
  /** How long close() waits for an in-flight call. Default DEFAULT_CLOSE_GRACE_MS. */
  closeGraceMs?: number;
  /** How long a missing original is not looked at again. Default DEFAULT_UNAVAILABLE_RECHECK_MS. */
  unavailableRecheckMs?: number;
  clock?: Clock;
  /** One line per drain that made a call or recorded a failure, and per failed drain. Default console.log. */
  log?: (line: string) => void;
}

export interface ImageDrainSummary extends ImageBackfillResult {
  ms: number;
  firstFailure: { id: string; error: string } | null;
}

/** e.g. `[notesd] image embeddings: 3 embedded, 1 failed (A-B32: ...), 40 not on this machine, 4 calls, 5210ms` */
export function formatImageDrain(s: ImageDrainSummary): string {
  const parts = [`[notesd] image embeddings: ${s.embedded} embedded`];
  if (s.skipped > 0) parts.push(`${s.skipped} changed meanwhile`);
  if (s.failed > 0) {
    const detail = s.firstFailure === null ? '' : ` (${s.firstFailure.id}: ${s.firstFailure.error.slice(0, LOG_ERROR_CHARS)})`;
    parts.push(`${s.failed} failed${detail}`);
  }
  if (s.unavailable > 0) parts.push(`${s.unavailable} not on this machine`);
  parts.push(`${s.calls} call${s.calls === 1 ? '' : 's'}, ${s.ms}ms`);
  return parts.join(', ');
}

export function startImageEmbeddingWorker(opts: ImageEmbeddingWorkerOptions): EmbeddingWorker {
  const log = opts.log ?? ((line: string) => console.log(line));
  const clock = opts.clock ?? realClock;
  const limiter = new RateLimiter(opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS, clock);
  const unavailable = new UnavailableImages(opts.unavailableRecheckMs ?? DEFAULT_UNAVAILABLE_RECHECK_MS, clock);
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const closeGraceMs = opts.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
  const abort = new AbortController();
  let closed = false;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let again = false;

  const drainOnce = async (): Promise<void> => {
    const started = clock.now();
    const failures: Array<{ id: string; error: string }> = [];
    try {
      const result = await runImageBackfill({
        store: opts.store,
        embedder: opts.embedder,
        limiter,
        clock,
        signal: abort.signal,
        unavailable,
        onImage: (r) => {
          if (r.outcome === 'failed') failures.push({ id: r.imageId, error: r.error ?? '' });
        },
      });
      if (result.calls > 0 || result.failed > 0) {
        log(formatImageDrain({ ...result, ms: clock.now() - started, firstFailure: failures[0] ?? null }));
      }
    } catch (err) {
      log(`[notesd] image embeddings: drain failed: ${errorMessage(err).slice(0, LOG_ERROR_CHARS)}`);
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
  // Creating an image note emits `created`; attaching an image emits `updated` on its note.
  const unsubscribe = opts.events.on((event) => {
    if (event.op === 'created' || event.op === 'updated') kick();
  });
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
      // Bounded, as for note embeddings: a call still in flight after the grace is abandoned and
      // its image stays pending for the next start.
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

### Step 11: `upload_id` adapter over P3's chat image store
**File:** `src/embeddings/chatUploads.ts` (new)
**Change:** a thin wrapper over Phase 3's `locateChatImage` (`src/chat/images.ts`), which normalizes the id (any case, dash optional), reads the `chat_images` row and resolves its data-dir-relative `path` with `resolveInDataDir`. No SQL of its own.
**Code:**
```ts
import { locateChatImage } from '../chat/images.js';
import type { Db } from '../db/client.js';

/** A chat upload (an image pasted into the chat bar) as `similar_images` reads it. */
export interface ChatUploadFile {
  /** Canonical upload id (A-B32 form, in its own table). */
  id: string;
  /** Absolute path of the stored original under this machine's data dir (may be absent here). */
  absPath: string;
}

/** Looks up an upload id (any case, dash optional). Null when unknown. Never throws for a bad id. */
export type ChatUploadSource = (uploadId: string) => Promise<ChatUploadFile | null>;

/** The daemon's source: phase 3's chat image store (`chat_images`). Lazy: nothing is read until it is called. */
export function dbChatUploadSource(db: Db, dataDir: string): ChatUploadSource {
  return async (input: string): Promise<ChatUploadFile | null> => {
    const loc = await locateChatImage({ db, dataDir }, input);
    if (loc === null) return null;
    return { id: loc.row.id, absPath: loc.source.originalPath };
  };
}
```
**Impact:** none until `mcpToolDeps` uses it (Step 18). `locateChatImage` returns null for a malformed or unknown id, so the "never throws for a bad id" contract holds. The `similar_images` handler still checks `fileExists(absPath)` itself (an upload pasted on the other laptop).

### Step 12: `AppDeps.imageEmbedder`
**File:** `src/deps.ts` (whole file; Phases 3 and 4 add no `AppDeps` field, so this is the file as of today plus `imageEmbedder`. Phase 7 later adds `chat`.)
**Code:**
```ts
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { Embedder } from './embeddings/embedder.js';
import type { ImageEmbedder } from './embeddings/imageEmbedder.js';
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
  /** Gemini image embedder for `similar_images` and the image worker. Null: image search off. */
  imageEmbedder: ImageEmbedder | null;
}
```

### Step 13: Daemon builds or receives the image embedder
**File:** `src/daemon.ts`
**Change (a), imports:** add next to the existing embeddings imports (`./embeddings/embedder.js`, `./embeddings/openrouter.js`; Phase 3 added only `CHAT_IMAGES_SUBDIR` from `./chat/images.js`, Phase 4 nothing):
```ts
import type { ImageEmbedder } from './embeddings/imageEmbedder.js';
import { imageEmbedderFromConfig } from './embeddings/openrouterImage.js';
```
**Change (b), `StartDaemonOptions` (unchanged by Phases 3 and 4):** replace with
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
  /**
   * The image embedder for the image worker and `similar_images`. Omitted: built from
   * config.embeddings (same key; null without it). Tests inject the fake, or null.
   */
  imageEmbedder?: ImageEmbedder | null;
}
```
**Change (c), inside `startDaemon` (unchanged by Phases 3 and 4; `DATA_SUBDIRS` above it is theirs and stays as `[..., CHAT_SUBDIR, CHAT_IMAGES_SUBDIR, 'files']`):** replace
```ts
  // Before createDb: a blank key throws EmbeddingError here, with no pool to leak.
  const embedder = options.embedder !== undefined ? options.embedder : embedderFromConfig(config.embeddings);
  const db = createDb(config.databaseUrl);
  const events = new NoteEvents();
  const service = new NotesService({ db, dataDir: config.dataDir, events, embedder });
  const deps: AppDeps = { config, db, events, service, embedder };
```
with
```ts
  // Before createDb: a blank key throws EmbeddingError here, with no pool to leak.
  const embedder = options.embedder !== undefined ? options.embedder : embedderFromConfig(config.embeddings);
  const imageEmbedder =
    options.imageEmbedder !== undefined ? options.imageEmbedder : imageEmbedderFromConfig(config.embeddings);
  const db = createDb(config.databaseUrl);
  const events = new NoteEvents();
  const service = new NotesService({ db, dataDir: config.dataDir, events, embedder });
  const deps: AppDeps = { config, db, events, service, embedder, imageEmbedder };
```

### Step 14: Background starts and stops the image worker
**File:** `src/background.ts` (whole file)
**Note:** the "off" line must not contain the substring `embeddings off`: `tests/integration/embeddings.worker.int.test.ts` counts exactly one such line.
**Code:**
```ts
import type { AppDeps } from './deps.js';
import { dbEmbeddingStore } from './embeddings/backfill.js';
import { dbImageEmbeddingStore } from './embeddings/imageBackfill.js';
import { startImageEmbeddingWorker } from './embeddings/imageWorker.js';
import { startEmbeddingWorker, type EmbeddingWorker } from './embeddings/worker.js';
import { imageDeps, ingestImage } from './images/ingest.js';
import { startInboxWatcher } from './images/inbox.js';
import { reconcileLegacyImages } from './images/legacy.js';
import { ensureDataDirs } from './images/store.js';

export type StopBackground = () => Promise<void>;

/**
 * Long-running work beside the HTTP server: the inbox watcher (iteration 2) and, when
 * OPENROUTER_API_KEY is set, the note embedding worker (iteration 6) and the image embedding
 * worker (image similarity search).
 * Creates images/, cache/, inbox/, inbox/failed/, chat-images/ under the data dir first (idempotent; the
 * daemon already made them, but tests call this without startDaemon). Then copies any legacy
 * image (notes.image_path/image_meta without a note_images row, e.g. ingested by an older daemon
 * after migration 0002 ran) into note_images, once, before the inbox can dedupe against it.
 */
export async function startBackground(deps: AppDeps): Promise<StopBackground> {
  const img = imageDeps(deps);
  const dirs = await ensureDataDirs(img.dataDir);
  try {
    const copied = await reconcileLegacyImages(deps.db);
    console.log(`[notesd] legacy images reconciled into note_images: ${copied}`);
  } catch (err) {
    // Never block the daemon on it: the next start retries (the copy is idempotent).
    console.error(`[notesd] legacy image reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const inbox = await startInboxWatcher({
    inboxDir: dirs.inbox,
    failedDir: dirs.failed,
    ingest: (absPath) => ingestImage(img, { path: absPath, move: true, origin: { source: 'inbox' } }),
  });
  console.log(`[notesd] watching ${dirs.inbox}`);

  let embeddings: EmbeddingWorker | null = null;
  if (!deps.embedder) {
    console.log('[notesd] embeddings off: OPENROUTER_API_KEY is not set, search stays full text');
  } else {
    embeddings = startEmbeddingWorker({
      store: dbEmbeddingStore(deps.db),
      events: deps.events,
      embedder: deps.embedder,
    });
    console.log(`[notesd] embedding notes with ${deps.embedder.model}`);
  }

  let imageEmbeddings: EmbeddingWorker | null = null;
  if (!deps.imageEmbedder) {
    console.log('[notesd] image search off: OPENROUTER_API_KEY is not set, similar_images cannot compare pictures');
  } else {
    imageEmbeddings = startImageEmbeddingWorker({
      store: dbImageEmbeddingStore(deps.db, img.dataDir),
      events: deps.events,
      embedder: deps.imageEmbedder,
    });
    console.log(`[notesd] embedding images with ${deps.imageEmbedder.model}`);
  }

  return async () => {
    await inbox.close();
    // In parallel: each close is bounded by its grace (5 s), well under main.ts's 10 s exit.
    await Promise.all([embeddings?.close(), imageEmbeddings?.close()]);
  };
}
```

### Step 15: `ToolDeps` gains the image embedder and the upload source
**File:** `src/mcp/tools.ts` lines 1-22 (imports + `ToolDeps`; rest of the file unchanged)
**Code:**
```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import type { ChatUploadSource } from '../embeddings/chatUploads.js';
import type { ImageEmbedder } from '../embeddings/imageEmbedder.js';
import type { NoteFilter } from '../notes/repo.js';
import type { NotesService } from '../notes/service.js';
import { NoteError } from '../notes/types.js';
import { ConnectorError, type Connectors } from '../connectors/types.js';

export interface ToolDeps {
  service: NotesService;
  dataDir: string;
  /** Read-only use by phase 5's image tools (raw image records); writes still go through `service`. */
  db: Db;
  /** Connectors for the connector tools. Omitted: defaultConnectors() (sibling repos, read per call). Tests inject their own. */
  connectors?: Connectors;
  /**
   * The wall's base URL (`http://localhost:<port>`, no trailing slash) named in the instructions'
   * Links paragraph. Omitted: `DEFAULT_WALL_URL` (port 7317), e.g. a daemon on port 0 in tests.
   */
  wallUrl?: string;
  /** Image embedder behind `similar_images`. Omitted or null: image search off (existing vectors still answer image_id). */
  imageEmbedder?: ImageEmbedder | null;
  /** Reads a wall-chat upload for `similar_images` upload_id. Omitted: upload_id answers that uploads are unavailable. */
  chatUploads?: ChatUploadSource;
}
```

### Step 16: `similar_images`
**File:** `src/mcp/similarTools.ts` (new)
**Code:**
```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { IMAGE_EMBEDDING_MODEL } from '../embeddings/imageConstants.js';
import type { ImageEmbedder } from '../embeddings/imageEmbedder.js';
import { notePngForEmbedding, toEmbeddingPng } from '../embeddings/imageInput.js';
import { nearestImages, saveImageEmbedding, type NearestImage } from '../embeddings/imageRepo.js';
import { toolImageDeps } from '../http/imageAccess.js';
import { OriginalMissingError } from '../images/derive.js';
import { locateImage, type LocatedImage } from '../images/ingest.js';
import { fileExists } from '../images/store.js';
import { normalizeId } from '../notes/ids.js';
import { errorResult, jsonResult, type ToolDeps } from './tools.js';

export const SIMILAR_IMAGES_DEFAULT_LIMIT = 10;
export const SIMILAR_IMAGES_MAX_LIMIT = 50;
/** Note body characters shown per hit. */
export const SIMILAR_SNIPPET_CHARS = 200;

export const IMAGE_SEARCH_OFF =
  'semantic image search is off on this daemon (OPENROUTER_API_KEY is not set), so pictures cannot be compared. ' +
  'Use search, or list with has_image: true, to find photos by their note text instead.';

/** Phase 8 replaces this answer with the real pasted_image -> upload_id path (PreToolUse hook). */
export const PASTED_IMAGE_NEEDS_HOOK =
  'pasted_image works only when the notes-paste hook is installed in Claude Code: the hook uploads the image pasted into this conversation and turns pasted_image into an upload_id. ' +
  'It is not installed here yet. Ask the user to run scripts/install.sh in ~/mcp-notes and restart Claude Code, ' +
  'or call similar_images with image_id (a picture already in a note) or query (words describing the picture) instead.';

/** A message for the model; the handler turns it into an isError result. */
class SimilarError extends Error {
  override name = 'SimilarError';
}

export interface SimilarArgs {
  image_id?: string | undefined;
  upload_id?: string | undefined;
  query?: string | undefined;
  pasted_image?: number | undefined;
  limit?: number | undefined;
}

export type SimilarSource = { image_id: string } | { upload_id: string } | { query: string };

export interface SimilarHit {
  image_id: string;
  note_id: string;
  /** 1 - cosine distance, 4 decimals: 1 = the same picture, near 0 = unrelated. */
  similarity: number;
  note: { body: string; tags: string[] };
  /** The image's file is on this machine (view_images can show it). */
  available: boolean;
}

export interface SimilarImagesResult {
  source: SimilarSource;
  model: string;
  hits: SimilarHit[];
  next: string;
}

/** How many of the four sources are set. */
export function countSources(args: SimilarArgs): number {
  return [args.image_id, args.upload_id, args.query, args.pasted_image].filter((v) => v !== undefined).length;
}

/** Whitespace collapsed, at most `max` characters, an ellipsis when cut, never half a surrogate pair. */
export function bodySnippet(body: string, max: number = SIMILAR_SNIPPET_CHARS): string {
  const text = body.trim().replace(/\s+/g, ' ');
  if (text.length <= max) return text;
  let cut = text.slice(0, Math.max(0, max - 1));
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function requireEmbedder(deps: ToolDeps): ImageEmbedder {
  const embedder = deps.imageEmbedder ?? null;
  if (embedder === null) throw new SimilarError(IMAGE_SEARCH_OFF);
  return embedder;
}

/** Embeds a stored note image now (the guarded upsert the worker does), like `related` does for notes. */
async function embedStoredImage(deps: ToolDeps, loc: LocatedImage): Promise<void> {
  const embedder = deps.imageEmbedder ?? null;
  if (embedder === null) {
    throw new SimilarError(`Image ${loc.id} has no image embedding yet and ${IMAGE_SEARCH_OFF}`);
  }
  const elsewhere =
    `Image ${loc.id} has no image embedding yet and its file lives on ${loc.host ?? 'another machine'}, so it cannot be embedded here; ` +
    "that machine's daemon embeds it in the background. Try again later, or describe the picture with query instead.";
  if (!loc.available) throw new SimilarError(elsewhere);
  let png: Uint8Array;
  try {
    png = await notePngForEmbedding(deps.dataDir, loc);
  } catch (err) {
    if (err instanceof OriginalMissingError) throw new SimilarError(elsewhere);
    throw new SimilarError(`Image ${loc.id} could not be prepared for embedding (${reason(err)}).`);
  }
  let vector: number[];
  try {
    vector = await embedder.embedImage(png);
  } catch (err) {
    throw new SimilarError(
      `Image ${loc.id} has no image embedding yet and embedding it now failed (${reason(err)}). The background job retries it; try again later.`,
    );
  }
  await saveImageEmbedding(deps.db, { imageId: loc.id, imageSha256: loc.meta.sha256, model: embedder.model, embedding: vector });
}

async function nearestFor(
  deps: ToolDeps,
  args: SimilarArgs,
  limit: number,
): Promise<{ source: SimilarSource; model: string; nearest: NearestImage[] }> {
  if (args.image_id !== undefined) {
    const id = normalizeId(args.image_id);
    if (id === null) {
      throw new SimilarError(`${args.image_id}: not an image id (image ids look like A-B32; take them from a note's images[].id).`);
    }
    const loc = await locateImage(toolImageDeps(deps), id);
    if (loc === null) {
      throw new SimilarError(`${id}: no such image. Image ids come from a note's images[].id (get, list or search with has_image: true).`);
    }
    // Without an embedder, existing vectors of the configured model still answer (as `related` does).
    const model = deps.imageEmbedder?.model ?? IMAGE_EMBEDDING_MODEL;
    let nearest = await nearestImages(deps.db, { source: { imageId: id }, model, limit });
    if (nearest === null) {
      await embedStoredImage(deps, loc);
      nearest = await nearestImages(deps.db, { source: { imageId: id }, model, limit });
      if (nearest === null) throw new SimilarError(`Image ${id} changed while it was being embedded. Try again.`);
    }
    return { source: { image_id: id }, model, nearest };
  }

  if (args.upload_id !== undefined) {
    const embedder = requireEmbedder(deps);
    const lookup = deps.chatUploads;
    if (lookup === undefined) throw new SimilarError('upload_id is not available on this daemon (it has no chat image store).');
    const upload = await lookup(args.upload_id);
    if (upload === null) {
      throw new SimilarError(`${args.upload_id}: no such chat upload. Upload ids appear in chat messages as [image upload:ID].`);
    }
    if (!(await fileExists(upload.absPath))) {
      throw new SimilarError(`Upload ${upload.id} was pasted on another machine; its file is not here, so it cannot be compared from this daemon.`);
    }
    let png: Uint8Array;
    try {
      png = await toEmbeddingPng(upload.absPath);
    } catch (err) {
      throw new SimilarError(`Upload ${upload.id} could not be read as an image (${reason(err)}).`);
    }
    let vector: number[];
    try {
      vector = await embedder.embedImage(png);
    } catch (err) {
      throw new SimilarError(`Embedding upload ${upload.id} failed (${reason(err)}). Try again in a moment.`);
    }
    // Embedded on the fly, never persisted: an upload is a question, not a note.
    const nearest = await nearestImages(deps.db, { source: { vector }, model: embedder.model, limit });
    return { source: { upload_id: upload.id }, model: embedder.model, nearest: nearest ?? [] };
  }

  if (args.query !== undefined) {
    const embedder = requireEmbedder(deps);
    const query = args.query.trim();
    if (query === '') throw new SimilarError('query is empty: describe the picture in words, e.g. "red top in a car".');
    let vector: number[];
    try {
      vector = await embedder.embedText(query);
    } catch (err) {
      throw new SimilarError(`Embedding the query failed (${reason(err)}). Try again in a moment.`);
    }
    const nearest = await nearestImages(deps.db, { source: { vector }, model: embedder.model, limit });
    return { source: { query }, model: embedder.model, nearest: nearest ?? [] };
  }

  throw new SimilarError(PASTED_IMAGE_NEEDS_HOOK);
}

/** Joins hits to their live notes; a hit whose note or image went away meanwhile is dropped. */
async function toHits(deps: ToolDeps, nearest: NearestImage[]): Promise<SimilarHit[]> {
  if (nearest.length === 0) return [];
  const found = await deps.service.get([...new Set(nearest.map((n) => n.noteId))]);
  const notes = new Map(found.notes.map((n) => [n.id, n]));
  const hits: SimilarHit[] = [];
  for (const n of nearest) {
    const note = notes.get(n.noteId);
    const image = note?.images.find((i) => i.id === n.imageId);
    if (note === undefined || image === undefined) continue;
    hits.push({
      image_id: n.imageId,
      note_id: n.noteId,
      similarity: n.similarity,
      note: { body: bodySnippet(note.body), tags: note.tags },
      available: image.available,
    });
  }
  return hits;
}

export function registerSimilarTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'similar_images',
    {
      title: 'Similar images',
      description:
        'Find the photos that look most like a picture, or that match a description of what is in it. Give exactly one of: ' +
        "image_id (a picture already in the notes, from a note's images[].id), " +
        'upload_id (an image pasted into the wall chat; the message names it [image upload:ID]), ' +
        'query (words describing the picture, e.g. "red top in a car"; words and pictures share one vector space), ' +
        'or pasted_image (Claude Code: the number of an image pasted into this conversation, 1 for the first). ' +
        'Returns { source, model, hits: [{ image_id, note_id, similarity, note: { body, tags }, available }] }, most similar first ' +
        '(similarity 1 = the same picture, near 0 = unrelated). Never returns the source image, a removed image or an image of a deleted note. ' +
        'It only measures likeness: call view_images with the top image ids and look before saying which ones match.',
      inputSchema: {
        image_id: z
          .string()
          .min(1)
          .optional()
          .describe("A picture already in the notes: an id from a note's images[].id, like A-B32. Case-insensitive; the dash may be omitted."),
        upload_id: z
          .string()
          .min(1)
          .optional()
          .describe('An image pasted into the wall chat: the ID from "[image upload:ID]" in the message.'),
        query: z
          .string()
          .min(1)
          .optional()
          .describe('Words describing what is IN the picture, e.g. "red top in a car". For words in the note text use search instead.'),
        pasted_image: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('Claude Code only: which image pasted into the latest user message, 1 for the first. Needs the notes-paste hook.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(SIMILAR_IMAGES_MAX_LIMIT)
          .optional()
          .describe(`How many images to return, 1-${SIMILAR_IMAGES_MAX_LIMIT}. Default ${SIMILAR_IMAGES_DEFAULT_LIMIT}.`),
      },
      annotations: { readOnlyHint: true },
    },
    async (args): Promise<CallToolResult> => {
      const n = countSources(args);
      if (n !== 1) {
        return fail(`similar_images needs exactly one of image_id, upload_id, query or pasted_image (got ${n === 0 ? 'none' : n}).`);
      }
      if (args.pasted_image !== undefined) return fail(PASTED_IMAGE_NEEDS_HOOK);
      const limit = Math.min(Math.max(Math.trunc(args.limit ?? SIMILAR_IMAGES_DEFAULT_LIMIT), 1), SIMILAR_IMAGES_MAX_LIMIT);
      try {
        const { source, model, nearest } = await nearestFor(deps, args, limit);
        const hits = await toHits(deps, nearest);
        const result: SimilarImagesResult = {
          source,
          model,
          hits,
          next:
            hits.length > 0
              ? 'Call view_images with the top image_ids to look at them before saying which ones match.'
              : 'No other embedded picture to compare with yet. New images are embedded in the background within a minute; npm run embed:images:backfill embeds existing ones.',
        };
        return jsonResult(result);
      } catch (err) {
        if (err instanceof SimilarError) return fail(err.message);
        return errorResult(err);
      }
    },
  );
}
```

### Step 17: Register the tool
**File:** `src/mcp/server.ts` lines 4 and 11-21
**Code:**
```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { defaultConnectors, registerConnectorTools } from '../connectors/register.js';
import { registerImageTools } from './imageTools.js';
import { buildInstructions } from './instructions.js';
import { registerSimilarTools } from './similarTools.js';
import { registerNoteTools, type ToolDeps } from './tools.js';

export const SERVER_NAME = 'mcp-notes';
export const SERVER_VERSION = '0.1.0';

export function createMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: buildInstructions(undefined, deps.wallUrl) },
  );
  registerNoteTools(server, deps);
  registerImageTools(server, deps);
  registerSimilarTools(server, deps);
  // Lazy: nothing is read or connected until a connector tool is called.
  registerConnectorTools(server, deps.connectors ?? defaultConnectors());
  return server;
}
```
(`handleMcpRequest` below is unchanged.)

### Step 18: `mcpToolDeps` hands them over
**File:** `src/http/app.ts` imports and `mcpToolDeps`
**Change:** add import `import { dbChatUploadSource } from '../embeddings/chatUploads.js';` among the `../` imports (Phase 3 added `./chatImages.js`, Phase 4 `./files.js`; their mounts and the `createApp` doc comment are not touched here) and replace `mcpToolDeps` (unchanged by Phases 3 and 4):
**Code:**
```ts
export function mcpToolDeps(deps: AppDeps): ToolDeps {
  const wallUrl = wallUrlForPort(deps.config.port);
  return {
    service: deps.service,
    dataDir: deps.config.dataDir,
    db: deps.db,
    imageEmbedder: deps.imageEmbedder ?? null,
    chatUploads: dbChatUploadSource(deps.db, deps.config.dataDir),
    ...(wallUrl !== undefined ? { wallUrl } : {}),
  };
}
```
(`deps.imageEmbedder ?? null` keeps `tests/unit/mcp.instructions.test.ts`'s cast `AppDeps` literal, which lacks the field, working.)

### Step 19: Chat allowlist and caption
**File:** `src/chat/status.ts` lines 17-35, 48-53, 96-99
**Code:**
```ts
export const NOTES_TOOL_NAMES = [
  'create',
  'get',
  'update',
  'append',
  'delete',
  'restore',
  'list',
  'search',
  'tags',
  'related',
  'revisions',
  'revert',
  'create_image',
  'view_images',
  'attach_image',
  'remove_image',
  'restore_image',
  'similar_images',
] as const;
```
```ts
/**
 * Exactly the 18 notes tools, the 15 connector tools and WebSearch + WebFetch
 * (CONNECTORS_PLAN invariant 8, which supersedes CHAT_BAR_BRAIN_PLAN invariant 4;
 * SEMANTIC_SEARCH_PLAN phase 5 adds `related`; WALL_EDITING_PLAN phase 3 adds
 * `attach_image`, `remove_image` and `restore_image`; CHAT_HISTORY_FILES_IMAGE_SEARCH_PLAN
 * phase 6 adds `similar_images`).
 */
export function allowedChatTools(): string[] {
  return [
    ...NOTES_TOOL_NAMES.map((name) => `${MCP_PREFIX}${name}`),
    ...ALL_CONNECTOR_TOOL_NAMES.map((name) => `${MCP_PREFIX}${name}`),
    ...WEB_TOOL_NAMES,
  ];
}
```
In `captionForToolUse`, add after the `'related'` case:
```ts
    case 'similar_images':
      return 'finding similar photos';
```

### Step 20: Wall chat system prompt
**File:** `src/chat/prompt.ts` (the pictures array element, as Phase 4 left it: it ends with Phase 4's sentence "A note may also hold files that are not pictures: you see each one's name, type and size in the note's files list but cannot open them, and you cannot attach files.")
**Code:** replace that array element with (Phase 4's files sentence kept, the pasted-image sentences appended)
```ts
    `To look at pictures, find the notes with images first (list with has_image, or search), then call view_images with their note ids (each note id shows every image of that note, up to 8 images per call; image ids work too) and comment on what you actually see. A note may also hold files that are not pictures: you see each one's name, type and size in the note's files list but cannot open them, and you cannot attach files. Images the owner pastes into the chat bar come with their message and are named in its text as [image upload:ID]. To find photos like one of them, call similar_images with upload_id set to that ID (image_id for a picture already in a note, query for words such as "red top in a car"), then call view_images on the top hits and say which ones really match and why.`,
```
**Impact:** Phase 4's test (`/files that are not pictures/`, `/cannot open them/`) still passes. P7 also edits this file later (`[msg:ID]` paragraph); different array element.

### Step 21: MCP instructions paragraph
**File:** `src/mcp/instructions.ts`, insert a new array element after Phase 4's `Files.` element (which follows `Attaching.`) and before `Connectors.`. Order becomes `… Attaching. / Files. / Similar images. / Connectors. …`, so Phase 4's test `order.indexOf('Files') === order.indexOf('Attaching') + 1` still holds:
**Code:**
```ts
    `Similar images. similar_images finds the pictures that look most like one picture, or that match words: pass exactly one of image_id (a picture already in the notes), upload_id (an image pasted into the wall chat, named [image upload:ID] in the message), query (a description such as "red top in a car"; words and pictures share one vector space) or pasted_image (the number of an image pasted into this Claude Code conversation, 1 for the first). It returns hits {image_id, note_id, similarity, note: {body, tags}, available}, most similar first (1 = the same picture, near 0 = unrelated), never the source image, a removed image or an image of a deleted note. similar_images only measures likeness: call view_images on the top image ids and look before you say which ones match. To find photos by the words in their note, use search instead.`,
```

### Step 22: `/n` skill
**File:** `claude/skills/n/SKILL.md`
**Change (a), Tools paragraph (lines 38-43 on `main`; Phase 4 does not change it, it adds a bullet to "What a note is" and a `## Files` section after `## Images`, both left as they are):** replace with
```markdown
`revisions` and `revert`. The image tools are `create_image` (a new note from a local file
path), `attach_image` (add a local file to an existing note), `remove_image` and
`restore_image` (take one image out of its note, softly, and put it back), `view_images` (see
the images of notes, or single images), `similar_images` (the pictures that look most like one
picture, or that match a description), and the `has_image` / taken-date filters on `list` and
`search`. Use them as described under Images. Always follow each tool's own schema and
description for parameter names and formats; they win over anything written here.
```
**Change (b), `## Images` section:** insert these bullets after the "Remove the second picture" bullet and before the `available: false` bullet of `## Images` (not the `available: false` bullet of Phase 4's `## Files` section, which follows `## Images`):
```markdown
- "Find photos like this one" about a picture already in a note → `similar_images` with that
  image's `image_id` (from the note's `images`; a note's first image has the note's id). Then
  `view_images` on the top few `image_id`s and say which ones really match and why. The
  similarity score only ranks; your own look decides.
- "Photos of a red top in a car", "pictures of a whiteboard" → `similar_images` with `query`
  in plain words. It looks at what is in the pictures; for words written in the notes use
  `search`. Again `view_images` on the top hits before answering.
- An image the user pasted into this conversation plus "find similar" → `similar_images` with
  `pasted_image: 1` (2 for the second image of that message). If it answers that the
  notes-paste hook is not installed, tell the user to run `scripts/install.sh` in
  `~/mcp-notes` and restart Claude Code. Do not try to save the pasted image yourself.
- If `similar_images` says semantic image search is off, the daemon has no
  `OPENROUTER_API_KEY`; say so and fall back to `list` with `has_image: true` or `search`.
```

### Step 23: CLI `embed:images:backfill`
**File:** `src/cli/embedImagesBackfill.ts` (new)
**Code:**
```ts
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, type Config } from '../config.js';
import { closeDb, createDb, type Db } from '../db/client.js';
import { errorMessage } from '../embeddings/backfill.js';
import { dbImageEmbeddingStore, runImageBackfill } from '../embeddings/imageBackfill.js';
import {
  IMAGE_EMBEDDING_MODEL,
  IMAGE_PRICE_USD_PER_M_TOKENS,
  estimateImageCostUsd,
  estimateImageTokens,
} from '../embeddings/imageConstants.js';
import type { ImageEmbedder } from '../embeddings/imageEmbedder.js';
import { imageEmbeddingStats, listPendingImages } from '../embeddings/imageRepo.js';
import { createOpenRouterImageEmbedder } from '../embeddings/openrouterImage.js';

const NAME = 'embed:images:backfill';

/** Most pending rows a dry run reads. */
export const DRY_RUN_MAX_ROWS = 100_000;

const USAGE = [
  'usage: npm run embed:images:backfill -- [--dry-run] [--limit N] [--retry-failed]',
  `  Embeds every note image whose vector is missing, stale (model changed) or failed and due, with ${IMAGE_EMBEDDING_MODEL}.`,
  '  Images whose file is on another machine are skipped (that machine embeds them). Safe to stop',
  '  (Ctrl-C) and run again. Never runs by itself; notesd embeds new images in the background.',
  '  --dry-run       count what would be sent and estimate image tokens and cost; no network, no writes',
  '  --limit N       send at most N images this run',
  '  --retry-failed  also retry failed images now, without waiting for their backoff',
].join('\n');

/** Everything the command touches, injectable for tests. */
export interface EmbedImagesBackfillIo {
  loadConfig: () => Config;
  createDb: (url: string) => Db;
  closeDb: (db: Db) => Promise<void>;
  createEmbedder: (apiKey: string) => ImageEmbedder;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Aborted on Ctrl-C by main(). */
  signal?: AbortSignal;
  /** Overrides DEFAULT_MIN_INTERVAL_MS (tests pass 0). */
  minIntervalMs?: number;
}

export function defaultIo(signal: AbortSignal): EmbedImagesBackfillIo {
  return {
    loadConfig: () => loadConfig(),
    createDb,
    closeDb,
    createEmbedder: (apiKey) => createOpenRouterImageEmbedder({ apiKey }),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    signal,
  };
}

type Parsed = { ok: true; dryRun: boolean; retryFailed: boolean; limit: number | null } | { ok: false; code: number };

function parseArgs(args: readonly string[], io: EmbedImagesBackfillIo): Parsed {
  let dryRun = false;
  let retryFailed = false;
  let limit: number | null = null;
  const bad = (message: string): Parsed => {
    io.err(`${NAME}: ${message}`);
    io.err(USAGE);
    return { ok: false, code: 2 };
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--retry-failed') {
      retryFailed = true;
    } else if (arg === '--limit' || arg.startsWith('--limit=')) {
      const raw = arg === '--limit' ? args[(i += 1)] : arg.slice('--limit='.length);
      const n = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isInteger(n) || n < 1) return bad(`--limit needs a whole number >= 1, got ${raw ?? 'nothing'}`);
      limit = n;
    } else if (arg === '--help' || arg === '-h') {
      io.out(USAGE);
      return { ok: false, code: 0 };
    } else {
      return bad(`unknown argument ${arg}`);
    }
  }
  return { ok: true, dryRun, retryFailed, limit };
}

/** Returns the process exit code. */
export async function embedImagesBackfill(args: readonly string[], io: EmbedImagesBackfillIo): Promise<number> {
  const parsed = parseArgs(args, io);
  if (!parsed.ok) return parsed.code;
  const { dryRun, retryFailed, limit } = parsed;

  let config: Config;
  try {
    config = io.loadConfig();
  } catch (err) {
    io.err(`${NAME}: ${errorMessage(err)}`);
    return 1;
  }
  const apiKey = config.embeddings.apiKey;
  if (!dryRun && !apiKey) {
    io.err(`${NAME}: OPENROUTER_API_KEY is not set. Put it in .env.local (or export it) and run again.`);
    return 1;
  }

  // Before createDb, as in embed:backfill: a bad key throws with no pool to leak. A dry run never builds one.
  const embedder = dryRun || !apiKey ? null : io.createEmbedder(apiKey);
  const model = embedder?.model ?? IMAGE_EMBEDDING_MODEL;
  const db = io.createDb(config.databaseUrl);
  try {
    const store = dbImageEmbeddingStore(db, config.dataDir);
    const before = await imageEmbeddingStats(db, model);
    io.out(
      `${NAME}: ${model}; ${before.images} images, ${before.current} current, ` +
        `${before.pending} pending (${before.failing} failing)`,
    );

    if (embedder === null) {
      const pending = await listPendingImages(db, { model, limit: DRY_RUN_MAX_ROWS, ignoreBackoff: retryFailed });
      let here = 0;
      let elsewhere = 0;
      let wouldSend = 0;
      let tokens = 0;
      for (const image of pending) {
        if (await store.isAvailable(image)) {
          here += 1;
          if (limit === null || wouldSend < limit) {
            wouldSend += 1;
            tokens += estimateImageTokens(image.width, image.height);
          }
        } else {
          elsewhere += 1;
        }
      }
      io.out(`dry run: ${pending.length} due now, ${here} on this machine, ${elsewhere} on another machine (skipped here)`);
      io.out(
        `would send ${wouldSend} image(s): about ${tokens} image tokens, about $${estimateImageCostUsd(tokens).toFixed(4)} ` +
          `at $${IMAGE_PRICE_USD_PER_M_TOKENS} per million image tokens (estimate)`,
      );
      io.out('dry run: nothing was sent and nothing was written');
      return 0;
    }

    const total = before.pending;
    const seen = { embedded: 0, failed: 0 };
    const result = await runImageBackfill({
      store,
      embedder,
      ignoreBackoff: retryFailed,
      signal: io.signal,
      ...(limit !== null ? { maxImages: limit } : {}),
      ...(io.minIntervalMs !== undefined ? { minIntervalMs: io.minIntervalMs } : {}),
      onImage: (r) => {
        if (r.outcome === 'failed') {
          seen.failed += 1;
          io.err(`failed ${r.imageId}: ${r.error ?? ''}`);
        } else if (r.outcome === 'embedded') {
          seen.embedded += 1;
        } else {
          return;
        }
        io.out(`embedded ${seen.embedded}/${Math.max(total, seen.embedded + seen.failed)}, failed ${seen.failed}`);
      },
    });
    const after = await imageEmbeddingStats(db, model);
    if (result.aborted) {
      io.out(
        `stopped: embedded ${result.embedded}, failed ${result.failed}; ${after.pending} still pending, run again to resume`,
      );
      return 130;
    }
    if (result.calls === 0 && result.failed === 0) io.out('nothing to embed on this machine');
    io.out(
      `done: embedded ${result.embedded}, failed ${result.failed}, ${result.unavailable} not on this machine; ${after.pending} pending`,
    );
    if (result.limited) io.out(`stopped at --limit ${limit}; run again for the rest`);
    if (!retryFailed && after.failing > 0) {
      io.out(`${after.failing} failed image(s) wait for their retry backoff; run with -- --retry-failed to try them now`);
    }
    return result.failed > 0 ? 1 : 0;
  } catch (err) {
    io.err(`${NAME}: ${errorMessage(err)}`);
    return 1;
  } finally {
    await io.closeDb(db);
  }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  let interrupts = 0;
  process.on('SIGINT', () => {
    interrupts += 1;
    if (interrupts > 1) process.exit(130);
    console.error(`${NAME}: stopping after the current image (Ctrl-C again to quit now)`);
    controller.abort();
  });
  process.exitCode = await embedImagesBackfill(process.argv.slice(2), defaultIo(controller.signal));
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  main().catch((err: unknown) => {
    console.error(`${NAME}: failed`, err);
    process.exitCode = 1;
  });
}
```

### Step 24: package.json scripts
**File:** `package.json` `scripts`
**Change:** add after `"test:live:embeddings"` and after `"embed:backfill"` respectively:
```json
    "test:live:imageEmbeddings": "IMAGE_EMBEDDINGS_LIVE_TEST=1 vitest run",
```
```json
    "embed:images:backfill": "tsx src/cli/embedImagesBackfill.ts"
```
(add the trailing comma to `"embed:backfill": "tsx src/cli/embedBackfill.ts"`).

### Step 25: Vitest routing for the live image probe
**File:** `vitest.config.ts` (whole file)
**Code:**
```ts
import { defineConfig } from 'vitest/config'

/**
 * The single Vitest config for the repo.
 *
 * - `npm test` (unit): `tests/unit/**` in node, plus `web/src/**\/*.test.tsx`, which opt
 *   into jsdom per file with a `// @vitest-environment jsdom` first-line pragma.
 * - `npm run test:int` (scripts/test-int.sh) sets VITEST_INTEGRATION=1, TEST_DATABASE_URL and
 *   TEST_CONNECTORS_URL, which switches the run to `tests/integration/**` only, against the
 *   Docker Postgres `mcp-notes-pg-test` (notes, pgvector image) and `mcp-notes-pg-connectors`
 *   (the three connector schemas, rebuilt from the sibling repos' migrations by
 *   tests/integration/connectors/globalSetup.ts). Integration files run one at a time because
 *   they share databases and truncate them. Embeddings there come from the deterministic fake
 *   embedders; no network.
 * - `npm run test:live` sets CHAT_LIVE_TEST=1 on top of scripts/test-int.sh, which switches the
 *   run to `tests/live/chat.live.test.ts` only: real Claude and real GLM calls through the Agent
 *   SDK, on the notes Docker Postgres. Opt-in, slow and billed.
 * - `npm run test:live:connectors` sets CONNECTORS_LIVE_TEST=1 (no Docker), which runs only
 *   `tests/live/connectors.live.test.ts`: each <system>_schema tool against the real databases,
 *   read-only. Opt-in.
 * - `npm run test:live:embeddings` sets EMBEDDINGS_LIVE_TEST=1 (no Docker, no database), which
 *   runs only `tests/live/embeddings.live.test.ts`: one real, billed OpenRouter embeddings call
 *   (OPENROUTER_API_KEY from .env.local) over the labelled search set. Opt-in.
 * - `npm run test:live:imageEmbeddings` sets IMAGE_EMBEDDINGS_LIVE_TEST=1 (no Docker, no
 *   database), which runs only `tests/live/imageEmbeddings.live.test.ts`: a few real, billed
 *   google/gemini-embedding-2 calls that document the request shapes and check the width. Opt-in.
 * None of the live files is ever part of `npm test` or `test:int`.
 *
 * Do not add a second config file.
 */
const chatLive = process.env.CHAT_LIVE_TEST === '1'
const connectorsLive = process.env.CONNECTORS_LIVE_TEST === '1'
const embeddingsLive = process.env.EMBEDDINGS_LIVE_TEST === '1'
const imageEmbeddingsLive = process.env.IMAGE_EMBEDDINGS_LIVE_TEST === '1'
const integration =
  !connectorsLive &&
  !embeddingsLive &&
  !imageEmbeddingsLive &&
  (chatLive || process.env.VITEST_INTEGRATION === '1')

function includeFor(): string[] {
  if (imageEmbeddingsLive) return ['tests/live/imageEmbeddings.live.test.ts']
  if (embeddingsLive) return ['tests/live/embeddings.live.test.ts']
  if (connectorsLive) return ['tests/live/connectors.live.test.ts']
  if (chatLive) return ['tests/live/chat.live.test.ts']
  if (integration) return ['tests/integration/**/*.int.test.ts']
  return ['tests/unit/**/*.test.ts', 'web/src/**/*.test.tsx']
}

function globalSetupFor(): string[] {
  if (embeddingsLive || connectorsLive || imageEmbeddingsLive) return []
  if (chatLive) return ['tests/integration/globalSetup.ts']
  if (integration) return ['tests/integration/globalSetup.ts', 'tests/integration/connectors/globalSetup.ts']
  return []
}

function testTimeoutFor(): number {
  if (chatLive) return 300_000
  if (connectorsLive || embeddingsLive || imageEmbeddingsLive) return 60_000
  if (integration) return 30_000
  return 5_000
}

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: includeFor(),
    exclude: ['node_modules/**', 'dist/**', 'web/dist/**'],
    globalSetup: globalSetupFor(),
    fileParallelism: !integration,
    testTimeout: testTimeoutFor(),
    hookTimeout: chatLive || connectorsLive || embeddingsLive || imageEmbeddingsLive || integration ? 60_000 : 10_000,
  },
})
```

### Step 26: Live probe (opt-in, billed)
**File:** `tests/live/imageEmbeddings.live.test.ts` (new)
**Code:**
```ts
/**
 * Opt-in live probe of image embeddings: a handful of real, billed OpenRouter calls to
 * google/gemini-embedding-2 (well under a cent). Run with `npm run test:live:imageEmbeddings`
 * (IMAGE_EMBEDDINGS_LIVE_TEST=1; no Docker, no database). Never part of `npm test`,
 * `npm run test:int` or the other live suites.
 *
 * It documents the request shapes src/embeddings/openrouterImage.ts sends (printed as a
 * "[live] ... request shapes" block) and checks what the fakes cannot: an image-only content item
 * with a PNG data URL comes back as a vector we can fit to vector(1536); a text-only content item
 * lands in the same space (a "red" query is nearer a red square than a blue one); and a
 * provider-shortened vector (`dimensions: 1536`) agrees with a client-shortened one (first 1536 of
 * the default 3072, renormalised). When a shape here starts failing, fix imageRequestBody /
 * textRequestBody first (for example drop `dimensions` from the image body: fitVector truncates).
 *
 * Needs OPENROUTER_API_KEY in the environment or in .env.local (a worktree carries a symlink to
 * ~/mcp-notes/.env.local). The key is never printed.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { IMAGE_EMBEDDING_DIMENSIONS, IMAGE_EMBEDDING_MODEL } from '../../src/embeddings/imageConstants.js';
import type { ImageEmbedder } from '../../src/embeddings/imageEmbedder.js';
import { postOpenRouterEmbeddings } from '../../src/embeddings/openrouter.js';
import {
  createOpenRouterImageEmbedder,
  fitVector,
  imageRequestBody,
  textRequestBody,
} from '../../src/embeddings/openrouterImage.js';

const TIMEOUT_MS = 30_000;

function apiKey(): string {
  const fromEnv = process.env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const file = path.resolve(import.meta.dirname, '../../.env.local');
  if (existsSync(file)) {
    const fromFile = parse(readFileSync(file)).OPENROUTER_API_KEY?.trim();
    if (fromFile) return fromFile;
  }
  throw new Error(
    'OPENROUTER_API_KEY is not set. Export it or put it in .env.local ' +
      '(in a worktree: ln -sf /home/miftah/mcp-notes/.env.local .env.local).',
  );
}

function cosine(a: readonly number[], b: readonly number[]): number {
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

function embeddingOf(json: unknown): number[] {
  const first = (json as { data?: Array<{ embedding?: unknown }> }).data?.[0]?.embedding;
  if (!Array.isArray(first)) throw new Error('no data[0].embedding in the response');
  return first as number[];
}

async function solid(rgb: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width: 256, height: 256, channels: 3, background: rgb } }).png().toBuffer();
}

let key: string;
let embedder: ImageEmbedder;
let red: Buffer;
let blue: Buffer;

beforeAll(async () => {
  key = apiKey();
  embedder = createOpenRouterImageEmbedder({ apiKey: key });
  red = await solid({ r: 220, g: 20, b: 20 });
  blue = await solid({ r: 20, g: 20, b: 220 });
});

describe(`${IMAGE_EMBEDDING_MODEL} on OpenRouter (live, billed)`, () => {
  it('embeds a PNG data URL with the verified shape, fitted to 1536 unit-length values', async () => {
    const v = await embedder.embedImage(red);
    expect(v).toHaveLength(IMAGE_EMBEDDING_DIMENSIONS);
    expect(Math.abs(Math.hypot(...v) - 1)).toBeLessThan(1e-6);
  });

  it('puts a text query in the same space: "red" is nearer the red square than the blue one', async () => {
    const [vr, vb, q] = await Promise.all([
      embedder.embedImage(red),
      embedder.embedImage(blue),
      embedder.embedText('a plain solid red square'),
    ]);
    expect(cosine(q, vr)).toBeGreaterThan(cosine(q, vb));
  });

  it('documents the raw request shapes and their widths', async () => {
    const report: Record<string, string> = {};
    const probe = async (label: string, body: unknown): Promise<number> => {
      try {
        const { json } = await postOpenRouterEmbeddings(fetch, key, body, TIMEOUT_MS);
        const width = embeddingOf(json).length;
        report[label] = `ok, ${width} values`;
        return width;
      } catch (err) {
        report[label] = `refused: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`;
        return -1;
      }
    };
    const withDims = imageRequestBody(red);
    const { dimensions: _imageDims, ...imageDefault } = withDims;
    const imageSent = await probe('image item + dimensions 1536 (what we send)', withDims);
    const imageWide = await probe('image item, no dimensions', imageDefault);
    const textSent = await probe('text item as content array (what we send)', textRequestBody('red top in a car'));
    await probe('text as a plain string input', {
      model: IMAGE_EMBEDDING_MODEL,
      input: ['red top in a car'],
      encoding_format: 'float',
      dimensions: IMAGE_EMBEDDING_DIMENSIONS,
    });
    console.log(
      `[live] ${IMAGE_EMBEDDING_MODEL} request shapes:\n` +
        Object.entries(report)
          .map(([label, outcome]) => `  ${label}: ${outcome}`)
          .join('\n'),
    );
    expect(imageSent, JSON.stringify(report)).toBeGreaterThanOrEqual(IMAGE_EMBEDDING_DIMENSIONS);
    expect(imageWide, JSON.stringify(report)).toBeGreaterThanOrEqual(IMAGE_EMBEDDING_DIMENSIONS);
    expect(textSent, JSON.stringify(report)).toBeGreaterThanOrEqual(IMAGE_EMBEDDING_DIMENSIONS);
  });

  it('a provider-shortened vector agrees with a client-shortened one (Matryoshka prefix)', async () => {
    const body = textRequestBody('red top in a car');
    const { dimensions: _textDims, ...full } = body;
    const [short, wide] = await Promise.all([
      postOpenRouterEmbeddings(fetch, key, body, TIMEOUT_MS),
      postOpenRouterEmbeddings(fetch, key, full, TIMEOUT_MS),
    ]);
    const a = fitVector(embeddingOf(short.json));
    const b = fitVector(embeddingOf(wide.json));
    expect(cosine(a, b)).toBeGreaterThan(0.99);
  });
});
```

### Step 27: Deterministic fake image embedder
**File:** `tests/helpers/fakeImageEmbedder.ts` (new)
**Change:** colour-seeded vectors (axes 0-2 = mean R, G, B of the PNG, axis 3 = a small bias), so a red and a dark red image are close and red vs blue are far; text maps colour words to the same axes (text -> image search in tests) and anything else to a hash-seeded unit vector on the remaining axes.
**Code:**
```ts
import sharp from 'sharp';
import { EmbeddingError, type EmbedOptions } from '../../src/embeddings/embedder.js';
import { IMAGE_EMBEDDING_DIMENSIONS, IMAGE_EMBEDDING_MODEL } from '../../src/embeddings/imageConstants.js';
import type { ImageEmbedder } from '../../src/embeddings/imageEmbedder.js';
import { isPng } from '../../src/embeddings/openrouterImage.js';

export type Rgb = { r: number; g: number; b: number };

/** Colour words embedText maps onto the colour axes; any other text is hashed. */
export const COLOUR_WORDS: Readonly<Record<string, Rgb>> = {
  red: { r: 220, g: 20, b: 20 },
  green: { r: 20, g: 200, b: 20 },
  blue: { r: 20, g: 20, b: 220 },
  yellow: { r: 230, g: 220, b: 20 },
  white: { r: 255, g: 255, b: 255 },
  black: { r: 0, g: 0, b: 0 },
};

/** Keeps black off the zero vector and lets brightness matter a little. */
const BIAS = 0.05;
const COLOUR_AXES = 4;

function normalise(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map((x) => x / norm);
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Unit vector on the colour axes: (r, g, b)/255 plus BIAS, everything else 0. */
export function vectorForColour(rgb: Rgb, dimensions: number = IMAGE_EMBEDDING_DIMENSIONS): number[] {
  const v = new Array<number>(dimensions).fill(0);
  v[0] = rgb.r / 255;
  v[1] = rgb.g / 255;
  v[2] = rgb.b / 255;
  v[3] = BIAS;
  return normalise(v);
}

/** Unit vector on 8 hash-chosen non-colour axes: deterministic, near-orthogonal to every colour. */
export function vectorForHash(key: string, dimensions: number = IMAGE_EMBEDDING_DIMENSIONS): number[] {
  const v = new Array<number>(dimensions).fill(0);
  let h = fnv1a(key);
  for (let k = 0; k < 8; k += 1) {
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
    const axis = COLOUR_AXES + (h % (dimensions - COLOUR_AXES));
    v[axis] = (v[axis] ?? 0) + 1;
  }
  return normalise(v);
}

export interface FakeImageCall {
  kind: 'image' | 'text';
  /** PNG size for an image call. */
  bytes?: number;
  /** Trimmed query for a text call. */
  text?: string;
}

function scriptedFailure(): EmbeddingError {
  return new EmbeddingError('fake image embedder: scripted failure');
}

/**
 * Deterministic offline ImageEmbedder for unit and integration tests. Same validation as the
 * real client (non-PNG bytes or empty text throw before anything is recorded), same model id and
 * width by default, so stored rows count as current.
 */
export class FakeImageEmbedder implements ImageEmbedder {
  readonly model: string;
  readonly dimensions: number;
  /** Every call that would have reached the network, in order (failed ones included). */
  readonly calls: FakeImageCall[] = [];
  delayMs: number;
  /** While set, a recorded call rejects when it matches. */
  failWhen: ((call: FakeImageCall) => boolean) | null = null;
  private failuresLeft = 0;
  private failure: Error = scriptedFailure();

  constructor(opts: { model?: string; dimensions?: number; delayMs?: number } = {}) {
    this.model = opts.model ?? IMAGE_EMBEDDING_MODEL;
    this.dimensions = opts.dimensions ?? IMAGE_EMBEDDING_DIMENSIONS;
    if (!Number.isInteger(this.dimensions) || this.dimensions < COLOUR_AXES + 8) {
      throw new Error(`fake image embedder: ${this.dimensions} dimensions is too narrow (need >= ${COLOUR_AXES + 8})`);
    }
    this.delayMs = opts.delayMs ?? 0;
  }

  /** The next `n` recorded calls reject with `error` (default: an EmbeddingError). */
  failNext(n = 1, error?: Error): void {
    this.failuresLeft = n;
    this.failure = error ?? scriptedFailure();
  }

  /** Clears calls, scripted failures and the delay. */
  reset(): void {
    this.calls.length = 0;
    this.failuresLeft = 0;
    this.failWhen = null;
    this.delayMs = 0;
  }

  /** The vector embedImage would return. Records nothing; never fails on a decodable PNG. */
  async vectorForPng(png: Uint8Array): Promise<number[]> {
    const stats = await sharp(Buffer.from(png.buffer, png.byteOffset, png.byteLength)).stats();
    const [r, g, b] = stats.channels;
    const mean = (c: { mean: number } | undefined, fallback: number): number => c?.mean ?? fallback;
    const red = mean(r, 0);
    return vectorForColour({ r: red, g: mean(g, red), b: mean(b, red) }, this.dimensions);
  }

  /** The vector embedText would return: the first colour word's colour, else a hash of the text. */
  vectorForText(text: string): number[] {
    const words = text.toLowerCase().split(/[^a-z]+/);
    for (const word of words) {
      if (Object.hasOwn(COLOUR_WORDS, word)) return vectorForColour(COLOUR_WORDS[word]!, this.dimensions);
    }
    return vectorForHash(text.trim().toLowerCase(), this.dimensions);
  }

  private async record(call: FakeImageCall): Promise<void> {
    this.calls.push(call);
    if (this.delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw this.failure;
    }
    const pred = this.failWhen;
    if (pred !== null && pred(call)) throw scriptedFailure();
  }

  async embedImage(png: Uint8Array, _opts?: EmbedOptions): Promise<number[]> {
    if (!isPng(png)) throw new EmbeddingError('image embedding needs PNG bytes (re-encode with toEmbeddingPng first)');
    await this.record({ kind: 'image', bytes: png.byteLength });
    return this.vectorForPng(png);
  }

  async embedText(query: string, _opts?: EmbedOptions): Promise<number[]> {
    const text = query.trim();
    if (text === '') throw new EmbeddingError('image search query is empty');
    await this.record({ kind: 'text', text });
    return this.vectorForText(text);
  }
}
```

### Step 28: Test infrastructure: truncate list, harness, every `AppDeps` literal
**File:** `tests/integration/setup.ts` line 50
**Change:** prepend `note_image_embeddings, ` to the table list as Phase 4 left it (`chat_images, note_files, note_images, …`):
```ts
export async function truncateAll(db: Db): Promise<void> {
  await db.execute(sql`truncate table note_image_embeddings, chat_images, note_files, note_images, note_embeddings, note_revisions, notes restart identity cascade`)
}
```

**File:** `tests/integration/imageHarness.ts` (`HarnessOptions` and the head of `startHarness`, as Phases 3 and 4 left them)
**Change:** Phase 3's `HarnessOptions` gains `imageEmbedder`, passed through to `AppDeps` (default null). Phase 3's `chat` option and Phase 4's `files` subdir stay. Add the import next to Phase 3's `ChatBackend` import:
```ts
import type { ImageEmbedder } from '../../src/embeddings/imageEmbedder.js';
```
and replace `HarnessOptions` through the `createApp` line:
```ts
export interface HarnessOptions {
  /** The brain behind POST /api/chat. Omitted: createApp's default (the stub). */
  chat?: ChatBackend;
  /** Image embedder for similar_images over /mcp. Default null (image search off). */
  imageEmbedder?: ImageEmbedder | null;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const url = testDatabaseUrl();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'mcp-notes-p5-'));
  for (const sub of ['images', 'cache', 'inbox', 'inbox/failed', 'chat-images', 'files']) {
    await mkdir(path.join(dataDir, sub), { recursive: true });
  }
  const db = openTestDb();
  const events = new NoteEvents();
  const service = new NotesService({ db, dataDir, events });
  const deps: AppDeps = {
    config: { databaseUrl: url, port: 0, host: '127.0.0.1', dataDir, chat: DEFAULT_CHAT_CONFIG, embeddings: DEFAULT_EMBEDDINGS_CONFIG },
    db,
    events,
    service,
    embedder: null,
    imageEmbedder: options.imageEmbedder ?? null,
  };
  const app = createApp(deps, options.chat !== undefined ? { chat: options.chat } : {});
```
(the rest of `startHarness` — `listen`, Phase 4's `reset()` over `['images', 'cache', 'chat-images', 'files']`, `close` — is unchanged.)

**Append `imageEmbedder: null` to each of these `AppDeps` literals** (exact edits):
- `tests/integration/connectors/mcp.int.test.ts:20` -> `const deps: AppDeps = { config, db, events, service, embedder: null, imageEmbedder: null };`
- `tests/integration/mcp.tools.int.test.ts:23` -> `const deps: AppDeps = { config, db, events, service, embedder: null, imageEmbedder: null };`
- `tests/integration/related.int.test.ts:44` -> `const deps: AppDeps = { config, db, events, service, embedder: fake, imageEmbedder: null };`
- `tests/integration/images.int.test.ts:142` and `:171` -> after `embedder: null,` add `imageEmbedder: null,`
- `tests/integration/helpers/api-harness.ts:49` -> after `embedder: null,` add `imageEmbedder: null,`
- `tests/integration/embeddings.worker.int.test.ts:319-328` ->
```ts
  function deps(embedder: Embedder | null): AppDeps {
    const events = new NoteEvents();
    return {
      config: config(null),
      db,
      events,
      service: new NotesService({ db, dataDir, events }),
      embedder,
      imageEmbedder: null,
    };
  }
```
- `tests/live/chat.live.test.ts:54` (unchanged by Phase 3, which only added `images: []` to its `reply` literals and one image case) -> `daemon = await startDaemon(config, { chat: createStubChatBackend({ delayMs: 0 }), embedder: null, imageEmbedder: null });`

**File:** `tests/integration/daemon.int.test.ts` lines 114-133 (the embedder test; Phase 3's data-dir assertion at line 45 is a different test and stays): replace the test with
```ts
  it('has no embedders without OPENROUTER_API_KEY, and carries injected ones', async () => {
    // The shared daemon's config has embeddings.apiKey null and no embedder options.
    expect(daemon.deps.embedder).toBeNull();
    expect(daemon.deps.imageEmbedder).toBeNull();
    // The "with a key" path is unit-tested through embedderFromConfig / imageEmbedderFromConfig:
    // a daemon started here with a key would hold real OpenRouter clients and its workers would call them.
    const fakeDir = join(mkdtempSync(join(tmpdir(), 'notesd-')), 'data');
    const fake = createFakeEmbedder();
    const fakeImages = new FakeImageEmbedder();
    const withFake = await startDaemon(config(fakeDir), {
      chat: createStubChatBackend({ delayMs: 0 }),
      embedder: fake,
      imageEmbedder: fakeImages,
    });
    try {
      expect(withFake.deps.embedder).toBe(fake);
      expect(withFake.deps.imageEmbedder).toBe(fakeImages);
      const res = await fetch(`http://127.0.0.1:${withFake.port}/health`);
      expect(res.status).toBe(200);
    } finally {
      await withFake.stop();
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });
```
with `import { FakeImageEmbedder } from '../helpers/fakeImageEmbedder.js';` added to the imports.

### Step 29: Unit tests
**File:** `tests/unit/chat-status.test.ts` lines 8-24: replace the first test with
```ts
  it('is exactly the 18 notes tools, the 15 connector tools, WebSearch and WebFetch', () => {
    const tools = allowedChatTools();
    expect(NOTES_TOOL_NAMES).toHaveLength(18);
    expect(ALL_CONNECTOR_TOOL_NAMES).toHaveLength(15);
    expect(tools).toHaveLength(18 + 15 + 2);
    expect(new Set(tools).size).toBe(tools.length);
    expect(tools).toContain('mcp__notes__view_images');
    expect(tools).toContain('mcp__notes__create_image');
    expect(tools).toContain('mcp__notes__related');
    expect(tools).toContain('mcp__notes__attach_image');
    expect(tools).toContain('mcp__notes__remove_image');
    expect(tools).toContain('mcp__notes__restore_image');
    expect(tools).toContain('mcp__notes__similar_images');
    for (const name of ALL_CONNECTOR_TOOL_NAMES) expect(tools).toContain(n(name));
    expect(tools).toContain('WebSearch');
    expect(tools).toContain('WebFetch');
    expect(tools.filter((t) => !t.startsWith('mcp__notes__'))).toEqual(['WebSearch', 'WebFetch']);
  });
```
and add to the first `it.each` table (after the `related` row):
```ts
    [n('similar_images'), { image_id: 'A-B32' }, 'finding similar photos'],
```

**File:** `tests/unit/mcp.instructions.test.ts`: add inside `describe('buildInstructions', ...)`:
```ts
  it('has one Similar images paragraph: the four sources, what it leaves out, view_images after', () => {
    const paragraphs = buildInstructions('Asia/Jakarta')
      .split('\n\n')
      .filter((p) => p.startsWith('Similar images.'));
    expect(paragraphs).toHaveLength(1);
    const p = paragraphs[0]!;
    for (const word of ['similar_images', 'image_id', 'upload_id', 'query', 'pasted_image', '[image upload:ID]', 'view_images']) {
      expect(p).toContain(word);
    }
    expect(p).toContain('never the source image, a removed image or an image of a deleted note');
    const order = buildInstructions('Asia/Jakarta').split('\n\n').map((s) => s.split('.')[0]);
    expect(order.indexOf('Similar images')).toBe(order.indexOf('Files') + 1);
  });
```

**File:** `tests/unit/chat-prompt.test.ts`: add inside `describe('buildChatSystemPrompt', ...)`:
```ts
  it('tells the agent how pasted images appear and to use similar_images, then view_images', () => {
    expect(prompt).toContain('[image upload:ID]');
    expect(prompt).toMatch(/similar_images with upload_id/);
    expect(prompt).toMatch(/then call view_images on the top hits/);
  });
```

**File:** `tests/unit/embeddings/imageConstants.test.ts` (new)
```ts
import { describe, expect, it } from 'vitest';
import { noteImageEmbeddings } from '../../../src/db/schema.js';
import {
  IMAGE_EMBEDDING_DIMENSIONS,
  IMAGE_EMBEDDING_MODEL,
  IMAGE_EMBED_LONG_EDGE,
  estimateImageCostUsd,
  estimateImageTokens,
} from '../../../src/embeddings/imageConstants.js';

describe('image embedding constants', () => {
  it('name the verified model and match the column width under the HNSW cap', () => {
    expect(IMAGE_EMBEDDING_MODEL).toBe('google/gemini-embedding-2');
    expect(IMAGE_EMBEDDING_DIMENSIONS).toBe(1536);
    expect(IMAGE_EMBEDDING_DIMENSIONS).toBeLessThanOrEqual(2000);
    expect(noteImageEmbeddings.embedding.getSQLType()).toBe(`vector(${IMAGE_EMBEDDING_DIMENSIONS})`);
    expect(IMAGE_EMBED_LONG_EDGE).toBe(1024);
  });

  it.each([
    [12, 12, 258],
    [384, 384, 258],
    [385, 100, 258],
    [1024, 768, 516],
    [4000, 3000, 516],
    [3000, 4000, 516],
    [1024, 1024, 1032],
    [0, 0, 258],
  ])('estimateImageTokens(%i, %i) = %i', (w, h, tokens) => {
    expect(estimateImageTokens(w, h)).toBe(tokens);
  });

  it('prices image tokens at $0.45 per million', () => {
    expect(estimateImageCostUsd(1_000_000)).toBeCloseTo(0.45, 10);
    expect(estimateImageCostUsd(516)).toBeCloseTo(0.0002322, 10);
    expect(estimateImageCostUsd(-5)).toBe(0);
  });
});
```
(385x100 scales to itself; 385 > 384 so it is tiled: ceil(385/768)*ceil(100/768) = 1 tile = 258.)

**File:** `tests/unit/embeddings/openrouterImage.test.ts` (new)
```ts
import sharp from 'sharp';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { OPENROUTER_EMBEDDINGS_URL } from '../../../src/embeddings/constants.js';
import { EmbeddingError, embeddingErrorText } from '../../../src/embeddings/embedder.js';
import { IMAGE_EMBEDDING_DIMENSIONS, IMAGE_EMBEDDING_MODEL } from '../../../src/embeddings/imageConstants.js';
import {
  MAX_EMBED_PNG_BYTES,
  OPENROUTER_IMAGE_EMBED_TIMEOUT_MS,
  createOpenRouterImageEmbedder,
  fitVector,
  imageEmbedderFromConfig,
  isPng,
} from '../../../src/embeddings/openrouterImage.js';

const KEY = 'sk-or-v1-TEST-SECRET-0123456789';
let PNG: Buffer;

beforeAll(async () => {
  PNG = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 255, g: 0, b: 0 } } })
    .png()
    .toBuffer();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type Seen = { url: string; init: RequestInit; body: unknown };

function fakeFetch(answer: (body: unknown) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as unknown;
    seen.push({ url: String(url), init: init ?? {}, body });
    return answer(body);
  });
  return { f, seen };
}

function vectorOf(width: number, value = 1): number[] {
  return new Array<number>(width).fill(value);
}

function embedder(f: unknown, timeoutMs?: number) {
  return createOpenRouterImageEmbedder({
    apiKey: KEY,
    fetch: f as unknown as typeof fetch,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

async function failure(p: Promise<unknown>): Promise<EmbeddingError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(EmbeddingError);
    expect(embeddingErrorText(err)).not.toContain(KEY);
    expect((err as Error).message).not.toContain(KEY);
    return err as EmbeddingError;
  }
  throw new Error('expected a rejection');
}

describe('createOpenRouterImageEmbedder', () => {
  it('exposes the model and width, and refuses a blank key without a request', () => {
    const { f } = fakeFetch(() => json({ data: [{ index: 0, embedding: vectorOf(1536) }] }));
    const e = embedder(f);
    expect(e.model).toBe(IMAGE_EMBEDDING_MODEL);
    expect(e.dimensions).toBe(IMAGE_EMBEDDING_DIMENSIONS);
    expect(OPENROUTER_IMAGE_EMBED_TIMEOUT_MS).toBe(30_000);
    expect(() => createOpenRouterImageEmbedder({ apiKey: '  ', fetch: f as unknown as typeof fetch })).toThrow(EmbeddingError);
    expect(f).not.toHaveBeenCalled();
  });

  it('sends one image as an image-only content item with a PNG data URL', async () => {
    const { f, seen } = fakeFetch(() => json({ data: [{ index: 0, embedding: vectorOf(1536) }] }));
    await embedder(f).embedImage(PNG);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(OPENROUTER_EMBEDDINGS_URL);
    expect(seen[0]!.init.method).toBe('POST');
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0]!.body).toEqual({
      model: 'google/gemini-embedding-2',
      input: [{ content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } }] }],
      encoding_format: 'float',
      dimensions: 1536,
    });
  });

  it('sends a query as a text-only content item, trimmed', async () => {
    const { f, seen } = fakeFetch(() => json({ data: [{ embedding: vectorOf(1536) }] }));
    await embedder(f).embedText('  red top in a car \n');
    expect(seen[0]!.body).toEqual({
      model: 'google/gemini-embedding-2',
      input: [{ content: [{ type: 'text', text: 'red top in a car' }] }],
      encoding_format: 'float',
      dimensions: 1536,
    });
  });

  it('returns a 1536-wide answer L2-normalised', async () => {
    const { f } = fakeFetch(() => json({ data: [{ index: 0, embedding: vectorOf(1536, 3) }] }));
    const v = await embedder(f).embedImage(PNG);
    expect(v).toHaveLength(1536);
    expect(Math.hypot(...v)).toBeCloseTo(1, 10);
    expect(v[0]).toBeCloseTo(1 / Math.sqrt(1536), 12);
  });

  it('cuts a 3072-wide answer to its first 1536 values and renormalises them', async () => {
    const wide = [...vectorOf(1536, 2), ...vectorOf(1536, 1000)];
    const { f } = fakeFetch(() => json({ data: [{ index: 0, embedding: wide }] }));
    const v = await embedder(f).embedText('red');
    expect(v).toHaveLength(1536);
    expect(v.every((x) => Math.abs(x - 1 / Math.sqrt(1536)) < 1e-12)).toBe(true);
  });

  it('refuses a narrower vector, a non-number value and a zero vector', async () => {
    const cases: Array<[unknown[], RegExp]> = [
      [vectorOf(1000), /1000 value\(s\).*vector\(1536\)/],
      // JSON cannot carry NaN; a null element is what a broken provider would send instead.
      [[...vectorOf(1535), null], /non-finite/],
      [vectorOf(1536, 0), /zero length/],
    ];
    for (const [embedding, pattern] of cases) {
      const { f } = fakeFetch(() => json({ data: [{ index: 0, embedding }] }));
      const err = await failure(embedder(f).embedImage(PNG));
      expect(err.message).toMatch(pattern);
    }
    expect(() => fitVector([...vectorOf(1535), Number.NaN])).toThrow(/non-finite/);
  });

  it('refuses non-PNG bytes, an oversized PNG and an empty query without a request', async () => {
    const { f } = fakeFetch(() => json({ data: [{ embedding: vectorOf(1536) }] }));
    const e = embedder(f);
    await failure(e.embedImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5])));
    const big = new Uint8Array(MAX_EMBED_PNG_BYTES + 1);
    big.set(PNG.subarray(0, 8));
    await failure(e.embedImage(big));
    await failure(e.embedText('   '));
    expect(f).not.toHaveBeenCalled();
  });

  it('turns transport, status, JSON and shape problems into EmbeddingError without the key', async () => {
    const cases: Array<[() => Promise<Response>, RegExp]> = [
      [async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }, /timed out after 5 ms/],
      [async () => { throw new TypeError('fetch failed'); }, /embedding request failed/],
      [async () => new Response(`upstream says no; key ${KEY}`.replace(KEY, 'xxx'), { status: 502 }), /returned 502/],
      [async () => new Response('<html>', { status: 200 }), /not valid JSON/],
      [async () => json({ nope: true }), /no data array/],
      [async () => json({ data: [{ embedding: vectorOf(1536) }, { embedding: vectorOf(1536) }] }), /2 vector\(s\) for 1 input/],
      [async () => json({ data: [{ index: 3, embedding: vectorOf(1536) }] }), /bad index 3/],
      [async () => json({ data: [{ index: 0, embedding: 'AAAA' }] }), /no vector at data\[0\]\.embedding/],
    ];
    for (const [answer, pattern] of cases) {
      const f = vi.fn(answer);
      const err = await failure(embedder(f, 5).embedImage(PNG));
      expect(err.message).toMatch(pattern);
    }
  });

  it('imageEmbedderFromConfig is null without a key', () => {
    expect(imageEmbedderFromConfig({ apiKey: null })).toBeNull();
    expect(imageEmbedderFromConfig({ apiKey: KEY })?.model).toBe(IMAGE_EMBEDDING_MODEL);
  });
});

describe('fitVector and isPng', () => {
  it('keeps the first width values, normalised, and asserts the width', () => {
    expect(fitVector([3, 4, 99], 2)).toEqual([0.6, 0.8]);
    expect(() => fitVector([1], 2)).toThrow(EmbeddingError);
  });

  it('recognises the PNG signature', () => {
    expect(isPng(PNG)).toBe(true);
    expect(isPng(PNG.subarray(0, 8))).toBe(false);
    expect(isPng(new Uint8Array([1, 2, 3]))).toBe(false);
  });
});
```

**File:** `tests/unit/embeddings/fakeImageEmbedder.test.ts` (new)
```ts
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { EmbeddingError } from '../../../src/embeddings/embedder.js';
import { IMAGE_EMBEDDING_DIMENSIONS, IMAGE_EMBEDDING_MODEL } from '../../../src/embeddings/imageConstants.js';
import { cosine } from '../../helpers/fakeEmbedder.js';
import { FakeImageEmbedder, vectorForColour, vectorForHash } from '../../helpers/fakeImageEmbedder.js';

function solid(rgb: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: rgb } }).png().toBuffer();
}

describe('FakeImageEmbedder', () => {
  it('uses the real model id and width, and returns unit vectors', async () => {
    const fake = new FakeImageEmbedder();
    expect(fake.model).toBe(IMAGE_EMBEDDING_MODEL);
    expect(fake.dimensions).toBe(IMAGE_EMBEDDING_DIMENSIONS);
    const v = await fake.embedImage(await solid({ r: 200, g: 10, b: 10 }));
    expect(v).toHaveLength(IMAGE_EMBEDDING_DIMENSIONS);
    expect(Math.hypot(...v)).toBeCloseTo(1, 10);
  });

  it('is deterministic, and similar colours are close while different ones are far', async () => {
    const fake = new FakeImageEmbedder();
    const red = await fake.embedImage(await solid({ r: 220, g: 20, b: 20 }));
    const again = await fake.embedImage(await solid({ r: 220, g: 20, b: 20 }));
    const darkRed = await fake.embedImage(await solid({ r: 110, g: 10, b: 10 }));
    const blue = await fake.embedImage(await solid({ r: 20, g: 20, b: 220 }));
    expect(again).toEqual(red);
    expect(cosine(red, darkRed)).toBeGreaterThan(0.99);
    // red . blue = ~0.19 with the 0.05 bias axis; far enough apart for every ordering test.
    expect(cosine(red, blue)).toBeLessThan(0.5);
  });

  it('maps colour words into the image space and hashes other text', async () => {
    const fake = new FakeImageEmbedder();
    const red = await fake.embedImage(await solid({ r: 220, g: 20, b: 20 }));
    expect(cosine(await fake.embedText('red top in a car'), red)).toBeGreaterThan(0.99);
    expect(await fake.embedText('a whiteboard')).toEqual(vectorForHash('a whiteboard'));
    expect(cosine(vectorForHash('a whiteboard'), vectorForColour({ r: 0, g: 0, b: 0 }))).toBe(0);
  });

  it('validates like the real client, records calls and scripts failures', async () => {
    const fake = new FakeImageEmbedder();
    await expect(fake.embedImage(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(EmbeddingError);
    await expect(fake.embedText('  ')).rejects.toBeInstanceOf(EmbeddingError);
    expect(fake.calls).toEqual([]);
    fake.failNext(1);
    await expect(fake.embedText('red')).rejects.toThrow(/scripted failure/);
    await expect(fake.embedText('red')).resolves.toHaveLength(IMAGE_EMBEDDING_DIMENSIONS);
    expect(fake.calls).toEqual([
      { kind: 'text', text: 'red' },
      { kind: 'text', text: 'red' },
    ]);
  });
});
```

**File:** `tests/unit/embeddings/imageBackfill.test.ts` (new)
```ts
import { describe, expect, it } from 'vitest';
import type { Clock } from '../../../src/embeddings/backfill.js';
import {
  UnavailableImages,
  runImageBackfill,
  type ImageEmbeddingStore,
  type ImageReport,
} from '../../../src/embeddings/imageBackfill.js';
import type { ImageEmbedder } from '../../../src/embeddings/imageEmbedder.js';
import type { PendingImage } from '../../../src/embeddings/imageRepo.js';
import { OriginalMissingError } from '../../../src/images/derive.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);

function image(id: string): PendingImage {
  return { id, noteId: id, path: `images/2026/10/${id}.png`, mime: 'image/png', sha256: `sha-${id}`, width: 12, height: 12, host: 'here', live: true };
}

class MemoryImageStore implements ImageEmbeddingStore {
  images: PendingImage[] = [];
  readonly available = new Set<string>();
  readonly vectors = new Map<string, number[]>();
  readonly failures = new Map<string, { attempts: number; error: string }>();
  readonly missingOnLoad = new Set<string>();
  readonly corrupt = new Set<string>();
  listCalls = 0;
  lastExclude: readonly string[] = [];
  /** List failed images again (as with ignoreBackoff), to prove the run settles them. */
  listFailed = false;

  add(id: string, available = true): void {
    this.images.push(image(id));
    if (available) this.available.add(id);
  }

  async listPending(opts: { model: string; limit: number; excludeIds: readonly string[] }): Promise<PendingImage[]> {
    this.listCalls += 1;
    this.lastExclude = opts.excludeIds;
    const exclude = new Set(opts.excludeIds);
    return this.images
      .filter((i) => !this.vectors.has(i.id) && (this.listFailed || !this.failures.has(i.id)) && !exclude.has(i.id))
      .slice(0, opts.limit);
  }

  async isAvailable(i: PendingImage): Promise<boolean> {
    return this.available.has(i.id);
  }

  async loadPng(i: PendingImage): Promise<Uint8Array> {
    if (this.missingOnLoad.has(i.id)) throw new OriginalMissingError(i.id, `/data/${i.path}`);
    if (this.corrupt.has(i.id)) throw new Error('Input buffer contains unsupported image format');
    return PNG;
  }

  async save(v: { imageId: string; embedding: number[] }): Promise<boolean> {
    this.vectors.set(v.imageId, v.embedding);
    return true;
  }

  async recordFailure(v: { imageId: string; error: string }): Promise<void> {
    const prev = this.failures.get(v.imageId);
    this.failures.set(v.imageId, { attempts: (prev?.attempts ?? 0) + 1, error: v.error });
  }
}

class ScriptedImageEmbedder implements ImageEmbedder {
  readonly model = 'test/images';
  readonly dimensions = 3;
  calls = 0;
  failIf: ((call: number) => boolean) | null = null;

  async embedImage(): Promise<number[]> {
    this.calls += 1;
    if (this.failIf?.(this.calls)) throw new Error(`scripted image failure ${this.calls}`);
    return [1, 0, 0];
  }

  async embedText(): Promise<number[]> {
    return [0, 1, 0];
  }
}

function fakeClock(): Clock & { t: number; slept: number[] } {
  const c = {
    t: 0,
    slept: [] as number[],
    now: () => c.t,
    sleep: async (ms: number) => {
      c.slept.push(ms);
      c.t += ms;
    },
  };
  return c;
}

describe('runImageBackfill', () => {
  it('embeds every available image once, one call per image', async () => {
    const store = new MemoryImageStore();
    for (const id of ['A-001', 'A-002', 'A-003']) store.add(id);
    const embedder = new ScriptedImageEmbedder();
    const r = await runImageBackfill({ store, embedder, minIntervalMs: 0 });
    expect(r).toMatchObject({ calls: 3, embedded: 3, failed: 0, unavailable: 0, aborted: false, limited: false });
    expect([...store.vectors.keys()].sort()).toEqual(['A-001', 'A-002', 'A-003']);
  });

  it('skips images not on this machine without a failure, and is not starved behind them', async () => {
    const store = new MemoryImageStore();
    for (let i = 0; i < 50; i += 1) store.add(`U-${String(i).padStart(3, '0')}`, false);
    store.add('L-001');
    const embedder = new ScriptedImageEmbedder();
    const r = await runImageBackfill({ store, embedder, minIntervalMs: 0, pageSize: 4 });
    expect(r).toMatchObject({ calls: 1, embedded: 1, failed: 0, unavailable: 50 });
    expect(store.failures.size).toBe(0);
    expect(store.vectors.has('L-001')).toBe(true);
  });

  it('remembers missing originals across runs until the recheck time', async () => {
    const store = new MemoryImageStore();
    for (let i = 0; i < 10; i += 1) store.add(`U-${String(i).padStart(3, '0')}`, false);
    const clock = fakeClock();
    const memo = new UnavailableImages(1_000, clock);
    const embedder = new ScriptedImageEmbedder();
    expect((await runImageBackfill({ store, embedder, clock, minIntervalMs: 0, unavailable: memo })).unavailable).toBe(10);
    store.listCalls = 0;
    const second = await runImageBackfill({ store, embedder, clock, minIntervalMs: 0, unavailable: memo });
    expect(second.unavailable).toBe(0);
    expect(store.listCalls).toBe(1);
    expect(store.lastExclude).toHaveLength(10);
    clock.t += 1_001;
    expect((await runImageBackfill({ store, embedder, clock, minIntervalMs: 0, unavailable: memo })).unavailable).toBe(10);
  });

  it('an original vanishing after the check is unavailable, a bad PNG is a recorded failure', async () => {
    const store = new MemoryImageStore();
    store.add('V-001');
    store.add('C-001');
    store.missingOnLoad.add('V-001');
    store.corrupt.add('C-001');
    const embedder = new ScriptedImageEmbedder();
    const r = await runImageBackfill({ store, embedder, minIntervalMs: 0 });
    expect(r).toMatchObject({ calls: 0, unavailable: 1, failed: 1 });
    expect(store.failures.has('V-001')).toBe(false);
    expect(store.failures.get('C-001')?.error).toMatch(/^could not prepare the image: /);
  });

  it('records an embedding failure and never retries it in the same run', async () => {
    const store = new MemoryImageStore();
    store.listFailed = true;
    store.add('F-001');
    store.add('F-002');
    const embedder = new ScriptedImageEmbedder();
    embedder.failIf = (n) => n === 1;
    const reports: ImageReport[] = [];
    const r = await runImageBackfill({ store, embedder, minIntervalMs: 0, onImage: (x) => reports.push(x) });
    expect(r).toMatchObject({ calls: 2, embedded: 1, failed: 1 });
    expect(store.failures.get('F-001')).toEqual({ attempts: 1, error: 'scripted image failure 1' });
    expect(reports.map((x) => x.outcome)).toEqual(['failed', 'embedded']);
  });

  it('stops at maxImages and says so', async () => {
    const store = new MemoryImageStore();
    for (const id of ['A-001', 'A-002', 'A-003']) store.add(id);
    const r = await runImageBackfill({ store, embedder: new ScriptedImageEmbedder(), minIntervalMs: 0, maxImages: 2 });
    expect(r).toMatchObject({ embedded: 2, limited: true });
  });

  it('makes no call once the signal has aborted', async () => {
    const store = new MemoryImageStore();
    store.add('A-001');
    const stop = new AbortController();
    stop.abort();
    const embedder = new ScriptedImageEmbedder();
    const r = await runImageBackfill({ store, embedder, minIntervalMs: 0, signal: stop.signal });
    expect(r).toMatchObject({ calls: 0, aborted: true });
    expect(embedder.calls).toBe(0);
  });

  it('spaces calls by minIntervalMs on the injected clock', async () => {
    const store = new MemoryImageStore();
    for (const id of ['A-001', 'A-002', 'A-003']) store.add(id);
    const clock = fakeClock();
    await runImageBackfill({ store, embedder: new ScriptedImageEmbedder(), minIntervalMs: 1_000, clock });
    expect(clock.slept).toEqual([1_000, 1_000]);
  });

  it('stops when a store ignores excludeIds and lists only settled images', async () => {
    const store = new MemoryImageStore();
    store.add('U-001', false);
    store.listPending = async () => [image('U-001')];
    const r = await runImageBackfill({ store, embedder: new ScriptedImageEmbedder(), minIntervalMs: 0 });
    expect(r.unavailable).toBe(1);
  });
});
```

**File:** `tests/unit/similarTools.test.ts` (new)
```ts
import { describe, expect, it } from 'vitest';
import {
  IMAGE_SEARCH_OFF,
  PASTED_IMAGE_NEEDS_HOOK,
  SIMILAR_SNIPPET_CHARS,
  bodySnippet,
  countSources,
} from '../../src/mcp/similarTools.js';

describe('similar_images helpers', () => {
  it('countSources counts the four mutually exclusive inputs, not limit', () => {
    expect(countSources({})).toBe(0);
    expect(countSources({ image_id: 'A-B32', limit: 5 })).toBe(1);
    expect(countSources({ image_id: 'A-B32', query: 'red' })).toBe(2);
    expect(countSources({ upload_id: 'K-7F2', pasted_image: 1, query: 'x', image_id: 'y' })).toBe(4);
  });

  it('bodySnippet collapses whitespace and cuts at 200 characters with an ellipsis', () => {
    expect(bodySnippet('  red top\n\nin a car  #pics ')).toBe('red top in a car #pics');
    const long = 'x'.repeat(250);
    const cut = bodySnippet(long);
    expect(cut).toHaveLength(SIMILAR_SNIPPET_CHARS);
    expect(cut.endsWith('…')).toBe(true);
    const emoji = `${'a'.repeat(198)}😀tail`;
    expect(bodySnippet(emoji)).toBe(`${'a'.repeat(198)}…`);
  });

  it('the fixed answers name the fix', () => {
    expect(PASTED_IMAGE_NEEDS_HOOK).toContain('scripts/install.sh');
    expect(PASTED_IMAGE_NEEDS_HOOK).toContain('image_id');
    expect(IMAGE_SEARCH_OFF).toContain('OPENROUTER_API_KEY');
  });
});
```

### Step 30: Integration tests
**File:** `tests/integration/imageEmbeddings.repo.int.test.ts` (new)
```ts
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IMAGE_EMBEDDING_MODEL } from '../../src/embeddings/imageConstants.js';
import {
  imageEmbeddingStats,
  listPendingImages,
  nearestImages,
  recordImageFailure,
  saveImageEmbedding,
} from '../../src/embeddings/imageRepo.js';
import { setImageDeleted } from '../../src/notes/imageRepo.js';
import { vectorForColour, type Rgb } from '../helpers/fakeImageEmbedder.js';
import { addImage, startHarness, type Harness } from './imageHarness.js';

const M = IMAGE_EMBEDDING_MODEL;
const RED: Rgb = { r: 220, g: 20, b: 20 };
const RED2: Rgb = { r: 221, g: 20, b: 20 };
const RED3: Rgb = { r: 219, g: 21, b: 20 };
const DARK_RED: Rgb = { r: 110, g: 10, b: 10 };
const BLUE: Rgb = { r: 20, g: 20, b: 220 };
const GREEN: Rgb = { r: 20, g: 200, b: 20 };

type EmbRow = { image_sha256: string; model: string; has_vector: boolean; attempts: number; last_error: string | null; due: boolean };

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
});

/** A note created through the service (tags parsed) holding one image of colour `rgb`; returns the image id (= note id). */
async function photo(rgb: Rgb, body = 'a photo #pics'): Promise<string> {
  const note = await h.deps.service.create({ body });
  return addImage(h, note.id, note.id, 0, rgb);
}

async function shaOf(imageId: string): Promise<string> {
  const r = await h.deps.db.execute<{ sha256: string }>(sql`select sha256 from note_images where id = ${imageId}`);
  return r.rows[0]!.sha256;
}

async function embed(imageId: string, rgb: Rgb, model = M): Promise<boolean> {
  return saveImageEmbedding(h.deps.db, { imageId, imageSha256: await shaOf(imageId), model, embedding: vectorForColour(rgb) });
}

async function row(imageId: string): Promise<EmbRow | null> {
  const r = await h.deps.db.execute<EmbRow>(sql`
    select image_sha256, model, embedding is not null as has_vector, attempts, last_error,
           (next_attempt_at is null or next_attempt_at <= now()) as due
    from note_image_embeddings where image_id = ${imageId}
  `);
  return r.rows[0] ?? null;
}

describe('listPendingImages', () => {
  it('lists every image without a current vector, live ones of live notes first, and honours excludeIds', async () => {
    const a = await photo(RED);
    const b = await photo(BLUE);
    const c = await photo(GREEN);
    await setImageDeleted(h.deps.db, b, true);
    await h.deps.service.delete(c);
    const pending = await listPendingImages(h.deps.db, { model: M, limit: 10 });
    expect(pending.map((p) => p.id).sort()).toEqual([a, b, c].sort());
    expect(pending[0]).toMatchObject({ id: a, noteId: a, live: true, width: 12, height: 12, mime: 'image/png' });
    expect(pending.filter((p) => !p.live).map((p) => p.id).sort()).toEqual([b, c].sort());
    const excluded = await listPendingImages(h.deps.db, { model: M, limit: 10, excludeIds: [a, c] });
    expect(excluded.map((p) => p.id)).toEqual([b]);
  });

  it('a current vector leaves the list; another model or other bytes bring it back', async () => {
    const a = await photo(RED);
    expect(await embed(a, RED)).toBe(true);
    expect(await listPendingImages(h.deps.db, { model: M, limit: 10 })).toEqual([]);
    expect((await listPendingImages(h.deps.db, { model: 'other/model', limit: 10 })).map((p) => p.id)).toEqual([a]);
    await h.deps.db.execute(sql`update note_images set sha256 = ${'e'.repeat(64)} where id = ${a}`);
    expect((await listPendingImages(h.deps.db, { model: M, limit: 10 })).map((p) => p.id)).toEqual([a]);
  });
});

describe('saveImageEmbedding / recordImageFailure', () => {
  it('saving is guarded by the image sha and rejects a wrong width', async () => {
    const a = await photo(RED);
    expect(
      await saveImageEmbedding(h.deps.db, { imageId: a, imageSha256: 'f'.repeat(64), model: M, embedding: vectorForColour(RED) }),
    ).toBe(false);
    expect(await row(a)).toBeNull();
    await expect(
      saveImageEmbedding(h.deps.db, { imageId: a, imageSha256: await shaOf(a), model: M, embedding: [1, 0, 0] }),
    ).rejects.toThrow(/3 dimensions, expected 1536/);
    expect(await embed(a, RED)).toBe(true);
    expect(await row(a)).toMatchObject({ has_vector: true, attempts: 0, model: M });
  });

  it('failures count attempts and back off, and never overwrite a current vector', async () => {
    const a = await photo(RED);
    const sha = await shaOf(a);
    await recordImageFailure(h.deps.db, { imageId: a, imageSha256: sha, model: M, error: 'boom Bearer sk-or-v1-SECRET' });
    expect(await row(a)).toMatchObject({ has_vector: false, attempts: 1, due: false });
    expect((await row(a))!.last_error).not.toContain('SECRET');
    expect(await listPendingImages(h.deps.db, { model: M, limit: 10 })).toEqual([]);
    expect((await listPendingImages(h.deps.db, { model: M, limit: 10, ignoreBackoff: true })).map((p) => p.id)).toEqual([a]);
    await recordImageFailure(h.deps.db, { imageId: a, imageSha256: sha, model: M, error: 'again' });
    expect(await row(a)).toMatchObject({ attempts: 2 });
    expect(await embed(a, RED)).toBe(true);
    await recordImageFailure(h.deps.db, { imageId: a, imageSha256: sha, model: M, error: 'late failure from the other laptop' });
    expect(await row(a)).toMatchObject({ has_vector: true, attempts: 0 });
  });
});

describe('nearestImages', () => {
  it('from an image: closest first, never the source, a removed image or a deleted note', async () => {
    const a = await photo(RED);
    const b = await photo(DARK_RED);
    const c = await photo(BLUE);
    const d = await photo(RED2);
    const e = await photo(RED3);
    for (const [id, rgb] of [[a, RED], [b, DARK_RED], [c, BLUE], [d, RED2], [e, RED3]] as const) await embed(id, rgb);
    await setImageDeleted(h.deps.db, d, true);
    await h.deps.service.delete(e);
    const hits = await nearestImages(h.deps.db, { source: { imageId: a }, model: M, limit: 10 });
    expect(hits!.map((x) => x.imageId)).toEqual([b, c]);
    expect(hits![0]!.noteId).toBe(b);
    expect(hits![0]!.similarity).toBeGreaterThan(0.99);
    expect(hits![1]!.similarity).toBeLessThan(0.5);
    expect(Number.isInteger(hits![0]!.similarity * 10_000)).toBe(true);
  });

  it('null for a source without a current vector; a raw vector source is never null', async () => {
    const a = await photo(RED);
    const b = await photo(DARK_RED);
    await embed(a, RED, 'other/model');
    await embed(b, DARK_RED);
    expect(await nearestImages(h.deps.db, { source: { imageId: a }, model: M, limit: 5 })).toBeNull();
    const fromVector = await nearestImages(h.deps.db, { source: { vector: vectorForColour(RED) }, model: M, limit: 5 });
    expect(fromVector!.map((x) => x.imageId)).toEqual([b]);
    await expect(nearestImages(h.deps.db, { source: { vector: [1, 2] }, model: M, limit: 5 })).rejects.toThrow(/2 dimensions/);
  });

  it('respects limit', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const rgb = { r: 200 + i, g: 20, b: 20 };
      const id = await photo(rgb);
      await embed(id, rgb);
      ids.push(id);
    }
    expect(await nearestImages(h.deps.db, { source: { imageId: ids[0]! }, model: M, limit: 2 })).toHaveLength(2);
  });
});

describe('imageEmbeddingStats and the migration', () => {
  it('counts images, current, pending and failing', async () => {
    const a = await photo(RED);
    const b = await photo(BLUE);
    await photo(GREEN);
    await embed(a, RED);
    await recordImageFailure(h.deps.db, { imageId: b, imageSha256: await shaOf(b), model: M, error: 'x' });
    expect(await imageEmbeddingStats(h.deps.db, M)).toEqual({ images: 3, current: 1, pending: 2, failing: 1 });
  });

  it('created the HNSW cosine index, and rows go away with their image', async () => {
    const idx = await h.deps.db.execute<{ indexname: string; indexdef: string }>(sql`
      select indexname, indexdef from pg_indexes where tablename = 'note_image_embeddings'
    `);
    const byName = new Map(idx.rows.map((r) => [r.indexname, r.indexdef]));
    expect(byName.get('note_image_embeddings_embedding_hnsw_idx')).toMatch(/hnsw .*vector_cosine_ops/);
    expect(byName.has('note_image_embeddings_next_attempt_idx')).toBe(true);
    const a = await photo(RED);
    await embed(a, RED);
    await h.deps.db.execute(sql`delete from notes where id = ${a}`);
    expect(await row(a)).toBeNull();
  });
});
```

**File:** `tests/integration/imageEmbeddings.worker.int.test.ts` (new)
```ts
import { rm } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startBackground } from '../../src/background.js';
import { embedImagesBackfill } from '../../src/cli/embedImagesBackfill.js';
import type { Db } from '../../src/db/client.js';
import { dbImageEmbeddingStore, runImageBackfill } from '../../src/embeddings/imageBackfill.js';
import { startImageEmbeddingWorker } from '../../src/embeddings/imageWorker.js';
import type { EmbeddingWorker } from '../../src/embeddings/worker.js';
import { imageDeps, ingestImage } from '../../src/images/ingest.js';
import { FakeImageEmbedder, type Rgb } from '../helpers/fakeImageEmbedder.js';
import { addImage, makeImage, originalPathOf, startHarness, type Harness } from './imageHarness.js';
import { closeTestDb, openTestDb } from './setup.js';

type EmbRow = { has_vector: boolean; attempts: number; last_error: string | null; due: boolean };

let h: Harness;
let worker: EmbeddingWorker | null = null;

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
});
afterEach(async () => {
  await worker?.close();
  worker = null;
});

async function row(imageId: string): Promise<EmbRow | null> {
  const r = await h.deps.db.execute<EmbRow>(sql`
    select embedding is not null as has_vector, attempts, last_error,
           (next_attempt_at is null or next_attempt_at <= now()) as due
    from note_image_embeddings where image_id = ${imageId}
  `);
  return r.rows[0] ?? null;
}

async function until(cond: () => Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function photo(rgb: Rgb): Promise<string> {
  const note = await h.deps.service.create({ body: 'a photo #pics' });
  return addImage(h, note.id, note.id, 0, rgb);
}

/** A photo whose original is then removed: it lives "on the other laptop". */
async function foreignPhoto(rgb: Rgb): Promise<string> {
  const id = await photo(rgb);
  await rm(await originalPathOf(h, id));
  return id;
}

function store() {
  return dbImageEmbeddingStore(h.deps.db, h.dataDir);
}

describe('image embedding worker', () => {
  it('embeds an image note as soon as it is created, and logs one summary line', async () => {
    const fake = new FakeImageEmbedder();
    const logs: string[] = [];
    worker = startImageEmbeddingWorker({
      store: store(),
      events: h.deps.events,
      embedder: fake,
      minIntervalMs: 0,
      debounceMs: 0,
      sweepMs: 3_600_000,
      log: (l) => logs.push(l),
    });
    await worker.idle();
    const { note } = await ingestImage(imageDeps(h.deps), {
      bytes: await makeImage('png', 40, 30, { r: 220, g: 20, b: 20 }),
      originalName: 'red.png',
      body: 'red top #pics',
    });
    await until(async () => (await row(note.images[0]!.id))?.has_vector === true);
    await worker.idle();
    expect(fake.calls).toEqual([{ kind: 'image', bytes: expect.any(Number) }]);
    expect(logs.some((l) => /^\[notesd\] image embeddings: 1 embedded, 1 call, \d+ms$/.test(l))).toBe(true);
  });

  it('skips images not on this machine without a failure, and still reaches a local one behind them', async () => {
    const local = await photo({ r: 1, g: 2, b: 3 });
    const foreign: string[] = [];
    for (let i = 0; i < 10; i += 1) foreign.push(await foreignPhoto({ r: 10 + i * 20, g: 50, b: 50 }));
    const fake = new FakeImageEmbedder();
    const r = await runImageBackfill({ store: store(), embedder: fake, minIntervalMs: 0, pageSize: 3 });
    expect(r).toMatchObject({ embedded: 1, failed: 0, unavailable: 10, calls: 1 });
    expect((await row(local))?.has_vector).toBe(true);
    for (const id of foreign) expect(await row(id)).toBeNull();
  });

  it('a failing call is recorded with backoff and not retried before it is due', async () => {
    const id = await photo({ r: 220, g: 20, b: 20 });
    const fake = new FakeImageEmbedder();
    fake.failNext(1);
    expect(await runImageBackfill({ store: store(), embedder: fake, minIntervalMs: 0 })).toMatchObject({ failed: 1, calls: 1 });
    expect(await row(id)).toMatchObject({ has_vector: false, attempts: 1, due: false });
    expect((await row(id))!.last_error).toMatch(/scripted failure/);
    expect((await runImageBackfill({ store: store(), embedder: fake, minIntervalMs: 0 })).calls).toBe(0);
    expect((await runImageBackfill({ store: store(), embedder: fake, minIntervalMs: 0, ignoreBackoff: true })).embedded).toBe(1);
  });
});

describe('startBackground', () => {
  it('runs the image worker when an image embedder is configured', async () => {
    const fake = new FakeImageEmbedder();
    const id = await photo({ r: 20, g: 20, b: 220 });
    const stop = await startBackground({ ...h.deps, imageEmbedder: fake });
    try {
      await until(async () => (await row(id))?.has_vector === true);
    } finally {
      await stop();
    }
  });

  it('logs "image search off" once and embeds nothing without one', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const id = await photo({ r: 20, g: 200, b: 20 });
    const stop = await startBackground({ ...h.deps, imageEmbedder: null });
    try {
      await new Promise((r) => setTimeout(r, 200));
      expect(await row(id)).toBeNull();
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines.filter((l) => l.includes('image search off'))).toHaveLength(1);
      expect(lines.filter((l) => l.includes('embeddings off'))).toHaveLength(1);
    } finally {
      await stop();
      log.mockRestore();
    }
  });
});

describe('npm run embed:images:backfill', () => {
  function cli(fake: FakeImageEmbedder | null, out: string[], err: string[], apiKey: string | null = 'test-key') {
    return {
      loadConfig: () => ({ ...h.deps.config, embeddings: { apiKey } }),
      createDb: () => openTestDb(),
      closeDb: async (d: Db) => closeTestDb(d),
      createEmbedder: (key: string) => {
        expect(key).toBe('test-key');
        if (fake === null) throw new Error('a dry run must not build an embedder');
        return fake;
      },
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
      minIntervalMs: 0,
    };
  }

  it('--dry-run counts and estimates without a key, a call or a write', async () => {
    await photo({ r: 220, g: 20, b: 20 });
    await photo({ r: 20, g: 20, b: 220 });
    await foreignPhoto({ r: 20, g: 200, b: 20 });
    const out: string[] = [];
    const err: string[] = [];
    expect(await embedImagesBackfill(['--dry-run'], cli(null, out, err, null))).toBe(0);
    expect(out[0]).toMatch(/3 images, 0 current, 3 pending \(0 failing\)/);
    expect(out).toContain('dry run: 3 due now, 2 on this machine, 1 on another machine (skipped here)');
    expect(out.join('\n')).toMatch(/would send 2 image\(s\): about 516 image tokens, about \$0\.0002 at \$0\.45 per million image tokens \(estimate\)/);
    expect(out.at(-1)).toBe('dry run: nothing was sent and nothing was written');
    expect(err).toEqual([]);
    const rows = await h.deps.db.execute<{ n: number }>(sql`select count(*)::int as n from note_image_embeddings`);
    expect(rows.rows[0]!.n).toBe(0);
  });

  it('--limit N sends at most N images and says so', async () => {
    for (const r of [200, 210, 220]) await photo({ r, g: 20, b: 20 });
    const fake = new FakeImageEmbedder();
    const out: string[] = [];
    expect(await embedImagesBackfill(['--limit', '2'], cli(fake, out, []))).toBe(0);
    expect(fake.calls).toHaveLength(2);
    expect(out).toContain('stopped at --limit 2; run again for the rest');
    expect(out.join('\n')).toMatch(/done: embedded 2, failed 0, 0 not on this machine; 1 pending/);
  });

  it('refuses bad arguments and a missing key', async () => {
    const err: string[] = [];
    expect(await embedImagesBackfill(['--limit', '0'], cli(null, [], err))).toBe(2);
    expect(await embedImagesBackfill(['--nope'], cli(null, [], err))).toBe(2);
    expect(await embedImagesBackfill([], cli(null, [], err, null))).toBe(1);
    expect(err.join('\n')).toMatch(/OPENROUTER_API_KEY is not set/);
  });

  it('--retry-failed retries a failed image without waiting for its backoff', async () => {
    const id = await photo({ r: 220, g: 20, b: 20 });
    const failing = new FakeImageEmbedder();
    failing.failNext(1);
    expect(await embedImagesBackfill([], cli(failing, [], []))).toBe(1);
    const healthy = new FakeImageEmbedder();
    const out1: string[] = [];
    expect(await embedImagesBackfill([], cli(healthy, out1, []))).toBe(0);
    expect(healthy.calls).toEqual([]);
    expect(out1.join('\n')).toMatch(/--retry-failed/);
    expect(await embedImagesBackfill(['--retry-failed'], cli(healthy, [], []))).toBe(0);
    expect((await row(id))?.has_vector).toBe(true);
  });
});
```

**File:** `tests/integration/similarImages.mcp.int.test.ts` (new)
```ts
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dbImageEmbeddingStore, runImageBackfill } from '../../src/embeddings/imageBackfill.js';
import { mcpToolDeps } from '../../src/http/app.js';
import { createMcpServer } from '../../src/mcp/server.js';
import type { SimilarImagesResult } from '../../src/mcp/similarTools.js';
import type { ToolDeps } from '../../src/mcp/tools.js';
import { normalizeId } from '../../src/notes/ids.js';
import { setImageDeleted } from '../../src/notes/imageRepo.js';
import { FakeImageEmbedder, type Rgb } from '../helpers/fakeImageEmbedder.js';
import { addImage, makeImage, originalPathOf, startHarness, type Harness } from './imageHarness.js';

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

const RED: Rgb = { r: 220, g: 20, b: 20 };
const RED2: Rgb = { r: 221, g: 20, b: 20 };
const RED3: Rgb = { r: 219, g: 21, b: 20 };
const DARK_RED: Rgb = { r: 110, g: 10, b: 10 };
const BLUE: Rgb = { r: 20, g: 20, b: 220 };

function text(r: ToolResult): string {
  return r.content.map((c) => c.text ?? '').join('\n');
}

describe('similar_images over MCP', () => {
  const fake = new FakeImageEmbedder();
  let h: Harness;
  let client: Client;

  beforeAll(async () => {
    h = await startHarness({ imageEmbedder: fake });
    const base = await h.listen();
    client = new Client({ name: 'p6-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  });
  afterAll(async () => {
    await client.close();
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    fake.reset();
  });

  async function call(args: Record<string, unknown>, c: Client = client): Promise<ToolResult> {
    return (await c.callTool({ name: 'similar_images', arguments: args })) as ToolResult;
  }

  async function ok(args: Record<string, unknown>, c: Client = client): Promise<SimilarImagesResult> {
    const r = await call(args, c);
    expect(r.isError, text(r)).toBeFalsy();
    return JSON.parse(text(r)) as SimilarImagesResult;
  }

  async function photo(rgb: Rgb, body = 'a photo #pics'): Promise<string> {
    const note = await h.deps.service.create({ body });
    return addImage(h, note.id, note.id, 0, rgb);
  }

  async function embedAll(): Promise<void> {
    await runImageBackfill({ store: dbImageEmbeddingStore(h.deps.db, h.dataDir), embedder: fake, minIntervalMs: 0 });
    fake.reset();
  }

  async function inProcess(overrides: Partial<ToolDeps>): Promise<Client> {
    const server = createMcpServer({ ...mcpToolDeps(h.deps), ...overrides });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const c = new Client({ name: 'p6-in-process', version: '0.0.0' });
    await c.connect(clientSide);
    return c;
  }

  async function rowCount(): Promise<number> {
    const r = await h.deps.db.execute<{ n: number }>(sql`select count(*)::int as n from note_image_embeddings`);
    return r.rows[0]!.n;
  }

  it('is listed, read-only, with the four sources and limit', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'similar_images');
    expect(tool).toBeDefined();
    expect(tool!.annotations?.readOnlyHint).toBe(true);
    const props = Object.keys((tool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
    expect(props.sort()).toEqual(['image_id', 'limit', 'pasted_image', 'query', 'upload_id']);
    expect(tool!.description).toMatch(/view_images/);
  });

  it('image_id: nearest first, never the source, a removed image or an image of a deleted note', async () => {
    const a = await photo(RED, 'red top in the car #pics #car');
    const b = await photo(DARK_RED, `dark red ${'x'.repeat(300)}`);
    const c = await photo(BLUE);
    const d = await photo(RED2);
    const e = await photo(RED3);
    await embedAll();
    await setImageDeleted(h.deps.db, d, true);
    await h.deps.service.delete(e);
    const r = await ok({ image_id: a.toLowerCase().replace('-', '') });
    expect(r.source).toEqual({ image_id: a });
    expect(r.model).toBe(fake.model);
    expect(r.hits.map((x) => x.image_id)).toEqual([b, c]);
    expect(r.hits[0]).toMatchObject({ note_id: b, available: true, note: { tags: [] } });
    expect(r.hits[0]!.similarity).toBeGreaterThan(0.99);
    expect(r.hits[0]!.note.body.length).toBeLessThanOrEqual(200);
    expect(r.hits[0]!.note.body.endsWith('…')).toBe(true);
    expect(r.next).toMatch(/view_images/);
    expect(fake.calls).toEqual([]);
  });

  it('limit caps the hits', async () => {
    const first = await photo({ r: 200, g: 20, b: 20 });
    for (const red of [201, 202, 203, 204]) await photo({ r: red, g: 20, b: 20 });
    await embedAll();
    expect((await ok({ image_id: first, limit: 2 })).hits).toHaveLength(2);
  });

  it('query: words reach pictures through the same space', async () => {
    const red = await photo(RED);
    await photo(BLUE);
    await embedAll();
    const r = await ok({ query: 'red top in a car' });
    expect(r.source).toEqual({ query: 'red top in a car' });
    expect(r.hits[0]!.image_id).toBe(red);
    expect(fake.calls).toEqual([{ kind: 'text', text: 'red top in a car' }]);
  });

  it('an image with no vector yet is embedded on the spot, like related', async () => {
    await photo(RED);
    await embedAll();
    const fresh = await photo(DARK_RED);
    const r = await ok({ image_id: fresh });
    expect(r.hits).toHaveLength(1);
    expect(fake.calls).toEqual([{ kind: 'image', bytes: expect.any(Number) }]);
    const saved = await h.deps.db.execute<{ ok: boolean }>(sql`
      select embedding is not null as ok from note_image_embeddings where image_id = ${fresh}
    `);
    expect(saved.rows[0]?.ok).toBe(true);
  });

  it('an image with no vector whose file is on another machine gets a clear error', async () => {
    const away = await photo(RED);
    await rm(await originalPathOf(h, away));
    const r = await call({ image_id: away });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/has no image embedding yet and its file lives on /);
  });

  it('unknown ids and malformed ids are explained', async () => {
    expect(text(await call({ image_id: 'Z-ZZZ' }))).toMatch(/Z-ZZZ: no such image/);
    expect(text(await call({ image_id: 'not an id!' }))).toMatch(/not an image id/);
  });

  it('needs exactly one source', async () => {
    const none = await call({ limit: 3 });
    expect(none.isError).toBe(true);
    expect(text(none)).toMatch(/exactly one of image_id, upload_id, query or pasted_image \(got none\)/);
    const two = await call({ image_id: 'A-B32', query: 'red' });
    expect(text(two)).toMatch(/\(got 2\)/);
  });

  it('pasted_image explains that the Claude Code hook is needed', async () => {
    const r = await call({ pasted_image: 1 });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/notes-paste hook/);
    expect(text(r)).toMatch(/scripts\/install\.sh/);
  });

  it('upload_id embeds the chat upload on the fly and stores nothing', async () => {
    const red = await photo(RED);
    await photo(BLUE);
    await embedAll();
    const uploadPath = path.join(h.dataDir, 'upload-red.png');
    await writeFile(uploadPath, await makeImage('png', 40, 40, RED));
    const c = await inProcess({
      chatUploads: async (id) => {
        const canonical = normalizeId(id);
        if (canonical === 'U-P01') return { id: 'U-P01', absPath: uploadPath };
        if (canonical === 'U-P02') return { id: 'U-P02', absPath: path.join(h.dataDir, 'gone.png') };
        return null;
      },
    });
    try {
      const before = await rowCount();
      const r = await ok({ upload_id: 'up01' }, c);
      expect(r.source).toEqual({ upload_id: 'U-P01' });
      expect(r.hits[0]!.image_id).toBe(red);
      expect(await rowCount()).toBe(before);
      expect(text(await call({ upload_id: 'U-P09' }, c))).toMatch(/no such chat upload/);
      expect(text(await call({ upload_id: 'U-P02' }, c))).toMatch(/pasted on another machine/);
    } finally {
      await c.close();
    }
  });

  it('without an image embedder: query says image search is off; existing vectors still answer image_id', async () => {
    const a = await photo(RED);
    const b = await photo(DARK_RED);
    await embedAll();
    const c = await inProcess({ imageEmbedder: null });
    try {
      const off = await call({ query: 'red' }, c);
      expect(off.isError).toBe(true);
      expect(text(off)).toMatch(/semantic image search is off/);
      expect((await ok({ image_id: a }, c)).hits.map((x) => x.image_id)).toEqual([b]);
    } finally {
      await c.close();
    }
  });
});
```

### Step 31: Docs
**File:** `README.md`
- MCP tools table (after the `view_images` row, ~line 633) add:
```markdown
| `similar_images` | The photos that look most like one picture, nearest first with a similarity score: from an existing photo id (`image_id`), an image pasted into the wall chat (`upload_id`) or a description (`query`, e.g. "red top in a car"). Never the source photo, removed photos or deleted notes' photos. `pasted_image` (Claude Code) needs the notes-paste hook |
```
- After the "Search by meaning" section (~line 656) add:
```markdown
### Similar photos

Every note image is also embedded, by its pixels, with Gemini Embedding 2 (`google/gemini-embedding-2`
over OpenRouter, the same key) into `note_image_embeddings` (1536 dimensions, HNSW cosine). The
model puts words and pictures in one space, so `similar_images` answers both "photos like this
one" and "photos of a red top in a car". What is sent is the photo's preview re-encoded as a PNG
of at most 1024 px. The daemon embeds new images in the background; a photo whose file lives on
the other laptop is skipped here and embedded by that laptop's daemon. `npm run
embed:images:backfill -- --dry-run` counts what is pending and estimates the cost (about $0.45 per
million image tokens, roughly 258-516 tokens a photo); without `--dry-run` it embeds them
(`--limit N` for a trial, `--retry-failed` to skip the backoff). It never runs by itself.
```
**File:** `CHANGELOG.md`: if no `## [Unreleased]` section exists yet (another phase may have added it), insert above `## [v0.1.0] - 2026-10-30`:
```markdown
## [Unreleased]

### Added

```
(create `### Added` under the existing `## [Unreleased]` if only `### Fixed` exists), then under `### Added` add the line:
```markdown
- **Image similarity search**: Gemini Embedding 2 image vectors in `note_image_embeddings`, a background worker, `npm run embed:images:backfill` (`--dry-run`, `--limit`, `--retry-failed`) and the `similar_images` MCP tool (by image id, wall-chat upload or text query), on the wall chat's allow list.
```

## Verification

**Build:** `npm run typecheck && npm run build`
**Migration:** `npm run db:generate -- --name note_image_embeddings` produced only `drizzle/0005_note_image_embeddings.sql` (+ snapshot, journal entry `0005_note_image_embeddings`); `npm run db:check` clean.
**Tests:**
- `npm test` (unit: new `tests/unit/embeddings/{openrouterImage,fakeImageEmbedder,imageBackfill,imageConstants}.test.ts`, `tests/unit/similarTools.test.ts`, updated `chat-status`, `mcp.instructions`, `chat-prompt`; `tests/unit/embeddings/openrouter.test.ts` must pass unchanged)
- `npm run test:int` (new `imageEmbeddings.repo`, `imageEmbeddings.worker`, `similarImages.mcp`; every existing file still green, especially `embeddings.worker.int.test.ts` "logs once" and `daemon.int.test.ts`)
- Optional, billed, only on explicit decision: `npm run test:live:imageEmbeddings` — read the printed "[live] google/gemini-embedding-2 request shapes" block; if "image item + dimensions 1536" is refused while "image item, no dimensions" works, remove `dimensions` from `imageRequestBody` and re-run unit tests (update the request-shape assertion accordingly).
**Manual check:** with the real daemon (`npm run dev`, key set) the log shows `[notesd] embedding images with google/gemini-embedding-2`; `npm run embed:images:backfill -- --dry-run` prints counts and a cost estimate and sends nothing; in Claude Code `/n find photos like <image id>` calls `similar_images` and then `view_images`.
**Exit criteria:** the worker embeds new images and skips images whose file is not on this machine without recording failures (worker int test); `nearestImages` excludes the source image, removed images and deleted notes (repo + MCP int tests); a text query finds the matching picture through the same space (MCP int test); `similar_images` is on the chat allowlist with caption "finding similar photos"; `pasted_image` answers with the hook explanation; the live probe file exists, is routed only by `IMAGE_EMBEDDINGS_LIVE_TEST=1`, and documents the request shape; typecheck, unit, integration and build pass.

## Handoffs

- **Phase 8 (R1, R3):** replace the `pasted_image` branch in `src/mcp/similarTools.ts` (`PASTED_IMAGE_NEEDS_HOOK`, the early `fail(...)` in the handler) once the PreToolUse hook rewrites `pasted_image` to `upload_id`; when the hook works, the daemon never sees `pasted_image`, so P8 may keep the message as the "hook not installed" fallback. P8 also owns the `/n` skill sentence about pasted images beyond the fallback written here, and `tests/integration/similarImages.mcp.int.test.ts`'s pasted_image case if the message changes.
- **Phase 7 (R3):** context rebuild that keeps `[image upload:ID]` placeholders makes `upload_id` usable for earlier-turn images too; nothing to do here.
- **Not in any phase (drive-by, left alone):** `startEmbeddingWorker` and `startImageEmbeddingWorker` share their kick/sweep/close skeleton; a later cleanup could extract a generic drain loop. `src/mcp/instructions.ts` "Images." paragraph could mention `similar_images` too; the new "Similar images." paragraph covers it.

## Rollback

Revert this phase's commits. That removes the tool, the worker, the CLI and `AppDeps.imageEmbedder`. The table may stay (harmless; nothing reads it). To drop it by hand on a database that ran migration 0005:
```sql
DROP TABLE IF EXISTS note_image_embeddings;
DELETE FROM drizzle.__drizzle_migrations WHERE hash = '<hash of 0005_note_image_embeddings>';
```
(the second statement only if migration 0005 must be re-applied later; take the hash from the row whose `created_at` matches the 0005 journal `when`). No data in other tables is touched by this phase; vectors are recomputable with `npm run embed:images:backfill`.
