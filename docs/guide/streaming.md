# Streaming and download sites

Films the library does not have are found on three outside sites, each with its own skill, and a
fourth skill adds a site:

| Site | Skill | What it does | Chat bar |
| --- | --- | --- | --- |
| pahe.ink (downloads) | `/pahe <title> [year]` | Finds the title's page and links each release, BluRay first | Yes, through `WebFetch` |
| idlix (streaming) | `/idlix <title> [year]` | Finds the title, starts the film, shows it full screen | Yes, through `streaming_play` |
| lk21 (streaming) | `/lk21 <title> [year]` | The same | Yes, through `streaming_play` |
| A cloud source, no site (streaming) | `/direct-stream <title> [year]` | Finds the title, resolves a stream, plays it full screen in our own player | Yes, through `direct_stream_play` |
| An aggregator site's providers | `/update-cloud-source <site url>` | Reads the site's provider templates, adds the ones the registry lacks, probes each | No: it writes the provider list both machines share |
| A site not listed here | `/create-streaming-skill <name> <homepage>` | Adds a streaming site as a new skill of the same kind | No: it changes this repository |

Nothing is downloaded and nothing is stored: these are lookups, and for the streaming sites a
browser being driven on your screen.

Contents: [pahe.ink](#paheink) · [The streaming sites](#the-streaming-sites) ·
[What you can ask](#what-you-can-ask) · [How a film is started](#how-a-film-is-started) ·
[The streaming Chrome](#the-streaming-chrome) · [In the chat bar](#in-the-chat-bar) ·
[Adding a site](#adding-a-site) · [Failure answers](#failure-answers) · [Direct streaming](#direct-streaming) ·
[Where the code is](#where-the-code-is) · [Proving a change](#proving-a-change)

## pahe.ink

```text
/pahe no other choice
/pahe ready or not 2019
```

- **In Claude Code** the `/pahe` skill (`claude/skills/pahe`) runs `search.mjs`, which fetches
  `https://pahe.ink/?s=<title>` and reads only the search results, not the page's menus and
  featured posts.
- **In the chat bar** the same request, or "find it on pahe" after a recommendation, reads that
  page with `WebFetch`.

The answer is a link per matching release, BluRay first, then WEB-DL. A result matches when its
name is the asked title, and its year is the asked year when one was given; without a year, a
remake and its original are both shown. The search is fuzzy, so most results are unrelated: with
no exact match the answer shows up to three near misses, or says the site does not have the title
and gives the search link. A link is never built by hand, because the addresses are irregular,
and the lookup stops at the title's page: the download buttons behind it are not followed.

## The streaming sites

Both streaming skills run one command, `claude/streaming/cli.mjs`, with a module per site in
`claude/streaming/sites/`:

| | idlix | lk21 |
| --- | --- | --- |
| Address | `https://z2.idlixku.com` (`IDLIX_ORIGIN`) | `https://tv12.lk21official.cc` (`LK21_ORIGIN`) |
| A plain request | Refused: Cloudflare answers 403 to `curl`, `WebFetch` and a headless browser | Answered |
| Search | The site's own `/api/search`, asked from inside the streaming Chrome | The search host named on the home page (`data-search_url`), asked directly |
| A film's page | `/movie/<slug>` | `/<slug>` |
| A series | `/series/<slug>`: a link, not started | Forwards to another site: a link, not started |
| Before the film | A 7-second countdown, then an advert with "Skip Ad" after about 10 seconds | Nothing |
| The player | In the page itself | In a frame from another host, inside a second one |
| Time to a playing film | About 25 seconds | 6 to 20 seconds |

Both sites move between hosts (`z1`, `z2`; `tv11`, `tv12`). Set the `*_ORIGIN` variable when one
has moved: see [configuration](reference/configuration.md#streaming-sites).

A result matches when its English or original-language name is the asked title, and its year is
the asked year when one was given. A link is never built by hand: it counts only when the site's
search returned it.

## What you can ask

Every line below works in Claude Code. The same words work in the wall's chat bar, except
`/create-streaming-skill` ([Adding a site](#adding-a-site)).

### `/pahe`: a download page

```text
/pahe no other choice
/pahe ready or not 2019
/pahe mobland
find no other choice on pahe
is ready or not on pahe? the 2019 one
get me the pahe link for that film
/pahe the second one
```

| You type | What comes back |
| --- | --- |
| `/pahe no other choice` | Both releases of No Other Choice (2025), BluRay first, then WEB-DL, each a link |
| `/pahe ready or not 2019` | Only the 2019 film, not the 2026 sequel |
| `/pahe that one`, after a recommendation | The film from the conversation, with its year |
| A title pahe does not have | "pahe.ink does not have it under that name", with the search link, or up to three near misses |

### `/idlix` and `/lk21`: find it, play it

```text
/idlix no other choice
/idlix love of your life
/lk21 love of your life
/lk21 ready or not 2019
/idlix la brea
play it on idlix
put that one on lk21
/lk21 the first one
```

| You type | What happens |
| --- | --- |
| `/idlix no other choice` | One film matches: it starts, full screen, in the streaming Chrome (about 25 seconds) |
| `/lk21 love of your life` | The same on lk21 (6 to 20 seconds) |
| `/lk21 ready or not 2019` | The 2019 film starts. The year is what tells a remake from its original when both carry the same name |
| A title two films share, with no year | Several films match: the answer lists them with their years and asks which one |
| `the 2019 one`, after that | That film starts, played by the link from the list |
| `/idlix la brea` | A series: its link, with the number of seasons. Nothing starts |
| `play it on lk21`, after a recommendation | The film from the conversation |

Lookups, which start nothing:

```text
is la brea on idlix?
find no other choice on lk21
where can I stream no other choice?
is love of your life on idlix or lk21? which has the better quality?
which of the films you recommended are on lk21?
```

| You type | What comes back |
| --- | --- |
| `is la brea on idlix?` | The link, "series, 3 seasons" |
| `where can I stream no other choice?` (chat bar) | One line per site, each with its link and quality |
| A title neither site has | It says so, per site, and offers near misses when there are any |

Together with the film library and the web:

```text
recommend comedies like How to Make a Killing, then put the first one I have not seen on idlix
which of those are on pahe?
what did this director make? find the newest one on lk21
```

The rules behind those answers:

- **`/idlix <title>` or `/lk21 <title>` puts the film on** when exactly one film matches.
- **A question is a lookup.** "Is it on idlix?" answers with the link and starts nothing.
- **Several matches start nothing.** The answer lists them; say which one and it is played by
  its link.
- **A series is a link only.** It has episodes to choose, and on lk21 it lives on another site.
- **A recommendation is not a request.** A film is never started because it was suggested.
- **A film in the library plays in VLC** (`movies_continue`), unless you name the site.

### `/direct-stream`: straight from a cloud source

```text
/direct-stream saltburn
/direct-stream dune 2021
this is a LOTR night. let's /direct-stream the first one
/direct-stream the bear season 2 episode 3
/direct-stream M-23T4
can I stream saltburn directly?
```

| You type | What happens |
| --- | --- |
| `/direct-stream saltburn` | One film matches: it is resolved and plays full screen in the streaming Chrome, English subtitle on when a source has one |
| `/direct-stream dune 2021` | The 2021 film. Without the year, Dune matches three titles: the answer lists them and starts nothing |
| `this is a LOTR night. let's /direct-stream the first one` | Claude names the film first (The Lord of the Rings: The Fellowship of the Ring, 2001), then streams it |
| `/direct-stream the bear` | A series: its seasons, and a question about which episode. Nothing starts |
| `/direct-stream the bear season 2 episode 3` | That episode plays |
| A film no source can stream | `no_source`, with what each provider did. Nothing starts |
| `can I stream saltburn directly?` | A lookup: the match, and whether this laptop has a recently verified source |

- **`/direct-stream` streams even a film you have.** Without it, a library film plays in VLC.
- **A question is a lookup**, and **a recommendation is not a request**.
- **It continues where the last stream stopped.**

### `/create-streaming-skill`: another site

```text
/create-streaming-skill "/lk21" the homepage is https://tv12.lk21official.cc/ .
note: we can search directly on the homepage without being redirected to a dedicated search page
search item url https://tv12.lk21official.cc/love-your-life-2026

/create-streaming-skill rebahin https://rebahin.example/ search is a pop-up, like idlix
add another streaming site, same as lk21: https://example.tv/
/lk21 stopped working, look at the site again
```

Give it the skill's name and the homepage. An example film page and a word on how the search
behaves save it a step. What it does is in [Adding a site](#adding-a-site).

## How a film is started

1. The streaming Chrome window comes to the front and opens the film's page.
2. The site's play button is pressed. On idlix the advertising tab that press opens is closed,
   the countdown is waited out and the site's own "Skip Ad" is pressed when the advert offers it.
   On lk21 the press goes to the player inside its frame, and the player's own play is pressed
   again when the first press only set it up.
3. Once the film is running, the window goes full screen and the player is stretched over it.

Things that are not obvious:

- **The film plays in the streaming Chrome, not in your own browser.** A link opens a fresh page,
  and a page that is already playing cannot be handed over through one. That Chrome has no ad
  blocker.
- **Full screen is the F11 kind.** A page's own full-screen button is refused for a click that
  does not come from the keyboard or mouse, so the whole window goes full screen and a style
  stretches the player over it. F11 leaves it; Esc removes the style and shows the page.
- **A hidden page stops a countdown.** Chrome is started with
  `--disable-features=CalculateNativeWinOcclusion`, so a window covered by another still counts
  as visible, and the window is brought to the front. Minimizing it during the wait stops the
  flow; the answer says at which stage, and asking again starts over.
- **One film at a time.** Starting a film closes the tabs of the other site.

## The streaming Chrome

`claude/streaming/cdp.ps1` is the Windows half. WSL cannot reach Windows loopback, so the part
that talks to Chrome runs in Windows PowerShell, as with VLC.

- It uses a Chrome with its own profile folder, `%LOCALAPPDATA%\notesd-stream-chrome`, and
  DevTools port 9333. Chrome refuses a debugging port on the default profile, so your everyday
  Chrome, its tabs and its logins are never touched.
- When that Chrome is not running it is started minimized, and it stays open afterwards: about
  4 seconds cold, under a second warm.
- One call evaluates one JavaScript expression, in the site's tab or in an embedded frame whose
  address matches a pattern, and prints the reply. Options bring the window to the front, make
  it full screen, and close the tabs that are not on the site.
- It never touches a Chrome it did not start, and never closes one.

## In the chat bar

The chat bar has no shell, so the daemon runs the same command for it through two MCP tools
(also available to Claude Code):

- `streaming_find` asks one site or all of them for a title and returns the links.
- `streaming_play` starts a film: by site and title, or by the link of a result.

"/idlix no other choice" or "put it on lk21" in the chat bar calls `streaming_play`; "where can
I watch it?" calls `streaming_find`. The bar never starts a film it was not asked to start. The
tools work on the machine with Windows Chrome; on the other one `streaming_play` answers with
the error and the bar gives the link. `NOTESD_STREAMING=off` turns both tools off.

## Adding a site

`/create-streaming-skill <name> <homepage> [what you know]` adds a streaming site end to end:
the skill, the site module, the chat bar's side, tests and this guide. Claude Code only, from any
repository; it works in `~/mcp-notes`. The sample commands are under
[What you can ask](#create-streaming-skill-another-site).

What the skill (`claude/skills/create-streaming-skill`) makes Claude do, in order:

1. **Ask the site with a plain request.** A real page back means lookups need no browser
   (lk21). A Cloudflare 403 means everything goes through the streaming Chrome (idlix).
2. **Find the search request** the site's search box makes, and read real answers: the fields
   for title, year, kind and slug, and how a page's address is built from the slug.
3. **Find the player:** in the page or in a frame from another host, what starts it, what the
   site shows before the film, and when the film is really running.
4. **Write the site module**, `claude/streaming/sites/<name>.mjs`: `search`, `titlePath`,
   `start` and `playerSelector`. Add it to `sites/index.mjs` and to `STREAMING_SITES`
   (`src/streaming/service.ts`).
5. **Add the skill folder:** a `SKILL.md` copied from lk21's and a three-line `search.mjs`.
6. **Name the site** in the chat prompt and the MCP instructions, so the chat bar knows it.
7. **Tests and docs**, then prove it live: a lookup, a series, no result, and two plays in a
   row, from the terminal and through the daemon.

It tells you before the first play test, because a Chrome window takes over the screen and plays
with sound. It also carries what went wrong on the first two sites: an advertising tab that
froze a countdown, a first press that only set a player up, a full-screen button that refuses
automated clicks, and a daemon that could not find PowerShell.

It will not disguise a client to get past a bot check, skip an advert the site does not let a
person skip, or dig out a video file. A site that needs any of those is not added.

## Failure answers

| Answer | Meaning |
| --- | --- |
| `streaming_off` | `NOTESD_STREAMING=off`, or the daemon was started without the tools |
| `no_chrome` | Chrome is not installed on the Windows side |
| `chrome_not_reachable`, `no_tab` | Chrome did not start, or the site's page did not load in time |
| `the site answered HTTP 403` | Cloudflare is now refusing the real Chrome too |
| `no_frame` | lk21's player frame did not appear: the player changed, or the page is not a film |
| `the page has no play button` | idlix's page changed, or it is a series page |
| `playing: false` with `stage` | Where the flow stopped: `countdown`, `advert`, `play_button`, `loading`, `film` (the player is there and did not start) |
| A host that does not resolve | The site moved: set its `*_ORIGIN` |

A failure never falls back to a guessed link.

## Direct streaming

Direct streaming plays a film straight from the stream host a provider uses, in a page notesd
serves, with no site, countdown or advert in between. A provider is an embed address keyed by the
TMDB id, such as `https://vidfast.pro/movie/{id}`. Resolving opens that address out of sight in
the streaming Chrome, notes the manifest it asks for and the headers it sent, and closes the tab;
playing hands the manifest to notesd's player page through the daemon. It needs `NOTESD_MOVIES`
on, and `NOTESD_DIRECT_STREAM=off` turns it off: every `/api/stream/*` route then answers
`direct_stream_off` and no Chrome tab is opened for it.

### The resolver

`claude/streaming/direct/cli.mjs resolve <movie|tv> <tmdb id> [season episode]` opens each
provider's embed in a background tab of the streaming Chrome, muted, and keeps the first one that
loads a stream: the manifest, the `Referer`, `Origin` and `User-Agent` its request carried, and the
subtitle tracks seen (separate `.vtt`/`.srt` requests and tracks inside the manifest). Providers are
tried with an English subtitle first, then by health on this host, then by quality (`order.mjs`). A
provider whose page shows a bot check is recorded as `bot_check` and the next one is tried; nothing
is clicked or disguised to get past it. Providers are data, `providers.seed.json`, 24 templates read
from fmovies. `--deadline-s <n>` stops trying providers once `n` seconds have passed (the answer is
`deadline`, which says nothing about the title). `cli.mjs open <url> --fullscreen` puts a daemon page
full screen in the streaming Chrome and starts the player with sound, as a click would.

### Providers and their health

- The providers are data. `claude/streaming/direct/providers.seed.json` is checked in; the daemon
  loads it into the `stream_providers` table at every start, and both machines share that table.
  An entry changed in the file updates its row. A provider added from a site keeps the site's
  address in `origin_site` and is never rewritten by the seed. Nothing deletes a provider.
- Health is per machine, in `stream_provider_health`: for each provider the last outcome
  (`resolved`, `no_stream`, `bot_check`, `error`), counts, failures in a row, the last success and
  failure, the last ten times to a stream, the manifest kind, the best quality and whether an
  English subtitle was seen. It is written after every resolve, and the resolver reads it to
  choose its order.
- A provider skipped because it only plays in its own page (`browser_only`), or because it has no
  episode address, is not a failure: its health is left alone.

### Sessions and the pass-through

A resolve makes a session, kept in the daemon's memory: a 32-character random id, the source, and
the hosts it may reach. It ends 4 hours after its last request or 24 hours after it began, and a
restart ends every session. The player page reads it from `GET /api/stream/sessions/<id>`.

Stream hosts check `Referer`, which a page cannot set, so every request the player makes goes
through `/api/stream/sessions/<id>/p?u=<address>`:

- **Only the session's hosts.** The hosts the resolve returned (the manifest's and the
  subtitles'), plus a host named inside a playlist or manifest fetched through the same session,
  or by a redirect one of them answered. Anything else is refused with 403 `forbidden_host` before
  any request is made, and an unknown or ended session gets 403 `unknown_session`. It is not an
  open proxy.
- **Only the captured headers.** `Referer`, `Origin` and `User-Agent` as the real Chrome sent them,
  plus the player's `Range`. No cookie and nothing invented; Node's fetch adds only its usual
  transport headers (`accept`, `accept-encoding`).
- **Every address comes back through it.** HLS playlists (address lines and `URI="..."`
  attributes) and DASH manifests (`BaseURL`, `Location`, segment templates, `SegmentURL`,
  `Initialization`) are rewritten; a template's `$Number$`-style fields are left for the player to
  fill in. Media streams through as it arrives, with the host's status, which is also in the
  `X-Notesd-Upstream` header, so the player can tell an expired token from a refused session.
- **Subtitles.** An `.srt` track is turned into WebVTT on the way, since a page shows only WebVTT.
- When a token expires mid-film, `POST /api/stream/sessions/<id>/refresh` resolves again and keeps
  the same session and page.

### Direct streaming answers

| Answer | Meaning |
| --- | --- |
| `direct_stream_off` | `NOTESD_DIRECT_STREAM=off`, `NOTESD_MOVIES=off`, or the daemon was started without it. Nothing is resolved and Chrome is not started |
| `no_source` | No provider resolved the title; `attempts` lists each provider's outcome |
| `resolve_failed` | The resolve could not run: `reason` is `no_chrome`, `chrome_not_reachable`, `script_failed`, or what the resolver said |
| `open_failed` | The title resolved, but the player page could not be opened in the streaming Chrome |
| `unknown_session` | The session id is wrong, the session ended, or the daemon restarted since |
| `forbidden_host` | The address is not on a host the session may reach |
| `upstream_error` | The stream host did not answer, or redirected too often |

### The player

`/stream/<session id>` is the page a direct-stream play opens in the streaming Chrome. It is a
separate small bundle (`web/stream.html`, `web/src/stream/`), not part of the wall. The resolver's
`open --fullscreen` makes the window full screen; the page fills the window.

- **It plays what the session names.** The page reads `GET /api/stream/sessions/<id>` and plays its
  manifest through the pass-through: HLS with hls.js, DASH with dash.js, a plain file in the
  browser itself. Both libraries are npm packages built into the page, each fetched only when the
  manifest needs it. Nothing comes from a CDN.
- **English subtitles are on by default.** An English track inside the manifest comes first, then
  a separate English `.vtt` or `.srt` from the resolve (an `.srt` is converted to WebVTT in the
  page). A subtitle file whose first answer fails is asked for once more before the track is left
  out. With no English track, subtitles start off and the others can still be picked.
- **Quality** is Auto at first; the menu lists every rendition the manifest offers, highest first.
- **Position.** The film starts at the session's `resume_s`. The page reports
  `{ position_s, duration_s, ended }` to `POST /api/stream/sessions/<id>/position` every 5 seconds
  while playing, on pause and at the end; it ignores the answer, a 404 included.
- **An expired token.** When the stream host answers 401, 403 or 410 through the pass-through (the
  answer carries `X-Notesd-Upstream`), the page calls `POST /api/stream/sessions/<id>/refresh`,
  reads the session again and carries on from where it was. It does this at most three times for
  one page, and stops with a message when a refreshed stream is refused before it plays. A 403
  without that header is notesd's own (the session ended, or the daemon restarted): the page says
  the session has ended and does not refresh.
- **Sound.** A play from `/direct-stream` or the movies page opens the page full screen and then
  calls its `start()` the way a click would, so the film starts with sound. If the browser still
  will not start it with sound, the page starts it muted and the speaker icon shows it.
- **`?muted=1`** (the playback checks): muted from the start, never unmuted, never full screen.
- **Controls** are icons only and hide after 2.5 seconds without the mouse: play, back and forward
  10 seconds, position, mute, subtitles, quality, full screen. Keys: Space or K, the left and right
  arrows, M, C (subtitles on or off), F.

The page keeps its state on `window.notesdStream` (stage, `kind`, `levels`, `level`, subtitle
choice, `refreshes`, `errors`, the last position sent and a short log), for scripts that check a
play, and its `start()`.

### `/direct-stream`

`/direct-stream <title>` in Claude Code (the `claude/skills/direct-stream` skill) and the same
words in the chat bar end in the same two MCP tools:

- `direct_stream_find` looks the title up and says, per match, whether this laptop has a source
  verified inside the freshness window. It resolves nothing and opens nothing.
- `direct_stream_play` looks the title up, then hands one film or one episode to the daemon's
  stream service: resolve, then the player page full screen in the streaming Chrome, from the
  last stream position.

**Finding the title.** The lookup (`src/directStream/lookup.ts`) reads titles already stored
first (the library, and titles streamed before), then TMDB's film and series search. A movie id
(`M-23T4`, of a title or one episode) or a title key (`movie-550`) is taken as is. Words match a
title in one of three ways, tried in this order:

1. **Its name.** Its English or original name is the asked title, and its year is the asked year
   when one was given: the rule of `claude/streaming/match.mjs`, ported, and a test keeps the two
   equal.
2. **A name you gave it.** A stored title keeps the other names you have used for it
   (`movie_titles.aliases`, normalized), and they match like its own name.
3. **A TMDB alternative title.** When no name matches, the alternative titles of the search's
   first 5 hits are read (one request each), and a hit matches when one of them is the asked
   title. This is how "Doctor X" finds "Doctor X: Mafia in White".

A site and TMDB sometimes disagree on a name: lk21 lists "Doctor X: Age of the White Mafia", TMDB
only "Doctor X: Mafia in White". Then nothing matches, and the answer is `no_match` with
`did_you_mean`: the search's other hits, or, when the search found nothing at all, the hits for a
shorter form of the name (the part before its subtitle, else its first two words). A near miss is
never played unasked. When you pick one, Claude plays it by its `title_key` and passes the name
you first used as `asked_as`; it is stored as an alias, so the same words find the title directly
from then on, on both machines.

**A series without an episode** carries on from what you watched (`src/directStream/episodePick.ts`).
The episode states are the ones the Movies page shows, from every play in `movie_plays` (streams
and VLC), so the progress survives sessions and restarts:

| What was played | What starts | `picked` |
| --- | --- | --- |
| Nothing | Season 1, episode 1 | `first` |
| The episode played last is unfinished | That episode, from the position it stopped at | `resume` |
| The episode played last is finished | The first unfinished episode after it, into the next season | `next` |

Specials (season 0) are never picked. When the stored episode list has nothing left, TMDB's
current list is read first, since a series still airing has newer episodes than the stored ones.
A named season and episode always wins over the pick.

Nothing starts when several titles match (the candidates come back with their years), when no
title matches (`no_match`), when no episode is left after the last one played (`caught_up`), when
the next episode airs after today (`not_aired`, with its air date), or when no provider resolves:
then the answer is `no_source` with each provider's outcome (`no_stream`, `bot_check`, `error`,
`skipped_browser_only`). With direct streaming off, both tools answer `direct_stream_off`.

### `/update-cloud-source`: providers from another site

```text
/update-cloud-source https://ww6-fmovies.com/
which stream providers do we have?
```

Aggregator sites are lists of provider templates. `/update-cloud-source` reads one site's list,
adds the providers the registry lacks and tries each new one on the known titles (Fight Club and
the others in `claude/streaming/direct/known-titles.json`). It runs in Claude Code only; the chat
bar can list the providers (`direct_stream_sources`) but not add one, because adding writes the
provider list both machines share and probes for minutes.

1. **Read the templates, no browser.** `cli.mjs templates <site>` fetches the page as a plain
   client that says what it is, then the scripts the page names and the webpack (Gatsby) chunks
   they load, on the site's own host only, likely chunks (`movie`, `details`, `player`, ...)
   first. It stops at 40 scripts, 4 MB a script, 30 MB in all and 90 seconds. A template is an
   object entry whose value builds an `https` address around one id (a film) or three (an
   episode: id, season, episode), keyed by the provider's name. ww6-fmovies.com gave all 24 of
   its servers, each with a film and an episode template.
2. **Keep the new ones.** A provider is already known when the registry has a template with the
   same host (without `www.`), path and id parameter; `?autoPlay=true` and colours do not count.
   A new provider whose name is taken by another host is stored as `VidSrc (vidsrc.xyz)`.
   Existing rows are never changed, and nothing is written when the read failed.
3. **Probe each new one.** Each known film is resolved with only that provider
   (`resolve --only`), in the streaming Chrome out of sight; the episode only when the provider
   has an episode template and resolved a film. Health is recorded for this machine, so the
   resolver orders the new provider like the others. A probe never marks a title stale.
4. **Report** per provider: resolves or not, and per title the outcome, seconds, manifest kind,
   best height and English subtitle.

| Answer | Meaning |
| --- | --- |
| `ok: true`, `added: []` | The registry already has every provider the site uses |
| `bot_check` | The site answers a plain request with a bot check. It is not got past |
| `no_templates` | The page and the scripts read hold no provider template |
| `unreachable` | The address does not answer, or answers an error |
| `busy` | Another update is still probing |
| `direct_stream_off` | Direct streaming is off, or the daemon runs without it |

**Not built:** reading the frames a site's server buttons load through the streaming Chrome. It
needs, per site, a film page with a known TMDB id, the selector of its server buttons and real
clicks on a page full of adverts; a site that needs it answers `no_templates` or `bot_check`.

**The seed and the table.** New providers go to the `stream_providers` table, which both
machines share, with the site they came from (`origin_site`) and when (`added_at`);
`providers.seed.json` is not changed. The other laptop sees them on its next resolve and
measures its own health. The daemon loads the seed at every start: it adds seed providers the
table lacks and updates seed rows (`origin_site` empty) whose entry changed in the file, but never
touches a provider a site added and never deletes one. To make a site's provider part of the
seed, copy its entry into `providers.seed.json` by hand.

| Path | What |
| --- | --- |
| `claude/streaming/direct/templates.mjs` | The template reader (`cli.mjs templates`) |
| `src/directStream/updateSource.ts` | What is new, the probes, the report |
| `src/mcp/directStreamTools.ts` | `direct_stream_sources`, `direct_stream_update_source` |
| `claude/skills/update-cloud-source/` | The skill |

### The prober

The Stream side of `/movies` shows only titles verified on this machine within the freshness
window. The prober fills it and keeps it fresh without being asked. It is **off** unless
`NOTESD_STREAM_PROBER=on`, because it widens the rule that a film starts only when asked: it opens
embed pages in the streaming Chrome by itself. Resolving is not playing. Each probe is the same
resolve `/direct-stream` runs: a tab out of sight, closed when the stream address is caught. No
window comes to the front, nothing makes a sound, nothing is played, and no play is recorded.

When it may probe: only while Windows has had no keyboard or mouse input for
`NOTESD_STREAM_IDLE_SECONDS` (one `powershell.exe` call to `GetLastInputInfo`, made again before
every probe), and only while nothing plays (no VLC that notesd follows, no open play the player page
reported in the last 15 minutes). The moment either changes, the pass stops after the probe in
flight. An idle time that cannot be read counts as "not idle". Outside WSL, or without
`powershell.exe`, the prober stays off and `GET /api/stream/prober` says why.

What it probes, each pass (one every `NOTESD_STREAM_PROBE_MS`):

1. Once a day, the candidate list is rebuilt from TMDB: TMDB's recommendations for up to 20 titles
   you finished (rated 4 or 5 first, then unrated ones; a finished title you rated 3 or lower is
   left out), discover lists for the three genres those titles share most, and this week's
   trending and popular titles. Unreleased titles are dropped. This step only talks to TMDB, so it
   runs whether or not the laptop is idle.
2. Re-checks: verified sources at least 70% through the freshness window, the oldest first, so a
   title is checked again before it would leave the grid.
3. New candidates, until `NOTESD_STREAM_CATALOG_SIZE` titles are fresh. Films lead, with a series
   in every fourth slot; a series is verified by its first episode. A title already fresh is
   never probed again. A title that fails waits 1 day, then 2, 4 and so on up to 30 days.

A pass stops at `NOTESD_STREAM_PROBE_BUDGET` probes or half of `NOTESD_STREAM_PROBE_MS`, whichever
comes first. The budget's default follows from the resolve campaign's timings
(`docs/plans/2026-11-15-direct-streaming-findings.md`): a title costs the median failing providers
tried before the one that works, at the median seconds of a failure, plus the median seconds of a
resolve. Each resolve is given the seconds left in the pass, so one title that no provider carries
cannot overrun it; a resolve cut short, or one that cannot reach Chrome, ends the pass without
blaming the title.

Every verified or stale mark is the one a play would write (see [movies.md](movies.md)); the
prober's own state is `stream_probe_titles`: per host, the listing, each title's last outcome and
its backoff. Each pass logs one line (`[notesd] stream prober: pass ...`); a pass that did nothing
logs only when its reason changed. `GET /api/stream/prober` shows the settings, the catalog count
and the last pass.

## Where the code is

| Path | What |
| --- | --- |
| `claude/streaming/cli.mjs` | The one command: find, `--play`, `--play-url` |
| `claude/streaming/sites/*.mjs`, `sites/index.mjs` | One module per site, and the list of them |
| `claude/streaming/match.mjs`, `play.mjs`, `chrome.mjs` | Title matching; the shared play flow and the fill-screen style; running `cdp.ps1` |
| `claude/streaming/cdp.ps1` | The Windows half: Chrome, tabs, frames, one expression |
| `claude/skills/pahe/`, `idlix/`, `lk21/` | The skills; `pahe/search.mjs` also holds the title parsing the others share |
| `claude/skills/create-streaming-skill/` | How to add a site |
| `src/streaming/service.ts` | `scriptRunner`: the daemon's way to run `cli.mjs` |
| `claude/streaming/direct/` | The resolver: `cli.mjs`, the sniffer, the provider order, `providers.seed.json` |
| `src/directStream/` | The registry (`repo.ts`), resolves and sessions (`service.ts`, `sessions.ts`), the pass-through and its rewriting (`passThrough.ts`, `rewrite.ts`), running the resolver (`runner.ts`) |
| `src/http/directStreamApi.ts` | The `/api/stream/*` routes |
| `src/directStream/lookup.ts`, `match.ts` | Words, a movie id or a title key to a TMDB title; the exact-title rule |
| `src/mcp/directStreamTools.ts` | `direct_stream_find`, `direct_stream_play` |
| `claude/skills/direct-stream/` | The `/direct-stream` skill |
| `src/mcp/streamingTools.ts` | `streaming_find`, `streaming_play` |
| `src/chat/prompt.ts` | When the chat bar looks and when it plays |

## Proving a change

The feature map entry is `.claude/skills/verify-notesd/features/streaming.md`.

- Matching, result building and the tools are unit-tested with no network:
  `npx vitest run tests/unit/scripts tests/unit/streaming.test.ts tests/unit/mcp.streamingTools.test.ts`.
- A lookup on the live site is free: `node claude/streaming/cli.mjs lk21 ready or not 2019`.
  The idlix one opens the streaming Chrome, minimized.
- Playing is proven only live, and it takes over the screen and starts a film with sound:
  `node claude/streaming/cli.mjs lk21 --play <film>`. Run it when the owner expects it. A
  throwaway daemon never has the streaming tools (`deps.streaming` is unset), so they answer
  `streaming_off` there.
- Direct streaming: the feature map entry is `.claude/skills/verify-notesd/features/direct-streaming.md`.
  `verify.sh up --direct-stream` drives it against a fake resolver and a fixture stream host, never
  a provider or Chrome; every other throwaway run has it off.
