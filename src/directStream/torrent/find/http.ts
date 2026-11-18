import type { IndexAnswer, IndexContext, IndexOutcome } from './types.js';

export type JsonAnswer = { ok: true; json: unknown } | { ok: false; outcome: Extract<IndexOutcome, 'error' | 'bot_check'>; detail: string };

/** Marks of a Cloudflare or DDoS-Guard challenge page. */
const CHALLENGE = /cf-chl|cf_chl|challenge-platform|just a moment\.\.\.|attention required|checking your browser|ddos-guard/i;

export function isBotCheck(status: number, headers: Headers, body: string): boolean {
  if ((headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') return true;
  const page = status === 403 || status === 429 || status === 503 || (status >= 200 && status < 300 && body.trimStart().startsWith('<'));
  return page && CHALLENGE.test(body);
}

/** An index's answer as JSON, or why not: a bot check page is `bot_check` (never worked around), any other failure `error`. */
async function readIndexJson(res: Response): Promise<JsonAnswer> {
  const body = await res.text();
  if (isBotCheck(res.status, res.headers, body)) return { ok: false, outcome: 'bot_check', detail: `HTTP ${res.status}: a bot check page` };
  if (!res.ok) return { ok: false, outcome: 'error', detail: `HTTP ${res.status}` };
  try {
    return { ok: true, json: JSON.parse(body) as unknown };
  } catch {
    return { ok: false, outcome: 'error', detail: 'the answer is not JSON' };
  }
}

/** One GET. A network failure or an abort throws; findCandidates records it as the index's `error`. */
export async function getIndexJson(ctx: IndexContext, url: string): Promise<JsonAnswer> {
  return readIndexJson(await ctx.fetch(url));
}

/** One POST of a JSON body (Knaben). Read like getIndexJson; the User-Agent is still notesd's (findCandidates sets it). */
export async function postIndexJson(ctx: IndexContext, url: string, payload: unknown): Promise<JsonAnswer> {
  return readIndexJson(await ctx.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }));
}

export function failedAnswer(answer: { outcome: Extract<IndexOutcome, 'error' | 'bot_check'>; detail: string }): IndexAnswer {
  return { outcome: answer.outcome, detail: answer.detail, candidates: [] };
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function asList(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/** A non-empty trimmed string, else null. */
export function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** A number or a numeric string, zero or more; else null. */
export function asCount(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** "9.53 GB", "136.47 MB", "512 KiB" in bytes (powers of 1024); null when unreadable. */
export function parseSizeText(text: string): number | null {
  const m = /^([\d.,]+)\s*([KMGT]?)i?B$/i.exec(text.trim());
  if (m?.[1] === undefined) return null;
  const value = Number(m[1].replace(/,/g, ''));
  const power = ['', 'K', 'M', 'G', 'T'].indexOf((m[2] ?? '').toUpperCase());
  return Number.isFinite(value) && value > 0 && power >= 0 ? Math.round(value * 1024 ** power) : null;
}

/** The `tr=` trackers of a magnet link. */
export function trackersFromMagnet(magnet: string): string[] {
  const at = magnet.indexOf('?');
  if (at < 0) return [];
  return new URLSearchParams(magnet.slice(at + 1))
    .getAll('tr')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}
