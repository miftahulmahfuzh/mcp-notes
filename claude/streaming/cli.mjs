#!/usr/bin/env node
// One command for every streaming site: find a title, and with --play start it full screen.
// Usage: cli.mjs <site> [--play] <title> [year] [--episode <n> [--season <n>]]
//        cli.mjs <site> --play-url <url>
//        cli.mjs --sites
// Prints one JSON object. The /idlix and /lk21 skills and the daemon's streaming tools all run this.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseQuery, pickMatches } from './match.mjs';
import { playTitle } from './play.mjs';
import { SITES } from './sites/index.mjs';

const print = (value) => console.log(JSON.stringify(value, null, 2));

export async function main(siteName, argv) {
  const site = SITES[siteName];
  if (!site) {
    print({ ok: false, error: `unknown site "${siteName}"; known: ${Object.keys(SITES).join(', ')}` });
    return 2;
  }
  if (argv[0] === '--play-url') {
    const played = await playTitle(site, argv[1] ?? '');
    print({ ok: played.playing === true, site: site.name, origin: site.origin, url: argv[1] ?? null, play: played });
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
    results = await site.search(query);
  } catch (err) {
    print({ ok: false, site: site.name, origin: site.origin, error: String(err?.message ?? err) });
    return 1;
  }
  const { matches, others } = pickMatches(results, query);
  const out = { ok: true, query, site: site.name, origin: site.origin, matches, others };
  if (episode !== null) {
    // An episode of a series: the site says which of the matching series has it, and in which season.
    const found = await findEpisode(site, matches, { season, episode });
    out.episode = found.episode;
    if (found.error) out.episode_error = found.error;
    if (found.candidates) out.episode_candidates = found.candidates;
    if (wantPlay) out.play = found.episode ? await playTitle(site, found.episode.url) : { playing: false, skipped_play: found.skipped };
    print(out);
    return 0;
  }
  if (wantPlay) {
    // Only an unambiguous film starts on its own; a series has episodes to choose from.
    out.play =
      matches.length === 1 && matches[0].kind === 'movie'
        ? await playTitle(site, matches[0].url)
        : { playing: false, skipped_play: matches.length === 0 ? 'no_match' : matches.length > 1 ? 'several_matches' : 'series' };
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
 * one does: `candidates` lists them, each with its series' title), `no_video` (the site lists the
 * episode without a video).
 */
export async function findEpisode(site, matches, { season, episode }) {
  const series = matches.filter((m) => m.kind === 'series');
  if (series.length === 0) return { episode: null, skipped: 'no_match' };
  if (typeof site.episodes !== 'function') return { episode: null, skipped: 'no_episodes' };
  const candidates = [];
  try {
    for (const match of series) {
      for (const hit of await site.episodes(match.url, { season, episode })) candidates.push({ ...hit, title: match.title });
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
