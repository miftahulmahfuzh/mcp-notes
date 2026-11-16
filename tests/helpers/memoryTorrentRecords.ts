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
