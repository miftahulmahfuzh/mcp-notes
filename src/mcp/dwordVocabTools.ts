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
  type DwordPartOfSpeech,
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
  part_of_speech: DwordPartOfSpeech;
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
  /**
   * Writer override (tests). Default: a DwordWriter over DAILY_WORDS_DIR's own .env.local. Without
   * it a test would write through the real ~/daily-words/.env.local, i.e. production (plan invariant 6).
   */
  writer?: DwordWriter;
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
  const writer =
    options.writer ?? new DwordWriter({ repoDir: () => resolveRepoDir('dword', connectorSettings()), userEmail: () => emailOf() ?? undefined });

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
    async (args) => run(() => vocabAdd(connector, writer, emailOf(), args), { compact: true }),
  );
}
