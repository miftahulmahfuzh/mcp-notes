import { describe, expect, it } from 'vitest';
import { countLineFor, hasImages, headingFor, imageCount, isHiddenByMode, lastEdited, nextMode, photosOf, visibleOnWall } from './filter';
import { makeImage, makeNote } from '../testing/fixtures';

const notes = [
  makeNote('A-AAA', '#seer #ux both'),
  makeNote('B-BBB', '#seer only'),
  makeNote('C-CCC', '#ux only'),
  makeNote('D-DDD', 'photos #seer #ux', { images: ['D-DDD', 'E-EE1', 'F-FF2'] }),
  makeNote('G-GGG', 'one photo #ux', { images: ['G-GGG'] }),
];

describe('visibleOnWall', () => {
  it('applies tag filters with AND semantics', () => {
    expect(visibleOnWall(notes, 'all', ['seer', 'ux']).map((n) => n.id)).toEqual(['A-AAA', 'D-DDD']);
    expect(visibleOnWall(notes, 'all', ['seer']).map((n) => n.id)).toEqual(['A-AAA', 'B-BBB', 'D-DDD']);
  });
  it('hides notes with images in text mode only', () => {
    expect(visibleOnWall(notes, 'text', []).map((n) => n.id)).toEqual(['A-AAA', 'B-BBB', 'C-CCC']);
    expect(visibleOnWall(notes, 'all', [])).toHaveLength(5);
  });
  it('always keeps the note being edited', () => {
    expect(visibleOnWall([...notes, makeNote('E-EEE', '')], 'text', ['seer'], 'E-EEE').map((n) => n.id)).toContain('E-EEE');
  });
  it('keeps every id in a keep list (inline edit + big editor)', () => {
    const extra = [...notes, makeNote('E-EEE', ''), makeNote('F-FFF', 'pic', { images: ['F-FFF'] })];
    const ids = visibleOnWall(extra, 'text', ['seer'], ['E-EEE', 'F-FFF', null]).map((n) => n.id);
    expect(ids).toContain('E-EEE');
    expect(ids).toContain('F-FFF');
    expect(ids).not.toContain('C-CCC');
  });
});

describe('images', () => {
  it('hasImages and imageCount', () => {
    expect(hasImages(notes[0])).toBe(false);
    expect(hasImages(notes[3])).toBe(true);
    expect(imageCount(notes)).toBe(4);
    expect(imageCount([])).toBe(0);
  });
  it('photosOf flattens note by note, images in position order, with k/n per note', () => {
    const items = photosOf(notes, []);
    expect(items.map((it) => [it.image.id, it.note.id, it.k, it.n])).toEqual([
      ['D-DDD', 'D-DDD', 1, 3],
      ['E-EE1', 'D-DDD', 2, 3],
      ['F-FF2', 'D-DDD', 3, 3],
      ['G-GGG', 'G-GGG', 1, 1],
    ]);
    expect(items[1].note).toBe(notes[3]);
  });
  it('photosOf applies tag filters to the owning note', () => {
    expect(photosOf(notes, ['seer']).map((it) => it.image.id)).toEqual(['D-DDD', 'E-EE1', 'F-FF2']);
    expect(photosOf(notes, ['nope'])).toEqual([]);
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
  it('builds the count line per mode: photos count images, the rest count notes', () => {
    const textVis = visibleOnWall(notes, 'text', []);
    expect(countLineFor('text', [], notes, textVis, [])).toBe('3 notes, 2 photo notes hidden.');
    expect(countLineFor('all', [], notes, notes, [])).toBe('5 notes, 2 with photos.');
    expect(countLineFor('images', [], notes, [], photosOf(notes, []))).toBe('4 photos.');
    const tagged = visibleOnWall(notes, 'all', ['ux']);
    expect(countLineFor('all', ['ux'], notes, tagged, [])).toBe('4 of 5 notes.');
  });
  it('counts only the photos on this machine', () => {
    const mixed = [
      makeNote('H-HHH', 'pics', { images: ['H-HH1', 'H-HH2'] }),
      { ...makeNote('J-JJJ', 'gpd pic'), images: [makeImage('J-JJ1', { note_id: 'J-JJJ', host: 'gpd', available: false })] },
    ];
    expect(imageCount(mixed)).toBe(2);
    expect(countLineFor('images', [], mixed, [], photosOf(mixed, []))).toBe('2 photos.');
  });
  it('knows which notes a mode hides', () => {
    expect(isHiddenByMode(notes[0], 'images')).toBe(true);
    expect(isHiddenByMode(notes[3], 'text')).toBe(true);
    expect(isHiddenByMode(notes[0], 'text')).toBe(false);
    expect(isHiddenByMode(notes[3], 'all')).toBe(false);
    expect(isHiddenByMode(undefined, 'text')).toBe(false);
  });
  it('finds the last edited note by updated_at', () => {
    const list = [makeNote('A-AAA', 'x', { updated: '2026-10-29T10:00:00Z' }), makeNote('B-BBB', 'y', { updated: '2026-10-30T09:00:00Z' })];
    expect(lastEdited(list)?.id).toBe('B-BBB');
    expect(lastEdited([])).toBeNull();
  });
});
