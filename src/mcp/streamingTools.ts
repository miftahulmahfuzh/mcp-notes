import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { STREAMING_TOOL_NAMES } from '../chat/status.js';
import { STREAMING_SITES, type StreamingRunner, type StreamingSite } from '../streaming/service.js';
import { run, type ToolDeps } from './tools.js';

const [FIND, PLAY] = STREAMING_TOOL_NAMES;

export const STREAMING_OFF =
  'streaming_off: the streaming tools are not running on this server (NOTESD_STREAMING=off, or the daemon was started without them).';

/** Unrelated results kept per site: a site's search is fuzzy and most of them are noise. */
export const STREAMING_OTHERS_LIMIT = 5;

const SITE_LIST = STREAMING_SITES.join(', ');

const FIND_DESCRIPTION =
  `Find a film or series on the owner's streaming sites (${SITE_LIST}) and return the link to its page on each. ` +
  'Pass the title, and the release year when you know it. Omit site to ask every site at once. ' +
  'Each site answers with matches (the results whose English or original name is the asked title, and whose year is the asked year when one was given; ' +
  'each has title, kind movie or series, year, quality or seasons, and url) and others (a few other results, mostly unrelated: use them only to offer a near miss, and say it is not exact). ' +
  'For one episode of a series pass episode, and season when the owner named one: a site that plays episodes (idlix) then answers episode { season, episode, name, url, title } when exactly one matching series has it, ' +
  'since a long anime numbers its episodes through the seasons (One Piece 787 is in season 18) and the site says where; otherwise episode is null and episode_candidates lists the ones that fit. ' +
  'A site that could not be asked answers ok: false with an error; say which site and do not guess a link. ' +
  'Never build a link yourself: a link counts only when this tool returned it. This tool only looks; nothing opens on screen.';

const PLAY_DESCRIPTION =
  `Start a film on one of the owner's streaming sites (${SITE_LIST}), full screen, on the owner's screen. ` +
  'A Chrome window kept for this comes to the front on the Windows side, opens the film, presses play, waits through what the site shows before the film ' +
  '(a countdown, an advert it skips with the site\'s own Skip button), and fills the screen with the player. It takes 10 to 40 seconds. ' +
  'Call it only when the owner asks to watch, play or put on something on one of these sites; finding a link is streaming_find. ' +
  'Pass site and title (with year when known): the film starts only when exactly one film matches. ' +
  'play.skipped_play says why nothing started: several_matches (show the matches and ask which, then call again with that match\'s url), ' +
  'series (a series has episodes to choose: give the link, or call again with episode), or no_match. To start a result you already have, pass its url and no title. ' +
  'One episode of a series ("/idlix one piece 787", "play La Brea season 2 episode 3 on idlix") is title with episode, and season only when the owner named one: the episode starts when exactly one matching series has it, and episode says which season it is in. ' +
  'Then skipped_play can also be no_episode (no matching series has that episode), several_episodes (list episode_candidates with their series and season and ask which, then call again with that one\'s url), ' +
  'no_video (the site lists the episode without a video) or no_episodes (this site does not play episodes: lk21, flicksy). ' +
  'play.playing true means the film is on screen; with false, stage or error says where it stopped (a hidden or minimized window stops a countdown; calling again starts over). ' +
  'Tell the owner it plays in the streaming Chrome window and that F11 leaves full screen. Works only on the machine with Windows Chrome.';

const siteField = z.enum(STREAMING_SITES);
const titleField = z.string().trim().min(1).max(200);
const yearField = z.number().int().min(1880).max(2100);

const seasonField = z.number().int().min(0).max(1000);
const episodeField = z.number().int().min(1).max(99_999);

function queryArgs(title: string, year: number | undefined, season?: number, episode?: number): string[] {
  return [
    title,
    ...(year === undefined ? [] : [String(year)]),
    ...(episode === undefined ? [] : ['--episode', String(episode)]),
    ...(episode === undefined || season === undefined ? [] : ['--season', String(season)]),
  ];
}

/** Cuts the unrelated results of one script answer down to a few. */
function trimOthers(answer: unknown): unknown {
  if (typeof answer !== 'object' || answer === null) return answer;
  const others = (answer as { others?: unknown }).others;
  if (!Array.isArray(others) || others.length <= STREAMING_OTHERS_LIMIT) return answer;
  return { ...answer, others: others.slice(0, STREAMING_OTHERS_LIMIT), others_omitted: others.length - STREAMING_OTHERS_LIMIT };
}

function requireRunner(runner: StreamingRunner | null | undefined): StreamingRunner {
  if (!runner) throw new Error(STREAMING_OFF);
  return runner;
}

async function findOnSite(runner: StreamingRunner, site: StreamingSite, title: string, year: number | undefined, season?: number, episode?: number): Promise<unknown> {
  try {
    return trimOthers(await runner(site, queryArgs(title, year, season, episode)));
  } catch (err) {
    return { ok: false, site, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The streaming tools: find a title on the streaming sites, and start a film full screen. Both
 * run claude/streaming/cli.mjs through `deps.streaming`, the same command the /idlix, /lk21 and /flicksy
 * skills run. Without it both answer streaming_off.
 */
export function registerStreamingTools(server: McpServer, deps: Pick<ToolDeps, 'streaming'>): void {
  server.registerTool(
    FIND,
    {
      title: 'Find a title on the streaming sites',
      description: FIND_DESCRIPTION,
      inputSchema: {
        title: titleField.describe('The film or series title, without the year.'),
        year: yearField.optional().describe('The release year, when known. Tells a remake from its original.'),
        site: siteField.optional().describe(`One site (${SITE_LIST}). Omit to ask every site.`),
        season: seasonField.optional().describe('With episode, when the owner named a season.'),
        episode: episodeField.optional().describe('One episode of a series, by its number as the owner said it ("one piece 787").'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ title, year, site, season, episode }) =>
      run(async () => {
        const runner = requireRunner(deps.streaming);
        const sites = site === undefined ? STREAMING_SITES : [site];
        return { sites: await Promise.all(sites.map((name) => findOnSite(runner, name, title, year, season, episode))) };
      }),
  );

  server.registerTool(
    PLAY,
    {
      title: 'Play a film from a streaming site, full screen',
      description: PLAY_DESCRIPTION,
      inputSchema: {
        site: siteField.describe(`The site to play on (${SITE_LIST}).`),
        title: titleField.optional().describe('The film title, without the year. Give this or url.'),
        year: yearField.optional().describe('The release year, when known.'),
        url: z.string().url().max(500).optional().describe("A result's url from streaming_find or an earlier answer, to start exactly that one. Give this or title."),
        season: seasonField.optional().describe('With episode, when the owner named a season.'),
        episode: episodeField.optional().describe('One episode of a series, by its number as the owner said it ("one piece 787"). With title, not url.'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ site, title, year, url, season, episode }) =>
      run(async () => {
        const runner = requireRunner(deps.streaming);
        if (url !== undefined) return runner(site, ['--play-url', url]);
        if (title === undefined) throw new Error('give a title or a url');
        return trimOthers(await runner(site, ['--play', ...queryArgs(title, year, season, episode)]));
      }),
  );
}
