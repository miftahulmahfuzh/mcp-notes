# Direct streaming from Claude Code: discovery, marks, absolute episodes

Brief for one session, written 2026-11-16 by the session that landed direct streaming and the
Stream grid upkeep (`2f39f07` on `main`). Read `CLAUDE.md`, `docs/guide/streaming.md`
("Direct streaming") and `docs/guide/movies.md` first.

## What the owner asked for

After `/direct-stream` worked, the owner listed what they want to be able to say in Claude Code:

1. let's watch some spanish series . pick one for me. find the one that was released this year
2. stream a johnny depp movie. the more recent the better
3. let's start resume one piece from episode 730
4. i wanna rewatch penguin . let's stream it
5. let's stream the most recent Shudder movie
6. what are Blumhouse's movie that was released this year? play one
7. play one of Nolan's movie
8. i watched House of The Dragon season 1 last year. start season 2
9. i want to watch Joko Anwar's movie. play one
10. let's watch James Gunn's superman

"these are the ones that i could think of RIGHT NOW. there are unlimited possibilites when CC is
connected to our direct streaming service". The ten are examples, not the full list: build the
general capability, then check it against all ten.

## Where things stand (judged from the tools' documented inputs, not run)

| # | Today |
|---|---|
| 2, 7, 9 | Should work: `movies_person` (TMDB filmography, newest first) then `direct_stream_play` |
| 4, 10 | Should work: title lookup (`direct_stream_find` / `direct_stream_play`), person tool to disambiguate |
| 8 | Playing S2E1 works. Marking season 1 finished from Claude Code does not: `movies_mark` has no season option |
| 3 | Unverified: does `direct_stream_play` map an absolute episode number (One Piece 730) to a season and episode? |
| 1 | Missing: no lookup by original language and year |
| 5, 6 | Missing: no lookup by studio (Blumhouse) or network / streaming service (Shudder) |

Verify each "should work" row for real before relying on it.

## What to build

1. **A discovery tool** (suggested name `direct_stream_discover`, in `src/mcp/directStreamTools.ts`,
   TMDB calls in `src/movies/tmdb.ts`): find titles on TMDB by any mix of kind (film / series),
   year or year range, original language, person (name, with role), production company, and
   network or streaming service; sorted by release date or popularity. It returns candidates with
   what the owner's library already knows about each (in library, state, fresh stream source on
   this host), in the shape `movies_person` uses, so the model can pick one and call
   `direct_stream_play`. It starts nothing. Names resolve to TMDB ids inside the tool (company
   search, network / watch-provider lookup, person search); when a name is ambiguous it lists the
   candidates the way `movies_person` lists `other_people`.
2. **`movies_mark` gains a season and "not interested"**: mark one season of a series finished or
   not (through `MoviesRepo.seasonEpisodes` + `setEpisodesWatched`, added in `2f39f07`; the HTTP
   route is `POST /api/movies/:id/episodes/watched`), and set or clear `not_interested`
   (`setTitleUser({ notInterested })`). A title that is not stored yet (never played, no file)
   must be storable from its TMDB id so "I watched season 1 last year" works before the first play.
3. **Absolute episode numbers in `direct_stream_play`**: "One Piece episode 730" names an episode
   by its absolute number. Map it to TMDB's season and episode (the episode list is in
   `movie_episodes`; `movie_files.absolute_episode` and `src/movies/` already have a notion of
   absolute numbering for files) and say which episode was chosen. If the mapping is not certain,
   list the candidates and start nothing (the existing rule).
4. **The skill and prompts**: `claude/skills/direct-stream/SKILL.md`, `src/mcp/instructions.ts`
   and the chat bar prompt (`src/chat/prompt.ts`) learn the new paths, with the ten requests above
   as worked examples. Decide whether the chat bar may call the discovery tool (it is read-only,
   so probably yes: add it to `DIRECT_STREAM_TOOL_NAMES` / the allow list and `docs/guide/chat.md`).

## Rules that bind

- A film starts only when asked, and only when exactly one title matches; otherwise list and
  start nothing. "pick one for me" and "play one" ARE asking: the model picks one from the
  discovery list and plays it, and says which and why.
- Direct streaming plays a title in its original language only (`--audio-lang`, see CLAUDE.md).
- `MoviesRepo` is the only writer of `movie_*`; watch state is derived only in `state.ts`.
- Tests use fakes: no TMDB, no Chrome, no provider. Never call `streaming_play`,
  `direct_stream_play` or any real play from a test or a throwaway daemon. A real play takes over
  the owner's screen with sound: do not run one; list it for the owner instead.
- Docs are checked against the code: `npm run docs:gen` after tool changes, guide text in
  `docs/guide/streaming.md` and `docs/guide/movies.md` ("What you can ask"), feature map in
  `.claude/skills/verify-notesd/features/`.
- Another session may be working in the main checkout `/home/miftah/mcp-notes`. Work only in this
  worktree (`~/.worktrees/mcp-notes/stream-discovery`, branch `feature/stream-discovery`).

## Done means

- `npm run typecheck`, `npm test`, `npm run docs:check` pass; the integration files you add pass
  (`python3 ~/.claude/skills/swarm/swarm.py lease pg-test -- npm run test:int`).
- Proof with `.claude/skills/verify-notesd` on a throwaway daemon (`verify.sh up --direct-stream`,
  fake resolver, fake TMDB extended for discovery): each of the ten requests is traced to the
  tool calls that answer it, with the tool output saved as evidence. Plays stay on the fake.
- Then land it without asking: fast-forward `main`, push, apply any migration with
  `npm run db:migrate` from the main checkout and verify the objects in the database, run
  `scripts/install.sh` (rebuild and restart), remove this worktree and branch.
- End with a short report: what works for each of the ten, what was decided without asking, and
  the real plays left for the owner to try.
