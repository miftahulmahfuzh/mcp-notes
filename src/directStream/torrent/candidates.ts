import { dubGroupOfName } from './find/dubGroups.js';
import type { ExcludeReason, IndexAttempt, ReleaseHeight, ReleaseInfo } from './find/types.js';
import { heardDub, type TorrentMark } from './marks.js';
import type { SwarmCount } from './find/scrape.js';
import type { TorrentSlotRecord } from './types.js';

/**
 * The torrent candidates of one film or episode, as the title page's candidates list and the `direct_stream_torrents`
 * tool show them: what the indexes list (read fresh or from the last answer, CANDIDATE_LIST_TTL_MS), the torrents this
 * machine opened for it before (stream_torrents), and the magnets the owner pasted for it, each with what is known of
 * its audio and how it went. Listing joins no swarm: the seeds are the index's claim and the trackers' scrape.
 */

/** How long the finder's answer is reused by the candidates list (a play's own answer counts). */
export const CANDIDATE_LIST_TTL_MS = 10 * 60_000;
/** How long the list waits for the indexes: under the MCP client's 60 s, with the tool's own work around it. */
export const CANDIDATE_LIST_FIND_MS = 40_000;

/** Where a row's audio language comes from: Whisper heard it, the file's tags named it, the release name says it, or nothing says. */
export type CandidateAudioHow = 'heard' | 'tags' | 'name' | 'unknown';

export interface TorrentCandidateRow {
  info_hash: string;
  name: string;
  /** The picture height the name says; null when it says none. */
  height: ReleaseHeight | null;
  size_bytes: number | null;
  /** The seeds the index listed; null when no index listed it now. */
  seeds: number | null;
  /** What the trackers know now (BEP 15 scrape); null when none answered. */
  scrape: { seeders: number; leechers: number } | null;
  /** The indexes that list it, `magnet` when the owner pasted it, `played before` for a row of this machine only. */
  from: string[];
  audio: { languages: string[]; how: CandidateAudioHow; heard_probability: number | null };
  /** It played this film or episode here (a row played or whole on disk, or the pasted magnet played). */
  worked: boolean;
  /** Why it did not play when it was last tried; null when it did not fail. */
  failed: string | null;
  blacklisted: { at: string; reason: string | null } | null;
  /** The known voice-over group its name carries (find/dubGroups.ts). */
  dub_group: string | null;
  /** Heard speaking another language than this title's original. */
  heard_dub: boolean;
  /** Its name reads as a dub: the finder keeps it for the last-resort round. */
  dub_named: boolean;
  /** Why the finder leaves it out (`cam`, `few_seeds`...); null when it is a candidate. */
  left_out: ExcludeReason | null;
  /** The torrent a Torrent Stream play opens again first for this film or episode. */
  remembered: boolean;
  /** Whole on this machine's disk. */
  on_disk: boolean;
}

export interface TorrentCandidateList {
  original_language: string | null;
  /** When the indexes were asked (ISO); null when they were not. */
  listed_at: string | null;
  /** True when the indexes' answer was the last one kept, not asked now. */
  cached: boolean;
  indexes: IndexAttempt[];
  candidates: TorrentCandidateRow[];
}

/** One torrent as the list gathers it before marks and swarms are joined. */
export interface Gathered {
  infoHash: string;
  name: string;
  release: Pick<ReleaseInfo, 'height' | 'languages' | 'dubGroup'>;
  sizeBytes: number | null;
  seeds: number | null;
  from: string[];
  dubNamed: boolean;
  leftOut: ExcludeReason | null;
  failed: string | null;
  worked: boolean;
  onDisk: boolean;
}

/** Joins what was gathered with the marks, the slot rows and the scrape, in the order given. */
export function candidateRows(
  gathered: readonly Gathered[],
  facts: {
    audioLang: string | null;
    marks: ReadonlyMap<string, TorrentMark>;
    rows: readonly TorrentSlotRecord[];
    counts: ReadonlyMap<string, SwarmCount>;
    remembered: string | null;
  },
): TorrentCandidateRow[] {
  return gathered.map((g) => {
    const mark = facts.marks.get(g.infoHash) ?? null;
    const rows = facts.rows.filter((r) => r.infoHash === g.infoHash);
    const count = facts.counts.get(g.infoHash) ?? null;
    const rowFailure = rows.find((r) => r.state === 'failed')?.error ?? null;
    const audio: TorrentCandidateRow['audio'] =
      mark?.heardLanguage != null
        ? { languages: [mark.heardLanguage], how: 'heard', heard_probability: mark.heardProbability }
        : mark?.tagLanguages != null && mark.tagLanguages.length > 0
          ? { languages: mark.tagLanguages, how: 'tags', heard_probability: null }
          : g.release.languages.length > 0
            ? { languages: g.release.languages, how: 'name', heard_probability: null }
            : { languages: [], how: 'unknown', heard_probability: null };
    return {
      info_hash: g.infoHash,
      name: g.name,
      height: g.release.height,
      size_bytes: g.sizeBytes ?? rows.find((r) => r.fileLength !== null)?.fileLength ?? null,
      seeds: g.seeds,
      scrape: count === null ? null : { seeders: count.seeders, leechers: count.leechers },
      from: g.from,
      audio,
      worked: g.worked || rows.some((r) => r.playedAt !== null || r.state === 'ready') || facts.remembered === g.infoHash,
      failed: g.failed ?? rowFailure,
      blacklisted: mark?.blacklistedAt == null ? null : { at: mark.blacklistedAt.toISOString(), reason: mark.blacklistReason },
      dub_group: g.release.dubGroup ?? dubGroupOfName(g.name)?.name ?? null,
      heard_dub: heardDub(mark, facts.audioLang),
      dub_named: g.dubNamed,
      left_out: g.leftOut,
      remembered: facts.remembered === g.infoHash,
      on_disk: g.onDisk || rows.some((r) => r.state === 'ready'),
    };
  });
}
