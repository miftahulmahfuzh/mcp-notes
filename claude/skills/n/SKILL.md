---
name: n
description: The user's personal notes system, mcp-notes, reached through the `notes` MCP server, which also reads the user's own apps read-only — expense-tracking (spending in rupiah), run-insights (Apple Watch runs, the app's run analyses and weekly/monthly reviews, coach Nina) and Seer (trading lab, leaderboard, positions, Sera methods). Use whenever the user types "/n <request>" from any repo, and when they ask to save, find, read, edit, tag, delete, restore, compare or summarize their notes or look at, attach or remove pictures in them ("save this session's insights as a note", "what was my last #v250 note", "check note A-B32", "summarize #seer this week vs last week", "show me the pictures I saved on 30 oct", "show me the pictures in note A-B32", "attach this screenshot to note A-B32"), or ask about their spending, expenses, runs or Seer ("how is my spending this week", "how did yesterday's run go", "compare my running this month with last month", "what are the best Sera methods so far", "what's on the Seer leaderboard").
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
path), `attach_image` (add a local file to an existing note), `remove_image` and
`restore_image` (take one image out of its note, softly, and put it back), `view_images` (see
the images of notes, or single images), and the `has_image` / taken-date filters on `list` and
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
