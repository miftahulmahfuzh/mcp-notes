/**
 * Opt-in live check of the embedding side of search: ONE real OpenRouter /embeddings call
 * (openai/text-embedding-3-small, 1536 dims) over phase 4's labelled set plus the two usage
 * examples. Run with `npm run test:live:embeddings` (EMBEDDINGS_LIVE_TEST=1, no Docker, no
 * database). Never part of `npm test`, `npm run test:int` or the other live suites. Billed, but a
 * few cents of a cent.
 *
 * It asserts what the fake embedder cannot: that each usage example from the brief "must come
 * back" with the real model. "arango root password is in the vault" for "ArangoDB credentials",
 * and "the login broke after the laptop slept" for "have we seen auth failures after resume
 * before?". Each target must clear BLEND.minSimilarity, sit in the top 5 by raw similarity and
 * appear on the default page (MCP_DEFAULT_LIMIT) of the hybrid ranking. The real vectors go
 * through src/search/blend.ts in memory, with text rank as simple word overlap. Rank 1 is not
 * required: a literal text hit outranks a meaning-only note by phase 4's invariant (R4, "ids and
 * code tokens still first"), so "arangodb" in another note puts that note above the vault one.
 * Coordinator decision 2026-10-30, rungs 1 and 4. When this fails, retune ONLY the numbers in
 * BLEND, then re-run `npm test`, `npm run test:int` and this file.
 *
 * Needs OPENROUTER_API_KEY in the environment or in .env.local (a worktree carries a symlink to
 * ~/mcp-notes/.env.local). The key is never printed.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';
import { beforeAll, describe, expect, it } from 'vitest';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from '../../src/embeddings/constants.js';
import { OPENROUTER_EMBED_MAX_BATCH, createOpenRouterEmbedder } from '../../src/embeddings/openrouter.js';
import { embedInput } from '../../src/embeddings/state.js';
import { MCP_DEFAULT_LIMIT } from '../../src/mcp/tools.js';
// ---- adapter: the only lines that depend on phase 4's export names ----
import { BLEND, rankCandidates, type BlendCandidate } from '../../src/search/blend.js';
import { LABELLED_NOTES, LABELLED_QUERIES } from '../fixtures/semantic/labelled.js';
// -----------------------------------------------------------------------

const ARANGO_NOTE = 'arango root password is in the vault';
const ARANGO_QUERY = 'ArangoDB credentials';
const LOGIN_NOTE = 'the login broke after the laptop slept';
const LOGIN_QUERY = 'have we seen auth failures after resume before?';

const NOW = new Date('2026-10-30T07:00:00Z');
const DAY_MS = 86_400_000;

interface LiveNote {
  key: string;
  body: string;
  ageDays: number;
  vector: number[];
}

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

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .filter((w) => w.length > 0),
  );
}

/** Stand-in for ts_rank: the share of query words found in the body; null when none (no FTS match). */
function textRank(query: string, body: string): number | null {
  const q = words(query);
  if (q.size === 0) return null;
  const b = words(body);
  let hits = 0;
  for (const w of q) if (b.has(w)) hits += 1;
  return hits === 0 ? null : hits / q.size;
}

function nearest(queryVector: readonly number[], notes: readonly LiveNote[]): Array<{ note: LiveNote; similarity: number }> {
  return notes
    .map((note) => ({ note, similarity: cosine(queryVector, note.vector) }))
    .sort((x, y) => y.similarity - x.similarity);
}

function blendRanking(query: string, queryVector: readonly number[], notes: readonly LiveNote[]): string[] {
  const candidates: BlendCandidate[] = notes.map((note) => ({
    id: note.key,
    textRank: textRank(query, note.body),
    similarity: cosine(queryVector, note.vector),
    tagMatch: 0,
    updatedAt: new Date(NOW.getTime() - note.ageDays * DAY_MS),
  }));
  return rankCandidates(candidates, { now: NOW }).map((r) => r.id);
}

function noteContaining(notes: readonly LiveNote[], text: string): LiveNote {
  const found = notes.find((n) => n.body.includes(text));
  if (!found) throw new Error(`labelled set has no note containing "${text}"`);
  return found;
}

let notes: LiveNote[] = [];
let queryVectors = new Map<string, number[]>();
let allVectors: number[][] = [];
let fetchCalls = 0;

beforeAll(async () => {
  const countingFetch: typeof fetch = (input, init) => {
    fetchCalls += 1;
    return fetch(input, init);
  };
  const embedder = createOpenRouterEmbedder({ apiKey: apiKey(), fetch: countingFetch, timeoutMs: 30_000 });

  const noteInputs = LABELLED_NOTES.map((n) => {
    const input = embedInput(n.body);
    if (input === null) throw new Error(`labelled note ${n.key} has an empty body`);
    return input;
  });
  const queryTexts = [...new Set([ARANGO_QUERY, LOGIN_QUERY, ...LABELLED_QUERIES.map((q) => q.query)])];
  const queryInputs = queryTexts.map((q) => embedInput(q) ?? q);

  allVectors = await embedder.embed([...noteInputs, ...queryInputs], { timeoutMs: 30_000 });

  notes = LABELLED_NOTES.map((n, i) => ({
    key: n.key,
    body: n.body,
    ageDays: n.ageDays ?? 0,
    vector: allVectors[i] ?? [],
  }));
  queryVectors = new Map(queryTexts.map((q, i) => [q, allVectors[noteInputs.length + i] ?? []]));
});

describe(`live embeddings (${EMBEDDING_MODEL})`, () => {
  it('makes one request and returns one finite 1536-dim vector per input', () => {
    // One request only while every input fits one OpenRouter batch (phase 2 splits at 64).
    expect(allVectors.length).toBeLessThanOrEqual(OPENROUTER_EMBED_MAX_BATCH);
    expect(fetchCalls).toBe(1);
    expect(allVectors.length).toBe(notes.length + queryVectors.size);
    for (const v of allVectors) {
      expect(v.length).toBe(EMBEDDING_DIMENSIONS);
      expect(v.every((x) => Number.isFinite(x))).toBe(true);
    }
  });

  it.each([
    [ARANGO_QUERY, ARANGO_NOTE],
    [LOGIN_QUERY, LOGIN_NOTE],
  ])('brings "%s" back: "%s"', (query, body) => {
    const target = noteContaining(notes, body);
    const queryVector = queryVectors.get(query) ?? [];
    const ranked = nearest(queryVector, notes);
    const rawRank = ranked.findIndex((r) => r.note.key === target.key) + 1;
    const similarity = cosine(queryVector, target.vector);
    // A query vector exists, so this is the ranking search returns in mode 'hybrid'.
    const page = blendRanking(query, queryVector, notes).slice(0, MCP_DEFAULT_LIMIT);
    const blendRank = page.indexOf(target.key) + 1;
    console.info(
      `[live] ${query}: ${target.key} raw rank ${rawRank}, blend rank ${blendRank || 'absent'}, ` +
        `similarity ${similarity.toFixed(3)}; top 3 ` +
        ranked.slice(0, 3).map((r) => `${r.note.key}=${r.similarity.toFixed(3)}`).join(', '),
    );
    expect(similarity).toBeGreaterThanOrEqual(BLEND.minSimilarity);
    expect(rawRank).toBeGreaterThanOrEqual(1);
    expect(rawRank).toBeLessThanOrEqual(5);
    expect(blendRank, `on the hybrid page (BLEND=${JSON.stringify(BLEND)})`).toBeGreaterThanOrEqual(1);
  });

  it('BLEND.minSimilarity keeps every relevant note that shares no word with its query', () => {
    const dropped: string[] = [];
    const rows: Array<{ query: string; firstRelevant: number | null; mrr: number }> = [];
    let mrrSum = 0;
    for (const q of LABELLED_QUERIES) {
      const qv = queryVectors.get(q.query) ?? [];
      for (const key of q.relevant) {
        const note = notes.find((n) => n.key === key);
        if (!note) throw new Error(`labelled query "${q.query}" names unknown note ${key}`);
        const sim = cosine(qv, note.vector);
        if (textRank(q.query, note.body) === null && sim < BLEND.minSimilarity) {
          dropped.push(`${key} for "${q.query}" (similarity ${sim.toFixed(3)} < ${BLEND.minSimilarity})`);
        }
      }
      const ranking = blendRanking(q.query, qv, notes);
      const positions = q.relevant.map((k) => ranking.indexOf(k)).filter((i) => i >= 0);
      const first = positions.length > 0 ? Math.min(...positions) + 1 : null;
      const rr = first === null ? 0 : 1 / first;
      mrrSum += rr;
      rows.push({ query: q.query, firstRelevant: first, mrr: Number(rr.toFixed(3)) });
    }
    const mrr = LABELLED_QUERIES.length === 0 ? 0 : mrrSum / LABELLED_QUERIES.length;
    console.table(rows);
    console.info(`[live] blend MRR over ${LABELLED_QUERIES.length} labelled queries: ${mrr.toFixed(3)}`);
    expect(dropped, dropped.join('\n')).toEqual([]);
  });
});
