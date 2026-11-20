# Phase 1: Preview core: builder, store, routes, the cloud-cache source

**Plan set:** `SEEK_PREVIEW_THUMBNAILS_PLAN.md`
**Analysis:** `.workflows/analyze/20261120-192436-K7QP_code_analyzer.md`
**Satisfies:** R1, R2 — the hover picture on the player's timeline (R1), made so it can never disturb a play (R2)
**Criteria:** R1.2, R1.5, R2.2, R2.3, R2.5, R2.7, R2.8
**Depends on:** none
**Difficulty:** HARD
**Package:** `src/directStream/previews`

---

## Goal

After this phase the daemon makes seek-preview sprite sheets from the part of a cloud stream's cache that is on
this machine, one niced ffmpeg at a time, keeps them beside the cache with an index that survives a restart, and
lists them per stream session at `GET /api/stream/sessions/:id/previews` (served by
`GET /api/stream/sessions/:id/previews/:name`). Every session carries `preview_rev`, raised whenever its cue list
changes and carried in the position report's answer, so phase 4's page can follow it. `NOTESD_STREAM_PREVIEWS=off`
builds nothing and answers no frame; a cache's size on disk counts its previews and its deletion takes them.

## Interface Contract

The reconciler reads this section to detect cross-phase conflicts.

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- The index's fixed contract, verbatim, in `src/directStream/previews/types.ts`: `PreviewCue`, `PreviewList`,
  `PreviewSource`, `LocalVideo` (its `input()` answers `PreviewInput`: `{args, cleanup?, loopback?: true}`, the one
  contract edit the reconciler allowed; `args` is the whole input section, seek included, and the builder adds no
  seek). Additions in the same file (no change to the four): `PreviewInput`, `noPreviews()` (the one `none` list),
  `class PreviewNotYet extends Error` (thrown by `LocalVideo.input()` or by its `cleanup()`: the stretch is not
  readable yet; never counted as a failure), `PREVIEW_INPUT_PROTOCOLS = 'file,crypto,data,concat'` (the
  `-protocol_whitelist` every preview ffmpeg input runs under), `PREVIEW_LOOPBACK_PROTOCOLS = 'http,tcp'` (added only
  for an input with `loopback: true`, whose every address must then be `http://127.0.0.1`), `PreviewHome` and
  `homeOf(video)` (the folder whose existence means the video is still on this machine; default the folder `dir` is in).
- `src/directStream/previews/plan.ts`: `PREVIEW_INTERVAL_S` 10, `PREVIEW_FRAME_WIDTH` 240, `PREVIEW_COLS` 6,
  `PREVIEW_ROWS` 6, `SHEET_SPAN_S` 360, `PREVIEW_MIN_STRETCH_S` 2, `SHEET_NAME`, `sheetName`, `SheetSpec`,
  `SheetRecord`, `planSheets`, `covered`, `cuesOf`.
- `src/directStream/previews/sheetIndex.ts`: `PREVIEW_INDEX_FILE` (`previews.json` in `LocalVideo.dir`),
  `readSheets`, `addSheet`.
- `src/directStream/previews/builder.ts`: `PREVIEW_NICENESS` 19, `PREVIEW_SHEET_TIME_LIMIT_MS` 120 000,
  `PreviewProcess`, `SpawnPreview`, `ffmpegPreviewSpawner`, `inputProtocols`, `refusedInput`, `sheetArgs`, `jpegSize`,
  `SheetOutcome`, `SheetBuilder`.
- `src/directStream/previews/queue.ts`: `PREVIEW_MAX_TRIES` 3, `PREVIEW_RETRY_MS` 20 000, `PreviewQueue`.
- `src/directStream/previews/local.ts`: `LocalVideos` (`forSession`, `whole`), `class LocalSource implements
  PreviewSource` (the cache source now, phase 2's torrent source next), `keyTag`, `sheetUrl`, `localList`, `isFile`.
- `src/directStream/previews/cacheSource.ts`: `CACHE_PREVIEWS_SUBDIR` (`previews`), `parseCachePlaylist`,
  `segmentCoverage`, `stretchPlaylist`, `CacheVideos`, `ffprobeDuration`, `cacheSource`.
- `src/directStream/previews/sources.ts`: `PreviewSourceDeps` (config, directStream, streamCache, torrents, fetch,
  changed, log, probeDuration?), `PreviewSourceFactory`, `PREVIEW_SOURCES` (the registry: `[cacheSource]`; phase 3
  puts `providerSource` first and phase 2 `torrentSource` before `cacheSource`), `previewSources`.
- `src/directStream/previews/service.ts`: `StreamPreviews` (`list`, `changed`, `sheet`, `reported`, `sweep`, `start`,
  `close`), `missingSheets`, `buildStreamPreviews`, `PREVIEW_LOOK_MS`, `PREVIEW_SWEEP_FIRST_MS`, `PREVIEW_SWEEP_MS`.
  How `preview_rev` rises, for every source (one mechanism): only `StreamPreviews.list(session)` raises it, when the
  list differs from the last one that session was given; a route read, a look on a position report, a made sheet and
  a source's `deps.changed(session)` all go through it. Nothing awaits `list()` while the position answer is built.
- `StreamSession.previewRev: number` (`src/directStream/sessions.ts`), `SessionInfo.preview_rev`
  (`src/directStream/service.ts`), `DirectStreamService.peek(id)`, `DirectStreamService.passThroughFetch` (the
  pass-through's `FetchLike`, read-only).
- `StreamCache.previewView()`, `CachePreviewRow`, `CachePreviewView` (`src/directStream/cache/service.ts`).
- `AppDeps.streamPreviews` (`src/deps.ts`).
- `DirectStreamConfig.previews` (`NOTESD_STREAM_PREVIEWS`, on by default; `false` in `DEFAULT_DIRECT_STREAM_CONFIG`).
- Routes `GET /api/stream/sessions/:id/previews`, `GET /api/stream/sessions/:id/previews/:name` (contract shape).
- `preview_rev` in the answer of `POST /api/stream/sessions/:id/position`; `StreamPositionDeps.previews`.

**Signature changes:**
- `directStreamRoutes(deps: Pick<AppDeps,'directStream'> & Partial<Pick<AppDeps, 'movies'|'streamLive'|'titleSubtitles'|'titleCues'|'torrents'>>)`
  -> the same with `'streamPreviews'` added to the `Partial<Pick<...>>`.
- `CacheStore.diskSize(id)`: same signature, now counts every file under the folder (the `previews/` subfolder too).

**Requires (from earlier phases):** none.
**Leaves alone (owned by others):** `web/` (phase 4), `claude/streaming/` and `passThrough.ts`, `evidence.ts`,
`delivery.ts`, `runner.ts`, `types.ts` of `src/directStream` (phase 3), `src/directStream/torrent/*` (phase 2),
`docs/guide/streaming.md`, `docs/guide/movies.md`, `CLAUDE.md`, `scripts/docs/shots/*`,
`.claude/skills/verify-notesd/features/*` and `scripts/stream/*` (phase 5).

## Files

| File | Action | What changes |
|---|---|---|
| `src/directStream/previews/types.ts` | create | the contract's types (with `PreviewInput`), `noPreviews`, `PreviewNotYet`, the input protocols, `PreviewHome`/`homeOf` |
| `src/directStream/previews/plan.ts` | create | the sheet plan and the cue list from finished sheets |
| `src/directStream/previews/sheetIndex.ts` | create | the on-disk index `previews.json` (zod-checked read, `*.part` then rename write) |
| `src/directStream/previews/builder.ts` | create | the ffmpeg sheet builder: injected spawn, niced, `-xerror`, the input whitelist and loopback check, time limit, abort, never makes a video's home, `*.part` then rename, JPEG check |
| `src/directStream/previews/queue.ts` | create | one build at a time, the session on screen first, bounded retries, ffmpeg missing stops all |
| `src/directStream/previews/local.ts` | create | `LocalSource`: a list from a `LocalVideo`'s finished sheets; sheet addresses |
| `src/directStream/previews/cacheSource.ts` | create | the cloud-cache `LocalVideo` (HLS and plain file, partial and whole) and its source |
| `src/directStream/previews/sources.ts` | create | the registry, asked in the order provider, torrent, cache |
| `src/directStream/previews/service.ts` | create | `StreamPreviews`: lists, `preview_rev`, what starts a build, the sweep; `buildStreamPreviews` |
| `src/directStream/sessions.ts:129-130`, `:202-203` | modify | `previewRev` on `StreamSession`, 0 at create |
| `src/directStream/service.ts:189`, `:1359-1361`, `:2401` | modify | `SessionInfo.preview_rev`; `peek(id)`; `passThroughFetch` |
| `src/directStream/cache/service.ts:61`, `:371` | modify | `CachePreviewRow`, `CachePreviewView`, `StreamCache.previewView()` |
| `src/directStream/cache/store.ts:109-127` | modify | `diskSize` counts every file under the folder |
| `src/config.ts:222`, `:226-231`, `:969`, `:1114` | modify | `previews` in `DirectStreamConfig`, its default, its parse, the key list |
| `src/deps.ts:31`, `:133` | modify | `AppDeps.streamPreviews` |
| `src/daemon.ts:58`, `:575` | modify | build `deps.streamPreviews` |
| `src/background.ts:239`, `:275` | modify | start the sweep; close the previews before every other closer (the cache and the torrents included) |
| `src/http/directStreamApi.ts:1-12`, `:88`, `:151`, `:231`, `:269`, `:283`, `:333-372` | modify | the two routes; `preview_rev` and `previews.reported` in the position route |
| `scripts/docs/httpRoutes.ts:248-249`, `:264` | modify | the two routes' entries; `preview_rev` in the session and position entries |
| `docs/guide/reference/http-api.md` | regenerate | `npm run docs:gen` |
| `docs/guide/reference/configuration.md:151` | modify | the `NOTESD_STREAM_PREVIEWS` row |
| `.claude/skills/verify-notesd/scripts/verify.sh:22`, `:370` | modify | `NOTESD_STREAM_PREVIEWS` off by default, a caller's `NOTESD_STREAM_PREVIEWS=on` passed through |
| `tests/unit/directStream/previews/fakes.ts` | create | fake ffmpeg, fake `LocalVideo`, a JPEG header |
| `tests/unit/directStream/previews/plan.test.ts` | create | the plan and the cues |
| `tests/unit/directStream/previews/builder.test.ts` | create | one sheet: kept, failed, timed out, missing, not yet, loopback only, a delete racing the build |
| `tests/unit/directStream/previews/service.test.ts` | create | one at a time, niced, retries, restart, `preview_rev`, source order, sweep |
| `tests/unit/directStream/previews/cacheSource.test.ts` | create | coverage, stretch playlist, only the cache the session plays from, plain file |
| `tests/unit/directStream/previews/routes.test.ts` | create | the two routes, previews off, the position answer |
| `tests/unit/directStream/previews/previews.ffmpeg.test.ts` | create | the real ffmpeg on a real HLS cache (skipped without ffmpeg) |
| `tests/unit/directStream/cache/diskSize.test.ts` | create | the size counts previews, the delete takes them |
| `tests/unit/config.streamCache.test.ts:12` | modify | `NOTESD_STREAM_PREVIEWS` parse |
| `tests/unit/config.test.ts:58` | modify | `previews: true` in the defaults |
| `tests/integration/movies.streams.int.test.ts:191`, `:303` | modify | `preview_rev: 0` in two exact position answers |

## Implementation Steps

Steps 1 to 9 add the module (nothing calls it yet: the tree builds and `npm test` passes after each). Steps 10 to 16
wire it in. Steps 17 to 19 are the docs and the harness pin. Steps 20 to 28 are the tests. Run
`npm run typecheck` after step 9 and after step 16.

### Step 1: The contract's types
**File:** `src/directStream/previews/types.ts` (new)
**Change:** the four types of the plan index's "Interface contract", verbatim (with the reconciled `PreviewInput`),
plus the additions phases 2 and 3 build on.
**Code:**
```ts
import path from 'node:path';
import type { StreamSession } from '../sessions.js';

/**
 * Seek previews (SEEK_PREVIEW_THUMBNAILS): the frames the player page shows over its timeline. PreviewCue,
 * PreviewList, PreviewSource and LocalVideo are the plan's fixed interface contract, shared with the player page
 * (phase 4) and the torrent (phase 2) and provider (phase 3) sources: they never change without the plan.
 */

export interface PreviewCue { start_s: number; end_s: number; url: string; x: number; y: number; w: number; h: number }
export interface PreviewList { state: 'none' | 'partial' | 'ready'; source: 'provider' | 'local' | null; cues: PreviewCue[] }

/** One source of frames. Asked in the order: provider, torrent, cache. The first that answers
 *  a list whose state is not 'none' is the session's list. */
export interface PreviewSource {
  readonly name: 'provider' | 'torrent' | 'cache';
  /** The frames this source has for the session now. Never throws; 'none' when it has nothing. */
  list(session: StreamSession): Promise<PreviewList>;
}

/** Video on this machine that sheets can be made from. Phase 1 builds from it; the cache source
 *  (phase 1) and the torrent source (phase 2) each describe their own. */
export interface LocalVideo {
  /** Stable for the same bytes across restarts; a folder name. */
  readonly key: string;
  /** Where the sheets and their index live (beside the video; made when missing). */
  readonly dir: string;
  readonly durationS: number;
  /** The stretches of the film that can be read now without any network: seconds. */
  coverage(): Promise<Array<[number, number]>>;
  /** ffmpeg input (and input arguments) for one stretch that coverage() said is there. Reading it
   *  must never fetch, select or wait for anything. */
  input(startS: number, endS: number): Promise<PreviewInput>;
}

/**
 * One stretch's ffmpeg input. `args` is the whole input section: input options, the seek to `startS` (`-ss`) and the
 * length `endS - startS` (`-t`), then `-i <address>`; the builder adds no seek of its own, so frame k of the sheet is
 * `startS + k × PREVIEW_INTERVAL_S`. `cleanup` runs after ffmpeg ended (it may throw PreviewNotYet). `loopback`: the
 * input reads this daemon's own 127.0.0.1 gate over http (a torrent file partly on disk, phase 2); only then does the
 * builder add `http,tcp` to the whitelist, and it refuses the input if any address is not `http://127.0.0.1`.
 */
export interface PreviewInput {
  args: string[];
  cleanup?: () => Promise<void>;
  loopback?: true;
}

/** A list with no frame: `cues` empty and `source` null, always together. A fresh object each call. */
export function noPreviews(): PreviewList {
  return { state: 'none', source: null, cues: [] };
}

/**
 * Thrown by LocalVideo.input(), or by the `cleanup` it returned (after ffmpeg ended), when the stretch cannot be
 * read yet: a torrent piece that is not on disk (phase 2's gate refused or cut short a read). The sheet is left for a
 * later look, is never counted against its tries, and keeps nothing. From `cleanup` it counts only when ffmpeg failed:
 * a sheet ffmpeg made from the bytes it was served is kept. Any other error from `input()`, and every other failed
 * ffmpeg, counts against the sheet's tries.
 */
export class PreviewNotYet extends Error {
  override readonly name = 'PreviewNotYet';
}

/**
 * The only protocols a preview ffmpeg may open: files on this machine, the AES-128 layer over them, an inline key and
 * a `concat:` of files (a remux's init and segments, phase 2). The builder puts `-protocol_whitelist` before every
 * input, so whatever an input names, a build can never reach the network, a torrent's swarm or a route of this daemon.
 */
export const PREVIEW_INPUT_PROTOCOLS = 'file,crypto,data,concat';
/** Added only for an input with `loopback: true`; the builder then refuses every address that is not http://127.0.0.1. */
export const PREVIEW_LOOPBACK_PROTOCOLS = 'http,tcp';

/**
 * A LocalVideo may also name its `home`: the folder whose existence means its video is still on this machine (a
 * torrent's `<hash>/` folder). The builder makes `dir` inside it and never makes `home` itself, and it keeps a sheet
 * only while `home` and `dir` are still there, so a delete racing a build never brings a preview folder back.
 */
export interface PreviewHome {
  readonly home: string;
}

/** The video's home: the one it names, else the folder its `dir` is in (a cache's folder for `<cache>/previews`). */
export function homeOf(video: LocalVideo): string {
  const home = (video as Partial<PreviewHome>).home;
  return typeof home === 'string' ? home : path.dirname(video.dir);
}
```
**Impact:** none yet.

### Step 2: The sheet plan and the cues
**File:** `src/directStream/previews/plan.ts` (new)
**Code:**
```ts
import type { PreviewCue } from './types.js';

/** A frame every 10 s of film. */
export const PREVIEW_INTERVAL_S = 10;
/** Each frame is 240 px wide; its height follows the picture's shape (ffmpeg's scale=240:-2). */
export const PREVIEW_FRAME_WIDTH = 240;
export const PREVIEW_COLS = 6;
export const PREVIEW_ROWS = 6;
/** One sheet holds at most 6×6 frames: 360 s of film. */
export const SHEET_SPAN_S = PREVIEW_INTERVAL_S * PREVIEW_COLS * PREVIEW_ROWS;
/** A last stretch shorter than this makes no sheet (its seconds show the time alone). */
export const PREVIEW_MIN_STRETCH_S = 2;
/** How far a stretch on disk may fall short of a sheet's edge and still count (playlist times are rounded). */
const EDGE_S = 0.5;

export const SHEET_NAME = /^sheet-\d{5}\.jpg$/;

/** One sheet to make: frames `startS`, `startS + 10`, ... below `endS`. */
export interface SheetSpec {
  index: number;
  name: string;
  startS: number;
  endS: number;
  frames: number;
}

/** One finished sheet, as the index on disk keeps it. `frame_w` x `frame_h` is one frame's rectangle in pixels. */
export interface SheetRecord {
  index: number;
  name: string;
  start_s: number;
  end_s: number;
  frames: number;
  frame_w: number;
  frame_h: number;
}

export function sheetName(index: number): string {
  return `sheet-${String(index).padStart(5, '0')}.jpg`;
}

/** Every sheet of a film `durationS` long, in order; [] for an unknown or empty length. */
export function planSheets(durationS: number): SheetSpec[] {
  const out: SheetSpec[] = [];
  if (!(durationS > 0)) return out;
  for (let index = 0; index * SHEET_SPAN_S < durationS; index += 1) {
    const startS = index * SHEET_SPAN_S;
    const endS = Math.min(startS + SHEET_SPAN_S, durationS);
    if (index > 0 && endS - startS < PREVIEW_MIN_STRETCH_S) break;
    out.push({ index, name: sheetName(index), startS, endS, frames: Math.ceil((endS - startS) / PREVIEW_INTERVAL_S) });
  }
  return out;
}

/** True when one stretch of `coverage` holds the sheet's whole stretch: a sheet is made only then. */
export function covered(sheet: Pick<SheetSpec, 'startS' | 'endS'>, coverage: ReadonlyArray<readonly [number, number]>): boolean {
  return coverage.some(([a, b]) => a <= sheet.startS + EDGE_S && b >= sheet.endS - EDGE_S);
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

/** The cues of finished sheets: one per frame, sorted, never overlapping (sheets never do), gaps where none is made. */
export function cuesOf(sheets: readonly SheetRecord[], urlOf: (name: string) => string): PreviewCue[] {
  const cues: PreviewCue[] = [];
  for (const sheet of sheets) {
    const url = urlOf(sheet.name);
    for (let k = 0; k < sheet.frames; k += 1) {
      const start = sheet.start_s + k * PREVIEW_INTERVAL_S;
      if (start >= sheet.end_s) break;
      cues.push({
        start_s: round(start),
        end_s: round(Math.min(start + PREVIEW_INTERVAL_S, sheet.end_s)),
        url,
        x: (k % PREVIEW_COLS) * sheet.frame_w,
        y: Math.floor(k / PREVIEW_COLS) * sheet.frame_h,
        w: sheet.frame_w,
        h: sheet.frame_h,
      });
    }
  }
  return cues.sort((a, b) => a.start_s - b.start_s);
}
```

### Step 3: The on-disk index of finished sheets
**File:** `src/directStream/previews/sheetIndex.ts` (new)
**Change:** `previews.json` in `LocalVideo.dir` is read through zod once (a file is outside input), and only
sheets whose JPEG is still there count. One writer: the queue, one job at a time.
**Code:**
```ts
import { randomBytes } from 'node:crypto';
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { PREVIEW_COLS, PREVIEW_INTERVAL_S, PREVIEW_ROWS, SHEET_NAME, type SheetRecord } from './plan.js';
import type { LocalVideo } from './types.js';

/** The index beside the sheets: which sheets are finished, and each frame's size. */
export const PREVIEW_INDEX_FILE = 'previews.json';

const sheetSchema = z.object({
  index: z.number().int().min(0),
  name: z.string().regex(SHEET_NAME),
  start_s: z.number().min(0),
  end_s: z.number().positive(),
  frames: z.number().int().min(1).max(PREVIEW_COLS * PREVIEW_ROWS),
  frame_w: z.number().int().positive(),
  frame_h: z.number().int().positive(),
});

const indexSchema = z.object({
  version: z.literal(1),
  key: z.string(),
  duration_s: z.number().positive(),
  interval_s: z.number().positive(),
  sheets: z.array(sheetSchema),
});

type IndexedVideo = Pick<LocalVideo, 'key' | 'dir' | 'durationS'>;

/**
 * The finished sheets of `video`, in order. An index of another video (key), another length (more than 1 s off)
 * or another interval counts as none; a sheet whose file is gone is left out. Never throws.
 */
export async function readSheets(video: IndexedVideo): Promise<SheetRecord[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(video.dir, PREVIEW_INDEX_FILE), 'utf8'));
  } catch {
    return [];
  }
  const parsed = indexSchema.safeParse(raw);
  if (!parsed.success) return [];
  const file = parsed.data;
  if (file.key !== video.key || file.interval_s !== PREVIEW_INTERVAL_S || Math.abs(file.duration_s - video.durationS) > 1) return [];
  let names: Set<string>;
  try {
    names = new Set(await readdir(video.dir));
  } catch {
    return [];
  }
  return file.sheets.filter((s) => names.has(s.name)).sort((a, b) => a.index - b.index);
}

/** Records one finished sheet (replacing an older record of the same index): a temporary name, then rename. */
export async function addSheet(video: IndexedVideo, record: SheetRecord): Promise<void> {
  const sheets = [...(await readSheets(video)).filter((s) => s.index !== record.index), record].sort((a, b) => a.index - b.index);
  const final = path.join(video.dir, PREVIEW_INDEX_FILE);
  const tmp = `${final}.${randomBytes(4).toString('hex')}.part`;
  const body = { version: 1, key: video.key, duration_s: video.durationS, interval_s: PREVIEW_INTERVAL_S, sheets };
  try {
    await writeFile(tmp, `${JSON.stringify(body)}\n`);
    await rename(tmp, final);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
```

### Step 4: The ffmpeg sheet builder
**File:** `src/directStream/previews/builder.ts` (new)
**Change:** one sheet per call. The stretch must be on disk and the video's home must exist (checked first: nothing
is spawned and no folder is made otherwise); `dir` is made inside the home, never the home itself. The input is
checked (`refusedInput`) before anything runs. The process is reniced to 19 right after spawn, runs with `-xerror`
(a failed read is a non-zero exit, never a sheet made from what was not read), is killed past the time limit or on
abort, writes to `*.part`, and `cleanup()` is awaited before anything is kept. A sheet is renamed into place only
when ffmpeg exited 0, the JPEG parses, and the home and `dir` are still there (a delete racing the build keeps
nothing and makes nothing again). `-protocol_whitelist file,crypto,data,concat` precedes every input (plus `http,tcp`
for a `loopback` input, whose addresses must all be `http://127.0.0.1`), so no build can reach another host.
`-skip_frame nokey` decodes keyframes only (a sheet of 360 s takes well under a second at 320x180, a few seconds at
1080p). Seek convention (the contract's `PreviewInput`): the input's own args carry `-ss`/`-t`; the builder adds none.
**Code:**
```ts
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, rmdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { covered, PREVIEW_COLS, PREVIEW_FRAME_WIDTH, PREVIEW_INTERVAL_S, PREVIEW_ROWS, type SheetRecord, type SheetSpec } from './plan.js';
import { homeOf, PREVIEW_INPUT_PROTOCOLS, PREVIEW_LOOPBACK_PROTOCOLS, PreviewNotYet, type LocalVideo, type PreviewInput } from './types.js';

/** The CPU priority every preview ffmpeg runs at: the lowest. */
export const PREVIEW_NICENESS = 19;
/** A sheet's ffmpeg past this is killed and the sheet counts as failed. */
export const PREVIEW_SHEET_TIME_LIMIT_MS = 120_000;
const STDERR_TAIL_CHARS = 600;

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function isDir(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** One ffmpeg run, as the builder sees it. */
export interface PreviewProcess {
  /** The OS process id; null when the binary could not be started at all. */
  readonly pid: number | null;
  /** The exit code; -1 when it could not start (startError says why), null when a signal ended it. */
  readonly exited: Promise<number | null>;
  /** Why it could not start (code `ENOENT`: no such binary); null otherwise. */
  startError(): NodeJS.ErrnoException | null;
  stderrTail(): string;
  /** SIGKILL: a preview is never worth waiting for. */
  kill(): void;
}

export type SpawnPreview = (args: readonly string[]) => PreviewProcess;

/** The real ffmpeg. stdout is ignored, the tail of stderr is kept for the log line. */
export function ffmpegPreviewSpawner(bin: string): SpawnPreview {
  return (args) => {
    const child = spawn(bin, [...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    const state: { tail: string; startError: NodeJS.ErrnoException | null } = { tail: '', startError: null };
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (text: string) => {
      state.tail = (state.tail + text).slice(-STDERR_TAIL_CHARS);
    });
    const exited = new Promise<number | null>((resolve) => {
      child.once('error', (err: NodeJS.ErrnoException) => {
        state.startError = err;
        resolve(-1);
      });
      child.once('close', (code) => resolve(code));
    });
    return {
      pid: child.pid ?? null,
      exited,
      startError: () => state.startError,
      stderrTail: () => state.tail.trim(),
      kill: () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      },
    };
  };
}

/** The `-protocol_whitelist` of one input: files only, or (a `loopback` input) also http over tcp. */
export function inputProtocols(loopback: boolean): string {
  return loopback ? `${PREVIEW_INPUT_PROTOCOLS},${PREVIEW_LOOPBACK_PROTOCOLS}` : PREVIEW_INPUT_PROTOCOLS;
}

/**
 * Why an input may not run, or null. Every address it opens (each value after `-i`) must be a path, a `file:` or a
 * `concat:` of paths; with `loopback`, also `http://127.0.0.1` (this daemon's own gate), never another host.
 */
export function refusedInput(args: readonly string[], loopback: boolean): string | null {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '-i') continue;
    const target = args[i + 1] ?? '';
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(target)?.[1]?.toLowerCase() ?? null;
    if (scheme === null || scheme === 'file' || scheme === 'concat') continue;
    if (scheme === 'http' && loopback) {
      let host = '';
      try {
        host = new URL(target).hostname;
      } catch {
        // not an address: refused below
      }
      if (host === '127.0.0.1') continue;
    }
    return `the input opens ${scheme}: on ${loopback ? 'a host that is not 127.0.0.1' : 'no file of this machine'}, and is not run`;
  }
  return null;
}

/** ffmpeg's arguments for one sheet: the input as LocalVideo.input gave it, one 6×6 JPEG of a frame every 10 s, to `out`. */
export function sheetArgs(input: readonly string[], out: string, loopback = false): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-xerror',
    '-y',
    '-threads',
    '1',
    '-skip_frame',
    'nokey',
    '-protocol_whitelist',
    inputProtocols(loopback),
    ...input,
    '-an',
    '-sn',
    '-dn',
    '-vf',
    `fps=1/${PREVIEW_INTERVAL_S},scale=${PREVIEW_FRAME_WIDTH}:-2,tile=${PREVIEW_COLS}x${PREVIEW_ROWS}`,
    '-frames:v',
    '1',
    '-c:v',
    'mjpeg',
    '-q:v',
    '5',
    '-pix_fmt',
    'yuvj420p',
    '-f',
    'mjpeg',
    out,
  ];
}

/** A JPEG's size from its first SOF marker; null for anything that is not a JPEG. */
export function jpegSize(data: Uint8Array): { width: number; height: number } | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let at = 2;
  while (at + 3 < data.length) {
    if (data[at] !== 0xff) return null;
    const marker = data[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = ((data[at + 2] ?? 0) << 8) | (data[at + 3] ?? 0);
    if (length < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 8 >= data.length) return null;
      const height = ((data[at + 5] ?? 0) << 8) | (data[at + 6] ?? 0);
      const width = ((data[at + 7] ?? 0) << 8) | (data[at + 8] ?? 0);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    at += 2 + length;
  }
  return null;
}

/** How one sheet ended. Only `made` leaves a file; every other outcome leaves no part of the sheet. */
export type SheetOutcome =
  | { kind: 'made'; record: SheetRecord; tookMs: number; nice: number | null }
  | { kind: 'not_yet'; detail: string }
  | { kind: 'failed'; detail: string }
  | { kind: 'no_ffmpeg'; detail: string }
  | { kind: 'aborted' };

export interface SheetBuilderOptions {
  spawn: SpawnPreview;
  /** For log lines only. */
  ffmpegBin: string;
  /** os.setPriority; a test's seam. */
  setPriority?: (pid: number, priority: number) => void;
  /** os.getPriority; a test's seam. */
  getPriority?: (pid: number) => number;
  timeLimitMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

/** Makes one sheet at a time (PreviewQueue never asks for two at once). */
export class SheetBuilder {
  /** Folders whose leftover `*.part` files (a run a restart cut short) were deleted this run. */
  private readonly swept = new Set<string>();

  constructor(private readonly opts: SheetBuilderOptions) {}

  get ffmpegBin(): string {
    return this.opts.ffmpegBin;
  }

  async build(video: LocalVideo, sheet: SheetSpec, signal: AbortSignal): Promise<SheetOutcome> {
    // Read again now: a cache deleted since the job was queued has no coverage, and its folder is not made again.
    if (!covered(sheet, await video.coverage())) return { kind: 'not_yet', detail: 'the stretch is not on this machine' };
    if (!(await this.prepare(video))) return { kind: 'not_yet', detail: 'the video\'s folder is gone' };
    const final = path.join(video.dir, sheet.name);
    const tmp = `${final}.${randomBytes(4).toString('hex')}.part`;
    const drop = (): Promise<void> => rm(tmp, { force: true });
    let input: PreviewInput;
    try {
      input = await video.input(sheet.startS, sheet.endS);
    } catch (err) {
      return err instanceof PreviewNotYet ? { kind: 'not_yet', detail: err.message } : { kind: 'failed', detail: `the stretch could not be opened: ${messageOf(err)}` };
    }
    const loopback = input.loopback === true;
    const refusal = refusedInput(input.args, loopback);
    if (refusal !== null) {
      await input.cleanup?.().catch(() => undefined);
      return { kind: 'failed', detail: refusal };
    }
    const now = this.opts.now ?? Date.now;
    const started = now();
    const timeLimitMs = this.opts.timeLimitMs ?? PREVIEW_SHEET_TIME_LIMIT_MS;
    const proc = this.opts.spawn(sheetArgs(input.args, tmp, loopback));
    const nice = proc.pid === null ? null : this.lower(proc.pid);
    const run = { timedOut: false };
    const timer = setTimeout(() => {
      run.timedOut = true;
      proc.kill();
    }, timeLimitMs);
    const onAbort = (): void => proc.kill();
    signal.addEventListener('abort', onAbort, { once: true });
    let code: number | null;
    try {
      code = await proc.exited;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
    let notYet: string | null = null;
    if (input.cleanup !== undefined) {
      try {
        await input.cleanup();
      } catch (err) {
        if (err instanceof PreviewNotYet) notYet = err.message;
        else this.log(`[notesd] previews: could not clean up after ${sheet.name} of ${video.key}: ${messageOf(err)}`);
      }
    }
    const startError = proc.startError();
    if (startError?.code === 'ENOENT') {
      await drop();
      return { kind: 'no_ffmpeg', detail: startError.message };
    }
    if (signal.aborted) {
      await drop();
      return { kind: 'aborted' };
    }
    if (run.timedOut) {
      await drop();
      return { kind: 'failed', detail: `ffmpeg ran past ${Math.round(timeLimitMs / 1000)} s and was stopped` };
    }
    if (!(await this.stillThere(video))) {
      // The video was deleted while ffmpeg ran: nothing is kept and no folder is made again.
      await drop();
      await rmdir(video.dir).catch(() => undefined);
      return { kind: 'not_yet', detail: 'the video was deleted while its sheet was made' };
    }
    if (code !== 0) {
      await drop();
      // A read the input's gate refused or cut short (PreviewNotYet from cleanup) is "not yet", never a try used up.
      if (notYet !== null) return { kind: 'not_yet', detail: notYet };
      const tail = proc.stderrTail();
      return { kind: 'failed', detail: `ffmpeg exited with ${code ?? 'a signal'}${tail === '' ? '' : `: ${tail}`}` };
    }
    let size: { width: number; height: number } | null;
    try {
      size = jpegSize(await readFile(tmp));
    } catch {
      size = null;
    }
    if (size === null || size.width < PREVIEW_COLS || size.height < PREVIEW_ROWS) {
      await drop();
      return { kind: 'failed', detail: 'ffmpeg wrote no picture' };
    }
    try {
      await rename(tmp, final);
    } catch (err) {
      await drop();
      return { kind: 'failed', detail: `the sheet could not be kept: ${messageOf(err)}` };
    }
    return {
      kind: 'made',
      record: {
        index: sheet.index,
        name: sheet.name,
        start_s: sheet.startS,
        end_s: sheet.endS,
        frames: sheet.frames,
        frame_w: Math.floor(size.width / PREVIEW_COLS),
        frame_h: Math.floor(size.height / PREVIEW_ROWS),
      },
      tookMs: now() - started,
      nice,
    };
  }

  /**
   * Makes `dir` one level at a time inside the video's home, never the home itself: false (nothing made) when the home
   * is gone. The first time this run, deletes the `*.part` files a stopped run left in `dir`.
   */
  private async prepare(video: LocalVideo): Promise<boolean> {
    const home = homeOf(video);
    if (!(await isDir(home))) return false;
    const rel = path.relative(home, video.dir);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
    let at = home;
    for (const part of rel === '' ? [] : rel.split(path.sep)) {
      at = path.join(at, part);
      await mkdir(at).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'EEXIST') throw err;
      });
    }
    const dir = video.dir;
    if (this.swept.has(dir)) return true;
    this.swept.add(dir);
    for (const name of await readdir(dir)) if (name.endsWith('.part')) await rm(path.join(dir, name), { force: true });
    return true;
  }

  /** The video's home and its sheets' folder are both still on disk (checked before a sheet is kept). */
  private async stillThere(video: LocalVideo): Promise<boolean> {
    return (await isDir(homeOf(video))) && (await isDir(video.dir));
  }

  /** Lowers the process to PREVIEW_NICENESS and answers the niceness it runs at (what was set when it ended already). */
  private lower(pid: number): number | null {
    try {
      (this.opts.setPriority ?? ((p: number, n: number) => os.setPriority(p, n)))(pid, PREVIEW_NICENESS);
    } catch (err) {
      this.log(`[notesd] previews: could not lower the priority of ffmpeg ${pid}: ${messageOf(err)}`);
      return null;
    }
    try {
      return (this.opts.getPriority ?? ((p: number) => os.getPriority(p)))(pid);
    } catch {
      return PREVIEW_NICENESS;
    }
  }

  private log(line: string): void {
    (this.opts.log ?? ((l: string) => console.log(l)))(line);
  }
}
```
**Impact:** none yet.

### Step 5: The one-at-a-time queue
**File:** `src/directStream/previews/queue.ts` (new)
**Change:** at most one `build` runs; a job of the focused video (the session on screen) goes first; a failed sheet
is tried again after `PREVIEW_RETRY_MS`, at most `PREVIEW_MAX_TRIES` times per daemon run; a missing ffmpeg stops
every build until a restart (one log line). A made sheet is recorded in the index, then `onMade` is called.
**Code:**
```ts
import type { SheetBuilder } from './builder.js';
import { planSheets, type SheetSpec } from './plan.js';
import { addSheet } from './sheetIndex.js';
import type { LocalVideo } from './types.js';

/** Tries of one sheet in one daemon run: the first and two more. */
export const PREVIEW_MAX_TRIES = 3;
/** A failed sheet is tried again this long after. */
export const PREVIEW_RETRY_MS = 20_000;

interface Job {
  video: LocalVideo;
  sheet: SheetSpec;
  /** Not before this time (ms): a failed sheet waits PREVIEW_RETRY_MS. */
  dueAt: number;
}

const jobId = (key: string, index: number): string => `${key}#${index}`;
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface PreviewQueueOptions {
  builder: SheetBuilder;
  /** A sheet of `video` was made and recorded. */
  onMade: (video: LocalVideo) => void;
  now?: () => number;
  log?: (line: string) => void;
  retryMs?: number;
  maxTries?: number;
}

export class PreviewQueue {
  private jobs: Job[] = [];
  private running: { id: string; abort: AbortController; done: Promise<void> } | null = null;
  private readonly tries = new Map<string, number>();
  private focusKey: string | null = null;
  private noFfmpeg = false;
  private closed = false;
  private wake: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: PreviewQueueOptions) {}

  /**
   * Queues the sheets of `video` that are not queued, running or out of tries. `front`: `video` is the session on
   * screen's, whose jobs go before every other. Answers how many were added (0 once ffmpeg was found missing).
   */
  want(video: LocalVideo, sheets: readonly SheetSpec[], front: boolean): number {
    if (this.closed || this.noFfmpeg) return 0;
    if (front) this.focusKey = video.key;
    let added = 0;
    for (const sheet of sheets) {
      const id = jobId(video.key, sheet.index);
      if ((this.tries.get(id) ?? 0) >= this.maxTries) continue;
      if (this.running?.id === id || this.jobs.some((j) => jobId(j.video.key, j.sheet.index) === id)) continue;
      this.jobs.push({ video, sheet, dueAt: 0 });
      added += 1;
    }
    this.pump();
    return added;
  }

  /** Stops the running ffmpeg (no part of its sheet is kept), drops the rest and waits. */
  async close(): Promise<void> {
    this.closed = true;
    this.jobs = [];
    if (this.wake !== null) clearTimeout(this.wake);
    this.wake = null;
    const running = this.running;
    running?.abort.abort();
    await running?.done;
  }

  private get maxTries(): number {
    return this.opts.maxTries ?? PREVIEW_MAX_TRIES;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private log(line: string): void {
    (this.opts.log ?? ((l: string) => console.log(l)))(line);
  }

  private pump(): void {
    if (this.closed || this.noFfmpeg || this.running !== null) return;
    const now = this.now();
    const due = this.jobs.filter((j) => j.dueAt <= now);
    const next = due.find((j) => j.video.key === this.focusKey) ?? due[0];
    if (next === undefined) {
      this.armWake();
      return;
    }
    this.jobs = this.jobs.filter((j) => j !== next);
    const abort = new AbortController();
    const done = this.run(next, abort.signal)
      .catch((err: unknown) => this.log(`[notesd] previews: ${next.sheet.name} of ${next.video.key}: ${messageOf(err)}`))
      .finally(() => {
        this.running = null;
        this.pump();
      });
    this.running = { id: jobId(next.video.key, next.sheet.index), abort, done };
  }

  /** Wakes the queue when the earliest waiting retry is due. */
  private armWake(): void {
    if (this.wake !== null || this.jobs.length === 0 || this.closed) return;
    const at = Math.min(...this.jobs.map((j) => j.dueAt));
    this.wake = setTimeout(() => {
      this.wake = null;
      this.pump();
    }, Math.max(0, at - this.now()));
    this.wake.unref();
  }

  private async run(job: Job, signal: AbortSignal): Promise<void> {
    const { video, sheet } = job;
    const id = jobId(video.key, sheet.index);
    const label = `sheet ${sheet.index + 1}/${planSheets(video.durationS).length} of ${video.key}`;
    const outcome = await this.opts.builder.build(video, sheet, signal);
    switch (outcome.kind) {
      case 'made':
        try {
          await addSheet(video, outcome.record);
        } catch (err) {
          this.failed(job, label, `the index could not be written: ${messageOf(err)}`);
          return;
        }
        this.tries.delete(id);
        this.log(`[notesd] previews: made ${label} in ${(outcome.tookMs / 1000).toFixed(1)} s (nice ${outcome.nice ?? '?'})`);
        this.opts.onMade(video);
        return;
      case 'failed':
        this.failed(job, label, outcome.detail);
        return;
      case 'no_ffmpeg':
        this.noFfmpeg = true;
        this.jobs = [];
        this.log(`[notesd] previews: ffmpeg (${this.opts.builder.ffmpegBin}) was not found, so no seek previews are made until the daemon restarts`);
        return;
      case 'not_yet':
      case 'aborted':
        // Not yet: the next look at the session (or the next sweep) asks again. Aborted: the daemon is stopping.
        return;
    }
  }

  private failed(job: Job, label: string, detail: string): void {
    const id = jobId(job.video.key, job.sheet.index);
    const count = (this.tries.get(id) ?? 0) + 1;
    this.tries.set(id, count);
    if (count >= this.maxTries) {
      this.log(`[notesd] previews: giving up on ${label} after ${count} tries (${detail}); the play is not affected`);
      return;
    }
    const retryMs = this.opts.retryMs ?? PREVIEW_RETRY_MS;
    this.log(`[notesd] previews: ${label} failed (${detail}); trying again in ${Math.round(retryMs / 1000)} s`);
    this.jobs.push({ video: job.video, sheet: job.sheet, dueAt: this.now() + retryMs });
  }
}
```

### Step 6: The local source (the cache's now, the torrent's in phase 2)
**File:** `src/directStream/previews/local.ts` (new)
**Change:** a `PreviewSource` built from a `LocalVideos` lookup; its list is the finished sheets in the video's
index. Sheet addresses carry `k=<8 hex of the video key>` so a session moved to another video never shows a stale
cached picture.
**Code:**
```ts
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { StreamSession } from '../sessions.js';
import { cuesOf, planSheets } from './plan.js';
import { readSheets } from './sheetIndex.js';
import { noPreviews, type LocalVideo, type PreviewList, type PreviewSource } from './types.js';

/** Where a local source finds video on this machine. Phase 1: the stream cache (cacheSource.ts); phase 2: torrents. */
export interface LocalVideos {
  /** The video a session's film can be previewed from, or null. */
  forSession(session: StreamSession): Promise<LocalVideo | null>;
  /** The videos whole on this machine, whatever plays: the sweep makes what sheets they lack. */
  whole(): Promise<LocalVideo[]>;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A source whose frames are sheets made on this machine. Never throws. */
export class LocalSource implements PreviewSource {
  constructor(
    readonly name: 'torrent' | 'cache',
    private readonly videos: LocalVideos,
    private readonly log: (line: string) => void,
  ) {}

  async list(session: StreamSession): Promise<PreviewList> {
    const video = await this.video(session);
    if (video === null) return noPreviews();
    try {
      return await localList(session.id, video);
    } catch (err) {
      this.log(`[notesd] previews: the ${this.name} sheets of ${video.key} could not be read: ${messageOf(err)}`);
      return noPreviews();
    }
  }

  async video(session: StreamSession): Promise<LocalVideo | null> {
    try {
      return await this.videos.forSession(session);
    } catch (err) {
      this.log(`[notesd] previews: could not look for ${this.name} video of session ${session.id.slice(0, 6)}: ${messageOf(err)}`);
      return null;
    }
  }

  async whole(): Promise<LocalVideo[]> {
    try {
      return await this.videos.whole();
    } catch (err) {
      this.log(`[notesd] previews: could not list the ${this.name} videos on disk: ${messageOf(err)}`);
      return [];
    }
  }
}

/** 8 hex characters naming a video in a sheet's address (`k=`). */
export function keyTag(key: string): string {
  return createHash('sha1').update(key).digest('hex').slice(0, 8);
}

/** A sheet's same-origin address: the route GET /api/stream/sessions/:id/previews/:name. */
export function sheetUrl(sessionId: string, name: string, tag: string): string {
  return `/api/stream/sessions/${sessionId}/previews/${name}?k=${tag}`;
}

/** The list of a video's finished sheets: `ready` once every sheet of the film is made. */
export async function localList(sessionId: string, video: LocalVideo): Promise<PreviewList> {
  const sheets = await readSheets(video);
  if (sheets.length === 0) return noPreviews();
  const tag = keyTag(video.key);
  return {
    state: sheets.length >= planSheets(video.durationS).length ? 'ready' : 'partial',
    source: 'local',
    cues: cuesOf(sheets, (name) => sheetUrl(sessionId, name, tag)),
  };
}

export async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}
```

### Step 7: What the previews read of the stream cache
**File:** `src/directStream/cache/service.ts:61` (after `CachePlayData`) and `:371` (after `diskUsage`)
**Change:** a narrow, read-only view: this host's caches whose source is known, their folders and their signature.
No new writer of `stream_caches`.
**Code (after line 61):**
```ts
/** A cache as the seek previews read it (src/directStream/previews/cacheSource.ts): this host's only. */
export interface CachePreviewRow {
  id: string;
  state: 'downloading' | 'ready' | 'failed';
  manifestKind: NonNullable<StreamCacheRow['manifestKind']>;
}

/** StreamCache.previewView(): what the previews' cache source reads, and nothing it could write. */
export interface CachePreviewView {
  /** The cache's folder (`<root>/<id>`), whether or not it exists. */
  folder(id: string): string;
  /** This host's cache with this id and a known source, or null (the other host's included). */
  get(id: string): Promise<CachePreviewRow | null>;
  /** This host's ready caches with a known source. */
  ready(): Promise<CachePreviewRow[]>;
  /** The source signature in the folder's cache.json; null without one. */
  signature(id: string): Promise<string | null>;
}
```
**Code (after `diskUsage`, line 371):**
```ts
  /** The seek previews' view of this host's caches (src/directStream/previews/cacheSource.ts). */
  previewView(): CachePreviewView {
    const own = (row: StreamCacheRow | null): CachePreviewRow | null =>
      row === null || row.host !== this.host || row.manifestKind === null ? null : { id: row.id, state: row.state, manifestKind: row.manifestKind };
    return {
      folder: (id) => this.store.dir(id),
      get: async (id) => own(await this.rowOf(id)),
      ready: async () => (await this.repo.caches()).filter((row) => row.state === 'ready').map(own).filter((row): row is CachePreviewRow => row !== null),
      signature: async (id) => (await this.store.readMeta(id))?.signature ?? null,
    };
  }
```
**Impact:** none on the cache's behaviour.

### Step 8: The cloud-cache source and its LocalVideo
**File:** `src/directStream/previews/cacheSource.ts` (new)
**Change:** a session's cache is the one it plays from (`session.cache`, what `SessionInfo.cached` names) and no
other: a pass-through session, even of a title this host has a cache of, and a torrent session get none from this
source (reconciler's decision: a cache filled from another provider may be offset in time, and R1.6 wants a frame
within one interval of the position; a pass-through session moved onto its cache by `cacheSession` has
`session.cache` set and gets it). Sheets live in `<cache folder>/previews/`, so every delete of
the cache folder takes them. An HLS cache (partial or whole) is covered by its segments on disk (with their init and
key files); a stretch is read through a temporary playlist of only that stretch's segments (absolute paths, the
media sequence kept for keys without an IV), so ffmpeg can never ask for a segment that is missing. A plain file
counts only once it is joined (`ready`): its chunks are not times, as `StreamCache.map` says too; its length comes
from ffprobe once per cache.
**Code:**
```ts
import { randomBytes } from 'node:crypto';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CachePreviewRow, CachePreviewView } from '../cache/service.js';
import type { StreamSession } from '../sessions.js';
import { ffprobeFile } from '../torrent/probe.js';
import { isFile, keyTag, LocalSource, type LocalVideos } from './local.js';
import type { PreviewSourceDeps } from './sources.js';
import { PreviewNotYet, type LocalVideo, type PreviewSource } from './types.js';

/** A cache's sheets and their index: `<cache folder>/previews/`. Deleted with the folder. */
export const CACHE_PREVIEWS_SUBDIR = 'previews';
const PROBE_TIMEOUT_MS = 30_000;
/** A file name inside the cache's folder: never a path, never an address. */
const LOCAL_NAME = /^[A-Za-z0-9._-]+$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** One segment of the cache's video playlist. */
export interface CacheSegment {
  name: string;
  startS: number;
  endS: number;
  /** Its media sequence number (a key without IV is derived from it). */
  seq: number;
  /** The #EXT-X-KEY line in force, or null (none, or METHOD=NONE). */
  key: string | null;
  /** The EXT-X-MAP URI in force, or null. */
  map: string | null;
  discontinuity: boolean;
  /** The local files it needs besides itself: its init section and its key. */
  needs: string[];
}

export interface CachePlaylist {
  version: number;
  targetDuration: number;
  segments: CacheSegment[];
  durationS: number;
}

const uriOf = (line: string): string | null => /URI="([^"]*)"/.exec(line)?.[1] ?? null;

/** The cache's `video.m3u8` (cache/hls.ts localMediaPlaylist); null when it names no local segment. */
export function parseCachePlaylist(text: string): CachePlaylist | null {
  let version = 3;
  let targetDuration = 10;
  let sequence = 0;
  let key: string | null = null;
  let map: string | null = null;
  let discontinuity = false;
  let length: number | null = null;
  let at = 0;
  let position = 0;
  const segments: CacheSegment[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const tag = /^(#EXT[A-Z0-9-]*):?(.*)$/.exec(line);
    if (tag !== null) {
      const name = tag[1] ?? '';
      const value = tag[2] ?? '';
      if (name === '#EXT-X-VERSION') version = Number(value) || version;
      else if (name === '#EXT-X-TARGETDURATION') targetDuration = Number(value) || targetDuration;
      else if (name === '#EXT-X-MEDIA-SEQUENCE') sequence = Number(value) || 0;
      else if (name === '#EXT-X-KEY') key = /METHOD=NONE/.test(value) ? null : line;
      else if (name === '#EXT-X-MAP') map = uriOf(value);
      else if (name === '#EXT-X-DISCONTINUITY') discontinuity = true;
      else if (name === '#EXTINF') {
        const d = Number.parseFloat(value);
        length = Number.isFinite(d) && d >= 0 ? d : null;
      }
      continue;
    }
    if (line.startsWith('#') || length === null) continue;
    const end = at + length;
    if (LOCAL_NAME.test(line)) {
      const needs = [map, key === null ? null : uriOf(key)].filter((n): n is string => n !== null && LOCAL_NAME.test(n));
      segments.push({ name: line, startS: at, endS: end, seq: sequence + position, key, map, discontinuity, needs });
    }
    at = end;
    position += 1;
    length = null;
    discontinuity = false;
  }
  return segments.length === 0 ? null : { version, targetDuration, segments, durationS: Math.round(at * 1000) / 1000 };
}

/** The stretches whose segments, init sections and keys are all in `names`, merged where they touch. */
export function segmentCoverage(segments: readonly CacheSegment[], names: ReadonlySet<string>): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const s of segments) {
    if (!names.has(s.name) || !s.needs.every((n) => names.has(n))) continue;
    const last = ranges.at(-1);
    if (last !== undefined && Math.abs(last[1] - s.startS) < 0.01) last[1] = s.endS;
    else ranges.push([s.startS, s.endS]);
  }
  return ranges;
}

const inFolder = (uri: string, folder: string): string => (SCHEME.test(uri) || path.isAbsolute(uri) ? uri : path.join(folder, uri));

/**
 * A VOD playlist of only the segments of [startS, endS), every file named by its absolute path, with the key and
 * init lines in force and the media sequence of its first segment; `offsetS` is where the stretch starts in it.
 * Null when no segment falls in the stretch.
 */
export function stretchPlaylist(playlist: CachePlaylist, folder: string, startS: number, endS: number): { text: string; offsetS: number } | null {
  const chosen = playlist.segments.filter((s) => s.endS > startS + 0.01 && s.startS < endS - 0.01);
  const first = chosen[0];
  if (first === undefined) return null;
  const lines = ['#EXTM3U', `#EXT-X-VERSION:${playlist.version}`, `#EXT-X-TARGETDURATION:${playlist.targetDuration}`, `#EXT-X-MEDIA-SEQUENCE:${first.seq}`, '#EXT-X-PLAYLIST-TYPE:VOD'];
  let key: string | null = null;
  let map: string | null = null;
  chosen.forEach((s, i) => {
    if (i > 0 && s.discontinuity) lines.push('#EXT-X-DISCONTINUITY');
    if (s.key !== key) {
      lines.push(s.key === null ? '#EXT-X-KEY:METHOD=NONE' : s.key.replace(/URI="([^"]*)"/, (_m, uri: string) => `URI="${inFolder(uri, folder)}"`));
      key = s.key;
    }
    if (s.map !== null && s.map !== map) lines.push(`#EXT-X-MAP:URI="${inFolder(s.map, folder)}"`);
    map = s.map;
    lines.push(`#EXTINF:${(s.endS - s.startS).toFixed(6)},`, path.join(folder, s.name));
  });
  lines.push('#EXT-X-ENDLIST', '');
  return { text: lines.join('\n'), offsetS: Math.max(0, startS - first.startS) };
}

const seconds = (n: number): string => n.toFixed(3);

/** An HLS cache: its segments on disk, read one stretch at a time. */
class HlsCacheVideo implements LocalVideo {
  readonly durationS: number;

  constructor(
    readonly key: string,
    readonly dir: string,
    private readonly folder: string,
    private readonly playlist: CachePlaylist,
  ) {
    this.durationS = playlist.durationS;
  }

  async coverage(): Promise<Array<[number, number]>> {
    let names: Set<string>;
    try {
      names = new Set(await readdir(this.folder));
    } catch {
      return [];
    }
    return segmentCoverage(this.playlist.segments, names);
  }

  async input(startS: number, endS: number): Promise<{ args: string[]; cleanup: () => Promise<void> }> {
    const stretch = stretchPlaylist(this.playlist, this.folder, startS, endS);
    if (stretch === null) throw new PreviewNotYet('no segment of the cache falls in that stretch');
    const file = path.join(this.dir, `stretch-${randomBytes(4).toString('hex')}.m3u8.part`);
    await writeFile(file, stretch.text);
    return {
      args: ['-f', 'hls', '-allowed_extensions', 'ALL', '-ss', seconds(stretch.offsetS), '-t', seconds(endS - startS), '-i', file],
      cleanup: () => rm(file, { force: true }),
    };
  }
}

/** A plain-file cache once joined into `video.mp4`. */
class Mp4CacheVideo implements LocalVideo {
  constructor(
    readonly key: string,
    readonly dir: string,
    private readonly file: string,
    readonly durationS: number,
  ) {}

  async coverage(): Promise<Array<[number, number]>> {
    return (await isFile(this.file)) ? [[0, this.durationS]] : [];
  }

  async input(startS: number, endS: number): Promise<{ args: string[] }> {
    return { args: ['-ss', seconds(startS), '-t', seconds(endS - startS), '-i', this.file] };
  }
}

export interface CacheVideosOptions {
  /** A plain file's length in seconds; null when it cannot be read. */
  probeDuration: (file: string) => Promise<number | null>;
  log: (line: string) => void;
}

/** The stream caches of this host as previewable video. */
export class CacheVideos implements LocalVideos {
  private readonly durations = new Map<string, number>();
  private readonly unreadable = new Set<string>();

  constructor(
    private readonly caches: CachePreviewView,
    private readonly opts: CacheVideosOptions,
  ) {}

  /**
   * The cache the session plays from (its `cached`), and no other: none for a pass-through or a torrent session, so a
   * frame never comes from a copy of the film whose timeline may be offset from the one on screen.
   */
  async forSession(session: StreamSession): Promise<LocalVideo | null> {
    if (session.cache === null) return null;
    const row = await this.caches.get(session.cache.id);
    return row === null ? null : this.videoOf(row);
  }

  async whole(): Promise<LocalVideo[]> {
    const out: LocalVideo[] = [];
    for (const row of await this.caches.ready()) {
      const video = await this.videoOf(row);
      if (video !== null) out.push(video);
    }
    return out;
  }

  private async videoOf(row: CachePreviewRow): Promise<LocalVideo | null> {
    const folder = this.caches.folder(row.id);
    const key = `cache-${row.id}-${keyTag((await this.caches.signature(row.id)) ?? 'unsigned')}`;
    const dir = path.join(folder, CACHE_PREVIEWS_SUBDIR);
    if (row.manifestKind === 'hls') {
      let text: string;
      try {
        text = await readFile(path.join(folder, 'video.m3u8'), 'utf8');
      } catch {
        return null;
      }
      const playlist = parseCachePlaylist(text);
      return playlist === null || playlist.durationS <= 0 ? null : new HlsCacheVideo(key, dir, folder, playlist);
    }
    const file = path.join(folder, 'video.mp4');
    if (row.state !== 'ready' || !(await isFile(file))) return null;
    const durationS = await this.mp4Duration(row.id, file);
    return durationS === null ? null : new Mp4CacheVideo(key, dir, file, durationS);
  }

  private async mp4Duration(id: string, file: string): Promise<number | null> {
    const known = this.durations.get(id);
    if (known !== undefined) return known;
    if (this.unreadable.has(id)) return null;
    const durationS = await this.opts.probeDuration(file);
    if (durationS !== null && durationS > 0) {
      this.durations.set(id, durationS);
      return durationS;
    }
    this.unreadable.add(id);
    this.opts.log(`[notesd] previews: the length of the cached file ${id} could not be read; it gets no previews this run`);
    return null;
  }
}

/** ffprobe's length of a file on disk; null when it cannot say. */
export function ffprobeDuration(ffprobeBin: string): (file: string) => Promise<number | null> {
  const probe = ffprobeFile({ ffprobeBin });
  return async (file) => {
    try {
      return (await probe(file, PROBE_TIMEOUT_MS)).durationS;
    } catch {
      return null;
    }
  };
}

/** The registry's cache source (sources.ts); null without a stream cache. */
export function cacheSource(deps: PreviewSourceDeps): PreviewSource | null {
  const view = deps.streamCache?.previewView() ?? null;
  if (view === null) return null;
  const videos = new CacheVideos(view, { probeDuration: deps.probeDuration ?? ffprobeDuration(deps.config.movies.ffprobeBin), log: deps.log });
  return new LocalSource('cache', videos, deps.log);
}
```
**Impact:** `ffprobeFile` is imported from `torrent/probe.ts` read-only (no change there).

### Step 9: The source registry
**File:** `src/directStream/previews/sources.ts` (new)
**Change:** one list of factories in the asking order. `PreviewSourceDeps` carries everything phases 2 and 3 need
(the torrents, the pass-through's fetch, the change hook, the log), so each of them adds exactly one file, one import
and one line to `PREVIEW_SOURCES`, and neither edits `src/daemon.ts`. The list is written one factory per line so
each of their lines is its own.
**Code:**
```ts
import type { Config } from '../../config.js';
import type { StreamCache } from '../cache/service.js';
import type { FetchLike } from '../passThrough.js';
import type { DirectStreamService } from '../service.js';
import type { StreamSession } from '../sessions.js';
import type { TorrentStreams } from '../torrent/service.js';
import { cacheSource } from './cacheSource.js';
import type { PreviewSource } from './types.js';

/** What a source may read to build itself. Built once, in buildStreamPreviews. */
export interface PreviewSourceDeps {
  config: Config;
  directStream: DirectStreamService;
  /** This host's stream cache; null without one. */
  streamCache: Pick<StreamCache, 'previewView'> | null;
  /** This host's torrents (phase 2's source reads three read-only members of it); null with torrents off. */
  torrents: TorrentStreams | null;
  /** The pass-through's fetch (DirectStreamService.passThroughFetch; phase 3's source reads a provider's track with it). */
  fetch: FetchLike;
  /**
   * A source's list for `session` changed outside a list() call (phase 3: a provider's track was read). The
   * session is listed again; its `preview_rev` rises if the list differs (StreamPreviews.changed). Never throws.
   */
  changed: (session: StreamSession) => void;
  log: (line: string) => void;
  /** A plain file's length in seconds (test seam; default ffprobe). */
  probeDuration?: (file: string) => Promise<number | null>;
}

/** Builds one source, or null when what it reads is off. */
export type PreviewSourceFactory = (deps: PreviewSourceDeps) => PreviewSource | null;

/**
 * Every source of seek-preview frames, in the order a session's list is asked (types.ts PreviewSource): a
 * provider's own track (phase 3 puts `providerSource` first), a torrent's file or remux (phase 2 puts
 * `torrentSource` before the cache), then this machine's stream cache. Each source is one line here.
 */
export const PREVIEW_SOURCES: readonly PreviewSourceFactory[] = [
  cacheSource,
];

export function previewSources(deps: PreviewSourceDeps): PreviewSource[] {
  return PREVIEW_SOURCES.map((make) => make(deps)).filter((source): source is PreviewSource => source !== null);
}
```

### Step 10: The previews service: lists, `preview_rev`, what starts a build
**File:** `src/directStream/previews/service.ts` (new)
**Change:** `list` asks the sources in order and raises the session's `previewRev` whenever the list differs from
the last one that session was given: the one place `preview_rev` rises, for every source. `changed(session)` (a
source's `deps.changed`) lists that session again in the background. `reported` (each position report that is not the page's last) marks the session
on screen and, at most every `PREVIEW_LOOK_MS`, queues the sheets its local video lacks for what is on disk now (in
front of every other job) and lists again. A made sheet lists the session on screen again. `sweep` (30 s after start,
then every 30 minutes) queues what whole videos lack. `buildStreamPreviews` answers null with the switch off or
without direct streaming.
**Code:**
```ts
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_FFMPEG_BIN, type Config } from '../../config.js';
import type { StreamCache } from '../cache/service.js';
import type { DirectStreamService } from '../service.js';
import type { StreamSession } from '../sessions.js';
import type { TorrentStreams } from '../torrent/service.js';
import { ffmpegPreviewSpawner, SheetBuilder, type SpawnPreview } from './builder.js';
import { isFile, keyTag, LocalSource } from './local.js';
import { covered, planSheets, SHEET_NAME, type SheetSpec } from './plan.js';
import { PreviewQueue } from './queue.js';
import { readSheets } from './sheetIndex.js';
import { previewSources } from './sources.js';
import { noPreviews, type LocalVideo, type PreviewList, type PreviewSource } from './types.js';

/** The session on screen is looked at again (what is on disk, what to make) at most this often. */
export const PREVIEW_LOOK_MS = 15_000;
/** The first sweep of the films on disk, after start. */
export const PREVIEW_SWEEP_FIRST_MS = 30_000;
/** Then this often. */
export const PREVIEW_SWEEP_MS = 30 * 60_000;

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function signatureOf(list: PreviewList): string {
  return `${list.state}|${list.source ?? ''}|${list.cues.map((c) => `${c.start_s}:${c.end_s}:${c.url}:${c.x}:${c.y}`).join(',')}`;
}

const NONE_SIGNATURE = signatureOf(noPreviews());

/** The sheets of `video` not made yet whose whole stretch is on disk now. */
export async function missingSheets(video: LocalVideo): Promise<SheetSpec[]> {
  const done = new Set((await readSheets(video)).map((s) => s.index));
  const coverage = await video.coverage();
  return planSheets(video.durationS).filter((s) => !done.has(s.index) && covered(s, coverage));
}

export interface StreamPreviewsOptions {
  /** In the asking order (sources.ts). */
  sources: readonly PreviewSource[];
  builder: SheetBuilder;
  /** DirectStreamService.peek: a live session without marking it used. */
  peek: (id: string) => StreamSession | null;
  now?: () => number;
  log?: (line: string) => void;
  lookMs?: number;
  sweepFirstMs?: number;
  sweepMs?: number;
  retryMs?: number;
  maxTries?: number;
}

/**
 * Seek previews on this host (SEEK_PREVIEW_THUMBNAILS phase 1). Held in AppDeps.streamPreviews; the routes in
 * src/http/directStreamApi.ts read it, startBackground starts and closes it. A failure is a missing picture and one
 * log line: nothing here throws into a route or touches a play.
 */
export class StreamPreviews {
  private readonly locals: LocalSource[];
  private readonly queue: PreviewQueue;
  /** The last list each session was given, as a signature: a different one raises its previewRev. */
  private readonly shown = new WeakMap<StreamSession, string>();
  private readonly looked = new WeakMap<StreamSession, number>();
  private onScreen: string | null = null;
  private firstSweep: ReturnType<typeof setTimeout> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(private readonly opts: StreamPreviewsOptions) {
    this.locals = opts.sources.filter((s): s is LocalSource => s instanceof LocalSource);
    this.queue = new PreviewQueue({
      builder: opts.builder,
      onMade: () => void this.refreshOnScreen(),
      ...(opts.now === undefined ? {} : { now: opts.now }),
      log: (line) => this.log(line),
      ...(opts.retryMs === undefined ? {} : { retryMs: opts.retryMs }),
      ...(opts.maxTries === undefined ? {} : { maxTries: opts.maxTries }),
    });
  }

  /** Starts the sweeps of the films on disk. */
  start(): void {
    if (this.closed || this.firstSweep !== null) return;
    this.firstSweep = setTimeout(() => void this.sweep(), this.opts.sweepFirstMs ?? PREVIEW_SWEEP_FIRST_MS);
    this.firstSweep.unref();
    this.sweepTimer = setInterval(() => void this.sweep(), this.opts.sweepMs ?? PREVIEW_SWEEP_MS);
    this.sweepTimer.unref();
  }

  /** Stops the sweeps and the running ffmpeg (keeping no part of its sheet). */
  async close(): Promise<void> {
    this.closed = true;
    if (this.firstSweep !== null) clearTimeout(this.firstSweep);
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    await this.queue.close();
  }

  /** GET /api/stream/sessions/:id/previews: the first list that is not `none`, the sources asked in order. */
  async list(session: StreamSession): Promise<PreviewList> {
    let list = noPreviews();
    for (const source of this.opts.sources) {
      let answer: PreviewList;
      try {
        answer = await source.list(session);
      } catch (err) {
        this.log(`[notesd] previews: the ${source.name} source failed for session ${session.id.slice(0, 6)}: ${messageOf(err)}`);
        continue;
      }
      if (answer.state !== 'none') {
        list = answer;
        break;
      }
    }
    const signature = signatureOf(list);
    if (signature !== (this.shown.get(session) ?? NONE_SIGNATURE)) session.previewRev += 1;
    this.shown.set(session, signature);
    return list;
  }

  /** A source says its list for `session` changed (PreviewSourceDeps.changed): list it again, in the background. Never throws. */
  changed(session: StreamSession): void {
    if (this.closed) return;
    void this.list(session).catch((err: unknown) => this.log(`[notesd] previews: could not list session ${session.id.slice(0, 6)} again: ${messageOf(err)}`));
  }

  /** GET /api/stream/sessions/:id/previews/:name: a sheet's bytes from the first local video of the session holding it (`tag`: its key). */
  async sheet(session: StreamSession, name: string, tag: string | null): Promise<Uint8Array | null> {
    if (!SHEET_NAME.test(name)) return null;
    for (const source of this.locals) {
      const video = await source.video(session);
      if (video === null || (tag !== null && keyTag(video.key) !== tag)) continue;
      const file = path.join(video.dir, name);
      if (!(await isFile(file))) continue;
      try {
        return await readFile(file);
      } catch {
        return null;
      }
    }
    return null;
  }

  /** A position report of a page that is still open: the session is on screen; its previews come first. */
  reported(id: string): void {
    if (this.closed) return;
    const session = this.opts.peek(id);
    if (session === null) return;
    this.onScreen = id;
    const now = (this.opts.now ?? Date.now)();
    const last = this.looked.get(session);
    if (last !== undefined && now - last < (this.opts.lookMs ?? PREVIEW_LOOK_MS)) return;
    this.looked.set(session, now);
    void this.look(session).catch((err: unknown) => this.log(`[notesd] previews: could not look at session ${id.slice(0, 6)}: ${messageOf(err)}`));
  }

  /** Queues what the whole videos on disk lack, behind the session on screen's. Never throws; answers how many sheets were queued. */
  async sweep(): Promise<number> {
    let added = 0;
    let videos = 0;
    for (const source of this.locals) {
      for (const video of await source.whole()) {
        try {
          const sheets = await missingSheets(video);
          if (sheets.length === 0) continue;
          videos += 1;
          added += this.queue.want(video, sheets, false);
        } catch (err) {
          this.log(`[notesd] previews: could not look at ${video.key}: ${messageOf(err)}`);
        }
      }
    }
    if (added > 0) this.log(`[notesd] previews: ${added} sheet(s) of ${videos} film(s) on disk to make`);
    return added;
  }

  private async look(session: StreamSession): Promise<void> {
    for (const source of this.locals) {
      const video = await source.video(session);
      if (video === null) continue;
      this.queue.want(video, await missingSheets(video), true);
      break;
    }
    await this.list(session);
  }

  private async refreshOnScreen(): Promise<void> {
    const id = this.onScreen;
    const session = id === null ? null : this.opts.peek(id);
    if (session !== null) await this.list(session);
  }

  private log(line: string): void {
    (this.opts.log ?? ((l: string) => console.log(l)))(line);
  }
}

/** What buildStreamPreviews reads of the daemon. */
export interface PreviewWiring {
  directStream: DirectStreamService | null;
  streamCache: StreamCache | null;
  torrents: TorrentStreams | null;
}

/** Test seams. */
export interface PreviewOverrides {
  spawn?: SpawnPreview;
  setPriority?: (pid: number, priority: number) => void;
  getPriority?: (pid: number) => number;
  probeDuration?: (file: string) => Promise<number | null>;
  now?: () => number;
  log?: (line: string) => void;
}

/** The daemon's seek previews, or null (nothing is built, the route answers no frame) with NOTESD_STREAM_PREVIEWS=off or without direct streaming. */
export function buildStreamPreviews(config: Config, wiring: PreviewWiring, overrides: PreviewOverrides = {}): StreamPreviews | null {
  const ds = config.directStream;
  const directStream = wiring.directStream;
  if (ds === undefined || ds.previews !== true || directStream === null) return null;
  const log = overrides.log ?? ((line: string) => console.log(line));
  const ffmpegBin = ds.ffmpegBin ?? DEFAULT_FFMPEG_BIN;
  // The sources are built before the service that lists them: their change hook reaches it through this holder.
  const holder: { previews: StreamPreviews | null } = { previews: null };
  const previews = new StreamPreviews({
    sources: previewSources({
      config,
      directStream,
      streamCache: wiring.streamCache,
      torrents: wiring.torrents,
      fetch: directStream.passThroughFetch,
      changed: (session) => holder.previews?.changed(session),
      log,
      ...(overrides.probeDuration === undefined ? {} : { probeDuration: overrides.probeDuration }),
    }),
    builder: new SheetBuilder({
      spawn: overrides.spawn ?? ffmpegPreviewSpawner(ffmpegBin),
      ffmpegBin,
      log,
      ...(overrides.setPriority === undefined ? {} : { setPriority: overrides.setPriority }),
      ...(overrides.getPriority === undefined ? {} : { getPriority: overrides.getPriority }),
      ...(overrides.now === undefined ? {} : { now: overrides.now }),
    }),
    peek: (id) => directStream.peek(id),
    log,
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  });
  holder.previews = previews;
  return previews;
}
```
### Step 11: `previewRev` on the session
**File:** `src/directStream/sessions.ts:129-130` and `:202-203`
**Change:** after `pastedTorrent: string | null;` (line 129) add:
```ts
  /**
   * Counts the times the session's seek-preview cue list changed (src/directStream/previews/service.ts); 0 at first.
   * The page reads it in the session and in the answer to its position reports and fetches the previews again when it rises.
   */
  previewRev: number;
```
and in `SessionStore.create`, after `pastedTorrent: null,` (line 202) add:
```ts
      previewRev: 0,
```
**Impact:** every `StreamSession` built by the store starts at 0; tests that cast partial sessions are unaffected.

### Step 12: `preview_rev` in `SessionInfo`; `peek`
**File:** `src/directStream/service.ts:189`, `:1361`, `:2401`
**Change:** after `source_note: string | null;` (line 189) add:
```ts
  /**
   * Counts the times the session's seek-preview frames changed (GET /api/stream/sessions/:id/previews); 0 for a session
   * with none yet. The answer to a position report carries it too: when it is higher than the page's, the page fetches
   * the previews again.
   */
  preview_rev: number;
```
after the `session(id)` method (ends line 1361) add:
```ts
  /** The live session, without marking it used (the seek previews' background work must not keep a session alive); null for an unknown or ended id. */
  peek(id: string): StreamSession | null {
    return this.sessions.peek(id);
  }

  /** The fetch the pass-through uses (a test's injected one included): the seek previews' provider source reads a track through forward() with it. */
  get passThroughFetch(): FetchLike {
    return this.fetchImpl;
  }
```
(`FetchLike` is already imported in `service.ts`, line 15.)
in `sessionInfo`, after `source_note: session.sourceNote,` (line 2401) add:
```ts
      preview_rev: session.previewRev,
```
**Impact:** `GET /api/stream/sessions/:id`, the play answer's `session`, and every answer that spreads `SessionInfo`
carry `preview_rev`. Tests use `toMatchObject` on these, so none breaks.

### Step 13: The cache's size counts its previews
**File:** `src/directStream/cache/store.ts:109-127`
**Change:** replace `diskSize` with a recursive count, so the Cache page and `stream_disk` count `previews/`.
Deletion needs no change: `CacheStore.remove`, `clear`, `prune` and `sweepOrphans` already `rm` the whole folder
recursively, `previews/` included (proved in step 27).
**Code:**
```ts
  /** The bytes the cache's folder takes on disk (allocated blocks, as the torrent budget counts), every file under it (its seek previews too); 0 when there is no folder. */
  async diskSize(id: string): Promise<number> {
    return blocksUnder(this.dir(id));
  }
```
and add at the end of the file (after the class):
```ts
/** The allocated bytes of every file under `dir`, at any depth; 0 for a folder that is not there. */
async function blocksUnder(dir: string): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await blocksUnder(file);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const s = await stat(file);
      total += s.blocks > 0 ? s.blocks * 512 : s.size;
    } catch {
      // gone meanwhile
    }
  }
  return total;
}
```
and add `import type { Dirent } from 'node:fs';` after line 1 (`store.ts` already imports `readdir`, `stat` and `path`).
**Impact:** `GET /api/stream/disk` `cloud_bytes` and the per-title sizes now include the previews.

### Step 14: The switch
**File:** `src/config.ts:222`, `:226-231`, `:969`, `:1114`
**Change:** after `trending?: TrendingConfig` (line 222) add:
```ts
  /**
   * `NOTESD_STREAM_PREVIEWS`, default on: seek previews (src/directStream/previews/), sprite sheets made in the
   * background by one niced ffmpeg from the part of a film that is on this machine and listed per stream session.
   * `off`, or unset in a literal: nothing is made and GET /api/stream/sessions/:id/previews answers no frame.
   */
  previews?: boolean
```
in `DEFAULT_DIRECT_STREAM_CONFIG` add `previews: false,` after `cacheDir: null,` (line 230); in `parseDirectStream`
after `canary: parseSwitch('NOTESD_STREAM_CANARY', env.NOTESD_STREAM_CANARY),` (line 969) add:
```ts
    previews: parseSwitch('NOTESD_STREAM_PREVIEWS', env.NOTESD_STREAM_PREVIEWS),
```
and in the `loadConfig` doc comment, line 1114, `Stream canary key: NOTESD_STREAM_CANARY (default on).` becomes
`Stream canary key: NOTESD_STREAM_CANARY (default on). Seek previews key: NOTESD_STREAM_PREVIEWS (default on).`
**Impact:** `tests/unit/config.test.ts:58` needs `previews: true` (step 27).

### Step 15: `AppDeps`, the daemon, the background
**File:** `src/deps.ts:31`, `:133`
**Code:** add `import type { StreamPreviews } from './directStream/previews/service.js';` after line 31, and after
`streamLive?: StreamLive | null;` (line 133):
```ts
  /**
   * Seek previews (src/directStream/previews/): sprite sheets of the films on this machine, made by one niced ffmpeg
   * and listed per stream session (GET /api/stream/sessions/:id/previews). Null or absent with
   * NOTESD_STREAM_PREVIEWS=off or without direct streaming: nothing is built and the route answers no frame.
   * startBackground starts its sweep and closes it before every other closer (the stream cache and the torrents included).
   */
  streamPreviews?: StreamPreviews | null;
```
**File:** `src/daemon.ts:58`, `:575`
**Code:** add `import { buildStreamPreviews } from './directStream/previews/service.js';` after line 58
(`import { buildStreamCache } ...`), and after the `deps.cacheShelf = ...;` statement (ends line 575):
```ts
  // Seek previews (src/directStream/previews/): sheets made by one niced ffmpeg from what is on this machine, the
  // session on screen first. Null with NOTESD_STREAM_PREVIEWS=off or without direct streaming.
  deps.streamPreviews = buildStreamPreviews(config, { directStream, streamCache, torrents });
```
This is the only `src/daemon.ts` line of the feature: phases 2 and 3 read everything through `PreviewSourceDeps`.
**File:** `src/background.ts:239`, `:275`
**Code:** after the stream cache's start block (ends line 239):
```ts
  // Seek previews: a sweep of the films on disk 30 s after start and every half hour; nothing joins a swarm or fetches.
  const streamPreviews = deps.streamPreviews ?? null;
  streamPreviews?.start();
```
and in the returned closer, after `await inbox.close();` (line 275), before the parallel `Promise.all`:
```ts
    // The previews' ffmpeg reads the caches' and the torrents' files (and phase 2's loopback gate): it stops, keeping
    // no part of its sheet, before anything it reads closes. Bounded: the running ffmpeg is killed at once.
    await streamPreviews?.close();
```
(The `Promise.all` list is not changed.)
**Impact:** the live daemon starts making previews of this host's ready caches 30 s after start (niced).

### Step 16: The routes and the position answer
**File:** `src/http/directStreamApi.ts`
**Change 1 (imports, after line 9):** `import { noPreviews } from '../directStream/previews/types.js';`
**Change 2 (line 88):** the deps type gains `'streamPreviews'`:
```ts
export function directStreamRoutes(deps: Pick<AppDeps, 'directStream'> & Partial<Pick<AppDeps, 'movies' | 'streamLive' | 'titleSubtitles' | 'titleCues' | 'torrents' | 'streamPreviews'>>): Hono {
```
**Change 3 (after the `GET /api/stream/sessions/:id` route, line 151):**
```ts
  // Seek previews (src/directStream/previews/): the frames this session can show now. Never polled by the page:
  // it fetches again when a `preview_rev` it is given is higher than the one it holds.
  r.get('/api/stream/sessions/:id/previews', async (c) => {
    const session = service().session(c.req.param('id'));
    if (session === null) return c.json(UNKNOWN_SESSION, 403);
    const previews = deps.streamPreviews ?? null;
    const list = previews === null ? noPreviews() : await previews.list(session);
    c.header('Cache-Control', 'no-store');
    return c.json({ state: list.state, rev: session.previewRev, source: list.source, cues: list.cues });
  });

  // One sprite sheet of those previews, named by a cue's url.
  r.get('/api/stream/sessions/:id/previews/:name', async (c) => {
    const session = service().session(c.req.param('id'));
    if (session === null) return c.json(UNKNOWN_SESSION, 403);
    const bytes = (await deps.streamPreviews?.sheet(session, c.req.param('name'), c.req.query('k') ?? null)) ?? null;
    if (bytes === null) return c.json({ error: 'not_found', message: 'This session has no preview sheet of that name on this machine.' }, 404);
    return c.body(new Uint8Array(bytes), 200, {
      'content-type': 'image/jpeg',
      'content-length': String(bytes.length),
      'cache-control': 'private, max-age=86400',
      'x-content-type-options': 'nosniff',
    });
  });
```
**Change 4 (line 231):**
```ts
  r.route('/', streamPositionRoutes({ movies: deps.movies ?? null, directStream: deps.directStream, live: deps.streamLive ?? null, torrents: deps.torrents ?? null, previews: deps.streamPreviews ?? null }));
```
**Change 5 (line 269):**
```ts
type PositionSession = StreamSessionRef & { torrent?: { subtitleRev: number; infoHash?: string; fileIndex?: number } | null; outside?: { subtitleRev: number }; sourceRev?: number; previewRev?: number };
```
**Change 6 (after `live?: StreamLive | null;`, line 283):**
```ts
  /** Seek previews: a report of a page still open makes its session the one whose sheets are made first. */
  previews?: { reported(id: string): void } | null;
```
**Change 7 (position handler):** after `service.reported?.(session.id, { paused: report.paused === true, over });`
(line 333) add:
```ts
    // Seek previews: the session on screen has its sheets made first and its frames looked at again (preview_rev).
    if (!over) deps.previews?.reported(session.id);
    const previewRev = session.previewRev ?? 0;
```
and both answers (lines 338 and 372) gain `preview_rev: previewRev`:
```ts
        return c.json({ ok: true, play_id: null, ended: false, subtitle_rev: subtitleRev, source_rev: sourceRev, preview_rev: previewRev });
```
```ts
    return c.json({ ok: true, play_id: written.play.id, ended: written.play.endedAt !== null, subtitle_rev: subtitleRev, source_rev: sourceRev, preview_rev: previewRev });
```
Also extend the doc comment above `streamPositionRoutes` (ends line 304) with one sentence:
`And \`preview_rev\`, the count of changes to the session's seek-preview frames: the page fetches them again when it rises.`
**Impact:** two new routes; one more field in the position answer (the web page ignores unknown fields until phase 4).

### Step 17: Route docs and the generated reference
**File:** `scripts/docs/httpRoutes.ts:248-249`, `:264`
**Change 1:** in the `'GET /api/stream/sessions/:id'` string, `subtitle_rev, source_rev, source_note}\`.` becomes
`subtitle_rev, source_rev, source_note, preview_rev}\`.`, and after the sentence that ends
`...the page loads the new source at the film\'s position when the number in a position report\'s answer differs.`
insert ` \`preview_rev\` counts the times the session\'s seek-preview frames changed (\`GET /api/stream/sessions/:id/previews\`); the page fetches them again when the number in a position report\'s answer is higher.`
**Change 2:** add after the `'GET /api/stream/sessions/:id'` entry (line 249):
```ts
      'GET /api/stream/sessions/:id/previews':
        'The seek-preview frames this session can show now: `{state, rev, source, cues}`. `state` is `none` (no frame: `cues` is `[]` and `source` null), `partial` (frames for the stretches of the film on this machine) or `ready` (the whole film). `source` is `local`: sprite sheets made on this machine from the video of the film the session plays (the stream cache it plays from, or a torrent\'s file or remux). `rev` is the session\'s `preview_rev`. Each cue is `{start_s, end_s, url, x, y, w, h}`: the stretch of the film `[start_s, end_s)` one frame stands for, the picture it is in (a same-origin address the page uses as is) and the frame\'s rectangle in that picture, in pixels; cues are sorted by `start_s`, never overlap, and leave gaps where the film is not on this machine yet. Sheets are made in the background by one `ffmpeg` at a time at the lowest CPU priority, the session on screen first (its position reports) and the whole videos on disk 30 s after start and every half hour: a frame every 10 s, 240 px wide, 6×6 frames per JPEG, from a stretch only once it is whole on disk, kept beside the video (a cache\'s `previews/` folder), counted in its size on disk and deleted with it. With `NOTESD_STREAM_PREVIEWS=off` nothing is made and the answer has no frame. 403 `unknown_session`.',
      'GET /api/stream/sessions/:id/previews/:name':
        'One sprite sheet of the session\'s previews (`sheet-NNNNN.jpg`, as a cue\'s `url` names it, with `k` naming the video it was made from): `image/jpeg`, kept by the browser for a day. 404 `not_found` for any other name, a sheet not made, or with previews off; 403 `unknown_session`.',
```
**Change 3:** in the `'POST /api/stream/sessions/:id/position'` string (line 264), the text (exactly as it stands in
the file, backticks and the escaped quote included)
```
200 `{ok: true, play_id, ended, subtitle_rev, source_rev}`; `subtitle_rev` and `source_rev` are the session\'s now
```
becomes
```
200 `{ok: true, play_id, ended, subtitle_rev, source_rev, preview_rev}`; `subtitle_rev`, `source_rev` and `preview_rev` are the session\'s now
```
and after `...a \`beat\` (a paused page saying it is still open) for the stream already on screen writes nothing and answers \`play_id: null\`.`
insert ` A report that is not \`closed\` or \`ended\` also makes the session the one whose seek previews are made first.`
**Then run:** `npm run docs:gen` (rewrites `docs/guide/reference/http-api.md`; never hand-edit it).
The previews entry is written once here for every local source (phase 2 does not edit this file); phase 3 replaces
its `` `source` is `local`: ... `` sentence to add `provider`, quoting it as written above.

### Step 18: The configuration row
**File:** `docs/guide/reference/configuration.md:151` (after the `NOTESD_STREAM_CACHE_DIR` row)
**Code:**
```md
| `NOTESD_STREAM_PREVIEWS` | on | Seek previews: the frames the player shows over its timeline. Sprite sheets are made in the background from the part of a film that is on this machine (the stream cache it plays from, or a torrent's file or remux), one `ffmpeg` (`NOTESD_FFMPEG_BIN`) at a time at the lowest CPU priority, the film on screen first, and kept beside the video, counted in its size on disk and deleted with it. A sheet ffmpeg fails is tried three times per run, and nothing of it is kept. `off`: nothing is made and the player shows the time alone. See [streaming](../streaming.md#direct-streaming). |
```
(Phase 5 points the link at its new "Seek previews" section; `#direct-streaming` exists today, so `docs:check` passes.)

### Step 19: The harness pin
**File:** `.claude/skills/verify-notesd/scripts/verify.sh:22`, `:370`
**Change:** one rule for every run (the reconciler's; phases 2, 3 and 5 rely on it): previews are off unless the
caller sets `NOTESD_STREAM_PREVIEWS=on`, which passes through. After header line 22 (`The daily stream canary
(NOTESD_STREAM_CANARY) is always pinned off.`) add:
```sh
#                                       Seek previews (NOTESD_STREAM_PREVIEWS) are off unless the caller sets
#                                       NOTESD_STREAM_PREVIEWS=on, which passes through (this machine's ffmpeg).
```
and after `env+=(NOTESD_STREAM_CANARY=off)` (line 370):
```sh
  # Seek previews (src/directStream/previews/): off, so a run builds nothing it was not asked to; a caller's
  # NOTESD_STREAM_PREVIEWS=on passes through for the journeys that make sheets with this machine's ffmpeg.
  env+=("NOTESD_STREAM_PREVIEWS=${NOTESD_STREAM_PREVIEWS:-off}")
```

### Step 20: Test fakes
**File:** `tests/unit/directStream/previews/fakes.ts` (new)
**Code:**
```ts
import { writeFile } from 'node:fs/promises';
import type { PreviewProcess, SpawnPreview } from '../../../../src/directStream/previews/builder.js';
import { PreviewNotYet, type LocalVideo } from '../../../../src/directStream/previews/types.js';

/** A JPEG's first bytes saying `width` x `height`: what the builder's check reads. */
export function fakeJpeg(width: number, height: number): Buffer {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ]);
}

export type FakeMode = 'ok' | 'fail' | 'garbage' | 'hang' | 'missing';

export interface FakeRun {
  args: string[];
  out: string;
  pid: number | null;
  killed: boolean;
}

/** A stand-in for ffmpeg: records each run and writes (or not) its output as `mode` says. */
export function fakeFfmpeg(options: { mode?: FakeMode; width?: number; height?: number; delayMs?: number } = {}) {
  const runs: FakeRun[] = [];
  let atOnce = 0;
  let most = 0;
  let nextPid = 4000;
  const spawn: SpawnPreview = (args) => {
    const mode = options.mode ?? 'ok';
    const out = args[args.length - 1] ?? '';
    const run: FakeRun = { args: [...args], out, pid: mode === 'missing' ? null : (nextPid += 1), killed: false };
    runs.push(run);
    let settle: (code: number | null) => void = () => undefined;
    const exited = new Promise<number | null>((resolve) => {
      settle = resolve;
    });
    atOnce += 1;
    most = Math.max(most, atOnce);
    void exited.then(() => {
      atOnce -= 1;
    });
    // A write into a folder deleted meanwhile fails as the real ffmpeg would: exit 1.
    const later = (work: () => Promise<number | null>): void => {
      setTimeout(() => void work().then((code) => settle(code), () => settle(1)), options.delayMs ?? 5);
    };
    const missing = mode === 'missing' ? Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }) : null;
    if (mode === 'missing') later(async () => -1);
    if (mode === 'ok') later(async () => (await writeFile(out, fakeJpeg(options.width ?? 1440, options.height ?? 816)), 0));
    if (mode === 'garbage') later(async () => (await writeFile(out, 'not a picture'), 0));
    if (mode === 'fail') later(async () => (await writeFile(out, 'half a sheet'), 1));
    const proc: PreviewProcess = {
      pid: run.pid,
      exited,
      startError: () => missing,
      stderrTail: () => (mode === 'fail' ? 'Invalid data found when processing input' : ''),
      kill: () => {
        run.killed = true;
        settle(null);
      },
    };
    return proc;
  };
  return { spawn, runs, mostAtOnce: () => most };
}

export interface FakeVideo extends LocalVideo {
  inputs: Array<[number, number]>;
  setCoverage(ranges: Array<[number, number]>): void;
}

/**
 * A LocalVideo whose sheets go to `dir` (its home: the folder `dir` is in); `notYet`: its stretches run out of pieces
 * (PreviewNotYet from cleanup); `input`: the address it gives ffmpeg, with `loopback` set for an http one.
 */
export function fakeVideo(
  dir: string,
  options: { key?: string; durationS?: number; coverage?: Array<[number, number]>; notYet?: boolean; input?: string } = {},
): FakeVideo {
  const durationS = options.durationS ?? 800;
  let ranges: Array<[number, number]> = options.coverage ?? [[0, durationS]];
  const inputs: Array<[number, number]> = [];
  return {
    key: options.key ?? 'test-video',
    dir,
    durationS,
    inputs,
    setCoverage: (next) => {
      ranges = next;
    },
    coverage: async () => ranges,
    input: async (startS, endS) => {
      inputs.push([startS, endS]);
      const address = options.input ?? '/films/test.mp4';
      const args = ['-ss', String(startS), '-t', String(endS - startS), '-i', address];
      const loopback = address.startsWith('http:') ? { loopback: true as const } : {};
      if (options.notYet !== true) return { args, ...loopback };
      return {
        args,
        ...loopback,
        cleanup: async () => {
          throw new PreviewNotYet('a piece of the stretch is not on disk');
        },
      };
    },
  };
}
```

### Step 21: The plan's tests
**File:** `tests/unit/directStream/previews/plan.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import { covered, cuesOf, planSheets } from '../../../../src/directStream/previews/plan.js';

describe('the sheet plan', () => {
  it('cuts a film into 360 s sheets of a frame every 10 s, the last one shorter', () => {
    expect(planSheets(800).map((s) => [s.name, s.startS, s.endS, s.frames])).toEqual([
      ['sheet-00000.jpg', 0, 360, 36],
      ['sheet-00001.jpg', 360, 720, 36],
      ['sheet-00002.jpg', 720, 800, 8],
    ]);
    expect(planSheets(721)).toHaveLength(2);
    expect(planSheets(0)).toEqual([]);
  });

  it('makes a sheet only when one stretch on disk holds all of it', () => {
    const [first, second] = planSheets(800);
    expect(first !== undefined && covered(first, [[0, 359.8]])).toBe(true);
    expect(second !== undefined && covered(second, [[360, 500], [500.2, 720]])).toBe(false);
    expect(second !== undefined && covered(second, [[0, 720]])).toBe(true);
  });

  it('lists one cue per frame with its rectangle, sorted, gaps where no sheet is made', () => {
    const cues = cuesOf(
      [
        { index: 2, name: 'sheet-00002.jpg', start_s: 720, end_s: 800, frames: 8, frame_w: 240, frame_h: 136 },
        { index: 0, name: 'sheet-00000.jpg', start_s: 0, end_s: 360, frames: 36, frame_w: 240, frame_h: 136 },
      ],
      (name) => `/x/${name}`,
    );
    expect(cues).toHaveLength(44);
    expect(cues[0]).toEqual({ start_s: 0, end_s: 10, url: '/x/sheet-00000.jpg', x: 0, y: 0, w: 240, h: 136 });
    expect(cues[7]).toEqual({ start_s: 70, end_s: 80, url: '/x/sheet-00000.jpg', x: 240, y: 136, w: 240, h: 136 });
    expect(cues[36]).toEqual({ start_s: 720, end_s: 730, url: '/x/sheet-00002.jpg', x: 0, y: 0, w: 240, h: 136 });
    expect(cues.at(-1)?.end_s).toBe(800);
    expect(cues.some((c) => c.start_s >= 360 && c.start_s < 720)).toBe(false);
  });
});
```

### Step 22: The builder's tests (R2.2, R2.3)
**File:** `tests/unit/directStream/previews/builder.test.ts` (new)
**Code:**
```ts
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { jpegSize, SheetBuilder } from '../../../../src/directStream/previews/builder.js';
import { planSheets, type SheetSpec } from '../../../../src/directStream/previews/plan.js';
import { fakeFfmpeg, fakeJpeg, fakeVideo } from './fakes.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'notesd-previews-builder-'));
  dirs.push(d);
  return d;
}

const SHEET0 = planSheets(800)[0] as SheetSpec;
const go = () => new AbortController().signal;

function builderOf(ffmpeg: ReturnType<typeof fakeFfmpeg>, timeLimitMs?: number) {
  const priorities: Array<[number, number]> = [];
  const builder = new SheetBuilder({
    spawn: ffmpeg.spawn,
    ffmpegBin: 'ffmpeg',
    setPriority: (pid, p) => void priorities.push([pid, p]),
    getPriority: () => 19,
    log: () => undefined,
    ...(timeLimitMs === undefined ? {} : { timeLimitMs }),
  });
  return { builder, priorities };
}

describe('one sheet', () => {
  it('is written by a niced ffmpeg that can open local files only, under a .part name, checked, then renamed', async () => {
    const dir = await tempDir();
    const ffmpeg = fakeFfmpeg();
    const { builder, priorities } = builderOf(ffmpeg);
    const outcome = await builder.build(fakeVideo(dir), SHEET0, go());
    expect(outcome).toMatchObject({ kind: 'made', nice: 19, record: { index: 0, name: 'sheet-00000.jpg', start_s: 0, end_s: 360, frames: 36, frame_w: 240, frame_h: 136 } });
    expect(await readdir(dir)).toEqual(['sheet-00000.jpg']);
    const run = ffmpeg.runs[0];
    expect(run?.out).toMatch(/sheet-00000\.jpg\.[0-9a-f]{8}\.part$/);
    const args = run?.args ?? [];
    expect(args.indexOf('-protocol_whitelist')).toBeGreaterThan(-1);
    expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe('file,crypto,data,concat');
    expect(args.indexOf('-protocol_whitelist')).toBeLessThan(args.indexOf('-i'));
    expect(args).toContain('-xerror');
    // The input's own seek, once: the builder adds none.
    expect(args.filter((a) => a === '-ss')).toHaveLength(1);
    expect(args.join(' ')).toContain('-skip_frame nokey');
    expect(args.join(' ')).toContain('fps=1/10,scale=240:-2,tile=6x6');
    expect(priorities).toEqual([[run?.pid, 19]]);
  });

  it('reads this daemon\'s loopback gate only when the input says so, and never another host', async () => {
    const dir = await tempDir();
    const ffmpeg = fakeFfmpeg();
    const { builder } = builderOf(ffmpeg);
    expect(await builder.build(fakeVideo(dir, { input: 'http://127.0.0.1:41234/0123abcd' }), SHEET0, go())).toMatchObject({ kind: 'made' });
    const args = ffmpeg.runs[0]?.args ?? [];
    expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe('file,crypto,data,concat,http,tcp');
    for (const input of ['http://10.0.0.7/film.mp4', 'http://localhost:41234/x', 'https://127.0.0.1/x', 'tcp://127.0.0.1:1', 'pipe:0']) {
      expect(await builder.build(fakeVideo(dir, { input }), SHEET0, go())).toMatchObject({ kind: 'failed', detail: expect.stringContaining('is not run') });
    }
    expect(ffmpeg.runs).toHaveLength(1);
  });

  it('a delete racing the build keeps no sheet and never makes the video\'s folder again', async () => {
    const home = await tempDir();
    const dir = path.join(home, 'previews');
    const { builder } = builderOf(fakeFfmpeg({ delayMs: 60 }));
    const outcome = builder.build(fakeVideo(dir), SHEET0, go());
    setTimeout(() => void rm(home, { recursive: true, force: true }), 20);
    expect(await outcome).toMatchObject({ kind: 'not_yet', detail: expect.stringContaining('deleted') });
    await expect(readdir(home)).rejects.toThrow();
    const ffmpeg = fakeFfmpeg();
    expect(await builderOf(ffmpeg).builder.build(fakeVideo(dir), SHEET0, go())).toMatchObject({ kind: 'not_yet' });
    expect(ffmpeg.runs).toEqual([]);
    await expect(readdir(home)).rejects.toThrow();
  });

  it('keeps no part of a sheet ffmpeg failed on', async () => {
    const dir = await tempDir();
    const { builder } = builderOf(fakeFfmpeg({ mode: 'fail' }));
    expect(await builder.build(fakeVideo(dir), SHEET0, go())).toMatchObject({ kind: 'failed', detail: expect.stringContaining('ffmpeg exited with 1') });
    expect(await readdir(dir)).toEqual([]);
  });

  it('kills an ffmpeg past its time limit and keeps nothing', async () => {
    const dir = await tempDir();
    const ffmpeg = fakeFfmpeg({ mode: 'hang' });
    const { builder } = builderOf(ffmpeg, 30);
    expect(await builder.build(fakeVideo(dir), SHEET0, go())).toMatchObject({ kind: 'failed', detail: expect.stringContaining('ran past') });
    expect(ffmpeg.runs[0]?.killed).toBe(true);
    expect(await readdir(dir)).toEqual([]);
  });

  it('a picture that is not a JPEG is a failure', async () => {
    const dir = await tempDir();
    const { builder } = builderOf(fakeFfmpeg({ mode: 'garbage' }));
    expect(await builder.build(fakeVideo(dir), SHEET0, go())).toEqual({ kind: 'failed', detail: 'ffmpeg wrote no picture' });
    expect(await readdir(dir)).toEqual([]);
  });

  it('says so when ffmpeg is missing', async () => {
    const dir = await tempDir();
    const { builder } = builderOf(fakeFfmpeg({ mode: 'missing' }));
    expect(await builder.build(fakeVideo(dir), SHEET0, go())).toMatchObject({ kind: 'no_ffmpeg' });
    expect(await readdir(dir)).toEqual([]);
  });

  it('starts no ffmpeg for a stretch that is not on disk', async () => {
    const dir = await tempDir();
    const ffmpeg = fakeFfmpeg();
    const { builder } = builderOf(ffmpeg);
    expect(await builder.build(fakeVideo(dir, { coverage: [[0, 200]] }), SHEET0, go())).toMatchObject({ kind: 'not_yet' });
    expect(ffmpeg.runs).toEqual([]);
  });

  it('a stretch that runs out of pieces is "not yet", not a failure, and keeps nothing', async () => {
    const dir = await tempDir();
    const { builder } = builderOf(fakeFfmpeg({ mode: 'fail' }));
    expect(await builder.build(fakeVideo(dir, { notYet: true }), SHEET0, go())).toEqual({ kind: 'not_yet', detail: 'a piece of the stretch is not on disk' });
    expect(await readdir(dir)).toEqual([]);
  });

  it('a sheet ffmpeg made from the bytes it was served is kept, whatever the cleanup says', async () => {
    const dir = await tempDir();
    const { builder } = builderOf(fakeFfmpeg());
    expect(await builder.build(fakeVideo(dir, { notYet: true }), SHEET0, go())).toMatchObject({ kind: 'made' });
    expect(await readdir(dir)).toEqual(['sheet-00000.jpg']);
  });

  it('an abort stops ffmpeg and keeps nothing', async () => {
    const dir = await tempDir();
    const ffmpeg = fakeFfmpeg({ mode: 'hang' });
    const { builder } = builderOf(ffmpeg);
    const abort = new AbortController();
    const outcome = builder.build(fakeVideo(dir), SHEET0, abort.signal);
    setTimeout(() => abort.abort(), 20);
    expect(await outcome).toEqual({ kind: 'aborted' });
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('jpegSize', () => {
  it('reads a JPEG\'s size and nothing else', () => {
    expect(jpegSize(fakeJpeg(1440, 816))).toEqual({ width: 1440, height: 816 });
    expect(jpegSize(Buffer.from('not a picture'))).toBeNull();
  });
});
```

### Step 23: The service's tests (R1.5, R2.2, R2.3, R2.8)
**File:** `tests/unit/directStream/previews/service.test.ts` (new)
**Code:**
```ts
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SheetBuilder } from '../../../../src/directStream/previews/builder.js';
import { LocalSource, type LocalVideos } from '../../../../src/directStream/previews/local.js';
import { StreamPreviews } from '../../../../src/directStream/previews/service.js';
import type { LocalVideo, PreviewSource } from '../../../../src/directStream/previews/types.js';
import type { StreamSession } from '../../../../src/directStream/sessions.js';
import { fakeFfmpeg, fakeVideo } from './fakes.js';

const dirs: string[] = [];
const open: StreamPreviews[] = [];
afterEach(async () => {
  for (const p of open.splice(0)) await p.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'notesd-previews-service-'));
  dirs.push(d);
  return d;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const POLL = { timeout: 5000, interval: 10 };

function sessionOf(): StreamSession {
  return { id: 'P'.repeat(32), ref: { kind: 'movie', tmdbId: 550 }, cache: null, torrent: null, previewRev: 0 } as unknown as StreamSession;
}

function setup(video: LocalVideo, ffmpeg: ReturnType<typeof fakeFfmpeg>, options: { before?: PreviewSource[] } = {}) {
  const session = sessionOf();
  const logged: string[] = [];
  const priorities: Array<[number, number]> = [];
  const log = (line: string) => void logged.push(line);
  const videos: LocalVideos = { forSession: async () => video, whole: async () => [video] };
  const previews = new StreamPreviews({
    sources: [...(options.before ?? []), new LocalSource('cache', videos, log)],
    builder: new SheetBuilder({ spawn: ffmpeg.spawn, ffmpegBin: '/opt/ffmpeg', setPriority: (pid, p) => void priorities.push([pid, p]), getPriority: () => 19, log }),
    peek: (id) => (id === session.id ? session : null),
    log,
    lookMs: 0,
    retryMs: 1,
  });
  open.push(previews);
  return { previews, session, logged, priorities };
}

describe('seek previews of the session on screen', () => {
  it('are made one ffmpeg at a time, each at the lowest priority', async () => {
    const dir = await tempDir();
    const ffmpeg = fakeFfmpeg();
    const t = setup(fakeVideo(dir, { durationS: 1100 }), ffmpeg);
    t.previews.reported(t.session.id);
    await expect.poll(async () => (await t.previews.list(t.session)).state, POLL).toBe('ready');
    expect(ffmpeg.runs).toHaveLength(4);
    expect(ffmpeg.mostAtOnce()).toBe(1);
    expect(t.priorities).toEqual(ffmpeg.runs.map((r) => [r.pid, 19]));
    expect((await readdir(dir)).sort()).toEqual(['previews.json', 'sheet-00000.jpg', 'sheet-00001.jpg', 'sheet-00002.jpg', 'sheet-00003.jpg']);
  });

  it('a sheet ffmpeg keeps failing is tried three times, keeps nothing and changes nothing the page sees', async () => {
    const dir = await tempDir();
    const ffmpeg = fakeFfmpeg({ mode: 'fail' });
    const t = setup(fakeVideo(dir, { durationS: 300 }), ffmpeg);
    t.previews.reported(t.session.id);
    await expect.poll(() => t.logged.some((l) => l.includes('giving up on sheet 1/1')), POLL).toBe(true);
    await sleep(50);
    t.previews.reported(t.session.id);
    await sleep(50);
    expect(ffmpeg.runs).toHaveLength(3);
    expect(t.logged.filter((l) => l.includes('failed ('))).toHaveLength(2);
    expect(await readdir(dir)).toEqual([]);
    expect(await t.previews.list(t.session)).toEqual({ state: 'none', source: null, cues: [] });
    expect(t.session.previewRev).toBe(0);
  });

  it('a missing ffmpeg is said once and nothing more is tried', async () => {
    const dir = await tempDir();
    const ffmpeg = fakeFfmpeg({ mode: 'missing' });
    const t = setup(fakeVideo(dir, { durationS: 1100 }), ffmpeg);
    t.previews.reported(t.session.id);
    await expect.poll(() => t.logged.some((l) => l.includes('ffmpeg (/opt/ffmpeg) was not found')), POLL).toBe(true);
    t.previews.reported(t.session.id);
    expect(await t.previews.sweep()).toBe(0);
    await sleep(50);
    expect(ffmpeg.runs).toHaveLength(1);
    expect(await readdir(dir)).toEqual([]);
  });

  it('a restart keeps the finished sheets and makes only the missing ones', async () => {
    const dir = await tempDir();
    const a = setup(fakeVideo(dir, { durationS: 1000, coverage: [[0, 360], [720, 1000]] }), fakeFfmpeg());
    a.previews.reported(a.session.id);
    await expect.poll(async () => (await a.previews.list(a.session)).cues.length, POLL).toBe(64);
    await a.previews.close();
    const before = await stat(path.join(dir, 'sheet-00000.jpg'));
    const second = fakeFfmpeg();
    const b = setup(fakeVideo(dir, { durationS: 1000 }), second);
    b.previews.reported(b.session.id);
    await expect.poll(async () => (await b.previews.list(b.session)).state, POLL).toBe('ready');
    expect(second.runs.map((r) => path.basename(r.out).split('.')[0])).toEqual(['sheet-00001']);
    const after = await stat(path.join(dir, 'sheet-00000.jpg'));
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
  });

  it('raise preview_rev each time the cue list changes, and only then', async () => {
    const dir = await tempDir();
    const video = fakeVideo(dir, { durationS: 1000, coverage: [[0, 360]] });
    const t = setup(video, fakeFfmpeg());
    expect((await t.previews.list(t.session)).state).toBe('none');
    expect(t.session.previewRev).toBe(0);
    t.previews.reported(t.session.id);
    await expect.poll(async () => (await t.previews.list(t.session)).state, POLL).toBe('partial');
    const partialRev = t.session.previewRev;
    expect(partialRev).toBeGreaterThanOrEqual(1);
    await t.previews.list(t.session);
    expect(t.session.previewRev).toBe(partialRev);
    video.setCoverage([[0, 1000]]);
    t.previews.reported(t.session.id);
    await expect.poll(async () => (await t.previews.list(t.session)).state, POLL).toBe('ready');
    const readyRev = t.session.previewRev;
    expect(readyRev).toBeGreaterThan(partialRev);
    await t.previews.list(t.session);
    expect(t.session.previewRev).toBe(readyRev);
  });

  it('take the first source with frames: a provider\'s before this machine\'s', async () => {
    const dir = await tempDir();
    const none: PreviewSource = { name: 'provider', list: async () => ({ state: 'none', source: null, cues: [] }) };
    const t = setup(fakeVideo(dir, { durationS: 300 }), fakeFfmpeg(), { before: [none] });
    t.previews.reported(t.session.id);
    await expect.poll(async () => (await t.previews.list(t.session)).source, POLL).toBe('local');
    const provider: PreviewSource = {
      name: 'provider',
      list: async () => ({ state: 'ready', source: 'provider', cues: [{ start_s: 0, end_s: 10, url: '/api/stream/sessions/x/p?u=a&img=1', x: 0, y: 0, w: 160, h: 90 }] }),
    };
    const u = setup(fakeVideo(dir, { durationS: 300 }), fakeFfmpeg(), { before: [provider] });
    expect((await u.previews.list(u.session)).source).toBe('provider');
  });

  it('a source that says its list changed has the session listed again: preview_rev rises once, and no position answer waits for it', async () => {
    const dir = await tempDir();
    let frames = false;
    const provider: PreviewSource = {
      name: 'provider',
      list: async () =>
        frames
          ? { state: 'ready', source: 'provider', cues: [{ start_s: 0, end_s: 10, url: '/api/stream/sessions/x/p?u=a&img=1', x: 0, y: 0, w: 160, h: 90 }] }
          : { state: 'none', source: null, cues: [] },
    };
    const t = setup(fakeVideo(dir, { durationS: 300, coverage: [] }), fakeFfmpeg(), { before: [provider] });
    await t.previews.list(t.session);
    expect(t.session.previewRev).toBe(0);
    frames = true;
    t.previews.changed(t.session);
    await expect.poll(() => t.session.previewRev, POLL).toBe(1);
    await t.previews.list(t.session);
    expect(t.session.previewRev).toBe(1);
  });

  it('a sweep makes what the films whole on disk lack, with no session', async () => {
    const dir = await tempDir();
    const t = setup(fakeVideo(dir, { durationS: 800 }), fakeFfmpeg());
    expect(await t.previews.sweep()).toBe(3);
    await expect.poll(async () => (await readdir(dir)).filter((n) => n.startsWith('sheet-')).length, POLL).toBe(3);
  });
});
```

### Step 24: The cache source's tests (R1.2)
**File:** `tests/unit/directStream/previews/cacheSource.test.ts` (new)
**Code:**
```ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CachePreviewRow, CachePreviewView } from '../../../../src/directStream/cache/service.js';
import { CacheVideos } from '../../../../src/directStream/previews/cacheSource.js';
import { keyTag, LocalSource } from '../../../../src/directStream/previews/local.js';
import { addSheet } from '../../../../src/directStream/previews/sheetIndex.js';
import type { StreamSession } from '../../../../src/directStream/sessions.js';
import { fakeJpeg } from './fakes.js';

const ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002';
const SID = 'C'.repeat(32);
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'notesd-previews-cache-'));
  dirs.push(d);
  return d;
}
const seg = (i: number) => `v-${String(i).padStart(5, '0')}.ts`;

/** A cache folder as cache/hls.ts writes it: `count` 4 s segments behind a key and an init section; `missing` not on disk. */
async function hlsCache(folder: string, count: number, missing: (i: number) => boolean = () => false): Promise<void> {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:7', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-KEY:METHOD=AES-128,URI="v-key-1.key"', '#EXT-X-MAP:URI="v-init-1.mp4"'];
  for (let i = 1; i <= count; i += 1) {
    lines.push('#EXTINF:4.0,', seg(i));
    if (!missing(i)) await writeFile(path.join(folder, seg(i)), 'segment');
  }
  lines.push('#EXT-X-ENDLIST', '');
  await writeFile(path.join(folder, 'video.m3u8'), lines.join('\n'));
  await writeFile(path.join(folder, 'v-key-1.key'), 'k'.repeat(16));
  await writeFile(path.join(folder, 'v-init-1.mp4'), 'init');
}

function viewOf(folder: string, rows: Record<string, CachePreviewRow>): CachePreviewView {
  return {
    folder: () => folder,
    get: async (id) => rows[id] ?? null,
    ready: async () => Object.values(rows).filter((r) => r.state === 'ready'),
    signature: async () => 'sig-1',
  };
}

const session = (over: Partial<Pick<StreamSession, 'cache' | 'torrent'>> = {}) =>
  ({ id: SID, ref: { kind: 'movie', tmdbId: 550 }, cache: null, torrent: null, previewRev: 0, ...over }) as unknown as StreamSession;
const hls: CachePreviewRow = { id: ID, state: 'ready', manifestKind: 'hls' };
const noProbe = { probeDuration: async () => null, log: () => undefined };

describe('a cloud cache as preview video', () => {
  it('covers the stretches whose segments are on disk', async () => {
    const folder = await tempDir();
    await hlsCache(folder, 200, (i) => i >= 91 && i <= 180);
    const video = await new CacheVideos(viewOf(folder, { [ID]: hls }), noProbe).forSession(session({ cache: { id: ID } as never }));
    expect(video).not.toBeNull();
    expect(video?.key).toBe(`cache-${ID}-${keyTag('sig-1')}`);
    expect(video?.dir).toBe(path.join(folder, 'previews'));
    expect(video?.durationS).toBe(800);
    expect(await video?.coverage()).toEqual([[0, 360], [720, 800]]);
  });

  it('reads a stretch from a playlist of only its segments, with absolute key and init and its media sequence', async () => {
    const folder = await tempDir();
    await hlsCache(folder, 200);
    const video = await new CacheVideos(viewOf(folder, { [ID]: hls }), noProbe).forSession(session({ cache: { id: ID } as never }));
    const input = await video?.input(730, 800);
    const args = input?.args ?? [];
    expect(args.slice(0, 8)).toEqual(['-f', 'hls', '-allowed_extensions', 'ALL', '-ss', '2.000', '-t', '70.000']);
    const file = args[args.indexOf('-i') + 1] ?? '';
    expect(path.dirname(file)).toBe(path.join(folder, 'previews'));
    const text = await readFile(file, 'utf8');
    expect(text).toContain('#EXT-X-MEDIA-SEQUENCE:189');
    expect(text).toContain(`#EXT-X-KEY:METHOD=AES-128,URI="${path.join(folder, 'v-key-1.key')}"`);
    expect(text).toContain(`#EXT-X-MAP:URI="${path.join(folder, 'v-init-1.mp4')}"`);
    expect(text.split('\n').filter((l) => l.startsWith('#EXTINF'))).toHaveLength(18);
    expect(text).toContain(path.join(folder, seg(183)));
    expect(text).not.toContain(path.join(folder, seg(182)));
    await input?.cleanup?.();
    await expect(readFile(file)).rejects.toThrow();
  });

  it('is the cache the session plays from and no other: none for a pass-through or a torrent session of a title cached here', async () => {
    const folder = await tempDir();
    await hlsCache(folder, 10);
    const other: CachePreviewRow = { id: OTHER, state: 'downloading', manifestKind: 'hls' };
    const videos = new CacheVideos(viewOf(folder, { [ID]: hls, [OTHER]: other }), noProbe);
    expect((await videos.forSession(session({ cache: { id: ID } as never })))?.key).toContain(ID);
    expect((await videos.forSession(session({ cache: { id: OTHER } as never })))?.key).toContain(OTHER);
    // A pass-through session of the same title: another provider's cache may be offset in time (R1.6), so none.
    expect(await videos.forSession(session())).toBeNull();
    expect(await videos.forSession(session({ torrent: { infoHash: 'a'.repeat(40) } as never }))).toBeNull();
  });

  it('a plain file counts only once joined, at the length ffprobe gives, asked once', async () => {
    const folder = await tempDir();
    const probed: string[] = [];
    const probe = { probeDuration: async (file: string) => (probed.push(file), 600), log: () => undefined };
    const downloading: CachePreviewRow = { id: ID, state: 'downloading', manifestKind: 'mp4' };
    expect(await new CacheVideos(viewOf(folder, { [ID]: downloading }), probe).forSession(session({ cache: { id: ID } as never }))).toBeNull();
    await writeFile(path.join(folder, 'video.mp4'), 'film');
    const videos = new CacheVideos(viewOf(folder, { [ID]: { ...downloading, state: 'ready' } }), probe);
    const video = await videos.forSession(session({ cache: { id: ID } as never }));
    expect(await video?.coverage()).toEqual([[0, 600]]);
    expect((await video?.input(360, 600))?.args).toEqual(['-ss', '360.000', '-t', '240.000', '-i', path.join(folder, 'video.mp4')]);
    await videos.forSession(session({ cache: { id: ID } as never }));
    expect(probed).toEqual([path.join(folder, 'video.mp4')]);
  });

  it('lists the frames of the sheets made for the stretches on disk', async () => {
    const folder = await tempDir();
    await hlsCache(folder, 200, (i) => i >= 91 && i <= 180);
    const source = new LocalSource('cache', new CacheVideos(viewOf(folder, { [ID]: hls }), noProbe), () => undefined);
    const s = session({ cache: { id: ID } as never });
    expect(await source.list(s)).toEqual({ state: 'none', source: null, cues: [] });
    const video = await new CacheVideos(viewOf(folder, { [ID]: hls }), noProbe).forSession(s);
    if (video === null) throw new Error('no video');
    await mkdir(video.dir, { recursive: true });
    await writeFile(path.join(video.dir, 'sheet-00000.jpg'), fakeJpeg(1440, 816));
    await addSheet(video, { index: 0, name: 'sheet-00000.jpg', start_s: 0, end_s: 360, frames: 36, frame_w: 240, frame_h: 136 });
    const list = await source.list(s);
    expect(list.state).toBe('partial');
    expect(list.source).toBe('local');
    expect(list.cues).toHaveLength(36);
    expect(list.cues[0]?.url).toBe(`/api/stream/sessions/${SID}/previews/sheet-00000.jpg?k=${keyTag(video.key)}`);
  });
});
```

### Step 25: The routes' tests (R2.7, R1.5 server half)
**File:** `tests/unit/directStream/previews/routes.test.ts` (new)
**Code:**
```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { DirectStreamService } from '../../../../src/directStream/service.js';
import type { StreamSession } from '../../../../src/directStream/sessions.js';
import { SheetBuilder } from '../../../../src/directStream/previews/builder.js';
import { LocalSource } from '../../../../src/directStream/previews/local.js';
import { StreamPreviews } from '../../../../src/directStream/previews/service.js';
import { addSheet } from '../../../../src/directStream/previews/sheetIndex.js';
import { directStreamRoutes, streamPositionRoutes, UNKNOWN_SESSION } from '../../../../src/http/directStreamApi.js';
import type { MovieStreamsSource } from '../../../../src/movies/streams.js';
import type { StreamLive } from '../../../../src/movies/streamLive.js';
import { fakeFfmpeg, fakeJpeg, fakeVideo } from './fakes.js';

const SID = 'R'.repeat(32);
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const sessionOf = () => ({ id: SID, ref: { kind: 'movie', tmdbId: 550 }, cache: null, torrent: null, previewRev: 0 }) as unknown as StreamSession;

function appOf(previews: StreamPreviews | null, session: StreamSession): Hono {
  const directStream = { session: (id: string) => (id === SID ? session : null) } as unknown as DirectStreamService;
  const app = new Hono();
  app.route('/', directStreamRoutes({ directStream, streamPreviews: previews }));
  return app;
}

describe('GET /api/stream/sessions/:id/previews', () => {
  it('answers no frame with previews off (NOTESD_STREAM_PREVIEWS=off)', async () => {
    const res = await appOf(null, sessionOf()).request(`/api/stream/sessions/${SID}/previews`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: 'none', rev: 0, source: null, cues: [] });
  });

  it('answers an unknown session as the session route does', async () => {
    const res = await appOf(null, sessionOf()).request(`/api/stream/sessions/${'X'.repeat(32)}/previews`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(UNKNOWN_SESSION);
  });

  it('lists the frames with the session\'s rev, serves a listed sheet as a JPEG, and nothing else', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'notesd-previews-route-'));
    dirs.push(dir);
    const video = fakeVideo(dir, { durationS: 800 });
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'sheet-00000.jpg'), fakeJpeg(1440, 816));
    await addSheet(video, { index: 0, name: 'sheet-00000.jpg', start_s: 0, end_s: 360, frames: 36, frame_w: 240, frame_h: 136 });
    const session = sessionOf();
    const previews = new StreamPreviews({
      sources: [new LocalSource('cache', { forSession: async () => video, whole: async () => [] }, () => undefined)],
      builder: new SheetBuilder({ spawn: fakeFfmpeg().spawn, ffmpegBin: 'ffmpeg', log: () => undefined }),
      peek: () => session,
      log: () => undefined,
    });
    const app = appOf(previews, session);
    const body = (await (await app.request(`/api/stream/sessions/${SID}/previews`)).json()) as { state: string; rev: number; source: string; cues: Array<{ url: string }> };
    expect(body).toMatchObject({ state: 'partial', rev: 1, source: 'local' });
    expect(body.cues).toHaveLength(36);
    const sheet = await app.request(body.cues[0]?.url ?? '');
    expect(sheet.status).toBe(200);
    expect(sheet.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await sheet.arrayBuffer())).toEqual(fakeJpeg(1440, 816));
    expect((await app.request(`/api/stream/sessions/${SID}/previews/previews.json`)).status).toBe(404);
    expect((await app.request(`/api/stream/sessions/${SID}/previews/sheet-00001.jpg`)).status).toBe(404);
    expect((await app.request(`/api/stream/sessions/${SID}/previews/sheet-00000.jpg?k=00000000`)).status).toBe(404);
    expect((await (await app.request(`/api/stream/sessions/${SID}/previews`)).json()) as { rev: number }).toMatchObject({ rev: 1 });
    await previews.close();
  });
});

describe('the position answer', () => {
  it('carries preview_rev and makes a page that is still open the one whose previews come first', async () => {
    const seen: string[] = [];
    const live = { has: () => true, current: () => ({ title_id: 'movie-550', duration: 100 }), report: () => undefined, end: () => undefined } as unknown as StreamLive;
    const movies = { host: 'host-a', tmdb: null, events: { changed: () => undefined }, repo: { titleById: async () => { throw new Error('down'); } } } as unknown as MovieStreamsSource;
    const session = { id: SID, ref: { kind: 'movie' as const, tmdbId: 550 }, source: { provider: 'Alpha' }, torrent: null, previewRev: 3 };
    const app = streamPositionRoutes({ movies, directStream: { session: () => session }, live, previews: { reported: (id) => void seen.push(id) } }, { log: () => undefined });
    const post = (body: object) => app.request(`/api/stream/sessions/${SID}/position`, { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const res = await post({ position_s: 5, paused: true, beat: true });
    expect(await res.json()).toEqual({ ok: true, play_id: null, ended: false, subtitle_rev: 0, source_rev: 0, preview_rev: 3 });
    await post({ position_s: 6, closed: true });
    expect(seen).toEqual([SID]);
  });
});
```

### Step 26: The real ffmpeg on a real HLS cache (R1.2, R2.3)
**File:** `tests/unit/directStream/previews/previews.ffmpeg.test.ts` (new)
**Change:** skipped where ffmpeg is missing (as `torrentRemux.ffmpeg.test.ts` does). A 400 s HLS film made by ffmpeg
in a cache-shaped folder; segment 95 ([376, 380)) held back: only sheet 1 of 2 is made, a 1440 x 816 JPEG, by an
ffmpeg at nice 19; once the segment is back, the second sheet is made and the list is `ready` with 40 cues.
**Code:**
```ts
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CachePreviewRow, CachePreviewView } from '../../../../src/directStream/cache/service.js';
import { ffmpegPreviewSpawner, jpegSize, SheetBuilder } from '../../../../src/directStream/previews/builder.js';
import { CacheVideos } from '../../../../src/directStream/previews/cacheSource.js';
import { LocalSource } from '../../../../src/directStream/previews/local.js';
import { StreamPreviews } from '../../../../src/directStream/previews/service.js';
import type { StreamSession } from '../../../../src/directStream/sessions.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

describe.skipIf(!hasFfmpeg)('seek previews from a real HLS cache with the real ffmpeg', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'notesd-previews-ffmpeg-'));

  beforeAll(() => {
    const made = spawnSync(
      'ffmpeg',
      ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=5', '-t', '400', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '10',
        '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-start_number', '1', '-hls_segment_filename', 'v-%05d.ts', 'video.m3u8'],
      { cwd: folder },
    );
    if (made.status !== 0) throw new Error(`ffmpeg could not make the fixture: ${made.stderr.toString()}`);
  }, 120_000);

  afterAll(() => rm(folder, { recursive: true, force: true }));

  it('makes sheets only for what is on disk, niced, and the rest once it arrives', async () => {
    const row: CachePreviewRow = { id: 'aaaaaaaa-0000-4000-8000-000000000001', state: 'ready', manifestKind: 'hls' };
    const view: CachePreviewView = { folder: () => folder, get: async () => row, ready: async () => [row], signature: async () => 'sig' };
    const logged: string[] = [];
    const log = (line: string) => void logged.push(line);
    const session = { id: 'F'.repeat(32), ref: { kind: 'movie', tmdbId: 550 }, cache: { id: row.id }, torrent: null, previewRev: 0 } as unknown as StreamSession;
    const previews = new StreamPreviews({
      sources: [new LocalSource('cache', new CacheVideos(view, { probeDuration: async () => null, log }), log)],
      builder: new SheetBuilder({ spawn: ffmpegPreviewSpawner('ffmpeg'), ffmpegBin: 'ffmpeg', log }),
      peek: () => session,
      log,
      lookMs: 0,
    });
    await rename(path.join(folder, 'v-00095.ts'), path.join(folder, 'held.ts'));
    previews.reported(session.id);
    await expect.poll(async () => (await previews.list(session)).cues.length, { timeout: 30_000, interval: 200 }).toBe(36);
    expect(await previews.list(session)).toMatchObject({ state: 'partial', source: 'local' });
    expect(jpegSize(await readFile(path.join(folder, 'previews', 'sheet-00000.jpg')))).toEqual({ width: 1440, height: 816 });
    expect(logged.filter((l) => l.includes('made sheet'))).toEqual([expect.stringMatching(/made sheet 1\/2 of cache-.* \(nice 19\)$/)]);
    await rename(path.join(folder, 'held.ts'), path.join(folder, 'v-00095.ts'));
    previews.reported(session.id);
    await expect.poll(async () => (await previews.list(session)).state, { timeout: 30_000, interval: 200 }).toBe('ready');
    expect((await previews.list(session)).cues).toHaveLength(40);
    await previews.close();
  }, 90_000);
});
```

### Step 27: Disk size and deletion of a cache's previews (R2.5); config tests
**File:** `tests/unit/directStream/cache/diskSize.test.ts` (new)
**Code:**
```ts
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StreamCacheRow } from '../../../../src/db/schema.js';
import type { DirectStreamRepo } from '../../../../src/directStream/repo.js';
import { StreamCache } from '../../../../src/directStream/cache/service.js';
import { CacheStore } from '../../../../src/directStream/cache/store.js';

const ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function cacheWithPreviews(): Promise<{ root: string; files: string[] }> {
  const root = await mkdtemp(path.join(tmpdir(), 'notesd-cache-size-'));
  dirs.push(root);
  const folder = path.join(root, ID);
  await mkdir(path.join(folder, 'previews'), { recursive: true });
  const files = [path.join(folder, 'v-00001.ts'), path.join(folder, 'previews', 'sheet-00000.jpg'), path.join(folder, 'previews', 'previews.json')];
  await writeFile(files[0] ?? '', Buffer.alloc(40_000, 1));
  await writeFile(files[1] ?? '', Buffer.alloc(90_000, 2));
  await writeFile(files[2] ?? '', '{}');
  return { root, files };
}

const blocks = async (files: string[]): Promise<number> => {
  let total = 0;
  for (const f of files) {
    const s = await stat(f);
    total += s.blocks > 0 ? s.blocks * 512 : s.size;
  }
  return total;
};

describe('a cloud cache\'s seek previews on disk', () => {
  it('count in the cache\'s size on disk', async () => {
    const { root, files } = await cacheWithPreviews();
    const size = await new CacheStore(root).diskSize(ID);
    expect(size).toBe(await blocks(files));
    expect(size).toBeGreaterThan(await blocks(files.slice(0, 1)));
  });

  it('go with the cache when it is deleted, and count in the Cache page until then', async () => {
    const { root, files } = await cacheWithPreviews();
    const row = { id: ID, host: 'host-a', kind: 'movie', tmdbId: 550, season: null, episode: null, state: 'ready' } as unknown as StreamCacheRow;
    const repo = { cacheById: async () => row, caches: async () => [row], deleteCache: async () => undefined } as unknown as DirectStreamRepo;
    const cache = new StreamCache({ repo, host: 'host-a', root, resolve: async () => Promise.reject(new Error('unused')), log: () => undefined });
    expect(await cache.diskUsage()).toEqual([{ row, bytes: await blocks(files) }]);
    await cache.remove(ID);
    await expect(stat(path.join(root, ID))).rejects.toThrow();
  });
});
```
**File:** `tests/unit/config.streamCache.test.ts:12` (append)
```ts
describe('NOTESD_STREAM_PREVIEWS', () => {
  it('is on unless set off, and off in DEFAULT_DIRECT_STREAM_CONFIG', () => {
    expect(parseDirectStream({}).previews).toBe(true);
    expect(parseDirectStream({ NOTESD_STREAM_PREVIEWS: 'off' }).previews).toBe(false);
    expect(DEFAULT_DIRECT_STREAM_CONFIG.previews).toBe(false);
    expect(() => parseDirectStream({ NOTESD_STREAM_PREVIEWS: 'sometimes' })).toThrow(/NOTESD_STREAM_PREVIEWS must be "on" or "off"/);
  });
});
```
and change its import to `import { DEFAULT_DIRECT_STREAM_CONFIG, parseDirectStream } from '../../src/config.js';`.
**File:** `tests/unit/config.test.ts:58`: in the `directStream` literal add `previews: true,` after `canary: true,`.

### Step 28: Two exact position answers in the integration test
**File:** `tests/integration/movies.streams.int.test.ts:191`, `:303`
**Change:** both `toEqual({ ok: true, play_id: null, ended: false, subtitle_rev: N, source_rev: 0 })` gain
`preview_rev: 0` (their fake sessions have no `previewRev`, so the route answers 0):
```ts
      expect(await (await report(a, 'sess-t', { position_s: 5, duration_s: 8340, paused: true, beat: true })).json()).toEqual({ ok: true, play_id: null, ended: false, subtitle_rev: 1, source_rev: 0, preview_rev: 0 })
```
```ts
        expect(await res.json()).toEqual({ ok: true, play_id: null, ended: false, subtitle_rev: 0, source_rev: 0, preview_rev: 0 })
```

## Principles applied

- Laziness protocol: no table, no new store class; the index is one JSON file beside the sheets, retry counts live in memory for the run, and `LocalSource` is one small class phase 2 reuses (`new LocalSource('torrent', videos, log)`) instead of a source framework.
- Boundary discipline: `previews.json` is read through one zod schema in `sheetIndex.ts`; the switch is parsed once in `parseDirectStream`; a sheet name is checked once against `SHEET_NAME` in `StreamPreviews.sheet` before any path is built; cue addresses are built server-side only (`sheetUrl`), the page never builds one.
- Make illegal states unrepresentable: `SheetOutcome` is a union where only `made` carries a record (a failed sheet cannot carry a file); `none` is said only through `noPreviews()`, so `none` with cues or a source cannot be built in this phase's code (the contract's `PreviewList` type itself stays as fixed).
- Encode lessons in structure: "a preview build makes no network request" (invariant 3) is enforced by `-protocol_whitelist file,crypto,data,concat` in `sheetArgs` for every input of every source, phase 2 included, widened only by the typed `loopback` field and then only to `http://127.0.0.1` (`refusedInput`), and tests check both, instead of a sentence each source must remember. "A delete never brings a preview folder back" is `prepare` making `dir` inside an existing home only.
- Prove it works: a real-ffmpeg test on a real HLS cache (step 26) and a throwaway-daemon script (Proof) that plays a cached film, reads the route and the sheet, restarts the daemon and reads the Cache page.
- Test behavior, not implementation: the tests assert files on disk, route answers, the fake ffmpeg's runs and the niceness it was given; none asserts a private call.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` (includes `tests/unit/docs/reference.test.ts`); focused:
`npx vitest run tests/unit/directStream/previews tests/unit/directStream/cache tests/unit/config.streamCache.test.ts tests/unit/config.test.ts tests/unit/directStream/positionRoute.test.ts tests/unit/docs`;
then `npm run docs:check` and `npm run test:int -- tests/integration/movies.streams.int.test.ts`.
**Proof:** a throwaway daemon caches a real 800 s HLS film from the fixture host, plays it from the cache, and the
previews route, the sheet route, the position answer, the disk and the Cache page show the behaviour.
- Harness: `.claude/skills/verify-notesd` (`up --direct-stream`, `api`, `restart`, `note`, `down`).
- Feature-map entries: `features/direct-streaming.md` "Stream cache" and "Playing from the cache" (neighbours only;
  the "Seek previews" entry is phase 5's, see Handoffs).
- Setup (once, for every journey): save the script below as `$S/previews-proof.sh` with
  `S=/tmp/claude-1000/-home-miftah-mcp-notes/09e2f240-99de-4681-a439-4a7bbd87d78a/scratchpad` (or any scratch
  folder), `chmod +x` it, and run everything from the worktree root. It prints `previews: PASS (<stages>)`, or
  `previews: FAIL at <stage>: <why>` and exits 1. Stages run in the order given on one run.

```bash
#!/usr/bin/env bash
# previews-proof.sh RUN STAGE...  (from the worktree root) — seek previews of a cloud cache on a
# `verify.sh up --direct-stream` run. Stages: partial, grow, restart, disk, off, failing (see the plan's Proof).
set -euo pipefail
V=.claude/skills/verify-notesd/scripts/verify.sh
VH="${VERIFY_HOME:-$HOME/.local/state/notesd-verify}"
RUN=${1:?usage: previews-proof.sh RUN STAGE...}
shift
DIR="$VH/$RUN"
DIRECT="$DIR/direct"
[ -s "$DIRECT/upstream.json" ] || { echo "previews: $RUN was not started with --direct-stream" >&2; exit 2; }
URL="http://127.0.0.1:$(cat "$DIR/port")"
EV="$DIR/evidence"
ST="$DIR/previews-proof"
FILM_DIR="${FILM_DIR:-$VH/.previews-film-800}"
mkdir -p "$ST"
STAGE=start
CODE=""
BODY=""
SID=""
REV=0
P=""

stage() { STAGE=$1; echo "== $STAGE"; }
ok() { echo "   ok  $*"; "$V" note "$RUN" "previews $STAGE: $*" >/dev/null; }
fail() { echo "previews: FAIL at $STAGE: $*" >&2; "$V" note "$RUN" "previews FAIL at $STAGE: $*" >/dev/null || true; exit 1; }
api() {
  local out
  out="$("$V" api "$RUN" "$@" 2>/dev/null)"
  CODE="$(sed -n 's/^< HTTP \([0-9]*\).*/\1/p' <<<"$out" | head -1)"
  BODY="$(sed '1,/^< HTTP /d' <<<"$out")"
}
cid() { cat "$ST/cid"; }
cdir() { echo "$DIR/data/movies/stream-cache/$(cid)"; }

# An 800 s HLS film: 320x180, 10 fps, a keyframe every 2 s, 200 segments of 4 s (made once, reused).
make_film() {
  [ -f "$FILM_DIR/.done" ] && return 0
  mkdir -p "$FILM_DIR"
  (
    cd "$FILM_DIR"
    ffmpeg -loglevel error -y -f lavfi -i "testsrc2=size=320x180:rate=10" -f lavfi -i "sine=frequency=440:sample_rate=48000" -t 800 \
      -c:v libx264 -preset ultrafast -pix_fmt yuv420p -g 20 -keyint_min 20 -sc_threshold 0 -c:a aac -b:a 32k \
      -f hls -hls_time 4 -hls_playlist_type vod -hls_segment_filename 'seg%03d.ts' index.m3u8
    printf '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x180,CODECS="avc1.640014,mp4a.40.2"\nindex.m3u8\n' >master.m3u8
  )
  touch "$FILM_DIR/.done"
}

# A ready cache of TMDB movie 550 from that film, through POST /api/stream/cache (the fake resolver's hls_film mode).
ensure_cache() {
  [ -s "$ST/cid" ] && return 0
  make_film
  [ -e "$DIRECT/film" ] || ln -s "$FILM_DIR" "$DIRECT/film"
  printf '1\n' >"$DIRECT/token"
  printf 'hls_film\n' >"$DIRECT/mode"
  api POST /api/stream/cache '{"kind":"movie","tmdb_id":550}'
  [[ $CODE == 20? ]] || fail "POST /api/stream/cache answered HTTP $CODE: $BODY"
  local id state="" i
  id="$(jq -r '.cache.id // empty' <<<"$BODY")"
  [ -n "$id" ] || fail "POST /api/stream/cache named no cache: $BODY"
  for i in $(seq 1 120); do
    api GET "/api/stream/cache/$id"
    state="$(jq -r '.cache.state // .state // empty' <<<"$BODY")"
    [ "$state" = ready ] && break
    [ "$state" = failed ] && fail "the cache failed: $BODY"
    sleep 1
  done
  [ "$state" = ready ] || fail "the cache is [$state] after 120 s"
  echo "$id" >"$ST/cid"
  [ "$(ls "$(cdir)" | grep -c '^v-[0-9]*\.ts$')" = 200 ] || fail "the cache does not hold 200 segments"
  ok "cache $id of the 800 s film is ready"
}

play() {
  api POST /api/stream/play '{"kind":"movie","tmdb_id":550}'
  [ "$CODE" = 200 ] || fail "a play answered HTTP $CODE: $BODY"
  [ "$(jq -r .session.cached.id <<<"$BODY")" = "$(cid)" ] || fail "the play is not from the cache: $(jq -c .session.cached <<<"$BODY")"
  [ "$(jq -r .session.preview_rev <<<"$BODY")" = 0 ] || fail "a new session's preview_rev is not 0: $(jq -c .session <<<"$BODY")"
  SID="$(jq -r .session.session_id <<<"$BODY")"
}

report() {
  api POST "/api/stream/sessions/$SID/position" '{"position_s":10,"duration_s":800}'
  [ "$CODE" = 200 ] || fail "a position report answered HTTP $CODE: $BODY"
  REV="$(jq -r .preview_rev <<<"$BODY")"
  [[ $REV =~ ^[0-9]+$ ]] || fail "the position answer carries no preview_rev: $BODY"
}

previews() {
  P="$EV/previews-$1.json"
  curl -sS "$URL/api/stream/sessions/$SID/previews" >"$P"
}

# wait_for STATE NAME: a position report every 3 s until the previews say STATE (at most 150 s).
wait_for() {
  local i
  for i in $(seq 1 50); do
    report
    previews "$2"
    [ "$(jq -r .state "$P")" = "$1" ] && return 0
    sleep 3
  done
  fail "the previews are $(jq -c '{state, rev, cues: (.cues | length)}' "$P") after 150 s, wanted $1"
}

sheet_ids() { stat -c '%n %i %Y' "$(cdir)/previews/sheet-00000.jpg" "$(cdir)/previews/sheet-00002.jpg"; }

stage_partial() {
  stage partial
  ensure_cache
  mkdir -p "$ST/held"
  local k rev url
  for k in $(seq 91 180); do mv "$(cdir)/$(printf 'v-%05d.ts' "$k")" "$ST/held/"; done
  play
  wait_for partial partial
  jq -e '.source == "local" and (.cues | length) == 44 and .cues[0].start_s == 0 and .cues[-1].end_s == 800
         and ([.cues[] | select(.start_s >= 360 and .start_s < 720)] | length) == 0
         and ([.cues[] | select(.w == 240 and (.url | startswith("/api/stream/sessions/")))] | length) == 44' "$P" >/dev/null ||
    fail "the partial previews are wrong: $(jq -c '{state, source, n: (.cues | length), first: .cues[0], last: .cues[-1]}' "$P")"
  rev="$(jq -r .rev "$P")"
  [ "$rev" -ge 1 ] || fail "rev is $rev with frames listed"
  report
  [ "$REV" = "$rev" ] || fail "the position answer says preview_rev $REV, the previews say $rev"
  url="$(jq -r '.cues[0].url' "$P")"
  curl -sS -D "$EV/previews-sheet0.head" -o "$EV/previews-sheet0.jpg" "$URL$url"
  grep -qi '^content-type: image/jpeg' "$EV/previews-sheet0.head" || fail "the sheet is not served as image/jpeg"
  file "$EV/previews-sheet0.jpg" | grep -q '1440x' || fail "the sheet is not 1440 px wide: $(file "$EV/previews-sheet0.jpg")"
  [ "$(ls "$(cdir)/previews" | grep -cE '^sheet-0000[02]\.jpg$')" = 2 ] || fail "sheets 0 and 2 are not both on disk"
  [ ! -e "$(cdir)/previews/sheet-00001.jpg" ] || fail "sheet 1 was made with its stretch not on disk"
  [ -z "$(ls "$(cdir)/previews" | grep '\.part$' || true)" ] || fail "a .part file was left"
  grep -q 'previews: made sheet 1/3 of cache-.* (nice 19)$' "$DIR/daemon.log" || fail "no 'made sheet 1/3 ... (nice 19)' line in the daemon log"
  sheet_ids >"$ST/before"
  ok "frames for [0, 360) and [720, 800) only (44 cues, rev $rev, the position answer agrees); sheet 0 served as a 1440 px JPEG; made at nice 19"
}

stage_grow() {
  stage grow
  local rev0 rev
  rev0="$(jq -r .rev "$P")"
  mv "$ST/held/"*.ts "$(cdir)/"
  wait_for ready grow
  jq -e '.source == "local" and (.cues | length) == 80' "$P" >/dev/null || fail "the ready previews are wrong: $(jq -c '{state, n: (.cues | length)}' "$P")"
  rev="$(jq -r .rev "$P")"
  [ "$rev" -gt "$rev0" ] || fail "rev did not rise ($rev0 -> $rev)"
  report
  [ "$REV" -ge "$rev" ] || fail "the position answer says preview_rev $REV, below the previews' $rev"
  sheet_ids | diff - "$ST/before" >/dev/null || fail "a finished sheet was made again"
  ok "the stretch back on disk got its sheet: 80 cues, rev $rev0 -> $rev, the position answer carries it, sheets 0 and 2 untouched"
}

stage_restart() {
  stage restart
  mv "$ST/held/"*.ts "$(cdir)/"
  [ ! -e "$(cdir)/previews/sheet-00001.jpg" ] || fail "inconclusive: sheet 1 was made before the restart"
  "$V" restart "$RUN" >/dev/null
  play
  wait_for ready restart
  sheet_ids | diff - "$ST/before" >/dev/null || fail "a sheet finished before the restart was made again"
  [ -f "$(cdir)/previews/sheet-00001.jpg" ] || fail "sheet 1 is missing"
  ok "after a restart only sheet 1 was made; sheets 0 and 2 kept their inode and time"
}

stage_disk() {
  stage disk
  [ -d "$(cdir)/previews" ] || fail "no previews folder"
  local want top got
  want="$(find "$(cdir)" -type f -printf '%b\n' | awk '{s += $1} END {print s * 512}')"
  top="$(find "$(cdir)" -maxdepth 1 -type f -printf '%b\n' | awk '{s += $1} END {print s * 512}')"
  api GET /api/stream/disk
  got="$(jq -r .cloud_bytes <<<"$BODY")"
  [ "$got" = "$want" ] || fail "the Cache page says $got bytes; the folder with its previews takes $want"
  [ "$got" -gt "$top" ] || fail "the previews are not counted ($got, $top without them)"
  api DELETE "/api/stream/cache/$(cid)"
  [ "$CODE" = 200 ] || fail "DELETE /api/stream/cache answered HTTP $CODE: $BODY"
  [ ! -e "$(cdir)" ] || fail "the cache folder (with its previews) is still there"
  ok "the Cache page counts the previews ($got bytes, $top without them); deleting the cache took them"
}

stage_off() {
  stage off
  ensure_cache
  play
  local i
  for i in 1 2 3 4 5 6 7; do report; sleep 3; done
  previews off
  [ "$(jq -c . "$P")" = '{"state":"none","rev":0,"source":null,"cues":[]}' ] || fail "with previews off the route answered $(jq -c . "$P")"
  [ "$REV" = 0 ] || fail "preview_rev is $REV with previews off"
  [ ! -e "$(cdir)/previews" ] || fail "a previews folder was made with previews off"
  ! grep -q 'previews:' "$DIR/daemon.log" || fail "the daemon logged preview work with previews off"
  ok "no frame, rev 0, no folder, no preview log line with NOTESD_STREAM_PREVIEWS=off"
}

stage_failing() {
  stage failing
  ensure_cache
  play
  local i s failed gave lines
  for i in $(seq 1 25); do report; sleep 3; done
  previews failing
  [ "$(jq -r .state "$P")" = none ] || fail "frames were listed with a failing ffmpeg: $(jq -c '{state}' "$P")"
  [ -z "$(ls -A "$(cdir)/previews" 2>/dev/null | grep -E '^sheet-|\.part$' || true)" ] || fail "a sheet or part of one was left: $(ls -A "$(cdir)/previews")"
  for s in 1 2 3; do
    failed="$(grep -c "previews: sheet $s/3 of .* failed (" "$DIR/daemon.log" || true)"
    gave="$(grep -c "previews: giving up on sheet $s/3 of " "$DIR/daemon.log" || true)"
    { [ "$failed" = 2 ] && [ "$gave" = 1 ]; } || fail "sheet $s: $failed retries and $gave give-ups logged, wanted 2 and 1"
  done
  lines="$(grep -c 'previews:' "$DIR/daemon.log")"
  for i in $(seq 1 10); do report; sleep 3; done
  [ "$(grep -c 'previews:' "$DIR/daemon.log")" = "$lines" ] || fail "preview work went on after the tries ran out"
  api GET "/api/stream/sessions/$SID"
  [ "$CODE" = 200 ] || fail "the session answered HTTP $CODE"
  [ "$(jq -r .cached.id <<<"$BODY")" = "$(cid)" ] || fail "the play changed: $(jq -c .cached <<<"$BODY")"
  ok "each sheet tried 3 times (2 retries, 1 give-up), nothing kept, no more work, the play untouched"
}

DONE=()
for s in "$@"; do
  case "$s" in
    partial | grow | restart | disk | off | failing) "stage_$s" ;;
    *) fail "unknown stage $s" ;;
  esac
  DONE+=("$s")
done
echo "previews: PASS (${DONE[*]})"
"$V" note "$RUN" "previews: PASS (${DONE[*]})" >/dev/null
```

- Journeys:
  - **J1** · traces R1.2, R2.3, R2.8 — `npx vitest run tests/unit/directStream/previews` → passes when every test passes and `previews.ffmpeg.test.ts` is not reported as skipped (`which ffmpeg` prints a path): sheets only for the stretches on disk, a 1440 x 816 JPEG, one ffmpeg at a time at nice 19, a second instance makes only the missing sheet.
  - **J2** · traces R1.2, R2.3 — `V=.claude/skills/verify-notesd/scripts/verify.sh; NOTESD_STREAM_PREVIEWS=on $V up --direct-stream` (note RUN), then `$S/previews-proof.sh RUN partial grow` → passes when it prints `previews: PASS (partial grow)`: with segments 91-180 of the cache moved away, `GET /api/stream/sessions/<sid>/previews` lists exactly 44 cues covering [0, 360) and [720, 800), each 240 px wide, the first cue's sheet answers `image/jpeg` 1440 px wide, sheet 1 is not on disk, no `.part` is left, and the daemon log has `made sheet 1/3 of cache-... (nice 19)`.
  - **J3** · traces R1.5 — the `grow` stage of J2's run → passes when, after the segments come back, the previews turn `ready` with 80 cues, `rev` is higher than the partial one, and the position answer's `preview_rev` is at least that `rev` (the page's signal to fetch again), with sheets 0 and 2 keeping their inode and mtime.
  - **J4** · traces R2.8 — a fresh run: `NOTESD_STREAM_PREVIEWS=on $V up --direct-stream`, then `$S/previews-proof.sh RUN partial restart disk` → passes when it prints `previews: PASS (partial restart disk)`: after `verify.sh restart` with the missing stretch restored, a new play's previews reach `ready`, `sheet-00001.jpg` exists, and `stat -c '%n %i %Y'` of sheets 0 and 2 is identical to before the restart.
  - **J5** · traces R2.5 — the `disk` stage of J4's run → passes when `GET /api/stream/disk`'s `cloud_bytes` equals the 512-byte blocks of every file under the cache folder (previews included) and is larger than the top-level files alone, and after `DELETE /api/stream/cache/<id>` the folder, `previews/` with it, no longer exists. Also `npx vitest run tests/unit/directStream/cache/diskSize.test.ts` passes.
  - **J6** · traces R2.7 — a fresh run: `NOTESD_STREAM_PREVIEWS=off $V up --direct-stream` (verify.sh's default; said here so the run cannot be mistaken), then `$S/previews-proof.sh RUN off` → passes when it prints `previews: PASS (off)`: the previews route answers exactly `{"state":"none","rev":0,"source":null,"cues":[]}`, the position answer's `preview_rev` is 0, the cache folder has no `previews/`, and the daemon log has no `previews:` line. Also the "previews off" case in `tests/unit/directStream/previews/routes.test.ts` passes.
  - **J7** · traces R2.2 — `printf '#!/bin/sh\nfor last; do :; done\nprintf "half a sheet" > "$last"\nexit 1\n' > $S/bad-ffmpeg && chmod +x $S/bad-ffmpeg`, then a fresh run `NOTESD_STREAM_PREVIEWS=on NOTESD_FFMPEG_BIN=$S/bad-ffmpeg $V up --direct-stream` and `$S/previews-proof.sh RUN failing` → passes when it prints `previews: PASS (failing)`: no `sheet-*` or `*.part` file in the cache's `previews/`, each of the 3 sheets logged exactly 2 `failed (` lines and 1 `giving up` line, 30 more seconds of reports add no `previews:` log line, and the session still answers 200 from the same cache. The missing-binary and time-limit cases: `npx vitest run tests/unit/directStream/previews/builder.test.ts tests/unit/directStream/previews/service.test.ts` passes ("kills an ffmpeg past its time limit and keeps nothing", "a missing ffmpeg is said once and nothing more is tried").
- Neighbor check: playing from the cache and the cache's own folder are what this phase touches most (`diskSize`,
  a new `previews/` subfolder, the position route). On a fresh `$V up --direct-stream` run:
  `.claude/skills/verify-notesd/scripts/direct-stream/cache-play.sh RUN ready downloading other-host` → passes when
  it ends with `cache-play: PASS (ready downloading other-host)`; and `npx vitest run tests/unit/directStream/cacheShelf.test.ts tests/unit/directStream/cache tests/unit/directStream/positionRoute.test.ts tests/unit/directStream/torrent/positionPlayed.test.ts` passes.
- Cost: none. No billed call: the fake resolver, the fixture host and this machine's ffmpeg only. Each `$V down RUN`
  afterwards.

**Exit criteria:** `npm run typecheck`, `npm test` and `npm run docs:check` pass; J1 to J7 and the neighbor check
pass; with a cache on disk (whole or partly) a session playing that title lists frames for exactly the stretches on
disk; sheets survive a restart; a failing ffmpeg leaves no file and stops after three tries; with the switch off
nothing is spawned and the route answers no frame.

## Handoffs

- **Phase 2 (R1.3, R2.4, the torrent half of R2.5):** build the torrent source as
  `new LocalSource('torrent', videos, deps.log)` with a `LocalVideos` of its own (`forSession`: a torrent session's
  file or remux; `whole`: whole files and whole remuxes, which the sweep then completes), exported as the factory
  `torrentSource(deps: PreviewSourceDeps)`, and add exactly one import and one line to `PREVIEW_SOURCES` in
  `src/directStream/previews/sources.ts`, before `cacheSource`. `PreviewSourceDeps` carries `torrents`, and
  `src/daemon.ts` already passes it: phase 2 does not edit `daemon.ts`, `background.ts` or `httpRoutes.ts`. A stretch
  that runs out of pieces throws `PreviewNotYet` from `input()` or from its `cleanup()`: it counts as "not yet", never
  as a failure. Inputs run under `-protocol_whitelist file,crypto,data,concat`; a partly downloaded file is read
  through the in-process 127.0.0.1 gate by answering `loopback: true` from `input()` (the builder then adds
  `http,tcp` and refuses any other host). Each torrent video names its `home` (`<root>/<hash>`, `PreviewHome`), so
  the builder never makes `<hash>/` again after a delete. `startBackground` closes the previews before every other
  closer, the torrents included. Ownership and sizes of `<hash>/notesd-previews/<index>/` are phase 2's.
- **Phase 3 (R1.4, R2.6):** export the factory `providerSource(deps: PreviewSourceDeps)` and add it, with its import,
  as the first line of `PREVIEW_SOURCES`; it reads `deps.fetch` (the pass-through's) and calls `deps.changed(session)`
  when a track's frames arrive or go, which lists the session again and raises `preview_rev` if the list differs. The
  position route never awaits `list()` (`reported()` is synchronous), so the provider's first 3 s wait never delays
  it. Replace the `` `source` is `local`: ... `` sentence of the `GET /api/stream/sessions/:id/previews` entry in
  `scripts/docs/httpRoutes.ts` (as written in Step 17) to add `provider`, and run `npm run docs:gen`. Phase 3 does
  not edit `daemon.ts`.
- **Phase 4 (R1.1, the page half of R1.5, R2.1):** the routes, `preview_rev` in the session and in the position answer
  follow the index's contract exactly; cue `url`s carry `?k=<8 hex>`, which the page uses as is.
- **Phase 5:** the feature-map entry "Seek previews" in `.claude/skills/verify-notesd/features/direct-streaming.md`
  (phase 1 changes what a user can do through the API, but the index gives the feature map to phase 5); it can reuse
  the Proof script above. Point the `NOTESD_STREAM_PREVIEWS` row in `configuration.md` at the new
  `streaming.md#seek-previews` section once it exists. The docs-shots throwaway daemon (`scripts/docs/shots/`) now
  runs with previews on by default (config default) unless it pins `NOTESD_STREAM_PREVIEWS`; its player pictures fake
  the stream routes, so it needs no pin. A verify run builds previews only with `NOTESD_STREAM_PREVIEWS=on` from the caller.
- None of this phase's journeys traces another phase's criterion.

## Rollback

Revert this phase's commit(s): the `src/directStream/previews/` folder, the wiring in `deps.ts`, `daemon.ts` and
`background.ts`, the two routes, the session field and the config key go together; run `npm run docs:gen` after
the revert. Without reverting, `NOTESD_STREAM_PREVIEWS=off` stops every build and empties the route. `previews/`
folders already made inside caches stay until their cache is deleted (they are counted in its size either way once
this phase is in; after a revert, `diskSize` counts top-level files again and ignores them).
