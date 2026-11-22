import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isAssDrawing, stripAssComments } from './assDrawing.js';

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

/**
 * A cue worth keeping, its times to the millisecond and its line ends LF; null for one with no text or no length, and
 * for an ASS drawing. A brace block is never text (assDrawing.ts) and is taken out. A feed kept on disk is read through
 * here too, so one written with drawings or brace blocks in it is shown without them.
 */
export function cleanCue(cue: FeedCue): FeedCue | null {
  const text = stripAssComments(cue.text.replace(/\r\n?/g, '\n'));
  if (text.replace(/<[^>]*>/g, '').trim() === '' || isAssDrawing(text) || !Number.isFinite(cue.start_s) || !Number.isFinite(cue.end_s)) return null;
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
