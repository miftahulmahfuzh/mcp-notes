import { describe, expect, it } from 'vitest';
import {
  attemptKey,
  decisionKey,
  draftKey,
  planWork,
  reviewableOriginals,
  toDecisions,
  toPreviewDecisions,
  type DraftRef,
  type PlanInput,
} from '../../../src/adversary/plan.js';
import type { CandidateRow, Decision, PreviewRow, RosterRow } from '../../../src/adversary/types.js';

const NOW = new Date('2031-01-10T00:00:00Z');

function row(id: string, extra: Partial<RosterRow> = {}): RosterRow {
  return {
    id,
    name: id,
    sub: 'test',
    engine: 'book',
    rulesId: null,
    objectName: null,
    gateNote: null,
    promotedFrom: null,
    status: 'active',
    twinOf: null,
    isBenchmark: false,
    ...extra,
  };
}

function candidates(strategyId: string, sessionDate: string, kind: 'bracket' | 'book', symbols: string[]): CandidateRow[] {
  return symbols.map((symbol, i) => ({
    strategyId,
    sessionDate,
    dataDate: '2031-01-09',
    kind,
    rank: i + 1,
    symbol,
    weight: kind === 'book' ? 1 / symbols.length : null,
    evidence: null,
  }));
}

function input(decisions: Decision[], extra: Partial<PlanInput> = {}): PlanInput {
  const ids = new Set(decisions.map((d) => d.strategyId));
  return {
    decisions,
    previews: [],
    promptVersions: new Map([...ids].map((id) => [id, 'adv-v1-aaaaaaaaaaaa'])),
    verdicts: new Map(),
    drafts: new Map(),
    failures: new Map(),
    skippedToday: new Set(),
    used: 0,
    cap: 15,
    rereview: false,
    ...extra,
  };
}

const summarize = (actions: ReturnType<typeof planWork>): string[] =>
  actions.map((a) => `${a.type}:${a.decision.strategyId}:${a.pick.symbol}`);

describe('reviewableOriginals', () => {
  it('keeps active non-benchmark originals with an active twin, read from the roster', () => {
    const roster = [
      row('SPY-GT', { engine: 'benchmark', isBenchmark: true }),
      row('C-GT', { engine: 'bracket' }),
      row('A-GT', { engine: 'bracket' }),
      row('A-GT-CX', { engine: 'bracket', twinOf: 'A-GT' }),
      row('RAW', { status: 'active' }),
      row('RAW-CX', { twinOf: 'RAW', status: 'retired' }),
      row('OLD', { status: 'retired' }),
      row('OLD-CX', { twinOf: 'OLD' }),
    ];
    expect(reviewableOriginals(roster).map((r) => r.id)).toEqual(['A-GT']);
  });
});

describe('toDecisions / toPreviewDecisions', () => {
  it('drops a decision whose session already opened and sorts picks by rank', () => {
    const rows = [...candidates('A', '2031-01-14', 'bracket', ['X', 'Y']).reverse(), ...candidates('B', '2031-01-09', 'book', ['Z'])];
    const decisions = toDecisions(rows, NOW);
    expect(decisions.map((d) => d.strategyId)).toEqual(['A']);
    expect(decisions[0]?.picks.map((p) => p.symbol)).toEqual(['X', 'Y']);
    expect(decisions[0]?.openUtc.toISOString()).toBe('2031-01-14T14:30:00.000Z');
  });

  it('drafts a preview only when its targets are not written yet and it opens within a week', () => {
    const preview = (strategyId: string, next: string): PreviewRow => ({ strategyId, dataDate: '2031-01-09', rank: 1, symbol: 'P', weight: 1, nextDecisionSession: next });
    const decided = new Set([decisionKey('DONE', '2031-01-13')]);
    const drafts = toPreviewDecisions([preview('SOON', '2031-01-13'), preview('DONE', '2031-01-13'), preview('FAR', '2031-02-03')], decided, NOW);
    expect(drafts.map((d) => [d.strategyId, d.stage, d.kind])).toEqual([['SOON', 'draft', 'book']]);
  });
});

describe('planWork', () => {
  const bracket = toDecisions(candidates('A', '2031-01-14', 'bracket', ['A1', 'A2']), NOW);
  const bookEarly = toDecisions(candidates('K', '2031-01-13', 'book', ['K1', 'K2']), NOW);
  const draft = toPreviewDecisions(
    [{ strategyId: 'K', dataDate: '2031-01-09', rank: 1, symbol: 'D1', weight: 1, nextDecisionSession: '2031-01-15' }],
    new Set(),
    NOW,
  );

  it('reviews bracket picks first, then books by earliest open, previews last, and skips the rest over the cap', () => {
    const actions = planWork(input([...bookEarly, ...bracket], { previews: draft, cap: 3 }));
    expect(summarize(actions)).toEqual(['review:A:A1', 'review:A:A2', 'review:K:K1', 'skip_budget:K:K2']);
  });

  it('spends leftover budget on previews and never logs a skipped preview', () => {
    expect(summarize(planWork(input([], { previews: draft, cap: 1, promptVersions: new Map([['K', 'pv']]) })))).toEqual(['review:K:D1']);
    expect(summarize(planWork(input([], { previews: draft, cap: 1, used: 1, promptVersions: new Map([['K', 'pv']]) })))).toEqual([]);
  });

  it('skips symbols that already have a verdict, unless re-reviewing, which supersedes it', () => {
    const verdicts = new Map([[decisionKey('A', '2031-01-14'), new Map([['A1', 41]])]]);
    expect(summarize(planWork(input(bracket, { verdicts })))).toEqual(['review:A:A2']);
    const again = planWork(input(bracket, { verdicts, rereview: true }));
    expect(again.map((a) => (a.type === 'review' ? a.supersedes : 'x'))).toEqual([41, null]);
  });

  it('reuses a recent draft with the same prompt version at no budget cost', () => {
    const ref: DraftRef = {
      id: 7,
      startedAt: NOW,
      verdict: { verdict: 'agree', reason: 'ok', sources: [], lens: 'L@1', seer_verdict_id: null, downgraded: false },
      gatherModel: 'g',
      verdictModel: 'v',
    };
    const drafts = new Map([[draftKey('A', '2031-01-14', 'A1', 'adv-v1-aaaaaaaaaaaa'), ref]]);
    expect(summarize(planWork(input(bracket, { drafts, cap: 1 })))).toEqual(['reuse:A:A1', 'review:A:A2']);
    const otherVersion = new Map([[draftKey('A', '2031-01-14', 'A1', 'adv-v1-bbbbbbbbbbbb'), ref]]);
    expect(summarize(planWork(input(bracket, { drafts: otherVersion, cap: 1 })))).toEqual(['review:A:A1', 'skip_budget:A:A2']);
  });

  it('writes a skipped_budget row once a day and stops retrying a pick that failed twice', () => {
    const skippedToday = new Set([attemptKey('A', '2031-01-14', 'A2', 'final')]);
    expect(summarize(planWork(input(bracket, { cap: 1, skippedToday })))).toEqual(['review:A:A1']);
    const failures = new Map([[attemptKey('A', '2031-01-14', 'A1', 'final'), 2]]);
    expect(summarize(planWork(input(bracket, { failures })))).toEqual(['review:A:A2']);
  });

  it('narrows a manual pass to one strategy and session', () => {
    expect(summarize(planWork(input([...bracket, ...bookEarly], { only: { strategyId: 'K' } })))).toEqual(['review:K:K1', 'review:K:K2']);
    expect(summarize(planWork(input([...bracket, ...bookEarly], { only: { sessionDate: '2031-01-14' } })))).toEqual(['review:A:A1', 'review:A:A2']);
  });

  it('leaves out a strategy without a prompt version (its lens could not be built)', () => {
    expect(planWork(input(bracket, { promptVersions: new Map() }))).toEqual([]);
  });
});
