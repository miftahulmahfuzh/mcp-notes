import { describe, expect, it } from 'vitest';
import type { AudioLangCheck, AudioLook, AudioVerdict } from '../../../src/directStream/audioLang.js';
import type { PictureCheck, PictureLook } from '../../../src/directStream/picture.js';
import type { DirectStreamRepo } from '../../../src/directStream/repo.js';
import { CHECKS_PENDING, DirectStreamService } from '../../../src/directStream/service.js';
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
  picture?: PictureCheck;
  /** How long a play waits for the checks (the service's CHECK_HEAD_MS). */
  headMs?: number;
}

function setup(o: Opts = {}) {
  const order = o.order ?? ['Alpha', 'Beta', 'Gamma'];
  const logged: string[] = [];
  const resolves: string[][] = [];
  const svc = new DirectStreamService({
    repo: { providers: async () => [], healthFor: async () => [], recordAttempts: async () => undefined } as unknown as DirectStreamRepo,
    runner: async (args: string[]) => {
      if (args[0] === 'open') return { ok: true };
      const skipAt = args.indexOf('--skip');
      const skip = skipAt === -1 ? [] : (args[skipAt + 1]?.split(',') ?? []);
      resolves.push(skip);
      const pick = order.find((p) => !skip.includes(p));
      if (pick === undefined) return { ok: false, error: 'no_source', detail: '', attempts: order.map((p) => ({ provider: p, outcome: 'no_stream', took_s: 0, detail: 'skipped' })) };
      return { ok: true, source: { provider: pick, manifest_url: `https://cdn.example/${pick}.m3u8`, manifest_kind: 'hls', subtitles: [], best_height: 1080 }, attempts: [{ provider: pick, outcome: 'resolved', took_s: 1, detail: '' }] };
    },
    host: 'host-a',
    seedFile: 'unused.json',
    pageBase: () => 'http://localhost:4321',
    hooks: { originalLanguage: async () => (o.originalLanguage === undefined ? 'es' : o.originalLanguage) },
    audioCheck: o.audio?.check ?? null,
    picture: o.picture ?? null,
    ...(o.headMs === undefined ? {} : { checkHeadMs: o.headMs }),
    log: (line) => void logged.push(line),
  });
  return Object.assign(svc, { logged, resolves });
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

describe('a play does not wait for the stream checks', () => {
  /** An audio check that answers only once `open()` is called. */
  function slowAudio(verdict: AudioVerdict) {
    let open = (): void => undefined;
    const wait = new Promise<void>((resolve) => {
      open = resolve;
    });
    const audio = fakeAudio({ Alpha: verdict });
    const inner = audio.check;
    const check = {
      check: async (ref: StreamRef, source: ResolvedSource, original: string) => {
        await wait;
        return inner.check(ref, source, original);
      },
      badFor: () => inner.badFor(FILM),
    } as unknown as AudioLangCheck;
    return { audio: { check, checks: audio.checks }, open };
  }
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('opens the page on the stream that resolved when the checks outlast the head, and says what they found once they end', async () => {
    const slow = slowAudio('dubbed');
    const svc = setup({ audio: slow.audio, headMs: 5 });
    const played = await svc.play(FILM);
    // The dub plays this once: one resolve, no second round, and the page is open before anything was heard.
    expect(played.session.provider).toBe('Alpha');
    expect(svc.resolves).toEqual([[]]);
    expect(detailOf(played.attempts, 'Alpha')).toBe(CHECKS_PENDING);
    slow.open();
    await tick();
    await tick();
    expect(detailOf(svc.session(played.session.session_id)?.attempts ?? [], 'Alpha')).toBe('audio: dubbed (heard dubbed)');
    expect(svc.logged).toContain('[notesd] direct stream: TMDB movie 818647 from Alpha, checked behind the play: audio: dubbed (heard dubbed); the next play passes this provider over');
  });

  it('still passes a dub over before the page opens when the check answers within the head', async () => {
    const audio = fakeAudio({ Alpha: 'dubbed', Beta: 'original' });
    const svc = setup({ audio, headMs: 5_000 });
    const played = await svc.play(FILM);
    expect(played.session.provider).toBe('Beta');
    expect(svc.resolves).toEqual([[], ['Alpha']]);
    expect(played.attempts.filter((a) => a.outcome === 'resolved').map((a) => `${a.provider}: ${a.detail}`)).toEqual(['Alpha: audio: dubbed (heard dubbed)', 'Beta: audio: original (heard original)']);
  });

  it('a provider heard as a dub behind one play is left out of the next from the start', async () => {
    const audio = fakeAudio({ Beta: 'original' }, ['Alpha']);
    const svc = setup({ audio, headMs: 5 });
    expect((await svc.play(FILM)).session.provider).toBe('Beta');
    expect(svc.resolves).toEqual([['Alpha']]);
  });

  it('waits for the whole check when nobody waits for a page (a cache keeps what it resolves)', async () => {
    const slow = slowAudio('dubbed');
    const svc = setup({ audio: slow.audio, headMs: 5 });
    const resolving = svc.resolve(FILM, { vet: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(svc.resolves).toEqual([[]]);
    slow.open();
    expect((await resolving).source.provider).toBe('Beta');
  });

  it('a stream no frame could be read from plays: it costs no second resolve', async () => {
    const looks: string[] = [];
    const picture = {
      check: async (_ref: StreamRef, source: ResolvedSource): Promise<PictureLook> => {
        looks.push(source.provider);
        return { verdict: 'unsure', reason: 'no frame could be read from the stream', kept: false, unreadable: true };
      },
      badFor: async () => [],
    } as unknown as PictureCheck;
    const svc = setup({ picture, originalLanguage: 'en', headMs: 5_000 });
    const played = await svc.play(FILM);
    expect(played.session.provider).toBe('Alpha');
    expect(svc.resolves).toEqual([[]]);
    expect(looks).toEqual(['Alpha']);
    expect(detailOf(played.attempts, 'Alpha')).toBe('picture: unsure (no frame could be read from the stream)');
  });
});
