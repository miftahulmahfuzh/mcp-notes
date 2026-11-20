import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QueryFn } from '../../../src/chat/agent.js';
import {
  buildWebStoryInput,
  createWebStoryWriter,
  parseWebStory,
  searchedKeys,
  sourceKey,
  WEB_STORY_MAX_TURNS,
  WEB_STORY_SYSTEM_PROMPT,
  type WebStoryEpisode,
  type WebStoryInput,
} from '../../../src/movies/webStory.js';

const WIKI = 'https://en.wikipedia.org/wiki/List_of_MobLand_episodes';
const FANDOM = 'https://mobland.fandom.com/wiki/Episode_Two';
const EPISODES: WebStoryEpisode[] = [
  { episode: 1, name: 'Stick or Twist', airDate: '2025-03-30' },
  { episode: 2, name: 'Episode Two', airDate: '2025-04-06' },
  { episode: 3, name: 'Episode Three', airDate: '2025-04-13' },
];
const SEASON: WebStoryInput = { title: 'MobLand (2025)', originalTitle: null, overview: 'Two crime families.', scope: 'season', season: 1, episodes: EPISODES };

const toolResult = (content: string): SDKMessage =>
  ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content }] }, parent_tool_use_id: null, session_id: 'x' }) as unknown as SDKMessage;
const assistantText = (t: string): SDKMessage => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] }, parent_tool_use_id: null, session_id: 'x' }) as unknown as SDKMessage;
const result = (t: string): SDKMessage => ({ type: 'result', subtype: 'success', is_error: false, result: t }) as unknown as SDKMessage;

describe('buildWebStoryInput', () => {
  it('names the title, says the synopsis is no source, and lists what is asked with a length', () => {
    expect(buildWebStoryInput(SEASON)).toBe(
      [
        'Title: MobLand (2025), a series',
        "TMDB's synopsis, only to tell the title apart from a namesake (it is not a source): Two crime families.",
        '',
        'Asked for: the whole of season 1, one section for each of its 3 episodes:',
        '- Episode 1 "Stick or Twist", aired 2025-03-30',
        '- Episode 2 "Episode Two", aired 2025-04-06',
        '- Episode 3 "Episode Three", aired 2025-04-13',
        'Length: about 150 to 300 words per section.',
      ].join('\n'),
    );
    expect(buildWebStoryInput({ ...SEASON, scope: 'episode', episodes: [{ episode: 2, name: null, airDate: null }], originalTitle: 'MobLand', overview: null })).toBe(
      ['Title: MobLand (2025), a series', 'Original title: MobLand', '', 'Asked for: one episode of season 1, as one section:', '- Episode 2', 'Length: about 400 to 800 words.'].join('\n'),
    );
    expect(buildWebStoryInput({ title: 'Oldboy (2003)', originalTitle: '올드보이', overview: null, scope: 'film', season: 0, episodes: [{ episode: 0, name: null, airDate: '2003-11-21' }] })).toBe(
      ['Title: Oldboy (2003), a film', 'Original title: 올드보이', '', 'Asked for: the whole film, as one section with episode 0.', 'Length: about 900 to 1600 words.'].join('\n'),
    );
    const long = Array.from({ length: 27 }, (_, i) => ({ episode: i + 1, name: null, airDate: null }));
    expect(buildWebStoryInput({ ...SEASON, episodes: long })).toMatch(/about 60 to 120 words per section\.$/);
  });
});

describe('sourceKey and searchedKeys', () => {
  it('names one page however its URL is written, and nothing that is not http(s)', () => {
    expect(sourceKey('https://www.en.wikipedia.org/wiki/List_of_MobLand_episodes/#Season_1')).toBe(sourceKey(WIKI));
    expect(sourceKey('https://en.wikipedia.org/wiki/MobLand_(TV_series)')).toBe(sourceKey('https://en.wikipedia.org/wiki/MobLand_%28TV_series%29'));
    expect(sourceKey('ftp://example.com/x')).toBeNull();
    expect(sourceKey('not a url')).toBeNull();
  });

  it('reads the pages a search result showed, and never what the model wrote itself', () => {
    const keys = searchedKeys(toolResult(`Links: [{"title":"List of MobLand episodes","url":"${WIKI}"},{"title":"MobLand","url":"https://en.wikipedia.org/wiki/MobLand_(TV_series)"}]`));
    expect(keys).toContain(sourceKey(WIKI));
    expect(keys).toContain(sourceKey('https://en.wikipedia.org/wiki/MobLand_(TV_series)'));
    expect(searchedKeys(assistantText(`I remember ${FANDOM}`))).toEqual([]);
    expect(searchedKeys(result(WIKI))).toEqual([]);
  });
});

describe('parseWebStory', () => {
  const seen = new Set([sourceKey(WIKI), sourceKey(FANDOM)].filter((k): k is string => k !== null));

  it('keeps one section per episode asked, told only from pages the searches returned, and the sources those sections cite', () => {
    const answer = `Here it is:\n${JSON.stringify({
      sections: [
        { episode: 1, found: true, text: ' Harry fixes it. ', sources: [`${WIKI}#Season_1`] },
        { episode: 2, found: true, text: 'Remembered, not searched.', sources: ['https://example.com/made-up'] },
        { episode: 9, found: true, text: 'An episode that does not exist.', sources: [WIKI] },
        { episode: 1, found: true, text: 'A second telling.', sources: [WIKI] },
      ],
      sources: [
        { url: WIKI, title: 'List of MobLand episodes', site: 'Wikipedia' },
        { url: FANDOM, title: 'Episode Two', site: 'Fandom' },
        { url: 'https://example.com/made-up', title: 'Made up', site: 'Example' },
        { url: 'ftp://x' },
      ],
    })}\nDone.`;
    expect(parseWebStory(answer, EPISODES, seen)).toEqual({
      sections: [
        { episode: 1, name: 'Stick or Twist', text: 'Harry fixes it.', found: true },
        { episode: 2, name: 'Episode Two', text: '', found: false },
        { episode: 3, name: 'Episode Three', text: '', found: false },
      ],
      sources: [{ url: WIKI, title: 'List of MobLand episodes', site: 'Wikipedia' }],
    });
  });

  it('marks an episode untold when it says found false, even with text', () => {
    const answer = JSON.stringify({ sections: [{ episode: 1, found: false, text: 'A guess.', sources: [WIKI] }], sources: [{ url: WIKI, title: 'x', site: 'Wikipedia' }] });
    expect(parseWebStory(answer, EPISODES.slice(0, 1), seen)).toEqual({ sections: [{ episode: 1, name: 'Stick or Twist', text: '', found: false }], sources: [] });
  });

  it('with no search results to check against (SEARCH_RESULTS_CARRY_URLS false), keeps a section only when it names an http(s) source its answer lists', () => {
    const answer = JSON.stringify({
      sections: [
        { episode: 1, found: true, text: 'Harry fixes it.', sources: [WIKI] },
        { episode: 2, found: true, text: 'No listed source.', sources: ['https://example.com/unlisted'] },
        { episode: 3, found: true, text: 'No source at all.', sources: [] },
      ],
      sources: [{ url: WIKI, title: 'List of MobLand episodes', site: 'Wikipedia' }, { url: 'ftp://x', title: 'x', site: 'x' }],
    });
    expect(parseWebStory(answer, EPISODES, null)).toEqual({
      sections: [
        { episode: 1, name: 'Stick or Twist', text: 'Harry fixes it.', found: true },
        { episode: 2, name: 'Episode Two', text: '', found: false },
        { episode: 3, name: 'Episode Three', text: '', found: false },
      ],
      sources: [{ url: WIKI, title: 'List of MobLand episodes', site: 'Wikipedia' }],
    });
  });

  it('refuses an answer with no JSON, bad JSON or no sections', () => {
    expect(() => parseWebStory('I could not search.', EPISODES, seen)).toThrow(/no JSON/);
    expect(() => parseWebStory('{"sections": [}', EPISODES, seen)).toThrow(/does not parse/);
    expect(() => parseWebStory('{"sources": []}', EPISODES, seen)).toThrow(/no sections/);
  });
});

describe('createWebStoryWriter', () => {
  let dir: string;
  let bin: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'notesd-web-story-'));
    bin = path.join(dir, 'claude');
    await writeFile(bin, '#!/bin/sh\n');
    await chmod(bin, 0o755);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs with WebSearch as its one tool and keeps only the pages its searches returned', async () => {
    const seenRuns: Array<{ prompt: unknown; options: Options }> = [];
    const query: QueryFn = ({ prompt, options }) => {
      seenRuns.push({ prompt, options });
      return (async function* () {
        yield toolResult(`Links: [{"title":"List of MobLand episodes","url":"${WIKI}"}]`);
        yield assistantText(`I also remember ${FANDOM}`);
        yield result(
          JSON.stringify({
            sections: [
              { episode: 1, found: true, text: 'Harry fixes it.', sources: [WIKI] },
              { episode: 2, found: true, text: 'From memory.', sources: [FANDOM] },
            ],
            sources: [
              { url: WIKI, title: 'List of MobLand episodes', site: 'Wikipedia' },
              { url: FANDOM, title: 'Episode Two', site: 'Fandom' },
            ],
          }),
        );
      })();
    };
    const writer = createWebStoryWriter({ claudeBin: bin, cwd: path.join(dir, 'cwd'), model: 'sonnet', query });
    expect(writer?.model).toBe('sonnet');
    const written = await writer?.write(SEASON);
    expect(written?.sections.map((s) => [s.episode, s.found])).toEqual([[1, true], [2, false], [3, false]]);
    expect(written?.sources).toEqual([{ url: WIKI, title: 'List of MobLand episodes', site: 'Wikipedia' }]);
    expect(seenRuns).toHaveLength(1);
    expect(seenRuns[0]?.prompt).toBe(buildWebStoryInput(SEASON));
    expect(seenRuns[0]?.options).toMatchObject({
      model: 'sonnet', tools: ['WebSearch'], allowedTools: ['WebSearch'], mcpServers: {}, settingSources: [], maxTurns: WEB_STORY_MAX_TURNS, persistSession: false, systemPrompt: WEB_STORY_SYSTEM_PROMPT,
    });
  });

  it('asks for the source order, one section per episode, and never an invented one', () => {
    for (const re of [/Wikipedia/, /List of <series> episodes/, /fandom\.com/, /Dramabeans/, /Vulture/, /The A\.V\. Club/, /Den of Geek/, /set its found to false/, /never a URL you built or remember/, /exactly one for each episode/]) {
      expect(WEB_STORY_SYSTEM_PROMPT).toMatch(re);
    }
  });

  it('rejects an answer it cannot read, and is null without a claude binary', async () => {
    const prose: QueryFn = () =>
      (async function* () {
        yield result('Sorry, I found nothing.');
      })();
    await expect(createWebStoryWriter({ claudeBin: bin, cwd: dir, model: 'sonnet', query: prose })?.write(SEASON)).rejects.toThrow(/no JSON/);
    const silent: QueryFn = () => (async function* () {})();
    await expect(createWebStoryWriter({ claudeBin: bin, cwd: dir, model: 'sonnet', query: silent })?.write(SEASON)).rejects.toThrow(/answered nothing/);
    expect(createWebStoryWriter({ claudeBin: path.join(dir, 'missing'), cwd: dir, model: 'sonnet', baseEnv: { PATH: `${dir}/nowhere` } })).toBeNull();
  });
});
