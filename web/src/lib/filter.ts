import type { Mode, Note, PhotoItem } from '../types';
import { tagsOf } from './text';

export const MODE_TIP: Record<Mode, string> = {
  text: 'Text notes only',
  images: 'Image notes only',
  all: 'All notes',
};
export const MODE_ORDER: Mode[] = ['text', 'images', 'all'];

export function nextMode(m: Mode): Mode {
  return m === 'text' ? 'images' : m === 'images' ? 'all' : 'text';
}

/** A note with at least one live image. */
export function hasImages(n: Note): boolean {
  return n.images.length > 0;
}

/** Number of images across `notes` (the sidebar's "N photos"). */
export function imageCount(notes: Note[]): number {
  let total = 0;
  for (const n of notes) total += n.images.length;
  return total;
}

/** AND semantics: a note matches when it carries every active tag. */
export function matchesTags(note: Note, active: string[]): boolean {
  if (active.length === 0) return true;
  const t = tagsOf(note.body);
  return active.every((a) => t.includes(a));
}

/** Notes shown on the wall. `keep` (the note being edited inline and/or the one open in the big editor) is always kept. */
export function visibleOnWall(
  notes: Note[],
  mode: Mode,
  active: string[],
  keep: string | null | ReadonlyArray<string | null> = null,
): Note[] {
  const list: ReadonlyArray<string | null> = typeof keep === 'string' || keep === null ? [keep] : keep;
  const kept = new Set<string>();
  for (const k of list) if (k !== null) kept.add(k);
  return notes.filter((n) => kept.has(n.id) || ((mode !== 'text' || !hasImages(n)) && matchesTags(n, active)));
}

/** One item per image of every tag-matching note: note by note in wall order, images in position order. */
export function photosOf(notes: Note[], active: string[]): PhotoItem[] {
  const out: PhotoItem[] = [];
  for (const note of notes) {
    if (!hasImages(note) || !matchesTags(note, active)) continue;
    const n = note.images.length;
    note.images.forEach((image, i) => out.push({ note, image, k: i + 1, n }));
  }
  return out;
}

export function headingFor(mode: Mode, active: string[]): string {
  if (mode === 'images') return 'Photos.';
  if (active.length) return active.map((t) => '#' + t).join(' ');
  return mode === 'text' ? 'Notes.' : 'Everything.';
}

export function countLineFor(mode: Mode, active: string[], all: Note[], visible: Note[], photos: PhotoItem[]): string {
  if (mode === 'images') return `${photos.length} photos.`;
  if (active.length) return `${visible.length} of ${all.length} notes.`;
  if (mode === 'text') return `${visible.length} notes, ${all.length - visible.length} photo notes hidden.`;
  return `${all.length} notes, ${all.filter(hasImages).length} with photos.`;
}

export function lastEdited(notes: Note[]): Note | null {
  let best: Note | null = null;
  let bestT = -Infinity;
  for (const n of notes) {
    const t = Date.parse(n.updated_at);
    if (!Number.isNaN(t) && t > bestT) {
      best = n;
      bestT = t;
    }
  }
  return best;
}

export function isHiddenByMode(note: Note | undefined, mode: Mode): boolean {
  return mode === 'images' || (mode === 'text' && !!note && hasImages(note));
}
