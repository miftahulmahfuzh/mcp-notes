import type { TorrentCandidate } from '../find/index.js';

/** Small helpers the torrent source's modules share for log lines, attempts and timers. None of them reads state. */

export const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/** Seconds from `from` to `to` (ms), to one decimal. */
export const seconds = (from: number, to: number): number => Math.round((to - from) / 100) / 10;
export const pad = (n: number): string => String(n).padStart(2, '0');
export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
export const mbps = (kbps: number): string => (kbps / 1000).toFixed(1);

/** A timer as a promise, with a way to clear it (so a race that ended first leaves no timer behind). */
export function sleep(ms: number): { done: Promise<void>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, ms));
  });
  return { done, clear: () => clearTimeout(timer) };
}

/** Where the torrent that plays was found, for its log line: `from torrentio`, `from knaben, also listed by apibay`. */
export function foundIn(c: Pick<TorrentCandidate, 'index' | 'listedBy'> | null): string {
  if (c === null) return '';
  const others = (c.listedBy ?? []).filter((name) => name !== c.index);
  return ` (from ${c.index}${others.length === 0 ? '' : `, also listed by ${others.join(', ')}`})`;
}
