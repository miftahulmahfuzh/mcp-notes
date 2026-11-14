# Notes from Claude Code

Claude Code reaches the notes through one MCP server, `notes`, that the daemon serves at
`http://127.0.0.1:7317/mcp`. The `/n` skill tells Claude how to use it, six hooks fill the gaps a
terminal has (pasted pictures, session links, chat history), and note ids in Claude's replies are
links that open the wall. Everything here works from any repository on the machine, because the
server, the skills and the hooks are installed at user scope.

```
/n <what you want, in plain words>
```

Related guides: [search.md](search.md) for how `search`, `related` and `similar_images` rank,
[connectors.md](connectors.md) for spending, runs, Seer and daily-words (`/v`, `/j`),
[sessions.md](sessions.md) for the session graph and node ids, [movies.md](movies.md) for the
`movies_*` tools, [adversary.md](adversary.md) for Seer Adversarial and `/redo`.

## The `notes` MCP server

- **Where:** `POST /mcp` on the daemon's port (`NOTESD_PORT`, default 7317). `scripts/install.sh`
  registers it with `claude mcp add --scope user --transport http notes <url>`, so every Claude
  Code session on the machine has it. The tools show up as `mcp__notes__<tool>`.
- **Stateless streamable HTTP.** Each POST gets a fresh server and transport and a JSON response.
  There is no session and no SSE stream, so `GET /mcp` and `DELETE /mcp` answer 405, and a daemon
  restart never strands a client.
- **Loopback only.** The request's host must be a loopback name, and a browser `Origin`, when one
  is sent, must be loopback too. Anything else gets 403 `Forbidden host.` or `Forbidden origin.`
  (a DNS-rebinding guard; Claude Code sends no `Origin`).
- **One writer.** Every tool goes through the same notes service as the wall and the chat bar, so
  a note Claude writes appears on the wall at once and keeps a revision.

Every tool, with its description and arguments, is listed in
[reference/mcp-tools.md](reference/mcp-tools.md). This guide covers the note, image and link
tools; the other families are in the guides named above.

### What the server tells Claude

The server sends instructions that Claude reads once per session (`src/mcp/instructions.ts`). They
are what makes a session behave the same with or without `/n` loaded:

| Paragraph | What it says |
|---|---|
| Notes | A note is one plain-text body. Tags are the `#hashtags` in it, re-parsed and lower-cased on every write. What a returned note carries (`id`, `body`, `tags`, dates, `origin`, `images`, `files`) |
| Ids | The `A-B32` shape, that the server generates ids and Claude must never invent one, and that lookup ignores case and a missing dash |
| Links | The wall URL, and the exact markdown link to write for every note id mentioned in a reply |
| Writing | `create`, `update` (whole body), `append`, revisions and `revert`, soft `delete` and `restore` |
| Reading | `get`, `list` with tag and date filters, `search` in hybrid and text mode, the `fallback` report, `tags` |
| Related, Dates | `related(id)`; `YYYY-MM-DD` means a whole day in the daemon's time zone |
| Comparisons | Comparing and summarising is Claude's job: call `list` or `search` once per side |
| Images, Attaching, Files, Similar images | How to view, save, attach, remove and compare pictures; files are visible but not readable |
| Connectors, Movies, Adversary, Sessions | The other tool families and their id and link rules |

The wall URL in the Links paragraph is built from `NOTESD_PORT`, so a daemon on another port needs
no edit to the skill.

## The `/n` skill

`claude/skills/n/SKILL.md` is linked into `~/.claude/skills/n`. Typing `/n <request>` loads it, and
Claude also loads it without the slash when a request is clearly about notes ("save this session's
insights as a note", "what was my last #v250 note"). It adds working rules on top of the server's
instructions:

- Answer from the tools, never from memory, repo files or earlier conversation.
- Note bodies are plain text: no markdown headings (a `#word` heading would become a tag), no
  bold, no fences, no links. Hashtags go on the last line, reusing existing tags (`tags` first when
  unsure). No secrets in a note.
- Pass `origin` on every `create` and `update` (see [Origin](#origin-where-a-note-was-saved-from)).
- After a write, check that the note is linked to the session before saying so (see
  [notes-link](#the-hooks)).
- Replies quote note ids as wall links and say what changed in one or two lines.

## What you can ask

Each group names the tools the request ends in. All of them exist in
[reference/mcp-tools.md](reference/mcp-tools.md).

### Save

`create`, `append`. A new note gets a server-made id; the reply quotes it.

```
/n let's get this session insights up until now and save it as a new note
/n save this as a note: the staging database rotates its password every Monday. tag it #infra #howto
/n add this to note A-B32: the fix also needs the migration from PR 41
```

"Save this session's insights" produces one dense note that a later session can act on: what the
work was, what was decided and why, what failed, the commands, paths and ids worth keeping, and
what is still open.

### Find and read

`get`, `list`, `search`, `related`, `tags`.

```
/n check note A-B32
/n what was my last note about #v250
/n show me the notes tagged #agentic
/n have we seen auth failures after resume before?
/n find the note that contains "connection pool" but not redis, exact words only
/n what else do I have that is related to A-B32?
/n which tags do I use most?
```

A question in plain words goes to hybrid `search`; an exact token, error string or command goes
to `search` with `mode: "text"`. See [search.md](search.md).

### Summarise and compare

The tools filter and Claude does the analysis: one `list` or `search` call per side, then the
comparison, citing the note ids each point comes from. A week runs Monday to Sunday in the
daemon's time zone, and the created date is used unless you talk about edits.

```
/n summarize our notes on #seer this week, compare to last week
/n summarize our notes on #seer this week. compare it to #v250
/n what did I write about the login bug in October?
```

### Edit, live on the wall

`update` replaces the whole body, so Claude reads the note first, writes the new full text and
keeps every fact and hashtag unless told otherwise. The wall is listening on the daemon's event
stream: the card changes and "Last edited" moves to that note with no reload.

```
/n check note A-B32 . i just copy paste it in a markdown format. please remove the markdown formatting in it. also add tag #agentic to it
/n fix the typos in A-B32 and move the commands to the end
/n remove the tag #draft from A-B32
```

Tagging is editing: to add a tag Claude writes `#tag` into the body, to remove one it takes it
out.

### Revisions and revert

Every body change keeps the previous body. `revisions` lists them, `revert` brings one back and
keeps the body it replaces as a new revision, so a revert can itself be undone.

```
/n what did A-B32 say before i edited it yesterday? put it back
/n show me the history of A-B32
```

### Delete and restore

`delete` is soft: the note leaves `list`, `search` and `tags` and moves to the wall's recycle bin.
`restore` brings it back. No tool deletes anything for good; "Delete forever" exists only in the
recycle bin on the wall ([wall.md](wall.md)).

```
/n delete note A-B32
/n which notes did I delete this week?
/n restore A-B32
```

### Pictures

`view_images`, `create_image`, `attach_image`, `remove_image`, `restore_image`, `similar_images`,
plus the `has_image` and `taken_from` / `taken_to` filters on `list` and `search`.

```
/n show me some pictures that i saved on 26 oct, give your comments on them
/n show me the pictures in note A-B32
/n photos taken last week
/n save ~/Pictures/Screenshots/login-bug.png as a note, tag it #seer #bug
/n attach ~/Pictures/Screenshots/login-bug-2.png to note A-B32
/n remove the second picture from note A-B32
/n find photos like the first picture in A-B32
/n do I have pictures of a whiteboard?
```

- `view_images` takes note ids or image ids. A note id stands for every picture of that note, in
  order. One call returns at most eight pictures and names the image ids still to view.
- A picture saved from a path is copied, never moved, and never re-encoded.
- Saving a file that already lives in a note returns that note with `created: false` or
  `attached: false`, and Claude says which note holds it.
- `remove_image` is soft and takes the image's id, not the note's. `restore_image` puts the
  picture back at its old position.
- Files that are not pictures (PDFs, archives) are listed on a note with name, type and size, but
  no tool can read, attach or remove them. That is done on the wall.

With a picture pasted into the terminal:

```
/n make this a note, tag it #whiteboard
/n add that image to A-B32
/n find photos like this
```

A pasted picture has no file path. The [notes-prompt and notes-paste hooks](#the-hooks) store it
and hand Claude an id, so Claude never asks for a path. "That image" is the latest pasted one;
`[Image #1]` or an id picks another.

### Link a note to a session

`link_note`, `unlink_note`. Notes written in a session are linked to it automatically. These are
for linking an existing note to another session.

```
/n link 5-BW7 into 5U-I7
/n unlink A-B32 from A0-3G
/n which session wrote the note about photo delete?
```

A link never changes the note's text or origin, linking twice is harmless, and a deleted note
must be restored first. A note saved from a session stays listed there after an unlink. See
[sessions.md](sessions.md).

### Other apps and the film library

The same `/n` answers questions about spending, runs and Seer
([connectors.md](connectors.md)) and about films and series ([movies.md](movies.md)).

## Note ids

- A note id is one character, a dash and three characters, all from `0-9A-Z`: `A-B32`.
- The server generates ids (`src/notes/ids.ts`). Nothing else may invent one.
- Lookup ignores case and a missing dash: `ab32`, `a-b32` and `AB32` all find `A-B32`. A note that
  does not exist is reported under its canonical id.
- An image id has the same shape, and a note's first image shares the note's id. Pasted pictures
  get ids of the same shape in their own store.
- Do not confuse a note id with a session node id (`A0-3G`, two and two) or a movie id (`M-23T4`,
  `M-` and four).

## Clickable note ids

Terminal output is plain text, so an id cannot normally be clicked. Four pieces make it a link:

1. **The wall has an address for every note.** `/?note=A-B32` opens the wall scrolled to that note
   and outlines it.
2. **Claude is told the address.** The server's instructions carry the wall URL and the exact form
   to write: `[A-B32](http://localhost:7317/?note=A-B32)`, canonical id as both text and value.
3. **Claude Code draws a markdown link as a terminal hyperlink** (OSC 8). Windows Terminal,
   iTerm2, kitty and most current terminals open it on Ctrl+click (Cmd+click on macOS).
4. **tmux must pass hyperlinks through.** It drops them unless told the terminal supports them;
   one line of tmux config fixes it. See [install.md](install.md).

Links are for replies only. Ids inside note bodies and tool arguments stay bare, and a link inside
a code span or code block does not render. Session node ids and movie ids are linked the same way,
to `/projects?repo=REPO&node=A0-3G` and `/movies/M-23T4`.

### The `note-links` mod

`claude/mods/note-links` is an optional Claude Code mod that covers what the instructions cannot:

- It redraws Claude's replies so a note id written without a link becomes one. Only the drawing
  changes; the stored message and what the model reads stay as they were.
- Session node ids become links to the project graph, but only ids the daemon confirms through
  `GET /api/sessions/known`, because upper-case look-alikes (`CI-CD`) share the shape. With the
  daemon down they stay plain.
- Movie ids become links to the title's page, and a movie id Claude wrote as a note link is
  redrawn as the movie link.
- `/open <id>` opens a note or a session on the wall in the browser, for an id you typed or a
  terminal that cannot click. From WSL it tries `explorer.exe`, then `powershell.exe`, then
  `cmd.exe`, and prints the URL when none starts.

Only the upper-case, dashed form standing alone is linked. Code blocks, code spans, existing
links, URLs, paths, hashes, UUIDs and longer dashed words are left alone. An upper-case word that
happens to have the shape (`X-RAY`) is linked too.

`install.sh` does not turn the mod on, because Claude Code asks a person before it loads one.
Start it with `claude --plugin-dir ~/mcp-notes/claude/mods/note-links`, or add the folder to
`CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`. Its options (`wallUrl`,
`discoverWallUrl`, `linkifyReplies`) and its own checks are in
[the mod's README](../../claude/mods/note-links/README.md).

## The hooks

Six hooks in `claude/hooks/` run in every Claude Code session on the machine. Each one always
exits 0, never blocks a prompt or a command, uses only Node built-ins, and writes its problems to
a log under `~/.local/state/notes-capture/` (or `$XDG_STATE_HOME/notes-capture/`).

| Hook | Event | What it does | Log |
|---|---|---|---|
| `notes-capture` | Stop, in the background | Saves each `/n` exchange to the chat history | `capture.log` |
| `notes-link` | After `create`, `create_image`, `update`, `append`, `attach_image` | Links the note just written to this session's node | `link.log` |
| `notes-paste` | Before `similar_images`, `create_image`, `attach_image` | Uploads a pasted picture and swaps `pasted_image` for its id | `paste.log` |
| `notes-prompt` | When a prompt is submitted | Stores pasted pictures for `/n` prompts; resolves session node ids in any prompt | `prompt.log` |
| `notes-session` | SessionStart | Reports the session and its parent to the daemon; tells Claude its node id | `session.log` |
| `notes-spawn` | Before every Bash command | Records a hand-started `claude` in tmux so the child links to its parent | `spawn.log` |

**notes-capture.** At the end of a turn it reads the transcript, and when the turn's prompt was a
`/n` request it posts the exchange to `POST /api/capture/claude-code`. See
[Chat history](#n-exchanges-in-the-chat-history).

**notes-link.** It posts the note id and the session id to `/api/sessions/hook/link-note`, so every
note written in a session is listed under that session's node on the Projects page without anyone
asking. It runs synchronously on purpose: a link that succeeded prints nothing, and a link that
failed is told to Claude, naming `link_note` as the retry. The `/n` skill does not take the link
on faith either: after a write Claude calls `link_note` with the session's node id, which is both
the check and the retry (`changed: false` means the hook had already linked it), and it writes
"Linked to session ..." only when a call confirmed it.

**notes-paste: a pasted image becomes a note.** Claude calls `create_image`, `attach_image` or
`similar_images` with `pasted_image: N` for `[Image #N]`. Before the call reaches the server the
hook finds that picture in the transcript, uploads it to the chat image store and rewrites the
call with `image_id` (or `upload_id` for `similar_images`). If no picture can be found or
uploaded, the call goes through unchanged and the server answers with an explanation. Setting
`NOTES_PASTE_STRATEGY=deny` when running `install.sh` registers a fallback mode in which the hook
denies the call and gives Claude the id to call again with.

**notes-prompt.** Two jobs, and on a prompt that needs neither it does no I/O at all: one regular
expression test, no transcript read, no network.

- *Pasted pictures, `/n` prompts only.* It stores the pictures pasted earlier in the session (the
  newest 8, up to 20 MB each, each uploaded once per session) and tells Claude their ids, oldest
  first, the newest marked latest. A picture pasted in the `/n` prompt itself is not in the
  transcript yet when this hook runs, so the hook tells Claude to use `pasted_image N` and
  notes-paste supplies the id. Claude is never handed an older picture as "that image" in its
  place. A session that never uses `/n` stores no pictures.
- *Node ids, any prompt.* A prompt that quotes a session node id such as `A0-3G` gets that
  session's summary, plan docs, commits and transcript path added as context, for up to five ids.
  A candidate must be upper case with its dash, stand alone as a token and contain a letter, so
  dates, times, versions, paths and ticket keys never match. Ids the daemon does not know add
  nothing.

**notes-session.** On start, resume, clear and compact it tells the daemon the session id, its
parent (from `CC_PARENT_SESSION`, which `swarm.py` sets on the sessions it spawns), the working
directory, the session name, the tmux pane and the host. Then it tells Claude its own node id and
its parent's, so the session knows them from the first turn. Sessions that are not interactive
(the wall's chat agent, `claude -p`) are skipped.

**notes-spawn.** When a Bash command starts `claude` in a new tmux window, split or session
without going through `swarm.py`, it records a pending spawn. The child's notes-session hook
claims it within 30 seconds, which links child to parent exactly. `claude -p`, `--resume` and
`--continue` are ignored, and the hook never changes or blocks a command.

The session side of these hooks (parent links, their sources, the graph) is explained in
[sessions.md](sessions.md).

### How they are installed

`scripts/install.sh` is idempotent and does the whole Claude Code side:

1. Registers the `notes` MCP server at user scope (it removes and re-adds it, so a port change is
   picked up).
2. Symlinks each skill folder in `claude/skills/` into `~/.claude/skills/`: `n`, `migrate`, `v`,
   `j`, `redo` and `check-seer-adversarial-nightly`. It refuses to replace a real directory.
3. Runs `scripts/claude-hooks.mjs install`, which merges the six hook entries into
   `~/.claude/settings.json`.
4. Runs `scripts/claude-hooks.mjs retention`, which raises `cleanupPeriodDays` to 3650 when it is
   missing or lower, so Claude Code stops deleting the transcripts the session graph reads
   (`NOTES_CLAUDE_RETENTION_DAYS` changes the number).

`scripts/claude-hooks.mjs` leaves every other key and every other hook in the settings file as it
was. It recognises its own entries by script name, so an entry left by another checkout is
replaced, not duplicated, and a second run leaves the file byte-identical. Before the first change
it keeps one copy at `settings.json.bak-notes-hooks`, and it writes atomically.

```sh
scripts/install.sh --skip-hooks                                    # leave ~/.claude/settings.json alone
node scripts/claude-hooks.mjs status    --settings ~/.claude/settings.json
node scripts/claude-hooks.mjs uninstall --settings ~/.claude/settings.json
```

Run `scripts/install.sh` again after pulling a change to a hook's matcher or to the skill list.
Installing from a worktree points the skills and hooks at that worktree; `install.sh` warns and
asks for a re-run from the main checkout after the branch lands. The full install is in
[install.md](install.md).

## `/n` exchanges in the chat history

The wall's chat history page lists what was asked from Claude Code next to what was asked in the
chat bar ([chat.md](chat.md)).

- After every turn whose prompt starts with `/n`, notes-capture sends the prompt as typed,
  Claude's final answer, both timestamps and any pasted pictures (up to 8) to
  `POST /api/capture/claude-code`.
- The daemon stores it as a single-turn thread with source `claude_code`, shown with a
  "claude code" badge. Pictures go into the chat image store, deduplicated by content.
- The route is idempotent on `<claude session>:<prompt uuid>`: a second post of the same exchange
  answers 200 `duplicate` and writes nothing.
- The payload is written to `~/.local/state/notes-capture/outbox/` before it is sent. If the
  daemon is down, the file waits and goes in on a later turn (oldest first, at most 20 per run,
  dropped after 14 days).
- The route accepts loopback requests only, with the `X-Notes-Capture: 1` header and a JSON body.

Claude does not save the exchange itself and has no need to mention it.

## Origin: where a note was saved from

A note carries an `origin` object, or `null`:

| Field | Meaning |
|---|---|
| `cwd` | Working directory of the session that saved it |
| `repo` | The repository: the basename of the git top level; left out outside a repo |
| `claude_session` | The Claude Code session id, only when Claude really knows it |
| `source` | Set by the server: `mcp` for a note written through these tools |

The `/n` skill passes `cwd`, `repo` and `claude_session` on every `create`, `update`,
`create_image` and `attach_image`. A note whose `origin.claude_session` is a known session is
listed under that session's node as `made`, even without a link. `append` takes no origin.

## `/migrate`: a folder of pictures into one note

```
/migrate C:\Users\me\Downloads\Telegram Desktop\sun27 #ai_image
/migrate ~/Pictures/whiteboards #work #whiteboard
```

`/migrate <dir> <#tag> [#tag ...]` puts every image in the folder into one new image note, tags
it, checks the note holds them all, and then deletes the folder so the pictures are stored once.

- Everything before the first `#tag` is the path. A Windows path is converted to `/mnt/<drive>/...`.
  At least one tag is required.
- Images are taken in natural filename order (`s2` before `s10`), not recursively. The first goes
  in with `create_image`, the rest with `attach_image`, one at a time.
- A file that already lives in another note comes back `attached: false`. It is reported and is
  not a failure.
- Before deleting, Claude reads the note back and compares count, `original_name` and `bytes`
  with the files. The folder is removed only when everything matches.
- It refuses dangerous targets (`/`, a drive root, `$HOME`, `Downloads`, `Desktop`, `Documents`,
  any path with fewer than three components) and asks first when the folder also holds files that
  are not images.
- The skill pins its own model (`claude-sonnet-4-6`) in its front matter.

## Quirks and limits

- **Pictures and files are per machine.** `available: false` on an image or file means it lives on
  the other laptop (`host`). The note's text is still readable; the picture cannot be viewed
  here.
- **Only `/n` prompts are captured to the chat history.** The capture hook matches `/n` followed
  by whitespace or the end. A notes request typed without the slash, and `/v`, `/j` or `/migrate`
  turns, are not captured.
- **A pasted picture needs the hooks.** Without them `pasted_image` reaches the server and the
  tool answers that the picture could not be resolved and suggests running `scripts/install.sh`.
  Paste the picture again in the same message as the request.
- **Missing tools usually mean a deny list.** If `claude mcp get notes` says Connected but the
  write tools are absent, look for `mcp__notes__*` under `permissions.deny` in the repo's
  `.claude/settings.json` or `.claude/settings.local.json`. A note written by another route is
  not linked by the hook.
- **Tools newer than the daemon.** If the skill names a tool the server does not have, the
  installed daemon is older than the skill: run `scripts/install.sh` again.
- **`update` replaces the whole body.** Claude must read the note first. `append` is the safe way
  to add text.
- **Links do not render in code.** A note link inside a code span or block shows its brackets.
- **`search` needs a key for meaning.** Without `OPENROUTER_API_KEY` it returns word matches with
  a `fallback` line, and `related` and `similar_images` refuse. See [search.md](search.md).
- **`/n` exchanges wait, hooks do not.** A capture survives a daemon restart through the outbox.
  A failed link, paste or session report is logged and not retried by the hook; the session graph
  recovers parent links later from the transcripts.

## Where the code is

| Path | What it holds |
|---|---|
| `src/mcp/server.ts` | The server: which tool families are registered, stateless request handling |
| `src/mcp/instructions.ts` | The instructions Claude reads, and the wall URL built from the port |
| `src/mcp/tools.ts` | Note tools: `create`, `get`, `update`, `append`, `delete`, `restore`, `list`, `search`, `tags`, `related`, `revisions`, `revert` |
| `src/mcp/imageTools.ts`, `similarTools.ts` | `create_image`, `attach_image`, `view_images`, `remove_image`, `restore_image`, `move_image`; `similar_images` |
| `src/mcp/sessionTools.ts` | Session tools, including `link_note` and `unlink_note` |
| `src/http/app.ts` | The `/mcp` mount and its loopback guard |
| `src/http/capture.ts`, `src/chat/capture.ts` | `POST /api/capture/claude-code`: guard, validation, storing the exchange |
| `src/notes/ids.ts` | Note id generation and the tolerant lookup form |
| `claude/skills/n`, `claude/skills/migrate` | The `/n` and `/migrate` skills |
| `claude/hooks/notes-*.mjs`, `claude/hooks/lib/` | The six hooks; shared state, logging and transcript reading |
| `claude/mods/note-links/` | The mod, with its own tsconfig and tests |
| `scripts/install.sh`, `scripts/claude-hooks.mjs` | MCP registration, skill symlinks, the hook merge and transcript retention |

## Proving a change

- **MCP tools:** the feature map entries `notes.md`, `images-files.md`, `search.md` and
  `projects.md` under `.claude/skills/verify-notesd/features/`. Launch a throwaway daemon with
  `verify.sh up` and call tools with `verify.sh mcp RUN <tool> '<json>'`; add `--web` to watch
  the wall update live after an `update`.
- **Instructions and tool descriptions:** `tests/unit/mcp.instructions.test.ts` and
  `tests/unit/mcp.describe.test.ts`. After changing a tool, run `npm run docs:gen` so
  [reference/mcp-tools.md](reference/mcp-tools.md) matches.
- **Hooks:** `tests/unit/hooks/*.test.ts` and `tests/unit/captureGuard.test.ts`. The two paste
  paths can be checked against a running daemon with `npm run verify:paste-hook` and
  `npm run verify:prompt-hook`; each makes one short, billed Claude call.
- **The mod:** `claude plugin validate claude/mods/note-links` and
  `claude plugin test claude/mods/note-links`. `npm test` does not run these.
- `verify.sh` never runs `install.sh` and never touches the real `~/.claude`. Check an installer
  change by reading the file, or with `claude-hooks.mjs` against a scratch settings file.
