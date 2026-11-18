import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QueryFn } from '../../../src/chat/agent.js';
import { buildGuideInput, createGuideWriter, GUIDE_SYSTEM_PROMPT, guideMark, parseGuide, personTitles, pickHit, type GuideInput } from '../../../src/movies/guides.js';
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
