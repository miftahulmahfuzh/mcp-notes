import { describe, expect, it } from 'vitest';
import type { AudioLangCheck, AudioLook, AudioVerdict } from '../../../src/directStream/audioLang.js';
import type { DirectStreamRepo } from '../../../src/directStream/repo.js';
import { DirectStreamService } from '../../../src/directStream/service.js';
import type { ResolveAttempt, ResolvedSource, StreamRef } from '../../../src/directStream/types.js';

const FILM: StreamRef = { kind: 'movie', tmdbId: 818647 };

/** A fake audio check keyed by provider: `byProvider` says each provider's verdict; `pre` are dubs remembered from before. */
function fakeAudio(byProvider: Record<string, AudioVerdict>, pre: string[] = []) {
  const checks: string[] = [];
  const check: Pick<AudioLangCheck, 'check' | 'badFor'> = {
    async check(_ref: StreamRef, source: ResolvedSource): Promise<AudioLook> {
      checks.push(source.provider);
      const verdict = byProvider[source.provider] ?? 'original';
      return { verdict, detected: verdict === 'dubbed' ? 'en' : 'es', probability: 0.9, reason: `heard ${verdict}`, kept: false };
    },
    async badFor() {
      return [...pre];
    },
  };
  return { check: check as unknown as AudioLangCheck, checks };
}

interface Opts {
  order?: string[];
  originalLanguage?: string | null;
  audio?: { check: AudioLangCheck; checks: string[] };
}

function setup(o: Opts = {}) {
  const order = o.order ?? ['Alpha', 'Beta', 'Gamma'];
  const svc = new DirectStreamService({
    repo: { providers: async () => [], healthFor: async () => [], recordAttempts: async () => undefined } as unknown as DirectStreamRepo,
    runner: async (args: string[]) => {
      if (args[0] === 'open') return { ok: true };
      const skipAt = args.indexOf('--skip');
      const skip = skipAt === -1 ? [] : (args[skipAt + 1]?.split(',') ?? []);
      const pick = order.find((p) => !skip.includes(p));
      if (pick === undefined) return { ok: false, error: 'no_source', detail: '', attempts: order.map((p) => ({ provider: p, outcome: 'no_stream', took_s: 0, detail: 'skipped' })) };
      return { ok: true, source: { provider: pick, manifest_url: `https://cdn.example/${pick}.m3u8`, manifest_kind: 'hls', subtitles: [], best_height: 1080 }, attempts: [{ provider: pick, outcome: 'resolved', took_s: 1, detail: '' }] };
    },
    host: 'host-a',
    seedFile: 'unused.json',
    pageBase: () => 'http://localhost:4321',
    hooks: { originalLanguage: async () => (o.originalLanguage === undefined ? 'es' : o.originalLanguage) },
    audioCheck: o.audio?.check ?? null,
    log: () => undefined,
  });
  return svc;
}

const detailOf = (attempts: ResolveAttempt[], provider: string): string => attempts.find((a) => a.provider === provider && a.outcome === 'resolved')?.detail ?? '';

describe('the cloud vet skips a dub for a provider that serves the original', () => {
  it('passes over each dub and plays the first provider heard speaking the original language', async () => {
    const audio = fakeAudio({ Alpha: 'dubbed', Beta: 'dubbed', Gamma: 'original' });
    const session = await setup({ audio }).resolve(FILM, { vet: true });
    expect(session.source.provider).toBe('Gamma');
    expect(audio.checks).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(detailOf(session.attempts, 'Gamma')).toContain('audio: original');
  });

  it('plays the first stream found as a fallback when every provider is a dub, labelled audio: dubbed', async () => {
    const audio = fakeAudio({ Alpha: 'dubbed', Beta: 'dubbed', Gamma: 'dubbed' });
    const session = await setup({ audio }).resolve(FILM, { vet: true });
    expect(session.source.provider).toBe('Alpha');
    expect(detailOf(session.attempts, 'Alpha')).toContain('audio: dubbed');
  });

  it('leaves out, from the start, a provider heard as a dub on an earlier play', async () => {
    const audio = fakeAudio({ Beta: 'original' }, ['Alpha']);
    const session = await setup({ audio }).resolve(FILM, { vet: true });
    expect(session.source.provider).toBe('Beta');
    // Alpha was never resolved: it was skipped up front, so the check never saw it.
    expect(audio.checks).toEqual(['Beta']);
  });

  it('is skipped when the title is English: the first provider plays with no audio heard', async () => {
    const audio = fakeAudio({ Alpha: 'dubbed' });
    const session = await setup({ audio, originalLanguage: 'en' }).resolve(FILM, { vet: true });
    expect(session.source.provider).toBe('Alpha');
    expect(audio.checks).toEqual([]);
  });

  it('is skipped when the original language is unknown', async () => {
    const audio = fakeAudio({ Alpha: 'dubbed' });
    const session = await setup({ audio, originalLanguage: null }).resolve(FILM, { vet: true });
    expect(session.source.provider).toBe('Alpha');
    expect(audio.checks).toEqual([]);
  });
});
