import type { Captions } from './captions';
import type { EngineReady, PlayerEngine } from './engine';
import { codeOf, messageOf, type PlayerHost } from './playerState';
import type { PreviewFrames } from './previewFrames';
import { fetchSession, fetchText, type SessionSubtitle, type StreamSession } from './session';
import { addFeedCue, followCueFeed, isEnglish, pickDefaultSubtitle, toWebVtt, type CueFeedFollower, type SubtitleOption } from './subtitles';

/** How long the film waits for its subtitle files. */
export const SUBTITLE_HOLD_MS = 3_000;

/** The label of a subtitle re-timed to the film's audio: Wyzie Synced's (`English (Wyzie, synced)`), /sync-subtitle's (`English (checked)`). */
export const SYNCED_LABEL = /\b(?:synced|checked)\)\s*$/i;

/** The subtitles part of the controller needs besides the host: the engine, for a subtitle inside the stream. */
export interface SubtitleHost extends PlayerHost {
  engine(): PlayerEngine | null;
  /** The engine has said what the stream holds since it was last attached. */
  engineReady(): boolean;
}

interface FileTrack {
  option: SubtitleOption;
  element: HTMLTrackElement;
  url: string;
  /** A growing subtitle's reader of its feed, once the track has loaded; null for a file. */
  follower: CueFeedFollower | null;
}

/**
 * The subtitle menu and the subtitle files of the session: each file a <track> on the video, in the
 * session's order, held for at most SUBTITLE_HOLD_MS before the film starts; a growing subtitle fed
 * from its cue feed; the default choice (pickDefaultSubtitle) until the viewer picks; and a subtitle
 * the daemon replaced while the film played (followRev).
 */
export class SubtitleTracks {
  private readonly host: SubtitleHost;
  private readonly captions: Captions;
  private readonly previews: PreviewFrames;
  private fileTracks: FileTrack[] = [];
  /** Counts every clearing of the file tracks: a file read for an earlier set is dropped when it arrives. */
  private load = 0;
  /** The session is being read again for a subtitle the daemon replaced. */
  private reading = false;
  /** The viewer chose from the menu since the source last changed: their choice is kept, the default is not applied. */
  chosen = false;

  constructor(host: SubtitleHost, captions: Captions, previews: PreviewFrames) {
    this.host = host;
    this.captions = captions;
    this.previews = previews;
  }

  /**
   * Reads the session's subtitle files, all at once, and holds the film for them at most `holdMs`:
   * a subtitle host that stalls on one file (Fake Profile S02E01: three of 31 took 18 to 20 s each,
   * read one after another) must not keep the picture back. A file that arrives after the hold
   * joins the menu then. `holdMs` null waits for every file and leaves the menu to the caller.
   */
  async loadFiles(session: StreamSession, holdMs: number | null = SUBTITLE_HOLD_MS): Promise<void> {
    const { host } = this;
    const load = this.load;
    let held = true;
    const all = Promise.all(
      [...session.subtitles.entries()].map(async ([index, sub]) => {
        try {
          // A growing subtitle (a cue feed) starts as an empty file; its cues are added as they come.
          // One more try for a file: a stream host that fails once would leave the whole film without the track.
          const vtt = sub.growing === true ? 'WEBVTT\n\n' : toWebVtt(await fetchText(sub.url, host.deps.fetch).catch(() => fetchText(sub.url, host.deps.fetch)));
          // The tracks were cleared meanwhile (another source, a subtitle read anew): this file is of the old set.
          if (host.disposed() || load !== this.load) return;
          const url = host.deps.textUrl(vtt);
          const element = host.video.ownerDocument.createElement('track');
          element.kind = 'subtitles';
          element.label = sub.label;
          if (sub.lang !== null) element.srclang = sub.lang;
          element.src = url;
          const fileTrack: FileTrack = {
            option: { id: `file-${index}`, source: 'file', index, label: sub.label, lang: sub.lang, english: sub.english },
            element,
            url,
            follower: null,
          };
          // In the session's order, whichever file answered first.
          const after = this.fileTracks.findIndex((t) => t.option.index > index);
          if (after === -1) {
            host.video.appendChild(element);
            this.fileTracks.push(fileTrack);
          } else {
            host.video.insertBefore(element, this.fileTracks[after].element);
            this.fileTracks.splice(after, 0, fileTrack);
          }
          if (sub.growing === true) this.followGrowing(fileTrack, sub);
          if (!held) this.addLate();
        } catch (err) {
          if (!host.disposed() && load === this.load) host.note(`subtitle ${sub.label}: ${messageOf(err)}`);
        }
      }),
    );
    if (holdMs === null) {
      await all;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const inTime = await Promise.race([all.then(() => true), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), holdMs)))]);
    clearTimeout(timer);
    held = false;
    if (!inTime && !host.disposed() && load === this.load) host.note(`subtitles: ${this.fileTracks.length} of ${session.subtitles.length} file(s) in after ${holdMs / 1000} s, the rest join as they arrive`);
  }

  /** The menu as it is now: the stream's own subtitles as the menu has them, then the files. */
  private withFiles(): SubtitleOption[] {
    return [...this.host.state().subtitles.filter((o) => o.source === 'manifest'), ...this.fileTracks.map((t) => t.option)];
  }

  /** A subtitle file that arrived after the hold: it joins the menu, and is shown only where the default would have shown it. */
  private addLate(): void {
    if (!this.host.engineReady() || !this.host.onFilm()) return;
    const subtitles = this.withFiles();
    const was = this.host.state().subtitle;
    const subtitle = was !== null || this.chosen ? was : pickDefaultSubtitle(subtitles);
    this.show(subtitles, subtitle);
    this.host.set({ subtitles, subtitle });
  }

  /**
   * A growing subtitle's cues come from its feed, read again every few seconds until it is complete.
   * Chrome empties a <track>'s cues when it first loads its file, and loads it only when the track is
   * first turned on, so the feed is read from then on: at once for the English track shown by default.
   */
  private followGrowing(fileTrack: FileTrack, sub: SessionSubtitle): void {
    const { host } = this;
    fileTrack.element.addEventListener(
      'load',
      () => {
        const track = fileTrack.element.track;
        if (host.disposed() || fileTrack.follower !== null || !this.fileTracks.includes(fileTrack) || !track) return;
        fileTrack.follower = followCueFeed(sub.url, {
          fetch: host.deps.fetch,
          add: (cue) => addFeedCue(track, cue),
          onError: (message) => host.note(`subtitle ${sub.label}: ${message}`),
          onComplete: (count) => host.note(`subtitle ${sub.label}: complete, ${count} cues`),
        });
      },
      { once: true },
    );
  }

  /**
   * Takes every file track off the video. Chrome keeps a cue on the picture when its track is taken
   * away while the film is detached (the last line of episode 787 stayed over the whole of 788), so a
   * track is switched off before it goes. A file still being read for the old set is dropped.
   */
  clear(): void {
    for (const track of this.fileTracks) {
      track.follower?.stop();
      if (track.element.track) track.element.track.mode = 'disabled';
      track.element.remove();
      this.host.deps.revokeTextUrl(track.url);
    }
    this.fileTracks = [];
    this.load += 1;
    if (this.host.state().caption !== '') this.host.set({ caption: '' });
  }

  /**
   * The menu once the engine is ready: the stream's own subtitles, then the files, and the one to show
   * (the viewer's choice while it is still there, else the default).
   */
  choose(ready: EngineReady): { subtitles: SubtitleOption[]; subtitle: string | null } {
    const embedded: SubtitleOption[] = ready.subtitles.map((s) => ({
      id: `manifest-${s.index}`,
      source: 'manifest',
      index: s.index,
      label: s.label,
      lang: s.lang,
      english: isEnglish(s.lang, s.label),
    }));
    const subtitles = [...embedded, ...this.fileTracks.map((t) => t.option)];
    const now = this.host.state().subtitle;
    const keep = this.chosen && (now === null || subtitles.some((o) => o.id === now));
    return { subtitles, subtitle: keep ? now : pickDefaultSubtitle(subtitles) };
  }

  /** The viewer's choice from the menu (null: subtitles off). An id the menu does not hold changes nothing. */
  select(id: string | null): void {
    const { subtitles } = this.host.state();
    if (id !== null && !subtitles.some((o) => o.id === id)) return;
    this.chosen = true;
    this.show(subtitles, id);
    this.host.set({ subtitle: id });
  }

  /** Turns on the chosen subtitle (inside the stream, or a file) and every other off; the caption follows. */
  show(options: readonly SubtitleOption[], id: string | null): void {
    const chosen = options.find((o) => o.id === id) ?? null;
    this.host.engine()?.setEmbeddedSubtitle(chosen !== null && chosen.source === 'manifest' ? chosen.index : null);
    for (const track of this.fileTracks) {
      const on = chosen !== null && chosen.source === 'file' && chosen.index === track.option.index;
      track.element.default = on;
      // jsdom has no TextTrack; a browser always does.
      // `hidden`: the cues run and the caption shows them; Chrome draws nothing.
      if (track.element.track) track.element.track.mode = on ? 'hidden' : 'disabled';
    }
    this.captions.read();
  }

  /**
   * The daemon changed the session's subtitle while the film plays, and the answer to a position report
   * said so: Wyzie Synced re-timed a subtitle that came from outside the stream, or a cloud stream with
   * no English subtitle got one from a subtitle service. The session is read again and its subtitle
   * files loaded anew: the film and its position stay as they are, subtitles the viewer turned off stay
   * off, and a subtitle that arrives where there was none is shown like any English one. A re-timed
   * file sets the owner's G/H delay for the title back to 0, since it was set against the old timing.
   */
  async followRev(asked: string, rev: number): Promise<void> {
    const { host } = this;
    const session = host.session();
    if (host.disposed() || this.reading || session === null || host.sessionId() !== asked || rev === session.subtitleRev || !host.onFilm()) return;
    this.reading = true;
    try {
      const fresh = await fetchSession(asked, host.deps.fetch);
      this.previews.follow(asked, fresh.previewRev);
      if (host.disposed() || host.session() !== session || host.sessionId() !== asked || fresh.subtitleRev === session.subtitleRev) return;
      session.subtitles = fresh.subtitles;
      session.subtitleRev = fresh.subtitleRev;
      this.clear();
      await this.loadFiles(session, null);
      if (host.disposed() || host.session() !== session) return;
      const subtitles = this.withFiles();
      const was = host.state().subtitle;
      const subtitle = was !== null && subtitles.some((o) => o.id === was) ? was : was === null && this.chosen ? null : pickDefaultSubtitle(subtitles);
      this.show(subtitles, subtitle);
      const synced = fresh.subtitles.some((s) => SYNCED_LABEL.test(s.label));
      host.set({ subtitles, subtitle, ...(synced ? { subtitleSyncs: host.state().subtitleSyncs + 1 } : {}) });
      const delay = host.state().subtitleDelayMs;
      if (synced && delay !== 0) this.captions.shift(-delay);
      host.note(`subtitles ${synced ? 'synced' : 'changed'}: ${fresh.subtitles.map((s) => s.label).join(', ') || 'none'}`);
    } catch (err) {
      host.note(`subtitles not reloaded: ${codeOf(err)}`);
    } finally {
      this.reading = false;
    }
  }
}
