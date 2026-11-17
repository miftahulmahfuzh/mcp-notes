#!/usr/bin/env node
// A stand-in for claude/streaming/torrent/whisper.py: same JSON lines, no model. Point
// NOTESD_TORRENT_WHISPER_PYTHON (or WorkerTranscriber's `python`) at this file; its arguments are
// ignored. Each request answers one cue, "Whisper line <n> (<task>, <seconds> s of audio)", at
// 0.5-2.5 s of the stretch, read from the WAV header, so a cue proves ffmpeg cut real audio.
//   FAKE_WHISPER_MODE      ok (default) | not_ready (fails to load) | error (every request fails)
//   FAKE_WHISPER_DELAY_MS  wait this long before each answer (default 0)
//   FAKE_WHISPER_LOG       append each request, as JSON with its time, to this file
//   FAKE_WHISPER_DETECT_LANG  language a "detect" request answers (default "en")
//   FAKE_WHISPER_DETECT_PROB  probability a "detect" request answers (default "0.98")
import { appendFileSync, closeSync, openSync, readSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.env.FAKE_WHISPER_MODE ?? 'ok';
const delayMs = Number(process.env.FAKE_WHISPER_DELAY_MS ?? '0');
const logFile = process.env.FAKE_WHISPER_LOG ?? '';
const detectLang = process.env.FAKE_WHISPER_DETECT_LANG ?? 'en';
const detectProb = Number(process.env.FAKE_WHISPER_DETECT_PROB ?? '0.98');

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

function wavSeconds(file) {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(44);
    readSync(fd, head, 0, 44, 0);
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 36, 40) !== 'data') throw new Error('not a 44-byte-header WAV');
    return head.readUInt32LE(40) / 32000;
  } finally {
    closeSync(fd);
  }
}

function main() {
  if (mode === 'not_ready') {
    out({ ready: false, error: 'faster_whisper cannot be imported: fake worker told to fail' });
    process.exitCode = 2;
    return;
  }
  out({ ready: true, model: 'fake', threads: 0, load_s: 0 });
  let count = 0;
  let chain = Promise.resolve();
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    chain = chain.then(async () => {
      if (line.trim() === '') return;
      const req = JSON.parse(line);
      if (logFile !== '') appendFileSync(logFile, `${JSON.stringify({ ...req, at: new Date().toISOString() })}\n`);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (mode === 'error') {
        out({ id: req.id, error: 'fake worker told to fail' });
        return;
      }
      if (req.task === 'detect') {
        out({ id: req.id, language: detectLang, probability: detectProb, took_s: delayMs / 1000 });
        return;
      }
      try {
        const seconds = wavSeconds(req.wav);
        count += 1;
        const cues = seconds < 1 ? [] : [{ start_s: 0.5, end_s: Math.min(seconds, 2.5), text: `Whisper line ${count} (${req.task}, ${seconds.toFixed(1)} s of audio)` }];
        out({ id: req.id, cues, took_s: delayMs / 1000 });
      } catch (err) {
        out({ id: req.id, error: String(err?.message ?? err) });
      }
    });
  });
  lines.on('close', () => {
    void chain.then(() => process.exit(0));
  });
}

main();
