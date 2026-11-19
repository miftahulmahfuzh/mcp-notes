import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CAUSES,
  CampaignAbort,
  FINDINGS_FILE,
  SEED_FILE,
  applySeed,
  checkFindings,
  claimedExpiry,
  diagnose,
  episodeTemplates,
  evidenceOf,
  lifetimeReport,
  main,
  readManifest,
  rediagnose,
  renderFindings,
  runCampaign,
  watchLifetime,
  // @ts-expect-error -- plain .mjs scripts without type declarations
} from '../../../claude/streaming/direct/campaign.mjs';

// The seed's names and film templates, with nothing measured: a live campaign fills the rest.
const seed: any[] = JSON.parse(readFileSync(SEED_FILE, 'utf8')).map((p: any) => ({ ...p, tv: null, browser_only: false, en_subtitle: null, notes: '' }));

const MASTER = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="subs/en.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=3840x2160,SUBTITLES="subs"',
  'hi/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=854x480,SUBTITLES="subs"',
  'lo/index.m3u8',
  '',
].join('\n');
const MEDIA = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg0.ts\n#EXT-X-ENDLIST\n';

const reply = (status: number, body: string) => ({
  status,
  ok: status >= 200 && status < 300,
  url: '',
  text: async () => body,
  arrayBuffer: async () => new ArrayBuffer(0),
});

const fakeFetch = async (url: string) => {
  if (url.includes('/index.m3u8')) return reply(200, MEDIA);
  if (url.includes('.m3u8')) return reply(200, MASTER);
  if (url.endsWith('.ts')) return reply(206, 'x');
  return reply(404, '');
};

type Shape = { manifest?: boolean; requests?: number; frames?: string[]; bot?: boolean; inspect?: unknown; clicks?: number };
const sniffed = (url: string, shape: Shape, options: any) => ({
  url,
  took_s: 2.4,
  requests: shape.requests ?? 40,
  clicks: shape.clicks ?? 0,
  popups_closed: 0,
  frames: shape.frames ?? ['iframe https://player.example/e/1'],
  hosts: ['player.example 30', 'cdn.example 10'],
  hits: shape.manifest
    ? [
        {
          at_s: 2.4,
          type: 'XHR',
          url: `https://cdn.example/hls/${encodeURIComponent(url)}/master.m3u8`,
          referer: 'https://player.example/',
          origin: 'https://player.example',
          document: url,
          status: 200,
          mime: 'application/vnd.apple.mpegurl',
        },
      ]
    : [],
  user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0',
  bot_check: shape.bot === true,
  inspect: options?.inspect ? (shape.inspect ?? [{ url, title: '', text: '', videos: [], iframes: 0 }]) : null,
});

const isControl = (url: string) => /(^|[^0-9])99([^0-9]|$)/.test(url);

/** One behaviour per embed host; every other provider resolves films and honours the episode. */
async function fakeSniff(url: string, options: any = {}) {
  const host = new URL(url).host;
  switch (host) {
    case 'player.videasy.net':
      return sniffed(url, { requests: 6, inspect: [{ url, title: 'Videasy', text: '', videos: [{ src: 'blob:https://player.videasy.net/1', ready_state: 4, paused: false, current_time: 3 }], iframes: 0 }] }, options);
    case 'www.vidking.net':
      return sniffed(url, { requests: 4, bot: true }, options);
    case 'vidsrc.cc':
      if (url.includes('/tv/')) return sniffed(url, { manifest: !isControl(url) && url.includes('/2/3') }, options);
      return sniffed(url, { manifest: Number(options.seconds ?? 0) >= 90 }, options);
    case 'vidup.to':
      return sniffed(url, { manifest: true }, options);
    case 'vidsrc.me':
      return sniffed(url, { requests: 0, frames: [] }, options);
    case '111movies.com':
      return sniffed(url, { inspect: [{ url, title: '111movies', text: 'Sorry, this movie is not found', videos: [], iframes: 0 }] }, options);
    case 'hexa.watch':
      return sniffed(url, { frames: [], inspect: [{ url, title: 'Hexa', text: '', videos: [], iframes: 1 }] }, options);
    case 'rivestream.org':
      return sniffed(url, { clicks: 4, inspect: [{ url, title: 'Rive', text: '', videos: [{ src: '', ready_state: 0, paused: true, current_time: 0 }], iframes: 0 }] }, options);
    case 'spencerdevs.xyz':
      return sniffed(url, {}, options);
    case 'vidsrc.wtf':
      throw new Error('powershell: the sniffer crashed');
    default:
      return sniffed(url, { manifest: !isControl(url) }, options);
  }
}

const run = () => runCampaign({ providers: seed, sniff: fakeSniff, fetchImpl: fakeFetch, now: () => new Date('2026-11-15T12:00:00Z'), host: 'test-host' });

describe('direct streaming probe campaign', () => {
  it('writes, for every one of the 24 seed providers, what it resolved or the named cause', async () => {
    expect(seed).toHaveLength(24);
    const results = await run();
    expect(results.rows.map((row: any) => row.name)).toEqual(seed.map((p) => p.name));
    for (const row of results.rows) {
      const film = [row.film, row.long, row.recent].find((r: any) => r?.outcome === 'resolved');
      if (film) {
        expect(film.manifest_kind).toBe('hls');
        expect(film.best_height).toBe(2160);
        expect(film.en_subtitle).toBe(true);
        expect(typeof film.took_s).toBe('number');
      } else {
        expect(CAUSES).toContain(row.verdict.cause);
      }
    }
  });

  it('names each cause from the evidence', async () => {
    const results = await run();
    const by = (name: string) => results.rows.find((row: any) => row.name === name).verdict;
    expect(by('Videasy').cause).toBe('blob_media');
    expect(by('VidKing').cause).toBe('bot_check');
    expect(by('VidSrc').cause).toBe('unreachable');
    expect(by('Movies111').cause).toBe('not_found');
    expect(by('StreamVault').cause).toBe('frame_not_attached');
    expect(by('MovieVault').cause).toBe('click_missed');
    expect(by('MediaHub').cause).toBe('no_player');
    expect(by('HyperLink').cause).toBe('error');
    expect(by('CloudPlay')).toEqual({ cause: null, note: 'slow_start' });
    expect(by('VidFast')).toEqual({ cause: null, note: '' });
  });

  it('names a browser error page or a Cloudflare 52x page unreachable, and ignores an advert page that took the tab', () => {
    const run = (url: string, inspect: unknown) => ({ outcome: 'no_stream', needed_click: false, evidence: evidenceOf(sniffed(url, { requests: 5, frames: [], inspect: [inspect] }, { inspect: true })) });
    const dns = run('https://player.videasy.net/movie/550', { url: 'chrome-error://chromewebdata/', title: 'player.videasy.to', text: 'This site can’t be reached', videos: [], iframes: 0 });
    expect(diagnose({ name: 'Videasy', standard: dns, long: dns })).toEqual({ cause: 'unreachable', note: '' });
    const down = run('https://vidsrc.cc/v2/embed/movie/550', { url: 'https://vidsrc.cc/v2/embed/movie/550', title: 'vidsrc.cc | 522: Connection timed out', text: 'Connection timed out Error code 522', videos: [], iframes: 0 });
    expect(diagnose({ name: 'CloudPlay', standard: down, long: down }).cause).toBe('unreachable');
    const advert = run('https://111movies.com/movie/550', { url: 'https://ron.mamma.com/general/deals', title: '404 - Page Not Found', text: '404 - Page Not Found', videos: [], iframes: 0 });
    expect(advert.evidence.inspect).toMatchObject({ away: true, text: '' });
    expect(diagnose({ name: 'Movies111', standard: advert, long: advert }).cause).toBe('no_player');
    // A provider's second host is still the provider.
    const moved = run('https://vidsrc.me/embed/movie?tmdb=550', { url: 'https://vidsrc.sh/embed/movie?tmdb=550', title: 'Fight Club', text: 'No sources', videos: [], iframes: 0 });
    expect(diagnose({ name: 'VidSrc', standard: moved, long: moved }).cause).toBe('not_found');
  });

  it('works the verdicts out again from the raw sniffs when a report is written', async () => {
    const results = await run();
    const stale = { ...results, rows: results.rows.map((row: any) => ({ ...row, verdict: { cause: 'undiagnosed', note: '' } })) };
    expect(rediagnose(stale).rows.map((row: any) => row.verdict)).toEqual(results.rows.map((row: any) => row.verdict));
  });

  it('keeps an episode template only when it serves the episode and fails the control', async () => {
    const results = await run();
    const by = (name: string) => results.rows.find((row: any) => row.name === name).episode;
    expect(by('CloudPlay').template).toBe('https://vidsrc.cc/v2/embed/tv/{id}/{season}/{episode}');
    expect(by('CloudPlay').control_outcome).not.toBe('resolved');
    expect(by('VidFast').template).toBe('https://vidfast.pro/tv/{id}/{season}/{episode}?autoPlay=true');
    expect(by('VidUp').template).toBeNull();
    expect(by('VidUp').tried.map((t: any) => t.outcome)).toEqual(['ignores_episode', 'ignores_episode', 'ignores_episode', 'ignores_episode']);
    expect(by('Videasy').skipped).toBe('no film resolved');
  });

  it('derives episode candidates for every seed template', () => {
    for (const provider of seed) {
      const candidates = episodeTemplates(provider.movie);
      expect(candidates.length).toBeGreaterThanOrEqual(2);
      for (const c of candidates) {
        expect(c).toContain('{id}');
        expect(c).toContain('{season}');
        expect(c).toContain('{episode}');
        expect(c).not.toMatch(/\/movie(\/|\?|$)|type=movie/);
      }
    }
    // A path id takes four shapes; Smashy's real one is the third (its /tv/{id}/{season}/{episode} forwards to an address its player refuses).
    expect(episodeTemplates('https://player.smashystream.com/movie/{id}')).toEqual([
      'https://player.smashystream.com/tv/{id}/{season}/{episode}',
      'https://player.smashystream.com/tv/{id}?season={season}&episode={episode}',
      'https://player.smashystream.com/tv/{id}?s={season}&e={episode}',
      'https://player.smashystream.com/tv/{id}-{season}-{episode}',
    ]);
    expect(episodeTemplates('https://vidup.to/movie/{id}?autoPlay=true')[2]).toBe('https://vidup.to/tv/{id}?autoPlay=true&s={season}&e={episode}');
    expect(episodeTemplates('https://vidsrc.me/embed/movie?tmdb={id}')[0]).toBe('https://vidsrc.me/embed/tv?tmdb={id}&season={season}&episode={episode}');
    expect(episodeTemplates('https://rivestream.org/embed?type=movie&id={id}')[0]).toBe('https://rivestream.org/embed?type=tv&id={id}&season={season}&episode={episode}');
  });

  it('stops the run when the streaming Chrome is not there', async () => {
    const down = async () => {
      throw Object.assign(new Error('no_chrome: chrome.exe was not found'), { code: 'no_chrome' });
    };
    await expect(runCampaign({ providers: seed.slice(0, 1), sniff: down, fetchImpl: fakeFetch })).rejects.toBeInstanceOf(CampaignAbort);
  });

  it('reads heights and English subtitle tracks from HLS and DASH manifests', () => {
    expect(readManifest(MASTER, 'hls')).toEqual({ heights: [2160, 480], subtitle_langs: ['en'] });
    const mpd = '<MPD><AdaptationSet contentType="video"><Representation height="1080"/></AdaptationSet><AdaptationSet contentType="text" lang="eng"></AdaptationSet></MPD>';
    expect(readManifest(mpd, 'dash')).toEqual({ heights: [1080], subtitle_langs: ['eng'] });
  });

  it('measures how long a manifest keeps answering, on a schedule, with a claimed expiry', async () => {
    let t = Date.parse('2026-11-15T12:00:00Z');
    const start = t;
    const expires = Math.floor(start / 1000) + 6 * 3600;
    const sniff = async (url: string) => ({
      ...sniffed(url, { manifest: false }, {}),
      hits: [{ at_s: 2, type: 'XHR', url: `https://cdn.example/hls/master.m3u8?expires=${expires}`, referer: 'https://vidfast.vc/', origin: 'https://vidfast.vc', document: url, status: 200, mime: 'application/vnd.apple.mpegurl' }],
    });
    const fetchAt = async (url: string) => ((t - start) / 60_000 >= 40 ? reply(403, '') : fakeFetch(url));
    const lines: any[] = [];
    await watchLifetime({
      provider: seed.find((p) => p.name === 'VidFast'),
      sniff,
      fetchImpl: fetchAt,
      sleep: async (ms: number) => {
        t += ms;
      },
      now: () => t,
      scheduleMin: [0, 5, 20, 40, 60],
      maxMin: 60,
      write: (line: any) => lines.push(line),
    });
    const report = lifetimeReport(lines);
    expect(report).toMatchObject({ provider: 'VidFast', claimed_minutes: 360, last_ok_min: 20, first_failure_min: 40, end_reason: 'failed', checks: 4 });
    expect(report.first_failure.master).toBe(403);
    expect(claimedExpiry('https://cdn.example/x/master.m3u8', start)).toBeNull();
  });

  it('fills the findings template so the checker accepts the tables, and flags hand sections left open', async () => {
    const results = await run();
    const lifetime = { provider: 'VidFast', manifest_kind: 'hls', manifest_host: 'cdn.example', started_at: '2026-11-15T12:00:00.000Z', claimed_expiry: null, claimed_minutes: null, last_ok_min: 60, first_failure_min: null, first_failure: null, checks: 7, finished: false, end_reason: 'running' };
    const template = readFileSync(FINDINGS_FILE, 'utf8');
    const text = renderFindings(template, { results, lifetime, lifetimeLog: '/tmp/lifetime.jsonl', resultsFiles: ['/tmp/results.json'] });
    expect(text).toContain('## Why three returned nothing');
    expect(text).toContain('## Playback');
    const filled = applySeed(seed, results);
    const problems = checkFindings(text, filled);
    expect(problems.filter((p: string) => /^(providers|episodes|seed|lifetime|timings):/.test(p))).toEqual([]);
    const timings = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)![1]!);
    expect(Object.keys(timings.providers)).toHaveLength(24);
    // Seconds come from phase 1's resolver; only their presence is this phase's to assert.
    expect(typeof timings.resolve_s.p50).toBe('number');
    expect(timings.token_lifetime.last_ok_min).toBe(60);
    // Rendering again without a lifetime keeps the measured one.
    const again = renderFindings(text, { results, resultsFiles: ['/tmp/results.json'] });
    expect(again).toContain('| 60 |');
  });

  it('fills the seed fields the campaign measured and leaves the rest', async () => {
    const results = await run();
    const filled = applySeed(seed, results);
    const by = (name: string) => filled.find((p: any) => p.name === name);
    expect(filled).toHaveLength(24);
    expect(by('CloudPlay').tv).toBe('https://vidsrc.cc/v2/embed/tv/{id}/{season}/{episode}');
    expect(by('VidUp').tv).toBeNull();
    expect(by('Videasy').browser_only).toBe(true);
    expect(by('VidFast').en_subtitle).toBe(true);
    expect(by('VidKing').en_subtitle).toBeNull();
    expect(by('VidFast').movie).toBe(seed.find((p) => p.name === 'VidFast').movie);
    for (const provider of filled) expect(provider.notes).toMatch(/^campaign 2026-11-15: /);
  });

  it('runs from the command line against a scratch findings file', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'campaign-'));
    const findings = path.join(dir, 'findings.md');
    writeFileSync(findings, readFileSync(FINDINGS_FILE, 'utf8'));
    const out: string[] = [];
    const original = console.log;
    console.log = (text: string) => out.push(text);
    try {
      const code = await main('run', ['--only', 'VidFast,VidKing', '--out', dir, '--findings', findings], { sniff: fakeSniff, fetchImpl: fakeFetch, log: () => {} });
      expect(code).toBe(0);
    } finally {
      console.log = original;
    }
    const printed = JSON.parse(out.join('\n'));
    expect(printed).toMatchObject({ ok: true, providers: 2, resolved: 1, bot_check: 1 });
    const results = JSON.parse(readFileSync(path.join(dir, 'results.json'), 'utf8'));
    // Seed order, not --only order.
    expect(results.rows.map((row: any) => row.name)).toEqual(seed.filter((p) => ['VidFast', 'VidKing'].includes(p.name)).map((p) => p.name));
    expect(readFileSync(findings, 'utf8')).toMatch(/\| VidKing \| — \| — \| — \(no film resolved\) \| bot_check \|/);
  });
});
