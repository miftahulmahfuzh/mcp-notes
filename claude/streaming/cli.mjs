#!/usr/bin/env node
// One command for every streaming site: find a title, and with --play start it full screen.
// Usage: cli.mjs <site> [--play] <title> [year]
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
  const query = parseQuery(wantPlay ? argv.slice(1) : argv);
  if (query.name === '') {
    print({ ok: false, error: 'usage: [--play] <title> [year] | --play-url <url>' });
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
