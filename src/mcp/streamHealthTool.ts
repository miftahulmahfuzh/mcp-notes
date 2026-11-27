import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { STREAM_HEALTH_TOOL_NAME } from '../chat/status.js';
import { HEALTH_DEFAULT_DAYS, HEALTH_MAX_DAYS, type HealthAnswer } from '../directStream/playLog/health.js';
import { DEFAULT_WALL_URL } from './instructions.js';
import { jsonResult, type ToolDeps } from './tools.js';

const DESCRIPTION =
  "How direct-stream plays went on this machine, from the play log: the wall's Stream health page (/movies/health) as data. " +
  'days (default 7, at most 90) is the period. totals has one entry per channel (all, cloud, torrent, and cache or site when they played) and by_source one per torrent index or cloud provider, each with asks, played (plays that reached the screen, however short: a short test play is a success, never a failure), success_rate (played / asks), failed, no_picture (a player opened and showed no frame), median_resolve_ms (ask to player), median_first_frame_ms, played_hours, stalls_per_hour, stalled_share (the share of the watching time, playing plus standing still, the film stood still) and hd_share (share of plays at 1080p or better). ' +
  'failures counts the failed asks per channel by outcome word (no_source, no_stream, bot_check, dubbed, ...). recent lists the latest plays: title, source, first frame, stalls and how each ended. ' +
  'unhandled lists, over all time, every film or episode whose asks failed and that has not played since, with what the cloud providers (cloud_failure) and the torrents (torrent_failure) last answered (no_picture: a player opened there and never showed the film; null: not asked there). ' +
  'Call it for "how did torrents do this week?", "which torrent index starts fastest?", "what could not be played?". Reads only. Off on this server: direct_stream_off.';

const OFF = JSON.stringify({ error: 'direct_stream_off', message: 'The movie library is off on this machine, so nothing is streamed or logged.' });

/** What to say first: start success, first frame, stalls and 1080p, per channel; never minutes watched. */
function nextFor(a: HealthAnswer): string {
  if (a.totals.all!.asks === 0) {
    return a.unhandled.length === 0
      ? `Say nothing was played on this machine in the last ${a.days} days.`
      : `Say nothing was played in the last ${a.days} days, then list the titles in unhandled with what the cloud and the torrents answered.`;
  }
  return 'Lead with each channel\'s success_rate (played of asks; a short play counts as played), median first frame, stalls per hour and hd_share, then the torrent indexes or providers that differ most; then the failures by word and, when unhandled is not empty, the titles that could not be played. Do not lead with hours watched.';
}

/** direct_stream_health. Without deps.streamHealth it answers direct_stream_off. */
export function registerStreamHealthTool(server: McpServer, deps: Pick<ToolDeps, 'streamHealth' | 'wallUrl'>): void {
  const wall = (deps.wallUrl ?? DEFAULT_WALL_URL).replace(/\/+$/, '');
  server.registerTool(
    STREAM_HEALTH_TOOL_NAME,
    {
      title: 'How stream plays went on this machine',
      description: DESCRIPTION,
      inputSchema: {
        days: z.number().int().min(1).max(HEALTH_MAX_DAYS).optional().describe(`The period in days, 1 to ${HEALTH_MAX_DAYS}; default ${HEALTH_DEFAULT_DAYS}. unhandled is over all time whatever the period.`),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      const reader = deps.streamHealth;
      if (!reader) return { isError: true, content: [{ type: 'text', text: OFF }] };
      const answer = await reader.read(args.days ?? HEALTH_DEFAULT_DAYS);
      return jsonResult({ ...answer, link: `${wall}/movies/health`, next: nextFor(answer) }, true);
    },
  );
}
