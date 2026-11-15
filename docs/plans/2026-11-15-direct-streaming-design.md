# Direct streaming: design brief

**Date:** 2026-11-15
**Status:** brief, not yet analyzed. Input for `/analyze`.
**Session:** Z2-QN (the brainstorm and the spike)
**Spike files:** `docs/plans/direct-streaming-spike/`

## Why

The owner's words:

> i kept thinking, what if we try to reverse-engineer what's inside idlix or lk21, because i am
> sure these streaming sites basically just an aggregator that fetch streaming data from
> somewhere. can we cut through the loops and stream DIRECTLY from our local laptop here.
>
> running "/idlix" honestly doesn't feel perfect yet. i have to watch around 30s of ads in total
> before the movie streaming starts. besides if we can achieve direct streaming (we implement the
> aggregator from our side without relying on these sites), it will be faster, simpler, and much
> much more customizable.

> what if we provide 2 major sources there: 1. the ones that you sync from my local directories
> (my downloaded ones) 2. the ones that you can FOR SURE provide through our new direct streaming
> architecture
>
> maybe we add one more button at the top, to change the page to streaming homepage (i would
> prefer we dont add one more buttons in the sidepanel though, because i think this direct
> streaming and movies are kinda similar in UI/UX). opening this page, mcp-notes will provide me
> with similar grid collections where i can directly click and play the movies / series' episode.
>
> each of the item there is GUARANTEED to be able to be fetched from one of our streaming sources
> (i just don't want mcp-notes recommending something that can't be streamed)

> i just want to click the play button, and see the fullscreen in which the movie starts playing

> english subtitle is very important to me. worst case scenario is that we can get a direct cloud
> source, but this source can't provide subtitle, well, i can accept it, but maybe prioritize the
> cloud source that has subtitle? just english subtitle is enough

> we need to really build this as clean and robust as possible. no need to rush.

The end state the owner described, from Claude Code:

```text
/direct-stream saltburn
this is a LOTR night. let's /direct-stream the first one
/update-cloud-source https://ww6-fmovies.com/
```

## What the spike proved (2026-11-15)

Run against Fight Club (TMDB 550) from the owner's laptop. Scripts are in
`docs/plans/direct-streaming-spike/`.

1. **Aggregator sites are lists of URL templates.** `ww6-fmovies.com` is a Gatsby app; its
   `movie-details` chunk (`fmovies-movie-details-chunk.js`) holds 24 named "servers", every one a
   template with the TMDB id filled in, such as `https://vidfast.pro/movie/${id}?autoPlay=true`.
   Reading them needs no browser.
2. **One network sniffer covers every provider.** `sniff.ps1` opens an embed address in the
   streaming Chrome (port 9333, the `notesd-stream-chrome` profile), attaches to the page and
   every frame and worker under it, and reports manifests, media and subtitle requests with the
   headers they carried. It closes advert tabs the page opens and clicks the middle of the page
   when no stream shows up.

   | Provider | Result | Seconds to the stream | Notes |
   | --- | --- | --- | --- |
   | VidFast | HLS, 480p to 2160p | 2.3 | no click |
   | VidLink | DASH, plus one `.srt` subtitle request | 3.7 | no click; the manifest seen was 480p |
   | VidNest | HLS behind `master.txt` | 2.9 | 3 advert tabs opened and closed |
   | Videasy | nothing in 35 s | | under 10 requests, cause unknown |
   | VidSrc (`vidsrc.cc`) | nothing in 35 s | | under 10 requests, cause unknown |
   | VidKing | nothing in 35 s | | under 10 requests, cause unknown |

3. **The stream host checks `Referer`.** VidFast's manifest answers 403 without
   `Referer: https://vidfast.vc/` and 200 with it. A page cannot set that header, so playback
   needs a local pass-through that adds it and rewrites playlists (`proxy.mjs`).
4. **Our own page plays it.** A bare page with one `<video>` and hls.js, opened in the streaming
   Chrome through `claude/streaming/chrome.mjs` and made full screen, played 3840x2160 with sound:
   first frame 6.8 s after opening the page, no dropped frames, about 30 s buffered ahead.
   About 9 s from asking to a playing film, with no adverts.

Not tested: how long a manifest's token lives (VidFast's appears to carry an expiry about six
hours out), DASH playback, VidNest playback, series episodes, subtitles in our player, the other
18 providers, and why three providers returned nothing.

## Shape

### Providers and the registry

- A provider is a URL template for a film and one for an episode, the id it takes (TMDB or IMDb),
  and what probing has learned about it: resolves or not, manifest kind, best quality, whether it
  offers an English subtitle, median seconds to a stream, last success, last failure.
- The registry is data, not code. Where it lives (a table, a JSON file under `claude/streaming/`,
  or both) is for analysis to decide; health is per host, since it is measured through one
  laptop's Chrome and one network.
- `/update-cloud-source <site>` reads a site's templates (from its scripts where that works, from
  the frames its server buttons load otherwise), adds the new ones and probes each against a few
  known titles.
- A provider that answers with a bot check is skipped and recorded as such. The existing rule
  holds: never a disguised client to get past a check. The sniffer is a real Chrome loading a
  real page.

### Resolving

- Resolve = open the embed in the streaming Chrome, capture the manifest, its headers and its
  subtitle tracks, close the tab. The window stays out of sight and makes no sound.
- Providers are tried in order: **an English subtitle first**, then health, then quality. A
  provider with no English subtitle is used only when none with one resolves. One English track
  is enough; other languages are not a goal.
- A subtitle may arrive as a separate `.srt`/`.vtt` request or as a track inside the manifest;
  the resolver records both. Whether to fetch English subtitles from a subtitle service when no
  provider has one is an open question for analysis.

### Playing

- The player is a page served by the daemon: `<video>`, hls.js (and dash.js if DASH providers
  are kept), English subtitle on by default, quality choice, resume position.
- A daemon route passes stream requests through with the headers the stream host wants, rewrites
  playlists, and accepts only hosts a resolve just returned (it must not be an open proxy).
- The page reports position to the daemon, so a streamed play writes the same play events a VLC
  play does. Watch state stays derived by `state.ts`.
- When a token expires mid-film, the player asks for a new resolve and continues from its
  position.
- A provider that cannot be played outside its own page (blob-only, encrypted segments) is marked
  browser-only: either skipped or played as the bare embed in a clean window. Analysis decides.

### Movies: a second source

- A stream is another source of a title, beside files. Titles are already shared and independent
  of files; a title may have files, verified stream sources, or both. When both exist, the local
  file is the default.
- `/movies` gets one switch at the top, Library and Stream. No new entry in the side panel. The
  Stream side uses the same grid and the same title page (poster, metadata, people, trailer); its
  Play opens the stream player. Series show episodes; the episode is verified when clicked.
- **The Stream grid shows only verified titles:** a provider returned a playable manifest for the
  title, on this host, inside the freshness window. A title that fails at click time is marked
  stale and leaves the grid.
- Candidates come from TMDB lists (trending, popular, by genre) and from what the owner watched.
  A background prober with a budget turns candidates into verified titles and re-checks old ones.

## Decisions

| | Decision | Source |
| --- | --- | --- |
| D1 | Prefer a source with an English subtitle; a source without one is the fallback, not a failure | Owner, 2026-11-15 |
| D2 | Any player is fine; the goal is one click to a full-screen film. The spike's own page in the streaming Chrome is the baseline | Owner, 2026-11-15 |
| D3 | Stream lives inside `/movies` behind a top switch, not a new side-panel entry | Owner, 2026-11-15 |
| D4 | Nothing is shown on the Stream side that has not been verified | Owner, 2026-11-15 |
| D5 | Catalog of about 300 verified titles, re-checked within 7 days, tuned from real probe timings | Owner, 2026-11-15 |
| D6 | The prober opens out-of-sight Chrome tabs on its own, only while the laptop is idle, in the streaming profile. This widens today's rule that a film starts only when asked; resolving is not playing | Owner, 2026-11-15 |
| D7 | Build order: resolver + registry + player + `/direct-stream` first, the Stream page and prober after | Proposed |

## Rules that carry over

- Chrome is driven only through its own profile on Windows, from PowerShell, never the owner's
  everyday Chrome and never a Chrome notesd did not start.
- `MoviesRepo` stays the only writer of `movie_*` tables. Play events are never deleted.
- Verification is per host: the other machine reports its own.
- `NOTESD_MOVIES=off` and `deps.streaming` unset start nothing; tests inject a fake resolver and
  never open Chrome or reach a provider.
- Docs: `docs/guide/streaming.md` and `docs/guide/movies.md` change with the behaviour; movies
  pictures come from the real library.

## Out of scope

Downloading streams to disk, casting, accounts on any provider, anything that defeats a bot check
or DRM, and removing `/idlix` and `/lk21` (they stay until direct streaming has proved itself).
