import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TORRENT_SITES } from '../../../../src/directStream/torrent/find-sites.js';
import { KNOWN_ORIGINS, readMagnet, TRACKER_BOOK_MAX, TrackerBook, trackerKey } from '../../../../src/directStream/torrent/origins.js';

const HASH = '8a088ff63e25ee6614151853a2fa232243b9cae7';

describe('what a magnet says of its index', () => {
  it('RuTracker signs its magnets with bt*.t-ru.org', () => {
    const facts = readMagnet(`magnet:?xt=urn:btih:${HASH.toUpperCase()}&dn=The Handmaid's Tale&tr=http://bt.t-ru.org/ann?magnet&tr=http://bt4.t-ru.org/ann&tr=udp://tracker.opentrackr.org:1337&tr=udp://p4p.arenabg.com:1337`);
    expect(facts).toMatchObject({ infoHash: HASH, name: "The Handmaid's Tale", own: ['http://bt.t-ru.org/ann?magnet', 'http://bt4.t-ru.org/ann'], unknownHosts: ['p4p.arenabg.com'] });
    expect(facts?.origin).toMatchObject({ by: 'bt.t-ru.org', known: { index: 'rutracker', site: 'rutracker' } });
  });

  it('a magnet with public trackers only, or a bare hash, names no index', () => {
    expect(readMagnet(`magnet:?xt=urn:btih:${HASH}&tr=udp://tracker.opentrackr.org:1337/announce`)).toMatchObject({ origin: null, own: [], unknownHosts: [] });
    expect(readMagnet(HASH)).toMatchObject({ infoHash: HASH, name: null, trackers: [], origin: null });
    expect(readMagnet('magnet:?dn=nothing')).toBeNull();
    expect(readMagnet(`magnet:?xt=urn:btih:${'0'.repeat(40)}`)).toBeNull();
  });

  it('every known origin with a site names a real torrent site, and two spellings of a tracker are one', () => {
    for (const origin of KNOWN_ORIGINS) if (origin.site !== null) expect(TORRENT_SITES).toContain(origin.site);
    expect(new Set(KNOWN_ORIGINS.map((o) => o.index)).size).toBe(KNOWN_ORIGINS.length);
    expect(trackerKey('udp://Tracker.Opentrackr.org:1337')).toBe(trackerKey('udp://tracker.opentrackr.org:1337/announce'));
  });
});

describe('the tracker book', () => {
  it('keeps udp trackers it lacks, once, and survives a broken file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'notesd-book-'));
    const file = join(dir, 'deep', 'trackers.json');
    const book = new TrackerBook(file, () => new Date('2026-11-19T00:00:00Z'));
    expect(book.list()).toEqual([]);
    // opentrackr is one of DEFAULT_TRACKERS; an http tracker is never kept.
    expect(book.add(['udp://tracker.opentrackr.org:1337', 'udp://p4p.arenabg.com:1337', 'udp://p4p.arenabg.com:1337/announce', 'http://web.example/announce'], HASH)).toEqual(['udp://p4p.arenabg.com:1337']);
    expect(book.has('udp://P4P.arenabg.com:1337/announce')).toBe(true);
    expect(new TrackerBook(file).list()).toEqual(['udp://p4p.arenabg.com:1337']);
    expect(book.add(Array.from({ length: 60 }, (_, i) => `udp://t${i}.example:1`), HASH)).toHaveLength(TRACKER_BOOK_MAX - 1);
    writeFileSync(file, '{ not json');
    expect(new TrackerBook(file).list()).toEqual([]);
  });
});
