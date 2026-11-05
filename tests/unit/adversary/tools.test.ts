import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  SourceLedger,
  adversaryTools,
  htmlToText,
  intervalLimiter,
  loadTickerCik,
  normalizeUrl,
  publicHttpUrl,
  type RateLimiter,
  type ToolDeps,
} from '../../../src/adversary/tools.js';
import type { Bar } from '../../../src/adversary/types.js';

const noLimit: RateLimiter = { wait: async () => {} };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function harness(overrides: Partial<ToolDeps> = {}) {
  const calls: { url: string; headers: Headers }[] = [];
  let reply: (url: string) => Response = () => json({});
  const deps: ToolDeps = {
    fetch: async (input, init) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers) });
      return reply(url);
    },
    keys: { finnhub: 'fh-secret-key', massive: 'ms-secret-key', secContact: 'owner@example.com' },
    limiters: { finnhub: noLimit, massive: noLimit, sec: noLimit },
    seer: { priceBars: async () => [] },
    tickerCik: async (symbol) => (symbol === 'ACME' ? '0000012345' : null),
    now: () => new Date('2026-11-05T10:00:00Z'),
    ...overrides,
  };
  const ledger = new SourceLedger();
  const scope = { symbol: 'ACME', dataDate: '2026-11-04', ledger };
  const tools = adversaryTools(deps, scope);
  async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const t = tools.find((x) => x.name === name);
    if (t === undefined) throw new Error(`no tool ${name}`);
    const result = await t.handler(args, {});
    const first = result.content[0];
    return first !== undefined && first.type === 'text' ? first.text : '';
  }
  return {
    calls,
    ledger,
    tools,
    call,
    setReply(fn: (url: string) => Response) {
      reply = fn;
    },
  };
}

describe('which tools a review gets', () => {
  it('offers a source only when its key is in Seer’s .env.local', () => {
    const none = harness({ keys: { finnhub: null, massive: null, secContact: null } });
    expect(none.tools.map((t) => t.name)).toEqual(['seer_price_context', 'fetch_url']);
    const all = harness();
    expect(all.tools.map((t) => t.name)).toEqual([
      'seer_price_context',
      'fetch_url',
      'finnhub_company_news',
      'finnhub_earnings_calendar',
      'finnhub_recommendation_trends',
      'finnhub_basic_financials',
      'finnhub_insider_transactions',
      'massive_news',
      'sec_filings',
    ]);
  });
});

describe('Finnhub tools', () => {
  it('send the key only in X-Finnhub-Token, as Seer does', async () => {
    const h = harness();
    h.setReply(() => json([{ headline: 'Acme cuts outlook', datetime: 1_762_300_000, source: 'Wire', url: 'https://news.example.com/a', summary: 'x' }]));
    const text = await h.call('finnhub_company_news');
    const sent = h.calls[0];
    expect(sent?.url).toBe('https://finnhub.io/api/v1/company-news?symbol=ACME&from=2026-10-29&to=2026-11-05');
    expect(sent?.headers.get('X-Finnhub-Token')).toBe('fh-secret-key');
    expect(JSON.parse(text).items[0]).toMatchObject({ headline: 'Acme cuts outlook', url: 'https://news.example.com/a' });
  });

  it('degrade to a plain "unavailable" on 403 and 429, never echoing the key', async () => {
    const h = harness();
    h.setReply(() => new Response('premium only fh-secret-key', { status: 403 }));
    const refused = await h.call('finnhub_insider_transactions');
    expect(refused).toMatch(/^unavailable: Finnhub refused this request \(HTTP 403\)/);
    expect(refused).not.toContain('fh-secret-key');
    h.setReply(() => new Response('', { status: 429 }));
    expect(await h.call('finnhub_basic_financials')).toMatch(/rate limit/);
  });
});

describe('massive_news', () => {
  it('sends the key as the apiKey query parameter only, as Seer does', async () => {
    const h = harness();
    h.setReply(() => json({ results: [{ title: 'Acme news', publisher: { name: 'Wire' }, published_utc: '2026-11-04T10:00:00Z', article_url: 'https://wire.example.com/b' }] }));
    const text = await h.call('massive_news', { limit: 5 });
    const url = new URL(h.calls[0]?.url ?? '');
    expect(url.origin + url.pathname).toBe('https://api.massive.com/v2/reference/news');
    expect(url.searchParams.get('apiKey')).toBe('ms-secret-key');
    expect(url.searchParams.get('ticker')).toBe('ACME');
    expect(text).not.toContain('ms-secret-key');
    expect(JSON.parse(text).items[0]).toMatchObject({ publisher: 'Wire', url: 'https://wire.example.com/b' });
  });
});

describe('sec_filings', () => {
  it('declares the contact in the User-Agent and keeps only recent forms that matter', async () => {
    const h = harness();
    h.setReply(() =>
      json({
        filings: {
          recent: {
            form: ['8-K', 'S-8', '10-Q'],
            filingDate: ['2026-11-01', '2026-11-02', '2025-01-01'],
            accessionNumber: ['0000012345-26-000101', '0000012345-26-000102', '0000012345-25-000001'],
            primaryDocument: ['acme-8k.htm', 'acme-s8.htm', 'acme-10q.htm'],
            primaryDocDescription: ['8-K', 'S-8', '10-Q'],
            items: ['2.02', '', ''],
          },
        },
      }),
    );
    const out = JSON.parse(await h.call('sec_filings'));
    expect(h.calls[0]?.url).toBe('https://data.sec.gov/submissions/CIK0000012345.json');
    expect(h.calls[0]?.headers.get('User-Agent')).toContain('owner@example.com');
    expect(out.filings).toEqual([
      { form: '8-K', filed: '2026-11-01', description: '8-K', items: '2.02', url: 'https://www.sec.gov/Archives/edgar/data/12345/000001234526000101/acme-8k.htm' },
    ]);
    expect(await h.call('sec_filings', { symbol: 'NOPE' })).toMatch(/^unavailable: no SEC filer/);
  });
});

describe('fetch_url and the ledger', () => {
  it('records the page it opened with title, publisher and publication time', async () => {
    const h = harness();
    h.setReply(
      () =>
        new Response(
          '<html><head><title>T</title><meta property="og:title" content="Acme cuts its outlook"><meta property="og:site_name" content="Example News"><meta property="article:published_time" content="2026-11-04T12:00:00Z"></head><body><p>Acme &amp; co lowered guidance.</p><script>x()</script></body></html>',
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
        ),
    );
    const out = JSON.parse(await h.call('fetch_url', { url: 'https://news.example.com/acme#top' }));
    expect(out.text).toBe('Acme & co lowered guidance.');
    expect(h.ledger.get('https://news.example.com/acme')).toEqual({
      url: 'https://news.example.com/acme#top',
      title: 'Acme cuts its outlook',
      publisher: 'Example News',
      published_at: '2026-11-04T12:00:00.000Z',
      fetched_at: '2026-11-05T10:00:00.000Z',
    });
  });

  it('refuses private addresses without fetching, and does not record what it cannot read', async () => {
    const h = harness();
    expect(await h.call('fetch_url', { url: 'http://127.0.0.1:7317/api/notes' })).toMatch(/^unavailable: only public/);
    expect(h.calls).toHaveLength(0);
    h.setReply(() => new Response('%PDF', { status: 200, headers: { 'content-type': 'application/pdf' } }));
    expect(await h.call('fetch_url', { url: 'https://example.com/a.pdf' })).toMatch(/cannot be read as text/);
    expect(h.ledger.list()).toEqual([]);
  });
});

describe('seer_price_context', () => {
  it('reads bars only up to the decision night', async () => {
    const asked: string[] = [];
    const bars = (n: number, start: number): Bar[] => Array.from({ length: n }, (_, i) => ({ date: `d${i}`, close: start - i, volume: 1_000 }));
    const h = harness({
      seer: {
        priceBars: async (symbol, through, limit) => {
          asked.push(`${symbol}|${through}|${limit}`);
          return symbol === 'SPY' ? bars(30, 500) : bars(30, 100);
        },
      },
    });
    const out = JSON.parse(await h.call('seer_price_context'));
    expect(asked.sort()).toEqual(['ACME|2026-11-04|260', 'SPY|2026-11-04|260']);
    expect(out).toMatchObject({ symbol: 'ACME', through: '2026-11-04', last_close: 100, change_5_sessions: 0.0526, vs_200_session_average: null });
  });
});

describe('helpers', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcp-notes-cik-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('maps current tickers to CIKs from Seer’s vendored CSV', async () => {
    const file = path.join(dir, 'ticker_cik.csv');
    writeFileSync(
      file,
      'symbol,cik,start_date,end_date,company_name,source,note\nACME,0000012345,2009-01-01,,"ACME, INC.",current,\nOLD,0000099999,2009-01-01,2015-01-01,OLD CO,manual,\nNOF,NONE,2009-01-01,,FUND,manual,"no filer, ever"\n',
    );
    expect([...(await loadTickerCik(file))]).toEqual([['ACME', '0000012345']]);
    expect((await loadTickerCik(path.join(dir, 'missing.csv'))).size).toBe(0);
  });

  it('spaces calls by the interval', async () => {
    let t = 0;
    const slept: number[] = [];
    const limiter = intervalLimiter(1_000, () => t, async (ms) => {
      slept.push(ms);
      t += ms;
    });
    await Promise.all([limiter.wait(), limiter.wait(), limiter.wait()]);
    expect(slept).toEqual([1_000, 1_000]);
  });

  it('normalizes URLs and strips pages to text', () => {
    expect(normalizeUrl('https://a.example.com/x/#frag')).toBe('https://a.example.com/x');
    expect(normalizeUrl('not a url')).toBeNull();
    expect(publicHttpUrl('http://192.168.1.5/')).toBeNull();
    expect(publicHttpUrl('file:///etc/passwd')).toBeNull();
    expect(publicHttpUrl('https://www.sec.gov/x')?.hostname).toBe('www.sec.gov');
    expect(htmlToText('<style>a{}</style><p>One</p><p>Two&nbsp;&#8212; three</p>')).toBe('One\nTwo — three');
  });
});
