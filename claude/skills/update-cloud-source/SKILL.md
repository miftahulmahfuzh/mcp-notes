---
name: update-cloud-source
description: Add the stream providers an aggregator streaming site uses to mcp-notes' direct-streaming registry, and probe each new one; or, given a magnet link, work out which torrent index it came from and widen the torrent sources with it. Use whenever the user types "/update-cloud-source <site url>" or "/update-cloud-source <magnet link>" in any Claude Code session — e.g. "/update-cloud-source https://ww6-fmovies.com/", "/update-cloud-source magnet:?xt=urn:btih:..." — and for a plain-English request to the same effect, such as "add the servers ww6-fmovies uses", "does this site have providers we lack?", "update the cloud sources from <site>", "where is this magnet from? add that index", "learn the trackers of this magnet". Also use for "which stream providers do we have?" and "is VidFast working?", which only list the registry. Reads the site's scripts for provider address templates (or, when they hold none, the embed frames a watch page loads in the streaming Chrome), adds the ones the registry lacks, probes each against known titles out of sight, and reports per provider.
argument-hint: <site url | magnet link> [a film's watch page] [an episode's watch page]
---

# /update-cloud-source — add an aggregator site's stream providers, or a magnet's torrent index

Direct streaming plays films from "providers": embed addresses keyed by a TMDB id, such as
`https://vidfast.pro/movie/{id}`. Aggregator sites (ww6-fmovies.com and its kind) are lists of
them. This skill reads such a site's list and adds to the registry the providers it lacks. How
it works is in `docs/guide/streaming.md` of the mcp-notes repo, section "Direct streaming".

## Step 1: the address

The text after `/update-cloud-source` is the site's address: its home page, or a film page on it.
Without `https://`, add it. Without any address, answer with the usage line
`/update-cloud-source <site url | magnet link>` and stop.

**A magnet link** (`magnet:?xt=urn:btih:...`, or a bare 40-character info hash) is not a site: go to
"A magnet link" below and skip steps 2 and 3. Pass the magnet exactly as the user pasted it, whole,
with every `&tr=`: its trackers are what names the index.

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

## A magnet link

A magnet holds three things: the torrent's info hash, its name (`dn`) and its trackers (`tr`). It
has no link back to the page it came from. But a torrent index that runs its own trackers signs
every magnet with them (RuTracker's are `bt*.t-ru.org`), so the trackers name the index. The goal
here is to widen what the torrent finder can ask: the index the magnet came from, and the public
trackers it carries. Do all of it without asking; the user pasted the magnet for exactly this.

### 1. Read the magnet

Call `direct_stream_update_source` with `magnet` set to the pasted link and nothing else (no
`site`). It plays nothing and joins no swarm. It answers:

- `origin`: the index the magnet's own trackers name (`index`, `label`, `by`: the tracker host
  that says so), or `null`.
  - `supported`: the finder has a site module for it (`claude/streaming/torrent/sites/<index>.mjs`).
  - `enabled` and `site_origin`: it is switched on, at that address.
  - `gate`: what the owner must do once by hand before the index answers (a login, a Cloudflare
    check).
- `unknown_hosts`: tracker hosts that belong to no index we know and to no public tracker we hold.
  An index we lack may run them.
- `trackers`: `own` (the index's own, never added), `known` (already used), `added` (new public
  UDP trackers that answered: from now on every torrent is opened with them and they are asked for
  seeders before a play), `silent` (did not answer, not added), `skipped` (not UDP).
- `swarm`: what the trackers know of this torrent now (`seeders`, `leechers`), or `null`.
- `next`: what to do, in words.

### 2. Act on `origin`

- **`origin.supported` and `origin.enabled`:** the finder already asks that index. Say so. When
  `gate` is set, check whether it is open: run the index's search by hand from the mcp-notes
  checkout,

  ```sh
  node ~/mcp-notes/claude/streaming/torrent/cli.mjs <index> search --title "<the title in the magnet's name>"
  ```

  `rows` means it answers. `bot_check` or `login_required` means the gate is shut: tell the user
  to run `node ~/mcp-notes/claude/streaming/torrent/cli.mjs <index> gate`, which brings the site to
  the front of the streaming Chrome so they solve the check and log in themselves, and that the
  index answers from then on. Never run the gate for them, never type a login, never click a
  challenge.
- **`origin.supported` and not `enabled`:** the site module exists and is off in this daemon's
  settings (`NOTESD_TORRENT_<INDEX>_ORIGIN=off` in `.env.local`). Say so; switching it on is the
  owner's call.
- **`origin` set but not `supported`:** an index we know by its trackers and cannot ask yet. Add it
  (step 3).
- **`origin` is `null` with `unknown_hosts`:** find out who runs those hosts. Search the web for
  each host name, and read the magnet's `dn`: its language and the way it is laid out (a Russian
  tracker writes `Русское название / Original Title / Сезон: 1 / Серии: 1-10 из 10 [2017, …]`) point
  at the site. When they name a torrent index, add it (step 3). When they are only public trackers
  (a tracker list, an open tracker anyone may use), there is no index to add: say so.
- **`origin` is `null` and no `unknown_hosts`:** the magnet carries only public trackers, so
  nothing tells where it came from. Say so. The trackers were still read (`trackers`).

### 3. Add an index the finder cannot ask yet

Work in the mcp-notes checkout (`~/mcp-notes`). Read `docs/guide/streaming.md`, "When the indexes
have nothing", first. Then, in one change:

1. **Look at the site by hand first**, with plain requests that say they are notesd: its search
   address, a result row (name, release page, seeders, leechers, size) and where a release page
   carries its magnet. A site behind a Cloudflare check or a login is looked at only after the owner
   has opened its gate; never get past either.
2. **The site module:** `claude/streaming/torrent/sites/<index>.mjs`, shaped like `1337x.mjs` (pages
   fetched from inside the site's tab), `ext.mjs` (the tab is moved) or `rutracker.mjs` (a login gate,
   pages in another encoding, and a title rewritten into a release name the finder reads). Add it
   to `sites/index.mjs`.
3. **The daemon's side, together:** `TORRENT_SITES` in `src/directStream/torrent/find-sites.ts`; the
   address and its `NOTESD_TORRENT_<INDEX>_ORIGIN` setting in `src/config.ts` (`TORRENT_SITE_ORIGIN_DEFAULTS`,
   `TorrentSitesConfig`, `parseTorrentSites`) with a row in `docs/guide/reference/configuration.md`;
   and the index's line in `KNOWN_ORIGINS` (`src/directStream/torrent/origins.ts`): its tracker
   hosts, `site` set to the module's name, and `gate` when the owner must open one.
4. **Tests** on pages saved from the site (`tests/fixtures/torrent-sites/`,
   `tests/unit/scripts/torrentSites.test.ts`), the guide's section, then `npm run typecheck`,
   `npm test` and `npm run docs:check`.
5. **Rebuild and restart** with `scripts/install.sh --wait` (it waits while something plays), then
   call `direct_stream_update_source` with the same magnet again: `origin.supported` is now `true`.

The rules of every site hold here too: only the streaming Chrome talks to a site, never a disguised
client, never a forged token, and a bot check or a login is the owner's to clear by hand.

When the site cannot be added (it is gone, it lists nothing by title, it needs something only the
owner can give), say which index it is and why it was left out; its line in `KNOWN_ORIGINS` with
`site: null` still tells the next magnet from it.

### 4. Answer

Keep it short, one line each:

- the torrent: its name and what the trackers know of it (`swarm`), so the user sees whether it
  can stream at all ("1 seeder, 7 leechers: too thin to stream");
- the index it came from and what became of it: already asked, gate shut (with the command), added
  now, or could not be told;
- the trackers: how many were added, and that they now go with every torrent.

Errors: `bad_magnet` (not a magnet link or an info hash: ask for the whole link), `torrent_off`
(torrents are off on this machine, `NOTESD_TORRENT=off`), `direct_stream_off`.

This reads a magnet; it never plays it. To play the torrent itself, that is `/direct-stream <title>`
with the magnet (`direct_stream_play`'s `magnet`).
