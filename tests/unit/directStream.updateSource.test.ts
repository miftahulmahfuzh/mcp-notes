import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ResolveOutput } from '../../src/directStream/types.js';
import { TemplatesAnswerSchema, loadKnownTitles, providerKey, toProbeResult, type KnownTitle } from '../../src/directStream/updateSource.js';
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
  });
});
