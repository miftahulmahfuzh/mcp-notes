# The mcp-notes guide

One guide per subsystem. Each says what the part does, its quirks and limits, where the code is and
how to prove a change. The root [README](../../README.md) is the short overview.

| Guide | Covers |
| --- | --- |
| [wall.md](wall.md) | The wall web app: views, tags, the big editor, photos, files, recycle bin, shortcuts |
| [claude-code.md](claude-code.md) | The `notes` MCP server, `/n`, hooks, clickable ids, `/migrate` |
| [search.md](search.md) | Hybrid search, related notes, similar photos, embeddings |
| [chat.md](chat.md) | The chat bar and the chat history page |
| [sessions.md](sessions.md) | The project session graph: node ids, parent links, summaries, context rot, resume, swarms |
| [connectors.md](connectors.md) | expense-tracking, run-insights, Seer and daily-words (`/v`, `/j`) |
| [adversary.md](adversary.md) | Seer Adversarial: the reviewer, verdicts, twin books, the page |
| [movies.md](movies.md) | The Movies library: scan, TMDB, movie ids, watch state, VLC, every question you can ask |
| [install.md](install.md) | Install, a second machine, running by hand, tests, docs tooling |
| [architecture.md](architecture.md) | Wiring, the one-writer rule, data model, disk layout, limitations |

## Reference

| File | Source |
| --- | --- |
| [reference/mcp-tools.md](reference/mcp-tools.md) | Generated from the tools the MCP server registers |
| [reference/http-api.md](reference/http-api.md) | Generated from the daemon's route table and `scripts/docs/httpRoutes.ts` |
| [reference/configuration.md](reference/configuration.md) | Written by hand; every environment variable the code reads must have a row |

## Keeping it true

`npm test` fails when a generated file is stale, a route or environment variable is undocumented, a
link is broken or a picture under `img/` is unused. The commands are in
[install.md](install.md#docs-tooling).

Pictures live in `img/<guide>/` and are written only by `npm run docs:shots -- <guide>`, which runs
`scripts/docs/shots/<guide>.mjs` against a throwaway daemon with seeded, made-up data. The chat
pictures need a real, billed Claude run and are retaken only on request (`DOCS_CHAT_BILLED=1` for
`chat`, `DOCS_SHOTS_CHAT=1` for `movies`).
