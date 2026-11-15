import { describe, expect, it } from 'vitest';
import { absoluteHttp, encodeTarget, proxiedUrl, rewriteDash, rewriteHls, srtToVtt } from '../../../src/directStream/rewrite.js';

const SID = 'abcdefghijklmnopqrstuvwxyz012345';
const P = (u: string): string => `/api/stream/sessions/${SID}/p?u=${encodeURIComponent(u)}`;

describe('proxiedUrl and encodeTarget', () => {
  it('round-trips an address through the u parameter', () => {
    const target = 'https://cdn.example/a b/master.m3u8?token=a%2Fb&x=1';
    const proxied = proxiedUrl(SID, target);
    expect(proxied.startsWith(`/api/stream/sessions/${SID}/p?u=`)).toBe(true);
    expect(new URL(proxied, 'http://localhost').searchParams.get('u')).toBe(target);
    expect(proxiedUrl(SID, target, { vtt: true }).endsWith('&vtt=1')).toBe(true);
  });

  it('keeps DASH template identifiers raw so the player can fill them in', () => {
    expect(encodeTarget('https://c.example/v/$RepresentationID$/seg-$Number%05d$.m4s?t=$Time$&s=$$')).toBe(
      `${encodeURIComponent('https://c.example/v/')}$RepresentationID$${encodeURIComponent('/seg-')}$Number%05d$${encodeURIComponent('.m4s?t=')}$Time$${encodeURIComponent('&s=')}$$`,
    );
    const filled = proxiedUrl(SID, 'https://c.example/v/$RepresentationID$/seg-$Number%05d$.m4s').replace('$RepresentationID$', 'v1').replace('$Number%05d$', '00007');
    expect(new URL(filled, 'http://localhost').searchParams.get('u')).toBe('https://c.example/v/v1/seg-00007.m4s');
  });

  it('accepts only http(s) addresses', () => {
    expect(absoluteHttp('seg.ts', 'https://c.example/a/b.m3u8')).toBe('https://c.example/a/seg.ts');
    expect(absoluteHttp('skd://key')).toBeNull();
    expect(absoluteHttp('file:///etc/passwd')).toBeNull();
    expect(absoluteHttp('not a url')).toBeNull();
  });
});

describe('rewriteHls', () => {
  it('rewrites address lines and URI attributes, keeps tags, blank lines and keys it cannot fetch', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key-1"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",URI="subs/en.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1',
      '720/index.m3u8',
      '',
      '#EXT-X-STREAM-INF:BANDWIDTH=2',
      'https://other.example/1080.m3u8?token=a%2Fb',
    ].join('\r\n');
    const r = rewriteHls(text, 'https://cdn.example/hls/master.m3u8', SID);
    expect(r.text.split('\n')).toEqual([
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key-1"',
      `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",URI="${P('https://cdn.example/hls/subs/en.m3u8')}"`,
      '#EXT-X-STREAM-INF:BANDWIDTH=1',
      P('https://cdn.example/hls/720/index.m3u8'),
      '',
      '#EXT-X-STREAM-INF:BANDWIDTH=2',
      P('https://other.example/1080.m3u8?token=a%2Fb'),
    ]);
    expect(r.urls).toEqual([
      'https://cdn.example/hls/subs/en.m3u8',
      'https://cdn.example/hls/720/index.m3u8',
      'https://other.example/1080.m3u8?token=a%2Fb',
    ]);
  });

  it('rewrites a media playlist: map, segments by relative and absolute path', () => {
    const text = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4.0,\nseg1.ts\n#EXTINF:4.0,\n/hls/720/seg2.ts\n#EXT-X-ENDLIST\n';
    const r = rewriteHls(text, 'https://cdn.example/hls/720/index.m3u8', SID);
    expect(r.text).toBe(
      `#EXTM3U\n#EXT-X-MAP:URI="${P('https://cdn.example/hls/720/init.mp4')}"\n#EXTINF:4.0,\n${P('https://cdn.example/hls/720/seg1.ts')}\n#EXTINF:4.0,\n${P('https://cdn.example/hls/720/seg2.ts')}\n#EXT-X-ENDLIST\n`,
    );
  });
});

describe('rewriteDash', () => {
  const MPD = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">',
    '  <BaseURL>https://cdn2.example/dash/</BaseURL>',
    '  <Period id="1">',
    '    <AdaptationSet mimeType="video/mp4">',
    '      <SegmentTemplate timescale="1000" duration="4000" media="$RepresentationID$/seg-$Number%05d$.m4s" initialization="$RepresentationID$/init.mp4"/>',
    '      <Representation id="v720" bandwidth="800000"/>',
    '    </AdaptationSet>',
    '    <AdaptationSet mimeType="audio/mp4">',
    '      <Representation id="a1" bandwidth="128000">',
    '        <BaseURL>audio/a1.mp4</BaseURL>',
    '        <SegmentBase indexRange="0-99"><Initialization range="0-49"/></SegmentBase>',
    '      </Representation>',
    '    </AdaptationSet>',
    '  </Period>',
    '</MPD>',
  ].join('\n');

  it('rewrites BaseURLs against their parent base and templates with their fields intact', () => {
    const r = rewriteDash(MPD, 'https://cdn.example/x/manifest.mpd', SID);
    expect(r.text).toContain(`<BaseURL>${P('https://cdn2.example/dash/')}</BaseURL>`);
    expect(r.text).toContain(`<BaseURL>${P('https://cdn2.example/dash/audio/a1.mp4')}</BaseURL>`);
    const prefix = `/api/stream/sessions/${SID}/p?u=`;
    expect(r.text).toContain(
      `media="${prefix}${encodeURIComponent('https://cdn2.example/dash/')}$RepresentationID$${encodeURIComponent('/seg-')}$Number%05d$${encodeURIComponent('.m4s')}"`,
    );
    expect(r.text).toContain(`initialization="${prefix}${encodeURIComponent('https://cdn2.example/dash/')}$RepresentationID$${encodeURIComponent('/init.mp4')}"`);
    expect(r.text).toContain('<SegmentBase indexRange="0-99"><Initialization range="0-49"/></SegmentBase>');
    expect(r.text).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(r.text).not.toContain('https://');
    expect(r.urls.map((u) => new URL(u).host)).toEqual(['cdn2.example', 'cdn2.example', 'cdn2.example', 'cdn2.example']);
  });

  it('leaves a non-http xlink:href alone', () => {
    const text = '<MPD><Period xlink:href="urn:mpeg:dash:resolve-to-zero:2013"/></MPD>';
    expect(rewriteDash(text, 'https://cdn.example/m.mpd', SID).text).toBe(text);
  });
});

describe('srtToVtt', () => {
  it('turns SubRip into WebVTT and leaves WebVTT alone', () => {
    expect(srtToVtt('﻿1\r\n00:00:01,000 --> 00:00:03,500\r\nHello.\r\n')).toBe('WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.500\nHello.\n');
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHi.\n';
    expect(srtToVtt(vtt)).toBe(vtt);
  });
});
