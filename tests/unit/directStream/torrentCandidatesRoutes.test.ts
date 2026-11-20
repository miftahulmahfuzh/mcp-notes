import { describe, expect, it, vi } from 'vitest';
import type { DirectStreamService } from '../../../src/directStream/service.js';
import { DirectStreamError } from '../../../src/directStream/types.js';
import { streamTorrentCandidatesRoutes } from '../../../src/http/streamTorrentCandidatesApi.js';

const COLD = '67b07b417f6f8f7d367bbded3cd797a0840724b6';
const SAME = { origin: 'http://localhost', 'content-type': 'application/json' };
const mark = { infoHash: COLD, name: 'Eternally.Yours.S01E07.1080p.ColdFilm.mkv', tagLanguages: null, heardLanguage: null, heardProbability: null, heardAt: null, blacklistedAt: new Date('2026-11-20T08:00:00Z'), blacklistReason: 'dub' };

function app(svc: Partial<DirectStreamService> | null) {
  return streamTorrentCandidatesRoutes({ directStream: svc as DirectStreamService | null });
}
const req = (path: string, init: RequestInit = {}) => new Request(`http://localhost${path}`, init);

describe('the torrent candidates and blacklist routes', () => {
  it('lists an episode\'s candidates, fresh on asking', async () => {
    const torrentCandidates = vi.fn(async () => ({ ref: { kind: 'tv', tmdbId: 313630, season: 1, episode: 7 }, original_language: 'en', listed_at: null, cached: false, indexes: [], candidates: [] }));
    const r = await app({ torrentCandidates } as never).fetch(req('/api/stream/torrents?kind=tv&tmdb_id=313630&season=1&episode=7&fresh=1'));
    expect(r.status).toBe(200);
    expect(torrentCandidates).toHaveBeenCalledWith({ kind: 'tv', tmdbId: 313630, season: 1, episode: 7 }, { fresh: true });
    expect((await app({ torrentCandidates } as never).fetch(req('/api/stream/torrents?kind=tv&tmdb_id=313630'))).status).toBe(400);
  });

  it('blacklists same-origin only, by a 40-hex hash, and takes it off again', async () => {
    const blacklistTorrent = vi.fn(async () => ({ mark, forgotten: ['M-8CBH'], moving: [] }));
    const unblacklistTorrent = vi.fn(async () => true);
    const a = app({ blacklistTorrent, unblacklistTorrent } as never);
    expect((await a.fetch(req(`/api/stream/torrents/${COLD}/blacklist`, { method: 'POST' }))).status).toBe(403);
    expect((await a.fetch(req('/api/stream/torrents/abc/blacklist', { method: 'POST', headers: SAME }))).status).toBe(400);
    const r = await a.fetch(req(`/api/stream/torrents/${COLD}/blacklist`, { method: 'POST', headers: SAME, body: JSON.stringify({ reason: 'dub' }) }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, torrent: { info_hash: COLD, reason: 'dub' }, forgotten_by: ['M-8CBH'] });
    expect(blacklistTorrent).toHaveBeenCalledWith(COLD, { reason: 'dub', name: null });
    const off = await a.fetch(req(`/api/stream/torrents/${COLD}/blacklist`, { method: 'DELETE', headers: SAME }));
    expect(await off.json()).toEqual({ ok: true, was_blacklisted: true });
  });

  it('answers direct_stream_off without direct streaming and torrent_off with torrents off', async () => {
    expect((await app(null).fetch(req('/api/stream/torrents/blacklist'))).status).toBe(503);
    const blacklistedTorrents = vi.fn(async () => {
      throw new DirectStreamError('torrent_off', 'off');
    });
    const r = await app({ blacklistedTorrents } as never).fetch(req('/api/stream/torrents/blacklist'));
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: 'torrent_off' });
  });
});
