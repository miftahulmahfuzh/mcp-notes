import { describe, expect, it } from 'vitest';
import type { MediaProbe } from '../../../../../src/directStream/torrent/probe.js';
import type { TorrentRemux } from '../../../../../src/directStream/torrent/remux.js';
import { chooseOrder, chosenText, deliveryText, filmKbpsOf, RATIO_MARGIN } from '../../../../../src/directStream/torrent/source/delivery.js';
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

// The two live cases of docs/plans/2026-11-27-torrent-ranking-evidence.md (decided 2026-11-27: option 2, a 1.5x margin).
describe('chooseOrder: the delivery ratio before the English subtitle file when no racer delivers', () => {
  type Racer = { name: string; position: number; english: boolean; height: 1080 | 720; d: { peers: number; downKbps: number; filmKbps: number | null } | null };
  const of = (r: Racer) => r.d;
  const NOMA: Racer = { name: 'NOMA', position: 1, english: false, height: 1080, d: { peers: 3, downKbps: 2900, filmKbps: 3100 } };
  const RUS: Racer = { name: 'Чудо в камере №7', position: 0, english: true, height: 1080, d: { peers: 1, downKbps: 1500, filmKbps: 6600 } };
  const ARTYMKO: Racer = { name: 'ArtymKo', position: 0, english: true, height: 1080, d: { peers: 4, downKbps: 1900, filmKbps: 6000 } };
  const YTS: Racer = { name: 'YTS', position: 1, english: false, height: 1080, d: { peers: 5, downKbps: 1000, filmKbps: 2600 } };
  const SARTRE: Racer = { name: 'SARTRE', position: 2, english: false, height: 1080, d: { peers: 2, downKbps: 500, filmKbps: 4700 } };

  it('the margin is 1.5x', () => {
    expect(RATIO_MARGIN).toBe(1.5);
  });

  it('Miracle in Cell No. 7: NOMA (2.9 of 3.1 Mbps) beats the Russian release (1.5 of 6.6) with English subtitles, and says why', () => {
    const order = chooseOrder([RUS, NOMA], of);
    expect(order.map((r) => r.name)).toEqual(['NOMA', 'Чудо в камере №7']);
    expect(chosenText(order[0]!, order[1] ?? null, of)).toBe('chosen: 4.1x the delivery of the next');
  });

  it('Confessions: ArtymKo (1.9 of 6.0) against YTS (1.0 of 2.6) is within 1.5x, so its English subtitle file still decides', () => {
    const order = chooseOrder([ARTYMKO, YTS, SARTRE], of);
    expect(order.map((r) => r.name)).toEqual(['ArtymKo', 'YTS', 'SARTRE']);
    expect(chosenText(order[0]!, order[1] ?? null, of)).toBe('chosen for its English subtitle file');
  });

  it('a racer that delivers and the preferred height still come first, whatever the ratios', () => {
    const delivering: Racer = { name: 'D', position: 3, english: false, height: 1080, d: { peers: 2, downKbps: 3200, filmKbps: 3100 } };
    expect(chooseOrder([NOMA, delivering], of).map((r) => r.name)).toEqual(['D', 'NOMA']);
    expect(chosenText(delivering, NOMA, of)).toBe('chosen: it delivers');
    const r720: Racer = { name: '720', position: 0, english: false, height: 720, d: { peers: 3, downKbps: 2900, filmKbps: 3000 } };
    expect(chooseOrder([r720, RUS], of).map((r) => r.name)).toEqual(['Чудо в камере №7', '720']);
    expect(chosenText(RUS, r720, of)).toBe('chosen for its height');
  });

  it('within the margin: then more peers, then the finder\'s order; an unknown ratio is never compared', () => {
    const a: Racer = { name: 'A', position: 0, english: false, height: 1080, d: { peers: 2, downKbps: 1000, filmKbps: 2000 } };
    const b: Racer = { name: 'B', position: 1, english: false, height: 1080, d: { peers: 4, downKbps: 1200, filmKbps: 2000 } };
    expect(chooseOrder([a, b], of).map((r) => r.name)).toEqual(['B', 'A']);
    expect(chosenText(b, a, of)).toBe('chosen for more peers');
    const c: Racer = { ...a, name: 'C', position: 1 };
    expect(chosenText(a, c, of)).toBe("chosen in the finder's order");
    const unknown: Racer = { name: 'U', position: 0, english: true, height: 1080, d: { peers: 1, downKbps: 100, filmKbps: null } };
    expect(chooseOrder([unknown, NOMA], of).map((r) => r.name)).toEqual(['U', 'NOMA']);
    // Nothing moving at all is no ratio to win with.
    const still: Racer = { name: 'S', position: 0, english: true, height: 1080, d: { peers: 1, downKbps: 0, filmKbps: 3000 } };
    const still2: Racer = { ...still, name: 'S2', position: 1, english: false };
    expect(chooseOrder([still2, still], of).map((r) => r.name)).toEqual(['S', 'S2']);
    expect(chosenText(NOMA, null, of)).toBe('chosen');
  });
});
