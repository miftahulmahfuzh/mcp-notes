/** Scroll-to + outline pulse for a wall card, gallery tile or bin card (dedupe hits, deep links). */

export interface FlashOptions {
  /** Wait this long before the first look, so React can render a view/mode switch first. Default 450. */
  delayMs?: number;
  /** When the element is not there yet, keep looking every 50 ms for up to this long. Default 0 (one look). */
  waitMs?: number;
}

const POLL_MS = 50;

const quote = (v: string): string => `"${v.replace(/["\\]/g, '\\$&')}"`;

/** The wall card (NoteCard) or gallery tiles (Gallery) of a live note. */
export function noteSelector(id: string): string {
  return `[data-note=${quote(id)}]`;
}

/** The card of a deleted note in the bin (Bin.tsx `BinCard`). */
export function binNoteSelector(id: string): string {
  return `[data-bin-note=${quote(id)}]`;
}

/** Scroll `el` to the middle of the window and pulse a 1.6 s outline on it. */
export function pulse(el: HTMLElement): void {
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (typeof el.animate !== 'function') return;
  el.animate(
    [
      { outline: '1px solid rgba(236,235,228,.85)', outlineOffset: '3px' },
      { outline: '1px solid rgba(236,235,228,.85)', outlineOffset: '3px', offset: 0.6 },
      { outline: '1px solid rgba(236,235,228,0)', outlineOffset: '3px' },
    ],
    { duration: 1600, easing: 'ease-out' },
  );
}

/** Pulse the first element matching `selector` after `delayMs`, waiting up to `waitMs` for it. Returns a cancel function. */
export function flashSelector(selector: string, { delayMs = 450, waitMs = 0 }: FlashOptions = {}): () => void {
  let timer: number | undefined;
  let cancelled = false;
  let tries = Math.max(0, Math.ceil(waitMs / POLL_MS));
  const look = (): void => {
    if (cancelled) return;
    const el = document.querySelector<HTMLElement>(selector);
    if (el) {
      pulse(el);
      return;
    }
    if (tries <= 0) return;
    tries -= 1;
    timer = window.setTimeout(look, POLL_MS);
  };
  timer = window.setTimeout(look, delayMs);
  return () => {
    cancelled = true;
    window.clearTimeout(timer);
  };
}

/** Scroll the card (or gallery tile) of `id` into view and pulse an outline on it. Returns a cancel function. */
export function flashNote(id: string, delayMs = 450): () => void {
  return flashSelector(noteSelector(id), { delayMs });
}
