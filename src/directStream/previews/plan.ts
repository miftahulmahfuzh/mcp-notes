import type { PreviewCue } from './types.js';

/** A frame every 10 s of film. */
export const PREVIEW_INTERVAL_S = 10;
/** Each frame is 240 px wide; its height follows the picture's shape (ffmpeg's scale=240:-2). */
export const PREVIEW_FRAME_WIDTH = 240;
export const PREVIEW_COLS = 6;
export const PREVIEW_ROWS = 6;
/** One sheet holds at most 6×6 frames: 360 s of film. */
export const SHEET_SPAN_S = PREVIEW_INTERVAL_S * PREVIEW_COLS * PREVIEW_ROWS;
/** A last stretch shorter than this makes no sheet (its seconds show the time alone). */
export const PREVIEW_MIN_STRETCH_S = 2;
/** How far a stretch on disk may fall short of a sheet's edge and still count (playlist times are rounded). */
const EDGE_S = 0.5;

export const SHEET_NAME = /^sheet-\d{5}\.jpg$/;

/** One sheet to make: frames `startS`, `startS + 10`, ... below `endS`. */
export interface SheetSpec {
  index: number;
  name: string;
  startS: number;
  endS: number;
  frames: number;
}

/** One finished sheet, as the index on disk keeps it. `frame_w` x `frame_h` is one frame's rectangle in pixels. */
export interface SheetRecord {
  index: number;
  name: string;
  start_s: number;
  end_s: number;
  frames: number;
  frame_w: number;
  frame_h: number;
}

export function sheetName(index: number): string {
  return `sheet-${String(index).padStart(5, '0')}.jpg`;
}

/** Every sheet of a film `durationS` long, in order; [] for an unknown or empty length. */
export function planSheets(durationS: number): SheetSpec[] {
  const out: SheetSpec[] = [];
  if (!(durationS > 0)) return out;
  for (let index = 0; index * SHEET_SPAN_S < durationS; index += 1) {
    const startS = index * SHEET_SPAN_S;
    const endS = Math.min(startS + SHEET_SPAN_S, durationS);
    if (index > 0 && endS - startS < PREVIEW_MIN_STRETCH_S) break;
    out.push({ index, name: sheetName(index), startS, endS, frames: Math.ceil((endS - startS) / PREVIEW_INTERVAL_S) });
  }
  return out;
}

/** True when one stretch of `coverage` holds the sheet's whole stretch: a sheet is made only then. */
export function covered(sheet: Pick<SheetSpec, 'startS' | 'endS'>, coverage: ReadonlyArray<readonly [number, number]>): boolean {
  return coverage.some(([a, b]) => a <= sheet.startS + EDGE_S && b >= sheet.endS - EDGE_S);
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

/** The cues of finished sheets: one per frame, sorted, never overlapping (sheets never do), gaps where none is made. */
export function cuesOf(sheets: readonly SheetRecord[], urlOf: (name: string) => string): PreviewCue[] {
  const cues: PreviewCue[] = [];
  for (const sheet of sheets) {
    const url = urlOf(sheet.name);
    for (let k = 0; k < sheet.frames; k += 1) {
      const start = sheet.start_s + k * PREVIEW_INTERVAL_S;
      if (start >= sheet.end_s) break;
      cues.push({
        start_s: round(start),
        end_s: round(Math.min(start + PREVIEW_INTERVAL_S, sheet.end_s)),
        url,
        x: (k % PREVIEW_COLS) * sheet.frame_w,
        y: Math.floor(k / PREVIEW_COLS) * sheet.frame_h,
        w: sheet.frame_w,
        h: sheet.frame_h,
      });
    }
  }
  return cues.sort((a, b) => a.start_s - b.start_s);
}
