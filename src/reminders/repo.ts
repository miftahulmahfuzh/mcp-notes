import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { reminders, type ReminderRow } from '../db/schema.js';

/** A reminder shown at a fresh start is not shown again for this long, until it is done. */
export const REMINDER_REPEAT_MS = 20 * 60 * 60 * 1000;
/** At most this many reminders go into one session's start context; the rest come at the next fresh start. */
export const MAX_REMINDERS_PER_START = 5;
/** The table's CHECKs say the same. */
export const MAX_REMINDER_BODY = 2000;
export const MAX_REMINDER_REPO = 200;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** One reminder as the `remind` tool answers it. Times are ISO 8601 UTC. */
export interface Reminder {
  id: number;
  body: string;
  /** The repository key it is shown in (`mcp-notes`); null: every repository. */
  repo: string | null;
  due_at: string;
  created_at: string;
  done_at: string | null;
  last_shown_at: string | null;
  /** Set on a reminder the daemon stored itself (src/reminders/seeds.ts). */
  seed_key: string | null;
}

/** What a fresh start is shown. */
export interface DueReminder {
  id: number;
  body: string;
  due_at: string;
}

export interface NewReminder {
  body: string;
  dueAt: Date;
  repo: string | null;
}

export interface ReminderSeedRow {
  key: string;
  repo: string | null;
  body: string;
  dueAfterDays: number;
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function view(row: ReminderRow): Reminder {
  return {
    id: row.id,
    body: row.body,
    repo: row.repo,
    due_at: row.dueAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    done_at: row.doneAt === null ? null : row.doneAt.toISOString(),
    last_shown_at: row.lastShownAt === null ? null : row.lastShownAt.toISOString(),
    seed_key: row.seedKey,
  };
}

/**
 * The only writer of `reminders`. Callers validate their input at their own boundary (the `remind` tool, the seed list);
 * the table's CHECKs are the last guard.
 */
export class RemindersRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async add(input: NewReminder): Promise<Reminder> {
    const [row] = await this.db
      .insert(reminders)
      .values({ body: input.body, dueAt: input.dueAt, repo: input.repo, createdAt: this.now() })
      .returning();
    if (row === undefined) throw new Error('insert into reminders returned no row');
    return view(row);
  }

  /** Every reminder not done, soonest first. */
  async listOpen(): Promise<Reminder[]> {
    const rows = await this.db.select().from(reminders).where(isNull(reminders.doneAt)).orderBy(asc(reminders.dueAt), asc(reminders.id));
    return rows.map(view);
  }

  /** Marks one done; `changed: false` when it already was. Null when no reminder has that id. */
  async done(id: number): Promise<{ reminder: Reminder; changed: boolean } | null> {
    const [updated] = await this.db
      .update(reminders)
      .set({ doneAt: this.now() })
      .where(and(eq(reminders.id, id), isNull(reminders.doneAt)))
      .returning();
    if (updated !== undefined) return { reminder: view(updated), changed: true };
    const [row] = await this.db.select().from(reminders).where(eq(reminders.id, id)).limit(1);
    return row === undefined ? null : { reminder: view(row), changed: false };
  }

  /**
   * The reminders a fresh start in `repo` shows at `now`: due (`due_at <= now`), not done, for `repo` or for every
   * repository (a null `repo` matches only those), and not shown in the last 20 hours. Stamps `last_shown_at = now` on
   * exactly the rows it returns, in the same statement; `skip locked` keeps two sessions starting at once from both
   * showing one reminder. Soonest first, at most MAX_REMINDERS_PER_START.
   */
  async dueFor(repo: string | null, now: Date = this.now()): Promise<DueReminder[]> {
    const at = now.toISOString();
    const shownBefore = new Date(now.getTime() - REMINDER_REPEAT_MS).toISOString();
    const res = await this.db.execute<{ id: string | number; body: string; due_at: string | Date }>(sql`
      with picked as (
        select id from reminders
        where done_at is null
          and due_at <= ${at}::timestamptz
          and (repo is null or repo = ${repo}::text)
          and (last_shown_at is null or last_shown_at <= ${shownBefore}::timestamptz)
        order by due_at, id
        limit ${MAX_REMINDERS_PER_START}
        for update skip locked
      )
      update reminders r set last_shown_at = ${at}::timestamptz
      from picked
      where r.id = picked.id
      returning r.id, r.body, r.due_at`);
    return res.rows
      .map((r) => ({ id: Number(r.id), body: r.body, due_at: iso(r.due_at) }))
      .sort((a, b) => a.due_at.localeCompare(b.due_at) || a.id - b.id);
  }

  /** Stores a seed once by its key, due `dueAfterDays` after now. True when this call stored it. */
  async seed(seed: ReminderSeedRow): Promise<boolean> {
    const now = this.now();
    const rows = await this.db
      .insert(reminders)
      .values({
        seedKey: seed.key,
        repo: seed.repo,
        body: seed.body,
        dueAt: new Date(now.getTime() + seed.dueAfterDays * DAY_MS),
        createdAt: now,
      })
      .onConflictDoNothing({ target: reminders.seedKey })
      .returning({ id: reminders.id });
    return rows.length > 0;
  }
}
