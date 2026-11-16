import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error -- plain .mjs scripts without type declarations
import { TORRENT_SITE_MODULES } from '../../../../claude/streaming/torrent/sites/index.mjs'
import { DEFAULT_TORRENT_SITES_CONFIG, TORRENT_SITE_ORIGIN_DEFAULTS } from '../../../../src/config.js'
import { findCandidates, parseRelease, type TorrentIndex } from '../../../../src/directStream/torrent/find/index.js'
import {
  MAX_RELEASE_PAGES,
  TORRENT_SITES,
  TORRENT_SITES_DEADLINE_MS,
  torrentSiteIndex,
  torrentSiteIndexes,
  type TorrentSiteRunner,
} from '../../../../src/directStream/torrent/find-sites.js'

type FindQuery = Parameters<TorrentIndex['find']>[0]
type FindContext = Parameters<TorrentIndex['find']>[1]

const ORIGIN = 'https://1337x.la'
const hashOf = (url: string): string => createHash('sha1').update(url).digest('hex')
const row = (id: number, name: string, seeds: number) => ({
  name,
  page_url: `${ORIGIN}/torrent/${id}/${name.replace(/[^A-Za-z0-9]+/g, '-')}/`,
  seeds,
  leeches: 10,
  size_bytes: 2_000_000_000,
})
// The Oppenheimer rows of the saved 1337x page (tests/fixtures/torrent-sites/1337x-search-oppenheimer.html),
// as `cli.mjs 1337x search` prints them, plus one unseeded row.
const ROWS = [
  row(5876708, 'Oppenheimer.2023.1080p.BluRay.DD5.1.x264-GalaxyRG', 6115),
  row(5829624, 'Oppenheimer (2023) NEW ENG 1080p.MP4.InfosPack022', 3212),
  row(5876811, 'Oppenheimer.2023.1080p.BluRay.DDP5.1.x265.10bit-GalaxyRG265', 2215),
  row(5737733, 'Oppenheimer (2023) NEW ENG 1080p HQ-CAM x264 AAC - HushRips', 1903),
  row(5876703, 'Oppenheimer.2023.720p.BluRay.999MB.x264-GalaxyRG', 1811),
  row(5752149, 'Oppenheimer.2023.1080p.LM.HD-TeleSync.DUAL.DD2.0.H.264-xCLuMsYx', 1713),
  row(5882292, 'Oppenheimer.2023.2160p.UHD.Bluray.REMUX.HDR10.HEVC.DTS-HD.MA.5.1-GHD[TGx]', 1687),
  row(5876686, 'Oppenheimer.2023.1080p.Bluray.REMUX.AVC.DTS-HD.MA.5.1-GHD[TGx]', 1253),
  row(1, 'Oppenheimer.2023.1080p.WEBRip.x264-NOBODY', 0),
]
const FILM = { imdbId: 'tt15398776', kind: 'movie', title: 'Oppenheimer', year: 2023 } as unknown as FindQuery
const CONTEXT = { fetch: globalThis.fetch, signal: new AbortController().signal } as unknown as FindContext
const pageUrls = (args: string[]): string[] => args.filter((arg) => arg.startsWith(`${ORIGIN}/torrent/`))

function fakeRunner(searchAnswer: unknown, magnetsAnswer?: (urls: string[]) => unknown) {
  return vi.fn<TorrentSiteRunner>(async (args) => {
    if (args[1] === 'search') return searchAnswer
    const urls = pageUrls(args)
    return magnetsAnswer
      ? magnetsAnswer(urls)
      : { ok: true, site: args[0], origin: ORIGIN, magnets: urls.map((url) => ({ page_url: url, info_hash: hashOf(url), trackers: ['udp://tracker.opentrackr.org:1337/announce'], error: null })) }
  })
}
const searched = (rows: unknown[]) => ({ ok: true, site: '1337x', origin: ORIGIN, url: `${ORIGIN}/category-search/Oppenheimer/Movies/1/`, rows, others: 0 })

describe('the torrent site list', () => {
  it('is the same in claude/streaming/torrent, the finder and the settings', () => {
    expect([...TORRENT_SITES].sort()).toEqual(Object.keys(TORRENT_SITE_MODULES).sort())
    expect([...TORRENT_SITES].sort()).toEqual(Object.keys(DEFAULT_TORRENT_SITES_CONFIG.origins).sort())
    for (const site of TORRENT_SITES) expect(TORRENT_SITE_MODULES[site].defaultOrigin).toBe(TORRENT_SITE_ORIGIN_DEFAULTS[site])
  })

  it('leaves out a site that is off', () => {
    const runner = fakeRunner(searched([]))
    expect(torrentSiteIndexes({ ...DEFAULT_TORRENT_SITES_CONFIG, origins: { '1337x': null, ext: 'https://ext.to' } }, runner).map((index) => index.name)).toEqual(['ext'])
    expect(torrentSiteIndexes(DEFAULT_TORRENT_SITES_CONFIG, runner).map((index) => index.name)).toEqual(['1337x', 'ext'])
  })
})

describe('torrentSiteIndex', () => {
  it('reads the magnets of the five best-seeded rows that are no cinema copy, dub or unseeded release', async () => {
    const runner = fakeRunner(searched(ROWS))
    const out = await torrentSiteIndex('1337x', { origin: ORIGIN, runner }).find(FILM, CONTEXT)
    expect(out.outcome).toBe('ok')
    expect(runner).toHaveBeenCalledTimes(2)
    const [searchArgs, searchOptions] = runner.mock.calls[0]!
    expect(searchArgs).toEqual(['1337x', 'search', '--origin', ORIGIN, '--deadline-s', expect.stringMatching(/^\d+$/), '--title', 'Oppenheimer', '--year', '2023', '--imdb', 'tt15398776'])
    expect(searchOptions.timeoutMs).toBeLessThanOrEqual(TORRENT_SITES_DEADLINE_MS)
    const asked = pageUrls(runner.mock.calls[1]![0])
    expect(asked).toHaveLength(MAX_RELEASE_PAGES)
    expect(asked.join(' ')).not.toMatch(/CAM|TeleSync|NOBODY/)
    expect(out.candidates.map((c) => c.seeds)).toEqual([6115, 3212, 2215, 1811, 1687])
    for (const candidate of out.candidates) {
      expect(candidate.index).toBe('1337x')
      expect(candidate.infoHash).toMatch(/^[0-9a-f]{40}$/)
      // Built by phase 2's candidateFrom: the release read with the query's title, the site's trackers first.
      expect(candidate.release).toEqual(parseRelease(candidate.name, { title: 'Oppenheimer', fileName: null }))
      expect(candidate.trackers[0]).toBe('udp://tracker.opentrackr.org:1337/announce')
      expect(candidate).toMatchObject({ listedBy: ['1337x'], site: '1337x', scoped: false, fileName: null, fileIdx: null })
      expect(candidate.sizeBytes).toBe(2_000_000_000)
    }
    expect(out.candidates[0]!.infoHash).toBe(hashOf(ROWS[0]!.page_url))
  })

  it('asks an episode by season and episode and leaves other episodes out', async () => {
    const episode = { imdbId: 'tt14452776', kind: 'tv', title: 'The Bear', year: 2022, season: 2, episode: 3 } as unknown as FindQuery
    const runner = fakeRunner(searched([row(10, 'The.Bear.S02E03.1080p.WEB.h264-EDITH', 300), row(11, 'The.Bear.S02E04.1080p.WEB.h264-EDITH', 900), row(12, 'The.Bear.S02.COMPLETE.1080p.HULU.WEB.H264-SuccessfulCrab', 500)]))
    const out = await torrentSiteIndex('1337x', { origin: ORIGIN, runner }).find(episode, CONTEXT)
    expect(runner.mock.calls[0]![0]).toEqual(expect.arrayContaining(['--season', '2', '--episode', '3']))
    expect(pageUrls(runner.mock.calls[1]![0]).join(' ')).not.toMatch(/S02E04/)
    expect(out.candidates.map((c) => c.name)).toEqual(['The.Bear.S02.COMPLETE.1080p.HULU.WEB.H264-SuccessfulCrab', 'The.Bear.S02E03.1080p.WEB.h264-EDITH'])
  })

  it('a bot check is the outcome bot_check and no release page is asked', async () => {
    const runner = fakeRunner({ ok: false, site: 'ext', origin: 'https://ext.to', error: 'bot_check', detail: 'the page stayed on "Just a moment..."' })
    const out = await torrentSiteIndex('ext', { origin: 'https://ext.to', runner }).find(FILM, CONTEXT)
    expect(out).toEqual({ outcome: 'bot_check', detail: 'search: bot_check: the page stayed on "Just a moment..."', candidates: [] })
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('a machine without the Windows Chrome is an error naming no_chrome', async () => {
    const runner = fakeRunner({ ok: false, error: 'no_chrome', detail: 'cannot run PowerShell' })
    const out = await torrentSiteIndex('1337x', { origin: ORIGIN, runner }).find(FILM, CONTEXT)
    expect(out.outcome).toBe('error')
    expect(out.detail).toContain('no_chrome')
  })

  it('a script that fails or hangs is an error, never a throw', async () => {
    const runner = vi.fn<TorrentSiteRunner>(async () => {
      throw new Error('torrent sites script failed: Command failed: timeout')
    })
    const out = await torrentSiteIndex('1337x', { origin: ORIGIN, runner }).find(FILM, CONTEXT)
    expect(out).toMatchObject({ outcome: 'error', candidates: [] })
    expect(out.detail).toContain('timeout')
  })

  it('no matching row is empty and no release page is asked', async () => {
    const runner = fakeRunner(searched([]))
    expect((await torrentSiteIndex('1337x', { origin: ORIGIN, runner }).find(FILM, CONTEXT)).outcome).toBe('empty')
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('release pages without a magnet link are an error', async () => {
    const runner = fakeRunner(searched(ROWS), (urls) => ({ ok: true, magnets: urls.map((url) => ({ page_url: url, info_hash: null, trackers: [], error: 'HTTP 404: no magnet link' })) }))
    const out = await torrentSiteIndex('1337x', { origin: ORIGIN, runner }).find(FILM, CONTEXT)
    expect(out.outcome).toBe('error')
    expect(out.detail).toContain('HTTP 404')
  })
})

describe('findCandidates with the sites as fallback', () => {
  it('adds what the site lists when every JSON index answers nothing, through the same filter', async () => {
    const notFound = vi.fn(async () => new Response('not found', { status: 404 }))
    const runner = fakeRunner(searched(ROWS))
    const result = await findCandidates(FILM, { fetch: notFound, fallback: [torrentSiteIndex('1337x', { origin: ORIGIN, runner })] } as unknown as Parameters<typeof findCandidates>[1])
    expect(runner).toHaveBeenCalled()
    expect(result.candidates.length).toBeGreaterThan(0)
    for (const candidate of result.candidates) {
      expect(candidate.index).toBe('1337x')
      expect(candidate.name).not.toMatch(/CAM|TeleSync/)
    }
    expect(JSON.stringify(result.indexes)).toContain('1337x')
  })
})
