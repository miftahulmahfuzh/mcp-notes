import { describe, expect, it } from 'vitest';
import { vlcArgs } from '../../../src/movies/vlc/launch.js';

const L = { winPath: 'C:\\Users\\x\\Videos\\Film.mkv', port: 47318, password: 'f'.repeat(32), startTime: 1200.7 };

describe('NOTESD_VLC_EXTRA_ARGS on the VLC argv', () => {
  it('R8.4: puts the extra args after notesd flags and right before the file', () => {
    const argv = vlcArgs(L, ['--avcodec-hw=none', '--no-video-title-show']);
    expect(argv.slice(-4)).toEqual(['--start-time=1200', '--avcodec-hw=none', '--no-video-title-show', 'C:\\Users\\x\\Videos\\Film.mkv']);
    expect(argv.slice(0, 2)).toEqual(['--no-one-instance', '--no-one-instance-when-started-from-file']);
  });

  it('without extras the argv is Phase 5 argv', () => {
    expect(vlcArgs(L)).toEqual(vlcArgs(L, []));
    expect(vlcArgs(L).slice(-2)).toEqual(['--start-time=1200', 'C:\\Users\\x\\Videos\\Film.mkv']);
  });
});
