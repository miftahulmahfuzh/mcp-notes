import { describe, expect, it } from 'vitest';
import type { Note } from '../types';
import { countLineFor, headingFor, isHiddenByMode, lastEdited, nextMode, photosOf, visibleOnWall } from './filter';

const img = { mime: 'image/jpeg', width: 600, height: 400, bytes: 1, taken_at: null, original_name: null, host: 'lenovo', available: true };
function note(id: string, body: string, opts: { image?: boolean; updated?: string } = {}): Note {
  return {
    id,
    body,
    tags: [],
    created_at: '2026-10-30T00:00:00Z',
    updated_at: opts.updated ?? '2026-10-30T00:00:00Z',
    origin: null,
    image: opts.image ? img : null,
  };
}

const notes = [
  note('A-AAA', '#seer #ux both'),
  note('B-BBB', '#seer only'),
  note('C-CCC', '#ux only'),
  note('D-DDD', 'photo #seer #ux', { image: true }),
];

describe('visibleOnWall', () => {
  it('applies tag filters with AND semantics', () => {
    expect(visibleOnWall(notes, 'all', ['seer', 'ux']).map((n) => n.id)).toEqual(['A-AAA', 'D-DDD']);
    expect(visibleOnWall(notes, 'all', ['seer']).map((n) => n.id)).toEqual(['A-AAA', 'B-BBB', 'D-DDD']);
  });
  it('hides image notes in text mode only', () => {
    expect(visibleOnWall(notes, 'text', []).map((n) => n.id)).toEqual(['A-AAA', 'B-BBB', 'C-CCC']);
    expect(visibleOnWall(notes, 'all', [])).toHaveLength(4);
  });
  it('always keeps the note being edited', () => {
    expect(visibleOnWall([...notes, note('E-EEE', '')], 'text', ['seer'], 'E-EEE').map((n) => n.id)).toContain('E-EEE');
  });
});

describe('modes and header', () => {
  it('cycles text → images → all → text', () => {
    expect(nextMode('text')).toBe('images');
    expect(nextMode('images')).toBe('all');
    expect(nextMode('all')).toBe('text');
  });
  it('picks the heading', () => {
    expect(headingFor('text', [])).toBe('Notes.');
    expect(headingFor('all', [])).toBe('Everything.');
    expect(headingFor('images', ['seer'])).toBe('Photos.');
    expect(headingFor('text', ['seer', 'ux'])).toBe('#seer #ux');
  });
  it('builds the count line per mode', () => {
    const textVis = visibleOnWall(notes, 'text', []);
    expect(countLineFor('text', [], notes, textVis, [])).toBe('3 notes, 1 photo notes hidden.');
    expect(countLineFor('all', [], notes, notes, [])).toBe('4 notes, 1 with photos.');
    expect(countLineFor('images', [], notes, [], photosOf(notes, []))).toBe('1 photos.');
    const tagged = visibleOnWall(notes, 'all', ['ux']);
    expect(countLineFor('all', ['ux'], notes, tagged, [])).toBe('3 of 4 notes.');
  });
  it('knows which notes a mode hides', () => {
    expect(isHiddenByMode(notes[0], 'images')).toBe(true);
    expect(isHiddenByMode(notes[3], 'text')).toBe(true);
    expect(isHiddenByMode(notes[0], 'text')).toBe(false);
    expect(isHiddenByMode(notes[3], 'all')).toBe(false);
  });
  it('finds the last edited note by updated_at', () => {
    const list = [note('A-AAA', 'x', { updated: '2026-10-29T10:00:00Z' }), note('B-BBB', 'y', { updated: '2026-10-30T09:00:00Z' })];
    expect(lastEdited(list)?.id).toBe('B-BBB');
    expect(lastEdited([])).toBeNull();
  });
});
