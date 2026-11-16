#!/usr/bin/env python3
"""notesd's speech detector: where people talk in one stretch of a film's audio.

    vad.py <wav>

reads a 16 kHz mono 16-bit PCM WAV (as the daemon's ffmpeg writes it) and prints one JSON line,
[[start_s, end_s], ...], the stretches of speech in seconds into the WAV, found with the Silero VAD
that ships inside faster-whisper (no model is downloaded). It reads only the WAV it is handed and
writes nothing.

Run by src/directStream/torrent/subtitles/synced.ts with Whisper's Python, to ask Wyzie Synced for
the subtitle that fits the film's audio.
"""
import json
import sys
import wave

SAMPLE_RATE = 16000


def read_wav(path):
    import numpy as np

    with wave.open(path, "rb") as w:
        if w.getframerate() != SAMPLE_RATE or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError("the stretch must be 16 kHz mono 16-bit PCM")
        frames = w.readframes(w.getnframes())
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


def main():
    if len(sys.argv) != 2:
        sys.stderr.write("usage: vad.py <wav>\n")
        return 2
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    samples = read_wav(sys.argv[1])
    spans = get_speech_timestamps(samples, VadOptions(min_silence_duration_ms=300))
    out = [[round(s["start"] / SAMPLE_RATE, 2), round(s["end"] / SAMPLE_RATE, 2)] for s in spans]
    sys.stdout.write(json.dumps(out) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
