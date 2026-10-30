import type { Mode, Note, View } from '../types';
import { isHiddenByMode } from './filter';
import { tagsOf } from './text';

/** The wall state that can hide a note. `keep` = ids `visibleOnWall` always shows (inline-edited, expanded). */
export interface RevealState {
  view: View;
  mode: Mode;
  active: string[];
  keep: ReadonlyArray<string | null>;
}

/** What to set so the note's card is on screen. `active` is the same array when unchanged. */
export interface RevealPlan {
  view: View;
  mode: Mode;
  active: string[];
  /** Something differs from the state: the card appears only after the next render. */
  changed: boolean;
}

/** The active tags the note carries (AND filter): drops only the ones that exclude it. Same array when none is dropped. */
export function tagsKeeping(note: Note, active: string[]): string[] {
  if (active.length === 0) return active;
  const own = tagsOf(note.body);
  const kept = active.filter((t) => own.includes(t));
  return kept.length === active.length ? active : kept;
}

/**
 * How to make `note` visible on the wall: leave the bin; `all` when the mode hides it (any note in
 * `images` mode, a photo note in `text` mode); with `tags`, drop the active tags that exclude it.
 * A kept note (being edited or expanded) is already on the wall unless the mode is `images`.
 * `note` may be undefined (jump on an id not in the store): only the mode rule applies, as before.
 */
export function planReveal(note: Note | undefined, s: RevealState, opts: { tags?: boolean } = {}): RevealPlan {
  const view: View = 'wall';
  const kept = note !== undefined && s.mode !== 'images' && s.keep.includes(note.id);
  const mode: Mode = !kept && isHiddenByMode(note, s.mode) ? 'all' : s.mode;
  const active = opts.tags === true && note !== undefined && !kept ? tagsKeeping(note, s.active) : s.active;
  return { view, mode, active, changed: view !== s.view || mode !== s.mode || active !== s.active };
}
