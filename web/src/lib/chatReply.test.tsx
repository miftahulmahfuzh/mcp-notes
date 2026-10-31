// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { answerMap, authorOf, messageSelector, resolveReply, snippetOf, threadForReply } from './chatReply';
import { makeMessage } from '../testing/chatFixtures';

describe('chatReply', () => {
  it('snippetOf collapses whitespace and cuts with an ellipsis', () => {
    expect(snippetOf('  a\n\n b  ')).toBe('a b');
    const long = 'x'.repeat(100);
    const s = snippetOf(long);
    expect(s.length).toBe(80);
    expect(s.endsWith('…')).toBe(true);
  });

  it('authorOf names the user "you" and every assistant "claude"', () => {
    expect(authorOf({ role: 'user' })).toBe('you');
    expect(authorOf({ role: 'assistant' })).toBe('claude');
  });

  it('threadForReply: a wall bubble continues its thread, a claude_code bubble starts a new one', () => {
    expect(threadForReply(makeMessage('W001', { source: 'wall', thread_id: 'TW01' }))).toBe('TW01');
    expect(threadForReply(makeMessage('C001', { source: 'claude_code', thread_id: 'TC01' }))).toBeNull();
  });

  it('answerMap pairs each question with the next live assistant row of its thread', () => {
    const q1 = makeMessage('Q001', { created_at: '2026-10-31T01:00:00.000Z' });
    const a1 = makeMessage('A001', { role: 'assistant', created_at: '2026-10-31T01:01:00.000Z' });
    const q2 = makeMessage('Q002', { created_at: '2026-10-31T01:02:00.000Z' });
    const a2 = makeMessage('A002', { role: 'assistant', created_at: '2026-10-31T01:03:00.000Z', deleted_at: '2026-10-31T02:00:00.000Z' });
    const other = makeMessage('Q003', { thread_id: 'TW02', created_at: '2026-10-31T00:59:00.000Z' });
    const m = answerMap([a2, q2, a1, q1, other]);
    expect(m.get('Q001')?.id).toBe('A001');
    expect(m.has('Q002')).toBe(false);
    expect(m.has('Q003')).toBe(false);
  });

  it('resolveReply prefers the loaded target, else the server preview (role null reads "message")', () => {
    const t = makeMessage('A001', { role: 'assistant', text: 'new text', deleted_at: '2026-10-31T02:00:00.000Z' });
    const byId = new Map([[t.id, t]]);
    expect(resolveReply({ id: 'A001', role: 'assistant', text: 'old', deleted: false }, byId)).toEqual({
      id: 'A001',
      author: 'claude',
      snippet: 'new text',
      deleted: true,
    });
    expect(resolveReply({ id: 'Z001', role: null, text: 'far back', deleted: false }, byId)).toEqual({
      id: 'Z001',
      author: 'message',
      snippet: 'far back',
      deleted: false,
    });
    expect(resolveReply({ id: 'Z001', role: 'user', text: 'far back', deleted: false }, byId).author).toBe('you');
  });

  it('messageSelector targets the bubble root', () => {
    expect(messageSelector('K7F2')).toBe('[data-msg="K7F2"]');
  });
});
