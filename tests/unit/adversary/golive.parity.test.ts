import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as gl from '../../../src/adversary/golive.js';
import { connectorSettings, resolveRepoDir } from '../../../src/connectors/env.js';

/**
 * The go-live numbers are Seer's: when Seer moves one, this fails instead of the wall judging at a
 * bar Seer abandoned (Seer once shipped CHECKS = 6 against a five-rule list; web/lib/metrics.ts
 * CHECKLIST_RULES explains it). Reads the Seer checkout at SEER_DIR (default ~/seer); skips without one.
 */
const seer = resolveRepoDir('seer', connectorSettings({ envFile: false }));
const goliveFile = path.join(seer, 'web', 'lib', 'golive.ts');
const metricsFile = path.join(seer, 'web', 'lib', 'metrics.ts');
const present = existsSync(goliveFile) && existsSync(metricsFile);
const metrics = present ? readFileSync(metricsFile, 'utf8') : '';

describe.skipIf(!present)(`go-live parity with Seer web (${seer})`, () => {
  it('MAX_DRAWDOWN and MIN_PAPER_MONTHS', () => {
    const golive = readFileSync(goliveFile, 'utf8');
    expect(golive).toContain(`export const MAX_DRAWDOWN = ${gl.MAX_DRAWDOWN};`);
    expect(golive).toContain(`export const MIN_PAPER_MONTHS = ${gl.MIN_PAPER_MONTHS};`);
  });

  it('the profit-factor bar, the rule count and rule 5 wording', () => {
    expect(metrics).toContain(`'Profit factor ≥ ${gl.MIN_PROFIT_FACTOR}'`);
    expect(metrics).toContain(`(m.profitFactor ?? 0) >= ${gl.MIN_PROFIT_FACTOR}`);
    expect(metrics).toContain(`export const CHECKLIST_RULES = ${gl.CHECKLIST_RULES};`);
    expect(metrics).toContain("label: 'Backtest gate passed'");
    expect(metrics).toContain("val: 'Not applicable'");
  });

  it.runIf(metrics.includes('gate.twin'))("a twin's rule 5 reads Can't be run (phase 3)", () => {
    expect(metrics).toContain(`val: "Can't be run"`);
  });
});
