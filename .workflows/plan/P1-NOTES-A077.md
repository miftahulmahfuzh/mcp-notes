> Adopted from `.workflows/orchestration/dword-connector/PLAN.md` phase 4. Source: `.workflows/plan/dword-connector/phase-4.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 4: Journal tools

**Plan set:** `DWORD_CONNECTOR_PLAN.md`
**Analysis:** `.workflows/analyze/20261106-070115-DW6C_code_analyzer.md`
**Satisfies:** R1, R2, R5 — the `/j` journal lookup-or-add capability (Claude Code side; skill text is Phase 5)
**Depends on:** Phase 1 (connector plumbing), Phase 2 (writer and rules) — both assumed landed
**Difficulty:** HARD
**Package:** `src/mcp`, `src/dword`, `tests/integration/connectors`

---

## Goal

After this phase, two new curated MCP tools exist — `dword_journal_find_similar` and
`dword_journal_add` — that let Claude look up or add a `journal_entries` row in dword's
database, mirroring dword's own two-layer duplicate check (`norm_sha` exact match, then an
OpenRouter embedding at the same `0.25` cosine-distance threshold dword uses) and D3 (a
duplicate blocks the insert unless `force: true`). A failed or unavailable embedding call never
blocks a save — it degrades to "no Layer 2 verdict," exactly like dword's own rule. Both tools
are directly testable (and tested) against a throwaway Postgres rebuilt from dword's own
migrations, with no dependency on Phase 3's file.

## Before you start: the two cross-phase risks this plan cannot resolve alone

These are flagged in detail under **Interface Contract → Requires** and **Assumptions**, but
stated up front because they are load-bearing for every step below:

1. **[Reconciled] User resolution.** `registerDwordCurated(server, connectors.dword)` — the call
   signature the plan index's own Decisions table fixes — passes only a `Connector`, no
   `Config`/`ToolDeps`. The original draft of this plan assumed `resolveDwordUserId` would
   therefore have to be self-sufficient (reading `DWORD_USER_EMAIL` internally, with a bare
   `(connector)` signature) exported from `src/connectors/dword/index.ts`. Phase 1's actual
   resolver takes the email as an explicit second argument —
   `resolveDwordUserId(connector: Connector, email: string | null): Promise<string>`, exported from
   `src/connectors/dword/user.ts` — matching Phase 3's own (also corrected) usage. This phase now
   does exactly what Phase 3 does: reads `DWORD_USER_EMAIL` itself via a small `emailOf` thunk
   (`options.userEmail ?? (() => loadConfig().dword.userEmail)`, injectable for tests) and passes
   its result as `resolveDwordUserId`'s second argument. `registerDwordJournalCurated(server,
   connector, options?)`'s two-argument production call shape is unaffected — the thunk lives
   inside the function body, not in its parameter list. See the plan index's Reconciliation Log.
2. **The one shared `registerDwordCurated` call.** The plan index's own Decisions table and
   Phase 4's "Also owns" text both anticipate that Phase 3 and Phase 4 touch the same three
   spots — `src/connectors/names.ts`'s `CONNECTOR_TOOL_NAMES.dword` array, `src/connectors/
   register.ts`'s one curated-registration line, and (by this phase's own choice, see below) a
   new barrel file. This is a **known, explicitly-sanctioned conflict**, not a mistake either
   planner made — the Reconciliation Log exists for exactly this. This phase's own tools, and its
   own test file, do **not** depend on that barrel or on Phase 3's file (see Verification); the
   barrel/register.ts/names.ts edits are the one piece of this plan that cannot build until
   Phase 3's `dwordVocabTools.ts` also exists.

## Interface Contract

**Creates:**
- `src/dword/journalSimilarity.ts` — `normalizeForCompare`, `sha256Hex`, `normShaFor`,
  `textShaFor` (ported byte-for-byte from `~/daily-words/src/lib/journal/similarity.ts`'s Layer 1
  logic), plus `NEAR_DUPLICATE_MAX_DISTANCE` (the same source file's Layer 2 threshold —
  **[Reconciled]**: lives here, not in `src/dword/rules.ts`; see Interface Contract → Requires).
- `src/mcp/dwordJournalTools.ts` — `registerDwordJournalCurated(server, connector, options?)`,
  `findSimilarJournalEntries(connector, userId, text, embedder)`, `defaultJournalEmbedder()`,
  types `JournalMatchEntry`, `JournalDuplicateResult`, `DwordJournalOptions`.
- `src/mcp/dwordTools.ts` — `registerDwordCurated(server, connector)` (barrel; see risk #2 above).
- `tests/unit/dword/journalSimilarity.test.ts`, `tests/integration/connectors/
  dword.journal.curated.int.test.ts`.

**Modifies (shared with Phase 3 — see risk #2):**
- `src/connectors/names.ts`: appends `'dword_journal_find_similar'`, `'dword_journal_add'` to
  `CONNECTOR_TOOL_NAMES.dword`.
- `src/connectors/register.ts`: adds `import { registerDwordCurated } from '../mcp/dwordTools.js';`
  and one `registerDwordCurated(server, connectors.dword);` line inside `registerConnectorTools`.

**Requires (from Phase 1, actual — see reconciled risk #1 above):**
- `src/connectors/names.ts` already has `'dword'` in `CONNECTOR_SYSTEMS` and
  `CONNECTOR_TOOL_NAMES.dword` starting with `['dword_schema', 'dword_sql', ...]` (phase 3's two
  curated names appended ahead of this phase's — see Step 6).
- `src/connectors/dword/index.ts` exports `createDwordConnector(): Connector`.
- `src/connectors/dword/user.ts` exports
  **`resolveDwordUserId(connector: Connector, email: string | null): Promise<string>`** — resolves
  the given email (read by the caller, not by this function) against the given connector, querying
  `SELECT id FROM users WHERE email = $1`, and throws `ConnectorError` (from
  `src/connectors/types.js`) with a clear, refusal-shaped message when `email` is null/blank or
  matches no row. This phase calls it the same way Phase 3 does (own `emailOf` thunk, see Step 3).
- `tests/integration/connectors/{harness,siblings}.ts` already accept `'dword'` as a `SystemId`
  (`truncateSystem`, `seedSystem`, `connectorFor`, `describeWithRepo` all work for it with no
  changes, per the analysis's own finding that dword's migrations match the drizzle-journal
  layout those functions already handle).

**Requires (from Phase 2, actual):**
- **[Reconciled]** `src/dword/rules.ts` exports, each commented with its dword source file:
  `JOURNAL_TEXT_MIN = 2`, `JOURNAL_TEXT_MAX = 1000`, `JOURNAL_SOURCE_NOTE_MAX = 200`
  (`~/daily-words/src/lib/journal/limits.ts` — these three were missing from Phase 2's original
  draft, which never enumerated `limits.ts` at all; added to Phase 2 during reconciliation, see the
  plan index's Reconciliation Log); `INSIGHT_MEANING_MIN_CHARS = 20`,
  `INSIGHT_MEANING_MAX_CHARS = 220`, `INSIGHT_WHEN_IT_APPLIES_MIN_ITEMS = 2`,
  `INSIGHT_WHEN_IT_APPLIES_MAX_ITEMS = 3`, `INSIGHT_WHEN_IT_APPLIES_ITEM_MIN_CHARS = 8`,
  `INSIGHT_WHEN_IT_APPLIES_ITEM_MAX_CHARS = 120` (`~/daily-words/src/lib/journal/schemas.ts`'s
  `insightSchema` — this phase's original draft used shorter names, e.g. `INSIGHT_MEANING_MIN`;
  Phase 2's actual names are longer and now used throughout this phase's code). **`NEAR_DUPLICATE_MAX_DISTANCE`
  is NOT one of Phase 2's exports** — Phase 2 never defined it (it was out of its enumerated list of
  limits to mirror). It is defined in this phase's own `src/dword/journalSimilarity.ts` instead
  (Step 1), alongside the other constants/functions ported from the same dword source file
  (`~/daily-words/src/lib/journal/similarity.ts`) — see the plan index's Reconciliation Log and
  Decisions table for why.
- `src/dword/writer.ts` exports a `DwordWriter` class constructed as
  `new DwordWriter({ repoDir: () => string, userEmail: () => string | undefined, timeoutMs?:
  number })` — **`userEmail` is a required constructor field**, not optional (the writer resolves
  the dword user id itself, fresh, against its own connection, on every write). Its methods this
  phase calls and does not reimplement — **[Reconciled]: neither input type carries a `userId`
  field** (the writer resolves it internally; passing one would be an excess-property error against
  Phase 2's actual types):
  ```ts
  interface NewJournalEntry {
    text: string;
    sourceNote: string | null;
    insight: { meaning: string; whenItApplies: readonly string[] };
  }
  interface JournalEntryRow {
    id: string;
    text: string;
    sourceNote: string | null;
    insight: { meaning: string; whenItApplies: string[] } | null;
    insightStatus: string; // 'ready'
    createdAt: string;     // ISO 8601 UTC
    updatedAt: string;     // ISO 8601 UTC
  }
  interface NewJournalEmbedding {
    entryId: string;
    textSha: string;
    normSha: string;
    model: string;
    embedding: readonly number[];
  }
  class DwordWriter {
    insertJournalEntry(row: NewJournalEntry): Promise<JournalEntryRow>;
    insertJournalEmbedding(row: NewJournalEmbedding): Promise<void>;
  }
  ```
  `insertJournalEntry` issues exactly `INSERT INTO journal_entries (user_id, text, source_note,
  insight, insight_status) VALUES ($1, $2, $3, $4::jsonb, 'ready') RETURNING id, text, source_note,
  insight, insight_status, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  AS created_at, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS
  updated_at`; `insertJournalEmbedding` issues exactly `INSERT INTO journal_entry_embeddings
  (entry_id, user_id, status, text_sha, norm_sha, model, embedding) VALUES ($1, $2, 'ready', $3, $4,
  $5, $6::vector)`, where `user_id` comes from the writer's own internally-resolved id, not from the
  input.

**Leaves alone (owned by others):** `src/dword/writer.ts` / `rules.ts` internals (Phase 2),
`src/mcp/dwordVocabTools.ts` (Phase 3's own file), `claude/skills/v`, `claude/skills/j`, any
`verify-notesd` feature-map file (Phase 5), `src/chat/*` (Phase 6).

## Files

| File | Action | What changes |
|---|---|---|
| `src/dword/journalSimilarity.ts` | create | Ported `normalizeForCompare`, `sha256Hex`, `normShaFor`, `textShaFor` |
| `tests/unit/dword/journalSimilarity.test.ts` | create | Fixture-pinned test of the port |
| `src/mcp/dwordJournalTools.ts` | create | `registerDwordJournalCurated`, dedup logic, embedder resolution |
| `src/mcp/dwordTools.ts` | create | `registerDwordCurated` barrel (shared w/ Phase 3, see risk #2) |
| `src/connectors/register.ts` | modify | import + one call line (shared w/ Phase 3) |
| `src/connectors/names.ts` | modify | append 2 tool names to `CONNECTOR_TOOL_NAMES.dword` (shared w/ Phase 3) |
| `tests/integration/connectors/dword.journal.curated.int.test.ts` | create | The six required journeys |

## Implementation Steps

### Step 1: Port `normalizeForCompare` exactly

**File:** `src/dword/journalSimilarity.ts` (new)
**Change:** Byte-for-byte port of dword's Layer 1 logic from
`~/daily-words/src/lib/journal/similarity.ts` (read 2026-11-06). Not imported — D1 forbids
importing dword code (it has no `server-only` tag here, but dword's own package boundary and
`@/` alias make it unimportable from mcp-notes regardless).

**Code:**
```ts
import { createHash } from 'node:crypto';

/**
 * Ported, not imported (D1), from ~/daily-words/src/lib/journal/similarity.ts. Keep this file
 * byte-for-byte in sync with that source's GLYPH_FOLDS / EDGE_NOISE regexes and the
 * NFKD-strip-marks-collapse-whitespace-trim-lowercase pipeline: the sha256 hex this produces
 * must equal what dword's own app would compute and already stores in `norm_sha`, or Layer 1
 * (the free, no-network duplicate check) silently stops working for any entry dword itself wrote.
 */
const GLYPH_FOLDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[‘’‚‛′´`]/gu, "'"],
  [/[“”„‟″«»]/gu, '"'],
  [/[‐‑‒–—―−]/gu, '-'],
  [/…/gu, '...'],
];

const EDGE_NOISE_LEADING = /^[\p{P}\p{S}\s]+/u;
const EDGE_NOISE_TRAILING = /[\p{P}\p{S}\s]+$/u;

/** Layer 1's fold: two copies of the same line normalize to the same string. */
export function normalizeForCompare(raw: string): string {
  let out = raw;
  for (const [pattern, replacement] of GLYPH_FOLDS) out = out.replace(pattern, replacement);

  return out
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(EDGE_NOISE_LEADING, '')
    .replace(EDGE_NOISE_TRAILING, '')
    .toLowerCase();
}

/** Lowercase hex, matching Postgres `encode(sha256(...), 'hex')`. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Layer 1's stored key: journal_entry_embeddings.norm_sha. */
export function normShaFor(text: string): string {
  return sha256Hex(normalizeForCompare(text));
}

/** journal_entry_embeddings.text_sha: sha256 of the exact (unnormalized) text. */
export function textShaFor(text: string): string {
  return sha256Hex(text);
}

/**
 * dword `src/lib/journal/similarity.ts:176` (`NEAR_DUPLICATE_MAX_DISTANCE`). Cosine distance below
 * which two journal lines are treated as the same saying — a dedup-algorithm threshold, not a
 * form-validation ceiling, which is why it lives alongside this file's other similarity.ts port
 * rather than in src/dword/rules.ts (see DWORD_CONNECTOR_PLAN.md's Reconciliation Log). Measured,
 * not guessed — dword's own comment on this constant documents the corpus run that produced it;
 * re-run that measurement before ever changing this number, never edit the digit directly.
 */
export const NEAR_DUPLICATE_MAX_DISTANCE = 0.25;
```

**Impact:** No callers yet; Step 3 imports it.

### Step 2: Pin the port with fixtures

**File:** `tests/unit/dword/journalSimilarity.test.ts` (new)
**Change:** Fixture values computed directly from this exact ported logic (run during planning,
2026-11-06, with Node's `node:crypto` — reproducible by anyone re-running the same function).
Proves the whitespace/smart-quote/diacritic folding this phase relies on for Layer 1, and
freezes the hashes so a future edit to the port is caught.

**Code:**
```ts
import { describe, expect, it } from 'vitest';
import { normalizeForCompare, normShaFor, sha256Hex, textShaFor } from '../../../src/dword/journalSimilarity.js';

describe('journalSimilarity (ported from daily-words)', () => {
  it('folds whitespace and punctuation the same way as a re-paste', () => {
    expect(normalizeForCompare('Nothing to be done.')).toBe('nothing to be done');
    expect(normalizeForCompare('  Nothing   to be\ndone. ')).toBe('nothing to be done');
  });

  it('folds smart quotes to ASCII', () => {
    expect(normalizeForCompare('one’s')).toBe("one's");
    expect(normalizeForCompare("one's")).toBe("one's");
  });

  it('folds diacritics via NFKD', () => {
    expect(normalizeForCompare('Naïve.')).toBe('naive');
    expect(normalizeForCompare('Naive')).toBe('naive');
  });

  it('leaves an ordinary sentence with interior punctuation alone', () => {
    const s = "most things in life don't go according to one's wishes";
    expect(normalizeForCompare(s)).toBe(s);
  });

  it('normShaFor is pinned to a known hash (computed from this exact port, 2026-11-06)', () => {
    expect(normShaFor('Nothing to be done.')).toBe(
      'bf1af3710cdb483d1bd8c91a2ce96b694d1e21aec1f127dd84905998ea36f844',
    );
    expect(normShaFor('  Nothing   to be\ndone. ')).toBe(
      'bf1af3710cdb483d1bd8c91a2ce96b694d1e21aec1f127dd84905998ea36f844',
    );
    expect(normShaFor('one’s')).toBe(
      '7ea7241388353df98bdc17b8d3e411a6ff230ee886aad294a8f5169365995e09',
    );
  });

  it('textShaFor hashes the exact text, unnormalized (two near-identical lines differ)', () => {
    expect(textShaFor('Nothing to be done.')).not.toBe(textShaFor('Nothing to be done!'));
    expect(textShaFor('same')).toBe(sha256Hex('same'));
  });
});
```

**Impact:** None (test-only). Run `npx vitest run tests/unit/dword/journalSimilarity.test.ts`
before moving on.

### Step 3: The journal tools

**File:** `src/mcp/dwordJournalTools.ts` (new)
**Change:** The two curated tools, the shared duplicate-check function, and the
self-sufficient embedder resolver (see risk #1's sibling problem for the embedder: this
function receives only a `Connector`, so it cannot reuse `AppDeps.embedder` either — it builds
its own, confirmed comparable to dword's stored vectors by the analysis's live measurement:
cosine distance 0.000000 on identical text via OpenRouter's `openai/text-embedding-3-small`).

**Code:**
```ts
import { existsSync, readFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { parse as parseDotenv } from 'dotenv';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { resolveDwordUserId } from '../connectors/dword/user.js';
import { CONNECTOR_SETTINGS_FILE, connectorSettings, resolveRepoDir } from '../connectors/env.js';
import { toObjects } from '../connectors/rows.js';
import type { Connector } from '../connectors/types.js';
import {
  INSIGHT_MEANING_MAX_CHARS,
  INSIGHT_MEANING_MIN_CHARS,
  INSIGHT_WHEN_IT_APPLIES_ITEM_MAX_CHARS,
  INSIGHT_WHEN_IT_APPLIES_ITEM_MIN_CHARS,
  INSIGHT_WHEN_IT_APPLIES_MAX_ITEMS,
  INSIGHT_WHEN_IT_APPLIES_MIN_ITEMS,
  JOURNAL_SOURCE_NOTE_MAX,
  JOURNAL_TEXT_MAX,
  JOURNAL_TEXT_MIN,
} from '../dword/rules.js';
import { DwordWriter } from '../dword/writer.js';
import { NEAR_DUPLICATE_MAX_DISTANCE, normShaFor, textShaFor } from '../dword/journalSimilarity.js';
import { toVectorLiteral } from '../embeddings/repo.js';
import type { Embedder } from '../embeddings/embedder.js';
import { createOpenRouterEmbedder } from '../embeddings/openrouter.js';
import { run } from './tools.js';

const FIND_SIMILAR = 'dword_journal_find_similar';
const ADD = 'dword_journal_add';

/* ------------------------------------------------------------- shapes ------------------------------------------------------------- */

export interface JournalInsight {
  meaning: string;
  whenItApplies: string[];
}

export interface JournalMatchEntry {
  id: string;
  text: string;
  source_note: string | null;
  insight: JournalInsight | null;
  insight_status: string;
  created_at: string;
}

interface JournalSiblingFacts {
  textSha: string;
  normSha: string;
  status: 'ready' | 'failed';
  model?: string;
  embedding?: number[];
}

export interface JournalDuplicateResult {
  verdict: 'duplicate' | 'none';
  entries: JournalMatchEntry[];
  layer2Skipped?: true;
  sibling: JournalSiblingFacts;
}

type Row = Record<string, unknown>;

function toMatchEntry(row: Row): JournalMatchEntry {
  return {
    id: String(row.id),
    text: String(row.text),
    source_note: row.source_note === null || row.source_note === undefined ? null : String(row.source_note),
    insight: (row.insight as JournalInsight | null) ?? null,
    insight_status: String(row.insight_status),
    created_at: String(row.created_at),
  };
}

/* --------------------------------------------------------------- SQL -------------------------------------------------------------- */

const MATCH_COLUMNS = `je.id, je.text, je.source_note, je.insight, je.insight_status,
  to_char(je.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at`;

/** Layer 1: exact norm_sha match. No status filter — mirrors dword's own findByNormSha. */
const LAYER1_SQL = `
SELECT ${MATCH_COLUMNS}
FROM journal_entry_embeddings jee
JOIN journal_entries je ON je.id = jee.entry_id
WHERE jee.user_id = $1
  AND jee.norm_sha = $2
  AND jee.text_sha = encode(sha256(je.text::bytea), 'hex')
ORDER BY je.created_at DESC
LIMIT 1`;

/** Layer 2: nearest ready, non-stale vector. Mirrors dword's own findNearest (limit 1: this phase shows only the top match). */
const LAYER2_SQL = `
SELECT ${MATCH_COLUMNS}, (jee.embedding <=> $2::vector) AS distance
FROM journal_entry_embeddings jee
JOIN journal_entries je ON je.id = jee.entry_id
WHERE jee.user_id = $1
  AND jee.status = 'ready'
  AND jee.embedding IS NOT NULL
  AND jee.text_sha = encode(sha256(je.text::bytea), 'hex')
ORDER BY jee.embedding <=> $2::vector
LIMIT 1`;

async function findByNormSha(connector: Connector, userId: string, normSha: string): Promise<JournalMatchEntry | null> {
  const result = await connector.query(LAYER1_SQL, [userId, normSha], { maxRows: 1 });
  const [row] = toObjects(result);
  return row ? toMatchEntry(row) : null;
}

async function findNearestJournalEntry(
  connector: Connector,
  userId: string,
  vector: number[],
): Promise<(JournalMatchEntry & { distance: number }) | null> {
  const result = await connector.query(LAYER2_SQL, [userId, toVectorLiteral(vector)], { maxRows: 1 });
  const [row] = toObjects(result);
  if (!row) return null;
  return { ...toMatchEntry(row), distance: Number(row.distance) };
}

/* ------------------------------------------------------ the shared dedup check ------------------------------------------------------ */

/**
 * The one duplicate check, called by both tools below (the brief's "call it, don't reimplement").
 * Always returns `sibling`: when Layer 2 ran and the result was 'none', the vector it computed is
 * reused by dword_journal_add for journal_entry_embeddings instead of embedding the text twice —
 * "the vector has been paid for", exactly as dword's own route comments it.
 *
 * Deliberately does NOT special-case `force` by skipping the check (dword's own route does skip
 * it entirely on a forced save, and therefore never embeds a forced save at all). This phase's
 * brief asks for the check to always run, so a forced save still gets a computed embedding
 * whenever Layer 1 missed — strictly better coverage than dword's own behavior, and the ONE
 * place this port deliberately differs from dword's code path rather than its data shape.
 */
export async function findSimilarJournalEntries(
  connector: Connector,
  userId: string,
  text: string,
  embedder: Embedder | null,
): Promise<JournalDuplicateResult> {
  const textSha = textShaFor(text);
  const normSha = normShaFor(text);
  const unembedded: JournalSiblingFacts = { textSha, normSha, status: 'failed' };

  const layer1 = await findByNormSha(connector, userId, normSha);
  if (layer1 !== null) {
    return { verdict: 'duplicate', entries: [layer1], sibling: unembedded };
  }

  if (embedder === null) {
    return { verdict: 'none', entries: [], layer2Skipped: true, sibling: unembedded };
  }

  let vector: number[];
  try {
    const vectors = await embedder.embed([text]);
    const first = vectors[0];
    if (first === undefined) throw new Error('embedder returned no vector');
    vector = first;
  } catch {
    // Provider down, unconfigured, timed out: never block the save (dword's own Product Principle 5).
    return { verdict: 'none', entries: [], layer2Skipped: true, sibling: unembedded };
  }

  const sibling: JournalSiblingFacts = { textSha, normSha, status: 'ready', model: embedder.model, embedding: vector };
  const nearest = await findNearestJournalEntry(connector, userId, vector);
  // Strict '<', mirroring dword's own isNearDuplicate ("distance < T warns, distance === T does
  // not" — ~/daily-words/src/lib/journal/similarity.ts). "Mirror, do not invent" wins here even
  // though this phase's own brief said "<=": a boundary-exact distance is a real measured edge
  // case in dword's own corpus notes, not a rounding nicety, so dword's own code is the fact.
  if (nearest !== null && nearest.distance < NEAR_DUPLICATE_MAX_DISTANCE) {
    const { distance: _distance, ...entry } = nearest;
    return { verdict: 'duplicate', entries: [entry], sibling };
  }
  return { verdict: 'none', entries: [], sibling };
}

/* ---------------------------------------------------------- the embedder ---------------------------------------------------------- */

/**
 * registerDwordCurated(server, connectors.dword) passes only a Connector — no AppDeps, no
 * Config — so this cannot reuse the daemon's shared `deps.embedder`. It reads mcp-notes' own
 * OPENROUTER_API_KEY itself, the same real-env-over-.env.local precedence connectorSettings()
 * already uses for sibling repo settings. Cheap: construction touches no network.
 */
function resolveOpenRouterApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (!existsSync(CONNECTOR_SETTINGS_FILE)) return null;
  try {
    const fromFile = parseDotenv(readFileSync(CONNECTOR_SETTINGS_FILE)).OPENROUTER_API_KEY?.trim();
    return fromFile ? fromFile : null;
  } catch {
    return null;
  }
}

/** null means "no OPENROUTER_API_KEY configured" — Layer 2 is reported skipped, never an error. */
export function defaultJournalEmbedder(): Embedder | null {
  const apiKey = resolveOpenRouterApiKey();
  return apiKey === null ? null : createOpenRouterEmbedder({ apiKey });
}

/* ------------------------------------------------------------ zod fields ------------------------------------------------------------ */

const textField = z
  .string()
  .trim()
  .min(JOURNAL_TEXT_MIN)
  .max(JOURNAL_TEXT_MAX)
  .describe(`The journal line (the saying), ${JOURNAL_TEXT_MIN}-${JOURNAL_TEXT_MAX} characters.`);

const sourceNoteField = z
  .string()
  .trim()
  .max(JOURNAL_SOURCE_NOTE_MAX)
  .optional()
  .describe(`Where it came from, e.g. a book title. At most ${JOURNAL_SOURCE_NOTE_MAX} characters. Omit if unknown.`);

const insightField = z
  .object({
    meaning: z
      .string()
      .trim()
      .min(INSIGHT_MEANING_MIN_CHARS)
      .max(INSIGHT_MEANING_MAX_CHARS)
      .describe(`The saying's meaning, ${INSIGHT_MEANING_MIN_CHARS}-${INSIGHT_MEANING_MAX_CHARS} characters, dictionary register, no advice, no praise.`),
    whenItApplies: z
      .array(z.string().trim().min(INSIGHT_WHEN_IT_APPLIES_ITEM_MIN_CHARS).max(INSIGHT_WHEN_IT_APPLIES_ITEM_MAX_CHARS))
      .min(INSIGHT_WHEN_IT_APPLIES_MIN_ITEMS)
      .max(INSIGHT_WHEN_IT_APPLIES_MAX_ITEMS)
      .describe(`${INSIGHT_WHEN_IT_APPLIES_MIN_ITEMS}-${INSIGHT_WHEN_IT_APPLIES_MAX_ITEMS} concrete everyday situations it applies to, each ${INSIGHT_WHEN_IT_APPLIES_ITEM_MIN_CHARS}-${INSIGHT_WHEN_IT_APPLIES_ITEM_MAX_CHARS} characters.`),
  })
  .describe("Claude's own explanation (D2: dword's GLM prompts are not called).");

const FIND_SIMILAR_DESCRIPTION =
  "Checks whether the owner's daily-words journal already has this saying or something close to it. Layer 1: an exact match after " +
  "normalizing whitespace, smart quotes and accents (a re-paste of the same line). Layer 2, only on a Layer 1 miss: cosine distance " +
  `of a fresh embedding against the owner's own entries, verdict 'duplicate' when distance < ${NEAR_DUPLICATE_MAX_DISTANCE}. A failed ` +
  "or unavailable embedding call never errors - it reports layer2_skipped: true and verdict 'none', since Layer 1 already ran and a " +
  "provider outage must never block a save (dword's own rule). Returns { verdict: 'duplicate' | 'none', entries, layer2_skipped? }; " +
  'entries holds the matching line(s) with their stored insight. Call this before dword_journal_add to decide what to tell the user; ' +
  'dword_journal_add runs the identical check itself, so this tool is for showing the user what would happen, not a required first call.';

const ADD_DESCRIPTION =
  'Adds a journal entry to daily-words, after running the same duplicate check as dword_journal_find_similar. If a duplicate is found ' +
  "and force is not true, nothing is inserted and the match is returned (D3 - 'show it, insert nothing unless the user says save " +
  "anyway'). Otherwise inserts with insight_status='ready' and, when an embedding was computed during the check, a " +
  'journal_entry_embeddings row too - a failed or unavailable embedding never blocks the entry insert; it is simply skipped and ' +
  "dword's own backfill picks it up later. insight is written by Claude (D2): meaning plus 2-3 concrete everyday situations, English, " +
  'dictionary register, no advice, no praise. Returns { verdict, inserted, entries, entry?, embedded, layer2_skipped? }.';

/* ---------------------------------------------------------- registration ---------------------------------------------------------- */

export interface DwordJournalOptions {
  /** Default: defaultJournalEmbedder(). Pass null to force Layer 2 off; tests inject a FakeEmbedder, including one set to fail. */
  embedder?: Embedder | null;
  /** Default: a DwordWriter pointed at DAILY_WORDS_DIR, resolved fresh. Tests inject one pointed at the throwaway Postgres. */
  writer?: DwordWriter;
  /** DWORD_USER_EMAIL override (tests). Default: loadConfig().dword.userEmail, read fresh per call — same pattern as src/mcp/dwordVocabTools.ts. */
  userEmail?: () => string | null;
}

export function registerDwordJournalCurated(server: McpServer, connector: Connector, options: DwordJournalOptions = {}): void {
  const embedder = options.embedder === undefined ? defaultJournalEmbedder() : options.embedder;
  const emailOf = options.userEmail ?? ((): string | null => loadConfig().dword.userEmail);
  const writer =
    options.writer ??
    new DwordWriter({ repoDir: () => resolveRepoDir('dword', connectorSettings()), userEmail: () => emailOf() ?? undefined });

  server.registerTool(
    FIND_SIMILAR,
    {
      title: 'Find a similar daily-words journal entry',
      description: FIND_SIMILAR_DESCRIPTION,
      inputSchema: { text: textField },
      annotations: { readOnlyHint: true },
    },
    async ({ text }) =>
      run(async () => {
        const userId = await resolveDwordUserId(connector, emailOf());
        const result = await findSimilarJournalEntries(connector, userId, text, embedder);
        return {
          verdict: result.verdict,
          entries: result.entries,
          ...(result.layer2Skipped ? { layer2_skipped: true as const } : {}),
        };
      }, { compact: true }),
  );

  server.registerTool(
    ADD,
    {
      title: 'Add a daily-words journal entry',
      description: ADD_DESCRIPTION,
      inputSchema: {
        text: textField,
        source_note: sourceNoteField,
        insight: insightField,
        force: z.boolean().optional().describe('Insert even though a duplicate was found. Default false.'),
      },
    },
    async ({ text, source_note, insight, force }) =>
      run(async () => {
        const userId = await resolveDwordUserId(connector, emailOf());
        const check = await findSimilarJournalEntries(connector, userId, text, embedder);

        if (check.verdict === 'duplicate' && force !== true) {
          return {
            verdict: 'duplicate' as const,
            inserted: false,
            entries: check.entries,
            ...(check.layer2Skipped ? { layer2_skipped: true as const } : {}),
          };
        }

        const sourceNote = source_note !== undefined && source_note.length > 0 ? source_note : null;
        // NewJournalEntry has no userId field (the writer resolves it itself, fresh, against its
        // own connection) — see the Interface Contract's Requires (from Phase 2, actual).
        const insertedRow = await writer.insertJournalEntry({ text, sourceNote, insight });

        let embedded = false;
        if (check.sibling.status === 'ready' && check.sibling.model !== undefined && check.sibling.embedding !== undefined) {
          try {
            await writer.insertJournalEmbedding({
              entryId: insertedRow.id,
              textSha: check.sibling.textSha,
              normSha: check.sibling.normSha,
              model: check.sibling.model,
              embedding: check.sibling.embedding,
            });
            embedded = true;
          } catch {
            // Best-effort, same as dword's own route: the entry is already saved and shown;
            // dword's own backfill (selectPendingForBackfill) picks this entry up later.
            embedded = false;
          }
        }

        return {
          verdict: check.verdict,
          inserted: true,
          entries: check.verdict === 'duplicate' ? check.entries : [],
          entry: {
            id: insertedRow.id,
            text: insertedRow.text,
            source_note: insertedRow.sourceNote,
            insight: insertedRow.insight,
            insight_status: insertedRow.insightStatus,
            created_at: insertedRow.createdAt,
          },
          embedded,
          ...(check.layer2Skipped ? { layer2_skipped: true as const } : {}),
        };
      }),
  );
}
```

**Impact:** No existing file is touched. `registerDwordJournalCurated` is independently callable
and independently testable with only Phases 1-2 landed (see Step 5).

### Step 4: The shared barrel (integration-only, see risk #2)

**File:** `src/mcp/dwordTools.ts` (new)
**Change:** The one function `src/connectors/register.ts` calls. Imports Phase 3's
`registerDwordVocabCurated` — **this import does not resolve until Phase 3's
`dwordVocabTools.ts` also exists**; that is the explicitly-sanctioned exception described above,
not an oversight.

**Code:**
```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Connector } from '../connectors/types.js';
import { registerDwordJournalCurated } from './dwordJournalTools.js';
import { registerDwordVocabCurated } from './dwordVocabTools.js';

/**
 * The dword system's one curated-registration entry point (the plan index's Decisions table:
 * "one registerDwordCurated call"). src/connectors/register.ts calls this once; it fans out to
 * each domain's own curated tools. Phase 3 owns dwordVocabTools.ts; Phase 4 owns this barrel and
 * dwordJournalTools.ts. If this file already exists when the other phase integrates, that
 * phase's implementer adds its own import + call line here rather than creating a second
 * registration function — see the plan index's Reconciliation Log.
 */
export function registerDwordCurated(server: McpServer, connector: Connector): void {
  registerDwordVocabCurated(server, connector);
  registerDwordJournalCurated(server, connector);
}
```

**Impact:** Does not compile standalone until Phase 3 lands. `npm run typecheck` on a tree with
only Phases 1, 2 and 4 will fail on this one file — expected, and the reason Step 5's test
bypasses it entirely. The reconciler/integrator runs `npm run typecheck` only after merging both
phases' branches, per the plan index's own phase table ("Phases 3 and 4 ... may run
concurrently").

### Step 5: Wire the one shared call into `register.ts`

**File:** `src/connectors/register.ts:1-30` (shape after Phase 1 landed, per the plan index's
own Phase 1 description: `ABOUT` has a `dword: DWORD_ABOUT` entry, `defaultConnectors()` has
`dword: createDwordConnector()`, and `registerConnectorTools`'s for-loop already iterates
`'dword'` for the generic schema/sql tools — no curated call yet)
**Change:** Add the import and the one call line.

**Code (the two lines that change; everything else in the file is Phase 1's / unchanged):**
```ts
import { registerDwordCurated } from '../mcp/dwordTools.js';
```
```ts
  registerDwordCurated(server, connectors.dword);
```
placed inside `registerConnectorTools`, after the three existing curated calls:
```ts
export function registerConnectorTools(server: McpServer, connectors: Connectors): void {
  for (const id of CONNECTOR_SYSTEMS) {
    registerSchemaTool(server, connectors[id], ABOUT[id]);
    registerSqlTool(server, connectors[id], ABOUT[id]);
  }
  registerExpensesCurated(server, connectors.expenses);
  registerRunsCurated(server, connectors.runs);
  registerSeerCurated(server, connectors.seer);
  registerDwordCurated(server, connectors.dword);
}
```

**Impact:** Shared edit with Phase 3 (risk #2) — if Phase 3's plan also proposes this exact
edit, the reconciler keeps one copy (they are textually identical once the barrel exists).

### Step 6: Append the two tool names

**File:** `src/connectors/names.ts` (shape after Phase 1 + Phase 3: `dword: ['dword_schema',
'dword_sql', 'dword_vocab_lookup', 'dword_vocab_add']` — **[Reconciled]** this phase's edit now
assumes Phase 3 has already landed its own two-name append, per the plan index's "one owner per
file region" rule: Phase 3 owns this array's vocab append; this phase appends only its own two
names after it, rather than re-diffing the whole literal from Phase 1's two-name state.)
**Change:** Append this phase's two names after Phase 3's two.

**Code (the final, merged array — the only state this array ever has once both phases have landed):**
```ts
export const CONNECTOR_TOOL_NAMES = {
  expenses: ['expenses_schema', 'expenses_sql', 'expenses_spending', 'expenses_get', 'expenses_months'],
  runs: ['runs_schema', 'runs_sql', 'runs_list', 'runs_get', 'runs_review'],
  seer: ['seer_schema', 'seer_sql', 'seer_leaderboard', 'seer_positions', 'seer_sera_best'],
  dword: [
    'dword_schema',
    'dword_sql',
    'dword_vocab_lookup',
    'dword_vocab_add',
    'dword_journal_find_similar',
    'dword_journal_add',
  ],
} as const satisfies Record<SystemId, readonly string[]>;
```

**Impact:** Shared file region with Phase 3 (risk #2), now resolved by ownership assignment rather
than left as a textual merge for whoever integrates second: Phase 3's two names land first: this
phase's implementer appends its two after them, reaching the six-name array above.

### Step 7: Integration tests (standalone from Phase 3)

**File:** `tests/integration/connectors/dword.journal.curated.int.test.ts` (new)
**Change:** Calls `registerDwordJournalCurated` directly (mirrors `seer.curated.int.test.ts`
calling `registerSeerCurated` directly, not through `registerConnectorTools`) — this is what
makes this phase's own proof independent of Phase 3 and of the Step 4/5/6 wiring.

**Code:**
```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConnector } from '../../../src/connectors/connector.js';
import type { Connector } from '../../../src/connectors/types.js';
import { DwordWriter } from '../../../src/dword/writer.js';
import { normShaFor, textShaFor } from '../../../src/dword/journalSimilarity.js';
import { registerDwordJournalCurated, type JournalDuplicateResult, type JournalMatchEntry } from '../../../src/mcp/dwordJournalTools.js';
import { createFakeEmbedder, type FakeEmbedder } from '../../../tests/helpers/fakeEmbedder.js';
import { describeWithRepo, seedSystem, systemDbUrl, truncateSystem } from './harness.js';

const OWNER_EMAIL = 'journal-int@example.test';
const OWNER_ID = randomUUID();

async function seedOwner(): Promise<void> {
  await truncateSystem('dword');
  await seedSystem('dword', 'INSERT INTO users (id, email) VALUES ($1, $2)', [OWNER_ID, OWNER_EMAIL]);
}

/** A temp daily-words repo dir whose .env.local points at the harness's throwaway Postgres. Used by both the connector and the writer, so they share one database. */
function dwordRepoDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcp-notes-dword-journal-'));
  writeFileSync(path.join(dir, '.env.local'), `DATABASE_URL_UNPOOLED=${systemDbUrl('dword')}\n`);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function text(result: unknown): string {
  const first = (result as CallToolResult).content[0];
  if (!first || first.type !== 'text') throw new Error('expected text content');
  return first.text;
}

async function connect(connector: Connector, writer: DwordWriter, embedder: FakeEmbedder | null): Promise<Client> {
  const server = new McpServer({ name: 'dword-journal-int', version: '0.0.0' });
  registerDwordJournalCurated(server, connector, { writer, embedder, userEmail: () => OWNER_EMAIL });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'dword-journal-int-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describeWithRepo('dword', 'dword journal curated tools', () => {
  let repo: { dir: string; cleanup: () => void };
  let connector: Connector;
  let writer: DwordWriter;
  let embedder: FakeEmbedder;
  let client: Client;

  async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    if (result.isError) throw new Error(text(result));
    return JSON.parse(text(result)) as T;
  }

  beforeAll(async () => {
    repo = dwordRepoDir();
  });

  afterAll(async () => {
    repo.cleanup();
  });

  beforeEach(async () => {
    await seedOwner();
    connector = createConnector('dword', { repoDir: repo.dir, settings: { envFile: false } });
    // userEmail is a required DwordWriterOptions field (phase 2's actual shape) — passed explicitly
    // here rather than via process.env.DWORD_USER_EMAIL, matching how registerDwordJournalCurated's
    // own userEmail override is threaded through `connect()` below, with no global state.
    writer = new DwordWriter({ repoDir: () => repo.dir, userEmail: () => OWNER_EMAIL });
    embedder = createFakeEmbedder();
    client = await connect(connector, writer, embedder);
  });

  afterEach(async () => {
    await client.close();
  });

  it('dword_journal_find_similar reports none when the journal is empty', async () => {
    const out = await call<JournalDuplicateResult>('dword_journal_find_similar', {
      text: 'the early bird catches the worm, every single morning without fail',
    });
    expect(out.verdict).toBe('none');
    expect(out.entries).toEqual([]);
  });

  it('dword_journal_find_similar finds an exact norm_sha match (Layer 1)', async () => {
    const original = 'Nothing to be done.';
    const entryId = randomUUID();
    await seedSystem(
      'dword',
      'INSERT INTO journal_entries (id, user_id, text) VALUES ($1, $2, $3)',
      [entryId, OWNER_ID, original],
    );
    await seedSystem(
      'dword',
      "INSERT INTO journal_entry_embeddings (entry_id, user_id, status, text_sha, norm_sha) VALUES ($1, $2, 'failed', $3, $4)",
      [entryId, OWNER_ID, textShaFor(original), normShaFor(original)],
    );

    // Different whitespace, same normalized text -> Layer 1 hit, no embedding call made.
    const out = await call<JournalDuplicateResult>('dword_journal_find_similar', {
      text: '  Nothing   to be\ndone. ',
    });
    expect(out.verdict).toBe('duplicate');
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]?.id).toBe(entryId);
    expect(embedder.calls).toHaveLength(0);
  });

  it('dword_journal_add with no duplicate inserts both the entry and its embedding', async () => {
    const out = await call<{ verdict: string; inserted: boolean; embedded: boolean; entry: JournalMatchEntry }>(
      'dword_journal_add',
      {
        text: 'the squeaky wheel gets the grease when nobody else speaks up first',
        insight: {
          meaning: 'The person who complains or asks loudest is the one who gets attention or help.',
          whenItApplies: [
            'Asking your manager directly for a raise instead of waiting to be noticed',
            'Flagging a bug repeatedly until it gets fixed',
          ],
        },
      },
    );
    expect(out.verdict).toBe('none');
    expect(out.inserted).toBe(true);
    expect(out.embedded).toBe(true);
    expect(out.entry.insight_status).toBe('ready');

    // Readback proves BOTH rows landed: Layer 1's SQL joins journal_entries to
    // journal_entry_embeddings and requires a matching text_sha/norm_sha, so it can only find
    // this entry if the embeddings insert also succeeded.
    const check = await call<JournalDuplicateResult>('dword_journal_find_similar', {
      text: 'the squeaky wheel gets the grease when nobody else speaks up first',
    });
    expect(check.verdict).toBe('duplicate');
    expect(check.entries[0]?.id).toBe(out.entry.id);
  });

  it('dword_journal_add with a duplicate and no force inserts nothing', async () => {
    const original = 'time heals all wounds';
    const entryId = randomUUID();
    await seedSystem('dword', 'INSERT INTO journal_entries (id, user_id, text) VALUES ($1, $2, $3)', [entryId, OWNER_ID, original]);
    await seedSystem(
      'dword',
      "INSERT INTO journal_entry_embeddings (entry_id, user_id, status, text_sha, norm_sha) VALUES ($1, $2, 'failed', $3, $4)",
      [entryId, OWNER_ID, textShaFor(original), normShaFor(original)],
    );

    const out = await call<{ verdict: string; inserted: boolean; entries: JournalMatchEntry[] }>('dword_journal_add', {
      text: 'time heals all wounds',
      insight: {
        meaning: 'Painful feelings fade and become easier to bear as time passes.',
        whenItApplies: ['Grieving the end of a long relationship', 'Getting over a humiliating mistake at work'],
      },
    });
    expect(out.verdict).toBe('duplicate');
    expect(out.inserted).toBe(false);
    expect(out.entries[0]?.id).toBe(entryId);
  });

  it('dword_journal_add with a duplicate and force=true inserts anyway, with no embedding row', async () => {
    const original = 'actions speak louder than words';
    const entryId = randomUUID();
    await seedSystem('dword', 'INSERT INTO journal_entries (id, user_id, text) VALUES ($1, $2, $3)', [entryId, OWNER_ID, original]);
    await seedSystem(
      'dword',
      "INSERT INTO journal_entry_embeddings (entry_id, user_id, status, text_sha, norm_sha) VALUES ($1, $2, 'failed', $3, $4)",
      [entryId, OWNER_ID, textShaFor(original), normShaFor(original)],
    );

    const out = await call<{ verdict: string; inserted: boolean; embedded: boolean; entry: JournalMatchEntry }>('dword_journal_add', {
      text: original,
      force: true,
      insight: {
        meaning: 'What someone does matters more than what they say they will do.',
        whenItApplies: ['A friend who promises to help you move but never shows up', 'A company that advertises values it does not practice'],
      },
    });
    expect(out.verdict).toBe('duplicate');
    expect(out.inserted).toBe(true);
    expect(out.embedded).toBe(false); // Layer 1 hit never computes a vector, forced or not
    expect(out.entry.id).not.toBe(entryId);
  });

  it('dword_journal_add still inserts the entry when the embedding call fails, with no embeddings row', async () => {
    embedder.failNext(1);
    const out = await call<{ verdict: string; inserted: boolean; embedded: boolean; layer2_skipped?: true }>('dword_journal_add', {
      text: 'a watched pot never boils, no matter how long you stare at it',
      insight: {
        meaning: 'Time feels like it passes more slowly when you are anxiously waiting for something.',
        whenItApplies: ['Refreshing your inbox while waiting for a job offer email', 'Standing by the microwave counting down the seconds'],
      },
    });
    expect(out.verdict).toBe('none');
    expect(out.inserted).toBe(true);
    expect(out.embedded).toBe(false);
    expect(out.layer2_skipped).toBe(true);
  });
});
```

**Impact:** New test file only. The "inserts both the entry and its embedding" journey proves
both rows landed via a Layer-1 readback (it can only find the entry if the join to
`journal_entry_embeddings` also succeeds) rather than a second raw-SQL query — one fewer thing
for the test to know about the schema.

## Principles applied

- **Mirror, do not invent** (the plan set's own invariant 8, generalized beyond `rules.ts`'s
  numeric limits to the near-duplicate comparison operator): `findSimilarJournalEntries` uses
  `distance < NEAR_DUPLICATE_MAX_DISTANCE` (strict), not the `<=` the phase brief's prose used,
  because dword's own `isNearDuplicate` is strict and its comment states the boundary is
  deliberate, not incidental. Documented inline and flagged above rather than silently following
  the brief's wording.
- **Fail loud at the boundary, degrade softly in the middle** (don't swallow unexpected states):
  `findSimilarJournalEntries` never throws past a missing vector or a failed embed call — both
  degrade to `layer2Skipped: true` — but a malformed MCP tool argument still fails zod validation
  loudly, and `resolveDwordUserId`'s refusal still surfaces as a real `ConnectorError`, not a
  silent empty result.
- **Don't reach past your own seam for state you don't own**: rather than widening
  `registerConnectorTools`/`createMcpServer`'s signature to thread `AppDeps.embedder` or
  `Config.dword` down into a curated-tool file (a cross-cutting change that touches
  `src/mcp/server.ts`, `src/deps.ts`, and every other connector's call site), this phase's tools
  re-resolve exactly the one setting they need (`OPENROUTER_API_KEY`) themselves, the same way
  every connector already re-resolves its own sibling repo's `.env.local` per call. Smaller,
  localized, and consistent with the codebase's existing "nothing is cached, everything is
  re-read" connector convention.
- **No new abstraction for one caller**: `findSimilarJournalEntries` lives directly in
  `dwordJournalTools.ts`, not in a new shared "dedup service" module, because exactly one file
  calls it (both of this phase's own tools) — a module boundary earns its keep when a second,
  unrelated caller shows up, not before.

## Verification

**Build:** `npx tsc --noEmit -p tsconfig.json` scoped to this phase's own new files is not
separately expressible (TypeScript checks the whole program), so build verification for *this
phase alone* means: temporarily stub `src/mcp/dwordTools.ts`'s import of
`registerDwordVocabCurated` is **not** necessary if Phase 3 has already landed in the branch
being tested; if it has not, `npm run typecheck` will fail only on `dwordTools.ts` (risk #2) —
confirm every *other* new/changed file in this phase has no error by running `npx tsc --noEmit`
and checking the error list names only `src/mcp/dwordTools.ts` / `src/connectors/register.ts`'s
import of it.
**Tests:** `npx vitest run tests/unit/dword/journalSimilarity.test.ts` (no DB, no network);
`npm run test:int -- tests/integration/connectors/dword.journal.curated.int.test.ts` (needs
Docker and a local `~/daily-words` checkout — both present on this machine, confirmed during
planning).

**Proof:**
- Harness: `.claude/skills/verify-notesd` exists but does not yet cover any dword surface —
  Phase 5 adds `.claude/skills/verify-notesd/features/dword.md` once the Claude-Code-facing `/j`
  skill exists. This phase's proof is therefore `npm run test:int`, the same standard Phases 1-2
  (also non-user-facing) are held to, following the precedent of `seer.curated.int.test.ts`
  proving `registerSeerCurated` directly before any skill or feature-map entry existed for it.
- Feature-map entries: none (deferred to Phase 5, which covers the full `/j` journey end to end).
- Journeys (all in `tests/integration/connectors/dword.journal.curated.int.test.ts`, run with
  `npm run test:int -- tests/integration/connectors/dword.journal.curated.int.test.ts`):
  1. `dword_journal_find_similar` on an empty journal returns `verdict: 'none'`, `entries: []`.
  2. Seed one `journal_entries` + `journal_entry_embeddings` row; call with differently-whitespaced
     but `normalizeForCompare`-identical text; assert `verdict: 'duplicate'`, the seeded id comes
     back, and the fake embedder recorded zero calls (Layer 1 short-circuits Layer 2).
  3. `dword_journal_add` with a fresh line and a valid insight on an empty journal: assert
     `inserted: true`, `embedded: true`, then call `dword_journal_find_similar` with the exact
     same text and assert it now reports `duplicate` with the same id — this is the readback that
     proves both `journal_entries` and `journal_entry_embeddings` rows exist (Layer 1's SQL joins
     both tables and requires a matching `text_sha`/`norm_sha`).
  4. Seed a duplicate; call `dword_journal_add` with the same text and no `force`: assert
     `inserted: false`, the existing id comes back in `entries`.
  5. Same seed; call with `force: true`: assert `inserted: true`, a *new* entry id (different from
     the seeded one), and `embedded: false` (a Layer-1 hit never computes a vector).
  6. `embedder.failNext(1)`; call `dword_journal_add` with a fresh line: assert `inserted: true`,
     `embedded: false`, `layer2_skipped: true` — the entry lands even though the embedding call
     failed.
- Neighbor check: Phase 1's `dword_schema`/`dword_sql` and Phase 2's `assertWritable`-shaped
  allow-list are the features most likely to break if this phase's SQL strings drift from the
  allow-list's expected shape — not directly tested here (Phase 2 owns that test), but journey 3
  above exercises `DwordWriter.insertJournalEntry`/`insertJournalEmbedding` end to end against a
  real (throwaway) Postgres, which would surface an allow-list rejection immediately as a thrown
  `AdversaryWriteError`-shaped error from `run()`'s `errorResult`.
- Cost: zero paid calls. `FakeEmbedder` never reaches OpenRouter; `npm run test:int` never
  touches `OPENROUTER_API_KEY` or dword's production Neon database (the harness's
  `connectorsAdminUrl()` refuses a Neon URL outright).

**Exit criteria:** `npx vitest run tests/unit/dword/journalSimilarity.test.ts` and
`npm run test:int -- tests/integration/connectors/dword.journal.curated.int.test.ts` both pass;
`registerDwordJournalCurated` is callable and fully tested using only Phases 1 and 2's output.

## Handoffs

- **Feature-map entry** (`verify-notesd/features/dword.md`, the journal half) — Phase 5's job,
  once `/j` exists and a live Claude Code session can drive it end to end.
- **[Reconciled] `DWORD_USER_EMAIL` resolution** (R3) — Phase 1 exports
  `resolveDwordUserId(connector, email)` from `src/connectors/dword/user.ts`; this phase (like
  Phase 3) reads the setting itself via its own `emailOf` thunk and passes it as the resolver's
  second argument. No open risk remains here — see "Before you start" risk #1 and the Interface
  Contract's Requires section, both updated.
- **The shared `registerDwordCurated` call / `dwordTools.ts` barrel / `CONNECTOR_TOOL_NAMES.dword`
  array** — ownership is now assigned rather than left as a textual merge: Phase 3 lands its own
  `names.ts` append and does not touch `register.ts`; this phase lands the barrel, the
  `register.ts` call, and appends its two names after Phase 3's (Step 6). The barrel's import of
  Phase 3's `registerDwordVocabCurated` does not type-check until Phase 3 has also landed — a
  known, sanctioned exception (risk #2), resolved by running the full build/test suite once both
  phases are merged (the plan index's phase table already allows them to run concurrently).
- **[Reconciled] `src/dword/rules.ts`'s journal-related constants** — Phase 2 now exports
  `JOURNAL_TEXT_MIN`, `JOURNAL_TEXT_MAX`, `JOURNAL_SOURCE_NOTE_MAX` (added to Phase 2 during
  reconciliation; its original draft never enumerated dword's `limits.ts` at all) and the
  `INSIGHT_*` bounds under their real, longer names (`INSIGHT_MEANING_MIN_CHARS`,
  `INSIGHT_WHEN_IT_APPLIES_ITEM_MAX_CHARS`, etc. — this phase's imports and Zod schema now use
  them). `NEAR_DUPLICATE_MAX_DISTANCE` is **not** one of Phase 2's exports — it is defined in this
  phase's own `src/dword/journalSimilarity.ts` (Step 1) instead; see the plan index's
  Reconciliation Log.
- **`README.md`'s env var table** (`DAILY_WORDS_DIR`, `DWORD_USER_EMAIL`) — Phase 1's job, not
  touched here.

## Rollback

Delete `src/dword/journalSimilarity.ts`, `src/mcp/dwordJournalTools.ts`,
`tests/unit/dword/journalSimilarity.test.ts`,
`tests/integration/connectors/dword.journal.curated.int.test.ts`. Revert the two-name append in
`src/connectors/names.ts`'s `CONNECTOR_TOOL_NAMES.dword` back to `['dword_schema',
'dword_sql']` (or back to the three-name array if Phase 3 had already landed its own two names).
If this phase created `src/mcp/dwordTools.ts` and `src/connectors/register.ts`'s
`registerDwordCurated` call, either delete both (if Phase 3 has not landed) or, if Phase 3 has
landed, edit the barrel to drop only `registerDwordJournalCurated`'s import and call, leaving
Phase 3's half intact. No data in `~/daily-words` is ever touched, so there is nothing to roll
back there.
