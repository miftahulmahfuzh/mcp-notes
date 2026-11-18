import { stremioAddonIndex } from './torrentio.js';
import type { TorrentIndex, TorrentQuery } from './types.js';

/** The one original language (ISO 639-1) Peerflix is asked for. */
export const PEERFLIX_LANGUAGE = 'es';

const NOT_ASKED = 'not asked: Peerflix lists Spanish releases, asked only for a title made in Spanish';

/**
 * Peerflix (addon.peerflix.mov), a Stremio torrent add-on of Spanish releases, nearly all Castilian dubs. Direct
 * streaming plays the original language only, so for a title made in any other language its every listing would be
 * a dub: it is asked only when the title's original language is Spanish, and otherwise answers `empty` with no request.
 */
export function peerflixIndex(base: string): TorrentIndex {
  return stremioAddonIndex({
    name: 'peerflix',
    base,
    skip: (query: TorrentQuery) => ((query.originalLanguage ?? '').trim().toLowerCase() === PEERFLIX_LANGUAGE ? null : NOT_ASKED),
  });
}
