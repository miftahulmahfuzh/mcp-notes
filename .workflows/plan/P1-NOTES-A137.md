> Adopted from `.workflows/plan/WIDER_TORRENT_SOURCES_PLAN.md` phase 2. Source: `.workflows/plan/wider-torrent-sources/phase-2.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 2: Title-search JSON indexes: Knaben, Bitsearch, torrents-csv

**Plan set:** `WIDER_TORRENT_SOURCES_PLAN.md`
**Analysis:** `.workflows/analyze/20261119-025431-K7QD_code_analyzer.md`
**Satisfies:** R1 — more indexes behind TM / TS: three indexes asked by title, side by side with the IMDb-keyed ones
**Criteria:** R1.1, R1.2, R1.3, R1.4
**Depends on:** Phase 1
**Difficulty:** HARD
**Package:** `src/directStream/torrent/find`

---

## Goal

The torrent finder asks Knaben, Bitsearch and torrents-csv on every torrent play, side by side with Torrentio, apibay,
EZTV, YTS and phase 1's add-on providers: a film by title and year, an episode by title and `SxxEyy`, one
`Index: <name>` attempt each. A release only these title searches list must name the asked title followed directly by
the film's year (±1) or the episode's marker; anything else lands in `excluded` as `other_title`, `other_year` or
`other_episode` and is never opened. Each index has its own address setting with `off`; an index may now send a
method and a body (Knaben is a POST) while notesd's User-Agent stays forced.

## Interface Contract

**Deletes:** none.
**Renames:** none.
**Creates:**
- `src/directStream/torrent/find/titleSearch.ts` (new): `TITLE_SEARCH_TIMEOUT_MS` (8 000), `TITLE_SEARCH_ROWS` (50), `TITLE_SEARCH_YEAR_SLACK` (1), `type TitleSearchExclusion`, `titleSearchText(query)`, `unsearchable(query)`, `titleSearchExclusion(name, query)`, `titleSearchAnswer(rows, index, query)`.
- `src/directStream/torrent/find/knaben.ts` (new): `knabenIndex(base)` (name `knaben`).
- `src/directStream/torrent/find/bitsearch.ts` (new): `bitsearchIndex(base)` (name `bitsearch`).
- `src/directStream/torrent/find/torrentscsv.ts` (new): `torrentscsvIndex(base)` (name `torrentscsv`).
- `src/directStream/torrent/find/http.ts`: `postIndexJson(ctx, url, payload)`; private `readIndexJson(res)` (`getIndexJson` keeps its signature and behaviour).
- `TorrentCandidate.titleSearch?: true` (`find/types.ts`).
- `ExcludeReason` gains `'other_year'` (`find/types.ts`).
- Registry members `knaben`, `bitsearch`, `torrentscsv` in `IndexBases`, `DEFAULT_INDEX_BASES`, `defaultIndexes` (`find/find.ts`), `TORRENT_INDEX_NAMES` and `TORRENT_INDEX_URL_KEYS` (`src/config.ts`).
- Env: `NOTESD_TORRENT_KNABEN_URL`, `NOTESD_TORRENT_BITSEARCH_URL`, `NOTESD_TORRENT_TORRENTSCSV_URL` (http(s) address or `off`).
- Fixtures `tests/fixtures/torrent/{knaben,bitsearch,torrentscsv}-shawshank.json` (byte copies of the analysis samples); test file `tests/unit/directStream/torrent/find/titleSearch.test.ts`.

**Signature changes:**
- `IndexFetch`: `(url: string, init?: { headers?: Record<string, string> }) => Promise<Response>` -> `(url: string, init?: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string }) => Promise<Response>`.
- `FetchLike`: `(url: string, init: { headers: Headers; signal: AbortSignal }) => Promise<Response>` -> `(url: string, init: { method?: 'GET' | 'POST'; headers: Headers; body?: string; signal: AbortSignal }) => Promise<Response>` (existing fakes that read only `headers`/`signal` still type-check; the global `fetch` still fits).
- `askOne`'s context fetch (`find/find.ts`) forwards `method` and `body` when the index gives them; a GET passes exactly `{ headers, signal }` as today; `user-agent` is still set last.
- `exclusionOf` / `joinListings` (`find/rank.ts`): a candidate all of whose listings are `titleSearch` must also pass `titleSearchExclusion` (right after `bad_hash`); a joined candidate keeps `titleSearch` only when every listing in its group has it.

**Requires (from earlier phases):**
- Phase 1: `IndexBases` / `DEFAULT_INDEX_BASES` already hold `torrentsdb` and `peerflix`; `defaultIndexes` returns torrentio, apibay, eztv, torrentsdb, peerflix and (`yts !== false`) yts, and still ends with `  return indexes;`.
- Phase 1: `TORRENT_INDEX_NAMES` and `TORRENT_INDEX_URL_KEYS` hold `torrentsdb`/`peerflix`; `parseTorrentFinder` and `indexesOf` (`source.ts:1055`) stay generic over `TORRENT_INDEX_NAMES` (a name set `off` is filtered out by `index.name`). **This phase does not edit `indexesOf`; it relies on that generic filter.**
- Phase 1: `verify.sh`'s index block names `NOTESD_TORRENT_TORRENTSDB_URL=off NOTESD_TORRENT_PEERFLIX_URL=off` on a line of its own in each branch, and `tests/unit/config.torrentFinder.test.ts` fails unless every `TORRENT_INDEX_URL_KEYS` value appears at least twice in `verify.sh` (Step 15 satisfies it for this phase's three keys); `configuration.md` holds its two rows after the `NOTESD_TORRENT_YTS_URL` row.
- Phase 1: the default-index tests in `findCandidates.test.ts` keep the default indexes (no explicit `indexes` list; reconciled): the film test is renamed `'asks Torrentio, apibay, TorrentsDB and YTS for a film by its IMDb id and answers ranked candidates'`, and phase 1 adds a `describe('findCandidates with the Stremio add-on providers')` whose Peerflix and failure tests pin the whole attempt list, plus `addonSwitches.test.ts` pinning the default index names. This phase appends its routes and expected attempts *after* phase 1's in all of them (Step 12).

**Leaves alone (owned by others):** `find/torrentio.ts` and the add-on providers (phase 1, read only), the `indexesOf` body and its doc comment (phase 1; generic over the index names); `find/scrape.ts`, `origins.ts`, tracker wiring in `source.ts` (`trackersOf`, `swarmCounts`, `buildTorrentSource`), `src/background.ts`, `src/daemon.ts`, the torrent block of `src/config.ts` (:421-440, :1092-1104), `engine.ts` (phase 3); the browser sites and `claude/streaming/torrent/match.mjs`, `fake-index.mjs` (nobody in this set).

**Shared-file regions this phase edits (anchors that exist today):**
- `src/config.ts:336` `TORRENT_INDEX_NAMES` (three names appended at the end of the array); `src/config.ts:357-362` `TORRENT_INDEX_URL_KEYS` (three entries appended after the last one); `src/config.ts:1197` loadConfig header comment: that one line becomes two, naming phase 1's two keys and this phase's three (phase 1 does not touch the comment; phase 3 inserts its own line after :1194, so :1195-1196 stay unchanged between the hunks).
- `docs/guide/reference/configuration.md`: three rows inserted immediately **before** the `NOTESD_TORRENT_1337X_ORIGIN` row (so after phase 1's rows).
- `docs/guide/streaming.md`: one new bullet inserted immediately **before** `- **Off.** With `NOTESD_TORRENT=off` nothing above happens` (≈:1808); the "Finding a torrent" bullet (phase 1 edits its index list) is not touched.
- `.claude/skills/verify-notesd/scripts/verify.sh`: inside the `if [ "$torrent" = 1 ]` index block, one line after each of phase 1's two new lines (one per branch), so every key of this phase is named twice, as phase 1's test requires. Phase 3's edit is in the base `env=(...)` array (:262), far from here.
- `.claude/skills/verify-notesd/features/direct-streaming.md`: one bullet inserted immediately **before** `- Throwaway daemon, a torrent run (`$V up --web --torrent`, note RUN)`, which after phase 1 is directly after phase 1's Stremio add-on bullet.
- `CLAUDE.md`: one bullet inserted immediately **before** `  - A torrent is chosen by its swarm, not by the index's seed count` (today :116), i.e. directly after phase 1's index bullet. Moved by the reconciler from before `  - The trackers are asked …` (:118), which left only two unchanged lines between this hunk and phase 3's insert after :120.

## Files

| File | Action | What changes |
|---|---|---|
| `src/directStream/torrent/find/types.ts` | modify | `TorrentCandidate.titleSearch?` (:113), `IndexFetch` (:137), `FetchLike` (:163), `ExcludeReason` adds `other_year` |
| `src/directStream/torrent/find/http.ts` | modify | `getIndexJson` split into `readIndexJson` + `postIndexJson` (:14-24) |
| `src/directStream/torrent/find/find.ts` | modify | imports (as phase 1 leaves them), `IndexBases`, `DEFAULT_INDEX_BASES`, `defaultIndexes` doc comment and body (before `return indexes;`), `askOne` ctx fetch |
| `src/directStream/torrent/find/titleSearch.ts` | create | query text, title-search fit, answer builder |
| `src/directStream/torrent/find/knaben.ts` | create | Knaben index (JSON POST) |
| `src/directStream/torrent/find/bitsearch.ts` | create | Bitsearch index |
| `src/directStream/torrent/find/torrentscsv.ts` | create | torrents-csv index |
| `src/directStream/torrent/find/rank.ts` | modify | import, `joinListings` (:47-68), `exclusionOf` (:75-77) |
| `src/directStream/torrent/find/index.ts` | modify | four `export *` lines appended at the end |
| `src/config.ts` | modify | `TORRENT_INDEX_NAMES` (:336), `TORRENT_INDEX_URL_KEYS` (after phase 1's `peerflix` entry), header comment (:1197 only) |
| `tests/fixtures/torrent/knaben-shawshank.json` | create | copy of `samples/knaben.json` |
| `tests/fixtures/torrent/bitsearch-shawshank.json` | create | copy of `samples/bitsearch.json` |
| `tests/fixtures/torrent/torrentscsv-shawshank.json` | create | copy of `samples/tcsv.json` |
| `tests/unit/directStream/torrent/find/titleSearch.test.ts` | create | R1.1-R1.3 behaviour through `findCandidates` and the three indexes |
| `tests/unit/directStream/torrent/find/findCandidates.test.ts` | modify | default-index tests (phase 1's four edited ones and its two new add-on tests that pin attempts): three title-search routes or attempts appended |
| `tests/unit/directStream/torrent/find/addonSwitches.test.ts` | modify | phase 1's two pinned name lists gain the three title-search names |
| `tests/unit/config.torrentFinder.test.ts` | modify | one test: the three addresses and `off` |
| `docs/guide/reference/configuration.md` | modify | three rows before `NOTESD_TORRENT_1337X_ORIGIN` |
| `docs/guide/streaming.md` | modify | "Indexes asked by title" bullet before "**Off.**" in "Playing from a torrent" |
| `.claude/skills/verify-notesd/scripts/verify.sh` | modify | the three addresses pinned `off` in both branches of the index block |
| `.claude/skills/verify-notesd/features/direct-streaming.md` | modify | one bullet under "Playing from a torrent" |
| `CLAUDE.md` | modify | one bullet under Direct streaming |

## Implementation Steps

### Step 1: Let an index send a method and a body (types)
**File:** `src/directStream/torrent/find/types.ts:137` and `:163`
**Change:** Widen `IndexFetch` and `FetchLike`.

Before (:133-137):
```ts
/**
 * The only fetch an index gets. findCandidates builds it: it sets notesd's User-Agent last (an
 * index cannot replace it) and binds the index's timeout signal.
 */
export type IndexFetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;
```
After:
```ts
/**
 * The only fetch an index gets. findCandidates builds it: it sets notesd's User-Agent last (an
 * index cannot replace it) and binds the index's timeout signal. An index may send a method and a
 * body (Knaben's search is a JSON POST); nothing else of a request is the index's to choose.
 */
export type IndexFetch = (url: string, init?: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string }) => Promise<Response>;
```

Before (:162-163):
```ts
/** What findCandidates calls. The global fetch fits. */
export type FetchLike = (url: string, init: { headers: Headers; signal: AbortSignal }) => Promise<Response>;
```
After:
```ts
/** What findCandidates calls. The global fetch fits. `method` and `body` are present only when the index gave them. */
export type FetchLike = (url: string, init: { method?: 'GET' | 'POST'; headers: Headers; body?: string; signal: AbortSignal }) => Promise<Response>;
```
**Impact:** typing only; every existing fake (`(url, init) => …` reading `init.headers`) still fits.

### Step 2: Mark a title-search listing, and the new exclusion reason (types)
**File:** `src/directStream/torrent/find/types.ts:111-113` and the `ExcludeReason` line
**Change:** Add the optional field after `scoped` in `TorrentCandidate`; add `other_year`.

Before (:111-114):
```ts
  /** The index answered for this exact episode (Torrentio's series address), so a name that says nothing still fits. */
  scoped: boolean;
  release: ReleaseInfo;
}
```
After:
```ts
  /** The index answered for this exact episode (Torrentio's series address), so a name that says nothing still fits. */
  scoped: boolean;
  /**
   * Every listing of this info hash came from an index asked by title (find/titleSearch.ts), none from one asked by
   * IMDb id. rank.ts then holds it to the title-search fit: the title, followed directly by the film's year or the
   * episode's marker. Absent otherwise; never false.
   */
  titleSearch?: true;
  release: ReleaseInfo;
}
```

Before:
```ts
export type ExcludeReason = 'bad_hash' | 'other_title' | 'dubbed' | 'cam' | 'three_d' | 'other_episode' | 'few_seeds' | 'too_big';
```
After:
```ts
/** `other_year`: a release only a title search listed names another year than the film's, or none (titleSearch.ts). */
export type ExcludeReason = 'bad_hash' | 'other_title' | 'other_year' | 'dubbed' | 'cam' | 'three_d' | 'other_episode' | 'few_seeds' | 'too_big';
```
**Impact:** additive; no exhaustive `switch` over `ExcludeReason` exists (grep over `src`, `web/src`, `claude`, `scripts`).

### Step 3: A JSON POST beside getIndexJson
**File:** `src/directStream/torrent/find/http.ts:14-24`
**Change:** Factor the answer reading out so `getIndexJson` and the new `postIndexJson` share it.

Before:
```ts
/** One GET. A network failure or an abort throws; findCandidates records it as the index's `error`. */
export async function getIndexJson(ctx: IndexContext, url: string): Promise<JsonAnswer> {
  const res = await ctx.fetch(url);
  const body = await res.text();
  if (isBotCheck(res.status, res.headers, body)) return { ok: false, outcome: 'bot_check', detail: `HTTP ${res.status}: a bot check page` };
  if (!res.ok) return { ok: false, outcome: 'error', detail: `HTTP ${res.status}` };
  try {
    return { ok: true, json: JSON.parse(body) as unknown };
  } catch {
    return { ok: false, outcome: 'error', detail: 'the answer is not JSON' };
  }
}
```
After:
```ts
/** An index's answer as JSON, or why not: a bot check page is `bot_check` (never worked around), any other failure `error`. */
async function readIndexJson(res: Response): Promise<JsonAnswer> {
  const body = await res.text();
  if (isBotCheck(res.status, res.headers, body)) return { ok: false, outcome: 'bot_check', detail: `HTTP ${res.status}: a bot check page` };
  if (!res.ok) return { ok: false, outcome: 'error', detail: `HTTP ${res.status}` };
  try {
    return { ok: true, json: JSON.parse(body) as unknown };
  } catch {
    return { ok: false, outcome: 'error', detail: 'the answer is not JSON' };
  }
}

/** One GET. A network failure or an abort throws; findCandidates records it as the index's `error`. */
export async function getIndexJson(ctx: IndexContext, url: string): Promise<JsonAnswer> {
  return readIndexJson(await ctx.fetch(url));
}

/** One POST of a JSON body (Knaben). Read like getIndexJson; the User-Agent is still notesd's (findCandidates sets it). */
export async function postIndexJson(ctx: IndexContext, url: string, payload: unknown): Promise<JsonAnswer> {
  return readIndexJson(await ctx.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }));
}
```
**Impact:** `getIndexJson` behaves exactly as before (existing `indexes.test.ts` unchanged).

### Step 4: askOne forwards method and body, User-Agent still last
**File:** `src/directStream/torrent/find/find.ts:154-161`
**Change:** The context fetch forwards `method`/`body` only when the index sets them; a GET still gets `{ headers, signal }`.

Before:
```ts
  const ctx: IndexContext = {
    signal: controller.signal,
    fetch: (url, init) => {
      const headers = new Headers(init?.headers);
      if (!headers.has('accept')) headers.set('accept', 'application/json');
      headers.set('user-agent', run.userAgent);
      return run.fetch(url, { headers, signal: controller.signal });
    },
  };
```
After:
```ts
  const ctx: IndexContext = {
    signal: controller.signal,
    fetch: (url, init) => {
      const headers = new Headers(init?.headers);
      if (!headers.has('accept')) headers.set('accept', 'application/json');
      // Set last: whatever headers an index passes, every request says it is notesd.
      headers.set('user-agent', run.userAgent);
      return run.fetch(url, {
        ...(init?.method === undefined ? {} : { method: init.method }),
        headers,
        ...(init?.body === undefined ? {} : { body: init.body }),
        signal: controller.signal,
      });
    },
  };
```
**Impact:** the existing test `'sends every request as notesd, whatever an index asks for'` still passes; a POST reaches the fetch as a POST.

### Step 5: The shared title-search helper
**File:** `src/directStream/torrent/find/titleSearch.ts` (new)
**Code:**
```ts
import { answerOf, candidateFrom } from './candidate.js';
import type { ExcludeReason, IndexAnswer, IndexRow, TorrentQuery, TvQuery } from './types.js';

/**
 * The indexes asked by title, not by IMDb id: Knaben, Bitsearch, torrents-csv (WIDER_TORRENT_SOURCES_PLAN phase 2).
 * An IMDb-keyed index answers for the title it was asked. A title search answers anything whose name holds the words,
 * so a release only title searches list is held to a stricter fit (titleSearchExclusion, applied in rank.ts): it must
 * start with the asked title and go straight on to the film's year or the episode's marker. A title is never guessed.
 */

/** Each title-search index's own limit; shorter than the finder's 10 s, so it never holds a play up longer. */
export const TITLE_SEARCH_TIMEOUT_MS = 8_000;
/** Rows asked of an index that takes a count (Knaben, torrents-csv). */
export const TITLE_SEARCH_ROWS = 50;
/** A film's release may carry the year next to TMDB's (a festival year, a late release); further off is another film. */
export const TITLE_SEARCH_YEAR_SLACK = 1;

export type TitleSearchExclusion = Extract<ExcludeReason, 'other_title' | 'other_year'>;

const ARTICLES: ReadonlySet<string> = new Set(['the', 'a', 'an']);
/** Words a release may put between a film's title and its year ("Kingdom of Heaven Directors Cut 2005"). */
const EDITION_WORDS: ReadonlySet<string> = new Set(['extended', 'directors', 'director', 'dc', 'cut', 'uncut', 'unrated', 'remastered', 'theatrical', 'edition', 'imax', 'repack', 'proper', 'criterion']);
/** Words that open a season pack's name right after the series' title. */
const SEASON_WORDS: ReadonlySet<string> = new Set(['season', 'seasons', 'complete', 'temporada', 'saison']);
const YEAR = /^(?:19|20)\d{2}$/;
/** "s01e01", "s01", "e01", "1x01", once the name is split into words. */
const EPISODE_MARK = /^(?:s\d{1,2}(?:e\d{1,4})?|e\d{1,4}|\d{1,2}x\d{2,3})$/;
/** A leading "[group]", "(tag)", "{tag}", "【tag】" or "www.site.org - " before the release's own name. */
const PREFIX = /^\s*(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|【[^】]*】|(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,6}\s+-\s+)\s*/i;

const two = (n: number): string => String(n).padStart(2, '0');

function titleOf(query: TorrentQuery): string {
  return query.title?.trim() || query.originalTitle?.trim() || '';
}

/**
 * What a title-search index is asked: a film as its title and year ("Dune 2021"), an episode as its title and
 * SxxEyy, numbered within the season (`alt`) when TMDB's number runs on across seasons. Null when the query has no
 * name, or is a film with no year: such a query is not searched at all (`unsearchable`).
 */
export function titleSearchText(query: TorrentQuery): string | null {
  const title = titleOf(query);
  if (title === '') return null;
  if (query.kind === 'movie') return query.year === null || query.year === undefined ? null : `${title} ${query.year}`;
  const episode = query.alt ?? query;
  return `${title} S${two(episode.season)}E${two(episode.episode)}`;
}

/** The answer of a title-search index that sent no request because titleSearchText had nothing to ask. */
export function unsearchable(query: TorrentQuery): IndexAnswer {
  const detail = titleOf(query) === '' ? 'not asked: the title has no name to search by' : 'not asked: a film is searched by title and year, and its year is unknown';
  return { outcome: 'empty', detail, candidates: [] };
}

/** A title-search index's rows as candidates marked `titleSearch`, so rank.ts holds them to titleSearchExclusion. */
export function titleSearchAnswer(rows: readonly IndexRow[], index: string, query: TorrentQuery): IndexAnswer {
  return answerOf(rows.map((row) => ({ ...candidateFrom(row, index, query), titleSearch: true as const })));
}

/** Lower case, accents dropped, "&" read as "and", apostrophes dropped, split on anything else; a leading article dropped. */
function words(text: string): string[] {
  const all = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== '');
  return all.length > 1 && all[0] !== undefined && ARTICLES.has(all[0]) ? all.slice(1) : all;
}

/** The name's words, then again after each leading prefix ("[YTS.MX] ", "www.UIndex.org - "), at most three. */
function readings(name: string): string[][] {
  const out = [words(name)];
  let rest = name;
  for (let i = 0; i < 3; i++) {
    const m = PREFIX.exec(rest);
    if (m === null || m[0] === '') break;
    rest = rest.slice(m[0].length);
    out.push(words(rest));
  }
  return out;
}

function startsWith(name: readonly string[], title: readonly string[]): boolean {
  return title.length > 0 && title.length <= name.length && title.every((w, i) => name[i] === w);
}

/** What follows a film's title: its year (after any edition words), within the slack. */
function filmFit(rest: readonly string[], year: number): TitleSearchExclusion | null {
  let at = 0;
  while (at < rest.length && EDITION_WORDS.has(rest[at] ?? '')) at++;
  const next = rest[at];
  if (next !== undefined && YEAR.test(next)) return Math.abs(Number(next) - year) <= TITLE_SEARCH_YEAR_SLACK ? null : 'other_year';
  // The title runs on into other words before a year ("Dune Part Two 2024"): another film. No year at all: nothing says which.
  return rest.some((w) => YEAR.test(w)) ? 'other_title' : 'other_year';
}

/** What follows a series' title: an optional year ("Doctor Who 2005"), then a season or episode marker, or the running number. */
function episodeFollows(rest: readonly string[], query: TvQuery): boolean {
  let at = 0;
  if (YEAR.test(rest[at] ?? '')) at++;
  const next = rest[at];
  if (next === undefined) return false;
  if (EPISODE_MARK.test(next) || SEASON_WORDS.has(next)) return true;
  const running = query.absoluteEpisode ?? null;
  return running !== null && /^\d{1,4}$/.test(next) && Number(next) === running;
}

/**
 * Why a release only a title search listed is not the asked title, or null when it is. It must start with the title
 * or the original title (after a leading group or site prefix, a leading article ignored), then go straight on to:
 * - a film: its year, give or take TITLE_SEARCH_YEAR_SLACK (edition words may come between). Another year, or no year,
 *   is `other_year`; other words before the year are `other_title`.
 * - an episode: a season or episode marker (or the running number of a long anime). Which episode is left to rank.ts's
 *   episode check (`other_episode`), as for every unscoped listing.
 */
export function titleSearchExclusion(name: string, query: TorrentQuery): TitleSearchExclusion | null {
  const titles = [query.title, query.originalTitle].map((t) => words(t ?? '')).filter((w) => w.length > 0);
  if (titles.length === 0) return 'other_title';
  let wrongYear = false;
  for (const reading of readings(name)) {
    for (const title of titles) {
      if (!startsWith(reading, title)) continue;
      const rest = reading.slice(title.length);
      if (query.kind === 'tv') {
        if (episodeFollows(rest, query)) return null;
        continue;
      }
      // Not reached through the indexes (a film with no year is never searched); without a year nothing tells two films apart.
      if (query.year === null || query.year === undefined) return 'other_year';
      const fit = filmFit(rest, query.year);
      if (fit === null) return null;
      if (fit === 'other_year') wrongYear = true;
    }
  }
  return wrongYear ? 'other_year' : 'other_title';
}
```
**Impact:** new module; nothing imports it until Steps 6-9.

### Step 6: Knaben
**File:** `src/directStream/torrent/find/knaben.ts` (new)
**Code:**
```ts
import { asCount, asList, asRecord, asText, failedAnswer, postIndexJson, trackersFromMagnet } from './http.js';
import { TITLE_SEARCH_ROWS, TITLE_SEARCH_TIMEOUT_MS, titleSearchAnswer, titleSearchText, unsearchable } from './titleSearch.js';
import type { IndexRow, TorrentIndex } from './types.js';

/** One Knaben hit as an IndexRow; null without an info hash (a link-only listing) or a title. */
function readKnabenHit(value: unknown): IndexRow | null {
  const hit = asRecord(value);
  const infoHash = asText(hit?.hash);
  const name = asText(hit?.title);
  if (hit === null || infoHash === null || name === null) return null;
  const magnet = asText(hit.magnetUrl);
  return {
    infoHash,
    name,
    seeds: asCount(hit.seeders) ?? 0,
    sizeBytes: asCount(hit.bytes),
    trackers: magnet === null ? [] : trackersFromMagnet(magnet),
    // Knaben aggregates: "The Pirate Bay", "1337x", ...
    site: asText(hit.tracker) ?? 'Knaben',
  };
}

/** Knaben (api.knaben.org/v1): one JSON POST, searched by title, most seeded first. */
export function knabenIndex(base: string): TorrentIndex {
  const root = base.replace(/\/+$/, '');
  return {
    name: 'knaben',
    timeoutMs: TITLE_SEARCH_TIMEOUT_MS,
    async find(query, ctx) {
      const text = titleSearchText(query);
      if (text === null) return unsearchable(query);
      const got = await postIndexJson(ctx, root, {
        search_type: '100%',
        search_field: 'title',
        query: text,
        order_by: 'seeders',
        order_direction: 'desc',
        size: TITLE_SEARCH_ROWS,
        hide_unsafe: true,
        hide_xxx: true,
      });
      if (!got.ok) return failedAnswer(got);
      const hits = asList(asRecord(got.json)?.hits);
      if (hits === null) return { outcome: 'error', detail: 'the answer has no hits list', candidates: [] };
      const rows = hits.map((h: unknown) => readKnabenHit(h)).filter((r): r is IndexRow => r !== null);
      return titleSearchAnswer(rows, 'knaben', query);
    },
  };
}
```

### Step 7: Bitsearch
**File:** `src/directStream/torrent/find/bitsearch.ts` (new)
**Code:**
```ts
import { asCount, asList, asRecord, asText, failedAnswer, getIndexJson } from './http.js';
import { TITLE_SEARCH_TIMEOUT_MS, titleSearchAnswer, titleSearchText, unsearchable } from './titleSearch.js';
import type { IndexRow, TorrentIndex } from './types.js';

function readBitsearchResult(value: unknown): IndexRow | null {
  const result = asRecord(value);
  const infoHash = asText(result?.infohash);
  const name = asText(result?.title);
  if (result === null || infoHash === null || name === null) return null;
  return { infoHash, name, seeds: asCount(result.seeders) ?? 0, sizeBytes: asCount(result.size), site: 'Bitsearch' };
}

/** Bitsearch (bitsearch.to/api/v1; solidtorrents answers from the same backend, so it is not asked too). */
export function bitsearchIndex(base: string): TorrentIndex {
  const root = base.replace(/\/+$/, '');
  return {
    name: 'bitsearch',
    timeoutMs: TITLE_SEARCH_TIMEOUT_MS,
    async find(query, ctx) {
      const text = titleSearchText(query);
      if (text === null) return unsearchable(query);
      const got = await getIndexJson(ctx, `${root}/search?q=${encodeURIComponent(text)}&sort=seeders`);
      if (!got.ok) return failedAnswer(got);
      const answer = asRecord(got.json);
      const results = asList(answer?.results);
      if (answer?.success !== true || results === null) return { outcome: 'error', detail: 'the answer is not a successful results list', candidates: [] };
      const rows = results.map((r: unknown) => readBitsearchResult(r)).filter((r): r is IndexRow => r !== null);
      return titleSearchAnswer(rows, 'bitsearch', query);
    },
  };
}
```

### Step 8: torrents-csv
**File:** `src/directStream/torrent/find/torrentscsv.ts` (new)
**Code:**
```ts
import { asCount, asList, asRecord, asText, failedAnswer, getIndexJson } from './http.js';
import { TITLE_SEARCH_ROWS, TITLE_SEARCH_TIMEOUT_MS, titleSearchAnswer, titleSearchText, unsearchable } from './titleSearch.js';
import type { IndexRow, TorrentIndex } from './types.js';

function readTorrentsCsvRow(value: unknown): IndexRow | null {
  const row = asRecord(value);
  const infoHash = asText(row?.infohash);
  const name = asText(row?.name);
  if (row === null || infoHash === null || name === null) return null;
  return { infoHash, name, seeds: asCount(row.seeders) ?? 0, sizeBytes: asCount(row.size_bytes), site: 'torrents-csv' };
}

/** torrents-csv (torrents-csv.com/service): a GET search by title. */
export function torrentscsvIndex(base: string): TorrentIndex {
  const root = base.replace(/\/+$/, '');
  return {
    name: 'torrentscsv',
    timeoutMs: TITLE_SEARCH_TIMEOUT_MS,
    async find(query, ctx) {
      const text = titleSearchText(query);
      if (text === null) return unsearchable(query);
      const got = await getIndexJson(ctx, `${root}/search?q=${encodeURIComponent(text)}&size=${TITLE_SEARCH_ROWS}`);
      if (!got.ok) return failedAnswer(got);
      const torrents = asList(asRecord(got.json)?.torrents);
      if (torrents === null) return { outcome: 'error', detail: 'the answer has no torrents list', candidates: [] };
      const rows = torrents.map((t: unknown) => readTorrentsCsvRow(t)).filter((r): r is IndexRow => r !== null);
      return titleSearchAnswer(rows, 'torrentscsv', query);
    },
  };
}
```

### Step 9: Hold title-search listings to the fit (rank)
**File:** `src/directStream/torrent/find/rank.ts:1-4`, `:47-68`, `:75-77`
**Change:** Import the fit; `joinListings` keeps `titleSearch` only when every listing has it; `exclusionOf` applies the fit right after `bad_hash`.

Imports. Before:
```ts
import { normalizeName } from '../../match.js';
import { isUsableHash } from './candidate.js';
import { episodeFitOf, type EpisodeFit } from './release.js';
```
After:
```ts
import { normalizeName } from '../../match.js';
import { isUsableHash } from './candidate.js';
import { episodeFitOf, type EpisodeFit } from './release.js';
import { titleSearchExclusion } from './titleSearch.js';
```

`joinListings`. Before (:58-67):
```ts
  if (group.length === 1) return base;
  return {
    ...base,
    seeds: Math.max(...group.map((c) => c.seeds)),
    sizeBytes: base.sizeBytes ?? group.find((c) => c.sizeBytes !== null)?.sizeBytes ?? null,
    listedBy: [...new Set(group.flatMap((c) => c.listedBy))],
    trackers: [...new Set(group.flatMap((c) => c.trackers))],
    scoped: group.some((c) => c.scoped),
  };
}
```
After:
```ts
  if (group.length === 1) return base;
  const joined: TorrentCandidate = {
    ...base,
    seeds: Math.max(...group.map((c) => c.seeds)),
    sizeBytes: base.sizeBytes ?? group.find((c) => c.sizeBytes !== null)?.sizeBytes ?? null,
    listedBy: [...new Set(group.flatMap((c) => c.listedBy))],
    trackers: [...new Set(group.flatMap((c) => c.trackers))],
    scoped: group.some((c) => c.scoped),
  };
  // An index asked by IMDb id that lists the same info hash vouches for the title: the title-search fit no longer applies.
  if (!group.every((c) => c.titleSearch === true)) delete joined.titleSearch;
  return joined;
}
```

`exclusionOf`. Before (:75-77):
```ts
export function exclusionOf(c: TorrentCandidate, query: TorrentQuery, settings: RankSettings = DEFAULT_RANK_SETTINGS): ExcludeReason | null {
  if (!isUsableHash(c.infoHash)) return 'bad_hash';
  if (!namesTitle(c, query)) return 'other_title';
```
After:
```ts
export function exclusionOf(c: TorrentCandidate, query: TorrentQuery, settings: RankSettings = DEFAULT_RANK_SETTINGS): ExcludeReason | null {
  if (!isUsableHash(c.infoHash)) return 'bad_hash';
  if (c.titleSearch === true) {
    // Only a title search listed it: the name must be the title, then the film's year or the episode's marker.
    const misfit = titleSearchExclusion(c.name, query);
    if (misfit !== null) return misfit;
  }
  if (!namesTitle(c, query)) return 'other_title';
```
**Impact:** candidates from the existing indexes never carry `titleSearch`, so their ranking is unchanged (existing `rank.test.ts` / `findCandidates.test.ts` expectations hold). The last-resort check re-runs `exclusionOf`, so a dub-named title-search release must also pass the fit before it can be a last resort.

### Step 10: Register the three indexes (find.ts)
**File:** `src/directStream/torrent/find/find.ts`, imports (:1-6), `IndexBases` (:67), `DEFAULT_INDEX_BASES` (:75), `defaultIndexes` (:111); quoted as phase 1 leaves them
**Change:**

Imports. Before (as phase 1 leaves them):
```ts
import { apibayIndex } from './apibay.js';
import { normalizeImdbId } from './candidate.js';
import { eztvIndex } from './eztv.js';
import { peerflixIndex } from './peerflix.js';
import { DEFAULT_RANK_SETTINGS, rankCandidates, type RankSettings } from './rank.js';
import { torrentioIndex } from './torrentio.js';
import { torrentsdbIndex } from './torrentsdb.js';
import { ytsIndex } from './yts.js';
```
After:
```ts
import { apibayIndex } from './apibay.js';
import { bitsearchIndex } from './bitsearch.js';
import { normalizeImdbId } from './candidate.js';
import { eztvIndex } from './eztv.js';
import { knabenIndex } from './knaben.js';
import { peerflixIndex } from './peerflix.js';
import { DEFAULT_RANK_SETTINGS, rankCandidates, type RankSettings } from './rank.js';
import { torrentioIndex } from './torrentio.js';
import { torrentscsvIndex } from './torrentscsv.js';
import { torrentsdbIndex } from './torrentsdb.js';
import { ytsIndex } from './yts.js';
```

`IndexBases`: append as the last three members (after phase 1's `torrentsdb`/`peerflix`):
```ts
  /** Asked by title with a JSON POST (find/titleSearch.ts). */
  knaben: string;
  /** Up to and including `/api/v1`. Asked by title. */
  bitsearch: string;
  /** Up to and including `/service`. Asked by title. */
  torrentscsv: string;
```

`DEFAULT_INDEX_BASES`: append as the last three entries:
```ts
  knaben: 'https://api.knaben.org/v1',
  bitsearch: 'https://bitsearch.to/api/v1',
  torrentscsv: 'https://torrents-csv.com/service',
```

`defaultIndexes` doc comment. Before (phase 1's):
```ts
/** Torrentio, apibay, EZTV, TorrentsDB, Peerflix (it asks only for a title made in Spanish), and YTS unless `yts` is false. */
```
After:
```ts
/**
 * Torrentio, apibay, EZTV, TorrentsDB, Peerflix (it asks only for a title made in Spanish), and YTS unless `yts` is
 * false, all asked by IMDb id; then Knaben, Bitsearch and torrents-csv, asked by title (find/titleSearch.ts).
 */
```

`defaultIndexes` body: insert immediately before its final `  return indexes;` (after phase 1's YTS push):
```ts
  // Asked by title, not by IMDb id (titleSearch.ts); each answers `empty` without a request for a title with no name or a film with no year.
  indexes.push(
    knabenIndex(bases.knaben ?? DEFAULT_INDEX_BASES.knaben),
    bitsearchIndex(bases.bitsearch ?? DEFAULT_INDEX_BASES.bitsearch),
    torrentscsvIndex(bases.torrentscsv ?? DEFAULT_INDEX_BASES.torrentscsv),
  );
```
**Impact:** every `findCandidates` on the default indexes now asks the three too (Step 12 updates the tests that pin the default attempt list). `trending/sources.ts` reads only `DEFAULT_INDEX_BASES.apibay`/`eztv` and is unaffected.

### Step 11: Barrel and settings
**File:** `src/directStream/torrent/find/index.ts` (end of file, after phase 1's lines)
**Code (append):**
```ts
export * from './titleSearch.js';
export * from './knaben.js';
export * from './bitsearch.js';
export * from './torrentscsv.js';
```

**File:** `src/config.ts:336` — append the three names at the **end** of `TORRENT_INDEX_NAMES` (after phase 1's); with phase 1 having appended `'torrentsdb', 'peerflix'` after `'yts'` the line reads:
```ts
export const TORRENT_INDEX_NAMES = ['torrentio', 'apibay', 'eztv', 'yts', 'torrentsdb', 'peerflix', 'knaben', 'bitsearch', 'torrentscsv'] as const
```
**File:** `src/config.ts:357-362` — append to `TORRENT_INDEX_URL_KEYS` after its last entry:
```ts
  knaben: 'NOTESD_TORRENT_KNABEN_URL',
  bitsearch: 'NOTESD_TORRENT_BITSEARCH_URL',
  torrentscsv: 'NOTESD_TORRENT_TORRENTSCSV_URL',
```
**File:** `src/config.ts:1197` (loadConfig's header comment; phase 1 leaves it as it is today, and phase 3 inserts its own line after :1194, so :1195-1196 stay unchanged between the two hunks). Replace this one line, and only it:
```ts
 * NOTESD_TORRENT_APIBAY_URL, NOTESD_TORRENT_EZTV_URL, NOTESD_TORRENT_YTS_URL (a number below 1 or a non-http address throw ConfigError),
```
with (phase 1's two keys and this phase's three):
```ts
 * NOTESD_TORRENT_APIBAY_URL, NOTESD_TORRENT_EZTV_URL, NOTESD_TORRENT_YTS_URL, NOTESD_TORRENT_TORRENTSDB_URL, NOTESD_TORRENT_PEERFLIX_URL,
 * NOTESD_TORRENT_KNABEN_URL, NOTESD_TORRENT_BITSEARCH_URL, NOTESD_TORRENT_TORRENTSCSV_URL (a number below 1 or a non-http address throw ConfigError),
```
**Impact:** `parseTorrentFinder` reads the three keys without code change (it loops over `TORRENT_INDEX_NAMES`); `indexesOf` (`source.ts`) drops any of them set `off` by name, also without change.

### Step 12: Tests and fixtures
**Fixtures** — copy the recorded answers byte for byte:
```sh
S=.workflows/analyze/20261119-025431-K7QD-samples
cp "$S/knaben.json"    tests/fixtures/torrent/knaben-shawshank.json
cp "$S/bitsearch.json" tests/fixtures/torrent/bitsearch-shawshank.json
cp "$S/tcsv.json"      tests/fixtures/torrent/torrentscsv-shawshank.json
```

**File:** `tests/unit/directStream/torrent/find/titleSearch.test.ts` (new)
```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bitsearchIndex } from '../../../../../src/directStream/torrent/find/bitsearch.js';
import { candidateFrom } from '../../../../../src/directStream/torrent/find/candidate.js';
import { defaultIndexes, findCandidates, TORRENT_INDEX_USER_AGENT } from '../../../../../src/directStream/torrent/find/find.js';
import { knabenIndex } from '../../../../../src/directStream/torrent/find/knaben.js';
import { rankCandidates } from '../../../../../src/directStream/torrent/find/rank.js';
import { titleSearchAnswer, titleSearchExclusion, titleSearchText } from '../../../../../src/directStream/torrent/find/titleSearch.js';
import { torrentscsvIndex } from '../../../../../src/directStream/torrent/find/torrentscsv.js';
import type { FetchLike, IndexContext, TorrentIndex, TorrentQuery } from '../../../../../src/directStream/torrent/find/types.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/torrent');
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8');

const SHAWSHANK: TorrentQuery = { kind: 'movie', imdbId: 'tt0111161', title: 'The Shawshank Redemption', year: 1994, originalLanguage: 'en' };
const DUNE: TorrentQuery = { kind: 'movie', imdbId: 'tt1160419', title: 'Dune', year: 2021, originalLanguage: 'en' };
const BREAKING_BAD: TorrentQuery = { kind: 'tv', imdbId: 'tt0903747', season: 1, episode: 1, title: 'Breaking Bad', year: 2008, originalLanguage: 'en' };

const KNABEN = 'https://api.knaben.org/v1';
const BITSEARCH = (q: string): string => `https://bitsearch.to/api/v1/search?q=${encodeURIComponent(q)}&sort=seeders`;
const TCSV = (q: string): string => `https://torrents-csv.com/service/search?q=${encodeURIComponent(q)}&size=50`;
const TORRENTIO_SHAWSHANK = 'https://torrentio.strem.fun/stream/movie/tt0111161.json';
const APIBAY_SHAWSHANK = 'https://apibay.org/q.php?q=tt0111161';
const YTS_SHAWSHANK = 'https://yts.mx/api/v2/list_movies.json?query_term=tt0111161';
const NO_YTS = '{"status":"ok","data":{"movie_count":0}}';
const TITLE_INDEX_NAMES = ['knaben', 'bitsearch', 'torrentscsv'];
const E0D0 = 'e0d00667650aba9ee05aacbbbd8b55ea8a51f534';
const YIFY_STREAM = { name: 'Torrentio\n1080p', title: 'The Shawshank Redemption 1994 1080p BrRip\n👤 700 💾 1.6 GB ⚙️ ThePirateBay', infoHash: E0D0.toUpperCase(), behaviorHints: {} };

interface Call {
  url: string;
  method: string;
  userAgent: string | null;
  body: string | null;
}
type Route = () => Response | Promise<Response>;
function fakeFetch(routes: Record<string, Route>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method ?? 'GET', userAgent: init.headers.get('user-agent'), body: init.body ?? null });
    const route = routes[url];
    if (route === undefined) throw new TypeError(`fetch failed: no route for ${url}`);
    return route();
  };
  return { fetch, calls };
}
const body = (text: string, status = 200, headers: Record<string, string> = {}): Route => () => new Response(text, { status, headers });
const json = (value: unknown): Route => body(JSON.stringify(value));
const hash = (n: number): string => n.toString(16).padStart(40, 'b');
const titleIndexes = (): TorrentIndex[] => defaultIndexes().filter((i) => TITLE_INDEX_NAMES.includes(i.name));
const knabenHit = (title: string, h: string, seeders = 40): Record<string, unknown> => ({
  hash: h.toUpperCase(),
  title,
  bytes: 600_000_000,
  seeders,
  magnetUrl: `magnet:?xt=urn:btih:${h}&tr=udp%3A%2F%2Ftracker.example%3A1337%2Fannounce`,
  tracker: 'The Pirate Bay',
});
const bitsearchResult = (title: string, h: string, seeders = 40): Record<string, unknown> => ({ infohash: h, title, size: 600_000_000, seeders });
const ctxAnswering = (answer: string): IndexContext => ({ signal: new AbortController().signal, fetch: async () => new Response(answer, { status: 200 }) });

describe('the title-search query', () => {
  it('asks a film by title and year, an episode by title and SxxEyy within its season, and nothing without a name or a film year', () => {
    expect(titleSearchText(SHAWSHANK)).toBe('The Shawshank Redemption 1994');
    expect(titleSearchText(BREAKING_BAD)).toBe('Breaking Bad S01E01');
    expect(titleSearchText({ kind: 'tv', imdbId: 'tt0388629', title: 'One Piece', season: 21, episode: 1000, absoluteEpisode: 1000, alt: { season: 21, episode: 109 } })).toBe('One Piece S21E109');
    expect(titleSearchText({ kind: 'movie', imdbId: 'tt0111161', title: null, originalTitle: null, year: 1994 })).toBeNull();
    expect(titleSearchText({ kind: 'movie', imdbId: 'tt0111161', title: 'The Shawshank Redemption', year: null })).toBeNull();
  });
});

describe('the title-search fit', () => {
  it('keeps the title followed by the year (one either way), after a group or site prefix, and leaves out another title or year', () => {
    expect(titleSearchExclusion('The Shawshank Redemption (1994) 1080p BrRip - 1.6GB -YIFY', SHAWSHANK)).toBeNull();
    expect(titleSearchExclusion('www.UIndex.org    -    The Shawshank Redemption 1994 REPACK 1080p BluRay x265-YAWNTiC', SHAWSHANK)).toBeNull();
    expect(titleSearchExclusion('[YTS.MX] Shawshank Redemption 1995 720p', SHAWSHANK)).toBeNull();
    expect(titleSearchExclusion('Dune Extended 2021 2160p', DUNE)).toBeNull();
    expect(titleSearchExclusion('Dune 1984 1080p BluRay x264', DUNE)).toBe('other_year');
    expect(titleSearchExclusion('Dune 1080p WEB-DL', DUNE)).toBe('other_year');
    expect(titleSearchExclusion('Dune Part Two 2024 1080p WEB-DL', DUNE)).toBe('other_title');
    expect(titleSearchExclusion('Children of Dune 2003 720p', DUNE)).toBe('other_title');
  });

  it('keeps a series title followed by its season or episode marker, and leaves out another show that starts with the same words', () => {
    expect(titleSearchExclusion('Breaking.Bad.S01E01.720p.HDTV.x264', BREAKING_BAD)).toBeNull();
    expect(titleSearchExclusion('Breaking Bad (2008) Season 1 Complete 1080p', BREAKING_BAD)).toBeNull();
    expect(titleSearchExclusion('Breaking Bad Insider Podcast S01E01', BREAKING_BAD)).toBe('other_title');
    expect(titleSearchExclusion('Breaking Bad 720p', BREAKING_BAD)).toBe('other_title');
  });

  it('applies only while no index asked by IMDb id lists the same torrent', () => {
    const wrongYear = { infoHash: hash(1), name: 'Dune 1984 1080p BluRay x264', seeds: 50, sizeBytes: 600_000_000 };
    const byTitle = titleSearchAnswer([wrongYear], 'bitsearch', DUNE).candidates;
    expect(rankCandidates(byTitle, DUNE).excluded.map((e) => e.reason)).toEqual(['other_year']);
    const both = rankCandidates([...byTitle, candidateFrom(wrongYear, 'torrentio', DUNE)], DUNE);
    expect(both.kept.map((c) => [c.infoHash, c.listedBy, c.titleSearch])).toEqual([[hash(1), ['bitsearch', 'torrentio'], undefined]]);
  });
});

describe('the title-search indexes', () => {
  it('asks Knaben, Bitsearch and torrents-csv by title side by side with the IMDb-keyed indexes, one attempt each, joined by info hash', async () => {
    const { fetch, calls } = fakeFetch({
      [TORRENTIO_SHAWSHANK]: json({ streams: [YIFY_STREAM] }),
      [APIBAY_SHAWSHANK]: body('[]'),
      [YTS_SHAWSHANK]: body(NO_YTS),
      [KNABEN]: body(fixture('knaben-shawshank.json')),
      [BITSEARCH('The Shawshank Redemption 1994')]: body(fixture('bitsearch-shawshank.json')),
      [TCSV('The Shawshank Redemption 1994')]: body(fixture('torrentscsv-shawshank.json')),
    });
    const found = await findCandidates(SHAWSHANK, { fetch });
    const names = found.indexes.map((a) => a.index);
    expect(new Set(names).size).toBe(names.length);
    expect(found.indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ index: 'torrentio', outcome: 'ok', listed: 1 }),
        expect.objectContaining({ index: 'knaben', outcome: 'ok', listed: 3 }),
        expect.objectContaining({ index: 'bitsearch', outcome: 'ok', listed: 3 }),
        expect.objectContaining({ index: 'torrentscsv', outcome: 'ok', listed: 3 }),
      ]),
    );
    const knaben = calls.filter((c) => c.url === KNABEN);
    expect(knaben).toHaveLength(1);
    expect(knaben[0]?.method).toBe('POST');
    expect(JSON.parse(knaben[0]?.body ?? '{}')).toMatchObject({ search_field: 'title', query: 'The Shawshank Redemption 1994', order_by: 'seeders' });
    expect(calls.every((c) => c.userAgent === TORRENT_INDEX_USER_AGENT)).toBe(true);
    expect(found.candidates.map((c) => c.infoHash).sort()).toEqual(
      ['9d03cb643f0a22c2aa7cf5479da2b81d19300362', 'b111a115d5d68e7ccbe10f1c160e64ffb702f15a', 'c3da9a3dc2ce14d0d4fc0e87d1b2023502f8dcd6', 'de45655f107904526620d21c3856ac29a5fd7e49', E0D0].sort(),
    );
    const yify = found.candidates.find((c) => c.infoHash === E0D0);
    expect([...(yify?.listedBy ?? [])].sort()).toEqual(['bitsearch', 'knaben', 'torrentio', 'torrentscsv']);
    expect(yify?.trackers).toEqual(expect.arrayContaining(['udp://vito-tracker.space:6969/announce']));
  });

  it('asks an episode by title and SxxEyy and keeps only that episode or its season pack', async () => {
    const { fetch, calls } = fakeFetch({
      [KNABEN]: json({
        hits: [
          knabenHit('Breaking.Bad.S01E01.720p.HDTV.x264', hash(1)),
          knabenHit('Breaking.Bad.S01E02.720p.HDTV.x264', hash(2), 90),
          knabenHit('Breaking Bad Season 1 Complete 1080p BluRay x264', hash(3)),
          knabenHit('Breaking Bad Insider Podcast S01E01', hash(4)),
        ],
        total: { relation: 'eq', value: 4 },
      }),
      [BITSEARCH('Breaking Bad S01E01')]: json({ success: true, results: [] }),
      [TCSV('Breaking Bad S01E01')]: json({ torrents: [] }),
    });
    const found = await findCandidates(BREAKING_BAD, { fetch, indexes: titleIndexes() });
    expect(JSON.parse(calls.find((c) => c.url === KNABEN)?.body ?? '{}')).toMatchObject({ query: 'Breaking Bad S01E01' });
    expect(found.candidates.map((c) => c.infoHash).sort()).toEqual([hash(1), hash(3)].sort());
    expect(Object.fromEntries(found.excluded.map((e) => [e.infoHash, e.reason]))).toEqual({ [hash(2)]: 'other_episode', [hash(4)]: 'other_title' });
  });

  it('sends no request by title for a title with no name or a film with no year', async () => {
    const { fetch, calls } = fakeFetch({});
    const noName = await findCandidates({ kind: 'movie', imdbId: 'tt0111161', title: null, originalTitle: null, year: 1994 }, { fetch, indexes: titleIndexes() });
    const noYear = await findCandidates({ kind: 'movie', imdbId: 'tt0111161', title: 'The Shawshank Redemption', year: null }, { fetch, indexes: titleIndexes() });
    expect(calls).toEqual([]);
    for (const found of [noName, noYear]) {
      expect(found.indexes.map((a) => [a.index, a.outcome])).toEqual(TITLE_INDEX_NAMES.map((n) => [n, 'empty']));
      expect(found.indexes.every((a) => a.detail.startsWith('not asked'))).toBe(true);
    }
  });

  it('leaves out another title and another year of a film by name, with the reason, and never offers them', async () => {
    const { fetch } = fakeFetch({
      [KNABEN]: json({ hits: [] }),
      [BITSEARCH('Dune 2021')]: json({
        success: true,
        results: [
          bitsearchResult('Dune.2021.1080p.WEB-DL.x264', hash(1)),
          bitsearchResult('Dune 1984 1080p BluRay x264', hash(2), 400),
          bitsearchResult('Dune Part Two 2024 1080p WEB-DL', hash(3), 900),
          bitsearchResult('Dune 1984 1080p BluRay Hindi Dubbed', hash(4), 300),
        ],
      }),
      [TCSV('Dune 2021')]: json({ torrents: [] }),
    });
    const found = await findCandidates(DUNE, { fetch, indexes: titleIndexes() });
    expect(found.candidates.map((c) => c.infoHash)).toEqual([hash(1)]);
    expect(found.lastResort).toEqual([]);
    expect(Object.fromEntries(found.excluded.map((e) => [e.infoHash, e.reason]))).toEqual({ [hash(2)]: 'other_year', [hash(3)]: 'other_title', [hash(4)]: 'other_year' });
  });

  it('records a bot check, a timeout and a failure per title-search index, asks each once as notesd, and still answers the others', async () => {
    const { fetch, calls } = fakeFetch({
      [TORRENTIO_SHAWSHANK]: json({ streams: [YIFY_STREAM] }),
      [APIBAY_SHAWSHANK]: body('[]'),
      [YTS_SHAWSHANK]: body(NO_YTS),
      [KNABEN]: body(fixture('cloudflare-challenge.html'), 403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' }),
      [BITSEARCH('The Shawshank Redemption 1994')]: () => new Promise<Response>(() => {}),
      [TCSV('The Shawshank Redemption 1994')]: body('', 500),
    });
    const found = await findCandidates(SHAWSHANK, { fetch, timeoutMs: 50 });
    expect(found.indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ index: 'knaben', outcome: 'bot_check', listed: 0 }),
        expect.objectContaining({ index: 'bitsearch', outcome: 'error', detail: expect.stringMatching(/^timed out after /), listed: 0 }),
        expect.objectContaining({ index: 'torrentscsv', outcome: 'error', detail: 'HTTP 500', listed: 0 }),
      ]),
    );
    expect(found.candidates.map((c) => c.infoHash)).toEqual([E0D0]);
    const knaben = calls.filter((c) => c.url === KNABEN);
    expect(knaben).toHaveLength(1);
    expect(knaben[0]?.userAgent).toBe(TORRENT_INDEX_USER_AGENT);
  });

  it('reads each index on its own: the recorded answers and the error shapes', async () => {
    expect((await knabenIndex('https://k.example/').find(SHAWSHANK, ctxAnswering(fixture('knaben-shawshank.json')))).candidates.map((c) => c.site)).toEqual(['The Pirate Bay', 'The Pirate Bay', 'The Pirate Bay']);
    expect((await bitsearchIndex('https://b.example').find(SHAWSHANK, ctxAnswering(fixture('bitsearch-shawshank.json')))).candidates.every((c) => c.titleSearch === true && c.index === 'bitsearch')).toBe(true);
    expect((await torrentscsvIndex('https://t.example').find(SHAWSHANK, ctxAnswering(fixture('torrentscsv-shawshank.json')))).candidates.map((c) => c.seeds)).toEqual([627, 187, 153]);
    expect((await bitsearchIndex('https://b.example').find(SHAWSHANK, ctxAnswering('{"success":false}'))).outcome).toBe('error');
    expect((await knabenIndex('https://k.example').find(SHAWSHANK, ctxAnswering('{}'))).outcome).toBe('error');
    expect((await torrentscsvIndex('https://t.example').find(SHAWSHANK, ctxAnswering('{"torrents":[]}'))).outcome).toBe('empty');
  });
});
```
Note for the implementer: `-t "by title"` (J1) matches the four tests whose names contain "by title" (the query-text test, the side-by-side film test, the episode test, "sends no request by title …"); `-t "leaves out|title-search fit"` (J2) matches the three fit tests and the Dune test.

**File:** `tests/unit/directStream/torrent/find/findCandidates.test.ts`. These tests use the default indexes, which now include the three. Each gets the routes it needs, and its pinned attempt list gets the three entries **appended after whatever entries phase 1 left**:

(a) Insert immediately after the line `const NO_YTS = '{"status":"ok","data":{"movie_count":0}}';`:
```ts
// The title-search indexes (WIDER_TORRENT_SOURCES phase 2) answering nothing, for the tests about the IMDb-keyed ones.
const KNABEN = 'https://api.knaben.org/v1';
const BITSEARCH_FILM = 'https://bitsearch.to/api/v1/search?q=Sintel%202010&sort=seeders';
const BITSEARCH_EPISODE = 'https://bitsearch.to/api/v1/search?q=Breaking%20Bad%20S01E01&sort=seeders';
const TCSV_FILM = 'https://torrents-csv.com/service/search?q=Sintel%202010&size=50';
const TCSV_EPISODE = 'https://torrents-csv.com/service/search?q=Breaking%20Bad%20S01E01&size=50';
const NOTHING_BY_TITLE_FILM: Record<string, Route> = { [KNABEN]: body('{"hits":[]}'), [BITSEARCH_FILM]: body('{"success":true,"results":[]}'), [TCSV_FILM]: body('{"torrents":[]}') };
const NOTHING_BY_TITLE_EPISODE: Record<string, Route> = { [KNABEN]: body('{"hits":[]}'), [BITSEARCH_EPISODE]: body('{"success":true,"results":[]}'), [TCSV_EPISODE]: body('{"torrents":[]}') };
```
(b) `'asks Torrentio, apibay, TorrentsDB and YTS for a film by its IMDb id and answers ranked candidates'` (phase 1's name for it): add `...NOTHING_BY_TITLE_FILM,` as the last entry of the `fakeFetch({...})` routes; append `KNABEN, BITSEARCH_FILM, TCSV_FILM` to the array in `expect(calls.map((c) => c.url).sort()).toEqual([...].sort())`; append to the `found.indexes.map((a) => [a.index, a.outcome, a.listed])` expectation:
```ts
      ['knaben', 'empty', 0],
      ['bitsearch', 'empty', 0],
      ['torrentscsv', 'empty', 0],
```
(c) `'asks Torrentio, apibay and EZTV for an episode and keeps only that episode or a pack that holds it'`: add `...NOTHING_BY_TITLE_EPISODE,` to the routes; append to the `[a.index, a.outcome]` expectation:
```ts
      ['knaben', 'empty'],
      ['bitsearch', 'empty'],
      ['torrentscsv', 'empty'],
```
(d) `'records an index that times out or answers a bot check and goes on with the others'`: add `...NOTHING_BY_TITLE_FILM,` to the routes; append to the `found.indexes` expectation:
```ts
      expect.objectContaining({ index: 'knaben', outcome: 'empty', listed: 0 }),
      expect.objectContaining({ index: 'bitsearch', outcome: 'empty', listed: 0 }),
      expect.objectContaining({ index: 'torrentscsv', outcome: 'empty', listed: 0 }),
```
(e) `'records an index that fails or answers an error status, and answers nothing rather than throwing'` (no title-search routes: each fails): append to the `found.indexes` expectation:
```ts
      expect.objectContaining({ index: 'knaben', outcome: 'error', detail: expect.stringContaining('fetch failed') }),
      expect.objectContaining({ index: 'bitsearch', outcome: 'error', detail: expect.stringContaining('fetch failed') }),
      expect.objectContaining({ index: 'torrentscsv', outcome: 'error', detail: expect.stringContaining('fetch failed') }),
```
(f) phase 1's `'asks Peerflix for a title made in Spanish and keeps what it lists'` (no title-search routes: `Pan's Labyrinth 2006` is unrouted, so each fails): append to the `[a.index, a.outcome]` expectation, after `['yts', 'empty'],`:
```ts
      ['knaben', 'error'],
      ['bitsearch', 'error'],
      ['torrentscsv', 'error'],
```
`found.candidates` stays exactly Peerflix's one row.
(g) phase 1's `"records an add-on provider's bot check, timeout or failure and still answers the other indexes' candidates"`: in the first run's `found.indexes` `toEqual`, after the `yts` entry, append:
```ts
      expect.objectContaining({ index: 'knaben', outcome: 'error', listed: 0 }),
      expect.objectContaining({ index: 'bitsearch', outcome: 'error', listed: 0 }),
      expect.objectContaining({ index: 'torrentscsv', outcome: 'error', listed: 0 }),
```
Its second run reads attempts with `find` and its candidates stay `[hash(1)]`: unchanged.
The other tests in the file pass explicit `indexes`, or do not pin the attempt list or the whole candidate list (phase 1's "asks TorrentsDB and joins …" and "sends Peerflix no request …" read attempts with `find`); they need no change.

**File:** `tests/unit/directStream/torrent/find/addonSwitches.test.ts` (phase 1's). In `'are among the default indexes, in the order they are asked'` the expected list becomes:
```ts
['torrentio', 'apibay', 'eztv', 'torrentsdb', 'peerflix', 'yts', 'knaben', 'bitsearch', 'torrentscsv']
```
In `'get no request when set off, even for a title made in Spanish'`, `indexes.map((i) => i.name)` becomes `['torrentio', 'apibay', 'eztv', 'yts', 'knaben', 'bitsearch', 'torrentscsv']` and `found.indexes.map((a) => a.index)` becomes `['torrentio', 'apibay', 'yts', 'knaben', 'bitsearch', 'torrentscsv']` (the recording fetch answers every request, so nothing reaches a network). `'are asked at the addresses the settings give'` uses `arrayContaining` and is unchanged.

**File:** `tests/unit/config.torrentFinder.test.ts` — add after the test `'reads the seed floor, the size cap in bytes, …'`:
```ts
  it('reads the title-search indexes: an address replaces the finder\'s, off never asks it', () => {
    expect(
      parseTorrentFinder({
        NOTESD_TORRENT_KNABEN_URL: 'off',
        NOTESD_TORRENT_BITSEARCH_URL: 'OFF',
        NOTESD_TORRENT_TORRENTSCSV_URL: 'http://127.0.0.1:4555/',
      }),
    ).toEqual({ indexes: { knaben: null, bitsearch: null, torrentscsv: 'http://127.0.0.1:4555' } });
    expect(() => parseTorrentFinder({ NOTESD_TORRENT_KNABEN_URL: 'api.knaben.org' })).toThrow(ConfigError);
  });
```

### Step 13: Configuration reference rows
**File:** `docs/guide/reference/configuration.md` — insert immediately before the row that starts `| `NOTESD_TORRENT_1337X_ORIGIN` |` (today :181; after phase 1's rows):
```md
| `NOTESD_TORRENT_KNABEN_URL` | the finder's own (Knaben, `https://api.knaben.org/v1`) | Address of the Knaben index, asked by title (a film by title and year, an episode by title and `SxxEyy`) with one JSON POST; `off` never asks it. `verify.sh` sets it `off`. See [streaming.md](../streaming.md#playing-from-a-torrent). |
| `NOTESD_TORRENT_BITSEARCH_URL` | the finder's own (Bitsearch, `https://bitsearch.to/api/v1`) | Address of the Bitsearch index, asked by title the same way; `off` never asks it. |
| `NOTESD_TORRENT_TORRENTSCSV_URL` | the finder's own (torrents-csv, `https://torrents-csv.com/service`) | Address of the torrents-csv index, asked by title the same way; `off` never asks it. |
```
**Impact:** `tests/unit/docs/reference.test.ts` needs a row for every variable the code names.

### Step 14: The streaming guide
**File:** `docs/guide/streaming.md`, section "Playing from a torrent" — insert immediately before the bullet that starts `- **Off.** With `NOTESD_TORRENT=off` nothing above happens` (≈:1808):
```md
- **Indexes asked by title.** Knaben, Bitsearch and torrents-csv hold no IMDb ids, so the finder asks them by name, at
  the same time as the others: a film as its title and year (`Dune 2021`), an episode as its title and `SxxEyy`
  (numbered within the season when TMDB's number runs on across seasons). Each is its own attempt (`Index: knaben`,
  `Index: bitsearch`, `Index: torrentscsv`) with its own 8 s and its own address setting (`off` never asks it), and none
  is asked for a title with no name or a film with no year. A name search lists anything whose name holds the words, so
  a release only these three list must start with the title (after a `[group]` or `www.site - ` prefix) and go straight
  on to the film's year, give or take one (an edition word such as `Extended` may sit between), or to the episode's
  season or episode marker: for Dune (2021), `Dune Part Two 2024` is left out as `other_title`, `Dune 1984` or a release
  that names no year as `other_year`, and another episode as `other_episode`. A release an index asked by IMDb id also
  lists is held only to the usual checks. A bot check, a failure or a timeout is that index's attempt and nothing more.
```

### Step 15: The verify harness never asks a real title-search index
**File:** `.claude/skills/verify-notesd/scripts/verify.sh`, the index block as phase 1 leaves it. Phase 1's test (`tests/unit/config.torrentFinder.test.ts`, "is named by verify.sh for every index, in both of its index lines") requires every `TORRENT_INDEX_URL_KEYS` value to appear at least twice, so each key goes into **both** branches (a single line before `# NOTESD_TRENDING=off` would name each once and fail it).

`--torrent` branch. Before (phase 1's):
```sh
      NOTESD_TORRENT_APIBAY_URL=off NOTESD_TORRENT_EZTV_URL=off NOTESD_TORRENT_YTS_URL=off NOTESD_TORRENT_MIN_SEEDS=1
      NOTESD_TORRENT_TORRENTSDB_URL=off NOTESD_TORRENT_PEERFLIX_URL=off
    )
```
After:
```sh
      NOTESD_TORRENT_APIBAY_URL=off NOTESD_TORRENT_EZTV_URL=off NOTESD_TORRENT_YTS_URL=off NOTESD_TORRENT_MIN_SEEDS=1
      NOTESD_TORRENT_TORRENTSDB_URL=off NOTESD_TORRENT_PEERFLIX_URL=off
      NOTESD_TORRENT_KNABEN_URL=off NOTESD_TORRENT_BITSEARCH_URL=off NOTESD_TORRENT_TORRENTSCSV_URL=off
    )
```
`else` branch. Before (phase 1's):
```sh
    env+=(NOTESD_TORRENT_TORRENTIO_URL=off NOTESD_TORRENT_APIBAY_URL=off NOTESD_TORRENT_EZTV_URL=off NOTESD_TORRENT_YTS_URL=off)
    env+=(NOTESD_TORRENT_TORRENTSDB_URL=off NOTESD_TORRENT_PEERFLIX_URL=off)
  fi
```
After:
```sh
    env+=(NOTESD_TORRENT_TORRENTIO_URL=off NOTESD_TORRENT_APIBAY_URL=off NOTESD_TORRENT_EZTV_URL=off NOTESD_TORRENT_YTS_URL=off)
    env+=(NOTESD_TORRENT_TORRENTSDB_URL=off NOTESD_TORRENT_PEERFLIX_URL=off)
    # The title-search indexes are never asked by a throwaway daemon: the fake index answers only Torrentio's shape.
    env+=(NOTESD_TORRENT_KNABEN_URL=off NOTESD_TORRENT_BITSEARCH_URL=off NOTESD_TORRENT_TORRENTSCSV_URL=off)
  fi
```
**Impact:** every `up` mode pins the three `off`; `npx vitest run tests/unit/config.torrentFinder.test.ts` passes with the three new keys. Phase 3's verify.sh edit is in the base `env=(...)` array (:262), far from this block.

### Step 16: Feature map
**File:** `.claude/skills/verify-notesd/features/direct-streaming.md`, section "Playing from a torrent" — insert immediately before the bullet that starts `- Throwaway daemon, a torrent run (`$V up --web --torrent`, note RUN)` (after phase 1, that is directly after phase 1's "The Stremio add-on providers beside Torrentio" bullet):
```md
- Indexes asked by title (Knaben, Bitsearch, torrents-csv: `Index: knaben`, `Index: bitsearch`, `Index: torrentscsv`):
  a film by title and year, an episode by title and `SxxEyy`; a release only they list must be the title followed by
  the year (one either way) or the episode's marker, else `other_title` / `other_year` / `other_episode` in `excluded`;
  a bot check, timeout or failure is that index's attempt only. Proven by
  `npx vitest run tests/unit/directStream/torrent/find/titleSearch.test.ts tests/unit/config.torrentFinder.test.ts`
  over the answers recorded on 2026-11-19 (`tests/fixtures/torrent/{knaben,bitsearch,torrentscsv}-shawshank.json`).
  Every throwaway daemon pins the three `off` (the fake index is Torrentio-shaped only): a `--torrent` run's play
  names no `Index: knaben`, `Index: bitsearch` or `Index: torrentscsv` attempt.
```

### Step 17: CLAUDE.md
**File:** `CLAUDE.md`, Architecture → Direct streaming — insert immediately before the line that starts `  - A torrent is chosen by its swarm, not by the index's seed count` (today :116; after phase 1, directly after phase 1's "The JSON torrent indexes are asked by IMDb id side by side" bullet). Phase 3 inserts after the `/update-cloud-source <magnet>` bullet (today :120), four unchanged lines further down:
```md
  - Knaben, Bitsearch and torrents-csv (`torrent/find/knaben.ts`, `bitsearch.ts`, `torrentscsv.ts`) are asked by title, not IMDb id: a film as title + year, an episode as title + `SxxEyy` (`titleSearchText`, `find/titleSearch.ts`). A release only they list carries `titleSearch` and must pass `titleSearchExclusion` in `rank.ts` (the title, then the year ±1 or the episode's marker), else `other_title` / `other_year`; never loosen it to a substring test. Each has its own `NOTESD_TORRENT_<NAME>_URL` (`off`); `verify.sh` pins all three `off`.
```

## Principles applied

- Laziness protocol: one shared helper (`titleSearch.ts`), not a fit per module; the episode check reuses rank's existing `other_episode` path for unscoped listings; no new settings code (`parseTorrentFinder` and `indexesOf` are already generic over `TORRENT_INDEX_NAMES`); Bitsearch asked, solidtorrents (same backend) not.
- Subtract before you add: `getIndexJson`'s answer reading is factored into one `readIndexJson` shared by the GET and the new POST, instead of a copy in `postIndexJson`.
- Make illegal states unrepresentable: `titleSearch?: true` has no `false` state, and `joinListings` drops it unless every listing carries it, so a torrent an IMDb-keyed index vouches for can never be held to the stricter fit; the index method is typed `'GET' | 'POST'`, not `string`.
- Boundary discipline: the fit runs once, in `exclusionOf` where every other exclusion lives, not inside each index (filtering there would hide the reason from `excluded`, which R1.2 needs); the query text is built once by `titleSearchText`.
- Test behavior, not implementation: the new tests drive `findCandidates` / the index `find` with a fake fetch and assert attempts, candidates, `excluded` reasons and the requests actually sent; nothing asserts on private calls.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` (includes `tests/unit/docs/reference.test.ts`); also `npm run docs:check`
**Proof:**
- Harness: `.claude/skills/verify-notesd` (unit journeys with injected fetch, no network; the R1.4 journey on a throwaway daemon, `verify.sh up --torrent`, fake index and fake resolver)
- Feature-map entries: `.claude/skills/verify-notesd/features/direct-streaming.md` ("Playing from a torrent")
- Journeys:
  - **J1** · traces R1.1 — `npx vitest run tests/unit/directStream/torrent/find/titleSearch.test.ts -t "by title"` → passes when every matching test passes (the query-text test, the side-by-side film test, the episode test and the no-request test): on the default index list each of `knaben`/`bitsearch`/`torrentscsv` has exactly one attempt under its own name (`ok`, `listed` 3) beside `torrentio`'s; Knaben got one POST whose JSON body has `query: "The Shawshank Redemption 1994"`; every request carried `TORRENT_INDEX_USER_AGENT`; the YIFY torrent `e0d0…f534` is one candidate with `listedBy` `bitsearch, knaben, torrentio, torrentscsv`; the episode is asked as `"Breaking Bad S01E01"`; a nameless or yearless film sends zero requests and gets three `empty` "not asked" attempts
  - **J2** · traces R1.2 — `npx vitest run tests/unit/directStream/torrent/find/titleSearch.test.ts -t "leaves out|title-search fit"` → passes when the four matching tests pass: for Dune (2021) `found.candidates` is only `Dune.2021…`, `lastResort` is `[]`, and `excluded` maps `Dune 1984` → `other_year`, `Dune Part Two 2024` → `other_title`, the dubbed `Dune 1984` → `other_year`; a wrong-year listing that torrentio also lists is kept with `titleSearch` `undefined`; the episode case (`S01E02` → `other_episode`, podcast → `other_title`) is asserted in J1's episode test
  - **J3** · traces R1.3 — `npx vitest run tests/unit/directStream/torrent/find/titleSearch.test.ts -t "records a bot check"` → passes when the attempts hold `knaben` `bot_check`, `bitsearch` `error` "timed out after …", `torrentscsv` `error` "HTTP 500", `found.candidates` is still `[e0d0…f534]` from torrentio, and Knaben received exactly one request, with notesd's User-Agent
  - **J4** · traces R1.4 — `npx vitest run tests/unit/config.torrentFinder.test.ts -t "title-search"`, then `V=.claude/skills/verify-notesd/scripts/verify.sh; OUT=$($V up --torrent); RUN=$(sed -n 's/^RUN=//p' <<<"$OUT"); D=~/.local/state/notesd-verify/$RUN; echo no_source > $D/direct/mode; echo ok > $D/torrent/index-mode; $V api $RUN POST /api/stream/play '{"kind":"movie","tmdb_id":467905}' | sed '1,/^< HTTP /d' | jq -c '[.attempts[].provider | select(startswith("Index: "))]'` → passes when the unit test passes (`off`/`OFF` → `null`, an address kept, a bare host rejected) and the daemon's play (run with `NOTESD_TORRENT_{KNABEN,BITSEARCH,TORRENTSCSV}_URL=off` from `verify.sh`) lists `"Index: torrentio"` and none of `"Index: knaben"`, `"Index: bitsearch"`, `"Index: torrentscsv"`. An index set `off` is never built, so it has no attempt and sends no request. Then `$V down $RUN` (after the neighbor check below)
- Neighbor check: the IMDb-keyed finder and the torrent play path. `npx vitest run tests/unit/directStream/torrent/find tests/unit/directStream/torrentSource.test.ts tests/unit/directStream/torrentRotation.test.ts tests/unit/directStream/torrent/findSites.test.ts` passes unchanged in meaning; on the J4 run, before `down`, `.claude/skills/verify-notesd/scripts/direct-stream/torrent.sh $RUN fallback named` ends with `torrent: PASS (fallback named)`
- Cost: none (no LLM turn, no real index, no real swarm)
**Exit criteria:** With default settings `defaultIndexes()` returns phase 1's list followed by `knaben`, `bitsearch`, `torrentscsv`; J1-J4 pass; `npm run typecheck`, `npm test` and `npm run docs:check` pass.

## Handoffs

- Phase 1 (reconciled): phase 1 updates the `indexesOf` doc comment to "the default indexes" (generic) and writes the `defaultIndexes` doc comment for its six; this phase rewrites the latter to name the title-search three (Step 10).
- Phase 1 (reconciled): `findCandidates.test.ts` keeps the default indexes in phase 1; this phase's Step 12 (b)-(g) append after phase 1's lines, and `addonSwitches.test.ts` is updated here.
- Phase 1 / 3 (reconciled): `src/config.ts` loadConfig comment: phase 1 does not touch it; this phase rewrites :1197 naming all five new index keys; phase 3 inserts `NOTESD_TORRENT_TRACKER_LISTS` on a new line after :1194.
- Phase 3: nothing is required. Title-search candidates carry Knaben's magnet trackers like any row's trackers, and phase 3's list trackers get appended after them in `trackersOf`/`swarmCounts` unchanged.
- Not in this set (no phase owns it): a fake title-search route in `scripts/torrent/fake-index.mjs` would let a `--torrent` throwaway daemon show a title-search candidate end to end. Today the harness pins the three `off` and the unit tests carry the proof. The same goes for long-anime releases named only by a running number with no `SxxEyy` (`One Piece - 1100`): they are found only when their name starts with the title followed by that number.

## Rollback

Revert this phase's commits: the finder goes back to phase 1's indexes, `IndexFetch` goes back to GET-only, and `other_year` and `titleSearch` are removed. Nothing is stored in the database or on disk. At run time, with no revert: set `NOTESD_TORRENT_KNABEN_URL=off`, `NOTESD_TORRENT_BITSEARCH_URL=off`, `NOTESD_TORRENT_TORRENTSCSV_URL=off` in `.env.local` and restart through `scripts/install.sh`.
