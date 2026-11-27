import type { ReminderSeedRow } from './repo.js';

/** A reminder the daemon stores itself, once by `key`, due `dueAfterDays` after the first start that knows it. */
export interface ReminderSeed extends ReminderSeedRow {
  key: string;
  /** The repository key it is shown in; null: every repository. */
  repo: string | null;
  dueAfterDays: number;
  /** Plain text the owner reads. */
  body: string;
}

/** STREAM_PLAY_LOG_PLAN R4: a week after the play log starts, decide proposal item 3 with its data. */
export const PLAY_LOG_RANKING_SEED: ReminderSeed = {
  key: 'play-log-ranking',
  repo: 'mcp-notes',
  dueAfterDays: 7,
  body:
    'The stream play log has been recording for a week. Decide proposal item 3: should real delivery (start failures, ' +
    'time to first frame, stalls, delivered height per torrent index and cloud provider) feed the choice of provider or ' +
    'torrent? Read the data at http://localhost:7317/movies/health or with the direct_stream_health tool. Also retake ' +
    'the movies guide live pictures now that the health page has data: npm run docs:shots -- --live movies (stream.png ' +
    'has a new icon; add health.png to docs/guide/movies.md).',
};

/** Every seed. A key is never reused for another reminder: a stored key is never stored again, even after it is done. */
export const REMINDER_SEEDS: readonly ReminderSeed[] = [PLAY_LOG_RANKING_SEED];

/** Stores each seed not stored yet. Returns the keys this call stored. */
export async function seedReminders(
  store: { seed(seed: ReminderSeedRow): Promise<boolean> },
  seeds: readonly ReminderSeed[] = REMINDER_SEEDS,
): Promise<string[]> {
  const stored: string[] = [];
  for (const seed of seeds) {
    if (await store.seed(seed)) stored.push(seed.key);
  }
  return stored;
}
