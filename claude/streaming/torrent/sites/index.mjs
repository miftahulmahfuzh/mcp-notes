// The torrent sites the finder falls back on, by name. src/directStream/torrent/find-sites.ts keeps
// the same names (TORRENT_SITES) and src/config.ts their default addresses; a test compares them.
// These are not streaming sites: claude/streaming/sites/index.mjs (play sites) stays apart.
import x1337 from './1337x.mjs';
import ext from './ext.mjs';

export const TORRENT_SITE_MODULES = { '1337x': x1337, ext };
