import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_PENDING_LINES,
  StreamEvidence,
  observeForward,
  playerRecord,
  redactQueries,
  sessionSource,
  type EvidenceRecord,
  type EvidenceSink,
  type RequestRecord,
} from '../../../src/directStream/evidence.js';
import type { FetchLike, ForwardRequest } from '../../../src/directStream/passThrough.js';
import { SessionStore, type StreamSession } from '../../../src/directStream/sessions.js';
import type { ResolvedSource, StreamRef } from '../../../src/directStream/types.js';

const REF: StreamRef = { kind: 'tv', tmdbId: 37854, season: 18, episode: 787 };
const SOURCE: ResolvedSource = {
  provider: 'HyperLink',
  embed_url: 'https://hyper.example/tv/37854/18/787?key=EMBEDSECRET',
  manifest_url: 'https://cdn.example:8443/hls/master.m3u8?token=MANIFESTSECRET',
  manifest_kind: 'hls',
  headers: { referer: 'https://hyper.example/', origin: 'https://hyper.example', user_agent: 'Chrome/130 HEADERSECRET' },
  subtitles: [{ url: 'https://subs.example/en.vtt?sig=SUBSECRET', lang: 'en', label: 'English', format: 'vtt', source: 'request' }],
  best_height: 1080,
  en_subtitle: true,
  took_s: 3.1,
};
const SEG = 'https://cdn.example:8443/hls/720/seg-00042.ts?token=SEGSECRET';
/** Nothing of these may ever reach the disk: queries, header values. */
const SECRETS = ['EMBEDSECRET', 'MANIFESTSECRET', 'HEADERSECRET', 'SUBSECRET', 'SEGSECRET', 'ATTEMPTSECRET', 'https://hyper.example'];

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'stream-evidence-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function liveSession(): { store: SessionStore; session: StreamSession } {
  const store = new SessionStore();
  const session = store.create(REF, SOURCE, [
    { provider: 'VidFast', outcome: 'bot_check', took_s: 1.2, detail: 'refused https://vidfast.example/e/1?t=ATTEMPTSECRET' },
    { provider: 'HyperLink', outcome: 'resolved', took_s: 3.1, detail: '' },
  ]);
  return { store, session };
}

function request(target: string, over: Partial<ForwardRequest> = {}): ForwardRequest {
  return { target, range: null, vtt: false, signal: new AbortController().signal, ...over };
}

function answering(make: () => Response | Promise<Response>): { fetchImpl: FetchLike; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetchImpl: async (url) => {
      urls.push(url);
      return make();
    },
  };
}

/** A body of the given chunk sizes that then closes, breaks off, or never ends. */
function chunked(sizes: number[], end: 'close' | 'error' | 'hold' = 'close'): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < sizes.length) {
        c.enqueue(new Uint8Array(sizes[i++]!));
        return;
      }
      if (end === 'close') c.close();
      else if (end === 'error') c.error(new Error('socket hang up'));
      else return new Promise<void>(() => undefined);
    },
  });
}

async function logged(ev: StreamEvidence): Promise<EvidenceRecord[]> {
  await ev.flushed();
  return ev.readTail();
}

const requests = (records: EvidenceRecord[]): RequestRecord[] => records.filter((r): r is RequestRecord => r.type === 'request');

describe('observeForward (R2.1)', () => {
  it('records one line per answer: host and path without the query, status, first byte, bytes, duration and throughput', async () => {
    const ev = new StreamEvidence({ dir: tmp, host: 'laptop' });
    const { session } = liveSession();
    const { fetchImpl, urls } = answering(() => new Response(chunked([400, 600]), { status: 206, headers: { 'content-type': 'video/mp2t', 'content-range': 'bytes 0-999/5000' } }));
    const res = await observeForward(session, request(SEG, { range: 'bytes=0-999' }), fetchImpl, ev);
    expect(res.status).toBe(206);
    expect(res.headers.get('x-notesd-upstream')).toBe('206');
    expect(res.headers.get('content-range')).toBe('bytes 0-999/5000');
    expect((await res.arrayBuffer()).byteLength).toBe(1000);
    expect(urls).toEqual([SEG]);
    const recs = requests(await logged(ev));
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      session: session.id,
      provider: 'HyperLink',
      stream_host: 'cdn.example:8443',
      path: '/hls/720/seg-00042.ts',
      range: 'bytes=0-999',
      kind: 'media',
      status: 206,
      answer: 206,
      bytes: 1000,
      redirects: 0,
      outcome: 'end',
      error: null,
    });
    expect(recs[0]!.ttfb_ms).toBeGreaterThanOrEqual(0);
    expect(recs[0]!.duration_ms).toBeGreaterThanOrEqual(recs[0]!.ttfb_ms ?? 0);
    expect(recs[0]!.kbps).toBeGreaterThan(0);
    expect(await readFile(ev.file, 'utf8')).not.toContain('SEGSECRET');
  });

  it('counts a playlist after its rewrite and marks it hls', async () => {
    const ev = new StreamEvidence({ dir: tmp, host: 'laptop' });
    const { session } = liveSession();
    const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg-1.ts\n';
    const { fetchImpl } = answering(() => new Response(playlist, { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } }));
    const res = await observeForward(session, request('https://cdn.example:8443/hls/720/index.m3u8?token=SEGSECRET'), fetchImpl, ev);
    const text = await res.text();
    expect(text).toContain(`/api/stream/sessions/${session.id}/p?u=`);
    const [rec] = requests(await logged(ev));
    expect(rec).toMatchObject({ kind: 'hls', path: '/hls/720/index.m3u8', status: 200, outcome: 'end', bytes: Buffer.byteLength(text) });
  });

  it('records the player going away mid-body as aborted, with the bytes it got', async () => {
    const ev = new StreamEvidence({ dir: tmp, host: 'laptop' });
    const { session } = liveSession();
    const { fetchImpl } = answering(() => new Response(chunked([500], 'hold'), { status: 200 }));
    const res = await observeForward(session, request(SEG), fetchImpl, ev);
    const reader = res.body!.getReader();
    expect((await reader.read()).value?.byteLength).toBe(500);
    await reader.cancel();
    const [rec] = requests(await logged(ev));
    expect(rec).toMatchObject({ outcome: 'aborted', bytes: 500, status: 200, error: 'the player went away' });
  });

  it('records a stream host that breaks off mid-body as an error, and the player sees it break', async () => {
    const ev = new StreamEvidence({ dir: tmp, host: 'laptop' });
    const { session } = liveSession();
    const { fetchImpl } = answering(() => new Response(chunked([300], 'error'), { status: 200 }));
    const res = await observeForward(session, request(SEG), fetchImpl, ev);
    await expect(res.arrayBuffer()).rejects.toThrow();
    const [rec] = requests(await logged(ev));
    expect(rec).toMatchObject({ outcome: 'error', bytes: 300 });
    expect(rec!.error).toContain('socket hang up');
  });

  it("records notesd's own refusals at once: a foreign host (nothing fetched) and a host that does not answer", async () => {
    const ev = new StreamEvidence({ dir: tmp, host: 'laptop' });
    const { session } = liveSession();
    const { fetchImpl, urls } = answering(() => Promise.reject(new Error('connect ECONNREFUSED')));
    const foreign = await observeForward(session, request('https://evil.example/x.ts?token=SEGSECRET'), fetchImpl, ev);
    expect(foreign.status).toBe(403);
    expect(urls).toEqual([]);
    const silent = await observeForward(session, request(SEG), fetchImpl, ev);
    expect(silent.status).toBe(502);
    const recs = requests(await logged(ev));
    expect(recs[0]).toMatchObject({ outcome: 'refused', answer: 403, status: null, stream_host: 'evil.example', path: '/x.ts', ttfb_ms: null });
    expect(recs[0]!.error).toMatch(/^forbidden_host: /);
    expect(recs[1]).toMatchObject({ outcome: 'refused', answer: 502, status: null, stream_host: 'cdn.example:8443', ttfb_ms: null });
    expect(recs[1]!.error).toBe('upstream_error: The stream host did not answer: connect ECONNREFUSED');
    expect(await readFile(ev.file, 'utf8')).not.toContain('SEGSECRET');
  });
});

describe('the evidence log (R2.4)', () => {
  it('record() returns before anything touches the disk', async () => {
    const ev = new StreamEvidence({ dir: path.join(tmp, 'movies'), host: 'laptop' });
    ev.record(playerRecord('S'.repeat(32), { text: 'error: x' }));
    expect(existsSync(ev.file)).toBe(false);
    await ev.flushed();
    expect(existsSync(ev.file)).toBe(true);
  });

  it('rotates into .1.jsonl past its cap, like the VLC health log, and reads across both files', async () => {
    const ev = new StreamEvidence({ dir: tmp, host: 'laptop', maxBytes: 1500 });
    expect(path.basename(ev.file)).toBe('stream-evidence-laptop.jsonl');
    expect(path.basename(ev.previousFile)).toBe('stream-evidence-laptop.1.jsonl');
    for (let i = 0; i < 20; i += 1) {
      ev.record(playerRecord('S'.repeat(32), { text: `line ${i} ${'x'.repeat(100)}` }));
      await ev.flushed();
    }
    expect(existsSync(ev.previousFile)).toBe(true);
    expect((await stat(ev.file)).size).toBeLessThanOrEqual(1500);
    const numbers = (await ev.readTail()).map((r) => (r.type === 'player' ? Number(r.text.split(' ')[1]) : -1));
    expect(numbers.at(-1)).toBe(19);
    expect(numbers).toEqual(numbers.map((_, k) => 20 - numbers.length + k));
  });

  it('repairs a torn last line before it appends', async () => {
    const ev = new StreamEvidence({ dir: tmp, host: 'laptop' });
    await writeFile(ev.file, '{"type":"player","at":"2026');
    ev.record(playerRecord('S'.repeat(32), { text: 'after the crash' }));
    const recs = await logged(ev);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ type: 'player', text: 'after the crash' });
  });

  it('a log that cannot be written never fails or holds up an answer, and says so once a minute', async () => {
    const blocker = path.join(tmp, 'blocker');
    await writeFile(blocker, 'not a folder');
    const warnings: string[] = [];
    const ev = new StreamEvidence({ dir: path.join(blocker, 'movies'), host: 'laptop', log: (l) => warnings.push(l) });
    const { session } = liveSession();
    const { fetchImpl } = answering(() => new Response(chunked([1000]), { status: 200 }));
    const res = await observeForward(session, request(SEG), fetchImpl, ev);
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(1000);
    await expect(ev.flushed()).resolves.toBeUndefined();
    expect(ev.failures).toBe(1);
    expect(warnings).toEqual([expect.stringContaining('[notesd] stream evidence: could not write')]);
    ev.record(playerRecord(session.id, { text: 'again' }));
    await ev.flushed();
    expect(ev.failures).toBe(2);
    expect(warnings).toHaveLength(1);
    // A sink that throws is ignored just the same.
    const throwing: EvidenceSink = {
      record: () => {
        throw new Error('disk on fire');
      },
    };
    const again = await observeForward(session, request(SEG), fetchImpl, throwing);
    expect((await again.arrayBuffer()).byteLength).toBe(1000);
  });

  it('drops lines past its backlog instead of growing without bound', async () => {
    const ev = new StreamEvidence({ dir: tmp, host: 'laptop' });
    for (let i = 0; i < MAX_PENDING_LINES + 10; i += 1) ev.record(playerRecord('S'.repeat(32), { text: `l${i}` }));
    expect(ev.dropped).toBeGreaterThan(0);
    await ev.flushed();
  });
});

describe('what evidence keeps of addresses and sessions (invariant 3)', () => {
  it('cuts the query off every address in free text', () => {
    expect(redactQueries('fragLoadError https://cdn.example/a/seg-1.ts?token=abc&e=1 at 61 s')).toBe('fragLoadError https://cdn.example/a/seg-1.ts at 61 s');
    expect(redactQueries('GET /api/stream/sessions/abc/p?u=https%3A%2F%2Fcdn%2Fx.ts%3Ftoken%3Dabc failed')).toBe('GET /api/stream/sessions/abc/p failed');
    expect(redactQueries('what? nothing to cut')).toBe('what? nothing to cut');
  });

  it("keeps a session's source as hosts and paths, header names only, and its refreshes", () => {
    const { store, session } = liveSession();
    store.replaceSource(session, SOURCE, session.attempts);
    const src = sessionSource(session, store.expiresAt(session));
    expect(src).toMatchObject({
      provider: 'HyperLink',
      ref: 'TMDB tv 37854 S18E787',
      embed: { host: 'hyper.example', path: '/tv/37854/18/787' },
      manifest: { host: 'cdn.example:8443', path: '/hls/master.m3u8' },
      subtitles: [{ host: 'subs.example', path: '/en.vtt', lang: 'en' }],
      captured_headers: ['referer', 'origin', 'user_agent'],
      refreshes: 1,
    });
    expect(src.hosts).toEqual(['cdn.example:8443', 'subs.example']);
    expect(src.attempts[0]!.detail).toBe('refused https://vidfast.example/e/1');
    const text = JSON.stringify(src);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  });
});

describe('snapshot (R2.3)', () => {
  it("writes the session's source, its records and the page's lines into one new folder", async () => {
    const { store, session } = liveSession();
    const other = store.create(REF, SOURCE, []);
    const ev = new StreamEvidence({
      dir: tmp,
      host: 'laptop',
      source: (id) => {
        const s = store.peek(id);
        return s === null ? null : sessionSource(s, store.expiresAt(s));
      },
      now: () => new Date('2026-11-16T12:58:45Z'),
    });
    const { fetchImpl } = answering(() => new Response(chunked([1000]), { status: 200 }));
    await (await observeForward(session, request(SEG), fetchImpl, ev)).arrayBuffer();
    await (await observeForward(other, request(SEG), fetchImpl, ev)).arrayBuffer();
    ev.record(playerRecord(session.id, { text: 'error: networkError fragLoadError https://cdn.example:8443/x.ts?token=SEGSECRET', stage: 'error', position_s: 61.2, buffer_s: 0 }));
    const snap = await ev.snapshot(session.id);
    expect(snap).toEqual({
      dir: path.join(tmp, 'stream-reports', `20261116-125845-${session.id.slice(0, 6)}`),
      session_id: session.id,
      complete: true,
      records: 1,
      player_lines: 1,
    });
    expect((await readdir(snap.dir)).sort()).toEqual(['evidence.jsonl', 'player.json', 'session.json']);
    const sessionJson = JSON.parse(await readFile(path.join(snap.dir, 'session.json'), 'utf8')) as Record<string, unknown>;
    expect(sessionJson).toMatchObject({ session_id: session.id, host: 'laptop', live: true, source: { provider: 'HyperLink', refreshes: 0 } });
    const trail = (await readFile(path.join(snap.dir, 'evidence.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(trail).toEqual([expect.objectContaining({ type: 'request', session: session.id, path: '/hls/720/seg-00042.ts' })]);
    const player = JSON.parse(await readFile(path.join(snap.dir, 'player.json'), 'utf8')) as { lines: Record<string, unknown>[] };
    expect(player.lines).toEqual([expect.objectContaining({ text: 'error: networkError fragLoadError https://cdn.example:8443/x.ts', position_s: 61.2 })]);
    const files = await Promise.all((await readdir(snap.dir)).map((f) => readFile(path.join(snap.dir, f), 'utf8')));
    for (const secret of SECRETS) expect(files.join('\n')).not.toContain(secret);
    // A second snapshot in the same second gets its own folder.
    expect((await ev.snapshot(session.id)).dir).toBe(`${snap.dir}-2`);
  });

  it('a session that has ended leaves its log records, and the snapshot says it is not complete', async () => {
    const { session } = liveSession();
    const ev = new StreamEvidence({ dir: tmp, host: 'laptop', source: () => null });
    const { fetchImpl } = answering(() => new Response(chunked([10]), { status: 200 }));
    await (await observeForward(session, request(SEG), fetchImpl, ev)).arrayBuffer();
    const snap = await ev.snapshot(session.id);
    expect(snap).toMatchObject({ session_id: session.id, complete: false, records: 1, player_lines: 0 });
    expect(JSON.parse(await readFile(path.join(snap.dir, 'session.json'), 'utf8'))).toMatchObject({ live: false, source: null });
  });

  it("without a session id: the stream on screen, else the newest record's session, else none", async () => {
    let onScreen: string | null = null;
    const ev = new StreamEvidence({ dir: tmp, host: 'laptop', onScreen: () => onScreen });
    const none = await ev.snapshot(null);
    expect(none).toMatchObject({ session_id: null, complete: false, records: 0, player_lines: 0 });
    expect(path.basename(none.dir)).toMatch(/^\d{8}-\d{6}-none$/);
    ev.record(playerRecord('B'.repeat(32), { text: 'x' }));
    expect((await ev.snapshot(null)).session_id).toBe('B'.repeat(32));
    onScreen = 'C'.repeat(32);
    expect((await ev.snapshot(null)).session_id).toBe('C'.repeat(32));
  });
});
