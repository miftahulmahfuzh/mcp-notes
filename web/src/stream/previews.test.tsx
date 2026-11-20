// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { cueAt, frameStyle, hoverTime, previewPlacement, SheetCache, type LoadSheet } from './previews';
import type { PreviewCue } from './session';

const cue = (startS: number, over: Partial<PreviewCue> = {}): PreviewCue => ({ startS, endS: startS + 10, url: '/s.jpg', x: 0, y: 0, w: 240, h: 135, ...over });

describe('hoverTime', () => {
  // The track's box starts at 300 px and is 811 px wide: the thumb's centre travels 800 px.
  const track = { left: 300, width: 811 };

  it('is the second a click there would seek to, clamped to the film', () => {
    expect(hoverTime(305.5, track, 600)).toBe(0);
    expect(hoverTime(705.5, track, 600)).toBe(300);
    expect(hoverTime(773.5, track, 600)).toBe(351);
    expect(hoverTime(1105.5, track, 600)).toBe(600);
    expect(hoverTime(100, track, 600)).toBe(0);
    expect(hoverTime(2000, track, 600)).toBe(600);
  });

  it('has nothing to say without a duration or a track with room', () => {
    expect(hoverTime(705.5, track, 0)).toBeNull();
    expect(hoverTime(705.5, track, Number.NaN)).toBeNull();
    expect(hoverTime(705.5, { left: 300, width: 11 }, 600)).toBeNull();
  });
});

describe('cueAt', () => {
  const cues = [cue(0), cue(10), cue(40)];

  it('finds the frame whose stretch holds the second, and none in a gap', () => {
    expect(cueAt(cues, 0)).toBe(cues[0]);
    expect(cueAt(cues, 9.99)).toBe(cues[0]);
    expect(cueAt(cues, 10)).toBe(cues[1]);
    expect(cueAt(cues, 25)).toBeNull();
    expect(cueAt(cues, 45)).toBe(cues[2]);
    expect(cueAt(cues, 50)).toBeNull();
    expect(cueAt(cues, -1)).toBeNull();
    expect(cueAt([], 5)).toBeNull();
  });
});

describe('frameStyle', () => {
  it('moves and scales the sheet so the rectangle fills the box', () => {
    const c = cue(0, { x: 240, y: 135 });
    expect(frameStyle(c, { width: 1440, height: 810 }, 240)).toEqual({
      width: 240,
      height: 135,
      backgroundImage: 'url("/s.jpg")',
      backgroundPosition: '-240px -135px',
      backgroundSize: '1440px 810px',
    });
    expect(frameStyle(c, { width: 1440, height: 810 }, 120)).toEqual({
      width: 120,
      height: 68,
      backgroundImage: 'url("/s.jpg")',
      backgroundPosition: '-120px -67.5px',
      backgroundSize: '720px 405px',
    });
  });

  it('draws nothing from outside the picture, and quotes an address with a quote in it', () => {
    expect(frameStyle(cue(0, { x: 240 }), { width: 400, height: 810 }, 240)).toBeNull();
    expect(frameStyle(cue(0, { y: 700 }), { width: 1440, height: 810 }, 240)).toBeNull();
    expect(frameStyle(cue(0, { url: '/p?u=a"b(c)' }), { width: 240, height: 135 }, 240)?.backgroundImage).toBe('url("/p?u=a\\"b(c)")');
  });
});

describe('previewPlacement', () => {
  const stage = { left: 0, bottom: 900, width: 1400, height: 900 };

  it('centres the box over the pointer, above the timeline', () => {
    expect(previewPlacement(705.5, stage, 850, { width: 240, height: 157 })).toEqual({ left: 585.5, bottom: 60 });
  });

  it('keeps the box inside the stage', () => {
    // The plan's 301 px is 181 px from the stage's left, not at its edge: a pointer that is at the edge.
    expect(previewPlacement(301, stage, 850, { width: 240, height: 157 }).left).toBe(181);
    expect(previewPlacement(50, stage, 850, { width: 240, height: 157 }).left).toBe(8);
    expect(previewPlacement(1395, stage, 850, { width: 240, height: 157 }).left).toBe(1152);
    expect(previewPlacement(700, { left: 0, bottom: 100, width: 1400, height: 100 }, 90, { width: 240, height: 157 }).bottom).toBe(8);
  });
});

describe('SheetCache', () => {
  it('loads each sheet once, remembers a failure until the previews change, and says when one settles', async () => {
    const load = vi.fn<LoadSheet>(async (url) => {
      if (url === '/b') throw new Error('404');
      if (url === '/empty') return { width: 0, height: 0 };
      return { width: 1440, height: 810 };
    });
    const changed = vi.fn();
    const cache = new SheetCache(load, changed);
    expect(cache.peek('/a')).toBeNull();
    cache.want('/a');
    cache.want('/a');
    expect(cache.peek('/a')).toEqual({ state: 'loading' });
    cache.want('/b');
    cache.want('/empty');
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(3));
    expect(cache.peek('/a')).toEqual({ state: 'ready', width: 1440, height: 810 });
    expect(cache.peek('/b')).toEqual({ state: 'failed' });
    // A picture with no size is not drawn.
    expect(cache.peek('/empty')).toEqual({ state: 'failed' });
    cache.want('/b');
    expect(load).toHaveBeenCalledTimes(3);
    cache.forgetFailures();
    expect(cache.peek('/a')).toEqual({ state: 'ready', width: 1440, height: 810 });
    expect(cache.peek('/b')).toBeNull();
    cache.want('/b');
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('takes a loader that throws as a failed sheet', async () => {
    const changed = vi.fn();
    const cache = new SheetCache(() => {
      throw new Error('no Image here');
    }, changed);
    cache.want('/a');
    await vi.waitFor(() => expect(cache.peek('/a')).toEqual({ state: 'failed' }));
  });
});
