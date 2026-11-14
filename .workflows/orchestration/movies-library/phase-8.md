# Phase 8: Docs, feature map, verify fixtures, live config

**Plan set:** `MOVIES_LIBRARY_PLAN.md`
**Analysis:** `.workflows/analyze/20261114-121616-M7VL_code_analyzer.md`
**Satisfies:** R7 — "Update CLAUDE.md, README and the verify-notesd features map" for the Movies subsystem phases 1–7 built
**Criteria:** R7.1
**Depends on:** Phase 6, Phase 7, Phase 9 (and through them 1–5)
**Difficulty:** NORMAL
**Package:** `.claude/skills/verify-notesd` (plus `README.md`, `CLAUDE.md`)

---

## Goal

After this phase the Movies subsystem is documented where every agent and the owner look first
(`CLAUDE.md` architecture bullet, README tour + env + HTTP + MCP tables), and it is provable: a
`verify.sh up --movies` run gets a generated video library, a fake TMDB and a fake `vlc.exe`/`curl.exe`
pair, and one script (`scripts/movies/journey.sh`) drives sync -> posters -> detail -> rate/review/watched
-> play -> progress -> delete/move -> `movies_continue` -> unmatched/assign on that throwaway daemon. A
plain `verify.sh up` pins `NOTESD_MOVIES=off`, so no throwaway daemon ever scans the owner's real folders.
Last, after the set is on `main`, the live `~/mcp-notes/.env.local` gains the three Movies keys and the live
daemon is migrated, rebuilt and restarted.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `verify.sh up --movies` flag; `verify.sh vlc RUN args|status|commands|at SECONDS|quit` subcommand; `MOVIES=<dir>` line in `up` output; `movies=0|1` in the run's `meta`; a `tmdb` line in `doctor` (`.claude/skills/verify-notesd/scripts/verify.sh`)
- `.claude/skills/verify-notesd/scripts/movies/make-fixtures.sh` (generated library, cached in `$VERIFY_HOME/.movies-fixture`)
- `.claude/skills/verify-notesd/scripts/movies/fake-tmdb.mjs` + `tmdb.json` (fixture TMDB, ids `movie-467905`, `tv-247718`, `movie-990001..990004`, person 990101)
- `.claude/skills/verify-notesd/scripts/movies/fake-vlc.mjs` (modes `vlc`, `curl`, `control`)
- `.claude/skills/verify-notesd/scripts/movies/vlc-qt-interface.ini` (fixture `[RecentsMRL]`)
- `.claude/skills/verify-notesd/scripts/movies/journey.sh` and `ui-library.mjs` (the whole-chain journey)
- `.claude/skills/verify-notesd/scripts/movies/doc-check.sh` (docs vs code coverage check)
- `.claude/skills/verify-notesd/features/movies.md`; one row in `features/README.md`
- `README.md` `## Movies` tour section, Contents link, Movies rows in Configuration / MCP tools / HTTP API, storage lines, one Limitations bullet
- `CLAUDE.md` `- **Movies**` architecture bullet
- Live (untracked, post-merge): `NOTESD_MOVIES_ROOTS`, `NOTESD_MOVIES_DONE_DIRS`, `NOTESD_VLC_INI` in `/home/miftah/mcp-notes/.env.local`

**Signature changes:** `verify.sh up` (no flag) now also pins `NOTESD_MOVIES=off` in the daemon env (before: unset).
**Requires (from earlier phases):**
- Phase 1: `parseMovies` reads the 16 env vars of the index's Shared contract by those exact names in `src/config.ts`; the `movie_*` tables and columns exactly as the contract lists them; README env rows exist as one contiguous block (phase 8 replaces the block).
- Phase 3: `POST /api/movies/sync` (via phase 4) starts a pass; done dirs compared per path segment; probe (too short) happens before any TMDB lookup, so a short clip never reaches the fallback.
- Phase 4: the routes of the contract, literally `'/api/movies…'` strings in `src/http/moviesApi.ts`; JSON bodies `{watched?, rating?, review?}`, `{watched}`, `{kind, tmdb_id, season?, episode?}`; file objects in responses carry `id` or `file_id`, `state`, `available`; unmatched entries carry `reason`; titles carry `poster_url`. Notes tag `movie` on the review note.
- Phase 5: launches `NOTESD_VLC_BIN` with `--http-port`, `--http-password`, `--start-time` (either `--x=v` or `--x v`) and the `wslpath -w` file as an argument; reads status only through `NOTESD_CURL_EXE … http://127.0.0.1:<port>/requests/status.json[?command=…]`; treats curl exit 7 as "VLC gone"; reads `NOTESD_VLC_INI` `[RecentsMRL]` on each pass; answers a foreign-host play with `not_on_this_machine`.
- Phase 6: wall hooks listed under Handoffs (rail button named `Movies`, poster `alt` = title, `data-testid="movie-file"` rows with `data-deleted`).
- Phase 7: tools registered with `server.registerTool('movies_…'` in `src/mcp/movieTools.ts`; args `movies_continue {title?}`, `movies_person {name}`, `movies_list {company}`, `movies_history {title}`, `movies_get {title}` (a title id or name; reconciled); `movies_continue` returns the contract's `ContinueResult` JSON; `movies_person` entries carry the TMDB `id` (number) or `title_id` and `seen` (boolean).

**Leaves alone (owned by others):** everything under `src/`, `web/`, `drizzle/`, `tests/`, `claude/skills/n/SKILL.md`, `src/mcp/instructions.ts` (phases 1–7). No product seam is added: every journey runs on env vars the contract already defines.

## Files

| File | Action | What changes |
|---|---|---|
| `.claude/skills/verify-notesd/scripts/movies/make-fixtures.sh` | create | ffmpeg lavfi library: 6 × 960 s videos in the six-shape layout, one 20 s clip in `Done/docker_es` |
| `.claude/skills/verify-notesd/scripts/movies/tmdb.json` | create | fixture TMDB bodies: 5 movies, 1 series with 3 episodes, 2 people |
| `.claude/skills/verify-notesd/scripts/movies/fake-tmdb.mjs` | create | TMDB v3 stand-in + PNG posters, logs requests |
| `.claude/skills/verify-notesd/scripts/movies/fake-vlc.mjs` | create | fake `vlc.exe`, fake `curl.exe`, control CLI |
| `.claude/skills/verify-notesd/scripts/movies/vlc-qt-interface.ini` | create | `[RecentsMRL]` with two gone films |
| `.claude/skills/verify-notesd/scripts/movies/journey.sh` | create | 12-stage whole-chain journey with assertions |
| `.claude/skills/verify-notesd/scripts/movies/ui-library.mjs` | create | Playwright steps: grid, MobLand detail, deleted flag |
| `.claude/skills/verify-notesd/scripts/movies/doc-check.sh` | create | env vars / routes / tools in code ⇔ docs |
| `.claude/skills/verify-notesd/scripts/verify.sh` | modify | header `:8-22`, `cmd_up` flags `:73-82`, movies block after `:130`, env `:135-148`, meta `:149-156`, output `:173-176`, `cmd_doctor` `:197`, new `cmd_vlc`, `stop_run` `:293-310`, dispatcher `:330-344` |
| `.claude/skills/verify-notesd/SKILL.md` | modify | Launch block `:21-26`, paragraph after `:38`, Drive table after `:61`, Gotchas after `:133` |
| `.claude/skills/verify-notesd/features/movies.md` | create | the four standard sections |
| `.claude/skills/verify-notesd/features/README.md` | modify | one row after the `egress.md` row (`:18`) |
| `CLAUDE.md` | modify | `- **Movies**` bullet after the Seer Adversarial bullet (`:42`) |
| `README.md` | modify | Contents `:43`, `## Movies` before `## Install and run` (`:985`), env block (phase 1's rows, after `NOTESD_EGRESS_METER` `:1116`), MCP rows after `adversary_redo_*` (`:1171`), sentence `:1182`, HTTP rows before `/full/:imageId` (`:1269`), storage lines before `app_settings` (`:1298`), Limitations after `:1369` |
| `/home/miftah/mcp-notes/.env.local` | modify (live, untracked) | append three keys if absent — Step 10, after merge |

Line numbers are today's `e09e602`; phase 1 shifts README's env-table neighbourhood by its rows. Anchor on the quoted text, not the number.

## Implementation Steps

### Step 1: Fixture library generator
**File:** `.claude/skills/verify-notesd/scripts/movies/make-fixtures.sh` (new, `chmod +x`)
**Change:** Generate the library once with ffmpeg lavfi; verify.sh copies it per run. All long videos are exactly 960 s (over `NOTESD_MOVIES_MIN_SECONDS=900`, and the fake VLC reports the same length). The layout covers: Pahe dots, Pahe underscores, year only in the folder, an SxxEyy season folder, a film already in `Done`, a short junk clip in `Done/docker_es`, and a second root with a space in its name.
**Code:**
```bash
#!/usr/bin/env bash
# make-fixtures.sh DEST: build the movie library `verify.sh up --movies` copies into every run.
# Idempotent: DEST/.complete-v1 marks a finished build; anything else in DEST is rebuilt.
# Bump the stamp name when the layout changes, so cached copies are rebuilt.
set -euo pipefail
DEST=${1:?usage: make-fixtures.sh DEST}
STAMP="$DEST/.complete-v1"
[ -f "$STAMP" ] && exit 0
command -v ffmpeg >/dev/null || { echo "make-fixtures: ffmpeg is not on PATH" >&2; exit 1; }
command -v ffprobe >/dev/null || { echo "make-fixtures: ffprobe is not on PATH" >&2; exit 1; }
rm -rf "$DEST"
mkdir -p "$DEST"

LONG=960   # 16 min: over NOTESD_MOVIES_MIN_SECONDS (900); fake-vlc.mjs reports the same length
SHORT=20   # a WhatsApp-style clip: under the minimum, so it never reaches TMDB

video() { # video PATH SECONDS: a black 32x18, 1 fps MPEG-4 video (a few KB)
  mkdir -p "$(dirname "$1")"
  ffmpeg -hide_banner -loglevel error -nostdin -y -f lavfi -i "color=c=0x1d2630:s=32x18:r=1" \
    -t "$2" -c:v mpeg4 -q:v 31 -an "$1"
}

V="$DEST/library/Videos"
T="$DEST/library/Telegram Desktop"
S="$V/Mobland S01 WEB-DL 1080p x265 6CH [Pahe.in]"
video "$V/How.to.Make.a.Killing.2026.1080p.WEB-DL.x265.6CH-Pahe.in.mkv" "$LONG"
video "$S/MobLand.S01E01.Stick.or.Twist.1080p.WEB-DL.x265.6CH-Pahe.in.mkv" "$LONG"
video "$S/MobLand.S01E02.Eye.for.an.Eye.1080p.WEB-DL.x265.6CH-Pahe.in.mkv" "$LONG"
video "$S/MobLand.S01E03.Lie.Down.with.Dogs.1080p.WEB-DL.x265.6CH-Pahe.in.mkv" "$LONG"
video "$V/Done/The_Rivals_of_Amziah_King_2026_1080p_BluRay_x265_DD+5_1_Pahe_in.mkv" "$LONG"
video "$V/Done/docker_es/WhatsApp Video 2026-10-01 at 21.14.03.mp4" "$SHORT"
video "$T/Oldboy (2003)/Oldboy.mkv" "$LONG"

got="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$T/Oldboy (2003)/Oldboy.mkv")"
awk -v d="$got" 'BEGIN { exit !(d + 0 >= 955 && d + 0 <= 965) }' || {
  echo "make-fixtures: ffprobe reads ${got}s for a ${LONG}s fixture" >&2
  exit 1
}
touch "$STAMP"
```
**Check:** `D=$(mktemp -d); .claude/skills/verify-notesd/scripts/movies/make-fixtures.sh "$D/f" && find "$D/f/library" -type f | sort` lists the 7 files; running it again exits 0 at once.
**Impact:** none on the product; only verify runs read it.

### Step 2: Fake TMDB data and server
**Files:** `.claude/skills/verify-notesd/scripts/movies/tmdb.json` (new), `.claude/skills/verify-notesd/scripts/movies/fake-tmdb.mjs` (new)
**Change:** A TMDB v3 stand-in. `tmdb.json` stores the full bodies of `/movie/{id}?append_to_response=credits` and `/tv/{id}?append_to_response=aggregate_credits,credits` (plus `seasons_detail` per season and `combined_credits` per person); the server derives search results from them and answers both the appended and the separate sub-routes, because phase 2 may use either. Posters are solid-colour PNGs made in memory. Ids 467905 and 247718 are the real ones the analysis probed; every other id is a fixture id in the 9900xx range.
**Code (`tmdb.json`):**
```json
{
  "movies": [
    {
      "id": 467905, "title": "How to Make a Killing", "original_title": "How to Make a Killing", "original_language": "en",
      "release_date": "2026-02-20", "runtime": 105, "popularity": 41.2, "vote_average": 7.1, "vote_count": 512,
      "overview": "Verify fixture. A disinherited heir works out how far he will go to get his family's fortune back.",
      "poster_path": "/fx-how-to-make-a-killing.jpg", "backdrop_path": "/fx-how-to-make-a-killing-bd.jpg",
      "genres": [{ "id": 80, "name": "Crime" }, { "id": 35, "name": "Comedy" }],
      "production_companies": [{ "id": 41077, "logo_path": null, "name": "A24", "origin_country": "US" }],
      "credits": {
        "cast": [
          { "id": 990102, "name": "Glen Powell", "character": "Becket Redfellow", "order": 0, "profile_path": null, "known_for_department": "Acting" },
          { "id": 990101, "name": "Margaret Qualley", "character": "Julia", "order": 1, "profile_path": null, "known_for_department": "Acting" }
        ],
        "crew": [
          { "id": 990103, "name": "John Patton Ford", "job": "Director", "department": "Directing", "profile_path": null },
          { "id": 990103, "name": "John Patton Ford", "job": "Screenplay", "department": "Writing", "profile_path": null },
          { "id": 990104, "name": "Verify Producer", "job": "Producer", "department": "Production", "profile_path": null }
        ]
      }
    },
    {
      "id": 990001, "title": "The Rivals of Amziah King", "original_title": "The Rivals of Amziah King", "original_language": "en",
      "release_date": "2026-03-13", "runtime": 112, "popularity": 18.3, "vote_average": 6.8, "vote_count": 140,
      "overview": "Verify fixture. A beekeeper and moonshiner in rural Oklahoma takes in an orphan girl.",
      "poster_path": "/fx-rivals-of-amziah-king.jpg", "backdrop_path": null,
      "genres": [{ "id": 18, "name": "Drama" }],
      "production_companies": [{ "id": 3172, "logo_path": null, "name": "Blumhouse Productions", "origin_country": "US" }],
      "credits": {
        "cast": [
          { "id": 990105, "name": "Matthew McConaughey", "character": "Amziah King", "order": 0, "profile_path": null, "known_for_department": "Acting" }
        ],
        "crew": [
          { "id": 990106, "name": "Andrew Patterson", "job": "Director", "department": "Directing", "profile_path": null },
          { "id": 990106, "name": "Andrew Patterson", "job": "Writer", "department": "Writing", "profile_path": null },
          { "id": 990104, "name": "Verify Producer", "job": "Producer", "department": "Production", "profile_path": null }
        ]
      }
    },
    {
      "id": 990004, "title": "Oldboy", "original_title": "올드보이", "original_language": "ko",
      "release_date": "2003-11-21", "runtime": 120, "popularity": 30.0, "vote_average": 8.3, "vote_count": 9000,
      "overview": "Verify fixture. A man held captive for fifteen years is released and given five days to learn why.",
      "poster_path": "/fx-oldboy.jpg", "backdrop_path": null,
      "genres": [{ "id": 18, "name": "Drama" }, { "id": 53, "name": "Thriller" }],
      "production_companies": [{ "id": 7036, "logo_path": null, "name": "Show East", "origin_country": "KR" }],
      "credits": {
        "cast": [
          { "id": 990107, "name": "Choi Min-sik", "character": "Oh Dae-su", "order": 0, "profile_path": null, "known_for_department": "Acting" }
        ],
        "crew": [
          { "id": 990108, "name": "Park Chan-wook", "job": "Director", "department": "Directing", "profile_path": null },
          { "id": 990108, "name": "Park Chan-wook", "job": "Screenplay", "department": "Writing", "profile_path": null }
        ]
      }
    },
    {
      "id": 990002, "title": "The Dog Stars", "original_title": "The Dog Stars", "original_language": "en",
      "release_date": "2026-03-27", "runtime": 118, "popularity": 25.0, "vote_average": 6.9, "vote_count": 210,
      "overview": "Verify fixture. A pilot and his dog live on after a flu wipes out most of the world.",
      "poster_path": "/fx-dog-stars.jpg", "backdrop_path": null,
      "genres": [{ "id": 878, "name": "Science Fiction" }],
      "production_companies": [{ "id": 1645, "logo_path": null, "name": "Scott Free Productions", "origin_country": "US" }],
      "credits": {
        "cast": [
          { "id": 990109, "name": "Jacob Elordi", "character": "Hig", "order": 0, "profile_path": null, "known_for_department": "Acting" }
        ],
        "crew": [
          { "id": 990110, "name": "Ridley Scott", "job": "Director", "department": "Directing", "profile_path": null },
          { "id": 990117, "name": "Mark L. Smith", "job": "Screenplay", "department": "Writing", "profile_path": null }
        ]
      }
    },
    {
      "id": 990003, "title": "Bad Apples", "original_title": "Bad Apples", "original_language": "en",
      "release_date": "2025-10-03", "runtime": 99, "popularity": 12.0, "vote_average": 6.2, "vote_count": 80,
      "overview": "Verify fixture. A teacher keeps her worst pupil locked in her basement.",
      "poster_path": "/fx-bad-apples.jpg", "backdrop_path": null,
      "genres": [{ "id": 35, "name": "Comedy" }, { "id": 53, "name": "Thriller" }],
      "production_companies": [{ "id": 990301, "logo_path": null, "name": "Verify Pictures", "origin_country": "SE" }],
      "credits": {
        "cast": [
          { "id": 990111, "name": "Saoirse Ronan", "character": "Maria", "order": 0, "profile_path": null, "known_for_department": "Acting" }
        ],
        "crew": [
          { "id": 990112, "name": "Jonatan Etzler", "job": "Director", "department": "Directing", "profile_path": null }
        ]
      }
    }
  ],
  "tv": [
    {
      "id": 247718, "name": "MobLand", "original_name": "MobLand", "original_language": "en", "origin_country": ["GB"],
      "first_air_date": "2025-03-30", "episode_run_time": [55], "popularity": 88.5, "vote_average": 8.0, "vote_count": 640,
      "overview": "Verify fixture. A fixer keeps a London crime family together while rival gangs close in.",
      "poster_path": "/fx-mobland.jpg", "backdrop_path": "/fx-mobland-bd.jpg",
      "genres": [{ "id": 80, "name": "Crime" }, { "id": 18, "name": "Drama" }],
      "number_of_seasons": 1, "number_of_episodes": 3,
      "created_by": [{ "id": 990113, "name": "Ronan Bennett", "profile_path": null }],
      "production_companies": [{ "id": 990302, "logo_path": null, "name": "Verify Television", "origin_country": "GB" }],
      "seasons": [{ "id": 990401, "season_number": 1, "episode_count": 3, "air_date": "2025-03-30", "name": "Season 1", "poster_path": null, "overview": "" }],
      "aggregate_credits": {
        "cast": [
          { "id": 990114, "name": "Tom Hardy", "profile_path": null, "order": 0, "total_episode_count": 3, "roles": [{ "credit_id": "fx1", "character": "Harry Da Souza", "episode_count": 3 }] },
          { "id": 990115, "name": "Helen Mirren", "profile_path": null, "order": 1, "total_episode_count": 3, "roles": [{ "credit_id": "fx2", "character": "Maeve Harrigan", "episode_count": 3 }] }
        ],
        "crew": [
          { "id": 990116, "name": "Guy Ritchie", "profile_path": null, "department": "Directing", "total_episode_count": 2, "jobs": [{ "credit_id": "fx3", "job": "Director", "episode_count": 2 }] },
          { "id": 990113, "name": "Ronan Bennett", "profile_path": null, "department": "Writing", "total_episode_count": 3, "jobs": [{ "credit_id": "fx4", "job": "Writer", "episode_count": 3 }] },
          { "id": 990104, "name": "Verify Producer", "profile_path": null, "department": "Production", "total_episode_count": 3, "jobs": [{ "credit_id": "fx5", "job": "Executive Producer", "episode_count": 3 }] }
        ]
      },
      "credits": {
        "cast": [
          { "id": 990114, "name": "Tom Hardy", "character": "Harry Da Souza", "order": 0, "profile_path": null },
          { "id": 990115, "name": "Helen Mirren", "character": "Maeve Harrigan", "order": 1, "profile_path": null }
        ],
        "crew": [
          { "id": 990116, "name": "Guy Ritchie", "job": "Director", "department": "Directing", "profile_path": null },
          { "id": 990113, "name": "Ronan Bennett", "job": "Writer", "department": "Writing", "profile_path": null },
          { "id": 990104, "name": "Verify Producer", "job": "Executive Producer", "department": "Production", "profile_path": null }
        ]
      },
      "seasons_detail": {
        "1": {
          "id": 990401, "season_number": 1, "name": "Season 1", "air_date": "2025-03-30", "overview": "", "poster_path": null,
          "episodes": [
            { "id": 990501, "season_number": 1, "episode_number": 1, "name": "Stick or Twist", "air_date": "2025-03-30", "runtime": 57, "overview": "Verify fixture episode 1.", "still_path": "/fx-mobland-s01e01.jpg" },
            { "id": 990502, "season_number": 1, "episode_number": 2, "name": "Eye for an Eye", "air_date": "2025-04-06", "runtime": 52, "overview": "Verify fixture episode 2.", "still_path": "/fx-mobland-s01e02.jpg" },
            { "id": 990503, "season_number": 1, "episode_number": 3, "name": "Lie Down with Dogs", "air_date": "2025-04-13", "runtime": 50, "overview": "Verify fixture episode 3.", "still_path": "/fx-mobland-s01e03.jpg" }
          ]
        }
      }
    }
  ],
  "people": [
    {
      "id": 990101, "name": "Margaret Qualley", "known_for_department": "Acting", "profile_path": null, "popularity": 30.1,
      "biography": "Verify fixture.", "birthday": "1994-10-23",
      "combined_credits": {
        "cast": [
          { "id": 467905, "media_type": "movie", "title": "How to Make a Killing", "original_title": "How to Make a Killing", "release_date": "2026-02-20", "character": "Julia", "poster_path": "/fx-how-to-make-a-killing.jpg", "popularity": 41.2, "vote_count": 512, "credit_id": "fx6" },
          { "id": 990201, "media_type": "movie", "title": "Kinds of Kindness", "original_title": "Kinds of Kindness", "release_date": "2024-06-21", "character": "Verify role", "poster_path": "/fx-kinds-of-kindness.jpg", "popularity": 20.4, "vote_count": 900, "credit_id": "fx7" }
        ],
        "crew": []
      }
    },
    {
      "id": 990114, "name": "Tom Hardy", "known_for_department": "Acting", "profile_path": null, "popularity": 50.0,
      "biography": "Verify fixture.", "birthday": "1977-09-15",
      "combined_credits": {
        "cast": [
          { "id": 247718, "media_type": "tv", "name": "MobLand", "original_name": "MobLand", "first_air_date": "2025-03-30", "character": "Harry Da Souza", "episode_count": 3, "poster_path": "/fx-mobland.jpg", "popularity": 88.5, "vote_count": 640, "credit_id": "fx8" }
        ],
        "crew": []
      }
    }
  ]
}
```
**Code (`fake-tmdb.mjs`):**
```js
// fake-tmdb.mjs: a TMDB v3 stand-in for `verify.sh up --movies`. Serves tmdb.json (search, details
// with credits, seasons, people) and solid-colour PNG posters on 127.0.0.1, on any free port.
//   node fake-tmdb.mjs --data tmdb.json --port-file FILE --log FILE
// The daemon reaches it through TMDB_API_BASE=http://127.0.0.1:<port>/3 and
// TMDB_IMAGE_BASE=http://127.0.0.1:<port>/t/p. Every request is appended to the log, with
// `api_key` taken out of the query and no header values.
import http from 'node:http'
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import zlib from 'node:zlib'

const opts = {}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 2) opts[argv[i].replace(/^--/, '')] = argv[i + 1]
if (!opts.data || !opts['port-file'] || !opts.log) {
  console.error('usage: node fake-tmdb.mjs --data tmdb.json --port-file FILE --log FILE')
  process.exit(2)
}
const data = JSON.parse(readFileSync(opts.data, 'utf8'))
const movies = data.movies
const tvs = data.tv
const people = data.people
let origin = ''

const norm = (s) =>
  String(s ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')

// Exact normalized name first, then containment (both sides at least 4 characters), then the year filter.
function search(list, query, nameKeys, dateKey, year) {
  const q = norm(query)
  if (!q) return []
  const hits = []
  for (const item of list) {
    const names = nameKeys.map((k) => norm(item[k])).filter(Boolean)
    const score = names.includes(q)
      ? 2
      : q.length >= 4 && names.some((n) => n.length >= 4 && (n.includes(q) || q.includes(n)))
        ? 1
        : 0
    if (score === 0) continue
    if (year && dateKey && String(item[dateKey] ?? '').slice(0, 4) !== String(year)) continue
    hits.push({ score, item })
  }
  return hits.sort((a, b) => b.score - a.score).map((h) => h.item)
}

const movieSummary = (m) => ({
  adult: false,
  backdrop_path: m.backdrop_path,
  genre_ids: m.genres.map((g) => g.id),
  id: m.id,
  original_language: m.original_language,
  original_title: m.original_title,
  overview: m.overview,
  popularity: m.popularity,
  poster_path: m.poster_path,
  release_date: m.release_date,
  title: m.title,
  video: false,
  vote_average: m.vote_average,
  vote_count: m.vote_count,
})
const tvSummary = (t) => ({
  adult: false,
  backdrop_path: t.backdrop_path,
  genre_ids: t.genres.map((g) => g.id),
  id: t.id,
  origin_country: t.origin_country,
  original_language: t.original_language,
  original_name: t.original_name,
  overview: t.overview,
  popularity: t.popularity,
  poster_path: t.poster_path,
  first_air_date: t.first_air_date,
  name: t.name,
  vote_average: t.vote_average,
  vote_count: t.vote_count,
})
const personSummary = (p) => ({
  adult: false,
  id: p.id,
  name: p.name,
  known_for_department: p.known_for_department,
  profile_path: p.profile_path,
  popularity: p.popularity,
  known_for: [],
})
const page = (results) => ({ page: 1, results, total_pages: 1, total_results: results.length })
const byId = (list, id) => list.find((x) => String(x.id) === String(id))
const notFound = () => [404, { success: false, status_code: 34, status_message: 'The resource you requested could not be found.' }]

function searchMovies(s) {
  return search(movies, s.get('query'), ['title', 'original_title'], 'release_date', s.get('primary_release_year') ?? s.get('year'))
}
function searchTv(s) {
  return search(tvs, s.get('query'), ['name', 'original_name'], 'first_air_date', s.get('first_air_date_year') ?? s.get('year'))
}

function route(url) {
  const p = url.pathname.replace(/^\/3(?=\/)/, '')
  const s = url.searchParams
  let m
  if (p === '/configuration') {
    return [200, {
      images: {
        base_url: `${origin}/t/p/`,
        secure_base_url: `${origin}/t/p/`,
        poster_sizes: ['w92', 'w154', 'w185', 'w342', 'w500', 'w780', 'original'],
        profile_sizes: ['w45', 'w185', 'h632', 'original'],
        still_sizes: ['w92', 'w185', 'w300', 'original'],
        backdrop_sizes: ['w300', 'w780', 'w1280', 'original'],
        logo_sizes: ['w45', 'w92', 'w154', 'w185', 'w300', 'w500', 'original'],
      },
    }]
  }
  if (p === '/search/movie') return [200, page(searchMovies(s).map(movieSummary))]
  if (p === '/search/tv') return [200, page(searchTv(s).map(tvSummary))]
  if (p === '/search/multi') {
    return [200, page([
      ...searchMovies(s).map((x) => ({ ...movieSummary(x), media_type: 'movie' })),
      ...searchTv(s).map((x) => ({ ...tvSummary(x), media_type: 'tv' })),
    ])]
  }
  if (p === '/search/person') return [200, page(search(people, s.get('query'), ['name'], null, null).map(personSummary))]
  if ((m = p.match(/^\/movie\/(\d+)$/))) {
    const x = byId(movies, m[1])
    return x ? [200, x] : notFound()
  }
  if ((m = p.match(/^\/movie\/(\d+)\/credits$/))) {
    const x = byId(movies, m[1])
    return x ? [200, { id: x.id, ...x.credits }] : notFound()
  }
  if ((m = p.match(/^\/tv\/(\d+)$/))) {
    const x = byId(tvs, m[1])
    if (!x) return notFound()
    const { seasons_detail: _seasons, ...details } = x
    return [200, details]
  }
  if ((m = p.match(/^\/tv\/(\d+)\/(aggregate_credits|credits)$/))) {
    const x = byId(tvs, m[1])
    return x ? [200, { id: x.id, ...x[m[2]] }] : notFound()
  }
  if ((m = p.match(/^\/tv\/(\d+)\/season\/(\d+)$/))) {
    const season = byId(tvs, m[1])?.seasons_detail?.[String(Number(m[2]))]
    return season ? [200, season] : notFound()
  }
  if ((m = p.match(/^\/person\/(\d+)$/))) {
    const x = byId(people, m[1])
    if (!x) return notFound()
    const { combined_credits: _credits, ...person } = x
    return [200, person]
  }
  if ((m = p.match(/^\/person\/(\d+)\/(combined_credits|movie_credits|tv_credits)$/))) {
    const x = byId(people, m[1])
    if (!x) return notFound()
    const want = m[2] === 'movie_credits' ? 'movie' : m[2] === 'tv_credits' ? 'tv' : null
    const keep = (list) => (want ? list.filter((c) => c.media_type === want) : list)
    return [200, { id: x.id, cast: keep(x.combined_credits.cast), crew: keep(x.combined_credits.crew) }]
  }
  return notFound()
}

// Minimal PNG encoder: one solid colour per poster path, so the grid shows distinct tiles.
function crc32(buf) {
  let crc = 0xffffffff
  for (const byte of buf) {
    crc ^= byte
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, body) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(body.length)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([len, typed, crc])
}
function png(width, height, [r, g, b]) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = r
    row[2 + x * 3] = g
    row[3 + x * 3] = b
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const posters = new Map()
function poster(name) {
  if (!posters.has(name)) {
    let h = 0
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
    posters.set(name, png(120, 180, [40 + (h & 0x7f), 40 + ((h >> 8) & 0x7f), 40 + ((h >> 16) & 0x7f)]))
  }
  return posters.get(name)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const logged = new URL(url)
  logged.searchParams.delete('api_key')
  const auth = req.headers.authorization ? 'bearer' : url.searchParams.has('api_key') ? 'api_key' : 'none'
  appendFileSync(opts.log, `${new Date().toISOString()} ${req.method} ${logged.pathname}${logged.search} auth=${auth}\n`)
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
    return
  }
  const img = url.pathname.match(/^\/t\/p\/[^/]+\/(.+)$/)
  if (img) {
    const body = poster(img[1])
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': body.length, 'cache-control': 'max-age=3600' })
    res.end(body)
    return
  }
  const [status, body] = req.method === 'GET' ? route(url) : [405, { success: false, status_message: 'GET only' }]
  res.writeHead(status, { 'content-type': 'application/json;charset=utf-8' })
  res.end(JSON.stringify(body))
})
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address()
  origin = `http://127.0.0.1:${port}`
  writeFileSync(`${opts['port-file']}.tmp`, String(port))
  renameSync(`${opts['port-file']}.tmp`, opts['port-file'])
  console.log(`fake TMDB on ${origin}`)
})
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => process.exit(0))
```
**Check:** `D=$(mktemp -d); node .claude/skills/verify-notesd/scripts/movies/fake-tmdb.mjs --data .claude/skills/verify-notesd/scripts/movies/tmdb.json --port-file $D/p --log $D/l & sleep 1; P=$(cat $D/p); curl -s "127.0.0.1:$P/3/search/tv?query=MobLand" | jq -c '.results[0].id'` prints `247718`; `curl -s "127.0.0.1:$P/3/tv/247718/season/1" | jq '.episodes|length'` prints `3`; `curl -s -o /dev/null -w '%{content_type}' "127.0.0.1:$P/t/p/w342/fx-oldboy.jpg"` prints `image/png`; `kill %1`.
**Impact:** none on the product.

### Step 3: Fake VLC + fake curl.exe
**File:** `.claude/skills/verify-notesd/scripts/movies/fake-vlc.mjs` (new)
**Change:** One file, three modes. `vlc` is what `NOTESD_VLC_BIN` runs: records the launch, then "plays" (time = base + seconds since base, capped at 960) until told to quit, replaced on its port, or 30 min pass. `curl` is what `NOTESD_CURL_EXE` runs: finds the launch by the URL's port, exits 7 when none is alive (as `curl.exe` does once VLC exits), checks the per-launch password, applies `?command=` and prints VLC's `status.json`. `control` is what `verify.sh vlc` runs. verify.sh writes per-run wrappers that bake in node and the state dir, so the daemon's env does not matter.
**Code:**
```js
// fake-vlc.mjs: a stand-in for the Windows vlc.exe + curl.exe pair, for `verify.sh up --movies`.
//   node fake-vlc.mjs vlc     --state DIR -- <vlc args>    NOTESD_VLC_BIN: records the launch, then "plays"
//   node fake-vlc.mjs curl    --state DIR -- <curl args>   NOTESD_CURL_EXE: answers /requests/status.json
//   node fake-vlc.mjs control --state DIR args|status|commands|at SECONDS|quit
// Playback: time = base + seconds since base was set, capped at LENGTH (the fixture videos are 960 s).
// DIR/<port>.json is the live launch on that port; DIR/launches.jsonl and DIR/commands.jsonl are the record.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const LENGTH = Number(process.env.FAKE_VLC_LENGTH ?? 960)
const MAX_LIFETIME_MS = 30 * 60 * 1000
const DEFAULT_PORT = 8080

const [mode, ...rest] = process.argv.slice(2)
const stateAt = rest.indexOf('--state')
if (!mode || stateAt < 0 || !rest[stateAt + 1]) {
  console.error('usage: fake-vlc.mjs vlc|curl|control --state DIR [-- args]')
  process.exit(2)
}
const stateDir = rest[stateAt + 1]
const sep = rest.indexOf('--')
const args = sep >= 0 ? rest.slice(sep + 1) : rest.slice(stateAt + 2)
mkdirSync(stateDir, { recursive: true })

const LAUNCHES = path.join(stateDir, 'launches.jsonl')
const COMMANDS = path.join(stateDir, 'commands.jsonl')
const statePath = (port) => path.join(stateDir, `${port}.json`)
const pidPath = (port) => path.join(stateDir, `${port}.pid`)
const quitPath = (port) => path.join(stateDir, `${port}.quit`)
const now = () => Date.now()

function readState(port) {
  try {
    return JSON.parse(readFileSync(statePath(port), 'utf8'))
  } catch {
    return null
  }
}
function writeState(s) {
  const tmp = `${statePath(s.port)}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(s))
  renameSync(tmp, statePath(s.port))
}
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const currentTime = (s) => (s.state === 'playing' ? Math.min(s.length, s.base + (now() - s.baseAt) / 1000) : s.base)

function statusJson(s) {
  const time = s.state === 'stopped' ? 0 : currentTime(s)
  const filename = s.file ? s.file.split(/[\\/]/).pop() : null
  return {
    apiversion: 3,
    version: '3.0.21 Vetinari (verify fake)',
    state: s.state,
    time: Math.floor(time),
    length: s.state === 'stopped' ? 0 : s.length,
    position: s.length ? time / s.length : 0,
    fullscreen: false,
    volume: 256,
    rate: 1,
    loop: false,
    repeat: false,
    random: false,
    information: { chapter: 0, title: 0, category: { meta: { filename } } },
  }
}

function runVlc() {
  const opt = (name) => {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === `--${name}`) return args[i + 1] ?? null
      if (args[i].startsWith(`--${name}=`)) return args[i].slice(name.length + 3)
    }
    return null
  }
  const port = Number(opt('http-port') ?? DEFAULT_PORT)
  const password = opt('http-password') ?? ''
  const start = Number(opt('start-time') ?? 0) || 0
  const file = args.filter((a) => !a.startsWith('-') && /[\\/]/.test(a)).at(-1) ?? null
  appendFileSync(LAUNCHES, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, port, start_time: start, file, argv: args })}\n`)
  rmSync(quitPath(port), { force: true })
  writeState({ pid: process.pid, port, password, file, length: LENGTH, state: 'playing', base: start, baseAt: now() })
  writeFileSync(pidPath(port), String(process.pid))
  const born = now()
  const leave = () => {
    const s = readState(port)
    if (s && s.pid === process.pid) {
      rmSync(statePath(port), { force: true })
      rmSync(pidPath(port), { force: true })
    }
    rmSync(quitPath(port), { force: true })
    process.exit(0)
  }
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, leave)
  setInterval(() => {
    const s = readState(port)
    if (!s || s.pid !== process.pid) process.exit(0) // a newer launch took this port
    if (existsSync(quitPath(port)) || now() - born > MAX_LIFETIME_MS) leave()
  }, 200)
}

function applyCommand(s, params) {
  const command = params.get('command')
  if (!command) return
  const val = params.get('val')
  appendFileSync(COMMANDS, `${JSON.stringify({ at: new Date().toISOString(), port: s.port, command, val })}\n`)
  const t = currentTime(s)
  if (command === 'seek' && val != null) {
    const m = String(val).trim().match(/^([+-]?)(\d+(?:\.\d+)?)(%?)$/)
    if (!m) return
    const amount = m[3] ? (s.length * Number(m[2])) / 100 : Number(m[2])
    const target = m[1] === '+' ? t + amount : m[1] === '-' ? t - amount : amount
    s.base = Math.max(0, Math.min(s.length, target))
  } else if (command === 'pl_pause') {
    s.base = t
    s.state = s.state === 'playing' ? 'paused' : 'playing'
  } else if (command === 'pl_forcepause') {
    s.base = t
    s.state = 'paused'
  } else if (command === 'pl_play' || command === 'pl_forceresume') {
    s.base = t
    s.state = 'playing'
  } else if (command === 'pl_stop') {
    s.base = 0
    s.state = 'stopped'
  } else {
    return
  }
  s.baseAt = now()
  writeState(s)
}

function runCurl() {
  const valueFlags = new Set(['-u', '--user', '-m', '--max-time', '--connect-timeout', '-o', '--output', '-w', '--write-out',
    '-H', '--header', '-X', '--request', '-d', '--data', '--data-urlencode', '--retry', '-A', '--user-agent'])
  const shortValue = new Set(['u', 'm', 'o', 'w', 'H', 'X', 'd', 'A'])
  let url = null
  let user = null
  let fail = false
  let outFile = null
  let writeOut = null
  let get = false
  const data = []
  const take = (flag, v) => {
    if (flag === '-u' || flag === '--user') user = v
    else if (flag === '-o' || flag === '--output') outFile = v
    else if (flag === '-w' || flag === '--write-out') writeOut = v
    else if (flag === '-d' || flag === '--data' || flag === '--data-urlencode') data.push(v)
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (/^https?:\/\//i.test(a)) url = a
    else if (valueFlags.has(a)) take(a, args[++i])
    else if (a === '-f' || a === '--fail' || a === '--fail-with-body') fail = true
    else if (a === '-G' || a === '--get') get = true
    else if (/^-[A-Za-z]{2,}$/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j]
        if (c === 'f') fail = true
        else if (c === 'G') get = true
        else if (shortValue.has(c)) {
          take(`-${c}`, j === a.length - 1 ? args[++i] : a.slice(j + 1))
          break
        }
      }
    } else if (a.startsWith('-')) {
      // -s, -S, --silent, --show-error, --no-progress-meter, ...: no value, no effect here
    } else {
      console.error(`fake-curl: unexpected argument ${a}`)
      process.exit(2)
    }
  }
  if (!url) {
    console.error('fake-curl: no URL')
    process.exit(2)
  }
  const u = new URL(url)
  if (get) for (const kv of data) for (const [k, v] of new URLSearchParams(kv)) u.searchParams.append(k, v)
  const port = Number(u.port || 80)
  const s = readState(port)
  if (!s || !alive(s.pid)) {
    console.error(`curl: (7) Failed to connect to ${u.hostname} port ${port} after 0 ms: Couldn't connect to server`)
    process.exit(7)
  }
  const pass = user == null ? null : user.slice(user.indexOf(':') + 1)
  let code = 200
  let body
  if (s.password && pass !== s.password) {
    code = 401
    body = '<h1>401 Unauthorized</h1>'
  } else if (u.pathname === '/requests/status.json') {
    applyCommand(s, u.searchParams)
    body = JSON.stringify(statusJson(readState(port) ?? s))
  } else if (u.pathname === '/requests/playlist.json') {
    body = JSON.stringify({ type: 'node', name: '', children: [{ type: 'node', name: 'Playlist', children: [] }] })
  } else {
    code = 404
    body = '<h1>404 Not Found</h1>'
  }
  if (code >= 400 && fail) {
    console.error(`curl: (22) The requested URL returned error: ${code}`)
    process.exit(22)
  }
  if (outFile && outFile !== '-') {
    if (!/^(\/dev\/null|NUL)$/i.test(outFile)) writeFileSync(outFile, body)
  } else {
    process.stdout.write(body)
  }
  if (writeOut) {
    process.stdout.write(writeOut.replace(/%\{(http_code|response_code)\}/g, String(code)).replace(/\\n/g, '\n'))
  }
  process.exit(0)
}

function lastLaunch() {
  if (!existsSync(LAUNCHES)) return null
  const lines = readFileSync(LAUNCHES, 'utf8').trim().split('\n').filter(Boolean)
  return lines.length ? JSON.parse(lines.at(-1)) : null
}

async function runControl() {
  const [cmd, arg] = args
  const die = (msg) => {
    console.error(`fake-vlc: ${msg}`)
    process.exit(1)
  }
  if (cmd === 'args') {
    console.log(existsSync(LAUNCHES) ? readFileSync(LAUNCHES, 'utf8').trimEnd() : '(no launches)')
    return
  }
  if (cmd === 'commands') {
    console.log(existsSync(COMMANDS) ? readFileSync(COMMANDS, 'utf8').trimEnd() : '(no commands)')
    return
  }
  const last = lastLaunch()
  if (!last) die('VLC was never launched in this run')
  const s = readState(last.port)
  const live = s !== null && alive(s.pid)
  if (cmd === 'status') {
    console.log(JSON.stringify(live ? { live: true, pid: s.pid, file: s.file, ...statusJson(s) } : { live: false, port: last.port, file: last.file }, null, 2))
    return
  }
  if (!live) die(`no live fake VLC on port ${last.port}`)
  if (cmd === 'at') {
    const secs = Number(arg)
    if (!Number.isFinite(secs) || secs < 0) die('usage: control at SECONDS')
    s.base = Math.min(s.length, secs)
    s.baseAt = now()
    s.state = 'playing'
    writeState(s)
    console.log(`at: ${s.base}s of ${s.length}s (pid ${s.pid}, ${s.file})`)
    return
  }
  if (cmd === 'quit') {
    writeFileSync(quitPath(last.port), '')
    for (let i = 0; i < 50 && alive(s.pid); i++) await new Promise((r) => setTimeout(r, 100))
    if (alive(s.pid)) die(`pid ${s.pid} did not exit`)
    console.log(`quit: pid ${s.pid} exited (${s.file})`)
    return
  }
  die('usage: control args|status|commands|at SECONDS|quit')
}

if (mode === 'vlc') runVlc()
else if (mode === 'curl') runCurl()
else if (mode === 'control') await runControl()
else {
  console.error(`fake-vlc: unknown mode ${mode}`)
  process.exit(2)
}
```
**Check:** `D=$(mktemp -d); F=.claude/skills/verify-notesd/scripts/movies/fake-vlc.mjs; node $F vlc --state $D -- --http-port=47318 --http-password=pw --start-time=30 'C:\x\a.mkv' & sleep 1; node $F curl --state $D -- -s -u :pw 'http://127.0.0.1:47318/requests/status.json?command=seek&val=600' | jq -c '[.state,.time]'` prints `["playing",600]`; `node $F control --state $D quit` prints `quit: pid … exited`; the same curl then exits `7`.
**Impact:** none on the product.

### Step 4: Fixture VLC ini
**File:** `.claude/skills/verify-notesd/scripts/movies/vlc-qt-interface.ini` (new)
**Change:** Two `[RecentsMRL]` entries for films whose files are gone (paths under a Windows user that does not exist): The Dog Stars at 4210000 ms, Bad Apples at `-1` (opened, position unknown). The `[General]`/`[MainWindow]` keys make the parser skip real-file noise. Copied per run, never edited in place.
**Code:**
```ini
[General]
filedialog-path=@Variant(\0\0\0\x11\0\0\0\x1a\x66ile:///C:/Users/verify/Videos)
geometry=@ByteArray(\x1\xd9\xd0\xcb\0\x3\0\0)

[MainWindow]
pl-dock-status=3
playlist-visible=false

[RecentsMRL]
list=file:///C:/Users/verify/Videos/The.Dog.Stars.2026.1080p.WEB-DL.x265.6CH-Pahe.in.mkv, file:///C:/Users/verify/Downloads/Telegram%20Desktop/Bad.Apples.2025.720p.WEB-DL.x264-Pahe.in.mkv
times=4210000, -1
```
**Impact:** none.

### Step 5: verify.sh: `--movies`, pinned off by default, `vlc` subcommand, cleanup
**File:** `.claude/skills/verify-notesd/scripts/verify.sh`
**Change:**

(a) Header `:8-22` — replace the `up` lines and add the `vlc` line (the usage printer reads lines 2–27 after this):
```bash
#   verify.sh up [--web] [--embed] [--sessions] [--adversary] [--movies]
#                                       start an instance from the current checkout; prints RUN= and URL=
#                                       --sessions seeds CLAUDE_HOME from tests/fixtures/claude-home
#                                       --adversary turns the Seer reviewer on against a throwaway Seer DB
#                                       built from ${SEER_DIR:-~/seer}/db/migrations (reviews are real, billed)
#                                       --movies turns the Movies library on against a generated video tree,
#                                       a fake TMDB and a fake vlc.exe/curl.exe (scripts/movies/); else it is off
#   verify.sh doctor RUN                is this instance worth driving? (read-only)
#   verify.sh api RUN METHOD PATH [JSON]   HTTP call; request + response saved as evidence
#   verify.sh upload RUN PATH FILE [body]  multipart POST (images, files); saved as evidence
#   verify.sh mcp RUN TOOL [JSON]       MCP tool call over /mcp; saved as evidence
#   verify.sh ui RUN STEPS.mjs          drive the wall with Playwright (video + final screenshot)
#   verify.sh sql RUN "SELECT ..."      read the run's database (read-only transaction)
#   verify.sh exec RUN [--seer] "SQL"   WRITE to the run's throwaway notes DB (or its Seer DB); saved as evidence
#   verify.sh note RUN "TEXT"           append a line to the run's evidence log (what you proved)
#   verify.sh vlc RUN args|status|commands|at SECONDS|quit
#                                       drive a --movies run's fake VLC; saved as evidence
#   verify.sh down RUN|--all            stop what `up` started, drop its DB; evidence stays
#   verify.sh ls                        runs with state, pid and evidence count
```
and the dispatcher's usage line `:343` becomes `*) sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;`.

(b) `cmd_up` flag parsing `:73-82`:
```bash
  local web=0 embed=0 sessions=0 adversary=0 movies=0
  for a in "$@"; do
    case "$a" in
      --web) web=1 ;;
      --embed) embed=1 ;;
      --sessions) sessions=1 ;;
      --adversary) adversary=1 ;;
      --movies) movies=1 ;;
      *) die "up: unknown flag $a" ;;
    esac
  done
```

(c) New block right after the `--adversary` block (after `:130`, before the `# Real env wins` comment):
```bash
  # --movies: a generated library, a fake TMDB and a fake VLC pair, all under the run dir. Never the
  # owner's folders, TMDB or VLC: the live .env.local names the real roots, so the env below overrides them.
  local tmdb_port=""
  if [ "$movies" = 1 ]; then
    command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null || die "--movies: ffmpeg and ffprobe must be on PATH"
    command -v wslpath >/dev/null || echo "verify: --movies without wslpath: Play will answer player_unavailable" >&2
    "$HERE/movies/make-fixtures.sh" "$VERIFY_HOME/.movies-fixture" || die "--movies: building the fixture library failed"
    mkdir -p "$dir/movies/bin" "$dir/movies/vlc"
    cp -a "$VERIFY_HOME/.movies-fixture/library" "$dir/movies/library"
    cp "$HERE/movies/vlc-qt-interface.ini" "$dir/movies/vlc-qt-interface.ini"
    local node_bin
    node_bin="$(command -v node)"
    printf '#!/bin/sh\nexec "%s" "%s" vlc --state "%s" -- "$@"\n' "$node_bin" "$HERE/movies/fake-vlc.mjs" "$dir/movies/vlc" >"$dir/movies/bin/vlc.exe"
    printf '#!/bin/sh\nexec "%s" "%s" curl --state "%s" -- "$@"\n' "$node_bin" "$HERE/movies/fake-vlc.mjs" "$dir/movies/vlc" >"$dir/movies/bin/curl.exe"
    chmod +x "$dir/movies/bin/vlc.exe" "$dir/movies/bin/curl.exe"
    setsid node "$HERE/movies/fake-tmdb.mjs" --data "$HERE/movies/tmdb.json" \
      --port-file "$dir/movies/tmdb.port" --log "$dir/movies/tmdb.log" </dev/null >"$dir/movies/tmdb.out" 2>&1 &
    echo $! >"$dir/tmdb.pid"
    for _ in $(seq 1 40); do [ -s "$dir/movies/tmdb.port" ] && break; sleep 0.25; done
    [ -s "$dir/movies/tmdb.port" ] || die "--movies: the fake TMDB did not start (log: $dir/movies/tmdb.out; verify.sh down $run)"
    tmdb_port="$(cat "$dir/movies/tmdb.port")"
  fi
```

(d) Env `:135-148` — append after the adversary `if … fi`:
```bash
  # NOTESD_MOVIES=off unless --movies: a throwaway daemon never scans the owner's video folders,
  # calls TMDB or starts VLC. --movies points every path and binary at the run's own fakes; the
  # filename fallback is pinned off so nothing is billed.
  if [ "$movies" = 1 ]; then
    env+=(
      NOTESD_MOVIES=on
      "NOTESD_MOVIES_ROOTS=$dir/movies/library/Videos:$dir/movies/library/Telegram Desktop"
      NOTESD_MOVIES_DONE_DIRS=Done
      NOTESD_MOVIES_SCAN_MS=3600000
      NOTESD_MOVIES_MIN_SECONDS=900
      NOTESD_MOVIES_FALLBACK_MODEL=off
      TMDB_API_READ_ACCESS_TOKEN=verify-fake-token
      TMDB_API_KEY=
      "TMDB_API_BASE=http://127.0.0.1:$tmdb_port/3"
      "TMDB_IMAGE_BASE=http://127.0.0.1:$tmdb_port/t/p"
      "NOTESD_FFPROBE_BIN=$(command -v ffprobe)"
      "NOTESD_VLC_BIN=$dir/movies/bin/vlc.exe"
      "NOTESD_CURL_EXE=$dir/movies/bin/curl.exe"
      "NOTESD_VLC_INI=$dir/movies/vlc-qt-interface.ini"
      NOTESD_VLC_HTTP_PORT=47318
      NOTESD_VLC_POLL_MS=1000
      # Phase 9: never sample the owner's real vlc.exe into verify evidence; no launch flags from .env.local.
      NOTESD_VLC_HEALTH_MS=0
      NOTESD_VLC_EXTRA_ARGS=
    )
  else
    env+=(NOTESD_MOVIES=off)
  fi
```

(e) Meta block `:149-156` — add after `echo "adversary=$adversary"`:
```bash
    echo "movies=$movies"
```

(f) Output `:173-176` — after `echo "LOG=$dir/daemon.log"`:
```bash
  if [ "$movies" = 1 ]; then echo "MOVIES=$dir/movies"; fi
```

(g) `cmd_doctor` — after the `database` line (`:197`):
```bash
  if [ -f "$dir/tmdb.pid" ]; then
    if kill -0 "$(cat "$dir/tmdb.pid")" 2>/dev/null && curl -fsS -m 3 "http://127.0.0.1:$(cat "$dir/movies/tmdb.port")/health" >/dev/null; then
      echo "tmdb     ok   fake TMDB on :$(cat "$dir/movies/tmdb.port")"
    else
      echo "tmdb     FAIL fake TMDB is not answering"; ok=0
    fi
  fi
```

(h) New function, after `cmd_note` (`:291`):
```bash
cmd_vlc() {
  local dir out
  dir="$(run_dir "${1:-}")"; shift
  [ -d "$dir/movies/vlc" ] || die "vlc: this run was not started with --movies"
  out="$(next_evidence "$dir" vlc "${*:-args}" txt)"
  node "$HERE/movies/fake-vlc.mjs" control --state "$dir/movies/vlc" "$@" | tee "$out"
  echo "[evidence: $out]" >&2
}
```

(i) `stop_run` `:293-310` — whole function:
```bash
stop_run() {
  local dir=$1 pid f
  pid="$(cat "$dir/pid" 2>/dev/null || true)"
  # setsid made the daemon a process-group leader: kill exactly the group `up` started.
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -KILL -- "-$pid" 2>/dev/null || true
  fi
  # --movies: the fake VLCs were started detached by the daemon, the fake TMDB by `up`; keep their records.
  if [ -d "$dir/movies" ]; then
    for f in "$dir"/movies/vlc/*.pid; do
      if [ -f "$f" ]; then kill -TERM "$(cat "$f")" 2>/dev/null || true; fi
    done
    if [ -f "$dir/movies/tmdb.log" ]; then cp "$dir/movies/tmdb.log" "$dir/evidence/movies-tmdb-requests.log"; fi
    if [ -f "$dir/movies/vlc/launches.jsonl" ]; then cp "$dir/movies/vlc/launches.jsonl" "$dir/evidence/movies-vlc-launches.jsonl"; fi
    if [ -f "$dir/movies/vlc/commands.jsonl" ]; then cp "$dir/movies/vlc/commands.jsonl" "$dir/evidence/movies-vlc-commands.jsonl"; fi
  fi
  if [ -f "$dir/tmdb.pid" ]; then
    kill -TERM -- "-$(cat "$dir/tmdb.pid")" 2>/dev/null || kill -TERM "$(cat "$dir/tmdb.pid")" 2>/dev/null || true
  fi
  if [ -f "$dir/db" ] && docker inspect "$PG_CONTAINER" >/dev/null 2>&1; then
    psql_run -c "drop database if exists $(cat "$dir/db") with (force)" >/dev/null || true
  fi
  if [ -f "$dir/seer_db" ] && docker inspect "$PG_CONTAINER" >/dev/null 2>&1; then
    psql_run -c "drop database if exists $(cat "$dir/seer_db") with (force)" >/dev/null || true
  fi
  rm -rf "$dir/data" "$dir/claude" "$dir/worktrees" "$dir/seer" "$dir/movies" "$dir/pid" "$dir/port" "$dir/db" "$dir/seer_db" "$dir/tmdb.pid"
  echo "verify: stopped $(basename "$dir"); evidence kept in $dir/evidence ($(find "$dir/evidence" -type f | wc -l) files)"
}
```

(j) Dispatcher `:330-344` — add `vlc) cmd_vlc "$@" ;;` after `note) cmd_note "$@" ;;`.

**Check:** `bash -n .claude/skills/verify-notesd/scripts/verify.sh`; `$V` (no args) prints the usage with `--movies` and `vlc`, not `set -euo pipefail`.
**Impact:** every `verify.sh up` daemon now runs with `NOTESD_MOVIES=off` (it would otherwise scan whatever roots the checkout's `.env.local` names once Step 10 lands). `--adversary`, `--sessions`, `--web`, `--embed` behave as before. The fixture cache under `$VERIFY_HOME/.movies-fixture` is a dot-dir, so `ls` and `down --all` skip it.

### Step 6: The whole-chain journey and its wall steps
**Files:** `.claude/skills/verify-notesd/scripts/movies/journey.sh` (new, `chmod +x`), `.claude/skills/verify-notesd/scripts/movies/ui-library.mjs` (new)
**Change:** One script the feature map, the verifier and later changes rerun. It reads state through HTTP, MCP and read-only SQL against the contract's tables. Response shapes the contract does not fix are read with recursive `jq` (`.. | objects | select(…)`), so a nested or flat wire view both pass. It makes no model call: every long fixture matches TMDB exactly, the short clip never reaches TMDB, the fallback is pinned off and the chat bar is not driven.
**Code (`journey.sh`):**
```bash
#!/usr/bin/env bash
# journey.sh RUN [--no-ui]: the Movies feature map's whole chain on a `verify.sh up --web --movies` run.
# Each stage drives a real surface (HTTP, MCP, the fake VLC, the wall), checks the end state through
# HTTP, MCP or the run's database (read-only), and logs it to the run's evidence LOG.md. The first
# failed check stops it with `journey: FAIL at <stage>`. No model call. Run from the checkout under test.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V="$HERE/../verify.sh"
VERIFY_HOME="${VERIFY_HOME:-$HOME/.local/state/notesd-verify}"
RUN=${1:?usage: journey.sh RUN [--no-ui]}
UI=1
if [ "${2:-}" = --no-ui ]; then UI=0; fi
DIR="$VERIFY_HOME/$RUN"
[ -d "$DIR/movies/library" ] || { echo "journey: $RUN was not started with --movies" >&2; exit 2; }
DB="$(cat "$DIR/db")"
LIB="$DIR/movies/library"
LAUNCHES="$DIR/movies/vlc/launches.jsonl"
COMMANDS="$DIR/movies/vlc/commands.jsonl"
IMG_BASE="http://127.0.0.1:$(cat "$DIR/movies/tmdb.port")/t/p/"
SERIES="$LIB/Videos/Mobland S01 WEB-DL 1080p x265 6CH [Pahe.in]"
E01_NAME='MobLand.S01E01.Stick.or.Twist.1080p.WEB-DL.x265.6CH-Pahe.in.mkv'
E02_NAME='MobLand.S01E02.Eye.for.an.Eye.1080p.WEB-DL.x265.6CH-Pahe.in.mkv'
E03_NAME='MobLand.S01E03.Lie.Down.with.Dogs.1080p.WEB-DL.x265.6CH-Pahe.in.mkv'
STAGE=start
STAGES=0
CODE=""
BODY=""
MCP=""

stage() { STAGE=$1; STAGES=$((STAGES + 1)); echo "== $STAGE"; }
ok() { echo "   ok  $*"; "$V" note "$RUN" "movies journey $STAGE: $*"; }
fail() {
  echo "journey: FAIL at $STAGE: $*" >&2
  "$V" note "$RUN" "movies journey FAIL at $STAGE: $*" || true
  exit 1
}
# q SQL: the query's value(s) from the run's database, in a read-only transaction.
q() {
  printf 'begin read only;\n%s;\nrollback;\n' "$1" \
    | docker exec -i mcp-notes-pg-verify psql -X -q -tA -v ON_ERROR_STOP=1 -U postgres -d "$DB" \
    | sed '/^BEGIN$/d;/^ROLLBACK$/d'
}
# wait_q SQL WANT [SECONDS]: poll until the query prints WANT.
wait_q() {
  local sql=$1 want=$2 secs=${3:-30} got="" i
  for ((i = 0; i < secs * 2; i++)); do
    got="$(q "$sql")"
    if [ "$got" = "$want" ]; then return 0; fi
    sleep 0.5
  done
  fail "waited ${secs}s for [$sql] = [$want], last [$got]"
}
# api METHOD PATH [JSON]: through verify.sh (evidence saved); sets CODE and BODY.
api() {
  local out
  out="$("$V" api "$RUN" "$@" 2>/dev/null)"
  CODE="$(sed -n 's/^< HTTP \([0-9]*\).*/\1/p' <<<"$out" | head -1)"
  BODY="$(sed '1,/^< HTTP /d' <<<"$out")"
}
need_2xx() { [[ $CODE == 2* ]] || fail "$1 answered HTTP $CODE: $BODY"; }
# sync_until SQL WANT: ask for a library pass every 10 s until the query prints WANT (2 min at most).
sync_until() {
  local sql=$1 want=$2 got="" i j
  for ((i = 0; i < 12; i++)); do
    api POST /api/movies/sync
    for ((j = 0; j < 20; j++)); do
      got="$(q "$sql")"
      if [ "$got" = "$want" ]; then return 0; fi
      sleep 0.5
    done
  done
  fail "after 12 passes [$sql] = [$got], wanted [$want]"
}
# mcp TOOL JSON: through verify.sh (evidence saved); sets MCP to the tool's JSON text.
mcp() {
  local out
  out="$("$V" mcp "$RUN" "$@" 2>/dev/null || true)"
  MCP="$(sed '1d' <<<"$out")"
}
jqb() { jq -e "$@" >/dev/null 2>&1; }
fid() { q "select id from movie_files where name = '$1' order by id desc limit 1"; }
launches() { if [ -f "$LAUNCHES" ]; then wc -l <"$LAUNCHES"; else echo 0; fi; }
# wait_launch NAME_PART COUNT_BEFORE: a new fake VLC launch whose file contains NAME_PART.
wait_launch() {
  local i
  for ((i = 0; i < 40; i++)); do
    if [ "$(launches)" -gt "$2" ] && tail -1 "$LAUNCHES" | jqb --arg w "$1" '(.file // "") | contains($w)'; then return 0; fi
    sleep 0.5
  done
  fail "no fake VLC launch on $1"
}
vlc() { "$V" vlc "$RUN" "$@" >/dev/null 2>&1 || fail "verify.sh vlc $*"; }
# expect_state TITLE_ID FILE_ID STATE: the title's detail reports that state for that file.
expect_state() {
  local got
  api GET "/api/movies/$1"
  need_2xx "GET /api/movies/$1"
  got="$(jq -r --arg id "$2" '[.. | objects | select(has("state") and (((.file_id // .id) | tostring) == $id)) | .state][0] // "none"' <<<"$BODY")"
  [ "$got" = "$3" ] || fail "file $2 of $1 is $got, wanted $3"
  ok "file $2 of $1 is $3"
}
in_range() { [ -n "$1" ] && [ "$1" != null ] && awk -v v="$1" 'BEGIN { exit !(v + 0 >= 295 && v + 0 <= 320) }'; }

"$V" doctor "$RUN" >/dev/null || fail "verify.sh doctor $RUN failed"

stage "1 sync: the generated tree becomes a library"
sync_until "select count(*) from movie_files where deleted_at is null and status = 'matched'" 6
ok "6 present files matched (dots, underscores in Done, year in folder, 3 episodes)"
[ "$(q "select status || ':' || coalesce(reason, '') from movie_files where name like 'WhatsApp Video%'")" = "unmatched:too_short" ] \
  || fail "the 20 s clip is not unmatched:too_short"
ok "the 20 s clip under Done/docker_es is unmatched:too_short"
[ "$(q "select count(*) from movie_files where title_id = 'tv-247718' and season = 1 and episode in (1, 2, 3) and deleted_at is null")" = 3 ] \
  || fail "the MobLand files are not one title with season and episode"
[ "$(q "select count(*) from movie_episodes where title_id = 'tv-247718' and season = 1")" = 3 ] || fail "MobLand episode titles missing"
ok "the season folder is one title tv-247718: S01E01-E03 files and 3 episode rows"
[ "$(q "select count(*) from movie_title_companies tc join movie_companies c on c.id = tc.company_id where tc.title_id = 'movie-990001' and c.name = 'Blumhouse Productions'")" = 1 ] \
  || fail "studio row missing"
[ "$(q "select count(*) from movie_credits where title_id = 'movie-467905' and role = 'cast' and character is not null")" -ge 2 ] || fail "cast with characters missing"
[ "$(q "select count(*) from movie_credits where title_id = 'movie-467905' and role = 'director'")" -ge 1 ] || fail "director missing"
ok "studios, cast with characters and directors stored"
[ "$(q "select count(*) from movie_files where name like 'The_Rivals_of_Amziah_King%' and done_at is not null")" = 1 ] || fail "file found in Done has no done signal"
ok "the film found inside Done has a done signal"
wait_q "select (count(*) >= 2)::text from movie_plays p join movie_files f on f.id = p.file_id where p.source = 'vlc_recents' and f.deleted_at is not null and f.title_id in ('movie-990002', 'movie-990003')" true 60
[ "$(q "select max(p.position_s)::int from movie_plays p join movie_files f on f.id = p.file_id where f.title_id = 'movie-990002' and p.source = 'vlc_recents'")" = 4210 ] \
  || fail "The Dog Stars recents position is not 4210 s"
ok "VLC recents: two gone films became deleted files with observations (The Dog Stars at 4210 s)"
grep -q ' GET /3/' "$DIR/movies/tmdb.log" || fail "the fake TMDB saw no request"
ok "metadata came from the fake TMDB ($(grep -c ' GET /3/' "$DIR/movies/tmdb.log") requests)"

stage "2 posters: every title has a poster URL that loads without the files"
api GET /api/movies
need_2xx "GET /api/movies"
n="$(jq --arg b "$IMG_BASE" '[.. | objects | .poster_url? | select(type == "string" and startswith($b))] | length' <<<"$BODY")"
[ "$n" -ge 4 ] || fail "only $n poster_url values point at the image base: $BODY"
poster="$(jq -r --arg b "$IMG_BASE" '[.. | objects | .poster_url? | select(type == "string" and startswith($b))][0]' <<<"$BODY")"
[ "$(curl -s -o /dev/null -w '%{http_code} %{content_type}' "$poster")" = "200 image/png" ] || fail "poster $poster does not load"
ok "$n titles carry a poster_url on the image base; $poster loads as image/png"

stage "3 user state: watched, stars and a review note"
api POST /api/movies/movie-467905/user '{"watched":true,"rating":4,"review":"Verify review: tight, mean and funny."}'
need_2xx "POST /api/movies/movie-467905/user"
[ "$(q "select rating || ' ' || (watched_at is not null)::text from movie_titles where id = 'movie-467905'")" = "4 true" ] || fail "rating/watched not stored"
[ "$(q "select count(*) from notes n join movie_titles t on t.review_note_id = n.id where t.id = 'movie-467905' and n.body like '%Verify review: tight, mean and funny.%' and 'movie' = any(n.tags) and n.deleted_at is null")" = 1 ] \
  || fail "the review is not a live #movie note linked to the title"
ok "rating 4 and watched stored; review is note $(q "select review_note_id from movie_titles where id = 'movie-467905'") tagged #movie"

stage "4 play: Play starts VLC from the start, polls progress, exit closes the play"
E01="$(fid "$E01_NAME")"
n="$(launches)"
api POST "/api/movies/files/$E01/play" '{}'
need_2xx "POST play S01E01"
wait_launch "S01E01" "$n"
start="$(tail -1 "$LAUNCHES" | jq -r '.start_time')"
[ "${start%.*}" -le 1 ] || fail "S01E01 started at $start s, wanted the start"
ok "fake vlc.exe launched on $(tail -1 "$LAUNCHES" | jq -r .file) at ${start}s"
wait_q "select count(*) from movie_plays where file_id = $E01 and source = 'live' and ended_at is null" 1 20
vlc at 912
wait_q "select (coalesce(max(position_s), 0) >= 900)::text from movie_plays where file_id = $E01 and source = 'live'" true 20
ok "position polled into the open play event (>= 900 of 960 s)"
vlc quit
wait_q "select count(*) from movie_plays where file_id = $E01 and source = 'live' and ended_at is not null and position_s >= 900" 1 30
ok "VLC exit closed the play event at its last position"
expect_state tv-247718 "$E01" finished

stage "5 continue MobLand: the next present episode starts"
n="$(launches)"
mcp movies_continue '{"title":"MobLand"}'
jqb '.action == "started"' <<<"$MCP" || fail "movies_continue {title: MobLand}: $MCP"
wait_launch "S01E02" "$n"
E02="$(fid "$E02_NAME")"
ok "movies_continue started S01E02"
wait_q "select count(*) from movie_plays where file_id = $E02 and source = 'live' and ended_at is null" 1 20
vlc at 300
wait_q "select (coalesce(max(position_s), 0) >= 300)::text from movie_plays where file_id = $E02 and source = 'live'" true 20
vlc quit
wait_q "select count(*) from movie_plays where file_id = $E02 and source = 'live' and ended_at is null" 0 30
expect_state tv-247718 "$E02" in_progress

stage "6 continue (no title): the newest play resumes where it stopped"
n="$(launches)"
mcp movies_continue '{}'
jqb '.action == "resumed"' <<<"$MCP" || fail "movies_continue {}: $MCP"
wait_launch "S01E02" "$n"
launched_at="$(tail -1 "$LAUNCHES" | jq -r '.at')"
start="$(tail -1 "$LAUNCHES" | jq -r '.start_time')"
seek=""
sleep 3
if [ -f "$COMMANDS" ]; then
  seek="$(jq -r --arg t "$launched_at" 'select(.command == "seek" and .at >= $t) | .val' "$COMMANDS" | tail -1)"
fi
in_range "$start" || in_range "$seek" || fail "resumed at start-time $start / seek ${seek:-none}, wanted about 300 s"
ok "VLC resumed S01E02 at about 300 s (start-time $start, seek ${seek:-none})"
vlc quit
wait_q "select count(*) from movie_plays where file_id = $E02 and source = 'live' and ended_at is null" 0 30

stage "7 delete and move: a deleted episode keeps its row, a moved film is not deleted"
E03="$(fid "$E03_NAME")"
OLD="$(fid 'Oldboy.mkv')"
rm "$SERIES/$E03_NAME"
mv "$LIB/Telegram Desktop/Oldboy (2003)" "$LIB/Videos/Done/"
sync_until "select count(*) from movie_files where id = $E03 and deleted_at is not null" 1
ok "S01E03 file marked deleted"
sync_until "select count(*) from movie_files where id = $OLD and deleted_at is null and done_at is not null and path like '%/Videos/Done/Oldboy (2003)/Oldboy.mkv'" 1
ok "Oldboy moved Telegram Desktop -> Videos/Done: same row, new path, done signal, not deleted"
[ "$(q "select count(*) from movie_titles where id = 'tv-247718'")" = 1 ] || fail "the title went with its file"
expect_state tv-247718 "$E03" removed_unwatched
expect_state movie-990004 "$OLD" finished

stage "8 continue MobLand again: the next episode is missing"
api POST "/api/movies/files/$E02/watched" '{"watched":true}'
need_2xx "POST watched S01E02"
expect_state tv-247718 "$E02" finished
n="$(launches)"
mcp movies_continue '{"title":"MobLand"}'
jqb '.action == "missing" and ((.missing | tostring) | test("\"episode\":3|S01E03"))' <<<"$MCP" || fail "movies_continue: $MCP"
sleep 2
[ "$(launches)" = "$n" ] || fail "movies_continue started VLC although the episode is missing"
ok "movies_continue answers missing S01E03 and starts nothing"

stage "9 another machine's file: available false, play refused"
"$V" exec "$RUN" "insert into movie_files (title_id, host, path, name, size, duration_s, status, source, first_seen_at, last_seen_at, updated_at) values ('movie-467905', 'verify-other-host', '/mnt/c/Users/other/Videos/How.to.Make.a.Killing.2026.mkv', 'How.to.Make.a.Killing.2026.mkv', 1234, 960, 'matched', 'scan', now(), now(), now())" >/dev/null 2>&1 \
  || fail "seeding the other host's file failed"
OTHER="$(q "select id from movie_files where host = 'verify-other-host'")"
api GET /api/movies/movie-467905
need_2xx "GET /api/movies/movie-467905"
jqb --arg id "$OTHER" '[.. | objects | select(((.file_id // .id) | tostring) == $id) | .available][0] == false' <<<"$BODY" \
  || fail "file $OTHER is not available:false: $BODY"
n="$(launches)"
api POST "/api/movies/files/$OTHER/play" '{}'
{ [[ $CODE == 4* ]] && grep -q not_on_this_machine <<<"$BODY"; } || fail "play of another host's file answered $CODE $BODY"
[ "$(launches)" = "$n" ] || fail "VLC started for another host's file"
ok "the other host's file is available:false; play answers $CODE not_on_this_machine"

stage "10 unmatched: the clip is listed with its reason; assigning moves it into the library"
JUNK="$(q "select id from movie_files where name like 'WhatsApp Video%' and deleted_at is null")"
api GET /api/movies/unmatched
need_2xx "GET /api/movies/unmatched"
jqb --arg id "$JUNK" '[.. | objects | select(((.file_id // .id) | tostring) == $id and .reason == "too_short")] | length == 1' <<<"$BODY" \
  || fail "clip $JUNK is not listed as too_short: $BODY"
api POST "/api/movies/files/$JUNK/assign" '{"kind":"movie","tmdb_id":990003}'
need_2xx "POST assign"
wait_q "select status || ' ' || coalesce(title_id, '') from movie_files where id = $JUNK" "matched movie-990003" 10
api GET /api/movies/unmatched
jqb --arg id "$JUNK" '[.. | objects | select(((.file_id // .id) | tostring) == $id)] | length == 0' <<<"$BODY" || fail "the clip is still unmatched: $BODY"
ok "clip $JUNK assigned to movie-990003 and gone from the unmatched list"

stage "11 MCP reads: person, company, history, one title"
mcp movies_person '{"name":"Margaret Qualley"}'
jqb '([.. | objects | select((.tmdb_id // .id) == 467905 or .title_id? == "movie-467905") | .seen][0] == true)
     and ([.. | objects | select((.tmdb_id // .id) == 990201 or .title_id? == "movie-990201") | .seen][0] == false)' <<<"$MCP" \
  || fail "movies_person: $MCP"
ok "movies_person marks How to Make a Killing seen and Kinds of Kindness not seen"
mcp movies_list '{"company":"Blumhouse"}'
jqb 'tostring | test("movie-990001")' <<<"$MCP" || fail "movies_list {company: Blumhouse}: $MCP"
ok "movies_list by company finds the Blumhouse film"
mcp movies_history '{"title":"MobLand"}'
jqb 'tostring | test("Eye for an Eye|\"episode\":2")' <<<"$MCP" || fail "movies_history: $MCP"
ok "movies_history lists the S01E02 plays"
mcp movies_get '{"title":"tv-247718"}'
jqb --arg id "$E03" '[.. | objects | select(((.file_id // .id) | tostring) == $id)] | length >= 1' <<<"$MCP" || fail "movies_get lacks the deleted S01E03 file: $MCP"
ok "movies_get returns the series with its deleted file"

if [ "$UI" = 1 ]; then
  stage "12 wall: poster grid, then the MobLand page with its deleted episode"
  "$V" ui "$RUN" "$HERE/ui-library.mjs" >/dev/null 2>&1 || fail "the wall drive failed; read the newest *-ui-ui-library.txt in $DIR/evidence"
  ok "grid of loaded posters; MobLand page with episodes, cast and characters, one deleted flag"
fi

"$V" vlc "$RUN" args >/dev/null 2>&1 || true
echo "journey: PASS ($STAGES stages)"
"$V" note "$RUN" "movies journey PASS ($STAGES stages)"
```
**Code (`ui-library.mjs`):**
```js
// ui-library.mjs: journey.sh stage 12, run by `verify.sh ui RUN`. Grid of loaded TMDB posters,
// then the MobLand page. Expects journey stages 1-8 first (S01E01/E02 finished, S01E03 deleted).
export default async ({ page, base, shot, log }) => {
  await page.goto(base + '/')
  await page.getByRole('button', { name: 'Movies' }).first().click()
  await page.waitForURL((url) => url.pathname === '/movies')
  await page.locator('img[src*="/t/p/"]').first().waitFor()
  await page.waitForFunction(
    () => {
      const imgs = [...document.querySelectorAll('img[src*="/t/p/"]')]
      return imgs.length >= 4 && imgs.every((img) => img.complete && img.naturalWidth > 0)
    },
    null,
    { timeout: 15000 },
  )
  log(`grid: ${await page.locator('img[src*="/t/p/"]').count()} posters, all loaded`)
  await shot('grid')

  await page.getByRole('img', { name: 'MobLand' }).first().click()
  await page.waitForURL((url) => url.pathname === '/movies/tv-247718')
  for (const text of ['Stick or Twist', 'Eye for an Eye', 'Lie Down with Dogs', 'Tom Hardy', 'Harry Da Souza']) {
    await page.getByText(text).first().waitFor()
  }
  log('detail: three episodes, cast with character')
  const deleted = page.locator('[data-testid="movie-file"][data-deleted="true"]')
  const count = await deleted.count()
  if (count !== 1) throw new Error(`expected exactly one deleted episode row, found ${count}`)
  const row = (await deleted.first().innerText()).replace(/\s+/g, ' ')
  if (!/Lie Down with Dogs|E0?3\b/.test(row)) throw new Error(`the deleted row is not S01E03: "${row}"`)
  log(`deleted flag on: ${row.slice(0, 80)}`)
  await shot('detail')
}
```
**Impact:** none on the product. If a journey fails because a phase's real shape differs from what the contract and Handoffs state, the fix is a reconcile of the journey's selector, not of the product — unless the behavior is wrong (then it is a product bug).

### Step 7: Docs coverage check
**File:** `.claude/skills/verify-notesd/scripts/movies/doc-check.sh` (new, `chmod +x`)
**Change:** Reads the env vars, routes and tools from the landed code and checks both directions against the docs, so README/CLAUDE drift is a failing command, not a review comment.
**Code:**
```bash
#!/usr/bin/env bash
# doc-check.sh: README.md, CLAUDE.md and the feature map name every Movies env var, HTTP route and
# MCP tool the code has, and README names none the code lacks. Prints one OK line or the gaps.
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$ROOT"
FEAT=.claude/skills/verify-notesd/features
ENV_RE='NOTESD_MOVIES[A-Z_]*|NOTESD_VLC_[A-Z_]+|NOTESD_CURL_EXE|NOTESD_FFPROBE_BIN|NOTESD_TASKLIST_EXE|NOTESD_POWERSHELL_EXE|TMDB_[A-Z_]+'
# Where the movies env vars are read: src/config.ts, plus phase 9's two probe-read overrides in the health monitor.
ENV_SOURCES='src/config.ts src/movies/vlc/health.ts'
bad=0
miss() { echo "doc-check: $*" >&2; bad=1; }

# 1. Env vars the movies config reads <-> README Configuration rows.
# shellcheck disable=SC2086
mapfile -t vars < <(grep -ohE "\\b($ENV_RE)\\b" $ENV_SOURCES | sort -u)
[ "${#vars[@]}" -ge 20 ] || miss "$ENV_SOURCES read only ${#vars[@]} movie env vars (${vars[*]:-none})"
for v in "${vars[@]}"; do
  grep -qE '^\| `'"$v"'`' README.md || miss "README Configuration has no row for $v"
done
mapfile -t doc_vars < <(grep -oE '^\| `('"$ENV_RE"')`' README.md | tr -d '|` ' | sort -u)
for v in "${doc_vars[@]}"; do
  printf '%s\n' "${vars[@]}" | grep -qx "$v" || miss "README documents $v, which $ENV_SOURCES do not read"
done

# 2. /api/movies paths <-> README HTTP API rows ("| `GET /api/movies/:id` |", query string allowed). The paths are
#    every '/api/movies…' string literal in the movie routers (phase 4 keeps some in *_PATH constants such as
#    '/api/movies/:id{[a-z]+-[0-9]+}'), with Hono's `{regex}` param constraints stripped. Methods are not compared.
mapfile -t routes < <(cat src/http/moviesApi.ts src/http/moviesPlayApi.ts \
  | grep -oE "['\"\`]/api/movies[^'\"\`]*" | cut -c2- | sed -E 's/\{[^}]*\}//g' | sort -u)
[ "${#routes[@]}" -ge 10 ] || miss "found only ${#routes[@]} /api/movies paths in src/http/movies*Api.ts"
for p in "${routes[@]}"; do
  grep -qE '^\| `(GET|POST|PUT|PATCH|DELETE) '"$p"'(\?[^`]*)?`' README.md || miss "README HTTP API has no row for $p"
done
mapfile -t doc_routes < <(grep -oE '^\| `(GET|POST|PUT|PATCH|DELETE) /api/movies[^`?]*' README.md | sed -E 's/^\| `[A-Z]+ //' | sort -u)
for p in "${doc_routes[@]}"; do
  printf '%s\n' "${routes[@]}" | grep -qxF "$p" || miss "README documents $p, which no movies router serves"
done

# 3. Registered movies_* MCP tools <-> README MCP tool rows.
mapfile -t tools < <(tr '\n' ' ' <src/mcp/movieTools.ts | grep -oE "registerTool\(\s*['\"]movies_[a-z_]+" | grep -oE 'movies_[a-z_]+' | sort -u)
[ "${#tools[@]}" -ge 6 ] || miss "found only ${#tools[@]} movies_* tools registered in src/mcp/movieTools.ts"
for t in "${tools[@]}"; do
  grep -qE '^\| `'"$t"'`' README.md || miss "README MCP tools has no row for $t"
done
mapfile -t doc_tools < <(grep -oE '^\| `movies_[a-z_]+`' README.md | tr -d '|` ' | sort -u)
for t in "${doc_tools[@]}"; do
  printf '%s\n' "${tools[@]}" | grep -qx "$t" || miss "README documents tool $t, which src/mcp/movieTools.ts does not register"
done

# 4. Tour section, CLAUDE.md bullet, feature map entry.
grep -qE '^## Movies$' README.md || miss "README has no '## Movies' section"
grep -qF '](#movies)' README.md || miss "README Contents does not link #movies"
line="$(grep -E '^- \*\*Movies\*\*' CLAUDE.md || true)"
[ -n "$line" ] || miss "CLAUDE.md has no '- **Movies**' architecture bullet"
for s in src/movies/repo.ts NOTESD_MOVIES src/http/moviesApi.ts src/mcp/movieTools.ts /movies curl.exe verify.sh; do
  grep -qF -- "$s" <<<"$line" || miss "CLAUDE.md's Movies bullet does not mention $s"
done
for h in '## Sub-features' '## How to get to it (user POV)' '## Driving it with verify.sh' '## Gotchas'; do
  grep -qxF -- "$h" "$FEAT/movies.md" || miss "features/movies.md lacks '$h'"
done
grep -qF '[movies.md](movies.md)' "$FEAT/README.md" || miss "features/README.md has no movies.md row"

if [ "$bad" != 0 ]; then echo "doc-check: FAIL" >&2; exit 1; fi
echo "doc-check: OK (${#vars[@]} env vars, ${#routes[@]} routes, ${#tools[@]} tools)"
```
**Check:** before Steps 8–9 it exits 1 listing the missing README/CLAUDE/feature-map items (proves it can fail); after them it prints `doc-check: OK (…)`.
**Impact:** none on the product.

### Step 8: Feature map entry, its index row, and the skill page
**Files:** `.claude/skills/verify-notesd/features/movies.md` (new), `.claude/skills/verify-notesd/features/README.md` (`:18`), `.claude/skills/verify-notesd/SKILL.md` (`:21-26`, `:38`, `:61`, `:133`)
**Change:** The user-facing feature map for Movies, in the four standard sections; the index row; the skill page learns `--movies`, the pin and `vlc`.
**Code (`features/movies.md`):**
````markdown
# Movies

## Sub-features
- VLC health (phase 9). Every `NOTESD_VLC_HEALTH_MS` (default 30 s; off at 0 or with no roots) each
  `vlc.exe` on this host is sampled through `tasklist.exe` / `powershell.exe` into
  `<dataDir>/movies/vlc-health-<host>.jsonl` (fsync'd lines: start, sample, idle, hang, clean_stop,
  incident). An unclean stop while sampling gives one incident on the next start with the Windows
  fault events around the last sample; a notesd VLC that stops answering while its process lives
  gets a hang line and its play stays open. `GET /api/movies/player/health` returns it. Proof:
  `npm run test:int -- tests/integration/movies.health.int.test.ts tests/integration/movies.healthCrash.int.test.ts`
  (fake Windows side `tests/fixtures/movies/fake-windows.mjs`; the crash test needs WSL interop and
  is `inconclusive` elsewhere). `verify.sh up --movies` pins it off.
- Library sync. A background pass every `NOTESD_MOVIES_SCAN_MS` (and `POST /api/movies/sync`) walks
  `NOTESD_MOVIES_ROOTS` recursively for mkv, mp4, avi, m4v and webm. `ffprobe` drops anything under
  `NOTESD_MOVIES_MIN_SECONDS` as `too_short`; the rest is parsed from its path (Pahe dots, Pahe
  underscores, year only in the folder, SxxEyy in a season folder, absolute numbering, two films in
  one folder) and looked up on TMDB, with a Haiku fallback for unclear names. No match goes to the
  hidden unmatched list with a reason (`no_match`, `low_confidence`, `tmdb_error`,
  `no_tmdb_credentials`, `probe_failed`). TMDB unreachable: files stay `pending` and retry next pass.
- Titles: one per TMDB movie (`movie-<id>`) or series (`tv-<id>`), with poster, release date, synopsis,
  studios, directors, writers, producers, cast with characters, and per-season episode titles. A
  title is never deleted with its files.
- Files: per host. Gone from disk = deleted (row kept, deleted flag); same name and size elsewhere under
  the roots = moved (same row, new path); in or into a `NOTESD_MOVIES_DONE_DIRS` folder = done signal.
- State, derived at read time: finished (manual watched flag, done signal, or last position >= 90 %),
  in progress, unwatched, dropped (deleted partway), removed unwatched (deleted, never played), seen
  (only "opened" observations from VLC's recent list).
- User state: watched flag, 0-5 stars, review (a note tagged `#movie`, linked to the title).
- Play/Resume: starts the Windows `vlc.exe` on this host's file at the resume second, reads its status
  through Windows `curl.exe` every `NOTESD_VLC_POLL_MS` into one play event, closes it when VLC exits.
  Another host's file: `available: false`, play answers `not_on_this_machine`; no VLC/interop/curl:
  `player_unavailable`.
- VLC recents: each pass reads `[RecentsMRL]` from `NOTESD_VLC_INI`; entries become play observations,
  and a gone file becomes a deleted file under its matched title.
- Continue: `movies_continue` / `POST /api/movies/continue` resumes the latest unfinished episode or
  film, else starts the next episode whose file is here, else answers which episode is missing and
  which later ones are present. Without a title: the title of the newest play.
- MCP: `movies_list`, `movies_get`, `movies_history`, `movies_continue`, `movies_person`, `movies_mark`
  (also in the chat bar). SSE `changed` on `/api/movies/events`.

## How to get to it (user POV)
Wall: the Movies icon in the rail or sidebar -> `/movies` (poster grid) -> click a poster ->
`/movies/<title id>` (detail, Play/Resume, watched, stars, review, episodes with progress and deleted
flags). The unmatched list (`/movies/unmatched`) opens from the Movies page; pick a TMDB title for a
file there. The pill bar asks the chat about the page.
Claude Code: `/n continue MobLand`, `/n which MobLand episode did I watch last?`, `/n Blumhouse films I
finished this year`, `/n other Margaret Qualley films I haven't seen`.

## Driving it with verify.sh
`up --movies` gives the run its own library (generated once with ffmpeg by
`scripts/movies/make-fixtures.sh`, copied to `<run>/movies/library` so a journey may delete and move
files), a fake TMDB (`fake-tmdb.mjs` + `tmdb.json`, posters included) and fake `vlc.exe`/`curl.exe`
(`fake-vlc.mjs`) that record each launch and answer `status.json`. It prints `MOVIES=<dir>`.

The whole chain is one script, 12 stages, no model call (about 2-3 minutes):
```sh
V=.claude/skills/verify-notesd/scripts/verify.sh
$V up --web --movies                                     # RUN=..., MOVIES=...
.claude/skills/verify-notesd/scripts/movies/journey.sh RUN   # ends with: journey: PASS (12 stages)
$V down RUN                                              # keeps movies-tmdb-requests.log, movies-vlc-launches.jsonl
```
| Stage | What it proves |
| --- | --- |
| 1 sync | 6 present files matched (`Videos/…Pahe.in.mkv`, the MobLand season folder as one `tv-247718` with S01E01-E03, `Done/The_Rivals…` with a done signal, `Telegram Desktop/Oldboy (2003)/Oldboy.mkv`); the 20 s `Done/docker_es` clip `unmatched:too_short`; studios, cast with characters, directors, 3 episode rows; two gone films from the fixture ini as deleted files with recents observations |
| 2 posters | `GET /api/movies` `poster_url`s on `TMDB_IMAGE_BASE`, one loads as `image/png` |
| 3 user state | `POST /api/movies/movie-467905/user` stores rating 4 + watched; review is a `#movie` note linked by `review_note_id` |
| 4 play | `POST …/files/<S01E01>/play` launches the fake VLC at 0; `vlc at 912` is polled into the play; `vlc quit` closes it; S01E01 `finished` |
| 5 continue | MCP `movies_continue {title:"MobLand"}` -> `started` S01E02; stopped at 300 s -> `in_progress` |
| 6 continue, no title | `movies_continue {}` -> `resumed` S01E02 at about 300 s (`--start-time` or a `seek`) |
| 7 delete, move | `rm` S01E03 -> deleted, `removed_unwatched`, title kept; `mv` Oldboy into `Videos/Done` -> same row, new path, done signal, `finished` |
| 8 missing | S01E02 marked watched; `movies_continue` -> `missing` S01E03, no VLC launch |
| 9 other host | a seeded `verify-other-host` file is `available:false`; play answers `not_on_this_machine` |
| 10 unmatched | `GET /api/movies/unmatched` lists the clip `too_short`; `POST …/assign {kind, tmdb_id}` moves it into `movie-990003` |
| 11 MCP reads | `movies_person` (seen / not seen), `movies_list {company}`, `movies_history`, `movies_get` with the deleted file |
| 12 wall | `ui-library.mjs`: grid of loaded posters; MobLand page with episodes, cast and characters, one `data-deleted="true"` row |

Driving one piece by hand on the same run:
```sh
$V api RUN POST /api/movies/sync
$V sql RUN "select id, name, status, reason, title_id, deleted_at, done_at from movie_files order by id"
$V api RUN POST /api/movies/files/<fileId>/play '{}'
$V vlc RUN args            # what the fake vlc.exe was started with (Windows path, --start-time, port)
$V vlc RUN at 600          # jump the playing fake VLC to 600 s; the next poll records it
$V vlc RUN quit            # VLC "exits": curl.exe answers exit 7, the play closes
$V mcp RUN movies_continue '{"title":"MobLand"}'
cat "$MOVIES/tmdb.log"     # every TMDB request the daemon made (MOVIES= from up)
```

## Gotchas
- A plain `$V up` pins `NOTESD_MOVIES=off` (`/api/movies*` answer 503 `movies_off`), even when the
  checkout's `.env.local` names real roots. Only `--movies` turns it on, and only against the run's fakes.
- Never set `NOTESD_MOVIES_ROOTS`, `NOTESD_VLC_INI` or `NOTESD_VLC_BIN` to anything under `/mnt/c` on a
  run, and never drive the live daemon's Play: it starts the owner's real VLC.
- A long file whose name matches nothing would ask the Haiku fallback (billed). The fixture has none,
  and `--movies` pins `NOTESD_MOVIES_FALLBACK_MODEL=off`. Add a fixture with an unmatched long name only
  with that in mind.
- The fake VLC plays in real time from `--start-time`; use `$V vlc RUN at SECONDS` rather than waiting.
  Every fixture video is 960 s, and the fake reports that length.
- `$V up --web` matters for stage 12: the wall serves the last `web/dist` otherwise.
- The fixture library is cached in `$VERIFY_HOME/.movies-fixture`; bump the stamp name in
  `make-fixtures.sh` when its layout changes.
- `not_on_this_machine` needs another host's row: stage 9 seeds one with `$V exec`.
- Stage 6 accepts the resume second from either the launch's `--start-time` or a later `seek` command,
  because Play passes the first and confirms with the second.
````
**Code (`features/README.md`, new row after the `egress.md` row):**
```markdown
| Movies: library sync, TMDB metadata, Play/Resume in VLC with progress, deleted vs watched, unmatched list, `movies_*` tools | [movies.md](movies.md) | background sync (`up --movies`), API, MCP, fake VLC, wall `/movies` |
```
**Code (`SKILL.md`):**
- Launch block (after the `$V up --adversary` line):
```sh
$V up --movies        # Movies ON against a generated video library, a fake TMDB and a fake vlc.exe/curl.exe
```
- New paragraph after the `--adversary` paragraph (after `:38`, before `## Doctor`):
```markdown
Every run also pins `NOTESD_MOVIES=off`, so a throwaway daemon never scans the owner's video folders
(the live `.env.local` names them), calls TMDB or starts VLC. `--movies` turns it on against
`<run>/movies/`: a library generated once with ffmpeg (`scripts/movies/make-fixtures.sh`, cached in
`$VERIFY_HOME/.movies-fixture`, copied per run), a fake TMDB (`scripts/movies/fake-tmdb.mjs`) and fake
`vlc.exe`/`curl.exe` wrappers (`scripts/movies/fake-vlc.mjs`) that record every launch and answer VLC's
`status.json`. The filename fallback is pinned `off`, so nothing is billed. `scripts/movies/journey.sh RUN`
drives the whole chain; see `features/movies.md`.
```
- Drive table, new row after `| Log | … |`:
```markdown
| Fake VLC | `$V vlc RUN args\|status\|commands\|at SECONDS\|quit` | `--movies` runs only: what VLC was started with, where it is, jump to a second, make it exit (the daemon then closes the play). |
```
- Gotchas, new bullet at the end:
```markdown
- Never drive Play or `movies_continue` on the live daemon, and never give a run a `/mnt/c` root: both
  reach the owner's real VLC or folders. `up --movies` is the only way to drive Movies.
```
**Impact:** docs only.

### Step 9: README and CLAUDE.md
**Files:** `README.md`, `CLAUDE.md`
**Change:** Before writing, read the landed code once and adjust wording where it differs from the contract (a status code, a body field, the capabilities key): `src/config.ts` `parseMovies`, `src/http/moviesApi.ts`, `src/http/moviesPlayApi.ts`, `src/http/reveal.ts` (`/api/capabilities`), `src/mcp/movieTools.ts`. The doc-check (Step 7) then proves names; the prose below is what to write.

(a) `README.md` Contents, after the Connectors line (`:43`):
```markdown
- [Movies](#movies)
```

(b) `README.md`, new section right before `## Install and run` (`:985`):
````markdown
## Movies

The Movies icon in the rail opens `/movies`: every film and series in your video folders, as a grid of
posters. notesd scans the folders named in `NOTESD_MOVIES_ROOTS` every two minutes, keeps the videos of
at least 15 minutes, and looks each one up on TMDB from its file name and folder. Release names like
`How.to.Make.a.Killing.2026.1080p.WEB-DL.x265.6CH-Pahe.in.mkv`, `The_Rivals_of_Amziah_King_2026_…_Pahe_in.mkv`,
`Oldboy (2003)/Oldboy.mkv`, a season folder of `MobLand.S01E01…` files and `One Piece - 405` all
resolve. When a name is not clear enough, one short Haiku call suggests the title. Everything else
(WhatsApp clips, trailers, names nothing matches) goes to a hidden unmatched list with the reason,
where you pick the right title by hand.

A series is one poster. Click a poster for its page: release date, synopsis, studios, directors,
writers and producers, the cast with their characters, Play or Resume, the watched flag, 0–5 stars and
a review. The review is an ordinary note tagged `#movie`, so `/n` finds it and its revisions are kept.
A series page lists every episode with its own progress. The pill bar at the bottom asks the chat about
the page you are on.

**Play and resume.** Play starts the Windows VLC on the file at the second you stopped (from the start
when you had finished it), so VLC's own "continue?" prompt never comes up, and reads its position every
five seconds while it plays. A film you open from Explorer counts too: VLC writes its recent list when
it exits, and the next scan reads the positions from it.

**Deleting is not watching.** Files come and go; titles and their history stay. A file is finished
when it got to 90 % or more, when you set the watched flag (for the films whose credits you skip), or
when it is moved into a `Done` folder. Deleted partway, it is dropped; deleted before it was played,
it is removed unwatched. A file that shows up elsewhere in the folders with the same name and size was
moved, not deleted. Deleted files keep their row, with a deleted flag on the page.

**From Claude Code.**

```
/n which MobLand episode did I watch last, and when?
/n Blumhouse films I finished this year
/n recommend other Margaret Qualley films I haven't seen
/n continue MobLand
/n continue whatever I watched last night
```

"Continue" resumes the episode you stopped in, else starts the next one whose file is here, else
tells you which episode is missing and which later ones you have.

**Setup.** Put the folders and VLC's settings file in `.env.local` (the TMDB token is in the
Configuration table below), then run `npm run db:migrate` once and `scripts/install.sh`:

```
NOTESD_MOVIES_ROOTS=/mnt/c/Users/<you>/Videos:/mnt/c/Users/<you>/Downloads/Telegram Desktop
NOTESD_MOVIES_DONE_DIRS=Done
NOTESD_VLC_INI=/mnt/c/Users/<you>/AppData/Roaming/vlc/vlc-qt-interface.ini
```

Play needs WSL interop, VLC at `NOTESD_VLC_BIN` and Windows' `curl.exe`; without them the button is
disabled and says why. Titles, ratings and reviews are shared by both machines; files, plays and VLC
belong to the machine that has the file, and the other one shows "not on this machine".
````

(c) `README.md` Configuration: replace the contiguous block of movie rows phase 1 added (from the `NOTESD_MOVIES` row to its last movie row; if phase 1 placed none of them, insert after the `NOTESD_EGRESS_METER` row `:1116`) with exactly:
```markdown
| `NOTESD_MOVIES` | on | `off` stops the Movies library on this machine: no scan, no TMDB call, no VLC. While `NOTESD_MOVIES_ROOTS` is empty nothing is scanned, but the library, playback and the routes still work. |
| `NOTESD_MOVIES_ROOTS` | — | The folders scanned for films and series: absolute paths separated by `:`, searched recursively. Spaces are fine (`/mnt/c/Users/you/Videos:/mnt/c/Users/you/Downloads/Telegram Desktop`). Unset: nothing is scanned. |
| `NOTESD_MOVIES_DONE_DIRS` | `Done` | Folder names, separated by `:`, any case, that mean "watched": a file found in or moved into one, at any depth below a root, counts as finished. |
| `NOTESD_MOVIES_SCAN_MS` | `120000` | Pause between library passes. `/mnt/c` sends WSL no file events, so the folders are polled, not watched. `POST /api/movies/sync` starts a pass at once. |
| `NOTESD_MOVIES_MIN_SECONDS` | `900` | Videos shorter than this (by `ffprobe`) go to the unmatched list as `too_short`, without a TMDB lookup. |
| `NOTESD_MOVIES_FALLBACK_MODEL` | `haiku` | Claude model alias asked for a title and year when a file name has no confident TMDB match: one short call per such file (never repeated for a file left unmatched), on your `claude` login. `off`: no fallback. |
| `TMDB_API_READ_ACCESS_TOKEN` | — | TMDB v4 read access token, sent as a Bearer header. Preferred. |
| `TMDB_API_KEY` | — | TMDB v3 API key, used only when there is no token. With neither, files are still registered, all unmatched as `no_tmdb_credentials`. |
| `TMDB_API_BASE` | `https://api.themoviedb.org/3` | TMDB API root. Tests and `verify.sh up --movies` point it at a fake. |
| `TMDB_IMAGE_BASE` | `https://image.tmdb.org/t/p` | Where poster URLs point. Posters are linked, never stored, so both machines show them. |
| `NOTESD_FFPROBE_BIN` | `ffprobe` | Reads each video's duration. |
| `NOTESD_VLC_BIN` | `/mnt/c/Program Files/VideoLAN/VLC/vlc.exe` | The Windows VLC that Play starts. notesd never reuses or closes a VLC it did not start. |
| `NOTESD_CURL_EXE` | `/mnt/c/Windows/System32/curl.exe` | The Windows `curl.exe` that reads VLC's status. VLC's HTTP interface listens on Windows' `127.0.0.1`, which WSL's NAT networking cannot reach, so the request is made from the Windows side. |
| `NOTESD_VLC_HTTP_PORT` | `47318` | Port of the HTTP interface notesd turns on in the VLC it starts (loopback only, a new password each launch). |
| `NOTESD_VLC_POLL_MS` | `5000` | How often a playing VLC's position is read into its play event. |
| `NOTESD_VLC_INI` | — | VLC's `vlc-qt-interface.ini` (`/mnt/c/Users/<you>/AppData/Roaming/vlc/vlc-qt-interface.ini`), read on every pass for its `[RecentsMRL]` list, so films opened from Explorer count too. Unset: only plays started from notesd are recorded. |
| `NOTESD_VLC_HEALTH_MS` | `30000` | How often every `vlc.exe` on this machine is sampled into `<NOTES_DATA_DIR>/movies/vlc-health-<host>.jsonl` (pid, working set, private bytes, handles, and for a VLC notesd started its play state and seconds paused); one fsync'd JSON line per VLC, 5 MB plus one previous file. After a crash the next start adds an incident with the last samples and the Windows Application Error / Application Hang events around them. `GET /api/movies/player/health` reads it. `0` turns the log, incidents and hang detection off (so does an empty `NOTESD_MOVIES_ROOTS`); 1-4999 is rejected. |
| `NOTESD_VLC_EXTRA_ARGS` | — | Extra `vlc.exe` arguments for every VLC notesd starts, split on whitespace (no quoting), placed before the file, e.g. `--avcodec-hw=none`. `--http-*`, `--extraintf`, `--intf` and `-I` are rejected: notesd owns VLC's HTTP interface. |
| `NOTESD_TASKLIST_EXE` | `/mnt/c/Windows/System32/tasklist.exe` | The Windows tasklist the VLC health log runs each interval. Missing: the health log is off (one startup log line). |
| `NOTESD_POWERSHELL_EXE` | `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe` | Reads private bytes, handles and the command line of each `vlc.exe` (only while one runs), and the Windows events for a crash incident. Missing: samples keep pid and working set only, and incidents carry no Windows events. |
```
The last four rows are phase 9's (reconciled: the same text phase 9 Step 8 inserts after the `NOTESD_CURL_EXE` row; this replacement keeps them).

(d) `README.md` MCP tools table, after the `adversary_redo_context` / `adversary_redo_submit` row (`:1171`):
```markdown
| `movies_list` | Titles by text, `state` (finished, in progress, unwatched, dropped, removed unwatched, seen), studio (`company`), `person`, kind, and the date range they were finished in ("Blumhouse films I saw this year") |
| `movies_get` | One title with its credits, episodes, files (deleted ones too) and play events |
| `movies_history` | Play events, newest first, optionally for one title or date range; kept after the file is deleted ("which MobLand episode did I watch last, and when?") |
| `movies_continue` | Resume the latest unfinished episode or film of `title` from its position, else start the next episode whose file is here, else say which next episode is missing and which later ones are present. Without `title`: the title of the newest play. Starts VLC on this machine |
| `movies_person` | A person's TMDB filmography, each entry marked seen or not seen ("other Margaret Qualley films") |
| `movies_mark` | Set the watched flag, the 0–5 rating or the review of a title, or the watched flag of one file |
```
and the sentence at `:1182` becomes:
```markdown
come first. The chat bar can use the five session tools, the three adversary tools and the movie tools too.
```

(e) `README.md` HTTP API table, before the `/full/:imageId` row (`:1269`):
```markdown
| `GET /api/movies?q=&state=&kind=&company=&person=` | The library, one entry per title with `poster_url` and its derived `state`; `q` is full text over title and synopsis. With `NOTESD_MOVIES=off` every `/api/movies*` route answers 503 `movies_off` |
| `GET /api/movies/unmatched` | This machine's files that are not in the library, each with its `reason` (`too_short`, `no_match`, `low_confidence`, `tmdb_error`, `no_tmdb_credentials`, `probe_failed`) |
| `GET /api/movies/status` | Whether the library is on, its roots, and the last pass with its counts |
| `GET /api/movies/search-tmdb?q=&kind=` | TMDB search, for picking the title of an unmatched file |
| `GET /api/movies/events` | Server-sent events, `event: changed` after every pass or write that changes the library |
| `GET /api/movies/player` | The play notesd is tracking now, if any, and whether playback is `available` on this machine |
| `GET /api/movies/player/health?limit=` | This machine's VLC health log (phase 9): the newest `limit` samples (default 200, max 2000) with pid, working set, private bytes, handles and, for the VLC notesd follows, its state and seconds paused; per-VLC run summaries with growth per paused minute; hang lines; and crash incidents with the Windows Application Error / Application Hang events. The file is `<NOTES_DATA_DIR>/movies/vlc-health-<host>.jsonl`. 503 `movies_off` without a monitor |
| `GET /api/movies/:id` | One title (`movie-<tmdb id>` or `tv-<tmdb id>`): release date, synopsis, studios, directors, writers, producers, cast with characters, rating, watched, review, the episode list, and every file (deleted ones too) with its `state`, `available`, season and episode |
| `POST /api/movies/:id/user` | `{watched?, rating?, review?}`: the watched flag, 0–5 stars, and the review, kept as a note tagged `#movie` and linked to the title. Same-origin only |
| `POST /api/movies/files/:fileId/watched` | `{watched}`: mark one file or episode finished, or take the mark off. Same-origin only |
| `POST /api/movies/files/:fileId/assign` | `{kind, tmdb_id, season?, episode?}`: put an unmatched (or wrongly matched) file under that TMDB title. Same-origin only |
| `POST /api/movies/sync` | Start a library pass now. Same-origin only |
| `POST /api/movies/files/:fileId/play` | Start VLC on the file at its resume point (the last position; the start when there is none or it was finished). `not_on_this_machine` for another machine's file, `player_unavailable` without `vlc.exe`, WSL interop or `curl.exe`. Same-origin only |
| `POST /api/movies/continue` | `{title?}`: what `movies_continue` does. Same-origin only |
```
Also extend the `GET /api/capabilities` row (`:1234`) with the movies key phase 5 added, worded from `src/http/reveal.ts` (e.g. "`{"reveal": true, "movies": …}`: … and whether Play can start VLC here").

(f) `README.md` storage block, before the `app_settings(key, value)` line (`:1298`):
```
           movie_titles(id [movie-467905 | tv-247718], kind, tmdb_id, title, year, release_date,
                        overview, poster_path, genres, watched_at, rating, review_note_id, …)
           movie_companies, movie_title_companies, movie_people,
           movie_credits(title_id, person_id, role, character, job, ord)
           movie_episodes(title_id, season, episode, name, air_date, runtime_min, …)
           movie_files(id, title_id, host, path, name, size, duration_s, season, episode, status,
                       reason, source, first_seen_at, deleted_at, moved_at, done_at, watched_at, …)
           movie_plays(id, file_id, host, source [live | vlc_recents], started_at, ended_at,
                       start_position_s, position_s, duration_s)
```

(g) `README.md` Limitations, after the "Edits from another machine" bullet (`:1369`):
```markdown
- **Movies play where the file is.** Titles, ratings and reviews are shared; files, plays and VLC belong
  to one machine. A film opened from Explorer reaches the history only when VLC exits (VLC writes its
  recent list then), and VLC keeps only its last 30. Playback needs Windows VLC under WSL.
```

(h) `CLAUDE.md`, new bullet after the `- **Seer Adversarial**` bullet (`:42`), one line:
```markdown
- **Movies** (`src/movies/*`): the owner's video library as titles (a TMDB movie or series, `movie-<id>` / `tv-<id>`, shared by both machines, never deleted with its files), files (per host, soft-deleted) and play events (never deleted) in the `movie_*` tables (`drizzle/0017_movies.sql`). `MoviesRepo` (`src/movies/repo.ts`) is the only writer; the review is a normal note written through `NotesService` (`reviewNote.ts`, tag `#movie`) and linked by `review_note_id`. `MoviesService` (`service.ts`, `deps.movies`) polls `NOTESD_MOVIES_ROOTS` every `NOTESD_MOVIES_SCAN_MS` (never a watcher: `/mnt/c` is drvfs and sends no inotify events): `ffprobe` drops videos under `NOTESD_MOVIES_MIN_SECONDS`, `parse.ts` reads the six filename shapes, `match.ts` asks TMDB (`tmdb.ts`; `TMDB_API_BASE` is the test seam) and the Haiku `fallback.ts` when unsure, and the rest lands in the unmatched list with a reason. A missing file with a same name+size twin under the roots is a move, not a delete; a file in a `NOTESD_MOVIES_DONE_DIRS` folder gets a done signal. State is derived at read time by `state.ts` only (finished = manual flag, done signal or last position >= 90 %; dropped / removed unwatched for deleted files); never store it. Play (`player.ts`, `vlc/*`) starts the Windows `vlc.exe` via `wslpath -w` with its HTTP interface on loopback and reads status with Windows `curl.exe` (WSL NAT cannot reach Windows loopback), resumes by seeking, polls into one play event, and never reuses or kills a VLC it did not start; `[RecentsMRL]` in `NOTESD_VLC_INI` is read on each pass for films opened from Explorer. The VLC health log (`vlc/health.ts`, `vlc/incidents.ts`) samples every `vlc.exe` via `tasklist.exe`/`powershell.exe` (`NOTESD_TASKLIST_EXE`, `NOTESD_POWERSHELL_EXE`) every `NOTESD_VLC_HEALTH_MS` into `<dataDir>/movies/vlc-health-<host>.jsonl` (a file, fsync'd, so it survives a WSL crash), writes an incident with Windows fault events after an unclean stop, logs a hang when a notesd VLC stops answering while its process lives (the play stays open), and is read by `GET /api/movies/player/health`; `NOTESD_VLC_EXTRA_ARGS` goes on every launch. Files, plays and VLC are per host (`available: false`, `not_on_this_machine`, `player_unavailable`); posters are hotlinked TMDB URLs so both machines see them. `NOTESD_MOVIES=off` or no roots starts nothing; tests use `DEFAULT_MOVIES_CONFIG` (off) and inject every path and binary. Routes: `src/http/moviesApi.ts`, `moviesPlayApi.ts` (writes, play and continue same-origin); MCP: `src/mcp/movieTools.ts` (`movies_*`; `movies_continue` starts VLC); web: `/movies`. Prove it with `verify.sh up --movies` + `scripts/movies/journey.sh` (generated library, fake TMDB, fake VLC).
```
**Check:** `bash .claude/skills/verify-notesd/scripts/movies/doc-check.sh` prints `doc-check: OK (…)`.
**Impact:** docs only.

### Step 10: Live config, migrate, rebuild, restart (LAST; only after the set is merged to `main`)
**File:** `/home/miftah/mcp-notes/.env.local` (untracked), then the live daemon.
**Change:** Runs once the plan set has been merged to `main` and pushed (by completion-handler or the swarm coordinator). If this phase's session finishes before that merge, it leaves this step to whoever lands the set and says so in its report. It is idempotent: each key is appended only when absent, existing values are never changed, and only key names are printed. The owner's standing rule is to run install/rebuild/restart without asking.
**Code:**
```bash
set -euo pipefail
LIVE=/home/miftah/mcp-notes
ENV_FILE="${ENV_FILE:-$LIVE/.env.local}"
cd "$LIVE"
before="$(git rev-parse HEAD)"
git pull -q --ff-only origin main
[ -f src/movies/service.ts ] || { echo "the movies set is not on main yet; nothing changed" >&2; exit 1; }

# add_key KEY VALUE: append KEY=VALUE only when KEY is absent. Prints the key name, never a value.
add_key() {
  local key=$1 value=$2
  if grep -qE "^[[:space:]]*(export[[:space:]]+)?${key}=" "$ENV_FILE"; then
    echo "kept    $key (already set)"
  else
    if [ -s "$ENV_FILE" ] && [ -n "$(tail -c1 "$ENV_FILE")" ]; then printf '\n' >>"$ENV_FILE"; fi
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
    echo "added   $key"
  fi
}
add_key NOTESD_MOVIES_ROOTS '/mnt/c/Users/mahfu/Videos:/mnt/c/Users/mahfu/Downloads/Telegram Desktop'
add_key NOTESD_MOVIES_DONE_DIRS 'Done'
add_key NOTESD_VLC_INI '/mnt/c/Users/mahfu/AppData/Roaming/vlc/vlc-qt-interface.ini'

if ! git diff --quiet "$before" HEAD -- package-lock.json; then npm ci; fi
npm run db:migrate          # 0017_movies on the direct Neon host; install.sh does not migrate
scripts/install.sh          # build, restart notesd, health, MCP registration, skills, hooks
systemctl --user is-active notesd
curl -fsS http://127.0.0.1:7317/api/movies/status | jq -c .
```
**Post-deploy check (owner's screen; after Step 10; not a journey, does not gate the phase):** a daemon restart must not interrupt a film (index Decisions). Play one real film from the wall (or `curl -fsS -X POST -H 'Origin: http://127.0.0.1:7317' http://127.0.0.1:7317/api/movies/files/<id>/play`), wait 15 s, note `tasklist.exe /FI "IMAGENAME eq vlc.exe" | grep -c vlc.exe`, run `systemctl --user restart notesd`, wait 10 s and count again → passes when the count is unchanged and the VLC window is still playing; `journalctl --user -u notesd -n 50` shows `closed 1 play(s) left open by the previous run`. If the VLC closed, phase 5's `systemd-run --user --scope` launch did not take effect: check `/proc/<notesd pid>/cgroup` ends in `notesd.service` and `command -v systemd-run`, and record it as a bug.

**Post-deploy check 2, phase 9's J8 (owner's screen; not a journey, does not gate the phase):** press Play on a film in the wall, pause it in VLC, wait 10+ minutes, then `curl -s localhost:7317/api/movies/player/health | jq '{sampling, process_detail, run: .runs[-1], last: .samples[-1]}'` → `sampling` and `process_detail` are true, `last.ours` is true, `last.play.state` is `"paused"` with `paused_s >= 600`, `run.samples >= 20`, and `run.private_growth_per_paused_min` is a number (near 0 = no leak while paused); `tail -n 2 ~/mcp-notes-data/movies/vlc-health-$(hostname).jsonl` shows two sample lines 30 s apart.

**Impact:** the live daemon starts scanning the two Windows folders (first pass: ~95 files through `ffprobe` over drvfs, TMDB lookups, a few Haiku fallback calls for unclear names — the owner accepted this in the brainstorm) and reads VLC's recents. `TMDB_API_READ_ACCESS_TOKEN`/`TMDB_API_KEY` are already in that file (key names checked, values never read). Nothing else in `.env.local` changes.

## Principles applied

- Build the lever: docs coverage is `doc-check.sh` (code <-> README/CLAUDE/feature map, both directions) and the feature chain is `journey.sh`, so a reviewer reruns two commands instead of reading prose against the code.
- Encode lessons in structure: once Step 10 lands, the main checkout's `.env.local` names the owner's real folders, which every `verify.sh up` from that checkout would inherit. Instead of a warning sentence, verify.sh pins `NOTESD_MOVIES=off` on every run and `--movies` overrides every path, binary, TMDB base and the fallback model.
- Laziness protocol: one `fake-vlc.mjs` serves the vlc, curl and control roles; journeys reuse `verify.sh api/mcp/ui/exec/note` for evidence instead of a new driver; the live `.env.local` step is an inline idempotent function, not a checked-in script carrying the owner's paths.
- Sequence into verifiable units: fixtures, fakes and the ini (Steps 1–4) each end in a check that can fail on its own; verify.sh (5) before the journey (6); doc-check (7) is written before the docs (8–9), so its first run fails and proves it can; the live change (10) is last.
- Test behavior, not implementation: the journey reads only HTTP, MCP, the wall and read-only SQL on the contract's tables; it never imports `src/movies/*` or asserts on private calls.

## Verification

**Build:** `npm run typecheck` (no TypeScript changes; it must stay green) and `bash -n` on every new `.sh`, `node --check` on every new `.mjs`:
`for f in .claude/skills/verify-notesd/scripts/verify.sh .claude/skills/verify-notesd/scripts/movies/*.sh; do bash -n "$f"; done; for f in .claude/skills/verify-notesd/scripts/movies/*.mjs; do node --check "$f"; done`
**Tests:** `npm test && npm run test:int` (unchanged suites; phase 8 adds no test file).
**Proof:** the real daemon, built from this checkout, driven through the whole Movies chain on a throwaway instance; the docs checked against the landed code; the live config applied idempotently.
- Harness: `.claude/skills/verify-notesd` (`verify.sh up --web --movies`, `scripts/movies/journey.sh`, `scripts/movies/doc-check.sh`)
- Feature-map entries: `features/movies.md` (new), `features/notes.md` (neighbor)
- Journeys:
  - **J1** · traces R7.1 — `bash .claude/skills/verify-notesd/scripts/movies/doc-check.sh` → passes when it exits 0 and prints `doc-check: OK (N env vars, M routes, T tools)` with N >= 20, M >= 14, T >= 6 (every env var `src/config.ts` and `src/movies/vlc/health.ts` read has a README Configuration row, every `/api/movies*` route in `src/http/movies*Api.ts` has an HTTP API row, every registered `movies_*` tool has an MCP row, none of those rows names something the code lacks, and the `## Movies` section, the `- **Movies**` CLAUDE.md bullet and `features/movies.md` with its four sections and README row exist)
  - **J2** · traces R7.1 — `V=.claude/skills/verify-notesd/scripts/verify.sh; $V up --web --movies` (note `RUN=`), then `.claude/skills/verify-notesd/scripts/movies/journey.sh <RUN>`, then `$V down <RUN>` → passes when the journey prints `journey: PASS (12 stages)`, `~/.local/state/notesd-verify/<RUN>/evidence/LOG.md` has an `ok` line for each of the 12 stages, the evidence holds `NN-ui-ui-library-1-grid.png` and `-2-detail.png`, and after `down` the evidence keeps `movies-tmdb-requests.log` (non-empty, only `127.0.0.1` fake requests) and `movies-vlc-launches.jsonl`, while `pgrep -f "notesd-verify/<RUN>/movies"` prints nothing
  - **J3** · traces R7.1 — the live-config function of Step 10 run twice against a scratch file (block below) → passes when the first run prints `added NOTESD_MOVIES_ROOTS`, `kept NOTESD_MOVIES_DONE_DIRS (already set)`, `added NOTESD_VLC_INI`, the second prints `kept` three times, each key occurs exactly once, `NOTESD_MOVIES_DONE_DIRS=Done:Watched` is unchanged, the original bytes are an unchanged prefix (`cmp` exits 0), and no value is printed
  - **J4** · traces R7.1 — **POST-MERGE ONLY: not part of this phase's verification.** A verifier running before the set is on `main` reports J4 `pending` (never `failed`) and judges R7.1 on J1-J3, which run pre-merge. After the merge and Step 10: `grep -cE '^NOTESD_MOVIES_ROOTS=' /home/miftah/mcp-notes/.env.local; grep -cE '^NOTESD_MOVIES_DONE_DIRS=' /home/miftah/mcp-notes/.env.local; grep -cE '^NOTESD_VLC_INI=' /home/miftah/mcp-notes/.env.local; systemctl --user is-active notesd; curl -fsS http://127.0.0.1:7317/api/movies/status | jq -c .` → passes when each count is `1`, the unit is `active`, and the status JSON shows the library on with the two `/mnt/c/Users/mahfu/…` roots; within 10 minutes `curl -fsS http://127.0.0.1:7317/api/movies | jq '[.. | objects | select(has("poster_url"))] | length'` is greater than 0. Before the set is on `main` this journey is `pending`, not failed
  J3 block:
  ```bash
  S=$(mktemp -d); printf 'DATABASE_URL=postgres://x\nTMDB_API_KEY=abc\n# comment\nNOTESD_MOVIES_DONE_DIRS=Done:Watched' >"$S/.env.local"; cp "$S/.env.local" "$S/orig"
  ENV_FILE="$S/.env.local"
  add_key() {
    local key=$1 value=$2
    if grep -qE "^[[:space:]]*(export[[:space:]]+)?${key}=" "$ENV_FILE"; then
      echo "kept    $key (already set)"
    else
      if [ -s "$ENV_FILE" ] && [ -n "$(tail -c1 "$ENV_FILE")" ]; then printf '\n' >>"$ENV_FILE"; fi
      printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
      echo "added   $key"
    fi
  }
  for pass in 1 2; do
    echo "-- pass $pass"
    add_key NOTESD_MOVIES_ROOTS '/mnt/c/Users/mahfu/Videos:/mnt/c/Users/mahfu/Downloads/Telegram Desktop'
    add_key NOTESD_MOVIES_DONE_DIRS 'Done'
    add_key NOTESD_VLC_INI '/mnt/c/Users/mahfu/AppData/Roaming/vlc/vlc-qt-interface.ini'
  done
  for k in NOTESD_MOVIES_ROOTS NOTESD_MOVIES_DONE_DIRS NOTESD_VLC_INI; do echo "$k $(grep -c "^$k=" "$ENV_FILE")"; done
  grep -x 'NOTESD_MOVIES_DONE_DIRS=Done:Watched' "$ENV_FILE"
  cmp -n "$(stat -c%s "$S/orig")" "$S/orig" "$ENV_FILE" && echo prefix-unchanged
  ```
- Neighbor check: a plain run must keep Movies off even when the shell says otherwise, and notes must still work — `NOTESD_MOVIES=on NOTESD_MOVIES_ROOTS=/tmp/nowhere $V up` (note `RUN`), `$V api RUN GET /api/movies/status`, `$V api RUN POST /api/notes '{"body":"neighbor check #verify"}'`, `$V api RUN GET '/api/notes?tag=verify'`, `$V down RUN` → passes when the status call answers 503 with `movies_off`, the note POST answers 201, and the list returns that note
- Cost: none. No model call: the fixture's long files all match the fake TMDB exactly, the short clip never reaches TMDB, `NOTESD_MOVIES_FALLBACK_MODEL=off` on `--movies` runs, and chat is not driven. J4's live first pass may make a few Haiku fallback calls on the owner's login (accepted in the brainstorm).

**Exit criteria:** `doc-check.sh` prints OK; `journey.sh` prints `journey: PASS (12 stages)` on a fresh `up --web --movies` run and `down` leaves no fake process; the neighbor check shows `movies_off` on a plain run; after the merge, the live `.env.local` holds each of the three keys once and `/api/movies/status` on 7317 shows both roots.

## Handoffs

- **`NOTESD_MOVIES_FALLBACK_MODEL=off` (reconciled):** phase 1's `parseMovies` maps `off` to `fallbackModel: null` and phase 3 then builds no fallback, so the README row documents `off`.
- **Phase 3 — probe before match.** Stage 1 expects the 20 s clip to be `unmatched:too_short` with no TMDB lookup (R1.2), and the Done-folder film found at first scan to have `done_at` (R3.3).
- **Phase 4 — wire shapes the journey reads** (recursive jq tolerates nesting, not renames): titles carry `poster_url`; each file object carries `id` or `file_id`, `state` and `available`; unmatched entries carry `reason`; bodies `POST /api/movies/:id/user {watched, rating, review}`, `POST …/files/:fileId/watched {watched}`, `POST …/files/:fileId/assign {kind, tmdb_id, season?, episode?}` (snake_case, like `thread_id` elsewhere); routes written as literal `'/api/movies…'` strings (doc-check greps them); the review note carries tag `movie`.
- **Phase 5 — what the fakes accept.** `fake-vlc.mjs vlc` reads `--http-port`, `--http-password`, `--start-time` in `--x=v` or `--x v` form and takes the last argument containing `/` or `\` as the file. `fake-vlc.mjs curl` accepts `-s -S -f --fail -G -u/--user -m/--max-time --connect-timeout -o -w -H -X -d --data-urlencode -A --retry` (and combined short flags such as `-sSf`), `http://127.0.0.1:<port>/requests/status.json[?command=seek|pl_pause|pl_play|pl_forceresume|pl_forcepause|pl_stop&val=…]`, prints VLC 3 `status.json`, exits 7 once the fake VLC is gone and 22 on 401 with `-f`. Any other flag with a value would be misread: tell the reconciler if phase 5 uses one. `detectPlayerEnv` must accept `NOTESD_VLC_BIN` / `NOTESD_CURL_EXE` pointing at executable shell scripts named `vlc.exe` / `curl.exe` outside `/mnt/c`. Foreign-host play must answer a 4xx whose body contains `not_on_this_machine`.
- **Phase 6 — wall hooks `ui-library.mjs` uses (reconciled: present in phase 6's code blocks):** a button whose accessible name is exactly `Movies` (rail and/or sidebar); each grid poster an `<img>` whose `src` is the API's `poster_url` and whose `alt` is the title (e.g. `MobLand`), clickable to `/movies/<title id>`; the detail page shows episode names and cast character names as text; each file/episode row `data-testid="movie-file"` with `data-deleted="true|false"` (and ideally `data-file-id`, `data-state`). The reconciler should copy these into phase 6's plan.
- **Phase 7 — MCP args and results:** `movies_continue {title?}` returning the contract's `ContinueResult` (`action`, `missing` naming season/episode); `movies_person {name}` entries with TMDB `id` (number) or `title_id`, and `seen` boolean; `movies_list {company}` (partial, case-insensitive name match); `movies_history {title}`; `movies_get {title}` (reconciled: phase 7's argument is `title`, an id or name) including deleted files; tools registered as `server.registerTool('movies_…'` (doc-check greps that).
- **Phase 1 — README env rows:** one contiguous block (phase 1 Step 10); Step 9c replaces it wholesale. Any env rows a later phase appends to that block (phase 9) must be kept in the replacement; doc-check fails otherwise.
- **Phase 9 (reconciled):** documented here: `GET /api/movies/player/health` (HTTP API row), the log file and its behavior (CLAUDE.md bullet, README env row, `features/movies.md` "VLC health" sub-feature), and the four env rows `NOTESD_VLC_HEALTH_MS`, `NOTESD_VLC_EXTRA_ARGS`, `NOTESD_TASKLIST_EXE`, `NOTESD_POWERSHELL_EXE` (the last two are read in `src/movies/vlc/health.ts`, which doc-check scans). `verify.sh up --movies` pins `NOTESD_VLC_HEALTH_MS=0` and an empty `NOTESD_VLC_EXTRA_ARGS`, so a throwaway daemon never samples the owner's real `vlc.exe`; plain runs are `NOTESD_MOVIES=off` and build no monitor. The feature map's health sub-feature is proven by phase 9's J5/J6 (`npm run test:int -- tests/integration/movies.health.int.test.ts tests/integration/movies.healthCrash.int.test.ts`, fake Windows side) plus the owner's J8 (post-deploy check 2); phase 9's J7 used a plain `verify.sh up`, which this phase turns into a movies-off run, so it is not copied into the map.
- **Fixture duplication (reconciled, kept):** this phase's `fake-vlc.mjs` (one Node script acting as vlc.exe, curl.exe and a control CLI, no network port) and `fake-tmdb.mjs` + `tmdb.json` (a standalone server with the verify tree's titles) do not reuse phase 5's `tests/fixtures/movies/fake-vlc.mjs` (an HTTP server reached by a real curl) or phase 2's `tests/helpers/tmdbFixtures.ts` (TypeScript, needs tsx, two titles). verify.sh scripts are standalone `.sh`/`.mjs` by convention and cannot import a test helper.
- **Completion-handler / coordinator — Step 10** runs after the merge to `main`; if phase 8's session ends before the merge, the lander runs Step 10 verbatim (owner rule: never ask before install/rebuild/restart).

## Rollback

Revert phase 8's commit: removes the fixtures, fakes, journey, doc-check, feature-map entry and doc edits, and restores verify.sh (plain runs stop pinning `NOTESD_MOVIES=off`; do this only together with the rest of the set, or a plain run from the main checkout would scan the real folders). The cached fixture `~/.local/state/notesd-verify/.movies-fixture` can be deleted at any time. Live: delete the three lines with `sed -i -E '/^(NOTESD_MOVIES_ROOTS|NOTESD_MOVIES_DONE_DIRS|NOTESD_VLC_INI)=/d' /home/miftah/mcp-notes/.env.local` (or add `NOTESD_MOVIES=off`) and run `scripts/install.sh`; the `movie_*` rows already written stay harmless.
