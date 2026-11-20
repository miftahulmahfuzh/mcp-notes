import type { DownloadView } from '../moviesApi';

/** A download id as the wire carries it (opaque to the page: it is only sent back to cancel). */
export const downloadId = (n: number): DownloadView['id'] => n as unknown as DownloadView['id'];

/** A running torrent download of How to Make a Killing (the MOVIE fixture), 42 % done; `over` changes any field. */
export function makeDownload(over: Partial<DownloadView> = {}): DownloadView {
  return {
    id: downloadId(1),
    title_id: 'movie-467905',
    kind: 'movie',
    tmdb_id: 467905,
    season: null,
    episode: null,
    state: 'running',
    via: 'auto',
    source: 'torrent',
    progress: 0.42,
    bytes_done: 630_000_000,
    bytes_total: 1_500_000_000,
    peers: 4,
    down_kbps: 2400,
    error: null,
    batch: null,
    ...over,
  } as DownloadView;
}
