# Iteration 1 — Spine

Paste everything below the line into a fresh Claude Code session in `~/mcp-notes`.

---

/analyze feature --no-worktree
Build iteration 1 ("Spine") of mcp-notes. Read docs/ROADMAP.md first: its "Fixed decisions"
table is binding, do not re-decide anything in it. This repo is empty apart from docs/ and
.env.local (LLM_*, DATABASE_URL, DATABASE_URL_UNPOOLED for this project's own Neon database).

Context: I keep Claude Code open all working day in WSL. mcp-notes is a local daemon that every
Claude Code session reaches through MCP. I trigger it with `/n <request>` from any repo. Later
iterations add images, a web UI, a chat bar, connectors to my other systems and semantic search;
this iteration builds the backbone they hang on, so leave clean seams for them but do not build
them.

What I want in this iteration:

1. `notesd`: a Node 22 + TypeScript daemon (Hono) in this repo. Binds 127.0.0.1:7317 only.
   Serves MCP over streamable HTTP at /mcp (@modelcontextprotocol/sdk) and GET /health.
   Config from .env.local. Data dir ~/mcp-notes-data (created if missing; images come in iter 2).

2. Neon schema via Drizzle (same style as ~/expense-tracking and ~/run-insights: drizzle-kit
   migrations, @neondatabase/serverless):
   - notes(id, body, tags text[], image_path null, image_meta jsonb null, origin jsonb,
     created_at, updated_at, deleted_at). GIN index on tags, full-text index on body using the
     'simple' config (notes are full of code tokens; english stemming mangles them).
     image_* columns exist now but stay unused until iteration 2.
   - note_revisions(note_id, body, saved_at): every update and every delete stores the previous body.
   - id format: one char [0-9A-Z], a dash, three chars [0-9A-Z]  (e.g. A-B32). Random, collision
     retried, lookup case-insensitive and tolerant of a missing dash ("ab32" finds A-B32).
   - tags: parsed from #hashtags in the body on every write (#v250, #from_phone, #ai_image, #seer).

3. MCP tools (names and descriptions written for Claude, since Claude is the only caller):
   create, get (one or several ids), update (full body replace), append, delete (soft), restore,
   list (filter by tags any/all, date range on created or updated, newest first, limit/cursor),
   search (full-text + tag + date filters, ranked), tags (all tags with counts and last-used date),
   revisions(id) and revert(id, revision).
   Every note returned carries id, body, tags, created_at, updated_at, and origin.
   create/update accept an optional origin {cwd, repo, claude_session} so notes saved from a repo
   remember where they came from. Comparisons like "this week vs last week" or "#seer vs #v250"
   are done by Claude from list/search results; the tools only need good filters, not analytics.
   Also expose MCP server instructions telling Claude what mcp-notes is and how ids look.

4. The `/n` skill at ~/.claude/skills/n/SKILL.md (user level, so it works in every repo):
   tells Claude the text after /n is a request for mcp-notes, to use the `notes` MCP tools,
   to pass the current cwd/repo as origin when saving, to quote note ids in replies, and for
   "save this session's insights" to write a dense plain-text note with hashtags it chooses.
   Keep the skill in this repo (e.g. claude/skills/n/SKILL.md) and install it by symlink, so it
   is versioned.

5. Autostart: a systemd user unit for notesd, an install script that enables it and runs
   `loginctl enable-linger`, registers the MCP server with
   `claude mcp add --scope user --transport http notes http://localhost:7317/mcp`, and symlinks
   the skill. Plus a Windows side: a PowerShell script that creates a Task Scheduler entry at
   logon running `wsl.exe -d <distro> -- sleep infinity` hidden. Verify what you can from WSL
   (unit active, /health, `claude mcp list` shows notes connected) and document the Windows step
   and whether WSL stays up without a terminal attached.

6. Tests: vitest. Unit tests for id generation/normalisation and tag parsing; integration tests
   for the tools against a real Postgres (follow how ~/expense-tracking does test:int).

Acceptance (run these through Claude Code once it is installed):
  /n let's get this session insights up until now and save it as a new note
  /n check notes that has #v250 tags. i wonder what my last note about it was
  /n check note A-B32 . i just copy paste it in a markdown format. please remove the markdown formatting in it. also add tag #agentic to it
  /n summarize our notes on #seer this week. compare it to last week
  /n summarize our notes on #seer this week. compare it to #v250

Out of scope: images, web UI, chat bar, connectors to expense-tracking/run-insights/seer,
embeddings. Do not add a title field or any typed note structure: one text field, by design.
