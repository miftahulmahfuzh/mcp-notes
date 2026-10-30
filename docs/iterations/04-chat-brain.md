# Iteration 4 — Chat bar brain

One `/analyze` run covering ROADMAP iteration 4. Everything below the line is the owner's
request, verbatim input for /analyze Step 0.

---

Build mcp-notes iteration 4 ("Chat bar brain") from docs/ROADMAP.md. The "Fixed decisions"
table in docs/ROADMAP.md is binding: do not re-decide anything in it. Iterations 1–3 are on main
(plan: docs/plans/NOTES_SPINE_IMAGES_UI_PLAN.md). The chat bar, the answer panel, the used-note
highlighting and the `POST /api/chat` SSE contract already exist. Today the endpoint streams a
fixed stub reply from src/chat/stub.ts through the `ChatBackend` seam in src/chat/backend.ts.
This iteration replaces the brain behind that seam and leaves the UI's look alone.

R1 — Claude brain. A `ChatBackend` built on the Claude Agent SDK
(`@anthropic-ai/claude-agent-sdk`): headless Claude Code on the owner's existing login, with no
API key in this repo.
  - One SDK run per chat message. The reply streams token by token as `event: delta`, so the
    panel fills while Claude works (partial assistant messages, not one block at the end).
  - The agent reaches notes through the same `notes` MCP server Claude Code uses
    (http://127.0.0.1:7317/mcp), so the chat bar and `/n` share one set of tools and one
    behaviour. Allowed tools: the `notes` MCP tools plus WebSearch and WebFetch (usage example:
    "when did i watch Verity? can you do some web search to see what is it about?"). Nothing
    else: no Bash, no file reads or edits, no other MCP servers from the owner's user config.
    Write tools stay allowed ("remove the markdown formatting in A-B32 and add #agentic" must work
    from the chat bar), and edits show up on the wall through the existing SSE.
  - It can look at pictures through `view_images` ("show me some pictures that i saved on
    30 oct. give your comments on them").
  - The system prompt says what mcp-notes is, that the person typing is the notes' owner, that
    note ids must be quoted in the answer exactly as A-B32 whenever a note is used (the wall's
    highlighting finds ids in the answer text), that answers are plain prose suited to the panel
    (short paragraphs, no markdown headings or tables), and today's date and timezone, so "this
    week" and "30 oct" resolve correctly.
  - Answers are not saved as notes (fixed decision).
  - Guardrails: a max-turns cap, a wall-clock timeout, and an abort that stops the SDK run when
    the HTTP client disconnects or the user sends a new message.

R2 — Threads. A follow-up in the chat bar continues the same conversation ("and compare it to
last month") by resuming the SDK session: `thread_id` in the existing contract is that session.
Dismissing the panel starts a new thread on the next message. A pinned panel keeps its thread.
Resume must survive a daemon restart, as long as the SDK session still exists on disk.

R3 — GLM fallback. The same code runs on GLM by swapping `ANTHROPIC_BASE_URL` /
`ANTHROPIC_AUTH_TOKEN` in the SDK child's environment, taken from .env.local's `LLM_BASE_URL`,
`LLM_API_KEY`, `LLM_MODEL` (z.ai, glm-5.3). A config switch, `CHAT_BRAIN=claude|glm`, defaults to
claude. On top of the switch, when a Claude run fails because of a usage limit or authentication,
the same message is retried once on GLM. The panel then says which brain answered, as a tiny
Geist Mono label in its existing header line, not as a button. GLM is a fallback only: the
daemon never prefers it on its own.

R4 — Progress in the panel. While the agent is calling tools, the panel's header line shows a
terse status in the design's Geist Mono caption style ("searching notes", "reading 3 notes",
"looking at 4 photos", "searching the web"). Add an `event: status` to the SSE contract; the
stub backend may ignore it. No tool-call transcript, no spinners beyond the existing ▍ cursor.

R5 — Daemon fit. notesd runs as a systemd user unit (see deploy/notesd.service and
scripts/install.sh). The SDK has to find the `claude` executable and the owner's login from
inside that unit: Claude Code lives at ~/tools/node-v22.23.1-linux-x64/bin/claude, and
credentials are under ~/.claude. Make install.sh and the unit provide whatever the SDK needs, and
verify through the installed daemon (not only in tests) that a chat message gets a real answer.

R6 — Tests. Unit tests for the backend against a fake SDK `query` (streaming deltas, status
mapping, ids passed through, abort, the fallback path, thread resume), integration tests for
`/api/chat` with the fake injected, and an opt-in live suite (`CHAT_LIVE_TEST=1`, excluded by
default like test:int) that runs one real Claude message and one real GLM message.

Acceptance (typed into the chat bar at http://localhost:7317 once installed):
  summarize our notes on #seer this week. compare it to last week
  check note A-B32 . i just copy paste it in a markdown format. please remove the markdown formatting in it. also add tag #agentic to it
  show me some pictures that i saved on 30 oct . give your comments on them
  when did i watch Verity? can you do some web search to see what is it about?
  (follow-up in the same thread) and what did i write about it the week after?

Out of scope: connectors to expense-tracking / run-insights / seer (iteration 5), embeddings and
semantic search (iteration 6), saving answers as notes, any redesign of the chat bar or the
answer panel beyond the status line and the brain label, chat history UI, multi-user anything.
