import type { StreamTorrentRow } from '../../src/db/schema.js';
import { cacheSlot } from '../../src/directStream/repo.js';
import type { TorrentChoice, TorrentRecords, TorrentRecordSpec, TorrentSlot } from '../../src/directStream/torrent/repo.js';
import type { StreamRef } from '../../src/directStream/types.js';

/** TorrentsRepo in memory, with the same rules (one row per host, hash and episode; another title forgets the choice; failed and ready exclude each other). */
export class MemoryTorrentRecords implements TorrentRecords {
  readonly rows: StreamTorrentRow[] = [];

  async record(host: string, spec: TorrentRecordSpec, now: Date): Promise<StreamTorrentRow> {
    const slot = cacheSlot(spec.ref);
    const row = this.at(host, { infoHash: spec.infoHash, season: slot.season, episode: slot.episode });
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
        keptAt: null,
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

  async get(host: string, infoHash: string, ref?: StreamRef): Promise<StreamTorrentRow | null> {
    if (ref !== undefined) {
      const s = cacheSlot(ref);
      const row = this.at(host, { infoHash, season: s.season, episode: s.episode });
      return row === undefined ? null : this.copy(row);
    }
    return (await this.slots(host, infoHash))[0] ?? null;
  }

  async slots(host: string, infoHash: string): Promise<StreamTorrentRow[]> {
    return this.rows
      .filter((r) => r.host === host && r.infoHash === infoHash)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map((r) => this.copy(r));
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

  async chosen(host: string, slot: TorrentSlot, choice: TorrentChoice, now: Date): Promise<StreamTorrentRow> {
    return this.copy(Object.assign(this.must(host, slot), { files: choice.files.map((f) => ({ ...f })), fileIndex: choice.fileIndex, fileLength: choice.fileLength, updatedAt: now }));
  }

  async progress(host: string, slot: TorrentSlot, bytesDone: number, now: Date): Promise<void> {
    Object.assign(this.must(host, slot), { bytesDone, updatedAt: now });
  }

  async ready(host: string, slot: TorrentSlot, bytesDone: number, now: Date): Promise<StreamTorrentRow> {
    const row = this.must(host, slot);
    if (row.fileIndex === null) throw new Error('stream_torrents_ready_check: a ready download needs a chosen video');
    return this.copy(Object.assign(row, { state: 'ready', error: null, completedAt: now, bytesDone, updatedAt: now }));
  }

  async failed(host: string, slot: TorrentSlot, error: string, now: Date): Promise<void> {
    Object.assign(this.must(host, slot), { state: 'failed', error, completedAt: null, updatedAt: now });
  }

  async restarted(host: string, slot: TorrentSlot, now: Date): Promise<void> {
    const row = this.must(host, slot);
    Object.assign(row, { state: 'downloading', error: null, completedAt: null, bytesDone: 0, updatedAt: now, files: row.files.map(({ remuxed: _, ...f }) => f) });
  }

  async remuxed(host: string, slot: TorrentSlot, fileIndex: number): Promise<StreamTorrentRow> {
    const row = this.must(host, slot);
    row.files = row.files.map((f) => (f.index === fileIndex ? { ...f, remuxed: true as const } : f));
    return this.copy(row);
  }

  async played(host: string, slot: TorrentSlot, now: Date): Promise<void> {
    Object.assign(this.must(host, slot), { playedAt: now });
  }

  async duration(host: string, slot: TorrentSlot, seconds: number, now: Date): Promise<void> {
    Object.assign(this.must(host, slot), { durationS: seconds, updatedAt: now });
  }

  async stale(host: string, before: Date): Promise<StreamTorrentRow[]> {
    return this.rows
      .filter((r) => r.host === host && (r.playedAt ?? r.completedAt ?? r.createdAt).getTime() < before.getTime())
      .map((r) => this.copy(r));
  }

  async delete(host: string, infoHash: string): Promise<boolean> {
    const before = this.rows.length;
    this.rows.splice(0, this.rows.length, ...this.rows.filter((r) => !(r.host === host && r.infoHash === infoHash)));
    return this.rows.length < before;
  }

  async deleteSlot(host: string, slot: TorrentSlot): Promise<boolean> {
    const before = this.rows.length;
    this.rows.splice(0, this.rows.length, ...this.rows.filter((r) => !(r.host === host && r.infoHash === slot.infoHash && r.season === slot.season && r.episode === slot.episode)));
    return this.rows.length < before;
  }

  async setKept(host: string, infoHash: string, at: Date | null): Promise<number> {
    const rows = this.rows.filter((r) => r.host === host && r.infoHash === infoHash);
    for (const r of rows) r.keptAt = at;
    return rows.length;
  }

  private at(host: string, slot: TorrentSlot): StreamTorrentRow | undefined {
    return this.rows.find((r) => r.host === host && r.infoHash === slot.infoHash && r.season === slot.season && r.episode === slot.episode);
  }

  private must(host: string, slot: TorrentSlot): StreamTorrentRow {
    const row = this.at(host, slot);
    if (row === undefined) throw new Error(`no torrent ${slot.infoHash} on ${host}`);
    return row;
  }

  private copy(row: StreamTorrentRow): StreamTorrentRow {
    return { ...row, files: row.files.map((f) => ({ ...f })), trackers: [...row.trackers] };
  }
}
