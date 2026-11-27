# Guide audit findings, 2026-11-27

Every guide under `docs/guide/` except `streaming.md` and the generated reference, plus the root
`README.md`, was read claim by claim against the source: each behaviour, limit, number, path,
environment variable, route, tool name and UI label a guide states was looked up in the code that
implements it. Where the guide had drifted from deliberate code, the guide was fixed in the same
change as this file. This file lists what was **not** fixed: places where the doc states the
intent and the code does something else, small stale strings in source, and questions only the
owner can settle. No source code was changed by the audit.

Line numbers are as of commit `d3f0297` plus the audit's doc edits.

## Doc right, code wrong

All four were fixed on 2026-11-27 (branch `token-maxxing-2026-11-27-guide-audit-code-fixes`), each with
a test that failed first, in the same commit.

### 1. A twin's id or a lower-case id in the `/adversary` URL never loads

**Fixed in `5c12d27`.** `useAdversary` keeps the id each detail answered and hands over only a detail
that answers the route id; the page, heading and count line trust it; the heading's roster fallback
matches any case and the twin id; App rewrites the address in place to the original's id.

- **Doc:** `docs/guide/adversary.md:45`: "A twin's id in the URL or in a tool argument means its
  original."
- **Code:** the route keeps the id as typed (`web/src/lib/route.ts:104`). The server resolves a
  twin and any case through `findPairing` (`src/adversary/readSql.ts:233-239`) and answers with the
  original's data, but the page renders only when
  `store.method.method.strategy_id !== strategy` is false (`web/src/pages/AdversaryPage.tsx:76`).
  So `/adversary/A-GT-CX` or `/adversary/a-gt` stays on "loading A-GT-CX" for good.
  `adversaryHeading` (`web/src/lib/adversary.ts:240-244`) has the same exact-match assumption.
- **Why the doc is the intent:** the server, the MCP tools (`src/mcp/adversaryTools.ts`) and
  `findPairing`'s own comment all promise twin and any-case resolution; the page is the only reader
  that does not follow it.
- **Confidence:** high on the behaviour, read from the code and not run.
- **Fix:** compare against the resolved original (or redirect the URL to
  `store.method.method.strategy_id`) instead of the raw route id.

### 2. A `/redo` counts against the daily reviewer cap

**Fixed in `df979f3`.** The redo's review row carries `redo: true` in its verdict jsonb (no
migration) and both counts (`countDeepSince`, `recent().usedToday` via `spentReview`) leave it out.

- **Doc:** `docs/guide/adversary.md:378`: "A redo costs no reviewer budget and is logged in
  `adversary_reviews` with zero tokens."
- **Code:** the redo's review row has status `ok` or `late` and `reusedFrom: null`
  (`src/adversary/service.ts:319-335`). The daily count takes every `ok`, `failed` or `late` row
  with no `reused_from` (`DEEP`, `src/adversary/reviewsRepo.ts:10` and `:82`; `usedToday` at
  `:96`). So each redo uses one of the day's `ADVERSARY_DAILY_CAP` reviews and raises
  `reviewer.used_today`.
- **Why the doc is the intent:** a redo runs on the Claude Code session's own usage, not the
  headless reviewer's. Its row records 0 tokens and $0 for that reason, and the cap is described as
  a cap on deep reviews. No test asserts either way (`tests/unit/adversary/redoService.test.ts`).
- **Confidence:** medium. Narrowing the doc would also settle it.
- **Fix:** mark redo rows (a `redo` status, or a flag) and leave them out of `DEEP`'s count.

### 3. The note-level Show in Explorer icon can show and then do nothing

**Fixed in `a6c97cd`.** `noteRevealPlan` selects the first photo on this machine (the first photo,
with its host in the 404, only when none is here).

- **Doc:** `docs/guide/wall.md:313`: "The icon appears only when it can work: the file must be on
  this machine ..."
- **Code:** for a note with photos and no files, `noteRevealable` shows the icon when **any** photo
  is on this machine (`web/src/lib/files.ts:171-175`), but the route always selects
  `note.images[0]` (`src/http/reveal.ts:277-279`). When the first photo is on the other machine and
  a later one is here, the click gets 404 `not_on_this_machine` and only logs a console warning.
- **Why the doc is the intent:** `NoteRevealButton.tsx` says it renders only when "`noteRevealable`
  says the route has something local to show": client and server were meant to agree.
- **Confidence:** high that they disagree; low impact (one note must hold photos from both machines).
- **Fix:** select the first available photo in `noteRevealPlan`.

### 4. `install.sh` does not check that `notes-link.mjs` exists

**Fixed in `1dc5566`.** Added to the loop; a test sources `install.sh` and runs `check_preconditions`
once per entry of `HOOK_SCRIPTS`.

- **Doc:** `docs/guide/install.md:51`: the installer "checks ... the hook scripts" before changing
  anything.
- **Code:** the precondition loop (`scripts/install.sh:157-160`) checks notes-capture, notes-paste,
  notes-prompt, notes-session, notes-spawn and the helper, not `claude/hooks/notes-link.mjs`. The
  hook merge (`scripts/claude-hooks.mjs`, `HOOK_SCRIPTS`) does check all six, but only after the
  daemon has been rebuilt and restarted.
- **Confidence:** high; most likely an omission from when notes-link was added. Low impact: the
  file exists today. Found independently by the install and the claude-code audits.
- **Fix:** add `"$HOOKS_DIR/notes-link.mjs"` to the loop.

## Stale strings in source and scripts (behaviour is right, the text is not)

All fixed on 2026-11-27; the last column names the commit.

| Where | What it says | What is true | Fixed |
| --- | --- | --- | --- |
| `src/mcp/dwordVocabTools.ts:432` (`dword_vocab_lookup`'s description, which Claude reads) | "a near-identical spelling (naïve/naive), returned as candidates" | A single word differing only in accents or case is **found** (`dedupKey` folds accents, `:298-301`); only a phrase such as `deja vu` / `déjà vu` comes back as candidates. `docs/guide/connectors.md` was fixed to match. | `ff38941`: description rewritten, pinned by `dword.vocab.curated.int.test.ts` |
| `src/chat/status.ts:146-153` | "The four curated dword tools", "all six of its tool names" | Five curated tools (`dword_journal_set_source` was added), seven names in all. | `7b4ecc0` |
| `src/chat/status.ts:176` | "the 6 movie tools" | Eight (`movies_pictures`, `movies_refresh`). | `7b4ecc0` |
| `src/sessions/replyEmbeddings.ts:108` | the reply worker sweeps "every sweep (60 s ...)" | `src/background.ts` passes no `sweepMs`, so it uses the 30-minute default (`DEFAULT_SWEEP_MS`); the guides say 30 minutes. | `7b4ecc0` |
| `.claude/skills/verify-notesd/scripts/movies/doc-check.sh:14-20` and on | requires a `README.md` Configuration row for every movies env var and an HTTP API row for every `/api/movies` path | Those tables moved to the generated `docs/guide/reference/`; the script would fail if run. Point it at `configuration.md` and `http-api.md`, or delete it (no feature file cites it). | `3d457d0`: deleted (`docs:check` covers it) |
| `docs/guide/reference/configuration.md:60` (hand-written, outside this audit's scope) | `DWORD_USER_EMAIL` is "Read at start"; names two tools as refusing | It is read on every call (`src/connectors/dword/user.ts`), and all five curated tools refuse. | `6c06315` |
| `.claude/skills/verify-notesd/scripts/verify.sh` (`up --adversary`) | does not pin `NOTESD_SEER_DISPATCH` | `scripts/docs/shots/adversary.mjs:20` pins it `off`. A throwaway run with the toggle on could try `gh workflow run` against Seer. It most likely fails because `SEER_DIR` is a scratch copy, but nothing guarantees it. `features/adversary.md` now tells the reader to pin it by hand. | `d05dd18`: pinned for every run, `tests/unit/scripts/verifyPins.test.ts` |

## For the owner to decide

1. **`install.sh` registers port 7317 whatever `NOTESD_PORT` says.** `PORT=7317` and
   `MCP_URL=http://localhost:$PORT/mcp` are fixed (`scripts/install.sh:55`, `:76`). The guide used
   to say a port change is picked up on re-install; it now says the port is fixed. If a daemon is
   ever run on another port, the MCP registration and the `/n` skill's wall links (taken from
   `claude mcp get notes`) would point at 7317.
2. **"Review now" never retries a pick whose review failed twice.** `planWork` skips it on manual
   passes too, unless `rereview` is set (`src/adversary/plan.ts:173`). No route or tool sets
   `rereview` (`src/http/adversaryApi.ts`), so the option is unreachable. The guide's "not retried
   automatically" (`docs/guide/adversary.md:261`) understates it. Either expose `rereview`, or the
   guide should say "not retried, even by Review now".
3. **The 50-a-day vocabulary limit is checked before the "already held" path**
   (`src/mcp/dwordVocabTools.ts:367`, before the collision handling at `:381-394`). Past the limit,
   a `dword_vocab_add` meant only to attach an origin sentence to a word already held is refused
   too. Nothing says whether that should be exempt.
4. **Dropped SVG and BMP files with no editor open** are sent to `POST /api/images` and refused
   with 415, logged only to the console (`DropOverlay.tsx`). The guide's "files that are not images
   are ignored" (`docs/guide/wall.md:158`) is right in effect; the editor's `routeFiles` filters them
   on the client, the drop overlay does not.

## What was fixed in the docs

Each guide's fixes, in short (the full per-claim reports were working files of the audit):

- **README.md, docs/guide/README.md:** photos and files live on disk, not in Postgres; "two
  machines, one database" is now one database per machine; reminders added to the Claude Code row;
  the chat agent has "most of" the same tools; most (not all) Movies pictures are real-library.
- **architecture.md:** the diagram and the limitations name the local `mcp-notes-pg` Postgres, not
  Neon; `daemon.ts`'s row; `image_path`/`image_meta` are cleared on a hard delete; a second link
  without a foreign key (`chat_message_attachments.ref_id`); the timer claim narrowed to the
  embedding and summary workers; node-postgres is also the local driver; `site-play`'s guard is the
  exception to same-origin; three missing background jobs and three missing pages; titles and
  ratings are shared only on one Postgres.
- **wall.md:** tags take ASCII letters only; tag suggestions open on `#`; Delete image closes the
  modal; `/full/<note id>` works only for a note made from a photo; each machine has its own
  database; Alt+C is Projects only; notes live in the local Postgres.
- **claude-code.md:** `/open` also opens movie ids; the MCP port is fixed at 7317; `/migrate` pins
  the `sonnet` alias; `related` and `similar_images` still answer from stored vectors without
  `OPENROUTER_API_KEY`.
- **search.md:** `search` takes `deleted`; deleted notes appear when asked for; session summaries
  are embedded by the summary worker.
- **chat.md:** three missing status captions, two missing allowed tools (`movies_refresh`,
  `direct_stream_health`), `remind` is not on the list, a picture id opens the picture, three more
  stripped child-environment variables.
- **sessions.md:** a short Jira key such as `QA-12` does match the node-id pattern; a fork is found
  by its first record uuid, on this machine only; a third words-only fallback (the query could not
  be embedded in time).
- **connectors.md:** the dword writer has five statements and five curated tools; `seer_schema`
  defaults to `both`; a single word differing in accents is found, only phrases come back as
  candidates; the repository default path; the drift test covers only `rules.ts`.
- **install.md:** the node lookup order; `embed:backfill` after `install.sh`; the missing "Local
  database" install step; a streaming site counts as a play being started; the `test:live:webStory`
  row.
- **adversary.md:** the nightly dispatch state is per machine; focus mode shows since when
  auto-runs are off, not which host turned them off.
- **movies.md:** eight `movies_*` tools, not seven; stories come from the web first and seasons
  have them too; a site play with no position is `in_progress`; Stream health's "No source named"
  channel; a refused VLC connection ends tracking at once; `movies_refresh` exists; a garbled
  sentence about `direct_stream_discover` restored.
- **docs/ROADMAP.md:** text storage is a Postgres on each machine since 2026-11-18.

The verify-notesd feature map (`.claude/skills/verify-notesd/features/`) gained `claude-code.md`,
`connectors.md` and `database.md`. Its index gained those and the unindexed `streaming.md`. Entries
were added to wall, recycle-bin, search, chat, images-files, projects, adversary, dword and movies
for every user-facing feature the guides describe that had no proof. Stale entries were corrected:
the wall's nonexistent font toggle, the bin's place on the rail, the adversary page's 120 s poll,
`/v` and `/j` not being captured, and seven dword tools, not six.

## Also fixed: the flaky Cache page timer test

**Fixed in `6b864bd`.** `CachePage.test.tsx`'s "reads the disk every 3 s while something downloads,
and every 15 s once nothing does" failed under load (expected 1 to be 2). The 3 s interval was set in a
passive effect; `findByRole` resolved as soon as the DOM showed "Downloading · 2", RTL drains with a
real `setTimeout(0)`, React's scheduler flushes passive effects with `setImmediate` in Node, and on a
loaded machine the timeout can win, so the test moved the fake clock while the 15 s interval still ran.
The interval is now set in a layout effect. Reproduced 2 of 12 runs before, 0 of 36 after, under the
same load. The page's second race, overlapping unawaited reads where an older answer landed last, is
fixed in the same commit (only the newest read's answer is kept), with its own test.
