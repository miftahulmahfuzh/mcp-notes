# Phase 1: Stremio add-on providers: TorrentsDB and Peerflix

**Plan set:** `WIDER_TORRENT_SOURCES_PLAN.md`
**Analysis:** `.workflows/analyze/20261119-025431-K7QD_code_analyzer.md`
**Satisfies:** R2 — "more providers": TM / TS plays find torrents through two more Stremio add-ons
**Criteria:** R2.1, R2.2, R2.3, R2.4
**Depends on:** none
**Difficulty:** NORMAL
**Package:** `src/directStream/torrent/find`

---

## Goal

The torrent finder asks two more Stremio torrent add-ons by IMDb id: TorrentsDB for every film and episode, and
Peerflix only when the title's original language is Spanish. Both are read by the same reader as Torrentio (generalized
to Peerflix's stats line and flag line), joined with the other indexes' listings by info hash, switchable with
`NOTESD_TORRENT_TORRENTSDB_URL` / `NOTESD_TORRENT_PEERFLIX_URL`, and pinned `off` in every throwaway daemon.

## Interface Contract

**Deletes:** none.
**Renames:** `readTorrentioStream` -> `readStremioStream` (`src/directStream/torrent/find/torrentio.ts:13`). Its only caller is
`torrentioIndex` in the same file (no test, no other module imports it; checked with `grep -rn readTorrentioStream`).
**Creates:**
- `StremioAddon` (interface), `stremioAddonIndex(addon)`, `readStremioStream(value)` in `find/torrentio.ts`
- `torrentsdbIndex(base)` in new `find/torrentsdb.ts`
- `peerflixIndex(base)`, `PEERFLIX_LANGUAGE = 'es'` in new `find/peerflix.ts`
- `IndexBases.torrentsdb`, `IndexBases.peerflix`; `DEFAULT_INDEX_BASES.torrentsdb = 'https://torrentsdb.com'`,
  `DEFAULT_INDEX_BASES.peerflix = 'https://addon.peerflix.mov'` (`find/find.ts`)
- `TORRENT_INDEX_NAMES` gains `'torrentsdb', 'peerflix'` (appended, after `'yts'`); `TORRENT_INDEX_URL_KEYS` gains
  `NOTESD_TORRENT_TORRENTSDB_URL`, `NOTESD_TORRENT_PEERFLIX_URL` and is now **exported** (`src/config.ts:335-362`)
- env vars `NOTESD_TORRENT_TORRENTSDB_URL`, `NOTESD_TORRENT_PEERFLIX_URL` (address or `off`)
- fixtures `tests/fixtures/torrent/torrentsdb-movie-shawshank.json`, `tests/fixtures/torrent/peerflix-movie-shawshank.json`
- test file `tests/unit/directStream/torrent/find/addonSwitches.test.ts`
- a test in `tests/unit/config.torrentFinder.test.ts`: every `TORRENT_INDEX_URL_KEYS` value is named at least twice in
  `verify.sh` (both the `--torrent` branch and the other one)
**Signature changes:**
- `function indexesOf(finder)` (`src/directStream/torrent/source.ts:1055`) becomes `export function indexesOf(finder)`; body unchanged.
- `defaultIndexes(options)` returns, in order: torrentio, apibay, eztv, torrentsdb, peerflix, then yts (unless `yts === false`).
  The order is the order of `FoundCandidates.indexes` attempts and of `listedBy`.
**Behaviour other phases must know:**
- Peerflix for a non-Spanish (or unknown) original language answers `{ outcome: 'empty', detail: 'not asked: Peerflix lists Spanish releases, asked only for a title made in Spanish' }`
  with no request. So with default indexes every `findCandidates` result now carries a `peerflix` attempt, and a
  `torrentsdb` attempt; a test with a fake fetch that does not route `https://torrentsdb.com/...` sees `torrentsdb` as
  `error` (`fetch failed: no route`).
- `tests/unit/config.torrentFinder.test.ts` now fails when a `TORRENT_INDEX_URL_KEYS` entry is not set in both branches of
  `verify.sh`'s index block (Invariant 3 as a test). Phase 2 must add its three keys to both lines it extends.
**Requires (from earlier phases):** none.
**Leaves alone (owned by others):** `IndexFetch`/`FetchLike` (`find/types.ts`) and `askOne`'s fetch wrapper (`find/find.ts:144-184`) (Phase 2);
`find/rank.ts`, `find/http.ts` (read only); `find/scrape.ts`, `origins.ts`, `trackersOf`/`swarmCounts`/`buildTorrentSource` tracker options,
`src/background.ts`, `src/daemon.ts`, the torrent block of `src/config.ts` (:421-440, :1092-1104) (Phase 3); the browser
sites; the `NOTESD_TORRENT_PEERS` row of `configuration.md` and anything after the RUTRACKER row (Phase 3); loadConfig's
key-list comment (`src/config.ts:1194-1198`): phase 2 names this phase's two keys there with its own three (line 1197), and
phase 3 adds its own line after 1194 (reconciled).

## Files

| File | Action | What changes |
|---|---|---|
| `src/directStream/torrent/find/torrentio.ts` | modify (whole file) | one reader and one index builder for any Stremio torrent add-on; Torrentio becomes one call of it |
| `src/directStream/torrent/find/torrentsdb.ts` | create | `torrentsdbIndex` |
| `src/directStream/torrent/find/peerflix.ts` | create | `peerflixIndex`, `PEERFLIX_LANGUAGE`, the Spanish-only gate |
| `src/directStream/torrent/find/find.ts` | modify :1-7, :67-80, :110-120 | imports, `IndexBases`, `DEFAULT_INDEX_BASES`, `defaultIndexes` |
| `src/directStream/torrent/find/index.ts` | modify :8 | barrel exports the two new modules |
| `src/config.ts` | modify :335-337, :356-362 | `TORRENT_INDEX_NAMES`, exported `TORRENT_INDEX_URL_KEYS` |
| `src/directStream/torrent/source.ts` | modify :1054-1060 | `indexesOf` exported, comment |
| `.claude/skills/verify-notesd/scripts/verify.sh` | modify :334-345 | both new addresses `off` in both branches |
| `docs/guide/reference/configuration.md` | modify after :180 | two rows after the YTS row |
| `docs/guide/streaming.md` | modify :1800-1801 | the index list in "Finding a torrent" |
| `.claude/skills/verify-notesd/features/direct-streaming.md` | modify after :436 | one bullet: what proves the add-on providers |
| `CLAUDE.md` | modify before :116 | one bullet under Direct streaming |
| `tests/fixtures/torrent/torrentsdb-movie-shawshank.json` | create | copy of the probe sample |
| `tests/fixtures/torrent/peerflix-movie-shawshank.json` | create | copy of the probe sample |
| `tests/unit/directStream/torrent/find/indexes.test.ts` | modify :1-11, append | reader tests for both providers |
| `tests/unit/directStream/torrent/find/findCandidates.test.ts` | modify :14-39, :42-73, :75-90, :161-188, append | default-index tests know the two providers; join, language gate, failure tests |
| `tests/unit/directStream/torrent/find/addonSwitches.test.ts` | create | settings -> `indexesOf` -> requests |
| `tests/unit/config.torrentFinder.test.ts` | modify :1-2, append in describe | parse of the two keys; verify.sh names every index key |

## Implementation Steps

### Step 1: One reader and one index builder for every Stremio torrent add-on
**File:** `src/directStream/torrent/find/torrentio.ts` (whole file, 67 lines today)
**Change:** Replace the file. Differences from today, and only these:
- `SITE` also reads the site after `🌐` (Peerflix), written with escapes so the `⚙️` variation selector is explicit
  (today's literal `/⚙️?\s*(.+)$/u` is U+2699 followed by an optional U+FE0F; the new pattern keeps exactly that).
- Lines made only of country flags are dropped from the lines before the stats line (Peerflix puts `🇪🇸` between the file
  line and the stats line, which today would be read as the file name). Torrentio puts its flag line after the stats
  line, so its rows read exactly as before (the Sintel and Breaking Bad fixtures prove it).
- `readTorrentioStream` is renamed `readStremioStream` (no other caller).
- The address building and answer reading move into `stremioAddonIndex`, with an optional `skip` that answers `empty`
  with its reason and sends no request. `torrentioIndex` is one call of it.
**Code:**
```ts
import { answerOf, candidateFrom, YTS_HINTS } from './candidate.js';
import { asRecord, asText, failedAnswer, getIndexJson, parseSizeText } from './http.js';
import { baseName } from './release.js';
import type { IndexAnswer, IndexRow, TorrentIndex, TorrentQuery } from './types.js';

/**
 * Stremio torrent add-ons (Torrentio, TorrentsDB, Peerflix) answer one open JSON protocol keyed by IMDb id:
 * GET `<base>/stream/movie/<imdb>.json` or `<base>/stream/series/<imdb>:<season>:<episode>.json`, a `streams` list.
 * A stream's `title` holds the release on its first line, the file on the last line before the stats line, and the
 * stats line `👤 <seeds> 💾 <size> ⚙️ <site>` (Peerflix: `🌐 <site>`, sometimes without 💾, after a line of flags).
 * One reader serves them all; each add-on is one stremioAddonIndex.
 */

const STATS = /[\u{1F464}\u{1F4BE}]/u;
const SEEDS = /\u{1F464}\s*(\d+)/u;
const SIZE = /\u{1F4BE}\s*([\d.,]+\s*[KMGT]?i?B)/iu;
/** The site after ⚙️ (Torrentio, TorrentsDB) or 🌐 (Peerflix). */
const SITE = /(?:⚙️?|\u{1F310})\s*(.+)$/u;
/** A line of country flags only ("🇪🇸", "🇬🇧 / 🇮🇹"): never the release or the file. */
const FLAGS = /^(?:[\u{1F1E6}-\u{1F1FF}]{2}|[\s\/])+$/u;
const YTS_RELEASE = /(?<![a-z])(?:yts|yify)(?![a-z])/i;

/** One Stremio add-on stream as an IndexRow; null when it has no info hash or no title. */
export function readStremioStream(value: unknown): IndexRow | null {
  const stream = asRecord(value);
  const infoHash = asText(stream?.infoHash);
  const title = asText(stream?.title);
  if (stream === null || infoHash === null || title === null) return null;
  const lines = title
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const statsAt = lines.findIndex((l) => STATS.test(l));
  const head = (statsAt < 0 ? lines : lines.slice(0, statsAt)).filter((l) => !FLAGS.test(l));
  const name = head[0];
  if (name === undefined) return null;
  const stats = statsAt < 0 ? '' : (lines[statsAt] ?? '');
  const fileLine = head.length > 1 ? (head[head.length - 1] ?? null) : null;
  const fileName = asText(asRecord(stream.behaviorHints)?.filename) ?? (fileLine === null ? null : baseName(fileLine));
  const sizeText = SIZE.exec(stats)?.[1];
  const site = SITE.exec(stats)?.[1]?.trim() ?? null;
  const sources = Array.isArray(stream.sources) ? stream.sources : [];
  const trackers = sources
    .map((s) => asText(s))
    .filter((s): s is string => s !== null && s.startsWith('tracker:'))
    .map((s) => s.slice('tracker:'.length));
  const fileIdx = typeof stream.fileIdx === 'number' && Number.isInteger(stream.fileIdx) && stream.fileIdx >= 0 ? stream.fileIdx : null;
  const yts = site?.toUpperCase() === 'YTS' || YTS_RELEASE.test(`${name} ${fileName ?? ''}`);
  return {
    infoHash,
    name,
    fileName,
    fileIdx,
    seeds: Number(SEEDS.exec(stats)?.[1] ?? 0),
    sizeBytes: sizeText === undefined ? null : parseSizeText(sizeText),
    trackers,
    site,
    hints: yts ? YTS_HINTS : undefined,
  };
}

export interface StremioAddon {
  /** Lower case: the attempt's name and each candidate's `index`. */
  name: string;
  /** The add-on's address, up to (not including) `/stream`. */
  base: string;
  /** Why this query is not asked, or null to ask it. A reason answers `empty` with it as the detail; no request is sent. */
  skip?: (query: TorrentQuery) => string | null;
}

/** A Stremio torrent add-on as a TorrentIndex, asked by IMDb id for a film or one episode. */
export function stremioAddonIndex(addon: StremioAddon): TorrentIndex {
  const root = addon.base.replace(/\/+$/, '');
  return {
    name: addon.name,
    async find(query, ctx): Promise<IndexAnswer> {
      const skip = addon.skip?.(query) ?? null;
      if (skip !== null) return { outcome: 'empty', detail: skip, candidates: [] };
      // The add-ons number an episode within its season: `alt` when TMDB's number runs on across seasons.
      const episode = query.kind === 'movie' ? null : (query.alt ?? query);
      const path = episode === null ? `movie/${query.imdbId}` : `series/${query.imdbId}:${episode.season}:${episode.episode}`;
      const got = await getIndexJson(ctx, `${root}/stream/${path}.json`);
      if (!got.ok) return failedAnswer(got);
      const streams = asRecord(got.json)?.streams;
      if (!Array.isArray(streams)) return { outcome: 'error', detail: 'the answer has no streams list', candidates: [] };
      const rows = streams.map((s: unknown) => readStremioStream(s)).filter((r): r is IndexRow => r !== null);
      return answerOf(rows.map((row) => candidateFrom(row, addon.name, query, query.kind === 'tv')));
    },
  };
}

export function torrentioIndex(base: string): TorrentIndex {
  return stremioAddonIndex({ name: 'torrentio', base });
}
```
**Impact:** none for Torrentio: same URLs, same rows, same candidates (existing `indexes.test.ts` torrentio tests, unchanged,
must still pass). Barrel exports change from `readTorrentioStream` to `readStremioStream`, `StremioAddon`, `stremioAddonIndex`.
**Check:** `npx vitest run tests/unit/directStream/torrent/find/indexes.test.ts -t torrentio` passes (3 tests).

### Step 2: The TorrentsDB provider
**File:** `src/directStream/torrent/find/torrentsdb.ts` (new)
**Code:**
```ts
import { stremioAddonIndex } from './torrentio.js';
import type { TorrentIndex } from './types.js';

/**
 * TorrentsDB (torrentsdb.com), a Stremio torrent add-on asked by IMDb id for every film and episode. It answers in
 * Torrentio's shape and lists sites Torrentio does not (knaben, rargb, sktorrent, ilcorsaronero): for The Shawshank
 * Redemption, 7 of its 96 streams were info hashes Torrentio's 500 did not hold (probed 2026-11-19). A torrent both
 * list is one candidate: rankCandidates joins listings by info hash, `listedBy` naming both.
 */
export function torrentsdbIndex(base: string): TorrentIndex {
  return stremioAddonIndex({ name: 'torrentsdb', base });
}
```

### Step 3: The Peerflix provider, asked for Spanish-original titles only
**File:** `src/directStream/torrent/find/peerflix.ts` (new)
**Code:**
```ts
import { stremioAddonIndex } from './torrentio.js';
import type { TorrentIndex, TorrentQuery } from './types.js';

/** The one original language (ISO 639-1) Peerflix is asked for. */
export const PEERFLIX_LANGUAGE = 'es';

const NOT_ASKED = 'not asked: Peerflix lists Spanish releases, asked only for a title made in Spanish';

/**
 * Peerflix (addon.peerflix.mov), a Stremio torrent add-on of Spanish releases, nearly all Castilian dubs. Direct
 * streaming plays the original language only, so for a title made in any other language its every listing would be
 * a dub: it is asked only when the title's original language is Spanish, and otherwise answers `empty` with no request.
 */
export function peerflixIndex(base: string): TorrentIndex {
  return stremioAddonIndex({
    name: 'peerflix',
    base,
    skip: (query: TorrentQuery) => ((query.originalLanguage ?? '').trim().toLowerCase() === PEERFLIX_LANGUAGE ? null : NOT_ASKED),
  });
}
```
**Impact:** an unknown original language (`null`) is not Spanish: Peerflix is not asked.

### Step 4: Register both in the finder's defaults
**File:** `src/directStream/torrent/find/find.ts`
**Change 4a** (imports, :1-7). Before:
```ts
import { apibayIndex } from './apibay.js';
import { normalizeImdbId } from './candidate.js';
import { eztvIndex } from './eztv.js';
import { DEFAULT_RANK_SETTINGS, rankCandidates, type RankSettings } from './rank.js';
import { torrentioIndex } from './torrentio.js';
import { ytsIndex } from './yts.js';
```
After:
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
**Change 4b** (:67-80). Before:
```ts
export interface IndexBases {
  torrentio: string;
  apibay: string;
  eztv: string;
  /** Up to and including `/api/v2`. */
  yts: string;
}

export const DEFAULT_INDEX_BASES: Readonly<IndexBases> = {
  torrentio: 'https://torrentio.strem.fun',
  apibay: 'https://apibay.org',
  eztv: 'https://eztvx.to',
  yts: 'https://yts.mx/api/v2',
};
```
After:
```ts
export interface IndexBases {
  torrentio: string;
  apibay: string;
  eztv: string;
  /** Up to and including `/api/v2`. */
  yts: string;
  /** A Stremio add-on, like Torrentio. */
  torrentsdb: string;
  /** A Stremio add-on of Spanish releases, asked only for a title made in Spanish. */
  peerflix: string;
}

export const DEFAULT_INDEX_BASES: Readonly<IndexBases> = {
  torrentio: 'https://torrentio.strem.fun',
  apibay: 'https://apibay.org',
  eztv: 'https://eztvx.to',
  yts: 'https://yts.mx/api/v2',
  torrentsdb: 'https://torrentsdb.com',
  peerflix: 'https://addon.peerflix.mov',
};
```
**Change 4c** (:110-120). Before:
```ts
/** Torrentio, apibay, EZTV, and YTS unless `yts` is false. */
export function defaultIndexes(options: Pick<FindOptions, 'bases' | 'yts'> = {}): TorrentIndex[] {
  const bases = options.bases ?? {};
  const indexes = [
    torrentioIndex(bases.torrentio ?? DEFAULT_INDEX_BASES.torrentio),
    apibayIndex(bases.apibay ?? DEFAULT_INDEX_BASES.apibay),
    eztvIndex(bases.eztv ?? DEFAULT_INDEX_BASES.eztv),
  ];
  if (options.yts !== false) indexes.push(ytsIndex(bases.yts ?? DEFAULT_INDEX_BASES.yts));
  return indexes;
}
```
After:
```ts
/** Torrentio, apibay, EZTV, TorrentsDB, Peerflix (it asks only for a title made in Spanish), and YTS unless `yts` is false. */
export function defaultIndexes(options: Pick<FindOptions, 'bases' | 'yts'> = {}): TorrentIndex[] {
  const bases = options.bases ?? {};
  const indexes = [
    torrentioIndex(bases.torrentio ?? DEFAULT_INDEX_BASES.torrentio),
    apibayIndex(bases.apibay ?? DEFAULT_INDEX_BASES.apibay),
    eztvIndex(bases.eztv ?? DEFAULT_INDEX_BASES.eztv),
    torrentsdbIndex(bases.torrentsdb ?? DEFAULT_INDEX_BASES.torrentsdb),
    peerflixIndex(bases.peerflix ?? DEFAULT_INDEX_BASES.peerflix),
  ];
  if (options.yts !== false) indexes.push(ytsIndex(bases.yts ?? DEFAULT_INDEX_BASES.yts));
  return indexes;
}
```
**Impact:** every `findCandidates` call without `indexes` asks TorrentsDB and lists a Peerflix attempt. `askOne` (:144-184) is
not touched (phase 2 owns it). Step 9 updates the tests that pinned the old attempt list.

### Step 5: The barrel
**File:** `src/directStream/torrent/find/index.ts:8`
Before:
```ts
export * from './torrentio.js';
```
After:
```ts
export * from './torrentio.js';
export * from './torrentsdb.js';
export * from './peerflix.js';
```

### Step 6: The settings
**File:** `src/config.ts`
**Change 6a** (:335-337). Before:
```ts
/** The JSON torrent indexes the finder asks (src/directStream/torrent/find/). */
export const TORRENT_INDEX_NAMES = ['torrentio', 'apibay', 'eztv', 'yts'] as const
```
After:
```ts
/** The JSON torrent indexes the finder asks (src/directStream/torrent/find/). */
export const TORRENT_INDEX_NAMES = ['torrentio', 'apibay', 'eztv', 'yts', 'torrentsdb', 'peerflix'] as const
```
**Change 6b** (:356-362). Before:
```ts
/** Each index's address setting, spelled out (not built from the name) so `npm run docs:check` finds the names in the code. */
const TORRENT_INDEX_URL_KEYS: Record<TorrentIndexName, string> = {
  torrentio: 'NOTESD_TORRENT_TORRENTIO_URL',
  apibay: 'NOTESD_TORRENT_APIBAY_URL',
  eztv: 'NOTESD_TORRENT_EZTV_URL',
  yts: 'NOTESD_TORRENT_YTS_URL',
}
```
After:
```ts
/**
 * Each index's address setting, spelled out (not built from the name) so `npm run docs:check` finds the names in the
 * code. tests/unit/config.torrentFinder.test.ts checks that verify.sh names every one, so no throwaway daemon asks a
 * real index.
 */
export const TORRENT_INDEX_URL_KEYS: Record<TorrentIndexName, string> = {
  torrentio: 'NOTESD_TORRENT_TORRENTIO_URL',
  apibay: 'NOTESD_TORRENT_APIBAY_URL',
  eztv: 'NOTESD_TORRENT_EZTV_URL',
  yts: 'NOTESD_TORRENT_YTS_URL',
  torrentsdb: 'NOTESD_TORRENT_TORRENTSDB_URL',
  peerflix: 'NOTESD_TORRENT_PEERFLIX_URL',
}
```
**Impact:** `parseTorrentFinder` (:365) needs no change: it loops over `TORRENT_INDEX_NAMES`. The torrent block (:421-440,
:1092-1104) is not touched (phase 3).

### Step 7: `indexesOf` exported
**File:** `src/directStream/torrent/source.ts:1054-1060`
Before:
```ts
/** The finder's index list from the settings: the default four at their addresses, minus the ones set `off`. */
function indexesOf(finder: NonNullable<Config['torrent']>['finder']): TorrentIndex[] {
```
After:
```ts
/** The finder's index list from the settings: the default indexes at their addresses, minus the ones set `off`. */
export function indexesOf(finder: NonNullable<Config['torrent']>['finder']): TorrentIndex[] {
```
The body (:1056-1059) stays as it is: it already turns any `TORRENT_INDEX_NAMES` entry set `off` into a filter by name, and
passes every address through `bases`. Exported so the settings-to-requests path is tested as a caller sees it (Step 10).
Nothing else in `source.ts` changes (`trackersOf`, `swarmCounts`, `buildTorrentSource` belong to phase 3).

### Step 8: Fixtures (the probe's real answers)
```sh
W=/home/miftah/.worktrees/mcp-notes/wider-torrent-sources
cp "$W/.workflows/analyze/20261119-025431-K7QD-samples/torrentsdb.json" "$W/tests/fixtures/torrent/torrentsdb-movie-shawshank.json"
cp "$W/.workflows/analyze/20261119-025431-K7QD-samples/peerflix.json" "$W/tests/fixtures/torrent/peerflix-movie-shawshank.json"
```
Byte for byte. torrentsdb: 4 streams of `/stream/movie/tt0111161.json`, two info hashes each listed twice (once upper case);
peerflix: 3 streams of the same address, each with a `🇪🇸` line before a `🌐 Peerflix` stats line.

### Step 9: Reader tests
**File:** `tests/unit/directStream/torrent/find/indexes.test.ts`
**Change 9a** (imports, :1-11): add two imports, keeping the alphabetical order. After line 8
(`import { getIndexJson } ...`) add:
```ts
import { peerflixIndex } from '../../../../../src/directStream/torrent/find/peerflix.js';
```
After line 9 (`import { torrentioIndex } ...`) add:
```ts
import { torrentsdbIndex } from '../../../../../src/directStream/torrent/find/torrentsdb.js';
```
**Change 9b**: append at the end of the file:
```ts
const SHAWSHANK: TorrentQuery = { kind: 'movie', imdbId: 'tt0111161', title: 'The Shawshank Redemption', year: 1994, originalLanguage: 'en' };

describe('torrentsdb', () => {
  it('reads a film answer in Torrentio\'s shape: release, file, seeds, size, site, trackers, any-case info hash', async () => {
    const { ctx, urls } = ctxFor({ 'https://torrentsdb.example/stream/movie/tt0111161.json': fixture('torrentsdb-movie-shawshank.json') });
    const answer = await torrentsdbIndex('https://torrentsdb.example/').find(SHAWSHANK, ctx);
    expect(urls).toEqual(['https://torrentsdb.example/stream/movie/tt0111161.json']);
    expect(answer.outcome).toBe('ok');
    expect(answer.candidates).toHaveLength(4);
    expect(answer.candidates.every((c) => c.index === 'torrentsdb' && c.listedBy.join() === 'torrentsdb' && !c.scoped)).toBe(true);
    expect(answer.candidates[0]).toMatchObject({
      infoHash: 'c3da9a3dc2ce14d0d4fc0e87d1b2023502f8dcd6',
      name: 'The Shawshank Redemption 1994 2160p BluRay',
      fileName: 'The.Shawshank.Redemption.1994.2160p.4K.BluRay.x265.10bit.HDR.AAC5.1-[YTS.MX].mkv',
      fileIdx: 0,
      seeds: 100,
      sizeBytes: 7419556004,
      site: 'YTS',
    });
    expect(answer.candidates[1]?.infoHash).toBe('c3da9a3dc2ce14d0d4fc0e87d1b2023502f8dcd6');
    expect(answer.candidates[2]).toMatchObject({ infoHash: '32770c6dd35a4dd71deb80d5deff7a4e084eedab', site: 'rargb', seeds: 93, sizeBytes: 62255550956, fileIdx: 1 });
    expect(answer.candidates[2]?.trackers).toEqual(expect.arrayContaining(['udp://9.rarbg.me:2860/announce', DEFAULT_TRACKERS[0]]));
    expect(answer.candidates[2]?.trackers.some((t) => t.startsWith('dht:'))).toBe(false);
  });

  it('asks for an episode by season and episode and marks it scoped', async () => {
    const query: TorrentQuery = { kind: 'tv', imdbId: 'tt0903747', season: 1, episode: 1, title: 'Breaking Bad', originalLanguage: 'en' };
    const stream = { name: 'TorrentsDB\n1080p', title: 'Breaking.Bad.S01E01.1080p.BluRay.x264-GRP\n👤 40 💾 1.5 GB ⚙️ knaben', infoHash: 'ab'.repeat(20) };
    const { ctx, urls } = ctxFor({ 'https://torrentsdb.example/stream/series/tt0903747:1:1.json': JSON.stringify({ streams: [stream] }) });
    const answer = await torrentsdbIndex('https://torrentsdb.example').find(query, ctx);
    expect(urls).toEqual(['https://torrentsdb.example/stream/series/tt0903747:1:1.json']);
    expect(answer.candidates).toEqual([expect.objectContaining({ infoHash: 'ab'.repeat(20), scoped: true, site: 'knaben', seeds: 40 })]);
  });
});

describe('peerflix', () => {
  // The recorded answer is The Shawshank Redemption's; the query says Spanish only so that Peerflix is asked.
  const SPANISH: TorrentQuery = { ...SHAWSHANK, originalLanguage: 'es' };

  it('reads a stats line that ends in the globe and the flag line before it', async () => {
    const { ctx, urls } = ctxFor({ 'https://peerflix.example/stream/movie/tt0111161.json': fixture('peerflix-movie-shawshank.json') });
    const answer = await peerflixIndex('https://peerflix.example').find(SPANISH, ctx);
    expect(urls).toEqual(['https://peerflix.example/stream/movie/tt0111161.json']);
    expect(answer.outcome).toBe('ok');
    expect(answer.candidates).toHaveLength(3);
    expect(answer.candidates[0]).toMatchObject({
      infoHash: '814978f980297cc7cd42be9d60b37b928a5e7cdc',
      name: 'Cadena perpetua [4Kreescaldo][2160p][HDR10][AC3 5.1 Castellano-AC3 5.1-Ingles+Subs][ES-EN]',
      fileName: 'Cadena perpetua 4Kreescalado2160.pctmix1.com.mkv',
      fileIdx: 5,
      seeds: 6,
      sizeBytes: 64005750129,
      site: 'Peerflix',
      index: 'peerflix',
    });
    expect(answer.candidates[1]?.seeds).toBe(0);
  });

  it('reads a row with no size', async () => {
    const stream = {
      name: 'Peerflix 1080p',
      title: 'El laberinto del fauno [1080p][Castellano]\nEl laberinto del fauno 1080p.mkv\n🇪🇸\n  👤 4 🌐 Peerflix',
      infoHash: 'cd'.repeat(20),
    };
    const { ctx } = ctxFor({ 'https://peerflix.example/stream/movie/tt0111161.json': JSON.stringify({ streams: [stream] }) });
    const answer = await peerflixIndex('https://peerflix.example').find(SPANISH, ctx);
    expect(answer.candidates).toEqual([
      expect.objectContaining({ name: 'El laberinto del fauno [1080p][Castellano]', fileName: 'El laberinto del fauno 1080p.mkv', seeds: 4, sizeBytes: null, site: 'Peerflix' }),
    ]);
  });

  it('sends no request for a title made in another language, or in an unknown one, and asks for Spanish in any case', async () => {
    for (const originalLanguage of ['en', 'pt', null]) {
      const { ctx, urls } = ctxFor({});
      const answer = await peerflixIndex('https://peerflix.example').find({ ...SHAWSHANK, originalLanguage }, ctx);
      expect(urls).toEqual([]);
      expect(answer).toEqual({ outcome: 'empty', detail: expect.stringMatching(/^not asked: .*Spanish/), candidates: [] });
    }
    const { ctx, urls } = ctxFor({ 'https://peerflix.example/stream/movie/tt0111161.json': '{"streams":[]}' });
    await peerflixIndex('https://peerflix.example').find({ ...SHAWSHANK, originalLanguage: 'ES' }, ctx);
    expect(urls).toEqual(['https://peerflix.example/stream/movie/tt0111161.json']);
  });
});
```
(If `parseSizeText` rounds differently than `Math.round(GB * 1024 ** 3)`, the sizes are: 6.91 GB = 7419556004, 57.98 GB =
62255550956, 59.61 GB = 64005750129; they are that formula.)

### Step 10: The finder with the two providers
**File:** `tests/unit/directStream/torrent/find/findCandidates.test.ts`
**Change 10a** — constants (after :18, the `YTS_FILM` line) add:
```ts
const TORRENTSDB_FILM = 'https://torrentsdb.com/stream/movie/tt1727587.json';
const TORRENTSDB_EPISODE = 'https://torrentsdb.com/stream/series/tt0903747:1:1.json';
const NO_STREAMS = '{"streams":[]}';
```
and after `torrentioAnswer` (:34-38) add:
```ts
function addonAnswer(addon: string, rows: Array<{ title: string; seeds: number; hash: string; site: string }>): string {
  return JSON.stringify({
    streams: rows.map((r) => ({ name: `${addon}\n1080p`, title: `${r.title}\n👤 ${r.seeds} 💾 1.2 GB ⚙️ ${r.site}`, infoHash: r.hash, behaviorHints: {} })),
  });
}
```
**Change 10b** — test "asks Torrentio, apibay and YTS for a film ..." (:42-73). Rename it to
`'asks Torrentio, apibay, TorrentsDB and YTS for a film by its IMDb id and answers ranked candidates'`, add the route
`[TORRENTSDB_FILM]: body(NO_STREAMS),` to its `fakeFetch`, and replace its two assertions on calls and attempts:
Before:
```ts
    expect(calls.map((c) => c.url).sort()).toEqual([APIBAY_FILM, TORRENTIO_FILM, YTS_FILM].sort());
    expect(calls.every((c) => c.userAgent === TORRENT_INDEX_USER_AGENT)).toBe(true);
    expect(found.indexes.map((a) => [a.index, a.outcome, a.listed])).toEqual([
      ['torrentio', 'ok', 32],
      ['apibay', 'ok', 19],
      ['yts', 'ok', 3],
    ]);
```
After:
```ts
    expect(calls.map((c) => c.url).sort()).toEqual([APIBAY_FILM, TORRENTIO_FILM, TORRENTSDB_FILM, YTS_FILM].sort());
    expect(calls.every((c) => c.userAgent === TORRENT_INDEX_USER_AGENT)).toBe(true);
    expect(found.indexes.map((a) => [a.index, a.outcome, a.listed])).toEqual([
      ['torrentio', 'ok', 32],
      ['apibay', 'ok', 19],
      ['torrentsdb', 'empty', 0],
      ['peerflix', 'empty', 0],
      ['yts', 'ok', 3],
    ]);
```
The rest of the test (candidates, `listedBy: ['torrentio', 'yts']`, exclusions) is unchanged.
**Change 10c** — test "asks Torrentio, apibay and EZTV for an episode ..." (:75-90): add the route
`[TORRENTSDB_EPISODE]: body(NO_STREAMS),`. Before:
```ts
    expect(calls.some((c) => c.url.includes('yts'))).toBe(false);
    expect(found.indexes.map((a) => [a.index, a.outcome])).toEqual([
      ['torrentio', 'ok'],
      ['apibay', 'empty'],
      ['eztv', 'empty'],
    ]);
```
After:
```ts
    expect(calls.some((c) => c.url.includes('yts'))).toBe(false);
    expect(calls.some((c) => c.url.includes('peerflix'))).toBe(false);
    expect(found.indexes.map((a) => [a.index, a.outcome])).toEqual([
      ['torrentio', 'ok'],
      ['apibay', 'empty'],
      ['eztv', 'empty'],
      ['torrentsdb', 'empty'],
      ['peerflix', 'empty'],
    ]);
```
**Change 10d** — test "records an index that times out or answers a bot check ..." (:161-174): add the route
`[TORRENTSDB_FILM]: body(NO_STREAMS),`. Before:
```ts
    expect(found.indexes).toEqual([
      expect.objectContaining({ index: 'torrentio', outcome: 'bot_check', listed: 0 }),
      expect.objectContaining({ index: 'apibay', outcome: 'ok', listed: 19 }),
      expect.objectContaining({ index: 'yts', outcome: 'error', detail: expect.stringMatching(/^timed out after /), listed: 0 }),
    ]);
```
After:
```ts
    expect(found.indexes).toEqual([
      expect.objectContaining({ index: 'torrentio', outcome: 'bot_check', listed: 0 }),
      expect.objectContaining({ index: 'apibay', outcome: 'ok', listed: 19 }),
      expect.objectContaining({ index: 'torrentsdb', outcome: 'empty', listed: 0 }),
      expect.objectContaining({ index: 'peerflix', outcome: 'empty', listed: 0 }),
      expect.objectContaining({ index: 'yts', outcome: 'error', detail: expect.stringMatching(/^timed out after /), listed: 0 }),
    ]);
```
**Change 10e** — test "records an index that fails or answers an error status ..." (:176-188), no route added. Before:
```ts
    expect(found.indexes).toEqual([
      expect.objectContaining({ index: 'torrentio', outcome: 'error', detail: 'HTTP 500' }),
      expect.objectContaining({ index: 'apibay', outcome: 'error', detail: expect.stringContaining('fetch failed') }),
      expect.objectContaining({ index: 'eztv', outcome: 'bot_check' }),
    ]);
```
After:
```ts
    expect(found.indexes).toEqual([
      expect.objectContaining({ index: 'torrentio', outcome: 'error', detail: 'HTTP 500' }),
      expect.objectContaining({ index: 'apibay', outcome: 'error', detail: expect.stringContaining('fetch failed') }),
      expect.objectContaining({ index: 'eztv', outcome: 'bot_check' }),
      expect.objectContaining({ index: 'torrentsdb', outcome: 'error', detail: expect.stringContaining('fetch failed') }),
      expect.objectContaining({ index: 'peerflix', outcome: 'empty' }),
    ]);
```
The tests at :114 and :135 assert no attempt list; their unrouted TorrentsDB request is an `error` attempt that changes none
of their candidates or exclusions, so they stay as they are.
**Change 10f** — append at the end of the file:
```ts
const PAN: TorrentQuery = { kind: 'movie', imdbId: 'tt0457430', title: "Pan's Labyrinth", originalTitle: 'El laberinto del fauno', year: 2006, originalLanguage: 'es' };
const PAN_URL = {
  torrentio: 'https://torrentio.strem.fun/stream/movie/tt0457430.json',
  apibay: 'https://apibay.org/q.php?q=tt0457430',
  torrentsdb: 'https://torrentsdb.com/stream/movie/tt0457430.json',
  peerflix: 'https://addon.peerflix.mov/stream/movie/tt0457430.json',
  yts: 'https://yts.mx/api/v2/list_movies.json?query_term=tt0457430',
};
const PEERFLIX_PAN = JSON.stringify({
  streams: [
    {
      name: 'Peerflix 1080p',
      title: 'El.Laberinto.Del.Fauno.2006.1080p.BluRay.x264-GRP\nEl.Laberinto.Del.Fauno.2006.1080p.BluRay.x264-GRP.mkv\n🇪🇸\n  👤 30 💾 2.1 GB 🌐 Peerflix',
      infoHash: hash(6),
    },
  ],
});

describe('findCandidates with the Stremio add-on providers', () => {
  it("asks TorrentsDB and joins its listing of a torrent with the other indexes' by info hash", async () => {
    const { fetch, calls } = fakeFetch({
      [TORRENTIO_FILM]: body(fixture('torrentio-movie-sintel.json')),
      [APIBAY_FILM]: body(fixture('apibay-empty.json')),
      [YTS_FILM]: body(fixture('yts-sintel.json')),
      [TORRENTSDB_FILM]: body(
        addonAnswer('TorrentsDB', [
          { title: 'Sintel 2010 720p BluRay', seeds: 45, hash: 'A779FA758F2229586EEBC2E5960EB32FE5659596', site: 'knaben' },
          { title: 'Sintel.2010.1080p.WEB-DL.x264.AAC-TDB', seeds: 12, hash: hash(5), site: 'rargb' },
        ]),
      ),
    });
    const found = await findCandidates(SINTEL, { fetch });
    expect(calls.map((c) => c.url)).toContain(TORRENTSDB_FILM);
    expect(found.indexes.find((a) => a.index === 'torrentsdb')).toMatchObject({ outcome: 'ok', listed: 2 });
    const shared = found.candidates.filter((c) => c.infoHash === 'a779fa758f2229586eebc2e5960eb32fe5659596');
    expect(shared).toHaveLength(1);
    expect(shared[0]?.listedBy).toEqual(['torrentio', 'torrentsdb', 'yts']);
    expect(shared[0]?.seeds).toBeGreaterThanOrEqual(45);
    expect(found.candidates.find((c) => c.infoHash === hash(5))).toMatchObject({ index: 'torrentsdb', listedBy: ['torrentsdb'], site: 'rargb' });
  });

  it('asks Peerflix for a title made in Spanish and keeps what it lists', async () => {
    const { fetch, calls } = fakeFetch({
      [PAN_URL.torrentio]: body(NO_STREAMS),
      [PAN_URL.apibay]: body(fixture('apibay-empty.json')),
      [PAN_URL.torrentsdb]: body(NO_STREAMS),
      [PAN_URL.peerflix]: body(PEERFLIX_PAN),
      [PAN_URL.yts]: body(NO_YTS),
    });
    const found = await findCandidates(PAN, { fetch });
    expect(calls.map((c) => c.url)).toContain(PAN_URL.peerflix);
    expect(found.indexes.map((a) => [a.index, a.outcome])).toEqual([
      ['torrentio', 'empty'],
      ['apibay', 'empty'],
      ['torrentsdb', 'empty'],
      ['peerflix', 'ok'],
      ['yts', 'empty'],
    ]);
    expect(found.candidates).toEqual([expect.objectContaining({ infoHash: hash(6), index: 'peerflix', listedBy: ['peerflix'], site: 'Peerflix' })]);
  });

  it('sends Peerflix no request for a title made in any other language', async () => {
    for (const query of [SINTEL, { ...SINTEL, originalLanguage: null }]) {
      const { fetch, calls } = fakeFetch({
        [TORRENTIO_FILM]: body(NO_STREAMS),
        [APIBAY_FILM]: body(fixture('apibay-empty.json')),
        [TORRENTSDB_FILM]: body(NO_STREAMS),
        [YTS_FILM]: body(NO_YTS),
      });
      const found = await findCandidates(query, { fetch });
      expect(calls.some((c) => c.url.includes('peerflix'))).toBe(false);
      expect(found.indexes.find((a) => a.index === 'peerflix')).toMatchObject({ outcome: 'empty', detail: expect.stringMatching(/^not asked: /), listed: 0 });
    }
  });

  it("records an add-on provider's bot check, timeout or failure and still answers the other indexes' candidates", async () => {
    const torrentio = body(torrentioAnswer([{ title: 'El.Laberinto.Del.Fauno.2006.1080p.BluRay.x264-GRP', seeds: 50, hash: hash(1) }]));
    const blocked = fakeFetch({
      [PAN_URL.torrentio]: torrentio,
      [PAN_URL.apibay]: body(fixture('apibay-empty.json')),
      [PAN_URL.torrentsdb]: body(fixture('cloudflare-challenge.html'), 403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' }),
      [PAN_URL.peerflix]: () => new Promise<Response>(() => {}),
      [PAN_URL.yts]: body(NO_YTS),
    });
    const found = await findCandidates(PAN, { fetch: blocked.fetch, timeoutMs: 50 });
    expect(found.indexes).toEqual([
      expect.objectContaining({ index: 'torrentio', outcome: 'ok', listed: 1 }),
      expect.objectContaining({ index: 'apibay', outcome: 'empty' }),
      expect.objectContaining({ index: 'torrentsdb', outcome: 'bot_check', listed: 0 }),
      expect.objectContaining({ index: 'peerflix', outcome: 'error', detail: expect.stringMatching(/^timed out after /), listed: 0 }),
      expect.objectContaining({ index: 'yts', outcome: 'empty' }),
    ]);
    expect(found.candidates.map((c) => c.infoHash)).toEqual([hash(1)]);

    const failing = fakeFetch({
      [PAN_URL.torrentio]: torrentio,
      [PAN_URL.apibay]: body(fixture('apibay-empty.json')),
      [PAN_URL.torrentsdb]: body('', 500),
      [PAN_URL.yts]: body(NO_YTS),
    });
    const again = await findCandidates(PAN, { fetch: failing.fetch });
    expect(again.indexes.find((a) => a.index === 'torrentsdb')).toMatchObject({ outcome: 'error', detail: 'HTTP 500' });
    expect(again.indexes.find((a) => a.index === 'peerflix')).toMatchObject({ outcome: 'error', detail: expect.stringContaining('fetch failed') });
    expect(again.candidates.map((c) => c.infoHash)).toEqual([hash(1)]);
  });
});
```

### Step 11: Settings to requests, as the daemon builds them
**File:** `tests/unit/directStream/torrent/find/addonSwitches.test.ts` (new; inside `find/` so the feature map's
`npx vitest run tests/unit/directStream/torrent/find` runs it)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import { parseTorrentFinder } from '../../../../../src/config.js';
import { findCandidates } from '../../../../../src/directStream/torrent/find/find.js';
import type { FetchLike, TorrentQuery } from '../../../../../src/directStream/torrent/find/types.js';
import { indexesOf } from '../../../../../src/directStream/torrent/source.js';

const PAN: TorrentQuery = { kind: 'movie', imdbId: 'tt0457430', title: "Pan's Labyrinth", originalTitle: 'El laberinto del fauno', year: 2006, originalLanguage: 'es' };

function recording(): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    return new Response('{"streams":[]}', { status: 200 });
  };
  return { fetch, urls };
}

describe('the Stremio add-on providers and their address settings', () => {
  it('are among the default indexes, in the order they are asked', () => {
    expect(indexesOf(parseTorrentFinder({})).map((i) => i.name)).toEqual(['torrentio', 'apibay', 'eztv', 'torrentsdb', 'peerflix', 'yts']);
  });

  it('are asked at the addresses the settings give', async () => {
    const finder = parseTorrentFinder({ NOTESD_TORRENT_TORRENTSDB_URL: 'http://127.0.0.1:4601/', NOTESD_TORRENT_PEERFLIX_URL: 'http://127.0.0.1:4602' });
    expect(finder.indexes).toEqual({ torrentsdb: 'http://127.0.0.1:4601', peerflix: 'http://127.0.0.1:4602' });
    const { fetch, urls } = recording();
    await findCandidates(PAN, { fetch, indexes: indexesOf(finder) });
    expect(urls).toEqual(expect.arrayContaining(['http://127.0.0.1:4601/stream/movie/tt0457430.json', 'http://127.0.0.1:4602/stream/movie/tt0457430.json']));
  });

  it('get no request when set off, even for a title made in Spanish', async () => {
    const finder = parseTorrentFinder({ NOTESD_TORRENT_TORRENTSDB_URL: 'off', NOTESD_TORRENT_PEERFLIX_URL: 'OFF' });
    expect(finder.indexes).toEqual({ torrentsdb: null, peerflix: null });
    const indexes = indexesOf(finder);
    expect(indexes.map((i) => i.name)).toEqual(['torrentio', 'apibay', 'eztv', 'yts']);
    const { fetch, urls } = recording();
    const found = await findCandidates(PAN, { fetch, indexes });
    expect(urls.filter((u) => u.includes('torrentsdb') || u.includes('peerflix'))).toEqual([]);
    expect(found.indexes.map((a) => a.index)).toEqual(['torrentio', 'apibay', 'yts']);
  });
});
```

### Step 12: Config tests
**File:** `tests/unit/config.torrentFinder.test.ts`
**Change 12a** (:1-2). Before:
```ts
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseTorrentFinder } from '../../src/config.js';
```
After:
```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseTorrentFinder, TORRENT_INDEX_URL_KEYS } from '../../src/config.js';
```
**Change 12b**: add inside `describe('parseTorrentFinder')`, after the "rejects a bad number ..." test:
```ts
  it('reads the add-on providers\' addresses and their off switch', () => {
    expect(parseTorrentFinder({ NOTESD_TORRENT_TORRENTSDB_URL: 'https://tdb.example/', NOTESD_TORRENT_PEERFLIX_URL: 'off' })).toEqual({
      indexes: { torrentsdb: 'https://tdb.example', peerflix: null },
    });
    expect(() => parseTorrentFinder({ NOTESD_TORRENT_PEERFLIX_URL: 'addon.peerflix.mov' })).toThrow(ConfigError);
  });

  it('is named by verify.sh for every index, in both of its index lines, so no throwaway daemon asks a real index', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const verify = readFileSync(path.join(root, '.claude/skills/verify-notesd/scripts/verify.sh'), 'utf8');
    for (const key of Object.values(TORRENT_INDEX_URL_KEYS)) {
      expect(verify.split(`${key}=`).length - 1, `${key} in verify.sh`).toBeGreaterThanOrEqual(2);
    }
  });
```

### Step 13: The throwaway daemon never asks the real providers
**File:** `.claude/skills/verify-notesd/scripts/verify.sh:334-345`
Before:
```sh
  # Torrent phase 3: the finder asks only the fake index on a --torrent run, and no index at all otherwise.
  if [ "$torrent" = 1 ]; then
    env+=(
      "NOTESD_TORRENT_TORRENTIO_URL=http://127.0.0.1:$(cat "$dir/torrent/index.port")"
      NOTESD_TORRENT_APIBAY_URL=off NOTESD_TORRENT_EZTV_URL=off NOTESD_TORRENT_YTS_URL=off NOTESD_TORRENT_MIN_SEEDS=1
    )
```
After:
```sh
  # Torrent phase 3: the finder asks only the fake index on a --torrent run, and no index at all otherwise.
  # Every index's NOTESD_TORRENT_<NAME>_URL is named on both lines (tests/unit/config.torrentFinder.test.ts checks it).
  if [ "$torrent" = 1 ]; then
    env+=(
      "NOTESD_TORRENT_TORRENTIO_URL=http://127.0.0.1:$(cat "$dir/torrent/index.port")"
      NOTESD_TORRENT_APIBAY_URL=off NOTESD_TORRENT_EZTV_URL=off NOTESD_TORRENT_YTS_URL=off NOTESD_TORRENT_MIN_SEEDS=1
      NOTESD_TORRENT_TORRENTSDB_URL=off NOTESD_TORRENT_PEERFLIX_URL=off
    )
```
and the `else` line (:344). Before:
```sh
    env+=(NOTESD_TORRENT_TORRENTIO_URL=off NOTESD_TORRENT_APIBAY_URL=off NOTESD_TORRENT_EZTV_URL=off NOTESD_TORRENT_YTS_URL=off)
```
After:
```sh
    env+=(NOTESD_TORRENT_TORRENTIO_URL=off NOTESD_TORRENT_APIBAY_URL=off NOTESD_TORRENT_EZTV_URL=off NOTESD_TORRENT_YTS_URL=off)
    env+=(NOTESD_TORRENT_TORRENTSDB_URL=off NOTESD_TORRENT_PEERFLIX_URL=off)
```
(The new names go on their own line in each branch so phase 2 can add its three on another line without touching these.)
**Impact:** the throwaway's attempt lists stay exactly as today (`codenames.sh:69` asserts every attempt of a torrent-only
`no_source` is an `Index:` one and the first is `Index: torrentio`; `speed.sh` reads `Index: torrentio`): an index set
`off` has no attempt. `fake-index.mjs` is not changed.

### Step 14: Configuration reference rows
**File:** `docs/guide/reference/configuration.md`, after line 180 (the `NOTESD_TORRENT_YTS_URL` row), before the
`NOTESD_TORRENT_1337X_ORIGIN` row. Insert:
```markdown
| `NOTESD_TORRENT_TORRENTSDB_URL` | the finder's own (TorrentsDB) | Address of the TorrentsDB Stremio add-on, asked by IMDb id for every film and episode beside Torrentio; it lists sites Torrentio does not. `off` never asks it. `verify.sh` sets it `off`. |
| `NOTESD_TORRENT_PEERFLIX_URL` | the finder's own (Peerflix) | Address of the Peerflix Stremio add-on, asked only for a title whose original language is Spanish (it lists Spanish releases, nearly all dubs). `off` never asks it. `verify.sh` sets it `off`. |
```
(Phase 2 adds its three rows after these two.)

### Step 15: The streaming guide's index list
**File:** `docs/guide/streaming.md:1800-1801` ("Finding a torrent"). Before:
```markdown
  title's IMDb id and within its own timeout: Torrentio, apibay, EZTV for a series and YTS for a film (each can be turned off or
  moved with `NOTESD_TORRENT_<NAME>_URL`; YTS, which timed out from this network once, is given 6 s). Every request says it is notesd; a bot check is the outcome
```
After:
```markdown
  title's IMDb id and within its own timeout: Torrentio, apibay, EZTV for a series, TorrentsDB, Peerflix for a title made
  in Spanish, and YTS for a film (each can be turned off or moved with `NOTESD_TORRENT_<NAME>_URL`; YTS, which timed out
  from this network once, is given 6 s). TorrentsDB and Peerflix are Stremio add-ons that answer in Torrentio's shape.
  TorrentsDB lists sites Torrentio does not (knaben, rargb, sktorrent, rutor); a torrent two indexes list is one
  candidate naming both. Peerflix lists Spanish releases, nearly all dubs, so for a title made in any other language it
  gets no request and its attempt is `no_stream`, "not asked". Every request says it is notesd; a bot check is the outcome
```

### Step 16: Feature map
**File:** `.claude/skills/verify-notesd/features/direct-streaming.md`, after line 436 (the end of the "Finding a torrent (phase
2's finder, ...)" bullet, which ends `every request sent as notesd).`). Insert:
```markdown
- The Stremio add-on providers beside Torrentio: TorrentsDB for every title, Peerflix only for a title made in Spanish.
  `npx vitest run tests/unit/directStream/torrent/find/indexes.test.ts tests/unit/directStream/torrent/find/findCandidates.test.ts tests/unit/directStream/torrent/find/addonSwitches.test.ts tests/unit/config.torrentFinder.test.ts`
  over their recorded answers (`tests/fixtures/torrent/{torrentsdb,peerflix}-movie-shawshank.json`): a torrent Torrentio
  and TorrentsDB both list is one candidate with both in `listedBy`; Peerflix gets no request for any other language and
  its attempt says `not asked`; a provider's bot check, timeout or failure is its own attempt and the others still answer;
  `NOTESD_TORRENT_TORRENTSDB_URL=off` / `NOTESD_TORRENT_PEERFLIX_URL=off` send nothing. Every throwaway daemon sets both
  `off`, so its attempt lists are unchanged.
```

### Step 17: CLAUDE.md
**File:** `CLAUDE.md`, under "Direct streaming", insert a new bullet immediately **before** line 116 (the bullet that starts
`  - A torrent is chosen by its swarm, not by the index's seed count`):
```markdown
  - The JSON torrent indexes are asked by IMDb id side by side (`defaultIndexes`, `find/find.ts`). TorrentsDB and Peerflix are Stremio add-ons read by Torrentio's reader (`stremioAddonIndex`, `find/torrentio.ts`); Peerflix lists Spanish releases, nearly all dubs, and is asked only for a title made in Spanish. A new index gets its name in `TORRENT_INDEX_NAMES`, its `NOTESD_TORRENT_<NAME>_URL` in `TORRENT_INDEX_URL_KEYS` with a configuration row, and is set to a fake or `off` on both of `verify.sh`'s index lines (a test checks it).
```

## Principles applied

- Subtract before you add: `readTorrentioStream` is renamed to `readStremioStream` rather than kept beside a new alias (its only caller is in its own file), and Torrentio's own address/answer code is folded into `stremioAddonIndex` instead of copied twice for the new providers (Step 1).
- Laziness protocol: the two providers are one-call modules over the shared builder; Peerflix's language gate is a `skip` option of that builder, not a new `TorrentIndex` field or a change to `findCandidates`' filtering (Steps 1-3). `indexesOf` already filters any `off` name, so its body is not changed (Step 7).
- Encode lessons in structure: Invariant 3 (no throwaway daemon reaches a real index) was a comment in `verify.sh`; it is now a unit test that fails when a `TORRENT_INDEX_URL_KEYS` entry is not on both of verify.sh's index lines (Steps 6b, 12b, 13). It catches phase 2's three new keys too.
- Test behavior, not implementation: R2.4 is proven from the env strings through `parseTorrentFinder` and the daemon's own `indexesOf` to the requests sent, not by inspecting the index list alone (Step 11; `indexesOf` is exported for that).
- Prove it works: J5 drives the real `findCandidates` with the global `fetch` over loopback HTTP against the recorded TorrentsDB answer, configured through the real settings parser.

## Verification

**Build:** `cd /home/miftah/.worktrees/mcp-notes/wider-torrent-sources && npm run typecheck`
**Tests:** `npm test` (includes `tests/unit/docs/reference.test.ts`); and `npm run docs:check` exits 0.
**Proof:** the finder's behaviour is proven by unit drives with an injected fetch (no network), and by one loopback HTTP
drive of the real finder with the global fetch.
- Harness: `.claude/skills/verify-notesd` — used for the neighbor check only: the throwaway daemon sets both new providers
  `off` (Step 13), so it cannot show them answering; J5 runs the real finder over loopback HTTP instead.
- Feature-map entries: `.claude/skills/verify-notesd/features/direct-streaming.md` ("Playing from a torrent")
- Journeys:
  - **J1** · traces R2.1 — `cd /home/miftah/.worktrees/mcp-notes/wider-torrent-sources && npx vitest run tests/unit/directStream/torrent/find/findCandidates.test.ts tests/unit/directStream/torrent/find/indexes.test.ts -t "TorrentsDB|torrentsdb|Torrentio, apibay"` → passes when every selected test passes, among them "asks TorrentsDB and joins its listing of a torrent with the other indexes' by info hash" (one candidate for `a779fa75…` with `listedBy` `['torrentio', 'torrentsdb', 'yts']`, a TorrentsDB-only hash with `listedBy` `['torrentsdb']`) and the torrentsdb reader tests over the recorded answer (4 candidates, upper-case hashes lower-cased, site `rargb`, its trackers kept)
  - **J2** · traces R2.2 — `npx vitest run tests/unit/directStream/torrent/find/findCandidates.test.ts tests/unit/directStream/torrent/find/indexes.test.ts -t "Peerflix|peerflix"` → passes when every selected test passes: for `originalLanguage: 'es'` the fake fetch records `https://addon.peerflix.mov/stream/movie/tt0457430.json` and the Peerflix row is a candidate with `listedBy` `['peerflix']`; for `'en'`, `'pt'` and `null` the recorded URL list holds no `peerflix` address and the attempt is `empty` with a detail starting `not asked: `
  - **J3** · traces R2.3 — `npx vitest run tests/unit/directStream/torrent/find/findCandidates.test.ts -t "bot check, timeout or failure"` → passes when the test passes: attempts `torrentsdb` `bot_check`, `peerflix` `error` "timed out after …", then `torrentsdb` `error` "HTTP 500" and `peerflix` `error` "fetch failed", and in both runs the candidates are exactly Torrentio's `[hash(1)]`
  - **J4** · traces R2.4 — `npx vitest run tests/unit/directStream/torrent/find/addonSwitches.test.ts tests/unit/config.torrentFinder.test.ts` → passes when all tests pass: with `NOTESD_TORRENT_TORRENTSDB_URL=off` and `NOTESD_TORRENT_PEERFLIX_URL=OFF` the daemon's `indexesOf` lists `['torrentio', 'apibay', 'eztv', 'yts']`, a Spanish-original query sends no URL containing `torrentsdb` or `peerflix`, its attempts are `['torrentio', 'apibay', 'yts']`; and verify.sh names both keys on both index lines
  - **J5** · traces R2.1, R2.2, R2.4 — run the script in **J5 drive** below (the real finder, the real settings parser and the global `fetch` against a loopback server serving the recorded TorrentsDB answer; no outside network) → passes when the printed JSON shows: `on.attempts` = `[["torrentio","ok",1],["torrentsdb","ok",4],["peerflix","empty",0]]`; `on.joined` = `[["32770c6dd35a4dd71deb80d5deff7a4e084eedab",["torrentio","torrentsdb"]]]`; `on.requests` holds exactly the `/tio/...tt0111161.json` and `/tdb/...tt0111161.json` paths, none under `/pfx`, each with user agent `notesd (personal notes daemon; torrent index lookup)`; `off.attempts` = `["torrentio"]` and `off.requests` holds only the `/tio/...tt0457430.json` path (no `/tdb`, no `/pfx`, though the title is Spanish)
- Neighbor check (Torrentio's reader was generalized; the throwaway daemon's torrent plays must read the same attempts):
  `npx vitest run tests/unit/directStream/torrent tests/unit/directStream/torrentSource.test.ts tests/unit/directStream/torrentRotation.test.ts tests/unit/directStream/torrentPlay.test.ts` passes with the three torrentio tests of `indexes.test.ts` unchanged; then `V=.claude/skills/verify-notesd/scripts/verify.sh; $V up --torrent` (note RUN), `.claude/skills/verify-notesd/scripts/direct-stream/torrent.sh RUN fallback named` ends with its PASS line, `grep -rlE 'Index: (torrentsdb|peerflix)' ~/.local/state/notesd-verify/RUN/` prints nothing (exit 1: both providers are `off` there, so no attempt names them), then `$V down RUN`.
- Cost: none (no LLM turn, no paid service; no outside network).

**J5 drive** (copy as is; the heredoc terminator must start its line):

```sh
cd /home/miftah/.worktrees/mcp-notes/wider-torrent-sources
D=$(mktemp -d) && cat > "$D/drive.mts" <<'EOF'
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { parseTorrentFinder } from '/home/miftah/.worktrees/mcp-notes/wider-torrent-sources/src/config.ts';
import { findCandidates } from '/home/miftah/.worktrees/mcp-notes/wider-torrent-sources/src/directStream/torrent/find/find.ts';
import { indexesOf } from '/home/miftah/.worktrees/mcp-notes/wider-torrent-sources/src/directStream/torrent/source.ts';
const tdb = readFileSync('/home/miftah/.worktrees/mcp-notes/wider-torrent-sources/tests/fixtures/torrent/torrentsdb-movie-shawshank.json', 'utf8');
const tio = JSON.stringify({ streams: [{ name: 'Torrentio\n4k', title: 'The.Shawshank.Redemption.1994.2160p.BluRay.REMUX.HEVC.DTS-HD.MA.5.1-FGT\n👤 120 💾 57.98 GB ⚙️ RARBG', infoHash: '32770c6dd35a4dd71deb80d5deff7a4e084eedab' }] });
const seen: string[] = [];
const server = http.createServer((req, res) => {
  seen.push(String(req.url) + ' ' + String(req.headers['user-agent']));
  res.setHeader('content-type', 'application/json');
  if (req.url === '/tdb/stream/movie/tt0111161.json') return void res.end(tdb);
  if (req.url === '/tio/stream/movie/tt0111161.json' || req.url === '/tio/stream/movie/tt0457430.json') return void res.end(tio);
  res.end('{"streams":[]}');
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
// The three title-search keys are phase 2's; parseTorrentFinder ignores them until phase 2 lands, and after it they keep
// a re-run of this drive (a verifier's, once the whole set is in) from asking a real index (Invariant 3).
const env = { NOTESD_TORRENT_TORRENTIO_URL: base + '/tio', NOTESD_TORRENT_TORRENTSDB_URL: base + '/tdb', NOTESD_TORRENT_PEERFLIX_URL: base + '/pfx', NOTESD_TORRENT_APIBAY_URL: 'off', NOTESD_TORRENT_EZTV_URL: 'off', NOTESD_TORRENT_YTS_URL: 'off', NOTESD_TORRENT_KNABEN_URL: 'off', NOTESD_TORRENT_BITSEARCH_URL: 'off', NOTESD_TORRENT_TORRENTSCSV_URL: 'off' };
const film = { kind: 'movie' as const, imdbId: 'tt0111161', title: 'The Shawshank Redemption', year: 1994, originalLanguage: 'en' };
const on = await findCandidates(film, { indexes: indexesOf(parseTorrentFinder(env)), maxSizeBytes: 100 * 1024 ** 3 });
const onSeen = seen.splice(0);
const spanish = { kind: 'movie' as const, imdbId: 'tt0457430', title: "Pan's Labyrinth", originalTitle: 'El laberinto del fauno', year: 2006, originalLanguage: 'es' };
const off = await findCandidates(spanish, { indexes: indexesOf(parseTorrentFinder({ ...env, NOTESD_TORRENT_TORRENTSDB_URL: 'off', NOTESD_TORRENT_PEERFLIX_URL: 'off' })) });
const offSeen = seen.splice(0);
server.close();
console.log(JSON.stringify({
  on: { attempts: on.indexes.map((a) => [a.index, a.outcome, a.listed]), joined: on.candidates.filter((c) => c.listedBy.length > 1).map((c) => [c.infoHash, c.listedBy]), requests: onSeen },
  off: { attempts: off.indexes.map((a) => a.index), requests: offSeen },
}, null, 1));
EOF
npx tsx "$D/drive.mts"; rm -rf "$D"
```

**Exit criteria:** with default settings `indexesOf(parseTorrentFinder({}))` names torrentio, apibay, eztv, torrentsdb, peerflix,
yts; J1-J5 pass; `npm run typecheck`, `npm test` and `npm run docs:check` pass.

## Handoffs

- Phase 2 (R1), as reconciled: its plan now quotes this phase's after-state (imports, `IndexBases`, `defaultIndexes`, the
  renamed film test, the new Peerflix / add-on failure tests and `addonSwitches.test.ts`), puts its three keys on a line of
  its own in **both** `verify.sh` branches, and names this phase's two keys in loadConfig's key-list comment. The note below
  is what it was told:
- Phase 2 (R1): extends the registry lines as this phase leaves them: `IndexBases`/`DEFAULT_INDEX_BASES`/`defaultIndexes`
  (after `peerflixIndex(...)`, before the `yts` push, or wherever it decides), `TORRENT_INDEX_NAMES` (append after
  `'peerflix'`), `TORRENT_INDEX_URL_KEYS` (now exported). Its three keys **must** go on both of `verify.sh`'s index lines,
  or `tests/unit/config.torrentFinder.test.ts` fails (Step 12b). Its configuration rows go after the two added here.
  Its title-search indexes added to `defaultIndexes` will again change the attempt lists asserted in
  `findCandidates.test.ts` tests "asks Torrentio, apibay, TorrentsDB and YTS ...", "asks Torrentio, apibay and EZTV for an
  episode ...", "records an index that times out ...", "records an index that fails ...", and the new
  "asks Peerflix for a title made in Spanish ..." and "bot check, timeout or failure" tests, and the default list in
  `addonSwitches.test.ts` ("are among the default indexes"); phase 2 updates those expectations.
- Phase 2 owns the `IndexFetch`/`FetchLike` method+body change; nothing here needs it (both add-ons are GET).
- Phase 3 (R3): nothing from this phase; the shared files are edited in different regions (CLAUDE.md bullet before :116,
  configuration.md rows after :180, streaming.md :1800-1801, feature-map bullet after :436, verify.sh :334-345).
- Not done, noted for whoever wants it: Peerflix's `not asked` attempt appears in every non-Spanish torrent play's attempt
  list as `Index: peerflix` `no_stream`. Dropping it from the list would need a language field on `TorrentIndex` filtered in
  `findCandidates`; the index chose the visible `empty` answer, so this phase keeps it.

## Rollback

Revert this phase's commit(s). At run time without a revert: `NOTESD_TORRENT_TORRENTSDB_URL=off` and
`NOTESD_TORRENT_PEERFLIX_URL=off` in `.env.local`, then `scripts/install.sh --wait` to restart the daemon when idle.
