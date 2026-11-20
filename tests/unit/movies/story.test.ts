import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryFn } from '../../../src/chat/agent.js';
import type { MovieDialogueRow, MovieStoryRow } from '../../../src/db/schema.js';
import type { NewMovieStory } from '../../../src/movies/repo.js';
import type { StoredDialogue } from '../../../src/directStream/dialogueStore.js';
import { DirectStreamError } from '../../../src/directStream/types.js';
import { DEFAULT_STORY_MODEL, MovieStories, STORY_SYSTEM_PROMPT, StoryError, buildStoryInput, createStoryWriter, type StoryInput, type StoryWriter } from '../../../src/movies/story.js';
import type { TitleMetadata } from '../../../src/movies/types.js';

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
  const META = {
    kind: 'tv', tmdbId: 37854, title: 'One Piece', year: 1999, overview: 'A boy wants to be King of the Pirates.',
    credits: [{ personId: 1, name: 'Mayumi Tanaka', profilePath: null, role: 'cast', character: 'Monkey D. Luffy (voice)', job: null }, { personId: 2, name: 'X', profilePath: null, role: 'director', character: null, job: 'Director' }],
    episodes: [{ season: 18, episode: 760, name: 'Destruction of the Capital', airDate: '2016-10-16', runtimeMin: 24, overview: 'Jack brings out his secret weapon.', stillPath: null }],
  } as unknown as TitleMetadata;
  const DIALOGUE: StoredDialogue = { provider: 'VidNest Anime', cues: 2, lastCueS: 723, body: '10:55\t...Jack!\n12:03\tIt was a poison-gas weapon.', fetchedAt: new Date('2026-11-16T05:00:00Z'), cached: true, story: null };

  function setup(over: { writer?: StoryWriter | null; dialogue?: () => Promise<StoredDialogue | null>; meta?: TitleMetadata | null; stored?: MovieStoryRow[] } = {}) {
    const rows = new Map<string, MovieStoryRow>((over.stored ?? []).map((r) => [`${r.titleId} ${r.season} ${r.episode}`, r]));
    const write = vi.fn(async (_input: StoryInput) => 'Jack gasses Zou.\n\nSanji arrives.');
    const writer = over.writer === undefined ? { model: 'sonnet', write } : over.writer;
    const dialogue = vi.fn(over.dialogue ?? (async () => DIALOGUE));
    const saveStory = vi.fn(async (row: NewMovieStory) => {
      const kept: MovieStoryRow = { sections: [], sources: [], ...row };
      rows.set(`${row.titleId} ${row.season} ${row.episode}`, kept);
      return kept;
    });
    const dialogueRow = (titleId: string, season: number, episode: number): MovieDialogueRow => ({
      titleId, season, episode, lang: 'en', provider: 'VidNest Anime', cues: 2, lastCueS: 723, body: DIALOGUE.body, fetchedAt: DIALOGUE.fetchedAt, story: null, storyModel: null, storyAt: null,
    });
    const stories = new MovieStories({
      repo: {
        story: async (titleId, season, episode) => rows.get(`${titleId} ${season} ${episode}`) ?? null,
        dialogue: async (titleId, season, episode) => dialogueRow(titleId, season, episode),
        saveStory,
        loadTitleMetadata: async () => (over.meta === undefined ? META : over.meta),
      },
      dialogue,
      writer,
      now: () => new Date('2026-11-16T06:00:00Z'),
      log: () => undefined,
    });
    return { stories, write, dialogue, saveStory };
  }

  it('writes a story once from the dialogue, keeps it, and answers the stored one after that without a model call', async () => {
    const t = setup();
    expect(await t.stories.get('tv-37854', 18, 760)).toBeNull();
    const first = await t.stories.write('tv-37854', 18, 760);
    expect(first).toEqual({
      cached: false,
      story: { season: 18, episode: 760, text: 'Jack gasses Zou.\n\nSanji arrives.', model: 'sonnet', written_at: '2026-11-16T06:00:00.000Z', provider: 'VidNest Anime', cues: 2 },
    });
    expect(t.dialogue).toHaveBeenCalledWith({ kind: 'tv', tmdbId: 37854, season: 18, episode: 760 });
    expect(t.write.mock.calls[0]?.[0]).toMatchObject({
      title: 'One Piece (1999)', code: 'S18E760', episodeName: 'Destruction of the Capital', airDate: '2016-10-16', overview: 'Jack brings out his secret weapon.',
      characters: ['Monkey D. Luffy (voice)'], dialogue: '[10:55] ...Jack!\n[12:03] It was a poison-gas weapon.',
    });
    const again = await t.stories.write('tv-37854', 18, 760);
    expect(again.cached).toBe(true);
    expect(again.story.text).toBe(first.story.text);
    expect(t.write).toHaveBeenCalledTimes(1);
    expect(await t.stories.get('tv-37854', 18, 760)).toMatchObject({ text: first.story.text, model: 'sonnet' });
    expect(t.saveStory).toHaveBeenCalledWith({ titleId: 'tv-37854', season: 18, episode: 760, text: 'Jack gasses Zou.\n\nSanji arrives.', origin: 'dialogue', model: 'sonnet', writtenAt: new Date('2026-11-16T06:00:00Z') });
  });

  it('answers a story already in the store without a model call or a dialogue read (R6.5)', async () => {
    const stored: MovieStoryRow = {
      titleId: 'tv-37854', season: 18, episode: 760, text: 'Kept from before.', sections: [], sources: [], origin: 'dialogue', model: 'haiku', writtenAt: new Date('2026-11-01T00:00:00Z'),
    };
    const t = setup({ stored: [stored] });
    expect(await t.stories.write('tv-37854', 18, 760)).toEqual({
      cached: true,
      story: { season: 18, episode: 760, text: 'Kept from before.', model: 'haiku', written_at: '2026-11-01T00:00:00.000Z', provider: 'VidNest Anime', cues: 2 },
    });
    expect(t.write).not.toHaveBeenCalled();
    expect(t.dialogue).not.toHaveBeenCalled();
    expect(t.saveStory).not.toHaveBeenCalled();
    // Stories are off here, and a stored one still opens.
    expect((await setup({ writer: null, stored: [stored] }).stories.write('tv-37854', 18, 760)).cached).toBe(true);
  });

  it('two requests for the same story share one write', async () => {
    const t = setup();
    const [a, b] = await Promise.all([t.stories.write('tv-37854', 18, 760), t.stories.write('tv-37854', 18, 760)]);
    expect(a.story.text).toBe(b.story.text);
    expect(t.write).toHaveBeenCalledTimes(1);
    expect(t.saveStory).toHaveBeenCalledTimes(1);
  });

  it('says why there is no story, and keeps nothing', async () => {
    const off = setup({ writer: null });
    await expect(off.stories.write('tv-37854', 18, 760)).rejects.toMatchObject({ code: 'story_off' });
    expect(off.dialogue).not.toHaveBeenCalled();
    await expect(setup({ meta: null }).stories.write('tv-1', 1, 1)).rejects.toMatchObject({ code: 'not_found' });
    await expect(setup({ dialogue: async () => null }).stories.write('tv-37854', 18, 760)).rejects.toMatchObject({ code: 'no_dialogue' });
    const noSubtitle = setup({ dialogue: async () => Promise.reject(new DirectStreamError('no_subtitle', 'no English subtitle')) });
    await expect(noSubtitle.stories.write('tv-37854', 18, 760)).rejects.toBeInstanceOf(DirectStreamError);
    const failing = setup({ writer: { model: 'sonnet', write: async () => Promise.reject(new Error('no story within 240 s')) } });
    const err = await failing.stories.write('tv-37854', 18, 760).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoryError);
    expect(err).toMatchObject({ code: 'story_failed', message: expect.stringContaining('240 s') });
    expect(failing.saveStory).not.toHaveBeenCalled();
    // A failed write is not remembered: the next press tries again.
    await expect(failing.stories.write('tv-37854', 18, 760)).rejects.toMatchObject({ code: 'story_failed' });
  });
});
