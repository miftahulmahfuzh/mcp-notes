import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { normalizeLang } from '../../../claude/streaming/direct/lang.mjs';
import { audioLanguages, describeProbe, normalizeAudioLang, parseProbe, ProbeError } from '../../../src/directStream/torrent/probe.js';

const mp4 = {
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264', height: 720 },
    { index: 1, codec_type: 'audio', codec_name: 'aac', tags: { language: 'eng' } },
    { index: 2, codec_type: 'video', codec_name: 'mjpeg', height: 300, disposition: { attached_pic: 1 } },
  ],
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '62.500000' },
};

describe('parseProbe', () => {
  it('reads an H.264/AAC MP4 as direct, its 720p picture, English audio and duration, and skips a cover picture', () => {
    const probe = parseProbe(mp4);
    expect(probe).toEqual({
      container: 'mov,mp4,m4a,3gp,3g2,mj2',
      video: { codec: 'h264', height: 720 },
      audio: [{ codec: 'aac', lang: 'eng' }],
      subtitles: [],
      durationS: 62.5,
      direct: true,
    });
    expect(audioLanguages(probe)).toEqual(['en']);
    expect(describeProbe(probe)).toBe('mov h264 720p / aac');
  });

  it('marks an MKV with HEVC and E-AC3, and an MP4 with AC3 audio, as not direct', () => {
    const mkv = parseProbe({
      streams: [
        { index: 0, codec_type: 'video', codec_name: 'hevc', height: 1080 },
        { index: 1, codec_type: 'audio', codec_name: 'eac3', tags: { language: 'kor' } },
        { index: 2, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } },
        { index: 3, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { language: 'eng', title: 'English SDH' }, disposition: { hearing_impaired: 1 } },
      ],
      format: { format_name: 'matroska,webm', duration: '5400.0' },
    });
    expect(mkv.direct).toBe(false);
    expect(mkv.subtitles).toEqual([
      { index: 2, codec: 'subrip', lang: 'eng', text: true, title: null, forced: false, hearingImpaired: false },
      { index: 3, codec: 'hdmv_pgs_subtitle', lang: 'eng', text: false, title: 'English SDH', forced: false, hearingImpaired: true },
    ]);
    expect(parseProbe({ ...mp4, streams: [mp4.streams[0], { index: 1, codec_type: 'audio', codec_name: 'ac3' }] }).direct).toBe(false);
  });

  it('plays a WebM with VP9 and Opus as is, and a file with no video never', () => {
    expect(parseProbe({ streams: [{ index: 0, codec_type: 'video', codec_name: 'vp9', height: 1080 }, { index: 1, codec_type: 'audio', codec_name: 'opus' }], format: { format_name: 'matroska,webm' } }).direct).toBe(true);
    expect(parseProbe({ streams: [{ index: 0, codec_type: 'audio', codec_name: 'aac' }], format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2' } }).direct).toBe(false);
  });

  it('rejects an answer of the wrong shape as bad_output', () => {
    expect(() => parseProbe({ streams: 'x' })).toThrow(ProbeError);
  });
});

describe('normalizeAudioLang', () => {
  it('agrees with the resolver\'s lang.mjs on every kind of tag', () => {
    for (const tag of ['eng', 'English', 'en-US', 'kor', 'Korean', 'jpn', 'chi', 'fre', 'ger', 'spa', 'por', 'hin', 'ind', 'tha', 'und', '', 'haw', 'xx', 'nob', 'Español']) {
      expect(normalizeAudioLang(tag)).toBe(normalizeLang(tag));
    }
  });
});
