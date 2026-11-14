import { access } from 'node:fs/promises';
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { movieEpisodes, movieFiles, moviePlays, movieTitles } from '../db/schema.js';
import type { MoviePlayer, PlayStarted } from './player.js';
import { fileState } from './state.js';
import type { TitleKind, WatchState } from './types.js';

type FileRow = typeof movieFiles.$inferSelect;
type PlayRow = typeof moviePlays.$inferSelect;
type TitleRow = typeof movieTitles.$inferSelect;

export interface ContinueDeps {
  db: Db;
  player: Pick<MoviePlayer, 'host' | 'play'>;
  /** Default: fs.access. A file counts as present only when it is really on disk. */
  exists?: (abs: string) => Promise<boolean>;
}

export interface ContinueTitleRef {
  id: string;
  title: string;
  kind: TitleKind;
  year: number | null;
}

export interface ContinueEpisodeRef {
  file_id: number | null;
  season: number | null;
  episode: number | null;
  absolute_episode: number | null;
  name: string | null;
}

export type NothingReason = 'finished' | 'caught_up' | 'no_episodes';

export type ContinueResult =
  | { action: 'resumed' | 'started'; title: ContinueTitleRef; file: ContinueEpisodeRef; position: number; play: PlayStarted }
  | { action: 'missing'; title: ContinueTitleRef; missing: ContinueEpisodeRef; present: ContinueEpisodeRef[] }
  | { action: 'nothing'; title: ContinueTitleRef; reason: NothingReason; finished_at: string | null; last: ContinueEpisodeRef | null }
  | { action: 'ambiguous'; query: string; candidates: ContinueTitleRef[] }
  | { action: 'no_match'; query: string | null };

/** One file of the title with what continue needs to decide. */
export interface ContinueFileView {
  file: FileRow;
  last: PlayRow | null;
  state: WatchState;
  /** On this host, not deleted, on disk. */
  present: boolean;
}

/** One expected episode (from movie_episodes, season >= 1). */
export interface EpisodeSlot {
  season: number;
  episode: number;
  name: string | null;
}

export type ContinueDecision =
  | { action: 'resume' | 'start'; file: FileRow }
  | { action: 'missing'; missing: ContinueEpisodeRef; present: ContinueEpisodeRef[] }
  | { action: 'nothing'; reason: NothingReason; finishedAt: Date | null; last: ContinueEpisodeRef | null };

/** Titles a query may match before it is "ambiguous". */
const MAX_CANDIDATES = 10;

const NO_EPISODE: ContinueEpisodeRef = { file_id: null, season: null, episode: null, absolute_episode: null, name: null };

function playedAt(v: ContinueFileView): number {
  return v.last === null ? Number.NEGATIVE_INFINITY : v.last.startedAt.getTime();
}

function newestFirst(a: ContinueFileView, b: ContinueFileView): number {
  return playedAt(b) - playedAt(a);
}

function slotOrder(a: { season: number; episode: number }, b: { season: number; episode: number }): number {
  return a.season - b.season || a.episode - b.episode;
}

function fileRef(file: FileRow, name: string | null): ContinueEpisodeRef {
  return { file_id: file.id, season: file.season, episode: file.episode, absolute_episode: file.absoluteEpisode, name };
}

/** The latest of: title flag, file flags, done signals, end of the last finishing play. */
function finishedAt(titleWatchedAt: Date | null, finished: ContinueFileView[]): Date | null {
  const times: number[] = [];
  if (titleWatchedAt !== null) times.push(titleWatchedAt.getTime());
  for (const v of finished) {
    for (const d of [v.file.watchedAt, v.file.doneAt, v.last?.endedAt ?? null]) if (d !== null) times.push(d.getTime());
  }
  return times.length === 0 ? null : new Date(Math.max(...times));
}

/**
 * The continue rule (R6.1), on loaded data, with no I/O. (a) resume the most recently played
 * present in-progress file; (b) a film: finished -> nothing, a present file -> start, else
 * missing; (c) a series: the first unfinished episode after the newest play (else after the
 * highest finished episode, else the first) -> start when present, else missing with the later
 * present episodes; none left -> caught_up.
 */
export function decideContinue(
  kind: TitleKind,
  titleWatchedAt: Date | null,
  files: ContinueFileView[],
  episodes: EpisodeSlot[],
): ContinueDecision {
  const resumable = files.filter((v) => v.present && v.state === 'in_progress').sort(newestFirst);
  if (resumable[0] !== undefined) return { action: 'resume', file: resumable[0].file };

  if (kind === 'movie') {
    const finished = files.filter((v) => v.state === 'finished');
    if (titleWatchedAt !== null || finished.length > 0) {
      return { action: 'nothing', reason: 'finished', finishedAt: finishedAt(titleWatchedAt, finished), last: null };
    }
    const present = files.find((v) => v.present);
    if (present !== undefined) return { action: 'start', file: present.file };
    return { action: 'missing', missing: NO_EPISODE, present: [] };
  }

  const placed = files.filter((v) => v.file.season !== null && v.file.episode !== null);
  const slotOf = (v: ContinueFileView): { season: number; episode: number } => ({ season: v.file.season!, episode: v.file.episode! });
  let seq: EpisodeSlot[] = episodes;
  if (seq.length === 0) {
    const seen = new Map<string, EpisodeSlot>();
    for (const v of placed) seen.set(`${v.file.season}x${v.file.episode}`, { ...slotOf(v), name: null });
    seq = [...seen.values()].sort(slotOrder);
  }
  if (seq.length === 0) return { action: 'nothing', reason: 'no_episodes', finishedAt: null, last: null };

  const filesAt = (s: EpisodeSlot): ContinueFileView[] =>
    placed.filter((v) => v.file.season === s.season && v.file.episode === s.episode);
  const nameOf = (v: ContinueFileView): string | null =>
    seq.find((s) => s.season === v.file.season && s.episode === v.file.episode)?.name ?? null;

  const played = placed.filter((v) => v.last !== null).sort(newestFirst)[0];
  const highestFinished = placed
    .filter((v) => v.state === 'finished')
    .sort((a, b) => slotOrder(slotOf(b), slotOf(a)))[0];
  const anchor = played ?? highestFinished ?? null;
  const after = anchor === null ? seq : seq.filter((s) => slotOrder(s, slotOf(anchor)) > 0);
  const next = after.find((s) => !filesAt(s).some((v) => v.state === 'finished'));

  if (next === undefined) {
    const finished = placed.filter((v) => v.state === 'finished');
    return {
      action: 'nothing',
      reason: 'caught_up',
      finishedAt: finishedAt(null, finished),
      last: anchor === null ? null : fileRef(anchor.file, nameOf(anchor)),
    };
  }
  const here = filesAt(next).find((v) => v.present);
  if (here !== undefined) return { action: 'start', file: here.file };
  const later = seq.slice(seq.indexOf(next) + 1).flatMap((s) => {
    const v = filesAt(s).find((x) => x.present);
    return v === undefined ? [] : [fileRef(v.file, s.name)];
  });
  return {
    action: 'missing',
    missing: { file_id: null, season: next.season, episode: next.episode, absolute_episode: null, name: next.name },
    present: later,
  };
}

function titleRef(t: TitleRow): ContinueTitleRef {
  return { id: t.id, title: t.title, kind: t.kind as TitleKind, year: t.year };
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

async function pathExists(abs: string): Promise<boolean> {
  try {
    await access(abs);
    return true;
  } catch {
    return false;
  }
}

type Resolved = { kind: 'one'; title: TitleRow } | { kind: 'none' } | { kind: 'ambiguous'; candidates: TitleRow[] };

/** A title id (`tv-247718`, what the web sends), or a case-insensitive substring of the title/original title. */
async function resolveTitle(db: Db, q: string): Promise<Resolved> {
  const lower = q.toLowerCase();
  const pattern = `%${escapeLike(q)}%`;
  const rows = await db
    .select()
    .from(movieTitles)
    .where(or(eq(movieTitles.id, lower), ilike(movieTitles.title, pattern), ilike(movieTitles.originalTitle, pattern)))
    .orderBy(asc(movieTitles.title))
    .limit(MAX_CANDIDATES);
  if (rows.length === 0) return { kind: 'none' };
  if (rows.length === 1) return { kind: 'one', title: rows[0]! };
  const exact = rows.filter((r) => r.id === lower || r.title.toLowerCase() === lower);
  if (exact.length === 1) return { kind: 'one', title: exact[0]! };
  const recent = await db
    .select({ titleId: movieFiles.titleId })
    .from(moviePlays)
    .innerJoin(movieFiles, eq(movieFiles.id, moviePlays.fileId))
    .where(inArray(movieFiles.titleId, rows.map((r) => r.id)))
    .groupBy(movieFiles.titleId)
    .orderBy(desc(sql`max(${moviePlays.startedAt})`))
    .limit(1);
  const top = rows.find((r) => r.id === recent[0]?.titleId);
  return top !== undefined ? { kind: 'one', title: top } : { kind: 'ambiguous', candidates: rows };
}

/** R6.2: the title of this host's newest play event. */
async function newestPlayedTitle(db: Db, host: string): Promise<TitleRow | null> {
  const rows = await db
    .select({ title: movieTitles })
    .from(moviePlays)
    .innerJoin(movieFiles, eq(movieFiles.id, moviePlays.fileId))
    .innerJoin(movieTitles, eq(movieTitles.id, movieFiles.titleId))
    .where(eq(moviePlays.host, host))
    .orderBy(desc(moviePlays.startedAt), desc(moviePlays.id))
    .limit(1);
  return rows[0]?.title ?? null;
}

async function loadFiles(deps: ContinueDeps, titleIdValue: string): Promise<ContinueFileView[]> {
  const files = await deps.db.select().from(movieFiles).where(eq(movieFiles.titleId, titleIdValue));
  if (files.length === 0) return [];
  const lasts = await deps.db
    .selectDistinctOn([moviePlays.fileId])
    .from(moviePlays)
    .where(inArray(moviePlays.fileId, files.map((f) => f.id)))
    // MoviesRepo.lastPlay's order: a play with a known position first, then the newest.
    .orderBy(moviePlays.fileId, sql`(${moviePlays.positionS} is not null) desc`, desc(moviePlays.startedAt), desc(moviePlays.id));
  const lastBy = new Map(lasts.map((p) => [p.fileId, p]));
  const exists = deps.exists ?? pathExists;
  const host = deps.player.host;
  return Promise.all(
    files.map(async (file) => {
      const last = lastBy.get(file.id) ?? null;
      const present = file.host === host && file.deletedAt === null && (await exists(file.path));
      return { file, last, state: fileState(file, last), present };
    }),
  );
}

async function loadEpisodes(db: Db, titleIdValue: string): Promise<EpisodeSlot[]> {
  return db
    .select({ season: movieEpisodes.season, episode: movieEpisodes.episode, name: movieEpisodes.name })
    .from(movieEpisodes)
    .where(and(eq(movieEpisodes.titleId, titleIdValue), gte(movieEpisodes.season, 1)))
    .orderBy(asc(movieEpisodes.season), asc(movieEpisodes.episode));
}

interface Loaded {
  title: TitleRow;
  episodes: EpisodeSlot[];
  decision: ContinueDecision;
}

/** One title's files, plays and episodes -> what continue would do with it. Plays nothing. */
async function loadDecision(deps: ContinueDeps, title: TitleRow): Promise<Loaded> {
  const kind = title.kind as TitleKind;
  const views = await loadFiles(deps, title.id);
  const episodes = kind === 'tv' ? await loadEpisodes(deps.db, title.id) : [];
  return { title, episodes, decision: decideContinue(kind, title.watchedAt, views, episodes) };
}

/** Carries a decision out: resume and start go through the player, the rest only report. */
async function carryOut(deps: ContinueDeps, { title, episodes, decision }: Loaded): Promise<ContinueResult> {
  const ref = titleRef(title);
  switch (decision.action) {
    case 'resume':
    case 'start': {
      const play = await deps.player.play(decision.file.id);
      const name = episodes.find((e) => e.season === decision.file.season && e.episode === decision.file.episode)?.name ?? null;
      return {
        action: decision.action === 'resume' ? 'resumed' : 'started',
        title: ref,
        file: fileRef(decision.file, name),
        position: play.start_position,
        play,
      };
    }
    case 'missing':
      return { action: 'missing', title: ref, missing: decision.missing, present: decision.present };
    case 'nothing':
      return {
        action: 'nothing',
        title: ref,
        reason: decision.reason,
        finished_at: decision.finishedAt === null ? null : decision.finishedAt.toISOString(),
        last: decision.last,
      };
  }
}

/**
 * "continue <title>" / "continue" (R6.1, R6.2). Plays through the player when the decision is to
 * resume or start; a PlayError from the player propagates to the caller.
 */
export async function continueTitle(deps: ContinueDeps, titleQuery: string | null): Promise<ContinueResult> {
  const q = titleQuery?.trim() ?? '';
  let title: TitleRow;
  if (q === '') {
    const newest = await newestPlayedTitle(deps.db, deps.player.host);
    if (newest === null) return { action: 'no_match', query: null };
    title = newest;
  } else {
    const resolved = await resolveTitle(deps.db, q);
    if (resolved.kind === 'none') return { action: 'no_match', query: q };
    if (resolved.kind === 'ambiguous') return { action: 'ambiguous', query: q, candidates: resolved.candidates.map(titleRef) };
    title = resolved.title;
  }
  return carryOut(deps, await loadDecision(deps, title));
}

/** Titles decided at once by playSomething (two or three queries each). */
const SOMETHING_BATCH = 8;

export interface SomethingResult {
  /** `resumed` or `started` for the pick; `no_match` (query null) when nothing here is left to watch. */
  result: ContinueResult;
  /** How many titles could have been picked. */
  candidates: number;
}

/**
 * "play something": one title at random among those continue would play right now, i.e. with a
 * file on this machine that is not deleted and is on disk, and a film not finished or a series
 * with a next episode here. A half-watched title is as likely as an unwatched one, and resumes.
 * A title the owner marked watched is never picked. `random` is Math.random's contract.
 */
export async function playSomething(deps: ContinueDeps, random: () => number = Math.random): Promise<SomethingResult> {
  const here = deps.db
    .selectDistinct({ titleId: movieFiles.titleId })
    .from(movieFiles)
    .where(and(eq(movieFiles.host, deps.player.host), isNull(movieFiles.deletedAt), isNotNull(movieFiles.titleId)));
  const titles = await deps.db
    .select()
    .from(movieTitles)
    .where(and(inArray(movieTitles.id, here), isNull(movieTitles.watchedAt)))
    .orderBy(asc(movieTitles.id));
  const playable: Loaded[] = [];
  for (let i = 0; i < titles.length; i += SOMETHING_BATCH) {
    const batch = await Promise.all(titles.slice(i, i + SOMETHING_BATCH).map((t) => loadDecision(deps, t)));
    playable.push(...batch.filter((l) => l.decision.action === 'resume' || l.decision.action === 'start'));
  }
  if (playable.length === 0) return { result: { action: 'no_match', query: null }, candidates: 0 };
  const pick = playable[Math.min(playable.length - 1, Math.floor(random() * playable.length))]!;
  return { result: await carryOut(deps, pick), candidates: playable.length };
}
