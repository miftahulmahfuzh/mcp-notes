import type { SessionTorrent } from '../../sessions.js';
import type { MediaProbe } from '../probe.js';
import { playsOriginalDirect } from './refusal.js';
import type { TorrentSourceOptions } from './types.js';

/**
 * What the player page plays a torrent's file from, and whether that file is whole yet. The remux (torrent phase 5)
 * starts here for a file Chrome cannot play as is, or whose default audio is not the original.
 */
export class SessionPages {
  constructor(private readonly opts: Pick<TorrentSourceOptions, 'swarm' | 'remux' | 'localBase'>) {}

  /**
   * The address the page plays the file from: its file route when Chrome plays it as is, else the remux playlist
   * (torrent phase 5), answered once the remux's first segment is on disk. ffmpeg reads the file from disk once it is
   * whole, else through the file route. Throws RemuxError.
   */
  async fileForPage(
    infoHash: string,
    fileIndex: number,
    probe: MediaProbe,
    audioLang: string | null,
    timeoutMs?: number,
    remuxOnly = false,
  ): Promise<{ manifestUrl: string; manifestKind: 'mp4' | 'hls' }> {
    const fileUrl = this.opts.swarm.localUrl(infoHash, fileIndex);
    const remux = this.opts.remux ?? null;
    // A file that lives as its remux has no original to hand out: its finished remux plays, whatever the probe says.
    if (remux === null) {
      if (remuxOnly) throw new Error('it lives as its remux, and the remux is off');
      // With no remux, refusalOf already refused a file Chrome cannot play, so this only serves truly direct ones.
      return { manifestUrl: fileUrl, manifestKind: 'mp4' };
    }
    // playsOriginalDirect, not probe.direct: a dual-audio file whose original is not the default is remuxed, so the
    // original track plays.
    if (!remuxOnly && playsOriginalDirect(probe, audioLang)) return { manifestUrl: fileUrl, manifestKind: 'mp4' };
    const input = (await this.opts.swarm.filePath(infoHash, fileIndex)) ?? `${this.opts.localBase()}${fileUrl}`;
    const play = await remux.start({ infoHash, fileIndex, input, probe, audioLang }, timeoutMs === undefined ? {} : { timeoutMs });
    return { manifestUrl: play.manifestUrl, manifestKind: 'hls' };
  }

  /** `ready` once the chosen file is whole on disk, else `downloading`. */
  async state(torrent: SessionTorrent): Promise<SessionTorrent['state']> {
    try {
      if ((await this.opts.swarm.filePath(torrent.infoHash, torrent.fileIndex)) !== null) return 'ready';
      return (await this.opts.swarm.remuxOnly?.(torrent.infoHash, torrent.fileIndex)) === true ? 'ready' : 'downloading';
    } catch {
      return torrent.state;
    }
  }
}
