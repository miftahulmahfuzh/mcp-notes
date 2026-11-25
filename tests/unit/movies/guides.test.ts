import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QueryFn } from '../../../src/chat/agent.js';
import { buildGuideInput, companyTitles, createGuideWriter, GUIDE_SYSTEM_PROMPT, guideMark, parseGuide, personTitles, pickHit, type GuideInput } from '../../../src/movies/guides.js';
import type { TmdbPersonCredit, TmdbSearchHit } from '../../../src/movies/tmdb.js';

const INPUT: GuideInput = { title: 'How to Make a Killing (2026)', kind: 'movie', genre: 'Comedy', genres: ['Comedy', 'Crime'], overview: 'An heir removes his relatives.' };

const credit = (over: Partial<TmdbPersonCredit>): TmdbPersonCredit => ({
  kind: 'movie', tmdbId: 1, title: 'A', releaseDate: '2020-01-01', year: 2020, posterPath: null, popularity: 1, credit: 'cast', character: null, job: null, department: null, episodeCount: null, ...over,
});
const hit = (over: Partial<TmdbSearchHit>): TmdbSearchHit => ({ kind: 'movie', tmdbId: 1, title: 'A', originalTitle: 'A', releaseDate: '2020-01-01', year: 2020, overview: '', posterPath: null, popularity: 1, ...over });

describe('guideMark', () => {
  it('reads what the owner did with a title: not interested first, then watched, then started', () => {
    expect(guideMark(undefined)).toBeNull();
    expect(guideMark({ state: 'unwatched', watched: false, not_interested: false })).toBeNull();
    expect(guideMark({ state: 'finished', watched: false, not_interested: false })).toBe('watched');
    expect(guideMark({ state: 'seen', watched: false, not_interested: false })).toBe('watched');
    expect(guideMark({ state: 'unwatched', watched: true, not_interested: false })).toBe('watched');
    expect(guideMark({ state: 'in_progress', watched: false, not_interested: false })).toBe('started');
    expect(guideMark({ state: 'dropped', watched: false, not_interested: false })).toBe('started');
    expect(guideMark({ state: 'finished', watched: true, not_interested: true })).toBe('not_interested');
  });
});

describe('personTitles', () => {
  it('lists a title once with the roles joined, and leaves out talk shows and news', () => {
    const listed = personTitles([
      credit({ tmdbId: 5, title: 'Film', character: 'Ruth' }),
      credit({ tmdbId: 5, title: 'Film', credit: 'crew', job: 'Producer' }),
      credit({ kind: 'tv', tmdbId: 5, title: 'Series', character: null }),
      credit({ kind: 'tv', tmdbId: 7, title: 'Late Show', character: 'Self', genreIds: [10767] }),
      credit({ kind: 'tv', tmdbId: 8, title: 'News', character: 'Self', genreIds: [35, 10763] }),
      credit({ tmdbId: 9, title: 'Making Of', character: 'Self - Director' }),
      credit({ tmdbId: 10, title: 'Friend Film', credit: 'crew', job: 'Thanks' }),
      credit({ tmdbId: 5, title: 'Film', character: 'Self (archive footage)' }),
    ]);
    expect(listed.map((l) => [l.kind, l.tmdbId, l.note])).toEqual([
      ['movie', 5, 'as Ruth, Producer'],
      ['tv', 5, 'cast'],
    ]);
  });
});

describe('companyTitles', () => {
  const page = (n: number, size = 20) => Array.from({ length: size }, (_, i) => hit({ tmdbId: n * 100 + i, title: `P${n} ${i}` }));

  it('reads every page TMDB has of a studio, each title once, and asks a failed page once more', async () => {
    const asked: number[] = [];
    let failed = false;
    const tmdb = {
      discover: () => Promise.reject(new Error('unused')),
      discoverPage: (_kind: 'movie' | 'tv', f: { page?: number; companyIds?: readonly number[] | null; sort?: string }) => {
        const n = f.page ?? 1;
        asked.push(n);
        expect([f.companyIds, f.sort]).toEqual([[3172], 'newest']);
        if (n === 7 && !failed) {
          failed = true;
          return Promise.reject(new Error('429'));
        }
        // Page 13 is the short last one; page 3 repeats a title of page 2.
        return Promise.resolve({ hits: n === 13 ? page(n, 4) : n === 3 ? [hit({ tmdbId: 200 }), ...page(n, 19)] : page(n), totalPages: 13 });
      },
    };
    const all = await companyTitles(tmdb, 'movie', 3172);
    expect(all).toHaveLength(12 * 20 + 4 - 1);
    expect(new Set(all.map((h) => h.tmdbId)).size).toBe(all.length);
    expect([...asked].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 7, 8, 9, 10, 11, 12, 13]);
  });

  it('without page counts walks the pages to the first short one', async () => {
    const asked: number[] = [];
    const tmdb = {
      discover: (_kind: 'movie' | 'tv', f: { page?: number }) => {
        asked.push(f.page ?? 1);
        return Promise.resolve(f.page === 3 ? page(3, 5) : page(f.page ?? 1));
      },
    };
    expect(await companyTitles(tmdb, 'tv', 1)).toHaveLength(45);
    expect(asked).toEqual([1, 2, 3]);
  });
});

describe('parseGuide', () => {
  it('reads the JSON object out of the answer, whatever surrounds it, and drops entries without a title', () => {
    const g = parseGuide('Here it is:\n```json\n{"description": " Dry and cold. ", "titles": [{"title": "Kind Hearts and Coronets", "year": 1949, "kind": "movie", "why": "the source"}, {"title": " "}, {"title": "Succession", "year": "2018", "kind": "tv"}]}\n```');
    expect(g.description).toBe('Dry and cold.');
    expect(g.titles).toEqual([
      { title: 'Kind Hearts and Coronets', year: 1949, kind: 'movie', why: 'the source' },
      { title: 'Succession', year: null, kind: 'tv', why: '' },
    ]);
  });

  it('refuses an answer with no JSON or no description', () => {
    expect(() => parseGuide('I could not search.')).toThrow(/no JSON/);
    expect(() => parseGuide('{"titles": []}')).toThrow(/no description/);
    expect(() => parseGuide('{"description": "x", ')).toThrow(/no JSON|does not parse/);
  });
});

describe('pickHit', () => {
  it('takes the hit of that exact name nearest the year; a looser first hit only when a year was asked; else nothing', () => {
    const hits = [hit({ tmdbId: 1, title: 'Superman', year: 1978 }), hit({ tmdbId: 2, title: 'Superman', year: 2025 }), hit({ tmdbId: 3, title: 'Superman II', year: 1980 })];
    expect(pickHit({ title: 'superman', year: 2025, kind: 'movie', why: '' }, hits)?.tmdbId).toBe(2);
    expect(pickHit({ title: 'Superman', year: null, kind: 'movie', why: '' }, hits)?.tmdbId).toBe(1);
    expect(pickHit({ title: 'Amélie', year: 2001, kind: 'movie', why: '' }, [hit({ tmdbId: 9, title: 'Amelie', originalTitle: 'Le Fabuleux Destin' })])?.tmdbId).toBe(9);
    expect(pickHit({ title: 'The Menu', year: 2022, kind: 'movie', why: '' }, [hit({ tmdbId: 4, title: 'Menu' })])?.tmdbId).toBe(4);
    expect(pickHit({ title: 'The Menu', year: null, kind: 'movie', why: '' }, [hit({ tmdbId: 4, title: 'Menu' })])).toBeNull();
    expect(pickHit({ title: 'Nothing', year: 2020, kind: 'movie', why: '' }, [])).toBeNull();
  });
});

describe('createGuideWriter', () => {
  let dir: string;
  let bin: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'notesd-guide-'));
    bin = path.join(dir, 'claude');
    await writeFile(bin, '#!/bin/sh\n');
    await chmod(bin, 0o755);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const result = (text: string) => ({ type: 'result', subtype: 'success', is_error: false, result: text }) as never;

  it('runs the model with web search as its one tool and no session, and answers the parsed guide', async () => {
    const seen: Array<{ prompt: unknown; options: Options }> = [];
    const query: QueryFn = ({ prompt, options }) => {
      seen.push({ prompt, options: options as Options });
      return (async function* () {
        yield result('{"description": "Dry.", "titles": [{"title": "The Menu", "year": 2022, "kind": "movie", "why": "eats the rich"}]}');
      })();
    };
    const writer = createGuideWriter({ claudeBin: bin, cwd: path.join(dir, 'cwd'), model: 'sonnet', query });
    expect(await writer?.write(INPUT)).toEqual({ description: 'Dry.', titles: [{ title: 'The Menu', year: 2022, kind: 'movie', why: 'eats the rich' }] });
    expect(seen[0]?.prompt).toBe(buildGuideInput(INPUT));
    expect(buildGuideInput(INPUT)).toBe('Genre clicked: Comedy\nTitle: How to Make a Killing (2026) (film)\nIts genres: Comedy, Crime\nTMDB\'s synopsis: An heir removes his relatives.');
    expect(seen[0]?.options).toMatchObject({ model: 'sonnet', tools: ['WebSearch'], allowedTools: ['WebSearch'], mcpServers: {}, persistSession: false, systemPrompt: GUIDE_SYSTEM_PROMPT });
    expect(GUIDE_SYSTEM_PROMPT).toMatch(/not from the genre's famous films/);
  });

  it('rejects when the model answers nothing or no guide, and is null without a claude binary', async () => {
    const silent: QueryFn = () => (async function* () {})();
    await expect(createGuideWriter({ claudeBin: bin, cwd: dir, model: 'sonnet', query: silent })?.write(INPUT)).rejects.toThrow(/answered nothing/);
    const prose: QueryFn = () =>
      (async function* () {
        yield result('Sorry, nothing found.');
      })();
    await expect(createGuideWriter({ claudeBin: bin, cwd: dir, model: 'sonnet', query: prose })?.write(INPUT)).rejects.toThrow(/no JSON/);
    expect(createGuideWriter({ claudeBin: path.join(dir, 'missing'), cwd: dir, model: 'sonnet', baseEnv: { PATH: dir + '/nowhere' } })).toBeNull();
  });
});
