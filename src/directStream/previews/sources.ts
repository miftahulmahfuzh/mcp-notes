import type { Config } from '../../config.js';
import type { StreamCache } from '../cache/service.js';
import type { FetchLike } from '../passThrough.js';
import type { DirectStreamService } from '../service.js';
import type { StreamSession } from '../sessions.js';
import type { TorrentStreams } from '../torrent/service.js';
import { cacheSource } from './cacheSource.js';
import { providerSource } from './providerSource.js';
import { torrentSource } from './torrentSource.js';
import type { PreviewSource } from './types.js';

/** What a source may read to build itself. Built once, in buildStreamPreviews. */
export interface PreviewSourceDeps {
  config: Config;
  directStream: DirectStreamService;
  /** This host's stream cache; null without one. */
  streamCache: Pick<StreamCache, 'previewView'> | null;
  /** This host's torrents (phase 2's source reads three read-only members of it); null with torrents off. */
  torrents: TorrentStreams | null;
  /** The pass-through's fetch (DirectStreamService.passThroughFetch; phase 3's source reads a provider's track with it). */
  fetch: FetchLike;
  /**
   * A source's list for `session` changed outside a list() call (phase 3: a provider's track was read). The
   * session is listed again; its `preview_rev` rises if the list differs (StreamPreviews.changed). Never throws.
   */
  changed: (session: StreamSession) => void;
  log: (line: string) => void;
  /** A plain file's length in seconds (test seam; default ffprobe). */
  probeDuration?: (file: string) => Promise<number | null>;
}

/** Builds one source, or null when what it reads is off. */
export type PreviewSourceFactory = (deps: PreviewSourceDeps) => PreviewSource | null;

/**
 * Every source of seek-preview frames, in the order a session's list is asked (types.ts PreviewSource): a
 * provider's own track (phase 3 puts `providerSource` first), a torrent's file or remux (phase 2 puts
 * `torrentSource` before the cache), then this machine's stream cache. Each source is one line here.
 */
export const PREVIEW_SOURCES: readonly PreviewSourceFactory[] = [
  providerSource,
  torrentSource,
  cacheSource,
];

export function previewSources(deps: PreviewSourceDeps): PreviewSource[] {
  return PREVIEW_SOURCES.map((make) => make(deps)).filter((source): source is PreviewSource => source !== null);
}
