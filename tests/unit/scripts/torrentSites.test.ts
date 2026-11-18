// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { ChromeError } from '../../../claude/streaming/chrome.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { BotCheckError } from '../../../claude/streaming/torrent/browser.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { clearGate, gateExpression, main, readOptions } from '../../../claude/streaming/torrent/cli.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { parseMagnet, parseSize, releaseNames, sameTitle, searchWords, toRow } from '../../../claude/streaming/torrent/match.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { isBotCheckPage } from '../../../claude/streaming/torrent/page.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import x1337, { magnetsExpression, readMagnet, readRows as read1337xRows, searchExpression, searchPath as path1337x } from '../../../claude/streaming/torrent/sites/1337x.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import ext, { askExtMagnet, magnetExpression, navigateExpression, readRows as readExtRows, rowsExpression, searchPath as extPath } from '../../../claude/streaming/torrent/sites/ext.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import rutracker, { gateExpression as rutrackerGate, isLoggedIn, magnetsExpression as rutrackerMagnets, readMagnet as readRutrackerMagnet, readRows as readRutrackerRows, releaseName, searchExpression as rutrackerSearch, searchPath as rutrackerPath } from '../../../claude/streaming/torrent/sites/rutracker.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { TORRENT_SITE_MODULES } from '../../../claude/streaming/torrent/sites/index.mjs';

// Under jsdom import.meta.url is no file address, so the saved pages are found from the repo root (vitest's cwd).
const fixture = (name: string): string => readFileSync(path.resolve('tests/fixtures/torrent-sites', name), 'utf8');
// The server tsconfig has no DOM lib: jsdom gives DOMParser at run time, and the pages are untyped here.
const page = (name: string): any => new (globalThis as any).DOMParser().parseFromString(fixture(name), 'text/html');
const parses = (expression: string): void => {
  expect(() => new Function(`return ${expression}`)).not.toThrow();
};
const X = 'https://1337x.la';
const E = 'https://ext.to';

describe('torrent site modules', () => {
  it.each(Object.entries(TORRENT_SITE_MODULES) as Array<[string, any]>)('%s has the whole contract', (name, site) => {
    expect(site.name).toBe(name);
    expect(site.defaultOrigin).toMatch(/^https:\/\/[a-z0-9.-]+$/);
    expect(typeof site.label).toBe('string');
    expect(typeof site.needsTitle).toBe('boolean');
    for (const fn of ['search', 'magnets', 'releasePath']) expect(typeof site[fn]).toBe('function');
    expect(site.releasePath('https://elsewhere.example/torrent/1/x/', site.defaultOrigin)).toBeNull();
    expect(site.releasePath('javascript:alert(1)', site.defaultOrigin)).toBeNull();
    expect(site.releasePath('not a url', site.defaultOrigin)).toBeNull();
  });
});

describe('1337x pages (saved 2026-11-16)', () => {
  it('reads the rows of a result page', () => {
    const rows = read1337xRows(page('1337x-search-sintel.html'));
    expect(rows).toHaveLength(9);
    expect(rows[0]).toEqual({
      name: 'Sintel 4K UHD ENG FLAC ITA ENG Sub DMRip 1744p X264 ZMachine',
      href: '/torrent/1010994/Sintel-4K-UHD-ENG-FLAC-ITA-ENG-Sub-DMRip-1744p-X264-ZMachine/',
      seeds: '1',
      leeches: expect.any(String),
      size: '4.8 GB',
    });
    expect(toRow(rows[0], X)).toEqual({
      name: rows[0].name,
      page_url: 'https://1337x.la/torrent/1010994/Sintel-4K-UHD-ENG-FLAC-ITA-ENG-Sub-DMRip-1744p-X264-ZMachine/',
      seeds: 1,
      leeches: expect.any(Number),
      size_bytes: Math.round(4.8 * 1024 ** 3),
    });
    expect(x1337.releasePath(toRow(rows[0], X).page_url, X)).toBe('/torrent/1010994/Sintel-4K-UHD-ENG-FLAC-ITA-ENG-Sub-DMRip-1744p-X264-ZMachine/');
  });

  it('reads the magnet link of a release page', () => {
    const magnet = parseMagnet(readMagnet(page('1337x-release.html')));
    expect(magnet.info_hash).toBe('64877b5490208c3015c0f5121287949d62622e54');
    expect(magnet.trackers).toContain('udp://tracker.opentrackr.org:1337/announce');
  });

  it('asks films under Movies and an episode under TV', () => {
    expect(path1337x('Sintel', false, 1)).toBe('/category-search/Sintel/Movies/1/');
    expect(path1337x('Bear', true, 2)).toBe('/category-search/Bear/TV/2/');
  });

  it('builds expressions that parse', () => {
    parses(searchExpression(['/category-search/Sintel/Movies/1/', '/category-search/Sintel/Movies/2/']));
    parses(magnetsExpression(['/torrent/1/a/', '/torrent/2/b/']));
  });
});

describe('ext.to pages (saved 2026-11-16)', () => {
  it('reads the rows of an IMDb search', () => {
    const rows = readExtRows(page('ext-search-sintel.html'));
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({
      name: 'Sintel (2010) 720p BluRay x264 2.0 YTS YIFY',
      href: '/sintel-2010-720p-bluray-x264-2-0-yts-yify-15037012/',
      seeds: '33',
      leeches: '1',
      size: '136.52 MB',
      id: '15037012',
    });
    expect(toRow(rows[0], E)).toMatchObject({ seeds: 33, size_bytes: Math.round(136.52 * 1024 ** 2), page_url: 'https://ext.to/sintel-2010-720p-bluray-x264-2-0-yts-yify-15037012/' });
    expect(ext.releasePath(toRow(rows[0], E).page_url, E)).toBe('/sintel-2010-720p-bluray-x264-2-0-yts-yify-15037012/');
  });

  it('reads an episode search, every row that episode', () => {
    const rows = readExtRows(page('ext-search-bear-s02e03.html'));
    expect(rows).toHaveLength(8);
    for (const row of rows) expect(row.name).toMatch(/S02E03/);
  });

  it('searches by IMDb id, with the episode mark, most seeds first', () => {
    expect(extPath({ title: 'Sintel', year: 2010, season: null, episode: null, imdb: 'tt1727587' })).toBe('/browse/?imdb_id=tt1727587&sort=seeds&order=desc');
    expect(extPath({ title: 'The Bear', year: 2022, season: 2, episode: 3, imdb: 'tt14452776' })).toBe('/browse/?q=S02E03&imdb_id=tt14452776&sort=seeds&order=desc');
    expect(extPath({ title: 'Sintel', year: 2010, season: null, episode: null, imdb: null })).toBe('/browse/?q=Sintel+2010&sort=seeds&order=desc');
  });

  it("asks a release page's magnet the way its own button does", async () => {
    const answer = JSON.parse(fixture('ext-magnet.json'));
    const fetch = vi.fn(async () => ({ status: 200, json: async () => answer }));
    const out = await askExtMagnet({
      fetch,
      computeHMAC: (id: number, ts: number, token: string) => `h:${id}:${ts}:${token}`,
      sessid: '08cab522f5e0ce6a895f7e365a7d998a',
      pageToken: '6a3dfc854461768ba4652a2732343069',
      torrentId: 15037012,
      now: () => 1_794_832_570_000,
    });
    expect(parseMagnet(out.magnet).info_hash).toBe('a779fa758f2229586eebc2e5960eb32fe5659596');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, { method: string; body: URLSearchParams }];
    expect(url).toBe('/ajax/getTorrentMagnet.php');
    expect(init.method).toBe('POST');
    expect(Object.fromEntries(new URLSearchParams(init.body))).toEqual({
      torrent_id: '15037012',
      action: 'get_magnet',
      timestamp: '1794832570',
      hmac: 'h:15037012:1794832570:6a3dfc854461768ba4652a2732343069',
      sessid: '08cab522f5e0ce6a895f7e365a7d998a',
    });
  });

  it('asks nothing on a page without the button script', async () => {
    const fetch = vi.fn();
    expect(await askExtMagnet({ fetch, computeHMAC: null, sessid: '', pageToken: undefined, torrentId: 1, now: Date.now })).toEqual({ error: 'the page has no magnet button script' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('builds expressions that parse', () => {
    parses(navigateExpression('/browse/?imdb_id=tt1727587&sort=seeds&order=desc'));
    parses(rowsExpression('/browse/?imdb_id=tt1727587&sort=seeds&order=desc'));
    parses(magnetExpression('/sintel-2010-15037012/', '/sintel-2010-16241483/'));
    parses(magnetExpression('/sintel-2010-15037012/', null));
  });
});

describe('bot checks', () => {
  it("knows Cloudflare's page and not the sites' own", () => {
    expect(isBotCheckPage(page('ext-challenge.html'))).toBe(true);
    for (const name of ['1337x-search-sintel.html', '1337x-release.html', 'ext-search-sintel.html', 'ext-release-sintel.html']) expect(isBotCheckPage(page(name))).toBe(false);
  });

  it('the gate expression compiles', () => {
    parses(gateExpression());
  });

  it('knows a Turnstile managed challenge by its inline options script, without the title', () => {
    const turnstile = (html: string): any => new (globalThis as any).DOMParser().parseFromString(html, 'text/html');
    // ext's current gate: no "Just a moment" title, only the inline window._cf_chl_opt script and the widget.
    expect(isBotCheckPage(turnstile('<html><head><title>ext.to</title></head><body><div id="cf-chl-widget"></div></body></html>'))).toBe(true);
    expect(isBotCheckPage(turnstile('<html><body><script>window._cf_chl_opt = { cvId: "3" };</script></body></html>'))).toBe(true);
    expect(isBotCheckPage(turnstile('<html><body><div class="cf-turnstile"></div></body></html>'))).toBe(true);
    // A real result page that merely mentions the words in text is not a challenge.
    expect(isBotCheckPage(turnstile('<html><head><title>Search</title></head><body><p>No cf_chl_opt here.</p></body></html>'))).toBe(false);
  });
});

describe('matching a release name to the title', () => {
  const film = (title: string, year: number | null) => ({ title, year, season: null, episode: null });

  it('takes every Oppenheimer row of the saved page and nothing for another title', () => {
    const names = read1337xRows(page('1337x-search-oppenheimer.html')).map((row: { name: string }) => row.name);
    expect(names).toHaveLength(8);
    for (const name of names) expect(sameTitle(name, film('Oppenheimer', 2023))).toBe(true);
    expect(sameTitle('Hawaii Five-0 2010 S09E01 HDTV x264-KILLERS [eztv]', film('Sintel', 2010))).toBe(false);
    expect(sameTitle('Iron man 2 (2010) 1080p BrRip x264 - 1.60GB - YIFY', film('Sintel', 2010))).toBe(false);
  });

  it('reads titles that hold years, slashes and other alphabets', () => {
    expect(sameTitle('Blade.Runner.2049.2017.1080p.BluRay.x264', film('Blade Runner 2049', 2017))).toBe(true);
    expect(sameTitle('Blade.Runner.2049.2017.1080p.BluRay.x264', film('Blade Runner', 1982))).toBe(false);
    expect(sameTitle('1917.2019.1080p.WEBRip.x264', film('1917', 2019))).toBe(true);
    expect(sameTitle('Синтел / Sintel (2010) 4K', film('Sintel', 2010))).toBe(true);
    expect(sameTitle('Sintel / Durian [2010, Netherlands, short, fantasy, HDRip 1080p] 2x DVO + VO + ENG + Sub', film('Sintel', 2010))).toBe(true);
    expect(sameTitle('Sintel H264 Eng Multisubs Tntvillage', film('Sintel', 2010))).toBe(true);
    expect(sameTitle("Charlotte's.Web.2006.DVDRip.XviD", film("Charlotte's", 2010))).toBe(false);
    expect(releaseNames('Blade.Runner.2049.2017.1080p').years).toEqual([2049, 2017]);
  });

  it("does not compare an episode's year", () => {
    expect(sameTitle('The.Bear.S02E03.1080p.WEB.h264-EDITH', { title: 'The Bear', year: 2022, season: 2, episode: 3 })).toBe(true);
    expect(sameTitle('The Bear 2023 S02E03 720p', { title: 'The Bear', year: 2022, season: 2, episode: 3 })).toBe(true);
  });

  it('searches without the small words', () => {
    expect(searchWords('The Bear')).toBe('Bear');
    expect(searchWords('Lord of the Rings')).toBe('Lord Rings');
    expect(searchWords("Ocean's Eleven")).toBe("Ocean's Eleven");
    expect(searchWords('The The')).toBe('The The');
  });
});

describe('sizes and magnets', () => {
  it('reads sizes', () => {
    expect(parseSize('4.8 GB')).toBe(Math.round(4.8 * 1024 ** 3));
    expect(parseSize('136.52 MB')).toBe(Math.round(136.52 * 1024 ** 2));
    expect(parseSize('1,234.5 MB')).toBe(Math.round(1234.5 * 1024 ** 2));
    expect(parseSize('2 GiB')).toBe(2 * 1024 ** 3);
    expect(parseSize('')).toBeNull();
  });

  it('reads hex and base32 hashes and keeps only tracker addresses', () => {
    expect(parseMagnet('magnet:?xt=urn:btih:MSDXWVEQECGDAFOA6UJBFB4UTVRGELSU&dn=Sintel')?.info_hash).toBe('64877b5490208c3015c0f5121287949d62622e54');
    expect(parseMagnet('magnet:?xt=urn:btih:64877B5490208C3015C0F5121287949D62622E54&tr=udp%3A%2F%2Fa.example%3A1337&tr=javascript%3Ax')?.trackers).toEqual(['udp://a.example:1337']);
    expect(parseMagnet('magnet:?xt=urn:sha1:abc')).toBeNull();
    expect(parseMagnet('https://1337x.la/')).toBeNull();
  });
});

describe('cli.mjs', () => {
  const ORIGIN = 'https://1337x.example';
  const SINTEL = { name: 'Sintel.2010.720p.BluRay.x264', page_url: `${ORIGIN}/torrent/1/sintel-720p/`, seeds: 12, leeches: 1, size_bytes: 100 };
  const HAWAII = { name: 'Hawaii Five-0 2010 S09E01 HDTV x264-KILLERS [eztv]', page_url: `${ORIGIN}/torrent/2/hawaii/`, seeds: 1717, leeches: 470, size_bytes: 200 };
  const HASH = 'ab'.repeat(20);

  function fakeSite(overrides: Record<string, unknown> = {}) {
    return {
      name: '1337x',
      label: '1337x',
      defaultOrigin: ORIGIN,
      needsTitle: true,
      releasePath: x1337.releasePath,
      search: vi.fn(async () => ({ url: `${ORIGIN}/category-search/Sintel/Movies/1/`, rows: [SINTEL, HAWAII] })),
      magnets: vi.fn(async (_origin: string, paths: string[]) => paths.map((path) => ({ path, magnet: `magnet:?xt=urn:btih:${HASH}&tr=udp%3A%2F%2Ftracker.example%3A1337`, error: null }))),
      ...overrides,
    };
  }

  async function run(argv: string[], site: ReturnType<typeof fakeSite>) {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await main(argv, { sites: { '1337x': site } });
      return { code, out: JSON.parse(String(log.mock.calls.at(-1)?.[0])) };
    } finally {
      log.mockRestore();
    }
  }

  it('search keeps only the releases named as the title', async () => {
    const site = fakeSite();
    const { code, out } = await run(['1337x', 'search', '--title', 'Sintel', '--year', '2010', '--origin', ORIGIN], site);
    expect(code).toBe(0);
    expect(out.rows).toEqual([SINTEL]);
    expect(out.others).toBe(1);
    expect(site.search).toHaveBeenCalledWith(ORIGIN, { title: 'Sintel', year: 2010, season: null, episode: null, imdb: null }, { deadline: expect.any(Number) });
  });

  it('search without a title on 1337x asks nothing', async () => {
    const site = fakeSite();
    const { code, out } = await run(['1337x', 'search', '--imdb', 'tt1727587'], site);
    expect(code).toBe(2);
    expect(out.error).toBe('no_title');
    expect(site.search).not.toHaveBeenCalled();
  });

  it("magnets refuses an address that is not a release page on the site", async () => {
    const site = fakeSite();
    const { code, out } = await run(['1337x', 'magnets', '--origin', ORIGIN, 'https://evil.example/torrent/1/x/'], site);
    expect(code).toBe(2);
    expect(out.error).toBe('usage');
    expect(site.magnets).not.toHaveBeenCalled();
  });

  it('magnets answers each page with its info hash and trackers', async () => {
    const site = fakeSite();
    const { code, out } = await run(['1337x', 'magnets', '--origin', ORIGIN, SINTEL.page_url], site);
    expect(code).toBe(0);
    expect(out.magnets).toEqual([{ page_url: SINTEL.page_url, info_hash: HASH, trackers: ['udp://tracker.example:1337'], magnet: expect.stringContaining(HASH), error: null }]);
    expect(site.magnets).toHaveBeenCalledWith(ORIGIN, ['/torrent/1/sintel-720p/'], { deadline: expect.any(Number) });
  });

  it('a bot check is the answer bot_check, and nothing more is asked', async () => {
    const site = fakeSite({ search: vi.fn(async () => { throw new BotCheckError('the page stayed on "Just a moment..."'); }) });
    const { code, out } = await run(['1337x', 'search', '--title', 'Sintel'], site);
    expect(code).toBe(1);
    expect(out).toMatchObject({ ok: false, error: 'bot_check' });
    expect(site.magnets).not.toHaveBeenCalled();
  });

  it('a machine without the Windows Chrome answers no_chrome', async () => {
    const site = fakeSite({ search: vi.fn(async () => { throw new ChromeError('no_chrome', 'chrome.exe was not found'); }) });
    const { out } = await run(['1337x', 'search', '--title', 'Sintel'], site);
    expect(out).toMatchObject({ ok: false, error: 'no_chrome' });
  });

  it('by hand it searches, then reads the magnets of the matching releases', async () => {
    const site = fakeSite();
    const { code, out } = await run(['1337x', 'sintel', '2010', '--origin', ORIGIN], site);
    expect(code).toBe(0);
    expect(out.query).toEqual({ title: 'sintel', year: 2010, season: null, episode: null, imdb: null });
    expect(out.releases).toEqual([{ ...SINTEL, info_hash: HASH, trackers: ['udp://tracker.example:1337'], magnet: expect.any(String), error: null }]);
    expect(site.magnets).toHaveBeenCalledWith(ORIGIN, ['/torrent/1/sintel-720p/'], { deadline: expect.any(Number) });
  });

  it('gate foregrounds the site and reports it cleared once the challenge is gone', async () => {
    const site = fakeSite();
    const gate = vi.fn(async () => ({ cleared: true, title: 'ext.to' }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await main(['1337x', 'gate', '--origin', ORIGIN, '--deadline-s', '30'], { sites: { '1337x': site }, gate });
      const out = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
      expect(code).toBe(0);
      expect(out).toMatchObject({ ok: true, site: '1337x', origin: ORIGIN, cleared: true, title: 'ext.to' });
      expect(gate).toHaveBeenCalledWith(site, ORIGIN, expect.any(Number));
      // The site's own search/magnets are not touched: the gate only clears the challenge.
      expect(site.search).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('clearGate foregrounds the tab, waits out the challenge, and reports whether it cleared', async () => {
    const foreground = vi.fn(async () => ({ created: false, activated: true }));
    const answers = [
      { bot_check: true, title: 'Just a moment...' },
      { bot_check: true, title: 'Just a moment...' },
      { bot_check: false, title: 'ext.to - search' },
    ];
    let i = 0;
    const ask = vi.fn(async () => answers[Math.min(i++, answers.length - 1)]);
    const sleep = vi.fn(async () => {});
    const cleared = await clearGate(fakeSite(), ORIGIN, Date.now() + 60_000, { foreground, ask, sleep });
    expect(cleared).toEqual({ cleared: true, title: 'ext.to - search' });
    expect(foreground).toHaveBeenCalledOnce();
    expect(ask).toHaveBeenCalledTimes(3);

    // A challenge that holds the only tab answers no_tab (a BotCheckError): clearGate waits, it is not fatal.
    let n = 0;
    const askBot = vi.fn(async () => {
      if (n++ === 0) throw new BotCheckError('no page got past its check');
      return { bot_check: false, title: 'through' };
    });
    expect(await clearGate(fakeSite(), ORIGIN, Date.now() + 60_000, { foreground, ask: askBot, sleep })).toEqual({ cleared: true, title: 'through' });

    // Still a challenge at the deadline: not cleared, and the last title is reported.
    const stuck = await clearGate(fakeSite(), ORIGIN, Date.now() + 10, { foreground, ask: vi.fn(async () => ({ bot_check: true, title: 'Just a moment...' })), sleep });
    expect(stuck).toEqual({ cleared: false, title: 'Just a moment...' });
  });

  it('--sites lists the real modules', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await main(['--sites'])).toBe(0);
      expect(JSON.parse(String(log.mock.calls[0]?.[0])).map((s: { name: string }) => s.name)).toEqual(['1337x', 'ext', 'rutracker']);
    } finally {
      log.mockRestore();
    }
  });

  it('reads flags and names what is wrong with them', () => {
    expect(readOptions(['--season', '2']).bad).toBe('--season and --episode go together');
    expect(readOptions(['--imdb', '1727587']).bad).toMatch(/IMDb id/);
    expect(readOptions(['--origin', 'https://1337x.la/x/y']).origin).toBe('https://1337x.la');
    expect(readOptions(['--bogus']).bad).toBe('unknown flag --bogus');
  });
});

describe('RuTracker', () => {
  const R = 'https://rutracker.net';

  it('reads a topic title as a release name: the Latin title, the season and episodes, the year, the marks, the audio', () => {
    expect(releaseName("Рассказ служанки / The Handmaid's Tale / Сезон: 1 / Серии: 1-10 из 10 (Рид Морано, Майк Баркер) [2017, США, фантастика, HDR10, WEB-DL 2160p, 4k] MVO (SDI Media) + Original (Eng)+ Sub (Rus, Eng)")).toBe(
      "The Handmaid's Tale S01E01-E10 2017 HDR10 WEB-DL 2160p 4k MVO (SDI Media) + Original (Eng)+ Sub (Rus, Eng)",
    );
    expect(releaseName('Бойцовский клуб / Fight Club (Дэвид Финчер / David Fincher) [1999, США, триллер, драма, BDRip 1080p] Dub + Original (Eng)')).toBe('Fight Club 1999 BDRip 1080p Dub + Original (Eng)');
    expect(releaseName('Медведь / The Bear / Сезон: 2 / Серии: 1-5 из 10 (Кристофер Сторер) [2023, США, WEB-DLRip] Dub (Невафильм)')).toBe('The Bear S02E01-E05 2023 WEB-DLRip Dub (Невафильм)');
    expect(releaseName('Игра престолов / Game of Thrones / Сезоны: 1-8 (Дэвид Бениофф) [2011-2019, США, BDRip 720p] Original')).toBe('Game of Thrones S01-S08 2011 BDRip 720p Original');
    // The rewritten name is what the finder's title rule and episode reader are given.
    expect(sameTitle(releaseName("Рассказ служанки / The Handmaid's Tale / Сезон: 1 / Серии: 1-10 из 10 [2017, США, WEB-DL 2160p] Original (Eng)"), { title: "The Handmaid's Tale", year: 2017, episode: 1 })).toBe(true);
    expect(sameTitle(releaseName('Бойцовский клуб / Fight Club (Дэвид Финчер) [1999, США, BDRip 1080p] Original'), { title: 'Fight Club', year: 1999, episode: null })).toBe(true);
  });

  it('searches by the words, most seeders first, and knows a topic page by its number', () => {
    expect(rutrackerPath({ title: "The Handmaid's Tale", year: 2017, season: 1, episode: 1 })).toBe('/forum/tracker.php?nm=Handmaid%27s+Tale&o=10&s=2');
    expect(rutrackerPath({ title: 'Fight Club', year: 1999, season: null, episode: null })).toBe('/forum/tracker.php?nm=Fight+Club+1999&o=10&s=2');
    expect(rutracker.releasePath(`${R}/forum/viewtopic.php?t=5404029`, R)).toBe('/forum/viewtopic.php?t=5404029');
    expect(rutracker.releasePath(`${R}/forum/viewtopic.php?p=1`, R)).toBeNull();
    expect(rutracker.releasePath(`${R}/forum/tracker.php?nm=x`, R)).toBeNull();
  });

  it('reads the rows of a search page, the magnet of a topic page, and whether the page is a member\'s', () => {
    const rows = readRutrackerRows(page('rutracker-search-handmaid.html'));
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ href: 'viewtopic.php?t=5402396', seeds: '46', leeches: '5', size: '6849814528 B' });
    expect(rows[0].name).toMatch(/^Рассказ служанки \/ The Handmaid's Tale \/ Сезон: 1/);
    expect(toRow({ ...rows[0], href: `/forum/${rows[0].href}`, name: releaseName(rows[0].name) }, R)).toMatchObject({ name: "The Handmaid's Tale S01E01-E10 2017 WEBRip MVO (LostFilm) + Original", page_url: `${R}/forum/viewtopic.php?t=5402396`, seeds: 46, leeches: 5, size_bytes: 6849814528 });
    expect(parseMagnet(readRutrackerMagnet(page('rutracker-topic.html')))).toMatchObject({ info_hash: '0bbf38e70fe5e022de46a882b872f85225697c08', trackers: ['http://bt4.t-ru.org/ann?magnet'] });
    expect(isLoggedIn(page('rutracker-search-handmaid.html'))).toBe(true);
    expect(isLoggedIn(page('rutracker-login.html'))).toBe(false);
  });

  it('its expressions are whole programs', () => {
    parses(rutrackerSearch('/forum/tracker.php?nm=x'));
    parses(rutrackerMagnets(['/forum/viewtopic.php?t=1']));
    parses(rutrackerGate());
  });

  it('the gate stays shut until the owner is logged in, and says what it waits for', async () => {
    const foreground = vi.fn(async () => ({ created: false, activated: true }));
    const sleep = vi.fn(async () => {});
    const answers = [{ bot_check: true, login: false, title: 'Just a moment...' }, { bot_check: false, login: true, title: 'Вход' }, { bot_check: false, login: false, title: 'RuTracker.org' }];
    const ask = vi.fn(async (_origin: string, expression: string) => {
      expect(expression).toBe(rutrackerGate());
      return answers.shift();
    });
    expect(await clearGate(rutracker, R, Date.now() + 60_000, { foreground, ask, sleep })).toEqual({ cleared: true, title: 'RuTracker.org' });
    expect(ask).toHaveBeenCalledTimes(3);
    const waiting = await clearGate(rutracker, R, Date.now() + 10, { foreground, ask: vi.fn(async () => ({ bot_check: false, login: true, title: 'Вход' })), sleep });
    expect(waiting).toEqual({ cleared: false, title: 'Вход', waiting_for: 'login' });
  });
});
