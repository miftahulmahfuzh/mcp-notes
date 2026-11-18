import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- a plain .mjs script without type declarations
import { ChromeError } from '../../../claude/streaming/chrome.mjs';
// @ts-expect-error -- a plain .mjs script without type declarations
import { BotCheckError } from '../../../claude/streaming/torrent/browser.mjs';
// @ts-expect-error -- a plain .mjs script without type declarations
import { clearGate, gateExpression, main } from '../../../claude/streaming/direct/cli.mjs';
// @ts-expect-error -- a plain .mjs script without type declarations
import { entriesFromFrames, entryFromPage, frameAddresses, looksLikeEpisodePage, numberTokens, pageNumbers, readFrameTemplates, readFrameTemplatesFromTab, templateFromFrame, wantedFor } from '../../../claude/streaming/direct/frames.mjs';
// @ts-expect-error -- a plain .mjs script without type declarations
import { templatesCommand } from '../../../claude/streaming/direct/templates.mjs';

const KNOWN = [
  { label: 'Fight Club (1999)', kind: 'movie', tmdb_id: 550 },
  { label: 'Breaking Bad S02E03', kind: 'tv', tmdb_id: 1396, season: 2, episode: 3 },
];

/** A sniffer that answers per address; every call is recorded. */
function fakeSniff(pages: Record<string, { frames?: string[]; hits?: unknown[]; bot_check?: boolean; throws?: unknown }>) {
  const calls: Array<{ url: string; options: unknown }> = [];
  const sniff = vi.fn(async (url: string, options: unknown) => {
    calls.push({ url, options });
    const page = pages[url] ?? {};
    if (page.throws !== undefined) throw page.throws;
    return { url, bot_check: page.bot_check === true, bot_check_reason: page.bot_check ? 'title Just a moment...' : null, frames: page.frames ?? [], hits: page.hits ?? [] };
  });
  return { sniff, calls };
}

const plainSite = (body = '<html><p>no scripts here</p></html>') => async (): Promise<Response> => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
const challenge = async (): Promise<Response> => new Response('<html><head><title>Just a moment...</title></head></html>', { status: 403 });

describe('direct streaming: provider templates from embed frames', () => {
  it('reads the numbers of an address: whole path segments and query values, and the number in a slug of the page', () => {
    expect(numberTokens(new URL('https://a.example/embed/tv/1396/2/3?x=y&color=215&t=7')).map((t: any) => [t.value, t.where, t.key])).toEqual([
      ['1396', 'path', null],
      ['2', 'path', null],
      ['3', 'path', null],
      ['215', 'query', 'color'],
      ['7', 'query', 't'],
    ]);
    expect(pageNumbers(new URL('https://site.example/watch/550-fight-club?ref=1'))).toEqual(['1', '550']);
    expect(pageNumbers(new URL('https://site.example/film/fight-club-550.html'))).toEqual(['550']);
  });

  it('puts {id} where the film\'s TMDB id is, in a path or a query, and leaves the rest of the address alone', () => {
    const wanted = { ids: new Set(['550']), season: null, episode: null };
    expect(templateFromFrame('https://vidfast.pro/movie/550?autoPlay=true', wanted)).toEqual({ kind: 'movie', url: 'https://vidfast.pro/movie/{id}?autoPlay=true' });
    expect(templateFromFrame('https://vidsrc.me/embed/movie?tmdb=550&color=215fb3', wanted)).toEqual({ kind: 'movie', url: 'https://vidsrc.me/embed/movie?tmdb={id}&color=215fb3' });
    // No id, an advert, a picture, not https, not an address: nothing.
    expect(templateFromFrame('https://ads.example/slot/12345', wanted)).toBeNull();
    expect(templateFromFrame('https://player.example/e/abcDEF', wanted)).toBeNull();
    expect(templateFromFrame('https://cdn.example/poster/550.jpg', wanted)).toBeNull();
    expect(templateFromFrame('http://vidfast.pro/movie/550', wanted)).toBeNull();
    expect(templateFromFrame('about:blank', wanted)).toBeNull();
  });

  it('puts {season} and {episode} where an episode page\'s numbers are, by name when the address names them', () => {
    const wanted = { ids: new Set(['1396']), season: '2', episode: '3' };
    expect(templateFromFrame('https://vidfast.pro/tv/1396/2/3?autoPlay=true', wanted)).toEqual({ kind: 'tv', url: 'https://vidfast.pro/tv/{id}/{season}/{episode}?autoPlay=true' });
    expect(templateFromFrame('https://vidsrc.me/embed/tv?tmdb=1396&episode=3&season=2', wanted)).toEqual({ kind: 'tv', url: 'https://vidsrc.me/embed/tv?tmdb={id}&episode={episode}&season={season}' });
    // The id without both numbers is not an episode address.
    expect(templateFromFrame('https://vidfast.pro/tv/1396/2', wanted)).toBeNull();
    // Season and episode with the same number: the first is the season.
    expect(templateFromFrame('https://x.example/tv/1396/1/1', { ids: new Set(['1396']), season: '1', episode: '1' })).toEqual({ kind: 'tv', url: 'https://x.example/tv/{id}/{season}/{episode}' });
  });

  it('knows the id from the known titles or from the page\'s own address, and an episode page\'s season and episode', () => {
    expect(wantedFor('https://site.example/movie/fight-club', [], KNOWN, false)).toEqual({ ids: new Set(['550', '1396']), season: null, episode: null });
    expect([...wantedFor('https://site.example/watch/872585-oppenheimer', [], KNOWN, false).ids]).toContain('872585');
    // A known series: its own season and episode, whatever the page's address says.
    expect(wantedFor('https://site.example/tv/breaking-bad/s2/e3', ['https://v.example/tv/1396/2/3'], KNOWN, true)).toEqual({ ids: new Set(['1396']), season: '2', episode: '3' });
    // Another series: the numbers after the id in the page's address, or its named parameters.
    expect(wantedFor('https://site.example/tv/94997/2/5', [], KNOWN, true)).toEqual({ ids: new Set(['94997']), season: '2', episode: '5' });
    expect(wantedFor('https://site.example/watch?id=94997&episode=5&season=2', [], KNOWN, true)).toEqual({ ids: new Set(['94997']), season: '2', episode: '5' });
  });

  it('keeps only frames, names a provider after its frame\'s host, and leaves out the site\'s own frames and repeats', () => {
    expect(frameAddresses(['page https://site.example/movie/550', 'iframe https://vidfast.pro/movie/550', 'iframe https://vidfast.pro/movie/550', 'worker https://w.example/1', 'iframe about:blank', 7])).toEqual(['https://vidfast.pro/movie/550']);
    const entries = entriesFromFrames(
      'https://www.site.example/movie/550',
      ['https://www.vidfast.pro/movie/550?autoPlay=true', 'https://site.example/player/550', 'https://ads.example/x/99', 'https://www.vidfast.pro/movie/550?autoPlay=true'],
      KNOWN,
      false,
    );
    expect(entries).toEqual([{ name: 'vidfast.pro', kind: 'movie', url: 'https://www.vidfast.pro/movie/{id}?autoPlay=true', found_in: 'https://www.vidfast.pro/movie/550?autoPlay=true', reader: 'frames' }]);
  });

  it('reads a film page and an episode page through the sniffer, out of sight, and merges them per provider', async () => {
    const { sniff, calls } = fakeSniff({
      'https://site.example/movie/550': { frames: ['page https://site.example/movie/550', 'iframe https://vidnew.example/embed/movie/550', 'iframe https://ads.example/b/1'] },
      'https://site.example/tv/1396/2/3': { frames: ['iframe https://vidnew.example/embed/tv/1396/2/3'] },
    });
    const answer = await readFrameTemplates({ watch: 'https://site.example/movie/550', episode: 'https://site.example/tv/1396/2/3' }, { sniff, known: KNOWN });
    expect(answer).toMatchObject({ ok: true, frames_read: 3, pages: ['https://site.example/movie/550', 'https://site.example/tv/1396/2/3'] });
    expect(answer.entries.map((e: any) => [e.name, e.kind, e.url])).toEqual([
      ['vidnew.example', 'movie', 'https://vidnew.example/embed/movie/{id}'],
      ['vidnew.example', 'tv', 'https://vidnew.example/embed/tv/{id}/{season}/{episode}'],
    ]);
    expect(calls.map((c) => c.url)).toEqual(['https://site.example/movie/550', 'https://site.example/tv/1396/2/3']);
  });

  it('a bot check in the streaming Chrome is the answer, and the second page is never opened', async () => {
    const { sniff, calls } = fakeSniff({ 'https://cf.example/movie/550': { bot_check: true, frames: ['iframe https://vidnew.example/embed/movie/550'] } });
    const answer = await readFrameTemplates({ watch: 'https://cf.example/movie/550', episode: 'https://cf.example/tv/1396/2/3' }, { sniff, known: KNOWN });
    expect(answer).toMatchObject({ ok: false, error: 'bot_check' });
    expect(answer.detail).toContain('It is not got past');
    expect(calls).toHaveLength(1);
  });

  it('answers chrome_unavailable when the streaming Chrome cannot be used, and no_templates when no frame carries an id', async () => {
    const down = fakeSniff({ 'https://site.example/movie/550': { throws: new ChromeError('no_chrome', 'chrome.exe was not found') } });
    expect(await readFrameTemplates({ watch: 'https://site.example/movie/550' }, { sniff: down.sniff, known: KNOWN })).toMatchObject({ ok: false, error: 'chrome_unavailable', detail: expect.stringContaining('no_chrome') });
    const home = fakeSniff({ 'https://site.example/': { frames: ['iframe https://ads.example/b/1'] } });
    const none = await readFrameTemplates({ watch: 'https://site.example/' }, { sniff: home.sniff, known: KNOWN });
    expect(none).toMatchObject({ ok: false, error: 'no_templates' });
    expect(none.detail).toContain('watch_page');
  });
});

describe('direct streaming: a site that plays in its own page is its own embed', () => {
  const STREAM = { url: 'https://relay.example/p/abc', status: 200, mime: 'application/dash+xml', body: '<?xml version="1.0"?><MPD></MPD>' };
  const FILM = 'https://self.example/watch/movie/550';
  const EPISODE = 'https://self.example/watch/tv/231257?season=1&episode=1';

  it('templates the page\'s own address, with the season and episode by name', () => {
    expect(entryFromPage(FILM, KNOWN, false)).toEqual({ name: 'self.example', kind: 'movie', url: 'https://self.example/watch/movie/{id}', found_in: FILM, reader: 'page' });
    expect(entryFromPage(EPISODE, KNOWN, true)).toMatchObject({ kind: 'tv', url: 'https://self.example/watch/tv/{id}?season={season}&episode={episode}' });
    // No id in the address, or an episode page that names no episode: nothing.
    expect(entryFromPage('https://self.example/', KNOWN, false)).toBeNull();
    expect(entryFromPage('https://self.example/watch/tv/231257?season=1', KNOWN, true)).toBeNull();
  });

  it('is read only when the page gave no frame template and loaded a stream by itself', async () => {
    const own = fakeSniff({ [FILM]: { hits: [STREAM] }, [EPISODE]: { hits: [STREAM] } });
    const answer = await readFrameTemplates({ watch: FILM, episode: EPISODE }, { sniff: own.sniff, known: KNOWN });
    expect(answer.entries.map((e: any) => [e.name, e.kind, e.url, e.reader])).toEqual([
      ['self.example', 'movie', 'https://self.example/watch/movie/{id}', 'page'],
      ['self.example', 'tv', 'https://self.example/watch/tv/{id}?season={season}&episode={episode}', 'page'],
    ]);
    // A page that loads nothing, or only an error page where a stream should be, is no provider.
    const silent = fakeSniff({ [FILM]: { hits: [{ ...STREAM, status: 403 }, { url: 'https://x.example/a.m3u8', status: 200, mime: 'text/html', body: '<html>' }] } });
    expect(await readFrameTemplates({ watch: FILM }, { sniff: silent.sniff, known: KNOWN })).toMatchObject({ ok: false, error: 'no_templates' });
    // A frame with the id wins: the site is an aggregator, not the embed.
    const framed = fakeSniff({ [FILM]: { frames: ['iframe https://vidnew.example/embed/movie/550'], hits: [STREAM] } });
    expect((await readFrameTemplates({ watch: FILM }, { sniff: framed.sniff, known: KNOWN })).entries.map((e: any) => [e.name, e.reader])).toEqual([['vidnew.example', 'frames']]);
  });

  it('templatesCommand says `page`, per provider and for the answer, and --from-tab needs no watch page after a bot check', async () => {
    const own = fakeSniff({ [FILM]: { hits: [STREAM] } });
    const { code, answer } = await templatesCommand(['https://self.example/', '--watch', FILM], { fetch: challenge, sniff: own.sniff, known: KNOWN });
    expect(code).toBe(0);
    expect(answer).toMatchObject({ ok: true, reader: 'page', providers: [{ name: 'self.example', movie: 'https://self.example/watch/movie/{id}', tv: null, reader: 'page' }] });
    const ask = vi.fn(async () => ({ url: FILM, frames: [], playing: true }));
    const tab = await templatesCommand(['https://self.example/', '--from-tab'], { fetch: challenge, ask, sniff: own.sniff, known: KNOWN });
    expect(tab).toMatchObject({ code: 0, answer: { reader: 'page' } });
    expect(own.sniff).toHaveBeenCalledTimes(1);
  });
});

describe('direct streaming: the gated-tab frame reader (no fresh navigation)', () => {
  /** A fake askInTab (origin, expression, options) -> reply, calls recorded. */
  function fakeAsk(replies: Record<string, { url?: string; frames?: string[]; playing?: boolean; throws?: unknown }>) {
    const calls: string[] = [];
    const ask = vi.fn(async (origin: string) => {
      calls.push(origin);
      const r = replies[origin] ?? {};
      if (r.throws !== undefined) throw r.throws;
      return { url: r.url ?? origin, frames: r.frames ?? [], playing: r.playing === true };
    });
    return { ask, calls };
  }

  it('guesses an episode page from its own address, never from the site', () => {
    expect(looksLikeEpisodePage('https://site.example/naive-leader-season-1-episode-1-2026')).toBe(true);
    expect(looksLikeEpisodePage('https://site.example/tv/breaking-bad/s2e3')).toBe(true);
    expect(looksLikeEpisodePage('https://site.example/watch/m/1368337')).toBe(false);
    // Named in the query only.
    expect(looksLikeEpisodePage('https://site.example/watch/tv/231257?season=1&episode=1')).toBe(true);
    expect(looksLikeEpisodePage('https://site.example/watch/movie/550?autoplay=1')).toBe(false);
  });

  it('takes a gated tab that plays in its own page as the template, a film page only', async () => {
    const film = fakeAsk({ 'https://self.example': { url: 'https://self.example/watch/movie/550', playing: true } });
    expect((await readFrameTemplatesFromTab('https://self.example', { ask: film.ask, known: KNOWN })).entries).toEqual([
      { name: 'self.example', kind: 'movie', url: 'https://self.example/watch/movie/{id}', found_in: 'https://self.example/watch/movie/550', reader: 'page' },
    ]);
    const idle = fakeAsk({ 'https://self.example': { url: 'https://self.example/watch/movie/550' } });
    expect(await readFrameTemplatesFromTab('https://self.example', { ask: idle.ask, known: KNOWN })).toMatchObject({ ok: false, error: 'no_templates' });
    // An episode tab gives no film template, and is never read as a film's.
    const episode = fakeAsk({ 'https://self.example': { url: 'https://self.example/watch/tv/231257?season=1&episode=1', playing: true } });
    const answer = await readFrameTemplatesFromTab('https://self.example', { ask: episode.ask, known: KNOWN });
    expect(answer).toMatchObject({ ok: false, error: 'no_templates' });
    expect(answer.detail).toContain('episode');
    const half = fakeAsk({ 'https://self.example': { url: 'https://self.example/watch/tv/231257?season=1', playing: true } });
    expect(await readFrameTemplatesFromTab('https://self.example', { ask: half.ask, known: KNOWN })).toMatchObject({ ok: false, error: 'no_templates' });
  });

  it('reads the tab\'s current frames with no navigation, and derives templates from them', async () => {
    const { ask, calls } = fakeAsk({
      'https://site.example': { url: 'https://site.example/movie/550', frames: ['https://vidnew.example/embed/movie/550', 'https://ads.example/x/1'] },
    });
    const answer = await readFrameTemplatesFromTab('https://site.example', { ask, known: KNOWN });
    expect(answer).toMatchObject({ ok: true, frames_read: 2, pages: ['https://site.example/movie/550'] });
    expect(answer.entries).toEqual([{ name: 'vidnew.example', kind: 'movie', url: 'https://vidnew.example/embed/movie/{id}', found_in: 'https://vidnew.example/embed/movie/550', reader: 'frames' }]);
    expect(calls).toEqual(['https://site.example']);
  });

  it('answers no_tab when the tab never got past its challenge, and chrome_unavailable when the browser could not be driven', async () => {
    const gated = fakeAsk({ 'https://cf.example': { throws: new BotCheckError('no page got past its check') } });
    const noTab = await readFrameTemplatesFromTab('https://cf.example', { ask: gated.ask, known: KNOWN });
    expect(noTab).toMatchObject({ ok: false, error: 'no_tab' });
    expect(noTab.detail).toContain('gate');

    const down = fakeAsk({ 'https://cf.example': { throws: new ChromeError('no_chrome', 'chrome.exe was not found') } });
    const unavailable = await readFrameTemplatesFromTab('https://cf.example', { ask: down.ask, known: KNOWN });
    expect(unavailable).toMatchObject({ ok: false, error: 'chrome_unavailable' });
  });

  it('answers no_templates when no frame of the gated tab carries an id', async () => {
    const { ask } = fakeAsk({ 'https://site.example': { frames: ['https://ads.example/x/1'] } });
    const answer = await readFrameTemplatesFromTab('https://site.example', { ask, known: KNOWN });
    expect(answer).toMatchObject({ ok: false, error: 'no_templates' });
  });

  it('templatesCommand reads from the gated tab with --from-tab instead of opening the sniffer', async () => {
    const { sniff } = fakeSniff({});
    const { ask, calls } = fakeAsk({
      'https://site.example/movie/550': { frames: ['https://vidnew.example/embed/movie/550'] },
    });
    const out = await templatesCommand(['https://site.example/movie/550', '--from-tab'], { fetch: plainSite(), sniff, ask, known: KNOWN });
    expect(out).toMatchObject({ code: 0, answer: { ok: true, reader: 'frames', providers: [{ name: 'vidnew.example', reader: 'frames' }] } });
    expect(sniff).not.toHaveBeenCalled();
    expect(calls).toEqual(['https://site.example/movie/550']);
  });

  it('templatesCommand\'s --from-tab answers the scripts\' failure without `ask`, and never calls the sniffer', async () => {
    const { sniff } = fakeSniff({});
    const out = await templatesCommand(['https://site.example/movie/550', '--from-tab'], { fetch: plainSite(), sniff, known: KNOWN });
    expect(out).toMatchObject({ code: 1, answer: { error: 'no_templates' } });
    expect(sniff).not.toHaveBeenCalled();
  });

  it('the gate expression compiles', () => {
    expect(() => new Function(`return ${gateExpression()}`)).not.toThrow();
  });

  it('clearGate foregrounds the tab, waits out the challenge, and reports whether it cleared', async () => {
    const foreground = vi.fn(async () => ({ created: false, activated: true }));
    const sleepFn = vi.fn(async () => {});
    const ORIGIN = 'https://site.example';

    const ask = vi.fn().mockResolvedValueOnce({ bot_check: true, title: 'Just a moment...' }).mockResolvedValueOnce({ bot_check: false, title: 'site.example' });
    expect(await clearGate(ORIGIN, Date.now() + 60_000, { foreground, ask, sleep: sleepFn })).toEqual({ cleared: true, title: 'site.example' });
    expect(foreground).toHaveBeenCalledWith(ORIGIN, expect.anything());

    // A challenge that holds the only tab answers no_tab (a BotCheckError here): clearGate waits, it is not fatal.
    const askBot = vi.fn().mockRejectedValueOnce(new BotCheckError('x')).mockResolvedValueOnce({ bot_check: false, title: 'through' });
    expect(await clearGate(ORIGIN, Date.now() + 60_000, { foreground, ask: askBot, sleep: sleepFn })).toEqual({ cleared: true, title: 'through' });

    const stuck = await clearGate(ORIGIN, Date.now() + 10, { foreground, ask: vi.fn(async () => ({ bot_check: true, title: 'Just a moment...' })), sleep: sleepFn });
    expect(stuck).toEqual({ cleared: false, title: 'Just a moment...' });
  });

  it('the gate command foregrounds the site and reports it cleared once the challenge is gone', async () => {
    const gate = vi.fn(async () => ({ cleared: true, title: 'site.example' }));
    const printed: any[] = [];
    const code = await main(['gate', 'https://site.example/movie/550', '--deadline-s', '30'], { print: (v: unknown) => printed.push(v), gate });
    expect(code).toBe(0);
    expect(printed[0]).toEqual({ ok: true, origin: 'https://site.example', cleared: true, title: 'site.example' });
    expect(gate).toHaveBeenCalledWith('https://site.example', expect.any(Number));
  });

  it('gate reports a named Chrome failure without crashing', async () => {
    const gate = vi.fn(async () => {
      throw new ChromeError('chrome_not_reachable', 'nothing answers on port 9333');
    });
    const printed: any[] = [];
    const code = await main(['gate', 'https://site.example/'], { print: (v: unknown) => printed.push(v), gate });
    expect(code).toBe(1);
    expect(printed[0]).toMatchObject({ ok: false, origin: 'https://site.example', error: 'chrome_not_reachable' });
  });
});

describe('direct streaming: templates, scripts first and frames as the fallback', () => {
  const FRAMES = { 'https://site.example/movie/550': { frames: ['iframe https://vidnew.example/embed/movie/550'] } };

  it('never opens the browser when the scripts hold templates, and says the scripts found them', async () => {
    const { sniff } = fakeSniff({});
    const page = async (): Promise<Response> => new Response('<script>var s={VidNew:`https://vidnew.example/embed/movie/${e}`}</script>', { status: 200 });
    const { code, answer } = await templatesCommand(['https://site.example/'], { fetch: page, sniff, known: KNOWN });
    expect(code).toBe(0);
    expect(answer).toMatchObject({ ok: true, reader: 'scripts', providers: [{ name: 'VidNew', movie: 'https://vidnew.example/embed/movie/{id}', reader: 'scripts' }] });
    expect(sniff).not.toHaveBeenCalled();
  });

  it('reads the frames when the scripts hold no template: the site address itself, or --watch and --episode', async () => {
    const own = fakeSniff(FRAMES);
    const direct = await templatesCommand(['https://site.example/movie/550'], { fetch: plainSite(), sniff: own.sniff, known: KNOWN });
    expect(direct).toMatchObject({
      code: 0,
      answer: { ok: true, reader: 'frames', frames_read: 1, providers: [{ name: 'vidnew.example', movie: 'https://vidnew.example/embed/movie/{id}', tv: null, reader: 'frames', found_in: 'https://vidnew.example/embed/movie/550' }] },
    });

    const both = fakeSniff({ ...FRAMES, 'https://site.example/tv/1396/2/3': { frames: ['iframe https://vidnew.example/embed/tv/1396/2/3'] } });
    const watched = await templatesCommand(['https://site.example/', '--watch', 'https://site.example/movie/550', '--episode', 'https://site.example/tv/1396/2/3'], { fetch: plainSite(), sniff: both.sniff, known: KNOWN });
    expect(watched.answer.providers).toEqual([
      { name: 'vidnew.example', movie: 'https://vidnew.example/embed/movie/{id}', tv: 'https://vidnew.example/embed/tv/{id}/{season}/{episode}', found_in: 'https://vidnew.example/embed/movie/550', reader: 'frames' },
    ]);
    expect(both.calls.map((c) => c.url)).toEqual(['https://site.example/movie/550', 'https://site.example/tv/1396/2/3']);
  });

  it('opens no browser for a plain request\'s bot check unless a watch page was given, and never with --no-chrome or without a sniffer', async () => {
    const refused = fakeSniff(FRAMES);
    expect(await templatesCommand(['https://site.example/'], { fetch: challenge, sniff: refused.sniff, known: KNOWN })).toMatchObject({ code: 1, answer: { error: 'bot_check' } });
    expect(refused.sniff).not.toHaveBeenCalled();
    const asked = await templatesCommand(['https://site.example/', '--watch', 'https://site.example/movie/550'], { fetch: challenge, sniff: refused.sniff, known: KNOWN });
    expect(asked).toMatchObject({ code: 0, answer: { reader: 'frames' } });

    const off = fakeSniff(FRAMES);
    expect(await templatesCommand(['https://site.example/movie/550', '--no-chrome'], { fetch: plainSite(), sniff: off.sniff, known: KNOWN })).toMatchObject({ code: 1, answer: { error: 'no_templates' } });
    expect(off.sniff).not.toHaveBeenCalled();
    expect(await templatesCommand(['https://site.example/movie/550'], { fetch: plainSite(), known: KNOWN })).toMatchObject({ code: 1, answer: { error: 'no_templates' } });
  });

  it('says what both readers found when neither has a template, and reports a bot check in Chrome as bot_check', async () => {
    const empty = await templatesCommand(['https://site.example/'], { fetch: plainSite(), sniff: fakeSniff({}).sniff, known: KNOWN });
    expect(empty).toMatchObject({ code: 1, answer: { ok: false, error: 'no_templates', site: 'https://site.example/' } });
    expect(empty.answer.detail).toMatch(/^Scripts: .* Frames: /);
    const walled = await templatesCommand(['https://site.example/movie/550'], { fetch: plainSite(), sniff: fakeSniff({ 'https://site.example/movie/550': { bot_check: true } }).sniff, known: KNOWN });
    expect(walled).toMatchObject({ code: 1, answer: { ok: false, error: 'bot_check' } });
    const episodeOnly = await templatesCommand(['https://site.example/', '--watch', 'https://site.example/', '--episode', 'https://site.example/tv/1396/2/3'], {
      fetch: plainSite(),
      sniff: fakeSniff({ 'https://site.example/tv/1396/2/3': { frames: ['iframe https://vidnew.example/embed/tv/1396/2/3'] } }).sniff,
      known: KNOWN,
    });
    expect(episodeOnly).toMatchObject({ code: 1, answer: { error: 'no_templates' } });
  });

  it('refuses a flag without an address, and the CLI hands its sniffer and flags through', async () => {
    expect(await templatesCommand(['https://site.example/', '--watch', 'nope'], {})).toMatchObject({ code: 2, answer: { error: 'usage' } });
    expect(await templatesCommand(['https://site.example/', '--frames'], {})).toMatchObject({ code: 2, answer: { error: 'usage' } });
    const printed: any[] = [];
    const { sniff, calls } = fakeSniff({});
    // An address nothing answers: the script reader says unreachable, and the browser is not opened for that.
    const code = await main(['templates', 'http://127.0.0.1:9/', '--watch', 'https://site.example/movie/550', '--no-chrome'], { print: (v: unknown) => printed.push(v), sniff });
    expect(code).toBe(1);
    expect(printed[0]).toMatchObject({ ok: false, error: 'unreachable' });
    expect(calls).toHaveLength(0);
  });
});
