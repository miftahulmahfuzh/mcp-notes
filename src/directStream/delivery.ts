import type { EvidenceRecord } from './evidence.js';

/**
 * How a provider's stream host delivered the last time something played from it on this machine,
 * read from the stream evidence log (evidence.ts) and never stored. A resolve says a provider
 * names a stream; only a play says whether the host then hands the segments over. A run is one
 * session's time on one provider: its media requests through the pass-through and the player's
 * stall lines. The newest run long enough to judge gives the provider's verdict, so a host that
 * got better is seen as soon as something plays from it again.
 */

/** Runs older than this say nothing: a host that refused segments last week may be fine today. */
export const DELIVERY_WINDOW_MS = 3 * 24 * 3_600_000;
/** Fewer media requests than this, and the share that failed is not judged. */
export const DELIVERY_MIN_REQUESTS = 12;
/** A run is bad when this share of its media requests failed (One Piece 787 on HyperLink: 0.75). */
export const DELIVERY_BAD_FAILED_SHARE = 0.25;
/** ... or when the player stalled this often, and at least this many times per ten minutes. */
export const DELIVERY_BAD_STALLS = 3;
export const DELIVERY_BAD_STALLS_PER_10_MIN = 2;
/** A stall rate is counted over at least this long, so three stalls in a row are not "180 per ten minutes". */
const MIN_SPAN_MS = 60_000;

export type DeliveryVerdict = 'good' | 'bad';

export interface Delivery {
  verdict: DeliveryVerdict;
  /** When the run that gave the verdict last asked for something. */
  at: string;
  session: string;
  /** Media requests of the run, and how many the host refused or never answered. */
  requests: number;
  failed: number;
  /** The player's stall and recovery lines during the run. */
  stalls: number;
  /** Median speed of the answered media requests; null when none carried a body. */
  median_kbps: number | null;
}

/** The player's lines that say the film stopped for want of data (controller.ts writes both). */
const STALL_LINE = /^(stalled|recovering) /;

interface Run {
  session: string;
  provider: string;
  first: number;
  last: number;
  requests: number;
  failed: number;
  stalls: number;
  kbps: number[];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? hi : Math.round(((sorted[mid - 1] ?? hi) + hi) / 2);
}

/** A run's verdict, or null when it is too short to say. */
export function verdictOf(run: { requests: number; failed: number; stalls: number; spanMs: number }): DeliveryVerdict | null {
  const judged = run.requests >= DELIVERY_MIN_REQUESTS;
  if (judged && run.failed / run.requests >= DELIVERY_BAD_FAILED_SHARE) return 'bad';
  const per10Min = run.stalls / (Math.max(run.spanMs, MIN_SPAN_MS) / 600_000);
  if (run.stalls >= DELIVERY_BAD_STALLS && per10Min >= DELIVERY_BAD_STALLS_PER_10_MIN) return 'bad';
  return judged ? 'good' : null;
}

/**
 * Each provider's delivery from the log's records (oldest first, as readTail gives them). A request
 * the player gave up (`aborted`: a seek, a quality change) or notesd refused itself is not the
 * host's doing and is left out. A player line belongs to the provider the session last asked.
 */
export function deliveryByProvider(records: readonly EvidenceRecord[], now: number): Map<string, Delivery> {
  const runs = new Map<string, Run>();
  const current = new Map<string, Run>();
  const since = now - DELIVERY_WINDOW_MS;
  for (const r of records) {
    const at = Date.parse(r.at);
    if (Number.isNaN(at) || at < since) continue;
    if (r.type === 'request') {
      if (r.provider === null || r.kind !== 'media' || r.outcome === 'aborted' || r.outcome === 'refused') continue;
      const key = `${r.session}\n${r.provider}`;
      let run = runs.get(key);
      if (run === undefined) {
        run = { session: r.session, provider: r.provider, first: at, last: at, requests: 0, failed: 0, stalls: 0, kbps: [] };
        runs.set(key, run);
      }
      current.set(r.session, run);
      run.last = Math.max(run.last, at);
      run.requests += 1;
      if (r.status === null || r.status >= 400) run.failed += 1;
      else if (r.kbps !== null && r.kbps > 0) run.kbps.push(r.kbps);
    } else if (r.type === 'player' && STALL_LINE.test(r.text)) {
      const run = current.get(r.session);
      if (run === undefined) continue;
      run.stalls += 1;
      run.last = Math.max(run.last, at);
    }
  }
  const out = new Map<string, Delivery>();
  for (const run of [...runs.values()].sort((a, b) => a.last - b.last)) {
    const verdict = verdictOf({ ...run, spanMs: run.last - run.first });
    if (verdict === null) continue;
    out.set(run.provider, {
      verdict,
      at: new Date(run.last).toISOString(),
      session: run.session,
      requests: run.requests,
      failed: run.failed,
      stalls: run.stalls,
      median_kbps: median(run.kbps),
    });
  }
  return out;
}
