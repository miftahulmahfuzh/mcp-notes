import { rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type WebTorrent from 'webtorrent';
import type { Torrent, TorrentFile } from 'webtorrent';
import type { TorrentFolder } from './store.js';
import { installPeerGuard, installUtpGuard } from './utpGuard.js';
import {
  BYTES_PER_KB,
  kilobits,
  TorrentError,
  type TorrentAddSpec,
  type TorrentEngine,
  type TorrentFileInfo,
  type TorrentHandle,
  type TorrentStats,
} from './types.js';

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface WebTorrentEngineOptions {
  folder: TorrentFolder;
  /** NOTESD_TORRENT_UPLOAD_KBPS: the upload cap in kB/s, all torrents together. */
  uploadKbps: number;
  /** false: no DHT and no trackers; peers come only from `peers` (the verify harness, tests). */
  discovery: boolean;
  /** `host:port` addresses added as a peer to every torrent (NOTESD_TORRENT_PEERS). */
  peers: readonly string[];
  log: (line: string) => void;
  /**
   * uTP beside TCP; default false (NOTESD_TORRENT_UTP=on turns it on). Measured from this machine on four well
   * seeded swarms, 40 s each, 2026-11-20: TCP alone fetched 183 to 251 MB, uTP beside it 18 to 98 MB.
   */
  utp?: boolean;
}

/**
 * The bytes start..end (inclusive) of one file, in order. webtorrent's iterator fetches their pieces before
 * the rest; it reads to the end of the file when `end` is 0, so the count is kept here.
 */
async function* take(file: TorrentFile, start: number, end: number): AsyncGenerator<Uint8Array> {
  const iterator = file[Symbol.asyncIterator]({ start, end });
  let left = end - start + 1;
  try {
    while (left > 0) {
      const next = await iterator.next();
      if (next.done === true) return;
      const chunk = next.value.length > left ? next.value.subarray(0, left) : next.value;
      left -= chunk.length;
      yield chunk;
    }
  } finally {
    await iterator.return?.();
  }
}

function destroyTorrent(torrent: Torrent): Promise<void> {
  return new Promise<void>((resolve) => {
    if (torrent.destroyed) {
      resolve();
      return;
    }
    torrent.destroy({ destroyStore: false }, () => resolve());
  });
}

/**
 * Waits for the file list ('ready': listed and what is on disk verified). `check` runs on 'metadata',
 * before the store touches the disk; an answer destroys the torrent there and then.
 */
function waitForFiles(torrent: Torrent, timeoutMs: number, check: () => TorrentError | null): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (torrent.ready) {
      const bad = check();
      if (bad === null) resolve();
      else reject(bad);
      return;
    }
    const finish = (err: TorrentError | null): void => {
      clearTimeout(timer);
      torrent.off('metadata', onMetadata);
      torrent.off('ready', onReady);
      torrent.off('error', onError);
      torrent.off('close', onClose);
      if (err === null) resolve();
      else reject(err);
    };
    const onMetadata = (): void => {
      const bad = check();
      if (bad === null) return;
      finish(bad);
      torrent.destroy({ destroyStore: false });
    };
    const onReady = (): void => finish(null);
    const onError = (err: unknown): void => finish(new TorrentError('engine_error', messageOf(err)));
    const onClose = (): void => finish(new TorrentError('engine_error', 'The torrent closed before its file list arrived.'));
    const timer = setTimeout(
      () => finish(new TorrentError('no_metadata', `No peer sent the file list within ${Math.round(timeoutMs / 1000)} s.`)),
      timeoutMs,
    );
    timer.unref();
    torrent.on('metadata', onMetadata);
    torrent.on('ready', onReady);
    torrent.on('error', onError);
    torrent.on('close', onClose);
  });
}

class WebTorrentHandle implements TorrentHandle {
  readonly live = true;
  readonly infoHash: string;
  readonly name: string;
  readonly files: readonly TorrentFileInfo[];

  constructor(private readonly torrent: Torrent) {
    this.infoHash = torrent.infoHash;
    this.name = torrent.name;
    this.files = torrent.files.map((f, index) => ({ index, path: f.path, name: f.name, length: f.length }));
  }

  select(indexes: readonly number[]): void {
    for (const index of indexes) this.file(index).select();
  }

  read(index: number, range: { start: number; end: number }): Readable {
    return Readable.from(take(this.file(index), range.start, range.end), { objectMode: false });
  }

  stats(): TorrentStats {
    const t = this.torrent;
    if (t.destroyed) return { peers: 0, down_kbps: 0, up_kbps: 0 };
    return { peers: t.numPeers, down_kbps: kilobits(t.downloadSpeed), up_kbps: kilobits(t.uploadSpeed) };
  }

  ranges(index: number): [number, number][] {
    const t = this.torrent;
    const bitfield = t.bitfield;
    if (t.destroyed || bitfield === undefined) return [];
    const file = this.file(index);
    if (file.length === 0) return [];
    const size = t.pieceLength;
    const first = Math.floor(file.offset / size);
    const last = Math.floor((file.offset + file.length - 1) / size);
    const out: [number, number][] = [];
    for (let piece = first; piece <= last; piece += 1) {
      if (!bitfield.get(piece)) continue;
      const from = Math.max(piece * size - file.offset, 0);
      const to = Math.min((piece + 1) * size - file.offset, file.length);
      const prev = out.at(-1);
      if (prev !== undefined && prev[1] === from) prev[1] = to;
      else out.push([from, to]);
    }
    return out;
  }

  done(index: number): boolean {
    return !this.torrent.destroyed && this.file(index).done;
  }

  private file(index: number): TorrentFile {
    const file = this.torrent.files[index];
    if (file === undefined) throw new RangeError(`the torrent ${this.infoHash} has no file ${index}`);
    return file;
  }
}

/**
 * The real engine: one WebTorrent client, made with the first torrent and destroyed after the last one leaves,
 * so the daemon has no torrent port, DHT node or peer while nothing is open. UPnP, NAT-PMP, local discovery
 * and web seeds are always off (WSL 2 NAT: only outgoing connections work anyway). Upload is capped for all
 * torrents together. Files are written under `folder.dirOf(infoHash)`; a torrent whose file list names a
 * path outside that folder is destroyed before anything is written (unsafe_path).
 */
export class WebTorrentEngine implements TorrentEngine {
  private client: WebTorrent | null = null;
  private starting: Promise<WebTorrent> | null = null;
  private readonly torrents = new Map<string, { torrent: Torrent; handle: WebTorrentHandle }>();
  /** Adds under way: the client is not destroyed while one is. */
  private pending = 0;
  private closed = false;

  constructor(private readonly opts: WebTorrentEngineOptions) {}

  async add(spec: TorrentAddSpec, options: { timeoutMs: number }): Promise<TorrentHandle> {
    if (this.closed) throw new TorrentError('closing', 'The torrent engine is stopping.');
    const known = this.torrents.get(spec.infoHash);
    if (known !== undefined) return known.handle;
    this.pending += 1;
    try {
      const client = await this.ensureClient();
      const torrent = client.add(spec.infoHash, {
        path: this.opts.folder.dirOf(spec.infoHash),
        deselect: true,
        announce: this.opts.discovery ? [...spec.trackers] : [],
      });
      torrent.on('error', (err: unknown) => this.opts.log(`[notesd] torrent ${spec.infoHash.slice(0, 8)}: ${messageOf(err)}`));
      if (this.opts.peers.length > 0) {
        torrent.once('infoHash', () => {
          for (const peer of this.opts.peers) torrent.addPeer(peer);
        });
      }
      try {
        await waitForFiles(torrent, options.timeoutMs, () => {
          const outside = torrent.files.find((f) => !this.opts.folder.contains(spec.infoHash, f.path));
          return outside === undefined
            ? null
            : new TorrentError('unsafe_path', `The torrent names a file outside its folder (${outside.path}); nothing of it is downloaded.`);
        });
      } catch (err) {
        await destroyTorrent(torrent);
        throw err instanceof TorrentError ? err : new TorrentError('engine_error', messageOf(err));
      }
      const handle = new WebTorrentHandle(torrent);
      this.torrents.set(spec.infoHash, { torrent, handle });
      return handle;
    } finally {
      this.pending -= 1;
      await this.stopWhenIdle();
    }
  }

  get(infoHash: string): TorrentHandle | null {
    return this.torrents.get(infoHash)?.handle ?? null;
  }

  async remove(infoHash: string, options: { deleteFiles: boolean }): Promise<void> {
    const entry = this.torrents.get(infoHash);
    this.torrents.delete(infoHash);
    if (entry !== undefined) await destroyTorrent(entry.torrent);
    if (options.deleteFiles) await rm(this.opts.folder.dirOf(infoHash), { recursive: true, force: true });
    await this.stopWhenIdle();
  }

  port(): number | null {
    return this.client?.address()?.port ?? null;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.torrents.clear();
    const client = this.client ?? (this.starting === null ? null : await this.starting.catch(() => null));
    this.client = null;
    if (client !== null && !client.destroyed) await new Promise<void>((resolve) => client.destroy(() => resolve()));
  }

  private async ensureClient(): Promise<WebTorrent> {
    if (this.client !== null) return this.client;
    this.starting ??= this.startClient().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async startClient(): Promise<WebTorrent> {
    let Ctor: typeof WebTorrent;
    try {
      Ctor = (await import('webtorrent')).default;
    } catch (err) {
      throw new TorrentError('engine_error', `webtorrent could not be loaded: ${messageOf(err)}`);
    }
    const discovery = this.opts.discovery;
    // A peer's uTP error must never leave the process (utpGuard.ts): installed before the first swarm is joined.
    if (this.opts.utp === true) installUtpGuard(this.opts.log);
    // Nor a peer whose torrent was already left (the same file).
    await installPeerGuard(this.opts.log);
    const client = new Ctor({
      dht: discovery,
      tracker: discovery ? {} : false,
      lsd: false,
      natUpnp: false,
      natPmp: false,
      webSeeds: false,
      utp: this.opts.utp === true,
      uploadLimit: Math.max(1, Math.round(this.opts.uploadKbps * BYTES_PER_KB)),
    });
    client.on('error', (err: unknown) => this.opts.log(`[notesd] torrent engine: ${messageOf(err)}`));
    this.client = client;
    return client;
  }

  private async stopWhenIdle(): Promise<void> {
    const client = this.client;
    if (client === null || this.pending > 0 || this.torrents.size > 0 || client.torrents.length > 0) return;
    this.client = null;
    if (!client.destroyed) await new Promise<void>((resolve) => client.destroy(() => resolve()));
  }
}
