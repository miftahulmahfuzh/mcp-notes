import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TORRENT_CONFIG, loadConfig, parseTorrent } from '../../src/config.js';

const DATA = '/srv/notes';

describe('torrent settings', () => {
  it('are on, under <dataDir>/movies/torrents, capped at 100 kB/s and kept 7 days by default', () => {
    expect(parseTorrent({}, DATA)).toEqual({ enabled: true, dir: path.join(DATA, 'movies', 'torrents'), uploadKbps: 100, keepDays: 7, discovery: true, peers: [], finder: { indexes: {} }, ffmpegBin: 'ffmpeg' });
  });

  it('read every variable', () => {
    expect(
      parseTorrent(
        {
          NOTESD_TORRENT: 'off',
          NOTESD_TORRENT_DIR: '/mnt/data/torrents/',
          NOTESD_TORRENT_UPLOAD_KBPS: '64',
          NOTESD_TORRENT_KEEP_DAYS: '3',
          NOTESD_TORRENT_DISCOVERY: 'off',
          NOTESD_TORRENT_PEERS: '127.0.0.1:6881, [::1]:7000,127.0.0.1:6881,seed.local:51413',
        },
        DATA,
      ),
    ).toEqual({ enabled: false, dir: '/mnt/data/torrents', uploadKbps: 64, keepDays: 3, discovery: false, peers: ['127.0.0.1:6881', '[::1]:7000', 'seed.local:51413'], finder: { indexes: {} }, ffmpegBin: 'ffmpeg' });
  });

  it('refuse a relative folder, a zero cap or keep, and a peer without a port', () => {
    expect(() => parseTorrent({ NOTESD_TORRENT_DIR: 'torrents' }, DATA)).toThrow(/NOTESD_TORRENT_DIR must be an absolute path/);
    expect(() => parseTorrent({ NOTESD_TORRENT_UPLOAD_KBPS: '0' }, DATA)).toThrow(/NOTESD_TORRENT_UPLOAD_KBPS must be a positive integer/);
    expect(() => parseTorrent({ NOTESD_TORRENT_KEEP_DAYS: '0' }, DATA)).toThrow(/NOTESD_TORRENT_KEEP_DAYS must be a positive integer/);
    expect(() => parseTorrent({ NOTESD_TORRENT_PEERS: '127.0.0.1' }, DATA)).toThrow(/NOTESD_TORRENT_PEERS takes host:port/);
    expect(() => parseTorrent({ NOTESD_TORRENT_PEERS: '127.0.0.1:70000' }, DATA)).toThrow(/NOTESD_TORRENT_PEERS takes host:port/);
    expect(() => parseTorrent({ NOTESD_TORRENT: 'maybe' }, DATA)).toThrow(/NOTESD_TORRENT must be "on" or "off"/);
  });

  it('follow NOTES_DATA_DIR in loadConfig', () => {
    const cfg = loadConfig({ env: { DATABASE_URL: 'postgres://u@127.0.0.1:1/db', NOTES_DATA_DIR: '/srv/notes-b' }, envFile: false });
    expect(cfg.torrent?.dir).toBe('/srv/notes-b/movies/torrents');
  });

  it('are off in DEFAULT_TORRENT_CONFIG, whose folder is never in the owner\'s data directory', () => {
    expect(DEFAULT_TORRENT_CONFIG.enabled).toBe(false);
    expect(DEFAULT_TORRENT_CONFIG.dir).not.toContain('mcp-notes-data');
  });
});
