> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/torrent-stream-source/PLAN.md` phase 6. Source: `.workflows/plan/torrent-stream-source/phase-6.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 6: Subtitle files: in the torrent, from a subtitle service, from a cloud provider

**Plan set:** `TORRENT_STREAM_SOURCE_PLAN.md`
**Analysis:** `.workflows/analyze/20261116-192341-T7QK_code_analyzer.md`
**Satisfies:** R3 — "making sure we have english subtitle by any means necessary.. one torrent file can have several files inside, so it has the movie file and the subtitle file.. maybe we can make use of this?"
**Criteria:** R3.1, R3.2, R3.3
**Depends on:** Phase 3 (and through it phases 1 and 2)
**Difficulty:** NORMAL
**Package:** `src/directStream/torrent/subtitles`

---

## Goal

A torrent session gets an English subtitle without a word from the owner. The subtitle tiers try three sources in order: an English subtitle file inside the torrent (or the torrent's one subtitle file when it names no language), then Stremio's OpenSubtitles add-on, matched first by the file's OpenSubtitles hash and then by IMDb id, then a cloud provider's English subtitle, read out of sight. Each answer is kept as WebVTT under the torrent's folder and served by `GET /api/stream/torrent/:hash/sub/:name`, and a later play of the same torrent finds it without asking anything. Before a play opens its first torrent, the files of the best three candidates are listed, and one whose files hold an English subtitle is tried first.

## Interface Contract

**Deletes:** `parseAnimeMapUrl` (`src/config.ts:703`), private. It is replaced by the general `parseUrlOrOff`, which behaves the same and gives the same error text.
**Renames:** none
**Creates:**
- `src/directStream/torrent/subtitles/disk.ts`: `SubtitleShelf` (`dir`, `file`, `save`, `kept`), `keptTier`, `subtitleUrl`, `vttFromBytes`, `vttFromText`, `isFile`, `SUBTITLE_DIR_NAME` (`.notesd-subs`), `SUBTITLE_NAME_PATTERN`, `INFO_HASH_PATTERN`, `KeptSubtitle`
- `src/directStream/torrent/subtitles/files.ts`: `subtitleLanguage`, `subtitleFlavor`, `rankSubtitleFiles`, `hasEnglishSubtitleFile`, `orderByFileLists`, `filesTier`, `ffmpegAssConverter`, `AssConverter`, `TorrentFilePaths`, `CandidateFileList`, `FileListDeps`, `SubtitleFilePick`, `FILE_LIST_CANDIDATES` (3), `FILE_LIST_TIMEOUT_MS` (15 000), `SUBTITLE_FILE_WAIT_MS` (15 000)
- `src/directStream/torrent/subtitles/service.ts`: `serviceTier`, `parseServiceAnswer`, `serviceListUrl`, `chooseServiceSubtitles`, `openSubtitlesHash`, `ServiceSubtitle`, `VideoHash`, `SUBTITLE_SERVICE_USER_AGENT`, `HASH_TIMEOUT_MS`
- `src/directStream/torrent/subtitles/borrow.ts`: `borrowTier`, `SubtitleLender`, `BorrowedSubtitle`, `BORROW_DEADLINE_S` (45)
- In `src/directStream/torrent/subtitles/chain.ts` (phase 3's file): the fields `subtitleUrl`, `fetch`, `lend`, `convertAss` of `SubtitleTierDeps`, and the tiers `kept`, `files`, `service`, `borrow` at phase 3's `// Phase 6` comments in `buildSubtitleTiers` (`SubtitleContext`, `SubtitleTier` and `runSubtitleChain` stay phase 3's)
- `TorrentConfig.subtitleUrl: string | null` and `DEFAULT_TORRENT_SUBTITLE_URL` in `src/config.ts`. The env var is `NOTESD_TORRENT_SUBTITLE_URL`.
- Route `GET /api/stream/torrent/:hash/sub/:name`, added inside phase 1's `streamTorrentRoutes` in `src/http/streamTorrentApi.ts`
- Harness: `.claude/skills/verify-notesd/scripts/torrent/{fake-subs.mjs,make-subtitle-fixtures.sh,subtitles.sh,subtitle-page.steps.mjs}`

**Signature changes:**
- `DirectStreamService.subtitleText(input)` -> `subtitleText(input, options: { deadlineS?: number } = {})` (`src/directStream/service.ts:493`). The new argument is optional, so existing callers keep working.
- `readBody` in `src/directStream/cache/upstream.ts:35` is now exported. Its body is unchanged.
- `resolve`'s `candidates` in `TorrentSource` become a `let` (R3.2 reorders them).

**Requires (from earlier phases):**
- Phase 1, `src/directStream/torrent/types.ts`:
  - `TorrentFileInfo { index, path, name, length }`
  - `TorrentHandle.read(index, { start, end })` returns a Node `Readable`, and `end` is **inclusive** (as in WebTorrent's `createReadStream`)
  - `TorrentStreams.filePath(infoHash, index)` returns the absolute path once the file is complete, else null (sync or async both work)
  - `TorrentStreams.open(pick, { timeoutMs })` is idempotent per info hash: it answers the same handle when the torrent is already open
  - `TorrentStreams.release(infoHash)` drops a torrent that was opened but never `use`d, and is a no-op for an unknown hash
  - `TorrentStreams.view(infoHash)` answers a view carrying `host: string` and `available: boolean` (false for the other machine's download), or null
- Phase 1, disk layout and config:
  - A torrent's files live under `<config.torrent.dir>/<infoHash>/`, and clearing a download (`keepDays`, `remove(…, { deleteFiles: true })`) removes that whole folder. That also removes this phase's `<infoHash>/.notesd-subs/`.
  - `config.torrent.dir` is the resolved absolute folder (a string).
- Phase 1, `src/http/streamTorrentApi.ts`: exports `streamTorrentRoutes(deps)` and a `TORRENT_OFF` answer body that its routes send with 503 when `deps.torrents` is null.
- Phase 3, `chain.ts` and `TorrentSource` (reconciled; phase 3 ships them):
  - `SubtitleContext` carries `ref, imdbId, infoHash, release, files, fileIndex, subtitleIndexes, handle, probe, audioLang, resumeS, cloudTried, localBase, signal, deadline`; `SubtitleTier` is `{ name, blocks, skip?, find }`.
  - `runSubtitleChain` stops at the first non-empty answer, records one `Subtitles: <tier>` attempt per tier (`resolved`, `no_stream`, `error`, `skipped`), and gives the blocking tiers one shared 40 s budget from the chain's start (`ctx.deadline`).
  - `TorrentSource` runs the chain on a replay from disk too (`handle: null`, `files: []`, `subtitleIndexes: []`, the recorded `release`), calls `swarm.use(infoHash, [video, ...subtitles])` before the chain (R2.2), appends the chain's attempts to the play's, and passes `cloudTried` after a cloud `no_source`.
  - It is **not** called inside `DirectStreamService.serial()`. The borrow tier calls `subtitleText`, which queues on `serial()`, so a call from inside it would deadlock.
  - `config.torrent.ffmpegBin` (`NOTESD_FFMPEG_BIN`) is phase 3's; `ffmpegAssConverter` is handed it in `src/daemon.ts`.
- Phase 2: `pickFile(files, query)` returns `{ video, subtitles }`.
- Phase 3's harness: the fake TMDB answers an `external_ids.imdb_id` for films 467905, 990001 to 990004 and series 247718. The fake index answers every query from `$TORRENT/candidates.json` (`[{info_hash, name, seeds?, size_bytes?}]`) when it exists, naming each release `<Title>.<Year>.<name>` after the asked title. Phase 1's seeder seeds a folder moved into `$TORRENT/seed/<name>/` and writes `$TORRENT/seeded/<name>.json`.

**Leaves alone (owned by others):**
- `web/` (all of it; the page already turns on the English or the lone unnamed subtitle)
- `subtitles/embedded.ts` (phase 7, inserted between `files` and `service`)
- `subtitles/whisper.ts` (phase 8, the chain's last tier)
- `remux.ts` (phase 5)
- the engine, store, finder and ranker (phases 1 and 2)
- every other branch of `source.ts` and `service.ts` (phase 3)

## Files

| File | Action | What changes |
|---|---|---|
| `src/directStream/torrent/subtitles/disk.ts` | create | the subtitle folder per torrent, atomic saves, `chosen.json`, the `kept` tier, WebVTT from bytes |
| `src/directStream/torrent/subtitles/files.ts` | create | subtitle file language and flavour from names, ranking, the bounded wait, the `files` tier, ASS via ffmpeg, `orderByFileLists` (R3.2) |
| `src/directStream/torrent/subtitles/service.ts` | create | OpenSubtitles hash, the add-on's addresses, parsing and choosing, the `service` tier |
| `src/directStream/torrent/subtitles/borrow.ts` | create | the `borrow` tier over `DirectStreamService.subtitleText` |
| `src/directStream/torrent/subtitles/chain.ts` | modify (phase 3's file) | `SubtitleTierDeps` fields; `kept`, `files`, `service`, `borrow` in `buildSubtitleTiers` |
| `src/directStream/torrent/source.ts` | modify (phase 3's file) | call `orderByFileLists` at phase 3's marked line in `resolve` |
| `src/directStream/service.ts:493` | modify | `subtitleText(input, { deadlineS })` |
| `src/directStream/cache/upstream.ts:35` | modify | `export` on `readBody` |
| `src/config.ts:696,703` + phase 1's `TorrentConfig`/`parseTorrent`/`DEFAULT_TORRENT_CONFIG` | modify | `subtitleUrl`, `DEFAULT_TORRENT_SUBTITLE_URL`, `parseUrlOrOff` |
| `src/daemon.ts` (phase 3's `buildSubtitleTiers({...})` call) | modify | `subtitleUrl`, `fetch`, `lend`, `convertAss` |
| `src/http/streamTorrentApi.ts` (phase 1's file) | modify | the subtitle route |
| `scripts/docs/httpRoutes.ts` (beside phase 1's torrent routes) | modify | describe the route; then `npm run docs:gen` |
| `docs/guide/reference/http-api.md` | regenerate | `npm run docs:gen` |
| `docs/guide/reference/configuration.md` (after phase 1's `NOTESD_TORRENT_KEEP_DAYS` row) | modify | `NOTESD_TORRENT_SUBTITLE_URL` row |
| `docs/guide/streaming.md` (under phase 1/3's `### Torrents`) | modify | `#### Subtitles for a torrent` |
| `.claude/skills/verify-notesd/features/direct-streaming.md:325` (before `## Gotchas`) | modify | `## Torrent subtitles` entry |
| `.claude/skills/verify-notesd/scripts/verify.sh` (phase 1's `--torrent` block, the address printout near `:311`, `down` near `:465`) | modify | start, point at and stop the fake subtitle service |
| `.claude/skills/verify-notesd/scripts/torrent/fake-subs.mjs` | create | the fake subtitle service |
| `.claude/skills/verify-notesd/scripts/torrent/make-subtitle-fixtures.sh` | create | fixture torrent folders |
| `.claude/skills/verify-notesd/scripts/torrent/subtitles.sh` | create | the journeys |
| `.claude/skills/verify-notesd/scripts/torrent/subtitle-page.steps.mjs` | create | the page shows it by default |
| `tests/fixtures/torrent-subtitles/opensubs-sintel.json` | create | cut from `.workflows/analyze/torrent-samples/opensubs-v3.json` |
| `tests/unit/directStream/torrent/subtitles/disk.test.ts` | create | shelf, kept, names |
| `tests/unit/directStream/torrent/subtitles/files.test.ts` | create | language, ranking, R3.2 order, files tier |
| `tests/unit/directStream/torrent/subtitles/service.test.ts` | create | hash, addresses, choosing, the service tier |
| `tests/unit/directStream/torrent/subtitles/borrow.test.ts` | create | the borrow tier |
| `tests/unit/directStream/torrent/subtitles/chain.test.ts` | create | this phase's tier order |
| `tests/unit/directStream/torrent/subtitles/context.ts` | create | `REST_OF_CONTEXT`, the context fields a tier test does not care about |
| `tests/unit/directStream/torrent/subtitleRoute.test.ts` | create | the route |
| `tests/unit/config.test.ts` (phase 1's torrent config test) | modify | `subtitleUrl` |

## Implementation Steps

### Step 1: Export `readBody` and let `subtitleText` take a deadline

**File:** `src/directStream/cache/upstream.ts:35`
**Change:** add `export` to the existing function. Nothing else changes.
**Code:**
```ts
export async function readBody(res: Response, cap: number, truncate: boolean): Promise<Buffer | null> {
  if (res.body === null) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (truncate && size >= cap) {
      await reader.cancel().catch(() => undefined);
      break;
    }
    if (size > cap) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
  }
  return Buffer.concat(chunks);
}
```

**File:** `src/directStream/service.ts:486-511`
**Change:** pass an optional resolver deadline through to `resolve`. The borrow tier needs it so the resolve stops after `BORROW_DEADLINE_S` and leaves the streaming Chrome's queue free.
**Code:**
```ts
  /**
   * The text of the title's English subtitle, for its dialogue (dialogue.ts) and for a torrent
   * session that has none (the borrow tier, torrent/subtitles/borrow.ts). Resolves the title like
   * a play does, out of sight, and opens no player: then reads the first English track that
   * holds cues, through the same pass-through rules as the player (the session's hosts, the
   * captured headers). A separate file is tried before a track inside the manifest. `deadlineS`
   * becomes the resolver's `--deadline-s`. Throws what `resolve` throws, or `no_subtitle` when the
   * source that resolved has no English track that can be read.
   */
  async subtitleText(input: StreamRefInput, options: { deadlineS?: number } = {}): Promise<{ provider: string; label: string; vtt: string; attempts: ResolveAttempt[] }> {
    const session = await this.resolve(input, options.deadlineS === undefined ? {} : { deadlineS: options.deadlineS });
    const english = session.source.subtitles.filter((t) => isEnglish(t));
    const tracks = [...english.filter((t) => t.source === 'request'), ...english.filter((t) => t.source !== 'request')];
    for (const track of tracks) {
      const vtt = await this.readSubtitle(session, track.url, track.format).catch(() => null);
      if (vtt !== null && parseCues(vtt).length >= DIALOGUE_MIN_CUES) {
        return { provider: session.source.provider, label: track.label, vtt, attempts: session.attempts };
      }
    }
    throw new DirectStreamError(
      'no_subtitle',
      tracks.length === 0
        ? `${session.source.provider} streams ${refLabel(session.ref)} without an English subtitle.`
        : `${session.source.provider} names an English subtitle for ${refLabel(session.ref)}, but it could not be read.`,
      { attempts: session.attempts },
    );
  }
```
**Impact:** none for existing callers. `npx vitest run tests/unit/directStream` stays green.

### Step 2: The subtitle service's address setting

**File:** `src/config.ts`
**Change:**
- Next to `DEFAULT_ANIME_MAP_URL` (`:194`), add the default.
- Add `subtitleUrl` to phase 1's `TorrentConfig`, set it to `null` in `DEFAULT_TORRENT_CONFIG`, and parse it in `parseTorrent`.
- Replace `parseAnimeMapUrl` (`:702-709`) with `parseUrlOrOff`, and point `parseDirectStream` (`:696`) at it.

**Code:**
```ts
/** Stremio's OpenSubtitles add-on: English subtitles by IMDb id and file hash, no key (src/directStream/torrent/subtitles/service.ts). */
export const DEFAULT_TORRENT_SUBTITLE_URL = 'https://opensubtitles-v3.strem.io'
```
In phase 1's `interface TorrentConfig`, after its last field:
```ts
  /**
   * `NOTESD_TORRENT_SUBTITLE_URL`, default https://opensubtitles-v3.strem.io: the subtitle service a
   * torrent without an English subtitle file asks, by the file's OpenSubtitles hash and then by the
   * IMDb id (Stremio's OpenSubtitles add-on; no key). `off`: null, and that tier is not in the chain.
   */
  subtitleUrl: string | null
```
In `DEFAULT_TORRENT_CONFIG`:
```ts
  subtitleUrl: null,
```
In `parseTorrent`'s returned object:
```ts
    subtitleUrl: parseUrlOrOff('NOTESD_TORRENT_SUBTITLE_URL', env.NOTESD_TORRENT_SUBTITLE_URL, DEFAULT_TORRENT_SUBTITLE_URL),
```
`parseDirectStream` line `:696` becomes:
```ts
    animeMapUrl: parseUrlOrOff('NOTESD_ANIME_MAP_URL', env.NOTESD_ANIME_MAP_URL, DEFAULT_ANIME_MAP_URL),
```
Replacing `parseAnimeMapUrl`:
```ts
/** An address setting: unset or blank is `fallback`, `off` is null, anything else must be an http(s) address (trailing slashes dropped). */
function parseUrlOrOff(name: string, raw: string | undefined, fallback: string): string | null {
  const value = (raw ?? '').trim()
  if (value === '') return fallback
  if (value.toLowerCase() === 'off') return null
  if (!/^https?:\/\/[^\s]+$/.test(value)) throw new ConfigError(`${name} must be an http(s) address or off (got ${value})`)
  return value.replace(/\/+$/, '')
}
```
**Impact:**
- Phase 1's config test compares the whole torrent config with `toEqual`. Add `subtitleUrl: 'https://opensubtitles-v3.strem.io'` to its expected object (Step 11).
- The anime test (`tests/unit/config.test.ts:460-462`) still passes: same values, and the message still names the variable.

### Step 3: `disk.ts`: the subtitle shelf and the `kept` tier

**File:** `src/directStream/torrent/subtitles/disk.ts` (new)
**Code:**
```ts
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CacheSubtitleView } from '../../cachePlay.js';
import { DIALOGUE_MIN_CUES, parseCues } from '../../dialogue.js';
import { srtToVtt } from '../../rewrite.js';
import type { SubtitleTier } from './chain.js';

/**
 * Where a torrent's subtitles are kept (TORRENT_STREAM_SOURCE phase 6): one folder per info hash,
 * `<torrent folder>/<info hash>/.notesd-subs/`, beside the torrent's own files, so clearing the
 * download clears them and a replay from disk finds them. Every file there is WebVTT, written by a
 * tier and served by GET /api/stream/torrent/:hash/sub/:name. `chosen.json` names the track the
 * last play chose, so the next play of the same torrent answers it without asking anything.
 */

export const SUBTITLE_DIR_NAME = '.notesd-subs';
/** A file the route serves: lower-case letters, digits and dashes, then `.vtt`. No other name is ever opened. */
export const SUBTITLE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}\.vtt$/;
/** A BitTorrent v1 info hash as the engine names torrents: 40 lower-case hex characters. */
export const INFO_HASH_PATTERN = /^[0-9a-f]{40}$/;
const CHOSEN_FILE = 'chosen.json';

/** One line of chosen.json. */
export interface KeptSubtitle {
  name: string;
  lang: string | null;
  label: string;
}

/** The route's address of one subtitle file, relative to the daemon's origin. */
export function subtitleUrl(infoHash: string, name: string): string {
  return `/api/stream/torrent/${infoHash}/sub/${name}`;
}

/** True when `file` is a regular file on disk. */
export async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** WebVTT from a subtitle's text (SubRip converted, WebVTT kept), or null when it holds no cue. */
export function vttFromText(text: string): string | null {
  const vtt = srtToVtt(text);
  return parseCues(vtt).length >= DIALOGUE_MIN_CUES ? vtt : null;
}

/** WebVTT from a subtitle file's bytes: UTF-8 when they are valid UTF-8, else Windows-1252 (old SubRip files). */
export function vttFromBytes(body: Buffer): string | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    text = new TextDecoder('windows-1252').decode(body);
  }
  return vttFromText(text);
}

function isKept(value: unknown): value is KeptSubtitle {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === 'string' && SUBTITLE_NAME_PATTERN.test(v.name) && (v.lang === null || typeof v.lang === 'string') && typeof v.label === 'string';
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, text, 'utf8');
  await rename(temp, file);
}

export class SubtitleShelf {
  constructor(private readonly torrentDir: string) {}

  /** The folder of one torrent's subtitles. Throws RangeError for anything that is not an info hash. */
  dir(infoHash: string): string {
    if (!INFO_HASH_PATTERN.test(infoHash)) throw new RangeError(`not an info hash: ${infoHash}`);
    return path.join(this.torrentDir, infoHash, SUBTITLE_DIR_NAME);
  }

  /** The absolute path of one subtitle file, or null for a hash or a name the route never serves. Does not look at the disk. */
  file(infoHash: string, name: string): string | null {
    if (!INFO_HASH_PATTERN.test(infoHash) || !SUBTITLE_NAME_PATTERN.test(name)) return null;
    return path.join(this.dir(infoHash), name);
  }

  /**
   * Writes one WebVTT file and makes it the torrent's chosen track (chosen.json), each through a
   * temporary file and a rename, so no reader sees half a file. Answers the session's view of it.
   */
  async save(infoHash: string, name: string, vtt: string, meta: { lang: string | null; label: string }): Promise<CacheSubtitleView> {
    const target = this.file(infoHash, name);
    if (target === null) throw new RangeError(`not a subtitle file name: ${name}`);
    const dir = this.dir(infoHash);
    await mkdir(dir, { recursive: true });
    await writeAtomic(target, vtt);
    const kept: KeptSubtitle[] = [{ name, lang: meta.lang, label: meta.label }];
    await writeAtomic(path.join(dir, CHOSEN_FILE), `${JSON.stringify(kept)}\n`);
    return { url: subtitleUrl(infoHash, name), lang: meta.lang, label: meta.label };
  }

  /** The tracks the last play of this torrent chose whose files are still on disk; [] when there are none. */
  async kept(infoHash: string): Promise<CacheSubtitleView[]> {
    if (!INFO_HASH_PATTERN.test(infoHash)) return [];
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path.join(this.dir(infoHash), CHOSEN_FILE), 'utf8'));
    } catch {
      return [];
    }
    if (!Array.isArray(raw)) return [];
    const views: CacheSubtitleView[] = [];
    for (const entry of raw) {
      if (!isKept(entry)) continue;
      const file = this.file(infoHash, entry.name);
      if (file === null || !(await isFile(file))) continue;
      views.push({ url: subtitleUrl(infoHash, entry.name), lang: entry.lang, label: entry.label });
    }
    return views;
  }
}

/** The first tier: what an earlier play of this torrent chose, from disk. A replay asks nothing. */
export function keptTier(shelf: SubtitleShelf): SubtitleTier {
  return { name: 'kept', blocks: true, find: (ctx) => shelf.kept(ctx.infoHash) };
}
```
**Impact:** new module, nothing else changes.

### Step 4: `files.ts`: subtitle files inside the torrent, and the candidates whose files hold one (R3.1, R3.2)

**File:** `src/directStream/torrent/subtitles/files.ts` (new)
**Decision on the bounded wait:** the subtitle files are selected with the video (phase 3's `use`). The tier waits up to 15 s in total for one to complete. A file that is not complete in time is left out of this play, and the next tier runs. Adding a track to a session after it answers would need the page to read its subtitles again, and `web/` is out of scope. A later play finds the file complete.
**Decision on forced files:** a `forced` English file holds only the lines in another language, so the tier never uses it. A lone unnamed file that is `forced` is not used either.
**Code:**
```ts
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import type { CacheSubtitleView } from '../../cachePlay.js';
import type { TorrentFileInfo } from '../types.js';
import type { SubtitleTier } from './chain.js';
import { vttFromBytes, vttFromText, type SubtitleShelf } from './disk.js';

/**
 * Subtitle files inside a torrent (TORRENT_STREAM_SOURCE phase 6, R3.1 and R3.2). A file's language
 * comes from its name and its folder (`Film.en.srt`, `Film.eng.srt`, `English.srt`, `2_English.srt`,
 * `Subs/<video name>/3_English.srt`, `Subs/English/1.srt`), once the words of the video's own name
 * are taken out (so "The.French.Dispatch.srt" names no language). Nothing here runs a file from
 * a torrent: SubRip and WebVTT are read as text, ASS/SSA are read by ffmpeg's ASS demuxer only.
 */

export type SubtitleLanguage = 'en' | 'other' | null;
export type SubtitleFlavor = 'plain' | 'sdh' | 'forced';

const SUBTITLE_EXT = /\.(srt|vtt|ass|ssa)$/i;
const ENGLISH_CODES = new Set(['en', 'eng']);
const OTHER_NAMES = new Set([
  'french', 'francais', 'german', 'deutsch', 'spanish', 'espanol', 'castellano', 'latino', 'italian', 'portuguese', 'brazilian',
  'russian', 'polish', 'dutch', 'swedish', 'norwegian', 'danish', 'finnish', 'czech', 'slovak', 'hungarian', 'romanian',
  'bulgarian', 'greek', 'turkish', 'arabic', 'hebrew', 'persian', 'farsi', 'hindi', 'indonesian', 'malay', 'thai',
  'vietnamese', 'chinese', 'mandarin', 'cantonese', 'japanese', 'korean', 'ukrainian', 'croatian', 'serbian', 'slovenian',
  'estonian', 'latvian', 'lithuanian', 'icelandic', 'catalan', 'basque', 'galician', 'tagalog', 'filipino', 'bengali',
  'tamil', 'telugu', 'urdu',
]);
const OTHER_CODES = new Set([
  'fr', 'fre', 'fra', 'de', 'ger', 'deu', 'es', 'spa', 'it', 'ita', 'pt', 'por', 'pob', 'ru', 'rus', 'pl', 'pol', 'nl', 'dut',
  'nld', 'sv', 'swe', 'no', 'nor', 'nob', 'da', 'dan', 'fi', 'fin', 'cs', 'cze', 'ces', 'sk', 'slo', 'hu', 'hun', 'ro', 'rum',
  'ron', 'bg', 'bul', 'el', 'gre', 'ell', 'tr', 'tur', 'ar', 'ara', 'he', 'heb', 'fa', 'per', 'fas', 'hin', 'id', 'ind', 'ms',
  'may', 'msa', 'th', 'tha', 'vi', 'vie', 'zh', 'chi', 'zho', 'chs', 'cht', 'ja', 'jpn', 'ko', 'kor', 'uk', 'ukr', 'hr', 'hrv',
  'sr', 'srp', 'sl', 'slv', 'et', 'est', 'lv', 'lav', 'lt', 'lit', 'is', 'ice', 'isl', 'ca', 'cat',
]);
/** Words after the language that say what kind of track it is, never which language. */
const TAIL_WORDS = new Set(['sdh', 'hi', 'cc', 'forced', 'foreign', 'full', 'default', 'hearing', 'impaired']);

function tokensOf(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t !== '');
}

function baseOf(filePath: string): { base: string; folders: string[] } {
  const parts = filePath.split(/[\\/]/).filter((p) => p !== '');
  const last = parts.pop() ?? '';
  return { base: last.replace(SUBTITLE_EXT, ''), folders: parts.map((p) => p.toLowerCase().trim()) };
}

/**
 * The language a subtitle file's name gives: `en`, `other` (it names another language), or null
 * (it names none). `titleName` is the video's file name or the release name: its words are not
 * read as a language.
 */
export function subtitleLanguage(filePath: string, titleName = ''): SubtitleLanguage {
  const { base, folders } = baseOf(filePath);
  const title = new Set(tokensOf(titleName.replace(/\.[a-z0-9]{2,4}$/i, '')));
  const tokens = tokensOf(base).filter((t) => !title.has(t) || ENGLISH_CODES.has(t) || t === 'english');
  const core = [...tokens];
  while (core.length > 0 && (TAIL_WORDS.has(core[core.length - 1]!) || /^\d+$/.test(core[core.length - 1]!))) core.pop();
  const last = core.length === 0 ? null : core[core.length - 1]!;
  const near = folders.slice(-2);
  if (tokens.includes('english') || (last !== null && ENGLISH_CODES.has(last)) || near.some((f) => f === 'english' || ENGLISH_CODES.has(f))) return 'en';
  if (tokens.some((t) => OTHER_NAMES.has(t)) || (last !== null && OTHER_CODES.has(last)) || near.some((f) => OTHER_NAMES.has(f) || OTHER_CODES.has(f))) return 'other';
  return null;
}

/** `forced` (only the lines in another language), `sdh` (with sounds and speakers) or `plain`. */
export function subtitleFlavor(filePath: string): SubtitleFlavor {
  const tokens = tokensOf(baseOf(filePath).base);
  if (tokens.includes('forced') || tokens.includes('foreign')) return 'forced';
  if (tokens.includes('sdh') || tokens.includes('cc') || tokens.includes('hi') || (tokens.includes('hearing') && tokens.includes('impaired'))) return 'sdh';
  return 'plain';
}

/** One subtitle file worth showing, with the language and label the session gives it. */
export interface SubtitleFilePick {
  file: TorrentFileInfo;
  /** `en`, or null for the torrent's one subtitle file that names no language. */
  lang: 'en' | null;
  /** `English`, `English SDH`, or '' (the page shows a lone unnamed track by default). */
  label: string;
}

const FLAVOR_ORDER: Readonly<Record<SubtitleFlavor, number>> = { plain: 0, sdh: 1, forced: 2 };

function formatRank(name: string): number {
  if (/\.srt$/i.test(name)) return 0;
  if (/\.vtt$/i.test(name)) return 1;
  return 2;
}

/**
 * The torrent's subtitle files worth showing, best first. English files (never a forced one) come
 * first: plain before SDH, SubRip before WebVTT before ASS/SSA, then the larger. With no English
 * file, the torrent's one subtitle file when it names no language. Otherwise [].
 * `subtitleIndexes` is pickFile's `subtitles`.
 */
export function rankSubtitleFiles(files: readonly TorrentFileInfo[], subtitleIndexes: readonly number[], videoName: string): SubtitleFilePick[] {
  const wanted = new Set(subtitleIndexes);
  const subs = files.filter((f) => wanted.has(f.index) && SUBTITLE_EXT.test(f.name));
  const english = subs.filter((f) => subtitleLanguage(f.path, videoName) === 'en' && subtitleFlavor(f.path) !== 'forced');
  if (english.length > 0) {
    return english
      .map((file) => ({ file, flavor: subtitleFlavor(file.path), format: formatRank(file.name) }))
      .sort((a, b) => FLAVOR_ORDER[a.flavor] - FLAVOR_ORDER[b.flavor] || a.format - b.format || b.file.length - a.file.length)
      .map(({ file, flavor }) => ({ file, lang: 'en' as const, label: flavor === 'sdh' ? 'English SDH' : 'English' }));
  }
  const [only] = subs;
  if (subs.length === 1 && only !== undefined && subtitleLanguage(only.path, videoName) === null && subtitleFlavor(only.path) !== 'forced') {
    return [{ file: only, lang: null, label: '' }];
  }
  return [];
}

/** True when the torrent's subtitle files hold an English one (R3.2). A lone unnamed file does not count. */
export function hasEnglishSubtitleFile(files: readonly TorrentFileInfo[], subtitleIndexes: readonly number[], videoName: string): boolean {
  return rankSubtitleFiles(files, subtitleIndexes, videoName).some((pick) => pick.lang === 'en');
}

/** How many of the best candidates have their file lists read before the first is opened (R3.2). */
export const FILE_LIST_CANDIDATES = 3;
/** A candidate whose file list has not arrived by then keeps its place. */
export const FILE_LIST_TIMEOUT_MS = 15_000;

/** One candidate's files as pickFile read them. */
export interface CandidateFileList {
  files: readonly TorrentFileInfo[];
  video: number;
  subtitles: readonly number[];
}

export interface FileListDeps<C> {
  /** Opens the candidate's torrent (metadata only, nothing selected) and answers pickFile's reading, or null. */
  listFiles: (candidate: C) => Promise<CandidateFileList | null>;
  /** Leaves a torrent opened here that will not be tried first. */
  release: (infoHash: string) => void | Promise<void>;
  log?: (line: string) => void;
  count?: number;
}

/**
 * R3.2: the ranked candidates with the first of the best `count` whose files hold an English
 * subtitle file moved to the front. The file lists are read in parallel; a candidate whose list
 * does not come keeps its place. Every torrent opened here except the one tried first is released.
 * With fewer than two candidates nothing is opened.
 */
export async function orderByFileLists<C extends { infoHash: string; name: string }>(candidates: readonly C[], deps: FileListDeps<C>): Promise<C[]> {
  const count = deps.count ?? FILE_LIST_CANDIDATES;
  const top = candidates.slice(0, count);
  if (top.length < 2) return [...candidates];
  const lists = await Promise.all(top.map((c) => deps.listFiles(c).catch(() => null)));
  const english = top.findIndex((_, i) => {
    const list = lists[i] ?? null;
    if (list === null) return false;
    const videoName = list.files.find((f) => f.index === list.video)?.name ?? '';
    return hasEnglishSubtitleFile(list.files, list.subtitles, videoName);
  });
  const first = english === -1 ? 0 : english;
  for (const [i, c] of top.entries()) {
    if (i === first) continue;
    try {
      await deps.release(c.infoHash);
    } catch {
      // A torrent that cannot be released is left to the engine's own clearing.
    }
  }
  if (first === 0) return [...candidates];
  const chosen = top[first]!;
  deps.log?.(`[notesd] direct stream: ${chosen.name} is tried first: its files hold an English subtitle`);
  return [chosen, ...candidates.filter((c) => c !== chosen)];
}

/** Phase 1's TorrentStreams as this phase reads it: a file's absolute path once it is complete, else null. */
export interface TorrentFilePaths {
  filePath(infoHash: string, index: number): string | null | Promise<string | null>;
}

/** An ASS/SSA file on disk to WebVTT text, or null when it cannot be converted. */
export type AssConverter = (file: string) => Promise<string | null>;

const ASS_TIMEOUT_MS = 20_000;

/** ffmpeg reading the file with its ASS demuxer only (no other format, no protocol but `file`), writing WebVTT to stdout. */
export function ffmpegAssConverter(ffmpegBin = 'ffmpeg'): AssConverter {
  return (file) =>
    new Promise((resolve) => {
      execFile(
        ffmpegBin,
        ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file', '-f', 'ass', '-i', file, '-f', 'webvtt', 'pipe:1'],
        { timeout: ASS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
        (err, stdout) => resolve(err ? null : stdout),
      );
    });
}

/** The tier waits this long in total for the subtitle files it wants to complete. */
export const SUBTITLE_FILE_WAIT_MS = 15_000;
const SUBTITLE_FILE_POLL_MS = 250;
/** A subtitle file larger than this is not a subtitle. */
export const SUBTITLE_FILE_MAX_BYTES = 5 * 1024 * 1024;

export interface FilesTierDeps {
  torrents: TorrentFilePaths;
  shelf: SubtitleShelf;
  convertAss: AssConverter;
  waitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * The second tier (R3.1): the best subtitle file inside the torrent, waited for (bounded) and
 * converted to WebVTT, kept as `file-<index>.vtt`. A file that does not complete in time, or that
 * holds no cue, is passed over; [] sends the chain to the next tier.
 */
export function filesTier(deps: FilesTierDeps): SubtitleTier {
  const waitMs = deps.waitMs ?? SUBTITLE_FILE_WAIT_MS;
  const pollMs = deps.pollMs ?? SUBTITLE_FILE_POLL_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());

  const waitFor = async (infoHash: string, index: number, deadline: number): Promise<string | null> => {
    for (;;) {
      const file = await deps.torrents.filePath(infoHash, index);
      if (file !== null) return file;
      if (now() >= deadline) return null;
      await sleep(pollMs);
    }
  };

  const readVtt = async (file: string, name: string): Promise<string | null> => {
    if ((await stat(file)).size > SUBTITLE_FILE_MAX_BYTES) return null;
    if (/\.(ass|ssa)$/i.test(name)) {
      const converted = await deps.convertAss(file);
      return converted === null ? null : vttFromText(converted);
    }
    return vttFromBytes(await readFile(file));
  };

  return {
    name: 'files',
    blocks: true,
    async find(ctx): Promise<CacheSubtitleView[]> {
      const videoName = ctx.files.find((f) => f.index === ctx.fileIndex)?.name ?? '';
      const picks = rankSubtitleFiles(ctx.files, ctx.subtitleIndexes, videoName);
      if (picks.length === 0) return [];
      const deadline = now() + waitMs;
      for (const pick of picks) {
        const file = await waitFor(ctx.infoHash, pick.file.index, deadline);
        if (file === null) continue;
        const vtt = await readVtt(file, pick.file.name).catch(() => null);
        if (vtt === null) continue;
        return [await deps.shelf.save(ctx.infoHash, `file-${pick.file.index}.vtt`, vtt, { lang: pick.lang, label: pick.label })];
      }
      return [];
    },
  };
}
```
**Impact:** new module.

### Step 5: `chain.ts`: this phase's tiers in phase 3's tier list

**File:** `src/directStream/torrent/subtitles/chain.ts` (phase 3's file)
**Change (reconciled):** phase 3 owns `SubtitleContext` (one name per fact: `fileIndex`, not `videoIndex`),
`SubtitleTier` (`name`, `blocks`, `skip?`, `find`), `runSubtitleChain` (it stops at the first **non-empty** answer,
records one `Subtitles: <tier>` attempt per tier, and gives the blocking tiers one shared 40 s budget,
`ctx.deadline`) and `buildSubtitleTiers(deps)` with a marked place per phase. This phase does not change them: it adds
its fields to `SubtitleTierDeps` and its four tiers at phase 3's two `// Phase 6` comments. Every tier of this phase
is `blocks: true` and answers only an English track or the torrent's one unnamed subtitle file.

**Code** (the imports, the `SubtitleTierDeps` fields, and `buildSubtitleTiers`' list as it stands after this phase):
```ts
import type { FetchLike } from '../../passThrough.js';
import { borrowTier, type SubtitleLender } from './borrow.js';
import { SubtitleShelf, keptTier } from './disk.js';
import { ffmpegAssConverter, filesTier, type AssConverter } from './files.js';
import { serviceTier } from './service.js';
```
```ts
export interface SubtitleTierDeps {
  torrentDir: string;
  torrents: TorrentStreams;
  log: (line: string) => void;
  /** config.torrent.subtitleUrl; null leaves the subtitle service out of the chain (phase 6). */
  subtitleUrl: string | null;
  fetch: FetchLike;
  /** DirectStreamService.subtitleText, read at play time; null without direct streaming (phase 6). */
  lend: () => SubtitleLender | null;
  /** ASS/SSA to WebVTT (phase 6); src/daemon.ts passes ffmpegAssConverter(config.torrent.ffmpegBin). */
  convertAss?: AssConverter;
  // Phase 7: embedded. Phase 8: whisper.
}
```
```ts
export function buildSubtitleTiers(deps: SubtitleTierDeps): SubtitleTier[] {
  const shelf = new SubtitleShelf(deps.torrentDir);
  return [
    // Phase 6: kept, files.
    keptTier(shelf),
    filesTier({ torrents: deps.torrents, shelf, convertAss: deps.convertAss ?? ffmpegAssConverter() }),
    // Phase 7: embedded.
    // Phase 6: service, borrow.
    ...(deps.subtitleUrl === null ? [] : [serviceTier({ baseUrl: deps.subtitleUrl, fetch: deps.fetch, torrents: deps.torrents, shelf })]),
    borrowTier({ lend: deps.lend, shelf }),
    // Phase 8: whisper.
  ];
}
```
**Impact:** phase 3's runner and context are untouched; `TorrentSource` already appends the chain's attempts to the
play's and runs the chain on a replay from disk (`handle: null`, `files: []`, `subtitleIndexes: []`, the recorded
`release`).

### Step 6: `service.ts`: the subtitle service (R3.3, first half)

**File:** `src/directStream/torrent/subtitles/service.ts` (new)
**Code:**
```ts
import { open, stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import type { CacheSubtitleView } from '../../cachePlay.js';
import { readBody } from '../../cache/upstream.js';
import type { FetchLike } from '../../passThrough.js';
import type { StreamRef } from '../../types.js';
import type { SubtitleContext, SubtitleTier } from './chain.js';
import { vttFromBytes, type SubtitleShelf } from './disk.js';
import { subtitleLanguage, type TorrentFilePaths } from './files.js';

/**
 * Stremio's OpenSubtitles add-on (NOTESD_TORRENT_SUBTITLE_URL, default
 * https://opensubtitles-v3.strem.io; no key) as the third tier (TORRENT_STREAM_SOURCE phase 6,
 * R3.3). `GET /subtitles/movie/tt<id>.json` and `/subtitles/series/tt<id>:<s>:<e>.json` answer
 * `{subtitles: [{id, url, lang, subtitleFileName?, movieReleaseName?, m?}]}` with direct .srt
 * addresses; `/subtitles/<type>/<id>/videoHash=<hash>&videoSize=<bytes>.json` adds the entries
 * matched to the file's OpenSubtitles hash (`m: "h"`). Every request is a plain one that says it is
 * notesd.
 */

export const SUBTITLE_SERVICE_USER_AGENT = 'notesd-direct-stream (plain request; torrent subtitles)';
const LIST_TIMEOUT_MS = 15_000;
const FILE_TIMEOUT_MS = 20_000;
const LIST_MAX_BYTES = 4 * 1024 * 1024;
const FILE_MAX_BYTES = 5 * 1024 * 1024;
/** At most this many of the chosen entries are downloaded before the tier gives up. */
const FILE_TRIES = 3;
/** OpenSubtitles hashes the first and the last 64 KiB. */
export const HASH_CHUNK_BYTES = 64 * 1024;
/** Reading those two pieces of a downloading file may take this long; then the service is asked by id alone. */
export const HASH_TIMEOUT_MS = 10_000;
const IMDB_ID = /^tt\d{5,10}$/;

/** One English entry of the service's answer. */
export interface ServiceSubtitle {
  id: string;
  url: string;
  fileName: string | null;
  releaseName: string | null;
  /** The service matched it to the file's hash (`m: "h"`). */
  hashMatched: boolean;
}

export interface VideoHash {
  hash: string;
  size: number;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The service's answer, read once where it enters: English entries with an http(s) address and a plain id; anything else is dropped. */
export function parseServiceAnswer(body: unknown): ServiceSubtitle[] {
  if (typeof body !== 'object' || body === null) return [];
  const list = (body as { subtitles?: unknown }).subtitles;
  if (!Array.isArray(list)) return [];
  const out: ServiceSubtitle[] = [];
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue;
    const e = raw as Record<string, unknown>;
    const lang = typeof e.lang === 'string' ? e.lang.trim().toLowerCase() : '';
    if (lang !== 'eng' && lang !== 'en' && !lang.startsWith('en-')) continue;
    const url = typeof e.url === 'string' ? e.url.trim() : '';
    if (!/^https?:\/\/\S+$/i.test(url)) continue;
    const id = typeof e.id === 'string' || typeof e.id === 'number' ? String(e.id) : '';
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) continue;
    out.push({ id, url, fileName: str(e.subtitleFileName), releaseName: str(e.movieReleaseName), hashMatched: e.m === 'h' });
  }
  return out;
}

/** The service's list address for a film or an episode, by hash and size when given. */
export function serviceListUrl(base: string, ref: StreamRef, imdbId: string, hash: VideoHash | null): string {
  const type = ref.kind === 'movie' ? 'movie' : 'series';
  const id = ref.kind === 'movie' ? imdbId : `${imdbId}:${ref.season}:${ref.episode}`;
  const extra = hash === null ? '' : `/videoHash=${hash.hash}&videoSize=${hash.size}`;
  return `${base}/subtitles/${type}/${id}${extra}.json`;
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
}

/**
 * The English entries in the order they are tried: those matched to the file's hash first; then
 * any whose file name does not name another language; then those whose file or release name
 * shares the most words with the torrent's release name; then the service's own order.
 */
export function chooseServiceSubtitles(list: readonly ServiceSubtitle[], release: string): ServiceSubtitle[] {
  const wanted = new Set(words(release));
  return list
    .map((s, order) => ({
      s,
      order,
      shared: new Set(words(`${s.fileName ?? ''} ${s.releaseName ?? ''}`).filter((w) => wanted.has(w))).size,
      otherLanguage: s.fileName !== null && subtitleLanguage(s.fileName, release) === 'other',
    }))
    .sort((a, b) => Number(b.s.hashMatched) - Number(a.s.hashMatched) || Number(a.otherLanguage) - Number(b.otherLanguage) || b.shared - a.shared || a.order - b.order)
    .map((x) => x.s);
}

/**
 * The OpenSubtitles hash: the file size plus every 64-bit little-endian word of its first and
 * last 64 KiB, modulo 2^64, as 16 hex digits. Null for a file shorter than 64 KiB or a short read.
 * `readRange` takes an inclusive byte span.
 */
export async function openSubtitlesHash(size: number, readRange: (start: number, end: number) => Promise<Buffer>): Promise<string | null> {
  if (!Number.isSafeInteger(size) || size < HASH_CHUNK_BYTES) return null;
  const head = await readRange(0, HASH_CHUNK_BYTES - 1);
  const tail = await readRange(size - HASH_CHUNK_BYTES, size - 1);
  if (head.length < HASH_CHUNK_BYTES || tail.length < HASH_CHUNK_BYTES) return null;
  const mask = (1n << 64n) - 1n;
  let sum = BigInt(size);
  for (const chunk of [head, tail]) {
    for (let i = 0; i < HASH_CHUNK_BYTES; i += 8) sum = (sum + chunk.readBigUInt64LE(i)) & mask;
  }
  return sum.toString(16).padStart(16, '0');
}

async function collect(stream: Readable, signal: AbortSignal): Promise<Buffer> {
  const stop = (): void => {
    stream.destroy(new Error('the hash read timed out'));
  };
  if (signal.aborted) stop();
  else signal.addEventListener('abort', stop, { once: true });
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

async function readFileRange(file: string, start: number, end: number): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const buf = Buffer.alloc(end - start + 1);
    const { bytesRead } = await handle.read(buf, 0, buf.length, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * The chosen video's hash: from disk when the file is complete, else through the open torrent
 * (which fetches those pieces first). Null when neither can be read within `timeoutMs`.
 */
async function videoHash(ctx: SubtitleContext, torrents: TorrentFilePaths, timeoutMs: number): Promise<VideoHash | null> {
  const signal = AbortSignal.timeout(timeoutMs);
  const onDisk = await torrents.filePath(ctx.infoHash, ctx.fileIndex);
  let size = ctx.files.find((f) => f.index === ctx.fileIndex)?.length ?? null;
  let read: ((start: number, end: number) => Promise<Buffer>) | null = null;
  if (onDisk !== null) {
    size = (await stat(onDisk)).size;
    read = (start, end) => readFileRange(onDisk, start, end);
  } else if (ctx.handle !== null) {
    const handle = ctx.handle;
    read = (start, end) => collect(handle.read(ctx.fileIndex, { start, end }), signal);
  }
  if (size === null || read === null) return null;
  try {
    const hash = await openSubtitlesHash(size, read);
    return hash === null ? null : { hash, size };
  } catch {
    return null;
  }
}

const HEADERS = { accept: 'application/json', 'user-agent': SUBTITLE_SERVICE_USER_AGENT } as const;

async function getList(fetchImpl: FetchLike, url: string): Promise<ServiceSubtitle[]> {
  const res = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`HTTP ${res.status}`);
  }
  const body = await readBody(res, LIST_MAX_BYTES, false);
  if (body === null) throw new Error(`the answer is larger than ${LIST_MAX_BYTES} bytes`);
  return parseServiceAnswer(JSON.parse(body.toString('utf8')));
}

async function getFile(fetchImpl: FetchLike, url: string): Promise<string | null> {
  const res = await fetchImpl(url, { headers: { ...HEADERS, accept: '*/*' }, signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  const body = await readBody(res, FILE_MAX_BYTES, false);
  return body === null ? null : vttFromBytes(body);
}

export interface ServiceTierDeps {
  baseUrl: string;
  fetch: FetchLike;
  torrents: TorrentFilePaths;
  shelf: SubtitleShelf;
  hashTimeoutMs?: number;
}

/**
 * The third tier (R3.3): asks the service by the file's hash first, then by the IMDb id alone
 * (when the hash request failed or listed no English subtitle), downloads the best of the English
 * entries (up to three tries) and keeps it as `service-<id>.vtt`. Answers [] when the service
 * lists nothing English or no file could be read; throws when the service did not answer at all.
 * Without an IMDb id it asks nothing.
 */
export function serviceTier(deps: ServiceTierDeps): SubtitleTier {
  return {
    name: 'service',
    blocks: true,
    async find(ctx): Promise<CacheSubtitleView[]> {
      if (ctx.imdbId === null || !IMDB_ID.test(ctx.imdbId)) return [];
      const imdbId = ctx.imdbId;
      const hash = await videoHash(ctx, deps.torrents, deps.hashTimeoutMs ?? HASH_TIMEOUT_MS).catch(() => null);
      const failures: string[] = [];
      let list: ServiceSubtitle[] = [];
      let answered = false;
      for (const by of hash === null ? [null] : [hash, null]) {
        try {
          list = await getList(deps.fetch, serviceListUrl(deps.baseUrl, ctx.ref, imdbId, by));
          answered = true;
          if (list.length > 0) break;
        } catch (err) {
          failures.push(`${by === null ? 'by IMDb id' : 'by hash'}: ${messageOf(err)}`);
        }
      }
      if (!answered) throw new Error(`the subtitle service did not answer (${failures.join('; ')})`);
      for (const entry of chooseServiceSubtitles(list, ctx.release).slice(0, FILE_TRIES)) {
        const vtt = await getFile(deps.fetch, entry.url).catch(() => null);
        if (vtt === null) continue;
        const name = `service-${entry.id.toLowerCase().replace(/[^a-z0-9-]/g, '-')}.vtt`;
        return [await deps.shelf.save(ctx.infoHash, name, vtt, { lang: 'en', label: entry.hashMatched ? 'English' : 'English (matched by title)' })];
      }
      return [];
    },
  };
}
```
**Impact:** new module. The real service is reached only from a daemon with torrents on. Tests inject `fetch`.

### Step 7: `borrow.ts`: a cloud provider's English subtitle (R3.3, second half)

**File:** `src/directStream/torrent/subtitles/borrow.ts` (new)
**Decision:**
- After a cloud `no_source` (`ctx.cloudTried`), every provider has just failed, so the tier asks nothing.
- Otherwise it calls `DirectStreamService.subtitleText`, the existing resolve that only reads a subtitle (the dialogue tool's path). It opens tabs in the streaming Chrome out of sight and never the player.
- The resolver's own deadline is 45 s, and the whole tier gets 40 s more to read the file, both capped by the chain's
  shared 40 s budget (`ctx.deadline`), so in a play the borrow gets what the earlier tiers left of it.
- With the Whisper tier on (phase 8 sets `whisperCovers`) and an English original language, the tier is skipped.
- A failure throws. The chain records it and the play goes on without a subtitle.

**Code:**
```ts
import type { CacheSubtitleView } from '../../cachePlay.js';
import { joinVtt } from '../../cache/subtitle.js';
import type { StreamRef } from '../../types.js';
import type { SubtitleTier } from './chain.js';
import { vttFromText, type SubtitleShelf } from './disk.js';

/**
 * The last file tier (TORRENT_STREAM_SOURCE phase 6, R3.3): a cloud provider's English subtitle for
 * the same title, read out of sight through DirectStreamService.subtitleText. It may be out of step
 * with the torrent's cut; the player's G and H keys move it. Kept as `borrow.vtt`, labelled with
 * the provider it came from.
 */

/** The resolver's `--deadline-s` for a borrow. */
export const BORROW_DEADLINE_S = 45;
/** Time to read the subtitle file after the resolver's deadline. */
export const BORROW_GRACE_MS = 40_000;

export interface BorrowedSubtitle {
  provider: string;
  label: string;
  vtt: string;
}

/** DirectStreamService.subtitleText as the tier calls it. Throws `no_source`, `resolve_failed`, `no_subtitle`. */
export type SubtitleLender = (ref: StreamRef, options: { deadlineS: number }) => Promise<BorrowedSubtitle>;

export interface BorrowTierDeps {
  /** Read at play time: the service is built after the tiers. Null: no direct streaming. */
  lend: () => SubtitleLender | null;
  shelf: SubtitleShelf;
  deadlineS?: number;
  graceMs?: number;
  /**
   * Phase 8 sets it when the Whisper tier is on: then a title whose original language is English skips the borrow
   * (Whisper measured 5 minutes of audio in 2.5 s, and a borrowed file may be out of step with the torrent's cut).
   */
  whisperCovers?: boolean;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no subtitle within ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export function borrowTier(deps: BorrowTierDeps): SubtitleTier {
  return {
    name: 'borrow',
    blocks: true,
    skip: (ctx) =>
      deps.whisperCovers === true && ctx.audioLang === 'en' ? 'Whisper transcribes English audio, and a borrowed subtitle may be out of step with the torrent' : null,
    async find(ctx): Promise<CacheSubtitleView[]> {
      if (ctx.cloudTried) return [];
      const lend = deps.lend();
      if (lend === null) return [];
      // Within the chain's shared budget (ctx.deadline): the resolver's deadline and the read after it both fit in it.
      const leftMs = Math.max(0, ctx.deadline - Date.now());
      const deadlineS = Math.max(1, Math.min(deps.deadlineS ?? BORROW_DEADLINE_S, Math.floor(leftMs / 1000) - 5));
      const got = await withTimeout(lend(ctx.ref, { deadlineS }), Math.min(deadlineS * 1000 + (deps.graceMs ?? BORROW_GRACE_MS), leftMs));
      // An HLS subtitle track arrives as its segments joined, each with its own WEBVTT header: one header is kept.
      const vtt = vttFromText(joinVtt(got.vtt.split(/\n+(?=WEBVTT)/)));
      if (vtt === null) throw new Error(`${got.provider}'s English subtitle holds no cue`);
      return [await deps.shelf.save(ctx.infoHash, 'borrow.vtt', vtt, { lang: 'en', label: `English (${got.provider})` })];
    },
  };
}
```
**Impact:** new module.

### Step 8: R3.2 in `TorrentSource`

**File:** `src/directStream/torrent/source.ts` (phase 3's file)
**Change:** one insertion, at phase 3's marked line in `resolve` (`// Phase 6 (R3.2): \`candidates\` is reordered
here ...`), after the `skip` filter and before `tryCandidates`. Phase 3 already takes the tiers from its options,
builds the `SubtitleContext`, runs the chain on a replay from disk and passes `cloudTried`; nothing else changes. Phase
3's local names are `ref`, `query`, `candidates` (a `const`; make it `let`), `this.opts.swarm` and `this.log`.

**Code:**
```ts
import { FILE_LIST_TIMEOUT_MS, orderByFileLists } from './subtitles/files.js';
```
```ts
    // R3.2: of the best three, the one whose files hold an English subtitle file is tried first.
    candidates = await orderByFileLists(candidates, {
      listFiles: async (candidate) => {
        const handle = await this.opts.swarm.open(
          { infoHash: candidate.infoHash, trackers: candidate.trackers, name: candidate.name, ref, release: candidate.release },
          { timeoutMs: FILE_LIST_TIMEOUT_MS },
        );
        const picked = pickFile(handle.files, query);
        return picked === null ? null : { files: handle.files, video: picked.video, subtitles: picked.subtitles };
      },
      release: (infoHash) => this.opts.swarm.release(infoHash),
      log: this.log,
    });
```
**Impact:**
- A play with two or more candidates reads up to three file lists in parallel before the first open (about 15 s at worst;
  usually seconds). This happens before the subtitle chain, so it is not counted in the chain's 40 s budget; it is
  counted in phase 3's `TORRENT_DEADLINE_MS`.
- Three swarms are joined for metadata only and the losers are released at once.

### Step 9: Wire the tiers in the daemon

**File:** `src/daemon.ts`, phase 3's `buildSubtitleTiers({ ... })` call inside `torrentSourceOf`
**Change:** at phase 3's `// Phase 6 adds ...` comment in that object, this phase's four fields. `directStream` is the
existing const (`src/daemon.ts:189`), read inside a closure at play time, as `streamEvidence`'s `source` already does.
**Code:**
```ts
import { ffmpegAssConverter } from './directStream/torrent/subtitles/files.js';
```
```ts
          subtitleUrl: config.torrent.subtitleUrl,
          fetch: (url, init) => fetch(url, init),
          // The borrow reads the title's English subtitle from a cloud provider, out of sight.
          lend: () => (directStream === null ? null : (ref, options) => directStream.subtitleText(ref, options)),
          convertAss: ffmpegAssConverter(config.torrent.ffmpegBin),
```
**Impact:** with `NOTESD_TORRENT=off`, `deps.torrents` is null and phase 3 builds nothing (invariant 2).

### Step 10: The subtitle route

**File:** `src/http/streamTorrentApi.ts` (phase 1's file), inside `streamTorrentRoutes(deps)`, after phase 1's file route
**Code:**
```ts
import { fileResponse } from '../directStream/cache/serve.js';
import { SubtitleShelf, isFile } from '../directStream/torrent/subtitles/disk.js';
```
```ts
  // Phase 6: a torrent's subtitle files (WebVTT), kept under its folder by the subtitle tiers.
  r.get('/api/stream/torrent/:hash/sub/:name', async (c) => {
    const torrents = deps.torrents ?? null;
    const dir = deps.config.torrent?.dir ?? null;
    if (torrents === null || dir === null) return c.json(TORRENT_OFF, 503);
    const hash = c.req.param('hash').toLowerCase();
    const name = c.req.param('name');
    const file = new SubtitleShelf(dir).file(hash, name);
    if (file !== null && (await isFile(file))) return fileResponse(file, name, c.req.header('range') ?? null);
    const view = file === null ? null : await torrents.view(hash);
    if (view !== null && view.available === false) {
      return c.json({ error: 'not_on_this_machine', message: `That torrent is on ${view.host}, not on this machine.`, host: view.host }, 404);
    }
    return c.json({ error: 'not_found', message: 'This machine has no subtitle file by that name for that torrent.' }, 404);
  });
```
If phase 1's `streamTorrentRoutes` takes `deps` as a narrower `Pick<AppDeps, …>`, add `'config'` to the pick.
**Impact:** `fileResponse` answers `text/vtt; charset=utf-8` with `Range` support (`src/directStream/cache/serve.ts:5-52`).

### Step 11: Tests

Every test injects its fetch, ffmpeg converter, torrent paths and clock. None touches the network or a swarm.

**File:** `tests/fixtures/torrent-subtitles/opensubs-sintel.json` (new). Cut it with:
```sh
jq '{subtitles: ([.subtitles[] | select(.lang == "eng")][:4] + [.subtitles[] | select(.lang == "fre")][:1])}' \
  .workflows/analyze/torrent-samples/opensubs-v3.json > tests/fixtures/torrent-subtitles/opensubs-sintel.json
```
It holds the four English entries, ids `3871796` (`sintel_en.srt`), `6738581` (`Sintel (2010).eng.srt`), `4784578` (`sintel.he.srt`) and `3863890` (`sintel_en.srt`, release `Sintel.2010.Xvid-VODO`), and one French entry.

**File:** `tests/unit/directStream/torrent/subtitles/disk.test.ts`
```ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SubtitleShelf, keptTier, vttFromBytes } from '../../../../../src/directStream/torrent/subtitles/disk.js';

const HASH = 'a'.repeat(40);
const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello.\n';
let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'notesd-subs-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SubtitleShelf', () => {
  it('keeps a saved track under <hash>/.notesd-subs and answers it as the chosen one', async () => {
    const shelf = new SubtitleShelf(dir);
    const view = await shelf.save(HASH, 'file-1.vtt', VTT, { lang: 'en', label: 'English' });
    expect(view).toEqual({ url: `/api/stream/torrent/${HASH}/sub/file-1.vtt`, lang: 'en', label: 'English' });
    expect(await readFile(path.join(dir, HASH, '.notesd-subs', 'file-1.vtt'), 'utf8')).toBe(VTT);
    expect(await shelf.kept(HASH)).toEqual([view]);
    expect(await keptTier(shelf).find({ infoHash: HASH } as never)).toEqual([view]);
  });

  it('answers nothing kept when the chosen file is gone or chosen.json is not ours', async () => {
    const shelf = new SubtitleShelf(dir);
    await shelf.save(HASH, 'file-1.vtt', VTT, { lang: 'en', label: 'English' });
    await rm(path.join(dir, HASH, '.notesd-subs', 'file-1.vtt'));
    expect(await shelf.kept(HASH)).toEqual([]);
    await writeFile(path.join(dir, HASH, '.notesd-subs', 'chosen.json'), '[{"name":"../../etc/passwd","lang":null,"label":""}]');
    expect(await shelf.kept(HASH)).toEqual([]);
  });

  it('never names a file outside the folder', () => {
    const shelf = new SubtitleShelf(dir);
    expect(shelf.file(HASH, '../x.vtt')).toBeNull();
    expect(shelf.file(HASH, 'chosen.json')).toBeNull();
    expect(shelf.file('../../etc', 'file-1.vtt')).toBeNull();
    expect(shelf.file(HASH, 'service-3871796.vtt')).toBe(path.join(dir, HASH, '.notesd-subs', 'service-3871796.vtt'));
  });
});

describe('vttFromBytes', () => {
  it('converts SubRip, reads Windows-1252, and refuses a file without cues', () => {
    expect(vttFromBytes(Buffer.from('1\r\n00:00:01,000 --> 00:00:02,000\r\nHi.\r\n'))).toContain('00:00:01.000 --> 00:00:02.000');
    expect(vttFromBytes(Buffer.from([0x31, 0x0a, ...Buffer.from('00:00:01,000 --> 00:00:02,000\n'), 0x43, 0x61, 0x66, 0xe9, 0x0a]))).toContain('Café');
    expect(vttFromBytes(Buffer.from('not a subtitle'))).toBeNull();
  });
});
```

**File:** `tests/unit/directStream/torrent/subtitles/files.test.ts`
```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SubtitleShelf } from '../../../../../src/directStream/torrent/subtitles/disk.js';
import { filesTier, orderByFileLists, rankSubtitleFiles, subtitleFlavor, subtitleLanguage, type CandidateFileList } from '../../../../../src/directStream/torrent/subtitles/files.js';
import type { SubtitleContext } from '../../../../../src/directStream/torrent/subtitles/chain.js';
import { REST_OF_CONTEXT } from './context.js';
import type { TorrentFileInfo } from '../../../../../src/directStream/torrent/types.js';

const VIDEO = 'Film.2010.1080p.mp4';
const file = (index: number, p: string, length = 1000): TorrentFileInfo => ({ index, path: p, name: p.split('/').pop()!, length });

describe('subtitleLanguage', () => {
  it.each([
    ['Film/Film.2010.1080p.en.srt', 'en'],
    ['Film/Film.2010.1080p.eng.srt', 'en'],
    ['Film/English.srt', 'en'],
    ['Film/Subs/2_English.srt', 'en'],
    ['Film/Subs/Film.2010.1080p/3_English.srt', 'en'],
    ['Film/Subs/English/1.srt', 'en'],
    ['Film/Film.2010.1080p.en.sdh.srt', 'en'],
    ['Film/Film.2010.1080p.fr.srt', 'other'],
    ['Film/Subs/4_French.srt', 'other'],
    ['Film/Film.2010.1080p.srt', null],
  ])('%s -> %s', (p, want) => {
    expect(subtitleLanguage(p, VIDEO)).toBe(want);
  });

  it('does not read the title as a language', () => {
    expect(subtitleLanguage('The.French.Dispatch.2021.srt', 'The.French.Dispatch.2021.mp4')).toBeNull();
    expect(subtitleLanguage('The.French.Dispatch.2021.en.srt', 'The.French.Dispatch.2021.mp4')).toBe('en');
  });

  it('reads the flavour', () => {
    expect(subtitleFlavor('Film.en.sdh.srt')).toBe('sdh');
    expect(subtitleFlavor('Film.eng.forced.srt')).toBe('forced');
    expect(subtitleFlavor('Film.en.srt')).toBe('plain');
  });
});

describe('rankSubtitleFiles (R3.1)', () => {
  it('puts plain English first, SubRip before ASS, SDH after, and never a forced file', () => {
    const files = [file(0, 'Film/Film.mp4', 9e8), file(1, 'Film/Film.en.sdh.srt', 900), file(2, 'Film/Film.en.srt', 500), file(3, 'Film/Film.fr.srt'), file(4, 'Film/Film.en.forced.srt'), file(5, 'Film/Film.en.ass')];
    const picks = rankSubtitleFiles(files, [1, 2, 3, 4, 5], 'Film.mp4');
    expect(picks.map((p) => [p.file.index, p.lang, p.label])).toEqual([
      [2, 'en', 'English'],
      [5, 'en', 'English'],
      [1, 'en', 'English SDH'],
    ]);
  });

  it('takes the one subtitle file that names no language, and nothing when there are two or it names another', () => {
    expect(rankSubtitleFiles([file(0, 'Film/Film.mp4'), file(1, 'Film/Film.srt')], [1], 'Film.mp4')).toEqual([{ file: file(1, 'Film/Film.srt'), lang: null, label: '' }]);
    expect(rankSubtitleFiles([file(0, 'Film/Film.mp4'), file(1, 'Film/Film.srt'), file(2, 'Film/Film.2.srt')], [1, 2], 'Film.mp4')).toEqual([]);
    expect(rankSubtitleFiles([file(0, 'Film/Film.mp4'), file(1, 'Film/Film.fr.srt')], [1], 'Film.mp4')).toEqual([]);
  });
});

describe('orderByFileLists (R3.2)', () => {
  const list = (subs: string[]): CandidateFileList => ({ files: [file(0, 'Film/Film.mp4'), ...subs.map((s, i) => file(i + 1, s))], video: 0, subtitles: subs.map((_, i) => i + 1) });
  const cands = [{ infoHash: 'a', name: 'A' }, { infoHash: 'b', name: 'B' }, { infoHash: 'c', name: 'C' }, { infoHash: 'd', name: 'D' }];

  it('moves the first of the best three with an English file to the front and releases the others', async () => {
    const released: string[] = [];
    const lists: Record<string, CandidateFileList | null> = { a: list([]), b: null, c: list(['Film/Film.en.srt']), d: list(['Film/Film.en.srt']) };
    const out = await orderByFileLists(cands, { listFiles: async (c) => lists[c.infoHash] ?? null, release: (h) => void released.push(h) });
    expect(out.map((c) => c.infoHash)).toEqual(['c', 'a', 'b', 'd']);
    expect(released.sort()).toEqual(['a', 'b']);
  });

  it('keeps the order when the first already has one, or none has', async () => {
    const released: string[] = [];
    const out = await orderByFileLists(cands, { listFiles: async (c) => (c.infoHash === 'a' ? list(['Film/English.srt']) : list([])), release: (h) => void released.push(h) });
    expect(out.map((c) => c.infoHash)).toEqual(['a', 'b', 'c', 'd']);
    expect(released.sort()).toEqual(['b', 'c']);
    expect((await orderByFileLists(cands, { listFiles: async () => list([]), release: () => undefined })).map((c) => c.infoHash)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('opens nothing for a single candidate', async () => {
    let opened = 0;
    await orderByFileLists([cands[0]!], { listFiles: async () => (opened++, null), release: () => undefined });
    expect(opened).toBe(0);
  });
});

describe('filesTier', () => {
  const HASH = 'b'.repeat(40);
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'notesd-files-'));
    await mkdir(path.join(dir, 'dl'), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const ctx = (files: TorrentFileInfo[], subs: number[]): SubtitleContext => ({
    ...REST_OF_CONTEXT,
    ref: { kind: 'movie', tmdbId: 1 }, imdbId: 'tt0000001', infoHash: HASH, release: 'Film.2010', files, fileIndex: 0, subtitleIndexes: subs, handle: null, cloudTried: false,
  });

  it('waits for the English file to complete, converts it and keeps it', async () => {
    const srt = path.join(dir, 'dl', 'Film.en.srt');
    await writeFile(srt, '1\r\n00:00:01,000 --> 00:00:30,000\r\nTorrent subtitle line one\r\n');
    let asks = 0;
    const tier = filesTier({
      torrents: { filePath: (_h, i) => (i === 1 && ++asks >= 3 ? srt : null) },
      shelf: new SubtitleShelf(path.join(dir, 'torrents')),
      convertAss: async () => null,
      pollMs: 1,
    });
    const found = await tier.find(ctx([file(0, 'Film/Film.mp4'), file(1, 'Film/Film.en.srt')], [1]));
    expect(found).toEqual([{ url: `/api/stream/torrent/${HASH}/sub/file-1.vtt`, lang: 'en', label: 'English' }]);
    expect(asks).toBeGreaterThanOrEqual(3);
  });

  it('reads ASS through the converter', async () => {
    const ass = path.join(dir, 'dl', 'Film.eng.ass');
    await writeFile(ass, '[Script Info]\n');
    const seen: string[] = [];
    const tier = filesTier({
      torrents: { filePath: () => ass },
      shelf: new SubtitleShelf(path.join(dir, 'torrents')),
      convertAss: async (f) => (seen.push(f), 'WEBVTT\n\n00:01.000 --> 00:02.000\nASS subtitle line\n'),
    });
    expect(await tier.find(ctx([file(0, 'Film/Film.mp4'), file(1, 'Film/Film.eng.ass')], [1]))).toHaveLength(1);
    expect(seen).toEqual([ass]);
  });

  it('gives up after the bounded wait and answers nothing', async () => {
    let clock = 0;
    const tier = filesTier({
      torrents: { filePath: () => null },
      shelf: new SubtitleShelf(path.join(dir, 'torrents')),
      convertAss: async () => null,
      waitMs: 1000,
      pollMs: 250,
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
    });
    expect(await tier.find(ctx([file(0, 'Film/Film.mp4'), file(1, 'Film/Film.en.srt')], [1]))).toEqual([]);
    expect(clock).toBe(1000);
  });
});
```

**File:** `tests/unit/directStream/torrent/subtitles/service.test.ts`
```ts
import { mkdtemp, readFile as readText, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SubtitleShelf } from '../../../../../src/directStream/torrent/subtitles/disk.js';
import { chooseServiceSubtitles, openSubtitlesHash, parseServiceAnswer, serviceListUrl, serviceTier } from '../../../../../src/directStream/torrent/subtitles/service.js';
import type { SubtitleContext } from '../../../../../src/directStream/torrent/subtitles/chain.js';
import { REST_OF_CONTEXT } from './context.js';
import type { TorrentHandle } from '../../../../../src/directStream/torrent/types.js';

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/torrent-subtitles/opensubs-sintel.json');
const HASH = 'c'.repeat(40);
const SIZE = 128 * 1024;
const SRT = (line: string): string => `1\r\n00:00:01,000 --> 00:00:30,000\r\n${line}\r\n`;

/** A file of SIZE bytes, zero but for its first word (1) and its last word (2): hash = SIZE + 3. */
function video(): Buffer {
  const b = Buffer.alloc(SIZE);
  b.writeBigUInt64LE(1n, 0);
  b.writeBigUInt64LE(2n, SIZE - 8);
  return b;
}

describe('openSubtitlesHash', () => {
  it('adds the size and the words of the first and last 64 KiB, modulo 2^64', async () => {
    const b = video();
    expect(await openSubtitlesHash(SIZE, async (s, e) => b.subarray(s, e + 1))).toBe((SIZE + 3).toString(16).padStart(16, '0'));
    const wrap = Buffer.alloc(SIZE);
    wrap.writeBigUInt64LE(0xffffffffffffffffn, 0);
    expect(await openSubtitlesHash(SIZE, async (s, e) => wrap.subarray(s, e + 1))).toBe((SIZE - 1).toString(16).padStart(16, '0'));
    expect(await openSubtitlesHash(1000, async () => Buffer.alloc(0))).toBeNull();
  });
});

describe('the service answer', () => {
  it('keeps English entries only, and orders them by hash, language in the name, then shared words', async () => {
    const list = parseServiceAnswer(JSON.parse(await readText(FIXTURE, 'utf8')));
    expect(list.map((s) => s.id)).toEqual(['3871796', '6738581', '4784578', '3863890']);
    expect(chooseServiceSubtitles(list, 'Sintel.2010.Xvid-VODO').map((s) => s.id)).toEqual(['3863890', '6738581', '3871796', '4784578']);
    expect(chooseServiceSubtitles([...list, { ...list[0]!, id: 'h1', hashMatched: true }], 'Sintel.2010.Xvid-VODO')[0]!.id).toBe('h1');
  });

  it('builds the film, episode and hash addresses', () => {
    expect(serviceListUrl('https://s.fixture', { kind: 'movie', tmdbId: 1 }, 'tt1727587', null)).toBe('https://s.fixture/subtitles/movie/tt1727587.json');
    expect(serviceListUrl('https://s.fixture', { kind: 'tv', tmdbId: 1, season: 1, episode: 2 }, 'tt0903747', { hash: '0000000000020003', size: SIZE })).toBe(
      'https://s.fixture/subtitles/series/tt0903747:1:2/videoHash=0000000000020003&videoSize=131072.json',
    );
  });
});

describe('serviceTier (R3.3)', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'notesd-service-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const handle = { read: (_i: number, r: { start: number; end: number }) => Readable.from([video().subarray(r.start, r.end + 1)]) } as unknown as TorrentHandle;
  const ctx = (over: Partial<SubtitleContext> = {}): SubtitleContext => ({
    ...REST_OF_CONTEXT,
    ref: { kind: 'movie', tmdbId: 45745 }, imdbId: 'tt1727587', infoHash: HASH, release: 'Sintel.2010.Xvid-VODO',
    files: [{ index: 0, path: 'Sintel/Sintel.mp4', name: 'Sintel.mp4', length: SIZE }], fileIndex: 0, subtitleIndexes: [], handle, cloudTried: false, ...over,
  });
  type Call = { url: string; ua: string | null };
  const fake = (answer: (url: string) => Response) => {
    const calls: Call[] = [];
    const fetch = async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, ua: new Headers(init.headers).get('user-agent') });
      return answer(url);
    };
    return { calls, fetch };
  };
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const entry = (id: string, m: string) => ({ id, url: `https://files.fixture/${id}.srt`, lang: 'eng', m, subtitleFileName: `${id}.srt` });

  it('asks by hash first, saying it is notesd, and keeps the hash-matched file', async () => {
    const { calls, fetch } = fake((url) => (url.endsWith('.srt') ? new Response(SRT(`line ${url}`)) : json({ subtitles: [entry('222', 'i'), entry('111', 'h')] })));
    const tier = serviceTier({ baseUrl: 'https://subs.fixture', fetch, torrents: { filePath: () => null }, shelf: new SubtitleShelf(dir) });
    const found = await tier.find(ctx());
    expect(calls[0]!.url).toBe('https://subs.fixture/subtitles/movie/tt1727587/videoHash=0000000000020003&videoSize=131072.json');
    expect(calls.every((c) => /notesd/.test(c.ua ?? ''))).toBe(true);
    expect(found).toEqual([{ url: `/api/stream/torrent/${HASH}/sub/service-111.vtt`, lang: 'en', label: 'English' }]);
    expect(await readText(path.join(dir, HASH, '.notesd-subs', 'service-111.vtt'), 'utf8')).toContain('00:00:01.000 --> 00:00:30.000');
  });

  it('falls back to the IMDb id when the hash request fails', async () => {
    const { calls, fetch } = fake((url) => (url.includes('videoHash') ? json({ err: 'x' }, 500) : url.endsWith('.srt') ? new Response(SRT('by id')) : json({ subtitles: [entry('222', 'i')] })));
    const tier = serviceTier({ baseUrl: 'https://subs.fixture', fetch, torrents: { filePath: () => null }, shelf: new SubtitleShelf(dir) });
    expect(await tier.find(ctx({ ref: { kind: 'tv', tmdbId: 1, season: 1, episode: 2 }, imdbId: 'tt0903747' }))).toEqual([
      { url: `/api/stream/torrent/${HASH}/sub/service-222.vtt`, lang: 'en', label: 'English (matched by title)' },
    ]);
    expect(calls.map((c) => c.url.replace('https://subs.fixture', ''))).toEqual([
      '/subtitles/series/tt0903747:1:2/videoHash=0000000000020003&videoSize=131072.json',
      '/subtitles/series/tt0903747:1:2.json',
      'https://files.fixture/222.srt',
    ]);
  });

  it('throws when the service does not answer, answers [] when it lists nothing, asks nothing without an IMDb id', async () => {
    const down = fake(() => json({}, 503));
    await expect(serviceTier({ baseUrl: 'https://subs.fixture', fetch: down.fetch, torrents: { filePath: () => null }, shelf: new SubtitleShelf(dir) }).find(ctx())).rejects.toThrow(/did not answer/);
    const empty = fake(() => json({ subtitles: [] }));
    expect(await serviceTier({ baseUrl: 'https://subs.fixture', fetch: empty.fetch, torrents: { filePath: () => null }, shelf: new SubtitleShelf(dir) }).find(ctx())).toEqual([]);
    expect(empty.calls).toHaveLength(2);
    const none = fake(() => json({ subtitles: [] }));
    expect(await serviceTier({ baseUrl: 'https://subs.fixture', fetch: none.fetch, torrents: { filePath: () => null }, shelf: new SubtitleShelf(dir) }).find(ctx({ imdbId: null }))).toEqual([]);
    expect(none.calls).toHaveLength(0);
  });
});
```
**File:** `tests/unit/directStream/torrent/subtitles/borrow.test.ts`
```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { borrowTier } from '../../../../../src/directStream/torrent/subtitles/borrow.js';
import { SubtitleShelf } from '../../../../../src/directStream/torrent/subtitles/disk.js';
import type { SubtitleContext } from '../../../../../src/directStream/torrent/subtitles/chain.js';
import { REST_OF_CONTEXT } from './context.js';

const HASH = 'd'.repeat(40);
let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'notesd-borrow-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const ctx = (cloudTried = false): SubtitleContext => ({
  ...REST_OF_CONTEXT,
  ref: { kind: 'movie', tmdbId: 7 }, imdbId: 'tt0000007', infoHash: HASH, release: 'Film', files: [], fileIndex: 0, subtitleIndexes: [], handle: null, cloudTried,
});

describe('borrowTier (R3.3)', () => {
  it('keeps a cloud provider\'s English subtitle as borrow.vtt, labelled with the provider, with one WEBVTT header', async () => {
    const asked: number[] = [];
    const tier = borrowTier({
      shelf: new SubtitleShelf(dir),
      lend: () => async (_ref, o) => (asked.push(o.deadlineS), { provider: 'VidLink', label: 'English', vtt: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nOne.\n\nWEBVTT\n\n00:00:03.000 --> 00:00:04.000\nTwo.\n' }),
    });
    expect(await tier.find(ctx())).toEqual([{ url: `/api/stream/torrent/${HASH}/sub/borrow.vtt`, lang: 'en', label: 'English (VidLink)' }]);
    expect(asked).toEqual([45]);
    const saved = await readFile(path.join(dir, HASH, '.notesd-subs', 'borrow.vtt'), 'utf8');
    expect(saved.match(/WEBVTT/g)).toHaveLength(1);
    expect(saved).toContain('Two.');
  });

  it('asks nothing after a cloud no_source, or without direct streaming', async () => {
    let asked = 0;
    const lend = async () => (asked++, { provider: 'X', label: 'English', vtt: '' });
    expect(await borrowTier({ shelf: new SubtitleShelf(dir), lend: () => lend }).find(ctx(true))).toEqual([]);
    expect(await borrowTier({ shelf: new SubtitleShelf(dir), lend: () => null }).find(ctx())).toEqual([]);
    expect(asked).toBe(0);
  });

  it('throws on a failed or late borrow (the chain records it; the play goes on)', async () => {
    await expect(borrowTier({ shelf: new SubtitleShelf(dir), lend: () => async () => { throw new Error('no_source'); } }).find(ctx())).rejects.toThrow('no_source');
    await expect(borrowTier({ shelf: new SubtitleShelf(dir), deadlineS: 0, graceMs: 5, lend: () => () => new Promise(() => undefined) }).find(ctx())).rejects.toThrow(/no subtitle within/);
  });
});
```

**File:** `tests/unit/directStream/torrent/subtitles/context.ts` (new, a test helper the tier tests of phases 6 to 8 share)
```ts
import type { SubtitleContext } from '../../../../../src/directStream/torrent/subtitles/chain.js';

/** The fields of phase 3's SubtitleContext a tier test does not care about. */
export const REST_OF_CONTEXT = {
  probe: { container: 'mov,mp4,m4a,3gp,3g2,mj2', video: { codec: 'h264', height: 720 }, audio: [{ codec: 'aac', lang: 'eng' }], subtitles: [], durationS: 120, direct: true },
  audioLang: 'en',
  resumeS: null,
  localBase: 'http://127.0.0.1:1',
  signal: new AbortController().signal,
  deadline: Number.MAX_SAFE_INTEGER,
} satisfies Partial<SubtitleContext>;
```

**File:** `tests/unit/directStream/torrent/subtitles/chain.test.ts` (the stop rule, the attempts and the budget are
phase 3's and tested there; this file tests this phase's tier list)
```ts
import { describe, expect, it } from 'vitest';
import { buildSubtitleTiers } from '../../../../../src/directStream/torrent/subtitles/chain.js';
import type { TorrentStreams } from '../../../../../src/directStream/torrent/service.js';

describe('buildSubtitleTiers', () => {
  const deps = {
    torrentDir: '/tmp/none',
    torrents: { filePath: async () => null } as unknown as TorrentStreams,
    log: () => undefined,
    fetch: async () => new Response(''),
    lend: () => null,
  };
  it('orders kept, files, service, borrow, every one blocking; without a service address the service is left out', () => {
    const tiers = buildSubtitleTiers({ ...deps, subtitleUrl: 'https://subs.fixture' });
    expect(tiers.map((t) => t.name)).toEqual(['kept', 'files', 'service', 'borrow']);
    expect(tiers.every((t) => t.blocks)).toBe(true);
    expect(buildSubtitleTiers({ ...deps, subtitleUrl: null }).map((t) => t.name)).toEqual(['kept', 'files', 'borrow']);
  });
});
```

**File:** `tests/unit/directStream/torrent/subtitleRoute.test.ts`
```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDeps } from '../../../../src/deps.js';
import { SubtitleShelf } from '../../../../src/directStream/torrent/subtitles/disk.js';
import { streamTorrentRoutes } from '../../../../src/http/streamTorrentApi.js';

const HASH = 'f'.repeat(40);
let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'notesd-subroute-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function app(torrents: unknown): Hono {
  const a = new Hono();
  a.route('/', streamTorrentRoutes({ config: { torrent: { dir } }, torrents } as unknown as AppDeps));
  return a;
}

describe('GET /api/stream/torrent/:hash/sub/:name', () => {
  it('serves a kept subtitle as WebVTT', async () => {
    await new SubtitleShelf(dir).save(HASH, 'file-1.vtt', 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi.\n', { lang: 'en', label: 'English' });
    const res = await app({ view: async () => null }).request(`/api/stream/torrent/${HASH}/sub/file-1.vtt`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/vtt/);
    expect(await res.text()).toContain('Hi.');
  });

  it('answers not_found for an unknown or unsafe name, not_on_this_machine for the other machine\'s torrent, and 503 when off', async () => {
    expect((await app({ view: async () => null }).request(`/api/stream/torrent/${HASH}/sub/chosen.json`)).status).toBe(404);
    expect(await (await app({ view: async () => null }).request(`/api/stream/torrent/${HASH}/sub/borrow.vtt`)).json()).toMatchObject({ error: 'not_found' });
    const other = await app({ view: async () => ({ host: 'laptop-b', available: false }) }).request(`/api/stream/torrent/${HASH}/sub/borrow.vtt`);
    expect(other.status).toBe(404);
    expect(await other.json()).toMatchObject({ error: 'not_on_this_machine', host: 'laptop-b' });
    expect((await app(null).request(`/api/stream/torrent/${HASH}/sub/borrow.vtt`)).status).toBe(503);
  });
});
```

**File:** `tests/unit/config.test.ts`. Add `subtitleUrl: 'https://opensubtitles-v3.strem.io'` to phase 1's whole-object expectation of the torrent config, and add:
```ts
  it('reads the torrent subtitle service address', () => {
    const t = (env: Record<string, string>) => loadConfig({ env: { DATABASE_URL: URL_A, ...env }, envFile: false }).torrent
    expect(DEFAULT_TORRENT_CONFIG.subtitleUrl).toBeNull()
    expect(t({})?.subtitleUrl).toBe('https://opensubtitles-v3.strem.io')
    expect(t({ NOTESD_TORRENT_SUBTITLE_URL: 'off' })?.subtitleUrl).toBeNull()
    expect(t({ NOTESD_TORRENT_SUBTITLE_URL: ' http://127.0.0.1:9100/ ' })?.subtitleUrl).toBe('http://127.0.0.1:9100')
    expect(() => t({ NOTESD_TORRENT_SUBTITLE_URL: 'strem.io' })).toThrow(/NOTESD_TORRENT_SUBTITLE_URL/)
  })
```
(`DEFAULT_TORRENT_CONFIG` joins the file's import from `src/config.ts`.)

### Step 12: Docs

**File:** `scripts/docs/httpRoutes.ts`, in the section that holds phase 1's `GET /api/stream/torrent/:hash/f/:index`, after it:
```ts
      'GET /api/stream/torrent/:hash/sub/:name':
        'A subtitle file of a torrent on this machine, as WebVTT, with `Range` (206, 416): `file-<index>.vtt` (a subtitle file inside the torrent: SubRip converted, ASS/SSA converted with ffmpeg), `service-<id>.vtt` (from the subtitle service, `NOTESD_TORRENT_SUBTITLE_URL`) or `borrow.vtt` (a cloud provider\'s English subtitle). They are kept under `<NOTESD_TORRENT_DIR>/<hash>/.notesd-subs/`, so a replay from disk has them, and a torrent session\'s `subtitles` point here. 404 `not_found`; 404 `not_on_this_machine` with `host` for a torrent the other machine downloaded; 503 when torrents are off.',
```
Then `npm run docs:gen` regenerates `docs/guide/reference/http-api.md`.

**File:** `docs/guide/reference/configuration.md`, in the direct-streaming table after phase 1's `NOTESD_TORRENT_KEEP_DAYS` row (or after `NOTESD_STREAM_CACHE_DIR` at `:145` if phase 1 put its rows elsewhere, next to them):
```md
| `NOTESD_TORRENT_SUBTITLE_URL` | `https://opensubtitles-v3.strem.io` | The subtitle service asked for an English subtitle when a torrent holds no subtitle file (Stremio's OpenSubtitles add-on; no key). One plain request by the file's OpenSubtitles hash, then one by the IMDb id, each saying it is notesd. `off`: never asked; a cloud provider's subtitle is tried next. See [streaming.md](../streaming.md#subtitles-for-a-torrent). |
```

**File:** `docs/guide/streaming.md`, a subsection of its own under phase 1/3's `### Torrents` heading (one level below it):
```md
### Subtitles for a torrent

A torrent session gets its English subtitle from the first of these that has one. The play
answer's `attempts` list each one asked as `Subtitles: <tier>`.

1. **Kept.** What an earlier play of the same torrent chose, from
   `<NOTESD_TORRENT_DIR>/<info hash>/.notesd-subs/`. A replay from disk asks nothing else.
2. **A file in the torrent.** Releases often carry `Film.en.srt`, `Film.eng.srt`, `English.srt`
   or `Subs/<film>/2_English.srt` beside the video. Those files are downloaded with the video, and
   the play waits up to 15 s for them. A plain English file comes before an SDH one, SubRip
   before WebVTT before ASS/SSA (converted with ffmpeg), and a `forced` file is never used. With
   no English file, the torrent's one subtitle file is used when its name gives no language; the
   player shows it like an English one. A file that has not arrived in 15 s is skipped for this
   play, and the next play finds it.
3. **The subtitle service** (`NOTESD_TORRENT_SUBTITLE_URL`, Stremio's OpenSubtitles add-on). It is
   asked first by the video's OpenSubtitles hash (its size and its first and last 64 KiB, read
   from the torrent ahead of the rest), so the lines match this exact file. If that fails, it is
   asked by the title's IMDb id, and the English file whose name shares the most words with the
   release is taken; it is labelled "English (matched by title)".
4. **A cloud provider.** The title is resolved out of sight, as `direct_stream_dialogue` does,
   and that provider's English subtitle is kept as `borrow.vtt`, labelled with the provider. It
   is skipped when the torrent was the fall-through after the cloud providers answered
   `no_source`. It gets 45 s, and its failure never stops the play.

A subtitle matched by title or borrowed from a provider may be cut for another release, so its
lines can come early or late. The player's G and H keys move them 50 ms at a time, and the delay
is kept for the title (see [The player](#the-player)).

Before the first torrent is opened, the file lists of the best three candidates are read in
parallel (metadata only), and one whose files hold an English subtitle is tried first. The
others leave their swarms at once.

Each kept file is served by `GET /api/stream/torrent/<hash>/sub/<name>`.
```

### Step 13: The feature map and the proof harness

**File:** `.claude/skills/verify-notesd/features/direct-streaming.md`, a new section before `## Gotchas` (`:325`):
```md
## Torrent subtitles
- A torrent session (`provider: "torrent"`, or the fall-through after a cloud `no_source`) carries an
  English subtitle from the first tier that has one: `kept` (an earlier play of the same torrent),
  `files` (an English `.srt`/`.vtt`/`.ass` inside the torrent, or its one subtitle file that names no
  language), `service` (the OpenSubtitles add-on at `NOTESD_TORRENT_SUBTITLE_URL`, by file hash then
  by IMDb id), `borrow` (a cloud provider's English subtitle, resolved out of sight; skipped after a
  cloud `no_source`). The play answer's `attempts` hold one `Subtitles: <tier>` line per tier asked.
  Files are WebVTT under `<data dir>/movies/torrents/<hash>/.notesd-subs/`, served by
  `GET /api/stream/torrent/:hash/sub/:name`; the page shows the English one (or the lone unnamed one)
  by default. Of the best three candidates, one whose files hold an English subtitle is tried first.
- Logic: `npx vitest run tests/unit/directStream/torrent/subtitles tests/unit/directStream/torrent/subtitleRoute.test.ts`.
- Throwaway daemon: `$V up --web --direct-stream --torrent` (note RUN, `TORRENT=`, `SUBS=`), then
  `.claude/skills/verify-notesd/scripts/torrent/subtitles.sh RUN` (all stages, about four minutes;
  `files` before `replay`). `up --torrent` starts a fake subtitle service
  (`scripts/torrent/fake-subs.mjs`; `$SUBS/mode` is `ok`, `id_only`, `empty` or `error`;
  `$SUBS/requests.jsonl` records each request's path and user-agent) and points
  `NOTESD_TORRENT_SUBTITLE_URL` at it; never the real service. Fixture torrents come from
  `scripts/torrent/make-subtitle-fixtures.sh` (cached in `$VERIFY_HOME/.torrent-subtitle-fixtures`).
  The transcript ends with `subtitles: PASS (...)`; `down` copies the request log into the evidence.
```

**File:** `.claude/skills/verify-notesd/scripts/verify.sh`. Three edits inside phase 1's `--torrent` code:

(a) In `up`, inside phase 1's `if [ "$torrent" = 1 ]` block, after its seeder starts:
```bash
    # Phase 6: a fake subtitle service in the shape of Stremio's OpenSubtitles add-on; never the real one.
    mkdir -p "$dir/torrent/subs"
    setsid node "$root/.claude/skills/verify-notesd/scripts/torrent/fake-subs.mjs" --state "$dir/torrent/subs" \
      --info "$dir/torrent/subs/info.json" </dev/null >"$dir/torrent/subs/out.log" 2>&1 &
    echo $! >"$dir/subs.pid"
    for _ in $(seq 1 40); do [ -s "$dir/torrent/subs/info.json" ] && break; sleep 0.25; done
    [ -s "$dir/torrent/subs/info.json" ] || die "--torrent: the fake subtitle service did not start (log: $dir/torrent/subs/out.log; verify.sh down $run)"
```
and, where phase 1 adds its `NOTESD_TORRENT*` variables to `env`:
```bash
    env+=("NOTESD_TORRENT_SUBTITLE_URL=$(jq -r .origin "$dir/torrent/subs/info.json")")
```
(b) Next to the `DIRECT=` printout (`:311`):
```bash
  if [ "$torrent" = 1 ]; then echo "SUBS=$dir/torrent/subs"; fi
```
(c) In `down`, next to the upstream host's stop (`:465-469`):
```bash
  if [ -f "$dir/subs.pid" ]; then
    kill -TERM -- "-$(cat "$dir/subs.pid")" 2>/dev/null || kill -TERM "$(cat "$dir/subs.pid")" 2>/dev/null || true
  fi
  if [ -f "$dir/torrent/subs/requests.jsonl" ]; then cp "$dir/torrent/subs/requests.jsonl" "$dir/evidence/torrent-subtitle-requests.jsonl"; fi
```

**File:** `.claude/skills/verify-notesd/scripts/torrent/fake-subs.mjs` (new)
```js
#!/usr/bin/env node
// A fake subtitle service in the shape of Stremio's OpenSubtitles add-on, for `verify.sh up --torrent`
// (TORRENT_STREAM_SOURCE phase 6). It answers /subtitles/<movie|series>/<id>[/<extra>].json and serves the
// .srt files it lists. <state>/mode picks the answers:
//   ok (default)  by hash: a hash-matched entry (9001), an id entry (9002), a French one; by id: 9002 and the French one
//   id_only       the hash request answers 500; by id as in ok
//   empty         every list is empty
//   error         every list answers 500
// Every request is one line of <state>/requests.jsonl: {at, path, user_agent, mode}.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? null);
};
const state = flag('--state');
const info = flag('--info');
if (!state || !info) {
  console.error('usage: fake-subs.mjs --state DIR --info FILE');
  process.exit(2);
}
mkdirSync(state, { recursive: true });

const srt = (line) => `1\r\n00:00:01,000 --> 00:00:30,000\r\n${line}\r\n\r\n2\r\n00:00:31,000 --> 00:00:59,000\r\n${line} (2)\r\n`;
const FILES = { 'hash.srt': srt('Service subtitle by hash'), 'id.srt': srt('Service subtitle by id'), 'french.srt': srt('Sous-titre') };

function mode() {
  const file = path.join(state, 'mode');
  return (existsSync(file) ? readFileSync(file, 'utf8').trim() : '') || 'ok';
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://fake.local');
  const now = mode();
  const pathname = decodeURIComponent(url.pathname);
  appendFileSync(path.join(state, 'requests.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), path: pathname, user_agent: req.headers['user-agent'] ?? null, mode: now })}\n`);
  const origin = `http://${req.headers.host}`;
  const file = /^\/files\/([a-z]+\.srt)$/.exec(pathname);
  if (file && FILES[file[1]]) {
    res.writeHead(200, { 'content-type': 'application/x-subrip' });
    res.end(FILES[file[1]]);
    return;
  }
  const list = /^\/subtitles\/(movie|series)\/(tt\d+(?::\d+:\d+)?)(\/[^/]+)?\.json$/.exec(pathname);
  if (!list) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"err":"not found"}');
    return;
  }
  const byHash = list[3] !== undefined && /videoHash=[0-9a-f]{16}&videoSize=\d+/.test(list[3]);
  if (now === 'error' || (now === 'id_only' && byHash)) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"err":"fake failure"}');
    return;
  }
  const entry = (id, name, m, lang = 'eng') => ({ id, url: `${origin}/files/${name}`, lang, m, g: '1', SubEncoding: 'UTF-8', subtitleFileName: name });
  const subtitles = now === 'empty' ? [] : [...(byHash ? [entry('9001', 'hash.srt', 'h')] : []), entry('9002', 'id.srt', 'i'), entry('9003', 'french.srt', 'i', 'fre')];
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ subtitles, cacheMaxAge: 0 }));
});
server.listen(0, '127.0.0.1', () => {
  writeFileSync(info, JSON.stringify({ origin: `http://127.0.0.1:${server.address().port}` }));
});
```

**File:** `.claude/skills/verify-notesd/scripts/torrent/make-subtitle-fixtures.sh` (new)
```bash
#!/usr/bin/env bash
# make-subtitle-fixtures.sh OUT: the fixture torrent folders of TORRENT_STREAM_SOURCE phase 6's journeys, made
# once with ffmpeg and cached (OUT/.done). Prints OUT. Each folder is one torrent; a Film.nfo naming the folder
# makes every info hash different. The video is H.264/AAC MP4 (Chrome plays it as is).
set -euo pipefail
OUT=${1:?usage: make-subtitle-fixtures.sh OUT}
if [ -f "$OUT/.done" ]; then echo "$OUT"; exit 0; fi
command -v ffmpeg >/dev/null || { echo "make-subtitle-fixtures: ffmpeg not found" >&2; exit 1; }
mkdir -p "$OUT"
film() { # film SECONDS FILE
  ffmpeg -loglevel error -y -f lavfi -i "testsrc2=size=640x360:rate=24" -f lavfi -i "sine=frequency=440:sample_rate=48000" \
    -t "$1" -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -b:a 96k -movflags +faststart "$2"
}
srt() { printf '1\r\n00:00:01,000 --> 00:00:30,000\r\n%s\r\n\r\n2\r\n00:00:31,000 --> 00:00:59,000\r\n%s (2)\r\n' "$1" "$1"; }
film 60 "$OUT/film-60.mp4"
film 61 "$OUT/film-61.mp4"
for name in with-sub lone ass bare-service bare-byid bare-borrow bare-quiet bare-hi with-sub-low; do
  mkdir -p "$OUT/$name/Film"
  if [ "$name" = bare-hi ]; then cp "$OUT/film-61.mp4" "$OUT/$name/Film/Film.mp4"; else cp "$OUT/film-60.mp4" "$OUT/$name/Film/Film.mp4"; fi
  printf 'fixture %s\n' "$name" >"$OUT/$name/Film/Film.nfo"
done
srt 'Torrent subtitle line one' >"$OUT/with-sub/Film/Film.en.srt"
srt 'Torrent subtitle line one' >"$OUT/with-sub-low/Film/Film.en.srt"
srt 'Lone subtitle line' >"$OUT/lone/Film/Film.srt"
cat >"$OUT/ass/Film/Film.eng.ass" <<'ASS'
[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:30.00,Default,,0,0,0,,ASS subtitle line
ASS
touch "$OUT/.done"
echo "$OUT"
```

**File:** `.claude/skills/verify-notesd/scripts/torrent/subtitle-page.steps.mjs` (new)
```js
// TORRENT_STREAM_SOURCE phase 6: the real player page turns a torrent session's subtitle on by default
// and shows its line. SESSION_ID: a live session; WANT_LINE: a line its subtitle shows between 1 s and 30 s.
export default async ({ page, base, shot, log }) => {
  const id = process.env.SESSION_ID
  const want = process.env.WANT_LINE
  if (!id || !want) throw new Error('SESSION_ID and WANT_LINE are required')
  await page.goto(`${base}/stream/${id}?muted=1`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 60_000 })
  const chosen = await page.evaluate(() => ({ subtitle: window.notesdStream.subtitle, options: window.notesdStream.subtitles }))
  if (chosen.subtitle === null) throw new Error(`no subtitle is on by default: ${JSON.stringify(chosen.options)}`)
  await page.evaluate(() => document.querySelector('video')?.play())
  await page.waitForFunction((line) => (window.notesdStream?.caption ?? '').includes(line), want, { timeout: 45_000 })
  await shot('torrent-subtitle')
  log(`SUBTITLE PAGE PASS: ${chosen.subtitle} is on by default and shows "${want}"`)
}
```

**File:** `.claude/skills/verify-notesd/scripts/torrent/subtitles.sh` (new)
```bash
#!/usr/bin/env bash
# subtitles.sh RUN [files|replay|lone|ass|service|byid|borrow|quiet|prefer ...]: TORRENT_STREAM_SOURCE phase 6's
# checks on a `verify.sh up --web --direct-stream --torrent` run. Each stage seeds a fixture torrent on
# loopback, has the fake index list it, plays a title with POST /api/stream/play {provider: "torrent"},
# and reads the session, the subtitle route, the fake subtitle service's request log
# ($SUBS/requests.jsonl) and the fake resolver's calls. Each stage plays a different title, because
# a title played once replays from disk. The first failed check stops it with
# `subtitles: FAIL at <stage>`. No stage named: all, in this order (replay needs files first).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V="$HERE/../verify.sh"
VERIFY_HOME="${VERIFY_HOME:-$HOME/.local/state/notesd-verify}"
RUN=${1:?usage: subtitles.sh RUN [files|replay|lone|ass|service|byid|borrow|quiet|prefer ...]}
shift
WANTED=("$@")
if [ ${#WANTED[@]} -eq 0 ]; then WANTED=(files replay lone ass service byid borrow quiet prefer); fi
DIR="$VERIFY_HOME/$RUN"
TORRENT="$DIR/torrent"
SUBS="$TORRENT/subs"
DIRECT="$DIR/direct"
[ -s "$SUBS/info.json" ] || { echo "subtitles: $RUN was not started with --torrent" >&2; exit 2; }
[ -s "$DIRECT/upstream.json" ] || { echo "subtitles: $RUN was not started with --direct-stream" >&2; exit 2; }
URL="http://127.0.0.1:$(cat "$DIR/port")"
EV="$DIR/evidence"
FIX="$(bash "$HERE/make-subtitle-fixtures.sh" "$VERIFY_HOME/.torrent-subtitle-fixtures")"
STAGE=start
CODE=""
BODY=""
SID=""

stage() { STAGE=$1; echo "== $STAGE"; }
ok() { echo "   ok  $*"; "$V" note "$RUN" "torrent subtitles $STAGE: $*"; }
fail() {
  echo "subtitles: FAIL at $STAGE: $*" >&2
  "$V" note "$RUN" "torrent subtitles FAIL at $STAGE: $*" || true
  exit 1
}
api() {
  local out
  out="$("$V" api "$RUN" "$@" 2>/dev/null)"
  CODE="$(sed -n 's/^< HTTP \([0-9]*\).*/\1/p' <<<"$out" | head -1)"
  BODY="$(sed '1,/^< HTTP /d' <<<"$out")"
}
# get PATH NAME: GET as the player does; the body is saved as evidence and read into GOT.
get() {
  CODE="$(curl -sS -o "$EV/torrent-sub-$2.body" -w '%{http_code}' "$URL$1")"
  GOT="$(cat "$EV/torrent-sub-$2.body")"
}

# The one place this script meets phases 1 and 3's harness (verify.sh up --torrent):
#  - phase 1's loopback seeder seeds every folder copied into $TORRENT/seed/<name>/ and then writes
#    $TORRENT/seeded/<name>.json = {"info_hash": "<40 hex>", ...};
#  - phase 3's fake index answers every query with $TORRENT/candidates.json,
#    [{info_hash, name, seeds, size_bytes}].
# (Reconciled: these are phase 1's and phase 3's names; the fake index answers each release as `<Title>.<Year>.<name>`.)
seed() { # seed NAME: prints the info hash
  mkdir -p "$TORRENT/seed"
  # Moved in whole (copy to a dot-name, then rename): phase 1's seeder skips dot-names and seeds a folder once.
  [ -d "$TORRENT/seed/$1" ] || { rm -rf "$TORRENT/seed/.$1"; cp -r "$FIX/$1" "$TORRENT/seed/.$1"; mv "$TORRENT/seed/.$1" "$TORRENT/seed/$1"; }
  for _ in $(seq 1 120); do [ -s "$TORRENT/seeded/$1.json" ] && break; sleep 0.25; done
  [ -s "$TORRENT/seeded/$1.json" ] || fail "the loopback seeder did not seed $1"
  jq -r .info_hash "$TORRENT/seeded/$1.json"
}
candidates() { # candidates PREFIX NAME:SEEDS ...
  local prefix=$1 out='[]' pair name seeds hash
  shift
  for pair in "$@"; do
    name=${pair%%:*}
    seeds=${pair##*:}
    hash="$(jq -r .info_hash "$TORRENT/seeded/$name.json")"
    out="$(jq -c --arg h "$hash" --arg n "$prefix.1080p.WEB.x264-$name" --argjson s "$seeds" '. + [{info_hash: $h, name: $n, seeds: $s, size_bytes: 1500000}]' <<<"$out")"
  done
  printf '%s\n' "$out" >"$TORRENT/candidates.json"
}

play() {
  api POST /api/stream/play "$1"
  [ "$CODE" = 200 ] || fail "POST /api/stream/play $1 answered HTTP $CODE: $BODY"
  SID="$(jq -r .session.session_id <<<"$BODY")"
  printf '%s\n' "$BODY" >"$EV/torrent-sub-play-$STAGE.json"
}
sub() { jq -r ".session.subtitles[0].$1 // \"\"" <<<"$BODY"; }
outcome() { jq -r --arg p "Subtitles: $1" '[.attempts[] | select(.provider == $p) | .outcome] | join(",")' <<<"$BODY"; }
requests() { if [ -f "$SUBS/requests.jsonl" ]; then wc -l <"$SUBS/requests.jsonl" | tr -d ' '; else echo 0; fi; }
resolves() { if [ -f "$DIRECT/calls.jsonl" ]; then grep -c '"resolve"' "$DIRECT/calls.jsonl" || true; else echo 0; fi; }
page() { # page LINE: the real player page shows the session's subtitle by default
  SESSION_ID="$SID" WANT_LINE="$1" "$V" ui "$RUN" "$HERE/subtitle-page.steps.mjs" >"$EV/torrent-sub-page-$STAGE.txt" 2>&1 \
    || fail "the player page did not show [$1] by default (see $EV/torrent-sub-page-$STAGE.txt)"
  ok "the player page turned the subtitle on by default and showed [$1]"
}
# ohash FILE: the OpenSubtitles hash, computed here independently of the daemon.
ohash() {
  node -e 'const fs=require("fs");const f=process.argv[1];const n=fs.statSync(f).size;const fd=fs.openSync(f,"r");const r=(p)=>{const b=Buffer.alloc(65536);fs.readSync(fd,b,0,65536,p);return b};let s=BigInt(n);for(const b of [r(0),r(n-65536)])for(let i=0;i<65536;i+=8)s=(s+b.readBigUInt64LE(i))&((1n<<64n)-1n);console.log(s.toString(16).padStart(16,"0")+" "+n)' "$1"
}

FILES_HASH=""
stage_files() {
  stage files
  local before
  FILES_HASH="$(seed with-sub)"
  candidates Film.2010 with-sub:500
  before="$(requests)"
  play '{"kind":"movie","tmdb_id":467905,"provider":"torrent"}'
  [[ "$(sub url)" =~ ^/api/stream/torrent/$FILES_HASH/sub/file-[0-9]+\.vtt$ ]] || fail "the session's subtitle is [$(sub url)], not the torrent's file"
  [ "$(sub lang) $(sub english)" = "en true" ] || fail "the subtitle is [$(sub lang) $(sub english)], not English"
  [ "$(outcome files)" = resolved ] || fail "Subtitles: files is [$(outcome files)]"
  get "$(sub url)" files
  [ "$CODE" = 200 ] || fail "the subtitle route answered $CODE"
  [[ "$GOT" == WEBVTT* ]] && grep -q '00:00:01.000 --> 00:00:30.000' <<<"$GOT" && grep -q 'Torrent subtitle line one' <<<"$GOT" || fail "the served file is not the torrent's .srt as WebVTT"
  [ "$(requests)" = "$before" ] || fail "the subtitle service was asked although the torrent holds an English file"
  [ -s "$DIR/data/movies/torrents/$FILES_HASH/.notesd-subs/chosen.json" ] || fail "chosen.json was not kept under the torrent folder"
  ok "Film.en.srt in the torrent is the session's English subtitle, served as WebVTT, the service not asked"
  page 'Torrent subtitle line one'
}

stage_replay() {
  stage replay
  [ -n "$FILES_HASH" ] || FILES_HASH="$(jq -r .info_hash "$TORRENT/seeded/with-sub.json")"
  local before
  before="$(requests)"
  play '{"kind":"movie","tmdb_id":467905,"provider":"torrent"}'
  [ "$(outcome kept)" = resolved ] || fail "Subtitles: kept is [$(outcome kept)] on the second play"
  [ -z "$(outcome files)" ] || fail "the files tier ran again on the second play"
  [[ "$(sub url)" =~ ^/api/stream/torrent/$FILES_HASH/sub/file-[0-9]+\.vtt$ ]] || fail "the second play's subtitle is [$(sub url)]"
  [ "$(requests)" = "$before" ] || fail "the second play asked the subtitle service"
  ok "a second play answers the kept subtitle and asks nothing"
}

stage_lone() {
  stage lone
  seed lone >/dev/null
  candidates Rivals.2026 lone:500
  play '{"kind":"movie","tmdb_id":990001,"provider":"torrent"}'
  [ "$(jq -c '.session.subtitles | map({lang, label})' <<<"$BODY")" = '[{"lang":null,"label":""}]' ] || fail "the lone subtitle is $(jq -c .session.subtitles <<<"$BODY")"
  get "$(sub url)" lone
  grep -q 'Lone subtitle line' <<<"$GOT" || fail "the served file is not Film.srt"
  ok "the torrent's one subtitle file that names no language is the session's subtitle"
  page 'Lone subtitle line'
}

stage_ass() {
  stage ass
  seed ass >/dev/null
  candidates Dog.Stars.2026 ass:500
  play '{"kind":"movie","tmdb_id":990002,"provider":"torrent"}'
  [ "$(sub label)" = English ] || fail "the ASS subtitle is labelled [$(sub label)]"
  get "$(sub url)" ass
  [[ "$GOT" == WEBVTT* ]] && grep -q -- '-->' <<<"$GOT" && grep -q 'ASS subtitle line' <<<"$GOT" || fail "Film.eng.ass was not converted to WebVTT"
  ok "an English .ass in the torrent is converted with ffmpeg and served as WebVTT"
}

stage_service() {
  stage service
  local before hash first want
  hash="$(seed bare-service)"
  candidates Bad.Apples.2026 bare-service:500
  printf 'ok\n' >"$SUBS/mode"
  before="$(requests)"
  play '{"kind":"movie","tmdb_id":990003,"provider":"torrent"}'
  [ "$(sub url)" = "/api/stream/torrent/$hash/sub/service-9001.vtt" ] || fail "the subtitle is [$(sub url)], not the hash-matched service file"
  [ "$(outcome files)" = no_stream ] && [ "$(outcome service)" = resolved ] || fail "attempts: files=[$(outcome files)] service=[$(outcome service)]"
  first="$(sed -n "$((before + 1))p" "$SUBS/requests.jsonl")"
  read -r want_hash want_size <<<"$(ohash "$FIX/bare-service/Film/Film.mp4")"
  want="videoHash=$want_hash&videoSize=$want_size.json"
  [[ "$(jq -r .path <<<"$first")" =~ ^/subtitles/movie/tt[0-9]+/ ]] && [[ "$(jq -r .path <<<"$first")" == *"$want" ]] || fail "the first request [$(jq -r .path <<<"$first")] does not carry [$want]"
  [[ "$(jq -r .user_agent <<<"$first")" == notesd* ]] || fail "the request's user-agent [$(jq -r .user_agent <<<"$first")] does not say notesd"
  get "$(sub url)" service
  grep -q 'Service subtitle by hash' <<<"$GOT" || fail "the served file is not the hash-matched one"
  ok "no subtitle in the torrent: the service was asked by the file's hash ($want_hash) as notesd and its file is served"
  page 'Service subtitle by hash'
}

stage_byid() {
  stage byid
  local before hash
  hash="$(seed bare-byid)"
  candidates MobLand.S01E01 bare-byid:500
  printf 'id_only\n' >"$SUBS/mode"
  before="$(requests)"
  play '{"kind":"tv","tmdb_id":247718,"season":1,"episode":1,"provider":"torrent"}'
  [ "$(sub url)" = "/api/stream/torrent/$hash/sub/service-9002.vtt" ] || fail "the subtitle is [$(sub url)], not the id-matched file"
  [ "$(sub label)" = 'English (matched by title)' ] || fail "the label is [$(sub label)]"
  sed -n "$((before + 1)),\$p" "$SUBS/requests.jsonl" | jq -r .path >"$EV/torrent-sub-byid-paths.txt"
  sed -n 1p "$EV/torrent-sub-byid-paths.txt" | grep -Eq '^/subtitles/series/tt[0-9]+:1:1/videoHash=' || fail "the first request was not by hash"
  sed -n 2p "$EV/torrent-sub-byid-paths.txt" | grep -Eq '^/subtitles/series/tt[0-9]+:1:1\.json$' || fail "the second request was not by IMDb id alone"
  ok "the hash request failed (500), the IMDb id request answered, its English file is served"
}

stage_borrow() {
  stage borrow
  local hash before
  hash="$(seed bare-borrow)"
  candidates MobLand.S01E02 bare-borrow:500
  printf 'empty\n' >"$SUBS/mode"
  printf 'hls\n' >"$DIRECT/mode"
  before="$(resolves)"
  play '{"kind":"tv","tmdb_id":247718,"season":1,"episode":2,"provider":"torrent"}'
  [ "$(sub url)" = "/api/stream/torrent/$hash/sub/borrow.vtt" ] || fail "the subtitle is [$(sub url)], not the borrowed one"
  [[ "$(sub label)" == 'English ('* ]] || fail "the label [$(sub label)] does not name the provider"
  [ "$(outcome service)" = no_stream ] && [ "$(outcome borrow)" = resolved ] || fail "attempts: service=[$(outcome service)] borrow=[$(outcome borrow)]"
  [ "$(resolves)" = "$((before + 1))" ] || fail "the borrow made $(( $(resolves) - before )) resolves, not one"
  get "$(sub url)" borrow
  grep -q '00:00:01.000 --> 00:00:03.000' <<<"$GOT" && grep -q 'Hello.' <<<"$GOT" || fail "the served file is not the provider's subtitle"
  ok "the service had nothing: one out-of-sight resolve borrowed the cloud provider's English subtitle"
  page 'Hello.'
}

stage_quiet() {
  stage quiet
  seed bare-quiet >/dev/null
  candidates MobLand.S01E03 bare-quiet:500
  printf 'error\n' >"$SUBS/mode"
  printf 'no_chrome\n' >"$DIRECT/mode"
  play '{"kind":"tv","tmdb_id":247718,"season":1,"episode":3,"provider":"torrent"}'
  printf 'hls\n' >"$DIRECT/mode"
  [ "$(jq '.session.subtitles | length' <<<"$BODY")" = 0 ] || fail "a subtitle came from nowhere: $(jq -c .session.subtitles <<<"$BODY")"
  [ "$(outcome service)" = error ] && [ "$(outcome borrow)" = error ] || fail "attempts: service=[$(outcome service)] borrow=[$(outcome borrow)]"
  [ -n "$(jq -r '.session.manifest_url // empty' <<<"$BODY")" ] || fail "the play has no manifest"
  ok "the service down and the borrow failed: both recorded as errors, the play still answers"
}

stage_prefer() {
  stage prefer
  local hi low
  hi="$(seed bare-hi)"
  low="$(seed with-sub-low)"
  candidates Oldboy.2003 bare-hi:900 with-sub-low:100
  play '{"kind":"movie","tmdb_id":990004,"provider":"torrent"}'
  [ "$(jq -r .session.torrent.info_hash <<<"$BODY")" = "$low" ] || fail "the session plays [$(jq -r .session.torrent.info_hash <<<"$BODY")], not the candidate with Film.en.srt ($low; the better-seeded one is $hi)"
  [ "$(sub lang)" = en ] || fail "the preferred torrent's subtitle is [$(sub lang)]"
  ok "of two candidates, the one whose files hold Film.en.srt was tried first over the better-seeded one"
}

for s in "${WANTED[@]}"; do
  case "$s" in
    files) stage_files ;;
    replay) stage_replay ;;
    lone) stage_lone ;;
    ass) stage_ass ;;
    service) stage_service ;;
    byid) stage_byid ;;
    borrow) stage_borrow ;;
    quiet) stage_quiet ;;
    prefer) stage_prefer ;;
    *) echo "subtitles: unknown stage $s" >&2; exit 2 ;;
  esac
done
echo "subtitles: PASS (${WANTED[*]})"
"$V" note "$RUN" "torrent subtitles PASS (${WANTED[*]})"
```
`ohash` prints `<hash> <size>`; the service stage reads both with `read -r want_hash want_size`.

## Principles applied

- Laziness protocol:
  - The borrow tier calls the existing `DirectStreamService.subtitleText` (the dialogue tool's out-of-sight resolve), with one optional `deadlineS`, and adds no second resolve path.
  - The route reuses `fileResponse`/`parseRange` from `cache/serve.ts`.
  - SubRip goes through the existing `srtToVtt`, and cue checks through `parseCues`.
  - The service's capped read reuses `cache/upstream.ts`'s `readBody` (now exported).
- Subtract before you add: the new address setting does not get its own parser. `parseAnimeMapUrl`, a single-use copy of the same rule, is deleted in favour of one `parseUrlOrOff`, which both settings use.
- Boundary discipline:
  - The service's JSON is read once in `parseServiceAnswer`: English only, an http(s) address, a plain id. The rest of the tier trusts `ServiceSubtitle`.
  - The route checks the hash and the file name against closed patterns before any path is joined, and `SubtitleShelf.file` is the only place a subtitle path is built.
- Make illegal states unrepresentable:
  - `subtitleUrl: null` removes the service tier from the chain in `buildSubtitleTiers`, so there is no tier that checks an "off" flag at run time.
  - A tier's "nothing here" is `[]` and its failure is a throw. The chain maps them to `no_stream` / `error`, and no status field can disagree with the list.
- Test behavior, not implementation: the tests assert the addresses asked, the user-agent, the files served and their text, the order of candidates and the attempts recorded. Only the network, the disk paths of the torrent and ffmpeg are faked.
- Prove it works: nine journeys drive a throwaway daemon with seeded fixture torrents and a fake subtitle service, and one drives the real player page. The OpenSubtitles hash is checked against an independent computation in the harness.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npx vitest run tests/unit/directStream/torrent/subtitles tests/unit/directStream/torrent/subtitleRoute.test.ts tests/unit/config.test.ts`, then `npm test` (it includes `tests/unit/docs/reference.test.ts`, which fails on an undocumented route or env var), and `npm run docs:check`
**Proof:** a throwaway daemon with torrents on, loopback-seeded fixture torrents, phase 3's fake index, this phase's fake subtitle service and the fake resolver. `V=.claude/skills/verify-notesd/scripts/verify.sh; $V up --web --direct-stream --torrent` (note `RUN`), then `S=.claude/skills/verify-notesd/scripts/torrent/subtitles.sh`.
- Harness: `.claude/skills/verify-notesd`
- Feature-map entries: `features/direct-streaming.md` (`## Torrent subtitles`)
- Journeys:
  - **J1** · traces R3.1 — `$S RUN files` → passes when:
    - the play answer's `session.subtitles[0]` is `/api/stream/torrent/<with-sub hash>/sub/file-<n>.vtt` with `lang: "en"`, `english: true`
    - `GET` of it is 200 and its body starts `WEBVTT` and holds `00:00:01.000 --> 00:00:30.000` and `Torrent subtitle line one`
    - `attempts` hold `Subtitles: files` = `resolved`
    - `$SUBS/requests.jsonl` gained no line
    - `<run>/data/movies/torrents/<hash>/.notesd-subs/chosen.json` exists
    - the Playwright step on `/stream/<id>?muted=1` finds `window.notesdStream.subtitle` non-null and `caption` containing `Torrent subtitle line one`
  - **J2** · traces R3.1 — `$S RUN replay` (after J1, same run) → passes when the second play of 467905 has `Subtitles: kept` = `resolved`, no `Subtitles: files` attempt, the same `file-<n>.vtt` address, and no new subtitle-service request
  - **J3** · traces R3.1 — `$S RUN lone` → passes when `session.subtitles` is exactly `[{lang: null, label: ""}]` (plus its url), its body holds `Lone subtitle line`, and the page step shows `Lone subtitle line` with the track on by default
  - **J4** · traces R3.1 — `$S RUN ass` → passes when the subtitle is labelled `English` and its body starts `WEBVTT`, holds a `-->` timing and `ASS subtitle line` (converted by the real ffmpeg)
  - **J5** · traces R3.3 — `$S RUN service` (`$SUBS/mode` = `ok`) → passes when:
    - `session.subtitles[0].url` is `/api/stream/torrent/<hash>/sub/service-9001.vtt`
    - `attempts` hold `Subtitles: files` = `no_stream` and `Subtitles: service` = `resolved`
    - the first new line of `$SUBS/requests.jsonl` has path `/subtitles/movie/tt<digits>/videoHash=<H>&videoSize=<N>.json`, where `<H> <N>` equal the harness's own OpenSubtitles hash and size of the fixture's `Film.mp4`, and a `user_agent` starting `notesd`
    - the served body holds `Service subtitle by hash`
    - the page step shows that line
  - **J6** · traces R3.3 — `$S RUN byid` (`$SUBS/mode` = `id_only`) → passes when the subtitle is `service-9002.vtt` labelled `English (matched by title)`, and the two new requests are `/subtitles/series/tt<digits>:1:1/videoHash=…` then `/subtitles/series/tt<digits>:1:1.json`
  - **J7** · traces R3.3 — `$S RUN borrow` (`$SUBS/mode` = `empty`, `$DIRECT/mode` = `hls`) → passes when:
    - the subtitle is `/api/stream/torrent/<hash>/sub/borrow.vtt` with a label starting `English (`
    - `attempts` hold `Subtitles: service` = `no_stream` and `Subtitles: borrow` = `resolved`
    - `$DIRECT/calls.jsonl` gained exactly one `resolve`
    - the body holds `00:00:01.000 --> 00:00:03.000` and `Hello.` (the fixture stream host's SRT)
    - the page step shows `Hello.`
  - **J8** · traces R3.3 — `$S RUN quiet` (`$SUBS/mode` = `error`, `$DIRECT/mode` = `no_chrome`) → passes when the play still answers 200 with a `manifest_url`, `session.subtitles` is `[]`, and `attempts` hold `Subtitles: service` = `error` and `Subtitles: borrow` = `error`
  - **J9** · traces R3.2 — `$S RUN prefer` → passes when, with `bare-hi` listed at 900 seeds and `with-sub-low` at 100, `session.torrent.info_hash` is `with-sub-low`'s hash and `session.subtitles[0].lang` is `en`
- Neighbor check: a cloud session's `.srt` through the pass-through is untouched by the `subtitleText` and `readBody` edits. `.claude/skills/verify-notesd/scripts/direct-stream/journey.sh RUN seed hls` on a `$V up --direct-stream` run ends `journey: PASS (seed hls)`, and `npx vitest run tests/unit/directStream/dialogue.test.ts tests/unit/directStream/cache` passes.
- Cost: none. No paid drive; the subtitle service, the resolver and the stream host are fakes.

**Exit criteria:** `npm run typecheck`, `npm test` and `npm run docs:check` pass. `subtitles.sh RUN` ends `subtitles: PASS (files replay lone ass service byid borrow quiet prefer)`. The evidence folder holds `torrent-subtitle-requests.jsonl`, the play answers, the served files and the page screenshots.

## Handoffs

- **Phase 3 (`source.ts`, `chain.ts`, `daemon.ts`), reconciled.** This phase edits phase 3's files only at marked places:
  - `chain.ts`: four `SubtitleTierDeps` fields and the four tiers at the `// Phase 6` comments. The context, the runner (non-empty stop rule, `Subtitles: <tier>` attempts, the 40 s budget) are phase 3's.
  - `source.ts`: the `orderByFileLists` call at the `// Phase 6 (R3.2)` line of `resolve`.
  - `daemon.ts`: four fields in phase 3's `buildSubtitleTiers({...})` object.
- **Phase 1.**
  - Downloads live under `<config.torrent.dir>/<infoHash>/`, and clearing a download removes that folder, so `.notesd-subs/` goes with it.
  - `TorrentHandle.read`'s `end` is inclusive. If it is exclusive, `service.ts`'s `collect` call passes `end + 1`.
  - `open` is idempotent per hash; `release` of an unused or unknown hash is a no-op.
  - `view(hash)` exposes `host` and `available`.
  - `streamTorrentRoutes` and `TORRENT_OFF` are exported from `src/http/streamTorrentApi.ts`.
  - The `--torrent` mode of `verify.sh` defines `$torrent` and the `$dir/torrent` folder, and its seeder seeds folders put in `$TORRENT/seed/<name>/` and writes `$TORRENT/seeded/<name>.json` with `info_hash`. If phase 1 ships another interface, only `seed()` in `subtitles.sh` changes.
- **Phase 3's harness.** The fake index answers `$TORRENT/candidates.json` (`[{info_hash, name, seeds, size_bytes}]`). The fake TMDB answers `external_ids.imdb_id` for 467905, 990001 to 990004 and 247718 (episodes S01E01 to S01E03 must exist). If the names differ, only `candidates()` in `subtitles.sh` changes.
- **Phase 7** inserts `embeddedTier` into `buildSubtitleTiers` at the `// Phase 7` comment, between `files` and `service`. Its tier must answer only English tracks (or throw), so the non-empty stop rule holds. `chosen.json` is written only by this phase's tiers. A growing embedded track is not kept, so a replay runs `files` and then phase 7's tier again.
- **Phase 8** adds `whisperTier` at the `// Phase 8` comment, last, and sets `whisperCovers: deps.whisper !== null` on this phase's `borrowTier(...)` line (the borrow is skipped for an English original when Whisper is on).
- **Phase 4 / web.** Nothing is needed: `SessionInfo.subtitles` already carries `english`, and `pickDefaultSubtitle` turns on English or a lone unnamed track. A borrowed or title-matched subtitle can be off by a few hundred milliseconds; G/H covers it (documented in Step 12).
- **Not done, deliberately:**
  - No new setting for the borrow deadline (a constant, `BORROW_DEADLINE_S`).
  - No `ffmpeg` path setting of its own: `src/daemon.ts` passes phase 3's `config.torrent.ffmpegBin` to `ffmpegAssConverter`.

## Rollback

Revert this phase's merge. What it leaves on disk is harmless: `.notesd-subs/` folders inside torrent downloads, which phase 1's clearing removes. With the revert, the chain goes back to phase 3's empty list, and a torrent session plays without a subtitle. To turn the service off without a revert: `NOTESD_TORRENT_SUBTITLE_URL=off`.
