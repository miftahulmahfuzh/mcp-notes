import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { CacheSubtitleView } from '../cachePlay.js';
import type { DirectStreamService } from '../service.js';
import type { SessionTorrent, StreamSession } from '../sessions.js';
import { titleCheckedName, titleKey, type TitleSubtitleShelf } from '../titleSubtitles.js';
import type { TorrentStreams } from '../torrent/service.js';
import type { SubtitleShelf } from '../torrent/subtitles/disk.js';
import { refLabel, type StreamRef } from '../types.js';
import { outsideCandidates, type CandidateServices } from './candidates.js';
import { CHECKED_LABEL, hintAt, hintFromPosition, type CheckResult, type CheckSubject, type PendingCheck, type SubtitleChecker } from './checker.js';

/**
 * What /sync-subtitle checks (checker.ts), built from what the owner named: a live stream session, or a title with
 * none open.
 *
 * - **A torrent** (a session's, or this machine's finished download of the title): the audio is the file itself,
 *   the subtitle is the torrent's chosen one (`.notesd-subs/chosen.json`), and a better one is kept there as
 *   `checked-<file>-<tag>.vtt`, which the next play's `kept` tier answers.
 * - **A cloud stream** (a session's, or the title resolved out of sight as the dialogue reader does): the audio is
 *   the provider's stream, the subtitle is the provider's own English track or the title's outside file, and a
 *   better one is kept per title (titleSubtitles.ts). When it stands in for the provider's own track, the file says
 *   so (`replaces`), and a session of that provider shows it and not the provider's.
 *
 * A live session gets the new subtitle at once: its `subtitleRev` goes up, and the page loads it on its next
 * position report. A Wyzie Synced job still running for the film is stopped first, so it cannot replace the choice.
 */

export type CheckFailure = 'unknown_session' | 'no_audio' | 'check_off';

export class CheckError extends Error {
  override readonly name = 'CheckError';
  constructor(
    readonly code: CheckFailure,
    message: string,
  ) {
    super(message);
  }
}

/** `at`: where the owner says people talk, in seconds of the film (a moment, or a range with `toS`). */
export type CheckTarget = ({ session: string } | { ref: StreamRef; source?: 'torrent' | 'cloud' }) & { at?: { fromS: number; toS: number | null } };

export interface SubjectDeps {
  directStream: Pick<DirectStreamService, 'session' | 'resolve' | 'audioInput' | 'ownSubtitleText'>;
  /** Null with torrents off: only cloud streams are checked. */
  torrents: Pick<TorrentStreams, 'find' | 'filePath' | 'localUrl'> | null;
  torrentShelf: SubtitleShelf | null;
  titleShelf: TitleSubtitleShelf;
  services: CandidateServices;
  /** This daemon's origin as ffmpeg reaches it (`http://127.0.0.1:<port>`). */
  localBase: () => string;
  /** The stream the player page shows now (StreamLive.current), or null. */
  onScreen: () => { sessionId: string; durationS: number | null; positionS?: number | null } | null;
  imdbId: (ref: StreamRef) => Promise<string | null>;
  /** The title's original language (TMDB's code): Whisper transcribes English and translates anything else. */
  audioLang: (ref: StreamRef) => Promise<string | null>;
  titleLabel: (ref: StreamRef) => Promise<string | null>;
  /** Stops a running Wyzie Synced job (`<info hash>-<file index>`, or a title key). */
  cancelSync?: (key: string) => void;
}

const sameRef = (a: StreamRef, b: StreamRef): boolean =>
  a.kind === b.kind && a.tmdbId === b.tmdbId && (a.kind === 'movie' || (b.kind === 'tv' && a.season === b.season && a.episode === b.episode));
const tagOf = (vtt: string): string => createHash('sha1').update(vtt).digest('hex').slice(0, 8);
const fileName = (url: string): string => url.slice(url.lastIndexOf('/') + 1);

export class CheckSubjects {
  constructor(private readonly deps: SubjectDeps) {}

  /** The session the player page shows now with its title, or null. */
  onScreen(): { sessionId: string; ref: StreamRef } | null {
    const on = this.deps.onScreen();
    const session = on === null ? null : this.deps.directStream.session(on.sessionId);
    return on === null || session === null ? null : { sessionId: on.sessionId, ref: session.ref };
  }

  /** Names the check's job without building its subject. */
  keyOf(target: CheckTarget): string {
    if ('session' in target) return 'session-' + target.session;
    const on = this.onScreen();
    if (on !== null && sameRef(on.ref, target.ref)) return 'session-' + on.sessionId;
    return titleKey(target.ref) + '-' + (target.source ?? 'any');
  }

  /** Throws CheckError, or what resolving a cloud title throws (DirectStreamError `no_source`, `resolve_failed`). */
  async build(target: CheckTarget): Promise<CheckSubject> {
    const subject = await this.subjectOf(target);
    // Heard first: the time the owner named, else the minute around where the player on screen is (it is there, and
    // the owner asked while watching it).
    const on = this.deps.onScreen();
    const played = subject.mode === 'live' && on !== null && on.sessionId === subject.sessionId ? (on.positionS ?? null) : null;
    const hint = target.at !== undefined ? hintAt(target.at.fromS, target.at.toS) : played === null ? null : hintFromPosition(played);
    return { ...subject, hint };
  }

  private async subjectOf(target: CheckTarget): Promise<CheckSubject> {
    if ('session' in target) return this.forSession(target.session);
    const on = this.onScreen();
    if (on !== null && sameRef(on.ref, target.ref)) return this.forSession(on.sessionId);
    return this.forTitle(target.ref, target.source ?? null);
  }

  private async label(ref: StreamRef): Promise<string> {
    return (await this.deps.titleLabel(ref).catch(() => null)) ?? refLabel(ref);
  }

  private async forSession(id: string): Promise<CheckSubject> {
    const session = this.deps.directStream.session(id);
    if (session === null) throw new CheckError('unknown_session', 'No live stream session has this id (it ended, or the daemon restarted). Name the title instead.');
    const on = this.deps.onScreen();
    const live = on !== null && on.sessionId === id;
    if (session.torrent !== null) {
      const t = session.torrent;
      return this.torrentSubject(session.ref, { infoHash: t.infoHash, fileIndex: t.fileIndex, release: t.name, durationS: t.durationS }, { torrent: t, sessionId: id, live, audioLang: session.audioLang });
    }
    return this.cloudSubject(session, live, live ? on.durationS : null);
  }

  private async forTitle(ref: StreamRef, source: 'torrent' | 'cloud' | null): Promise<CheckSubject> {
    const { torrents, torrentShelf } = this.deps;
    if (source !== 'cloud' && torrents !== null && torrentShelf !== null) {
      const download = await torrents.find(ref);
      if (download !== null && (await torrents.filePath(download.infoHash, download.fileIndex)) !== null) {
        return this.torrentSubject(ref, { infoHash: download.infoHash, fileIndex: download.fileIndex, release: download.release ?? download.name, durationS: download.durationS }, null);
      }
    }
    if (source === 'torrent') {
      throw new CheckError('no_audio', 'This machine holds no finished torrent download of it, so there is no audio to check a subtitle against. Play it from a torrent first (TM, TS), then check it while it plays.');
    }
    // No session and no download: the title is resolved out of sight, as the dialogue reader does; nothing plays.
    const session = await this.deps.directStream.resolve(ref);
    return this.cloudSubject(session, false, null);
  }

  private async torrentSubject(
    ref: StreamRef,
    file: { infoHash: string; fileIndex: number; release: string; durationS: number | null },
    open: { torrent: SessionTorrent; sessionId: string; live: boolean; audioLang: string | null } | null,
  ): Promise<CheckSubject> {
    const { torrents, torrentShelf: shelf } = this.deps;
    if (torrents === null || shelf === null) throw new CheckError('check_off', 'Torrents are off on this machine.');
    const { infoHash, fileIndex } = file;
    const imdbId = open?.torrent.imdbId ?? (await this.deps.imdbId(ref).catch(() => null));
    return {
      key: infoHash + '-' + fileIndex,
      ref,
      title: await this.label(ref),
      mode: open?.live === true ? 'live' : 'idle',
      source: 'torrent',
      provider: 'Torrent',
      sessionId: open?.sessionId ?? null,
      durationS: file.durationS,
      audioLang: open?.audioLang ?? (await this.deps.audioLang(ref).catch(() => null)),
      input: async () => ({ url: (await torrents.filePath(infoHash, fileIndex)) ?? this.deps.localBase() + torrents.localUrl(infoHash, fileIndex) }),
      current: async () => {
        const view = (open === null ? await shelf.kept(infoHash) : open.torrent.subtitles)[0];
        if (view === undefined) return null;
        const label = view.label || 'a subtitle that names no language';
        if (view.growing === true) return { label, skip: 'it grows while the film plays: the track inside the video file, or a Whisper transcript' };
        const path = shelf.file(infoHash, fileName(view.url));
        try {
          if (path === null) throw new Error('not a kept file');
          return { label, vtt: await readFile(path, 'utf8') };
        } catch {
          return { label, skip: 'its file is not on this machine' };
        }
      },
      candidates: (notes) => outsideCandidates(this.deps.services, { ref, imdbId, release: file.release }, notes),
      keep: async (vtt) => {
        this.deps.cancelSync?.(infoHash + '-' + fileIndex);
        const view = await shelf.save(infoHash, 'checked-' + fileIndex + '-' + tagOf(vtt) + '.vtt', vtt, { lang: 'en', label: CHECKED_LABEL });
        if (open !== null) {
          open.torrent.subtitles = [view];
          open.torrent.subtitleRev += 1;
        }
        return view;
      },
    };
  }

  private async cloudSubject(session: StreamSession, live: boolean, durationS: number | null): Promise<CheckSubject> {
    const { directStream, titleShelf } = this.deps;
    const ref = session.ref;
    const provider = session.source.provider;
    /** The provider's own English track, read once: what the page shows unless a checked file already stands in for it. */
    let own: Promise<{ label: string; vtt: string } | null> | null = null;
    const ownTrack = (): Promise<{ label: string; vtt: string } | null> => (own ??= directStream.ownSubtitleText(session.id).catch(() => null));
    return {
      key: titleKey(ref),
      ref,
      title: await this.label(ref),
      mode: live ? 'live' : 'idle',
      source: 'cloud',
      provider,
      sessionId: session.id,
      durationS,
      audioLang: session.audioLang,
      input: () => directStream.audioInput(session.id),
      current: async () => {
        const mine = await ownTrack();
        if (mine !== null && (await titleShelf.replaces(ref)) !== provider) return mine;
        return titleShelf.text(ref);
      },
      candidates: async function* (this: CheckSubjects, notes: string[]) {
        const imdbId = await this.deps.imdbId(ref).catch(() => null);
        yield* outsideCandidates(this.deps.services, { ref, imdbId, release: '' }, notes);
      }.bind(this),
      keep: async (vtt): Promise<CacheSubtitleView> => {
        this.deps.cancelSync?.(titleKey(ref));
        const view = await titleShelf.save(ref, titleCheckedName(tagOf(vtt)), vtt, CHECKED_LABEL, (await ownTrack()) !== null ? provider : null);
        session.outside.subtitles = [view];
        session.outside.subtitleRev += 1;
        return view;
      },
    };
  }
}

/** What the daemon and the MCP tool hold: the subjects and the checker together. */
export class SubtitleCheckService {
  constructor(
    private readonly subjects: CheckSubjects,
    private readonly checker: SubtitleChecker,
  ) {}

  onScreen(): { sessionId: string; ref: StreamRef } | null {
    return this.subjects.onScreen();
  }

  /** The check of `target`, or `pending` when it outlasts `waitMs` (the same call again joins it). */
  check(target: CheckTarget, waitMs: number): Promise<CheckResult | PendingCheck> {
    return this.checker.within(this.subjects.keyOf(target), () => this.subjects.build(target), waitMs);
  }

  close(): Promise<void> {
    return this.checker.close();
  }
}
