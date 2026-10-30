> Adopted from `/home/miftah/.worktrees/mcp-notes/semantic-search/.workflows/orchestration/semantic-search/PLAN.md` phase 5. Source: `.workflows/plan/semantic-search/phase-5.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 5: `related` tool

**Plan set:** `SEMANTIC_SEARCH_PLAN.md`
**Analysis:** `docs/analyzer/20261030-140513-S6EM_code_analyzer.md`
**Satisfies:** R5 (and R6 for its own tests): a `related` MCP tool that, given a note id, returns the nearest notes by meaning with a similarity score, excluding the note itself
**Depends on:** Phase 1, 2, 4
**Difficulty:** NORMAL
**Package:** `src/embeddings`, `src/notes`, `src/mcp`, `src/chat`

---

## Goal

After this phase, Claude (through `/n` and the chat bar) can call `related(id)` and get back the live notes nearest in meaning to that note. Each comes with `similarity = 1 - cosine distance`, the note itself is never included, and neither is a deleted note or a note whose vector is stale. A source note that has not been embedded yet is embedded on demand when an embedder is configured. With no embedder it fails with a clear `not_embedded` error. The chat agent's allow list grows from 13 to 14 notes tools, and the status caption for the new tool is "finding related notes".

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `embeddings.nearestNotes(db: Db, opts: NearestOptions): Promise<NearestNote[] | null>` (`src/embeddings/repo.ts`, appended at end of file)
- `embeddings.NearestOptions { noteId: string; model: string; limit: number }`, `embeddings.NearestNote { row: NoteRow; distance: number }` (`src/embeddings/repo.ts`)
- `NotesService.related(idInput: string, opts?: RelatedOptions): Promise<RelatedResult>` (`src/notes/service.ts`, after `tags()`)
- private `NotesService.embedNow(id, body, input): Promise<void>` (`src/notes/service.ts`)
- `RELATED_DEFAULT_LIMIT = 10`, `RELATED_MAX_LIMIT = 50`, `RelatedOptions { limit?: number }` (`src/notes/service.ts`)
- `RelatedNote { note: Note; similarity: number }`, `RelatedResult { note_id: string; related: RelatedNote[] }` (`src/notes/types.ts`)
- `NoteErrorCode` gains `'not_embedded'` (`src/notes/types.ts`)
- MCP tool `related` `{ id, limit? 1-50 }`, `readOnlyHint: true` (`src/mcp/tools.ts`)
- instructions section starting `Related.` (`src/mcp/instructions.ts`)
- `'related'` in `NOTES_TOOL_NAMES` (14 entries) + caption `'finding related notes'` (`src/chat/status.ts`)
- test file `tests/integration/related.int.test.ts`

**Signature changes:** none to existing symbols.

**Requires (from earlier phases):**
- Phase 1: `src/embeddings/constants.ts` exports `EMBEDDING_MODEL`. `src/embeddings/state.ts` exports `bodySha256(body)` and `embedInput(body)`. `src/embeddings/repo.ts` exports `isCurrentEmbeddingSql(model): SQL` (references `notes` and `note_embeddings` by their **unaliased** table names, like drizzle column refs `"notes"."body"` / `"note_embeddings"."embedding"`) and `saveEmbedding(db, {noteId, bodySha256, model, embedding}): Promise<boolean>`. `src/db/schema.ts` exports `noteEmbeddings` (drizzle table for `note_embeddings` with columns `noteId`, `embedding`, ...). The HNSW index `note_embeddings_embedding_hnsw_idx` on `embedding vector_cosine_ops` exists. `truncateAll` empties `note_embeddings` (by cascade or explicitly).
- Phase 2: `NotesServiceDeps.embedder?: Embedder | null`, and `NotesService` stores it as `private readonly embedder: Embedder | null` (this plan reads `this.embedder` and checks it with `!embedder`, so `undefined` also works). `Embedder { model; dimensions; embed(inputs) }`. `Config.embeddings` + `DEFAULT_EMBEDDINGS_CONFIG` exported from `src/config.ts`. `AppDeps.embedder: Embedder | null`. `tests/helpers/fakeEmbedder.ts` exports `createFakeEmbedder({ lexicon?, dimensions?, model? })` returning a `FakeEmbedder` with `model` (default `EMBEDDING_MODEL`), `dimensions` (default 1536, so vectors fit `vector(1536)`), `readonly calls: string[][]` (one entry per `embed()` call that would reach the network, failed ones included), `failNext(n = 1, error?)`, and `type Lexicon = readonly (readonly string[])[]` (synonym groups; an entry ending in `*` is a prefix match). Step 8's `LEXICON` is typed as `Lexicon` (reconciled against Phase 2's plan).
- Phase 4 (reconciled against its plan): rewrites `search` in `src/notes/service.ts` and adds a private `textSearch` right after it, adds `searchCandidates` to `src/notes/repo.ts`, `SearchMode` / `SearchPage` after `NotePage` in `src/notes/types.ts`, rewrites the `search` registration in `src/mcp/tools.ts` and the `Reading.` element of `src/mcp/instructions.ts`, and appends one `it` to `tests/unit/mcp.instructions.test.ts`. Phase 4 imports nothing from `src/embeddings/**` in `service.ts`, so the three `../embeddings/*` imports below are new lines; Step 3(a) quotes the merged block. Phase 4 adds no `NoteErrorCode`.

**Leaves alone (owned by others):** search ranking and `src/search/**` (Phase 4). `src/notes/repo.ts` (Phase 4; this phase adds nothing there). The `search` tool and the "Reading." instructions paragraph (Phase 4). The worker, backfill and `src/background.ts` (Phase 3). `web/**` (nobody). `src/chat/prompt.ts` (out of scope). `src/http/api.ts` (unchanged: its `default` branch already maps any new code to 400). `claude/skills/n/SKILL.md`, README and docs (Phase 6).

## Files

| File | Action | What changes |
|---|---|---|
| `src/embeddings/repo.ts` | modify (append) | add `NearestOptions`, `NearestNote`, `nearestNotes` |
| `src/notes/types.ts` | modify (after `TagCount`; `NoteErrorCode`; anchor on text, Phase 4 inserts `SearchMode`/`SearchPage` after `NotePage`) | add `RelatedNote`, `RelatedResult`; add `'not_embedded'` |
| `src/notes/service.ts` | modify (import block as left by Phases 2 and 4; options after Phase 4's `SearchOptions`; method after `tags()`; helper at end of file) | `related()`, `embedNow()`, limits, `roundSimilarity` |
| `src/mcp/tools.ts` | modify (after `tags` registration, today `:271-280`) | register `related` |
| `src/mcp/instructions.ts` | modify (before the `Dates.` element, today `:24`, after Phase 4's rewritten `Reading.` at `:22`) | one-sentence `Related.` section |
| `src/chat/status.ts` | modify (`:17-31`, `:44-47`, `:85-89`) | add `related`, update the 13 → 14 comment, caption |
| `tests/unit/chat-status.test.ts` | modify (`:8-12`, `:25-28`) | 14 notes tools, 14+15+2, caption row |
| `tests/unit/mcp.instructions.test.ts` | modify (append inside `describe('buildInstructions')`, after Phase 4's Reading-paragraph test) | `Related.` paragraph test |
| `tests/integration/related.int.test.ts` | create | service + MCP integration tests with the fake embedder |

## Implementation Steps

### Step 1: `nearestNotes` in the embeddings repo
**File:** `src/embeddings/repo.ts` (append at end of file; phase 1 owns the rest)
**Change:** Add the nearest-neighbour query. It runs in one transaction with two statements:
1. Check that the source note has a *current* vector for `model`. If not, return `null` so the caller can embed it and ask again.
2. `SET LOCAL hnsw.iterative_scan = strict_order` (pgvector ≥ 0.8; Neon has 0.8.6, `pgvector/pgvector:pg16` ships 0.8.x). The `WHERE` clause drops deleted, stale and self rows *after* the index walk, so without this setting the HNSW scan stops at `ef_search` (40) candidates and could return fewer than `limit`, or none. `strict_order` keeps the exact distance order.
3. `ORDER BY note_embeddings.embedding <=> (SELECT src.embedding FROM note_embeddings AS src WHERE src.note_id = $id) LIMIT n`. This is the shape pgvector's README documents for "nearest neighbours of a row", and the one the HNSW cosine index serves. No secondary sort key is added because it would stop the index from supplying the order.

Phase 1's import block is `sql, type SQL` from drizzle-orm, `noteEmbeddings, notes` from the schema, `type Executor` from `../notes/repo.js`, `EMBEDDING_DIMENSIONS` and `clampError, retryDelayMs`. Replace it with this merged block (all new imports are type-only or drizzle helpers, so no runtime cycle with `src/notes/repo.ts`, which imports this file since Phase 4):

**Code (the file's whole import block after this phase):**
```ts
import { and, eq, getTableColumns, isNull, ne, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { noteEmbeddings, notes } from '../db/schema.js';
import type { Executor } from '../notes/repo.js';
import type { NoteRow } from '../notes/types.js';
import { EMBEDDING_DIMENSIONS } from './constants.js';
import { clampError, retryDelayMs } from './state.js';
```
**Code (append):**
```ts
export interface NearestOptions {
  /** Canonical id of the note to find neighbours for. */
  noteId: string;
  /** Only vectors from this model count as current (see isCurrentEmbeddingSql). */
  model: string;
  /** Maximum number of neighbours, already clamped by the caller. */
  limit: number;
}

export interface NearestNote {
  row: NoteRow;
  /** Cosine distance (pgvector `<=>`), 0 = same direction, 2 = opposite. similarity = 1 - distance. */
  distance: number;
}

/**
 * Live notes nearest in meaning to `noteId`, closest first. Both sides use only current vectors
 * (vector present, body hash and model match). Never returns the note itself or a deleted note.
 *
 * Returns null when `noteId` has no current vector for `model` (no row, stale body, failed attempt,
 * or another model), so the caller can embed it and ask again.
 *
 * `ORDER BY embedding <=> (source vector) LIMIT n` is the shape the HNSW cosine index serves.
 * Iterative scan (pgvector >= 0.8) keeps walking the index past rows the WHERE clause drops
 * (deleted, stale, self), so `limit` rows come back whenever that many exist.
 */
export async function nearestNotes(db: Db, opts: NearestOptions): Promise<NearestNote[] | null> {
  return db.transaction(async (tx) => {
    const source = await tx
      .select({ noteId: noteEmbeddings.noteId })
      .from(noteEmbeddings)
      .innerJoin(notes, eq(notes.id, noteEmbeddings.noteId))
      .where(and(eq(noteEmbeddings.noteId, opts.noteId), isCurrentEmbeddingSql(opts.model)))
      .limit(1);
    if (source.length === 0) return null;

    await tx.execute(sql`set local hnsw.iterative_scan = strict_order`);

    const distance = sql<number>`(${noteEmbeddings.embedding} <=> (select src.embedding from note_embeddings as src where src.note_id = ${opts.noteId}))`;
    const rows = await tx
      .select({ note: getTableColumns(notes), distance })
      .from(notes)
      .innerJoin(noteEmbeddings, eq(noteEmbeddings.noteId, notes.id))
      .where(and(isNull(notes.deletedAt), ne(notes.id, opts.noteId), isCurrentEmbeddingSql(opts.model)))
      .orderBy(distance)
      .limit(opts.limit);
    return rows.map((r) => ({ row: r.note, distance: Number(r.distance) }));
  });
}
```
**Impact:** Additive. The vector never leaves the database: only the distance is selected, which keeps invariant 6. Phase 1's `isCurrentEmbeddingSql` renders `"notes".…` / `"note_embeddings".…` (confirmed in its plan), so both outer queries use the unaliased tables. The only alias is `src` inside the distance subquery, which contains no shared fragment.

### Step 2: result types and the new error code
**File:** `src/notes/types.ts:52-56` (insert after `TagCount`) and `:63-71` (`NoteErrorCode`)
**Change:** Add the wire result of `related` and one error code. `not_embedded` is a new code, not `invalid_input`, because it is *temporary*: the note is valid, it just has no vector yet, and either the background job will fill one or the daemon has no `OPENROUTER_API_KEY`. Claude reads `not_embedded: ...` in the MCP error text and can tell the user to try again, or fall back to `search` with words from the note. A textless photo uses the existing `invalid_input`, because retrying cannot fix it.

HTTP mapping: `noteErrorResponse` in `src/http/api.ts:53-68` has a `default` branch, so `not_embedded` maps to 400 with no edit. No HTTP route calls `related` (no UI change), so `api.ts` stays untouched.

**Code (insert after the `TagCount` interface):**
```ts
/** One neighbour returned by `related`. similarity = 1 - cosine distance, rounded to 4 decimals. */
export interface RelatedNote {
  note: Note;
  similarity: number;
}

/** Result of `related`: the source note's canonical id and its neighbours, most similar first. */
export interface RelatedResult {
  note_id: string;
  related: RelatedNote[];
}
```
**Code (replace `NoteErrorCode`):**
```ts
export type NoteErrorCode =
  | 'invalid_id'
  | 'invalid_input'
  | 'not_found'
  | 'deleted'
  | 'empty_body'
  | 'conflict'
  | 'duplicate_image'
  | 'invalid_revision'
  | 'not_embedded';
```
**Impact:** Additive. Phase 4 adds no code.

### Step 3: `NotesService.related`
**File:** `src/notes/service.ts`
**Change:**
(a) Imports. Replace the block Phases 2 and 4 left (quoted in Phase 4 Step 5a) with this one: three `../embeddings/*` lines added after Phase 2's `Embedder` import, `type RelatedResult` added to the `./types.js` list; Phase 4's lines kept as they are.
```ts
import type { Db } from '../db/client.js';
import { EMBEDDING_MODEL } from '../embeddings/constants.js';
import type { Embedder } from '../embeddings/embedder.js';
import * as embeddings from '../embeddings/repo.js';
import { bodySha256, embedInput } from '../embeddings/state.js';
import { BLEND, queryTerms, rankCandidates, tagMatch } from '../search/blend.js';
import {
  QUERY_EMBED_TIMEOUT_MS,
  QueryVectorCache,
  SEMANTIC_OFF_FALLBACK,
  embedFailedFallback,
  embedQuery,
} from '../search/queryVector.js';
import type { NoteEvents, NoteOp } from './events.js';
import { generateId, normalizeId } from './ids.js';
import * as repo from './repo.js';
import type { NoteFilter } from './repo.js';
import { parseTags } from './tags.js';
import {
  NoteError,
  cleanOrigin,
  rowToNote,
  type ImageMeta,
  type Note,
  type NotePage,
  type NoteRow,
  type Origin,
  type RelatedResult,
  type Revision,
  type SearchMode,
  type SearchPage,
  type TagCount,
} from './types.js';
```

(b) Constants and options, inserted after Phase 4's `SearchOptions` (which follows `GetOptions`, today `:50-52`):
```ts
/** related(): neighbours returned when no limit is given, and the most it returns. */
export const RELATED_DEFAULT_LIMIT = 10;
export const RELATED_MAX_LIMIT = 50;

export interface RelatedOptions {
  /** 1..RELATED_MAX_LIMIT, default RELATED_DEFAULT_LIMIT. Out-of-range values are clamped. */
  limit?: number;
}
```

(c) Methods, inserted directly after `tags()` (today `:171-174`; Phase 4 replaces `search()` above it with `search()` + private `textSearch()`, so the line number moves, but `tags()` itself does not change):
```ts
  /**
   * Live notes nearest in meaning to one note, most similar first. The note itself, deleted
   * notes and notes whose vector no longer matches their body are never returned. A source note
   * with no current vector is embedded here when an embedder is configured (the same guarded
   * upsert the background worker does); without one this fails with NoteError('not_embedded').
   */
  async related(idInput: string, opts: RelatedOptions = {}): Promise<RelatedResult> {
    const id = this.requireId(idInput);
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? RELATED_DEFAULT_LIMIT), 1), RELATED_MAX_LIMIT);
    const row = await repo.findNoteById(this.db, id);
    if (row === null) throw new NoteError('not_found', `Note ${id} does not exist.`);
    if (row.deletedAt !== null) {
      throw new NoteError('deleted', `Note ${id} is deleted. Call restore("${id}") first if you want notes related to it.`);
    }
    const input = embedInput(row.body);
    if (input === null) {
      const what = row.imagePath !== null ? 'is a photo with no text' : 'has no text';
      throw new NoteError(
        'invalid_input',
        `Note ${id} ${what}, so there is nothing to compare by meaning. Add a description with append("${id}", ...) first, or use list with dates to find notes from the same time.`,
      );
    }
    const model = this.embedder?.model ?? EMBEDDING_MODEL;
    let nearest = await embeddings.nearestNotes(this.db, { noteId: id, model, limit });
    if (nearest === null) {
      await this.embedNow(id, row.body, input);
      nearest = await embeddings.nearestNotes(this.db, { noteId: id, model, limit });
      if (nearest === null) {
        throw new NoteError('not_embedded', `Note ${id} changed while it was being embedded. Try again.`);
      }
    }
    return {
      note_id: id,
      related: nearest.map((n) => ({ note: this.toNote(n.row), similarity: roundSimilarity(1 - n.distance) })),
    };
  }

  /** Embeds one note's body now and stores the vector (skipped by saveEmbedding if the body changed meanwhile). */
  private async embedNow(id: string, body: string, input: string): Promise<void> {
    const embedder = this.embedder;
    if (!embedder) {
      throw new NoteError(
        'not_embedded',
        `Note ${id} has no embedding yet and semantic search is off on this daemon (OPENROUTER_API_KEY is not set), so related notes cannot be found for it. Use search with words from the note instead.`,
      );
    }
    let vectors: number[][];
    try {
      vectors = await embedder.embed([input]);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new NoteError(
        'not_embedded',
        `Note ${id} has no embedding yet and embedding it now failed (${reason}). The background job retries it; try again later, or use search with words from the note.`,
      );
    }
    const vector = vectors[0];
    if (vector === undefined) {
      throw new NoteError('not_embedded', `Note ${id} has no embedding yet and the embedder returned none. Try again later.`);
    }
    await embeddings.saveEmbedding(this.db, { noteId: id, bodySha256: bodySha256(body), model: embedder.model, embedding: vector });
  }
```
(d) Module-level helper at the end of the file, after the class:
```ts
/** 4 decimals: enough to order and compare, short enough to read in a tool result. */
function roundSimilarity(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
```
**Impact:**
- `related` performs at most one embedding call, and only when the source is not current. It never touches the write path, so invariant 2 holds.
- On embed failure it does **not** call `recordFailure`. The worker owns the retry and backoff state, and a read path must not reset or bump its counters.
- The model used for "current" is `this.embedder.model` when there is an embedder, because that is what the worker writes. If there is no embedder it falls back to `EMBEDDING_MODEL`, so already-embedded notes still get answers on a daemon without a key.
- `EmbeddingError` messages carry at most a 300-char response snippet and never the key (phase 2 contract), so passing `err.message` through is safe.

### Step 4: MCP `related` tool
**File:** `src/mcp/tools.ts`, insert immediately after the `tags` registration (today `:271-280`, ending `async () => run(async () => ({ tags: await service.tags() })),\n  );`) and before `revisions`. Phase 4 edits only the `search` registration above it.
**Change:** Register the tool. `readOnlyHint: true`: it changes no note, and the on-demand embedding is a cache fill the worker would have made anyway.
**Code:**
```ts
  server.registerTool(
    'related',
    {
      title: 'Related notes',
      description:
        'Notes closest in meaning to one note, most similar first, each with a similarity score (1 = same meaning, near 0 = unrelated). Finds notes that share no words with it. Never includes the note itself or deleted notes. Use it for "what else do I have on this?" or "notes related to A-B32" after finding a note with get, list or search. Returns { note_id, related: [{ note, similarity }] }. Fails on a deleted note and on a photo that has no text.',
      inputSchema: {
        id: idField,
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('How many related notes to return, 1-50. Default 10.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, limit }) => run(() => service.related(id, limit === undefined ? {} : { limit })),
  );
```
**Impact:** Adds one tool to the `/mcp` server. `tests/integration/mcp.tools.int.test.ts:83` uses `arrayContaining`, so it keeps passing.

### Step 5: one sentence in the server instructions
**File:** `src/mcp/instructions.ts`, insert a new element into `sections` immediately **before** the element that starts `` `Dates. `` (today `:24`). Phase 4 rewrites the `Reading.` element just above (`:22`), so this phase adds its own element rather than editing that string; the order becomes `Reading.`, `Related.`, `Dates.`.
**Code:**
```ts
    `Related. related(id) returns the notes closest in meaning to one note, most similar first with a similarity score (1 = same meaning, near 0 = unrelated), never the note itself or a deleted note; use it for "what else do I have on this?" or "what other notes are related to A-B32?".`,

```
**Impact:** The instructions grow by one paragraph. The existing connectors-paragraph test filters by prefix and is unaffected.

### Step 6: chat allow list and caption
**File:** `src/chat/status.ts`
**Change:** (a) In `NOTES_TOOL_NAMES` (`:17-31`), insert `'related',` after `'tags',`:
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
] as const;
```
(b) Replace the comment on `allowedChatTools` (`:44-47`):
```ts
/**
 * Exactly the 14 notes tools, the 15 connector tools and WebSearch + WebFetch
 * (CONNECTORS_PLAN invariant 8, which supersedes CHAT_BAR_BRAIN_PLAN invariant 4;
 * SEMANTIC_SEARCH_PLAN phase 5 adds `related`).
 */
```
(c) In `captionForToolUse` (`:85-89`), add a case after the `search`/`list`/`tags` group. `search` keeps "searching notes" (invariant 4):
```ts
    case 'search':
    case 'list':
    case 'tags':
      return 'searching notes';
    case 'related':
      return 'finding related notes';
```
**Impact:** The chat agent may call `mcp__notes__related`. `tests/unit/chat-agent.test.ts:278` compares against `allowedChatTools()` itself, so it follows automatically.

### Step 7: unit tests
**File:** `tests/unit/chat-status.test.ts:8-12`. Replace the first `it`:
```ts
  it('is exactly the 14 notes tools, the 15 connector tools, WebSearch and WebFetch', () => {
    const tools = allowedChatTools();
    expect(NOTES_TOOL_NAMES).toHaveLength(14);
    expect(ALL_CONNECTOR_TOOL_NAMES).toHaveLength(15);
    expect(tools).toHaveLength(14 + 15 + 2);
    expect(new Set(tools).size).toBe(tools.length);
    expect(tools).toContain('mcp__notes__view_images');
    expect(tools).toContain('mcp__notes__create_image');
    expect(tools).toContain('mcp__notes__related');
    for (const name of ALL_CONNECTOR_TOOL_NAMES) expect(tools).toContain(n(name));
    expect(tools).toContain('WebSearch');
    expect(tools).toContain('WebFetch');
    expect(tools.filter((t) => !t.startsWith('mcp__notes__'))).toEqual(['WebSearch', 'WebFetch']);
  });
```
and in the first `it.each` table, add after the `[n('tags'), {}, 'searching notes'],` row (`:27`):
```ts
    [n('related'), { id: 'A-B32' }, 'finding related notes'],
```

**File:** `tests/unit/mcp.instructions.test.ts`, inside `describe('buildInstructions', ...)`, after Phase 4's `'says search understands meaning, …'` test (which itself follows the connectors test ending at `:31`):
```ts
  it('has one Related paragraph that names related(id), the score and what it leaves out', () => {
    const paragraphs = buildInstructions('Asia/Jakarta')
      .split('\n\n')
      .filter((p) => p.startsWith('Related.'));
    expect(paragraphs).toHaveLength(1);
    const p = paragraphs[0]!;
    expect(p).toContain('related(id)');
    expect(p).toContain('similarity');
    expect(p).toContain('never the note itself or a deleted note');
  });
```

### Step 8: integration tests
**File:** `tests/integration/related.int.test.ts` (new)
**Change:** Exercises the service and the real `/mcp` route against the pgvector container with the fake embedder. Vectors are written directly with `saveEmbedding` (no worker), so the test does not depend on phase 3. `LEXICON` is typed with Phase 2's `Lexicon`; it uses exact entries only. Ordering only needs the concept axes: A shares two concepts with the source, C one, B none.
**Code:**
```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CHAT_CONFIG, DEFAULT_EMBEDDINGS_CONFIG, type Config } from '../../src/config.js';
import type { AppDeps } from '../../src/deps.js';
import { EMBEDDING_MODEL } from '../../src/embeddings/constants.js';
import { saveEmbedding } from '../../src/embeddings/repo.js';
import { bodySha256, embedInput } from '../../src/embeddings/state.js';
import { createApp } from '../../src/http/app.js';
import { NoteEvents } from '../../src/notes/events.js';
import { NotesService } from '../../src/notes/service.js';
import { NoteError, type ImageMeta, type Note, type RelatedResult } from '../../src/notes/types.js';
import { createFakeEmbedder, type Lexicon } from '../helpers/fakeEmbedder.js';
import { closeTestDb, openTestDb, testDatabaseUrl, truncateAll } from './setup.js';

/** Synonym groups: each group is one concept axis in the fake embedder. */
const LEXICON: Lexicon = [
  ['arango', 'arangodb', 'database', 'postgres'],
  ['password', 'credentials', 'secret', 'vault'],
  ['login', 'auth', 'signin'],
  ['sleep', 'slept', 'resume', 'suspend'],
];

const db = openTestDb();
const dataDir = mkdtempSync(join(tmpdir(), 'notes-related-'));
const events = new NoteEvents();
const fake = createFakeEmbedder({ lexicon: LEXICON });
const service = new NotesService({ db, dataDir, events, embedder: fake });
const noEmbedder = new NotesService({ db, dataDir, events, embedder: null });

const config: Config = {
  databaseUrl: testDatabaseUrl(),
  port: 0,
  host: '127.0.0.1',
  dataDir,
  chat: DEFAULT_CHAT_CONFIG,
  embeddings: DEFAULT_EMBEDDINGS_CONFIG,
};
const deps: AppDeps = { config, db, events, service, embedder: fake };
const app = createApp(deps);
let client: Client;

async function expectNoteError(p: Promise<unknown>, code: string, message?: RegExp): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(NoteError);
  expect((err as NoteError).code).toBe(code);
  if (message) expect((err as NoteError).message).toMatch(message);
}

/** Writes a current vector for the note's body, as the worker would. */
async function embed(note: Note, model: string = fake.model): Promise<void> {
  const input = embedInput(note.body);
  if (input === null) throw new Error(`note ${note.id} has no text`);
  const [vector] = await fake.embed([input]);
  const saved = await saveEmbedding(db, { noteId: note.id, bodySha256: bodySha256(note.body), model, embedding: vector! });
  expect(saved).toBe(true);
}

async function hasCurrentRow(id: string): Promise<boolean> {
  const res = await db.execute(sql`select 1 from note_embeddings where note_id = ${id} and embedding is not null`);
  return res.rows.length > 0;
}

const ids = (r: RelatedResult): string[] => r.related.map((x) => x.note.id);

const photoMeta: ImageMeta = {
  sha256: 'f'.repeat(64),
  mime: 'image/png',
  width: 2,
  height: 1,
  bytes: 70,
  taken_at: null,
  original_name: 'shot.png',
  host: 'lenovo',
};

/** Source + three neighbours at decreasing closeness (2 shared concepts, 1, 0). */
async function seed(): Promise<{ src: Note; a: Note; b: Note; c: Note }> {
  const src = await service.create({ body: 'where are the arangodb credentials kept' });
  const a = await service.create({ body: 'arango root password is in the vault' });
  const c = await service.create({ body: 'postgres backup runs nightly' });
  const b = await service.create({ body: 'the login broke after the laptop slept' });
  for (const n of [src, a, b, c]) await embed(n);
  return { src, a, b, c };
}

beforeAll(async () => {
  client = new Client({ name: 'mcp-notes-related-test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: async (input, init) => app.request(String(input), init),
    }),
  );
});

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await client.close();
  await closeTestDb(db);
  rmSync(dataDir, { recursive: true, force: true });
});

describe('NotesService.related', () => {
  it('orders live notes by meaning, excludes the note itself, similarity = 1 - distance', async () => {
    const { src, a, b, c } = await seed();
    const r = await service.related(src.id.toLowerCase().replace('-', ''));
    expect(r.note_id).toBe(src.id);
    expect(ids(r)).toEqual([a.id, c.id, b.id]);
    expect(ids(r)).not.toContain(src.id);
    const sims = r.related.map((x) => x.similarity);
    for (const s of sims) {
      expect(s).toBeGreaterThanOrEqual(-1);
      expect(s).toBeLessThanOrEqual(1);
    }
    expect([...sims].sort((x, y) => y - x)).toEqual(sims);
    expect(sims[0]!).toBeGreaterThan(sims[2]!);
  });

  it('honours limit and clamps it to 1..50', async () => {
    const { src, a } = await seed();
    expect(ids(await service.related(src.id, { limit: 1 }))).toEqual([a.id]);
    expect((await service.related(src.id, { limit: 0 })).related).toHaveLength(1);
    expect((await service.related(src.id, { limit: 500 })).related).toHaveLength(3);
  });

  it('never returns a deleted note, even though its vector is kept', async () => {
    const { src, a, b, c } = await seed();
    await service.delete(a.id);
    expect(await hasCurrentRow(a.id)).toBe(true);
    expect(ids(await service.related(src.id))).toEqual([c.id, b.id]);
  });

  it('ignores stale vectors (body changed) and vectors from another model', async () => {
    const { src, a, b, c } = await seed();
    const a2 = await service.update(a.id, 'arango root password moved to bitwarden');
    const d = await service.create({ body: 'arangodb credentials rotated' });
    await embed(d, 'other/model');
    const r = await service.related(src.id);
    expect(ids(r)).not.toContain(a2.id);
    expect(ids(r)).not.toContain(d.id);
    expect(ids(r)).toEqual([c.id, b.id]);
  });

  it('embeds a source with no current vector on demand, once', async () => {
    const { src, a, b } = await seed();
    const fresh = await service.create({ body: 'vault holds the arangodb secret' });
    expect(await hasCurrentRow(fresh.id)).toBe(false);
    const before = fake.calls.length;
    const r = await service.related(fresh.id);
    expect(fake.calls.length).toBe(before + 1);
    expect(await hasCurrentRow(fresh.id)).toBe(true);
    // src and a both share two concepts with fresh; their mutual order is up to the hash tail.
    expect(ids(r).slice(0, 2)).toEqual(expect.arrayContaining([src.id, a.id]));
    expect(ids(r).at(-1)).toBe(b.id);
    await service.related(fresh.id);
    expect(fake.calls.length).toBe(before + 1);
  });

  it('re-embeds a source whose body changed since its vector was made', async () => {
    const { src } = await seed();
    await service.append(src.id, 'and the vault password');
    const before = fake.calls.length;
    await service.related(src.id);
    expect(fake.calls.length).toBe(before + 1);
  });

  it('without an embedder: answers from existing vectors, clear error for an unembedded source', async () => {
    const { src, a } = await seed();
    // With no embedder, "current" means model = EMBEDDING_MODEL. The fake already uses that id
    // (Phase 2 default), so these re-saves are no-ops kept to make the precondition explicit.
    await embed(src, EMBEDDING_MODEL);
    await embed(a, EMBEDDING_MODEL);
    expect(ids(await noEmbedder.related(src.id))[0]).toBe(a.id);
    const fresh = await service.create({ body: 'arangodb credentials again' });
    await expectNoteError(noEmbedder.related(fresh.id), 'not_embedded', /semantic search is off/);
  });

  it('a failing on-demand embed is a not_embedded error and stores nothing', async () => {
    await seed();
    const fresh = await service.create({ body: 'arangodb credentials again' });
    fake.failNext(1);
    await expectNoteError(service.related(fresh.id), 'not_embedded', /embedding it now failed/);
    expect(await hasCurrentRow(fresh.id)).toBe(false);
  });

  it('rejects bad, unknown and deleted ids, and a photo with no text', async () => {
    const { src } = await seed();
    await expectNoteError(service.related('not an id'), 'invalid_id');
    await expectNoteError(service.related('Z-ZZZ'), 'not_found');
    await service.delete(src.id);
    await expectNoteError(service.related(src.id), 'deleted', /restore/);
    const photo = await service.create({
      body: '',
      allowEmpty: true,
      image: { path: 'images/2026/10/photo.png', meta: photoMeta },
    });
    const before = fake.calls.length;
    await expectNoteError(service.related(photo.id), 'invalid_input', /photo with no text/);
    expect(fake.calls.length).toBe(before);
  });
});

describe('MCP related tool', () => {
  async function callTool(args: Record<string, unknown>): Promise<CallToolResult> {
    return (await client.callTool({ name: 'related', arguments: args })) as CallToolResult;
  }
  function text(r: CallToolResult): string {
    const first = r.content[0];
    if (!first || first.type !== 'text') throw new Error('expected text content');
    return first.text;
  }

  it('is listed, read-only, and returns { note_id, related: [{ note, similarity }] }', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'related');
    expect(tool).toBeDefined();
    expect(tool!.annotations?.readOnlyHint).toBe(true);

    const { src, a } = await seed();
    const r = await callTool({ id: src.id, limit: 2 });
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(text(r)) as RelatedResult;
    expect(body.note_id).toBe(src.id);
    expect(body.related).toHaveLength(2);
    expect(body.related[0]!.note.id).toBe(a.id);
    expect(typeof body.related[0]!.similarity).toBe('number');
    expect(Object.keys(body.related[0]!.note)).not.toContain('embedding');
  });

  it('rejects limit outside 1-50 and reports service errors as code: message', async () => {
    const { src } = await seed();
    expect((await callTool({ id: src.id, limit: 51 })).isError).toBe(true);
    expect((await callTool({ id: src.id, limit: 0 })).isError).toBe(true);
    const missing = await callTool({ id: 'Z-ZZZ' });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/^not_found: /);
  });
});
```
**Impact:** New file, picked up by the integration vitest config's `tests/integration/**/*.int.test.ts` glob. It makes no network call (invariant 3).

Note on the "stale" test: it updates `a` without re-embedding it, and no worker runs in this file. `a`'s row therefore keeps the old hash and must be ignored.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` (unit: chat-status, mcp.instructions) and `npm run test:int` (pgvector container; `related.int.test.ts` plus every existing file)
**Manual check:** Optional, on the test container: `begin; set local enable_seqscan = off; set local hnsw.iterative_scan = strict_order; explain select ... (the nearestNotes query) ...; rollback;` should show `Index Scan using note_embeddings_embedding_hnsw_idx`. This is not asserted in tests, because the planner may pick a sequential scan on a few rows, and that is correct too.
**Exit criteria:**
- `related` never returns the note itself or a deleted note.
- It orders by meaning and ignores stale or other-model vectors.
- It embeds an unembedded source once on demand.
- It returns `not_embedded` with no embedder or when the embed fails.
- A textless photo gets `invalid_input` "is a photo with no text".
- The chat allow list is 14 + 15 + 2, and the `related` caption is "finding related notes".
- typecheck, `npm test` and `npm run test:int` all pass.

## Handoffs

- **Phase 6 (R6/docs):** mention `related` in `claude/skills/n/SKILL.md` (for example "what other notes are related to <id>?" → `related`), in the README tool list (`README.md:433`/`:481` area) and in `docs/ROADMAP.md`. The acceptance prompt `/n what other notes are related to <id>?` depends on the skill text.
- **Phase 6:** the opt-in live test may also call `service.related` on the two usage-example notes. Optional; not required by R5.
- **Reconciled:** Phase 1's fragments are unaliased; Phase 2's `Lexicon`, `calls`, `failNext` and default `model` (= `EMBEDDING_MODEL`) match Step 8; `AppDeps` / `Config` after Phases 2–4 match Step 8's literals (`embeddings`, `embedder`); the `service.ts` import block in Step 3(a) is the merged one.
- **Not done here (drive-by):** `tests/integration/mcp.tools.int.test.ts:79` still says "eleven note tools" in its test name. The assertion uses `arrayContaining`, so it is left alone.

## Rollback

Revert this phase's commit. Nothing persistent depends on it: no migration, and the only rows it may write (on-demand `note_embeddings` upserts) are the same rows the phase 3 worker writes and stay valid. The chat allow list goes back to 13 together with its test.
