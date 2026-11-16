import { describe, expect, it } from 'vitest';
import type { DirectStreamService } from '../../../src/directStream/service.js';
import type { PageReport, ReportOutcome, StreamReporter } from '../../../src/directStream/report.js';
import { scrubLine, streamReportRoutes } from '../../../src/http/streamReportApi.js';

const SID = 'AbCdEf0123456789_-AbCdEf01234567';
const URL_ = `http://localhost/api/stream/sessions/${SID}/report`;
const ON = {} as DirectStreamService;

function fakeReporter(outcome: ReportOutcome) {
  const calls: { id: string; page: PageReport | null }[] = [];
  const reporter = {
    report: async (id: string, page: PageReport | null) => {
      calls.push({ id, page });
      return outcome;
    },
  } as unknown as StreamReporter;
  return { reporter, calls };
}

const OPENED: ReportOutcome = { status: 200, body: { ok: true, dir: '/d/r1', window: 'note:3', complete: true } };

function post(app: ReturnType<typeof streamReportRoutes>, body: string | undefined, origin: string | null = 'http://localhost') {
  return app.request(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin === null ? {} : { origin }) },
    ...(body === undefined ? {} : { body }),
  });
}

const PAGE = { stage: 'error', error: 'networkError fragLoadError', errors: ['networkError fragLoadError'], log: [] };

describe('POST /api/stream/sessions/:id/report', () => {
  it("refuses a request without the page's own Origin and reports nothing", async () => {
    const { reporter, calls } = fakeReporter(OPENED);
    const res = await post(streamReportRoutes({ directStream: ON, streamReporter: reporter }), '{}', null);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden_origin' });
    expect(calls).toHaveLength(0);
  });

  it('answers direct_stream_off without direct streaming and report_off without a reporter', async () => {
    const { reporter } = fakeReporter(OPENED);
    const off = await post(streamReportRoutes({ directStream: null, streamReporter: reporter }), '{}');
    expect(off.status).toBe(503);
    expect(await off.json()).toMatchObject({ error: 'direct_stream_off' });
    const noReporter = await post(streamReportRoutes({ directStream: ON, streamReporter: null }), '{}');
    expect(noReporter.status).toBe(503);
    expect(await noReporter.json()).toMatchObject({ error: 'report_off' });
  });

  it("hands the page's log to the reporter with every address's query dropped", async () => {
    const { reporter, calls } = fakeReporter(OPENED);
    const body = JSON.stringify({
      page: {
        ...PAGE,
        log: ['retry 2: https://cdn.host.example/hls/seg-12.ts?token=SECRET&e=1 timed out', `GET /api/stream/sessions/${SID}/p?u=https%3A%2F%2Fcdn%2Fx%3Ftoken%3DSECRET`],
        title: 'One Piece S18E787',
        position_s: 612.4,
      },
    });
    const res = await post(streamReportRoutes({ directStream: ON, streamReporter: reporter }), body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OPENED.body);
    expect(calls[0]!.id).toBe(SID);
    expect(calls[0]!.page!.log).toEqual(['retry 2: https://cdn.host.example/hls/seg-12.ts timed out', `GET /api/stream/sessions/${SID}/p`]);
    expect(calls[0]!.page).toMatchObject({ stage: 'error', title: 'One Piece S18E787', position_s: 612.4 });
    expect(JSON.stringify(calls)).not.toContain('SECRET');
  });

  it('an empty body is a report without the page log; a page without title or position gets nulls', async () => {
    const { reporter, calls } = fakeReporter(OPENED);
    const app = streamReportRoutes({ directStream: ON, streamReporter: reporter });
    expect((await post(app, undefined)).status).toBe(200);
    expect((await post(app, JSON.stringify({ page: PAGE }))).status).toBe(200);
    expect(calls[0]!.page).toBeNull();
    expect(calls[1]!.page).toEqual({ ...PAGE, title: null, position_s: null });
  });

  it.each<ReportOutcome>([
    { status: 409, body: { error: 'already_reported', dir: '/d/r1' } },
    { status: 409, body: { error: 'no_tmux', dir: '/d/r1', complete: false } },
    { status: 500, body: { error: 'spawn_failed', dir: '/d/r1', message: 'boom', complete: true } },
    { status: 403, body: { error: 'unknown_session', message: 'gone' } },
  ])('passes the reporter answer $status $body.error through', async (outcome) => {
    const { reporter } = fakeReporter(outcome);
    const res = await post(streamReportRoutes({ directStream: ON, streamReporter: reporter }), JSON.stringify({ page: PAGE }));
    expect(res.status).toBe(outcome.status);
    expect(await res.json()).toEqual(outcome.body);
  });

  it('refuses a body that is not JSON, or not a report', async () => {
    const { reporter, calls } = fakeReporter(OPENED);
    const app = streamReportRoutes({ directStream: ON, streamReporter: reporter });
    const bad = await post(app, '{nope');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'invalid_json' });
    const wrong = await post(app, JSON.stringify({ page: { stage: 3 } }));
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: 'invalid_body' });
    expect(calls).toHaveLength(0);
  });
});

describe('scrubLine', () => {
  it('keeps host and path, drops query and fragment, caps the length', () => {
    expect(scrubLine('x https://a.example/p/q.m3u8?sig=1#t y')).toBe('x https://a.example/p/q.m3u8 y');
    expect(scrubLine('no address here')).toBe('no address here');
    expect(scrubLine('z'.repeat(900))).toHaveLength(500);
  });
});
