// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeVideo, jsonResponse, routeFetch } from '../testing/streamFakes';
import { fakeHost, fakeSession } from './fakeHost';
import { POSITION_INTERVAL_MS, positionReport, PositionReports } from './positionReports';
import type { PositionAnswer } from './session';

const stats = { load: 'L', first_frame_ms: null, played_ms: 0, stalls: 0, stalled_ms: 0, waits: 0, waited_ms: 0, errors: 0 };

afterEach(() => {
  vi.useRealTimers();
});

describe('positionReport', () => {
  it('reports the position to a tenth, the end as the duration, and nothing before the film has a position', () => {
    expect(positionReport({ currentTime: 61.26, duration: 5400, paused: true }, {}, stats)).toEqual({ position_s: 61.3, duration_s: 5400, ended: false, paused: true, stats });
    expect(positionReport({ currentTime: 5399, duration: 5400, paused: true }, { ended: true }, stats)).toMatchObject({ position_s: 5400, ended: true, paused: false });
    expect(positionReport({ currentTime: 10, duration: Number.NaN, paused: false }, { beat: true, closed: true }, stats)).toMatchObject({ duration_s: null, beat: true, closed: true });
    expect(positionReport({ currentTime: 0, duration: 5400, paused: false }, {}, stats)).toBeNull();
  });
});

describe('PositionReports', () => {
  function setup() {
    const { fetchImpl, calls } = routeFetch({ 'POST /api/stream/sessions/S1/position': () => jsonResponse({ ok: true, subtitle_rev: 3 }) });
    const v = fakeVideo({ currentTime: 30, duration: 600, paused: false });
    const host = fakeHost(v.video, { fetch: fetchImpl });
    host.currentSession = fakeSession();
    host.current = { ...host.current, stage: 'ready' };
    const remembered: [string, number][] = [];
    const answers: PositionAnswer[] = [];
    const reports = new PositionReports({ ...host, rememberPosition: (id, s) => void remembered.push([id, s]), onAnswer: (_id, a) => void answers.push(a) });
    const bodies = () => calls.map((c) => c.body as Record<string, unknown>);
    return { v, host, reports, remembered, answers, bodies };
  }

  it('reports every POSITION_INTERVAL_MS while the film is on the page, a beat while it is paused, and hands on the answer', async () => {
    vi.useFakeTimers();
    const t = setup();
    t.reports.start();
    await vi.advanceTimersByTimeAsync(POSITION_INTERVAL_MS);
    t.v.media.paused = true;
    await vi.advanceTimersByTimeAsync(POSITION_INTERVAL_MS);
    t.host.current = { ...t.host.current, stage: 'loading' };
    await vi.advanceTimersByTimeAsync(POSITION_INTERVAL_MS);
    t.reports.stop();
    expect(t.bodies().map((b) => [b.position_s, b.paused, b.beat])).toEqual([
      [30, false, undefined],
      [30, true, true],
    ]);
    expect(t.host.current.reportedS).toBe(30);
    expect(t.remembered).toEqual([
      ['S1', 30],
      ['S1', 30],
    ]);
    expect(t.answers[0]).toMatchObject({ rev: 3, gone: false });
  });

  it('does not keep the end as the position to carry on from', () => {
    const t = setup();
    t.reports.ended();
    expect(t.bodies()[0]).toMatchObject({ ended: true, position_s: 600 });
    expect(t.remembered).toEqual([]);
  });
});
