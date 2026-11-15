import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { firstSegment, firstVariant, isOriginalAudio, manifestAudioTracks, mp4AudioLanguages, probeAudio, tsAudioLanguages } from '../../../claude/streaming/direct/audio.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { languagesOf, normalizeLang } from '../../../claude/streaming/direct/lang.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { parseArgs } from '../../../claude/streaming/direct/cli.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { resolveTitle } from '../../../claude/streaming/direct/resolve.mjs';

type Json = Record<string, any>;

/** One 188-byte MPEG-TS packet carrying a section that starts in it. */
function tsPacket(pid: number, section: number[]): Buffer {
  const packet = Buffer.alloc(188, 0xff);
  packet[0] = 0x47;
  packet[1] = 0x40 | ((pid >> 8) & 0x1f);
  packet[2] = pid & 0xff;
  packet[3] = 0x10;
  packet[4] = 0x00; // pointer field
  Buffer.from(section).copy(packet, 5);
  return packet;
}

/** A segment start: a PAT naming the PMT on pid 0x1000, and a PMT with H.264 video and one AAC audio tagged `lang` (null: no tag). */
function tsSegment(lang: string | null): Buffer {
  const pat = [0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xf0, 0x00, 0, 0, 0, 0];
  const descriptor = lang === null ? [] : [0x0a, 0x04, ...Buffer.from(lang, 'latin1'), 0x00];
  const streams = [0x1b, 0xe1, 0x00, 0xf0, 0x00, 0x0f, 0xe1, 0x01, 0xf0, descriptor.length, ...descriptor];
  const length = 9 + streams.length + 4;
  const pmt = [0x02, 0xb0 | (length >> 8), length & 0xff, 0x00, 0x01, 0xc1, 0x00, 0x00, 0xe1, 0x00, 0xf0, 0x00, ...streams, 0, 0, 0, 0];
  return Buffer.concat([tsPacket(0, pat), tsPacket(0x1000, pmt), Buffer.alloc(188 * 2, 0xff)]);
}

function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

/** A `trak` with a media header in `lang` and a handler of `handler` (`soun`, `vide`). */
function trak(lang: string, handler: string): Buffer {
  const mdhd = Buffer.alloc(24);
  const [a, b, c] = [...lang].map((ch) => ch.charCodeAt(0) - 0x60);
  mdhd.writeUInt16BE(((a ?? 0) << 10) | ((b ?? 0) << 5) | (c ?? 0), 20);
  const hdlr = Buffer.alloc(12);
  hdlr.write(handler, 8, 'latin1');
  return box('trak', box('mdia', box('mdhd', mdhd), box('hdlr', hdlr)));
}

const MASTER = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=640x358', 'low/index.m3u8?t=1', '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080', 'high/index.m3u8?t=1'].join('\n');
const MEDIA = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXTINF:6.0,', 'https://seg.example/vod/segment0.ts?md5=x', '#EXTINF:4.0,', 'https://seg.example/vod/segment1.ts?md5=y'].join('\n');
const DUBBED_MASTER = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="a/en.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Korean",LANGUAGE="kor",DEFAULT=NO,URI="a/ko.m3u8"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="s/en.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,AUDIO="aud"',
  'v/index.m3u8',
].join('\n');

const found = (over: Json = {}): Json => ({
  manifest_url: 'https://cdn.example/hls/master.m3u8?token=abc',
  manifest_kind: 'hls',
  manifest_body: MASTER,
  headers: { referer: 'https://embed.example/', origin: 'https://embed.example', user_agent: 'UA/1' },
  ...over,
});

/** A fetch that answers by address; records every request. Unknown addresses answer 404. */
function fakeFetch(routes: Record<string, string | Buffer>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    const body = routes[url];
    return body === undefined ? new Response('no', { status: 404 }) : new Response(body);
  };
  return { fetchImpl: impl, calls };
}

describe('language tags', () => {
  it('brings 639-2 codes, region tags and names to the 639-1 code', () => {
    expect(['eng', 'en-US', 'English', 'EN', 'kor', 'Korean', 'jpn', 'fre', 'fra', 'Español (Latino)'].map(normalizeLang)).toEqual(['en', 'en', 'en', 'en', 'ko', 'ko', 'ja', 'fr', 'fr', 'es']);
    // TMDB writes Cantonese as "cn"; a stream writes chi, zho or yue. One family.
    expect(['cn', 'zh', 'chi', 'zho', 'yue', 'Mandarin'].map(normalizeLang)).toEqual(['zh', 'zh', 'zh', 'zh', 'zh', 'zh']);
  });

  it('reads a tag that names no language as none, and keeps an unknown code as it is', () => {
    expect(['und', '', null, 'Unknown', 'mul', 'Audio 1', 'default'].map(normalizeLang)).toEqual([null, null, null, null, null, null, null]);
    expect(normalizeLang('haw')).toBe('haw');
    expect(languagesOf(['eng', 'und', 'en', 'kor'])).toEqual(['en', 'ko']);
  });
});

describe('reading the audio language out of a stream', () => {
  it("reads an MPEG-TS segment's audio language from its programme table", () => {
    expect(tsAudioLanguages(tsSegment('eng'))).toEqual(['eng']);
    expect(tsAudioLanguages(tsSegment('kor'))).toEqual(['kor']);
    expect(tsAudioLanguages(tsSegment(null))).toEqual([]);
    expect(tsAudioLanguages(Buffer.from('not a transport stream'))).toEqual([]);
  });

  it('finds the programme table after bytes that are not a packet', () => {
    expect(tsAudioLanguages(Buffer.concat([Buffer.from([1, 2, 3]), tsSegment('jpn')]))).toEqual(['jpn']);
  });

  it("reads an MP4's sound tracks' languages and leaves the video track's out", () => {
    const init = Buffer.concat([box('ftyp', Buffer.from('iso5')), box('moov', trak('und', 'vide'), trak('kor', 'soun'), trak('eng', 'soun'))]);
    expect(mp4AudioLanguages(init)).toEqual(['kor', 'eng']);
    expect(mp4AudioLanguages(Buffer.alloc(40))).toEqual([]);
  });

  it("lists a manifest's audio tracks, HLS and DASH", () => {
    expect(manifestAudioTracks('hls', DUBBED_MASTER)).toEqual([{ lang: 'en', label: 'English' }, { lang: 'kor', label: 'Korean' }]);
    const mpd = '<MPD><Period><AdaptationSet contentType="audio" lang="ja"><Label>Japanese</Label></AdaptationSet><AdaptationSet mimeType="audio/mp4" lang="en"></AdaptationSet><AdaptationSet contentType="video"></AdaptationSet></Period></MPD>';
    expect(manifestAudioTracks('dash', mpd)).toEqual([{ lang: 'ja', label: 'Japanese' }, { lang: 'en', label: null }]);
    expect(manifestAudioTracks('mp4', '')).toEqual([]);
  });

  it('finds the first variant and the first segment, or the init segment when there is one', () => {
    expect(firstVariant(MASTER, 'https://cdn.example/hls/master.m3u8')).toBe('https://cdn.example/hls/low/index.m3u8?t=1');
    expect(firstVariant(MEDIA, 'https://cdn.example/hls/low/index.m3u8')).toBeNull();
    expect(firstSegment(MEDIA, 'https://cdn.example/hls/low/index.m3u8')).toBe('https://seg.example/vod/segment0.ts?md5=x');
    expect(firstSegment('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nseg1.m4s', 'https://cdn.example/v/index.m3u8')).toBe('https://cdn.example/v/init.mp4');
  });
});

describe('probeAudio', () => {
  it("answers from the manifest's audio tracks without a request", async () => {
    const f = fakeFetch({});
    const heard = await probeAudio(found({ manifest_body: DUBBED_MASTER }), f);
    expect(heard).toMatchObject({ languages: ['en', 'ko'], tracks: 2 });
    expect(heard.named[1]).toEqual({ lang: 'kor', label: 'Korean', language: 'ko' });
    expect(f.calls).toEqual([]);
  });

  it('asks a stream with one muxed audio through its first variant and first segment, with the captured headers', async () => {
    const f = fakeFetch({ 'https://cdn.example/hls/low/index.m3u8?t=1': MEDIA, 'https://seg.example/vod/segment0.ts?md5=x': tsSegment('eng') });
    expect(await probeAudio(found(), f)).toMatchObject({ languages: ['en'], tracks: 0 });
    expect(f.calls.map((c) => c.url)).toEqual(['https://cdn.example/hls/low/index.m3u8?t=1', 'https://seg.example/vod/segment0.ts?md5=x']);
    expect(f.calls[0]?.headers).toMatchObject({ referer: 'https://embed.example/', origin: 'https://embed.example', 'user-agent': 'UA/1' });
    expect(f.calls[1]?.headers.range).toMatch(/^bytes=0-/);
  });

  it('reads a fragmented-MP4 stream through its init segment, and a plain file through its start', async () => {
    const init = box('moov', trak('kor', 'soun'));
    const playlist = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nseg1.m4s';
    const hls = fakeFetch({ 'https://cdn.example/hls/low/index.m3u8?t=1': playlist, 'https://cdn.example/hls/low/init.mp4': init });
    expect((await probeAudio(found(), hls)).languages).toEqual(['ko']);
    const file = fakeFetch({ 'https://cdn.example/film.mp4': init });
    expect((await probeAudio(found({ manifest_url: 'https://cdn.example/film.mp4', manifest_kind: 'mp4', manifest_body: '' }), file)).languages).toEqual(['ko']);
  });

  it('answers no language, and never throws, when the stream cannot be read or says nothing', async () => {
    expect(await probeAudio(found(), fakeFetch({}))).toMatchObject({ languages: [], tracks: 0 });
    const untagged = fakeFetch({ 'https://cdn.example/hls/low/index.m3u8?t=1': MEDIA, 'https://seg.example/vod/segment0.ts?md5=x': tsSegment(null) });
    expect((await probeAudio(found(), untagged)).languages).toEqual([]);
    const failing = { fetchImpl: async () => { throw new Error('offline'); } };
    expect((await probeAudio(found(), failing)).languages).toEqual([]);
  });
});

describe('the original-language rule', () => {
  it('is true when the stream speaks the original, false for a dub, null when nothing says', () => {
    expect(isOriginalAudio(['en', 'ko'], 'ko')).toBe(true);
    expect(isOriginalAudio(['en'], 'ko')).toBe(false);
    expect(isOriginalAudio([], 'ko')).toBeNull();
    expect(isOriginalAudio(['en'], null)).toBeNull();
    expect(isOriginalAudio(['zh'], 'cn')).toBe(true);
  });
});

const provider = (name: string): Json => ({ name, id_kind: 'tmdb', movie: `https://${name.toLowerCase()}.example/movie/{id}`, tv: null, browser_only: false, en_subtitle: null, notes: '' });
const streamOf = (host: string, body = MASTER): Json => ({
  user_agent: 'UA/1', bot_check: false, requests: 9,
  hits: [{ url: `https://${host}/hls/master.m3u8`, referer: 'https://embed.example/', origin: null, user_agent: 'UA/1', status: 200, mime: 'application/vnd.apple.mpegurl', body }],
});
const MOVIE = { kind: 'movie', tmdbId: 550, season: null, episode: null };

describe('resolving with the original language', () => {
  const sniff = async (url: string): Promise<Json> => streamOf(`cdn-${new URL(url).hostname.split('.')[0]}.example`);
  /** What each stream host speaks. */
  const probe = (byHost: Record<string, string[]>) => async (source: Json) => ({ languages: byHost[new URL(source.manifest_url).hostname] ?? [], tracks: 0, named: [] });

  it('skips a dubbed stream as `dubbed` and keeps the first one in the original language', async () => {
    const result = await resolveTitle(MOVIE, {
      providers: [provider('Alpha'), provider('Beta'), provider('Gamma')],
      sniff,
      audioLang: 'ko',
      probeAudio: probe({ 'cdn-alpha.example': ['en'], 'cdn-beta.example': ['ko'] }),
    });
    expect(result.ok).toBe(true);
    expect(result.source).toMatchObject({ provider: 'Beta', audio: { languages: ['ko'], tracks: 0, original: true, track: null } });
    expect(result.attempts.map((a: Json) => [a.provider, a.outcome])).toEqual([['Alpha', 'dubbed'], ['Beta', 'resolved']]);
    expect(result.attempts[0].detail).toBe('audio is en, the original is ko');
  });

  it('keeps a stream whose language nothing names, and answers no_source when every stream is a dub', async () => {
    const unknown = await resolveTitle(MOVIE, { providers: [provider('Alpha')], sniff, audioLang: 'ko', probeAudio: probe({}) });
    expect(unknown.source).toMatchObject({ provider: 'Alpha', audio: { languages: [], original: null } });
    const dubs = await resolveTitle(MOVIE, { providers: [provider('Alpha'), provider('Beta')], sniff, audioLang: 'ko', probeAudio: probe({ 'cdn-alpha.example': ['en'], 'cdn-beta.example': ['es'] }) });
    expect(dubs).toMatchObject({ ok: false, error: 'no_source', source: null });
    expect(dubs.attempts.map((a: Json) => a.outcome)).toEqual(['dubbed', 'dubbed']);
  });

  it("names the manifest's original-language track for the player, and probes nothing without a language", async () => {
    const named = [{ lang: 'en', label: 'English', language: 'en' }, { lang: 'kor', label: 'Korean', language: 'ko' }];
    const multi = await resolveTitle(MOVIE, { providers: [provider('Alpha')], sniff, audioLang: 'ko', probeAudio: async () => ({ languages: ['en', 'ko'], tracks: 2, named }) });
    expect(multi.source.audio).toEqual({ languages: ['en', 'ko'], tracks: 2, original: true, track: { lang: 'kor', label: 'Korean' } });
    let probed = 0;
    const plain = await resolveTitle(MOVIE, { providers: [provider('Alpha')], sniff, probeAudio: async () => { probed += 1; return { languages: ['en'], tracks: 0, named: [] }; } });
    expect(plain.source.audio).toBeNull();
    expect(probed).toBe(0);
  });

  it("lends a dub's English subtitle file to the stream that is kept when it has none of its own", async () => {
    const withSub = (host: string): Json => {
      const c = streamOf(host);
      c.hits.push({ url: 'https://subs.example/tv/1/english.vtt', status: 200, mime: 'text/vtt' }, { url: 'https://subs.example/tv/1/spanish.vtt', status: 200, mime: 'text/vtt' });
      return c;
    };
    const lending = async (url: string): Promise<Json> => (new URL(url).hostname.startsWith('alpha') ? withSub('cdn-alpha.example') : streamOf('cdn-beta.example'));
    const result = await resolveTitle(MOVIE, { providers: [provider('Alpha'), provider('Beta')], sniff: lending, audioLang: 'ko', probeAudio: probe({ 'cdn-alpha.example': ['en'] }) });
    expect(result.source.provider).toBe('Beta');
    expect(result.source.subtitles).toEqual([{ url: 'https://subs.example/tv/1/english.vtt', lang: 'en', label: null, format: 'vtt', source: 'request', borrowed_from: 'Alpha' }]);
    // The provider's own: its health must not learn an English subtitle it does not have.
    expect(result.source.en_subtitle).toBe(false);
    expect(result.attempts[1].detail).toMatch(/English subtitle from Alpha$/);

    // A stream with its own English subtitle borrows nothing.
    const own = async (url: string): Promise<Json> => withSub(new URL(url).hostname.startsWith('alpha') ? 'cdn-alpha.example' : 'cdn-beta.example');
    const kept = await resolveTitle(MOVIE, { providers: [provider('Alpha'), provider('Beta')], sniff: own, audioLang: 'ko', probeAudio: probe({ 'cdn-alpha.example': ['en'] }) });
    expect(kept.source.subtitles.some((t: Json) => 'borrowed_from' in t)).toBe(false);
    expect(kept.source.en_subtitle).toBe(true);
  });

  it('takes --audio-lang as a language code', () => {
    expect(parseArgs(['resolve', 'tv', '293610', '1', '1', '--audio-lang', 'ko'])).toMatchObject({ audioLang: 'ko' });
    expect(parseArgs(['resolve', 'movie', '550', '--audio-lang', 'ENG'])).toMatchObject({ audioLang: 'en' });
    expect(parseArgs(['resolve', 'movie', '550'])).toMatchObject({ audioLang: null });
    expect(() => parseArgs(['resolve', 'movie', '550', '--audio-lang', 'und'])).toThrow(/language code/);
  });
});
