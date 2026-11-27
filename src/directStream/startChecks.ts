import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_FFMPEG_BIN, DEFAULT_TORRENT_WHISPER_SCRIPT, type Config } from '../config.js';
import { MOVIES_SUBDIR } from '../movies/service.js';
import { AUDIO_VERDICTS_FILE, AudioLangCheck, AudioVerdicts, streamAudioGrabber } from './audioLang.js';
import { PICTURE_VERDICTS_FILE, PictureCheck, PictureVerdicts, createPictureJudge, ffmpegFrameGrabber, firstFrameOf, hlsSegmentFrameGrabber, hlsStreamReach, type PictureJudge } from './picture.js';
import { WHISPER_IDLE_STOP_MS, WorkerTranscriber, type WorkerTranscriberOptions } from './torrent/subtitles/whisper.js';

/** The checks a stream gets before its first play of a title, and the one Whisper worker every hearing shares. */
export interface StreamChecks {
  /** Looks at a stream's picture (a cinema recording, a burned-in advert). */
  picture: PictureCheck | null;
  /** The daemon's one Whisper worker (about 850 MB loaded): started on the first ask, ended when idle. */
  sharedWhisper: WorkerTranscriber | null;
  /** Hears a cloud stream's audio to tell a dub from the original. */
  audioCheck: AudioLangCheck | null;
}

export interface StreamChecksIo {
  judge?: (opts: Parameters<typeof createPictureJudge>[0]) => PictureJudge | null;
  /** Whether Whisper's Python can run. Default: an X_OK access check. */
  canRun?: (path: string) => Promise<boolean>;
  worker?: (opts: WorkerTranscriberOptions) => WorkerTranscriber;
  log?: (line: string) => void;
}

/**
 * The picture check: two frames through ffmpeg and one model call, kept per title and provider. Null with
 * NOTESD_STREAM_PICTURE_MODEL=off, without direct streaming (or the library), or without a claude binary.
 *
 * The shared Whisper worker serves the cloud audio-language check, the torrent and cloud transcripts and
 * /sync-subtitle; a play's language check goes ahead of queued transcriptions. Null with Whisper off or before
 * install.sh has made its Python (said once in the log when the audio check would have used it).
 *
 * The audio check: ~30 s of a cloud stream through Whisper before its first play of a foreign-language title. Null with
 * NOTESD_STREAM_AUDIO_CHECK=off, without the picture check, without direct streaming or without the worker.
 */
export async function buildStreamChecks(config: Config, moviesOn: boolean, io: StreamChecksIo = {}): Promise<StreamChecks> {
  const log = io.log ?? ((line: string) => console.log(line));
  const directOn = moviesOn && config.directStream?.enabled === true;
  const ffmpegBin = config.directStream?.ffmpegBin ?? DEFAULT_FFMPEG_BIN;
  const pictureModel = directOn ? (config.directStream?.pictureModel ?? null) : null;
  const pictureJudge = pictureModel === null ? null : (io.judge ?? createPictureJudge)({ claudeBin: config.chat.claudeBin, model: pictureModel, cwd: join(config.dataDir, 'movies-picture') });
  const picture =
    pictureJudge === null
      ? null
      : new PictureCheck({
          verdicts: new PictureVerdicts(join(config.dataDir, MOVIES_SUBDIR, PICTURE_VERDICTS_FILE)),
          // ffmpeg on the manifest; for an HLS stream it cannot open (segments wrapped in a picture file), the segment itself.
          grab: firstFrameOf(ffmpegFrameGrabber({ ffmpegBin }), hlsSegmentFrameGrabber({ ffmpegBin })),
          // No frame: the attempt says whether the stream's host still hands out a segment. Either way the stream plays.
          reach: hlsStreamReach(),
          judge: pictureJudge,
        });
  const audioCheckOn = directOn && config.directStream?.audioCheck !== false && picture !== null;
  const whisperCfg = config.torrent?.whisper;
  let sharedWhisper: WorkerTranscriber | null = null;
  if (whisperCfg?.enabled === true) {
    const canRun = io.canRun ?? ((path: string) => access(path, fsConstants.X_OK).then(() => true, () => false));
    if (await canRun(whisperCfg.python)) {
      sharedWhisper = (io.worker ?? ((opts: WorkerTranscriberOptions) => new WorkerTranscriber(opts)))({
        python: whisperCfg.python,
        script: DEFAULT_TORRENT_WHISPER_SCRIPT,
        model: whisperCfg.model,
        threads: whisperCfg.threads,
        modelsDir: join(whisperCfg.dir, 'models'),
        hfHome: join(whisperCfg.dir, 'hf'),
        idleStopMs: WHISPER_IDLE_STOP_MS,
        log: (line) => console.log(line),
      });
    } else if (audioCheckOn) {
      log(`[notesd] direct stream: no Whisper Python at ${whisperCfg.python}; cloud audio-language check off. No change to cloud plays until scripts/install.sh installs it.`);
    }
  }
  const audioDetector = audioCheckOn ? sharedWhisper : null;
  const audioCheck =
    audioDetector === null
      ? null
      : new AudioLangCheck({
          verdicts: new AudioVerdicts(join(config.dataDir, MOVIES_SUBDIR, AUDIO_VERDICTS_FILE)),
          // The stream's own segments first (hlsCut.ts), ffmpeg on the manifest when they give nothing.
          grab: streamAudioGrabber({ ffmpegBin }),
          detector: audioDetector,
        });
  return { picture, sharedWhisper, audioCheck };
}

/**
 * The torrent audio check: a torrent whose file tags no audio language is heard behind the play through the shared
 * Whisper worker, for any title whose original language is known. Null with NOTESD_STREAM_AUDIO_CHECK=off, without
 * direct streaming, or without the worker.
 */
export function buildTorrentHearer(config: Config, sharedWhisper: WorkerTranscriber | null): AudioLangCheck | null {
  if (sharedWhisper === null || config.directStream?.enabled !== true || config.directStream.audioCheck === false) return null;
  return new AudioLangCheck({
    verdicts: new AudioVerdicts(join(config.dataDir, MOVIES_SUBDIR, AUDIO_VERDICTS_FILE)),
    grab: streamAudioGrabber({ ffmpegBin: config.directStream.ffmpegBin ?? DEFAULT_FFMPEG_BIN }),
    detector: sharedWhisper,
  });
}
