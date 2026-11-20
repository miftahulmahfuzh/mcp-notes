import { describe, expect, it, vi } from 'vitest';
import { forward, type FetchLike } from '../../../../src/directStream/passThrough.js';
import {
  PROVIDER_TRACK_MAX_BYTES,
  ProviderPreviewSource,
  parseThumbnailCues,
} from '../../../../src/directStream/previews/providerSource.js';
import { proxiedUrl } from '../../../../src/directStream/rewrite.js';
import { SessionStore, allows, type StreamSession } from '../../../../src/directStream/sessions.js';
import type { ResolvedSource, StreamRef } from '../../../../src/directStream/types.js';

const REF: StreamRef = { kind: 'movie', tmdbId: 550 };
const TRACK = 'https://img.example/vd/abc/thumbs/thumbs.vtt?tok=TRACKTOKEN';
const TRACK2 = 'https://img2.example/vd/abc/thumbs.vtt';
const SOURCE: ResolvedSource = {
  provider: 'VidFast',
  embed_url: 'https://vidfast.example/movie/550',
  manifest_url: 'https://cdn.example/hls/master.m3u8',
  manifest_kind: 'hls',
  headers: { referer: 'https://vidfast.example/', origin: 'https://vidfast.example', user_agent: 'Chrome/142' },
  subtitles: [],
  best_height: 1080,
  en_subtitle: false,
  took_s: 2,
  thumbnails: { url: TRACK, referer: 'https://player.example/', origin: 'https://player.example', user_agent: 'Chrome/142 player' },
};
const NONE = { state: 'none', source: null, cues: [] };
// Out of order on purpose; the third picture is on a host only the track names.
const SPRITES = [
  'WEBVTT',
  '',
  '00:00:10.000 --> 00:00:20.000',
  'sprite-1.jpg#xywh=160,0,160,90',
  '',
  '00:00.000 --> 00:10.000',
  'sprite-1.jpg#xywh=0,0,160,90',
  '',
  '00:00:20.000 --> 00:00:30.000 align:start',
  'https://pics.example/s/sprite-2.jpg#xywh=pixel:0,0,160,90',
  '',
].join('\n');

interface Seen {
  url: string;
  headers: Record<string, string>;
}

function host(answer: (url: string, init: RequestInit) => Response | Promise<Response>): { fetchImpl: FetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    fetchImpl: async (url, init) => {
      seen.push({ url, headers: { ...(init.headers as Record<string, string>) } });
      return answer(url, init);
    },
  };
}

const vtt = (body: string, headers: Record<string, string> = {}): Response => new Response(body, { status: 200, headers: { 'content-type': 'text/vtt', ...headers } });

function live(source: ResolvedSource = SOURCE): { store: SessionStore; session: StreamSession } {
  const store = new SessionStore();
  return { store, session: store.create(REF, source, []) };
}

function made(opts: { fetchImpl: FetchLike; maxBytes?: number; timeoutMs?: number; waitMs?: number }): { source: ProviderPreviewSource; changed: StreamSession[]; lines: string[] } {
  const changed: StreamSession[] = [];
  const lines: string[] = [];
  const source = new ProviderPreviewSource({
    fetch: opts.fetchImpl,
    onChange: (s) => changed.push(s),
    log: (line) => lines.push(line),
    maxBytes: opts.maxBytes,
    timeoutMs: opts.timeoutMs ?? 2_000,
    waitMs: opts.waitMs ?? 2_000,
  });
  return { source, changed, lines };
}

describe("a provider's seek-preview track (R1.4)", () => {
  it("lists its frames, sorted, as pass-through addresses with img=1, read once with the track's own headers", async () => {
    const { fetchImpl, seen } = host(() => vtt(SPRITES));
    const { source, changed } = made({ fetchImpl });
    const { session } = live();
    const list = await source.list(session);
    expect(list).toEqual({
      state: 'ready',
      source: 'provider',
      cues: [
        { start_s: 0, end_s: 10, url: `${proxiedUrl(session.id, 'https://img.example/vd/abc/thumbs/sprite-1.jpg')}&img=1`, x: 0, y: 0, w: 160, h: 90 },
        { start_s: 10, end_s: 20, url: `${proxiedUrl(session.id, 'https://img.example/vd/abc/thumbs/sprite-1.jpg')}&img=1`, x: 160, y: 0, w: 160, h: 90 },
        { start_s: 20, end_s: 30, url: `${proxiedUrl(session.id, 'https://pics.example/s/sprite-2.jpg')}&img=1`, x: 0, y: 0, w: 160, h: 90 },
      ],
    });
    expect(await source.list(session)).toEqual(list);
    expect(seen).toEqual([{ url: TRACK, headers: { referer: 'https://player.example/', origin: 'https://player.example', 'user-agent': 'Chrome/142 player' } }]);
    expect(changed).toEqual([session]);
  });

  it('lets the session reach the hosts the track named, and no other', async () => {
    const { fetchImpl } = host(() => vtt(SPRITES));
    const { source } = made({ fetchImpl });
    const { session } = live();
    expect(allows(session, TRACK)).toBe(true);
    expect(allows(session, 'https://pics.example/s/sprite-2.jpg')).toBe(false);
    await source.list(session);
    expect(allows(session, 'https://pics.example/s/sprite-2.jpg')).toBe(true);
    const other = host(() => new Response('x', { headers: { 'content-type': 'image/png' } }));
    const res = await forward(session, { target: 'https://elsewhere.example/s.png', range: null, vtt: false, preview: 'image', signal: new AbortController().signal }, other.fetchImpl);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'forbidden_host' });
    expect(other.seen).toEqual([]);
  });

  it('lists nothing and fetches nothing for a source with no track, a cache or a torrent', async () => {
    const { fetchImpl, seen } = host(() => vtt(SPRITES));
    const { source } = made({ fetchImpl });
    expect(await source.list(live({ ...SOURCE, thumbnails: null }).session)).toEqual(NONE);
    const { session: cached } = live();
    cached.cache = { id: 'c1', state: 'ready', height: 1080, manifestUrl: '/api/stream/cache/c1/f/master.m3u8', subtitles: [] };
    expect(await source.list(cached)).toEqual(NONE);
    expect(seen).toEqual([]);
  });

  it("reads a refreshed source's own track, and drops the frames when the new source has none", async () => {
    const { fetchImpl, seen } = host((url) => vtt(url === TRACK2 ? SPRITES.replaceAll('sprite-1.jpg', 'next.jpg') : SPRITES));
    const { source, changed } = made({ fetchImpl });
    const { store, session } = live();
    await source.list(session);
    store.replaceSource(session, { ...SOURCE, thumbnails: { url: TRACK2, referer: null, origin: null, user_agent: null } }, []);
    const next = await source.list(session);
    expect(seen.map((s) => s.url)).toEqual([TRACK, TRACK2]);
    expect(next.cues[0]?.url).toBe(`${proxiedUrl(session.id, 'https://img2.example/vd/abc/next.jpg')}&img=1`);
    store.replaceSource(session, { ...SOURCE, thumbnails: null }, []);
    expect(await source.list(session)).toEqual(NONE);
    // frames came (1), the old frames went and new ones came (2, 3), the frames went (4)
    expect(changed).toHaveLength(4);
  });

  it('answers without the track while it is still read, then tells the change and lists it', async () => {
    let release: (res: Response) => void = () => undefined;
    const { fetchImpl } = host(() => new Promise<Response>((resolve) => { release = resolve; }));
    const { source, changed } = made({ fetchImpl, waitMs: 10 });
    const { session } = live();
    expect(await source.list(session)).toEqual(NONE);
    release(vtt(SPRITES));
    await vi.waitFor(() => expect(changed).toEqual([session]));
    expect((await source.list(session)).cues).toHaveLength(3);
  });
});

describe('a track that gives no frame (R2.6)', () => {
  const big = 'WEBVTT\n\n' + 'x'.repeat(4096);
  const cases: Array<[string, (url: string, init: RequestInit) => Response | Promise<Response>, number?]> = [
    ['cannot be reached', () => Promise.reject(new Error('ECONNREFUSED'))],
    ['answers 404', () => new Response('gone', { status: 404, headers: { 'content-type': 'text/plain' } })],
    ['is an HTML page', () => new Response('<!doctype html><title>Just a moment...</title>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })],
    ['says it is over the size limit', () => vtt(SPRITES, { 'content-length': String(PROVIDER_TRACK_MAX_BYTES + 1) })],
    ['runs over the size limit', () => vtt(big), 1024],
    ['holds words, not pictures', () => vtt('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello.\n')],
    ['names whole pictures with no rectangle', () => vtt('WEBVTT\n\n00:00.000 --> 00:10.000\nsprite-0.jpg\n\n00:10.000 --> 00:20.000\nsprite-1.jpg\n')],
    ['is not WebVTT', () => vtt('sprite-0.jpg#xywh=0,0,160,90\n')],
    [
      'takes longer than the time limit',
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    ],
  ];
  it.each(cases)('lists no frame from a track that %s, lets no picture host in and logs one line without its address', async (_name, answer, maxBytes) => {
    const { fetchImpl, seen } = host(answer);
    const { source, changed, lines } = made({ fetchImpl, maxBytes, timeoutMs: 50 });
    const { session } = live();
    expect(await source.list(session)).toEqual(NONE);
    expect(await source.list(session)).toEqual(NONE);
    expect(seen).toHaveLength(1);
    expect(changed).toEqual([]);
    expect(allows(session, 'https://img.example/vd/abc/thumbs/sprite-0.jpg')).toBe(true); // the track's own host, from the resolve
    expect(allows(session, 'https://pics.example/s/sprite-2.jpg')).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("VidFast's preview track gives no frame");
    expect(lines[0]).not.toContain('TRACKTOKEN');
  });
});

describe('parseThumbnailCues', () => {
  it('keeps picture cues only, sorted, and never overlapping', () => {
    const text = [
      '﻿WEBVTT',
      '',
      '1',
      '00:00:00.000 --> 00:00:10.000',
      'a.jpg#xywh=0,0,160,90',
      '',
      '00:00:08.000 --> 00:00:20.000',
      'a.jpg#xywh=160,0,160,90',
      '',
      '00:00:12.000 --> 00:00:18.000',
      'a.jpg#xywh=320,0,160,90',
      '',
      '00:00:30.000 --> 00:00:30.000',
      'a.jpg#xywh=0,90,160,90',
      '',
      '00:00:40.000 --> 00:00:50.000',
      'a.jpg#xywh=percent:0,0,50,50',
      '',
      '00:00:50.000 --> 00:01:00.000',
      'a.jpg#xywh=0,0,0,90',
      '',
      '00:01:00.000 --> 00:01:10.000',
      'data:image/png;base64,AAAA#xywh=0,0,160,90',
      '',
    ].join('\r\n');
    expect(parseThumbnailCues(text, 'https://img.example/t/thumbs.vtt')).toEqual([
      { start_s: 0, end_s: 10, picture: 'https://img.example/t/a.jpg', x: 0, y: 0, w: 160, h: 90 },
      { start_s: 10, end_s: 20, picture: 'https://img.example/t/a.jpg', x: 160, y: 0, w: 160, h: 90 },
    ]);
  });
});
