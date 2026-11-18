import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseTorrentFinder, TORRENT_INDEX_URL_KEYS } from '../../src/config.js';

describe('parseTorrentFinder', () => {
  it('leaves every setting to the finder when nothing is set', () => {
    expect(parseTorrentFinder({})).toEqual({ indexes: {} });
  });

  it('reads the seed floor, the size cap in bytes, the index timeout, an index address and an index turned off', () => {
    expect(
      parseTorrentFinder({
        NOTESD_TORRENT_MIN_SEEDS: '8',
        NOTESD_TORRENT_MAX_GB: '12',
        NOTESD_TORRENT_INDEX_TIMEOUT_MS: '6000',
        NOTESD_TORRENT_TORRENTIO_URL: 'http://127.0.0.1:4555/',
        NOTESD_TORRENT_YTS_URL: 'OFF',
        NOTESD_TORRENT_APIBAY_URL: '',
      }),
    ).toEqual({ minSeeds: 8, maxSizeBytes: 12 * 1024 ** 3, indexTimeoutMs: 6000, indexes: { torrentio: 'http://127.0.0.1:4555', yts: null } });
  });

  it('rejects a bad number and an address that is not http(s)', () => {
    expect(() => parseTorrentFinder({ NOTESD_TORRENT_MIN_SEEDS: '0' })).toThrow(ConfigError);
    expect(() => parseTorrentFinder({ NOTESD_TORRENT_EZTV_URL: 'eztvx.to' })).toThrow(ConfigError);
  });

  it('reads the add-on providers\' addresses and their off switch', () => {
    expect(parseTorrentFinder({ NOTESD_TORRENT_TORRENTSDB_URL: 'https://tdb.example/', NOTESD_TORRENT_PEERFLIX_URL: 'off' })).toEqual({
      indexes: { torrentsdb: 'https://tdb.example', peerflix: null },
    });
    expect(() => parseTorrentFinder({ NOTESD_TORRENT_PEERFLIX_URL: 'addon.peerflix.mov' })).toThrow(ConfigError);
  });

  it('is named by verify.sh for every index, in both of its index lines, so no throwaway daemon asks a real index', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const verify = readFileSync(path.join(root, '.claude/skills/verify-notesd/scripts/verify.sh'), 'utf8');
    for (const key of Object.values(TORRENT_INDEX_URL_KEYS)) {
      expect(verify.split(`${key}=`).length - 1, `${key} in verify.sh`).toBeGreaterThanOrEqual(2);
    }
  });

  it('reads the ffmpeg the torrent source runs', () => {
    const t = (env: Record<string, string>) => loadConfig({ env: { DATABASE_URL: 'postgres://u:p@localhost/db', ...env }, envFile: false }).torrent;
    expect(t({})?.ffmpegBin).toBe('ffmpeg');
    expect(t({ NOTESD_FFMPEG_BIN: '/opt/ff/bin/ffmpeg' })?.ffmpegBin).toBe('/opt/ff/bin/ffmpeg');
  });
});
