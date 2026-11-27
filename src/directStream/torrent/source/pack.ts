import type { ResolveAttempt, ResolveOutcome, StreamRef } from '../../types.js';
import { candidateFromMagnet, pickFile, type TorrentCandidate } from '../find/index.js';
import { audioLanguages } from '../probe.js';
import type { TorrentPick } from '../types.js';
import { seasonPacks } from '../seasonPack.js';
import { MAX_PACK_TRIES, NO_FILE_LIST, PREFERRED_TORRENT_HEIGHT, PROBE_MIN_MS, TORRENT_DEADLINE_MS, TORRENT_OPEN_TIMEOUT_MS, torrentLabel } from './constants.js';
import type { SourceContext } from './context.js';
import { probeWhileDelivering } from './probeWhileDelivering.js';
import { indexAttempt, queryOf, refKey } from './query.js';
import { refusalOf } from './refusal.js';
import { messageOf, pad, plural, seconds } from './text.js';
import { swarmCounts, trackersOf } from './trackers.js';
import type { FindAnswer, OpenedTorrent, PackFetch, PackHold, PackOptions } from './types.js';

/**
 * A season download's pack (downloads/season.ts). The indexes are asked for the first wanted episode; the season packs
 * among the answer (seasonPack.ts) are opened one at a time, at most MAX_PACK_TRIES, and the first that passes is
 * kept: its first wanted episode is taken alone and checked as a play is (the probe's refusal, then a hearing when its
 * tags name no language) before any other episode is selected; then every wanted episode it holds is taken with its
 * own `use`, its video and subtitle files only, one `stream_torrents` row each. `known` is tried first, with no
 * index asked. Never throws: a pack that fails is let go at once.
 */
export async function fetchPack(ctx: SourceContext, tmdbId: number, season: number, episodes: readonly number[], options: PackOptions): Promise<PackFetch> {
  const { opts, now, log } = ctx;
  const wanted = [...new Set(episodes)].sort((a, b) => a - b);
  const [first] = wanted;
  if (first === undefined) return { ok: false, error: 'no_pack', attempts: [] };
  const refOf = (episode: number): StreamRef => ({ kind: 'tv', tmdbId, season, episode });
  const label = `TMDB tv ${tmdbId} S${pad(season)}`;
  const started = now();
  const query = queryOf(refOf(first), options.imdbId, options.names, options.audioLang);
  // Blacklisted by the owner, or heard speaking another language than this title's: never tried.
  const marked = await ctx.ears.leftOutByMarks(options.audioLang);
  const attempts: ResolveAttempt[] = [];
  const kept = (hold: Omit<PackHold, 'attempts'>): PackFetch => {
    log(`[notesd] torrent: ${label}: downloading ${plural(hold.episodes.length, 'episode')} from the season pack ${hold.name} (${hold.infoHash.slice(0, 8)})${hold.lacking.length === 0 ? '' : `; it lacks ${hold.lacking.map((e) => `E${pad(e)}`).join(', ')}`}`);
    return { ok: true, pack: { ...hold, attempts } };
  };
  const known = options.known == null ? null : candidateFromMagnet(options.known, query);
  if (known !== null && !marked.has(known.infoHash.toLowerCase())) {
    const out = await tryPack(ctx, known, refOf, wanted, options, TORRENT_DEADLINE_MS);
    attempts.push(out.attempt);
    if (out.ok) return kept(out.pack);
  }
  let found: FindAnswer;
  try {
    found = await opts.find(query, AbortSignal.timeout(TORRENT_DEADLINE_MS), { tried: marked });
  } catch (err) {
    return { ok: false, error: 'no_pack', attempts: [...attempts, { provider: 'Index: all', outcome: 'error', took_s: seconds(started, now()), detail: messageOf(err) }] };
  }
  attempts.push(...found.indexes.map(indexAttempt));
  const listed = found.candidates.filter((c) => c.release.pack && !marked.has(c.infoHash.toLowerCase()) && c.infoHash !== known?.infoHash);
  const counts = await swarmCounts(opts, log, listed);
  const packs = seasonPacks(listed, season, counts, options.heights === 'preferred' ? PREFERRED_TORRENT_HEIGHT : null);
  for (const c of packs.slice(0, MAX_PACK_TRIES)) {
    const out = await tryPack(ctx, c, refOf, wanted, options, TORRENT_DEADLINE_MS);
    attempts.push(out.attempt);
    if (out.ok) return kept(out.pack);
  }
  log(`[notesd] torrent: ${label}: no season pack of ${plural(wanted.length, 'episode')} ${packs.length === 0 ? `was found (${plural(listed.length, 'pack')} listed, none ${options.heights === 'preferred' ? `at ${PREFERRED_TORRENT_HEIGHT}p ` : ''}with live seeds holding the season)` : 'passed'}; each episode downloads on its own`);
  return { ok: false, error: 'no_pack', attempts };
}

/**
 * One pack up to its holds: the file list from the swarm, each wanted episode's file (pickFile), the first one taken
 * and checked, then the others taken. Any failure lets go of every hold taken here, and of the torrent.
 */
async function tryPack(
  ctx: SourceContext,
  c: TorrentCandidate,
  refOf: (episode: number) => StreamRef,
  wanted: readonly number[],
  options: PackOptions,
  budgetMs: number,
): Promise<{ ok: true; pack: Omit<PackHold, 'attempts'>; attempt: ResolveAttempt } | { ok: false; attempt: ResolveAttempt }> {
  const { opts, now, hands, ears } = ctx;
  const started = now();
  const swarm = opts.swarm;
  const attempt = (outcome: ResolveOutcome, detail: string): ResolveAttempt => ({ provider: torrentLabel(c.name), outcome, took_s: seconds(started, now()), detail });
  const pickOf = (episode: number): TorrentPick => ({ infoHash: c.infoHash, trackers: trackersOf(opts, c), name: c.name, ref: refOf(episode), release: c.release });
  let holds = 0;
  const letGo = (): void => {
    if (holds === 0) hands.dropNow(c.infoHash, false);
    for (; holds > 0; holds -= 1) hands.dropNow(c.infoHash, true);
  };
  const [first] = wanted;
  if (first === undefined) return { ok: false, attempt: attempt('skipped', 'no episode was asked for') };
  let opened: OpenedTorrent;
  try {
    opened = await swarm.open(pickOf(first), { timeoutMs: Math.min(TORRENT_OPEN_TIMEOUT_MS, budgetMs) });
  } catch (err) {
    letGo();
    return { ok: false, attempt: attempt('no_stream', `${NO_FILE_LIST} (${messageOf(err)})`) };
  }
  const held = wanted.flatMap((episode) => {
    const picked = pickFile(opened.files, queryOf(refOf(episode), options.imdbId, null, options.audioLang));
    return picked === null ? [] : [{ episode, video: picked.video, subtitles: picked.subtitles }];
  });
  const lacking = wanted.filter((episode) => !held.some((h) => h.episode === episode));
  const [head, ...rest] = held;
  if (head === undefined) {
    letGo();
    return { ok: false, attempt: attempt('no_stream', `the torrent holds no file of ${wanted.map((e) => `E${pad(e)}`).join(', ')}`) };
  }
  try {
    await hands.useSlotOf(pickOf(head.episode), [head.video, ...head.subtitles]);
    holds += 1;
    // The audio check a play applies, on the first wanted episode alone, before any other file is selected.
    const url = `${opts.localBase()}${swarm.localUrl(c.infoHash, head.video)}`;
    const probed = await probeWhileDelivering({ opts, now, receivedText: (hash) => hands.receivedText(hash) }, url, c.infoHash, Math.max(PROBE_MIN_MS, budgetMs - (now() - started)), () => false);
    if (!probed.ok) {
      letGo();
      return { ok: false, attempt: attempt(probed.outcome, `E${pad(head.episode)}: ${probed.detail}`) };
    }
    const probe = probed.probe;
    ears.noteTags(c.infoHash, c.name, audioLanguages(probe));
    const refusal = refusalOf(probe, options.audioLang, opts.remux ?? null);
    if (refusal !== null) {
      letGo();
      ctx.failures.remember(refKey(refOf(head.episode)), c.infoHash, true, `${refusal.outcome}: ${refusal.detail}`);
      return { ok: false, attempt: attempt(refusal.outcome, `E${pad(head.episode)}: ${refusal.detail}`) };
    }
    if (options.audioLang !== null && audioLanguages(probe).length === 0 && ears.hears) {
      const heard = await ears.hearAudio({ infoHash: c.infoHash, fileIndex: head.video, name: c.name, durationS: probe.durationS }, options.audioLang, null);
      if (heard?.verdict === 'dubbed') {
        letGo();
        ctx.failures.noteDubbed(refOf(head.episode), c.infoHash, heard.reason);
        return { ok: false, attempt: attempt('dubbed', `E${pad(head.episode)}: ${heard.reason}`) };
      }
    }
    hands.noteDuration(c.infoHash, probe, head.video);
    for (const e of rest) {
      await hands.useSlotOf(pickOf(e.episode), [e.video, ...e.subtitles]);
      holds += 1;
    }
  } catch (err) {
    letGo();
    return { ok: false, attempt: attempt('error', messageOf(err)) };
  }
  const detail = `${plural(held.length, 'episode')} taken${lacking.length === 0 ? '' : `; it lacks ${lacking.map((e) => `E${pad(e)}`).join(', ')}`}, ${c.seeds} seeds`;
  return { ok: true, pack: { infoHash: c.infoHash, name: c.name, episodes: held, lacking }, attempt: attempt('resolved', detail) };
}
