import type { SheetBuilder } from './builder.js';
import { planSheets, type SheetSpec } from './plan.js';
import { addSheet } from './sheetIndex.js';
import type { LocalVideo } from './types.js';

/** Tries of one sheet in one daemon run: the first and two more. */
export const PREVIEW_MAX_TRIES = 3;
/** A failed sheet is tried again this long after. */
export const PREVIEW_RETRY_MS = 20_000;

interface Job {
  video: LocalVideo;
  sheet: SheetSpec;
  /** Not before this time (ms): a failed sheet waits PREVIEW_RETRY_MS. */
  dueAt: number;
}

const jobId = (key: string, index: number): string => `${key}#${index}`;
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface PreviewQueueOptions {
  builder: SheetBuilder;
  /** A sheet of `video` was made and recorded. */
  onMade: (video: LocalVideo) => void;
  now?: () => number;
  log?: (line: string) => void;
  retryMs?: number;
  maxTries?: number;
}

export class PreviewQueue {
  private jobs: Job[] = [];
  private running: { id: string; abort: AbortController; done: Promise<void> } | null = null;
  private readonly tries = new Map<string, number>();
  private focusKey: string | null = null;
  private noFfmpeg = false;
  private closed = false;
  private wake: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: PreviewQueueOptions) {}

  /**
   * Queues the sheets of `video` that are not queued, running or out of tries. `front`: `video` is the session on
   * screen's, whose jobs go before every other. Answers how many were added (0 once ffmpeg was found missing).
   */
  want(video: LocalVideo, sheets: readonly SheetSpec[], front: boolean): number {
    if (this.closed || this.noFfmpeg) return 0;
    if (front) this.focusKey = video.key;
    let added = 0;
    for (const sheet of sheets) {
      const id = jobId(video.key, sheet.index);
      if ((this.tries.get(id) ?? 0) >= this.maxTries) continue;
      if (this.running?.id === id || this.jobs.some((j) => jobId(j.video.key, j.sheet.index) === id)) continue;
      this.jobs.push({ video, sheet, dueAt: 0 });
      added += 1;
    }
    this.pump();
    return added;
  }

  /** Stops the running ffmpeg (no part of its sheet is kept), drops the rest and waits. */
  async close(): Promise<void> {
    this.closed = true;
    this.jobs = [];
    if (this.wake !== null) clearTimeout(this.wake);
    this.wake = null;
    const running = this.running;
    running?.abort.abort();
    await running?.done;
  }

  private get maxTries(): number {
    return this.opts.maxTries ?? PREVIEW_MAX_TRIES;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private log(line: string): void {
    (this.opts.log ?? ((l: string) => console.log(l)))(line);
  }

  private pump(): void {
    if (this.closed || this.noFfmpeg || this.running !== null) return;
    const now = this.now();
    const due = this.jobs.filter((j) => j.dueAt <= now);
    const next = due.find((j) => j.video.key === this.focusKey) ?? due[0];
    if (next === undefined) {
      this.armWake();
      return;
    }
    this.jobs = this.jobs.filter((j) => j !== next);
    const abort = new AbortController();
    const done = this.run(next, abort.signal)
      .catch((err: unknown) => this.log(`[notesd] previews: ${next.sheet.name} of ${next.video.key}: ${messageOf(err)}`))
      .finally(() => {
        this.running = null;
        this.pump();
      });
    this.running = { id: jobId(next.video.key, next.sheet.index), abort, done };
  }

  /** Wakes the queue when the earliest waiting retry is due. */
  private armWake(): void {
    if (this.wake !== null || this.jobs.length === 0 || this.closed) return;
    const at = Math.min(...this.jobs.map((j) => j.dueAt));
    this.wake = setTimeout(() => {
      this.wake = null;
      this.pump();
    }, Math.max(0, at - this.now()));
    this.wake.unref();
  }

  private async run(job: Job, signal: AbortSignal): Promise<void> {
    const { video, sheet } = job;
    const id = jobId(video.key, sheet.index);
    const label = `sheet ${sheet.index + 1}/${planSheets(video.durationS).length} of ${video.key}`;
    const outcome = await this.opts.builder.build(video, sheet, signal);
    switch (outcome.kind) {
      case 'made':
        try {
          await addSheet(video, outcome.record);
        } catch (err) {
          this.failed(job, label, `the index could not be written: ${messageOf(err)}`);
          return;
        }
        this.tries.delete(id);
        this.log(`[notesd] previews: made ${label} in ${(outcome.tookMs / 1000).toFixed(1)} s (nice ${outcome.nice ?? '?'})`);
        this.opts.onMade(video);
        return;
      case 'failed':
        this.failed(job, label, outcome.detail);
        return;
      case 'no_ffmpeg':
        this.noFfmpeg = true;
        this.jobs = [];
        this.log(`[notesd] previews: ffmpeg (${this.opts.builder.ffmpegBin}) was not found, so no seek previews are made until the daemon restarts`);
        return;
      case 'not_yet':
      case 'aborted':
        // Not yet: the next look at the session (or the next sweep) asks again. Aborted: the daemon is stopping.
        return;
    }
  }

  private failed(job: Job, label: string, detail: string): void {
    const id = jobId(job.video.key, job.sheet.index);
    const count = (this.tries.get(id) ?? 0) + 1;
    this.tries.set(id, count);
    if (count >= this.maxTries) {
      this.log(`[notesd] previews: giving up on ${label} after ${count} tries (${detail}); the play is not affected`);
      return;
    }
    const retryMs = this.opts.retryMs ?? PREVIEW_RETRY_MS;
    this.log(`[notesd] previews: ${label} failed (${detail}); trying again in ${Math.round(retryMs / 1000)} s`);
    this.jobs.push({ video: job.video, sheet: job.sheet, dueAt: this.now() + retryMs });
  }
}
