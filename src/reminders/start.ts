import type { Db } from '../db/client.js';
import { RemindersRepo } from './repo.js';
import { seedReminders } from './seeds.js';

export interface SeedRemindersIo {
  /** Default: seedReminders over a RemindersRepo on `db` (every seed of REMINDER_SEEDS). */
  seed?: (db: Db, now: () => Date) => Promise<string[]>;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

/**
 * Reminders (src/reminders/): each seed is stored once by its key, due its days after the first start that knows it.
 * A failure here costs the seed, never the start.
 */
export async function seedRemindersAtStart(db: Db, now: () => Date = () => new Date(), io: SeedRemindersIo = {}): Promise<void> {
  const seed = io.seed ?? ((d: Db, clock: () => Date) => seedReminders(new RemindersRepo(d, clock)));
  const log = io.log ?? ((line: string) => console.log(line));
  const error = io.error ?? ((line: string) => console.error(line));
  try {
    const seeded = await seed(db, now);
    if (seeded.length > 0) log(`[notesd] reminders: stored ${seeded.join(', ')}`);
  } catch (err) {
    error(`[notesd] reminders: could not store the seeds: ${err instanceof Error ? err.message : String(err)}`);
  }
}
