import { describe, expect, it } from 'vitest';
import { candidateFromMagnet } from '../../../../../src/directStream/torrent/find/candidate.js';
import type { TorrentQuery } from '../../../../../src/directStream/torrent/find/types.js';

const FILM: TorrentQuery = { kind: 'movie', imdbId: 'tt1481390', title: 'Curious Tales of a Temple', originalLanguage: 'zh' };
const HASH = 'f5ab15bfb22915770a14eca1a15e1d1dc375f83a';

describe('candidateFromMagnet', () => {
  it('reads the info hash, the dn name and the tr= trackers of a magnet the owner pasted', () => {
    const magnet = `magnet:?xt=urn:btih:${HASH}&dn=Curious Tales of a Temple 2025 1080p WEB-DL&tr=udp://open.stealth.si:80/announce&tr=udp://tracker.opentrackr.org:1337/announce`;
    const c = candidateFromMagnet(magnet, FILM)!;
    expect(c).toMatchObject({ infoHash: HASH, name: 'Curious Tales of a Temple 2025 1080p WEB-DL', index: 'magnet', listedBy: ['magnet'], seeds: 0, fileName: null });
    // Its own trackers, then the defaults, no repeats.
    expect(c.trackers).toContain('udp://open.stealth.si:80/announce');
    expect(c.trackers).toContain('udp://tracker.opentrackr.org:1337/announce');
    expect(new Set(c.trackers).size).toBe(c.trackers.length);
    // The release is parsed from the name, so the file-pick and the language check read it like an index row's.
    expect(c.release.height).toBe(1080);
  });

  it('takes a bare 40-hex info hash (no trackers but the defaults), and names it by the hash', () => {
    const c = candidateFromMagnet(HASH.toUpperCase(), FILM)!;
    expect(c.infoHash).toBe(HASH);
    expect(c.name).toBe(HASH);
    expect(c.trackers.length).toBeGreaterThan(0);
  });

  it('reads a base32 info hash', () => {
    // The base32 form of HASH.
    const c = candidateFromMagnet('magnet:?xt=urn:btih:6WVRLP5SFEKXOCQU5SQ2CXQ5DXBXL6B2&dn=X', FILM)!;
    expect(c.infoHash).toBe(HASH);
  });

  it('is null for anything that is not a magnet or a 40-hex hash', () => {
    for (const bad of ['', 'not a magnet', 'magnet:?dn=no+hash', 'https://ext.to/x', 'abc123', 'f'.repeat(39)]) {
      expect(candidateFromMagnet(bad, FILM)).toBeNull();
    }
  });
});
