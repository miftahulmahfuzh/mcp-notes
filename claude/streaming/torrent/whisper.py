#!/usr/bin/env python3
"""notesd's Whisper worker: the last subtitle tier of a torrent session.

A long-lived process, so the model loads once. It reads one JSON request per line on stdin:

    {"id": "3", "wav": "/abs/stretch.wav", "task": "transcribe" | "translate", "language": "es" | null}
    {"id": "4", "wav": "/abs/clip.wav", "task": "detect"}

and writes one JSON line per request on stdout:

    {"id": "3", "cues": [{"start_s": 1.2, "end_s": 3.4, "text": "..."}], "took_s": 41.0}
    {"id": "4", "language": "zh", "probability": 0.98, "took_s": 1.1}
    {"id": "3", "error": "..."}

A "detect" request answers the language actually spoken in the clip (the daemon's cloud audio check,
src/directStream/audioLang.ts): no cues, the segments generator is never iterated.

Cue times are seconds into the stretch; the daemon adds the stretch's start. The first line it
writes is {"ready": true, "model": "small", ...} once the model is loaded (downloaded into
--models-dir on first use), or {"ready": false, "error": "..."} before it exits. It exits when
stdin closes. It reads only the WAV it is handed and writes nothing but the model cache.

Run by src/directStream/torrent/subtitles/whisper.ts and, with --download-only, by
scripts/install.sh to fetch the model ahead of the first play.
"""
import argparse
import json
import sys
import time
import wave


def read_wav(path):
    """16 kHz mono 16-bit PCM, as the daemon's ffmpeg writes it, to float32 samples.

    Decoded here rather than by faster-whisper, whose PyAV decoder breaks on newer PyAV releases.
    """
    import numpy as np

    with wave.open(path, "rb") as w:
        if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError("the stretch must be 16 kHz mono 16-bit PCM")
        frames = w.readframes(w.getnframes())
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="small")
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--models-dir", required=True)
    parser.add_argument("--download-only", action="store_true")
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except Exception as err:  # the venv is missing or broken
        emit({"ready": False, "error": f"faster_whisper cannot be imported: {err}"})
        return 2

    started = time.monotonic()
    try:
        model = WhisperModel(
            args.model,
            device="cpu",
            compute_type="int8",
            cpu_threads=args.threads,
            download_root=args.models_dir,
        )
    except Exception as err:
        emit({"ready": False, "error": f"model {args.model} did not load: {err}"})
        return 2
    emit({"ready": True, "model": args.model, "threads": args.threads, "load_s": round(time.monotonic() - started, 1)})
    if args.download_only:
        return 0

    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = str(req.get("id"))
            raw_task = req.get("task")
            t0 = time.monotonic()
            if raw_task == "detect":
                # Which language is actually spoken, from the first ~30 s: faster-whisper computes
                # info.language eagerly, so the segments generator is never iterated.
                _segments, info = model.transcribe(read_wav(req["wav"]), language=None, vad_filter=True)
                emit({"id": req_id, "language": info.language, "probability": round(float(info.language_probability), 4), "took_s": round(time.monotonic() - t0, 2)})
                continue
            task = raw_task if raw_task in ("transcribe", "translate") else "transcribe"
            language = req.get("language") or None
            segments, _info = model.transcribe(
                read_wav(req["wav"]),
                task=task,
                language=language,
                vad_filter=True,
                beam_size=5,
                condition_on_previous_text=False,
                word_timestamps=True,
            )
            cues = []
            for seg in segments:
                text = seg.text.strip()
                if text:
                    words = seg.words or []
                    start = words[0].start if words else seg.start
                    end = words[-1].end if words else seg.end
                    cues.append({"start_s": round(start, 3), "end_s": round(end, 3), "text": text})
            emit({"id": req_id, "cues": cues, "took_s": round(time.monotonic() - t0, 2)})
        except Exception as err:
            emit({"id": req_id, "error": str(err)[:300]})
    return 0


if __name__ == "__main__":
    sys.exit(main())
