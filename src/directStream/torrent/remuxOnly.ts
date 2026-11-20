import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { MediaProbe, ProbeFile } from './probe.js';
import { playlistSeconds, readRemuxProbe, REMUX_DONE_FILE, REMUX_PLAYLIST, REMUX_SEGMENT_S, remuxDir, writeRemuxProbe } from './remux.js';
import { chooseEmbeddedTrack, embeddedTrackId } from './subtitles/embedded.js';
import { CUES_DIR, parseFeedFile } from './subtitles/feed.js';

/**
 * A remuxed torrent film keeps one copy on disk. Once a file's remux is whole (ffmpeg read the whole file and exited
 * cleanly, every segment is on disk, the playlist covers the film) and nothing else still needs the original, the
 * original is deleted and the remux plays in its place (TorrentStreams.dropOriginals decides when; this module says
 * whether). Every other reader of the file works from the remux then: a replay from disk plays its playlist with the
 * probe kept beside it, the audio cuts (Whisper, Wyzie Synced, /sync-subtitle) read its segments (remuxAudioInput).
 * The one reader that cannot is the extraction of the English text track inside the file (the remux has no subtitle
 * stream), so the original stays until that track's cue feed is complete.
 */

/** How far short of the film's length a whole remux may end: its last segment's cut, the audio running out first. */
export function remuxSlackS(durationS: number): number {
  return Math.max(2 * REMUX_SEGMENT_S, durationS * 0.005);
}

/** Null when the remux in `dir` is whole (done, ended, every segment on disk, the film's length when known); else why not. */
export async function remuxWholeBlocker(dir: string, durationS: number | null): Promise<string | null> {
  if (!existsSync(path.join(dir, REMUX_DONE_FILE))) return 'its remux is not finished';
  let text: string;
  try {
    text = await readFile(path.join(dir, REMUX_PLAYLIST), 'utf8');
  } catch {
    return 'its remux has no playlist';
  }
  const lines = text.split('\n').map((l) => l.trim());
  if (!lines.includes('#EXT-X-ENDLIST')) return 'its remux playlist is not closed';
  const map = /^#EXT-X-MAP:URI="([^"]+)"/.exec(lines.find((l) => l.startsWith('#EXT-X-MAP:')) ?? '')?.[1];
  const parts = [...(map === undefined ? [] : [map]), ...lines.filter((l) => l !== '' && !l.startsWith('#'))];
  if (parts.length === 0) return 'its remux playlist names no segment';
  for (const name of parts) {
    if (name.includes('/') || name.includes('\\')) return `its remux playlist names ${name}, outside its folder`;
    const size = await stat(path.join(dir, name)).then(
      (s) => (s.isFile() ? s.size : 0),
      () => 0,
    );
    if (size === 0) return `its remux is missing ${name}`;
  }
  const seconds = playlistSeconds(text);
  if (durationS !== null && durationS > 0 && seconds < durationS - remuxSlackS(durationS)) {
    return `its remux holds ${Math.round(seconds)} s of the ${Math.round(durationS)} s film`;
  }
  return null;
}

/** What TorrentStreams asks before it deletes an original, and when it plays a file that lives as its remux. */
export interface RemuxKeeper {
  /**
   * Null when the file's remux can stand in for the original alone; else why the original stays. `original` is the
   * whole file on disk (read by ffprobe for a remux made before its probe was kept, which then keeps it).
   */
  blocker(infoHash: string, fileIndex: number, original: string, durationS: number | null): Promise<string | null>;
  /** True when the file has a finished remux to play (its `done.json`). */
  playable(infoHash: string, fileIndex: number): boolean;
}

export class RemuxOnly implements RemuxKeeper {
  constructor(private readonly opts: { dir: string; probe: ProbeFile | null; probeTimeoutMs?: number }) {}

  playable(infoHash: string, fileIndex: number): boolean {
    return existsSync(path.join(remuxDir(this.opts.dir, infoHash, fileIndex), REMUX_DONE_FILE));
  }

  async blocker(infoHash: string, fileIndex: number, original: string, durationS: number | null): Promise<string | null> {
    const dir = remuxDir(this.opts.dir, infoHash, fileIndex);
    if (!this.playable(infoHash, fileIndex)) return 'its remux is not finished';
    const probe = await this.probeOf(dir, original);
    if (probe === null) return 'what the file holds is not known (no probe beside its remux, and ffprobe could not read it)';
    const whole = await remuxWholeBlocker(dir, probe.durationS ?? durationS);
    if (whole !== null) return whole;
    // The remux holds no subtitle stream: the English text track inside the file must already be in its cue feed, whole.
    const track = chooseEmbeddedTrack(probe.subtitles);
    if (track !== null) {
      const feed = path.join(this.opts.dir, infoHash, CUES_DIR, `${embeddedTrackId(fileIndex, track.index)}.jsonl`);
      const complete = await readFile(feed, 'utf8').then(
        (text) => parseFeedFile(text).complete,
        () => false,
      );
      if (!complete) return `its English subtitle track (stream ${track.index}) is not extracted to the end yet, and the remux holds no subtitle track`;
    }
    return null;
  }

  /** The probe kept beside the remux; for an older remux, ffprobe on the whole original, then kept. */
  private async probeOf(dir: string, original: string): Promise<MediaProbe | null> {
    const kept = await readRemuxProbe(dir);
    if (kept !== null || this.opts.probe === null) return kept;
    try {
      const probe = await this.opts.probe(original, this.opts.probeTimeoutMs ?? 30_000);
      await writeRemuxProbe(dir, probe);
      return probe;
    } catch {
      return null;
    }
  }
}
