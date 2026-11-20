import { vi } from 'vitest';
import type { DownloadRequestAnswer, DownloadView } from '../../../src/directStream/downloads/types.js';
import type { StreamDownloadsPort } from '../../../src/http/streamDownloadsApi.js';

export const HOST = 'here';
export const DL_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/** One download as the engine (phase 2) lists it; a queued film of Saltburn unless told otherwise. */
export function dview(over: Partial<DownloadView> = {}): DownloadView {
  return {
    id: DL_ID,
    host: HOST,
    available: true,
    kind: 'movie',
    tmdb_id: 930564,
    season: null,
    episode: null,
    via: 'auto',
    info_hash: null,
    batch: null,
    state: 'queued',
    source: null,
    source_id: null,
    progress: 0,
    bytes_done: 0,
    bytes_total: null,
    peers: null,
    down_kbps: null,
    error: null,
    detail: null,
    created_at: '2026-11-20T12:00:00.000Z',
    updated_at: '2026-11-20T12:00:00.000Z',
    finished_at: null,
    ...over,
  };
}

/** What `request` answers for a row made now. */
export const made = (d: DownloadView = dview()): DownloadRequestAnswer => ({ download: d, created: true, onDisk: false });

/** A fake engine: request makes one row, requestSeason three, list answers `rows`. */
export function fakeDownloads(rows: DownloadView[] = [dview()]) {
  const request = vi.fn<StreamDownloadsPort['request']>(async () => made());
  const requestSeason = vi.fn<StreamDownloadsPort['requestSeason']>(async () => ({
    ok: true,
    batch: 'b1',
    queued: [1, 2, 3].map((e) => made(dview({ id: `dddddddd-dddd-4ddd-8ddd-00000000000${e}`, kind: 'tv', tmdb_id: 247718, season: 1, episode: e, batch: 'b1' }))),
    left_out: [],
  }));
  const cancel = vi.fn<StreamDownloadsPort['cancel']>(async (id) => dview({ id, state: 'failed', error: 'cancelled' }));
  const list = vi.fn<StreamDownloadsPort['list']>(async () => rows);
  const port: StreamDownloadsPort = { host: HOST, request, requestSeason, cancel, list };
  return { port, request, requestSeason, cancel, list };
}
