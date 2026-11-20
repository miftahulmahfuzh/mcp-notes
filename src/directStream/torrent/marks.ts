import { eq, isNotNull, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { streamTorrentMarks, type StreamTorrentMarkRow } from '../../db/schema.js';
import { normalizeAudioLang } from './probe.js';

/**
 * What this machine knows of a torrent whatever title it was opened for (`stream_torrent_marks`): the audio
 * languages its file's tags named, the language Whisper heard in it when they named none, and whether the owner
 * blacklisted it. A dub is a dub for every title, so all of it is kept per info hash.
 */

/** One torrent's marks, as the torrent source and the candidates list read them. */
export interface TorrentMark {
  infoHash: string;
  name: string | null;
  /** The audio languages the file's own tags named when it was probed; empty: none (or only `und`); null: never probed here. */
  tagLanguages: string[] | null;
  /** What Whisper heard in it (2-letter code), when the tags named nothing; null: never heard. */
  heardLanguage: string | null;
  heardProbability: number | null;
  heardAt: Date | null;
  blacklistedAt: Date | null;
  blacklistReason: string | null;
}

/**
 * The part of the marks the torrent source reads and writes. `leftOut` is what a play never tries: every blacklisted
 * torrent, and for a title whose original is `audioLang`, every torrent heard speaking another language.
 */
export interface TorrentMarks {
  leftOut(audioLang: string | null): Promise<Set<string>>;
  get(infoHash: string): Promise<TorrentMark | null>;
  many(infoHashes: readonly string[]): Promise<Map<string, TorrentMark>>;
  noteTags(infoHash: string, name: string | null, languages: readonly string[]): Promise<void>;
  noteHeard(infoHash: string, name: string | null, language: string, probability: number): Promise<void>;
  blacklist(infoHash: string, name: string | null, reason: string | null): Promise<TorrentMark>;
  unblacklist(infoHash: string): Promise<boolean>;
  blacklisted(): Promise<TorrentMark[]>;
}

function markOf(row: StreamTorrentMarkRow): TorrentMark {
  return {
    infoHash: row.infoHash,
    name: row.name,
    tagLanguages: row.tagLanguages ?? null,
    heardLanguage: row.heardLanguage,
    heardProbability: row.heardProbability,
    heardAt: row.heardAt,
    blacklistedAt: row.blacklistedAt,
    blacklistReason: row.blacklistReason,
  };
}

/** True when what was heard in the torrent is not the title's original language: a dub, for that title. */
export function heardDub(mark: Pick<TorrentMark, 'heardLanguage'> | null | undefined, audioLang: string | null): boolean {
  if (mark?.heardLanguage == null || audioLang === null) return false;
  const original = normalizeAudioLang(audioLang);
  return original !== null && mark.heardLanguage !== original;
}

const lower = (hash: string): string => hash.trim().toLowerCase();

/** The only writer of `stream_torrent_marks`. */
export class TorrentMarksRepo implements TorrentMarks {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(infoHash: string): Promise<TorrentMark | null> {
    const [row] = await this.db.select().from(streamTorrentMarks).where(eq(streamTorrentMarks.infoHash, lower(infoHash)));
    return row === undefined ? null : markOf(row);
  }

  async many(infoHashes: readonly string[]): Promise<Map<string, TorrentMark>> {
    const hashes = [...new Set(infoHashes.map(lower))];
    const out = new Map<string, TorrentMark>();
    if (hashes.length === 0) return out;
    const rows = await this.db
      .select()
      .from(streamTorrentMarks)
      .where(sql`${streamTorrentMarks.infoHash} in (${sql.join(hashes.map((h) => sql`${h}`), sql`, `)})`);
    for (const row of rows) out.set(row.infoHash, markOf(row));
    return out;
  }

  async leftOut(audioLang: string | null): Promise<Set<string>> {
    const rows = await this.db
      .select()
      .from(streamTorrentMarks)
      .where(or(isNotNull(streamTorrentMarks.blacklistedAt), isNotNull(streamTorrentMarks.heardLanguage)));
    return new Set(rows.filter((r) => r.blacklistedAt !== null || heardDub(r, audioLang)).map((r) => r.infoHash));
  }

  /** Upserts one row; `name` is kept when the new one is null. */
  private async upsert(infoHash: string, name: string | null, set: Partial<typeof streamTorrentMarks.$inferInsert>): Promise<StreamTorrentMarkRow> {
    const at = this.now();
    const [row] = await this.db
      .insert(streamTorrentMarks)
      .values({ infoHash: lower(infoHash), name, ...set, updatedAt: at })
      .onConflictDoUpdate({
        target: streamTorrentMarks.infoHash,
        set: { ...set, updatedAt: at, name: sql`coalesce(${name}, ${streamTorrentMarks.name})` },
      })
      .returning();
    if (row === undefined) throw new Error(`the marks of ${infoHash} were not written`);
    return row;
  }

  async noteTags(infoHash: string, name: string | null, languages: readonly string[]): Promise<void> {
    await this.upsert(infoHash, name, { tagLanguages: [...new Set(languages)].sort() });
  }

  async noteHeard(infoHash: string, name: string | null, language: string, probability: number): Promise<void> {
    await this.upsert(infoHash, name, { heardLanguage: language, heardProbability: probability, heardAt: this.now() });
  }

  async blacklist(infoHash: string, name: string | null, reason: string | null): Promise<TorrentMark> {
    return markOf(await this.upsert(infoHash, name, { blacklistedAt: this.now(), blacklistReason: reason }));
  }

  /** False when it was not blacklisted. */
  async unblacklist(infoHash: string): Promise<boolean> {
    const rows = await this.db
      .update(streamTorrentMarks)
      .set({ blacklistedAt: null, blacklistReason: null, updatedAt: this.now() })
      .where(sql`${streamTorrentMarks.infoHash} = ${lower(infoHash)} and ${streamTorrentMarks.blacklistedAt} is not null`)
      .returning({ infoHash: streamTorrentMarks.infoHash });
    return rows.length > 0;
  }

  async blacklisted(): Promise<TorrentMark[]> {
    const rows = await this.db.select().from(streamTorrentMarks).where(isNotNull(streamTorrentMarks.blacklistedAt));
    return rows.map(markOf).sort((a, b) => (b.blacklistedAt?.getTime() ?? 0) - (a.blacklistedAt?.getTime() ?? 0));
  }
}

/** In memory, for tests and a daemon built without a database. */
export class MemoryTorrentMarks implements TorrentMarks {
  readonly rows = new Map<string, TorrentMark>();
  constructor(private readonly now: () => Date = () => new Date()) {}

  private row(infoHash: string, name: string | null): TorrentMark {
    const key = lower(infoHash);
    const row = this.rows.get(key) ?? { infoHash: key, name: null, tagLanguages: null, heardLanguage: null, heardProbability: null, heardAt: null, blacklistedAt: null, blacklistReason: null };
    if (name !== null) row.name = name;
    this.rows.set(key, row);
    return row;
  }

  async get(infoHash: string): Promise<TorrentMark | null> {
    return this.rows.get(lower(infoHash)) ?? null;
  }
  async many(infoHashes: readonly string[]): Promise<Map<string, TorrentMark>> {
    const out = new Map<string, TorrentMark>();
    for (const h of infoHashes) {
      const row = this.rows.get(lower(h));
      if (row !== undefined) out.set(row.infoHash, row);
    }
    return out;
  }
  async leftOut(audioLang: string | null): Promise<Set<string>> {
    return new Set([...this.rows.values()].filter((r) => r.blacklistedAt !== null || heardDub(r, audioLang)).map((r) => r.infoHash));
  }
  async noteTags(infoHash: string, name: string | null, languages: readonly string[]): Promise<void> {
    this.row(infoHash, name).tagLanguages = [...new Set(languages)].sort();
  }
  async noteHeard(infoHash: string, name: string | null, language: string, probability: number): Promise<void> {
    Object.assign(this.row(infoHash, name), { heardLanguage: language, heardProbability: probability, heardAt: this.now() });
  }
  async blacklist(infoHash: string, name: string | null, reason: string | null): Promise<TorrentMark> {
    return Object.assign(this.row(infoHash, name), { blacklistedAt: this.now(), blacklistReason: reason });
  }
  async unblacklist(infoHash: string): Promise<boolean> {
    const row = this.rows.get(lower(infoHash));
    if (row?.blacklistedAt == null) return false;
    row.blacklistedAt = null;
    row.blacklistReason = null;
    return true;
  }
  async blacklisted(): Promise<TorrentMark[]> {
    return [...this.rows.values()].filter((r) => r.blacklistedAt !== null);
  }
}
