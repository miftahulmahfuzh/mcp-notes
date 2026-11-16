import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_TORRENT_WHISPER_CONFIG, parseTorrentWhisper } from '../../../../src/config.js';

const DATA = '/home/u/mcp-notes-data';

describe('parseTorrentWhisper', () => {
  it('is on with the data folder, small, 8 threads and 5-minute stretches by default', () => {
    expect(parseTorrentWhisper({}, DATA)).toEqual({
      enabled: true,
      dir: '/home/u/mcp-notes-data/whisper',
      python: '/home/u/mcp-notes-data/whisper/venv/bin/python',
      model: 'small',
      threads: 8,
      stretchS: 300,
    });
  });

  it('off carries nothing else', () => {
    expect(parseTorrentWhisper({ NOTESD_TORRENT_WHISPER: 'off', NOTESD_TORRENT_WHISPER_MODEL: 'bad model' }, DATA)).toEqual({ enabled: false });
    expect(DEFAULT_TORRENT_WHISPER_CONFIG).toEqual({ enabled: false });
  });

  it('takes every setting', () => {
    expect(
      parseTorrentWhisper(
        {
          NOTESD_TORRENT_WHISPER: 'on',
          NOTESD_TORRENT_WHISPER_DIR: '/opt/whisper',
          NOTESD_TORRENT_WHISPER_PYTHON: '/usr/local/bin/python3',
          NOTESD_TORRENT_WHISPER_MODEL: 'base.en',
          NOTESD_TORRENT_WHISPER_THREADS: '4',
          NOTESD_TORRENT_WHISPER_STRETCH_S: '60',
        },
        DATA,
      ),
    ).toEqual({ enabled: true, dir: '/opt/whisper', python: '/usr/local/bin/python3', model: 'base.en', threads: 4, stretchS: 60 });
    expect(parseTorrentWhisper({ NOTESD_TORRENT_WHISPER_DIR: '/opt/whisper' }, DATA)).toMatchObject({ python: '/opt/whisper/venv/bin/python' });
    expect(parseTorrentWhisper({ NOTESD_TORRENT_WHISPER_MODEL: 'Systran/faster-whisper-small' }, DATA)).toMatchObject({ model: 'Systran/faster-whisper-small' });
  });

  it('rejects what it cannot use', () => {
    expect(() => parseTorrentWhisper({ NOTESD_TORRENT_WHISPER: 'maybe' }, DATA)).toThrow(ConfigError);
    expect(() => parseTorrentWhisper({ NOTESD_TORRENT_WHISPER_MODEL: 'small; rm -rf /' }, DATA)).toThrow(ConfigError);
    expect(() => parseTorrentWhisper({ NOTESD_TORRENT_WHISPER_MODEL: '../../etc' }, DATA)).toThrow(ConfigError);
    expect(() => parseTorrentWhisper({ NOTESD_TORRENT_WHISPER_THREADS: '0' }, DATA)).toThrow(ConfigError);
    expect(() => parseTorrentWhisper({ NOTESD_TORRENT_WHISPER_STRETCH_S: '4' }, DATA)).toThrow(ConfigError);
    expect(() => parseTorrentWhisper({ NOTESD_TORRENT_WHISPER_DIR: 'whisper' }, DATA)).toThrow(ConfigError);
    expect(() => parseTorrentWhisper({ NOTESD_TORRENT_WHISPER_PYTHON: 'python3' }, DATA)).toThrow(ConfigError);
  });
});
