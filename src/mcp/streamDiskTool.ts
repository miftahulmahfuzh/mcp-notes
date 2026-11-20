import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { STREAM_DISK_TOOL_NAME } from '../chat/status.js';
import { ShelfError, sizeText, type CacheShelf, type ShelfTitle, type ShelfView } from '../directStream/cacheShelf.js';
import { DEFAULT_WALL_URL } from './instructions.js';
import { jsonResult, type ToolDeps } from './tools.js';

/** What the tool calls on the daemon's CacheShelf; tests pass the real one over fakes. */
export type StreamDiskApi = Pick<CacheShelf, 'view' | 'remove' | 'undo'>;

const DESCRIPTION =
  "What this machine keeps on disk for streaming (torrent downloads and the cloud stream cache), per title, season and episode, and deleting it: the wall's Cache page (/movies/cache). " +
  'action list: the total against the torrent budget, split torrents / cloud, and every title holding cache, largest first, with its size, kinds (torrent, cloud), watched and not_interested tags, in_use (it plays or is being fetched: it cannot be deleted now), and for a series its seasons and episodes. Pass title to see one title only ("how much cache does Dandadan take?"). ' +
  'action delete with title (a name, a movie id such as M-23T4 (an episode\'s id names its episode) or a title key such as tv-1399), plus season, or season and episode: deletes that title\'s (season\'s, episode\'s) cache. action delete_watched: every watched film and series, and a series\' watched episodes ("clear the cache of watched stuff"). action delete_not_interested: every title marked not interested. ' +
  'A deletion is carried out 10 seconds after the call (the Cache page shows an undo for that long); action undo with the id from the answer cancels it inside that window. Nothing is blacklisted: a deleted torrent can be fetched again. Sizes are blocks on disk. ' +
  'Only this machine\'s cache is listed or deleted. Off on this server: stream_disk_off.';

const OFF = JSON.stringify({ error: 'stream_disk_off', message: 'Neither torrents nor the stream cache are on on this machine.' });

interface DiskArgs {
  action: 'list' | 'delete' | 'delete_watched' | 'delete_not_interested' | 'undo';
  title?: string | undefined;
  season?: number | undefined;
  episode?: number | undefined;
  id?: string | undefined;
}

const fold = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** The titles the words name: a movie id (the title's or an episode's), a title key, else the name (exact first, then contained). */
export function matchTitles(view: ShelfView, words: string): { titles: ShelfTitle[]; season?: number; episode?: number } {
  const raw = words.trim();
  const upper = raw.toUpperCase();
  for (const t of view.titles) {
    if (t.movie_id !== null && t.movie_id.toUpperCase() === upper) return { titles: [t] };
    if (t.title_id === raw.toLowerCase()) return { titles: [t] };
    for (const s of t.seasons) for (const e of s.episodes) if (e.movie_id !== null && e.movie_id.toUpperCase() === upper) return { titles: [t], season: e.season, episode: e.episode };
  }
  const want = fold(raw);
  const exact = view.titles.filter((t) => fold(t.title) === want);
  if (exact.length > 0) return { titles: exact };
  return { titles: view.titles.filter((t) => want !== '' && fold(t.title).includes(want)) };
}

/** A title as the tool answers it: sizes in words beside the bytes. */
function titleView(t: ShelfTitle, wall: string): Record<string, unknown> {
  return {
    title: t.title,
    year: t.year,
    movie_id: t.movie_id,
    title_key: t.title_id,
    link: t.stored ? `${wall}/movies/${t.movie_id ?? t.title_id}?side=stream` : null,
    size: sizeText(t.bytes),
    bytes: t.bytes,
    torrent: sizeText(t.torrent_bytes),
    cloud: sizeText(t.cloud_bytes),
    kinds: t.kinds,
    watched: t.watched,
    not_interested: t.not_interested,
    in_use: t.in_use,
    ...(t.kind === 'tv'
      ? {
          seasons: t.seasons.map((s) => ({
            season: s.season,
            size: sizeText(s.bytes),
            shared: s.shared_bytes > 0 ? sizeText(s.shared_bytes) : undefined,
            watched: s.watched,
            in_use: s.in_use,
            episodes: s.episodes.map((e) => ({ episode: e.episode, movie_id: e.movie_id, name: e.name, size: sizeText(e.bytes), kinds: e.kinds, watched: e.watched, in_use: e.in_use })),
          })),
        }
      : {}),
  };
}

function ok(value: unknown): CallToolResult {
  return jsonResult(value, true);
}

async function diskAction(a: DiskArgs, d: StreamDiskApi, wall: string): Promise<CallToolResult> {
  if (a.action === 'undo') {
    if (a.id === undefined) return ok({ error: 'invalid_input', next: 'undo needs the id of a deletion from an earlier answer.' });
    const undone = await d.undo(a.id);
    return ok({ undone: true, deletion: undone, next: `Say ${undone.label} is kept: the deletion was cancelled.` });
  }
  if (a.action === 'delete_watched' || a.action === 'delete_not_interested') {
    const deletion = await d.remove({ bulk: a.action === 'delete_watched' ? 'watched' : 'not_interested' });
    return ok({
      deletion: { ...deletion, size: sizeText(deletion.bytes) },
      next: `Say ${deletion.label}, ${sizeText(deletion.bytes)}, is deleted in 10 seconds${deletion.skipped.length > 0 ? `, and that ${deletion.skipped.join(', ')} was left because it is in use` : ''}; it can be undone with action undo and this id until then.`,
    });
  }
  const view = await d.view();
  const summary = {
    host: view.host,
    total: sizeText(view.total_bytes),
    torrents: sizeText(view.torrent_bytes),
    cloud: sizeText(view.cloud_bytes),
    budget: view.budget_bytes === null ? null : sizeText(view.budget_bytes),
    delete_watched_frees: sizeText(view.bulk.watched.bytes),
    delete_not_interested_frees: sizeText(view.bulk.not_interested.bytes),
  };
  if (a.action === 'list' && a.title === undefined) {
    return ok({ ...summary, count: view.titles.length, titles: view.titles.map((t) => titleView(t, wall)), next: view.titles.length === 0 ? 'Nothing is cached on this machine. Say so.' : 'Say the total against the budget and the largest titles with their sizes.' });
  }
  if (a.title === undefined) return ok({ error: 'invalid_input', next: 'delete needs a title (a name, a movie id or a title key).' });
  const found = matchTitles(view, a.title);
  if (found.titles.length === 0) return ok({ ...summary, found: false, next: `Nothing named "${a.title}" holds cache on this machine. Say so.` });
  if (found.titles.length > 1) {
    return ok({ skipped: 'several_matches', candidates: found.titles.map((t) => ({ title: t.title, year: t.year, title_key: t.title_id, size: sizeText(t.bytes) })), next: 'Ask which one; then call again with its title_key.' });
  }
  const t = found.titles[0]!;
  if (a.action === 'list') return ok({ ...summary, titles: [titleView(t, wall)], next: `Say how much ${t.title} takes${t.kind === 'tv' ? ', by season' : ''}.` });
  const season = a.season ?? found.season;
  const episode = a.episode ?? found.episode;
  if (episode !== undefined && season === undefined) return ok({ error: 'invalid_input', next: 'An episode needs its season.' });
  const deletion = await d.remove({ title_id: t.title_id, ...(season === undefined ? {} : { season }), ...(episode === undefined ? {} : { episode }) });
  return ok({ deletion: { ...deletion, size: sizeText(deletion.bytes) }, next: `Say ${deletion.label}, ${sizeText(deletion.bytes)}, is deleted in 10 seconds; it can be undone with action undo and this id until then.` });
}

/** stream_disk. Without deps.streamDisk it answers stream_disk_off. */
export function registerStreamDiskTool(server: McpServer, deps: Pick<ToolDeps, 'streamDisk' | 'wallUrl'>): void {
  const wall = (deps.wallUrl ?? DEFAULT_WALL_URL).replace(/\/+$/, '');
  server.registerTool(
    STREAM_DISK_TOOL_NAME,
    {
      title: "What this machine's stream cache takes on disk, and deleting it",
      description: DESCRIPTION,
      inputSchema: {
        action: z.enum(['list', 'delete', 'delete_watched', 'delete_not_interested', 'undo']).describe('list (optionally one title), delete one title/season/episode, delete every watched or not-interested title, undo a deletion by id.'),
        title: z.string().trim().min(1).max(200).optional().describe('A title name, a movie id (M-23T4; an episode\'s id names its episode) or a title key (tv-1399).'),
        season: z.number().int().min(0).max(1000).optional().describe('delete: a series\' season.'),
        episode: z.number().int().min(1).max(10_000).optional().describe('delete: an episode of that season.'),
        id: z.string().trim().regex(/^[0-9a-f]{12}$/).optional().describe('undo: the id of a deletion from an earlier answer.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args) => {
      const d = deps.streamDisk;
      if (!d) return { isError: true, content: [{ type: 'text', text: OFF }] };
      try {
        return await diskAction(args, d, wall);
      } catch (err) {
        if (err instanceof ShelfError) {
          const next = err.code === 'in_use' ? 'Say it plays or is being fetched now and can be deleted once it stops.' : err.code === 'unknown_deletion' ? 'Say the deletion was already carried out (or undone): it cannot be undone now.' : 'Say nothing of it is cached on this machine.';
          return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: err.code, message: err.message, next }) }] };
        }
        throw err;
      }
    },
  );
}
