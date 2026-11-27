# Search and related notes

## Sub-features
- Hybrid search: full text + vector similarity + tag match + recency (`src/search/blend.ts`).
- Text mode: exact words, quoted phrases, OR, `-exclusion`.
- `fallback` reported when meaning search is unavailable.
- `related(id)`: nearest notes by meaning.
- `search` filters shared with `list`, `deleted` included (`exclude` by default, `include`, `only`);
  a `-word` exclusion also drops meaning-side matches. Integration:
  `tests/integration/search.hybrid.int.test.ts`.
- `similar_images` (`image_id`, `query`, `upload_id`, `pasted_image`): photos close to a photo or
  to words. Without an image embedder it answers `IMAGE_SEARCH_OFF` (`src/mcp/similarTools.ts`).
  Unit: `tests/unit/similarTools.test.ts`; integration with a fake image embedder:
  `tests/integration/similarImages.mcp.int.test.ts`.
- The image embedding worker (photos embedded after upload, in the background). Integration:
  `tests/integration/imageEmbeddings.worker.int.test.ts`.
- The backfill commands `npm run embed:backfill` and `npm run embed:images:backfill`. Unit:
  `tests/unit/embeddings/embedBackfillCli.test.ts` (text CLI),
  `tests/unit/embeddings/imageBackfill.test.ts` (the image loop; no test runs the image CLI itself).

## How to get to it (user POV)
Claude Code `/n find ...` (MCP `search`, `related`); the chat bar on the wall uses it too.

## Driving it with verify.sh
```sh
$V mcp RUN search '{"query":"harness"}'                  # without --embed: mode "text" + fallback
$V mcp RUN search '{"query":"\"exact phrase\"","mode":"text"}'
```
```sh
$V api RUN DELETE /api/notes/<id>
$V mcp RUN search '{"query":"harness","deleted":"only"}'  # the deleted note, and only it
$V mcp RUN similar_images '{"query":"red top"}'          # without --embed: the "semantic image search is off" error
```
With `up --embed`, upload a photo, then
`$V sql RUN "select count(*) from note_image_embeddings where embedding is not null"` shows the
worker's row, and `similar_images '{"image_id":"<id>"}'` answers.

For ranking or semantic changes, run `up --embed` (billed, small) and wait for the background
embedder before searching. Prove it with `sql RUN "select count(*) from note_embeddings"`.

## Gotchas
- Without `--embed`, `related` and semantic ranking cannot be proven live. Say `inconclusive`
  for those, or rely on `npm run test:int` (deterministic fake embeddings) and say so.
- Embedding never blocks a save; an empty embeddings table right after a create is normal.
