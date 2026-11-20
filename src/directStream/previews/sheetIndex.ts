import { randomBytes } from 'node:crypto';
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { PREVIEW_COLS, PREVIEW_INTERVAL_S, PREVIEW_ROWS, SHEET_NAME, type SheetRecord } from './plan.js';
import type { LocalVideo } from './types.js';

/** The index beside the sheets: which sheets are finished, and each frame's size. */
export const PREVIEW_INDEX_FILE = 'previews.json';

const sheetSchema = z.object({
  index: z.number().int().min(0),
  name: z.string().regex(SHEET_NAME),
  start_s: z.number().min(0),
  end_s: z.number().positive(),
  frames: z.number().int().min(1).max(PREVIEW_COLS * PREVIEW_ROWS),
  frame_w: z.number().int().positive(),
  frame_h: z.number().int().positive(),
});

const indexSchema = z.object({
  version: z.literal(1),
  key: z.string(),
  duration_s: z.number().positive(),
  interval_s: z.number().positive(),
  sheets: z.array(sheetSchema),
});

type IndexedVideo = Pick<LocalVideo, 'key' | 'dir' | 'durationS'>;

/**
 * The finished sheets of `video`, in order. An index of another video (key), another length (more than 1 s off)
 * or another interval counts as none; a sheet whose file is gone is left out. Never throws.
 */
export async function readSheets(video: IndexedVideo): Promise<SheetRecord[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(video.dir, PREVIEW_INDEX_FILE), 'utf8'));
  } catch {
    return [];
  }
  const parsed = indexSchema.safeParse(raw);
  if (!parsed.success) return [];
  const file = parsed.data;
  if (file.key !== video.key || file.interval_s !== PREVIEW_INTERVAL_S || Math.abs(file.duration_s - video.durationS) > 1) return [];
  let names: Set<string>;
  try {
    names = new Set(await readdir(video.dir));
  } catch {
    return [];
  }
  return file.sheets.filter((s) => names.has(s.name)).sort((a, b) => a.index - b.index);
}

/** Records one finished sheet (replacing an older record of the same index): a temporary name, then rename. */
export async function addSheet(video: IndexedVideo, record: SheetRecord): Promise<void> {
  const sheets = [...(await readSheets(video)).filter((s) => s.index !== record.index), record].sort((a, b) => a.index - b.index);
  const final = path.join(video.dir, PREVIEW_INDEX_FILE);
  const tmp = `${final}.${randomBytes(4).toString('hex')}.part`;
  const body = { version: 1, key: video.key, duration_s: video.durationS, interval_s: PREVIEW_INTERVAL_S, sheets };
  try {
    await writeFile(tmp, `${JSON.stringify(body)}\n`);
    await rename(tmp, final);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
