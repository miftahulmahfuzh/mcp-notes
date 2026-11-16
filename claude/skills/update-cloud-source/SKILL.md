---
name: update-cloud-source
description: Add the stream providers an aggregator streaming site uses to mcp-notes' direct-streaming registry, and probe each new one. Use whenever the user types "/update-cloud-source <site url>" in any Claude Code session — e.g. "/update-cloud-source https://ww6-fmovies.com/" — and for a plain-English request to the same effect, such as "add the servers ww6-fmovies uses", "does this site have providers we lack?", "update the cloud sources from <site>". Also use for "which stream providers do we have?" and "is VidFast working?", which only list the registry. Reads the site's scripts for provider address templates (or, when they hold none, the embed frames a watch page loads in the streaming Chrome), adds the ones the registry lacks, probes each against known titles out of sight, and reports per provider.
argument-hint: <site url> [a film's watch page] [an episode's watch page]
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

The site is read two ways, the second only when the first finds nothing:

1. **Its scripts**, with plain requests and no browser.
2. **Its frames:** a watch page is opened in a background tab of the streaming Chrome, muted, and
   each embed frame it loads that carries the film's TMDB id becomes a template. This runs when
   the scripts hold no template; the page opened is `watch_page`, else the site address itself.

Pass `watch_page` (a film's page on the site) and `episode_page` (an episode's page, for the
episode template) only when the user gave them; never make one up. When the answer is
`no_templates` after both readers, ask the user for a film's watch page on the site, best a
known title's (Fight Club), and call again with it as `watch_page`. A site that answers a plain
request with a bot check is read through its frames only when the user gave a watch page.

Only to look at what a site offers, without adding anything, run the reader directly:

```sh
node ~/mcp-notes/claude/streaming/direct/cli.mjs templates https://ww6-fmovies.com/ --no-chrome
```

Without `--no-chrome` the same command opens the site in the streaming Chrome when its scripts
hold no template (`--watch <film page>` and `--episode <episode page>` name the pages).

For "which providers do we have?" or "is VidFast working?", call `direct_stream_sources`
instead: it lists the registry with this machine's health and changes nothing.

## Step 3: answer

- **`ok: true`:** one line with the counts: found, already known, added, skipped, and which reader
  found them (`reader`: `scripts` or `frames`). A provider read from a frame is named after the
  frame's host (`vidlink.pro`), since a frame has no name. Then one line
  per added provider: its name (and `renamed_from` when the site called it something else
  because the name was taken), whether it `resolves`, and per probed title the outcome with the
  seconds, the best height and whether it had an English subtitle. A provider that resolved
  nothing is still in the registry: say so, and that the resolver tries it last. Nothing added:
  say the registry already had every provider the site uses.
- **`ok: false`:** the registry is unchanged; say why in one line:
  - `bot_check`: the site answers a plain request with a bot check, or shows one in the streaming
    Chrome. It is not got past. For the plain request's, a watch page the user gives is read
    through its frames instead.
  - `no_templates`: neither the site's scripts nor the frames of the page that was opened hold a
    provider template; `detail` says what each reader read. Only the frames a page loads by
    itself are seen: its other server buttons are not pressed.
  - `chrome_unavailable`: the streaming Chrome could not open the watch page (`detail` has the
    reason: `no_chrome`, `chrome_not_reachable`).
  - `unreachable`: the address does not answer; check it.
  - `busy`: another `/update-cloud-source` is still probing; ask again after it answers.
  - `reader_failed`, `bad_url`: report the detail.
- **`direct_stream_off`:** direct streaming is off on this daemon (`NOTESD_DIRECT_STREAM=off`,
  `NOTESD_MOVIES=off`) or the daemon runs without it.

Never add a provider by hand, never edit `providers.seed.json` for this, and never probe again
on your own: the owner asks.
