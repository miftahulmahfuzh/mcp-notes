import { describe, expect, it } from 'vitest';
import { askedOf, channelFailures, failureDetailOf, RELEASE_DATE_ATTEMPT, subtitleSourceOf } from '../../../../src/directStream/playLog/derive.js';
import { NOT_RELEASED } from '../../../../src/directStream/service.js';
import { SessionStore, type SessionTorrent } from '../../../../src/directStream/sessions.js';
import { DirectStreamError, type ResolveAttempt, type ResolvedSource } from '../../../../src/directStream/types.js';
import { siteAttemptName } from '../../../../src/streaming/fallback.js';

const a = (provider: string, outcome: ResolveAttempt['outcome']): ResolveAttempt => ({ provider, outcome, took_s: 1, detail: '' });
const fail = (code: 'no_source' | 'resolve_failed' | 'torrent_off', attempts: ResolveAttempt[]) => new DirectStreamError(code, 'nothing', { attempts });
const SOURCE: ResolvedSource = {
  provider: 'Alpha', embed_url: 'https://embed.example/e/1', manifest_url: 'https://up.example/hls/master.m3u8', manifest_kind: 'hls',
  headers: { referer: null, origin: null, user_agent: null }, subtitles: [], best_height: 1080, en_subtitle: false, took_s: 1,
};

describe('how the ask named its source', () => {
  it('reads a magnet, a codename and a provider as the session lock does', () => {
    expect(askedOf(null, null)).toBeNull();
    expect(askedOf(null, 'magnet:?xt=urn:btih:abc')).toBe('torrent');
    expect(askedOf('Torrent', null)).toBe('torrent');
    expect(askedOf('cloud', null)).toBe('cloud');
    expect(askedOf('VidLink', null)).toBe('provider');
  });
});

describe('the word each channel of a failed ask ended with', () => {
  it('a cloud ask whose providers found nothing, the torrents not asked', () => {
    expect(channelFailures('cloud', fail('no_source', [a('Alpha', 'no_stream'), a('Beta', 'no_stream')]))).toEqual({ cloud: 'no_stream', torrent: null });
  });
  it('a bot check outranks nothing found, and a dub outranks nothing found', () => {
    expect(channelFailures(null, fail('no_source', [a('Alpha', 'no_stream'), a('Beta', 'bot_check')])).cloud).toBe('bot_check');
    expect(channelFailures(null, fail('no_source', [a('Alpha', 'no_stream'), a('Beta', 'dubbed')])).cloud).toBe('dubbed');
  });
  it('indexes that listed nothing worth trying mean no torrent exists', () => {
    expect(channelFailures('torrent', fail('no_source', [a('Index: torrentio', 'no_stream'), a('Index: yts', 'resolved')]))).toEqual({ cloud: null, torrent: 'no_source' });
  });
  it('torrents tried and failed say how; indexes that all failed say error; an index behind a bot check says so', () => {
    expect(channelFailures('torrent', fail('no_source', [a('Index: torrentio', 'resolved'), a('Torrent: Film 2022 1080p', 'dubbed')])).torrent).toBe('dubbed');
    expect(channelFailures('torrent', fail('no_source', [a('Index: torrentio', 'error'), a('Index: yts', 'error')])).torrent).toBe('error');
    expect(channelFailures('torrent', fail('no_source', [a('Index: rutracker', 'bot_check'), a('Index: yts', 'no_stream')])).torrent).toBe('bot_check');
  });
  it('the long way: every cloud provider, then the torrents, each with its own word', () => {
    expect(channelFailures(null, fail('no_source', [a('Alpha', 'no_stream'), a('Index: torrentio', 'resolved'), a('Torrent: Film 2022 1080p', 'error'), a('WARP', 'error')]))).toEqual({ cloud: 'no_stream', torrent: 'error' });
  });
  it('a resolve that could not run, and torrents that are off, say so for the channel asked', () => {
    expect(channelFailures(null, fail('resolve_failed', []))).toEqual({ cloud: 'resolve_failed', torrent: null });
    expect(channelFailures('torrent', fail('torrent_off', []))).toEqual({ cloud: null, torrent: 'torrent_off' });
  });
  it('a title not out yet asked neither channel; subtitle tiers and streaming sites belong to neither', () => {
    expect(channelFailures(null, fail('no_source', [a(RELEASE_DATE_ATTEMPT, 'skipped')]))).toEqual({ cloud: null, torrent: null });
    expect(channelFailures(null, fail('no_source', [a('Alpha', 'no_stream'), a('Subtitles: Wyzie', 'resolved'), a(siteAttemptName('idlix'), 'no_stream')]))).toEqual({ cloud: 'no_stream', torrent: null });
  });
  it('keeps the attempt names it reads equal to the ones the service and the site fallback write', () => {
    expect(RELEASE_DATE_ATTEMPT).toBe(NOT_RELEASED);
    expect(siteAttemptName('idlix').startsWith('Site: ')).toBe(true);
  });
});

describe('a failure detail', () => {
  it('keeps no query, no fragment and no magnet, and at most 500 characters', () => {
    const detail = failureDetailOf(new Error(`could not open https://up.example/hls/a.m3u8?tok=SECRET#x nor magnet:?xt=urn:btih:abcdef&tr=udp://t ${'x'.repeat(900)}`));
    expect(detail).not.toContain('SECRET');
    expect(detail).not.toContain('xt=');
    expect(detail).toContain('https://up.example/hls/a.m3u8');
    expect(detail?.length).toBeLessThanOrEqual(500);
  });
});

describe('where the English subtitle comes from', () => {
  it('the stream, a subtitle from outside it, a torrent tier, or nothing', () => {
    const store = new SessionStore();
    const english = store.create({ kind: 'movie', tmdbId: 550 }, { ...SOURCE, subtitles: [{ url: 'https://up.example/en.vtt', lang: 'en', label: 'English', format: 'vtt', source: 'request' }] }, []);
    expect(subtitleSourceOf(english)).toBe('stream');
    const none = store.create({ kind: 'movie', tmdbId: 550 }, SOURCE, []);
    expect(subtitleSourceOf(none)).toBeNull();
    none.outside.subtitles = [{ url: '/api/stream/subs/movie-550/outside.vtt', lang: 'en', label: 'English' }];
    expect(subtitleSourceOf(none)).toBe('outside');
    const torrent = store.create({ kind: 'movie', tmdbId: 550 }, { ...SOURCE, provider: 'Torrent' }, [a('Subtitles: Wyzie', 'resolved')]);
    torrent.torrent = { infoHash: 'a'.repeat(40), subtitles: [], height: 1080, index: 'torrentio', seeds: 16 } as unknown as SessionTorrent;
    expect(subtitleSourceOf(torrent)).toBe('Wyzie');
  });
});
