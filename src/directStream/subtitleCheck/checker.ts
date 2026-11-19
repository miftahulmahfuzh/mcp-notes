import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { CacheSubtitleView } from '../cachePlay.js';
import type { StreamRef } from '../types.js';
import type { SyncInput } from '../torrent/subtitles/synced.js';
import { whisperTask, type AudioCutter, type Transcriber, type WhisperTask } from '../torrent/subtitles/whisper.js';
import { withoutSecrets } from '../torrent/subtitles/wyzie.js';
import type { Candidate } from './candidates.js';
import { judge, MIN_HEARD_LINES, MIN_LINE_WORDS, retime, wordsOf, type HeardLine, type Judgement } from './match.js';

/**
 * /sync-subtitle (direct_stream_sync_subtitle): is the subtitle of this film the right one, and in step with what is
 * said? Unlike Wyzie Synced (torrent/subtitles/synced.ts), which asks a service to line a subtitle up and trusts its
 * answer, this hears the film itself:
 *
 * 1. **Hear.** ffmpeg cuts a minute of audio at six places spread over the film (more when little was said there),
 *    and Whisper writes down what is said in each, with its times. With a hint (a time the owner named, or the
 *    minute around the position of the stream on screen) that stretch is heard first: when enough is said there, only the
 *    film's two ends are heard beside it, and the other places only when those three did not settle it.
 * 2. **Judge the subtitle that is shown** against those lines (match.ts): right text and in step is `ok`, and
 *    nothing changes.
 * 3. **Otherwise find one.** Right text but late, early or drifting: the same subtitle is re-timed by the offsets
 *    the lines agree on. Wrong text (another episode's file), or cut for another edit: the subtitle services' other
 *    files are tried one by one, each judged the same way, re-timed when that is all it lacks, and judged again.
 *    A file that is right as it is comes before one that had to be re-timed: after the first that needed it,
 *    LOOK_FURTHER more are tried.
 * 4. **Keep and show.** The first that is right and in step is kept as the film's chosen subtitle (a torrent's
 *    `checked-<file>.vtt`, a title's `checked.vtt`), so the next play starts with it, and put on the live session:
 *    its `subtitleRev` goes up and the open page loads it on its next position report.
 *
 * Nothing is changed unless a subtitle passed both checks. A check runs as a job: an answer that would outlast the
 * MCP client's time limit says `pending`, and the same call again joins it.
 */

export const CHECKED_LABEL = 'English (checked)';
/** Seconds of audio heard at each place. */
export const WINDOW_S = 60;
/** Where the first six windows start, as shares of the film; the next five are heard only when the first said too little. */
export const FIRST_WINDOWS: readonly number[] = [0.02, 0.2, 0.4, 0.6, 0.8, 0.93];
export const MORE_WINDOWS: readonly number[] = [0.1, 0.3, 0.5, 0.7, 0.87];
/** Where to listen in a film of unknown length, in seconds; a window past the end is cut short and passed over. */
export const BLIND_WINDOWS_S: readonly number[] = [60, 480, 960, 1500, 2100, 2700, 3600, 4800, 6000];
/** Countable heard lines that are plenty: no further window is cut. */
export const ENOUGH_LINES = 30;
/** A window whose bytes do not come in this long (a torrent still downloading, a slow host) is passed over. */
export const WINDOW_CUT_TIMEOUT_MS = 90_000;
/** A hinted stretch is this long at least, and at most HINT_MAX_S when the owner named a range. */
export const HINT_MAX_S = 180;
/** A named moment is heard from this many seconds before it. */
export const HINT_LEAD_S = 10;
/** The hint of a stream on screen starts this long before the player's position: half behind it, half ahead. */
export const HINT_BEHIND_S = 30;
/** Countable lines the hinted stretch must give for the short round (the hint and the film's two ends). */
export const HINT_MIN_LINES = MIN_HEARD_LINES;
/** The short round settles a check only with SPREAD_LINES lines heard in each of two windows this far apart: a drift shows over a distance only. */
export const SPREAD_S = 240;
export const SPREAD_LINES = 3;
/** After a candidate that is right once re-timed, this many more are tried for one that is right as it is. */
export const LOOK_FURTHER = 3;
/** A finished check is kept this long for the call that was told `pending`. */
export const RESULT_KEEP_MS = 10 * 60_000;

/** What the checker needs of one film: where its audio and its subtitle are, and how a better one is kept and shown. */
export interface CheckSubject {
  /** Names the job: one check runs per film at a time. */
  key: string;
  ref: StreamRef;
  /** "American Horror Story S01E02". */
  title: string;
  /** `live`: a session of it is open in the player and gets the subtitle at once; `idle`: the next play gets it. */
  mode: 'live' | 'idle';
  source: 'torrent' | 'cloud';
  provider: string;
  sessionId: string | null;
  durationS: number | null;
  /** The title's original language (TMDB's code), or null. */
  audioLang: string | null;
  /** Where people are known to talk: heard first (see the file comment). Null or absent: the usual places only. */
  hint?: CheckHint | null;
  /** What ffmpeg reads the audio from; read again for every window. */
  input(): SyncInput | Promise<SyncInput>;
  /** The subtitle shown now: its text, or why it cannot be read (`skip`), or null when there is none. */
  current(): Promise<{ label: string; vtt: string } | { label: string; skip: string } | null>;
  /** The other subtitles to try, in order. */
  candidates(notes: string[]): AsyncGenerator<Candidate>;
  /** Keeps `vtt` as the film's chosen subtitle and puts it on the live session, if any. */
  keep(vtt: string): Promise<CacheSubtitleView>;
}

/** A stretch to hear first. `asked`: the owner named the time; `position`: the minute around where the player on screen is. */
export interface CheckHint {
  startS: number;
  lengthS: number;
  from: 'asked' | 'position';
}

/** The stretch for a moment the owner named (heard from HINT_LEAD_S before it, a minute long) or a range (as asked, a minute to HINT_MAX_S). */
export function hintAt(fromS: number, toS: number | null): CheckHint {
  if (toS === null) return { startS: Math.max(0, fromS - HINT_LEAD_S), lengthS: WINDOW_S, from: 'asked' };
  return { startS: Math.max(0, fromS), lengthS: Math.min(HINT_MAX_S, Math.max(WINDOW_S, toS - fromS)), from: 'asked' };
}

/**
 * The minute around where the player is: half behind the position, half ahead. The owner asks while people talk, or
 * pauses as they start, and a stretch that only looked back missed a conversation that had just begun.
 */
export function hintFromPosition(positionS: number): CheckHint | null {
  if (!Number.isFinite(positionS) || positionS < 0) return null;
  return { startS: Math.max(0, Math.floor(positionS) - HINT_BEHIND_S), lengthS: WINDOW_S, from: 'position' };
}

export interface HeardWindow {
  at_s: number;
  length_s: number;
  /** True for the hinted stretch. */
  hint?: true;
  /** Lines of MIN_LINE_WORDS words or more heard in it; null when it could not be cut or transcribed. */
  lines: number | null;
  problem?: string;
}

export type CheckVerdict = 'ok' | 'retimed' | 'replaced' | 'none_fits' | 'unsure' | 'unheard';

export interface CheckResult {
  verdict: CheckVerdict;
  /** True when the film's subtitle is another file, or the same one re-timed, than before the check. */
  changed: boolean;
  title: string;
  mode: 'live' | 'idle';
  source: 'torrent' | 'cloud';
  provider: string;
  session_id: string | null;
  heard: {
    task: WhisperTask;
    lines: number;
    windows: HeardWindow[];
    /** The stretch heard first, and whether it (with the film's two ends) settled the check; null without a hint. */
    hint: { at_s: number; length_s: number; from: CheckHint['from']; lines: number; enough: boolean } | null;
  };
  /** The subtitle that was shown, judged; null when there was none. */
  current: ({ label: string } & (Judgement | { skipped: string })) | null;
  /** Every other subtitle tried, in order. */
  tried: Array<{ from: string; name: string | null; retimed: boolean } & Judgement>;
  /** The subtitle now kept and shown, when `changed`. */
  chosen: { from: string; name: string | null; label: string; retimed: boolean; shift_s: number | null; stretch: number | null; url: string } | null;
  notes: string[];
  took_s: number;
}

export interface PendingCheck {
  pending: true;
  since: string;
  waited_s: number;
  stage: string;
}

export interface SubtitleCheckerOptions {
  cutter: AudioCutter;
  transcriber: Transcriber;
  /** WAVs of the window in progress are written here and removed. */
  workDir: string;
  now?: () => number;
  log?: (line: string) => void;
}

interface Job {
  promise: Promise<CheckResult>;
  since: number;
  stage: string;
  /** Set when the job ended. */
  done: { at: number; result: CheckResult | null; error: unknown } | null;
  /** A caller was told `pending`, so the outcome is kept for its next call. */
  awaited: boolean;
}

const messageOf = (err: unknown): string => withoutSecrets(err instanceof Error ? err.message : String(err));
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Where the windows start for a film of this length, the first batch or the second. */
export function windowStarts(durationS: number | null, more: boolean): number[] {
  if (durationS === null || !(durationS > 0)) return more ? [] : [...BLIND_WINDOWS_S];
  if (durationS <= WINDOW_S * 2) return more ? [] : [0];
  const last = Math.max(0, durationS - WINDOW_S - 5);
  const starts = (more ? MORE_WINDOWS : FIRST_WINDOWS).map((share) => Math.min(last, Math.round(share * durationS)));
  return [...new Set(starts)];
}

interface Stretch {
  startS: number;
  lengthS: number;
  hint?: true;
}

/** True when two windows that each gave SPREAD_LINES lines lie SPREAD_S apart. */
function spreadOut(windows: readonly HeardWindow[]): boolean {
  const said = windows.filter((w) => (w.lines ?? 0) >= SPREAD_LINES).map((w) => w.at_s);
  return said.length >= 2 && Math.max(...said) - Math.min(...said) >= SPREAD_S;
}

const clock = (s: number): string => {
  const t = Math.max(0, Math.round(s));
  const mm = String(Math.floor(t / 60) % 60).padStart(t >= 3600 ? 2 : 1, '0');
  return (t >= 3600 ? Math.floor(t / 3600) + ':' : '') + mm + ':' + String(t % 60).padStart(2, '0');
};

const countable = (lines: readonly HeardLine[]): number => lines.filter((l) => wordsOf(l.text).length >= MIN_LINE_WORDS).length;

export class SubtitleChecker {
  private readonly jobs = new Map<string, Job>();
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private running = 0;

  constructor(private readonly opts: SubtitleCheckerOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((line: string) => console.log(line));
  }

  /**
   * The check of one film, answered within `waitMs` or as `pending`. `subject` is asked for only when no check of
   * `key` runs: a second call joins the first. Rejects with what the subject or the check threw.
   */
  async within(key: string, subject: () => Promise<CheckSubject>, waitMs: number): Promise<CheckResult | PendingCheck> {
    const job = this.jobFor(key, subject);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), Math.max(0, waitMs));
    });
    try {
      const got = await Promise.race([job.promise, late]);
      if (got !== 'late') {
        this.jobs.delete(key);
        return got;
      }
      job.awaited = true;
      return { pending: true, since: new Date(job.since).toISOString(), waited_s: round1((this.now() - job.since) / 1000), stage: job.stage };
    } catch (err) {
      this.jobs.delete(key);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Ends the Whisper worker: notesd is stopping. */
  async close(): Promise<void> {
    await this.opts.transcriber.stop();
  }

  private jobFor(key: string, subject: () => Promise<CheckSubject>): Job {
    const known = this.jobs.get(key);
    // A running check is joined; a finished one is handed to the caller that was told to come back, once.
    if (known !== undefined && (known.done === null || (known.awaited && this.now() - known.done.at < RESULT_KEEP_MS))) return known;
    const job: Job = { promise: Promise.resolve(null as never), since: this.now(), stage: 'reading the session', done: null, awaited: false };
    this.running += 1;
    job.promise = subject()
      .then((s) => this.check(s, (stage) => (job.stage = stage)))
      .then(
        (result) => {
          job.done = { at: this.now(), result, error: null };
          return result;
        },
        (error: unknown) => {
          job.done = { at: this.now(), result: null, error };
          throw error;
        },
      )
      .finally(() => {
        this.running -= 1;
        // Nothing left to hear: the worker's memory (about 850 MB with `small`) goes back.
        if (this.running === 0) void this.opts.transcriber.stop();
      });
    job.promise.catch(() => undefined);
    this.jobs.set(key, job);
    return job;
  }

  /** One check, start to end. */
  async check(subject: CheckSubject, stage: (text: string) => void = () => undefined): Promise<CheckResult> {
    const started = this.now();
    const notes: string[] = [];
    const { task, language } = whisperTask(subject.audioLang);
    const windows: HeardWindow[] = [];
    const heard: HeardLine[] = [];
    let hinted: CheckResult['heard']['hint'] = null;
    const result = (verdict: CheckVerdict, rest: Pick<CheckResult, 'current' | 'tried' | 'chosen'>): CheckResult => {
      const out: CheckResult = {
        verdict,
        changed: rest.chosen !== null,
        title: subject.title,
        mode: subject.mode,
        source: subject.source,
        provider: subject.provider,
        session_id: subject.sessionId,
        heard: { task, lines: countable(heard), windows, hint: hinted },
        ...rest,
        notes,
        took_s: round1((this.now() - started) / 1000),
      };
      this.log(
        '[notesd] subtitle check: ' + subject.title + ' (' + subject.source + ', ' + subject.mode + '): ' + verdict +
          (rest.chosen === null ? '' : ', now ' + rest.chosen.from + (rest.chosen.name === null ? '' : ' ' + rest.chosen.name) + (rest.chosen.retimed ? ' re-timed' : '')) +
          ', ' + out.heard.lines + ' line(s) heard in ' + windows.filter((w) => w.lines !== null).length + ' window(s)' +
          (hinted === null ? '' : ', hint at ' + clock(hinted.at_s) + ' (' + hinted.from + (hinted.enough ? ', enough' : ', not enough') + ')') + ', ' + out.took_s + ' s',
      );
      return out;
    };

    /** A film heard through translation is matched by where its lines start when the words do not settle it (match.ts onsetFit). */
    const translated = { translated: task === 'translate' };
    if (task === 'translate') {
      notes.push('The film is not in English: Whisper translated what it heard, whose wording is not a subtitle\'s. Where the words did not settle it, a subtitle was matched by where its lines start (matched_by: onsets): right when its cues start with the heard lines at one offset that stands clear of every other. A file cut for another edit or one that drifts cannot be matched that way and stays wrong or unsure.');
    }
    /** `vtt` re-timed by its own fit, when that makes it good. */
    const fixed = (vtt: string, was: Judgement): { vtt: string; now: Judgement } | null => {
      if (was.grade !== 'fixable' || was.fit === null) return null;
      const moved = retime(vtt, was.fit);
      const now = judge(moved, heard, subject.durationS, translated);
      return now.grade === 'good' ? { vtt: moved, now } : null;
    };
    const how = { task, language };
    const hear = (stretches: readonly Stretch[]): Promise<void> => this.hear(subject, stretches, how, windows, heard, stage);
    let hint: Stretch | null = null;
    if (subject.hint != null && subject.hint.lengthS > 0) {
      const { startS, lengthS } = subject.hint;
      // A time past the end of the film: its last stretch.
      hint = { startS: subject.durationS !== null && subject.durationS > 0 ? Math.max(0, Math.min(startS, subject.durationS - lengthS - 5)) : startS, lengthS, hint: true };
    }
    /** The usual places, less any the hinted stretch already covers (a line heard twice would count twice). */
    const usual = (more: boolean): Stretch[] =>
      windowStarts(subject.durationS, more)
        .filter((s) => hint === null || s + WINDOW_S <= hint.startS || s >= hint.startS + hint.lengthS)
        .map((s) => ({ startS: s, lengthS: WINDOW_S }));
    let rest = usual(false);
    let shown: Awaited<ReturnType<CheckSubject['current']>> | undefined;
    stage('listening to the film');
    if (hint !== null && subject.hint != null) {
      await hear([hint]);
      hinted = { at_s: hint.startS, length_s: hint.lengthS, from: subject.hint.from, lines: countable(heard), enough: false };
      const where = hinted.from === 'asked' ? 'the stretch named, from ' + clock(hint.startS) : 'the minute around where the player is, from ' + clock(hint.startS);
      if (hinted.lines < HINT_MIN_LINES) {
        notes.push('Little was said in ' + where + ' (' + hinted.lines + ' line(s) of ' + MIN_LINE_WORDS + ' words or more), so the film was heard at its usual places as well.');
      } else if (subject.durationS !== null && subject.durationS > 0 && rest.length > 0) {
        // The short round: the film's two ends beside the hint, which is all a shift and a drift need.
        const ends = rest.length === 1 ? rest : [rest[0]!, rest[rest.length - 1]!];
        rest = rest.filter((s) => !ends.includes(s));
        await hear(ends);
        if (spreadOut(windows)) {
          heard.sort((a, b) => a.startS - b.startS);
          shown = await subject.current();
          const quick = shown !== null && 'vtt' in shown ? judge(shown.vtt, heard, subject.durationS, translated) : null;
          hinted.enough = quick !== null && shown !== null && 'vtt' in shown && (quick.grade === 'good' || fixed(shown.vtt, quick) !== null);
        }
        if (!hinted.enough) notes.push(where.charAt(0).toUpperCase() + where.slice(1) + ', and the film\'s two ends did not settle it, so the rest of the usual places were heard as well.');
      } else {
        notes.push('The length of the film is not known here (a source resolved out of sight), so its two ends could not be picked beside ' + where + ': the usual places were heard as well. A stream on screen has a length.');
      }
    }
    if (hinted === null || !hinted.enough) {
      await hear(rest);
      if (countable(heard) < ENOUGH_LINES) await hear(usual(true));
    }
    heard.sort((a, b) => a.startS - b.startS);
    windows.sort((a, b) => a.at_s - b.at_s);

    stage('judging the subtitle shown now');
    if (shown === undefined) shown = await subject.current();
    const current: CheckResult['current'] = shown === null ? null : 'skip' in shown ? { label: shown.label, skipped: shown.skip } : { label: shown.label, ...judge(shown.vtt, heard, subject.durationS, translated) };
    if (countable(heard) < MIN_HEARD_LINES) {
      notes.push('Too little speech was heard to judge a subtitle (' + countable(heard) + ' line(s) of ' + MIN_LINE_WORDS + ' words or more; ' + MIN_HEARD_LINES + ' are needed). Nothing was changed.');
      return result('unheard', { current, tried: [], chosen: null });
    }
    if (current !== null && 'skipped' in current) {
      notes.push('The subtitle shown could not be read as a file (' + current.skipped + '), so it was not judged and not replaced.');
      return result('unsure', { current, tried: [], chosen: null });
    }
    if (current !== null && current.grade === 'good') return result('ok', { current, tried: [], chosen: null });

    const keep = async (vtt: string, from: string, name: string | null, fixed: Judgement | null): Promise<NonNullable<CheckResult['chosen']>> => {
      stage('keeping the subtitle');
      const view = await subject.keep(vtt);
      return { from, name, label: view.label, retimed: fixed !== null, shift_s: fixed?.fit?.shiftS ?? null, stretch: fixed?.fit?.stretch ?? null, url: view.url };
    };
    // The right subtitle at the wrong time: the same file, re-timed.
    if (shown !== null && 'vtt' in shown && current !== null && !('skipped' in current)) {
      const again = fixed(shown.vtt, current);
      if (again !== null) return result('retimed', { current, tried: [], chosen: await keep(again.vtt, 'the subtitle shown', null, current) });
    }

    const tried: CheckResult['tried'] = [];
    /** The first candidate that is right once re-timed: kept unless one right as it is follows soon. */
    let moved: { candidate: Candidate; vtt: string; was: Judgement; left: number } | null = null;
    stage('trying other subtitles');
    for await (const candidate of subject.candidates(notes)) {
      const was = judge(candidate.vtt, heard, subject.durationS, translated);
      stage('trying other subtitles (' + (tried.length + 1) + ' so far)');
      if (was.grade === 'good') {
        tried.push({ from: candidate.from, name: candidate.name, retimed: false, ...was });
        return result('replaced', { current, tried, chosen: await keep(candidate.vtt, candidate.from, candidate.name, null) });
      }
      const again: { vtt: string; now: Judgement } | null = moved === null ? fixed(candidate.vtt, was) : null;
      if (again !== null) {
        tried.push({ from: candidate.from, name: candidate.name, retimed: true, ...again.now });
        moved = { candidate, vtt: again.vtt, was, left: LOOK_FURTHER };
        continue;
      }
      tried.push({ from: candidate.from, name: candidate.name, retimed: false, ...was });
      if (moved !== null && (moved.left -= 1) <= 0) break;
    }
    if (moved !== null) return result('replaced', { current, tried, chosen: await keep(moved.vtt, moved.candidate.from, moved.candidate.name, moved.was) });
    if (current !== null && current.grade === 'unsure') return result('unsure', { current, tried, chosen: null });
    return result('none_fits', { current, tried, chosen: null });
  }

  /** Cuts and transcribes the `stretches`, in order; a window that fails is recorded and passed over. Never throws. */
  private async hear(
    subject: CheckSubject,
    stretches: readonly Stretch[],
    how: { task: WhisperTask; language: string | null },
    windows: HeardWindow[],
    heard: HeardLine[],
    stage: (text: string) => void,
  ): Promise<void> {
    const signal = new AbortController().signal;
    await mkdir(this.opts.workDir, { recursive: true });
    let short = false;
    for (const [i, { startS, lengthS, hint }] of stretches.entries()) {
      const mark = hint === true ? { hint } : {};
      // A film of unknown length: the first window cut short was the end.
      if (short) break;
      stage('listening to the film (' + (windows.length + 1) + ' of about ' + (windows.length + stretches.length - i) + ' stretches)');
      const wav = path.join(this.opts.workDir, subject.key.replace(/[^a-z0-9-]/gi, '-') + '-' + Math.round(startS) + '-' + this.now() + '.wav');
      try {
        const input = await subject.input();
        const cut = await this.opts.cutter({ ...input, startS, lengthS, out: wav }, signal);
        if (!cut.ok) {
          windows.push({ ...mark, at_s: startS, length_s: 0, lines: null, problem: 'the audio could not be cut: ' + withoutSecrets(cut.reason).slice(0, 160) });
          continue;
        }
        if (cut.lengthS < lengthS - 1) short = subject.durationS === null;
        if (cut.lengthS < 5) {
          windows.push({ ...mark, at_s: startS, length_s: round1(cut.lengthS), lines: null, problem: 'past the end of the film' });
          continue;
        }
        const cues = await this.opts.transcriber.transcribe({ wav, task: how.task, language: how.language }, signal);
        const lines = cues.map((c): HeardLine => ({ startS: startS + c.start_s, endS: startS + c.end_s, text: c.text }));
        heard.push(...lines);
        windows.push({ ...mark, at_s: startS, length_s: round1(cut.lengthS), lines: countable(lines) });
      } catch (err) {
        windows.push({ ...mark, at_s: startS, length_s: 0, lines: null, problem: messageOf(err).slice(0, 200) });
      } finally {
        await rm(wav, { force: true });
      }
    }
  }
}
