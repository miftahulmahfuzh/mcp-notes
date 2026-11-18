import { createHash } from 'node:crypto';
import type { FetchLike } from '../passThrough.js';
import type { StreamRef } from '../types.js';
import { chooseServiceSubtitles, getFile, getList, serviceListUrl, SUBTITLE_SERVICE_USER_AGENT } from '../torrent/subtitles/service.js';
import { withoutSecrets, wyzieEntries, wyzieFile } from '../torrent/subtitles/wyzie.js';

/**
 * The English subtitles /sync-subtitle may try for a title, one after the other (checker.ts): Wyzie Subs' list with
 * a key, then the OpenSubtitles add-on's by the IMDb id. The same services, requests and ranking as a play's
 * `service` tier (torrent/subtitles/service.ts), but every entry is offered, not only the first: the checker decides
 * by the film's audio, not by a file's name. A file is fetched only when the checker asks for the next one.
 *
 * Wyzie's addresses carry the key and a token: none is logged, thrown or kept.
 */

/** At most this many of Wyzie's entries, and of the add-on's, are offered. */
export const WYZIE_CANDIDATES = 8;
export const ADDON_CANDIDATES = 5;
const WYZIE_LIST_TIMEOUT_MS = 20_000;
const FILE_TIMEOUT_MS = 20_000;
const IMDB_ID = /^tt\d{5,10}$/;

export interface Candidate {
  from: 'wyzie' | 'opensubtitles';
  /** The release or file the service names it by; null when it names none. */
  name: string | null;
  vtt: string;
}

export interface CandidateServices {
  /** The OpenSubtitles add-on's address; null: not asked. */
  baseUrl: string | null;
  wyzie: { baseUrl: string; key: string } | null;
  fetch: FetchLike;
}

export interface CandidateQuery {
  ref: StreamRef;
  imdbId: string | null;
  /** The release that plays, to rank by; '' when there is none (a cloud stream). */
  release: string;
}

const messageOf = (err: unknown): string => withoutSecrets(err instanceof Error ? err.message : String(err));

/**
 * The candidates in the order they are tried. A file that could not be read, or the same text a second time, is
 * passed over; a service that did not answer adds one line to `notes` and the other is still asked. Never throws.
 */
export async function* outsideCandidates(services: CandidateServices, query: CandidateQuery, notes: string[]): AsyncGenerator<Candidate> {
  const seen = new Set<string>();
  const fresh = (vtt: string): boolean => {
    const sum = createHash('sha1').update(vtt.replace(/\s+/g, ' ')).digest('hex');
    if (seen.has(sum)) return false;
    seen.add(sum);
    return true;
  };
  const imdbId = query.imdbId !== null && IMDB_ID.test(query.imdbId) ? query.imdbId : null;
  if (services.wyzie !== null) {
    const deps = { ...services.wyzie, fetch: services.fetch, userAgent: SUBTITLE_SERVICE_USER_AGENT, timeoutMs: WYZIE_LIST_TIMEOUT_MS };
    let entries: Awaited<ReturnType<typeof wyzieEntries>> = [];
    try {
      entries = await wyzieEntries(deps, { ref: query.ref, imdbId, release: query.release });
    } catch (err) {
      notes.push('Wyzie did not answer: ' + messageOf(err));
    }
    for (const entry of entries.slice(0, WYZIE_CANDIDATES)) {
      const vtt = await wyzieFile(deps, entry, FILE_TIMEOUT_MS);
      if (vtt !== null && fresh(vtt)) yield { from: 'wyzie', name: entry.names[0] ?? null, vtt };
    }
  }
  if (services.baseUrl !== null && imdbId !== null) {
    let list: Awaited<ReturnType<typeof getList>> = [];
    try {
      list = await getList(services.fetch, serviceListUrl(services.baseUrl, query.ref, imdbId, null));
    } catch (err) {
      notes.push('The OpenSubtitles add-on did not answer: ' + messageOf(err));
    }
    for (const entry of chooseServiceSubtitles(list, query.release).slice(0, ADDON_CANDIDATES)) {
      const vtt = await getFile(services.fetch, entry.url).catch(() => null);
      if (vtt !== null && fresh(vtt)) yield { from: 'opensubtitles', name: entry.releaseName ?? entry.fileName, vtt };
    }
  }
}
