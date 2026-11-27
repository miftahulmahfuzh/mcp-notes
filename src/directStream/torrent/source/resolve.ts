import { refLabel, type ResolveAttempt, type StreamRef } from '../../types.js';
import type { SessionTorrent } from '../../sessions.js';
import { deadLast, looksDead, type TorrentCandidate } from '../find/index.js';
import { PROBE_MIN_MS, TORRENT_DEADLINE_MS, TORRENTS_LEFT } from './constants.js';
import type { SourceContext } from './context.js';
import { indexAttempt, queryOf, refKey } from './query.js';
import { tryCandidates } from './race.js';
import { foundIn, messageOf, plural, seconds } from './text.js';
import { swarmCounts } from './trackers.js';
import type { FindAnswer, NoteFailure, PlayFacts, TorrentResolve, TorrentResolveOptions } from './types.js';

/**
 * Finds the title's torrents and plays the first that works, trying at most MAX_TORRENT_TRIES within
 * TORRENT_DEADLINE_MS, one budget for the whole ask (the dub-named round gets what the proper round left). `attempts` holds one `Index: <name>` per index asked, then per torrent tried one
 * `Torrent: <release>`, and after the one that plays its `Subtitles: <tier>` attempts. Never throws.
 */
export async function resolve(ctx: SourceContext, ref: StreamRef, options: TorrentResolveOptions): Promise<TorrentResolve> {
  const { opts, now, log, failures } = ctx;
  const started = now();
  // No IMDb id (TMDB lists none, or could not be asked): the indexes asked by title and the fallback sites still are.
  const query = queryOf(ref, options.imdbId, options.names ?? null, options.audioLang);
  options.progress?.({ stage: 'asking the torrent indexes', attempts: [] });
  // Blacklisted by the owner, or heard speaking another language than this title's: never tried.
  const marked = await ctx.ears.leftOutByMarks(options.audioLang);
  let found: FindAnswer;
  try {
    // What earlier asks for this title already failed on: with nothing new among the JSON indexes' candidates, the finder asks its fallback sites.
    const before = new Set([...(options.skip ?? []).map((h) => h.toLowerCase()), ...failures.remembered(refKey(ref)).keys(), ...marked]);
    found = await opts.find(query, AbortSignal.timeout(TORRENT_DEADLINE_MS), { tried: before });
  } catch (err) {
    return { ok: false, error: 'no_source', attempts: [{ provider: 'Index: all', outcome: 'error', took_s: seconds(started, now()), detail: messageOf(err) }] };
  }
  const key = refKey(ref);
  ctx.listings.keep(key, found);
  const asked = (options.skip ?? []).map((h) => h.toLowerCase());
  const leftOut = (): Set<string> => new Set([...asked, ...failures.remembered(key).keys(), ...marked]);
  const pick = (skip: ReadonlySet<string>): { candidates: TorrentCandidate[]; dubs: TorrentCandidate[] } => {
    const proper = found.candidates.filter((c) => !skip.has(c.infoHash.toLowerCase()));
    // Releases the name read as a dub: many are dual-audio and still carry the original track (the probe decides).
    return { candidates: proper, dubs: (found.lastResort ?? []).filter((c) => !skip.has(c.infoHash.toLowerCase()) && !proper.some((k) => k.infoHash === c.infoHash)) };
  };
  let { candidates, dubs } = pick(leftOut());
  if (candidates.length === 0 && dubs.length === 0 && failures.forgetSwarmFailures(key)) {
    // Every torrent found was tried on earlier asks: start over with the ones whose swarm did not deliver then.
    ({ candidates, dubs } = pick(leftOut()));
    if (candidates.length + dubs.length > 0) log(`[notesd] torrent: ${refLabel(ref)}: every torrent found was tried before; starting over with ${plural(candidates.length + dubs.length, 'torrent')} whose swarm did not deliver`);
  }
  const counts = await swarmCounts(opts, log, [...candidates, ...dubs]);
  const dead = [...candidates, ...dubs].filter((c) => looksDead(counts.get(c.infoHash))).length;
  if (dead > 0) log(`[notesd] torrent: ${refLabel(ref)}: the trackers know no seeder for ${dead} of ${candidates.length + dubs.length} torrent(s); those are tried last`);
  const only = options.only ?? null;
  if (only !== null) {
    const allowed = (c: TorrentCandidate): boolean => only(c, counts.get(c.infoHash) ?? null);
    const before = candidates.length + dubs.length;
    candidates = candidates.filter(allowed);
    dubs = dubs.filter(allowed);
    log(`[notesd] torrent: ${refLabel(ref)}: ${candidates.length + dubs.length} of ${before} torrent(s) fit what this download asks for`);
  }
  candidates = deadLast(candidates, counts);
  dubs = deadLast(dubs, counts);
  const indexes = found.indexes.map(indexAttempt);
  const play: PlayFacts = { audioLang: options.audioLang, imdbId: options.imdbId, resumeS: options.resumeS ?? null, cloudTried: options.cloudTried === true };
  const progress = options.progress;
  const tried = new Set<string>();
  const note: NoteFailure = (c, lasting, why) => {
    tried.add(c.infoHash);
    failures.remember(key, c.infoHash, lasting, why ?? null);
  };
  /** The last attempt of a play that started nothing: what asking again would try. */
  const left = (): ResolveAttempt[] => {
    if (tried.size === 0) return [];
    const untried = [...candidates, ...dubs].filter((c) => !tried.has(c.infoHash)).length;
    const detail =
      untried > 0
        ? `${plural(untried, 'more torrent')} of this title ${untried === 1 ? 'was' : 'were'} found and not tried yet: ask again and the next ones are tried`
        : 'every torrent found was tried; asking again starts over with the ones whose swarm did not deliver';
    return [{ provider: TORRENTS_LEFT, outcome: 'skipped', took_s: null, detail }];
  };
  const out = await tryCandidates(ctx, ref, query, candidates, play, started + TORRENT_DEADLINE_MS, progress === undefined ? undefined : (p) => progress({ stage: p.stage, attempts: [...indexes, ...p.attempts] }), note, dubs.length);
  if (out.ok) {
    log(`[notesd] torrent: ${refLabel(ref)}: ${candidates.length} candidate(s), playing ${out.torrent.name}${foundIn(out.torrent.candidate)}`);
    return { ...out, attempts: [...indexes, ...out.attempts] };
  }
  // Nothing proper played: the dub-named releases are tried now, in their own round.
  const firstAttempts = [...indexes, ...out.attempts];
  if (dubs.length === 0 || started + TORRENT_DEADLINE_MS - now() < PROBE_MIN_MS) {
    log(`[notesd] torrent: ${refLabel(ref)}: ${candidates.length} candidate(s), none played`);
    return { ok: false, error: 'no_source', attempts: [...firstAttempts, ...left()] };
  }
  options.progress?.({ stage: 'trying releases whose name reads as a dub (the file may still carry the original)', attempts: firstAttempts });
  // The same budget as the proper round: one ask never takes longer than TORRENT_DEADLINE_MS in all.
  const dubbed = await tryCandidates(ctx, ref, query, dubs, play, started + TORRENT_DEADLINE_MS, progress === undefined ? undefined : (p) => progress({ stage: p.stage, attempts: [...firstAttempts, ...p.attempts] }), note);
  log(`[notesd] torrent: ${refLabel(ref)}: ${candidates.length} candidate(s) and ${dubs.length} dub-named, ${dubbed.ok ? `playing ${dubbed.torrent.name}${foundIn(dubbed.torrent.candidate)} (its file carries the original ${options.audioLang ?? 'language'})` : 'none played'}`);
  return dubbed.ok ? { ...dubbed, attempts: [...firstAttempts, ...dubbed.attempts] } : { ok: false, error: 'no_source', attempts: [...firstAttempts, ...dubbed.attempts, ...left()] };
}

/** The shuffle button: the session's remaining candidates, in their order, without asking the indexes again. Torrents that failed this title lately are left out. */
export async function next(ctx: SourceContext, ref: StreamRef, torrent: SessionTorrent, audioLang: string | null): Promise<TorrentResolve> {
  const key = refKey(ref);
  const failed = ctx.failures.remembered(key);
  const marked = await ctx.ears.leftOutByMarks(audioLang);
  const candidates = torrent.candidates.filter((c) => !failed.has(c.infoHash.toLowerCase()) && !marked.has(c.infoHash.toLowerCase()));
  if (torrent.query === null || candidates.length === 0) return { ok: false, error: 'no_source', attempts: [] };
  const play: PlayFacts = { audioLang, imdbId: torrent.imdbId, resumeS: null, cloudTried: false };
  // A torrent the shuffle tried and could not play is left out of the title's next plays too.
  return tryCandidates(ctx, ref, torrent.query, candidates, play, ctx.now() + TORRENT_DEADLINE_MS, undefined, (c, lasting, why) => ctx.failures.remember(key, c.infoHash, lasting, why ?? null));
}
