import { describe, expect, it } from 'vitest';
import { covered, cuesOf, planSheets } from '../../../../src/directStream/previews/plan.js';

describe('the sheet plan', () => {
  it('cuts a film into 360 s sheets of a frame every 10 s, the last one shorter', () => {
    expect(planSheets(800).map((s) => [s.name, s.startS, s.endS, s.frames])).toEqual([
      ['sheet-00000.jpg', 0, 360, 36],
      ['sheet-00001.jpg', 360, 720, 36],
      ['sheet-00002.jpg', 720, 800, 8],
    ]);
    expect(planSheets(721)).toHaveLength(2);
    expect(planSheets(0)).toEqual([]);
  });

  it('makes a sheet only when one stretch on disk holds all of it', () => {
    const [first, second] = planSheets(800);
    expect(first !== undefined && covered(first, [[0, 359.8]])).toBe(true);
    expect(second !== undefined && covered(second, [[360, 500], [500.2, 720]])).toBe(false);
    expect(second !== undefined && covered(second, [[0, 720]])).toBe(true);
  });

  it('lists one cue per frame with its rectangle, sorted, gaps where no sheet is made', () => {
    const cues = cuesOf(
      [
        { index: 2, name: 'sheet-00002.jpg', start_s: 720, end_s: 800, frames: 8, frame_w: 240, frame_h: 136 },
        { index: 0, name: 'sheet-00000.jpg', start_s: 0, end_s: 360, frames: 36, frame_w: 240, frame_h: 136 },
      ],
      (name) => `/x/${name}`,
    );
    expect(cues).toHaveLength(44);
    expect(cues[0]).toEqual({ start_s: 0, end_s: 10, url: '/x/sheet-00000.jpg', x: 0, y: 0, w: 240, h: 136 });
    expect(cues[7]).toEqual({ start_s: 70, end_s: 80, url: '/x/sheet-00000.jpg', x: 240, y: 136, w: 240, h: 136 });
    expect(cues[36]).toEqual({ start_s: 720, end_s: 730, url: '/x/sheet-00002.jpg', x: 0, y: 0, w: 240, h: 136 });
    expect(cues.at(-1)?.end_s).toBe(800);
    expect(cues.some((c) => c.start_s >= 360 && c.start_s < 720)).toBe(false);
  });
});
