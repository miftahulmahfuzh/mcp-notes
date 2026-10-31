import { describe, expect, it } from 'vitest';
import { makeMessage } from '../testing/chatFixtures';
import { historyCountLine, mergeMessages, pruneLocal, sortMessages, threadForSend, timelineOf, type LocalBubble } from './timeline';

const at = (min: number) => new Date(Date.UTC(2026, 9, 31, 1, min)).toISOString();

const local = (over: Partial<LocalBubble>): LocalBubble => ({
  key: 'local-1-u',
  role: 'user',
  serverId: null,
  threadId: null,
  text: 'hi',
  createdAt: at(30),
  attachments: [],
  streaming: false,
  status: '',
  brain: null,
  error: null,
  ...over,
});

describe('timeline', () => {
  it('sorts ascending, question before answer at the same instant', () => {
    const a = makeMessage('AAA1', { role: 'assistant', created_at: at(1) });
    const u = makeMessage('ZZZ1', { role: 'user', created_at: at(1) });
    const old = makeMessage('BBB1', { created_at: at(0) });
    expect(sortMessages([a, u, old]).map((m) => m.id)).toEqual(['BBB1', 'ZZZ1', 'AAA1']);
  });

  it('a latest page replaces its window: missing newer rows were deleted, older rows stay', () => {
    const old = makeMessage('OLD1', { created_at: at(0) });
    const gone = makeMessage('GONE', { created_at: at(5) });
    const kept = makeMessage('KEPT', { created_at: at(4), text: 'v1' });
    const fresh = { ...kept, text: 'v2' };
    const merged = mergeMessages([old, kept, gone], [fresh], Date.parse(at(4)));
    expect(merged.map((m) => [m.id, m.text])).toEqual([
      ['OLD1', 'message OLD1'],
      ['KEPT', 'v2'],
    ]);
  });

  it('an older page only adds; -Infinity means the page is everything', () => {
    const a = makeMessage('A001', { created_at: at(3) });
    const b = makeMessage('B001', { created_at: at(1) });
    expect(mergeMessages([a], [b], null).map((m) => m.id)).toEqual(['B001', 'A001']);
    expect(mergeMessages([a], [], Number.NEGATIVE_INFINITY)).toEqual([]);
  });

  it('hides a local bubble once the server holds its id, and prunes it', () => {
    const server = [makeMessage('U001')];
    const l = local({ serverId: 'U001' });
    const pending = local({ key: 'local-1-a', role: 'assistant', streaming: true });
    expect(timelineOf(server, [l, pending]).map((i) => i.key)).toEqual(['U001', 'local-1-a']);
    expect(pruneLocal([l, pending], server)).toEqual([pending]);
  });

  it('thread rule: the newest wall message continues its thread, claude code starts a new one', () => {
    const wall = makeMessage('W001', { thread_id: 'T1', created_at: at(1) });
    const cc = makeMessage('C001', { thread_id: 'T9', source: 'claude_code', created_at: at(2) });
    expect(threadForSend(timelineOf([wall], []))).toBe('T1');
    expect(threadForSend(timelineOf([wall, cc], []))).toBeUndefined();
    expect(threadForSend([])).toBeUndefined();
  });

  it('thread rule skips error bubbles and deleted messages', () => {
    const wall = makeMessage('W001', { thread_id: 'T1', created_at: at(1) });
    const del = makeMessage('C001', { source: 'claude_code', deleted_at: at(3), created_at: at(2) });
    const err = local({ key: 'local-2-a', role: 'assistant', error: 'Chat failed: boom' });
    expect(threadForSend(timelineOf([wall, del], [err]))).toBe('T1');
  });

  it('count line', () => {
    const items = timelineOf([makeMessage('A001'), makeMessage('B001', { thread_id: 'T2' })], []);
    expect(historyCountLine(items, false)).toBe('2 messages in 2 threads.');
    expect(historyCountLine(items, true)).toBe('Latest 2 messages in 2 threads.');
  });
});

describe('historyCountLine (phase 10)', () => {
  it('does not count deleted rows', () => {
    const items = timelineOf(
      [makeMessage('A001'), makeMessage('A002', { deleted_at: '2026-10-31T02:00:00.000Z' })],
      [],
    );
    expect(historyCountLine(items, false)).toBe('1 messages in 1 threads.');
  });
});
