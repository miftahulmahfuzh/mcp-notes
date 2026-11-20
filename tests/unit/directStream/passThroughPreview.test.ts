import { describe, expect, it } from 'vitest';
import { observeForward, parseEvidenceLine, type EvidenceInput, type EvidenceSink } from '../../../src/directStream/evidence.js';
import { PREVIEW_IMAGE_MAX_BYTES, forward, type FetchLike, type ForwardRequest } from '../../../src/directStream/passThrough.js';
import { SessionStore, type StreamSession } from '../../../src/directStream/sessions.js';
import type { ResolvedSource, StreamRef } from '../../../src/directStream/types.js';

const REF: StreamRef = { kind: 'movie', tmdbId: 550 };
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
  thumbnails: { url: 'https://cdn.example/thumbs/thumbs.vtt', referer: 'https://player.example/', origin: null, user_agent: 'Chrome/142 player' },
};
const PIC = 'https://cdn.example/thumbs/sprite-0.jpg';

function session(): StreamSession {
  return new SessionStore().create(REF, SOURCE, []);
}

function req(target: string, over: Partial<ForwardRequest> = {}): ForwardRequest {
  return { target, range: null, vtt: false, signal: new AbortController().signal, ...over };
}

function host(make: () => Response): { fetchImpl: FetchLike; sent: Array<Record<string, string>> } {
  const sent: Array<Record<string, string>> = [];
  return {
    sent,
    fetchImpl: async (_url, init) => {
      sent.push({ ...(init.headers as Record<string, string>) });
      return make();
    },
  };
}

const jpeg = (bytes: number, headers: Record<string, string> = {}): Response => new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'image/jpeg', ...headers } });

describe('a seek-preview picture through the pass-through (img=1)', () => {
  it("comes back whole with its type, sent with the track's headers and no Range, cacheable by the browser", async () => {
    const { fetchImpl, sent } = host(() => jpeg(1234));
    const res = await forward(session(), req(PIC, { preview: 'image', range: 'bytes=0-9' }), fetchImpl);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toBe('private, max-age=86400');
    expect((await res.arrayBuffer()).byteLength).toBe(1234);
    expect(sent).toEqual([{ referer: 'https://player.example/', 'user-agent': 'Chrome/142 player' }]);
  });

  it.each([
    ['an HTML page', () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['a refusal', () => new Response('no', { status: 403, headers: { 'content-type': 'image/jpeg' } })],
    ['an answer with no type', () => new Response('??', { status: 200 })],
  ])('refuses %s with 502 not_an_image', async (_name, make) => {
    const res = await forward(session(), req(PIC, { preview: 'image' }), host(make).fetchImpl);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'not_an_image' });
  });

  it('refuses a picture over the size limit, said or streamed, with 502 image_too_large', async () => {
    const said = await forward(session(), req(PIC, { preview: 'image' }), host(() => jpeg(10, { 'content-length': String(PREVIEW_IMAGE_MAX_BYTES + 1) })).fetchImpl);
    expect(said.status).toBe(502);
    expect(await said.json()).toMatchObject({ error: 'image_too_large' });
    const streamed = await forward(session(), req(PIC, { preview: 'image' }), host(() => jpeg(PREVIEW_IMAGE_MAX_BYTES + 1)).fetchImpl);
    expect(streamed.status).toBe(502);
    expect(await streamed.json()).toMatchObject({ error: 'image_too_large' });
  });

  it("leaves a play's request as it was: the manifest's headers and the player's Range", async () => {
    const { fetchImpl, sent } = host(() => new Response(new Uint8Array(10), { status: 206, headers: { 'content-type': 'video/mp2t' } }));
    const res = await forward(session(), req('https://cdn.example/hls/seg1.ts', { range: 'bytes=0-9' }), fetchImpl);
    expect(res.status).toBe(206);
    expect(sent).toEqual([{ referer: 'https://vidfast.example/', origin: 'https://vidfast.example', 'user-agent': 'Chrome/142', range: 'bytes=0-9' }]);
  });

  it('is recorded as kind image, which the evidence log reads back', async () => {
    const records: EvidenceInput[] = [];
    const sink: EvidenceSink = { record: (r) => records.push(r) };
    const res = await observeForward(session(), req(PIC, { preview: 'image' }), host(() => jpeg(100)).fetchImpl, sink);
    await res.arrayBuffer();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ type: 'request', kind: 'image', status: 200, outcome: 'end', bytes: 100 });
    expect(parseEvidenceLine(JSON.stringify({ ...records[0], at: '2026-11-20T12:00:00.000Z' }))).toMatchObject({ kind: 'image' });
  });
});
