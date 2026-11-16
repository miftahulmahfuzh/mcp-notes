import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseTorrentFinder } from '../../src/config.js';

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

  it('reads the ffmpeg the torrent source runs', () => {
    const t = (env: Record<string, string>) => loadConfig({ env: { DATABASE_URL: 'postgres://u:p@localhost/db', ...env }, envFile: false }).torrent;
    expect(t({})?.ffmpegBin).toBe('ffmpeg');
    expect(t({ NOTESD_FFMPEG_BIN: '/opt/ff/bin/ffmpeg' })?.ffmpegBin).toBe('/opt/ff/bin/ffmpeg');
  });
});
