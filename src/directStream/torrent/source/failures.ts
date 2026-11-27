import type { StreamRef } from '../../types.js';
import { FILE_FAILURE_KEEP_MS, SWARM_FAILURE_KEEP_MS } from './constants.js';
import { refKey } from './query.js';

/** One torrent left out of a film's or episode's plays: until when, whether the failure was the file's, and why. */
export interface Failure {
  until: number;
  lasting: boolean;
  why: string | null;
}

/**
 * Per film or episode, the torrents that were tried and did not play, in memory (one per daemon run): the info hash,
 * until when it is left out, and whether the failure was the file's (`lasting`: a dub, the wrong files, kept
 * FILE_FAILURE_KEEP_MS) or the swarm's (kept SWARM_FAILURE_KEEP_MS). Asking again then tries the next candidates
 * instead of the same ones. Keyed by refKey.
 */
export class FailureMemory {
  private readonly failed = new Map<string, Map<string, Failure>>();

  constructor(private readonly now: () => number) {}

  /** The torrents of `key` still left out, by info hash (true: the failure was the file's). Expired ones are dropped. */
  remembered(key: string): Map<string, boolean> {
    const kept = new Map<string, boolean>();
    const entries = this.failed.get(key);
    if (entries === undefined) return kept;
    const now = this.now();
    for (const [hash, entry] of entries) {
      if (entry.until <= now) entries.delete(hash);
      else kept.set(hash, entry.lasting);
    }
    if (entries.size === 0) this.failed.delete(key);
    return kept;
  }

  remember(key: string, infoHash: string, lasting: boolean, why: string | null = null): void {
    const entries = this.failed.get(key) ?? new Map<string, Failure>();
    const hash = infoHash.toLowerCase();
    // A file's failure (a dub) is never shortened to a swarm's by a later stall of the same torrent.
    const before = entries.get(hash);
    if (before !== undefined && before.lasting && !lasting && before.until > this.now()) return;
    entries.set(hash, { until: this.now() + (lasting ? FILE_FAILURE_KEEP_MS : SWARM_FAILURE_KEEP_MS), lasting, why: why ?? before?.why ?? null });
    this.failed.set(key, entries);
  }

  /** Forgets the torrents of `key` whose swarm did not deliver (a file's failure stays); true when any was forgotten. */
  forgetSwarmFailures(key: string): boolean {
    const entries = this.failed.get(key);
    if (entries === undefined) return false;
    let any = false;
    for (const [hash, entry] of entries) {
      if (entry.lasting) continue;
      entries.delete(hash);
      any = true;
    }
    return any;
  }

  /**
   * Why a torrent of `key` failed, for the candidates list, or null. Read as stored: an expired entry still says why
   * until `remembered` drops it (as the candidates list always read it).
   */
  whyOf(key: string): (infoHash: string) => string | null {
    const failures = this.failed.get(key) ?? new Map<string, Failure>();
    return (hash) => failures.get(hash)?.why ?? null;
  }

  /** A session's torrent kept stalling while it played: left out like a swarm that did not deliver. */
  noteStalled(ref: StreamRef, infoHash: string): void {
    this.remember(refKey(ref), infoHash, false);
  }

  /** A torrent heard as a dub of this title: left out like a file that will not change. */
  noteDubbed(ref: StreamRef, infoHash: string, why: string | null = null): void {
    this.remember(refKey(ref), infoHash, true, why === null ? 'dubbed: heard' : `dubbed: ${why}`);
  }
}
