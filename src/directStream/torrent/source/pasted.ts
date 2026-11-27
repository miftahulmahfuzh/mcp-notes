import { refLabel, type StreamRef } from '../../types.js';
import { candidateFromMagnet } from '../find/index.js';
import { TORRENT_DEADLINE_MS, TRACKER_PROBE_MS } from './constants.js';
import type { SourceContext } from './context.js';
import { queryOf, refKey } from './query.js';
import { tryCandidates } from './race.js';
import { plural } from './text.js';
import { swarmCounts } from './trackers.js';
import type { PlayFacts, TorrentResolve, TorrentResolveOptions } from './types.js';

/** One magnet pasted for a film or episode: its name, and how its play went (null: it played). */
export interface PastedMagnet {
  name: string;
  failed: string | null;
}

/** Per film or episode, in memory: each magnet the owner pasted for it, for the candidates list. Keyed by refKey. */
export class PastedMagnets {
  private readonly pasted = new Map<string, Map<string, PastedMagnet>>();

  /** The magnets pasted for `key`, by info hash; empty when none. */
  of(key: string): ReadonlyMap<string, PastedMagnet> {
    return this.pasted.get(key) ?? new Map<string, PastedMagnet>();
  }

  note(key: string, infoHash: string, magnet: PastedMagnet): void {
    const kept = this.pasted.get(key) ?? new Map<string, PastedMagnet>();
    kept.set(infoHash, magnet);
    this.pasted.set(key, kept);
  }
}

/**
 * One torrent the owner pasted (a magnet link or a bare 40-hex info hash), played without asking any index:
 * the swarm is opened, the title's file picked and probed, and the original-language check still applies (a
 * dub, or a torrent with no video file, is refused). `attempts` holds the one `Torrent: <name>`. Never throws.
 */
export async function playMagnet(ctx: SourceContext, ref: StreamRef, options: TorrentResolveOptions & { magnet: string; pasted?: boolean }): Promise<TorrentResolve> {
  const { opts, now, log } = ctx;
  const query = queryOf(ref, options.imdbId, options.names ?? null, options.audioLang);
  const candidate = candidateFromMagnet(options.magnet, query);
  if (candidate === null) {
    return { ok: false, error: 'no_source', attempts: [{ provider: 'Torrent: magnet', outcome: 'error', took_s: 0, detail: 'not a magnet link or a 40-character info hash' }] };
  }
  const play: PlayFacts = { audioLang: options.audioLang, imdbId: options.imdbId, resumeS: options.resumeS ?? null, cloudTried: false };
  options.progress?.({ stage: `opening the torrent ${candidate.name}`, attempts: [] });
  // Asked beside the play, without joining anything: when the swarm sends nothing, the answer says how thin it is.
  const known = swarmCounts(opts, log, [candidate], TRACKER_PROBE_MS).then((counts) => counts.get(candidate.infoHash) ?? null);
  const tried = await tryCandidates(ctx, ref, query, [candidate], play, now() + TORRENT_DEADLINE_MS, options.progress);
  const swarm = tried.ok ? null : await known;
  const out: TorrentResolve =
    tried.ok || swarm === null
      ? tried
      : { ...tried, attempts: tried.attempts.map((a) => (a.outcome === 'no_stream' ? { ...a, detail: `${a.detail}; the trackers asked know ${plural(swarm.seeders, 'seeder')} and ${plural(swarm.leechers, 'leecher')} for it` } : a)) };
  if (options.pasted === true) {
    const last = out.attempts.at(-1);
    ctx.pasted.note(refKey(ref), candidate.infoHash, { name: out.ok ? out.torrent.name : candidate.name, failed: out.ok ? null : last === undefined ? 'did not play' : `${last.outcome}: ${last.detail}` });
  }
  log(`[notesd] torrent: ${refLabel(ref)} from a pasted magnet (${candidate.infoHash.slice(0, 8)}): ${out.ok ? `playing ${out.torrent.name}` : 'did not play'}`);
  return out;
}
