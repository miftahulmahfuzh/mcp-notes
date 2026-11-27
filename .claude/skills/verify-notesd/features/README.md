# notesd feature map

What notesd does, from the user's side, and what proves each feature works. One file per
feature, each with the same four sections: `Sub-features`, `How to get to it (user POV)`,
`Driving it with verify.sh`, `Gotchas`. A plan's **Proof** section cites entries by file name.

| Feature | File | Surfaces |
| --- | --- | --- |
| Notes: create, edit, append, tags, revisions, soft delete | [notes.md](notes.md) | API, MCP, wall |
| Search and related notes | [search.md](search.md) | MCP, chat |
| Photos and files in notes | [images-files.md](images-files.md) | API upload, MCP, wall, inbox folder |
| Recycle bin (restore, delete forever) | [recycle-bin.md](recycle-bin.md) | API, wall |
| The wall: live updates, editor, sidebar | [wall.md](wall.md) | wall |
| Projects: Claude Code session graph | [projects.md](projects.md) | API, MCP, wall `/projects` |
| Reminders: `remind` tool, due reminders in a fresh Claude Code session's start context, the daemon's one-week seed | [reminders.md](reminders.md) | MCP, the SessionStart hook route, database |
| Chat bar and chat history | [chat.md](chat.md) | wall, API (billed) |
| Seer Adversarial: reviewer, verdicts in Seer, toggle, budget, read API, MCP, SSE, wall | [adversary.md](adversary.md) | background job (`up --adversary`), Seer DB, API, MCP, SSE, wall |
| dword vocabulary (`/v`) and journal (`/j`) | [dword.md](dword.md) | MCP, Claude Code skills |
| Egress meter and quota breaker (`/api/debug/egress`, `NOTESD_EGRESS_METER`) | [egress.md](egress.md) | HTTP (loopback) |
| Movies: library sync, TMDB metadata, Play/Resume in VLC with progress, deleted vs watched, unmatched list, the Stream side (titles verified to stream here), the Download buttons, the Cache page and its Downloading view, the Stream health page (`direct_stream_health`), episode and season stories, `movies_*` tools | [movies.md](movies.md) | background sync (`up --movies`), API, MCP, fake VLC, wall `/movies` |
| Direct streaming: provider registry and health, play, sessions, the stream pass-through (`/api/stream/*`), the daily provider canary, torrent downloads and their file route (`--torrent`), downloads asked for (`/api/stream/downloads`), seek previews on the player's timeline, the play log (`stream_play_log`) | [direct-streaming.md](direct-streaming.md) | API, fake resolver and fixture stream host (`up --direct-stream`), database, loopback torrent seeder (`up --torrent`) |

Add an entry when a change ships a new user-facing feature; fix an entry when the app's behavior
changed on purpose. A journey that fails because the app is broken is a product bug: report it,
do not edit the entry to match.
