import { readBody } from '../../cache/upstream.js';
import type { FetchLike } from '../../passThrough.js';
import type { StreamRef } from '../../types.js';
import { vttFromBytes } from './disk.js';

/**
 * Wyzie Subs (WYZIE_API_KEY, NOTESD_TORRENT_WYZIE_URL, default https://sub.wyzie.io) as the first
 * step of the `service` tier (TORRENT_STREAM_SOURCE phase 6 addendum, R3.3): asked before the
 * keyless OpenSubtitles add-on when a key is set. `GET /search?id=<tt id or TMDB id>&language=en
 * &format=srt&key=<key>` (an episode adds `&season=&episode=`) answers a JSON array of
 * `{id, url, format, language, isHearingImpaired, release, releases, fileName, origin,
 * downloadCount, ai}` with direct SubRip addresses. The first request asks Wyzie's default source;
 * only when that lists no English SubRip file, a second asks `source=all`. The `release=` filter is
 * slow and loose, so the list is ranked here.
 *
 * The key travels in the search address and a `tok` in every download address: neither address is
 * ever logged, thrown or kept. Failures name the step and the status only.
 */

/** The whole Wyzie step (both searches and the download) fits in this, inside the chain's 40 s budget. */
export const WYZIE_TIMEOUT_MS = 12_000;
const LIST_MAX_BYTES = 4 * 1024 * 1024;
const FILE_MAX_BYTES = 5 * 1024 * 1024;
/** At most this many of the ranked entries are downloaded. */
const FILE_TRIES = 2;

/**
 * Wyzie's answers for a title it does not know: 400 `Invalid id` for a TMDB id it cannot map (a film TMDB lists
 * without an IMDb id: Chasing the Moon, 2026-11-20) and 404 for a title with no subtitle. Both are an answer, "none",
 * not a service that failed: the title is then left alone for hours, not asked about again every five minutes, and
 * the second search (`source=all`), which answers the same, is not made.
 */
const UNKNOWN_TITLE: ReadonlySet<number> = new Set([400, 404]);

/** One English SubRip entry of Wyzie's answer. */
export interface WyzieSubtitle {
  id: string;
  /** The download address. It carries a `tok`: never logged or kept. */
  url: string;
  /** The release and file names the entry gives, for ranking against the torrent's release. */
  names: string[];
  origin: string | null;
  hearingImpaired: boolean;
  downloadCount: number;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** A message with anything key-like taken out (an error that quotes an address). */
export function withoutSecrets(text: string): string {
  return text.replace(/([?&](?:key|tok|tk)=)[^&\s"']*/gi, '$1…');
}
const messageOf = (err: unknown): string => withoutSecrets(err instanceof Error ? err.message : String(err));

/** Wyzie's answer, read once where it enters: English SubRip entries a person wrote, with an http(s) address and a plain id. */
export function parseWyzieAnswer(body: unknown): WyzieSubtitle[] {
  if (!Array.isArray(body)) throw new Error('the answer is not a list');
  const out: WyzieSubtitle[] = [];
  for (const raw of body) {
    if (typeof raw !== 'object' || raw === null) continue;
    const e = raw as Record<string, unknown>;
    // A machine translation (`ai`) is never taken, and `format=srt` is asked for and still checked.
    if (e.ai === true || e.language !== 'en' || e.format !== 'srt') continue;
    const url = typeof e.url === 'string' ? e.url.trim() : '';
    if (!/^https?:\/\/\S+$/i.test(url)) continue;
    const id = typeof e.id === 'string' || typeof e.id === 'number' ? String(e.id) : '';
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) continue;
    const releases = Array.isArray(e.releases) ? e.releases.map(str).filter((n): n is string => n !== null) : [];
    const names = [...new Set([str(e.release), ...releases, str(e.fileName)].filter((n): n is string => n !== null))];
    out.push({
      id,
      url,
      names,
      origin: str(e.origin),
      hearingImpaired: e.isHearingImpaired === true,
      downloadCount: typeof e.downloadCount === 'number' && Number.isFinite(e.downloadCount) ? e.downloadCount : 0,
    });
  }
  return out;
}

/** The search address: by the IMDb id when it is known, else by the TMDB id. `all` asks every source the key may use. */
export function wyzieSearchUrl(base: string, ref: StreamRef, imdbId: string | null, key: string, source: 'default' | 'all'): string {
  const q = new URLSearchParams({ id: imdbId ?? String(ref.tmdbId), language: 'en', format: 'srt' });
  if (ref.kind === 'tv') {
    q.set('season', String(ref.season));
    q.set('episode', String(ref.episode));
  }
  if (source === 'all') q.set('source', 'all');
  q.set('key', key);
  return `${base}/search?${q.toString()}`;
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
}

type Origin = 'bluray' | 'web' | 'dvd' | 'tv';

/** Where a release was taken from, read from its name or from Wyzie's `origin`. */
function originOf(text: string | null): Origin | null {
  if (text === null) return null;
  if (/blu-?ray|b[dr]-?rip|bdremux|\bremux\b/i.test(text)) return 'bluray';
  if (/web-?dl|web-?rip|\bweb\b/i.test(text)) return 'web';
  if (/dvd/i.test(text)) return 'dvd';
  if (/hdtv|pdtv/i.test(text)) return 'tv';
  return null;
}

/**
 * True when an entry's names say it is another episode's file: they name an episode (`S01E01`, `1x01`) and none of
 * them names the one asked for. Wyzie's list for an episode sometimes holds a file of its neighbour (on 2026-11-18
 * the list for American Horror Story S01E02 held `...S01E01.720p.BluRay...`, the Pilot's lines). A name with no
 * episode in it, and a season pack's `S01EAll`, say nothing.
 */
export function namesOtherEpisode(names: readonly string[], ref: StreamRef): boolean {
  if (ref.kind !== 'tv') return false;
  let named = false;
  for (const name of names) {
    for (const m of name.matchAll(/(?:^|[^a-z0-9])(?:s(\d{1,2})[ ._-]?e(\d{1,4})|(\d{1,2})x(\d{2,4}))(?![0-9])/gi)) {
      named = true;
      if (Number(m[1] ?? m[3]) === ref.season && Number(m[2] ?? m[4]) === ref.episode) return false;
    }
  }
  return named;
}

/**
 * The entries in the order they are tried: a file that names another episode last of all (`ref`); then most words
 * shared between the torrent's release name and the entry's names; then the same origin (BluRay, WEB) as the
 * release; then a plain subtitle before a hearing-impaired one; then the more downloaded; then Wyzie's own order.
 */
export function chooseWyzieSubtitles(list: readonly WyzieSubtitle[], release: string, ref: StreamRef | null = null): WyzieSubtitle[] {
  const wanted = new Set(words(release));
  const origin = originOf(release);
  return list
    .map((s, order) => ({
      s,
      order,
      otherEpisode: ref !== null && namesOtherEpisode(s.names, ref),
      shared: new Set(words(s.names.join(' ')).filter((w) => wanted.has(w))).size,
      sameOrigin: origin !== null && (originOf(s.origin) ?? originOf(s.names.join(' '))) === origin,
    }))
    .sort(
      (a, b) =>
        Number(a.otherEpisode) - Number(b.otherEpisode) ||
        b.shared - a.shared ||
        Number(b.sameOrigin) - Number(a.sameOrigin) ||
        Number(a.s.hearingImpaired) - Number(b.s.hearingImpaired) ||
        b.s.downloadCount - a.s.downloadCount ||
        a.order - b.order,
    )
    .map((x) => x.s);
}

export interface WyzieDeps {
  baseUrl: string;
  key: string;
  fetch: FetchLike;
  userAgent: string;
  timeoutMs?: number;
  now?: () => number;
}

/** What the Wyzie step asks about. */
export interface WyzieQuery {
  ref: StreamRef;
  imdbId: string | null;
  release: string;
}

/**
 * Wyzie's English subtitles for the title, in the order they are tried (chooseWyzieSubtitles). Throws when Wyzie
 * did not answer (a status other than 200, 400 and 404, a body that is no list, the time limit). For /sync-subtitle,
 * which tries several.
 */
export async function wyzieEntries(deps: WyzieDeps, query: WyzieQuery): Promise<WyzieSubtitle[]> {
  const now = deps.now ?? (() => Date.now());
  const deadline = now() + (deps.timeoutMs ?? WYZIE_TIMEOUT_MS);
  const list = async (source: 'default' | 'all'): Promise<WyzieSubtitle[] | null> => {
    let res: Response;
    try {
      res = await deps.fetch(wyzieSearchUrl(deps.baseUrl, query.ref, query.imdbId, deps.key, source), {
        headers: { 'user-agent': deps.userAgent, accept: 'application/json' },
        signal: AbortSignal.timeout(Math.max(1, deadline - now())),
      });
    } catch (err) {
      throw new Error(`the search did not answer (${messageOf(err)})`);
    }
    if (UNKNOWN_TITLE.has(res.status)) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`the search answered HTTP ${res.status}`);
    }
    const body = await readBody(res, LIST_MAX_BYTES, false);
    if (body === null) throw new Error(`the search answer is larger than ${LIST_MAX_BYTES} bytes`);
    try {
      return parseWyzieAnswer(JSON.parse(body.toString('utf8')));
    } catch {
      throw new Error('the search answer is not a JSON list');
    }
  };
  let found = await list('default');
  if (found !== null && found.length === 0) found = await list('all');
  return chooseWyzieSubtitles(found ?? [], query.release, query.ref);
}

/** One entry's file as WebVTT, or null when it cannot be read. Never throws; its address is never logged or kept. */
export async function wyzieFile(deps: Pick<WyzieDeps, 'fetch' | 'userAgent'>, entry: WyzieSubtitle, timeoutMs: number): Promise<string | null> {
  try {
    const res = await deps.fetch(entry.url, { headers: { 'user-agent': deps.userAgent, accept: '*/*' }, signal: AbortSignal.timeout(Math.max(1, timeoutMs)) });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const body = await readBody(res, FILE_MAX_BYTES, false);
    return body === null ? null : vttFromBytes(body);
  } catch {
    return null;
  }
}

/**
 * Wyzie's best English subtitle for the title as WebVTT, or null when it lists none that can be
 * read (also when it does not know the title: 400, 404). Throws when Wyzie did not answer (any other status but
 * 200, a body that is no list, the time limit).
 */
export async function wyzieSubtitle(deps: WyzieDeps, query: WyzieQuery): Promise<{ id: string; vtt: string } | null> {
  const now = deps.now ?? (() => Date.now());
  const deadline = now() + (deps.timeoutMs ?? WYZIE_TIMEOUT_MS);
  const signal = (): AbortSignal => AbortSignal.timeout(Math.max(1, deadline - now()));
  const headers = { 'user-agent': deps.userAgent };

  const search = async (source: 'default' | 'all'): Promise<WyzieSubtitle[] | null> => {
    let res: Response;
    try {
      res = await deps.fetch(wyzieSearchUrl(deps.baseUrl, query.ref, query.imdbId, deps.key, source), { headers: { ...headers, accept: 'application/json' }, signal: signal() });
    } catch (err) {
      throw new Error(`the search did not answer (${messageOf(err)})`);
    }
    if (UNKNOWN_TITLE.has(res.status)) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`the search answered HTTP ${res.status}`);
    }
    const body = await readBody(res, LIST_MAX_BYTES, false);
    if (body === null) throw new Error(`the search answer is larger than ${LIST_MAX_BYTES} bytes`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      throw new Error('the search answer is not JSON');
    }
    return parseWyzieAnswer(parsed);
  };

  let list = await search('default');
  if (list !== null && list.length === 0) list = await search('all');
  for (const entry of chooseWyzieSubtitles(list ?? [], query.release, query.ref).slice(0, FILE_TRIES)) {
    if (now() >= deadline) break;
    try {
      const res = await deps.fetch(entry.url, { headers: { ...headers, accept: '*/*' }, signal: signal() });
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined);
        continue;
      }
      const body = await readBody(res, FILE_MAX_BYTES, false);
      const vtt = body === null ? null : vttFromBytes(body);
      if (vtt !== null) return { id: entry.id, vtt };
    } catch {
      // A file that cannot be read: the next entry, then the add-on.
    }
  }
  return null;
}
