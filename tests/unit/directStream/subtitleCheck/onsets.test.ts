import { describe, expect, it } from 'vitest';
import { judge, onsetFit, parseSubCues, retime, type HeardLine } from '../../../../src/directStream/subtitleCheck/match.js';

/** A small fixed random sequence, so every film below is the same on every run. */
function random(seed: number): () => number {
  let x = seed;
  return () => {
    x = (x * 1664525 + 1013904223) % 4294967296;
    return x / 4294967296;
  };
}
const stamp = (s: number): string => {
  const ms = Math.round(s * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)}.${p(ms % 1000, 3)}`;
};
const WORDS = 'when the river turned we left our village behind and nobody asked where the old man had gone that winter'.split(' ');
/** A film's subtitle: a cue every 2 to 6 s for `lengthS` seconds, its own words. */
function film(seed: number, lengthS = 3000): { vtt: string; starts: number[] } {
  const next = random(seed);
  const out = ['WEBVTT', ''];
  const starts: number[] = [];
  for (let t = 5 + next() * 3; t < lengthS; t += 2 + next() * 4) {
    starts.push(t);
    const text = Array.from({ length: 4 + Math.floor(next() * 4) }, () => WORDS[Math.floor(next() * WORDS.length)]).join(' ');
    out.push(`${stamp(t)} --> ${stamp(t + 1.6)}`, `${text} ${seed}`, '');
  }
  return { vtt: out.join('\n'), starts };
}
/**
 * What Whisper hears of a film through translation, a minute at six places: most of the lines that are said there
 * (it merges some), each beginning a little after its cue, in words that are not the subtitle's.
 */
function heardOf(starts: readonly number[], seed: number, move: (t: number) => number = (t) => t): HeardLine[] {
  const next = random(seed);
  const lines: HeardLine[] = [];
  for (const at of [60, 480, 960, 1500, 2100, 2700]) {
    for (const s of starts.filter((c) => c >= at && c < at + 60)) {
      if (next() < 0.2) continue;
      const startS = move(s) + 0.15 + (next() - 0.5) * 0.5;
      lines.push({ startS, endS: startS + 1.5, text: 'something else entirely was said here' });
    }
    // A line the subtitle does not carry.
    lines.push({ startS: at + 59 * next(), endS: at + 60, text: 'a shout from the crowd' });
  }
  return lines;
}

describe('a film heard through translation is matched by where its lines start', () => {
  const right = film(7);
  const other = film(99);
  const heard = heardOf(right.starts, 3);

  it('has enough lines to say something, and none of them match by words', () => {
    expect(heard.length).toBeGreaterThan(60);
    expect(judge(right.vtt, heard, 3000)).toMatchObject({ text: 'wrong', grade: 'bad', matched_by: 'words', onsets: null });
  });

  it("the film's own subtitle is right and in step", () => {
    const j = judge(right.vtt, heard, 3000, { translated: true });
    expect(j).toMatchObject({ text: 'correct', timing: 'in_step', grade: 'good', matched_by: 'onsets' });
    expect(j.onsets!.matched / j.onsets!.lines).toBeGreaterThan(0.7);
    expect(j.onsets!.matched - j.onsets!.rival).toBeGreaterThan(15);
    expect(Math.abs(j.off_start_s!)).toBeLessThan(0.4);
    // The words say what they said before: the share is not made up.
    expect(j.text_share).toBe(0);
  });

  it("another film's subtitle lines up with many lines by chance at some offset, and is still wrong", () => {
    const fit = onsetFit(heard, parseSubCues(other.vtt));
    expect(fit).toBeNull();
    expect(judge(other.vtt, heard, 3000, { translated: true })).toMatchObject({ text: 'wrong', grade: 'bad', matched_by: 'words' });
    // The same for a subtitle with far more cues than the film has lines.
    const dense = film(5).vtt + film(6).vtt.replace('WEBVTT', '') + film(8).vtt.replace('WEBVTT', '');
    expect(onsetFit(heard, parseSubCues(dense))).toBeNull();
  });

  it('a subtitle 33 s early is the right text and off, and re-timing it puts it in step', () => {
    const early = retime(right.vtt, { shiftS: 33, stretch: 1 });
    const j = judge(early, heard, 3000, { translated: true });
    expect(j).toMatchObject({ text: 'correct', timing: 'off', grade: 'fixable', matched_by: 'onsets' });
    expect(Math.abs(j.off_start_s! + 33)).toBeLessThan(0.5);
    expect(judge(retime(early, j.fit!), heard, 3000, { translated: true })).toMatchObject({ grade: 'good', timing: 'in_step' });
  });

  it('a subtitle that drifts (another frame rate) has no one offset and is not matched', () => {
    const drifting = retime(right.vtt, { shiftS: 0, stretch: 23.976 / 25 });
    expect(onsetFit(heard, parseSubCues(drifting))).toBeNull();
    expect(judge(drifting, heard, 3000, { translated: true }).grade).toBe('bad');
  });

  it('says nothing from a few lines, and is never asked for a film heard in English', () => {
    expect(onsetFit(heard.slice(0, 19), parseSubCues(right.vtt))).toBeNull();
    expect(onsetFit(heard, [])).toBeNull();
    expect(judge(right.vtt, heard, 3000, { translated: false })).toMatchObject({ text: 'wrong', matched_by: 'words' });
  });
});
