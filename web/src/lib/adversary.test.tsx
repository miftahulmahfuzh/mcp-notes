import { describe, expect, it } from 'vitest';
import { OVERVIEW, METHOD_BOOK, METHOD_DAILY } from '../testing/adversaryFixtures';
import {
  adversaryChatMessage,
  adversaryCountLine,
  adversaryHeading,
  causeTiles,
  checkValue,
  coverageLabel,
  decisionSummary,
  disagreement,
  methodHeading,
  overviewCountLine,
  paperMonth,
  pct,
  pts,
  ratio,
  rosterNames,
  shortDate,
  usd,
} from './adversary';

const NOW = new Date('2026-11-05T03:00:00Z');

describe('adversary formatting', () => {
  it('signs numbers with a real minus', () => {
    expect(pct(0.054)).toBe('+5.4%');
    expect(pct(-0.01)).toBe('−1.0%');
    expect(pct(0)).toBe('0.0%');
    expect(pct(null)).toBe('—');
    expect(pts(-1.9)).toBe('−1.9 pts');
    expect(usd(38.2)).toBe('+$38.20');
  });

  it('formats calendar dates without a time zone shift', () => {
    expect(shortDate('2026-11-04')).toBe('Nov 4');
    expect(shortDate('2026-01-31')).toBe('Jan 31');
  });

  it('labels coverage per engine', () => {
    // Phase 5's Coverage: decisions, reviewed, absent, late, paused, pending.
    const cov = (reviewed: number, absent: number, paused: number, pending = 0) => ({ decisions: reviewed + absent + paused + pending, reviewed, absent, late: 0, paused, pending });
    expect(coverageLabel(cov(78, 17, 5), 'bracket', 'daily')).toBe('78% · 17% · 5%');
    expect(coverageLabel(cov(7, 0, 0), 'book', 'monthly')).toBe('7 of 7 rebalances');
    expect(coverageLabel(cov(6, 0, 1), 'book', 'monthly')).toBe('6 of 7 rebalances · 1 paused');
    expect(coverageLabel(cov(3, 0, 0), 'book', 'quarterly')).toBe('3 of 3 re-picks');
    expect(coverageLabel(cov(0, 0, 0), 'book', 'monthly')).toBe('no decisions yet');
    expect(coverageLabel(cov(0, 0, 0, 1), 'book', 'monthly')).toBe('1 pending');
    expect(coverageLabel(cov(7, 0, 0, 1), 'book', 'monthly')).toBe('7 of 7 rebalances · 1 pending');
  });

  it("renders phase 5's profit factor, including no losing trade", () => {
    expect(ratio(2.04)).toBe('2.04');
    expect(ratio('infinite')).toBe('∞');
    expect(ratio(null)).toBe('n/a');
  });

  it('heads a method page with its code, or its plain name when the code is one or two letters', () => {
    expect(methodHeading('RAW35 · Momentum')).toBe('RAW35.');
    expect(methodHeading('A · Dip buy')).toBe('Dip buy.');
    expect(methodHeading('SOLO')).toBe('SOLO.');
  });

  it('counts paper months from the earliest twin start', () => {
    expect(paperMonth('2026-10-20', NOW)).toBe(1);
    expect(paperMonth('2026-05-05', NOW)).toBe(7);
    expect(paperMonth(null, NOW)).toBeNull();
  });

  it('writes the overview count line from the payload', () => {
    expect(overviewCountLine(OVERVIEW, null, NOW)).toBe(
      "3 methods on Seer's roster, each with a Claude twin that drops the picks Claude objects to. Month 1 of 18. Last review: RAW35's 35 picks for Nov 2, on Nov 1.",
    );
    expect(overviewCountLine(null, 'seer_unavailable', NOW)).toContain("can't be reached");
    expect(overviewCountLine(null, null, NOW)).toBe('Loading Seer Adversarial.');
  });

  it('heads and counts each sub-page', () => {
    const s = { overview: OVERVIEW, overviewError: null, method: METHOD_BOOK, methodError: null };
    expect(adversaryHeading(s, null)).toBe('Adversary.');
    expect(adversaryHeading(s, 'RAW35-FR-GT')).toBe('RAW35.');
    expect(adversaryHeading(s, 'A-GT')).toBe('Dip buy.');
    expect(adversaryHeading(s, 'NOPE')).toBe('Adversary.');
    expect(adversaryCountLine(s, 'RAW35-FR-GT', NOW)).toBe(
      'The 35 stocks that rose most beyond the market, re-picked each month. Nov 2 decision: 4 picks, 1 objection, 1 can\'t tell.',
    );
    expect(adversaryCountLine({ ...s, methodError: 'not_found' }, 'NOPE', NOW)).toBe("No method NOPE on Seer's roster.");
    expect(decisionSummary(null)).toBe('No verdicts yet.');
  });

  it('builds the cause tiles from ids, naming methods from the roster', () => {
    const tiles = causeTiles({ ...OVERVIEW.cause, twins_beat_spy: ['A-GT', 'RAW35-FR-GT'], originals_beat_spy: ['RAW35-FR-GT'] }, rosterNames(OVERVIEW.roster));
    expect(tiles.map((t) => t.value)).toEqual(['2 of 3 twins', '+$38.20', '−1.9 pts']);
    expect(tiles[0]?.text).toBe("A's and RAW35's twins are ahead of SPY. Of the originals, RAW35 is.");
  });

  it('writes checklist cells', () => {
    const [r1, r2, , , r5] = METHOD_BOOK.checklist.twin;
    expect(checkValue(r1!)).toBe('7.0 of 18 mo');
    expect(checkValue(r2!)).toBe('+3.6 pts · pass');
    expect(checkValue(r5!)).toBe("can't be run");
    expect(checkValue(METHOD_BOOK.checklist.original[4]!)).toBe('failed');
  });

  it('sorts the disagreement grid', () => {
    expect(disagreement(METHOD_DAILY.three_way!.rows)).toEqual({ bothBlock: ['ZBRA'], claudeOnly: ['SLB'], criticOnly: ['HPQ'], bothKeep: ['PANW'] });
  });

  it('names the page on the chat message first line', () => {
    expect(adversaryChatMessage('why ZBRA?', null)).toBe('[Seer Adversarial · overview]\nwhy ZBRA?');
    expect(adversaryChatMessage('why?', 'A-GT')).toBe('[Seer Adversarial · A-GT]\nwhy?');
  });
});
