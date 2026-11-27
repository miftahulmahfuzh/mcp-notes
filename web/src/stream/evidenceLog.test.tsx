// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fakeVideo, routeFetch, type FetchCall } from '../testing/streamFakes';
import { bufferAheadOf, EVENT_TEXT_MAX, EVENTS_PER_POST, EvidenceLog, positionOf } from './evidenceLog';

const ranges = (...r: [number, number][]) => ({ length: r.length, start: (i: number) => r[i][0], end: (i: number) => r[i][1] }) as unknown as TimeRanges;

describe('the position and buffer of a log line', () => {
  it('reads the position to a tenth, and the seconds buffered ahead of it', () => {
    expect(positionOf({ currentTime: 12.345 })).toBe(12.3);
    expect(positionOf({ currentTime: Number.NaN })).toBeNull();
    expect(bufferAheadOf({ currentTime: 10, buffered: ranges([0, 5], [9.7, 40.04]) })).toBe(30);
    // The position is outside every range: nothing ahead.
    expect(bufferAheadOf({ currentTime: 50, buffered: ranges([0, 40]) })).toBe(0);
    expect(bufferAheadOf({ currentTime: Number.NaN, buffered: ranges([0, 40]) })).toBeNull();
    expect(
      bufferAheadOf({
        currentTime: 1,
        get buffered(): TimeRanges {
          throw new Error('detached');
        },
      }),
    ).toBeNull();
  });
});

describe('EvidenceLog', () => {
  it('posts the lines of one tick together, under the session each was written in, at most EVENTS_PER_POST a post', async () => {
    const posted: FetchCall[] = [];
    const ok = (c: FetchCall) => {
      posted.push(c);
      return new Response(null, { status: 204 });
    };
    const { fetchImpl } = routeFetch({ 'POST /api/stream/sessions/S1/events': ok, 'POST /api/stream/sessions/S2/events': ok });
    const log = new EvidenceLog(fakeVideo({ currentTime: 7 }).video, fetchImpl);
    for (let i = 0; i < EVENTS_PER_POST + 1; i++) log.send('S1', 'ready', `line ${i}`);
    log.send('S2', 'error', 'x'.repeat(EVENT_TEXT_MAX + 10));
    expect(posted).toEqual([]);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const bodies = posted.map((c) => ({ url: c.url, lines: (c.body as { lines: { text: string; stage: string; position_s: number }[] }).lines }));
    expect(bodies.map((b) => [b.url, b.lines.length])).toEqual([
      ['/api/stream/sessions/S1/events', EVENTS_PER_POST],
      ['/api/stream/sessions/S1/events', 1],
      ['/api/stream/sessions/S2/events', 1],
    ]);
    expect(bodies[0].lines[0]).toMatchObject({ text: 'line 0', stage: 'ready', position_s: 7 });
    expect(bodies[2].lines[0].text).toHaveLength(EVENT_TEXT_MAX);
  });
});
