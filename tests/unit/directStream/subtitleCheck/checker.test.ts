import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Candidate } from '../../../../src/directStream/subtitleCheck/candidates.js';
import { CHECKED_LABEL, SubtitleChecker, WINDOW_S, windowStarts, type CheckSubject } from '../../../../src/directStream/subtitleCheck/checker.js';
import { parseSubCues } from '../../../../src/directStream/subtitleCheck/match.js';
import type { AudioCutter, Transcriber, WhisperCue } from '../../../../src/directStream/torrent/subtitles/whisper.js';

const DURATION = 2400;
const WORDS = ['river', 'candle', 'stone', 'window', 'garden', 'letter', 'silver', 'morning', 'winter', 'doctor', 'kitchen', 'brother', 'engine', 'yellow', 'paper', 'north'];
/** Line `i` of film `salt`: another film speaks other words. */
const lineOf = (i: number, salt = 0): string => [0, 1, 2, 3, 4, 5].map((k) => WORDS[(i * (k + 3) + k * 7 + ((i * i) % 11)) % WORDS.length]! + (salt === 0 ? '' : 'q' + salt)).join(' ') + ' ' + (i + salt * 1000);
const stamp = (s: number): string => new Date(Math.round(s * 1000)).toISOString().slice(11, 23);
/** One line every 5 s, so every minute heard holds twelve. */
const film = (salt = 0, shiftS = 0): string =>
  'WEBVTT\n\n' + Array.from({ length: 470 }, (_, i) => stamp(20 + i * 5 + shiftS) + ' --> ' + stamp(22 + i * 5 + shiftS) + '\n' + lineOf(i, salt) + '\n').join('\n');

/** The "film": what is said at each time, read from the true subtitle. The cutter names the window in the WAV's path; the transcriber answers its lines. */
function fakes(options: { silent?: boolean; failCutAt?: number } = {}): { cutter: AudioCutter; transcriber: Transcriber; cuts: number[]; stops: () => number } {
  const truth = parseSubCues(film());
  const windows = new Map<string, number>();
  const cuts: number[] = [];
  let stops = 0;
  return {
    cuts,
    stops: () => stops,
    cutter: async (request) => {
      cuts.push(request.startS);
      if (options.failCutAt === request.startS) return { ok: false, reason: 'the file route sent nothing' };
      windows.set(request.out, request.startS);
      return { ok: true, lengthS: Math.max(0, Math.min(request.lengthS, DURATION - request.startS)) };
    },
    transcriber: {
      transcribe: async ({ wav }): Promise<WhisperCue[]> => {
        const at = windows.get(wav) ?? 0;
        if (options.silent === true) return [];
        return truth.filter((c) => c.startS >= at && c.startS < at + WINDOW_S).map((c) => ({ start_s: c.startS - at + 0.1, end_s: c.endS - at, text: c.text }));
      },
      detect: async () => null,
      stop: async () => {
        stops += 1;
      },
    },
  };
}

function subject(over: Partial<CheckSubject> & { shown?: string | null; others?: Candidate[] }, kept: string[]): CheckSubject {
  return {
    key: 'tv-1-s1e2',
    ref: { kind: 'tv', tmdbId: 1, season: 1, episode: 2 },
    title: 'A Series S01E02',
    mode: 'live',
    source: 'torrent',
    provider: 'Torrent',
    sessionId: 'sess',
    durationS: DURATION,
    audioLang: 'en',
    input: () => ({ url: '/film.mkv' }),
    current: async () => (over.shown === null ? null : { label: 'English (Wyzie)', vtt: over.shown ?? film() }),
    candidates: async function* () {
      yield* over.others ?? [];
    },
    keep: async (vtt) => {
      kept.push(vtt);
      return { url: '/api/stream/torrent/x/sub/checked-1.vtt', lang: 'en', label: CHECKED_LABEL };
    },
    ...over,
  };
}

describe('windowStarts', () => {
  it('spreads six windows over the film, then five more between them', () => {
    expect(windowStarts(2400, false)).toEqual([48, 480, 960, 1440, 1920, 2232]);
    expect(windowStarts(2400, true)).toEqual([240, 720, 1200, 1680, 2088]);
  });

  it('hears a short clip once and a film of unknown length at fixed places', () => {
    expect(windowStarts(90, false)).toEqual([0]);
    expect(windowStarts(null, false)[0]).toBe(60);
    expect(windowStarts(null, true)).toEqual([]);
  });
});

describe('SubtitleChecker', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'subcheck-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const checker = (f: ReturnType<typeof fakes>): SubtitleChecker => new SubtitleChecker({ ...f, workDir: dir, log: () => undefined });

  it('leaves a right subtitle in step alone', async () => {
    const kept: string[] = [];
    const f = fakes();
    const out = await checker(f).check(subject({}, kept));
    expect(out).toMatchObject({ verdict: 'ok', changed: false, chosen: null, tried: [] });
    expect(out.current).toMatchObject({ grade: 'good', text: 'correct', timing: 'in_step' });
    expect(out.heard.lines).toBeGreaterThanOrEqual(30);
    expect(f.cuts).toHaveLength(6);
    expect(kept).toEqual([]);
  });

  it('re-times the right subtitle shown late, without asking for another', async () => {
    const kept: string[] = [];
    let asked = false;
    const out = await checker(fakes()).check(
      subject(
        {
          shown: film(0, 8),
          candidates: async function* () {
            asked = true;
            yield* [];
          },
        },
        kept,
      ),
    );
    expect(out).toMatchObject({ verdict: 'retimed', changed: true });
    expect(out.chosen).toMatchObject({ from: 'the subtitle shown', retimed: true, label: CHECKED_LABEL });
    expect(out.chosen!.shift_s).toBeCloseTo(7.9, 0);
    expect(asked).toBe(false);
    // The kept file is back in step: its first cue is where the first line is said.
    expect(parseSubCues(kept[0]!)[0]!.startS).toBeCloseTo(20, 0);
  });

  it("replaces another episode's subtitle with the first file that is right and in step", async () => {
    const kept: string[] = [];
    const out = await checker(fakes()).check(
      subject(
        {
          shown: film(1),
          others: [
            { from: 'wyzie', name: 'Series.S01E01.BluRay', vtt: film(2) },
            { from: 'wyzie', name: 'Series.S01E02.WEB', vtt: film() },
            { from: 'opensubtitles', name: 'never reached', vtt: film() },
          ],
        },
        kept,
      ),
    );
    expect(out).toMatchObject({ verdict: 'replaced', changed: true });
    expect(out.current).toMatchObject({ grade: 'bad', text: 'wrong' });
    expect(out.tried.map((t) => [t.name, t.grade])).toEqual([
      ['Series.S01E01.BluRay', 'bad'],
      ['Series.S01E02.WEB', 'good'],
    ]);
    expect(out.chosen).toMatchObject({ from: 'wyzie', name: 'Series.S01E02.WEB', retimed: false });
    expect(kept).toEqual([film()]);
  });

  it('re-times a candidate that is right but early, and keeps the re-timed text', async () => {
    const kept: string[] = [];
    const out = await checker(fakes()).check(subject({ shown: null, others: [{ from: 'opensubtitles', name: 'Series.S01E02.DVDRip', vtt: film(0, -15) }] }, kept));
    expect(out).toMatchObject({ verdict: 'replaced', current: null });
    expect(out.chosen).toMatchObject({ retimed: true });
    expect(out.tried[0]).toMatchObject({ retimed: true, grade: 'good' });
    expect(parseSubCues(kept[0]!)[0]!.startS).toBeCloseTo(20, 0);
  });

  it('prefers a file that is right as it is over an earlier one that had to be re-timed', async () => {
    const kept: string[] = [];
    const out = await checker(fakes()).check(
      subject({ shown: film(1), others: [{ from: 'wyzie', name: 'PAL', vtt: film(0, -15) }, { from: 'wyzie', name: 'other', vtt: film(2) }, { from: 'wyzie', name: 'WEB', vtt: film() }] }, kept),
    );
    expect(out.chosen).toMatchObject({ name: 'WEB', retimed: false });
    expect(out.tried.map((t) => t.name)).toEqual(['PAL', 'other', 'WEB']);
    expect(kept).toEqual([film()]);
  });

  it('keeps the re-timed file when none right as it is follows within three more', async () => {
    const kept: string[] = [];
    const wrong = (n: number): Candidate => ({ from: 'wyzie', name: 'w' + n, vtt: film(n) });
    const out = await checker(fakes()).check(subject({ shown: film(1), others: [{ from: 'wyzie', name: 'PAL', vtt: film(0, -15) }, wrong(2), wrong(3), wrong(4), { from: 'wyzie', name: 'too far', vtt: film() }] }, kept));
    expect(out.chosen).toMatchObject({ name: 'PAL', retimed: true });
    expect(out.tried).toHaveLength(4);
  });

  it('changes nothing when no file passes', async () => {
    const kept: string[] = [];
    const out = await checker(fakes()).check(subject({ shown: film(1), others: [{ from: 'wyzie', name: 'x', vtt: film(2) }] }, kept));
    expect(out).toMatchObject({ verdict: 'none_fits', changed: false, chosen: null });
    expect(kept).toEqual([]);
  });

  it('changes nothing when too little was heard, after listening at eleven places', async () => {
    const kept: string[] = [];
    const f = fakes({ silent: true });
    const out = await checker(f).check(subject({ shown: film(1), others: [{ from: 'wyzie', name: 'x', vtt: film() }] }, kept));
    expect(out).toMatchObject({ verdict: 'unheard', changed: false });
    expect(f.cuts).toHaveLength(11);
    expect(kept).toEqual([]);
  });

  it('passes over a window that cannot be cut and says so', async () => {
    const out = await checker(fakes({ failCutAt: 960 })).check(subject({}, []));
    expect(out.verdict).toBe('ok');
    expect(out.heard.windows.find((w) => w.at_s === 960)).toMatchObject({ lines: null, problem: expect.stringContaining('the file route sent nothing') });
  });

  it('does not judge a growing track', async () => {
    const out = await checker(fakes()).check(subject({ current: async () => ({ label: 'English (Whisper)', skip: 'it grows while the film plays' }) }, []));
    expect(out).toMatchObject({ verdict: 'unsure', changed: false, current: { label: 'English (Whisper)', skipped: 'it grows while the film plays' } });
  });

  it('answers pending past the wait, joins the same check, and hands its outcome over once', async () => {
    const f = fakes();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let built = 0;
    const c = checker(f);
    const make = async (): Promise<CheckSubject> => {
      built += 1;
      await gate;
      return subject({}, []);
    };
    const first = await c.within('k', make, 10);
    expect(first).toMatchObject({ pending: true, stage: 'reading the session' });
    release();
    const second = await c.within('k', make, 5_000);
    expect(second).toMatchObject({ verdict: 'ok' });
    expect(built).toBe(1);
    // The outcome was collected: the next call is a new check.
    await c.within('k', make, 5_000);
    expect(built).toBe(2);
    expect(f.stops()).toBeGreaterThanOrEqual(1);
  });
});
