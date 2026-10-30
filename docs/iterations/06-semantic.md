# Iteration 6 — Semantic search

One `/analyze` run covering ROADMAP iteration 6. Everything below the line is the owner's
request, verbatim input for /analyze Step 0.

---

Build mcp-notes iteration 6 ("Semantic") from docs/ROADMAP.md. The "Fixed decisions" table in
docs/ROADMAP.md is binding: do not re-decide anything in it, in particular the "Semantic search"
row (pgvector on the notes DB, embeddings via OpenRouter as run-insights does, hybrid ranking:
full-text + tags + recency + vector). Iterations 1–5 are on main (plans in docs/plans/).

The usage examples this iteration exists for:
  /n check our notes, have we met this kind of accidents before? maybe we already have a solution for this
  /n find a relevant notes that talks about ArangoDB credentials
Today `search` is Postgres full text ('simple' config) plus tags and dates, so a note only comes
back when it shares words with the question. A note saying "arango root password is in the
vault" must come back for "ArangoDB credentials", and "the login broke after the laptop slept"
must come back for "have we seen auth failures after resume before?".

R1 — Embeddings. Follow how ~/run-insights does it (read its lib/ for the embedding module:
OpenRouter's /embeddings endpoint, `openai/text-embedding-3-small`, 1536 dimensions, its input
cap and its error handling); do not import its code. The key is `OPENROUTER_API_KEY` in this
repo's .env.local. Every note's body is embedded on create, update, append and revert, after the
write commits, so a slow or failing embedding call never blocks or fails a note write: the note is
saved, marked as needing an embedding, and retried later. A note's embedding always matches its
current body (store which body it was made from, e.g. a hash, so a stale vector is detectable).
Image notes embed their text; a photo note with no text has no embedding. Deleted notes keep
their vector (restore must not need a new call) but never appear in results.

R2 — Schema. pgvector on the notes database: `create extension vector`, a vector column (or a
side table, planner's choice) with an HNSW index for cosine distance. This is the first migration
since iteration 1. It must apply cleanly to the live Neon database (pgvector 0.8.6 is available
there) and to the test Postgres; the integration test container needs an image that ships
pgvector (e.g. pgvector/pgvector:pg16) instead of plain postgres:16.

R3 — Backfill. Notes that existed before this iteration, and notes whose embedding failed, get
embedded by a background job inside notesd (same lifecycle as the inbox watcher): batched,
rate-limited, resumable, logged, and quiet when there is nothing to do. Plus a one-shot command
(`npm run embed:backfill`) that does the same and prints progress, for the first run and for a
model change.

R4 — Hybrid search. `search` ranks by a blend of full-text rank, vector similarity, tag match and
recency, with the existing filters (tags any/all, date ranges, has_image, taken dates) applied
before ranking. A query with no word overlap still finds semantically close notes; an exact id
or a rare code token still ranks first (full text must not be drowned by the vector side). If
the embedding call for the query fails, search falls back to today's full-text ranking and says
so in the result, instead of erroring. The weights live in one place with a short comment on
why each is what it is; tune them against a small labelled set of example notes and queries
kept in the tests (include the two usage examples above in the set, in spirit).
The MCP `search` tool keeps its name and inputs (optionally a `mode`: hybrid by default,
`text` for exact-word search); its description and the server instructions say it now
understands meaning, not only words. `/n` and the chat bar need no change beyond that, but the
chat bar's status caption for search stays "searching notes".

R5 — Related notes. A `related` MCP tool: given a note id, the nearest notes by meaning, with a
similarity score, excluding the note itself. In the web UI, nothing changes in this iteration
(no new buttons), so the design stays as it is.

R6 — Tests. Unit tests for the blending and the stale-embedding logic with a fake embedder.
Integration tests on the pgvector container with a deterministic fake embedder (no network in
`npm test` or `test:int`): write paths enqueue and fill embeddings, a failed embedding does not
fail the write and is retried, backfill is resumable, hybrid search beats text-only on the
labelled set, query-embedding failure falls back to text. One opt-in live test
(`EMBEDDINGS_LIVE_TEST=1`, excluded by default) calls OpenRouter for real once.

Acceptance (with a handful of real notes written first, through `/n` in Claude Code and the
chat bar):
  /n check our notes, have we met this kind of accidents before? maybe we already have a solution for this
  /n find a relevant notes that talks about ArangoDB credentials
  /n what other notes are related to <id>?
  (chat bar) anything in my notes about sleep and tiredness?

Out of scope: any UI change, semantic search over the connector systems (expenses, runs, Seer),
image embeddings (pictures are found by their text and dates), a separate vector database,
re-ranking with an LLM.
