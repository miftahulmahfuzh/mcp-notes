> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/movies-library/PLAN.md` phase 2. Source: `.workflows/plan/movies-library/phase-2.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 2: Filename parser, TMDB client, matcher, Haiku fallback

**Plan set:** `MOVIES_LIBRARY_PLAN.md`
**Analysis:** `.workflows/analyze/20261114-121616-M7VL_code_analyzer.md`
**Satisfies:** R1, R2 — the library knows what each video file is (title, year, season, episode) and can fetch everything TMDB knows about that title
**Criteria:** R1.3, R2.1, R2.2
**Depends on:** none (runs in parallel with Phase 1)
**Difficulty:** HARD
**Package:** `src/movies`

---

## Goal

After this phase, four pure library modules exist under `src/movies/`: `parseVideoPath` turns every filename shape found on the owner's disk into a title, year, season, episode and absolute episode; `createTmdbClient` searches TMDB and returns a complete `TitleMetadata` (poster, release date, synopsis, companies, directors, writers, producers, creators, cast with characters, and every season's episodes); `matchTitle` applies one written confidence rule and asks the Haiku fallback only when the file name is not confident. Nothing is wired into the daemon yet: Phase 3 calls these from the sync pass and stores what they return.

All the code below was prototyped in a scratch copy of this worktree before the plan was written: `npx tsc -p tsconfig.json` was clean, the four test files passed (84 tests), and the live journey J4 matched the real names against the real TMDB (including One Piece 405 -> season 11, episode 405).

## Interface Contract

**Deletes:** nothing
**Renames:** nothing
**Creates:**
- `src/movies/parse.ts`: `VIDEO_EXTENSIONS`, `KindHint`, `ParsedName`, `isVideoFile(name)`, `normalizeTitle(text)`, `compactTitle(text)`, `parseVideoPath(relPath): ParsedName`
- `src/movies/tmdb.ts`: types `TitleKind`, `CreditRole`, `CompanyMeta`, `CreditMeta`, `EpisodeMeta`, `TitleMetadata` (a temporary structural mirror of phase 1's `types.ts`; phase 3 turns it into a re-export), `TmdbSearchHit`, `TmdbPersonHit`, `TmdbPersonCredit`, `TmdbClient`, `TmdbClientConfig`, `TmdbClientOptions`, `TmdbErrorCode`; class `TmdbError`; `createTmdbClient(config, fetch?, options?)`, `posterUrl(imageBase, path, size?)`, `absoluteToSeasonEpisode(episodes, n)`, `yearOf(date)`, `crewRole(job, department)`; constants `TMDB_TIMEOUT_MS`, `MAX_CAST`, `MAX_CREW_PER_ROLE`, `DEFAULT_POSTER_SIZE`
- `src/movies/match.ts`: `CONFIDENT_SCORE` (0.85), `MAX_CANDIDATES`, `MatchResult`, `matchTitle(parsed, client, fallback?)`, `titleSimilarity`, `yearAdjustment`, `scoreHit`, `searchQuery`
- `src/movies/fallback.ts`: `NameFallback`, `FallbackAnswer`, `HaikuFallbackOptions`, `createHaikuFallback(opts)`, `parseFallbackAnswer(raw)`, `buildFallbackInput(fileName, dirName)`, `FALLBACK_SYSTEM_PROMPT`, `DEFAULT_FALLBACK_MODEL`, `DEFAULT_FALLBACK_TIMEOUT_MS`
- `tests/helpers/tmdbFixtures.ts`: `fixtureFetch()`, `startTmdbFixtureServer()`, `tmdbFixtureResponse`, `fixtureFileFor`, `FIXTURE_API_BASE`, `TMDB_FIXTURE_DIR`
- `tests/fixtures/movies/filenames.ts` (`FILENAME_CASES`) and 8 TMDB JSON fixtures in `tests/fixtures/movies/`

**Signature changes (relative to the index's Shared contract, additive only — the reconciler should copy them into the index):**
- `ParsedName` carries two more fields: `fileName` (base name, extension included) and `dirName` (parent folder or `null`). `matchTitle` needs them to ask the fallback, and Phase 3 may store them in `movie_files.parsed`.
- `MatchResult`'s matched arm carries two more fields: `source: 'filename' | 'fallback'` and `matchedTitle`. The `none` arm's `reason` is `'no_match' | 'low_confidence'` (both are `FileReason` values).
- `matchTitle(parsed, client, fallback?: NameFallback | null)`. **It throws `TmdbError`** when TMDB cannot be reached; it never turns an outage into `none`. Phase 3 catches it and leaves the file `pending` (R2.3).
- `NameFallback` gains `readonly model: string`; `resolve(fileName: string, dirName: string | null)` **never rejects**. A failed Haiku call is logged and answers `null`.
- `createHaikuFallback(opts: HaikuFallbackOptions): NameFallback | null`. `opts` is `{ claudeBin, cwd, model?, query?, baseEnv?, timeoutMs?, log? }`, the same shape as `createAgentSummarizer`. It returns `null` when the claude binary is missing.
- `createTmdbClient(config: { token, apiKey, apiBase }, fetch = globalThis.fetch, options = { timeoutMs })`. `config.movies.tmdb` from Phase 1 fits as-is (extra fields are ignored). With no credentials the client is still built, and every call rejects with `TmdbError` code `no_credentials` without sending a request.
- `absoluteToSeasonEpisode(episodes: ReadonlyArray<{ season; episode }>, n)` takes `TitleMetadata.episodes`, not per-season counts. It returns the n-th listed episode over seasons >= 1 with **TMDB's own episode number**. On TMDB, One Piece season 2 starts at episode 62, so a cumulative-count mapping would return episode numbers that do not exist. The index's Decisions row "map to TMDB season/episode by cumulative episode counts" should read "the n-th listed episode over seasons >= 1".

**`TitleMetadata` (reconciled: phase 1's names and fields, mirrored here):** Phase 1 owns the single definition in `src/movies/types.ts` (`TitleKind`, `CreditRole`, `CompanyMeta`, `CreditMeta`, `EpisodeMeta`, `TitleMetadata`). Phases 1 and 2 run in the same wave and neither can import the other, so `tmdb.ts` declares a field-for-field structural copy under the same names (Step 4), and **Phase 3** (the first phase that has both) replaces that block in `tmdb.ts` with `export type { TitleKind, CreditRole, CompanyMeta, CreditMeta, EpisodeMeta, TitleMetadata } from './types.js';`. There is no `ord` field: order is array order, and `MoviesRepo.upsertTitle` stores each list's index as `ord`.

```ts
type TitleKind = 'movie' | 'tv';
type CreditRole = 'cast' | 'director' | 'writer' | 'producer' | 'creator';
interface CompanyMeta { id: number; name: string; logoPath: string | null; originCountry: string | null }
interface CreditMeta { personId: number; name: string; profilePath: string | null; role: CreditRole; character: string | null; job: string | null }
interface EpisodeMeta { season: number; episode: number; name: string; airDate: string | null; runtimeMin: number | null; overview: string | null; stillPath: string | null }
interface TitleMetadata {
  kind: TitleKind; tmdbId: number; title: string; originalTitle: string; year: number | null;
  releaseDate: string | null; overview: string; posterPath: string | null; backdropPath: string | null;
  runtimeMin: number | null; genres: string[]; seasonCount: number | null; episodeCount: number | null;
  companies: CompanyMeta[]; credits: CreditMeta[]; episodes: EpisodeMeta[];
}
```

`ParsedName` (`{ title, year, season, episode, absoluteEpisode, kindHint, fileName, dirName }`) is assignable to phase 1's `MovieParsedName` (the two extra fields are allowed by structural typing), so phase 3 stores it in `movie_files.parsed` as-is.

**Requires (from earlier phases):** nothing. Phase 1 is not needed: this phase reads no config, no DB and no `types.ts`.
**Leaves alone (owned by others):** `src/config.ts`, `src/db/*`, `drizzle/*`, `src/movies/types.ts`, `state.ts`, `repo.ts`, `service.ts` (Phase 1/3); `scan.ts`, `sync.ts` (Phase 3); `src/http/*` (Phases 1/4/5); `web/*` (Phase 6); `src/mcp/*`, `src/chat/*` (Phase 7); docs and `features/` (Phase 8). It imports `findClaudeBin` from `src/sessions/summarize.ts` and `claudeEnv`/`QueryFn` from `src/chat/*` but does not change them.

## Files

| File | Action | What changes |
|---|---|---|
| `src/movies/parse.ts:1` | create | filename parser (Step 1) |
| `tests/fixtures/movies/filenames.ts:1` | create | the real-name table, the parser's spec (Step 2) |
| `tests/unit/movies/parse.test.ts:1` | create | table-driven parser tests (Step 3) |
| `src/movies/tmdb.ts:1` | create | TMDB client, `TitleMetadata`, `TmdbError`, helpers (Step 4) |
| `tests/fixtures/movies/movie-467905.json:1` | create | movie details + credits fixture (Step 5) |
| `tests/fixtures/movies/tv-247718.json:1` | create | series details + aggregate credits fixture (Step 5) |
| `tests/fixtures/movies/tv-247718-season-1.json:1` | create | season fixture (Step 5) |
| `tests/fixtures/movies/tv-247718-season-2.json:1` | create | season fixture (Step 5) |
| `tests/fixtures/movies/search-movie-how-to-make-a-killing.json:1` | create | movie search fixture (Step 5) |
| `tests/fixtures/movies/search-tv-mobland.json:1` | create | tv search fixture (Step 5) |
| `tests/fixtures/movies/search-person-margaret-qualley.json:1` | create | person search fixture (Step 5) |
| `tests/fixtures/movies/person-1392137-combined-credits.json:1` | create | filmography fixture (Step 5) |
| `tests/helpers/tmdbFixtures.ts:1` | create | fake TMDB: injected fetch + real HTTP server over the fixtures (Step 6) |
| `tests/unit/movies/tmdb.test.ts:1` | create | client tests (Step 7) |
| `src/movies/fallback.ts:1` | create | Haiku name fallback (Step 8) |
| `tests/unit/movies/fallback.test.ts:1` | create | fallback tests with a fake `QueryFn` (Step 9) |
| `src/movies/match.ts:1` | create | confidence rule + `matchTitle` (Step 10) |
| `tests/unit/movies/match.test.ts:1` | create | matcher tests with a fake client and fallback (Step 11) |

No existing file is modified.

## Implementation Steps

Before step 1, if `node_modules` is missing in the worktree (it was missing when this plan was written), run `cd /home/miftah/.worktrees/mcp-notes/movies-library && npm ci`.

### Step 1: Filename parser
**File:** `src/movies/parse.ts:1` (new)
**Change:** A pure parser. Only the file name and its parent folder are read. A done folder or collection folder above them never reaches the title. The parent folder lends its title, a year (only to the same film, compared with `compactTitle`) and a season. The title ends at the first marker: SxxEyy, `S01`, `Season N`, `E04`, or a release tag. The year is the last year-like token before that marker, and never the first token, so "1917.2019" gives the title 1917 with year 2019 and "Ne.Zha.2.2025" gives "Ne Zha 2" with year 2025. A trailing `- 405` is an absolute episode.
**Code:**
```ts
/**
 * Video file names -> what to look up on TMDB. Pure string work: no fs, no network, never throws.
 *
 * The input is a path relative to a library root, `/` or `\` separated
 * ("Done/Nezha (2019)/Ne.Zha.2.2025.1080p.WEB-DL.x265.6CH-Pahe.in.mkv"). Only the file name and its
 * parent folder are read, so a folder above them (a done folder such as "Done", a collection such
 * as "Pak Bernard") is never part of the title. The parent folder only lends what the file name
 * lacks:
 * - its title, when the file name has none ("Mobland S01 .../S01E07.mkv");
 * - its year, when it names the same film ("Oldboy (2003)/Oldboy.mkv"). A folder that holds two
 *   films ("Nezha (2019)/Ne.Zha.2.2025...") lends nothing: the file carries its own year, or its
 *   title differs from the folder's;
 * - its season ("Person of Interest Season 1 .../Person.of.Interest.E04...").
 *
 * The six shapes on disk: Pahe dots, Pahe spaces/underscores, year only in the folder, SxxEyy in a
 * season folder, absolute numbering ("One Piece - 405 720p ..."), two films in one folder. The
 * table in tests/fixtures/movies/filenames.ts is the spec.
 */

export const VIDEO_EXTENSIONS: readonly string[] = ['mkv', 'mp4', 'avi', 'm4v', 'webm'];

/** What the name says the file is: a film, an episode, or no clue. */
export type KindHint = 'movie' | 'tv' | null;

export interface ParsedName {
  /** Readable title, release tags removed ("Ne Zha 2", "E.T. the Extra-Terrestrial"); '' when nothing is left. */
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  /** "One Piece - 405": the episode counted from the first, no season. */
  absoluteEpisode: number | null;
  kindHint: KindHint;
  /** The file's base name, extension included: the Haiku fallback's input. */
  fileName: string;
  /** The parent folder's name; null for a file directly under the root. */
  dirName: string | null;
}

const MIN_YEAR = 1900;
/** A 4-digit token above this is not a year ("Blade Runner 2049" without its own year stays whole). */
const MAX_YEAR = new Date().getFullYear() + 1;

const BRACKETED = /\[[^\]]*\]|\{[^}]*\}/g;
const RELEASE_GROUP_SUFFIX = /[-_. ]+pahe[._ ]in$/i;
const SXXEYY = /^s(\d{1,2})e(\d{1,4})(?:-?e\d{1,4})*$/i;
const SEASON_TOKEN = /^s(\d{1,2})$/i;
const SEASON_WORD = /^season$/i;
const EPISODE_TOKEN = /^ep?(\d{1,4})$/i;
const YEAR_TOKEN = /^\(?(\d{4})\)?$/;
const NUMBER_TOKEN = /^\d{1,4}$/;
const DASH_TOKEN = /^[-–—]$/;
const PUNCT_TOKEN = /^[-–—:,.+]+$/;
/** Release tags: resolution, source, codec, bit depth, audio. Never title words, so the title ends before the first one. */
const QUALITY_TOKEN =
  /^(?:\d{3,4}[pi]|4k|uhd|hdr(?:10)?\+?|dv|dovi|web-?dl|web-?rip|blu-?ray|bdrip|brrip|dvdrip|hdtv|hdrip|remux|x26[45]|h\.?26[45]|hevc|avc|xvid|\d{1,2}-?bit|\d(?:\.\d)?ch|aac(?:\d(?:\.\d)?)?|e?ac-?3|ddp?\+?(?:\d(?:\.\d)?)?|atmos|truehd|dts(?:-?hd)?)$/i;

export function isVideoFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return false;
  return VIDEO_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
}

/** Lower case, accents and punctuation gone, single spaces: "WALL·E" and "WALL-E" both give "wall e". */
export function normalizeTitle(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** normalizeTitle without spaces: "Nezha" and "Ne Zha" are the same film. */
export function compactTitle(text: string): string {
  return normalizeTitle(text).replace(/ /g, '');
}

interface SegmentParse {
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  /** "E04" / "EP04" with no season in this segment: an episode when the folder names a season, else absolute. */
  bareEpisode: number | null;
  absoluteEpisode: number | null;
}

function yearOfToken(token: string): number | null {
  const m = YEAR_TOKEN.exec(token);
  if (m === null) return null;
  const year = Number(m[1]);
  return year >= MIN_YEAR && year <= MAX_YEAR ? year : null;
}

/**
 * Words of one path segment. Brackets ("[Pahe.in]") and the Pahe suffix go first. A segment with
 * spaces keeps its dots ("E.T. the Extra-Terrestrial"); one without splits on dots and underscores.
 */
function tokenize(segment: string): string[] {
  const stripped = segment.replace(BRACKETED, '').trim().replace(RELEASE_GROUP_SUFFIX, '');
  const words = stripped.includes(' ') ? stripped.replace(/_/g, ' ') : stripped.replace(/[._]+/g, ' ');
  return words.split(/\s+/).filter((t) => t !== '');
}

function trimPunctuation(tokens: string[]): string[] {
  let start = 0;
  let end = tokens.length;
  while (start < end && PUNCT_TOKEN.test(tokens[start] ?? '')) start++;
  while (end > start && PUNCT_TOKEN.test(tokens[end - 1] ?? '')) end--;
  return tokens.slice(start, end);
}

function parseSegment(segment: string): SegmentParse {
  const tokens = tokenize(segment);
  let season: number | null = null;
  let episode: number | null = null;
  let bareEpisode: number | null = null;
  // The title ends at the first marker. Only SxxEyy may stand first ("S01E07.mkv"): any other
  // marker in first place is the title itself.
  let bound = tokens.length;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? '';
    const se = SXXEYY.exec(token);
    if (se !== null) {
      season = Number(se[1]);
      episode = Number(se[2]);
      bound = i;
      break;
    }
    if (i === 0) continue;
    const seasonOnly = SEASON_TOKEN.exec(token);
    if (seasonOnly !== null) {
      season = Number(seasonOnly[1]);
      bound = i;
      break;
    }
    const next = tokens[i + 1];
    if (SEASON_WORD.test(token) && next !== undefined && NUMBER_TOKEN.test(next)) {
      season = Number(next);
      bound = i;
      break;
    }
    const ep = EPISODE_TOKEN.exec(token);
    if (ep !== null) {
      bareEpisode = Number(ep[1]);
      bound = i;
      break;
    }
    if (QUALITY_TOKEN.test(token)) {
      bound = i;
      break;
    }
  }
  // The year is the LAST year-like token before the bound, never the first token: "1917 2019"
  // is 1917 from 2019, "Ne Zha 2 2025" is "Ne Zha 2" from 2025.
  let year: number | null = null;
  let cut = bound;
  for (let i = bound - 1; i >= 1; i--) {
    const y = yearOfToken(tokens[i] ?? '');
    if (y !== null) {
      year = y;
      cut = i;
      break;
    }
  }
  let titleTokens = trimPunctuation(tokens.slice(0, cut));
  // "One Piece - 405": a dash then a bare number closes the title of an absolutely numbered episode.
  let absoluteEpisode: number | null = null;
  const last = titleTokens[titleTokens.length - 1];
  const beforeLast = titleTokens[titleTokens.length - 2];
  if (
    season === null &&
    titleTokens.length >= 3 &&
    last !== undefined &&
    beforeLast !== undefined &&
    NUMBER_TOKEN.test(last) &&
    DASH_TOKEN.test(beforeLast)
  ) {
    absoluteEpisode = Number(last);
    titleTokens = trimPunctuation(titleTokens.slice(0, -2));
  }
  return { title: titleTokens.join(' '), year, season, episode, bareEpisode, absoluteEpisode };
}

/** Title, year, season, episode and absolute episode of one video path. Never throws. */
export function parseVideoPath(relPath: string): ParsedName {
  const segments = relPath.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
  const fileName = segments[segments.length - 1] ?? '';
  const dirName = segments.length >= 2 ? (segments[segments.length - 2] ?? null) : null;
  const stem = isVideoFile(fileName) ? fileName.slice(0, fileName.lastIndexOf('.')) : fileName;

  const file = parseSegment(stem);
  const dir = dirName === null ? null : parseSegment(dirName);

  const title = file.title !== '' ? file.title : (dir?.title ?? '');
  const sameFilm = dir !== null && (file.title === '' || compactTitle(file.title) === compactTitle(dir.title));
  const year = file.year ?? (sameFilm && dir !== null ? dir.year : null);
  const season = file.season ?? dir?.season ?? null;
  let episode = file.episode;
  let absoluteEpisode = file.absoluteEpisode;
  if (file.bareEpisode !== null) {
    if (season !== null) episode = file.bareEpisode;
    else absoluteEpisode = file.bareEpisode;
  }
  const kindHint: KindHint =
    season !== null || episode !== null || absoluteEpisode !== null ? 'tv' : year !== null ? 'movie' : null;
  return { title, year, season, episode, absoluteEpisode, kindHint, fileName, dirName };
}
```
**Impact:** new module, no callers yet.

### Step 2: The filename table
**File:** `tests/fixtures/movies/filenames.ts:1` (new)
**Change:** Every real name from the request, plus traps, with the expected parse. The unit test and Proof J1 both run this one table.
**Code:**
```ts
import type { ParsedName } from '../../../src/movies/parse.js';

/**
 * The real names on the owner's disk (2026-11-14), relative to a library root, and what
 * parseVideoPath must make of them. The spec of src/movies/parse.ts: the unit test and the phase 2
 * proof both run this table.
 */
export type FilenameShape =
  | 'pahe-dots'
  | 'pahe-underscores'
  | 'year-in-folder'
  | 'season-folder'
  | 'absolute'
  | 'two-films'
  | 'junk'
  | 'trap';

export interface FilenameCase {
  shape: FilenameShape;
  relPath: string;
  expected: Omit<ParsedName, 'fileName' | 'dirName'>;
}

function movie(title: string, year: number | null): FilenameCase['expected'] {
  return { title, year, season: null, episode: null, absoluteEpisode: null, kindHint: year === null ? null : 'movie' };
}

function episode(title: string, season: number, ep: number): FilenameCase['expected'] {
  return { title, year: null, season, episode: ep, absoluteEpisode: null, kindHint: 'tv' };
}

const MOBLAND_DIR = 'Mobland S01 WEB-DL 1080p x265 6CH [Pahe.in]';

export const FILENAME_CASES: readonly FilenameCase[] = [
  {
    shape: 'pahe-dots',
    relPath: 'How.to.Make.a.Killing.2026.1080p.WEB-DL.x265.6CH-Pahe.in.mkv',
    expected: movie('How to Make a Killing', 2026),
  },
  {
    shape: 'pahe-dots',
    relPath: 'By Any Means 2026 1080p WEB-DL x265 6CH-Pahe.in.mkv',
    expected: movie('By Any Means', 2026),
  },
  {
    shape: 'pahe-underscores',
    relPath: 'The_Rivals_of_Amziah_King_2026_1080p_BluRay_x265_DD+5_1_Pahe_in.mkv',
    expected: movie('The Rivals of Amziah King', 2026),
  },
  { shape: 'year-in-folder', relPath: 'Pak Bernard/Oldboy (2003)/Oldboy.mkv', expected: movie('Oldboy', 2003) },
  {
    shape: 'year-in-folder',
    relPath: 'Pak Bernard/E.T. the Extra-Terrestrial (1982)/E.T. the Extra-Terrestrial.mkv',
    expected: movie('E.T. the Extra-Terrestrial', 1982),
  },
  {
    shape: 'year-in-folder',
    relPath: 'Pak Bernard/Batman - The Killing Joke (2016)/Batman - The Killing Joke.mkv',
    expected: movie('Batman - The Killing Joke', 2016),
  },
  {
    shape: 'season-folder',
    relPath: `${MOBLAND_DIR}/MobLand.S01E01.Stick.or.Twist.1080p.WEB-DL.x265.6CH-Pahe.in.mkv`,
    expected: episode('MobLand', 1, 1),
  },
  {
    shape: 'season-folder',
    relPath: `${MOBLAND_DIR}/MobLand.S01E05.Funeral.for.a.Friend.PROPER.1080p.WEB-DL.x265.6CH-Pahe.in.mkv`,
    expected: episode('MobLand', 1, 5),
  },
  {
    shape: 'season-folder',
    relPath: `${MOBLAND_DIR}/Mobland.S01E09.Beggars.Banquet.1080p.WEB-DL.x265.6CH-Pahe.in.mkv`,
    expected: episode('Mobland', 1, 9),
  },
  {
    shape: 'season-folder',
    relPath: `${MOBLAND_DIR}/MobLand.S01E02.Jigsaw.Puzzle.1080p.WEB-DL.x265.10Bit.6CH-Pahe.in.mkv`,
    expected: episode('MobLand', 1, 2),
  },
  {
    shape: 'season-folder',
    relPath: 'Person of Interest Season 1 x265 [Pahe.in]/Person.of.Interest.S01E01.Extended.720p.BluRay.x265.10Bit-Pahe.in.mkv',
    expected: episode('Person of Interest', 1, 1),
  },
  {
    shape: 'season-folder',
    relPath: 'Done/From S03 1080p x265 [Pahe.in]/From.S03E10.Revelations.Chapter.Two.1080p.WEB-DL.x265.6CH-Pahe.in.mkv',
    expected: episode('From', 3, 10),
  },
  {
    shape: 'absolute',
    relPath: 'Done/One Piece - 405 720p WEB-DL x264 2CH [Pahe.in].mkv',
    expected: { title: 'One Piece', year: null, season: null, episode: null, absoluteEpisode: 405, kindHint: 'tv' },
  },
  {
    shape: 'two-films',
    relPath: 'Done/Nezha (2019)/Ne.Zha.2019.1080p.UHD.BluRay.x265.HDR.DD5.1-Pahe.in.mkv',
    expected: movie('Ne Zha', 2019),
  },
  {
    shape: 'two-films',
    relPath: 'Done/Nezha (2019)/Ne.Zha.2.2025.1080p.WEB-DL.x265.6CH-Pahe.in.mkv',
    expected: movie('Ne Zha 2', 2025),
  },
  {
    shape: 'pahe-dots',
    relPath: 'Done/WALL-E.2008.1080p.UHD.BluRay.x265.HDR.DV.DD+5.1-Pahe.in.mkv',
    expected: movie('WALL-E', 2008),
  },
  {
    shape: 'pahe-dots',
    relPath: 'Done/Your.Eyes.Tell.2020.1080p.BluRay.x264.6CH-Pahe.in.mkv',
    expected: movie('Your Eyes Tell', 2020),
  },
  { shape: 'junk', relPath: 'Done/docker_es/VID-20220222-WA0011.mp4', expected: movie('VID-20220222-WA0011', null) },
  {
    shape: 'junk',
    relPath: 'Done/docker_es/s/Snapinsta_26084969_2014635765484161_3368348057538470914_n.mp4',
    expected: movie('Snapinsta 26084969 2014635765484161 3368348057538470914 n', null),
  },
  {
    shape: 'junk',
    relPath: 'Done/docker_es/WhatsApp Video 2021-11-21 at 08.58.22.mp4',
    expected: movie('WhatsApp Video 2021-11-21 at 08.58.22', null),
  },
  // Traps: a title that is a year, a folder that lends a year only to its own film, a season named only by the folder.
  { shape: 'trap', relPath: '1917.2019.1080p.BluRay.x265-Pahe.in.mkv', expected: movie('1917', 2019) },
  { shape: 'trap', relPath: 'Done/Nezha (2019)/Ne.Zha.2.mkv', expected: movie('Ne Zha 2', null) },
  { shape: 'trap', relPath: 'Done/Nezha (2019)/Nezha.mkv', expected: movie('Nezha', 2019) },
  {
    shape: 'trap',
    relPath: 'Person of Interest Season 1 x265 [Pahe.in]/Person.of.Interest.E04.720p.BluRay.x265.10Bit-Pahe.in.mkv',
    expected: episode('Person of Interest', 1, 4),
  },
  { shape: 'trap', relPath: `${MOBLAND_DIR}/S01E07.mkv`, expected: episode('Mobland', 1, 7) },
];
```
**Impact:** test data only.

### Step 3: Parser tests
**File:** `tests/unit/movies/parse.test.ts:1` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import { compactTitle, isVideoFile, normalizeTitle, parseVideoPath } from '../../../src/movies/parse.js';
import { FILENAME_CASES } from '../../fixtures/movies/filenames.js';

describe('parseVideoPath on the names found on disk', () => {
  it.each(FILENAME_CASES.map((c) => [c.shape, c.relPath, c] as const))('%s: %s', (_shape, relPath, c) => {
    const { fileName: _fileName, dirName: _dirName, ...parsed } = parseVideoPath(relPath);
    expect(parsed).toEqual(c.expected);
  });

  it('covers all six shapes of the request', () => {
    const shapes = new Set(FILENAME_CASES.map((c) => c.shape));
    for (const shape of ['pahe-dots', 'pahe-underscores', 'year-in-folder', 'season-folder', 'absolute', 'two-films']) {
      expect(shapes.has(shape as never)).toBe(true);
    }
  });

  it('keeps the raw file and folder names for the fallback', () => {
    const p = parseVideoPath('Done/Nezha (2019)/Ne.Zha.2.2025.1080p.WEB-DL.x265.6CH-Pahe.in.mkv');
    expect(p.fileName).toBe('Ne.Zha.2.2025.1080p.WEB-DL.x265.6CH-Pahe.in.mkv');
    expect(p.dirName).toBe('Nezha (2019)');
    expect(parseVideoPath('Oldboy.mkv').dirName).toBeNull();
  });

  it('never takes a done folder or a collection folder into the title', () => {
    expect(parseVideoPath('Done/Your.Eyes.Tell.2020.1080p.mkv').title).toBe('Your Eyes Tell');
    expect(parseVideoPath('Pak Bernard/Oldboy (2003)/Oldboy.mkv').title).toBe('Oldboy');
  });

  it('accepts Windows separators', () => {
    expect(parseVideoPath('Pak Bernard\\Oldboy (2003)\\Oldboy.mkv')).toMatchObject({ title: 'Oldboy', year: 2003 });
  });

  it.each(['', '/', '.mkv', 'a/b/', '[]', '....mkv', '-.mkv', 'S01.mkv', '2019.mkv', '((((('])('never throws on %j', (odd) => {
    expect(() => parseVideoPath(odd)).not.toThrow();
  });
});

describe('isVideoFile', () => {
  it('accepts the five video extensions in any case', () => {
    for (const name of ['a.mkv', 'a.MP4', 'a.avi', 'a.m4v', 'a.webm']) expect(isVideoFile(name)).toBe(true);
  });
  it('rejects everything else', () => {
    for (const name of ['a.srt', 'a.nfo', 'a.jpg', 'mkv', '.mkv', 'a.mkv.part', 'a.']) expect(isVideoFile(name)).toBe(false);
  });
});

describe('normalizeTitle / compactTitle', () => {
  it('folds punctuation, case and accents', () => {
    expect(normalizeTitle('WALL·E')).toBe('wall e');
    expect(normalizeTitle('WALL-E')).toBe('wall e');
    expect(normalizeTitle('Batman: The Killing Joke')).toBe(normalizeTitle('Batman - The Killing Joke'));
    expect(normalizeTitle('Amélie')).toBe('amelie');
    expect(normalizeTitle('Fast & Furious')).toBe('fast and furious');
  });
  it('compactTitle ignores spaces', () => {
    expect(compactTitle('Nezha')).toBe(compactTitle('Ne Zha'));
  });
});
```
**Impact:** `npx vitest run tests/unit/movies/parse.test.ts` passes. This step is a checkpoint: run it before moving on.

### Step 4: TMDB client
**File:** `src/movies/tmdb.ts:1` (new)
**Change:** One `get()` sends the Bearer token, or `api_key` when there is no token. It applies a 15 s timeout and maps every failure to `TmdbError`, never putting the URL in a message because the URL can hold the key. Each response is checked once against a zod schema at this edge, then mapped to `TitleMetadata`, `TmdbSearchHit`, `TmdbPersonHit` or `TmdbPersonCredit`.

Credits are merged per (role, person), so a writer with "Writer" and "Screenplay" credits becomes one row with job `Writer, Screenplay`. They are capped (`MAX_CAST` = 40, `MAX_CREW_PER_ROLE` = 20) and ordered by billing for cast and by episode count for series crew. Roles come from `crewRole`: job `Director` -> director; jobs `Producer` and `Executive Producer` -> producer; the Writing department -> writer, except editor, consultant, researcher and storyboard jobs; `created_by` -> creator.

`tvDetails` fetches each season listed in `seasons[]` in turn, season 0 included. A season that answers 404 counts as empty.
**Code:**
```ts
import { z } from 'zod';

/**
 * TMDB v3 client: search, details with credits, every season's episodes, people. The only module
 * that talks to TMDB. Every response is checked against a schema here, at the edge, and turned
 * into the types below; callers never see TMDB's JSON. Every failure is a TmdbError, which the
 * sync pass treats as "TMDB unreachable, retry next pass".
 *
 * Auth: `Authorization: Bearer <token>` when a read access token is set, else `?api_key=`. Neither
 * ever appears in an error message.
 */

/** Per request. */
export const TMDB_TIMEOUT_MS = 15_000;
/** Cast members kept per title, by billing order. */
export const MAX_CAST = 40;
/** Directors, writers, producers and creators kept per title, each. */
export const MAX_CREW_PER_ROLE = 20;
/** Poster width used when the caller names none (TMDB sizes: w92 w154 w185 w342 w500 w780 original). */
export const DEFAULT_POSTER_SIZE = 'w342';
/** How much of a bad response body an error message carries. */
const SNIPPET_CHARS = 300;

export type TitleKind = 'movie' | 'tv';
export type CreditRole = 'cast' | 'director' | 'writer' | 'producer' | 'creator';

/*
 * TitleMetadata: what a match stores (movie_titles + movie_companies/movie_title_companies +
 * movie_people/movie_credits + movie_episodes). TEMPORARY MIRROR of src/movies/types.ts (phase 1,
 * built in parallel): same names, same fields, field for field. Phase 3 replaces this block with
 * `export type { TitleKind, CreditRole, CompanyMeta, CreditMeta, EpisodeMeta, TitleMetadata } from
 * './types.js';` (reconciled plan set). Order is array order: MoviesRepo.upsertTitle stores each
 * list's index as `ord`, so these types carry no `ord` field.
 */
export interface CompanyMeta {
  /** TMDB company id (movie_companies.id). */
  id: number;
  name: string;
  logoPath: string | null;
  originCountry: string | null;
}

export interface CreditMeta {
  /** TMDB person id (movie_people.id). */
  personId: number;
  name: string;
  profilePath: string | null;
  role: CreditRole;
  /** Cast only: the character(s) played, " / " joined. */
  character: string | null;
  /** Crew only: TMDB job(s), ", " joined ("Writer, Original Concept"). Null for cast and creators. */
  job: string | null;
}

export interface EpisodeMeta {
  season: number;
  episode: number;
  name: string;
  airDate: string | null;
  runtimeMin: number | null;
  overview: string | null;
  stillPath: string | null;
}

export interface TitleMetadata {
  kind: TitleKind;
  tmdbId: number;
  title: string;
  originalTitle: string;
  year: number | null;
  /** YYYY-MM-DD: a film's release date, a series' first air date. */
  releaseDate: string | null;
  overview: string;
  posterPath: string | null;
  backdropPath: string | null;
  runtimeMin: number | null;
  genres: string[];
  seasonCount: number | null;
  episodeCount: number | null;
  /** Billing order (array order). */
  companies: CompanyMeta[];
  /** Ordered by role (cast, director, writer, producer, creator), then billing within the role (array order). */
  credits: CreditMeta[];
  /** Series: every episode of every season TMDB lists, season 0 (specials) included. Films: []. */
  episodes: EpisodeMeta[];
}

/** One search result, film or series. */
export interface TmdbSearchHit {
  kind: TitleKind;
  tmdbId: number;
  title: string;
  originalTitle: string;
  releaseDate: string | null;
  year: number | null;
  overview: string;
  posterPath: string | null;
  popularity: number;
}

export interface TmdbPersonHit {
  personId: number;
  name: string;
  knownFor: string | null;
  profilePath: string | null;
  popularity: number;
}

/** One entry of a person's filmography (movies_person, phase 7). */
export interface TmdbPersonCredit {
  kind: TitleKind;
  tmdbId: number;
  title: string;
  releaseDate: string | null;
  year: number | null;
  posterPath: string | null;
  popularity: number;
  credit: 'cast' | 'crew';
  character: string | null;
  job: string | null;
  department: string | null;
  /** Series: episodes this person is credited on. */
  episodeCount: number | null;
}

export interface TmdbClient {
  /** Films matching `query`; `year` narrows to that release year. '' answers [] without a request. */
  searchMovie(query: string, year?: number | null): Promise<TmdbSearchHit[]>;
  /** Series matching `query`; `year` narrows to that first-air year. '' answers [] without a request. */
  searchTv(query: string, year?: number | null): Promise<TmdbSearchHit[]>;
  movieDetails(id: number): Promise<TitleMetadata>;
  /** One request for the series, then one per season (sequential). */
  tvDetails(id: number): Promise<TitleMetadata>;
  searchPerson(query: string): Promise<TmdbPersonHit[]>;
  /** Films and series, cast then crew, in TMDB's order. */
  personCredits(personId: number): Promise<TmdbPersonCredit[]>;
}

/** The slice of `config.movies.tmdb` the client needs; the whole config object fits. */
export interface TmdbClientConfig {
  token: string | null;
  apiKey: string | null;
  apiBase: string;
}

export interface TmdbClientOptions {
  /** Default TMDB_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * no_credentials: neither token nor key set (no request made). network / timeout: TMDB not reached.
 * http: TMDB answered non-2xx (`status`). bad_response: the body is not JSON or not the expected shape.
 */
export type TmdbErrorCode = 'no_credentials' | 'network' | 'timeout' | 'http' | 'bad_response';

export class TmdbError extends Error {
  override readonly name = 'TmdbError';
  readonly code: TmdbErrorCode;
  /** HTTP status for `http`, else null. */
  readonly status: number | null;

  constructor(code: TmdbErrorCode, message: string, status: number | null = null, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.code = code;
    this.status = status;
  }
}

// ---- response schemas (the boundary) ----

const intId = z.number().int();
const text = z.string().nullish();
const num = z.number().nullish();

const GenreSchema = z.object({ name: z.string() });
const CompanySchema = z.object({ id: intId, name: z.string(), logo_path: text, origin_country: text });
const MovieCastSchema = z.object({ id: intId, name: z.string(), character: text, order: num, profile_path: text });
const MovieCrewSchema = z.object({ id: intId, name: z.string(), job: text, department: text, profile_path: text });

const MovieDetailsSchema = z.object({
  id: intId,
  title: z.string(),
  original_title: text,
  release_date: text,
  overview: text,
  poster_path: text,
  backdrop_path: text,
  runtime: num,
  genres: z.array(GenreSchema).nullish(),
  production_companies: z.array(CompanySchema).nullish(),
  credits: z.object({ cast: z.array(MovieCastSchema).nullish(), crew: z.array(MovieCrewSchema).nullish() }).nullish(),
});

const TvCastSchema = z.object({
  id: intId,
  name: z.string(),
  profile_path: text,
  order: num,
  roles: z.array(z.object({ character: text, episode_count: num })).nullish(),
});
const TvCrewSchema = z.object({
  id: intId,
  name: z.string(),
  profile_path: text,
  department: text,
  total_episode_count: num,
  jobs: z.array(z.object({ job: text, episode_count: num })).nullish(),
});
const PersonRefSchema = z.object({ id: intId, name: z.string(), profile_path: text });

const TvDetailsSchema = z.object({
  id: intId,
  name: z.string(),
  original_name: text,
  first_air_date: text,
  overview: text,
  poster_path: text,
  backdrop_path: text,
  episode_run_time: z.array(z.number()).nullish(),
  genres: z.array(GenreSchema).nullish(),
  number_of_seasons: num,
  number_of_episodes: num,
  created_by: z.array(PersonRefSchema).nullish(),
  production_companies: z.array(CompanySchema).nullish(),
  seasons: z.array(z.object({ season_number: intId })).nullish(),
  aggregate_credits: z.object({ cast: z.array(TvCastSchema).nullish(), crew: z.array(TvCrewSchema).nullish() }).nullish(),
});

const SeasonSchema = z.object({
  episodes: z
    .array(
      z.object({
        episode_number: intId,
        name: text,
        air_date: text,
        runtime: num,
        overview: text,
        still_path: text,
      }),
    )
    .nullish(),
});

const MovieSearchSchema = z.object({
  results: z
    .array(
      z.object({
        id: intId,
        title: z.string(),
        original_title: text,
        release_date: text,
        overview: text,
        poster_path: text,
        popularity: num,
      }),
    )
    .nullish(),
});

const TvSearchSchema = z.object({
  results: z
    .array(
      z.object({
        id: intId,
        name: z.string(),
        original_name: text,
        first_air_date: text,
        overview: text,
        poster_path: text,
        popularity: num,
      }),
    )
    .nullish(),
});

const PersonSearchSchema = z.object({
  results: z
    .array(z.object({ id: intId, name: z.string(), known_for_department: text, profile_path: text, popularity: num }))
    .nullish(),
});

const PersonCreditSchema = z.object({
  id: intId,
  media_type: text,
  title: text,
  name: text,
  release_date: text,
  first_air_date: text,
  character: text,
  job: text,
  department: text,
  poster_path: text,
  popularity: num,
  episode_count: num,
});
const CombinedCreditsSchema = z.object({
  cast: z.array(PersonCreditSchema).nullish(),
  crew: z.array(PersonCreditSchema).nullish(),
});

type PersonCreditJson = z.infer<typeof PersonCreditSchema>;

function decode<T>(schema: z.ZodType<T>, json: unknown, what: string): T {
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined ? '' : ` at ${issue.path.join('.') || '(root)'}: ${issue.message}`;
    throw new TmdbError('bad_response', `TMDB ${what} had an unexpected shape${where}`);
  }
  return parsed.data;
}

// ---- small helpers ----

function orNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value.trim() === '' ? null : value;
}

function positiveOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

/** 2019 from "2019-07-26"; null for null or a malformed date. */
export function yearOf(date: string | null): number | null {
  if (date === null) return null;
  const m = /^(\d{4})-/.exec(date);
  return m === null ? null : Number(m[1]);
}

function errorName(cause: unknown): unknown {
  return typeof cause === 'object' && cause !== null ? (cause as { name?: unknown }).name : undefined;
}

function isTimeout(cause: unknown): boolean {
  const name = errorName(cause);
  return name === 'TimeoutError' || name === 'AbortError';
}

/** Full poster URL, loadable from any machine (posters are hotlinked, never cached on disk). */
export function posterUrl(imageBase: string, path: string | null, size: string = DEFAULT_POSTER_SIZE): string | null {
  if (path === null || path.trim() === '') return null;
  return `${imageBase.replace(/\/+$/, '')}/${size}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Season and episode of the n-th episode (1-based) of a series counted over seasons >= 1 in order:
 * "One Piece - 405" -> the 405th listed episode. Returns that episode's own TMDB numbers, which
 * for some anime run on across seasons (One Piece season 2 starts at episode 62). Null when n is
 * out of range. `episodes` is TitleMetadata.episodes (any order).
 */
export function absoluteToSeasonEpisode(
  episodes: ReadonlyArray<{ season: number; episode: number }>,
  n: number,
): { season: number; episode: number } | null {
  if (!Number.isInteger(n) || n < 1) return null;
  const ordered = episodes
    .filter((e) => e.season >= 1)
    .slice()
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
  const hit = ordered[n - 1];
  return hit === undefined ? null : { season: hit.season, episode: hit.episode };
}

// ---- credits ----

const ROLE_ORDER: readonly CreditRole[] = ['cast', 'director', 'writer', 'producer', 'creator'];
const PRODUCER_JOBS: ReadonlySet<string> = new Set(['Producer', 'Executive Producer']);
/** Writing-department jobs that are not authorship. */
const NON_WRITER_JOBS: ReadonlySet<string> = new Set([
  'Script Editor',
  'Script Consultant',
  'Script Coordinator',
  'Story Editor',
  'Executive Story Editor',
  'Researcher',
  'Storyboard',
  'Storyboard Artist',
]);

/** The role a crew job is stored under, or null for jobs the library does not keep (grips, editors, ...). */
export function crewRole(job: string | null, department: string | null): CreditRole | null {
  if (job === 'Director') return 'director';
  if (job !== null && PRODUCER_JOBS.has(job)) return 'producer';
  if (department === 'Writing' && (job === null || !NON_WRITER_JOBS.has(job))) return 'writer';
  return null;
}

interface PersonRef {
  id: number;
  name: string;
  profilePath: string | null;
}

interface PendingCredit {
  person: PersonRef;
  role: CreditRole;
  jobs: string[];
  characters: string[];
  /** Higher first: -billing order for cast, episode count for series crew. */
  weight: number;
  seq: number;
}

/** One credit per (role, person): a writer credited for "Screenplay" and "Story" is one row. */
class CreditCollector {
  private readonly entries = new Map<string, PendingCredit>();

  add(role: CreditRole, person: PersonRef, detail: { job?: string | null; character?: string | null; weight: number }): void {
    const key = `${role}:${person.id}`;
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = { person, role, jobs: [], characters: [], weight: detail.weight, seq: this.entries.size };
      this.entries.set(key, entry);
    } else {
      entry.weight = Math.max(entry.weight, detail.weight);
    }
    const job = orNull(detail.job);
    if (job !== null && !entry.jobs.includes(job)) entry.jobs.push(job);
    const character = orNull(detail.character);
    if (character !== null && !entry.characters.includes(character)) entry.characters.push(character);
  }

  build(): CreditMeta[] {
    const all = [...this.entries.values()];
    const out: CreditMeta[] = [];
    for (const role of ROLE_ORDER) {
      const cap = role === 'cast' ? MAX_CAST : MAX_CREW_PER_ROLE;
      const items = all
        .filter((e) => e.role === role)
        .sort((a, b) => b.weight - a.weight || a.seq - b.seq)
        .slice(0, cap);
      items.forEach((e) =>
        out.push({
          personId: e.person.id,
          name: e.person.name,
          profilePath: e.person.profilePath,
          role,
          character: e.characters.length > 0 ? e.characters.join(' / ') : null,
          job: e.jobs.length > 0 ? e.jobs.join(', ') : null,
        }),
      );
    }
    return out;
  }
}

function personRef(p: { id: number; name: string; profile_path?: string | null }): PersonRef {
  return { id: p.id, name: p.name, profilePath: orNull(p.profile_path) };
}

function companiesOf(list: ReadonlyArray<z.infer<typeof CompanySchema>> | null | undefined): CompanyMeta[] {
  return (list ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    logoPath: orNull(c.logo_path),
    originCountry: orNull(c.origin_country),
  }));
}

function searchHit(
  kind: TitleKind,
  r: {
    id: number;
    title: string;
    original: string | null | undefined;
    date: string | null | undefined;
    overview: string | null | undefined;
    poster: string | null | undefined;
    popularity: number | null | undefined;
  },
): TmdbSearchHit {
  const releaseDate = orNull(r.date);
  return {
    kind,
    tmdbId: r.id,
    title: r.title,
    originalTitle: orNull(r.original) ?? r.title,
    releaseDate,
    year: yearOf(releaseDate),
    overview: r.overview ?? '',
    posterPath: orNull(r.poster),
    popularity: r.popularity ?? 0,
  };
}

function personCredit(c: PersonCreditJson, credit: 'cast' | 'crew'): TmdbPersonCredit | null {
  const kind: TitleKind | null = c.media_type === 'movie' ? 'movie' : c.media_type === 'tv' ? 'tv' : null;
  if (kind === null) return null;
  const title = orNull(kind === 'movie' ? c.title : c.name) ?? orNull(c.title) ?? orNull(c.name);
  if (title === null) return null;
  const releaseDate = orNull(kind === 'movie' ? c.release_date : c.first_air_date);
  return {
    kind,
    tmdbId: c.id,
    title,
    releaseDate,
    year: yearOf(releaseDate),
    posterPath: orNull(c.poster_path),
    popularity: c.popularity ?? 0,
    credit,
    character: credit === 'cast' ? orNull(c.character) : null,
    job: credit === 'crew' ? orNull(c.job) : null,
    department: credit === 'crew' ? orNull(c.department) : null,
    episodeCount: positiveOrNull(c.episode_count),
  };
}

type QueryParams = Record<string, string | number | boolean | null | undefined>;

export function createTmdbClient(
  config: TmdbClientConfig,
  fetchImpl: typeof fetch = fetch,
  options: TmdbClientOptions = {},
): TmdbClient {
  const base = config.apiBase.replace(/\/+$/, '');
  const token = orNull(config.token);
  const apiKey = orNull(config.apiKey);
  const timeoutMs = options.timeoutMs ?? TMDB_TIMEOUT_MS;

  /** GET `path` (no query string in it) and parse JSON. Errors name the path, never the URL (it may hold the key). */
  async function get(path: string, params: QueryParams): Promise<unknown> {
    if (token === null && apiKey === null) {
      throw new TmdbError('no_credentials', 'TMDB is not configured: set TMDB_API_READ_ACCESS_TOKEN or TMDB_API_KEY');
    }
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token !== null) headers.authorization = `Bearer ${token}`;
    else if (apiKey !== null) url.searchParams.set('api_key', apiKey);

    let res: Response;
    try {
      res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (cause) {
      if (isTimeout(cause)) throw new TmdbError('timeout', `TMDB ${path} timed out after ${timeoutMs} ms`, null, cause);
      throw new TmdbError('network', `TMDB ${path} could not be reached`, null, cause);
    }
    let raw: string;
    try {
      raw = await res.text();
    } catch (cause) {
      if (isTimeout(cause)) throw new TmdbError('timeout', `TMDB ${path} timed out after ${timeoutMs} ms`, null, cause);
      throw new TmdbError('network', `TMDB ${path} response could not be read`, null, cause);
    }
    if (!res.ok) {
      throw new TmdbError('http', `TMDB ${path} returned ${res.status}: ${raw.slice(0, SNIPPET_CHARS)}`, res.status);
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch (cause) {
      throw new TmdbError('bad_response', `TMDB ${path} did not return JSON: ${raw.slice(0, SNIPPET_CHARS)}`, null, cause);
    }
  }

  async function seasonEpisodes(tvId: number, season: number): Promise<EpisodeMeta[]> {
    let json: unknown;
    try {
      json = await get(`/tv/${tvId}/season/${season}`, {});
    } catch (err) {
      // TMDB sometimes lists a season it has no page for: no episodes, not a failed sync.
      if (err instanceof TmdbError && err.status === 404) return [];
      throw err;
    }
    const raw = decode(SeasonSchema, json, `tv ${tvId} season ${season}`);
    return (raw.episodes ?? []).map((e) => ({
      season,
      episode: e.episode_number,
      name: orNull(e.name) ?? `Episode ${e.episode_number}`,
      airDate: orNull(e.air_date),
      runtimeMin: positiveOrNull(e.runtime),
      overview: orNull(e.overview),
      stillPath: orNull(e.still_path),
    }));
  }

  return {
    async searchMovie(query, year = null) {
      const q = query.trim();
      if (q === '') return [];
      const raw = decode(
        MovieSearchSchema,
        await get('/search/movie', { query: q, year: year ?? undefined, include_adult: false }),
        'movie search',
      );
      return (raw.results ?? []).map((r) =>
        searchHit('movie', {
          id: r.id,
          title: r.title,
          original: r.original_title,
          date: r.release_date,
          overview: r.overview,
          poster: r.poster_path,
          popularity: r.popularity,
        }),
      );
    },

    async searchTv(query, year = null) {
      const q = query.trim();
      if (q === '') return [];
      const raw = decode(
        TvSearchSchema,
        await get('/search/tv', { query: q, first_air_date_year: year ?? undefined, include_adult: false }),
        'tv search',
      );
      return (raw.results ?? []).map((r) =>
        searchHit('tv', {
          id: r.id,
          title: r.name,
          original: r.original_name,
          date: r.first_air_date,
          overview: r.overview,
          poster: r.poster_path,
          popularity: r.popularity,
        }),
      );
    },

    async movieDetails(id) {
      const raw = decode(MovieDetailsSchema, await get(`/movie/${id}`, { append_to_response: 'credits' }), `movie ${id}`);
      const credits = new CreditCollector();
      (raw.credits?.cast ?? []).forEach((c, i) =>
        credits.add('cast', personRef(c), { character: c.character, weight: -(c.order ?? i) }),
      );
      for (const c of raw.credits?.crew ?? []) {
        const role = crewRole(orNull(c.job), orNull(c.department));
        if (role !== null) credits.add(role, personRef(c), { job: c.job, weight: 0 });
      }
      const releaseDate = orNull(raw.release_date);
      return {
        kind: 'movie',
        tmdbId: raw.id,
        title: raw.title,
        originalTitle: orNull(raw.original_title) ?? raw.title,
        year: yearOf(releaseDate),
        releaseDate,
        overview: raw.overview ?? '',
        posterPath: orNull(raw.poster_path),
        backdropPath: orNull(raw.backdrop_path),
        runtimeMin: positiveOrNull(raw.runtime),
        genres: (raw.genres ?? []).map((g) => g.name),
        seasonCount: null,
        episodeCount: null,
        companies: companiesOf(raw.production_companies),
        credits: credits.build(),
        episodes: [],
      };
    },

    async tvDetails(id) {
      const raw = decode(TvDetailsSchema, await get(`/tv/${id}`, { append_to_response: 'aggregate_credits' }), `tv ${id}`);
      const credits = new CreditCollector();
      (raw.aggregate_credits?.cast ?? []).forEach((c, i) => {
        const weight = -(c.order ?? i);
        const roles = [...(c.roles ?? [])].sort((a, b) => (b.episode_count ?? 0) - (a.episode_count ?? 0)).slice(0, 2);
        if (roles.length === 0) credits.add('cast', personRef(c), { weight });
        for (const r of roles) credits.add('cast', personRef(c), { character: r.character, weight });
      });
      for (const c of raw.aggregate_credits?.crew ?? []) {
        for (const j of c.jobs ?? []) {
          const role = crewRole(orNull(j.job), orNull(c.department));
          if (role !== null) credits.add(role, personRef(c), { job: j.job, weight: c.total_episode_count ?? 0 });
        }
      }
      for (const c of raw.created_by ?? []) credits.add('creator', personRef(c), { weight: 0 });

      const seasonNumbers = [...new Set((raw.seasons ?? []).map((s) => s.season_number))].sort((a, b) => a - b);
      const episodes: EpisodeMeta[] = [];
      for (const n of seasonNumbers) episodes.push(...(await seasonEpisodes(raw.id, n)));

      const releaseDate = orNull(raw.first_air_date);
      return {
        kind: 'tv',
        tmdbId: raw.id,
        title: raw.name,
        originalTitle: orNull(raw.original_name) ?? raw.name,
        year: yearOf(releaseDate),
        releaseDate,
        overview: raw.overview ?? '',
        posterPath: orNull(raw.poster_path),
        backdropPath: orNull(raw.backdrop_path),
        runtimeMin: positiveOrNull(raw.episode_run_time?.[0]),
        genres: (raw.genres ?? []).map((g) => g.name),
        seasonCount: raw.number_of_seasons ?? null,
        episodeCount: raw.number_of_episodes ?? null,
        companies: companiesOf(raw.production_companies),
        credits: credits.build(),
        episodes,
      };
    },

    async searchPerson(query) {
      const q = query.trim();
      if (q === '') return [];
      const raw = decode(PersonSearchSchema, await get('/search/person', { query: q, include_adult: false }), 'person search');
      return (raw.results ?? []).map((r) => ({
        personId: r.id,
        name: r.name,
        knownFor: orNull(r.known_for_department),
        profilePath: orNull(r.profile_path),
        popularity: r.popularity ?? 0,
      }));
    },

    async personCredits(personId) {
      const raw = decode(
        CombinedCreditsSchema,
        await get(`/person/${personId}/combined_credits`, {}),
        `person ${personId} credits`,
      );
      const out: TmdbPersonCredit[] = [];
      for (const c of raw.cast ?? []) {
        const entry = personCredit(c, 'cast');
        if (entry !== null) out.push(entry);
      }
      for (const c of raw.crew ?? []) {
        const entry = personCredit(c, 'crew');
        if (entry !== null) out.push(entry);
      }
      return out;
    },
  };
}
```
**Impact:** new module, no callers yet.

### Step 5: TMDB fixtures
**Files:** `tests/fixtures/movies/*.json` (new, 8 files). These are trimmed copies of real TMDB answers fetched on 2026-11-14. The movie fixture adds two rows: a "Key Grip" credit, which must be dropped, and a duplicate "Screenplay" credit, which must be merged. The series is trimmed to 3 + 2 episodes.

`tests/fixtures/movies/movie-467905.json`
```json
{
  "id": 467905,
  "title": "How to Make a Killing",
  "original_title": "How to Make a Killing",
  "release_date": "2026-02-16",
  "overview": "Disowned at birth by his obscenely wealthy family, blue-collar Becket Redfellow will stop at nothing to reclaim his inheritance, no matter how many relatives stand in his way.",
  "poster_path": "/vxMeKC7o5Gi8IHMi6lUgsdprTqv.jpg",
  "backdrop_path": "/bkUa5ZDqjQPx6rkxs0hM87vaWVa.jpg",
  "runtime": 105,
  "genres": [
    { "id": 35, "name": "Comedy" },
    { "id": 53, "name": "Thriller" },
    { "id": 80, "name": "Crime" }
  ],
  "production_companies": [
    { "id": 694, "logo_path": "/5LEHONGkZBIoWvp1ygHOF8iyi1M.png", "name": "StudioCanal", "origin_country": "FR" },
    { "id": 2376, "logo_path": "/yeNoWmSHZfvKsBYuL8uTRE4LPdQ.png", "name": "Blueprint Pictures", "origin_country": "GB" }
  ],
  "credits": {
    "cast": [
      { "id": 83271, "name": "Glen Powell", "character": "Becket Redfellow", "order": 0, "profile_path": "/7eG0GB1GY3RXI7Tg3GoKrLO9mPW.jpg" },
      { "id": 1392137, "name": "Margaret Qualley", "character": "Julia", "order": 1, "profile_path": "/r5WeMrU4YLJqRRE3joeOrBVicAH.jpg" },
      { "id": 1202689, "name": "Jessica Henwick", "character": "Ruth", "order": 2, "profile_path": "/ayMJbMeg68uJyirPKmcAtHYML8r.jpg" }
    ],
    "crew": [
      { "id": 1099792, "name": "John Patton Ford", "job": "Director", "department": "Directing", "profile_path": "/9JuEmMR8xNWZ1vBesh6YC4WhTe7.jpg" },
      { "id": 29227, "name": "Graham Broadbent", "job": "Producer", "department": "Production", "profile_path": "/ySorycswjsueC1hdmybKzeRGm6M.jpg" },
      { "id": 54474, "name": "Peter Czernin", "job": "Producer", "department": "Production", "profile_path": "/mgsZQ959ro3lB2iJUcFkvLxojH3.jpg" },
      { "id": 70864, "name": "Robert Hamer", "job": "Original Film Writer", "department": "Writing", "profile_path": "/uyfGB5eUmDMXvRZJkQwqqModX3D.jpg" },
      { "id": 83271, "name": "Glen Powell", "job": "Executive Producer", "department": "Production", "profile_path": "/7eG0GB1GY3RXI7Tg3GoKrLO9mPW.jpg" },
      { "id": 1099792, "name": "John Patton Ford", "job": "Writer", "department": "Writing", "profile_path": "/9JuEmMR8xNWZ1vBesh6YC4WhTe7.jpg" },
      { "id": 1099792, "name": "John Patton Ford", "job": "Screenplay", "department": "Writing", "profile_path": "/9JuEmMR8xNWZ1vBesh6YC4WhTe7.jpg" },
      { "id": 4000001, "name": "Sam Grip", "job": "Key Grip", "department": "Crew", "profile_path": null }
    ]
  }
}
```

`tests/fixtures/movies/tv-247718.json`
```json
{
  "id": 247718,
  "name": "MobLand",
  "original_name": "MobLand",
  "first_air_date": "2025-03-30",
  "overview": "Two mob families clash in a war that threatens to topple empires and lives.",
  "poster_path": "/5Xc7WpWsgflfgEMoBlf9TmWhfbH.jpg",
  "backdrop_path": "/h0OC7ouop8YLwbAVfS3UUE2Lw4T.jpg",
  "episode_run_time": [],
  "genres": [
    { "id": 80, "name": "Crime" },
    { "id": 18, "name": "Drama" }
  ],
  "number_of_seasons": 2,
  "number_of_episodes": 5,
  "created_by": [
    { "id": 84665, "credit_id": "67c7365126b4e196b1f06589", "name": "Ronan Bennett", "original_name": "Ronan Bennett", "gender": 2, "profile_path": null }
  ],
  "production_companies": [
    { "id": 6329, "logo_path": "/4lZJiVHPClma8YB9hXodraFXSwi.png", "name": "MTV Entertainment Studios", "origin_country": "US" },
    { "id": 270146, "logo_path": "/4r6rIxegOrrVeJwqRxpzNrCRQMD.png", "name": "Paramount Television Studios", "origin_country": "US" }
  ],
  "seasons": [
    { "season_number": 1, "episode_count": 3, "name": "Season 1" },
    { "season_number": 2, "episode_count": 2, "name": "Season 2" }
  ],
  "aggregate_credits": {
    "cast": [
      { "id": 2524, "name": "Tom Hardy", "profile_path": "/d81K0RH8UX7tZj49tZaQhZ9ewH.jpg", "total_episode_count": 20, "order": 0,
        "roles": [{ "credit_id": "674757fc95c55a202717aeb1", "character": "Harry Da Souza", "episode_count": 20 }] },
      { "id": 517, "name": "Pierce Brosnan", "profile_path": "/dzXVwwJLPwiZeXOnf7YxorqVEEM.jpg", "total_episode_count": 20, "order": 1,
        "roles": [{ "credit_id": "6747580495c55a202717aeb9", "character": "Conrad Harrigan", "episode_count": 20 }] }
    ],
    "crew": [
      { "id": 131844, "name": "Lawrence Gough", "profile_path": null, "department": "Directing", "total_episode_count": 4,
        "jobs": [{ "credit_id": "6821464efc29087c4ea16146", "job": "Director", "episode_count": 4 }] },
      { "id": 956, "name": "Guy Ritchie", "profile_path": "/9pLUnjMgIEWXi0mlHYzie9cKUTD.jpg", "department": "Directing", "total_episode_count": 4,
        "jobs": [{ "credit_id": "67e907e8700a6a94c6e546d5", "job": "Director", "episode_count": 4 }] },
      { "id": 21339, "name": "Jez Butterworth", "profile_path": "/fCdknBtQMVoIEW0VfKiL2yMZqgW.jpg", "department": "Writing", "total_episode_count": 20,
        "jobs": [{ "credit_id": "67e907e02cca6fc8fbc6a9c4", "job": "Writer", "episode_count": 20 }] },
      { "id": 5337321, "name": "Sebastian Magiera", "profile_path": null, "department": "Writing", "total_episode_count": 20,
        "jobs": [{ "credit_id": "67e90f0e7a75294b76c69b87", "job": "Script Editor", "episode_count": 20 }] },
      { "id": 956, "name": "Guy Ritchie", "profile_path": "/9pLUnjMgIEWXi0mlHYzie9cKUTD.jpg", "department": "Production", "total_episode_count": 20,
        "jobs": [{ "credit_id": "65df68c998f1f1017d9a0875", "job": "Executive Producer", "episode_count": 20 }] },
      { "id": 228247, "name": "Ron Burkle", "profile_path": "/hf69HPpxXieEPqSblJGqX5Hq31V.jpg", "department": "Production", "total_episode_count": 20,
        "jobs": [{ "credit_id": "65df6900b39e35018630c819", "job": "Executive Producer", "episode_count": 20 }] }
    ]
  }
}
```

`tests/fixtures/movies/tv-247718-season-1.json`
```json
{
  "id": 381456,
  "season_number": 1,
  "name": "Season 1",
  "episodes": [
    { "episode_number": 1, "season_number": 1, "name": "Stick or Twist", "air_date": "2025-03-30", "runtime": 60, "overview": "Harry Da Souza is called upon to make a problem disappear.", "still_path": "/5IBWjTRedZgLgUEx5MYAq76FBZf.jpg" },
    { "episode_number": 2, "season_number": 1, "name": "Jigsaw Puzzle", "air_date": "2025-04-06", "runtime": 52, "overview": "Harry must deal with the aftermath.", "still_path": "/22kcWCxB4bf4ZlKx1UiE1zArFr2.jpg" },
    { "episode_number": 3, "season_number": 1, "name": "Plan B", "air_date": "2025-04-13", "runtime": 48, "overview": "", "still_path": "/jKXqCG2lyCgWHSRyukpriRzoI14.jpg" }
  ]
}
```

`tests/fixtures/movies/tv-247718-season-2.json`
```json
{
  "id": 381457,
  "season_number": 2,
  "name": "Season 2",
  "episodes": [
    { "episode_number": 1, "season_number": 2, "name": "I Wanna Be Your Dog", "air_date": "2026-09-18", "runtime": 50, "overview": null, "still_path": "/uTSdfO5dND5QLYkVSguosJTDs5S.jpg" },
    { "episode_number": 2, "season_number": 2, "name": "Song 2", "air_date": "2026-09-25", "runtime": 45, "overview": null, "still_path": "/gtu6NmcqFw6kILEcWicAUCmJBVd.jpg" }
  ]
}
```

`tests/fixtures/movies/search-movie-how-to-make-a-killing.json`
```json
{
  "page": 1,
  "total_pages": 1,
  "total_results": 2,
  "results": [
    { "adult": false, "id": 467905, "title": "How to Make a Killing", "original_title": "How to Make a Killing", "original_language": "en", "release_date": "2026-02-16", "overview": "Disowned at birth by his obscenely wealthy family, blue-collar Becket Redfellow will stop at nothing to reclaim his inheritance.", "poster_path": "/vxMeKC7o5Gi8IHMi6lUgsdprTqv.jpg", "popularity": 9.9714, "vote_count": 864 },
    { "adult": false, "id": 1210732, "title": "How to Make a Killing", "original_title": "Un ours dans le Jura", "original_language": "fr", "release_date": "2025-01-01", "overview": "Michel and Cathy lead a quiet but monotonous life in the mountains.", "poster_path": "/oovadj4TsgCuAGfd5LhDP19ZCYD.jpg", "popularity": 2.6182, "vote_count": 428 }
  ]
}
```

`tests/fixtures/movies/search-tv-mobland.json`
```json
{
  "page": 1,
  "total_pages": 1,
  "total_results": 1,
  "results": [
    { "adult": false, "id": 247718, "name": "MobLand", "original_name": "MobLand", "original_language": "en", "first_air_date": "2025-03-30", "overview": "Two mob families clash in a war that threatens to topple empires and lives.", "poster_path": "/5Xc7WpWsgflfgEMoBlf9TmWhfbH.jpg", "popularity": 434.5809 }
  ]
}
```

`tests/fixtures/movies/search-person-margaret-qualley.json`
```json
{
  "page": 1,
  "total_pages": 1,
  "total_results": 1,
  "results": [
    { "adult": false, "id": 1392137, "name": "Margaret Qualley", "known_for_department": "Acting", "profile_path": "/r5WeMrU4YLJqRRE3joeOrBVicAH.jpg", "popularity": 6.0101, "known_for": [] }
  ]
}
```

`tests/fixtures/movies/person-1392137-combined-credits.json`
```json
{
  "id": 1392137,
  "cast": [
    { "id": 933260, "media_type": "movie", "title": "The Substance", "original_title": "The Substance", "release_date": "2024-09-18", "character": "Sue", "poster_path": "/lqoMzCcZYEFK729d6qzt349fB4o.jpg", "popularity": 20.7861 },
    { "id": 467905, "media_type": "movie", "title": "How to Make a Killing", "original_title": "How to Make a Killing", "release_date": "2026-02-16", "character": "Julia", "poster_path": "/vxMeKC7o5Gi8IHMi6lUgsdprTqv.jpg", "popularity": 9.9714 },
    { "id": 59941, "media_type": "tv", "name": "The Tonight Show Starring Jimmy Fallon", "original_name": "The Tonight Show Starring Jimmy Fallon", "first_air_date": "2014-02-17", "character": "Self - Guest", "poster_path": "/1N4o5PmmqhlVDrcdJ2RlCFWbLGX.jpg", "popularity": 350.2771, "episode_count": 4 }
  ],
  "crew": [
    { "id": 870518, "media_type": "movie", "title": "Sanctuary", "original_title": "Sanctuary", "release_date": "2023-03-02", "department": "Production", "job": "Executive Producer", "poster_path": "/yGQAZupyZgT2ESbBSMZ9R0OBToo.jpg", "popularity": 2.3203 }
  ]
}
```
**Impact:** test data only.

### Step 6: Fake TMDB helper
**File:** `tests/helpers/tmdbFixtures.ts:1` (new)
**Change:** The fixtures as an injected `fetch` for unit tests and as a real HTTP server on 127.0.0.1 for the Proof scripts. Phase 3's integration test and Phase 8's `verify.sh` fixtures can point `TMDB_API_BASE` at the same server.
**Code:**
```ts
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
```
**Impact:** test helper only.

### Step 7: Client tests
**File:** `tests/unit/movies/tmdb.test.ts:1` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import {
  TmdbError,
  absoluteToSeasonEpisode,
  createTmdbClient,
  crewRole,
  posterUrl,
  type CreditMeta,
  type TmdbClientConfig,
} from '../../../src/movies/tmdb.js';
import { FIXTURE_API_BASE, fixtureFetch } from '../../helpers/tmdbFixtures.js';

const TOKEN_CONFIG: TmdbClientConfig = { token: 'test-token', apiKey: null, apiBase: FIXTURE_API_BASE };

function names(credits: CreditMeta[], role: CreditMeta['role']): string[] {
  return credits.filter((c) => c.role === role).map((c) => c.name);
}

function failingFetch(make: () => Promise<Response>): typeof fetch {
  return (() => make()) as typeof fetch;
}

describe('createTmdbClient: auth and search', () => {
  it('sends the read access token as a Bearer header and the year as a filter', async () => {
    const f = fixtureFetch();
    const hits = await createTmdbClient(TOKEN_CONFIG, f.fetch).searchMovie('How to Make a Killing', 2026);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.pathname).toBe('/search/movie');
    expect(f.calls[0]?.authorization).toBe('Bearer test-token');
    expect(f.calls[0]?.params.get('query')).toBe('How to Make a Killing');
    expect(f.calls[0]?.params.get('year')).toBe('2026');
    expect(f.calls[0]?.params.has('api_key')).toBe(false);
    expect(hits.map((h) => [h.kind, h.tmdbId, h.year, h.originalTitle])).toEqual([
      ['movie', 467905, 2026, 'How to Make a Killing'],
      ['movie', 1210732, 2025, 'Un ours dans le Jura'],
    ]);
    expect(hits[0]?.posterPath).toBe('/vxMeKC7o5Gi8IHMi6lUgsdprTqv.jpg');
  });

  it('falls back to the v3 api_key query parameter without a token', async () => {
    const f = fixtureFetch();
    await createTmdbClient({ token: null, apiKey: 'k3', apiBase: FIXTURE_API_BASE }, f.fetch).searchTv('MobLand');
    expect(f.calls[0]?.authorization).toBeNull();
    expect(f.calls[0]?.params.get('api_key')).toBe('k3');
    expect(f.calls[0]?.params.has('first_air_date_year')).toBe(false);
  });

  it('maps a series hit and answers [] for an unknown or empty query', async () => {
    const f = fixtureFetch();
    const client = createTmdbClient(TOKEN_CONFIG, f.fetch);
    const hits = await client.searchTv('MobLand', 2025);
    expect(hits).toEqual([
      expect.objectContaining({ kind: 'tv', tmdbId: 247718, title: 'MobLand', releaseDate: '2025-03-30', year: 2025 }),
    ]);
    expect(f.calls[0]?.params.get('first_air_date_year')).toBe('2025');
    expect(await client.searchMovie('No Such Film Anywhere')).toEqual([]);
    const before = f.calls.length;
    expect(await client.searchMovie('   ')).toEqual([]);
    expect(f.calls.length).toBe(before);
  });
});

describe('movieDetails', () => {
  it('returns poster, release date, synopsis, companies and every credit role', async () => {
    const meta = await createTmdbClient(TOKEN_CONFIG, fixtureFetch().fetch).movieDetails(467905);
    expect(meta).toMatchObject({
      kind: 'movie',
      tmdbId: 467905,
      title: 'How to Make a Killing',
      year: 2026,
      releaseDate: '2026-02-16',
      posterPath: '/vxMeKC7o5Gi8IHMi6lUgsdprTqv.jpg',
      runtimeMin: 105,
      genres: ['Comedy', 'Thriller', 'Crime'],
      seasonCount: null,
      episodes: [],
    });
    expect(meta.overview).toMatch(/^Disowned at birth/);
    expect(meta.companies.map((c, i) => [c.name, c.originCountry, i])).toEqual([
      ['StudioCanal', 'FR', 0],
      ['Blueprint Pictures', 'GB', 1],
    ]);
    expect(meta.credits.filter((c) => c.role === 'cast').map((c, i) => [c.name, c.character, i])).toEqual([
      ['Glen Powell', 'Becket Redfellow', 0],
      ['Margaret Qualley', 'Julia', 1],
      ['Jessica Henwick', 'Ruth', 2],
    ]);
    expect(names(meta.credits, 'director')).toEqual(['John Patton Ford']);
    expect(meta.credits.filter((c) => c.role === 'writer').map((c) => [c.name, c.job])).toEqual([
      ['Robert Hamer', 'Original Film Writer'],
      ['John Patton Ford', 'Writer, Screenplay'],
    ]);
    expect(meta.credits.filter((c) => c.role === 'producer').map((c) => [c.name, c.job])).toEqual([
      ['Graham Broadbent', 'Producer'],
      ['Peter Czernin', 'Producer'],
      ['Glen Powell', 'Executive Producer'],
    ]);
    expect(meta.credits.some((c) => c.name === 'Sam Grip')).toBe(false);
  });
});

describe('tvDetails', () => {
  it('returns creators, cast with characters, crew and the episodes of every season', async () => {
    const f = fixtureFetch();
    const meta = await createTmdbClient(TOKEN_CONFIG, f.fetch).tvDetails(247718);
    expect(meta).toMatchObject({
      kind: 'tv',
      tmdbId: 247718,
      title: 'MobLand',
      year: 2025,
      releaseDate: '2025-03-30',
      runtimeMin: null,
      seasonCount: 2,
      episodeCount: 5,
    });
    expect(meta.companies.map((c) => c.name)).toEqual(['MTV Entertainment Studios', 'Paramount Television Studios']);
    expect(meta.credits.filter((c) => c.role === 'cast').map((c) => [c.name, c.character])).toEqual([
      ['Tom Hardy', 'Harry Da Souza'],
      ['Pierce Brosnan', 'Conrad Harrigan'],
    ]);
    expect(names(meta.credits, 'creator')).toEqual(['Ronan Bennett']);
    expect(names(meta.credits, 'director')).toEqual(['Lawrence Gough', 'Guy Ritchie']);
    expect(names(meta.credits, 'writer')).toEqual(['Jez Butterworth']);
    expect(names(meta.credits, 'producer')).toEqual(['Guy Ritchie', 'Ron Burkle']);
    expect(meta.episodes.map((e) => [e.season, e.episode, e.name])).toEqual([
      [1, 1, 'Stick or Twist'],
      [1, 2, 'Jigsaw Puzzle'],
      [1, 3, 'Plan B'],
      [2, 1, 'I Wanna Be Your Dog'],
      [2, 2, 'Song 2'],
    ]);
    expect(meta.episodes[0]).toMatchObject({ airDate: '2025-03-30', runtimeMin: 60, stillPath: '/5IBWjTRedZgLgUEx5MYAq76FBZf.jpg' });
    expect(meta.episodes[2]?.overview).toBeNull();
    expect(f.calls.map((c) => c.pathname)).toEqual(['/tv/247718', '/tv/247718/season/1', '/tv/247718/season/2']);
    expect(f.calls[0]?.params.get('append_to_response')).toBe('aggregate_credits');
  });

  it('treats a listed season with no page (404) as empty', async () => {
    const base = fixtureFetch();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/tv/247718') {
        const res = await base.fetch(input, init);
        const json = (await res.json()) as { seasons: unknown[] };
        json.seasons.push({ season_number: 3, episode_count: 0 });
        return new Response(JSON.stringify(json), { status: 200 });
      }
      return base.fetch(input, init);
    }) as typeof fetch;
    const meta = await createTmdbClient(TOKEN_CONFIG, fetchImpl).tvDetails(247718);
    expect(meta.episodes).toHaveLength(5);
  });
});

describe('people', () => {
  it('searches a person and returns their films and series, cast and crew', async () => {
    const client = createTmdbClient(TOKEN_CONFIG, fixtureFetch().fetch);
    expect(await client.searchPerson('Margaret Qualley')).toEqual([
      { personId: 1392137, name: 'Margaret Qualley', knownFor: 'Acting', profilePath: '/r5WeMrU4YLJqRRE3joeOrBVicAH.jpg', popularity: 6.0101 },
    ]);
    const credits = await client.personCredits(1392137);
    expect(credits.map((c) => [c.kind, c.tmdbId, c.title, c.year, c.credit, c.character, c.job])).toEqual([
      ['movie', 933260, 'The Substance', 2024, 'cast', 'Sue', null],
      ['movie', 467905, 'How to Make a Killing', 2026, 'cast', 'Julia', null],
      ['tv', 59941, 'The Tonight Show Starring Jimmy Fallon', 2014, 'cast', 'Self - Guest', null],
      ['movie', 870518, 'Sanctuary', 2023, 'crew', null, 'Executive Producer'],
    ]);
    expect(credits[2]?.episodeCount).toBe(4);
  });
});

describe('errors', () => {
  it('without credentials rejects with no_credentials and makes no request', async () => {
    const f = fixtureFetch();
    const client = createTmdbClient({ token: null, apiKey: '  ', apiBase: FIXTURE_API_BASE }, f.fetch);
    await expect(client.movieDetails(467905)).rejects.toMatchObject({ name: 'TmdbError', code: 'no_credentials' });
    expect(f.calls).toHaveLength(0);
  });

  it('an unreachable TMDB is a network TmdbError', async () => {
    const client = createTmdbClient(TOKEN_CONFIG, failingFetch(() => Promise.reject(new TypeError('fetch failed'))));
    const err = await client.searchMovie('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TmdbError);
    expect(err).toMatchObject({ code: 'network', status: null });
  });

  it('a timeout is a timeout TmdbError', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const client = createTmdbClient(TOKEN_CONFIG, failingFetch(() => Promise.reject(timeout)), { timeoutMs: 5 });
    await expect(client.searchTv('x')).rejects.toMatchObject({ code: 'timeout' });
  });

  it('a non-2xx answer is an http TmdbError with the status, and never carries the key', async () => {
    const client = createTmdbClient(
      { token: null, apiKey: 'secret-key', apiBase: FIXTURE_API_BASE },
      failingFetch(async () => new Response('{"status_code":25}', { status: 429 })),
    );
    const err = (await client.searchMovie('x').catch((e: unknown) => e)) as TmdbError;
    expect(err).toMatchObject({ code: 'http', status: 429 });
    expect(err.message).not.toContain('secret-key');
  });

  it('a 404 for a title is an http TmdbError', async () => {
    await expect(createTmdbClient(TOKEN_CONFIG, fixtureFetch().fetch).movieDetails(999999999)).rejects.toMatchObject({
      code: 'http',
      status: 404,
    });
  });

  it('a body that is not JSON, or not the expected shape, is bad_response', async () => {
    const html = createTmdbClient(TOKEN_CONFIG, failingFetch(async () => new Response('<html>blocked</html>', { status: 200 })));
    await expect(html.searchMovie('x')).rejects.toMatchObject({ code: 'bad_response' });
    const shape = createTmdbClient(TOKEN_CONFIG, failingFetch(async () => new Response('{"id":"nope"}', { status: 200 })));
    await expect(shape.movieDetails(1)).rejects.toMatchObject({ code: 'bad_response' });
  });
});

describe('helpers', () => {
  it('posterUrl joins base, size and path, and is null without a path', () => {
    expect(posterUrl('https://image.tmdb.org/t/p/', '/abc.jpg')).toBe('https://image.tmdb.org/t/p/w342/abc.jpg');
    expect(posterUrl('https://image.tmdb.org/t/p', 'abc.jpg', 'w500')).toBe('https://image.tmdb.org/t/p/w500/abc.jpg');
    expect(posterUrl('https://image.tmdb.org/t/p', null)).toBeNull();
  });

  it('absoluteToSeasonEpisode counts listed episodes over seasons >= 1 and keeps TMDB numbers', () => {
    const episodes = [
      { season: 0, episode: 1 },
      { season: 2, episode: 62 },
      { season: 1, episode: 2 },
      { season: 1, episode: 1 },
      { season: 2, episode: 63 },
    ];
    expect(absoluteToSeasonEpisode(episodes, 1)).toEqual({ season: 1, episode: 1 });
    expect(absoluteToSeasonEpisode(episodes, 3)).toEqual({ season: 2, episode: 62 });
    expect(absoluteToSeasonEpisode(episodes, 4)).toEqual({ season: 2, episode: 63 });
    expect(absoluteToSeasonEpisode(episodes, 5)).toBeNull();
    expect(absoluteToSeasonEpisode(episodes, 0)).toBeNull();
  });

  it('crewRole keeps directors, authors and producers only', () => {
    expect(crewRole('Director', 'Directing')).toBe('director');
    expect(crewRole('Screenplay', 'Writing')).toBe('writer');
    expect(crewRole('Script Editor', 'Writing')).toBeNull();
    expect(crewRole('Executive Producer', 'Production')).toBe('producer');
    expect(crewRole('Casting', 'Production')).toBeNull();
  });
});
```
**Impact:** `npx vitest run tests/unit/movies/tmdb.test.ts` passes (checkpoint).

### Step 8: Haiku fallback
**File:** `src/movies/fallback.ts:1` (new)
**Change:** This uses the same Agent SDK setup as `createAgentSummarizer` in `src/sessions/summarize.ts`, reusing its `findClaudeBin`, plus `claudeEnv` and `QueryFn` from `src/chat/*`: no tools, no MCP, no settings, one turn, `persistSession: false`, and keys stripped from the child env. The model's answer is validated once in `parseFallbackAnswer`. `resolve` never rejects: an error result, a thrown SDK error or the 60 s timeout is logged as one line and answers `null`, which leaves the file unmatched.
**Code:**
```ts
import { mkdir } from 'node:fs/promises';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { QueryFn } from '../chat/agent.js';
import { claudeEnv } from '../chat/env.js';
import { findClaudeBin } from '../sessions/summarize.js';
import type { TitleKind } from './tmdb.js';

/**
 * The Haiku fallback: asked for a title and year only when a file name found no confident TMDB
 * match (match.ts). Same Agent SDK setup as the session summarizer (src/sessions/summarize.ts):
 * the owner's login, no tools, no MCP servers, no settings, one turn, no persisted session.
 */

/** Agent SDK model alias; `config.movies.fallbackModel` (NOTESD_MOVIES_FALLBACK_MODEL) overrides it. */
export const DEFAULT_FALLBACK_MODEL = 'haiku';
/** Wall clock per question. */
export const DEFAULT_FALLBACK_TIMEOUT_MS = 60_000;

export const FALLBACK_SYSTEM_PROMPT = [
  'You identify films and TV series from the names of video files on a home computer.',
  'The user message gives one file name and the folder it sits in.',
  'Release tags such as 1080p, WEB-DL, x265, 6CH, BluRay or Pahe.in are not part of the title.',
  'Answer with one JSON object and nothing else:',
  '{"title": "<the title as TMDB lists it in English>", "year": <four-digit release year, or null>, "kind": "movie" or "tv"}.',
  'For a TV episode give the series title and the year the series first aired.',
  'Answer with the single word null when the file is not a released film or series (a phone clip, a screen recording, a personal video) or when you cannot tell.',
].join(' ');

export interface FallbackAnswer {
  title: string;
  year: number | null;
  kind: TitleKind | null;
}

/** The seam between matching and a model. Production: createHaikuFallback. Tests: a plain object. */
export interface NameFallback {
  /** Model id or alias, for logs. */
  readonly model: string;
  /** A title to search TMDB for, or null when the model has none. Never rejects: a failed call is logged and answers null. */
  resolve(fileName: string, dirName: string | null): Promise<FallbackAnswer | null>;
}

export interface HaikuFallbackOptions {
  /** `config.chat.claudeBin`. */
  claudeBin: string;
  /** `<dataDir>/movies-fallback`; created on first use, nothing is persisted there. */
  cwd: string;
  /** Default DEFAULT_FALLBACK_MODEL. */
  model?: string;
  /** Default: the SDK's query. Tests inject a fake. */
  query?: QueryFn;
  /** Env the child env is derived from (keys and parent-session markers stripped). Default process.env. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Default DEFAULT_FALLBACK_TIMEOUT_MS. */
  timeoutMs?: number;
  /** One line per failed call. Default console.warn. */
  log?: (line: string) => void;
}

const AnswerSchema = z.object({
  title: z.string(),
  year: z.union([z.number(), z.string()]).nullish(),
  kind: z.string().nullish(),
});

const MIN_ANSWER_YEAR = 1870;
const MAX_ANSWER_YEAR = 2100;

function toYear(value: number | string | null | undefined): number | null {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= MIN_ANSWER_YEAR && n <= MAX_ANSWER_YEAR ? n : null;
}

/** The model's user message. */
export function buildFallbackInput(fileName: string, dirName: string | null): string {
  return `File name: ${fileName}\nFolder: ${dirName ?? '(library root)'}`;
}

/**
 * The model's answer as a FallbackAnswer, or null for "null", prose, broken JSON or an empty title.
 * Tolerates a ```json fence, text around the object, and a year given as a string.
 */
export function parseFallbackAnswer(raw: string): FallbackAnswer | null {
  const textOnly = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  if (/^null\.?$/i.test(textOnly)) return null;
  const start = textOnly.indexOf('{');
  const end = textOnly.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let json: unknown;
  try {
    json = JSON.parse(textOnly.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = AnswerSchema.safeParse(json);
  if (!parsed.success) return null;
  const title = parsed.data.title.trim();
  if (title === '') return null;
  const kind = parsed.data.kind === 'movie' || parsed.data.kind === 'tv' ? parsed.data.kind : null;
  return { title, year: toYear(parsed.data.year), kind };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Haiku through the Agent SDK. Null when the claude binary cannot be found: matching then runs without a fallback. */
export function createHaikuFallback(opts: HaikuFallbackOptions): NameFallback | null {
  const baseEnv = opts.baseEnv ?? process.env;
  const claudeBin = findClaudeBin(opts.claudeBin, baseEnv.PATH);
  if (claudeBin === null) return null;
  const query: QueryFn = opts.query ?? sdkQuery;
  const model = opts.model ?? DEFAULT_FALLBACK_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FALLBACK_TIMEOUT_MS;
  const log = opts.log ?? ((line: string) => console.warn(line));

  function optionsFor(abortController: AbortController): Options {
    return {
      abortController,
      cwd: opts.cwd,
      env: claudeEnv(baseEnv),
      model,
      pathToClaudeCodeExecutable: claudeBin as string,
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      tools: [],
      allowedTools: [],
      permissionMode: 'dontAsk',
      maxTurns: 1,
      thinking: { type: 'disabled' },
      systemPrompt: FALLBACK_SYSTEM_PROMPT,
      persistSession: false,
    };
  }

  /** The raw answer; rejects on an error result, a thrown SDK error or the timeout. */
  async function ask(input: string): Promise<string> {
    await mkdir(opts.cwd, { recursive: true });
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort('timeout');
    }, timeoutMs);
    timer.unref();

    let result: string | null = null;
    let failure: string | null = null;
    try {
      for await (const message of query({ prompt: input, options: optionsFor(controller) })) {
        if (message.type !== 'result') continue;
        if (message.subtype === 'success' && !message.is_error) result = message.result;
        else if (message.subtype === 'success') failure = message.result.trim() || 'the fallback failed without saying why';
        else failure = message.errors.join('; ').trim() || `the fallback failed (${message.subtype})`;
      }
    } catch (err) {
      // A CLI that exits non-zero after its result still produced that result: trust it.
      if (result === null && failure === null) failure = errorText(err);
    } finally {
      clearTimeout(timer);
    }
    if (result !== null) return result;
    if (timedOut) throw new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`);
    throw new Error(failure ?? 'ended without a result');
  }

  return {
    model,
    async resolve(fileName, dirName) {
      try {
        return parseFallbackAnswer(await ask(buildFallbackInput(fileName, dirName)));
      } catch (err) {
        log(`movies: name fallback (${model}) failed for ${fileName}: ${errorText(err)}`);
        return null;
      }
    },
  };
}
```
**Impact:** new module, no callers yet. It spawns nothing until Phase 3 calls `resolve`.

### Step 9: Fallback tests
**File:** `tests/unit/movies/fallback.test.ts:1` (new)
**Code:**
```ts
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QueryFn } from '../../../src/chat/agent.js';
import {
  DEFAULT_FALLBACK_MODEL,
  FALLBACK_SYSTEM_PROMPT,
  buildFallbackInput,
  createHaikuFallback,
  parseFallbackAnswer,
} from '../../../src/movies/fallback.js';

function result(text: string, isError = false): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: isError,
    result: text,
    num_turns: 1,
    duration_ms: 1,
    duration_api_ms: 1,
    session_id: 'x',
    uuid: randomUUID(),
  } as unknown as SDKMessage;
}

function answering(text: string, seen: Array<{ prompt: unknown; options: Options }> = []): QueryFn {
  return ({ prompt, options }) => {
    seen.push({ prompt, options });
    return (async function* () {
      yield result(text);
    })();
  };
}

let dir: string;
let bin: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'movies-fallback-'));
  bin = path.join(dir, 'claude');
  await writeFile(bin, '#!/bin/sh\nexit 0\n');
  await chmod(bin, 0o755);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('parseFallbackAnswer', () => {
  it('reads the JSON object, fenced or bare, with a string year', () => {
    expect(parseFallbackAnswer('{"title":"Ne Zha 2","year":2025,"kind":"movie"}')).toEqual({ title: 'Ne Zha 2', year: 2025, kind: 'movie' });
    expect(parseFallbackAnswer('```json\n{"title":"MobLand","year":"2025","kind":"tv"}\n```')).toEqual({
      title: 'MobLand',
      year: 2025,
      kind: 'tv',
    });
    expect(parseFallbackAnswer('Sure: {"title":"Oldboy","year":null,"kind":"film"}')).toEqual({ title: 'Oldboy', year: null, kind: null });
  });

  it('answers null for null, prose, broken JSON and an empty title', () => {
    for (const raw of ['null', 'NULL.', 'I cannot tell.', '{"title":', '{"title":"  ","year":2020}', '{"year":2020}']) {
      expect(parseFallbackAnswer(raw)).toBeNull();
    }
  });

  it('drops an impossible year', () => {
    expect(parseFallbackAnswer('{"title":"X","year":20220222}')).toEqual({ title: 'X', year: null, kind: null });
  });
});

describe('createHaikuFallback', () => {
  it('returns null when the claude binary is missing', () => {
    expect(createHaikuFallback({ claudeBin: path.join(dir, 'nope'), cwd: dir })).toBeNull();
  });

  it('asks haiku with no tools, one turn, no persisted session, and returns the parsed answer', async () => {
    const seen: Array<{ prompt: unknown; options: Options }> = [];
    const cwd = path.join(dir, 'movies-fallback');
    const fb = createHaikuFallback({
      claudeBin: bin,
      cwd,
      query: answering('{"title":"Ne Zha 2","year":2025,"kind":"movie"}', seen),
      baseEnv: { PATH: '', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_SESSION_ID: 'parent' },
    });
    expect(fb).not.toBeNull();
    expect(fb!.model).toBe(DEFAULT_FALLBACK_MODEL);
    expect(await fb!.resolve('Ne.Zha.2.2025.1080p.WEB-DL.x265.6CH-Pahe.in.mkv', 'Nezha (2019)')).toEqual({
      title: 'Ne Zha 2',
      year: 2025,
      kind: 'movie',
    });
    const { prompt, options } = seen[0]!;
    expect(prompt).toBe(buildFallbackInput('Ne.Zha.2.2025.1080p.WEB-DL.x265.6CH-Pahe.in.mkv', 'Nezha (2019)'));
    expect(options.model).toBe('haiku');
    expect(options.systemPrompt).toBe(FALLBACK_SYSTEM_PROMPT);
    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual([]);
    expect(options.mcpServers).toEqual({});
    expect(options.maxTurns).toBe(1);
    expect(options.persistSession).toBe(false);
    expect(options.settingSources).toEqual([]);
    expect(options.pathToClaudeCodeExecutable).toBe(bin);
    expect(options.cwd).toBe(cwd);
    expect(options.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(options.env?.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect((await stat(cwd)).isDirectory()).toBe(true);
  });

  it('uses the configured model', async () => {
    const seen: Array<{ prompt: unknown; options: Options }> = [];
    const fb = createHaikuFallback({ claudeBin: bin, cwd: dir, model: 'sonnet', query: answering('null', seen) });
    expect(await fb!.resolve('a.mkv', null)).toBeNull();
    expect(seen[0]?.options.model).toBe('sonnet');
    expect(seen[0]?.prompt).toBe('File name: a.mkv\nFolder: (library root)');
  });

  it('answers null and logs one line on an error result', async () => {
    const lines: string[] = [];
    const query: QueryFn = () =>
      (async function* () {
        yield result('quota exceeded', true);
      })();
    const fb = createHaikuFallback({ claudeBin: bin, cwd: dir, query, log: (l) => lines.push(l) });
    expect(await fb!.resolve('x.mkv', 'Done')).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('quota exceeded');
    expect(lines[0]).toContain('x.mkv');
  });

  it('answers null and logs when the SDK throws', async () => {
    const lines: string[] = [];
    const query: QueryFn = () =>
      (async function* (): AsyncGenerator<SDKMessage> {
        throw new Error('spawn failed');
      })();
    const fb = createHaikuFallback({ claudeBin: bin, cwd: dir, query, log: (l) => lines.push(l) });
    expect(await fb!.resolve('x.mkv', null)).toBeNull();
    expect(lines[0]).toContain('spawn failed');
  });

  it('answers null after the timeout', async () => {
    const lines: string[] = [];
    const query: QueryFn = ({ options }) =>
      (async function* (): AsyncGenerator<SDKMessage> {
        await new Promise<void>((resolve) => options.abortController?.signal.addEventListener('abort', () => resolve()));
        throw new Error('aborted');
      })();
    const fb = createHaikuFallback({ claudeBin: bin, cwd: dir, query, timeoutMs: 20, log: (l) => lines.push(l) });
    expect(await fb!.resolve('x.mkv', null)).toBeNull();
    expect(lines[0]).toContain('no answer within');
  });
});
```
**Impact:** `npx vitest run tests/unit/movies/fallback.test.ts` passes (checkpoint). No real SDK call is made: `query` is injected.

### Step 10: Matcher and confidence rule
**File:** `src/movies/match.ts:1` (new)
**Change:** The rule is written out in the module's header. In short: `confidence = clamp(titleSimilarity + yearAdjustment, 0, 1)`, and a candidate matches at 0.85 or above.

The search is chosen by the parsed hint: series only for an episode, films only for a film, and films then series when there is no hint. A search with a year that finds nothing is retried without the year. Only when the best candidate is below 0.85 is the fallback asked, and its answer goes through the same search and the same rule.
**Code:**
```ts
import type { NameFallback } from './fallback.js';
import { compactTitle, normalizeTitle, type KindHint, type ParsedName } from './parse.js';
import type { TitleKind, TmdbClient, TmdbSearchHit } from './tmdb.js';

/**
 * Parsed file name -> one TMDB title, or no match with a reason.
 *
 * The confidence rule (one number per candidate, 0..1):
 *   confidence = clamp(titleSimilarity + yearAdjustment, 0, 1)
 * - titleSimilarity, against the candidate's title and original title (the higher counts):
 *   1 when normalizeTitle is equal ("WALL-E" = "WALL·E", "Batman - The Killing Joke" =
 *   "Batman: The Killing Joke"); 0.95 when equal without spaces ("Nezha" = "Ne Zha"); else the
 *   Dice coefficient of the two word sets.
 * - yearAdjustment, when the name has a year: 0 for the same year; -0.1 one year apart or when
 *   the candidate has no date; -0.5 further apart. A series' later season year (name year after
 *   the first air year) costs nothing.
 * A candidate is a match at CONFIDENT_SCORE or above. The best candidate wins; on a tie the
 * earlier one in TMDB's order (which ranks by popularity), movies before series.
 *
 * Search order: an episode ('tv' hint) searches series only, a film ('movie' hint) films only, no
 * hint films then series (series skipped once a film is confident). A search with a year that
 * finds nothing is repeated without it (folder years are sometimes off).
 *
 * Below CONFIDENT_SCORE the Haiku fallback (when given) is asked for a title and year from the raw
 * file and folder names, and its answer goes through the same search and rule. TmdbError is not
 * caught here: the caller (sync) leaves the file pending and retries on its next pass.
 */

export const CONFIDENT_SCORE = 0.85;
/** Search results scored per query. */
export const MAX_CANDIDATES = 10;

export type MatchResult =
  | {
      kind: 'matched';
      tmdbKind: TitleKind;
      tmdbId: number;
      confidence: number;
      /** 'filename': the parsed name matched. 'fallback': Haiku's title matched. */
      source: 'filename' | 'fallback';
      /** TMDB's title of the match, for logs. */
      matchedTitle: string;
    }
  | {
      kind: 'none';
      /** no_match: TMDB returned no candidate. low_confidence: candidates, none confident. */
      reason: 'no_match' | 'low_confidence';
    };

interface Candidate {
  hit: TmdbSearchHit;
  score: number;
}

function words(text: string): Set<string> {
  return new Set(normalizeTitle(text).split(' ').filter((w) => w !== ''));
}

/** 0..1, see the rule above. */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na === '' || nb === '') return 0;
  if (na === nb) return 1;
  if (compactTitle(a) === compactTitle(b)) return 0.95;
  const wa = words(a);
  const wb = words(b);
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return (2 * common) / (wa.size + wb.size);
}

export function yearAdjustment(kind: TitleKind, nameYear: number | null, hitYear: number | null): number {
  if (nameYear === null) return 0;
  if (hitYear === null) return -0.1;
  const diff = nameYear - hitYear;
  if (diff === 0) return 0;
  if (kind === 'tv' && diff > 0) return 0;
  if (Math.abs(diff) === 1) return -0.1;
  return -0.5;
}

/** Confidence of one candidate for a title and year, rounded to 3 decimals. */
export function scoreHit(title: string, year: number | null, hit: TmdbSearchHit): number {
  const similarity = Math.max(titleSimilarity(title, hit.title), titleSimilarity(title, hit.originalTitle));
  const score = Math.min(1, Math.max(0, similarity + yearAdjustment(hit.kind, year, hit.year)));
  return Math.round(score * 1000) / 1000;
}

/** What is sent to TMDB: the title without stand-alone dashes ("Batman - The Killing Joke" -> "Batman The Killing Joke"). */
export function searchQuery(title: string): string {
  return title
    .split(/\s+/)
    .filter((w) => w !== '' && !/^[-–—:]+$/.test(w))
    .join(' ');
}

function kindsFor(hint: KindHint): TitleKind[] {
  if (hint === 'tv') return ['tv'];
  if (hint === 'movie') return ['movie'];
  return ['movie', 'tv'];
}

async function search(client: TmdbClient, kind: TitleKind, query: string, year: number | null): Promise<TmdbSearchHit[]> {
  return kind === 'movie' ? client.searchMovie(query, year) : client.searchTv(query, year);
}

async function bestCandidate(
  client: TmdbClient,
  title: string,
  year: number | null,
  hint: KindHint,
): Promise<Candidate | null> {
  const query = searchQuery(title);
  if (query === '') return null;
  let best: Candidate | null = null;
  for (const kind of kindsFor(hint)) {
    if (best !== null && best.score >= CONFIDENT_SCORE) break;
    let hits = await search(client, kind, query, year);
    if (hits.length === 0 && year !== null) hits = await search(client, kind, query, null);
    for (const hit of hits.slice(0, MAX_CANDIDATES)) {
      const score = scoreHit(title, year, hit);
      if (best === null || score > best.score) best = { hit, score };
    }
  }
  return best;
}

function matched(c: Candidate, source: 'filename' | 'fallback'): MatchResult {
  return { kind: 'matched', tmdbKind: c.hit.kind, tmdbId: c.hit.tmdbId, confidence: c.score, source, matchedTitle: c.hit.title };
}

function none(best: Candidate | null): MatchResult {
  return { kind: 'none', reason: best === null ? 'no_match' : 'low_confidence' };
}

export async function matchTitle(parsed: ParsedName, client: TmdbClient, fallback?: NameFallback | null): Promise<MatchResult> {
  const first = await bestCandidate(client, parsed.title, parsed.year, parsed.kindHint);
  if (first !== null && first.score >= CONFIDENT_SCORE) return matched(first, 'filename');
  if (fallback === undefined || fallback === null) return none(first);

  const answer = await fallback.resolve(parsed.fileName, parsed.dirName);
  if (answer === null) return none(first);
  const second = await bestCandidate(client, answer.title, answer.year, answer.kind ?? parsed.kindHint);
  if (second !== null && second.score >= CONFIDENT_SCORE) return matched(second, 'fallback');
  return none(second ?? first);
}
```
**Impact:** new module, no callers yet.

### Step 11: Matcher tests
**File:** `tests/unit/movies/match.test.ts:1` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import type { FallbackAnswer, NameFallback } from '../../../src/movies/fallback.js';
import { CONFIDENT_SCORE, matchTitle, scoreHit, searchQuery, titleSimilarity } from '../../../src/movies/match.js';
import { parseVideoPath } from '../../../src/movies/parse.js';
import { TmdbError, type TitleKind, type TmdbClient, type TmdbSearchHit } from '../../../src/movies/tmdb.js';

function hit(kind: TitleKind, tmdbId: number, title: string, year: number | null, originalTitle = title): TmdbSearchHit {
  return {
    kind,
    tmdbId,
    title,
    originalTitle,
    releaseDate: year === null ? null : `${year}-06-01`,
    year,
    overview: '',
    posterPath: null,
    popularity: 1,
  };
}

/** Search answers keyed "query|year" ("query|" without a year); anything else answers []. */
function fakeClient(table: { movie?: Record<string, TmdbSearchHit[]>; tv?: Record<string, TmdbSearchHit[]> }) {
  const calls: string[] = [];
  const unused = (): Promise<never> => Promise.reject(new Error('not used by matchTitle'));
  const client: TmdbClient = {
    async searchMovie(query, year = null) {
      calls.push(`movie:${query}|${year ?? ''}`);
      return table.movie?.[`${query}|${year ?? ''}`] ?? [];
    },
    async searchTv(query, year = null) {
      calls.push(`tv:${query}|${year ?? ''}`);
      return table.tv?.[`${query}|${year ?? ''}`] ?? [];
    },
    movieDetails: unused,
    tvDetails: unused,
    searchPerson: unused,
    personCredits: unused,
  };
  return { client, calls };
}

function fakeFallback(answer: FallbackAnswer | null) {
  const asked: Array<[string, string | null]> = [];
  const fallback: NameFallback = {
    model: 'fake',
    async resolve(fileName, dirName) {
      asked.push([fileName, dirName]);
      return answer;
    },
  };
  return { fallback, asked };
}

describe('the confidence rule', () => {
  it('titleSimilarity: equal after normalizing, equal without spaces, else word overlap', () => {
    expect(titleSimilarity('WALL-E', 'WALL·E')).toBe(1);
    expect(titleSimilarity('Nezha', 'Ne Zha')).toBe(0.95);
    expect(titleSimilarity('Rivals of Amziah King', 'The Rivals of Amziah King')).toBeCloseTo(0.889, 3);
    expect(titleSimilarity('Oldboy', 'Wall Street')).toBe(0);
    expect(titleSimilarity('', 'x')).toBe(0);
  });

  it('scoreHit: same year 1, a year off 0.9, further 0.5, a later season year free', () => {
    expect(scoreHit('Oldboy', 2003, hit('movie', 1, 'Oldboy', 2003))).toBe(1);
    expect(scoreHit('Oldboy', 2004, hit('movie', 1, 'Oldboy', 2003))).toBe(0.9);
    expect(scoreHit('Oldboy', 2013, hit('movie', 1, 'Oldboy', 2003))).toBe(0.5);
    expect(scoreHit('MobLand', 2026, hit('tv', 1, 'MobLand', 2025))).toBe(1);
    expect(scoreHit('Oldboy', null, hit('movie', 1, 'Oldboy', 2003))).toBe(1);
    expect(scoreHit('Oldboy', 2003, hit('movie', 1, 'Oldboy', null))).toBe(0.9);
    expect(scoreHit('Ne Zha', 2019, hit('movie', 1, 'Nezha 2019 dub', 2019, 'Ne Zha'))).toBe(1);
  });

  it('searchQuery drops stand-alone dashes', () => {
    expect(searchQuery('Batman - The Killing Joke')).toBe('Batman The Killing Joke');
    expect(searchQuery('WALL-E')).toBe('WALL-E');
  });
});

describe('matchTitle', () => {
  it('matches the file name title and year without asking the fallback', async () => {
    const { client, calls } = fakeClient({
      movie: {
        'How to Make a Killing|2026': [hit('movie', 467905, 'How to Make a Killing', 2026), hit('movie', 1210732, 'How to Make a Killing', 2025)],
      },
    });
    const { fallback, asked } = fakeFallback({ title: 'wrong', year: null, kind: null });
    const parsed = parseVideoPath('How.to.Make.a.Killing.2026.1080p.WEB-DL.x265.6CH-Pahe.in.mkv');
    expect(await matchTitle(parsed, client, fallback)).toEqual({
      kind: 'matched',
      tmdbKind: 'movie',
      tmdbId: 467905,
      confidence: 1,
      source: 'filename',
      matchedTitle: 'How to Make a Killing',
    });
    expect(calls).toEqual(['movie:How to Make a Killing|2026']);
    expect(asked).toEqual([]);
  });

  it('matches WALL-E to WALL·E and a dashed title to a colon title', async () => {
    const { client } = fakeClient({
      movie: {
        'WALL-E|2008': [hit('movie', 10681, 'WALL·E', 2008), hit('movie', 10673, 'Wall Street', 1987)],
        'Batman The Killing Joke|2016': [hit('movie', 382322, 'Batman: The Killing Joke', 2016)],
      },
    });
    expect(await matchTitle(parseVideoPath('Done/WALL-E.2008.1080p.UHD.BluRay.x265-Pahe.in.mkv'), client)).toMatchObject({
      kind: 'matched',
      tmdbId: 10681,
    });
    expect(
      await matchTitle(parseVideoPath('Pak Bernard/Batman - The Killing Joke (2016)/Batman - The Killing Joke.mkv'), client),
    ).toMatchObject({ kind: 'matched', tmdbId: 382322 });
  });

  it('searches series only for an episode', async () => {
    const { client, calls } = fakeClient({ tv: { 'MobLand|': [hit('tv', 247718, 'MobLand', 2025)] } });
    const parsed = parseVideoPath('Mobland S01 WEB-DL 1080p x265 6CH [Pahe.in]/MobLand.S01E05.Funeral.for.a.Friend.mkv');
    expect(await matchTitle(parsed, client)).toMatchObject({ kind: 'matched', tmdbKind: 'tv', tmdbId: 247718 });
    expect(calls).toEqual(['tv:MobLand|']);
  });

  it('searches again without the year when the year finds nothing', async () => {
    const { client, calls } = fakeClient({ movie: { 'Oldboy|': [hit('movie', 670, 'Oldboy', 2003)] } });
    expect(await matchTitle(parseVideoPath('Pak Bernard/Oldboy (2003)/Oldboy.mkv'), client)).toMatchObject({ tmdbId: 670 });
    expect(calls).toEqual(['movie:Oldboy|2003', 'movie:Oldboy|']);
  });

  it('takes TMDB order on a tie', async () => {
    const { client } = fakeClient({
      tv: { 'One Piece|': [hit('tv', 37854, 'One Piece', 1999), hit('tv', 111110, 'ONE PIECE', 2023)] },
    });
    expect(await matchTitle(parseVideoPath('Done/One Piece - 405 720p WEB-DL x264 2CH [Pahe.in].mkv'), client)).toMatchObject({
      tmdbKind: 'tv',
      tmdbId: 37854,
    });
  });

  it('with no hint tries films, then series', async () => {
    const { client, calls } = fakeClient({ tv: { 'Severance|': [hit('tv', 95396, 'Severance', 2022)] } });
    expect(await matchTitle(parseVideoPath('Severance.mkv'), client)).toMatchObject({ tmdbKind: 'tv', tmdbId: 95396 });
    expect(calls).toEqual(['movie:Severance|', 'tv:Severance|']);
  });

  it('asks the fallback when the best candidate is not confident, and matches its title', async () => {
    const { client } = fakeClient({
      movie: {
        'By Any Means|2026': [hit('movie', 1, 'By Any Means', 2008)],
        'Any Means Necessary|2026': [hit('movie', 2, 'Any Means Necessary', 2026)],
      },
    });
    const { fallback, asked } = fakeFallback({ title: 'Any Means Necessary', year: 2026, kind: 'movie' });
    const parsed = parseVideoPath('Done/By Any Means 2026 1080p WEB-DL x265 6CH-Pahe.in.mkv');
    expect(scoreHit(parsed.title, parsed.year, hit('movie', 1, 'By Any Means', 2008))).toBeLessThan(CONFIDENT_SCORE);
    expect(await matchTitle(parsed, client, fallback)).toMatchObject({
      kind: 'matched',
      tmdbId: 2,
      source: 'fallback',
    });
    expect(asked).toEqual([['By Any Means 2026 1080p WEB-DL x265 6CH-Pahe.in.mkv', 'Done']]);
  });

  it('asks the fallback when TMDB has no candidate at all', async () => {
    const { client } = fakeClient({ movie: { 'How to Make a Killing|2026': [hit('movie', 467905, 'How to Make a Killing', 2026)] } });
    const { fallback } = fakeFallback({ title: 'How to Make a Killing', year: 2026, kind: 'movie' });
    expect(await matchTitle(parseVideoPath('Hw.2.Mk.Killng.2026.1080p.mkv'), client, fallback)).toMatchObject({
      kind: 'matched',
      tmdbId: 467905,
      source: 'fallback',
    });
  });

  it('leaves the file unmatched when the fallback has no answer', async () => {
    const { client } = fakeClient({ movie: { 'By Any Means|2026': [hit('movie', 1, 'By Any Means', 2008)] } });
    const { fallback, asked } = fakeFallback(null);
    expect(await matchTitle(parseVideoPath('By Any Means 2026 1080p.mkv'), client, fallback)).toEqual({
      kind: 'none',
      reason: 'low_confidence',
    });
    expect(asked).toHaveLength(1);
  });

  it('leaves the file unmatched when the fallback title is not confident either', async () => {
    const { client } = fakeClient({});
    const { fallback } = fakeFallback({ title: 'Nothing Like It', year: 1999, kind: 'movie' });
    expect(await matchTitle(parseVideoPath('Done/docker_es/VID-20220222-WA0011.mp4'), client, fallback)).toEqual({
      kind: 'none',
      reason: 'no_match',
    });
  });

  it('without a fallback reports no_match and asks nothing more', async () => {
    const { client, calls } = fakeClient({});
    expect(await matchTitle(parseVideoPath('Done/docker_es/VID-20220222-WA0011.mp4'), client, null)).toEqual({
      kind: 'none',
      reason: 'no_match',
    });
    expect(calls).toEqual(['movie:VID-20220222-WA0011|', 'tv:VID-20220222-WA0011|']);
  });

  it('an empty title skips TMDB and goes straight to the fallback', async () => {
    const { client, calls } = fakeClient({});
    const { fallback, asked } = fakeFallback(null);
    expect(await matchTitle(parseVideoPath('[Pahe.in].mkv'), client, fallback)).toEqual({ kind: 'none', reason: 'no_match' });
    expect(calls).toEqual([]);
    expect(asked).toEqual([['[Pahe.in].mkv', null]]);
  });

  it('lets a TmdbError through without asking the fallback (the sync retries the file)', async () => {
    const { fallback, asked } = fakeFallback({ title: 'x', year: null, kind: null });
    const down: TmdbClient = {
      ...fakeClient({}).client,
      searchMovie: () => Promise.reject(new TmdbError('network', 'TMDB /search/movie could not be reached')),
    };
    await expect(matchTitle(parseVideoPath('Oldboy (2003)/Oldboy.mkv'), down, fallback)).rejects.toMatchObject({
      name: 'TmdbError',
      code: 'network',
    });
    expect(asked).toEqual([]);
  });
});
```
**Impact:** `npx vitest run tests/unit/movies` passes: 4 files, 84 tests.

## Principles applied

- Boundary discipline: TMDB JSON is validated once by the zod schemas in `tmdb.ts` and Haiku's answer once in `parseFallbackAnswer`. Everything after works on typed values (`TitleMetadata`, `FallbackAnswer`), and `match.ts` does no checks of its own.
- Make illegal states unrepresentable: `MatchResult` is a discriminated union, so a match can never also carry a reason. Failures are `TmdbError` with a closed `code` set, never a `none` result, so Phase 3 cannot confuse "TMDB is down" (pending, R2.3) with "no such title" (unmatched).
- Laziness protocol: the fallback reuses the summarizer's SDK setup (`findClaudeBin`, `claudeEnv`, `QueryFn`) instead of a new wrapper. There is no retry or backoff layer, no response cache, and season fetches run one after another, because Phase 3 calls this sequentially at most once per new title.
- Build the lever: the real names live in one table (`FILENAME_CASES`) that the unit test and Proof J1 both run, and the fake TMDB (`tests/helpers/tmdbFixtures.ts`) is one helper that serves both an injected fetch and a real HTTP server, ready for Phase 3 and Phase 8.
- Test behavior, not implementation: the tests drive only the public functions, cutting at the process boundary (an injected `fetch`, an injected `QueryFn`, a fake `TmdbClient`). They assert on what a caller sees (titles, credits, episodes, match results, error codes), never on private calls.
- Prove it works: besides the fixture journeys, J4 drives the real TMDB with the owner's token. That is how the One Piece numbering was found and the `absoluteToSeasonEpisode` signature changed (see Interface Contract).

## Verification

**Build:** `cd /home/miftah/.worktrees/mcp-notes/movies-library && npm run typecheck`
**Tests:** `cd /home/miftah/.worktrees/mcp-notes/movies-library && npx vitest run tests/unit/movies && npm test`
**Proof:** the real modules, driven by scripts. J2 and J3 serve the fixtures over a real HTTP server, and J4 talks to the real TMDB.
- Harness: `.claude/skills/verify-notesd` exists, but this phase adds no daemon surface (no route, no MCP tool, no background job; Phase 3 wires it in), so `verify.sh` cannot reach it. The journeys run the modules with `npx tsx` instead. Set up once (paste as-is):
  ```sh
  W=/home/miftah/.worktrees/mcp-notes/movies-library; P=$(mktemp -d); cd "$W"
  ```
  Then write each script below with its heredoc and run it. The heredocs are unquoted on purpose, so `$W` expands to the worktree path.
- Feature-map entries: none. Phase 8 owns `features/movies.md`; this phase has no user-facing surface.
- Journeys:
  - **J1** · traces R1.3 — write `$P/j1.mts` (block J1 below), then `npx tsx "$P/j1.mts"` → passes when it prints one JSON line per name and ends with `R1.3 OK 25 names, shapes absolute,junk,pahe-dots,pahe-underscores,season-folder,trap,two-films,year-in-folder` (exit 0). Any wrong field stops it with an `AssertionError` naming the path.
  - **J2** · traces R2.1 — write `$P/j2.mts` (block J2), then `npx tsx "$P/j2.mts"` → passes when it prints `movie: poster=true release=2026-02-16 synopsis=true companies=2 directors=1 writers=2 producers=3 cast=3; tv: poster=true release=2025-03-30 companies=2 creators=1 directors=2 writers=1 producers=2 cast=2 episodes=S1:3,S2:2` then `R2.1 OK over HTTP: /movie/467905 /tv/247718 /tv/247718/season/1 /tv/247718/season/2` (exit 0)
  - **J3** · traces R2.2 — write `$P/j3.mts` (block J3), then `npx tsx "$P/j3.mts"` → passes when a garbled name is matched to `tmdbId 467905` with `"source":"fallback"` after asking the fallback once; the same name with a fallback answering `null` gives `{"kind":"none","reason":"no_match"}`; a clean name matches with `"source":"filename"` and `fallback asked 0`; and the last line is `R2.2 OK`
  - **J4** · traces R2.1, R1.3 — live TMDB (no fixtures). Write `$P/j4.mts` (block J4), then `export TMDB_API_READ_ACCESS_TOKEN=$(grep '^TMDB_API_READ_ACCESS_TOKEN=' /home/miftah/mcp-notes/.env.local | cut -d= -f2- | tr -d '"') && npx tsx "$P/j4.mts"` → passes when it prints `matches movie-382322 movie-10681 movie-980477 tv-124364` (Batman: The Killing Joke, WALL·E, Ne Zha 2, FROM), then `One Piece 405 -> {"season":11,"episode":405}`, then a line starting `R2.1 LIVE OK` (exit 0). This is the only journey that needs the network. It costs nothing (TMDB is free) and takes about 10 s.
- Neighbor check: the Agent SDK helpers this phase imports, plus the rest of the suite. `npx vitest run tests/unit/sessions/summarize.test.ts tests/unit/chat-env.test.ts && npm test && npm run typecheck` → passes when all are green, with no change to those files.
- Cost: no LLM turns. J3 and the unit tests use a scripted fallback; no journey calls Haiku.

**Block J1** (`$P/j1.mts`)
```sh
cat > "$P/j1.mts" <<EOF
import assert from 'node:assert/strict';
import { parseVideoPath } from '$W/src/movies/parse.ts';
import { FILENAME_CASES } from '$W/tests/fixtures/movies/filenames.ts';
const shapes = new Set<string>();
for (const c of FILENAME_CASES) {
  const { fileName: _f, dirName: _d, ...got } = parseVideoPath(c.relPath);
  console.log(JSON.stringify({ shape: c.shape, relPath: c.relPath, ...got }));
  assert.deepEqual(got, c.expected, c.relPath);
  shapes.add(c.shape);
}
for (const s of ['pahe-dots', 'pahe-underscores', 'year-in-folder', 'season-folder', 'absolute', 'two-films']) assert.ok(shapes.has(s), 'missing shape ' + s);
console.log('R1.3 OK ' + FILENAME_CASES.length + ' names, shapes ' + [...shapes].sort().join(','));
EOF
```

**Block J2** (`$P/j2.mts`)
```sh
cat > "$P/j2.mts" <<EOF
import assert from 'node:assert/strict';
import { createTmdbClient } from '$W/src/movies/tmdb.ts';
import { startTmdbFixtureServer } from '$W/tests/helpers/tmdbFixtures.ts';
const server = await startTmdbFixtureServer();
try {
  const client = createTmdbClient({ token: 'proof-token', apiKey: null, apiBase: server.base });
  const m = await client.movieDetails(467905);
  const t = await client.tvDetails(247718);
  const count = (meta: typeof m, role: string) => meta.credits.filter((c) => c.role === role).length;
  const castWithCharacter = (meta: typeof m) => meta.credits.filter((c) => c.role === 'cast' && c.character !== null).length;
  const perSeason = [...new Set(t.episodes.map((e) => e.season))].map((s) => 'S' + s + ':' + t.episodes.filter((e) => e.season === s && e.name !== '').length).join(',');
  const line = 'movie: poster=' + (m.posterPath !== null) + ' release=' + m.releaseDate + ' synopsis=' + (m.overview.length > 0) + ' companies=' + m.companies.length + ' directors=' + count(m, 'director') + ' writers=' + count(m, 'writer') + ' producers=' + count(m, 'producer') + ' cast=' + castWithCharacter(m)
    + '; tv: poster=' + (t.posterPath !== null) + ' release=' + t.releaseDate + ' companies=' + t.companies.length + ' creators=' + count(t, 'creator') + ' directors=' + count(t, 'director') + ' writers=' + count(t, 'writer') + ' producers=' + count(t, 'producer') + ' cast=' + castWithCharacter(t) + ' episodes=' + perSeason;
  console.log(line);
  assert.equal(line, 'movie: poster=true release=2026-02-16 synopsis=true companies=2 directors=1 writers=2 producers=3 cast=3; tv: poster=true release=2025-03-30 companies=2 creators=1 directors=2 writers=1 producers=2 cast=2 episodes=S1:3,S2:2');
  assert.ok(server.calls.every((c) => c.authorization === 'Bearer proof-token'), 'every request carries the Bearer token');
  console.log('R2.1 OK over HTTP: ' + server.calls.map((c) => c.pathname).join(' '));
} finally {
  await server.close();
}
EOF
```

**Block J3** (`$P/j3.mts`)
```sh
cat > "$P/j3.mts" <<EOF
import assert from 'node:assert/strict';
import { matchTitle } from '$W/src/movies/match.ts';
import { parseVideoPath } from '$W/src/movies/parse.ts';
import { createTmdbClient } from '$W/src/movies/tmdb.ts';
import type { FallbackAnswer, NameFallback } from '$W/src/movies/fallback.ts';
import { startTmdbFixtureServer } from '$W/tests/helpers/tmdbFixtures.ts';
const server = await startTmdbFixtureServer();
const fallbackSaying = (answer: FallbackAnswer | null) => {
  const asked: string[] = [];
  const fb: NameFallback = { model: 'scripted', resolve: async (fileName) => { asked.push(fileName); return answer; } };
  return { fb, asked };
};
try {
  const client = createTmdbClient({ token: 'proof-token', apiKey: null, apiBase: server.base });
  const garbled = parseVideoPath('Done/Hw.2.Mk.Killng.2026.1080p.WEB-DL.x265-Pahe.in.mkv');
  const a = fallbackSaying({ title: 'How to Make a Killing', year: 2026, kind: 'movie' });
  const viaFallback = await matchTitle(garbled, client, a.fb);
  console.log('garbled + fallback ->', JSON.stringify(viaFallback), 'asked', JSON.stringify(a.asked));
  assert.deepEqual(a.asked, ['Hw.2.Mk.Killng.2026.1080p.WEB-DL.x265-Pahe.in.mkv']);
  assert.equal(viaFallback.kind, 'matched');
  assert.ok(viaFallback.kind === 'matched' && viaFallback.tmdbId === 467905 && viaFallback.source === 'fallback');
  const b = fallbackSaying(null);
  const unmatched = await matchTitle(garbled, client, b.fb);
  console.log('garbled + no fallback answer ->', JSON.stringify(unmatched));
  assert.deepEqual(unmatched, { kind: 'none', reason: 'no_match' });
  assert.equal(b.asked.length, 1);
  const c = fallbackSaying({ title: 'Wrong', year: null, kind: null });
  const direct = await matchTitle(parseVideoPath('How.to.Make.a.Killing.2026.1080p.WEB-DL.x265.6CH-Pahe.in.mkv'), client, c.fb);
  console.log('clean name ->', JSON.stringify(direct), 'fallback asked', c.asked.length);
  assert.ok(direct.kind === 'matched' && direct.source === 'filename' && direct.tmdbId === 467905);
  assert.equal(c.asked.length, 0);
  console.log('R2.2 OK');
} finally {
  await server.close();
}
EOF
```

**Block J4** (`$P/j4.mts`)
```sh
cat > "$P/j4.mts" <<EOF
import assert from 'node:assert/strict';
import { matchTitle } from '$W/src/movies/match.ts';
import { parseVideoPath } from '$W/src/movies/parse.ts';
import { absoluteToSeasonEpisode, createTmdbClient } from '$W/src/movies/tmdb.ts';
const token = process.env.TMDB_API_READ_ACCESS_TOKEN ?? null;
assert.ok(token, 'TMDB_API_READ_ACCESS_TOKEN must be exported');
const client = createTmdbClient({ token, apiKey: null, apiBase: 'https://api.themoviedb.org/3' });
const rows: string[] = [];
for (const rel of ['Pak Bernard/Batman - The Killing Joke (2016)/Batman - The Killing Joke.mkv', 'Done/WALL-E.2008.1080p.UHD.BluRay.x265.HDR.DV.DD+5.1-Pahe.in.mkv', 'Done/Nezha (2019)/Ne.Zha.2.2025.1080p.WEB-DL.x265.6CH-Pahe.in.mkv', 'Done/From S03 1080p x265 [Pahe.in]/From.S03E10.Revelations.Chapter.Two.1080p.WEB-DL.x265.6CH-Pahe.in.mkv']) {
  const r = await matchTitle(parseVideoPath(rel), client);
  rows.push(r.kind === 'matched' ? r.tmdbKind + '-' + r.tmdbId : 'none:' + r.reason);
}
console.log('matches', rows.join(' '));
assert.deepEqual(rows, ['movie-382322', 'movie-10681', 'movie-980477', 'tv-124364']);
const m = await client.movieDetails(467905);
assert.ok(m.companies.some((c) => c.name === 'StudioCanal'));
assert.ok(m.credits.some((c) => c.role === 'director' && c.name === 'John Patton Ford'));
assert.ok(m.credits.some((c) => c.role === 'cast' && c.name === 'Margaret Qualley' && c.character === 'Julia'));
const t = await client.tvDetails(247718);
const s1 = t.episodes.filter((e) => e.season === 1);
assert.equal(s1.find((e) => e.episode === 1)?.name, 'Stick or Twist');
assert.ok(s1.length >= 10);
const onePiece = await matchTitle(parseVideoPath('Done/One Piece - 405 720p WEB-DL x264 2CH [Pahe.in].mkv'), client);
assert.ok(onePiece.kind === 'matched' && onePiece.tmdbId === 37854);
const op = await client.tvDetails(37854);
const se = absoluteToSeasonEpisode(op.episodes, 405);
console.log('One Piece 405 ->', JSON.stringify(se), op.episodes.find((e) => e.season === se?.season && e.episode === se?.episode)?.name);
assert.deepEqual(se, { season: 11, episode: 405 });
console.log('R2.1 LIVE OK movie companies=' + m.companies.length + ' credits=' + m.credits.length + '; tv seasons=' + t.seasonCount + ' episodes=' + t.episodes.length);
EOF
```

**Exit criteria:** `npm run typecheck` and `npm test` are green. J1 through J4 print their OK lines. Every name in the request parses to the expected title, year, season, episode and absolute episode. `tvDetails` returns the episodes of every season. A name below 0.85 goes to the fallback and is left unmatched when the fallback gives nothing confident. An unreachable TMDB raises `TmdbError` (unit test `errors › an unreachable TMDB is a network TmdbError`).

## Handoffs

- **Phase 3 (Library sync), for R1.1, R1.2, R2.1 (storing half), R2.3:**
  - Call `parseVideoPath` with the path relative to its root, `/`-separated.
  - Run `matchTitle(parsed, tmdb, fallback)`. On a match, fetch `movieDetails` or `tvDetails` once per new title and hand the `TitleMetadata` to `MoviesRepo.upsertTitle`. Storing it is the storing half of R2.1, which Phase 3 owns.
  - **Catch `TmdbError`** around both calls: code `no_credentials` -> reason `no_tmdb_credentials`; any other code -> status `pending`, reason `tmdb_error`, retried next pass (R2.3).
  - `{ kind: 'none', reason }` -> status `unmatched` with that reason.
  - Map `absoluteEpisode` with `absoluteToSeasonEpisode(meta.episodes, n)`. When it returns `null`, keep the file on the series with season and episode null, as the index decides.
  - Build the fallback with `createHaikuFallback({ claudeBin: config.chat.claudeBin, cwd: path.join(config.dataDir, 'movies-fallback'), model: config.movies.fallbackModel })`; `null` means run without one.
  - **Cost guard:** probe the duration first, so a file under `minSeconds` never reaches TMDB or Haiku (the ~28 `docker_es` clips). Do not re-match `unmatched` files on every pass. Each re-match can be one Haiku call, and `scanMs` is 2 minutes.
  - `tvDetails(37854)` (One Piece) is 25 requests and about 7 s. Fetch details once per title per pass, not once per episode file.
- **Phase 4 (HTTP API), for R1.5, R2.4:** use `searchMovie`/`searchTv` for `GET /api/movies/search-tmdb` (hits carry `posterPath`), and `posterUrl(config.movies.tmdb.imageBase, posterPath)` for `poster_url`.
- **Phase 7 (MCP), for R6.4:** `movies_person` = `searchPerson(name)[0]` -> `personCredits(id)`. Each entry has `kind` and `tmdbId`, so "seen" is a lookup of `titleId(kind, tmdbId)`.
- **Phase 8 (Docs), for R7.1:** the feature map entry `features/movies.md`. `startTmdbFixtureServer()` and `tests/fixtures/movies/*.json` can serve as the fake TMDB for `verify.sh` (`TMDB_API_BASE=<base>`). Add fixtures there for whatever titles the verify tree uses.
- **Phase 3:** replace the mirrored type block in `tmdb.ts` with the re-export from `./types.js` (reconciled; see Interface Contract). The index's Shared contract and Decisions row on absolute numbering were updated by the reconciler.
- No criterion is left untraced.

## Rollback

Delete the new files: `src/movies/parse.ts`, `tmdb.ts`, `match.ts`, `fallback.ts`, `tests/unit/movies/`, `tests/fixtures/movies/` and `tests/helpers/tmdbFixtures.ts`. No existing file was touched and nothing imports these modules until Phase 3, so reverting this phase's commit is enough.

