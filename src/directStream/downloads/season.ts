import { randomUUID } from 'node:crypto';
import type { StreamDownloadRow } from '../../db/schema.js';
import type { PackFetch, PackHold, PackOptions, TorrentSource } from '../torrent/source.js';
import type { TorrentStreams } from '../torrent/service.js';
import { refLabel, type StreamRef } from '../types.js';
import type { DownloadRecords } from './repo.js';
import type { DownloadFacts, DownloadVia } from './types.js';
import { noPeersAtAll } from '../torrentWarp.js';
import type { WarpHold, WarpRounds } from './warp.js';

/**
 * Season downloads (the season row's Download button, R2). A season asks for every aired episode of it that this
 * machine does not hold whole: one `stream_downloads` row each, under one batch, queued at once. When the queue reaches
 * the first of them (one torrent download at a time, StreamDownloads' runner), the batch's season pack is looked for
 * once (TorrentSource.fetchPack): with one, a single swarm carries every episode it holds, one `stream_torrents` row
 * and one hold each, kept by the owner's mark, and each row is done when its file is whole. Episodes the pack lacks,
 * or all of them when no pack fits, go through the per-episode path in episode order. Nothing starts unasked: only the
 * episodes the owner's click named, never one that has not aired.
 */

/** How often a season pack's episodes are looked at (whole yet, cancelled, the swarm still sending). */
export const PACK_POLL_MS = 30_000;
/** A season pack whose swarm sent nothing for this long fails what it still carries. */
export const PACK_STALL_MS = 2 * 3_600_000;
/** A whole pack episode is ready to play from disk once the torrents' tick settled it: looked for this many times, PACK_POLL_MS apart. */
export const FINISH_READY_TRIES = 10;
/** Its remux and subtitle search are waited for at most this many looks, PACK_POLL_MS apart (an hour). */
export const FINISH_MAX_POLLS = 120;

export type TvRef = Extract<StreamRef, { kind: 'tv' }>;

/** One episode of a season as the title's stored metadata lists it; `airDate` is TMDB's day (`2026-10-08`) or null. */
export interface SeasonEpisode {
  episode: number;
  airDate: string | null;
}

/** An episode a season download left out, and why: it airs later, no day is known for it, or it is whole here already. */
export interface SeasonLeftOut {
  episode: number;
  why: 'not_aired' | 'no_air_date' | 'whole';
}

/** What StreamDownloads.requestSeason answers. `queued` holds what `request` answered per episode, in episode order. */
export type SeasonAnswer<R> =
  | { ok: true; batch: string | null; queued: R[]; left_out: SeasonLeftOut[] }
  | { ok: false; error: 'unknown_season' | 'seasons_off'; detail: string };

/** A `stream_downloads` row of an episode, as a season download reads it. */
export interface SeasonRow {
  id: string;
  ref: TvRef;
  via: DownloadVia;
  /** A torrent the owner picked by hand: such a row is never carried by a pack. */
  infoHash: string | null;
  batch: string | null;
  /** The torrent the row was downloading from (a pack, before a restart); null when none yet. */
  sourceId: string | null;
}

/** What a season download writes and reads of its rows (DownloadsRepo through `seasonRowsOf`). */
export interface SeasonRows {
  /** This host's rows of `batch` still to download (queued, running or paused), in episode order. */
  open(batch: string): Promise<SeasonRow[]>;
  /** True while the row is still to download: a cancel, or anything else that ended it, says false. */
  wanted(id: string): Promise<boolean>;
  /** The row downloads from the pack now: running, the pack's info hash its source. */
  running(id: string, infoHash: string): Promise<void>;
  /** A torrent plays on screen: the row waits, the pack still its source (the next take opens it again by its hash). */
  paused(id: string): Promise<void>;
  done(id: string, infoHash: string, bytes: { done: number; total: number } | null): Promise<void>;
  failed(id: string, code: 'download_failed', detail: string): Promise<void>;
}

/** The torrents as a season pack uses them (TorrentStreams with phase 2's owner's mark, through `packSwarmOf`). */
export interface PackSwarm {
  /** True once the file is whole on this machine (its file, or its remux alone). */
  whole(infoHash: string, fileIndex: number): Promise<boolean>;
  /** The file's bytes on disk now and its length; null when this machine has no such file. */
  bytes(infoHash: string, fileIndex: number): Promise<{ done: number; total: number } | null>;
  /** Bytes the torrent received from peers since it was opened; null when it cannot say. */
  received(infoHash: string): number | null;
  /** Gives back one episode's hold; with none left the torrent leaves the swarm when it is finished. */
  release(infoHash: string): Promise<void>;
  /** One episode's own files stop downloading and its hold is given back (TorrentStreams.releaseSlot). */
  releaseSlot(infoHash: string, ref: StreamRef): Promise<void>;
  /** The owner's mark on every row of the torrent: the age prune and the budget skip it. */
  keep(infoHash: string): Promise<void>;
}

/** TorrentSource.fetchPack, with the title's language, IMDb id and names filled in by the wiring. */
export interface SeasonPacks {
  fetch(tmdbId: number, season: number, episodes: readonly number[], options: Pick<PackOptions, 'heights' | 'known'>): Promise<PackFetch>;
}

export interface SeasonDownloadsDeps<R> {
  /** The season's episodes as the title's stored metadata lists them; null when the series is not stored and cannot be. */
  episodes(tmdbId: number, season: number): Promise<SeasonEpisode[] | null>;
  /** True when this machine holds the episode whole (a finished torrent download, a ready cache). */
  whole(ref: TvRef): Promise<boolean>;
  /** StreamDownloads.request: one row for the episode, answered at once (the existing one when it is still to download). */
  request(ref: TvRef, options: { via: DownloadVia; batch: string }): Promise<R>;
  rows: SeasonRows;
  /** Null: torrents off; every row of a season downloads on its own. */
  packs: SeasonPacks | null;
  swarm: PackSwarm | null;
  /**
   * The office network's WARP round (downloads/warp.ts): a pack whose every swarm sent no file list is looked for once
   * more with WARP on, and the job holds WARP until it is done. Null or unset: no round (NOTESD_STREAM_WARP=off, tests).
   */
  warp?: WarpRounds | null;
  /** What a torrent download does once a file is whole (the remux to its end, the subtitle: finishFromDisk); absent: nothing more. */
  finish?(ref: TvRef): Promise<void>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  newBatch?: () => string;
  log?: (line: string) => void;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const pad = (n: number): string => String(n).padStart(2, '0');
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const OPEN_STATES: ReadonlySet<string> = new Set(['queued', 'running', 'paused']);

const tvRef = (tmdbId: number, season: number, episode: number): TvRef => ({ kind: 'tv', tmdbId, season, episode });

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/**
 * The episodes of a season a download takes: aired on or before `today` (TMDB's day, as `refuseUnreleased` reads it).
 * One that airs later, or whose day TMDB does not give, is left out: nothing is asked for an episode that may not exist yet.
 */
export function airedEpisodes(list: readonly SeasonEpisode[], today: string): { aired: number[]; leftOut: SeasonLeftOut[] } {
  const aired: number[] = [];
  const leftOut: SeasonLeftOut[] = [];
  for (const e of [...list].sort((a, b) => a.episode - b.episode)) {
    if (e.airDate === null || !DAY.test(e.airDate)) leftOut.push({ episode: e.episode, why: 'no_air_date' });
    else if (e.airDate > today) leftOut.push({ episode: e.episode, why: 'not_aired' });
    else aired.push(e.episode);
  }
  return { aired, leftOut };
}

/** A `stream_downloads` row as a season download reads it; null for a film's. */
export function seasonRowOf(r: StreamDownloadRow): SeasonRow | null {
  if (r.kind !== 'tv') return null;
  return {
    id: r.id,
    ref: tvRef(r.tmdbId, r.season, r.episode),
    via: r.via,
    infoHash: r.infoHash,
    batch: r.batch,
    sourceId: r.source === 'torrent' ? r.sourceId : null,
  };
}

/** SeasonRows over phase 1's DownloadsRepo (through phase 2's DownloadRecords), the only writer of `stream_downloads`. */
export function seasonRowsOf(
  repo: Pick<DownloadRecords, 'list' | 'get' | 'setState' | 'on' | 'done' | 'failed'>,
  host: string,
  now: () => Date,
): SeasonRows {
  return {
    open: async (batch) =>
      (await repo.list(host, { states: ['queued', 'running', 'paused'] }))
        .filter((r) => r.batch === batch)
        .flatMap((r) => {
          const row = seasonRowOf(r);
          return row === null ? [] : [row];
        })
        .sort((a, b) => a.ref.episode - b.ref.episode),
    wanted: async (id) => {
      const row = await repo.get(host, id);
      return row !== null && OPEN_STATES.has(row.state);
    },
    running: async (id, infoHash) => {
      await repo.on(host, id, { source: 'torrent', infoHash }, now());
      await repo.setState(host, id, 'running', now());
    },
    paused: async (id) => {
      await repo.setState(host, id, 'paused', now());
    },
    done: async (id, infoHash, bytes) => {
      await repo.done(host, id, { source: 'torrent', infoHash }, { bytesDone: bytes?.done ?? 0, bytesTotal: bytes?.total ?? null }, now());
    },
    failed: async (id, code, detail) => {
      await repo.failed(host, id, code, detail, now());
    },
  };
}

/** PackSwarm over TorrentStreams, with phase 2's owner's mark (`keep(hash, true)`). */
export function packSwarmOf(torrents: Pick<TorrentStreams, 'filePath' | 'remuxOnly' | 'onDisk' | 'received' | 'release' | 'releaseSlot' | 'keep'>): PackSwarm {
  return {
    whole: async (infoHash, fileIndex) => (await torrents.filePath(infoHash, fileIndex)) !== null || (await torrents.remuxOnly(infoHash, fileIndex)),
    bytes: async (infoHash, fileIndex) => {
      const disk = await torrents.onDisk(infoHash, fileIndex);
      if (disk === null) return null;
      const done = disk.kind === 'whole' ? disk.length : disk.ranges.reduce((n, [from, to]) => n + (to - from), 0);
      return { done, total: disk.length };
    },
    received: (infoHash) => torrents.received(infoHash),
    release: (infoHash) => torrents.release(infoHash),
    releaseSlot: (infoHash, ref) => torrents.releaseSlot(infoHash, ref),
    keep: (infoHash) => torrents.keep(infoHash, true),
  };
}

/**
 * A pack episode made ready to play offline (R1.8), as a play from disk makes it: TorrentSource.fromDisk starts its
 * remux (a file Chrome cannot play as is) and its subtitle chain on the whole file, and this waits until both are done,
 * then lets the session torrent go (it joined no swarm). fromDisk finds the episode once the torrents' tick settled it
 * ready; until then it is looked for again, FINISH_READY_TRIES times. Nothing found: a later play makes it ready itself.
 * Never throws.
 */
export function finishFromDisk(
  source: () => Pick<TorrentSource, 'fromDisk' | 'keptState' | 'release'> | null,
  facts: (ref: StreamRef) => Promise<Pick<DownloadFacts, 'audioLang'>>,
  options: { sleep?: (ms: number) => Promise<void>; pollMs?: number; log?: (line: string) => void } = {},
): (ref: TvRef) => Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  const pollMs = options.pollMs ?? PACK_POLL_MS;
  const log = options.log ?? ((line: string) => console.log(line));
  return async (ref) => {
    try {
      const s = source();
      if (s === null) return;
      const audioLang = (await facts(ref)).audioLang ?? null;
      let out: Awaited<ReturnType<TorrentSource['fromDisk']>> = null;
      for (let i = 0; i < FINISH_READY_TRIES && out === null; i += 1) {
        out = await s.fromDisk(ref, { audioLang });
        if (out === null) await sleep(pollMs);
      }
      if (out === null) {
        log(`[notesd] downloads: ${refLabel(ref)} is whole, but not yet readable from disk; a play makes it ready`);
        return;
      }
      try {
        for (let i = 0; i < FINISH_MAX_POLLS; i += 1) {
          const now = await s.keptState(out.torrent);
          if (now.remux !== 'running' && now.subtitles === 'done') return;
          await sleep(pollMs);
        }
      } finally {
        s.release(out.torrent);
      }
    } catch (err) {
      log(`[notesd] downloads: ${refLabel(ref)}: could not make it ready to play offline: ${messageOf(err)}`);
    }
  };
}

export class SeasonDownloads<R> {
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly newBatch: () => string;
  /** The batches whose pack was looked for in this daemon run: the rows left over download on their own. */
  private readonly looked = new Set<string>();

  constructor(private readonly deps: SeasonDownloadsDeps<R>) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? ((line: string) => console.log(line));
    this.sleep = deps.sleep ?? defaultSleep;
    this.newBatch = deps.newBatch ?? (() => randomUUID());
  }

  /**
   * The season row's Download: every aired episode of the season not whole on this machine gets its row, in episode
   * order, under one new batch; answered at once (nothing is fetched here). `unknown_season` when the stored title
   * lists no episode of the season.
   */
  async request(tmdbId: number, season: number, options: { via: DownloadVia }): Promise<SeasonAnswer<R>> {
    const list = await this.deps.episodes(tmdbId, season);
    if (list === null || list.length === 0) {
      return { ok: false, error: 'unknown_season', detail: `TMDB tv ${tmdbId} lists no episode of season ${season}.` };
    }
    const { aired, leftOut } = airedEpisodes(list, this.now().toISOString().slice(0, 10));
    const wanted: number[] = [];
    for (const episode of aired) {
      if (await this.deps.whole(tvRef(tmdbId, season, episode))) leftOut.push({ episode, why: 'whole' });
      else wanted.push(episode);
    }
    leftOut.sort((a, b) => a.episode - b.episode);
    const left = leftOut.length === 0 ? '' : `; left out ${leftOut.map((l) => `E${pad(l.episode)} (${l.why.replace(/_/g, ' ')})`).join(', ')}`;
    if (wanted.length === 0) {
      this.log(`[notesd] downloads: season ${season} of TMDB tv ${tmdbId}: nothing to download${left}`);
      return { ok: true, batch: null, queued: [], left_out: leftOut };
    }
    const batch = this.newBatch();
    const queued: R[] = [];
    for (const episode of wanted) queued.push(await this.deps.request(tvRef(tmdbId, season, episode), { via: options.via, batch }));
    this.log(`[notesd] downloads: season ${season} of TMDB tv ${tmdbId}: ${wanted.length} episode(s) queued (${options.via})${left}`);
    return { ok: true, batch, queued, left_out: leftOut };
  }

  /**
   * The queue reached `row` (phase 2's `run`, before its own steps). For the first row of a batch asked `auto` or
   * `torrent` the queue reaches, the batch's season pack is looked for, on every network. On the office network, a
   * pack search whose every swarm sent no file list is asked once more through Cloudflare WARP, and the job holds WARP
   * while it downloads. With a pack, the answer is the job that downloads every row it holds. The queue keeps it as its
   * one torrent job, lets it go while a torrent plays, and cancels one of its rows through it. A batch is looked at
   * once per daemon run, except when two or more of its rows still name one torrent as their source (a pack that
   * carried them before a pause or a restart). That pack is opened again by its info hash, with no index asked. Null:
   * the row downloads on its own (a film, a cloud download, a torrent picked by hand, no pack, a batch already looked
   * at).
   */
  async take(row: SeasonRow): Promise<SeasonPackJob | null> {
    const { packs, swarm } = this.deps;
    if (row.batch === null || row.via === 'cloud' || row.infoHash !== null || packs === null || swarm === null) return null;
    const open: SeasonRow[] = [];
    for (const r of await this.deps.rows.open(row.batch)) {
      if (r.via !== row.via || r.infoHash !== null || r.ref.tmdbId !== row.ref.tmdbId || r.ref.season !== row.ref.season) continue;
      // Whole meanwhile (played to the end, fetched ahead): the per-episode path finds it on disk and ends the row.
      if (await this.deps.whole(r.ref)) continue;
      open.push(r);
    }
    if (open.length === 0) return null;
    // A torrent two or more of the batch's rows still name: the pack that carried them before a pause or a restart.
    const named = new Map<string, number>();
    for (const r of open) if (r.sourceId !== null) named.set(r.sourceId, (named.get(r.sourceId) ?? 0) + 1);
    const shared = [...named].find(([, n]) => n >= 2)?.[0] ?? null;
    if (this.looked.has(row.batch) && shared === null) return null;
    this.looked.add(row.batch);
    const label = `season ${row.ref.season} of TMDB tv ${row.ref.tmdbId}`;
    const known = shared ?? open.find((r) => r.sourceId !== null)?.sourceId ?? null;
    const ask = (): Promise<PackFetch> =>
      packs.fetch(
        row.ref.tmdbId,
        row.ref.season,
        open.map((r) => r.ref.episode),
        { heights: row.via === 'auto' ? 'preferred' : 'any', known },
      );
    const first = await ask();
    const round = this.deps.warp == null ? null : await this.deps.warp.round(label, first, !first.ok && noPeersAtAll(first.attempts), ask);
    const fetched = round?.out ?? first;
    const hold: WarpHold | null = round?.hold ?? null;
    if (!fetched.ok) {
      this.log(`[notesd] downloads: ${label}: no season pack${round?.note == null ? '' : ` (${round.note})`}; ${open.length} episode(s) download one by one`);
      return null;
    }
    const pack = fetched.pack;
    const carried = pack.episodes.flatMap((e) => {
      const r = open.find((x) => x.ref.episode === e.episode);
      return r === undefined ? [] : [{ row: r, video: e.video }];
    });
    try {
      await swarm.keep(pack.infoHash);
      for (const c of carried) await this.deps.rows.running(c.row.id, pack.infoHash);
    } catch (err) {
      // fetchPack took one hold per episode it holds: every one is given back, and WARP with them.
      for (let i = 0; i < pack.episodes.length; i += 1) await swarm.release(pack.infoHash).catch(() => undefined);
      await hold?.release();
      this.log(`[notesd] downloads: ${label}: the season pack ${pack.name} could not be recorded (${messageOf(err)}); each episode downloads on its own`);
      return null;
    }
    this.log(`[notesd] downloads: ${label}: ${carried.length} episode(s) from the season pack ${pack.name}${hold === null ? '' : ' through Cloudflare WARP'}${pack.lacking.length === 0 ? '' : `; ${pack.lacking.map((e) => `E${pad(e)}`).join(', ')} on their own`}`);
    return new SeasonPackJob({
      pack,
      carried,
      rows: this.deps.rows,
      swarm,
      warp: hold,
      ...(this.deps.finish === undefined ? {} : { finish: this.deps.finish }),
      now: () => this.now().getTime(),
      sleep: this.sleep,
      pollMs: PACK_POLL_MS,
      stallMs: PACK_STALL_MS,
      log: this.log,
    });
  }
}

interface Carried {
  row: SeasonRow;
  video: number;
}

export interface SeasonPackJobParts {
  pack: PackHold;
  carried: Carried[];
  rows: SeasonRows;
  swarm: PackSwarm;
  /** The WARP this pack went ahead through (downloads/warp.ts), let go when the job ends; null: none. */
  warp?: WarpHold | null;
  finish?: (ref: TvRef) => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollMs: number;
  stallMs: number;
  log: (line: string) => void;
}

/**
 * One season pack downloading several rows at once: the queue's one torrent job while it runs. Each episode is done
 * on its own when its file is whole (its hold given back, then the offline step); a cancelled one stops alone; a swarm
 * that sends nothing for `stallMs` fails what is left. A torrent on screen (`pause`) or the daemon stopping (`close`)
 * lets go of every hold at once. `done` settles when no row is left or it was let go; it never rejects.
 */
export class SeasonPackJob {
  readonly infoHash: string;
  readonly rowIds: readonly string[];
  readonly done: Promise<void>;
  private readonly finished = new Set<string>();
  private readonly dropped = new Set<string>();
  private stopped = false;
  /** The daemon stops: the WARP this pack holds is left as it is. */
  private closing = false;
  private lastGrowthAt: number;
  private lastReceived: number | null;

  constructor(private readonly p: SeasonPackJobParts) {
    this.infoHash = p.pack.infoHash;
    this.rowIds = p.carried.map((c) => c.row.id);
    this.lastGrowthAt = p.now();
    this.lastReceived = p.swarm.received(this.infoHash);
    this.done = this.run();
  }

  /**
   * A torrent plays on screen (phase 2's play first): the pack lets go of its swarm and every row it still carries waits
   * `paused`, the pack still its source. The WARP it held is let go at once (it stays on while that play may play
   * through it). When the play ends the queue reaches them again and `take` opens the same pack by its info hash.
   */
  async pause(): Promise<void> {
    const left = this.letGo();
    await this.p.warp?.release();
    for (const c of left) await this.p.rows.paused(c.row.id);
  }

  /**
   * The daemon stops: every hold is let go; the rows stay running, and the next start carries them on from disk.
   * WARP is left as it is, as a torrent play's is at a stop.
   */
  async close(): Promise<void> {
    this.closing = true;
    this.letGo();
  }

  /** Stops one row of the pack (its own files, its hold); the row's state is the canceller's to write. False when the job does not carry it. */
  async cancel(rowId: string): Promise<boolean> {
    const c = this.pending().find((x) => x.row.id === rowId);
    if (c === undefined) return false;
    await this.drop(c);
    return true;
  }

  /** A carried row's bytes on disk and its file's length, for the downloads list; null when the job does not carry it. */
  async progress(rowId: string): Promise<{ done: number; total: number } | null> {
    const c = this.p.carried.find((x) => x.row.id === rowId);
    return c === undefined ? null : this.p.swarm.bytes(this.infoHash, c.video);
  }

  private pending(): Carried[] {
    return this.p.carried.filter((c) => !this.finished.has(c.row.id) && !this.dropped.has(c.row.id));
  }

  /** Every hold still taken is given back (with none left the torrent leaves the swarm); answers the rows it carried. */
  private letGo(): Carried[] {
    if (this.stopped) return [];
    this.stopped = true;
    const left = this.pending();
    for (const c of left) {
      this.dropped.add(c.row.id);
      void this.p.swarm.release(this.infoHash).catch(() => undefined);
    }
    return left;
  }

  private async run(): Promise<void> {
    try {
      for (;;) {
        if (this.stopped) return;
        await this.look();
        if (this.stopped || this.pending().length === 0) return;
        await this.p.sleep(this.p.pollMs);
      }
    } catch (err) {
      await this.failRest(`the season pack ${this.p.pack.name} stopped: ${messageOf(err)}`);
    } finally {
      // Done, failed, cancelled or paused: the WARP this pack held is let go (back off unless a play or another holder
      // keeps it). A daemon stop leaves it as it is.
      if (!this.closing) await this.p.warp?.release();
    }
  }

  private async look(): Promise<void> {
    for (const c of this.pending()) {
      if (this.stopped) return;
      if (!(await this.p.rows.wanted(c.row.id))) {
        await this.drop(c);
        continue;
      }
      if (!(await this.p.swarm.whole(this.infoHash, c.video))) continue;
      this.finished.add(c.row.id);
      await this.p.rows.done(c.row.id, this.infoHash, await this.p.swarm.bytes(this.infoHash, c.video));
      this.p.log(`[notesd] downloads: ${refLabel(c.row.ref)} is on disk from the season pack ${this.p.pack.name}`);
      await this.p.swarm.release(this.infoHash);
      // The offline step (finishFromDisk) never throws: it logs what it could not do.
      if (this.p.finish !== undefined) await this.p.finish(c.row.ref);
    }
    if (this.pending().length === 0 || this.stopped) {
      this.lastGrowthAt = this.p.now();
      return;
    }
    const received = this.p.swarm.received(this.infoHash);
    if (received === null) return;
    if (received !== this.lastReceived) {
      this.lastReceived = received;
      this.lastGrowthAt = this.p.now();
      return;
    }
    if (this.p.now() - this.lastGrowthAt >= this.p.stallMs) {
      await this.failRest(`the swarm of ${this.p.pack.name} sent nothing for ${Math.round(this.p.stallMs / 3_600_000)} h`);
    }
  }

  private async drop(c: Carried): Promise<void> {
    this.dropped.add(c.row.id);
    await this.p.swarm.releaseSlot(this.infoHash, c.row.ref);
  }

  private async failRest(detail: string): Promise<void> {
    for (const c of this.pending()) {
      this.dropped.add(c.row.id);
      try {
        await this.p.rows.failed(c.row.id, 'download_failed', detail);
        await this.p.swarm.release(this.infoHash);
      } catch (err) {
        this.p.log(`[notesd] downloads: ${refLabel(c.row.ref)}: ${messageOf(err)}`);
      }
    }
    this.p.log(`[notesd] downloads: season pack ${this.p.pack.name}: ${detail}`);
  }
}
