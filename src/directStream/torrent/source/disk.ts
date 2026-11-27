import { refLabel, type ResolveAttempt, type ResolvedSource, type StreamRef } from '../../types.js';
import type { SessionTorrent } from '../../sessions.js';
import { parseRelease, type ReleaseHeight } from '../find/index.js';
import type { MediaProbe } from '../probe.js';
import { TORRENT_PROBE_TIMEOUT_MS } from './constants.js';
import type { SourceContext } from './context.js';
import { refusalOf, standIn } from './refusal.js';
import { messageOf } from './text.js';
import type { DownloadOnDisk, TorrentSwarm } from './types.js';

/**
 * A torrent this host already holds whole: played from disk with no index asked and no swarm joined (R2.9), and the
 * small questions asked of this host's rows (is it on disk, what height did its release name say).
 */

/**
 * R2.9: this host's finished download of the title, played from disk with no index asked and no swarm
 * joined. Null when there is none, it is not whole, or its file does not play (another language, a file
 * Chrome cannot play): the play then goes on as if there were none. `attempts` are the subtitle tiers' only.
 */
export async function fromDisk(
  ctx: SourceContext,
  ref: StreamRef,
  options: { audioLang: string | null; resumeS?: number | null },
): Promise<{ torrent: SessionTorrent; source: ResolvedSource; attempts: ResolveAttempt[] } | null> {
  const { opts, log } = ctx;
  let download: DownloadOnDisk | null;
  let remuxOnly = false;
  try {
    download = await opts.swarm.find(ref);
    if (download === null || download.state !== 'ready') return null;
    if ((await opts.swarm.filePath(download.infoHash, download.fileIndex)) === null) {
      // Its original was deleted beside its whole remux: the remux plays, with the probe kept beside it.
      remuxOnly = (await opts.swarm.remuxOnly?.(download.infoHash, download.fileIndex)) === true;
      if (!remuxOnly) return null;
    }
  } catch (err) {
    log(`[notesd] torrent: could not read this machine's downloads of ${refLabel(ref)}: ${messageOf(err)}`);
    return null;
  }
  if ((await ctx.ears.leftOutByMarks(options.audioLang)).has(download.infoHash.toLowerCase())) {
    log(`[notesd] torrent: the download ${download.infoHash} of ${refLabel(ref)} is not played again: it is blacklisted, or was heard as a dub`);
    return null;
  }
  const manifestUrl = opts.swarm.localUrl(download.infoHash, download.fileIndex);
  let probe: MediaProbe;
  try {
    const kept = remuxOnly ? ((await opts.remux?.savedProbe(download.infoHash, download.fileIndex)) ?? null) : null;
    if (remuxOnly && kept === null) throw new Error('it lives as its remux, and no probe of it is kept beside the remux');
    probe = kept ?? (await opts.probe(`${opts.localBase()}${manifestUrl}`, TORRENT_PROBE_TIMEOUT_MS));
  } catch (err) {
    log(`[notesd] torrent: the download ${download.infoHash} of ${refLabel(ref)} could not be read: ${messageOf(err)}`);
    return null;
  }
  const refusal = refusalOf(probe, options.audioLang, opts.remux ?? null);
  if (refusal !== null) {
    log(`[notesd] torrent: the download ${download.infoHash} of ${refLabel(ref)} is not played again (${refusal.outcome}: ${refusal.detail})`);
    return null;
  }
  let page: { manifestUrl: string; manifestKind: 'mp4' | 'hls' };
  try {
    page = await ctx.pages.fileForPage(download.infoHash, download.fileIndex, probe, options.audioLang, undefined, remuxOnly);
  } catch (err) {
    log(`[notesd] torrent: the download ${download.infoHash} of ${refLabel(ref)} could not be remuxed: ${messageOf(err)}`);
    return null;
  }
  ctx.hands.noteDuration(download.infoHash, probe, download.fileIndex);
  const stop = new AbortController();
  const torrent: SessionTorrent = {
    infoHash: download.infoHash,
    fileIndex: download.fileIndex,
    selected: [download.fileIndex],
    name: download.name,
    index: null,
    seeds: null,
    state: 'ready',
    height: probe.video?.height ?? null,
    manifestUrl: page.manifestUrl,
    manifestKind: page.manifestKind,
    subtitles: [],
    subtitleRev: 0,
    candidates: [],
    durationS: probe.durationS,
    candidate: null,
    held: false,
    imdbId: null,
    query: null,
    stop,
  };
  const attempts = await ctx.subtitles.start(
    torrent,
    {
      ref,
      imdbId: null,
      infoHash: download.infoHash,
      release: download.release ?? download.name,
      files: [],
      fileIndex: download.fileIndex,
      subtitleIndexes: [],
      handle: null,
      probe,
      audioLang: options.audioLang,
      resumeS: options.resumeS ?? null,
      cloudTried: false,
      localBase: opts.localBase(),
      signal: stop.signal,
    },
    { ref, imdbId: null, infoHash: download.infoHash, fileIndex: download.fileIndex, durationS: probe.durationS },
  );
  return { torrent, source: standIn(torrent, probe, options.audioLang, null), attempts };
}

/** True when this host holds a finished download of `ref`. */
export async function onDisk(swarm: TorrentSwarm, ref: StreamRef): Promise<boolean> {
  try {
    const download = await swarm.find(ref);
    return download !== null && download.state === 'ready';
  } catch {
    return false;
  }
}

/** The picture height a torrent's release name says (from this host's row), or null when nothing says. Never throws. */
export async function releaseHeight(swarm: TorrentSwarm, infoHash: string): Promise<ReleaseHeight | null> {
  try {
    const name = (await swarm.releaseName?.(infoHash)) ?? null;
    return name === null ? null : parseRelease(name).height;
  } catch {
    return null;
  }
}
