---
name: sync-subtitle
description: Check that the English subtitle of a directly streamed film or episode in mcp-notes' own player is the right one and in step with what is said, and fix it when it is not — the subtitle shows another episode's lines, comes late or early, or drifts further off as the film goes on. Use whenever the user types "/sync-subtitle" (alone, for the stream on screen), "/sync-subtitle <movie id or title>" such as "/sync-subtitle M-NT38" or "/sync-subtitle dune 2021", or "/sync-subtitle <player page address>" such as "/sync-subtitle http://localhost:7317/stream/PAhM8Lh_Quy1ETptJPTuy2KkKWhtHAcy", in any Claude Code session — and for a plain-English request to the same effect, such as "the subtitle doesn't match", "the subtitles are out of sync", "wrong subtitle on this episode", "fix the subtitle timing", "is the subtitle of that film right?". Works for every kind of direct stream (a torrent: TM, TS; a cloud provider: NTM, NTS), while it plays (the open player gets the fixed subtitle within seconds, the film is not touched) or with nothing playing (the fix is kept for the next play). Not for a film played in VLC from the library (DM, DS) or on a streaming site (/idlix, /lk21).
argument-hint: [movie id, title, or player page address; nothing for the stream on screen] [a time such as 12:37 where people talk]
---

# /sync-subtitle

A direct stream's English subtitle often comes from outside the stream: a subtitle service's file,
picked by its name. The name can lie (another episode's file in the episode's list) and the timing
can be another release's. The daemon checks the subtitle against the film itself: Whisper hears a
minute of audio at six places spread over the film, and the subtitle is judged against those lines
for its **text** (is it this film?) and its **timing** (does each line come when it is said?).

**A hint says where to listen first.** A time the user names (`12:37`, `1:02:10`, or a range
`12:37-14:00`) is a place where people talk: that stretch is heard first. With no time and a stream
on screen, the daemon uses the minute around where the player is (30 s behind, 30 s ahead), by itself. When enough is said there
(8 lines), only the film's two ends are heard beside it, three stretches in place of six, and the
check takes about half the time. When the hint is quiet, or the three stretches do not settle it,
the usual places are heard as well, so a hint never makes a verdict weaker.

One tool does all of it: `mcp__notes__direct_stream_sync_subtitle`. Your job is to name the right
target, wait for the answer, and tell the user what was found, with the numbers.

## What to pass

| The user typed | Call with |
| --- | --- |
| `/sync-subtitle` (nothing after it) | no arguments: the stream on screen |
| a player page address (`http://localhost:7317/stream/<id>`) or a session id | `session`: that text, as it is |
| a movie id (`M-NT38`; an episode's id names its season and episode) | `title`: the id |
| a name ("dune 2021", "the bear season 2 episode 3") | `title` without the year, plus `year`, `season`, `episode` as said |
| a series with no episode | `title` alone: it means the episode on screen; with none on screen the tool answers `needs_episode` (`movies_get` gives `last_play`) |
| a codename with it (TM, TS / NTM, NTS) and nothing playing | `source: "torrent"` / `source: "cloud"` |
| a time or a range with any of the above (`/sync-subtitle 12:37`, `/sync-subtitle <address> 12:37-14:00`) | `at`: the time as typed, beside the target |

Pass `at` only when the user named a time; never guess one. A lone `12:37` is a time, not a title:
it means the stream on screen, heard there. Never invent a session id or a movie id. Do not call `direct_stream_play`: this skill starts no film.

## Live and idle

The tool decides by itself; say which it was (`mode`).

- **live**: a stream of the title is on screen. The audio is that stream's, and a fixed subtitle is
  put on the session: the open page loads it within about 5 seconds. The film, its position and
  whether subtitles are on stay as they are. Nobody needs to reload or press anything.
- **idle**: nothing plays it. This machine's finished torrent download of the title is checked, else
  a cloud source resolved out of sight (nothing opens, 5 to 40 seconds more). The fix is kept on this
  machine and the next play starts with it.

## Pending

A check takes about 40 seconds for a film on disk (about half with a hint that was enough), longer for a cloud stream or when many files are
tried. Past 45 seconds the tool answers `pending: true` with `stage`. That is not a failure: say in
one line that it is still checking, then call the tool again with exactly the same arguments. It
joins the same check; repeat until an outcome comes.

## Reading the answer

| `verdict` | What happened | Changed? |
| --- | --- | --- |
| `ok` | The subtitle shown is the right text and in step | no |
| `retimed` | Right text at the wrong time: moved by `chosen.shift_s` s, stretched by `chosen.stretch` when the frame rate differed | yes |
| `replaced` | Wrong text, missing, or cut for another edit: another file (`chosen.from`, `chosen.name`) passed both checks, re-timed first when `chosen.retimed` | yes |
| `none_fits` | The subtitle did not pass and no other file did | no |
| `unsure` | Too little matched to say (a film not in English is heard through Whisper's translation), or the track grows while the film plays and cannot be read as a file | no |
| `unheard` | Too little speech was heard (`heard.windows` says what each stretch gave) | no |

`current` is the subtitle that was shown and each entry of `tried` another file, all judged alike:

- `text`: `correct`, `wrong` or `unsure`, from `text_share`, the share of the `heard_lines` (lines of
  four words or more) found in it. The right file scores above 0.8; another episode's under 0.1.
- `timing`: `in_step` (within 0.6 s at both ends), `off` (one shift, or a shift and a stretch, fixes
  it), `scattered` (the offsets disagree: cut for another edit), `unknown`. `off_start_s` and
  `off_end_s` are subtitle minus speech, in seconds, at the start and the end of the film.
- `by_place`: that offset at each place heard (`at_s`, `lines`, `off_s`). For a `scattered` file, say
  what it shows: where the offset steps (a stream or a file cut differently from there on), and that
  every file stepping at the same place points at the stream, not the subtitles.

Nothing is ever changed unless a subtitle passed both checks, so a verdict with "no" above left the
player exactly as it was.

## The reply

Short, in plain words, with the evidence:

1. The title (season and episode), `mode`, and the source (`provider`).
2. The verdict in one sentence, with numbers: lines heard, the share found, the offsets. For
   example: "The subtitle is right and in step: 77 of 82 lines heard are in it, and it runs 0.02 s
   from the speech at both ends."
3. When it changed: what was wrong with the old one, what is shown now (`chosen.name`,
   `chosen.label`), and that the open player has it already (live) or the next play will (idle).
4. When nothing passed: one short line per file tried (name, text, timing), then what is left: the
   player's G and H keys move the lines 50 ms at a time, or another source of the title (a torrent
   that carries its own subtitle file, another cloud provider).
5. `heard.hint`, when there is one, in a few words: where it listened first (`at_s`, the named time
   or the minute around the player's position) and whether that was enough (`enough`).
6. `notes`, when it has any.

Follow the answer's `next`. Errors: `unknown_session` (the session ended: ask for the title or call
with no arguments), `no_audio` (a torrent was asked for and this machine holds no finished download:
offer `source: "cloud"` or to play it first), `no_source` (no cloud provider could stream it),
`subtitle_check_off` (direct streaming is off or Whisper is not installed: `scripts/install.sh`).

Do not edit a subtitle file by hand, and do not restart the daemon: a restart ends the stream.
