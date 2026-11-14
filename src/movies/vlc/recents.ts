import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { movieFiles, moviePlays } from '../../db/schema.js';
import type { MatchResult } from '../match.js';
import { isVideoFile, parseVideoPath } from '../parse.js';
import type { MoviesRepo } from '../repo.js';
import type { SyncHook, TitleResolver } from '../sync.js';
import { titleId } from '../types.js';

/** Phase 3's resolver (sync.ts), reused: one definition of name -> title. */
export type { TitleResolver };
type MatchOutcome = MatchResult;

/** One `[RecentsMRL]` entry. `path` is null for anything that is not a `file:///<drive>:/` URL. */
export interface RecentsEntry {
  url: string;
  path: string | null;
  /** Seconds; null when VLC stored 0 or -1 ("opened, position unknown"). */
  positionS: number | null;
}

/** key -> raw value of one `[section]` of a Qt ini file. */
export function iniSection(text: string, section: string): Map<string, string> {
  const out = new Map<string, string>();
  let inside = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[') && line.endsWith(']')) {
      inside = line.slice(1, -1) === section;
      continue;
    }
    if (!inside || line === '' || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out.set(line.slice(0, eq).trim(), line.slice(eq + 1));
  }
  return out;
}

/** A QSettings string list (`a, b, "c, d"`). `@Invalid()` and empty mean no items. Positions are kept. */
export function splitQtList(value: string): string[] {
  const v = value.trim();
  if (v === '' || v.startsWith('@Invalid(')) return [];
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < v.length; i++) {
    const ch = v[i]!;
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (ch === '\\' && quoted && i + 1 < v.length) {
      i += 1;
      cur += v[i]!;
      continue;
    }
    if (ch === ',' && !quoted) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** `file:///C:/Users/a%20b/x.mkv` -> `/mnt/c/Users/a b/x.mkv`; anything else -> null. */
export function fileUrlToWslPath(url: string): string | null {
  const m = /^file:\/\/\/([A-Za-z]):\/(.*)$/.exec(url.trim());
  if (m === null) return null;
  let rest: string;
  try {
    rest = m[2]!.split('/').map((seg) => decodeURIComponent(seg)).join('/');
  } catch {
    return null;
  }
  return `/mnt/${m[1]!.toLowerCase()}/${rest}`;
}

/** `[RecentsMRL]` `list=` (newest first) zipped with `times=` (ms). */
export function parseRecents(iniText: string): RecentsEntry[] {
  const section = iniSection(iniText, 'RecentsMRL');
  const list = splitQtList(section.get('list') ?? '');
  const times = splitQtList(section.get('times') ?? '');
  return list.map((url, i) => {
    const ms = Number(times[i] ?? '');
    return { url, path: fileUrlToWslPath(url), positionS: Number.isFinite(ms) && ms > 0 ? ms / 1000 : null };
  });
}

/** What the parser sees: the path below its library root, else `<parent>/<name>` (year-in-folder still works). */
export function recentsRelPath(abs: string, roots: readonly string[]): string {
  for (const root of roots) {
    const rel = path.posix.relative(root, abs);
    if (rel !== '' && !rel.startsWith('..') && !path.posix.isAbsolute(rel)) return rel;
  }
  return path.posix.join(path.posix.basename(path.posix.dirname(abs)), path.posix.basename(abs));
}

/** Positions closer than this to the file's last play are the same observation (a live play VLC also wrote to the ini). */
export const RECENTS_SAME_POSITION_S = 10;

/** Record an entry only when it says something the file's last play does not. */
export function shouldRecord(last: { positionS: number | null } | null, positionS: number | null): boolean {
  if (last === null) return true;
  if (positionS === null) return false;
  if (last.positionS === null) return true;
  return Math.abs(last.positionS - positionS) > RECENTS_SAME_POSITION_S;
}

export type RecentsRepo = Pick<
  MoviesRepo,
  'findTrackedFile' | 'lastPlay' | 'recordObservation' | 'titleById' | 'upsertTitle' | 'upsertFile'
>;

export interface RecentsFs {
  readFile(p: string): Promise<string>;
  mtime(p: string): Promise<Date>;
  exists(p: string): Promise<boolean>;
}

export const nodeRecentsFs: RecentsFs = {
  readFile: (p) => readFile(p, 'utf8'),
  mtime: async (p) => (await stat(p)).mtime,
  async exists(p) {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  },
};

export interface RecentsHookDeps {
  /** `config.movies.vlc.ini`. */
  iniPath: string;
  /** `config.movies.roots`, for parsing a gone file's name relative to its root. */
  roots: readonly string[];
  host: string;
  repo: RecentsRepo;
  /** Null without TMDB credentials: gone files are then skipped (retried once credentials exist). */
  resolver: TitleResolver | null;
  fs?: RecentsFs;
  log?: (line: string) => void;
}

export interface RecentsReport {
  /** Play observations written. */
  observed: number;
  /** Deleted files created for entries whose file is gone. */
  created: number;
  /** Not files, already handled, same position, or on disk but untracked (the scanner's). */
  skipped: number;
  /** Gone files no title matched. */
  unmatched: number;
  /** Gone files left for the next pass (resolver failed or no credentials). */
  retry: number;
}

type FileRow = typeof movieFiles.$inferSelect;
type PlayRow = typeof moviePlays.$inferSelect;

/**
 * The passive layer: after each sync pass, VLC's `[RecentsMRL]` becomes play observations
 * (R4.4). Never throws into the pass: failures are logged and the entry is retried next pass.
 */
export function recentsSyncHook(deps: RecentsHookDeps): SyncHook & { run(): Promise<RecentsReport> } {
  const fs = deps.fs ?? nodeRecentsFs;
  const log = deps.log ?? ((line: string) => console.log(line));
  /** `<path>\0<position>` already recorded or decided in this process. */
  const handled = new Set<string>();

  async function observe(file: FileRow, last: PlayRow | null, positionS: number | null, durationS: number | null, observedAt: Date): Promise<boolean> {
    if (!shouldRecord(last, positionS)) return false;
    await deps.repo.recordObservation({ fileId: file.id, host: deps.host, positionS, durationS, observedAt });
    return true;
  }

  async function run(): Promise<RecentsReport> {
    const report: RecentsReport = { observed: 0, created: 0, skipped: 0, unmatched: 0, retry: 0 };
    let text: string;
    let mtime: Date;
    try {
      text = await fs.readFile(deps.iniPath);
      mtime = await fs.mtime(deps.iniPath);
    } catch {
      return report; // no ini yet: VLC has never exited on this host
    }
    const entries = parseRecents(text);
    for (const [i, entry] of entries.entries()) {
      if (entry.path === null) {
        report.skipped += 1;
        continue;
      }
      const key = `${entry.path}\u0000${entry.positionS ?? 'unknown'}`;
      if (handled.has(key)) {
        report.skipped += 1;
        continue;
      }
      const observedAt = new Date(mtime.getTime() - i * 1000);
      const name = path.posix.basename(entry.path);
      const known = await deps.repo.findTrackedFile(deps.host, entry.path, name);
      if (known !== null) {
        const last = await deps.repo.lastPlay(known.id);
        if (await observe(known, last, entry.positionS, known.durationS, observedAt)) report.observed += 1;
        else report.skipped += 1;
        handled.add(key);
        continue;
      }
      if (await fs.exists(entry.path)) {
        report.skipped += 1; // on disk but untracked: the scanner registers it (or it is outside the roots)
        continue;
      }
      if (!isVideoFile(name)) {
        handled.add(key);
        report.skipped += 1;
        continue;
      }
      if (deps.resolver === null) {
        report.retry += 1;
        continue;
      }
      const parsed = parseVideoPath(recentsRelPath(entry.path, deps.roots));
      let match: MatchOutcome;
      try {
        match = await deps.resolver.match(parsed);
      } catch (err) {
        log(`[movies] recents: matching ${name} failed, retrying next pass: ${err instanceof Error ? err.message : String(err)}`);
        report.retry += 1;
        continue;
      }
      if (match.kind === 'none') {
        handled.add(key);
        report.unmatched += 1;
        continue;
      }
      const id = titleId(match.tmdbKind, match.tmdbId);
      let title = await deps.repo.titleById(id);
      if (title === null) {
        try {
          await deps.repo.upsertTitle(await deps.resolver.details(match.tmdbKind, match.tmdbId));
        } catch (err) {
          log(`[movies] recents: fetching ${id} failed, retrying next pass: ${err instanceof Error ? err.message : String(err)}`);
          report.retry += 1;
          continue;
        }
        title = await deps.repo.titleById(id);
      }
      // A file only VLC's recents remember: created already deleted under its matched title (Phase 1's upsertFile).
      const { file } = await deps.repo.upsertFile({
        host: deps.host,
        path: entry.path,
        name,
        size: null,
        mtime: null,
        durationS: null,
        season: parsed.season,
        episode: parsed.episode,
        absoluteEpisode: parsed.absoluteEpisode,
        parsed,
        source: 'vlc_recents',
        classification: { status: 'matched', titleId: id },
        seenAt: observedAt,
        deletedAt: observedAt,
      });
      const durationS = match.tmdbKind === 'movie' && title !== null && title.runtimeMin !== null ? title.runtimeMin * 60 : null;
      await observe(file, null, entry.positionS, durationS, observedAt);
      report.created += 1;
      report.observed += 1;
      handled.add(key);
    }
    return report;
  }

  return {
    name: 'vlc-recents',
    run,
    /** Rows written (phase 3 emits `changed('sync')` when a pass's hooks wrote any). Never throws. */
    async afterScan() {
      try {
        const r = await run();
        if (r.observed > 0 || r.retry > 0) {
          log(`[movies] recents: ${r.observed} observation(s), ${r.created} deleted file(s) backfilled, ${r.retry} to retry`);
        }
        return r.observed + r.created;
      } catch (err) {
        log(`[movies] recents pass failed: ${err instanceof Error ? err.message : String(err)}`);
        return 0;
      }
    },
  };
}
