# Brief: Wyzie Synced for torrent subtitles

**Worktree:** `/home/miftah/.worktrees/mcp-notes/wyzie-synced`, branch `feature/wyzie-synced` (base `origin/main` @ `e4c1717`, the commit after the torrent set landed)
**Asked by the owner on 2026-11-17:** "add wyzie synced too" (they bought a Wyzie Pro key; `WYZIE_API_KEY` is in `/home/miftah/mcp-notes/.env.local`).

## What to build

A torrent session's English subtitle that came from outside the torrent (the `service` tier: Wyzie or the OpenSubtitles add-on; the `borrow` tier) may be timed for another release. After such a session starts, the daemon re-times it with Wyzie Synced in the background, keeps the synced file as the torrent's chosen subtitle, and the open player page takes it over without a reload. A subtitle from the torrent's own files or its embedded track is already in step and is never synced. A Whisper track is never synced.

## What is known (measured on 2026-11-17 with the owner's Pro key)

- `POST https://sub.wyzie.io/sync`, JSON body `{ key, id: "<tt id or TMDB id>", language: "en", speech: [[start_s, end_s], …], covered: [[from_s, to_s], …] }`; an episode adds `season` and `episode` (both). By `id`, Wyzie tries its top 5 English text subtitles and returns the one that fits the audio best.
- Answer 200: `{ url, offset, fps, confidence, inSync, subtitle: { release, fileName, source, isHearingImpaired, format }, tried }`. `url` is a normal download link with the fix applied (it carries a `tok`: never log or keep it); downloading it gives SubRip. `fps` is null or e.g. `"23.976:24"`.
- Cost: 60 requests per successful sync; a refused or failed one is free. The key's balance is about 2,000,000.
- Errors: 400 invalid fields, 401, 403 "Paid feature" (a free key), 404 "No subtitles found", 422 "Couldn't sync" / "No speech found" (also when under 120 s of speech fell inside `covered`), 429 / 402, 503.
- **The trial.** A library copy of Eastern Promises (6,028 s), speech detected with Silero VAD:
  - the first 12 minutes (`covered [[0,720]]`, 151 segments, 326 s of speech): 422 after 45 s, "None of the top 5 subtitles lines up";
  - the first 30 minutes (`covered [[0,1800]]`, 377 segments): 200 in 1.2 s, offset -0.89 s, fps `23.976:24`, confidence 1;
  - the whole film (1,044 segments): 200 in 1.3 s, offset -0.93 s, the same fps fix.
  So the head of a film is enough, but 12 minutes was not. The 30-minute request body is saved as `.workflows/plan/wyzie-synced-speech-sample.json` (no key in it) for a fixture and for a live check.
- **Speech detection is already installed.** The Whisper environment (`<data dir>/whisper/venv`, faster-whisper 1.2.1) has Silero VAD: `from faster_whisper.vad import get_speech_timestamps, VadOptions`; over 16 kHz mono float32 samples it returns `[{start, end}]` in samples. The whole 100-minute film took 9 s; cutting its audio to 16 kHz mono WAV with ffmpeg took about 20 s from a local file. No model download is needed for the VAD (it ships with the package).
- Docs: https://docs.wyzie.io/subs/usage/synced (uploading the audio itself is also possible, but past about 90 MB it needs a chunked protocol: do not build that).

## Design (decided; change it only where the code makes it wrong, and say so)

1. **`src/directStream/torrent/subtitles/synced.ts`**: the client (`POST /sync`, then the download, to WebVTT through `vttFromBytes`) and the background job. Reuse `wyzie.ts`'s `withoutSecrets`, the `SubtitleShelf` (`disk.ts`), and Whisper's audio cutter (`ffmpegCutter` / `cutArgs` in `whisper.ts`), which already cuts 16 kHz mono WAV from the local file route and blocks until the bytes are on disk.
2. **Speech**: a small script beside `claude/streaming/torrent/whisper.py` (e.g. `vad.py <wav>` printing `[[start_s, end_s], …]` as JSON), run with the Whisper environment's Python. Read `src/config.ts` (`TorrentWhisperConfig`) for where that Python is. The VAD does not need the Whisper tier to be on, only its environment to be installed; when there is no environment, the sync is skipped with a log line and nothing else changes.
3. **The job**, started when a session's subtitle chain resolved at the `service` or `borrow` tier and a Wyzie key is set (`config.torrent.wyzieKey`), bound to `ctx.signal` (it stops when the session lets go of the torrent):
   - horizons 30 minutes, then 60 minutes, then the whole file (each only when the film is longer than the one before); for each: cut the audio from 0 to the horizon in stretches as the download reaches them, detect speech, `POST /sync` with `covered [[0, horizon]]`; a 422 goes on to the next horizon, any other failure ends the job. A film shorter than 30 minutes goes straight to the whole file.
   - a 200: download `url`, keep it on the shelf as the chosen track (so a replay from disk plays the synced file through the `kept` tier, and is not synced again), label `English (Wyzie, synced)`, and replace the session's subtitle. `inSync: true` with the same kind of subtitle still replaces it (Wyzie picked the best fit of five).
   - At most one sync per torrent and file; the outcome (done, or failed and why) is remembered in the torrent folder so a replay does not pay or try again after a success.
   - It must not hold up the play, and it is outside the chain's 40 s budget.
4. **The open page takes the synced file.** The page reports its position every 5 s (`POST /api/stream/sessions/:id/position`) and ignores the answer. Let that answer carry the session's subtitle revision (a counter that the sync bumps); when the page sees it change it fetches the session again and reloads its file subtitle tracks (`clearFileTracks`, `loadFileSubtitles` in `web/src/stream/controller.ts`), keeping the viewer's choice (on or off), the position and the film untouched. If a cleaner channel exists in the code as it is now, use that instead. The owner's own G/H subtitle delay for the title is reset to 0 when a synced file replaces the old one, since it was set against the old timing; the line over the picture says `Subtitles synced` once.
5. **Settings**: `NOTESD_TORRENT_WYZIE_SYNC` (default on when `WYZIE_API_KEY` is set; `off` disables). A row in `docs/guide/reference/configuration.md`.
6. **Never** log, throw, store or put into attempts, evidence or a fixture the key or a `tok`.

## Rules

- Read `CLAUDE.md` first, then `docs/guide/streaming.md` (Torrents, the subtitle tiers), `src/directStream/torrent/subtitles/*`, `src/directStream/torrent/source.ts`, `src/directStream/service.ts` (the torrent branches, `sessionInfo`), `src/http/directStreamApi.ts` (the position route), `web/src/stream/controller.ts` and `subtitles.ts`.
- Tests never touch the network or the real Python: the sync client gets a fake fetch, the VAD and the cutter are injected. Web tests are jsdom.
- Docs in the same change: the guide's subtitle section, the configuration row, `npm run docs:gen` if a route's answer changed (describe it in `scripts/docs/httpRoutes.ts`), the feature map in `.claude/skills/verify-notesd/features/direct-streaming.md`.
- Prove it with `.claude/skills/verify-notesd` (throwaway daemon, `--torrent`; the fake subtitle service there can answer `POST /sync`), never the live daemon on 7317. `npm run typecheck` and `npm test` pass.
- One live check is allowed and wanted (it costs 60 requests): post `.workflows/plan/wyzie-synced-speech-sample.json` plus the key from `/home/miftah/mcp-notes/.env.local` with the new client code and confirm a 200 with an offset near -0.9 s. Do not print the key or the answer's `url`.
- Decide forks yourself and write down what you decided; do not stop to ask.

## Landing

When it is proven: commit on `feature/wyzie-synced`, merge to `main`, push, and remove the worktree and branch, the way the torrent set landed (see `git log` on main: `merge(torrent-stream-source)`). Then rebuild and restart the daemon (`scripts/install.sh` is idempotent) **only if nothing is streaming** (`GET http://127.0.0.1:7317/api/movies/player` shows no `stream`, and VLC is not playing): a restart ends every stream session. If something is playing, land the code, skip the restart, and say so in the last message.
