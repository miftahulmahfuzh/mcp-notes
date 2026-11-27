# Token-Maxxing Session — 2026-11-27: Movies Web Page Tests

## 🎯 Achievement / End Result
- **Goal of the burn:** give the most edited web files that had no direct test their own jsdom tests: `web/src/pages/MoviesPage.tsx` and `web/src/components/movies/{MovieDetail,PlayMenu,EntityModal,MovieModal,AssignDialog}.tsx`, each test pinning behaviour that `docs/guide/movies.md` describes. Fix any proven bug in the same commit, and change no other behaviour.
- **Concrete changes:** six new test files beside the components (2049 lines added, no component file changed):
  - `web/src/components/movies/PlayMenu.test.tsx`: 25 tests
  - `web/src/components/movies/AssignDialog.test.tsx`: 13 tests
  - `web/src/components/movies/EntityModal.test.tsx`: 19 tests
  - `web/src/components/movies/MovieModal.test.tsx`: 15 tests
  - `web/src/components/movies/MovieDetail.test.tsx`: 31 tests
  - `web/src/pages/MoviesPage.test.tsx`: 34 tests
  - The worker reported about 140 tests in total. A count of `it(`/`test(` call sites in the six files gives 137; the difference is parameterised cases.
- **Real value delivered:**
  - The two most edited web files with zero direct test lines (MoviesPage, 21 commits; MovieDetail, 20 commits), plus EntityModal (266 lines) and MovieModal (257 lines), now have tests that fail when their documented behaviour drifts.
  - Mutation check: 11 deliberate breakages of the components were all caught by the new tests, then reverted.
  - No bugs found. Every behaviour checked matched the movies guide. One suspected AssignDialog bug was disproved and is now pinned by a test.
- **Branch:** token-maxxing-2026-11-27-movies-web-page-tests
- **Commits:** 7ff8497, 35b0b0f, 0cf6dc7, b1647e1, 2949fb4, 143c8eb, 9431b8c, 43e9a98, ed6ddfa
- **Merge status:** on branch, NOT merged — this is a worker session; the coordinator owns landing worker branches
- **Approx token burn:** several million tokens over a long worker session (six component suites, mutation runs, full unit and integration suites, a verify-notesd journey) 🔥

## Context & Motivation
The coordinator (orch-stream-play-log) assigned this idea from `docs/plans/2026-11-27-holes-map.md`, which was written earlier the same day. That map ranked `MoviesPage.tsx` and `MovieDetail.tsx` as the most edited web files with zero direct test lines (21 and 20 commits). It also listed `EntityModal.tsx` (266 lines) and `MovieModal.tsx` (257 lines) as untested directly. Until now these components were covered only indirectly, mostly through `web/src/App.movies.test.tsx`, and that file's `waitFor`-heavy flows do not isolate a single component's rules.

The brief was narrow: write tests that pin documented behaviour, fix a bug only when a test proves it, and otherwise leave the code alone.

## What We Did (blow-by-blow)
1. **PlayMenu (7ff8497).** Pinned the rows, hints and the request each row posts:
   - a cloud or torrent provider row
   - a site row carrying season and episode
   - the pahe row: its tab is opened inside the click handler with `opener` set to null, and the tab is closed when the request fails
   - the blocked pop-up case
   - streaming off, and no episode listed
   - Esc and click-outside close only the menu, never the page below it
2. **AssignDialog (35b0b0f, 9431b8c).** Pinned:
   - the guess is searched together with its kind, and the request body differs per kind
   - one assign per click
   - the race guard: the newest search wins
   - the `tmdb_off` text
   - Esc does not reach the page

   A suspected bug (an absolute-numbered episode file guessed as a film) turned out not to be one: the parser sets `kind_hint: 'tv'` for absolute episodes. 9431b8c pins that the file is assigned as a series.
3. **EntityModal (0cf6dc7, ed6ddfa).** The person, studio and genre pop-ups. Pinned:
   - the facts block, and more/less
   - rows drawn 150 at a time
   - a genre guide that is stored, collated once, or rewritten
   - the three mark buttons, including `ensure` first for a title that is not stored, and the "stays watched" case
   - opening a title ensures it exactly once
   - Esc yields to the movie pop-up

   Under a load average of about 41 the 320-row list test hit the 5 s timeout. It was slimmed to 155 rows, which still crosses the 150-row page boundary, and given a 20 s timeout (ed6ddfa).
4. **MovieModal (b1647e1).** The pop-up a movie id opens. Pinned:
   - film, episode and series ids
   - `not_on_this_machine` and deleted episodes falling back to streaming
   - the `no_source` text, and VLC unavailable
   - live follow per episode, in VLC and in the stream player
   - a failed re-read keeps the current view
   - Esc yields to the play menu
5. **MovieDetail (2949fb4).** A title's page. Pinned:
   - the reasons Play is disabled (file on another machine, no file, VLC off), and file first with the stream as an alternative
   - the stream line and the played line
   - watched and stars revert when the write fails
   - interested / not interested per side, with undo
   - season marks with an exact undo
   - cast capped at 18, and producers past 8
   - names open their pop-ups; a character asks the chat, waits, and falls back to plain text
   - the Files section and the download icon per side
6. **MoviesPage (143c8eb, 43e9a98).** Pinned:
   - the Library row of controls, the filters and counts, and per-side filters kept across a visit to a title
   - the Stream pills
   - the Cache icon with the Stream health icon beside it, after Films/Series: in the toolbar when there is no grid, lit on its own page, a second press goes back, plus Back to Stream
   - poster marks leave at the click, with undo, and revert on failure
   - the empty, failed, off and loading states
   - Trending: torrent play, refresh polling every 5 s while running, and trending marks leaving at the click
   - streaming-site titles: play, play again, remove
   - the grid's scroll kept per side
   - a title with no file shown on the Stream side

   CachePage and HealthPage are stubbed; HealthPage was reviewed by another worker.
7. **Mutation check.** 11 deliberate mutations of the components, all caught, components restored:
   - Cache/Health order swapped
   - health not toggling back
   - opener not cleared
   - menu Esc propagating
   - entity Esc ignoring the movie pop-up
   - ensure called on a stored title
   - interested icon always shown
   - rating not reverted
   - assign race guard removed
   - modal live follow ignoring the episode
   - modal Esc ignoring the play menu
8. **Proof runs.** See the Appendix.

## Code / Design Details
- Each test file sits beside its component and opts into jsdom with the `// @vitest-environment jsdom` first-line pragma, as CLAUDE.md requires. No second vitest config was added.
- Every fetch is stubbed. No test touches the network or the live daemon.
- Each test's expectation comes from `docs/guide/movies.md`, not from reading the current implementation, so the tests check the documented behaviour and not just whatever the code does today.
- The Movies page's CachePage and HealthPage children are stubbed, so `MoviesPage.test.tsx` covers only where they are placed and how they toggle, not what is inside them.

## Decisions & Trade-offs
- **No component changes.** Nothing failed against the guide, so the "fix any proven bug" clause was never used.
- **The movies header counts are not pinned here.** They live in `App.tsx` (`moviesHeading`), not in MoviesPage, and are outside this file set.
- **Slimmed long-list test (ed6ddfa).** 155 rows still crosses the 150-row page boundary that the test exists to prove. The test now costs less on a loaded machine and keeps what it checks.
- **App.movies.test.tsx flakes left alone.** That file is not one of the assigned files, and its failures were shown to be load flakes (see the Appendix).

## Follow-ups & YAGNI notes
- `web/src/App.movies.test.tsx`: its `waitFor`-based tests are flaky under heavy load. Longer timeouts there may help; this is outside this session's scope.
- The movies header counts (`moviesHeading` in `App.tsx`) have no direct test.
- Cosmetic: the MoviesPage site-play notice names the site in lower case ("on dramacool") while the rest of the UI capitalises it. Left as is.
- `EpisodeList`'s own episode-row play-menu flows are only partly covered here; `EpisodeList.test.tsx` already exists.

## Appendix
- `npm run typecheck`: clean.
- `npm run docs:check`: "reference is current".
- `npm run test:int`: 108 files / 1083 tests pass.
- `npm test`: 4879 of 4881 passed. The 2 failures were in `web/src/App.movies.test.tsx`, a file this session did not touch, and were load flakes: the load average was about 41 from sibling workers and the stream soak. Reran that file alone 7 times: 6 runs passed all 30 tests, and 1 run failed different tests than the first time.
- verify-notesd: `verify.sh up --movies --web`, run `1127-133513-3566481`. The movies journey passed all 12 stages. Evidence (45 files) is in `~/.local/state/notesd-verify/1127-133513-3566481/evidence/`, and the run was torn down.
- The live daemon on 7317 was never restarted or contacted.
