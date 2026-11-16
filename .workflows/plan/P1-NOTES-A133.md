> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/torrent-stream-source/PLAN.md` phase 7. Source: `.workflows/plan/torrent-stream-source/phase-7.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 7: The embedded subtitle track and the growing cue feed

**Plan set:** `TORRENT_STREAM_SOURCE_PLAN.md`
**Analysis:** `.workflows/analyze/20261116-192341-T7QK_code_analyzer.md`
**Satisfies:** R3 — "making sure we have english subtitle by any means necessary"
**Criteria:** R3.4, R3.5
**Depends on:** Phase 6, Phase 4 (and through them 3, 2 and 1)
**Difficulty:** HARD
**Package:** `src/directStream/torrent/subtitles`

---

## Goal

When the torrent's video file carries an English text subtitle track (SubRip, ASS/SSA, mov_text,
WebVTT) and phase 6's files tier found no subtitle file, the daemon extracts that track with ffmpeg
while the file downloads, into a growing cue feed kept on disk beside the torrent, and the player
page shows the cues as they arrive. It reads the feed again every few seconds until the feed is
complete. Picture tracks (PGS, VobSub, DVB) are never used: the tier answers nothing and the chain
goes on to phase 6's service tier. The feed is generic, so phase 8's Whisper appends to it.

## Interface Contract

**Deletes:** nothing.

**Renames:** nothing.

**Creates:**
- `src/directStream/torrent/subtitles/feed.ts`: `FeedCue` `{start_s, end_s, text}`, `CueRead` `{cues, next, complete}`, `CueFeed` (`append(cues)`, `complete()`, `read(after)`, `size`, `isComplete`, `infoHash`, `track`), `CueFeeds` (`get(infoHash, track)`, `start(infoHash, track)`), `cueFeedUrl(infoHash, track)`, `cleanCue`, `parseFeedFile`, `CUES_PER_READ`, `INFO_HASH_PATTERN`, `TRACK_ID_PATTERN`, `CUES_DIR` (`notesd-cues`).
- `src/directStream/torrent/subtitles/embedded.ts`: `TEXT_SUBTITLE_CODECS`, `EmbeddedTrackInfo`, `chooseEmbeddedTrack`, `trackLabel`, `embeddedTrackId` (`embedded-<file index>-<stream index>`), `parseVttBlock`, `VttCueReader`, `extractArgs`, `ExtractorProcess`, `SpawnExtractor`, `spawnExtractor`, `EmbeddedSubtitles` (`feedOf(infoHash, fileIndex, track)`), `embeddedTier(subtitles, log?) → SubtitleTier`, `EmbeddedTierContext`, `EXTRACT_STALL_S`.
- `src/http/streamTorrentCuesApi.ts`: `streamTorrentCuesRoutes(deps)`, route `GET /api/stream/torrent/:hash/cues/:track?after=<n>` → `{cues, next, complete}`.
- `AppDeps.torrentCues?: CueFeeds | null` (`src/deps.ts`).
- `CacheSubtitleView.growing?: true` (`src/directStream/cachePlay.ts`), `SessionSubtitle.growing?: true` (`src/directStream/service.ts`, the server's), the module function `localSubtitle(view)` in `service.ts`.
- Web: `SessionSubtitle.growing?: true` (`web/src/stream/session.ts`); in `web/src/stream/subtitles.ts`: `FeedCue`, `CueFeedPage`, `CUE_FEED_POLL_MS`, `parseCueFeed`, `followCueFeed`, `CueFeedFollower`, `addFeedCue`.
- Verify harness: `.claude/skills/verify-notesd/scripts/stream/make-torrent-sub-fixtures.sh`, `.claude/skills/verify-notesd/scripts/stream/embedded-subtitle.steps.mjs`.

**Signature changes:** none to existing functions. `StreamController.loadFileSubtitles` (private) gains a growing branch; the private `FileTrack` gains `follower`.

**Requires (from earlier phases):**
- Phase 1: `TorrentStreams` built in `src/daemon.ts` (named `torrents` below) with `filePath(infoHash, index)` (absolute path once complete, else null; sync or async both work) and `localUrl(infoHash, index)` (`/api/stream/torrent/<hash>/f/<index>`); the route answers byte ranges of a file that is still downloading and blocks until the pieces arrive. `config.torrent.dir` (`NOTESD_TORRENT_DIR`); one torrent's folder is `path.join(config.torrent.dir, infoHash)`, and clearing a download removes that whole folder (the cue feeds go with it).
- Phase 1: `verify.sh up --torrent` seeds a fixture torrent on loopback, and takes `TORRENT_FIXTURE_FILE=<path>` to seed that file instead of the generated film (a one-file torrent: its file index is 0). Phase 3: `POST /api/stream/play` takes `provider: "torrent"`.
- Phase 3 (reconciled): `src/directStream/torrent/subtitles/chain.ts` exports `SubtitleTier` (`{ name, blocks, skip?, find(ctx) → Promise<CacheSubtitleView[]> }`), `SubtitleContext` (this phase reads `infoHash`, `fileIndex`, `probe`; `probe` is always there, the chain runs only after a probe), `SubtitleTierDeps` and `buildSubtitleTiers` with a `// Phase 7: embedded.` comment. The chain stops at the first non-empty answer; this tier answers only an English track, so `[]` lets the chain go on. It is a growing tier (`blocks: false`), not counted in the chain's 40 s budget.
- Phase 3: `MediaProbe.subtitles[]` carries `index` (ffprobe's stream index), `codec`, `lang`, `text`, `title` (ffprobe `tags.title`), `forced` and `hearingImpaired` (its dispositions).
- Phase 3: `sessionInfo()`'s torrent branch maps `session.torrent.subtitles` with `localSubtitle` (Step 6), so `growing` reaches the page; `config.torrent.ffmpegBin` (`NOTESD_FFMPEG_BIN`) is phase 3's.
- Phase 3's harness: the fake index of `--torrent` runs answers the seeded film for any title of the fake TMDB (this phase plays 467905).
- Phase 4: `web/src/stream/session.ts` and `controller.ts` as phase 4 leaves them (this phase depends on phase 4).
- Phase 6: the tier list in `buildSubtitleTiers` is `kept, files, // Phase 7: embedded., service, borrow`.

**Leaves alone (owned by others):** `web/src/stream/hlsEngine.ts`, `nativeEngine.ts`, `StreamApp.tsx` (phases 4, 5); `remux.ts` (phase 5); `subtitles/{files,service,borrow}.ts`, the `/sub/` route (phase 6); `subtitles/whisper.ts` (phase 8, which appends to `CueFeeds`); `src/http/streamTorrentApi.ts` and the engine (phase 1); `source.ts`, `probe.ts`, `chain.ts` (phase 3).

**Shared files this phase edits that another phase owns** (the reconciler merges these):
- `web/src/stream/session.ts` (phase 4): one interface field, one changed line in `parseSession` (Step 9).
- `web/src/stream/controller.ts` (phase 4): imports, `FileTrack`, `loadFileSubtitles`, a new `followGrowing`, `clearFileTracks` (Step 10).
- `src/daemon.ts` (phases 1, 3, 6): building `CueFeeds` and `EmbeddedSubtitles`, the tier insertion, `deps.torrentCues` (Step 8).
- `src/directStream/service.ts` (phase 3): `SessionSubtitle.growing`, `localSubtitle`, the cache branch of `sessionInfo` (Step 6).
- `scripts/docs/httpRoutes.ts`: a new row, one sentence added to `GET /api/stream/sessions/:id` (phase 3 edits that row too) (Step 12).

## Files

| File | Action | What changes |
|---|---|---|
| `src/directStream/torrent/subtitles/feed.ts` | create | the growing cue feed, on disk as JSONL |
| `src/directStream/torrent/subtitles/embedded.ts` | create | track choice, the ffmpeg extraction, the WebVTT reader, the tier |
| `src/directStream/cachePlay.ts:13` | modify | `CacheSubtitleView.growing?: true` |
| `src/directStream/service.ts:80` and phase 3's `sessionInfo` | modify | `SessionSubtitle.growing?: true`, `localSubtitle`, used in `sessionInfo`'s local branch |
| `src/http/streamTorrentCuesApi.ts` | create | `GET /api/stream/torrent/:hash/cues/:track` |
| `src/http/app.ts:33`, `:149` | modify | import and mount `streamTorrentCuesRoutes` |
| `src/deps.ts:68` | modify | `torrentCues?: CueFeeds \| null` |
| `src/directStream/torrent/subtitles/chain.ts` (phase 3's, with phase 6's tiers) | modify | `SubtitleTierDeps.embedded`; `embedded` at the `// Phase 7` comment |
| `src/daemon.ts` (after phase 1's `torrents`; phase 3's `buildSubtitleTiers({...})`; the `deps` literal) | modify | build feeds and extraction, `embedded` in the tier deps, `deps.torrentCues` |
| `web/src/stream/subtitles.ts:56` | modify | feed parsing, the follower, `addFeedCue` |
| `web/src/stream/session.ts:6`, `:116` | modify | `growing` field and its parsing |
| `web/src/stream/controller.ts:31`, `:170`, `:585`, `:864` | modify | the growing branch, the follower's life |
| `tests/unit/directStream/torrent/subtitles/feed.test.ts` | create | feed behaviour and its disk copy |
| `tests/unit/directStream/torrent/subtitles/embedded.test.ts` | create | track choice, reader, extraction with a fake ffmpeg, the tier |
| `tests/unit/directStream/torrent/subtitles/embedded.ffmpeg.test.ts` | create | real ffmpeg on a generated MKV over a throttled HTTP server |
| `tests/unit/directStream/torrent/cuesRoute.test.ts` | create | the route |
| `web/src/stream/subtitles.test.tsx` | modify | `parseCueFeed`, `followCueFeed` |
| `web/src/stream/controller.test.tsx` | modify | a growing track in the controller |
| `scripts/docs/httpRoutes.ts` | modify | the cues route row; `growing` in the session row |
| `docs/guide/reference/http-api.md` | regenerate | `npm run docs:gen` |
| `docs/guide/streaming.md` | modify | `#### The subtitle track inside the file` under `### Torrents`; code table rows |
| `.claude/skills/verify-notesd/features/direct-streaming.md` | modify | what proves the embedded track |
| `.claude/skills/verify-notesd/scripts/stream/make-torrent-sub-fixtures.sh` | create | the two fixture films |
| `.claude/skills/verify-notesd/scripts/stream/embedded-subtitle.steps.mjs` | create | the page journey |

## What was checked against the installed ffmpeg 6.1.1

Run in `/tmp/claude-1000/-home-miftah-mcp-notes/1d47aea4-2db1-4561-92cf-f680a6f26fd5/scratchpad/p7/` while planning:

- A 60 s MKV (`testsrc` H.264, `sine` AAC, an English SubRip track with a cue every 3 s, an ASS
  track, an SDH SubRip track) served by a Python range server throttled to 200 kB/s (8 s for the
  file). `ffmpeg -v error -i http://127.0.0.1:<port>/film.mkv -map 0:2 -c:s webvtt -flush_packets 1 -f webvtt pipe:1`
  printed the cues **progressively**: the first at 0.2 s, one every 0.4 s, the last at 8.1 s,
  from **one** request (`Range: bytes=0-`, no seek to the end of an MKV). The same without
  `-flush_packets 1` was just as progressive (the WebVTT muxer writes a cue per packet); the flag
  stays as a guard.
- **Times:** without `-copyts` every cue came out 23 ms late (`00:01.023`), because ffmpeg moves the
  output by the file's start, `-0.023` from the AAC priming (`ffprobe` `format.start_time=-0.023`).
  With `-copyts` the cues carry the file's own times (`00:01.000`). The extraction uses `-copyts`.
- **ASS:** `{\an8}{\i1}Styled{\i0} line\Nsecond row` came out as `<i>Styled</i> line` / `second row`:
  ffmpeg drops the override codes and keeps the italics as a WebVTT tag. Nothing more to strip.
  SubRip `<i>Line 1</i> & more` comes out as `<i>Line 1</i> & more`.
- **mov_text** in an MP4 whose index is at the end: ffmpeg asked for `bytes=0-`, then the end
  (`bytes=1630449-`), then read on, and gave all 20 cues. A torrent's file route serves the end
  first, as it does for the player. With `-reconnect 1 -reconnect_delay_max 30 -rw_timeout 300000000`
  the counts were the same (20) for MP4 and MKV.
- **Pictures:** `-c:s webvtt` on a PGS track fails at once: `Subtitle encoding currently only
  possible from text to text or bitmap to bitmap`. The tier never asks for one.
- **Fixtures:** a PGS `.sup` written by hand (display sets with a 100x20 bitmap, see
  `make-torrent-sub-fixtures.sh`) muxes into MKV as `hdmv_pgs_subtitle`; MP4 refuses PGS, but
  `-fix_sub_duration -i pic.sup ... -c:s dvdsub` gives an MP4 with a `dvd_subtitle` (VobSub) track,
  packets 6 s apart. An MP4 with H.264, AAC and a mov_text or VobSub track plays in Chrome as it is,
  so the journeys do not need phase 5's remux. The script was run as written and produced
  `sub-text.mp4` (`mov_text`, `eng`; first cue `00:01.000 --> 00:03.000 Line 1`) and
  `sub-picture.mp4` (`dvd_subtitle`, `eng`).

What this means for the feature, and the guide says so: the subtitle packets are spread through the
whole file, so ffmpeg can only give the cues as far as the torrent has downloaded. The extraction
follows the download from the start of the file. A seek past what is extracted shows no line until
the extraction gets there. A file already complete on disk is read from its path at full speed
(seconds).

## Implementation Steps

### Step 1: The growing cue feed
**File:** `src/directStream/torrent/subtitles/feed.ts` (new)
**Change:** An append-only store of cues per torrent and track. Memory first, so a read straight
after an append sees it, and a JSONL file in the torrent folder so a replay has it. Cues are
cleaned once here, where every producer enters (ffmpeg now, Whisper in phase 8).
**Code:**
```ts
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * A growing subtitle: the cues of one track of one torrent, appended as they are made (the English
 * text track inside the file, extracted by ffmpeg as the file downloads; phase 8's Whisper), and read
 * by the player page from an index on until the feed says it is complete. Kept on disk beside the
 * torrent's files (`<torrent folder>/notesd-cues/<track>.jsonl`: one cue per line, then
 * `{"complete":true}`), so a replay from disk has its subtitle at once. A feed belongs to the
 * machine that holds the torrent, like the torrent itself.
 */

/** One cue. `text` is WebVTT cue text: it may hold `<i>` and the like (the page takes tags out when it draws). */
export interface FeedCue {
  start_s: number;
  end_s: number;
  text: string;
}

/** One read: the cues after an index, the index to read from next, and whether the feed will grow again. */
export interface CueRead {
  cues: FeedCue[];
  next: number;
  complete: boolean;
}

/** Cues one read answers at most; a film has one to two thousand. */
export const CUES_PER_READ = 2_000;
/** A torrent's info hash as the engine names it: 40 lower-case hex characters. */
export const INFO_HASH_PATTERN = /^[0-9a-f]{40}$/;
/**
 * A feed's track name, with the chosen file's index in it, because the episodes of a season pack share one info hash:
 * `embedded-<file index>-<stream index>` (phase 7), `whisper-<file index>` (phase 8).
 */
export const TRACK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Phase 8's feed of one file of a torrent. */
export const whisperTrackId = (fileIndex: number): string => `whisper-${fileIndex}`;
/** The folder of a torrent's cue feeds, inside its torrent folder. */
export const CUES_DIR = 'notesd-cues';

/** Where the page reads a feed: GET /api/stream/torrent/:hash/cues/:track. */
export function cueFeedUrl(infoHash: string, track: string): string {
  return `/api/stream/torrent/${infoHash}/cues/${track}`;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A cue worth keeping, its times to the millisecond and its line ends LF; null for one with no text or no length. */
export function cleanCue(cue: FeedCue): FeedCue | null {
  const text = cue.text.replace(/\r\n?/g, '\n').trim();
  if (text === '' || !Number.isFinite(cue.start_s) || !Number.isFinite(cue.end_s)) return null;
  const start = round3(Math.max(0, cue.start_s));
  const end = round3(cue.end_s);
  return end > start ? { start_s: start, end_s: end, text } : null;
}

/** A feed file's cues and whether it was complete. A line that is not JSON (a crash mid-write) is left out. */
export function parseFeedFile(text: string): { cues: FeedCue[]; complete: boolean } {
  const cues: FeedCue[] = [];
  let complete = false;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value !== 'object' || value === null) continue;
    const o = value as Record<string, unknown>;
    if (o.complete === true) {
      complete = true;
      continue;
    }
    if (typeof o.start_s === 'number' && typeof o.end_s === 'number' && typeof o.text === 'string') {
      const cue = cleanCue({ start_s: o.start_s, end_s: o.end_s, text: o.text });
      if (cue !== null) cues.push(cue);
    }
  }
  return { cues, complete };
}

export class CueFeed {
  private readonly cues: FeedCue[];
  private done: boolean;
  /** Disk writes, one after another, so the file's order is the feed's. */
  private writing: Promise<void> = Promise.resolve();

  constructor(
    readonly infoHash: string,
    readonly track: string,
    private readonly file: string,
    cues: FeedCue[],
    complete: boolean,
    private readonly log: (line: string) => void,
  ) {
    this.cues = cues;
    this.done = complete;
  }

  get size(): number {
    return this.cues.length;
  }

  get isComplete(): boolean {
    return this.done;
  }

  /**
   * Adds cues after the ones already there, in any time order (phase 8 appends the stretch on screen first): reads go
   * by count, and the page adds every cue to a TextTrack, which keeps them in time order itself, so nobody sorts.
   * A read sees them at once; the disk copy follows. A complete feed takes nothing more.
   */
  append(cues: readonly FeedCue[]): Promise<void> {
    if (this.done) return this.writing;
    const kept = cues.map(cleanCue).filter((c): c is FeedCue => c !== null);
    if (kept.length === 0) return this.writing;
    this.cues.push(...kept);
    return this.write(`${kept.map((c) => JSON.stringify(c)).join('\n')}\n`);
  }

  /** The feed will not grow again: the page stops reading it, and a replay uses it as it is. */
  complete(): Promise<void> {
    if (this.done) return this.writing;
    this.done = true;
    return this.write('{"complete":true}\n');
  }

  /** The cues after the first `after`, at most CUES_PER_READ. `next` never goes back, even when `after` is past the end. */
  read(after: number): CueRead {
    const from = Math.min(Math.max(0, after), this.cues.length);
    const cues = this.cues.slice(from, from + CUES_PER_READ);
    return { cues, next: Math.max(after, from + cues.length), complete: this.done && from + cues.length >= this.cues.length };
  }

  private write(text: string): Promise<void> {
    this.writing = this.writing.then(() =>
      appendFile(this.file, text).catch((err: unknown) => {
        this.log(`[notesd] torrent: the cue feed ${this.track} of ${this.infoHash.slice(0, 8)} could not be written: ${messageOf(err)}`);
      }),
    );
    return this.writing;
  }
}

export interface CueFeedsOptions {
  /** A torrent's folder (phase 1's layout: `<NOTESD_TORRENT_DIR>/<info hash>`). */
  folderOf: (infoHash: string) => string;
  log?: (line: string) => void;
}

/** This machine's cue feeds. Names come from the route (checked there) or from the code that makes feeds. */
export class CueFeeds {
  private readonly feeds = new Map<string, CueFeed>();
  private readonly log: (line: string) => void;

  constructor(private readonly opts: CueFeedsOptions) {
    this.log = opts.log ?? ((line: string) => console.log(line));
  }

  private fileOf(infoHash: string, track: string): string {
    return path.join(this.opts.folderOf(infoHash), CUES_DIR, `${track}.jsonl`);
  }

  /** The feed of a torrent's track: in memory, else read from disk; null when this machine has none. */
  async get(infoHash: string, track: string): Promise<CueFeed | null> {
    const key = `${infoHash}|${track}`;
    const open = this.feeds.get(key);
    if (open !== undefined) return open;
    let text: string;
    try {
      text = await readFile(this.fileOf(infoHash, track), 'utf8');
    } catch {
      return null;
    }
    // A start() while the file was read wins: it is the newer feed.
    const started = this.feeds.get(key);
    if (started !== undefined) return started;
    const { cues, complete } = parseFeedFile(text);
    const feed = new CueFeed(infoHash, track, this.fileOf(infoHash, track), cues, complete, this.log);
    this.feeds.set(key, feed);
    return feed;
  }

  /** A new, empty feed for a track, in place of any earlier one (an extraction that did not finish starts over). */
  async start(infoHash: string, track: string): Promise<CueFeed> {
    const file = this.fileOf(infoHash, track);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '');
    const feed = new CueFeed(infoHash, track, file, [], false, this.log);
    this.feeds.set(`${infoHash}|${track}`, feed);
    return feed;
  }
}
```
**Impact:** new module, no caller yet. Phase 8 calls `CueFeeds.get` / `CueFeeds.start(infoHash, whisperTrackId(fileIndex))`, then `append` (out of time order is fine) and `complete`.

### Step 2: The embedded track: choice, extraction, tier
**File:** `src/directStream/torrent/subtitles/embedded.ts` (new)
**Change:** Choose the English text track from the probe, run ffmpeg on the file (its path when
complete, else the local file route), read WebVTT from stdout as it comes, append each finished cue
to the feed, mark it complete when ffmpeg ends cleanly. One extraction per torrent and track at a
time. A complete feed from an earlier play is reused without ffmpeg. The tier answers the feed as a
growing English view, or `[]` (picture tracks only, no English text track, ffmpeg would not start),
so the chain goes on.
**Code:**
```ts
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { CacheSubtitleView } from '../../cachePlay.js';
import type { SubtitleTier } from './chain.js';
import { cueFeedUrl, type CueFeed, type CueFeeds, type FeedCue } from './feed.js';

/**
 * The English subtitle track inside a torrent's video file (R3.4, R3.5). Subtitle packets are spread
 * through the whole file, so ffmpeg can give the cues only as far as the torrent has downloaded: the
 * extraction reads the file from its start, following the download, and each cue goes into a growing
 * feed the player page reads again until it is complete. A file complete on disk is read from its
 * path, at full speed. Only text tracks are used; a picture track (PGS, VobSub, DVB) is never
 * turned into text, and the chain goes on to the next tier.
 */

/** Subtitle codecs (ffprobe's names) ffmpeg turns into WebVTT. Every other one is never used: hdmv_pgs_subtitle, dvd_subtitle, dvb_subtitle and xsub are pictures. */
export const TEXT_SUBTITLE_CODECS: ReadonlySet<string> = new Set(['subrip', 'srt', 'webvtt', 'mov_text', 'text', 'ass', 'ssa']);
/** Among English tracks: plain SubRip first, ASS (often signs and songs) last. */
const CODEC_RANK: Readonly<Record<string, number>> = { subrip: 0, srt: 0, webvtt: 1, mov_text: 2, text: 3, ass: 4, ssa: 4 };

/** No byte from the file route for this long ends the extraction (a torrent released or stuck); the next play starts it again. */
export const EXTRACT_STALL_S = 300;
const STDERR_KEEP = 2_000;

/** A subtitle stream as phase 3's probe reads it. The last three are optional: without them SDH and forced tracks are told apart by their titles. */
export interface EmbeddedTrackInfo {
  /** ffprobe's stream index: what `-map 0:<index>` names. */
  index: number;
  codec: string;
  lang: string | null;
  title?: string | null;
  forced?: boolean;
  hearingImpaired?: boolean;
}

const ENGLISH = /^(en|eng)(?:[-_].*)?$/i;
const isEnglishTrack = (t: EmbeddedTrackInfo): boolean => (t.lang !== null && ENGLISH.test(t.lang.trim())) || /\benglish\b/i.test(t.title ?? '');
const isForced = (t: EmbeddedTrackInfo): boolean => t.forced === true || /\bforced\b/i.test(t.title ?? '');
const isSdh = (t: EmbeddedTrackInfo): boolean => t.hearingImpaired === true || /\b(sdh|cc|hearing)\b/i.test(t.title ?? '');

/**
 * The English text track to show: a full one before an SDH one, SubRip before ASS, then the first in
 * the file. A forced track (only the lines in another language) is taken only when it is the one
 * English text track. Picture tracks and tracks in other languages are never chosen.
 */
export function chooseEmbeddedTrack(tracks: readonly EmbeddedTrackInfo[]): EmbeddedTrackInfo | null {
  const english = tracks.filter((t) => TEXT_SUBTITLE_CODECS.has(t.codec.toLowerCase()) && isEnglishTrack(t));
  const full = english.filter((t) => !isForced(t));
  if (full.length === 0) return english.length === 1 ? (english[0] ?? null) : null;
  const rank = (t: EmbeddedTrackInfo): [number, number, number] => [isSdh(t) ? 1 : 0, CODEC_RANK[t.codec.toLowerCase()] ?? 9, t.index];
  const sorted = [...full].sort((a, b) => {
    const [a0, a1, a2] = rank(a);
    const [b0, b1, b2] = rank(b);
    return a0 - b0 || a1 - b1 || a2 - b2;
  });
  return sorted[0] ?? null;
}

const GENERIC_TITLE = /^(subtitles?|english|eng|en|und|default|track ?\d*)?$/i;

/** The menu's name for the track: its own title when it says something ("English SDH"), else "English". */
export function trackLabel(track: EmbeddedTrackInfo): string {
  const title = (track.title ?? '').trim();
  return title !== '' && !GENERIC_TITLE.test(title) ? title : 'English';
}

/** The feed name of a subtitle stream of one file of a torrent (a pack's episodes share the info hash). */
export const embeddedTrackId = (fileIndex: number, streamIndex: number): string => `embedded-${fileIndex}-${streamIndex}`;

const VTT_TIMING = /^(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{3})\s+-->\s+(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{3})/;
const secondsOf = (h: string | undefined, m: string | undefined, s: string | undefined, ms: string | undefined): number =>
  Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0) + Number(ms ?? 0) / 1000;

/** One WebVTT block as a cue; null for the header, a NOTE, or a block without text. */
export function parseVttBlock(block: string): FeedCue | null {
  const lines = block.split('\n');
  const at = lines.findIndex((line) => line.includes('-->'));
  if (at === -1) return null;
  const m = VTT_TIMING.exec((lines[at] ?? '').trim());
  if (m === null) return null;
  const text = lines.slice(at + 1).join('\n').trim();
  if (text === '') return null;
  return { start_s: secondsOf(m[1], m[2], m[3], m[4]), end_s: secondsOf(m[5], m[6], m[7], m[8]), text };
}

/** ffmpeg's WebVTT on stdout, read as it comes: a cue is given once its block has ended (a blank line). */
export class VttCueReader {
  private rest = '';

  push(chunk: string): FeedCue[] {
    this.rest = (this.rest + chunk).replace(/\r/g, '');
    const blocks = this.rest.split(/\n{2,}/);
    this.rest = blocks.pop() ?? '';
    return blocks.map(parseVttBlock).filter((c): c is FeedCue => c !== null);
  }

  /** What is left when ffmpeg is done: the last block, when it had no blank line after it. */
  end(): FeedCue[] {
    const last = parseVttBlock(this.rest.trim());
    this.rest = '';
    return last === null ? [] : [last];
  }
}

/**
 * ffmpeg's arguments: one subtitle stream of `input` to WebVTT on stdout. `-copyts` keeps the file's
 * own times (without it every cue moves by the file's start, -0.023 s for an AAC track). Over HTTP a
 * response that ends early is asked again where it stopped, and a route that sends nothing for
 * `stallS` ends the run.
 */
export function extractArgs(input: string, streamIndex: number, stallS: number = EXTRACT_STALL_S): string[] {
  const overHttp = /^https?:\/\//.test(input);
  return [
    '-v', 'error', '-nostdin', '-copyts',
    ...(overHttp ? ['-reconnect', '1', '-reconnect_delay_max', '30', '-rw_timeout', String(stallS * 1_000_000)] : []),
    '-i', input,
    '-map', `0:${streamIndex}`,
    '-c:s', 'webvtt', '-flush_packets', '1', '-f', 'webvtt', 'pipe:1',
  ];
}

/** The part of a child process the extraction uses. Production: spawnExtractor. Tests: an EventEmitter with two PassThroughs. */
export interface ExtractorProcess {
  readonly stdout: Readable;
  readonly stderr: Readable;
  on(event: 'spawn', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnExtractor = (bin: string, args: string[]) => ExtractorProcess;

export const spawnExtractor: SpawnExtractor = (bin, args) => spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

export interface EmbeddedSubtitlesOptions {
  /** `config.torrent.ffmpegBin`. */
  ffmpegBin: string;
  feeds: CueFeeds;
  /** What ffmpeg reads: the file's path once it is complete on disk, else its absolute file route on this daemon. */
  input: (infoHash: string, fileIndex: number) => Promise<string>;
  spawn?: SpawnExtractor;
  stallS?: number;
  log?: (line: string) => void;
}

export class EmbeddedSubtitles {
  /** The extraction of each torrent and track that is running, by `<hash>|<track>`. */
  private readonly running = new Map<string, Promise<CueFeed | null>>();
  readonly log: (line: string) => void;

  constructor(private readonly opts: EmbeddedSubtitlesOptions) {
    this.log = opts.log ?? ((line: string) => console.log(line));
  }

  /**
   * The feed of one subtitle stream of a torrent's file: a complete one kept from an earlier play,
   * the one an extraction is still filling, or a new extraction. Answers once ffmpeg has started
   * (not when it is done); null when it could not start.
   */
  feedOf(infoHash: string, fileIndex: number, track: EmbeddedTrackInfo): Promise<CueFeed | null> {
    const trackId = embeddedTrackId(fileIndex, track.index);
    const key = `${infoHash}|${trackId}`;
    const running = this.running.get(key);
    if (running !== undefined) return running;
    const started = this.begin(infoHash, fileIndex, track.index, trackId, () => this.running.delete(key));
    this.running.set(key, started);
    return started;
  }

  private async begin(infoHash: string, fileIndex: number, streamIndex: number, trackId: string, over: () => void): Promise<CueFeed | null> {
    const what = `the subtitle track ${streamIndex} of ${infoHash.slice(0, 8)}`;
    let feed: CueFeed;
    let input: string;
    try {
      const kept = await this.opts.feeds.get(infoHash, trackId);
      if (kept !== null && kept.isComplete) {
        over();
        return kept;
      }
      input = await this.opts.input(infoHash, fileIndex);
      feed = await this.opts.feeds.start(infoHash, trackId);
    } catch (err) {
      over();
      this.log(`[notesd] torrent: ${what} could not be extracted: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    let child: ExtractorProcess;
    try {
      child = (this.opts.spawn ?? spawnExtractor)(this.opts.ffmpegBin, extractArgs(input, streamIndex, this.opts.stallS));
    } catch (err) {
      over();
      this.log(`[notesd] torrent: ffmpeg did not start for ${what}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    const reader = new VttCueReader();
    let stderr = '';
    let ended = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      void feed.append(reader.push(chunk));
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_KEEP);
    });
    const finish = (clean: boolean, why: string): void => {
      if (ended) return;
      ended = true;
      over();
      void feed.append(reader.end());
      if (clean) {
        void feed.complete();
        this.log(`[notesd] torrent: ${what} extracted, ${feed.size} cues`);
      } else {
        this.log(`[notesd] torrent: ${what} stopped after ${feed.size} cues (${why}); the next play starts it again`);
      }
    };
    return new Promise<CueFeed | null>((resolve) => {
      child.on('spawn', () => resolve(feed));
      child.on('error', (err) => {
        finish(false, err.message);
        resolve(null);
      });
      child.on('close', (code, signal) => {
        const last = stderr.trim().split('\n').pop() ?? '';
        finish(code === 0, code === null ? `signal ${signal ?? 'unknown'}` : `exit ${code}${last === '' ? '' : `: ${last}`}`);
        resolve(feed);
      });
    });
  }
}

/** What the embedded tier reads from phase 3's SubtitleContext. */
export type EmbeddedTierContext = Pick<SubtitleContext, 'infoHash' | 'fileIndex' | 'probe'>;

/**
 * The chain's `embedded` tier, after phase 6's files tier and before its service tier: the English
 * text track of the file as a growing subtitle, or nothing, and the chain goes on. A growing tier
 * (`blocks: false`): it answers once ffmpeg has started and is not counted in the chain's budget. It
 * does not read `ctx.signal`: an extraction ends by itself at the end of the file, when the file route
 * answers 409 `not_in_swarm` (the torrent left the swarm; it never rejoins), or after the 300 s stall.
 */
export function embeddedTier(subtitles: EmbeddedSubtitles): SubtitleTier {
  return {
    name: 'embedded',
    blocks: false,
    async find(ctx: EmbeddedTierContext): Promise<CacheSubtitleView[]> {
      const tracks = ctx.probe.subtitles;
      const track = chooseEmbeddedTrack(tracks);
      if (track === null) {
        const seen = tracks.map((t) => `${t.codec}/${t.lang ?? 'und'}`).join(', ') || 'none';
        subtitles.log(`[notesd] torrent: no English text subtitle track in ${ctx.infoHash.slice(0, 8)} (${seen}); the next subtitle tier is asked`);
        return [];
      }
      const feed = await subtitles.feedOf(ctx.infoHash, ctx.fileIndex, track);
      if (feed === null) return [];
      return [{ url: cueFeedUrl(ctx.infoHash, feed.track), lang: 'en', label: trackLabel(track), growing: true }];
    },
  };
}
```
**Impact:** new module. It reads phase 3's `SubtitleContext` by its names (`infoHash`, `fileIndex`, `probe`), and
`import type { SubtitleContext, SubtitleTier } from './chain.js';` sits with its imports. `spawnExtractor`'s return type is node's
`ChildProcessByStdio<null, Readable, Readable>`, whose `on` overloads cover the three events above;
if `tsc` refuses the assignment, wrap it in an object literal that forwards `stdout`, `stderr`,
`on` and `kill`.

### Step 3: `config.torrent.ffmpegBin` is phase 3's
Nothing to add (reconciled): phase 3 owns `DEFAULT_FFMPEG_BIN`, `TorrentConfig.ffmpegBin` and the `NOTESD_FFMPEG_BIN`
row. This phase reads `config.torrent.ffmpegBin` (Step 8).

### Step 4: `CacheSubtitleView.growing`
**File:** `src/directStream/cachePlay.ts:12-18`
**Change:** replace the interface.
**Code:**
```ts
/** One subtitle file of a cache (WebVTT), served by the cache's file route; a torrent session's subtitles have the same shape. */
export interface CacheSubtitleView {
  /** Relative to the daemon's origin: `/api/stream/cache/<id>/f/<file>`, a torrent's `/sub/` route, or a cue feed. */
  url: string;
  lang: string | null;
  label: string;
  /**
   * A cue feed (`GET /api/stream/torrent/:hash/cues/:track`): `url` answers JSON cues after an
   * index, and the player reads it again until it is complete. Absent: `url` is a WebVTT file.
   */
  growing?: true;
}
```
**Impact:** optional literal field: every existing literal still compiles; `growing: false` cannot be written.

### Step 5: The cues route
**File:** `src/http/streamTorrentCuesApi.ts` (new)
**Change:** the one place a feed name and `after` come in from outside; checked here, trusted after.
**Code:**
```ts
import { Hono } from 'hono';
import type { AppDeps } from '../deps.js';
import { INFO_HASH_PATTERN, TRACK_ID_PATTERN } from '../directStream/torrent/subtitles/feed.js';

/**
 * A growing subtitle's cues (torrent-stream-source phase 7): `GET /api/stream/torrent/:hash/cues/:track?after=<n>`
 * answers the cues after the first `n`, the index to ask from next and whether the feed is complete.
 * The player page reads it every few seconds until it is. Read-only, like the file routes the page
 * loads, so it is not same-origin only. 503 `torrent_off` without torrents.
 */

const TORRENT_OFF = { error: 'torrent_off', message: 'Torrents are off on this machine (NOTESD_TORRENT=off).' } as const;
const AFTER = /^\d{1,7}$/;

export function streamTorrentCuesRoutes(deps: Partial<Pick<AppDeps, 'torrentCues'>>): Hono {
  const r = new Hono();

  r.get('/api/stream/torrent/:hash/cues/:track', async (c) => {
    const feeds = deps.torrentCues ?? null;
    if (feeds === null) return c.json(TORRENT_OFF, 503);
    const hash = c.req.param('hash').toLowerCase();
    const track = c.req.param('track');
    const after = c.req.query('after') ?? '0';
    if (!AFTER.test(after)) return c.json({ error: 'invalid_query', message: 'after: a whole number from 0.' }, 400);
    const feed = INFO_HASH_PATTERN.test(hash) && TRACK_ID_PATTERN.test(track) ? await feeds.get(hash, track) : null;
    if (feed === null) return c.json({ error: 'unknown_feed', message: 'This machine has no cue feed by that name.' }, 404);
    c.header('Cache-Control', 'no-store');
    return c.json(feed.read(Number(after)));
  });

  return r;
}
```
**Impact:** new route. If phase 1's `streamTorrentApi.ts` already exports a `torrent_off` body,
the reconciler may point `TORRENT_OFF` at it; the answer is the same.

### Step 6: `growing` through the server's `SessionInfo`
**File:** `src/directStream/service.ts:80-89` (interface), new module function above `export class DirectStreamService`, `:752` (the cache branch of `sessionInfo`)
**Change:** the server's `SessionSubtitle` carries `growing`; one function maps a local subtitle
view (a cache's, a torrent's) to what the page reads. `format` says what `url` answers: `cues` for
a feed, else `vtt`.
**Code:**
```ts
export interface SessionSubtitle {
  /** Pass-through address on this daemon; an `.srt` track's carries `&vtt=1`. A cache's or a torrent's: its local route. */
  url: string;
  lang: string | null;
  label: string;
  /** `vtt` for an `.srt` track (served converted); `cues` for a cue feed; otherwise the resolver's format. */
  format: string;
  source: 'request' | 'manifest';
  english: boolean;
  /** A cue feed (`format: "cues"`): the page reads `url` again, from where it stopped, until the feed is complete. */
  growing?: true;
}
```
```ts
/** A local subtitle (a cache's file, a torrent's file or cue feed) as the page reads it. */
function localSubtitle(view: CacheSubtitleView): SessionSubtitle {
  return {
    url: view.url,
    lang: view.lang,
    label: view.label,
    format: view.growing === true ? 'cues' : 'vtt',
    source: 'request',
    english: isEnglish(view),
    ...(view.growing === true ? { growing: true as const } : {}),
  };
}
```
In `sessionInfo` as phase 3 leaves it (its `const local = torrent ?? cache` branch serves a cache and a torrent alike),
the line
```ts
          : local.subtitles.map((t) => ({ url: t.url, lang: t.lang, label: t.label, format: 'vtt', source: 'request' as const, english: isEnglish(t) })),
```
becomes:
```ts
          : local.subtitles.map(localSubtitle),
```
Add `type CacheSubtitleView` to the existing import from `./cachePlay.js` in `service.ts`.
**Impact:** the cache branch answers exactly what it did (no cache view is growing); the same line maps a torrent
session's subtitles, so `growing` reaches the page.

### Step 7: Mount the route and add the dependency
**File:** `src/deps.ts:68` (after `streamCache?`), `src/http/app.ts:33` (imports), `src/http/app.ts:149` (mounts)
**Code:**
```ts
// src/deps.ts: import at the top
import type { CueFeeds } from './directStream/torrent/subtitles/feed.js';
```
```ts
// src/deps.ts: in `interface AppDeps`, after `streamCache?: StreamCache | null;`
  /**
   * The growing cue feeds of torrent sessions (torrent-stream-source phase 7: the subtitle track inside
   * a torrent's file; phase 8: Whisper). Built next to `torrents`; null or absent with torrents off,
   * and GET /api/stream/torrent/:hash/cues/:track then answers 503 torrent_off.
   */
  torrentCues?: CueFeeds | null;
```
```ts
// src/http/app.ts: after `import { streamReportRoutes } from './streamReportApi.js';`
import { streamTorrentCuesRoutes } from './streamTorrentCuesApi.js';
```
```ts
// src/http/app.ts: after `app.route('/', streamReportRoutes(deps));`, before staticRoutes
  app.route('/', streamTorrentCuesRoutes(deps));
```
**Impact:** the route is served; without `torrentCues` it answers 503 `torrent_off` (behind the
`directStreamRoutes` guard, which answers 503 `direct_stream_off` first when direct streaming is off).

### Step 8: Wiring in the daemon
**File:** `src/directStream/torrent/subtitles/chain.ts` (phase 3's file, with phase 6's tiers in it) and `src/daemon.ts`
**Change:** one `SubtitleTierDeps` field and the tier at phase 3's `// Phase 7: embedded.` comment (after phase 6's
`files`, before its `service`); in the daemon, the feeds and the extraction built right after phase 1's
`const torrents = buildTorrentStreams(...)` (the route needs `torrentCues` whether or not a torrent was played), the
field in phase 3's `buildSubtitleTiers({...})` object, and `torrentCues` in `deps`.
**Code:**
```ts
// chain.ts: import, the SubtitleTierDeps field, the tier
import { embeddedTier, type EmbeddedSubtitles } from './embedded.js';
```
```ts
  /** The extraction of a file's English text track into a growing cue feed (phase 7); null with torrents off. */
  embedded?: EmbeddedSubtitles | null;
```
```ts
    // Phase 7: embedded.
    ...(deps.embedded == null ? [] : [embeddedTier(deps.embedded)]),
```
```ts
// src/daemon.ts: imports
import { EmbeddedSubtitles } from './directStream/torrent/subtitles/embedded.js';
import { CueFeeds } from './directStream/torrent/subtitles/feed.js';
```
```ts
// src/daemon.ts: right after phase 1's `const torrents = buildTorrentStreams(config, directStream, db);`
  // Phase 7: the growing cue feeds (the subtitle track inside a torrent's file; phase 8's Whisper) and
  // the ffmpeg extraction that fills them. ffmpeg reads the file from disk once it is complete, else
  // through this daemon's own file route, which waits for the pieces as the torrent downloads.
  const torrentDir = config.torrent?.dir ?? null;
  const torrentCues = torrents === null || torrentDir === null ? null : new CueFeeds({ folderOf: (infoHash) => join(torrentDir, infoHash) });
  const embeddedSubtitles =
    torrents === null || torrentCues === null || config.torrent === undefined
      ? null
      : new EmbeddedSubtitles({
          ffmpegBin: config.torrent.ffmpegBin,
          feeds: torrentCues,
          input: async (infoHash, fileIndex) =>
            (await torrents.filePath(infoHash, fileIndex)) ?? `http://127.0.0.1:${boundPort ?? config.port}${torrents.localUrl(infoHash, fileIndex)}`,
        });
```
```ts
// src/daemon.ts: in phase 3's `buildSubtitleTiers({ ... })` object, at its comment
          embedded: embeddedSubtitles,
```
```ts
// src/daemon.ts: in `const deps: AppDeps = { ... }`, after phase 1's `torrents,`
    torrentCues,
```
**Impact:** with torrents off nothing is built (no ffmpeg, no feed folder). `join` is already imported in
`daemon.ts`.

### Step 9: The page reads `growing`
**File:** `web/src/stream/session.ts:6-12` and `:116`
**Change:** one optional field and one changed line (the one-line addition phase 4 expects).
**Code:**
```ts
/** A separate subtitle file of the session (phase 3's `source: "request"` tracks). */
export interface SessionSubtitle {
  url: string;
  lang: string | null;
  label: string;
  /** Phase 3's `english` when it sent one, else isEnglish(lang, label). */
  english: boolean;
  /** A cue feed: `url` answers JSON cues after an index (subtitles.ts followCueFeed), read until complete. Absent: a WebVTT or SRT file. */
  growing?: true;
}
```
Line 116 becomes:
```ts
      subtitles.push({ url, lang, label, english: typeof s.english === 'boolean' ? s.english : isEnglish(lang, label), ...(s.growing === true ? { growing: true as const } : {}) });
```
**Impact:** sessions without the field parse exactly as before (the existing `toEqual` tests keep passing).

### Step 10: The page follows a growing track
**File:** `web/src/stream/subtitles.ts` (append after line 56)
**Code:**
```ts
/** One cue of a growing subtitle, as GET /api/stream/torrent/:hash/cues/:track answers it. */
export interface FeedCue {
  start_s: number;
  end_s: number;
  text: string;
}

/** One answer of a cue feed. */
export interface CueFeedPage {
  cues: FeedCue[];
  next: number;
  complete: boolean;
}

/** How often a growing subtitle is read again while it is not complete. */
export const CUE_FEED_POLL_MS = 4_000;

/** A feed answer, checked once; null when it is not one. A cue without text or length is left out. */
export function parseCueFeed(json: unknown): CueFeedPage | null {
  if (typeof json !== 'object' || json === null) return null;
  const o = json as Record<string, unknown>;
  if (!Array.isArray(o.cues) || typeof o.next !== 'number' || !Number.isInteger(o.next) || o.next < 0 || typeof o.complete !== 'boolean') return null;
  const cues: FeedCue[] = [];
  for (const entry of o.cues) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { start_s: start, end_s: end, text } = entry as Record<string, unknown>;
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (typeof text !== 'string' || text.trim() === '') continue;
    cues.push({ start_s: start, end_s: end, text });
  }
  return { cues, next: o.next, complete: o.complete };
}

export interface CueFeedFollower {
  stop(): void;
}

export interface FollowCueFeedDeps {
  fetch: typeof fetch;
  /** Each cue, as it arrives. */
  add: (cue: FeedCue) => void;
  /** A read failed: said once per run of failures. A 404 (no such feed on this machine) ends the following. */
  onError?: (message: string) => void;
  /** The feed is complete: `count` cues in all. */
  onComplete?: (count: number) => void;
  pollMs?: number;
}

/**
 * Reads a growing subtitle from the start, adds each cue, and reads it again every `pollMs` from
 * where it stopped until the feed says it is complete. A failed read is tried again at the next
 * poll; a 404 stops.
 */
export function followCueFeed(url: string, deps: FollowCueFeedDeps): CueFeedFollower {
  const fetchImpl = deps.fetch;
  const pollMs = deps.pollMs ?? CUE_FEED_POLL_MS;
  let next = 0;
  let stopped = false;
  let failing = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fail = (message: string): void => {
    if (!failing) deps.onError?.(message);
    failing = true;
  };
  const later = (): void => {
    if (!stopped) timer = setTimeout(() => void read(), pollMs);
  };
  const read = async (): Promise<void> => {
    timer = null;
    let page: CueFeedPage | null = null;
    try {
      const res = await fetchImpl(`${url}${url.includes('?') ? '&' : '?'}after=${next}`, { cache: 'no-store' });
      if (res.status === 404) {
        if (!stopped) deps.onError?.('http_404');
        stopped = true;
        return;
      }
      page = res.ok ? parseCueFeed(await res.json()) : null;
      if (page === null) fail(res.ok ? 'not a cue feed' : `http_${res.status}`);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
    if (stopped) return;
    if (page === null) {
      later();
      return;
    }
    failing = false;
    for (const cue of page.cues) deps.add(cue);
    next = Math.max(next, page.next);
    if (page.complete) {
      stopped = true;
      deps.onComplete?.(next);
      return;
    }
    later();
  };
  void read();
  return {
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

/** Adds a feed's cue to a text track as a browser cue. Without VTTCue (not a browser) nothing is added. */
export function addFeedCue(track: Pick<TextTrack, 'addCue'>, cue: FeedCue): void {
  const Cue = (globalThis as { VTTCue?: new (start: number, end: number, text: string) => TextTrackCue }).VTTCue;
  if (Cue === undefined) return;
  track.addCue(new Cue(cue.start_s, cue.end_s, cue.text));
}
```
**File:** `web/src/stream/controller.ts`
- `:31`, the import from `./subtitles` becomes:
```ts
import { addFeedCue, followCueFeed, isEnglish, pickDefaultSubtitle, toWebVtt, type CueFeedFollower, type SubtitleOption } from './subtitles';
```
  and the import from `./session` gains `type SessionSubtitle` (add it to that import's list).
- `:170-174`, `FileTrack` becomes:
```ts
interface FileTrack {
  option: SubtitleOption;
  element: HTMLTrackElement;
  url: string;
  /** A growing subtitle's reader of its feed, once the track has loaded; null for a file. */
  follower: CueFeedFollower | null;
}
```
- `:585-607`, `loadFileSubtitles` is replaced by these two methods:
```ts
  private async loadFileSubtitles(session: StreamSession): Promise<void> {
    for (const [index, sub] of session.subtitles.entries()) {
      try {
        // A growing subtitle (a cue feed) starts as an empty file; its cues are added as they come.
        // One more try for a file: a stream host that fails once would leave the whole film without the track.
        const vtt = sub.growing === true ? 'WEBVTT\n\n' : toWebVtt(await fetchText(sub.url, this.deps.fetch).catch(() => fetchText(sub.url, this.deps.fetch)));
        const url = this.deps.textUrl(vtt);
        const element = this.video.ownerDocument.createElement('track');
        element.kind = 'subtitles';
        element.label = sub.label;
        if (sub.lang !== null) element.srclang = sub.lang;
        element.src = url;
        this.video.appendChild(element);
        const fileTrack: FileTrack = {
          option: { id: `file-${index}`, source: 'file', index, label: sub.label, lang: sub.lang, english: sub.english },
          element,
          url,
          follower: null,
        };
        if (sub.growing === true) this.followGrowing(fileTrack, sub);
        this.fileTracks.push(fileTrack);
      } catch (err) {
        this.note(`subtitle ${sub.label}: ${messageOf(err)}`);
      }
    }
  }

  /**
   * A growing subtitle's cues come from its feed, read again every few seconds until it is complete.
   * Chrome empties a <track>'s cues when it first loads its file, and loads it only when the track is
   * first turned on, so the feed is read from then on: at once for the English track shown by default.
   */
  private followGrowing(fileTrack: FileTrack, sub: SessionSubtitle): void {
    fileTrack.element.addEventListener(
      'load',
      () => {
        const track = fileTrack.element.track;
        if (this.disposed || fileTrack.follower !== null || !this.fileTracks.includes(fileTrack) || !track) return;
        fileTrack.follower = followCueFeed(sub.url, {
          fetch: this.deps.fetch,
          add: (cue) => addFeedCue(track, cue),
          onError: (message) => this.note(`subtitle ${sub.label}: ${message}`),
          onComplete: (count) => this.note(`subtitle ${sub.label}: complete, ${count} cues`),
        });
      },
      { once: true },
    );
  }
```
- `:864-872`, `clearFileTracks` becomes:
```ts
  private clearFileTracks(): void {
    for (const track of this.fileTracks) {
      track.follower?.stop();
      if (track.element.track) track.element.track.mode = 'disabled';
      track.element.remove();
      this.deps.revokeTextUrl(track.url);
    }
    this.fileTracks = [];
    if (this.state.caption !== '') this.set({ caption: '' });
  }
```
**Impact:** a file subtitle loads exactly as before. A growing one adds cues to its track; the
existing `cuechange` / `timeupdate` reading (`readCaption`) shows them and `applySubtitleDelay`
moves new cues by the G/H delay (it goes through the cues again whenever their count changes).
`dispose`, a source switch, an episode switch and the move onto a cache all go through
`clearFileTracks`, so no follower outlives its track.

### Step 11: Tests
**File:** `tests/unit/directStream/torrent/subtitles/feed.test.ts` (new)
```ts
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CUES_DIR, CUES_PER_READ, CueFeeds, cleanCue, cueFeedUrl, parseFeedFile } from '../../../../../src/directStream/torrent/subtitles/feed.js';

const HASH = 'c'.repeat(40);
let dir: string;
let feeds: CueFeeds;
const lines: string[] = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'notesd-cues-'));
  lines.length = 0;
  feeds = new CueFeeds({ folderOf: (hash) => path.join(dir, hash), log: (l) => lines.push(l) });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('a cue feed', () => {
  it('answers what was appended, from an index on, and says when it is complete', async () => {
    const feed = await feeds.start(HASH, 'embedded-2');
    void feed.append([{ start_s: 1, end_s: 3, text: 'Line 1' }, { start_s: 4, end_s: 6, text: 'Line 2' }]);
    expect(feed.read(0)).toEqual({ cues: [{ start_s: 1, end_s: 3, text: 'Line 1' }, { start_s: 4, end_s: 6, text: 'Line 2' }], next: 2, complete: false });
    void feed.append([{ start_s: 7, end_s: 9, text: 'Line 3' }]);
    expect(feed.read(2)).toEqual({ cues: [{ start_s: 7, end_s: 9, text: 'Line 3' }], next: 3, complete: false });
    await feed.complete();
    expect(feed.read(3)).toEqual({ cues: [], next: 3, complete: true });
    // A complete feed takes nothing more.
    await feed.append([{ start_s: 10, end_s: 11, text: 'late' }]);
    expect(feed.size).toBe(3);
  });

  it('never moves a reader back, even past the end', async () => {
    const feed = await feeds.start(HASH, 'whisper');
    await feed.append([{ start_s: 1, end_s: 2, text: 'a' }]);
    expect(feed.read(5)).toEqual({ cues: [], next: 5, complete: false });
  });

  it('answers at most CUES_PER_READ cues and is not complete until the reader has them all', async () => {
    const feed = await feeds.start(HASH, 'embedded-3');
    await feed.append(Array.from({ length: CUES_PER_READ + 5 }, (_, i) => ({ start_s: i, end_s: i + 0.5, text: `c${i}` })));
    await feed.complete();
    const first = feed.read(0);
    expect(first.cues).toHaveLength(CUES_PER_READ);
    expect(first.complete).toBe(false);
    expect(feed.read(first.next)).toMatchObject({ next: CUES_PER_READ + 5, complete: true });
  });

  it('keeps only cues with text and length, to the millisecond', () => {
    expect(cleanCue({ start_s: 1.00049, end_s: 2.5, text: ' Hi\r\nthere ' })).toEqual({ start_s: 1, end_s: 2.5, text: 'Hi\nthere' });
    expect(cleanCue({ start_s: 2, end_s: 2, text: 'zero' })).toBeNull();
    expect(cleanCue({ start_s: 1, end_s: 2, text: '  ' })).toBeNull();
    expect(cleanCue({ start_s: Number.NaN, end_s: 2, text: 'x' })).toBeNull();
  });

  it('is on disk in the torrent folder, and a new CueFeeds reads it back for a replay', async () => {
    const feed = await feeds.start(HASH, 'embedded-2');
    await feed.append([{ start_s: 1, end_s: 3, text: '<i>Line 1</i>' }]);
    await feed.complete();
    const file = path.join(dir, HASH, CUES_DIR, 'embedded-2.jsonl');
    expect(await readFile(file, 'utf8')).toBe('{"start_s":1,"end_s":3,"text":"<i>Line 1</i>"}\n{"complete":true}\n');
    const again = await new CueFeeds({ folderOf: (hash) => path.join(dir, hash) }).get(HASH, 'embedded-2');
    expect(again?.read(0)).toEqual({ cues: [{ start_s: 1, end_s: 3, text: '<i>Line 1</i>' }], next: 1, complete: true });
  });

  it('reads a file cut off mid-line as an incomplete feed, and start() empties it', async () => {
    await mkdir(path.join(dir, HASH, CUES_DIR), { recursive: true });
    await writeFile(path.join(dir, HASH, CUES_DIR, 'embedded-2.jsonl'), '{"start_s":1,"end_s":3,"text":"a"}\n{"start_s":4,"end_s');
    expect(parseFeedFile('{"start_s":1,"end_s":3,"text":"a"}\n{"start_s":4,"end_s')).toEqual({ cues: [{ start_s: 1, end_s: 3, text: 'a' }], complete: false });
    const torn = await feeds.get(HASH, 'embedded-2');
    expect(torn?.isComplete).toBe(false);
    const fresh = await feeds.start(HASH, 'embedded-2');
    expect(fresh.size).toBe(0);
    expect(await feeds.get(HASH, 'embedded-2')).toBe(fresh);
  });

  it('answers null for a feed this machine does not have', async () => {
    expect(await feeds.get(HASH, 'embedded-9')).toBeNull();
    expect(cueFeedUrl(HASH, 'whisper')).toBe(`/api/stream/torrent/${HASH}/cues/whisper`);
  });
});
```
**File:** `tests/unit/directStream/torrent/subtitles/embedded.test.ts` (new)
```ts
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EmbeddedSubtitles,
  VttCueReader,
  chooseEmbeddedTrack,
  embeddedTier,
  extractArgs,
  trackLabel,
  type EmbeddedTrackInfo,
  type ExtractorProcess,
} from '../../../../../src/directStream/torrent/subtitles/embedded.js';
import { CueFeeds } from '../../../../../src/directStream/torrent/subtitles/feed.js';

const HASH = 'b'.repeat(40);
const sub = (index: number, codec: string, lang: string | null, extra: Partial<EmbeddedTrackInfo> = {}): EmbeddedTrackInfo => ({ index, codec, lang, ...extra });

class FakeFfmpeg extends EventEmitter implements ExtractorProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
  /** ffmpeg writes, then exits: stdout ends before `close`, as with a real child. */
  async exit(code: number, stderrText = ''): Promise<void> {
    if (stderrText !== '') this.stderr.write(stderrText);
    this.stdout.end();
    this.stderr.end();
    await new Promise((r) => setImmediate(r));
    this.emit('close', code, null);
  }
}

describe('chooseEmbeddedTrack', () => {
  it('takes no picture track, whatever its language (R3.5)', () => {
    expect(chooseEmbeddedTrack([sub(2, 'hdmv_pgs_subtitle', 'eng'), sub(3, 'dvd_subtitle', 'eng'), sub(4, 'dvb_subtitle', 'en')])).toBeNull();
    expect(chooseEmbeddedTrack([])).toBeNull();
  });

  it('takes English text tracks only', () => {
    expect(chooseEmbeddedTrack([sub(2, 'subrip', 'fre'), sub(3, 'hdmv_pgs_subtitle', 'eng')])).toBeNull();
    expect(chooseEmbeddedTrack([sub(2, 'subrip', 'fre'), sub(3, 'hdmv_pgs_subtitle', 'eng'), sub(4, 'subrip', 'eng')])?.index).toBe(4);
    expect(chooseEmbeddedTrack([sub(5, 'mov_text', null, { title: 'English' })])?.index).toBe(5);
  });

  it('prefers a full track over SDH, SubRip over ASS, and leaves a forced track unless it is the only one', () => {
    expect(chooseEmbeddedTrack([sub(2, 'subrip', 'eng', { hearingImpaired: true }), sub(3, 'subrip', 'eng')])?.index).toBe(3);
    expect(chooseEmbeddedTrack([sub(2, 'subrip', 'eng', { title: 'English SDH' }), sub(3, 'ass', 'eng')])?.index).toBe(3);
    expect(chooseEmbeddedTrack([sub(2, 'ass', 'eng'), sub(3, 'subrip', 'eng')])?.index).toBe(3);
    expect(chooseEmbeddedTrack([sub(2, 'subrip', 'eng', { forced: true }), sub(3, 'subrip', 'eng')])?.index).toBe(3);
    expect(chooseEmbeddedTrack([sub(2, 'subrip', 'eng', { title: 'Forced' })])?.index).toBe(2);
    expect(chooseEmbeddedTrack([sub(2, 'subrip', 'eng', { forced: true }), sub(3, 'ass', 'eng', { forced: true })])).toBeNull();
  });

  it('names the track by its title when it says something', () => {
    expect(trackLabel(sub(2, 'subrip', 'eng', { title: 'English SDH' }))).toBe('English SDH');
    expect(trackLabel(sub(2, 'subrip', 'eng', { title: 'eng' }))).toBe('English');
    expect(trackLabel(sub(2, 'subrip', 'eng'))).toBe('English');
  });
});

describe('VttCueReader', () => {
  it('gives each cue once its block has ended, across chunk boundaries', () => {
    const reader = new VttCueReader();
    expect(reader.push('WEBVTT\n\n00:01.000 --> 00:03.000\n<i>Line 1</i> & more\n')).toEqual([]);
    expect(reader.push('\n00:04.000 --> 00:0')).toEqual([{ start_s: 1, end_s: 3, text: '<i>Line 1</i> & more' }]);
    expect(reader.push('6.000\nLine 2\nsecond row\n\n01:02:03.500 --> 01:02:05.000\nLate')).toEqual([{ start_s: 4, end_s: 6, text: 'Line 2\nsecond row' }]);
    expect(reader.end()).toEqual([{ start_s: 3723.5, end_s: 3725, text: 'Late' }]);
  });
});

describe('extractArgs', () => {
  it('keeps the file\'s own times and waits out a slow route, over HTTP only', () => {
    const http = extractArgs('http://127.0.0.1:7317/api/stream/torrent/x/f/0', 2, 300);
    expect(http).toEqual(['-v', 'error', '-nostdin', '-copyts', '-reconnect', '1', '-reconnect_delay_max', '30', '-rw_timeout', '300000000', '-i', 'http://127.0.0.1:7317/api/stream/torrent/x/f/0', '-map', '0:2', '-c:s', 'webvtt', '-flush_packets', '1', '-f', 'webvtt', 'pipe:1']);
    expect(extractArgs('/data/film.mkv', 3)).toEqual(['-v', 'error', '-nostdin', '-copyts', '-i', '/data/film.mkv', '-map', '0:3', '-c:s', 'webvtt', '-flush_packets', '1', '-f', 'webvtt', 'pipe:1']);
  });
});

describe('EmbeddedSubtitles with a fake ffmpeg', () => {
  let dir: string;
  let feeds: CueFeeds;
  let spawned: { bin: string; args: string[]; child: FakeFfmpeg }[];
  let lines: string[];
  let subs: EmbeddedSubtitles;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'notesd-embedded-'));
    feeds = new CueFeeds({ folderOf: (hash) => path.join(dir, hash), log: () => {} });
    spawned = [];
    lines = [];
    subs = new EmbeddedSubtitles({
      ffmpegBin: '/bin/ffmpeg-fake',
      feeds,
      input: async (hash, index) => `http://127.0.0.1:1/api/stream/torrent/${hash}/f/${index}`,
      spawn: (bin, args) => {
        const child = new FakeFfmpeg();
        spawned.push({ bin, args, child });
        queueMicrotask(() => child.emit('spawn'));
        return child;
      },
      log: (l) => lines.push(l),
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('fills the feed as ffmpeg writes, and marks it complete when ffmpeg ends cleanly (R3.4)', async () => {
    const feed = await subs.feedOf(HASH, 0, sub(2, 'subrip', 'eng'));
    expect(feed?.track).toBe('embedded-0-2');
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.args).toContain(`http://127.0.0.1:1/api/stream/torrent/${HASH}/f/0`);
    const child = spawned[0]!.child;
    child.stdout.write('WEBVTT\n\n00:01.000 --> 00:03.000\nLine 1\n\n');
    await vi.waitFor(() => expect(feed?.read(0).cues).toEqual([{ start_s: 1, end_s: 3, text: 'Line 1' }]));
    expect(feed?.isComplete).toBe(false);
    child.stdout.write('00:04.000 --> 00:06.000\nLine 2\n');
    await child.exit(0);
    await vi.waitFor(() => expect(feed?.read(0)).toEqual({ cues: [{ start_s: 1, end_s: 3, text: 'Line 1' }, { start_s: 4, end_s: 6, text: 'Line 2' }], next: 2, complete: true }));
  });

  it('runs one extraction per track, and a replay reuses a complete feed without ffmpeg', async () => {
    const [a, b] = await Promise.all([subs.feedOf(HASH, 0, sub(2, 'subrip', 'eng')), subs.feedOf(HASH, 0, sub(2, 'subrip', 'eng'))]);
    expect(a).toBe(b);
    expect(spawned).toHaveLength(1);
    await spawned[0]!.child.exit(0);
    await vi.waitFor(() => expect(a?.isComplete).toBe(true));
    // complete() on a complete feed answers its pending disk write: the file is whole after this.
    await a?.complete();
    const fresh = new EmbeddedSubtitles({ ffmpegBin: 'x', feeds: new CueFeeds({ folderOf: (hash) => path.join(dir, hash) }), input: async () => 'x', spawn: () => { throw new Error('ffmpeg must not run'); } });
    const kept = await fresh.feedOf(HASH, 0, sub(2, 'subrip', 'eng'));
    expect(kept?.isComplete).toBe(true);
  });

  it('leaves a stopped extraction incomplete and starts it over on the next play', async () => {
    const first = await subs.feedOf(HASH, 0, sub(2, 'subrip', 'eng'));
    spawned[0]!.child.stdout.write('00:01.000 --> 00:03.000\nLine 1\n\n');
    await spawned[0]!.child.exit(1, 'http://127.0.0.1/...: Server returned 404 Not Found\n');
    await vi.waitFor(() => expect(lines.some((l) => l.includes('stopped after 1 cues (exit 1: http://127.0.0.1/...: Server returned 404 Not Found)'))).toBe(true));
    expect(first?.isComplete).toBe(false);
    const second = await subs.feedOf(HASH, 0, sub(2, 'subrip', 'eng'));
    expect(spawned).toHaveLength(2);
    expect(second?.size).toBe(0);
  });

  it('answers null when ffmpeg cannot start', async () => {
    const broken = new EmbeddedSubtitles({
      ffmpegBin: '/nowhere/ffmpeg',
      feeds,
      input: async () => '/data/film.mkv',
      spawn: () => {
        const child = new FakeFfmpeg();
        queueMicrotask(() => child.emit('error', new Error('spawn /nowhere/ffmpeg ENOENT')));
        return child;
      },
      log: () => {},
    });
    expect(await broken.feedOf(HASH, 0, sub(2, 'subrip', 'eng'))).toBeNull();
  });

  it('the tier answers the feed as a growing English subtitle', async () => {
    const tier = embeddedTier(subs);
    const views = await tier.find({ infoHash: HASH, fileIndex: 0, probe: { subtitles: [sub(2, 'hdmv_pgs_subtitle', 'eng'), sub(3, 'subrip', 'eng', { title: 'English SDH', hearingImpaired: true })] } } as never);
    expect(views).toEqual([{ url: `/api/stream/torrent/${HASH}/cues/embedded-0-3`, lang: 'en', label: 'English SDH', growing: true }]);
  });

  it('the tier answers nothing for picture tracks only, so the chain goes on, and runs no ffmpeg (R3.5)', async () => {
    const tier = embeddedTier(subs);
    const views = await tier.find({ infoHash: HASH, fileIndex: 0, probe: { subtitles: [sub(2, 'hdmv_pgs_subtitle', 'eng'), sub(3, 'dvd_subtitle', 'eng')] } } as never);
    expect(views).toEqual([]);
    expect(spawned).toHaveLength(0);
    expect(lines).toContain(`[notesd] torrent: no English text subtitle track in bbbbbbbb (hdmv_pgs_subtitle/eng, dvd_subtitle/eng); the next subtitle tier is asked`);
    expect(await tier.find({ infoHash: HASH, fileIndex: 0, probe: { subtitles: [] } } as never)).toEqual([]);
    expect(tier.blocks).toBe(false);
  });
});
```
(`as never` passes only the fields `EmbeddedTierContext` reads from phase 3's `SubtitleContext`.)

**File:** `tests/unit/directStream/torrent/subtitles/embedded.ffmpeg.test.ts` (new): the one
real-ffmpeg test. It builds a 60 s MKV (H.264, AAC, an English SubRip track and an English ASS
track), serves it from a throttled range server, and checks the cues reach the feed **before the
server has sent the whole file**, with the file's own times.
```ts
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EmbeddedSubtitles } from '../../../../../src/directStream/torrent/subtitles/embedded.js';
import { CueFeeds, type CueFeed } from '../../../../../src/directStream/torrent/subtitles/feed.js';

const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;
const HASH = 'd'.repeat(40);
const CHUNK = 16 * 1024;
const PACE_MS = 40;

const stamp = (s: number): string => `00:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')},000`;
const SRT = Array.from({ length: 20 }, (_, i) => `${i + 1}\n${stamp(3 * (i + 1) - 2)} --> ${stamp(3 * (i + 1))}\n<i>Line ${i + 1}</i>\n`).join('\n');
const ASS = [
  '[Script Info]',
  'ScriptType: v4.00+',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,Arial,16,&Hffffff,&Hffffff,&H0,&H0,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,0',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,{\\an8}{\\i1}Styled{\\i0} line\\Nsecond row',
  '',
].join('\n');

describe.skipIf(!HAS_FFMPEG)('the embedded track with the real ffmpeg', () => {
  let dir: string;
  let film: Buffer;
  let server: Server;
  let base: string;
  /** feed.size when the server wrote the last chunk of the file. */
  let sizeAtLastChunk: number | null = null;
  let watched: CueFeed | null = null;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'notesd-embedded-ffmpeg-'));
    await writeFile(path.join(dir, 'en.srt'), SRT);
    await writeFile(path.join(dir, 'en.ass'), ASS);
    const made = spawnSync('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=25:duration=60',
      '-f', 'lavfi', '-i', 'sine=duration=60',
      '-i', path.join(dir, 'en.srt'), '-i', path.join(dir, 'en.ass'),
      '-map', '0', '-map', '1', '-map', '2', '-map', '3',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-c:s:0', 'srt', '-c:s:1', 'ass',
      '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=eng',
      path.join(dir, 'film.mkv'),
    ]);
    expect(made.status).toBe(0);
    film = await readFile(path.join(dir, 'film.mkv'));
    server = createServer((req, res) => {
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] !== '' ? Number(m[2]) : film.length - 1;
      res.writeHead(m ? 206 : 200, {
        'content-length': String(end - start + 1),
        'accept-ranges': 'bytes',
        'content-type': 'video/x-matroska',
        ...(m ? { 'content-range': `bytes ${start}-${end}/${film.length}` } : {}),
      });
      let at = start;
      const tick = (): void => {
        if (res.destroyed) return;
        const to = Math.min(at + CHUNK, end + 1);
        if (to === film.length && sizeAtLastChunk === null && watched !== null) sizeAtLastChunk = watched.size;
        res.write(film.subarray(at, to));
        at = to;
        if (at > end) res.end();
        else setTimeout(tick, PACE_MS);
      };
      tick();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/film.mkv`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  it('extracts the SubRip track over HTTP as the file arrives, with the file\'s own times (R3.4)', async () => {
    const subs = new EmbeddedSubtitles({ ffmpegBin: 'ffmpeg', feeds: new CueFeeds({ folderOf: (hash) => path.join(dir, hash), log: () => {} }), input: async () => base, log: () => {} });
    const feed = await subs.feedOf(HASH, 0, { index: 2, codec: 'subrip', lang: 'eng' });
    expect(feed).not.toBeNull();
    watched = feed;
    for (let i = 0; i < 300 && !feed!.isComplete; i++) await new Promise((r) => setTimeout(r, 100));
    expect(feed!.isComplete).toBe(true);
    const { cues } = feed!.read(0);
    expect(cues).toHaveLength(20);
    expect(cues[0]).toEqual({ start_s: 1, end_s: 3, text: '<i>Line 1</i>' });
    expect(cues[16]).toEqual({ start_s: 49, end_s: 51, text: '<i>Line 17</i>' });
    // Progressive: most cues were in the feed before the server had sent the end of the file.
    expect(sizeAtLastChunk).not.toBeNull();
    expect(sizeAtLastChunk!).toBeGreaterThanOrEqual(10);
  }, 60_000);

  it('extracts an ASS track as text, its override codes gone', async () => {
    const subs = new EmbeddedSubtitles({ ffmpegBin: 'ffmpeg', feeds: new CueFeeds({ folderOf: (hash) => path.join(dir, hash), log: () => {} }), input: async () => path.join(dir, 'film.mkv'), log: () => {} });
    const feed = await subs.feedOf(HASH, 0, { index: 3, codec: 'ass', lang: 'eng' });
    for (let i = 0; i < 300 && !feed!.isComplete; i++) await new Promise((r) => setTimeout(r, 100));
    expect(feed!.read(0).cues).toEqual([{ start_s: 2, end_s: 4, text: '<i>Styled</i> line\nsecond row' }]);
  }, 60_000);
});
```
**File:** `tests/unit/directStream/torrent/cuesRoute.test.ts` (new)
```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDeps } from '../../../../src/deps.js';
import { CueFeeds } from '../../../../src/directStream/torrent/subtitles/feed.js';
import { streamTorrentCuesRoutes } from '../../../../src/http/streamTorrentCuesApi.js';

const HASH = 'e'.repeat(40);
let dir: string;
let feeds: CueFeeds;

function app(deps: Partial<AppDeps>): Hono {
  const a = new Hono();
  a.route('/', streamTorrentCuesRoutes(deps));
  return a;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'notesd-cues-route-'));
  feeds = new CueFeeds({ folderOf: (hash) => path.join(dir, hash), log: () => {} });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('GET /api/stream/torrent/:hash/cues/:track', () => {
  it('answers torrent_off without torrents', async () => {
    const res = await app({ torrentCues: null }).request(`/api/stream/torrent/${HASH}/cues/embedded-2`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'torrent_off' });
  });

  it('answers the cues after an index, and complete once there are no more', async () => {
    const feed = await feeds.start(HASH, 'embedded-2');
    await feed.append([{ start_s: 1, end_s: 3, text: 'Line 1' }, { start_s: 4, end_s: 6, text: 'Line 2' }]);
    const a = app({ torrentCues: feeds });
    const first = await a.request(`/api/stream/torrent/${HASH}/cues/embedded-2`);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(await first.json()).toEqual({ cues: [{ start_s: 1, end_s: 3, text: 'Line 1' }, { start_s: 4, end_s: 6, text: 'Line 2' }], next: 2, complete: false });
    await feed.complete();
    expect(await (await a.request(`/api/stream/torrent/${HASH.toUpperCase()}/cues/embedded-2?after=2`)).json()).toEqual({ cues: [], next: 2, complete: true });
  });

  it('refuses a bad after, and names no feed for an unknown or malformed name', async () => {
    const a = app({ torrentCues: feeds });
    expect((await a.request(`/api/stream/torrent/${HASH}/cues/embedded-2?after=-1`)).status).toBe(400);
    expect((await a.request(`/api/stream/torrent/${HASH}/cues/embedded-2?after=x`)).status).toBe(400);
    const unknown = await a.request(`/api/stream/torrent/${HASH}/cues/embedded-9`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: 'unknown_feed' });
    expect((await a.request('/api/stream/torrent/not-a-hash/cues/embedded-2')).status).toBe(404);
    expect((await a.request(`/api/stream/torrent/${HASH}/cues/..%2F..%2Fetc`)).status).toBe(404);
  });
});
```
**File:** `web/src/stream/subtitles.test.tsx`: change the import on line 3 and append two `describe` blocks.
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CUE_FEED_POLL_MS, followCueFeed, isEnglish, parseCueFeed, pickDefaultSubtitle, toWebVtt, type FeedCue, type SubtitleOption } from './subtitles';
```
(the first import line `import { describe, expect, it } from 'vitest';` is replaced by the one above.)
```ts
afterEach(() => {
  vi.useRealTimers();
});

describe('parseCueFeed', () => {
  it('reads a feed answer and leaves out cues without text or length', () => {
    expect(parseCueFeed({ cues: [{ start_s: 1, end_s: 3, text: 'Hi' }, { start_s: 4, end_s: 4, text: 'zero' }, { start_s: 5, end_s: 6, text: ' ' }, 'x'], next: 4, complete: false })).toEqual({
      cues: [{ start_s: 1, end_s: 3, text: 'Hi' }],
      next: 4,
      complete: false,
    });
  });

  it('refuses what is not a feed answer', () => {
    expect(parseCueFeed(null)).toBeNull();
    expect(parseCueFeed({ cues: [], next: -1, complete: false })).toBeNull();
    expect(parseCueFeed({ cues: [], next: 1.5, complete: false })).toBeNull();
    expect(parseCueFeed({ cues: {}, next: 0, complete: true })).toBeNull();
    expect(parseCueFeed({ cues: [], next: 0 })).toBeNull();
  });
});

describe('followCueFeed', () => {
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('adds the cues that arrive in later reads, from where it stopped, until the feed is complete', async () => {
    vi.useFakeTimers();
    const answers: Record<string, Response | (() => Response)> = {
      '/cues?after=0': json({ cues: [{ start_s: 1, end_s: 3, text: 'Line 1' }], next: 1, complete: false }),
      '/cues?after=1': json({ cues: [], next: 1, complete: false }),
    };
    const asked: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      asked.push(url);
      const answer = answers[url];
      return typeof answer === 'function' ? answer() : (answer ?? json({ error: 'not_found' }, 404));
    }) as typeof fetch;
    const added: FeedCue[] = [];
    let completeAt: number | null = null;
    followCueFeed('/cues', { fetch: fetchImpl, add: (c) => added.push(c), onComplete: (n) => (completeAt = n) });
    await vi.waitFor(() => expect(added.map((c) => c.text)).toEqual(['Line 1']));
    await vi.advanceTimersByTimeAsync(CUE_FEED_POLL_MS);
    expect(asked).toEqual(['/cues?after=0', '/cues?after=1']);
    answers['/cues?after=1'] = json({ cues: [{ start_s: 4, end_s: 6, text: 'Line 2' }], next: 2, complete: true });
    await vi.advanceTimersByTimeAsync(CUE_FEED_POLL_MS);
    expect(added.map((c) => c.text)).toEqual(['Line 1', 'Line 2']);
    expect(completeAt).toBe(2);
    await vi.advanceTimersByTimeAsync(CUE_FEED_POLL_MS * 5);
    expect(asked).toHaveLength(3);
  });

  it('tries again after a failed read, says so once, and stops on a 404 or stop()', async () => {
    vi.useFakeTimers();
    let status = 500;
    const asked: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return json({ error: 'x' }, status);
    }) as typeof fetch;
    const errors: string[] = [];
    followCueFeed('/cues', { fetch: fetchImpl, add: () => {}, onError: (m) => errors.push(m) });
    await vi.advanceTimersByTimeAsync(CUE_FEED_POLL_MS * 2);
    expect(asked).toHaveLength(3);
    expect(errors).toEqual(['http_500']);
    status = 404;
    await vi.advanceTimersByTimeAsync(CUE_FEED_POLL_MS);
    expect(errors).toEqual(['http_500', 'http_404']);
    await vi.advanceTimersByTimeAsync(CUE_FEED_POLL_MS * 3);
    expect(asked).toHaveLength(4);
    const stopped: string[] = [];
    const follower = followCueFeed('/other', { fetch: (async (input: RequestInfo | URL) => { stopped.push(String(input)); return json({ cues: [], next: 0, complete: false }); }) as typeof fetch, add: () => {} });
    await vi.waitFor(() => expect(stopped).toHaveLength(1));
    follower.stop();
    await vi.advanceTimersByTimeAsync(CUE_FEED_POLL_MS * 3);
    expect(stopped).toHaveLength(1);
  });
});
```
**File:** `web/src/stream/controller.test.tsx`: add `CUE_FEED_POLL_MS` to an import from
`./subtitles` (new line `import { CUE_FEED_POLL_MS } from './subtitles';` after line 6) and append:
```ts
describe('a growing subtitle (a cue feed)', () => {
  it('starts the track empty, reads the feed once the track has loaded, adds each cue as it arrives, and stops at complete', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const added: { startTime: number; endTime: number; text: string }[] = [];
    const fakeTrack = { mode: 'disabled', addCue: (cue: { startTime: number; endTime: number; text: string }) => added.push(cue) };
    const had = Object.getOwnPropertyDescriptor(HTMLTrackElement.prototype, 'track');
    Object.defineProperty(HTMLTrackElement.prototype, 'track', { configurable: true, get: () => fakeTrack });
    vi.stubGlobal(
      'VTTCue',
      class {
        constructor(
          public startTime: number,
          public endTime: number,
          public text: string,
        ) {}
      },
    );
    try {
      const FEED = `/api/stream/torrent/${'a'.repeat(40)}/cues/embedded-2`;
      const t = setup({
        [`GET ${S1}`]: () => jsonResponse(streamSessionJson({ manifest_kind: 'mp4', manifest_url: '/api/stream/torrent/x/f/0', subtitles: [sessionTrack(FEED, 'en', 'English', { format: 'cues', growing: true })] })),
        [`GET ${FEED}?after=0`]: () => jsonResponse({ cues: [{ start_s: 1, end_s: 3, text: 'Line 1' }, { start_s: 4, end_s: 6, text: 'Line 2' }], next: 2, complete: false }),
        [`GET ${FEED}?after=2`]: () => jsonResponse({ cues: [{ start_s: 7, end_s: 9, text: 'Line 3' }], next: 3, complete: true }),
      });
      void t.controller.start();
      await vi.waitFor(() => expect(t.made).toHaveLength(1));
      // The track starts as an empty WebVTT file; nothing was fetched for it yet.
      expect(t.texts).toEqual(['WEBVTT\n\n']);
      expect(t.calls.some((c) => c.url.startsWith(FEED))).toBe(false);
      t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
      expect(t.controller.getState().subtitle).toBe('file-0');
      expect(fakeTrack.mode).toBe('hidden');
      t.video.querySelector('track')?.dispatchEvent(new Event('load'));
      await vi.waitFor(() => expect(added.map((c) => c.text)).toEqual(['Line 1', 'Line 2']));
      await vi.advanceTimersByTimeAsync(CUE_FEED_POLL_MS);
      await vi.waitFor(() => expect(added.map((c) => [c.startTime, c.endTime, c.text])).toEqual([[1, 3, 'Line 1'], [4, 6, 'Line 2'], [7, 9, 'Line 3']]));
      await vi.advanceTimersByTimeAsync(CUE_FEED_POLL_MS * 3);
      expect(t.calls.filter((c) => c.url.startsWith(FEED)).map((c) => c.url)).toEqual([`${FEED}?after=0`, `${FEED}?after=2`]);
      expect(t.controller.getState().log).toContain('subtitle English: complete, 3 cues');
    } finally {
      if (had) Object.defineProperty(HTMLTrackElement.prototype, 'track', had);
      else delete (HTMLTrackElement.prototype as { track?: unknown }).track;
      vi.unstubAllGlobals();
    }
  });

  it('parses growing only when the daemon says so', () => {
    const FEED = '/api/stream/torrent/x/cues/embedded-2';
    expect(parseSession(streamSessionJson({ subtitles: [sessionTrack(FEED, 'en', 'English', { format: 'cues', growing: true })] })).subtitles).toEqual([{ url: FEED, lang: 'en', label: 'English', english: true, growing: true }]);
    expect(parseSession(streamSessionJson({ subtitles: [sessionTrack('/x', 'en', 'English', { growing: 'yes' })] })).subtitles).toEqual([{ url: '/x', lang: 'en', label: 'English', english: true }]);
  });
});
```
**Impact:** proves behaviour at the boundaries: the feed's answers, the route's answers, the
process boundary (a fake ffmpeg writing stdout), the real ffmpeg on a real file over HTTP, and
the page's track gaining cues from later reads.

### Step 12: Docs, the generated reference, the feature map, the harness
**File:** `scripts/docs/httpRoutes.ts`: in the group that holds phase 1's
`'GET /api/stream/torrent/:hash/map'` row, add after it:
```ts
      'GET /api/stream/torrent/:hash/cues/:track':
        'A growing subtitle of a torrent session (`track` is `embedded-<file index>-<stream index>`, the English text track inside the file, or `whisper-<file index>`): `{cues: [{start_s, end_s, text}], next, complete}`, the cues after the first `after` (query, default 0, at most 2000 per answer). `text` is WebVTT cue text. The player reads it again from `next` every 4 s until `complete`. Kept on this machine\'s disk beside the torrent, so a replay has it at once. 404 `unknown_feed`; 400 `invalid_query`; 503 `torrent_off`.',
```
In the `'GET /api/stream/sessions/:id'` row (line 226 today), after the sentence that ends
`each track says whether it is \`english\`.`, add:
```text
 A track with `growing: true` (and `format: "cues"`) is a cue feed (`GET /api/stream/torrent/:hash/cues/:track`): its `url` answers JSON cues, read again until the feed is complete.
```
Then run `npm run docs:gen` (rewrites `docs/guide/reference/http-api.md`; never hand-edit it).

**File:** `docs/guide/streaming.md`: under `### Torrents` (phase 1 makes it), after phase 6's
subtitle subsection, add:
```markdown
### The subtitle track inside the file

When the torrent holds no subtitle file, the video file's own English text track is used: SubRip,
ASS/SSA, mov_text or WebVTT, chosen by language (`eng`, `en`), a full track before an SDH one,
SubRip before ASS. A forced track (only the lines spoken in another language) is used only when it
is the file's one English text track. Picture tracks (PGS, VobSub, DVB) are never turned into text:
the daemon log says `no English text subtitle track in <hash> (...)`, and the next tier, the
subtitle service, is asked.

- **It grows as the film downloads.** Subtitle packets are spread through the whole file, so ffmpeg
  can give the cues only as far as the torrent has downloaded. It reads the file from its start
  through the daemon's own file route, which waits for each piece, and every cue it writes goes into
  a cue feed: `GET /api/stream/torrent/<hash>/cues/embedded-<file index>-<stream index>`. The session's subtitle
  carries `growing: true`; the page starts the track empty and reads the feed again every 4 seconds
  from where it stopped, until the feed is `complete`.
- **A seek past what is extracted shows no line** until the extraction gets there. The extraction
  follows the download from the beginning of the file, so after a seek far ahead the lines come back
  once the torrent has filled the file up to there.
- **On disk, beside the torrent.** The feed is `<torrent folder>/notesd-cues/<track>.jsonl`. A file
  already complete on disk is read from its path at full speed, in seconds, and a complete feed is
  used again on a replay without ffmpeg. An extraction that stopped (the torrent was left, the route
  sent nothing for 5 minutes, the daemon restarted) is started over on the next play.
- **Times are the file's own** (`-copyts`): the cues are not moved by the file's start, and G/H
  still move them for the viewer.
- Whisper (the last tier) appends its cues to a feed of the same kind, `whisper`.
```
In `## Where the code is`, add a row:
```markdown
| `src/directStream/torrent/subtitles/embedded.ts`, `feed.ts`, `src/http/streamTorrentCuesApi.ts` | The subtitle track inside a torrent's file: track choice, the ffmpeg extraction, the growing cue feed and its route |
```

**File:** `.claude/skills/verify-notesd/features/direct-streaming.md`: under the torrent section
(phase 1 or 3 makes it; else at the end of `## Sub-features`), add:
```markdown
- The subtitle track inside a torrent's file (torrent-stream-source phase 7): with no subtitle
  file in the torrent, the file's English text track (SubRip, ASS, mov_text, WebVTT) is extracted
  with ffmpeg into a growing cue feed, `GET /api/stream/torrent/<hash>/cues/embedded-<file>-<stream>?after=<i>`
  (`{cues, next, complete}`), and the page reads it every 4 s until complete; picture tracks (PGS,
  VobSub) are skipped and the next tier is asked. Fixtures (MP4 that Chrome plays as is):
  `FX=$(bash .claude/skills/verify-notesd/scripts/stream/make-torrent-sub-fixtures.sh "$HOME/.local/state/notesd-verify/.torrent-sub-fixture")`
  gives `$FX/sub-text.mp4` (English mov_text, cue N "Line N" from 3N-2 s to 3N s) and
  `$FX/sub-picture.mp4` (English VobSub only). Page journey:
  `TORRENT_FIXTURE_FILE="$FX/sub-text.mp4" $V up --web --direct-stream --torrent`, then
  `$V ui RUN .claude/skills/verify-notesd/scripts/stream/embedded-subtitle.steps.mjs`: the transcript
  has `EMBEDDED SESSION PASS`, `EMBEDDED FEED PASS`, `EMBEDDED CAPTION PASS`, `EMBEDDED SEEK PASS`.
  Picture only: `TORRENT_FIXTURE_FILE="$FX/sub-picture.mp4" $V up --direct-stream --torrent`, play
  `{"kind":"movie","tmdb_id":467905,"provider":"torrent"}`: no subtitle has `growing`, the log says
  `no English text subtitle track`, and no `notesd-cues` folder exists. Logic:
  `npx vitest run tests/unit/directStream/torrent web/src/stream/subtitles.test.tsx web/src/stream/controller.test.tsx`
  (the real ffmpeg is in `embedded.ffmpeg.test.ts`).
```

**File:** `.claude/skills/verify-notesd/scripts/stream/make-torrent-sub-fixtures.sh` (new, `chmod +x`), as run while planning:
```bash
#!/usr/bin/env bash
# Two small films for the embedded-subtitle journeys (torrent-stream-source phase 7), both H.264/AAC
# MP4 with the index in front, so Chrome plays them as they are (no remux needed):
#   <out>/sub-text.mp4    an English mov_text track: cue N is "Line N", from 3N-2 s to 3N s (N = 1..20)
#   <out>/sub-picture.mp4 an English dvd_subtitle (VobSub) track only: pictures, no text
# Usage: make-torrent-sub-fixtures.sh OUT_DIR. Prints OUT_DIR. Needs ffmpeg and python3. Idempotent.
set -euo pipefail
OUT=${1:?usage: make-torrent-sub-fixtures.sh OUT_DIR}
mkdir -p "$OUT"
if [[ -s "$OUT/sub-text.mp4" && -s "$OUT/sub-picture.mp4" ]]; then echo "$OUT"; exit 0; fi
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
python3 - "$TMP" <<'PY'
import struct, sys
tmp = sys.argv[1]
def stamp(t): return "00:%02d:%02d,000" % (t // 60, t % 60)
with open(f"{tmp}/en.srt", "w") as f:
    f.write("\n".join(f"{n}\n{stamp(3*n-2)} --> {stamp(3*n)}\nLine {n}\n" for n in range(1, 21)))
# A PGS (.sup) file by hand: every 6 s a 100x20 white box for 3 s. ffmpeg turns it into VobSub below.
def seg(pts, typ, data): return b"PG" + struct.pack(">IIBH", pts, 0, typ, len(data)) + data
W, H, w, h = 320, 240, 100, 20
out = b""
for i, t in enumerate(range(1, 60, 6)):
    pts = t * 90000
    pcs = struct.pack(">HHBHBBBB", W, H, 0x10, 2 * i, 0x80, 0, 0, 1) + struct.pack(">HBBHH", 0, 0, 0, 110, 200)
    wds = struct.pack(">BBHHHH", 1, 0, 110, 200, w, h)
    pds = struct.pack(">BB", 0, 0) + bytes([0, 16, 128, 128, 0, 1, 235, 128, 128, 255])
    rle = bytes([0x00, 0xC0 | (w >> 8), w & 0xFF, 1, 0x00, 0x00]) * h
    ods = struct.pack(">HBB", 0, 0, 0xC0) + (len(rle) + 4).to_bytes(3, "big") + struct.pack(">HH", w, h) + rle
    out += seg(pts, 0x16, pcs) + seg(pts, 0x17, wds) + seg(pts, 0x14, pds) + seg(pts, 0x15, ods) + seg(pts, 0x80, b"")
    end = pts + 3 * 90000
    out += seg(end, 0x16, struct.pack(">HHBHBBBB", W, H, 0x10, 2 * i + 1, 0x00, 0, 0, 0)) + seg(end, 0x17, wds) + seg(end, 0x80, b"")
open(f"{tmp}/pic.sup", "wb").write(out)
PY
ffmpeg -v error -y -f lavfi -i testsrc=size=320x240:rate=25:duration=60 -f lavfi -i sine=duration=60 \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac "$TMP/av.mp4"
ffmpeg -v error -y -i "$TMP/av.mp4" -i "$TMP/en.srt" -map 0:v -map 0:a -map 1:0 -c:v copy -c:a copy -c:s mov_text \
  -metadata:s:s:0 language=eng -movflags +faststart "$OUT/sub-text.mp4"
ffmpeg -v error -y -i "$TMP/av.mp4" -fix_sub_duration -i "$TMP/pic.sup" -map 0:v -map 0:a -map 1:0 -c:v copy -c:a copy -c:s dvdsub \
  -metadata:s:s:0 language=eng -movflags +faststart "$OUT/sub-picture.mp4"
echo "$OUT"
```

**File:** `.claude/skills/verify-notesd/scripts/stream/embedded-subtitle.steps.mjs` (new)
```js
// The English text track inside a torrent's file, shown in the real page as it is extracted
// (torrent-stream-source phase 7, R3.4). Runs on a throwaway daemon seeded with the fixture film:
//   FX=$(bash .claude/skills/verify-notesd/scripts/stream/make-torrent-sub-fixtures.sh "$HOME/.local/state/notesd-verify/.torrent-sub-fixture")
//   TORRENT_FIXTURE_FILE="$FX/sub-text.mp4" verify.sh up --web --direct-stream --torrent
//   verify.sh ui RUN .claude/skills/verify-notesd/scripts/stream/embedded-subtitle.steps.mjs
// Logs "EMBEDDED SESSION PASS", "EMBEDDED FEED PASS", "EMBEDDED CAPTION PASS", "EMBEDDED SEEK PASS";
// the first failed check throws and fails the run. Nothing leaves this machine.
function check(ok, what) {
  if (!ok) throw new Error(what)
}

const captionHas = (needle) => (document.querySelector('[data-testid="caption"]')?.textContent ?? '').includes(needle)

export default async ({ page, base, shot, log }) => {
  const origin = new URL(base).origin
  const feedReads = []
  page.on('request', (r) => {
    if (/\/cues\/embedded-\d+-\d+\?after=\d+$/.test(r.url())) feedReads.push(r.url())
  })

  // Play the fixture title from the torrent, as direct_stream_play with provider "torrent" does.
  const played = await page.request.post(`${base}/api/stream/play`, { headers: { origin }, data: { kind: 'movie', tmdb_id: 467905, provider: 'torrent' } })
  check(played.ok(), `play answered ${played.status()}: ${await played.text()}`)
  const { session } = await played.json()
  log(`session subtitles ${JSON.stringify(session.subtitles)}`)
  const growing = (session.subtitles ?? []).filter((s) => s.growing === true)
  check(
    growing.length === 1 && /^\/api\/stream\/torrent\/[0-9a-f]{40}\/cues\/embedded-0-2$/.test(growing[0].url) && growing[0].lang === 'en' && growing[0].format === 'cues' && growing[0].english === true,
    'the session names one growing English subtitle: the cue feed of file 0, stream 2',
  )
  log('EMBEDDED SESSION PASS')

  // The feed fills as ffmpeg reads the file, and ends complete with the fixture's 20 cues at the file's own times.
  let feed = null
  for (let i = 0; i < 120; i++) {
    const res = await page.request.get(`${base}${growing[0].url}?after=0`)
    check(res.ok(), `the feed answered ${res.status()}`)
    feed = await res.json()
    if (feed.complete) break
    await page.waitForTimeout(500)
  }
  log(`feed ${JSON.stringify(feed).slice(0, 300)}`)
  check(feed?.complete === true && feed.cues.length === 20 && feed.next === 20, 'the feed completes with 20 cues')
  check(JSON.stringify(feed.cues[0]) === JSON.stringify({ start_s: 1, end_s: 3, text: 'Line 1' }), 'the first cue is Line 1 from 1 s to 3 s')
  check(feed.cues[16].text === 'Line 17' && feed.cues[16].start_s === 49 && feed.cues[16].end_s === 51, 'cue 17 is Line 17 from 49 s to 51 s')
  log('EMBEDDED FEED PASS')

  // The page shows the lines over the picture, English on by default.
  await page.goto(`${base}/stream/${session.session_id}`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 30_000 })
  await page.waitForFunction(captionHas, 'Line ', { timeout: 20_000 })
  await shot('embedded-caption')
  const state = await page.evaluate(() => ({ subtitle: window.notesdStream.subtitle, hidden: [...document.querySelector('video').textTracks].filter((t) => t.mode === 'hidden').map((t) => [t.language, t.cues?.length ?? 0]) }))
  log(`page ${JSON.stringify(state)} feed reads ${feedReads.join(' ')}`)
  check(state.subtitle !== null, 'an English subtitle is on by default')
  check(state.hidden.length === 1 && state.hidden[0][0] === 'en' && state.hidden[0][1] === 20, 'the one running track is English and holds the 20 cues read from the feed')
  check(feedReads.length >= 1 && feedReads[0].endsWith('?after=0'), 'the page read the feed from the start')
  log('EMBEDDED CAPTION PASS')

  // A line far into the film, after a seek.
  await page.evaluate(() => {
    const v = document.querySelector('video')
    v.pause()
    v.currentTime = 49.5
  })
  await page.waitForFunction(captionHas, 'Line 17', { timeout: 10_000 })
  await shot('embedded-seek')
  log('EMBEDDED SEEK PASS')
}
```
**Impact:** `npm test` (the docs reference test) stays green once `docs:gen` ran and the
configuration row exists (Step 3, when it applies). No UI picture changes (the page looks the
same; only where its cues come from changed), so no `docs:shots`.

## Principles applied

- Laziness protocol: one route only. A complete feed is read once with `after=0`, so there is no second WebVTT route, and the page follows every feed track the same way. No `stop()` / `close()` API with no caller: an extraction ends by itself at the end of the file, when the route fails (the torrent left), or after 300 s without a byte (`-rw_timeout`). An incomplete feed starts over on the next play. Nothing is added to `StreamApp.tsx`.
- Make illegal states unrepresentable: `growing?: true` (a literal, not a boolean) on `CacheSubtitleView` and both `SessionSubtitle`s, so `growing: false` cannot be written and an absent field is the one way to say "a file". The server's `format` is derived from it in one function (`localSubtitle`), never set on its own.
- Boundary discipline: the feed name and `after` are checked once, in the route. Cues are cleaned once, in `CueFeed.append`, where both producers (ffmpeg now, Whisper in phase 8) enter. The page checks a feed answer once, in `parseCueFeed`. The probe's tracks are filtered by one codec allow-list in `chooseEmbeddedTrack`; picture codecs never reach ffmpeg.
- Prove it works: the ffmpeg command was run against the installed 6.1.1 while planning (progressive output, `-copyts`, ASS, mov_text, picture refusal; see "What was checked"). The proof drives a real torrent session in the real page with fixture films that Chrome plays as they are, including a real VobSub track built from a hand-written PGS file.
- Test behavior, not implementation: tests cut at the process boundary (a fake ffmpeg that writes stdout and exits) and the HTTP boundary (the route, a throttled server), and assert what a caller sees: feed contents, route answers, cues added to the page's track. One test runs the real ffmpeg.

## Verification

**Build:** `npm run typecheck && npm run build`
**Tests:** `npm test` (includes `tests/unit/directStream/torrent/**`, `web/src/stream/subtitles.test.tsx`, `web/src/stream/controller.test.tsx`, and the docs reference test after `npm run docs:gen`)
**Proof:** the real daemon plays a torrent whose video file carries an English mov_text track and no subtitle file: the session names a growing English subtitle, its feed fills to the fixture's 20 cues with the file's own times, and the real page shows them over the picture. A file whose only subtitle is VobSub gets no feed, and the next tier is asked.
- Harness: `.claude/skills/verify-notesd` (`verify.sh up --web --direct-stream --torrent`, `api`, `ui`), plus phase 1's `--torrent` loopback seeder with `TORRENT_FIXTURE_FILE`
- Feature-map entries: `.claude/skills/verify-notesd/features/direct-streaming.md` (the torrent section, the embedded-track bullet added in Step 12)
- Fixtures, once: `FX=$(bash .claude/skills/verify-notesd/scripts/stream/make-torrent-sub-fixtures.sh "$HOME/.local/state/notesd-verify/.torrent-sub-fixture")`; `V=.claude/skills/verify-notesd/scripts/verify.sh`
- Journeys:
  - **J1** · traces R3.4 — `TORRENT_FIXTURE_FILE="$FX/sub-text.mp4" $V up --web --direct-stream --torrent` (note `RUN=`), then `$V ui $RUN .claude/skills/verify-notesd/scripts/stream/embedded-subtitle.steps.mjs`, then `$V down $RUN` → passes when the ui transcript holds `EMBEDDED SESSION PASS` (the play's session has exactly one subtitle with `growing: true`, `format: "cues"`, `lang: "en"`, url `/api/stream/torrent/<40 hex>/cues/embedded-0-2`), `EMBEDDED FEED PASS` (the feed ends `complete: true` with 20 cues, the first `{"start_s":1,"end_s":3,"text":"Line 1"}`, the 17th `Line 17` from 49 to 51), `EMBEDDED CAPTION PASS` (the page's caption layer shows `Line ...`, the one hidden track is `en` with 20 cues, the page's first feed read was `?after=0`) and `EMBEDDED SEEK PASS` (after a seek to 49.5 s the caption reads `Line 17`), with screenshots `embedded-caption` and `embedded-seek`
  - **J2** · traces R3.4 — `npx vitest run tests/unit/directStream/torrent/subtitles/embedded.ffmpeg.test.ts` → passes when both tests pass and none is skipped (ffmpeg is installed): the real ffmpeg reads a 60 s MKV over a throttled HTTP server, the feed holds 10 or more cues at the moment the server writes the file's last chunk (the cues arrive as the file arrives), and ends complete with 20 cues whose first is `{start_s: 1, end_s: 3, text: "<i>Line 1</i>"}` (`-copyts`, not 1.023); the ASS track comes out as `<i>Styled</i> line\nsecond row`
  - **J3** · traces R3.4 — `npx vitest run web/src/stream/subtitles.test.tsx web/src/stream/controller.test.tsx -t "growing|followCueFeed|parseCueFeed"` → passes when the tests pass: a track that starts empty gains `Line 1`, `Line 2` from the first read and `Line 3` from a read 4 s later, the reads are exactly `?after=0` then `?after=2`, and reading stops at `complete`
  - **J4** · traces R3.5 — `TORRENT_FIXTURE_FILE="$FX/sub-picture.mp4" $V up --direct-stream --torrent` (note `RUN=` and `LOG=`), `$V api $RUN POST /api/stream/play '{"kind":"movie","tmdb_id":467905,"provider":"torrent"}'`, `grep -c 'no English text subtitle track in .* (dvd_subtitle/eng); the next subtitle tier is asked' "$LOG"`, `find "$HOME/.local/state/notesd-verify/$RUN/data" -type d -name notesd-cues | wc -l`, `$V down $RUN` → passes when the play answers 200 and its `session.subtitles` has no entry with `growing` and no url containing `/cues/`, the grep counts 1 or more, and the find counts 0 (no ffmpeg extraction was started)
  - **J5** · traces R3.5 — `npx vitest run tests/unit/directStream/torrent/subtitles/embedded.test.ts -t "picture"` → passes when the two picture tests pass: no picture codec (`hdmv_pgs_subtitle`, `dvd_subtitle`, `dvb_subtitle`) is ever chosen even when English, and the tier answers `[]` for picture tracks only, spawns no ffmpeg and logs the line J4 greps
- Neighbor check: a separate subtitle file still loads as before (the changed `loadFileSubtitles`). `npx vitest run web/src/stream` passes, and on a fresh fixture `FIX=$(bash .claude/skills/verify-notesd/scripts/stream/make-hls-fixture.sh "$HOME/.local/state/notesd-verify/.stream-fixture")`, `$V up --web`, `STREAM_FIXTURE="$FIX" $V ui RUN .claude/skills/verify-notesd/scripts/stream/player.steps.mjs` still logs `J1 PASS` and `J2 PASS` (`.srt` as WebVTT, English shown)
- Cost: none billed (no model call; ffmpeg and the loopback swarm only)

**Exit criteria:** on a throwaway daemon, a torrent whose file carries an English text track and no subtitle file plays with that track's cues on screen, read from a feed that grows as ffmpeg extracts and ends complete; a file with picture tracks only gets no feed and the chain asks the next tier; `npm run typecheck` and `npm test` pass.

## Handoffs

- **Phase 1:** `verify.sh up --torrent` takes `TORRENT_FIXTURE_FILE=<path>` (seed that file in place of the generated film; J1 and J4 use it). Clearing a download (`keepDays`) removes the whole `<NOTESD_TORRENT_DIR>/<info hash>/` folder, which holds `notesd-cues/`; leaving the swarm keeps it. Once the torrent has left the swarm the file route answers 409 `not_in_swarm` and never rejoins, so a running extraction ends there (unfinished: the next play starts it over); a file whole on disk is read from its path instead.
- **Phase 3 (reconciled):** the tier reads phase 3's `SubtitleContext` (`infoHash`, `fileIndex`, `probe`); phase 3's probe carries `title`, `forced`, `hearingImpaired`. The torrent branch of `sessionInfo` maps subtitles with `localSubtitle` (Step 6). A cue-feed view must not be copied into `session.source.subtitles`: `subtitleText` (the dialogue, `service.ts:495`) fetches those as files and would get JSON.
- **Phase 4 (reconciled):** this phase depends on phase 4 and edits `web/src/stream/session.ts` (Step 9: one field, one line) and `controller.ts` (Step 10: imports, `FileTrack.follower`, `loadFileSubtitles`, `followGrowing`, `clearFileTracks`) as phase 4 leaves them. Nothing in `StreamApp.tsx`, `nativeEngine.ts` or `stream.css`.
- **Phase 5:** `config.torrent.ffmpegBin` is phase 3's. A remuxed session's player and this extraction read the same file at the same time; the extraction reads from the start, so after a seek far ahead the torrent downloads two places at once.
- **Phase 6:** the `embedded` tier goes at phase 3's `// Phase 7` comment, between phase 6's `files` and `service`. Phase 6's tiers are untouched.
- **Phase 8:** append to `CueFeeds.start(infoHash, whisperTrackId(fileIndex))` (or carry on with `CueFeeds.get` of a feed that is not complete) with `append(cues)` and `complete()`, and answer `{ url: cueFeedUrl(infoHash, whisperTrackId(fileIndex)), lang: 'en', label, growing: true }` from its tier. Appends may come out of time order: reads go by count and the page's TextTrack orders cues itself. The route, the page following, and `growing` through `SessionInfo` need nothing more. Cues are `{start_s, end_s, text}`; `append` drops empty or zero-length ones. The daemon local is `torrentCues`.
- **Reconciler:** the `torrent_off` 503 body is defined locally in `streamTorrentCuesApi.ts` with phase 1's text; the `GET /api/stream/sessions/:id` row in `scripts/docs/httpRoutes.ts` is edited by phase 3 first, then by this phase (append one sentence).

## Rollback

Revert this phase's merge. Nothing in the database changes. Files left on disk are only
`<NOTESD_TORRENT_DIR>/<hash>/notesd-cues/*.jsonl`, which nothing reads after the revert and which go
with the torrent folder when it is cleared. Without reverting, removing the `embeddedTier(...)`
entry from the chain in `src/daemon.ts` turns the tier off: the session gets no growing track,
and the page code only acts on a track marked `growing`.
