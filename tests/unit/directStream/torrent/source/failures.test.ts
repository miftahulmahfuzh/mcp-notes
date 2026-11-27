import { describe, expect, it } from 'vitest';
import { FILE_FAILURE_KEEP_MS, SWARM_FAILURE_KEEP_MS } from '../../../../../src/directStream/torrent/source.js';
import { FailureMemory } from '../../../../../src/directStream/torrent/source/failures.js';
import { refKey } from '../../../../../src/directStream/torrent/source/query.js';

const H = 'a'.repeat(40);
const K = 'movie:1';

function memory(): { m: FailureMemory; clock: { t: number } } {
  const clock = { t: 1_000_000 };
  return { m: new FailureMemory(() => clock.t), clock };
}

describe('FailureMemory: what failed lately per film or episode', () => {
  it('keeps a swarm failure SWARM_FAILURE_KEEP_MS and a file failure FILE_FAILURE_KEEP_MS, then drops it', () => {
    const { m, clock } = memory();
    m.remember(K, H, false);
    m.remember(K, 'b'.repeat(40), true);
    expect([...m.remembered(K)]).toEqual([
      [H, false],
      ['b'.repeat(40), true],
    ]);
    clock.t += SWARM_FAILURE_KEEP_MS;
    expect([...m.remembered(K)]).toEqual([['b'.repeat(40), true]]);
    clock.t += FILE_FAILURE_KEEP_MS;
    expect(m.remembered(K).size).toBe(0);
  });

  it('keys by lower-case info hash', () => {
    const { m } = memory();
    m.remember(K, H.toUpperCase(), false);
    expect(m.remembered(K).has(H)).toBe(true);
  });

  it('never shortens a file failure (a dub) to a swarm failure by a later stall', () => {
    const { m, clock } = memory();
    m.remember(K, H, true, 'dubbed: heard');
    m.remember(K, H, false, 'no_stream: stalled');
    clock.t += SWARM_FAILURE_KEEP_MS + 1;
    expect(m.remembered(K).get(H)).toBe(true);
    expect(m.whyOf(K)(H)).toBe('dubbed: heard');
  });

  it('a later failure without a reason keeps the earlier reason', () => {
    const { m } = memory();
    m.remember(K, H, false, 'no_stream: no file list');
    m.remember(K, H, false);
    expect(m.whyOf(K)(H)).toBe('no_stream: no file list');
  });

  it('forgetSwarmFailures forgets the swarm failures only, and says whether any went', () => {
    const { m } = memory();
    expect(m.forgetSwarmFailures(K)).toBe(false);
    m.remember(K, H, false);
    m.remember(K, 'b'.repeat(40), true);
    expect(m.forgetSwarmFailures(K)).toBe(true);
    expect([...m.remembered(K).keys()]).toEqual(['b'.repeat(40)]);
    expect(m.forgetSwarmFailures(K)).toBe(false);
  });

  it('noteDubbed is a lasting failure that says why; noteStalled a swarm failure', () => {
    const { m } = memory();
    const ref = { kind: 'tv', tmdbId: 7, season: 1, episode: 2 } as const;
    m.noteDubbed(ref, H, 'heard as es');
    m.noteStalled(ref, 'c'.repeat(40));
    const key = refKey(ref);
    expect(m.remembered(key).get(H)).toBe(true);
    expect(m.whyOf(key)(H)).toBe('dubbed: heard as es');
    expect(m.remembered(key).get('c'.repeat(40))).toBe(false);
    m.noteDubbed(ref, 'd'.repeat(40));
    expect(m.whyOf(key)('d'.repeat(40))).toBe('dubbed: heard');
  });

  it('keeps each film or episode apart', () => {
    const { m } = memory();
    m.remember('movie:1', H, false);
    expect(m.remembered('movie:2').size).toBe(0);
    expect(m.whyOf('movie:2')(H)).toBeNull();
  });
});
