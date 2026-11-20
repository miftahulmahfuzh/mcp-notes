import type { PreviewCue } from './session';

/** The range thumb's width (stream.css `.st-seek::-webkit-slider-thumb`): its centre runs from half of it in from each end. */
export const SEEK_THUMB_PX = 11;
/** How wide the box draws a frame: the daemon's own frames are 240 px, so they show pixel for pixel. */
export const PREVIEW_WIDTH_PX = 240;
/** The box with the time alone (stream.css `.st-preview-time` min-width). */
export const TIME_ONLY_WIDTH_PX = 72;
/** The line the time takes under the frame (stream.css `.st-preview-time` height). */
export const PREVIEW_TIME_PX = 22;
/** Between the box and the top of the timeline. */
export const PREVIEW_GAP_PX = 10;
/** The least room between the box and the stage's edges. */
export const PREVIEW_EDGE_PX = 8;

/** The stage's box as the pointer event saw it (getBoundingClientRect). */
export interface StageBox {
  left: number;
  bottom: number;
  width: number;
  height: number;
}

export interface SheetSize {
  width: number;
  height: number;
}

/** Loads one sheet's picture and answers its natural size; rejects when it does not load. */
export type LoadSheet = (url: string) => Promise<SheetSize>;

/** What the page knows of a sheet: being probed, loaded (with its size), or failed. */
export type SheetStatus = { state: 'loading' } | { state: 'failed' } | ({ state: 'ready' } & SheetSize);

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The film's second under the pointer: where a click there would put the thumb's centre, clamped to
 * the film. Null when the film has no duration yet or the track has no room. Integer inputs give an
 * exact second (the product is divided once).
 */
export function hoverTime(clientX: number, track: Pick<DOMRect, 'left' | 'width'>, durationS: number, thumbPx = SEEK_THUMB_PX): number | null {
  if (!(durationS > 0) || !(track.width > thumbPx)) return null;
  const travel = track.width - thumbPx;
  const offset = Math.min(travel, Math.max(0, clientX - track.left - thumbPx / 2));
  return (offset * durationS) / travel;
}

/** The frame that stands for second `t`: the cue whose [startS, endS) holds it; null in a gap. `cues` is sorted and never overlaps (parsePreviews). */
export function cueAt(cues: readonly PreviewCue[], t: number): PreviewCue | null {
  let lo = 0;
  let hi = cues.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].startS <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found === -1) return null;
  const cue = cues[found];
  return t < cue.endS ? cue : null;
}

export interface FrameStyle {
  width: number;
  height: number;
  backgroundImage: string;
  backgroundPosition: string;
  backgroundSize: string;
}

/**
 * The frame drawn `width` px wide: a div whose background is the sheet, moved and scaled so the cue's
 * rectangle fills it. Null when the rectangle is not inside the picture that loaded (nothing drawn
 * from outside it).
 */
export function frameStyle(cue: PreviewCue, sheet: SheetSize, width: number): FrameStyle | null {
  if (cue.x + cue.w > sheet.width || cue.y + cue.h > sheet.height) return null;
  const k = width / cue.w;
  const px = (n: number): string => `${round2(n)}px`;
  return {
    width,
    height: Math.round(cue.h * k),
    // JSON.stringify quotes the address and escapes `"` and `\`, which a CSS string reads back as they were.
    backgroundImage: `url(${JSON.stringify(cue.url)})`,
    backgroundPosition: `${px(-cue.x * k)} ${px(-cue.y * k)}`,
    backgroundSize: `${px(sheet.width * k)} ${px(sheet.height * k)}`,
  };
}

/**
 * Where the box goes, in px from the stage's left and bottom: centred over the pointer, PREVIEW_GAP_PX
 * above the timeline's top, and never closer than PREVIEW_EDGE_PX to the stage's edges.
 */
export function previewPlacement(clientX: number, stage: StageBox, trackTop: number, box: SheetSize): { left: number; bottom: number } {
  const maxLeft = Math.max(PREVIEW_EDGE_PX, stage.width - box.width - PREVIEW_EDGE_PX);
  const left = Math.min(maxLeft, Math.max(PREVIEW_EDGE_PX, clientX - stage.left - box.width / 2));
  const maxBottom = Math.max(PREVIEW_EDGE_PX, stage.height - box.height - PREVIEW_EDGE_PX);
  const bottom = Math.min(maxBottom, Math.max(PREVIEW_EDGE_PX, stage.bottom - trackTop + PREVIEW_GAP_PX));
  return { left: round2(left), bottom: round2(bottom) };
}

/** The browser's probe: an Image() that is never put on the page, so a sheet that fails is never shown broken. */
export const loadSheetImage: LoadSheet = (url) =>
  new Promise<SheetSize>((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('sheet_failed'));
    img.src = url;
  });

/**
 * The sheets of the session's previews, each probed once, when a hover first reaches a frame in it
 * (never all of them at once); its size or its failure is remembered, so a broken sheet is asked for
 * once. `forgetFailures` gives the failed ones one more try when the previews change.
 */
export class SheetCache {
  private readonly known = new Map<string, SheetStatus>();
  private readonly load: LoadSheet;
  private readonly onChange: () => void;

  constructor(load: LoadSheet, onChange: () => void) {
    this.load = load;
    this.onChange = onChange;
  }

  /** What is known of `url`; null before it was wanted. */
  peek(url: string): SheetStatus | null {
    return this.known.get(url) ?? null;
  }

  /** Starts the probe of `url` unless it is known already. */
  want(url: string): void {
    if (this.known.has(url)) return;
    this.known.set(url, { state: 'loading' });
    let probe: Promise<SheetSize>;
    try {
      probe = this.load(url);
    } catch {
      probe = Promise.reject(new Error('sheet_failed'));
    }
    probe.then(
      (size) => this.settle(url, size.width > 0 && size.height > 0 ? { state: 'ready', width: size.width, height: size.height } : { state: 'failed' }),
      () => this.settle(url, { state: 'failed' }),
    );
  }

  /** The previews changed: a sheet that failed may be there now. */
  forgetFailures(): void {
    for (const [url, status] of this.known) if (status.state === 'failed') this.known.delete(url);
  }

  private settle(url: string, status: SheetStatus): void {
    if (this.known.get(url)?.state !== 'loading') return;
    this.known.set(url, status);
    this.onChange();
  }
}
