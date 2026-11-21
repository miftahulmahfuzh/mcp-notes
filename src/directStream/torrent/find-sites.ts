import { z } from 'zod'
import type { TorrentSitesConfig } from '../../config.js'
import { runJsonScript } from '../../streaming/service.js'
import { candidateFrom, parseRelease, type IndexAnswer, type TorrentCandidate, type TorrentIndex } from './find/index.js'

/**
 * 1337x, ext.to and RuTracker: the torrent finder's fallback (torrent phase 9). They are asked through
 * claude/streaming/torrent/cli.mjs inside the streaming Chrome only when the JSON indexes give
 * nothing usable. claude/streaming/torrent/sites/index.mjs holds the same names; a test compares them.
 */
export const TORRENT_SITES = ['1337x', 'ext', 'rutracker'] as const satisfies ReadonlyArray<keyof TorrentSitesConfig['origins']>
export type TorrentSiteName = (typeof TORRENT_SITES)[number]

/** One site, both steps. The finder asks the sites side by side, so both together take about this long. */
export const TORRENT_SITES_DEADLINE_MS = 40_000
/** The search step's share at most, so the release pages keep the rest. */
export const TORRENT_SITES_SEARCH_MS = 25_000
/** Release pages read for magnet links: the best-seeded rows that survive the release-name filter. */
export const MAX_RELEASE_PAGES = 5
/** The script is told to answer this much before the daemon would stop it. */
const SCRIPT_MARGIN_S = 3

type FindQuery = Parameters<TorrentIndex['find']>[0]
type FindContext = Parameters<TorrentIndex['find']>[1]
type ReleaseInfo = ReturnType<typeof parseRelease>

/** Runs `node claude/streaming/torrent/cli.mjs <args...>` and returns the JSON it prints; tests inject a fake. */
export type TorrentSiteRunner = (args: string[], options: { timeoutMs: number }) => Promise<unknown>

export function torrentSitesScriptRunner(options: { cliPath: string; nodeBin?: string }): TorrentSiteRunner {
  const nodeBin = options.nodeBin ?? process.execPath
  return (args, { timeoutMs }) => runJsonScript({ label: 'torrent sites script', nodeBin, argv: [options.cliPath, ...args], timeoutMs })
}

const rowSchema = z.object({
  name: z.string().min(1),
  page_url: z.string().url(),
  seeds: z.number().int().nonnegative(),
  leeches: z.number().int().nonnegative().nullish(),
  size_bytes: z.number().int().nonnegative().nullish(),
})
type SiteRow = z.infer<typeof rowSchema>

const failedSchema = z.object({ ok: z.literal(false), error: z.string().min(1), detail: z.string().nullish() })
const searchSchema = z.object({ ok: z.literal(true), url: z.string(), rows: z.array(rowSchema), others: z.number().int().nonnegative().nullish() })
const magnetsSchema = z.object({
  ok: z.literal(true),
  magnets: z.array(
    z.object({
      page_url: z.string(),
      info_hash: z.string().regex(/^[0-9a-f]{40}$/).nullish(),
      trackers: z.array(z.string()).nullish(),
      error: z.string().nullish(),
    }),
  ),
})

const answer = (outcome: IndexAnswer['outcome'], detail: string, candidates: TorrentCandidate[] = []): IndexAnswer => ({ outcome, detail, candidates })

/**
 * A failure the script printed. A bot check is its own outcome, and so is a site that wants the owner logged in
 * (`login_required`): both are cleared by hand with the site's `gate` command and never counted against the index. Anything else (no_chrome too) is an error.
 */
function failed(value: unknown, step: string): IndexAnswer | null {
  const parsed = failedSchema.safeParse(value)
  if (!parsed.success) return null
  const detail = `${step}: ${parsed.data.error}${parsed.data.detail ? `: ${parsed.data.detail}` : ''}`
  return answer(parsed.data.error === 'bot_check' || parsed.data.error === 'login_required' ? 'bot_check' : 'error', detail)
}

/** The asked episode, or null for a film (phase 2's TorrentQuery is a union: only a `tv` query has one). */
const episodeOf = (query: FindQuery): { season: number; episode: number } | null => (query.kind === 'tv' ? { season: query.season, episode: query.episode } : null)

/**
 * The rows worth a release page: seeded, not a dub, a cinema copy or 3D, and not another episode
 * (by phase 2's reading of the release name), most seeds first, at most MAX_RELEASE_PAGES.
 * findCandidates applies the full filter and ranking afterwards; this only spends the page reads well.
 */
export function pickRows(rows: SiteRow[], query: FindQuery): Array<SiteRow & { release: ReleaseInfo }> {
  const episode = episodeOf(query)
  return rows
    .map((row) => ({ ...row, release: parseRelease(row.name) }))
    .filter(({ seeds, release }) => seeds > 0 && !release.dubbed && !release.cam && !release.threeD)
    .filter(({ release }) => episode === null || ((release.season == null || release.season === episode.season) && (release.episode == null || release.episode === episode.episode)))
    .sort((a, b) => b.seeds - a.seeds)
    .slice(0, MAX_RELEASE_PAGES)
}

function imdbArg(imdbId: string | null | undefined): string | null {
  if (!imdbId) return null
  return imdbId.startsWith('tt') ? imdbId : `tt${imdbId}`
}

function searchArgs(site: TorrentSiteName, origin: string, query: FindQuery, timeoutMs: number): string[] {
  const args = [site, 'search', '--origin', origin, '--deadline-s', String(Math.max(5, Math.floor(timeoutMs / 1000) - SCRIPT_MARGIN_S))]
  if (query.title) args.push('--title', query.title)
  if (query.year != null) args.push('--year', String(query.year))
  const episode = episodeOf(query)
  if (episode !== null) args.push('--season', String(episode.season), '--episode', String(episode.episode))
  const imdb = imdbArg(query.imdbId)
  if (imdb !== null) args.push('--imdb', imdb)
  return args
}

export interface TorrentSiteIndexOptions {
  /** The site's address, scheme and host (from TorrentSitesConfig.origins). */
  origin: string
  runner: TorrentSiteRunner
  /** Default TORRENT_SITES_DEADLINE_MS. */
  deadlineMs?: number
  /** Default Date.now; tests pin it. */
  now?: () => number
}

/** One torrent site as an index of the finder. Never throws: every failure is its answer's outcome. */
export function torrentSiteIndex(site: TorrentSiteName, options: TorrentSiteIndexOptions): TorrentIndex {
  const deadlineMs = options.deadlineMs ?? TORRENT_SITES_DEADLINE_MS
  const now = options.now ?? Date.now
  return {
    name: site,
    // A fallback index keeps its own limit (phase 2): the JSON indexes' 10 s would cut a browser-driven site short.
    timeoutMs: deadlineMs,
    async find(query: FindQuery, context: FindContext): Promise<IndexAnswer> {
      const signal = (context as { signal?: AbortSignal } | undefined)?.signal
      if (signal?.aborted) return answer('error', 'aborted before the search')
      const deadline = now() + deadlineMs
      const left = (): number => deadline - now()
      try {
        const searchMs = Math.min(TORRENT_SITES_SEARCH_MS, left())
        const searched = await options.runner(searchArgs(site, options.origin, query, searchMs), { timeoutMs: searchMs })
        const searchFailure = failed(searched, 'search')
        if (searchFailure !== null) return searchFailure
        const found = searchSchema.safeParse(searched)
        if (!found.success) return answer('error', `search: unreadable answer (${found.error.issues[0]?.message ?? 'no detail'})`)
        if (found.data.rows.length === 0) return answer('empty', `no release named as the title on ${found.data.url}`)
        const picked = pickRows(found.data.rows, query)
        if (picked.length === 0) {
          return answer('empty', `${found.data.rows.length} releases listed, none seeded and free of dubs, cinema copies, 3D and other episodes`)
        }
        if (signal?.aborted) return answer('error', 'aborted before the release pages')
        if (left() < 5_000) return answer('error', 'deadline: no time left for the release pages')
        const magnetMs = left()
        const read = await options.runner(
          [site, 'magnets', '--origin', options.origin, '--deadline-s', String(Math.max(5, Math.floor(magnetMs / 1000) - SCRIPT_MARGIN_S)), ...picked.map((row) => row.page_url)],
          { timeoutMs: magnetMs },
        )
        const magnetFailure = failed(read, 'magnets')
        if (magnetFailure !== null) return magnetFailure
        const magnets = magnetsSchema.safeParse(read)
        if (!magnets.success) return answer('error', `magnets: unreadable answer (${magnets.error.issues[0]?.message ?? 'no detail'})`)
        const byPage = new Map(magnets.data.magnets.map((entry) => [entry.page_url, entry]))
        const candidates: TorrentCandidate[] = []
        for (const row of picked) {
          const entry = byPage.get(row.page_url)
          if (!entry?.info_hash) continue
          // Phase 2's one place a listed row becomes a candidate (hash, trackers, release parsed with the query).
          candidates.push(
            candidateFrom({ infoHash: entry.info_hash, name: row.name, seeds: row.seeds, sizeBytes: row.size_bytes ?? null, trackers: entry.trackers ?? [], site }, site, query),
          )
        }
        if (candidates.length === 0) {
          const why = magnets.data.magnets.find((entry) => entry.error)?.error ?? 'no magnet link'
          return answer('error', `magnets: none of ${picked.length} release pages gave a magnet link (${why})`)
        }
        return answer('ok', `${candidates.length} of ${found.data.rows.length} listed releases`, candidates)
      } catch (err) {
        return answer('error', err instanceof Error ? err.message : String(err))
      }
    },
  }
}

/** The sites that are on, as the finder's fallback indexes, in TORRENT_SITES order. */
export function torrentSiteIndexes(config: TorrentSitesConfig, runner: TorrentSiteRunner): TorrentIndex[] {
  const indexes: TorrentIndex[] = []
  for (const site of TORRENT_SITES) {
    const origin = config.origins[site]
    if (origin !== null) indexes.push(torrentSiteIndex(site, { origin, runner }))
  }
  return indexes
}
