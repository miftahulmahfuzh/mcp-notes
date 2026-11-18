import { open, stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import type { CacheSubtitleView } from '../../cachePlay.js';
import { readBody } from '../../cache/upstream.js';
import type { FetchLike } from '../../passThrough.js';
import type { StreamRef } from '../../types.js';
import type { SubtitleContext, SubtitleTier } from './chain.js';
import { vttFromBytes, type SubtitleShelf } from './disk.js';
import { subtitleLanguage, type TorrentFilePaths } from './files.js';
import { withoutSecrets, wyzieSubtitle } from './wyzie.js';

/**
 * Stremio's OpenSubtitles add-on (NOTESD_TORRENT_SUBTITLE_URL, default
 * https://opensubtitles-v3.strem.io; no key) as the third tier (TORRENT_STREAM_SOURCE phase 6,
 * R3.3). `GET /subtitles/movie/tt<id>.json` and `/subtitles/series/tt<id>:<s>:<e>.json` answer
 * `{subtitles: [{id, url, lang, subtitleFileName?, movieReleaseName?, m?}]}` with direct .srt
 * addresses; `/subtitles/<type>/<id>/videoHash=<hash>&videoSize=<bytes>.json` adds the entries
 * matched to the file's OpenSubtitles hash (`m: "h"`). Every request is a plain one that says it is
 * notesd. With WYZIE_API_KEY set, Wyzie Subs (wyzie.ts) is asked before it.
 */

export const SUBTITLE_SERVICE_USER_AGENT = 'notesd-direct-stream (plain request; torrent subtitles)';
const LIST_TIMEOUT_MS = 15_000;
const FILE_TIMEOUT_MS = 20_000;
const LIST_MAX_BYTES = 4 * 1024 * 1024;
const FILE_MAX_BYTES = 5 * 1024 * 1024;
/** At most this many of the chosen entries are downloaded before the tier gives up. */
const FILE_TRIES = 3;
/** OpenSubtitles hashes the first and the last 64 KiB. */
export const HASH_CHUNK_BYTES = 64 * 1024;
/** Reading those two pieces of a downloading file may take this long; then the service is asked by id alone. */
export const HASH_TIMEOUT_MS = 10_000;
const IMDB_ID = /^tt\d{5,10}$/;

/** One English entry of the service's answer. */
export interface ServiceSubtitle {
  id: string;
  url: string;
  fileName: string | null;
  releaseName: string | null;
  /** The service matched it to the file's hash (`m: "h"`). */
  hashMatched: boolean;
}

export interface VideoHash {
  hash: string;
  size: number;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The service's answer, read once where it enters: English entries with an http(s) address and a plain id; anything else is dropped. */
export function parseServiceAnswer(body: unknown): ServiceSubtitle[] {
  if (typeof body !== 'object' || body === null) return [];
  const list = (body as { subtitles?: unknown }).subtitles;
  if (!Array.isArray(list)) return [];
  const out: ServiceSubtitle[] = [];
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue;
    const e = raw as Record<string, unknown>;
    const lang = typeof e.lang === 'string' ? e.lang.trim().toLowerCase() : '';
    if (lang !== 'eng' && lang !== 'en' && !lang.startsWith('en-')) continue;
    const url = typeof e.url === 'string' ? e.url.trim() : '';
    if (!/^https?:\/\/\S+$/i.test(url)) continue;
    const id = typeof e.id === 'string' || typeof e.id === 'number' ? String(e.id) : '';
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) continue;
    out.push({ id, url, fileName: str(e.subtitleFileName), releaseName: str(e.movieReleaseName), hashMatched: e.m === 'h' });
  }
  return out;
}

/** The service's list address for a film or an episode, by hash and size when given. */
export function serviceListUrl(base: string, ref: StreamRef, imdbId: string, hash: VideoHash | null): string {
  const type = ref.kind === 'movie' ? 'movie' : 'series';
  const id = ref.kind === 'movie' ? imdbId : `${imdbId}:${ref.season}:${ref.episode}`;
  const extra = hash === null ? '' : `/videoHash=${hash.hash}&videoSize=${hash.size}`;
  return `${base}/subtitles/${type}/${id}${extra}.json`;
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
}

/**
 * The English entries in the order they are tried: those matched to the file's hash first; then
 * any whose file name does not name another language; then those whose file or release name
 * shares the most words with the torrent's release name; then the service's own order.
 */
export function chooseServiceSubtitles(list: readonly ServiceSubtitle[], release: string): ServiceSubtitle[] {
  const wanted = new Set(words(release));
  return list
    .map((s, order) => ({
      s,
      order,
      shared: new Set(words(`${s.fileName ?? ''} ${s.releaseName ?? ''}`).filter((w) => wanted.has(w))).size,
      otherLanguage: s.fileName !== null && subtitleLanguage(s.fileName, release) === 'other',
    }))
    .sort((a, b) => Number(b.s.hashMatched) - Number(a.s.hashMatched) || Number(a.otherLanguage) - Number(b.otherLanguage) || b.shared - a.shared || a.order - b.order)
    .map((x) => x.s);
}

/**
 * The OpenSubtitles hash: the file size plus every 64-bit little-endian word of its first and
 * last 64 KiB, modulo 2^64, as 16 hex digits. Null for a file shorter than 64 KiB or a short read.
 * `readRange` takes an inclusive byte span.
 */
export async function openSubtitlesHash(size: number, readRange: (start: number, end: number) => Promise<Buffer>): Promise<string | null> {
  if (!Number.isSafeInteger(size) || size < HASH_CHUNK_BYTES) return null;
  const head = await readRange(0, HASH_CHUNK_BYTES - 1);
  const tail = await readRange(size - HASH_CHUNK_BYTES, size - 1);
  if (head.length < HASH_CHUNK_BYTES || tail.length < HASH_CHUNK_BYTES) return null;
  const mask = (1n << 64n) - 1n;
  let sum = BigInt(size);
  for (const chunk of [head, tail]) {
    for (let i = 0; i < HASH_CHUNK_BYTES; i += 8) sum = (sum + chunk.readBigUInt64LE(i)) & mask;
  }
  return sum.toString(16).padStart(16, '0');
}

async function collect(stream: Readable, signal: AbortSignal): Promise<Buffer> {
  const stop = (): void => {
    stream.destroy(new Error('the hash read timed out'));
  };
  if (signal.aborted) stop();
  else signal.addEventListener('abort', stop, { once: true });
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

async function readFileRange(file: string, start: number, end: number): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const buf = Buffer.alloc(end - start + 1);
    const { bytesRead } = await handle.read(buf, 0, buf.length, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * The chosen video's hash: from disk when the file is complete, else through the open torrent
 * (which fetches those pieces first). Null when neither can be read within `timeoutMs`.
 */
async function videoHash(ctx: SubtitleContext, torrents: TorrentFilePaths, timeoutMs: number): Promise<VideoHash | null> {
  const signal = AbortSignal.timeout(timeoutMs);
  const onDisk = await torrents.filePath(ctx.infoHash, ctx.fileIndex);
  let size = ctx.files.find((f) => f.index === ctx.fileIndex)?.length ?? null;
  let read: ((start: number, end: number) => Promise<Buffer>) | null = null;
  if (onDisk !== null) {
    size = (await stat(onDisk)).size;
    read = (start, end) => readFileRange(onDisk, start, end);
  } else if (ctx.handle !== null) {
    const handle = ctx.handle;
    read = (start, end) => collect(handle.read(ctx.fileIndex, { start, end }), signal);
  }
  if (size === null || read === null) return null;
  try {
    const hash = await openSubtitlesHash(size, read);
    return hash === null ? null : { hash, size };
  } catch {
    return null;
  }
}

const HEADERS = { accept: 'application/json', 'user-agent': SUBTITLE_SERVICE_USER_AGENT } as const;

/** The add-on's English entries at one list address (serviceListUrl). Throws when it does not answer. */
export async function getList(fetchImpl: FetchLike, url: string): Promise<ServiceSubtitle[]> {
  const res = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`HTTP ${res.status}`);
  }
  const body = await readBody(res, LIST_MAX_BYTES, false);
  if (body === null) throw new Error(`the answer is larger than ${LIST_MAX_BYTES} bytes`);
  return parseServiceAnswer(JSON.parse(body.toString('utf8')));
}

/** One of the add-on's files as WebVTT, or null when it cannot be read or holds no cue. */
export async function getFile(fetchImpl: FetchLike, url: string): Promise<string | null> {
  const res = await fetchImpl(url, { headers: { ...HEADERS, accept: '*/*' }, signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  const body = await readBody(res, FILE_MAX_BYTES, false);
  return body === null ? null : vttFromBytes(body);
}

/** The subtitle services as a caller names them: the torrent `service` tier, and a cloud session's outside subtitle (titleSubtitles.ts). */
export interface OutsideServices {
  /** The OpenSubtitles add-on's address; null: only Wyzie is asked. */
  baseUrl: string | null;
  /** Wyzie Subs, asked first (phase 6 addendum); null without WYZIE_API_KEY. */
  wyzie?: { baseUrl: string; key: string; timeoutMs?: number } | null;
  fetch: FetchLike;
  log?: (line: string) => void;
}

export interface OutsideQuery {
  ref: StreamRef;
  /** `tt…`, or null: the add-on is then not asked, and Wyzie is asked by the TMDB id. */
  imdbId: string | null;
  /** The release the entries are ranked against; '' ranks a plain file before a hearing-impaired one, then by downloads. */
  release: string;
  /** The video file's OpenSubtitles hash, read when the add-on is asked; unset or null: by IMDb id alone. */
  hash?: () => Promise<VideoHash | null>;
  /** Names the play in the log (an info hash, a title). */
  tag: string;
}

export interface OutsideSubtitle {
  from: 'wyzie' | 'opensubtitles';
  /** The service's id of the entry. */
  id: string;
  vtt: string;
  /** The add-on matched it to the file's hash. */
  hashMatched: boolean;
}

/**
 * An English subtitle from outside the stream. With a Wyzie key, Wyzie Subs is asked first (at most 12 s); when it
 * lists nothing usable, fails or times out, the add-on (`opensubtitles`) is asked by the file's hash, then by the
 * IMDb id alone (when the hash request failed or listed no English subtitle), and the best of its English entries
 * (up to three tries) is read. Null when no service lists anything English or no file could be read; throws when no
 * service answered at all. Without an IMDb id the add-on is not asked.
 */
export async function findOutsideSubtitle(deps: OutsideServices, query: OutsideQuery): Promise<OutsideSubtitle | null> {
  const wyzie = deps.wyzie ?? null;
  const imdbId = query.imdbId !== null && IMDB_ID.test(query.imdbId) ? query.imdbId : null;
  const failures: string[] = [];
  let answered = false;
  if (wyzie !== null) {
    try {
      const got = await wyzieSubtitle(
        { baseUrl: wyzie.baseUrl, key: wyzie.key, fetch: deps.fetch, userAgent: SUBTITLE_SERVICE_USER_AGENT, ...(wyzie.timeoutMs === undefined ? {} : { timeoutMs: wyzie.timeoutMs }) },
        { ref: query.ref, imdbId, release: query.release },
      );
      answered = true;
      if (got !== null) return { from: 'wyzie', id: got.id, vtt: got.vtt, hashMatched: false };
    } catch (err) {
      // Only the step and the status: Wyzie's addresses carry the key and a token.
      failures.push(`wyzie: ${withoutSecrets(messageOf(err))}`);
      deps.log?.(`[notesd] torrent: wyzie gave no subtitle for ${query.tag}: ${withoutSecrets(messageOf(err))}`);
    }
  }
  if (deps.baseUrl === null || imdbId === null) {
    if (!answered && failures.length > 0) throw new Error(`the subtitle service did not answer (${failures.join('; ')})`);
    return null;
  }
  const baseUrl = deps.baseUrl;
  const hash = query.hash === undefined ? null : await query.hash().catch(() => null);
  let list: ServiceSubtitle[] = [];
  for (const by of hash === null ? [null] : [hash, null]) {
    try {
      list = await getList(deps.fetch, serviceListUrl(baseUrl, query.ref, imdbId, by));
      answered = true;
      if (list.length > 0) break;
    } catch (err) {
      failures.push(`opensubtitles ${by === null ? 'by IMDb id' : 'by hash'}: ${messageOf(err)}`);
    }
  }
  if (!answered) throw new Error(`the subtitle service did not answer (${failures.join('; ')})`);
  for (const entry of chooseServiceSubtitles(list, query.release).slice(0, FILE_TRIES)) {
    const vtt = await getFile(deps.fetch, entry.url).catch(() => null);
    if (vtt !== null) return { from: 'opensubtitles', id: entry.id, vtt, hashMatched: entry.hashMatched };
  }
  return null;
}

export interface ServiceTierDeps extends OutsideServices {
  torrents: TorrentFilePaths;
  shelf: SubtitleShelf;
  hashTimeoutMs?: number;
}

/**
 * The third tier (R3.3): findOutsideSubtitle for the torrent's chosen file. Wyzie's file is kept as
 * `service-wyzie-<id>.vtt`, labelled `English (Wyzie)`; the add-on's as `service-<id>.vtt`, labelled `English`
 * when it matched the file's hash, else `English (matched by title)`.
 */
export function serviceTier(deps: ServiceTierDeps): SubtitleTier {
  return {
    name: 'service',
    blocks: true,
    async find(ctx): Promise<CacheSubtitleView[]> {
      const got = await findOutsideSubtitle(deps, {
        ref: ctx.ref,
        imdbId: ctx.imdbId,
        release: ctx.release,
        hash: () => videoHash(ctx, deps.torrents, deps.hashTimeoutMs ?? HASH_TIMEOUT_MS),
        tag: ctx.infoHash,
      });
      if (got === null) return [];
      const id = got.id.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      if (got.from === 'wyzie') return [await deps.shelf.save(ctx.infoHash, `service-wyzie-${id}.vtt`, got.vtt, { lang: 'en', label: 'English (Wyzie)' })];
      return [await deps.shelf.save(ctx.infoHash, `service-${id}.vtt`, got.vtt, { lang: 'en', label: got.hashMatched ? 'English' : 'English (matched by title)' })];
    },
  };
}
