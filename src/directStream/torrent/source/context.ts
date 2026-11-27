import type { FailureMemory } from './failures.js';
import type { SwarmHands } from './hands.js';
import type { TorrentEars } from './hearing.js';
import type { CandidateListings } from './listing.js';
import type { SessionPages } from './page.js';
import type { PastedMagnets } from './pasted.js';
import type { SubtitleStarter } from './subtitles.js';
import type { TorrentSourceOptions } from './types.js';

/**
 * Everything one TorrentSource holds, handed to the modules that do its work (race.ts, resolve.ts, kept.ts, pack.ts,
 * pasted.ts, listing.ts, disk.ts, learnMagnet.ts). Built once in its constructor. The in-memory state per film or
 * episode (one per daemon run) is `failures`, `listings` and `pasted`.
 */
export interface SourceContext {
  readonly opts: TorrentSourceOptions;
  readonly now: () => number;
  readonly log: (line: string) => void;
  readonly failures: FailureMemory;
  readonly hands: SwarmHands;
  readonly ears: TorrentEars;
  readonly pages: SessionPages;
  readonly subtitles: SubtitleStarter;
  readonly listings: CandidateListings;
  readonly pasted: PastedMagnets;
}
