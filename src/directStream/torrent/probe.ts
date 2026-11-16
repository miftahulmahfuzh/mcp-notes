import { execFile } from 'node:child_process';
import { z } from 'zod';

/**
 * What a torrent's chosen file holds, read by ffprobe through this daemon's file route
 * (`/api/stream/torrent/<hash>/f/<index>`; phase 1 answers a range as soon as its pieces are on disk).
 * Torrent phase 3 decides with it whether the file plays (`direct`) and in which language (`audio`);
 * phases 5 to 7 read the rest (the duration for the remux, the text subtitle tracks).
 */

export const PROBE_MAX_BUFFER = 4 * 1024 * 1024;

export interface MediaProbe {
  /** ffprobe's `format_name`, lower case: `mov,mp4,m4a,3gp,3g2,mj2`, `matroska,webm`, ... */
  container: string;
  /** The first real video stream (a cover picture is not one); null when there is none. */
  video: { codec: string; height: number | null } | null;
  /** Every audio stream in order; `lang` is the stream's language tag as written (`eng`), null when it has none. */
  audio: Array<{ codec: string; lang: string | null }>;
  /**
   * Every subtitle stream; `index` is ffprobe's stream index (ffmpeg's `0:<index>`), `text` is false for a picture
   * track (PGS, VobSub, DVB), `title` is its `tags.title`, `forced` and `hearingImpaired` its dispositions (phase 7
   * tells a full English track from a forced or SDH one by them).
   */
  subtitles: Array<{ index: number; codec: string; lang: string | null; text: boolean; title: string | null; forced: boolean; hearingImpaired: boolean }>;
  durationS: number | null;
  /**
   * Chrome's <video> plays the file as is: MP4 with H.264 video and AAC or MP3 audio, or WebM/Matroska with
   * VP8, VP9 or AV1 and Opus or Vorbis. Anything else needs phase 5's remux.
   */
  direct: boolean;
}

/** Reads one file over HTTP. Rejects with ProbeError. */
export type ProbeFile = (url: string, timeoutMs: number) => Promise<MediaProbe>;

export type ProbeErrorCode = 'timeout' | 'failed' | 'bad_output';

export class ProbeError extends Error {
  override name = 'ProbeError';

  constructor(
    readonly code: ProbeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const streamSchema = z.object({
  index: z.number().int(),
  codec_type: z.string().nullish(),
  codec_name: z.string().nullish(),
  height: z.number().int().nullish(),
  disposition: z.object({ attached_pic: z.number().nullish(), forced: z.number().nullish(), hearing_impaired: z.number().nullish() }).nullish(),
  tags: z.object({ language: z.string().nullish(), title: z.string().nullish() }).nullish(),
});

const probeSchema = z.object({
  streams: z.array(streamSchema).nullish(),
  format: z.object({ format_name: z.string().nullish(), duration: z.string().nullish() }).nullish(),
});

const TEXT_SUBTITLE_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);
const WEBM_VIDEO = new Set(['vp8', 'vp9', 'av1']);
const WEBM_AUDIO = new Set(['opus', 'vorbis']);
const MP4_AUDIO = new Set(['aac', 'mp3']);

const present = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim());

function playsAsIs(container: string, video: MediaProbe['video'], audio: MediaProbe['audio']): boolean {
  if (video === null) return false;
  const formats = container.split(',');
  if (formats.includes('mp4')) return video.codec === 'h264' && audio.every((a) => MP4_AUDIO.has(a.codec));
  if (formats.includes('webm')) return WEBM_VIDEO.has(video.codec) && audio.every((a) => WEBM_AUDIO.has(a.codec));
  return false;
}

/** ffprobe's `-print_format json -show_format -show_streams` answer, validated once here. Throws ProbeError `bad_output`. */
export function parseProbe(raw: unknown): MediaProbe {
  const parsed = probeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProbeError('bad_output', `ffprobe printed an answer notesd cannot read: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'answer'}: ${i.message}`).join('; ')}`);
  }
  const streams = parsed.data.streams ?? [];
  const container = (parsed.data.format?.format_name ?? '').toLowerCase();
  const first = streams.find((s) => s.codec_type === 'video' && (s.disposition?.attached_pic ?? 0) !== 1);
  const video = first === undefined ? null : { codec: (first.codec_name ?? '').toLowerCase(), height: first.height ?? null };
  const audio = streams
    .filter((s) => s.codec_type === 'audio')
    .map((s) => ({ codec: (s.codec_name ?? '').toLowerCase(), lang: present(s.tags?.language) }));
  const subtitles = streams
    .filter((s) => s.codec_type === 'subtitle')
    .map((s) => {
      const codec = (s.codec_name ?? '').toLowerCase();
      return {
        index: s.index,
        codec,
        lang: present(s.tags?.language),
        text: TEXT_SUBTITLE_CODECS.has(codec),
        title: present(s.tags?.title),
        forced: (s.disposition?.forced ?? 0) === 1,
        hearingImpaired: (s.disposition?.hearing_impaired ?? 0) === 1,
      };
    });
  const duration = Number(parsed.data.format?.duration ?? Number.NaN);
  return {
    container,
    video,
    audio,
    subtitles,
    durationS: Number.isFinite(duration) && duration > 0 ? duration : null,
    direct: playsAsIs(container, video, audio),
  };
}

/** ffprobe on a URL. A run past `timeoutMs` is killed and rejects with `timeout`: the swarm sent too little in time. */
export function ffprobeFile(options: { ffprobeBin: string }): ProbeFile {
  return (url, timeoutMs) =>
    new Promise<MediaProbe>((resolve, reject) => {
      execFile(
        options.ffprobeBin,
        ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', url],
        { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: PROBE_MAX_BUFFER },
        (err, stdout) => {
          if (err !== null) {
            const killed = (err as { killed?: boolean }).killed === true;
            reject(new ProbeError(killed ? 'timeout' : 'failed', killed ? `ffprobe gave up after ${Math.round(timeoutMs / 1000)} s` : err.message));
            return;
          }
          let raw: unknown;
          try {
            raw = JSON.parse(stdout);
          } catch {
            reject(new ProbeError('bad_output', 'ffprobe did not print JSON'));
            return;
          }
          try {
            resolve(parseProbe(raw));
          } catch (parseErr) {
            reject(parseErr);
          }
        },
      );
    });
}

/** 639-2 (both forms) and common names -> 639-1. The same table as claude/streaming/direct/lang.mjs (a test compares them). */
const TO_TWO: ReadonlyMap<string, string> = new Map(
  Object.entries({
    en: ['eng', 'english'],
    ko: ['kor', 'korean'],
    ja: ['jpn', 'japanese'],
    zh: ['chi', 'zho', 'cmn', 'yue', 'cn', 'chinese', 'mandarin', 'cantonese'],
    es: ['spa', 'spanish', 'espanol', 'castellano', 'latino'],
    fr: ['fre', 'fra', 'french', 'francais'],
    de: ['ger', 'deu', 'german', 'deutsch'],
    it: ['ita', 'italian', 'italiano'],
    pt: ['por', 'portuguese', 'portugues'],
    ru: ['rus', 'russian'],
    hi: ['hin', 'hindi'],
    ta: ['tam', 'tamil'],
    te: ['tel', 'telugu'],
    ml: ['mal', 'malayalam'],
    kn: ['kan', 'kannada'],
    bn: ['ben', 'bengali'],
    mr: ['mar', 'marathi'],
    pa: ['pan', 'punjabi'],
    ur: ['urd', 'urdu'],
    id: ['ind', 'indonesian', 'bahasa'],
    ms: ['may', 'msa', 'malay'],
    th: ['tha', 'thai'],
    vi: ['vie', 'vietnamese'],
    tl: ['tgl', 'fil', 'tagalog', 'filipino'],
    tr: ['tur', 'turkish'],
    ar: ['ara', 'arabic'],
    fa: ['per', 'fas', 'persian', 'farsi'],
    he: ['heb', 'hebrew', 'iw'],
    pl: ['pol', 'polish'],
    nl: ['dut', 'nld', 'dutch'],
    sv: ['swe', 'swedish'],
    no: ['nor', 'nob', 'nno', 'nb', 'nn', 'norwegian'],
    da: ['dan', 'danish'],
    fi: ['fin', 'finnish'],
    is: ['ice', 'isl', 'icelandic'],
    cs: ['cze', 'ces', 'czech'],
    sk: ['slo', 'slk', 'slovak'],
    hu: ['hun', 'hungarian'],
    ro: ['rum', 'ron', 'romanian'],
    bg: ['bul', 'bulgarian'],
    el: ['gre', 'ell', 'greek'],
    uk: ['ukr', 'ukrainian'],
    sr: ['srp', 'serbian'],
    hr: ['hrv', 'croatian'],
    ca: ['cat', 'catalan'],
    la: ['lat', 'latin'],
  }).flatMap(([two, others]) => [[two, two] as const, ...others.map((other) => [other, two] as const)]),
);

/** Tags that name no language. */
const NO_LANGUAGE = new Set(['', 'und', 'unk', 'mul', 'zxx', 'mis', 'qaa', 'xx', 'unknown', 'undefined', 'default', 'original', 'audio']);

/** One language tag in the common form ("eng", "en-US", "English" are "en"); null when it names no language ("und"). */
export function normalizeAudioLang(tag: string | null): string | null {
  const text = (tag ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
  const head = text.split(/[-_\s(]/)[0] ?? '';
  if (NO_LANGUAGE.has(text) || NO_LANGUAGE.has(head)) return null;
  const known = TO_TWO.get(text) ?? TO_TWO.get(head);
  if (known !== undefined) return known;
  return /^[a-z]{2,3}$/.test(head) ? head : null;
}

/** The distinct languages the file's audio streams name, in order; empty when none names one. */
export function audioLanguages(probe: MediaProbe): string[] {
  const out: string[] = [];
  for (const a of probe.audio) {
    const lang = normalizeAudioLang(a.lang);
    if (lang !== null && !out.includes(lang)) out.push(lang);
  }
  return out;
}

/** `mp4 h264 720p / aac`: one line for an attempt's detail and the log. */
export function describeProbe(probe: MediaProbe): string {
  const format = probe.container.split(',')[0] || 'unknown';
  const video = probe.video === null ? 'no video' : `${probe.video.codec}${probe.video.height === null ? '' : ` ${probe.video.height}p`}`;
  const audio = probe.audio.map((a) => a.codec).join('+') || 'no audio';
  return `${format} ${video} / ${audio}`;
}
