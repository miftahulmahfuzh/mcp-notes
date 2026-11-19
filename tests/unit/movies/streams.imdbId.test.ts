import { describe, expect, it } from 'vitest';
import { IMDB_ID_TRIES, MovieStreams, type MovieStreamsSource } from '../../../src/movies/streams.js';
import { TmdbError } from '../../../src/movies/tmdb.js';

const FILM = { kind: 'movie' as const, tmdbId: 1054867 };

function setup(answers: Array<string | null | Error>): { streams: MovieStreams; calls: () => number; lines: string[] } {
  let calls = 0;
  const lines: string[] = [];
  const tmdb = {
    imdbId: async (): Promise<string | null> => {
      const next = answers[Math.min(calls, answers.length - 1)];
      calls += 1;
      if (next instanceof Error) throw next;
      return next ?? null;
    },
  };
  const source = { repo: {}, tmdb, events: { emit: () => undefined }, host: 'test' } as unknown as MovieStreamsSource;
  return { streams: new MovieStreams(source, { log: (line) => lines.push(line) }), calls: () => calls, lines };
}

describe('MovieStreams.imdbId', () => {
  it("answers TMDB's id and keeps it: a second ask sends no request", async () => {
    const t = setup(['tt30144839']);
    expect(await t.streams.imdbId(FILM)).toBe('tt30144839');
    expect(await t.streams.imdbId(FILM)).toBe('tt30144839');
    expect(t.calls()).toBe(1);
    expect(t.lines).toEqual([]);
  });

  it('asks again when TMDB did not answer, and the title keeps its id (a hiccup is not "no IMDb id")', async () => {
    for (const hiccup of [new TmdbError('timeout', 'TMDB timed out'), new TmdbError('network', 'fetch failed'), new TmdbError('http', 'TMDB returned 503', 503), new TmdbError('http', 'TMDB returned 429', 429)]) {
      const t = setup([hiccup, 'tt30144839']);
      expect(await t.streams.imdbId(FILM)).toBe('tt30144839');
      expect(t.calls()).toBe(2);
      expect(t.lines).toEqual([]);
    }
  });

  it('gives up after the tries, says so in the log, and keeps nothing: the next play asks again', async () => {
    const t = setup([new TmdbError('timeout', 'TMDB timed out'), new TmdbError('timeout', 'TMDB timed out'), 'tt30144839']);
    expect(await t.streams.imdbId(FILM)).toBeNull();
    expect(t.calls()).toBe(IMDB_ID_TRIES);
    expect(t.lines).toHaveLength(1);
    expect(t.lines[0]).toContain('could not read the IMDb id of');
    expect(t.lines[0]).toContain('TMDB timed out');
    expect(await t.streams.imdbId(FILM)).toBe('tt30144839');
  });

  it('a title TMDB lists no id for is null with no retry and no log line, and is asked again next time', async () => {
    const t = setup([null]);
    expect(await t.streams.imdbId(FILM)).toBeNull();
    expect(await t.streams.imdbId(FILM)).toBeNull();
    expect(t.calls()).toBe(2);
    expect(t.lines).toEqual([]);
  });

  it('does not retry an answer TMDB did give (a 404, a bad body)', async () => {
    const t = setup([new TmdbError('http', 'TMDB returned 404', 404)]);
    expect(await t.streams.imdbId(FILM)).toBeNull();
    expect(t.calls()).toBe(1);
    expect(t.lines).toHaveLength(1);
  });
});
