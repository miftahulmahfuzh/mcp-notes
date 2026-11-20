import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TORRENT_CONFIG, DEFAULT_TORRENT_SITES_CONFIG, loadConfig, parseTorrent } from '../../src/config.js';

const DATA = '/srv/notes';

describe('torrent settings', () => {
  it('are on, under <dataDir>/movies/torrents, capped at 100 kB/s and kept 7 days by default', () => {
    expect(parseTorrent({}, DATA)).toEqual({ enabled: true, dir: path.join(DATA, 'movies', 'torrents'), uploadKbps: 100, keepDays: 7, discovery: true, peers: [], trackerLists: true, finder: { indexes: {} }, ffmpegBin: 'ffmpeg', remux: true, subtitleUrl: 'https://opensubtitles-v3.strem.io', wyzieKey: null, wyzieUrl: 'https://sub.wyzie.io', wyzieSync: null, sites: DEFAULT_TORRENT_SITES_CONFIG, whisper: { enabled: true, dir: path.join(DATA, 'whisper'), python: path.join(DATA, 'whisper', 'venv', 'bin', 'python'), model: 'small', threads: 8, stretchS: 300 } });
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
          NOTESD_TORRENT_TRACKER_LISTS: 'off',
        },
        DATA,
      ),
    ).toEqual({ enabled: false, dir: '/mnt/data/torrents', uploadKbps: 64, keepDays: 3, discovery: false, peers: ['127.0.0.1:6881', '[::1]:7000', 'seed.local:51413'], trackerLists: false, finder: { indexes: {} }, ffmpegBin: 'ffmpeg', remux: true, subtitleUrl: 'https://opensubtitles-v3.strem.io', wyzieKey: null, wyzieUrl: 'https://sub.wyzie.io', wyzieSync: null, sites: DEFAULT_TORRENT_SITES_CONFIG, whisper: { enabled: true, dir: path.join(DATA, 'whisper'), python: path.join(DATA, 'whisper', 'venv', 'bin', 'python'), model: 'small', threads: 8, stretchS: 300 } });
  });

  it('refuse a relative folder, a zero cap or keep, and a peer without a port', () => {
    expect(() => parseTorrent({ NOTESD_TORRENT_DIR: 'torrents' }, DATA)).toThrow(/NOTESD_TORRENT_DIR must be an absolute path/);
    expect(() => parseTorrent({ NOTESD_TORRENT_UPLOAD_KBPS: '0' }, DATA)).toThrow(/NOTESD_TORRENT_UPLOAD_KBPS must be a positive integer/);
    expect(() => parseTorrent({ NOTESD_TORRENT_KEEP_DAYS: '0' }, DATA)).toThrow(/NOTESD_TORRENT_KEEP_DAYS must be a positive integer/);
    expect(() => parseTorrent({ NOTESD_TORRENT_PEERS: '127.0.0.1' }, DATA)).toThrow(/NOTESD_TORRENT_PEERS takes host:port/);
    expect(() => parseTorrent({ NOTESD_TORRENT_PEERS: '127.0.0.1:70000' }, DATA)).toThrow(/NOTESD_TORRENT_PEERS takes host:port/);
    expect(() => parseTorrent({ NOTESD_TORRENT: 'maybe' }, DATA)).toThrow(/NOTESD_TORRENT must be "on" or "off"/);
  });

  it('read how long a play may wait for its subtitle, and leave it unset by default', () => {
    expect(parseTorrent({ NOTESD_TORRENT_SUBTITLE_WAIT_MS: '40000' }, DATA).subtitleWaitMs).toBe(40000);
    expect(parseTorrent({ NOTESD_TORRENT_SUBTITLE_WAIT_MS: ' ' }, DATA)).not.toHaveProperty('subtitleWaitMs');
    expect(() => parseTorrent({ NOTESD_TORRENT_SUBTITLE_WAIT_MS: '0' }, DATA)).toThrow(/NOTESD_TORRENT_SUBTITLE_WAIT_MS must be a positive integer/);
  });

  it('read the tracker lists switch: on by default, unset in DEFAULT_TORRENT_CONFIG', () => {
    expect(parseTorrent({}, DATA).trackerLists).toBe(true);
    expect(parseTorrent({ NOTESD_TORRENT_TRACKER_LISTS: 'off' }, DATA).trackerLists).toBe(false);
    expect(parseTorrent({ NOTESD_TORRENT_TRACKER_LISTS: 'on' }, DATA).trackerLists).toBe(true);
    expect(() => parseTorrent({ NOTESD_TORRENT_TRACKER_LISTS: 'maybe' }, DATA)).toThrow(/NOTESD_TORRENT_TRACKER_LISTS must be "on" or "off"/);
    expect(DEFAULT_TORRENT_CONFIG.trackerLists).toBeUndefined();
  });

  it('follow NOTES_DATA_DIR in loadConfig', () => {
    const cfg = loadConfig({ env: { DATABASE_URL: 'postgres://u@127.0.0.1:1/db', NOTES_DATA_DIR: '/srv/notes-b' }, envFile: false });
    expect(cfg.torrent?.dir).toBe('/srv/notes-b/movies/torrents');
  });

  it('read the subtitle service address and the Wyzie key', () => {
    const t = (env: Record<string, string>) => parseTorrent(env, DATA);
    expect(DEFAULT_TORRENT_CONFIG.subtitleUrl).toBeNull();
    expect(DEFAULT_TORRENT_CONFIG.wyzieKey).toBeNull();
    expect(DEFAULT_TORRENT_CONFIG.wyzieUrl).toBeNull();
    expect(t({}).subtitleUrl).toBe('https://opensubtitles-v3.strem.io');
    expect(t({ NOTESD_TORRENT_SUBTITLE_URL: 'off' }).subtitleUrl).toBeNull();
    expect(t({ NOTESD_TORRENT_SUBTITLE_URL: ' http://127.0.0.1:9100/ ' }).subtitleUrl).toBe('http://127.0.0.1:9100');
    expect(() => t({ NOTESD_TORRENT_SUBTITLE_URL: 'strem.io' })).toThrow(/NOTESD_TORRENT_SUBTITLE_URL/);
    expect(t({ WYZIE_API_KEY: ' wyzie-test-key ' }).wyzieKey).toBe('wyzie-test-key');
    expect(t({ WYZIE_API_KEY: '  ' }).wyzieKey).toBeNull();
    expect(t({ NOTESD_TORRENT_WYZIE_URL: 'http://127.0.0.1:9101/' }).wyzieUrl).toBe('http://127.0.0.1:9101');
    expect(t({ NOTESD_TORRENT_WYZIE_URL: 'off' }).wyzieUrl).toBeNull();
    expect(() => t({ NOTESD_TORRENT_WYZIE_URL: 'wyzie' })).toThrow(/NOTESD_TORRENT_WYZIE_URL/);
    // Wyzie Synced: on with a key, with Whisper's Python whether or not the Whisper tier is on.
    expect(DEFAULT_TORRENT_CONFIG.wyzieSync).toBeNull();
    expect(t({}).wyzieSync).toBeNull();
    expect(t({ WYZIE_API_KEY: 'k' }).wyzieSync).toEqual({ python: path.join(DATA, 'whisper', 'venv', 'bin', 'python') });
    expect(t({ WYZIE_API_KEY: 'k', NOTESD_TORRENT_WHISPER: 'off', NOTESD_TORRENT_WHISPER_DIR: '/opt/w' }).wyzieSync).toEqual({ python: '/opt/w/venv/bin/python' });
    expect(t({ WYZIE_API_KEY: 'k', NOTESD_TORRENT_WHISPER_PYTHON: '/usr/bin/python3' }).wyzieSync).toEqual({ python: '/usr/bin/python3' });
    expect(t({ WYZIE_API_KEY: 'k', NOTESD_TORRENT_WYZIE_SYNC: 'off' }).wyzieSync).toBeNull();
    expect(t({ WYZIE_API_KEY: 'k', NOTESD_TORRENT_WYZIE_URL: 'off' }).wyzieSync).toBeNull();
    expect(() => t({ NOTESD_TORRENT_WYZIE_SYNC: 'maybe' })).toThrow(/NOTESD_TORRENT_WYZIE_SYNC/);
  });

  it('are off in DEFAULT_TORRENT_CONFIG, whose folder is never in the owner\'s data directory', () => {
    expect(DEFAULT_TORRENT_CONFIG.enabled).toBe(false);
    expect(DEFAULT_TORRENT_CONFIG.dir).not.toContain('mcp-notes-data');
  });
});
