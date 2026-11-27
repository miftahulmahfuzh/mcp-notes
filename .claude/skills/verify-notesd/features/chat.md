# Chat bar and chat history

## Sub-features
- Ask about notes from the wall's bottom bar ("Ask about your notes"); answers stream.
- Threads and messages persisted; edit, delete, restore messages; chat about an image.
- `/n` exchanges captured from Claude Code via `POST /api/capture/claude-code` (needs the header
  `X-Notes-Capture: 1`, else 403 `capture_header_required`). The end-to-end hook path is in
  `claude-code.md`.
- The answer panel: collapse and expand, the pin that ignores Esc, dismiss ending the thread,
  "Chat in full screen" (`/history?thread=`), the used-note chips. Unit:
  `web/src/components/AnswerPanel.test.tsx`, `web/src/hooks/useChat.test.tsx`.
- Status captions for each tool the agent calls ("saving a saying", ...), and the tools with none.
  Unit: `tests/unit/chat-status.test.ts`.
- Ids in chat text become links (note, session node, movie, `img:`/`upload:`), with the misfire
  rules. Unit: `web/src/lib/chatSegments.test.tsx`, `web/src/components/ChatText.test.tsx`,
  `web/src/components/Bubble.notelinks.test.tsx`.
- Pictures pasted into the bar: at most 4 per message (`MAX_CHAT_IMAGES`), a spinner then failed,
  send blocked while one uploads, `not_on_this_machine` for the other machine's. Unit:
  `web/src/hooks/useChatImages.test.tsx`; integration: `tests/integration/chat.images.int.test.ts`.
- Claude first, GLM as the fallback, the turn cap and the stop messages. Unit:
  `tests/unit/chat-agent.test.ts`.
- A turn's context: the token budgets, `<reply_to>`, tag neutralising, `[msg:ID]` stripping. Unit:
  `tests/unit/chat-context.test.ts`, `tests/unit/chat-citation.test.ts`.
- The history page's reply, edit, delete with its answer, undo and Show deleted. Unit:
  `web/src/components/BubbleActions.flow.test.tsx`.

- Finding and playing films on pahe.ink, idlix, lk21, flicksy and dramacool from the chat bar: see
  `streaming.md`. The Movies page's own pill is in `movies.md`.

## How to get to it (user POV)
The bar at the bottom of the wall, `Send`; `Chat history` in the sidebar or on the rail.

## Driving it with verify.sh
History, without the LLM: `$V api RUN GET /api/chat/messages`, then PATCH, DELETE and restore a
message, and read it back. The capture route takes the hook's payload; see `src/http/capture.ts`
for its shape. `$V api` sends no custom header, so call the capture route with curl and
`-H 'X-Notes-Capture: 1'`.

Pasted pictures without a turn: `$V upload RUN /api/chat/images tests/fixtures/images/plain.png`
returns the upload's id; the UI half (spinner, send blocked) is in the unit tests above.

Ids as links without a turn: seed a capture whose answer holds a real note id and `img:<imageId>`,
then a steps file on `/history` checks both render as links.

A real chat turn runs the Claude agent and bills. Drive it only when the change is in the chat
path, once, with a one-line question, and say in the report that it was billed.

## Gotchas
- Without a real turn, prove persistence and rendering with seeded rows from a capture call, then the UI.
- The answer panel and status captions show only during a turn; without billing, the unit tests
  above are the proof.
