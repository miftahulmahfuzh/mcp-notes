/**
 * Every limit mcp-notes must mirror from dword (daily-words), in one place (plan invariant 8).
 * Each constant is commented with the dword source file/line it was read from on 2026-11-06.
 * `tests/unit/dword/rules.drift.test.ts` re-reads those files and fails if a number here no
 * longer matches, whenever `~/daily-words` is checked out locally.
 *
 * This module is pure: no I/O, no imports from `src/connectors/*` or `pg`. `src/dword/writer.ts`
 * and the phase 3/4 MCP tools both depend on it; it depends on nothing of mcp-notes' own.
 */

/* --------------------------------- Part of speech -------------------------------- */

/** dword `src/lib/llm/prompts/vocab-enrich.ts:13-28` (`PART_OF_SPEECH_VALUES`). Exact order. */
export const PART_OF_SPEECH_VALUES = [
  'noun',
  'verb',
  'adjective',
  'adverb',
  'pronoun',
  'preposition',
  'conjunction',
  'interjection',
  'determiner',
  'phrase',
  'idiom',
  'phrasal verb',
  'abbreviation',
  'other',
] as const;

export type DwordPartOfSpeech = (typeof PART_OF_SPEECH_VALUES)[number];

export function isDwordPartOfSpeech(value: string): value is DwordPartOfSpeech {
  return (PART_OF_SPEECH_VALUES as readonly string[]).includes(value);
}

/* ------------------------------------- Term --------------------------------------- */

/** dword `src/lib/vocab/normalize.ts:14` (`MAX_TERM_CHARS`). */
export const MAX_TERM_CHARS = 80;

/** dword `src/lib/vocab/normalize.ts:17` (`MAX_TERM_WORDS`). More than this is a sentence. */
export const MAX_TERM_WORDS = 6;

/** Word count for the six-word cap, same rule as dword's `countWords`: split on spaces, drop empties. */
export function countTermWords(term: string): number {
  return term.split(' ').filter(Boolean).length;
}

/* ----------------------------------- Context --------------------------------------- */

/** dword `src/lib/vocab/normalize.ts:104` (`MAX_CONTEXT_CHARS`), the "as in" sentence on `/v`. */
export const MAX_CONTEXT_CHARS = 200;

export type DwordContextErrorCode = 'context_too_long';

export interface DwordContextValidation {
  ok: boolean;
  code?: DwordContextErrorCode;
  message?: string;
}

/**
 * Mirrors dword's `validateContext` (`src/lib/vocab/normalize.ts:149`) exactly, including its
 * order: checked on the RAW, untouched input, before any truncation. Truncating first would
 * silently accept and cut a too-long sentence instead of telling the caller it was too long —
 * dword's own comment states this is deliberate, and this function keeps the same order.
 */
export function validateDwordContext(raw: string): DwordContextValidation {
  if (raw.trim().length > MAX_CONTEXT_CHARS) {
    return { ok: false, code: 'context_too_long', message: "That's too long. One sentence is enough." };
  }
  return { ok: true };
}

/* ------------------------------ Pronunciation / definition ------------------------------- */

/** dword `src/lib/llm/prompts/vocab-enrich.ts:54` (`pronunciation: z.string().trim().max(60)`). */
export const PRONUNCIATION_MAX_CHARS = 60;

/**
 * dword `src/lib/llm/prompts/vocab-enrich.ts:44` (`const DEFINITION_TARGET = 60`) — the prompt's
 * own target, not a hard ceiling. mcp-notes' `/v` flow has Claude write the definition directly
 * (no enrichment prompt call), so this is advisory: aim for it, but `DEFINITION_MAX_CHARS` is the
 * one that must be enforced before a write.
 */
export const DEFINITION_TARGET_CHARS = 60;

/** dword `src/lib/llm/prompts/vocab-enrich.ts:45` (`const DEFINITION_MAX = 80`). The hard ceiling. */
export const DEFINITION_MAX_CHARS = 80;

/* ----------------------------------- Examples ------------------------------------- */

/** dword `src/lib/llm/prompts/vocab-enrich.ts:56,76-81` — exactly 3 examples (non-"unknown" case). */
export const EXAMPLES_COUNT = 3;

/**
 * dword `src/lib/llm/prompts/vocab-enrich.ts:179` — the prompt's own instruction, "Each at most
 * 100 characters." Advisory only: the schema's hard ceiling is `EXAMPLE_MAX_CHARS` (120).
 */
export const EXAMPLE_TARGET_CHARS = 100;

/** dword `src/lib/llm/prompts/vocab-enrich.ts:56` (`z.string().trim().min(1).max(120)`). Hard ceiling. */
export const EXAMPLE_MAX_CHARS = 120;

/**
 * dword's prompt requires each example to "contain the term or an inflected form of it"
 * (`vocab-enrich.ts:179`). mcp-notes' simpler rule (per this plan set's design): each example
 * must contain the term verbatim, case-insensitively — inflected-form matching is not attempted.
 */
export function exampleContainsTerm(example: string, term: string): boolean {
  return example.toLowerCase().includes(term.toLowerCase());
}

/* ------------------------------------ Journal -------------------------------------- */

/**
 * dword `src/lib/journal/limits.ts` (`JOURNAL_TEXT_MIN`). **[Reconciled]** Added during plan
 * reconciliation: phase 4 (journal tools) needs this and the two constants below, and this
 * module's original enumerated list never named `limits.ts` at all — confirmed against the real
 * file during reconciliation, 2026-11-06.
 */
export const JOURNAL_TEXT_MIN = 2;

/** dword `src/lib/journal/limits.ts` (`JOURNAL_TEXT_MAX`). ~150-170 English words. */
export const JOURNAL_TEXT_MAX = 1000;

/** dword `src/lib/journal/limits.ts` (`JOURNAL_SOURCE_NOTE_MAX`). */
export const JOURNAL_SOURCE_NOTE_MAX = 200;

/* ------------------------------------ Insight -------------------------------------- */

/** dword `src/lib/journal/schemas.ts:115-118` (`insightSchema.meaning`, `z.string().trim().min(20)`). */
export const INSIGHT_MEANING_MIN_CHARS = 20;

/** dword `src/lib/journal/schemas.ts:115-118` (`insightSchema.meaning`, `.max(220)`). */
export const INSIGHT_MEANING_MAX_CHARS = 220;

/** dword `src/lib/journal/schemas.ts:115-118` (`insightSchema.whenItApplies`, `.min(2)` items). */
export const INSIGHT_WHEN_IT_APPLIES_MIN_ITEMS = 2;

/** dword `src/lib/journal/schemas.ts:115-118` (`insightSchema.whenItApplies`, `.max(3)` items). */
export const INSIGHT_WHEN_IT_APPLIES_MAX_ITEMS = 3;

/** dword `src/lib/journal/schemas.ts:115-118` (`whenItApplies` item, `z.string().trim().min(8)`). */
export const INSIGHT_WHEN_IT_APPLIES_ITEM_MIN_CHARS = 8;

/** dword `src/lib/journal/schemas.ts:115-118` (`whenItApplies` item, `.max(120)`). */
export const INSIGHT_WHEN_IT_APPLIES_ITEM_MAX_CHARS = 120;

/* ---------------------------------- Daily limit ------------------------------------- */

/**
 * dword `src/lib/db/queries/vocab.ts:20` (`DAILY_ADD_LIMIT`). A rolling 24h window, not a
 * calendar day — dword's own comment: "needs no timezone and no profile."
 */
export const DAILY_ADD_LIMIT = 50;
