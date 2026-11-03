# Chat bar and chat history

## Sub-features
- Ask about notes from the wall's bottom bar ("Ask about your notes"); answers stream.
- Threads and messages persisted; edit, delete, restore messages; chat about an image.
- `/n` exchanges captured from Claude Code via `POST /api/capture/claude-code`.

## How to get to it (user POV)
The bar at the bottom of the wall, `Send`; `Chat history` in the sidebar.

## Driving it with verify.sh
History, without the LLM: `$V api RUN GET /api/chat/messages`, then PATCH, DELETE and restore a
message, and read it back. The capture route takes the hook's payload; see `src/http/capture.ts`
for its shape.

A real chat turn runs the Claude agent and bills. Drive it only when the change is in the chat
path, once, with a one-line question, and say in the report that it was billed.

## Gotchas
- Without a real turn, prove persistence and rendering with seeded rows from a capture call, then the UI.
