# Projects: Claude Code session graph

## Sub-features
- Projects list (repo, session count, live count, last active), selected project.
- Per-project sessions: graph, tree, timeline views; node ids like `A0-3G`.
- Session search, usage (tokens), transcript (owning host only), resume (real tmux NOT driven here; background-job attach driven with a fake tmux, below).
- Session search matches a session's notes too (made ∪ linked, live notes only): a word or meaning
  only a session's note has finds that session, and the hit lists those notes in `via_notes`
  (`[{ id, excerpt }]`, best first, at most 3; `[]` when no note matched). Same in text mode. MCP
  `sessions_search` and `GET /api/sessions/search` both carry `via_notes`.
- Session search matches Claude's replies too (`cc_session_replies`, one per prompt: what Claude
  said after the turn's last tool call). A word or meaning only a reply has finds that session, and
  the hit lists those replies in `via_replies` (`[{ seq, excerpt }]`, where `seq` is the number of the
  prompt the reply answered and `excerpt` is the passage around the match; best first, at most 3;
  `[]` when none matched). Words work in every mode, including without a key. Meaning needs the reply's
  current vector (`cc_session_reply_embeddings`, filled in the background by the owning host). Note
  and reply evidence counts `BLEND.related` (0.6) times the session's own, so a session whose own
  summary or prompts answer ranks above one that only repeats the words in a long reply. MCP
  `sessions_search` and `GET /api/sessions/search` carry `via_replies`; the Projects chat agent is
  told to quote a reply excerpt with its node id and prompt number. No UI change (R5): there is no
  search box on `/projects`; the Projects chat (query pill bar) is the way in.
- Session search matches a session's commit messages: every commit subject (not the sha) is in the
  session's full-text index (`cc_sessions.search_tsv`, migration 0013) and in the text its vector
  is made from, so a word or meaning only a commit has finds that session, in text and hybrid
  mode. Vectors made before this (`cc_session_embeddings.text_version` 0) are rebuilt once by
  the owning host's summary worker after a restart, then never again.
- Link an existing note to a session (MCP `link_note` / `unlink_note`; Phase 1). Session notes =
  made ∪ linked, deduped (a note both made and linked is listed once as `made`), newest first, at most 50.
  Links live in `note_session_links`; purging a note from the bin (hard delete) drops its link rows
  (`on delete cascade`), a soft delete keeps them.
- Auto-link: the `notes-link` PostToolUse hook links every note a Claude Code session writes
  (`create`, `create_image`, `update`, `append`, `attach_image`) to that session through
  `POST /api/sessions/hook/link-note {session, note}` (loopback + X-Notes-Capture; 404
  unknown_session / not_found, 409 deleted). Proof: `tests/unit/hooks/notesLink.test.ts` and the
  link-note block of `tests/integration/sessionHooks.int.test.ts` (route plus hook end to end).
- A session's "Notes made": notes saved from it (`kind: "made"`) plus notes linked to it with MCP
  `link_note` (`kind: "linked"`, shown with a link icon labelled "Linked note"). A plain click on a
  note id opens it in the big editor (bigger-view-on-note) over `/projects`, or over the chat node
  pop-up; Esc / X / backdrop closes only the editor and the node panel stays. Ctrl/middle click still
  opens the wall on that note in a new tab.
- Summary on demand (R1, node panel section "Summary"). With no summary the section says why:
  "Empty session" (0 tokens), "Summarizes once idle" (this machine, waiting for 15 min idle),
  "Summary requested", "Will be summarized on <host>" (another machine), or "No summary yet"
  (older daemon). Where a summary can still be made (not empty, not already requested) an
  icon-only button "Summarize" records a request; the label flips to "Summary requested" at once
  and survives a reload (`cc_sessions.summary_requested_at`). API: session detail carries
  `summary_state` (`ready` | `empty` | `requested` | `idle_wait` | `other_host`) and
  `summary_requested_at`; same-origin `POST /api/sessions/:nodeId/summarize` answers 200
  `{ node_id, summary_state, summary_requested_at }`, idempotent; 409 `empty_session` for a
  0-token session; 400 `invalid_node_id` for a malformed node id; 404 `not_found`
  for an unknown one; 403 `forbidden_origin` without the page's Origin; a summarized node answers
  `ready` and records nothing. It never calls the model: the summary worker on the host that owns
  the session serves requests first on its next sweep (within 60 s), live sessions included, and
  the request clears when the summary is saved; the panel shows the summary when the graph poll
  sees it.
- Expand prompts (R2): the node panel's Prompts section has an icon-only "Expand prompts" button
  (shown when the session has a prompt). It opens a large modal (`role=dialog`, "Prompts of <NODE>")
  listing every stored prompt, numbered from 1, with its time and the full text, whitespace kept.
  Secrets are shown as `[redacted]`, and a prompt cut at the 256 KB storage ceiling is marked
  "truncated". "Copy prompt N" copies that prompt's text. "Copy all prompts" (top right) copies
  `1. <text>\n\n2. <text>…`. Both show a brief check mark. Images a prompt carried (pasted into
  Claude Code alongside its text) show as small clickable thumbnails under the prompt's text;
  clicking one opens the Lightbox scoped to that prompt's own images (arrow keys / Esc as
  elsewhere; Esc closes only the Lightbox first, leaving the Prompts modal open). Each image is a
  real `chat_images` row (`source: claude_code`), extracted from the transcript's base64 content
  blocks during normal tail ingestion and by the one-time `PROMPTS_VERSION` backfill for sessions
  ingested before this shipped (idempotent: `chat_images` dedupes by sha256, so re-extraction never
  duplicates a file). An image on another host than this daemon shows greyed with the tooltip "Not
  on this machine" instead of opening; it is served (and host-gated) exactly like a wall chat
  image, at `/api/chat/images/:id/{thumb,display}` — no separate route. Esc, X ("Close prompts") or
  a backdrop click closes only the modal; the node panel, `?node=` and the chat node pop-up stay.
  The modal reads `GET /api/sessions/:nodeId/prompts` (DB only, any host), now joined with
  `cc_session_prompt_images`/`chat_images` for the full-prompts case. A row its owning host has not
  backfilled yet shows its excerpts and the line "Full prompts arrive once <host> backfills"
  (`complete: false`, `incomplete_reason: not_backfilled`). A row whose transcript was pruned
  before the backfill shows its redacted excerpts and "Older prompts were cut; the full text is no
  longer on <host>" (`prompts_version` 1, `incomplete_reason: transcript_pruned`). Fixture:
  session `5e55a001-…-000000000005` (106 prompts, #50 over 2000 chars, #60 with a fake key shown
  as `[redacted]`); it adds a third node to the mcp-notes graph.
- Forks at ingest (`claude --resume X --fork-session`, background jobs): a fork is its own node,
  linked to the session it was copied from with parent link source `fork`, which no other source
  replaces. The parent comes from `<CLAUDE_HOME>/jobs/<first 8 of the fork's id>/state.json`
  (`fork_detected_by` `job`; `time` when only the job's `forkBoundaryAt` could cut it) or, with no
  job, from the rows of this host whose transcript starts with the same uuid (`uuid`; the longest
  shared prefix wins, so a fork of a fork links to that fork). The records the fork copied from its
  parent count nowhere in it: tokens, models, commits, files edited, plan docs, prompts, replies,
  first prompt, final message and start all come from its own records (`fork_cut_offset` is the
  byte its own records start at; `forked_at` and `fork_prompt_count` say where it split). A fork
  that so far holds only the copy shows 0 tokens and no prompts until its own records arrive. A
  session whose source cannot be found is an ordinary unlinked node. Proof:
  `tests/unit/sessions/ingestForks.test.ts`, `tests/integration/sessions.forks.int.test.ts`, and
  the "Forks at ingest" drive below. Fixture: `tests/fixtures/claude-home-forks` (generator
  `tests/fixtures/make-fork-fixtures.mjs`), a separate home so the main fixture's counts stay put.
  Forks ingested before fork handling are linked and cut once per host on the first daemon start
  with it (the fork backfill, marker `sessions.forks.backfill.<host>` in `app_settings`; proof
  `tests/integration/sessions.forkBackfill.int.test.ts`).
- Forks and background jobs in the session tools (session-fork-awareness phase 5). A fork (a
  session Claude Code copied from another with `--fork-session`, or a background job forked from
  one) has `parent_link_source: "fork"` and `fork: { parent_node_id, forked_at, prompt_count }` on
  every API node shape (graph `nodes[]`, detail `session` / `parent` / `children[]`, search `hits[]`);
  every other node has `fork: null`. MCP `session_get` (`session.fork_of`) and `sessions_search`
  (`hits[].fork_of`) say `fork of <parent node id> (after prompt N, <YYYY-MM-DD HH:mm> <zone>)`,
  and the prompt hook's context block prints `Fork of …` instead of `Parent: … (fork link)`.
  `session_transcript` and `GET /api/sessions/:nodeId/transcript` on a fork search only what the
  fork added: records copied from the parent are skipped, `starts_at_fork_point: true`, and `line`
  stays the file's line number. A session live on this host as a Claude Code background job
  (registry `kind: "bg"`) carries `job_id`. Its hook context reads `Transcript: <path> (attach
  with: claude attach <jobId>)`, and `session_get` gives `session.resume_command: "claude attach
  <jobId>"` (otherwise `claude --resume <session id>`, and null for another host's session).
- Forks (session-fork-awareness R4.2): a Claude Code fork (`--fork-session`, background jobs) is
  its own node and a child of the session it was forked from (`parent_link_source: "fork"`). The
  graph draws its edge as round dots in the id colour (`path.gedge.fork`, `data-edge=<fork session id>`)
  and marks its row with an icon-only GitFork badge left of the node id (`data-testid="fork-badge"`,
  aria-label `fork of <parent>`, hover text `forked from <parent> after prompt N`). The node panel's
  parent line reads `forked from <parent> after prompt N · <fork time> · <parent title>`. API: graph
  nodes and session detail carry `fork: { parent_node_id, forked_at, prompt_count } | null`.
- Background jobs (R3.5): a session live as a Claude Code background job (`job_id` set, live only)
  shows the resume button as "Attach to the background session". An `attached` answer shows
  `Opened claude attach <jobId> in <window>` (plus `; prompt not sent, type it there` when
  `prompt_delivered` is false). A focused/messaged attach pane names the job too. A 409 for a live job
  shows `<NODE> is background job <jobId>: run claude attach <jobId>`, never the raw code.

## How to get to it (user POV)
Wall sidebar `Projects` → `/projects`, click a node → the node panel (`aside.np`), section
"Notes made". Claude Code: MCP `sessions_search`, `session_get`, `session_transcript`,
`sessions_usage`; `/n link 5-BW7 into 5U-I7` (MCP `link_note` / `unlink_note`).

## Driving it with verify.sh
```sh
$V up --sessions --web            # ingests tests/fixtures/claude-home: repos mcp-notes, wall-editing
$V api RUN GET /api/projects      # both repos listed
$V api RUN GET /api/projects/mcp-notes/sessions
$V mcp RUN sessions_usage '{}'
```
UI: `page.goto(base + '/projects')`, wait for `getByRole('group', { name: 'Session graph' })`, toggle with `project-view-toggle`.

Session notes. Node ids and session ids are generated at ingest, so read them from the run; never
type one in. `URL` is what `up` printed.
```sh
S=$(curl -sf --retry 30 --retry-delay 1 --retry-all-errors "$URL/api/projects/mcp-notes/sessions")
NODE=$(jq -r '.nodes[0].node_id' <<<"$S"); SID=$(jq -r '.nodes[0].session_id' <<<"$S")
MADE=$($V mcp RUN create "{\"body\":\"made in a fixture session #verify\",\"origin\":{\"claude_session\":\"$SID\"}}" | sed 1d | jq -r .note.id)
LINKED=$($V mcp RUN create '{"body":"saved elsewhere #verify"}' | sed 1d | jq -r .note.id)
$V mcp RUN link_note "{\"note_id\":\"$LINKED\",\"node_id\":\"$NODE\"}"
$V mcp RUN session_get "{\"node_id\":\"$NODE\"}"     # notes: MADE kind "made", LINKED kind "linked"
$V mcp RUN sessions_search '{"query":"saved elsewhere"}'   # NODE first, via_notes lists LINKED
# Only after the UI steps below (it removes LINKED from the panel):
$V mcp RUN unlink_note "{\"note_id\":\"$LINKED\",\"node_id\":\"$NODE\"}"   # {linked:false, changed:true}; again -> changed:false
$V sql RUN "select note_id, session_id from note_session_links"   # read-only check of the link table
```
Results: `link_note` / `unlink_note` → `{ note_id, node_id, session_id, linked, changed, made }`. Errors:
`not_found: Note …`, `not_found: no session …`, `invalid_node_id: …`, `deleted: Note … is deleted` (link only;
unlink works on a deleted note).
UI selectors (pass ids to the steps file through the environment: `NODE=$NODE LINKED=$LINKED $V ui RUN steps.mjs`):
- `page.goto(base + '/projects?repo=mcp-notes&node=' + NODE)`
- node panel: `page.locator('aside.np[data-node="' + NODE + '"]')`; its notes: `.getByRole('region', { name: 'Notes made' })`
- a note: `.getByRole('link', { name: LINKED, exact: true })`; the icon: `getByRole('img', { name: 'Linked note' })` inside that `li`
- the editor: `page.getByRole('dialog', { name: 'Edit note ' + LINKED })`, text box `getByLabel('Note text')`

Commit messages in search. Fixture `5e55a001-…-000000000001` committed `feat(sessions): ingest
transcripts`; `feat` appears nowhere else in its indexed text (only in tool output, which is not
indexed), so it is a commit-only word:
```sh
NOTESD_CLAUDE_BIN=/nonexistent/claude $V up --sessions
S=$(curl -sf --retry 30 --retry-delay 1 --retry-all-errors "$URL/api/projects/mcp-notes/sessions")
NODE=$(jq -r '.nodes[] | select(.session_id=="5e55a001-0000-4000-8000-000000000001") | .node_id' <<<"$S")
$V sql RUN "select node_id, commits from cc_sessions where session_id = '5e55a001-0000-4000-8000-000000000001'"
$V mcp RUN sessions_search '{"query":"feat"}'        # mode "text" (fallback), hits contain NODE
$V api RUN GET '/api/sessions/search?q=feat'         # same NODE in .hits
$V sql RUN "select indexdef from pg_indexes where indexname = 'cc_sessions_search_gin'"   # gin (search_tsv)
```
With `--embed` (billed, a few embeddings) the vectors carry the version:
`$V sql RUN "select count(*) filter (where text_version = 1) as cur, count(*) as all from cc_session_embeddings where embedding is not null"`
→ `cur = all`. "Rebuilt once, then never again" needs a daemon restart, which `verify.sh` has no
command for: it is proven by `tests/integration/sessions.commitSearch.int.test.ts`.

Replies in search. Seed one reply with a word nothing else has (fixture replies are real ingest
output, but a seeded row keeps the word unique). Prompt 9001 is far past any fixture prompt:
```sh
NOTESD_CLAUDE_BIN=/nonexistent/claude $V up --sessions
SID=5e55a001-0000-4000-8000-000000000001
S=$(curl -sf --retry 30 --retry-delay 1 --retry-all-errors "$URL/api/projects/mcp-notes/sessions")
NODE=$(jq -r --arg s "$SID" '.nodes[] | select(.session_id==$s) | .node_id' <<<"$S")
$V exec RUN "insert into cc_session_prompts (session_id, seq, at, text, truncated) values ('$SID', 9001, now(), 'why is the cache stale?', false) on conflict do nothing"
$V exec RUN "insert into cc_session_replies (session_id, seq, at, text, truncated) values ('$SID', 9001, now(), 'The wombat cache was stale because its key ignored the repo. I keyed it by repo and node id, and the stale entries are gone.', false)"
$V mcp RUN sessions_search '{"query":"wombat"}'     # hits[0].node_id NODE, via_replies [{seq: 9001, excerpt "…wombat…"}], mode "text"
$V api RUN GET '/api/sessions/search?q=wombat'      # same via_replies
$V sql RUN "select session_id, seq, left(text, 60) from cc_session_replies order by session_id, seq"
```
With `--embed` (billed, a few embeddings) the reply worker gives row 9001 a vector within about a
minute (`select embedding is not null from cc_session_reply_embeddings where seq = 9001`). A
meaning-only query such as `"why did lookups return outdated data for another project"` then lists
NODE with `via_replies` seq 9001 in `mode: "hybrid"`. The weight itself is proven by
`tests/integration/sessions.relatedEvidence.int.test.ts`, not on a run.

Summary requests. Start the run with the summarizer off so nothing is billed and the request stays
visible (`NOTESD_CLAUDE_BIN` pointing nowhere turns summaries off; the daemon log says so):
```sh
NOTESD_CLAUDE_BIN=/nonexistent/claude $V up --sessions
S=$(curl -sf --retry 30 --retry-delay 1 --retry-all-errors "$URL/api/projects/mcp-notes/sessions")
NODE=$(jq -r '.nodes[] | select(.session_id=="5e55a001-0000-4000-8000-000000000001") | .node_id' <<<"$S")
$V api RUN GET /api/sessions/$NODE                # session.summary_state "idle_wait"
$V api RUN POST /api/sessions/$NODE/summarize     # 200 summary_state "requested", summary_requested_at set
$V api RUN POST /api/sessions/$NODE/summarize     # same body again (idempotent)
$V api RUN POST /api/sessions/ZZ-ZZ/summarize     # 404 not_found
$V api RUN POST /api/sessions/A-B32/summarize     # 400 invalid_node_id
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL/api/sessions/$NODE/summarize"   # 403: no Origin
$V sql RUN "select node_id, summary_requested_at from cc_sessions where summary_requested_at is not null"
```
No fixture node has 0 tokens (fixture `…0003` is an `sdk-cli` session, which ingest skips), so the
409 `empty_session` answer is proven by `tests/integration/sessions.api.int.test.ts`, not on a run.

Summarize in the wall. Start the run with the summarizer off, so nothing summarizes the fixtures
behind the check (and nothing bills): `NOTESD_CLAUDE_BIN=/nonexistent/claude $V up --sessions --web`
(real env wins over `.env.local`; `daemon.log` then says `session summaries off`). Pick a node
with tokens and no summary, read its state, drive the click, read the row back:
```sh
S=$(curl -sf --retry 30 --retry-delay 1 --retry-all-errors "$URL/api/projects/mcp-notes/sessions")
NODE=$(jq -r '[.nodes[] | select(.summary_excerpt == null and (.tokens.input + .tokens.output + .tokens.cache_read + .tokens.cache_write) > 0)][0].node_id' <<<"$S")
curl -sf "$URL/api/sessions/$NODE" | jq -r '.session.summary_state'        # idle_wait
NODE=$NODE $V ui RUN summarize-steps.mjs
curl -sf "$URL/api/sessions/$NODE" | jq -r '.session.summary_state'        # requested
$V sql RUN "select node_id, summary_requested_at from cc_sessions where node_id = '$NODE'"   # timestamp, not null
```
UI selectors: panel `page.locator('aside.np[data-node="' + NODE + '"]')`; section
`.getByRole('region', { name: 'Summary' })`; button `.getByRole('button', { name: 'Summarize' })`;
labels by text (`'Summarizes once idle'`, `'Summary requested'`, `'Empty session'`,
`'Will be summarized on GPD'`).

Expand prompts. The fixture session with more than 100 prompts (one over 2000 chars, one with a fake
`sk-ant-` key) is in repo `mcp-notes`; find it by its prompt count, never by a typed id:
```sh
BIG=""; for i in $(seq 30); do
  for n in $(curl -sf "$URL/api/projects/mcp-notes/sessions" | jq -r '.nodes[].node_id'); do
    [ "$(curl -sf "$URL/api/sessions/$n/prompts" | jq '.prompts | length')" -gt 100 ] && BIG=$n
  done; [ -n "$BIG" ] && break; sleep 1; done; echo "BIG=$BIG"
$V api RUN GET /api/sessions/$BIG/prompts      # complete:true, n = 1..N, one text > 2000 chars, "[redacted]", no "sk-ant-"
$V sql RUN "select count(*) from cc_session_prompts p join cc_sessions s using (session_id) where s.node_id = '$BIG'"
$V api RUN GET /api/sessions/ZZ-ZZ/prompts     # 404 not_found; A-B32 -> 400 invalid_node_id
```
UI selectors (pass ids through the environment: `NODE=$BIG PROMPTS_JSON=<file> $V ui RUN steps.mjs`):
- expand: `panel.getByRole('region', { name: 'Prompts' }).getByRole('button', { name: 'Expand prompts' })`
- modal: `page.getByRole('dialog', { name: 'Prompts of ' + NODE })`; rows `li.prm-item[data-n="N"]`, text `.prm-text`
- copy: `getByRole('button', { name: 'Copy prompt 1', exact: true })` (exact, or it also matches 10, 11, …), `'Copy all prompts'`
- backdrop: `page.locator('[data-modal="prompts"]').dispatchEvent('click')`

Pasted images on a prompt. Extraction out of a real transcript's base64 blocks is proven by
`tests/unit/sessions/transcript.test.ts` (`extractImages`) and the `pasted-image prompts` describe
block of `tests/integration/sessions.repo.int.test.ts` (storage, sha256 dedupe, from-byte-0 relink,
a corrupt paste dropped without losing the prompt's text) — all against a real Postgres and a real
temp data dir, not a run. To check the read side (API shape, thumbnail, Lightbox) on a run, seed a
`chat_images` row and a `cc_session_prompt_images` link directly rather than crafting a fixture
transcript with a real base64 image block:
```sh
$V exec RUN "insert into chat_images (id, path, sha256, mime, width, height, bytes, host, source) values ('A-IMG1', 'chat-images/2026/11/A-IMG1.png', repeat('a', 64), 'image/png', 12, 8, 100, '<RUN's host>', 'claude_code')"
$V exec RUN "insert into cc_session_prompt_images (session_id, prompt_seq, position, image_id, paste_id) values ('<a seeded session_id>', 1, 0, 'A-IMG1', 1)"
$V api RUN GET /api/sessions/$NODE/prompts   # prompts[0].images: [{id:"A-IMG1", width:12, height:8, available:true, urls:{thumb,display}}]
```
UI: `panel.getByRole('button', { name: /Open pasted image/ })` inside `li.prm-item[data-n="1"]`;
clicking opens `page.getByRole('dialog', { name: 'Image viewer' })`. `path` need not exist on disk
for this read-side check (`available` is a host-string compare, not a file probe); the thumbnail
`<img>` itself will 404 since there is no real file, which is fine for proving the API/DOM wiring.

## Resume of a live background job (fake tmux)
A session live as a Claude Code background job (registry `kind: "bg"`, `jobId`) resumes by opening
a tmux window running `claude attach <jobId>` (`action: "attached"`, `job_id`), then focuses that
pane on the next ask (`focused`/`messaged` + `job_id`). A prompt with no attach pane answers
`prompt_delivered: false`. A live non-background session outside tmux stays 409 `live_outside_tmux`.

Never run real tmux or claude from a verify run. Point `NOTESD_TMUX_BIN` at a fake that logs argv
and keeps a pane list, and `NOTESD_CLAUDE_BIN` nowhere; `up` passes the caller's env through:
```sh
F=$SCRATCH/faketmux; mkdir -p $F && : >$F/panes && : >$F/calls.log
cat >$F/tmux <<'EOF'
#!/usr/bin/env bash
D="${FAKE_TMUX_DIR:?}"; printf '%s\n' "$*" >>"$D/calls.log"
[ "$1" = -S ] && shift 2
case "$1" in
  list-sessions) echo "100 note" ;;
  list-clients) echo "1 /dev/pts/9" ;;
  show-environment) echo "PATH=/usr/bin:/bin" ;;
  list-panes) if [[ "$*" == *pane_start_command* ]]; then cat "$D/panes"; else cut -d' ' -f1 "$D/panes"; fi ;;
  new-window) n="%$(( 50 + $(wc -l <"$D/panes") ))"; while [ "$#" -gt 0 ] && [ "$1" != "-F" ]; do shift; done; shift 2
              echo "$n $*" >>"$D/panes"; echo "note:5 $n" ;;
  display-message) if [[ "$*" == *pane_in_mode* ]]; then echo 0; else echo note:5; fi ;;
esac
EOF
chmod +x $F/tmux
FAKE_TMUX_DIR=$F NOTESD_TMUX_BIN=$F/tmux NOTESD_CLAUDE_BIN=/nonexistent/claude $V up --sessions
sleep 600 & JOBPID=$!     # stands in for the background job's process (pid must be alive)
SID=5e55a001-0000-4000-8000-000000000005
NODE=$($V sql RUN "select node_id from cc_sessions where session_id='$SID'" | grep -oE '^ [0-9A-Z]{2}-[0-9A-Z]{2}$' | tr -d ' ')   # anchored: the echoed query holds the uuid
echo "{\"pid\":$JOBPID,\"sessionId\":\"$SID\",\"kind\":\"bg\",\"jobId\":\"5e55a001\",\"updatedAt\":9999999999999}" \
  >~/.local/state/notesd-verify/RUN/claude/sessions/$JOBPID.json
$V api RUN POST /api/sessions/$NODE/resume '{}'            # attached, job_id 5e55a001; panes gains "%50 ... attach 5e55a001"
$V api RUN POST /api/sessions/$NODE/resume '{"prompt":"hi"}'  # messaged, job_id; calls.log: paste-buffer ... -t %50
```
`kill $JOBPID` afterwards. The same flow is unit-tested in `tests/unit/sessions/resume.test.ts`
(`background jobs`).

Forks at ingest. The fork fixtures are copied into the run's `CLAUDE_HOME` in order, parent first,
because a fork without a job record is found through its parent's row:
```sh
NOTESD_CLAUDE_BIN=/nonexistent/claude $V up --sessions      # note RUN and URL
CH="$HOME/.local/state/notesd-verify/$RUN/claude"; FX=tests/fixtures/claude-home-forks; PD=projects/-home-u-mcp-notes
P=f0a0a001-0000-4000-8000-000000000001; J=f0b0b001-0000-4000-8000-000000000002; T=f0c0c001-0000-4000-8000-000000000003
TT=f0d0d001-0000-4000-8000-000000000004; PEND=f0f0f001-0000-4000-8000-000000000005; U=f0e0e001-0000-4000-8000-000000000006
seen() { for i in $(seq 90); do curl -sf "$URL/api/projects/mcp-notes/sessions" | jq -e --arg s "$1" '.nodes[] | select(.session_id == $s)' >/dev/null && return 0; sleep 1; done; echo "timed out: $1"; return 1; }
cp "$FX/$PD/$P.jsonl" "$CH/$PD/" && seen $P
cp -r "$FX/jobs" "$CH/" && cp "$FX/$PD/$J.jsonl" "$FX/$PD/$T.jsonl" "$FX/$PD/$PEND.jsonl" "$FX/$PD/$U.jsonl" "$CH/$PD/" && seen $J && seen $T && seen $PEND && seen $U
cp "$FX/$PD/$TT.jsonl" "$CH/$PD/" && seen $TT
$V sql $RUN "select session_id, parent_session_id, parent_link_source, fork_detected_by, fork_prompt_count, input_tokens, output_tokens, jsonb_path_query_array(commits, '\$[*].sha')::text as shas from cc_sessions where session_id like 'f0%' order by session_id"
```
Expected: `f0b0…` (job) → parent `f0a0…`, `fork`, `job`, 2, 130/13, `["0d0e0f1"]`; `f0c0…` (terminal) → `f0a0…`,
`fork`, `uuid`, 2, 50/5, `[]`; `f0d0…` (fork of a fork) → `f0c0…`, `fork`, `uuid`, 3, 7/7; `f0f0…` (pending) →
`f0a0…`, `fork`, `job`, 2, 0/0, `[]`; `f0e0…` (unrelated, unreadable job record) → no parent, 9/9; `f0a0…`
(parent) → no parent, 1000/100, `["a1b2c3d"]`. Then give the pending fork its own records:
`cat "$FX/appends/$PEND.own.jsonl" >> "$CH/$PD/$PEND.jsonl"` and its node's `tokens.input` becomes 11.
Forks and background jobs in the tools and hook context. The fixtures hold no fork, so the run
seeds one. It makes fixture `…0005` a fork of `…0001` cut after its first copied prompt/reply pair
(lines 2-3), and makes it a live background job by writing a registry entry for a running `sleep`.
Nothing is billed:
```sh
NOTESD_CLAUDE_BIN=/nonexistent/claude $V up --sessions
P=5e55a001-0000-4000-8000-000000000001; F=5e55a001-0000-4000-8000-000000000005
S=$(curl -sf --retry 30 --retry-delay 1 --retry-all-errors "$URL/api/projects/mcp-notes/sessions")
PN=$(jq -r --arg s $P '.nodes[] | select(.session_id==$s) | .node_id' <<<"$S"); FN=$(jq -r --arg s $F '.nodes[] | select(.session_id==$s) | .node_id' <<<"$S")
CUT=$(head -n 3 tests/fixtures/claude-home/projects/-home-u-mcp-notes/$F.jsonl | wc -c)
for i in $(seq 20); do $V sql RUN "select key from app_settings where key like 'sessions.forks.backfill.%'" | grep -q 'sessions.forks.backfill.' && break; sleep 1; done   # with phase 3 in the tree: seed after the fork backfill
$V exec RUN "update cc_sessions set parent_session_id='$P', parent_link_source='fork', forked_at='2026-10-20T01:02:30Z', fork_prompt_count=1, fork_cut_offset=$CUT, fork_detected_by='uuid', updated_at=now() where session_id='$F'"
$V mcp RUN session_transcript "$(jq -nc --arg n $FN '{node_id:$n, query:"\"step 1 of\""}')"   # total_matches 0, starts_at_fork_point true
$V mcp RUN session_transcript "$(jq -nc --arg n $FN '{node_id:$n, query:"\"step 2 of\""}')"   # 1 match, line 4
$V mcp RUN session_get "{\"node_id\":\"$FN\"}"        # session.fork_of "fork of $PN (after prompt 1, 2026-10-20 …)"
curl -sf "$URL/api/sessions/context?ids=$FN" | jq -r .context   # "Fork of $PN (after prompt 1, …)"
sleep 900 >/dev/null 2>&1 & JOBPID=$!
printf '{"pid":%d,"sessionId":"%s","kind":"bg","jobId":"5e55a005","status":"idle"}\n' $JOBPID $F > "$(dirname "$EVIDENCE")/claude/sessions/$JOBPID.json"
curl -sf "$URL/api/sessions/context?ids=$FN" | jq -r .context   # "(attach with: claude attach 5e55a005)"
$V mcp RUN session_get "{\"node_id\":\"$FN\"}"        # session.job_id "5e55a005", resume_command "claude attach 5e55a005"
kill $JOBPID
```
The same checks with assertions are `tests/integration/sessions.forkWording.int.test.ts`.

Forks and background jobs in the wall. The fixtures hold no fork, so seed one after ingest settles:
fixture `…0005` becomes a fork of `…0001` that copied 3 prompts. A live background job is a registry
file in the run's own CLAUDE_HOME whose pid is a `sleep` you started (never the real `~/.claude`).
Resume is never driven: the steps file answers the resume POST itself with `page.route`.
```sh
NOTESD_CLAUDE_BIN=/nonexistent/claude $V up --sessions --web
P=5e55a001-0000-4000-8000-000000000001; F=5e55a001-0000-4000-8000-000000000005
for i in $(seq 60); do S=$(curl -sf "$URL/api/projects/mcp-notes/sessions") && [ "$(jq --arg f $F '[.nodes[]|select(.session_id==$f)]|length' <<<"$S")" = 1 ] && break; sleep 1; done
PARENT=$(jq -r --arg s $P '.nodes[]|select(.session_id==$s)|.node_id' <<<"$S"); FORK=$(jq -r --arg s $F '.nodes[]|select(.session_id==$s)|.node_id' <<<"$S")
for i in $(seq 20); do $V sql RUN "select key from app_settings where key like 'sessions.forks.backfill.%'" | grep -q 'sessions.forks.backfill.' && break; sleep 1; done   # with phase 3 in the tree: seed after the fork backfill
$V exec RUN "update cc_sessions set parent_session_id='$P', parent_link_source='fork', forked_at='2026-10-01T12:30:00Z', fork_prompt_count=3, fork_cut_offset=0, fork_detected_by='job' where session_id='$F'"
$V api RUN GET /api/projects/mcp-notes/sessions     # FORK: parent_node_id PARENT, parent_link_source "fork", fork.prompt_count 3
sleep 900 & JOBPID=$!
echo "{\"pid\":$JOBPID,\"sessionId\":\"$F\",\"cwd\":\"/home/u/mcp-notes\",\"kind\":\"bg\",\"jobId\":\"5e55a005\",\"status\":\"idle\"}" > "$HOME/.local/state/notesd-verify/RUN/claude/sessions/$JOBPID.json"
$V api RUN GET /api/sessions/$FORK                   # session.live true, session.job_id "5e55a005" (registry cache: up to 2 s)
kill $JOBPID
```
UI selectors: row `g[data-node="<FORK>"]`, badge `getByTestId('fork-badge')` in it, edge
`path[data-edge="<fork session id>"]` (class `gedge fork`), panel `aside.np[data-node="<FORK>"]`,
parent line `.np-parent`, resume button `getByRole('button', { name: 'Attach to the background session' })`,
notice `getByRole('status')`.

## Gotchas
- Ingest is a background tail; allow a few seconds after `up` before asserting (the `curl --retry`
  above waits for it; `/api/projects/<repo>/sessions` is 404 until the repo has a session).
- New ingest behavior needs a new fixture in `tests/fixtures/claude-home`, never the real `~/.claude`.
- Never drive `resume`: it spawns real Claude sessions.
- The node panel loads session detail when it opens; after `link_note`, reload the page (or reopen
  the node) before asserting the new note is listed. A link change sends no SSE event.
- A note's row: `notes.locator('li').filter({ has: page.getByRole('link', { name: ID, exact: true }) })`. A `has`
  locator chained from `notes` never matches: Playwright resolves `has` inside each `li`.
- `$V mcp` prints a `> tool args` line first; strip it (`sed 1d`) before `jq`.
- The verify daemon finds the real `claude` binary unless `NOTESD_CLAUDE_BIN` points nowhere; then
  its summary worker runs Haiku on the fixtures (billed, nondeterministic). Assert the request
  (label, `summary_state`, `summary_requested_at`), never the Haiku output. "The worker serves a
  request" is proven by `tests/unit/sessions/summaryWorker.test.ts` and
  `tests/integration/sessions.summaries.int.test.ts`; "Empty session" and "Will be summarized on
  <host>" need a 0-token row and a row of another host, which the fixtures do not have: cover them
  in `tests/integration/sessions.api.int.test.ts` and the jsdom tests, not on a run.
- Headless chromium has no clipboard permission: to check what a copy button copied, stub
  `navigator.clipboard.writeText` with `page.addInitScript` before `goto` and read the stub back.
- Compare a prompt with `.prm-text` `textContent()`, not `innerText()`: textContent keeps the
  prompt's whitespace byte for byte.
