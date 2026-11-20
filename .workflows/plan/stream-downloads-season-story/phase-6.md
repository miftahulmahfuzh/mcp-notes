# Phase 6: Stories from the web: the season story, the episode story web-first

**Plan set:** `STREAM_DOWNLOADS_SEASON_STORY_PLAN.md`
**Analysis:** `.workflows/analyze/20261120-213359-K7Q2_code_analyzer.md`
**Satisfies:** R6 — "Narrate the full story of SXX" on the season row, written from websites that tell full stories instead of from subtitles
**Criteria:** R6.1, R6.2, R6.4, R6.5, R6.6
**Depends on:** Phase 1
**Difficulty:** HARD
**Package:** `src/movies`, `src/http`

---

## Goal

After this phase the daemon can write a season's whole story, one section per aired episode, from published recaps Claude finds with WebSearch (Wikipedia, then the series' Fandom wiki, then Dramabeans, Vulture, The A.V. Club and Den of Geek), naming its sources. An episode no page tells is marked `found: false` and is never made up. An episode's or a film's story is now web-first too, and its subtitle is read only when the web has nothing. Every story is kept in `movie_stories` (phase 1) and answered from there without a model. The story routes accept `{season}` without an episode, answer `origin`, `sources` and `sections`, and the title detail carries `has_story` per season.

## Interface Contract

**Deletes:**
- `StoryError` code `no_dialogue` (`src/movies/story.ts:167`). It becomes `no_story_source`: nothing on the web, and no subtitle either.
- The refine `'a season needs an episode'` on `storySlot` (`src/http/moviesApi.ts:206-208`). A season alone is now valid.
- The private copies of the Agent SDK run loop in `createStoryWriter` (`story.ts:98-148`) and `createGuideWriter` (`guides.ts:299-348`). Both move into `runAgentText`.

**Renames:** none

**Creates:**
- `src/movies/agentText.ts`: `AgentTextRun`, `agentOptions(run, abortController)`, `runAgentText(run, prompt): Promise<string>`.
- `src/movies/webStory.ts`:
  - `WEB_STORY_SYSTEM_PROMPT`, `WEB_STORY_MAX_TURNS = 32`, `DEFAULT_WEB_STORY_TIMEOUT_MS = 420_000`, `WEB_STORY_SOURCES_KEPT = 24`, `LONG_SEASON_EPISODES = 26`
  - `WebStoryScope = 'season' | 'episode' | 'film'`, `WebStoryEpisode`, `WebStoryInput`, `WrittenWebStory`
  - `buildWebStoryInput`, `sourceKey`, `searchedKeys`, `parseWebStory`
  - `SEARCH_RESULTS_CARRY_URLS` (settled by Step 0 from the installed SDK: whether a run's WebSearch results reach `onMessage` with their URLs)
  - `WebStoryWriter`, `WebStoryWriterOptions`, `createWebStoryWriter`
- `src/movies/story.ts`:
  - `NO_RECAP_TEXT`, `StoryOrigin`, `seasonText(season, sections)`
  - `MovieStories.writeSeason(titleId, season)`
  - `MovieStoriesOptions.webWriter`
- `SeasonView.has_story: boolean` (`src/movies/read.ts:136`).
- `tests/live/webStory.live.test.ts` and the script `test:live:webStory` (`WEB_STORY_LIVE_TEST=1 vitest run`), one real, billed web story run, opt-in under the repo's `test:live*` convention: never part of `npm test` or `test:int`. Its switch `WEB_STORY_LIVE_TEST` gets a row in `docs/guide/reference/configuration.md` ("Tests", beside `EMBEDDINGS_LIVE_TEST`) and a branch in `vitest.config.ts` (no second config).

**Signature changes:**
- `StoryView` (`story.ts:152`) becomes `{season, episode, text, origin: 'web'|'dialogue', sources: MovieStorySource[], sections: MovieStorySection[], model: string|null, written_at: string|null, provider: string|null, cues: number|null}`. It used to be `provider: string, cues: number` with none of the three new fields. A season's story has `episode: 0`.
- `MovieStoriesOptions.repo`: `Pick<MoviesRepo, 'dialogue'|'saveStory'|'loadTitleMetadata'>` becomes `Pick<MoviesRepo, 'story'|'saveStory'|'dialogue'|'loadTitleMetadata'>`.
- `MovieStoriesOptions` gains `webWriter: WebStoryWriter | null` (required).
- `MovieStories.write(titleId, season, episode)` keeps its signature:
  - `episode === 0 && season > 0` is a season story and goes to `writeSeason`.
  - Anything else is web-first, with the dialogue route as the fallback only when the web answers `found: false`.
- `MovieStories.get(titleId, season, episode)` keeps its signature. It reads `MoviesRepo.story`; there is no separate `getSeason`, because the season story is `get(titleId, season, 0)`.
- `StoryError.code` becomes `'not_found' | 'story_off' | 'no_story_source' | 'story_failed'`.

**HTTP (story routes, `src/http/moviesApi.ts`):**
- `GET /api/movies/:id/story?season=&episode=`
  - `?season=N` alone (N > 0) is that season's story; no query is the film.
  - Answer: `{story: StoryView | null, cached: true}`. 400 `invalid_query`; 503 `story_off` without the service.
- `POST /api/movies/:id/story` with body `{season?, episode?}`. `{season: N}` alone is the season. Same-origin only.
  - 200: `{story: StoryView, cached: boolean}`.
  - 404: `not_found` (no such title, a season of a film, a series with neither a season nor an episode, or a season with no aired episode) or `no_story_source`.
  - 503: `story_off`.
  - 502: `story_failed`, or a stream error (`resolve_failed`, `open_failed`, …) from reading the subtitle, as today.
  - 400: `invalid_id` / `invalid_body`.
- `GET /api/movies/:id`: each `seasons[]` entry gains `has_story` (true when the season's story is stored).

**Requires (from earlier phases):** from Phase 1. If phase 1 chose other names, the reconciler aligns them here.
- `src/db/schema.ts` exports:
  - `movieStories`
  - `type MovieStoryRow = typeof movieStories.$inferSelect`
  - the jsonb element types `MovieStorySection {episode: number; name: string | null; text: string; found: boolean}` and `MovieStorySource {url: string; title: string; site: string}` (phase 1's names; reconciled from this plan's earlier `StorySection`/`StorySource`)
- `movie_stories` columns:
  - `title_id` text, FK to `movie_titles(id)` `on delete cascade`, so `truncateMovies`' cascade empties it
  - `season` int, `episode` int
  - `text` text not null
  - `sections` jsonb `MovieStorySection[]` not null default `[]`
  - `sources` jsonb `MovieStorySource[]` not null default `[]`
  - `origin` text not null, `web` | `dialogue`
  - `model` text null
  - `written_at` timestamptz not null
  - PK `(title_id, season, episode)`
  - Drizzle field names: `titleId, season, episode, text, sections, sources, origin, model, writtenAt`.
- `MoviesRepo.story(titleId: string, season: number, episode: number): Promise<MovieStoryRow | null>`.
- `MoviesRepo.saveStory(row: NewMovieStory): Promise<MovieStoryRow>` (phase 1: `NewMovieStory` is `MovieStoryRow` with `sections` and `sources` optional, exported from `src/movies/repo.ts`), an upsert on the PK that answers the stored row. This phase always passes `{titleId, season, episode, text, sections, sources, origin, model, writtenAt}`. `MovieStories` is its only caller.
- `MoviesRepo.dialogue(titleId, season, episode)` still answers a row with `provider` and `cues`.
- `getTitle` (`src/movies/read.ts:~1080`) builds its `stories` list from `movie_stories` (`season`, `episode`) rather than from `movie_dialogues.story` (phase 1 Step 9 replaced the fourth query of that `Promise.all` and the schema import; the `storied` lines below it are as today). This phase adds only the per-season flag beside the line that consumes it.
- `src/movies/story.ts` as phase 1 leaves it: `MovieStoriesOptions.repo` is already `Pick<MoviesRepo, 'dialogue' | 'story' | 'saveStory' | 'loadTitleMetadata'>`, `get` reads `repo.story` (filling `provider`/`cues` from the dialogue row, `''`/`0` without one), and `writeNew` calls `saveStory({titleId, season, episode, text, origin: 'dialogue', model, writtenAt})`. Step 4 replaces the whole file, superseding those edits (it keeps every behaviour they added).
- `tests/integration/movies.api.int.test.ts` as phase 1 leaves it (phase 1 changed lines 341–344 to read the story from `movie_stories`); Step 10 replaces the story block (295–362) whole.

**Leaves alone (owned by others):**
- every file under `web/` (Phase 7)
- `src/directStream/dialogue.ts` and `dialogueStore.ts` (the dialogue reader)
- `src/db/schema.ts`, `drizzle/`, `MoviesRepo` (Phase 1)
- `docs/guide/*`, `.claude/skills/verify-notesd/features/*`, `CLAUDE.md` (Phase 9); `docs/guide/reference/configuration.md` except the one `WEB_STORY_LIVE_TEST` row this phase adds (invariant 1: a new environment variable has its row in the same phase)
- the downloads routes in `scripts/docs/httpRoutes.ts` (Phase 4). This phase edits only the two story entries.
- `GenreGuides` behaviour (only its writer's run loop moves into `runAgentText`).

## Files

| File | Action | What changes |
|---|---|---|
| `src/movies/agentText.ts` | create | the one Agent SDK run loop the three movie writers share |
| `tests/live/webStory.live.test.ts` | create | one real, billed run: a found section backed by a source (Step 0's check) |
| `vitest.config.ts` | modify | `WEB_STORY_LIVE_TEST` runs only the live web story file (beside the other live switches) |
| `package.json` | modify | `"test:live:webStory": "WEB_STORY_LIVE_TEST=1 vitest run"` after `test:live:imageEmbeddings` |
| `docs/guide/reference/configuration.md:225` | modify | `WEB_STORY_LIVE_TEST` row in "Tests" (phase 2 adds rows in "Direct streaming", line 145: no dependency edge, separate places) |
| `src/movies/webStory.ts` | create | the web story writer, its system prompt, input builder and tolerant parser |
| `src/movies/story.ts` | modify (whole file replaced) | `StoryView` fields, `StoryError` codes, `MovieStories` web-first plus `writeSeason`, `createStoryWriter` on `runAgentText` |
| `src/movies/guides.ts` | modify (`:1-11`, `:287-349`) | `createGuideWriter` on `runAgentText`; unused imports dropped |
| `src/movies/read.ts` | modify (`:136-141`, `:693`, `:~1086`) | `SeasonView.has_story`, set by `getTitle` |
| `src/http/moviesApi.ts` | modify (`:63-67`, `:205-208`, `:538`, `:568-571`) | season slot, error statuses, comment |
| `src/daemon.ts` | modify (`:35`, `:513-524`) | builds the web writer and passes `webWriter` |
| `src/config.ts` | modify (`:511`, `:572-574`) | doc comments say what the story model now writes |
| `scripts/docs/httpRoutes.ts` | modify (`:204-207`) | the two story routes' descriptions |
| `docs/guide/reference/http-api.md` | regenerate | `npm run docs:gen` |
| `tests/unit/movies/webStory.test.ts` | create | input, parser, writer |
| `tests/unit/movies/story.test.ts` | modify (whole file replaced) | `MovieStories` season, web-first, fallback, errors, cache |
| `tests/integration/movies.api.int.test.ts` | modify (`:295-362`, import `:6`) | story routes for a season, web-first episode, errors |
| `tests/unit/directStream/cacheShelf.test.ts` | modify (`:106`) | `has_story: false` in the `SeasonView` fixture, which typechecks under `tsconfig.json` |

## Implementation Steps

### Step 0: Settle what a run's messages carry of a search
**Files:** none written until the answer is known; then `src/movies/webStory.ts` (`SEARCH_RESULTS_CARRY_URLS`, Step 3).
**Change:** the guard "a section counts only when it cites a URL this run's WebSearch results returned" needs the Agent
SDK's message stream to hand those results, with their URLs, to `onMessage`. Fake-writer tests cannot tell, and if it
does not, every story would answer `no_story_source`. Settle it before Step 3, from the installed code:
1. `npm ci` (the worktree has no `node_modules`).
2. Read the SDK's message types: `grep -n "SDKUserMessage\|tool_use_result\|tool_result\|web_search_tool_result\|WebSearch" node_modules/@anthropic-ai/claude-agent-sdk/*.d.ts` (and any `.d.ts` under it the hits point to; the `SDKUserMessage` that carries a tool's answer back to the model, its `message.content` blocks and its `tool_use_result` field, and the WebSearch tool's output type with its result `url`s).
3. Read how this repo reads tool results today: `grep -rn "tool_result\|tool_use_result\|type === 'user'" src/chat src/movies/guides.ts src/sessions`. (`guides.ts` reads only the final `result` message; the chat code and the session ingester are where a tool result is read, if anywhere.)
4. Decide: when a WebSearch result reaches the stream as a `user` message whose content holds a `tool_result` (or `web_search_tool_result`) block, or whose `tool_use_result` holds the results, and either carries the result URLs as text, set `SEARCH_RESULTS_CARRY_URLS = true` (the cross-check branch). Otherwise set it `false` (the fallback branch). Both branches are written in Step 3; only the constant changes. Note the answer, with the `.d.ts` line that settles it, in the commit message.
5. Confirm on demand with the opt-in live test (Step 10): `npm run test:live:webStory` runs one real, billed WebSearch run at the owner's login and passes only when a found section with a source comes back under the chosen branch. It is never part of `npm test` or `test:int`.

**The two branches** (Step 3's code):
- `true`: `searchedKeys` collects every URL in the run's tool results (content blocks and `tool_use_result`); `parseWebStory(answer, episodes, seen)` keeps a source only when its key is in `seen`, and a section is found only when it cites one such source.
- `false`: `parseWebStory(answer, episodes, null)`: a section is found only when it names at least one http(s) source that is also in the answer's `sources` list; the writer logs once per daemon run `[notesd] movies: WebSearch results could not be cross-checked (the SDK's messages carry no result URLs); a story section counts when it names a source its answer lists`. Invariant 12 still holds through the system prompt (never from memory; `found: false` where no page tells it) and the parser (an episode not asked for is dropped, a section with no listed http(s) source is `found: false`).
**Impact:** none on the tree until Step 3.

### Step 1: Lift the Agent SDK run loop into one helper
**File:** `src/movies/agentText.ts` (new)
**Change:** `story.ts:98-148` and `guides.ts:299-348` hold the same loop: options, timeout, reading the result message, and trusting a result over a non-zero exit. The web story writer would be a third copy, so the loop moves here. `onMessage` lets the web writer see each search result.
**Code:**
```ts
import { mkdir } from 'node:fs/promises';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn } from '../chat/agent.js';
import { claudeEnv } from '../chat/env.js';

/**
 * One Agent SDK run of a movies writer (story.ts, guides.ts, webStory.ts): the owner's login, no MCP
 * servers, no settings, thinking off, no persisted session, and exactly the tools named.
 */
export interface AgentTextRun {
  query: QueryFn;
  /** The claude binary findClaudeBin found. */
  claudeBin: string;
  /** Created on first use; nothing is persisted there. */
  cwd: string;
  baseEnv: NodeJS.ProcessEnv;
  model: string;
  /** [] for none; ['WebSearch'] for a writer that searches. Allowed exactly as given. */
  tools: string[];
  maxTurns: number;
  systemPrompt: string;
  timeoutMs: number;
  /** What is being written, named in the timeout error: "no story within 240 s". */
  what: string;
  /** Sees every message of the run, in order (the web story collects what its searches returned). */
  onMessage?: (message: SDKMessage) => void;
}

export function agentOptions(run: AgentTextRun, abortController: AbortController): Options {
  return {
    abortController,
    cwd: run.cwd,
    env: claudeEnv(run.baseEnv),
    model: run.model,
    pathToClaudeCodeExecutable: run.claudeBin,
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    tools: run.tools,
    allowedTools: run.tools,
    permissionMode: 'dontAsk',
    maxTurns: run.maxTurns,
    thinking: { type: 'disabled' },
    systemPrompt: run.systemPrompt,
    persistSession: false,
  };
}

/** The run's answer, trimmed and not empty. Rejects when the run fails, times out or answers nothing. */
export async function runAgentText(run: AgentTextRun, prompt: string): Promise<string> {
  await mkdir(run.cwd, { recursive: true });
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort('timeout');
  }, run.timeoutMs);
  timer.unref();
  let result: string | null = null;
  let failure: string | null = null;
  try {
    for await (const message of run.query({ prompt, options: agentOptions(run, controller) })) {
      run.onMessage?.(message);
      if (message.type !== 'result') continue;
      if (message.subtype === 'success' && !message.is_error) result = message.result;
      else if (message.subtype === 'success') failure = message.result.trim() || 'the model failed without saying why';
      else failure = message.errors.join('; ').trim() || `the model failed (${message.subtype})`;
    }
  } catch (err) {
    // A CLI that exits non-zero after its result still produced that result: trust it.
    if (result === null && failure === null) failure = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }
  const text = (result ?? '').trim();
  if (text !== '') return text;
  throw new Error(timedOut ? `no ${run.what} within ${Math.round(run.timeoutMs / 1000)} s` : (failure ?? 'the model answered nothing'));
}
```
**Impact:** none yet. Steps 2 and 4 switch the guide and the story writer over to it.

### Step 2: The genre guide writer uses the helper
**File:** `src/movies/guides.ts:1-11` (imports) and `:287-349` (`createGuideWriter`)
**Change:** Replace the import block at lines 1-11 with the block below. It drops `mkdir`, `Options` and `claudeEnv`, which are now unused, and adds `runAgentText`. Replace `createGuideWriter` (the doc comment at 287-291 and the body at 292-349) with the code below. Behaviour is the same: the same options, the same errors ("no guide within 240 s", "the model answered nothing"), and `parseGuide` on the trimmed answer.
**Code (imports, lines 1-11):**
```ts
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn } from '../chat/agent.js';
import type { Db } from '../db/client.js';
import type { GenreGuideItem } from '../db/schema.js';
import { findClaudeBin } from '../sessions/summarize.js';
import { runAgentText, type AgentTextRun } from './agentText.js';
import { listTitlesByIds, type ReadContext, type TitleListItem } from './read.js';
import type { MoviesRepo } from './repo.js';
import { posterUrl, yearOf, type TmdbClient, type TmdbDiscovery, type TmdbPersonCredit, type TmdbProfiles, type TmdbSearchHit } from './tmdb.js';
import { titleId, type TitleKind, type TitleMetadata } from './types.js';
```
**Code (`createGuideWriter`, replacing lines 287-349):**
```ts
/**
 * Claude through the Agent SDK with WebSearch as its one tool (agentText.ts: the owner's login, no MCP
 * servers, no settings, no persisted session). Null when the claude binary cannot be found.
 */
export function createGuideWriter(opts: GuideWriterOptions): GuideWriter | null {
  const baseEnv = opts.baseEnv ?? process.env;
  const claudeBin = findClaudeBin(opts.claudeBin, baseEnv.PATH);
  if (claudeBin === null) return null;
  const query: QueryFn = opts.query ?? sdkQuery;
  const run: AgentTextRun = {
    query,
    claudeBin,
    cwd: opts.cwd,
    baseEnv,
    model: opts.model,
    tools: ['WebSearch'],
    maxTurns: GUIDE_MAX_TURNS,
    systemPrompt: GUIDE_SYSTEM_PROMPT,
    timeoutMs: opts.timeoutMs ?? DEFAULT_GUIDE_TIMEOUT_MS,
    what: 'guide',
  };
  return {
    model: opts.model,
    async write(input) {
      return parseGuide(await runAgentText(run, buildGuideInput(input)));
    },
  };
}
```
**Impact:** `tests/unit/movies/guides.test.ts` must pass unchanged. That is the check for this step: `npx vitest run tests/unit/movies/guides.test.ts`.

### Step 3: The web story writer
**File:** `src/movies/webStory.ts` (new)
**Change:** This step is the heart of the phase: the system prompt, the user message, the parser and the writer. The parser is where "never invented" is enforced:
- A section counts as found only when it cites a page that this run's own WebSearch results returned. URLs from the model's memory are dropped.
- An episode the message did not ask for is dropped.
- An episode the model left out becomes `found: false`.
- Episode names come from TMDB (the input), never from the model.
**Code:**
```ts
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn } from '../chat/agent.js';
import type { MovieStorySection, MovieStorySource } from '../db/schema.js';
import { findClaudeBin } from '../sessions/summarize.js';
import { runAgentText, type AgentTextRun } from './agentText.js';

/**
 * A story told by the web (story.ts asks for it): Claude with WebSearch as its one tool finds published recaps
 * of a whole season, one episode or a film and retells them, every spoiler included, section by section, naming
 * the pages it took each section from. Nothing is written from memory: a section counts only when it names a
 * page this run's own searches returned, and an episode no such page tells is answered `found: false` with no
 * text. Same Agent SDK setup as the genre guide (guides.ts, agentText.ts).
 */

/** Wall clock for one run: a long season means many searches. */
export const DEFAULT_WEB_STORY_TIMEOUT_MS = 420_000;
/** Each search is a turn; a season of a dozen episodes may need one per episode beyond Wikipedia. */
export const WEB_STORY_MAX_TURNS = 32;
/** Sources kept per story at most. */
export const WEB_STORY_SOURCES_KEPT = 24;
/** A season longer than this gets shorter sections, so the whole answer fits. */
export const LONG_SEASON_EPISODES = 26;
/**
 * Whether a run's WebSearch results reach `onMessage` with their URLs (Step 0 settles it from the installed SDK's
 * types). True: a section counts only when it cites a page this run's searches returned. False: it counts when it
 * names an http(s) source the answer's own sources list holds, and the writer says once that it could not cross-check.
 */
export const SEARCH_RESULTS_CARRY_URLS = true;

export const WEB_STORY_SYSTEM_PROMPT = [
  'You retell a film, one episode of a series, or a whole season of a series for its owner, who wants the whole story with every spoiler, the ending included.',
  'You write only from published pages you find with WebSearch: never from memory, never from a guess, never from a trailer, a preview, a synopsis written before the episode aired, or a fan theory.',
  'Search in this order, and go further down the list only for the episodes the pages found so far do not tell:',
  '(1) Wikipedia: the season\'s own article ("<series> season <n>"), else the series\' "List of <series> episodes" article, else the series\' or the film\'s own article and its "Plot" or "Episodes" section;',
  '(2) the series\' or the film\'s Fandom wiki (<name>.fandom.com): the episode\'s own page and its synopsis or plot;',
  '(3) episode recaps on Dramabeans (for Korean dramas), Vulture, The A.V. Club and Den of Geek; then other published recaps or reviews that retell the episode.',
  'Search with the title and year as given, and with the original title when one is given. Make sure each page is about this title and not a remake, an adaptation or a namesake from another year, and that it tells the episode by its season and number (and by its name when one is given).',
  'For each episode asked for, write what happens in it, in order from start to end: who does what, why, what is revealed, what changes, how it ends. Take every fact from the pages you found about that episode, and name characters as those pages do.',
  'When no page you found tells what happens in an episode (none at all, only a one-line logline, or only a preview), set its found to false and leave its text empty.',
  'Never fill such an episode from another episode, from the synopsis in the message, or from what seems likely: an episode the sources do not tell is said to be missing.',
  'Write plain prose in English: paragraphs separated by one blank line, no headings, no lists, no bold, no links, and no names of the sources in the text. Keep to the length the message asks for.',
  'Then answer with one JSON object and nothing else, no code fence:',
  '{"sections": [{"episode": number, "found": boolean, "text": string, "sources": [string]}], "sources": [{"url": string, "title": string, "site": string}]}.',
  'sections: exactly one for each episode the message lists, in its order, with the episode number given there (a film is episode 0).',
  'A section\'s sources are the URLs of the pages its text was taken from: a section with found true names at least one, a section with found false names none.',
  'sources: every page a section names, once each: its exact URL as a search result gave it, its page title, and the site\'s name ("Wikipedia", "Fandom", "Dramabeans", "Vulture", "The A.V. Club", "Den of Geek").',
  'Only pages that appeared in your search results; never a URL you built or remember.',
].join(' ');

export type WebStoryScope = 'season' | 'episode' | 'film';

export interface WebStoryEpisode {
  /** 0 for a film. */
  episode: number;
  /** TMDB's name; null when TMDB has none (and always for a film). */
  name: string | null;
  /** `YYYY-MM-DD`. */
  airDate: string | null;
}

/** What the writer is given. */
export interface WebStoryInput {
  /** "MobLand (2025)". */
  title: string;
  /** Set only when it differs from the title ("오징어 게임"). */
  originalTitle: string | null;
  /** TMDB's synopsis of the title: only to tell it apart from a namesake. */
  overview: string | null;
  scope: WebStoryScope;
  /** 0 for a film. */
  season: number;
  /** A season: its aired episodes in order. An episode or a film: exactly one. */
  episodes: WebStoryEpisode[];
}

/** The model's user message. */
export function buildWebStoryInput(input: WebStoryInput): string {
  const head = [
    `Title: ${input.title}, a ${input.scope === 'film' ? 'film' : 'series'}`,
    ...(input.originalTitle === null ? [] : [`Original title: ${input.originalTitle}`]),
    ...(input.overview === null ? [] : [`TMDB's synopsis, only to tell the title apart from a namesake (it is not a source): ${input.overview}`]),
    '',
  ];
  if (input.scope === 'film') return [...head, 'Asked for: the whole film, as one section with episode 0.', 'Length: about 900 to 1600 words.'].join('\n');
  const listed = input.episodes.map((e) => `- Episode ${e.episode}${e.name === null ? '' : ` "${e.name}"`}${e.airDate === null ? '' : `, aired ${e.airDate}`}`);
  if (input.scope === 'episode') {
    return [...head, `Asked for: one episode of season ${input.season}, as one section:`, ...listed, 'Length: about 400 to 800 words.'].join('\n');
  }
  const words = input.episodes.length > LONG_SEASON_EPISODES ? '60 to 120' : '150 to 300';
  return [
    ...head,
    `Asked for: the whole of season ${input.season}, one section for each of its ${input.episodes.length} episodes:`,
    ...listed,
    `Length: about ${words} words per section.`,
  ].join('\n');
}

/** What a run answers: one section per episode asked for, in the input's order, and the pages they cite. */
export interface WrittenWebStory {
  sections: MovieStorySection[];
  sources: MovieStorySource[];
}

/**
 * One page, whatever way a URL to it is written: host without `www.`, the path decoded and without a trailing
 * slash, the query kept, the fragment dropped. Null for anything that is not an http(s) URL.
 */
export function sourceKey(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  let path = u.pathname;
  try {
    path = decodeURI(path);
  } catch {
    // A path that does not decode is compared as written.
  }
  return `${u.hostname.toLowerCase().replace(/^www\./, '')}${path.replace(/\/+$/, '')}${u.search}`;
}

const URL_IN_TEXT = /https?:\/\/[^\s"'<>\\`]+/g;

/**
 * The pages one message of a run shows the model as search results (the tool results it was handed), as
 * sourceKey keys. What the model writes itself (its own text) never counts.
 */
export function searchedKeys(message: SDKMessage): string[] {
  if (message.type !== 'user' && message.type !== 'assistant') return [];
  const content: unknown = (message as { message?: { content?: unknown } }).message?.content;
  const results: unknown[] = Array.isArray(content)
    ? content.filter((block) => {
        const type = (block as { type?: unknown } | null)?.type;
        return type === 'tool_result' || type === 'web_search_tool_result';
      })
    : [];
  // A tool's structured output, when the SDK hands it beside the content (Step 0).
  const structured: unknown = (message as { tool_use_result?: unknown }).tool_use_result;
  if (structured !== undefined && structured !== null) results.push(structured);
  const keys: string[] = [];
  for (const block of results) {
    for (const match of JSON.stringify(block).matchAll(URL_IN_TEXT)) {
      const raw = match[0].replace(/[.,;:]+$/, '');
      // "(TV series)" ends many a Wikipedia URL; a closing bracket after a URL in prose does not.
      for (const candidate of [raw, raw.replace(/\)+$/, '')]) {
        const key = sourceKey(candidate);
        if (key !== null) keys.push(key);
      }
    }
  }
  return keys;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * The model's answer as a story. One section per episode asked for, in that order, named as TMDB names it:
 * - a section for an episode not asked for is dropped (invented);
 * - an episode the answer leaves out, or tells with no page `seen` by this run's searches (with `seen` null: no
 *   http(s) page its own sources list holds), is `found: false` with no text;
 * - only the sources a found section cites are kept.
 * Throws when the answer holds no JSON object with a sections list.
 */
export function parseWebStory(answer: string, episodes: readonly WebStoryEpisode[], seen: ReadonlySet<string> | null): WrittenWebStory {
  const from = answer.indexOf('{');
  const to = answer.lastIndexOf('}');
  if (from === -1 || to <= from) throw new Error('the model answered no JSON');
  let raw: unknown;
  try {
    raw = JSON.parse(answer.slice(from, to + 1));
  } catch {
    throw new Error('the model answered JSON that does not parse');
  }
  const o = raw as { sections?: unknown; sources?: unknown };
  if (!Array.isArray(o.sections)) throw new Error('the model answered no sections');

  // The pages it lists that this run's searches really returned, by key, in its order.
  const listed = new Map<string, MovieStorySource>();
  for (const s of Array.isArray(o.sources) ? o.sources : []) {
    const e = s as { url?: unknown; title?: unknown; site?: unknown } | null;
    const url = text(e?.url);
    const key = sourceKey(url);
    // `seen` null: the run's search results could not be read (SEARCH_RESULTS_CARRY_URLS false): any listed http(s) page counts.
    if (key === null || (seen !== null && !seen.has(key)) || listed.has(key)) continue;
    const host = new URL(url).hostname.replace(/^www\./, '');
    listed.set(key, { url, title: text(e?.title) || host, site: text(e?.site) || host });
  }

  const asked = new Set(episodes.map((e) => e.episode));
  const told = new Map<number, string>();
  const cited = new Set<string>();
  for (const s of o.sections) {
    const e = s as { episode?: unknown; found?: unknown; text?: unknown; sources?: unknown } | null;
    const episode = e?.episode;
    if (typeof episode !== 'number' || !asked.has(episode) || told.has(episode)) continue;
    const body = text(e?.text);
    if (e?.found !== true || body === '') continue;
    const keys = (Array.isArray(e.sources) ? e.sources : [])
      .map((u) => (typeof u === 'string' ? sourceKey(u) : null))
      .filter((k): k is string => k !== null && listed.has(k));
    // A section no page of this run's searches backs is not told: never kept as if it were.
    if (keys.length === 0) continue;
    told.set(episode, body);
    for (const k of keys) cited.add(k);
  }

  return {
    sections: episodes.map((ep) => {
      const body = told.get(ep.episode);
      return { episode: ep.episode, name: ep.name, text: body ?? '', found: body !== undefined };
    }),
    sources: [...listed]
      .filter(([key]) => cited.has(key))
      .map(([, source]) => source)
      .slice(0, WEB_STORY_SOURCES_KEPT),
  };
}

/** The seam between a web story and a model. Production: createWebStoryWriter. Tests: a plain object. */
export interface WebStoryWriter {
  /** Model id or alias: stored with the story. */
  readonly model: string;
  /** Rejects when the run fails, times out or answers no JSON with sections. */
  write(input: WebStoryInput): Promise<WrittenWebStory>;
}

export interface WebStoryWriterOptions {
  /** `config.chat.claudeBin`. */
  claudeBin: string;
  /** `<dataDir>/movies-web-story`; created on first use, nothing is persisted there. */
  cwd: string;
  /** `config.movies.storyModel`. */
  model: string;
  /** Default: the SDK's query. Tests inject a fake. */
  query?: QueryFn;
  baseEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  log?: (line: string) => void;
}

/** Claude with WebSearch as its one tool. Null when the claude binary cannot be found. */
export function createWebStoryWriter(opts: WebStoryWriterOptions): WebStoryWriter | null {
  const baseEnv = opts.baseEnv ?? process.env;
  const claudeBin = findClaudeBin(opts.claudeBin, baseEnv.PATH);
  if (claudeBin === null) return null;
  const query: QueryFn = opts.query ?? sdkQuery;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WEB_STORY_TIMEOUT_MS;
  const log = opts.log ?? ((line: string) => console.log(line));
  let warned = false;
  return {
    model: opts.model,
    async write(input) {
      const seen = new Set<string>();
      const run: AgentTextRun = {
        query,
        claudeBin,
        cwd: opts.cwd,
        baseEnv,
        model: opts.model,
        tools: ['WebSearch'],
        maxTurns: WEB_STORY_MAX_TURNS,
        systemPrompt: WEB_STORY_SYSTEM_PROMPT,
        timeoutMs,
        what: 'story',
        onMessage: (message) => {
          for (const key of searchedKeys(message)) seen.add(key);
        },
      };
      const answer = await runAgentText(run, buildWebStoryInput(input));
      if (!SEARCH_RESULTS_CARRY_URLS && !warned) {
        warned = true;
        log('[notesd] movies: WebSearch results could not be cross-checked (the SDK\'s messages carry no result URLs); a story section counts when it names a source its answer lists');
      }
      return parseWebStory(answer, input.episodes, SEARCH_RESULTS_CARRY_URLS ? seen : null);
    },
  };
}
```
**Impact:** new module. Nothing imports it until Step 4.

### Step 4: `MovieStories` web-first, season stories, the new `StoryView`
**File:** `src/movies/story.ts`. Replace the whole file. If phase 1 edited `MovieStories.get`/`writeNew` to compile against `movie_stories`, this replacement supersedes those edits.
**Change:**
- `createStoryWriter` now uses `runAgentText`. Its options are the same as before.
- `StoryView` gains `origin`, `sources`, `sections`; `provider` and `cues` become nullable.
- `StoryError` code `no_dialogue` becomes `no_story_source`.
- `write` routes a season to `writeSeason`. A season never reads a subtitle.
- An episode or a film is web-first and falls back to the dialogue route only when the web writer answers `found: false`. A failed web run is `story_failed` and does not fall back.
- All stories are stored through `MoviesRepo.saveStory` and read through `MoviesRepo.story`.
**Code:**
```ts
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn } from '../chat/agent.js';
import { DEFAULT_MOVIES_STORY_MODEL } from '../config.js';
import type { MovieStorySection, MovieStorySource } from '../db/schema.js';
import { dialoguePage } from '../directStream/dialogue.js';
import type { StoredDialogue } from '../directStream/dialogueStore.js';
import { DirectStreamError, type DirectStreamErrorCode, type StreamRef } from '../directStream/types.js';
import { findClaudeBin } from '../sessions/summarize.js';
import { runAgentText, type AgentTextRun } from './agentText.js';
import type { MoviesRepo } from './repo.js';
import type { TitleMetadata } from './types.js';
import type { WebStoryInput, WebStoryWriter, WrittenWebStory } from './webStory.js';

/**
 * The story of a film, an episode or a whole season, with every spoiler, written once on the owner's click and
 * kept in `movie_stories` (MoviesRepo.saveStory), so it is never paid for twice and a stored one is answered with
 * no model call. Web first (webStory.ts): Claude with WebSearch retells it from published recaps and names its
 * sources. A season is only ever written from the web. An episode or a film the web has no recap of is written
 * from its dialogue instead (the English subtitle a stream source carried, src/directStream/dialogue.ts), by one
 * more model call with no tools: the owner's login, no MCP servers, no settings, one turn.
 */

/** Agent SDK model alias; `config.movies.storyModel` (NOTESD_MOVIES_STORY_MODEL) overrides it. */
export const DEFAULT_STORY_MODEL = DEFAULT_MOVIES_STORY_MODEL;
/** Wall clock for one story from dialogue: a film's dialogue is long. */
export const DEFAULT_STORY_TIMEOUT_MS = 240_000;
/** Characters of dialogue handed to the model: a three-hour film fits; anything longer is cut at a whole minute. */
export const STORY_DIALOGUE_CHARS = 400_000;
/** What a season's text says for an episode no published recap told. */
export const NO_RECAP_TEXT = 'No published recap was found for this episode.';

export const STORY_SYSTEM_PROMPT = [
  'You retell one film or one episode of a series for its owner, who wants the whole story with every spoiler.',
  'The user message gives the title, what TMDB says about it, some of its characters, and the complete English subtitle: every line said, each with the minute it is said.',
  'Write what happens, in order, from start to end, the ending included: who does what, why, what is revealed, what changes.',
  'Work only from the lines given. Name a character when the lines or the cast make clear who it is; when you cannot tell who speaks, say what is said without guessing a name.',
  'Say when something is a flashback, a recap of earlier events or a preview of the next episode. Leave out opening and ending song lyrics.',
  'Subtitles do not describe silent action: do not invent what the lines do not show.',
  'Plain prose in English: paragraphs separated by one blank line, no headings, no lists, no bold. Begin with one sentence that says what this film or episode is about, then the story.',
  'An episode takes about 400 to 800 words, a film about 900 to 1600.',
].join(' ');

/** What the dialogue writer is given about one title. */
export interface StoryInput {
  /** "One Piece (1999)". */
  title: string;
  /** "S18E760", or null for a film. */
  code: string | null;
  episodeName: string | null;
  airDate: string | null;
  /** TMDB's synopsis of the episode, else of the title. */
  overview: string | null;
  /** "Monkey D. Luffy (voice)", from the cast's character names. */
  characters: string[];
  /** `[mm:ss] line` per cue. */
  dialogue: string;
}

/** The dialogue writer's user message. */
export function buildStoryInput(input: StoryInput): string {
  return [
    `Title: ${input.title}`,
    ...(input.code === null ? [] : [`Episode: ${input.code}${input.episodeName === null ? '' : ` "${input.episodeName}"`}${input.airDate === null ? '' : `, aired ${input.airDate}`}`]),
    ...(input.overview === null || input.overview.trim() === '' ? [] : [`TMDB's synopsis: ${input.overview.trim()}`]),
    ...(input.characters.length === 0 ? [] : [`Characters of the title: ${input.characters.join('; ')}`]),
    '',
    'The subtitle, every line with its minute:',
    input.dialogue,
  ].join('\n');
}

/** The seam between a story from dialogue and a model. Production: createStoryWriter. Tests: a plain object. */
export interface StoryWriter {
  /** Model id or alias: stored with the story. */
  readonly model: string;
  /** The story as plain paragraphs. Rejects when the model call fails or times out. */
  write(input: StoryInput): Promise<string>;
}

export interface StoryWriterOptions {
  /** `config.chat.claudeBin`. */
  claudeBin: string;
  /** `<dataDir>/movies-story`; created on first use, nothing is persisted there. */
  cwd: string;
  model?: string;
  /** Default: the SDK's query. Tests inject a fake. */
  query?: QueryFn;
  baseEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Claude through the Agent SDK, no tools, one turn. Null when the claude binary cannot be found. */
export function createStoryWriter(opts: StoryWriterOptions): StoryWriter | null {
  const baseEnv = opts.baseEnv ?? process.env;
  const claudeBin = findClaudeBin(opts.claudeBin, baseEnv.PATH);
  if (claudeBin === null) return null;
  const query: QueryFn = opts.query ?? sdkQuery;
  const model = opts.model ?? DEFAULT_STORY_MODEL;
  const run: AgentTextRun = {
    query,
    claudeBin,
    cwd: opts.cwd,
    baseEnv,
    model,
    tools: [],
    maxTurns: 1,
    systemPrompt: STORY_SYSTEM_PROMPT,
    timeoutMs: opts.timeoutMs ?? DEFAULT_STORY_TIMEOUT_MS,
    what: 'story',
  };
  return {
    model,
    async write(input) {
      return runAgentText(run, buildStoryInput(input));
    },
  };
}

/** Where a story was written from. */
export type StoryOrigin = 'web' | 'dialogue';

/** A story as the wall and the tools read it. */
export interface StoryView {
  season: number;
  /** 0 for a season's story (season > 0) and for a film's (season 0). */
  episode: number;
  /** The story. A season's: every section under its "S01E02 · name" heading (seasonText), for a reader of plain text. */
  text: string;
  origin: StoryOrigin;
  /** The pages a web story was written from; [] for a story from dialogue. */
  sources: MovieStorySource[];
  /** A season's story: one per aired episode, in order (`found: false` and no text where no recap told it); [] otherwise. */
  sections: MovieStorySection[];
  model: string | null;
  written_at: string | null;
  /** A story from dialogue: the stream provider whose subtitle it was written from, and how many lines that was. Null for a web story. */
  provider: string | null;
  cues: number | null;
}

/** Why a story could not be given: the route answers `code`. */
export class StoryError extends Error {
  override readonly name = 'StoryError';
  constructor(
    readonly code: 'not_found' | 'story_off' | 'no_story_source' | 'story_failed',
    message: string,
  ) {
    super(message);
  }
}

export interface MovieStoriesOptions {
  repo: Pick<MoviesRepo, 'story' | 'saveStory' | 'dialogue' | 'loadTitleMetadata'>;
  /**
   * The title's dialogue, read from a stream source when it is not stored yet
   * (dialogueStore.ts loadDialogue). Null from it: none is stored and none can be read here
   * (direct streaming is off). It throws DirectStreamError when the title cannot be resolved.
   */
  dialogue: (target: StreamRef) => Promise<StoredDialogue | null>;
  /** Writes an episode or a film from its dialogue when the web has no recap. Null: NOTESD_MOVIES_STORY_MODEL=off, or no claude binary. */
  writer: StoryWriter | null;
  /** Writes from published recaps (webStory.ts): a season always, an episode or a film first. Null as `writer`. Stored stories are still read. */
  webWriter: WebStoryWriter | null;
  now?: () => Date;
  log?: (line: string) => void;
}

type Written = { story: StoryView; cached: boolean };

/** One stored story, without its title. */
interface StoryRecord {
  season: number;
  episode: number;
  text: string;
  sections: MovieStorySection[];
  sources: MovieStorySource[];
  origin: StoryOrigin;
  model: string | null;
  writtenAt: Date;
}

/** A dialogue that cannot be read because there is none: with no recap on the web either, nothing tells the story. */
const NOTHING_TO_READ: ReadonlySet<DirectStreamErrorCode> = new Set<DirectStreamErrorCode>(['no_source', 'no_subtitle', 'no_episode']);

const pad = (n: number): string => String(n).padStart(2, '0');

/** A season's sections as one text, each under its "S01E02 · name" heading; an untold one says so. */
export function seasonText(season: number, sections: readonly MovieStorySection[]): string {
  return sections.map((s) => `S${pad(season)}E${pad(s.episode)}${s.name === null ? '' : ` · ${s.name}`}\n\n${s.found ? s.text : NO_RECAP_TEXT}`).join('\n\n');
}

function viewOf(r: StoryRecord, dialogue: { provider: string; cues: number } | null): StoryView {
  return {
    season: r.season,
    episode: r.episode,
    text: r.text,
    origin: r.origin,
    sources: r.sources,
    sections: r.sections,
    model: r.model,
    written_at: r.writtenAt.toISOString(),
    provider: dialogue?.provider ?? null,
    cues: dialogue?.cues ?? null,
  };
}

function labelOf(meta: TitleMetadata, season: number, episode: number): string {
  if (meta.kind === 'movie') return meta.title;
  return episode === 0 ? `${meta.title} season ${season}` : `${meta.title} S${pad(season)}E${pad(episode)}`;
}

/** What every web story is told about its title. */
function webTitle(meta: TitleMetadata): Pick<WebStoryInput, 'title' | 'originalTitle' | 'overview'> {
  const original = meta.originalTitle.trim();
  return {
    title: meta.year === null ? meta.title : `${meta.title} (${meta.year})`,
    originalTitle: original !== '' && original !== meta.title ? original : null,
    overview: meta.overview.trim() === '' ? null : meta.overview.trim(),
  };
}

function storyInput(meta: TitleMetadata, season: number, episode: number, dialogue: string): StoryInput {
  const ep = meta.kind === 'tv' ? (meta.episodes.find((e) => e.season === season && e.episode === episode) ?? null) : null;
  return {
    title: meta.year === null ? meta.title : `${meta.title} (${meta.year})`,
    code: meta.kind === 'tv' ? `S${pad(season)}E${pad(episode)}` : null,
    episodeName: ep?.name ?? null,
    airDate: ep?.airDate ?? null,
    overview: ep?.overview ?? (meta.kind === 'movie' ? meta.overview : null),
    characters: meta.credits.filter((c) => c.role === 'cast' && c.character !== null).slice(0, 40).map((c) => c.character as string),
    dialogue,
  };
}

/** The stories of the library: read from the store, and written once on request. Holds only the writes in flight. */
export class MovieStories {
  private readonly inFlight = new Map<string, Promise<Written>>();
  private readonly now: () => Date;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: MovieStoriesOptions) {
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((line: string) => console.log(line));
  }

  /** The stored story of a film (0, 0), an episode, or a season (season, 0), or null. Never calls a model. */
  async get(titleId: string, season: number, episode: number): Promise<StoryView | null> {
    const row = await this.opts.repo.story(titleId, season, episode);
    if (row === null) return null;
    const record: StoryRecord = {
      season: row.season,
      episode: row.episode,
      text: row.text,
      sections: row.sections ?? [],
      sources: row.sources ?? [],
      origin: row.origin === 'web' ? 'web' : 'dialogue',
      model: row.model,
      writtenAt: row.writtenAt,
    };
    const dialogue = record.origin === 'dialogue' ? await this.opts.repo.dialogue(titleId, season, episode) : null;
    return viewOf(record, dialogue);
  }

  /**
   * The story: the stored one (`cached: true`, no model call), else written now and kept. `episode` 0 with a
   * season above 0 is that season's story (writeSeason). Two requests for the same story share one write.
   * Throws StoryError, or the DirectStreamError of a subtitle that could not be read for another reason
   * than there being none.
   */
  async write(titleId: string, season: number, episode: number): Promise<Written> {
    if (episode === 0 && season > 0) return this.writeSeason(titleId, season);
    return this.once(titleId, season, episode, () => this.writeOne(titleId, season, episode));
  }

  /** A season's whole story, one section per aired episode, from the web only: no subtitle is ever read for it. */
  async writeSeason(titleId: string, season: number): Promise<Written> {
    if (season < 1) throw new StoryError('not_found', 'Season 0 holds the specials: ask for one of its episodes.');
    return this.once(titleId, season, 0, () => this.writeNewSeason(titleId, season));
  }

  private async once(titleId: string, season: number, episode: number, make: () => Promise<Written>): Promise<Written> {
    const stored = await this.get(titleId, season, episode);
    if (stored !== null) return { story: stored, cached: true };
    const key = `${titleId} ${season} ${episode}`;
    const running = this.inFlight.get(key);
    if (running !== undefined) return running;
    const job = make().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, job);
    return job;
  }

  private async writeNewSeason(titleId: string, season: number): Promise<Written> {
    const web = this.opts.webWriter;
    if (web === null) throw new StoryError('story_off', 'Stories are off on this machine (NOTESD_MOVIES_STORY_MODEL=off, or no claude binary).');
    const meta = await this.opts.repo.loadTitleMetadata(titleId);
    if (meta === null) throw new StoryError('not_found', `No title ${titleId} is stored.`);
    if (meta.kind !== 'tv') throw new StoryError('not_found', `${meta.title} is a film: it has no seasons.`);
    const today = this.now().toISOString().slice(0, 10);
    // Aired episodes only: a recap of an episode that has not aired cannot exist.
    const episodes = meta.episodes
      .filter((e) => e.season === season && e.airDate !== null && e.airDate <= today)
      .sort((a, b) => a.episode - b.episode)
      .map((e) => ({ episode: e.episode, name: e.name, airDate: e.airDate }));
    const label = labelOf(meta, season, 0);
    if (episodes.length === 0) throw new StoryError('not_found', `${label} has no aired episode.`);
    const written = await this.askWeb(web, { ...webTitle(meta), scope: 'season', season, episodes }, label);
    const told = written.sections.filter((s) => s.found).length;
    // Nothing kept when nothing was told: a later click searches again.
    if (told === 0) throw new StoryError('no_story_source', `No published recap of ${label} was found.`);
    const record: StoryRecord = {
      season,
      episode: 0,
      text: seasonText(season, written.sections),
      sections: written.sections,
      sources: written.sources,
      origin: 'web',
      model: web.model,
      writtenAt: this.now(),
    };
    await this.opts.repo.saveStory({ titleId, ...record });
    this.log(`[notesd] movies: wrote the story of ${titleId} season ${season} with ${web.model} from the web: ${told} of ${episodes.length} episodes told, ${written.sources.length} sources`);
    return { story: viewOf(record, null), cached: false };
  }

  private async writeOne(titleId: string, season: number, episode: number): Promise<Written> {
    const { webWriter: web, writer } = this.opts;
    if (web === null && writer === null) throw new StoryError('story_off', 'Stories are off on this machine (NOTESD_MOVIES_STORY_MODEL=off, or no claude binary).');
    const meta = await this.opts.repo.loadTitleMetadata(titleId);
    if (meta === null) throw new StoryError('not_found', `No title ${titleId} is stored.`);
    if (meta.kind === 'movie' && (season !== 0 || episode !== 0)) throw new StoryError('not_found', `${meta.title} is a film: it has no episodes.`);
    if (meta.kind === 'tv' && episode === 0) throw new StoryError('not_found', `Name an episode or a season of ${meta.title}.`);
    const label = labelOf(meta, season, episode);
    if (web !== null) {
      const ep = meta.kind === 'tv' ? (meta.episodes.find((e) => e.season === season && e.episode === episode) ?? null) : null;
      const input: WebStoryInput =
        meta.kind === 'movie'
          ? { ...webTitle(meta), scope: 'film', season: 0, episodes: [{ episode: 0, name: null, airDate: meta.releaseDate }] }
          : { ...webTitle(meta), scope: 'episode', season, episodes: [{ episode, name: ep?.name ?? null, airDate: ep?.airDate ?? null }] };
      const written = await this.askWeb(web, input, label);
      const section = written.sections[0];
      if (section !== undefined && section.found) {
        const record: StoryRecord = { season, episode, text: section.text, sections: [], sources: written.sources, origin: 'web', model: web.model, writtenAt: this.now() };
        await this.opts.repo.saveStory({ titleId, ...record });
        this.log(`[notesd] movies: wrote the story of ${label} (${titleId}) with ${web.model} from the web: ${written.sources.length} sources, ${section.text.length} characters`);
        return { story: viewOf(record, null), cached: false };
      }
      this.log(`[notesd] movies: no published recap of ${label} (${titleId}) was found; its subtitle is read instead`);
    }
    return this.fromDialogue(meta, titleId, season, episode, label);
  }

  /** The fallback of an episode or a film the web does not tell: its story from its dialogue. */
  private async fromDialogue(meta: TitleMetadata, titleId: string, season: number, episode: number, label: string): Promise<Written> {
    const writer = this.opts.writer;
    if (writer === null) throw new StoryError('no_story_source', `No published recap of ${label} was found, and stories from subtitles are off here.`);
    const target: StreamRef = meta.kind === 'movie' ? { kind: 'movie', tmdbId: meta.tmdbId } : { kind: 'tv', tmdbId: meta.tmdbId, season, episode };
    let dialogue: StoredDialogue | null;
    try {
      dialogue = await this.opts.dialogue(target);
    } catch (err) {
      if (err instanceof DirectStreamError && NOTHING_TO_READ.has(err.code)) {
        throw new StoryError('no_story_source', `No published recap of ${label} was found, and its subtitle could not be read: ${err.message}`);
      }
      throw err;
    }
    if (dialogue === null) throw new StoryError('no_story_source', `No published recap of ${label} was found, and no subtitle of it is stored here (direct streaming is off).`);
    const page = dialoguePage(dialogue.body, 0, STORY_DIALOGUE_CHARS);
    let text: string;
    try {
      text = await writer.write(storyInput(meta, season, episode, page.text));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`[notesd] movies: the story of ${label} (${titleId}) was not written: ${message}`);
      throw new StoryError('story_failed', `The story could not be written: ${message}`);
    }
    const record: StoryRecord = { season, episode, text, sections: [], sources: [], origin: 'dialogue', model: writer.model, writtenAt: this.now() };
    await this.opts.repo.saveStory({ titleId, ...record });
    this.log(`[notesd] movies: wrote the story of ${label} (${titleId}) with ${writer.model} from ${dialogue.cues} lines (${text.length} characters)`);
    return { story: viewOf(record, dialogue), cached: false };
  }

  /** The web writer's answer; a failed run is `story_failed` (never a reason to read a subtitle instead). */
  private async askWeb(web: WebStoryWriter, input: WebStoryInput, label: string): Promise<WrittenWebStory> {
    try {
      return await web.write(input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`[notesd] movies: the story of ${label} was not written from the web: ${message}`);
      throw new StoryError('story_failed', `The story could not be written: ${message}`);
    }
  }
}
```
**Impact:**
- `src/daemon.ts` and `tests/integration/movies.api.int.test.ts` must pass `webWriter` (Steps 6 and 10).
- The route's `StoryError` status map changes (Step 5).
- The web `StoryModal` still renders the new answer. It reads `text`, `model`, `provider` and `cues`, so a web story's foot shows "from null subtitle lines (null)" until phase 7 changes it (see Handoffs).

### Step 5: Story routes accept a season and answer the new error
**File:** `src/http/moviesApi.ts`
**Change (a), `:63-67`:** replace the `StoryResponse` comment and interface:
```ts
/** GET and POST /api/movies/:id/story: a film's, an episode's or a season's story. `cached` is false only when this call had it written. */
export interface StoryResponse {
  story: StoryView | null;
  cached: boolean;
}
```
**Change (b), `:205-208`:** replace `storySlot` and add the status map right after it:
```ts
/** A film is season 0, episode 0 (the default); an episode names both; a season (above 0) is `season` alone. */
const storySlot = z.object({
  season: z.coerce.number().int().min(0).max(1000).default(0),
  episode: z.coerce.number().int().min(0).max(100_000).default(0),
});

/** The status each StoryError answers with. */
const STORY_ERROR_STATUS = { not_found: 404, no_story_source: 404, story_failed: 502, story_off: 503 } as const;
```
**Change (c), `:538`:** the comment becomes
```ts
  // The story of a film, an episode or a season (src/movies/story.ts, webStory.ts). GET only reads the store; POST writes it once.
```
**Change (d), `:568-571`:** in the POST handler's `catch`, replace the `StoryError` branch with:
```ts
        if (err instanceof StoryError) return c.json({ error: err.code, message: err.message }, STORY_ERROR_STATUS[err.code]);
```
The GET handler (`:539-550`) and the rest of the POST handler stay as they are: `stories.get(id, season, episode)` serves a season through `(season, 0)`, and `stories.write` dispatches it. The `DirectStreamError` branch (`:574`) stays.
**Impact:** the body `{season: 1}` was 400 and is now a season story. `no_dialogue` is gone and `no_story_source` (404) is new.

### Step 6: The daemon builds the web writer
**File:** `src/daemon.ts:35` (import) and `:513-524` (the `movieStories` block)
**Change:** add the import after line 35:
```ts
import { createWebStoryWriter } from './movies/webStory.js';
```
Then replace lines 513-524 with:
```ts
  // The story of a film, an episode or a whole season: from published recaps found with WebSearch first; an
  // episode or a film the web has none of, from its dialogue (one model run, then kept in movie_stories).
  const storyModel = config.movies.storyModel ?? null;
  const movieStories =
    movies === null
      ? null
      : new MovieStories({
          repo: movies.repo,
          dialogue: (target) => loadDialogue(movies.repo, directStream, target),
          writer: storyModel === null ? null : createStoryWriter({ claudeBin: config.chat.claudeBin, model: storyModel, cwd: join(config.dataDir, 'movies-story') }),
          webWriter: storyModel === null ? null : createWebStoryWriter({ claudeBin: config.chat.claudeBin, model: storyModel, cwd: join(config.dataDir, 'movies-web-story') }),
        });
```
The `genreGuides` block below it is unchanged.
**Impact:** a daemon with `NOTESD_MOVIES_STORY_MODEL=off` builds neither writer, but `MovieStories` itself is still built whenever the movies store is on (as `daemon.ts:514` does today), so the read path stays alive with the model off: `GET /api/movies/:id/story` answers a stored story (a season's included), and `POST` answers a stored one `cached: true` (`once` reads the store before any writer is asked); only writing a new story answers 503 `story_off`. The route's `stories === null → 503 story_off` is reached only with the movies store off. Phase 9's season-story proof relies on this (reconciled). Pass `log` to neither writer's options: the default console line is the daemon's log.

### Step 7: Per-season `has_story` on the title detail
**File:** `src/movies/read.ts`
**Change (a), `:136-141`:** `SeasonView` becomes
```ts
export interface SeasonView {
  season: number;
  /** YouTube video id of this season's trailer; null when TMDB lists none. */
  trailer_key: string | null;
  /** This season's whole story is stored (src/movies/story.ts): opening it costs nothing. Set by getTitle only. */
  has_story: boolean;
  episodes: EpisodeView[];
}
```
**Change (b), `:693`:** the push in `buildSeasons` becomes
```ts
    else seasons.push({ season: ep.season, trailer_key: trailers[String(ep.season)] ?? null, has_story: false, episodes: [ep] });
```
**Change (c), `getTitle`, around `:1085-1086`:** keep phase 1's `stories` query, which reads `movie_stories`. Directly after the existing line that sets each episode's `has_story`, add the season flag. After both phases, the two lines read:
```ts
  const storied = new Set(stories.map((s) => `${s.season}x${s.episode}`));
  for (const season of built.seasons) for (const e of season.episodes) e.has_story = storied.has(`${e.season}x${e.episode}`);
  for (const season of built.seasons) season.has_story = season.season > 0 && storied.has(`${season.season}x0`);
```
**Impact:** `GET /api/movies/:id` and `movies_get` gain `seasons[].has_story`.

**File:** `tests/unit/directStream/cacheShelf.test.ts:106`. Its `SeasonView` literal must typecheck, so add the field after `trailer_key: null,`:
```ts
      has_story: false,
```

### Step 8: Config comments
**File:** `src/config.ts:511` and `:572-574`
**Change:** line 511 becomes
```ts
/** The model that writes a story (src/movies/story.ts, webStory.ts) and a genre's guide (guides.ts). */
```
Lines 572-574 become
```ts
   * `NOTESD_MOVIES_STORY_MODEL`: Agent SDK alias or model id that writes a story when the owner asks for one
   * (src/movies/story.ts): a season's from published recaps found with WebSearch (webStory.ts), an episode's or a
   * film's from the web first and from its dialogue when the web has none. `off` gives null: no story is written
   * (stored ones are still shown; verify.sh pins it off).
```
**Impact:** comments only. No new environment variable.

### Step 9: Route reference
**File:** `scripts/docs/httpRoutes.ts:204-207`
**Change:** replace the two story entries with:
```ts
      'GET /api/movies/:id/story':
        'The stored story of a film, of one episode (`?season=&episode=`) or of a whole season (`?season=` alone, a season above 0): `{story: {season, episode, text, origin, sources, sections, model, written_at, provider, cues} | null, cached: true}`. A season\'s story is episode 0. `origin` is `web` or `dialogue`; `sources` the pages a web story was written from (`{url, title, site}`); `sections` a season\'s, one per aired episode (`{episode, name, text, found}`, `found: false` with no text where no published recap told it), `[]` otherwise; `provider` and `cues` only for a story from dialogue. Reads the store only; no model is called. 503 `story_off` without the stories service.',
      'POST /api/movies/:id/story':
        '`{season?, episode?}` (a film: neither; a season: `season` alone). The story with every spoiler, as the page asks for it: the stored one (`cached: true`, no model called), else written once and kept in `movie_stories`. Claude retells it from published recaps it finds with WebSearch (`NOTESD_MOVIES_STORY_MODEL`; a season can take a few minutes): Wikipedia first, then the series\' Fandom wiki, then recap sites; a section counts only when it cites a page the run\'s searches returned, and an episode none tells is said to be untold, never invented. A season is written from the web only and never reads a subtitle. An episode or a film the web has no recap of is written from its dialogue instead (the stored one, else the English subtitle of a stream source resolved out of sight). `{story, cached}`. 404 `not_found` (no such title, a season of a film, or a season with no aired episode) or `no_story_source` (no published recap, and no subtitle either; nothing is kept, so a later click searches again); 503 `story_off` (the model is off or no claude binary); 502 `story_failed` (the model run failed or answered no story) or `resolve_failed` and the other stream errors (the subtitle could not be read). Same-origin only.',
```
Then run `npm run docs:gen`. It rewrites `docs/guide/reference/http-api.md` (and `mcp-tools.md`, unchanged here); do not edit either by hand. They are regenerated, never merged: phases 4, 5 and 6 each regenerate them, and the integrator regenerates them after every merge. Phase 4's "Stream downloads" group and phase 5's `'GET /api/stream/disk'` entry are below line 290 of `scripts/docs/httpRoutes.ts`; this phase's two story entries (204–207) are a separate place (no dependency edge between 4/5 and 6).
**Impact:** `tests/unit/docs/reference.test.ts` stays green.

### Step 10: Tests
**File:** `tests/unit/movies/webStory.test.ts` (new)
```ts
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
```

The writer test "keeps only the pages its searches returned" is written for `SEARCH_RESULTS_CARRY_URLS = true`. If Step 0 settles it `false`, change that test's expectations to the fallback (sections `[[1, true], [2, true], [3, false]]`, both listed sources kept) and add `log` to the writer's options to assert the one "could not be cross-checked" line; nothing else changes.

**File:** `tests/live/webStory.live.test.ts` (new; runs only under `WEB_STORY_LIVE_TEST=1`, never in `npm test` or `test:int`)
```ts
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWebStoryWriter, SEARCH_RESULTS_CARRY_URLS } from '../../src/movies/webStory.js';

/**
 * One real, billed web story run (npm run test:live:webStory): the owner's claude login, WebSearch as the one tool.
 * It proves Step 0's answer on the installed SDK: under SEARCH_RESULTS_CARRY_URLS as set, a well-covered episode comes
 * back told, with at least one source. Were the constant wrong, every section would come back `found: false`.
 */
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'notesd-web-story-live-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe(`a real web story run (SEARCH_RESULTS_CARRY_URLS = ${SEARCH_RESULTS_CARRY_URLS})`, () => {
  it('tells a well-covered episode from a page it found, and names that page', async () => {
    const lines: string[] = [];
    const writer = createWebStoryWriter({ claudeBin: 'claude', cwd: dir, model: 'sonnet', log: (line) => void lines.push(line) });
    if (writer === null) throw new Error('no claude binary on PATH');
    const story = await writer.write({
      title: 'Breaking Bad (2008)',
      originalTitle: null,
      overview: null,
      scope: 'episode',
      season: 1,
      episodes: [{ episode: 1, name: 'Pilot', airDate: '2008-01-20' }],
    });
    expect(story.sections[0]?.found).toBe(true);
    expect(story.sources.length).toBeGreaterThan(0);
    expect(story.sources.every((s) => /^https?:\/\//.test(s.url))).toBe(true);
    expect(lines.some((l) => l.includes('could not be cross-checked'))).toBe(!SEARCH_RESULTS_CARRY_URLS);
  });
});
```

**File:** `vitest.config.ts`. Beside the other live switches add
`const webStoryLive = process.env.WEB_STORY_LIVE_TEST === '1'`; add `!webStoryLive &&` to `integration`'s guard;
in `includeFor()` add `if (webStoryLive) return ['tests/live/webStory.live.test.ts']` first; in `globalSetupFor()`
return `[]` for it (add it to the first condition); in `testTimeoutFor()` return `600_000` for it; add it to
`hookTimeout`'s list; and add one line to the header comment: ``- `npm run test:live:webStory` sets WEB_STORY_LIVE_TEST=1 (no Docker, no database), which runs only `tests/live/webStory.live.test.ts`: one real, billed web story run with WebSearch.``

**File:** `package.json`, after the `test:live:imageEmbeddings` script:
```json
    "test:live:webStory": "WEB_STORY_LIVE_TEST=1 vitest run",
```

**File:** `docs/guide/reference/configuration.md`, in "Tests" after the `IMAGE_EMBEDDINGS_LIVE_TEST` row:
```markdown
| `WEB_STORY_LIVE_TEST` | set by `test:live:webStory` | `1` runs only the live web story suite: one real, billed Claude run with WebSearch, the owner's login. |
```

**File:** `tests/unit/movies/story.test.ts`. Replace the whole file. The `buildStoryInput` and `createStoryWriter` tests are kept as they are; the `MovieStories` tests are new.
```ts
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
```

**File:** `tests/integration/movies.api.int.test.ts`.
- Add `StoryResponse` to the type import on line 6:
  ```ts
  import type { FileChangeResponse, MoviesStatusResponse, StoryResponse, SyncResponse, TitleListResponse, TmdbSearchResponse, UnmatchedResponse } from '../../src/http/moviesApi.js';
  ```
- Replace the whole `describe('the story of an episode', …)` block (lines 295-362) with the block below. It also replaces any edit phase 1 made in that block: the old `dialogue(...).story` and `storySlots` assertions at 341-344 test the store phase 1 retired.
```ts
describe('the story of a film, an episode and a season', () => {
  const SOURCE = { url: 'https://en.wikipedia.org/wiki/MobLand', title: 'MobLand', site: 'Wikipedia' };
  interface Calls {
    web: string[];
    dialogue: string[];
  }
  /** `told`: the episodes the fake web writer has a recap of; null: no web writer. */
  const storyApp = (calls: Calls, told: ReadonlySet<number> | null, dialogueWriter = true): Hono => {
    const stories = new MovieStories({
      repo: here.repo,
      // No stream service in this test: only a stored dialogue can be read.
      dialogue: (target) => loadDialogue(here.repo, null, target),
      writer: dialogueWriter
        ? {
            model: 'test-model',
            write: async (input) => {
              calls.dialogue.push(input.dialogue);
              return `The story of ${input.title} ${input.code}.\n\nIt ends.`;
            },
          }
        : null,
      webWriter:
        told === null
          ? null
          : {
              model: 'web-model',
              write: async (input) => {
                calls.web.push(`${input.scope} ${input.season}: ${input.episodes.map((e) => e.episode).join(',')}`);
                return {
                  sections: input.episodes.map((e) => ({ episode: e.episode, name: e.name, text: told.has(e.episode) ? `Recap of ${e.episode}.` : '', found: told.has(e.episode) })),
                  sources: input.episodes.some((e) => told.has(e.episode)) ? [SOURCE] : [],
                };
              },
            },
      now: () => new Date('2026-11-20T00:00:00Z'),
      log: () => undefined,
    });
    const app = new Hono();
    app.route('/', moviesApiRoutes({ ...h.deps, config: { ...h.deps.config, movies: MOVIES_TEST_CONFIG }, movies: here, movieStories: stories }, { sseHeartbeatMs: 50 }));
    return app;
  };
  const seedDialogue = () =>
    here.repo.saveDialogue({ titleId: 'tv-247718', season: 1, episode: 2, lang: 'en', provider: 'VidNest Anime', cues: 2, lastCueS: 70, body: '00:05\tWho are you?\n01:10\tI am the fixer.', fetchedAt: new Date('2026-11-16T05:00:00Z') });
  const errorOf = async (res: Response): Promise<[number, string]> => [res.status, ((await res.json()) as { error: string }).error];

  it('writes a season story from the web on POST {season}, keeps it, marks the season, and reads it back without a model', async () => {
    const calls: Calls = { web: [], dialogue: [] };
    const app = storyApp(calls, new Set([1, 2]));
    expect(await getJson<StoryResponse>(app, '/api/movies/tv-247718/story?season=1')).toEqual({ status: 200, body: { story: null, cached: true } });

    const res = await post(app, '/api/movies/tv-247718/story', { season: 1 });
    expect(res.status).toBe(200);
    const first = (await res.json()) as StoryResponse;
    expect(first).toMatchObject({ cached: false, story: { season: 1, episode: 0, origin: 'web', model: 'web-model', sources: [SOURCE], provider: null, cues: null } });
    expect(first.story?.sections).toEqual([
      { episode: 1, name: 'Stick or Twist', text: 'Recap of 1.', found: true },
      { episode: 2, name: 'Episode Two', text: 'Recap of 2.', found: true },
      { episode: 3, name: 'Episode Three', text: '', found: false },
    ]);
    expect(calls).toEqual({ web: ['season 1: 1,2,3'], dialogue: [] });

    expect((await (await post(app, '/api/movies/tv-247718/story', { season: 1 })).json()) as StoryResponse).toEqual({ story: first.story, cached: true });
    expect((await getJson<StoryResponse>(app, '/api/movies/tv-247718/story?season=1')).body).toEqual({ story: first.story, cached: true });
    expect(calls.web).toHaveLength(1);

    const detail = await getJson<TitleDetail>(app, '/api/movies/tv-247718');
    expect(detail.body.seasons[0]?.has_story).toBe(true);
    expect(detail.body.seasons[0]?.episodes.map((e) => e.has_story)).toEqual([false, false, false]);
    expect(detail.body.has_story).toBe(false);
  });

  it('writes an episode from the web first, and from its stored subtitle only when the web has none', async () => {
    const calls: Calls = { web: [], dialogue: [] };
    const app = storyApp(calls, new Set([1]));
    await seedDialogue();
    const web = (await (await post(app, '/api/movies/tv-247718/story', { season: 1, episode: 1 })).json()) as StoryResponse;
    expect(web).toMatchObject({ cached: false, story: { season: 1, episode: 1, origin: 'web', text: 'Recap of 1.', sections: [], sources: [SOURCE], provider: null } });
    const sub = (await (await post(app, '/api/movies/tv-247718/story', { season: 1, episode: 2 })).json()) as StoryResponse;
    expect(sub).toMatchObject({ cached: false, story: { season: 1, episode: 2, origin: 'dialogue', text: 'The story of MobLand (2025) S01E02.\n\nIt ends.', sources: [], provider: 'VidNest Anime', cues: 2 } });
    expect(calls).toEqual({ web: ['episode 1: 1', 'episode 1: 2'], dialogue: ['[00:05] Who are you?\n[01:10] I am the fixer.'] });
    expect((await getJson<StoryResponse>(app, '/api/movies/tv-247718/story?season=1&episode=2')).body).toEqual({ story: sub.story, cached: true });

    const detail = await getJson<TitleDetail>(app, '/api/movies/tv-247718');
    expect(detail.body.seasons[0]?.episodes.map((e) => [e.episode, e.has_story])).toEqual([[1, true], [2, true], [3, false]]);
    expect(detail.body.seasons[0]?.has_story).toBe(false);
  });

  it('answers why there is none: no source at all, a season of a film, an unknown title, another origin, a bad slot, stories off', async () => {
    const calls: Calls = { web: [], dialogue: [] };
    const app = storyApp(calls, new Set());
    expect(await errorOf(await post(app, '/api/movies/tv-247718/story', { season: 1, episode: 3 }))).toEqual([404, 'no_story_source']);
    expect(await errorOf(await post(app, '/api/movies/tv-247718/story', { season: 1 }))).toEqual([404, 'no_story_source']);
    expect((await getJson<StoryResponse>(app, '/api/movies/tv-247718/story?season=1')).body.story).toBeNull();
    expect(await errorOf(await post(app, '/api/movies/movie-467905/story', { season: 1 }))).toEqual([404, 'not_found']);
    expect((await post(app, '/api/movies/tv-999999/story', { season: 1, episode: 1 })).status).toBe(404);
    expect((await post(app, '/api/movies/tv-247718/story', { season: 1 }, {})).status).toBe(403);
    expect((await post(app, '/api/movies/tv-247718/story', { season: 1, episode: -1 })).status).toBe(400);
    expect((await app.request('/api/movies/tv-247718/story?season=x')).status).toBe(400);
    expect(await errorOf(await post(storyApp(calls, null, false), '/api/movies/tv-247718/story', { season: 1 }))).toEqual([503, 'story_off']);
    // Without the stories service at all (a daemon older than it): 503.
    expect((await post(appFor(here), '/api/movies/tv-247718/story', { season: 1, episode: 2 })).status).toBe(503);
    expect(calls.dialogue).toEqual([]);
  });
});
```
**Impact:** this proves R6.1, R6.2, R6.4, R6.5 and R6.6 at the unit and HTTP levels. The cases that need a database run under `npm run test:int`.

## Principles applied

- Laziness protocol: a season reuses the existing story route (`{season}` alone) and `MovieStories.get(titleId, season, 0)`. No new route and no separate `getSeason` were added. The third copy of the Agent SDK loop was lifted into `runAgentText` (Step 1) and reused by the story and guide writers rather than written again.
- Make illegal states unrepresentable:
  - `parseWebStory` builds the section list from the episodes asked for, so a section for an invented episode cannot be represented.
  - Section names come from TMDB, not the model.
  - A `found: true` section with no backing page cannot leave the parser.
  - The season story's `StoryView` carries `provider`/`cues` as null instead of fake values.
- Encode lessons in structure: the owner's complaint (subtitle stories invent) and invariant 12 are enforced in code, not only in the prompt. A section counts only when it cites a URL that this run's own WebSearch results contained (`searchedKeys` + `sourceKey`), and a season story never has a code path that reads a subtitle (`writeNewSeason` never touches `opts.dialogue`).
- Boundary discipline: the model's answer is validated once, in `parseWebStory`; `MovieStories` trusts a `WrittenWebStory`. The HTTP input is validated once, in `storySlot`.
- Test behavior, not implementation: the tests drive `MovieStories` and the HTTP routes through the injected writer seam and assert what a caller sees: the answer, what was stored, and whether a model or subtitle was asked. They do not assert private calls.
- Prove it works: J4 reads a stored season story back from a real throwaway daemon whose story model is pinned `off`, so a 200 `cached: true` there is proof that no model was called.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` (includes `tests/unit/docs/reference.test.ts` after `npm run docs:gen`) and `npm run test:int -- tests/integration/movies.api.int.test.ts tests/integration/movies.guides.int.test.ts`
**Proof:** the unit and HTTP tests prove the writer, parser and routes against fake writers; no test calls a model or the network. The real artifact is a throwaway daemon, which serves a stored season story and the per-season flag with no model available.
- Harness: `.claude/skills/verify-notesd` (`verify.sh up --movies`; `NOTESD_MOVIES_STORY_MODEL=off` is pinned there, so no run is billed)
- Feature-map entries: `features/movies.md` (the book icon / story entry, read here; its update is phase 9's, see Handoffs)
- Journeys:
  - **J1** · traces R6.1 — `npx vitest run tests/unit/movies/story.test.ts -t "one section per aired episode"`, then `npm run test:int -- tests/integration/movies.api.int.test.ts -t "writes a season story from the web"` → passes when both report 1 passed and 0 failed. The second test asserts that `POST /api/movies/tv-247718/story {"season":1}` answered 200 with `story.episode` 0, `origin` `web`, 3 `sections` with `found` `[true,true,false]`, and that `GET /api/movies/tv-247718` then has `seasons[0].has_story === true`.
  - **J2** · traces R6.2 — `npx vitest run tests/unit/movies/webStory.test.ts -t "WebSearch as its one tool"`, then `npx vitest run tests/unit/movies/story.test.ts -t "never a subtitle"` → passes when both report 1 passed. The first asserts that the run's options are `tools: ['WebSearch']`, `allowedTools: ['WebSearch']`, `mcpServers: {}` and that a URL the model only remembered is dropped. The second asserts that the season was written with the dialogue reader and the subtitle writer never called.
  - **J3** · traces R6.4 — `npx vitest run tests/unit/movies/webStory.test.ts -t "parseWebStory"`, then `npx vitest run tests/unit/movies/story.test.ts -t "no source tells"` → passes when all report passed. They assert:
    - an episode the answer left out, and one backed only by an unsearched URL, come back `{found: false, text: ''}`;
    - an invented episode 9 is dropped;
    - the season text holds `No published recap was found for this episode.` under that episode's heading;
    - a season with no episode told answers `no_story_source` and stores nothing.
  - **J4** · traces R6.5 — on a throwaway daemon:
    1. `V=.claude/skills/verify-notesd/scripts/verify.sh; eval "$($V up --movies | grep -E '^(RUN|URL|EVIDENCE)=')"`
    2. `for i in $(seq 60); do $V api $RUN GET /api/movies/tv-247718 | grep -q '^< HTTP 200' && break; sleep 1; done`
    3. `$V api $RUN POST /api/movies/tv-247718/story '{"season":1}'`. It must answer `< HTTP 503` with `"error":"story_off"`: no model is available to write one.
    4. `$V exec $RUN "insert into movie_stories (title_id, season, episode, text, sections, sources, origin, model, written_at) values ('tv-247718', 1, 0, 'S01E01 · Stick or Twist', '[{\"episode\":1,\"name\":\"Stick or Twist\",\"text\":\"Seeded.\",\"found\":true},{\"episode\":2,\"name\":null,\"text\":\"\",\"found\":false}]'::jsonb, '[{\"url\":\"https://en.wikipedia.org/wiki/MobLand\",\"title\":\"MobLand\",\"site\":\"Wikipedia\"}]'::jsonb, 'web', 'seeded', now())"`
    5. `$V api $RUN POST /api/movies/tv-247718/story '{"season":1}' | sed '1,/^< HTTP /d' | jq -c '[.cached, .story.origin, (.story.sections|length), .story.sections[1].found, .story.sources[0].site]'`
    6. `$V api $RUN GET /api/movies/tv-247718 | sed '1,/^< HTTP /d' | jq '.seasons[] | select(.season==1) | .has_story'`
    7. `$V note $RUN "phase 6 J4: stored season story answered cached with the model off"`, then `$V down $RUN`.

    → passes when step 3 shows 503 `story_off`, step 5 prints `[true,"web",2,false,"Wikipedia"]` (the stored story was answered with the story model pinned off, so no model was called), and step 6 prints `true`. The unit side is `npx vitest run tests/unit/movies/story.test.ts -t "from the store without calling a model"` (1 passed).
  - **J5** · traces R6.6 — `npx vitest run tests/unit/movies/story.test.ts -t "web first"`, then `npm run test:int -- tests/integration/movies.api.int.test.ts -t "writes an episode from the web first"` → passes when all report passed. They assert:
    - S18E759 (the web has a recap): `origin: "web"`, the dialogue reader never called;
    - S18E760 and MobLand S01E02 (the web answered `found: false`): `origin: "dialogue"` with `provider: "VidNest Anime"` and `cues: 2`, the subtitle read once;
    - a failed web run is `story_failed` and reads no subtitle.
- Neighbor check: the genre guide, whose writer now runs through `runAgentText`, and the old dialogue stories phase 1 copied. Run `npx vitest run tests/unit/movies/guides.test.ts` and `npm run test:int -- tests/integration/movies.guides.int.test.ts` → both report 0 failed. On the J4 daemon, before `down`, run `$V api $RUN GET '/api/movies/tv-247718/story?season=1&episode=2'` → `< HTTP 200` with `{"story":null,"cached":true}`.
- Cost: none for J1–J5. No journey calls a model (fakes in tests; the story model is pinned `off` on the throwaway daemon). `npm run test:live:webStory` (Step 0's confirmation) is one billed run and is opt-in, never part of a journey.

**Exit criteria:**
- Step 0 is settled: `SEARCH_RESULTS_CARRY_URLS` is set from the installed SDK's types, and the commit message names the `.d.ts` line that settles it.
- `npm run typecheck`, `npm test` (the docs reference test included) and `npm run test:int -- tests/integration/movies.api.int.test.ts tests/integration/movies.guides.int.test.ts` pass.
- J1 to J5 pass.
- `POST /api/movies/:id/story {"season":N}` writes or serves a season's story with one section per aired episode, `origin`, `sources` and `sections`.
- An episode's story is web-first, with the subtitle as a fallback only on `found: false`.

## Handoffs

- **Phase 1 (assumed done, see Requires):**
  - `movie_stories` with the columns and Drizzle field names above, its FK to `movie_titles` with cascade;
  - `MovieStorySection`/`MovieStorySource` exported from `src/db/schema.ts`;
  - `MoviesRepo.story(titleId, season, episode)` and the object-form `saveStory({titleId, season, episode, text, sections, sources, origin, model, writtenAt})`;
  - `getTitle`'s `stories` query on `movie_stories`.

  If phase 1 named any of these differently, the reconciler renames them in Steps 3, 4 and 10. This phase replaces `src/movies/story.ts` and the integration test's story block whole, superseding any interim edit phase 1 made there.
- **Phase 7 (R6.1's pop-up, R6.3):** the server now answers everything the pop-up needs:
  - `StoryView` gains `origin`, `sources: {url, title, site}[]` and `sections: {episode, name, text, found}[]`, and `provider` and `cues` become nullable.
  - `SeasonView` gains `has_story`.
  - The season form of `writeStory` posts `{season}` alone.
  - `storyErrorText` must learn `no_story_source` (404). `no_dialogue` is gone.
  - The foot `written … from {cues} subtitle lines ({provider})` must change for `origin: 'web'` (otherwise it reads "null").
  - The wait text: a season can take up to 7 minutes (`DEFAULT_WEB_STORY_TIMEOUT_MS`).

  R6.3 (sources as links) is phase 7's. This phase only supplies `sources`.
- **Phase 9:**
  - `docs/guide/movies.md` and `docs/guide/streaming.md` ("What a title says"): web-first stories, the season story, the source order, `no_story_source`.
  - The `NOTESD_MOVIES_STORY_MODEL` row in `docs/guide/reference/configuration.md` still says "writes the story of an episode from its dialogue". It should say web-first, with season stories.
  - `.claude/skills/verify-notesd/features/movies.md`: the story entry should name `tests/unit/movies/webStory.test.ts`, the season story, and J4's seeded `movie_stories` drive.
  - The feature-map update is required by the planning rules for a user-facing change, but it belongs to phase 9 under the index.
- **Phase 5 (overlap, not a handoff of work):** Step 7 adds `has_story: false` to the `SeasonView` fixture at `tests/unit/directStream/cacheShelf.test.ts:106` so the tree typechecks. Phase 5 edits the same test file, and the integrator keeps both edits.
- **Not in any phase (owner's call later):** a stored season story is never refreshed. A season still airing keeps the episodes it had when it was written. A `refresh` flag like the genre guide's would cover it.

## Rollback

Revert this phase's commit(s). That restores the subtitle-only `MovieStories`, the old route validation, `createGuideWriter`'s own loop and the old route descriptions; run `npm run docs:gen` to regenerate the reference. The phase adds no migration, and stories it wrote stay in `movie_stories` (phase 1's table). After a revert, a stored `web` story is still served by phase 1's read path, and nothing is lost.
