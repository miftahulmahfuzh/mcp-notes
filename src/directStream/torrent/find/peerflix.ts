import { stremioAddonIndex } from './torrentio.js';
import type { TorrentIndex, TorrentQuery } from './types.js';

/** The one original language (ISO 639-1) Peerflix is asked for. */
export const PEERFLIX_LANGUAGE = 'es';

/**
 * Peerflix (addon.peerflix.mov), a Stremio torrent add-on of Spanish releases, nearly all Castilian dubs. Direct
 * streaming plays the original language only, so for a title made in any other language its every listing would be
 * a dub: it is asked only when the title's original language is Spanish. For any other title the finder sends it no
 * request and lists no attempt of it, so a play's attempts and log do not name it every time.
 */
export function peerflixIndex(base: string): TorrentIndex {
  return stremioAddonIndex({
    name: 'peerflix',
    base,
    asks: (query: TorrentQuery) => (query.originalLanguage ?? '').trim().toLowerCase() === PEERFLIX_LANGUAGE,
  });
}
