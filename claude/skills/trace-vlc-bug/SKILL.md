---
name: trace-vlc-bug
description: Find the root cause of a VLC problem on the user's Windows laptop when VLC was started by notesd (the movie library in mcp-notes) or by hand — "/trace-vlc-bug", "vlc crashed again", "vlc froze", "the movie won't play after I paused it", "there is a hole where the video should be", "vlc shows a black screen", "vlc opened a crash dialog", "why did vlc die last night", "check the vlc logs". Collects the notesd health log, VLC's frame counters and windows, the Windows event logs (display-driver resets, application crashes, sleep) and screenshots into one evidence folder, matches them against the known causes, and saves the finding as a note. Use it before guessing, and before touching the stuck VLC.
argument-hint: [what the user saw, e.g. "froze after a 5 minute pause"]
---

# /trace-vlc-bug

VLC runs on Windows; notesd starts it from WSL and follows it through VLC's HTTP interface. The
text after `/trace-vlc-bug` is what the user saw. Your job is the root cause, with evidence, not a
restart.

Three rules:

- **Collect first, with the broken VLC still open.** A stuck VLC is the evidence. Do not close,
  kill, restart or "fix" it, and do not start another play, until the collection is done.
- **Never kill a VLC without the user saying so.** notesd itself never does. If the cure is to
  close it, say so and let the user close it (or ask).
- **A process that answers is not a healthy player.** MEASURED 2026-11-15: a VLC whose video
  device was removed still answered HTTP, was `Responding: True`, had a visible video window of
  the right size and flat memory. Only the frame counters and a screenshot showed it.

## 1. Collect

```sh
~/.claude/skills/trace-vlc-bug/trace.sh --front
```

- `--front` brings each VLC window to the front for two screenshots 2 s apart, then gives focus
  back. Leave it out when the user is in the middle of something on screen.
- `--probe` is for a VLC that is **paused**: frozen counters prove nothing while paused, so this
  plays it for 6 s and pauses it again. Use it when the user says it cannot be played.
- `--hours N` widens the Windows event window (default 6).

It prints a summary and writes everything to
`~/mcp-notes-data/movies/vlc-traces/<stamp>/`:

| File | What it holds |
| --- | --- |
| `windows.txt` | Every `vlc.exe` (memory, handles, `Responding`, command line with the password redacted), its window tree, its frame counters read twice, the graphics driver version, display-driver events, application crashes and hangs, sleep and resume, VLC crash dumps, the `vlcrc` lines that matter |
| `health.json` | `GET /api/movies/player/health`: samples, run summaries, `gpu_resets`, `stalls`, `hangs`, `incidents` |
| `player.json` | The play notesd follows now (`video_stalled` is the live verdict) |
| `notesd.log` | The daemon's own lines about VLC |
| `vlc-health-tail.jsonl` | The raw tail of the health log |
| `screen*.jpg` | The desktop as it is, and with each VLC in front |
| `vlc-<pid>.log` | VLC's own log, when it was started with `--logfile` |

Then **read the screenshots** (`Read` the jpg files). Compare the two `-a` / `-b` shots: a playing
VLC whose two shots are identical has a frozen picture whatever its counters say.

## 2. Match the evidence

| What the evidence shows | Cause | Where it is proven |
| --- | --- | --- |
| A `Display` event 4101 ("display driver ... stopped responding and has successfully recovered") during the play; afterwards `playing` with the clock advancing and `decodedvideo` / `displayedpictures` frozen; the screenshot shows the desktop through the picture rectangle, or a frozen frame | **The graphics driver was reset under VLC.** Every Direct3D device is removed and VLC 3 never rebuilds its own. Sound and the clock go on, the picture is gone for good. Only closing and replaying that VLC helps. | `gpu_resets` and a `video_stall` start line in `health.json`; `VERDICT: VIDEO STALLED` in `windows.txt` |
| VLC opens a small "VLC crash reporting: VLC media player just crashed" dialog instead of the film | A previous VLC crashed and left a dump in `%APPDATA%\vlc\crashdump`. The dialog blocks playback until answered. | "VLC crash dumps" in `windows.txt`; the dump's time names the VLC that crashed |
| The HTTP interface stops answering while `vlc.exe` still exists | VLC's own threads are stuck (a real hang). | A `hang` line in `health.json`; `hung=True` on a window; an Application Hang (1002) event |
| `vlc.exe` is gone and an Application Error (1000) names it | VLC crashed. The faulting module says where (a codec DLL, the graphics driver's DLL, `libvlccore`). | "application crashes" in `windows.txt`; an `incident` when the daemon died with it |
| Private bytes climb while paused (`growth per paused minute` well above 0) | A leak during pause. | The run summary in `health.json` |
| Everything stops at the same second and the health log just ends | WSL or Windows itself went down (sleep, shutdown, a WSL crash), not VLC. | An `incident` on the next daemon start; sleep / resume / 6008 events |
| notesd never got an answer after launch (`tracking: false`, `http_timeout`) | VLC took over 20 s to open its HTTP interface, or a dialog (first-run, crash report) was in the way. | `notesd.log`; the screenshot |

When nothing matches, the cause is new: go to step 4.

## 3. What is known about this machine

- Lenovo 83D2, Core Ultra 7 155H, Intel Arc integrated graphics (driver `igfxn`). On driver
  32.0.101.6733 (April 2025) the driver reset itself 8 times in 30 days, once 4 min 20 s into a VLC
  pause. The driver was updated to 32.0.101.9175 on 2026-11-15 08:18 WIB; a 4101 event after that
  date means the update did not cure it (the 30-day list in `windows.txt` shows the dates).
- MEASURED 2026-11-15, by restarting the display adapter under a throwaway VLC 3.0.21 and comparing
  screenshots (the counters lie for some outputs):

  | VLC video output | After the adapter restart |
  | --- | --- |
  | default (`direct3d11`), with or without `--avcodec-hw=none` | Counters frozen, no picture |
  | `--vout=direct3d9` | Counters keep moving, picture frozen (`Present` fails with `0x88760870`) |
  | `--vout=directdraw` | Counters keep moving, picture frozen |
  | `--vout=glwin32` | VLC crashes |
  | `--vout=wingdi --avcodec-hw=none` | **Keeps playing.** No measurable CPU cost on this machine, same picture |
  | Stop, play and seek through HTTP on the broken VLC | Hangs; no recovery inside the same process |

  So this machine runs VLC with `NOTESD_VLC_EXTRA_ARGS=--vout=wingdi --avcodec-hw=none ...` in
  `~/mcp-notes/.env.local`. If a stall shows up with that setting on, it is a different bug.
- notesd records both sides itself: `gpu_reset` lines while any `vlc.exe` exists and `video_stall`
  lines for the VLC it follows (`docs/guide/movies.md`, "The VLC health log"). The stall rule only
  sees the default `direct3d11` output; with another output trust the screenshots.

## 4. A cause that is not in the table

1. Turn on VLC's own log if it is not on: add
   `--file-logging --logfile=C:\Users\<user>\AppData\Local\Temp\vlc-notesd.log --log-verbose=2`
   to `NOTESD_VLC_EXTRA_ARGS` (no spaces in the path; the setting is split on whitespace), restart
   notesd, reproduce. VLC overwrites the file on every start and buffers it, so run `trace.sh`
   (which copies it) before the next play, and expect the last lines only after VLC exits.
2. Reproduce on a throwaway VLC, never on the user's: start `vlc.exe` yourself with
   `--no-one-instance --extraintf http --http-port 47340 --http-password <anything>` and the same
   extra arguments, and stop only the pid you started.
3. To force the driver fault you need an elevated PowerShell (one UAC prompt for the user):
   `pnputil /restart-device "<InstanceId of Get-PnpDevice -Class Display>"`. The Win+Ctrl+Shift+B
   hotkey is too gentle: VLC survives it. Judge the result by two screenshots a few seconds apart,
   not by the counters.
4. Change one thing at a time and write down what each variant did.

## 5. Report and save

Tell the user, in this order: what happened (with times in WIB), the cause, the evidence that
proves it (the event, the counters, what the screenshot shows), and what to do now. Say plainly
when the evidence does not settle it.

Then save one note through the `notes` tools (plain text, no markdown, `origin` set, hashtags on
the last line: `#vlc #bug #mcp-notes`, plus `#movies`): the symptom, the cause, the evidence
folder, the times, and what was changed. Link it to this session as the `/n` skill describes.

If the cause was new, add a row to the table in step 2 and, when you measured something, to step 3
(`~/mcp-notes/claude/skills/trace-vlc-bug/SKILL.md`), in the same change.
