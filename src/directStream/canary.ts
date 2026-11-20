import type { ResolveOutput, StreamRef } from './types.js';
import type { KnownTitle } from './updateSource.js';

/**
 * The daily stream canary. A few minutes after start, then once a day, every cloud provider in the registry is
 * asked for one known film (`resolve --only <provider>`, an out-of-sight tab, no sound, no play), so each
 * provider's health on this host stays current even when nothing was played through it. That is all it does: it
 * writes stream_provider_health through DirectStreamService.runResolve, never a stream source, a title or a play,
 * and a failure marks no title stale. Nothing is asked while something plays or is being started; the pass then
 * waits an hour. A provider keyed by AniList id (anime only) or one that plays only in a browser is not asked.
 * `NOTESD_STREAM_CANARY=off` (or direct streaming off) is a DisabledCanary: nothing is asked.
 */

export const CANARY_INITIAL_DELAY_MS = 5 * 60_000;
export const CANARY_EVERY_MS = 24 * 60 * 60_000;
/** After a pass cut short by a play, the rest is asked this much later. */
export const CANARY_BUSY_RETRY_MS = 60 * 60_000;
/** One provider's ask; a real play that starts meanwhile waits behind at most this (resolves run one at a time). */
export const CANARY_DEADLINE_S = 60;
const CLOSE_GRACE_MS = 5_000;

export interface CanaryProvider {
  name: string;
  idKind: string;
  browserOnly: boolean;
}

export interface CanaryPass {
  started_at: string;
  finished_at: string | null;
  asked: number;
  resolved: number;
  /** Providers left for the next try (a play started). */
  left: number;
  stopped: 'done' | 'busy' | 'closed' | 'error';
  error: string | null;
}

export interface CanaryHandle {
  readonly enabled: boolean;
  startLine(): string;
  start(): void;
  close(): Promise<void>;
}

export class DisabledCanary implements CanaryHandle {
  readonly enabled = false;
  constructor(readonly reason: 'setting_off' | 'direct_stream_off') {}
  startLine(): string {
    return `[notesd] stream canary off: ${this.reason === 'setting_off' ? 'NOTESD_STREAM_CANARY=off' : 'direct streaming is off'}`;
  }
  start(): void {}
  async close(): Promise<void> {}
}

export interface StreamCanaryOptions {
  providers: () => Promise<CanaryProvider[]>;
  knownTitles: () => Promise<KnownTitle[]>;
  /** DirectStreamService.runResolve: records health, writes nothing else. */
  resolve: (ref: StreamRef, options: { only: string; deadlineS: number }) => Promise<ResolveOutput>;
  /** True while a VLC play, a stream on screen or a stream being started exists. */
  busy: () => boolean;
  initialDelayMs?: number;
  everyMs?: number;
  busyRetryMs?: number;
  log?: (line: string) => void;
  now?: () => Date;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The providers a canary asks: cloud providers keyed by TMDB or IMDb id that a script can resolve. */
export function canaryProviders(all: readonly CanaryProvider[]): string[] {
  return all.filter((p) => p.idKind !== 'anilist' && !p.browserOnly).map((p) => p.name);
}

export class StreamCanary implements CanaryHandle {
  readonly enabled = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<CanaryPass> | null = null;
  private closed = false;
  private readonly log: (line: string) => void;
  private readonly now: () => Date;

  constructor(private readonly o: StreamCanaryOptions) {
    this.log = o.log ?? ((line: string) => console.log(line));
    this.now = o.now ?? (() => new Date());
  }

  startLine(): string {
    return '[notesd] stream canary on: every cloud provider is asked for one known film a few minutes after start and once a day, while nothing plays';
  }

  start(): void {
    this.schedule(this.o.initialDelayMs ?? CANARY_INITIAL_DELAY_MS);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const running = this.running;
    if (running !== null) await Promise.race([running.catch(() => undefined), new Promise((r) => setTimeout(r, CLOSE_GRACE_MS).unref())]);
  }

  private schedule(ms: number): void {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pass().then((p) => this.schedule(p.stopped === 'busy' ? (this.o.busyRetryMs ?? CANARY_BUSY_RETRY_MS) : (this.o.everyMs ?? CANARY_EVERY_MS)));
    }, ms);
    this.timer.unref();
  }

  /** One pass over every provider. Never rejects. */
  pass(): Promise<CanaryPass> {
    if (this.running !== null) return this.running;
    const run = this.run().finally(() => {
      this.running = null;
    });
    this.running = run;
    return run;
  }

  private async run(): Promise<CanaryPass> {
    const p: CanaryPass = { started_at: this.now().toISOString(), finished_at: null, asked: 0, resolved: 0, left: 0, stopped: 'done', error: null };
    try {
      const [title] = (await this.o.knownTitles()).filter((t) => t.ref.kind === 'movie');
      if (title === undefined) throw new Error('no known film to ask for');
      const names = canaryProviders(await this.o.providers());
      for (const [i, name] of names.entries()) {
        if (this.closed || this.o.busy()) {
          p.stopped = this.closed ? 'closed' : 'busy';
          p.left = names.length - i;
          break;
        }
        p.asked += 1;
        try {
          const out = await this.o.resolve(title.ref, { only: name, deadlineS: CANARY_DEADLINE_S });
          if (out.ok) p.resolved += 1;
        } catch (err) {
          this.log(`[notesd] stream canary: ${name}: ${messageOf(err)}`);
        }
      }
    } catch (err) {
      p.stopped = 'error';
      p.error = messageOf(err);
    }
    p.finished_at = this.now().toISOString();
    this.log(
      `[notesd] stream canary: ${p.resolved} of ${p.asked} providers resolved; ${p.stopped}` +
        (p.left > 0 ? ` (${p.left} left for later)` : '') +
        (p.error === null ? '' : ` (${p.error})`),
    );
    return p;
  }
}
