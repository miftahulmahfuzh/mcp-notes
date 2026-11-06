import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DwordWriteError, DwordWriter, assertWritable } from '../../../src/dword/writer.js';

const INSERT_VOCAB =
  "INSERT INTO vocab_entries (user_id, term, source, status, part_of_speech, pronunciation, definition, examples, enrichment_status) VALUES ($1, $2, 'manual', 'active', $3, $4, $5, $6::jsonb, 'ready') ON CONFLICT (user_id, lower(term)) DO NOTHING RETURNING id";
const ATTACH_ORIGIN =
  'UPDATE vocab_entries SET origin_term = $2, origin_language = $3, origin_context = $4 WHERE id = $1 AND user_id = $5 AND origin_term IS NULL RETURNING id';
const INSERT_JOURNAL = "INSERT INTO journal_entries (user_id, text, source_note, insight, insight_status) VALUES ($1, $2, $3, $4::jsonb, 'ready') RETURNING id";
const INSERT_EMBEDDING =
  "INSERT INTO journal_entry_embeddings (entry_id, user_id, status, text_sha, norm_sha, model, embedding) VALUES ($1, $2, 'ready', $3, $4, $5, $6::vector)";

const INSERT_UNEMBEDDED =
  "INSERT INTO journal_entry_embeddings (entry_id, user_id, status, text_sha, norm_sha, failed_reason) VALUES ($1, $2, 'failed', $3, $4, $5)";

describe('assertWritable (dword write allow-list)', () => {
  it.each([
    [INSERT_VOCAB, 'vocab_entries'],
    [ATTACH_ORIGIN, 'vocab_entries'],
    [INSERT_JOURNAL, 'journal_entries'],
    [INSERT_EMBEDDING, 'journal_entry_embeddings'],
    [INSERT_UNEMBEDDED, 'journal_entry_embeddings'],
  ])('allows %s', (sql, table) => {
    expect(assertWritable(sql)).toBe(table);
  });

  it.each([
    'DELETE FROM vocab_entries WHERE id = $1',
    'DELETE FROM journal_entries WHERE id = $1',
    'DELETE FROM journal_entry_embeddings WHERE entry_id = $1',
    'INSERT INTO users (id, email) VALUES ($1, $2)',
    'UPDATE users SET email = $1 WHERE id = $2',
    'UPDATE journal_entries SET text = $1 WHERE id = $2',
    "UPDATE journal_entry_embeddings SET status = 'failed' WHERE entry_id = $1",
    'UPDATE vocab_entries SET definition = $1 WHERE id = $2',
    'UPDATE vocab_entries SET origin_term = $1 WHERE id = $2',
    'UPDATE vocab_entries SET origin_term = $2, origin_language = $3, origin_context = $4 WHERE id = $1 AND user_id = $5',
    'UPDATE vocab_entries SET origin_context = $2, origin_term = $3, origin_language = $4 WHERE id = $1 AND user_id = $5 AND origin_term IS NULL',
    'SELECT * FROM vocab_entries',
    "INSERT INTO vocab_entries (term) VALUES ($1); DROP TABLE vocab_entries",
    'INSERT INTO public.vocab_entries (term) VALUES ($1)',
  ])('refuses %s', (sql) => {
    expect(() => assertWritable(sql)).toThrow(DwordWriteError);
  });
});

describe('DwordWriter', () => {
  it('names the missing daily-words repository instead of connecting anywhere', async () => {
    const writer = new DwordWriter({
      repoDir: () => path.join(tmpdir(), `no-dword-here-${process.pid}`),
      userEmail: () => 'owner@example.com',
    });
    await expect(
      writer.insertJournalEntry({ text: 'hello', sourceNote: null, insight: { meaning: 'm'.repeat(20), whenItApplies: ['a'.repeat(8), 'b'.repeat(8)] } }),
    ).rejects.toThrow(/daily-words is not reachable: no repository/);
  });
});
