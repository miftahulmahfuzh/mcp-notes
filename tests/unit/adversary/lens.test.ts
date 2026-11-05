import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildLens, lensText, readBrief } from '../../../src/adversary/lens.js';
import { promptVersion } from '../../../src/adversary/prompt.js';
import type { RosterRow } from '../../../src/adversary/types.js';

const RAW35: RosterRow = {
  id: 'RAW35-FR-GT',
  name: 'RAW35 · Unbraked momentum',
  sub: 'Top 35 by rise beyond the market, monthly',
  engine: 'book',
  rulesId: 'monthly-hold-frac-gotrade',
  objectName: 'RESIDMOM35',
  gateNote: 'Lab M0139 dev window only',
  promotedFrom: 'M0139',
  status: 'active',
  twinOf: null,
  isBenchmark: false,
};
const LAB = { id: 'M0139', name: 'Residual momentum, 35 names', family: 'momentum', hypothesis: 'Stocks that rose beyond the market keep doing so for a month.' };

const dir = mkdtempSync(path.join(tmpdir(), 'mcp-notes-briefs-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the lens', () => {
  it('is built from the roster row, the lab hypothesis and the owner brief', () => {
    const text = lensText(RAW35, LAB, 'Object to one-off jumps.');
    expect(text).toContain('Method: RAW35 · Unbraked momentum (RAW35-FR-GT)');
    expect(text).toContain('Top 35 by rise beyond the market');
    expect(text).toContain('A basket held until the next rebalance');
    expect(text).toContain('Lab M0139 dev window only');
    expect(text).toContain('Stocks that rose beyond the market keep doing so');
    expect(text).toContain('Object to one-off jumps.');
  });

  it('is identified as object_name@hash, and any change moves the hash and the prompt version', () => {
    const a = buildLens(RAW35, LAB, 'brief one');
    const b = buildLens(RAW35, LAB, 'brief two');
    expect(a.id).toMatch(/^RESIDMOM35@[0-9a-f]{8}$/);
    expect(a.id).not.toBe(b.id);
    const pv = promptVersion(a, 'sonnet', 'opus');
    expect(pv).toMatch(/^adv-v1-[0-9a-f]{12}$/);
    expect(promptVersion(buildLens(RAW35, LAB, 'brief one'), 'sonnet', 'opus')).toBe(pv);
    expect(promptVersion(b, 'sonnet', 'opus')).not.toBe(pv);
    expect(promptVersion(a, 'sonnet', 'claude-opus-5-5')).not.toBe(pv);
  });

  it('ships the three owner briefs, keyed by object_name', async () => {
    for (const name of ['STRATEGY_A', 'RESIDMOM35', 'COSKEW']) {
      expect((await readBrief(name))?.length ?? 0).toBeGreaterThan(200);
    }
    expect(await readBrief('NOPE_NOT_A_BRIEF')).toBeNull();
    expect(await readBrief(null)).toBeNull();
  });

  it('never reads outside the briefs directory', async () => {
    writeFileSync(path.join(dir, 'X.md'), 'secret');
    expect(await readBrief('../X', dir)).toBeNull();
    expect(await readBrief('X', dir)).toBe('secret');
  });
});
