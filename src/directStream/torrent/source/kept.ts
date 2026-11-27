import { refLabel, type ResolveAttempt, type ResolvedSource, type StreamRef } from '../../types.js';
import type { SessionTorrent } from '../../sessions.js';
import { candidateFromMagnet, parseRelease, type TorrentCandidate } from '../find/index.js';
import { MAX_TORRENT_TRIES, TORRENT_DEADLINE_MS, TORRENT_PROVIDER, torrentLabel } from './constants.js';
import type { SourceContext } from './context.js';
import { queryOf } from './query.js';
import { tryCandidates } from './race.js';
import { messageOf } from './text.js';
import type { KeptResolve, KeptState, PlayFacts, TorrentResolve, TorrentResolveOptions } from './types.js';

/**
 * Torrents held beyond a play: the next episode fetched while another plays (fetchAhead, ahead.ts) and a download the
 * owner asked for (fetchKept, src/directStream/downloads/). A kept download is checked as a play is, and its
 * untagged audio heard before it is kept: a dub is never downloaded.
 */

/** How a kept fetch plays one title: TorrentSource.resolve (its in-memory failures and listings included). */
export type Resolve = (ref: StreamRef, options: TorrentResolveOptions) => Promise<TorrentResolve>;

/** `dubbed` when every torrent tried was refused or heard as a dub; else `no_source`. */
export function keptFailure(attempts: readonly ResolveAttempt[]): 'no_source' | 'dubbed' {
  const torrents = attempts.filter((a) => a.provider.startsWith(`${TORRENT_PROVIDER}: `) && a.outcome !== 'skipped');
  return torrents.length > 0 && torrents.every((a) => a.outcome === 'dubbed') ? 'dubbed' : 'no_source';
}

/**
 * The next episode, fetched while another plays (ahead.ts): `resolve`, and then everything a page would
 * need is stopped (the subtitle tiers still running, the sync, a remux), so only the download goes on. The
 * torrent stays in the swarm until `releaseAhead`. A later play finds the file with `fromDisk`.
 */
export async function fetchAhead(ctx: SourceContext, resolve: Resolve, ref: StreamRef, options: TorrentResolveOptions): Promise<TorrentResolve> {
  const out = await resolve(ref, options);
  if (!out.ok) return out;
  out.torrent.stop.abort();
  if (out.torrent.manifestKind === 'hls') ctx.opts.remux?.release(out.torrent.infoHash, out.torrent.fileIndex);
  return out;
}

/** Lets go of a torrent `fetchAhead` took (once): with no other user the daemon leaves its swarm. */
export function releaseAhead(ctx: SourceContext, torrent: SessionTorrent): void {
  if (!torrent.held) return;
  torrent.held = false;
  ctx.hands.letGo(torrent.infoHash);
}

/**
 * A download the owner asked for (src/directStream/downloads/): the title's torrent found and opened as a play finds
 * it (the indexes, the race, the header, the original-language check on the file's tags), or the one torrent
 * `infoHash` names (a pick, or a download carried on after a pause or a restart: no index is asked, its kept
 * trackers are used). A file that tags no audio language is heard before it is kept, and a dub is let go and the
 * next torrent tried. Unlike fetchAhead nothing is stopped: the subtitle chain and the remux run to their end. The
 * torrent stays in the swarm until `release`. Never throws.
 */
export async function fetchKept(ctx: SourceContext, resolve: Resolve, ref: StreamRef, options: TorrentResolveOptions & { infoHash?: string | null }): Promise<KeptResolve> {
  const attempts: ResolveAttempt[] = [];
  const skip = new Set((options.skip ?? []).map((hash) => hash.toLowerCase()));
  const pinned = options.infoHash ?? null;
  for (let round = 0; round < MAX_TORRENT_TRIES; round += 1) {
    const out = pinned !== null ? await keptByHash(ctx, ref, pinned, options) : await resolve(ref, { ...options, skip: [...skip] });
    attempts.push(...out.attempts);
    if (!out.ok) return { ok: false, error: keptFailure(attempts), attempts };
    const dub = await heardAsDub(ctx, out.torrent, out.source, options.audioLang);
    if (dub === null) {
      ctx.log(`[notesd] torrent: ${refLabel(ref)}: keeping ${out.torrent.name} (${out.torrent.infoHash.slice(0, 8)}), downloaded until it is whole`);
      return { ok: true, torrent: out.torrent, attempts };
    }
    // The torrent's `resolved` attempt is what was heard as a dub: it says so, so the failure reads `dubbed`.
    const label = torrentLabel(out.torrent.name);
    for (let i = 0; i < attempts.length; i += 1) {
      const a = attempts[i]!;
      if (a.provider === label && a.outcome === 'resolved') attempts[i] = { ...a, outcome: 'dubbed', detail: `${a.detail}; audio heard: ${dub}` };
    }
    ctx.failures.noteDubbed(ref, out.torrent.infoHash, dub);
    dropKept(ctx, out.torrent);
    ctx.log(`[notesd] torrent: ${refLabel(ref)}: ${out.torrent.name} was heard as a dub (${dub}); not downloaded`);
    if (pinned !== null) break;
    skip.add(out.torrent.infoHash.toLowerCase());
  }
  return { ok: false, error: keptFailure(attempts), attempts };
}

/**
 * Where a kept download stands: its file whole on disk, its remux (none for a file Chrome plays as is), and whether
 * its subtitle chain is still searching. Never throws.
 */
export async function keptState(ctx: SourceContext, torrent: SessionTorrent): Promise<KeptState> {
  const file = (await ctx.pages.state(torrent)) === 'ready' ? 'whole' : 'downloading';
  const remux = torrent.manifestKind === 'hls' ? (ctx.opts.remux?.status(torrent.infoHash, torrent.fileIndex) ?? 'none') : 'none';
  return { file, remux, subtitles: (torrent.subtitlesPending ?? null) === null ? 'done' : 'searching' };
}

/** A kept download's remux that failed: started again once (the file is whole by then, so ffmpeg reads it from disk). Never throws. */
export async function retryKeptRemux(ctx: SourceContext, torrent: SessionTorrent): Promise<void> {
  if (torrent.manifestKind !== 'hls' || !torrent.held) return;
  try {
    await ctx.opts.remux?.resume(torrent.infoHash, torrent.fileIndex);
  } catch (err) {
    ctx.log(`[notesd] torrent: the remux of ${torrent.name} (${torrent.infoHash.slice(0, 8)}) failed again: ${messageOf(err)}`);
  }
}

/** One torrent by its info hash, opened with the trackers this host kept for it and the shared ones; no index is asked. */
async function keptByHash(ctx: SourceContext, ref: StreamRef, infoHash: string, options: TorrentResolveOptions): Promise<TorrentResolve> {
  const swarm = ctx.opts.swarm;
  const query = queryOf(ref, options.imdbId, options.names ?? null, options.audioLang);
  const base = candidateFromMagnet(infoHash, query);
  if (base === null) {
    return { ok: false, error: 'no_source', attempts: [{ provider: 'Torrent: magnet', outcome: 'error', took_s: 0, detail: 'not a 40-character info hash' }] };
  }
  const stored = (await Promise.resolve(swarm.trackersOf?.(base.infoHash)).catch(() => undefined)) ?? [];
  const name = (await Promise.resolve(swarm.releaseName?.(base.infoHash)).catch(() => null)) ?? base.name;
  const candidate: TorrentCandidate = { ...base, name, release: parseRelease(name), trackers: [...new Set([...stored, ...base.trackers])] };
  const play: PlayFacts = { audioLang: options.audioLang, imdbId: options.imdbId, resumeS: null, cloudTried: false };
  options.progress?.({ stage: `opening the torrent ${candidate.name}`, attempts: [] });
  return tryCandidates(ctx, ref, query, [candidate], play, ctx.now() + TORRENT_DEADLINE_MS, options.progress);
}

/** The reason a kept torrent's untagged audio was heard as a dub, or null (tagged, unknown original, no hearer, or not a dub). */
async function heardAsDub(ctx: SourceContext, torrent: SessionTorrent, source: ResolvedSource, audioLang: string | null): Promise<string | null> {
  if (audioLang === null || !ctx.ears.hears || (source.audio?.languages.length ?? 0) > 0) return null;
  const heard = await ctx.ears.hearAudio(torrent, audioLang, 0);
  return heard?.verdict === 'dubbed' ? heard.reason : null;
}

/** Lets go of a kept torrent that will not be downloaded (a dub): its subtitle chain and remux stop, and it leaves the swarm at once. */
function dropKept(ctx: SourceContext, torrent: SessionTorrent): void {
  torrent.stop.abort();
  if (!torrent.held) return;
  torrent.held = false;
  if (torrent.manifestKind === 'hls') ctx.opts.remux?.release(torrent.infoHash, torrent.fileIndex);
  ctx.hands.dropNow(torrent.infoHash, true);
}
