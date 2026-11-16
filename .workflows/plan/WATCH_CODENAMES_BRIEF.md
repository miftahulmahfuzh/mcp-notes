# Brief: watch codenames, and the ten requests they were written for

**Worktree:** `/home/miftah/.worktrees/mcp-notes/watch-codenames`, branch `feature/watch-codenames` (base `origin/main`)
**Asked by the owner on 2026-11-17.** Their words:

> next, to make it easier for us to refer to each of this items. let's use codenames:
> 1. manually downloaded movie by me - DM
> 2. manually downloaded series by me - DS
> 3. cloud (non-torrent) stream movie - NTM
> 4. cloud (non-torrent) stream series - NTS
> 5. torrent stream movie - TM
> 6. torrent stream series - TS
>
> in the future we can talk like this:
> 1. play some chinese action movie TM
> 2. TM shadow edge is smooth af. let's play jackie chan's movie before this one now
> 3. continue OP TS
> 4. there is a spanish movie called smth like looking through your window . TM
> 5. play one of indonesian horror movie released this year TM
> 6. play one of thai comedy movie released on 2025 TM
> 7. play one of Kdrama with bloody action genre TS
> 8. what is the most recent park bo yeung project? let's watch it TS
> 9. i miss korean mafia movies. play one released this year TM
> 10. play House of Dragon season 2 TS
>
> i put some effort in writing these queries.. maybe add it to our readme/guide somewhere and make sure mcp-notes could handle these in the future.
> add the codenames to your persistent memory , maybe this CLAUDE.md , and a /n note

The memory and the note (7-UR5) are done. This brief is the rest: CLAUDE.md, the guide, and making the ten requests work from Claude Code and from the wall's chat bar.

## What a codename means

| Codename | Source | Kind | How it plays |
| --- | --- | --- | --- |
| DM | the library (a file the owner downloaded) | film | `movies_continue`, VLC |
| DS | the library | series | `movies_continue`, VLC |
| NTM | a cloud provider, never a torrent | film | `direct_stream_play` |
| NTS | a cloud provider, never a torrent | series | `direct_stream_play` |
| TM | a torrent | film | `direct_stream_play` with `provider: "torrent"` |
| TS | a torrent | series | `direct_stream_play` with `provider: "torrent"` |

A codename is one whole upper-case word, usually the last of a request, sometimes the first ("TM shadow edge is smooth af": there it names what was played, it is not a request). It is never part of a title. A request without one behaves exactly as today.

## What to do

1. **CLAUDE.md**: a short section (the table above in a few lines) so every session in this repo knows the six words. Keep it tight.
2. **Where the words must be understood** (read each first, and say the same thing in each, briefly): `claude/skills/direct-stream/SKILL.md`, `claude/skills/n/SKILL.md` (the Movies part: DM / DS), `src/mcp/instructions.ts`, `src/chat/prompt.ts`, and the tool descriptions in `src/mcp/directStreamTools.ts` where a line helps. The skills are symlinked into `~/.claude/skills` by `scripts/install.sh`; check the trigger descriptions in the SKILL.md front matter still fit their limits.
3. **NTM / NTS need "cloud only".** Today a play with no provider falls through to the torrent source after a cloud `no_source`. Find the smallest honest way to say "never a torrent" for one play (for example `provider: "cloud"` beside `provider: "torrent"`, or a named argument), implement it in `DirectStreamService.play` and the tool, and test both directions.
4. **Run the ten requests against what exists and close every gap.** Known before you start:
   - `direct_stream_discover` filters by kind, year, language, person, company, service and sort. It has **no genre and no keyword filter**, which requests 1, 5, 6, 7 and 9 need (action, horror, comedy; "bloody action"; "mafia"). `src/movies/tmdb.ts` already has `genres(kind)` and `discoverByGenre`; TMDB's discover takes `with_genres` and `with_keywords` (keyword ids from `/search/keyword`). Add `genre` (one or several, by English name, resolved inside the tool like the other names, with what was understood echoed in `filters`) and `keyword`, combinable with language and year. "Kdrama" is a Korean-language series; "chinese" is the original language zh (and cn for Cantonese: decide and say).
   - Request 2: "jackie chan's movie before this one" is the film in his filmography released just before the one named (The Shadow's Edge, 2025): `direct_stream_discover` by person, newest first, gives the list; check the answer carries release dates fine enough to order two films of one year.
   - Request 3: "OP" is an alias the lookup may already hold for One Piece (`movie_titles.aliases`); a series with no episode carries on from the last one watched, and it must do so with `provider: "torrent"` too. Check the torrent path for a long anime: the finder's episode match by absolute number.
   - Request 4: a title the owner half remembers ("looking through your window", Spanish: Through My Window / A través de mi ventana, 2022). The skill should tell Claude to work out the real title first (its own knowledge, then `WebSearch`), then play by that name; `did_you_mean` covers near misses. No tool change is expected: confirm.
   - Request 8: a person's most recent project across films and series ("park bo yeung" is a misspelling of Park Bo-young: the person search must find her; check, and if TMDB's search does not, say what does).
   - Request 10: season 2 with no episode: episode 1 of that season, or the first unfinished one in it. Check what `direct_stream_play {season: 2}` without an episode does today and make it sensible.
   For each request write down the tool calls it becomes, as the guide's existing table of ten requests does (`docs/guide/streaming.md`, "Finding something to stream").
5. **The guide**: a "Codenames" subsection in `docs/guide/streaming.md` with the table, and the owner's ten requests verbatim with the tool calls each becomes; one line in `docs/guide/movies.md` for DM / DS; `README.md` only if a line there names the ways to watch. `npm run docs:gen` after the tool changes.
6. **Tests and proof**: unit tests for the new filters and the cloud-only play; extend the discovery fixtures of `.claude/skills/verify-notesd` (`verify.sh up --discovery`, the fake TMDB) so the ten requests' tool calls run against it, as the existing ten do; update the feature map. Never the live daemon on 7317. `npm run typecheck` and `npm test` pass.

## Rules

- Read `CLAUDE.md` and `docs/guide/streaming.md` first. Decide forks yourself and write down what you decided; do not stop to ask.
- Another session, `impl-wyzie-synced`, is working at the same time in `/home/miftah/.worktrees/mcp-notes/wyzie-synced` on subtitles (`src/directStream/service.ts`, `src/directStream/torrent/subtitles/`, `web/src/stream/`, the subtitle parts of the guide, possibly `direct_stream_dialogue`). Stay out of those; keep your `service.ts` edit to the few lines the cloud-only play needs. Whoever lands second rebases onto main first.

## Landing

When it is proven: commit on `feature/watch-codenames`, rebase onto the current `origin/main`, merge to `main`, push, remove the worktree and branch. Then run `scripts/install.sh` (idempotent: it relinks the skills and rebuilds) and restart the daemon **only if nothing is streaming** (`GET http://127.0.0.1:7317/api/movies/player` shows no `stream` and no VLC play): a restart ends every stream session. If something is playing, land the code, skip the restart, and say so in the last message.

## Decided while doing it (2026-11-17)

- **Cloud only is `provider: "cloud"`**, beside `provider: "torrent"`. It plays this machine's stream cache first (a cache is made from a cloud provider), then every cloud provider with the picture check; it passes over a finished torrent download and never asks an index.
- **"Chinese" is `zh` and `cn` together** (TMDB's Mandarin and Cantonese); "Mandarin" and "Cantonese" ask for one.
- **A genre is read per kind.** A genre a kind lacks (Horror for a series) is refused with that kind's list when it was asked for alone, and goes in `keyword`; no silent rewrite.
- **Several genres must all fit; several keywords, any one.** A keyword stands for TMDB's keyword of that name and those that hold it as a whole word (8 at most). When no title carries one, the list comes back without the keyword and `filters.keywords_dropped` is true: on the day of writing TMDB tagged no Korean film of 2026 with mafia, gangster or organized crime, so request 9 leans on this and on `genre: "crime"`.
- **TMDB's person search finds nothing for "park bo yeung".** The tool searches again with the last word cut short ("park bo y", "park bo") and takes a name within one letter per five; `filters.person.asked_as` keeps the words asked.
- **A season without an episode** starts its first unfinished episode; a finished season starts again at its first (naming a season already seen asks to see it again); `no_such_season` otherwise.
- **A codename at the start of a remark carries to a request in the same message** (request 2).
- **Request 3 had a real gap in the torrent path.** Torrentio counts an episode within its season; TMDB numbers One Piece on across seasons, so the index listed nothing. The finder's query now carries the episode's place in its season (from the stored episode list). Against the real indexes, One Piece S23E1180: 0 candidates before, 20 after.
- **Request 4 needs no tool change**: TMDB's search finds nothing for the half-remembered name, so the skill and the chat prompt tell Claude to work the title out first.
- **Proof**: `direct-stream/codenames.sh` on `verify.sh up --discovery --torrent`. One request plays for real from the loopback torrent (the fixture's audio is English, so only an English film can); the others check `no_source` from the torrent source alone, the index address, and that no cloud resolve ran.
