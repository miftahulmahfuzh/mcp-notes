# Phase 2: Torrent previews: file, remux, partial download

**Plan set:** `SEEK_PREVIEW_THUMBNAILS_PLAN.md`
**Analysis:** `.workflows/analyze/20261120-192436-K7QP_code_analyzer.md`
**Satisfies:** R1, R2 — the hover frame for a torrent play, built without ever touching the swarm, and deleted with its download
**Criteria:** R1.3, R2.4, R2.5
**Depends on:** Phase 1
**Difficulty:** HARD
**Package:** `src/directStream/previews`, `src/directStream/torrent`

---

## Goal

A torrent session's `GET /api/stream/sessions/:id/previews` lists frames for every stretch of its video on this
machine: the file whole on disk, its remux (whole or growing), or the part of a file that plays as is and is still
downloading. The sheets live in `<torrent dir>/<hash>/notesd-previews/<file index>/`, count in the episode's size on
the Cache page and the budget, and go with a one-episode or whole-download delete. No preview path can use, select,
read through or hold a torrent. A test proves this: the fake engine records nothing and the torrent still leaves the
swarm when its linger time runs out.

## Assumptions (on phase 1, reconciled against phase 1's plan)

Phase 1's code does not exist yet. The reconciler lined each assumption up with phase 1's plan; this plan now uses
phase 1's names:

- **A1.** `src/directStream/previews/types.ts` exports `PreviewCue`, `PreviewList`, `PreviewSource`, `LocalVideo`,
  `PreviewInput` (`{args, cleanup?, loopback?: true}`), `PreviewNotYet`, `PreviewHome` and `noPreviews()`.
  `PreviewSource.list` takes `StreamSession` from `src/directStream/sessions.ts`. (Phase 1 Step 1.)
- **A2.** Phase 1's core is `LocalSource` (`src/directStream/previews/local.ts`): `new LocalSource('torrent', videos,
  log)` with `videos: LocalVideos` (`forSession(session)`, `whole()`). Its `list` reads the finished sheets of the
  video `forSession` gives and lists them with session-scoped `url`s; the sheets are queued by `StreamPreviews` (the
  session on screen on each position report, every `PREVIEW_LOOK_MS`), not by `list`. (Phase 1 Steps 6, 10.)
- **A3.** The sheet route asks each `LocalSource`'s `video(session)` for the folder, so the torrent source being a
  `LocalSource` is what makes its sheets served. (Phase 1 Step 10, `StreamPreviews.sheet`.)
- **A4 (input arguments).** Phase 1's convention, the same as this plan's: `input(startS, endS).args` is the whole
  ffmpeg input section, input `-ss`/`-t` included, then `-i <input>`; the builder adds no seek, and frame k stands for
  `startS + k × interval`. The torrent source returns `['-ss', s, '-t', len, '-i', x]` (with `-rw_timeout` before
  them for the gate). (Phase 1 Step 1 `PreviewInput`, Step 4.)
- **A5.** Phase 1's builder runs ffmpeg with `-xerror` and awaits `cleanup()` after ffmpeg exits, before it keeps
  anything. A `PreviewNotYet` from `cleanup()` makes a failed run "not yet" (no try used); a run that exited 0 with a
  good JPEG is kept whatever the cleanup says (every byte it read was served from disk). Any other cleanup error is
  logged and does not fail the sheet. A throw from `input()` other than `PreviewNotYet` fails that sheet, never the
  queue. Its whitelist is `file,crypto,data,concat`; an input answering `loopback: true` gets `http,tcp` too, and
  every `-i` address of it must be `http://127.0.0.1` or the input is not run. (Phase 1 Steps 1, 4.)
- **A6.** The builder makes `video.dir` one level at a time inside the video's home and never makes the home: each
  torrent video names `home: <root>/<hash>` (`PreviewHome`), so a delete racing a build never brings back the
  torrent's folder or `notesd-previews/<i>/`. (Phase 1 Step 4, reconciled from this plan's handoff.)
- **A7.** The retry limit (3 per daemon run) counts per sheet and only failures; a sheet whose stretch is not inside
  `coverage()` is not tried. A gate miss (a 416, or an answer cut short at the end of the bytes on disk) is
  `PreviewNotYet` from `cleanup()`, and its byte goes into the gap book, so a partial download never uses up a
  sheet's tries; the builder still keeps a sheet ffmpeg made (exit 0). (Phase 1 Steps 4, 5.)
- **A8.** Phase 1's sweep (30 s after start, then every 30 minutes) calls `whole()` on every `LocalSource`'s
  `LocalVideos`. (Phase 1 Step 10.)
- **A9.** `src/directStream/previews/sources.ts` holds `PREVIEW_SOURCES`, a list of factories
  `(deps: PreviewSourceDeps) => PreviewSource | null`, one per line, asked in the order provider, torrent, cache.
  `deps.torrents` is the daemon's `TorrentStreams | null`, `deps.log` the log. Phase 2 adds one import and one line
  and does not edit `src/daemon.ts`. (Phase 1 Step 9.)
- **A10.** `verify.sh` keeps previews off unless the caller sets `NOTESD_STREAM_PREVIEWS=on`, which passes through.
  (Phase 1 Step 19.)
- **A11.** `GET /api/stream/sessions/:id/previews` reads the session with `service().session(id)`, and the torrent
  source reads the disk only: it never calls `hold`. J2 proves this end to end. (Phase 1 Step 16.)

## Interface Contract

**Deletes:** none
**Renames:** none
**Creates:**
- `PREVIEWS_DIR` = `'notesd-previews'` (`src/directStream/torrent/usage.ts`)
- `FileOnDisk`, `WholeVideo` types and the methods `TorrentStreams.onDisk(infoHash, index)` and `TorrentStreams.wholeVideos()` (`src/directStream/torrent/service.ts`)
- `TorrentVideos` (implements phase 1's `LocalVideos`), `torrentVideos()`, `torrentSource` (the registry factory: a `LocalSource('torrent', …)`), `PreviewTorrents`, `TorrentVideo`, `readRemux`, `RemuxOnDisk`, `RemuxSegment`, `partialCoverage`, `openGate`, `previewsDirOf`, `PARTIAL_HEAD_BYTES`, `PARTIAL_MARGIN_MIN_BYTES`, `PARTIAL_MARGIN_SHARE` (`src/directStream/previews/torrentSource.ts`)
- One entry in `src/directStream/previews/sources.ts`
**Signature changes:** none. `ownersOf` keeps its signature and now also gives `notesd-previews/<i>/…` to the episodes that chose file `i`.
**Requires (from earlier phases):** phase 1's `types.ts` with `PreviewInput`, `PreviewNotYet`, `PreviewHome` (A1), `LocalSource` and `LocalVideos` (A2), its sheet route (A3), the input convention (A4), `-xerror`, the whitelist with `loopback` and `cleanup()` handling (A5), the home rule (A6), the sweep's `whole()` (A8), the registry and `PreviewSourceDeps.torrents` (A9), the verify switch (A10), a previews route that does not hold (A11)
**Leaves alone (owned by others):** `web/` (phase 4), `claude/streaming/` and `providerSource.ts` (phase 3), the cache source and the builder/queue/index/routes/config/wiring (phase 1), `passThrough.ts`, `docs/guide/*` prose, `CLAUDE.md`, `.claude/skills/verify-notesd/features/*` (phase 5)

## Files

| File | Action | What changes |
|---|---|---|
| `src/directStream/torrent/usage.ts:18-37` | modify | `PREVIEWS_DIR`; `ownersOf` gives `notesd-previews/<i>/…` to file `i`'s episodes |
| `src/directStream/torrent/service.ts:59` (types), `:435` (`onDisk`), `:537` (`wholeVideos`) | modify | two read-only methods for the preview source |
| `src/directStream/previews/torrentSource.ts` | create | the source, its three `LocalVideo` shapes, the loopback gate |
| `src/directStream/previews/sources.ts` (phase 1's file) | modify | one import, one registry line `torrentSource,` before `cacheSource,` |
| `tests/unit/directStream/torrent/previewFiles.test.ts` | create | R2.5: sizes, one-episode delete, whole delete, budget, keepDays |
| `tests/unit/directStream/previews/torrentSource.test.ts` | create | R1.3/R2.4: shapes, coverage, the gate, no swarm touched, remux-only, sweep |
| `tests/unit/directStream/previews/torrentSource.ffmpeg.test.ts` | create | real ffmpeg: remux frames equal the file's; a missing byte fails at once |

## Implementation Steps

### Step 1: Give the preview folder to its episode
**File:** `src/directStream/torrent/usage.ts:18-37`
**Change:** Replace the constants and `ownersOf` (lines 18–37) with the code below. The sizes (`TorrentFolder.size`,
`usage`) and the deletes (`remove`, `removeInside`) already walk and remove recursively. They need no change, and
Step 5's tests prove it.
**Code:**
```ts
const REMUX_DIR = 'notesd-remux';
/**
 * `notesd-previews/<file index>/`: the seek-preview sheets made from one video of the torrent, whichever shape it was
 * read in (the file, its remux, the part on disk): src/directStream/previews/torrentSource.ts.
 */
export const PREVIEWS_DIR = 'notesd-previews';
/** `notesd-cues/embedded-<file index>-<stream index>.jsonl`, `notesd-cues/whisper-<file index>.jsonl`. */
const CUE_FILE = /^(?:embedded|whisper)-(\d+)(?:-\d+)?\.jsonl$/;

/**
 * Which episodes of a torrent own one file of its folder: the rows that chose it (by its path on disk), the rows whose
 * video a remux folder (`notesd-remux/<file index>/`), a preview folder (`notesd-previews/<file index>/`) or a cue feed
 * was made from. Anything else (the kept subtitles, the edges of files nobody chose) has no owner.
 */
export function ownersOf(rel: string, rows: readonly StreamTorrentRow[], relOf: (filePath: string) => string | null): StreamTorrentRow[] {
  const parts = rel.split('/');
  let index: number | null = null;
  if ((parts[0] === REMUX_DIR || parts[0] === PREVIEWS_DIR) && parts.length >= 3) index = Number(parts[1]);
  else if (parts[0] === CUES_DIR && parts.length === 2) {
    const m = CUE_FILE.exec(parts[1]!);
    if (m !== null) index = Number(m[1]);
  }
  if (index !== null) return Number.isInteger(index) ? rows.filter((r) => r.fileIndex === index || r.files.some((f) => f.index === index)) : [];
  return rows.filter((r) => r.files.some((f) => relOf(f.path) === rel));
}
```
**Impact:** `splitUsage` and `removalPlan` (same file) now give an episode its preview bytes and take them when it is
deleted. Nothing else changes: before this step, a `notesd-previews/` file had no owner and counted as shared.

### Step 2: Two read-only questions on TorrentStreams
**File:** `src/directStream/torrent/service.ts`
**Change (a), after `sameRef` (line 59):** add the two exported types.
```ts
/**
 * One chosen file of a torrent as this machine's disk holds it now (TorrentStreams.onDisk). `whole`: at its full
 * length. `partial`: the byte stretches whose pieces are verified on disk, `[from, to)`, in order; empty when the
 * torrent is not in the swarm and nothing says which pieces are there.
 */
export type FileOnDisk =
  | { readonly kind: 'whole'; readonly path: string; readonly length: number }
  | { readonly kind: 'partial'; readonly path: string; readonly length: number; readonly ranges: readonly [number, number][] };

/** A chosen video of this host that is whole on disk: as its file, or as its finished remux alone (its original was deleted). */
export type WholeVideo = { readonly infoHash: string; readonly fileIndex: number; readonly durationS: number | null } & (
  | { readonly via: 'file'; readonly path: string }
  | { readonly via: 'remux' }
);
```
**Change (b), after `remuxOnly()` (ends line 435):** add `onDisk`.
```ts
  /**
   * File `index` of a torrent as it is on this machine's disk now, for the seek previews (previews/torrentSource.ts).
   * It reads the row, the disk and the swarm's map of verified pieces only. It never opens, uses, selects, reads
   * through or holds the torrent, and it is not a request: a torrent waiting to leave the swarm leaves on time. Null
   * for an unknown hash, the other machine's, a file no episode chose, or one that lives as its remux (its original
   * is gone).
   */
  async onDisk(infoHash: string, index: number): Promise<FileOnDisk | null> {
    const hash = normalizeInfoHash(infoHash);
    if (hash === null) return null;
    const found = await this.rowHere(hash, index);
    if (found instanceof Response) return null;
    const file = found.files.find((f) => f.index === index);
    if (file === undefined || file.remuxed === true) return null;
    const target = this.folder.diskPath(hash, file.path);
    if (target === null) return null;
    const whole = await this.filePath(hash, index);
    if (whole !== null) return { kind: 'whole', path: whole, length: file.length };
    const live = this.active.get(hash);
    return { kind: 'partial', path: target, length: file.length, ranges: live === undefined ? [] : live.handle.ranges(index) };
  }
```
**Change (c), after `diskUsage()` (ends line 537):** add `wholeVideos`.
```ts
  /**
   * This host's chosen videos that are whole on disk now, for the seek previews' sweep: a ready row's video at its full
   * length, or one that lives as its finished remux. It reads rows and the disk only, and joins or holds nothing.
   */
  async wholeVideos(): Promise<WholeVideo[]> {
    const out: WholeVideo[] = [];
    for (const row of await this.hostRows()) {
      if (row.state !== 'ready' || row.fileIndex === null) continue;
      const video = row.files.find((f) => f.index === row.fileIndex);
      if (video === undefined) continue;
      const base = { infoHash: row.infoHash, fileIndex: video.index, durationS: row.durationS };
      if (video.remuxed === true) {
        if (this.opts.remuxes?.playable(row.infoHash, video.index) === true) out.push({ ...base, via: 'remux' });
        continue;
      }
      const whole = await this.folder.complete(row.infoHash, video.path, video.length);
      if (whole !== null) out.push({ ...base, via: 'file', path: whole });
    }
    return out;
  }
```
**Impact:** these are new methods only, so no existing caller changes. Neither method sets `lastRequestAt` or touches
`users`, and neither calls `use`/`select`/`read`/`open`. `filePath` and `rowHere` are reused as they are.

### Step 3: The torrent preview source
**File:** `src/directStream/previews/torrentSource.ts` (new)
**Code:**
```ts
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { StreamSession } from '../sessions.js';
import { readRemuxProbe, REMUX_DONE_FILE, REMUX_PLAYLIST, remuxDir } from '../torrent/remux.js';
import type { FileOnDisk, TorrentStreams, WholeVideo } from '../torrent/service.js';
import { PREVIEWS_DIR } from '../torrent/usage.js';
import { LocalSource, type LocalVideos } from './local.js';
import type { PreviewSourceFactory } from './sources.js';
import { PreviewNotYet, type LocalVideo, type PreviewHome } from './types.js';

/**
 * Seek previews from a torrent's video on this machine (seek-preview-thumbnails phase 2). The video can be in one of
 * three shapes:
 *   - the file whole on disk, read from its path;
 *   - its remux (`notesd-remux/<file index>/`, whole or still growing), read as its init section followed by the
 *     segments of one stretch (ffmpeg's `concat:` protocol: the bytes of a fragmented MP4);
 *   - the file partly on disk, played as is, read through a loopback gate (the input says `loopback: true`, so phase
 *     1's builder allows http to 127.0.0.1 and nothing else). The gate serves only the bytes whose pieces are verified
 *     on disk and refuses any other, so a read that would need a missing piece ends the sheet at once, as
 *     PreviewNotYet (never a try used up).
 * In every shape, the sheets of file `i` live in `<torrent dir>/<info hash>/notesd-previews/<i>/`, and the video's
 * home is `<torrent dir>/<info hash>/` (the builder never makes it again after a delete). usage.ts gives that folder to
 * the episode whose video it is, and the sheets of the original stay valid once only its remux is left. The source is
 * phase 1's LocalSource over TorrentVideos. Nothing here opens, uses, selects, reads through or holds a torrent: it
 * sees TorrentStreams only through PreviewTorrents' three read-only members (torrentVideos builds that view).
 */

/** A file partly on disk is tried only once its first bytes (the container's header) are there. */
export const PARTIAL_HEAD_BYTES = 4 * 1024 * 1024;
/**
 * The byte-to-time map of a file partly on disk is a proportion: bytes over the length, times the film's length. A
 * stretch is offered only this far inside a run of bytes on disk, the larger of this floor and PARTIAL_MARGIN_SHARE of
 * the file, to allow for a bitrate that is not even. The gate still refuses whatever the proportion misjudges.
 */
export const PARTIAL_MARGIN_MIN_BYTES = 8 * 1024 * 1024;
export const PARTIAL_MARGIN_SHARE = 0.02;
/** The gate never stalls, but ffmpeg gives up on a read that does after this long (microseconds). */
const GATE_RW_TIMEOUT_US = '15000000';
const INIT_NAME = 'init.mp4';
const SEGMENT_NAME = /^seg-\d{5}\.m4s$/;

type Stretches = Array<[number, number]>;
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const secs = (n: number): string => (Math.round(n * 1000) / 1000).toFixed(3);

/** What the source reads of TorrentStreams. None of these opens, uses, selects, reads through or holds a torrent. */
export interface PreviewTorrents {
  /** `config.torrent.dir`: `<root>/<info hash>/` is one torrent's folder. */
  readonly root: string;
  onDisk(infoHash: string, index: number): Promise<FileOnDisk | null>;
  wholeVideos(): Promise<WholeVideo[]>;
}

/** `<root>/<info hash>/notesd-previews/<file index>/`. */
export function previewsDirOf(root: string, infoHash: string, fileIndex: number): string {
  return path.join(root, infoHash, PREVIEWS_DIR, String(fileIndex));
}

/** ffmpeg's input for one stretch of `input`: an input seek of `skipS` (ffmpeg decodes up to it and drops the frames before) and a length. */
function stretchArgs(input: string, skipS: number, lengthS: number): string[] {
  return ['-ss', secs(Math.max(0, skipS)), '-t', secs(lengthS), '-i', input];
}

export interface RemuxSegment {
  readonly name: string;
  readonly startS: number;
  readonly endS: number;
}

export interface RemuxOnDisk {
  /** In order. Every segment the playlist lists is whole on disk: the remux renames each one into place (temp_file). */
  readonly segments: readonly RemuxSegment[];
  /** `done.json` is there: ffmpeg read the whole file and exited cleanly. */
  readonly whole: boolean;
}

/**
 * The remux in `dir` as its playlist lists it now. Null when there is no playlist, or when it names anything but its
 * own `init.mp4` and `seg-NNNNN.m4s`. The names are checked here once, before they become a path in an ffmpeg input.
 */
export async function readRemux(dir: string): Promise<RemuxOnDisk | null> {
  let text: string;
  try {
    text = await readFile(path.join(dir, REMUX_PLAYLIST), 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n').map((l) => l.trim());
  const map = /^#EXT-X-MAP:URI="([^"]+)"/.exec(lines.find((l) => l.startsWith('#EXT-X-MAP:')) ?? '')?.[1];
  if (map !== INIT_NAME) return null;
  const segments: RemuxSegment[] = [];
  let at = 0;
  let length: number | null = null;
  for (const line of lines) {
    const inf = /^#EXTINF:([\d.]+)/.exec(line);
    if (inf !== null) {
      length = Number(inf[1]);
      continue;
    }
    if (line === '' || line.startsWith('#')) continue;
    if (!SEGMENT_NAME.test(line) || length === null || !Number.isFinite(length)) return null;
    segments.push({ name: line, startS: at, endS: at + length });
    at += length;
    length = null;
  }
  return { segments, whole: existsSync(path.join(dir, REMUX_DONE_FILE)) };
}

/**
 * The stretches of a film (seconds) that a file partly on disk is worth trying for. It needs the header (the first
 * PARTIAL_HEAD_BYTES), takes each run of bytes on disk less a margin at each inner edge, and maps it to seconds by
 * proportion. With `gapAt` set and that byte still missing, it offers nothing: the last try needed it.
 */
export function partialCoverage(length: number, ranges: readonly [number, number][], durationS: number, gapAt: number | null): Stretches {
  if (length <= 0 || durationS <= 0) return [];
  if (gapAt !== null && !ranges.some(([a, b]) => gapAt >= a && gapAt < b)) return [];
  const head = Math.min(length, PARTIAL_HEAD_BYTES);
  if (!ranges.some(([a, b]) => a === 0 && b >= head)) return [];
  const margin = Math.max(PARTIAL_MARGIN_MIN_BYTES, length * PARTIAL_MARGIN_SHARE);
  const out: Stretches = [];
  for (const [a, b] of ranges) {
    const from = a === 0 ? 0 : a + margin;
    const to = b >= length ? length : b - margin;
    if (to > from) out.push([(from / length) * durationS, (to / length) * durationS]);
  }
  return out;
}

export interface Gate {
  /** `http://127.0.0.1:<port>/<random token>`. */
  readonly url: string;
  /**
   * Closes the server and every connection; answers the first byte the reader asked for that is not on disk, or
   * null: the start of a range it refused (416), or the end of the run of bytes on disk an answer was cut short at.
   */
  close(): Promise<number | null>;
}

/**
 * A loopback reader of a file partly on disk, for one ffmpeg run. It serves byte ranges from the file itself, and only
 * inside `ranges` (pieces verified on disk). A request that starts outside them is answered 416 and recorded. An
 * answer ends at the end of the run of bytes it starts in, and that end is recorded too (a reader that needs more fails
 * the read: "partial file", with -xerror a non-zero exit). So a read that needs a missing piece ends the sheet at once
 * and the gate names the first byte asked for that is not on disk: nothing waits for, selects or fetches a piece, and
 * a hole's zeros are never read as film. A sheet ffmpeg still made (exit 0) is kept by phase 1's builder: every byte
 * it read was served from disk; the recorded byte then only holds back the next partial sheet until it arrives, which
 * a sequential download brings next. It listens on 127.0.0.1, on a free
 * port, under a random path, and is closed with the run. The bytes come from this machine's own disk, and the server
 * makes no request.
 */
export async function openGate(file: string, length: number, ranges: readonly [number, number][]): Promise<Gate> {
  const token = randomBytes(16).toString('hex');
  let missing: number | null = null;
  const server = createServer((req, res) => {
    if (req.url !== `/${token}` || req.method !== 'GET') {
      res.writeHead(404).end();
      return;
    }
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? 'bytes=0-');
    const start = m === null ? Number.NaN : Number(m[1]);
    const askedEnd = m === null || m[2] === '' || m[2] === undefined ? length - 1 : Math.min(Number(m[2]), length - 1);
    const run = Number.isSafeInteger(start) ? ranges.find(([a, b]) => start >= a && start < b) : undefined;
    if (run === undefined || start > askedEnd) {
      missing ??= Number.isSafeInteger(start) ? start : 0;
      res.writeHead(416, { 'content-range': `bytes */${length}` }).end();
      return;
    }
    const end = Math.min(askedEnd, run[1] - 1);
    res.writeHead(206, {
      'accept-ranges': 'bytes',
      'content-type': 'application/octet-stream',
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${length}`,
    });
    // Cut short at the end of the bytes on disk: the reader asked for the byte after it.
    if (end < askedEnd) missing ??= end + 1;
    const stream = createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/${token}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return missing;
    },
  };
}

interface VideoBase {
  readonly key: string;
  readonly dir: string;
  /** `<root>/<info hash>/`: phase 1's builder makes `dir` inside it and never makes it (PreviewHome). */
  readonly home: string;
  readonly durationS: number;
}

/** A torrent's video as phase 1's builder reads it: a LocalVideo that names its home. */
export type TorrentVideo = LocalVideo & PreviewHome;

/** The file whole on disk, read from its path. */
function fileVideo(base: VideoBase, file: string): TorrentVideo {
  return {
    ...base,
    coverage: async (): Promise<Stretches> => (existsSync(file) ? [[0, base.durationS]] : []),
    input: async (startS: number, endS: number) => ({ args: stretchArgs(file, startS, endS - startS) }),
  };
}

/** The remux, whole or growing: from 0 to what its playlist lists (the whole film once it is whole). */
function remuxVideo(base: VideoBase, dir: string): TorrentVideo {
  // ffmpeg's concat: protocol splits its list at `|`: a folder whose path holds one cannot be read this way.
  const readable = !dir.includes('|');
  return {
    ...base,
    async coverage(): Promise<Stretches> {
      const remux = readable ? await readRemux(dir) : null;
      if (remux === null) return [];
      if (remux.whole) return [[0, base.durationS]];
      const end = Math.min(remux.segments.at(-1)?.endS ?? 0, base.durationS);
      return end > 0 ? [[0, end]] : [];
    },
    async input(startS: number, endS: number) {
      const remux = readable ? await readRemux(dir) : null;
      const parts = (remux?.segments ?? []).filter((s) => s.endS > startS && s.startS < endS);
      const first = parts[0];
      if (first === undefined) throw new Error(`the remux in ${dir} holds nothing of ${secs(startS)}-${secs(endS)} s`);
      const input = `concat:${[INIT_NAME, ...parts.map((s) => s.name)].map((name) => path.join(dir, name)).join('|')}`;
      return { args: stretchArgs(input, startS - first.startS, endS - startS) };
    },
  };
}

/** The file partly on disk: the stretches partialCoverage offers, read through a gate over the pieces on disk. */
function partialVideo(base: VideoBase, file: Extract<FileOnDisk, { kind: 'partial' }>, gaps: Map<string, number>): TorrentVideo {
  return {
    ...base,
    async coverage(): Promise<Stretches> {
      const gap = gaps.get(base.key) ?? null;
      if (gap !== null && file.ranges.some(([a, b]) => gap >= a && gap < b)) gaps.delete(base.key);
      return partialCoverage(file.length, file.ranges, base.durationS, gaps.get(base.key) ?? null);
    },
    async input(startS: number, endS: number) {
      const gate = await openGate(file.path, file.length, file.ranges);
      return {
        args: ['-rw_timeout', GATE_RW_TIMEOUT_US, ...stretchArgs(gate.url, startS, endS - startS)],
        // This daemon's own gate on 127.0.0.1: phase 1's builder allows http for this input only, to that host only.
        loopback: true as const,
        cleanup: async () => {
          const missing = await gate.close();
          if (missing === null) return;
          gaps.set(base.key, missing);
          // "Not yet", never a failure: the sheet keeps its tries and is offered again once that byte is on disk.
          throw new PreviewNotYet(`byte ${missing} of the file is not on disk yet`);
        },
      };
    },
  };
}

/** Nothing of the video can be read now (the torrent left the swarm unfinished): only the sheets already made are listed. */
function storedVideo(base: VideoBase): TorrentVideo {
  return {
    ...base,
    coverage: async (): Promise<Stretches> => [],
    input: async () => {
      throw new Error('nothing of this video can be read from disk now');
    },
  };
}

/** This host's torrent videos as phase 1's LocalSource reads them (its `forSession` and the sweep's `whole`). */
export class TorrentVideos implements LocalVideos {
  /** By video key: the first byte a gate found missing, until that byte is on disk. In memory only: after a restart, one more try. */
  private readonly gaps = new Map<string, number>();

  constructor(
    private readonly torrents: PreviewTorrents,
    private readonly log: (line: string) => void,
  ) {}

  /** The torrent video a session plays; null for a session that is not a torrent's, or one whose length is not known. */
  async forSession(session: StreamSession): Promise<TorrentVideo | null> {
    const t = session.torrent;
    if (t === null) return null;
    return this.videoOf(t.infoHash, t.fileIndex, t.durationS);
  }

  /**
   * For phase 1's sweep: every torrent video of this host that is whole on disk (its file, or its finished remux), so
   * an episode fetched ahead has its previews before it is played. Never throws.
   */
  async whole(): Promise<TorrentVideo[]> {
    let whole: WholeVideo[];
    try {
      whole = await this.torrents.wholeVideos();
    } catch (err) {
      this.log(`[notesd] previews: could not list the torrent videos on disk: ${messageOf(err)}`);
      return [];
    }
    const out: TorrentVideo[] = [];
    for (const v of whole) {
      const base = await this.baseOf(v.infoHash, v.fileIndex, v.durationS);
      if (base === null) continue;
      out.push(v.via === 'file' ? fileVideo(base, v.path) : remuxVideo(base, this.remuxDirOf(v.infoHash, v.fileIndex)));
    }
    return out;
  }

  /** In order: the file whole on disk, else its remux (growing, or the one copy left), else the part of the file on disk. */
  private async videoOf(infoHash: string, fileIndex: number, durationS: number | null): Promise<TorrentVideo | null> {
    const base = await this.baseOf(infoHash, fileIndex, durationS);
    if (base === null) return null;
    const disk = await this.torrents.onDisk(infoHash, fileIndex);
    if (disk?.kind === 'whole') return fileVideo(base, disk.path);
    const remuxAt = this.remuxDirOf(infoHash, fileIndex);
    if ((await readRemux(remuxAt)) !== null) return remuxVideo(base, remuxAt);
    if (disk?.kind === 'partial') return partialVideo(base, disk, this.gaps);
    return storedVideo(base);
  }

  /** The video's key, folders and length: the session's (the probe's), else the probe kept beside its remux. Null: no length known. */
  private async baseOf(infoHash: string, fileIndex: number, durationS: number | null): Promise<VideoBase | null> {
    const seconds = durationS ?? (await readRemuxProbe(this.remuxDirOf(infoHash, fileIndex)))?.durationS ?? null;
    if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
    return {
      key: `torrent-${infoHash}-${fileIndex}`,
      dir: previewsDirOf(this.torrents.root, infoHash, fileIndex),
      home: path.join(this.torrents.root, infoHash),
      durationS: seconds,
    };
  }

  private remuxDirOf(infoHash: string, fileIndex: number): string {
    return remuxDir(this.torrents.root, infoHash, fileIndex);
  }
}

/**
 * The torrent videos of `torrents`, or null with torrents off. It is handed a three-member view of TorrentStreams, not
 * the object itself, so no preview path can reach `use`, `open`, `serve` or a handle.
 */
export function torrentVideos(torrents: TorrentStreams | null | undefined, log: (line: string) => void): TorrentVideos | null {
  if (torrents === null || torrents === undefined) return null;
  const view: PreviewTorrents = {
    root: torrents.root,
    onDisk: (infoHash, index) => torrents.onDisk(infoHash, index),
    wholeVideos: () => torrents.wholeVideos(),
  };
  return new TorrentVideos(view, log);
}

/** The registry's torrent source (sources.ts): phase 1's LocalSource over this host's torrent videos; null with torrents off. */
export const torrentSource: PreviewSourceFactory = (deps) => {
  const videos = torrentVideos(deps.torrents, deps.log);
  return videos === null ? null : new LocalSource('torrent', videos, deps.log);
};
```
**Impact:** this is a new file, used only by the registry. The `concat:` input and the input `-ss` offset inside the
first segment were checked by hand on ffmpeg 6.1.1. The frame matched the original's within one frame, because the
start time includes the 22 ms AAC priming. The gate was checked too: with `-xerror` (phase 1's builder always passes
it), ffmpeg exits 183 on a refused range, and without it, it exits 0 and writes nothing. Step 7's ffmpeg test makes
both checks repeatable. `sources.ts` imports `torrentSource` from here and this file imports only the
`PreviewSourceFactory` type from `sources.ts`, so the cycle is type-only (as phase 1's `cacheSource.ts` already is).

### Step 4: The registry entry
**File:** `src/directStream/previews/sources.ts` (phase 1's file, as phase 1 Step 9 writes it)
**Change:** one import after `import { cacheSource } from './cacheSource.js';`, and one line before `cacheSource,`.
Phase 1 lands first and writes the list as:
```ts
export const PREVIEW_SOURCES: readonly PreviewSourceFactory[] = [
  cacheSource,
];
```
**Code:**
```ts
import { torrentSource } from './torrentSource.js';
```
```ts
export const PREVIEW_SOURCES: readonly PreviewSourceFactory[] = [
  torrentSource,
  cacheSource,
];
```
**Impact:** the torrent source is asked before the cache. Nothing else in phase 1's files changes: `PreviewSourceDeps`
already carries `torrents` and `src/daemon.ts` already passes it. Phase 3 runs at the same time and adds
`providerSource` (with its import) to the same list, first. Whichever of the two merges second keeps both lines; the
list after both is:
```ts
export const PREVIEW_SOURCES: readonly PreviewSourceFactory[] = [
  providerSource,
  torrentSource,
  cacheSource,
];
```

### Step 5: Tests — preview files are the episode's (R2.5)
**File:** `tests/unit/directStream/torrent/previewFiles.test.ts` (new)
**Code:**
```ts
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TorrentStreams } from '../../../../src/directStream/torrent/service.js';
import { TorrentFolder } from '../../../../src/directStream/torrent/store.js';
import { PREVIEWS_DIR } from '../../../../src/directStream/torrent/usage.js';
import { FakeTorrentEngine } from '../../../helpers/fakeTorrentEngine.js';
import { MemoryTorrentRecords } from '../../../helpers/memoryTorrentRecords.js';

const HOST = 'host-a';
const PACK = 'aaaa'.padEnd(40, '1');
const FILM = 'bbbb'.padEnd(40, '2');
const KIB = 1024;
const MIB = 1024 * KIB;
const DAY = 86_400_000;
const SHOW = 'Show.S01';

let root: string;
let clock: number;

function build(records: MemoryTorrentRecords, options: { budgetBytes?: number } = {}) {
  const folder = new TorrentFolder(root);
  const streams = new TorrentStreams({
    engine: new FakeTorrentEngine(),
    repo: records,
    folder,
    host: HOST,
    uploadKbps: 100,
    keepDays: 7,
    discovery: true,
    ...(options.budgetBytes === undefined ? {} : { budgetBytes: options.budgetBytes }),
    now: () => new Date(clock),
    log: () => undefined,
    every: () => () => undefined,
  });
  return { streams, folder };
}

async function put(file: string, bytes: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.alloc(bytes, 7));
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Bytes on disk the way TorrentFolder counts them (blocks). */
async function blocks(file: string): Promise<number> {
  const s = await stat(file);
  return s.blocks > 0 ? s.blocks * 512 : s.size;
}

const sheet = (hash: string, index: number, name: string): string => path.join(root, hash, PREVIEWS_DIR, String(index), name);

/** A film: one whole video with its sheets (an index and one sheet) under notesd-previews/0/. */
async function seedFilm(records: MemoryTorrentRecords, folder: TorrentFolder, o: { videoBytes: number; sheetBytes: number; madeAt: Date }): Promise<void> {
  const slot = { infoHash: FILM, season: 0, episode: 0 };
  await records.record(HOST, { infoHash: FILM, ref: { kind: 'movie', tmdbId: 77 }, name: 'Film', release: 'Film', trackers: [] }, o.madeAt);
  await records.chosen(HOST, slot, { files: [{ index: 0, path: 'Film/Film.mp4', length: o.videoBytes }], fileIndex: 0, fileLength: o.videoBytes }, o.madeAt);
  await records.ready(HOST, slot, o.videoBytes, o.madeAt);
  await put(folder.diskPath(FILM, 'Film/Film.mp4')!, o.videoBytes);
  await put(sheet(FILM, 0, 'sheet-00000.jpg'), o.sheetBytes);
  await put(sheet(FILM, 0, 'previews.json'), KIB);
}

/** A season pack with E01 (file 0) and E02 (file 1) chosen and whole, each with its own sheets. */
async function seedPack(records: MemoryTorrentRecords, folder: TorrentFolder, madeAt: Date): Promise<void> {
  const files = [
    { index: 0, path: `${SHOW}/Show.S01E01.mkv`, length: 64 * KIB },
    { index: 1, path: `${SHOW}/Show.S01E02.mkv`, length: 32 * KIB },
  ];
  for (const [episode, video] of [
    [1, 0],
    [2, 1],
  ] as const) {
    await records.record(HOST, { infoHash: PACK, ref: { kind: 'tv', tmdbId: 500, season: 1, episode }, name: SHOW, release: SHOW, trackers: [] }, madeAt);
    const slot = { infoHash: PACK, season: 1, episode };
    await records.chosen(HOST, slot, { files: [files[video]!], fileIndex: video, fileLength: files[video]!.length }, madeAt);
    await records.ready(HOST, slot, files[video]!.length, madeAt);
    await put(folder.diskPath(PACK, files[video]!.path)!, files[video]!.length);
    await put(sheet(PACK, video, 'sheet-00000.jpg'), (24 + 8 * video) * KIB);
    await put(sheet(PACK, video, 'previews.json'), KIB);
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'torrent-previews-'));
  clock = Date.parse('2026-11-20T12:00:00Z');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('the preview sheets of a torrent download (R2.5)', () => {
  it("counts each episode's sheets in that episode's size, and a film's in the film's", async () => {
    const records = new MemoryTorrentRecords();
    const { streams, folder } = build(records);
    await seedPack(records, folder, new Date(clock - DAY));
    await seedFilm(records, folder, { videoBytes: 128 * KIB, sheetBytes: 16 * KIB, madeAt: new Date(clock - DAY) });
    const e1 = (await blocks(folder.diskPath(PACK, `${SHOW}/Show.S01E01.mkv`)!)) + (await blocks(sheet(PACK, 0, 'sheet-00000.jpg'))) + (await blocks(sheet(PACK, 0, 'previews.json')));
    const e2 = (await blocks(folder.diskPath(PACK, `${SHOW}/Show.S01E02.mkv`)!)) + (await blocks(sheet(PACK, 1, 'sheet-00000.jpg'))) + (await blocks(sheet(PACK, 1, 'previews.json')));
    const film = (await blocks(folder.diskPath(FILM, 'Film/Film.mp4')!)) + (await blocks(sheet(FILM, 0, 'sheet-00000.jpg'))) + (await blocks(sheet(FILM, 0, 'previews.json')));
    const usage = await streams.diskUsage();
    const pack = usage.torrents.find((t) => t.infoHash === PACK)!.usage;
    expect(pack.slots.get('1x1')).toBe(e1);
    expect(pack.slots.get('1x2')).toBe(e2);
    expect(pack.shared).toBe(0);
    expect(usage.torrents.find((t) => t.infoHash === FILM)!.usage.total).toBe(film);
    expect(await folder.size(FILM)).toBe(film);
  });

  it("deleting one episode takes its sheets and leaves the other episode's", async () => {
    const records = new MemoryTorrentRecords();
    const { streams, folder } = build(records);
    await seedPack(records, folder, new Date(clock - DAY));
    const e1 = (await blocks(folder.diskPath(PACK, `${SHOW}/Show.S01E01.mkv`)!)) + (await blocks(sheet(PACK, 0, 'sheet-00000.jpg'))) + (await blocks(sheet(PACK, 0, 'previews.json')));
    expect(await streams.removeSlots(PACK, [{ season: 1, episode: 1 }])).toBe(e1);
    expect(await exists(path.join(root, PACK, PREVIEWS_DIR, '0'))).toBe(false);
    expect(await exists(sheet(PACK, 1, 'sheet-00000.jpg'))).toBe(true);
    expect(await exists(sheet(PACK, 1, 'previews.json'))).toBe(true);
  });

  it('deleting the last episode, or a whole film, takes the whole folder with every sheet in it', async () => {
    const records = new MemoryTorrentRecords();
    const { streams, folder } = build(records);
    await seedPack(records, folder, new Date(clock - DAY));
    await seedFilm(records, folder, { videoBytes: 128 * KIB, sheetBytes: 16 * KIB, madeAt: new Date(clock - DAY) });
    await streams.removeSlots(PACK, [{ season: 1, episode: 1 }]);
    await streams.removeSlots(PACK, [{ season: 1, episode: 2 }]);
    expect(await exists(path.join(root, PACK))).toBe(false);
    await streams.removeSlots(FILM, [{ season: 0, episode: 0 }]);
    expect(await exists(path.join(root, FILM))).toBe(false);
  });

  it('the budget counts the sheets and clears a torrent with them', async () => {
    const records = new MemoryTorrentRecords();
    const { streams, folder } = build(records, { budgetBytes: 2 * MIB });
    // 1 MiB of film is under the 2 MiB budget; with 2 MiB of sheets it is over.
    await seedFilm(records, folder, { videoBytes: MIB, sheetBytes: 2 * MIB, madeAt: new Date(clock - DAY) });
    expect(await streams.prune()).toBe(1);
    expect(await exists(path.join(root, FILM))).toBe(false);
    expect(records.rows).toEqual([]);
  });

  it('a download cleared after keepDays goes with its sheets', async () => {
    const records = new MemoryTorrentRecords();
    const { streams, folder } = build(records);
    await seedFilm(records, folder, { videoBytes: 64 * KIB, sheetBytes: 16 * KIB, madeAt: new Date(clock - 10 * DAY) });
    expect(await streams.prune()).toBe(1);
    expect(await exists(path.join(root, FILM))).toBe(false);
  });
});
```

### Step 6: Tests — the source, the gate, no swarm touched (R1.3, R2.4)
**File:** `tests/unit/directStream/previews/torrentSource.test.ts` (new)
**Code:**
```ts
import { mkdir, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalSource } from '../../../../src/directStream/previews/local.js';
import type { PreviewSourceDeps } from '../../../../src/directStream/previews/sources.js';
import { readRemux, torrentSource, TorrentVideos, torrentVideos, type PreviewTorrents } from '../../../../src/directStream/previews/torrentSource.js';
import { PreviewNotYet, type LocalVideo, type PreviewList } from '../../../../src/directStream/previews/types.js';
import { SessionStore, type SessionTorrent, type StreamSession } from '../../../../src/directStream/sessions.js';
import { REMUX_DONE_FILE, remuxDir } from '../../../../src/directStream/torrent/remux.js';
import type { RemuxKeeper } from '../../../../src/directStream/torrent/remuxOnly.js';
import { TorrentStreams } from '../../../../src/directStream/torrent/service.js';
import { TorrentFolder } from '../../../../src/directStream/torrent/store.js';
import { TORRENT_LINGER_MS, type TorrentPick } from '../../../../src/directStream/torrent/types.js';
import type { ResolvedSource } from '../../../../src/directStream/types.js';
import { FakeTorrentEngine } from '../../../helpers/fakeTorrentEngine.js';
import { MemoryTorrentRecords } from '../../../helpers/memoryTorrentRecords.js';

const MIB = 1024 * 1024;
const BIG = 'b1'.repeat(20);
const SMALL = 'a1'.repeat(20);
const BIG_LENGTH = 40 * MIB;
const BIG_VIDEO = Buffer.alloc(BIG_LENGTH);
for (let i = 0; i < BIG_LENGTH; i += 4096) BIG_VIDEO[i] = (i / 4096) % 251;
for (let i = 0; i < 4096; i += 1) BIG_VIDEO[i] = i % 253;
const SMALL_VIDEO = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 249));
const SRT = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHello\n');
const pick = (infoHash: string, name: string): TorrentPick => ({ infoHash, trackers: [], name, ref: { kind: 'movie', tmdbId: 550 } });

let root: string;
let clock: number;

function build(remuxes: RemuxKeeper | null = null) {
  const engine = new FakeTorrentEngine([
    { infoHash: BIG, name: 'Big', files: [{ path: 'Big/Big.en.srt', data: SRT }, { path: 'Big/Big.mp4', data: BIG_VIDEO }] },
    { infoHash: SMALL, name: 'Small', files: [{ path: 'Small/Small.en.srt', data: SRT }, { path: 'Small/Small.mkv', data: SMALL_VIDEO }] },
  ]);
  const folder = new TorrentFolder(root);
  const streams = new TorrentStreams({
    engine,
    repo: new MemoryTorrentRecords(),
    folder,
    host: 'host-a',
    uploadKbps: 100,
    keepDays: 7,
    discovery: true,
    remuxes,
    now: () => new Date(clock),
    log: () => undefined,
    every: () => () => undefined,
  });
  const videos = torrentVideos(streams, () => undefined)!;
  // What phase 1's LocalSource asks of the videos, recorded: `list` answers 'none' with no video, else 'partial'
  // (the sheets themselves are phase 1's), and every video handed out lands in `seen`.
  const seen: LocalVideo[] = [];
  const source = {
    list: async (session: StreamSession): Promise<PreviewList> => {
      const video = await videos.forSession(session);
      if (video === null) return { state: 'none', source: null, cues: [] };
      seen.push(video);
      return { state: 'partial', source: 'local', cues: [] };
    },
    wholeVideos: () => videos.whole(),
  };
  return { engine, folder, streams, seen, source };
}

function sessionOf(infoHash: string, fileIndex: number, durationS: number | null, manifestKind: 'mp4' | 'hls' = 'mp4'): StreamSession {
  const manifestUrl = `/api/stream/torrent/${infoHash}/f/${fileIndex}`;
  const torrent: SessionTorrent = {
    infoHash, fileIndex, selected: [fileIndex], name: 'x', index: null, seeds: null, state: 'downloading', height: null,
    manifestUrl, manifestKind, subtitles: [], subtitleRev: 0, candidates: [], durationS, candidate: null, held: false,
    imdbId: null, query: null, stop: new AbortController(),
  };
  return new SessionStore().createTorrent({ kind: 'movie', tmdbId: 550 }, standIn(manifestUrl, manifestKind), [], null, null, torrent);
}

function standIn(manifestUrl: string, kind: 'mp4' | 'hls'): ResolvedSource {
  return { provider: 'Torrent', embed_url: '', manifest_url: manifestUrl, manifest_kind: kind, headers: { referer: null, origin: null, user_agent: null }, subtitles: [], best_height: null, en_subtitle: false, took_s: null };
}

/** The file on disk with only `runs` written (the rest a hole), at its full length, as webtorrent leaves a download in progress. */
async function sparse(file: string, data: Buffer, runs: [number, number][]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const fd = await open(file, 'w');
  await fd.truncate(data.length);
  for (const [a, b] of runs) await fd.write(data, a, b - a, a);
  await fd.close();
}

/** A remux folder: init, `count` 6 s segments, the playlist, and done.json when whole. */
async function remuxOf(infoHash: string, fileIndex: number, count: number, whole: boolean): Promise<string> {
  const dir = remuxDir(root, infoHash, fileIndex);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'init.mp4'), 'init');
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:6', '#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-MAP:URI="init.mp4"'];
  for (let i = 0; i < count; i += 1) {
    const name = `seg-${String(i).padStart(5, '0')}.m4s`;
    await writeFile(path.join(dir, name), 'seg');
    lines.push('#EXTINF:6.000000,', name);
  }
  if (whole) lines.push('#EXT-X-ENDLIST');
  await writeFile(path.join(dir, 'index.m3u8'), `${lines.join('\n')}\n`);
  if (whole) await writeFile(path.join(dir, REMUX_DONE_FILE), '{}\n');
  return dir;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'torrent-preview-source-'));
  clock = Date.parse('2026-11-20T12:00:00Z');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('the torrent preview source (R1.3)', () => {
  it("is phase 1's LocalSource named torrent, and none with torrents off", () => {
    const { streams } = build();
    const deps = { torrents: streams, log: () => undefined } as unknown as PreviewSourceDeps;
    const made = torrentSource(deps);
    expect(made).toBeInstanceOf(LocalSource);
    expect(made?.name).toBe('torrent');
    expect(torrentSource({ ...deps, torrents: null })).toBeNull();
  });

  it("has nothing for a session that is not a torrent's, or whose length is not known", async () => {
    const { source, seen } = build();
    const cloud = new SessionStore().create({ kind: 'movie', tmdbId: 550 }, standIn('https://cdn.example/a.m3u8', 'hls'), []);
    expect(await source.list(cloud)).toEqual({ state: 'none', source: null, cues: [] });
    expect(await source.list(sessionOf(SMALL, 1, null))).toEqual({ state: 'none', source: null, cues: [] });
    expect(seen).toEqual([]);
  });

  it('a file whole on disk: the whole film, read from its path, sheets in notesd-previews/<index>', async () => {
    const { streams, engine, folder, source, seen } = build();
    await streams.open(pick(SMALL, 'Small'), { timeoutMs: 1000 });
    await streams.use(SMALL, [1]);
    engine.have(SMALL, 1);
    const file = folder.diskPath(SMALL, 'Small/Small.mkv')!;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, SMALL_VIDEO);
    expect(await source.list(sessionOf(SMALL, 1, 100))).toMatchObject({ state: 'partial' });
    const video = seen[0]!;
    expect(video.key).toBe(`torrent-${SMALL}-1`);
    expect(video.dir).toBe(path.join(root, SMALL, 'notesd-previews', '1'));
    // Its home: phase 1's builder makes `dir` inside it and never makes it again after a delete.
    expect((video as LocalVideo & { home: string }).home).toBe(path.join(root, SMALL));
    expect(video.durationS).toBe(100);
    expect(await video.coverage()).toEqual([[0, 100]]);
    expect((await video.input(10, 20)).args).toEqual(['-ss', '10.000', '-t', '10.000', '-i', file]);
  });

  it('a file partly on disk: only stretches well inside the bytes on disk, and none before its header is there', async () => {
    const { streams, engine, source, seen } = build();
    await streams.open(pick(BIG, 'Big'), { timeoutMs: 1000 });
    await streams.use(BIG, [1]);
    engine.have(BIG, 1, [10 * MIB, 30 * MIB]);
    await source.list(sessionOf(BIG, 1, 1000));
    expect(await seen.at(-1)!.coverage()).toEqual([]);
    engine.have(BIG, 1, [0, 10 * MIB]);
    await source.list(sessionOf(BIG, 1, 1000));
    // [0, 30 MiB) on disk, less the 8 MiB margin at its inner edge: 22/40 of 1000 s.
    expect(await seen.at(-1)!.coverage()).toEqual([[0, 550]]);
  });

  it('the gate serves only bytes on disk; a read of a missing byte fails at once, and the file is not offered again until that byte is there (R2.4)', async () => {
    const { streams, engine, folder, source, seen } = build();
    await streams.open(pick(BIG, 'Big'), { timeoutMs: 1000 });
    await streams.use(BIG, [1]);
    engine.have(BIG, 1, [0, 20 * MIB]);
    await sparse(folder.diskPath(BIG, 'Big/Big.mp4')!, BIG_VIDEO, [[0, 20 * MIB]]);
    await source.list(sessionOf(BIG, 1, 1000));
    const video = seen.at(-1)!;
    expect(await video.coverage()).toEqual([[0, 300]]);
    const input = await video.input(0, 100);
    const url = input.args.at(-1)!;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);
    expect(input.loopback).toBe(true);
    const inside = await fetch(url, { headers: { range: 'bytes=100-4195' } });
    expect(inside.status).toBe(206);
    expect(Buffer.from(await inside.arrayBuffer()).equals(BIG_VIDEO.subarray(100, 4196))).toBe(true);
    const edge = await fetch(url, { headers: { range: `bytes=${20 * MIB - 10}-` } });
    expect(edge.headers.get('content-range')).toBe(`bytes ${20 * MIB - 10}-${20 * MIB - 1}/${BIG_LENGTH}`);
    expect((await edge.arrayBuffer()).byteLength).toBe(10);
    const t0 = Date.now();
    expect((await fetch(url, { headers: { range: `bytes=${25 * MIB}-` } })).status).toBe(416);
    expect(Date.now() - t0).toBeLessThan(1000);
    // A gate miss is "not yet" (phase 1 never counts it against the sheet's tries), naming the first byte not on disk.
    await expect(input.cleanup!()).rejects.toBeInstanceOf(PreviewNotYet);
    await source.list(sessionOf(BIG, 1, 1000));
    expect(await seen.at(-1)!.coverage()).toEqual([]);
    engine.have(BIG, 1, [20 * MIB, 30 * MIB]);
    await source.list(sessionOf(BIG, 1, 1000));
    expect(await seen.at(-1)!.coverage()).toEqual([[0, 550]]);
  });

  it('making previews never touches the swarm: no open, no use, no selection, no read, and the torrent still leaves on time (R2.4)', async () => {
    const { streams, engine, folder, source, seen } = build();
    await streams.open(pick(BIG, 'Big'), { timeoutMs: 1000 });
    await streams.use(BIG, [1]);
    engine.have(BIG, 1, [0, 20 * MIB]);
    await sparse(folder.diskPath(BIG, 'Big/Big.mp4')!, BIG_VIDEO, [[0, 20 * MIB]]);
    await streams.release(BIG); // the page closed: nothing uses it, it lingers
    const before = { added: engine.added.length, selected: engine.selected.length, deselected: engine.deselected.length, reads: engine.reads.length };
    await source.list(sessionOf(BIG, 1, 1000));
    const video = seen.at(-1)!;
    await video.coverage();
    const input = await video.input(0, 100);
    await (await fetch(input.args.at(-1)!, { headers: { range: 'bytes=0-4095' } })).arrayBuffer();
    await input.cleanup?.();
    await source.wholeVideos();
    expect({ added: engine.added.length, selected: engine.selected.length, deselected: engine.deselected.length, reads: engine.reads.length }).toEqual(before);
    expect(streams.inUse(BIG)).toBe(false);
    clock += TORRENT_LINGER_MS;
    await streams.tick();
    expect(engine.removed).toContain(BIG);
    // Out of the swarm and unfinished: the pieces on disk are not known, so nothing new is offered and nothing reopens it.
    await source.list(sessionOf(BIG, 1, 1000));
    expect(await seen.at(-1)!.coverage()).toEqual([]);
    expect(engine.added.length).toBe(before.added);
  });

  it('a film that lives as its remux gets its sheets from the remux, in the same folder, and the sheets made before stay', async () => {
    const keeper: RemuxKeeper = { playable: () => true, blocker: async () => null };
    const { streams, engine, folder, source, seen } = build(keeper);
    await streams.open(pick(SMALL, 'Small'), { timeoutMs: 1000 });
    await streams.use(SMALL, [1]);
    engine.have(SMALL, 1);
    const file = folder.diskPath(SMALL, 'Small/Small.mkv')!;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, SMALL_VIDEO);
    const dir = await remuxOf(SMALL, 1, 17, true);
    await streams.tick(); // ready
    await source.list(sessionOf(SMALL, 1, 100, 'hls'));
    const before = seen.at(-1)!;
    await mkdir(before.dir, { recursive: true });
    await writeFile(path.join(before.dir, 'sheet-00000.jpg'), 'jpeg');
    await streams.release(SMALL); // finished: leaves the swarm, and the original goes beside its whole remux
    await expect(stat(file)).rejects.toThrow();
    await source.list(sessionOf(SMALL, 1, 100, 'hls'));
    const after = seen.at(-1)!;
    expect([after.key, after.dir]).toEqual([before.key, before.dir]);
    expect((await stat(path.join(after.dir, 'sheet-00000.jpg'))).isFile()).toBe(true);
    expect(await after.coverage()).toEqual([[0, 100]]);
    expect((await after.input(13, 20)).args).toEqual(['-ss', '1.000', '-t', '7.000', '-i', `concat:${[path.join(dir, 'init.mp4'), path.join(dir, 'seg-00002.m4s'), path.join(dir, 'seg-00003.m4s')].join('|')}`]);
  });

  it("a growing remux offers what its playlist lists; a playlist naming anything else is not read", async () => {
    const dir = await remuxOf(SMALL, 1, 3, false);
    const view: PreviewTorrents = { root, onDisk: async () => null, wholeVideos: async () => [] };
    const video = await new TorrentVideos(view, () => undefined).forSession(sessionOf(SMALL, 1, 100, 'hls'));
    expect(await video!.coverage()).toEqual([[0, 18]]);
    await writeFile(path.join(dir, 'index.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6.0,\n../../../etc.m4s\n');
    expect(await readRemux(dir)).toBeNull();
  });

  it('the sweep lists whole files and whole remuxes, never a download still running', async () => {
    const keeper: RemuxKeeper = { playable: () => true, blocker: async () => null };
    const { streams, engine, folder, source } = build(keeper);
    await streams.open(pick(SMALL, 'Small'), { timeoutMs: 1000 });
    await streams.use(SMALL, [1]);
    engine.have(SMALL, 1);
    const file = folder.diskPath(SMALL, 'Small/Small.mkv')!;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, SMALL_VIDEO);
    await streams.setDuration(SMALL, 100, 1);
    await streams.tick();
    await streams.open(pick(BIG, 'Big'), { timeoutMs: 1000 });
    await streams.use(BIG, [1]);
    await streams.setDuration(BIG, 1000, 1);
    engine.have(BIG, 1, [0, 20 * MIB]);
    expect((await source.wholeVideos()).map((v) => v.key)).toEqual([`torrent-${SMALL}-1`]);
    expect(await (await source.wholeVideos())[0]!.coverage()).toEqual([[0, 100]]);
  });
});
```
**Note for the implementer:** the remux-only test uses `RemuxKeeper` with no probe, and `blocker` returns null.
`TorrentStreams.release` on a finished torrent goes through `settle` → `leave` → `dropOriginals`. If `settle` already
left on the `tick` (finished, users 1, so no), keep the order as written. Read `service.ts:881-951` if the original
is not deleted, and say in the commit why the order changed.

### Step 7: Tests with the real ffmpeg
**File:** `tests/unit/directStream/previews/torrentSource.ffmpeg.test.ts` (new)
**Code:**
```ts
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TorrentVideos, type PreviewTorrents } from '../../../../src/directStream/previews/torrentSource.js';
import { PreviewNotYet, type LocalVideo } from '../../../../src/directStream/previews/types.js';
import { SessionStore, type SessionTorrent, type StreamSession } from '../../../../src/directStream/sessions.js';
import { REMUX_DONE_FILE, remuxArgs, remuxDir } from '../../../../src/directStream/torrent/remux.js';
import type { FileOnDisk } from '../../../../src/directStream/torrent/service.js';
import type { ResolvedSource } from '../../../../src/directStream/types.js';

const FFMPEG = 'ffmpeg';
const hasFfmpeg = spawnSync(FFMPEG, ['-version']).status === 0;
const HASH = 'd'.repeat(40);

let root: string;
let film: string;

/** Runs ffmpeg without blocking the event loop (the gate answers in this process). */
function run(args: string[]): Promise<{ code: number | null; out: Buffer; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('close', (code) => resolve({ code, out: Buffer.concat(chunks), ms: Date.now() - t0 }));
  });
}

/** The grey level of the frame 0.5 s into what `input` gives: the film's second, since every second has its own level. */
async function levelOf(input: string[]): Promise<{ code: number | null; level: number | null; ms: number }> {
  const r = await run(['-nostdin', '-v', 'error', '-xerror', ...input, '-an', '-ss', '0.5', '-frames:v', '1', '-vf', 'scale=1:1,format=gray', '-f', 'rawvideo', '-']);
  return { code: r.code, level: r.out.length === 1 ? r.out[0]! : null, ms: r.ms };
}

function session(durationS: number): StreamSession {
  const manifestUrl = `/api/stream/torrent/${HASH}/f/0`;
  const torrent: SessionTorrent = {
    infoHash: HASH, fileIndex: 0, selected: [0], name: 'x', index: null, seeds: null, state: 'downloading', height: null,
    manifestUrl, manifestKind: 'mp4', subtitles: [], subtitleRev: 0, candidates: [], durationS, candidate: null, held: false,
    imdbId: null, query: null, stop: new AbortController(),
  };
  const source = { provider: 'Torrent', embed_url: '', manifest_url: manifestUrl, manifest_kind: 'mp4', headers: { referer: null, origin: null, user_agent: null }, subtitles: [], best_height: null, en_subtitle: false, took_s: null } as ResolvedSource;
  return new SessionStore().createTorrent({ kind: 'movie', tmdbId: 550 }, source, [], null, null, torrent);
}

/** The LocalVideo the source makes for `disk` (and the remux folder under root, when there is one). */
async function videoFor(disk: FileOnDisk | null): Promise<LocalVideo> {
  const view: PreviewTorrents = { root, onDisk: async () => disk, wholeVideos: async () => [] };
  const video = await new TorrentVideos(view, () => undefined).forSession(session(40));
  if (video === null) throw new Error('no video');
  return video;
}

beforeAll(async () => {
  if (!hasFfmpeg) return;
  root = await mkdtemp(path.join(os.tmpdir(), 'torrent-preview-ffmpeg-'));
  film = path.join(root, HASH, 'Film.mp4');
  await mkdir(path.dirname(film), { recursive: true });
  // 40 s, a grey level per second (20 + 20 × (second mod 10)), H.264 + AAC, the header first.
  const made = spawnSync(FFMPEG, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', "nullsrc=s=64x36:r=25:d=40,geq=lum='20+20*mod(floor(T)\\,10)':cb=128:cr=128,format=yuv420p",
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=40',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '10', '-g', '50', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', film,
  ]);
  expect(made.status).toBe(0);
});
afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe.skipIf(!hasFfmpeg)('torrent previews with the real ffmpeg', () => {
  it("the remux's stretch shows the frame the file shows at the same second", async () => {
    const dir = remuxDir(root, HASH, 0);
    await mkdir(dir, { recursive: true });
    expect(spawnSync(FFMPEG, remuxArgs({ input: film, dir, videoCodec: 'h264', audioStream: 0 })).status).toBe(0);
    await writeFile(path.join(dir, REMUX_DONE_FILE), '{}\n');
    const length = (await stat(film)).size;
    const fromFile = await videoFor({ kind: 'whole', path: film, length });
    // Remux only: the original is gone, the remux is read.
    const fromRemux = await videoFor(null);
    expect(await fromRemux.coverage()).toEqual([[0, 40]]);
    const levels: number[] = [];
    for (const startS of [7, 14, 21, 33]) {
      const want = await levelOf((await fromFile.input(startS, startS + 6)).args);
      const got = await levelOf((await fromRemux.input(startS, startS + 6)).args);
      expect([want.code, got.code]).toEqual([0, 0]);
      expect(Math.abs(got.level! - want.level!)).toBeLessThanOrEqual(4);
      levels.push(want.level!);
    }
    // Every second asked has its own level, so a stretch read from the wrong second would not match.
    for (let i = 0; i < levels.length; i += 1) for (let j = i + 1; j < levels.length; j += 1) expect(Math.abs(levels[i]! - levels[j]!)).toBeGreaterThan(10);
    await rm(dir, { recursive: true, force: true });
  });

  it('a file partly on disk reads the stretch on disk, and a stretch past it fails at once with the missing byte named', async () => {
    const length = (await stat(film)).size;
    const cut = Math.floor(length / 2);
    const partial = path.join(root, HASH, 'Partial.mp4');
    const bytes = await readFile(film);
    const fd = await open(partial, 'w');
    await fd.truncate(length);
    await fd.write(bytes, 0, cut, 0);
    await fd.close();
    const video = await videoFor({ kind: 'partial', path: partial, length, ranges: [[0, cut]] });
    const want = await levelOf((await (await videoFor({ kind: 'whole', path: film, length })).input(3, 9)).args);

    const near = await video.input(3, 9);
    const got = await levelOf(near.args);
    // ffmpeg's first, open-ended read was cut short at the bytes on disk, so cleanup may say "not yet"; phase 1's
    // builder keeps a sheet whose ffmpeg exited 0 whatever cleanup says.
    await near.cleanup!().catch((err: unknown) => expect(err).toBeInstanceOf(PreviewNotYet));
    expect(got.code).toBe(0);
    expect(Math.abs(got.level! - want.level!)).toBeLessThanOrEqual(4);

    const far = await video.input(33, 39);
    const failed = await levelOf(far.args);
    expect(failed.code).not.toBe(0);
    expect(failed.level).toBeNull();
    expect(failed.ms).toBeLessThan(10_000);
    const missing = await far.cleanup!().then(() => null, (err: unknown) => err);
    expect(missing).toBeInstanceOf(PreviewNotYet);
    expect(Number(/byte (\d+) /.exec((missing as Error).message)?.[1])).toBeGreaterThanOrEqual(cut);
    await copyFile(film, partial); // not needed further; keeps the folder tidy for afterAll
  });
});
```
**Impact:** this is new test code only. It is skipped where ffmpeg is missing, as `torrentRemux.ffmpeg.test.ts`
already is.

### Step 8: Run the gates
Run `npm run typecheck`, the three new test files, then `npm test`. Fix only what this phase's code broke.

## Principles applied

- Laziness protocol: R2.5 is one widened condition in `ownersOf`. Sizes, the budget, keepDays and whole-folder deletes
  were already recursive, so they get proving tests (Step 5) and no code. One folder per file index is shared by all
  three shapes, so the remux-only case needs no move or migration of sheets.
- Make illegal states unrepresentable: `FileOnDisk` is a `whole | partial` union (a partial file always has its
  ranges), and `WholeVideo` is `via: 'file'` with a path or `via: 'remux'` without one, never a nullable path to
  interpret.
- Encode lessons in structure: the source never gets `TorrentStreams`. `torrentVideos` hands it a three-member
  read-only view (`root`, `onDisk`, `wholeVideos`), so no preview path can call `use`/`open`/`serve` at compile time
  or at run time. R2.4 is also pinned by a fake-engine test.
- Boundary discipline: the remux playlist's names are checked once in `readRemux` (`init.mp4`, `seg-NNNNN.m4s`)
  before they become paths in a `concat:` input. The gate parses `Range` once and serves only inside the verified
  piece runs.
- Test behavior, not implementation: the tests assert what an outsider sees. These are the engine's recorded calls
  and the torrent leaving the swarm after linger, the bytes and status the gate answers, frame levels compared with
  the file's own seek, and files left on disk after a delete. They never assert private calls.
- Prove it works: Proof drives a throwaway daemon for a whole file, a partial download, a remux, remux-only and both
  deletes.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npx vitest run tests/unit/directStream/torrent/previewFiles.test.ts tests/unit/directStream/previews/torrentSource.test.ts tests/unit/directStream/previews/torrentSource.ffmpeg.test.ts && npm test`
**Proof:** a torrent session of the throwaway daemon lists frames for exactly what is on disk, in all three shapes;
the sheets sit in `notesd-previews/<index>/`, count in the Cache page's sizes and go with a delete.
- Harness: `.claude/skills/verify-notesd` (`up --torrent`, the loopback seeder, `offer-remux.sh`). Previews are on
  through `NOTESD_STREAM_PREVIEWS=on` (A10).
- Feature-map entries: `features/direct-streaming.md` "Torrents: the engine and its file route", "Torrent remux",
  "Playing from a torrent" (the "Seek previews" entry is written by phase 5).
- Shared setup for J1, J4, J5 (one run; J2 uses its own):
  `V=.claude/skills/verify-notesd/scripts/verify.sh; NOTESD_STREAM_PREVIEWS=on $V up --torrent` (note `RUN`), then
  `R=$HOME/.local/state/notesd-verify/$RUN; URL=http://127.0.0.1:$(cat $R/port); ROOT=$R/data/movies/torrents;`
  `body() { sed '1,/^< HTTP /d'; }; prev() { curl -s "$URL/api/stream/sessions/$1/previews"; }`
  `look() { $V api $RUN POST /api/stream/sessions/$1/position '{"position_s":5}' >/dev/null; prev "$1"; }`
  (`look` is a page on screen: phase 1 makes a session's sheets when its position reports say it is on screen, at
  most every 15 s, or in the sweep of whole videos 30 s after start and every 30 minutes; `prev` alone only reads.)
  - **J1** · traces R1.3 — `P=$($V api $RUN POST /api/stream/play '{"kind":"movie","tmdb_id":467905,"provider":"torrent"}' | body); SID=$(jq -r .session.session_id <<<"$P"); H=$(jq -r .session.torrent.info_hash <<<"$P"); I=$(jq -r .session.torrent.file_index <<<"$P")`; poll `curl -s $URL/api/stream/sessions/$SID | jq -r .torrent.state` every 5 s until `ready` (at most 300 s); poll `look $SID | jq -r .state` every 2 s until `ready` (at most 180 s); then `$V api $RUN GET /api/stream/sessions/$SID/previews`, `ls $ROOT/$H/notesd-previews/$I/`, `curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "$URL$(prev $SID | jq -r '.cues[0].url')"` → passes when the previews answer has `state: "ready"`, `source: "local"`, 12 cues (the 120 s film, one every 10 s) sorted by `start_s`, the last `end_s` ≥ 119, the folder holds the sheet file(s), and the first cue's url answers `200 image/jpeg`
  - **J2** · traces R1.3, R2.4 — own run: `ffmpeg -v error -y -f lavfi -i testsrc2=size=320x180:rate=25 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 1500 -c:v libx264 -preset veryfast -b:v 120k -g 50 -c:a aac -b:a 32k -metadata:s:a:0 language=eng -movflags +faststart $SCRATCH/long.mp4; TORRENT_FIXTURE_FILE=$SCRATCH/long.mp4 NOTESD_STREAM_PREVIEWS=on $V up --torrent`, setup lines as above, play as in J1. Every 5 s, read `curl -s $URL/api/stream/torrent | jq -r --arg h $H '.downloads[] | select(.info_hash==$h) | .state'`, `look $SID` and `curl -s $URL/api/stream/torrent/$H/map`. Stop at the first answer with `state: "partial"` and ≥ 1 cue while the download is still `downloading`, and save it with `$V api $RUN GET /api/stream/sessions/$SID/previews`. Then close the page with `$V api $RUN POST /api/stream/sessions/$SID/position '{"position_s":5,"closed":true}'`, keep reading `prev $SID` (no position report) every 2 s, and poll `curl -s $URL/api/stream/torrent | jq '.swarm|length'` → passes when (a) before the download is ready, the previews are `partial` with cues whose stretches all lie inside the map's `ranges` at that moment (the first sheet, `[0, 360)`, appears at about 52 % downloaded), (b) after `closed`, the swarm list is empty within 240 s while the previews route is still read every 2 s (no preview read held the torrent), and (c) `$V doctor $RUN` stays clean
  - **J3** · traces R2.4 — `npx vitest run tests/unit/directStream/previews/torrentSource.test.ts -t "never touches the swarm|the gate serves only bytes on disk" && npx vitest run tests/unit/directStream/previews/torrentSource.ffmpeg.test.ts -t "partly on disk"` → passes when the run shows 3 tests passed and 0 skipped. That means the fake engine recorded no new open, select, deselect or read, the torrent left the swarm when its linger ran out, a missing byte got 416 in under 1 s, and the real ffmpeg failed in under 10 s with a `PreviewNotYet` naming a byte at or past the cut
  - **J4** · traces R1.3 — on J1's run, after J1: `.claude/skills/verify-notesd/scripts/torrent/offer-remux.sh $RUN`, then play as in J1 (now the MKV) → `manifest_kind` is `hls`. Poll `look $SID2` until `ready`, and save `ls $ROOT/$H2/notesd-previews/$I2/ > $SCRATCH/before.txt`. Close (`position … closed:true`), then poll `curl -s -o /dev/null -w '%{http_code}' $URL/api/stream/torrent/$H2/f/$I2` until `410`. Then `rm -rf $ROOT/$H2/notesd-previews/$I2`, play again (`SID3`, a replay from disk), and poll `look $SID3` until `ready` → passes when the remux session reached `ready` with 12 cues, the original then answered 410 `remuxed`, and with the original gone and the sheets deleted the replay made them again from the remux alone (`ready`, 12 cues, the folder filled again)
  - **J5** · traces R2.5 — on J1's run, after J4: close every session (`position … closed:true` for each SID) and wait until `curl -s $URL/api/stream/torrent | jq '.swarm|length'` is 0. `B=$(curl -s $URL/api/stream/disk | jq '[.titles[] | select(.title_id=="movie-467905")][0].bytes'); D=$(( $(find $ROOT/$H $ROOT/$H2 -type f -printf '%b\n' | paste -sd+ | bc) * 512 ))`. Then the pack: `$V api $RUN POST /api/stream/play '{"kind":"tv","tmdb_id":247718,"season":1,"episode":1,"provider":"torrent"}'` and the same for episode 2, poll `look` of each session until `ready`, close both, and wait for the swarm to empty. Then `$V api $RUN POST /api/stream/disk/delete '{"title_id":"tv-247718","season":1,"episode":1}'`, `sleep 12`, `ls $ROOT/$HP/notesd-previews/`. Then `$V api $RUN POST /api/stream/disk/delete '{"title_id":"movie-467905"}'`, `sleep 12`, `ls -d $ROOT/$H $ROOT/$H2` → passes when `B` equals `D` (the title's size counts every block of both folders, sheets included), after the episode delete `notesd-previews/` holds the folder named by E02's file index and not E01's, and after the film delete both film folders are gone (`No such file or directory`)
- Neighbor check: the torrent engine and the Cache page, which share `usage.ts` and `service.ts`. Run `npx vitest run tests/unit/directStream/cacheShelf.test.ts tests/unit/directStream/torrent tests/unit/directStream/torrentRemux.test.ts tests/unit/directStream/torrentSource.test.ts`, then on a fresh `NOTESD_STREAM_PREVIEWS=on $V up --torrent` run `.claude/skills/verify-notesd/scripts/torrent/torrent.sh RUN` → it prints `torrent: PASS (...)`
- Cost: none. Nothing is billed (loopback seeder, fake index and resolver). J2 takes about 8 minutes at the run's 64 kB/s cap.
**Exit criteria:** a torrent session's previews list frames for exactly what is on disk, for the whole file, the
growing and whole remux, and the partly downloaded file. No preview path opens, uses, selects, reads through or holds
a torrent (J3, J2b). Deleting one episode or the whole download leaves no preview file, and the sheets count in the
Cache page's size until then.

## Handoffs

- Phase 5: the feature-map entry "Seek previews" with the torrent journeys above (whole file, partial download,
  remux, remux-only, delete), and the guide prose. Add `notesd-previews/<index>/` to the torrent folder list in "The
  torrent engine and its file route". "One copy on disk" should say the sheets stay valid when only the remux is
  left. Add the CLAUDE.md rule "a preview never uses, selects, reads through or holds a torrent; a partly downloaded
  file is read only through the gate over its verified pieces". Phase 5's end-to-end steps script can reuse J1/J2.
- Phase 1 (settled by the reconciler): A1 to A11 are phase 1's plan as reconciled. The home rule (A6) and the
  loopback whitelist (A5) are phase 1's code and tests; this phase only names `home` and answers `loopback: true`.
- Phase 3 runs at the same time and adds its own line to `PREVIEW_SOURCES` (Step 4 quotes the list after both).
  Neither phase edits `src/daemon.ts`.

## Risks

- A gate miss never uses up a sheet's tries: a 416 or an answer cut short at the end of the bytes on disk is
  `PreviewNotYet` from `cleanup()` (A7), and the gap book holds the file back until that byte is on disk, so it is
  not tried again in the meantime. The byte recorded after a sheet that still succeeded only delays the next partial
  sheet until that byte arrives (the next one a sequential download fetches). A partial file that ffmpeg fails on for
  another reason (bad data) uses up tries as any failure does, and gets sheets again once it is whole (read from its
  path) or after a restart.
- A gap at a far offset (e.g. a `moov` at the end that is not fetched yet) stops new partial sheets for that file until
  that byte arrives. That is safe (no wrong frame), and the sheets already made stay listed.
- `concat:` cannot read a remux folder whose path holds `|`. Such a remux offers nothing, which is safe.
- The input convention (A4) is phase 1's and this plan's alike; a double `-ss` would move every frame. Phase 1's
  builder test asserts exactly one `-ss` in a sheet's arguments, and phase 5's frame check (R1.6) is the end-to-end
  guard.

## Rollback

Remove the registry line and its import in `sources.ts` and delete `src/directStream/previews/torrentSource.ts` and its two tests.
Revert `TorrentStreams.onDisk`/`wholeVideos`/types and the `ownersOf` condition (with `previewFiles.test.ts`). The
`notesd-previews/` folders already on disk count as shared bytes until their download is deleted. They are never
read again.
