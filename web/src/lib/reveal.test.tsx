import { describe, expect, it } from 'vitest';
import { makeNote } from '../testing/fixtures';
import { planReveal, tagsKeeping, type RevealState } from './reveal';

const text = makeNote('A-B32', '#seer onboarding is long');
const both = makeNote('E-F56', 'miso soup #seer #kitchen');
const photo = makeNote('K-F07', 'River #walks', { images: ['K-F07'] });

const base: RevealState = { view: 'wall', mode: 'text', active: [], keep: [] };

describe('tagsKeeping', () => {
  it('keeps the tags the note carries and returns the same array when nothing drops', () => {
    const active = ['seer', 'kitchen'];
    expect(tagsKeeping(both, active)).toBe(active);
    expect(tagsKeeping(text, active)).toEqual(['seer']);
    expect(tagsKeeping(photo, active)).toEqual([]);
    const none: string[] = [];
    expect(tagsKeeping(text, none)).toBe(none);
  });
});

describe('planReveal', () => {
  it('changes nothing for a visible text note on the text wall', () => {
    const s = { ...base, active: ['seer'] };
    const p = planReveal(text, s, { tags: true });
    expect(p).toEqual({ view: 'wall', mode: 'text', active: ['seer'], changed: false });
    expect(p.active).toBe(s.active);
  });

  it('switches text -> all for a photo note and images -> all for any note', () => {
    expect(planReveal(photo, base)).toMatchObject({ mode: 'all', changed: true });
    expect(planReveal(text, { ...base, mode: 'images' })).toMatchObject({ mode: 'all', changed: true });
    expect(planReveal(photo, { ...base, mode: 'all' })).toMatchObject({ mode: 'all', changed: false });
  });

  it('leaves the bin', () => {
    expect(planReveal(text, { ...base, view: 'bin' })).toMatchObject({ view: 'wall', mode: 'text', changed: true });
  });

  it('drops only the excluding tags, and only with tags: true', () => {
    const s = { ...base, active: ['kitchen', 'seer'] };
    expect(planReveal(text, s, { tags: true })).toMatchObject({ active: ['seer'], changed: true });
    expect(planReveal(text, s).active).toBe(s.active);
  });

  it('a kept (edited/expanded) note needs no mode or tag change, except in images mode', () => {
    const s = { ...base, active: ['kitchen'], keep: ['K-F07', null] };
    const p = planReveal(photo, s, { tags: true });
    expect(p).toMatchObject({ mode: 'text', changed: false });
    expect(p.active).toBe(s.active);
    expect(planReveal(photo, { ...s, mode: 'images' }, { tags: true })).toMatchObject({ mode: 'all', active: [], changed: true });
  });

  it('an unknown note (jump on a missing id) keeps the old mode rule', () => {
    expect(planReveal(undefined, { ...base, mode: 'images' })).toMatchObject({ mode: 'all', changed: true });
    expect(planReveal(undefined, base)).toMatchObject({ mode: 'text', changed: false });
  });
});
