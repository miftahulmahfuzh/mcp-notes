> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/torrent-stream-source/PLAN.md` phase 8. Source: `.workflows/plan/torrent-stream-source/phase-8.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 8: Whisper, the last resort

**Plan set:** `TORRENT_STREAM_SOURCE_PLAN.md`
**Analysis:** `.workflows/analyze/20261116-192341-T7QK_code_analyzer.md`
**Satisfies:** R3 — "making sure we have english subtitle by any means necessary"
**Criteria:** R3.6
**Depends on:** Phase 7 (and through it 6, 3, 1)
**Difficulty:** HARD
**Package:** `src/directStream/torrent/subtitles`

---

## Goal

When every earlier subtitle tier of a torrent session answers nothing, the session still starts at
once, with a growing subtitle track labelled `English (Whisper)`. Behind it the daemon cuts the
chosen file's audio into stretches with ffmpeg (reading the torrent's own file route, so it waits
for bytes that are not downloaded yet), runs a CPU Whisper (faster-whisper, int8) over each stretch
in a long-lived Python worker, and appends the cues to phase 7's growing cue feed, which the player
already re-reads. `scripts/install.sh` installs that Whisper by itself; nobody runs a manual step.

## Measured on this machine (2026-11-16, before writing this plan)

All of it in a scratch venv under `/tmp/claude-1000/whisper-scratch/`, removed afterwards (nothing
was written to `~/.cache/huggingface`).

| What | Command | Result |
|---|---|---|
| System Python venv | `/usr/bin/python3 -m venv x` | **fails**: Ubuntu's 3.12.3 has no `ensurepip` (`python3-venv` not installed) |
| Miniconda venv | `python3 -m venv venv` (`/home/miftah/miniconda3/bin/python3`, 3.12.7) | 2 s |
| Install | `venv/bin/pip install -q faster-whisper` | 10 s; faster-whisper 1.2.1, ctranslate2 4.9.0, onnxruntime 1.32.0, av 19.0.2; venv 479 MB |
| Model `small` | `WhisperModel('small', device='cpu', compute_type='int8', cpu_threads=8, download_root=./models)` | download + load 46 s; 464 MB on disk; later loads 0.7 s |
| Sample | `ffmpeg -t 360 -i https://download.blender.org/durian/movies/Sintel.2010.1080p.mkv -vn -ac 1 -ar 16000 -c:a pcm_s16le` | 63 s, 11 MB (Sintel, Blender Foundation, CC BY) |
| Realtime factor, 60 s of dialogue (100–160 s), 8 threads | worker request | **2.2 s** (transcribe), 2.9 s (translate); 11 cues, all correct lines |
| 5-minute stretch (0–300 s), 8 threads | worker request | **2.5 s**; peak RSS 845 MB; VAD skips the music |
| ffmpeg input seek over HTTP | `ffmpeg -ss 600 -t 30 -i <mkv url> -map 0:a:0 ... -fflags +bitexact -flags:a +bitexact cut.wav` | 5 s; 960 044 bytes = 44-byte header + exactly 30 s |
| Long-lived worker | node spawns it, writes one line, reads one line, stdin left open | answers each request, survives a bad request (`{"id":"2","error":"[Errno 2] ..."}`) |

Two findings changed the design:

- **faster-whisper 1.2.1's own audio decoder breaks with PyAV 19** (`open() got an unexpected
  keyword argument 'metadata_errors'`). The worker therefore decodes the WAV itself (stdlib `wave`
  + numpy, which ctranslate2 already pulls in) and hands faster-whisper a float array. ffmpeg
  writes exactly that format, so nothing else is lost.
- **Segment ends are loose without word timestamps**: one cue ran 155–212 s. With
  `word_timestamps=True` it became 208.2–211.6 s at the same cost (2.56 s vs 2.49 s). The daemon
  still caps a cue at 7 s. A line right after a long stretch of music can be missed ("This blade has
  a dark past" at 106 s was missed from the 0–300 s stretch and caught from 100–160 s); the guide
  says so.
- Translation of a non-English film: **unmeasured** (no cheap public-domain non-English sample was
  fetched). The `translate` path ran on English audio (language detected, English out, 2.9 s).

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `src/directStream/torrent/subtitles/whisper.ts`: `WhisperTier` (class; `name = 'whisper'`,
  `find(ctx: WhisperContext) → Promise<WhisperTrack[]>`, `close()`), `buildWhisperTier(options) →
  Promise<WhisperTier | null>`, `WorkerTranscriber` (class, `Transcriber`), `ffmpegCutter(options) →
  AudioCutter`, `cutArgs`, `placeCues`, `firstStretch`, `whisperTask`, `parseCues`, and the types
  `WhisperCue`, `WhisperTask`, `WhisperRequest`, `Transcriber`, `AudioCutter`, `StretchRequest`,
  `StretchCut`, `WhisperFeed`, `OpenWhisperFeed`, `WhisperContext`, `WhisperTrack`; constants
  `WHISPER_TIER_NAME`, `WHISPER_LABEL` (`'English (Whisper)'`), `WHISPER_MAX_CUE_S` (7).
- `claude/streaming/torrent/whisper.py` (the worker; JSON lines on stdin and stdout).
- `src/config.ts`: `TorrentWhisperConfig` (union: `{ enabled: false } | { enabled: true; dir;
  python; model; threads; stretchS }`), `parseTorrentWhisper(env, dataDir)`,
  `DEFAULT_TORRENT_WHISPER_CONFIG` (off), `DEFAULT_TORRENT_WHISPER_MODEL`,
  `DEFAULT_TORRENT_WHISPER_THREADS`, `DEFAULT_TORRENT_WHISPER_STRETCH_S`,
  `MIN_TORRENT_WHISPER_STRETCH_S`, `DEFAULT_TORRENT_WHISPER_SCRIPT`; the field
  `TorrentConfig.whisper`.
- Settings: `NOTESD_TORRENT_WHISPER` (on), `NOTESD_TORRENT_WHISPER_DIR` (`<dataDir>/whisper`),
  `NOTESD_TORRENT_WHISPER_PYTHON` (`<dir>/venv/bin/python`), `NOTESD_TORRENT_WHISPER_MODEL`
  (`small`), `NOTESD_TORRENT_WHISPER_THREADS` (8), `NOTESD_TORRENT_WHISPER_STRETCH_S` (300).
- `AppDeps.torrentWhisper?: WhisperTier | null` (`src/deps.ts`), closed in `src/background.ts`.
- `scripts/install.sh`: `ENV_LOCAL`, `env_local_value`, `is_off`, `whisper_base_python`,
  `install_whisper` (called from `main` before `install_unit`); `WHISPER_PACKAGE=faster-whisper==1.2.1`.
- `scripts/whisper-sample.ts` (one stretch through the real cutter and worker, outside the daemon).
- `tests/fixtures/torrent/fake-whisper.mjs` (executable fake worker, same protocol).
- Files on disk: `<torrent dir>/<infohash>/notesd-whisper/<infohash>-<fileIndex>.json` (finished stretches) and the
  short-lived `<torrent dir>/<infohash>/notesd-whisper/<infohash>-<fileIndex>-<startS>.wav` (inside the torrent's
  folder: they survive the swarm leaving and go with the folder on prune); `<whisper dir>/{venv,models,hf}`.
- `WHISPER_DIR` (`notesd-whisper`); in phase 3's `chain.ts`, the `SubtitleTierDeps.whisper` field, the tier last in
  `buildSubtitleTiers`, and `whisperCovers` on phase 6's borrow line.

**Signature changes:** `TorrentConfig` gains `whisper: TorrentWhisperConfig`; phase 1's
`parseTorrent` gains one line `whisper: parseTorrentWhisper(env, dataDir)` and
`DEFAULT_TORRENT_CONFIG` gains `whisper: DEFAULT_TORRENT_WHISPER_CONFIG`.

**Requires (from earlier phases):**
- Phase 1: `config.torrent` with `dir`, `parseTorrent(env, dataDir)` (or any parse function that has
  the data dir in scope), `TorrentStreams.localUrl(infoHash, index)` answering
  `/api/stream/torrent/<hash>/f/<index>`, a route that blocks a ranged read until the bytes are on
  disk, and a daemon local holding the `TorrentStreams` (called `torrents` below).
- Phase 3 (reconciled): a `SubtitleTier` is `{ name, blocks, skip?, find(ctx) }`, tried in order; the chain stops
  at the first tier that answers anything, so the tier last in `buildSubtitleTiers` runs only when every earlier one
  answered nothing. This tier is growing (`blocks: false`): it answers at once and is not counted in the chain's 40 s
  budget. The `ctx` (phase 3's `SubtitleContext`) carries **`infoHash`, `fileIndex`, `audioLang` (the title's
  original language: lower-case two letters or null), `resumeS` (number | null), `probe` (the `MediaProbe`, read for
  `durationS`) and `signal` (an `AbortSignal` aborted when the session lets go of the torrent)**. `WhisperTier.find`
  takes a structural `WhisperContext` with exactly those fields, so `whisper.ts` does not import `chain.ts`.
- Phase 3: `config.torrent.ffmpegBin` (`NOTESD_FFMPEG_BIN`), the one ffmpeg the torrent source runs.
- Phase 6: `borrowTier`'s `whisperCovers` option (the borrow is skipped for an English original when it is true).
- Phase 7: `subtitles/feed.ts`: `CueFeeds.get(infoHash, track)` / `CueFeeds.start(infoHash, track)` (a daemon local
  `torrentCues`), `CueFeed.append(cues)` (cue = `{ start_s, end_s, text }`; appends **may come out of time order**:
  reads go by count and the page's TextTrack orders cues itself) and `complete()`, `cueFeedUrl(infoHash, track)`,
  `whisperTrackId(fileIndex)` (`whisper-<file index>`), and the session subtitle's `growing?: true` mark (always set
  for a cue feed, finished or not).

**Leaves alone (owned by others):** `web/` (all of it; phase 7 owns reading a growing track),
`subtitles/{files,service,borrow,embedded,feed}.ts` (in `chain.ts` only the `whisper` field, the tier and `whisperCovers` on the borrow line), `torrent/{engine,store,service,source,probe,remux}.ts`,
`src/http/streamTorrentApi.ts`, `claude/streaming/torrent/cli.mjs` and its site modules (phase 9; this
phase only adds `whisper.py` beside them), `verify.sh` (phase 1's `--torrent` mode; this phase needs
no flag of its own: env passes through).

## Files

| File | Action | What changes |
|---|---|---|
| `src/config.ts` | modify | `TorrentWhisperConfig`, its defaults and `parseTorrentWhisper` (after `parseDirectStream`, today line 700); `whisper` field in `TorrentConfig`, `DEFAULT_TORRENT_CONFIG` and `parseTorrent` (phase 1's); the keys in `loadConfig`'s doc comment (lines 745–748) |
| `src/directStream/torrent/subtitles/whisper.ts` | create | the tier, the worker client, the ffmpeg cutter |
| `claude/streaming/torrent/whisper.py` | create | the faster-whisper worker |
| `src/directStream/torrent/subtitles/chain.ts` (phase 3's, with phases 6 and 7 in it) | modify | `SubtitleTierDeps.whisper`; the tier last; `whisperCovers` on the borrow line |
| `src/daemon.ts` | modify | build the tier after phase 7's feeds, `whisper` in phase 3's tier deps, set `deps.torrentWhisper` |
| `src/deps.ts` | modify | `torrentWhisper?: WhisperTier \| null` (before `sessionEvents`, line 95) |
| `src/background.ts` | modify | `deps.torrentWhisper?.close()` in the stop list (after `streamCache?.close()`, line 221) |
| `scripts/install.sh` | modify | `install_whisper` and helpers; header comment; `main` |
| `scripts/whisper-sample.ts` | create | one stretch through the real cutter and worker |
| `tests/fixtures/torrent/fake-whisper.mjs` | create (mode 755) | fake worker for tests and the throwaway daemon |
| `tests/unit/directStream/torrent/whisper.test.ts` | create | tier, worker client, cutter args |
| `tests/unit/directStream/torrent/whisperConfig.test.ts` | create | `parseTorrentWhisper` |
| `tests/unit/scripts/installWhisper.test.ts` | create | `install_whisper` sourced with a fake `python3` |
| `docs/guide/reference/configuration.md` | modify | six rows in phase 1's torrent table |
| `docs/guide/streaming.md` | modify | `#### Whisper: the last resort` under the Torrents section; a line in "Where the code is" (line 1106) |
| `docs/guide/install.md` | modify | a Requirements line (after line 25) and a "Whisper" row in the step table (after line 48) |
| `.claude/skills/verify-notesd/features/direct-streaming.md` | modify | a "Torrent subtitles: Whisper" section |

## Implementation Steps

### Step 1: Settings
**File:** `src/config.ts:229` (after `DEFAULT_DIRECT_STREAM_CONFIG`) for the types and defaults,
`src/config.ts:700` (after `parseDirectStream`) for the parser; phase 1's `TorrentConfig`,
`DEFAULT_TORRENT_CONFIG` and `parseTorrent` for the field.
**Change:** a switch, a folder, a Python path, a model, threads and the stretch length. The type is a
union so an off config carries nothing that could be read by mistake. The parser is the one place
the values are checked; everything downstream trusts them.
**Code:**
```ts
/** `claude/streaming/torrent/whisper.py` in this checkout: the Whisper worker the torrent source runs (torrent phase 8). */
export const DEFAULT_TORRENT_WHISPER_SCRIPT = path.join(REPO_ROOT, 'claude', 'streaming', 'torrent', 'whisper.py')
export const DEFAULT_TORRENT_WHISPER_MODEL = 'small'
export const DEFAULT_TORRENT_WHISPER_THREADS = 8
/** Five minutes of audio per Whisper run: cues come in steps of this, well ahead of the picture (a 5-minute stretch took 2.5 s on 8 threads). */
export const DEFAULT_TORRENT_WHISPER_STRETCH_S = 300
export const MIN_TORRENT_WHISPER_STRETCH_S = 5

/**
 * Whisper, the last subtitle tier of a torrent session (src/directStream/torrent/subtitles/whisper.ts).
 * Off carries nothing else: no folder, no model, no worker.
 */
export type TorrentWhisperConfig =
  | { enabled: false }
  | {
      /** `NOTESD_TORRENT_WHISPER`, default on. `off`: no Whisper tier and no worker. */
      enabled: true
      /** `NOTESD_TORRENT_WHISPER_DIR`, absolute, default `<dataDir>/whisper`: `venv/`, `models/` and `hf/` (scripts/install.sh fills it). */
      dir: string
      /** `NOTESD_TORRENT_WHISPER_PYTHON`, absolute, default `<dir>/venv/bin/python`. */
      python: string
      /** `NOTESD_TORRENT_WHISPER_MODEL`, default `small`: a faster-whisper model name or Hugging Face repo id. */
      model: string
      /** `NOTESD_TORRENT_WHISPER_THREADS`, default 8: CPU threads of the worker. */
      threads: number
      /** `NOTESD_TORRENT_WHISPER_STRETCH_S`, default 300, at least 5: seconds of audio per Whisper run. */
      stretchS: number
    }

/** Whisper off. DEFAULT_TORRENT_CONFIG carries it, so no test that builds a Config literal ever starts a worker. */
export const DEFAULT_TORRENT_WHISPER_CONFIG: TorrentWhisperConfig = { enabled: false }

const WHISPER_MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

export function parseTorrentWhisper(env: Record<string, string | undefined>, dataDir: string): TorrentWhisperConfig {
  if (!parseSwitch('NOTESD_TORRENT_WHISPER', env.NOTESD_TORRENT_WHISPER)) return { enabled: false }
  const dir = parseOptionalAbsolutePath('NOTESD_TORRENT_WHISPER_DIR', env.NOTESD_TORRENT_WHISPER_DIR) ?? path.join(dataDir, 'whisper')
  const model = env.NOTESD_TORRENT_WHISPER_MODEL?.trim() || DEFAULT_TORRENT_WHISPER_MODEL
  if (!WHISPER_MODEL_NAME.test(model) || model.includes('..')) {
    throw new ConfigError(`NOTESD_TORRENT_WHISPER_MODEL must be a model name such as small or a repo id, got "${env.NOTESD_TORRENT_WHISPER_MODEL}"`)
  }
  const stretchS = parsePositiveInt('NOTESD_TORRENT_WHISPER_STRETCH_S', env.NOTESD_TORRENT_WHISPER_STRETCH_S, DEFAULT_TORRENT_WHISPER_STRETCH_S)
  if (stretchS < MIN_TORRENT_WHISPER_STRETCH_S) {
    throw new ConfigError(`NOTESD_TORRENT_WHISPER_STRETCH_S must be at least ${MIN_TORRENT_WHISPER_STRETCH_S}, got "${env.NOTESD_TORRENT_WHISPER_STRETCH_S}"`)
  }
  return {
    enabled: true,
    dir,
    python: parseOptionalAbsolutePath('NOTESD_TORRENT_WHISPER_PYTHON', env.NOTESD_TORRENT_WHISPER_PYTHON) ?? path.join(dir, 'venv', 'bin', 'python'),
    model,
    threads: parsePositiveInt('NOTESD_TORRENT_WHISPER_THREADS', env.NOTESD_TORRENT_WHISPER_THREADS, DEFAULT_TORRENT_WHISPER_THREADS),
    stretchS,
  }
}
```
In phase 1's `TorrentConfig` interface add (the doc comment style of the file):
```ts
  /** Whisper, the last subtitle tier (torrent phase 8). */
  whisper: TorrentWhisperConfig
```
In phase 1's `DEFAULT_TORRENT_CONFIG` literal add `whisper: DEFAULT_TORRENT_WHISPER_CONFIG,` and in
the object `parseTorrent` returns add `whisper: parseTorrentWhisper(env, dataDir),` (`dataDir` is the
resolved data directory phase 1 already uses for `NOTESD_TORRENT_DIR`'s default).
In `loadConfig`'s doc comment, after the direct-streaming prober keys line (748), add:
```ts
 * Torrent Whisper keys: NOTESD_TORRENT_WHISPER, NOTESD_TORRENT_WHISPER_DIR, NOTESD_TORRENT_WHISPER_PYTHON,
 * NOTESD_TORRENT_WHISPER_MODEL, NOTESD_TORRENT_WHISPER_THREADS, NOTESD_TORRENT_WHISPER_STRETCH_S (a relative
 * folder or Python, a model name with spaces or `..`, or a stretch under 5 s throw ConfigError).
```
**Impact:** six quoted names in `config.ts`, so `npm test`'s docs check fails until Step 9 adds their
rows; land Steps 1 and 9 together.

### Step 2: The worker
**File:** `claude/streaming/torrent/whisper.py` (new)
**Change:** the script measured above, unchanged from what ran. It is long-lived, loads the model once,
reads one JSON request per line, answers one JSON line per request, decodes the WAV itself, and exits
when stdin closes (so a daemon that dies takes it down with it).
**Code:**
```python
#!/usr/bin/env python3
"""notesd's Whisper worker: the last subtitle tier of a torrent session.

A long-lived process, so the model loads once. It reads one JSON request per line on stdin:

    {"id": "3", "wav": "/abs/stretch.wav", "task": "transcribe" | "translate", "language": "es" | null}

and writes one JSON line per request on stdout:

    {"id": "3", "cues": [{"start_s": 1.2, "end_s": 3.4, "text": "..."}], "took_s": 41.0}
    {"id": "3", "error": "..."}

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
            task = req.get("task") if req.get("task") in ("transcribe", "translate") else "transcribe"
            language = req.get("language") or None
            t0 = time.monotonic()
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
```
**Impact:** none on the tree (not run by tests). Mode 644 is fine: the daemon runs it as `python -I whisper.py`.

### Step 3: The tier, the worker client and the cutter
**File:** `src/directStream/torrent/subtitles/whisper.ts` (new)
**Change:** everything the daemon side of Whisper needs, behind three injected seams (the feed
opener, the cutter, the transcriber) so tests run none of ffmpeg, Python or a feed route.
**Code:**
```ts
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { setPriority } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { DEFAULT_TORRENT_WHISPER_SCRIPT, type TorrentWhisperConfig } from '../../../config.js';

/**
 * Whisper, the last subtitle tier of a torrent session (TORRENT_STREAM_SOURCE phase 8).
 *
 * It runs only when every earlier tier (a subtitle file in the torrent, the subtitle service, a
 * cloud provider's, the embedded text track) answered nothing. It never delays a play: `find`
 * answers at once with a growing track named "English (Whisper)" and the work goes on behind it.
 * The chosen file's first audio stream is cut into stretches with ffmpeg from the torrent's own
 * file route (a stretch whose bytes are not downloaded yet waits on the route), each stretch goes
 * through a long-lived faster-whisper worker (claude/streaming/torrent/whisper.py), and the cues,
 * moved to their place in the film, are appended to phase 7's growing cue feed.
 *
 * Order: the stretch the play starts in, then each one after it, then those before it, so cues are
 * ahead of the picture soon after the start. A title whose original language is English is
 * transcribed; any other is translated into English.
 *
 * It stops when the session releases the torrent (its signal aborts) or notesd stops. The finished
 * stretches are kept in `<torrent dir>/<info hash>/notesd-whisper/<info hash>-<file index>.json`, inside the
 * torrent's own folder beside phase 7's feed (both survive the swarm leaving and go with the folder when the download
 * is cleared), so a replay carries on from there, and a file done to the end starts nothing.
 */

export const WHISPER_TIER_NAME = 'whisper';
/** The tier's folder inside a torrent's folder: progress files and the WAV of the stretch in progress. */
export const WHISPER_DIR = 'notesd-whisper';
/** A transcript is not a subtitle: the track says what it is. */
export const WHISPER_LABEL = 'English (Whisper)';
/** A cue stays on screen at most this long, however long the worker says the line ran. */
export const WHISPER_MAX_CUE_S = 7;
/** First use downloads the model (464 MB for `small`, 46 s measured), so the first load may take long. */
export const WHISPER_READY_TIMEOUT_MS = 15 * 60_000;
/** One stretch: 5 minutes of dialogue took 2.5 s on 8 threads with `small`; a big model on few threads is far slower. */
export const WHISPER_STRETCH_TIMEOUT_MS = 10 * 60_000;
/** One cut: ffmpeg waits on the file route until the stretch's bytes are downloaded. */
export const WHISPER_CUT_TIMEOUT_MS = 30 * 60_000;
/** Failed stretches in a row before a file is given up (a replay tries again). */
export const WHISPER_MAX_FAILURES = 3;
/** The worker runs below the daemon, so the torrent engine and the file route stay quick. */
const WORKER_NICENESS = 10;
/** 16 kHz mono 16-bit PCM, with the 44-byte header ffmpeg writes in bitexact mode. */
const WAV_BYTES_PER_SECOND = 32_000;
const WAV_HEADER_BYTES = 44;

export interface WhisperCue {
  start_s: number;
  end_s: number;
  text: string;
}

export type WhisperTask = 'transcribe' | 'translate';

export interface WhisperRequest {
  /** A 16 kHz mono 16-bit PCM WAV. */
  wav: string;
  task: WhisperTask;
  /** The spoken language as a 2-letter code, or null to let Whisper detect it. */
  language: string | null;
}

/** The seam to the model. Production: WorkerTranscriber. Tests: a plain object. */
export interface Transcriber {
  /** The cues of one stretch, in seconds into the stretch. Rejects when the worker fails or `signal` aborts. */
  transcribe(request: WhisperRequest, signal: AbortSignal): Promise<WhisperCue[]>;
  /** Ends the worker if one runs; the next transcribe starts a new one. */
  stop(): Promise<void>;
}

export interface StretchRequest {
  /** The file route, absolute (ffmpeg reads it with Range requests). */
  url: string;
  startS: number;
  lengthS: number;
  /** The WAV to write. */
  out: string;
}

/** `lengthS`: the seconds of audio written; under the asked length at the end of the film, 0 past it. */
export type StretchCut = { ok: true; lengthS: number } | { ok: false; reason: string };

/** The seam to ffmpeg. Production: ffmpegCutter. Tests: a plain function. */
export type AudioCutter = (request: StretchRequest, signal: AbortSignal) => Promise<StretchCut>;

/** The part of phase 7's growing cue feed (subtitles/feed.ts) this tier writes. */
export interface WhisperFeed {
  /** Relative to the daemon's origin: what the session's subtitle points at. */
  readonly url: string;
  /** Cues in film time. Whisper appends the stretch on screen first and earlier ones later. */
  append(cues: readonly WhisperCue[]): Promise<void>;
  complete(): Promise<void>;
}

export type OpenWhisperFeed = (infoHash: string, fileIndex: number) => Promise<WhisperFeed>;

/** What this tier reads of the subtitle chain's context (phase 3's SubtitleTier ctx). */
export interface WhisperContext {
  infoHash: string;
  fileIndex: number;
  /** The title's original language, as the session has it ("en", "ko"); null when not known. */
  audioLang: string | null;
  /** Where the play starts, in seconds; null from the start. */
  resumeS: number | null;
  probe: { durationS: number | null };
  /** Aborts when the session releases the torrent. */
  signal: AbortSignal;
}

/**
 * One session subtitle. Always a cue feed, so always `growing: true` (phase 7's mark: `url` answers JSON cues and the
 * page reads it from where it stopped until the feed says it is complete; a finished feed is read once).
 */
export interface WhisperTrack {
  url: string;
  lang: string;
  label: string;
  growing: true;
}

/** English is transcribed; anything else, or a language not known, is translated into English. */
export function whisperTask(audioLang: string | null): Pick<WhisperRequest, 'task' | 'language'> {
  const lang = audioLang?.trim().toLowerCase() ?? '';
  if (lang === 'en' || lang === 'eng') return { task: 'transcribe', language: 'en' };
  return { task: 'translate', language: /^[a-z]{2}$/.test(lang) ? lang : null };
}

/** The start of the stretch that holds `fromS` (the last stretch for a position past the end). */
export function firstStretch(fromS: number | null, stretchS: number, durationS: number | null): number {
  const at = Math.max(0, fromS ?? 0);
  const inside = durationS !== null && at >= durationS ? Math.max(0, durationS - 1) : at;
  return Math.floor(inside / stretchS) * stretchS;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Cues of a stretch moved to film time, each at most WHISPER_MAX_CUE_S long. */
export function placeCues(cues: readonly WhisperCue[], startS: number): WhisperCue[] {
  return cues.map((cue) => ({
    start_s: round3(startS + cue.start_s),
    end_s: round3(startS + Math.min(cue.end_s, cue.start_s + WHISPER_MAX_CUE_S)),
    text: cue.text,
  }));
}

/** The worker's cues, kept only when well formed: it is another program's output. */
export function parseCues(raw: unknown): WhisperCue[] {
  if (!Array.isArray(raw)) return [];
  const cues: WhisperCue[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const { start_s: start, end_s: end, text } = item as Record<string, unknown>;
    if (typeof start !== 'number' || typeof end !== 'number' || typeof text !== 'string') continue;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || text.trim() === '') continue;
    cues.push({ start_s: start, end_s: end, text: text.trim() });
  }
  return cues;
}

/**
 * ffmpeg's arguments for one stretch: seek in the input (a ranged read of the file route), the first
 * audio stream only, 16 kHz mono 16-bit PCM, no metadata, so the header is exactly 44 bytes.
 * The first audio stream: the finder leaves dual-audio releases out, so it is the original.
 */
export function cutArgs(request: StretchRequest): string[] {
  return [
    '-v', 'error', '-nostdin', '-y',
    '-ss', String(request.startS), '-t', String(request.lengthS),
    '-i', request.url,
    '-map', '0:a:0', '-vn', '-sn', '-dn',
    '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
    '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact',
    request.out,
  ];
}

export function ffmpegCutter(options: { ffmpegBin: string; timeoutMs?: number }): AudioCutter {
  return async (request, signal) => {
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(options.ffmpegBin, cutArgs(request), { timeout: options.timeoutMs ?? WHISPER_CUT_TIMEOUT_MS, killSignal: 'SIGKILL', signal }, (err) =>
          err ? reject(err) : resolve(),
        );
      });
      const size = (await stat(request.out)).size;
      return { ok: true, lengthS: Math.max(0, size - WAV_HEADER_BYTES) / WAV_BYTES_PER_SECOND };
    } catch (err) {
      return { ok: false, reason: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
    }
  };
}

export interface WorkerTranscriberOptions {
  python: string;
  script: string;
  model: string;
  threads: number;
  /** Where the model is downloaded to and loaded from. */
  modelsDir: string;
  /** Hugging Face's own cache and settings, kept beside the models instead of in ~/.cache. */
  hfHome: string;
  /** The worker's base environment; default process.env. */
  env?: NodeJS.ProcessEnv;
  readyTimeoutMs?: number;
  stretchTimeoutMs?: number;
  log?: (line: string) => void;
}

interface WorkerLine {
  ready?: boolean;
  model?: string;
  load_s?: number;
  id?: string | number | null;
  cues?: unknown;
  error?: string;
}

interface Waiting {
  resolve: (cues: WhisperCue[]) => void;
  reject: (err: Error) => void;
}

/**
 * The client of one long-lived worker: started on the first stretch, asked one stretch at a time,
 * stopped when nothing needs it. A worker that dies is started again on the next stretch.
 */
export class WorkerTranscriber implements Transcriber {
  private child: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private readonly waiting = new Map<string, Waiting>();
  private nextId = 1;
  private turn: Promise<unknown> = Promise.resolve();
  private stderrTail = '';
  private readonly log: (line: string) => void;

  constructor(private readonly opts: WorkerTranscriberOptions) {
    this.log = opts.log ?? ((line: string) => console.log(line));
  }

  transcribe(request: WhisperRequest, signal: AbortSignal): Promise<WhisperCue[]> {
    // One stretch at a time, so each one's timeout counts only its own run.
    const run = this.turn.then(() => this.ask(request, signal));
    this.turn = run.catch(() => undefined);
    return run;
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.ready = null;
    if (child === null || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill('SIGKILL');
    });
  }

  private async ask(request: WhisperRequest, signal: AbortSignal): Promise<WhisperCue[]> {
    signal.throwIfAborted();
    await this.start();
    signal.throwIfAborted();
    const child = this.child;
    if (child === null || child.stdin === null) throw new Error('the Whisper worker is not running');
    const id = String(this.nextId++);
    const timeoutMs = this.opts.stretchTimeoutMs ?? WHISPER_STRETCH_TIMEOUT_MS;
    return await new Promise<WhisperCue[]>((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.waiting.delete(id);
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`the Whisper worker gave no answer in ${Math.round(timeoutMs / 1000)} s`));
        void this.stop();
      }, timeoutMs);
      timer.unref();
      // The worker finishes the stretch anyway; its answer then finds no one waiting and is dropped.
      const onAbort = (): void => {
        done();
        reject(signal.reason instanceof Error ? signal.reason : new Error('the stretch was dropped'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiting.set(id, {
        resolve: (cues) => {
          done();
          resolve(cues);
        },
        reject: (err) => {
          done();
          reject(err);
        },
      });
      child.stdin?.write(`${JSON.stringify({ id, wav: request.wav, task: request.task, language: request.language })}\n`);
    });
  }

  private start(): Promise<void> {
    if (this.ready !== null) return this.ready;
    const { python, script, model, threads, modelsDir, hfHome } = this.opts;
    const child = spawn(python, ['-I', script, '--model', model, '--threads', String(threads), '--models-dir', modelsDir], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...(this.opts.env ?? process.env), HF_HOME: hfHome, HF_HUB_DISABLE_TELEMETRY: '1' },
    });
    this.child = child;
    try {
      if (child.pid !== undefined) setPriority(child.pid, WORKER_NICENESS);
    } catch {
      // Not allowed here: it runs at the daemon's priority.
    }
    this.stderrTail = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    child.stdin?.on('error', () => undefined);
    const readyTimeoutMs = this.opts.readyTimeoutMs ?? WHISPER_READY_TIMEOUT_MS;
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the Whisper worker did not load model ${model} in ${Math.round(readyTimeoutMs / 1000)} s`)), readyTimeoutMs);
      timer.unref();
      const lines = createInterface({ input: child.stdout! });
      lines.on('line', (line) => {
        let message: WorkerLine;
        try {
          message = JSON.parse(line) as WorkerLine;
        } catch {
          return;
        }
        if (message.ready !== undefined) {
          clearTimeout(timer);
          if (message.ready === true) {
            this.log(`[notesd] torrent whisper: worker ready (model ${message.model ?? model}, loaded in ${message.load_s ?? '?'} s)`);
            resolve();
          } else {
            reject(new Error(message.error ?? 'the Whisper worker did not start'));
          }
          return;
        }
        const key = message.id === undefined || message.id === null ? null : String(message.id);
        const waiting = key === null ? undefined : this.waiting.get(key);
        if (waiting === undefined) return;
        if (Array.isArray(message.cues)) waiting.resolve(parseCues(message.cues));
        else waiting.reject(new Error(message.error ?? 'the Whisper worker answered nothing'));
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      // `close`, not `exit`: it comes after stdout is drained, so a `{"ready": false, "error"}` line
      // written just before the worker exits is read first and its reason wins.
      child.on('close', (code, sig) => {
        clearTimeout(timer);
        const why = `the Whisper worker stopped (${sig ?? `exit ${code}`})${this.stderrTail.trim() === '' ? '' : `: ${this.stderrTail.trim().slice(-300)}`}`;
        reject(new Error(why));
        if (this.child === child) {
          this.child = null;
          this.ready = null;
        }
        for (const waiting of [...this.waiting.values()]) waiting.reject(new Error(why));
      });
    });
    this.ready = ready;
    ready.catch(() => {
      if (this.child === child) {
        this.child = null;
        this.ready = null;
        child.kill('SIGKILL');
      }
    });
    return ready;
  }
}

/** The finished stretches of one file, kept beside the torrent. */
interface WhisperProgress {
  stretchS: number;
  done: number[];
  /** Where the audio ends, once known (the probe's duration, or found by a short last stretch). */
  endS: number | null;
  complete: boolean;
}

function parseProgress(raw: unknown): WhisperProgress | null {
  if (raw === null || typeof raw !== 'object') return null;
  const { stretchS, done, endS, complete } = raw as Record<string, unknown>;
  if (typeof stretchS !== 'number' || !(stretchS > 0) || !Array.isArray(done) || typeof complete !== 'boolean') return null;
  if (endS !== null && typeof endS !== 'number') return null;
  return { stretchS, done: done.filter((d): d is number => typeof d === 'number' && d >= 0), endS, complete };
}

/** One file being transcribed, shared by every session that plays it. */
class WhisperJob {
  readonly controller = new AbortController();
  private users = 0;

  /** The job goes on while at least one session's signal has not aborted. */
  join(signal: AbortSignal): void {
    this.users += 1;
    signal.addEventListener(
      'abort',
      () => {
        this.users -= 1;
        if (this.users === 0) this.controller.abort(new Error('the torrent was released'));
      },
      { once: true },
    );
  }
}

export interface WhisperTierOptions {
  /** Seconds per stretch for a file not started yet (a file started before keeps its own). */
  stretchS: number;
  /** A torrent's `notesd-whisper` folder (`<torrent dir>/<info hash>/notesd-whisper`): progress files and the WAV of the stretch in progress. */
  workDirOf: (infoHash: string) => string;
  /** The file route of a torrent's file, absolute (`http://127.0.0.1:<port>/api/stream/torrent/<hash>/f/<index>`). */
  fileUrl: (infoHash: string, fileIndex: number) => string;
  openFeed: OpenWhisperFeed;
  cutter: AudioCutter;
  transcriber: Transcriber;
  log?: (line: string) => void;
}

export class WhisperTier {
  readonly name = WHISPER_TIER_NAME;
  /** A growing tier (phase 3's SubtitleTier): it answers at once and is not counted in the chain's 40 s budget. */
  readonly blocks = false;
  private readonly jobs = new Map<string, WhisperJob>();
  private readonly log: (line: string) => void;

  constructor(private readonly opts: WhisperTierOptions) {
    this.log = opts.log ?? ((line: string) => console.log(line));
  }

  /** A growing English track at once (a finished one when the file is done); nothing when no feed can be opened. Never throws. */
  async find(ctx: WhisperContext): Promise<WhisperTrack[]> {
    const key = `${ctx.infoHash.toLowerCase()}-${ctx.fileIndex}`;
    let feed: WhisperFeed;
    try {
      feed = await this.opts.openFeed(ctx.infoHash, ctx.fileIndex);
    } catch (err) {
      this.log(`[notesd] torrent whisper: no cue feed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
    const progress = await this.readProgress(key);
    if (progress?.complete === true) return [this.track(feed)];
    if (!ctx.signal.aborted) this.jobFor(key, ctx, feed, progress).join(ctx.signal);
    return [this.track(feed)];
  }

  /** Stops every file and the worker: notesd is stopping. */
  async close(): Promise<void> {
    for (const job of this.jobs.values()) job.controller.abort(new Error('notesd is stopping'));
    this.jobs.clear();
    await this.opts.transcriber.stop();
  }

  private track(feed: WhisperFeed): WhisperTrack {
    return { url: feed.url, lang: 'en', label: WHISPER_LABEL, growing: true };
  }

  private jobFor(key: string, ctx: WhisperContext, feed: WhisperFeed, progress: WhisperProgress | null): WhisperJob {
    const running = this.jobs.get(key);
    if (running !== undefined && !running.controller.signal.aborted) return running;
    const job = new WhisperJob();
    this.jobs.set(key, job);
    void this.transcribeFile(key, ctx, feed, progress, job.controller.signal)
      .catch((err: unknown) => {
        const why = err instanceof Error ? err.message : String(err);
        this.log(`[notesd] torrent whisper: ${key} stopped: ${job.controller.signal.aborted ? 'the torrent was released' : why}`);
      })
      .finally(() => {
        if (this.jobs.get(key) === job) this.jobs.delete(key);
        // Nothing left to transcribe: the worker's memory (about 850 MB with `small`) goes back.
        if (this.jobs.size === 0) void this.opts.transcriber.stop();
      });
    return job;
  }

  private async transcribeFile(key: string, ctx: WhisperContext, feed: WhisperFeed, stored: WhisperProgress | null, signal: AbortSignal): Promise<void> {
    const { task, language } = whisperTask(ctx.audioLang);
    const stretchS = stored?.stretchS ?? this.opts.stretchS;
    const done = new Set(stored?.done ?? []);
    let endS = stored?.endS ?? ctx.probe.durationS;
    const url = this.opts.fileUrl(ctx.infoHash, ctx.fileIndex);
    const first = firstStretch(ctx.resumeS, stretchS, endS);
    let failures = 0;
    await mkdir(this.opts.workDirOf(ctx.infoHash.toLowerCase()), { recursive: true });
    const save = (complete: boolean): Promise<void> => this.saveProgress(key, { stretchS, done: [...done].sort((a, b) => a - b), endS, complete });

    /** One stretch: `end` once the audio is over. Throws when released or after too many failures. */
    const one = async (startS: number): Promise<'next' | 'end'> => {
      const wav = path.join(this.opts.workDirOf(ctx.infoHash.toLowerCase()), `${key}-${startS}.wav`);
      try {
        const cut = await this.opts.cutter({ url, startS, lengthS: stretchS, out: wav }, signal);
        signal.throwIfAborted();
        if (!cut.ok) throw new Error(`the audio at ${startS} s could not be cut: ${cut.reason}`);
        if (cut.lengthS < 0.5) {
          endS = startS;
          await save(false);
          return 'end';
        }
        const cues = await this.opts.transcriber.transcribe({ wav, task, language }, signal);
        signal.throwIfAborted();
        await feed.append(placeCues(cues, startS));
        done.add(startS);
        const last = cut.lengthS < stretchS - 1;
        if (last) endS = startS + cut.lengthS;
        await save(false);
        failures = 0;
        this.log(`[notesd] torrent whisper: ${key} ${startS}-${round3(startS + cut.lengthS)} s: ${cues.length} cue(s) (${task})`);
        return last ? 'end' : 'next';
      } catch (err) {
        if (signal.aborted) throw err;
        failures += 1;
        this.log(`[notesd] torrent whisper: ${key} stretch at ${startS} s failed: ${err instanceof Error ? err.message : String(err)}`);
        if (failures >= WHISPER_MAX_FAILURES) throw new Error(`gave up after ${failures} failed stretches in a row; a replay tries again`);
        return 'next';
      } finally {
        await rm(wav, { force: true });
      }
    };

    for (let startS = first; endS === null || startS < endS; startS += stretchS) {
      if (done.has(startS)) continue;
      if ((await one(startS)) === 'end') break;
    }
    for (let startS = first - stretchS; startS >= 0; startS -= stretchS) {
      if (done.has(startS)) continue;
      await one(startS);
    }
    const finalEnd = endS;
    if (finalEnd === null) return;
    for (let startS = 0; startS < finalEnd; startS += stretchS) {
      if (!done.has(startS)) {
        this.log(`[notesd] torrent whisper: ${key} has stretches left over; a replay tries them again`);
        return;
      }
    }
    await save(true);
    await feed.complete();
    this.log(`[notesd] torrent whisper: ${key} transcribed to the end`);
  }

  /** `key` is `<info hash>-<file index>`, the hash 40 lower-case hex characters. */
  private progressFile(key: string): string {
    return path.join(this.opts.workDirOf(key.slice(0, 40)), `${key}.json`);
  }

  private async readProgress(key: string): Promise<WhisperProgress | null> {
    try {
      return parseProgress(JSON.parse(await readFile(this.progressFile(key), 'utf8')));
    } catch {
      return null;
    }
  }

  private async saveProgress(key: string, progress: WhisperProgress): Promise<void> {
    const file = this.progressFile(key);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(progress));
    await rename(tmp, file);
  }
}

export interface BuildWhisperTierOptions {
  whisper: TorrentWhisperConfig;
  /** `config.torrent.dir`: the tier keeps its files under `<dir>/<info hash>/notesd-whisper`. */
  torrentDir: string;
  ffmpegBin: string;
  fileUrl: (infoHash: string, fileIndex: number) => string;
  openFeed: OpenWhisperFeed;
  /** Default: claude/streaming/torrent/whisper.py in this checkout. */
  script?: string;
  log?: (line: string) => void;
}

/** The tier, or null: Whisper is off, or install.sh has not made its Python (the log says which). */
export async function buildWhisperTier(options: BuildWhisperTierOptions): Promise<WhisperTier | null> {
  const log = options.log ?? ((line: string) => console.log(line));
  const whisper = options.whisper;
  if (!whisper.enabled) {
    log('[notesd] torrent whisper: off (NOTESD_TORRENT_WHISPER=off)');
    return null;
  }
  try {
    await access(whisper.python, constants.X_OK);
  } catch {
    log(`[notesd] torrent whisper: no Python at ${whisper.python}; scripts/install.sh installs it. No Whisper subtitles until then.`);
    return null;
  }
  log(`[notesd] torrent whisper: on (model ${whisper.model}, ${whisper.threads} threads, ${whisper.stretchS} s stretches)`);
  return new WhisperTier({
    stretchS: whisper.stretchS,
    workDirOf: (infoHash) => path.join(options.torrentDir, infoHash, WHISPER_DIR),
    fileUrl: options.fileUrl,
    openFeed: options.openFeed,
    cutter: ffmpegCutter({ ffmpegBin: options.ffmpegBin }),
    transcriber: new WorkerTranscriber({
      python: whisper.python,
      script: options.script ?? DEFAULT_TORRENT_WHISPER_SCRIPT,
      model: whisper.model,
      threads: whisper.threads,
      modelsDir: path.join(whisper.dir, 'models'),
      hfHome: path.join(whisper.dir, 'hf'),
      log,
    }),
    log,
  });
}
```
**Impact:** new module, nothing calls it until Step 4. Note for the docs scanner: the worker's
environment is an object literal (`HF_HOME: hfHome`), which `scripts/docs/reference.ts` does not
read as a setting; keep it that way (no `env.HF_HOME`, no quoted name bound to an `...Env` identifier).

### Step 4: Wiring
**File:** `src/directStream/torrent/subtitles/chain.ts` (phase 3's, with phases 6 and 7 in it); `src/daemon.ts` right
after phase 7's `torrentCues` / `embeddedSubtitles` block, phase 3's `buildSubtitleTiers({...})` object, after the
`deps.streamProber = ...` line (233 today); `src/deps.ts:94`; `src/background.ts:221`.
**Change:** the tier at phase 3's `// Phase 8: whisper.` comment (last), the borrow skipped for an English original
while Whisper is on (decided at reconciliation: Whisper measured 5 minutes of audio in 2.5 s, and a borrowed file may
be out of step), the feed opened through phase 7's real API, and the tier kept on `deps` so stop closes it.
**Code:**
`chain.ts`:
```ts
import type { WhisperTier } from './whisper.js';
```
```ts
  /** Whisper, the last tier (phase 8); null when off or not installed. */
  whisper?: WhisperTier | null;
```
In `buildSubtitleTiers`, phase 6's borrow line gains the flag, and the tier goes last:
```ts
    borrowTier({ lend: deps.lend, shelf, whisperCovers: deps.whisper != null }),
    // Phase 8: whisper.
    ...(deps.whisper == null ? [] : [deps.whisper]),
```
`src/daemon.ts`, imports beside the other `./directStream/...` imports:
```ts
import { cueFeedUrl, whisperTrackId } from './directStream/torrent/subtitles/feed.js';
import { buildWhisperTier } from './directStream/torrent/subtitles/whisper.js';
```
(`CueFeeds` is already imported by phase 7; merge the two `feed.js` imports into one.) Right after phase 7's
`embeddedSubtitles` block (phase 1's `torrents` and phase 7's `torrentCues` exist there):
```ts
  // Torrent phase 8: Whisper, the last subtitle tier. Null with NOTESD_TORRENT_WHISPER=off or before
  // install.sh has made its Python; the chain then ends at phase 6's borrow. The worker starts on the
  // first stretch, never at boot. Its cues go into phase 7's feed `whisper-<file index>` of the torrent.
  const whisperTier =
    torrents === null || torrentCues === null || config.torrent === undefined
      ? null
      : await buildWhisperTier({
          whisper: config.torrent.whisper,
          torrentDir: config.torrent.dir,
          ffmpegBin: config.torrent.ffmpegBin,
          fileUrl: (infoHash, fileIndex) => `http://127.0.0.1:${boundPort ?? config.port}${torrents.localUrl(infoHash, fileIndex)}`,
          openFeed: async (infoHash, fileIndex) => {
            const track = whisperTrackId(fileIndex);
            // A feed a stopped run left carries on (the progress file says which stretches are in it); else a new one.
            const feed = (await torrentCues.get(infoHash, track)) ?? (await torrentCues.start(infoHash, track));
            return { url: cueFeedUrl(infoHash, track), append: (cues) => feed.append(cues), complete: () => feed.complete() };
          },
        });
```
In phase 3's `buildSubtitleTiers({ ... })` object, at its comment:
```ts
          whisper: whisperTier,
```
After `deps.streamProber = await buildStreamProber(...)`:
```ts
  // Torrent phase 8: closed by startBackground's stop, which ends a running Whisper worker.
  deps.torrentWhisper = whisperTier;
```
`src/deps.ts`, import beside the other type imports and the field before `sessionEvents`:
```ts
import type { WhisperTier } from './directStream/torrent/subtitles/whisper.js';
```
```ts
  /**
   * Whisper, the last subtitle tier of a torrent session (torrent phase 8). Null or absent with
   * Whisper off or not installed; startBackground's stop closes it, which ends its worker.
   */
  torrentWhisper?: WhisperTier | null;
```
`src/background.ts`, in the stop's `Promise.all` list after `streamCache?.close(),`:
```ts
      deps.torrentWhisper?.close(),
```
**Impact:** with torrents off (`DEFAULT_TORRENT_CONFIG`, every test) nothing is built. With Whisper
on but not installed the daemon logs one line and the chain is phases 6 and 7's as before. The cutter reads the
file route; once the session lets go the job's signal aborts, and a stretch that still reads after the torrent left
the swarm gets 409 `not_in_swarm` and fails like any cut (the job is stopped by then).

### Step 5: The fake worker
**File:** `tests/fixtures/torrent/fake-whisper.mjs` (new, mode 755: `chmod +x` and
`git update-index --chmod=+x`)
**Change:** the worker's protocol without a model. It reads the WAV header, so a cue says how much
audio ffmpeg really cut. Used by the unit tests and, as `NOTESD_TORRENT_WHISPER_PYTHON`, by the
throwaway daemon in the Proof. It ignores its arguments (`-I <script> --model ...`).
**Code:**
```js
#!/usr/bin/env node
// A stand-in for claude/streaming/torrent/whisper.py: same JSON lines, no model. Point
// NOTESD_TORRENT_WHISPER_PYTHON (or WorkerTranscriber's `python`) at this file; its arguments are
// ignored. Each request answers one cue, "Whisper line <n> (<task>, <seconds> s of audio)", at
// 0.5-2.5 s of the stretch, read from the WAV header, so a cue proves ffmpeg cut real audio.
//   FAKE_WHISPER_MODE      ok (default) | not_ready (fails to load) | error (every request fails)
//   FAKE_WHISPER_DELAY_MS  wait this long before each answer (default 0)
//   FAKE_WHISPER_LOG       append each request, as JSON with its time, to this file
import { appendFileSync, closeSync, openSync, readSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.env.FAKE_WHISPER_MODE ?? 'ok';
const delayMs = Number(process.env.FAKE_WHISPER_DELAY_MS ?? '0');
const logFile = process.env.FAKE_WHISPER_LOG ?? '';

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
```
**Impact:** none on the tree; `tests/` is not scanned for settings.

### Step 6: Tests
**File:** `tests/unit/directStream/torrent/whisper.test.ts` (new)
**Change:** behaviour through the tier's `find` and the feed it writes (what the session and the page
see), the worker client against the fake worker, and the pure helpers.
**Code:**
```ts
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cutArgs,
  firstStretch,
  parseCues,
  placeCues,
  whisperTask,
  WhisperTier,
  WorkerTranscriber,
  WHISPER_LABEL,
  type AudioCutter,
  type OpenWhisperFeed,
  type Transcriber,
  type WhisperContext,
  type WhisperCue,
  type WhisperFeed,
  type WhisperRequest,
} from '../../../../src/directStream/torrent/subtitles/whisper.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const FAKE_WORKER = path.join(REPO, 'tests', 'fixtures', 'torrent', 'fake-whisper.mjs');
const HASH = 'ab'.repeat(20);

let workDir: string;
beforeEach(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), 'notesd-whisper-'));
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class FakeFeed implements WhisperFeed {
  readonly url = `/api/stream/torrent/${HASH}/feed/0/whisper`;
  readonly cues: WhisperCue[] = [];
  completed = 0;
  async append(cues: readonly WhisperCue[]): Promise<void> {
    this.cues.push(...cues);
  }
  async complete(): Promise<void> {
    this.completed += 1;
  }
}

class FakeTranscriber implements Transcriber {
  readonly requests: WhisperRequest[] = [];
  stops = 0;
  /** Called with the request's number (from 1) before it answers. */
  onRequest: (n: number) => void = () => undefined;
  /** When set, each request waits for it (or for its signal). */
  gate: Promise<void> | null = null;
  async transcribe(request: WhisperRequest, signal: AbortSignal): Promise<WhisperCue[]> {
    this.requests.push(request);
    this.onRequest(this.requests.length);
    if (this.gate !== null) {
      await Promise.race([
        this.gate,
        new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
      ]);
    }
    if (signal.aborted) throw new Error('aborted');
    return [{ start_s: 1, end_s: 3, text: `line ${this.requests.length}` }];
  }
  async stop(): Promise<void> {
    this.stops += 1;
  }
}

/** Audio up to `endS`; the starts it was asked for land in `cuts`; starts in `fail` fail. */
function fakeCutter(endS: number, cuts: number[], fail: ReadonlySet<number> = new Set()): AudioCutter {
  return async ({ startS, lengthS }) => {
    cuts.push(startS);
    if (fail.has(startS)) return { ok: false, reason: 'the route closed' };
    return { ok: true, lengthS: Math.max(0, Math.min(lengthS, endS - startS)) };
  };
}

function ctx(over: Partial<WhisperContext> = {}): WhisperContext {
  return { infoHash: HASH, fileIndex: 0, audioLang: 'en', resumeS: null, probe: { durationS: 1000 }, signal: new AbortController().signal, ...over };
}

function tier(parts: { cutter: AudioCutter; transcriber: Transcriber; feed?: FakeFeed; openFeed?: OpenWhisperFeed; stretchS?: number }): WhisperTier {
  const feed = parts.feed ?? new FakeFeed();
  return new WhisperTier({
    stretchS: parts.stretchS ?? 300,
    workDirOf: () => workDir,
    fileUrl: (infoHash, fileIndex) => `http://127.0.0.1:1/api/stream/torrent/${infoHash}/f/${fileIndex}`,
    openFeed: parts.openFeed ?? (async () => feed),
    cutter: parts.cutter,
    transcriber: parts.transcriber,
    log: () => undefined,
  });
}

describe('WhisperTier', () => {
  it('answers a growing English (Whisper) track at once and fills it stretch by stretch from where the play starts', async () => {
    const cuts: number[] = [];
    const feed = new FakeFeed();
    const transcriber = new FakeTranscriber();
    const tracks = await tier({ cutter: fakeCutter(1000, cuts), transcriber, feed }).find(ctx({ resumeS: 650 }));
    expect(tracks).toEqual([{ url: feed.url, lang: 'en', label: WHISPER_LABEL, growing: true }]);
    await until(() => feed.completed === 1);
    expect(cuts).toEqual([600, 900, 300, 0]);
    expect(feed.cues.map((cue) => cue.start_s)).toEqual([601, 901, 301, 1]);
    expect(transcriber.stops).toBe(1);
  });

  it('answers before any stretch is transcribed', async () => {
    const controller = new AbortController();
    const transcriber = new FakeTranscriber();
    transcriber.gate = new Promise<void>(() => undefined);
    const feed = new FakeFeed();
    const tracks = await tier({ cutter: fakeCutter(1000, []), transcriber, feed }).find(ctx({ signal: controller.signal }));
    expect(tracks[0]?.growing).toBe(true);
    expect(feed.cues).toEqual([]);
    controller.abort();
    await until(() => transcriber.stops === 1);
  });

  it('transcribes an English title and translates any other into English', async () => {
    const english = new FakeTranscriber();
    await tier({ cutter: fakeCutter(300, []), transcriber: english }).find(ctx({ audioLang: 'en' }));
    await until(() => english.stops === 1);
    expect(english.requests.map((r) => [r.task, r.language])).toEqual([['transcribe', 'en']]);

    await rm(workDir, { recursive: true, force: true });
    const korean = new FakeTranscriber();
    await tier({ cutter: fakeCutter(300, []), transcriber: korean }).find(ctx({ audioLang: 'ko' }));
    await until(() => korean.stops === 1);
    expect(korean.requests.map((r) => [r.task, r.language])).toEqual([['translate', 'ko']]);
  });

  it('stops when the session releases the torrent, keeps what it made, and a later play carries on', async () => {
    const controller = new AbortController();
    const cuts: number[] = [];
    const feed = new FakeFeed();
    const transcriber = new FakeTranscriber();
    transcriber.onRequest = (n) => {
      if (n === 2) controller.abort();
    };
    await tier({ cutter: fakeCutter(1000, cuts), transcriber, feed }).find(ctx({ signal: controller.signal }));
    await until(() => transcriber.stops === 1);
    expect(cuts).toEqual([0, 300]);
    expect(feed.cues.map((cue) => cue.start_s)).toEqual([1]);
    expect(feed.completed).toBe(0);

    // notesd restarted: a new tier over the same folder, the same feed on disk.
    const cutsAgain: number[] = [];
    const again = new FakeTranscriber();
    await tier({ cutter: fakeCutter(1000, cutsAgain), transcriber: again, feed }).find(ctx());
    await until(() => feed.completed === 1);
    expect(cutsAgain).toEqual([300, 600, 900]);
    expect(feed.cues.map((cue) => cue.start_s)).toEqual([1, 301, 601, 901]);

    // Done to the end: a finished track, and nothing is cut or transcribed.
    const cutsDone: number[] = [];
    const tracks = await tier({ cutter: fakeCutter(1000, cutsDone), transcriber: new FakeTranscriber(), feed }).find(ctx());
    // Still a cue feed (growing: true); the page reads a finished feed once.
    expect(tracks).toEqual([{ url: feed.url, lang: 'en', label: WHISPER_LABEL, growing: true }]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cutsDone).toEqual([]);
  });

  it('goes on while another session still plays the same file', async () => {
    const first = new AbortController();
    const second = new AbortController();
    const feed = new FakeFeed();
    const transcriber = new FakeTranscriber();
    transcriber.onRequest = (n) => {
      if (n === 1) first.abort();
    };
    const whisper = tier({ cutter: fakeCutter(900, []), transcriber, feed });
    await Promise.all([whisper.find(ctx({ signal: first.signal })), whisper.find(ctx({ signal: second.signal }))]);
    await until(() => feed.completed === 1);
    expect(feed.cues).toHaveLength(3);
  });

  it('finds the end of a film whose length the probe did not know', async () => {
    const cuts: number[] = [];
    const feed = new FakeFeed();
    await tier({ cutter: fakeCutter(700, cuts), transcriber: new FakeTranscriber(), feed }).find(ctx({ resumeS: 400, probe: { durationS: null } }));
    await until(() => feed.completed === 1);
    expect(cuts).toEqual([300, 600, 0]);
    expect(feed.cues.map((cue) => cue.start_s)).toEqual([301, 601, 1]);
  });

  it('gives up after three failed stretches in a row and leaves the track growing', async () => {
    const cuts: number[] = [];
    const feed = new FakeFeed();
    const transcriber = new FakeTranscriber();
    await tier({ cutter: fakeCutter(1000, cuts, new Set([0, 300, 600, 900])), transcriber, feed }).find(ctx());
    await until(() => transcriber.stops === 1);
    expect(cuts).toEqual([0, 300, 600]);
    expect(feed.completed).toBe(0);
    expect(transcriber.requests).toEqual([]);
  });

  it('answers nothing, and never throws, when no feed can be opened', async () => {
    const tracks = await tier({ cutter: fakeCutter(1000, []), transcriber: new FakeTranscriber(), openFeed: async () => Promise.reject(new Error('no feed route')) }).find(ctx());
    expect(tracks).toEqual([]);
  });
});

describe('helpers', () => {
  it('whisperTask: English is transcribed, the rest translated', () => {
    expect(whisperTask('en')).toEqual({ task: 'transcribe', language: 'en' });
    expect(whisperTask('ko')).toEqual({ task: 'translate', language: 'ko' });
    expect(whisperTask('jpn')).toEqual({ task: 'translate', language: null });
    expect(whisperTask(null)).toEqual({ task: 'translate', language: null });
  });

  it('firstStretch: the stretch that holds the start, the last one past the end', () => {
    expect(firstStretch(650, 300, 1000)).toBe(600);
    expect(firstStretch(null, 300, 1000)).toBe(0);
    expect(firstStretch(1200, 300, 1000)).toBe(900);
    expect(firstStretch(1200, 300, null)).toBe(1200);
  });

  it('placeCues: film time, a cue at most 7 s', () => {
    expect(placeCues([{ start_s: 0.5, end_s: 20.5, text: 'long' }, { start_s: 2, end_s: 3.25, text: 'short' }], 300)).toEqual([
      { start_s: 300.5, end_s: 307.5, text: 'long' },
      { start_s: 302, end_s: 303.25, text: 'short' },
    ]);
  });

  it('parseCues keeps only well-formed cues', () => {
    expect(parseCues([{ start_s: 1, end_s: 2, text: ' hi ' }, { start_s: 3, end_s: 2, text: 'back' }, { start_s: 'x', end_s: 2, text: 'y' }, null, { start_s: 4, end_s: 5, text: ' ' }])).toEqual([
      { start_s: 1, end_s: 2, text: 'hi' },
    ]);
    expect(parseCues('nope')).toEqual([]);
  });

  it('cutArgs: a ranged read of the route, the first audio stream, 16 kHz mono PCM', () => {
    const args = cutArgs({ url: 'http://127.0.0.1:7317/api/stream/torrent/x/f/0', startS: 300, lengthS: 300, out: '/tmp/s.wav' });
    expect(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 6)).toEqual(['-ss', '300', '-t', '300', '-i', 'http://127.0.0.1:7317/api/stream/torrent/x/f/0']);
    expect(args).toEqual(expect.arrayContaining(['-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le']));
    expect(args.at(-1)).toBe('/tmp/s.wav');
  });
});

describe('WorkerTranscriber (against the fake worker)', () => {
  async function wav(seconds: number): Promise<string> {
    const data = Buffer.alloc(Math.round(seconds * 32000));
    const head = Buffer.alloc(44);
    head.write('RIFF', 0, 'ascii');
    head.writeUInt32LE(36 + data.length, 4);
    head.write('WAVE', 8, 'ascii');
    head.write('fmt ', 12, 'ascii');
    head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20);
    head.writeUInt16LE(1, 22);
    head.writeUInt32LE(16000, 24);
    head.writeUInt32LE(32000, 28);
    head.writeUInt16LE(2, 32);
    head.writeUInt16LE(16, 34);
    head.write('data', 36, 'ascii');
    head.writeUInt32LE(data.length, 40);
    const file = path.join(workDir, `s-${seconds}.wav`);
    await writeFile(file, Buffer.concat([head, data]));
    return file;
  }

  function worker(env: Record<string, string> = {}): WorkerTranscriber {
    return new WorkerTranscriber({
      python: FAKE_WORKER,
      script: '/not/read/whisper.py',
      model: 'small',
      threads: 2,
      modelsDir: workDir,
      hfHome: workDir,
      env: { ...process.env, ...env },
      log: () => undefined,
    });
  }

  it('the fake worker is executable', async () => {
    expect((await stat(FAKE_WORKER)).mode & 0o111).not.toBe(0);
  });

  it('loads once and answers each stretch', async () => {
    const transcriber = worker();
    try {
      const signal = new AbortController().signal;
      const one = await transcriber.transcribe({ wav: await wav(5), task: 'transcribe', language: 'en' }, signal);
      const two = await transcriber.transcribe({ wav: await wav(3), task: 'translate', language: 'ko' }, signal);
      expect(one).toEqual([{ start_s: 0.5, end_s: 2.5, text: 'Whisper line 1 (transcribe, 5.0 s of audio)' }]);
      expect(two).toEqual([{ start_s: 0.5, end_s: 2.5, text: 'Whisper line 2 (translate, 3.0 s of audio)' }]);
    } finally {
      await transcriber.stop();
    }
  });

  it('a stretch the worker cannot do rejects with its reason', async () => {
    const transcriber = worker({ FAKE_WHISPER_MODE: 'error' });
    try {
      await expect(transcriber.transcribe({ wav: await wav(2), task: 'transcribe', language: 'en' }, new AbortController().signal)).rejects.toThrow(/told to fail/);
    } finally {
      await transcriber.stop();
    }
  });

  it('a worker that cannot load rejects with why', async () => {
    const transcriber = worker({ FAKE_WHISPER_MODE: 'not_ready' });
    await expect(transcriber.transcribe({ wav: await wav(2), task: 'transcribe', language: 'en' }, new AbortController().signal)).rejects.toThrow(/cannot be imported/);
    await transcriber.stop();
  });

  it('a dropped stretch rejects at once, and stop rejects what still waits', async () => {
    const log = path.join(workDir, 'requests.jsonl');
    const transcriber = worker({ FAKE_WHISPER_DELAY_MS: '5000', FAKE_WHISPER_LOG: log });
    const controller = new AbortController();
    const dropped = transcriber.transcribe({ wav: await wav(2), task: 'transcribe', language: 'en' }, controller.signal);
    // Wait until the fake has the request, then drop it.
    await until(() => existsSync(log), 5000);
    controller.abort();
    await expect(dropped).rejects.toThrow();
    const waiting = transcriber.transcribe({ wav: await wav(2), task: 'transcribe', language: 'en' }, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await transcriber.stop();
    await expect(waiting).rejects.toThrow(/stopped/);
    expect((await readFile(log, 'utf8')).trim().split('\n').length).toBeGreaterThanOrEqual(1);
  });
});
```
**File:** `tests/unit/directStream/torrent/whisperConfig.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_TORRENT_WHISPER_CONFIG, parseTorrentWhisper } from '../../../../src/config.js';

const DATA = '/home/u/mcp-notes-data';

describe('parseTorrentWhisper', () => {
  it('is on with the data folder, small, 8 threads and 5-minute stretches by default', () => {
    expect(parseTorrentWhisper({}, DATA)).toEqual({
      enabled: true,
      dir: '/home/u/mcp-notes-data/whisper',
      python: '/home/u/mcp-notes-data/whisper/venv/bin/python',
      model: 'small',
      threads: 8,
      stretchS: 300,
    });
  });

  it('off carries nothing else', () => {
    expect(parseTorrentWhisper({ NOTESD_TORRENT_WHISPER: 'off', NOTESD_TORRENT_WHISPER_MODEL: 'bad model' }, DATA)).toEqual({ enabled: false });
    expect(DEFAULT_TORRENT_WHISPER_CONFIG).toEqual({ enabled: false });
  });

  it('takes every setting', () => {
    expect(
      parseTorrentWhisper(
        {
          NOTESD_TORRENT_WHISPER: 'on',
          NOTESD_TORRENT_WHISPER_DIR: '/opt/whisper',
          NOTESD_TORRENT_WHISPER_PYTHON: '/usr/local/bin/python3',
          NOTESD_TORRENT_WHISPER_MODEL: 'base.en',
          NOTESD_TORRENT_WHISPER_THREADS: '4',
          NOTESD_TORRENT_WHISPER_STRETCH_S: '60',
        },
        DATA,
      ),
    ).toEqual({ enabled: true, dir: '/opt/whisper', python: '/usr/local/bin/python3', model: 'base.en', threads: 4, stretchS: 60 });
    expect(parseTorrentWhisper({ NOTESD_TORRENT_WHISPER_DIR: '/opt/whisper' }, DATA)).toMatchObject({ python: '/opt/whisper/venv/bin/python' });
    expect(parseTorrentWhisper({ NOTESD_TORRENT_WHISPER_MODEL: 'Systran/faster-whisper-small' }, DATA)).toMatchObject({ model: 'Systran/faster-whisper-small' });
  });

  it('rejects what it cannot use', () => {
    expect(() => parseTorrentWhisper({ NOTESD_TORRENT_WHISPER: 'maybe' }, DATA)).toThrow(ConfigError);
    expect(() => parseTorrentWhisper({ NOTESD_TORRENT_WHISPER_MODEL: 'small; rm -rf /' }, DATA)).toThrow(ConfigError);
    expect(() => parseTorrentWhisper({ NOTESD_TORRENT_WHISPER_MODEL: '../../etc' }, DATA)).toThrow(ConfigError);
    expect(() => parseTorrentWhisper({ NOTESD_TORRENT_WHISPER_THREADS: '0' }, DATA)).toThrow(ConfigError);
    expect(() => parseTorrentWhisper({ NOTESD_TORRENT_WHISPER_STRETCH_S: '4' }, DATA)).toThrow(ConfigError);
    expect(() => parseTorrentWhisper({ NOTESD_TORRENT_WHISPER_DIR: 'whisper' }, DATA)).toThrow(ConfigError);
    expect(() => parseTorrentWhisper({ NOTESD_TORRENT_WHISPER_PYTHON: 'python3' }, DATA)).toThrow(ConfigError);
  });
});
```
**Impact:** none beyond the new files; `tests/unit/directStream/torrent/` may already exist from
phases 1–7.

### Step 7: The installer
**File:** `scripts/install.sh` — header comment after line 11; `ENV_LOCAL` and `WHISPER_*` after line
57; the helpers and `install_whisper` after `make_data_dir` (line 180); `main` (line 366); the help
range at line 69.
**Change:** an idempotent Whisper install that never stops the daemon install, and that the owner
never has to finish by hand: it finds a Python that can make a venv (miniconda's here; Ubuntu's own
lacks `ensurepip` until `python3-venv` is installed, which it tries with `sudo -n` the way
`enable_linger` does), installs a pinned faster-whisper, and loads the model once so it is on disk
before the first play. A second run only checks (about a second).
**Code:**
Header, after line 11 (`# the transcripts the session graph ingests are not deleted after 30 days.`):
```bash
# It also installs Whisper for the torrent source's last subtitle tier: a Python virtual
# environment in <data dir>/whisper/venv with faster-whisper, and the model .env.local names
# (NOTESD_TORRENT_WHISPER_MODEL, default small), unless .env.local turns torrents or Whisper off.
```
Line 69: `sed -n '2,29p'` becomes `sed -n '2,32p'` (three lines more of header).
After line 57 (`RETENTION_DAYS=...`):
```bash
ENV_LOCAL="$REPO_DIR/.env.local"
WHISPER_PACKAGE="faster-whisper==1.2.1"
WHISPER_SCRIPT="$REPO_DIR/claude/streaming/torrent/whisper.py"
```
After `make_data_dir` (line 180):
```bash
# The last value of NAME in .env.local (quotes stripped), or nothing. The daemon reads the same file.
env_local_value() {
  [[ -f "$ENV_LOCAL" ]] || return 0
  sed -n "s/^[[:space:]]*$1=//p" "$ENV_LOCAL" | tail -n 1 \
    | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

# True for the words the daemon reads as off.
is_off() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    off|0|false|no) return 0 ;;
    *) return 1 ;;
  esac
}

# A Python 3.9+ that can make a virtual environment. Ubuntu's own python3 has no ensurepip until
# python3-venv is installed; that is tried with sudo -n, never with a password prompt.
whisper_base_python() {
  local py
  for py in "$(command -v python3 || true)" "$HOME/miniconda3/bin/python3" /usr/bin/python3; do
    [[ -n "$py" && -x "$py" ]] || continue
    if "$py" -c 'import sys, ensurepip, venv; sys.exit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; then
      printf '%s\n' "$py"
      return 0
    fi
  done
  if [[ -x /usr/bin/python3 ]] && sudo -n apt-get install -y python3-venv >/dev/null 2>&1 \
     && /usr/bin/python3 -c 'import ensurepip, venv' >/dev/null 2>&1; then
    printf '%s\n' /usr/bin/python3
    return 0
  fi
  return 1
}

# Whisper for the torrent source's last subtitle tier (src/directStream/torrent/subtitles/whisper.ts).
# Idempotent: a venv that already has WHISPER_PACKAGE is kept, and the model is downloaded once.
# Any failure warns and returns: the daemon then starts without a Whisper tier and says so.
install_whisper() {
  if is_off "$(env_local_value NOTESD_TORRENT)" || is_off "$(env_local_value NOTESD_TORRENT_WHISPER)"; then
    log "Whisper: torrents or Whisper are off in $ENV_LOCAL, skipping"
    return 0
  fi
  local dir model venv py base ready
  dir="$(env_local_value NOTESD_TORRENT_WHISPER_DIR)"
  dir="${dir:-$DATA_DIR/whisper}"
  model="$(env_local_value NOTESD_TORRENT_WHISPER_MODEL)"
  model="${model:-small}"
  venv="$dir/venv"
  py="$venv/bin/python"
  mkdir -p "$dir/models" "$dir/hf"
  if [[ -x "$py" ]] && "$py" -I -c 'import importlib.metadata as m, sys; sys.exit(0 if m.version("faster-whisper") == sys.argv[1] else 1)' "${WHISPER_PACKAGE#*==}" >/dev/null 2>&1; then
    log "Whisper: $WHISPER_PACKAGE already in $venv"
  else
    if ! base="$(whisper_base_python)"; then
      warn "Whisper: no Python 3.9+ here can make a virtual environment (Ubuntu: python3-venv). Torrent sessions get no Whisper subtitles until one can."
      return 0
    fi
    log "Whisper: virtual environment $venv (from $base), pip install $WHISPER_PACKAGE"
    if ! "$base" -m venv --clear "$venv" >/dev/null 2>&1 \
       || ! "$py" -m pip install --quiet --disable-pip-version-check "$WHISPER_PACKAGE"; then
      warn "Whisper: could not install $WHISPER_PACKAGE into $venv. Torrent sessions get no Whisper subtitles; re-run to try again."
      return 0
    fi
  fi
  log "Whisper: model $model in $dir/models (downloaded once: about 460 MB for small)"
  if ready="$(HF_HOME="$dir/hf" HF_HUB_DISABLE_TELEMETRY=1 "$py" -I "$WHISPER_SCRIPT" --model "$model" --threads 2 --models-dir "$dir/models" --download-only 2>/dev/null | tail -n 1)" \
     && [[ "$ready" != *'"ready": false'* ]]; then
    log "Whisper: ready ${ready}"
  else
    warn "Whisper: model $model could not be loaded (${ready:-no answer}). The daemon downloads it on the first Whisper play instead."
  fi
}
```
`main`, between `make_data_dir` and `install_unit`:
```bash
  install_whisper
```
**Impact:** the first install after this phase takes about a minute more (measured: pip 10 s, model
46 s) and about 940 MB under the data dir; later runs about a second. The variables it reads from
`.env.local` are the daemon's own settings (documented in Step 9); it adds no `${NAME:-}` read and no
`export`, so the docs scanner finds nothing new in the script.

**File:** `tests/unit/scripts/installWhisper.test.ts` (new)
**Code:**
```ts
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const INSTALL = path.join(REPO, 'scripts', 'install.sh');

// A python3 that records each call, passes the venv check, makes a "venv" by copying itself and
// remembers a pip install in a marker beside its own bin folder.
const FAKE_PYTHON = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_PY_LOG"
here="$(cd "$(dirname "$0")/.." && pwd)"
case "$1" in
  -c) exit 0 ;;
  -m)
    if [[ "$2" == venv ]]; then dir="\${@: -1}"; mkdir -p "$dir/bin"; cp "$0" "$dir/bin/python"; exit 0; fi
    if [[ "$2" == pip ]]; then touch "$here/installed"; exit 0; fi
    ;;
  -I)
    if [[ "$2" == -c ]]; then [[ -f "$here/installed" ]]; exit $?; fi
    printf '{"ready": true, "model": "fake"}\\n'
    exit 0
    ;;
esac
exit 0
`;

let root: string;
let data: string;
let envLocal: string;
let pyLog: string;
let bin: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'notes-whisper-install-'));
  data = path.join(root, 'data');
  envLocal = path.join(root, '.env.local');
  pyLog = path.join(root, 'python.log');
  bin = path.join(root, 'bin');
  await mkdir(bin, { recursive: true });
  await mkdir(path.join(root, 'home'), { recursive: true });
  await writeFile(path.join(bin, 'python3'), FAKE_PYTHON);
  await chmod(path.join(bin, 'python3'), 0o755);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Runs install_whisper with this test's .env.local; answers the python calls it made. */
function installWhisper(envText: string | null): string[] {
  if (envText === null) rmSync(envLocal, { force: true });
  else writeFileSync(envLocal, envText);
  rmSync(pyLog, { force: true });
  execFileSync('bash', ['-c', 'source "$1"; ENV_LOCAL="$2"; install_whisper', '_', INSTALL, envLocal], {
    env: { ...process.env, HOME: path.join(root, 'home'), NOTES_DATA_DIR: data, PATH: `${bin}:${process.env.PATH}`, FAKE_PY_LOG: pyLog },
    encoding: 'utf8',
  });
  return existsSync(pyLog) ? readFileSync(pyLog, 'utf8').trim().split('\n') : [];
}

describe('install.sh install_whisper (sourced, fake python3)', () => {
  it('makes the venv, installs the pinned faster-whisper and loads the model on the first run', () => {
    const calls = installWhisper(null);
    const venv = path.join(data, 'whisper', 'venv');
    expect(calls).toContain(`-m venv --clear ${venv}`);
    expect(calls.some((c) => /^-m pip install .*faster-whisper==1\.2\.1$/.test(c))).toBe(true);
    expect(calls.at(-1)).toBe(`-I ${path.join(REPO, 'claude', 'streaming', 'torrent', 'whisper.py')} --model small --threads 2 --models-dir ${path.join(data, 'whisper', 'models')} --download-only`);
  });

  it('a second run installs nothing and only checks the model', () => {
    installWhisper(null);
    const calls = installWhisper(null);
    expect(calls.some((c) => c.startsWith('-m venv') || c.startsWith('-m pip'))).toBe(false);
    expect(calls.at(-1)).toMatch(/--download-only$/);
  });

  it('takes the folder and the model from .env.local', () => {
    const dir = path.join(root, 'w');
    const calls = installWhisper(`NOTESD_TORRENT_WHISPER_MODEL="base.en"\nNOTESD_TORRENT_WHISPER_DIR=${dir}\n`);
    expect(calls).toContain(`-m venv --clear ${path.join(dir, 'venv')}`);
    expect(calls.at(-1)).toContain('--model base.en');
  });

  it('installs nothing when .env.local turns torrents or Whisper off', () => {
    expect(installWhisper('NOTESD_TORRENT_WHISPER=off\n')).toEqual([]);
    expect(installWhisper('NOTESD_TORRENT=OFF\n')).toEqual([]);
  });
});
```
**Impact:** the test puts its fake `python3` first on `PATH`, so the `sudo -n apt-get` branch is
never reached from a test.

### Step 8: One stretch by hand
**File:** `scripts/whisper-sample.ts` (new)
**Change:** the real cutter and worker over one stretch of any file or address, outside the daemon.
It is the owner's "does Whisper work here" check and Proof journey J3. It reads the same settings as
the daemon and needs no database.
**Code:**
```ts
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
```
**Impact:** none on the tree (`scripts/*.ts` is outside `tsconfig.json`'s `include` and outside the
docs scanner's `.mjs`/`.sh` walk, as `scripts/docs/*.ts` already are).

### Step 9: Docs and the feature map
**File:** `docs/guide/reference/configuration.md` (phase 1's torrent table, after phase 7's rows),
`docs/guide/streaming.md` (the Torrents section phase 1/3 adds, after phase 7's subsection; "Where
the code is", line 1106), `docs/guide/install.md` (after lines 25 and 48),
`.claude/skills/verify-notesd/features/direct-streaming.md` (a new section before `## Gotchas`, line 325).
**Change:** the six settings, the behaviour, the install step, and what proves it.
**Code:**
`configuration.md` rows:
```markdown
| `NOTESD_TORRENT_WHISPER` | on | `off`: no Whisper tier. A torrent session whose other subtitle tiers find nothing plays without an English subtitle, and no Whisper worker ever starts. `scripts/install.sh` then skips installing it. See [streaming.md](../streaming.md#whisper-the-last-resort). |
| `NOTESD_TORRENT_WHISPER_DIR` | `<NOTES_DATA_DIR>/whisper` | Absolute path of the folder holding Whisper's virtual environment (`venv/`), its models (`models/`) and Hugging Face's cache (`hf/`). `scripts/install.sh` installs into the same folder. A relative path is rejected. |
| `NOTESD_TORRENT_WHISPER_PYTHON` | `<NOTESD_TORRENT_WHISPER_DIR>/venv/bin/python` | Absolute path of the Python that runs `claude/streaming/torrent/whisper.py`. When it is not there at start, the tier is off and the daemon log says so. |
| `NOTESD_TORRENT_WHISPER_MODEL` | `small` | The faster-whisper model: `tiny`, `base`, `small`, `medium`, `large-v3`, an `.en` variant, or a Hugging Face repo id. Downloaded once into the models folder (`small`: about 460 MB). |
| `NOTESD_TORRENT_WHISPER_THREADS` | `8` | CPU threads of the Whisper worker, which runs at a lower priority than the daemon. |
| `NOTESD_TORRENT_WHISPER_STRETCH_S` | `300` | Seconds of audio transcribed at a time, at least 5. A stretch's cues arrive together. |
```
`streaming.md`, the subsection:
```markdown
### Whisper: the last resort

When no subtitle file in the torrent, no subtitle service, no cloud provider and no embedded text
track gives an English subtitle, the session still starts at once, with a subtitle named
**English (Whisper)** that grows while the film plays. A transcript is not a subtitle, and the name
says so.

The daemon cuts the chosen file's audio into stretches of five minutes
(`NOTESD_TORRENT_WHISPER_STRETCH_S`) with ffmpeg, reading the torrent's own file route, so a stretch
whose bytes are not downloaded yet waits for them. A CPU Whisper (faster-whisper, int8, the `small`
model, `claude/streaming/torrent/whisper.py`, one worker that loads the model once) transcribes each
stretch. A title whose original language is English is transcribed; any other is translated into
English. The cues go into the same growing cue feed as an embedded track's, and the player picks them
up as it reads the track again.

The stretch the play starts in comes first, then each one after it, then those before it, so cues
are ahead of the picture soon after the start. On the owner's laptop (22 cores, 8 threads) five
minutes of Sintel took 2.5 s and a minute of steady dialogue 2.2 s: the voice filter skips music and
silence. The worker holds about 850 MB while it runs and exits when no torrent needs it.

When the session lets go of the torrent the stretch in progress is dropped; restarting notesd stops
the worker too. Cues already made stay in the feed, and
`<torrent folder>/<info hash>/notesd-whisper/` remembers the finished stretches, so a replay
carries on from there, and a file transcribed to the end plays with its finished track and runs
nothing.

Limits: a line right after a long stretch of music can be missed, a cue stays on screen at most 7 s,
names come out as heard, and the first audio stream is the one transcribed (the finder leaves
dual-audio releases out). `scripts/install.sh` installs Whisper ([install.md](install.md));
`NOTESD_TORRENT_WHISPER=off` turns it off.
```
`streaming.md`, "Where the code is" list, one line:
```markdown
- `src/directStream/torrent/subtitles/whisper.ts` and `claude/streaming/torrent/whisper.py`: Whisper, the last subtitle tier of a torrent session.
```
`install.md`, Requirements, after the `curl` line (25):
```markdown
- A Python 3.9 or later that can make a virtual environment, for the torrent source's Whisper
  subtitles. The installer finds one (miniconda's works; Ubuntu's own needs `python3-venv`, which it
  installs with `sudo -n` when it may) and warns, without stopping, when there is none.
```
`install.md`, step table, after the "Data dir" row (48):
```markdown
| Whisper | Unless `.env.local` turns torrents or Whisper off: a virtual environment in `~/mcp-notes-data/whisper/venv` (`NOTESD_TORRENT_WHISPER_DIR`), `pip install faster-whisper==1.2.1`, and the model (`NOTESD_TORRENT_WHISPER_MODEL`, `small`: about 460 MB) loaded once so it is on disk before the first play. The first run takes about a minute; later runs only check. A failure warns and the install goes on; torrent sessions then have no Whisper subtitles. |
```
`features/direct-streaming.md`, new section:
```markdown
## Torrent subtitles: Whisper, the last resort

- When the torrent's subtitle file, the subtitle service, the cloud borrow and the embedded text track
  all give no English subtitle, the session answers at once with a subtitle `{label: "English (Whisper)",
  lang: "en", growing: true}` whose cues arrive stretch by stretch in phase 7's cue feed and show in the
  player as they come; once the file is transcribed to the end the feed says `complete` (the subtitle stays
  `growing: true`: it is a cue feed). English titles are
  transcribed, others translated (`task` in each worker request).
- Off: `NOTESD_TORRENT_WHISPER=off`, or no Python at `NOTESD_TORRENT_WHISPER_PYTHON`: no Whisper track,
  one daemon log line (`torrent whisper: off` / `no Python at ...`).
- Proof: `npx vitest run tests/unit/directStream/torrent/whisper.test.ts tests/unit/directStream/torrent/whisperConfig.test.ts tests/unit/scripts/installWhisper.test.ts`;
  on a run, journeys J1 and J2 of `.workflows/plan/torrent-stream-source/phase-8.md` with the fake worker
  `tests/fixtures/torrent/fake-whisper.mjs` (`NOTESD_TORRENT_WHISPER_PYTHON=<it>`,
  `NOTESD_TORRENT_WHISPER_STRETCH_S=5`; `FAKE_WHISPER_DELAY_MS`, `FAKE_WHISPER_LOG`, `FAKE_WHISPER_MODE`);
  the real model by J3 (`npx tsx scripts/whisper-sample.ts`, scratch install, never the live data dir).
- Gotcha: a run's Whisper folder is `<run>/data/whisper`, which has no venv, so the tier is off on a
  throwaway daemon unless `NOTESD_TORRENT_WHISPER_PYTHON` is set in the caller's shell (verify.sh passes
  it through). Never point it at `~/mcp-notes-data/whisper`.
```
**Impact:** `npm test`'s docs check passes again with Step 1's names documented. No route, no MCP
tool and no picture changes, so `npm run docs:gen` and `docs:shots` are not needed.

## Principles applied

- Boundary discipline: every Whisper setting is checked once in `parseTorrentWhisper` (absolute paths, a model name that cannot carry spaces or `..`, a stretch of at least 5 s), and the worker's output, another program's, is checked once in `parseCues`; the tier trusts both.
- Make illegal states unrepresentable: `TorrentWhisperConfig` is a union, so an off config has no folder, model or Python that code could read by mistake, and `buildWhisperTier` gets the fields only after narrowing on `enabled`.
- Laziness protocol: one worker for the whole daemon (no pool), the first audio stream instead of a language matcher (the finder already drops dual-audio releases), progress in one small JSON file instead of a table, and no verify.sh flag (the run's environment already passes `NOTESD_TORRENT_WHISPER_PYTHON` through to a fake).
- Build the lever: the fake worker speaks the real protocol and reads the WAV header, so the same file drives the unit tests and the throwaway daemon and proves ffmpeg cut real audio; `scripts/whisper-sample.ts` lets anyone rerun the real model on any film in one command.
- Prove it works: the real install, model and realtime factor were measured before planning (the PyAV break and the loose segment ends changed the worker), and J3 runs the real model through the shipped code.
- Test behavior, not implementation: the tier's tests assert what the session and the page see (the track `find` answers, the cues and completion in the feed, which stretches were read) through injected seams, never private calls.

## Verification

**Build:** `npm run typecheck && npm run build`
**Tests:** `npm test` (and alone: `npx vitest run tests/unit/directStream/torrent/whisper.test.ts tests/unit/directStream/torrent/whisperConfig.test.ts tests/unit/scripts/installWhisper.test.ts`)
**Proof:** a throwaway daemon with every earlier tier empty grows an `English (Whisper)` track from a
fake worker and the page draws its cues; the real faster-whisper, installed by the installer's own
function into a scratch folder, turns Sintel's dialogue into timed English cues through the shipped
cutter and worker.
- Harness: `.claude/skills/verify-notesd` (`verify.sh up --web --direct-stream --torrent`, the
  `--torrent` mode phase 1 adds) for J1 and J2; J3 has no daemon (`scripts/whisper-sample.ts`).
- Feature-map entries: `.claude/skills/verify-notesd/features/direct-streaming.md` (the new
  "Torrent subtitles: Whisper" section, and phase 1/3's torrent entries for the run itself).
- Journeys:
  - **J1** · traces R3.6 — in the worktree, `V=.claude/skills/verify-notesd/scripts/verify.sh`;
    `export NOTESD_TORRENT_WHISPER_PYTHON=$PWD/tests/fixtures/torrent/fake-whisper.mjs NOTESD_TORRENT_WHISPER_STRETCH_S=5 FAKE_WHISPER_DELAY_MS=2000 FAKE_WHISPER_LOG=/tmp/claude-1000/fake-whisper-j1.jsonl`;
    `TORRENT_FIXTURE_FILE="$HOME/.local/state/notesd-verify/.torrent-fixture/Fixture.Film.2026.1080p.WEB-DL.x264-NOTESD/Fixture.Film.2026.1080p.WEB-DL.x264-NOTESD.mp4" $V up --web --direct-stream --torrent`
    (note `RUN`; phase 1's 120 s film, built by `up` before it is copied, seeded alone: no subtitle file beside it,
    no subtitle track in it); `grep 'torrent whisper: on' ~/.local/state/notesd-verify/$RUN/daemon.log`;
    `echo empty > ~/.local/state/notesd-verify/$RUN/torrent/subs/mode` (phase 6's fake subtitle service answers no
    subtitle; the borrow is skipped for this English title because Whisper is on);
    `$V api $RUN POST /api/stream/play '{"kind":"movie","tmdb_id":467905,"provider":"torrent"}'` and take
    `session.session_id`; read the subtitle whose `label` is `English (Whisper)` (note its `url` as FEED, `/api/stream/torrent/<hash>/cues/whisper-0`);
    `$V api $RUN GET "$FEED?after=0"` twice, 5 s apart, counting `.cues | length`; then poll it every 5 s until
    `complete` is true (at most 120 / 5 × 2 s + 30 s)
    → passes when the session answers that subtitle with `lang: "en"` and `growing: true` at once, its attempts hold
    `Subtitles: borrow` = `skipped` and `Subtitles: whisper` = `resolved`, the second read holds more cues than the
    first, every cue text matches `Whisper line \d+ \((transcribe|translate), [0-9.]+ s of audio\)` with at least one
    `5.0 s of audio`, the final read is complete with one cue per 5 s stretch of the film that has at least 1 s of
    audio, every line of `/tmp/claude-1000/fake-whisper-j1.jsonl` has `task` `transcribe` (467905's original language
    is `en`), and on disk `ls ~/.local/state/notesd-verify/$RUN/data/movies/torrents/<hash>/notesd-whisper/` shows
    `<hash>-0.json` with `"complete":true` and no `.wav` left.
  - **J2** · traces R3.6 — same run, same session id, before J1's final poll ends (or a second play of
    the same title after deleting `<run data>/movies/torrents/<hash>/notesd-whisper/*.json` and `<hash>/notesd-cues/whisper-0.jsonl`):
    write `/tmp/claude-1000/whisper-j2.steps.mjs` with
    `export default async ({ page, base, shot, log }) => { await page.goto(base + '/stream/<id>?muted=1'); await page.getByText(/Whisper line \d+/).first().waitFor({ timeout: 60000 }); await shot('whisper-cue-on-screen'); log('a Whisper cue is drawn while the track grows'); };`
    (the session id written in), then `$V ui $RUN /tmp/claude-1000/whisper-j2.steps.mjs`
    → passes when the step finishes without throwing and the screenshot shows a `Whisper line N (...)`
    cue over the picture.
  - **J3** · traces R3.6 — install the real Whisper with the installer's own function into a scratch
    folder: `NOTES_DATA_DIR=/tmp/claude-1000/whisper-proof bash -c 'source scripts/install.sh && ENV_LOCAL=/dev/null && install_whisper'`;
    then `NOTES_DATA_DIR=/tmp/claude-1000/whisper-proof npx tsx scripts/whisper-sample.ts https://download.blender.org/durian/movies/Sintel.2010.1080p.mkv --start 100 --length 60 --lang en | tee /tmp/claude-1000/whisper-j3.json`;
    then `rm -rf /tmp/claude-1000/whisper-proof`
    → passes when the installer logs `Whisper: ready {"ready": true, "model": "small", ...}`, the output
    has `"task":"transcribe"`, `audio_s` 60, at least 5 cues, every `start_s` between 100 and 160 and every
    `end_s - start_s` at most 7, and one cue text matches `/blade has a dark past/i` (measured
    2026-11-16: 11 cues, first at 106.58 s "This blade has a dark past.").
- Neighbor check: a cloud play is untouched. On the J1 run, `.claude/skills/verify-notesd/scripts/direct-stream/journey.sh $RUN hls`
  passes as before, and `npm test` (the docs reference check included) is green.
- Cost: no billed LLM call. J3 downloads about 940 MB (venv 479 MB, model 464 MB) and about 11 MB of
  Sintel's audio, about 2 minutes; J1/J2 take about a minute of fake transcription.
**Exit criteria:** `npm run typecheck` and `npm test` pass; J1 shows a growing `English (Whisper)`
track filled stretch by stretch and completed, J2 shows its cue drawn in the player, J3 shows the real
model's timed English cues for Sintel; with `NOTESD_TORRENT_WHISPER=off` the daemon logs
`torrent whisper: off` and builds no tier (unit: `parseTorrentWhisper` and `buildWhisperTier`).

## Assumptions

- Phase 3's chain (reconciled) stops at the first tier that answers anything and tries tiers in the order of
  `buildSubtitleTiers`, so this tier, last, runs only when phases 6 and 7 answered nothing. Its `ctx` carries
  `infoHash`, `fileIndex`, `audioLang`, `resumeS`, `probe.durationS` and `signal` under those names.
- Phase 7's feed persists its cues on disk per (info hash, track), keeps them across restarts, and accepts appends out
  of time order (reads go by count; the page's TextTrack orders cues itself, nobody sorts).
- Phase 1's file route blocks a ranged read until the pieces are on disk and fetches the asked range first (R2.1).
  Whisper's reads ask for the stretch on screen first and the ones just ahead next, which the play needs anyway; the
  earlier stretches come last. Once the torrent has left the swarm the route answers 409 `not_in_swarm` and never
  rejoins; the job has stopped by then (its signal aborted when the session let go).
- `audioLang` is the session's normalized original language ("en", "ko"); a 3-letter or unknown value
  is translated with language detection.

## Handoffs

- **Phase 3 (reconciled):** the `SubtitleContext` carries `signal`, aborted when the session lets go of the torrent
  (`TorrentSource.release`: page closed, film ended, shuffle, idle, session end); `resumeS` and `probe` under those
  names. A page that comes back does not restart a stopped job; the next play does, from the progress file.
- **Phase 3:** `config.torrent.ffmpegBin` / `NOTESD_FFMPEG_BIN` is phase 3's (main's picture check reads the same
  variable; the merge keeps one row).
- **Phase 6 (reconciled):** this phase sets `whisperCovers` on phase 6's `borrowTier(...)` line: with Whisper on, an
  English original skips the borrow (`Subtitles: borrow` = `skipped`).
- **Phase 7 (reconciled):** the feed is `torrentCues.get(infoHash, whisperTrackId(fileIndex))`, else
  `torrentCues.start(...)`; its address `cueFeedUrl(infoHash, whisperTrackId(fileIndex))`; the track is always
  `growing: true` (a cue feed, finished or not).
- **Phases 1, 3, 6 (verify harness):** J1 seeds phase 1's own film alone (`TORRENT_FIXTURE_FILE`: no subtitle file, no
  text track), sets phase 6's fake subtitle service to `empty`, and plays 467905 (English: the borrow is skipped);
  phase 8 adds no fixture film of its own.
- **Phase 1:** the progress files and WAVs live in `<torrent dir>/<info hash>/notesd-whisper/`, so clearing a
  download removes them with it.
- **Phase 9:** `claude/streaming/torrent/` gets `whisper.py` from this phase beside phase 9's
  `cli.mjs` and site modules; neither phase touches the other's files.
- Not taken: choosing the audio stream by language (would need phase 3's language normalizer in
  `src/`); a non-English realtime/accuracy measurement.

## Rollback

Revert this phase's merge. The tree goes back to phase 7's chain (no Whisper tier); `TorrentConfig`
loses `whisper` and the six settings' rows go with their parser. On a machine already installed,
`rm -rf ~/mcp-notes-data/whisper` frees about 940 MB, and `<torrent dir>/whisper/` holds only progress
files. Without a revert, `NOTESD_TORRENT_WHISPER=off` in `.env.local` turns it off and the next
`scripts/install.sh` skips it.
