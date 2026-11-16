#!/usr/bin/env node
// A stand-in for Whisper's Python running claude/streaming/torrent/vad.py: same output, no model. Point
// NOTESD_TORRENT_WHISPER_PYTHON at this file (with NOTESD_TORRENT_WHISPER=off, so the Whisper tier does not take
// it for its worker). It is run as `<this> -I <vad.py> <wav>` and prints the stretches of "speech" of that WAV:
// 8.5 s in every 10 s, as far as the WAV's header says it runs, so the spans prove ffmpeg cut real audio.
//   FAKE_VAD_LOG  append each run, as JSON with its time and the WAV's length, to this file
import { appendFileSync, closeSync, openSync, readSync } from 'node:fs';

const wav = process.argv.at(-1);
const fd = openSync(wav, 'r');
let seconds = 0;
try {
  const head = Buffer.alloc(44);
  readSync(fd, head, 0, 44, 0);
  if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 36, 40) !== 'data') throw new Error('not a 44-byte-header WAV');
  seconds = head.readUInt32LE(40) / 32000;
} finally {
  closeSync(fd);
}
const spans = [];
for (let t = 0; t + 9.5 <= seconds; t += 10) spans.push([t + 1, t + 9.5]);
if (process.env.FAKE_VAD_LOG) appendFileSync(process.env.FAKE_VAD_LOG, `${JSON.stringify({ at: new Date().toISOString(), wav_s: Math.round(seconds * 10) / 10, spans: spans.length })}\n`);
process.stdout.write(`${JSON.stringify(spans)}\n`);
