import { describe, expect, it } from 'vitest';
import { DELIVERY_MIN_REQUESTS, DELIVERY_WINDOW_MS, deliveryByProvider, verdictOf } from '../../../src/directStream/delivery.js';
import type { EvidenceRecord } from '../../../src/directStream/evidence.js';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const at = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString();

function request(session: string, provider: string | null, minutesAgo: number, status: number | null, over: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    type: 'request', at: at(minutesAgo), session, provider, stream_host: 'cdn.example', path: '/seg.ts', range: null, kind: 'media',
    status, answer: status ?? 502, ttfb_ms: 200, bytes: status === 200 ? 300_000 : 190, duration_ms: 1000, kbps: status === 200 ? 2400 : null,
    redirects: 0, outcome: status === null ? 'error' : 'end', error: null, ...over,
  } as EvidenceRecord;
}

function line(session: string, minutesAgo: number, text: string): EvidenceRecord {
  return { type: 'player', at: at(minutesAgo), session, text, page_at: null, stage: 'ready', position_s: 10, buffer_s: 0 };
}

const many = (n: number, make: (i: number) => EvidenceRecord): EvidenceRecord[] => Array.from({ length: n }, (_, i) => make(i));

describe('a provider\'s delivery, from the evidence log', () => {
  it('is bad when the host refused a quarter of the media requests, with the numbers of that run', () => {
    // One Piece 787 on HyperLink: 33 answered, 97 refused with 503.
    const records = [...many(33, (i) => request('s1', 'HyperLink', 30 - i / 10, 200)), ...many(97, (i) => request('s1', 'HyperLink', 20 - i / 10, 503))];
    const hyper = deliveryByProvider(records, NOW).get('HyperLink');
    expect(hyper).toMatchObject({ verdict: 'bad', session: 's1', requests: 130, failed: 97, stalls: 0, median_kbps: 2400 });
  });

  it('is good when the host answered, and says nothing of a run too short to judge', () => {
    const records = [
      ...many(DELIVERY_MIN_REQUESTS, (i) => request('s1', 'Smooth', 10 - i / 10, 200)),
      ...many(DELIVERY_MIN_REQUESTS - 1, (i) => request('s2', 'Brief', 10 - i / 10, 503)),
    ];
    const got = deliveryByProvider(records, NOW);
    expect(got.get('Smooth')?.verdict).toBe('good');
    expect(got.has('Brief')).toBe(false);
  });

  it('counts a host that never answered, and leaves out what the player gave up, what notesd refused and what is not media', () => {
    const records = [
      ...many(9, (i) => request('s1', 'P', 10 - i / 10, 200)),
      ...many(3, () => request('s1', 'P', 9, null)),
      ...many(20, () => request('s1', 'P', 8, null, { outcome: 'aborted' })),
      ...many(20, () => request('s1', 'P', 8, 403, { outcome: 'refused' })),
      ...many(20, () => request('s1', 'P', 8, 503, { kind: 'hls' })),
      ...many(20, () => request('s1', null, 8, 503)),
    ];
    expect(deliveryByProvider(records, NOW).get('P')).toMatchObject({ verdict: 'bad', requests: 12, failed: 3 });
  });

  it('is bad when the player kept stalling though every request was answered, and a stall belongs to the provider last asked', () => {
    const records = [
      ...many(20, (i) => request('s1', 'Slow', 9 - i / 10, 200)),
      line('s1', 6, 'stalled at 30 s'),
      line('s1', 5, 'recovering 1/5 after networkError fragLoadError at 40 s'),
      line('s1', 4, 'stalled at 50 s'),
      line('s1', 4, 'recovered at 50 s'),
      line('s2', 4, 'stalled at 1 s'),
    ];
    expect(deliveryByProvider(records, NOW).get('Slow')).toMatchObject({ verdict: 'bad', failed: 0, stalls: 3 });
    // Three stalls over a whole film are not a bad source.
    expect(verdictOf({ requests: 900, failed: 0, stalls: 3, spanMs: 100 * 60_000 })).toBe('good');
    expect(verdictOf({ requests: 2, failed: 0, stalls: 3, spanMs: 0 })).toBe('bad');
    expect(verdictOf({ requests: 2, failed: 2, stalls: 0, spanMs: 0 })).toBeNull();
  });

  it('takes the newest run of a provider, each session and provider apart, and forgets runs older than the window', () => {
    const records = [
      ...many(20, () => request('old', 'Healed', 600, 503)),
      ...many(20, () => request('new', 'Healed', 30, 200)),
      ...many(20, () => request('new', 'Other', 20, 503)),
      ...many(20, () => request('gone', 'Ancient', DELIVERY_WINDOW_MS / 60_000 + 5, 503)),
    ];
    const got = deliveryByProvider(records, NOW);
    expect(got.get('Healed')).toMatchObject({ verdict: 'good', session: 'new' });
    expect(got.get('Other')?.verdict).toBe('bad');
    expect(got.has('Ancient')).toBe(false);
  });
});
