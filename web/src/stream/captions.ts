import type { PlayerHost } from './playerState';

/** One press of G or H moves the subtitles this far, as in VLC. */
export const SUBTITLE_DELAY_STEP_MS = 50;
export const SUBTITLE_DELAY_MAX_MS = 60_000;

/** A cue's text as the page shows it: WebVTT's tags (<i>, <c.yellow>, <v Name>, timestamps) taken out, its entities read. */
export function cueText(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_all: string, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n');
}

/** Where a title's subtitle delay is kept between plays. */
export const delayKeyOf = (title: string): string => `notesd-subtitle-delay:${title}`;

/**
 * The caption over the picture and the subtitle delay (G and H). The page draws the caption itself
 * (`state.caption`): every text track is kept `hidden`, so its cues run and Chrome draws nothing.
 * The delay moves every cue of every track from the time its file gave it, and is kept per title.
 */
export class Captions {
  private readonly host: PlayerHost;
  /** Each cue's times as its file gave them, so a delay is always counted from there. */
  private readonly cueTimes = new WeakMap<object, { start: number; end: number; applied: number }>();
  /** How many cues the text tracks held when they were last gone through, and under which delay: nothing new, nothing to do. */
  private cuesTended = { count: -1, delay: 0 };
  /** The text tracks already listened to for `cuechange`. */
  private readonly heardTracks = new WeakSet<object>();

  constructor(host: PlayerHost) {
    this.host = host;
  }

  /**
   * Reads what the subtitles say now into `caption`. A track an engine or the page turned on
   * (`showing`) is set to `hidden`: its cues keep running and Chrome draws nothing. Runs when a
   * track's cues change, when a track is turned on or off, and as the film plays.
   */
  readonly read = (): void => {
    // jsdom has no text tracks; a browser always does.
    const tracks = this.host.video.textTracks as TextTrackList | undefined;
    if (tracks === undefined) return;
    const lines: string[] = [];
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      if (track === undefined || (track.kind !== 'subtitles' && track.kind !== 'captions')) continue;
      if (!this.heardTracks.has(track)) {
        this.heardTracks.add(track);
        track.addEventListener?.('cuechange', this.read);
      }
      if (track.mode === 'showing') track.mode = 'hidden';
      if (track.mode !== 'hidden' || !track.activeCues) continue;
      for (let j = 0; j < track.activeCues.length; j++) {
        const text = cueText((track.activeCues[j] as Partial<VTTCue> | undefined)?.text ?? '');
        if (text !== '' && !lines.includes(text)) lines.push(text);
      }
    }
    const caption = lines.join('\n');
    if (caption !== this.host.state().caption) this.host.set({ caption });
  };

  /**
   * Moves every cue of every text track to its own time plus the delay.
   * Cues arrive late (a file loads, hls.js adds a part), so this runs again as the film plays.
   */
  applyDelay(): void {
    const delay = this.host.state().subtitleDelayMs;
    // jsdom has no text tracks; a browser always does.
    const tracks = this.host.video.textTracks as TextTrackList | undefined;
    if (tracks === undefined) return;
    let count = 0;
    for (let i = 0; i < tracks.length; i++) count += tracks[i]?.cues?.length ?? 0;
    if (count === this.cuesTended.count && delay === this.cuesTended.delay) return;
    this.cuesTended = { count, delay };
    for (let i = 0; i < tracks.length; i++) {
      const cues = tracks[i]?.cues;
      if (!cues) continue;
      for (let j = 0; j < cues.length; j++) {
        const cue = cues[j];
        if (cue === undefined) continue;
        let times = this.cueTimes.get(cue);
        if (times === undefined) {
          if (delay === 0) continue;
          times = { start: cue.startTime, end: cue.endTime, applied: 0 };
          this.cueTimes.set(cue, times);
        }
        if (times.applied === delay) continue;
        const start = Math.max(0, times.start + delay / 1000);
        // Lengthening first keeps start before end whichever way the cue moves.
        cue.endTime = Math.max(cue.endTime, start + 0.001);
        cue.startTime = start;
        cue.endTime = Math.max(start + 0.001, times.end + delay / 1000);
        times.applied = delay;
      }
    }
  }

  /**
   * G and H: the subtitles show `deltaMs` later (positive) or earlier, on top of what was set
   * before. For a subtitle that came from another source than the picture and runs ahead of or
   * behind the voices. Kept per title, so the next play of it starts with the same delay.
   */
  shift(deltaMs: number): void {
    const was = this.host.state().subtitleDelayMs;
    const next = Math.max(-SUBTITLE_DELAY_MAX_MS, Math.min(SUBTITLE_DELAY_MAX_MS, was + deltaMs));
    if (next === was) return;
    this.host.set({ subtitleDelayMs: next });
    this.applyDelay();
    const key = this.delayKey();
    if (key === null) return;
    try {
      if (next === 0) this.host.deps.storage?.removeItem(key);
      else this.host.deps.storage?.setItem(key, String(next));
    } catch {
      // A full or closed storage only means the delay is not remembered.
    }
  }

  /** The delay kept for the session's title, or 0 (nothing kept, or nothing sensible). */
  restoreDelay(): void {
    const key = this.delayKey();
    let kept = 0;
    try {
      kept = Number(key === null ? 0 : (this.host.deps.storage?.getItem(key) ?? 0));
    } catch {
      kept = 0;
    }
    this.host.set({ subtitleDelayMs: Number.isFinite(kept) && Math.abs(kept) <= SUBTITLE_DELAY_MAX_MS ? Math.round(kept) : 0 });
  }

  private delayKey(): string | null {
    const session = this.host.session();
    return session === null ? null : delayKeyOf(session.title);
  }
}
