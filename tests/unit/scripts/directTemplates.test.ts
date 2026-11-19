import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain .mjs script without type declarations
import { main } from '../../../claude/streaming/direct/cli.mjs';
// @ts-expect-error -- a plain .mjs script without type declarations
import { LIMITS, USER_AGENT, extractTemplates, mergeProviders, readSiteTemplates, templatesCommand } from '../../../claude/streaming/direct/templates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CHUNK = readFileSync(path.join(ROOT, 'docs/plans/direct-streaming-spike/fmovies-movie-details-chunk.js'), 'utf8');

/** The 24 servers of ww6-fmovies.com's movie-details chunk, as the analysis lists them. */
const FMOVIES: Array<[string, string]> = [
  ['VidNest', 'https://vidnest.fun/movie/{id}'],
  ['Videasy', 'https://player.videasy.net/movie/{id}'],
  ['VidKing', 'https://www.vidking.net/embed/movie/{id}'],
  ['Peachify', 'https://peachify.top/embed/movie/{id}'],
  ['Smashy', 'https://player.smashystream.com/movie/{id}'],
  ['VidUp', 'https://vidup.to/movie/{id}?autoPlay=true'],
  ['VidFast', 'https://vidfast.pro/movie/{id}?autoPlay=true'],
  ['VidLink', 'https://vidlink.pro/movie/{id}?autoplay=true&title=true'],
  ['VidMov', 'https://vidsrc.mov/embed/movie/{id}'],
  ['VidFyi', 'https://vidsrc.fyi/embed/movie/{id}'],
  ['VidRock', 'https://vidrock.net/movie/{id}'],
  ['Movies111', 'https://111movies.com/movie/{id}'],
  ['NonTongo', 'https://www.nontongo.win/embed/movie/{id}'],
  ['VidSrc', 'https://vidsrc.me/embed/movie?tmdb={id}'],
  ['HyperLink', 'https://vidsrc.wtf/api/1/movie/?id={id}&color=215fb3'],
  ['NexaStream', 'https://vidsrc.wtf/api/2/movie/?id={id}&color=215fb3'],
  ['UltraBox', 'https://player.vidplus.to/embed/movie/{id}'],
  ['CloudBox', 'https://vidify.top/embed/movie/{id}'],
  ['UpCloud', 'https://player.vidsrc.co/embed/movie/{id}'],
  ['StreamVault', 'https://hexa.watch/watch/movie/{id}'],
  ['MediaHub', 'https://spencerdevs.xyz/movie/{id}?theme=215fb3'],
  ['CloudPlay', 'https://vidsrc.cc/v2/embed/movie/{id}'],
  ['StreamBoxHD', 'https://test.autoembed.cc/embed/movie/{id}'],
  ['MovieVault', 'https://rivestream.org/embed?type=movie&id={id}'],
];

const HASH = '0123456789abcdef0123';
const CHUNK_PATH = `/component---src-pages-movie-details-js-${HASH}.js`;

type Route = { status?: number; body: string; headers?: Record<string, string> } | Error;

/** A fetch that serves only the given addresses and records every request. */
function fakeFetch(routes: Record<string, Route>) {
  const asked: Array<{ url: string; userAgent: string | null }> = [];
  const fetch = async (url: string, init?: { headers?: Record<string, string> }): Promise<Response> => {
    asked.push({ url, userAgent: init?.headers?.['user-agent'] ?? null });
    const route = routes[url];
    if (route === undefined) return new Response('not found', { status: 404 });
    if (route instanceof Error) throw route;
    return new Response(route.body, { status: route.status ?? 200, headers: route.headers ?? {} });
  };
  return { fetch, asked };
}

/** A Gatsby-shaped site: a page naming its webpack runtime, which maps chunk 623 to the movie-details chunk. */
function gatsbySite(origin: string): Record<string, Route> {
  return {
    [`${origin}/`]: {
      body: `<html><head><script src="/webpack-runtime-aaaaaaaaaaaaaaaaaaaa.js"></script><script src="https://www.googletagmanager.com/gtag/js?id=G-1"></script></head></html>`,
    },
    [`${origin}/webpack-runtime-aaaaaaaaaaaaaaaaaaaa.js`]: {
      body: `o.p="/",o.u=e=>({125:"component---src-pages-index-js",623:"component---src-pages-movie-details-js"}[e]||e)+"-"+{125:"ffffffffffffffffffff",623:"${HASH}"}[e]+".js"`,
    },
    [`${origin}${CHUNK_PATH}`]: { body: CHUNK },
  };
}

describe('direct streaming: reading provider templates', () => {
  it('finds the 24 named film templates in the fmovies movie-details chunk, and not its poster addresses', () => {
    const { providers, skipped } = mergeProviders(extractTemplates(CHUNK));
    expect(providers.map((p: { name: string; movie: string }) => [p.name, p.movie])).toEqual(FMOVIES);
    expect(providers.every((p: { tv: string | null }) => p.tv === null)).toBe(true);
    expect(skipped).toEqual([]);
    expect(JSON.stringify(providers)).not.toContain('image.tmdb.org');
  });

  it('reads concatenations, merges an episode template by name, and skips what is not a film provider', () => {
    const source = [
      'const a={Alpha:"https://alpha.example/embed/movie/"+e,Beta:"https://beta.example/e?id="+e+"&x=1",src:"https://img.example/"+e};',
      'const b={Alpha:`https://alpha.example/tv/${e}/${t}/${n}`,Show:`https://show.example/tv/${e}`,OnlyTv:`https://o.example/tv/${e}?s=${s}&e=${n}`,Imdb:`https://i.example/movie/tt${e}`,Two:`https://two.example/${e}/${t}`,Expr:`https://x.example/${e.id}`};',
      'const c=ok?x:`https://ternary.example/movie/${e}`;',
    ].join('\n');
    const { providers, skipped } = mergeProviders(extractTemplates(source, 'https://s.example/app.js'));
    expect(providers).toEqual([
      { name: 'Alpha', movie: 'https://alpha.example/embed/movie/{id}', tv: 'https://alpha.example/tv/{id}/{season}/{episode}', found_in: 'https://s.example/app.js' },
      { name: 'Beta', movie: 'https://beta.example/e?id={id}&x=1', tv: null, found_in: 'https://s.example/app.js' },
    ]);
    expect(skipped).toEqual([{ name: 'OnlyTv', reason: 'no_film_template' }]);
  });

  it('does not take a share button or a relay for a provider', () => {
    // bingebang.st's share menu and rivestream.app's relay, 2026-11-19: one variable each, and no title's id.
    const source = 'const share={reddit:`https://www.reddit.com/submit?url=${e}`,whatsapp:`https://wa.me/?text=${e}`,telegram:`https://t.me/share/url?url=${e}`,x:`https://twitter.com/intent/tweet?url=${e}`,relay:`https://proxy.example/?destination=${e}`,VidOne:`https://vidone.example/embed/movie/${e}`,VidTwo:`https://vidtwo.example/embed?tmdb=${e}`,VidThree:`https://vidthree.example/api/movie/?id=${e}&color=fff`}';
    expect(extractTemplates(source).map((e: { name: string }) => e.name)).toEqual(['VidOne', 'VidTwo', 'VidThree']);
  });

  it('follows the page to its webpack runtime and the movie-details chunk, on the site only, as a plain client', async () => {
    const { fetch, asked } = fakeFetch(gatsbySite('https://fm.example'));
    const answer = await readSiteTemplates('https://fm.example/', { fetch });
    expect(answer.ok).toBe(true);
    expect(answer.providers.map((p: { name: string; movie: string }) => [p.name, p.movie])).toEqual(FMOVIES);
    expect(answer.providers[0].found_in).toBe(`https://fm.example${CHUNK_PATH}`);
    expect(asked.map((a) => a.url)).not.toContain('https://www.googletagmanager.com/gtag/js?id=G-1');
    expect(new Set(asked.map((a) => a.userAgent))).toEqual(new Set([USER_AGENT]));
    expect(USER_AGENT).not.toMatch(/Mozilla|Chrome|Safari/);
  });

  it('reads the likely chunk first and stops at the script bound', async () => {
    const routes = gatsbySite('https://b.example');
    const ids = Array.from({ length: 60 }, (_, i) => i + 1);
    const hex = (i: number): string => String(i).padStart(20, 'a');
    routes['https://b.example/webpack-runtime-aaaaaaaaaaaaaaaaaaaa.js'] = {
      body: `o.u=e=>({${ids.map((i) => `${i}:"chunk-${i}"`).join(',')},623:"component---src-pages-movie-details-js"}[e]||e)+"-"+{${ids.map((i) => `${i}:"${hex(i)}"`).join(',')},623:"${HASH}"}[e]+".js"`,
    };
    for (const i of ids) routes[`https://b.example/chunk-${i}-${hex(i)}.js`] = { body: 'var x=1' };
    const { fetch, asked } = fakeFetch(routes);
    const answer = await readSiteTemplates('https://b.example/', { fetch, limits: { ...LIMITS, maxScripts: 3 } });
    expect(answer.ok).toBe(true);
    expect(answer.providers).toHaveLength(24);
    expect(answer.scripts_read).toBeLessThanOrEqual(3);
    expect(asked.length).toBeLessThanOrEqual(4);
  });

  it('answers bot_check for a challenge page and reads nothing further', async () => {
    const { fetch, asked } = fakeFetch({ 'https://cf.example/': { status: 403, body: '<html><head><title>Just a moment...</title></head></html>' } });
    const answer = await readSiteTemplates('https://cf.example/', { fetch });
    expect(answer).toMatchObject({ ok: false, error: 'bot_check', scripts_read: 0 });
    expect(answer.detail).toContain("give a film's watch page (--watch)");
    expect(asked).toHaveLength(1);
  });

  it('answers no_templates for a page with no provider, unreachable for a host that does not answer, bad_url and usage', async () => {
    expect(await readSiteTemplates('https://plain.example/', fakeFetch({ 'https://plain.example/': { body: '<html><p>hi</p></html>' } })))
      .toMatchObject({ ok: false, error: 'no_templates' });
    const down = async (): Promise<Response> => {
      throw new Error('getaddrinfo ENOTFOUND down.example');
    };
    expect(await readSiteTemplates('https://down.example/', { fetch: down })).toMatchObject({ ok: false, error: 'unreachable', detail: 'getaddrinfo ENOTFOUND down.example' });
    expect(await readSiteTemplates('not a url', { fetch: down })).toMatchObject({ ok: false, error: 'bad_url' });
    expect(await templatesCommand([])).toMatchObject({ code: 2, answer: { error: 'usage' } });
    expect(await templatesCommand(['https://plain.example/'], fakeFetch({ 'https://plain.example/': { body: '' } }))).toMatchObject({ code: 1 });
  });

  it('is reachable through the direct CLI without a providers file', async () => {
    const printed: unknown[] = [];
    const code = await main(['templates'], { print: (v: unknown) => printed.push(v), readText: () => { throw new Error('read'); } });
    expect(code).toBe(2);
    expect(printed[0]).toMatchObject({ ok: false, error: 'usage' });
  });
});
