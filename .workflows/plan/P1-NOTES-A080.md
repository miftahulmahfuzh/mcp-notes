> Adopted from `/home/miftah/.worktrees/mcp-notes/session-search-context/.workflows/plan/SESSION_SEARCH_CONTEXT_PLAN.md` phase 1. Source: `.workflows/plan/session-search-context/phase-1.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 1: Candidate-source refactor of searchSessions

**Plan set:** `SESSION_SEARCH_CONTEXT_PLAN.md`
**Analysis:** `.workflows/analyze/20261106-145826-SSC7_code_analyzer.md`
**Satisfies:** R4 — Projects search is restructured so new context (Claude's replies, phase 5) is one more source, not another inline branch
**Depends on:** none
**Difficulty:** NORMAL
**Package:** `src/sessions`

---

## Goal

`searchSessions` (hybrid and text mode) gathers its candidates from a list of named
`CandidateSource`s (session text, session vector, node id, notes) and combines them in one pure
merge step, `mergeCandidates`, that takes the per-signal maximum and records, for each merged
candidate, which evidence (`'own'` or `'note'`) gave its best text rank and its best similarity.
Every search result stays exactly the same (same hits, order, scores, `via_notes`, cursors,
fallbacks). A golden snapshot written from the code as it is today proves that. Phase 5 adds
Claude's replies by appending one source to two lists and widening one union type.

## Interface Contract

**Deletes (all module-private in `src/sessions/search.ts`, no importer outside the file):**
`HitDbRow` (`search.ts:109`), `NoteVia` (`search.ts:132`), `hybridCandidates` (`search.ts:301`),
`maxOrNull` (`search.ts:404`), `HybridQuery` (`search.ts:293`), `noteHasSessionSql`'s and
`sessionsOfNotesSql`'s `via_notes` output column (renamed `items`, below). The inline SQL in
`textSearch` (`search.ts:255-291`) is replaced by sources.
**Renames:** the jsonb column `via_notes` produced by `sessionsOfNotesSql` -> `items` (private SQL alias).
**Creates (all exported from `src/sessions/search.ts`):**
- `type EvidenceKind = 'own' | 'note'`: where a signal came from. **Phase 5 widens it to `'own' | 'note' | 'reply'`.**
- `type RelatedKind = Exclude<EvidenceKind, 'own'>`
- `interface Signal { value: number; from: EvidenceKind }`
- `type SessionRow`: a `cc_sessions` hit row plus the session's OWN `text_rank` / `similarity` (numbers or null)
- `interface RelatedEvidence { kind: RelatedKind; session_id: string; text_rank: number | null; similarity: number | null; items: unknown }`
- `interface MergedCandidate { row: SessionRow; text: Signal | null; similarity: Signal | null; related: Partial<Record<RelatedKind, RelatedEvidence>> }`
- `type SourceRows = { kind: 'own'; rows: SessionRow[] } | { kind: 'related'; rows: RelatedEvidence[] }`
- `interface SourceQuery { tsq: SQL; vector: QueryVector | null; nodeIds: readonly string[]; excluded: readonly string[]; filter: SessionSearchFilter; textLimit: number | null }`
- `interface QueryVector { qvec: SQL; model: string }`
- `interface CandidateSource { name: string; run(db: Db, q: SourceQuery): Promise<SourceRows> }`
- `const sessionTextSource`, `sessionVectorSource`, `nodeIdSource`, `notesSource: CandidateSource`
- `const HYBRID_SOURCES: readonly CandidateSource[]` = `[sessionTextSource, sessionVectorSource, nodeIdSource, notesSource]`
- `const TEXT_SOURCES: readonly CandidateSource[]` = `[sessionTextSource, notesSource]`
- `function mergeCandidates(own: readonly SessionRow[], related: readonly RelatedEvidence[]): MergedCandidate[]` (pure)
- `function collectCandidates(db: Db, q: SourceQuery, sources: readonly CandidateSource[]): Promise<MergedCandidate[]>`
- `function compareTextRanked(a: MergedCandidate, b: MergedCandidate): number` (text mode order)
- `function relatedSourceRows(kind: RelatedKind, rows: readonly RelatedDbRow[]): SourceRows` and `type RelatedDbRow`: the boundary helper a related source (phase 5's replies) uses to turn its SQL rows into `RelatedEvidence`
- No shared "items -> per session" SQL helper: each related source owns its SQL (see Handoffs).
- test file `tests/unit/sessions/searchMerge.test.ts`, test file `tests/integration/sessions.search.golden.int.test.ts` + its snapshot `tests/integration/__snapshots__/sessions.search.golden.int.test.ts.snap`
**Signature changes:** private `toHit(r: HitDbRow, thisHost, score, viaNotes?)` -> `toHit(c: MergedCandidate, thisHost: string, score: number)`. Private `textSearch(...)` keeps its parameters. Public `searchSessions`, `SessionSearchHit`, `SessionSearchPage`, `SessionNoteMatch`, `SessionSearchDeps`, `SessionSearchFilter`, `SessionSearchOptions`, `SESSION_*`, `VIA_NOTES_MAX`, `SESSIONS_SEMANTIC_OFF_FALLBACK`, `sessionEmbedFailedFallback`: **unchanged**.
**Requires (from earlier phases):** none.
**Leaves alone (owned by others):** `src/search/blend.ts` (no weight, no type change; phase 5), `src/db/schema.ts` + `drizzle/*` (phases 2, 3), `src/sessions/readModel.ts`, `view.ts`, `src/mcp/*`, `src/http/*`, `src/chat/*` (phase 5), README / CLAUDE.md / `features/*.md` (phases 2, 3, 5), all of `web/` (R5), `tests/integration/sessions.search.int.test.ts` (kept byte for byte, must pass unchanged).

**What phase 5 does on top of this (for the reconciler):**
1. `export type EvidenceKind = 'own' | 'note' | 'reply';` (RelatedKind follows automatically).
2. Writes `const repliesSource: CandidateSource` whose `run` returns `relatedSourceRows('reply', res.rows)`, with `items` = a jsonb array of `{ seq }` best first (no reply text: excerpts are fetched for the shown page only, by `ts_headline`, see phase-5.md Step 4); uses `q.vector === null` to pick text-only SQL (text mode) vs text ∪ vector SQL (hybrid), and `q.textLimit` / `BLEND.vectorCandidates` as `notesSource` does.
3. Appends `repliesSource` to `HYBRID_SOURCES` and `TEXT_SOURCES`.
4. Changes private `toHit(c, thisHost, score)` to `toHit(c, thisHost, score, replyExcerpts)` and adds `via_replies: toViaReplies(c.row.session_id, c.related.reply?.items, replyExcerpts)`.
5. In the ranking, reads the own signals (`c.row.text_rank` / `c.row.similarity`) and the related ones (`c.related.*`) separately to compute `max(own, BLEND.related × related)`; `Signal.from` stays as diagnostic data.
`mergeCandidates` and `collectCandidates` need no change for any of that.

## Files

| File | Action | What changes |
|---|---|---|
| `tests/integration/sessions.search.golden.int.test.ts` | create (Step 1, BEFORE the refactor) | fixed-clock seed + a battery of hybrid/text/filter/paging queries, snapshot of every page |
| `tests/integration/__snapshots__/sessions.search.golden.int.test.ts.snap` | create (generated by Step 1 on today's code) | the golden output; never regenerated in this phase after Step 1 |
| `src/sessions/search.ts` | modify (whole file, lines 1-473) | types, sources, merge, collect; `textSearch` and `searchSessions` rebuilt on them |
| `tests/unit/sessions/searchMerge.test.ts` | create | pure tests of `mergeCandidates` and `compareTextRanked` |

## Implementation Steps

### Step 0: Install dependencies if the worktree has none
**File:** none (worktree root)
**Change:** the worktree has no `node_modules` until a phase installs them. Run once, before anything else:
```sh
cd /home/miftah/.worktrees/mcp-notes/session-search-context
[ -d node_modules ] || npm ci
```
**Impact:** none on the tree.

### Step 1: Golden snapshot of today's behaviour (on the UNCHANGED code)
**File:** `tests/integration/sessions.search.golden.int.test.ts` (new)
**Change:** seed sessions and notes with absolute timestamps (so recency, and hence every score,
is the same on every run), pass a fixed `now`, run a battery of queries in hybrid, text,
no-embedder and filtered/paged form, and snapshot the observable fields of each page. Then run it
**with `src/sessions/search.ts` still at `b41ae04`** so the snapshot records current behaviour:

```sh
cd /home/miftah/.worktrees/mcp-notes/session-search-context
git diff --quiet origin/main -- src/sessions/search.ts && echo "search.ts untouched: OK"
npm run test:int -- tests/integration/sessions.search.golden.int.test.ts --update
git add tests/integration/sessions.search.golden.int.test.ts tests/integration/__snapshots__/sessions.search.golden.int.test.ts.snap
```

Commit these two files on their own (`test(sessions): golden snapshot of searchSessions`) before
Step 2, so the snapshot provably predates the refactor. Never pass `--update` again in this phase.

**Code:**
```ts
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { toVectorLiteral } from '../../src/embeddings/repo.js';
import { QueryVectorCache } from '../../src/search/queryVector.js';
import {
  searchSessions,
  type SessionSearchFilter,
  type SessionSearchOptions,
  type SessionSearchPage,
} from '../../src/sessions/search.js';
import { createFakeEmbedder, type FakeEmbedder } from '../helpers/fakeEmbedder.js';
import { closeTestDb, migrateTestDb, openTestDb, truncateAll } from './setup.js';

/**
 * Golden output of searchSessions, written from the code as of b41ae04 (before the
 * candidate-source refactor) and kept byte for byte by it. Every timestamp is absolute and `now`
 * is fixed, so recency (and hence every blended score) is identical on every run.
 */

const HOST = 'golden-host';
const NOW = new Date('2026-11-01T00:00:00.000Z');
let db: Db;
let embedder: FakeEmbedder;

interface SeedSession {
  sessionId: string;
  nodeId: string;
  repo: string;
  host?: string;
  summary: string;
  lastActive: string;
  embed?: boolean;
}

const SESSIONS: SeedSession[] = [
  { sessionId: 'g-photo', nodeId: 'A0-3G', repo: 'mcp-notes', summary: 'Wall photo delete button added to the editor.', lastActive: '2026-10-01T10:00:00.000Z' },
  { sessionId: 'g-login', nodeId: 'B1-4H', repo: 'mcp-notes', summary: 'The login broke after the laptop slept.', lastActive: '2026-10-28T10:00:00.000Z' },
  { sessionId: 'g-board', nodeId: 'C2-5J', repo: 'seer', host: 'gpd', summary: 'Leaderboard ranking tweaks.', lastActive: '2026-10-30T10:00:00.000Z' },
  { sessionId: 'g-vault', nodeId: 'D3-6K', repo: 'mcp-notes', summary: 'Arango password moved to the vault.', lastActive: '2026-09-15T10:00:00.000Z' },
  { sessionId: 'g-noemb', nodeId: 'E4-7L', repo: 'seer', summary: 'Photo upload crash on resume.', lastActive: '2026-10-20T10:00:00.000Z', embed: false },
  { sessionId: 'g-tie-a', nodeId: 'F5-8M', repo: 'mcp-notes', summary: 'quokka tie session', lastActive: '2026-10-10T10:00:00.000Z' },
  { sessionId: 'g-tie-b', nodeId: 'G6-9N', repo: 'mcp-notes', summary: 'quokka tie session', lastActive: '2026-10-10T10:00:00.000Z' },
];

interface SeedNote {
  id: string;
  body: string;
  madeIn?: string;
  linkTo?: string[];
  embed?: boolean;
  deleted?: boolean;
}

const NOTES: SeedNote[] = [
  { id: 'N-001', body: 'Adversarial shows zero trades, suspect the cutoff', linkTo: ['g-board'] },
  { id: 'N-002', body: 'quokka migration plan', madeIn: 'g-photo' },
  { id: 'N-003', body: 'Leaderboard ranking tweaks.', linkTo: ['g-photo'] },
  { id: 'N-004', body: 'vault credentials rotated after the login incident', madeIn: 'g-vault', linkTo: ['g-login'] },
  { id: 'N-005', body: 'quokka deleted', linkTo: ['g-login'], deleted: true },
  { id: 'N-006', body: 'photo delete notes for the upload crash', linkTo: ['g-noemb'], embed: false },
  { id: 'N-007', body: 'quokka loose note' },
  { id: 'N-008', body: 'second quokka note about the migration', linkTo: ['g-photo', 'g-tie-a'] },
];

async function seed(): Promise<void> {
  for (const s of SESSIONS) {
    const started = new Date(new Date(s.lastActive).getTime() - 3_600_000).toISOString();
    await db.execute(sql`
      insert into cc_sessions (session_id, node_id, host, repo, cwd, name, first_prompt, prompts, summary,
        started_at, last_active_at, created_at, updated_at)
      values (${s.sessionId}, ${s.nodeId}, ${s.host ?? HOST}, ${s.repo}, '/tmp', null, 'start', '["start"]'::jsonb, ${s.summary},
        ${started}::timestamptz, ${s.lastActive}::timestamptz, ${s.lastActive}::timestamptz, ${s.lastActive}::timestamptz)
    `);
    if (s.embed !== false) {
      await db.execute(sql`
        insert into cc_session_embeddings (session_id, sha, model, embedding, embedded_at, created_at, updated_at)
        values (${s.sessionId}, 'sha', ${embedder.model}, ${toVectorLiteral(embedder.vectorFor(s.summary))}::vector,
          ${s.lastActive}::timestamptz, ${s.lastActive}::timestamptz, ${s.lastActive}::timestamptz)
      `);
    }
  }
  for (const n of NOTES) {
    const origin = n.madeIn !== undefined ? JSON.stringify({ claude_session: n.madeIn }) : null;
    await db.execute(sql`
      insert into notes (id, body, origin, created_at, updated_at, deleted_at)
      values (${n.id}, ${n.body}, ${origin}::jsonb, '2026-10-01T00:00:00Z'::timestamptz, '2026-10-01T00:00:00Z'::timestamptz,
        ${n.deleted === true ? sql`'2026-10-02T00:00:00Z'::timestamptz` : sql`null`})
    `);
    for (const sessionId of n.linkTo ?? []) {
      await db.execute(sql`insert into note_session_links (note_id, session_id) values (${n.id}, ${sessionId})`);
    }
    if (n.embed !== false) {
      await db.execute(sql`
        insert into note_embeddings (note_id, embedding, body_sha256, model, embedded_at, updated_at)
        values (${n.id}, ${toVectorLiteral(embedder.vectorFor(n.body))}::vector,
          encode(sha256(convert_to(${n.body}, 'UTF8')), 'hex'), ${embedder.model},
          '2026-10-01T00:00:00Z'::timestamptz, '2026-10-01T00:00:00Z'::timestamptz)
      `);
    }
  }
}

/** What a caller can observe of a page. */
function observable(page: SessionSearchPage): unknown {
  return {
    mode: page.mode,
    fallback: page.fallback ?? null,
    next_cursor: page.next_cursor,
    sessions: page.sessions.map((s) => ({
      session_id: s.session_id,
      node_id: s.node_id,
      available: s.available,
      title: s.title,
      score: s.score,
      via_notes: s.via_notes,
    })),
  };
}

const QUERIES = [
  'photo delete',
  'auth failures after resume',
  'C2-5J photo delete',
  'leaderboard',
  'leaderboard ranking tweaks',
  'quokka',
  'quokka migration',
  'adversarial trades',
  'vault credentials',
  'password',
  'leaderboard or login or photo',
  'photo -delete',
  '"photo delete"',
  'crash',
  'no such word anywhere',
];

const FILTERS: SessionSearchFilter[] = [
  { repo: 'seer' },
  { repo: 'mcp-notes' },
  { host: HOST },
  { from: '2026-10-15' },
  { to: '2026-10-15' },
];

beforeAll(async () => {
  await migrateTestDb();
  db = openTestDb();
  embedder = createFakeEmbedder();
});

afterAll(async () => {
  await closeTestDb(db);
});

beforeEach(async () => {
  await truncateAll(db);
  await seed();
});

async function run(query: string, filter: SessionSearchFilter, opts: SessionSearchOptions, withEmbedder = true): Promise<unknown> {
  const deps = { db, embedder: withEmbedder ? embedder : null, host: HOST, queryVectors: new QueryVectorCache() };
  return observable(await searchSessions(deps, query, filter, { now: NOW, ...opts }));
}

describe('searchSessions golden output (must not change in the candidate-source refactor)', () => {
  it('hybrid, every query', async () => {
    const out: Record<string, unknown> = {};
    for (const q of QUERIES) out[q] = await run(q, {}, {});
    expect(out).toMatchSnapshot();
  });

  it('text mode, every query', async () => {
    const out: Record<string, unknown> = {};
    for (const q of QUERIES) out[q] = await run(q, {}, { mode: 'text' });
    expect(out).toMatchSnapshot();
  });

  it('no embedder: text fallback, every query', async () => {
    const out: Record<string, unknown> = {};
    for (const q of QUERIES) out[q] = await run(q, {}, {}, false);
    expect(out).toMatchSnapshot();
  });

  it('filters, both modes', async () => {
    const out: Record<string, unknown> = {};
    for (const f of FILTERS) {
      for (const q of ['leaderboard or login or photo or quokka', 'quokka', 'auth failures after resume']) {
        out[`hybrid ${JSON.stringify(f)} ${q}`] = await run(q, f, {});
        out[`text ${JSON.stringify(f)} ${q}`] = await run(q, f, { mode: 'text' });
      }
    }
    expect(out).toMatchSnapshot();
  });

  it('paging walks the whole ranking, both modes', async () => {
    const out: Record<string, unknown> = {};
    for (const mode of ['hybrid', 'text'] as const) {
      const pages: unknown[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i += 1) {
        const page = await searchSessions(
          { db, embedder, host: HOST, queryVectors: new QueryVectorCache() },
          'leaderboard or login or photo or quokka or vault',
          { limit: 2, cursor },
          { now: NOW, mode },
        );
        pages.push(observable(page));
        if (page.next_cursor === null) break;
        cursor = page.next_cursor;
      }
      out[mode] = pages;
    }
    expect(out).toMatchSnapshot();
  });
});
```
**Impact:** adds one integration file and its snapshot. Passes on today's code by construction
(it was generated from it). If `next_cursor` values are opaque strings that embed nothing
time-dependent (they are `encodeCursor(offset)`), the snapshot is stable; confirm by running the
command twice and checking `git status` shows no snapshot change.

### Step 2: Rebuild `src/sessions/search.ts` on candidate sources and one merge
**File:** `src/sessions/search.ts:1-473` (replace the whole file)
**Change:** Lines 1-107 (imports, constants, fallbacks, public types) keep their content except
the imports listed. `HitDbRow`/`NoteVia`/`hybridCandidates`/`maxOrNull`/`HybridQuery` go. New:
the evidence and source types, the four sources, `mergeCandidates`, `collectCandidates`,
`compareTextRanked`, `relatedSourceRows`. `textSearch` and the hybrid part of `searchSessions`
call `collectCandidates` with `TEXT_SOURCES` / `HYBRID_SOURCES`.

Behaviour-preservation notes the code below is written to (do not "simplify" them away):
- Every own source selects the same `ownFields(q)`, so a session's own `text_rank` and
  `similarity` are the same whichever own source returned it; the first one wins in the merge
  (today: `if (!byId.has(...))`).
- Sessions found only through a related source are hydrated with the same `ownFields(q)`,
  **without** `filterSql` (as today's `extra` query; the related source already applied the filter),
  so they keep their own similarity even when they are not among the 100 nearest.
- Own wins a tie with a related source; a related source only replaces a signal it strictly beats.
  The value is the same as today's `maxOrNull`; only the recorded `from` depends on the rule.
- Text mode used to rank and page in SQL (`order by text_rank desc, s.last_active_at desc nulls
  last, s.session_id desc limit/offset`). It now fetches every match (text mode was already
  exhaustive: no candidate cap) and sorts with `compareTextRanked`, which reproduces that order.
  `ts_rank` values are fetched as the same `float8` the SQL compared, so ranks and ties match.
- The session text source keeps `order by ts_rank desc, last_active_at desc nulls last,
  session_id desc` before its `limit`, because that order decides which 500 sessions hybrid sees.

**Code:**
```ts
import { hostname } from 'node:os';
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { Embedder } from '../embeddings/embedder.js';
import { noteEmbeddings, notes } from '../db/schema.js';
import { isCurrentEmbeddingSql, toVectorLiteral } from '../embeddings/repo.js';
import { parseDateBound } from '../notes/dates.js';
import { decodeCursor, encodeCursor } from '../notes/repo.js';
import { NoteError, type SearchMode } from '../notes/types.js';
import { BLEND, queryTerms, rankCandidates, tagMatch } from '../search/blend.js';
import { QUERY_EMBED_TIMEOUT_MS, QueryVectorCache, embedQuery } from '../search/queryVector.js';
import { findNodeIdCandidates } from './ids.js';
import { NOTE_EXCERPT_CHARS, excerpt } from './view.js';

export const SESSION_SEARCH_DEFAULT_LIMIT = 20;
export const SESSION_SEARCH_MAX_LIMIT = 200;
/** Phase 1's generated tsvector column on cc_sessions (name, titles, prompts, summary; 'simple'). */
export const SESSION_TSV_COLUMN = 'search_tsv';
/** first_prompt is cut to this many characters in hits. */
const HIT_PROMPT_CHARS = 500;
/** At most this many matching notes are listed in a hit's via_notes. */
export const VIA_NOTES_MAX = 3;

export const SESSIONS_SEMANTIC_OFF_FALLBACK =
  'Meaning search is off on this server (OPENROUTER_API_KEY is not set), so these are full-text results only: sessions that share words with the query.';

export function sessionEmbedFailedFallback(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const reason = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
  return `The query could not be embedded (${reason}), so these are full-text results only: sessions that share words with the query.`;
}

export interface SessionSearchDeps {
  db: Db;
  embedder: Embedder | null;
  /** Default: one cache shared by every caller in the process. */
  queryVectors?: QueryVectorCache;
  /** This machine; `available` is `host === thisHost`. Default os.hostname(). */
  host?: string;
}

export interface SessionSearchFilter {
  /** Resolved repo key, e.g. `mcp-notes`. */
  repo?: string;
  /** Only sessions whose transcript lives on this host. */
  host?: string;
  /** Inclusive lower bound on the session's activity: YYYY-MM-DD (local day) or ISO datetime. */
  from?: string;
  /** Inclusive upper bound: YYYY-MM-DD (whole local day) or ISO datetime. */
  to?: string;
  /** 1..SESSION_SEARCH_MAX_LIMIT, default SESSION_SEARCH_DEFAULT_LIMIT. */
  limit?: number;
  /** Opaque value from a previous page's next_cursor. */
  cursor?: string;
}

export interface SessionSearchOptions {
  /** Default 'hybrid'. 'text' is the full-text ranking only. */
  mode?: SearchMode;
  queryTimeoutMs?: number;
  /** Recency reference. Default new Date(). */
  now?: Date;
}

/** One search result, wire-ready (snake_case, ISO strings). */
export interface SessionSearchHit {
  session_id: string;
  node_id: string;
  repo: string | null;
  host: string;
  /** False when the transcript lives on another machine (invariant 7). */
  available: boolean;
  cwd: string | null;
  branch: string | null;
  name: string | null;
  /** custom title, else AI title, else name. */
  title: string | null;
  /** Cut to 500 characters. */
  first_prompt: string | null;
  summary: string | null;
  started_at: string | null;
  last_active_at: string | null;
  parent_session_id: string | null;
  parent_link_source: 'env' | 'hook' | 'heuristic' | null;
  /**
   * Notes saved from (origin.claude_session) or linked to this session that matched the query,
   * best first, at most VIA_NOTES_MAX. Empty when the session matched on its own text only.
   */
  via_notes: SessionNoteMatch[];
  /** Ranking score: the blended score in hybrid mode, ts_rank in text mode (phase 7 rounds and returns it). */
  score: number;
}

/** A note of the session that matched the query. */
export interface SessionNoteMatch {
  id: string;
  excerpt: string;
}

export interface SessionSearchPage {
  sessions: SessionSearchHit[];
  next_cursor: string | null;
  /** The ranking actually used. */
  mode: SearchMode;
  /** Present only when hybrid was asked for but could not run. */
  fallback?: string;
}

// ---------------------------------------------------------------------------------------------
// Candidate sources and their merge.
//
// A search gathers candidates from a list of sources. An OWN source (session text, session
// vector, node id) returns cc_sessions rows carrying the session's own signals. A RELATED source
// (notes; phase 5 adds replies) returns, per session, the best text rank and similarity among
// that session's matching items plus the items themselves. mergeCandidates folds them into one
// candidate per session that takes the best value of each signal and remembers which kind of
// evidence gave it. Adding context to search = writing one source and listing it below.
// ---------------------------------------------------------------------------------------------

/** Where a signal came from: the session's own text/vector, or one kind of related item. */
export type EvidenceKind = 'own' | 'note';
/** The related item kinds: every evidence kind except the session's own. */
export type RelatedKind = Exclude<EvidenceKind, 'own'>;

/** A signal's value and the evidence that produced it. */
export interface Signal {
  value: number;
  from: EvidenceKind;
}

/** A cc_sessions row as the database returns it: hit fields plus the session's own signals. */
type SessionDbRow = {
  session_id: string;
  node_id: string;
  repo: string | null;
  host: string;
  cwd: string | null;
  branch: string | null;
  name: string | null;
  custom_title: string | null;
  ai_title: string | null;
  first_prompt: string | null;
  summary: string | null;
  started_at: Date | string | null;
  last_active_at: Date | string | null;
  parent_session_id: string | null;
  parent_link_source: string | null;
  text_rank: number | string | null;
  similarity: number | string | null;
};

/** A session candidate's row with its own signals as numbers. */
export type SessionRow = Omit<SessionDbRow, 'text_rank' | 'similarity'> & {
  /** ts_rank of the session's own search_tsv; null when its own text does not match. */
  text_rank: number | null;
  /** Cosine similarity of the session's own current vector; null without one, always null in text mode. */
  similarity: number | null;
};

/** One related source's per-session row as the database returns it. */
export type RelatedDbRow = {
  session_id: string;
  text_rank: number | string | null;
  similarity: number | string | null;
  /** jsonb array of the session's matching items, best first. */
  items: unknown;
};

/** One kind of related item's best evidence for one session. */
export interface RelatedEvidence {
  kind: RelatedKind;
  session_id: string;
  /** Best ts_rank among the session's matching items of this kind; null when none matched by words. */
  text_rank: number | null;
  /** Best cosine similarity among them; null when none has a current vector (or text mode). */
  similarity: number | null;
  /** The matching items, best first, as the source's jsonb array; toHit maps them to via_*. */
  items: unknown;
}

/** One session after the merge. */
export interface MergedCandidate {
  row: SessionRow;
  /** Best full-text rank over own and related evidence; null when nothing matched by words. */
  text: Signal | null;
  /** Best similarity over own and related evidence; null when nothing has a current vector. */
  similarity: Signal | null;
  /** Each related kind's evidence for this session, when that kind matched. */
  related: Partial<Record<RelatedKind, RelatedEvidence>>;
}

export type SourceRows = { kind: 'own'; rows: SessionRow[] } | { kind: 'related'; rows: RelatedEvidence[] };

/** The query vector and the embedding model it belongs to. */
export interface QueryVector {
  /** `'[...]'::vector` literal. */
  qvec: SQL;
  model: string;
}

/** Everything a source needs to know about one search. */
export interface SourceQuery {
  /** websearch_to_tsquery('simple', query). */
  tsq: SQL;
  /** Null in text mode: sources then run their full-text part only and report no similarity. */
  vector: QueryVector | null;
  /** Node ids named in the query (hybrid only; empty in text mode). */
  nodeIds: readonly string[];
  /** Websearch exclusions, applied to vector candidates (hybrid only; empty in text mode). */
  excluded: readonly string[];
  filter: SessionSearchFilter;
  /** Rows per full-text source; null = every match (text mode is exhaustive). */
  textLimit: number | null;
}

export interface CandidateSource {
  /** Stable name for tests and logs. */
  name: string;
  run(db: Db, q: SourceQuery): Promise<SourceRows>;
}

const defaultQueryVectors = new QueryVectorCache();

function toDate(v: Date | string | null): Date | null {
  if (v === null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clampSessionLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return SESSION_SEARCH_DEFAULT_LIMIT;
  return Math.min(SESSION_SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

function tsv(): SQL {
  return sql.raw(`s.${SESSION_TSV_COLUMN}`);
}

function hitFields(): SQL {
  return sql`s.session_id, s.node_id, s.repo, s.host, s.cwd, s.branch, s.name, s.custom_title, s.ai_title,
    left(s.first_prompt, ${HIT_PROMPT_CHARS}) as first_prompt, s.summary, s.started_at, s.last_active_at,
    s.parent_session_id, s.parent_link_source`;
}

function filterSql(filter: SessionSearchFilter): SQL {
  const conds: SQL[] = [sql`true`];
  if (filter.repo !== undefined && filter.repo !== '') conds.push(sql`s.repo = ${filter.repo}`);
  if (filter.host !== undefined && filter.host !== '') conds.push(sql`s.host = ${filter.host}`);
  if (filter.from !== undefined && filter.from !== '') {
    conds.push(sql`coalesce(s.last_active_at, s.started_at) >= ${parseDateBound(filter.from, 'from').toISOString()}::timestamptz`);
  }
  if (filter.to !== undefined && filter.to !== '') {
    conds.push(sql`coalesce(s.started_at, s.last_active_at) < ${parseDateBound(filter.to, 'to').toISOString()}::timestamptz`);
  }
  return sql.join(conds, sql` and `);
}

function toSessionRow(r: SessionDbRow): SessionRow {
  return { ...r, text_rank: toNumberOrNull(r.text_rank), similarity: toNumberOrNull(r.similarity) };
}

/** The boundary for related sources: database rows -> typed evidence of one kind. */
export function relatedSourceRows(kind: RelatedKind, rows: readonly RelatedDbRow[]): SourceRows {
  return {
    kind: 'related',
    rows: rows.map((r) => ({
      kind,
      session_id: r.session_id,
      text_rank: toNumberOrNull(r.text_rank),
      similarity: toNumberOrNull(r.similarity),
      items: r.items,
    })),
  };
}

/** `e.*` is the session's current embedding for the query's model. */
function currentEmbeddingOn(v: QueryVector): SQL {
  return sql`e.session_id = s.session_id and e.model = ${v.model} and e.embedding is not null`;
}

/** The left join that gives own rows their similarity; nothing in text mode. */
function ownEmbeddingJoin(q: SourceQuery): SQL {
  return q.vector === null ? sql.empty() : sql`left join cc_session_embeddings e on ${currentEmbeddingOn(q.vector)}`;
}

/** Hit fields plus the session's own text rank and similarity. Every own source selects exactly this. */
function ownFields(q: SourceQuery): SQL {
  const similarity = q.vector === null ? sql`null::float8` : sql`(1 - (e.embedding <=> ${q.vector.qvec}))::float8`;
  return sql`${hitFields()},
    (case when ${tsv()} @@ ${q.tsq} then ts_rank(${tsv()}, ${q.tsq}) end)::float8 as text_rank,
    ${similarity} as similarity`;
}

function idList(ids: readonly string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}

/** Sessions whose own search_tsv matches, best ts_rank first (at most textLimit). */
export const sessionTextSource: CandidateSource = {
  name: 'session_text',
  async run(db, q) {
    const limit = q.textLimit === null ? sql.empty() : sql`limit ${q.textLimit}`;
    const res = await db.execute<SessionDbRow>(sql`
      select ${ownFields(q)}
      from cc_sessions s
      ${ownEmbeddingJoin(q)}
      where ${tsv()} @@ ${q.tsq} and ${filterSql(q.filter)}
      order by ts_rank(${tsv()}, ${q.tsq}) desc, s.last_active_at desc nulls last, s.session_id desc
      ${limit}
    `);
    return { kind: 'own', rows: res.rows.map(toSessionRow) };
  },
};

/** The sessions nearest the query vector (exclusions apply here too, as in note search). Hybrid only. */
export const sessionVectorSource: CandidateSource = {
  name: 'session_vector',
  async run(db, q) {
    if (q.vector === null) return { kind: 'own', rows: [] };
    const excluded =
      q.excluded.length > 0
        ? sql`not (${tsv()} @@ websearch_to_tsquery('simple', ${q.excluded.join(' OR ')}))`
        : sql`true`;
    const res = await db.execute<SessionDbRow>(sql`
      select ${ownFields(q)}
      from cc_sessions s
      join cc_session_embeddings e on ${currentEmbeddingOn(q.vector)}
      where ${filterSql(q.filter)} and ${excluded}
      order by e.embedding <=> ${q.vector.qvec}
      limit ${BLEND.vectorCandidates}
    `);
    return { kind: 'own', rows: res.rows.map(toSessionRow) };
  },
};

/** Sessions the query names by node id. */
export const nodeIdSource: CandidateSource = {
  name: 'node_id',
  async run(db, q) {
    if (q.nodeIds.length === 0) return { kind: 'own', rows: [] };
    const res = await db.execute<SessionDbRow>(sql`
      select ${ownFields(q)}
      from cc_sessions s
      ${ownEmbeddingJoin(q)}
      where s.node_id in (${idList(q.nodeIds)}) and ${filterSql(q.filter)}
    `);
    return { kind: 'own', rows: res.rows.map(toSessionRow) };
  },
};

/** Live notes that belong to a session: saved from it, or linked to it with link_note. */
function noteHasSessionSql(): SQL {
  return sql`(${notes.origin} ->> 'claude_session' is not null
    or exists (select 1 from note_session_links l where l.note_id = ${notes.id}))`;
}

/**
 * `matched(note_id, body, text_rank, similarity)` -> per session of `filter`:
 * `(session_id, text_rank, similarity, items)`, the best of its matching notes. A note counts
 * for every session it was saved from or is linked to (each session once per note).
 */
function sessionsOfNotesSql(matched: SQL, filter: SessionSearchFilter): SQL {
  return sql`
    with matched as (${matched}),
    owners as (
      select m.note_id, n.origin ->> 'claude_session' as session_id
      from matched m join notes n on n.id = m.note_id
      where n.origin ->> 'claude_session' is not null
      union
      select l.note_id, l.session_id from note_session_links l where l.note_id in (select note_id from matched)
    )
    select s.session_id,
      max(m.text_rank)::float8 as text_rank,
      max(m.similarity)::float8 as similarity,
      jsonb_agg(jsonb_build_object('id', m.note_id, 'body', left(m.body, ${NOTE_EXCERPT_CHARS * 2}))
        order by m.text_rank desc nulls last, m.similarity desc nulls last, m.note_id) as items
    from matched m
    join owners o on o.note_id = m.note_id
    join cc_sessions s on s.session_id = o.session_id
    where ${filterSql(filter)}
    group by s.session_id
  `;
}

function noteTsv(): SQL {
  return sql`to_tsvector('simple', ${notes.body})`;
}

/** Text mode: every live session note that matches by words. */
function notesTextOnlySql(q: SourceQuery): SQL {
  return sql`select ${notes.id} as note_id, ${notes.body} as body, ts_rank(${noteTsv()}, ${q.tsq}) as text_rank, null::float8 as similarity
    from ${notes}
    where ${notes.deletedAt} is null and ${noteTsv()} @@ ${q.tsq} and ${noteHasSessionSql()}`;
}

/** Hybrid: the best word matches (at most textLimit) and the nearest notes, session notes only. */
function notesHybridSql(q: SourceQuery, v: QueryVector): SQL {
  const noteVec = sql`(${noteEmbeddings.embedding} <=> ${v.qvec})`;
  const noteJoin = sql`${noteEmbeddings.noteId} = ${notes.id} and ${isCurrentEmbeddingSql(v.model)}`;
  const noteFields = sql`${notes.id} as note_id, ${notes.body} as body,
    (case when ${noteTsv()} @@ ${q.tsq} then ts_rank(${noteTsv()}, ${q.tsq}) end)::float8 as text_rank,
    (1 - ${noteVec})::float8 as similarity`;
  const noteExcluded =
    q.excluded.length > 0
      ? sql`not (${noteTsv()} @@ websearch_to_tsquery('simple', ${q.excluded.join(' OR ')}))`
      : sql`true`;
  const textLimit = q.textLimit === null ? sql.empty() : sql`limit ${q.textLimit}`;
  return sql`(select ${noteFields} from ${notes} left join ${noteEmbeddings} on ${noteJoin}
      where ${notes.deletedAt} is null and ${noteTsv()} @@ ${q.tsq} and ${noteHasSessionSql()}
      order by ts_rank(${noteTsv()}, ${q.tsq}) desc
      ${textLimit})
    union
    (select ${noteFields} from ${notes} join ${noteEmbeddings} on ${noteJoin}
      where ${notes.deletedAt} is null and ${noteHasSessionSql()} and ${noteExcluded}
      order by ${noteVec}
      limit ${BLEND.vectorCandidates})`;
}

/** Sessions whose notes (saved from them or linked to them) match, by words or meaning. */
export const notesSource: CandidateSource = {
  name: 'notes',
  async run(db, q) {
    const matched = q.vector === null ? notesTextOnlySql(q) : notesHybridSql(q, q.vector);
    const res = await db.execute<RelatedDbRow>(sessionsOfNotesSql(matched, q.filter));
    return relatedSourceRows('note', res.rows);
  },
};

/** Hybrid mode's sources, in the order their rows are merged. */
export const HYBRID_SOURCES: readonly CandidateSource[] = [sessionTextSource, sessionVectorSource, nodeIdSource, notesSource];
/** Text mode's sources: the full-text part of every source that has one. */
export const TEXT_SOURCES: readonly CandidateSource[] = [sessionTextSource, notesSource];

/**
 * The own row (signals included) of sessions only a related source found. No filterSql: the
 * related source has already applied the filter to these sessions.
 */
async function sessionRowsById(db: Db, q: SourceQuery, ids: readonly string[]): Promise<SessionRow[]> {
  if (ids.length === 0) return [];
  const res = await db.execute<SessionDbRow>(sql`
    select ${ownFields(q)}
    from cc_sessions s
    ${ownEmbeddingJoin(q)}
    where s.session_id in (${idList(ids)})
  `);
  return res.rows.map(toSessionRow);
}

/** `cur`, or a signal from `from` when `value` strictly beats it. */
function better(cur: Signal | null, value: number | null, from: RelatedKind): Signal | null {
  if (value === null) return cur;
  if (cur === null || value > cur.value) return { value, from };
  return cur;
}

/**
 * One candidate per session: the first own row of each session (every own source computes the
 * same own signals), then each related evidence row takes over a signal it strictly beats, so
 * the session's own evidence wins ties and earlier sources win ties among related kinds. A
 * related row whose session has no own row (gone between the source query and hydration) and a
 * second row of the same kind for one session (sources group by session, so none is produced)
 * are ignored. Pure: no I/O.
 */
export function mergeCandidates(own: readonly SessionRow[], related: readonly RelatedEvidence[]): MergedCandidate[] {
  const byId = new Map<string, MergedCandidate>();
  for (const row of own) {
    if (byId.has(row.session_id)) continue;
    byId.set(row.session_id, {
      row,
      text: row.text_rank === null ? null : { value: row.text_rank, from: 'own' },
      similarity: row.similarity === null ? null : { value: row.similarity, from: 'own' },
      related: {},
    });
  }
  for (const ev of related) {
    const c = byId.get(ev.session_id);
    if (c === undefined || c.related[ev.kind] !== undefined) continue;
    c.related[ev.kind] = ev;
    c.text = better(c.text, ev.text_rank, ev.kind);
    c.similarity = better(c.similarity, ev.similarity, ev.kind);
  }
  return [...byId.values()];
}

/** Runs `sources` in order, hydrates sessions only related evidence found, and merges. */
export async function collectCandidates(
  db: Db,
  q: SourceQuery,
  sources: readonly CandidateSource[],
): Promise<MergedCandidate[]> {
  const own: SessionRow[] = [];
  const related: RelatedEvidence[] = [];
  for (const source of sources) {
    const out = await source.run(db, q);
    if (out.kind === 'own') own.push(...out.rows);
    else related.push(...out.rows);
  }
  const known = new Set(own.map((r) => r.session_id));
  const missing = [...new Set(related.map((r) => r.session_id))].filter((id) => !known.has(id));
  own.push(...(await sessionRowsById(db, q, missing)));
  return mergeCandidates(own, related);
}

/**
 * Text mode's order: best text rank first, then most recently active (no activity last), then
 * session id descending. The same order the single SQL query used before the sources existed.
 */
export function compareTextRanked(a: MergedCandidate, b: MergedCandidate): number {
  const ra = a.text?.value ?? Number.NEGATIVE_INFINITY;
  const rb = b.text?.value ?? Number.NEGATIVE_INFINITY;
  if (ra !== rb) return rb > ra ? 1 : -1;
  const ta = toDate(a.row.last_active_at)?.getTime() ?? null;
  const tb = toDate(b.row.last_active_at)?.getTime() ?? null;
  if (ta !== tb) {
    if (ta === null) return 1;
    if (tb === null) return -1;
    return tb - ta;
  }
  const ia = a.row.session_id;
  const ib = b.row.session_id;
  return ia < ib ? 1 : ia > ib ? -1 : 0;
}

function toViaNotes(v: unknown): SessionNoteMatch[] {
  if (!Array.isArray(v)) return [];
  const out: SessionNoteMatch[] = [];
  for (const item of v) {
    if (typeof item !== 'object' || item === null) continue;
    const { id, body } = item as { id?: unknown; body?: unknown };
    if (typeof id !== 'string' || out.some((n) => n.id === id)) continue;
    out.push({ id, excerpt: excerpt(typeof body === 'string' ? body : '', NOTE_EXCERPT_CHARS) ?? '' });
    if (out.length === VIA_NOTES_MAX) break;
  }
  return out;
}

function toHit(c: MergedCandidate, thisHost: string, score: number): SessionSearchHit {
  const r = c.row;
  const source = r.parent_link_source;
  return {
    session_id: r.session_id,
    node_id: r.node_id,
    repo: r.repo,
    host: r.host,
    available: r.host === thisHost,
    cwd: r.cwd,
    branch: r.branch,
    name: r.name,
    title: r.custom_title ?? r.ai_title ?? r.name,
    first_prompt: r.first_prompt,
    summary: r.summary,
    started_at: toDate(r.started_at)?.toISOString() ?? null,
    last_active_at: toDate(r.last_active_at)?.toISOString() ?? null,
    parent_session_id: r.parent_session_id,
    parent_link_source: source === 'env' || source === 'hook' || source === 'heuristic' ? source : null,
    via_notes: toViaNotes(c.related.note?.items),
    score,
  };
}

function tsQuery(query: string): SQL {
  return sql`websearch_to_tsquery('simple', ${query})`;
}

async function textSearch(
  deps: SessionSearchDeps,
  query: string,
  filter: SessionSearchFilter,
  offset: number,
  limit: number,
  fallback?: string,
): Promise<SessionSearchPage> {
  const q: SourceQuery = { tsq: tsQuery(query), vector: null, nodeIds: [], excluded: [], filter, textLimit: null };
  // A session ranks by the better of its own text and its best matching related item's.
  const ranked = (await collectCandidates(deps.db, q, TEXT_SOURCES)).sort(compareTextRanked);
  const thisHost = deps.host ?? hostname();
  const end = offset + limit;
  const page: SessionSearchPage = {
    sessions: ranked.slice(offset, end).map((c) => toHit(c, thisHost, c.text?.value ?? 0)),
    next_cursor: ranked.length > end ? encodeCursor(end) : null,
    mode: 'text',
  };
  if (fallback !== undefined) page.fallback = fallback;
  return page;
}

/**
 * Hybrid search over cc_sessions: full-text rank on the generated tsvector, closeness in
 * meaning from cc_session_embeddings, the repo as a tag, recency of last activity, and an
 * exact node id. Candidates come from HYBRID_SOURCES; the notes saved from or linked to a
 * session count as its text too: a session takes the better of its own and its best note's
 * rank and similarity, and lists those notes in via_notes. Everything is blended by
 * src/search/blend.ts (same weights as note search). Falls back to full text (TEXT_SOURCES),
 * with `fallback` saying why, without an embedder or when the query cannot be embedded in time.
 * The cursor is an offset into whichever ranking produced the page.
 */
export async function searchSessions(
  deps: SessionSearchDeps,
  query: string,
  filter: SessionSearchFilter = {},
  opts: SessionSearchOptions = {},
): Promise<SessionSearchPage> {
  if (query.trim() === '') throw new NoteError('invalid_input', 'sessions search needs a non-empty query.');
  const offset = decodeCursor(filter.cursor);
  const limit = clampSessionLimit(filter.limit);
  // Validate dates before spending an embedding call.
  filterSql(filter);
  if (opts.mode === 'text') return textSearch(deps, query, filter, offset, limit);
  const embedder = deps.embedder;
  if (embedder === null) return textSearch(deps, query, filter, offset, limit, SESSIONS_SEMANTIC_OFF_FALLBACK);

  let vector: number[];
  try {
    vector = await embedQuery(
      embedder,
      deps.queryVectors ?? defaultQueryVectors,
      query,
      opts.queryTimeoutMs ?? QUERY_EMBED_TIMEOUT_MS,
    );
  } catch (err) {
    return textSearch(deps, query, filter, offset, limit, sessionEmbedFailedFallback(err));
  }

  const terms = queryTerms(query);
  const nodeIds = findNodeIdCandidates(query.toUpperCase());
  const candidates = await collectCandidates(
    deps.db,
    {
      tsq: tsQuery(query),
      vector: { qvec: sql`${toVectorLiteral(vector)}::vector`, model: embedder.model },
      nodeIds,
      excluded: terms.excluded,
      filter,
      textLimit: BLEND.textCandidates,
    },
    HYBRID_SOURCES,
  );
  const epoch = new Date(0);
  const ranked = rankCandidates(
    candidates.map((c) => ({
      id: c.row.session_id,
      textRank: c.text?.value ?? null,
      similarity: c.similarity?.value ?? null,
      tagMatch: tagMatch(c.row.repo !== null ? [c.row.repo.toLowerCase()] : [], terms),
      updatedAt: toDate(c.row.last_active_at) ?? toDate(c.row.started_at) ?? epoch,
      exactId: nodeIds.includes(c.row.node_id),
      candidate: c,
    })),
    { now: opts.now ?? new Date() },
  );
  const thisHost = deps.host ?? hostname();
  const end = offset + limit;
  return {
    sessions: ranked.slice(offset, end).map((r) => toHit(r.candidate, thisHost, r.score)),
    next_cursor: ranked.length > end ? encodeCursor(end) : null,
    mode: 'hybrid',
  };
}
```
**Impact:** internal only; the exported API of the module is a superset of today's. Two
deliberate, invisible differences: (a) text mode fetches all matching sessions and notes and
pages in memory instead of `limit/offset` in SQL (text mode had no candidate cap before either; at
~740 sessions this is one query of at most that many short rows); (b) the session-id tie-break in
text mode now compares in JavaScript (code units) instead of the database collation, exactly like
hybrid mode already does via `rankCandidates`. Session ids are lower-case UUIDs, for which both
orders agree; the golden test's `g-tie-a` / `g-tie-b` pair pins it.

If `sql.empty()` is not exported by the installed drizzle-orm, use `sql\`\`` in its three places;
`npm run typecheck` tells. (It is in drizzle-orm's `sql` namespace, `sql/sql.d.ts:144`.)

### Step 3: Unit tests for the merge and the text-mode order
**File:** `tests/unit/sessions/searchMerge.test.ts` (new)
**Change:** pure tests of the behaviour phase 5 builds on: per-signal max, own wins ties, `from`
recorded, related-only sessions, orphan evidence ignored, first own row wins, text-mode order.
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import {
  compareTextRanked,
  mergeCandidates,
  relatedSourceRows,
  type RelatedEvidence,
  type SessionRow,
} from '../../../src/sessions/search.js';

function row(sessionId: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: sessionId,
    node_id: `N${sessionId.length}-ABC`,
    repo: 'mcp-notes',
    host: 'h',
    cwd: '/tmp',
    branch: null,
    name: null,
    custom_title: null,
    ai_title: null,
    first_prompt: null,
    summary: null,
    started_at: '2026-10-01T00:00:00.000Z',
    last_active_at: '2026-10-01T01:00:00.000Z',
    parent_session_id: null,
    parent_link_source: null,
    text_rank: null,
    similarity: null,
    ...over,
  };
}

function note(sessionId: string, textRank: number | null, similarity: number | null, items: unknown = [{ id: 'A-001', body: 'b' }]): RelatedEvidence {
  return { kind: 'note', session_id: sessionId, text_rank: textRank, similarity, items };
}

describe('mergeCandidates', () => {
  it('a session matched on its own text only: own signals, no related evidence', () => {
    const [c] = mergeCandidates([row('s1', { text_rank: 0.3, similarity: 0.5 })], []);
    expect(c?.text).toEqual({ value: 0.3, from: 'own' });
    expect(c?.similarity).toEqual({ value: 0.5, from: 'own' });
    expect(c?.related).toEqual({});
  });

  it('takes the best of own and note per signal and records which one gave it', () => {
    const [c] = mergeCandidates([row('s1', { text_rank: 0.1, similarity: 0.8 })], [note('s1', 0.4, 0.2)]);
    expect(c?.text).toEqual({ value: 0.4, from: 'note' });
    expect(c?.similarity).toEqual({ value: 0.8, from: 'own' });
    expect(c?.related.note?.items).toEqual([{ id: 'A-001', body: 'b' }]);
  });

  it('own evidence wins a tie', () => {
    const [c] = mergeCandidates([row('s1', { text_rank: 0.4, similarity: 0.2 })], [note('s1', 0.4, 0.2)]);
    expect(c?.text?.from).toBe('own');
    expect(c?.similarity?.from).toBe('own');
  });

  it('a session only its notes found gets both signals from the notes', () => {
    const [c] = mergeCandidates([row('s2')], [note('s2', 0.2, 0.6)]);
    expect(c?.text).toEqual({ value: 0.2, from: 'note' });
    expect(c?.similarity).toEqual({ value: 0.6, from: 'note' });
  });

  it('null note signals never replace or create a signal', () => {
    const [c] = mergeCandidates([row('s1', { similarity: 0.5 })], [note('s1', null, null)]);
    expect(c?.text).toBeNull();
    expect(c?.similarity).toEqual({ value: 0.5, from: 'own' });
    expect(c?.related.note).toBeDefined();
  });

  it('ignores evidence for a session with no own row, and a second row of the same kind', () => {
    const out = mergeCandidates([row('s1')], [note('gone', 0.9, 0.9), note('s1', 0.1, null), note('s1', 0.9, 0.9, [{ id: 'B-002', body: 'x' }])]);
    expect(out.map((c) => c.row.session_id)).toEqual(['s1']);
    expect(out[0]?.text).toEqual({ value: 0.1, from: 'note' });
    expect(out[0]?.related.note?.items).toEqual([{ id: 'A-001', body: 'b' }]);
  });

  it('keeps the first own row of a session (every own source computes the same signals)', () => {
    const out = mergeCandidates([row('s1', { text_rank: 0.3, summary: 'first' }), row('s1', { text_rank: 0.3, summary: 'second' })], []);
    expect(out).toHaveLength(1);
    expect(out[0]?.row.summary).toBe('first');
  });
});

describe('relatedSourceRows', () => {
  it('normalizes database numbers (numeric strings, nulls) at the boundary', () => {
    expect(relatedSourceRows('note', [{ session_id: 's1', text_rank: '0.25', similarity: null, items: [] }])).toEqual({
      kind: 'related',
      rows: [{ kind: 'note', session_id: 's1', text_rank: 0.25, similarity: null, items: [] }],
    });
  });
});

describe('compareTextRanked', () => {
  it('orders by text rank, then most recent activity (none last), then session id descending', () => {
    const [a, b, c, d, e] = mergeCandidates(
      [
        row('a', { text_rank: 0.1 }),
        row('b', { text_rank: 0.5 }),
        row('c', { text_rank: 0.1, last_active_at: '2026-10-05T00:00:00.000Z' }),
        row('d', { text_rank: 0.1, last_active_at: null }),
        row('e', { text_rank: 0.1 }),
      ],
      [],
    );
    const sorted = [a, b, c, d, e].filter((x) => x !== undefined).sort(compareTextRanked);
    expect(sorted.map((x) => x.row.session_id)).toEqual(['b', 'c', 'e', 'a', 'd']);
  });
});
```
**Impact:** new unit file, picked up by `npm test` (`tests/unit/**`).

### Step 4: Prove the refactor kept behaviour, then commit
**File:** none
**Change:** run, in order: `npm run typecheck`, `npm test`,
`npm run test:int -- tests/integration/sessions.search.golden.int.test.ts tests/integration/sessions.search.int.test.ts`
(no `--update`), then the full `npm run test:int`. Then `git status --porcelain tests/integration/__snapshots__`
must print nothing (the snapshot is unchanged). Commit `refactor(sessions): candidate sources and one merge in searchSessions`.
**Impact:** none.

## Principles applied

- Build the lever: behaviour identity is proven by a golden snapshot (Step 1) generated from the unchanged code and committed before the refactor, instead of by reading the diff; a reviewer reruns it.
- Sequence into verifiable units: Step 1 lands and is committed (passing) before Step 2 touches `search.ts`, so the refactor ends in a check that can fail.
- Make illegal states unrepresentable: the merged signal is `Signal | null` (`{ value, from }`), so a text rank without its evidence kind (or the reverse) cannot be built; `SourceRows` is a discriminated union so an own source cannot hand back evidence rows and vice versa.
- Boundary discipline: database numbers (`number | string | null`) are normalized once, in `toSessionRow` / `relatedSourceRows` at each source's exit; the merge, sort and blend take typed numbers only (today `toNumberOrNull` was sprinkled through the merge and the ranking).
- Laziness protocol: no new module, no generic SQL builder for related sources, no parallel execution of sources; everything stays in `search.ts`, and phase 5's reply source writes its own SQL beside `notesSource`'s.
- Test behavior, not implementation: the golden test asserts only the observable page (`session_id`, `node_id`, `available`, `title`, `score`, `via_notes`, `next_cursor`, `mode`, `fallback`); the unit tests drive the exported pure merge, not private SQL.

## Verification

**Build:** `cd /home/miftah/.worktrees/mcp-notes/session-search-context && ([ -d node_modules ] || npm ci) && npm run typecheck`
**Tests:** `npm test && npm run test:int` (includes `tests/integration/sessions.search.int.test.ts`, unchanged, and the new golden file, run without `--update`)
**Proof:** the real daemon answers every search the same before and after the refactor.
- Harness: `.claude/skills/verify-notesd` (`scripts/verify.sh`). No `--embed`, so the daemon runs
  text mode with `fallback` (the documented default); hybrid identity is proven by the golden
  integration test with the fake embedder, which is the only unbilled way to drive hybrid.
- Feature-map entries: `.claude/skills/verify-notesd/features/projects.md` (session search, "Session
  search matches a session's notes too"). Not edited: nothing a user can observe changes.
- Journeys:
  1. **Same answers on base and branch (A/B on two throwaway daemons).** Save this as
     `$SCRATCH/ab.sh` (`SCRATCH` = the session scratchpad) and run `bash $SCRATCH/ab.sh`:
     ```sh
     set -euo pipefail
     WT=/home/miftah/.worktrees/mcp-notes/session-search-context
     SCRATCH=${SCRATCH:?set SCRATCH to the scratchpad dir}
     # Base = the tree just before this phase's Step 1 commit (phase 2 may already be on the set
     # branch, and its commit-subject index changes ranks; comparing against origin/main would mix it in).
     STEP1=$(git -C "$WT" log --format=%H --diff-filter=A -- tests/integration/sessions.search.golden.int.test.ts | tail -1)
     BASE_SHA=$(git -C "$WT" rev-parse "$STEP1^")
     rm -rf "$SCRATCH/base" && git -C "$WT" worktree add --detach "$SCRATCH/base" "$BASE_SHA"
     ln -s "$WT/node_modules" "$SCRATCH/base/node_modules"
     [ -f "$WT/.env.local" ] && cp "$WT/.env.local" "$SCRATCH/base/.env.local" || true
     drive() { # $1 checkout, $2 output file
       cd "$1"; V=.claude/skills/verify-notesd/scripts/verify.sh
       eval "$($V up --sessions | grep -E '^(RUN|URL|EVIDENCE)=')"
       S=""; for i in $(seq 60); do
         S=$(curl -sf "$URL/api/projects/mcp-notes/sessions" || true)
         n=$(jq '.nodes | length' <<<"$S" 2>/dev/null || true)
         [ "${n:-0}" -ge 3 ] && break; sleep 1; done
       SID=$(jq -r '[.nodes[].session_id] | sort | .[0]' <<<"$S")
       NODE=$(jq -r --arg s "$SID" '.nodes[] | select(.session_id==$s) | .node_id' <<<"$S")
       NID=$($V mcp "$RUN" create '{"body":"quokka zebra plan for the golden check #verify"}' | sed 1d | jq -r .note.id)
       $V mcp "$RUN" link_note "{\"note_id\":\"$NID\",\"node_id\":\"$NODE\"}" >/dev/null
       : > "$2"
       for q in fixture "fixture prompt" implement wall spend quokka "quokka zebra" "fixture or wall or quokka" "fixture -prompt" '"long session"' nothingmatchesthis; do
         enc=$(jq -rn --arg q "$q" '$q|@uri')
         curl -sf "$URL/api/sessions/search?q=$enc&limit=50" \
           | jq -c --arg q "$q" '{q:$q, mode, fallback, hits:[.hits[] | {session_id, score, via:[.via_notes[].excerpt]}]}' >> "$2"
         curl -sf "$URL/api/sessions/search?q=$enc&repo=mcp-notes&limit=2" \
           | jq -c --arg q "$q" '{q:$q, repo:"mcp-notes", hits:[.hits[] | .session_id]}' >> "$2"
       done
       $V mcp "$RUN" sessions_search '{"query":"quokka zebra"}' | sed 1d \
         | jq -c '{mcp:true, mode, hits:[.hits[] | {score, via:[.via_notes[].excerpt]}]}' >> "$2"
       $V note "$RUN" "searchSessions A/B: wrote $2 from $1"
       echo "EVIDENCE($1)=$EVIDENCE"
       $V down "$RUN"
     }
     drive "$SCRATCH/base" "$SCRATCH/base.jsonl"
     drive "$WT" "$SCRATCH/branch.jsonl"
     diff "$SCRATCH/base.jsonl" "$SCRATCH/branch.jsonl" && echo "A/B IDENTICAL"
     grep -c '"via":\["quokka zebra plan' "$SCRATCH/branch.jsonl"
     git -C "$WT" worktree remove --force "$SCRATCH/base"
     ```
     Passes when the script prints `A/B IDENTICAL`, the last `grep -c` prints a number >= 2 (the
     linked note reached `via_notes` over HTTP and MCP on the branch), every line has
     `"mode":"text"` and a non-null `fallback`, and `base.jsonl` is not empty. Session ids are fixed
     by the fixture transcripts, so both runs compare like for like; node and note ids differ per
     run and are deliberately not compared.
  2. **Golden snapshot unchanged.** `npm run test:int -- tests/integration/sessions.search.golden.int.test.ts`
     passes and `git -C /home/miftah/.worktrees/mcp-notes/session-search-context log --format=%H -1 -- tests/integration/__snapshots__/sessions.search.golden.int.test.ts.snap`
     names the Step 1 commit, which is an ancestor of the commit that changed `src/sessions/search.ts`
     (`git merge-base --is-ancestor <step1> <refactor>` exits 0). Hybrid, text, fallback, filters and
     paging are all in that snapshot.
  3. **Evidence kinds are recorded.** `npx vitest run tests/unit/sessions/searchMerge.test.ts` passes
     (9 tests), including "takes the best of own and note per signal and records which one gave it".
- Neighbor check: note search (`src/notes` hybrid search shares `src/search/blend.ts`, which this
  phase does not change): `npx vitest run tests/unit/search.blend.test.ts` and
  `npm run test:int -- tests/integration/search.hybrid.int.test.ts` pass. And the Projects chat /
  MCP mapping of hits: `npm run test:int -- tests/integration/sessions.mcp.int.test.ts tests/integration/sessions.api.int.test.ts` pass.
- Cost: none (no `--embed`, no chat, no summaries billed: the fixture daemon's summarizer may run
  only if a real `claude` binary is configured; prefix `up` with `NOTESD_CLAUDE_BIN=/nonexistent/claude`
  in `drive()` if the verifier wants zero spend).
**Exit criteria:** `tests/integration/sessions.search.int.test.ts` passes unchanged; the golden
snapshot written before the refactor passes unchanged after it; `searchMerge.test.ts` passes; the
A/B script prints `A/B IDENTICAL`; `src/sessions/search.ts` exposes `CandidateSource`,
`HYBRID_SOURCES`, `TEXT_SOURCES`, `mergeCandidates`, `collectCandidates`, `relatedSourceRows`,
`EvidenceKind`; no file outside the four in **Files** changed by this phase's commits (`git diff --stat "$STEP1^" HEAD`, `STEP1` as in journey 1; other phases may already be on the set branch).

## Handoffs

- **Phase 5 (R3, R4):** add `'reply'` to `EvidenceKind`; write `repliesSource` returning
  `relatedSourceRows('reply', rows)` with `items` = jsonb `[{ seq }]` best first (reconciled: no reply
  text in `items`; phase 5 fetches excerpts for the shown page with `ts_headline`) (text mode:
  `q.vector === null`, words only, no limit; hybrid: words limited by `q.textLimit` ∪ nearest
  `BLEND.vectorCandidates` reply vectors, exclusions applied to the vector half, `filterSql(q.filter)`
  on the joined session); append it to `HYBRID_SOURCES` and `TEXT_SOURCES`; add
  `via_replies` in `toHit` from `c.related.reply?.items` (plus a per-page excerpt map); apply the
  related-evidence weight from `c.row.*` (own) and `c.related.*` kept apart, in `searchSessions`'
  `rankCandidates` mapping and in text mode (phase 5's `withWeightedText`). If phase 5 wants a shared
  "items -> per session" SQL helper for notes and replies, it may generalize `sessionsOfNotesSql`;
  this phase deliberately did not (one caller).
- **Phase 5 (R4):** the golden snapshot in `tests/integration/__snapshots__/sessions.search.golden.int.test.ts.snap`
  WILL change when the related-evidence weight lands (scores of note-matched sessions). Phase 5
  regenerates it with `--update` in its own commit and says why; its seed has no reply rows, so
  any change there is the weight, nothing else.
- **Phase 2 (R1):** adding commit subjects to `search_tsv` can change text ranks in the golden
  snapshot only if a seeded session has commits; the seed inserts `cc_sessions` without `commits`
  (column default), and the appended `coalesce(... '$[*].subject')::text` on an empty array yields no
  lexemes and shifts no existing position, so `ts_rank` is unchanged. Reconciled: phase 2 never
  regenerates this snapshot; if the golden test fails after phase 2, that is a phase 2 bug.
- **Phase 3 (R2):** `tests/integration/setup.ts` `truncateAll` gains the reply tables; the golden
  test calls `truncateAll` and inserts no replies, so nothing to do here.
- Drive-by, not done: `sessions.search.int.test.ts` seeds relative to `now()`; harmless, left alone.

## Rollback

`git revert` the refactor commit (Step 2 + Step 3) to restore the inline `hybridCandidates` /
`textSearch`; the golden test from Step 1 keeps passing against the old code (it was generated
from it), so it can stay. To drop the whole phase, also revert the Step 1 commit. No schema, data
or config is touched.
