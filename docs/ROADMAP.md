# mcp-notes roadmap

A local notes daemon that plugs every personal system into Claude Code through one MCP server.
Claude Code is open all working day; `/n <anything>` from any repo talks to mcp-notes.

## Fixed decisions

| Topic | Decision |
|---|---|
| Activation | `/n <request>` — a user-level Claude Code skill at `~/.claude/skills/n/SKILL.md`. Not `\n`: literal `\n` occurs in ordinary text. |
| Process | One daemon, `notesd` (Node 22, TypeScript, Hono). Serves MCP (streamable HTTP, `/mcp`), the web UI, image files, and `/chat`. Binds `127.0.0.1:7317` only, no auth. |
| Autostart | systemd **user** service + `loginctl enable-linger`; Windows Task Scheduler at logon runs `wsl.exe -d <distro> -- sleep infinity` (hidden) so WSL boots and stays up. |
| MCP registration | `claude mcp add --scope user --transport http notes http://localhost:7317/mcp` |
| Note shape | One text field. No title. Tags are `#hashtags` inside the text, parsed into a `tags text[]` column on every write. |
| Note ID | `[0-9A-Z]-[0-9A-Z]{3}`, e.g. `A-B32`. Random, unique, case-insensitive on lookup. Every card in the UI has a copy-id icon. |
| Text storage | Neon Postgres (this repo's `.env.local`). Lenovo and GPD both run `notesd` against the same DB. |
| Edit safety | Every edit keeps the previous body in `note_revisions`; deletes are soft. |
| Images | An image note = a note with one or more local files (several images per note since iteration 7). Originals stored byte for byte in `~/mcp-notes-data/images`, never re-encoded. Derived thumbnail (grid) and capped preview (what Claude sees). **No image sync to the GPD, ever** — on the GPD the text shows, the image shows as "on Lenovo". Accepted limitation. |
| Chat bar brain | Claude Agent SDK (headless Claude Code, existing login), one run per message, resumable thread, streamed. Same code runs on GLM by swapping `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` — fallback only. |
| Chat answers | Overlay panel rising above the chat bar; notes the answer used are highlighted on the wall. Answers are not saved as notes. |
| Other systems | Read-only. Credentials read at runtime from `~/expense-tracking/.env.local`, `~/run-insights/.env.local`, `~/seer/.env.local`; every connection `default_transaction_read_only = on`. Per system: `schema` tool, row-limited `sql` tool, a few curated tools. Seer also reads `~/seer/lab/lab.sqlite` read-only. |
| Semantic search | pgvector on the notes DB, embeddings via OpenRouter (as run-insights does), hybrid ranking: full-text + tags + recency + vector. |
| UI | Icon-only controls, Phosphor icons (duotone). No search bar. Masonry wall, collapsed sidebar (image-only toggle + tags), long chat bar at the bottom. Dark first. No Claude-default look (see `design/claude-design-prompt.md`). |
| Frontend | Vite + React SPA, built and served statically by `notesd`. |

## Iterations

| # | Name | Delivers | Usage examples covered |
|---|---|---|---|
| 0 | Design | Claude Design run with `design/claude-design-prompt.md` + owner's reference shots | – |
| 1 | Spine | `notesd`, schema, note tools, revisions, `/n` skill, autostart, MCP registration | 1.a, 1.a2, 1.a3, 1.a4 |
| 2 | Images | Local image store, thumbnails/previews, inbox folder, image notes, MCP returns images, EXIF dates | 1.e |
| 3 | Web UI | Implement the design: wall, sidebar, copy-id, inline edit, drag/paste upload, image-notes gallery grid, photo modal, full-screen image tab | – |
| 4 | Chat bar brain | Agent SDK per message, streaming overlay, thread resume, GLM fallback switch | all of them, from the UI |
| 5 | Connectors | expense-tracking, run-insights, seer (Neon + lab.sqlite), read-only | 1.d, 1.d2, 1.f, 1.g |
| 6 | Semantic | Embeddings, backfill, hybrid search | 1.b, 1.c |
| 7 | Wall editing | Big editor modal, several images per note, delete + recycle bin, open file location in Explorer | – |
| 8 | Chat history, files, image search | Chat history on its own tables, `/history`, note files, Gemini image embeddings and `similar_images` (v0.2.0) | – |
| 9 | Claude Code hooks | `/n` capture, pasted image to note (`image_id`, `pasted_image`), clickable note ids (v0.2.0) | – |
| 10 | Project session graph | Every Claude Code session per repo as a graph on the wall, node ids resolvable from any prompt, exact and heuristic parent links, Haiku summaries and session search, session MCP/chat tools, resume into tmux, per-project chat, "unfinished" orch badge. Brief: `iterations/08-project-session-graph.md` | – |
| 11+ | Later | GPD install, weekly digest, daily session digest note, fork-session UI, … | – |

5 and 6 depend only on 1, so they can run in parallel with 3 and 4.

Each iteration is started with `/analyze` in its own tmux window, using the brief in
`iterations/NN-*.md`.

## Usage examples (the acceptance set)

```
/n let's get this session insights up until now and save it as a new note
/n check notes that has #v250 tags. i wonder what my last note about it was
/n check note A-B32 . i just copy paste it in a markdown format. please remove the markdown formatting in it. also add tag #agentic to it
/n summarize our notes on #seer this week. compare it to last week / to #v250
/n check our notes, have we met this kind of accidents before? maybe we already have a solution for this
/n find a relevant notes that talks about ArangoDB credentials
/n when did i watch Verity? can you do some web search to see what is it about?
/n how are my spending this week? don't just tally the numbers and give me your inputs
/n show me some pictures that i saved on 30 oct . give your comments on them
/n i did a run yesterday. show me how it went. what are your thoughts on this run?
/n what are the best sera method that we have found up until now?
```
