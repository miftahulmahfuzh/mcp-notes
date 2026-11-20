import type { StreamDownloadRow, StreamDownloadState } from '../../src/db/schema.js';
import { cacheSlot } from '../../src/directStream/repo.js';
import {
  DOWNLOAD_CANCELLED,
  DOWNLOAD_OPEN_STATES,
  MAX_DOWNLOAD_DETAIL,
  onColumns,
  type DownloadFilter,
  type DownloadOn,
  type DownloadOpenState,
  type DownloadRecords,
  type DownloadRequest,
} from '../../src/directStream/downloads/repo.js';
import type { StreamRef } from '../../src/directStream/types.js';

const isOpen = (state: StreamDownloadState): boolean => (DOWNLOAD_OPEN_STATES as readonly string[]).includes(state);

/**
 * DownloadsRepo in memory, with the same rules: one open (not done) row per host and slot, a failed one queued again
 * from nothing, done and failed final, the CHECKs on a picked torrent and on a finished row. Proven against the real
 * repository by tests/helpers/downloadRecordsContract.ts.
 */
export class MemoryDownloadRecords implements DownloadRecords {
  readonly rows: StreamDownloadRow[] = [];
  private seq = 0;

  async create(host: string, req: DownloadRequest, now: Date): Promise<{ row: StreamDownloadRow; created: boolean }> {
    const slot = cacheSlot(req.ref);
    const ask = { via: req.via, infoHash: req.infoHash ?? null, batch: req.batch ?? null };
    if (ask.infoHash !== null && (ask.via !== 'torrent' || !/^[0-9a-f]{40}$/.test(ask.infoHash))) {
      throw new Error('stream_downloads_info_hash_check: a picked torrent needs via torrent and a 40-hex hash');
    }
    const existing = this.openRow(host, req.ref);
    if (existing === undefined) {
      this.seq += 1;
      const row: StreamDownloadRow = {
        id: `00000000-0000-4000-8000-${String(this.seq).padStart(12, '0')}`,
        host,
        ...slot,
        ...ask,
        state: 'queued',
        source: null,
        sourceId: null,
        bytesDone: 0,
        bytesTotal: null,
        error: null,
        errorDetail: null,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        completedAt: null,
      };
      this.rows.push(row);
      return { row: { ...row }, created: true };
    }
    if (existing.state !== 'failed') return { row: { ...existing }, created: false };
    Object.assign(existing, ask, {
      state: 'queued',
      source: null,
      sourceId: null,
      bytesDone: 0,
      bytesTotal: null,
      error: null,
      errorDetail: null,
      startedAt: null,
      completedAt: null,
      updatedAt: now,
    });
    return { row: { ...existing }, created: true };
  }

  async openFor(host: string, ref: StreamRef): Promise<StreamDownloadRow | null> {
    const row = this.openRow(host, ref);
    return row === undefined ? null : { ...row };
  }

  async get(host: string, id: string): Promise<StreamDownloadRow | null> {
    const row = this.at(host, id);
    return row === undefined ? null : { ...row };
  }

  async list(host: string, filter: DownloadFilter = {}): Promise<StreamDownloadRow[]> {
    return this.rows
      .filter(
        (r) =>
          r.host === host &&
          (filter.kind === undefined || r.kind === filter.kind) &&
          (filter.tmdbId === undefined || r.tmdbId === filter.tmdbId) &&
          (filter.states === undefined || filter.states.includes(r.state)),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.season - b.season || a.episode - b.episode || a.id.localeCompare(b.id))
      .map((r) => ({ ...r }));
  }

  async claimNext(host: string, now: Date): Promise<StreamDownloadRow | null> {
    const [next] = await this.list(host, { states: ['queued'] });
    if (next === undefined) return null;
    const row = this.at(host, next.id) as StreamDownloadRow;
    Object.assign(row, { state: 'running', startedAt: row.startedAt ?? now, updatedAt: now });
    return { ...row };
  }

  async setState(host: string, id: string, state: DownloadOpenState, now: Date): Promise<StreamDownloadRow | null> {
    const row = this.openById(host, id);
    if (row === undefined) return null;
    Object.assign(row, { state, updatedAt: now }, state === 'running' ? { startedAt: row.startedAt ?? now } : {});
    return { ...row };
  }

  async on(host: string, id: string, on: DownloadOn, now: Date): Promise<StreamDownloadRow | null> {
    const row = this.openById(host, id);
    if (row === undefined) return null;
    Object.assign(row, onColumns(on), { updatedAt: now });
    return { ...row };
  }

  async progress(host: string, id: string, bytesDone: number, bytesTotal: number | null, now: Date): Promise<void> {
    const row = this.openById(host, id);
    if (row !== undefined) Object.assign(row, { bytesDone, bytesTotal, updatedAt: now });
  }

  async done(host: string, id: string, on: DownloadOn, bytes: { bytesDone: number; bytesTotal: number | null }, now: Date): Promise<StreamDownloadRow | null> {
    const row = this.openById(host, id);
    if (row === undefined) return null;
    Object.assign(row, onColumns(on), bytes, { state: 'done', error: null, errorDetail: null, completedAt: now, updatedAt: now });
    return { ...row };
  }

  async failed(host: string, id: string, error: string, detail: string | null, now: Date): Promise<StreamDownloadRow | null> {
    const row = this.openById(host, id);
    if (row === undefined) return null;
    Object.assign(row, { state: 'failed', error, errorDetail: detail === null ? null : detail.slice(0, MAX_DOWNLOAD_DETAIL), completedAt: null, updatedAt: now });
    return { ...row };
  }

  async cancel(host: string, id: string, now: Date): Promise<StreamDownloadRow | null> {
    return this.failed(host, id, DOWNLOAD_CANCELLED, null, now);
  }

  async toResume(host: string, now: Date): Promise<StreamDownloadRow[]> {
    for (const r of this.rows) if (r.host === host && (r.state === 'running' || r.state === 'paused')) Object.assign(r, { state: 'queued', updatedAt: now });
    return this.list(host, { states: ['queued'] });
  }

  async delete(host: string, id: string): Promise<boolean> {
    const before = this.rows.length;
    this.rows.splice(0, this.rows.length, ...this.rows.filter((r) => !(r.host === host && r.id === id)));
    return this.rows.length < before;
  }

  async deleteSlot(host: string, ref: StreamRef): Promise<number> {
    const before = this.rows.length;
    this.rows.splice(0, this.rows.length, ...this.rows.filter((r) => !(r.host === host && this.sameSlot(r, ref))));
    return before - this.rows.length;
  }

  private sameSlot(r: StreamDownloadRow, ref: StreamRef): boolean {
    const s = cacheSlot(ref);
    return r.kind === s.kind && r.tmdbId === s.tmdbId && r.season === s.season && r.episode === s.episode;
  }

  private openRow(host: string, ref: StreamRef): StreamDownloadRow | undefined {
    return this.rows.find((r) => r.host === host && r.state !== 'done' && this.sameSlot(r, ref));
  }

  private at(host: string, id: string): StreamDownloadRow | undefined {
    return this.rows.find((r) => r.host === host && r.id === id);
  }

  private openById(host: string, id: string): StreamDownloadRow | undefined {
    const row = this.at(host, id);
    return row !== undefined && isOpen(row.state) ? row : undefined;
  }
}
