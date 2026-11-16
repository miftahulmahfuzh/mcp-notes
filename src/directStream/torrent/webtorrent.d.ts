// Types for webtorrent 3.0.21, which ships none: only what src/directStream/torrent/engine.ts, its tests
// and the verify seeder use. Read from the package's index.js, lib/torrent.js and lib/file.js, not from the
// v1/v2 @types. Keep it a script (no top-level import or export) so the module declaration stays ambient.
declare module 'webtorrent' {
  import { EventEmitter } from 'node:events';

  export interface WebTorrentOptions {
    dht?: boolean | Record<string, unknown>;
    tracker?: boolean | Record<string, unknown>;
    lsd?: boolean;
    utPex?: boolean;
    natUpnp?: boolean | 'permanent';
    natPmp?: boolean;
    utp?: boolean;
    webSeeds?: boolean;
    torrentPort?: number;
    maxConns?: number;
    /** Bytes per second, all torrents together; -1 (the default) is no limit. */
    uploadLimit?: number;
    downloadLimit?: number;
  }

  export interface TorrentOptions {
    /** The folder the torrent's files are written under. */
    path?: string;
    /** Start with no file selected (the default selects the whole torrent). */
    deselect?: boolean;
    /** Trackers added to the torrent's own. */
    announce?: string[];
    /** seed(): the piece length of the torrent it makes. */
    pieceLength?: number;
    name?: string;
  }

  export interface TorrentFile extends EventEmitter {
    readonly name: string;
    readonly path: string;
    readonly length: number;
    /** Where the file starts in the torrent's byte stream. */
    readonly offset: number;
    readonly done: boolean;
    readonly downloaded: number;
    readonly progress: number;
    select(priority?: number): void;
    deselect(): void;
    /**
     * Bytes start..end, end inclusive. Reading fetches those pieces first. `end` 0 (falsy) or past the end
     * reads to the end of the file: callers count the bytes themselves.
     */
    [Symbol.asyncIterator](opts?: { start?: number; end?: number }): AsyncIterator<Uint8Array>;
  }

  export interface Wire {
    readonly remoteAddress: string;
    readonly remotePort: number;
  }

  export interface Torrent extends EventEmitter {
    readonly infoHash: string;
    readonly name: string;
    readonly files: TorrentFile[];
    readonly pieceLength: number;
    readonly length: number;
    /** Set once the file list is known. */
    readonly bitfield: { get(index: number): boolean } | undefined;
    readonly ready: boolean;
    readonly done: boolean;
    readonly destroyed: boolean;
    readonly numPeers: number;
    readonly wires: Wire[];
    /** Bytes per second. */
    readonly downloadSpeed: number;
    /** Bytes per second. */
    readonly uploadSpeed: number;
    readonly downloaded: number;
    readonly uploaded: number;
    readonly received: number;
    addPeer(peer: string): boolean;
    destroy(opts?: { destroyStore?: boolean } | null, cb?: (err?: Error | null) => void): void;
  }

  export default class WebTorrent extends EventEmitter {
    constructor(opts?: WebTorrentOptions);
    static readonly VERSION: string;
    readonly torrents: Torrent[];
    readonly listening: boolean;
    readonly destroyed: boolean;
    add(torrentId: string, opts?: TorrentOptions, ontorrent?: (torrent: Torrent) => void): Torrent;
    seed(input: string | string[], opts?: TorrentOptions, onseed?: (torrent: Torrent) => void): Torrent;
    address(): { address: string; family: string; port: number } | null;
    throttleUpload(rate: number): boolean | void;
    destroy(cb?: (err?: Error | null) => void): void;
  }
}
