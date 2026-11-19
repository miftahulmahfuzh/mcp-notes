import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { WhisperDetector } from './torrent/subtitles/whisper.js';
import { normalizeAudioLang } from './torrent/probe.js';
import { hlsTransportStream } from './picture.js';
import { refLabel, type ResolvedSource, type StreamRef } from './types.js';

/**
 * Hearing a cloud stream before it plays. A torrent's audio tracks are ffprobed and the original
 * language is enforced on them (torrent/probe.ts), but a cloud mp4 often carries no audio-language
 * tag at all: ffprobe reports nothing and a Spanish film dubbed into English plays undetected. So the
 * first time a cloud provider's stream of a foreign-language title is about to play, ~30 s of its
 * audio is cut with ffmpeg (the manifest's address and the headers the resolve captured, as the
 * pass-through sends them) and passed through Whisper, which hears the language actually spoken
 * whatever the tags say. A provider heard speaking a language other than the title's original is a
 * dub, and the play looks for one that serves the original. The verdict is kept per title and
 * provider on this machine, so it is paid for once.
 *
 * Nothing here fails a play: audio that cannot be read or a model that is not sure is `unsure`, which
 * plays. Only ever asked when the title's original language is known and is not English (there is no
 * dub into English of an English film to hear); the service guards that, so this module stays simple.
 */

/** Seconds into the title the clip is cut at: well past the opening, a point with dialogue. */
export const AUDIO_SAMPLE_AT_S = 600;
/** Seconds of audio Whisper hears: enough to settle on a language, small enough for one cheap cut. */
export const AUDIO_CLIP_S = 30;
export const AUDIO_CLIP_TIMEOUT_MS = 40_000;
/** Below this, Whisper is not sure enough to call a dub: the stream plays and is looked at again next time. */
export const AUDIO_MIN_PROBABILITY = 0.6;
/** A kept verdict (original or dubbed) is heard again after this long: a provider may have swapped its stream. */
export const AUDIO_KEEP_TTL_MS = 60 * 24 * 3_600_000;
export const AUDIO_VERDICTS_FILE = 'stream-audio.json';

/** `original`: the audio is the title's own language. `dubbed`: another language, confidently. `unsure`: nothing could be said. */
export type AudioVerdict = 'original' | 'dubbed' | 'unsure';

export const isDub = (verdict: AudioVerdict): boolean => verdict === 'dubbed';

export interface AudioFinding {
  verdict: AudioVerdict;
  /** The language Whisper heard, as a 2-letter code; null when none could be read. */
  detected: string | null;
  /** How sure Whisper was of it (0..1); null when nothing was heard. */
  probability: number | null;
  /** One short line: what was heard, or why nothing could be said. */
  reason: string;
}

/** One clip of the stream at `atS` seconds as a 16 kHz mono 16-bit PCM WAV, or null when it could not be read. Never throws. */
export type AudioGrabber = (source: ResolvedSource, atS: number) => Promise<string | null>;

/** ffmpeg's arguments for one audio clip: seek, the manifest's headers, 30 s of the first audio stream as 16 kHz mono PCM. */
export function cutAudioArgs(source: ResolvedSource, atS: number, out: string): string[] {
  const { referer, origin, user_agent: userAgent } = source.headers;
  const headers = [referer === null ? null : `Referer: ${referer}`, origin === null ? null : `Origin: ${origin}`].filter((h): h is string => h !== null);
  return [
    '-v', 'error', '-y', '-ss', String(atS),
    ...(userAgent === null ? [] : ['-user_agent', userAgent]),
    ...(headers.length === 0 ? [] : ['-headers', headers.map((h) => `${h}\r\n`).join('')]),
    '-i', source.manifest_url,
    '-t', String(AUDIO_CLIP_S), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
    '-map_metadata', '-1', '-fflags', '+bitexact',
    out,
  ];
}

/**
 * The audio clip through ffmpeg: it reads the manifest with the Referer, Origin and User-Agent the
 * resolve captured (what the pass-through sends for the player), seeks, and writes 30 s of the first
 * audio stream as a 16 kHz mono PCM WAV, which is what the Whisper worker reads. The WAV is left for
 * the caller to remove; a failed cut takes its own temp folder with it.
 */
export function ffmpegAudioGrabber(options: { ffmpegBin: string; timeoutMs?: number }): AudioGrabber {
  return async (source, atS) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'notesd-audio-'));
    const out = path.join(dir, 'clip.wav');
    const args = cutAudioArgs(source, atS, out);
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(options.ffmpegBin, args, { timeout: options.timeoutMs ?? AUDIO_CLIP_TIMEOUT_MS, killSignal: 'SIGKILL' }, (err) => (err ? reject(err) : resolve()));
      });
      return (await stat(out)).size > 44 ? out : (await rm(dir, { recursive: true, force: true }), null);
    } catch {
      await rm(dir, { recursive: true, force: true });
      return null;
    }
  };
}

/** Segments read for a clip when ffmpeg cannot open the stream itself: eight of 4 to 10 s cover the 30 s Whisper is handed. */
export const AUDIO_CLIP_SEGMENTS = 8;
/** The pause before the segments are asked for a second time. */
export const AUDIO_SEGMENTS_RETRY_MS = 1_500;

/**
 * The audio clip of an HLS stream ffmpeg cannot open by itself: the segments from `atS` on are fetched here (as the
 * picture check does for a frame, picture.ts `hlsTransportStream`) and their transport stream is handed to ffmpeg on
 * stdin. Some hosts wrap every segment in a small picture file (HyperLink's are PNGs on an image host): ffmpeg then
 * reads the manifest, finds "no stream" and writes nothing, and a dub went unheard (five of six foreign-language
 * streams in the soak of 2026-11-19 read `no audio could be read from the stream`). Null when the stream is not
 * plain MPEG-TS, carries its audio in a rendition of its own, or cannot be fetched. Never throws.
 */
export function hlsSegmentAudioGrabber(options: { ffmpegBin: string; fetch?: typeof fetch; timeoutMs?: number; segments?: number; retryMs?: number }): AudioGrabber {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? AUDIO_CLIP_TIMEOUT_MS;
  return async (source, atS) => {
    if (source.manifest_kind !== 'hls') return null;
    const dir = await mkdtemp(path.join(tmpdir(), 'notesd-audio-'));
    const out = path.join(dir, 'clip.wav');
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      const read = (): Promise<Buffer | null> => hlsTransportStream(source, atS, options.segments ?? AUDIO_CLIP_SEGMENTS, fetchImpl, signal).catch(() => null);
      // Once more after a moment: HyperLink's host refused the first ask and answered the next (2026-11-19).
      const ts = (await read()) ?? (await new Promise((resolve) => setTimeout(resolve, options.retryMs ?? AUDIO_SEGMENTS_RETRY_MS)), await read());
      if (ts === null) throw new Error('no transport stream');
      await new Promise<void>((resolve, reject) => {
        const child = execFile(
          options.ffmpegBin,
          ['-v', 'error', '-y', '-f', 'mpegts', '-i', 'pipe:0', '-t', String(AUDIO_CLIP_S), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-fflags', '+bitexact', out],
          { timeout: timeoutMs, killSignal: 'SIGKILL' },
          (err) => (err ? reject(err) : resolve()),
        );
        // ffmpeg stops reading once it has its 30 s: the rest of the segments is not an error.
        child.stdin?.on('error', () => undefined);
        child.stdin?.end(ts);
      });
      if ((await stat(out)).size > 44) return out;
      throw new Error('an empty clip');
    } catch {
      await rm(dir, { recursive: true, force: true });
      return null;
    }
  };
}

/** Each grabber in turn until one reads a clip. */
export function firstAudioOf(...grabbers: AudioGrabber[]): AudioGrabber {
  return async (source, atS) => {
    for (const grab of grabbers) {
      const wav = await grab(source, atS);
      if (wav !== null) return wav;
    }
    return null;
  };
}

/** One kept verdict. */
export interface StoredAudio extends AudioFinding {
  provider: string;
  at: string;
  model: string;
}

const audioKey = (ref: StreamRef, provider: string): string => `${refLabel(ref)}|${provider.toLowerCase()}`;

/**
 * This machine's audio verdicts, in one small JSON file beside the picture verdicts and the stream
 * evidence log. A verdict is the machine's own look at a stream; it is not shared, and losing the
 * file only costs the checks again. `unsure` is never written, so the next play hears again.
 */
export class AudioVerdicts {
  private loaded: Map<string, StoredAudio> | null = null;

  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async all(): Promise<Map<string, StoredAudio>> {
    if (this.loaded !== null) return this.loaded;
    const map = new Map<string, StoredAudio>();
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, StoredAudio>;
      for (const [key, value] of Object.entries(parsed)) {
        if (value !== null && typeof value === 'object' && typeof value.verdict === 'string' && typeof value.at === 'string') map.set(key, value);
      }
    } catch {
      // No file yet, or one that cannot be read: start empty.
    }
    this.loaded = map;
    return map;
  }

  private fresh(entry: StoredAudio): boolean {
    const age = this.now().getTime() - Date.parse(entry.at);
    return age >= 0 && age < AUDIO_KEEP_TTL_MS;
  }

  /** The kept verdict of a provider's stream of a title, or null: never heard, or too long ago. */
  async get(ref: StreamRef, provider: string): Promise<StoredAudio | null> {
    const entry = (await this.all()).get(audioKey(ref, provider));
    return entry !== undefined && this.fresh(entry) ? entry : null;
  }

  /** The providers whose stream of this title was heard as a dub and not heard again since. */
  async badFor(ref: StreamRef): Promise<string[]> {
    const prefix = `${refLabel(ref)}|`;
    return [...(await this.all()).entries()].filter(([key, entry]) => key.startsWith(prefix) && isDub(entry.verdict) && this.fresh(entry)).map(([, entry]) => entry.provider);
  }

  async set(ref: StreamRef, provider: string, finding: AudioFinding, model: string): Promise<void> {
    const map = await this.all();
    map.set(audioKey(ref, provider), { ...finding, provider, at: this.now().toISOString(), model });
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(Object.fromEntries(map), null, 1));
    await rename(tmp, this.file);
  }
}

/** One look at a stream's audio. */
export interface AudioLook extends AudioFinding {
  /** The verdict was kept from an earlier look: no audio was read and no model asked. */
  kept: boolean;
}

/** A stream a play passes over for the next provider: its audio is a dub. */
export const passesOverAudio = (look: AudioLook): boolean => isDub(look.verdict);

export interface AudioLangCheckOptions {
  verdicts: AudioVerdicts;
  grab: AudioGrabber;
  detector: WhisperDetector;
  /** Seconds into the title the clip is cut at; default AUDIO_SAMPLE_AT_S. */
  frameAtS?: number;
  now?: () => Date;
  log?: (line: string) => void;
}

/** What the service asks: one cloud stream's audio verdict (kept, or heard now), and which providers to leave out from the start. */
export class AudioLangCheck {
  private readonly log: (line: string) => void;
  private readonly now: () => Date;
  /** For the per-detector model name in the stored verdict and the log. */
  private readonly model = 'whisper';

  constructor(private readonly opts: AudioLangCheckOptions) {
    this.log = opts.log ?? ((line: string) => console.log(line));
    this.now = opts.now ?? (() => new Date());
  }

  /** The providers a play of `ref` leaves out from the start: a stream heard as a dub before. Empty when the verdict file cannot be read. */
  async badFor(ref: StreamRef): Promise<string[]> {
    return this.opts.verdicts.badFor(ref).catch(() => [] as string[]);
  }

  /**
   * The audio verdict of `source` for `ref`: the kept one, else a clip and one Whisper call. `audioLang`
   * is the title's original language (a code the caller knows is set and not English). `unsure` is never
   * kept, so the next play hears again.
   */
  async check(ref: StreamRef, source: ResolvedSource, audioLang: string): Promise<AudioLook> {
    let wav: string | null = null;
    try {
      const kept = await this.opts.verdicts.get(ref, source.provider);
      if (kept !== null) return { verdict: kept.verdict, detected: kept.detected, probability: kept.probability, reason: kept.reason, kept: true };
      wav = await this.opts.grab(source, this.opts.frameAtS ?? AUDIO_SAMPLE_AT_S);
      if (wav === null) return { verdict: 'unsure', detected: null, probability: null, reason: 'no audio could be read from the stream', kept: false };
      const heard = await this.opts.detector.detect(wav, AbortSignal.timeout(AUDIO_CLIP_TIMEOUT_MS));
      if (heard === null || heard.probability < AUDIO_MIN_PROBABILITY) {
        const reason = heard === null ? 'no language could be heard in the audio' : `the language was not heard clearly enough (${heard.language} ${heard.probability})`;
        return { verdict: 'unsure', detected: heard?.language ?? null, probability: heard?.probability ?? null, reason, kept: false };
      }
      const spoken = normalizeAudioLang(heard.language);
      const original = normalizeAudioLang(audioLang);
      if (spoken === null || original === null) {
        // Whisper named no real language, or the title's original is one this machine cannot normalize: nothing to say.
        return { verdict: 'unsure', detected: heard.language, probability: heard.probability, reason: `the heard language ${heard.language} could not be compared`, kept: false };
      }
      const finding: AudioFinding =
        spoken === original
          ? { verdict: 'original', detected: spoken, probability: heard.probability, reason: `the audio is spoken ${spoken}, the original` }
          : { verdict: 'dubbed', detected: spoken, probability: heard.probability, reason: `the audio is spoken ${spoken}, not the original ${original}` };
      this.log(`[notesd] direct stream: audio of ${refLabel(ref)} from ${source.provider}: ${finding.verdict} (${finding.reason})`);
      await this.opts.verdicts.set(ref, source.provider, finding, this.model);
      return { ...finding, kept: false };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log(`[notesd] direct stream: the audio of ${refLabel(ref)} from ${source.provider} could not be heard: ${reason}`);
      return { verdict: 'unsure', detected: null, probability: null, reason: reason.slice(0, 200), kept: false };
    } finally {
      if (wav !== null) await rm(path.dirname(wav), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
