import path from 'node:path';
import type { CacheSubtitleView } from './cachePlay.js';
import { TITLE_OUTSIDE_NAME, TITLE_SYNCED_NAME, titleKey, type TitleSubtitleShelf } from './titleSubtitles.js';
import { findOutsideSubtitle, type OutsideServices } from './torrent/subtitles/service.js';
import { SYNCED_LABEL, SYNC_DIR, wantsSync, type SubtitleSync, type SyncInput, type SyncTarget } from './torrent/subtitles/synced.js';
import { withoutSecrets } from './torrent/subtitles/wyzie.js';
import { isEnglish, refLabel, type StreamRef } from './types.js';

/**
 * An English subtitle for a cloud stream that has none (WYZIE_SYNCED_BRIEF, addendum). When a session's source (a
 * provider's stream, or this machine's stream cache of one) names no English track, the subtitle services the
 * torrent `service` tier asks are asked for the title: Wyzie Subs first with a key, then the OpenSubtitles add-on
 * by IMDb id. The file is kept per title on this machine (titleSubtitles.ts) and shown by every later session of
 * the title here. It never holds up a play for longer than OUTSIDE_WAIT_MS: a slower answer arrives behind the
 * play and bumps the session's `subtitleRev`, which the open page reads in the answer to its position reports.
 *
 * Such a file is timed for some release, seldom the provider's cut, so Wyzie Synced (synced.ts) re-times it against
 * the stream's own audio in the background, once per title and machine; a sync that fails leaves the file as it is.
 */

/** A play waits this long for the subtitle services (Wyzie's search took about 1 s); then it goes on without. */
export const OUTSIDE_WAIT_MS = 4_000;
/** A title the services had nothing for is not asked about again for this long. */
export const OUTSIDE_EMPTY_MS = 6 * 60 * 60_000;
/** After a service failed to answer, the title is asked about again no sooner than this. */
export const OUTSIDE_RETRY_MS = 5 * 60_000;

export const OUTSIDE_LABELS = { wyzie: 'English (Wyzie)', opensubtitles: 'English (OpenSubtitles)' } as const;

/** The part of a stream session this module fills. */
export interface OutsideSession {
  ref: StreamRef;
  /** `subtitles`: the outside file, [] while there is none; `subtitleRev`: counts the times it changed after the session was first read. */
  outside: SyncTarget & { stop: AbortController };
}

/**
 * True when the page has an English subtitle to show by default: an English track, or a source's one subtitle that
 * names no language (no tag, and a label that is empty or just "Subtitle"), which the page shows like one.
 */
export function showsEnglish(tracks: ReadonlyArray<{ lang: string | null; label: string }>): boolean {
  if (tracks.some((t) => isEnglish(t))) return true;
  const only = tracks.length === 1 ? tracks[0] : undefined;
  return only !== undefined && (only.lang ?? '').trim() === '' && /^(subtitle)?$/i.test(only.label.trim());
}

export interface OutsideSubtitlesOptions {
  shelf: TitleSubtitleShelf;
  /** The subtitle services; null: none may be asked (kept files are still shown). */
  services: OutsideServices | null;
  /** Wyzie Synced; null: the file is shown as the service gave it. */
  sync: Pick<SubtitleSync, 'start'> | null;
  /** The title's IMDb id (the add-on is asked by it); null: unknown. */
  imdbId: (ref: StreamRef) => Promise<string | null>;
  waitMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

const messageOf = (err: unknown): string => withoutSecrets(err instanceof Error ? err.message : String(err));

export class OutsideSubtitles {
  /** One ask per title at a time, shared by every session of it. */
  private readonly asking = new Map<string, Promise<CacheSubtitleView | null>>();
  /** Titles not asked about before this time (ms): the services had nothing, or did not answer. */
  private readonly quiet = new Map<string, number>();
  /** Sessions that wait for an ask that outlasted their inline wait. */
  private readonly waiting = new WeakSet<OutsideSession>();
  /** Sessions whose sync was started (or found done). */
  private readonly synced = new WeakSet<OutsideSession>();
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: OutsideSubtitlesOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((line: string) => console.log(line));
  }

  /**
   * Gives a session with no English subtitle the title's outside one: the kept file at once, else the services'
   * within `waitMs`, else later (with `subtitleRev` bumped). `input` says what ffmpeg reads the session's audio
   * from, for the sync. Never throws.
   */
  async attach(session: OutsideSession, input: () => SyncInput): Promise<void> {
    try {
      if (session.outside.subtitles.length === 0) {
        const kept = await this.opts.shelf.kept(session.ref);
        if (kept !== null) session.outside.subtitles = [kept];
      }
      if (session.outside.subtitles.length === 0) {
        if (this.waiting.has(session)) return;
        const ask = this.ask(session.ref);
        if (ask === null) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<'late'>((resolve) => {
          timer = setTimeout(() => resolve('late'), this.opts.waitMs ?? OUTSIDE_WAIT_MS);
        });
        const got = await Promise.race([ask, late]).finally(() => clearTimeout(timer));
        if (got === 'late') {
          this.waiting.add(session);
          void ask.then((view) => {
            this.waiting.delete(session);
            if (view === null || session.outside.subtitles.length > 0 || session.outside.stop.signal.aborted) return;
            session.outside.subtitles = [view];
            session.outside.subtitleRev += 1;
            this.startSync(session, input);
          });
          return;
        }
        if (got === null) return;
        session.outside.subtitles = [got];
      }
      this.startSync(session, input);
    } catch (err) {
      this.log(`[notesd] direct stream: no outside subtitle for ${refLabel(session.ref)}: ${messageOf(err)}`);
    }
  }

  /** The text of the title's outside subtitle for its dialogue: the kept file, else asked for now. Null: there is none. Never throws. */
  async text(ref: StreamRef): Promise<{ label: string; vtt: string } | null> {
    try {
      const kept = await this.opts.shelf.text(ref);
      if (kept !== null) return kept;
      const ask = this.ask(ref);
      return ask === null || (await ask) === null ? null : await this.opts.shelf.text(ref);
    } catch {
      return null;
    }
  }

  /** The running ask for the title, a new one, or null when the services may not be asked (none, or the title is quiet). Never rejects. */
  private ask(ref: StreamRef): Promise<CacheSubtitleView | null> | null {
    const services = this.opts.services;
    if (services === null || (services.baseUrl === null && (services.wyzie ?? null) === null)) return null;
    const key = titleKey(ref);
    const running = this.asking.get(key);
    if (running !== undefined) return running;
    if ((this.quiet.get(key) ?? 0) > this.now()) return null;
    const ask = (async (): Promise<CacheSubtitleView | null> => {
      try {
        const imdbId = await this.opts.imdbId(ref).catch(() => null);
        const got = await findOutsideSubtitle(services, { ref, imdbId, release: '', tag: refLabel(ref) });
        if (got === null) {
          this.quiet.set(key, this.now() + OUTSIDE_EMPTY_MS);
          this.log(`[notesd] direct stream: the subtitle services have no English subtitle for ${refLabel(ref)}`);
          return null;
        }
        const view = await this.opts.shelf.save(ref, TITLE_OUTSIDE_NAME, got.vtt, OUTSIDE_LABELS[got.from]);
        this.log(`[notesd] direct stream: ${refLabel(ref)} has no English subtitle in its stream; kept ${view.label} for it`);
        return view;
      } catch (err) {
        this.quiet.set(key, this.now() + OUTSIDE_RETRY_MS);
        this.log(`[notesd] direct stream: the subtitle services did not answer for ${refLabel(ref)}: ${messageOf(err)}`);
        return null;
      } finally {
        this.asking.delete(key);
      }
    })();
    this.asking.set(key, ask);
    return ask;
  }

  /** Wyzie Synced for the session's outside file, once per session; the job itself runs once per title and machine. */
  private startSync(session: OutsideSession, input: () => SyncInput): void {
    const sync = this.opts.sync;
    if (sync === null || this.synced.has(session) || !wantsSync(session.outside.subtitles)) return;
    this.synced.add(session);
    const key = titleKey(session.ref);
    const dir = this.opts.shelf.dir(key);
    void this.opts
      .imdbId(session.ref)
      .catch(() => null)
      .then((imdbId) =>
        sync.start({
          ref: session.ref,
          imdbId,
          key,
          durationS: null,
          signal: session.outside.stop.signal,
          target: session.outside,
          place: {
            outcomeFile: path.join(dir, 'synced.json'),
            workDir: path.join(dir, SYNC_DIR),
            input,
            save: (vtt) => this.opts.shelf.save(session.ref, TITLE_SYNCED_NAME, vtt, SYNCED_LABEL),
          },
        }),
      );
  }
}
