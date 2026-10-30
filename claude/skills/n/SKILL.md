---
name: n
description: The user's personal notes system, mcp-notes, reached through the `notes` MCP server. Use whenever the user types "/n <request>" from any repo, and when they ask to save, find, read, edit, tag, delete, restore, compare or summarize their notes or look at pictures they saved ("save this session's insights as a note", "what was my last #v250 note", "check note A-B32", "summarize #seer this week vs last week", "show me the pictures I saved on 30 oct").
argument-hint: <request for mcp-notes>
---

# /n — mcp-notes

The text after `/n` is a request for mcp-notes, the user's own notes store. Do it with the
`notes` MCP server's tools (they appear as `mcp__notes__<tool>`). Do not answer from memory,
from files in the current repo, or from earlier conversation when the request is about notes:
the notes are the source of truth.

## What a note is

- One plain-text body. No title, no fields, no structure.
- Tags are the `#hashtags` inside the body (`#seer`, `#v250`, `#from_phone`). The server
  re-parses them on every write: letters, digits, `_` and `-`, lower-cased, and a `#` glued to
  a word (`C#`, `a#b`) is not a tag. To add a tag, put `#tag` in the body. To remove one, take it
  out of the body.
- Ids look like `A-B32`: one character, a dash, three characters, all `0-9A-Z`. Lookup is
  case-insensitive and tolerates a missing dash, so `ab32` finds `A-B32`.
- Every edit keeps the previous body as a revision; deletes are soft and can be restored.
- A note may carry an image (a local file on the machine that saved it). Results say so.

## Tools

The spine tools are `create`, `get` (one or several ids), `update` (full body replace),
`append`, `delete` (soft), `restore`, `list` (tag any/all filters, created/updated date range,
newest first, limit + cursor), `search` (full text + tag + date filters, ranked), `tags` (every
tag with count and last-used date), `revisions` and `revert`. If the server also offers image
tools (for example `create_image` from a local file path, `view_images` to see a note's picture,
and `has_image` / taken-date filters on `list` and `search`), use them as described under
Images. Always follow each tool's own schema and description for parameter names and formats;
they win over anything written here.

## Saving

- Pass `origin` on every `create` and `update`: `cwd` = the current working directory, `repo` =
  the basename of the git top-level (`basename "$(git rev-parse --show-toplevel)"`, omit it when
  the cwd is not in a git repo), and `claude_session` only if you actually know this session's
  id. Never invent one.
- Bodies are plain text. No markdown: no `#` headings (a `#word` heading becomes a tag), no
  `**bold**`, no backtick fences, no tables. Line breaks and a plain `- ` at the start of a line
  are fine. Code tokens, paths, commands and ids are fine inline.
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
- Words or a topic rather than a tag → `search`, then `get` the best hits if you need full
  bodies. If `search` finds nothing, try `list` by a likely tag, or `tags` to see what exists.
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

## Images

Only when the server offers image tools.

- "Show me the pictures I saved on 30 oct" → `list` with the image filter and that saved-date
  range (or the taken-date range when the user means when the photo was taken), then the image
  viewing tool on those ids so you actually see them. Comment on what you see, per note id.
- A screenshot or image path at hand ("save this screenshot") → the tool that creates an image
  note from a local path, with a short body and hashtags.
- A note whose image file is not on this machine still has its text; say the file lives on the
  machine that saved it (its metadata names the host) instead of treating it as an error.

## Deleting

Delete only when the user asks, and only the notes they named. Deletes are soft: reply with the
ids and say `restore` brings them back.

## Replies

- Quote note ids exactly (`A-B32`) every time you mention a note, so the user can copy them.
- Keep replies short. Show a note's body only when the user asks to see it or it is short.
- If the request is ambiguous between two readings, pick the likelier one, do it, and say which
  reading you took.

## When the `notes` tools are missing or fail to connect

Say so plainly and suggest, in this order: `systemctl --user status notesd`,
`curl -s http://127.0.0.1:7317/health`, `journalctl --user -u notesd -n 50`, and re-running
`scripts/install.sh` from the mcp-notes checkout (`~/mcp-notes`). Do not fall back to writing
notes into files.
