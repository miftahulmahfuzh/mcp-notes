> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/torrent-stream-source/PLAN.md` phase 2. Source: `.workflows/plan/torrent-stream-source/phase-2.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 2: Finding and ranking torrents

**Plan set:** `TORRENT_STREAM_SOURCE_PLAN.md`
**Analysis:** `.workflows/analyze/20261116-192341-T7QK_code_analyzer.md`
**Satisfies:** R1 — "finding the relevant torrent file … the top torrent file with a high seeds number"
**Criteria:** R1.1, R1.2, R1.3, R1.4, R1.5
**Depends on:** none
**Difficulty:** NORMAL
**Package:** `src/directStream/torrent/find`

---

## Goal

After this phase, `findCandidates(query, options)` asks the JSON torrent indexes (Torrentio, apibay,
EZTV for a series, YTS for a film) by IMDb id, all at once, each with its own timeout and always as
a plain `notesd` request. It answers a ranked list of torrent candidates with dubs, cinema recordings,
3D, other titles, other episodes, torrents under the seed floor and oversized single files left out,
plus each index's outcome. `pickFile(files, query)` picks the video (a pack's episode file, else the
largest video, never a sample) and its subtitle files from a torrent's file list. Nothing is wired
into the daemon. That is phase 3's job.

## Interface Contract

The reconciler reads this section to detect cross-phase conflicts. Be exact and exhaustive.

**Deletes:** nothing
**Renames:** nothing
**Creates** (all new, all under `src/directStream/torrent/find/`, all re-exported by `find/index.ts`):
- `types.ts`: `TorrentQuery` (union: `{ kind: 'movie', imdbId, title?, originalTitle?, year?, originalLanguage? }` | `{ kind: 'tv', …same, season, episode, absoluteEpisode? }`), `TvQuery`, `ReleaseHeight`, `VideoCodec`, `AudioCodec`, `Container`, `ReleaseSource`, `ReleaseInfo` (`height`, `videoCodec`, `audioCodec`, `container`, `source`, `languages`, `multiAudio`, `dubbed`, `cam`, `threeD`, `season`, `seasonTo`, `episode`, `episodeTo`, `complete`, `pack`, `direct`), `ReleaseHints`, `IndexRow`, `TorrentCandidate` (`infoHash`, `name`, `fileName`, `fileIdx`, `seeds`, `sizeBytes`, `index`, `listedBy`, `site`, `trackers`, `scoped`, `release`), `IndexOutcome` (`'ok' | 'empty' | 'error' | 'bot_check'`), `IndexAnswer`, `IndexFetch`, `IndexContext` (`{ fetch, signal }`), `TorrentIndex` (`{ name, kinds?, timeoutMs?, find(query, ctx) }`), `FetchLike`, `IndexAttempt` (`{ index, outcome, detail, took_s, listed }`), `ExcludeReason`, `ExcludedCandidate`, `FoundCandidates` (`{ candidates, indexes, excluded }`), `TorrentFileLike` (`{ index, path, length }`), `FilePick` (`{ video, subtitles }`).
- `release.ts`: `parseRelease(name, context?)`, `parseEpisodeRef(text)`, `episodeFit(name, fileName, season, episode)`, `covers`, `baseName`, `stripExtension`, `extensionOf`, `VIDEO_EXTENSIONS`, `SUBTITLE_EXTENSIONS`, types `ReleaseContext`, `EpisodeRef`, `EpisodeFit`.
- `candidate.ts`: `candidateFrom(row, index, query, scoped?)`, `answerOf`, `normalizeInfoHash`, `isUsableHash`, `normalizeImdbId`, `DEFAULT_TRACKERS`, `YTS_HINTS`.
- `http.ts`: `getIndexJson(ctx, url)`, `isBotCheck`, `failedAnswer`, `asRecord`, `asList`, `asText`, `asCount`, `parseSizeText`, `trackersFromMagnet`, type `JsonAnswer`.
- `rank.ts`: `rankCandidates`, `compareCandidates`, `exclusionOf`, `RankSettings`, `DEFAULT_RANK_SETTINGS`, `DEFAULT_MIN_SEEDS` (5), `DEFAULT_GOOD_SEEDS` (20), `DEFAULT_MAX_SIZE_BYTES` (25 GiB), `HEIGHT_PREFERENCE`, `Ranked`.
- `pickFile.ts`: `pickFile(files, query)`, `MIN_VIDEO_BYTES` (50 MiB).
- `torrentio.ts`: `torrentioIndex(base)`, `readTorrentioStream`. `apibay.ts`: `apibayIndex(base)`. `eztv.ts`: `eztvIndex(base)`, `EZTV_PAGE_LIMIT`, `EZTV_MAX_PAGES`. `yts.ts`: `ytsIndex(base)`, `DEFAULT_YTS_TIMEOUT_MS` (6 s).
- `find.ts`: `findCandidates(query, options?) → Promise<FoundCandidates>`, `defaultIndexes(options?)`, `FindOptions`, `IndexBases`, `DEFAULT_INDEX_BASES`, `TORRENT_INDEX_USER_AGENT`, `DEFAULT_INDEX_TIMEOUT_MS` (10 s), `DEFAULT_MAX_CANDIDATES` (20).
- `index.ts`: barrel. **Other phases import from `src/directStream/torrent/find/index.js`.**

**Signature changes:** none (all new). Against the index's shared contract:
- `TorrentCandidate`: every contract field is kept, with `fileName`/`fileIdx` set to `null` when the index does not name the file. Added: `listedBy`, `site`, `scoped`.
- `ReleaseInfo`: every contract field is kept. Added: `languages`, `multiAudio`, `seasonTo`, `episodeTo`, `complete`.
- `TorrentIndex.find(query, { fetch, signal })`: kept. Added: optional `kinds` and `timeoutMs`.
- `findCandidates` returns `{ candidates, indexes }` as the contract says, plus `excluded`. The query is a union: a `tv` query must carry `season` and `episode`. It adds `originalTitle`, `originalLanguage` and `absoluteEpisode`.
- `pickFile(files, query)`: kept.
- `parseRelease(name)`: kept. It adds an optional second argument `{ originalLanguage, title, originalTitle, fileName, hints }`.

**Requires (from earlier phases):** nothing.
**Leaves alone (owned by others):** every file outside `src/directStream/torrent/find/`, `tests/unit/directStream/torrent/find/` and `tests/fixtures/torrent/`. In particular `src/config.ts` and `src/daemon.ts` (phases 1 and 3), `src/directStream/torrent/{engine,store,service,types,serve}.ts` (phase 1), `torrent/source.ts` and `torrent/probe.ts` (phase 3), `claude/streaming/torrent/` (phase 9), `docs/guide/streaming.md` and `.claude/skills/verify-notesd/features/direct-streaming.md` (handed to phase 3, see Handoffs).

## Files

| File | Action | What changes |
|---|---|---|
| `tests/fixtures/torrent/torrentio-movie-sintel.json` | create | copy of the probed Torrentio answer for Sintel (32 streams) |
| `tests/fixtures/torrent/torrentio-series-bb-s01e01.json` | create | 18 streams cut from the probed Breaking Bad S01E01 answer |
| `tests/fixtures/torrent/apibay-sintel.json` | create | copy of the probed apibay answer for Sintel (19 rows) |
| `tests/fixtures/torrent/apibay-empty.json` | create | apibay's "No results returned" placeholder |
| `tests/fixtures/torrent/eztv-page.json` | create | copy of the probed EZTV page (3 rows) |
| `tests/fixtures/torrent/yts-sintel.json` | create | hand-written in YTS's documented `list_movies` shape (YTS timed out from this network, so nothing was probed) |
| `tests/fixtures/torrent/cloudflare-challenge.html` | create | a minimal Cloudflare challenge page |
| `src/directStream/torrent/find/types.ts` | create | the shapes |
| `src/directStream/torrent/find/release.ts` | create | release-name reader, episode reader, episode fit |
| `src/directStream/torrent/find/candidate.ts` | create | row to candidate, hash and IMDb id normalizing, default trackers |
| `src/directStream/torrent/find/http.ts` | create | one JSON GET per index answer, bot-check detection, JSON field readers |
| `src/directStream/torrent/find/torrentio.ts` | create | Torrentio index |
| `src/directStream/torrent/find/apibay.ts` | create | apibay index |
| `src/directStream/torrent/find/eztv.ts` | create | EZTV index (series only) |
| `src/directStream/torrent/find/yts.ts` | create | YTS index (films only) |
| `src/directStream/torrent/find/rank.ts` | create | dedupe, exclusions, ordering |
| `src/directStream/torrent/find/pickFile.ts` | create | the video and subtitle files of a torrent |
| `src/directStream/torrent/find/find.ts` | create | `findCandidates`, parallel asks, timeouts, User-Agent, fallback |
| `src/directStream/torrent/find/index.ts` | create | barrel |
| `tests/unit/directStream/torrent/find/release.test.ts` | create | R1.3, R1.4 parsing |
| `tests/unit/directStream/torrent/find/rank.test.ts` | create | R1.2 |
| `tests/unit/directStream/torrent/find/pickFile.test.ts` | create | R1.4 |
| `tests/unit/directStream/torrent/find/indexes.test.ts` | create | R1.1, R1.5, per index |
| `tests/unit/directStream/torrent/find/findCandidates.test.ts` | create | R1.1–R1.5 end to end over recorded answers |

No existing file is modified. Every source file is new, so its line reference is `:1`.

## Implementation Steps

### Step 1: Fixtures from the probed answers
**File:** `tests/fixtures/torrent/` (new directory)
**Change:** Copy three probed answers whole. Cut 18 streams from the 178 KB series answer, chosen by
position in the probed file so the cut is exact. Write the three hand-made files below. Run from the
worktree root:

```sh
cd /home/miftah/.worktrees/mcp-notes/torrent-stream-source
mkdir -p tests/fixtures/torrent
S=.workflows/analyze/torrent-samples
cp $S/torrentio-movie-sintel.json tests/fixtures/torrent/torrentio-movie-sintel.json
cp $S/apibay.json tests/fixtures/torrent/apibay-sintel.json
cp $S/eztv.json tests/fixtures/torrent/eztv-page.json
node -e '
const fs = require("fs");
const src = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const keep = [4, 17, 18, 19, 21, 23, 27, 33, 34, 44, 55, 72, 81, 111, 113, 117, 163, 187];
fs.writeFileSync(process.argv[2], JSON.stringify({ streams: keep.map((i) => src.streams[i]) }, null, 1) + "\n");
' $S/torrentio-series-s01e01.json tests/fixtures/torrent/torrentio-series-bb-s01e01.json
node -e 'const s=require("./tests/fixtures/torrent/torrentio-series-bb-s01e01.json").streams; if (s.length!==18||s[1].infoHash!=="6bbad06245a0d631b0a5e47c8cd6e5abc9a70211") process.exit(1); console.log("cut ok")'
```

The cut keeps these rows of the probed answer (each one's role in the tests is in brackets):
4 XEBEC 2160p single [kept, 2160p tier], 17 PSA season pack 647 seeds [kept, first], 18 QxR S01–S05
[kept, `fileIdx` 245], 19 Rutracker "Dub … + Original (Eng)" [kept, multi-audio], 21 RARBG x265 mp4
[kept, not direct], 23 ENG-ITA Multisub [kept, multi-audio], 27 G66 ITA-ENG [kept], 33 OPUS S01–S05
[kept], 34 "Full 1080p PT-BR" [dubbed], 44 Dual Audio Hindi+Eng [kept], 55 FRENCH + VOSTFR [kept,
multi-audio], 72 Breaking In [other title], 81 3D SBS [3D], 111 Hindi-English [kept, 720p], 113
"dublado" [dubbed], 117 MULTi VOSTFR+FRENCH [kept], 163 "PT-BR Legendado" 0 seeds [few seeds: the
Portuguese is a subtitle], 187 "Saison 1 FRENCH" [dubbed].

`tests/fixtures/torrent/apibay-empty.json`:
```json
[{"id":"0","name":"No results returned","info_hash":"0000000000000000000000000000000000000000","leechers":"0","seeders":"0","num_files":"0","size":"0","username":"","added":"0","status":"member","category":"0","imdb":""}]
```

`tests/fixtures/torrent/yts-sintel.json` follows YTS's documented `list_movies` shape. It is
hand-written: the 720p hash is the real YTS release Torrentio lists, and the 1080p and 3D hashes are
made up for the test.
```json
{
 "status": "ok",
 "status_message": "Query was successful",
 "data": {
  "movie_count": 2,
  "limit": 20,
  "page_number": 1,
  "movies": [
   {
    "id": 2468,
    "imdb_code": "tt1727587",
    "title": "Sintel",
    "title_long": "Sintel (2010)",
    "year": 2010,
    "language": "en",
    "torrents": [
     {"hash": "A779FA758F2229586EEBC2E5960EB32FE5659596", "quality": "720p", "type": "bluray", "video_codec": "x264", "seeds": 30, "peers": 2, "size": "136.47 MB", "size_bytes": 143099167},
     {"hash": "B9C4E2D4C0F43A5D1E8F7A6B5C4D3E2F1A0B9C8D", "quality": "1080p", "type": "bluray", "video_codec": "x264", "seeds": 12, "peers": 1, "size": "258.4 MB", "size_bytes": 270951219},
     {"hash": "3D0000000000000000000000000000000000AB3D", "quality": "3D", "type": "bluray", "video_codec": "x264", "seeds": 9, "peers": 0, "size": "258.4 MB", "size_bytes": 270951219}
    ]
   },
   {
    "id": 9999,
    "imdb_code": "tt9999999",
    "title": "Sintel: The Making Of",
    "title_long": "Sintel: The Making Of (2011)",
    "year": 2011,
    "language": "en",
    "torrents": [
     {"hash": "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", "quality": "720p", "type": "web", "video_codec": "x264", "seeds": 50, "peers": 0, "size": "100 MB", "size_bytes": 104857600}
    ]
   }
  ]
 }
}
```

`tests/fixtures/torrent/cloudflare-challenge.html`:
```html
<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body><div id="challenge-platform"></div><script>window._cf_chl_opt={cvId:'3',cType:'managed'};</script></body></html>
```
**Impact:** test data only.

### Step 2: The shapes
**File:** `src/directStream/torrent/find/types.ts:1` (new)
**Code:**
```ts
/**
 * The torrent finder's shapes (TORRENT_STREAM_SOURCE_PLAN phase 2). An index's JSON is read once, in
 * that index's module, into an IndexRow; candidateFrom (candidate.ts) turns a row into a
 * TorrentCandidate with a normalized info hash and a parsed release. Everything after that trusts
 * the candidate. Nothing here reads settings: findCandidates takes plain options with defaults.
 */

interface QueryCommon {
  /** `tt` and at least seven digits; findCandidates normalizes it once. */
  imdbId: string;
  /** The title's English name. When set, a release that names neither it nor `originalTitle` is left out. */
  title?: string | null;
  originalTitle?: string | null;
  year?: number | null;
  /** ISO 639-1 code of the title's original language. Null or absent: only an explicit dub marker leaves a release out. */
  originalLanguage?: string | null;
}

/** What to find: a film, or one episode of a series (TMDB's season and episode). A series without an episode cannot be built. */
export type TorrentQuery =
  | (QueryCommon & { kind: 'movie' })
  | (QueryCommon & {
      kind: 'tv';
      season: number;
      episode: number;
      /** The episode's number counted over the whole series (anime); read by pickFile only. */
      absoluteEpisode?: number | null;
    });

export type TvQuery = Extract<TorrentQuery, { kind: 'tv' }>;

/** Nominal picture height: 2160 for 4K/UHD, 1080, 720, 480 for SD and anything smaller. */
export type ReleaseHeight = 2160 | 1080 | 720 | 480;
export type VideoCodec = 'h264' | 'hevc' | 'av1' | 'vp9' | 'xvid';
export type AudioCodec = 'aac' | 'ac3' | 'eac3' | 'dts' | 'truehd' | 'flac' | 'opus' | 'mp3';
export type Container = 'mp4' | 'mkv' | 'avi' | 'webm' | 'other';
export type ReleaseSource = 'cam' | 'telesync' | 'telecine' | 'web' | 'bluray' | 'hdtv' | 'dvd';

/** What a release name (and the file name, when the index gave it) says. parseRelease builds it. */
export interface ReleaseInfo {
  height: ReleaseHeight | null;
  videoCodec: VideoCodec | null;
  audioCodec: AudioCodec | null;
  container: Container | null;
  source: ReleaseSource | null;
  /** ISO 639-1 codes the name gives as audio (subtitle languages are not counted), sorted. */
  languages: string[];
  /** More than one audio track: MULTI, DUAL, two languages, a dub next to the original. Chrome would play the first track. */
  multiAudio: boolean;
  /** A dub without the original track. Never a candidate. */
  dubbed: boolean;
  /** A cinema recording: CAM, TS/TELESYNC, TC/TELECINE. Never a candidate. */
  cam: boolean;
  threeD: boolean;
  /** The file's season when the file names its episode, else the first season the release names. */
  season: number | null;
  /** The last season of a multi-season pack. */
  seasonTo: number | null;
  episode: number | null;
  episodeTo: number | null;
  /** The release says COMPLETE / Integrale / Box Set. */
  complete: boolean;
  /** The torrent holds more than one episode. */
  pack: boolean;
  /** Chrome plays it as is, as far as the names say: H.264, AAC, MP4, one audio track, not a dub. */
  direct: boolean;
}

/** What an index knows beyond the name (YTS ships MP4 with AAC). Wins over the name. */
export type ReleaseHints = Partial<Pick<ReleaseInfo, 'container' | 'audioCodec' | 'videoCodec' | 'height' | 'threeD'>>;

/** One torrent as an index listed it, read from its JSON. */
export interface IndexRow {
  /** 40 hex or 32 base32 characters, any case. */
  infoHash: string;
  name: string;
  fileName?: string | null;
  fileIdx?: number | null;
  seeds: number;
  sizeBytes: number | null;
  trackers?: readonly string[];
  /** The site the listing comes from (Torrentio aggregates: "YTS", "1337x", "ThePirateBay"). */
  site?: string | null;
  hints?: ReleaseHints;
}

export interface TorrentCandidate {
  /** 40 lower-case hex characters (rank leaves out anything else). */
  infoHash: string;
  /** The release name. */
  name: string;
  /** The video file the index named (a pack's episode file); null when it named none. */
  fileName: string | null;
  fileIdx: number | null;
  seeds: number;
  /** For a pack, often the whole torrent. Null when unknown. */
  sizeBytes: number | null;
  /** The index that gave the richest listing. */
  index: string;
  /** Every index that listed this info hash, in the order they were asked. */
  listedBy: string[];
  site: string | null;
  /** The index's trackers followed by DEFAULT_TRACKERS, without repeats. */
  trackers: string[];
  /** The index answered for this exact episode (Torrentio's series address), so a name that says nothing still fits. */
  scoped: boolean;
  release: ReleaseInfo;
}

export type IndexOutcome = 'ok' | 'empty' | 'error' | 'bot_check';

export interface IndexAnswer {
  outcome: IndexOutcome;
  detail: string;
  candidates: TorrentCandidate[];
}

/**
 * The only fetch an index gets. findCandidates builds it: it sets notesd's User-Agent last (an
 * index cannot replace it) and binds the index's timeout signal.
 */
export type IndexFetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;

export interface IndexContext {
  fetch: IndexFetch;
  /** Aborted when the index's time is up or the caller gives up. */
  signal: AbortSignal;
}

export interface TorrentIndex {
  /** Lower case; an attempt and a candidate's `index` carry it. */
  name: string;
  /** The kinds it lists; absent: both. */
  kinds?: ReadonlyArray<TorrentQuery['kind']>;
  /**
   * A shorter limit than findCandidates' timeoutMs; the shorter of the two applies. A `fallback` index's own limit
   * applies even when it is longer (phase 9's browser-driven sites need about 40 s).
   */
  timeoutMs?: number;
  find(query: TorrentQuery, ctx: IndexContext): Promise<IndexAnswer>;
}

/** What findCandidates calls. The global fetch fits. */
export type FetchLike = (url: string, init: { headers: Headers; signal: AbortSignal }) => Promise<Response>;

/** One index's outcome; phase 3 turns it into a ResolveAttempt named `Index: <index>`. */
export interface IndexAttempt {
  index: string;
  outcome: IndexOutcome;
  detail: string;
  took_s: number;
  /** Candidates the index answered, before dedupe and exclusions. */
  listed: number;
}

export type ExcludeReason = 'bad_hash' | 'other_title' | 'dubbed' | 'cam' | 'three_d' | 'other_episode' | 'few_seeds' | 'too_big';

export interface ExcludedCandidate {
  infoHash: string;
  name: string;
  index: string;
  seeds: number;
  reason: ExcludeReason;
}

export interface FoundCandidates {
  /** Ranked best first, at most `maxCandidates`. */
  candidates: TorrentCandidate[];
  indexes: IndexAttempt[];
  excluded: ExcludedCandidate[];
}

/** A file inside a torrent; phase 1's TorrentFileInfo fits. `path` is relative to the torrent, `/` or `\` separated. */
export interface TorrentFileLike {
  index: number;
  path: string;
  length: number;
}

export interface FilePick {
  video: number;
  /** .srt/.vtt/.ass/.ssa files beside the video or in a Subs folder; for a pack, only the episode's. */
  subtitles: number[];
}
```
**Impact:** none outside the folder.

### Step 3: The release-name reader
**File:** `src/directStream/torrent/find/release.ts:1` (new)
**Change:** A pure reader. It turns a name into tokens: accents are dropped, everything but letters,
digits, Cyrillic and `-` becomes a space, and split words such as `WEB-DL`, `H 265`, `PT-BR`,
`Dual-Audio` and `Half-SBS` are joined. Dub, cam, 3D and language markers are read only after the
title: after the asked title's words when they start the name, else from the first year, quality,
codec or season word. A subtitle word (`SUB`, `ESUB`, `Subs`, `Legendado`) takes the languages after
it out of the audio languages. A plural (`NL Subs`, `PT-BR Legendado`) also takes the one before it.
`dubbed` means: a dub marker or a language other than the original is named, and neither the
original (by language or `Original`/`VO`/`VOSTFR`) nor `MULTI`/`DUAL-AUDIO`/`DL` is. A bare `DUAL`
next to only a foreign language is a dub. `direct` needs H.264, AAC, MP4 and a single audio track.
**Code:**
```ts
import { normalizeName } from '../../match.js';
import type { AudioCodec, Container, ReleaseHeight, ReleaseHints, ReleaseInfo, ReleaseSource, VideoCodec } from './types.js';

/**
 * Reads what a torrent's release name (and the file name, when the index gave one) says: picture
 * height, codecs, container, source, the languages named as audio, dub and multi-audio marks, cinema
 * recordings, 3D, the season and the episode. Pure. A word counts as a marker only after the title:
 * after the asked title's words when they start the name, else from the first year, quality, codec or
 * season word on, so "The French Dispatch" is never a French dub and "Cam (2018)" never a camera copy.
 */

export const VIDEO_EXTENSIONS: readonly string[] = ['mp4', 'm4v', 'mkv', 'avi', 'webm', 'mov', 'ts', 'm2ts', 'mpg', 'mpeg', 'wmv', 'flv', '3gp'];
export const SUBTITLE_EXTENSIONS: readonly string[] = ['srt', 'vtt', 'ass', 'ssa'];

export interface ReleaseContext {
  /** ISO 639-1. Null or absent: only an explicit dub marker makes a release `dubbed`. */
  originalLanguage?: string | null;
  title?: string | null;
  originalTitle?: string | null;
  /** The video file the index named inside the torrent (a pack's episode file). */
  fileName?: string | null;
  hints?: ReleaseHints;
}

export interface EpisodeRef {
  season: number | null;
  /** Last season of a multi-season pack; null for one season. */
  seasonTo: number | null;
  episode: number | null;
  /** Last episode of a range (S01E01-07); null for one episode. */
  episodeTo: number | null;
  complete: boolean;
}

/** `match`: names the episode; `pack`: holds its season; `other`: names something else; `unknown`: names nothing. */
export type EpisodeFit = 'match' | 'pack' | 'other' | 'unknown';

const LANGUAGE_TOKENS: ReadonlyMap<string, string> = new Map([
  ['english', 'en'], ['eng', 'en'], ['ingles', 'en'],
  ['french', 'fr'], ['truefrench', 'fr'], ['fre', 'fr'], ['fra', 'fr'], ['vf', 'fr'], ['vff', 'fr'], ['vfq', 'fr'], ['vfi', 'fr'], ['vf2', 'fr'],
  ['italian', 'it'], ['italiano', 'it'], ['ita', 'it'],
  ['german', 'de'], ['ger', 'de'], ['deu', 'de'], ['deutsch', 'de'],
  ['spanish', 'es'], ['spa', 'es'], ['esp', 'es'], ['espanol', 'es'], ['castellano', 'es'], ['latino', 'es'],
  ['portuguese', 'pt'], ['portugues', 'pt'], ['por', 'pt'], ['ptbr', 'pt'],
  ['russian', 'ru'], ['rus', 'ru'],
  ['ukrainian', 'uk'], ['ukr', 'uk'],
  ['hindi', 'hi'], ['hin', 'hi'],
  ['tamil', 'ta'], ['telugu', 'te'], ['malayalam', 'ml'], ['kannada', 'kn'],
  ['japanese', 'ja'], ['jpn', 'ja'],
  ['korean', 'ko'], ['kor', 'ko'],
  ['chinese', 'zh'], ['mandarin', 'zh'], ['cantonese', 'zh'],
  ['polish', 'pl'], ['turkish', 'tr'], ['thai', 'th'], ['hungarian', 'hu'], ['swedish', 'sv'], ['dutch', 'nl'],
]);
/** A dub or a voice-over track (Russian MVO/DVO/AVO, Polish lektor). */
const DUB_TOKENS: ReadonlySet<string> = new Set(['dub', 'dubbed', 'dubbing', 'dublado', 'doblado', 'dublaj', 'mvo', 'dvo', 'avo', 'lektor']);
/** The original track is there (VO: version originale; VOSTFR: original with French subtitles). */
const ORIGINAL_TOKENS: ReadonlySet<string> = new Set(['original', 'orig', 'vo', 'vost', 'vostfr', 'vosta']);
/** Several audio tracks, the original among them. DL: German "dual language". */
const MULTI_TOKENS: ReadonlySet<string> = new Set(['multi', 'multiaudio', 'dualaudio', 'multilang', 'dl']);
const SUB_WORD = /^(?:[a-z]{0,6}subs?|subtitles?|subtitled|subbed|legendado|legendas)$/;
const SUB_PLURAL = /^(?:[a-z]{0,6}subs|subtitles|subtitled|legendado|legendas)$/;
const THREE_D_TOKENS: ReadonlySet<string> = new Set(['3d', 'sbs', 'hsbs', 'hou']);
const CAM_SOURCES: ReadonlyMap<string, ReleaseSource> = new Map([
  ['cam', 'cam'], ['camrip', 'cam'], ['hdcam', 'cam'],
  ['ts', 'telesync'], ['hdts', 'telesync'], ['tsrip', 'telesync'], ['telesync', 'telesync'], ['pdvd', 'telesync'],
  ['tc', 'telecine'], ['hdtc', 'telecine'], ['telecine', 'telecine'],
]);
const SOURCES: ReadonlyMap<string, ReleaseSource> = new Map([
  ['webdl', 'web'], ['webrip', 'web'], ['web', 'web'], ['hdrip', 'web'],
  ['bluray', 'bluray'], ['bdrip', 'bluray'], ['brrip', 'bluray'], ['bdremux', 'bluray'], ['remux', 'bluray'], ['bdmux', 'bluray'],
  ['hdtv', 'hdtv'], ['pdtv', 'hdtv'],
  ['dvdrip', 'dvd'], ['dvd', 'dvd'], ['dvd5', 'dvd'], ['dvd9', 'dvd'], ['dvdr', 'dvd'],
]);
const VIDEO_CODECS: ReadonlyMap<string, VideoCodec> = new Map([
  ['x264', 'h264'], ['h264', 'h264'], ['avc', 'h264'],
  ['x265', 'hevc'], ['h265', 'hevc'], ['hevc', 'hevc'],
  ['av1', 'av1'], ['vp9', 'vp9'], ['xvid', 'xvid'], ['divx', 'xvid'],
]);
const CONTAINER_TOKENS: ReadonlyMap<string, Container> = new Map([
  ['mp4', 'mp4'], ['m4v', 'mp4'], ['mkv', 'mkv'], ['avi', 'avi'], ['webm', 'webm'],
]);
/** Where the markers start when the title is not found at the start of the name. */
const ANCHOR =
  /^(?:19[2-9]\d|20[0-4]\d|\d{3,4}[pi]|[248]k|uhd|s\d{1,2}(?:e\d{1,4})?|\d{1,2}x\d{2,3}|seasons?|saison|stagion[ei]|temporadas?|complete|completa|integrale|bluray|bdrip|brrip|bdremux|remux|webdl|webrip|web|hdtv|hdrip|dvdrip|x264|x265|h264|h265|hevc|xvid|cam|camrip|hdcam|ts|hdts|telesync|tc|hdtc|telecine)$/;
const CYRILLIC = /[Ѐ-ӿ]/;
/** Words a name splits that mean one thing joined. Applied to the prepared text, where `-` is kept. */
const JOINS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?<![a-z0-9])web ?-? ?dl(?![a-z0-9])/g, 'webdl'],
  [/(?<![a-z0-9])web ?-? ?rip(?![a-z0-9])/g, 'webrip'],
  [/(?<![a-z0-9])blu ?-? ?ray(?![a-z0-9])/g, 'bluray'],
  [/(?<![a-z0-9])dts ?-? ?hd(?![a-z0-9])/g, 'dtshd'],
  [/(?<![a-z0-9])e ?-? ?ac ?-? ?3(?![a-z0-9])/g, 'eac3'],
  [/(?<![a-z0-9])h ?-? ?26([45])(?![0-9])/g, 'h26$1'],
  [/(?<![a-z0-9])x ?-? ?26([45])(?![0-9])/g, 'x26$1'],
  [/(?<![a-z0-9])dual ?-? ?audio(?![a-z0-9])/g, 'dualaudio'],
  [/(?<![a-z0-9])multi ?-? ?audio(?![a-z0-9])/g, 'multiaudio'],
  [/(?<![a-z0-9])pt ?-? ?br(?![a-z0-9])/g, 'ptbr'],
  [/(?<![a-z0-9])(?:half ?-? ?|h ?-? ?)sbs(?![a-z0-9])/g, 'hsbs'],
  [/(?<![a-z0-9])full ?-? ?sbs(?![a-z0-9])/g, 'sbs'],
  [/(?<![a-z0-9])(?:half ?-? ?|h ?-? ?)ou(?![a-z0-9])/g, 'hou'],
  [/(?<![a-z0-9])hd ?-? ?(cam|ts|tc)(?![a-z0-9])/g, 'hd$1'],
  [/(?<![a-z0-9])tele ?-? ?(sync|cine)(?![a-z0-9])/g, 'tele$1'],
];
const SE = /(?<![a-z0-9])s(\d{1,2}) ?e(\d{1,4})(?:(?: ?- ?e?| ?e)(\d{1,4}))?(?![0-9a-z])/;
const NX = /(?<![a-z0-9])(\d{1,2})x(\d{2,3})(?![0-9a-z])/;
const SEASON_RANGE = /(?<![a-z0-9])s(\d{1,2}) ?- ?s?(\d{1,2})(?![0-9])/g;
const SEASON_ALONE = /(?<![a-z0-9])s(\d{1,2})(?![0-9])(?! ?e\d)/g;
const SEASON_WORD = /(?<![a-z0-9])(?:seasons?|saison|stagion[ei]|temporadas?|сезон) ?(\d{1,2})(?: ?(?:-|to|a) ?(\d{1,2}))?(?![0-9])/g;
const SEASON_WORD_AFTER = /(?<![0-9])(\d{1,2})a? temporada(?![a-z])/g;
const EPISODE_ALONE = /(?<![a-z0-9])(?:episode|episodio|ep|e|capitulo|cap) ?(\d{1,4})(?![0-9])/;
const COMPLETE = /(?<![a-z])(?:complete|completa|completo|integrale|box ?set)(?![a-z])/;

/** The file name's extension when it is a video or subtitle one, lower case, without the dot. */
export function extensionOf(path: string): string | null {
  const ext = /\.([a-z0-9]{2,4})$/i.exec(path.trim())?.[1]?.toLowerCase() ?? null;
  return ext !== null && (VIDEO_EXTENSIONS.includes(ext) || SUBTITLE_EXTENSIONS.includes(ext)) ? ext : null;
}

/** The name without a video or subtitle extension. */
export function stripExtension(name: string): string {
  const ext = extensionOf(name);
  return ext === null ? name.trim() : name.trim().slice(0, -(ext.length + 1));
}

/** The last part of a `/` or `\` path. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? path;
}

function prepare(text: string): string {
  let s = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9Ѐ-ӿ-]+/g, ' ');
  for (const [pattern, joined] of JOINS) s = s.replace(pattern, joined);
  return s.replace(/\s+/g, ' ').trim();
}

function tokensOf(prepared: string): string[] {
  return prepared.split(/[\s-]+/).filter((t) => t.length > 0);
}

/** How many leading tokens spell one of the titles (non-Latin tokens, which normalize to nothing, are passed over); 0 when none does. */
function titleEnd(tokens: readonly string[], titles: readonly string[]): number {
  let best = 0;
  for (const title of titles) {
    const target = normalizeName(title);
    if (target === '') continue;
    let spelled = '';
    for (let i = 0; i < tokens.length; i++) {
      spelled += normalizeName(tokens[i] ?? '');
      if (spelled === target) {
        best = Math.max(best, i + 1);
        break;
      }
      if (!target.startsWith(spelled)) break;
    }
  }
  return best;
}

function markerStart(tokens: readonly string[], titles: readonly string[]): number {
  const afterTitle = titleEnd(tokens, titles);
  if (afterTitle > 0) return afterTitle;
  const anchor = tokens.findIndex((t) => ANCHOR.test(t));
  return anchor < 0 ? 0 : anchor;
}

/** Positions in `tail` that are subtitle words or the languages of a subtitle word. */
function subtitleTokens(tail: readonly string[]): Set<number> {
  const marked = new Set<number>();
  tail.forEach((token, i) => {
    if (!SUB_WORD.test(token)) return;
    marked.add(i);
    const before = tail[i - 1];
    if (SUB_PLURAL.test(token) && before !== undefined && LANGUAGE_TOKENS.has(before)) marked.add(i - 1);
    for (let j = i + 1; j < tail.length && LANGUAGE_TOKENS.has(tail[j] ?? ''); j++) marked.add(j);
  });
  return marked;
}

function heightClass(n: number): ReleaseHeight {
  return n >= 1500 ? 2160 : n >= 900 ? 1080 : n >= 600 ? 720 : 480;
}

function widthClass(w: number): ReleaseHeight {
  return w >= 2500 ? 2160 : w >= 1700 ? 1080 : w >= 1100 ? 720 : 480;
}

function heightOf(token: string): ReleaseHeight | null {
  const lines = /^(\d{3,4})[pi]$/.exec(token)?.[1];
  if (lines !== undefined) return heightClass(Number(lines));
  const width = /^(\d{3,4})x\d{3,4}$/.exec(token)?.[1];
  if (width !== undefined) return widthClass(Number(width));
  if (token === '4k' || token === 'uhd') return 2160;
  if (token === '2k') return 1080;
  if (token === 'sd') return 480;
  return null;
}

function audioCodecOf(token: string): AudioCodec | null {
  if (/^aac\d*$/.test(token)) return 'aac';
  if (/^(?:eac3|ddp\d*)$/.test(token)) return 'eac3';
  if (/^(?:ac3|dd\d*)$/.test(token)) return 'ac3';
  if (/^dts(?:hd|x|ma)?\d*$/.test(token)) return 'dts';
  if (/^(?:truehd|atmos)$/.test(token)) return 'truehd';
  if (/^flac\d*$/.test(token)) return 'flac';
  if (/^opus\d*$/.test(token)) return 'opus';
  if (token === 'mp3') return 'mp3';
  return null;
}

function containerOf(ext: string | null): Container | null {
  if (ext === null) return null;
  if (ext === 'mp4' || ext === 'm4v') return 'mp4';
  if (ext === 'mkv' || ext === 'avi' || ext === 'webm') return ext;
  return VIDEO_EXTENSIONS.includes(ext) ? 'other' : null;
}

interface Signals {
  height: ReleaseHeight | null;
  videoCodec: VideoCodec | null;
  audioCodecs: AudioCodec[];
  container: Container | null;
  source: ReleaseSource | null;
  languages: Set<string>;
  original: boolean;
  multi: boolean;
  dual: boolean;
  dub: boolean;
  cam: boolean;
  threeD: boolean;
}

function readSignals(text: string, titles: readonly string[]): Signals {
  const tokens = tokensOf(prepare(text));
  const tail = tokens.slice(markerStart(tokens, titles));
  const subtitles = subtitleTokens(tail);
  const signals: Signals = {
    height: null,
    videoCodec: null,
    audioCodecs: [],
    container: null,
    source: null,
    languages: new Set(),
    original: false,
    multi: false,
    dual: false,
    dub: false,
    cam: false,
    threeD: false,
  };
  if (CYRILLIC.test(text)) signals.languages.add('ru');
  for (const token of tokens) {
    signals.height ??= heightOf(token);
    signals.videoCodec ??= VIDEO_CODECS.get(token) ?? null;
    const audio = audioCodecOf(token);
    if (audio !== null && !signals.audioCodecs.includes(audio)) signals.audioCodecs.push(audio);
    signals.container ??= CONTAINER_TOKENS.get(token) ?? null;
    signals.source ??= SOURCES.get(token) ?? null;
  }
  tail.forEach((token, i) => {
    if (subtitles.has(i)) return;
    const language = LANGUAGE_TOKENS.get(token);
    if (language !== undefined) signals.languages.add(language);
    if (ORIGINAL_TOKENS.has(token)) signals.original = true;
    if (MULTI_TOKENS.has(token)) signals.multi = true;
    if (token === 'dual') signals.dual = true;
    if (DUB_TOKENS.has(token)) signals.dub = true;
    if (THREE_D_TOKENS.has(token)) signals.threeD = true;
    const cam = CAM_SOURCES.get(token);
    if (cam !== undefined && !signals.cam) {
      signals.cam = true;
      signals.source = cam;
    }
  });
  return signals;
}

/** The season, episode and pack words of a release or file name. */
export function parseEpisodeRef(text: string): EpisodeRef {
  const s = prepare(text);
  const seasons: number[] = [];
  let episode: number | null = null;
  let episodeTo: number | null = null;
  const se = SE.exec(s);
  const nx = se === null ? NX.exec(s) : null;
  if (se?.[1] !== undefined && se[2] !== undefined) {
    seasons.push(Number(se[1]));
    episode = Number(se[2]);
    episodeTo = se[3] !== undefined ? Number(se[3]) : null;
  } else if (nx?.[1] !== undefined && nx[2] !== undefined) {
    seasons.push(Number(nx[1]));
    episode = Number(nx[2]);
  }
  for (const m of s.matchAll(SEASON_RANGE)) seasons.push(Number(m[1]), Number(m[2]));
  for (const m of s.matchAll(SEASON_ALONE)) seasons.push(Number(m[1]));
  for (const m of s.matchAll(SEASON_WORD)) {
    seasons.push(Number(m[1]));
    if (m[2] !== undefined) seasons.push(Number(m[2]));
  }
  for (const m of s.matchAll(SEASON_WORD_AFTER)) seasons.push(Number(m[1]));
  if (episode === null) {
    const alone = EPISODE_ALONE.exec(s)?.[1];
    if (alone !== undefined) episode = Number(alone);
  }
  const season = seasons.length > 0 ? Math.min(...seasons) : null;
  const last = seasons.length > 0 ? Math.max(...seasons) : null;
  const seasonTo = season !== null && last !== null && last > season ? last : null;
  // A multi-season pack's episode numbers ("S01-05e01-62") count over the whole pack, not one season.
  if (seasonTo !== null) {
    episode = null;
    episodeTo = null;
  }
  if (episode !== null && episodeTo !== null && episodeTo <= episode) episodeTo = null;
  return { season, seasonTo, episode, episodeTo, complete: COMPLETE.test(s) };
}

/** The ref names `episode` (alone or inside its range). */
export function covers(ref: EpisodeRef, episode: number): boolean {
  return ref.episode !== null && episode >= ref.episode && episode <= (ref.episodeTo ?? ref.episode);
}

function holdsSeason(ref: EpisodeRef, season: number): boolean {
  return ref.season !== null && season >= ref.season && season <= (ref.seasonTo ?? ref.season);
}

/**
 * Whether a candidate holds one episode. The file name decides when it names an episode (it is the
 * file that would play); else the release name: the episode, or a season pack or complete series
 * that holds it.
 */
export function episodeFit(name: string, fileName: string | null, season: number, episode: number): EpisodeFit {
  const named = parseEpisodeRef(name);
  if (fileName !== null) {
    const file = parseEpisodeRef(stripExtension(baseName(fileName)));
    if (file.episode !== null) {
      const seasonFits = file.season !== null ? file.season === season : named.season === null || holdsSeason(named, season);
      return seasonFits && covers(file, episode) ? 'match' : 'other';
    }
  }
  if (named.episode !== null) return (named.season === null || named.season === season) && covers(named, episode) ? 'match' : 'other';
  if (named.season !== null) return holdsSeason(named, season) ? 'pack' : 'other';
  return named.complete ? 'pack' : 'unknown';
}

/** Reads a release name, and the named file inside it when there is one. */
export function parseRelease(name: string, context: ReleaseContext = {}): ReleaseInfo {
  const titles = [context.title, context.originalTitle].filter((t): t is string => typeof t === 'string' && t.trim() !== '');
  const fileName = context.fileName?.trim() ? context.fileName.trim() : null;
  const fileStem = fileName === null ? null : stripExtension(baseName(fileName));
  const fromName = readSignals(name, titles);
  const fromFile = fileStem === null ? null : readSignals(fileStem, titles);
  const hints = context.hints ?? {};
  const original = context.originalLanguage?.trim().toLowerCase() || null;

  const languages = new Set([...fromName.languages, ...(fromFile?.languages ?? [])]);
  const originalNamed = fromName.original || (fromFile?.original ?? false) || (original !== null && languages.has(original));
  const multi = fromName.multi || (fromFile?.multi ?? false);
  const dual = fromName.dual || (fromFile?.dual ?? false);
  const dub = fromName.dub || (fromFile?.dub ?? false);
  const foreign = original === null ? [] : [...languages].filter((l) => l !== original);
  const dubbed = !originalNamed && !multi && (dub || foreign.length > 0);
  const audioCodecs = [...new Set([...(fromFile?.audioCodecs ?? []), ...fromName.audioCodecs])];
  const multiAudio = multi || dual || languages.size >= 2 || (dub && originalNamed) || (foreign.length > 0 && originalNamed) || audioCodecs.length >= 2;

  const videoCodec = hints.videoCodec ?? fromFile?.videoCodec ?? fromName.videoCodec;
  const audioCodec = hints.audioCodec ?? audioCodecs[0] ?? null;
  const container = hints.container ?? containerOf(fileName === null ? null : extensionOf(fileName)) ?? fromFile?.container ?? fromName.container;
  const height = hints.height ?? fromFile?.height ?? fromName.height;
  const cam = fromName.cam || (fromFile?.cam ?? false);
  const camSource = fromName.cam ? fromName.source : fromFile?.cam ? fromFile.source : null;
  const source = camSource ?? fromName.source ?? fromFile?.source ?? null;
  const threeD = hints.threeD === true || fromName.threeD || (fromFile?.threeD ?? false);

  const named = parseEpisodeRef(name);
  const file = fileStem === null ? null : parseEpisodeRef(fileStem);
  const ref = file !== null && file.episode !== null ? file : named;
  const pack = named.complete || named.seasonTo !== null || named.episodeTo !== null || (named.season !== null && named.episode === null);

  return {
    height,
    videoCodec,
    audioCodec,
    container,
    source,
    languages: [...languages].sort(),
    multiAudio,
    dubbed,
    cam,
    threeD,
    season: ref.season ?? named.season,
    seasonTo: named.seasonTo,
    episode: ref.episode,
    episodeTo: ref.episodeTo,
    complete: named.complete,
    pack,
    direct: !multiAudio && !dubbed && videoCodec === 'h264' && audioCodec === 'aac' && container === 'mp4',
  };
}
```
**Impact:** `src/directStream/match.ts` is imported (read only, not changed).

### Step 4: Row to candidate
**File:** `src/directStream/torrent/find/candidate.ts:1` (new)
**Code:**
```ts
import { parseRelease } from './release.js';
import type { IndexAnswer, IndexRow, ReleaseHints, TorrentCandidate, TorrentQuery } from './types.js';

/**
 * Public trackers added to every candidate (apibay and YTS list none; a Torrentio row may list only
 * one site's retrackers). The swarm is also found through DHT; these only speed up the first peers.
 */
export const DEFAULT_TRACKERS: readonly string[] = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://explodie.org:6969/announce',
];

/** YTS releases are H.264 or HEVC with AAC in MP4; its names do not say so. */
export const YTS_HINTS: Readonly<ReleaseHints> = { container: 'mp4', audioCodec: 'aac' };

const HEX_HASH = /^[0-9a-f]{40}$/;
const BASE32_HASH = /^[a-z2-7]{32}$/i;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32ToHex(text: string): string {
  let bits = '';
  for (const ch of text.toLowerCase()) bits += BASE32.indexOf(ch).toString(2).padStart(5, '0');
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

/** 40 lower-case hex characters when the text is a hex or base32 info hash; else the text lower-cased (rank leaves it out). */
export function normalizeInfoHash(raw: string): string {
  const text = raw.trim().toLowerCase();
  if (HEX_HASH.test(text)) return text;
  if (BASE32_HASH.test(text)) return base32ToHex(text);
  return text;
}

export function isUsableHash(hash: string): boolean {
  return HEX_HASH.test(hash) && !/^0+$/.test(hash);
}

/** `tt` and at least seven digits, from "tt1727587", "TT1727587" or "1727587"; null for anything else. */
export function normalizeImdbId(text: string): string | null {
  const digits = /^(?:tt)?(\d{5,10})$/i.exec(text.trim())?.[1];
  return digits === undefined ? null : `tt${digits.padStart(7, '0')}`;
}

/** The one place a listed row becomes a candidate. `scoped`: the index answered for the asked episode. */
export function candidateFrom(row: IndexRow, index: string, query: TorrentQuery, scoped = false): TorrentCandidate {
  const fileName = row.fileName?.trim() ? row.fileName.trim() : null;
  const seeds = Number.isFinite(row.seeds) && row.seeds > 0 ? Math.floor(row.seeds) : 0;
  return {
    infoHash: normalizeInfoHash(row.infoHash),
    name: row.name.trim(),
    fileName,
    fileIdx: row.fileIdx ?? null,
    seeds,
    sizeBytes: row.sizeBytes !== null && Number.isFinite(row.sizeBytes) && row.sizeBytes > 0 ? row.sizeBytes : null,
    index,
    listedBy: [index],
    site: row.site ?? null,
    trackers: [...new Set([...(row.trackers ?? []), ...DEFAULT_TRACKERS])],
    scoped,
    release: parseRelease(row.name, {
      originalLanguage: query.originalLanguage,
      title: query.title,
      originalTitle: query.originalTitle,
      fileName,
      hints: row.hints,
    }),
  };
}

/** `ok` with what was listed, or `empty`. */
export function answerOf(candidates: TorrentCandidate[]): IndexAnswer {
  return candidates.length > 0
    ? { outcome: 'ok', detail: `${candidates.length} listed`, candidates }
    : { outcome: 'empty', detail: 'nothing listed', candidates: [] };
}
```
**Impact:** none.

### Step 5: One plain JSON request
**File:** `src/directStream/torrent/find/http.ts:1` (new)
**Change:** Reads one answer through `ctx.fetch` (notesd's User-Agent and the timeout are already
bound there, Step 10). It is a bot check when Cloudflare says `cf-mitigated: challenge`, or when a
403/429/503, or a 200 that is HTML, carries a challenge page's marks. A failed status is `error`
`HTTP <status>`, and text that is not JSON is `error`. It never retries and never follows a challenge.
**Code:**
```ts
import type { IndexAnswer, IndexContext, IndexOutcome } from './types.js';

export type JsonAnswer = { ok: true; json: unknown } | { ok: false; outcome: Extract<IndexOutcome, 'error' | 'bot_check'>; detail: string };

/** Marks of a Cloudflare or DDoS-Guard challenge page. */
const CHALLENGE = /cf-chl|cf_chl|challenge-platform|just a moment\.\.\.|attention required|checking your browser|ddos-guard/i;

export function isBotCheck(status: number, headers: Headers, body: string): boolean {
  if ((headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') return true;
  const page = status === 403 || status === 429 || status === 503 || (status >= 200 && status < 300 && body.trimStart().startsWith('<'));
  return page && CHALLENGE.test(body);
}

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

export function failedAnswer(answer: { outcome: Extract<IndexOutcome, 'error' | 'bot_check'>; detail: string }): IndexAnswer {
  return { outcome: answer.outcome, detail: answer.detail, candidates: [] };
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function asList(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/** A non-empty trimmed string, else null. */
export function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** A number or a numeric string, zero or more; else null. */
export function asCount(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** "9.53 GB", "136.47 MB", "512 KiB" in bytes (powers of 1024); null when unreadable. */
export function parseSizeText(text: string): number | null {
  const m = /^([\d.,]+)\s*([KMGT]?)i?B$/i.exec(text.trim());
  if (m?.[1] === undefined) return null;
  const value = Number(m[1].replace(/,/g, ''));
  const power = ['', 'K', 'M', 'G', 'T'].indexOf((m[2] ?? '').toUpperCase());
  return Number.isFinite(value) && value > 0 && power >= 0 ? Math.round(value * 1024 ** power) : null;
}

/** The `tr=` trackers of a magnet link. */
export function trackersFromMagnet(magnet: string): string[] {
  const at = magnet.indexOf('?');
  if (at < 0) return [];
  return new URLSearchParams(magnet.slice(at + 1))
    .getAll('tr')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}
```
**Impact:** none.

### Step 6: Torrentio
**File:** `src/directStream/torrent/find/torrentio.ts:1` (new)
**Change:** `GET <base>/stream/movie/<tt>.json` or `<base>/stream/series/<tt>:<s>:<e>.json`. Each
stream's `title` has these lines: the release name, then (for a pack) the file path, then
`👤 seeds 💾 size ⚙️ site`, then sometimes a line of flags. `behaviorHints.filename` names the file
and `sources` lists `tracker:` entries. A series answer is `scoped`, since Torrentio answered for
that episode. A row from the YTS site gets `YTS_HINTS`.
**Code:**
```ts
import { answerOf, candidateFrom, YTS_HINTS } from './candidate.js';
import { asRecord, asText, failedAnswer, getIndexJson, parseSizeText } from './http.js';
import { baseName } from './release.js';
import type { IndexRow, TorrentIndex } from './types.js';

const STATS = /[\u{1F464}\u{1F4BE}]/u;
const SEEDS = /\u{1F464}\s*(\d+)/u;
const SIZE = /\u{1F4BE}\s*([\d.,]+\s*[KMGT]?i?B)/iu;
const SITE = /⚙️?\s*(.+)$/u;
const YTS_RELEASE = /(?<![a-z])(?:yts|yify)(?![a-z])/i;

/** One Torrentio stream as an IndexRow; null when it has no info hash or no title. */
export function readTorrentioStream(value: unknown): IndexRow | null {
  const stream = asRecord(value);
  const infoHash = asText(stream?.infoHash);
  const title = asText(stream?.title);
  if (stream === null || infoHash === null || title === null) return null;
  const lines = title
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const statsAt = lines.findIndex((l) => STATS.test(l));
  const head = statsAt < 0 ? lines : lines.slice(0, statsAt);
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

export function torrentioIndex(base: string): TorrentIndex {
  const root = base.replace(/\/+$/, '');
  return {
    name: 'torrentio',
    async find(query, ctx) {
      const path = query.kind === 'movie' ? `movie/${query.imdbId}` : `series/${query.imdbId}:${query.season}:${query.episode}`;
      const got = await getIndexJson(ctx, `${root}/stream/${path}.json`);
      if (!got.ok) return failedAnswer(got);
      const streams = asRecord(got.json)?.streams;
      if (!Array.isArray(streams)) return { outcome: 'error', detail: 'the answer has no streams list', candidates: [] };
      const rows = streams.map((s: unknown) => readTorrentioStream(s)).filter((r): r is IndexRow => r !== null);
      return answerOf(rows.map((row) => candidateFrom(row, 'torrentio', query, query.kind === 'tv')));
    },
  };
}
```
**Impact:** none.

### Step 7: apibay
**File:** `src/directStream/torrent/find/apibay.ts:1` (new)
**Change:** `GET <base>/q.php?q=<tt>`. The answer is a list of `{ name, info_hash, seeders, size,
imdb }`, with numbers as strings. When nothing is found it answers one row named "No results
returned" with an all-zero hash. That row is no listing, so the answer is `empty`. A row tagged with
another IMDb id is dropped. apibay names no trackers (`DEFAULT_TRACKERS` come from `candidateFrom`).
**Code:**
```ts
import { answerOf, candidateFrom } from './candidate.js';
import { asCount, asRecord, asText, failedAnswer, getIndexJson } from './http.js';
import type { IndexRow, TorrentIndex } from './types.js';

function readApibayRow(value: unknown, imdbId: string): IndexRow | null {
  const row = asRecord(value);
  const infoHash = asText(row?.info_hash);
  const name = asText(row?.name);
  if (row === null || infoHash === null || name === null || /^0+$/.test(infoHash)) return null;
  const imdb = asText(row.imdb);
  if (imdb !== null && imdb.toLowerCase() !== imdbId) return null;
  return { infoHash, name, seeds: asCount(row.seeders) ?? 0, sizeBytes: asCount(row.size), site: 'ThePirateBay' };
}

export function apibayIndex(base: string): TorrentIndex {
  const root = base.replace(/\/+$/, '');
  return {
    name: 'apibay',
    async find(query, ctx) {
      const got = await getIndexJson(ctx, `${root}/q.php?q=${encodeURIComponent(query.imdbId)}`);
      if (!got.ok) return failedAnswer(got);
      if (!Array.isArray(got.json)) return { outcome: 'error', detail: 'the answer is not a list', candidates: [] };
      const rows = got.json.map((v: unknown) => readApibayRow(v, query.imdbId)).filter((r): r is IndexRow => r !== null);
      return answerOf(rows.map((row) => candidateFrom(row, 'apibay', query)));
    },
  };
}
```
**Impact:** none.

### Step 8: EZTV
**File:** `src/directStream/torrent/find/eztv.ts:1` (new)
**Change:** Series only.
`GET <base>/api/get-torrents?imdb_id=<digits>&limit=100&page=N`. It reads pages one after another,
at most 3, until a page comes back short or `torrents_count` is covered. A failure on page 1 is the
outcome. A failure on a later page keeps what was read. EZTV lists every episode, so only the rows
that fit the asked episode (`episodeFit` is not `other`) are answered. Trackers come from `magnet_url`.
**Code:**
```ts
import { answerOf, candidateFrom } from './candidate.js';
import { asCount, asList, asRecord, asText, failedAnswer, getIndexJson, trackersFromMagnet } from './http.js';
import { episodeFit, stripExtension } from './release.js';
import type { IndexRow, TorrentIndex } from './types.js';

export const EZTV_PAGE_LIMIT = 100;
/** EZTV lists newest first; older episodes of a long series are left to Torrentio. */
export const EZTV_MAX_PAGES = 3;

function readEztvRow(value: unknown, imdbDigits: string): IndexRow | null {
  const row = asRecord(value);
  const infoHash = asText(row?.hash);
  const fileName = asText(row?.filename);
  const name = asText(row?.title) ?? (fileName === null ? null : stripExtension(fileName));
  if (row === null || infoHash === null || name === null) return null;
  const imdb = asText(row.imdb_id);
  if (imdb !== null && Number(imdb.replace(/^tt/i, '')) !== Number(imdbDigits)) return null;
  const magnet = asText(row.magnet_url);
  return {
    infoHash,
    name,
    fileName,
    seeds: asCount(row.seeds) ?? 0,
    sizeBytes: asCount(row.size_bytes),
    trackers: magnet === null ? [] : trackersFromMagnet(magnet),
    site: 'EZTV',
  };
}

export function eztvIndex(base: string): TorrentIndex {
  const root = base.replace(/\/+$/, '');
  return {
    name: 'eztv',
    kinds: ['tv'],
    async find(query, ctx) {
      if (query.kind !== 'tv') return { outcome: 'empty', detail: 'EZTV lists series only', candidates: [] };
      const digits = query.imdbId.slice(2);
      const rows: IndexRow[] = [];
      for (let page = 1; page <= EZTV_MAX_PAGES; page++) {
        const got = await getIndexJson(ctx, `${root}/api/get-torrents?imdb_id=${digits}&limit=${EZTV_PAGE_LIMIT}&page=${page}`);
        if (!got.ok) {
          if (page === 1) return failedAnswer(got);
          break;
        }
        const answer = asRecord(got.json);
        const list = asList(answer?.torrents) ?? [];
        for (const value of list) {
          const row = readEztvRow(value, digits);
          if (row !== null) rows.push(row);
        }
        const total = asCount(answer?.torrents_count) ?? 0;
        if (list.length < EZTV_PAGE_LIMIT || page * EZTV_PAGE_LIMIT >= total) break;
      }
      const fitting = rows.filter((row) => episodeFit(row.name, row.fileName ?? null, query.season, query.episode) !== 'other');
      return answerOf(fitting.map((row) => candidateFrom(row, 'eztv', query)));
    },
  };
}
```
**Impact:** none.

### Step 9: YTS
**File:** `src/directStream/torrent/find/yts.ts:1` (new)
**Change:** Films only. `GET <base>/list_movies.json?query_term=<tt>` with the documented shape
`{ status, data: { movie_count, movies: [{ imdb_code, title_long, torrents: [{ hash, quality, type,
video_codec, seeds, size_bytes }] }] } }`. Only the movie whose `imdb_code` is the asked id counts.
YTS rows have no release name, so one is built from the fields, e.g. `Sintel (2010) [720p] [bluray]
[x264] [YTS]`, and gets `YTS_HINTS`. Quality `3D` is `threeD`. YTS timed out from this network, so
its own timeout is 6 s instead of 10 s. With `yts: false` (Step 10) it is not asked at all.
**Code:**
```ts
import { answerOf, candidateFrom, YTS_HINTS } from './candidate.js';
import { asCount, asList, asRecord, asText, failedAnswer, getIndexJson } from './http.js';
import type { IndexRow, TorrentIndex } from './types.js';

/** YTS did not answer within 20 s from this network on 2026-11-16; it may not hold the others up for 10. */
export const DEFAULT_YTS_TIMEOUT_MS = 6_000;

function readYtsTorrent(value: unknown, title: string): IndexRow | null {
  const torrent = asRecord(value);
  const infoHash = asText(torrent?.hash);
  if (torrent === null || infoHash === null) return null;
  const quality = asText(torrent.quality) ?? '';
  const parts = [quality, asText(torrent.type), asText(torrent.video_codec)].filter((p): p is string => p !== null && p !== '');
  return {
    infoHash,
    name: `${title} ${parts.map((p) => `[${p}]`).join(' ')} [YTS]`,
    seeds: asCount(torrent.seeds) ?? 0,
    sizeBytes: asCount(torrent.size_bytes),
    site: 'YTS',
    hints: quality.toUpperCase() === '3D' ? { ...YTS_HINTS, threeD: true } : YTS_HINTS,
  };
}

export function ytsIndex(base: string): TorrentIndex {
  const root = base.replace(/\/+$/, '');
  return {
    name: 'yts',
    kinds: ['movie'],
    timeoutMs: DEFAULT_YTS_TIMEOUT_MS,
    async find(query, ctx) {
      const got = await getIndexJson(ctx, `${root}/list_movies.json?query_term=${encodeURIComponent(query.imdbId)}`);
      if (!got.ok) return failedAnswer(got);
      const answer = asRecord(got.json);
      const status = asText(answer?.status);
      if (answer === null || status !== 'ok') return { outcome: 'error', detail: `YTS answered status ${status ?? 'none'}`, candidates: [] };
      const rows: IndexRow[] = [];
      for (const value of asList(asRecord(answer.data)?.movies) ?? []) {
        const movie = asRecord(value);
        if (movie === null || asText(movie.imdb_code)?.toLowerCase() !== query.imdbId) continue;
        const title = asText(movie.title_long) ?? asText(movie.title) ?? query.imdbId;
        for (const torrent of asList(movie.torrents) ?? []) {
          const row = readYtsTorrent(torrent, title);
          if (row !== null) rows.push(row);
        }
      }
      return answerOf(rows.map((row) => candidateFrom(row, 'yts', query)));
    },
  };
}
```
**Impact:** none.

### Step 10: Filter and ranking
**File:** `src/directStream/torrent/find/rank.ts:1` (new)
**Change:** First, listings of the same info hash are joined. The base is the listing whose file fits
the episode best, then one that names a file, then the most seeds. The joined candidate takes the
most seeds of any listing, the union of trackers and every index's name. Then exclusions are checked
in a fixed order: a malformed or all-zero hash, another title (only when the query names one), dub,
cam, 3D, another episode (a name that says nothing is kept only from an index that answered for the
episode), under the seed floor (default 5), and a single file over the size ceiling (default 25 GiB;
a pack's size is the whole torrent, and only the episode file is downloaded, so packs are not held
to it). Then the order: `direct` first, then well seeded (20 or more), then height 1080 > 720 >
2160 > 480 > unknown, then more seeds, then the info hash for a stable order.
**Code:**
```ts
import { normalizeName } from '../../match.js';
import { isUsableHash } from './candidate.js';
import { episodeFit, type EpisodeFit } from './release.js';
import type { ExcludedCandidate, ExcludeReason, ReleaseHeight, TorrentCandidate, TorrentQuery } from './types.js';

/** Fewer seeds than this and a torrent is never picked. */
export const DEFAULT_MIN_SEEDS = 5;
/** This many seeds or more streams without waiting; such a torrent comes before a better picture with fewer. */
export const DEFAULT_GOOD_SEEDS = 20;
/** A single file larger than this is left out (a pack is not: only the episode file is downloaded). */
export const DEFAULT_MAX_SIZE_BYTES = 25 * 1024 ** 3;
/** Picture heights, preferred first; anything else (unknown) comes after. */
export const HEIGHT_PREFERENCE: readonly ReleaseHeight[] = [1080, 720, 2160, 480];

export interface RankSettings {
  minSeeds: number;
  goodSeeds: number;
  maxSizeBytes: number;
}

export const DEFAULT_RANK_SETTINGS: Readonly<RankSettings> = {
  minSeeds: DEFAULT_MIN_SEEDS,
  goodSeeds: DEFAULT_GOOD_SEEDS,
  maxSizeBytes: DEFAULT_MAX_SIZE_BYTES,
};

export interface Ranked {
  kept: TorrentCandidate[];
  excluded: ExcludedCandidate[];
}

const FIT_ORDER: Record<EpisodeFit, number> = { match: 0, pack: 1, unknown: 2, other: 3 };

function fitOf(c: TorrentCandidate, query: TorrentQuery): EpisodeFit {
  return query.kind === 'tv' ? episodeFit(c.name, c.fileName, query.season, query.episode) : 'match';
}

/** One candidate for every listing of one info hash. */
function joinListings(group: readonly TorrentCandidate[], query: TorrentQuery): TorrentCandidate {
  const ordered = [...group].sort(
    (a, b) =>
      FIT_ORDER[fitOf(a, query)] - FIT_ORDER[fitOf(b, query)] ||
      Number(b.fileName !== null) - Number(a.fileName !== null) ||
      b.seeds - a.seeds,
  );
  const [base] = ordered;
  if (base === undefined) throw new RangeError('an empty listing group');
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

function namesTitle(c: TorrentCandidate, query: TorrentQuery): boolean {
  const wanted = [query.title, query.originalTitle].map((t) => normalizeName(t ?? '')).filter((t) => t.length > 0);
  if (wanted.length === 0) return true;
  const text = normalizeName(`${c.name} ${c.fileName ?? ''}`);
  return wanted.some((t) => text.includes(t));
}

/** Why a candidate is left out, or null when it is kept. */
export function exclusionOf(c: TorrentCandidate, query: TorrentQuery, settings: RankSettings = DEFAULT_RANK_SETTINGS): ExcludeReason | null {
  if (!isUsableHash(c.infoHash)) return 'bad_hash';
  if (!namesTitle(c, query)) return 'other_title';
  if (c.release.dubbed) return 'dubbed';
  if (c.release.cam) return 'cam';
  if (c.release.threeD) return 'three_d';
  if (query.kind === 'tv') {
    const fit = fitOf(c, query);
    if (fit === 'other' || (fit === 'unknown' && !c.scoped)) return 'other_episode';
  }
  if (c.seeds < settings.minSeeds) return 'few_seeds';
  if (!c.release.pack && c.sizeBytes !== null && c.sizeBytes > settings.maxSizeBytes) return 'too_big';
  return null;
}

function heightRank(height: ReleaseHeight | null): number {
  const at = height === null ? -1 : HEIGHT_PREFERENCE.indexOf(height);
  return at < 0 ? HEIGHT_PREFERENCE.length : at;
}

/** Negative when `a` is the better pick. */
export function compareCandidates(a: TorrentCandidate, b: TorrentCandidate, settings: RankSettings = DEFAULT_RANK_SETTINGS): number {
  return (
    Number(b.release.direct) - Number(a.release.direct) ||
    Number(b.seeds >= settings.goodSeeds) - Number(a.seeds >= settings.goodSeeds) ||
    heightRank(a.release.height) - heightRank(b.release.height) ||
    b.seeds - a.seeds ||
    a.infoHash.localeCompare(b.infoHash)
  );
}

/** Joins listings by info hash, leaves out what may not be picked, orders the rest best first. */
export function rankCandidates(all: readonly TorrentCandidate[], query: TorrentQuery, settings: RankSettings = DEFAULT_RANK_SETTINGS): Ranked {
  const groups = new Map<string, TorrentCandidate[]>();
  for (const c of all) {
    const group = groups.get(c.infoHash);
    if (group === undefined) groups.set(c.infoHash, [c]);
    else group.push(c);
  }
  const kept: TorrentCandidate[] = [];
  const excluded: ExcludedCandidate[] = [];
  for (const group of groups.values()) {
    const joined = joinListings(group, query);
    const reason = exclusionOf(joined, query, settings);
    if (reason === null) kept.push(joined);
    else excluded.push({ infoHash: joined.infoHash, name: joined.name, index: joined.index, seeds: joined.seeds, reason });
  }
  kept.sort((a, b) => compareCandidates(a, b, settings));
  return { kept, excluded };
}
```
**Impact:** none.

### Step 11: The file inside a torrent
**File:** `src/directStream/torrent/find/pickFile.ts:1` (new)
**Change:** Videos are the files with a video extension, minus extras (a folder named
Extras/Featurettes/Bonus/Sample/Trailers…, or a file named sample/trailer/featurette). Videos under
50 MiB are dropped when a bigger one exists. For a film, the largest video wins. For an episode, the
largest video that names it wins: `SxxEyy` and `NxNN`, or `Ep N`/`Episode N` with the season from a
folder (or no season named anywhere in the torrent), or the absolute number for anime. A torrent with
a single video that names no episode also counts. Subtitles are `.srt/.vtt/.ass/.ssa` files in the
video's folder or in a `Subs`/`Subtitles` folder at or above it. In a pack, only the episode's
subtitles count: those whose path starts with the video's file name (RARBG's
`Subs/<episode>/2_English.srt`) or that name the episode.
**Code:**
```ts
import { baseName, covers, extensionOf, parseEpisodeRef, stripExtension, SUBTITLE_EXTENSIONS, VIDEO_EXTENSIONS } from './release.js';
import type { FilePick, TorrentFileLike, TorrentQuery, TvQuery } from './types.js';

/** A video smaller than this is skipped when a bigger one exists (samples, previews). */
export const MIN_VIDEO_BYTES = 50 * 1024 * 1024;

const EXTRA_FOLDER = /^(?:extras?|featurettes?|bonus|behind the scenes|deleted scenes|interviews?|trailers?|samples?)(?![a-z])/i;
const EXTRA_FILE = /(?<![a-z])(?:sample|trailer|featurette)(?![a-z])/i;
const SUBS_FOLDER = /^(?:subs?|subtitles?)$/i;

function segments(path: string): string[] {
  return path.split(/[\\/]+/).filter((s) => s.length > 0);
}

function folderOf(path: string): string {
  return segments(path).slice(0, -1).join('/');
}

function hasExtension(path: string, list: readonly string[]): boolean {
  const ext = extensionOf(path);
  return ext !== null && list.includes(ext);
}

function isExtra(path: string): boolean {
  const parts = segments(path);
  return parts.slice(0, -1).some((p) => EXTRA_FOLDER.test(p.trim())) || EXTRA_FILE.test(stripExtension(parts[parts.length - 1] ?? ''));
}

function largest(files: readonly TorrentFileLike[]): TorrentFileLike | null {
  let best: TorrentFileLike | null = null;
  for (const f of files) if (best === null || f.length > best.length) best = f;
  return best;
}

/** The season of the nearest folder that names exactly one season. */
function folderSeason(path: string): number | null {
  for (const folder of segments(path).slice(0, -1).reverse()) {
    const ref = parseEpisodeRef(folder);
    if (ref.season !== null && ref.seasonTo === null) return ref.season;
  }
  return null;
}

function seasonOf(path: string): number | null {
  return parseEpisodeRef(stripExtension(baseName(path))).season ?? folderSeason(path);
}

/** The stem names `n` as a number of its own ("One Piece - 1071", "[1071v2]"). */
function namesNumber(stem: string, n: number): boolean {
  return new RegExp(`(?<![0-9a-z])0*${n}(?:v\\d)?(?![0-9a-z])`, 'i').test(stem);
}

function matchesEpisode(path: string, query: TvQuery, oneSeason: boolean): boolean {
  const stem = stripExtension(baseName(path));
  const ref = parseEpisodeRef(stem);
  if (ref.episode !== null) {
    const season = ref.season ?? folderSeason(path);
    if (season !== null) return season === query.season && covers(ref, query.episode);
    if (query.absoluteEpisode != null && ref.episode === query.absoluteEpisode) return true;
    return oneSeason && covers(ref, query.episode);
  }
  return query.absoluteEpisode != null && namesNumber(stem, query.absoluteEpisode);
}

function inSubsFolder(path: string, videoFolder: string): boolean {
  const folders = segments(path).slice(0, -1);
  const at = folders.findIndex((f) => SUBS_FOLDER.test(f));
  if (at < 0) return false;
  const above = folders.slice(0, at).join('/');
  return above === '' || videoFolder === above || videoFolder.startsWith(`${above}/`);
}

function subtitlesFor(
  files: readonly TorrentFileLike[],
  video: TorrentFileLike,
  episode: { query: TvQuery; oneSeason: boolean } | null,
  pack: boolean,
): number[] {
  const videoFolder = folderOf(video.path);
  const videoStem = stripExtension(baseName(video.path)).toLowerCase();
  return files
    .filter((f) => hasExtension(f.path, SUBTITLE_EXTENSIONS))
    .filter((f) => folderOf(f.path) === videoFolder || inSubsFolder(f.path, videoFolder))
    .filter((f) => {
      if (!pack || episode === null) return true;
      return segments(f.path).some((s) => stripExtension(s).toLowerCase().startsWith(videoStem)) || matchesEpisode(f.path, episode.query, episode.oneSeason);
    })
    .map((f) => f.index);
}

/** The video to play and its subtitle files; null when the torrent holds no fitting video. */
export function pickFile(files: readonly TorrentFileLike[], query: TorrentQuery): FilePick | null {
  const videos = files.filter((f) => hasExtension(f.path, VIDEO_EXTENSIONS) && !isExtra(f.path));
  const big = videos.filter((f) => f.length >= MIN_VIDEO_BYTES);
  const pool = big.length > 0 ? big : videos;
  if (pool.length === 0) return null;
  if (query.kind === 'movie') {
    const film = largest(pool);
    return film === null ? null : { video: film.index, subtitles: subtitlesFor(files, film, null, false) };
  }
  const oneSeason = pool.every((f) => {
    const season = seasonOf(f.path);
    return season === null || season === query.season;
  });
  const matching = pool.filter((f) => matchesEpisode(f.path, query, oneSeason));
  const [only] = pool;
  const lone = pool.length === 1 && only !== undefined && parseEpisodeRef(stripExtension(baseName(only.path))).episode === null ? only : null;
  const video = matching.length > 0 ? largest(matching) : lone;
  if (video === null) return null;
  return { video: video.index, subtitles: subtitlesFor(files, video, { query, oneSeason }, pool.length > 1) };
}
```
**Impact:** none. Phase 3 calls it on the real file list (`TorrentHandle.files`), and phase 6 picks
the English subtitle from `subtitles`.

### Step 12: findCandidates
**File:** `src/directStream/torrent/find/find.ts:1` (new)
**Change:** The IMDb id is normalized once (a bad one throws `RangeError`, since it is a programming
error in phase 3). Only the indexes for the query's kind are asked, all at once. Each gets
`ctx.fetch`, which always sets `user-agent` to notesd's own and `accept: application/json` (unless
the index set one), and is bound to an abort signal for the shorter of the index's and the caller's
timeout (a `fallback` index keeps its own limit even when longer: phase 9's browser-driven sites need about 40 s). When the time is up, the answer is `error` `timed out after N s`, even if the index ignores
the signal. A throw is `error` with the message. `findCandidates` never throws for an index. The
`fallback` indexes are asked only when the JSON indexes leave nothing after ranking. Their candidates
are ranked together with the first ones.
**Code:**
```ts
import { apibayIndex } from './apibay.js';
import { normalizeImdbId } from './candidate.js';
import { eztvIndex } from './eztv.js';
import { DEFAULT_RANK_SETTINGS, rankCandidates, type RankSettings } from './rank.js';
import { torrentioIndex } from './torrentio.js';
import { ytsIndex } from './yts.js';
import type { FetchLike, FoundCandidates, IndexAnswer, IndexAttempt, IndexContext, TorrentCandidate, TorrentIndex, TorrentQuery } from './types.js';

/**
 * Asks the JSON torrent indexes for a film or one episode by IMDb id and answers ranked candidates
 * (TORRENT_STREAM_SOURCE_PLAN phase 2). Reads no settings: phase 3 maps them onto FindOptions.
 * Every request says it is notesd; a bot check is the outcome `bot_check`, never worked around.
 */

/** Sent as the User-Agent of every index request; an index cannot replace it. */
export const TORRENT_INDEX_USER_AGENT = 'notesd (personal notes daemon; torrent index lookup)';
export const DEFAULT_INDEX_TIMEOUT_MS = 10_000;
/** Candidates answered at most (phase 3 keeps the rest for the shuffle button). */
export const DEFAULT_MAX_CANDIDATES = 20;

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

export interface FindOptions extends Partial<RankSettings> {
  /** Default: the global fetch. Tests pass a fake; nothing here touches the network otherwise. */
  fetch?: FetchLike;
  /** Default: defaultIndexes(options). */
  indexes?: readonly TorrentIndex[];
  /**
   * Asked side by side, only when `indexes` leave no usable candidate (phase 9: 1337x and ext.to through the streaming
   * Chrome). Each is given its own `timeoutMs` when it has one, even a longer one than `timeoutMs`.
   */
  fallback?: readonly TorrentIndex[];
  bases?: Partial<IndexBases>;
  /** Ask YTS (films only). Default true. */
  yts?: boolean;
  /** Per index. Default DEFAULT_INDEX_TIMEOUT_MS; an index's own shorter limit wins. */
  timeoutMs?: number;
  maxCandidates?: number;
  /** Default TORRENT_INDEX_USER_AGENT; phase 3 may pass one with the daemon's version. */
  userAgent?: string;
  signal?: AbortSignal;
}

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

interface AskSettings {
  fetch: FetchLike;
  userAgent: string;
  timeoutMs: number;
  signal: AbortSignal | null;
}

interface Asked {
  attempts: IndexAttempt[];
  candidates: TorrentCandidate[];
}

function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message;
}

function seconds(ms: number): number {
  return Math.round(ms / 100) / 10;
}

async function askOne(index: TorrentIndex, query: TorrentQuery, run: AskSettings): Promise<{ attempt: IndexAttempt; candidates: TorrentCandidate[] }> {
  const started = Date.now();
  const limitMs = Math.min(index.timeoutMs ?? run.timeoutMs, run.timeoutMs);
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort();
  run.signal?.addEventListener('abort', onParentAbort, { once: true });
  if (run.signal?.aborted) controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<IndexAnswer>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ outcome: 'error', detail: `timed out after ${seconds(limitMs)} s`, candidates: [] });
    }, limitMs);
  });
  const ctx: IndexContext = {
    signal: controller.signal,
    fetch: (url, init) => {
      const headers = new Headers(init?.headers);
      if (!headers.has('accept')) headers.set('accept', 'application/json');
      headers.set('user-agent', run.userAgent);
      return run.fetch(url, { headers, signal: controller.signal });
    },
  };
  let answer: IndexAnswer;
  try {
    answer = await Promise.race([index.find(query, ctx), timedOut]);
  } catch (err) {
    answer = { outcome: 'error', detail: run.signal?.aborted ? 'aborted' : errorText(err), candidates: [] };
  } finally {
    clearTimeout(timer);
    run.signal?.removeEventListener('abort', onParentAbort);
  }
  return {
    attempt: { index: index.name, outcome: answer.outcome, detail: answer.detail, took_s: seconds(Date.now() - started), listed: answer.candidates.length },
    candidates: answer.candidates,
  };
}

async function askAll(indexes: readonly TorrentIndex[], query: TorrentQuery, run: AskSettings): Promise<Asked> {
  const answers = await Promise.all(indexes.map((index) => askOne(index, query, run)));
  return { attempts: answers.map((a) => a.attempt), candidates: answers.flatMap((a) => a.candidates) };
}

export async function findCandidates(query: TorrentQuery, options: FindOptions = {}): Promise<FoundCandidates> {
  const imdbId = normalizeImdbId(query.imdbId);
  if (imdbId === null) throw new RangeError(`not an IMDb id: ${query.imdbId}`);
  const asked: TorrentQuery = { ...query, imdbId };
  const settings: RankSettings = {
    minSeeds: options.minSeeds ?? DEFAULT_RANK_SETTINGS.minSeeds,
    goodSeeds: options.goodSeeds ?? DEFAULT_RANK_SETTINGS.goodSeeds,
    maxSizeBytes: options.maxSizeBytes ?? DEFAULT_RANK_SETTINGS.maxSizeBytes,
  };
  const run: AskSettings = {
    fetch: options.fetch ?? fetch,
    userAgent: options.userAgent ?? TORRENT_INDEX_USER_AGENT,
    timeoutMs: options.timeoutMs ?? DEFAULT_INDEX_TIMEOUT_MS,
    signal: options.signal ?? null,
  };
  const forKind = (list: readonly TorrentIndex[]): TorrentIndex[] => list.filter((i) => i.kinds === undefined || i.kinds.includes(asked.kind));

  const first = await askAll(forKind(options.indexes ?? defaultIndexes(options)), asked, run);
  let attempts = first.attempts;
  let found = first.candidates;
  let ranked = rankCandidates(found, asked, settings);
  const fallback = forKind(options.fallback ?? []);
  if (ranked.kept.length === 0 && fallback.length > 0) {
    // A fallback index (a browser-driven site) keeps its own, longer limit.
    const second = await askAll(fallback, asked, { ...run, timeoutMs: Math.max(run.timeoutMs, ...fallback.map((i) => i.timeoutMs ?? 0)) });
    attempts = [...attempts, ...second.attempts];
    found = [...found, ...second.candidates];
    ranked = rankCandidates(found, asked, settings);
  }
  return { candidates: ranked.kept.slice(0, options.maxCandidates ?? DEFAULT_MAX_CANDIDATES), indexes: attempts, excluded: ranked.excluded };
}
```
**Impact:** none. Nothing calls it until phase 3.

### Step 13: Barrel
**File:** `src/directStream/torrent/find/index.ts:1` (new)
**Code:**
```ts
/** The torrent finder (TORRENT_STREAM_SOURCE_PLAN phase 2). Other phases import from here. */
export * from './types.js';
export * from './release.js';
export * from './candidate.js';
export * from './http.js';
export * from './rank.js';
export * from './pickFile.js';
export * from './torrentio.js';
export * from './apibay.js';
export * from './eztv.js';
export * from './yts.js';
export * from './find.js';
```
**Impact:** none.

### Step 14: Release tests
**File:** `tests/unit/directStream/torrent/find/release.test.ts:1` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import { episodeFit, parseEpisodeRef, parseRelease } from '../../../../../src/directStream/torrent/find/release.js';

const DUNE = { title: 'Dune: Part Two', originalLanguage: 'en' };

describe('parseRelease', () => {
  it.each([['Dune.Part.Two.2024.HDCAM.x264-GRP'], ['Dune Part Two 2024 1080p TELESYNC'], ['Dune.Part.Two.2024.HDTS.x264'], ['Dune.Part.Two.2024.TS.x264'], ['Dune Part Two 2024 CAM']])(
    'marks a cinema recording: %s',
    (name) => {
      expect(parseRelease(name, DUNE).cam).toBe(true);
    },
  );

  it.each([['Avatar.2009.1080p.3D.HSBS.BluRay.x264'], ['Avatar 2009 1080p Half-SBS']])('marks 3D: %s', (name) => {
    expect(parseRelease(name, { title: 'Avatar', originalLanguage: 'en' }).threeD).toBe(true);
  });

  it.each([
    ['Dune.Part.Two.2024.1080p.Hindi.Dubbed.WEB-DL'],
    ['Dune Part Two (2024) 1080p Latino'],
    ['Dune.Part.Two.2024.TRUEFRENCH.1080p.WEB'],
    ['Dune.Part.Two.2024.iTALiAN.1080p.WEBRip'],
    ['Dune.Part.Two.2024.GERMAN.1080p.WEB'],
    ['Dune Part Two 2024 1080p PT-BR'],
  ])('marks a dub: %s', (name) => {
    expect(parseRelease(name, DUNE).dubbed).toBe(true);
  });

  it('treats a dub marker as a dub even when the original language is unknown', () => {
    expect(parseRelease('Dune.Part.Two.2024.1080p.DUBBED', { title: 'Dune: Part Two' }).dubbed).toBe(true);
    expect(parseRelease('Dune.Part.Two.2024.FRENCH.1080p', { title: 'Dune: Part Two' }).dubbed).toBe(false);
  });

  it.each([
    ['Dune.Part.Two.2024.MULTi.1080p.WEB.x264', DUNE, true],
    ['Dune Part Two 2024 1080p Dual-Audio Hindi English', DUNE, true],
    ['Dune.Part.Two.2024.GERMAN.DL.1080p.WEB', DUNE, true],
    ['Breaking.Bad.S01.720p.BRRip.Hindi-English.ESUB', { title: 'Breaking Bad', originalLanguage: 'en' }, true],
    ['Sintel.2010.720p.SWESUB.x264-SMS', { title: 'Sintel', originalLanguage: 'en' }, false],
    ['Breaking Bad PT-BR Legendado 720p', { title: 'Breaking Bad', originalLanguage: 'en' }, false],
    ['Amelie.2001.FRENCH.1080p.BluRay', { title: 'Amelie', originalLanguage: 'fr' }, false],
  ])('keeps a release that carries the original track: %s', (name, context, multiAudio) => {
    const info = parseRelease(name, context);
    expect(info.dubbed).toBe(false);
    expect(info.multiAudio).toBe(multiAudio);
  });

  it('never reads a title word as a marker', () => {
    expect(parseRelease('The French Dispatch 2021 1080p WEB', { originalLanguage: 'en' }).dubbed).toBe(false);
    expect(parseRelease('Cam.2018.1080p.WEB.x264', { title: 'Cam', originalLanguage: 'en' }).cam).toBe(false);
    expect(parseRelease('Step Up 3D 2010 1080p BluRay', { title: 'Step Up 3D', originalLanguage: 'en' }).threeD).toBe(false);
    expect(parseRelease('Hindi Medium 2017 1080p WEB', { title: 'Hindi Medium', originalLanguage: 'hi' }).dubbed).toBe(false);
  });

  it('says a release plays in Chrome as is only for H.264 with AAC in MP4', () => {
    const yts = parseRelease('Sintel 2010 720p BluRay', { fileName: 'Sintel.2010.720p.BluRay.x264.AAC-[YTS.MX].mp4' });
    expect(yts).toMatchObject({ direct: true, height: 720, videoCodec: 'h264', audioCodec: 'aac', container: 'mp4', source: 'bluray' });
    expect(parseRelease('Sintel.1080p.h264.AAC').direct).toBe(false);
    expect(parseRelease('Breaking.Bad.S01.1080p.BluRay.x265-RARBG', { fileName: 'Breaking.Bad.S01E01.1080p.BluRay.x265-RARBG.mp4' }).direct).toBe(false);
    expect(parseRelease('Movie.2020.1080p.WEB.x264.AAC.MULTi', { fileName: 'Movie.2020.1080p.WEB.x264.AAC.MULTi.mp4' }).direct).toBe(false);
    expect(parseRelease('Sintel (2010) [720p] [bluray] [x264] [YTS]', { hints: { container: 'mp4', audioCodec: 'aac' } }).direct).toBe(true);
  });

  it.each([
    ['Sintel.2010.1080p.WEB.H264', 1080],
    ['Sintel 4K UHD', 2160],
    ['Sintel 1744p X264', 2160],
    ['Sintel.2010.820p.H264', 720],
    ['Sintel (2010) Retina edition - h.264 2880x1226', 2160],
    ['Sintel.2010.2K.SURROUND.x264', 1080],
    ['Sintel.2010.HDRip.XviD', null],
  ])('reads the picture height of %s', (name, height) => {
    expect(parseRelease(name).height).toBe(height);
  });
});

describe('parseEpisodeRef', () => {
  it.each([
    ['Breaking.Bad.S01E01.Pilot', { season: 1, seasonTo: null, episode: 1, episodeTo: null, complete: false }],
    ['Breaking.Bad.S01E01-07.1080p', { season: 1, seasonTo: null, episode: 1, episodeTo: 7, complete: false }],
    ['Breaking Bad S01 E01-07 BluRay', { season: 1, seasonTo: null, episode: 1, episodeTo: 7, complete: false }],
    ['BB 1x02 Cat', { season: 1, seasonTo: null, episode: 2, episodeTo: null, complete: false }],
    ['Breaking Bad (2008) Season 1-5 S01-S05 (1080p BluRay x265)', { season: 1, seasonTo: 5, episode: null, episodeTo: null, complete: false }],
    ['Breaking.Bad.S01.S02.S03.S04.S05.FRENCH.HDTV', { season: 1, seasonTo: 5, episode: null, episodeTo: null, complete: false }],
    ['Breaking Bad S01-S05e01-62 (Serie Completa Extra)', { season: 1, seasonTo: 5, episode: null, episodeTo: null, complete: true }],
    ['Breaking Bad 1ª Temporada (2008) BluRay 720p', { season: 1, seasonTo: null, episode: null, episodeTo: null, complete: false }],
    ['Breaking Bad Complete 1080p', { season: null, seasonTo: null, episode: null, episodeTo: null, complete: true }],
    ['Ep 01 - Pilot', { season: null, seasonTo: null, episode: 1, episodeTo: null, complete: false }],
    ['[S01.E01] Breaking Bad - Pilot', { season: 1, seasonTo: null, episode: 1, episodeTo: null, complete: false }],
    ['Breaking.Bad.S1.Ep01', { season: 1, seasonTo: null, episode: 1, episodeTo: null, complete: false }],
    ['Sintel.2010.1080p.WEB.H264', { season: null, seasonTo: null, episode: null, episodeTo: null, complete: false }],
  ])('reads %s', (text, ref) => {
    expect(parseEpisodeRef(text)).toEqual(ref);
  });
});

describe('episodeFit', () => {
  it('tells an episode, a pack that holds it, another episode and a name that says nothing apart', () => {
    expect(episodeFit('Breaking.Bad.S01E01.720p', null, 1, 1)).toBe('match');
    expect(episodeFit('Breaking.Bad.S01E02.720p', null, 1, 1)).toBe('other');
    expect(episodeFit('Breaking.Bad.S01-S05.1080p', null, 3, 4)).toBe('pack');
    expect(episodeFit('Breaking.Bad.S01-S05.1080p', null, 6, 1)).toBe('other');
    expect(episodeFit('Breaking Bad Complete 1080p', null, 2, 1)).toBe('pack');
    expect(episodeFit('Breaking Bad S01 Complete - 1080p', 'Ep 01 - Pilot.mkv', 1, 1)).toBe('match');
    expect(episodeFit('Breaking Bad S01 Complete - 1080p', 'Ep 01 - Pilot.mkv', 1, 2)).toBe('other');
    expect(episodeFit('Breaking Bad 1080p', null, 1, 1)).toBe('unknown');
  });
});
```

### Step 15: Ranking tests
**File:** `tests/unit/directStream/torrent/find/rank.test.ts:1` (new)
**Code:**
```ts
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { candidateFrom } from '../../../../../src/directStream/torrent/find/candidate.js';
import { rankCandidates } from '../../../../../src/directStream/torrent/find/rank.js';
import type { IndexRow, TorrentQuery } from '../../../../../src/directStream/torrent/find/types.js';

const FILM: TorrentQuery = { kind: 'movie', imdbId: 'tt1727587', title: 'Sintel', originalLanguage: 'en' };
const EPISODE: TorrentQuery = { kind: 'tv', imdbId: 'tt0903747', season: 1, episode: 1, title: 'Breaking Bad', originalLanguage: 'en' };
const MB = 1024 * 1024;
const hashOf = (text: string): string => createHash('sha1').update(text).digest('hex');
function row(name: string, seeds: number, extra: Partial<IndexRow> = {}): IndexRow {
  return { infoHash: hashOf(name), name, seeds, sizeBytes: 500 * MB, ...extra };
}

describe('rankCandidates', () => {
  it('never keeps a candidate under the seed floor', () => {
    const four = candidateFrom(row('Sintel.2010.1080p.WEB.H264-FOUR', 4), 'apibay', FILM);
    const five = candidateFrom(row('Sintel.2010.1080p.WEB.H264-FIVE', 5), 'apibay', FILM);
    const ranked = rankCandidates([four, five], FILM);
    expect(ranked.kept.map((c) => c.name)).toEqual(['Sintel.2010.1080p.WEB.H264-FIVE']);
    expect(ranked.excluded).toEqual([{ infoHash: four.infoHash, name: four.name, index: 'apibay', seeds: 4, reason: 'few_seeds' }]);
    expect(rankCandidates([four, five], FILM, { minSeeds: 0, goodSeeds: 20, maxSizeBytes: 25 * 1024 ** 3 }).kept).toHaveLength(2);
  });

  it('orders a direct release first, then well seeded, then 1080p > 720p > 2160p > 480p, then more seeds', () => {
    const rows = [
      row('Sintel.2010.2160p.WEB.x265-A', 900),
      row('Sintel.2010.1080p.WEB.x264-B', 30),
      row('Sintel.2010.720p.WEB.x264.AAC-C', 6, { fileName: 'Sintel.2010.720p.WEB.x264.AAC-C.mp4' }),
      row('Sintel.2010.1080p.WEB.x264.AAC-D', 8, { fileName: 'Sintel.2010.1080p.WEB.x264.AAC-D.mp4' }),
      row('Sintel.2010.720p.WEB.x264-E', 300),
      row('Sintel.2010.1080p.WEB.x264-F', 31),
      row('Sintel.2010.480p.WEB.x264-G', 25),
    ];
    const ranked = rankCandidates(
      rows.map((r) => candidateFrom(r, 'apibay', FILM)),
      FILM,
    );
    expect(ranked.kept.map((c) => c.name.slice(-1))).toEqual(['D', 'C', 'F', 'B', 'E', 'A', 'G']);
  });

  it('joins one torrent listed by several indexes into one candidate with the most seeds', () => {
    const hash = hashOf('shared');
    const fromTorrentio = candidateFrom(
      row('Sintel 2010 720p BluRay', 30, { infoHash: hash.toUpperCase(), fileName: 'Sintel.2010.720p.BluRay.x264.AAC-[YTS.MX].mp4', fileIdx: 0, trackers: ['udp://a.example:1/announce'] }),
      'torrentio',
      FILM,
    );
    const fromYts = candidateFrom(row('Sintel (2010) [720p] [bluray] [x264] [YTS]', 41, { infoHash: hash, trackers: ['udp://b.example:1/announce'] }), 'yts', FILM);
    const ranked = rankCandidates([fromTorrentio, fromYts], FILM);
    expect(ranked.kept).toHaveLength(1);
    expect(ranked.kept[0]).toMatchObject({ infoHash: hash, seeds: 41, index: 'torrentio', listedBy: ['torrentio', 'yts'], fileName: 'Sintel.2010.720p.BluRay.x264.AAC-[YTS.MX].mp4', fileIdx: 0 });
    expect(ranked.kept[0]?.trackers).toEqual(expect.arrayContaining(['udp://a.example:1/announce', 'udp://b.example:1/announce']));
  });

  it('leaves out a single file over the size ceiling, never a pack for it', () => {
    const single = candidateFrom(row('Breaking.Bad.S01E01.2160p.REMUX', 50, { sizeBytes: 30 * 1024 ** 3 }), 'apibay', EPISODE);
    const pack = candidateFrom(row('Breaking.Bad.S01-S05.2160p.REMUX', 50, { sizeBytes: 600 * 1024 ** 3 }), 'apibay', EPISODE);
    const ranked = rankCandidates([single, pack], EPISODE);
    expect(ranked.kept.map((c) => c.infoHash)).toEqual([pack.infoHash]);
    expect(ranked.excluded.map((e) => e.reason)).toEqual(['too_big']);
  });

  it('leaves out a malformed or all-zero info hash and a release of another title', () => {
    const zero = candidateFrom(row('Sintel.2010.1080p.WEB', 50, { infoHash: '0'.repeat(40) }), 'apibay', FILM);
    const short = candidateFrom(row('Sintel.2010.720p.WEB', 50, { infoHash: 'abc123' }), 'apibay', FILM);
    const other = candidateFrom(row('Breaking.In.S01E01.Pilot.1080p', 50), 'torrentio', EPISODE, true);
    expect(rankCandidates([zero, short], FILM).excluded.map((e) => e.reason)).toEqual(['bad_hash', 'bad_hash']);
    expect(rankCandidates([other], EPISODE).excluded.map((e) => e.reason)).toEqual(['other_title']);
  });
});
```

### Step 16: pickFile tests
**File:** `tests/unit/directStream/torrent/find/pickFile.test.ts:1` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import { pickFile } from '../../../../../src/directStream/torrent/find/pickFile.js';
import type { TorrentFileLike, TorrentQuery } from '../../../../../src/directStream/torrent/find/types.js';

const MB = 1024 * 1024;
const FILM: TorrentQuery = { kind: 'movie', imdbId: 'tt1727587' };
function episode(season: number, ep: number, absoluteEpisode: number | null = null): TorrentQuery {
  return { kind: 'tv', imdbId: 'tt0903747', season, episode: ep, absoluteEpisode };
}
function files(...entries: Array<[string, number]>): TorrentFileLike[] {
  return entries.map(([path, length], index) => ({ index, path, length }));
}

describe('pickFile', () => {
  it("picks a film's largest video and the subtitles beside it or in Subs, never a sample or a trailer", () => {
    const list = files(
      ['Sintel (2010)/Sintel.2010.720p.mp4', 140 * MB],
      ['Sintel (2010)/Sample/sample.mp4', 60 * MB],
      ['Sintel (2010)/Sintel.Trailer.mp4', 200 * MB],
      ['Sintel (2010)/Subs/English.srt', 1],
      ['Sintel (2010)/Sintel.2010.720p.en.srt', 1],
      ['Sintel (2010)/WWW.YTS.MX.jpg', 1],
      ['Sintel (2010)/Other/notes.srt', 1],
    );
    expect(pickFile(list, FILM)).toEqual({ video: 0, subtitles: [3, 4] });
  });

  it('plays a lone small video', () => {
    expect(pickFile(files(['Short/Short.2019.mkv', 30 * MB]), FILM)).toEqual({ video: 0, subtitles: [] });
  });

  it("picks the episode inside a multi-season pack and only that episode's subtitles", () => {
    const root = 'Breaking Bad (2008) Season 1-5 S01-S05 (1080p BluRay x265 HEVC 10bit AAC 5.1 Silence) [QxR]';
    const list = files(
      [`${root}/Season 1/Breaking Bad (2008) - S01E01 - Pilot (1080p BluRay x265 Silence).mkv`, 900 * MB],
      [`${root}/Season 1/Breaking Bad (2008) - S01E02 - Cat's in the Bag (1080p BluRay x265 Silence).mkv`, 800 * MB],
      [`${root}/Season 2/Breaking Bad (2008) - S02E02 - Grilled (1080p BluRay x265 Silence).mkv`, 850 * MB],
      [`${root}/Season 1/Breaking Bad (2008) - S01E02 - Cat's in the Bag (1080p BluRay x265 Silence).en.srt`, 1],
      [`${root}/Season 1/Breaking Bad (2008) - S01E01 - Pilot (1080p BluRay x265 Silence).en.srt`, 1],
      [`${root}/Featurettes/Breaking Bad S01E02 Inside.mkv`, 300 * MB],
    );
    expect(pickFile(list, episode(1, 2))).toEqual({ video: 1, subtitles: [3] });
  });

  it('reads Subs folders named after the episode file', () => {
    const list = files(
      ['Show.S01.1080p/Show.S01E01.1080p.mkv', 900 * MB],
      ['Show.S01.1080p/Show.S01E02.1080p.mkv', 900 * MB],
      ['Show.S01.1080p/Subs/Show.S01E02.1080p/2_English.srt', 1],
      ['Show.S01.1080p/Subs/Show.S01E01.1080p/2_English.srt', 1],
    );
    expect(pickFile(list, episode(1, 2))).toEqual({ video: 1, subtitles: [2] });
  });

  it('reads "Ep 02" under a season folder, 1x02, and an anime\'s absolute number', () => {
    expect(pickFile(files(['Breaking Bad S01/Ep 01 - Pilot.mkv', 700 * MB], ['Breaking Bad S01/Ep 02 - Cat in the Bag.mkv', 700 * MB]), episode(1, 2))?.video).toBe(1);
    expect(pickFile(files(['BB/BB 1x01 Pilot.mkv', 700 * MB], ['BB/BB 1x02 Cat.mkv', 700 * MB]), episode(1, 2))?.video).toBe(1);
    const anime = files(['One Piece/[SubsPlease] One Piece - 1070 (1080p).mkv', 1400 * MB], ['One Piece/[SubsPlease] One Piece - 1071 (1080p).mkv', 1400 * MB]);
    expect(pickFile(anime, episode(21, 179, 1071))).toEqual({ video: 1, subtitles: [] });
  });

  it('answers null when the torrent does not hold the episode', () => {
    expect(pickFile(files(['Show S01/Show.S01E01.mkv', 700 * MB], ['Show S01/Show.S01E02.mkv', 700 * MB]), episode(1, 5))).toBeNull();
    expect(pickFile(files(['Breaking.Bad.S01E02.720p.mkv', 400 * MB]), episode(1, 1))).toBeNull();
    expect(pickFile(files(['Film/sample.mkv', 30 * MB]), FILM)).toBeNull();
    expect(pickFile(files(['Breaking.Bad.S01E01.720p.mkv', 400 * MB], ['Breaking.Bad.S01E01.720p.srt', 1]), episode(1, 1))).toEqual({ video: 0, subtitles: [1] });
  });
});
```

### Step 17: Index tests
**File:** `tests/unit/directStream/torrent/find/indexes.test.ts:1` (new)
**Code:**
```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { apibayIndex } from '../../../../../src/directStream/torrent/find/apibay.js';
import { DEFAULT_TRACKERS } from '../../../../../src/directStream/torrent/find/candidate.js';
import { eztvIndex } from '../../../../../src/directStream/torrent/find/eztv.js';
import { getIndexJson } from '../../../../../src/directStream/torrent/find/http.js';
import { torrentioIndex } from '../../../../../src/directStream/torrent/find/torrentio.js';
import type { IndexContext, TorrentQuery } from '../../../../../src/directStream/torrent/find/types.js';
import { ytsIndex } from '../../../../../src/directStream/torrent/find/yts.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/torrent');
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8');
const SINTEL: TorrentQuery = { kind: 'movie', imdbId: 'tt1727587', title: 'Sintel', originalLanguage: 'en' };

function ctxFor(routes: Record<string, string | Response>): { ctx: IndexContext; urls: string[] } {
  const urls: string[] = [];
  const ctx: IndexContext = {
    signal: new AbortController().signal,
    fetch: async (url) => {
      urls.push(url);
      const answer = routes[url];
      if (answer === undefined) throw new TypeError(`fetch failed: no route for ${url}`);
      return typeof answer === 'string' ? new Response(answer, { status: 200 }) : answer;
    },
  };
  return { ctx, urls };
}

describe('torrentio', () => {
  it('reads a film answer: release, file, seeds, size, site, trackers', async () => {
    const { ctx, urls } = ctxFor({ 'https://torrentio.example/stream/movie/tt1727587.json': fixture('torrentio-movie-sintel.json') });
    const answer = await torrentioIndex('https://torrentio.example/').find(SINTEL, ctx);
    expect(urls).toEqual(['https://torrentio.example/stream/movie/tt1727587.json']);
    expect(answer.outcome).toBe('ok');
    expect(answer.candidates).toHaveLength(32);
    const yts = answer.candidates.find((c) => c.infoHash === 'a779fa758f2229586eebc2e5960eb32fe5659596');
    expect(yts).toMatchObject({
      name: 'Sintel 2010 720p BluRay',
      fileName: 'Sintel.2010.720p.BluRay.x264.AAC-[YTS.MX].mp4',
      fileIdx: 0,
      seeds: 30,
      sizeBytes: 143099167,
      site: 'YTS',
      index: 'torrentio',
      scoped: false,
    });
    expect(yts?.release.direct).toBe(true);
    const rutor = answer.candidates.find((c) => c.infoHash === 'c334138ef5bfc2d568ea7324e0e2a3a7ec229bdd');
    expect(rutor?.trackers).toEqual(expect.arrayContaining(['http://retracker.local/announce', DEFAULT_TRACKERS[0]]));
  });

  it('reads an episode answer and marks it scoped to the episode', async () => {
    const query: TorrentQuery = { kind: 'tv', imdbId: 'tt0903747', season: 1, episode: 1, title: 'Breaking Bad', originalLanguage: 'en' };
    const { ctx } = ctxFor({ 'https://torrentio.example/stream/series/tt0903747:1:1.json': fixture('torrentio-series-bb-s01e01.json') });
    const answer = await torrentioIndex('https://torrentio.example').find(query, ctx);
    expect(answer.candidates).toHaveLength(18);
    expect(answer.candidates.every((c) => c.scoped)).toBe(true);
    expect(answer.candidates.find((c) => c.infoHash === 'b43df67a93863ea91f2f773f00361072da771dd3')).toMatchObject({
      fileIdx: 245,
      fileName: 'Breaking Bad (2008) - S01E01 - Pilot (1080p BluRay x265 Silence).mkv',
      seeds: 523,
    });
  });
});

describe('apibay', () => {
  it('reads rows and lower-cases the info hash', async () => {
    const { ctx } = ctxFor({ 'https://apibay.example/q.php?q=tt1727587': fixture('apibay-sintel.json') });
    const answer = await apibayIndex('https://apibay.example').find(SINTEL, ctx);
    expect(answer.outcome).toBe('ok');
    expect(answer.candidates).toHaveLength(19);
    expect(answer.candidates[0]).toMatchObject({ infoHash: '43f4001de4ab25d521c63684e2b69804193ed9d9', name: 'Sintel.2010.1080p.WEB.H264-CLASSiCALHD', seeds: 22, sizeBytes: 583689809, site: 'ThePirateBay' });
    expect(answer.candidates[0]?.trackers).toEqual([...DEFAULT_TRACKERS]);
  });

  it('reads "No results returned" as empty', async () => {
    const { ctx } = ctxFor({ 'https://apibay.example/q.php?q=tt1727587': fixture('apibay-empty.json') });
    expect(await apibayIndex('https://apibay.example').find(SINTEL, ctx)).toEqual({ outcome: 'empty', detail: 'nothing listed', candidates: [] });
  });
});

describe('eztv', () => {
  it('asks by the IMDb digits and keeps the asked episode only', async () => {
    const query: TorrentQuery = { kind: 'tv', imdbId: 'tt0903747', season: 2, episode: 2 };
    const { ctx, urls } = ctxFor({ 'https://eztv.example/api/get-torrents?imdb_id=0903747&limit=100&page=1': fixture('eztv-page.json') });
    const answer = await eztvIndex('https://eztv.example').find(query, ctx);
    expect(urls).toHaveLength(1);
    expect(answer.candidates).toHaveLength(1);
    expect(answer.candidates[0]).toMatchObject({ infoHash: '1697fa425af41580da18a07b3dd0bc6b589c51a0', seeds: 0, sizeBytes: 924303336, index: 'eztv' });
    expect(answer.candidates[0]?.trackers).toEqual(expect.arrayContaining(['udp://tracker.opentrackr.org:1337/announce', 'https://tracker.zhuqiy.com:443/announce']));
  });
});

describe('yts', () => {
  it('reads every torrent of the asked film as MP4 with AAC', async () => {
    const { ctx } = ctxFor({ 'https://yts.example/api/v2/list_movies.json?query_term=tt1727587': fixture('yts-sintel.json') });
    const answer = await ytsIndex('https://yts.example/api/v2').find(SINTEL, ctx);
    expect(answer.candidates.map((c) => c.infoHash)).toEqual([
      'a779fa758f2229586eebc2e5960eb32fe5659596',
      'b9c4e2d4c0f43a5d1e8f7a6b5c4d3e2f1a0b9c8d',
      '3d0000000000000000000000000000000000ab3d',
    ]);
    expect(answer.candidates[1]).toMatchObject({ name: 'Sintel (2010) [1080p] [bluray] [x264] [YTS]', seeds: 12, site: 'YTS' });
    expect(answer.candidates[1]?.release).toMatchObject({ direct: true, height: 1080 });
    expect(answer.candidates[2]?.release.threeD).toBe(true);
  });

  it('reads an empty list as empty', async () => {
    const { ctx } = ctxFor({ 'https://yts.example/api/v2/list_movies.json?query_term=tt1727587': '{"status":"ok","data":{"movie_count":0}}' });
    expect((await ytsIndex('https://yts.example/api/v2').find(SINTEL, ctx)).outcome).toBe('empty');
  });
});

describe('getIndexJson', () => {
  it('reads a Cloudflare challenge as bot_check, a failed status as error, and text that is not JSON as error', async () => {
    const page = fixture('cloudflare-challenge.html');
    const cases: Array<[Response, unknown]> = [
      [new Response(page, { status: 403, headers: { 'cf-mitigated': 'challenge' } }), { ok: false, outcome: 'bot_check', detail: 'HTTP 403: a bot check page' }],
      [new Response(page, { status: 503 }), { ok: false, outcome: 'bot_check', detail: 'HTTP 503: a bot check page' }],
      [new Response(page, { status: 200, headers: { 'content-type': 'text/html' } }), { ok: false, outcome: 'bot_check', detail: 'HTTP 200: a bot check page' }],
      [new Response('', { status: 500 }), { ok: false, outcome: 'error', detail: 'HTTP 500' }],
      [new Response('<html>maintenance</html>', { status: 200 }), { ok: false, outcome: 'error', detail: 'the answer is not JSON' }],
      [new Response('[1]', { status: 200 }), { ok: true, json: [1] }],
    ];
    for (const [res, expected] of cases) {
      const { ctx } = ctxFor({ 'https://index.example/x': res });
      expect(await getIndexJson(ctx, 'https://index.example/x')).toEqual(expected);
    }
  });
});
```

### Step 18: findCandidates tests
**File:** `tests/unit/directStream/torrent/find/findCandidates.test.ts:1` (new)
**Change:** Drives the public entry over recorded answers with a fake fetch. These are the criterion
tests. The expected Breaking Bad order follows from the rules in Steps 3 and 10 (no direct release
among them; well seeded first; 1080p, then 720p, then 2160p; then seeds). If it fails, fix the code
to the rule. Do not change the expectation.
**Code:**
```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { candidateFrom } from '../../../../../src/directStream/torrent/find/candidate.js';
import { findCandidates, TORRENT_INDEX_USER_AGENT } from '../../../../../src/directStream/torrent/find/find.js';
import type { FetchLike, TorrentIndex, TorrentQuery } from '../../../../../src/directStream/torrent/find/types.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/torrent');
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8');

const SINTEL: TorrentQuery = { kind: 'movie', imdbId: 'tt1727587', title: 'Sintel', year: 2010, originalLanguage: 'en' };
const BREAKING_BAD: TorrentQuery = { kind: 'tv', imdbId: 'tt0903747', season: 1, episode: 1, title: 'Breaking Bad', originalLanguage: 'en' };
const TORRENTIO_FILM = 'https://torrentio.strem.fun/stream/movie/tt1727587.json';
const TORRENTIO_EPISODE = 'https://torrentio.strem.fun/stream/series/tt0903747:1:1.json';
const APIBAY_FILM = 'https://apibay.org/q.php?q=tt1727587';
const APIBAY_SERIES = 'https://apibay.org/q.php?q=tt0903747';
const EZTV_SERIES = 'https://eztvx.to/api/get-torrents?imdb_id=0903747&limit=100&page=1';
const YTS_FILM = 'https://yts.mx/api/v2/list_movies.json?query_term=tt1727587';

type Route = () => Response | Promise<Response>;
function fakeFetch(routes: Record<string, Route>): { fetch: FetchLike; calls: Array<{ url: string; userAgent: string | null }> } {
  const calls: Array<{ url: string; userAgent: string | null }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, userAgent: init.headers.get('user-agent') });
    const route = routes[url];
    if (route === undefined) throw new TypeError(`fetch failed: no route for ${url}`);
    return route();
  };
  return { fetch, calls };
}
const body = (text: string, status = 200, headers: Record<string, string> = {}): Route => () => new Response(text, { status, headers });
const hash = (n: number): string => n.toString(16).padStart(40, 'a');
function torrentioAnswer(rows: Array<{ title: string; seeds: number; hash: string }>): string {
  return JSON.stringify({
    streams: rows.map((r) => ({ name: 'Torrentio\n1080p', title: `${r.title}\n👤 ${r.seeds} 💾 1.2 GB ⚙️ ThePirateBay`, infoHash: r.hash, behaviorHints: {} })),
  });
}
const NO_YTS = '{"status":"ok","data":{"movie_count":0}}';

describe('findCandidates', () => {
  it('asks Torrentio, apibay and YTS for a film by its IMDb id and answers ranked candidates', async () => {
    const { fetch, calls } = fakeFetch({
      [TORRENTIO_FILM]: body(fixture('torrentio-movie-sintel.json')),
      [APIBAY_FILM]: body(fixture('apibay-sintel.json')),
      [YTS_FILM]: body(fixture('yts-sintel.json')),
    });
    const found = await findCandidates(SINTEL, { fetch });
    expect(calls.map((c) => c.url).sort()).toEqual([APIBAY_FILM, TORRENTIO_FILM, YTS_FILM].sort());
    expect(calls.every((c) => c.userAgent === TORRENT_INDEX_USER_AGENT)).toBe(true);
    expect(found.indexes.map((a) => [a.index, a.outcome, a.listed])).toEqual([
      ['torrentio', 'ok', 32],
      ['apibay', 'ok', 19],
      ['yts', 'ok', 3],
    ]);
    expect(found.candidates.map((c) => c.infoHash)).toEqual([
      'a779fa758f2229586eebc2e5960eb32fe5659596',
      'b9c4e2d4c0f43a5d1e8f7a6b5c4d3e2f1a0b9c8d',
      '43f4001de4ab25d521c63684e2b69804193ed9d9',
      '150922bce30a1091e347741ebbf96072593a69b4',
    ]);
    for (const c of found.candidates) {
      expect(c.infoHash).toMatch(/^[0-9a-f]{40}$/);
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.seeds).toBeGreaterThanOrEqual(5);
      expect(c.sizeBytes).toBeGreaterThan(0);
    }
    expect(found.candidates[0]).toMatchObject({ listedBy: ['torrentio', 'yts'], fileName: 'Sintel.2010.720p.BluRay.x264.AAC-[YTS.MX].mp4' });
    expect(found.candidates[0]?.release.direct).toBe(true);
    const mitzep = found.excluded.filter((e) => e.infoHash === 'afb2c3f4ee0901947219e69997e95cd7280ca2d7');
    expect(mitzep).toEqual([expect.objectContaining({ seeds: 1, reason: 'few_seeds' })]);
    expect(found.excluded.find((e) => e.infoHash === '3d0000000000000000000000000000000000ab3d')?.reason).toBe('three_d');
  });

  it('asks Torrentio, apibay and EZTV for an episode and keeps only that episode or a pack that holds it', async () => {
    const { fetch, calls } = fakeFetch({
      [TORRENTIO_EPISODE]: body(fixture('torrentio-series-bb-s01e01.json')),
      [APIBAY_SERIES]: body(fixture('apibay-empty.json')),
      [EZTV_SERIES]: body(fixture('eztv-page.json')),
    });
    const found = await findCandidates(BREAKING_BAD, { fetch });
    expect(calls.some((c) => c.url.includes('yts'))).toBe(false);
    expect(found.indexes.map((a) => [a.index, a.outcome])).toEqual([
      ['torrentio', 'ok'],
      ['apibay', 'empty'],
      ['eztv', 'empty'],
    ]);
    expect(found.candidates.map((c) => c.infoHash)).toEqual([
      '6bbad06245a0d631b0a5e47c8cd6e5abc9a70211',
      'b43df67a93863ea91f2f773f00361072da771dd3',
      '97a13de6bb8b741a099a446e755a8a09cfd3a493',
      'a43107ec1e5c2f5d6429c68cc030031cddbcb0ad',
      '3c7a0d35b01b8d3b0abab10bb363cbe0b00ace3a',
      '6a12ce77043c07604314f30fa62f2b17ea8d4ab9',
      'a5c1aefb62c9bd67ff49412544915533155a0b99',
      'a77271af0ceae766101146f62899999e8a45ca41',
      '0d9b239b02f5fa8c4cdda71f3ccfde93ae918bd9',
      'c6d960000329117d615b3bcf1f8f93e521d891ab',
      'f6ed72e8ff4ec570210c66abf54acb4342a7bf62',
      '88a54ed7baef627dc1ecc2fd2df70f8ce990ab09',
    ]);
    expect(Object.fromEntries(found.excluded.map((e) => [e.infoHash, e.reason]))).toEqual({
      '703ff2ed0c176f5c432ea7e7e16a41aa137c9c87': 'dubbed',
      '9b2f37817de4b2a5722f622db6d73ba8c774d94c': 'other_title',
      '167e34bbf6fc3e53382d0c8d2a8fe5852b522e91': 'three_d',
      'bbd4d315a00580f9cafd9c36f35165c83f13043c': 'dubbed',
      'd71705838d78b41eaf4a2e1c8da53dc28027ea68': 'few_seeds',
      '0a03aba4f6395f865b40e5c83b27ae4f630897c1': 'dubbed',
    });
    const rutracker = found.candidates.find((c) => c.infoHash === '97a13de6bb8b741a099a446e755a8a09cfd3a493');
    expect(rutracker?.release).toMatchObject({ dubbed: false, multiAudio: true, direct: false });
  });

  it('leaves out an episode that names another one, from an index that was not asked for that episode', async () => {
    const { fetch } = fakeFetch({
      [TORRENTIO_EPISODE]: body('{"streams":[]}'),
      [APIBAY_SERIES]: body(
        JSON.stringify([
          { name: 'Breaking.Bad.S01E01.720p.HDTV.x264', info_hash: hash(1).toUpperCase(), seeders: '40', size: '500000000', imdb: 'tt0903747' },
          { name: 'Breaking.Bad.S01E02.720p.HDTV.x264', info_hash: hash(2).toUpperCase(), seeders: '90', size: '500000000', imdb: 'tt0903747' },
          { name: 'Breaking.Bad.S01.720p.BluRay.x264', info_hash: hash(3).toUpperCase(), seeders: '30', size: '5000000000', imdb: 'tt0903747' },
          { name: 'Breaking Bad 720p', info_hash: hash(4).toUpperCase(), seeders: '80', size: '500000000', imdb: 'tt0903747' },
        ]),
      ),
      [EZTV_SERIES]: body('{"torrents_count":0,"torrents":[]}'),
    });
    const found = await findCandidates(BREAKING_BAD, { fetch });
    expect(found.candidates.map((c) => c.infoHash)).toEqual([hash(1), hash(3)]);
    expect(found.excluded.map((e) => [e.infoHash, e.reason])).toEqual([
      [hash(2), 'other_episode'],
      [hash(4), 'other_episode'],
    ]);
  });

  it('leaves out dubs, cinema recordings and 3D however many seeds they have', async () => {
    const rows = [
      { title: 'Sintel.2010.1080p.WEB.x264-GOOD', seeds: 50, hash: hash(1) },
      { title: 'Sintel.2010.HDCAM.x264-BAD', seeds: 900, hash: hash(2) },
      { title: 'Sintel 2010 1080p TELESYNC', seeds: 800, hash: hash(3) },
      { title: 'Sintel.2010.1080p.3D.HSBS.BluRay.x264', seeds: 700, hash: hash(4) },
      { title: 'Sintel.2010.1080p.Hindi.Dubbed.WEB-DL', seeds: 600, hash: hash(5) },
      { title: 'Sintel (2010) 1080p Latino', seeds: 500, hash: hash(6) },
      { title: 'Sintel.2010.MULTi.1080p.WEB.x264', seeds: 40, hash: hash(7) },
    ];
    const { fetch } = fakeFetch({
      [TORRENTIO_FILM]: body(torrentioAnswer(rows)),
      [APIBAY_FILM]: body(fixture('apibay-empty.json')),
      [YTS_FILM]: body(NO_YTS),
    });
    const found = await findCandidates(SINTEL, { fetch });
    expect(found.candidates.map((c) => c.infoHash)).toEqual([hash(1), hash(7)]);
    expect(found.excluded.map((e) => [e.infoHash, e.reason])).toEqual([
      [hash(2), 'cam'],
      [hash(3), 'cam'],
      [hash(4), 'three_d'],
      [hash(5), 'dubbed'],
      [hash(6), 'dubbed'],
    ]);
  });

  it('records an index that times out or answers a bot check and goes on with the others', async () => {
    const { fetch } = fakeFetch({
      [TORRENTIO_FILM]: body(fixture('cloudflare-challenge.html'), 403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' }),
      [APIBAY_FILM]: body(fixture('apibay-sintel.json')),
      [YTS_FILM]: () => new Promise<Response>(() => {}),
    });
    const found = await findCandidates(SINTEL, { fetch, timeoutMs: 50 });
    expect(found.indexes).toEqual([
      expect.objectContaining({ index: 'torrentio', outcome: 'bot_check', listed: 0 }),
      expect.objectContaining({ index: 'apibay', outcome: 'ok', listed: 19 }),
      expect.objectContaining({ index: 'yts', outcome: 'error', detail: expect.stringMatching(/^timed out after /), listed: 0 }),
    ]);
    expect(found.candidates.map((c) => c.infoHash)).toEqual(['43f4001de4ab25d521c63684e2b69804193ed9d9', '150922bce30a1091e347741ebbf96072593a69b4']);
  });

  it('records an index that fails or answers an error status, and answers nothing rather than throwing', async () => {
    const { fetch } = fakeFetch({
      [TORRENTIO_EPISODE]: body('', 500),
      [EZTV_SERIES]: body(fixture('cloudflare-challenge.html'), 200, { 'content-type': 'text/html' }),
    });
    const found = await findCandidates(BREAKING_BAD, { fetch });
    expect(found.indexes).toEqual([
      expect.objectContaining({ index: 'torrentio', outcome: 'error', detail: 'HTTP 500' }),
      expect.objectContaining({ index: 'apibay', outcome: 'error', detail: expect.stringContaining('fetch failed') }),
      expect.objectContaining({ index: 'eztv', outcome: 'bot_check' }),
    ]);
    expect(found.candidates).toEqual([]);
  });

  it('sends every request as notesd, whatever an index asks for', async () => {
    const sneaky: TorrentIndex = {
      name: 'sneaky',
      async find(_query, ctx) {
        await ctx.fetch('https://index.example/x', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
        return { outcome: 'empty', detail: 'nothing listed', candidates: [] };
      },
    };
    const { fetch, calls } = fakeFetch({ 'https://index.example/x': body('{}') });
    await findCandidates(SINTEL, { fetch, indexes: [sneaky] });
    expect(calls).toEqual([{ url: 'https://index.example/x', userAgent: TORRENT_INDEX_USER_AGENT }]);
  });

  it('asks the fallback only when the JSON indexes give no usable candidate', async () => {
    const asked: string[] = [];
    const fallback: TorrentIndex = {
      name: '1337x',
      async find(query) {
        asked.push(query.imdbId);
        const row = { infoHash: hash(9), name: 'Sintel.2010.1080p.WEB.x264-FB', seeds: 60, sizeBytes: 900 * 1024 * 1024 };
        return { outcome: 'ok', detail: '1 listed', candidates: [candidateFrom(row, '1337x', query)] };
      },
    };
    const lowSeeds: TorrentIndex = {
      name: 'torrentio',
      async find(query) {
        const row = { infoHash: hash(8), name: 'Sintel.2010.720p.WEB.x264', seeds: 2, sizeBytes: 500 * 1024 * 1024 };
        return { outcome: 'ok', detail: '1 listed', candidates: [candidateFrom(row, 'torrentio', query)] };
      },
    };
    const found = await findCandidates(SINTEL, { indexes: [lowSeeds], fallback: [fallback] });
    expect(asked).toEqual(['tt1727587']);
    expect(found.indexes.map((a) => a.index)).toEqual(['torrentio', '1337x']);
    expect(found.candidates.map((c) => c.infoHash)).toEqual([hash(9)]);

    asked.length = 0;
    const usable = await findCandidates(SINTEL, { indexes: [lowSeeds], fallback: [fallback], minSeeds: 1 });
    expect(asked).toEqual([]);
    expect(usable.candidates.map((c) => c.infoHash)).toEqual([hash(8)]);
  });

  it("gives a fallback index its own longer time limit, and a JSON index never more than timeoutMs", async () => {
    const slow = (name: string, ms: number, timeoutMs: number): TorrentIndex => ({
      name,
      timeoutMs,
      find: (query) => new Promise((resolve) => setTimeout(() => resolve({ outcome: 'ok', detail: '1 listed', candidates: [candidateFrom({ infoHash: hash(7), name: 'Sintel.2010.1080p.WEB.x264-FB', seeds: 60, sizeBytes: 1 }, name, query)] }), ms)),
    });
    const found = await findCandidates(SINTEL, { timeoutMs: 20, indexes: [slow('torrentio', 60, 200)], fallback: [slow('1337x', 60, 200)] });
    expect(found.indexes.map((a) => [a.index, a.outcome])).toEqual([['torrentio', 'error'], ['1337x', 'ok']]);
  });

  it('refuses a query that has no IMDb id', async () => {
    await expect(findCandidates({ kind: 'movie', imdbId: 'sintel' })).rejects.toBeInstanceOf(RangeError);
    const seen: string[] = [];
    const recorder: TorrentIndex = {
      name: 'recorder',
      async find(query) {
        seen.push(query.imdbId);
        return { outcome: 'empty', detail: 'nothing listed', candidates: [] };
      },
    };
    await findCandidates({ kind: 'movie', imdbId: '1727587' }, { indexes: [recorder] });
    expect(seen).toEqual(['tt1727587']);
  });
});
```
**Impact:** none. `npm test` picks these files up through `tests/unit/**/*.test.ts`.

## Principles applied

- Boundary discipline: each index reads its own JSON once into an `IndexRow` (`asRecord`/`asText`/`asCount`, in its module). `candidateFrom` is the only place a row becomes a candidate (hash lower-cased or converted from base32, seeds floored, trackers joined with the defaults, release parsed). `findCandidates` normalizes the IMDb id once. Ranking and `pickFile` trust what they get and check nothing again.
- Make illegal states unrepresentable: `TorrentQuery` is a union, so a `tv` query cannot lack `season`/`episode` and a film cannot carry them. That replaces the contract's `season?`/`episode?`. `IndexAnswer.outcome` and `ExcludeReason` are closed unions.
- Encode lessons in structure: invariant 6 (never pose as another client) and the per-index timeout are not left to each index's author. `ctx.fetch` is built by `findCandidates`, sets `user-agent` last (an index's own header is overwritten) and binds the timeout signal. A test (`sends every request as notesd, whatever an index asks for`) has an index try a browser User-Agent. Phase 9's indexes get the same `ctx`.
- Laziness protocol: no settings are read and no daemon wiring is added. Options with exported default constants are enough, and phase 3 maps settings onto them. No retry, no cache, no class hierarchy for indexes: one factory function per index returning a plain object.
- Test behavior, not implementation: the criterion tests drive `findCandidates` over recorded real answers through a fake `fetch` and assert what a caller sees (the order, the outcomes, the reasons), never private helpers.
- Prove it works: on top of the fixture runs, J6 asks the real indexes for the public-domain film Sintel.

## Verification

**Build:** `cd /home/miftah/.worktrees/mcp-notes/torrent-stream-source && npm run typecheck`
**Tests:** `cd /home/miftah/.worktrees/mcp-notes/torrent-stream-source && npx vitest run tests/unit/directStream/torrent/find && npm test`
**Proof:** This phase has no route or tool. Its artifact is the module. It is proven by vitest over
recorded index answers (no network), plus one free, read-only live run against the real indexes for
Sintel (tt1727587, public domain). The live run makes 3 small GETs and joins no swarm.
- Harness: `.claude/skills/verify-notesd` exists, but nothing in it can reach this phase (no daemon path calls `findCandidates` until phase 3), so the journeys run vitest and `tsx` directly.
- Feature-map entries: none. Phase 3 adds the torrent entry to `features/direct-streaming.md` (see Handoffs).
- Journeys:
  - **J1** · traces R1.1 — `cd /home/miftah/.worktrees/mcp-notes/torrent-stream-source && npx vitest run tests/unit/directStream/torrent/find/findCandidates.test.ts tests/unit/directStream/torrent/find/indexes.test.ts -t "asks Torrentio|torrentio|apibay|eztv|yts"` → passes when vitest reports these tests passed and none failed: `asks Torrentio, apibay and YTS for a film by its IMDb id and answers ranked candidates`, `asks Torrentio, apibay and EZTV for an episode and keeps only that episode or a pack that holds it`, `reads a film answer: release, file, seeds, size, site, trackers`, `reads an episode answer and marks it scoped to the episode`, `reads rows and lower-cases the info hash`, `asks by the IMDb digits and keeps the asked episode only`, `reads every torrent of the asked film as MP4 with AAC`. Together they show the four indexes asked by IMDb id at their real addresses (films: Torrentio, apibay, YTS; episodes: Torrentio, apibay, EZTV), each candidate with a 40-hex info hash, a release name, seeds and a size.
  - **J2** · traces R1.2 — `cd /home/miftah/.worktrees/mcp-notes/torrent-stream-source && npx vitest run tests/unit/directStream/torrent/find/rank.test.ts tests/unit/directStream/torrent/find/findCandidates.test.ts -t "seed floor|orders a direct release first|joins one torrent|asks Torrentio, apibay and YTS for a film"` → passes when all 4 tests pass. A candidate with 4 seeds is never kept at the default floor of 5. The direct H.264/AAC/MP4 releases (D, C) come before every remux one, and among equals the one with more seeds comes first (F 31 before B 30). The Sintel answer ranks `a779…` (direct, 30 seeds) first.
  - **J3** · traces R1.3 — `cd /home/miftah/.worktrees/mcp-notes/torrent-stream-source && npx vitest run tests/unit/directStream/torrent/find -t "marks a cinema recording|marks 3D|marks a dub|dub marker|carries the original track|title word|leaves out dubs, cinema recordings and 3D"` → passes when every listed test passes. HDCAM/TELESYNC/HDTS/TS/CAM, 3D/HSBS/Half-SBS, Hindi Dubbed/Latino/TRUEFRENCH/iTALiAN/GERMAN/PT-BR are all left out even with 500–900 seeds. MULTi, Dual-Audio, GERMAN.DL, a subtitle language (SWESUB, ESUB, Legendado) and title words ("The French Dispatch", "Cam", "Step Up 3D") are not.
  - **J4** · traces R1.4 — `cd /home/miftah/.worktrees/mcp-notes/torrent-stream-source && npx vitest run tests/unit/directStream/torrent/find -t "pickFile|parseEpisodeRef|episodeFit|keeps only that episode or a pack|names another one"` → passes when every listed test passes. For S01E01 the Breaking Bad answer keeps only candidates that name that episode or a pack holding season 1. apibay's S01E02 and a name that says nothing are `other_episode`. `pickFile` picks S01E02 inside the QxR S01–S05 pack, with only that episode's `.srt`, and also handles `Ep 02` under `Breaking Bad S01/`, `1x02`, and One Piece `- 1071`. A pack without the episode answers `null`.
  - **J5** · traces R1.5 — `cd /home/miftah/.worktrees/mcp-notes/torrent-stream-source && npx vitest run tests/unit/directStream/torrent/find -t "times out or answers a bot check|fails or answers an error status|sends every request as notesd|Cloudflare challenge"` → passes when all 4 tests pass. A 403 Cloudflare challenge is `bot_check`, a hung YTS is `error` `timed out after 0.1 s`, a 500 is `error` `HTTP 500`, a network failure is `error` with `fetch failed`, and a 200 challenge page is `bot_check`. The other indexes' candidates still come back. Every request, including one where an index set a browser User-Agent, carried `notesd (personal notes daemon; torrent index lookup)`.
  - **J6** · traces R1.1, R1.5 — live and free (3 GETs, no swarm). From the worktree root: `cd /home/miftah/.worktrees/mcp-notes/torrent-stream-source && npx tsx -e "import('./src/directStream/torrent/find/index.ts').then(async (m) => { const r = await m.findCandidates({ kind: 'movie', imdbId: 'tt1727587', title: 'Sintel', year: 2010, originalLanguage: 'en' }); console.log(JSON.stringify({ indexes: r.indexes.map((a) => [a.index, a.outcome, a.detail]), top: r.candidates.slice(0, 3).map((c) => [c.infoHash, c.name, c.seeds, c.sizeBytes, c.release.direct, c.listedBy]) }, null, 1)); })"` → passes when the command exits 0 within about 15 s and prints exactly three `indexes` entries, for `torrentio`, `apibay` and `yts`, each with an outcome among `ok`/`empty`/`error`/`bot_check` (a YTS timeout shows as `["yts","error","timed out after 6 s"]`, not a crash). When `torrentio` or `apibay` is `ok`, `top[0]` must hold a 40-hex info hash, a name containing "Sintel", seeds ≥ 5 and a size > 0. On 2026-11-16 that was `a779fa75…` (YTS 720p, 30 seeds, `direct: true`) or `43f4001d…` (apibay 1080p, 22 seeds).
- Neighbor check: `src/directStream/match.ts` is the only existing module this phase imports. `cd /home/miftah/.worktrees/mcp-notes/torrent-stream-source && npx vitest run tests/unit/directStream/match.test.ts tests/unit/directStream/lookup.test.ts && npm run typecheck` passes when both test files pass and both tsconfig projects typecheck with no error.
- Cost: none billed. J6 makes three anonymous GETs to public indexes.

**Exit criteria:** `npm run typecheck` and `npm test` pass. J1–J5 pass over the fixtures. J6 answers a
ranked Sintel list from the live indexes, with each index's outcome recorded. No file outside
`src/directStream/torrent/find/`, `tests/unit/directStream/torrent/find/` and
`tests/fixtures/torrent/` changed (`git status --porcelain` lists nothing else).

## Handoffs

- **Phase 3 (R1, R2):**
  - Map the finder settings onto `FindOptions` (`minSeeds`, `goodSeeds`, `maxSizeBytes`, `timeoutMs`, `bases`, `yts`, `maxCandidates`, and a `userAgent` carrying the daemon's version if wanted). This phase reads no config.
  - Build `TorrentQuery` from the `StreamRef`, TMDB's `external_ids.imdb_id`, the title, the original title and `original_language`. Pass `absoluteEpisode` for anime when the lookup has one.
  - Turn each `IndexAttempt` into a `ResolveAttempt` with provider `Index: <index>`.
  - **R1.4, the real-list half:** call `pickFile(handle.files, query)` on the file list the engine reports, before selecting files. Torrentio's `fileIdx` is a hint only; `pickFile` decides. A `null` pick moves on to the next candidate.
  - Write the "Torrents → Finding a torrent" subsection of `docs/guide/streaming.md`: the four indexes, the exclusions, the order, the plain User-Agent, `bot_check`. Add the finder's proof (`npx vitest run tests/unit/directStream/torrent/find`) to `.claude/skills/verify-notesd/features/direct-streaming.md`. Invariant 10 asks each phase for this, but this phase's scope forbids files outside `find/`. Moved here so the reconciler can see it.
- **Phase 3 (R1.6):** a candidate with `release.multiAudio` is not excluded. The audio probe must still confirm the original language is among the file's audio streams.
- **Phase 5 (R2.8):** a `multiAudio` release is never `direct`, because Chrome plays the first audio track, which in a Rutracker or Hindi dual release is not the original. The remux should map the original-language audio track, not track 0.
- **Phase 6 (R3.1, R3.2):** `FilePick.subtitles` lists every `.srt/.vtt/.ass/.ssa` beside the chosen video or in its `Subs` folder (for a pack, only the episode's). It is not filtered by language. Choosing the English one, and preferring a candidate whose list has one, is phase 6's job.
- **Phase 9 (R1.7):** build each listing with `candidateFrom(row, '1337x' | 'ext', query)` (`scoped` false) and hand the `TorrentIndex` objects to `findCandidates` as `options.fallback`. They are ranked with the same rules, including the title check (a row must name the asked title). Use `ctx.signal` to stop the Chrome runner when time is up. `ctx.fetch` is irrelevant to them. Phase 9 sets `timeoutMs` on its indexes (40 s); a fallback index keeps that limit even though the JSON indexes' `timeoutMs` is shorter.
- Drive-by found, not done: `src/directStream/anime.ts:25` sends `notesd-direct-stream (plain request; anime id lookup)` while this phase sends `notesd (personal notes daemon; torrent index lookup)`. One shared User-Agent constant for every plain request would be tidier. Left for a later cleanup; it belongs to no phase of this set.

## Rollback

Delete `src/directStream/torrent/find/`, `tests/unit/directStream/torrent/find/` and
`tests/fixtures/torrent/`. No other file changed, nothing imports the module until phase 3, and no
migration, setting or route was added.
