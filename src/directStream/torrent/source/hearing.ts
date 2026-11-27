import type { ResolvedSource } from '../../types.js';
import type { SessionTorrent } from '../../sessions.js';
import { normalizeAudioLang } from '../probe.js';
import type { TorrentMarks } from '../marks.js';
import { TORRENT_HEAR_AFTER_S, TORRENT_PROVIDER } from './constants.js';
import { messageOf } from './text.js';
import type { TorrentHearing, TorrentSourceOptions } from './types.js';

/**
 * Where a torrent's audio is heard: TORRENT_HEAR_AFTER_S after where the play starts (those pieces are fetched for the
 * play soon anyway), but never past the middle of a film whose length is known.
 */
export function hearAt(durationS: number | null, startS: number | null): number {
  const at = Math.max(0, startS ?? 0) + TORRENT_HEAR_AFTER_S;
  if (durationS === null || durationS <= 0) return at;
  return Math.max(0, Math.min(at, durationS / 2));
}

/**
 * What this machine knows of a torrent's audio whatever the title: the marks (marks.ts: the owner's blacklist, the
 * languages a file's tags named, the language heard) and the torrent audio check that hears an untagged file.
 */
export class TorrentEars {
  constructor(
    private readonly opts: Pick<TorrentSourceOptions, 'marks' | 'hear' | 'swarm' | 'localBase'>,
    private readonly log: (line: string) => void,
  ) {}

  /** The torrent marks (the blacklist, heard languages); null when none are wired. */
  get marks(): TorrentMarks | null {
    return this.opts.marks ?? null;
  }

  /** True when a hearing can run at all (a hearer is wired). */
  get hears(): boolean {
    return (this.opts.hear ?? null) !== null;
  }

  /** The info hashes the marks keep out of a play of a title whose original is `audioLang`; empty when the marks cannot be read. */
  async leftOutByMarks(audioLang: string | null): Promise<Set<string>> {
    const marks = this.opts.marks ?? null;
    if (marks === null) return new Set();
    try {
      return await marks.leftOut(audioLang);
    } catch (err) {
      this.log(`[notesd] torrent: the torrent marks could not be read: ${messageOf(err)}`);
      return new Set();
    }
  }

  /** Keeps the audio languages a probed file's tags name (marks.ts), behind the play. */
  noteTags(infoHash: string, name: string, languages: readonly string[]): void {
    const marks = this.opts.marks ?? null;
    if (marks === null) return;
    void marks.noteTags(infoHash, name, languages).catch((err: unknown) => this.log(`[notesd] torrent: the tags of ${infoHash.slice(0, 8)} could not be kept: ${messageOf(err)}`));
  }

  /**
   * The torrent audio check: a session's torrent whose file tags no audio language is heard (~30 s through Whisper,
   * TORRENT_HEAR_AFTER_S after where the play starts, from the daemon's own file route) and the language heard is
   * kept on the torrent (marks.ts), whatever the verdict but `unsure`. A torrent heard before answers from the marks.
   * Null when no hearer is wired. Never throws: a failure is `unsure`.
   */
  async hearAudio(torrent: Pick<SessionTorrent, 'infoHash' | 'fileIndex' | 'name' | 'durationS'>, audioLang: string, startS: number | null): Promise<TorrentHearing | null> {
    const hear = this.opts.hear ?? null;
    if (hear === null) return null;
    const original = normalizeAudioLang(audioLang);
    try {
      const mark = (await this.opts.marks?.get(torrent.infoHash)) ?? null;
      if (mark?.heardLanguage != null && original !== null) {
        const dub = mark.heardLanguage !== original;
        return {
          verdict: dub ? 'dubbed' : 'original',
          detected: mark.heardLanguage,
          probability: mark.heardProbability,
          reason: dub ? `heard before: the audio is spoken ${mark.heardLanguage}, not the original ${original}` : `heard before: the audio is spoken ${mark.heardLanguage}, the original`,
          kept: true,
        };
      }
      const url = `${this.opts.localBase()}${this.opts.swarm.localUrl(torrent.infoHash, torrent.fileIndex)}`;
      const source: ResolvedSource = {
        provider: TORRENT_PROVIDER,
        embed_url: '',
        manifest_url: url,
        manifest_kind: 'mp4',
        headers: { referer: null, origin: null, user_agent: null },
        subtitles: [],
        best_height: null,
        en_subtitle: false,
        took_s: null,
      };
      const finding = await hear.hear(source, audioLang, hearAt(torrent.durationS ?? null, startS));
      if (finding.verdict !== 'unsure' && finding.detected !== null && finding.probability !== null) {
        await this.opts.marks?.noteHeard(torrent.infoHash, torrent.name, finding.detected, finding.probability);
      }
      this.log(`[notesd] torrent: audio of ${torrent.name} (${torrent.infoHash.slice(0, 8)}), whose file tags no language: ${finding.verdict} (${finding.reason})`);
      return { ...finding, kept: false };
    } catch (err) {
      this.log(`[notesd] torrent: the audio of ${torrent.name} (${torrent.infoHash.slice(0, 8)}) could not be heard: ${messageOf(err)}`);
      return { verdict: 'unsure', detected: null, probability: null, reason: messageOf(err).slice(0, 200), kept: false };
    }
  }
}
