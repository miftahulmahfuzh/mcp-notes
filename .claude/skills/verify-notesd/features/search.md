# Search and related notes

## Sub-features
- Hybrid search: full text + vector similarity + tag match + recency (`src/search/blend.ts`).
- Text mode: exact words, quoted phrases, OR, `-exclusion`.
- `fallback` reported when meaning search is unavailable.
- `related(id)`: nearest notes by meaning.

## How to get to it (user POV)
Claude Code `/n find ...` (MCP `search`, `related`); the chat bar on the wall uses it too.

## Driving it with verify.sh
```sh
$V mcp RUN search '{"query":"harness"}'                  # without --embed: mode "text" + fallback
$V mcp RUN search '{"query":"\"exact phrase\"","mode":"text"}'
```
For ranking or semantic changes, run `up --embed` (billed, small) and wait for the background
embedder before searching. Prove it with `sql RUN "select count(*) from note_embeddings"`.

## Gotchas
- Without `--embed`, `related` and semantic ranking cannot be proven live. Say `inconclusive`
  for those, or rely on `npm run test:int` (deterministic fake embeddings) and say so.
- Embedding never blocks a save; an empty embeddings table right after a create is normal.
