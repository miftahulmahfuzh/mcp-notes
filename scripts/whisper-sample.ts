/**
 * One stretch of a film through the torrent source's Whisper tier, outside the daemon: ffmpeg cuts
 * the audio, the worker (claude/streaming/torrent/whisper.py) transcribes it, and the cues are
 * printed in film time. Reads NOTESD_TORRENT_WHISPER_DIR / _PYTHON / _MODEL / _THREADS as the
 * daemon does (default folder: <NOTES_DATA_DIR or ~/mcp-notes-data>/whisper, which
 * scripts/install.sh fills). Never starts the daemon or opens the database.
 *
 *   npx tsx scripts/whisper-sample.ts <file or http(s) address> [--start 100] [--length 60] [--lang en]
 *
 * Prints one JSON line: {"task", "language", "audio_s", "took_s", "cues": [{start_s, end_s, text}]}.
 * `took_s` includes loading the model (and downloading it, the first time).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_TORRENT_WHISPER_SCRIPT, parseTorrentWhisper } from '../src/config.js';
import { ffmpegCutter, placeCues, whisperTask, WorkerTranscriber } from '../src/directStream/torrent/subtitles/whisper.js';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { start: { type: 'string', default: '0' }, length: { type: 'string', default: '60' }, lang: { type: 'string' } },
  });
  const input = positionals[0];
  const startS = Number(values.start);
  const lengthS = Number(values.length);
  if (input === undefined || !Number.isFinite(startS) || startS < 0 || !Number.isFinite(lengthS) || lengthS <= 0) {
    console.error('usage: npx tsx scripts/whisper-sample.ts <file or http(s) address> [--start S] [--length S] [--lang en]');
    process.exit(2);
  }
  const dataDir = process.env.NOTES_DATA_DIR?.trim() || path.join(os.homedir(), 'mcp-notes-data');
  const whisper = parseTorrentWhisper({ ...process.env, NOTESD_TORRENT_WHISPER: 'on' }, dataDir);
  if (!whisper.enabled) throw new Error('Whisper is off');
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'notesd-whisper-sample-'));
  const transcriber = new WorkerTranscriber({
    python: whisper.python,
    script: DEFAULT_TORRENT_WHISPER_SCRIPT,
    model: whisper.model,
    threads: whisper.threads,
    modelsDir: path.join(whisper.dir, 'models'),
    hfHome: path.join(whisper.dir, 'hf'),
    log: (line) => console.error(line),
  });
  try {
    const wav = path.join(tmp, 'stretch.wav');
    const cut = await ffmpegCutter({ ffmpegBin: 'ffmpeg' })({ url: input, startS, lengthS, out: wav }, AbortSignal.timeout(10 * 60_000));
    if (!cut.ok) throw new Error(`ffmpeg could not cut the audio: ${cut.reason}`);
    const { task, language } = whisperTask(values.lang ?? null);
    const started = Date.now();
    const cues = await transcriber.transcribe({ wav, task, language }, AbortSignal.timeout(20 * 60_000));
    console.log(JSON.stringify({ task, language, audio_s: cut.lengthS, took_s: (Date.now() - started) / 1000, cues: placeCues(cues, startS) }));
  } finally {
    await transcriber.stop();
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
