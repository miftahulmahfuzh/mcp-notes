import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_ADVERSARY_CONFIG } from '../../../src/config.js';
import { AdversaryService } from '../../../src/adversary/service.js';
import type { SeerReader } from '../../../src/adversary/seerReader.js';
import type { SeerWriter } from '../../../src/adversary/seerWriter.js';
import type { CandidateRow, RosterRow } from '../../../src/adversary/types.js';
import type { Db } from '../../../src/db/client.js';
import { fakeReviewer } from '../../helpers/fakeReviewer.js';

const roster: RosterRow[] = [
  { id: 'A-GT', name: 'Dip buy', sub: 'buys dips', engine: 'bracket', rulesId: null, objectName: null, gateNote: null, promotedFrom: null, status: 'active', twinOf: null, isBenchmark: false },
  { id: 'A-GT-CX', name: 'Dip buy twin', sub: '', engine: 'bracket', rulesId: null, objectName: null, gateNote: null, promotedFrom: null, status: 'active', twinOf: 'A-GT', isBenchmark: false },
];
const candidates: CandidateRow[] = [{ strategyId: 'A-GT', sessionDate: '2026-11-05', dataDate: '2026-11-04', kind: 'bracket', rank: 1, symbol: 'SLB', weight: null, evidence: null }];

function build(nowIso: string) {
  const seer = {
    schemaReady: async () => true,
    roster: async () => roster,
    candidates: async () => candidates,
    verdictsFrom: async () => [{ id: 7, strategyId: 'A-GT', sessionDate: '2026-11-05', symbol: 'SLB', verdict: 'unsure', decidedAt: '2026-11-05T01:00:00.000Z' }],
    labMethod: async () => null,
    heldSymbols: async () => [],
  } as unknown as SeerReader;
  const writer = {
    claimLease: vi.fn(async () => true),
    releaseLease: vi.fn(async () => undefined),
    insertVerdict: vi.fn(async (_verdict: unknown, _supersedes: number | null) => ({ id: 99, decidedAt: nowIso })),
  };
  const inserted: unknown[] = [];
  const db = { insert: () => ({ values: (v: unknown) => ({ returning: async () => (inserted.push(v), [{ id: 1 }]) }) }) } as unknown as Db;
  const service = new AdversaryService({
    config: DEFAULT_ADVERSARY_CONFIG,
    db,
    host: 'test-host',
    reviewer: fakeReviewer(),
    seer,
    writer: writer as unknown as SeerWriter,
    now: () => new Date(nowIso),
    log: () => undefined,
    briefsDir: '/nonexistent',
  });
  return { service, writer, inserted };
}

const req = { strategy: 'A', symbol: 'slb' };
const submission = { verdict: 'agree' as const, reason: 'Earnings were fine.', sources: [{ url: 'https://news.test/slb' }] };

describe('redoContext', () => {
  it('gives the facts and rules before the open (21:30 WIB = 14:30Z)', async () => {
    const { service } = build('2026-11-05T10:00:00Z');
    const r = await service.redoContext(req);
    expect(r).toMatchObject({ ok: true, can_redo: true, strategy_id: 'A-GT', symbol: 'SLB', existing_verdict: { id: 7, verdict: 'unsure' } });
    if (r.ok) {
      expect(r.clock.open_wib).toBe('2026-11-05 21:30');
      expect(r.facts).toContain('Stock under review: SLB');
      expect(r.rules).toContain('WebFetch');
    }
  });

  it('stops with a plain explanation and no facts once the session opened', async () => {
    const r = await build('2026-11-05T15:00:00Z').service.redoContext(req);
    expect(r).toMatchObject({ ok: true, can_redo: false });
    if (r.ok) {
      expect(r.message).toMatch(/Too late.*21:30 WIB/);
      expect(r.facts).toBeUndefined();
    }
  });

  it('says too tight inside the start margin', async () => {
    const r = await build('2026-11-05T14:25:00Z').service.redoContext(req);
    expect(r).toMatchObject({ ok: true, can_redo: false, clock: { state: 'closing' } });
  });

  it('refuses a stock that is not a pick and an unknown method', async () => {
    const { service } = build('2026-11-05T10:00:00Z');
    expect(await service.redoContext({ strategy: 'A', symbol: 'ZZZ' })).toMatchObject({ ok: false, code: 'not_a_pick' });
    expect(await service.redoContext({ strategy: 'Q', symbol: 'SLB' })).toMatchObject({ ok: false, code: 'unknown_method' });
  });
});

describe('redoSubmit', () => {
  it('writes the verdict, supersedes the old one and logs the review', async () => {
    const { service, writer, inserted } = build('2026-11-05T10:00:00Z');
    const r = await service.redoSubmit({ ...req, ...submission, model: 'claude-sonnet-5-5' });
    expect(r).toMatchObject({ ok: true, written: true, verdict_id: 99, late: false, replaced: { id: 7, verdict: 'unsure' } });
    expect(writer.insertVerdict).toHaveBeenCalledTimes(1);
    expect(writer.insertVerdict.mock.calls[0]?.[1]).toBe(7);
    expect(inserted[0]).toMatchObject({ status: 'ok', stage: 'final', symbol: 'SLB', verdictModel: 'claude-sonnet-5-5' });
    expect(writer.releaseLease).toHaveBeenCalled();
  });

  it('writes nothing after the open, even when the caller started in time', async () => {
    const { service, writer } = build('2026-11-05T14:31:00Z');
    expect(await service.redoSubmit({ ...req, ...submission })).toMatchObject({ ok: false, code: 'too_late' });
    expect(writer.claimLease).not.toHaveBeenCalled();
    expect(writer.insertVerdict).not.toHaveBeenCalled();
  });

  it('downgrades an uncited agree to unsure, and reports a lease held elsewhere', async () => {
    const a = build('2026-11-05T10:00:00Z');
    expect(await a.service.redoSubmit({ ...req, verdict: 'object', reason: 'x', sources: [] })).toMatchObject({ ok: true, verdict: 'unsure', downgraded: true });
    const b = build('2026-11-05T10:00:00Z');
    b.writer.claimLease.mockResolvedValueOnce(false);
    expect(await b.service.redoSubmit({ ...req, ...submission })).toMatchObject({ ok: false, code: 'leased' });
    expect(b.writer.insertVerdict).not.toHaveBeenCalled();
  });
});
