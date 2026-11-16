# Phase 1: The torrent engine and its file route

**Plan set:** `TORRENT_STREAM_SOURCE_PLAN.md`
**Analysis:** `.workflows/analyze/20261116-192341-T7QK_code_analyzer.md`
**Satisfies:** R2 — "streaming video using that torrent file": the daemon can join a swarm, download one film's video and subtitle files in playing order and serve any byte range of them from its own route
**Criteria:** R2.1, R2.2, R2.3, R2.6, R2.9
**Depends on:** none
**Difficulty:** HARD
**Package:** `src/directStream/torrent`

---

## Goal

After this phase the daemon holds a WebTorrent 3 engine (started lazily, only while a torrent is open), a
per-host record of torrent downloads (`stream_torrents`, written only by `TorrentsRepo`), and the routes
`/api/stream/torrent[/...]`. Opening a torrent by info hash answers its file list; using a video and its
subtitle files downloads only those, in order, under `<NOTESD_TORRENT_DIR>/<info hash>/`; any byte range
of a chosen file is answered 206 with exactly those bytes, its pieces fetched first; upload is capped;
the swarm is left as soon as nothing uses the torrent; a finished download opens and plays from disk with
no swarm; downloads not played for `NOTESD_TORRENT_KEEP_DAYS` are deleted. With `NOTESD_TORRENT=off`
nothing is built and every route answers `torrent_off`. `verify.sh up --torrent` proves it against a
loopback seeder of a generated film and pack.

## What was checked before planning (facts the code below relies on)

- `webtorrent@3.0.21` was installed in a scratch folder (`/tmp/claude-1000/wt-api`) with npm 12.0.1 on
  Node 22.23.1 (WSL). npm 12 blocks dependency install scripts by default; webtorrent's import chain
  (`@thaunknown/simple-peer` → `webrtc-polyfill` → `node-datachannel`) loads the native
  `node_datachannel.node` **at import time**, so with the script blocked `import 'webtorrent'` throws
  `Cannot find module '../../../build/Release/node_datachannel.node'`. `npm install-scripts approve
  node-datachannel` + `npm rebuild node-datachannel` (prebuild-install downloads a linux-x64 N-API binary,
  ~8 s) fixes it; after that the client loads (`WebTorrent.VERSION` 3.0.21, `UTP_SUPPORT` true from
  utp-native's bundled prebuild even with its script denied). The other blocked scripts (`ip-set`
  preinstall `npx only-allow pnpm`, `bufferutil`, `utf-8-validate`, `utp-native` node-gyp) are not needed.
  Approving writes an `allowScripts` field into `package.json`; once it exists, npm ignores the user-level
  `allow-scripts` in `~/.npmrc` (only `@anthropic-ai/claude-code`, which is not a dependency here).
- webtorrent 3 ships no TypeScript types (`@types/webtorrent` is v1/v2); this phase declares the few it uses.
- API, read from `index.js`, `lib/torrent.js`, `lib/file.js`, `lib/file-iterator.js`, `fs-chunk-store`:
  - `new WebTorrent({ dht, tracker, lsd, utPex, natUpnp, natPmp, utp, webSeeds, uploadLimit })`; the
    constructor itself starts the DHT and a TCP (+uTP) listener on a random port on all interfaces, so the
    client must only be built when a torrent is opened. `uploadLimit` is bytes/s (`-1` none).
  - `client.add(hexInfoHash, { path, deselect: true, announce })` → `Torrent`; `'infoHash'` fires
    asynchronously (only then may `addPeer('host:port')` be called), `'metadata'` when the file list is
    known (synchronous handlers may destroy the torrent before verification), `'ready'` after the store
    verified what is on disk. `deselect: true` selects nothing.
  - `file.select()` selects the file's pieces (priority 0, strategy `sequential`);
    `file[Symbol.asyncIterator]({ start, end })` adds a priority-1 stream selection and marks the next
    pieces critical, so a range is fetched before the rest. **Bug:** `end: 0` is falsy and reads to the end
    of the file, so the byte count must be enforced by the caller.
  - `torrent.bitfield.get(piece)`, `pieceLength`, `file.offset`, `file.done`, `numPeers`, `downloadSpeed`,
    `uploadSpeed` (bytes/s); `torrent.destroy({ destroyStore: false }, cb)` leaves the swarm and keeps the
    files; `client.destroy(cb)`.
  - fs-chunk-store writes `resolve(join(path, dirname(file.path)))` + basename stripped of
    `/[<>:"/\\|?*\u0000-\u001F]/g`; files are opened lazily on first write; parse-torrent normalizes `..`.
- Measured over loopback with the scratch install (DHT, trackers, LSD, UPnP, uTP off; peer added by
  address): file list in 113 ms; a 100 001-byte range at 87.5 % of a 4 MB file came back byte-exact after
  ~100 ms with 6 % of the file downloaded; with only the 38-byte `.srt` and the 4 MB `.mp4` selected, the
  disk held those two plus 63 194 bytes of the next file (`Sample/sample.mp4`, the edge of the shared last
  piece) and nothing of `setup.exe`; `client.remove` dropped the seeder's peer count to 0 at once. A
  partial downloader capped at `uploadLimit: 50000` uploaded 256 KiB to a third peer at 45 314 B/s (a
  seeder capped at 100 000 gave 77 554 B/s); the third peer, with `utPex: false`, connected to nobody else.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- Dependency `webtorrent@3.0.21` (`package.json`, `package-lock.json`) and `package.json` `allowScripts`
  (`node-datachannel@0.32.3: true`; `bufferutil`, `ip-set`, `utf-8-validate`, `utp-native`: false).
- `src/config.ts`: `TorrentConfig { enabled, dir, uploadKbps, keepDays, discovery, peers }`,
  `DEFAULT_TORRENT_CONFIG` (off, `dir` under the OS temp folder), `DEFAULT_TORRENT_UPLOAD_KBPS` (100),
  `DEFAULT_TORRENT_KEEP_DAYS` (7), `parseTorrent(env, dataDir)`, `Config.torrent?: TorrentConfig`.
  `dir` is the **resolved absolute folder** (`NOTESD_TORRENT_DIR`, default `<dataDir>/movies/torrents`).
  Env: `NOTESD_TORRENT`, `NOTESD_TORRENT_DIR`, `NOTESD_TORRENT_UPLOAD_KBPS` (kB/s, 1 kB = 1000 bytes),
  `NOTESD_TORRENT_KEEP_DAYS`, `NOTESD_TORRENT_DISCOVERY` (default on), `NOTESD_TORRENT_PEERS` (`host:port,...`).
- `src/db/schema.ts`: `streamTorrents` (`stream_torrents`, PK `(host, info_hash)`), `STREAM_TORRENT_STATES`,
  `StreamTorrentState`, `StreamTorrentFile`, `StreamTorrentRow`; migration `drizzle/0031_stream_torrents.sql`.
- `src/directStream/torrent/types.ts`: `TorrentFileInfo { index, path, name, length }`, `TorrentStats
  { peers, down_kbps, up_kbps }` (**kilobits** per second, as the stream evidence log's `kbps`),
  `TorrentHandle { infoHash, name, files, live, select, read, stats, ranges, done }` (`read`'s `end` is
  inclusive; `ranges` are `[from, to)` bytes), `TorrentAddSpec`, `TorrentEngine { add, get, remove, port,
  close }`, `TorrentPick { infoHash, trackers, name, ref, release? }` (`name` = the release name as an index
  lists it; `release` = anything, e.g. phase 2's `ReleaseInfo`, not read here), `TorrentDownload` (camelCase,
  what `find` answers), `TorrentDownloadView`, `TorrentFileView`, `TorrentMap`, `TorrentStatus`,
  `TorrentSwarmView`, `TorrentError` + `TorrentErrorCode`, `mediaOf`, `torrentContentType`,
  `normalizeInfoHash`, `INFO_HASH_PATTERN`, constants `TORRENT_SUBDIR`, `TORRENT_OPEN_TIMEOUT_MS` (60 s),
  `TORRENT_LINGER_MS` (3 min), `TORRENT_TICK_MS`, `TORRENT_PRUNE_EVERY_MS`, `PROGRESS_STEP_BYTES`,
  `PLAYED_EVERY_MS`, `BYTES_PER_KB`, `kilobits`.
- `src/directStream/torrent/webtorrent.d.ts`: ambient `declare module 'webtorrent'`.
- `src/directStream/torrent/engine.ts`: `WebTorrentEngine`, `WebTorrentEngineOptions`.
- `src/directStream/torrent/store.ts`: `TorrentFolder { root, dirOf, diskPath, contains, complete, dropFiles,
  remove }`, `DiskHandle`.
- `src/directStream/torrent/repo.ts`: `TorrentsRepo` (only writer of `stream_torrents`), `TorrentRecords`,
  `TorrentRecordSpec`, `TorrentChoice`, `torrentRef`.
- `src/directStream/torrent/serve.ts`: `diskFileResponse`, `swarmFileResponse`, `notOnThisMachine`.
- `src/directStream/torrent/service.ts`: `TorrentStreams` (`host`, `root`, `uploadKbps`, `keepDays`, `open`,
  `use`, `release`, `find`, `view`, `list`, `status`, `filePath`, `serve`, `map`, `setDuration`, `localUrl`,
  `start`, `tick`, `prune`, `close`), `TorrentStreamsOptions`, `buildTorrentStreams`.
- `src/http/streamTorrentApi.ts`: `streamTorrentRoutes`, `TORRENT_OFF`, `openBody`, `torrentErrorResponse`.
  Routes: `GET /api/stream/torrent`, `POST /api/stream/torrent`, `POST /api/stream/torrent/:hash/release`,
  `GET /api/stream/torrent/:hash`, `GET /api/stream/torrent/:hash/map`, `GET /api/stream/torrent/:hash/f/:index`.
- `AppDeps.torrents?: TorrentStreams | null`.
- verify-notesd: `verify.sh up --torrent` (shell var `torrent=1`, implies `--direct-stream`; pins
  `NOTESD_TORRENT=off` and `NOTESD_TORRENT_DIR` under the run otherwise; honours `TORRENT_FIXTURE_FILE`),
  `scripts/torrent/{make-fixture.sh,seed.mjs,torrent.sh}`; `<run>/torrent/fixture.json` and `pack.json`
  (`{info_hash, name, trackers: [], port, piece_length, files: [{index, path, length}]}`),
  `<run>/torrent/seeder.jsonl`; a folder moved into `<run>/torrent/seed/<name>/` is seeded by the same seeder and
  described in `<run>/torrent/seeded/<name>.json` (same shape), the one way later phases add fixture torrents.

**Signature changes:** `loadConfig` answers `torrent`; `startBackground` starts and closes `deps.torrents`.

**Requires (from earlier phases):** nothing.

**Leaves alone (owned by others):** `src/directStream/service.ts`, `sessions.ts`, `types.ts`, `cachePlay.ts`
(phase 3); `src/directStream/torrent/find/` (phase 2); `src/directStream/torrent/{source,probe,remux}.ts`,
`subtitles/` (phases 3, 5–8); `src/mcp/*`, `src/chat/*`, `claude/` (phases 3, 9); everything under `web/`
(phases 4, 5, 7); `scripts/install.sh` (phase 8).

## Files

| File | Action | What changes |
|---|---|---|
| `package.json`, `package-lock.json` | modify (npm) | `webtorrent` 3.0.21; `allowScripts` |
| `src/directStream/torrent/webtorrent.d.ts` | create | types for the webtorrent API used |
| `src/directStream/torrent/types.ts` | create | shared shapes, constants, `TorrentError`, media rules |
| `src/directStream/torrent/store.ts` | create | the torrent folder; `DiskHandle` |
| `src/directStream/torrent/engine.ts` | create | `WebTorrentEngine` |
| `src/directStream/torrent/repo.ts` | create | `TorrentsRepo` |
| `src/directStream/torrent/serve.ts` | create | Range answers from disk and from the swarm |
| `src/directStream/torrent/service.ts` | create | `TorrentStreams`, `buildTorrentStreams` |
| `src/db/schema.ts:1542` and `:1585` | modify | `stream_torrents` table and row type |
| `drizzle/0031_stream_torrents.sql`, `drizzle/meta/*` | create (generated) | the migration |
| `src/config.ts:2`, `:229`, `:392`, `:725`, `:745-748`, `:780` | modify | `TorrentConfig`, `parseTorrent`, `loadConfig` |
| `src/deps.ts:68` | modify | `torrents` |
| `src/daemon.ts:33`, `:218`, `:246` | modify | build `deps.torrents` |
| `src/background.ts:196`, `:221` | modify | start and close it |
| `src/http/streamTorrentApi.ts` | create | the routes |
| `src/http/app.ts:32`, `:113`, `:148` | modify | mount them |
| `scripts/docs/httpRoutes.ts:261` | modify | a "Torrents" group |
| `docs/guide/reference/http-api.md` | regenerate | `npm run docs:gen` |
| `docs/guide/reference/configuration.md:145` | modify | a "Torrents" section, six rows |
| `docs/guide/streaming.md:1104`, `:1125`, `:1160` | modify | `## Torrents` and this phase's subsection; code table; proving |
| `docs/guide/architecture.md:70`, `:94`, `:119` | modify | writer, data model, disk layout |
| `CLAUDE.md:92` | modify | one bullet under Direct streaming |
| `tests/unit/config.test.ts:56` | modify | `torrent` in the default config |
| `tests/unit/config.torrent.test.ts` | create | the settings |
| `tests/helpers/fakeTorrentEngine.ts` | create | an in-memory `TorrentEngine` |
| `tests/helpers/memoryTorrentRecords.ts` | create | `TorrentsRepo` in memory |
| `tests/unit/directStream/torrent/store.test.ts` | create | disk paths, refusal, dropping edges |
| `tests/unit/directStream/torrent/service.test.ts` | create | the service over the fake engine |
| `tests/unit/directStream/torrent/routes.test.ts` | create | the routes |
| `tests/unit/directStream/torrent/engine.test.ts` | create | the real engine over loopback |
| `tests/integration/setup.ts:50` | modify | truncate `stream_torrents` |
| `tests/integration/directStream.torrents.int.test.ts` | create | the table, two machines, replay from disk |
| `.claude/skills/verify-notesd/scripts/verify.sh` | modify | `--torrent`, pins, seeder lifecycle |
| `.claude/skills/verify-notesd/scripts/torrent/make-fixture.sh` | create | generated film and pack |
| `.claude/skills/verify-notesd/scripts/torrent/seed.mjs` | create | loopback seeder and test leecher |
| `.claude/skills/verify-notesd/scripts/torrent/torrent.sh` | create | the journeys |
| `.claude/skills/verify-notesd/SKILL.md:29` | modify | `--torrent` line |
| `.claude/skills/verify-notesd/features/direct-streaming.md:325` | modify | "Torrents" entry |
| `.claude/skills/verify-notesd/features/README.md` | modify | mention torrents in the direct-streaming row |

## Implementation Steps

### Step 1: Add webtorrent and approve its one native install script
**File:** `package.json` (dependencies), `package-lock.json`
**Change:** The worktree has no `node_modules`. From the worktree root:

```sh
npm ci
npm install webtorrent@3.0.21 --save-exact
npm install-scripts approve node-datachannel
npm install-scripts deny ip-set bufferutil utf-8-validate utp-native
npm rebuild node-datachannel
node --input-type=module -e "import('webtorrent').then((m) => console.log('webtorrent', m.default.VERSION))"
```

The last line must print `webtorrent 3.0.21`. `package.json` then has `"webtorrent": "3.0.21"` among
`dependencies` and (npm writes it) this block:

```json
  "allowScripts": {
    "node-datachannel@0.32.3": true,
    "bufferutil": false,
    "ip-set": false,
    "utf-8-validate": false,
    "utp-native": false
  }
```

If `npm install-scripts approve` writes a different pinned version than `0.32.3`, keep what npm wrote.
**Impact:** `npm ci` on either laptop now runs node-datachannel's `prebuild-install` (a download from
GitHub at install time). Nothing imports webtorrent yet.

### Step 2: Types for webtorrent
**File:** `src/directStream/torrent/webtorrent.d.ts` (new)
**Code:**
```ts
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
```
**Impact:** none at runtime; `tsc` finds the module's types.

### Step 3: The shared shapes
**File:** `src/directStream/torrent/types.ts` (new)
**Code:**
```ts
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { StreamTorrentState } from '../../db/schema.js';
import type { StreamRef } from '../types.js';

/**
 * Torrents as a direct-streaming source (torrent-stream-source phase 1): the shapes the engine, the
 * service, the routes and the later phases share. A torrent is named by its v1 info hash, 40 lower-case
 * hexadecimal characters, checked once where it enters (normalizeInfoHash).
 */

/** Where the downloads live under the data directory when NOTESD_TORRENT_DIR is unset. */
export const TORRENT_SUBDIR = path.join('movies', 'torrents');
/** How long `open` waits for a peer to send the file list. */
export const TORRENT_OPEN_TIMEOUT_MS = 60_000;
/** An unfinished torrent nothing uses leaves the swarm this long after its last file request. */
export const TORRENT_LINGER_MS = 3 * 60_000;
/** How often the service records progress, marks finished downloads and lets idle torrents go. */
export const TORRENT_TICK_MS = 5_000;
/** How often downloads not played for `keepDays` are looked for. */
export const TORRENT_PRUNE_EVERY_MS = 6 * 3_600_000;
/** Progress is written to the database at most once per this many new bytes (Neon egress). */
export const PROGRESS_STEP_BYTES = 16 * 1_048_576;
/** `played_at` is written at most once per minute per download. */
export const PLAYED_EVERY_MS = 60_000;
/** Bytes per second in one kB/s of NOTESD_TORRENT_UPLOAD_KBPS. */
export const BYTES_PER_KB = 1000;

/** Bytes per second as kilobits per second, the unit of the stream evidence log's `kbps` and the views' `*_kbps`. */
export function kilobits(bytesPerSecond: number): number {
  return Math.round((bytesPerSecond * 8) / 1000);
}

export const INFO_HASH_PATTERN = /^[0-9a-f]{40}$/;

/** A v1 info hash in any case, trimmed and lower-cased; null for anything else. */
export function normalizeInfoHash(raw: string): string | null {
  const hash = raw.trim().toLowerCase();
  return INFO_HASH_PATTERN.test(hash) ? hash : null;
}

const VIDEO_TYPES: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.wmv': 'video/x-ms-wmv',
};
const SUBTITLE_TYPES: Readonly<Record<string, string>> = {
  '.srt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.ass': 'text/plain; charset=utf-8',
  '.ssa': 'text/plain; charset=utf-8',
};

export type TorrentMedia = 'video' | 'subtitle';

/** What a torrent file is by its extension: the only two kinds notesd ever selects, reads or serves. */
export function mediaOf(name: string): TorrentMedia | null {
  const ext = path.extname(name).toLowerCase();
  if (Object.hasOwn(VIDEO_TYPES, ext)) return 'video';
  if (Object.hasOwn(SUBTITLE_TYPES, ext)) return 'subtitle';
  return null;
}

/** The content type a chosen file is served with; never one a browser would run. */
export function torrentContentType(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return VIDEO_TYPES[ext] ?? SUBTITLE_TYPES[ext] ?? 'application/octet-stream';
}

/** One file of a torrent: its index in the torrent, its path inside it (the torrent's name first), its size. */
export interface TorrentFileInfo {
  index: number;
  path: string;
  name: string;
  length: number;
}

/** A torrent's swarm now. Speeds in kilobits per second; all 0 for a download read from disk. */
export interface TorrentStats {
  peers: number;
  down_kbps: number;
  up_kbps: number;
}

/** An open torrent: from the swarm (`live`), or a finished download read from disk with no swarm. */
export interface TorrentHandle {
  readonly infoHash: string;
  readonly name: string;
  /** The swarm handle: every file of the torrent. A disk handle: the chosen files only. */
  readonly files: readonly TorrentFileInfo[];
  /** True while the pieces come from the swarm; false for a finished download read from disk. */
  readonly live: boolean;
  /** Downloads these files (in order); never anything else. A disk handle ignores it. */
  select(indexes: readonly number[]): void;
  /** Bytes start..end of one file, `end` inclusive, in order; the swarm fetches their pieces first. */
  read(index: number, range: { start: number; end: number }): Readable;
  stats(): TorrentStats;
  /** The stretches of one file that are on disk, `[from, to)` byte offsets, in order, never touching. */
  ranges(index: number): [number, number][];
  done(index: number): boolean;
}

export interface TorrentAddSpec {
  infoHash: string;
  /** Asked only with discovery on. */
  trackers: readonly string[];
  /** For the log; the torrent's own name comes with its file list. */
  name: string | null;
}

/** Joins swarms. WebTorrentEngine is the real one; tests inject a fake. */
export interface TorrentEngine {
  /** Resolves once a peer sent the file list (nothing selected); rejects TorrentError no_metadata / unsafe_path / engine_error / closing. */
  add(spec: TorrentAddSpec, options: { timeoutMs: number }): Promise<TorrentHandle>;
  get(infoHash: string): TorrentHandle | null;
  /** Leaves the swarm. `deleteFiles` also deletes the torrent's folder. */
  remove(infoHash: string, options: { deleteFiles: boolean }): Promise<void>;
  /** The listening port while any torrent is in the swarm, else null (no engine runs). */
  port(): number | null;
  close(): Promise<void>;
}

/** What a caller opens: a torrent for a title. */
export interface TorrentPick {
  infoHash: string;
  trackers: readonly string[];
  /** The release name as an index lists it (stored as the download's `release`); null when unknown. */
  name: string | null;
  ref: StreamRef;
  /** What the finder knows of the release (phase 2's ReleaseInfo). Not read in phase 1. */
  release?: unknown;
}

/** This host's record of a title's download with a chosen video (TorrentStreams.find). */
export interface TorrentDownload {
  infoHash: string;
  host: string;
  /** The torrent's own name. */
  name: string;
  release: string | null;
  fileIndex: number;
  fileLength: number | null;
  state: StreamTorrentState;
  durationS: number | null;
}

export interface TorrentFileView {
  index: number;
  path: string;
  length: number;
  media: TorrentMedia | null;
}

/** One download as the routes answer it. */
export interface TorrentDownloadView {
  info_hash: string;
  /** The machine whose disk holds the files. */
  host: string;
  /** True when `host` is this machine. */
  available: boolean;
  kind: 'movie' | 'tv';
  tmdb_id: number;
  season: number | null;
  episode: number | null;
  /** The torrent's own name. */
  name: string;
  /** The release name the index listed. */
  release: string | null;
  state: StreamTorrentState;
  error: string | null;
  /** The video among `files`; null before one was chosen. */
  file_index: number | null;
  file_length: number | null;
  /** The chosen files only. */
  files: TorrentFileView[];
  bytes_done: number;
  /** bytes_done / file_length, 0 to 1. */
  progress: number;
  duration_s: number | null;
  in_swarm: boolean;
  users: number;
  peers: number;
  down_kbps: number;
  up_kbps: number;
  /** `/api/stream/torrent/<hash>/f/<video index>`; null on the other machine or before a choice. */
  file_url: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  played_at: string | null;
}

/** `GET /api/stream/torrent/:hash/map`: the video's stretches on disk. */
export interface TorrentMap {
  /** Null until a caller set it (TorrentStreams.setDuration). */
  duration_s: number | null;
  /** `byte_ranges` in seconds by proportion; empty while `duration_s` is null. */
  ranges: [number, number][];
  length: number | null;
  /** `[from, to)` byte offsets of the video, in order. */
  byte_ranges: [number, number][];
}

export interface TorrentSwarmView extends TorrentStats {
  info_hash: string;
  name: string;
  users: number;
}

/** `GET /api/stream/torrent`: this machine's engine. */
export interface TorrentStatus {
  host: string;
  /** The engine's listening port; null while no torrent is in the swarm. */
  port: number | null;
  upload_cap_bytes_per_s: number;
  keep_days: number;
  discovery: boolean;
  swarm: TorrentSwarmView[];
}

export type TorrentErrorCode =
  | 'invalid_hash'
  | 'unknown_torrent'
  | 'not_on_this_machine'
  | 'not_open'
  | 'not_media'
  | 'no_metadata'
  | 'unsafe_path'
  | 'engine_error'
  | 'closing';

export class TorrentError extends Error {
  override readonly name = 'TorrentError';
  constructor(
    readonly code: TorrentErrorCode,
    message: string,
    readonly extra: { host?: string } = {},
  ) {
    super(message);
  }
}
```
**Impact:** none yet.

### Step 4: The schema and its migration
**File:** `src/db/schema.ts:1542` (after the closing `)` of `streamCaches`), and `:1585` (after `StreamCacheRow`)
**Change:** add the table, then generate the migration.
**Code (after line 1542):**
```ts

/** What a torrent download is doing (src/directStream/torrent/). The CHECK below keeps the same list. */
export const STREAM_TORRENT_STATES = ['downloading', 'ready', 'failed'] as const
export type StreamTorrentState = (typeof STREAM_TORRENT_STATES)[number]
/** One chosen file of a torrent download: its index in the torrent, its path inside it, its size. */
export interface StreamTorrentFile {
  index: number
  path: string
  length: number
}

/**
 * One torrent download on one host (migration 0031, torrent-stream-source phase 1). Written only by
 * TorrentsRepo (src/directStream/torrent/repo.ts). The files live in that host's torrent folder
 * (`<NOTESD_TORRENT_DIR>/<info hash>/`), so the other machine lists the row with `available: false`.
 * One row per host and info hash; the title slot is the one it was last opened for (a film is season 0,
 * episode 0, as in stream_caches); opening it for another slot forgets the chosen files. `files` are the
 * chosen files only (the video and its subtitles), `file_index` the video. `error` is set exactly when it
 * failed; `completed_at` exactly when it is ready, which needs a chosen video.
 */
export const streamTorrents = pgTable(
  'stream_torrents',
  {
    host: text('host').notNull(),
    infoHash: text('info_hash').notNull(),
    kind: text('kind').$type<MovieTitleKind>().notNull(),
    tmdbId: integer('tmdb_id').notNull(),
    season: integer('season').notNull().default(0),
    episode: integer('episode').notNull().default(0),
    /** The torrent's own name (its file list's root). */
    name: text('name').notNull(),
    /** The release name the index listed; null when it was opened by hash alone. */
    release: text('release'),
    trackers: jsonb('trackers').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    fileIndex: integer('file_index'),
    files: jsonb('files').$type<StreamTorrentFile[]>().notNull().default(sql`'[]'::jsonb`),
    fileLength: bigint('file_length', { mode: 'number' }),
    bytesDone: bigint('bytes_done', { mode: 'number' }).notNull().default(0),
    durationS: real('duration_s'),
    state: text('state').$type<StreamTorrentState>().notNull().default('downloading'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    /** The video was last read through the file route; downloads not played for NOTESD_TORRENT_KEEP_DAYS are deleted. */
    playedAt: timestamp('played_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    primaryKey({ columns: [t.host, t.infoHash] }),
    index('stream_torrents_slot_idx').on(t.kind, t.tmdbId, t.season, t.episode, t.host),
    check('stream_torrents_info_hash_check', sql`${t.infoHash} ~ '^[0-9a-f]{40}$'`),
    check('stream_torrents_kind_check', sql`${t.kind} in ('movie', 'tv')`),
    check(
      'stream_torrents_slot_check',
      sql`${t.tmdbId} > 0 and ((${t.kind} = 'movie' and ${t.season} = 0 and ${t.episode} = 0) or (${t.kind} = 'tv' and ${t.season} >= 0 and ${t.episode} > 0))`,
    ),
    check('stream_torrents_state_check', sql`${t.state} in ('downloading', 'ready', 'failed')`),
    check('stream_torrents_failed_check', sql`(${t.state} = 'failed') = (${t.error} is not null)`),
    check(
      'stream_torrents_ready_check',
      sql`(${t.state} = 'ready') = (${t.completedAt} is not null) and (${t.state} <> 'ready' or ${t.fileIndex} is not null)`,
    ),
    check(
      'stream_torrents_counts_check',
      sql`${t.bytesDone} >= 0 and (${t.fileLength} is null or ${t.fileLength} >= 0) and (${t.fileIndex} is null or ${t.fileIndex} >= 0) and (${t.durationS} is null or ${t.durationS} > 0)`,
    ),
  ],
)
```
**Code (after line 1585, `export type StreamCacheRow = ...`):**
```ts
export type StreamTorrentRow = typeof streamTorrents.$inferSelect
```
**Then generate** (drizzle-kit needs a direct URL in the environment but does not connect for `generate`):
```sh
DATABASE_URL_UNPOOLED=postgres://gen@127.0.0.1:1/gen npm run db:generate -- --name stream_torrents
```
It writes `drizzle/0031_stream_torrents.sql`, `drizzle/meta/0031_snapshot.json` and a journal entry. The SQL
must be one `CREATE TABLE "stream_torrents"` with the columns above, `CONSTRAINT
"stream_torrents_host_info_hash_pk" PRIMARY KEY("host","info_hash")`, the seven checks, and
`CREATE INDEX "stream_torrents_slot_idx"`. Nothing else may be in it; if drizzle-kit proposes other changes
the schema drifted and that must be fixed first.
**Impact:** a new table only; `primaryKey`, `jsonb`, `bigint`, `real`, `index`, `check` are already imported
at the top of `schema.ts`.

### Step 5: The torrent folder and the disk handle
**File:** `src/directStream/torrent/store.ts` (new)
**Code:**
```ts
import { createReadStream } from 'node:fs';
import { rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { TorrentFileInfo, TorrentHandle, TorrentStats } from './types.js';

/** fs-chunk-store 5 (webtorrent's disk store) drops these characters from a file's last name; disk paths must match. */
const RESERVED_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001F]/g;

/**
 * `<root>/<info hash>/`: where one torrent's files are written, at the paths webtorrent's store uses.
 * Other phases may keep their own files under a torrent's folder (subtitles, a remux); this class only
 * ever deletes the torrent's own files by path, or the whole folder when the download is cleared.
 */
export class TorrentFolder {
  constructor(readonly root: string) {}

  /** The info hash is checked (40 hex) before it gets here, so the folder never leaves the root. */
  dirOf(infoHash: string): string {
    return path.join(this.root, infoHash);
  }

  /**
   * Where webtorrent writes a torrent file: `resolve(join(dir, dirname(path)))` plus the last name without
   * reserved characters, exactly as fs-chunk-store does. Null when that would not be inside the folder.
   */
  diskPath(infoHash: string, filePath: string): string | null {
    const dir = this.dirOf(infoHash);
    const target = path.join(path.resolve(path.join(dir, path.dirname(filePath))), path.basename(filePath).replace(RESERVED_NAME_CHARS, ''));
    return target.startsWith(`${dir}${path.sep}`) ? target : null;
  }

  contains(infoHash: string, filePath: string): boolean {
    return this.diskPath(infoHash, filePath) !== null;
  }

  /** The file's absolute path when it is on disk at its full size, else null. */
  async complete(infoHash: string, filePath: string, length: number): Promise<string | null> {
    const target = this.diskPath(infoHash, filePath);
    if (target === null) return null;
    try {
      const s = await stat(target);
      return s.isFile() && s.size === length ? target : null;
    } catch {
      return null;
    }
  }

  /**
   * Deletes these files of the torrent (those not chosen: the edge bytes of pieces they share with a chosen
   * file), then the folders they leave empty. Anything else under the folder is left. Returns how many went.
   */
  async dropFiles(infoHash: string, filePaths: readonly string[]): Promise<number> {
    const dir = this.dirOf(infoHash);
    let removed = 0;
    for (const filePath of filePaths) {
      const target = this.diskPath(infoHash, filePath);
      if (target === null) continue;
      try {
        await rm(target);
      } catch {
        continue; // never written
      }
      removed += 1;
      let parent = path.dirname(target);
      while (parent.startsWith(`${dir}${path.sep}`)) {
        try {
          await rmdir(parent);
        } catch {
          break; // not empty
        }
        parent = path.dirname(parent);
      }
    }
    return removed;
  }

  /** Deletes the torrent's folder and everything in it. */
  async remove(infoHash: string): Promise<void> {
    await rm(this.dirOf(infoHash), { recursive: true, force: true });
  }
}

/** A finished download read from disk: no swarm, no engine. Its files are the chosen ones only. */
export class DiskHandle implements TorrentHandle {
  readonly live = false;

  constructor(
    readonly infoHash: string,
    readonly name: string,
    readonly files: readonly TorrentFileInfo[],
    private readonly paths: ReadonlyMap<number, string>,
  ) {}

  select(): void {}

  read(index: number, range: { start: number; end: number }): Readable {
    const file = this.paths.get(index);
    if (file === undefined) throw new RangeError(`file ${index} of ${this.infoHash} is not on disk`);
    return createReadStream(file, { start: range.start, end: range.end });
  }

  stats(): TorrentStats {
    return { peers: 0, down_kbps: 0, up_kbps: 0 };
  }

  ranges(index: number): [number, number][] {
    const file = this.files.find((f) => f.index === index);
    return file !== undefined && file.length > 0 ? [[0, file.length]] : [];
  }

  done(index: number): boolean {
    return this.paths.has(index);
  }
}
```
**Impact:** none yet.

### Step 6: The engine
**File:** `src/directStream/torrent/engine.ts` (new)
**Change:** webtorrent is imported only by type at the top and loaded with `import()` when the first torrent
is opened, so a daemon with torrents off (or a machine where the native module did not build) never loads
it, and no DHT node or listener exists until a torrent is opened. The client is destroyed when its last
torrent leaves.
**Code:**
```ts
import { rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type WebTorrent from 'webtorrent';
import type { Torrent, TorrentFile } from 'webtorrent';
import type { TorrentFolder } from './store.js';
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
  /** uTP beside TCP; default true. The loopback tests turn it off. */
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
    const client = new Ctor({
      dht: discovery,
      tracker: discovery ? {} : false,
      lsd: false,
      natUpnp: false,
      natPmp: false,
      webSeeds: false,
      utp: this.opts.utp ?? true,
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
```
**Impact:** none until something builds a `WebTorrentEngine` (step 9).

### Step 7: The repository
**File:** `src/directStream/torrent/repo.ts` (new)
**Code:**
```ts
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { streamTorrents, type StreamTorrentFile, type StreamTorrentRow } from '../../db/schema.js';
import { cacheSlot } from '../repo.js';
import type { StreamRef } from '../types.js';

/** What `record` writes for an open torrent. */
export interface TorrentRecordSpec {
  infoHash: string;
  ref: StreamRef;
  /** The torrent's own name. */
  name: string;
  /** The release name the index listed. */
  release: string | null;
  trackers: readonly string[];
}

/** The chosen files: the video (`fileIndex`) and its subtitles. */
export interface TorrentChoice {
  files: StreamTorrentFile[];
  fileIndex: number | null;
  fileLength: number | null;
}

/** The title a row holds. */
export function torrentRef(row: Pick<StreamTorrentRow, 'kind' | 'tmdbId' | 'season' | 'episode'>): StreamRef {
  return row.kind === 'movie' ? { kind: 'movie', tmdbId: row.tmdbId } : { kind: 'tv', tmdbId: row.tmdbId, season: row.season, episode: row.episode };
}

const key = (host: string, infoHash: string) => and(eq(streamTorrents.host, host), eq(streamTorrents.infoHash, infoHash));

/** The only writer of `stream_torrents`. */
export class TorrentsRepo {
  constructor(private readonly db: Db) {}

  /**
   * This host's row of a torrent, made now (downloading) when there is none. An existing one takes the
   * new title slot, name and trackers; a failed one, or one opened for another slot, starts over
   * (downloading); another slot also forgets the chosen files.
   */
  async record(host: string, spec: TorrentRecordSpec, now: Date): Promise<StreamTorrentRow> {
    const slot = cacheSlot(spec.ref);
    const [inserted] = await this.db
      .insert(streamTorrents)
      .values({ host, infoHash: spec.infoHash, ...slot, name: spec.name, release: spec.release, trackers: [...spec.trackers], state: 'downloading', createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: [streamTorrents.host, streamTorrents.infoHash] })
      .returning();
    if (inserted !== undefined) return inserted;
    const existing = await this.get(host, spec.infoHash);
    if (existing === null) throw new Error(`the torrent ${spec.infoHash} on ${host} vanished while it was recorded`);
    const sameSlot = existing.kind === slot.kind && existing.tmdbId === slot.tmdbId && existing.season === slot.season && existing.episode === slot.episode;
    const restart = !sameSlot || existing.state === 'failed';
    const [row] = await this.db
      .update(streamTorrents)
      .set({
        ...slot,
        name: spec.name,
        release: spec.release ?? existing.release,
        trackers: spec.trackers.length > 0 ? [...spec.trackers] : existing.trackers,
        updatedAt: now,
        ...(restart ? { state: 'downloading' as const, error: null, completedAt: null } : {}),
        ...(sameSlot ? {} : { fileIndex: null, files: [], fileLength: null, bytesDone: 0, durationS: null }),
      })
      .where(key(host, spec.infoHash))
      .returning();
    if (row === undefined) throw new Error(`the torrent ${spec.infoHash} on ${host} vanished while it was recorded`);
    return row;
  }

  async get(host: string, infoHash: string): Promise<StreamTorrentRow | null> {
    const [row] = await this.db.select().from(streamTorrents).where(key(host, infoHash));
    return row ?? null;
  }

  /** Every host's row of a torrent. */
  async byHash(infoHash: string): Promise<StreamTorrentRow[]> {
    return this.db.select().from(streamTorrents).where(eq(streamTorrents.infoHash, infoHash)).orderBy(asc(streamTorrents.host));
  }

  /** One host's rows of a title slot: ready ones first, then the most recently written. */
  async forRef(host: string, ref: StreamRef): Promise<StreamTorrentRow[]> {
    const s = cacheSlot(ref);
    return this.db
      .select()
      .from(streamTorrents)
      .where(
        and(
          eq(streamTorrents.host, host),
          eq(streamTorrents.kind, s.kind),
          eq(streamTorrents.tmdbId, s.tmdbId),
          eq(streamTorrents.season, s.season),
          eq(streamTorrents.episode, s.episode),
        ),
      )
      .orderBy(sql`(${streamTorrents.state} = 'ready') desc`, desc(streamTorrents.updatedAt));
  }

  /** Every row of both hosts, newest first. */
  async all(): Promise<StreamTorrentRow[]> {
    return this.db.select().from(streamTorrents).orderBy(desc(streamTorrents.createdAt), asc(streamTorrents.host), asc(streamTorrents.infoHash));
  }

  async chosen(host: string, infoHash: string, choice: TorrentChoice, now: Date): Promise<StreamTorrentRow> {
    const [row] = await this.db
      .update(streamTorrents)
      .set({ files: choice.files, fileIndex: choice.fileIndex, fileLength: choice.fileLength, updatedAt: now })
      .where(key(host, infoHash))
      .returning();
    if (row === undefined) throw new Error(`no torrent ${infoHash} on ${host}`);
    return row;
  }

  async progress(host: string, infoHash: string, bytesDone: number, now: Date): Promise<void> {
    await this.db.update(streamTorrents).set({ bytesDone, updatedAt: now }).where(key(host, infoHash));
  }

  /** Every chosen file is whole on disk. Needs a chosen video (the CHECK refuses otherwise). */
  async ready(host: string, infoHash: string, bytesDone: number, now: Date): Promise<StreamTorrentRow> {
    const [row] = await this.db
      .update(streamTorrents)
      .set({ state: 'ready', error: null, completedAt: now, bytesDone, updatedAt: now })
      .where(key(host, infoHash))
      .returning();
    if (row === undefined) throw new Error(`no torrent ${infoHash} on ${host}`);
    return row;
  }

  async failed(host: string, infoHash: string, error: string, now: Date): Promise<void> {
    await this.db.update(streamTorrents).set({ state: 'failed', error, completedAt: null, updatedAt: now }).where(key(host, infoHash));
  }

  /** A ready download whose files are gone: downloading again from nothing. */
  async restarted(host: string, infoHash: string, now: Date): Promise<void> {
    await this.db.update(streamTorrents).set({ state: 'downloading', error: null, completedAt: null, bytesDone: 0, updatedAt: now }).where(key(host, infoHash));
  }

  async played(host: string, infoHash: string, now: Date): Promise<void> {
    await this.db.update(streamTorrents).set({ playedAt: now }).where(key(host, infoHash));
  }

  async duration(host: string, infoHash: string, seconds: number, now: Date): Promise<void> {
    await this.db.update(streamTorrents).set({ durationS: seconds, updatedAt: now }).where(key(host, infoHash));
  }

  /** One host's rows last played (else finished, else made) before `before`. */
  async stale(host: string, before: Date): Promise<StreamTorrentRow[]> {
    return this.db
      .select()
      .from(streamTorrents)
      .where(
        and(
          eq(streamTorrents.host, host),
          sql`coalesce(${streamTorrents.playedAt}, ${streamTorrents.completedAt}, ${streamTorrents.createdAt}) < ${before.toISOString()}::timestamptz`,
        ),
      );
  }

  async delete(host: string, infoHash: string): Promise<boolean> {
    const rows = await this.db.delete(streamTorrents).where(key(host, infoHash)).returning({ infoHash: streamTorrents.infoHash });
    return rows.length > 0;
  }
}

/** What TorrentStreams needs of the repository (tests pass an in-memory one). */
export type TorrentRecords = Pick<
  TorrentsRepo,
  'record' | 'get' | 'byHash' | 'forRef' | 'all' | 'chosen' | 'progress' | 'ready' | 'failed' | 'restarted' | 'played' | 'duration' | 'stale' | 'delete'
>;
```
**Impact:** none yet.

### Step 8: Range answers
**File:** `src/directStream/torrent/serve.ts` (new)
**Code:**
```ts
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { parseRange } from '../cache/serve.js';
import { torrentContentType, type TorrentHandle } from './types.js';

function refused(size: number): Response {
  return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes', 'cache-control': 'no-store' } });
}

function answer(body: ReadableStream<Uint8Array> | null, name: string, size: number, range: { start: number; end: number } | null, cacheControl: string): Response {
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const headers = new Headers({
    'content-type': torrentContentType(name),
    'accept-ranges': 'bytes',
    'x-content-type-options': 'nosniff',
    'cache-control': cacheControl,
    'content-length': String(size === 0 ? 0 : end - start + 1),
  });
  if (range !== null) headers.set('content-range', `bytes ${start}-${end}/${size}`);
  return new Response(body, { status: range === null ? 200 : 206, headers });
}

/** A finished torrent file from this machine's disk: 200, 206 for one Range, 416 for one that cannot be served. */
export async function diskFileResponse(file: string, name: string, rangeHeader: string | null): Promise<Response> {
  const size = (await stat(file)).size;
  const range = parseRange(rangeHeader, size);
  if (range === 'invalid') return refused(size);
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const body = size === 0 ? null : (Readable.toWeb(createReadStream(file, { start, end })) as unknown as ReadableStream<Uint8Array>);
  return answer(body, name, size, range, 'private, max-age=3600');
}

/**
 * A chosen file that is still coming: the range's bytes are read through the handle, whose engine fetches
 * their pieces before the rest of the file. Never cached by the browser (the file is not whole yet).
 */
export function swarmFileResponse(handle: TorrentHandle, file: { index: number; path: string; length: number }, rangeHeader: string | null): Response {
  const size = file.length;
  const range = parseRange(rangeHeader, size);
  if (range === 'invalid') return refused(size);
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const body = size === 0 ? null : (Readable.toWeb(handle.read(file.index, { start, end })) as unknown as ReadableStream<Uint8Array>);
  return answer(body, file.path, size, range, 'no-store');
}

export function notOnThisMachine(host: string): Response {
  return new Response(JSON.stringify({ error: 'not_on_this_machine', host, message: `This torrent was downloaded on ${host}; its files are only there.` }), {
    status: 404,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
```
**Impact:** none yet.

### Step 9: The service
**File:** `src/directStream/torrent/service.ts` (new)
**Change:** `TorrentStreams` is the only thing that opens torrents, counts their users and decides when one
leaves the swarm. Rules, in code below:
- `open` is idempotent per hash (same handle while open, one shared promise while opening). A download that
  is `ready` on this host for the same title and whose chosen files are whole on disk answers a `DiskHandle`
  and never touches the engine (R2.9). One whose files vanished is marked `restarted` and opened again.
- `use` checks every index is a video or subtitle file of the torrent (else `not_media`, nothing changes),
  selects them, counts one user, and records the choice (the first video is the download's video).
- `release` counts a user down; with none left, a finished download leaves at once and an unfinished one
  `lingerMs` after its last file request (the tick decides). Releasing a torrent opened and never used
  drops it at once; an unknown hash is ignored.
- Leaving deletes, from the torrent folder, only the torrent's files that were not chosen (edges of shared
  pieces); other files under the folder (later phases' subtitles or remux) stay.
- The file route serves chosen files only: from disk when whole, else through the swarm handle; it never
  joins a swarm by itself (`409 not_in_swarm` when the download is unfinished and not open).
- Progress is written at most every `PROGRESS_STEP_BYTES`; `played_at` at most once a minute.
**Code:**
```ts
import path from 'node:path';
import type { Config } from '../../config.js';
import type { Db } from '../../db/client.js';
import type { StreamTorrentFile, StreamTorrentRow } from '../../db/schema.js';
import { jsonError } from '../passThrough.js';
import type { StreamRef } from '../types.js';
import { WebTorrentEngine } from './engine.js';
import { torrentRef, TorrentsRepo, type TorrentRecords, type TorrentRecordSpec } from './repo.js';
import { diskFileResponse, notOnThisMachine, swarmFileResponse } from './serve.js';
import { DiskHandle, TorrentFolder } from './store.js';
import {
  BYTES_PER_KB,
  mediaOf,
  normalizeInfoHash,
  PLAYED_EVERY_MS,
  PROGRESS_STEP_BYTES,
  TORRENT_LINGER_MS,
  TORRENT_PRUNE_EVERY_MS,
  TORRENT_TICK_MS,
  TorrentError,
  type TorrentDownload,
  type TorrentDownloadView,
  type TorrentEngine,
  type TorrentFileInfo,
  type TorrentHandle,
  type TorrentMap,
  type TorrentPick,
  type TorrentStatus,
} from './types.js';

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const sumRanges = (ranges: readonly [number, number][]): number => ranges.reduce((n, [from, to]) => n + (to - from), 0);
const round1 = (n: number): number => Math.round(n * 10) / 10;
const sameRef = (a: StreamRef, b: StreamRef): boolean =>
  a.kind === b.kind && a.tmdbId === b.tmdbId && (a.kind === 'movie' || (b.kind === 'tv' && a.season === b.season && a.episode === b.episode));

export interface TorrentStreamsOptions {
  engine: TorrentEngine;
  repo: TorrentRecords;
  folder: TorrentFolder;
  /** os.hostname(): rows are made under it, and only its rows' files are here. */
  host: string;
  /** NOTESD_TORRENT_UPLOAD_KBPS, for the status (the engine applies it). */
  uploadKbps: number;
  /** NOTESD_TORRENT_KEEP_DAYS. */
  keepDays: number;
  /** NOTESD_TORRENT_DISCOVERY, for the status. */
  discovery: boolean;
  lingerMs?: number;
  tickMs?: number;
  now?: () => Date;
  log?: (line: string) => void;
  /** Runs `fn` every `ms`; answers how to stop it. Default setInterval, unref'd. Tests pass a no-op and call tick(). */
  every?: (fn: () => void, ms: number) => () => void;
}

/** A torrent in the swarm. A finished download read from disk is never one. */
interface Active {
  handle: TorrentHandle;
  /** Stream sessions (and the open route) using it now. */
  users: number;
  /** The last use, release or file request, in ms. */
  lastRequestAt: number;
  /** This host's row as last written; ticks read it instead of the database. */
  row: StreamTorrentRow;
}

const defaultEvery = (fn: () => void, ms: number): (() => void) => {
  const timer = setInterval(fn, ms);
  timer.unref();
  return () => clearInterval(timer);
};

/**
 * This host's torrent downloads (torrent-stream-source phase 1). Held in AppDeps.torrents; the routes
 * (src/http/streamTorrentApi.ts) and, from phase 3, the stream sessions call it. A torrent is in the swarm
 * only while something uses it; the engine itself runs only while a torrent is in the swarm.
 */
export class TorrentStreams {
  private readonly engine: TorrentEngine;
  private readonly repo: TorrentRecords;
  private readonly folder: TorrentFolder;
  private readonly lingerMs: number;
  private readonly tickMs: number;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly every: (fn: () => void, ms: number) => () => void;
  private readonly active = new Map<string, Active>();
  private readonly opening = new Map<string, Promise<TorrentHandle>>();
  private readonly playedAt = new Map<string, number>();
  private stopTimer: (() => void) | null = null;
  private lastPrune = 0;
  private ticking = false;
  private closed = false;

  constructor(private readonly opts: TorrentStreamsOptions) {
    this.engine = opts.engine;
    this.repo = opts.repo;
    this.folder = opts.folder;
    this.lingerMs = opts.lingerMs ?? TORRENT_LINGER_MS;
    this.tickMs = opts.tickMs ?? TORRENT_TICK_MS;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((line: string) => console.log(line));
    this.every = opts.every ?? defaultEvery;
  }

  get host(): string {
    return this.opts.host;
  }

  get root(): string {
    return this.folder.root;
  }

  get uploadKbps(): number {
    return this.opts.uploadKbps;
  }

  get keepDays(): number {
    return this.opts.keepDays;
  }

  /** Clears downloads not played for `keepDays` and starts the tick. Joins nothing. Returns how many were cleared. */
  async start(): Promise<number> {
    const cleared = await this.prune();
    this.stopTimer ??= this.every(() => void this.tick(), this.tickMs);
    return cleared;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopTimer?.();
    this.stopTimer = null;
    this.active.clear();
    await this.engine.close();
  }

  /**
   * Opens a torrent for a title and answers once its file list is known, with nothing selected. The same
   * handle while it is open. A download finished on this host for the same title answers from disk.
   */
  async open(pick: TorrentPick, options: { timeoutMs: number }): Promise<TorrentHandle> {
    const infoHash = normalizeInfoHash(pick.infoHash);
    if (infoHash === null) throw new TorrentError('invalid_hash', 'An info hash is 40 hexadecimal characters.');
    if (this.closed) throw new TorrentError('closing', 'The daemon is stopping.');
    const live = this.active.get(infoHash);
    if (live !== undefined) {
      live.lastRequestAt = this.nowMs();
      return live.handle;
    }
    const pending = this.opening.get(infoHash);
    if (pending !== undefined) return pending;
    const opened = this.openNow({ ...pick, infoHash }, options).finally(() => this.opening.delete(infoHash));
    this.opening.set(infoHash, opened);
    return opened;
  }

  /**
   * Selects these files (videos and subtitles only) and counts one more user. On a finished download read
   * from disk it only marks the play (nothing joins a swarm). Throws not_open, not_media, invalid_hash.
   */
  async use(infoHash: string, fileIndexes: readonly number[]): Promise<void> {
    const hash = normalizeInfoHash(infoHash);
    if (hash === null) throw new TorrentError('invalid_hash', 'An info hash is 40 hexadecimal characters.');
    const live = this.active.get(hash);
    if (live === undefined) {
      const row = await this.repo.get(this.host, hash);
      if (row !== null && row.state === 'ready' && fileIndexes.every((i) => row.files.some((f) => f.index === i)) && (await this.diskHandle(row)) !== null) {
        await this.notePlayed(row, true);
        return;
      }
      throw new TorrentError('not_open', 'Open the torrent before using its files.');
    }
    const chosen = this.mediaFiles(live.handle, fileIndexes);
    live.handle.select(chosen.map((f) => f.index));
    live.users += 1;
    live.lastRequestAt = this.nowMs();
    const files: StreamTorrentFile[] = live.row.files.map((f) => ({ ...f }));
    for (const f of chosen) if (!files.some((m) => m.index === f.index)) files.push({ index: f.index, path: f.path, length: f.length });
    const fileIndex = live.row.fileIndex ?? chosen.find((f) => mediaOf(f.name) === 'video')?.index ?? null;
    const fileLength = files.find((f) => f.index === fileIndex)?.length ?? null;
    live.row = await this.repo.chosen(this.host, hash, { files, fileIndex, fileLength }, this.now());
  }

  /**
   * One user fewer. With none left, a finished download leaves the swarm at once and an unfinished one
   * `lingerMs` after its last file request. A torrent opened and never used leaves at once. Unknown: ignored.
   */
  async release(infoHash: string): Promise<void> {
    const hash = normalizeInfoHash(infoHash);
    const live = hash === null ? undefined : this.active.get(hash);
    if (hash === null || live === undefined) return;
    live.lastRequestAt = this.nowMs();
    if (live.users === 0) {
      await this.leave(hash, live, 'it was opened and never used');
      return;
    }
    live.users -= 1;
    if (live.users === 0) await this.settle(hash, live);
  }

  /** This host's best record of a title with a chosen video: a ready one first, then the most recent. */
  async find(ref: StreamRef): Promise<TorrentDownload | null> {
    for (const stored of await this.repo.forRef(this.host, ref)) {
      const row = this.active.get(stored.infoHash)?.row ?? stored;
      if (row.fileIndex === null) continue;
      return {
        infoHash: row.infoHash,
        host: row.host,
        name: row.name,
        release: row.release,
        fileIndex: row.fileIndex,
        fileLength: row.fileLength,
        state: row.state,
        durationS: row.durationS,
      };
    }
    return null;
  }

  /** One download: this host's, else the other machine's (`available: false`); null when none. */
  async view(infoHash: string): Promise<TorrentDownloadView | null> {
    const hash = normalizeInfoHash(infoHash);
    if (hash === null) return null;
    const live = this.active.get(hash);
    if (live !== undefined) return this.viewOf(live.row);
    const rows = await this.repo.byHash(hash);
    const row = rows.find((r) => r.host === this.host) ?? rows[0];
    return row === undefined ? null : this.viewOf(row);
  }

  /** Every download of both machines, newest first. */
  async list(): Promise<TorrentDownloadView[]> {
    return (await this.repo.all()).map((row) => this.viewOf(row.host === this.host ? (this.active.get(row.infoHash)?.row ?? row) : row));
  }

  status(): TorrentStatus {
    return {
      host: this.host,
      port: this.engine.port(),
      upload_cap_bytes_per_s: this.opts.uploadKbps * BYTES_PER_KB,
      keep_days: this.opts.keepDays,
      discovery: this.opts.discovery,
      swarm: [...this.active.entries()].map(([hash, live]) => ({ info_hash: hash, name: live.row.name, users: live.users, ...live.handle.stats() })),
    };
  }

  /** The absolute path of a chosen file once it is whole on this machine's disk, else null. */
  async filePath(infoHash: string, index: number): Promise<string | null> {
    const hash = normalizeInfoHash(infoHash);
    if (hash === null) return null;
    const found = await this.rowHere(hash);
    if (found instanceof Response) return null;
    const file = found.files.find((f) => f.index === index);
    if (file === undefined) return null;
    if (found.state !== 'ready' && this.active.get(hash)?.handle.done(index) !== true) return null;
    return this.folder.complete(hash, file.path, file.length);
  }

  /**
   * GET /api/stream/torrent/:hash/f/:index. A chosen file with Range: from disk when it is whole, else
   * through the swarm, whose pieces for the range come first. 404 unknown_torrent / not_on_this_machine /
   * not_selected, 409 not_in_swarm (unfinished and not open: play it to carry on), 503 closing.
   */
  async serve(infoHash: string, index: number, rangeHeader: string | null): Promise<Response> {
    const hash = normalizeInfoHash(infoHash);
    if (hash === null || !Number.isSafeInteger(index) || index < 0) return jsonError(404, 'unknown_torrent', 'No torrent download has this info hash.');
    const found = await this.rowHere(hash);
    if (found instanceof Response) return found;
    const file = found.files.find((f) => f.index === index);
    if (file === undefined) return jsonError(404, 'not_selected', 'That file of the torrent is not one this machine downloads.');
    await this.notePlayed(found, index === found.fileIndex);
    const live = this.active.get(hash);
    if (found.state === 'ready' || live?.handle.done(index) === true) {
      const onDisk = await this.folder.complete(hash, file.path, file.length);
      if (onDisk !== null) return diskFileResponse(onDisk, file.path, rangeHeader);
    }
    if (this.closed) return jsonError(503, 'closing', 'The daemon is stopping.');
    if (live === undefined) return jsonError(409, 'not_in_swarm', 'This torrent is not being downloaded now; play it again to carry on.');
    live.lastRequestAt = this.nowMs();
    return swarmFileResponse(live.handle, file, rangeHeader);
  }

  /** The video's stretches on this machine's disk; null for an unknown hash or the other machine's. */
  async map(infoHash: string): Promise<TorrentMap | null> {
    const hash = normalizeInfoHash(infoHash);
    if (hash === null) return null;
    const found = await this.rowHere(hash);
    if (found instanceof Response) return null;
    const live = this.active.get(hash);
    const length = found.fileLength;
    let bytes: [number, number][] = [];
    if (found.fileIndex !== null && length !== null) {
      if (found.state === 'ready') bytes = length > 0 ? [[0, length]] : [];
      else if (live !== undefined) bytes = live.handle.ranges(found.fileIndex);
    }
    const duration = found.durationS;
    const ranges: [number, number][] =
      duration === null || length === null || length === 0 ? [] : bytes.map(([from, to]) => [round1((from / length) * duration), round1((to / length) * duration)]);
    return { duration_s: duration, ranges, length, byte_ranges: bytes };
  }

  /** The video's length in seconds, once a caller knows it (phase 3's probe): the map turns bytes into seconds with it. */
  async setDuration(infoHash: string, seconds: number): Promise<void> {
    const hash = normalizeInfoHash(infoHash);
    if (hash === null || !Number.isFinite(seconds) || seconds <= 0) return;
    await this.repo.duration(this.host, hash, seconds, this.now());
    const live = this.active.get(hash);
    if (live !== undefined) live.row = { ...live.row, durationS: seconds };
  }

  localUrl(infoHash: string, index: number): string {
    return `/api/stream/torrent/${infoHash}/f/${index}`;
  }

  /** The timer's work: progress, finished downloads, idle torrents leaving, and now and then the prune. */
  async tick(): Promise<void> {
    if (this.ticking || this.closed) return;
    this.ticking = true;
    try {
      for (const [hash, live] of [...this.active]) {
        try {
          await this.settle(hash, live);
        } catch (err) {
          this.log(`[notesd] torrent: ${live.row.name}: ${messageOf(err)}`);
        }
      }
      if (this.nowMs() - this.lastPrune >= TORRENT_PRUNE_EVERY_MS) await this.prune();
    } finally {
      this.ticking = false;
    }
  }

  /** Deletes this host's downloads not played for `keepDays`, with their folders. Never throws. */
  async prune(): Promise<number> {
    this.lastPrune = this.nowMs();
    let cleared = 0;
    try {
      const before = new Date(this.nowMs() - this.opts.keepDays * 86_400_000);
      for (const row of await this.repo.stale(this.host, before)) {
        if (this.active.has(row.infoHash) || this.opening.has(row.infoHash)) continue;
        await this.folder.remove(row.infoHash);
        await this.repo.delete(this.host, row.infoHash);
        cleared += 1;
        this.log(`[notesd] torrent: cleared ${row.name}, not played for ${this.opts.keepDays} days`);
      }
    } catch (err) {
      this.log(`[notesd] torrent: could not clear old downloads: ${messageOf(err)}`);
    }
    return cleared;
  }

  private nowMs(): number {
    return this.now().getTime();
  }

  private async openNow(pick: TorrentPick, options: { timeoutMs: number }): Promise<TorrentHandle> {
    const existing = await this.repo.get(this.host, pick.infoHash);
    if (existing !== null && existing.state === 'ready' && sameRef(torrentRef(existing), pick.ref)) {
      const disk = await this.diskHandle(existing);
      if (disk !== null) return disk;
      await this.repo.restarted(this.host, pick.infoHash, this.now());
      this.log(`[notesd] torrent: ${existing.name} was finished but its files are gone from ${this.folder.dirOf(pick.infoHash)}; downloading it again`);
    }
    const spec = (name: string): TorrentRecordSpec => ({ infoHash: pick.infoHash, ref: pick.ref, name, release: pick.name, trackers: pick.trackers });
    let handle: TorrentHandle;
    try {
      handle = await this.engine.add({ infoHash: pick.infoHash, trackers: pick.trackers, name: pick.name }, options);
    } catch (err) {
      const failure = err instanceof TorrentError ? err : new TorrentError('engine_error', messageOf(err));
      if (failure.code !== 'closing') {
        await this.repo.record(this.host, spec(existing?.name ?? pick.name ?? pick.infoHash), this.now());
        await this.repo.failed(this.host, pick.infoHash, failure.code, this.now());
        this.log(`[notesd] torrent: ${pick.name ?? pick.infoHash}: ${failure.code}: ${failure.message}`);
      }
      throw failure;
    }
    const row = await this.repo.record(this.host, spec(handle.name), this.now());
    this.active.set(pick.infoHash, { handle, users: 0, lastRequestAt: this.nowMs(), row });
    this.log(`[notesd] torrent: joined the swarm of ${handle.name} (${pick.infoHash.slice(0, 8)}), ${handle.files.length} files, nothing chosen yet`);
    return handle;
  }

  /** A DiskHandle over a ready row's chosen files when every one is whole on disk, else null. */
  private async diskHandle(row: StreamTorrentRow): Promise<DiskHandle | null> {
    if (row.fileIndex === null || row.files.length === 0) return null;
    const paths = new Map<number, string>();
    for (const f of row.files) {
      const onDisk = await this.folder.complete(row.infoHash, f.path, f.length);
      if (onDisk === null) return null;
      paths.set(f.index, onDisk);
    }
    const files: TorrentFileInfo[] = row.files.map((f) => ({ index: f.index, path: f.path, name: path.basename(f.path), length: f.length }));
    return new DiskHandle(row.infoHash, row.name, files, paths);
  }

  private mediaFiles(handle: TorrentHandle, indexes: readonly number[]): TorrentFileInfo[] {
    if (indexes.length === 0) throw new TorrentError('not_media', 'Name at least one file to use.');
    return [...new Set(indexes)].map((index) => {
      const file = handle.files.find((f) => f.index === index);
      if (file === undefined) throw new TorrentError('not_media', `The torrent has no file ${index}.`);
      if (mediaOf(file.name) === null) {
        throw new TorrentError('not_media', `${file.path} is neither a video nor a subtitle file; notesd never downloads or opens anything else from a torrent.`);
      }
      return file;
    });
  }

  /** Records progress and a finished download, then lets the torrent go when nothing uses it. */
  private async settle(hash: string, live: Active): Promise<void> {
    const row = live.row;
    const complete = row.fileIndex !== null && row.files.every((f) => live.handle.done(f.index));
    if (complete && row.state !== 'ready') {
      live.row = await this.repo.ready(this.host, hash, row.fileLength ?? 0, this.now());
      this.log(`[notesd] torrent: ${row.name} is on disk (${Math.round((row.fileLength ?? 0) / 1_048_576)} MB)`);
    } else if (!complete && row.fileIndex !== null) {
      const bytes = sumRanges(live.handle.ranges(row.fileIndex));
      if (Math.abs(bytes - row.bytesDone) >= PROGRESS_STEP_BYTES) {
        await this.repo.progress(this.host, hash, bytes, this.now());
        live.row = { ...row, bytesDone: bytes };
      }
    }
    if (live.users > 0) return;
    if (complete) await this.leave(hash, live, 'it is finished and nothing plays it');
    else if (this.nowMs() - live.lastRequestAt >= this.lingerMs) {
      await this.leave(hash, live, `nothing asked for it for ${Math.round(this.lingerMs / 60_000)} min`);
    }
  }

  private async leave(hash: string, live: Active, why: string): Promise<void> {
    if (this.active.get(hash) !== live) return;
    this.active.delete(hash);
    try {
      await this.engine.remove(hash, { deleteFiles: false });
    } catch (err) {
      this.log(`[notesd] torrent: could not leave the swarm of ${live.row.name}: ${messageOf(err)}`);
    }
    const chosen = new Set(live.row.files.map((f) => f.index));
    try {
      await this.folder.dropFiles(hash, live.handle.files.filter((f) => !chosen.has(f.index)).map((f) => f.path));
    } catch (err) {
      this.log(`[notesd] torrent: could not delete the edges of unchosen files of ${live.row.name}: ${messageOf(err)}`);
    }
    this.log(`[notesd] torrent: left the swarm of ${live.row.name} (${hash.slice(0, 8)}): ${why}`);
  }

  /** This host's row of a hash, or the answer for the other machine's / an unknown one. */
  private async rowHere(hash: string): Promise<StreamTorrentRow | Response> {
    const live = this.active.get(hash);
    if (live !== undefined) return live.row;
    const rows = await this.repo.byHash(hash);
    const here = rows.find((r) => r.host === this.host);
    if (here !== undefined) return here;
    const other = rows[0];
    if (other !== undefined) return notOnThisMachine(other.host);
    return jsonError(404, 'unknown_torrent', 'No torrent download has this info hash.');
  }

  private async notePlayed(row: StreamTorrentRow, isVideo: boolean): Promise<void> {
    if (!isVideo) return;
    const at = this.nowMs();
    if (at - (this.playedAt.get(row.infoHash) ?? Number.NEGATIVE_INFINITY) < PLAYED_EVERY_MS) return;
    this.playedAt.set(row.infoHash, at);
    try {
      await this.repo.played(this.host, row.infoHash, this.now());
    } catch (err) {
      this.log(`[notesd] torrent: could not mark ${row.name} played: ${messageOf(err)}`);
    }
  }

  private viewOf(row: StreamTorrentRow): TorrentDownloadView {
    const available = row.host === this.host;
    const live = available ? this.active.get(row.infoHash) : undefined;
    const stats = live?.handle.stats() ?? { peers: 0, down_kbps: 0, up_kbps: 0 };
    const length = row.fileLength;
    const bytes =
      row.state === 'ready'
        ? (length ?? row.bytesDone)
        : live !== undefined && row.fileIndex !== null
          ? sumRanges(live.handle.ranges(row.fileIndex))
          : row.bytesDone;
    return {
      info_hash: row.infoHash,
      host: row.host,
      available,
      kind: row.kind,
      tmdb_id: row.tmdbId,
      season: row.kind === 'tv' ? row.season : null,
      episode: row.kind === 'tv' ? row.episode : null,
      name: row.name,
      release: row.release,
      state: row.state,
      error: row.error,
      file_index: row.fileIndex,
      file_length: length,
      files: row.files.map((f) => ({ index: f.index, path: f.path, length: f.length, media: mediaOf(f.path) })),
      bytes_done: bytes,
      progress: length === null || length === 0 ? (row.state === 'ready' ? 1 : 0) : Math.round((bytes / length) * 1000) / 1000,
      duration_s: row.durationS,
      in_swarm: live !== undefined,
      users: live?.users ?? 0,
      ...stats,
      file_url: available && row.fileIndex !== null ? this.localUrl(row.infoHash, row.fileIndex) : null,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
      completed_at: row.completedAt === null ? null : row.completedAt.toISOString(),
      played_at: row.playedAt === null ? null : row.playedAt.toISOString(),
    };
  }
}

/** Test seams for buildTorrentStreams. */
export interface TorrentStreamsOverrides {
  engine?: TorrentEngine;
  now?: () => Date;
  log?: (line: string) => void;
}

/**
 * The daemon's torrents, or null with direct streaming off or NOTESD_TORRENT=off (then nothing is built,
 * no swarm is joined and the routes answer torrent_off). Building it starts nothing: the engine starts
 * with the first torrent opened.
 */
export function buildTorrentStreams(
  config: Config,
  directStream: { readonly host: string } | null,
  db: Db,
  overrides: TorrentStreamsOverrides = {},
): TorrentStreams | null {
  const t = config.torrent;
  if (directStream === null || t === undefined || !t.enabled) return null;
  const folder = new TorrentFolder(t.dir);
  const log = overrides.log ?? ((line: string) => console.log(line));
  return new TorrentStreams({
    engine: overrides.engine ?? new WebTorrentEngine({ folder, uploadKbps: t.uploadKbps, discovery: t.discovery, peers: t.peers, log }),
    repo: new TorrentsRepo(db),
    folder,
    host: directStream.host,
    uploadKbps: t.uploadKbps,
    keepDays: t.keepDays,
    discovery: t.discovery,
    log,
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  });
}
```
**Impact:** none until the daemon builds it (step 11).

### Step 10: Settings
**File:** `src/config.ts`
**Change 1 (line 2):** `import { homedir } from 'node:os'` → `import { homedir, tmpdir } from 'node:os'`
**Change 2 (after line 229, the end of `DEFAULT_DIRECT_STREAM_CONFIG`):**
```ts

export const DEFAULT_TORRENT_UPLOAD_KBPS = 100
export const DEFAULT_TORRENT_KEEP_DAYS = 7

/** Torrents as a direct-streaming source (src/directStream/torrent/*). They also need direct streaming on. */
export interface TorrentConfig {
  /**
   * `NOTESD_TORRENT`, default on. `off`: AppDeps.torrents is null, no swarm is joined, and every
   * /api/stream/torrent route answers torrent_off.
   */
  enabled: boolean
  /** `NOTESD_TORRENT_DIR`, absolute, default `<dataDir>/movies/torrents`: one folder per info hash. Always resolved. */
  dir: string
  /** `NOTESD_TORRENT_UPLOAD_KBPS`, default 100: the upload cap in kB/s (1 kB = 1000 bytes), all torrents together. */
  uploadKbps: number
  /** `NOTESD_TORRENT_KEEP_DAYS`, default 7: a download not played for this many days is deleted with its files. */
  keepDays: number
  /** `NOTESD_TORRENT_DISCOVERY`, default on. `off`: no DHT and no trackers; peers come only from `peers`. */
  discovery: boolean
  /** `NOTESD_TORRENT_PEERS`: `host:port` addresses (comma-separated) added as a peer to every torrent. Empty by default. */
  peers: string[]
}

/**
 * Torrents off. Tests build `Config` literals with it (or leave `torrent` out, which is the same). Its
 * folder is under the OS temp folder, so a test that turns torrents on without a folder never writes into
 * the owner's data directory.
 */
export const DEFAULT_TORRENT_CONFIG: TorrentConfig = {
  enabled: false,
  dir: path.join(tmpdir(), 'notesd-torrents'),
  uploadKbps: DEFAULT_TORRENT_UPLOAD_KBPS,
  keepDays: DEFAULT_TORRENT_KEEP_DAYS,
  discovery: true,
  peers: [],
}
```
**Change 3 (in `interface Config`, after line 392 `directStream?: DirectStreamConfig`):**
```ts
  /** Torrents (direct streaming's torrent source). Absent (a config built by a test) is the same as `enabled: false`. */
  torrent?: TorrentConfig
```
**Change 4 (after line 725, the end of `parseStreamProber`):**
```ts

const PEER_ADDRESS = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/

function parsePeers(raw: string | undefined): string[] {
  const out: string[] = []
  for (const part of (raw ?? '').split(',')) {
    const value = part.trim()
    if (value === '') continue
    const m = PEER_ADDRESS.exec(value)
    const port = m === null ? 0 : Number(m[1])
    if (port < 1 || port > 65535) throw new ConfigError(`NOTESD_TORRENT_PEERS takes host:port addresses separated by ",", got "${value}"`)
    if (!out.includes(value)) out.push(value)
  }
  return out
}

/** `dataDir` is the resolved NOTES_DATA_DIR: the default folder is under it. */
export function parseTorrent(env: Record<string, string | undefined>, dataDir: string): TorrentConfig {
  return {
    enabled: parseSwitch('NOTESD_TORRENT', env.NOTESD_TORRENT),
    dir: parseOptionalAbsolutePath('NOTESD_TORRENT_DIR', env.NOTESD_TORRENT_DIR) ?? path.join(dataDir, 'movies', 'torrents'),
    uploadKbps: parsePositiveInt('NOTESD_TORRENT_UPLOAD_KBPS', env.NOTESD_TORRENT_UPLOAD_KBPS, DEFAULT_TORRENT_UPLOAD_KBPS),
    keepDays: parsePositiveInt('NOTESD_TORRENT_KEEP_DAYS', env.NOTESD_TORRENT_KEEP_DAYS, DEFAULT_TORRENT_KEEP_DAYS),
    discovery: parseSwitch('NOTESD_TORRENT_DISCOVERY', env.NOTESD_TORRENT_DISCOVERY),
    peers: parsePeers(env.NOTESD_TORRENT_PEERS),
  }
}
```
**Change 5 (docstring, after line 748 `NOTESD_STREAM_PROBE_BUDGET, NOTESD_STREAM_IDLE_SECONDS, NOTESD_STREAM_PROBE_MS.`):** add the line
```ts
 * Torrent keys: NOTESD_TORRENT, NOTESD_TORRENT_DIR, NOTESD_TORRENT_UPLOAD_KBPS, NOTESD_TORRENT_KEEP_DAYS,
 * NOTESD_TORRENT_DISCOVERY, NOTESD_TORRENT_PEERS (a relative folder, a cap or keep of 0, a peer without a port throw ConfigError).
```
**Change 6 (in `loadConfig`, lines 766–781):** replace the tail from `const dataDirRaw` to the closing `}` of the
returned object with:
```ts
  const dataDirRaw = env.NOTES_DATA_DIR?.trim() || DEFAULT_DATA_DIR
  const dataDir = path.resolve(expandHome(dataDirRaw))

  return {
    databaseUrl,
    port: parsePort(env.NOTESD_PORT),
    host: parseHost(env.NOTESD_HOST),
    dataDir,
    chat: parseChat(env),
    embeddings: parseEmbeddings(env),
    sessions: parseSessions(env),
    adversary: parseAdversary(env),
    dword: parseDword(env),
    movies: parseMovies(env),
    streaming: { enabled: parseSwitch('NOTESD_STREAMING', env.NOTESD_STREAMING) },
    directStream: parseDirectStream(env),
    torrent: parseTorrent(env, dataDir),
  }
```
**Impact:** `loadConfig` answers `torrent`; `tests/unit/config.test.ts`'s whole-config `toEqual` needs it (step 17).

### Step 11: Wiring
**File:** `src/deps.ts`
**Change:** add `import type { TorrentStreams } from './directStream/torrent/service.js';` after line 13
(`StreamCache` import), and after line 68 (`streamCache?: StreamCache | null;`):
```ts
  /**
   * Torrents (torrent-stream-source phase 1): this host's torrent downloads, the engine and the
   * /api/stream/torrent routes. Built next to `directStream`; null or absent with direct streaming off or
   * NOTESD_TORRENT=off. startBackground starts its tick and closes it.
   */
  torrents?: TorrentStreams | null;
```
**File:** `src/daemon.ts`
**Change:** after line 33 (`import { DirectStreamRepo } ...`) add
```ts
import { buildTorrentStreams } from './directStream/torrent/service.js';
```
after line 218 (`const streamCache = buildStreamCache(...)`) add
```ts
  // Torrents (torrent-stream-source phase 1): null with NOTESD_TORRENT=off or direct streaming off.
  // Building it joins nothing: the WebTorrent engine starts with the first torrent opened.
  const torrents = buildTorrentStreams(config, directStream, db);
```
and in the `deps` literal after line 246 (`streamCache,`) add `    torrents,`.
**File:** `src/background.ts`
**Change:** after line 196 (the end of the stream-cache `if` block) add
```ts

  // Torrents (torrent-stream-source phase 1): old downloads are cleared and the tick starts; nothing joins a swarm here.
  const torrents = deps.torrents ?? null;
  if (torrents !== null) {
    void torrents.start().then(
      (cleared) =>
        console.log(
          `[notesd] torrents on as ${torrents.host}: downloads in ${torrents.root}, upload capped at ${torrents.uploadKbps} kB/s` +
            (cleared > 0 ? `, ${cleared} download(s) not played for ${torrents.keepDays} days cleared` : ''),
        ),
      (err: unknown) => console.error(`[notesd] torrents: could not start: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
```
and in the closing `Promise.all([...])` after line 221 (`streamCache?.close(),`) add `      torrents?.close(),`.
**Impact:** a daemon with direct streaming on and `NOTESD_TORRENT` unset now builds `TorrentStreams` (no
engine, no socket) and logs one line at start.

### Step 12: The routes
**File:** `src/http/streamTorrentApi.ts` (new)
**Code:**
```ts
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import type { TorrentStreams } from '../directStream/torrent/service.js';
import { mediaOf, normalizeInfoHash, TORRENT_OPEN_TIMEOUT_MS, TorrentError } from '../directStream/torrent/types.js';
import type { StreamRef } from '../directStream/types.js';
import { DIRECT_STREAM_OFF } from './directStreamApi.js';
import { sameOriginOnly } from './sameOrigin.js';

/**
 * Torrents (torrent-stream-source phase 1): the engine's status, opening a torrent and using its files,
 * letting go, one download's view and map, and the file route the player and ffmpeg read. 503
 * direct_stream_off without direct streaming (the directStreamRoutes guard answers first when both are
 * mounted), 503 torrent_off with NOTESD_TORRENT=off. The two POSTs join or leave a swarm, so they are
 * same-origin only.
 */

export const TORRENT_OFF = { error: 'torrent_off', message: 'Torrents are off on this machine (NOTESD_TORRENT=off).' } as const;
const UNKNOWN_TORRENT = { error: 'unknown_torrent', message: 'No torrent download has this info hash.' } as const;

const tmdbId = z.number().int().min(1).max(2_147_483_647);
const tracker = z
  .string()
  .trim()
  .max(500)
  .regex(/^(?:udp|https?|wss?):\/\/\S+$/, 'a tracker is a udp, http(s) or ws(s) address');
const common = {
  info_hash: z
    .string()
    .trim()
    .regex(/^[0-9a-fA-F]{40}$/, 'an info hash is 40 hexadecimal characters'),
  /** The release name as an index lists it. */
  name: z.string().trim().min(1).max(500).nullish(),
  trackers: z.array(tracker).max(50).nullish(),
  /** The file indexes to download: video and subtitle files only. */
  files: z.array(z.number().int().min(0).max(1_000_000)).min(1).max(50).nullish(),
};

export const openBody = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('movie'), tmdb_id: tmdbId, season: z.null().optional(), episode: z.null().optional(), ...common }),
  z.strictObject({
    kind: z.literal('tv'),
    tmdb_id: tmdbId,
    season: z.number().int().min(0).max(1000),
    episode: z.number().int().min(1).max(10_000),
    ...common,
  }),
]);

type OpenBody = z.infer<typeof openBody>;

function refOf(body: OpenBody): StreamRef {
  return body.kind === 'movie' ? { kind: 'movie', tmdbId: body.tmdb_id } : { kind: 'tv', tmdbId: body.tmdb_id, season: body.season, episode: body.episode };
}

/** TorrentError -> its HTTP answer; anything else is rethrown (500). */
export function torrentErrorResponse(c: Context, err: unknown): Response {
  if (!(err instanceof TorrentError)) throw err;
  const body = { error: err.code, message: err.message };
  switch (err.code) {
    case 'invalid_hash':
    case 'not_media':
      return c.json(body, 400);
    case 'unknown_torrent':
      return c.json(body, 404);
    case 'not_on_this_machine':
      return c.json({ ...body, host: err.extra.host ?? null }, 404);
    case 'not_open':
      return c.json(body, 409);
    case 'unsafe_path':
      return c.json(body, 422);
    case 'engine_error':
      return c.json(body, 502);
    case 'closing':
      return c.json(body, 503);
    case 'no_metadata':
      return c.json(body, 504);
  }
}

export function streamTorrentRoutes(deps: Pick<AppDeps, 'directStream'> & Partial<Pick<AppDeps, 'torrents'>>): Hono {
  const r = new Hono();
  /** Info hashes POST /api/stream/torrent holds in use (one user each) until their release route. */
  const held = new Set<string>();
  const torrentsOf = (): TorrentStreams | null => ((deps.directStream ?? null) === null ? null : (deps.torrents ?? null));
  const off = (c: Context): Response => ((deps.directStream ?? null) === null ? c.json(DIRECT_STREAM_OFF, 503) : c.json(TORRENT_OFF, 503));

  r.get('/api/stream/torrent', async (c) => {
    const torrents = torrentsOf();
    if (torrents === null) return off(c);
    return c.json({ ...torrents.status(), downloads: await torrents.list() });
  });

  r.post('/api/stream/torrent', sameOriginOnly, async (c) => {
    const torrents = torrentsOf();
    if (torrents === null) return off(c);
    let raw: unknown;
    try {
      raw = JSON.parse(await c.req.text());
    } catch {
      return c.json({ error: 'invalid_json', message: 'The body is not JSON.' }, 400);
    }
    const body = openBody.safeParse(raw);
    if (!body.success) {
      return c.json({ error: 'invalid_body', message: body.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') }, 400);
    }
    const hash = body.data.info_hash.toLowerCase();
    try {
      const handle = await torrents.open(
        { infoHash: hash, trackers: body.data.trackers ?? [], name: body.data.name ?? null, ref: refOf(body.data) },
        { timeoutMs: TORRENT_OPEN_TIMEOUT_MS },
      );
      const files = body.data.files ?? null;
      if (files !== null) {
        await torrents.use(hash, files);
        // The route holds one user per torrent: a second POST re-chooses without counting twice.
        if (held.has(hash)) await torrents.release(hash);
        else held.add(hash);
      }
      return c.json({
        ok: true,
        from_disk: !handle.live,
        files: handle.files.map((f) => ({ index: f.index, path: f.path, length: f.length, media: mediaOf(f.name) })),
        torrent: await torrents.view(hash),
      });
    } catch (err) {
      return torrentErrorResponse(c, err);
    }
  });

  r.post('/api/stream/torrent/:hash/release', sameOriginOnly, async (c) => {
    const torrents = torrentsOf();
    if (torrents === null) return off(c);
    const hash = normalizeInfoHash(c.req.param('hash'));
    if (hash === null) return c.json(UNKNOWN_TORRENT, 404);
    const released = held.delete(hash);
    if (released) await torrents.release(hash);
    const view = await torrents.view(hash);
    if (view === null) return c.json(UNKNOWN_TORRENT, 404);
    return c.json({ ok: true, released, torrent: view });
  });

  r.get('/api/stream/torrent/:hash', async (c) => {
    const torrents = torrentsOf();
    if (torrents === null) return off(c);
    const view = await torrents.view(c.req.param('hash'));
    if (view === null) return c.json(UNKNOWN_TORRENT, 404);
    return c.json(view);
  });

  // What of the video is on disk: the player's timeline draws it.
  r.get('/api/stream/torrent/:hash/map', async (c) => {
    const torrents = torrentsOf();
    if (torrents === null) return off(c);
    const map = await torrents.map(c.req.param('hash'));
    if (map === null) return c.json({ ...UNKNOWN_TORRENT, message: 'This machine has no torrent download with this info hash.' }, 404);
    return c.json(map);
  });

  r.get('/api/stream/torrent/:hash/f/:index', async (c) => {
    const torrents = torrentsOf();
    if (torrents === null) return off(c);
    const raw = c.req.param('index');
    const index = /^\d{1,7}$/.test(raw) ? Number(raw) : -1;
    return torrents.serve(c.req.param('hash'), index, c.req.header('range') ?? null);
  });

  return r;
}
```
**File:** `src/http/app.ts`
**Change:** after line 32 (`import { streamCachePlayRoutes } ...`) add
`import { streamTorrentRoutes } from './streamTorrentApi.js';`; in the doc comment (line 113) replace
`streamCacheRoutes (stream-cache phase 5: the stream cache), staticRoutes` with
`streamCacheRoutes (stream-cache phase 5: the stream cache), streamTorrentRoutes (torrent-stream-source phase 1: torrent downloads and their file route), staticRoutes`;
after line 148 (`app.route('/', streamCachePlayRoutes(deps));`) add
```ts
  app.route('/', streamTorrentRoutes(deps));
```
**Impact:** six new routes; `scripts/docs/reference.ts` now lists them, so step 13 must land in the same commit
or `npm test` fails.

### Step 13: Route reference
**File:** `scripts/docs/httpRoutes.ts:261` (after the closing `},` of the group holding the stream cache
routes, before the `Debug` group)
**Code:**
```ts
  {
    title: 'Torrents',
    intro:
      'Torrent downloads of this machine: a film\'s video and subtitle files from a swarm, served from this daemon. Every route answers 503 `direct_stream_off` without direct streaming and 503 `torrent_off` with `NOTESD_TORRENT=off`. A download belongs to the machine that made it: the other machine sees it with `available: false`, and its file routes answer 404 `not_on_this_machine` with `host`. Speeds are in kilobits per second. Guide: [streaming.md](../streaming.md#torrents).',
    routes: {
      'GET /api/stream/torrent':
        'This machine\'s torrent engine and every download of both machines: `{host, port, upload_cap_bytes_per_s, keep_days, discovery, swarm, downloads}`. `port` is the engine\'s listening port, null while no torrent is in the swarm (the engine starts with the first torrent and stops after the last). `swarm` is the torrents in the swarm now, `{info_hash, name, users, peers, down_kbps, up_kbps}`; `downloads` are in the shape of `GET /api/stream/torrent/:hash`, newest first. Starts nothing.',
      'POST /api/stream/torrent':
        '`{info_hash, kind, tmdb_id, season?, episode?, name?, trackers?, files?}` (`name`: the release name as an index lists it): open a torrent for a title and answer its file list once a peer sends it (60 s at most): `{ok: true, from_disk, files: [{index, path, length, media}], torrent}`, `media` `video`, `subtitle` or null. Nothing is downloaded until `files` names the indexes to use, which must be video or subtitle files; those are downloaded in order under `<NOTESD_TORRENT_DIR>/<info hash>/`, and this route holds the torrent in the swarm until `POST .../release`. A download finished on this machine for the same title opens from disk (`from_disk: true`, its chosen files only) and joins no swarm. 400 `invalid_json` / `invalid_body` / `not_media`; 504 `no_metadata` (no peer sent the file list); 422 `unsafe_path` (a file would land outside the torrent\'s folder); 502 `engine_error`. Same-origin only.',
      'POST /api/stream/torrent/:hash/release':
        'Let go of the torrent `POST /api/stream/torrent` holds: `{ok: true, released, torrent}` (`released: false` when it held nothing). A finished download leaves the swarm at once, an unfinished one three minutes after its last file request. 404 `unknown_torrent`. Same-origin only.',
      'GET /api/stream/torrent/:hash':
        'One download: `{info_hash, host, available, kind, tmdb_id, season, episode, name, release, state (downloading, ready, failed), error, file_index, file_length, files, bytes_done, progress, duration_s, in_swarm, users, peers, down_kbps, up_kbps, file_url, created_at, updated_at, completed_at, played_at}`. `files` are the chosen files and `file_index` the video; `peers` and the speeds are live while it is in the swarm, else 0. `file_url` is null on the other machine. `error` on a failed one: `no_metadata`, `unsafe_path`, `engine_error`. 404 `unknown_torrent`.',
      'GET /api/stream/torrent/:hash/map':
        'What of the video is on this machine\'s disk: `{duration_s, ranges, length, byte_ranges}`. `byte_ranges` are `[from, to)` byte stretches in order; `ranges` the same in seconds by proportion once a duration is known, empty before. 404 `unknown_torrent` (also for the other machine\'s download).',
      'GET /api/stream/torrent/:hash/f/:index':
        'A chosen file of a download, with `Range` (206, 416): from disk once it is whole, else from the swarm, which fetches the pieces of the asked range before the rest of the file. Only the video and subtitle files chosen for it are served, as video or text, never run. 404 `unknown_torrent`, 404 `not_selected`, 404 `not_on_this_machine` with `host`, 409 `not_in_swarm` (unfinished and not open: play it again), 503 `closing`.',
    },
  },
```
Then run `npm run docs:gen` (regenerates `docs/guide/reference/http-api.md`; never edit it by hand).
**Impact:** `tests/unit/docs/reference.test.ts` passes with the new routes.

### Step 14: Configuration reference
**File:** `docs/guide/reference/configuration.md:145` (after the `NOTESD_STREAM_CACHE_DIR` row, i.e. after the
Direct streaming table, before `## Install script and hooks`)
**Code:**
```md

## Torrents

A torrent is a source direct streaming downloads from a swarm, described in
[streaming.md](../streaming.md#torrents). It needs direct streaming on.

| Variable | Default | Meaning |
| --- | --- | --- |
| `NOTESD_TORRENT` | on | `off` turns torrents off on this machine: nothing is built, no swarm is joined, and every `/api/stream/torrent` route answers 503 `torrent_off`. |
| `NOTESD_TORRENT_DIR` | `<NOTES_DATA_DIR>/movies/torrents` | Absolute path of the folder where this machine keeps its torrent downloads, one folder per info hash. The other machine keeps its own; a relative path is rejected. |
| `NOTESD_TORRENT_UPLOAD_KBPS` | 100 | The upload cap in kB/s (1 kB = 1000 bytes), all torrents together. A torrent client uploads to its peers while it downloads; this keeps that small. |
| `NOTESD_TORRENT_KEEP_DAYS` | 7 | A download not played for this many days is deleted with its files. |
| `NOTESD_TORRENT_DISCOVERY` | on | `off`: no DHT and no trackers, so peers come only from `NOTESD_TORRENT_PEERS`. `verify.sh up --torrent` sets it with a loopback seeder. |
| `NOTESD_TORRENT_PEERS` | unset | `host:port` addresses, separated by `,`, added as a peer to every torrent. For the verify harness's loopback seeder; empty in normal use. |
```
**Impact:** every quoted name in `config.ts` is documented, so `envVarProblems()` stays empty.

### Step 15: The guide
**File:** `docs/guide/streaming.md`
**Change 1:** insert before line 1104 (`## Where the code is`) — this phase creates the `## Torrents` heading that
later phases add their subsections under:
```md
## Torrents

A torrent is the third way direct streaming gets a film, beside a cloud provider and the stream cache: the
daemon joins the torrent's swarm, downloads the one video file (and its subtitle files) in playing order,
and serves it from its own disk to the player page. Each torrent phase adds its subsection here.

### The torrent engine and its file route

The engine is WebTorrent 3, inside the daemon (`src/directStream/torrent/`). It starts with the first
torrent opened and stops after the last one leaves: while nothing is open the daemon has no torrent port, no
DHT node and no peer.

1. A torrent is opened by its info hash; its file list comes from the peers, no `.torrent` file is needed.
   Nothing is downloaded until files are chosen, and only video files (`.mp4`, `.m4v`, `.mkv`, `.webm`,
   `.mov`, `.avi`, `.ts`, `.m2ts`, `.wmv`) and subtitle files (`.srt`, `.vtt`, `.ass`, `.ssa`) can be.
   Nothing from a torrent is ever run.
2. The chosen files are written under `<NOTESD_TORRENT_DIR>/<info hash>/` (default
   `<NOTES_DATA_DIR>/movies/torrents/`), at the paths the torrent names. A torrent that names a path outside
   that folder is refused before anything is written (`unsafe_path`).
3. They download in order. `GET /api/stream/torrent/<hash>/f/<index>` answers a byte range with exactly
   those bytes: from disk once the file is whole, else through the engine, which fetches the range's pieces
   before the rest, so a seek plays as soon as its stretch arrives.
4. Pieces at a file's edge are shared with the next file, so a few edge bytes of a file that was not chosen
   are fetched too. They are deleted when the torrent leaves the swarm; the folder then holds only the
   chosen files.
5. Upload is capped at `NOTESD_TORRENT_UPLOAD_KBPS` (100 kB/s) for all torrents together. UPnP and NAT-PMP
   are off; under WSL 2 no peer can connect in, so the daemon only connects out.
6. A torrent is in the swarm only while something uses it (a stream session; for now
   `POST /api/stream/torrent` with `files`, until its release). Once nothing does, a finished download
   leaves at once and an unfinished one three minutes after its last file request.
7. A finished download stays (`stream_torrents`, state `ready`) and plays again from disk with no swarm.
   A download not played for `NOTESD_TORRENT_KEEP_DAYS` (7) days is deleted with its folder.

A download belongs to the machine that made it: the other machine lists it with `available: false`, and
its file routes answer 404 `not_on_this_machine`. `NOTESD_TORRENT=off` builds nothing and every route
answers `torrent_off`. The routes are in [http-api.md](reference/http-api.md#torrents).

| Answer | Meaning |
| --- | --- |
| `no_metadata` | No peer sent the file list within 60 s |
| `unsafe_path` | The torrent names a file outside its folder; nothing of it was downloaded |
| `not_media` | A chosen file is neither a video nor a subtitle file |
| `not_selected` | That file of the torrent was not chosen, so it is not served |
| `not_in_swarm` | The download is unfinished and nothing holds it now: play it again to carry on |
| `not_on_this_machine` | The download is on the other laptop |
| `torrent_off` | `NOTESD_TORRENT=off` on this machine |

```
**Change 2 (table "Where the code is", after the row for `src/http/streamCacheApi.ts, src/mcp/streamCacheTools.ts`, line 1125):**
```md
| `src/directStream/torrent/` | Torrents: the WebTorrent engine (`engine.ts`), the torrent folder (`store.ts`), downloads, users and the swarm (`service.ts`), Range answers (`serve.ts`), `stream_torrents` (`repo.ts`) |
| `src/http/streamTorrentApi.ts` | The `/api/stream/torrent` routes |
```
**Change 3 ("Proving a change", after the stream-cache bullet that ends `npx vitest run tests/unit/directStream/cache`.):**
```md
- Torrents: `npx vitest run tests/unit/directStream/torrent` (the engine test seeds a generated torrent over
  loopback, DHT and trackers off) and `npm run test:int -- tests/integration/directStream.torrents.int.test.ts`;
  on a throwaway daemon `verify.sh up --torrent`, then `scripts/torrent/torrent.sh RUN` (the feature map's
  "Torrents" section). No throwaway daemon ever joins a real swarm.
```
**File:** `docs/guide/architecture.md`
**Change 1 (after line 70, the `stream_providers, ... stream_caches` writer row):**
```md
| `stream_torrents` | `TorrentsRepo` (`src/directStream/torrent/repo.ts`) |
```
**Change 2 (line 94, the Direct streaming data-model row):** replace `` `stream_probe_titles`, `stream_caches` | ``
with `` `stream_probe_titles`, `stream_caches`, `stream_torrents` | `` and append to its last cell:
` A torrent download is one per host and info hash: the title it was opened for, its chosen files, its state; the files only on that host.`
**Change 3 (after line 119, `movies/stream-cache/<id>/ ...`):**
```
  movies/torrents/<info hash>/       a torrent download: the chosen video and subtitle files (NOTESD_TORRENT_DIR)
```
**File:** `CLAUDE.md` (after line 92, the last sub-bullet of **Direct streaming**)
```md
  - Torrents (`src/directStream/torrent/*`): `TorrentsRepo` is the only writer of `stream_torrents`. A torrent is in the swarm only while something uses it, and only its video and subtitle files are selected, read or served; nothing from a torrent is ever run. Tests use `DEFAULT_TORRENT_CONFIG` (off) or a fake engine; the real-engine test seeds over loopback with DHT and trackers off.
```
**Impact:** docs only; `docs:check` link to `reference/http-api.md#torrents` resolves after `docs:gen`.

### Step 16: Test helpers
**File:** `tests/helpers/fakeTorrentEngine.ts` (new)
**Code:**
```ts
import { Readable } from 'node:stream';
import {
  TorrentError,
  type TorrentAddSpec,
  type TorrentEngine,
  type TorrentFileInfo,
  type TorrentHandle,
  type TorrentStats,
} from '../../src/directStream/torrent/types.js';

export interface FakeTorrentSpec {
  infoHash: string;
  name: string;
  files: { path: string; data: Buffer }[];
}

/**
 * A TorrentEngine with no network: a torrent it was given answers at once, its bytes come from memory, and
 * what the service asked of it is recorded. A torrent it does not know answers no_metadata.
 */
export class FakeTorrentEngine implements TorrentEngine {
  readonly added: string[] = [];
  readonly removed: string[] = [];
  readonly selected: { infoHash: string; indexes: number[] }[] = [];
  readonly reads: { infoHash: string; index: number; start: number; end: number }[] = [];
  private readonly specs = new Map<string, FakeTorrentSpec>();
  private readonly handles = new Map<string, FakeHandle>();
  closed = false;

  constructor(torrents: readonly FakeTorrentSpec[] = []) {
    for (const t of torrents) this.specs.set(t.infoHash, t);
  }

  async add(spec: TorrentAddSpec): Promise<TorrentHandle> {
    if (this.closed) throw new TorrentError('closing', 'The torrent engine is stopping.');
    const known = this.handles.get(spec.infoHash);
    if (known !== undefined) return known;
    const torrent = this.specs.get(spec.infoHash);
    if (torrent === undefined) throw new TorrentError('no_metadata', 'No peer sent the file list within 1 s.');
    this.added.push(spec.infoHash);
    const handle = new FakeHandle(torrent, this);
    this.handles.set(spec.infoHash, handle);
    return handle;
  }

  get(infoHash: string): TorrentHandle | null {
    return this.handles.get(infoHash) ?? null;
  }

  async remove(infoHash: string): Promise<void> {
    this.removed.push(infoHash);
    this.handles.delete(infoHash);
  }

  port(): number | null {
    return this.handles.size > 0 ? 6881 : null;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.handles.clear();
  }

  /** Marks a file's bytes as on disk: all of it, or `[from, to)`. */
  have(infoHash: string, index: number, span?: [number, number]): void {
    const handle = this.handles.get(infoHash);
    if (handle === undefined) throw new Error(`the fake engine has no open torrent ${infoHash}`);
    handle.have(index, span);
  }
}

class FakeHandle implements TorrentHandle {
  readonly live = true;
  readonly infoHash: string;
  readonly name: string;
  readonly files: TorrentFileInfo[];
  private readonly onDisk = new Map<number, [number, number][]>();

  constructor(
    private readonly spec: FakeTorrentSpec,
    private readonly engine: FakeTorrentEngine,
  ) {
    this.infoHash = spec.infoHash;
    this.name = spec.name;
    this.files = spec.files.map((f, index) => ({ index, path: f.path, name: f.path.split('/').at(-1) ?? f.path, length: f.data.length }));
  }

  select(indexes: readonly number[]): void {
    this.engine.selected.push({ infoHash: this.infoHash, indexes: [...indexes] });
  }

  read(index: number, range: { start: number; end: number }): Readable {
    this.engine.reads.push({ infoHash: this.infoHash, index, start: range.start, end: range.end });
    const data = this.spec.files[index]?.data;
    if (data === undefined) throw new RangeError(`no file ${index}`);
    this.have(index, [range.start, range.end + 1]);
    return Readable.from([data.subarray(range.start, range.end + 1)]);
  }

  stats(): TorrentStats {
    return { peers: 3, down_kbps: 900, up_kbps: 40 };
  }

  ranges(index: number): [number, number][] {
    return (this.onDisk.get(index) ?? []).map(([a, b]) => [a, b]);
  }

  done(index: number): boolean {
    const file = this.files[index];
    return file !== undefined && (this.onDisk.get(index) ?? []).some(([a, b]) => a === 0 && b >= file.length);
  }

  have(index: number, span?: [number, number]): void {
    const file = this.files[index];
    if (file === undefined) throw new RangeError(`no file ${index}`);
    const next = [...(this.onDisk.get(index) ?? []), span ?? [0, file.length]].sort((x, y) => x[0] - y[0]);
    const merged: [number, number][] = [];
    for (const [a, b] of next) {
      const last = merged.at(-1);
      if (last !== undefined && a <= last[1]) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    this.onDisk.set(index, merged);
  }
}
```
**File:** `tests/helpers/memoryTorrentRecords.ts` (new)
**Code:**
```ts
import type { StreamTorrentRow } from '../../src/db/schema.js';
import { cacheSlot } from '../../src/directStream/repo.js';
import type { TorrentChoice, TorrentRecords, TorrentRecordSpec } from '../../src/directStream/torrent/repo.js';
import type { StreamRef } from '../../src/directStream/types.js';

/** TorrentsRepo in memory, with the same rules (one row per host and hash; a new slot forgets the choice; failed and ready exclude each other). */
export class MemoryTorrentRecords implements TorrentRecords {
  readonly rows: StreamTorrentRow[] = [];

  async record(host: string, spec: TorrentRecordSpec, now: Date): Promise<StreamTorrentRow> {
    const slot = cacheSlot(spec.ref);
    const row = this.at(host, spec.infoHash);
    if (row === undefined) {
      const created: StreamTorrentRow = {
        host,
        infoHash: spec.infoHash,
        ...slot,
        name: spec.name,
        release: spec.release,
        trackers: [...spec.trackers],
        fileIndex: null,
        files: [],
        fileLength: null,
        bytesDone: 0,
        durationS: null,
        state: 'downloading',
        error: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        playedAt: null,
      };
      this.rows.push(created);
      return this.copy(created);
    }
    const sameSlot = row.kind === slot.kind && row.tmdbId === slot.tmdbId && row.season === slot.season && row.episode === slot.episode;
    const restart = !sameSlot || row.state === 'failed';
    Object.assign(row, slot, {
      name: spec.name,
      release: spec.release ?? row.release,
      trackers: spec.trackers.length > 0 ? [...spec.trackers] : row.trackers,
      updatedAt: now,
    });
    if (restart) Object.assign(row, { state: 'downloading', error: null, completedAt: null });
    if (!sameSlot) Object.assign(row, { fileIndex: null, files: [], fileLength: null, bytesDone: 0, durationS: null });
    return this.copy(row);
  }

  async get(host: string, infoHash: string): Promise<StreamTorrentRow | null> {
    const row = this.at(host, infoHash);
    return row === undefined ? null : this.copy(row);
  }

  async byHash(infoHash: string): Promise<StreamTorrentRow[]> {
    return this.rows.filter((r) => r.infoHash === infoHash).sort((a, b) => a.host.localeCompare(b.host)).map((r) => this.copy(r));
  }

  async forRef(host: string, ref: StreamRef): Promise<StreamTorrentRow[]> {
    const s = cacheSlot(ref);
    return this.rows
      .filter((r) => r.host === host && r.kind === s.kind && r.tmdbId === s.tmdbId && r.season === s.season && r.episode === s.episode)
      .sort((a, b) => Number(b.state === 'ready') - Number(a.state === 'ready') || b.updatedAt.getTime() - a.updatedAt.getTime())
      .map((r) => this.copy(r));
  }

  async all(): Promise<StreamTorrentRow[]> {
    return [...this.rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map((r) => this.copy(r));
  }

  async chosen(host: string, infoHash: string, choice: TorrentChoice, now: Date): Promise<StreamTorrentRow> {
    return this.copy(Object.assign(this.must(host, infoHash), { files: choice.files.map((f) => ({ ...f })), fileIndex: choice.fileIndex, fileLength: choice.fileLength, updatedAt: now }));
  }

  async progress(host: string, infoHash: string, bytesDone: number, now: Date): Promise<void> {
    Object.assign(this.must(host, infoHash), { bytesDone, updatedAt: now });
  }

  async ready(host: string, infoHash: string, bytesDone: number, now: Date): Promise<StreamTorrentRow> {
    const row = this.must(host, infoHash);
    if (row.fileIndex === null) throw new Error('stream_torrents_ready_check: a ready download needs a chosen video');
    return this.copy(Object.assign(row, { state: 'ready', error: null, completedAt: now, bytesDone, updatedAt: now }));
  }

  async failed(host: string, infoHash: string, error: string, now: Date): Promise<void> {
    Object.assign(this.must(host, infoHash), { state: 'failed', error, completedAt: null, updatedAt: now });
  }

  async restarted(host: string, infoHash: string, now: Date): Promise<void> {
    Object.assign(this.must(host, infoHash), { state: 'downloading', error: null, completedAt: null, bytesDone: 0, updatedAt: now });
  }

  async played(host: string, infoHash: string, now: Date): Promise<void> {
    Object.assign(this.must(host, infoHash), { playedAt: now });
  }

  async duration(host: string, infoHash: string, seconds: number, now: Date): Promise<void> {
    Object.assign(this.must(host, infoHash), { durationS: seconds, updatedAt: now });
  }

  async stale(host: string, before: Date): Promise<StreamTorrentRow[]> {
    return this.rows
      .filter((r) => r.host === host && (r.playedAt ?? r.completedAt ?? r.createdAt).getTime() < before.getTime())
      .map((r) => this.copy(r));
  }

  async delete(host: string, infoHash: string): Promise<boolean> {
    const at = this.rows.findIndex((r) => r.host === host && r.infoHash === infoHash);
    if (at < 0) return false;
    this.rows.splice(at, 1);
    return true;
  }

  private at(host: string, infoHash: string): StreamTorrentRow | undefined {
    return this.rows.find((r) => r.host === host && r.infoHash === infoHash);
  }

  private must(host: string, infoHash: string): StreamTorrentRow {
    const row = this.at(host, infoHash);
    if (row === undefined) throw new Error(`no torrent ${infoHash} on ${host}`);
    return row;
  }

  private copy(row: StreamTorrentRow): StreamTorrentRow {
    return { ...row, files: row.files.map((f) => ({ ...f })), trackers: [...row.trackers] };
  }
}
```
**Impact:** test-only.

### Step 17: Unit tests
**File:** `tests/unit/config.test.ts:56` — after the `directStream: ...` line of the defaults `toEqual`, add
```ts
      torrent: { ...DEFAULT_TORRENT_CONFIG, enabled: true, dir: path.join(homedir(), 'mcp-notes-data', 'movies', 'torrents') },
```
and add `DEFAULT_TORRENT_CONFIG` to that file's import from `'../../src/config.js'` (it already imports
`path` and `homedir`).

**File:** `tests/unit/config.torrent.test.ts` (new)
```ts
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TORRENT_CONFIG, loadConfig, parseTorrent } from '../../src/config.js';

const DATA = '/srv/notes';

describe('torrent settings', () => {
  it('are on, under <dataDir>/movies/torrents, capped at 100 kB/s and kept 7 days by default', () => {
    expect(parseTorrent({}, DATA)).toEqual({ enabled: true, dir: path.join(DATA, 'movies', 'torrents'), uploadKbps: 100, keepDays: 7, discovery: true, peers: [] });
  });

  it('read every variable', () => {
    expect(
      parseTorrent(
        {
          NOTESD_TORRENT: 'off',
          NOTESD_TORRENT_DIR: '/mnt/data/torrents/',
          NOTESD_TORRENT_UPLOAD_KBPS: '64',
          NOTESD_TORRENT_KEEP_DAYS: '3',
          NOTESD_TORRENT_DISCOVERY: 'off',
          NOTESD_TORRENT_PEERS: '127.0.0.1:6881, [::1]:7000,127.0.0.1:6881,seed.local:51413',
        },
        DATA,
      ),
    ).toEqual({ enabled: false, dir: '/mnt/data/torrents', uploadKbps: 64, keepDays: 3, discovery: false, peers: ['127.0.0.1:6881', '[::1]:7000', 'seed.local:51413'] });
  });

  it('refuse a relative folder, a zero cap or keep, and a peer without a port', () => {
    expect(() => parseTorrent({ NOTESD_TORRENT_DIR: 'torrents' }, DATA)).toThrow(/NOTESD_TORRENT_DIR must be an absolute path/);
    expect(() => parseTorrent({ NOTESD_TORRENT_UPLOAD_KBPS: '0' }, DATA)).toThrow(/NOTESD_TORRENT_UPLOAD_KBPS must be a positive integer/);
    expect(() => parseTorrent({ NOTESD_TORRENT_KEEP_DAYS: '0' }, DATA)).toThrow(/NOTESD_TORRENT_KEEP_DAYS must be a positive integer/);
    expect(() => parseTorrent({ NOTESD_TORRENT_PEERS: '127.0.0.1' }, DATA)).toThrow(/NOTESD_TORRENT_PEERS takes host:port/);
    expect(() => parseTorrent({ NOTESD_TORRENT_PEERS: '127.0.0.1:70000' }, DATA)).toThrow(/NOTESD_TORRENT_PEERS takes host:port/);
    expect(() => parseTorrent({ NOTESD_TORRENT: 'maybe' }, DATA)).toThrow(/NOTESD_TORRENT must be "on" or "off"/);
  });

  it('follow NOTES_DATA_DIR in loadConfig', () => {
    const cfg = loadConfig({ env: { DATABASE_URL: 'postgres://u@127.0.0.1:1/db', NOTES_DATA_DIR: '/srv/notes-b' }, envFile: false });
    expect(cfg.torrent?.dir).toBe('/srv/notes-b/movies/torrents');
  });

  it('are off in DEFAULT_TORRENT_CONFIG, whose folder is never in the owner\'s data directory', () => {
    expect(DEFAULT_TORRENT_CONFIG.enabled).toBe(false);
    expect(DEFAULT_TORRENT_CONFIG.dir).not.toContain('mcp-notes-data');
  });
});
```

**File:** `tests/unit/directStream/torrent/store.test.ts` (new)
```ts
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TorrentFolder } from '../../../../src/directStream/torrent/store.js';

const H = 'ab'.repeat(20);
let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'torrent-folder-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function listing(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(`${path.relative(base, full)}/`, ...(await listing(full, base)));
    else out.push(path.relative(base, full));
  }
  return out.sort();
}

describe('TorrentFolder', () => {
  it('names the path webtorrent writes a file to: the last name without reserved characters', () => {
    const f = new TorrentFolder('/data/torrents');
    expect(f.diskPath(H, 'Dune: Part Two (2024)/Dune: Part Two.mkv')).toBe(`/data/torrents/${H}/Dune: Part Two (2024)/Dune Part Two.mkv`);
    expect(f.diskPath(H, 'Film/Film.en.srt')).toBe(`/data/torrents/${H}/Film/Film.en.srt`);
    // fs-chunk-store joins, so a leading slash stays inside the folder.
    expect(f.diskPath(H, '/etc/passwd')).toBe(`/data/torrents/${H}/etc/passwd`);
  });

  it('refuses a path that would leave the torrent folder', () => {
    const f = new TorrentFolder('/data/torrents');
    expect(f.diskPath(H, '../../etc/passwd')).toBeNull();
    expect(f.diskPath(H, 'Film/../../x.mp4')).toBeNull();
    expect(f.diskPath(H, '..')).toBeNull();
    expect(f.contains(H, 'Film/Film.mp4')).toBe(true);
    expect(f.contains(H, '../Film.mp4')).toBe(false);
  });

  it('finds a file only when it is whole', async () => {
    const f = new TorrentFolder(tmp);
    const file = f.diskPath(H, 'Film/Film.mp4')!;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.alloc(10));
    expect(await f.complete(H, 'Film/Film.mp4', 10)).toBe(file);
    expect(await f.complete(H, 'Film/Film.mp4', 11)).toBeNull();
    expect(await f.complete(H, 'Film/Missing.mp4', 10)).toBeNull();
  });

  it('drops the named files and the folders they leave empty, and nothing else', async () => {
    const f = new TorrentFolder(tmp);
    for (const p of ['Film/Film.mp4', 'Film/Sample/sample.mp4', 'Film/README.txt']) {
      const file = f.diskPath(H, p)!;
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, 'x');
    }
    await mkdir(path.join(f.dirOf(H), '.notesd-subs'), { recursive: true });
    await writeFile(path.join(f.dirOf(H), '.notesd-subs', 'en.vtt'), 'WEBVTT');
    expect(await f.dropFiles(H, ['Film/Sample/sample.mp4', 'Film/README.txt', 'Film/setup.exe', '../outside.txt'])).toBe(2);
    expect(await listing(f.dirOf(H))).toEqual(['.notesd-subs/', '.notesd-subs/en.vtt', 'Film/', 'Film/Film.mp4']);
    await f.remove(H);
    await expect(stat(f.dirOf(H))).rejects.toThrow();
  });
});
```

**File:** `tests/unit/directStream/torrent/service.test.ts` (new)
```ts
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../../src/config.js';
import type { Db } from '../../../../src/db/client.js';
import { buildTorrentStreams, TorrentStreams } from '../../../../src/directStream/torrent/service.js';
import { TorrentFolder } from '../../../../src/directStream/torrent/store.js';
import type { TorrentPick } from '../../../../src/directStream/torrent/types.js';
import { FakeTorrentEngine } from '../../../helpers/fakeTorrentEngine.js';
import { MemoryTorrentRecords } from '../../../helpers/memoryTorrentRecords.js';

const HASH = 'c0ffee'.padEnd(40, '0');
const NAME = 'Fixture.Film.2026';
const VIDEO = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));
const SRT = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHello\n');
const EXE = Buffer.from('MZ inert bytes: never fetched, never run');
const FILES = [
  { path: `${NAME}/${NAME}.en.srt`, data: SRT },
  { path: `${NAME}/${NAME}.mp4`, data: VIDEO },
  { path: `${NAME}/setup.exe`, data: EXE },
];
const REF = { kind: 'movie', tmdbId: 550 } as const;
const PICK: TorrentPick = { infoHash: HASH.toUpperCase(), trackers: ['udp://tracker.example:1337/announce'], name: `${NAME}.1080p.WEB-DL`, ref: REF };
const OPEN = { timeoutMs: 1_000 };
const MIN = 60_000;

let root: string;
let clock: number;

function build(options: { host?: string; records?: MemoryTorrentRecords; engine?: FakeTorrentEngine } = {}) {
  const records = options.records ?? new MemoryTorrentRecords();
  const engine = options.engine ?? new FakeTorrentEngine([{ infoHash: HASH, name: NAME, files: FILES }]);
  const folder = new TorrentFolder(root);
  const streams = new TorrentStreams({
    engine,
    repo: records,
    folder,
    host: options.host ?? 'host-a',
    uploadKbps: 100,
    keepDays: 7,
    discovery: true,
    now: () => new Date(clock),
    log: () => undefined,
    every: () => () => undefined,
  });
  return { streams, engine, records, folder };
}

async function put(folder: TorrentFolder, filePath: string, data: Buffer | string): Promise<void> {
  const file = folder.diskPath(HASH, filePath)!;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
}

async function onDisk(folder: TorrentFolder): Promise<string[]> {
  const walk = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await walk(full)));
      else out.push(path.relative(folder.dirOf(HASH), full));
    }
    return out;
  };
  return (await walk(folder.dirOf(HASH))).sort();
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'torrents-'));
  clock = Date.parse('2026-11-16T12:00:00Z');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('TorrentStreams', () => {
  it('opens a torrent with nothing chosen and records it downloading', async () => {
    const { streams, engine, records } = build();
    const handle = await streams.open(PICK, OPEN);
    expect(handle.live).toBe(true);
    expect(handle.files.map((f) => f.path)).toEqual(FILES.map((f) => f.path));
    expect(engine.added).toEqual([HASH]);
    expect(engine.selected).toEqual([]);
    expect(await streams.open(PICK, OPEN)).toBe(handle);
    expect(records.rows).toMatchObject([{ host: 'host-a', infoHash: HASH, name: NAME, release: `${NAME}.1080p.WEB-DL`, state: 'downloading', fileIndex: null }]);
    expect(streams.status()).toMatchObject({ port: 6881, swarm: [{ info_hash: HASH, users: 0 }] });
  });

  it('downloads only the video and subtitle files it is asked to use (R2.2)', async () => {
    const { streams, engine, records } = build();
    await streams.open(PICK, OPEN);
    await expect(streams.use(HASH, [2])).rejects.toMatchObject({ code: 'not_media' });
    await expect(streams.use(HASH, [1, 7])).rejects.toMatchObject({ code: 'not_media' });
    expect(engine.selected).toEqual([]);
    await streams.use(HASH, [1, 0]);
    expect(engine.selected).toEqual([{ infoHash: HASH, indexes: [1, 0] }]);
    expect(records.rows[0]).toMatchObject({ fileIndex: 1, fileLength: VIDEO.length, files: [{ index: 1 }, { index: 0 }] });
    const exe = await streams.serve(HASH, 2, null);
    expect(exe.status).toBe(404);
    expect(await exe.json()).toMatchObject({ error: 'not_selected' });
  });

  it('answers a byte range of a chosen file with exactly those bytes, read through the swarm (R2.1)', async () => {
    const { streams, engine } = build();
    await streams.open(PICK, OPEN);
    await streams.use(HASH, [1]);
    const res = await streams.serve(HASH, 1, 'bytes=3686-3785');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 3686-3785/${VIDEO.length}`);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await res.arrayBuffer()).equals(VIDEO.subarray(3686, 3786))).toBe(true);
    expect(engine.reads).toEqual([{ infoHash: HASH, index: 1, start: 3686, end: 3785 }]);
    expect((await streams.serve(HASH, 1, 'bytes=9000-')).status).toBe(416);
    expect(await streams.map(HASH)).toEqual({ duration_s: null, ranges: [], length: VIDEO.length, byte_ranges: [[3686, 3786]] });
    await streams.setDuration(HASH, 100);
    expect((await streams.map(HASH))?.ranges).toEqual([[90, 92.4]]);
  });

  it('leaves the swarm at once when a finished download is released, keeping only the chosen files (R2.3)', async () => {
    const { streams, engine, records, folder } = build();
    await streams.open(PICK, OPEN);
    await streams.use(HASH, [1, 0]);
    engine.have(HASH, 1);
    engine.have(HASH, 0);
    await put(folder, FILES[0]!.path, SRT);
    await put(folder, FILES[1]!.path, VIDEO);
    await put(folder, FILES[2]!.path, 'edge bytes of a shared piece');
    await mkdir(path.join(folder.dirOf(HASH), '.notesd-subs'), { recursive: true });
    await writeFile(path.join(folder.dirOf(HASH), '.notesd-subs', 'en.vtt'), 'WEBVTT');
    await streams.tick();
    expect(records.rows[0]).toMatchObject({ state: 'ready', bytesDone: VIDEO.length });
    expect(engine.removed).toEqual([]);
    await streams.release(HASH);
    expect(engine.removed).toEqual([HASH]);
    expect(streams.status().swarm).toEqual([]);
    expect(await onDisk(folder)).toEqual(['.notesd-subs/en.vtt', FILES[0]!.path, FILES[1]!.path].sort());
    expect(await streams.view(HASH)).toMatchObject({ state: 'ready', in_swarm: false, peers: 0, progress: 1 });
  });

  it('keeps an unfinished download in the swarm until nothing asked for it for three minutes (R2.3)', async () => {
    const { streams, engine } = build();
    await streams.open(PICK, OPEN);
    await streams.use(HASH, [1]);
    await streams.release(HASH);
    await streams.tick();
    expect(engine.removed).toEqual([]);
    clock += 2 * MIN;
    await streams.tick();
    expect(engine.removed).toEqual([]);
    expect((await streams.serve(HASH, 1, 'bytes=0-9')).status).toBe(206);
    clock += 2 * MIN;
    await streams.tick();
    expect(engine.removed).toEqual([]);
    clock += 1.5 * MIN;
    await streams.tick();
    expect(engine.removed).toEqual([HASH]);
    const later = await streams.serve(HASH, 1, 'bytes=0-9');
    expect(later.status).toBe(409);
    expect(await later.json()).toMatchObject({ error: 'not_in_swarm' });
  });

  it('drops at once a torrent opened and never used, and ignores an unknown hash', async () => {
    const { streams, engine } = build();
    await streams.open(PICK, OPEN);
    await streams.release('f'.repeat(40));
    await streams.release('not a hash');
    expect(engine.removed).toEqual([]);
    await streams.release(HASH);
    expect(engine.removed).toEqual([HASH]);
  });

  it('records a torrent no peer describes as failed', async () => {
    const { streams, records } = build({ engine: new FakeTorrentEngine([]) });
    await expect(streams.open(PICK, OPEN)).rejects.toMatchObject({ code: 'no_metadata' });
    expect(records.rows[0]).toMatchObject({ state: 'failed', error: 'no_metadata' });
  });

  it('plays a finished download from disk without joining a swarm (R2.9)', async () => {
    const records = new MemoryTorrentRecords();
    const at = new Date(clock - 3 * 86_400_000);
    await records.record('host-a', { infoHash: HASH, ref: REF, name: NAME, release: PICK.name, trackers: [] }, at);
    await records.chosen('host-a', HASH, { files: [{ index: 1, path: FILES[1]!.path, length: VIDEO.length }, { index: 0, path: FILES[0]!.path, length: SRT.length }], fileIndex: 1, fileLength: VIDEO.length }, at);
    await records.ready('host-a', HASH, VIDEO.length, at);
    const engine = new FakeTorrentEngine([]);
    const { streams, folder } = build({ records, engine });
    await put(folder, FILES[1]!.path, VIDEO);
    await put(folder, FILES[0]!.path, SRT);
    const handle = await streams.open(PICK, OPEN);
    expect(handle.live).toBe(false);
    expect(handle.files.map((f) => f.index)).toEqual([1, 0]);
    await streams.use(HASH, [1, 0]);
    const res = await streams.serve(HASH, 1, 'bytes=0-9');
    expect(res.status).toBe(206);
    expect(Buffer.from(await res.arrayBuffer()).equals(VIDEO.subarray(0, 10))).toBe(true);
    expect(engine.added).toEqual([]);
    expect(streams.status()).toMatchObject({ port: null, swarm: [] });
    expect(await streams.find(REF)).toMatchObject({ infoHash: HASH, fileIndex: 1, state: 'ready' });
    expect(await streams.filePath(HASH, 1)).toBe(folder.diskPath(HASH, FILES[1]!.path));
    expect(records.rows[0]?.playedAt?.getTime()).toBe(clock);
  });

  it('answers not_on_this_machine for the other machine\'s download', async () => {
    const records = new MemoryTorrentRecords();
    await records.record('host-b', { infoHash: HASH, ref: REF, name: NAME, release: null, trackers: [] }, new Date(clock));
    const { streams } = build({ records });
    const res = await streams.serve(HASH, 1, null);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_on_this_machine', host: 'host-b' });
    expect(await streams.view(HASH)).toMatchObject({ host: 'host-b', available: false, file_url: null });
    expect(await streams.map(HASH)).toBeNull();
    expect(await streams.find(REF)).toBeNull();
  });

  it('clears downloads not played for keepDays, with their folders', async () => {
    const records = new MemoryTorrentRecords();
    const OLD = 'a1'.repeat(20);
    await records.record('host-a', { infoHash: OLD, ref: REF, name: 'Old', release: null, trackers: [] }, new Date(clock - 30 * 86_400_000));
    await records.played('host-a', OLD, new Date(clock - 8 * 86_400_000));
    await records.record('host-a', { infoHash: HASH, ref: REF, name: NAME, release: null, trackers: [] }, new Date(clock - 30 * 86_400_000));
    await records.played('host-a', HASH, new Date(clock - 86_400_000));
    const { streams, folder } = build({ records });
    await mkdir(folder.dirOf(OLD), { recursive: true });
    expect(await streams.start()).toBe(1);
    expect(records.rows.map((r) => r.infoHash)).toEqual([HASH]);
    await expect(readdir(folder.dirOf(OLD))).rejects.toThrow();
  });

  it('is not built with torrents off or direct streaming off, and building it joins nothing (R2.6)', () => {
    const env = { DATABASE_URL: 'postgres://u@127.0.0.1:1/db', NOTES_DATA_DIR: root };
    const db = {} as Db;
    const off = loadConfig({ env: { ...env, NOTESD_TORRENT: 'off' }, envFile: false });
    expect(buildTorrentStreams(off, { host: 'host-a' }, db)).toBeNull();
    const on = loadConfig({ env, envFile: false });
    expect(buildTorrentStreams(on, null, db)).toBeNull();
    const built = buildTorrentStreams(on, { host: 'host-a' }, db);
    expect(built).not.toBeNull();
    expect(built?.root).toBe(path.join(root, 'movies', 'torrents'));
    expect(built?.status()).toMatchObject({ port: null, swarm: [], upload_cap_bytes_per_s: 100_000 });
  });
});
```

**File:** `tests/unit/directStream/torrent/routes.test.ts` (new)
```ts
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DirectStreamService } from '../../../../src/directStream/service.js';
import { TorrentStreams } from '../../../../src/directStream/torrent/service.js';
import { TorrentFolder } from '../../../../src/directStream/torrent/store.js';
import { streamTorrentRoutes } from '../../../../src/http/streamTorrentApi.js';
import { FakeTorrentEngine } from '../../../helpers/fakeTorrentEngine.js';
import { MemoryTorrentRecords } from '../../../helpers/memoryTorrentRecords.js';

const HASH = 'beef'.padEnd(40, '1');
const NAME = 'Fixture.Film.2026';
const VIDEO = Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 7) % 256));
const DIRECT = {} as unknown as DirectStreamService;
const JSON_SAME = { origin: 'http://localhost', 'content-type': 'application/json' };
const OPEN = { info_hash: HASH, kind: 'movie', tmdb_id: 550, name: `${NAME}.1080p` };

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'torrent-routes-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function app() {
  const engine = new FakeTorrentEngine([
    { infoHash: HASH, name: NAME, files: [{ path: `${NAME}/${NAME}.mp4`, data: VIDEO }, { path: `${NAME}/setup.exe`, data: Buffer.from('MZ') }] },
  ]);
  const torrents = new TorrentStreams({
    engine,
    repo: new MemoryTorrentRecords(),
    folder: new TorrentFolder(root),
    host: 'host-a',
    uploadKbps: 100,
    keepDays: 7,
    discovery: true,
    log: () => undefined,
    every: () => () => undefined,
  });
  return { app: new Hono().route('/', streamTorrentRoutes({ directStream: DIRECT, torrents })), engine };
}

describe('the torrent routes', () => {
  it('answer direct_stream_off without direct streaming and torrent_off with torrents off (R2.6)', async () => {
    const none = new Hono().route('/', streamTorrentRoutes({ directStream: null }));
    const res = await none.request('/api/stream/torrent');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'direct_stream_off' });
    const off = new Hono().route('/', streamTorrentRoutes({ directStream: DIRECT, torrents: null }));
    const calls: [string, string][] = [
      ['GET', '/api/stream/torrent'],
      ['POST', '/api/stream/torrent'],
      ['GET', `/api/stream/torrent/${HASH}`],
      ['GET', `/api/stream/torrent/${HASH}/map`],
      ['GET', `/api/stream/torrent/${HASH}/f/0`],
      ['POST', `/api/stream/torrent/${HASH}/release`],
    ];
    for (const [method, url] of calls) {
      const answer = await off.request(url, { method, headers: JSON_SAME, ...(method === 'POST' ? { body: JSON.stringify(OPEN) } : {}) });
      expect(answer.status, `${method} ${url}`).toBe(503);
      expect(await answer.json()).toMatchObject({ error: 'torrent_off' });
    }
  });

  it('open, use, serve a range and release a torrent', async () => {
    const { app: a, engine } = app();
    const listed = await a.request('/api/stream/torrent', { method: 'POST', headers: JSON_SAME, body: JSON.stringify(OPEN) });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      ok: true,
      from_disk: false,
      files: [
        { index: 0, media: 'video', length: VIDEO.length },
        { index: 1, media: null },
      ],
      torrent: { info_hash: HASH, state: 'downloading', users: 0, release: `${NAME}.1080p` },
    });
    const used = await a.request('/api/stream/torrent', { method: 'POST', headers: JSON_SAME, body: JSON.stringify({ ...OPEN, files: [0] }) });
    expect(await used.json()).toMatchObject({ torrent: { users: 1, file_index: 0, file_url: `/api/stream/torrent/${HASH}/f/0` } });
    const again = await a.request('/api/stream/torrent', { method: 'POST', headers: JSON_SAME, body: JSON.stringify({ ...OPEN, files: [0] }) });
    expect(await again.json()).toMatchObject({ torrent: { users: 1 } });
    const range = await a.request(`/api/stream/torrent/${HASH}/f/0`, { headers: { range: 'bytes=100-199' } });
    expect(range.status).toBe(206);
    expect(Buffer.from(await range.arrayBuffer()).equals(VIDEO.subarray(100, 200))).toBe(true);
    const status = await (await a.request('/api/stream/torrent')).json();
    expect(status).toMatchObject({ port: 6881, swarm: [{ info_hash: HASH, users: 1 }], downloads: [{ info_hash: HASH }] });
    const released = await a.request(`/api/stream/torrent/${HASH}/release`, { method: 'POST', headers: JSON_SAME });
    expect(await released.json()).toMatchObject({ ok: true, released: true, torrent: { users: 0 } });
    expect(engine.removed).toEqual([]);
    const map = await (await a.request(`/api/stream/torrent/${HASH}/map`)).json();
    expect(map).toEqual({ duration_s: null, ranges: [], length: VIDEO.length, byte_ranges: [[100, 200]] });
  });

  it('refuse a cross-origin open, a file that is neither video nor subtitle, and an unknown hash', async () => {
    const { app: a } = app();
    const cross = await a.request('/api/stream/torrent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(OPEN) });
    expect(cross.status).toBe(403);
    const exe = await a.request('/api/stream/torrent', { method: 'POST', headers: JSON_SAME, body: JSON.stringify({ ...OPEN, files: [1] }) });
    expect(exe.status).toBe(400);
    expect(await exe.json()).toMatchObject({ error: 'not_media' });
    const bad = await a.request('/api/stream/torrent', { method: 'POST', headers: JSON_SAME, body: JSON.stringify({ ...OPEN, info_hash: 'xyz' }) });
    expect(bad.status).toBe(400);
    expect((await a.request(`/api/stream/torrent/${'0'.repeat(40)}`)).status).toBe(404);
    expect((await a.request(`/api/stream/torrent/${'0'.repeat(40)}/f/0`)).status).toBe(404);
    const missing = await a.request('/api/stream/torrent', { method: 'POST', headers: JSON_SAME, body: JSON.stringify({ ...OPEN, info_hash: '9'.repeat(40) }) });
    expect(missing.status).toBe(504);
    expect(await missing.json()).toMatchObject({ error: 'no_metadata' });
  });
});
```

**File:** `tests/unit/directStream/torrent/engine.test.ts` (new) — the real engine over loopback (no network:
DHT, trackers, LSD, UPnP and uTP off; the seeder is added by address).
```ts
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebTorrent, { type Torrent } from 'webtorrent';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebTorrentEngine } from '../../../../src/directStream/torrent/engine.js';
import { TorrentFolder } from '../../../../src/directStream/torrent/store.js';
import type { TorrentHandle } from '../../../../src/directStream/torrent/types.js';

const NAME = 'Fixture.Film.2026';
const PIECE = 32_768;
const FILM = 2 * 1_048_576;
const SEEDER_BYTES_PER_S = 300_000;
const CAP_KBPS = 50;
const SRT = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHello from loopback\n');
const QUIET = { dht: false, tracker: false, lsd: false, natUpnp: false, natPmp: false, utp: false, webSeeds: false } as const;

/** The same pseudo-random bytes on every run (xorshift32). */
function bytes(length: number, seed: number): Buffer {
  const out = Buffer.alloc(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i += 1) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

async function files(dir: string, base = dir): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) Object.assign(out, await files(full, base));
    else out[path.relative(base, full)] = (await stat(full)).size;
  }
  return out;
}

async function until(check: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function readAll(handle: TorrentHandle, index: number, start: number, end: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of handle.read(index, { start, end })) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

const film = bytes(FILM, 7);
let tmp: string;
let seeder: WebTorrent;
let seeded: Torrent;
let folder: TorrentFolder;
let engine: WebTorrentEngine;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'torrent-engine-'));
  const src = path.join(tmp, 'src', NAME);
  await mkdir(path.join(src, 'Sample'), { recursive: true });
  await writeFile(path.join(src, `${NAME}.en.srt`), SRT);
  await writeFile(path.join(src, `${NAME}.mp4`), film);
  await writeFile(path.join(src, 'Sample', 'sample.mp4'), bytes(200_000, 11));
  await writeFile(path.join(src, 'setup.exe'), bytes(600_000, 13));
  seeder = new WebTorrent({ ...QUIET, uploadLimit: SEEDER_BYTES_PER_S });
  seeder.on('error', () => undefined);
  seeded = await new Promise<Torrent>((resolve) => seeder.seed(src, { announce: [], pieceLength: PIECE }, resolve));
  if (!seeder.listening) await new Promise<void>((resolve) => seeder.once('listening', () => resolve()));
  folder = new TorrentFolder(path.join(tmp, 'torrents'));
  engine = new WebTorrentEngine({
    folder,
    uploadKbps: CAP_KBPS,
    discovery: false,
    peers: [`127.0.0.1:${seeder.address()?.port}`],
    log: () => undefined,
    utp: false,
  });
}, 30_000);

afterAll(async () => {
  await engine.close();
  await new Promise<void>((resolve) => seeder.destroy(() => resolve()));
  await rm(tmp, { recursive: true, force: true });
});

describe('WebTorrentEngine over loopback', () => {
  it('answers the file list once a peer sends it, with nothing selected or written', async () => {
    expect(engine.port()).toBeNull();
    const handle = await engine.add({ infoHash: seeded.infoHash, trackers: [], name: NAME }, { timeoutMs: 15_000 });
    expect(handle.files.map((f) => [f.index, f.path, f.length])).toEqual([
      [0, `${NAME}/${NAME}.en.srt`, SRT.length],
      [1, `${NAME}/${NAME}.mp4`, FILM],
      [2, `${NAME}/Sample/sample.mp4`, 200_000],
      [3, `${NAME}/setup.exe`, 600_000],
    ]);
    expect(await files(folder.dirOf(seeded.infoHash))).toEqual({});
    expect(engine.port()).toEqual(expect.any(Number));
  }, 30_000);

  it('reads a byte range before the rest of the file, and exactly the bytes asked for (R2.1)', async () => {
    const handle = engine.get(seeded.infoHash)!;
    handle.select([1, 0]);
    const start = Math.floor(FILM * 0.9);
    const end = start + 65_535;
    expect((await readAll(handle, 1, start, end)).equals(film.subarray(start, end + 1))).toBe(true);
    const have = handle.ranges(1);
    expect(have.some(([from, to]) => from <= start && to >= end + 1)).toBe(true);
    expect(have.reduce((n, [from, to]) => n + (to - from), 0)).toBeLessThan(FILM / 2);
    expect((await readAll(handle, 1, 0, 0)).equals(film.subarray(0, 1))).toBe(true);
  }, 30_000);

  it('writes only the chosen files under the torrent folder; an unchosen neighbour gets at most one piece\'s edge (R2.2)', async () => {
    const handle = engine.get(seeded.infoHash)!;
    await until(() => handle.done(1) && handle.done(0), 25_000);
    const disk = await files(folder.dirOf(seeded.infoHash));
    expect(disk[`${NAME}/${NAME}.mp4`]).toBe(FILM);
    expect(disk[`${NAME}/${NAME}.en.srt`]).toBe(SRT.length);
    expect(disk[`${NAME}/setup.exe`]).toBeUndefined();
    expect(disk[`${NAME}/Sample/sample.mp4`] ?? 0).toBeLessThanOrEqual(PIECE);
    expect(handle.stats()).toMatchObject({ peers: expect.any(Number), down_kbps: expect.any(Number), up_kbps: expect.any(Number) });
  }, 30_000);

  it('uploads to another peer no faster than the cap (R2.3)', async () => {
    const leecher = new WebTorrent({ ...QUIET, utPex: false });
    leecher.on('error', () => undefined);
    try {
      const port = engine.port();
      const t = leecher.add(seeded.infoHash, { path: path.join(tmp, 'leecher'), deselect: true, announce: [] });
      t.once('infoHash', () => t.addPeer(`127.0.0.1:${port}`));
      if (!t.ready) await new Promise<void>((resolve) => t.once('ready', () => resolve()));
      const want = 256 * 1024;
      const iterator = t.files[1]![Symbol.asyncIterator]({ start: 0, end: want - 1 });
      const started = Date.now();
      let got = 0;
      while (got < want) {
        const next = await iterator.next();
        if (next.done === true) break;
        got += next.value.length;
      }
      const seconds = (Date.now() - started) / 1000;
      expect(got).toBe(want);
      expect(t.wires.map((w) => w.remotePort)).toEqual([port]);
      expect(got / seconds).toBeLessThanOrEqual(CAP_KBPS * 1000 * 1.25);
    } finally {
      await new Promise<void>((resolve) => leecher.destroy(() => resolve()));
    }
  }, 30_000);

  it('leaves the swarm when the torrent is removed, and stops listening once nothing is left (R2.3)', async () => {
    expect(seeded.numPeers).toBeGreaterThanOrEqual(1);
    await engine.remove(seeded.infoHash, { deleteFiles: false });
    await until(() => seeded.numPeers === 0, 5_000);
    expect(engine.get(seeded.infoHash)).toBeNull();
    expect(engine.port()).toBeNull();
    expect((await files(folder.dirOf(seeded.infoHash)))[`${NAME}/${NAME}.mp4`]).toBe(FILM);
  }, 30_000);

  it('gives up on a torrent no peer describes, and stops again', async () => {
    await expect(engine.add({ infoHash: 'f'.repeat(40), trackers: [], name: null }, { timeoutMs: 1_500 })).rejects.toMatchObject({ code: 'no_metadata' });
    expect(engine.port()).toBeNull();
  }, 30_000);
});
```
**Impact:** `npm test` gains ~20 s of loopback work in one file; nothing leaves 127.0.0.1.

### Step 18: Integration test against the real table
**File:** `tests/integration/setup.ts:50` — in the `truncate table` list, put `stream_torrents, ` before `stream_caches`.
**File:** `tests/integration/directStream.torrents.int.test.ts` (new)
```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { streamTorrents } from '../../src/db/schema.js';
import { TorrentsRepo } from '../../src/directStream/torrent/repo.js';
import { TorrentStreams } from '../../src/directStream/torrent/service.js';
import { TorrentFolder } from '../../src/directStream/torrent/store.js';
import { FakeTorrentEngine } from '../helpers/fakeTorrentEngine.js';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

const HASH = '0123456789abcdef0123456789abcdef01234567';
const NAME = 'Fixture.Film.2026';
const VIDEO = Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 199));
const REF = { kind: 'movie', tmdbId: 550 } as const;
const EPISODE = { kind: 'tv', tmdbId: 1399, season: 1, episode: 2 } as const;
const T0 = new Date('2026-11-16T12:00:00Z');

let db: Db;
let repo: TorrentsRepo;
let root: string;

async function pgCode(statement: Promise<unknown>): Promise<string | undefined> {
  try {
    await statement;
  } catch (err) {
    let cur: unknown = err;
    while (cur && typeof cur === 'object') {
      const e = cur as { code?: unknown; cause?: unknown };
      if (typeof e.code === 'string') return e.code;
      cur = e.cause;
    }
    return undefined;
  }
  throw new Error('expected the statement to fail');
}

function streams(host: string, engine = new FakeTorrentEngine([])): TorrentStreams {
  return new TorrentStreams({ engine, repo, folder: new TorrentFolder(root), host, uploadKbps: 100, keepDays: 7, discovery: true, now: () => T0, log: () => undefined, every: () => () => undefined });
}

beforeAll(() => {
  db = openTestDb();
  repo = new TorrentsRepo(db);
});
afterAll(async () => {
  await closeTestDb(db);
});
beforeEach(async () => {
  await truncateAll(db);
  root = await mkdtemp(path.join(os.tmpdir(), 'torrents-int-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('stream_torrents', () => {
  it('keeps one row per host and hash; another title slot forgets the chosen files', async () => {
    const first = await repo.record('host-a', { infoHash: HASH, ref: REF, name: NAME, release: 'Release.A', trackers: ['udp://t.example:1/announce'] }, T0);
    expect(first).toMatchObject({ state: 'downloading', fileIndex: null, files: [], trackers: ['udp://t.example:1/announce'] });
    await repo.chosen('host-a', HASH, { files: [{ index: 1, path: `${NAME}/${NAME}.mp4`, length: 3000 }], fileIndex: 1, fileLength: 3000 }, T0);
    const same = await repo.record('host-a', { infoHash: HASH, ref: REF, name: NAME, release: null, trackers: [] }, T0);
    expect(same).toMatchObject({ fileIndex: 1, release: 'Release.A', trackers: ['udp://t.example:1/announce'] });
    const other = await repo.record('host-a', { infoHash: HASH, ref: EPISODE, name: NAME, release: null, trackers: [] }, T0);
    expect(other).toMatchObject({ kind: 'tv', season: 1, episode: 2, fileIndex: null, files: [], state: 'downloading' });
    await repo.record('host-b', { infoHash: HASH, ref: REF, name: NAME, release: null, trackers: [] }, T0);
    expect((await repo.byHash(HASH)).map((r) => r.host)).toEqual(['host-a', 'host-b']);
  });

  it('refuses contradictions', async () => {
    const base = { host: 'host-a', infoHash: HASH, kind: 'movie' as const, tmdbId: 550, name: NAME };
    expect(await pgCode(db.insert(streamTorrents).values({ ...base, infoHash: HASH.toUpperCase() }))).toBe('23514');
    expect(await pgCode(db.insert(streamTorrents).values({ ...base, state: 'ready', completedAt: T0 }))).toBe('23514');
    expect(await pgCode(db.insert(streamTorrents).values({ ...base, state: 'ready', fileIndex: 0 }))).toBe('23514');
    expect(await pgCode(db.insert(streamTorrents).values({ ...base, state: 'failed' }))).toBe('23514');
    expect(await pgCode(db.insert(streamTorrents).values({ ...base, kind: 'movie', season: 1, episode: 1 }))).toBe('23514');
  });

  it('moves through ready, failed and restarted without breaking a check', async () => {
    await repo.record('host-a', { infoHash: HASH, ref: REF, name: NAME, release: null, trackers: [] }, T0);
    await repo.chosen('host-a', HASH, { files: [{ index: 1, path: `${NAME}/${NAME}.mp4`, length: 3000 }], fileIndex: 1, fileLength: 3000 }, T0);
    expect(await repo.ready('host-a', HASH, 3000, T0)).toMatchObject({ state: 'ready', completedAt: T0 });
    await repo.failed('host-a', HASH, 'no_metadata', T0);
    expect(await repo.get('host-a', HASH)).toMatchObject({ state: 'failed', error: 'no_metadata', completedAt: null });
    await repo.restarted('host-a', HASH, T0);
    expect(await repo.get('host-a', HASH)).toMatchObject({ state: 'downloading', error: null, bytesDone: 0 });
  });

  it('finds what was not played for the window: by played_at, else completed_at, else created_at', async () => {
    const day = 86_400_000;
    await repo.record('host-a', { infoHash: 'a'.repeat(40), ref: REF, name: 'never played', release: null, trackers: [] }, new Date(T0.getTime() - 9 * day));
    await repo.record('host-a', { infoHash: 'b'.repeat(40), ref: REF, name: 'played lately', release: null, trackers: [] }, new Date(T0.getTime() - 9 * day));
    await repo.played('host-a', 'b'.repeat(40), new Date(T0.getTime() - day));
    await repo.record('host-b', { infoHash: 'c'.repeat(40), ref: REF, name: 'other machine', release: null, trackers: [] }, new Date(T0.getTime() - 9 * day));
    const stale = await repo.stale('host-a', new Date(T0.getTime() - 7 * day));
    expect(stale.map((r) => r.name)).toEqual(['never played']);
  });

  it('shows the other machine\'s download with available: false and serves none of it', async () => {
    await repo.record('host-b', { infoHash: HASH, ref: REF, name: NAME, release: null, trackers: [] }, T0);
    const here = streams('host-a');
    expect(await here.view(HASH)).toMatchObject({ host: 'host-b', available: false, file_url: null });
    const res = await here.serve(HASH, 0, null);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_on_this_machine', host: 'host-b' });
    expect((await here.list()).map((v) => v.available)).toEqual([false]);
  });

  it('plays a finished download from disk after a restart, with no swarm (R2.9)', async () => {
    const file = `${NAME}/${NAME}.mp4`;
    await repo.record('host-a', { infoHash: HASH, ref: REF, name: NAME, release: null, trackers: [] }, T0);
    await repo.chosen('host-a', HASH, { files: [{ index: 1, path: file, length: VIDEO.length }], fileIndex: 1, fileLength: VIDEO.length }, T0);
    await repo.ready('host-a', HASH, VIDEO.length, T0);
    const folder = new TorrentFolder(root);
    const onDisk = folder.diskPath(HASH, file)!;
    await mkdir(path.dirname(onDisk), { recursive: true });
    await writeFile(onDisk, VIDEO);
    const engine = new FakeTorrentEngine([]);
    const restarted = streams('host-a', engine);
    expect(await restarted.find(REF)).toMatchObject({ infoHash: HASH, fileIndex: 1, state: 'ready' });
    const handle = await restarted.open({ infoHash: HASH, trackers: [], name: null, ref: REF }, { timeoutMs: 1_000 });
    expect(handle.live).toBe(false);
    const res = await restarted.serve(HASH, 1, 'bytes=2990-');
    expect(res.status).toBe(206);
    expect(Buffer.from(await res.arrayBuffer()).equals(VIDEO.subarray(2990))).toBe(true);
    expect(engine.added).toEqual([]);
    expect((await repo.get('host-a', HASH))?.playedAt).toEqual(T0);
  });
});
```
**Impact:** test-only; needs `npm run test:int` (Docker Postgres) with the new migration applied.

### Step 19: The verify harness: fixture, seeder, `--torrent`
**File:** `.claude/skills/verify-notesd/scripts/torrent/make-fixture.sh` (new, `chmod +x`)
```bash
#!/usr/bin/env bash
# make-fixture.sh DEST: the torrents `verify.sh up --torrent` seeds on loopback (torrent-stream-source phase 1).
#   DEST/Fixture.Film.2026.1080p.WEB-DL.x264-NOTESD/   a 120 s H.264/AAC MP4 (faststart, audio tagged eng),
#       its .en.srt, README.txt, Sample/sample.mp4 (5 s) and setup.exe (inert text: a file notesd must
#       never fetch or run, only its name says "program")
#   DEST/Fixture.Show.S01.1080p.WEB-DL.x264-NOTESD/    a season pack: S01E01 and S01E02, 20 s each
# Idempotent: DEST/.complete-v1 marks a finished build. Prints DEST.
set -euo pipefail
DEST=${1:?usage: make-fixture.sh DEST}
STAMP="$DEST/.complete-v1"
if [ -f "$STAMP" ]; then
  echo "$DEST"
  exit 0
fi
command -v ffmpeg >/dev/null || { echo "make-fixture: ffmpeg is not on PATH" >&2; exit 1; }
rm -rf "$DEST"
FILM=Fixture.Film.2026.1080p.WEB-DL.x264-NOTESD
SHOW=Fixture.Show.S01.1080p.WEB-DL.x264-NOTESD
mkdir -p "$DEST/$FILM/Sample" "$DEST/$SHOW"

clip() { # clip PATH SECONDS HZ: H.264 + AAC (English), fast start, so Chrome plays it as is
  ffmpeg -hide_banner -loglevel error -nostdin -y \
    -f lavfi -i "testsrc2=size=640x360:rate=25" -f lavfi -i "sine=frequency=$3:sample_rate=48000" \
    -t "$2" -c:v libx264 -preset veryfast -pix_fmt yuv420p -b:v 400k -g 50 \
    -c:a aac -b:a 64k -metadata:s:a:0 language=eng -movflags +faststart "$1"
}

clip "$DEST/$FILM/$FILM.mp4" 120 440
clip "$DEST/$FILM/Sample/sample.mp4" 5 660
cat >"$DEST/$FILM/$FILM.en.srt" <<'EOF'
1
00:00:01,000 --> 00:00:04,000
A torrent fixture, made by notesd's verify harness.

2
00:00:05,000 --> 00:00:08,000
Every byte of it came over loopback.
EOF
printf 'notesd verify fixture: a torrent may carry files like this one. notesd never downloads them.\n' >"$DEST/$FILM/README.txt"
head -c 1048576 < <(yes 'notesd fixture: never fetched, never run') >"$DEST/$FILM/setup.exe"
clip "$DEST/$SHOW/Fixture.Show.S01E01.1080p.WEB-DL.x264-NOTESD.mp4" 20 523
clip "$DEST/$SHOW/Fixture.Show.S01E02.1080p.WEB-DL.x264-NOTESD.mp4" 20 587
touch "$STAMP"
echo "$DEST"
```

**File:** `.claude/skills/verify-notesd/scripts/torrent/seed.mjs` (new)
```js
#!/usr/bin/env node
// seed.mjs: the loopback swarm of `verify.sh up --torrent` (torrent-stream-source phase 1). No DHT, no
// tracker, no local discovery, no UPnP: a peer reaches it only by its address, so nothing leaves 127.0.0.1.
//
//   seed --film DIR --pack DIR --state STATE [--upload-kbps N]
//       Seeds the two folders from one client on a free port. Once it listens, writes STATE/fixture.json and
//       STATE/pack.json ({info_hash, name, trackers: [], port, piece_length, files: [{index, path, length}]}),
//       then one line a second to STATE/seeder.jsonl ({at, torrents: [{info_hash, peers, uploaded}]}).
//       Every folder that appears in STATE/seed/<name>/ (move it in whole: copy to a dot-name, then rename) is
//       seeded from the same client and port, and STATE/seeded/<name>.json is written in the same shape: the
//       fixtures of later phases (phase 5's MKV, phase 6's subtitle torrents, phase 8's silent film).
//       Runs until SIGTERM.
//   leech --info-hash H --peer HOST:PORT --file INDEX --bytes N --out DIR [--timeout-s S]
//       Joins only HOST:PORT (no PEX either), reads the first N bytes of file INDEX and prints
//       {bytes, seconds, bytes_per_s, peers}: how fast that peer uploads to a stranger.
import { appendFileSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import WebTorrent from 'webtorrent'

const QUIET = { dht: false, tracker: false, lsd: false, natUpnp: false, natPmp: false, utp: false, webSeeds: false }
const PIECE = 32768

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]
    if (!name.startsWith('--') || i + 1 >= argv.length) throw new Error(`unexpected argument ${name}`)
    out[name.slice(2)] = argv[i + 1]
  }
  return out
}

function need(opts, name) {
  const value = opts[name]
  if (value === undefined || value === '') throw new Error(`--${name} is required`)
  return value
}

function writeJson(file, value) {
  writeFileSync(`${file}.part`, `${JSON.stringify(value)}\n`)
  renameSync(`${file}.part`, file)
}

function describe(torrent, port) {
  return {
    info_hash: torrent.infoHash,
    name: torrent.name,
    trackers: [],
    port,
    piece_length: torrent.pieceLength,
    files: torrent.files.map((f, index) => ({ index, path: f.path, length: f.length })),
  }
}

async function seed(opts) {
  const state = path.resolve(need(opts, 'state'))
  mkdirSync(state, { recursive: true })
  const kbps = opts['upload-kbps'] === undefined ? 0 : Number(opts['upload-kbps'])
  const client = new WebTorrent({ ...QUIET, uploadLimit: kbps > 0 ? Math.round(kbps * 1000) : -1 })
  client.on('error', (err) => {
    console.error(`seed: ${err.message}`)
    process.exit(1)
  })
  const add = (dir) => new Promise((resolve) => client.seed(path.resolve(dir), { announce: [], pieceLength: PIECE }, resolve))
  const film = await add(need(opts, 'film'))
  const pack = await add(need(opts, 'pack'))
  if (!client.listening) await new Promise((resolve) => client.once('listening', resolve))
  const port = client.address().port
  writeJson(path.join(state, 'fixture.json'), describe(film, port))
  writeJson(path.join(state, 'pack.json'), describe(pack, port))
  console.log(`seed: ${film.name} ${film.infoHash} and ${pack.name} ${pack.infoHash} on 127.0.0.1:${port}`)
  // Later phases' fixtures: every folder moved into STATE/seed/<name>/ is seeded too, then STATE/seeded/<name>.json.
  const seedDir = path.join(state, 'seed')
  const seededDir = path.join(state, 'seeded')
  mkdirSync(seedDir, { recursive: true })
  mkdirSync(seededDir, { recursive: true })
  const extra = new Map()
  const watch = async () => {
    for (const name of readdirSync(seedDir)) {
      if (name.startsWith('.') || extra.has(name) || !statSync(path.join(seedDir, name)).isDirectory()) continue
      extra.set(name, null)
      const torrent = await add(path.join(seedDir, name))
      extra.set(name, torrent)
      writeJson(path.join(seededDir, `${name}.json`), describe(torrent, port))
      console.log(`seed: ${name} ${torrent.infoHash}`)
    }
  }
  setInterval(() => void watch().catch((err) => console.error(`seed: ${err.message}`)), 500)
  setInterval(() => {
    const torrents = [film, pack, ...[...extra.values()].filter((t) => t !== null)].map((t) => ({ info_hash: t.infoHash, peers: t.numPeers, uploaded: t.uploaded }))
    appendFileSync(path.join(state, 'seeder.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), torrents })}\n`)
  }, 1000)
  process.on('SIGTERM', () => client.destroy(() => process.exit(0)))
}

async function leech(opts) {
  const bytes = Number(need(opts, 'bytes'))
  if (!Number.isInteger(bytes) || bytes < 2) throw new Error('--bytes must be an integer of at least 2')
  const index = Number(need(opts, 'file'))
  const timeoutS = Number(opts['timeout-s'] ?? 120)
  const client = new WebTorrent({ ...QUIET, utPex: false })
  client.on('error', (err) => {
    console.log(JSON.stringify({ error: err.message }))
    process.exit(1)
  })
  const timer = setTimeout(() => {
    console.log(JSON.stringify({ error: `timeout after ${timeoutS} s` }))
    process.exit(1)
  }, timeoutS * 1000)
  const torrent = client.add(need(opts, 'info-hash'), { path: path.resolve(need(opts, 'out')), deselect: true, announce: [] })
  const peer = need(opts, 'peer')
  torrent.once('infoHash', () => torrent.addPeer(peer))
  if (!torrent.ready) await new Promise((resolve) => torrent.once('ready', resolve))
  const file = torrent.files[index]
  if (file === undefined) throw new Error(`the torrent has no file ${index}`)
  const iterator = file[Symbol.asyncIterator]({ start: 0, end: bytes - 1 })
  const started = Date.now()
  let got = 0
  while (got < bytes) {
    const next = await iterator.next()
    if (next.done) break
    got += next.value.length
  }
  await iterator.return?.()
  const seconds = (Date.now() - started) / 1000
  const taken = Math.min(got, bytes)
  console.log(JSON.stringify({ bytes: taken, seconds, bytes_per_s: Math.round(taken / seconds), peers: torrent.wires.map((w) => `${w.remoteAddress}:${w.remotePort}`) }))
  clearTimeout(timer)
  client.destroy(() => process.exit(0))
}

const [mode, ...rest] = process.argv.slice(2)
try {
  const opts = parseArgs(rest)
  if (mode === 'seed') await seed(opts)
  else if (mode === 'leech') await leech(opts)
  else {
    console.error('usage: seed.mjs seed --film DIR --pack DIR --state STATE [--upload-kbps N]\n       seed.mjs leech --info-hash H --peer HOST:PORT --file INDEX --bytes N --out DIR [--timeout-s S]')
    process.exit(2)
  }
} catch (err) {
  console.error(`seed.mjs: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
```

**File:** `.claude/skills/verify-notesd/scripts/verify.sh` — edits in order:
1. Line 8: append ` [--torrent]` to the `up` usage line. After line 24 (`#  is pinned off.`) insert:
```bash
#                                       --torrent (implies --direct-stream) turns torrents on against a loopback
#                                       seeder of a generated film and pack (scripts/torrent/; TORRENT_FIXTURE_FILE=
#                                       <path> seeds that file as the film); without it NOTESD_TORRENT=off is pinned
```
   and at line 513 change `sed -n '2,27p'` to `sed -n '2,30p'`.
2. Line 87: `local web=0 embed=0 sessions=0 adversary=0 movies=0 direct=0 discovery=0 prober=""` →
   `local web=0 embed=0 sessions=0 adversary=0 movies=0 direct=0 discovery=0 prober="" torrent=0`.
   In the flag `case` after the `--discovery)` line add:
```bash
      --torrent) torrent=1; direct=1; movies=1 ;;
```
3. After line 195 (the end of the `if [ "$direct" = 1 ]` block that starts the fixture stream host) insert:
```bash
  # --torrent: a loopback seeder of a generated film and season pack (scripts/torrent/). Never a real swarm:
  # the daemon gets NOTESD_TORRENT_DISCOVERY=off (no DHT, no tracker) and the seeder as its only peer.
  # TORRENT_FIXTURE_FILE=<path> seeds that one file as the film (no subtitle file beside it).
  local seed_port=""
  if [ "$torrent" = 1 ]; then
    local fixture film_name film
    fixture="$("$HERE/torrent/make-fixture.sh" "$VERIFY_HOME/.torrent-fixture")" || die "--torrent: building the fixture torrents failed"
    film_name=Fixture.Film.2026.1080p.WEB-DL.x264-NOTESD
    film="$fixture/$film_name"
    mkdir -p "$dir/torrent"
    if [ -n "${TORRENT_FIXTURE_FILE:-}" ]; then
      [ -f "$TORRENT_FIXTURE_FILE" ] || die "--torrent: TORRENT_FIXTURE_FILE=$TORRENT_FIXTURE_FILE is not a file"
      film="$dir/torrent/custom/$film_name"
      mkdir -p "$film"
      cp "$TORRENT_FIXTURE_FILE" "$film/$film_name.${TORRENT_FIXTURE_FILE##*.}"
    fi
    setsid node "$HERE/torrent/seed.mjs" seed --film "$film" --pack "$fixture/Fixture.Show.S01.1080p.WEB-DL.x264-NOTESD" \
      --state "$dir/torrent" --upload-kbps 200 </dev/null >"$dir/torrent/seeder.out" 2>&1 &
    echo $! >"$dir/seeder.pid"
    for _ in $(seq 1 80); do [ -s "$dir/torrent/fixture.json" ] && [ -s "$dir/torrent/pack.json" ] && break; sleep 0.25; done
    [ -s "$dir/torrent/pack.json" ] || die "--torrent: the loopback seeder did not start (log: $dir/torrent/seeder.out; verify.sh down $run)"
    seed_port="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).port)' "$dir/torrent/fixture.json")"
  fi
```
4. In the `env` array, after the `NOTESD_STREAM_CACHE_DIR=...` line (line 209) insert:
```bash
    # A throwaway daemon never writes into the owner's torrent folder either.
    NOTESD_TORRENT_DIR="$dir/data/movies/torrents"
```
5. After line 266 (the `fi` closing the `NOTESD_DIRECT_STREAM` block) insert:
```bash
  # NOTESD_TORRENT=off unless --torrent: a throwaway daemon never joins a real swarm. --torrent turns discovery
  # off (no DHT, no tracker), names the loopback seeder as every torrent's peer and caps upload at 64 kB/s.
  if [ "$torrent" = 1 ]; then
    env+=(NOTESD_TORRENT=on NOTESD_TORRENT_DISCOVERY=off "NOTESD_TORRENT_PEERS=127.0.0.1:$seed_port" NOTESD_TORRENT_UPLOAD_KBPS=64 NOTESD_TORRENT_KEEP_DAYS=7)
  else
    env+=(NOTESD_TORRENT=off)
  fi
```
6. In the `meta` block after `echo "prober=${prober:-pinned_off}"` add `    echo "torrent=$torrent"`.
7. After line 311 (`if [ "$direct" = 1 ]; then echo "DIRECT=$dir/direct"; fi`) add
```bash
  if [ "$torrent" = 1 ]; then echo "TORRENT=$dir/torrent"; fi
```
8. In `stop_run`, after line 470 (the `calls.jsonl` copy) insert:
```bash
  # --torrent: the loopback seeder was started by `up`; keep its log.
  if [ -f "$dir/seeder.pid" ]; then
    kill -TERM -- "-$(cat "$dir/seeder.pid")" 2>/dev/null || kill -TERM "$(cat "$dir/seeder.pid")" 2>/dev/null || true
  fi
  if [ -f "$dir/torrent/seeder.jsonl" ]; then cp "$dir/torrent/seeder.jsonl" "$dir/evidence/torrent-seeder.jsonl"; fi
```
   and in the `rm -rf` line (477) add `"$dir/torrent" "$dir/seeder.pid"` to the list.

**File:** `.claude/skills/verify-notesd/scripts/torrent/torrent.sh` (new, `chmod +x`)
```bash
#!/usr/bin/env bash
# torrent.sh RUN [idle|files|refuse|range|cap|leave|only|disk ...]: the torrent engine's checks
# (torrent-stream-source phase 1) on a `verify.sh up --torrent` run; `torrent.sh RUN off` on a run started
# without --torrent. Every stage drives the real daemon over HTTP against the loopback seeder `up --torrent`
# started (seed.mjs, the fixture of make-fixture.sh); end states are read over HTTP, from the torrent folder,
# the seeder's log, the daemon's log and the daemon's sockets. The first failed check stops it with
# `torrent: FAIL at <stage>`. No stage named: every stage but `off`, in order, once per run.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V="$HERE/../verify.sh"
VERIFY_HOME="${VERIFY_HOME:-$HOME/.local/state/notesd-verify}"
RUN=${1:?usage: torrent.sh RUN [idle|files|refuse|range|cap|leave|only|disk|off ...]}
shift
WANTED=("$@")
if [ ${#WANTED[@]} -eq 0 ]; then WANTED=(idle files refuse range cap leave only disk); fi
DIR="$VERIFY_HOME/$RUN"
[ -f "$DIR/port" ] || { echo "torrent: no live run $RUN" >&2; exit 2; }
URL="http://127.0.0.1:$(cat "$DIR/port")"
EV="$DIR/evidence"
T="$DIR/torrent"
ROOT="$DIR/data/movies/torrents"
FIXTURE="$VERIFY_HOME/.torrent-fixture"
STAGE=start
CODE=""
BODY=""
HASH=""

stage() { STAGE=$1; echo "== $STAGE"; }
ok() { echo "   ok  $*"; "$V" note "$RUN" "torrent $STAGE: $*"; }
pass() { echo "$1 PASS ${*:2}"; "$V" note "$RUN" "torrent $1 PASS ${*:2}"; }
fail() {
  echo "torrent: FAIL at $STAGE: $*" >&2
  "$V" note "$RUN" "torrent FAIL at $STAGE: $*" || true
  exit 1
}
api() {
  local out
  out="$("$V" api "$RUN" "$@" 2>/dev/null)"
  CODE="$(sed -n 's/^< HTTP \([0-9]*\).*/\1/p' <<<"$out" | head -1)"
  BODY="$(sed '1,/^< HTTP /d' <<<"$out")"
}
status() { curl -sS "$URL/api/stream/torrent"; }
# The ss lines of every process in the group `up` started (the daemon and its tsx child).
sockets() {
  local pids
  pids="$(ps -o pid= -g "$(cat "$DIR/pid")" | tr -d ' ' | paste -sd'|')"
  ss -tuanpH 2>/dev/null | grep -E "pid=(${pids})," || true
}
udp_sockets() { sockets | awk '$1 == "udp"' | wc -l | tr -d ' '; }
tcp_listening() { sockets | awk '$1 == "tcp" && $2 == "LISTEN" { n = split($5, a, ":"); print a[n] }' | sort -un | paste -sd' '; }

if [ -s "$T/fixture.json" ]; then
  HASH="$(jq -r .info_hash "$T/fixture.json")"
  NAME="$(jq -r .name "$T/fixture.json")"
  idx() { jq -r --arg s "$1" '[.files[] | select(.path | endswith($s))][0].index' "$T/fixture.json"; }
  VIDEO="$(idx "$NAME.mp4")"
  SUB="$(idx "$NAME.en.srt")"
  EXE="$(idx setup.exe)"
  LEN="$(jq -r --argjson i "$VIDEO" '.files[] | select(.index == $i) | .length' "$T/fixture.json")"
  SRC="$FIXTURE/$(jq -r --argjson i "$VIDEO" '.files[] | select(.index == $i) | .path' "$T/fixture.json")"
  OPEN="{\"info_hash\":\"$HASH\",\"name\":\"$NAME\",\"kind\":\"movie\",\"tmdb_id\":550"
fi
need_torrent() {
  [ -n "$HASH" ] || fail "$RUN was not started with --torrent"
  [ "$SUB" != null ] && [ "$EXE" != null ] || fail "the seeded film is not the generated fixture (TORRENT_FIXTURE_FILE?): these stages need its .srt and setup.exe"
}
quiet() { [ "$(udp_sockets)" = 0 ] && [ "$(tcp_listening)" = "$(cat "$DIR/port")" ]; }

stage_off() {
  stage off
  [ ! -d "$T" ] || fail "$RUN was started with --torrent; start one without it for this stage"
  api GET /api/stream/torrent
  [ "$CODE" = 503 ] && [ "$(jq -r .error <<<"$BODY")" = torrent_off ] || fail "GET /api/stream/torrent answered HTTP $CODE: $BODY"
  api POST /api/stream/torrent "{\"info_hash\":\"$(printf 'ab%.0s' $(seq 1 20))\",\"kind\":\"movie\",\"tmdb_id\":550,\"files\":[0]}"
  [ "$CODE" = 503 ] && [ "$(jq -r .error <<<"$BODY")" = torrent_off ] || fail "POST /api/stream/torrent answered HTTP $CODE: $BODY"
  quiet || fail "the daemon holds sockets beyond its HTTP port: $(sockets)"
  pass OFF "torrent_off on GET and POST; no UDP socket; TCP listens on $(tcp_listening) only"
}

stage_idle() {
  stage idle
  need_torrent
  api GET /api/stream/torrent
  [ "$CODE" = 200 ] || fail "GET /api/stream/torrent answered HTTP $CODE: $BODY"
  [ "$(jq -c '[.port, (.swarm | length)]' <<<"$BODY")" = '[null,0]' ] || fail "an engine runs before any torrent was opened: $BODY"
  quiet || fail "sockets before any torrent: $(sockets)"
  ok "torrents on and nothing opened: no engine port, no UDP socket, TCP only on the HTTP port"
}

stage_files() {
  stage files
  need_torrent
  api POST /api/stream/torrent "$OPEN}"
  [ "$CODE" = 200 ] || fail "POST /api/stream/torrent answered HTTP $CODE: $BODY"
  [ "$(jq '.files | length' <<<"$BODY")" = "$(jq '.files | length' "$T/fixture.json")" ] || fail "the file list differs from the seeder's: $BODY"
  [ "$(jq -r --argjson i "$VIDEO" '.files[] | select(.index == $i) | .media' <<<"$BODY")" = video ] || fail "the film is not marked video: $BODY"
  [ "$(jq -r --argjson i "$EXE" '.files[] | select(.index == $i) | .media' <<<"$BODY")" = null ] || fail "setup.exe is marked as media: $BODY"
  [ "$(jq -r '[.torrent.state, (.torrent.in_swarm | tostring), (.from_disk | tostring)] | join(" ")' <<<"$BODY")" = "downloading true false" ] || fail "unexpected view: $BODY"
  sleep 2
  local n
  n="$(find "$ROOT/$HASH" -type f 2>/dev/null | wc -l | tr -d ' ')"
  [ "$n" = 0 ] || fail "$n file(s) under the torrent folder before any file was chosen: $(find "$ROOT/$HASH" -type f)"
  ok "the file list ($(jq '.files | length' <<<"$BODY") files) came from the loopback seeder; nothing is on disk before a choice"
}

stage_refuse() {
  stage refuse
  need_torrent
  api POST /api/stream/torrent "$OPEN,\"files\":[$EXE]}"
  [ "$CODE" = 400 ] && [ "$(jq -r .error <<<"$BODY")" = not_media ] || fail "choosing setup.exe answered HTTP $CODE: $BODY"
  api GET "/api/stream/torrent/$HASH/f/$EXE"
  [ "$CODE" = 404 ] && [ "$(jq -r .error <<<"$BODY")" = not_selected ] || fail "reading setup.exe answered HTTP $CODE: $BODY"
  [ ! -e "$ROOT/$HASH/$NAME/setup.exe" ] || fail "setup.exe is on disk"
  pass REFUSE "setup.exe: 400 not_media to choose, 404 not_selected to read, absent from disk"
}

stage_range() {
  stage range
  need_torrent
  api POST /api/stream/torrent "$OPEN,\"files\":[$VIDEO,$SUB]}"
  [ "$CODE" = 200 ] && [ "$(jq -r .torrent.users <<<"$BODY")" = 1 ] || fail "choosing the film answered HTTP $CODE: $BODY"
  local start end code progress
  start=$((LEN * 9 / 10))
  end=$((start + 65535))
  code="$(curl -sS -D "$EV/torrent-range.head" -o "$EV/torrent-range.body" -w '%{http_code}' -r "$start-$end" "$URL/api/stream/torrent/$HASH/f/$VIDEO")"
  [ "$code" = 206 ] || fail "the range answered HTTP $code"
  grep -qi "^content-range: bytes $start-$end/$LEN" "$EV/torrent-range.head" || fail "content-range: $(grep -i content-range "$EV/torrent-range.head")"
  [ "$(stat -c %s "$EV/torrent-range.body")" = 65536 ] || fail "the body is $(stat -c %s "$EV/torrent-range.body") bytes, not 65536"
  cmp -s -i "$start:0" -n 65536 "$SRC" "$EV/torrent-range.body" || fail "the bytes differ from the film's bytes $start-$end"
  api GET "/api/stream/torrent/$HASH"
  progress="$(jq -r .progress <<<"$BODY")"
  awk -v p="$progress" 'BEGIN { exit !(p < 0.5) }' || fail "progress was $progress when the range at 90% came back: it was not fetched first"
  api GET "/api/stream/torrent/$HASH/map"
  jq -e --argjson s "$start" --argjson e "$((end + 1))" 'any(.byte_ranges[]; .[0] <= $s and .[1] >= $e)' <<<"$BODY" >/dev/null || fail "the map does not hold the range: $BODY"
  pass RANGE "206 with exactly bytes $start-$end of $LEN while $progress of the film was on disk"
}

wait_ready() {
  local view state
  for _ in $(seq 1 240); do
    view="$(curl -sS "$URL/api/stream/torrent/$HASH")"
    state="$(jq -r .state <<<"$view")"
    [ "$state" = ready ] && return 0
    [ "$state" = failed ] && fail "the download failed: $view"
    sleep 0.5
  done
  fail "the download was not ready in 120 s (last: $view)"
}

stage_cap() {
  stage cap
  need_torrent
  wait_ready
  api GET /api/stream/torrent
  local port cap limit out
  port="$(jq -r .port <<<"$BODY")"
  cap="$(jq -r .upload_cap_bytes_per_s <<<"$BODY")"
  [[ $port =~ ^[0-9]+$ ]] || fail "no engine port while the film is held: $BODY"
  out="$(node "$HERE/seed.mjs" leech --info-hash "$HASH" --peer "127.0.0.1:$port" --file "$VIDEO" --bytes 524288 --out "$T/leech" --timeout-s 90)" || fail "the test peer could not download from the daemon: $out"
  echo "$out" >"$EV/torrent-cap.json"
  limit=$((cap * 5 / 4))
  [ "$(jq -c .peers <<<"$out")" = "[\"127.0.0.1:$port\"]" ] || fail "the test peer had other peers than the daemon: $out"
  [ "$(jq -r .bytes_per_s <<<"$out")" -le "$limit" ] || fail "the daemon uploaded at $(jq -r .bytes_per_s <<<"$out") B/s, over $limit (the cap $cap B/s + 25%)"
  pass CAP "a peer of the daemon got 512 KiB at $(jq -r .bytes_per_s <<<"$out") B/s under a cap of $cap B/s"
}

stage_leave() {
  stage leave
  need_torrent
  api POST "/api/stream/torrent/$HASH/release"
  [ "$CODE" = 200 ] && [ "$(jq -r .released <<<"$BODY")" = true ] || fail "release answered HTTP $CODE: $BODY"
  local s="" peers=""
  for _ in $(seq 1 40); do
    s="$(status)"
    [ "$(jq -c '[.port, (.swarm | length)]' <<<"$s")" = '[null,0]' ] && break
    sleep 0.25
  done
  [ "$(jq -c '[.port, (.swarm | length)]' <<<"$s")" = '[null,0]' ] || fail "still in the swarm 10 s after release: $s"
  api GET /api/stream/torrent
  for _ in $(seq 1 20); do
    peers="$(tail -1 "$T/seeder.jsonl" | jq -r --arg h "$HASH" '.torrents[] | select(.info_hash == $h) | .peers')"
    [ "$peers" = 0 ] && break
    sleep 0.5
  done
  [ "$peers" = 0 ] || fail "the seeder still has $peers peer(s) on the film"
  grep -q "left the swarm of $NAME" "$DIR/daemon.log" || fail "the daemon log has no 'left the swarm of $NAME' line"
  quiet || fail "sockets left after leaving: $(sockets)"
  pass LEAVE "released a finished film: no swarm, no engine port, the seeder has 0 peers on it, no torrent socket left"
}

stage_only() {
  stage only
  need_torrent
  local listing want
  listing="$(cd "$ROOT/$HASH" && find . -type f | sed 's#^\./##' | sort | paste -sd'|')"
  want="$(printf '%s\n' "$NAME/$NAME.en.srt" "$NAME/$NAME.mp4" | sort | paste -sd'|')"
  [ "$listing" = "$want" ] || fail "the torrent folder holds [$listing], not only [$want]"
  cmp -s "$SRC" "$ROOT/$HASH/$NAME/$NAME.mp4" || fail "the film on disk differs from the seeder's"
  pass ONLY "the torrent folder holds only the film and its subtitle, byte for byte the seeder's"
}

stage_disk() {
  stage disk
  need_torrent
  local pid joined code
  pid="$(cat "$DIR/seeder.pid")"
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
  if kill -0 "$pid" 2>/dev/null; then fail "the seeder did not stop"; fi
  joined="$(grep -c "joined the swarm of $NAME" "$DIR/daemon.log" || true)"
  api POST /api/stream/torrent "$OPEN,\"files\":[$VIDEO,$SUB]}"
  [ "$CODE" = 200 ] && [ "$(jq -r .from_disk <<<"$BODY")" = true ] && [ "$(jq '.files | length' <<<"$BODY")" = 2 ] || fail "opening the finished film answered HTTP $CODE: $BODY"
  code="$(curl -sS -o "$EV/torrent-disk.body" -w '%{http_code}' -r 0-1023 "$URL/api/stream/torrent/$HASH/f/$VIDEO")"
  [ "$code" = 206 ] && cmp -s -n 1024 "$SRC" "$EV/torrent-disk.body" || fail "the first KiB from disk answered HTTP $code or differs"
  api GET /api/stream/torrent
  [ "$(jq -c '[.port, (.swarm | length)]' <<<"$BODY")" = '[null,0]' ] || fail "playing from disk joined a swarm: $BODY"
  [ "$(grep -c "joined the swarm of $NAME" "$DIR/daemon.log" || true)" = "$joined" ] || fail "the daemon joined the swarm again"
  quiet || fail "sockets while playing from disk: $(sockets)"
  api POST "/api/stream/torrent/$HASH/release"
  pass DISK "with the seeder gone the finished film opens from disk (from_disk true) and serves exact bytes; no swarm joined, no torrent socket"
}

for s in "${WANTED[@]}"; do
  case "$s" in
    off | idle | files | refuse | range | cap | leave | only | disk) "stage_$s" ;;
    *) fail "unknown stage $s" ;;
  esac
done
echo "torrent: PASS (${WANTED[*]})"
```
**Impact:** every throwaway run now pins `NOTESD_TORRENT=off` unless `--torrent`, so no `--direct-stream` run
joins a swarm by the new default.

### Step 20: Feature map and skill
**File:** `.claude/skills/verify-notesd/features/direct-streaming.md` — insert before `## Gotchas` (line 325):
```md
## Torrents: the engine and its file route (torrent phase 1)
- `POST /api/stream/torrent` (same-origin) opens a torrent by info hash for a title and answers its file list
  from the swarm; with `files` (video and subtitle indexes only; anything else is 400 `not_media`) it
  downloads them in order under `<NOTES_DATA_DIR>/movies/torrents/<hash>/` and holds the torrent until
  `POST /api/stream/torrent/:hash/release`. `GET /api/stream/torrent/:hash/f/:index` answers a byte range with
  exactly those bytes, fetching that range first; `.../map` the stretches on disk; `GET /api/stream/torrent`
  the engine (`port`, `swarm`, `upload_cap_bytes_per_s`) and every download. Upload is capped at
  `NOTESD_TORRENT_UPLOAD_KBPS`; a torrent leaves the swarm once nothing holds it (at once when finished, three
  minutes after the last request otherwise) and only its chosen files stay; a finished download opens and plays
  from disk with no swarm; downloads are cleared after `NOTESD_TORRENT_KEEP_DAYS` without a play.
  `NOTESD_TORRENT=off`: 503 `torrent_off`, nothing is built, no socket is opened.
- Logic: `npx vitest run tests/unit/directStream/torrent tests/unit/config.torrent.test.ts` (`engine.test.ts`
  seeds a generated torrent over loopback with DHT and trackers off); the table, both machines and replay from
  disk: `npm run test:int -- tests/integration/directStream.torrents.int.test.ts`.
- Throwaway daemon: `$V up --torrent` (implies `--direct-stream`; prints `TORRENT=<run>/torrent`). It starts a
  loopback seeder (`scripts/torrent/seed.mjs`, 200 kB/s) of the generated film and season pack
  (`scripts/torrent/make-fixture.sh`: a 120 s H.264/AAC MP4 with English audio, its `.en.srt`, a README, a
  sample and an inert `setup.exe`; two 20 s episodes), writes `fixture.json` and `pack.json`
  (`{info_hash, name, trackers: [], port, piece_length, files}`) and `seeder.jsonl` there, and gives the daemon
  `NOTESD_TORRENT_DISCOVERY=off`, `NOTESD_TORRENT_PEERS=127.0.0.1:<seeder>` and a 64 kB/s cap.
  `TORRENT_FIXTURE_FILE=<path>` seeds that one file as the film instead; a folder moved into
  `<run>/torrent/seed/<name>/` is seeded too and described in `<run>/torrent/seeded/<name>.json`. Then
  `.claude/skills/verify-notesd/scripts/torrent/torrent.sh RUN` (stages `idle files refuse range cap leave only
  disk`, in order, once per run, on the generated film) prints `REFUSE PASS`, `RANGE PASS`, `CAP PASS`,
  `LEAVE PASS`, `ONLY PASS`, `DISK PASS` and `torrent: PASS (...)`. On a run without `--torrent`,
  `torrent.sh RUN off` prints `OFF PASS`.
- Every other run pins `NOTESD_TORRENT=off` and `NOTESD_TORRENT_DIR` under the run: no throwaway daemon joins a
  real swarm or writes into the owner's torrent folder.

```
**File:** `.claude/skills/verify-notesd/features/README.md` — in the Direct streaming row, after
`background prober (`--prober`)` add `, torrent downloads and their file route (`--torrent`)`, and in its
Surfaces cell after `database` add `, loopback torrent seeder (`up --torrent`)`.
**File:** `.claude/skills/verify-notesd/SKILL.md` — after line 29 (the `--prober` line) add:
```sh
$V up --torrent       # --direct-stream plus torrents ON against a loopback seeder of a generated film and pack (scripts/torrent/)
```
and after the paragraph that starts "Every run also pins `NOTESD_DIRECT_STREAM=off`" add:
```md
Every run also pins `NOTESD_TORRENT=off` and `NOTESD_TORRENT_DIR` under the run, so a throwaway daemon never
joins a real swarm. `--torrent` (implies `--direct-stream`) turns torrents on with discovery off (no DHT, no
tracker) against a loopback seeder (`scripts/torrent/seed.mjs`) of a film and a season pack generated once with
ffmpeg (`scripts/torrent/make-fixture.sh`, cached in `$VERIFY_HOME/.torrent-fixture`); `up` prints
`TORRENT=<run>/torrent`, where `fixture.json`, `pack.json` and `seeder.jsonl` are. `TORRENT_FIXTURE_FILE=<path>`
seeds that file as the film. `scripts/torrent/torrent.sh RUN` drives it; see `features/direct-streaming.md`.
```
**Impact:** docs only.

## Principles applied

- Laziness protocol: no torrent framework of our own; the Range parser (`cache/serve.ts parseRange`) and the title slot (`repo.ts cacheSlot`) are reused, and the WebTorrent client is the store, the scheduler and the piece picker.
- Boundary discipline: an info hash is normalized once (`normalizeInfoHash`) at the route and service entry, file kinds are checked once in `use` (`mediaOf`), and the env is parsed once in `parseTorrent` (`config.torrent.dir` arrives resolved); the engine and the folder trust what they get.
- Make illegal states unrepresentable: `stream_torrents` CHECKs tie `ready` to `completed_at` and a chosen video, `failed` to `error`, and the hash to 40 lower-case hex; `TorrentHandle.live` separates a swarm handle from a disk handle, and `Active` only ever holds swarm handles, so "in the swarm" is exactly `active.has(hash)`.
- Fix root causes: webtorrent's iterator reads to the end of the file when `end` is 0 (`end && end < length`); `take()` counts the bytes itself, and `engine.test.ts` reads byte 0..0 to keep it fixed.
- Encode lessons in structure: webtorrent is imported only by type and loaded with `import()` on the first open, so a daemon with torrents off, or a laptop whose native `node-datachannel` failed to build, cannot crash at start; the client exists only while a torrent is open, so "no swarm while nothing plays" holds by construction, not by a flag.
- Build the lever: `torrent.sh` + `seed.mjs` + `make-fixture.sh` make the proof a rerunnable script against the real daemon, including the cap (a stranger peer measures the daemon's upload) and leaving (the seeder's peer count).
- Prove it works / test behavior: the only fake is the engine boundary (`FakeTorrentEngine`); the real engine is tested over loopback, and the Proof drives the real routes with real pieces.
- Sequence into verifiable units: steps 2–9 compile and are covered by step 17's unit tests before steps 10–12 wire anything into the daemon.

## Verification

**Build:** `npm run typecheck && npm run build`
**Tests:** `npm test` (includes `tests/unit/directStream/torrent/*`, `tests/unit/config.torrent.test.ts`, `tests/unit/docs/reference.test.ts`) and `npm run test:int -- tests/integration/directStream.torrents.int.test.ts`
**Proof:** a throwaway daemon with torrents on, against a loopback seeder of a generated film, driven over its real routes; and one with torrents off.
- Harness: `.claude/skills/verify-notesd` (`verify.sh up --torrent`, `api`, `note`, `down`), plus this phase's `scripts/torrent/torrent.sh`
- Feature-map entries: `features/direct-streaming.md` ("Torrents: the engine and its file route")
- Journeys (all on one run unless said: `V=.claude/skills/verify-notesd/scripts/verify.sh; $V up --torrent`, note `RUN=`, then `.claude/skills/verify-notesd/scripts/torrent/torrent.sh $RUN`, then `$V down $RUN`):
  - **J1** · traces R2.1 — `$V up --torrent`; `.claude/skills/verify-notesd/scripts/torrent/torrent.sh $RUN` → passes when it prints `RANGE PASS 206 with exactly bytes <s>-<e> of <len> while <p> of the film was on disk` (a 64 KiB range at 90% of the film answered 206 with the right `content-range` and byte-identical bytes, `p` < 0.5, and `/map`'s `byte_ranges` holds the range) and ends `torrent: PASS (idle files refuse range cap leave only disk)`
  - **J2** · traces R2.2 — same run and command → passes when it prints `REFUSE PASS` (choosing `setup.exe` is 400 `not_media`, reading it is 404 `not_selected`, it is not on disk) and `ONLY PASS` (after the release, `<run>/data/movies/torrents/<hash>/` holds exactly `<name>/<name>.en.srt` and `<name>/<name>.mp4`, the film byte-identical to the seeder's), and the `files` stage logged that nothing was on disk before a choice
  - **J3** · traces R2.3 — same run and command → passes when it prints `CAP PASS` (a stranger peer reading 512 KiB from the daemon only got ≤ 80 000 B/s under the 64 kB/s cap, saved as `evidence/torrent-cap.json`) and `LEAVE PASS` (after `POST .../release` of the finished film: `GET /api/stream/torrent` shows `port: null` and an empty `swarm`, `seeder.jsonl` shows 0 peers on the film, the daemon log has `left the swarm of Fixture.Film.2026...`, and the daemon holds no UDP socket and listens on its HTTP port only)
  - **J4** · traces R2.9 — same run and command → passes when it prints `DISK PASS` (with the seeder killed, `POST /api/stream/torrent` answers `from_disk: true` with the 2 chosen files, a range reads byte-identical from disk, `GET /api/stream/torrent` shows `port: null` and no swarm, and the daemon log has no second `joined the swarm` line)
  - **J5** · traces R2.6 — `$V up --direct-stream` (no `--torrent`: `NOTESD_TORRENT=off` pinned), note `RUN=`; `.claude/skills/verify-notesd/scripts/torrent/torrent.sh $RUN off`; `$V down $RUN` → passes when it prints `OFF PASS torrent_off on GET and POST; no UDP socket; TCP listens on <http port> only`
  - **J6** · traces R2.1, R2.2, R2.3 — `npx vitest run tests/unit/directStream/torrent tests/unit/config.torrent.test.ts` → passes when every test passes, including the six of `engine.test.ts` (real WebTorrent over loopback: the range before the rest, only chosen files on disk, the cap measured by a third peer, the seeder's peers at 0 after `remove`, `port()` null when idle)
  - **J7** · traces R2.9, R2.6 — `npm run test:int -- tests/integration/directStream.torrents.int.test.ts` and `npx vitest run tests/unit/directStream/torrent/routes.test.ts` → passes when both pass (replay from disk after a restart with no engine add; the other machine's download is 404 `not_on_this_machine`; every route answers 503 `torrent_off` with torrents off)
- Neighbor check: the stream cache shares `/api/stream/*`, `cache/serve.ts` and the daemon wiring. `$V up --direct-stream`, then `.claude/skills/verify-notesd/scripts/direct-stream/cache.sh $RUN` → passes when it ends `cache: PASS (start tool refused other clear)`; and `npm test` stays green.
- Cost: nothing billed; J1–J4 take about two minutes on one run (the film comes at 200 kB/s; the cap stage reads 512 KiB at 64 kB/s).

**Exit criteria:** on `verify.sh up --torrent`, `torrent.sh RUN` ends `torrent: PASS (idle files refuse range cap leave only disk)`; on `verify.sh up --direct-stream`, `torrent.sh RUN off` prints `OFF PASS`; `npm run typecheck`, `npm test` and the new integration test pass.

## Handoffs

- **Phase 3 (R2.6, R2.9, R2.3 in full):**
  - Answering `torrent_off` to `direct_stream_play` / `POST /api/stream/play` with `provider: "torrent"` (R2.6's play part) is phase 3's; this phase makes `deps.torrents` null and the routes answer `torrent_off`.
  - Playing a title again from disk (R2.9's play part) is phase 3's: `find(ref)` answers `{ infoHash, host, name, release, fileIndex, fileLength, state, durationS }` (camelCase, only rows with a chosen video; ready ones first), `open` of a ready download for the same title answers a `DiskHandle` (`live: false`, only the chosen files) without touching the engine, `use` on it only marks the play, and the file route serves it from disk.
  - `TorrentPick` is `{ infoHash, trackers, name, ref, release? }`: `name` is the release name (stored as `release`), `release` is accepted and not read, so phase 3's `release: ReleaseInfo` fits.
  - R2.3 in a real play needs phase 3 to `release` once per `use` when a session ends; `release` also drops at once a torrent opened and never used, and ignores an unknown hash.
  - Call `setDuration(infoHash, probe.durationS)` after the probe: `/map`'s `ranges` (seconds) stay empty until a duration is known (`byte_ranges` and `length` are always there).
  - Opening a hash for another title slot (a season pack, another episode) moves the row to that slot and forgets the previous choice, whose file is then deleted as an unchosen edge when the torrent leaves. A pack replayed for several episodes needs more than one row per hash; left for phase 3 to raise if it matters.
  - `fixture.json` / `pack.json` have `trackers: []`: on `--torrent` runs discovery is off and the daemon adds the seeder (`NOTESD_TORRENT_PEERS`) to every torrent, so a fake index can hand out any tracker list (it is ignored). The pack's episode files are `Fixture.Show.S01E01...mp4` and `...S01E02...mp4` under `Fixture.Show.S01.1080p.WEB-DL.x264-NOTESD/`.
- **Phase 4 (R2.7):** `GET /api/stream/torrent/:hash` answers `state`, `peers`, `down_kbps` (**kilobits** per second, as the plan assumes), `progress` at the top level; a GET needs no Origin. `/map` is `{ duration_s, ranges (seconds), length, byte_ranges }`; `ranges` is empty while `duration_s` is null (see phase 3's `setDuration`).
- **Phase 5 (R2.8):** ffmpeg reads `localUrl(hash, index)` on loopback. Files a later phase writes under `<config.torrent.dir>/<hash>/` survive the swarm leaving (only the torrent's unchosen file paths are deleted) and go with the folder when the download is cleared (`keepDays`) or removed.
- **Phases 6 and 7:** `config.torrent.dir` is the resolved absolute folder (string); `read`'s `end` is inclusive; `open` is idempotent per hash; `view` carries `host` and `available`. After the swarm is left, an unfinished file's route answers 409 `not_in_swarm` (the file route never joins a swarm by itself), so an extraction reading it stops.
- **Phase 2:** `mediaOf` (video and subtitle extensions) lives in `types.ts`; `pickFile` may want the same lists, but phase 2 touches no shared file, so the reconciler decides whether phase 3 aligns them.
- **Phases 5, 6, 8 harness:** a fixture torrent of a later phase is a folder moved into `<run>/torrent/seed/<name>/`;
  the seeder seeds it on the same port and writes `<run>/torrent/seeded/<name>.json` (fixture.json's shape). Phase 3's
  fake index hands it out when `<run>/torrent/candidates.json` lists it. `verify.sh up --torrent` writes nothing under
  `<run>/torrent/subs/`.
- **Sidecar folders:** `.notesd-subs/` (phase 6), `notesd-remux/` (phase 5), `notesd-cues/` (phase 7) and
  `notesd-whisper/` (phase 8) live under `<dir>/<info hash>/`; leaving the swarm deletes only the torrent's own unchosen
  file paths, so they survive it, and pruning a download removes the whole folder, so they go with it.

## Rollback

Revert this phase's merge. The migration only adds `stream_torrents`; drop it with
`DROP TABLE stream_torrents;` and delete the `0031` entry from `drizzle/meta/_journal.json` (plus
`0031_snapshot.json`), or leave it: nothing else reads it. Downloads on disk are under
`<NOTES_DATA_DIR>/movies/torrents/` and can be deleted. Without a revert, `NOTESD_TORRENT=off` builds nothing.
