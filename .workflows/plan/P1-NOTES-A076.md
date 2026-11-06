> Adopted from `.workflows/orchestration/dword-connector/PLAN.md` phase 3. Source: `.workflows/plan/dword-connector/phase-3.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 3: Vocab tools

**Plan set:** `DWORD_CONNECTOR_PLAN.md`
**Analysis:** `.workflows/analyze/20261106-070115-DW6C_code_analyzer.md`
**Satisfies:** R1, R2, R5 — `/v`'s two MCP tools (lookup-or-add a `vocab_entries` row), proven against a throwaway Postgres
**Depends on:** Phase 1 (connector plumbing), Phase 2 (writer and rules)
**Difficulty:** HARD
**Package:** `src/mcp`, `tests/integration/connectors`

---

## Goal

After this phase, two new MCP tools exist and work end to end against dword's real schema:
`dword_vocab_lookup` (read-only: is this word already known, by exact term, by the original
non-English term it resolved from, or by a near-spelling) and `dword_vocab_add` (write: insert a
complete vocab entry, recovering cleanly from a unique-index collision and applying the 5.7/D4
origin rules). Both are exported from one new file, `src/mcp/dwordVocabTools.ts`, via
`registerDwordVocabCurated(server, connector)`, proven by a new integration test file against a
dword-shaped Postgres rebuilt from dword's own migrations. Nothing in `~/daily-words` is touched;
the only database written is the throwaway test one.

## Interface Contract

**Creates:**
- `registerDwordVocabCurated(server: McpServer, connector: Connector, options?: DwordVocabOptions): void` (`src/mcp/dwordVocabTools.ts`) — registers `dword_vocab_lookup` and `dword_vocab_add`. `options.userEmail?: () => string | null` is an optional override (tests only); production call sites pass only `(server, connector)`.
- `interface DwordVocabOptions { userEmail?: () => string | null }` (`src/mcp/dwordVocabTools.ts`)
- `interface VocabEntryJson` (`src/mcp/dwordVocabTools.ts`) — the JSON shape of one `vocab_entries` row, every column.
- Two MCP tool names: `dword_vocab_lookup`, `dword_vocab_add`.

**Modifies:**
- `src/connectors/names.ts` — `CONNECTOR_TOOL_NAMES.dword` gains `'dword_vocab_lookup'` and `'dword_vocab_add'`, appended after whatever phase 1 put there (`dword_schema`, `dword_sql`). **This array is also touched by phase 4** (appending its own two journal tool names) — see Handoffs; the two edits will conflict textually and the reconciler must merge them into one array in a stable order (schema, sql, vocab\*, journal\* is the natural one, matching registration order phases 3 then 4).

**Leaves alone (owned by others):**
- `src/connectors/names.ts`'s `CONNECTOR_SYSTEMS`, `SYSTEM_META` entries, and `src/connectors/env.ts`'s `SETTING_KEYS` (Phase 1).
- `src/connectors/dword/index.ts`, `src/connectors/dword/user.ts`'s `resolveDwordUserId` (imported, not reimplemented), `src/config.ts`'s `DWORD_USER_EMAIL`/`config.dword.userEmail` parsing (Phase 1).
- `src/dword/rules.ts`, `src/dword/writer.ts` internals (Phase 2) — this phase only imports and calls them.
- `src/mcp/dwordJournalTools.ts`, any journal tool names (Phase 4).
- `src/connectors/register.ts`'s curated-registration call (Phase 4 adds the single `registerDwordCurated(...)` call wiring up both phase 3's and phase 4's tools — this phase's `registerDwordVocabCurated` is written so that call works unmodified: `registerDwordVocabCurated(server, connectors.dword)`).
- `claude/skills/v/*`, `.claude/skills/verify-notesd/features/dword.md` (Phase 5) — this phase is not yet reachable by any user flow (no skill, no chat wiring), so it adds no feature-map entry; Phase 5 owns that once `/v` exists.

**Requires (from earlier phases):**
- `'dword'` is a valid `SystemId` with a `SYSTEM_META.dword` entry (`repoDirEnv`, `defaultRepoDir`, `label`, `hasLab: false`), so `resolveRepoDir('dword', ...)` and `createConnector('dword', ...)` work (Phase 1).
- **[Reconciled]** `Config` (`src/config.ts`) has `config.dword: DwordConfig` with `DwordConfig.userEmail: string | null` (Phase 1's actual shape — not the flat `config.dwordUserEmail` this phase originally assumed). This phase reads `loadConfig().dword.userEmail`.
- **[Reconciled]** `src/connectors/dword/user.ts` exports `resolveDwordUserId(connector: Connector, email: string | null): Promise<string>` (Phase 1's actual signature and path). This phase imports and calls it directly rather than reimplementing it locally — see Assumptions below for what changed.
- **[Reconciled]** `src/dword/rules.ts` exports (Phase 1's actual names): `MAX_TERM_CHARS`, `MAX_TERM_WORDS`, `MAX_CONTEXT_CHARS`, `validateDwordContext`, `PART_OF_SPEECH_VALUES` (14-value `as const` tuple), `PRONUNCIATION_MAX_CHARS`, `DEFINITION_MAX_CHARS`, `EXAMPLE_MAX_CHARS`, `EXAMPLES_COUNT`, `DAILY_ADD_LIMIT` (Phase 2's actual exported names — three differ from this phase's original draft: `PRONUNCIATION_MAX`→`PRONUNCIATION_MAX_CHARS`, `DEFINITION_MAX`→`DEFINITION_MAX_CHARS`, `EXAMPLES_REQUIRED`→`EXAMPLES_COUNT`).
- **[Reconciled]** `src/dword/writer.ts` exports a `DwordWriter` class constructed as
  `new DwordWriter({ repoDir: () => string, userEmail: () => string | undefined, timeoutMs?: number })`
  (Phase 2's actual shape — `userEmail` is a **required** constructor field, not optional; the
  writer resolves the dword user id itself, fresh, on every call, against its own connection). Its
  methods this phase calls:
  - `insertVocabEntry(entry: NewVocabEntry): Promise<VocabEntryRow | null>`, where `NewVocabEntry`
    is `{ term, partOfSpeech, pronunciation, definition, examples }` — **no `userId` field** (the
    writer resolves it internally) and **no origin fields** (origin is never set on the initial
    insert; it is always a separate `attachVocabOrigin` call, even for a brand-new row). On a
    unique-index collision (`vocab_entries_user_term_uniq`), the real SQL is
    `... ON CONFLICT (user_id, lower(term)) DO NOTHING RETURNING ...` — **it never throws**; it
    resolves to `null`. This phase originally assumed collision recovery would be driven by
    catching a Postgres `23505` error; Phase 2's actual writer never throws one for this case, so
    that whole code path (Step 1's `pgErrorCode`/`PG_UNIQUE_VIOLATION` logic) has been removed —
    see Assumptions and the plan index's Reconciliation Log.
  - `attachVocabOrigin(id: string, origin: VocabOrigin): Promise<boolean>`, where `VocabOrigin` is
    `{ originTerm: string; originLanguage: string; originContext: string | null }` — returns
    `true`/`false` (whether the `origin_term IS NULL` guard let the attach through), **not a row**.
    A fresh read is needed afterward to get the updated entry.

## Files

| File | Action | What changes |
|---|---|---|
| `src/mcp/dwordVocabTools.ts` | create | `dword_vocab_lookup`, `dword_vocab_add`, `registerDwordVocabCurated` |
| `src/connectors/names.ts` | modify | append `'dword_vocab_lookup'`, `'dword_vocab_add'` to `CONNECTOR_TOOL_NAMES.dword` |
| `tests/integration/connectors/dword.vocab.curated.int.test.ts` | create | integration tests against a throwaway dword-shaped Postgres |

## Assumptions

Phases 1 and 2 were planned concurrently with this one; the shapes below are what this phase
originally coded against, with **[Reconciled]** notes recording what the plan-reconciler changed
once phase-1.md/phase-2.md's actual content was available (see `DWORD_CONNECTOR_PLAN.md`'s
Reconciliation Log for the full list).

1. **Normalize/dedup functions are ported here, not imported from `rules.ts`.** Confirmed correct:
   phase 2's actual `src/dword/rules.ts` holds limits and simple validators (`validateDwordContext`,
   `exampleContainsTerm`, `isDwordPartOfSpeech`, `countTermWords`) but not dword's dedup algorithm.
   `normalizeForDedup`, `foldMorphology`, `dedupKey`, `isSingleWord`, `normalizeTerm`,
   `normalizeContext`, `countWords` stay ported faithfully from `~/daily-words/src/lib/vocab/
   dedup.ts` and `~/daily-words/src/lib/vocab/normalize.ts` directly into `dwordVocabTools.ts`
   (private, not exported), each with a comment naming the source file. **[Reconciled]** The one
   exception: `requireValidContext`'s length check is replaced by a call to phase 2's own
   `validateDwordContext` (it already exists there, performing the identical
   `raw.trim().length > MAX_CONTEXT_CHARS` check) rather than re-testing the same ceiling a second
   time in this file — see Step 1's updated code.
2. **[Reconciled] User-id resolution now calls phase 1's shared resolver, not a local copy.** The
   original draft of this phase assumed no such function existed yet and wrote its own ~10-line
   `resolveDwordUserId(connector, email)` inline. Phase 1 actually ships exactly that function —
   same signature, same SQL, same behavior, only the refusal wording differs — at
   `src/connectors/dword/user.ts`. The local copy is deleted; this file now imports and calls
   `resolveDwordUserId` from that path, so phase 1's exact refusal text ("daily-words user not
   configured: ...", "daily-words user `<email>` not found") is what every dword tool surfaces,
   matching the plan index's R3. This phase still owns reading `DWORD_USER_EMAIL` itself
   (`options.userEmail` override, default `() => loadConfig().dword.userEmail`, read fresh per
   call) and passing the result as the resolver's second argument — `registerDwordVocabCurated`'s
   two-argument production call shape is unaffected. Phase 4 does the identical thing for the
   journal tools (same import, same `emailOf` pattern) — the reconciler accepted this one small
   duplication (the `emailOf` thunk itself, not the resolver) rather than invent a shared options
   type neither phase currently owns.
3. **Lookup's 4-step match order**, read literally off the phase scope ("exact lower(term);
   origin_term match; dedup-key match; near-duplicate"), is implemented as: (1) plain
   `.toLowerCase()` equality on `term` — found; (2) plain `.toLowerCase()` equality on
   `origin_term` — found; (3) `dedupKey()` equality (`normalizeForDedup` + `foldMorphology`),
   restricted to single words on both sides exactly as dword's own `findNearDuplicate` restricts
   its morphological pass — found (this also catches diacritic/case differences on single words,
   since `dedupKey` runs `normalizeForDedup` first); (4) `normalizeForDedup()` equality across all
   remaining rows, not restricted to single words (dword's `findNearDuplicate`'s first pass) —
   returned as `candidates`, not `found`, matching dword's own `near_duplicate` (soft, user
   overrides) vs. `duplicate` (hard) distinction. A verifier should sanity-check this split against
   the three worked examples in the Proof section below.
4. **`examples` is required to be exactly `EXAMPLES_COUNT` (3) strings.** dword's own schema
   only requires exactly 3 when `enrichment_status` is not `'unknown'`; this tool only ever writes
   `enrichment_status = 'ready'`, so the exactly-3 rule always applies and is enforced directly in
   the Zod shape.

## Implementation Steps

### Step 1: `src/mcp/dwordVocabTools.ts`
**File:** `src/mcp/dwordVocabTools.ts` (new)
**Change:** The two curated vocab tools, their validation, and the matching logic.
**Code:**
```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { resolveDwordUserId } from '../connectors/dword/user.js';
import { connectorSettings, resolveRepoDir } from '../connectors/env.js';
import { toObjects } from '../connectors/rows.js';
import { CONNECTOR_MAX_ROWS, ConnectorError, type Connector } from '../connectors/types.js';
import {
  DAILY_ADD_LIMIT,
  DEFINITION_MAX_CHARS,
  EXAMPLES_COUNT,
  EXAMPLE_MAX_CHARS,
  MAX_CONTEXT_CHARS,
  MAX_TERM_CHARS,
  MAX_TERM_WORDS,
  PART_OF_SPEECH_VALUES,
  PRONUNCIATION_MAX_CHARS,
  validateDwordContext,
} from '../dword/rules.js';
import { DwordWriter, type NewVocabEntry, type VocabEntryRow } from '../dword/writer.js';
import { run } from './tools.js';

/*
 * ---------------------------------------------------------------------------
 * Ported from ~/daily-words (read-only reference; never imported, never
 * edited). Two files, kept together here because this tool needs both:
 *   - src/lib/vocab/normalize.ts: normalizeTerm, normalizeContext, validateTerm,
 *     validateContext, countWords.
 *   - src/lib/vocab/dedup.ts: normalizeForDedup, foldMorphology, dedupKey,
 *     isSingleWord.
 * If a future phase 2 adds these to src/dword/rules.ts, delete this block and
 * import them instead; call sites below do not change.
 * ---------------------------------------------------------------------------
 */

const SINGLE_WORD = /^[a-z]{2,32}$/;

function isSingleWord(raw: string): boolean {
  const bare = raw.normalize('NFKD').replace(/\p{M}/gu, '').trim().toLowerCase();
  return SINGLE_WORD.test(bare);
}

const EDGE_JUNK_LEADING = /^[^a-zA-Z]+/;
const EDGE_JUNK_TRAILING = /[^a-zA-Z]+$/;

function normalizeForDedup(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(EDGE_JUNK_LEADING, '')
    .replace(EDGE_JUNK_TRAILING, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

const INFLECTIONS: ReadonlyArray<readonly [string, string]> = [
  ['ying', 'y'],
  ['iest', 'y'],
  ['ier', 'y'],
  ['ies', 'y'],
  ['ied', 'y'],
  ['ing', ''],
  ['es', ''],
  ['ed', ''],
  ['s', ''],
];

const NOT_A_PLURAL = /(?:ss|us|is|as)$/;
const TAKES_ES = /(?:s|x|z|ch|sh)$/;
const DOUBLED_CONSONANT = /([bcdfgklmnprtvz])\1$/;

function dedouble(stem: string): string {
  return DOUBLED_CONSONANT.test(stem) ? stem.slice(0, -1) : stem;
}

function applyInflection(word: string): string {
  for (const [suffix, replacement] of INFLECTIONS) {
    if (!word.endsWith(suffix)) continue;
    const stem = word.slice(0, word.length - suffix.length);
    if (stem.length < 3) continue;
    if (suffix === 's' && NOT_A_PLURAL.test(word)) continue;
    if (suffix === 'es' && !TAKES_ES.test(stem)) continue;
    const folded = stem + replacement;
    return suffix === 'ing' || suffix === 'ed' ? dedouble(folded) : folded;
  }
  return word;
}

const DERIVATIONS: ReadonlyArray<readonly [string, string]> = [
  ['ication', 'icate'],
  ['ation', 'ate'],
  ['ously', 'ous'],
  ['ness', ''],
  ['ment', ''],
  ['tion', 't'],
  ['sion', 's'],
  ['able', ''],
  ['ible', ''],
  ['ity', ''],
  ['ive', ''],
  ['ous', ''],
  ['ism', ''],
  ['ist', ''],
  ['est', ''],
  ['al', ''],
  ['er', ''],
  ['ic', ''],
  ['ly', ''],
];

const MIN_DERIVED_STEM = 5;

function applyDerivation(word: string): string {
  for (const [suffix, replacement] of DERIVATIONS) {
    if (!word.endsWith(suffix)) continue;
    const stem = word.slice(0, word.length - suffix.length);
    if (stem.length < MIN_DERIVED_STEM) continue;
    return stem + replacement;
  }
  return word;
}

function foldMorphology(word: string): string {
  if (word.length <= 4) return word;
  let out = applyInflection(word);
  for (let pass = 0; pass < 2; pass++) {
    const next = applyDerivation(out);
    if (next === out) break;
    out = next;
  }
  return out.length >= 5 && out.endsWith('e') ? out.slice(0, -1) : out;
}

function dedupKey(raw: string): string {
  return foldMorphology(normalizeForDedup(raw));
}

const CURLY_QUOTES = /[‘’ʼ]/g;
const CURLY_DOUBLE_QUOTES = /[“”]/g;
const DASHES = /[–—−]/g;
const EDGE_PUNCTUATION = '[,;:!?"\'‘’“”()\\[\\]]';
const LEADING = new RegExp(`^(?:${EDGE_PUNCTUATION}|\\.)+`);
const TRAILING = new RegExp(`(?:${EDGE_PUNCTUATION})+$`);

function normalizeTerm(raw: string): string {
  const straightened = raw
    .normalize('NFC')
    .replace(CURLY_QUOTES, "'")
    .replace(CURLY_DOUBLE_QUOTES, '"')
    .replace(DASHES, '-')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!straightened) return '';
  let stripped = straightened.replace(LEADING, '').replace(TRAILING, '');
  if (stripped.endsWith('.') && stripped.indexOf('.') === stripped.length - 1) {
    stripped = stripped.slice(0, -1);
  }
  return stripped.trim() || straightened;
}

function normalizeContext(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/[<>`]/g, '')
    .replace(CURLY_QUOTES, "'")
    .replace(CURLY_DOUBLE_QUOTES, '"')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, MAX_CONTEXT_CHARS)
    .trim();
}

function countWords(term: string): number {
  return term.split(' ').filter(Boolean).length;
}

/** Matches dword's TERM_PATTERN shape (Latin letters/marks/'-. /space, first char a letter). */
const TERM_PATTERN = /^\p{Script=Latin}[\p{Script=Latin}\p{M}'\-. ]*$/u;

/** Throws a ConnectorError naming the failed rule. Returns the normalized term. */
function requireValidTerm(raw: string, field: string): string {
  const term = normalizeTerm(raw);
  if (!term) throw new ConnectorError(`${field}: type a word (rule: empty_term).`);
  if (countWords(term) > MAX_TERM_WORDS) {
    throw new ConnectorError(`${field}: "${term}" is a sentence, not a word or short phrase (rule: MAX_TERM_WORDS=${MAX_TERM_WORDS}).`);
  }
  if (term.length > MAX_TERM_CHARS) {
    throw new ConnectorError(`${field}: too long (rule: MAX_TERM_CHARS=${MAX_TERM_CHARS}).`);
  }
  if (!TERM_PATTERN.test(term)) {
    throw new ConnectorError(`${field}: letters only, "${term}" has unsupported characters (rule: TERM_PATTERN).`);
  }
  return term;
}

/**
 * Throws on a raw context longer than MAX_CONTEXT_CHARS. The length check itself is
 * src/dword/rules.ts's own `validateDwordContext` (phase 2) — not re-tested here — so the ceiling
 * is enforced in exactly one place, per plan invariant 8's spirit.
 */
function requireValidContext(raw: string, field: string): string | null {
  const validation = validateDwordContext(raw);
  if (!validation.ok) {
    throw new ConnectorError(`${field}: ${validation.message ?? 'invalid context'} (rule: ${validation.code ?? 'MAX_CONTEXT_CHARS'}).`);
  }
  return normalizeContext(raw) || null;
}

/* ------------------------------------------------------------------------ */

export interface VocabEntryJson {
  id: string;
  user_id: string;
  term: string;
  source: string;
  status: string;
  part_of_speech: string | null;
  pronunciation: string | null;
  definition: string | null;
  examples: string[] | null;
  enrichment_status: string;
  suggested_correction: string | null;
  enrichment_error: string | null;
  enrichment_attempts: number;
  last_shown_on: string | null;
  origin_term: string | null;
  origin_language: string | null;
  origin_context: string | null;
  created_at: string;
  mastered_at: string | null;
}

function entryFromRow(row: Record<string, unknown>): VocabEntryJson {
  const str = (v: unknown): string => String(v ?? '');
  const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
  return {
    id: str(row.id),
    user_id: str(row.user_id),
    term: str(row.term),
    source: str(row.source),
    status: str(row.status),
    part_of_speech: strOrNull(row.part_of_speech),
    pronunciation: strOrNull(row.pronunciation),
    definition: strOrNull(row.definition),
    examples: Array.isArray(row.examples) ? (row.examples as unknown[]).map(String) : null,
    enrichment_status: str(row.enrichment_status),
    suggested_correction: strOrNull(row.suggested_correction),
    enrichment_error: strOrNull(row.enrichment_error),
    enrichment_attempts: Number(row.enrichment_attempts ?? 0),
    last_shown_on: strOrNull(row.last_shown_on),
    origin_term: strOrNull(row.origin_term),
    origin_language: strOrNull(row.origin_language),
    origin_context: strOrNull(row.origin_context),
    created_at: str(row.created_at),
    mastered_at: strOrNull(row.mastered_at),
  };
}

const VOCAB_COLUMNS = `id, user_id, term, source, status, part_of_speech, pronunciation, definition, examples,
  enrichment_status, suggested_correction, enrichment_error, enrichment_attempts, last_shown_on,
  origin_term, origin_language, origin_context, created_at, mastered_at`;

/** Every row the user holds, newest first — mirrors dword's own listTermsForDedup (no status filter). */
async function fetchVocabRows(connector: Connector, userId: string): Promise<VocabEntryJson[]> {
  const result = await connector.query(`SELECT ${VOCAB_COLUMNS} FROM vocab_entries WHERE user_id = $1 ORDER BY created_at DESC`, [userId], {
    maxRows: CONNECTOR_MAX_ROWS,
  });
  return toObjects(result).map(entryFromRow);
}

// resolveDwordUserId is imported from src/connectors/dword/user.js (phase 1) — see Assumptions.

export interface LookupOutcome {
  found: boolean;
  entry?: VocabEntryJson;
  candidates?: VocabEntryJson[];
}

/**
 * Match order (phase scope, literal): exact lower(term); origin_term match; dedup-key match
 * (single words only, like dword's findNearDuplicate morphological pass — also catches
 * diacritic/case differences since dedupKey runs normalizeForDedup first); near-duplicate
 * (normalizeForDedup equality across all rows, dword's findNearDuplicate cosmetic pass) —
 * returned as candidates, not found, matching dword's own near_duplicate/duplicate split.
 */
async function vocabLookup(connector: Connector, email: string | null, rawTerm: string): Promise<LookupOutcome> {
  const userId = await resolveDwordUserId(connector, email);
  const term = normalizeTerm(rawTerm);
  const lowered = term.toLowerCase();
  const rows = await fetchVocabRows(connector, userId);

  const exact = rows.find((r) => r.term.toLowerCase() === lowered);
  if (exact) return { found: true, entry: exact };

  const byOrigin = rows.find((r) => r.origin_term !== null && r.origin_term.toLowerCase() === lowered);
  if (byOrigin) return { found: true, entry: byOrigin };

  if (isSingleWord(term)) {
    const key = dedupKey(term);
    const byFold = rows.find((r) => isSingleWord(r.term) && dedupKey(r.term) === key);
    if (byFold) return { found: true, entry: byFold };
  }

  const normalized = normalizeForDedup(term);
  const candidates = normalized ? rows.filter((r) => normalizeForDedup(r.term) === normalized) : [];
  if (candidates.length > 0) return { found: false, candidates };

  return { found: false };
}

export interface AddVocabArgs {
  term: string;
  part_of_speech: string;
  pronunciation: string;
  definition: string;
  examples: string[];
  origin?: { term: string; language: string; context?: string };
  context?: string;
}

export interface AddOutcome {
  created: boolean;
  origin_attached: boolean;
  entry: VocabEntryJson;
}

/**
 * Re-reads one row by id as a full VocabEntryJson. Needed because neither
 * `writer.insertVocabEntry` (RETURNING a subset of columns) nor `writer.attachVocabOrigin`
 * (RETURNING only `id`, as a boolean here) hands back every column this tool's JSON shape needs.
 */
async function reloadEntry(connector: Connector, id: string): Promise<VocabEntryJson> {
  const result = await connector.query(`SELECT ${VOCAB_COLUMNS} FROM vocab_entries WHERE id = $1`, [id], { maxRows: 1 });
  const [row] = toObjects(result);
  if (!row) throw new ConnectorError('vocab entry disappeared immediately after a successful write');
  return entryFromRow(row);
}

async function vocabAdd(connector: Connector, writer: DwordWriter, email: string | null, args: AddVocabArgs): Promise<AddOutcome> {
  if (args.origin && args.context) {
    throw new ConnectorError('Pass either origin or context, not both — origin already carries its own context field.');
  }

  const userId = await resolveDwordUserId(connector, email);
  const term = requireValidTerm(args.term, 'term');

  let originTerm: string | null = null;
  let originLanguage: string | null = null;
  let originContext: string | null = null;

  if (args.origin) {
    originTerm = requireValidTerm(args.origin.term, 'origin.term');
    originLanguage = args.origin.language.trim();
    if (!originLanguage) throw new ConnectorError('origin.language: must not be empty.');
    originContext = args.origin.context ? requireValidContext(args.origin.context, 'origin.context') : null;
  } else if (args.context) {
    // 5.7 resolution: an English term with a "> sentence" and no origin given.
    originContext = requireValidContext(args.context, 'context');
    originTerm = term;
    originLanguage = 'English';
  }

  const limitRow = await connector.query(`SELECT count(*)::int AS n FROM vocab_entries WHERE user_id = $1 AND created_at >= now() - interval '24 hours'`, [
    userId,
  ]);
  const recent = Number(limitRow.rows[0]?.[0] ?? 0);
  if (recent >= DAILY_ADD_LIMIT) {
    throw new ConnectorError(`That's ${DAILY_ADD_LIMIT} words in a day. Come back tomorrow.`);
  }

  // NewVocabEntry has no userId (the writer resolves it itself) and no origin fields (origin is
  // always a separate attachVocabOrigin call, below — see the Interface Contract's Requires).
  const newEntry: NewVocabEntry = {
    term,
    partOfSpeech: args.part_of_speech,
    pronunciation: args.pronunciation.trim(),
    definition: args.definition.trim(),
    examples: args.examples.map((e) => e.trim()),
  };

  // insertVocabEntry never throws on a term collision (its SQL is ON CONFLICT ... DO NOTHING); it
  // resolves to null instead. No try/catch, no Postgres error code to read.
  const inserted: VocabEntryRow | null = await writer.insertVocabEntry(newEntry);

  if (inserted !== null) {
    // Brand-new row: origin_term is NULL by construction, so an attach (if requested) always wins.
    if (originTerm !== null) {
      await writer.attachVocabOrigin(inserted.id, { originTerm, originLanguage: originLanguage ?? 'English', originContext });
      return { created: true, origin_attached: true, entry: await reloadEntry(connector, inserted.id) };
    }
    return { created: true, origin_attached: false, entry: await reloadEntry(connector, inserted.id) };
  }

  // Collision: the term already exists for this user (case-insensitively).
  const rows = await fetchVocabRows(connector, userId);
  const existing = rows.find((r) => r.term.toLowerCase() === term.toLowerCase());
  if (!existing) {
    throw new ConnectorError('vocab_entries reported an existing term but no matching row was found');
  }
  return finishCollision(connector, writer, existing, originTerm, originLanguage, originContext);
}

/** D4: attach origin only when the existing row has none yet. One UPDATE, no transaction needed. */
async function finishCollision(
  connector: Connector,
  writer: DwordWriter,
  existing: VocabEntryJson,
  originTerm: string | null,
  originLanguage: string | null,
  originContext: string | null,
): Promise<AddOutcome> {
  if (originTerm !== null && existing.origin_term === null) {
    const attached = await writer.attachVocabOrigin(existing.id, { originTerm, originLanguage: originLanguage ?? 'English', originContext });
    if (attached) return { created: false, origin_attached: true, entry: await reloadEntry(connector, existing.id) };
  }
  return { created: false, origin_attached: false, entry: existing };
}

export interface DwordVocabOptions {
  /** DWORD_USER_EMAIL override (tests). Default: loadConfig().dword.userEmail, read fresh per call. */
  userEmail?: () => string | null;
}

const LOOKUP_DESCRIPTION =
  "Checks whether the user already holds a word or phrase in daily-words (dword), their personal vocabulary app, before adding it. " +
  'Matches in order: the exact term; the original (often non-English) word that resolved to an English term (origin_term); ' +
  'an inflected form of the same single word (studying/study); a near-identical spelling (naïve/naive), returned as candidates rather than a ' +
  'confident match since the user may still want to add it separately. Call this before dword_vocab_add.';

const ADD_DESCRIPTION =
  'Adds a complete vocab entry to daily-words (dword): part_of_speech, pronunciation, definition and exactly 3 example sentences are written as given — ' +
  'this tool makes no model call, so write a correct, complete entry yourself before calling it. On a term the user already holds, nothing new is inserted ' +
  "and the existing entry is returned instead (created: false). Pass origin only for a non-English term you already resolved to English (origin.term is " +
  'the original word, origin.language its language, origin.context an optional "as in ..." sentence). Pass context (not origin) for a plain English term ' +
  'with a "> sentence" from /v — it is stored as the entry\'s own origin (origin_language "English") so the sentence is not lost; if the term already exists ' +
  'with no origin, the context is attached to it instead of failing. Refuses past 50 adds in a rolling 24 hours.';

export function registerDwordVocabCurated(server: McpServer, connector: Connector, options: DwordVocabOptions = {}): void {
  const emailOf = options.userEmail ?? ((): string | null => loadConfig().dword.userEmail);
  const writerFor = (): DwordWriter =>
    new DwordWriter({ repoDir: () => resolveRepoDir('dword', connectorSettings()), userEmail: () => emailOf() ?? undefined });

  server.registerTool(
    'dword_vocab_lookup',
    {
      title: 'Look up a dword vocab entry',
      description: LOOKUP_DESCRIPTION,
      inputSchema: {
        term: z.string().min(1).max(MAX_TERM_CHARS).describe('The word or phrase to look up, exactly as the user typed it.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ term }) => run(() => vocabLookup(connector, emailOf(), term), { compact: true }),
  );

  server.registerTool(
    'dword_vocab_add',
    {
      title: 'Add a dword vocab entry',
      description: ADD_DESCRIPTION,
      inputSchema: {
        term: z.string().min(1).max(MAX_TERM_CHARS).describe('The word or phrase to add, exactly as the user typed it.'),
        part_of_speech: z.enum(PART_OF_SPEECH_VALUES).describe('The term\'s part of speech.'),
        pronunciation: z.string().trim().max(PRONUNCIATION_MAX_CHARS).describe('A short pronunciation guide (IPA or respelling), e.g. "JEN-teel".'),
        definition: z.string().trim().min(1).max(DEFINITION_MAX_CHARS).describe('A plain-English definition, one sentence.'),
        examples: z
          .array(z.string().trim().min(1).max(EXAMPLE_MAX_CHARS))
          .length(EXAMPLES_COUNT)
          .describe(`Exactly ${EXAMPLES_COUNT} example sentences using the term.`),
        origin: z
          .object({
            term: z.string().min(1).max(MAX_TERM_CHARS).describe('The original (often non-English) word or phrase, before resolving to term.'),
            language: z.string().trim().min(1).max(60).describe('The origin language, e.g. "Indonesian".'),
            context: z.string().max(2000).optional().describe('An "as in ..." sentence for the origin term (same length rule as context).'),
          })
          .optional()
          .describe('Only for a non-English lookup you already resolved to term. Omit for a plain English add.'),
        context: z
          .string()
          .max(2000)
          .optional()
          .describe('An "as in ..." sentence from /v\'s "> sentence" for a plain English term. Mutually exclusive with origin.'),
      },
    },
    async (args) => run(() => vocabAdd(connector, writerFor(), emailOf(), args as AddVocabArgs), { compact: true }),
  );
}
```
**Impact:** Adds two new tools; registers nothing else. No existing file's runtime behavior changes (only `names.ts`'s array literal, see Step 2).

### Step 2: register the two tool names
**File:** `src/connectors/names.ts:10-14` (as it will read after Phase 1 adds `dword: ['dword_schema', 'dword_sql']`)
**Change:** Append the vocab tool names to `CONNECTOR_TOOL_NAMES.dword`.
**Code:**
```ts
export const CONNECTOR_TOOL_NAMES = {
  expenses: ['expenses_schema', 'expenses_sql', 'expenses_spending', 'expenses_get', 'expenses_months'],
  runs: ['runs_schema', 'runs_sql', 'runs_list', 'runs_get', 'runs_review'],
  seer: ['seer_schema', 'seer_sql', 'seer_leaderboard', 'seer_positions', 'seer_sera_best'],
  dword: ['dword_schema', 'dword_sql', 'dword_vocab_lookup', 'dword_vocab_add'],
} as const satisfies Record<SystemId, readonly string[]>;
```
**Impact:** `ALL_CONNECTOR_TOOL_NAMES` (used by the chat bar's allow-list, phase 6) now includes the
two vocab tool names. **Conflict risk:** phase 4 independently appends its own two journal tool
names to the same `dword` array; whichever phase's branch merges second must combine both edits
into `['dword_schema', 'dword_sql', 'dword_vocab_lookup', 'dword_vocab_add', 'dword_journal_find_similar', 'dword_journal_add']` — flagged for the reconciler.

## Principles applied

- Make illegal states unrepresentable: `vocabAdd` rejects a call that supplies both `origin` and
  top-level `context` (ambiguous which sentence attaches to what) with a clear refusal, rather than
  silently preferring one and dropping the other.
- Boundary discipline: every input (`term`, `origin.term`, `context`, `origin.context`,
  `pronunciation`, `definition`, `examples`) is normalized and validated exactly once, at the top
  of `vocabAdd`/`vocabLookup`; `fetchVocabRows`, `resolveDwordUserId` and the writer calls trust
  the already-validated values and never re-validate.
- Laziness protocol: `fetchVocabRows` (one query) is reused for both the lookup tool's matching
  and the add tool's post-collision existing-row lookup, instead of a second parameterised query
  or a new abstraction.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npx vitest run tests/unit` (unaffected unit suite stays green) and the integration test
below.
**Proof:**
- Harness: no harness — `dword_vocab_lookup`/`dword_vocab_add` are backend MCP connector tools
  with no web UI, the same shape as the existing `expenses`/`runs`/`seer` connectors, none of which
  have a `verify-notesd` feature-map entry either (confirmed: only `adversary.md` exists among
  `.claude/skills/verify-notesd/features/*.md`, because Seer Adversarial has a `/adversary` web
  page and the three read-only connectors do not). Proof here is the integration test, run against
  a throwaway Postgres rebuilt from dword's own migrations — the same proof shape every existing
  connector curated-tool file uses (`seer.curated.int.test.ts`, `expenses.curated.int.test.ts`).
- Feature-map entries: none (this phase is not yet reachable by any user flow; Phase 5 adds
  `.claude/skills/verify-notesd/features/dword.md` once `/v` exists).
- Journeys (each a `vitest` case in the file from Step 3, run for real against Postgres, not
  mocked):
  1. `dword_vocab_lookup` on a seeded exact term returns `found: true` with the full row.
  2. `dword_vocab_lookup` on an unknown term returns `found: false` with no candidates.
  3. `dword_vocab_add` on a brand-new term inserts a real row (`created: true`) — verified by
     calling `dword_vocab_lookup` immediately after and getting `found: true` on the same id.
  4. `dword_vocab_add` on an existing term (different case) returns the existing row
     (`created: false`) without erroring or creating a second row.
  5. `dword_vocab_add` with `context` on a term with no prior origin attaches origin
     (`origin_attached: true`, `origin_language: 'English'`).
  6. `dword_vocab_add` with `context` on a term that already has an origin leaves it untouched
     (`origin_attached: false`, the seeded origin unchanged).
  7. `dword_vocab_add` against a user with 50 rows already created in the last 24h is refused
     (`result.isError` true, message names the limit) and inserts no 51st row.
- Neighbor check: `dword_schema`/`dword_sql` (phase 1's generic tools, already proven by its own
  phase) are not re-broken — `tests/integration/connectors/generic.int.test.ts` already iterates
  every `SystemId` including `'dword'` once phase 1 lands, so no new test is owed here, but this
  phase's `npm run test:int` run also exercises that file and must stay green.
- Cost: none — no LLM calls, no `swarm.py launch`; one Docker Postgres run.
**Exit criteria:** `npm run test:int -- tests/integration/connectors/dword.vocab.curated.int.test.ts`
passes seven test cases against the real dword schema in Docker Postgres, and `npm run typecheck`
is clean.

### Step 3: integration test
**File:** `tests/integration/connectors/dword.vocab.curated.int.test.ts` (new)
**Change:** Seeds a throwaway `connectors_dword` Postgres database (rebuilt from
`~/daily-words/drizzle/*.sql` by the shared harness) with two users and a handful of
`vocab_entries` rows, then drives the two tools over an in-memory MCP client — the exact pattern
`seer.curated.int.test.ts` and `expenses.curated.int.test.ts` already use.
**Code:**
```ts
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { registerDwordVocabCurated } from '../../../src/mcp/dwordVocabTools.js';
import type { Connector } from '../../../src/connectors/types.js';
import { cleanupHarness, connectorFor, describeWithRepo, systemDbUrl, truncateSystem, withAdmin } from './harness.js';

const VOCAB_EMAIL = 'vocab-test@example.test';
const VOCAB_USER_ID = randomUUID();
const LIMIT_EMAIL = 'vocab-limit-test@example.test';
const LIMIT_USER_ID = randomUUID();

const GENTEEL_ID = randomUUID();
const SMEAR_ID = randomUUID();
const MELUMURI_ID = randomUUID();

async function seed(): Promise<void> {
  await truncateSystem('dword');
  await withAdmin(systemDbUrl('dword'), async (db) => {
    await db.query('INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)', [VOCAB_USER_ID, VOCAB_EMAIL, LIMIT_USER_ID, LIMIT_EMAIL]);

    await db.query(
      `INSERT INTO vocab_entries (id, user_id, term, source, status, part_of_speech, pronunciation, definition, examples, enrichment_status)
       VALUES ($1, $2, 'Genteel', 'manual', 'active', 'adjective', 'jen-TEEL', 'polite in a refined way',
               '["She had a genteel manner.","The genteel part of town.","He spoke with genteel calm."]'::jsonb, 'ready')`,
      [GENTEEL_ID, VOCAB_USER_ID],
    );

    await db.query(
      `INSERT INTO vocab_entries (id, user_id, term, source, status, part_of_speech, pronunciation, definition, examples, enrichment_status)
       VALUES ($1, $2, 'Smear', 'manual', 'active', 'verb', 'smeer', 'to spread a substance across a surface',
               '["He tried to smear paint on the wall.","Do not smear the ink.","The chef smeared sauce on the plate."]'::jsonb, 'ready')`,
      [SMEAR_ID, VOCAB_USER_ID],
    );

    await db.query(
      `INSERT INTO vocab_entries (id, user_id, term, source, status, part_of_speech, pronunciation, definition, examples, enrichment_status,
               origin_term, origin_language, origin_context)
       VALUES ($1, $2, 'Smudge', 'manual', 'active', 'verb', 'smuhj', 'to spread or rub dirt, making a mark',
               '["The pencil left a smudge.","He smudged the chalk line.","A smudge of ink on the page."]'::jsonb, 'ready',
               'melumuri', 'Indonesian', NULL)`,
      [MELUMURI_ID, VOCAB_USER_ID],
    );

    for (let i = 0; i < 50; i++) {
      await db.query(
        `INSERT INTO vocab_entries (id, user_id, term, source, status, part_of_speech, pronunciation, definition, examples, enrichment_status, created_at)
         VALUES ($1, $2, $3, 'manual', 'active', 'noun', 'x', 'x', '["x","x","x"]'::jsonb, 'ready', now())`,
        [randomUUID(), LIMIT_USER_ID, `limit-word-${i}`],
      );
    }
  });
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('expected text content');
  return first.text;
}

async function connect(connector: Connector, email: string): Promise<{ client: Client; server: McpServer }> {
  const server = new McpServer({ name: 'dword-vocab-curated-int', version: '0.0.0' });
  registerDwordVocabCurated(server, connector, { userEmail: () => email });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'dword-vocab-curated-int-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server };
}

describeWithRepo('dword', 'dword vocab curated tools', () => {
  let client: Client;
  let server: McpServer;
  let limitClient: Client;
  let limitServer: McpServer;

  async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    if (result.isError) throw new Error(textOf(result));
    return JSON.parse(textOf(result)) as T;
  }

  async function callError(name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    expect(result.isError).toBe(true);
    return textOf(result);
  }

  beforeAll(async () => {
    await seed();
    const connector = connectorFor('dword');
    ({ client, server } = await connect(connector, VOCAB_EMAIL));
    ({ client: limitClient, server: limitServer } = await connect(connector, LIMIT_EMAIL));
  });

  afterAll(async () => {
    await client?.close();
    await server?.close();
    await limitClient?.close();
    await limitServer?.close();
    cleanupHarness();
  });

  it('dword_vocab_lookup: exact term hit returns the full row', async () => {
    const out = await call<{ found: boolean; entry?: { id: string; definition: string | null } }>('dword_vocab_lookup', { term: 'genteel' });
    expect(out.found).toBe(true);
    expect(out.entry?.id).toBe(GENTEEL_ID);
    expect(out.entry?.definition).toBe('polite in a refined way');
  });

  it('dword_vocab_lookup: origin_term match finds the row by its original non-English word', async () => {
    const out = await call<{ found: boolean; entry?: { id: string } }>('dword_vocab_lookup', { term: 'melumuri' });
    expect(out.found).toBe(true);
    expect(out.entry?.id).toBe(MELUMURI_ID);
  });

  it('dword_vocab_lookup: an unrelated word is a miss with no candidates', async () => {
    const out = await call<{ found: boolean; candidates?: unknown[] }>('dword_vocab_lookup', { term: 'xenophobia' });
    expect(out.found).toBe(false);
    expect(out.candidates ?? []).toEqual([]);
  });

  it('dword_vocab_add: a brand-new term is created and then found by lookup', async () => {
    const out = await call<{ created: boolean; origin_attached: boolean; entry: { id: string; term: string } }>('dword_vocab_add', {
      term: 'lucent',
      part_of_speech: 'adjective',
      pronunciation: 'LOO-suhnt',
      definition: 'giving off light; shining',
      examples: ['The lucent moon.', 'Her lucent eyes.', 'A lucent glow filled the room.'],
    });
    expect(out.created).toBe(true);
    expect(out.origin_attached).toBe(false);
    expect(out.entry.term).toBe('lucent');

    const found = await call<{ found: boolean; entry?: { id: string } }>('dword_vocab_lookup', { term: 'Lucent' });
    expect(found.found).toBe(true);
    expect(found.entry?.id).toBe(out.entry.id);
  });

  it('dword_vocab_add: an existing term (different case) returns the existing row, no new row', async () => {
    const out = await call<{ created: boolean; entry: { id: string; definition: string | null } }>('dword_vocab_add', {
      term: 'GENTEEL',
      part_of_speech: 'noun',
      pronunciation: 'x',
      definition: 'a different definition that must not overwrite the existing one',
      examples: ['x', 'x', 'x'],
    });
    expect(out.created).toBe(false);
    expect(out.entry.id).toBe(GENTEEL_ID);
    expect(out.entry.definition).toBe('polite in a refined way');
  });

  it('dword_vocab_add: a context on a term with no prior origin attaches origin (5.7)', async () => {
    const out = await call<{ created: boolean; origin_attached: boolean; entry: { origin_term: string | null; origin_language: string | null; origin_context: string | null } }>(
      'dword_vocab_add',
      {
        term: 'Smear',
        part_of_speech: 'verb',
        pronunciation: 'x',
        definition: 'x',
        examples: ['x', 'x', 'x'],
        context: 'as in he tried to smear his rival',
      },
    );
    expect(out.created).toBe(false);
    expect(out.origin_attached).toBe(true);
    expect(out.entry.origin_term).toBe('Smear');
    expect(out.entry.origin_language).toBe('English');
    expect(out.entry.origin_context).toBe('as in he tried to smear his rival');
  });

  it('dword_vocab_add: a context on a term that already has an origin leaves it untouched (D4)', async () => {
    const out = await call<{ created: boolean; origin_attached: boolean; entry: { origin_term: string | null; origin_language: string | null } }>(
      'dword_vocab_add',
      {
        term: 'Smudge',
        part_of_speech: 'verb',
        pronunciation: 'x',
        definition: 'x',
        examples: ['x', 'x', 'x'],
        context: 'as in he smudged the drawing',
      },
    );
    expect(out.created).toBe(false);
    expect(out.origin_attached).toBe(false);
    expect(out.entry.origin_term).toBe('melumuri');
    expect(out.entry.origin_language).toBe('Indonesian');
  });

  it('dword_vocab_add: refuses past the 50/24h limit and writes nothing', async () => {
    const result = (await limitClient.callTool({
      name: 'dword_vocab_add',
      arguments: { term: 'one-too-many', part_of_speech: 'noun', pronunciation: 'x', definition: 'x', examples: ['x', 'x', 'x'] },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/50 words in a day/);

    const lookup = await limitClient.callTool({ name: 'dword_vocab_lookup', arguments: { term: 'one-too-many' } });
    const parsed = JSON.parse(textOf(lookup as CallToolResult)) as { found: boolean };
    expect(parsed.found).toBe(false);
  });

  it('dword_vocab_add: rejects origin and context together', async () => {
    expect(
      await callError('dword_vocab_add', {
        term: 'ambiguous',
        part_of_speech: 'noun',
        pronunciation: 'x',
        definition: 'x',
        examples: ['x', 'x', 'x'],
        origin: { term: 'ambigu', language: 'French' },
        context: 'as in an ambiguous sentence',
      }),
    ).toMatch(/either origin or context/);
  });
});
```
**Impact:** New file only; proves Step 1 against real Postgres, never touches `~/daily-words` or
production Neon (`describeWithRepo`/`truncateSystem`/`systemDbUrl` all route to the Docker
`connectors_dword` database per `siblings.ts`, unchanged by this phase).

## Handoffs

- **[Reconciled]** This phase now imports the real `src/dword/rules.ts` names (Phase 2) and the
  real `src/connectors/dword/user.ts` resolver (Phase 1) — see Assumptions and the Interface
  Contract's Requires section for the full before/after. No open assumption remains on either.
- **[Reconciled]** `insertVocabEntry` never surfaces a Postgres `23505` error — it resolves to
  `null` on a collision (`ON CONFLICT ... DO NOTHING`). This phase's `vocabAdd` now branches on that
  `null` directly; the earlier `pgErrorCode`/`PG_UNIQUE_VIOLATION` detection logic is removed.
- **[Reconciled]** `resolveDwordUserId`/`DWORD_USER_EMAIL`-reading is no longer duplicated as a
  full local function — both this phase and Phase 4 import the same `resolveDwordUserId` from
  `src/connectors/dword/user.ts` and each keep their own small `emailOf` thunk
  (`options.userEmail ?? (() => loadConfig().dword.userEmail)`) to supply its second argument,
  since `registerDwordVocabCurated`/`registerDwordJournalCurated`'s two-argument production call
  shape leaves no room to inject a resolved id. The reconciler judged this one-line thunk an
  acceptable, independently-correct duplication rather than a shared file neither phase owns.
- **Phase 4** adds `src/connectors/register.ts`'s one `registerDwordCurated(server, connectors.dword)`
  call, which must call this phase's `registerDwordVocabCurated(server, connectors.dword)` with no
  third argument (the default `options = {}` reads real config) alongside its own journal
  registration.
- **Names.ts conflict**: both this phase and phase 4 append to `CONNECTOR_TOOL_NAMES.dword` in
  `src/connectors/names.ts`; the reconciler merges both edits into one array (see Step 2's Impact
  note).
- **Phase 5** owns `.claude/skills/verify-notesd/features/dword.md` and the `/v` skill; this phase
  adds no feature-map entry since nothing user-facing exists yet.
- Not done here, intentionally: a proactive near-duplicate check on `dword_vocab_add` (dword's own
  `findNearDuplicate`-before-insert UX). The phase scope only asks for unique-index collision
  recovery on add; a softer near-duplicate warning on add (if ever wanted) is a product decision
  for a later phase, not implied by R1/R2/R5.

## Rollback

Delete `src/mcp/dwordVocabTools.ts` and `tests/integration/connectors/dword.vocab.curated.int.test.ts`,
and revert the one-line append to `CONNECTOR_TOOL_NAMES.dword` in `src/connectors/names.ts` (back to
whatever phase 1 left it as). Nothing else references this phase's exports yet (phase 4's shared
registration call does not exist until phase 4 lands), so this phase can be reverted alone without
touching phase 1/2's files.
