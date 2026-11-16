import { describe, expect, it } from 'vitest'
import { DEFAULT_TORRENT_SITES_CLI, parseTorrentSites } from '../../src/config.js'

describe('the torrent sites settings', () => {
  it('defaults to 1337x.la, ext.to and the script in this checkout', () => {
    expect(parseTorrentSites({})).toEqual({ origins: { '1337x': 'https://1337x.la', ext: 'https://ext.to' }, cli: DEFAULT_TORRENT_SITES_CLI })
  })

  it('takes another address, scheme and host only, and off', () => {
    const sites = parseTorrentSites({ NOTESD_TORRENT_1337X_ORIGIN: 'https://1337x.to/', NOTESD_TORRENT_EXT_ORIGIN: 'OFF' })
    expect(sites.origins).toEqual({ '1337x': 'https://1337x.to', ext: null })
  })

  it('refuses a path, a non-web address and a relative script path', () => {
    expect(() => parseTorrentSites({ NOTESD_TORRENT_1337X_ORIGIN: 'https://1337x.la/search' })).toThrow(/NOTESD_TORRENT_1337X_ORIGIN must be a site address/)
    expect(() => parseTorrentSites({ NOTESD_TORRENT_EXT_ORIGIN: 'ftp://ext.to' })).toThrow(/NOTESD_TORRENT_EXT_ORIGIN must be a site address/)
    expect(() => parseTorrentSites({ NOTESD_TORRENT_SITES_CLI: 'claude/streaming/torrent/cli.mjs' })).toThrow(/NOTESD_TORRENT_SITES_CLI must be an absolute path/)
  })
})
