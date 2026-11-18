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

The site is read three ways, each only when the one before finds nothing:

1. **Its scripts**, with plain requests and no browser.
2. **Its frames:** a watch page is opened in a background tab of the streaming Chrome, muted, and
   each embed frame it loads that carries the film's TMDB id becomes a template. This runs when
   the scripts hold no template; the page opened is `watch_page`, else the site address itself.

3. **The page itself:** a site that plays in its own page (cinemaos.live) has no embed frame.
   When the watch page gave no frame template and loaded a stream by itself, its own address
   becomes the template (`reader`: `page`), named after the site's host.

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
  found them (`reader`: `scripts`, `frames` or `page`). A provider read from a frame is named after the
  frame's host (`vidlink.pro`), since a frame has no name; a `page` provider is the site itself. Then one line
  per added provider: its name (and `renamed_from` when the site called it something else
  because the name was taken), whether it `resolves`, and per probed title the outcome with the
  seconds, the best height and whether it had an English subtitle. A provider that resolved
  nothing is still in the registry: say so, and that the resolver tries it last. Nothing added:
  say the registry already had every provider the site uses.
- **`ok: false`:** the registry is unchanged; say why in one line:
  - `bot_check`: the site answers a plain request with a bot check, or shows one in the streaming
    Chrome. It is not got past. For the plain request's, a watch page the user gives is read
    through its frames instead. If the SAME `bot_check` (or `no_templates` with a watch page
    given) keeps coming back try after try, the site's challenge never completes in the
    background tab the frame reader opens fresh each time — offer step 2b below instead of
    retrying the same way again.
  - `no_templates`: neither the site's scripts nor the frames of the page that was opened hold a
    provider template, and the page loaded no stream by itself; `detail` says what each reader read. Only the frames a page loads by
    itself are seen: its other server buttons are not pressed.
  - `chrome_unavailable`: the streaming Chrome could not open the watch page (`detail` has the
    reason: `no_chrome`, `chrome_not_reachable`).
  - `no_tab`: `from_tab` was asked and no gated tab answered — the owner has not gated the site
    yet, gated it too long ago, or has not solved the challenge yet. Offer step 2b again.
  - `unreachable`: the address does not answer; check it.
  - `busy`: another `/update-cloud-source` is still probing; ask again after it answers.
  - `reader_failed`, `bad_url`: report the detail.

## Step 2b: a site whose challenge keeps coming back

A plain request's `bot_check`, or `no_templates` right after one, usually clears on the next try.
When it keeps answering `bot_check` (or `no_tab`) across several calls, the site's Cloudflare
challenge cannot complete in the background tab the frame reader opens on its own — same wall as
ext.to's torrent index. Tell the user to run, in a terminal:

```sh
node ~/mcp-notes/claude/streaming/direct/cli.mjs gate <site url>
```

This brings the site's tab to the front of the streaming Chrome so they can solve the challenge by
hand; it answers `{ ok: true, cleared: true }` once it is gone (or `cleared: false` after about
40 seconds with none). Only once they say it is solved, call `direct_stream_update_source` again
with the same arguments plus `from_tab: true`: this reads that SAME tab's current frames with no
new navigation, so the challenge never shows again. Never run the gate command yourself or click
through the challenge for them — the owner solves it in their own browser, the same rule as every
other bot check in this project.
- **`direct_stream_off`:** direct streaming is off on this daemon (`NOTESD_DIRECT_STREAM=off`,
  `NOTESD_MOVIES=off`) or the daemon runs without it.

Never add a provider by hand, never edit `providers.seed.json` for this, and never probe again
on your own: the owner asks.
