/**
 * Is this subtitle the right one for this audio, and is it in step with it? (/sync-subtitle, checker.ts)
 *
 * Whisper hears a few stretches spread over the film ("heard" lines, in film time). A subtitle is judged against
 * them in two steps, both from the same matches:
 *
 * - **Text.** Each heard line of four words or more is looked for anywhere in the subtitle: against every run of
 *   one to four cues in a row, scored by the longest common run of words in order. The share of heard lines found
 *   says whether the subtitle is of this film at all: another episode's subtitle shares almost none.
 * - **Timing.** Each line found is an anchor: the cue's start beside the moment it was heard. The anchors' offsets
 *   give one shift (their median) or, when the subtitle drifts over the film (another frame rate), a shift and a
 *   stretch. A subtitle is in step when that fix is nothing; it can be re-timed when one fix puts most anchors
 *   right; a subtitle whose offsets scatter was cut for another edit, and no single fix helps.
 *
 * A film that is not in English is heard through Whisper's translation, whose wording is not the subtitle's: the
 * right file of The Raid held 13% of the heard lines, another film's file as many. For such a film the lines' *starts*
 * are compared instead (onsetFit): see there.
 *
 * Pure: no I/O, no clock.
 */

export interface SubCue {
  startS: number;
  endS: number;
  text: string;
}

/** One line Whisper heard, in seconds into the film. */
export interface HeardLine {
  startS: number;
  endS: number;
  text: string;
}

/** A heard line needs this many words to count: shorter ones ("I can't.", "Thank you.") are in every film. */
export const MIN_LINE_WORDS = 4;
/** A heard line is found when its best cue run scores this (F1 of the common word run). */
export const MATCH_SCORE = 0.6;
/** Fewer countable heard lines than this says nothing about a subtitle. */
export const MIN_HEARD_LINES = 8;
/** Share of heard lines found: at or above, the subtitle is of this film; at or below WRONG_SHARE it is not. */
export const CORRECT_SHARE = 0.5;
export const WRONG_SHARE = 0.2;
/** A subtitle is in step when its lines come within this of the speech, at the start and at the end of the film. */
export const IN_STEP_S = 0.6;
/** An anchor agrees with the fix when it lands within this of it. */
export const ANCHOR_SLACK_S = 1.0;
/** The share of anchors that must agree with one fix. */
export const AGREE_SHARE = 0.7;
/** Fewer anchors than this give no timing. */
export const MIN_ANCHORS = 6;
/** A re-timed cue starts this long before its line is heard, as subtitles are cut. */
export const CUE_LEAD_S = 0.15;
const MAX_RUN = 4;
const TIMING = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s+-->\s+(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})(.*)$/;

const secondsOf = (h: string | undefined, m: string, s: string, ms: string): number => Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + Number(`0.${ms}`);

/** The cues of a WebVTT or SubRip text, in time order. */
export function parseSubCues(text: string): SubCue[] {
  const cues: SubCue[] = [];
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const t = TIMING.exec(lines[i]!.trim());
    if (t === null) continue;
    const parts: string[] = [];
    for (i += 1; i < lines.length && lines[i]!.trim() !== ''; i++) {
      if (TIMING.test(lines[i]!.trim())) {
        i -= 1;
        break;
      }
      parts.push(lines[i]!.trim());
    }
    const said = parts.join(' ').trim();
    if (said !== '') cues.push({ startS: secondsOf(t[1], t[2]!, t[3]!, t[4]!), endS: secondsOf(t[5], t[6]!, t[7]!, t[8]!), text: said });
  }
  return cues.sort((a, b) => a.startS - b.startS);
}

/** The words of a line as they are compared: lower case, no tags, no sound descriptions, no song lines, no apostrophes. */
export function wordsOf(text: string): string[] {
  const plain = text
    .replace(/<[^>]*>|\{[^}]*\}/g, ' ')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/[♪♫#][^♪♫#]*[♪♫#]?/g, ' ')
    .toLowerCase()
    .replace(/['’]/g, '');
  return plain.split(/[^a-z0-9]+/).filter((w) => w !== '');
}

/** The length of the longest run of words the two lines share in order (not necessarily adjacent). */
export function commonWords(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) row[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, row[j - 1]!);
    prev = row;
  }
  return prev[b.length]!;
}

/** A heard line found in the subtitle. */
export interface Anchor {
  heardS: number;
  /** The start of the first cue of the run it was found in. */
  cueS: number;
  score: number;
  /** The run is nearly the same words from its first word on, so its start is the line's start. */
  sharp: boolean;
}

interface Found {
  cueS: number;
  score: number;
  sharp: boolean;
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length === 0 ? 0 : sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** Every place a heard line is found at MATCH_SCORE or better, best first. */
function placesOf(heard: readonly string[], cueWords: readonly (readonly string[])[], cues: readonly SubCue[]): Found[] {
  const wanted = new Set(heard);
  const found: Found[] = [];
  for (let i = 0; i < cues.length; i++) {
    let run: string[] = [];
    let best: Found | null = null;
    for (let n = 0; n < MAX_RUN && i + n < cues.length; n++) {
      run = run.concat(cueWords[i + n]!);
      if (run.length === 0) continue;
      if (run.length > heard.length * 3) break;
      let shared = 0;
      for (const w of run) if (wanted.has(w)) shared += 1;
      if (shared < 2) continue;
      const common = commonWords(heard, run);
      const cover = common / heard.length;
      const fill = common / run.length;
      const score = cover + fill === 0 ? 0 : (2 * cover * fill) / (cover + fill);
      if (score >= MATCH_SCORE && (best === null || score > best.score)) {
        best = { cueS: cues[i]!.startS, score, sharp: cover >= 0.8 && fill >= 0.8 && heard[0] === run[0] };
      }
    }
    if (best !== null) found.push(best);
  }
  return found.sort((a, b) => b.score - a.score);
}

export interface TextMatch {
  /** Heard lines of MIN_LINE_WORDS words or more. */
  lines: number;
  /** How many of them the subtitle holds. */
  found: number;
  anchors: Anchor[];
}

/**
 * Looks every countable heard line up in the subtitle. A line said more than once in the film (a place for each) is
 * anchored to the place nearest the offset most lines agree on, so a repeated line does not pull the timing.
 */
export function matchLines(heard: readonly HeardLine[], cues: readonly SubCue[]): TextMatch {
  const cueWords = cues.map((c) => wordsOf(c.text));
  const lines = heard.map((h) => ({ h, words: wordsOf(h.text) })).filter((l) => l.words.length >= MIN_LINE_WORDS);
  const places = lines.map((l) => ({ heardS: l.h.startS, found: placesOf(l.words, cueWords, cues) })).filter((p) => p.found.length > 0);
  // First reading: each line's best place, a tie going to the place nearest the line's own time.
  const first = places.map((p) => {
    const top = p.found[0]!.score;
    return p.found.filter((f) => f.score >= top - 0.05).sort((a, b) => Math.abs(a.cueS - p.heardS) - Math.abs(b.cueS - p.heardS))[0]!;
  });
  const consensus = median(first.map((f, i) => f.cueS - places[i]!.heardS));
  const anchors = places.map((p): Anchor => {
    const top = p.found[0]!.score;
    const pick = p.found.filter((f) => f.score >= top - 0.05).sort((a, b) => Math.abs(a.cueS - p.heardS - consensus) - Math.abs(b.cueS - p.heardS - consensus))[0]!;
    return { heardS: p.heardS, cueS: pick.cueS, score: pick.score, sharp: pick.sharp };
  });
  return { lines: lines.length, found: anchors.length, anchors };
}

/** cue time = `stretch` x heard time + `shiftS`. In step: stretch 1, shift 0. */
export interface TimingFit {
  shiftS: number;
  stretch: number;
}

export interface Timing {
  fit: TimingFit;
  /** Anchors the fit was read from. */
  anchors: number;
  /** The share of them within ANCHOR_SLACK_S of the fit. */
  agree: number;
  /** How far the subtitle is from the speech at the start and at the end of the film, in seconds (cue minus speech). */
  offStartS: number;
  offEndS: number;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** The fix the anchors agree on, or null with too few of them. `durationS`: the film's length (null: the last anchor's time). */
export function timingOf(anchors: readonly Anchor[], durationS: number | null): Timing | null {
  const sharp = anchors.filter((a) => a.sharp);
  const used = sharp.length >= MIN_ANCHORS * 2 ? sharp : anchors;
  if (used.length < MIN_ANCHORS) return null;
  const endS = Math.max(durationS ?? 0, ...used.map((a) => a.heardS));
  const residuals = (fit: TimingFit): number[] => used.map((a) => a.cueS - (fit.stretch * a.heardS + fit.shiftS));
  const agreeOf = (fit: TimingFit): number => residuals(fit).filter((r) => Math.abs(r) <= ANCHOR_SLACK_S).length / used.length;
  const flat: TimingFit = { stretch: 1, shiftS: median(used.map((a) => a.cueS - a.heardS)) };
  let fit = flat;
  // A drift: the slope of offset over time, read from anchor pairs at least four minutes apart (Theil-Sen).
  const slopes: number[] = [];
  for (let i = 0; i < used.length; i++) {
    for (let j = i + 1; j < used.length; j++) {
      const dt = used[j]!.heardS - used[i]!.heardS;
      if (Math.abs(dt) >= 240) slopes.push((used[j]!.cueS - used[j]!.heardS - (used[i]!.cueS - used[i]!.heardS)) / dt);
    }
  }
  if (slopes.length >= 10) {
    const slope = median(slopes);
    const tilted: TimingFit = { stretch: 1 + slope, shiftS: median(used.map((a) => a.cueS - (1 + slope) * a.heardS)) };
    // Only a drift that matters over the film and that explains the anchors better than a plain shift.
    if (Math.abs(slope) * endS >= 0.4 && agreeOf(tilted) > agreeOf(flat) + 0.05) fit = tilted;
  }
  const off = (t: number): number => fit.stretch * t + fit.shiftS - t;
  return { fit: { shiftS: round3(fit.shiftS), stretch: fit.stretch }, anchors: used.length, agree: round3(agreeOf(fit)), offStartS: round3(off(0)), offEndS: round3(off(endS)) };
}

/** Offsets up to this far either way are tried for the onsets. */
export const ONSET_RANGE_S = 90;
/** A heard line agrees with an offset when a cue starts within this of it. */
export const ONSET_SLACK_S = 0.6;
/** Fewer heard lines than this give no onset fit. */
export const ONSET_MIN_LINES = 20;
/** The share of heard lines that must start with a cue at the best offset. */
export const ONSET_MIN_SHARE = 0.6;
/** The best offset must hold this many lines more than the best offset elsewhere, and this share of all lines more. */
export const ONSET_MIN_MARGIN = 10;
export const ONSET_MARGIN_SHARE = 0.15;
/** Another offset is "elsewhere" when it lies further than this from the best. */
const ONSET_APART_S = 2;
const ONSET_BIN_S = 0.25;
const ONSET_CANDIDATES = 12;

export interface OnsetFit {
  /** Cue start minus the moment the line is heard, at the offset most lines agree on. */
  shiftS: number;
  /** Heard lines (of any length). */
  lines: number;
  /** How many of them start with a cue at that offset. */
  matched: number;
  /** How many do at the best offset elsewhere: what chance alone gives. */
  rival: number;
  anchors: Anchor[];
}

/**
 * Whether the subtitle's cues start where the heard lines start, at one offset: the text test of a film heard through
 * translation, where words cannot be compared. Every line Whisper hears begins where somebody starts to speak, and so
 * does a cue of the film's own subtitle; any subtitle with many cues also lines up with a third or half of the lines
 * at *some* offset by chance. What tells them apart is how far the best offset stands out: measured on seven streams
 * against seventeen subtitle files (2026-11-20), the right file's best offset held 8 to 42 lines more than its best
 * offset elsewhere (64% to 93% of the lines), another film's at most 7. So it counts only with ONSET_MIN_SHARE of the
 * lines at the best offset and a lead of ONSET_MIN_MARGIN lines (and ONSET_MARGIN_SHARE of all lines) over the rest.
 * A file cut for another edit, or one that drifts (another frame rate), has no one offset and is not found this way.
 * Null when it does not count.
 */
export function onsetFit(heard: readonly HeardLine[], cues: readonly SubCue[]): OnsetFit | null {
  if (heard.length < ONSET_MIN_LINES || cues.length === 0) return null;
  const starts = cues.map((c) => c.startS);
  const bins = new Map<number, number>();
  let from = 0;
  for (const h of [...heard].sort((a, b) => a.startS - b.startS)) {
    while (from < starts.length && starts[from]! < h.startS - ONSET_RANGE_S) from += 1;
    for (let i = from; i < starts.length && starts[i]! <= h.startS + ONSET_RANGE_S; i++) {
      const bin = Math.round((starts[i]! - h.startS) / ONSET_BIN_S);
      bins.set(bin, (bins.get(bin) ?? 0) + 1);
    }
  }
  /** The cue start nearest to where the line would be at `offset`, when one lies within the slack. */
  const near = (h: HeardLine, offset: number): number | null => {
    let best: number | null = null;
    for (const c of starts) {
      const off = Math.abs(c - h.startS - offset);
      if (off <= ONSET_SLACK_S && (best === null || off < Math.abs(best - h.startS - offset))) best = c;
    }
    return best;
  };
  const count = (offset: number): number => heard.filter((h) => near(h, offset) !== null).length;
  const scored = [...bins]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, ONSET_CANDIDATES)
    .map(([bin]) => ({ offset: bin * ONSET_BIN_S, n: count(bin * ONSET_BIN_S) }))
    .sort((a, b) => b.n - a.n || Math.abs(a.offset) - Math.abs(b.offset));
  const best = scored[0];
  if (best === undefined) return null;
  const rival = scored.find((x) => Math.abs(x.offset - best.offset) > ONSET_APART_S)?.n ?? 0;
  const lead = best.n - rival;
  if (best.n / heard.length < ONSET_MIN_SHARE || lead < ONSET_MIN_MARGIN || lead < ONSET_MARGIN_SHARE * heard.length) return null;
  const anchors: Anchor[] = [];
  for (const h of heard) {
    const cueS = near(h, best.offset);
    if (cueS !== null) anchors.push({ heardS: h.startS, cueS, score: 1, sharp: false });
  }
  return { shiftS: round3(median(anchors.map((a) => a.cueS - a.heardS))), lines: heard.length, matched: best.n, rival, anchors };
}

export type TextVerdict = 'correct' | 'wrong' | 'unsure';
/** `in_step`: nothing to fix. `off`: one shift (and stretch) fixes it. `scattered`: no single fix does. `unknown`: too few anchors. */
export type TimingVerdict = 'in_step' | 'off' | 'scattered' | 'unknown';
/** `good`: right text, in step. `fixable`: right text, re-timing fixes it. `bad`: wrong text, or cut for another edit. `unsure`: too little to say. */
export type Grade = 'good' | 'fixable' | 'bad' | 'unsure';

export interface Judgement {
  grade: Grade;
  text: TextVerdict;
  timing: TimingVerdict;
  cues: number;
  heard_lines: number;
  found_lines: number;
  /** found_lines / heard_lines, 0 to 1. */
  text_share: number;
  /**
   * What `text: correct` rests on: the heard lines' `words` found in the subtitle, or, for a film heard through
   * translation whose words did not settle it, the `onsets` (the cues start where the lines start, at one offset).
   */
  matched_by: 'words' | 'onsets';
  /** The onset count when it decided: heard lines of any length, those that start with a cue at the best offset, and at the best offset elsewhere. */
  onsets: { lines: number; matched: number; rival: number } | null;
  anchors: number;
  /** The share of anchors that agree with the fix; null without a timing. */
  agree: number | null;
  /** Cue minus speech at the start and the end of the film, in seconds; null without a timing. */
  off_start_s: number | null;
  off_end_s: number | null;
  fit: TimingFit | null;
  /**
   * The same offset (cue minus speech, the median) at each place lines were found, in film order: what `scattered`
   * looks like. One number everywhere is in step or a plain shift, a steady climb a stretch, steps a file cut for
   * another edit. `spread_s`: how far the place's own lines disagree. Empty for a wrong text.
   */
  by_place: Array<{ at_s: number; lines: number; off_s: number; spread_s: number }>;
}

/** Anchors further apart than this were heard at different places. */
export const PLACE_GAP_S = 90;

/** The anchors' offsets per place heard. */
export function offsetsByPlace(anchors: readonly Anchor[]): Judgement['by_place'] {
  const sorted = [...anchors].sort((a, b) => a.heardS - b.heardS);
  const groups: Anchor[][] = [];
  for (const a of sorted) {
    const last = groups[groups.length - 1];
    if (last !== undefined && a.heardS - last[last.length - 1]!.heardS <= PLACE_GAP_S) last.push(a);
    else groups.push([a]);
  }
  return groups.map((g) => {
    const offs = g.map((a) => a.cueS - a.heardS);
    return { at_s: Math.round(g[0]!.heardS), lines: g.length, off_s: round3(median(offs)), spread_s: round3(Math.max(...offs) - Math.min(...offs)) };
  });
}

/** Judges one subtitle against what was heard. */
export function judge(vtt: string, heard: readonly HeardLine[], durationS: number | null, options: { translated?: boolean } = {}): Judgement {
  const cues = parseSubCues(vtt);
  const match = matchLines(heard, cues);
  const share = match.lines === 0 ? 0 : match.found / match.lines;
  let text: TextVerdict = match.lines < MIN_HEARD_LINES ? 'unsure' : share >= CORRECT_SHARE ? 'correct' : share <= WRONG_SHARE ? 'wrong' : 'unsure';
  let anchors = match.anchors;
  // Heard through translation, the words say little either way: the lines' starts decide, when they can.
  const onsets = options.translated === true && text !== 'correct' ? onsetFit(heard, cues) : null;
  if (onsets !== null) {
    text = 'correct';
    anchors = onsets.anchors;
  }
  // The few lines another film's subtitle shares by chance say nothing of its timing.
  const timing = text === 'wrong' ? null : timingOf(anchors, durationS);
  const timingVerdict: TimingVerdict =
    timing === null ? 'unknown' : timing.agree < AGREE_SHARE ? 'scattered' : Math.abs(timing.offStartS) <= IN_STEP_S && Math.abs(timing.offEndS) <= IN_STEP_S ? 'in_step' : 'off';
  const grade: Grade =
    text === 'wrong' ? 'bad' : text === 'unsure' || timingVerdict === 'unknown' ? 'unsure' : timingVerdict === 'in_step' ? 'good' : timingVerdict === 'off' ? 'fixable' : 'bad';
  return {
    grade,
    text,
    timing: timingVerdict,
    cues: cues.length,
    heard_lines: match.lines,
    found_lines: match.found,
    text_share: round3(share),
    matched_by: onsets === null ? 'words' : 'onsets',
    onsets: onsets === null ? null : { lines: onsets.lines, matched: onsets.matched, rival: onsets.rival },
    anchors: timing?.anchors ?? anchors.length,
    agree: timing?.agree ?? null,
    off_start_s: timing?.offStartS ?? null,
    off_end_s: timing?.offEndS ?? null,
    fit: timing?.fit ?? null,
    by_place: text === 'wrong' ? [] : offsetsByPlace(anchors),
  };
}

function stamp(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
}

/**
 * The subtitle with every cue moved to where its line is heard: film time = (cue time - shift) / stretch, less
 * CUE_LEAD_S so a cue is up just before its line. A cue that would start before the film is dropped. Always WebVTT.
 */
export function retime(vtt: string, fit: TimingFit): string {
  const move = (t: number): number => (t - fit.shiftS) / fit.stretch - CUE_LEAD_S;
  const out: string[] = ['WEBVTT', ''];
  for (const cue of parseSubCues(vtt)) {
    const start = move(cue.startS);
    const end = move(cue.endS);
    if (end <= 0) continue;
    out.push(`${stamp(start)} --> ${stamp(Math.max(end, start + 0.3))}`, cue.text, '');
  }
  return out.join('\n');
}
