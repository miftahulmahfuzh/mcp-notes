import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { parse as parseDotenv } from 'dotenv';
import { z } from 'zod';
import { reasonOf, scrub } from '../connectors/errors.js';
import { addDays, utcDate } from './sessions.js';
import type { Bar, Source } from './types.js';

export const ADVERSARY_MCP_SERVER = 'adversary';

const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const MASSIVE_BASE = 'https://api.massive.com';
const SEC_SUBMISSIONS = 'https://data.sec.gov/submissions';
const USER_AGENT = 'mcp-notes-adversary/0.1';
const HTTP_TIMEOUT_MS = 15_000;
const MAX_PAGE_BYTES = 2_000_000;
const MAX_PAGE_TEXT = 12_000;
const MAX_ITEMS = 20;
const PRICE_BARS = 260;
export const FINNHUB_MIN_INTERVAL_MS = 1_000;
export const MASSIVE_MIN_INTERVAL_MS = 12_500;
export const SEC_MIN_INTERVAL_MS = 110;

/** Forms that can break a pick's story: results, events, insider trades, takeovers, delistings. */
const SEC_FORMS = new Set([
  '8-K', '8-K/A', '10-Q', '10-K', '4', 'SC 13D', 'SC 13D/A', 'SC TO-T', 'SC 14D9',
  'DEFM14A', 'PREM14A', 'S-4', '425', '25-NSE', '15-12B', '15-12G',
]);

const SYMBOL = z.string().regex(/^[A-Z0-9][A-Z0-9.-]{0,11}$/, 'a ticker such as AAPL or BRK.B');

export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

// ---------- rate limits ----------

export interface RateLimiter {
  /** Resolves when the next call may go out; calls are spaced at least the interval apart. */
  wait(): Promise<void>;
}

export function intervalLimiter(
  minIntervalMs: number,
  clock: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): RateLimiter {
  let last = Number.NEGATIVE_INFINITY;
  let chain: Promise<void> = Promise.resolve();
  return {
    wait(): Promise<void> {
      const turn = chain.then(async () => {
        const delay = last + minIntervalMs - clock();
        if (delay > 0) await sleep(delay);
        last = clock();
      });
      chain = turn.catch(() => {});
      return turn;
    },
  };
}

export interface Limiters {
  finnhub: RateLimiter;
  massive: RateLimiter;
  sec: RateLimiter;
}

/** One set per daemon: limits are per API key, shared by every review. */
export function defaultLimiters(): Limiters {
  return {
    finnhub: intervalLimiter(FINNHUB_MIN_INTERVAL_MS),
    massive: intervalLimiter(MASSIVE_MIN_INTERVAL_MS),
    sec: intervalLimiter(SEC_MIN_INTERVAL_MS),
  };
}

// ---------- keys ----------

export interface SeerKeys {
  finnhub: string | null;
  massive: string | null;
  /** A contact email SEC can reach; null when unset or not an address. */
  secContact: string | null;
}

/** FINNHUB_API_KEY, MASSIVE_API_KEY, SEC_CONTACT_EMAIL from <repoDir>/.env.local, read on every call. Never logged. */
export function loadSeerKeys(repoDir: string): SeerKeys {
  let vars: Record<string, string> = {};
  try {
    vars = parseDotenv(readFileSync(path.join(repoDir, '.env.local')));
  } catch {
    vars = {};
  }
  const pick = (key: string): string | null => {
    const value = vars[key]?.trim() ?? '';
    return value === '' ? null : value;
  };
  const contact = pick('SEC_CONTACT_EMAIL');
  return {
    finnhub: pick('FINNHUB_API_KEY'),
    massive: pick('MASSIVE_API_KEY'),
    secContact: contact !== null && /^[^@\s]+@[^@\s]+$/.test(contact) ? contact : null,
  };
}

// ---------- ticker -> CIK (Seer's vendored map) ----------

export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

/** symbol -> 10-digit CIK for rows still current (end_date empty) with a real filer. Missing file: empty map. */
export async function loadTickerCik(file: string): Promise<Map<string, string>> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw err;
  }
  const map = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  const header = parseCsvLine(lines[0] ?? '');
  const iSymbol = header.indexOf('symbol');
  const iCik = header.indexOf('cik');
  const iEnd = header.indexOf('end_date');
  if (iSymbol < 0 || iCik < 0 || iEnd < 0) return map;
  for (const line of lines.slice(1)) {
    if (line.trim() === '') continue;
    const cells = parseCsvLine(line);
    const symbol = cells[iSymbol]?.trim().toUpperCase() ?? '';
    const cik = cells[iCik]?.trim() ?? '';
    const end = cells[iEnd]?.trim() ?? '';
    if (symbol === '' || end !== '' || !/^\d{10}$/.test(cik)) continue;
    map.set(symbol, cik);
  }
  return map;
}

/** Reads <seer>/engine/data/ticker_cik.csv once per path. */
export function createTickerCikLookup(repoDir: () => string): (symbol: string) => Promise<string | null> {
  let cache: { file: string; map: Promise<Map<string, string>> } | null = null;
  return async (symbol) => {
    const file = path.join(repoDir(), 'engine', 'data', 'ticker_cik.csv');
    if (cache === null || cache.file !== file) cache = { file, map: loadTickerCik(file) };
    return (await cache.map).get(symbol.toUpperCase()) ?? null;
  };
}

// ---------- the ledger of pages actually fetched ----------

/** URL without fragment and without a trailing slash on a non-root path; null when not a URL. */
export function normalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    url.hash = '';
    const text = url.toString();
    return text.endsWith('/') && url.pathname !== '/' ? text.slice(0, -1) : text;
  } catch {
    return null;
  }
}

/** The pages one review opened with fetch_url. Only these can be cited (brief §4.2). */
export class SourceLedger {
  private readonly byUrl = new Map<string, Source>();

  /** Records a fetched page under its requested URL and, when different, the URL it redirected to. */
  record(source: Source, finalUrl?: string): void {
    for (const raw of [source.url, finalUrl]) {
      if (raw === undefined || raw === '') continue;
      const key = normalizeUrl(raw);
      if (key !== null) this.byUrl.set(key, source);
    }
  }

  get(url: string): Source | undefined {
    const key = normalizeUrl(url);
    return key === null ? undefined : this.byUrl.get(key);
  }

  list(): Source[] {
    return [...new Set(this.byUrl.values())];
  }
}

// ---------- pages ----------

/** A public http(s) URL, or null for anything that points at this machine or a private network. */
export function publicHttpUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a = -1, b = -1] = host.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) {
      return null;
    }
  }
  if (host.includes(':') && (host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80'))) return null;
  return url;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith('#') && name !== '#39') return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<(script|style|noscript|svg|head|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(stripped)
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function metaContent(html: string, key: string): string | null {
  const tag = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${escapeRe(key)}["'][^>]*>`, 'i').exec(html)?.[0];
  if (tag === undefined) return null;
  const content = /content=["']([^"']*)["']/i.exec(tag)?.[1];
  const value = content === undefined ? '' : decodeEntities(content).trim();
  return value === '' ? null : value;
}

function titleTag(html: string): string | null {
  const raw = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const value = raw === undefined ? '' : decodeEntities(raw).replace(/\s+/g, ' ').trim();
  return value === '' ? null : value;
}

function isoOrNull(value: string | null): string | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)} [cut]`;
}

export interface ReadPage {
  title: string | null;
  publisher: string | null;
  publishedAt: string | null;
  text: string;
}

export function readPage(raw: string, contentType: string, url: string): ReadPage {
  const host = hostOf(url);
  if (!/html|xml/i.test(contentType)) {
    return { title: null, publisher: host, publishedAt: null, text: clip(raw.replace(/\s+/g, ' ').trim(), MAX_PAGE_TEXT) };
  }
  return {
    title: metaContent(raw, 'og:title') ?? titleTag(raw),
    publisher: metaContent(raw, 'og:site_name') ?? host,
    publishedAt: isoOrNull(
      metaContent(raw, 'article:published_time') ?? metaContent(raw, 'og:published_time') ?? metaContent(raw, 'datePublished') ?? metaContent(raw, 'date'),
    ),
    text: clip(htmlToText(raw), MAX_PAGE_TEXT),
  };
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).subarray(0, max).toString('utf8');
}

// ---------- prices ----------

function round(x: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

function changeOver(bars: readonly Bar[], sessions: number): number | null {
  const latest = bars[0];
  const then = bars[sessions];
  return latest !== undefined && then !== undefined && then.close > 0 ? round(latest.close / then.close - 1) : null;
}

function mean(xs: readonly number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Plain numbers from Seer's bars (newest first), nothing after `through`. */
export function priceContext(symbol: string, through: string, bars: readonly Bar[], spy: readonly Bar[]): Record<string, unknown> {
  const last = bars[0];
  const avg200 = bars.length >= 200 ? mean(bars.slice(0, 200).map((b) => b.close)) : null;
  const value20 = mean(bars.slice(0, 20).map((b) => b.close * b.volume));
  return {
    symbol,
    through,
    last_date: last?.date ?? null,
    last_close: last?.close ?? null,
    sessions_available: bars.length,
    change_5_sessions: changeOver(bars, 5),
    change_20_sessions: changeOver(bars, 20),
    change_60_sessions: changeOver(bars, 60),
    change_250_sessions: changeOver(bars, 250),
    vs_200_session_average: last !== undefined && avg200 !== null && avg200 > 0 ? round(last.close / avg200 - 1) : null,
    average_daily_value_20_sessions_usd: value20 === null ? null : Math.round(value20),
    spy: {
      change_5_sessions: changeOver(spy, 5),
      change_20_sessions: changeOver(spy, 20),
      change_60_sessions: changeOver(spy, 60),
    },
    last_10_closes: bars.slice(0, 10).map((b) => ({ date: b.date, close: b.close })),
    note: "Raw daily closes from Seer's own price table, nothing after the night the method decided. Changes are fractions (0.05 = up 5%). A stock split inside the window shows as a jump.",
  };
}

// ---------- the tools ----------

export interface ToolDeps {
  fetch: FetchFn;
  keys: SeerKeys;
  limiters: Limiters;
  seer: { priceBars(symbol: string, throughDate: string, limit: number): Promise<Bar[]> };
  tickerCik: (symbol: string) => Promise<string | null>;
  now: () => Date;
}

export interface ToolScope {
  /** The stock under review (the default symbol of every tool). */
  symbol: string;
  /** The decision night: seer_price_context never reads a later bar. */
  dataDate: string;
  ledger: SourceLedger;
}

export interface ReviewTools {
  server: McpSdkServerConfigWithInstance;
  /** WebSearch plus `mcp__adversary__<tool>` for every tool offered. */
  allowedTools: string[];
}

function textResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] };
}

function unavailable(message: string): CallToolResult {
  return textResult(`unavailable: ${message}`);
}

type JsonAnswer = { ok: true; data: unknown } | { ok: false; message: string };

async function getJson(deps: ToolDeps, url: URL, headers: Record<string, string>, label: string, secrets: string[]): Promise<JsonAnswer> {
  let res: Response;
  try {
    res = await deps.fetch(url, { headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (err) {
    return { ok: false, message: scrub(`${label} did not answer: ${reasonOf(err)}`, secrets) };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, message: `${label} refused this request (HTTP ${res.status}); it may not be in the free plan` };
  }
  if (res.status === 429) return { ok: false, message: `${label} rate limit reached; use another source` };
  if (!res.ok) return { ok: false, message: `${label} answered HTTP ${res.status}` };
  try {
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, message: `${label} sent something that is not JSON` };
  }
}

function finnhub(deps: ToolDeps, key: string, pathname: string, params: Record<string, string>): Promise<JsonAnswer> {
  const url = new URL(`${FINNHUB_BASE}${pathname}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return deps.limiters.finnhub.wait().then(() =>
    getJson(deps, url, { 'X-Finnhub-Token': key, Accept: 'application/json', 'User-Agent': USER_AGENT }, 'Finnhub', [key]),
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function guarded(handler: () => Promise<CallToolResult>): Promise<CallToolResult> {
  return handler().catch((err: unknown) => unavailable(reasonOf(err)));
}

function finnhubTools(deps: ToolDeps, scope: ToolScope, key: string): Array<SdkMcpToolDefinition<any>> {
  const today = (): string => utcDate(deps.now());
  return [
    tool(
      'finnhub_company_news',
      'Company news headlines from Finnhub for a stock (default: the stock under review), newest first, at most 20, with links to open with fetch_url.',
      { symbol: SYMBOL.optional(), days: z.number().int().min(1).max(30).optional().describe('How many days back. Default 7.') },
      async ({ symbol, days }) =>
        guarded(async () => {
          const sym = symbol ?? scope.symbol;
          const answer = await finnhub(deps, key, '/company-news', { symbol: sym, from: addDays(today(), -(days ?? 7)), to: today() });
          if (!answer.ok) return unavailable(answer.message);
          const items = asArray(answer.data)
            .map(asRecord)
            .filter((r) => typeof r.headline === 'string' && r.headline !== '')
            .slice(0, MAX_ITEMS)
            .map((r) => ({
              published: typeof r.datetime === 'number' ? new Date(r.datetime * 1000).toISOString() : null,
              source: r.source ?? null,
              headline: r.headline,
              summary: typeof r.summary === 'string' ? clip(r.summary, 300) : null,
              url: r.url ?? null,
            }));
          return textResult({ symbol: sym, items });
        }),
    ),
    tool(
      'finnhub_earnings_calendar',
      'Scheduled results dates from Finnhub for a stock over the next 60 days.',
      { symbol: SYMBOL.optional() },
      async ({ symbol }) =>
        guarded(async () => {
          const sym = symbol ?? scope.symbol;
          const answer = await finnhub(deps, key, '/calendar/earnings', { symbol: sym, from: today(), to: addDays(today(), 60) });
          if (!answer.ok) return unavailable(answer.message);
          const rows = asArray(asRecord(answer.data).earningsCalendar)
            .map(asRecord)
            .map((r) => ({ date: r.date ?? null, hour: r.hour ?? null, eps_estimate: r.epsEstimate ?? null, revenue_estimate: r.revenueEstimate ?? null }));
          return textResult({ symbol: sym, scheduled: rows });
        }),
    ),
    tool(
      'finnhub_recommendation_trends',
      "Analysts' buy/hold/sell counts for a stock from Finnhub, the last four months.",
      { symbol: SYMBOL.optional() },
      async ({ symbol }) =>
        guarded(async () => {
          const sym = symbol ?? scope.symbol;
          const answer = await finnhub(deps, key, '/stock/recommendation', { symbol: sym });
          if (!answer.ok) return unavailable(answer.message);
          const rows = asArray(answer.data)
            .map(asRecord)
            .slice(0, 4)
            .map((r) => ({ period: r.period ?? null, strong_buy: r.strongBuy ?? null, buy: r.buy ?? null, hold: r.hold ?? null, sell: r.sell ?? null, strong_sell: r.strongSell ?? null }));
          return textResult({ symbol: sym, months: rows });
        }),
    ),
    tool(
      'finnhub_basic_financials',
      'A few headline numbers for a company from Finnhub: size, valuation, growth, debt, 52-week range.',
      { symbol: SYMBOL.optional() },
      async ({ symbol }) =>
        guarded(async () => {
          const sym = symbol ?? scope.symbol;
          const answer = await finnhub(deps, key, '/stock/metric', { symbol: sym, metric: 'all' });
          if (!answer.ok) return unavailable(answer.message);
          const metric = asRecord(asRecord(answer.data).metric);
          const keys = [
            'marketCapitalization', '52WeekHigh', '52WeekLow', '52WeekPriceReturnDaily', 'peTTM',
            'epsGrowthTTMYoy', 'revenueGrowthTTMYoy', 'netProfitMarginTTM', 'totalDebt/totalEquityQuarterly',
            'dividendYieldIndicatedAnnual', 'beta',
          ];
          const picked: Record<string, unknown> = {};
          for (const k of keys) if (metric[k] !== undefined && metric[k] !== null) picked[k] = metric[k];
          return textResult({ symbol: sym, metrics: picked, note: 'marketCapitalization is in millions of US dollars.' });
        }),
    ),
    tool(
      'finnhub_insider_transactions',
      'Buying and selling by company insiders over the last 90 days, from Finnhub, at most 20 rows.',
      { symbol: SYMBOL.optional() },
      async ({ symbol }) =>
        guarded(async () => {
          const sym = symbol ?? scope.symbol;
          const answer = await finnhub(deps, key, '/stock/insider-transactions', { symbol: sym, from: addDays(today(), -90), to: today() });
          if (!answer.ok) return unavailable(answer.message);
          const rows = asArray(asRecord(answer.data).data)
            .map(asRecord)
            .slice(0, MAX_ITEMS)
            .map((r) => ({ name: r.name ?? null, change: r.change ?? null, shares_after: r.share ?? null, date: r.transactionDate ?? null, code: r.transactionCode ?? null, price: r.transactionPrice ?? null }));
          return textResult({ symbol: sym, transactions: rows });
        }),
    ),
  ];
}

function massiveNewsTool(deps: ToolDeps, scope: ToolScope, key: string): SdkMcpToolDefinition<any> {
  return tool(
    'massive_news',
    'News articles about a stock from Massive (Polygon), newest first, with links to open with fetch_url.',
    { symbol: SYMBOL.optional(), limit: z.number().int().min(1).max(MAX_ITEMS).optional() },
    async ({ symbol, limit }) =>
      guarded(async () => {
        const sym = symbol ?? scope.symbol;
        const url = new URL(`${MASSIVE_BASE}/v2/reference/news`);
        url.searchParams.set('ticker', sym);
        url.searchParams.set('order', 'desc');
        url.searchParams.set('sort', 'published_utc');
        url.searchParams.set('limit', String(limit ?? 10));
        url.searchParams.set('apiKey', key);
        await deps.limiters.massive.wait();
        const answer = await getJson(deps, url, { Accept: 'application/json', 'User-Agent': USER_AGENT }, 'Massive', [key]);
        if (!answer.ok) return unavailable(answer.message);
        const items = asArray(asRecord(answer.data).results)
          .map(asRecord)
          .map((r) => ({
            published: r.published_utc ?? null,
            publisher: asRecord(r.publisher).name ?? null,
            title: r.title ?? null,
            description: typeof r.description === 'string' ? clip(r.description, 300) : null,
            url: r.article_url ?? null,
          }));
        return textResult({ symbol: sym, items });
      }),
  );
}

function secFilingsTool(deps: ToolDeps, scope: ToolScope, contact: string): SdkMcpToolDefinition<any> {
  return tool(
    'sec_filings',
    "A company's recent SEC filings (8-K events, 10-Q/10-K results, Form 4 insider trades, takeover and delisting forms), last 120 days, with links to open with fetch_url.",
    { symbol: SYMBOL.optional() },
    async ({ symbol }) =>
      guarded(async () => {
        const sym = symbol ?? scope.symbol;
        const cik = await deps.tickerCik(sym);
        if (cik === null) return unavailable(`no SEC filer is known for ${sym}`);
        await deps.limiters.sec.wait();
        const url = new URL(`${SEC_SUBMISSIONS}/CIK${cik}.json`);
        const answer = await getJson(deps, url, { 'User-Agent': `${USER_AGENT} (${contact})`, Accept: 'application/json' }, 'SEC EDGAR', [contact]);
        if (!answer.ok) return unavailable(answer.message);
        const recent = asRecord(asRecord(asRecord(answer.data).filings).recent);
        const forms = asArray(recent.form);
        const filed = asArray(recent.filingDate);
        const accession = asArray(recent.accessionNumber);
        const documents = asArray(recent.primaryDocument);
        const descriptions = asArray(recent.primaryDocDescription);
        const items = asArray(recent.items);
        const since = addDays(utcDate(deps.now()), -120);
        const cikNumber = String(Number(cik));
        const out: Record<string, unknown>[] = [];
        for (let i = 0; i < forms.length && out.length < 25; i += 1) {
          const form = String(forms[i] ?? '');
          const date = String(filed[i] ?? '');
          if (!SEC_FORMS.has(form) || date < since) continue;
          const acc = String(accession[i] ?? '');
          const doc = String(documents[i] ?? '');
          out.push({
            form,
            filed: date,
            description: descriptions[i] ?? null,
            items: items[i] ?? null,
            url: acc !== '' && doc !== '' ? `https://www.sec.gov/Archives/edgar/data/${cikNumber}/${acc.replace(/-/g, '')}/${doc}` : null,
          });
        }
        return textResult({ symbol: sym, cik, filings: out });
      }),
  );
}

function priceTool(deps: ToolDeps, scope: ToolScope): SdkMcpToolDefinition<any> {
  return tool(
    'seer_price_context',
    "Seer's own daily prices for a stock up to the night the method decided (no network): recent changes, distance from its 200-session average, daily trading value, and the same changes for SPY.",
    { symbol: SYMBOL.optional() },
    async ({ symbol }) =>
      guarded(async () => {
        const sym = symbol ?? scope.symbol;
        const [bars, spy] = await Promise.all([
          deps.seer.priceBars(sym, scope.dataDate, PRICE_BARS),
          deps.seer.priceBars('SPY', scope.dataDate, PRICE_BARS),
        ]);
        if (bars.length === 0) return unavailable(`Seer has no prices for ${sym} up to ${scope.dataDate}`);
        return textResult(priceContext(sym, scope.dataDate, bars, spy));
      }),
  );
}

function fetchUrlTool(deps: ToolDeps, scope: ToolScope): SdkMcpToolDefinition<any> {
  return tool(
    'fetch_url',
    'Open a web page and read its text. Only pages opened with this tool can be cited in the verdict, so open every page you rely on.',
    { url: z.string().min(8).max(2_000) },
    async ({ url }) =>
      guarded(async () => {
        const target = publicHttpUrl(url);
        if (target === null) return unavailable('only public http(s) pages can be opened');
        const isSec = /(^|\.)sec\.gov$/i.test(target.hostname);
        if (isSec) await deps.limiters.sec.wait();
        const agent = isSec && deps.keys.secContact !== null ? `${USER_AGENT} (${deps.keys.secContact})` : `${USER_AGENT} (personal research reader)`;
        let res: Response;
        try {
          res = await deps.fetch(target, {
            headers: { 'User-Agent': agent, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
            redirect: 'follow',
            signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
          });
        } catch (err) {
          return unavailable(`could not open ${target.hostname}: ${reasonOf(err)}`);
        }
        if (!res.ok) return unavailable(`${target.hostname} answered HTTP ${res.status}`);
        const type = res.headers.get('content-type') ?? '';
        if (!/^text\/|application\/(xhtml\+xml|json|xml)/i.test(type)) {
          return unavailable(`${target.hostname} sent ${type === '' ? 'an unknown type' : type}, which cannot be read as text`);
        }
        const raw = await readCapped(res, MAX_PAGE_BYTES);
        const finalUrl = res.url !== '' ? res.url : target.toString();
        const page = readPage(raw, type, finalUrl);
        const source: Source = {
          url: target.toString(),
          title: page.title,
          publisher: page.publisher,
          published_at: page.publishedAt,
          fetched_at: deps.now().toISOString(),
        };
        scope.ledger.record(source, finalUrl);
        return textResult({ url: source.url, title: source.title, publisher: source.publisher, published_at: source.published_at, text: page.text });
      }),
  );
}

/** The tools one review gets. A source whose key is missing from Seer's .env.local is left out. */
export function adversaryTools(deps: ToolDeps, scope: ToolScope): Array<SdkMcpToolDefinition<any>> {
  const tools: Array<SdkMcpToolDefinition<any>> = [priceTool(deps, scope), fetchUrlTool(deps, scope)];
  if (deps.keys.finnhub !== null) tools.push(...finnhubTools(deps, scope, deps.keys.finnhub));
  if (deps.keys.massive !== null) tools.push(massiveNewsTool(deps, scope, deps.keys.massive));
  if (deps.keys.secContact !== null) tools.push(secFilingsTool(deps, scope, deps.keys.secContact));
  return tools;
}

/** A fresh in-process MCP server per review (its ledger is per review). */
export function adversaryServer(deps: ToolDeps, scope: ToolScope): ReviewTools {
  const tools = adversaryTools(deps, scope);
  return {
    server: createSdkMcpServer({ name: ADVERSARY_MCP_SERVER, version: '0.1.0', tools, alwaysLoad: true }),
    allowedTools: ['WebSearch', ...tools.map((t) => `mcp__${ADVERSARY_MCP_SERVER}__${t.name}`)],
  };
}
