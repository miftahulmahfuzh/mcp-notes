import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { BLOCK_BEGIN, BLOCK_END, GUARD_EXPRESSION, PAUSE_EXPRESSION, STATE_EXPRESSION, auditFindings, classifyManifest, decide, parseRunArgs, renderBlock, replaceBlock, runCheck, segmentFormat } from '../../../claude/streaming/direct/playcheck.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { gateUrl, startGate, wrapperMain } from '../../../claude/streaming/direct/playgate.mjs';

const DAEMON = 'http://127.0.0.1:7400';
const MASTER = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",LANGUAGE="en",URI="subs.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,SUBTITLES="s"',
  'v1080.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720',
  'v720.m3u8',
  '',
].join('\n');
const MEDIA = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg0.ts\n#EXT-X-ENDLIST\n';
const TS = new Uint8Array(376);
TS[0] = 0x47;
TS[188] = 0x47;
const MPD_DRM = '<MPD><Period><AdaptationSet contentType="video"><ContentProtection schemeIdUri="urn:uuid:edef8ba9"/><Representation height="1080"/></AdaptationSet></Period></MPD>';
const HLS_SESSION = {
  manifest_url: '/api/stream/sessions/s1/p?u=https%3A%2F%2Fcdn.example%2Fm.m3u8',
  manifest_kind: 'hls',
  subtitles: [{ url: '/api/stream/sessions/s1/p?u=sub', lang: 'en', label: 'English' }],
  resume_s: null,
};

function video(t: number, over: any = {}): any {
  return {
    stage: 'video', origin: DAEMON, playing: t > 0, paused: false, t, duration_s: 8340, w: 1920, h: 1080, muted: true,
    frames: 400, dropped: 0, buffered_s: 24, error: null, fullscreen: false,
    tracks: [{ kind: 'subtitles', label: 'English', language: 'en', mode: 'showing', cues: 1200, active_cues: 1 }],
    state: { kind: 'hls', levels: [1080, 720], level: 0, errors: [], refreshes: 0 },
    ...over,
  };
}

const opts = (check: string, provider: string, over: any = {}): any => ({
  daemon: DAEMON, dir: '/unused', check, provider, ref: { kind: 'movie', tmdbId: 550 },
  watchS: 10, timeoutS: 60, expireAfterS: 45, gatePort: 0, host: null, ...over,
});

interface FakeOptions {
  guard?: any;
  play?: any;
  session?: any;
  manifest?: string;
  gate?: (dtMs: number) => any;
}

function fakeDeps(sampleAt: (i: number) => any, o: FakeOptions = {}) {
  let clock = 0;
  let i = 0;
  const calls: any[] = [];
  const posted: any[] = [];
  const next: any[] = [];
  const opened: any[] = [];
  const deps = {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    evaluate: async (origin: string, expression: string, options: any = {}) => {
      calls.push({ origin, expression, options });
      if (expression === GUARD_EXPRESSION) return o.guard ?? { origin, playing: false };
      if (expression === STATE_EXPRESSION) return sampleAt(i++);
      return 'ok';
    },
    fetchJson: async (url: string, init: any = {}) => {
      if (url === `${DAEMON}/api/stream/play`) {
        posted.push(init.body);
        const reply = o.play ?? { ok: true, status: 200, body: { ok: true } };
        if (reply.ok) opened.push({ url: 'http://localhost:7400/stream/s1', args: ['--fullscreen'] });
        return reply;
      }
      if (url === `${DAEMON}/api/stream/sessions/s1`) return { ok: true, status: 200, body: o.session ?? HLS_SESSION };
      throw new Error(`unexpected fetch ${url}`);
    },
    fetchText: async (url: string) => ({ ok: true, status: 200, text: url.includes('?u=') ? (o.manifest ?? MASTER) : MEDIA }),
    fetchHead: async () => TS,
    readOpened: async () => [...opened],
    writeNext: async (value: any) => {
      next.push(value);
    },
    startGate: async () => {
      const armedAt = clock;
      return { url: 'http://127.0.0.1:47399', stats: () => o.gate!(clock - armedAt), close: async () => {} };
    },
  };
  return { deps, calls, posted, next };
}

const gateTimeline = (dt: number) =>
  dt < 30_000
    ? { tokens: [{ n: 1, served: 5, refused: 0 }] }
    : dt < 40_000
      ? { tokens: [{ n: 1, served: 9, refused: 2 }] }
      : { tokens: [{ n: 1, served: 9, refused: 2 }, { n: 2, served: 6, refused: 0 }] };

describe('playcheck: reading a stream', () => {
  it('reads encryption, DRM, subtitle tracks and heights from a manifest', () => {
    expect(classifyManifest(MASTER, 'hls')).toEqual({
      kind: 'hls', encryption: 'none', drm: false, key_formats: [], subtitles: [{ lang: 'en', label: 'English' }], heights: [1080, 720],
    });
    expect(classifyManifest('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k"\n', 'hls')).toMatchObject({ encryption: 'sample-aes', drm: false });
    expect(classifyManifest('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"\n', 'hls')).toMatchObject({ drm: true });
    expect(classifyManifest(MPD_DRM, 'dash')).toMatchObject({ kind: 'dash', drm: true, encryption: 'cenc', heights: [1080] });
    expect(classifyManifest('<MPD><AdaptationSet contentType="text" lang="en" label="English"></AdaptationSet></MPD>', 'dash').subtitles).toEqual([
      { lang: 'en', label: 'English' },
    ]);
  });

  it('tells a media segment from a disguised one', () => {
    expect(segmentFormat(TS).format).toBe('ts');
    expect(segmentFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).format).toBe('disguised_png');
  });

  it('gives the page expressions that parse', () => {
    for (const expression of [GUARD_EXPRESSION, STATE_EXPRESSION, PAUSE_EXPRESSION]) {
      expect(() => new Function(`return ${expression}`)).not.toThrow();
    }
  });
});

describe('playcheck: one run', () => {
  it('plays one provider muted in a normal window and pauses it afterwards', async () => {
    const f = fakeDeps((i) => video(i === 0 ? 0 : i * 1.5));
    const report = await runCheck(opts('play', 'VidFast'), f.deps);
    expect(report).toMatchObject({ verdict: 'plays', cause: null, session_id: 's1', error: null, subtitle_source: 'separate+manifest' });
    expect(f.posted).toEqual([{ kind: 'movie', tmdb_id: 550 }]);
    expect(f.next).toEqual([{ only: 'VidFast' }]);
    const nav = f.calls.find((c) => c.expression.includes('location.assign'));
    expect(nav.expression).toContain(`${DAEMON}/stream/s1?muted=1`);
    expect(nav.options).toMatchObject({ show: true, windowState: 'normal' });
    expect(f.calls.some((c) => c.options?.windowState === 'fullscreen')).toBe(false);
    expect(f.calls.at(-1).expression).toBe(PAUSE_EXPRESSION);
    expect(report.summary).toMatchObject({ muted_always: true, fullscreen_ever: false, height: 1080 });
    expect(report.manifest).toMatchObject({ kind: 'hls', encryption: 'none', heights: [1080, 720] });
    expect(report.segment.format).toBe('ts');
  });

  it('stops and pauses at once when the video is heard', async () => {
    const f = fakeDeps(() => video(3, { muted: false }));
    const report = await runCheck(opts('play', 'VidFast'), f.deps);
    expect(report).toMatchObject({ verdict: 'inconclusive', cause: 'not_muted' });
    expect(f.calls.filter((c) => c.expression === STATE_EXPRESSION)).toHaveLength(1);
    expect(f.calls.at(-1).expression).toBe(PAUSE_EXPRESSION);
  });

  it('never takes over a tab that is playing something else', async () => {
    const f = fakeDeps(() => video(1), { guard: { origin: 'http://localhost:7317', playing: true } });
    const report = await runCheck(opts('play', 'VidFast'), f.deps);
    expect(report).toMatchObject({ verdict: 'inconclusive', cause: 'foreign_tab_playing' });
    expect(f.posted).toEqual([]);
  });

  it('answers no_source without opening the page when the provider does not resolve', async () => {
    const play = { ok: false, status: 502, body: { error: 'no_source', attempts: [{ provider: 'VidLink', outcome: 'no_stream' }] } };
    const f = fakeDeps(() => video(1), { play });
    const report = await runCheck(opts('dash', 'VidLink'), f.deps);
    expect(report).toMatchObject({ verdict: 'no_source', play: { attempts: play.body.attempts } });
    expect(f.calls.some((c) => c.expression.includes('location.assign'))).toBe(false);
  });

  it('marks a DASH stream that never plays and carries DRM as browser_only', async () => {
    const session = { manifest_url: '/api/stream/sessions/s1/p?u=mpd', manifest_kind: 'dash', subtitles: [], resume_s: null };
    const f = fakeDeps(() => video(0, { playing: false, w: 0, h: 0 }), { session, manifest: MPD_DRM });
    const report = await runCheck(opts('dash', 'VidLink'), f.deps);
    expect(report).toMatchObject({ verdict: 'browser_only', cause: 'drm' });
  });

  it('calls a stream that will not play for no named cause our fault', async () => {
    const f = fakeDeps(() => video(0, { playing: false, state: { errors: ['networkError manifestLoadError FATAL'] } }));
    const report = await runCheck(opts('vidnest', 'VidNest'), f.deps);
    expect(report).toMatchObject({ verdict: 'needs_fix', cause: 'networkError manifestLoadError FATAL' });
  });

  it('needs an English track showing with cues for the subtitle check', async () => {
    const hidden = [{ kind: 'subtitles', label: 'English', language: 'en', mode: 'disabled', cues: null, active_cues: null }];
    const f = fakeDeps((i) => video(i * 1.5, { tracks: hidden }));
    const report = await runCheck(opts('subtitle', 'VidLink'), f.deps);
    expect(report).toMatchObject({ verdict: 'needs_fix', cause: 'english_track_disabled_0_cues' });
  });

  it('passes the expiry check when a refreshed source plays on from where it stopped', async () => {
    const f = fakeDeps((i) => video(i * 1.5), { gate: gateTimeline });
    const report = await runCheck(opts('expiry', 'VidFast'), f.deps);
    expect(report.expiry).toMatchObject({ first_refused: 2, refreshed: true, restarted: false, resumed: true });
    expect(report).toMatchObject({ verdict: 'plays', cause: null });
  });

  it('fails the expiry check when the film starts again from the beginning', async () => {
    const f = fakeDeps((i) => video(i <= 22 ? i * 1.5 : (i - 22) * 1.5), { gate: gateTimeline });
    const report = await runCheck(opts('expiry', 'VidFast'), f.deps);
    expect(report).toMatchObject({ verdict: 'needs_fix', cause: 'restarted_from_start' });
  });

  it('decides an unresolved, a wrongly kinded and a scrambled run by rule', () => {
    expect(decide('dash', { play: { ok: true }, session: { manifest_kind: 'hls' } })).toEqual({ verdict: 'inconclusive', cause: 'not_dash (hls)' });
    const stuck = { playing_at_end: false, advanced_s: 0, height: 0, errors: [] };
    expect(decide('play', { play: { ok: true }, session: { manifest_kind: 'hls' }, manifest: { drm: false, encryption: 'none' }, segment: { format: 'disguised_png' }, summary: stuck })).toEqual({
      verdict: 'browser_only',
      cause: 'obfuscated_segments',
    });
  });

  it('checks run arguments once and refuses the live daemon', () => {
    expect(() => parseRunArgs(['--daemon', 'http://127.0.0.1:7317', '--dir', '/d', '--check', 'play', '--provider', 'VidFast', 'movie', '550'])).toThrow(/7317/);
    expect(() => parseRunArgs(['--daemon', DAEMON, '--dir', '/d', '--check', 'vidnest', '--provider', 'VidFast', 'movie', '550'])).toThrow(/VidNest/);
    expect(() => parseRunArgs(['--daemon', DAEMON, '--dir', '/d', '--check', 'play', '--provider', 'VidFast', 'tv', '1399'])).toThrow(/season/);
    expect(parseRunArgs(['--daemon', `${DAEMON}/`, '--dir', '/d', '--check', 'dash', '--provider', 'VidLink', 'movie', '550'])).toMatchObject({
      daemon: DAEMON, check: 'dash', ref: { kind: 'movie', tmdbId: 550 }, watchS: 15, expireAfterS: 45, gatePort: 47399, host: null,
    });
  });
});

describe('playcheck: the daemon side', () => {
  const resolved = {
    ok: true, kind: 'movie', tmdb_id: 550,
    source: {
      provider: 'VidFast', manifest_url: 'https://cdn.example/m.m3u8', manifest_kind: 'hls',
      headers: { referer: 'https://vidfast.vc/', origin: 'https://vidfast.vc', user_agent: 'UA' }, subtitles: [],
    },
    attempts: [],
  };

  it('records open without running the CLI or touching Chrome', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'playcheck-'));
    const spawned: string[][] = [];
    const out: string[] = [];
    const code = await wrapperMain({ cli: '/x/cli.mjs', dir, gate: '' }, ['open', 'http://localhost:7400/stream/s1', '--fullscreen'], {
      spawnCli: async (args: string[]) => {
        spawned.push(args);
        return { code: 0, stdout: '' };
      },
      write: (text: string) => out.push(text),
    });
    expect(code).toBe(0);
    expect(spawned).toEqual([]);
    expect(readFileSync(path.join(dir, 'opened.jsonl'), 'utf8')).toContain('"url":"http://localhost:7400/stream/s1"');
    expect(JSON.parse(out[0]!)).toEqual({ ok: true, opened: false, url: 'http://localhost:7400/stream/s1' });
  });

  it('pins resolve to the provider under test and sends an HLS source through an armed gate', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'playcheck-'));
    writeFileSync(path.join(dir, 'next.json'), '{"only":"VidFast"}');
    const spawned: string[][] = [];
    const out: string[] = [];
    await wrapperMain({ cli: '/x/cli.mjs', dir, gate: 'http://127.0.0.1:47399' }, ['resolve', 'movie', '550', '--only', 'VidLink', '--providers', '/p.json'], {
      spawnCli: async (args: string[]) => {
        spawned.push(args);
        return { code: 0, stdout: JSON.stringify(resolved) };
      },
      fetch: async () => new Response(JSON.stringify({ token: 't1-ab' }), { status: 200, headers: { 'content-type': 'application/json' } }),
      write: (text: string) => out.push(text),
    });
    expect(spawned).toEqual([['resolve', 'movie', '550', '--providers', '/p.json', '--only', 'VidFast']]);
    expect(JSON.parse(out[0]!).source.manifest_url).toBe(gateUrl('http://127.0.0.1:47399', 't1-ab', 'https://cdn.example/m.m3u8'));
  });

  it('leaves a source alone when no gate answers', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'playcheck-'));
    const out: string[] = [];
    await wrapperMain({ cli: '/x/cli.mjs', dir, gate: 'http://127.0.0.1:47399' }, ['resolve', 'movie', '550'], {
      spawnCli: async () => ({ code: 0, stdout: JSON.stringify(resolved) }),
      fetch: async () => {
        throw new Error('connection refused');
      },
      write: (text: string) => out.push(text),
    });
    expect(JSON.parse(out[0]!).source.manifest_url).toBe('https://cdn.example/m.m3u8');
  });

  it('the gate replays the captured headers, rewrites playlists, and expires only the first source', async () => {
    const seen: any[] = [];
    const upstream = http.createServer((req, res) => {
      seen.push({ url: req.url, referer: req.headers.referer, ua: req.headers['user-agent'] });
      if (req.url === '/master.m3u8') {
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080\nv.m3u8\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      res.end(Buffer.from([0x47, 0, 0, 0]));
    });
    await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', () => done()));
    const up = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    let clock = 0;
    const gate = await startGate({ port: 0, expireAfterS: 45, now: () => clock });
    try {
      const register = async () => {
        const res = await fetch(`${gate.url}/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ headers: { referer: 'https://vidfast.vc/', user_agent: 'UA-from-chrome' } }),
        });
        return ((await res.json()) as { token: string }).token;
      };
      const t1 = await register();
      const first = await fetch(gateUrl(gate.url, t1, `${up}/master.m3u8`));
      expect(first.status).toBe(200);
      expect(await first.text()).toContain(gateUrl(gate.url, t1, `${up}/v.m3u8`));
      expect(seen[0]).toEqual({ url: '/master.m3u8', referer: 'https://vidfast.vc/', ua: 'UA-from-chrome' });
      clock = 45_000;
      expect((await fetch(gateUrl(gate.url, t1, `${up}/seg.ts`))).status).toBe(410);
      const t2 = await register();
      const again = await fetch(gateUrl(gate.url, t2, `${up}/seg.ts`));
      expect(again.status).toBe(200);
      expect(new Uint8Array(await again.arrayBuffer())[0]).toBe(0x47);
      expect(gate.stats().tokens.map((t: any) => [t.n, t.served, t.refused])).toEqual([[1, 1, 1], [2, 1, 0]]);
    } finally {
      await gate.close();
      upstream.close();
    }
  });
});

describe('playcheck: the findings block', () => {
  const result = (check: string, provider: string, verdict: string, cause: string | null, at: string): any => ({
    check, provider, ref: { kind: 'movie', tmdbId: 550 }, verdict, cause, at, summary: null, session: { manifest_kind: check === 'dash' ? 'dash' : 'hls' },
    manifest: null, subtitle_source: 'separate', expiry: null,
  });

  it('writes the table between its markers and audits it against the seed', () => {
    const results = [
      result('dash', 'VidLink', 'needs_fix', 'english_track_missing', '2026-11-16T10:00:00.000Z'),
      result('dash', 'VidLink', 'plays', null, '2026-11-16T11:00:00.000Z'),
      result('vidnest', 'VidNest', 'browser_only', 'obfuscated_segments', '2026-11-16T10:10:00.000Z'),
      result('subtitle', 'VidLink', 'plays', null, '2026-11-16T10:20:00.000Z'),
      result('expiry', 'VidFast', 'plays', null, '2026-11-16T10:30:00.000Z'),
    ];
    const block = renderBlock(results);
    expect(block.startsWith(BLOCK_BEGIN)).toBe(true);
    expect(block.endsWith(BLOCK_END)).toBe(true);
    expect(block).toContain('| dash | VidLink | movie 550 | **plays** |');
    expect(block).not.toContain('**needs_fix**');
    const md = replaceBlock('# Findings\n\n## Playback\n\nTo be filled by phase 6.\n\n## Other\n', block);
    expect(md.indexOf(BLOCK_BEGIN)).toBeGreaterThan(md.indexOf('## Playback'));
    expect(md.indexOf('## Other')).toBeGreaterThan(md.indexOf(BLOCK_END));
    expect(replaceBlock(md, block)).toBe(md);
    const seed = [
      { name: 'VidLink', browser_only: false },
      { name: 'VidNest', browser_only: false },
      { name: 'VidFast', browser_only: false },
    ];
    expect(auditFindings(md, seed)).toEqual(['VidNest is browser_only in the findings but browser_only is not true in the seed']);
    expect(auditFindings(md, seed.map((p) => (p.name === 'VidNest' ? { ...p, browser_only: true } : p)))).toEqual([]);
  });

  it('wants a decided row for every check and a Fixes row for an open fix', () => {
    const md = replaceBlock('## Playback\n', renderBlock([result('dash', 'VidLink', 'needs_fix', 'no_progress', '2026-11-16T10:00:00.000Z')]));
    expect(auditFindings(md, [{ name: 'VidLink', browser_only: false }])).toEqual([
      'the vidnest check has no decided result (plays, browser_only, needs_fix, or no_source after 3 runs)',
      'the subtitle check has no decided result (plays, browser_only, needs_fix, or no_source after 3 runs)',
      'the expiry check has no decided result (plays, browser_only, needs_fix, or no_source after 3 runs)',
      'dash/VidLink needs a fix but has no row in the Fixes table',
    ]);
  });
});
