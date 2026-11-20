import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { streamAudioGrabber } from '../../../src/directStream/audioLang.js';
import { lowestVariant } from '../../../src/directStream/picture.js';
import type { ResolvedSource } from '../../../src/directStream/types.js';

const MEDIA = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXTINF:6,', 'a.ts', '#EXTINF:6,', 'b.ts', '#EXTINF:6,', 'c.ts', '#EXTINF:6,', 'd.ts', '#EXT-X-ENDLIST'].join('\n');
const BASE = 'https://cdn.example/v/index.m3u8';
const source = (over: Partial<ResolvedSource> = {}): ResolvedSource => ({
  provider: 'Alpha', embed_url: '', manifest_url: BASE, manifest_kind: 'hls', headers: { referer: 'https://alpha.example/', origin: null, user_agent: 'UA' },
  subtitles: [], best_height: 1080, en_subtitle: false, audio: null, took_s: 1, ...over,
});

describe('lowestVariant', () => {
  it('picks the rendition with the least bandwidth, wherever it stands; a media playlist has none', () => {
    const master = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=1920x1080', '1080/i.m3u8', '#EXT-X-STREAM-INF:RESOLUTION=640x360,BANDWIDTH=700000', '360/i.m3u8', '#EXT-X-STREAM-INF:BANDWIDTH=2500000', 'https://other.example/720.m3u8'].join('\n');
    expect(lowestVariant(master, 'https://cdn.example/m.m3u8')).toBe('https://cdn.example/360/i.m3u8');
    expect(lowestVariant(MEDIA, BASE)).toBeNull();
  });
});

describe('the audio clip read from the segments themselves', () => {
  let dir: string;
  /** Two real 4 s MPEG-TS segments with a tone, made once with ffmpeg. */
  let segs: Buffer[];
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'notesd-audioseg-'));
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:d=8', '-c:a', 'aac', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_segment_filename', path.join(dir, 's%d.ts'), path.join(dir, 'index.m3u8')]);
    segs = [readFileSync(path.join(dir, 's0.ts')), readFileSync(path.join(dir, 's1.ts'))];
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(56, 1)]);
  /** A host whose every segment is a small picture file with the transport stream behind it (HyperLink's). */
  function host(o: { wrap?: boolean; key?: boolean; missing?: string } = {}) {
    const asked: Array<{ url: string; referer: string | null }> = [];
    const playlist = ['#EXTM3U', ...(o.key ? ['#EXT-X-KEY:METHOD=AES-128,URI="k"'] : []), '#EXTINF:4,', 's0', '#EXTINF:4,', 's1', '#EXT-X-ENDLIST'].join('\n');
    const fetchImpl = (async (url: string, init?: { headers?: Record<string, string> }) => {
      asked.push({ url: String(url), referer: init?.headers?.referer ?? null });
      if (String(url) === BASE) return new Response(playlist);
      const name = String(url).split('/').pop() ?? '';
      if (name === o.missing) return new Response('gone', { status: 404 });
      const body = segs[name === 's0' ? 0 : 1] as Buffer;
      return new Response(o.wrap === false ? body : Buffer.concat([PNG, body]), { headers: { 'content-type': 'text/html' } });
    }) as unknown as typeof fetch;
    return { fetchImpl, asked };
  }

  it('the stream audio grabber writes the 16 kHz mono WAV Whisper reads, from segments wrapped in picture files', async () => {
    const h = host();
    const wav = await streamAudioGrabber({ ffmpegBin: 'ffmpeg', fetch: h.fetchImpl, retryMs: 1 })(source(), 0);
    expect(h.asked.every((a) => a.referer === 'https://alpha.example/')).toBe(true);
    expect(wav).not.toBeNull();
    const file = wav as string;
    try {
      const head = readFileSync(file).subarray(0, 44);
      expect(head.toString('latin1', 0, 4)).toBe('RIFF');
      expect(head.readUInt16LE(22)).toBe(1);
      expect(head.readUInt32LE(24)).toBe(16_000);
      // About the 8 s the two segments hold.
      expect(statSync(file).size).toBeGreaterThan(16_000 * 2 * 6);
    } finally {
      rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('asks the segments once more when the host refused the first time', async () => {
    const h = host();
    let first = true;
    const flaky = (async (url: string, init?: { headers?: Record<string, string> }) => {
      if (first) {
        first = false;
        return new Response('slow down', { status: 429 });
      }
      return h.fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const wav = await streamAudioGrabber({ ffmpegBin: 'ffmpeg', retryMs: 1, fetch: flaky })(source(), 0);
    expect(wav).not.toBeNull();
    rmSync(path.dirname(wav as string), { recursive: true, force: true });
  });
});
