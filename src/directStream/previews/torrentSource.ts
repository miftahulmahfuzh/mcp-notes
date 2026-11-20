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
