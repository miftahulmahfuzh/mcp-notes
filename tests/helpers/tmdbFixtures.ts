import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A fake TMDB v3 built from the JSON files in tests/fixtures/movies. Two ways in: `fixtureFetch()`
 * (an injected fetch, for unit tests) and `startTmdbFixtureServer()` (a real HTTP server on
 * 127.0.0.1, for scripted proofs and later integration tests; point `TMDB_API_BASE` at `base`).
 *
 * Routes -> files: /search/{movie,tv,person}?query=Q -> search-{kind}-{slug(Q)}.json (an unknown
 * query answers an empty page, as TMDB does); /movie/ID -> movie-ID.json; /tv/ID -> tv-ID.json;
 * /tv/ID/season/N -> tv-ID-season-N.json; /person/ID/combined_credits ->
 * person-ID-combined-credits.json. Anything else is TMDB's 404 body.
 */

export const TMDB_FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/movies');

/** apiBase for fixtureFetch(). */
export const FIXTURE_API_BASE = 'http://tmdb.fixture';

export interface TmdbFixtureCall {
  pathname: string;
  params: URLSearchParams;
  authorization: string | null;
}

function slug(query: string | null): string {
  return (query ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function fixtureFileFor(pathname: string, params: URLSearchParams): string | null {
  const searchKind = /^\/search\/(movie|tv|person)$/.exec(pathname);
  if (searchKind !== null) return `search-${searchKind[1]}-${slug(params.get('query'))}.json`;
  const movie = /^\/movie\/(\d+)$/.exec(pathname);
  if (movie !== null) return `movie-${movie[1]}.json`;
  const tv = /^\/tv\/(\d+)$/.exec(pathname);
  if (tv !== null) return `tv-${tv[1]}.json`;
  const season = /^\/tv\/(\d+)\/season\/(\d+)$/.exec(pathname);
  if (season !== null) return `tv-${season[1]}-season-${season[2]}.json`;
  const person = /^\/person\/(\d+)\/combined_credits$/.exec(pathname);
  if (person !== null) return `person-${person[1]}-combined-credits.json`;
  return null;
}

export function tmdbFixtureResponse(pathname: string, params: URLSearchParams): { status: number; body: string } {
  const file = fixtureFileFor(pathname, params);
  if (file !== null) {
    const full = path.join(TMDB_FIXTURE_DIR, file);
    if (existsSync(full)) return { status: 200, body: readFileSync(full, 'utf8') };
  }
  if (pathname.startsWith('/search/')) {
    return { status: 200, body: JSON.stringify({ page: 1, results: [], total_pages: 0, total_results: 0 }) };
  }
  return {
    status: 404,
    body: JSON.stringify({ success: false, status_code: 34, status_message: 'The resource you requested could not be found.' }),
  };
}

/** An injected fetch answering from the fixtures; `calls` records every request. Use with apiBase FIXTURE_API_BASE. */
export function fixtureFetch(): { fetch: typeof fetch; calls: TmdbFixtureCall[] } {
  const calls: TmdbFixtureCall[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    calls.push({ pathname: url.pathname, params: url.searchParams, authorization: headers.get('authorization') });
    const { status, body } = tmdbFixtureResponse(url.pathname, url.searchParams);
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch: impl as typeof fetch, calls };
}

/** The same fixtures over real HTTP on 127.0.0.1 and a free port. */
export async function startTmdbFixtureServer(): Promise<{ base: string; calls: TmdbFixtureCall[]; close(): Promise<void> }> {
  const calls: TmdbFixtureCall[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const auth = req.headers.authorization;
    calls.push({ pathname: url.pathname, params: url.searchParams, authorization: typeof auth === 'string' ? auth : null });
    const { status, body } = tmdbFixtureResponse(url.pathname, url.searchParams);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
