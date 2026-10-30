import type { Mode, Note } from '../types';
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

/** AND semantics: a note matches when it carries every active tag. */
export function matchesTags(note: Note, active: string[]): boolean {
  if (active.length === 0) return true;
  const t = tagsOf(note.body);
  return active.every((a) => t.includes(a));
}

/** Notes shown on the wall. `keepId` (the note being edited) is always kept. */
export function visibleOnWall(notes: Note[], mode: Mode, active: string[], keepId: string | null = null): Note[] {
  return notes.filter((n) => n.id === keepId || ((mode !== 'text' || !n.image) && matchesTags(n, active)));
}

export function photosOf(notes: Note[], active: string[]): Note[] {
  return notes.filter((n) => n.image && matchesTags(n, active));
}

export function headingFor(mode: Mode, active: string[]): string {
  if (mode === 'images') return 'Photos.';
  if (active.length) return active.map((t) => '#' + t).join(' ');
  return mode === 'text' ? 'Notes.' : 'Everything.';
}

export function countLineFor(mode: Mode, active: string[], all: Note[], visible: Note[], photos: Note[]): string {
  if (mode === 'images') return `${photos.length} photos.`;
  if (active.length) return `${visible.length} of ${all.length} notes.`;
  if (mode === 'text') return `${visible.length} notes, ${all.length - visible.length} photo notes hidden.`;
  return `${all.length} notes, ${all.filter((n) => n.image).length} with photos.`;
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
  return mode === 'images' || (mode === 'text' && !!note?.image);
}
