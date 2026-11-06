import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SYSTEM_META } from '../../../src/connectors/names.js';
import {
  DAILY_ADD_LIMIT,
  DEFINITION_MAX_CHARS,
  DEFINITION_TARGET_CHARS,
  EXAMPLE_MAX_CHARS,
  EXAMPLE_TARGET_CHARS,
  EXAMPLES_COUNT,
  INSIGHT_MEANING_MAX_CHARS,
  INSIGHT_MEANING_MIN_CHARS,
  INSIGHT_WHEN_IT_APPLIES_ITEM_MAX_CHARS,
  INSIGHT_WHEN_IT_APPLIES_ITEM_MIN_CHARS,
  INSIGHT_WHEN_IT_APPLIES_MAX_ITEMS,
  INSIGHT_WHEN_IT_APPLIES_MIN_ITEMS,
  JOURNAL_SOURCE_NOTE_MAX,
  JOURNAL_TEXT_MAX,
  JOURNAL_TEXT_MIN,
  MAX_CONTEXT_CHARS,
  MAX_TERM_CHARS,
  MAX_TERM_WORDS,
  PART_OF_SPEECH_VALUES,
  PRONUNCIATION_MAX_CHARS,
} from '../../../src/dword/rules.js';
import { siblingRepo } from '../../integration/connectors/siblings.js';

function dwordFile(repoDir: string, rel: string): string {
  return readFileSync(path.join(repoDir, rel), 'utf8');
}

function extractOne(source: string, pattern: RegExp, file: string): string {
  const match = pattern.exec(source);
  const value = match?.[1];
  if (value === undefined) {
    throw new Error(`drift test: could not find the expected pattern in dword's ${file} — its source shape changed; update the pattern and the mirrored constant together`);
  }
  return value;
}

const repoDir = siblingRepo('dword');

if (repoDir === null) {
  const meta = SYSTEM_META.dword;
  describe.skip(`dword rules drift [skipped: ${meta.label} repository not found; clone it to ${meta.defaultRepoDir} or set ${meta.repoDirEnv}]`, () => {});
} else {
  const vocabEnrich = dwordFile(repoDir, 'src/lib/llm/prompts/vocab-enrich.ts');
  const normalize = dwordFile(repoDir, 'src/lib/vocab/normalize.ts');
  const vocabQueries = dwordFile(repoDir, 'src/lib/db/queries/vocab.ts');
  const journalSchemas = dwordFile(repoDir, 'src/lib/journal/schemas.ts');
  const journalLimits = dwordFile(repoDir, 'src/lib/journal/limits.ts');

  describe('dword rules drift (src/dword/rules.ts vs. the real ~/daily-words source)', () => {
    it('mirrors PART_OF_SPEECH_VALUES exactly, same order', () => {
      const block = extractOne(vocabEnrich, /PART_OF_SPEECH_VALUES = \[([\s\S]*?)\] as const/, 'vocab-enrich.ts');
      const values = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      expect(values).toEqual([...PART_OF_SPEECH_VALUES]);
    });

    it('mirrors the pronunciation max', () => {
      const n = Number(extractOne(vocabEnrich, /pronunciation:\s*z\.string\(\)\.trim\(\)\.max\((\d+)\)/, 'vocab-enrich.ts'));
      expect(PRONUNCIATION_MAX_CHARS).toBe(n);
    });

    it('mirrors the definition target and max', () => {
      const target = Number(extractOne(vocabEnrich, /const DEFINITION_TARGET = (\d+);/, 'vocab-enrich.ts'));
      const max = Number(extractOne(vocabEnrich, /const DEFINITION_MAX = (\d+);/, 'vocab-enrich.ts'));
      expect(DEFINITION_TARGET_CHARS).toBe(target);
      expect(DEFINITION_MAX_CHARS).toBe(max);
    });

    it('mirrors the examples count, hard ceiling and advisory target', () => {
      const match = vocabEnrich.match(/examples:\s*z\.array\(z\.string\(\)\.trim\(\)\.min\(1\)\.max\((\d+)\)\)\.max\((\d+)\)/);
      const oneMax = match?.[1];
      const arrMax = match?.[2];
      if (oneMax === undefined || arrMax === undefined) throw new Error("drift test: could not find dword's examples schema shape in vocab-enrich.ts");
      expect(EXAMPLE_MAX_CHARS).toBe(Number(oneMax));
      expect(EXAMPLES_COUNT).toBe(Number(arrMax));
      const advisory = Number(extractOne(vocabEnrich, /Each at most (\d+) characters\./, 'vocab-enrich.ts'));
      expect(EXAMPLE_TARGET_CHARS).toBe(advisory);
    });

    it('mirrors the term length/word limits and the context length', () => {
      const maxChars = Number(extractOne(normalize, /export const MAX_TERM_CHARS = (\d+);/, 'normalize.ts'));
      const maxWords = Number(extractOne(normalize, /export const MAX_TERM_WORDS = (\d+);/, 'normalize.ts'));
      const maxContext = Number(extractOne(normalize, /export const MAX_CONTEXT_CHARS = (\d+);/, 'normalize.ts'));
      expect(MAX_TERM_CHARS).toBe(maxChars);
      expect(MAX_TERM_WORDS).toBe(maxWords);
      expect(MAX_CONTEXT_CHARS).toBe(maxContext);
    });

    it('mirrors the daily add limit', () => {
      const n = Number(extractOne(vocabQueries, /export const DAILY_ADD_LIMIT = (\d+);/, 'queries/vocab.ts'));
      expect(DAILY_ADD_LIMIT).toBe(n);
    });

    it('mirrors the journal text and source-note length limits', () => {
      const textMin = Number(extractOne(journalLimits, /export const JOURNAL_TEXT_MIN = (\d+);/, 'journal/limits.ts'));
      const textMax = Number(extractOne(journalLimits, /export const JOURNAL_TEXT_MAX = (\d+);/, 'journal/limits.ts'));
      const sourceNoteMax = Number(extractOne(journalLimits, /export const JOURNAL_SOURCE_NOTE_MAX = (\d+);/, 'journal/limits.ts'));
      expect(JOURNAL_TEXT_MIN).toBe(textMin);
      expect(JOURNAL_TEXT_MAX).toBe(textMax);
      expect(JOURNAL_SOURCE_NOTE_MAX).toBe(sourceNoteMax);
    });

    it('mirrors the insight meaning and whenItApplies bounds', () => {
      const match = journalSchemas.match(
        /meaning:\s*z\.string\(\)\.trim\(\)\.min\((\d+)\)\.max\((\d+)\)[\s\S]*?whenItApplies:\s*z\.array\(z\.string\(\)\.trim\(\)\.min\((\d+)\)\.max\((\d+)\)\)\.min\((\d+)\)\.max\((\d+)\)/,
      );
      if (!match) throw new Error("drift test: could not find dword's insightSchema shape in journal/schemas.ts");
      const [, meaningMin, meaningMax, itemMin, itemMax, itemsMin, itemsMax] = match;
      expect(INSIGHT_MEANING_MIN_CHARS).toBe(Number(meaningMin));
      expect(INSIGHT_MEANING_MAX_CHARS).toBe(Number(meaningMax));
      expect(INSIGHT_WHEN_IT_APPLIES_ITEM_MIN_CHARS).toBe(Number(itemMin));
      expect(INSIGHT_WHEN_IT_APPLIES_ITEM_MAX_CHARS).toBe(Number(itemMax));
      expect(INSIGHT_WHEN_IT_APPLIES_MIN_ITEMS).toBe(Number(itemsMin));
      expect(INSIGHT_WHEN_IT_APPLIES_MAX_ITEMS).toBe(Number(itemsMax));
    });
  });
}
