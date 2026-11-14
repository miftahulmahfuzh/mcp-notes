# Search, related notes and similar photos

`search` finds notes by meaning as well as by words. It blends four signals (full-text rank,
closeness in meaning, tag match and recency) so that a question in plain words finds a note that
shares no word with it, while an exact id, code token or version string still ranks first.
`related` returns the notes nearest in meaning to one note, and `similar_images` does the same
for pictures, by what is in them. All three are MCP tools, used by `/n` in Claude Code
([claude-code.md](claude-code.md)) and by the chat bar on the wall ([chat.md](chat.md)). There is
no HTTP search route.

Arguments and result shapes are in the reference:
[`search`](reference/mcp-tools.md#search), [`related`](reference/mcp-tools.md#related),
[`similar_images`](reference/mcp-tools.md#similar_images).

## Asking

```
/n have we seen auth failures after resume before?
/n where did I write down the ArangoDB credentials procedure?
/n find notes about retry backoff tagged #infra from October
/n find the note that contains "connection pool" but not redis, exact words only
/n what else do I have that is related to A-B32?
/n find photos like the first picture in A-B32
/n do I have pictures of a red top in a car?
```

Claude passes a question to `search` as it was asked. It switches to `mode: "text"` when the
note must contain an exact token, error string or command. Both modes take the same filters as
`list`: `tags_any`, `tags_all`, a `from`/`to` date range on the created or updated date,
`has_image`, `taken_from`/`taken_to`, `limit` (default 50, at most 200) and `cursor`.

## Hybrid search

Hybrid is the default mode. One search does this:

1. **Embed the query.** One OpenRouter call, bounded at 5 seconds. The daemon keeps the last 64
   query vectors, so paging and repeated questions cost nothing.
2. **Gather candidates**, every source under the same filters, so filters apply before ranking:
   - the best 500 full-text matches (`websearch_to_tsquery` with the `simple` configuration),
   - the 100 nearest notes by cosine similarity among notes with a current vector,
   - any note whose id the query names.
3. **Score and sort** each candidate with the blend below. A candidate that matched only by
   meaning is dropped when its similarity is under the floor, so results are not padded with the
   nearest unrelated notes.
4. **Page.** `next_cursor` is an offset into that ranking.

The result says `mode: "hybrid"`.

### The blend

All weights live in `src/search/blend.ts` (`BLEND`), each with a comment that says what it is for
and how it was tuned.

```
score = exactId                          2, when the query names this note's id
      + textFloor + text * rank / best   0.6 + 0.4 * (ts_rank / best ts_rank), for a full-text match
      + vector * meaning                 0.6 * similarity rescaled so 0.22 -> 0 and 1 -> 1
      + tag * tagMatch                   0.25 * (0..1)
      + recency * 0.5^(age / 90 days)    0.1 at most
```

| Signal | Weight | How it is measured |
|---|---|---|
| Exact id | `exactId` 2 | The query contains the note's id: `A-B32` or `a-b32` anywhere, or a lone `ab32` when it has a digit (so an ordinary four-letter word is not read as an id) |
| Full text | `textFloor` 0.6 + `text` 0.4 | Any literal match gets the floor; the rest scales with its rank against the best match |
| Meaning | `vector` 0.6, `minSimilarity` 0.22 | Cosine similarity of the note's vector to the query's |
| Tag | `tag` 0.25 | A `#hashtag` in the query that the note carries fills it (`hashtagHit` 1). A bare query word that is one of the note's tags counts half (`wordTagHit` 0.5) |
| Recency | `recency` 0.1, half-life 90 days | From the note's `updated_at`. Small on purpose: an old note that answers beats a new near miss |

Ties break on `updated_at`, then id, newest first.

Two rules hold through any retune and are asserted in `tests/unit/search.blend.test.ts`:

- `textFloor + text > vector + tag + recency`: the best literal hit beats every note that matched
  by meaning only. A word you typed is never pushed down by notes that are merely on topic.
- `exactId > textFloor + text + vector + tag + recency`: a note named by id beats everything.

A `-word` exclusion in the query also removes notes from the meaning side, not only from the
full-text side.

## Text mode

`mode: "text"` is full-text search alone, ranked by `ts_rank`, then `updated_at`, then id. It is
exhaustive (no candidate cap) and needs no embedding call. The query is parsed by Postgres'
`websearch_to_tsquery`:

| You write | It means |
|---|---|
| `retry backoff` | Both words, anywhere in the note |
| `"connection pool"` | The exact phrase |
| `redis OR valkey` | Either word |
| `"connection pool" -redis` | The phrase, in notes that do not contain `redis` |

The `simple` configuration does no stemming and drops no stop words: `pooling` does not find
`pool`, and matching ignores case. That is the point of it: ids, code tokens, flags and version
strings match exactly as written. Hybrid mode uses the same parser for its full-text side, so the
same syntax works there.

## The `fallback` report

Meaning search needs `OPENROUTER_API_KEY`. A hybrid search that cannot use it still answers, with
the text-mode ranking, and says so:

```json
{
  "notes": [ ... ],
  "next_cursor": null,
  "mode": "text",
  "fallback": "Meaning search is off on this server (OPENROUTER_API_KEY is not set), so these are full-text results only: notes that share words with the query."
}
```

| Situation | `mode` | `fallback` |
|---|---|---|
| Hybrid search worked | `hybrid` | absent |
| You asked for `mode: "text"` | `text` | absent |
| No `OPENROUTER_API_KEY` | `text` | "Meaning search is off on this server ..." |
| The query could not be embedded in 5 s (timeout, provider error) | `text` | "The query could not be embedded (reason) ..." |

The server's instructions tell Claude to pass the fallback on to you. A search never fails
because of the embedder.

## Related notes

`related(id)` returns the live notes nearest in meaning to one note, most similar first, each with
a `similarity` (1 = same meaning, near 0 = unrelated). It takes `limit` 1 to 50, default 10.

- It never returns the note itself, a deleted note or a note whose vector no longer matches its
  body.
- It reads stored vectors only. If the source note has no current vector yet, the tool embeds it
  on the spot and stores the result.
- It refuses a deleted note (`deleted`: restore it first) and a note with no text, such as a photo
  without a caption (`invalid_input`).
- Without `OPENROUTER_API_KEY` it still answers for a note that already has a current vector, and
  answers `not_embedded` for one that does not.

## Embeddings

Every note body is embedded with `openai/text-embedding-3-small` over OpenRouter, 1536
dimensions, into `note_embeddings` (pgvector, HNSW cosine index).

- **Keyed to the body.** Each row stores the sha256 of the body it was made from and the model. A
  vector counts as current only when both match the note today, so a vector that no longer
  describes its note is never used. An edit makes the row stale and the note is embedded again.
- **In the background.** Embedding starts after a write commits. A slow or failing OpenRouter
  never blocks or fails a save. Right after a `create`, the note has no vector yet and is found by
  words only.
- **How the worker runs.** Note events schedule a drain after a 500 ms debounce, in batches of 16
  with at least one second between calls. A sweep every 60 seconds picks up notes written by the
  daemon on the other machine and retries that are due.
- **Retries.** A failed note is retried after 30 seconds, doubling up to one hour. The last error
  is kept on the row with keys redacted.
- **What gets a vector.** Bodies are trimmed and cut at 8,000 characters. A note with no text has
  no vector. A deleted note keeps its vector, so a restore needs no new call.

### Backfill

The background worker catches up by itself. The CLI does the same work in one go and prints
progress, for a first run with many notes or after a model change:

```sh
npm run embed:backfill                      # every note whose vector is missing, stale, or failed and due
npm run embed:backfill -- --retry-failed    # also retry failed notes without waiting for their backoff
```

It is safe to stop with Ctrl-C and run again; finished notes are not embedded twice. It needs
`OPENROUTER_API_KEY` and the database settings from `.env.local`.

## Similar photos

`similar_images` finds the pictures that look most like one picture, or that match a description.
It takes exactly one source:

| Source | What it is |
|---|---|
| `image_id` | A picture already in a note (an id from the note's `images`) |
| `query` | Words describing what is in the picture, such as "red top in a car" |
| `upload_id` | A picture pasted into the wall's chat bar, named `[image upload:ID]` in the message |
| `pasted_image` | Claude Code only: the N of `[Image #N]`. The notes-paste hook uploads it and swaps this for `upload_id` before the call arrives |

Hits come back most similar first as `{image_id, note_id, similarity, note: {body, tags},
available}`, 10 by default and at most 50. The source picture, removed pictures and pictures of
deleted notes are never returned. The score only measures likeness, so Claude is told to open the
top hits with `view_images` and look before saying which ones match.

`similar_images` looks at pixels. To find photos by the words in their note, use `search` (with
`has_image: true` if you want only notes with pictures).

### Image embeddings

Every note image is embedded by its pixels with `google/gemini-embedding-2` over OpenRouter (the
same key) into `note_image_embeddings`, 1536 dimensions, HNSW cosine. The model puts words and
pictures in one vector space, which is why a text `query` works. These vectors are a different
space from the note text vectors and the two are never compared.

- What is sent is a PNG of the picture, at most 1024 px on its long edge. The stored original is
  never changed.
- New images are embedded in the background, with the same debounce, sweep and backoff as notes.
- A picture whose file lives on the other laptop is skipped here and embedded by that laptop's
  daemon. This daemon looks at it again after an hour.
- With `image_id`, a picture that has no vector yet is embedded on the spot. A pasted picture
  (`upload_id`) is embedded for the question and not stored.

```sh
npm run embed:images:backfill -- --dry-run        # count what is pending, estimate tokens and cost; no network, no writes
npm run embed:images:backfill -- --limit 20       # embed at most 20 images, as a trial
npm run embed:images:backfill                     # embed everything pending on this machine
npm run embed:images:backfill -- --retry-failed   # also retry failures without waiting for their backoff
```

The dry-run estimate uses the provider's published rule (258 tokens for a small picture, 258 per
768 px tile for a larger one, about $0.45 per million image tokens) and is labelled as an
estimate. The backfill never runs by itself.

## What else uses the blend

- **Session search.** `sessions_search` and the Projects page rank Claude Code sessions with the
  same `blendScore`, over candidates from the session's own text and vector, its node id, the
  notes saved from or linked to it and Claude's replies in it. Evidence borrowed from a note or a
  reply counts `BLEND.related` (0.6) times the session's own. See [sessions.md](sessions.md).
- **Session summaries and replies** are embedded with the same text model and worker, into their
  own tables.
- **The chat bar** calls the same `search`, `related` and `similar_images` tools.
- The daily-words journal's duplicate check uses the same embedding model but its own threshold
  and table; see [connectors.md](connectors.md).

## Quirks and limits

- **A new or edited note is word-searchable at once, meaning-searchable a moment later.** An empty
  `note_embeddings` table right after a create is normal.
- **No key, no meaning.** Without `OPENROUTER_API_KEY`: `search` falls back to full text and says
  so, `related` answers only for notes that already have a vector, and `similar_images` with a
  `query` or a pasted picture answers that semantic image search is off.
- **Hybrid considers at most 500 literal and 100 meaning candidates** per query. For an exhaustive
  list of every note containing a word, use text mode and page with `next_cursor`.
- **A cursor belongs to the ranking that made it.** If one page is hybrid and the next falls back
  to text, the offset points into a different order.
- **A lone four-character query with a digit is read as a note id** (`ab32`). Write an all-letter
  id with its dash.
- **Photos without text are invisible to `search` and `related`.** They have no body to match or
  embed. Find them with `list` (`has_image`, dates) or `similar_images`.
- **Pictures are per machine.** A hit with `available: false` lives on the other laptop: it ranks,
  but `view_images` cannot show it here. A pasted upload whose file is on the other machine cannot
  be compared from this daemon.
- **Changing a model or its width** needs a migration and a full re-embed (the vector column is
  `vector(1536)`), then the matching backfill.
- **Deleted notes** never appear in `search`, `related` or `similar_images`, but keep their
  vectors.

## Where the code is

| Path | What it holds |
|---|---|
| `src/search/blend.ts` | `BLEND` weights, query parsing (`queryTerms`), `blendScore`, `rankCandidates` |
| `src/search/queryVector.ts` | Query embedding with timeout and cache; the `fallback` wording |
| `src/notes/service.ts` | `search` (hybrid, text, fallback) and `related` |
| `src/notes/repo.ts` | `searchNotes` (text mode) and `searchCandidates` (the hybrid candidate query) |
| `src/embeddings/constants.ts`, `state.ts` | Text model, dimensions, input cap; embedding states and retry delays |
| `src/embeddings/worker.ts`, `backfill.ts`, `repo.ts` | The background worker, the batch loop, `note_embeddings` reads and writes, `nearestNotes` |
| `src/embeddings/openrouter.ts`, `embedder.ts` | The OpenRouter text embedder and its interface |
| `src/embeddings/image*.ts`, `openrouterImage.ts`, `chatUploads.ts` | Image model constants, worker, backfill, repo, PNG input, pasted uploads |
| `src/mcp/tools.ts`, `src/mcp/similarTools.ts` | The `search` and `related` tools; `similar_images` |
| `src/cli/embedBackfill.ts`, `embedImagesBackfill.ts` | `npm run embed:backfill`, `npm run embed:images:backfill` |
| `tests/fixtures/semantic/` | The labelled queries the weights are tuned on |

## Proving a change

The feature map entry is `.claude/skills/verify-notesd/features/search.md`.

```sh
V=.claude/skills/verify-notesd/scripts/verify.sh
$V up                                                      # no key: proves text mode and the fallback
$V mcp RUN search '{"query":"harness"}'                    # mode "text" + fallback
$V mcp RUN search '{"query":"\"exact phrase\" -word","mode":"text"}'
$V down RUN
```

- Ranking and meaning cannot be shown live without a key. `verify.sh up --embed` runs with a real
  key (billed, small): wait for the background embedder, check
  `verify.sh sql RUN "select count(*) from note_embeddings"`, then search.
- Without `--embed`, rely on the tests, which use deterministic fake embeddings and make no
  network call: `tests/unit/search.blend.test.ts`, `tests/unit/search.queryVector.test.ts`,
  `tests/unit/similarTools.test.ts`, and with `npm run test:int`
  `search.hybrid.int.test.ts`, `related.int.test.ts`, `embeddings.worker.int.test.ts` and
  `similarImages.mcp.int.test.ts`.
- `npm run test:live:embeddings` re-checks the weights against the real model. It is opt-in and
  billed, and never part of `npm test` or `test:int`.
- After retuning a weight, keep both invariants above and update the comment next to the number.
