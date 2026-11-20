import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { StreamCacheRow, StreamTorrentRow } from '../db/schema.js';
import type { SeasonView, TitleListItem } from '../movies/read.js';
import { titleId } from '../movies/types.js';
import { TorrentError } from './torrent/types.js';
import { slotId, type SlotKey, type TorrentUsage } from './torrent/usage.js';

/**
 * The Cache page (`/movies/cache`, GET /api/stream/disk, the `stream_disk` tool): everything this host keeps on disk for
 * streaming, per title, season and episode, and its deletion with an undo window.
 *
 * Nothing here writes a table: a torrent goes through TorrentStreams.removeSlots (TorrentsRepo), a cloud cache through
 * StreamCache.remove. A deletion is a pending record first (kept in a JSON file beside the downloads, so a restart inside
 * the window still carries it out at start): its rows are hidden at once and its files go when the window closes.
 */

/** The pending deletions' file, under `<dataDir>/movies/`. */
export const CACHE_PENDING_FILE = 'cache-deletions.json';

/** The stream on screen (StreamLive) and the plays being started (DirectStreamService.starting), as live slots. */
export function liveSlots(
  streamLive: { current(): { title_id: string; season: number | null; episode: number | null } | null } | null,
  direct: { starting(onScreen: string | null): { kind: 'movie' | 'tv'; tmdb_id: number; season: number | null; episode: number | null }[] } | null,
): LiveSlot[] {
  const out: LiveSlot[] = [];
  const now = streamLive?.current() ?? null;
  if (now !== null) out.push({ titleId: now.title_id, season: now.season, episode: now.episode });
  for (const p of direct?.starting(null) ?? []) out.push({ titleId: titleId(p.kind, p.tmdb_id), season: p.season, episode: p.episode });
  return out;
}

/** How long a deletion can be undone. */
export const UNDO_MS = 10_000;

export type ShelfKind = 'torrent' | 'cloud';

export interface ShelfEpisode {
  season: number;
  episode: number;
  /** The episode's movie id (`M-0T77`); null when the registry has none. */
  movie_id: string | null;
  name: string | null;
  bytes: number;
  kinds: ShelfKind[];
  watched: boolean;
  /** On screen or being started now. */
  playing: boolean;
  /** Playing, or held by something else (its torrent fetched, its cache downloading): it cannot be deleted now. */
  in_use: boolean;
}

export interface ShelfSeason {
  season: number;
  /** The episodes' bytes plus `shared_bytes`. */
  bytes: number;
  /** Files of a season pack no single episode owns (subtitles, extras, the pack's other files). */
  shared_bytes: number;
  kinds: ShelfKind[];
  /** Every episode of the season is watched (or the series is marked watched). */
  watched: boolean;
  playing: boolean;
  in_use: boolean;
  episodes: ShelfEpisode[];
}

export interface ShelfTitle {
  /** `movie-<tmdb id>` / `tv-<tmdb id>`. */
  title_id: string;
  movie_id: string | null;
  kind: 'movie' | 'tv';
  tmdb_id: number;
  title: string;
  year: number | null;
  poster_url: string | null;
  /** The title is in the library's table: it has a page. */
  stored: boolean;
  bytes: number;
  torrent_bytes: number;
  cloud_bytes: number;
  kinds: ShelfKind[];
  watched: boolean;
  not_interested: boolean;
  playing: boolean;
  in_use: boolean;
  /** A series: largest first. Empty for a film. */
  seasons: ShelfSeason[];
  /** A series: bytes of a torrent whose episodes span several seasons and that no single episode owns. */
  shared_bytes: number;
}

export interface BulkView {
  bytes: number;
  titles: number;
}

export interface PendingView {
  id: string;
  label: string;
  bytes: number;
  execute_at: string;
  /** What was left out because it is in use (a bulk deletion only). */
  skipped: string[];
}

export interface ShelfView {
  host: string;
  /** Torrents plus cloud caches (blocks on disk), without what a pending deletion hides. */
  total_bytes: number;
  torrent_bytes: number;
  cloud_bytes: number;
  /** Torrent folders no row of this host names (the prune clears them); counted in `total_bytes`. */
  unnamed_bytes: number;
  /** NOTESD_TORRENT_BUDGET_GB in bytes; null when torrents are off. */
  budget_bytes: number | null;
  titles: ShelfTitle[];
  bulk: { watched: BulkView; not_interested: BulkView };
  pending: PendingView[];
  undo_ms: number;
}

/** One concrete thing a deletion removes. */
export type DeletionTarget =
  | { type: 'torrent'; info_hash: string; season: number; episode: number; title_id: string }
  | { type: 'cache'; id: string; title_id: string; season: number; episode: number };

interface PendingRecord {
  id: string;
  label: string;
  bytes: number;
  created_at: string;
  execute_at: string;
  skipped: string[];
  targets: DeletionTarget[];
}

/** What deleting from the Cache page can be asked for. */
export type DeletionScope = { title_id: string; season?: number; episode?: number } | { bulk: 'watched' | 'not_interested' };

export type ShelfErrorCode = 'unknown_title' | 'nothing_cached' | 'in_use' | 'unknown_deletion';

export class ShelfError extends Error {
  override readonly name = 'ShelfError';
  constructor(
    readonly code: ShelfErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** What the shelf needs of TorrentStreams. */
export interface ShelfTorrents {
  diskUsage(): Promise<{ torrents: { infoHash: string; rows: StreamTorrentRow[]; usage: TorrentUsage }[]; unnamedBytes: number; budgetBytes: number | null }>;
  inUse(infoHash: string): boolean;
  removeSlots(infoHash: string, slots: readonly SlotKey[]): Promise<number>;
}

/** What the shelf needs of StreamCache. */
export interface ShelfCaches {
  diskUsage(): Promise<{ row: StreamCacheRow; bytes: number }[]>;
  busy(id: string): boolean;
  remove(id: string): Promise<void>;
}

/** A film or episode on screen or being started: `season`/`episode` null for a film. */
export interface LiveSlot {
  titleId: string;
  season: number | null;
  episode: number | null;
}

export interface CacheShelfOptions {
  host: string;
  torrents: ShelfTorrents | null;
  caches: ShelfCaches | null;
  /** movies/read.ts titleWatchViews, bound to the database and this host. */
  titles: (ids: readonly string[]) => Promise<Map<string, { item: TitleListItem; seasons: SeasonView[] }>>;
  /** The stream on screen and the plays being started. */
  live: () => LiveSlot[];
  /** The JSON file holding the pending deletions. */
  pendingFile: string;
  undoMs?: number;
  now?: () => Date;
  log?: (line: string) => void;
  /** setTimeout, unref'd. Tests pass their own and fire it. */
  later?: (fn: () => void, ms: number) => () => void;
}

const defaultLater = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
};

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const MIB = 1_048_576;
const GIB = 1024 ** 3;
/** "154 MB", "4.2 GB". */
export function sizeText(bytes: number): string {
  return bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GB` : `${Math.max(bytes > 0 ? 1 : 0, Math.round(bytes / MIB))} MB`;
}
const sxe = (season: number, episode?: number): string =>
  `S${String(season).padStart(2, '0')}${episode === undefined ? '' : `E${String(episode).padStart(2, '0')}`}`;

/** One film or episode on disk: its bytes per torrent and per cache. */
interface Slot {
  season: number;
  episode: number;
  torrent: number;
  cloud: number;
  byHash: Map<string, number>;
  byCache: Map<string, number>;
  targets: DeletionTarget[];
  inUse: boolean;
}

/** One title's pieces on disk, before they are named and tagged. */
interface Holding {
  titleId: string;
  kind: 'movie' | 'tv';
  tmdbId: number;
  /** By slotId (film: 0x0): bytes and targets. */
  slots: Map<string, Slot>;
  /** By season: shared torrent bytes of hashes whose rows are all in that season. */
  seasonShared: Map<number, { bytes: number; inUse: boolean }>;
  titleShared: { bytes: number; inUse: boolean };
  /** Torrents of several episodes: their shared bytes, freed once every visible episode of them goes. */
  packs: { infoHash: string; shared: number; season: number | null; slots: Set<string> }[];
}

/**
 * The Cache page's reading and its deletions. Built next to TorrentStreams and StreamCache; `start` carries out what a
 * restart left pending, `close` stops the timers (the records stay for the next start).
 */
export class CacheShelf {
  private readonly undoMs: number;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly later: (fn: () => void, ms: number) => () => void;
  private pending: PendingRecord[] = [];
  private readonly timers = new Map<string, () => void>();
  private chain: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(private readonly opts: CacheShelfOptions) {
    this.undoMs = opts.undoMs ?? UNDO_MS;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((line: string) => console.log(line));
    this.later = opts.later ?? defaultLater;
  }

  /** Carries out every deletion a restart left pending. Never throws. */
  async start(): Promise<number> {
    await this.load();
    const left = [...this.pending];
    for (const record of left) await this.execute(record.id);
    return left.length;
  }

  close(): void {
    for (const stop of this.timers.values()) stop();
    this.timers.clear();
  }

  /** What this host keeps on disk for streaming, largest title first, without what a pending deletion hides. */
  async view(): Promise<ShelfView> {
    await this.load();
    const { holdings, torrentUsage } = await this.read();
    const titles = await this.describe(holdings);
    const torrentBytes = titles.reduce((n, t) => n + t.torrent_bytes, 0) + torrentUsage.unnamedBytes;
    const cloudBytes = titles.reduce((n, t) => n + t.cloud_bytes, 0);
    const bulk = (pick: (t: ShelfTitle) => DeletionTarget[] | null): BulkView => {
      let bytes = 0;
      let count = 0;
      for (const t of titles) {
        const h = holdings.get(t.title_id);
        const targets = pick(t);
        if (h === undefined || targets === null || targets.length === 0) continue;
        const free = this.freeable(h, targets.filter((x) => !this.targetInUse(h, x)));
        if (free > 0) {
          bytes += free;
          count += 1;
        }
      }
      return { bytes, titles: count };
    };
    return {
      host: this.opts.host,
      total_bytes: torrentBytes + cloudBytes,
      torrent_bytes: torrentBytes,
      cloud_bytes: cloudBytes,
      unnamed_bytes: torrentUsage.unnamedBytes,
      budget_bytes: torrentUsage.budgetBytes,
      titles,
      bulk: {
        watched: bulk((t) => this.watchedTargets(t, holdings.get(t.title_id))),
        not_interested: bulk((t) => (t.not_interested ? this.allTargets(holdings.get(t.title_id)) : null)),
      },
      pending: this.pending.map(pendingView),
      undo_ms: this.undoMs,
    };
  }

  /**
   * Deletes a title, a season or an episode (or every watched / not interested title) after the undo window. The rows
   * are hidden at once. A single target in use throws in_use; a bulk deletion leaves what is in use out (`skipped`).
   */
  async remove(scope: DeletionScope): Promise<PendingView> {
    await this.load();
    const { holdings } = await this.read();
    const titles = await this.describe(holdings);
    let targets: DeletionTarget[] = [];
    let label: string;
    let bytes = 0;
    const skipped: string[] = [];
    if ('bulk' in scope) {
      const chosen = titles.filter((t) => (scope.bulk === 'watched' ? t.watched || t.seasons.some((s) => s.episodes.some((e) => e.watched)) : t.not_interested));
      let count = 0;
      for (const t of chosen) {
        const h = holdings.get(t.title_id)!;
        const all = scope.bulk === 'watched' ? (this.watchedTargets(t, h) ?? []) : this.allTargets(h);
        const free = all.filter((x) => !this.targetInUse(h, x));
        if (free.length < all.length) skipped.push(t.title);
        if (free.length === 0) continue;
        bytes += this.freeable(h, free);
        targets.push(...free);
        count += 1;
      }
      if (targets.length === 0) throw new ShelfError('nothing_cached', scope.bulk === 'watched' ? 'Nothing watched is cached here (or it is in use).' : 'Nothing marked not interested is cached here (or it is in use).');
      label = `${scope.bulk === 'watched' ? 'Watched' : 'Not interested'} (${count} ${count === 1 ? 'title' : 'titles'})`;
    } else {
      const t = titles.find((x) => x.title_id === scope.title_id);
      const h = holdings.get(scope.title_id);
      if (t === undefined || h === undefined) throw new ShelfError('nothing_cached', 'This title holds nothing on this machine.');
      targets = this.allTargets(h).filter((x) => scope.season === undefined || (x.season === scope.season && (scope.episode === undefined || x.episode === scope.episode)));
      if (targets.length === 0) throw new ShelfError('nothing_cached', 'This season or episode holds nothing on this machine.');
      if (targets.some((x) => this.targetInUse(h, x))) throw new ShelfError('in_use', `${t.title} plays or is being fetched now; it can be deleted once it stops.`);
      bytes = this.freeable(h, targets);
      label = scope.season === undefined ? t.title : `${t.title} ${sxe(scope.season, scope.episode)}`;
    }
    const at = this.now();
    const record: PendingRecord = {
      id: randomBytes(6).toString('hex'),
      label,
      bytes,
      created_at: at.toISOString(),
      execute_at: new Date(at.getTime() + this.undoMs).toISOString(),
      skipped,
      targets,
    };
    this.pending.push(record);
    await this.save();
    this.arm(record);
    this.log(`[notesd] cache page: ${label} (${sizeText(bytes)}) goes in ${Math.round(this.undoMs / 1000)} s unless undone`);
    return pendingView(record);
  }

  /** Cancels a pending deletion: its rows come back as they were. Throws unknown_deletion once it was carried out. */
  async undo(id: string): Promise<PendingView> {
    await this.load();
    const record = this.pending.find((r) => r.id === id);
    if (record === undefined) throw new ShelfError('unknown_deletion', 'No pending deletion has this id: it was carried out or undone already.');
    this.pending = this.pending.filter((r) => r.id !== id);
    this.timers.get(id)?.();
    this.timers.delete(id);
    await this.save();
    this.log(`[notesd] cache page: ${record.label} undone`);
    return pendingView(record);
  }

  /** Carries out a pending deletion now (its window closed, or a restart). What became in use meanwhile is left. */
  async execute(id: string): Promise<void> {
    const run = this.chain.then(async () => {
      const record = this.pending.find((r) => r.id === id);
      if (record === undefined) return;
      this.timers.get(id)?.();
      this.timers.delete(id);
      const byHash = new Map<string, SlotKey[]>();
      for (const t of record.targets) if (t.type === 'torrent') byHash.set(t.info_hash, [...(byHash.get(t.info_hash) ?? []), { season: t.season, episode: t.episode }]);
      for (const [hash, slots] of byHash) {
        try {
          if (this.opts.torrents === null) continue;
          await this.opts.torrents.removeSlots(hash, slots);
        } catch (err) {
          const why = err instanceof TorrentError && err.code === 'in_use' ? 'it plays now' : messageOf(err);
          this.log(`[notesd] cache page: kept the torrent ${hash.slice(0, 8)} of ${record.label}: ${why}`);
        }
      }
      for (const t of record.targets) {
        if (t.type !== 'cache' || this.opts.caches === null) continue;
        try {
          if (this.opts.caches.busy(t.id)) {
            this.log(`[notesd] cache page: kept the cache ${t.id} of ${record.label}: it downloads now`);
            continue;
          }
          await this.opts.caches.remove(t.id);
        } catch (err) {
          this.log(`[notesd] cache page: could not delete the cache ${t.id} of ${record.label}: ${messageOf(err)}`);
        }
      }
      this.pending = this.pending.filter((r) => r.id !== id);
      try {
        await this.save();
      } catch (err) {
        this.log(`[notesd] cache page: could not write the pending deletions: ${messageOf(err)}`);
      }
      this.log(`[notesd] cache page: deleted ${record.label} (${sizeText(record.bytes)})`);
    });
    this.chain = run.catch(() => undefined);
    await run;
  }

  // ---------- reading ----------

  private async read(): Promise<{ holdings: Map<string, Holding>; torrentUsage: { unnamedBytes: number; budgetBytes: number | null } }> {
    const hiddenSlots = new Set<string>();
    const hiddenCaches = new Set<string>();
    for (const r of this.pending)
      for (const t of r.targets) {
        if (t.type === 'torrent') hiddenSlots.add(`${t.info_hash}:${t.season}x${t.episode}`);
        else hiddenCaches.add(t.id);
      }
    const holdings = new Map<string, Holding>();
    const holding = (kind: 'movie' | 'tv', tmdbId: number): Holding => {
      const id = titleId(kind, tmdbId);
      let h = holdings.get(id);
      if (h === undefined) {
        h = { titleId: id, kind, tmdbId, slots: new Map(), seasonShared: new Map(), titleShared: { bytes: 0, inUse: false }, packs: [] };
        holdings.set(id, h);
      }
      return h;
    };
    const slotOf = (h: Holding, season: number, episode: number) => {
      const key = `${season}x${episode}`;
      let s = h.slots.get(key);
      if (s === undefined) {
        s = { season, episode, torrent: 0, cloud: 0, byHash: new Map(), byCache: new Map(), targets: [], inUse: false };
        h.slots.set(key, s);
      }
      return s;
    };
    let torrentUsage = { unnamedBytes: 0, budgetBytes: null as number | null };
    if (this.opts.torrents !== null) {
      const usage = await this.opts.torrents.diskUsage();
      torrentUsage = { unnamedBytes: usage.unnamedBytes, budgetBytes: usage.budgetBytes };
      for (const t of usage.torrents) {
        const rows = t.rows.filter((r) => !hiddenSlots.has(`${t.infoHash}:${slotId(r)}`));
        if (rows.length === 0) continue;
        const inUse = this.opts.torrents.inUse(t.infoHash);
        // A torrent's rows are of one title; one opened for two titles counts to the title of its first row.
        const first = rows[0]!;
        const h = holding(first.kind, first.tmdbId);
        const slots = new Set<string>();
        for (const r of rows) {
          const sh = r.kind === first.kind && r.tmdbId === first.tmdbId ? h : holding(r.kind, r.tmdbId);
          const s = slotOf(sh, r.season, r.episode);
          // With episodes hidden, a file one hidden and one visible episode shared counts as shared.
          const own = rows.length === 1 ? t.usage.total : (t.usage.slots.get(slotId(r)) ?? 0);
          s.torrent += own;
          s.byHash.set(t.infoHash, (s.byHash.get(t.infoHash) ?? 0) + own);
          s.targets.push({ type: 'torrent', info_hash: t.infoHash, season: r.season, episode: r.episode, title_id: sh.titleId });
          s.inUse ||= inUse;
          slots.add(slotId(r));
        }
        if (rows.length > 1) {
          const shared = t.usage.total - rows.reduce((n, r) => n + (t.usage.slots.get(slotId(r)) ?? 0), 0);
          const seasons = new Set(rows.map((r) => r.season));
          const season = seasons.size === 1 ? first.season : null;
          if (season !== null) {
            const was = h.seasonShared.get(season) ?? { bytes: 0, inUse: false };
            h.seasonShared.set(season, { bytes: was.bytes + shared, inUse: was.inUse || inUse });
          } else {
            h.titleShared = { bytes: h.titleShared.bytes + shared, inUse: h.titleShared.inUse || inUse };
          }
          h.packs.push({ infoHash: t.infoHash, shared, season, slots });
        }
      }
    }
    if (this.opts.caches !== null) {
      for (const { row, bytes } of await this.opts.caches.diskUsage()) {
        if (hiddenCaches.has(row.id)) continue;
        const h = holding(row.kind, row.tmdbId);
        const s = slotOf(h, row.season, row.episode);
        s.cloud += bytes;
        s.byCache.set(row.id, bytes);
        s.targets.push({ type: 'cache', id: row.id, title_id: h.titleId, season: row.season, episode: row.episode });
        s.inUse ||= this.opts.caches.busy(row.id);
      }
    }
    for (const [id, h] of holdings) {
      const total = [...h.slots.values()].reduce((n, s) => n + s.torrent + s.cloud, 0) + [...h.seasonShared.values()].reduce((n, s) => n + s.bytes, 0) + h.titleShared.bytes;
      if (total <= 0) holdings.delete(id);
    }
    return { holdings, torrentUsage };
  }

  private async describe(holdings: Map<string, Holding>): Promise<ShelfTitle[]> {
    const views = await this.opts.titles([...holdings.keys()]);
    const live = this.opts.live();
    const titles: ShelfTitle[] = [];
    for (const h of holdings.values()) {
      const v = views.get(h.titleId);
      const item = v?.item;
      const liveHere = live.filter((l) => l.titleId === h.titleId);
      const kindsOf = (torrent: number, cloud: number): ShelfKind[] => [...(torrent > 0 ? (['torrent'] as const) : []), ...(cloud > 0 ? (['cloud'] as const) : [])];
      const titleWatched = item !== undefined && (item.watched || item.state === 'finished');
      let torrentBytes = 0;
      let cloudBytes = 0;
      for (const s of h.slots.values()) {
        torrentBytes += s.torrent;
        cloudBytes += s.cloud;
      }
      for (const s of h.seasonShared.values()) torrentBytes += s.bytes;
      torrentBytes += h.titleShared.bytes;
      const seasons: ShelfSeason[] = [];
      if (h.kind === 'tv') {
        const bySeason = new Map<number, ShelfEpisode[]>();
        for (const s of h.slots.values()) {
          const ev = v?.seasons.find((x) => x.season === s.season)?.episodes.find((e) => e.episode === s.episode);
          const playing = liveHere.some((l) => l.season === s.season && l.episode === s.episode);
          const ep: ShelfEpisode = {
            season: s.season,
            episode: s.episode,
            movie_id: ev?.movie_id ?? null,
            name: ev?.name ?? null,
            bytes: s.torrent + s.cloud,
            kinds: kindsOf(s.torrent, s.cloud),
            watched: titleWatched || ev?.state === 'finished',
            playing,
            in_use: playing || s.inUse,
          };
          bySeason.set(s.season, [...(bySeason.get(s.season) ?? []), ep]);
        }
        for (const season of new Set([...bySeason.keys(), ...h.seasonShared.keys()])) {
          const episodes = (bySeason.get(season) ?? []).sort((a, b) => b.bytes - a.bytes || a.episode - b.episode);
          const shared = h.seasonShared.get(season) ?? { bytes: 0, inUse: false };
          const known = v?.seasons.find((x) => x.season === season)?.episodes ?? [];
          const watched = titleWatched || (known.length > 0 ? known.every((e) => e.state === 'finished') : episodes.length > 0 && episodes.every((e) => e.watched));
          const torrent = episodes.reduce((n, e) => n + (e.kinds.includes('torrent') ? 1 : 0), 0) > 0 || shared.bytes > 0;
          const cloud = episodes.some((e) => e.kinds.includes('cloud'));
          seasons.push({
            season,
            bytes: episodes.reduce((n, e) => n + e.bytes, 0) + shared.bytes,
            shared_bytes: shared.bytes,
            kinds: [...(torrent ? (['torrent'] as const) : []), ...(cloud ? (['cloud'] as const) : [])],
            watched,
            playing: episodes.some((e) => e.playing),
            in_use: shared.inUse || episodes.some((e) => e.in_use),
            episodes,
          });
        }
        seasons.sort((a, b) => b.bytes - a.bytes || a.season - b.season);
      }
      const film = h.slots.get('0x0');
      const playing = liveHere.length > 0;
      titles.push({
        title_id: h.titleId,
        movie_id: item?.movie_id ?? null,
        kind: h.kind,
        tmdb_id: h.tmdbId,
        title: item?.title ?? `TMDB ${h.kind === 'tv' ? 'series' : 'movie'} ${h.tmdbId}`,
        year: item?.year ?? null,
        poster_url: item?.poster_url ?? null,
        stored: item !== undefined,
        bytes: torrentBytes + cloudBytes,
        torrent_bytes: torrentBytes,
        cloud_bytes: cloudBytes,
        kinds: kindsOf(torrentBytes, cloudBytes),
        watched: titleWatched,
        not_interested: item?.not_interested ?? false,
        playing,
        in_use: playing || h.titleShared.inUse || [...h.slots.values()].some((s) => s.inUse) || seasons.some((s) => s.in_use) || (film?.inUse ?? false),
        seasons,
        shared_bytes: h.titleShared.bytes,
      });
    }
    return titles.sort((a, b) => b.bytes - a.bytes || a.title.localeCompare(b.title));
  }

  private allTargets(h: Holding | undefined): DeletionTarget[] {
    return h === undefined ? [] : [...h.slots.values()].flatMap((s) => s.targets);
  }

  /** A watched film or series: all of it. Else a series' watched episodes. Null: nothing watched. */
  private watchedTargets(t: ShelfTitle, h: Holding | undefined): DeletionTarget[] | null {
    if (h === undefined) return null;
    if (t.watched) return this.allTargets(h);
    const watched = new Set(t.seasons.flatMap((s) => s.episodes.filter((e) => e.watched).map((e) => `${e.season}x${e.episode}`)));
    if (watched.size === 0) return null;
    return [...h.slots.entries()].filter(([key]) => watched.has(key)).flatMap(([, s]) => s.targets);
  }

  private targetInUse(h: Holding, target: DeletionTarget): boolean {
    const slot = h.slots.get(`${target.season}x${target.episode}`);
    const live = this.opts.live().some((l) => l.titleId === h.titleId && (h.kind === 'movie' || (l.season === target.season && l.episode === target.episode)));
    if (live) return true;
    if (target.type === 'torrent') return this.opts.torrents?.inUse(target.info_hash) ?? false;
    return this.opts.caches?.busy(target.id) ?? slot?.inUse ?? false;
  }

  /** The bytes these targets free: each slot's own bytes of its torrent or cache, plus a pack's shared bytes once every visible episode of it goes. */
  private freeable(h: Holding, targets: readonly DeletionTarget[]): number {
    let bytes = 0;
    const chosen = new Set<string>();
    for (const t of targets) {
      const slot = h.slots.get(`${t.season}x${t.episode}`);
      if (slot === undefined) continue;
      if (t.type === 'torrent') {
        chosen.add(`${t.info_hash}:${t.season}x${t.episode}`);
        bytes += slot.byHash.get(t.info_hash) ?? 0;
      } else bytes += slot.byCache.get(t.id) ?? 0;
    }
    for (const p of h.packs) if ([...p.slots].every((k) => chosen.has(`${p.infoHash}:${k}`))) bytes += p.shared;
    return bytes;
  }

  // ---------- pending records ----------

  private arm(record: PendingRecord): void {
    const wait = Math.max(0, Date.parse(record.execute_at) - this.now().getTime());
    this.timers.set(
      record.id,
      this.later(() => void this.execute(record.id), wait),
    );
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.opts.pendingFile, 'utf8')) as unknown;
      this.pending = Array.isArray(raw) ? raw.filter(isRecord) : [];
    } catch {
      this.pending = [];
    }
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.opts.pendingFile), { recursive: true });
    const temp = `${this.opts.pendingFile}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(this.pending, null, 1)}\n`, 'utf8');
    await rename(temp, this.opts.pendingFile);
  }
}

function pendingView(r: PendingRecord): PendingView {
  return { id: r.id, label: r.label, bytes: r.bytes, execute_at: r.execute_at, skipped: r.skipped };
}

function isRecord(v: unknown): v is PendingRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === 'string' && typeof r.label === 'string' && typeof r.execute_at === 'string' && Array.isArray(r.targets);
}
