#!/usr/bin/env node
// One command for every streaming site: find a title, and with --play start it full screen.
// Usage: cli.mjs <site> [--play] <title> [year] [--episode <n> [--season <n>]]
//        cli.mjs <site> --play-url <url>
//        cli.mjs <site> --play-from <title url> --episode <n> [--season <n>]
//        cli.mjs <site> --details <title url>
//        cli.mjs --sites
// Prints one JSON object. The site skills (/idlix, /lk21, ...) and the daemon's streaming tools all
// run this. A play that started is reported to the daemon, which keeps it with the title (`kept`
// in the answer); --no-report leaves that to the caller.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseQuery, pickMatches } from './match.mjs';
import { playTitle } from './play.mjs';
import { recall, remember } from './seen.mjs';
import { turnWarpOn } from './warp.mjs';
import { SITES } from './sites/index.mjs';

const print = (value) => console.log(JSON.stringify(value, null, 2));

const REPORT_TIMEOUT_MS = 20_000;
const WARP_NOTE = 'connected: the site did not answer on this network, so Cloudflare WARP was turned on and it was asked again. WARP stays on.';

/**
 * A site this network does not reach (the provider blocks it, its page never loads) is asked once
 * more through Cloudflare WARP, when WARP is installed and was off (warp.mjs). `note.warp` then
 * says so in the answer.
 */
async function searchSite(site, query, note) {
  try {
    return await site.search(query);
  } catch (err) {
    if (!(await turnWarpOn())) throw err;
    note.warp = WARP_NOTE;
    return site.search(query);
  }
}

/** playTitle, and once more through WARP when the page could not be opened at all (an `error`; a `stage` is the player's own stop). */
async function playOn(site, url, note) {
  const played = await playTitle(site, url);
  if (played.playing || played.error === undefined || !(await turnWarpOn())) return played;
  note.warp = WARP_NOTE;
  return playTitle(site, url);
}

/** What the daemon is told of a play that started: the site, the title's page there, and what the search said of it. */
export function playReport(siteName, match, episode = null) {
  return {
    site: siteName,
    url: match.url,
    name: match.name ?? null,
    original_name: match.original_name ?? null,
    year: match.year ?? null,
    kind: match.kind ?? null,
    season: episode ? episode.season : null,
    episode: episode ? episode.episode : null,
  };
}

/**
 * Tells the daemon (127.0.0.1, NOTESD_PORT or 7317) that a site's player started, so the title's
 * page and the Stream side know it. Answers what the daemon kept, or null when it could not be
 * told: a play is never held up or failed by this.
 */
export async function reportPlay(report, fetchImpl = fetch) {
  const port = /^\d{1,5}$/.test(process.env.NOTESD_PORT ?? '') ? process.env.NOTESD_PORT : '7317';
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/api/movies/site-play`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-notes-site-play': '1' },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
    const body = await res.json();
    return body && typeof body === 'object' && typeof body.recorded === 'boolean' ? body : null;
  } catch {
    return null;
  }
}

export async function main(siteName, allArgv) {
  const site = SITES[siteName];
  if (!site) {
    print({ ok: false, error: `unknown site "${siteName}"; known: ${Object.keys(SITES).join(', ')}` });
    return 2;
  }
  const note = {};
  const report = !allArgv.includes('--no-report');
  const argv = allArgv.filter((word) => word !== '--no-report');
  if (argv[0] === '--details') {
    // What the title's own page says of it, for a title TMDB does not list. A site without it answers null.
    try {
      print({ ok: true, site: site.name, url: argv[1] ?? null, details: typeof site.details === 'function' ? await site.details(argv[1] ?? '') : null });
      return 0;
    } catch (err) {
      print({ ok: false, site: site.name, url: argv[1] ?? null, error: String(err?.message ?? err) });
      return 1;
    }
  }
  if (argv[0] === '--play-url') {
    const played = await playOn(site, argv[1] ?? '', note);
    const out = { ok: played.playing === true, site: site.name, origin: site.origin, url: argv[1] ?? null, play: played, ...note };
    // The address came from a search run before: what that search said of it names the title.
    if (played.playing && report) out.kept = await reportPlay(recall(argv[1]) ?? { site: site.name, url: argv[1] });
    print(out);
    return played.playing ? 0 : 1;
  }
  if (argv[0] === '--play-from') {
    // An episode of a title whose page is already known (it was played from this site before).
    const { words, season, episode, bad } = readEpisodeFlags(argv.slice(1));
    if (words.length !== 1 || episode === null || bad !== null) {
      print({ ok: false, error: bad ?? 'usage: --play-from <title url> --episode <n> [--season <n>]' });
      return 2;
    }
    const found = await findEpisode(site, [{ kind: 'series', url: words[0], title: null }], { season, episode });
    const played = found.episode ? await playOn(site, found.episode.url, note) : { playing: false, skipped_play: found.skipped };
    const out = { ok: played.playing === true, site: site.name, origin: site.origin, url: words[0], episode: found.episode, play: played, ...note };
    if (found.error) out.episode_error = found.error;
    if (played.playing && report) out.kept = await reportPlay({ site: site.name, url: words[0], season: found.episode.season, episode: found.episode.episode });
    print(out);
    return played.playing ? 0 : 1;
  }
  const wantPlay = argv[0] === '--play';
  const { words, season, episode, bad } = readEpisodeFlags(wantPlay ? argv.slice(1) : argv);
  const query = parseQuery(words);
  if (query.name === '' || bad !== null) {
    print({ ok: false, error: bad ?? 'usage: [--play] <title> [year] [--episode <n> [--season <n>]] | --play-url <url>' });
    return 2;
  }
  let results;
  try {
    results = await searchSite(site, query, note);
  } catch (err) {
    print({ ok: false, site: site.name, origin: site.origin, error: String(err?.message ?? err) });
    return 1;
  }
  const { matches, others } = pickMatches(results, query);
  // A film's address is the page that plays: a later --play-url of it is reported by this.
  remember(results.filter((r) => r.kind === 'movie').map((r) => ({ url: r.url, report: playReport(site.name, r) })));
  const out = { ok: true, query, site: site.name, origin: site.origin, matches, others, ...note };
  if (episode !== null) {
    // An episode of a series: the site says which of the matching series has it, and in which season.
    const found = await findEpisode(site, matches, { season, episode });
    out.episode = found.episode;
    const seriesOf = (hit) => matches.find((m) => m.url === hit.series_url);
    remember([...(found.candidates ?? []), ...(found.episode ? [found.episode] : [])].filter(seriesOf).map((hit) => ({ url: hit.url, report: playReport(site.name, seriesOf(hit), hit) })));
    if (found.error) out.episode_error = found.error;
    if (found.candidates) out.episode_candidates = found.candidates;
    if (wantPlay) out.play = found.episode ? await playOn(site, found.episode.url, note) : { playing: false, skipped_play: found.skipped };
    Object.assign(out, note);
    const series = found.episode ? matches.find((m) => m.url === found.episode.series_url) : undefined;
    if (out.play?.playing && report && series) out.kept = await reportPlay(playReport(site.name, series, found.episode));
    print(out);
    return 0;
  }
  if (wantPlay) {
    // Only an unambiguous film starts on its own; a series has episodes to choose from.
    out.play =
      matches.length === 1 && matches[0].kind === 'movie'
        ? await playOn(site, matches[0].url, note)
        : { playing: false, skipped_play: matches.length === 0 ? 'no_match' : matches.length > 1 ? 'several_matches' : 'series' };
    if (out.play.playing && report) out.kept = await reportPlay(playReport(site.name, matches[0]));
    Object.assign(out, note);
  }
  print(out);
  return 0;
}

/** Takes `--season <n>` and `--episode <n>` out of the words; `bad` names a flag without a whole number. */
export function readEpisodeFlags(argv) {
  const words = [];
  const got = { season: null, episode: null };
  let bad = null;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] === '--season' ? 'season' : argv[i] === '--episode' ? 'episode' : null;
    if (flag === null) {
      words.push(argv[i]);
      continue;
    }
    const value = argv[++i] ?? '';
    if (!/^\d{1,5}$/.test(value)) bad = `--${flag} takes a whole number`;
    else got[flag] = Number(value);
  }
  if (bad === null && got.season !== null && got.episode === null) bad = '--season needs --episode';
  return { words, ...got, bad };
}

/**
 * The one episode the request names, among the series that matched the title. `skipped` says why
 * there is none: `no_match` (no series of that name), `no_episodes` (the site's series are only
 * links here), `no_episode` (no matching series has that episode), `several_episodes` (more than
 * one does: `candidates` lists them, each with its series' title and page), `no_video` (the site
 * lists the episode without a video).
 */
export async function findEpisode(site, matches, { season, episode }) {
  const series = matches.filter((m) => m.kind === 'series');
  if (series.length === 0) return { episode: null, skipped: 'no_match' };
  if (typeof site.episodes !== 'function') return { episode: null, skipped: 'no_episodes' };
  const candidates = [];
  try {
    for (const match of series) {
      for (const hit of await site.episodes(match.url, { season, episode })) candidates.push({ ...hit, title: match.title, series_url: match.url });
    }
  } catch (err) {
    return { episode: null, skipped: 'episode_lookup_failed', error: String(err?.message ?? err) };
  }
  if (candidates.length === 0) return { episode: null, skipped: 'no_episode' };
  if (candidates.length > 1) return { episode: null, skipped: 'several_episodes', candidates };
  if (!candidates[0].has_video) return { episode: null, skipped: 'no_video', candidates };
  return { episode: candidates[0] };
}

// Reached through a symlink from ~/.claude/skills, so compare real paths.
function isMain() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const [first, ...rest] = process.argv.slice(2);
  if (first === '--sites') {
    print(Object.values(SITES).map((site) => ({ name: site.name, label: site.label, origin: site.origin })));
  } else {
    process.exitCode = await main(first ?? '', rest);
  }
}
