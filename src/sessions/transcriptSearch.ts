import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';

export const TRANSCRIPT_DEFAULT_LIMIT = 20;
export const TRANSCRIPT_MAX_LIMIT = 100;
export const TRANSCRIPT_EXCERPT_CHARS = 600;
export const TRANSCRIPT_MAX_SCAN_BYTES = 256 * 1024 * 1024;
export const TRANSCRIPT_MAX_QUERY_TERMS = 8;

export type TranscriptRole = 'user' | 'assistant';

export interface TranscriptMessage {
  role: TranscriptRole;
  text: string;
  at: string | null;
}

export interface TranscriptMatch {
  /** 1-based JSONL line number. */
  line: number;
  at: string | null;
  role: TranscriptRole;
  excerpt: string;
}

export interface TranscriptSearchOptions {
  /** Null or blank: no filter, the last `limit` messages come back. */
  query: string | null;
  limit: number;
  /** Tests lower it. Default TRANSCRIPT_MAX_SCAN_BYTES. */
  maxScanBytes?: number;
}

export interface TranscriptSearchResult {
  matches: TranscriptMatch[];
  total_matches: number;
  truncated: boolean;
  scanned_bytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The human-readable text of one transcript record: user/assistant text blocks only; tool calls, tool results and isMeta records give null. */
export function messageText(record: unknown): TranscriptMessage | null {
  if (!isRecord(record)) return null;
  const type = record.type;
  if (type !== 'user' && type !== 'assistant') return null;
  if (record.isMeta === true) return null;
  const message = record.message;
  if (!isRecord(message)) return null;
  const content = message.content;
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
    text = parts.join('\n');
  }
  text = text.trim();
  if (text === '') return null;
  const ts = record.timestamp;
  const at = typeof ts === 'string' && !Number.isNaN(Date.parse(ts)) ? new Date(ts).toISOString() : null;
  return { role: type, text, at };
}

/** Lower-cased terms: "quoted phrases" stay whole, other words split on whitespace; unique, at most TRANSCRIPT_MAX_QUERY_TERMS. */
export function queryTerms(query: string | null): string[] {
  if (query === null) return [];
  const terms: string[] = [];
  for (const m of query.toLowerCase().matchAll(/"([^"]+)"|(\S+)/g)) {
    const t = (m[1] ?? m[2] ?? '').trim();
    if (t !== '' && !terms.includes(t)) terms.push(t);
  }
  return terms.slice(0, TRANSCRIPT_MAX_QUERY_TERMS);
}

function sliceSafe(text: string, start: number, end: number): string {
  let a = start;
  let b = end;
  const first = text.charCodeAt(a);
  if (a > 0 && first >= 0xdc00 && first <= 0xdfff) a += 1;
  const last = text.charCodeAt(b - 1);
  if (b < text.length && last >= 0xd800 && last <= 0xdbff) b -= 1;
  return text.slice(a, b);
}

/** About `max` chars of `text` (whitespace collapsed) around the earliest term hit, ellipses where cut. */
export function excerptAround(text: string, terms: readonly string[], max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const lower = flat.toLowerCase();
  let hit = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (hit < 0 || i < hit)) hit = i;
  }
  if (hit < 0) return `${sliceSafe(flat, 0, max - 1)}…`;
  const start = Math.max(0, Math.min(hit - Math.floor(max / 3), flat.length - max));
  const end = Math.min(flat.length, start + max);
  return `${start > 0 ? '…' : ''}${sliceSafe(flat, start, end)}${end < flat.length ? '…' : ''}`;
}

/**
 * Scans `file` once. A message matches when it contains every query term (case-insensitive).
 * Keeps the LAST `limit` matches in file order. Throws ENOENT when the file is gone (the caller
 * maps it to transcript_missing).
 */
export async function searchTranscript(file: string, options: TranscriptSearchOptions): Promise<TranscriptSearchResult> {
  await stat(file);
  const terms = queryTerms(options.query === null || options.query.trim() === '' ? null : options.query);
  const limit = Math.min(Math.max(Math.trunc(options.limit), 1), TRANSCRIPT_MAX_LIMIT);
  const maxScan = options.maxScanBytes ?? TRANSCRIPT_MAX_SCAN_BYTES;
  const kept: TranscriptMatch[] = [];
  let total = 0;
  let scanned = 0;
  let line = 0;
  let capped = false;
  const stream = createReadStream(file, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const raw of rl) {
      line += 1;
      const size = Buffer.byteLength(raw, 'utf8') + 1;
      if (scanned + size > maxScan) {
        capped = true;
        break;
      }
      scanned += size;
      if (raw.trim() === '') continue;
      let record: unknown;
      try {
        record = JSON.parse(raw);
      } catch {
        continue;
      }
      const msg = messageText(record);
      if (msg === null) continue;
      if (terms.length > 0) {
        const lower = msg.text.toLowerCase();
        if (!terms.every((t) => lower.includes(t))) continue;
      }
      total += 1;
      kept.push({ line, at: msg.at, role: msg.role, excerpt: excerptAround(msg.text, terms, TRANSCRIPT_EXCERPT_CHARS) });
      if (kept.length > limit) kept.shift();
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { matches: kept, total_matches: total, truncated: capped || total > kept.length, scanned_bytes: scanned };
}
