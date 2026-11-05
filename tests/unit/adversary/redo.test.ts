import { describe, expect, it } from 'vitest';
import { REDO_START_MARGIN_MS, checkSubmitted, decisionsOf, pickDecision, redoClock, resolveOriginal } from '../../../src/adversary/redo.js';
import { sessionOpenUtc } from '../../../src/adversary/sessions.js';
import type { CandidateRow, RosterRow } from '../../../src/adversary/types.js';

const row = (id: string): RosterRow => ({
  id,
  name: id,
  sub: '',
  engine: 'bracket',
  rulesId: null,
  objectName: null,
  gateNote: null,
  promotedFrom: null,
  status: 'active',
  twinOf: null,
  isBenchmark: false,
});

const cand = (sessionDate: string, symbol: string, rank: number, strategyId = 'A-GT'): CandidateRow => ({
  strategyId,
  sessionDate,
  dataDate: sessionDate,
  kind: 'bracket',
  rank,
  symbol,
  weight: null,
  evidence: null,
});

describe('redoClock', () => {
  // 2026-11-05 is US winter: the open is 14:30Z = 21:30 WIB.
  const open = sessionOpenUtc('2026-11-05');

  it('is fresh well before the open and prints WIB times', () => {
    const c = redoClock(open, new Date('2026-11-05T10:00:00Z'));
    expect(c.state).toBe('fresh');
    expect(c.open_wib).toBe('2026-11-05 21:30');
    expect(c.start_by_wib).toBe('2026-11-05 21:20');
    expect(c.minutes_to_open).toBe(270);
  });

  it('is closing inside the start margin, closed at and after the open', () => {
    expect(redoClock(open, new Date(open.getTime() - REDO_START_MARGIN_MS + 1)).state).toBe('closing');
    expect(redoClock(open, new Date(open.getTime() - REDO_START_MARGIN_MS)).state).toBe('closing');
    expect(redoClock(open, new Date(open.getTime() - REDO_START_MARGIN_MS - 1)).state).toBe('fresh');
    const closed = redoClock(open, open);
    expect(closed.state).toBe('closed');
    expect(closed.minutes_to_open).toBe(0);
  });

  it('uses the summer open in July (20:30 WIB)', () => {
    expect(redoClock(sessionOpenUtc('2026-07-01'), new Date('2026-07-01T00:00:00Z')).open_wib).toBe('2026-07-01 20:30');
  });
});

describe('resolveOriginal', () => {
  const originals = [row('A-GT'), row('RAW35-FR-GT'), row('B-GT'), row('B-XX')];

  it('matches an exact id in any case, a twin id, and a unique short form', () => {
    expect(resolveOriginal(originals, 'a-gt')).toMatchObject({ kind: 'ok', row: { id: 'A-GT' } });
    expect(resolveOriginal(originals, 'A-GT-CX')).toMatchObject({ kind: 'ok', row: { id: 'A-GT' } });
    expect(resolveOriginal(originals, 'A')).toMatchObject({ kind: 'ok', row: { id: 'A-GT' } });
  });

  it('reports an ambiguous short form and an unknown one', () => {
    expect(resolveOriginal(originals, 'B')).toEqual({ kind: 'ambiguous', ids: ['B-GT', 'B-XX'] });
    expect(resolveOriginal(originals, 'Z')).toEqual({ kind: 'none' });
    expect(resolveOriginal(originals, '  ')).toEqual({ kind: 'none' });
  });
});

describe('pickDecision', () => {
  const decisions = decisionsOf(
    [cand('2026-11-04', 'SLB', 1), cand('2026-11-05', 'XOM', 1), cand('2026-11-05', 'SLB', 2), cand('2026-11-05', 'OXY', 1, 'OTHER')],
    'A-GT',
  );

  it('groups only the strategy, sessions ascending, picks by rank', () => {
    expect(decisions.map((d) => d.sessionDate)).toEqual(['2026-11-04', '2026-11-05']);
    expect(decisions[1]?.picks.map((p) => p.symbol)).toEqual(['XOM', 'SLB']);
  });

  it('prefers the earliest session that has not opened', () => {
    const got = pickDecision(decisions, 'slb', new Date('2026-11-04T20:00:00Z'));
    expect(got?.decision.sessionDate).toBe('2026-11-05');
  });

  it('falls back to the newest opened session so the caller can say it is too late', () => {
    const got = pickDecision(decisions, 'SLB', new Date('2026-11-06T20:00:00Z'));
    expect(got?.decision.sessionDate).toBe('2026-11-05');
  });

  it('honours an explicit session and returns null for a stock that is not a pick', () => {
    expect(pickDecision(decisions, 'SLB', new Date('2026-11-01T00:00:00Z'), '2026-11-04')?.decision.sessionDate).toBe('2026-11-04');
    expect(pickDecision(decisions, 'OXY', new Date('2026-11-01T00:00:00Z'))).toBeNull();
  });
});

describe('checkSubmitted', () => {
  const at = new Date('2026-11-05T10:00:00Z');

  it('stamps fetched_at with the server clock and de-duplicates sources', () => {
    const v = checkSubmitted(
      { verdict: 'agree', reason: ' fine ', sources: [{ url: 'https://a.test/x', published_at: '2026-10-23' }, { url: 'https://a.test/x' }] },
      at,
    );
    expect(v.reason).toBe('fine');
    expect(v.sources).toEqual([{ url: 'https://a.test/x', title: null, publisher: null, published_at: '2026-10-23T00:00:00.000Z', fetched_at: at.toISOString() }]);
    expect(v.downgraded).toBe(false);
  });

  it('turns agree/object with no source into unsure, never unsure into anything else', () => {
    expect(checkSubmitted({ verdict: 'object', reason: 'x', sources: [] }, at)).toMatchObject({ verdict: 'unsure', downgraded: true });
    expect(checkSubmitted({ verdict: 'unsure', reason: 'x', sources: [] }, at)).toMatchObject({ verdict: 'unsure', downgraded: false });
  });

  it('rejects an empty or over-long reason and a non-http url', () => {
    expect(() => checkSubmitted({ verdict: 'unsure', reason: '  ', sources: [] }, at)).toThrow(/empty/);
    expect(() => checkSubmitted({ verdict: 'unsure', reason: 'x'.repeat(601), sources: [] }, at)).toThrow(/600/);
    expect(() => checkSubmitted({ verdict: 'agree', reason: 'x', sources: [{ url: 'file:///etc/passwd' }] }, at)).toThrow(/http/);
  });
});
