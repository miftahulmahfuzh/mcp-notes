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
  /** The torrents removed with `deleteFiles: true` (the real engine then deletes the whole folder). */
  readonly deletedFiles: string[] = [];
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

  async remove(infoHash: string, options?: { deleteFiles: boolean }): Promise<void> {
    this.removed.push(infoHash);
    if (options?.deleteFiles === true) this.deletedFiles.push(infoHash);
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
