import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_TORRENT_VAD_SCRIPT } from '../../../config.js';
import { readBody } from '../../cache/upstream.js';
import type { CacheSubtitleView } from '../../cachePlay.js';
import type { FetchLike } from '../../passThrough.js';
import { withHlsSegments } from '../../hlsCut.js';
import type { ResolvedSource, StreamRef } from '../../types.js';
import { INFO_HASH_PATTERN, vttFromBytes, type SubtitleShelf } from './disk.js';
import { TITLE_OUTSIDE_NAME } from '../../titleSubtitles.js';
import { IN_STEP_S } from '../../subtitleCheck/match.js';
import { ffmpegCutter, type AudioCutter } from './whisper.js';
import { withoutSecrets } from './wyzie.js';

/**
 * Wyzie Synced for a stream session's subtitle (WYZIE_SYNCED_BRIEF): a torrent session's, and a cloud session's
 * outside subtitle (titleSubtitles.ts), whose audio is cut from the stream it plays. What follows speaks of the
 * torrent; a SyncPlace says where each kind keeps its files and what ffmpeg reads.
 *
 * A subtitle that came from outside the torrent (the `service` tier's file, the `borrow` tier's) may be timed for
 * another release. After such a session starts, the film's audio is cut from its beginning with ffmpeg (Whisper's
 * cutter, from the torrent's own file route, which waits for bytes not downloaded yet), the stretches of speech in it
 * are found with Silero VAD (claude/streaming/torrent/vad.py, run with Whisper's Python), and Wyzie is asked
 * (`POST /sync`) for the English subtitle of the title that fits that speech best, with the fix applied. The answer's
 * file is kept on the shelf as the torrent's chosen track, `English (Wyzie, synced)`, and replaces the session's
 * subtitle: the session's `subtitleRev` goes up, which the player page reads in the answer to its position reports.
 *
 * Horizons: the first 30 minutes, then the first 60, then the whole file (the head of a film is enough when it has
 * dialogue; 12 minutes was not). A 422 ("couldn't sync", "no speech") goes on to the next horizon; anything else
 * ends the job. A successful sync costs 60 requests of the key; a refused or failed one is free.
 *
 * At most one job per torrent and file. Its outcome is kept in `<torrent>/.notesd-subs/synced-<file index>.json`:
 * after `done`, or a failure that says the title cannot be synced, a replay asks nothing; a failure that may pass
 * (no answer, the limit, no Python) is tried again by the next play. A job the session's release stopped left no
 * outcome and starts over. Never in the play's way: it starts after the chain, outside its 40 s budget.
 *
 * The key travels in the request's body and a `tok` in the answer's download address: neither is ever logged,
 * thrown or kept.
 */

export const SYNCED_LABEL = 'English (Wyzie, synced)';
/** The folder inside a torrent's folder for the WAV of the stretch in progress. */
export const SYNC_DIR = 'notesd-sync';
/** Seconds from the start of the film tried in turn before the whole file. */
export const SYNC_HORIZONS_S: readonly number[] = [1800, 3600];
/** The audio is cut and listened to this many seconds at a time. */
export const SYNC_STRETCH_S = 300;
/** Wyzie refuses a request with less speech than this inside `covered`; such a horizon is not sent. */
export const SYNC_MIN_SPEECH_S = 120;
/** A refusal took 45 s in the trial (Wyzie tried five subtitles); a fit about 1 s. */
export const SYNC_REQUEST_TIMEOUT_MS = 120_000;
export const SYNC_FILE_TIMEOUT_MS = 30_000;
/** Silero VAD took 9 s for 100 minutes; a stretch of 5 minutes is far inside this. */
export const VAD_TIMEOUT_MS = 120_000;
const ANSWER_MAX_BYTES = 256 * 1024;
const FILE_MAX_BYTES = 5 * 1024 * 1024;
const VAD_MAX_BYTES = 4 * 1024 * 1024;
const USER_AGENT = 'notesd (personal notes daemon; torrent subtitles)';

/** One stretch of speech, `[start, end]` in seconds into the film. */
export type SpeechSpan = [number, number];

/** `no_fit`: Wyzie could not line a subtitle up with this much audio (422). `none`: it has no subtitle (404). `failed`: anything else. */
export type SyncFailure = 'no_fit' | 'none' | 'failed';

export class SyncError extends Error {
  override readonly name = 'SyncError';
  constructor(
    readonly kind: SyncFailure,
    message: string,
  ) {
    super(message);
  }
}

/** What Wyzie says of the subtitle it synced. Never its address. */
export interface SyncedInfo {
  /** Seconds the lines were moved by; null when not said. */
  offsetS: number | null;
  /** A frame-rate fix such as `23.976:24`; null: none. */
  fps: string | null;
  confidence: number | null;
  /** The subtitle already fit as it was. */
  inSync: boolean;
  release: string | null;
}

export interface SyncClientDeps {
  baseUrl: string;
  key: string;
  fetch: FetchLike;
  requestTimeoutMs?: number;
  fileTimeoutMs?: number;
}

export interface SyncQuery {
  ref: StreamRef;
  /** `tt…`; null: asked by the TMDB id. */
  imdbId: string | null;
  speech: readonly SpeechSpan[];
  /** The stretches of the film `speech` was looked for in. */
  covered: readonly SpeechSpan[];
}

const messageOf = (err: unknown): string => withoutSecrets(err instanceof Error ? err.message : String(err));
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 200) : null);
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The body of `POST /sync`. It holds the key: it goes to Wyzie and nowhere else. */
export function syncRequestBody(key: string, query: SyncQuery): Record<string, unknown> {
  return {
    key,
    id: query.imdbId ?? String(query.ref.tmdbId),
    language: 'en',
    ...(query.ref.kind === 'tv' ? { season: query.ref.season, episode: query.ref.episode } : {}),
    speech: query.speech,
    covered: query.covered,
  };
}

/** Wyzie's 200, read once where it enters: the download address and what it says of the fix. Throws SyncError `failed`. */
export function parseSyncAnswer(body: unknown): { url: string; info: SyncedInfo } {
  if (typeof body !== 'object' || body === null) throw new SyncError('failed', 'the sync answer is not an object');
  const b = body as Record<string, unknown>;
  const url = typeof b.url === 'string' ? b.url.trim() : '';
  if (!/^https?:\/\/\S+$/i.test(url)) throw new SyncError('failed', 'the sync answer names no file');
  const subtitle = typeof b.subtitle === 'object' && b.subtitle !== null ? (b.subtitle as Record<string, unknown>) : {};
  return {
    url,
    info: { offsetS: num(b.offset), fps: text(b.fps), confidence: num(b.confidence), inSync: b.inSync === true, release: text(subtitle.release) ?? text(subtitle.fileName) },
  };
}

/** What Wyzie said with a refusal (`{error}` or `{message}`), without anything key-like; '' when it said nothing readable. */
async function refusalText(res: Response): Promise<string> {
  try {
    const body = await readBody(res, ANSWER_MAX_BYTES, false);
    if (body === null) return '';
    const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown> | null;
    const said = text(parsed?.error) ?? text(parsed?.message) ?? '';
    return withoutSecrets(said);
  } catch {
    return '';
  }
}

/**
 * Asks Wyzie for the English subtitle that fits `speech` and answers it as WebVTT. Throws SyncError: `no_fit` (422),
 * `none` (404) or `failed` (no answer, any other status, a file that cannot be read). `signal` stops the request; once
 * Wyzie answered 200 the sync is paid for, so the file is fetched whatever `signal` says.
 */
export async function wyzieSynced(deps: SyncClientDeps, query: SyncQuery, signal: AbortSignal): Promise<{ vtt: string; info: SyncedInfo }> {
  let res: Response;
  try {
    res = await deps.fetch(`${deps.baseUrl}/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify(syncRequestBody(deps.key, query)),
      signal: AbortSignal.any([signal, AbortSignal.timeout(deps.requestTimeoutMs ?? SYNC_REQUEST_TIMEOUT_MS)]),
    });
  } catch (err) {
    signal.throwIfAborted();
    throw new SyncError('failed', `the sync did not answer (${messageOf(err)})`);
  }
  if (res.status !== 200) {
    const said = await refusalText(res);
    const kind: SyncFailure = res.status === 422 ? 'no_fit' : res.status === 404 ? 'none' : 'failed';
    throw new SyncError(kind, `the sync answered HTTP ${res.status}${said === '' ? '' : ` (${said})`}`);
  }
  const body = await readBody(res, ANSWER_MAX_BYTES, false).catch(() => null);
  if (body === null) throw new SyncError('failed', 'the sync answer could not be read');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw new SyncError('failed', 'the sync answer is not JSON');
  }
  const answer = parseSyncAnswer(parsed);
  let file: Response;
  try {
    file = await deps.fetch(answer.url, { headers: { accept: '*/*', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(deps.fileTimeoutMs ?? SYNC_FILE_TIMEOUT_MS) });
  } catch (err) {
    throw new SyncError('failed', `the synced file did not answer (${messageOf(err)})`);
  }
  if (file.status !== 200) {
    await file.body?.cancel().catch(() => undefined);
    throw new SyncError('failed', `the synced file answered HTTP ${file.status}`);
  }
  const bytes = await readBody(file, FILE_MAX_BYTES, false).catch(() => null);
  const vtt = bytes === null ? null : vttFromBytes(bytes);
  if (vtt === null) throw new SyncError('failed', 'the synced file holds no cue');
  return { vtt, info: answer.info };
}

/** The seam to Silero VAD: the stretches of speech in one WAV, in seconds into it. Production: vadDetector. Tests: a plain function. */
export type SpeechDetector = (wav: string, signal: AbortSignal) => Promise<SpeechSpan[]>;

/** The detector's output, kept only when well formed: it is another program's. */
export function parseSpeech(raw: unknown): SpeechSpan[] {
  if (!Array.isArray(raw)) throw new Error('the speech detector did not print a list');
  const spans: SpeechSpan[] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length !== 2) continue;
    const [start, end] = item as unknown[];
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) continue;
    spans.push([start, end]);
  }
  return spans;
}

export function vadDetector(options: { python: string; script?: string; timeoutMs?: number }): SpeechDetector {
  return (wav, signal) =>
    new Promise<SpeechSpan[]>((resolve, reject) => {
      execFile(
        options.python,
        ['-I', options.script ?? DEFAULT_TORRENT_VAD_SCRIPT, wav],
        { timeout: options.timeoutMs ?? VAD_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: VAD_MAX_BYTES, signal },
        (err, stdout, stderr) => {
          if (err) {
            const tail = String(stderr).trim().split('\n').pop() ?? '';
            reject(new Error(`the speech detector failed: ${tail === '' ? err.message : tail}`.slice(0, 300)));
            return;
          }
          try {
            resolve(parseSpeech(JSON.parse(String(stdout))));
          } catch (parseErr) {
            reject(parseErr instanceof Error ? parseErr : new Error(String(parseErr)));
          }
        },
      );
    });
}

/**
 * `spans` of one stretch moved to film time and added to `into`. Speech that runs across the seam between two
 * stretches (it ended with the last one, and this one starts with it) is joined; the detector's own splits stay.
 */
export function addSpeech(into: SpeechSpan[], spans: readonly SpeechSpan[], startS: number): void {
  for (const [i, [from, to]] of spans.entries()) {
    const start = round2(startS + from);
    const end = round2(startS + to);
    const last = into[into.length - 1];
    if (i === 0 && from <= 0.05 && last !== undefined && Math.abs(last[1] - startS) <= 0.05) last[1] = Math.max(last[1], end);
    else into.push([start, end]);
  }
}

/** The horizons for a film of this length: each SYNC_HORIZONS_S entry the film is longer than, then the whole file (Infinity when the length is not known). */
export function horizonsFor(durationS: number | null, horizonsS: readonly number[] = SYNC_HORIZONS_S): number[] {
  const whole = durationS !== null && durationS > 0 ? durationS : Number.POSITIVE_INFINITY;
  return [...horizonsS.filter((h) => h < whole), whole];
}

const SYNCABLE_FILE = new RegExp(`/(?:sub/(?:service-[a-z0-9-]+|borrow)|subs/[a-z0-9-]+/${TITLE_OUTSIDE_NAME.replace('.vtt', '')})\\.vtt$`);

/**
 * True when the session's subtitle came from outside the torrent: the `service` tier's kept file or the `borrow`
 * tier's, also when the `kept` tier answered it on a replay, or a cloud session's outside file. A file of the
 * torrent, its embedded track, a Whisper track and a file already synced are in step with the film and never are.
 */
export function wantsSync(subtitles: readonly CacheSubtitleView[]): boolean {
  return subtitles.length > 0 && subtitles.every((t) => t.growing !== true && SYNCABLE_FILE.test(t.url));
}

/**
 * The outcome file's version. A failure an older version wrote (it may have come from a bug fixed since, such as a
 * cloud stream's audio that could not be cut before hlsCut.ts) is not final: the next play tries again.
 */
export const SYNC_OUTCOME_VERSION = 2;

/**
 * True when a synced answer would move the session's subtitle by less than IN_STEP_S with no frame-rate fix, and that
 * subtitle is Wyzie's own (a service file named Wyzie, a cloud session's Wyzie file): the re-timing is not worth a new
 * file. A borrowed or add-on file is replaced whatever the offset, since Wyzie's answer may be another subtitle.
 */
export function inStepAlready(info: Pick<SyncedInfo, 'offsetS' | 'fps' | 'inSync'>, shown: readonly CacheSubtitleView[]): boolean {
  if (info.fps !== null) return false;
  const small = info.offsetS === null ? info.inSync : Math.abs(info.offsetS) < IN_STEP_S;
  return small && shown.length > 0 && shown.every((t) => /\/sub\/service-wyzie-[a-z0-9-]+\.vtt$/.test(t.url) || t.label.startsWith('English (Wyzie'));
}

/** One line of the outcome file. */
export interface SyncOutcome {
  /** SYNC_OUTCOME_VERSION when written. */
  v: number;
  state: 'done' | 'failed';
  /** A failure the next play tries again (no answer, the key's limit, no Python); false: this title cannot be synced. */
  retry: boolean;
  reason: string | null;
  at: string;
  /** Seconds of the film that were listened to. */
  covered_s: number;
  offset_s: number | null;
  fps: string | null;
  confidence: number | null;
  in_sync: boolean | null;
  release: string | null;
}

function parseOutcome(raw: unknown): SyncOutcome | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if ((o.state !== 'done' && o.state !== 'failed') || typeof o.retry !== 'boolean') return null;
  const v = typeof o.v === 'number' && Number.isInteger(o.v) ? o.v : 1;
  // An older version's failure is not kept: it is tried again. Its success stands.
  if (v < SYNC_OUTCOME_VERSION && o.state === 'failed') return null;
  return {
    v,
    state: o.state,
    retry: o.retry,
    reason: text(o.reason),
    at: typeof o.at === 'string' ? o.at : '',
    covered_s: num(o.covered_s) ?? 0,
    offset_s: num(o.offset_s),
    fps: text(o.fps),
    confidence: num(o.confidence),
    in_sync: typeof o.in_sync === 'boolean' ? o.in_sync : null,
    release: text(o.release),
  };
}

/** The part of a session's torrent (SessionTorrent) a finished sync writes. */
export interface SyncTarget {
  subtitles: CacheSubtitleView[];
  /** Counts the times a sync replaced `subtitles`; the player page loads its subtitle again when it changes. */
  subtitleRev: number;
}

/** What ffmpeg reads the film from: an address or a path, and the arguments it needs before it (a stream host's headers). */
export interface SyncInput {
  url: string;
  inputArgs?: string[];
  /** A cloud HLS stream as it was resolved, for a host whose segments ffmpeg cannot read by itself (hlsCut.ts). */
  hls?: Pick<ResolvedSource, 'manifest_kind' | 'manifest_url' | 'headers'>;
}

/** Where one sync keeps its files and what it listens to: a torrent's file (torrentSyncPlace) or a title's stream (titleSubtitles.ts). */
export interface SyncPlace {
  /** The outcome of the one sync of this film on this machine. */
  outcomeFile: string;
  /** The WAV of the stretch in progress is written here. */
  workDir: string;
  /** Read again for every stretch: a download finishes, a session moves to another source. Throws when there is nothing to read. */
  input(): SyncInput | Promise<SyncInput>;
  /** Keeps the synced file as the film's chosen subtitle and answers the session's view of it. */
  save(vtt: string): Promise<CacheSubtitleView>;
}

export interface SyncRequest {
  ref: StreamRef;
  imdbId: string | null;
  /** Names the job: one runs per key at a time (`<info hash>-<file index>`, `movie-550`). */
  key: string;
  /** The film's length; null: not known. */
  durationS: number | null;
  /** Aborted when the session lets go of the film. */
  signal: AbortSignal;
  target: SyncTarget;
  place: SyncPlace;
}

/** A torrent session's sync as TorrentSource asks for it; the daemon adds the place (torrentSyncPlace). */
export interface TorrentSyncRequest extends Omit<SyncRequest, 'key' | 'place'> {
  infoHash: string;
  fileIndex: number;
}

/** A torrent file's place: its outcome beside the kept subtitles, the WAVs in `<torrent>/notesd-sync`, the synced file as the torrent's chosen track. */
export function torrentSyncPlace(
  deps: { torrentDir: string; shelf: SubtitleShelf; input: (infoHash: string, fileIndex: number) => string | Promise<string> },
  infoHash: string,
  fileIndex: number,
): SyncPlace {
  if (!INFO_HASH_PATTERN.test(infoHash)) throw new RangeError(`not an info hash: ${infoHash}`);
  return {
    outcomeFile: path.join(deps.shelf.dir(infoHash), `synced-${fileIndex}.json`),
    workDir: path.join(deps.torrentDir, infoHash, SYNC_DIR),
    input: async () => ({ url: await deps.input(infoHash, fileIndex) }),
    save: (vtt) => deps.shelf.save(infoHash, `synced-${fileIndex}.vtt`, vtt, { lang: 'en', label: SYNCED_LABEL }),
  };
}

/** The outcome an earlier sync left in `file`, or null. */
export async function readSyncOutcome(file: string): Promise<SyncOutcome | null> {
  try {
    return parseOutcome(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    return null;
  }
}

export interface SubtitleSyncOptions {
  wyzie: { baseUrl: string; key: string };
  fetch: FetchLike;
  cutter: AudioCutter;
  detect: SpeechDetector;
  /** False when the speech detector cannot run (no Python); asked once per job, and the job is skipped with a log line. */
  ready?: () => boolean | Promise<boolean>;
  horizonsS?: readonly number[];
  stretchS?: number;
  now?: () => Date;
  log?: (line: string) => void;
}

/** One torrent file being synced, shared by every session that plays it. */
class SyncJob {
  readonly controller = new AbortController();
  /** /sync-subtitle chose the film's subtitle: a sync that ends now keeps nothing. */
  checked = false;
  readonly targets = new Set<SyncTarget>();
  private users = 0;

  /** The job goes on while at least one session's signal has not aborted. */
  join(request: SyncRequest): void {
    this.targets.add(request.target);
    this.users += 1;
    request.signal.addEventListener(
      'abort',
      () => {
        this.users -= 1;
        if (this.users === 0) this.controller.abort(new Error('the torrent was released'));
      },
      { once: true },
    );
  }
}

export class SubtitleSync {
  private readonly jobs = new Map<string, SyncJob>();
  private readonly log: (line: string) => void;
  private readonly now: () => Date;

  constructor(private readonly opts: SubtitleSyncOptions) {
    this.log = opts.log ?? ((line: string) => console.log(line));
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Starts the sync of a session's subtitle when it came from outside the torrent, and answers at once. Returns the
   * job's promise (tests wait on it; the daemon does not), or null when nothing was started. Never throws or rejects.
   */
  start(request: SyncRequest): Promise<void> | null {
    if (request.signal.aborted || !wantsSync(request.target.subtitles)) return null;
    const key = request.key;
    const running = this.jobs.get(key);
    if (running !== undefined && !running.controller.signal.aborted) {
      running.join(request);
      return null;
    }
    const job = new SyncJob();
    job.join(request);
    this.jobs.set(key, job);
    return this.run(key, request, job)
      .catch((err: unknown) => {
        this.log(`[notesd] torrent sync: ${key} stopped: ${job.controller.signal.aborted ? 'the torrent was released' : messageOf(err)}`);
      })
      .finally(() => {
        if (this.jobs.get(key) === job) this.jobs.delete(key);
      });
  }

  /** Stops the job of one film, if one runs: /sync-subtitle chose its subtitle, and a sync ending later must not replace it. */
  cancel(key: string): void {
    const job = this.jobs.get(key);
    if (job === undefined) return;
    job.checked = true;
    job.controller.abort(new Error('the subtitle was checked'));
  }

  /** Stops every job: notesd is stopping. */
  close(): void {
    for (const job of this.jobs.values()) job.controller.abort(new Error('notesd is stopping'));
    this.jobs.clear();
  }

  private async saveOutcome(file: string, outcome: SyncOutcome): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(outcome)}\n`, 'utf8');
    await rename(tmp, file);
  }

  private async run(key: string, request: SyncRequest, job: SyncJob): Promise<void> {
    const place = request.place;
    const signal = job.controller.signal;
    const before = await readSyncOutcome(place.outcomeFile);
    if (before !== null && (before.state === 'done' || !before.retry)) {
      this.log(`[notesd] torrent sync: ${key} is not synced again (${before.state}${before.reason === null ? '' : `: ${before.reason}`})`);
      return;
    }
    if (this.opts.ready !== undefined && !(await this.opts.ready())) {
      this.log(`[notesd] torrent sync: ${key} skipped: Whisper's Python is not installed (scripts/install.sh installs it), so speech cannot be found`);
      return;
    }
    const stretchS = this.opts.stretchS ?? SYNC_STRETCH_S;
    const workDir = place.workDir;
    await mkdir(workDir, { recursive: true });
    const speech: SpeechSpan[] = [];
    /** Seconds of audio listened to so far, from the start of the film. */
    let heardS = 0;
    /** The audio ended before the horizon asked for: there is no more to hear. */
    let over = false;
    const fail = async (retry: boolean, reason: string): Promise<void> => {
      await this.saveOutcome(place.outcomeFile, {
        v: SYNC_OUTCOME_VERSION, state: 'failed', retry, reason, at: this.now().toISOString(), covered_s: round2(heardS), offset_s: null, fps: null, confidence: null, in_sync: null, release: null,
      });
      this.log(`[notesd] torrent sync: ${key} not synced: ${reason}${retry ? ' (the next play tries again)' : ''}`);
    };

    const horizons = horizonsFor(request.durationS, this.opts.horizonsS);
    for (const [i, horizon] of horizons.entries()) {
      while (heardS < horizon - 0.5 && !over) {
        signal.throwIfAborted();
        const lengthS = Math.min(stretchS, horizon - heardS);
        const wav = path.join(workDir, `${key}-${Math.round(heardS)}.wav`);
        try {
          let input: SyncInput;
          try {
            input = await place.input();
          } catch (err) {
            signal.throwIfAborted();
            return await fail(true, messageOf(err));
          }
          const cut = await this.opts.cutter({ ...input, startS: heardS, lengthS, out: wav }, signal);
          signal.throwIfAborted();
          if (!cut.ok) return await fail(true, `the audio at ${Math.round(heardS)} s could not be cut: ${withoutSecrets(cut.reason)}`);
          if (cut.lengthS >= 0.5) {
            let spans: SpeechSpan[];
            try {
              spans = await this.opts.detect(wav, signal);
            } catch (err) {
              signal.throwIfAborted();
              return await fail(true, messageOf(err));
            }
            addSpeech(speech, spans, heardS);
            heardS += cut.lengthS;
          }
          // A cut shorter than asked: the audio is over (a film whose length ffprobe did not know, or said too long).
          if (cut.lengthS < 0.5 || cut.lengthS < lengthS - 1) over = true;
        } finally {
          await rm(wav, { force: true });
        }
      }
      signal.throwIfAborted();
      const last = over || i === horizons.length - 1;
      const spokenS = speech.reduce((sum, [from, to]) => sum + (to - from), 0);
      if (spokenS < SYNC_MIN_SPEECH_S) {
        if (last) return await fail(false, `only ${Math.round(spokenS)} s of speech in the film: too little to line a subtitle up with`);
        continue;
      }
      // The release's own subtitle (or a checked one) took the place of the outside file meanwhile: nothing to re-time.
      if ([...job.targets].every((t) => !wantsSync(t.subtitles))) {
        this.log(`[notesd] torrent sync: ${key} stopped: the session now shows a subtitle that needs no sync`);
        return;
      }
      try {
        const got = await wyzieSynced({ ...this.opts.wyzie, fetch: this.opts.fetch }, { ref: request.ref, imdbId: request.imdbId, speech, covered: [[0, round2(heardS)]] }, signal);
        // /sync-subtitle chose a subtitle while Wyzie answered: its choice stands, and nothing is kept.
        if (job.checked) {
          this.log(`[notesd] torrent sync: ${key}: the subtitle was checked meanwhile; the synced file is not kept`);
          return;
        }
        const outcome = {
          v: SYNC_OUTCOME_VERSION, retry: false, at: this.now().toISOString(), covered_s: round2(heardS),
          offset_s: got.info.offsetS, fps: got.info.fps, confidence: got.info.confidence, release: got.info.release,
        };
        if (inStepAlready(got.info, request.target.subtitles)) {
          // Wyzie's own file, moved by less than a subtitle is ever off by: it was in step. Kept as `done`, never asked again.
          await this.saveOutcome(place.outcomeFile, { ...outcome, state: 'done', reason: `in step: moved by ${got.info.offsetS ?? 0} s, under ${IN_STEP_S} s`, in_sync: true });
          this.log(`[notesd] torrent sync: ${key} is in step already (offset ${got.info.offsetS ?? 0} s from the first ${Math.round(heardS)} s); the subtitle is kept as it was`);
          return;
        }
        const view = await place.save(got.vtt);
        await this.saveOutcome(place.outcomeFile, { ...outcome, state: 'done', reason: null, in_sync: got.info.inSync });
        for (const target of job.targets) {
          // Only a session still showing the outside file takes the synced one: never over the release's own or a checked one.
          if (!wantsSync(target.subtitles)) continue;
          target.subtitles = [view];
          target.subtitleRev += 1;
        }
        const { offsetS, fps, confidence, inSync, release } = got.info;
        this.log(
          `[notesd] torrent sync: ${key} synced from the first ${Math.round(heardS)} s: offset ${offsetS ?? '?'} s${fps === null ? '' : `, fps ${fps}`}, confidence ${confidence ?? '?'}${inSync ? ', already in step' : ''}${release === null ? '' : ` (${release})`}`,
        );
        return;
      } catch (err) {
        signal.throwIfAborted();
        if (!(err instanceof SyncError)) throw err;
        if (err.kind === 'no_fit' && !last) {
          this.log(`[notesd] torrent sync: ${key}: no fit with the first ${Math.round(heardS)} s (${err.message}); listening further`);
          continue;
        }
        return await fail(err.kind === 'failed', err.message);
      }
    }
  }
}

export interface BuildSubtitleSyncOptions {
  /** config.torrent.wyzieSync; null or unset: nothing is built. */
  sync: { python: string } | null | undefined;
  wyzie: { baseUrl: string; key: string } | null;
  ffmpegBin: string;
  fetch: FetchLike;
  log?: (line: string) => void;
}

/** The daemon's sync, or null: `NOTESD_TORRENT_WYZIE_SYNC=off`, or no Wyzie key or address. The Python is looked for when a job starts. */
export function buildSubtitleSync(options: BuildSubtitleSyncOptions): SubtitleSync | null {
  if (options.sync === null || options.sync === undefined || options.wyzie === null) return null;
  const python = options.sync.python;
  return new SubtitleSync({
    wyzie: options.wyzie,
    fetch: options.fetch,
    // A cloud stream whose segments ffmpeg cannot read by itself is cut from its segments (hlsCut.ts).
    cutter: withHlsSegments(ffmpegCutter({ ffmpegBin: options.ffmpegBin }), { ffmpegBin: options.ffmpegBin }),
    detect: vadDetector({ python }),
    ready: () => access(python, constants.X_OK).then(() => true, () => false),
    ...(options.log === undefined ? {} : { log: options.log }),
  });
}
