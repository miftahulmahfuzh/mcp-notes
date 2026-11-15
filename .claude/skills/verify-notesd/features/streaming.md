# Streaming and download sites (pahe, idlix, lk21)

## Sub-features
- `/pahe <title>`: links to a title's releases on pahe.ink. Parser proven by
  `npx vitest run tests/unit/scripts/paheSearch.test.ts`; live by
  `node claude/skills/pahe/search.mjs no other choice` (free, reads pahe.ink). The chat bar's side
  is prompt text (`tests/unit/chat-prompt.test.ts`).
- `/idlix`, `/lk21`: find a title, and start a single matching film full screen. Matching and
  result building proven by `npx vitest run tests/unit/scripts/streamingSites.test.ts`.
- `streaming_find`, `streaming_play` (MCP, chat bar): proven with a fake runner by
  `npx vitest run tests/unit/mcp.streamingTools.test.ts tests/unit/streaming.test.ts`; the chat
  allow list and captions by `tests/unit/chat-status.test.ts`.

## How to get to it (user POV)
`/idlix no other choice` in Claude Code, or the same words in the wall's chat bar.

## Driving it
- A throwaway daemon has no streaming runner: both tools answer `streaming_off`. That is the
  expected proof there; do not wire the real script into a throwaway instance.
- Live lookup, free: `node claude/streaming/cli.mjs lk21 ready or not 2019`. The idlix lookup
  opens the streaming Chrome on Windows, minimized.
- Live play: `node claude/streaming/cli.mjs <site> --play <film>`. It brings Chrome to the front,
  goes full screen and plays with sound. Run it only when the owner expects it, and say so in
  the report.

## Gotchas
- The sites change. A failing live run with passing unit tests means the site moved host
  (`IDLIX_ORIGIN`, `LK21_ORIGIN`) or changed its page: follow
  `claude/skills/create-streaming-skill` to look again.
- Never test against the owner's everyday Chrome. The scripts use their own profile folder.
