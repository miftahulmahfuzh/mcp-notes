> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/torrent-stream-source/PLAN.md` phase 5. Source: `.workflows/plan/torrent-stream-source/phase-5.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 5: The remux for files Chrome cannot play

**Plan set:** `TORRENT_STREAM_SOURCE_PLAN.md`
**Analysis:** `.workflows/analyze/20261116-192341-T7QK_code_analyzer.md`
**Satisfies:** R2 — a torrent whose file is an MKV, or carries AC3/E-AC3/DTS sound or HEVC video, still streams in the player page
**Criteria:** R2.8
**Depends on:** Phase 3 (and through it phases 1 and 2)
**Difficulty:** HARD
**Package:** `src/directStream/torrent`

---

## Goal

After this phase a torrent file that phase 3's probe marks not `direct` is no longer skipped as `unplayable` when
ffmpeg can make it playable: one ffmpeg per file reads it through the daemon's own file route (or from disk once
whole), copies the video, converts the original-language audio to AAC stereo and writes an HLS EVENT playlist of fMP4
segments under the torrent folder, which grows while the file downloads and is closed with `EXT-X-ENDLIST` only when
ffmpeg has read the whole file cleanly. The session plays it with `manifest_kind: "hls"`; the page starts at the resume
position or 0 (never a live edge), shows the whole film's length, waits at a seek past what is remuxed, and a finished
remux replays from disk with no ffmpeg.

## What was run before planning (ffmpeg 6.1.1 at `/usr/bin/ffmpeg`, hls.js 1.7.4)

All in `/tmp/claude-1000/-home-miftah-mcp-notes/1d47aea4-2db1-4561-92cf-f680a6f26fd5/scratchpad/remux/`
(`slow-server.mjs`: serves a file with `Range`, bytes "arriving" at a set rate, a read past them blocks, like phase
1's route; `hlscheck.mjs`: hls.js in Playwright's Chromium against a growing playlist).

1. Fixture: `ffmpeg -f lavfi -i testsrc2=size=640x360:rate=24 -f lavfi -i sine=440 -f lavfi -i sine=660 -t 120 -map 0:v
   -map 1:a -map 2:a -c:v libx264 -g 48 -c:a ac3 -ac 6 -metadata:s:a:0 language=spa -metadata:s:a:1 language=eng
   film.mkv` (16.4 MB; h264 + two ac3 5.1 tracks).
2. Remux from the slow HTTP input (600 kB/s) with exactly the arguments of `remuxArgs` below: segments appeared as
   data arrived (2, 8, 13, 17, 20 `EXTINF` at 3, 8, 15, 25, 35 s), header `#EXT-X-VERSION:7`,
   `#EXT-X-PLAYLIST-TYPE:EVENT`, `#EXT-X-MAP:URI="init.mp4"`, `#EXT-X-ENDLIST` only at the end, exit 0, **one**
   HTTP request (`bytes=0-`: the MKV demuxer does not jump to the cues). Output: `h264 avc1` + `aac mp4a 2ch`, the
   audio tagged `language=eng` (the `0:a:1` track), segments continuous (`seg-00005` starts at 30.008 s).
3. HEVC + E-AC3 MKV, `-c:v copy -tag:v hvc1`: exit 0, `hevc hvc1` + `aac`. AV1 (libsvtav1) and VP9 (libvpx-vp9) MKVs
   with Opus: exit 0, `av01` / `vp09` + `aac`. MPEG-2 also "succeeds" into fMP4 (Chrome cannot decode it), so the
   decision is an allow-list of video codecs, not ffmpeg's exit code.
4. **The input dying mid-remux** (server killed after 8 s): without `-xerror` ffmpeg logs `Stream ends prematurely`
   / `Error during demuxing` and still **exits 0 and writes `#EXT-X-ENDLIST`**. With `-xerror` it exits 251 — but
   still writes `#EXT-X-ENDLIST`. Hence: done = exit 0 under `-xerror`, recorded in `done.json`, and the file route
   strips `EXT-X-ENDLIST` from any playlist without `done.json`.
5. `-reconnect 1 -reconnect_on_network_error 1 -reconnect_delay_max 30 -rw_timeout 120000000`: server killed at 4 s
   and restarted 2 s later: ffmpeg logged `Will reconnect at 5235600`, re-requested `bytes=5235600-`, finished all 20
   segments, exit 0.
6. hls.js on the growing playlist, `startPosition: 0`, `attachMedia({ media, overrides: { duration: 120 } })`: plays
   from 0, `video.duration` 120 while 1 segment exists, audio decodes (`webkitAudioDecodedByteCount` > 0). **A seek to
   100 s while 18 s were remuxed was pulled back to ~12 s** by hls.js's live-edge sync (`StreamController.
   synchronizeToLiveEdge` → `hls.liveSyncPosition`). Re-run with `latencyController: undefined` added (no latency
   controller → `liveSyncPosition` null): the seek **held at 100 s** and played on from 100 s once the remux reached it
   (`t: 101.9` at 22 s), no fatal error. That config line is what `hlsEngine.ts` adds for a growing remux.

## Interface Contract

**Deletes:** the blanket `unplayable` refusal for every non-`direct` file in phase 3's `refusalOf`
(`src/directStream/torrent/source.ts`): it stays only for a file the remux cannot help (video not H.264/HEVC/AV1/VP9)
or when the remux is off. Nothing else.
**Renames:** none.
**Creates:**
- `src/directStream/torrent/remux.ts`: `TorrentRemux` (`start(req, { timeoutMs? })`, `resume(infoHash, fileIndex)`,
  `release(infoHash, fileIndex)`, `map(infoHash)`, `file(infoHash, fileIndex, name, range)`, `close()`),
  `buildTorrentRemux(torrentConfig)`, `ffmpegSpawner(bin)`, `remuxArgs(...)`, `canRemux(probe)`,
  `pickAudioStream(audio, audioLang)`, `remuxDir(dir, hash, index)`, `remuxPlaylistUrl(hash, index, durationS)`,
  `openPlaylist(text)`, `playlistSeconds(text)`, `RemuxError` (`remux_unsupported | remux_failed | remux_timeout`),
  types `RemuxProbe`, `RemuxRequest`, `RemuxPlay`, `RemuxMap`, `FfmpegProcess`, `SpawnFfmpeg`, `TorrentRemuxOptions`,
  constants `REMUX_VIDEO_CODECS`, `REMUX_SEGMENT_S` (6), `REMUX_FIRST_SEGMENT_TIMEOUT_MS` (60 000), `REMUX_POLL_MS`,
  `REMUX_KILL_GRACE_MS`, `REMUX_PLAYLIST`, `REMUX_DONE_FILE`, `REMUX_FILE_NAME`.
- `src/http/streamTorrentRemuxApi.ts`: `streamTorrentRemuxRoutes(deps)`; route
  `GET /api/stream/torrent/:hash/hls/:index/:name`.
- `src/config.ts`: `TorrentConfig.remux` (`NOTESD_TORRENT_REMUX`, default on). It reads phase 3's
  `TorrentConfig.ffmpegBin` (`NOTESD_FFMPEG_BIN`).
- `src/deps.ts`: `AppDeps.torrentRemux?: TorrentRemux | null`.
- `web/src/stream/hlsEngine.ts`: `growingPlaylist(src)`, `GrowingPlaylist`.
- The manifest address contract: a remux session's `manifest_url` is
  `/api/stream/torrent/<hash>/hls/<index>/index.m3u8?remux=1[&total_s=<film seconds>]`; the page reads `remux=1`
  and `total_s` from it.
- verify-notesd: `scripts/stream/make-mkv-fixture.sh`, `scripts/torrent/offer-remux.sh` (seeds the MKV through phase
  1's `<run>/torrent/seed/remux/` folder and lists it in phase 3's `<run>/torrent/candidates.json`),
  `scripts/stream/torrent-remux.steps.mjs`.

**Signature changes:**
- Phase 3's `TorrentSourceOptions` gains `remux?: TorrentRemux | null`; `buildTorrentSource(config, torrents, wiring)`'s
  `wiring` gains `remux?: TorrentRemux | null`.
- Phase 3's private `refusalOf(probe, audioLang)` → `refusalOf(probe, audioLang, remux)`.
- Phase 1's map route `GET /api/stream/torrent/:hash/map` answers the remux's map first when there is one.

**Requires (from earlier phases):**
- Phase 3 exactly as planned in `phase-3.md` Step 3: `TorrentSource` with `tryOne`, `fromDisk`, `hold`, `release`,
  `refusalOf`, `standIn` (reads `torrent.manifestUrl` / `manifestKind`), `SessionTorrent` with `infoHash`, `fileIndex`,
  `manifestUrl`, `manifestKind: 'mp4' | 'hls'`, `durationS`, `held`, `candidate`; `MediaProbe` with
  `video: { codec, height } | null`, `audio: Array<{ codec, lang }>` **in stream order** (so `audio[n]` is ffmpeg's
  `0:a:n`), `durationS`, `direct`; `describeProbe`, `normalizeAudioLang`, `TorrentSwarm.filePath` / `localUrl`,
  `opts.localBase()`; `buildTorrentSource` in `src/daemon.ts` (phase 3 Step 11).
- Phase 3's `sessionInfo` answers `manifest_url` / `manifest_kind` from `session.torrent` (phase 3's `const local =
  torrent ?? cache`), so an `hls` torrent reaches the page unchanged.
- Phase 1: `TorrentConfig` (`enabled`, `dir` = `NOTESD_TORRENT_DIR`, default `<dataDir>/movies/torrents`),
  `DEFAULT_TORRENT_CONFIG`, `parseTorrent(env, ...)`; each torrent's files under `<dir>/<infoHash>/`; `AppDeps.torrents`
  built in `src/daemon.ts` (null when off) and closed in `src/background.ts`'s close list; `src/http/streamTorrentApi.ts`
  with a `GET /api/stream/torrent/:hash/map` handler that has the lower-cased hash in hand; `TorrentStreams.view(hash)`
  answering an object with `available: false` and `host` for a download of the other machine (read defensively).
- Phase 1 + 3 harness: `verify.sh up --torrent` seeds a folder moved into `<run>/torrent/seed/<name>/` and writes
  `<run>/torrent/seeded/<name>.json` (`fixture.json` shape); phase 3's fake index answers every query from
  `<run>/torrent/candidates.json` when it exists (`[{info_hash, name, seeds?, size_bytes?}]`, the release named
  `<Title>.<Year>.<name>`).

**Leaves alone (owned by others):** `web/src/stream/StreamApp.tsx`, `controller.ts`, `nativeEngine.ts`, `session.ts`,
`stream.css` (phase 4); `web/src/stream/subtitles.ts` and every subtitle tier, `subtitles/*` (phases 6-8); the engine,
store, file route `/f/:index` and the `stream_torrents` table (phase 1); `find/` (phase 2); `probe.ts`, `sessions.ts`,
`service.ts` (phase 3: no line of `service.ts` changes here).

## Files

| File | Action | What changes |
|---|---|---|
| phase 1's `TorrentConfig` / `DEFAULT_TORRENT_CONFIG` / `parseTorrent` in `src/config.ts` | modify | `remux` (after phase 3's `ffmpegBin`) |
| `src/directStream/torrent/remux.ts` | create | the remuxer |
| `src/directStream/torrent/source.ts` (phase 3's file) | modify | `refusalOf`, new `fileForPage`, `tryOne`, `fromDisk`, `hold`, `release`, options, `buildTorrentSource` |
| `src/http/streamTorrentRemuxApi.ts` | create | the remux file route |
| `src/http/streamTorrentApi.ts` (phase 1's file, its map handler) | modify | the remux's map first |
| `src/http/app.ts:12,149` | modify | import and mount `streamTorrentRemuxRoutes` |
| `src/deps.ts:68` | modify | `AppDeps.torrentRemux` |
| `src/daemon.ts` (phase 3's Step 11 lines, phase 1's `torrents` build, the `deps` literal `:236-250`) | modify | build `torrentRemux`, hand it to the torrent source and `deps` |
| `src/background.ts:208-221` | modify | close the remux |
| `web/src/stream/hlsEngine.ts:20-33,86-87` | modify | growing remux: start position, no latency controller, film duration |
| `web/src/stream/hlsEngine.test.tsx` | modify | fake records `attachMedia`; four cases |
| `tests/unit/directStream/remuxFakes.ts` | create | fake ffmpeg shared by the remux tests |
| `tests/unit/directStream/torrentRemux.test.ts` | create | `TorrentRemux` with the fake ffmpeg |
| `tests/unit/directStream/torrentRemux.ffmpeg.test.ts` | create | the real ffmpeg on a generated MKV (H.264 + AC3) |
| `tests/unit/directStream/torrentRemuxRoute.test.ts` | create | the file route |
| `tests/unit/directStream/torrentRemuxSource.test.ts` | create | `TorrentSource` with the remux |
| `tests/unit/config.test.ts` | modify | the two settings |
| `scripts/docs/httpRoutes.ts` (the group phase 1 puts its torrent routes in) | modify | the new route; the map route's sentence |
| `docs/guide/reference/http-api.md` | regenerate | `npm run docs:gen` |
| `docs/guide/reference/configuration.md` (phase 1's torrent table) | modify | `NOTESD_TORRENT_REMUX` |
| `docs/guide/streaming.md` (after phase 3's "Playing from a torrent"; "Where the code is" `:1106-1135`) | modify | subsection "The remux for files Chrome cannot play"; one table row |
| `.claude/skills/verify-notesd/scripts/verify.sh` (phase 1/3's `--torrent` env block) | modify | `NOTESD_TORRENT_REMUX` |
| `.claude/skills/verify-notesd/scripts/stream/make-mkv-fixture.sh` | create | the MKV fixture |
| `.claude/skills/verify-notesd/scripts/torrent/offer-remux.sh` | create | seeds the MKV through phase 1's seed folder and lists it in phase 3's `candidates.json` |
| `.claude/skills/verify-notesd/scripts/stream/torrent-remux.steps.mjs` | create | J1-J5 in the real page |
| `.claude/skills/verify-notesd/features/direct-streaming.md:325` | modify | section "Torrent remux" before `## Gotchas` |

## Implementation Steps

Order: Step 1 (config) and Step 2 (the remuxer and its fake-ffmpeg tests) each end in a passing test file; Step 3 is
the real-ffmpeg test; Steps 4-6 wire it in (route, source, daemon) and end in `npm run typecheck` + the route and
source tests; Step 7 is the page; Steps 8-9 docs and harness. `npm run typecheck` passes after every step.

### Step 1: The remux setting
`NOTESD_FFMPEG_BIN` / `config.torrent.ffmpegBin` / `DEFAULT_FFMPEG_BIN` are phase 3's (reconciled: one owner for the
ffmpeg and ffprobe the torrent source runs); this phase only reads `config.torrent.ffmpegBin`.

**File:** `src/config.ts`, phase 1's `TorrentConfig` interface: add, after phase 3's `ffmpegBin` field
```ts
  /**
   * `NOTESD_TORRENT_REMUX`, default on: a torrent file Chrome cannot play as is (MKV, AC3/E-AC3/DTS sound, HEVC)
   * plays as an ffmpeg remux (src/directStream/torrent/remux.ts). `off`: such a file is `unplayable` and the next
   * torrent is tried.
   */
  remux: boolean
```
**File:** `src/config.ts`, phase 1's `DEFAULT_TORRENT_CONFIG`: add `remux: false,` (tests stay off) after phase 3's
`ffmpegBin` line.
**File:** `src/config.ts`, phase 1's `parseTorrent` return object: add, after phase 3's `ffmpegBin` line,
```ts
    remux: parseSwitch('NOTESD_TORRENT_REMUX', env.NOTESD_TORRENT_REMUX),
```
(`parseSwitch` `:529` treats unset as on.)

**Test:** `tests/unit/config.test.ts` — add `DEFAULT_TORRENT_CONFIG` to the import list and append:
```ts
describe('torrent remux settings (torrent phase 5)', () => {
  it('turns the remux on by default', () => {
    const torrent = loadConfig({ env: { DATABASE_URL: URL_A }, envFile: false }).torrent
    expect(torrent?.remux).toBe(true)
  })

  it('NOTESD_TORRENT_REMUX=off turns it off', () => {
    const torrent = loadConfig({ env: { DATABASE_URL: URL_A, NOTESD_TORRENT_REMUX: 'off' }, envFile: false }).torrent
    expect(torrent?.remux).toBe(false)
  })

  it('refuses a NOTESD_TORRENT_REMUX that is neither on nor off', () => {
    expect(() => loadConfig({ env: { DATABASE_URL: URL_A, NOTESD_TORRENT_REMUX: 'maybe' }, envFile: false })).toThrow(ConfigError)
  })

  it('leaves the remux off in DEFAULT_TORRENT_CONFIG, as everything torrent is in tests', () => {
    expect(DEFAULT_TORRENT_CONFIG.remux).toBe(false)
  })
})
```
If phase 1's tests compare the whole parsed `torrent` object with `toEqual`, add `remux: true` to their expected
objects.
**Impact:** one new setting; nothing reads it until Step 6. Check: `npx vitest run tests/unit/config.test.ts`.

### Step 2: The remuxer
**File:** `src/directStream/torrent/remux.ts` (new)
```ts
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TorrentConfig } from '../../config.js';
import { contentTypeOf, fileResponse } from '../cache/serve.js';

/**
 * The remux of a torrent file Chrome cannot play as is (torrent phase 5, R2.8): an MKV, AC3/E-AC3/DTS sound, HEVC.
 * One ffmpeg per file reads it (through this daemon's own file route while it downloads, so a read waits for its
 * pieces and the download follows ffmpeg from the start of the film; from disk once whole), copies the video,
 * converts the audio track in the title's original language to AAC stereo, and writes an HLS playlist of fMP4
 * segments in `<torrent dir>/<info hash>/notesd-remux/<file index>/`. The playlist is an EVENT one: it grows a segment
 * at a time and is served with EXT-X-ENDLIST only once ffmpeg has read the whole file and exited cleanly
 * (`done.json`). A finished remux is kept beside the download and plays again from disk with no ffmpeg.
 */

/** Video ffmpeg copies into an fMP4 segment and Chrome decodes (HEVC where the machine's Chrome does). MPEG-2, VC-1, MPEG-4 Part 2 are not. */
export const REMUX_VIDEO_CODECS: ReadonlySet<string> = new Set(['h264', 'hevc', 'av1', 'vp9']);
/** ffmpeg cuts at the first keyframe after this many seconds. */
export const REMUX_SEGMENT_S = 6;
/** A play waits this long at most for the first segment (the probe already read the header, so the data flows). */
export const REMUX_FIRST_SEGMENT_TIMEOUT_MS = 60_000;
export const REMUX_POLL_MS = 500;
/** SIGTERM, then SIGKILL after this long. */
export const REMUX_KILL_GRACE_MS = 5_000;
export const REMUX_PLAYLIST = 'index.m3u8';
/** Written once ffmpeg exited 0 under -xerror: the remux is whole. */
export const REMUX_DONE_FILE = 'done.json';
/** The only names the file route serves. */
export const REMUX_FILE_NAME = /^(?:index\.m3u8|init\.mp4|seg-\d{5}\.m4s)$/;
const STDERR_TAIL_CHARS = 2_000;

export type RemuxErrorCode = 'remux_unsupported' | 'remux_failed' | 'remux_timeout';

export class RemuxError extends Error {
  override name = 'RemuxError';

  constructor(
    readonly code: RemuxErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** What the remux reads of phase 3's MediaProbe (MediaProbe fits it). `audio` is in stream order: `audio[n]` is ffmpeg's `0:a:n`. */
export interface RemuxProbe {
  video: { codec: string } | null;
  audio: readonly { lang: string | null }[];
  durationS: number | null;
}

export interface RemuxRequest {
  /** Lower-case hex. */
  infoHash: string;
  fileIndex: number;
  /** The file's absolute path once it is whole on disk, else the absolute address of its file route on this daemon. */
  input: string;
  probe: RemuxProbe;
  /** The title's original language (TMDB's ISO 639-1), or null. */
  audioLang: string | null;
}

export interface RemuxPlay {
  /** `/api/stream/torrent/<hash>/hls/<index>/index.m3u8?remux=1&total_s=<film seconds>`. */
  manifestUrl: string;
  durationS: number | null;
}

/** The shape of the cache's and phase 1's map: the stretches of the film the page can play, in seconds. */
export interface RemuxMap {
  duration_s: number | null;
  ranges: [number, number][];
}

/** One ffmpeg run. */
export interface FfmpegProcess {
  /** Its exit code once it has exited (null after a signal, -1 when it could not start). */
  readonly exited: Promise<number | null>;
  /** The last of what it wrote to stderr. */
  stderrTail(): string;
  /** SIGTERM, then SIGKILL after REMUX_KILL_GRACE_MS. Safe to call twice or after the exit. */
  kill(): void;
}

export type SpawnFfmpeg = (args: readonly string[]) => FfmpegProcess;

const round1 = (n: number): number => Math.round(n * 10) / 10;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function remuxDir(torrentDir: string, infoHash: string, fileIndex: number): string {
  return path.join(torrentDir, infoHash, 'notesd-remux', String(fileIndex));
}

/** The playlist's address as a session hands it to the page: `remux=1` marks a growing remux, `total_s` the film's length. */
export function remuxPlaylistUrl(infoHash: string, fileIndex: number, durationS: number | null): string {
  const total = durationS !== null && durationS > 0 ? `&total_s=${round1(durationS)}` : '';
  return `/api/stream/torrent/${infoHash}/hls/${fileIndex}/${REMUX_PLAYLIST}?remux=1${total}`;
}

/** Whether a remux can make the file playable: its video is one Chrome decodes from an fMP4 segment. Any audio ffmpeg reads becomes AAC. */
export function canRemux(probe: RemuxProbe): boolean {
  return probe.video !== null && REMUX_VIDEO_CODECS.has(probe.video.codec.toLowerCase());
}

/** "eng", "en-US", "en" → "en" (ISO 639-2 and BCP 47 tags through Intl); a tag Intl rejects as it is, lower-cased. */
function languageOf(tag: string): string {
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  try {
    return Intl.getCanonicalLocales(primary)[0]?.split('-')[0] ?? primary;
  } catch {
    return primary;
  }
}

/** The audio stream to keep, as an index among the audio streams: the first in the original language, else the first. Null: no audio. */
export function pickAudioStream(audio: RemuxProbe['audio'], audioLang: string | null): number | null {
  if (audio.length === 0) return null;
  if (audioLang !== null) {
    const want = languageOf(audioLang);
    const at = audio.findIndex((a) => a.lang !== null && languageOf(a.lang) === want);
    if (at !== -1) return at;
  }
  return 0;
}

/**
 * ffmpeg's arguments, checked on ffmpeg 6.1.1 (see the phase plan): `-xerror` makes a read error a non-zero exit
 * (without it ffmpeg exits 0 on a dead input); the reconnect options carry on at the same byte when the file route
 * drops a connection; the HLS muxer writes an EVENT playlist of fMP4 segments, renaming each file into place.
 */
export function remuxArgs(o: { input: string; dir: string; videoCodec: string; audioStream: number | null }): string[] {
  const overHttp = /^https?:\/\//.test(o.input);
  return [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror',
    ...(overHttp ? ['-reconnect', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '30', '-rw_timeout', '120000000'] : []),
    '-i', o.input,
    '-map', '0:v:0',
    ...(o.audioStream === null ? ['-an'] : ['-map', `0:a:${o.audioStream}`]),
    '-sn', '-dn',
    '-c:v', 'copy',
    ...(o.videoCodec === 'hevc' ? ['-tag:v', 'hvc1'] : []),
    ...(o.audioStream === null ? [] : ['-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', '192k']),
    // A copied video stream with a converted audio stream can queue many packets before the first audio frame.
    '-max_muxing_queue_size', '4096',
    '-f', 'hls',
    '-hls_time', String(REMUX_SEGMENT_S),
    '-hls_playlist_type', 'event',
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', path.join(o.dir, 'seg-%05d.m4s'),
    '-hls_flags', 'independent_segments+temp_file',
    path.join(o.dir, REMUX_PLAYLIST),
  ];
}

/** The playlist without EXT-X-ENDLIST: ffmpeg writes it on any exit, a failed one too. */
export function openPlaylist(text: string): string {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '#EXT-X-ENDLIST')
    .join('\n');
}

/** The seconds a playlist's segments add up to. */
export function playlistSeconds(text: string): number {
  let total = 0;
  for (const line of text.split('\n')) {
    const m = /^#EXTINF:([\d.]+)/.exec(line.trim());
    if (m !== null) total += Number(m[1]);
  }
  return total;
}

/** The real ffmpeg. stderr is kept (its tail goes into the log and an attempt's detail); stdout is ignored. */
export function ffmpegSpawner(bin: string): SpawnFfmpeg {
  return (args) => {
    const child = spawn(bin, [...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let tail = '';
    const keep = (text: string): void => {
      tail = (tail + text).slice(-STDERR_TAIL_CHARS);
    };
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', keep);
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const exited = new Promise<number | null>((resolve) => {
      child.once('error', (err) => {
        keep(`\n${err.message}`);
        resolve(-1);
      });
      child.once('close', (code) => resolve(code));
    }).finally(() => {
      if (killTimer !== null) clearTimeout(killTimer);
    });
    return {
      exited,
      stderrTail: () => tail.trim(),
      kill() {
        if (child.exitCode !== null || child.signalCode !== null || killTimer !== null) return;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), REMUX_KILL_GRACE_MS);
        killTimer.unref();
      },
    };
  };
}

type RunState = 'running' | 'done' | 'failed' | 'stopped';

interface Run {
  key: string;
  infoHash: string;
  fileIndex: number;
  dir: string;
  durationS: number | null;
  state: RunState;
  /** Sessions playing it: start() adds one, release() takes one; at none a running ffmpeg is stopped. */
  users: number;
  process: FfmpegProcess | null;
  firstSegment: Promise<void>;
}

export interface TorrentRemuxOptions {
  /** `config.torrent.dir`. */
  dir: string;
  spawn: SpawnFfmpeg;
  firstSegmentTimeoutMs?: number;
  pollMs?: number;
  log?: (line: string) => void;
}

export class TorrentRemux {
  private readonly runs = new Map<string, Run>();
  /** The file a torrent's map answers for: the one started last. */
  private readonly latest = new Map<string, string>();
  /** What each file was started with, so a session that takes its torrent again starts the same remux. */
  private readonly requests = new Map<string, RemuxRequest>();
  private readonly log: (line: string) => void;

  constructor(private readonly opts: TorrentRemuxOptions) {
    this.log = opts.log ?? ((line: string) => console.log(line));
  }

  /**
   * The remux of one file for one more session: answered once its first segment is on disk (at once for a finished
   * one, kept from before). Two plays of one file share one ffmpeg. A remux stopped, failed or cut off by a restart
   * starts over from the start of the file. Throws RemuxError: `remux_unsupported` (nothing ran), `remux_failed`
   * (ffmpeg ended before a segment), `remux_timeout` (no segment in time; ffmpeg is stopped).
   */
  async start(req: RemuxRequest, options: { timeoutMs?: number } = {}): Promise<RemuxPlay> {
    if (!canRemux(req.probe)) {
      throw new RemuxError('remux_unsupported', `Chrome does not decode ${req.probe.video?.codec ?? 'a file without'} video, so a remux would not help`);
    }
    const key = `${req.infoHash}:${req.fileIndex}`;
    const label = `${req.infoHash} file ${req.fileIndex}`;
    const play: RemuxPlay = { manifestUrl: remuxPlaylistUrl(req.infoHash, req.fileIndex, req.probe.durationS), durationS: req.probe.durationS };
    this.requests.set(key, req);
    const known = this.runs.get(key);
    if (known !== undefined && (known.state === 'running' || known.state === 'done')) {
      await known.firstSegment;
      known.users += 1;
      this.latest.set(req.infoHash, key);
      if (known.state === 'done') this.log(`[notesd] torrent remux: ${label} plays from disk`);
      return play;
    }
    const dir = remuxDir(this.opts.dir, req.infoHash, req.fileIndex);
    if (existsSync(path.join(dir, REMUX_DONE_FILE))) {
      this.runs.set(key, { key, infoHash: req.infoHash, fileIndex: req.fileIndex, dir, durationS: req.probe.durationS, state: 'done', users: 1, process: null, firstSegment: Promise.resolve() });
      this.latest.set(req.infoHash, key);
      this.log(`[notesd] torrent remux: ${label} plays from disk`);
      return play;
    }
    const run: Run = { key, infoHash: req.infoHash, fileIndex: req.fileIndex, dir, durationS: req.probe.durationS, state: 'running', users: 0, process: null, firstSegment: Promise.resolve() };
    run.firstSegment = this.begin(run, req, options.timeoutMs ?? this.opts.firstSegmentTimeoutMs ?? REMUX_FIRST_SEGMENT_TIMEOUT_MS);
    this.runs.set(key, run);
    try {
      await run.firstSegment;
    } catch (err) {
      if (this.runs.get(key) === run) this.runs.delete(key);
      this.log(`[notesd] torrent remux: ${label} did not start: ${messageOf(err)}`);
      throw err;
    }
    run.users += 1;
    this.latest.set(req.infoHash, key);
    this.log(`[notesd] torrent remux: ${label} started (${req.probe.video?.codec ?? ''} copied, audio to AAC)`);
    return play;
  }

  /** start() again with what the file was last started with (a session that took its torrent again). No-op for a file never started. */
  async resume(infoHash: string, fileIndex: number): Promise<void> {
    const req = this.requests.get(`${infoHash}:${fileIndex}`);
    if (req !== undefined) await this.start(req);
  }

  /** One session fewer on the file; with none left a running ffmpeg is stopped (its half-made remux starts over next time). */
  release(infoHash: string, fileIndex: number): void {
    const key = `${infoHash}:${fileIndex}`;
    const run = this.runs.get(key);
    if (run === undefined || run.users === 0) return;
    run.users -= 1;
    if (run.users > 0 || run.state !== 'running') return;
    run.state = 'stopped';
    run.process?.kill();
    this.runs.delete(key);
    if (this.latest.get(infoHash) === key) this.latest.delete(infoHash);
    this.log(`[notesd] torrent remux: ${infoHash} file ${fileIndex} stopped: no session plays it`);
  }

  /** What of the film the remux holds (from 0 to where it is), or null when this torrent has no remux here. */
  async map(infoHash: string): Promise<RemuxMap | null> {
    const key = this.latest.get(infoHash);
    const run = key === undefined ? undefined : this.runs.get(key);
    if (run === undefined) return null;
    const covered = round1(await this.seconds(run.dir));
    return { duration_s: run.durationS === null ? (covered > 0 ? covered : null) : round1(run.durationS), ranges: covered > 0 ? [[0, covered]] : [] };
  }

  /**
   * One file of a remux from disk, or null when there is no such file. The playlist is never cached and carries
   * EXT-X-ENDLIST only once `done.json` is there; segments and the init section are served with `Range`. `name`
   * must already match REMUX_FILE_NAME (the route checks it).
   */
  async file(infoHash: string, fileIndex: number, name: string, rangeHeader: string | null): Promise<Response | null> {
    const dir = remuxDir(this.opts.dir, infoHash, fileIndex);
    const file = path.join(dir, name);
    if (name === REMUX_PLAYLIST) {
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        return null;
      }
      const whole = existsSync(path.join(dir, REMUX_DONE_FILE));
      return new Response(whole ? text : openPlaylist(text), { status: 200, headers: { 'content-type': contentTypeOf(name), 'cache-control': 'no-store' } });
    }
    try {
      return await fileResponse(file, name, rangeHeader);
    } catch {
      return null;
    }
  }

  /** Stops every running ffmpeg (the daemon closes). Bounded by REMUX_KILL_GRACE_MS. */
  async close(): Promise<void> {
    const procs: FfmpegProcess[] = [];
    for (const run of this.runs.values()) {
      if (run.state !== 'running') continue;
      run.state = 'stopped';
      if (run.process !== null) {
        procs.push(run.process);
        run.process.kill();
      }
    }
    await Promise.all(procs.map((p) => p.exited));
    this.runs.clear();
    this.latest.clear();
  }

  private async seconds(dir: string): Promise<number> {
    try {
      return playlistSeconds(await readFile(path.join(dir, REMUX_PLAYLIST), 'utf8'));
    } catch {
      return 0;
    }
  }

  /** Empties the folder, starts ffmpeg, and resolves once the playlist names a segment. */
  private async begin(run: Run, req: RemuxRequest, timeoutMs: number): Promise<void> {
    await rm(run.dir, { recursive: true, force: true });
    await mkdir(run.dir, { recursive: true });
    if (run.state !== 'running') throw new RemuxError('remux_failed', 'the daemon closed before ffmpeg started');
    const proc = this.opts.spawn(
      remuxArgs({ input: req.input, dir: run.dir, videoCodec: (req.probe.video?.codec ?? '').toLowerCase(), audioStream: pickAudioStream(req.probe.audio, req.audioLang) }),
    );
    run.process = proc;
    let exitCode: number | null | undefined;
    const ended = (): boolean => exitCode !== undefined;
    void proc.exited.then((code) => {
      exitCode = code;
      return this.finish(run, proc, code);
    });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await this.seconds(run.dir)) > 0) return;
      if (ended()) throw new RemuxError('remux_failed', proc.stderrTail().slice(-300) || `ffmpeg ended (exit ${String(exitCode)}) before writing a segment`);
      if (Date.now() >= deadline) {
        run.state = 'stopped';
        proc.kill();
        throw new RemuxError('remux_timeout', `ffmpeg wrote no segment in ${Math.round(timeoutMs / 1000)} s`);
      }
      await sleep(this.opts.pollMs ?? REMUX_POLL_MS);
    }
  }

  private async finish(run: Run, proc: FfmpegProcess, code: number | null): Promise<void> {
    if (run.process === proc) run.process = null;
    if (run.state !== 'running') return;
    const label = `${run.infoHash} file ${run.fileIndex}`;
    const covered = await this.seconds(run.dir);
    if (code !== 0 || covered === 0) {
      run.state = 'failed';
      this.log(`[notesd] torrent remux: ${label} failed (exit ${String(code)}) after ${round1(covered)} s: ${proc.stderrTail().slice(-300)}`);
      return;
    }
    try {
      await writeFile(path.join(run.dir, REMUX_DONE_FILE), `${JSON.stringify({ duration_s: round1(covered), at: new Date().toISOString() })}\n`);
    } catch (err) {
      this.log(`[notesd] torrent remux: ${label} is whole but ${REMUX_DONE_FILE} could not be written: ${messageOf(err)}`);
    }
    run.state = 'done';
    this.log(`[notesd] torrent remux: ${label} done (${round1(covered)} s)`);
  }
}

/** The daemon's remuxer, or null when torrents or the remux are off. Building it starts nothing. */
export function buildTorrentRemux(torrent: Pick<TorrentConfig, 'enabled' | 'remux' | 'dir' | 'ffmpegBin'> | null | undefined): TorrentRemux | null {
  if (torrent === null || torrent === undefined || !torrent.enabled || !torrent.remux) return null;
  return new TorrentRemux({ dir: torrent.dir, spawn: ffmpegSpawner(torrent.ffmpegBin) });
}
```
**Impact:** new module, no caller yet. `phase 3`'s `normalizeAudioLang` is not reused here on purpose: it needs a
`MediaProbe` import and maps names ("English"); the remux compares only ffprobe's tags against TMDB's ISO 639-1
code, which `Intl.getCanonicalLocales` does (`eng`→`en`, `fre`/`fra`→`fr`, `ger`→`de`, `chi`→`zh`, all checked).
If the reconciler prefers one helper, `pickAudioStream` may call `normalizeAudioLang` instead with the same tests.

**File:** `tests/unit/directStream/remuxFakes.ts` (new)
```ts
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FfmpegProcess, SpawnFfmpeg } from '../../../src/directStream/torrent/remux.js';

/** The playlist ffmpeg's HLS muxer writes after `n` segments of 6 s; `end` adds the EXT-X-ENDLIST it writes on any exit. */
export function eventPlaylist(n: number, end = false): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-MAP:URI="init.mp4"'];
  for (let i = 0; i < n; i++) lines.push('#EXTINF:6.000000,', `seg-${String(i).padStart(5, '0')}.m4s`);
  if (end) lines.push('#EXT-X-ENDLIST');
  return `${lines.join('\n')}\n`;
}

export interface FakeFfmpegRun {
  args: string[];
  dir: string;
  killed: boolean;
  /** ffmpeg has written `n` segments (and with `end`, closed the playlist as it does on exit). */
  write(n: number, end?: boolean): Promise<void>;
  exit(code: number | null): void;
}

/** A stand-in for ffmpeg: it records each run's arguments and writes what a test tells it to into the run's folder. */
export function fakeFfmpeg(options: { segmentsAtStart?: number; exitAtStart?: number } = {}): { spawn: SpawnFfmpeg; runs: FakeFfmpegRun[] } {
  const runs: FakeFfmpegRun[] = [];
  const spawn: SpawnFfmpeg = (args) => {
    let settle: (code: number | null) => void = () => undefined;
    const exited = new Promise<number | null>((resolve) => {
      settle = resolve;
    });
    const out = args[args.length - 1] ?? '';
    const run: FakeFfmpegRun = {
      args: [...args],
      dir: path.dirname(out),
      killed: false,
      async write(n, end = false) {
        await writeFile(path.join(run.dir, 'init.mp4'), 'init');
        for (let i = 0; i < n; i++) await writeFile(path.join(run.dir, `seg-${String(i).padStart(5, '0')}.m4s`), `segment ${i} `.repeat(20));
        await writeFile(out, eventPlaylist(n, end));
      },
      exit: (code) => settle(code),
    };
    runs.push(run);
    if (options.segmentsAtStart !== undefined) void run.write(options.segmentsAtStart);
    if (options.exitAtStart !== undefined) settle(options.exitAtStart);
    const proc: FfmpegProcess = {
      exited,
      stderrTail: () => 'Invalid data found when processing input',
      kill: () => {
        run.killed = true;
        settle(255);
      },
    };
    return proc;
  };
  return { spawn, runs };
}
```

**Test:** `tests/unit/directStream/torrentRemux.test.ts` (new)
```ts
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canRemux,
  pickAudioStream,
  REMUX_DONE_FILE,
  remuxArgs,
  remuxDir,
  RemuxError,
  TorrentRemux,
  type RemuxProbe,
  type RemuxRequest,
  type SpawnFfmpeg,
} from '../../../src/directStream/torrent/remux.js';
import { eventPlaylist, fakeFfmpeg } from './remuxFakes.js';

const HASH = 'b'.repeat(40);
const MKV: RemuxProbe = { video: { codec: 'h264' }, audio: [{ lang: 'spa' }, { lang: 'eng' }], durationS: 5400.46 };
const URL3 = `/api/stream/torrent/${HASH}/hls/3/index.m3u8?remux=1&total_s=5400.5`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'notesd-remux-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const request = (over: Partial<RemuxRequest> = {}): RemuxRequest => ({ infoHash: HASH, fileIndex: 3, input: `http://127.0.0.1:7317/api/stream/torrent/${HASH}/f/3`, probe: MKV, audioLang: 'en', ...over });
const remuxWith = (spawn: SpawnFfmpeg, over: { firstSegmentTimeoutMs?: number } = {}) => new TorrentRemux({ dir, spawn, pollMs: 5, log: () => undefined, ...over });
const text = async (res: Response | null): Promise<string> => (res === null ? 'null' : res.text());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('which files the remux can help, and with what', () => {
  it('helps H.264, HEVC, AV1 and VP9 video; not MPEG-2, VC-1, MPEG-4 Part 2 or a file without video', () => {
    for (const codec of ['h264', 'hevc', 'av1', 'vp9', 'HEVC']) expect(canRemux({ ...MKV, video: { codec } })).toBe(true);
    for (const codec of ['mpeg2video', 'vc1', 'mpeg4']) expect(canRemux({ ...MKV, video: { codec } })).toBe(false);
    expect(canRemux({ ...MKV, video: null })).toBe(false);
  });

  it("keeps the audio in the title's original language, else the first, and none when the file has no audio", () => {
    expect(pickAudioStream([{ lang: 'spa' }, { lang: 'eng' }], 'en')).toBe(1);
    expect(pickAudioStream([{ lang: 'jpn' }, { lang: 'eng' }], 'ja')).toBe(0);
    expect(pickAudioStream([{ lang: 'fre' }, { lang: 'ger' }], 'de')).toBe(1);
    expect(pickAudioStream([{ lang: null }, { lang: 'eng' }], 'ko')).toBe(0);
    expect(pickAudioStream([{ lang: 'eng' }], null)).toBe(0);
    expect(pickAudioStream([], 'en')).toBeNull();
  });

  it('copies the video (hvc1 for HEVC), converts the chosen audio to AAC stereo, and writes an EVENT playlist of fMP4 segments', () => {
    const args = remuxArgs({ input: 'http://127.0.0.1:1/f/0', dir: '/d', videoCodec: 'hevc', audioStream: 1 });
    const has = (...seq: string[]) => args.join('\u0000').includes(seq.join('\u0000'));
    expect(has('-xerror')).toBe(true);
    expect(has('-reconnect', '1')).toBe(true);
    expect(has('-map', '0:v:0', '-map', '0:a:1')).toBe(true);
    expect(has('-c:v', 'copy', '-tag:v', 'hvc1')).toBe(true);
    expect(has('-c:a', 'aac', '-ac', '2')).toBe(true);
    expect(has('-hls_playlist_type', 'event', '-hls_segment_type', 'fmp4')).toBe(true);
    expect(args.at(-1)).toBe('/d/index.m3u8');
    const plain = remuxArgs({ input: '/data/film.mkv', dir: '/d', videoCodec: 'h264', audioStream: null });
    expect(plain).toContain('-an');
    expect(plain).not.toContain('-reconnect');
    expect(plain).not.toContain('-tag:v');
    expect(plain).not.toContain('-c:a');
  });
});

describe('TorrentRemux', () => {
  it("answers the playlist's address once the first segment is written, with the film's length on it", async () => {
    const f = fakeFfmpeg();
    const started = remuxWith(f.spawn).start(request());
    await vi.waitFor(() => expect(f.runs).toHaveLength(1));
    let answered = false;
    void started.then(() => {
      answered = true;
    });
    await sleep(30);
    expect(answered).toBe(false);
    await f.runs[0]!.write(1);
    await expect(started).resolves.toEqual({ manifestUrl: URL3, durationS: 5400.46 });
    expect(f.runs[0]!.args).toContain(request().input);
    expect(f.runs[0]!.dir).toBe(remuxDir(dir, HASH, 3));
  });

  it('serves a growing playlist without EXT-X-ENDLIST, and closes it only after a clean exit', async () => {
    const f = fakeFfmpeg({ segmentsAtStart: 1 });
    const remux = remuxWith(f.spawn);
    await remux.start(request());
    // ffmpeg writes EXT-X-ENDLIST as it exits; until it has exited 0 the page must not read the film as ended.
    await f.runs[0]!.write(2, true);
    expect(await text(await remux.file(HASH, 3, 'index.m3u8', null))).not.toContain('#EXT-X-ENDLIST');
    expect(await remux.map(HASH)).toEqual({ duration_s: 5400.5, ranges: [[0, 12]] });
    f.runs[0]!.exit(0);
    await vi.waitFor(() => expect(existsSync(path.join(remuxDir(dir, HASH, 3), REMUX_DONE_FILE))).toBe(true));
    const done = await remux.file(HASH, 3, 'index.m3u8', null);
    expect(done?.headers.get('cache-control')).toBe('no-store');
    expect(done?.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    expect((await text(done)).trimEnd().endsWith('#EXT-X-ENDLIST')).toBe(true);
  });

  it('never closes the playlist of a run ffmpeg ended with an error (a dead input)', async () => {
    const f = fakeFfmpeg({ segmentsAtStart: 1 });
    const remux = remuxWith(f.spawn);
    await remux.start(request());
    await f.runs[0]!.write(2, true);
    f.runs[0]!.exit(251);
    await sleep(30);
    expect(existsSync(path.join(remuxDir(dir, HASH, 3), REMUX_DONE_FILE))).toBe(false);
    expect(await text(await remux.file(HASH, 3, 'index.m3u8', null))).not.toContain('#EXT-X-ENDLIST');
  });

  it('plays a finished remux again from disk with no ffmpeg, after a restart too', async () => {
    const f = fakeFfmpeg({ segmentsAtStart: 2 });
    const first = remuxWith(f.spawn);
    await first.start(request());
    f.runs[0]!.exit(0);
    await vi.waitFor(() => expect(existsSync(path.join(remuxDir(dir, HASH, 3), REMUX_DONE_FILE))).toBe(true));
    await expect(first.start(request())).resolves.toEqual({ manifestUrl: URL3, durationS: 5400.46 });
    const restarted = remuxWith(() => {
      throw new Error('ffmpeg must not run for a finished remux');
    });
    await expect(restarted.start(request())).resolves.toEqual({ manifestUrl: URL3, durationS: 5400.46 });
    expect(f.runs).toHaveLength(1);
    expect(await restarted.map(HASH)).toEqual({ duration_s: 5400.5, ranges: [[0, 12]] });
  });

  it('fails the start with ffmpeg\'s last words when it ends before a segment', async () => {
    const f = fakeFfmpeg({ exitAtStart: 1 });
    const err = await remuxWith(f.spawn).start(request()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemuxError);
    expect((err as RemuxError).code).toBe('remux_failed');
    expect((err as RemuxError).message).toContain('Invalid data found');
  });

  it('stops ffmpeg and fails with remux_timeout when no segment comes in time', async () => {
    const f = fakeFfmpeg();
    const err = await remuxWith(f.spawn, { firstSegmentTimeoutMs: 40 }).start(request()).catch((e: unknown) => e);
    expect((err as RemuxError).code).toBe('remux_timeout');
    expect(f.runs[0]!.killed).toBe(true);
  });

  it('refuses a file whose video Chrome cannot decode before ffmpeg runs', async () => {
    const f = fakeFfmpeg();
    const err = await remuxWith(f.spawn).start(request({ probe: { ...MKV, video: { codec: 'mpeg2video' } } })).catch((e: unknown) => e);
    expect((err as RemuxError).code).toBe('remux_unsupported');
    expect(f.runs).toHaveLength(0);
  });

  it('shares one ffmpeg between two plays of a file and stops it when the last one lets go; the next play starts over', async () => {
    const f = fakeFfmpeg({ segmentsAtStart: 1 });
    const remux = remuxWith(f.spawn);
    await Promise.all([remux.start(request()), remux.start(request())]);
    expect(f.runs).toHaveLength(1);
    remux.release(HASH, 3);
    expect(f.runs[0]!.killed).toBe(false);
    remux.release(HASH, 3);
    expect(f.runs[0]!.killed).toBe(true);
    expect(await remux.map(HASH)).toBeNull();
    await remux.resume(HASH, 3);
    expect(f.runs).toHaveLength(2);
    await vi.waitFor(async () => expect((await readdir(remuxDir(dir, HASH, 3))).sort()).toEqual(['index.m3u8', 'init.mp4', 'seg-00000.m4s']));
  });

  it('serves a segment with Range and answers null for a file that is not there', async () => {
    const f = fakeFfmpeg({ segmentsAtStart: 1 });
    const remux = remuxWith(f.spawn);
    await remux.start(request());
    const part = await remux.file(HASH, 3, 'seg-00000.m4s', 'bytes=0-9');
    expect(part?.status).toBe(206);
    expect((await part!.arrayBuffer()).byteLength).toBe(10);
    expect(await remux.file(HASH, 3, 'seg-00009.m4s', null)).toBeNull();
    expect(await remux.file(HASH, 4, 'index.m3u8', null)).toBeNull();
  });

  it('close stops every running ffmpeg', async () => {
    const f = fakeFfmpeg({ segmentsAtStart: 1 });
    const remux = remuxWith(f.spawn);
    await remux.start(request());
    await remux.close();
    expect(f.runs[0]!.killed).toBe(true);
  });

  it('keeps a stale half-made remux from an earlier run out of the new one', async () => {
    const stale = remuxDir(dir, HASH, 3);
    await mkdir(stale, { recursive: true });
    await writeFile(path.join(stale, 'index.m3u8'), eventPlaylist(9, true));
    await writeFile(path.join(stale, 'seg-00008.m4s'), 'old');
    const f = fakeFfmpeg();
    const started = remuxWith(f.spawn).start(request());
    await vi.waitFor(() => expect(f.runs).toHaveLength(1));
    expect(existsSync(path.join(stale, 'seg-00008.m4s'))).toBe(false);
    await f.runs[0]!.write(1);
    await started;
  });
});
```
**Impact:** none outside the new module. Check: `npx vitest run tests/unit/directStream/torrentRemux.test.ts`.

### Step 3: The real ffmpeg on a generated MKV
**File:** `tests/unit/directStream/torrentRemux.ffmpeg.test.ts` (new). It is skipped only when `ffmpeg`/`ffprobe` are
missing (they are installed on both laptops); it takes about 5 s.
```ts
import { spawnSync } from 'node:child_process';
import { existsSync, openSync, readSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ffmpegSpawner, REMUX_DONE_FILE, remuxDir, TorrentRemux } from '../../../src/directStream/torrent/remux.js';

const HASH = 'c'.repeat(40);
const present = (bin: string): boolean => spawnSync(bin, ['-version']).status === 0;
const hasFfmpeg = present('ffmpeg') && present('ffprobe');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Serves `file` with Range as phase 1's file route does while a torrent downloads: bytes arrive at `rate` a second, and a read past them waits. */
async function trickle(file: string, rate: number): Promise<{ server: Server; url: string }> {
  const size = statSync(file).size;
  const fd = openSync(file, 'r');
  const t0 = Date.now();
  const arrived = (): number => Math.min(size, Math.floor(((Date.now() - t0) / 1000) * rate));
  const server = createServer((req, res) => {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    const start = m === null ? 0 : Number(m[1]);
    const end = m === null || m[2] === '' ? size - 1 : Number(m[2]);
    res.writeHead(m === null ? 200 : 206, { 'accept-ranges': 'bytes', 'content-length': String(end - start + 1), ...(m === null ? {} : { 'content-range': `bytes ${start}-${end}/${size}` }) });
    let at = start;
    let closed = false;
    res.on('close', () => {
      closed = true;
    });
    void (async () => {
      while (at <= end && !closed) {
        const have = Math.min(end + 1, arrived());
        if (have <= at) {
          await sleep(50);
          continue;
        }
        const buf = Buffer.alloc(Math.min(have - at, 64 * 1024));
        readSync(fd, buf, 0, buf.length, at);
        at += buf.length;
        if (!res.write(buf)) await new Promise((r) => res.once('drain', r));
      }
      res.end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/stream/torrent/${HASH}/f/0` };
}

describe.skipIf(!hasFfmpeg)('the remux with the real ffmpeg (torrent phase 5)', () => {
  let work: string;
  let served: { server: Server; url: string };

  beforeAll(async () => {
    work = await mkdtemp(path.join(tmpdir(), 'notesd-remux-real-'));
    const film = path.join(work, 'film.mkv');
    const made = spawnSync('ffmpeg', [
      '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000',
      '-t', '24', '-map', '0:v', '-map', '1:a', '-map', '2:a',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '48',
      '-c:a', 'ac3', '-b:a', '192k', '-ac', '6',
      '-metadata:s:a:0', 'language=spa', '-metadata:s:a:1', 'language=eng',
      film,
    ]);
    expect(made.status).toBe(0);
    // About four seconds for the whole file: the first segment comes well before the end.
    served = await trickle(film, Math.ceil(statSync(film).size / 4));
  }, 60_000);

  afterAll(async () => {
    served?.server.close();
    await rm(work, { recursive: true, force: true });
  });

  it('remuxes an MKV with H.264 and two AC3 tracks into a growing EVENT playlist of H.264 and English AAC stereo, closed once the file is read', async () => {
    const torrents = path.join(work, 'torrents');
    const remux = new TorrentRemux({ dir: torrents, spawn: ffmpegSpawner('ffmpeg'), pollMs: 100, log: () => undefined });
    const probe = { video: { codec: 'h264' }, audio: [{ lang: 'spa' }, { lang: 'eng' }], durationS: 24 };
    const play = await remux.start({ infoHash: HASH, fileIndex: 0, input: served.url, probe, audioLang: 'en' });
    expect(play.manifestUrl).toBe(`/api/stream/torrent/${HASH}/hls/0/index.m3u8?remux=1&total_s=24`);

    const early = await (await remux.file(HASH, 0, 'index.m3u8', null))!.text();
    expect(early).toContain('#EXT-X-PLAYLIST-TYPE:EVENT');
    expect(early).toContain('#EXT-X-MAP:URI="init.mp4"');
    expect(early).not.toContain('#EXT-X-ENDLIST');
    const earlyMap = await remux.map(HASH);
    expect(earlyMap?.ranges[0]?.[1]).toBeLessThan(20);

    const dir = remuxDir(torrents, HASH, 0);
    await vi.waitFor(() => expect(existsSync(path.join(dir, REMUX_DONE_FILE))).toBe(true), { timeout: 30_000, interval: 200 });
    const final = await (await remux.file(HASH, 0, 'index.m3u8', null))!.text();
    expect(final.trimEnd().endsWith('#EXT-X-ENDLIST')).toBe(true);
    expect((await remux.map(HASH))?.ranges).toEqual([[0, expect.closeTo(24, 0)]]);

    const probed = JSON.parse(
      spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,channels:stream_tags=language', '-of', 'json', path.join(dir, 'index.m3u8')], { encoding: 'utf8' }).stdout,
    ) as { streams: Array<{ codec_type: string; codec_name: string; channels?: number; tags?: { language?: string } }> };
    expect(probed.streams.map((s) => [s.codec_type, s.codec_name])).toEqual([
      ['video', 'h264'],
      ['audio', 'aac'],
    ]);
    const audio = probed.streams.find((s) => s.codec_type === 'audio');
    expect(audio?.channels).toBe(2);
    expect(audio?.tags?.language).toBe('eng');
    await remux.close();
  }, 60_000);
});
```
**Impact:** none. Check: `npx vitest run tests/unit/directStream/torrentRemux.ffmpeg.test.ts` reports 1 passed (not
skipped).

### Step 4: The file route, the map, the mount, the deps field
**File:** `src/http/streamTorrentRemuxApi.ts` (new)
```ts
import { Hono } from 'hono';
import { REMUX_FILE_NAME, type TorrentRemux } from '../directStream/torrent/remux.js';

/**
 * The files of a torrent remux (torrent phase 5): `GET /api/stream/torrent/:hash/hls/:index/:name`, what hls.js
 * loads for a torrent file Chrome cannot play as is. The hash, the file index and the name are checked here once;
 * TorrentRemux trusts them. Not same-origin only: like the cache's file route it starts nothing.
 */

const INFO_HASH = /^[0-9a-f]{40}$/;
const FILE_INDEX = /^\d{1,5}$/;

/** What the route reads of phase 1's TorrentStreams: whether a torrent is the other machine's. */
interface TorrentViews {
  view(infoHash: string): unknown;
}

/** The other machine's name when phase 1's view says the download is there, else null. */
function otherHost(view: unknown): string | null {
  if (typeof view !== 'object' || view === null) return null;
  const v = view as { available?: unknown; host?: unknown };
  return v.available === false && typeof v.host === 'string' ? v.host : null;
}

export function streamTorrentRemuxRoutes(deps: { torrentRemux?: TorrentRemux | null; torrents?: TorrentViews | null }): Hono {
  const r = new Hono();
  r.get('/api/stream/torrent/:hash/hls/:index/:name', async (c) => {
    const torrents = deps.torrents ?? null;
    if (torrents === null) return c.json({ error: 'torrent_off', message: 'Torrents are off on this machine (NOTESD_TORRENT=off).' }, 503);
    const remux = deps.torrentRemux ?? null;
    if (remux === null) return c.json({ error: 'remux_off', message: 'The remux is off on this machine (NOTESD_TORRENT_REMUX=off).' }, 404);
    const hash = c.req.param('hash').toLowerCase();
    const index = c.req.param('index');
    const name = c.req.param('name');
    if (!INFO_HASH.test(hash) || !FILE_INDEX.test(index) || !REMUX_FILE_NAME.test(name)) {
      return c.json({ error: 'not_found', message: 'No such remux file.' }, 404);
    }
    const answer = await remux.file(hash, Number(index), name, c.req.header('range') ?? null);
    if (answer !== null) return answer;
    const host = otherHost(await Promise.resolve(torrents.view(hash)));
    if (host !== null) return c.json({ error: 'not_on_this_machine', message: `This torrent was downloaded on ${host}.`, host }, 404);
    return c.json({ error: 'not_found', message: 'This machine has no remux of that file.' }, 404);
  });
  return r;
}
```
**File:** `src/http/streamTorrentApi.ts` (phase 1's file), first lines of the `GET /api/stream/torrent/:hash/map`
handler, right after it has the lower-cased hash (call it `hash` there) and before it maps bytes to seconds:
```ts
    // Torrent phase 5: a remuxed file is played from its remux, so its stretches are what the remux holds.
    const remuxed = (await deps.torrentRemux?.map(hash)) ?? null;
    if (remuxed !== null) return c.json(remuxed);
```
(If phase 1's route takes `deps: AppDeps`, Step 4's `AppDeps.torrentRemux` is all it needs; if it takes a narrower
type, add `torrentRemux?: TorrentRemux | null` to it.)
**File:** `src/deps.ts:68` (after `streamCache?: StreamCache | null;`)
```ts
  /**
   * The remux of torrent files Chrome cannot play as is (torrent phase 5, src/directStream/torrent/remux.ts): its
   * file route is /api/stream/torrent/:hash/hls/:index/:name. Null or absent with torrents or NOTESD_TORRENT_REMUX
   * off. startBackground's close stops its ffmpeg runs.
   */
  torrentRemux?: TorrentRemux | null;
```
and with the other type imports at the top (`:13`):
```ts
import type { TorrentRemux } from './directStream/torrent/remux.js';
```
**File:** `src/http/app.ts:33` (after `import { streamReportRoutes } ...`)
```ts
import { streamTorrentRemuxRoutes } from './streamTorrentRemuxApi.js';
```
and `:149` (after `app.route('/', streamReportRoutes(deps));`, and after phase 1's torrent routes wherever they are mounted):
```ts
  app.route('/', streamTorrentRemuxRoutes(deps));
```
**Test:** `tests/unit/directStream/torrentRemuxRoute.test.ts` (new)
```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REMUX_DONE_FILE, remuxDir, TorrentRemux } from '../../../src/directStream/torrent/remux.js';
import { streamTorrentRemuxRoutes } from '../../../src/http/streamTorrentRemuxApi.js';
import { eventPlaylist } from './remuxFakes.js';

const HASH = 'a'.repeat(40);
const OTHER = 'd'.repeat(40);
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'notesd-remux-route-'));
  const files = remuxDir(dir, HASH, 2);
  await mkdir(files, { recursive: true });
  await writeFile(path.join(files, 'index.m3u8'), eventPlaylist(1, true));
  await writeFile(path.join(files, 'seg-00000.m4s'), Buffer.alloc(1000, 7));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const remux = () => new TorrentRemux({ dir, spawn: () => { throw new Error('no ffmpeg in a route test'); }, log: () => undefined });
const views = (view: unknown = null) => ({ view: () => view });
function app(deps: Parameters<typeof streamTorrentRemuxRoutes>[0]): Hono {
  const a = new Hono();
  a.route('/', streamTorrentRemuxRoutes(deps));
  return a;
}
const url = (name: string, hash = HASH, index = '2') => `/api/stream/torrent/${hash}/hls/${index}/${name}`;

describe('GET /api/stream/torrent/:hash/hls/:index/:name', () => {
  it('answers torrent_off without torrents, and remux_off with the remux off', async () => {
    const off = await app({ torrents: null, torrentRemux: remux() }).request(url('index.m3u8'));
    expect(off.status).toBe(503);
    expect(await off.json()).toMatchObject({ error: 'torrent_off' });
    const noRemux = await app({ torrents: views(), torrentRemux: null }).request(url('index.m3u8'));
    expect(noRemux.status).toBe(404);
    expect(await noRemux.json()).toMatchObject({ error: 'remux_off' });
  });

  it('serves a playlist that is still growing without EXT-X-ENDLIST, never cached, and a finished one whole', async () => {
    const a = app({ torrents: views(), torrentRemux: remux() });
    const growing = await a.request(`${url('index.m3u8')}?remux=1&total_s=120`);
    expect(growing.status).toBe(200);
    expect(growing.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    expect(growing.headers.get('cache-control')).toBe('no-store');
    expect(await growing.text()).not.toContain('#EXT-X-ENDLIST');
    await writeFile(path.join(remuxDir(dir, HASH, 2), REMUX_DONE_FILE), '{}');
    expect(await (await a.request(url('index.m3u8'))).text()).toContain('#EXT-X-ENDLIST');
  });

  it('serves a segment with Range', async () => {
    const res = await app({ torrents: views(), torrentRemux: remux() }).request(url('seg-00000.m4s'), { headers: { range: 'bytes=0-99' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-99/1000');
    expect((await res.arrayBuffer()).byteLength).toBe(100);
  });

  it('refuses a name, an index or a hash it does not serve', async () => {
    const a = app({ torrents: views(), torrentRemux: remux() });
    for (const target of [url('index.m3u8.tmp'), url('film.mkv'), url('index.m3u8', 'zz'), url('index.m3u8', HASH, 'x1')]) {
      const res = await a.request(target);
      expect(res.status, target).toBe(404);
      expect(await res.json()).toMatchObject({ error: 'not_found' });
    }
    // A name that climbs out of the folder never reaches the disk (Hono may not even route it: only the status is checked).
    const climb = await a.request(url('..%2F..%2F..%2Fdone.json'));
    expect(climb.status).toBe(404);
  });

  it("answers not_on_this_machine for the other machine's download", async () => {
    const res = await app({ torrents: views({ available: false, host: 'other-laptop' }), torrentRemux: remux() }).request(url('index.m3u8', OTHER));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_on_this_machine', host: 'other-laptop' });
  });
});
```
**Impact:** a new route, mounted; `AppDeps` gains an optional field. Check:
`npx vitest run tests/unit/directStream/torrentRemuxRoute.test.ts` and `npm run typecheck`. (`tests/unit/docs/reference.test.ts`
fails until Step 8 documents the route: do Step 8's `httpRoutes.ts` entry in the same commit as this step.)

### Step 5: The torrent source plays a remux instead of refusing the file
**File:** `src/directStream/torrent/source.ts` (phase 3's file). Five edits; everything else stays as phase 3 wrote it.

(a) Imports (after phase 3's `import { runSubtitleChain, type SubtitleTier } from './subtitles/chain.js';`):
```ts
import { canRemux, type TorrentRemux } from './remux.js';
```
(b) `TorrentSourceOptions`: add after `tiers`:
```ts
  /** The remux for a file Chrome cannot play as is (torrent phase 5); null or unset: such a file is `unplayable`. */
  remux?: TorrentRemux | null;
```
(c) Replace phase 3's whole `refusalOf` function:
```ts
/**
 * Why a probed file is not played, or null when it plays: a dub first (original language only), then a file Chrome
 * cannot play that the remux cannot help either (the remux off, or video Chrome cannot decode).
 */
function refusalOf(probe: MediaProbe, audioLang: string | null, remux: TorrentRemux | null): { outcome: ResolveOutcome; detail: string } | null {
  const languages = audioLanguages(probe);
  if (audioLang !== null && languages.length > 0 && !languages.includes(audioLang)) {
    return { outcome: 'dubbed', detail: `its audio is ${languages.join(', ')}, not the original ${audioLang}` };
  }
  if (probe.direct) return null;
  if (remux === null) return { outcome: 'unplayable', detail: `${describeProbe(probe)}: Chrome does not play it as is` };
  if (!canRemux(probe)) return { outcome: 'unplayable', detail: `${describeProbe(probe)}: Chrome does not play it as is, and a remux cannot make its video playable` };
  return null;
}
```
(The remux-off detail is phase 3's text unchanged, so phase 3's `torrentSource.test.ts` case "answers unplayable for a
file Chrome cannot play" still passes: its `setup` passes no `remux`.)

(d) In `class TorrentSource`, a new private method (place it right after `state(...)`):
```ts
  /**
   * The address the page plays the file from: its file route when Chrome plays it as is, else the remux playlist
   * (torrent phase 5), answered once the remux's first segment is on disk. ffmpeg reads the file from disk once it is
   * whole, else through the file route. Throws RemuxError.
   */
  private async fileForPage(
    infoHash: string,
    fileIndex: number,
    probe: MediaProbe,
    audioLang: string | null,
    timeoutMs?: number,
  ): Promise<{ manifestUrl: string; manifestKind: 'mp4' | 'hls' }> {
    const fileUrl = this.opts.swarm.localUrl(infoHash, fileIndex);
    const remux = this.opts.remux ?? null;
    if (probe.direct || remux === null) return { manifestUrl: fileUrl, manifestKind: 'mp4' };
    const input = (await this.opts.swarm.filePath(infoHash, fileIndex)) ?? `${this.opts.localBase()}${fileUrl}`;
    const play = await remux.start({ infoHash, fileIndex, input, probe, audioLang }, timeoutMs === undefined ? {} : { timeoutMs });
    return { manifestUrl: play.manifestUrl, manifestKind: 'hls' };
  }
```
(e) The three call sites.

In `fromDisk`, replace from `const refusal = refusalOf(probe, options.audioLang);` down to the `const torrent:
SessionTorrent = {` object's `manifestKind: 'mp4',` line with:
```ts
    const refusal = refusalOf(probe, options.audioLang, this.opts.remux ?? null);
    if (refusal !== null) {
      this.log(`[notesd] torrent: the download ${download.infoHash} of ${refLabel(ref)} is not played again (${refusal.outcome}: ${refusal.detail})`);
      return null;
    }
    let page: { manifestUrl: string; manifestKind: 'mp4' | 'hls' };
    try {
      page = await this.fileForPage(download.infoHash, download.fileIndex, probe, options.audioLang);
    } catch (err) {
      this.log(`[notesd] torrent: the download ${download.infoHash} of ${refLabel(ref)} could not be remuxed: ${messageOf(err)}`);
      return null;
    }
    this.noteDuration(download.infoHash, probe);
    const stop = new AbortController();
    const chain = await runSubtitleChain(
      this.opts.tiers,
      {
        ref,
        imdbId: null,
        infoHash: download.infoHash,
        release: download.release ?? download.name,
        files: [],
        fileIndex: download.fileIndex,
        subtitleIndexes: [],
        handle: null,
        probe,
        audioLang: options.audioLang,
        resumeS: options.resumeS ?? null,
        cloudTried: false,
        localBase: this.opts.localBase(),
        signal: stop.signal,
      },
      { log: this.log },
    );
    const torrent: SessionTorrent = {
      infoHash: download.infoHash,
      fileIndex: download.fileIndex,
      selected: [download.fileIndex],
      name: download.name,
      index: null,
      seeds: null,
      state: 'ready',
      height: probe.video?.height ?? null,
      manifestUrl: page.manifestUrl,
      manifestKind: page.manifestKind,
```
(the rest of the object, `subtitles: chain.subtitles,` to `stop,`, and the `return` stay). Phase 3's
`const manifestUrl = this.opts.swarm.localUrl(...)` line above it stays: the probe still reads the file route.

In `tryOne`, replace
```ts
      const refusal = refusalOf(probe, audioLang);
      if (refusal !== null) return fail(refusal.outcome, refusal.detail);
```
with
```ts
      const refusal = refusalOf(probe, audioLang, this.opts.remux ?? null);
      if (refusal !== null) return fail(refusal.outcome, refusal.detail);
      let page: { manifestUrl: string; manifestKind: 'mp4' | 'hls' };
      try {
        page = await this.fileForPage(c.infoHash, picked.video, probe, audioLang, Math.max(PROBE_MIN_MS, budgetMs - (this.now() - started)));
      } catch (err) {
        return fail('unplayable', `${describeProbe(probe)}: the remux did not start (${messageOf(err)})`);
      }
```
and in the same method's `const torrent: SessionTorrent = {` replace the two lines `manifestUrl,` and
`manifestKind: 'mp4',` with
```ts
        manifestUrl: page.manifestUrl,
        manifestKind: page.manifestKind,
```
and the `attempt('resolved', ...)` detail with
```ts
      return {
        ok: true,
        torrent,
        source: standIn(torrent, probe, audioLang, tookS),
        attempt: attempt('resolved', `${describeProbe(probe)}${page.manifestKind === 'hls' ? ', remuxed' : ''}, ${c.seeds} seeds`),
        subtitleAttempts: chain.attempts,
      };
```

`hold` — append as its last line (after `torrent.held = true;`):
```ts
    // A remux stopped with the release starts again (torrent phase 5); its playlist keeps its address.
    if (torrent.manifestKind === 'hls') await this.opts.remux?.resume(torrent.infoHash, torrent.fileIndex);
```
`release` — between `torrent.held = false;` and `this.letGo(torrent.infoHash);`:
```ts
    if (torrent.manifestKind === 'hls') this.opts.remux?.release(torrent.infoHash, torrent.fileIndex);
```
`buildTorrentSource` — the `wiring` parameter type gains
```ts
    /** The remux of files Chrome cannot play as is (torrent phase 5); null or unset: such a file is `unplayable`. */
    remux?: TorrentRemux | null;
```
and the options object gains, after `tiers: wiring.tiers ?? [],`:
```ts
    remux: wiring.remux ?? null,
```
**Impact:** a non-`direct` file with H.264/HEVC/AV1/VP9 video now plays as `manifest_kind: "hls"` from the remux;
`standIn` already copies `torrent.manifestKind`/`manifestUrl` into the session's source. A replay from disk
(`candidate: null`, never held) is never released, so its remux, read from disk, runs to the end and is kept.
A remux that does not start is `unplayable` with the reason, and phase 3's `fail` releases the torrent as before.

**Test:** `tests/unit/directStream/torrentRemuxSource.test.ts` (new)
```ts
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamRef } from '../../../src/directStream/types.js';
import { parseRelease, type TorrentCandidate } from '../../../src/directStream/torrent/find/index.js';
import type { MediaProbe } from '../../../src/directStream/torrent/probe.js';
import { REMUX_DONE_FILE, remuxDir, TorrentRemux } from '../../../src/directStream/torrent/remux.js';
import { TorrentSource, type DownloadOnDisk, type FindAnswer, type TorrentSwarm } from '../../../src/directStream/torrent/source.js';
import { eventPlaylist, fakeFfmpeg } from './remuxFakes.js';

const FILM: StreamRef = { kind: 'movie', tmdbId: 467905 };
const BASE = 'http://127.0.0.1:4321';
const h = (n: number): string => n.toString(16).padStart(40, '0');
const candidate = (infoHash: string, name: string): TorrentCandidate => ({
  infoHash,
  name,
  fileName: null,
  fileIdx: null,
  seeds: 40,
  sizeBytes: 700_000_000,
  index: 'torrentio',
  listedBy: ['torrentio'],
  site: null,
  trackers: ['http://127.0.0.1:1/announce'],
  scoped: false,
  release: parseRelease(name),
});
const MKV_AC3: MediaProbe = { container: 'matroska,webm', video: { codec: 'h264', height: 1080 }, audio: [{ codec: 'ac3', lang: 'spa' }, { codec: 'ac3', lang: 'eng' }], subtitles: [], durationS: 120, direct: false };
const MPEG2: MediaProbe = { ...MKV_AC3, video: { codec: 'mpeg2video', height: 576 } };
const MP4: MediaProbe = { container: 'mov,mp4,m4a,3gp,3g2,mj2', video: { codec: 'h264', height: 720 }, audio: [{ codec: 'aac', lang: 'eng' }], subtitles: [], durationS: 120, direct: true };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'notesd-remux-source-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(o: { candidates: TorrentCandidate[]; probes: Record<string, MediaProbe>; ready?: string[]; disk?: DownloadOnDisk | null; ffmpeg?: ReturnType<typeof fakeFfmpeg> }) {
  const calls: string[] = [];
  const ffmpeg = o.ffmpeg ?? fakeFfmpeg({ segmentsAtStart: 1 });
  const remux = new TorrentRemux({ dir, spawn: ffmpeg.spawn, pollMs: 5, log: () => undefined });
  const swarm: TorrentSwarm = {
    open: async (pick) => {
      calls.push(`open ${pick.infoHash}`);
      return { infoHash: pick.infoHash, files: [{ index: 0, path: 'Film.2026.1080p.mkv', name: 'Film.2026.1080p.mkv', length: 700_000_000 }] };
    },
    use: (infoHash) => {
      calls.push(`use ${infoHash}`);
    },
    release: (infoHash) => {
      calls.push(`release ${infoHash}`);
    },
    find: async () => o.disk ?? null,
    filePath: (infoHash, index) => ((o.ready ?? []).includes(infoHash) ? `/data/torrents/${infoHash}/${index}.mkv` : null),
    localUrl: (infoHash, index) => `/api/stream/torrent/${infoHash}/f/${index}`,
    setDuration: () => undefined,
  };
  const answer: FindAnswer = { candidates: o.candidates, indexes: [{ index: 'torrentio', outcome: 'ok', detail: '', took_s: 0.1, listed: o.candidates.length }], excluded: [] };
  const source = new TorrentSource({
    swarm,
    find: async () => answer,
    probe: async (url) => o.probes[/\/torrent\/([0-9a-f]+)\//.exec(url)?.[1] ?? ''] ?? MP4,
    tiers: [],
    remux,
    localBase: () => BASE,
    log: () => undefined,
  });
  return { source, remux, ffmpeg, calls };
}

describe('TorrentSource with the remux (torrent phase 5, R2.8)', () => {
  it('plays an MKV with AC3 sound through the remux: an hls session on the remux playlist, ffmpeg reading the file route', async () => {
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.1080p.BluRay.x264.AC3-GRP')], probes: { [h(1)]: MKV_AC3 } });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const playlist = `/api/stream/torrent/${h(1)}/hls/0/index.m3u8?remux=1&total_s=120`;
    expect(out.torrent).toMatchObject({ manifestUrl: playlist, manifestKind: 'hls', durationS: 120 });
    expect(out.source).toMatchObject({ provider: 'Torrent', manifest_url: playlist, manifest_kind: 'hls' });
    expect(out.attempts.at(-1)).toMatchObject({ outcome: 'resolved', detail: 'matroska h264 1080p / ac3+ac3, remuxed, 40 seeds' });
    expect(t.ffmpeg.runs[0]?.args).toContain(`${BASE}/api/stream/torrent/${h(1)}/f/0`);
    expect(t.ffmpeg.runs[0]?.args).toContain('0:a:1');
  });

  it('has ffmpeg read the file from disk once the download is whole', async () => {
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.1080p.BluRay.x264.AC3-GRP')], probes: { [h(1)]: MKV_AC3 }, ready: [h(1)] });
    await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    expect(t.ffmpeg.runs[0]?.args).toContain(`/data/torrents/${h(1)}/0.mkv`);
  });

  it('leaves a file whose video Chrome cannot decode as unplayable without running ffmpeg, and plays the next', async () => {
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.DVD.MPEG2-A'), candidate(h(2), 'Film.2026.720p.WEB-DL.x264.AAC-B')], probes: { [h(1)]: MPEG2, [h(2)]: MP4 } });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    expect(out.ok && out.torrent.manifestKind).toBe('mp4');
    expect(out.attempts[1]).toMatchObject({ outcome: 'unplayable', detail: 'matroska mpeg2video 576p / ac3+ac3: Chrome does not play it as is, and a remux cannot make its video playable' });
    expect(t.ffmpeg.runs).toHaveLength(0);
  });

  it('makes a remux that does not start unplayable with its reason, releases that torrent and plays the next', async () => {
    const t = setup({
      candidates: [candidate(h(1), 'Film.2026.1080p.BluRay.x264.AC3-A'), candidate(h(2), 'Film.2026.720p.WEB-DL.x264.AAC-B')],
      probes: { [h(1)]: MKV_AC3, [h(2)]: MP4 },
      ffmpeg: fakeFfmpeg({ exitAtStart: 1 }),
    });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    expect(out.ok && out.torrent.infoHash).toBe(h(2));
    expect(out.attempts[1]?.outcome).toBe('unplayable');
    expect(out.attempts[1]?.detail).toContain('the remux did not start');
    await new Promise((r) => setTimeout(r, 0));
    expect(t.calls).toContain(`release ${h(1)}`);
  });

  it('stops the remux when the session lets go of its torrent, and starts it again when the session takes it back', async () => {
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.1080p.BluRay.x264.AC3-GRP')], probes: { [h(1)]: MKV_AC3 } });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    if (!out.ok) throw new Error('no play');
    t.source.release(out.torrent);
    expect(t.ffmpeg.runs[0]?.killed).toBe(true);
    await t.source.hold(FILM, out.torrent);
    expect(t.ffmpeg.runs).toHaveLength(2);
    expect(await t.remux.map(h(1))).toEqual({ duration_s: 120, ranges: [[0, 6]] });
  });

  it('plays a finished download again from disk through its finished remux, with no ffmpeg', async () => {
    const files = remuxDir(dir, h(1), 0);
    await mkdir(files, { recursive: true });
    await writeFile(path.join(files, 'index.m3u8'), eventPlaylist(20, true));
    await writeFile(path.join(files, REMUX_DONE_FILE), '{}');
    const t = setup({ candidates: [], probes: { [h(1)]: MKV_AC3 }, ready: [h(1)], disk: { infoHash: h(1), name: 'Film.2026.1080p.BluRay.x264.AC3-GRP', fileIndex: 0, state: 'ready' } });
    const disk = await t.source.fromDisk(FILM, { audioLang: 'en' });
    expect(disk?.torrent).toMatchObject({ manifestKind: 'hls', manifestUrl: `/api/stream/torrent/${h(1)}/hls/0/index.m3u8?remux=1&total_s=120`, candidate: null });
    expect(t.ffmpeg.runs).toHaveLength(0);
    expect(existsSync(path.join(files, REMUX_DONE_FILE))).toBe(true);
    await vi.waitFor(async () => expect(await t.remux.map(h(1))).toEqual({ duration_s: 120, ranges: [[0, 120]] }));
  });
});
```
**Impact:** Check: `npx vitest run tests/unit/directStream/torrentRemuxSource.test.ts tests/unit/directStream/torrentSource.test.ts`
(phase 3's file still passes unchanged).

### Step 6: Build it in the daemon, close it with the daemon
**File:** `src/daemon.ts` — with the other `./directStream/torrent/*` imports (phase 3's line after `:31`):
```ts
import { buildTorrentRemux } from './directStream/torrent/remux.js';
```
Right before phase 3's `let torrentSource: TorrentSource | null = null;` (phase 3 Step 11):
```ts
  // Torrent phase 5: the remux of files Chrome cannot play as is; null with torrents or NOTESD_TORRENT_REMUX off.
  const torrentRemux = buildTorrentRemux(config.torrent);
```
In phase 3's `torrentSourceOf` closure, at its `// Phase 5 adds remux ...` comment in the wiring object, one line:
```ts
        remux: torrentRemux,
```
In the `deps` object literal (`:245`, after `streamCache,` and phase 1's `torrents`):
```ts
    torrentRemux,
```
**File:** `src/background.ts:208-221` — in the `Promise.all([...])` of the close, before `streamCache?.close(),`
(and before phase 1's torrents close, so ffmpeg stops reading the file route first):
```ts
      deps.torrentRemux?.close(),
```
**Impact:** with torrents or the remux off `torrentRemux` is null: the source refuses non-`direct` files as phase 3
did, the route answers `torrent_off` / `remux_off`. Check: `npm run typecheck`, `npm test`.

### Step 7: The page plays a growing remux
**File:** `web/src/stream/hlsEngine.ts:12-33` — add before `export function createHlsEngine` (after `upstreamOf`):
```ts
/**
 * A torrent remux's playlist (src/directStream/torrent/remux.ts) is an EVENT playlist that grows while the file
 * downloads. Its address says so (`remux=1`) and names the film's full length (`total_s`) when the probe knew it.
 */
export interface GrowingPlaylist {
  totalS: number | null;
}

export function growingPlaylist(src: string): GrowingPlaylist | null {
  const q = src.indexOf('?');
  if (q === -1) return null;
  const params = new URLSearchParams(src.slice(q + 1));
  if (params.get('remux') !== '1') return null;
  const total = Number(params.get('total_s'));
  return { totalS: Number.isFinite(total) && total > 0 ? total : null };
}
```
and replace the `const hls = new Hls({ ... });` statement (`:29-33`) with:
```ts
  const growing = growingPlaylist(src);
  const hls = new Hls({
    // A growing remux starts at the resume position or at 0: hls.js would start a live playlist at its edge.
    startPosition: growing !== null ? Math.max(0, startAt) : startAt > 0 ? startAt : -1,
    maxBufferLength: bufferAheadS,
    maxMaxBufferLength: bufferAheadS,
    // hls.js's latency controller pulls a play that is past the end of a live playlist back to the live edge on every
    // reload. A growing remux is a film: a seek past what is remuxed waits there until the remux reaches it.
    ...(growing !== null ? { latencyController: undefined } : {}),
  });
```
and replace `hls.attachMedia(video);` (`:87`) with:
```ts
  // The film's full length from the probe, so the timeline is the whole film and a seek past the remux is possible.
  hls.attachMedia(growing !== null && growing.totalS !== null ? { media: video, overrides: { duration: growing.totalS } } : video);
```
**Impact:** a cloud or cache HLS source (no `remux=1`) gets exactly today's config and `attachMedia(video)`. A decode
error on a remux (HEVC this Chrome cannot decode: hls.js `mediaError bufferAddCodecError` and kin) goes the existing
way: one `recoverMediaError`, then `onFatal`, so the page stops with `Playback stopped (mediaError ...)` in its log and
the owner's shuffle button (S) moves to the next torrent through phase 3's `switchSource`.

**File:** `web/src/stream/hlsEngine.test.tsx` — in `interface FakeHls` add `attachMedia: Mock<(arg: unknown) => void>;`;
in the fake's `this.fake = { ... }` add `attachMedia: vi.fn(),`; replace the fake class's `attachMedia(): void {}` with
```ts
    attachMedia(arg: unknown): void {
      this.fake.attachMedia(arg);
    }
```
replace the `start` helper with
```ts
function start(over: { bufferAheadS?: number; startAt?: number; src?: string } = {}) {
  const { video, media } = fakeVideo();
  const h = handlers();
  const engine = createHlsEngine({
    kind: 'hls',
    video,
    src: over.src ?? SRC,
    startAt: over.startAt ?? 0,
    handlers: h,
    ...(over.bufferAheadS === undefined ? {} : { bufferAheadS: over.bufferAheadS }),
  });
  return { engine, hls: instances.at(-1)!, media, h, video };
}
```
and append:
```ts
describe('createHlsEngine: a torrent remux that is still growing (R2.8)', () => {
  const REMUX = '/api/stream/torrent/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/hls/0/index.m3u8';

  it('starts at 0 or the resume position, never at the live edge, and has no latency controller to pull a seek back', () => {
    const fresh = start({ src: `${REMUX}?remux=1&total_s=5400.5` }).hls.config;
    expect(fresh.startPosition).toBe(0);
    expect('latencyController' in fresh && fresh.latencyController === undefined).toBe(true);
    expect(start({ src: `${REMUX}?remux=1&total_s=5400.5`, startAt: 1800 }).hls.config.startPosition).toBe(1800);
  });

  it("gives the page the film's whole length from the probe, not the length remuxed so far", () => {
    const { hls, video } = start({ src: `${REMUX}?remux=1&total_s=5400.5` });
    expect(hls.attachMedia).toHaveBeenCalledWith({ media: video, overrides: { duration: 5400.5 } });
  });

  it('a remux whose length is unknown still never starts at the live edge', () => {
    const { hls, video } = start({ src: `${REMUX}?remux=1` });
    expect(hls.config.startPosition).toBe(0);
    expect(hls.attachMedia).toHaveBeenCalledWith(video);
  });

  it('plays a stream through the pass-through or the cache exactly as before', () => {
    const { hls, video } = start();
    expect(hls.config.startPosition).toBe(-1);
    expect('latencyController' in hls.config).toBe(false);
    expect(hls.attachMedia).toHaveBeenCalledWith(video);
  });
});
```
**Impact:** Check: `npx vitest run web/src/stream/hlsEngine.test.tsx`, `npm run typecheck` (web config).

### Step 8: Docs
**File:** `scripts/docs/httpRoutes.ts`, in the group phase 1 puts `GET /api/stream/torrent/:hash/f/:index` in, add:
```ts
      'GET /api/stream/torrent/:hash/hls/:index/:name':
        'A file of the ffmpeg remux of a torrent\'s file `:index` that Chrome cannot play as is (an MKV, AC3, E-AC3 or DTS sound, HEVC video), from this machine\'s disk: `index.m3u8`, an HLS EVENT playlist that grows while the file downloads and carries `EXT-X-ENDLIST` only once ffmpeg has read the whole file and exited cleanly; `init.mp4`; `seg-00000.m4s` and on (fMP4, about 6 s each: the video copied, the original-language audio as AAC stereo), with `Range` (206, 416). The playlist is never cached. A remux session\'s `manifest_url` names the playlist with `remux=1` and `total_s` (the film\'s length), which the player reads. 404 `not_found` (no such remux or file here; only those three kinds of name are served), 404 `not_on_this_machine` with `host` for a torrent downloaded on the other machine, 404 `remux_off` with `NOTESD_TORRENT_REMUX=off`, 503 `torrent_off`.',
```
and append to phase 1's `GET /api/stream/torrent/:hash/map` description:
```text
 For a torrent whose file plays as a remux, `ranges` is the remuxed stretch from 0 and `duration_s` the film's length from the probe.
```
Then `npm run docs:gen` (regenerates `docs/guide/reference/http-api.md`; never hand-edit it).
**File:** `docs/guide/reference/configuration.md`, phase 1's torrent table, add:
```markdown
| `NOTESD_TORRENT_REMUX` | on | `off`: a torrent file Chrome cannot play as is (an MKV, AC3/E-AC3/DTS sound, HEVC) is `unplayable` and the next torrent is tried, instead of playing an ffmpeg remux of it. See [streaming.md](../streaming.md#the-remux-for-files-chrome-cannot-play). |
```
**File:** `docs/guide/streaming.md` — a subsection right after phase 3's "Playing from a torrent", at the same heading
level:
```markdown
### The remux for files Chrome cannot play

A torrent's file is often an MKV, or carries AC3, E-AC3 or DTS sound, or HEVC video, none of which Chrome plays as a
plain file. When the probe says the file is not one Chrome plays as is, the session plays an ffmpeg remux of it:

- **One ffmpeg per file.** It reads the file through the daemon's own file route while the torrent downloads (a read
  waits for its pieces, and the download follows ffmpeg from the start of the film), or straight from disk once the
  download is whole.
- **Video copied, sound converted.** The video is never re-encoded (HEVC is tagged `hvc1`). The audio track in the
  title's original language (else the first) becomes AAC stereo; other audio tracks and embedded subtitles are left out.
- **An HLS playlist that grows.** `index.m3u8`, `init.mp4` and fMP4 segments of about 6 s go to
  `<NOTESD_TORRENT_DIR>/<info hash>/notesd-remux/<file index>/`, served by
  `GET /api/stream/torrent/<hash>/hls/<index>/<file>`. The playlist grows a segment at a time and is closed with
  `EXT-X-ENDLIST` only once ffmpeg has read the whole file and exited cleanly (`done.json`): ffmpeg closes a playlist
  even when its input dies, so that mark alone decides.
- **On the page.** The session's `manifest_kind` is `hls` and its `manifest_url` carries `remux=1` and `total_s` (the
  film's length from the probe). The player starts at the resume position or at 0, never at a live edge; its timeline
  is the whole film; a seek past what is remuxed waits there until the remux reaches it. The torrent's map
  (`GET /api/stream/torrent/<hash>/map`) answers the remuxed stretch, so the grey bar shows how far the remux is.
- **When it is not played.** The play starts once the first segment is written. ffmpeg that writes none in time, or
  stops with an error first, makes the torrent `unplayable` with the reason, and the next one is tried. Video other
  than H.264, HEVC, AV1 or VP9 (MPEG-2, VC-1, MPEG-4 Part 2) is `unplayable` without running ffmpeg.
- **Stopping and replaying.** A session that lets go of its torrent stops its ffmpeg; the half-made remux starts over
  the next time. A finished remux stays with the download and plays again from disk with no ffmpeg; it goes when the
  download is cleared.
- **HEVC** plays where the streaming Chrome decodes it. Where it cannot, the page stops with `mediaError ...` in its
  log, and the shuffle button (S) moves to the next torrent.
- `NOTESD_TORRENT_REMUX=off` makes such a file `unplayable` again; `NOTESD_FFMPEG_BIN` names the ffmpeg.
```
and one row in "Where the code is" (`:1106-1135`), after the `src/directStream/cache/` row:
```markdown
| `src/directStream/torrent/remux.ts`, `src/http/streamTorrentRemuxApi.ts` | The torrent remux: ffmpeg into a growing HLS playlist, its files and map |
```
**Impact:** Check: `npm run docs:check` and `npx vitest run tests/unit/docs/reference.test.ts`.

### Step 9: The harness and the feature map
**File:** `.claude/skills/verify-notesd/scripts/stream/make-mkv-fixture.sh` (new, `chmod +x`)
```bash
#!/usr/bin/env bash
# Builds the film the torrent remux journeys play (torrent-remux.steps.mjs): 120 s of 640x360 H.264 with a keyframe
# every 2 s and two AC3 5.1 tracks, Spanish (440 Hz) then English (660 Hz), in an MKV: a file Chrome cannot play as
# is. scripts/torrent/offer-remux.sh hands it to a `verify.sh up --torrent` run (phase 1's seed folder, phase 3's
# candidates.json).
# Usage: make-mkv-fixture.sh OUT_DIR   (prints OUT_DIR; a finished OUT_DIR is reused)
set -euo pipefail
out=${1:?usage: make-mkv-fixture.sh OUT_DIR}
if [ -f "$out/.done" ]; then
  echo "$out"
  exit 0
fi
command -v ffmpeg >/dev/null || { echo "make-mkv-fixture: ffmpeg not found" >&2; exit 1; }
mkdir -p "$out"
ffmpeg -loglevel error -y \
  -f lavfi -i "testsrc2=size=640x360:rate=24" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000" \
  -f lavfi -i "sine=frequency=660:sample_rate=48000" \
  -t 120 -map 0:v -map 1:a -map 2:a \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p -g 48 \
  -c:a ac3 -b:a 192k -ac 6 \
  -metadata:s:a:0 language=spa -metadata:s:a:1 language=eng \
  "$out/Verify.Fixture.Film.2026.360p.BluRay.x264.AC3-NOTESD.mkv"
touch "$out/.done"
echo "$out"
```
**File:** `.claude/skills/verify-notesd/scripts/torrent/offer-remux.sh` (new, `chmod +x`). It uses only what phases 1
and 3 own: phase 1's seeder seeds a folder moved into `<run>/torrent/seed/<name>/` and writes
`<run>/torrent/seeded/<name>.json`; phase 3's fake index answers every query from `<run>/torrent/candidates.json`,
naming each release `<Title>.<Year>.<name>` (so 467905 gets `How.to.Make.a.Killing.2026.360p.BluRay.x264.AC3-NOTESD`).
```bash
#!/usr/bin/env bash
# offer-remux.sh RUN: hands torrent phase 5's MKV fixture (make-mkv-fixture.sh) to a `verify.sh up --torrent` run:
# moves a copy into phase 1's seed folder (<run>/torrent/seed/remux/), waits for <run>/torrent/seeded/remux.json, and
# makes it the fake index's only answer (<run>/torrent/candidates.json, release tail 360p.BluRay.x264.AC3-NOTESD).
# Prints the info hash. Idempotent per run.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFY_HOME="${VERIFY_HOME:-$HOME/.local/state/notesd-verify}"
RUN=${1:?usage: offer-remux.sh RUN}
TOR="$VERIFY_HOME/$RUN/torrent"
[ -s "$TOR/fixture.json" ] || { echo "offer-remux: $RUN was not started with --torrent" >&2; exit 2; }
FIX="$(bash "$HERE/../stream/make-mkv-fixture.sh" "$VERIFY_HOME/.stream-fixture-mkv")"
if [ ! -s "$TOR/seeded/remux.json" ]; then
  rm -rf "$TOR/seed/.remux"
  mkdir -p "$TOR/seed/.remux"
  cp "$FIX"/*.mkv "$TOR/seed/.remux/"
  mv "$TOR/seed/.remux" "$TOR/seed/remux"
  for _ in $(seq 1 80); do [ -s "$TOR/seeded/remux.json" ] && break; sleep 0.25; done
  [ -s "$TOR/seeded/remux.json" ] || { echo "offer-remux: the seeder did not seed the MKV (log: $TOR/seeder.out)" >&2; exit 1; }
fi
jq -c '[{info_hash, name: "360p.BluRay.x264.AC3-NOTESD", seeds: 25, size_bytes: ([.files[].length] | add)}]' "$TOR/seeded/remux.json" >"$TOR/candidates.json"
jq -r .info_hash "$TOR/seeded/remux.json"
```
**File:** `.claude/skills/verify-notesd/scripts/verify.sh`, in phase 1/3's `--torrent` env block (after phase 3's
finder lines):
```bash
  # Torrent phase 5: the remux runs with this machine's ffmpeg; NOTESD_TORRENT_REMUX=off from the caller passes through.
  if [ "$torrent" = 1 ]; then
    env+=(
      "NOTESD_TORRENT_REMUX=${NOTESD_TORRENT_REMUX:-on}"
    )
  fi
```
**File:** `.claude/skills/verify-notesd/scripts/stream/torrent-remux.steps.mjs` (new)
```js
// The remux for a torrent file Chrome cannot play as is (torrent phase 5), end to end on a throwaway daemon: phase 1's
// loopback seeder serves an MKV with H.264 video and two AC3 5.1 tracks (Spanish, then English), phase 3's fake index
// hands it out for every film, and the real player page plays it through ffmpeg's HLS remux. Chromium here, never the
// owner's streaming Chrome; nothing leaves this machine.
//   FIX=$(bash .claude/skills/verify-notesd/scripts/stream/make-mkv-fixture.sh "$HOME/.local/state/notesd-verify/.stream-fixture-mkv")
//   $V up --web --torrent                       (note RUN), then .claude/skills/verify-notesd/scripts/torrent/offer-remux.sh RUN
//   RUN_DIR=$HOME/.local/state/notesd-verify/<RUN> $V ui RUN .claude/skills/verify-notesd/scripts/stream/torrent-remux.steps.mjs
// Logs "REMUX PLAY PASS" (J1), "REMUX TRACKS PASS" (J2), "REMUX SEEK PASS" (J3), "REMUX REPLAY PASS" (J4) and
// "REMUX GROWING PASS" (J5); the first failed check throws and fails the run.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const RUN_DIR = process.env.RUN_DIR
// An English film of the fake TMDB (scripts/movies/tmdb.json): the remux keeps the English track.
const TMDB_ID = Number(process.env.TMDB_ID ?? 467905)
const REMUX_URL = /^\/api\/stream\/torrent\/([0-9a-f]{40})\/hls\/(\d+)\/index\.m3u8\?remux=1&total_s=([\d.]+)$/

function check(ok, what) {
  if (!ok) throw new Error(what)
}

async function play(page, base) {
  const res = await page.request.post(`${base}/api/stream/play`, { headers: { origin: new URL(base).origin }, data: { kind: 'movie', tmdb_id: TMDB_ID, provider: 'torrent' } })
  check(res.ok(), `POST /api/stream/play answered ${res.status()} ${await res.text()}`)
  return (await res.json()).session
}

/** The playlist as it was when only its first `n` segments were remuxed: no EXT-X-ENDLIST. */
function firstSegments(text, n) {
  const lines = text.split('\n')
  const out = []
  let kept = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('#EXT-X-ENDLIST')) continue
    if (line.startsWith('#EXTINF')) {
      if (kept === n) break
      kept += 1
      out.push(line, lines[i + 1])
      i += 1
      continue
    }
    out.push(line)
  }
  return `${out.join('\n')}\n`
}

function ffmpegOn(dir) {
  try {
    return execFileSync('pgrep', ['-f', dir], { encoding: 'utf8' }).trim() !== ''
  } catch {
    return false
  }
}

const mtimes = (dir) => JSON.stringify(Object.fromEntries(readdirSync(dir).sort().map((name) => [name, statSync(path.join(dir, name)).mtimeMs])))

export default async ({ page, base, shot, log }) => {
  check(RUN_DIR && existsSync(path.join(RUN_DIR, 'daemon.log')), 'set RUN_DIR to the run folder (~/.local/state/notesd-verify/<RUN>)')
  const tor = path.join(RUN_DIR, 'torrent')
  check(existsSync(path.join(tor, 'seeded', 'remux.json')) && existsSync(path.join(tor, 'candidates.json')), 'run scripts/torrent/offer-remux.sh RUN first (it seeds the MKV and lists it in the fake index)')
  const torrentsDir = process.env.TORRENT_DIR ?? path.join(RUN_DIR, 'data', 'movies', 'torrents')

  // J1: the play answers the remux playlist, and the page plays it, with sound.
  const first = await play(page, base)
  const m = REMUX_URL.exec(first.manifest_url ?? '')
  check(first.manifest_kind === 'hls' && m !== null, `the session plays the remux playlist (got ${first.manifest_kind} ${first.manifest_url})`)
  const [, hash, index, total] = m
  check(Math.abs(Number(total) - 120) < 1, `total_s is the film's length from the probe (got ${total})`)
  await page.goto(`${base}/stream/${first.session_id}`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 60_000 })
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !!v && !v.paused && v.currentTime > 2 && v.webkitAudioDecodedByteCount > 0
  }, null, { timeout: 60_000 })
  const playing = await page.evaluate(() => {
    const v = document.querySelector('video')
    return { kind: window.notesdStream.kind, height: v.videoHeight, duration: v.duration, audioBytes: v.webkitAudioDecodedByteCount, errors: window.notesdStream.errors }
  })
  log(`REMUX PLAY state ${JSON.stringify(playing)}`)
  check(playing.kind === 'hls' && playing.height === 360 && Math.abs(playing.duration - 120) < 1 && playing.errors.length === 0, `hls.js plays the remux: 360p, 120 s long, no error (got ${JSON.stringify(playing)})`)
  await shot('remux-playing')
  log('REMUX PLAY PASS the MKV (H.264 + AC3) plays in the player page from the remux playlist, with sound')

  // J2: the finished remux is H.264 copied and the English track as AAC stereo, in a closed EVENT playlist.
  const dir = path.join(torrentsDir, hash, 'notesd-remux', index)
  for (let i = 0; i < 120 && !existsSync(path.join(dir, 'done.json')); i++) await page.waitForTimeout(500)
  check(existsSync(path.join(dir, 'done.json')), `the remux finished: ${dir}/done.json`)
  const playlist = await (await page.request.get(`${base}${first.manifest_url}`)).text()
  check(playlist.includes('#EXT-X-PLAYLIST-TYPE:EVENT') && playlist.trimEnd().endsWith('#EXT-X-ENDLIST'), 'the finished playlist is an EVENT playlist closed with EXT-X-ENDLIST')
  const streams = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,channels:stream_tags=language', '-of', 'json', path.join(dir, 'index.m3u8')], { encoding: 'utf8' })).streams
  log(`REMUX TRACKS ${JSON.stringify(streams)}`)
  const video = streams.filter((s) => s.codec_type === 'video')
  const audio = streams.filter((s) => s.codec_type === 'audio')
  check(video.length === 1 && video[0].codec_name === 'h264', 'the video is the H.264 stream, copied')
  check(audio.length === 1 && audio[0].codec_name === 'aac' && audio[0].channels === 2 && audio[0].tags?.language === 'eng', 'one audio track: the English one (not the first, Spanish), as AAC stereo')
  log('REMUX TRACKS PASS H.264 copied, the English AC3 5.1 track as AAC stereo, EVENT playlist closed once whole')

  // J3: a seek inside what is remuxed plays from there; the map says how far that is.
  const map = await (await page.request.get(`${base}/api/stream/torrent/${hash}/map`)).json()
  log(`REMUX MAP ${JSON.stringify(map)}`)
  check(map.ranges.length === 1 && map.ranges[0][0] === 0 && map.ranges[0][1] > 110 && Math.abs(map.duration_s - 120) < 1, 'the map answers the remuxed stretch from 0 and the film length')
  await page.evaluate(() => {
    document.querySelector('video').currentTime = 90
  })
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !v.paused && v.currentTime > 91
  }, null, { timeout: 30_000 })
  const at = await page.evaluate(() => document.querySelector('video').currentTime)
  check(at > 91 && at < 110, `plays on from 90 s (at ${at})`)
  log('REMUX SEEK PASS a seek to 90 s inside the remuxed stretch plays from there')

  // J4: a second play of the title replays the finished remux from disk: no ffmpeg, no file written again.
  const before = mtimes(dir)
  const second = await play(page, base)
  check(second.manifest_url === first.manifest_url && second.manifest_kind === 'hls', `the second play names the same playlist (got ${second.manifest_url})`)
  check(!ffmpegOn(dir), 'no ffmpeg runs for the finished remux')
  const replayed = await (await page.request.get(`${base}${second.manifest_url}`)).text()
  check(replayed.trimEnd().endsWith('#EXT-X-ENDLIST'), 'the replayed playlist is whole from the first read')
  check(mtimes(dir) === before, 'no file of the remux was written again')
  check(readFileSync(path.join(RUN_DIR, 'daemon.log'), 'utf8').includes(`torrent remux: ${hash} file ${index} plays from disk`), "the daemon's log says the remux plays from disk")
  log('REMUX REPLAY PASS the second play reads the finished remux from disk: same playlist, no ffmpeg, files untouched')

  // J5: the real page on a playlist that is still growing (Playwright hands it the first 3 segments, no EXT-X-ENDLIST,
  // for 15 s): the timeline is the whole film, a seek past the remuxed part waits there, and plays once it is there.
  let loadedAt = 0
  await page.route(`**/api/stream/torrent/${hash}/hls/${index}/index.m3u8*`, async (route) => {
    const res = await route.fetch()
    const text = await res.text()
    const grown = loadedAt !== 0 && Date.now() - loadedAt > 15_000
    await route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', headers: { 'cache-control': 'no-store' }, body: grown ? text : firstSegments(text, 3) })
  })
  loadedAt = Date.now()
  await page.goto(`${base}/stream/${second.session_id}`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 30_000 })
  await page.evaluate(() => {
    document.querySelector('video').currentTime = 60
  })
  await page.waitForTimeout(5_000)
  const held = await page.evaluate(() => {
    const v = document.querySelector('video')
    return { t: v.currentTime, d: v.duration }
  })
  log(`REMUX GROWING held ${JSON.stringify(held)} at ${Date.now() - loadedAt} ms`)
  check(Date.now() - loadedAt < 15_000, 'the hold was read while the playlist was still cut (raise the 15 s window if this machine is slow)')
  check(held.t >= 60 && held.t < 60.5 && Math.abs(held.d - 120) < 1, `a seek to 60 s past the 18 s remuxed waits at 60 s (not pulled back to a live edge) on a 120 s timeline (got ${JSON.stringify(held)})`)
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !v.paused && v.currentTime > 62
  }, null, { timeout: 30_000 })
  const errors = await page.evaluate(() => window.notesdStream.errors)
  check(errors.length === 0, `no error (got ${JSON.stringify(errors)})`)
  await shot('remux-growing')
  log('REMUX GROWING PASS on a growing playlist the page shows 120 s, holds a seek past the edge at 60 s, and plays on from there once the remux reaches it')
  await page.unroute(`**/api/stream/torrent/${hash}/hls/${index}/index.m3u8*`)
}
```
**File:** `.claude/skills/verify-notesd/features/direct-streaming.md:325` — new section before `## Gotchas` (after
phase 3's "Playing from a torrent"):
```markdown
## Torrent remux (a file Chrome cannot play as is)
- A torrent file the probe marks not `direct` (MKV, AC3/E-AC3/DTS, HEVC) with H.264, HEVC, AV1 or VP9 video plays as
  an ffmpeg remux: `manifest_kind: "hls"`, `manifest_url`
  `/api/stream/torrent/<hash>/hls/<index>/index.m3u8?remux=1&total_s=<film s>`. Video copied, the original-language
  audio as AAC stereo, fMP4 segments in `<torrent dir>/<hash>/notesd-remux/<index>/`; the playlist is EVENT, grows
  with the download and is served with `EXT-X-ENDLIST` only after `done.json` (a clean ffmpeg exit). The page starts
  at the resume position or 0, shows the whole film, and holds a seek past the remuxed part until it is there; the map
  answers the remuxed stretch. Other video (MPEG-2, VC-1) is `unplayable`; `NOTESD_TORRENT_REMUX=off` makes every such
  file `unplayable`. A finished remux replays from disk with no ffmpeg.
- Logic: `npx vitest run tests/unit/directStream/torrentRemux.test.ts tests/unit/directStream/torrentRemux.ffmpeg.test.ts tests/unit/directStream/torrentRemuxRoute.test.ts tests/unit/directStream/torrentRemuxSource.test.ts web/src/stream/hlsEngine.test.tsx`
  (the ffmpeg file runs the real ffmpeg on a generated H.264 + AC3 MKV served at a trickle).
- Throwaway daemon: `FIX=$(bash .claude/skills/verify-notesd/scripts/stream/make-mkv-fixture.sh "$HOME/.local/state/notesd-verify/.stream-fixture-mkv")`,
  `$V up --web --torrent` (note RUN), then
  `RUN_DIR=$HOME/.local/state/notesd-verify/RUN $V ui RUN .claude/skills/verify-notesd/scripts/stream/torrent-remux.steps.mjs`:
  `REMUX PLAY PASS`, `REMUX TRACKS PASS`, `REMUX SEEK PASS`, `REMUX REPLAY PASS`, `REMUX GROWING PASS`, screenshots
  `remux-playing` and `remux-growing`. Run `.claude/skills/verify-notesd/scripts/torrent/offer-remux.sh RUN` before
  the steps: it seeds the MKV through phase 1's `<run>/torrent/seed/remux/` and makes it the fake index's answer
  (`<run>/torrent/candidates.json`).
- Remux off: `NOTESD_TORRENT_REMUX=off $V up --torrent`, `.claude/skills/verify-notesd/scripts/torrent/offer-remux.sh RUN`, then
  `$V api RUN POST /api/stream/play '{"kind":"movie","tmdb_id":467905,"provider":"torrent"}'` answers 502 `no_source`
  with a `Torrent: ...AC3-NOTESD` attempt `unplayable`.
```
**Impact:** Check: the journeys of **Proof** below.

## Principles applied

- Make illegal states unrepresentable: ffmpeg writes `EXT-X-ENDLIST` on every exit, a dead input included (measured,
  with and without `-xerror`), so the playlist file alone cannot say a remux is whole. The route serves
  `EXT-X-ENDLIST` only when `done.json` exists, and only `finish()` after exit 0 under `-xerror` with segments writes
  it: a truncated remux can never look like a finished film to hls.js (which would end the play early).
- Prove it works (and attack the premise): the analyst's design assumed hls.js plays a growing EVENT playlist and
  "a seek past it waits". Measured in Chromium, hls.js pulled such a seek back to the live edge; the plan therefore
  turns the latency controller off for a growing remux (verified to hold the seek) and J5 drives exactly that in the
  real page. The ffmpeg arguments are the ones run on 6.1.1 (see "What was run before planning").
- Laziness protocol: no new table and no state file but `done.json`; files are served by the cache's `fileResponse`
  and `contentTypeOf`; a remux that was stopped or failed starts over instead of resuming mid-file; the page learns
  the film's length from the manifest address (`total_s`) instead of a new session field that phase 4's
  `session.ts` would have to parse; no line of phase 3's `service.ts` changes (the remux hangs off `TorrentSource`'s
  existing `hold`/`release`).
- Boundary discipline: the hash, the file index and the file name are checked once in the route (three regexes);
  `TorrentRemux.file` trusts them. The probe stays phase 3's single parse; the remux reads it through its own narrow
  `RemuxProbe`.
- Test behavior, not implementation: the remux is tested through `start`/`file`/`map`/`release` and the HTTP route,
  with a fake only at the ffmpeg process seam, plus one test with the real ffmpeg on a generated MKV over a trickling
  HTTP server; the source tests read what a session gets (`manifestKind`, the playlist address, the attempt).

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` (includes `tests/unit/docs/reference.test.ts`), then `npm run docs:check`
**Proof:** a throwaway daemon with phase 1's loopback-seeded MKV (H.264 + two AC3 5.1 tracks) and phase 3's fake index
plays the MKV in the real player page through the remux, seeks inside it, replays it from disk, and holds a seek past a
growing playlist's edge; with the remux off the same file is `unplayable`.
- Harness: `.claude/skills/verify-notesd` (`V=.claude/skills/verify-notesd/scripts/verify.sh`); torrent runs are
  `$V up --web --torrent` (phase 1, implies `--direct-stream`); the MKV comes from
  `FIX=$(bash .claude/skills/verify-notesd/scripts/stream/make-mkv-fixture.sh "$HOME/.local/state/notesd-verify/.stream-fixture-mkv")`
  and `scripts/torrent/offer-remux.sh RUN` seeds it through phase 1's seed folder and lists it in phase 3's
  `candidates.json` (see Handoffs).
- Feature-map entries: `features/direct-streaming.md` (the new "Torrent remux" section; "Playing from a torrent" and
  the player bullets for the neighbor check)
- Journeys (RUN from `$V up --web --torrent` followed by `.claude/skills/verify-notesd/scripts/torrent/offer-remux.sh RUN`;
  J1-J5 are one UI run, in order; RUN2 from `NOTESD_TORRENT_REMUX=off $V up --torrent`):
  - **J1** · traces R2.8 — `RUN_DIR=$HOME/.local/state/notesd-verify/RUN $V ui RUN .claude/skills/verify-notesd/scripts/stream/torrent-remux.steps.mjs` → passes when the transcript has `REMUX PLAY PASS`: `POST /api/stream/play {"kind":"movie","tmdb_id":467905,"provider":"torrent"}` answered `manifest_kind: "hls"` and `manifest_url` `/api/stream/torrent/<hash>/hls/<index>/index.m3u8?remux=1&total_s=120`, and the page's `window.notesdStream.kind` is `hls` with `videoHeight` 360, `video.duration` 120, `webkitAudioDecodedByteCount` > 0, time past 2 s and no error (screenshot `remux-playing`)
  - **J2** · traces R2.8 — the same run → passes when it logs `REMUX TRACKS PASS`: `<run>/data/movies/torrents/<hash>/notesd-remux/<index>/done.json` exists, the playlist read over HTTP has `#EXT-X-PLAYLIST-TYPE:EVENT` and ends with `#EXT-X-ENDLIST`, and ffprobe of it lists one `h264` video and one `aac` audio with 2 channels tagged `eng` (the second, English AC3 track of the MKV, not the first, Spanish one)
  - **J3** · traces R2.8 — the same run → passes when it logs `REMUX SEEK PASS`: `GET /api/stream/torrent/<hash>/map` answers `ranges` `[[0, >110]]` and `duration_s` ≈ 120, and after `currentTime = 90` the video plays past 91 s and stays under 110 s
  - **J4** · traces R2.8 — the same run → passes when it logs `REMUX REPLAY PASS`: a second play answers the same `manifest_url`, `pgrep -f <remux dir>` finds no ffmpeg, the playlist's first read ends with `#EXT-X-ENDLIST`, no file in the remux folder changed its mtime, and `<run>/daemon.log` has `torrent remux: <hash> file <index> plays from disk`
  - **J5** · traces R2.8 — the same run → passes when it logs `REMUX GROWING PASS`: with Playwright serving the daemon's playlist cut to its first 3 segments without `EXT-X-ENDLIST` for 15 s, the page shows `video.duration` ≈ 120, a seek to 60 s still reads `currentTime` in [60, 60.5) 5 s later (not pulled back to ~6-12 s), and once the full playlist is served the video plays past 62 s with no error (screenshot `remux-growing`)
  - **J6** · traces R2.8 — on RUN2: `.claude/skills/verify-notesd/scripts/torrent/offer-remux.sh RUN2`, then `$V api RUN2 POST /api/stream/play '{"kind":"movie","tmdb_id":467905,"provider":"torrent"}'` → passes when it answers 502 `no_source` whose `attempts` hold `Torrent: How.to.Make.a.Killing.2026.360p.BluRay.x264.AC3-NOTESD` with outcome `unplayable` and detail `matroska h264 360p / ac3+ac3: Chrome does not play it as is`, and `find ~/.local/state/notesd-verify/RUN2/data -path '*notesd-remux*'` prints nothing (the file is never handed to the page as is, and nothing is remuxed with the remux off)
  - **J7** · traces R2.8 — `npx vitest run tests/unit/directStream/torrentRemux.test.ts tests/unit/directStream/torrentRemux.ffmpeg.test.ts tests/unit/directStream/torrentRemuxRoute.test.ts tests/unit/directStream/torrentRemuxSource.test.ts web/src/stream/hlsEngine.test.tsx tests/unit/config.test.ts` → passes when every file passes and the ffmpeg file reports its one test as passed, not skipped
- Neighbor check: the HLS engine's cloud path and phase 3's MP4 torrent must be untouched — `FIX=$(bash .claude/skills/verify-notesd/scripts/stream/make-hls-fixture.sh "$HOME/.local/state/notesd-verify/.stream-fixture")`, `$V up --web` (RUN3), `STREAM_FIXTURE="$FIX" $V ui RUN3 .claude/skills/verify-notesd/scripts/stream/player.steps.mjs` logs `J1 PASS`, `API PASS`, `BUFFER PASS`, `J3 PASS`, `J2 PASS`, `MUTED PASS`, `CDN PASS`; and on a fresh `$V up --web --torrent` run (RUN4, no `candidates.json`) `.claude/skills/verify-notesd/scripts/direct-stream/torrent.sh RUN4 named` then `SID=$(cat ~/.local/state/notesd-verify/RUN4/torrent-journey/sid) $V ui RUN4 .claude/skills/verify-notesd/scripts/stream/torrent-play.steps.mjs` logs `TORRENT PAGE PASS` with `manifest_url` still `/api/stream/torrent/<hash>/f/<index>`
- Cost: none billed (loopback swarm, fake index, fake TMDB, local ffmpeg; no model call). `down` every run after.
**Exit criteria:** `npm run typecheck`, `npm test` and `npm run docs:check` pass; J1-J7 and the neighbor check pass;
every run is `down`.

## Handoffs

- **Phase 1 (harness, reconciled):** nothing is added to phase 1. This phase's `offer-remux.sh` moves the MKV into
  phase 1's seed folder (`<run>/torrent/seed/remux/`) and reads `<run>/torrent/seeded/remux.json`; phase 3's fake index
  answers it from `<run>/torrent/candidates.json`.
- **Phase 1 (layout and clearing):** the remux lives in `<config.torrent.dir>/<info hash>/notesd-remux/<file index>/`,
  inside the torrent's own folder; phase 1's clearing after `keepDays` (and any delete of a download) must remove the
  whole `<dir>/<info hash>/` folder, so the remux goes with its download. A torrent's own files never land in
  `notesd-remux/` (phase 1 selects only video and subtitle files).
- **Phase 1 (route):** Step 4 adds three lines at the top of phase 1's `GET /api/stream/torrent/:hash/map` handler and
  one sentence to its `httpRoutes.ts` description. `TorrentStreams.view(hash)` is read for `available: false` and
  `host`; if phase 1 names those fields differently, adjust `otherHost` in `streamTorrentRemuxApi.ts`.
- **Phase 3:** Step 5 edits `source.ts` in five places (`refusalOf`'s non-`direct` branch is the one the contract said
  phase 5 replaces); `fake-index.mjs` is not edited (its `candidates.json` knob serves this phase).
  `fromDisk` now replays a finished non-`direct` download through its remux instead of passing it over. If the
  reconciler wants one language helper, `pickAudioStream` can use phase 3's `normalizeAudioLang` (same results for
  every ffprobe tag the tests use).
- **Phase 4:** a remuxed torrent session is `manifest_kind: "hls"`; the controller's torrent handling (mark, bar from
  the map, no automatic source move) applies unchanged. A seek past the remuxed part fires `waiting`: with phase 4's
  automatic move off for torrent sessions it simply waits. A decode error (HEVC this Chrome cannot decode) arrives as
  the engine's `onFatal('mediaError ...')`; phase 4's shuffle button is the way on.
- **Phase 7:** `config.torrent.ffmpegBin` / `NOTESD_FFMPEG_BIN` / `DEFAULT_FFMPEG_BIN` are phase 3's (reconciled);
  phases 5, 7 and 8 only read them. Phase 7's extraction and this remux read the same file at once (both from the
  start), which phase 1's sequential download serves.
- **Phase 1 (409 `not_in_swarm`):** ffmpeg reads the file route while the session holds the torrent; once the
  session lets go and the torrent leaves the swarm, the route answers 409 `not_in_swarm` and never rejoins, so ffmpeg
  exits non-zero, `done.json` is not written, and the next play starts the remux over (the playlist then keeps its
  address). `release` stops ffmpeg before that anyway.
- Not done here (outside R2.8): resuming a stopped remux mid-file (it starts over), seeking ahead of the remux faster
  than the download (a remux started at the seek point), and a choice of audio track in the page.

## Rollback

Revert this phase's merge: phase 3's `source.ts` returns to refusing every non-`direct` file as `unplayable`, the route
and the setting go, and `hlsEngine.ts` returns to its previous config. Remux folders left on disk
(`<torrent dir>/*/notesd-remux/`) are inert and go with their downloads. Without a revert, `NOTESD_TORRENT_REMUX=off`
turns the remux off (such files are `unplayable` again).
