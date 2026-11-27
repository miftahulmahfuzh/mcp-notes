import { describe, expect, it } from 'vitest';
import type { DirectStreamRepo, HealthAttempt } from '../../../src/directStream/repo.js';
import { DirectStreamService } from '../../../src/directStream/service.js';

// A cloud provider's no_stream counts toward its failures in a row only when the title demonstrably exists here:
// another provider resolved it in the same resolve, or a cloud provider or a torrent streamed it before.
const FILM = { kind: 'movie' as const, tmdbId: 806704 };
const EPISODE = { kind: 'tv' as const, tmdbId: 95480, season: 6, episode: 6 };
const SOURCE = { provider: 'Good', manifest_url: 'https://up.example/hls/master.m3u8', manifest_kind: 'hls', subtitles: [], best_height: 1080 };
const NO_STREAM = { provider: 'Empty', outcome: 'no_stream', took_s: 35, detail: '60 requests, 0 media hits' };
const UNREACHABLE = { provider: 'Down', outcome: 'no_stream', took_s: 3, detail: 'unreachable: HTTP 523' };
const BOT = { provider: 'Gated', outcome: 'bot_check', took_s: 4, detail: 'Just a moment...' };
const ERROR = { provider: 'Broken', outcome: 'error', took_s: 1, detail: 'the sniffer timed out' };
const PROVIDERS = ['Good', 'Empty', 'Down', 'Gated', 'Broken'].map((name) => ({ name, idKind: 'tmdb', movie: `https://${name}.example/{id}`, tv: null, browserOnly: false, enSubtitle: null, notes: '' }));

function setup(output: unknown, streamed: boolean | 'absent' | Error) {
  const recorded: HealthAttempt[][] = [];
  const asked: unknown[] = [];
  const svc = new DirectStreamService({
    repo: { providers: async () => PROVIDERS, healthFor: async () => [], recordAttempts: async (_host: string, rows: HealthAttempt[]) => void recorded.push(rows) } as unknown as DirectStreamRepo,
    runner: async () => output,
    host: 'host-a',
    seedFile: 'unused.json',
    pageBase: () => 'http://localhost:4321',
    hooks:
      streamed === 'absent'
        ? {}
        : {
            titleStreamed: async (ref) => {
              asked.push(ref);
              if (streamed instanceof Error) throw streamed;
              return streamed;
            },
          },
    log: () => undefined,
  });
  return { svc, recorded, asked };
}
const names = (rows: HealthAttempt[] | undefined) => (rows ?? []).map((r) => `${r.provider}:${r.outcome}`);
const FAILED = (attempts: unknown[]) => ({ ok: false, source: null, error: 'no_source', detail: '', attempts });

describe('provider rests: which no_stream counts', () => {
  it('another provider resolved the title in the same resolve: every failure counts, the title is not looked up', async () => {
    const t = setup({ ok: true, source: SOURCE, attempts: [NO_STREAM, UNREACHABLE, BOT, ERROR, { provider: 'Good', outcome: 'resolved', took_s: 2, detail: '' }] }, false);
    await t.svc.runResolve(FILM);
    expect(names(t.recorded[0])).toEqual(['Empty:no_stream', 'Down:no_stream', 'Gated:bot_check', 'Broken:error', 'Good:resolved']);
    expect(t.asked).toEqual([]);
  });

  it('nothing resolved and nobody ever streamed the title: its no_stream is left out; unreachable, bot check and error count', async () => {
    const t = setup(FAILED([NO_STREAM, UNREACHABLE, BOT, ERROR]), false);
    await t.svc.runResolve(EPISODE);
    expect(names(t.recorded[0])).toEqual(['Down:no_stream', 'Gated:bot_check', 'Broken:error']);
    expect(t.asked).toEqual([EPISODE]);
  });

  it('nothing resolved but the title (that episode) streamed here before: its no_stream counts', async () => {
    const t = setup(FAILED([NO_STREAM, BOT]), true);
    await t.svc.runResolve(EPISODE);
    expect(names(t.recorded[0])).toEqual(['Empty:no_stream', 'Gated:bot_check']);
  });

  it('no hook, or a hook that fails: the title is not known to stream, so the no_stream does not count', async () => {
    for (const streamed of ['absent', new Error('db down')] as const) {
      const t = setup(FAILED([NO_STREAM, BOT]), streamed);
      await t.svc.runResolve(FILM);
      expect(names(t.recorded[0])).toEqual(['Gated:bot_check']);
    }
  });

  it('only unreachable pages and checks failed: the title is not looked up', async () => {
    const t = setup(FAILED([UNREACHABLE, BOT]), true);
    await t.svc.runResolve(FILM);
    expect(names(t.recorded[0])).toEqual(['Down:no_stream', 'Gated:bot_check']);
    expect(t.asked).toEqual([]);
  });

  it('a known title (the canary, a probe: known-titles.json) streams by construction: its no_stream counts, nothing is looked up', async () => {
    const t = setup(FAILED([NO_STREAM]), false);
    await t.svc.runResolve(FILM, { only: 'Empty', known: true });
    expect(names(t.recorded[0])).toEqual(['Empty:no_stream']);
    expect(t.asked).toEqual([]);
  });
});
