import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROBE_TIMINGS,
  defaultProbeBudget,
  probePassSeconds,
  probeSecondsPerTitle,
  REPO_ROOT,
  SPIKE_PROBE_TIMINGS,
  type ProbeTimings,
} from '../../../src/config.js';

const FINDINGS = path.join(REPO_ROOT, 'docs', 'plans', '2026-11-15-direct-streaming-findings.md');
const KEYS = ['median_resolve_s', 'median_fail_s', 'median_failed_before_resolve'] as const;

/**
 * Phase 2's `campaign:timings` block (its schema 1 is the contract): `resolve_s.p50` is the median
 * resolve, `fail_s.p50` the median failure. It has no failed-before-resolve figure, so that key
 * stays the spike's. Null when the block is missing.
 */
function timingsBlock(markdown: string): Partial<ProbeTimings> | null {
  const m = /<!-- campaign:timings:begin -->[\s\S]*?```json[^\n]*\n([\s\S]*?)```[\s\S]*?<!-- campaign:timings:end -->/.exec(markdown);
  if (m === null) return null;
  const o = JSON.parse(m[1] ?? '') as { resolve_s?: { p50?: unknown } | null; fail_s?: { p50?: unknown } | null };
  const out: Partial<ProbeTimings> = {};
  if (typeof o.resolve_s?.p50 === 'number') out.median_resolve_s = o.resolve_s.p50;
  if (typeof o.fail_s?.p50 === 'number') out.median_fail_s = o.fail_s.p50;
  return out;
}

describe('prober defaults', () => {
  it('DEFAULT_PROBE_TIMINGS are the resolve campaign\'s timings, a spike number where the block has none', () => {
    expect(existsSync(FINDINGS)).toBe(true);
    const block = timingsBlock(readFileSync(FINDINGS, 'utf8'));
    expect(block, 'the findings file has no ```json timings block').not.toBeNull();
    for (const k of KEYS) expect(DEFAULT_PROBE_TIMINGS[k], k).toBe(block?.[k] ?? SPIKE_PROBE_TIMINGS[k]);
  });

  it('derives the budget: half the pause between passes, divided by one title\'s seconds', () => {
    expect(probeSecondsPerTitle(SPIKE_PROBE_TIMINGS)).toBe(38);
    expect(probePassSeconds(1_200_000)).toBe(600);
    expect(defaultProbeBudget(1_200_000, SPIKE_PROBE_TIMINGS)).toBe(15);
    expect(defaultProbeBudget(10_000, SPIKE_PROBE_TIMINGS)).toBe(1);
  });
});
