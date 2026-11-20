import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryFn } from '../../../src/chat/agent.js';
import type { MovieStorySection, MovieStorySource } from '../../../src/db/schema.js';
import type { StoredDialogue } from '../../../src/directStream/dialogueStore.js';
import { DirectStreamError } from '../../../src/directStream/types.js';
import {
  DEFAULT_STORY_MODEL,
  MovieStories,
  NO_RECAP_TEXT,
  STORY_SYSTEM_PROMPT,
  StoryError,
  buildStoryInput,
  createStoryWriter,
  type MovieStoriesOptions,
  type StoryInput,
  type StoryWriter,
} from '../../../src/movies/story.js';
import type { TitleMetadata } from '../../../src/movies/types.js';
import type { WebStoryInput, WebStoryWriter, WrittenWebStory } from '../../../src/movies/webStory.js';

function result(text: string, isError = false): SDKMessage {
  return { type: 'result', subtype: 'success', is_error: isError, result: text, num_turns: 1, duration_ms: 1, duration_api_ms: 1, session_id: 'x', uuid: randomUUID() } as unknown as SDKMessage;
}

const INPUT: StoryInput = {
  title: 'One Piece (1999)',
  code: 'S18E760',
  episodeName: 'Destruction of the Capital',
  airDate: '2016-10-16',
  overview: 'Jack brings out his secret weapon.',
  characters: ['Monkey D. Luffy (voice)', 'Nami (voice)'],
  dialogue: '[10:55] ...Jack!\n[12:03] It was a poison-gas weapon.',
};

let dir: string;
let bin: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'movies-story-'));
  bin = path.join(dir, 'claude');
  await writeFile(bin, '#!/bin/sh\nexit 0\n');
  await chmod(bin, 0o755);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('buildStoryInput', () => {
  it('names the title, the episode, the synopsis and the characters, then every line', () => {
    expect(buildStoryInput(INPUT)).toBe(
      [
        'Title: One Piece (1999)',
        'Episode: S18E760 "Destruction of the Capital", aired 2016-10-16',
        "TMDB's synopsis: Jack brings out his secret weapon.",
        'Characters of the title: Monkey D. Luffy (voice); Nami (voice)',
        '',
        'The subtitle, every line with its minute:',
        '[10:55] ...Jack!',
        '[12:03] It was a poison-gas weapon.',
      ].join('\n'),
    );
    expect(buildStoryInput({ ...INPUT, title: 'Oldboy (2003)', code: null, episodeName: null, airDate: null, overview: ' ', characters: [] })).toBe(
      ['Title: Oldboy (2003)', '', 'The subtitle, every line with its minute:', INPUT.dialogue].join('\n'),
    );
  });
});

describe('createStoryWriter', () => {
  it('asks the model once, with no tools and no session, and answers its text', async () => {
    const seen: Array<{ prompt: unknown; options: Options }> = [];
    const query: QueryFn = ({ prompt, options }) => {
      seen.push({ prompt, options });
      return (async function* () {
        yield result('  Jack gasses Zou.\n\nSanji arrives.  ');
      })();
    };
    const writer = createStoryWriter({ claudeBin: bin, cwd: path.join(dir, 'cwd'), query });
    expect(writer?.model).toBe(DEFAULT_STORY_MODEL);
    expect(await writer?.write(INPUT)).toBe('Jack gasses Zou.\n\nSanji arrives.');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.prompt).toBe(buildStoryInput(INPUT));
    expect(seen[0]?.options).toMatchObject({ model: DEFAULT_STORY_MODEL, tools: [], allowedTools: [], mcpServers: {}, maxTurns: 1, persistSession: false, systemPrompt: STORY_SYSTEM_PROMPT });
    expect(STORY_SYSTEM_PROMPT).toMatch(/every spoiler/);
    expect(STORY_SYSTEM_PROMPT).toMatch(/do not invent/);
  });

  it('rejects when the model fails or answers nothing, and is null without a claude binary', async () => {
    const failing: QueryFn = () =>
      (async function* () {
        yield result('rate limited', true);
      })();
    await expect(createStoryWriter({ claudeBin: bin, cwd: dir, query: failing })?.write(INPUT)).rejects.toThrow(/rate limited/);
    const silent: QueryFn = () => (async function* () {})();
    await expect(createStoryWriter({ claudeBin: bin, cwd: dir, query: silent })?.write(INPUT)).rejects.toThrow(/answered nothing/);
    expect(createStoryWriter({ claudeBin: path.join(dir, 'missing'), cwd: dir, baseEnv: { PATH: dir + '/nowhere' } })).toBeNull();
  });
});

describe('MovieStories', () => {
  const SOURCE: MovieStorySource = { url: 'https://onepiece.fandom.com/wiki/Episode_760', title: 'Episode 760', site: 'Fandom' };
  const META = {
    kind: 'tv', tmdbId: 37854, title: 'One Piece', originalTitle: 'ONE PIECE', year: 1999, releaseDate: '1999-10-20', overview: 'A boy wants to be King of the Pirates.',
    credits: [{ personId: 1, name: 'Mayumi Tanaka', profilePath: null, role: 'cast', character: 'Monkey D. Luffy (voice)', job: null }],
    episodes: [
      { season: 18, episode: 760, name: 'Destruction of the Capital', airDate: '2016-10-16', runtimeMin: 24, overview: 'Jack brings out his secret weapon.', stillPath: null },
      { season: 18, episode: 759, name: 'Zou Falls', airDate: '2016-10-09', runtimeMin: 24, overview: null, stillPath: null },
      { season: 18, episode: 761, name: 'Not Yet', airDate: '2099-01-01', runtimeMin: 24, overview: null, stillPath: null },
    ],
  } as unknown as TitleMetadata;
  const FILM = { kind: 'movie', tmdbId: 670, title: 'Oldboy', originalTitle: '올드보이', year: 2003, releaseDate: '2003-11-21', overview: 'A man is locked up for 15 years.', credits: [], episodes: [] } as unknown as TitleMetadata;
  const DIALOGUE: StoredDialogue = { provider: 'VidNest Anime', cues: 2, lastCueS: 723, body: '10:55\t...Jack!\n12:03\tIt was a poison-gas weapon.', fetchedAt: new Date('2026-11-16T05:00:00Z'), cached: true, story: null };

  interface Row {
    titleId: string;
    season: number;
    episode: number;
    text: string;
    sections: MovieStorySection[];
    sources: MovieStorySource[];
    origin: 'web' | 'dialogue';
    model: string | null;
    writtenAt: Date;
  }

  /** `told`: the episodes the fake web finds a recap of (0: the film); `web: null` / `writer: null`: that writer is off. */
  function setup(over: { told?: ReadonlySet<number>; web?: WebStoryWriter | null; writer?: StoryWriter | null; dialogue?: () => Promise<StoredDialogue | null>; meta?: TitleMetadata | null; rows?: Map<string, Row> } = {}) {
    const rows = over.rows ?? new Map<string, Row>();
    const told = over.told ?? new Set([759, 760]);
    const write = vi.fn(async (_input: StoryInput) => 'Jack gasses Zou.\n\nSanji arrives.');
    const webWrite = vi.fn(
      async (input: WebStoryInput): Promise<WrittenWebStory> => ({
        sections: input.episodes.map((e) => ({ episode: e.episode, name: e.name, text: told.has(e.episode) ? `Recap ${e.episode}.` : '', found: told.has(e.episode) })),
        sources: input.episodes.some((e) => told.has(e.episode)) ? [SOURCE] : [],
      }),
    );
    const writer = over.writer === undefined ? { model: 'sonnet', write } : over.writer;
    const web = over.web === undefined ? { model: 'web-sonnet', write: webWrite } : over.web;
    const dialogue = vi.fn(over.dialogue ?? (async () => DIALOGUE));
    const saveStory = vi.fn(async (input: Row) => {
      rows.set(`${input.titleId} ${input.season} ${input.episode}`, input);
    });
    const repo = {
      story: async (titleId: string, season: number, episode: number) => rows.get(`${titleId} ${season} ${episode}`) ?? null,
      saveStory,
      dialogue: async () => ({ provider: DIALOGUE.provider, cues: DIALOGUE.cues }),
      loadTitleMetadata: async () => (over.meta === undefined ? META : over.meta),
    } as unknown as MovieStoriesOptions['repo'];
    const stories = new MovieStories({ repo, dialogue, writer, webWriter: web, now: () => new Date('2026-11-16T06:00:00Z'), log: () => undefined });
    return { stories, write, webWrite, dialogue, saveStory, rows };
  }

  it("writes a season's story from the web once: one section per aired episode, its sources, never a subtitle", async () => {
    const t = setup();
    const first = await t.stories.write('tv-37854', 18, 0);
    expect(first.cached).toBe(false);
    expect(first.story).toEqual({
      season: 18,
      episode: 0,
      text: 'S18E759 · Zou Falls\n\nRecap 759.\n\nS18E760 · Destruction of the Capital\n\nRecap 760.',
      origin: 'web',
      sources: [SOURCE],
      sections: [
        { episode: 759, name: 'Zou Falls', text: 'Recap 759.', found: true },
        { episode: 760, name: 'Destruction of the Capital', text: 'Recap 760.', found: true },
      ],
      model: 'web-sonnet',
      written_at: '2026-11-16T06:00:00.000Z',
      provider: null,
      cues: null,
    });
    // The unaired 761 is not asked about; the episodes go in order.
    expect(t.webWrite.mock.calls[0]?.[0]).toEqual({
      title: 'One Piece (1999)', originalTitle: 'ONE PIECE', overview: 'A boy wants to be King of the Pirates.', scope: 'season', season: 18,
      episodes: [{ episode: 759, name: 'Zou Falls', airDate: '2016-10-09' }, { episode: 760, name: 'Destruction of the Capital', airDate: '2016-10-16' }],
    });
    expect(t.dialogue).not.toHaveBeenCalled();
    expect(t.write).not.toHaveBeenCalled();
    expect(await t.stories.writeSeason('tv-37854', 18)).toEqual({ story: first.story, cached: true });
  });

  it('answers a stored story from the store without calling a model', async () => {
    const t = setup();
    const season = await t.stories.write('tv-37854', 18, 0);
    const episode = await t.stories.write('tv-37854', 18, 760);
    expect(t.webWrite).toHaveBeenCalledTimes(2);
    // Both writers off: a stored story is still answered, and nothing is called.
    const off = setup({ rows: t.rows, web: null, writer: null });
    expect(await off.stories.write('tv-37854', 18, 0)).toEqual({ story: season.story, cached: true });
    expect(await off.stories.write('tv-37854', 18, 760)).toEqual({ story: episode.story, cached: true });
    expect(await off.stories.get('tv-37854', 18, 0)).toEqual(season.story);
    expect(off.webWrite).not.toHaveBeenCalled();
    expect(off.dialogue).not.toHaveBeenCalled();
    expect(t.webWrite).toHaveBeenCalledTimes(2);
  });

  it('says so in the section of an episode no source tells, and keeps nothing when no episode is told', async () => {
    const some = setup({ told: new Set([760]) });
    const { story } = await some.stories.write('tv-37854', 18, 0);
    expect(story.sections).toEqual([
      { episode: 759, name: 'Zou Falls', text: '', found: false },
      { episode: 760, name: 'Destruction of the Capital', text: 'Recap 760.', found: true },
    ]);
    expect(story.text).toBe(`S18E759 · Zou Falls\n\n${NO_RECAP_TEXT}\n\nS18E760 · Destruction of the Capital\n\nRecap 760.`);
    const none = setup({ told: new Set() });
    await expect(none.stories.write('tv-37854', 18, 0)).rejects.toMatchObject({ code: 'no_story_source' });
    expect(none.saveStory).not.toHaveBeenCalled();
    expect(await none.stories.get('tv-37854', 18, 0)).toBeNull();
    expect(none.dialogue).not.toHaveBeenCalled();
  });

  it('refuses a season with no aired episode, a season of a film, and season 0', async () => {
    await expect(setup().stories.write('tv-37854', 19, 0)).rejects.toMatchObject({ code: 'not_found' });
    await expect(setup({ meta: FILM }).stories.write('movie-670', 1, 0)).rejects.toMatchObject({ code: 'not_found' });
    await expect(setup().stories.writeSeason('tv-37854', 0)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('writes an episode from the web first, and reads its subtitle only when the web has none', async () => {
    const t = setup({ told: new Set([759]) });
    const web = await t.stories.write('tv-37854', 18, 759);
    expect(web).toEqual({
      cached: false,
      story: { season: 18, episode: 759, text: 'Recap 759.', origin: 'web', sources: [SOURCE], sections: [], model: 'web-sonnet', written_at: '2026-11-16T06:00:00.000Z', provider: null, cues: null },
    });
    expect(t.webWrite.mock.calls[0]?.[0]).toMatchObject({ scope: 'episode', season: 18, episodes: [{ episode: 759, name: 'Zou Falls', airDate: '2016-10-09' }] });
    expect(t.dialogue).not.toHaveBeenCalled();

    const sub = await t.stories.write('tv-37854', 18, 760);
    expect(sub).toEqual({
      cached: false,
      story: { season: 18, episode: 760, text: 'Jack gasses Zou.\n\nSanji arrives.', origin: 'dialogue', sources: [], sections: [], model: 'sonnet', written_at: '2026-11-16T06:00:00.000Z', provider: 'VidNest Anime', cues: 2 },
    });
    expect(t.webWrite).toHaveBeenCalledTimes(2);
    expect(t.dialogue).toHaveBeenCalledWith({ kind: 'tv', tmdbId: 37854, season: 18, episode: 760 });
    expect(t.write.mock.calls[0]?.[0]).toMatchObject({ code: 'S18E760', dialogue: '[10:55] ...Jack!\n[12:03] It was a poison-gas weapon.' });
    expect(await t.stories.get('tv-37854', 18, 760)).toEqual(sub.story);
  });

  it('writes a film from the web first', async () => {
    const t = setup({ meta: FILM, told: new Set([0]) });
    const film = await t.stories.write('movie-670', 0, 0);
    expect(film.story).toMatchObject({ season: 0, episode: 0, origin: 'web', text: 'Recap 0.', sources: [SOURCE] });
    expect(t.webWrite.mock.calls[0]?.[0]).toEqual({
      title: 'Oldboy (2003)', originalTitle: '올드보이', overview: 'A man is locked up for 15 years.', scope: 'film', season: 0, episodes: [{ episode: 0, name: null, airDate: '2003-11-21' }],
    });
    expect(t.dialogue).not.toHaveBeenCalled();
  });

  it('two requests for the same story share one write', async () => {
    const t = setup();
    const [a, b] = await Promise.all([t.stories.write('tv-37854', 18, 0), t.stories.write('tv-37854', 18, 0)]);
    expect(a.story).toEqual(b.story);
    expect(t.webWrite).toHaveBeenCalledTimes(1);
    expect(t.saveStory).toHaveBeenCalledTimes(1);
  });

  it('says why there is no story, and keeps nothing', async () => {
    const off = setup({ web: null, writer: null });
    await expect(off.stories.write('tv-37854', 18, 760)).rejects.toMatchObject({ code: 'story_off' });
    await expect(setup({ web: null }).stories.write('tv-37854', 18, 0)).rejects.toMatchObject({ code: 'story_off' });
    expect(off.dialogue).not.toHaveBeenCalled();
    await expect(setup({ meta: null }).stories.write('tv-1', 1, 1)).rejects.toMatchObject({ code: 'not_found' });
    await expect(setup({ meta: FILM }).stories.write('movie-670', 1, 2)).rejects.toMatchObject({ code: 'not_found' });

    const noDialogue = setup({ told: new Set(), dialogue: async () => null });
    await expect(noDialogue.stories.write('tv-37854', 18, 760)).rejects.toMatchObject({ code: 'no_story_source' });
    const noSubtitle = setup({ told: new Set(), dialogue: async () => Promise.reject(new DirectStreamError('no_subtitle', 'no English subtitle')) });
    await expect(noSubtitle.stories.write('tv-37854', 18, 760)).rejects.toMatchObject({ code: 'no_story_source' });
    // A subtitle that could not be read for another reason is that reason, as before.
    const resolveFailed = setup({ told: new Set(), dialogue: async () => Promise.reject(new DirectStreamError('resolve_failed', 'Chrome did not answer')) });
    await expect(resolveFailed.stories.write('tv-37854', 18, 760)).rejects.toBeInstanceOf(DirectStreamError);

    // A failed web run is not "the web has none": no subtitle is read.
    const webFails = setup({ web: { model: 'web-sonnet', write: async () => Promise.reject(new Error('no story within 420 s')) } });
    const err = await webFails.stories.write('tv-37854', 18, 760).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoryError);
    expect(err).toMatchObject({ code: 'story_failed', message: expect.stringContaining('420 s') });
    expect(webFails.dialogue).not.toHaveBeenCalled();
    const dialogueFails = setup({ told: new Set(), writer: { model: 'sonnet', write: async () => Promise.reject(new Error('rate limited')) } });
    await expect(dialogueFails.stories.write('tv-37854', 18, 760)).rejects.toMatchObject({ code: 'story_failed' });

    for (const t of [noDialogue, noSubtitle, resolveFailed, webFails, dialogueFails]) expect(t.saveStory).not.toHaveBeenCalled();
    // A failed write is not remembered: the next press tries again.
    await expect(webFails.stories.write('tv-37854', 18, 760)).rejects.toMatchObject({ code: 'story_failed' });
  });
});
