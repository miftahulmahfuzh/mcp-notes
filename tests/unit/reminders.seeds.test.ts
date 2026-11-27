import { describe, expect, it } from 'vitest';
import { MAX_REMINDER_BODY, MAX_REMINDER_REPO, type ReminderSeedRow } from '../../src/reminders/repo.js';
import { PLAY_LOG_RANKING_SEED, REMINDER_SEEDS, seedReminders } from '../../src/reminders/seeds.js';

describe('reminder seeds', () => {
  it('have unique keys and bodies the table accepts', () => {
    const keys = REMINDER_SEEDS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const seed of REMINDER_SEEDS) {
      expect(seed.key.length).toBeGreaterThan(0);
      expect(seed.key.length).toBeLessThanOrEqual(100);
      expect(seed.body.trim().length).toBeGreaterThan(0);
      expect(seed.body.length).toBeLessThanOrEqual(MAX_REMINDER_BODY);
      if (seed.repo !== null) expect(seed.repo.length).toBeLessThanOrEqual(MAX_REMINDER_REPO);
      expect(seed.dueAfterDays).toBeGreaterThan(0);
    }
  });

  it('the play-log reminder is for mcp-notes, a week out, and names proposal item 3 and where its data is', () => {
    expect(PLAY_LOG_RANKING_SEED).toMatchObject({ key: 'play-log-ranking', repo: 'mcp-notes', dueAfterDays: 7 });
    for (const words of ['proposal item 3', 'provider or torrent', 'http://localhost:7317/movies/health', 'direct_stream_health', 'docs:shots -- --live movies', 'health.png']) {
      expect(PLAY_LOG_RANKING_SEED.body).toContain(words);
    }
  });

  it('seedReminders reports only the keys the store took', async () => {
    const seen: string[] = [];
    const store = { seed: async (s: ReminderSeedRow) => (seen.push(s.key), s.key === 'a') };
    const seeds = [
      { key: 'a', repo: null, dueAfterDays: 1, body: 'one' },
      { key: 'b', repo: 'x', dueAfterDays: 2, body: 'two' },
    ];
    expect(await seedReminders(store, seeds)).toEqual(['a']);
    expect(seen).toEqual(['a', 'b']);
  });
});
