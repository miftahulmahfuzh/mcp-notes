import type { CacheNow, DownloadCaches, DownloadTorrents, KeptTorrentHandle, TorrentAsk, TorrentFetch, TorrentNow } from '../../../../src/directStream/downloads/types.js';
import { refLabel, type StreamRef } from '../../../../src/directStream/types.js';

/** The torrent side, recorded: `fetch band:preferred`, `fetch hash:<h>`, `keep <h> true`, `release <h>`. */
export class FakeTorrents implements DownloadTorrents {
  readonly calls: string[] = [];
  /** What fetch answers, by `band:preferred`, `band:below` or `hash:<info hash>`; unset: no_source. */
  readonly answers = new Map<string, TorrentFetch>();
  /** Info hashes whose file is whole on disk. */
  readonly whole = new Set<string>();
  /** A held torrent's remux, by info hash; unset: none. */
  readonly remux = new Map<string, TorrentNow['remux']>();
  /** Info hashes whose subtitle search still runs. */
  readonly searching = new Set<string>();
  /** refLabel of the titles already whole here. */
  readonly onDiskRefs = new Set<string>();
  readonly kept = new Map<string, boolean>();

  async onDisk(ref: StreamRef): Promise<boolean> {
    return this.onDiskRefs.has(refLabel(ref));
  }

  async fetch(_ref: StreamRef, ask: TorrentAsk): Promise<TorrentFetch> {
    const key = 'band' in ask ? `band:${ask.band}` : `hash:${ask.infoHash}`;
    this.calls.push(`fetch ${key}`);
    return this.answers.get(key) ?? { ok: false, error: 'no_source', detail: 'no torrent fits' };
  }

  async now(handle: KeptTorrentHandle): Promise<TorrentNow> {
    const whole = this.whole.has(handle.infoHash);
    return {
      file: whole ? 'whole' : 'downloading',
      remux: this.remux.get(handle.infoHash) ?? 'none',
      subtitles: this.searching.has(handle.infoHash) ? 'searching' : 'done',
      bytesDone: whole ? 100 : 40,
      bytesTotal: 100,
      peers: 5,
      downKbps: 900,
    };
  }

  async retryRemux(handle: KeptTorrentHandle): Promise<void> {
    this.calls.push(`retry remux ${handle.infoHash}`);
  }

  release(handle: KeptTorrentHandle): void {
    this.calls.push(`release ${handle.infoHash}`);
  }

  async keep(infoHash: string, kept: boolean): Promise<void> {
    this.kept.set(infoHash, kept);
    this.calls.push(`keep ${infoHash} ${kept}`);
  }
}

/** The cloud side, recorded: `request <ref> <height>`, `pause <ref>`. */
export class FakeCaches implements DownloadCaches {
  readonly calls: string[] = [];
  readonly caches = new Map<string, CacheNow>();

  async onDisk(ref: StreamRef): Promise<boolean> {
    return this.caches.get(refLabel(ref))?.state === 'ready';
  }

  async request(ref: StreamRef, maxHeight: number): Promise<CacheNow> {
    this.calls.push(`request ${refLabel(ref)} ${maxHeight}`);
    const key = refLabel(ref);
    const was = this.caches.get(key);
    const cache: CacheNow =
      was === undefined || was.state === 'failed'
        ? { id: `0000000${this.caches.size + 1}-0000-4000-8000-000000000000`, state: 'downloading', running: true, queued: false, progress: 0, bytes: 0, maxHeight, error: null, errorDetail: null }
        : { ...was, running: was.state === 'downloading' };
    this.caches.set(key, cache);
    return { ...cache };
  }

  async find(ref: StreamRef): Promise<CacheNow | null> {
    const cache = this.caches.get(refLabel(ref));
    return cache === undefined ? null : { ...cache };
  }

  async pause(ref: StreamRef): Promise<boolean> {
    this.calls.push(`pause ${refLabel(ref)}`);
    return true;
  }

  set(ref: StreamRef, patch: Partial<CacheNow>): void {
    const cache = this.caches.get(refLabel(ref));
    if (cache === undefined) throw new Error(`no cache of ${refLabel(ref)}`);
    this.caches.set(refLabel(ref), { ...cache, ...patch });
  }
}
