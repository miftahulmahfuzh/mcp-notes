import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { bestVariant, download, measureStream, netcheck, parseArgs, probeHost, targetHost } from '../../../claude/skills/report-stream-bug/netcheck.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { CAUSES, classify, daemonFacts, noteBody, readFolder, summarize, torrentFacts } from '../../../claude/skills/report-stream-bug/diagnose.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SKILL = path.join(REPO, 'claude', 'skills', 'report-stream-bug');
const COLLECT = path.join(SKILL, 'collect.sh');
const NETCHECK = path.join(SKILL, 'netcheck.mjs');
const FIXTURES = path.join(REPO, 'tests', 'fixtures', 'stream-report');
const SID = 'test0session0id0for0collect0sh01';
const SECRET = 'SECRET123token';
const SEGMENT = Buffer.alloc(500_000, 7);
const REFERENCE = Buffer.alloc(2_000_000, 1);
const run = promisify(execFile);

interface Seen {
  method: string;
  path: string;
  origin: string | null;
}
const seen: Seen[] = [];
let server: http.Server;
let base = '';
let snapshotDir = '';

const streamAddress = (p: string): string => `${base}${p}?token=${SECRET}`;
const pass = (p: string): string => `/api/stream/sessions/${SID}/p?u=${encodeURIComponent(streamAddress(p))}`;

/** A phase 1 `request` record (src/directStream/evidence.ts). */
function passRecord(p: string): Record<string, unknown> {
  return {
    type: 'request', at: '2026-11-16T04:00:00.000Z', session: SID, provider: 'HyperLink', stream_host: new URL(base).host, path: p, range: null, kind: 'media',
    status: 200, answer: 200, ttfb_ms: 20, bytes: 500_000, duration_ms: 100, kbps: 40_000, redirects: 0, outcome: 'end', error: null,
  };
}

/** A phase 1 snapshot folder: session.json {session_id, host, taken_at, live, source, sessions}, evidence.jsonl, player.json {session_id, lines}. */
function writeSnapshot(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const source = { session_id: SID, ref: 'TMDB tv 1 S01E01', provider: 'HyperLink', attempts: [], hosts: [new URL(base).host], refreshes: 0 };
  writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ session_id: SID, host: hostname(), taken_at: '2026-11-16T04:00:11.000Z', live: true, source, sessions: [] }));
  writeFileSync(path.join(dir, 'evidence.jsonl'), `${JSON.stringify(passRecord('/cdn/seg0.ts'))}\n`);
  const line = { type: 'player', at: '2026-11-16T04:00:10.000Z', session: SID, text: 'error: networkError fragLoadError', page_at: '2026-11-16T04:00:10.000Z', stage: 'error', position_s: 12, buffer_s: 0 };
  writeFileSync(path.join(dir, 'player.json'), JSON.stringify({ session_id: SID, lines: [line] }));
}

function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', base);
  seen.push({ method: req.method ?? 'GET', path: url.pathname, origin: req.headers.origin ?? null });
  const send = (status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': type, ...headers });
    res.end(body);
  };
  const json = (status: number, body: unknown): void => send(status, 'application/json', JSON.stringify(body));
  if (url.pathname === '/health') return json(200, { ok: true });
  if (url.pathname === '/ref.bin') return send(200, 'application/octet-stream', REFERENCE);
  if (url.pathname === '/') return send(403, 'text/plain', 'no');
  if (url.pathname === `/api/stream/sessions/${SID}`) {
    return json(200, { session_id: SID, provider: 'HyperLink', manifest_kind: 'hls', manifest_url: pass('/cdn/master.m3u8') });
  }
  if (url.pathname === `/api/stream/sessions/${SID}/p`) {
    const target = new URL(url.searchParams.get('u') ?? 'http://invalid/');
    const up = (status: number): Record<string, string> => ({ 'x-notesd-upstream': String(status) });
    if (target.searchParams.get('token') !== SECRET) return send(403, 'text/plain', 'token expired', up(403));
    if (target.pathname === '/cdn/master.m3u8') {
      const master = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=800000,AVERAGE-BANDWIDTH=9000000', pass('/cdn/low.m3u8'), '#EXT-X-STREAM-INF:BANDWIDTH=5000000', pass('/cdn/high.m3u8'), ''];
      return send(200, 'application/vnd.apple.mpegurl', master.join('\n'), up(200));
    }
    if (target.pathname === '/cdn/high.m3u8') {
      const media = ['#EXTM3U', '#EXT-X-TARGETDURATION:4', ...[0, 1, 2, 3].flatMap((i) => ['#EXTINF:4,', pass(`/cdn/seg${i}.ts`)]), '#EXT-X-ENDLIST', ''];
      return send(200, 'application/vnd.apple.mpegurl', media.join('\n'), up(200));
    }
    if (/^\/cdn\/seg\d\.ts$/.test(target.pathname)) return send(200, 'video/mp2t', SEGMENT, up(200));
    return send(500, 'text/plain', 'broken', up(500));
  }
  if (url.pathname.startsWith('/api/stream/sessions/')) return json(403, { error: 'unknown_session' });
  if (url.pathname === '/api/stream/evidence' && req.method === 'GET') return json(200, { host: hostname(), file: '/x/stream-evidence.jsonl', records: [passRecord('/cdn/seg1.ts')] });
  if (url.pathname === '/api/stream/evidence/snapshot' && req.method === 'POST') {
    writeSnapshot(snapshotDir);
    return json(200, { ok: true, dir: snapshotDir, session_id: SID, complete: true, records: 1, player_lines: 1 });
  }
  return json(404, { error: 'not_found' });
}

async function closedPort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

async function collect(args: string[]): Promise<string> {
  const { stdout } = await run('bash', [COLLECT, ...args], { timeout: 60_000, maxBuffer: 8_000_000 });
  return stdout;
}

const evidenceDir = (stdout: string): string => /^evidence: (.+)$/m.exec(stdout)?.[1] ?? '';

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

function dataDirWithLogs(): { data: string; log: string } {
  const data = mkdtempSync(path.join(tmpdir(), 'report-stream-bug-'));
  mkdirSync(path.join(data, 'movies', 'stream-reports'), { recursive: true });
  const other = { ...passRecord('/cdn/other.ts'), session: 'another0session0id00000000000001' };
  writeFileSync(path.join(data, 'movies', `stream-evidence-${hostname()}.jsonl`), `${JSON.stringify(passRecord('/cdn/seg-tail.ts'))}\n${JSON.stringify(other)}\n`);
  const log = path.join(data, 'daemon.log');
  writeFileSync(
    log,
    [
      '[notesd] direct stream: tv 37854 S18E787 resolved by HyperLink (hls, 1080p) after 22 tries',
      `[notesd] direct stream: did not resolve: upstream https://cdn.fixture.example/m.m3u8?token=${SECRET} refused`,
      'notesd listening on http://127.0.0.1:7317',
      '',
    ].join('\n'),
  );
  return { data, log };
}

beforeAll(async () => {
  server = http.createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen.length = 0;
});

describe('netcheck.mjs', () => {
  it('downloads the reference and stops at the byte cap', async () => {
    const r = await download(`${base}/ref.bin`, { maxBytes: 500_000, maxSeconds: 5 });
    expect(r).toMatchObject({ ok: true, status: 200, truncated: true, error: null });
    expect(r.bytes).toBeGreaterThanOrEqual(500_000);
    expect(r.bytes).toBeLessThan(REFERENCE.length);
    expect(r.mbps).toBeGreaterThan(0);
  });

  it('picks the variant with the highest BANDWIDTH, not AVERAGE-BANDWIDTH', () => {
    const text = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=800000,AVERAGE-BANDWIDTH=9000000', 'low.m3u8', '#EXT-X-STREAM-INF:BANDWIDTH=5000000', 'high.m3u8', ''].join('\n');
    expect(bestVariant(text, 'https://cdn.example/hls/master.m3u8')).toEqual({ bandwidth: 5_000_000, url: 'https://cdn.example/hls/high.m3u8' });
    expect(bestVariant('#EXTM3U\n#EXTINF:4,\nseg0.ts\n', 'https://cdn.example/a.m3u8')).toBeNull();
  });

  it('names the stream host of a pass-through address and nothing else', () => {
    expect(targetHost(`${base}${pass('/cdn/seg0.ts')}`)).toBe(new URL(base).host);
    expect(targetHost(`${base}/api/stream/sessions/${SID}`)).toBeNull();
  });

  it('measures the stream host through a live session and keeps no token', async () => {
    const out = await netcheck(parseArgs(['--reference', `${base}/ref.bin`, '--daemon', base, '--session', SID, '--host', new URL(base).host, '--host-scheme', 'http']));
    expect(out.reference).toMatchObject({ ok: true, status: 200, bytes: REFERENCE.length });
    expect(out.stream).toMatchObject({ ok: true, kind: 'hls', host: new URL(base).host, variant_bandwidth: 5_000_000, segments_tried: 2, segments_ok: 2, bytes: 1_000_000, statuses: { '200': 2 } });
    expect(out.stream_skipped).toBeNull();
    expect(out.host_probe).toMatchObject({ ok: true, status: 403 });
    const text = JSON.stringify(out);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('p?u=');
  });

  it('reports an ended session instead of measuring it', async () => {
    const r = await measureStream({ daemon: base, session: 'gone0session0id00000000000000001', maxBytes: 1_000_000, maxSeconds: 5 });
    expect(r).toEqual({ ok: false, reason: 'session_ended', status: 403 });
  });

  it('a host that does not answer is a failed probe, not a crash', async () => {
    const r = await probeHost(`127.0.0.1:${await closedPort()}`, { scheme: 'http', maxSeconds: 2 });
    expect(r).toMatchObject({ ok: false, status: null });
    expect(typeof r.error).toBe('string');
  });

  it('prints the same JSON from the command line, without the token', async () => {
    const { stdout } = await run(process.execPath, [NETCHECK, '--reference', `${base}/ref.bin`, '--daemon', base, '--session', SID], { timeout: 30_000 });
    expect(JSON.parse(stdout).stream).toMatchObject({ ok: true, segments_ok: 2 });
    expect(stdout).not.toContain(SECRET);
  }, 30_000);
});

describe('diagnose.mjs', () => {
  it.each(Object.keys(CAUSES))('names %s from its fixture folder', (cause) => {
    expect(classify(readFolder(path.join(FIXTURES, cause))).cause).toBe(cause);
  });

  it('reads a torrent session by its swarm: what it delivers against the film\'s bitrate, the peers, and the plays that never started', () => {
    const ev = readFolder(path.join(FIXTURES, 'torrent_swarm_slow'));
    expect(torrentFacts(ev)).toMatchObject({ state: 'downloading', bitrateMbps: 2.64, swarmMbps: 1.75, peers: 3 });
    expect(daemonFacts(ev)).toEqual({
      starts: ['Nov 17 03:47:06'],
      plays: [
        { at: 'Nov 17 03:47:04', ref: 'TMDB movie 818647', candidates: 6, played: null },
        { at: 'Nov 17 03:51:02', ref: 'TMDB movie 818647', candidates: 6, played: null },
        { at: 'Nov 17 03:55:44', ref: 'TMDB movie 818647', candidates: 6, played: 'Through My Window 2022 1080p WEBRip' },
      ],
    });
    const cls = classify(ev);
    expect(cls.signals.join('\n')).toMatch(/the swarm delivers 1\.75 Mbps and the film needs 2\.64 Mbps/);
    expect(cls.signals.join('\n')).toMatch(/2 earlier torrent play\(s\) of it found no torrent that played in time/);
    const summary = summarize(ev);
    expect(summary).toContain('slow step: Index: yts error after 6 s');
    expect(summary).toContain('daemon starts in the log window');
    // A torrent has no stream host: nothing about one is reported missing.
    expect(ev.missing.join('\n')).not.toMatch(/pass-through|stream host/);
    expect(noteBody(ev, 'it took three tries')).toContain('swarm 1.75 Mbps, film 2.64 Mbps, 3 peer(s)');
  });

  it('leaves a torrent session on a slow connection to connection_slow, and one that keeps up to no known cause', () => {
    const ev = readFolder(path.join(FIXTURES, 'torrent_swarm_slow'));
    expect(classify({ ...ev, network: { ...ev.network, reference: { ok: true, mbps: 2 } } }).cause).toBe('connection_slow');
    const fast = ev.torrentSamples.map((x: Record<string, unknown>, i: number) => ({ ...x, peers: 40, bytes_done: 91_980_620 + i * 20_000_000 }));
    expect(classify({ ...ev, torrentSamples: fast }).cause).toBe('new');
  });

  it('writes a plain-text note that names the cause and ends with #stream-bug', () => {
    const body: string = noteBody(readFolder(path.join(FIXTURES, 'host_slow')), 'laggy, then stopped');
    expect(body).toContain(`Cause: ${CAUSES.host_slow}.`);
    expect(body).toContain('What was seen: laggy, then stopped');
    expect(body.split('\n').at(-1)).toBe('#stream-bug #direct-stream #mcp-notes');
    expect(body).not.toMatch(/\?u=|token=/);
  });

  it('does not count requests made after the measurement started', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'report-stream-bug-cutoff-'));
    writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ session_id: SID, live: true, source: { provider: 'HyperLink', refreshes: 0 }, sessions: [] }));
    const fast = { ...passRecord('/seg1.ts'), stream_host: 'cdn.fixture.example', ttfb_ms: 100, bytes: 1_800_000, duration_ms: 600, kbps: 24_000 };
    const ours = { ...fast, at: '2026-11-16T05:00:01.000Z', path: '/seg2.ts', status: 403, answer: 403, bytes: 0, kbps: null };
    writeFileSync(path.join(dir, 'evidence.jsonl'), `${JSON.stringify(fast)}\n${JSON.stringify(ours)}\n`);
    writeFileSync(path.join(dir, 'network.json'), JSON.stringify({ measured_at: '2026-11-16T05:00:00.000Z', reference: { url: 'https://ref.example/', ok: true, status: 200, mbps: 85, ttfb_ms: 40 }, stream: null, stream_skipped: 'no_daemon', host_probe: null }));
    expect(classify(readFolder(dir)).cause).toBe('new');
  });

  it("reads the page's own log from report.json when the session had ended", () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'report-stream-bug-report-'));
    writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ session_id: SID, live: false, source: null, sessions: [] }));
    writeFileSync(path.join(dir, 'player.json'), JSON.stringify({ session_id: SID, lines: [] }));
    const page = { stage: 'error', error: 'session_over', errors: ['session_over'], log: ['error: session_over'], title: 'One Piece S18E787', position_s: 1312.4 };
    writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ session_id: SID, dir, complete: false, page, result: { outcome: 'opened', window: '@7' } }));
    const ev = readFolder(dir);
    expect(ev.playerLines).toContain('error: session_over');
    expect(ev.session?.title).toBe('One Piece S18E787');
    expect(classify(ev).cause).toBe('session_ended');
  });

  it('says what is missing when the session had ended', () => {
    const text: string = summarize(readFolder(path.join(FIXTURES, 'session_ended')));
    expect(text).toContain('cause: The session ended (session_ended)');
    expect(text).toContain('missing:');
    expect(text).toContain('the session had ended when the snapshot was taken');
  });
});

describe('collect.sh', () => {
  it('without a folder asks the daemon for a snapshot, sending the daemon its own Origin', async () => {
    const { data, log } = dataDirWithLogs();
    snapshotDir = path.join(data, 'movies', 'stream-reports', '20261116-040000-test0s');
    const stdout = await collect(['--wall', base, '--data-dir', data, '--log', log, '--reference', `${base}/ref.bin`, '--host-scheme', 'http']);
    expect(evidenceDir(stdout)).toBe(snapshotDir);
    const posts = seen.filter((s) => s.method === 'POST');
    expect(posts).toEqual([{ method: 'POST', path: '/api/stream/evidence/snapshot', origin: base }]);
    for (const f of ['session.json', 'evidence.jsonl', 'player.json', 'snapshot-answer.json', 'evidence-latest.json', 'evidence-tail.jsonl', 'notesd.log', 'network.json', 'missing.txt', 'summary.txt']) {
      expect(existsSync(path.join(snapshotDir, f)), f).toBe(true);
    }
    expect(readFileSync(path.join(snapshotDir, 'summary.txt'), 'utf8')).toMatch(/^cause: /m);
  }, 60_000);

  it('with a folder adds to it, asks for no snapshot and writes no token anywhere', async () => {
    const { data, log } = dataDirWithLogs();
    const folder = path.join(data, 'movies', 'stream-reports', '20261116-040000-test0s');
    writeSnapshot(folder);
    const stdout = await collect([folder, '--wall', base, '--log', log, '--reference', `${base}/ref.bin`, '--host-scheme', 'http']);
    expect(evidenceDir(stdout)).toBe(folder);
    expect(readdirSync(path.join(data, 'movies', 'stream-reports'))).toEqual(['20261116-040000-test0s']);
    expect(seen.some((s) => s.method === 'POST')).toBe(false);
    expect(seen.some((s) => s.path === '/api/stream/evidence')).toBe(true);
    const network = JSON.parse(readFileSync(path.join(folder, 'network.json'), 'utf8'));
    expect(network.stream).toMatchObject({ ok: true, host: new URL(base).host, segments_ok: 2 });
    expect(network.host_probe).toMatchObject({ ok: true, host: new URL(base).host });
    const tail = readFileSync(path.join(folder, 'evidence-tail.jsonl'), 'utf8');
    expect(tail).toContain('seg-tail.ts');
    expect(tail).not.toContain('another0session0id');
    expect(readFileSync(path.join(folder, 'notesd.log'), 'utf8')).toContain('resolved by HyperLink');
    for (const f of filesUnder(folder)) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toContain(SECRET);
      expect(text, f).not.toContain('p?u=');
    }
    expect(stdout).not.toContain(SECRET);
  }, 60_000);

  it('with the daemon down still writes the log tail, the measurement and what is missing', async () => {
    const { data, log } = dataDirWithLogs();
    const stdout = await collect(['--wall', `http://127.0.0.1:${await closedPort()}`, '--data-dir', data, '--log', log, '--reference', `${base}/ref.bin`]);
    const dir = evidenceDir(stdout);
    expect(path.dirname(dir)).toBe(path.join(data, 'movies', 'stream-reports'));
    expect(path.basename(dir)).toMatch(/^\d{8}-\d{6}-collect$/);
    const network = JSON.parse(readFileSync(path.join(dir, 'network.json'), 'utf8'));
    expect(network.reference).toMatchObject({ ok: true, bytes: REFERENCE.length });
    expect(network.stream_skipped).toBe('no_session');
    expect(readFileSync(path.join(dir, 'evidence-tail.jsonl'), 'utf8')).toContain('seg-tail.ts');
    const daemonLines = readFileSync(path.join(dir, 'notesd.log'), 'utf8');
    expect(daemonLines).toContain('resolved by HyperLink');
    expect(daemonLines).not.toContain(SECRET);
    expect(daemonLines).not.toContain('listening');
    const summary = readFileSync(path.join(dir, 'summary.txt'), 'utf8');
    expect(summary).toContain('missing:');
    expect(summary).toContain('did not answer');
    expect(summary).toMatch(/^cause: /m);
  }, 60_000);
});
