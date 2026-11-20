import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { directStreamScriptRunner, parseOpenOutput, parseResolveOutput } from '../../../src/directStream/runner.js';
import { DirectStreamError } from '../../../src/directStream/types.js';

const FAKE_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/direct-stream/fake-cli.mjs');

const RESOLVED = {
  ok: true,
  kind: 'movie',
  tmdb_id: 550,
  season: null,
  episode: null,
  source: {
    provider: 'VidFast',
    embed_url: 'https://vidfast.pro/movie/550?autoPlay=true',
    manifest_url: 'https://cdn.example/hls/master.m3u8',
    manifest_kind: 'hls',
    headers: { referer: 'https://vidfast.vc/', origin: null, user_agent: 'Mozilla/5.0 Chrome/130' },
    subtitles: [
      { url: 'https://subs.example/en.vtt', lang: 'en', label: 'English', format: 'VTT', source: 'request' },
      { url: 'blob:https://vidfast.pro/abc', lang: 'en', label: 'English', format: 'vtt', source: 'request' },
    ],
    best_height: 2160,
    took_s: 2.3,
  },
  attempts: [
    { provider: 'VidNest', outcome: 'skipped_browser_only', took_s: null, detail: '' },
    { provider: 'VidFast', outcome: 'resolved', took_s: 2.3, detail: '' },
  ],
};

describe('parseResolveOutput', () => {
  it('reads a resolved answer, drops subtitle tracks that are not http(s) and computes en_subtitle', () => {
    const out = parseResolveOutput(RESOLVED);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.source.headers).toEqual({ referer: 'https://vidfast.vc/', origin: null, user_agent: 'Mozilla/5.0 Chrome/130' });
    expect(out.source.subtitles).toEqual([{ url: 'https://subs.example/en.vtt', lang: 'en', label: 'English', format: 'vtt', source: 'request' }]);
    expect(out.source.en_subtitle).toBe(true);
    expect(out.attempts.map((a) => a.outcome)).toEqual(['skipped_browser_only', 'resolved']);
  });

  it("reads what the stream speaks, and a provider skipped as a dub", () => {
    const audio = { languages: ['en', 'ko'], tracks: 2, original: true, track: { lang: 'kor', label: 'Korean' } };
    const out = parseResolveOutput({
      ...RESOLVED,
      source: { ...RESOLVED.source, audio },
      attempts: [{ provider: 'HyperLink', outcome: 'dubbed', took_s: 10.2, detail: 'audio is en, the original is ko' }, ...RESOLVED.attempts],
    });
    expect(out.ok && out.source.audio).toEqual(audio);
    expect(out.attempts[0]).toEqual({ provider: 'HyperLink', outcome: 'dubbed', took_s: 10.2, detail: 'audio is en, the original is ko' });
    const plain = parseResolveOutput(RESOLVED);
    expect(plain.ok && plain.source.audio).toBeNull();
    const muxed = parseResolveOutput({ ...RESOLVED, source: { ...RESOLVED.source, audio: { languages: [], tracks: 0, original: null, track: null } } });
    expect(muxed.ok && muxed.source.audio).toEqual({ languages: [], tracks: 0, original: null, track: null });
  });

  it('reads a failure with every attempt', () => {
    const out = parseResolveOutput({ ok: false, source: null, error: 'no_source', attempts: [{ provider: 'Videasy', outcome: 'bot_check', took_s: 4, detail: 'Just a moment...' }] });
    expect(out).toEqual({ ok: false, source: null, error: 'no_source', detail: '', attempts: [{ provider: 'Videasy', outcome: 'bot_check', took_s: 4, detail: 'Just a moment...' }] });
  });

  it('refuses an answer it cannot read as resolve_failed / bad_output', () => {
    const bad = { ...RESOLVED, source: { ...RESOLVED.source, manifest_url: 'blob:https://x/1' } };
    try {
      parseResolveOutput(bad);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DirectStreamError);
      expect((err as DirectStreamError).code).toBe('resolve_failed');
      expect((err as DirectStreamError).reason).toBe('bad_output');
    }
  });

  it('reads the open answers', () => {
    expect(parseOpenOutput({ ok: true, url: 'http://localhost:7317/stream/x', fullscreen: true })).toEqual({ ok: true });
    expect(parseOpenOutput({ ok: false, url: 'x', error: 'chrome_not_reachable', detail: 'port 9333' })).toEqual({ ok: false, error: 'chrome_not_reachable', detail: 'port 9333' });
    expect(parseOpenOutput('nonsense')).toMatchObject({ ok: false, error: 'bad_output' });
  });

  it('reads the seek-preview track with its own headers, and none from an older resolver', () => {
    const thumbnails = { url: 'https://img.example/vd/1/thumbs.vtt?tok=1', referer: 'https://player.example/', origin: '', user_agent: 'Chrome/142' };
    const out = parseResolveOutput({ ...RESOLVED, source: { ...RESOLVED.source, thumbnails } });
    expect(out.ok && out.source.thumbnails).toEqual({ url: 'https://img.example/vd/1/thumbs.vtt?tok=1', referer: 'https://player.example/', origin: null, user_agent: 'Chrome/142' });
    const older = parseResolveOutput(RESOLVED);
    expect(older.ok && older.source.thumbnails).toBeNull();
  });

  it('keeps the resolve when its seek-preview track does not fit: no track', () => {
    for (const thumbnails of [{ url: 'blob:https://player.example/1' }, { url: 42 }, 'thumbs.vtt']) {
      const out = parseResolveOutput({ ...RESOLVED, source: { ...RESOLVED.source, thumbnails } });
      expect(out.ok).toBe(true);
      expect(out.ok && out.source.thumbnails).toBeNull();
      expect(out.ok && out.source.manifest_url).toBe('https://cdn.example/hls/master.m3u8');
    }
  });
});

describe('directStreamScriptRunner', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'direct-stream-runner-'));
  });
  afterEach(async () => {
    delete process.env.DIRECT_STREAM_FAKE_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it('passes the arguments and returns the printed JSON, also on a non-zero exit', async () => {
    const ok = path.join(dir, 'ok.mjs');
    await writeFile(ok, 'console.log(JSON.stringify({ ok: true, argv: process.argv.slice(2) }));');
    expect(await directStreamScriptRunner({ cliPath: ok })(['open', 'http://localhost:1/stream/x', '--fullscreen'])).toEqual({ ok: true, argv: ['open', 'http://localhost:1/stream/x', '--fullscreen'] });
    const failing = path.join(dir, 'fail.mjs');
    await writeFile(failing, 'console.log(JSON.stringify({ ok: false, error: "no_source", attempts: [] })); process.exitCode = 1;');
    expect(await directStreamScriptRunner({ cliPath: failing })(['resolve', 'movie', '1'])).toEqual({ ok: false, error: 'no_source', attempts: [] });
    const silent = path.join(dir, 'silent.mjs');
    await writeFile(silent, 'process.exitCode = 1;');
    await expect(directStreamScriptRunner({ cliPath: silent })([])).rejects.toThrow(/direct stream script failed/);
  });

  it('runs the fixture fake resolver end to end', async () => {
    process.env.DIRECT_STREAM_FAKE_DIR = dir;
    await writeFile(path.join(dir, 'upstream.json'), JSON.stringify({ origin: 'http://127.0.0.1:9' }));
    const providers = path.join(dir, 'providers.json');
    await writeFile(providers, JSON.stringify([{ name: 'A', browser_only: false }, { name: 'B', browser_only: false }]));
    const out = parseResolveOutput(await directStreamScriptRunner({ cliPath: FAKE_CLI })(['resolve', 'movie', '550', '--providers', providers]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.source.provider).toBe('B');
    expect(out.source.manifest_url).toBe('http://127.0.0.1:9/hls/master.m3u8');
    expect(out.attempts.map((a) => `${a.provider}:${a.outcome}`)).toEqual(['A:bot_check', 'B:resolved']);
  });

  it('reads a resolve cut short by --deadline-s as a failure that is not no_source', () => {
    const out = parseResolveOutput({ ok: false, source: null, error: 'deadline', detail: 'stopped after 30 s; 20 provider(s) not tried', attempts: [] });
    expect(out).toMatchObject({ ok: false, error: 'deadline' });
  });
});
