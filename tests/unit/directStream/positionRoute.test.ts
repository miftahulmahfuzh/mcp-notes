import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { streamPositionRoutes } from '../../../src/http/directStreamApi.js';
import type { StreamLive } from '../../../src/movies/streamLive.js';
import type { MovieStreamsSource } from '../../../src/movies/streams.js';

const HEADERS = { origin: 'http://localhost', 'content-type': 'application/json' };
const SESSION = { id: 'S'.repeat(32), ref: { kind: 'movie' as const, tmdbId: 550 }, source: { provider: 'Alpha' }, torrent: null };

describe('the position route', () => {
  it('a database that does not answer is a clean 503 the page reports past, with one log line', async () => {
    const logged: string[] = [];
    const movies = {
      host: 'host-a',
      tmdb: null,
      events: { changed: () => undefined },
      repo: {
        titleById: async () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:55437');
        },
      },
    } as unknown as MovieStreamsSource;
    const app = new Hono();
    app.route('/', streamPositionRoutes({ movies, directStream: { session: () => SESSION } }, { log: (line) => void logged.push(line) }));
    const res = await app.request(`/api/stream/sessions/${SESSION.id}/position`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ position_s: 600, duration_s: 7200 }) });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: 'store_failed', message: 'The position could not be stored now; the next report is tried again.' });
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
    expect(logged).toEqual([`[notesd] direct stream: the position of session SSSSSS was not stored: connect ECONNREFUSED 127.0.0.1:55437`]);
  });

  it('tells the service whether the film plays, so a move a check behind the play asked for waits for a playing report', async () => {
    const heard: Array<{ paused: boolean; over: boolean }> = [];
    const movies = { host: 'host-a', tmdb: null, events: { changed: () => undefined }, repo: { titleById: async () => { throw new Error('down'); } } } as unknown as MovieStreamsSource;
    const app = new Hono();
    app.route('/', streamPositionRoutes({ movies, directStream: { session: () => SESSION, reported: (_id, r) => void heard.push(r) } }, { log: () => undefined }));
    const post = (body: unknown) => app.request(`/api/stream/sessions/${SESSION.id}/position`, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
    await post({ position_s: 600, paused: true, beat: true });
    await post({ position_s: 605 });
    await post({ position_s: 610, closed: true });
    expect(heard).toEqual([{ paused: true, over: false }, { paused: false, over: false }, { paused: false, over: true }]);
  });

  it('feeds the play log: the page counters read once, how the play ended, and a quiet beat for the stream on screen', async () => {
    const heard: Array<{ id: string; page: unknown }> = [];
    const replaced: string[] = [];
    const playLog = { report: (id: string, page: unknown) => void heard.push({ id, page }), replaced: (id: string) => void replaced.push(id) };
    const live = { has: () => true, current: () => ({ session_id: SESSION.id, title_id: 'movie-550', duration: 7200 }), report: () => undefined, end: () => undefined } as unknown as StreamLive;
    const movies = { host: 'host-a', tmdb: null, events: { changed: () => undefined }, repo: { titleById: async () => { throw new Error('down'); } } } as unknown as MovieStreamsSource;
    const app = new Hono();
    app.route('/', streamPositionRoutes({ movies, directStream: { session: () => SESSION }, live, playLog: playLog as never }, { log: () => undefined }));
    const post = (body: unknown) => app.request(`/api/stream/sessions/${SESSION.id}/position`, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
    const stats = { load: 'loadAAAA1', first_frame_ms: 1200.4, played_ms: 10000, stalls: 1, stalled_ms: 2000, waits: 0, waited_ms: 0, errors: 0 };
    await post({ position_s: 10, stats });
    await post({ position_s: 10, stats: { ...stats, load: 'x' } });
    await post({ position_s: 10, paused: true, beat: true, stats });
    await post({ position_s: 20, ended: true });
    await post({ position_s: 20, closed: true });
    expect(heard.map((h) => h.page)).toEqual([
      { stats: { load: 'loadAAAA1', firstFrameMs: 1200, playedMs: 10000, stalls: 1, stalledMs: 2000, waits: 0, waitedMs: 0, errors: 0 }, over: null, quiet: false },
      { stats: null, over: null, quiet: false },
      { stats: { load: 'loadAAAA1', firstFrameMs: 1200, playedMs: 10000, stalls: 1, stalledMs: 2000, waits: 0, waitedMs: 0, errors: 0 }, over: null, quiet: true },
      { stats: null, over: 'finished', quiet: false },
      { stats: null, over: 'closed', quiet: false },
    ]);
    expect(replaced).toEqual([]);
  });

  it('a report from another session while one is on screen tells the log that one was replaced', async () => {
    const replaced: string[] = [];
    const playLog = { report: () => undefined, replaced: (id: string) => void replaced.push(id) };
    const OTHER = 'O'.repeat(32);
    const live = { has: () => false, current: () => ({ session_id: OTHER, title_id: 'movie-550', duration: 7200 }), report: () => undefined, end: () => undefined } as unknown as StreamLive;
    const movies = { host: 'host-a', tmdb: null, events: { changed: () => undefined }, repo: { titleById: async () => { throw new Error('down'); } } } as unknown as MovieStreamsSource;
    const app = new Hono();
    app.route('/', streamPositionRoutes({ movies, directStream: { session: () => SESSION }, live, playLog: playLog as never }, { log: () => undefined }));
    const res = await app.request(`/api/stream/sessions/${SESSION.id}/position`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ position_s: 5 }) });
    expect(res.status).toBe(503);
    expect(replaced).toEqual([OTHER]);
  });
});
