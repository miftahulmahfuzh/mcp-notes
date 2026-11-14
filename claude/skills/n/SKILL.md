---
name: n
description: The user's personal notes system, mcp-notes, reached through the `notes` MCP server, which also reads the user's own apps read-only — expense-tracking (spending in rupiah), run-insights (Apple Watch runs, the app's run analyses and weekly/monthly reviews, coach Nina) and Seer (trading lab, leaderboard, positions, Sera methods) — and keeps their movie and TV library (what they watched and when, VLC playback). Use whenever the user types "/n <request>" from any repo, and when they ask to save, find, read, edit, tag, delete, restore, compare or summarize their notes or look at, attach or remove pictures in them, or link a note to a Claude Code session ("save this session's insights as a note", "what was my last #v250 note", "check note A-B32", "summarize #seer this week vs last week", "show me the pictures I saved on 30 oct", "show me the pictures in note A-B32", "attach this screenshot to note A-B32", "link 5-BW7 into 5U-I7"), or ask about their spending, expenses, runs or Seer ("how is my spending this week", "how did yesterday's run go", "compare my running this month with last month", "what are the best Sera methods so far", "what's on the Seer leaderboard"), or about their movies and series ("which MobLand episode did I watch last", "continue MobLand", "recommend other Margaret Qualley films").
argument-hint: <request for mcp-notes>
---

# /n — mcp-notes

The text after `/n` is a request for mcp-notes, the user's own notes store, or for one of the
user's apps that the same server reads. Do it with the `notes` MCP server's tools (they appear
as `mcp__notes__<tool>`). Do not answer from memory, from files in the current repo, or from
earlier conversation when the request is about notes, spending, runs or Seer: the notes and the
apps' tools are the source of truth.

## What a note is

- One plain-text body. No title, no fields, no structure.
- Tags are the `#hashtags` inside the body (`#seer`, `#v250`, `#from_phone`). The server
  re-parses them on every write: letters, digits, `_` and `-`, lower-cased, and a `#` glued to
  a word (`C#`, `a#b`) is not a tag. To add a tag, put `#tag` in the body. To remove one, take it
  out of the body.
- Ids look like `A-B32`: one character, a dash, three characters, all `0-9A-Z`. Lookup is
  case-insensitive and tolerates a missing dash, so `ab32` finds `A-B32`.
- Every edit keeps the previous body as a revision; deletes are soft and can be restored.
- A note may hold several images (local files on the machine that saved them), in the order
  they were added. Every note in a result has an `images` list (empty for a text note). Each
  image has its own image id (the same `A-B32` form as note ids; a note's first image has the
  note's own id), a `position`, metadata (`mime`, size, `taken_at`, `original_name`, `host`) and
  `available`.
- A note may also hold files that are not pictures (PDFs, documents, archives, anything), added
  by the user on the wall. Every note in a result has a `files` list (empty when it has none);
  each file has an id, `name`, `mime`, `bytes`, `host`, `available` and `extraction_status`.

## Tools

The spine tools are `create`, `get` (one or several ids), `update` (full body replace),
`append`, `delete` (soft), `restore`, `list` (tag any/all filters, created/updated date range,
newest first, limit + cursor), `search` (ranked by meaning and by words, with tag and date
filters; `mode: "text"` for exact words only), `related` (the notes nearest in meaning to one
note id, with a similarity score), `tags` (every tag with count and last-used date),
`revisions` and `revert`. The image tools are `create_image` (a new note from a local file
path, or from a pasted image's id), `attach_image` (add a local file or a pasted image to an
existing note), `remove_image` and
`restore_image` (take one image out of its note, softly, and put it back), `view_images` (see
the images of notes, or single images), `similar_images` (the pictures that look most like one
picture, or that match a description), and the `has_image` / taken-date filters on `list` and
`search`. Use them as described under Images. Always follow each tool's own schema and
description for parameter names and formats; they win over anything written here.

## Saving

- Pass `origin` on every `create` and `update`: `cwd` = the current working directory, `repo` =
  the basename of the git top-level (`basename "$(git rev-parse --show-toplevel)"`, omit it when
  the cwd is not in a git repo), and `claude_session` only if you actually know this session's
  id. Never invent one.
- Bodies are plain text. No markdown: no `#` headings (a `#word` heading becomes a tag), no
  `**bold**`, no backtick fences, no tables, no links. Line breaks and a plain `- ` at the start
  of a line are fine. Code tokens, paths, commands and ids are fine inline; write ids bare
  (`A-B32`), never as the wall links used in replies.
- End a note with its hashtags on the last line, chosen by you: the repo name when the note is
  about a repo, the system or topic (`#seer`, `#v250`), and the kind of thing it is
  (`#bug`, `#decision`, `#howto`) when that helps finding it later. Reuse existing tags: call
  `tags` first when unsure what the user already uses, and prefer their spelling.
- Never put secrets in a note: tokens, passwords, API keys, connection strings.
- The notes-link hook links every note you write here to this session's node: it runs after each
  successful `create`, `create_image`, `update`, `append` and `attach_image`. **Never take that on
  faith — verify it.** See "Verify the link" below. Call `link_note` for another node only when the
  user names one ("link it to 5U-I7"), and `unlink_note` when they say this note should not be
  linked here.

### Verify the link, every write

A link is reported only when a call in this turn returned `linked: true`. MEASURED 2026-11-11: a
session whose notes tools were hidden by a settings deny list wrote a note by another route, the
hook never ran, and the reply said "Linked to session" anyway because this skill told it to.

1. After the write, call `link_note` with the note id and this session's node id (the one the
   SessionStart context names). It is idempotent, so this is the check and the retry in one call:
   `linked: true, changed: false` means the hook had linked it; `changed: true` means the hook had
   not and this call did — say so in one line. A hook message "notes-link: note X was saved but NOT
   linked" means the same: this call is the retry.
2. If `link_note` is not available in this session or fails, retry another way: POST to the
   daemon, `curl -s -m 5 -X POST <wall>/api/sessions/hook/link-note -H 'content-type:
   application/json' -H 'x-notes-capture: 1' -d '{"session":"<session uuid>","note":"<id>"}'` (the
   session uuid is in the SessionStart context or the transcript path; the answer carries
   `node_id` and `changed`). A note whose `origin.claude_session` is this session is listed under
   its node as `made` even without the link, so pass the real session id in `origin` whenever you
   know it.
3. If every route fails, say plainly that the note is saved but not linked, with the note id, the
   node id and the error, so it can be linked later. Never write a "Linked to session" line that no
   call confirmed.

If the notes write tools are missing altogether while `claude mcp get notes` says Connected, look
for a `permissions.deny` list in the repo's `.claude/settings.local.json` or `.claude/settings.json`
naming `mcp__notes__*` before anything else.

### "Save this session's insights"

Write one dense plain-text note that someone (the user, or a later Claude session) can act on
without this conversation: what the work was, what was decided and why, what was tried and did
not work, the commands, paths, versions and note ids worth keeping, and what is still open. No
narration of the chat, no filler, no markdown. Hashtags on the last line. Save it with `create`
and `origin`, then reply with the new id and a two-line summary of what it holds.

## Finding and reading

- A note id in the request (`A-B32`, `ab32`) → `get` it.
- "Notes tagged X", "my last note about X" → `list` filtered by that tag, newest first, small
  limit. A tag filter needs the tag without `#`, unless the tool schema says otherwise.
- Words, a topic or a question rather than a tag → `search` with the user's words as they are
  (it understands meaning, so "have we seen auth failures after resume before?" finds a note
  that says "the login broke after the laptop slept"), then `get` the best hits if you need full
  bodies. If `search` finds nothing, try `list` by a likely tag, or `tags` to see what exists.
- An exact id, code token, error string or command the note must contain → `search` with
  `mode: "text"`.
- "What else is related to A-B32", "anything similar to this note" → `related` with that id.
- Page with the cursor when the user asks about "all" of something and the first page is full.

## Editing

- "Remove the markdown", "fix", "rewrite" → `get` the note, write the new full body yourself,
  `update` it (with `origin`). Keep every fact and every existing hashtag unless told otherwise.
- "Add tag #x" → make sure `#x` is in the body (append it to the hashtag line) and save.
- "Add this to note X" → `append`.
- "Undo", "what did it say before" → `revisions`, then `revert` to the one the user means.
- After any edit, reply with the id and what changed in one or two lines, and mention that the
  previous version is kept.

## Comparisons and summaries

The tools filter; you do the analysis. For "this week vs last week" call `list` (or `search`)
twice, once per date range. For "#seer vs #v250" call it twice, once per tag. Then compare the
two result sets yourself: themes, what changed, what is new, what stopped. Dates are in the
user's local time (Asia/Jakarta, WIB). A week runs Monday 00:00 to Sunday 23:59; "this week" is
Monday until now. Use the created date unless the user talks about edits. State the ranges you
used, and cite the note ids each point comes from.

## Spending, runs and Seer

The same server reads three of the user's own apps, read-only. Nothing you do through these
tools can change them, and you must not try. Questions about money spent, expenses, runs,
training, the Seer leaderboard, positions, strategies or Sera methods go to these tools, not to
the notes (unless the user asks about notes on those topics).

Each system has curated tools that compute what the app itself shows. Use them first. Use a
system's `_sql` tool only when no curated tool answers the question, and call its `_schema` tool
before writing SQL so you use real table and column names. `_sql` takes one `SELECT` and caps
the rows. Follow each tool's own schema for parameter names; it wins over anything here.

expense-tracking (spending, money in whole rupiah):
- `expenses_spending` — `from`/`to` (inclusive WIB days, up to 366): total, by category (slug
  plus Indonesian label), by day, by ISO week (Monday to Sunday, keyed by its Monday; weeks the
  range cuts are `partial`), and the largest items. Start here for "how much did I spend", "this
  week", "on meals in October", "which week was worst". Narrow with `categories`, a list of slugs:
  `["meals"]` is everyday meals only; all eating and drinking is
  `["meals", "jajan", "dining", "snacks", "drinks"]`. When comparing weeks, mind the partial ones.
- `expenses_months` — monthly totals for the last `months` (default 6) ending at `to_month`
  (`YYYY-MM`, default this month), zero-filled; the current month is `in_progress`. Use it for
  month-over-month trends. Takes the same `categories`.
- `expenses_get` — one expense group by `id` (from `expenses_spending`'s
  `largest_items[].group_id`): its items, note, original pasted text and photos. Use it to explain
  a big line or a specific purchase.
- `expenses_schema`, `expenses_sql` — anything the three above cannot answer.

run-insights (Apple Watch runs; metres, seconds, sec/km, bpm, each with a readable companion):
- `runs_list` — reviewed runs from `from` to `to` (default today) with their key metrics, the
  app's own headline for each, and period totals. Use it for "my runs this month", and call it
  once per period for "this month vs last month".
- `runs_get` — exactly one of `id` (from `runs_list`) or `date` (`YYYY-MM-DD`, every run that
  day): metrics, per-km splits, heart-rate zones, the runner's note and the app's own latest
  analysis of the run. Use `date` for "how did yesterday's run go".
- `runs_review` — `scope` `week` or `month`, `key` like `2026-W44`, `2026-10` or any day inside
  the period (default: the current one): the app's latest review for that period with its totals
  and runs. `review` is null when the app has not written one; the totals still hold.
- `runs_schema`, `runs_sql` — anything else (records, badges, the coach Nina's chat).

Seer (trading lab, money in USD; dates are New York trading sessions) and Sera (its method lab):
- `seer_leaderboard` — the paper strategies ranked the way the app ranks them, over a common
  window (name the window when you say who leads); the benchmark, retired and too-new strategies
  are listed apart with a reason.
- `seer_positions` — open bracket orders and book positions with marks and unrealised P&L.
  Optional `strategy` (an id from the leaderboard) and `include_pending`.
- `seer_sera_best` — the best dev variant of each Sera method by MAR, with the lab's metrics,
  recomputed hurdles and test trials. Use it for "best Sera methods". `eligible_at_run` is the
  verdict when the trial ran, so say "eligible when it ran", not "eligible". Optional `status`,
  `only_eligible`, `limit`.
- `seer_schema`, `seer_sql` — anything else; `seer_sql` reads either the Postgres database or
  the lab (`source` `db` or `lab`).

Dates: the user's days are WIB (Asia/Jakarta). A week runs Monday to Sunday; "this week" is
Monday until today; "yesterday" and "this month" are WIB calendar days. Pass dates as
`YYYY-MM-DD`. For a comparison, call the tool once per period and compare the results yourself.

The answer is not a tally. Say what the data shows, then what you think about it: the pattern,
how it compares with the previous period or with what is usual for the user, what stands out,
and at least one concrete suggestion. Give figures in the app's units: rupiah as whole numbers
written `Rp 38.500`, distance in km, pace as `m:ss /km`, heart rate in bpm, Seer money in USD.
State the date range you used. Keep it to short paragraphs.

## Images

If one of these tools is missing, the installed `notesd` is older than this skill. Say so and
suggest re-running `scripts/install.sh` in `~/mcp-notes` instead of working around it.

- "Show me the pictures I saved on 30 oct" → `list` with `has_image: true` and that saved-date
  range (or `taken_from` / `taken_to` when the user means when the photo was taken), then
  `view_images` on those note ids so you actually see them. Comment on what you see, per note id.
- "Show me the pictures in note A-B32" → `view_images` with that note id. A note id stands for
  every image of the note, in order, and each image comes with "image k of n". At most 8 images
  come back per call. When there are more, the last text line lists the image ids not shown:
  call `view_images` again with those ids before you say anything about "all" of them.
- A screenshot or image path at hand ("save this screenshot") → `create_image` with the absolute
  path, a short body and hashtags. It makes a new note.
- "Attach this screenshot to note A-B32", "add ~/Pictures/x.png to A-B32" → `attach_image` with
  the note id and the absolute path (expand `~`), plus `origin`. `attached: false` means the
  file is already in a note, and the returned note is the one that holds it. That may be a
  different note, or one that was deleted and is now restored. Say which note, and do not
  attach the file again.
- "Remove the second picture from A-B32" → `get` the note, pick the image from its `images`
  list by position, and call `remove_image` with that image's id (not the note id). Removal is
  soft: the image goes to the recycle bin on the wall, and `restore_image` with the same image
  id puts it back at its old place. Reply with the note id and the image id.
- "Find photos like this one" about a picture already in a note → `similar_images` with that
  image's `image_id` (from the note's `images`; a note's first image has the note's id). Then
  `view_images` on the top few `image_id`s and say which ones really match and why. The
  similarity score only ranks; your own look decides.
- "Photos of a red top in a car", "pictures of a whiteboard" → `similar_images` with `query`
  in plain words. It looks at what is in the pictures; for words written in the notes use
  `search`. Again `view_images` on the top hits before answering.
- Pasted images and `/n`: when your `/n` request comes with a note that starts "Pasted images
  in this Claude Code session", a hook has already stored those pictures and lists each one as
  `[Image #N] = <id>` (ids look like `G-0NC`), the newest marked "(latest)". "Make that image a
  new note", "save this picture" → `create_image` with `image_id` set to the latest id (or the
  one the user names: another `[Image #N]`, "the first image", or an explicit id), a short body
  with hashtags, and `origin`. "Add it to A-B32" → `attach_image` with `id` and `image_id`.
  `created: false` / `attached: false` mean that picture is already in a note: say which note.
  Never ask for a file path for a pasted image and never pass one. If the note says the latest
  image has no id yet (it is the picture pasted in this very prompt), call `create_image` (or
  `attach_image`, or `similar_images`) with `pasted_image: N` for its `[Image #N]`; a hook stores
  it and supplies the id. If the note says the latest image could not be stored, tell the user in
  one line and ask them to paste it again with the request; do not use an older image instead. With no such note there is no id: ask the user to
  paste the image again together with the `/n` request. Save a pasted image as a note only when
  asked.
- An image the user pasted into this conversation shows as `[Image #1]`, `[Image #2]`, … in
  their message and has no file path. "Find photos like this", "do I have similar pictures" →
  call `similar_images` with `pasted_image: 1` (the number in `[Image #N]`; 1 for the first or
  only one), or with `upload_id` set to its id when the pasted-images note gives one. A hook
  uploads that image and the server searches with it. Then call `view_images` on the top hits
  (their note ids or image ids) so you actually see them, and say how each one matches. If
  `similar_images` answers that the pasted image could not be resolved, tell the user in one
  line and ask them to paste the image again together with the request. Never ask for a file
  path for a pasted image.
- If `similar_images` says semantic image search is off, the daemon has no
  `OPENROUTER_API_KEY`; say so and fall back to `list` with `has_image: true` or `search`.
- An image whose file is not on this machine (`available: false`) still has its note and
  metadata. Say the file lives on the machine that saved it (`host`) instead of treating it as
  an error.

## Files

- You can see a note's files but not read them: their contents are not available through any
  tool (`extraction_status` is `none` for now). When the user asks what a note holds, list each
  file by name with its type and size, e.g. `report.pdf (application/pdf, 1.2 MB)`.
- There is no tool to attach, remove or restore a file. If the user asks for that, tell them to
  open the note on the wall and use the paperclip or the file's chip there.
- `view_images` shows pictures only; files never come back from it.
- A file with `available: false` lives on the machine that saved it (`host`).

## Chat history

Every `/n` exchange (the prompt as typed, your final answer and any pasted images) is saved to
the wall's chat history by a Claude Code hook after you answer. You do not save it yourself and
need not mention it, unless the user asks where their `/n` conversations go: the wall's chat
history page, badged "claude code".

## Sessions

Claude Code sessions are nodes with ids like `A0-3G` (two characters, a dash, two characters).
Note ids look like `A-B32` (one character, a dash, three). Never swap the two and never invent
either.

- "Which session did X", "what did A0-3G do" → `sessions_search`, then `session_get`. A
  session's `notes` are the notes saved from it (`kind: "made"`) and the notes linked to it
  (`kind: "linked"`).
- "Link 5-BW7 into 5U-I7", "link note A-B32 to session A0-3G", "put this note under that
  session" → `link_note` with `note_id` = the note id and `node_id` = the session's node id.
  Linking twice is harmless (`changed: false`). It never edits the note, so do not `update` or
  `append` anything to "make" the link. A deleted note must be restored first; ask before
  restoring it.
- "Unlink A-B32 from A0-3G" → `unlink_note`. A note saved from that session (`made: true`)
  stays listed there; say so.
- Reply with both ids as links (the note as described under Replies, the session with the
  `url` that `session_get` returns) and whether anything changed.
- Notes saved in this session are linked to it by the hook and verified by you (see "Verify the
  link"), so "write this as a new note" needs no "and link it to this node". After a save whose
  link a call confirmed (`linked: true`), add one short line such as
  "Linked to session [A0-3G](<wall>/projects?repo=REPO&node=A0-3G)." with this session's node id
  (the one the SessionStart context names; never invent one, and leave the line out when it names
  none) and the `repo` you passed in `origin` as REPO. With no confirmation, say it is not linked
  instead.

## Movies

The same server keeps the user's movie and TV library: every title (movie id `M-23T4`: `M`, a
dash, four of 0-9/A-Z; never invent one) with its TMDB metadata, studios, cast and crew; every video
file on each laptop, with season, episode, `host`, and `deleted_at` once the user deleted it;
and every play event (when, and to what position). A title and its history outlive its files,
so "what did I watch" still answers after the file is gone.

- "What Blumhouse films have I seen this year", "my unfinished series", "which films with
  Margaret Qualley do I have" → `movies_list` (`company`, `person`, `kind`, `state`,
  `finished_from` / `finished_to`, `q`). Dates are `YYYY-MM-DD`, like every other date filter.
- "Which MobLand episode did I watch last and when", "how far am I in X", "is X still on
  disk" → `movies_get` with the title's name or id. `last_play` answers "last watched"
  (season, episode, episode name, `started_at`, `position_s`); `files[].deleted_at` says when a
  file was deleted; `plays` are newest first.
- "What did I watch last week" → `movies_history` with `from` / `to`.
- "Play something", "I am eating dinner, play a random movie", "I am eating lunch, play smth",
  "let's watch something" (no title named) → `movies_continue` with `random: true` and nothing
  else, at once: no listing, no questions, no choosing a title yourself. The server picks one film
  or series at random among those playable on this machine (never a deleted file or a finished
  title; a half-watched one resumes) and opens it full screen. Then say in one line what it
  opened (title with year, the episode for a series, and "resumed at" when `action` is
  `resumed`). If they ask for another, call it again.
- "Continue MobLand", "resume X", "play the next episode", and "continue what I watched last
  night" (no title) → `movies_continue`. It opens VLC on the user's screen on this machine, so
  call it only when they asked to play something. `action` says what happened: `resumed` (from
  `position` seconds), `started` (the next episode, or a film from the start), `missing`
  (nothing played: `missing` is the next episode with no file here and `present` the later ones
  that are here; tell the user both), `nothing`. `not_on_this_machine` means the file is on the
  other laptop; `file_missing` means the library thinks the file is there but it is not on disk:
  say it is a bug.
- "Recommend other Margaret Qualley films", "what else did this director make" →
  `movies_person` with the name, then `WebSearch` for reviews or anything newer than TMDB.
  Recommend entries with `seen: false`, and say which ones they have already seen. When
  `other_people` lists someone else with the same name, make sure you have the right person
  (pass `person_id`).
- "Mark X watched", "rate X 4 stars", "my review of X: ..." → `movies_mark`. The review is a
  normal note tagged `#movie`, linked to the title; one episode's watched flag goes on its
  `file_id` (from `movies_get`).
- Movie ids. Every title has one (`movie_id`, e.g. `M-23T4`) and so has every episode of a
  series, with or without a file. A note id has three characters after its dash (`A-B32`), a
  movie id starts with `M-` and has four, so `M-0909` in a request is always a film or an
  episode, never a note. Every `movies_*` tool takes a movie id as `title`:
  - "What's M-0909 about?" → `movies_get` with it, then `WebSearch` for more than the synopsis.
  - "We missed M-0T77, tell me about this episode, maybe we can skip it" → `movies_get` with
    it: `asked.episode` is that episode (name, air date, overview, `has_file`); then
    `WebSearch` for what happens in it and whether it is filler.
  - "M-8TR4 is interesting, give me other movies in the same genre" → `movies_get` for its
    genres and credits, then `WebSearch`, and check suggestions against `movies_list`.
  - "Play M-0T77" → `movies_continue` with it plays exactly that episode.
  - To find an episode's movie id ("One Piece episode 744"), call `movies_get` with the series
    as `title` and `episode: 744` (and/or `season`). A long series answers with a summary per
    season (`files_here` shows which episode numbers have a file, so a gap is a missing file)
    until you pass `season` or `episode`.
  Quote the movie id after the name when you mention a title or episode, as a link the user
  can click: `MobLand (2025), [M-8TR4](<wall>/movies/M-8TR4)`. `<wall>/movies/<movie id>`
  opens the title's page; an episode's id opens its series scrolled to that episode. It is the
  `url` the tools return.
- `movies_off` means the movie library is not running on this daemon; say so in one line.

## Deleting

Delete only when the user asks, and only the notes or images they named. `delete` (a note) and
`remove_image` (one image) are soft. Both land in the recycle bin on the wall ("Deleted." on the
wall, at the wall URL described under Replies). Reply with the ids and say `restore` /
`restore_image` brings them back.

You cannot delete anything for good, and must not try another way (files, SQL, the HTTP API).
If the user asks to delete permanently, empty the bin or free disk space, tell them that
"delete forever" is in the wall's recycle bin, behind an inline confirm, and only there.

## Replies

- Write every note id you mention as a markdown link to the wall, in exactly this form:
  `[A-B32](<wall>/?note=A-B32)`. The id is canonical (upper case, with the dash) and is both
  the link text and the `note` value; `<wall>` has no trailing slash. A terminal that supports
  hyperlinks lets the user Ctrl+click it to open the wall on that note, and the link text is
  still the id they can copy.
- `<wall>` is the wall URL in the `notes` server's instructions (their "Links." paragraph,
  built from the daemon's port). If you cannot see it there, run `claude mcp get notes` and take
  its URL without the trailing `/mcp` (normally `http://localhost:7317`). Never guess another
  port.
- Links are for your replies only. Ids stay bare (`A-B32`) in note bodies, in tool arguments,
  and inside code spans or code blocks, where a link does not render.
- Keep replies short. Show a note's body only when the user asks to see it or it is short.
- If the request is ambiguous between two readings, pick the likelier one, do it, and say which
  reading you took.
- Answers from spending, runs or Seer follow the rule in "Spending, runs and Seer": what the
  data shows plus your own read and a suggestion.

## When the `notes` tools are missing or fail to connect

Say so plainly and suggest, in this order: `systemctl --user status notesd`,
`curl -s <wall>/health` (the wall URL from Replies; `http://localhost:7317` unless `NOTESD_PORT`
changed it), `journalctl --user -u notesd -n 50`, and re-running `scripts/install.sh` from the
mcp-notes checkout (`~/mcp-notes`). Do not fall back to writing notes into files.

A connector tool that fails returns an error naming its system ("expense-tracking is not
reachable: …", "run-insights query failed: …"). Tell the user which system failed and why, in
one line. Do not guess or estimate its numbers, and do not reach into the app's repo or
database any other way. The notes and the other systems still work; answer what they can.
