import type { HealthRow, UnhandledEntry } from '../../src/directStream/playLog/health.js';

export const NOW = new Date('2026-11-27T12:00:00Z');
export const ago = (min: number): Date => new Date(NOW.getTime() - min * 60_000);

export function row(over: Partial<HealthRow>): HealthRow {
  return {
    id: 1,
    asked_at: ago(10),
    kind: 'movie',
    tmdb_id: 990001,
    season: null,
    episode: null,
    asked: null,
    outcome: 'played',
    failure: null,
    cloud_failure: null,
    torrent_failure: null,
    resolve_ms: null,
    channel: null,
    provider_first: null,
    torrent_index: null,
    height: null,
    first_frame_ms: null,
    played_ms: 0,
    stalls: 0,
    stalled_ms: 0,
    waits: 0,
    waited_ms: 0,
    ended: null,
    title: 'Health Film A',
    movie_id: 'M-AAAA',
    ...over,
  };
}

/** The verify journeys' seed (Proof J2): newest first, as healthRows returns them. */
export const SEED: HealthRow[] = [
  row({ id: 4, asked_at: ago(30), kind: 'tv', tmdb_id: 990003, season: 1, episode: 2, outcome: 'failed', failure: 'no_source', cloud_failure: 'no_stream', torrent_failure: 'no_source', resolve_ms: 30_000, title: 'Health Series', movie_id: null }),
  row({ id: 2, asked_at: ago(60), tmdb_id: 990002, title: 'Health Film B', movie_id: 'M-BBBB', asked: 'torrent', channel: 'torrent', torrent_index: 'apibay', height: 720, resolve_ms: 12_000, first_frame_ms: 5000, played_ms: 60_000, ended: 'closed' }),
  row({ id: 1, asked_at: ago(120), asked: 'torrent', channel: 'torrent', torrent_index: 'apibay', height: 1080, resolve_ms: 8000, first_frame_ms: 3000, played_ms: 1_800_000, stalls: 2, stalled_ms: 6000, ended: 'finished' }),
  row({ id: 3, asked_at: ago(180), channel: 'cloud', provider_first: 'VidFast', height: 1080, resolve_ms: 20_000, first_frame_ms: 2000, played_ms: 1_740_000, stalls: 1, stalled_ms: 2000, ended: 'closed' }),
  row({ id: 5, asked_at: ago(300), tmdb_id: 990002, title: 'Health Film B', movie_id: 'M-BBBB', asked: 'torrent', outcome: 'failed', failure: 'no_source', torrent_failure: 'no_source', resolve_ms: 25_000 }),
];

export const UNHANDLED: UnhandledEntry[] = [
  { title: 'Health Series', movie_id: null, kind: 'tv', tmdb_id: 990003, season: 1, episode: 2, asks: 2, last_asked_at: ago(30).toISOString(), cloud_failure: 'no_stream', torrent_failure: 'no_source' },
];
