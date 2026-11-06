import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DwordWriter } from '../../../src/dword/writer.js';
import { cleanupHarness, describeWithRepo, seedSystem, systemDbUrl, truncateSystem, withAdmin } from './harness.js';

const OWNER_EMAIL = 'owner@example.com';

let repoDir: string;

function writer(email: string | undefined = OWNER_EMAIL): DwordWriter {
  return new DwordWriter({ repoDir: () => repoDir, userEmail: () => email });
}

async function seedOwner(): Promise<string> {
  await truncateSystem('dword');
  const result = await withAdmin(systemDbUrl('dword'), (c) => c.query<{ id: string }>('INSERT INTO users (email) VALUES ($1) RETURNING id', [OWNER_EMAIL]));
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('seeding the dword owner row failed');
  return id;
}

describeWithRepo('dword', 'DwordWriter against the dword schema rebuilt from its migrations', () => {
  beforeAll(() => {
    repoDir = mkdtempSync(path.join(tmpdir(), 'mcp-notes-dword-writer-'));
    writeFileSync(path.join(repoDir, '.env.local'), `DATABASE_URL_UNPOOLED=${systemDbUrl('dword')}\n`);
  });

  afterAll(() => {
    rmSync(repoDir, { recursive: true, force: true });
    cleanupHarness();
  });

  it('inserts a vocab entry with examples and no origin', async () => {
    await seedOwner();
    const row = await writer().insertVocabEntry({
      term: 'genteel',
      partOfSpeech: 'adjective',
      pronunciation: '/dʒɛnˈtiːl/',
      definition: 'polite and refined, straining to seem upper class',
      examples: ['Her genteel manners impressed the household.', 'He kept a genteel appearance.', 'The village had a genteel charm.'],
    });
    expect(row?.term).toBe('genteel');
    expect(row?.originTerm).toBeNull();
    expect(row?.examples).toHaveLength(3);
  });

  it('returns null on a case-insensitive duplicate term instead of failing', async () => {
    const userId = await seedOwner();
    await seedSystem('dword', "INSERT INTO vocab_entries (user_id, term, source, status, enrichment_status) VALUES ($1, 'Genteel', 'manual', 'active', 'ready')", [userId]);
    const row = await writer().insertVocabEntry({
      term: 'genteel',
      partOfSpeech: 'adjective',
      pronunciation: '/dʒɛnˈtiːl/',
      definition: 'polite and refined',
      examples: ['One genteel day.', 'Two genteel ways.', 'Three genteel places.'],
    });
    expect(row).toBeNull();
  });

  it('attaches an origin only when the row has none yet', async () => {
    const userId = await seedOwner();
    const inserted = await withAdmin(systemDbUrl('dword'), (c) =>
      c.query<{ id: string }>("INSERT INTO vocab_entries (user_id, term, source, status, enrichment_status) VALUES ($1, 'smear', 'manual', 'active', 'ready') RETURNING id", [userId]),
    );
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('seed insert returned no row');

    const first = await writer().attachVocabOrigin(id, { originTerm: 'smear', originLanguage: 'English', originContext: 'The paint began to smear in the rain.' });
    expect(first).toBe(true);

    const second = await writer().attachVocabOrigin(id, { originTerm: 'smear', originLanguage: 'English', originContext: 'a different sentence' });
    expect(second).toBe(false);

    const stored = await withAdmin(systemDbUrl('dword'), (c) => c.query<{ origin_context: string }>('SELECT origin_context FROM vocab_entries WHERE id = $1', [id]));
    expect(stored.rows[0]?.origin_context).toBe('The paint began to smear in the rain.');
  });

  it('inserts a journal entry with its insight, ready to read', async () => {
    await seedOwner();
    const row = await writer().insertJournalEntry({
      text: 'Measure twice, cut once.',
      sourceNote: null,
      insight: { meaning: 'Plan carefully before acting to avoid costly mistakes.', whenItApplies: ['Before a big decision', 'When a mistake is expensive to undo'] },
    });
    expect(row.text).toBe('Measure twice, cut once.');
    expect(row.insightStatus).toBe('ready');
    expect(row.insight?.meaning).toContain('Plan carefully');
  });

  it('inserts a journal embedding only when called, and it never blocks the entry insert', async () => {
    await seedOwner();
    const entry = await writer().insertJournalEntry({
      text: 'A stitch in time saves nine.',
      sourceNote: null,
      insight: { meaning: 'Fixing a small problem now prevents a bigger one later.', whenItApplies: ['A small issue is noticed early'] },
    });
    // No embedding call made yet: the row exists with no embeddings row, same as dword's own "not tried" state.
    const before = await withAdmin(systemDbUrl('dword'), (c) => c.query('SELECT 1 FROM journal_entry_embeddings WHERE entry_id = $1', [entry.id]));
    expect(before.rowCount).toBe(0);

    await writer().insertJournalEmbedding({
      entryId: entry.id,
      textSha: 'a'.repeat(64),
      normSha: 'b'.repeat(64),
      model: 'text-embedding-3-small',
      embedding: new Array(1536).fill(0.01),
    });
    const after = await withAdmin(systemDbUrl('dword'), (c) => c.query<{ status: string; model: string }>('SELECT status, model FROM journal_entry_embeddings WHERE entry_id = $1', [entry.id]));
    expect(after.rows[0]?.status).toBe('ready');
    expect(after.rows[0]?.model).toBe('text-embedding-3-small');
  });

  it('refuses to write when the configured email has no dword user', async () => {
    await seedOwner();
    await expect(
      writer('nobody@example.com').insertJournalEntry({ text: 'x', sourceNote: null, insight: { meaning: 'y'.repeat(20), whenItApplies: ['a'.repeat(8), 'b'.repeat(8)] } }),
    ).rejects.toThrow();
  });
});
