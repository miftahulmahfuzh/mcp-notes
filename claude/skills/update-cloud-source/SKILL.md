---
name: update-cloud-source
description: Add the stream providers an aggregator streaming site uses to mcp-notes' direct-streaming registry, and probe each new one. Use whenever the user types "/update-cloud-source <site url>" in any Claude Code session — e.g. "/update-cloud-source https://ww6-fmovies.com/" — and for a plain-English request to the same effect, such as "add the servers ww6-fmovies uses", "does this site have providers we lack?", "update the cloud sources from <site>". Also use for "which stream providers do we have?" and "is VidFast working?", which only list the registry. Reads the site's scripts for provider address templates, adds the ones the registry lacks, probes each against known titles out of sight, and reports per provider.
argument-hint: <site url>
---

# /update-cloud-source — add an aggregator site's stream providers

Direct streaming plays films from "providers": embed addresses keyed by a TMDB id, such as
`https://vidfast.pro/movie/{id}`. Aggregator sites (ww6-fmovies.com and its kind) are lists of
them. This skill reads such a site's list and adds to the registry the providers it lacks. How
it works is in `docs/guide/streaming.md` of the mcp-notes repo, section "Direct streaming".

## Step 1: the address

The text after `/update-cloud-source` is the site's address: its home page, or a film page on it.
Without `https://`, add it. Without any address, answer with the usage line
`/update-cloud-source <site url>` and stop.

## Step 2: add and probe

Call the `notes` MCP tool `direct_stream_update_source` with `site` set to the address. Before the
call, say in one line that new providers are probed in the streaming Chrome out of sight (no
window, no sound, nothing plays) and that it can take a few minutes.

Only to look at what a site offers, without adding anything, run the reader directly:

```sh
node ~/mcp-notes/claude/streaming/direct/cli.mjs templates https://ww6-fmovies.com/
```

For "which providers do we have?" or "is VidFast working?", call `direct_stream_sources`
instead: it lists the registry with this machine's health and changes nothing.

## Step 3: answer

- **`ok: true`:** one line with the counts: found, already known, added, skipped. Then one line
  per added provider: its name (and `renamed_from` when the site called it something else
  because the name was taken), whether it `resolves`, and per probed title the outcome with the
  seconds, the best height and whether it had an English subtitle. A provider that resolved
  nothing is still in the registry: say so, and that the resolver tries it last. Nothing added:
  say the registry already had every provider the site uses.
- **`ok: false`:** the registry is unchanged; say why in one line:
  - `bot_check`: the site answers a plain request with a bot check. It is not got past, and
    reading the frames its server buttons load is not built.
  - `no_templates`: the site's scripts hold no provider template a plain request can read.
  - `unreachable`: the address does not answer; check it.
  - `busy`: another `/update-cloud-source` is still probing; ask again after it answers.
  - `reader_failed`, `bad_url`: report the detail.
- **`direct_stream_off`:** direct streaming is off on this daemon (`NOTESD_DIRECT_STREAM=off`,
  `NOTESD_MOVIES=off`) or the daemon runs without it.

Never add a provider by hand, never edit `providers.seed.json` for this, and never probe again
on your own: the owner asks.
