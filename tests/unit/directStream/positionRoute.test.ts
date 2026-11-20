import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { streamPositionRoutes } from '../../../src/http/directStreamApi.js';
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
});
