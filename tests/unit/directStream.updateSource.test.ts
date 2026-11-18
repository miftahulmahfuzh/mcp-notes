import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ResolveOutput } from '../../src/directStream/types.js';
import { TemplatesAnswerSchema, loadKnownTitles, providerKey, toProbeResult, updateSource, type KnownTitle } from '../../src/directStream/updateSource.js';
// @ts-expect-error -- a plain .mjs script without type declarations
import { extractTemplates, mergeProviders } from '../../claude/streaming/direct/templates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIGHT_CLUB: KnownTitle = { label: 'Fight Club (1999)', ref: { kind: 'movie', tmdbId: 550 } };

describe('providerKey', () => {
  it('ignores www, a trailing slash and cosmetic query parameters', () => {
    expect(providerKey('https://www.vidking.net/embed/movie/{id}')).toBe(providerKey('https://vidking.net/embed/movie/{id}/'));
    expect(providerKey('https://vidfast.pro/movie/{id}?autoPlay=true')).toBe(providerKey('https://vidfast.pro/movie/{id}?autoPlay=false'));
    expect(providerKey('https://vidsrc.wtf/api/1/movie/?id={id}&color=215fb3')).toBe('vidsrc.wtf/api/1/movie?id');
  });

  it('tells apart providers on one host by path or by the parameter that carries the id', () => {
    expect(providerKey('https://vidsrc.wtf/api/1/movie/?id={id}')).not.toBe(providerKey('https://vidsrc.wtf/api/2/movie/?id={id}'));
    expect(providerKey('https://vidsrc.me/embed/movie?tmdb={id}')).not.toBe(providerKey('https://vidsrc.me/embed/movie?imdb={id}'));
    expect(providerKey('https://vidsrc.me/embed/movie?tmdb={id}')).not.toBe(providerKey('https://vidsrc.xyz/embed/movie?tmdb={id}'));
  });
});

describe('toProbeResult', () => {
  // Phase 3's ResolveOutput (what runResolve returns after parseResolveOutput).
  const resolved: ResolveOutput = {
    ok: true,
    source: {
      provider: 'Fresh',
      embed_url: 'https://fresh.example/movie/550',
      manifest_url: 'https://cdn.fresh.example/master.m3u8',
      manifest_kind: 'hls',
      headers: { referer: 'https://fresh.example/', origin: 'https://fresh.example', user_agent: 'Chrome' },
      subtitles: [{ url: 'https://cdn.fresh.example/en.vtt', lang: 'en', label: 'English', format: 'vtt', source: 'request' }],
      best_height: 1080,
      en_subtitle: true,
      took_s: 3.1,
    },
    attempts: [{ provider: 'Fresh', outcome: 'resolved', took_s: 3.1, detail: '' }],
  };

  it('reads a resolved answer for the asked provider', () => {
    expect(toProbeResult(FIGHT_CLUB, 'Fresh', resolved)).toEqual({
      title: 'Fight Club (1999)',
      outcome: 'resolved',
      took_s: 3.1,
      manifest_kind: 'hls',
      best_height: 1080,
      en_subtitle: true,
      detail: '',
    });
  });

  it('reads the attempt of a provider that did not resolve', () => {
    const answer: ResolveOutput = { ok: false, source: null, error: 'no_source', detail: '', attempts: [{ provider: 'Fresh', outcome: 'bot_check', took_s: 4, detail: 'Just a moment' }] };
    expect(toProbeResult(FIGHT_CLUB, 'Fresh', answer)).toMatchObject({ outcome: 'bot_check', took_s: 4, detail: 'Just a moment', manifest_kind: null });
  });
});

describe('known titles and the reader answer', () => {
  it('loads the shared known titles, Fight Club among them', async () => {
    const titles = await loadKnownTitles();
    expect(titles.some((t) => t.ref.kind === 'movie' && t.ref.tmdbId === 550)).toBe(true);
  });

  it('the schema accepts what the reader makes of the real fmovies chunk', () => {
    const chunk = readFileSync(path.join(ROOT, 'docs/plans/direct-streaming-spike/fmovies-movie-details-chunk.js'), 'utf8');
    const { providers, skipped } = mergeProviders(extractTemplates(chunk, 'https://ww6-fmovies.com/x.js'));
    const parsed = TemplatesAnswerSchema.safeParse({ ok: true, site: 'https://ww6-fmovies.com/', scripts_read: 1, providers, skipped });
    expect(parsed.success).toBe(true);
    // An answer that names no reader (the script reader before the frame reader existed) is the scripts'.
    expect(parsed.success && parsed.data.ok && [parsed.data.reader, parsed.data.providers[0]?.reader]).toEqual(['scripts', 'scripts']);
    // A site that plays in its own page is found by the `page` reader.
    const own = { name: 'self.example', movie: 'https://self.example/watch/movie/{id}', tv: null, found_in: 'https://self.example/watch/movie/550', reader: 'page' };
    expect(TemplatesAnswerSchema.safeParse({ ok: true, site: 'https://self.example/', reader: 'page', scripts_read: 0, providers: [own], skipped: [] }).success).toBe(true);
  });
});

describe('updateSource with the frame reader', () => {
  const framesAnswer = {
    ok: true,
    site: 'https://site.example/',
    reader: 'frames',
    scripts_read: 2,
    frames_read: 3,
    pages: ['https://site.example/movie/550'],
    providers: [{ name: 'vidnew.example', movie: 'https://vidnew.example/embed/movie/{id}', tv: null, found_in: 'https://vidnew.example/embed/movie/550', reader: 'frames' }],
    skipped: [],
  };

  function deps(answer: unknown) {
    const asked: string[][] = [];
    const inserted: string[] = [];
    return {
      asked,
      inserted,
      deps: {
        runner: async (args: string[]) => {
          asked.push(args);
          return answer;
        },
        registry: {
          list: async () => [{ name: 'VidFast', movie: 'https://vidfast.pro/movie/{id}', tv: null }],
          insert: async (rows: Array<{ name: string }>) => {
            inserted.push(...rows.map((r) => r.name));
            return rows.map((r) => r.name);
          },
        },
        knownTitles: async () => [FIGHT_CLUB],
        probe: async (_provider: string, title: KnownTitle) => ({ title: title.label, outcome: 'resolved' as const, took_s: 3, manifest_kind: 'hls', best_height: 1080, en_subtitle: true, detail: '' }),
      },
    };
  }

  it('hands the watch pages to the reader and says which reader found each provider', async () => {
    const t = deps(framesAnswer);
    const out = await updateSource('https://site.example/', t.deps, { watchPage: 'https://site.example/movie/550', episodePage: 'https://site.example/tv/1396/2/3' });
    expect(t.asked).toEqual([['templates', 'https://site.example/', '--watch', 'https://site.example/movie/550', '--episode', 'https://site.example/tv/1396/2/3']]);
    expect(out).toMatchObject({ ok: true, reader: 'frames', scripts_read: 2, frames_read: 3, found: 1, added: [{ name: 'vidnew.example', reader: 'frames', resolves: true }] });
    expect(t.inserted).toEqual(['vidnew.example']);
  });

  it('a frame provider the registry already has by address is known, whatever its name; the Chrome answers change nothing', async () => {
    const known = deps({ ...framesAnswer, providers: [{ ...framesAnswer.providers[0], name: 'vidfast.pro', movie: 'https://www.vidfast.pro/movie/{id}?autoPlay=true' }] });
    expect(await updateSource('https://site.example/', known.deps)).toMatchObject({ ok: true, added: [], known: [{ name: 'vidfast.pro', registry_name: 'VidFast' }] });
    expect(known.asked).toEqual([['templates', 'https://site.example/']]);
    for (const error of ['bot_check', 'chrome_unavailable', 'no_templates', 'no_tab']) {
      const failed = deps({ ok: false, site: 'https://site.example/', error, detail: 'x', scripts_read: 1 });
      expect(await updateSource('https://site.example/', failed.deps)).toEqual({ ok: false, site: 'https://site.example/', error, detail: 'x', registry_changed: false });
      expect(failed.inserted).toEqual([]);
    }
  });

  it('passes --from-tab when the owner already gated the site by hand, and surfaces no_tab unchanged', async () => {
    const t = deps(framesAnswer);
    await updateSource('https://site.example/', t.deps, { fromTab: true });
    expect(t.asked).toEqual([['templates', 'https://site.example/', '--from-tab']]);

    const noTab = deps({ ok: false, site: 'https://site.example/', error: 'no_tab', detail: 'gate it first', scripts_read: 0 });
    expect(await updateSource('https://site.example/', noTab.deps, { fromTab: true })).toEqual({ ok: false, site: 'https://site.example/', error: 'no_tab', detail: 'gate it first', registry_changed: false });
  });
});
