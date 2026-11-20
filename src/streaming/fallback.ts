import type { SiteFallback } from '../directStream/service.js';
import type { RememberedChannel, ResolveAttempt, ResolveOutcome, StreamRef } from '../directStream/types.js';
import type { MovieStreams } from '../movies/streams.js';
import type { StreamingRunner, StreamingSite } from './service.js';
import { isSite, playOnSite, type SiteSkip } from './sitePlays.js';

/**
 * The streaming sites are the worst case (the owner's decision of 2026-11-20): a play with no source named goes to
 * direct streaming first, every cloud provider and every torrent, and only when that found nothing to play is a site
 * asked. First the site the title was last played on, at its page there; then the others in this order, each through
 * the streaming command's own search, which plays only on exactly one match. The first site whose player starts ends it.
 *
 * A film: idlix (films and series, the site the owner streams from most), lk21 (a wide film catalogue), flicksy last
 * (the newest, a TMDB-fed catalogue). dramacool is not asked for a film: every title there is a page of episodes, so
 * its search never starts a film on its own (`series`).
 * An episode: idlix, then dramacool (Asian dramas, an episode at a time). lk21 and flicksy list a series as a link
 * only and start no episode, so they are not asked.
 */
export const FILM_SITE_ORDER: readonly StreamingSite[] = ['idlix', 'lk21', 'flicksy'];
export const EPISODE_SITE_ORDER: readonly StreamingSite[] = ['idlix', 'dramacool'];

/** One site to ask, and the title's page there from an earlier play (null: search it). */
export interface SiteToAsk {
  site: StreamingSite;
  known: string | null;
}

/** The attempt's name for a site in a play's attempts list. */
export const siteAttemptName = (site: string): string => `Site: ${site}`;

/**
 * The sites to ask for `ref`, in order: the site the title was last played on (the channel, else the site method
 * played most recently) first, with its page; then the order above, each with its own remembered page when there is one.
 */
export function sitesToAsk(ref: StreamRef, known: RememberedChannel | null): SiteToAsk[] {
  const order = ref.kind === 'movie' ? FILM_SITE_ORDER : EPISODE_SITE_ORDER;
  const pages = new Map<StreamingSite, string>();
  let last: { site: StreamingSite; at: number } | null = null;
  for (const [method, m] of Object.entries(known?.methods ?? {})) {
    if (!isSite(method) || m.siteUrl === null) continue;
    pages.set(method, m.siteUrl);
    if (last === null || m.playedAt.getTime() > last.at) last = { site: method, at: m.playedAt.getTime() };
  }
  let first: StreamingSite | null = last?.site ?? null;
  if (known !== null && known.channel === 'site' && known.provider !== null && isSite(known.provider)) {
    first = known.provider;
    if (known.siteUrl !== null) pages.set(known.provider, known.siteUrl);
  }
  const sites = first === null ? [...order] : [first, ...order.filter((s) => s !== first)];
  return sites.map((site) => ({ site, known: pages.get(site) ?? null }));
}

const OUTCOME: Record<SiteSkip, ResolveOutcome> = {
  no_match: 'no_stream',
  no_episode: 'no_stream',
  series: 'no_stream',
  // Several titles carry the name: none is guessed.
  several_matches: 'skipped',
  not_playing: 'error',
};

export interface SiteFallbackDeps {
  runner: StreamingRunner;
  /** How the title was last played on this machine (MovieStreams.channel): the site it was played on goes first. */
  remembered: (ref: StreamRef) => Promise<RememberedChannel | null>;
  /** The title's name and year, which a site's search is asked by (MovieStreams.titleNames). Null: only a remembered page can play. */
  title: (ref: StreamRef) => Promise<{ title: string; year: number | null } | null>;
  streams: Pick<MovieStreams, 'recordSitePlay'>;
  now?: () => number;
  log?: (line: string) => void;
}

/** The streaming sites as the direct-stream service's last resort (DirectStreamService `siteFallback`). */
export function siteFallback(deps: SiteFallbackDeps): SiteFallback {
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? (() => Date.now());
  return async (ref, progress) => {
    const [known, named] = await Promise.all([deps.remembered(ref).catch(() => null), deps.title(ref).catch(() => null)]);
    const label = named === null ? `${ref.kind}-${ref.tmdbId}` : `${named.title}${named.year === null ? '' : ` (${named.year})`}`;
    const what = `${label}${ref.kind === 'tv' ? ` S${ref.season}E${ref.episode}` : ''}`;
    for (const { site, known: page } of sitesToAsk(ref, known)) {
      progress.stage(page === null ? `asking ${site}: no cloud provider or torrent could stream it` : `asking ${site}, which played it last time: no cloud provider or torrent could stream it`);
      const started = now();
      const tried = await playOnSite({ site, ref, title: named?.title ?? null, year: named?.year ?? null, known: page }, { runner: deps.runner, streams: deps.streams, log });
      const tookS = Math.round((now() - started) / 100) / 10;
      const attempt: ResolveAttempt = tried.ok
        ? { provider: siteAttemptName(site), outcome: 'resolved', took_s: tookS, detail: `playing${tried.site_url === null ? '' : ` ${tried.site_url}`}` }
        : { provider: siteAttemptName(site), outcome: OUTCOME[tried.error], took_s: tookS, detail: `${tried.error}: ${tried.message}` };
      progress.attempt(attempt);
      log(`[notesd] streaming: asked ${site} for ${what}${page === null ? '' : ' at the page it played from last time'}: ${tried.ok ? 'playing' : tried.error} after ${tookS} s`);
      if (tried.ok) return { site, site_url: tried.site_url, site_play: tried.site_play };
    }
    return null;
  };
}
