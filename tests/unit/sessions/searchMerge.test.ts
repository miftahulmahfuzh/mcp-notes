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
