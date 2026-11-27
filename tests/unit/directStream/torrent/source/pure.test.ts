import { describe, expect, it } from 'vitest';
import type { MediaProbe } from '../../../../../src/directStream/torrent/probe.js';
import type { TorrentRemux } from '../../../../../src/directStream/torrent/remux.js';
import { deliveryText, filmKbpsOf } from '../../../../../src/directStream/torrent/source/delivery.js';
import { keptFailure } from '../../../../../src/directStream/torrent/source.js';
import { indexAttempt, queryOf, refKey } from '../../../../../src/directStream/torrent/source/query.js';
import { playsOriginalDirect, refusalOf } from '../../../../../src/directStream/torrent/source/refusal.js';
import { foundIn, plural, seconds } from '../../../../../src/directStream/torrent/source/text.js';

const probe = (over: Partial<MediaProbe>): MediaProbe => ({
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  video: { codec: 'h264', height: 1080 },
  audio: [{ codec: 'aac', lang: 'eng' }],
  subtitles: [],
  durationS: 6000,
  direct: true,
  ...over,
});
const REMUX = {} as TorrentRemux;

describe('refusalOf: the original language only, and only what plays', () => {
  it('refuses a file whose audio names only another language as dubbed, with or without a remux', () => {
    const p = probe({ audio: [{ codec: 'aac', lang: 'spa' }] });
    expect(refusalOf(p, 'en', null)?.outcome).toBe('dubbed');
    expect(refusalOf(p, 'en', REMUX)?.outcome).toBe('dubbed');
  });

  it('plays a direct file whose audio is the original, or names no language', () => {
    expect(refusalOf(probe({}), 'en', null)).toBeNull();
    expect(refusalOf(probe({ audio: [{ codec: 'aac', lang: null }] }), 'en', null)).toBeNull();
    expect(refusalOf(probe({}), null, null)).toBeNull();
  });

  it('a dual-audio file whose original is not the default: dubbed without a remux, played through one', () => {
    const p = probe({ audio: [{ codec: 'aac', lang: 'spa' }, { codec: 'aac', lang: 'eng' }] });
    expect(playsOriginalDirect(p, 'en')).toBe(false);
    expect(refusalOf(p, 'en', null)?.outcome).toBe('dubbed');
    expect(refusalOf(p, 'en', REMUX)).toBeNull();
  });

  it('a file Chrome cannot play: unplayable without a remux, and with one when its video cannot be remuxed', () => {
    const mkv = probe({ container: 'matroska,webm', direct: false });
    expect(refusalOf(mkv, 'en', null)?.outcome).toBe('unplayable');
    expect(refusalOf(mkv, 'en', REMUX)).toBeNull();
    expect(refusalOf({ ...mkv, video: { codec: 'mpeg4', height: 480 } }, 'en', REMUX)?.outcome).toBe('unplayable');
  });
});

describe('the finder query and attempts', () => {
  it('refKey names a film and an episode apart', () => {
    expect(refKey({ kind: 'movie', tmdbId: 5 })).toBe('movie:5');
    expect(refKey({ kind: 'tv', tmdbId: 5, season: 2, episode: 3 })).toBe('tv:5:2:3');
  });

  it('queryOf carries the names, year and original language, and the place in the season only when TMDB runs on', () => {
    const names = { title: 'One Piece', originalTitle: 'ワンピース', year: 1999, episodeInSeason: 109 };
    expect(queryOf({ kind: 'movie', tmdbId: 1 }, 'tt1', null, 'ja')).toEqual({ imdbId: 'tt1', title: null, originalTitle: null, year: null, originalLanguage: 'ja', kind: 'movie' });
    const runsOn = queryOf({ kind: 'tv', tmdbId: 1, season: 21, episode: 1000 }, null, names, 'ja');
    expect(runsOn).toMatchObject({ kind: 'tv', season: 21, episode: 1000, absoluteEpisode: 1000, alt: { season: 21, episode: 109 } });
    const plain = queryOf({ kind: 'tv', tmdbId: 1, season: 1, episode: 3 }, null, { ...names, episodeInSeason: 3 }, 'ja');
    expect(plain).not.toHaveProperty('absoluteEpisode');
  });

  it('indexAttempt maps an index outcome to an attempt', () => {
    expect(indexAttempt({ index: 'knaben', outcome: 'empty', took_s: 1.2, detail: 'nothing' } as Parameters<typeof indexAttempt>[0])).toEqual({ provider: 'Index: knaben', outcome: 'no_stream', took_s: 1.2, detail: 'nothing' });
    expect(indexAttempt({ index: 'x', outcome: 'ok', took_s: null, detail: '' } as unknown as Parameters<typeof indexAttempt>[0]).outcome).toBe('resolved');
  });
});

describe('delivery words and the kept answer', () => {
  it('filmKbpsOf is bytes over seconds, null when either is unknown', () => {
    expect(filmKbpsOf(750_000_000, 6000)).toBe(1000);
    expect(filmKbpsOf(null, 6000)).toBeNull();
    expect(filmKbpsOf(1, 0)).toBeNull();
  });

  it('deliveryText says peers and rates, and nothing for an unknown delivery', () => {
    expect(deliveryText(null)).toBe('');
    expect(deliveryText({ peers: 1, downKbps: 3200, filmKbps: null })).toBe(' listed; 1 peer connected, 3.2 Mbps');
    expect(deliveryText({ peers: 5, downKbps: 3200, filmKbps: 2100 })).toBe(' listed; 5 peers connected, 3.2 Mbps for a 2.1 Mbps film');
  });

  it('keptFailure is dubbed only when every torrent tried was a dub', () => {
    const t = (outcome: string) => ({ provider: 'Torrent: x', outcome, took_s: 1, detail: '' }) as Parameters<typeof keptFailure>[0][number];
    expect(keptFailure([])).toBe('no_source');
    expect(keptFailure([t('dubbed'), t('skipped'), { ...t('error'), provider: 'Index: a' }])).toBe('dubbed');
    expect(keptFailure([t('dubbed'), t('no_stream')])).toBe('no_source');
  });

  it('log words', () => {
    expect(plural(1, 'peer')).toBe('1 peer');
    expect(plural(2, 'peer')).toBe('2 peers');
    expect(seconds(1000, 3460)).toBe(2.5);
    expect(foundIn(null)).toBe('');
    expect(foundIn({ index: 'knaben', listedBy: ['knaben', 'apibay'] })).toBe(' (from knaben, also listed by apibay)');
  });
});
