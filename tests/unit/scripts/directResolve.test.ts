import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { ChromeError } from '../../../claude/streaming/chrome.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { ANIME_SEED_PATH, main, openInChrome, parseArgs, readHealth, readProviders, SEED_PATH, SITE_HOSTS, START_EXPRESSION, wantsStart } from '../../../claude/streaming/direct/cli.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { orderProviders } from '../../../claude/streaming/direct/order.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { embedUrl, indexSubtitles, pickSource, resolveTitle, seriesPlayerFrame } from '../../../claude/streaming/direct/resolve.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { MEDIA_EXPRESSION, MUTE_SCRIPT, parseSniffReply } from '../../../claude/streaming/direct/sniff.mjs';

type Json = Record<string, any>;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const MASTER = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="subs/en.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480,SUBTITLES="subs"',
  '480/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=3840x2160,SUBTITLES="subs"',
  '2160/index.m3u8',
].join('\n');
const MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">
 <Period>
  <AdaptationSet contentType="video" mimeType="video/mp4" maxHeight="1080">
   <Representation id="v480" bandwidth="900000" width="854" height="480"/>
   <Representation id="v1080" bandwidth="5000000" width="1920" height="1080"/>
  </AdaptationSet>
  <AdaptationSet contentType="text" mimeType="text/vtt" lang="en">
   <Label>English</Label>
   <Representation id="sub-en" bandwidth="256"><BaseURL>subs/en.vtt</BaseURL></Representation>
  </AdaptationSet>
 </Period>
</MPD>`;

const hit = (over: Json): Json => ({ at_s: 2, type: 'XHR', url: '', referer: 'https://vidfast.vc/', origin: 'https://vidfast.vc', user_agent: UA, document: null, status: 200, mime: null, body: null, ...over });
const capture = (over: Json = {}): Json => ({
  url: '', took_s: 2.3, user_agent: UA, bot_check: false, bot_check_reason: null, requests: 40, clicks: 0, popups_closed: 0, tabs_left_open: 0,
  frames: [], hosts: [], media: { elements: 1, audible: 0 }, hits: [], ...over,
});
const streamCapture = (over: Json = {}): Json =>
  capture({
    hits: [
      hit({ url: 'https://cdn.example/hls/master.m3u8?token=abc', mime: 'application/vnd.apple.mpegurl', body: MASTER }),
      hit({ at_s: 2.4, url: 'https://cdn.example/hls/2160/index.m3u8?token=abc', mime: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n#EXTINF:6,\nseg0.ts' }),
      hit({ at_s: 2.6, url: 'https://cdn.example/hls/subs/seg-0.vtt', mime: 'text/vtt' }),
    ],
    ...over,
  });
const botCapture = (): Json => capture({ requests: 6, bot_check: true, bot_check_reason: 'title Just a moment...' });

const provider = (name: string, over: Json = {}): Json => ({
  name, id_kind: 'tmdb', movie: `https://${name.toLowerCase()}.example/movie/{id}`, tv: null, browser_only: false, en_subtitle: null, notes: '', ...over,
});
const names = (list: Json[]): string[] => list.map((p) => p.name);

/** A sniffer that answers by the embed's host name; anything unknown loaded no stream. */
function fakeSniffer(byHost: Record<string, Json | Error>) {
  const calls: Array<{ url: string; options: unknown }> = [];
  const sniff = async (url: string, options: unknown): Promise<Json> => {
    calls.push({ url, options });
    const answer = byHost[new URL(url).hostname];
    if (answer instanceof Error) throw answer;
    return answer ?? capture();
  };
  return { sniff, calls };
}

const MOVIE = { kind: 'movie', tmdbId: 550, season: null, episode: null };

describe('the provider seed', () => {
  const seed: Json[] = readProviders(readFileSync(SEED_PATH, 'utf8'));

  it('holds the ten fmovies providers that still give a stream, with the learned fields in their shapes', () => {
    expect(names(seed)).toEqual(['VidNest', 'Smashy', 'VidUp', 'VidFast', 'VidLink', 'VidRock', 'Movies111', 'HyperLink', 'NexaStream', 'MovieVault']);
    for (const p of seed) {
      expect(p.movie).toMatch(/^https:\/\/[^/]+\/.*\{id\}/);
      // The values of tv, browser_only, en_subtitle and notes were measured by hand.
      expect(p.id_kind).toBe('tmdb');
      if (p.tv !== null) expect(p.tv).toMatch(/^https:\/\/[^/]+\/.*\{id\}.*\{season\}.*\{episode\}/);
      expect(typeof p.browser_only).toBe('boolean');
      expect([true, false, null]).toContain(p.en_subtitle);
      expect(typeof p.notes).toBe('string');
    }
  });

  it('fills a template with the TMDB id, and has no address for an episode without a tv template', () => {
    const byName = Object.fromEntries(seed.map((p) => [p.name, p]));
    expect(embedUrl(byName.VidFast, MOVIE)).toBe('https://vidfast.pro/movie/550?autoPlay=true');
    expect(embedUrl(byName.Movies111, MOVIE)).toBe('https://player.vidmario.net/embed/movie/550?autoplay=true');
    expect(embedUrl({ ...byName.VidFast, tv: null }, { kind: 'tv', tmdbId: 1399, season: 1, episode: 2 })).toBeNull();
    const withTv = provider('Beta', { tv: 'https://beta.example/tv/{id}/{season}/{episode}' });
    expect(embedUrl(withTv, { kind: 'tv', tmdbId: 1399, season: 1, episode: 2 })).toBe('https://beta.example/tv/1399/1/2');
  });
});

describe('reading providers and health', () => {
  const bad = (entries: Json[]): (() => unknown) => () => readProviders(JSON.stringify(entries));

  it('refuses a providers file it cannot trust', () => {
    expect(bad([provider('A'), provider('a')])).toThrow(/used twice/);
    expect(bad([provider('A', { movie: 'https://a.example/movie' })])).toThrow(/\{id\}/);
    expect(bad([provider('A', { tv: 'https://a.example/tv/{id}/{season}' })])).toThrow(/tv must be/);
    expect(bad([provider('A', { id_kind: 'imdb' })])).toThrow(/id_kind/);
    expect(bad([provider('A', { en_subtitle: 'yes' })])).toThrow(/en_subtitle/);
    expect(() => readProviders('[]')).toThrow(/non-empty/);
  });

  it('accepts registry rows with extra fields and drops them', () => {
    const [row] = readProviders(JSON.stringify([provider('A', { origin_site: 'https://ww6-fmovies.com', added_at: '2026-11-15' })]));
    expect(Object.keys(row)).toEqual(['name', 'id_kind', 'movie', 'tv', 'browser_only', 'en_subtitle', 'notes']);
  });

  it('fills what a health entry leaves out, and refuses a list', () => {
    expect(readHealth('{"VidFast":{"en_subtitle":true}}')).toEqual({
      VidFast: { en_subtitle: true, best_height: null, median_s: null, last_success_at: null, last_failure_at: null, consecutive_failures: 0, last_outcome: null, last_detail: null, delivery: null },
    });
    expect(() => readHealth('[]')).toThrow(/keyed by provider name/);
    expect(() => readHealth('{"A":{"best_height":"tall"}}')).toThrow(/best_height/);
  });
});

describe('the order providers are tried in (R1.2)', () => {
  it('puts a known English subtitle first, unknown next, known none last', () => {
    const list = [provider('A'), provider('B', { en_subtitle: false }), provider('C', { en_subtitle: true }), provider('D')];
    expect(names(orderProviders(list, {}))).toEqual(['C', 'A', 'D', 'B']);
  });

  it('tries the provider put first before every other, while it keeps working', () => {
    const list = [provider('A', { en_subtitle: true }), provider('cinemaos.live', { en_subtitle: false }), provider('C', { en_subtitle: true })];
    expect(names(orderProviders(list, {}, { first: 'Cinemaos.Live' }))).toEqual(['cinemaos.live', 'A', 'C']);
    expect(names(orderProviders(list, {}, { first: 'nobody' }))).toEqual(['A', 'C', 'cinemaos.live']);
    // Two failures in a row keep the place; three, or a bad delivery, lose it until it works again.
    const failing = (n: number) => readHealth(JSON.stringify({ 'cinemaos.live': { last_success_at: '2026-11-18T10:00:00Z', consecutive_failures: n } }));
    expect(names(orderProviders(list, failing(2), { first: 'cinemaos.live' }))[0]).toBe('cinemaos.live');
    expect(names(orderProviders(list, failing(3), { first: 'cinemaos.live' }))).toEqual(['A', 'C', 'cinemaos.live']);
    expect(names(orderProviders(list, { 'cinemaos.live': { delivery: 'bad' } }, { first: 'cinemaos.live' }))).toEqual(['A', 'C', 'cinemaos.live']);
  });

  it('ranks by English subtitle before health', () => {
    const health = readHealth(JSON.stringify({ E1: { consecutive_failures: 3 }, E2: { last_success_at: '2026-11-15T10:00:00Z', best_height: 2160 } }));
    expect(names(orderProviders([provider('E2', { en_subtitle: false }), provider('E1', { en_subtitle: true })], health))).toEqual(['E1', 'E2']);
  });

  it('ranks by health before quality, then quality, then list order', () => {
    const list = [provider('P1', { en_subtitle: true }), provider('P2', { en_subtitle: true }), provider('P3', { en_subtitle: true }), provider('P4', { en_subtitle: true })];
    const health = readHealth(
      JSON.stringify({
        P1: { consecutive_failures: 2, best_height: 4320 },
        P2: { last_success_at: '2026-11-15T10:00:00Z', best_height: 720 },
        P3: { last_success_at: '2026-11-15T10:00:00Z', best_height: 2160 },
      }),
    );
    expect(names(orderProviders(list, health))).toEqual(['P3', 'P2', 'P4', 'P1']);
    expect(names(orderProviders([provider('X'), provider('Y')], {}))).toEqual(['X', 'Y']);
  });

  it('puts a provider whose last play here kept stalling after the ones that delivered, whatever its health', () => {
    const list = [provider('Laggy', { en_subtitle: true }), provider('Fresh', { en_subtitle: true }), provider('Failing', { en_subtitle: true }), provider('NoSub', { en_subtitle: false })];
    const health = readHealth(
      JSON.stringify({
        Laggy: { last_success_at: '2026-11-15T10:00:00Z', best_height: 2160, delivery: 'bad' },
        Failing: { consecutive_failures: 4 },
        NoSub: { last_success_at: '2026-11-15T10:00:00Z', delivery: 'good' },
      }),
    );
    // An English subtitle still comes first: Laggy stays ahead of a provider known to have none.
    expect(names(orderProviders(list, health))).toEqual(['Fresh', 'Failing', 'Laggy', 'NoSub']);
    expect(readHealth('{"A":{"delivery":"bad"},"B":{"delivery":"slow"},"C":{}}')).toMatchObject({ A: { delivery: 'bad' }, B: { delivery: null }, C: { delivery: null } });
  });

  it('tries a provider that never gave a stream here after every other, and keeps a seed\'s English subtitle over one title without', () => {
    const list = [provider('Dead', { en_subtitle: true }), provider('Failing', { en_subtitle: true }), provider('NoSub', { en_subtitle: false }), provider('Seeded', { en_subtitle: true })];
    const health = readHealth(
      JSON.stringify({
        Dead: { consecutive_failures: 5 },
        // It failed five times too, but it has worked here: not dead.
        Failing: { consecutive_failures: 5, last_success_at: '2026-11-10T10:00:00Z' },
        NoSub: { last_success_at: '2026-11-15T10:00:00Z' },
        // The last title it resolved had no subtitle; the seed still says it offers them.
        Seeded: { last_success_at: '2026-11-15T10:00:00Z', en_subtitle: false },
      }),
    );
    expect(names(orderProviders(list, health))).toEqual(['Seeded', 'Failing', 'NoSub', 'Dead']);
  });

  it('lets what this host measured override the seed', () => {
    const health = readHealth('{"Late":{"en_subtitle":true}}');
    expect(names(orderProviders([provider('Early'), provider('Late', { en_subtitle: false })], health))).toEqual(['Late', 'Early']);
  });
});

describe('picking the stream out of a capture', () => {
  it('takes the HLS master with its headers, best height and in-manifest English track', () => {
    const found = pickSource(streamCapture());
    expect(found).toEqual({
      manifest_url: 'https://cdn.example/hls/master.m3u8?token=abc',
      manifest_kind: 'hls',
      headers: { referer: 'https://vidfast.vc/', origin: 'https://vidfast.vc', user_agent: UA },
      subtitles: [{ url: 'https://cdn.example/hls/subs/en.m3u8', lang: 'en', label: 'English', format: 'hls', source: 'manifest' }],
      best_height: 2160,
      en_subtitle: true,
    });
  });

  it("falls back to the tab's user agent and keeps a missing header null", () => {
    const found = pickSource(capture({ hits: [hit({ url: 'https://cdn.example/a.m3u8', origin: null, user_agent: null, body: MASTER })] }));
    expect(found.headers).toEqual({ referer: 'https://vidfast.vc/', origin: null, user_agent: UA });
  });

  it('reads a playlist behind an address that does not look like one', () => {
    const found = pickSource(capture({ hits: [hit({ url: 'https://vidnest.example/v/master.txt', mime: 'text/plain', body: MASTER })] }));
    expect(found.manifest_kind).toBe('hls');
    expect(found.best_height).toBe(2160);
  });

  it('takes a DASH manifest with its text track and a separate .srt request', () => {
    const found = pickSource(
      capture({
        hits: [
          hit({ url: 'https://dash.example/v/manifest.mpd', mime: 'application/dash+xml', body: MPD }),
          hit({ at_s: 3, url: 'https://subs.example/fight-club/English.srt', mime: 'application/x-subrip' }),
        ],
      }),
    );
    expect(found.manifest_kind).toBe('dash');
    expect(found.best_height).toBe(1080);
    expect(found.subtitles).toEqual([
      { url: 'https://dash.example/v/subs/en.vtt', lang: 'en', label: 'English', format: 'vtt', source: 'manifest' },
      { url: 'https://subs.example/fight-club/English.srt', lang: 'en', label: null, format: 'srt', source: 'request' },
    ]);
    expect(found.en_subtitle).toBe(true);
  });

  it("leaves out a player's seek-preview file: its cues are picture addresses, not words", () => {
    const found = pickSource(
      capture({
        hits: [
          hit({ url: 'https://cdn.example/vd/abc/index.m3u8', mime: 'application/vnd.apple.mpegurl', body: MASTER }),
          hit({ at_s: 3, url: 'https://cdn.example/vd/abc/thumbs/thumbs.vtt', mime: 'text/vtt' }),
          hit({ at_s: 3, url: 'https://cdn.example/vd/abc/preview.vtt', mime: 'text/vtt', body: 'WEBVTT\n\n00:00.000 --> 00:10.000\nthumbs/sprite-001.jpg#xywh=160,0,160,90\n' }),
          hit({ at_s: 3, url: 'https://subs.example/the-fix/English.vtt', mime: 'text/vtt' }),
        ],
      }),
    );
    expect(found.subtitles.filter((t: Json) => t.source === 'request').map((t: Json) => t.url)).toEqual(['https://subs.example/the-fix/English.vtt']);
  });

  it('finds no stream in refused requests or an empty capture', () => {
    expect(pickSource(capture({ hits: [hit({ url: 'https://cdn.example/master.m3u8', status: 403, body: MASTER })] }))).toBeNull();
    expect(pickSource(capture())).toBeNull();
  });

  it('does not take a page for a stream because its address ends in .mp4', () => {
    const page = hit({ url: 'https://vidrock.net/demo-video.mp4', mime: 'text/html; charset=utf-8' });
    expect(pickSource(capture({ hits: [page] }))).toBeNull();
    expect(pickSource(capture({ hits: [{ ...page, mime: 'video/mp4' }] }))?.manifest_kind).toBe('mp4');
    // A playlist is known by its body, whatever the host calls it.
    expect(pickSource(capture({ hits: [hit({ url: 'https://cdn.example/master.m3u8', mime: 'text/html', body: MASTER })] }))?.manifest_kind).toBe('hls');
  });
});

describe('1080p by default on the cloud side', () => {
  const master = (height: number): string =>
    ['#EXTM3U', '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="subs/en.m3u8"', `#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x${height},SUBTITLES="subs"`, `${height}/index.m3u8`].join('\n');
  const tall = (height: number): Json => capture({ hits: [hit({ url: `https://cdn.example/hls/${height}/master.m3u8?token=abc`, mime: 'application/vnd.apple.mpegurl', body: master(height) })] });
  const TALL_BEFORE = { best_height: 1080, last_success_at: '2026-11-19T10:00:00Z', median_s: 6, consecutive_failures: 0, successes: 5, failures: 0 };

  it('holds a 720p stream and plays the 1080p of a provider that gave one before', async () => {
    const { sniff } = fakeSniffer({ 'alpha.example': tall(720), 'beta.example': tall(1080) });
    const result = await resolveTitle(MOVIE, { providers: [provider('Alpha'), provider('Beta')], sniff, first: 'Alpha', health: { Beta: TALL_BEFORE } });
    expect(result.source.provider).toBe('Beta');
    expect(result.source.best_height).toBe(1080);
    expect(result.attempts[0].detail).toMatch(/held: 720p, asking Beta for 1080p/);
  });

  it('plays the held 720p when the taller provider has only a short stream too', async () => {
    const { sniff } = fakeSniffer({ 'alpha.example': tall(720), 'beta.example': tall(720) });
    const result = await resolveTitle(MOVIE, { providers: [provider('Alpha'), provider('Beta')], sniff, first: 'Alpha', health: { Beta: TALL_BEFORE } });
    expect(result.source.provider).toBe('Alpha');
    expect(result.attempts.map((a: Json) => a.provider)).toEqual(['Alpha', 'Beta']);
  });

  it('plays a 720p at once when no provider after it gave this machine a 1080p stream', async () => {
    const { sniff, calls } = fakeSniffer({ 'alpha.example': tall(720), 'beta.example': tall(1080) });
    const result = await resolveTitle(MOVIE, { providers: [provider('Alpha'), provider('Beta')], sniff });
    expect(result.source.provider).toBe('Alpha');
    expect(calls).toHaveLength(1);
  });
});

describe('resolving a title (R1.1, R1.3)', () => {
  it('skips a provider that answers with a bot check, records it, and tries the next with the same client', async () => {
    const { sniff, calls } = fakeSniffer({ 'alpha.example': botCapture(), 'beta.example': streamCapture() });
    const result = await resolveTitle(MOVIE, { providers: [provider('Alpha'), provider('Beta')], sniff });
    expect(result.ok).toBe(true);
    expect(result.source.provider).toBe('Beta');
    expect(result.attempts.map((a: Json) => [a.provider, a.outcome])).toEqual([
      ['Alpha', 'bot_check'],
      ['Beta', 'resolved'],
    ]);
    expect(result.attempts[0].detail).toBe('title Just a moment...');
    expect(calls.map((c) => c.url)).toEqual(['https://alpha.example/movie/550', 'https://beta.example/movie/550']);
    expect(calls[1]?.options).toBe(calls[0]?.options);
  });

  it('keeps a stream the real Chrome reached even when a check was seen on the way', async () => {
    const { sniff } = fakeSniffer({ 'alpha.example': streamCapture({ bot_check: true, bot_check_reason: 'frame challenges.cloudflare.com' }) });
    const result = await resolveTitle(MOVIE, { providers: [provider('Alpha')], sniff });
    expect(result.attempts.map((a: Json) => a.outcome)).toEqual(['resolved']);
  });

  it('answers no_source with every provider and its outcome when nothing resolves', async () => {
    const { sniff, calls } = fakeSniffer({ 'beta.example': botCapture(), 'delta.example': new Error('boom') });
    const providers = [provider('Alpha'), provider('Beta'), provider('Gamma', { browser_only: true }), provider('Delta')];
    const result = await resolveTitle(MOVIE, { providers, sniff });
    expect(result).toMatchObject({ ok: false, kind: 'movie', tmdb_id: 550, source: null, error: 'no_source' });
    expect(result.attempts.map((a: Json) => [a.provider, a.outcome])).toEqual([
      ['Alpha', 'no_stream'],
      ['Beta', 'bot_check'],
      ['Gamma', 'skipped_browser_only'],
      ['Delta', 'error'],
    ]);
    expect(calls.map((c) => new URL(c.url).hostname)).not.toContain('gamma.example');
  });

  it('stops at once when Chrome cannot be started', async () => {
    const { sniff, calls } = fakeSniffer({ 'alpha.example': new ChromeError('no_chrome', 'chrome.exe was not found'), 'beta.example': streamCapture() });
    const result = await resolveTitle(MOVIE, { providers: [provider('Alpha'), provider('Beta')], sniff });
    expect(result).toMatchObject({ ok: false, error: 'no_chrome', source: null });
    expect(calls).toHaveLength(1);
  });

  it('asks only providers with an episode template for an episode', async () => {
    const { sniff, calls } = fakeSniffer({ 'beta.example': streamCapture() });
    const providers = [provider('Alpha'), provider('Beta', { tv: 'https://beta.example/tv/{id}/{season}/{episode}' })];
    const result = await resolveTitle({ kind: 'tv', tmdbId: 1399, season: 1, episode: 2 }, { providers, sniff });
    expect(result).toMatchObject({ ok: true, kind: 'tv', tmdb_id: 1399, season: 1, episode: 2 });
    expect(result.attempts.map((a: Json) => a.outcome)).toEqual(['skipped_no_template', 'resolved']);
    expect(calls.map((c) => c.url)).toEqual(['https://beta.example/tv/1399/1/2']);
  });

  it('tries only the named provider with --only, and says so when there is none', async () => {
    const { sniff, calls } = fakeSniffer({ 'beta.example': streamCapture() });
    const one = await resolveTitle(MOVIE, { providers: [provider('Alpha'), provider('Beta')], sniff, only: 'beta' });
    expect(calls.map((c) => c.url)).toEqual(['https://beta.example/movie/550']);
    expect(one.source.provider).toBe('Beta');
    const none = await resolveTitle(MOVIE, { providers: [provider('Alpha')], sniff, only: 'Zeta' });
    expect(none).toMatchObject({ ok: false, error: 'unknown_provider', attempts: [] });
  });

  it('never tries a provider named by --skip', async () => {
    const { sniff, calls } = fakeSniffer({ 'alpha.example': streamCapture(), 'beta.example': streamCapture() });
    const other = await resolveTitle(MOVIE, { providers: [provider('Alpha'), provider('Beta')], sniff, skip: ['alpha'] });
    expect(calls.map((c) => c.url)).toEqual(['https://beta.example/movie/550']);
    expect(other.source.provider).toBe('Beta');
    expect(other.attempts.map((a: Json) => a.provider)).toEqual(['Beta']);
    const none = await resolveTitle(MOVIE, { providers: [provider('Alpha'), provider('Beta')], sniff, skip: ['Alpha', 'Beta'] });
    expect(none).toMatchObject({ ok: false, error: 'no_source', attempts: [] });
    expect(parseArgs(['resolve', 'movie', '550', '--skip', 'Alpha, Beta'])).toMatchObject({ skip: ['Alpha', 'Beta'] });
    expect(parseArgs(['resolve', 'movie', '550'])).toMatchObject({ skip: [] });
  });

  it('tries no further provider once its deadline has passed, and says deadline, not no_source', async () => {
    const { sniff, calls } = fakeSniffer({ 'gamma.example': streamCapture() });
    let now = 0;
    const slowSniff = async (url: string, options: Json) => {
      now += 20_000;
      return sniff(url, options);
    };
    const providers = [provider('Alpha'), provider('Beta'), provider('Gamma')];
    const result = await resolveTitle(MOVIE, { providers, sniff: slowSniff, clock: () => now, deadlineS: 30 });
    expect(result).toMatchObject({ ok: false, error: 'deadline', source: null });
    expect(result.attempts.map((a: Json) => [a.provider, a.outcome])).toEqual([
      ['Alpha', 'no_stream'],
      ['Beta', 'no_stream'],
    ]);
    expect(calls.map((c) => new URL(c.url).hostname)).toEqual(['alpha.example', 'beta.example']);
    expect(parseArgs(['resolve', 'movie', '550', '--deadline-s', '30'])).toMatchObject({ deadlineS: 30 });
    expect(parseArgs(['resolve', 'movie', '550'])).toMatchObject({ deadlineS: null });
    expect(() => parseArgs(['resolve', 'movie', '550', '--deadline-s', '0'])).toThrow(/whole number of seconds/);
  });
});

describe('the command', () => {
  // The seed as phase 1 wrote it: the order these tests expect must not move with what was measured since.
  const unlearned = (file: string): string => {
    const text = readFileSync(file, 'utf8');
    if (file !== SEED_PATH) return text;
    return JSON.stringify(JSON.parse(text).map((p: Json) => ({ ...p, tv: null, browser_only: false, en_subtitle: null, notes: '' })));
  };
  const run = async (argv: string[], io: Json = {}): Promise<{ code: number; printed: Json[] }> => {
    const printed: Json[] = [];
    const code = await main(argv, { print: (value: Json) => printed.push(value), readText: unlearned, ...io });
    return { code, printed };
  };

  it('resolve prints one JSON object naming the provider, the manifest, its headers and the subtitles (R1.1)', async () => {
    const { sniff } = fakeSniffer({ 'vidfast.pro': streamCapture() });
    const { code, printed } = await run(['resolve', 'movie', '550'], { sniff });
    expect(code).toBe(0);
    expect(printed).toHaveLength(1);
    const out = printed[0] as Json;
    expect(Object.keys(out)).toEqual(['ok', 'kind', 'tmdb_id', 'season', 'episode', 'source', 'attempts']);
    expect(Object.keys(out.source)).toEqual(['provider', 'embed_url', 'manifest_url', 'manifest_kind', 'headers', 'subtitles', 'best_height', 'en_subtitle', 'audio', 'took_s']);
    expect(out).toMatchObject({
      ok: true,
      kind: 'movie',
      tmdb_id: 550,
      season: null,
      episode: null,
      source: {
        provider: 'VidFast',
        embed_url: 'https://vidfast.pro/movie/550?autoPlay=true',
        manifest_url: 'https://cdn.example/hls/master.m3u8?token=abc',
        manifest_kind: 'hls',
        headers: { referer: 'https://vidfast.vc/', origin: 'https://vidfast.vc', user_agent: UA },
        subtitles: [{ lang: 'en', format: 'hls', source: 'manifest' }],
        best_height: 2160,
        en_subtitle: true,
      },
    });
    expect(out.attempts).toHaveLength(4);
    expect(out.attempts.slice(0, 3).every((a: Json) => a.outcome === 'no_stream')).toBe(true);
    expect(typeof out.source.took_s).toBe('number');
  });

  it('resolve exits 1 with no_source and every attempt when nothing resolves', async () => {
    const { sniff } = fakeSniffer({});
    const { code, printed } = await run(['resolve', 'movie', '550'], { sniff });
    expect(code).toBe(1);
    expect(printed[0]).toMatchObject({ ok: false, error: 'no_source', source: null });
    expect(printed[0]?.attempts).toHaveLength(10);
  });

  it('providers prints the order resolve would try, with what this host measured (R1.2)', async () => {
    const HEALTH = JSON.stringify({
      VidNest: { en_subtitle: false },
      VidLink: { en_subtitle: true, best_height: 1080, consecutive_failures: 0, last_success_at: '2026-11-15T10:00:00Z' },
      VidFast: { en_subtitle: true, best_height: 2160, consecutive_failures: 0, last_success_at: '2026-11-15T10:00:00Z' },
      Smashy: { en_subtitle: true, consecutive_failures: 3 },
    });
    const readText = (file: string): string => (file === 'health.json' ? HEALTH : unlearned(file));
    const { code, printed } = await run(['providers', '--health', 'health.json'], { readText });
    expect(code).toBe(0);
    const order = names(printed[0]?.providers);
    expect(order.slice(0, 4)).toEqual(['VidFast', 'VidLink', 'Smashy', 'VidUp']);
    expect(order.at(-1)).toBe('VidNest');
    expect(printed[0]?.providers[0].health).toMatchObject({ best_height: 2160 });
  });

  it('refuses bad input with exit 2 and says why', async () => {
    for (const argv of [['resolve', 'film', '550'], ['resolve', 'tv', '1399'], ['resolve', 'movie', '550', '1', '1'], ['resolve', 'movie', '550', '--fast'], ['open', 'https://example.com/'], ['providers', '--only', 'x'], []]) {
      const { code, printed } = await run(argv);
      expect(code, argv.join(' ')).toBe(2);
      expect(printed[0]).toMatchObject({ ok: false, error: 'usage' });
    }
    const { code, printed } = await run(['providers', '--providers', 'p.json'], { readText: () => '[{"name":"A"}]' });
    expect(code).toBe(2);
    expect(printed[0]).toMatchObject({ ok: false, error: 'bad_providers' });
  });

  it('open hands a daemon page to Chrome, full screen when asked', async () => {
    const opened: unknown[] = [];
    const open = async (url: string, options: Json): Promise<Json> => {
      opened.push([url, options]);
      return { ok: true, url, fullscreen: options.fullscreen };
    };
    const { code } = await run(['open', 'http://localhost:7317/stream/abc', '--fullscreen'], { open });
    expect(code).toBe(0);
    expect(opened).toEqual([['http://localhost:7317/stream/abc', { fullscreen: true }]]);
    expect(parseArgs(['open', 'http://127.0.0.1:7317/x'])).toEqual({ command: 'open', url: 'http://127.0.0.1:7317/x', fullscreen: false });
  });

  it("a full-screen open leaves full screen to the page, and makes the window full screen only when the page did not take it", async () => {
    const run = async (answer: string) => {
      const asked: Array<[string, Json]> = [];
      const evaluate = async (_origin: string, expression: string, options: Json): Promise<unknown> => {
        asked.push([expression, options]);
        return expression === START_EXPRESSION ? answer : 'ok';
      };
      const result = await openInChrome('http://localhost:7317/stream/abc', { fullscreen: true }, { evaluate, wait: async () => {} });
      return { result, asked };
    };
    // The page went full screen itself: the window is never made full screen (F11's kind, which a double click cannot leave).
    const own = await run('started');
    expect(own.result).toMatchObject({ ok: true, started: true });
    // A film that starts with sound closes the streaming sites' tabs first: their film would go on playing behind it.
    expect(own.asked.map((a) => a[1])).toEqual([{ show: true, windowState: 'normal', closeHosts: SITE_HOSTS }, {}]);
    // The film started but Chrome did not give the page the screen: the window takes it.
    const windowed = await run('windowed');
    expect(windowed.result).toMatchObject({ ok: true, started: true });
    expect(windowed.asked.at(-1)).toEqual(["'ok'", { show: true, windowState: 'fullscreen' }]);
    // The page never exposed start(): the same fallback.
    const never = await run('waiting');
    expect(never.result).toMatchObject({ ok: true, started: false });
    expect(never.asked.at(-1)).toEqual(["'ok'", { show: true, windowState: 'fullscreen' }]);
    expect(START_EXPRESSION).toContain('document.fullscreenElement');
  });

  it('a full-screen open starts the film with sound through the page, and never for a muted check (D2)', async () => {
    const asked: Array<[string, string, Json]> = [];
    let tries = 0;
    const evaluate = async (origin: string, expression: string, options: Json): Promise<unknown> => {
      asked.push([origin, expression, options]);
      if (expression !== START_EXPRESSION) return 'ok';
      tries += 1;
      return tries < 3 ? 'waiting' : 'started';
    };
    const wait = async (): Promise<void> => {};
    const played = await openInChrome('http://localhost:7317/stream/abc', { fullscreen: true }, { evaluate, wait });
    expect(played).toEqual({ ok: true, url: 'http://localhost:7317/stream/abc', fullscreen: true, started: true });
    expect(asked[0]).toEqual(['http://localhost:7317', "location.assign(\"/stream/abc\"); 'ok'", { show: true, windowState: 'normal', closeHosts: SITE_HOSTS }]);
    expect(SITE_HOSTS).toContain('dramacool9.com.ro');
    expect(asked.slice(1).map((a) => a[1])).toEqual([START_EXPRESSION, START_EXPRESSION, START_EXPRESSION]);

    asked.length = 0;
    const muted = await openInChrome('http://127.0.0.1:7317/stream/abc?muted=1', { fullscreen: true }, { evaluate, wait });
    expect(muted).toMatchObject({ ok: true, started: null });
    expect(asked.map((a) => a[1])).not.toContain(START_EXPRESSION);
    // A page that will not start itself still gets the screen, from the window.
    expect(asked[0]?.[2]).toEqual({ show: true, windowState: 'fullscreen' });
    expect(wantsStart('http://localhost:7317/stream/abc', false)).toBe(false);
    expect(wantsStart('http://localhost:7317/stream/abc?muted=1', true)).toBe(false);

    const never = await openInChrome('http://localhost:7317/stream/abc', { fullscreen: true }, { evaluate: async (_o: string, e: string) => (e === START_EXPRESSION ? 'waiting' : 'ok'), wait });
    expect(never).toMatchObject({ ok: true, started: false });
  });
});

describe('the sniffer', () => {
  const parses = (expression: string): void => {
    expect(() => new Function(`return ${expression}`)).not.toThrow();
  };

  it('reads its one line of JSON, and turns a named failure into a ChromeError', () => {
    expect(() => parseSniffReply('starting\n{"error":"no_chrome","detail":"chrome.exe was not found"}\n')).toThrow(ChromeError);
    try {
      parseSniffReply('{"error":"chrome_not_reachable","detail":"x"}');
    } catch (err) {
      expect((err as { code: string }).code).toBe('chrome_not_reachable');
    }
    expect(() => parseSniffReply('garbage')).toThrow(/unreadable/);
    const reply = parseSniffReply('{"url":"u","hits":null,"frames":"page https://a.example/","bot_check":true,"bot_check_reason":"title Just a moment..."}');
    expect(reply).toMatchObject({ hits: [], frames: ['page https://a.example/'], hosts: [], bot_check: true, media: { elements: 0, audible: 0 } });
  });

  it('keeps a page silent: media cannot be unmuted and Web Audio stays suspended', async () => {
    parses(MUTE_SCRIPT);
    parses(MEDIA_EXPRESSION);
    class FakeMedia {
      #muted = false;
      paused = true;
      get muted(): boolean {
        return this.#muted;
      }
      set muted(value: boolean) {
        this.#muted = value;
      }
      play(): Promise<void> {
        this.paused = false;
        return Promise.resolve();
      }
    }
    class FakeAudioContext {
      state = 'running';
      suspend(): Promise<void> {
        this.state = 'suspended';
        return Promise.resolve();
      }
      resume(): Promise<void> {
        this.state = 'running';
        return Promise.resolve();
      }
    }
    const page: Json = { HTMLMediaElement: FakeMedia, AudioContext: FakeAudioContext, addEventListener: () => undefined };
    page.window = page;
    createContext(page);
    runInContext(MUTE_SCRIPT, page);
    const media = new FakeMedia();
    media.muted = false;
    await media.play();
    expect(media.paused).toBe(false);
    expect(media.muted).toBe(true);
    const Audio = page.AudioContext as new () => FakeAudioContext;
    const audio = new Audio();
    await audio.resume();
    expect(audio.state).toBe('suspended');
  });

  it('never raises a window and never disguises the client', () => {
    const script = readFileSync(new URL('../../../claude/streaming/direct/sniff.ps1', import.meta.url), 'utf8');
    for (const forbidden of ['bringToFront', 'setWindowBounds', 'AppActivate', 'SendKeys', 'setUserAgentOverride', '--user-agent', '--mute-audio']) {
      expect(script, forbidden).not.toContain(forbidden);
    }
    expect(script).toContain('background = $true');
    expect(script).toContain('Page.addScriptToEvaluateOnNewDocument');
  });
});

describe('anime embeds', () => {
  const ANIME = { kind: 'tv', tmdbId: 37854, season: 17, episode: 730, anime: { id: 21, episode: 730 } };
  const animeProvider = (name: string, over: Json = {}): Json =>
    provider(name, { id_kind: 'anilist', movie: `https://${name.toLowerCase()}.example/anime/{id}/1/sub`, tv: `https://${name.toLowerCase()}.example/anime/{id}/{episode}/sub`, en_subtitle: true, ...over });
  /** What vidnest.fun's anime embed loads: a relayed playlist, and the subtitle file behind a relay that names it as a parameter. */
  const animeCapture = (): Json =>
    capture({
      hits: [
        hit({ type: 'XHR', url: 'https://relay.example/proxy?url=https%3A%2F%2Fcdn.example%2Fa%2Fmaster.m3u8&headers=%7B%7D', mime: 'application/vnd.apple.mpegurl', body: MASTER }),
        hit({ type: 'TextTrack', url: 'https://relay.example/fetch?url=https%3A%2F%2Fsubs.example%2Fanime%2Fsubtitles%2F147c.vtt&ref=https%3A%2F%2Fplay.example%2F', mime: 'application/octet-stream' }),
        hit({ type: 'TextTrack', url: 'blob:https://vidnest.fun/894a5a94', mime: 'text/vtt' }),
      ],
    });

  it('the anime seed holds embeds keyed by AniList id, with an episode and no season', () => {
    const seed: Json[] = readProviders(readFileSync(ANIME_SEED_PATH, 'utf8'));
    expect(seed.length).toBeGreaterThan(0);
    for (const p of seed) {
      expect(p.id_kind).toBe('anilist');
      expect(p.tv).toContain('{episode}');
      expect(p.tv).not.toContain('{season}');
      expect(p.en_subtitle).toBe(true);
    }
    expect(() => readProviders(JSON.stringify([animeProvider('A', { tv: 'https://a.example/anime/{id}/sub' })]))).toThrow(/\{id\}, \{episode\}/);
    expect(() => readProviders(JSON.stringify([provider('A', { id_kind: 'imdb' })]))).toThrow(/id_kind/);
  });

  it('addresses an anime embed by the AniList id and the episode counted through the series, and has no address without them', () => {
    expect(embedUrl(animeProvider('Ani'), ANIME)).toBe('https://ani.example/anime/21/730/sub');
    expect(embedUrl(animeProvider('Ani'), { kind: 'movie', tmdbId: 129, season: null, episode: null, anime: { id: 199, episode: 1 } })).toBe('https://ani.example/anime/199/1/sub');
    expect(embedUrl(animeProvider('Ani'), { kind: 'tv', tmdbId: 1396, season: 2, episode: 3 })).toBeNull();
    expect(embedUrl(provider('Plain', { tv: 'https://plain.example/tv/{id}/{season}/{episode}' }), ANIME)).toBe('https://plain.example/tv/37854/17/730');
  });

  it('tries the anime embeds first for an anime, whatever the health order says, and reads the relayed subtitle as English', async () => {
    const { sniff, calls } = fakeSniffer({ 'ani.example': animeCapture(), 'healthy.example': streamCapture() });
    const providers = [provider('Healthy', { tv: 'https://healthy.example/tv/{id}/{season}/{episode}', en_subtitle: true }), animeProvider('Ani')];
    const health = { Healthy: { last_outcome: 'resolved', last_success_at: '2026-11-16T00:00:00Z', consecutive_failures: 0 } };
    const out = await resolveTitle(ANIME, { providers, health, sniff });
    expect(calls.map((c) => c.url)).toEqual(['https://ani.example/anime/21/730/sub']);
    expect(out).toMatchObject({ ok: true, source: { provider: 'Ani', embed_url: 'https://ani.example/anime/21/730/sub', manifest_kind: 'hls', en_subtitle: true } });
    expect(out.source.subtitles).toContainEqual(
      { url: 'https://relay.example/fetch?url=https%3A%2F%2Fsubs.example%2Fanime%2Fsubtitles%2F147c.vtt&ref=https%3A%2F%2Fplay.example%2F', lang: 'en', label: 'English', format: 'vtt', source: 'request' },
    );
    // The page's own blob copy of the file is not an address the player can ask for.
    expect(out.source.subtitles.some((t: Json) => String(t.url).startsWith('blob:'))).toBe(false);
  });

  it('skips the anime embeds for a title that is no anime, and falls back to the others when they load nothing', async () => {
    const plain = fakeSniffer({ 'healthy.example': streamCapture() });
    const providers = [animeProvider('Ani'), provider('Healthy', { tv: 'https://healthy.example/tv/{id}/{season}/{episode}' })];
    const notAnime = await resolveTitle({ kind: 'tv', tmdbId: 1396, season: 2, episode: 3 }, { providers, sniff: plain.sniff });
    expect(notAnime.attempts.map((a: Json) => [a.provider, a.outcome])).toEqual([['Ani', 'skipped_no_template'], ['Healthy', 'resolved']]);
    expect(notAnime.attempts[0].detail).toContain('AniList');
    const empty = fakeSniffer({ 'healthy.example': streamCapture() });
    const fallback = await resolveTitle(ANIME, { providers, sniff: empty.sniff });
    expect(fallback.attempts.map((a: Json) => [a.provider, a.outcome])).toEqual([['Ani', 'no_stream'], ['Healthy', 'resolved']]);
  });

  it('parses --anime, and refuses one that is not <AniList id>:<episode>', () => {
    expect(parseArgs(['resolve', 'tv', '37854', '17', '730', '--anime', '21:730']).ref).toEqual({ kind: 'tv', tmdbId: 37854, season: 17, episode: 730, anime: { id: 21, episode: 730 } });
    expect(parseArgs(['resolve', 'movie', '550']).ref.anime).toBeNull();
    for (const bad of ['21', '21:0', 'a:1', '21:730:1']) expect(() => parseArgs(['resolve', 'tv', '37854', '17', '730', '--anime', bad])).toThrow(/--anime/);
  });
});

describe('what counts as a stream, and where subtitles show', () => {
  it('does not take a whole-series fallback player for the episode asked', async () => {
    // NexaStream, 2026-11-19: Breaking Bad S01E99 does not exist, and the page fell back to a nested player given the series alone.
    const episode = { kind: 'tv', tmdbId: 1396, season: 1, episode: 99 };
    const fromFrame = (frame: string): Json =>
      capture({ frames: [`iframe ${frame}`, 'worker blob:https://embed.example/1'], hits: [hit({ url: 'https://cdn.player.example/s/master.m3u8', referer: 'https://player.example/', origin: 'https://player.example', body: MASTER })] });
    const fallback = fromFrame('https://player.example/play/tt0903747');
    expect(seriesPlayerFrame(fallback, pickSource(fallback), episode)).toBe('player.example');
    expect(seriesPlayerFrame(fromFrame('https://player.example/embed/tv/1396'), pickSource(fallback), episode)).toBe('player.example');
    // A frame that names the episode, in any of the usual ways, is the episode's own player.
    for (const named of ['https://player.example/embed/tv/1396/1/99', 'https://player.example/play/tt0903747?s=1&e=99', 'https://player.example/e/1396-S01E99', 'https://player.example/tv?tmdb=1396&season=01&episode=99']) {
      expect(seriesPlayerFrame(fromFrame(named), pickSource(fallback), episode)).toBeNull();
    }
    // S01E01 needs both numbers: the season alone does not name the episode.
    expect(seriesPlayerFrame(fromFrame('https://player.example/tv/1396/1'), pickSource(fallback), { ...episode, episode: 1 })).toBe('player.example');
    expect(seriesPlayerFrame(fromFrame('https://player.example/tv/1396/1/1'), pickSource(fallback), { ...episode, episode: 1 })).toBeNull();
    // An opaque frame names no title and says nothing; nor does a stream the embed's own page asked for, or a film.
    expect(seriesPlayerFrame(fromFrame('https://player.example/rcp/Zm9vYmFy'), pickSource(fallback), episode)).toBeNull();
    expect(seriesPlayerFrame(fromFrame('https://other.example/play/tt0903747'), pickSource(fallback), episode)).toBeNull();
    expect(seriesPlayerFrame(fallback, pickSource(fallback), MOVIE)).toBeNull();

    const tv = 'https://{host}.example/tv/{id}/{season}/{episode}';
    const { sniff } = fakeSniffer({ 'alpha.example': fallback, 'beta.example': streamCapture() });
    const result = await resolveTitle(episode, { providers: [provider('Alpha', { tv: tv.replace('{host}', 'alpha') }), provider('Beta', { tv: tv.replace('{host}', 'beta') })], sniff });
    expect(result.attempts.map((a: Json) => [a.provider, a.outcome])).toEqual([
      ['Alpha', 'no_stream'],
      ['Beta', 'resolved'],
    ]);
    expect(result.attempts[0].detail).toBe('the stream came from player.example, a whole-series player whose address names no episode');
    // The same capture for a film is a stream like any other.
    const film = await resolveTitle(MOVIE, { providers: [provider('Alpha')], sniff });
    expect(film.source?.provider).toBe('Alpha');
  });

  it('does not take an answer that is no playlist for a stream', async () => {
    // What a relay under a rate limit answered for One Piece: a bare list of addresses, no #EXTM3U.
    const garbage = capture({ hits: [hit({ url: 'https://cdn.example/m3u8-proxy.m3u8?p=abc', mime: 'application/vnd.apple.mpegurl', body: 'https://cdn.example/m3u8-proxy.m3u8?p=1\nhttps://cdn.example/m3u8-proxy.m3u8?p=2\n' })] });
    expect(pickSource(garbage)).toBeNull();
    const { sniff } = fakeSniffer({ 'bad.example': garbage, 'good.example': streamCapture() });
    const out = await resolveTitle(MOVIE, { providers: [provider('Bad'), provider('Good')], sniff });
    expect(out.attempts.map((a: Json) => [a.provider, a.outcome])).toEqual([['Bad', 'no_stream'], ['Good', 'resolved']]);
    // A playlist whose text Chrome did not keep cannot be checked, and is kept.
    expect(pickSource(capture({ hits: [hit({ url: 'https://cdn.example/a.m3u8', mime: 'application/vnd.apple.mpegurl', body: null })] }))).not.toBeNull();
  });

  it('reads the subtitle files a page\'s subtitle service listed, English named as such', () => {
    const vdrk = hit({ type: 'SubtitleIndex', url: 'https://sub.vdrk.site/v2/tv/1396/2/3', mime: 'application/json', body: JSON.stringify([{ label: 'Arabic', file: 'https://cache.vdrk.site/v3/tv/1396/2/3/Arabic.vtt' }, { label: 'English', file: 'https://cache.vdrk.site/v3/tv/1396/2/3/English.vtt' }]) });
    const wyzie = hit({ type: 'SubtitleIndex', url: 'https://sub.wyzie.io/search?id=550', mime: 'application/json', body: JSON.stringify([{ url: 'https://sub.wyzie.io/c/1/id/9?format=srt', display: 'English', language: 'en', format: 'srt' }, { url: 'ftp://x/y.srt', language: 'en' }]) });
    expect(indexSubtitles([vdrk, wyzie, hit({ type: 'SubtitleIndex', body: '{"error":"No subtitles found"}' }), hit({ type: 'SubtitleIndex', body: 'not json' })])).toEqual([
      { url: 'https://cache.vdrk.site/v3/tv/1396/2/3/Arabic.vtt', lang: null, label: 'Arabic', format: 'vtt', source: 'request' },
      { url: 'https://cache.vdrk.site/v3/tv/1396/2/3/English.vtt', lang: 'en', label: 'English', format: 'vtt', source: 'request' },
      { url: 'https://sub.wyzie.io/c/1/id/9?format=srt', lang: 'en', label: 'English', format: 'srt', source: 'request' },
    ]);
    const found = pickSource(capture({ hits: [hit({ url: 'https://cdn.example/hls/2160/index.m3u8', mime: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n#EXTINF:6,\nseg0.ts' }), vdrk] }));
    expect(found.en_subtitle).toBe(true);
  });

  it('the sniffer keeps a subtitle file behind a relay, a text track, and a subtitle service\'s list', () => {
    const script = readFileSync(new URL('../../../claude/streaming/direct/sniff.ps1', import.meta.url), 'utf8');
    expect(script).toContain("\\.vtt([?&%]|$)");
    expect(script).toContain("$m.params.type -eq 'TextTrack'");
    expect(script).toContain("'SubtitleIndex'");
  });

  it('never takes a playlist the page built for itself for the stream', () => {
    // VidMario, 2026-11-19: the master playlist of an episode is a blob the player wrote; the playlists it names are real requests.
    const blob = hit({ url: 'blob:https://player.example/d94a7ae8-fd8e-4d94-928a-d196a73c4905', mime: 'application/vnd.apple.mpegurl', body: MASTER });
    const real = hit({ at_s: 2.4, url: 'https://cdn.example/tv/abc/1080/index.m3u8', mime: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n#EXTINF:6,\nseg0.ts' });
    expect(pickSource(capture({ hits: [blob, real] }))?.manifest_url).toBe('https://cdn.example/tv/abc/1080/index.m3u8');
    expect(pickSource(capture({ hits: [blob] }))).toBeNull();
    // The page's own master says which of the playlists it loaded is which: the tallest loaded one is kept, with its height.
    const media = '#EXTM3U\n#EXTINF:6,\nseg0.ts';
    const built = hit({
      url: 'blob:https://player.example/b50e7914',
      mime: 'application/vnd.apple.mpegurl',
      body: [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=3049059,RESOLUTION=1280x720',
        'data:application/vnd.apple.mpegurl,%23EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=900000000,RESOLUTION=1920x1080',
        'https://cache.example/api?d=full',
        '#EXT-X-STREAM-INF:BANDWIDTH=950000000,RESOLUTION=3840x2160,CODECS="hvc1.2.4.L153.B0,mp4a.40.2"',
        'https://cache.example/api?d=uhd',
        '#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=7680x4320',
        'https://cache.example/api?d=never-loaded',
      ].join('\n'),
    });
    const low = hit({ url: 'https://cdn.example/tv/abc/list.m3u8', mime: 'application/vnd.apple.mpegurl', body: media });
    const full = hit({ url: 'https://cache.example/api?d=full', mime: 'application/vnd.apple.mpegurl', body: media });
    const uhd = hit({ at_s: 3, url: 'https://cache.example/api?d=uhd', mime: 'application/vnd.apple.mpegurl', body: media });
    expect(pickSource(capture({ hits: [low, full, built, uhd] }))).toMatchObject({ manifest_url: 'https://cache.example/api?d=uhd', best_height: 2160 });
    expect(pickSource(capture({ hits: [low, full, built] }))).toMatchObject({ manifest_url: 'https://cache.example/api?d=full', best_height: 1080 });
    expect(pickSource(capture({ hits: [low, built] }))).toMatchObject({ manifest_url: 'https://cdn.example/tv/abc/list.m3u8', best_height: null });
  });

  it('presses the middle of the page as it is laid out, and knows a player\'s own captcha gate for a bot check', () => {
    const script = readFileSync(new URL('../../../claude/streaming/direct/sniff.ps1', import.meta.url), 'utf8');
    // vidsrc.sh's player starts only from its centred button: a fixed point misses it in a tab the size of the window.
    expect(script).toContain(`expression = 'innerWidth + "x" + innerHeight'`);
    expect(script).toContain('x = $clickX; y = $clickY');
    expect(script).not.toContain('x = 400; y = 300');
    // Its puzzle before the stream is an outcome, never solved.
    expect(/\$botUrl = '([^']+)'/.exec(script)?.[1]).toContain('/vs_captcha/');
    expect(/\$botUrl = '([^']+)'/.exec(script)?.[1]).toContain('^https?://cap\\.[^/]+/');
  });
});
