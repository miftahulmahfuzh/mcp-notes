import type { PlayerHost } from './playerState';
import { fetchPreviews, NO_PREVIEWS } from './session';

/**
 * The session's seek-preview frames, read into `state.previews` when the daemon says they changed
 * (its `preview_rev`, from the session or a position answer). Never on a timer.
 */
export class PreviewFrames {
  private readonly host: PlayerHost;
  /** The session `state.previews` belongs to (or is being read for); null: none yet, the next session reads its own. */
  private of: string | null = null;
  /** The highest `preview_rev` asked for that session; -1 before the first read. */
  private revAsked = -1;
  /** The session whose previews are being read now: one read at a time per session. */
  private reading: string | null = null;

  constructor(host: PlayerHost) {
    this.host = host;
  }

  /** The page plays another session: its frames are read afresh by the next follow(). */
  forget(): void {
    this.of = null;
  }

  /**
   * Reads the session's seek-preview frames when `rev` is higher than the one asked for, or none was
   * read yet for this session. One read at a time per session; a higher rev that arrives meanwhile is
   * read when it ends. A new session starts from no frames.
   */
  follow(asked: string, rev: number): void {
    if (this.host.disposed() || this.host.sessionId() !== asked) return;
    if (this.of !== asked) {
      this.of = asked;
      this.revAsked = -1;
      if (this.host.state().previews !== NO_PREVIEWS) this.host.set({ previews: NO_PREVIEWS });
    }
    if (rev <= this.revAsked) return;
    this.revAsked = rev;
    if (this.reading === asked) return;
    void this.read(asked);
  }

  /** The read itself: a failed one keeps the frames the page had and says nothing (that rev is not asked again; a higher one is). */
  private async read(asked: string): Promise<void> {
    this.reading = asked;
    try {
      for (;;) {
        const wanted = this.revAsked;
        const got = await fetchPreviews(asked, this.host.deps.fetch);
        if (this.host.disposed() || this.host.sessionId() !== asked || this.of !== asked) return;
        let reached = wanted;
        if (got !== null) {
          reached = Math.max(wanted, got.rev);
          this.revAsked = Math.max(this.revAsked, got.rev);
          const was = this.host.state().previews;
          this.host.set({ previews: got });
          if (got.cues.length !== was.cues.length || got.state !== was.state) {
            const n = got.cues.length;
            this.host.note(`previews: ${got.state}, ${n} ${n === 1 ? 'frame' : 'frames'} (${got.source ?? 'none'}, rev ${got.rev})`);
          }
        }
        if (this.revAsked <= reached) return;
      }
    } finally {
      if (this.reading === asked) this.reading = null;
    }
  }
}
