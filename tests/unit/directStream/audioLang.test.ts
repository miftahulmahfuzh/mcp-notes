import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIO_CLIP_S,
  AUDIO_KEEP_TTL_MS,
  AUDIO_SAMPLE_AT_S,
  AudioLangCheck,
  AudioVerdicts,
  cutAudioArgs,
  isDub,
  passesOverAudio,
  type AudioGrabber,
} from '../../../src/directStream/audioLang.js';
import type { WhisperDetector } from '../../../src/directStream/torrent/subtitles/whisper.js';
import type { ResolvedSource, StreamRef } from '../../../src/directStream/types.js';

const FILM: StreamRef = { kind: 'movie', tmdbId: 1419406 };
const EPISODE: StreamRef = { kind: 'tv', tmdbId: 37854, season: 18, episode: 787 };
const source = (provider: string): ResolvedSource => ({
  provider,
  embed_url: `https://${provider.toLowerCase()}.example/e`,
  manifest_url: `https://cdn-${provider.toLowerCase()}.example/master.m3u8`,
  manifest_kind: 'hls',
  headers: { referer: 'https://embed.example/', origin: 'https://embed.example', user_agent: 'UA/1' },
  subtitles: [],
  best_height: 1080,
  en_subtitle: false,
  took_s: 5,
});

let dir: string;
let now: Date;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'audiolang-'));
  now = new Date('2026-11-16T12:00:00Z');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const verdicts = () => new AudioVerdicts(path.join(dir, 'movies', 'stream-audio.json'), () => now);
const detectorOf = (answer: () => { language: string; probability: number } | null): WhisperDetector & { calls: number } => {
  const d = { calls: 0, detect: async () => ((d.calls += 1), answer()) };
  return d as WhisperDetector & { calls: number };
};

describe('the ffmpeg clip arguments', () => {
  it('seeks, sends the captured headers, and writes 30 s of the first audio stream as 16 kHz mono PCM', () => {
    const args = cutAudioArgs(source('NexaStream'), 600, '/tmp/clip.wav');
    expect(args.slice(0, 6)).toEqual(['-v', 'error', '-y', '-ss', '600', '-user_agent']);
    expect(args).toEqual(expect.arrayContaining(['-headers', 'Referer: https://embed.example/\r\nOrigin: https://embed.example\r\n']));
    expect(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2)).toEqual(['-i', 'https://cdn-nexastream.example/master.m3u8']);
    expect(args).toEqual(expect.arrayContaining(['-t', String(AUDIO_CLIP_S), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-fflags', '+bitexact']));
    expect(args.at(-1)).toBe('/tmp/clip.wav');
  });
});

describe('the kept verdicts', () => {
  it('keeps one per title and provider on disk, an episode apart from another', async () => {
    const first = verdicts();
    await first.set(FILM, 'NexaStream', { verdict: 'dubbed', detected: 'en', probability: 0.98, reason: 'spoken en, not zh' }, 'whisper');
    await first.set(FILM, 'VidLink', { verdict: 'original', detected: 'zh', probability: 0.95, reason: 'spoken zh, the original' }, 'whisper');
    await first.set(EPISODE, 'VidLink', { verdict: 'dubbed', detected: 'en', probability: 0.9, reason: '' }, 'whisper');
    const again = verdicts();
    expect(await again.get(FILM, 'nexastream')).toMatchObject({ verdict: 'dubbed', detected: 'en', provider: 'NexaStream', model: 'whisper' });
    expect(await again.badFor(FILM)).toEqual(['NexaStream']);
    expect(await again.badFor(EPISODE)).toEqual(['VidLink']);
    expect(await again.get({ ...EPISODE, episode: 788 }, 'VidLink')).toBeNull();
    expect(Object.keys(JSON.parse(await readFile(path.join(dir, 'movies', 'stream-audio.json'), 'utf8')))).toHaveLength(3);
  });

  it('forgets a verdict after the keep window', async () => {
    const v = verdicts();
    await v.set(FILM, 'Bad', { verdict: 'dubbed', detected: 'en', probability: 0.98, reason: '' }, 'whisper');
    await v.set(FILM, 'Good', { verdict: 'original', detected: 'zh', probability: 0.95, reason: '' }, 'whisper');
    now = new Date(now.getTime() + AUDIO_KEEP_TTL_MS + 1000);
    expect(await v.get(FILM, 'Bad')).toBeNull();
    expect(await v.badFor(FILM)).toEqual([]);
    expect(await v.get(FILM, 'Good')).toBeNull();
  });
});

describe('the audio-language check', () => {
  it('reads the clip, hears the original, keeps the verdict and answers it without hearing again', async () => {
    const grab = vi.fn<AudioGrabber>(async () => path.join(dir, 'clip', 'clip.wav'));
    const detector = detectorOf(() => ({ language: 'zh', probability: 0.96 }));
    const check = new AudioLangCheck({ verdicts: verdicts(), grab, detector, log: () => undefined });
    expect(await check.check(FILM, source('VidLink'), 'zh')).toMatchObject({ verdict: 'original', detected: 'zh', kept: false });
    expect(grab.mock.calls[0]?.[1]).toBe(AUDIO_SAMPLE_AT_S);
    expect(detector.calls).toBe(1);
    expect(await check.check(FILM, source('VidLink'), 'zh')).toMatchObject({ verdict: 'original', kept: true });
    expect(detector.calls).toBe(1);
    expect(passesOverAudio(await check.check(FILM, source('VidLink'), 'zh'))).toBe(false);
    expect(await check.badFor(FILM)).toEqual([]);
  });

  it('hears a dub of a foreign film, keeps it, and leaves the provider out next time', async () => {
    const detector = detectorOf(() => ({ language: 'en', probability: 0.99 }));
    const check = new AudioLangCheck({ verdicts: verdicts(), grab: async () => path.join(dir, 'c', 'clip.wav'), detector, log: () => undefined });
    const look = await check.check(FILM, source('NexaStream'), 'zh');
    expect(look).toMatchObject({ verdict: 'dubbed', detected: 'en', kept: false });
    expect(look.reason).toMatch(/spoken en, not the original zh/);
    expect(passesOverAudio(look)).toBe(true);
    expect(isDub(look.verdict)).toBe(true);
    expect(await check.badFor(FILM)).toEqual(['NexaStream']);
  });

  it('is unsure, and never keeps it, when no audio could be read, when nothing was heard, or when it was not heard clearly', async () => {
    const none = new AudioLangCheck({ verdicts: verdicts(), grab: async () => null, detector: detectorOf(() => ({ language: 'en', probability: 0.99 })), log: () => undefined });
    const noAudio = await none.check(FILM, source('A'), 'zh');
    expect(noAudio).toMatchObject({ verdict: 'unsure', reason: 'no audio could be read from the stream', kept: false });
    expect(passesOverAudio(noAudio)).toBe(false);

    const silent = new AudioLangCheck({ verdicts: verdicts(), grab: async () => path.join(dir, 'a', 'c.wav'), detector: detectorOf(() => null), log: () => undefined });
    expect(await silent.check(FILM, source('B'), 'zh')).toMatchObject({ verdict: 'unsure', kept: false });

    const unsure = new AudioLangCheck({ verdicts: verdicts(), grab: async () => path.join(dir, 'a', 'c.wav'), detector: detectorOf(() => ({ language: 'en', probability: 0.4 })), log: () => undefined });
    const low = await unsure.check(FILM, source('C'), 'zh');
    expect(low).toMatchObject({ verdict: 'unsure', detected: 'en', probability: 0.4, kept: false });
    // Nothing unsure was kept: the next play hears each one again.
    expect(await none.badFor(FILM)).toEqual([]);
  });

  it('never throws and never keeps when the detector fails', async () => {
    const check = new AudioLangCheck({
      verdicts: verdicts(),
      grab: async () => path.join(dir, 'a', 'c.wav'),
      detector: { detect: async () => { throw new Error('the worker stopped'); } },
      log: () => undefined,
    });
    expect(await check.check(FILM, source('A'), 'zh')).toMatchObject({ verdict: 'unsure', reason: 'the worker stopped', kept: false });
    expect(await check.badFor(FILM)).toEqual([]);
  });

  it('a kept verdict is reused without a clip or a detector call', async () => {
    const grab = vi.fn<AudioGrabber>(async () => path.join(dir, 'a', 'c.wav'));
    const detector = detectorOf(() => ({ language: 'en', probability: 0.99 }));
    const v = verdicts();
    await v.set(EPISODE, 'NexaStream', { verdict: 'dubbed', detected: 'en', probability: 0.98, reason: 'spoken en, not ko' }, 'whisper');
    const check = new AudioLangCheck({ verdicts: v, grab, detector, log: () => undefined });
    expect(await check.check(EPISODE, source('NexaStream'), 'ko')).toMatchObject({ verdict: 'dubbed', kept: true });
    expect(grab).not.toHaveBeenCalled();
    expect(detector.calls).toBe(0);
  });
});
