import { describe, expect, it } from 'vitest';
import {
  HlsUnsupported,
  isMaster,
  localMaster,
  localMediaPlaylist,
  parseAttributes,
  parseMaster,
  parseMedia,
  pickAudio,
  pickVariant,
  type HlsRendition,
  type HlsVariant,
} from '../../../../src/directStream/cache/hls.js';

const variant = (height: number | null, bandwidth: number, url = `https://cdn.test/${height}.m3u8`): HlsVariant => ({
  url,
  bandwidth,
  averageBandwidth: null,
  width: height === null ? null : Math.round((height * 16) / 9),
  height,
  codecs: null,
  frameRate: null,
  audioGroup: null,
});

const rendition = (language: string | null, name: string | null, isDefault = false): HlsRendition => ({
  type: 'AUDIO',
  groupId: 'aud',
  name,
  language,
  isDefault,
  channels: null,
  url: `https://cdn.test/${language ?? name}.m3u8`,
});

function unsupported(fn: () => unknown): HlsUnsupported {
  try {
    fn();
  } catch (err) {
    if (err instanceof HlsUnsupported) return err;
    throw err;
  }
  throw new Error('expected HlsUnsupported');
}

describe('parseAttributes', () => {
  it('reads quoted values with commas and bare values', () => {
    const a = parseAttributes('BANDWIDTH=800000,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=1280x720,AUDIO="aud"');
    expect([...a.entries()]).toEqual([
      ['BANDWIDTH', '800000'],
      ['CODECS', 'avc1.4d401f,mp4a.40.2'],
      ['RESOLUTION', '1280x720'],
      ['AUDIO', 'aud'],
    ]);
  });
});

describe('parseMaster', () => {
  it("resolves a master served as VidNest's master.txt against its own address", () => {
    const text = '﻿#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=1280x720,AUDIO="aud"\n720/index.m3u8\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Japanese",LANGUAGE="ja",DEFAULT=YES,URI="/audio/ja.m3u8"\n';
    expect(isMaster(text)).toBe(true);
    const master = parseMaster(text, 'https://cdn.vidnest.test/x/y/master.txt?t=1');
    expect(master.variants).toEqual([
      { url: 'https://cdn.vidnest.test/x/y/720/index.m3u8', bandwidth: 900000, averageBandwidth: null, width: 1280, height: 720, codecs: null, frameRate: null, audioGroup: 'aud' },
    ]);
    expect(master.media).toEqual([{ type: 'AUDIO', groupId: 'aud', name: 'Japanese', language: 'ja', isDefault: true, channels: null, url: 'https://cdn.vidnest.test/audio/ja.m3u8' }]);
  });

  it('refuses a text that is no playlist, and a master without a rendition', () => {
    expect(unsupported(() => parseMaster('<html>', 'https://x.test/a')).reason).toBe('not_a_playlist');
    expect(unsupported(() => parseMaster('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n', 'https://x.test/a')).reason).toBe('empty');
  });
});

describe('pickVariant', () => {
  const all = [variant(360, 500), variant(1080, 4000), variant(720, 1500), variant(720, 2000, 'https://cdn.test/720b.m3u8')];
  it('takes the tallest, the widest of equal heights', () => {
    expect(pickVariant(all, null).height).toBe(1080);
    expect(pickVariant(all, 720).url).toBe('https://cdn.test/720b.m3u8');
  });
  it('takes the tallest not above max_height, else the shortest', () => {
    expect(pickVariant(all, 1000).height).toBe(720);
    expect(pickVariant(all, 480).height).toBe(360);
    expect(pickVariant(all, 200).height).toBe(360);
  });
  it('ranks by bandwidth when no rendition names a resolution', () => {
    expect(pickVariant([variant(null, 100, 'https://a.test/a'), variant(null, 300, 'https://a.test/b')], 720).url).toBe('https://a.test/b');
  });
});

describe('pickAudio', () => {
  const tracks = [rendition('en', 'English', true), rendition('ko', 'Korean'), rendition('ko', 'Korean (commentary)'), rendition(null, 'Original')];
  it("takes the resolver's original-language track by language and name, as the player does", () => {
    expect(pickAudio(tracks, 'aud', { track: { lang: 'ko', label: 'Korean (commentary)' }, lang: 'ko' })?.name).toBe('Korean (commentary)');
    expect(pickAudio(tracks, 'aud', { track: { lang: 'KO', label: 'Other' }, lang: null })?.name).toBe('Korean');
    expect(pickAudio(tracks, 'aud', { track: { lang: null, label: 'Original' }, lang: null })?.name).toBe('Original');
  });
  it("falls back to the title's original language, then the default", () => {
    expect(pickAudio([rendition('ko-KR', 'Korean'), rendition('en', 'English', true)], 'aud', { track: null, lang: 'ko' })?.name).toBe('Korean');
    expect(pickAudio(tracks, 'aud', { track: null, lang: 'fr' })?.name).toBe('English');
  });
  it('answers null without a group', () => {
    expect(pickAudio(tracks, null, { track: null, lang: 'ko' })).toBeNull();
    expect(pickAudio(tracks, 'other', { track: null, lang: 'ko' })).toBeNull();
  });
});

describe('parseMedia', () => {
  const BASE = 'https://cdn.test/v/index.m3u8';
  it('reads byte ranges (with and without offset), an init section with a range, keys with and without IV, and discontinuities', () => {
    const media = parseMedia(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MEDIA-SEQUENCE:10',
        '#EXT-X-DISCONTINUITY-SEQUENCE:2',
        '#EXT-X-MAP:URI="init.mp4",BYTERANGE="100@0"',
        '#EXT-X-KEY:METHOD=AES-128,URI="/k?t=1",IV=0x0A',
        '#EXTINF:4.0,first',
        '#EXT-X-BYTERANGE:1000@100',
        'media.mp4',
        '#EXTINF:4,',
        '#EXT-X-BYTERANGE:1000',
        'media.mp4',
        '#EXT-X-DISCONTINUITY',
        '#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain;base64,AAAA"',
        '#EXT-X-PROGRAM-DATE-TIME:2026-11-16T00:00:00Z',
        '#EXTINF:3.5,',
        'https://other.test/p3.m4s',
        '#EXT-X-KEY:METHOD=NONE',
        '#EXT-X-GAP',
        '#EXTINF:2,',
        'p4.m4s',
        '#EXT-X-ENDLIST',
      ].join('\r\n'),
      BASE,
    );
    expect(media).toMatchObject({ version: 7, targetDuration: 4, mediaSequence: 10, discontinuitySequence: 2 });
    expect(media.maps).toEqual([{ url: 'https://cdn.test/v/init.mp4', range: { length: 100, offset: 0 } }]);
    expect(media.keys).toEqual([
      { url: 'https://cdn.test/k?t=1', inline: null, iv: '0x0A', keyFormat: null, keyFormatVersions: null },
      { url: null, inline: 'data:text/plain;base64,AAAA', iv: null, keyFormat: null, keyFormatVersions: null },
    ]);
    expect(media.segments.map((s) => [s.url, s.duration, s.title, s.range, s.key, s.map, s.tags, s.gap])).toEqual([
      ['https://cdn.test/v/media.mp4', 4, 'first', { length: 1000, offset: 100 }, 0, 0, [], false],
      ['https://cdn.test/v/media.mp4', 4, '', { length: 1000, offset: 1100 }, 0, 0, [], false],
      ['https://other.test/p3.m4s', 3.5, '', null, 1, 0, ['#EXT-X-DISCONTINUITY', '#EXT-X-PROGRAM-DATE-TIME:2026-11-16T00:00:00Z'], false],
      ['https://cdn.test/v/p4.m4s', 2, '', null, null, 0, ['#EXT-X-GAP'], true],
    ]);
  });

  it('refuses DRM, a live playlist, an empty one and a range without a start', () => {
    const head = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n';
    expect(unsupported(() => parseMedia(`${head}#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k"\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n`, BASE))).toMatchObject({ reason: 'drm' });
    expect(unsupported(() => parseMedia(`${head}#EXT-X-KEY:METHOD=AES-128,URI="k",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n`, BASE))).toMatchObject({ reason: 'drm' });
    expect(unsupported(() => parseMedia(`${head}#EXTINF:4,\na.ts\n`, BASE))).toMatchObject({ reason: 'live' });
    expect(unsupported(() => parseMedia(`${head}#EXT-X-ENDLIST\n`, BASE))).toMatchObject({ reason: 'empty' });
    expect(unsupported(() => parseMedia(`${head}#EXTINF:4,\n#EXT-X-BYTERANGE:10\na.ts\n#EXT-X-ENDLIST\n`, BASE))).toMatchObject({ reason: 'not_a_playlist' });
  });
});

describe('local playlists', () => {
  it('name every segment by position, keep the media sequence, IV, discontinuities and gaps, and drop byte ranges', () => {
    const media = parseMedia(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:4',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MEDIA-SEQUENCE:10',
        '#EXT-X-INDEPENDENT-SEGMENTS',
        '#EXT-X-MAP:URI="init.mp4"',
        '#EXT-X-KEY:METHOD=AES-128,URI="k1",IV=0x01,KEYFORMAT="identity"',
        '#EXTINF:4.0,',
        '#EXT-X-BYTERANGE:10@0',
        'a.mp4',
        '#EXT-X-DISCONTINUITY',
        '#EXT-X-KEY:METHOD=NONE',
        '#EXTINF:4.5,',
        'b.m4s',
        '#EXT-X-GAP',
        '#EXTINF:4.004,',
        'c.m4s',
        '#EXT-X-ENDLIST',
      ].join('\n'),
      'https://cdn.test/index.m3u8',
    );
    expect(localMediaPlaylist(media, 'v').split('\n')).toEqual([
      '#EXTM3U',
      '#EXT-X-VERSION:6',
      '#EXT-X-TARGETDURATION:5',
      '#EXT-X-MEDIA-SEQUENCE:10',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-INDEPENDENT-SEGMENTS',
      '#EXT-X-KEY:METHOD=AES-128,URI="v-key-1.key",IV=0x01,KEYFORMAT="identity"',
      '#EXT-X-MAP:URI="v-init-1.mp4"',
      '#EXTINF:4.0,',
      'v-00001.m4s',
      '#EXT-X-DISCONTINUITY',
      '#EXT-X-KEY:METHOD=NONE',
      '#EXTINF:4.5,',
      'v-00002.m4s',
      '#EXT-X-GAP',
      '#EXTINF:4.004,',
      'v-00003.m4s',
      '#EXT-X-ENDLIST',
      '',
    ]);
  });

  it('write a master of the one variant, with its audio rendition when it is separate', () => {
    const v = { bandwidth: 2400000, averageBandwidth: 2000000, width: 1280, height: 720, codecs: 'avc1.4d401f,mp4a.40.2', frameRate: '23.976' };
    expect(localMaster(v, { ...rendition('ko', 'Korean'), channels: '2' }, true).split('\n')).toEqual([
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-INDEPENDENT-SEGMENTS',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Korean",LANGUAGE="ko",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="audio.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=2400000,AVERAGE-BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",FRAME-RATE=23.976,AUDIO="audio"',
      'video.m3u8',
      '',
    ]);
    expect(localMaster({ ...v, averageBandwidth: null, codecs: null, frameRate: null, width: null, height: null, bandwidth: 0 }, null, false)).toBe(
      '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvideo.m3u8\n',
    );
  });
});
