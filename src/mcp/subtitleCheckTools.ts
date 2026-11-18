import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { SUBTITLE_CHECK_TOOL_NAMES } from '../chat/status.js';
import type { AppDeps } from '../deps.js';
import { lookupTitle, parseTitleRequest } from '../directStream/lookup.js';
import type { CheckResult, PendingCheck } from '../directStream/subtitleCheck/checker.js';
import { CheckError, type CheckTarget } from '../directStream/subtitleCheck/subjects.js';
import { DirectStreamError, toStreamRef, type StreamRef } from '../directStream/types.js';
import { candidateView, directStreamToolDeps, targetFor, type DirectStreamToolDeps } from './directStreamTools.js';
import { DEFAULT_WALL_URL } from './instructions.js';
import { movieErrorResult } from './movieTools.js';
import { jsonResult, type ToolDeps } from './tools.js';

const [SYNC_SUBTITLE] = SUBTITLE_CHECK_TOOL_NAMES;

/**
 * The tool answers within this, whatever the check does: Claude Code gives an MCP request 60 s (see PLAY_ANSWER_MS
 * in directStreamTools.ts). A check of a film already on disk takes about half a minute; a cloud title resolved out
 * of sight, or many subtitles tried, takes longer and answers `pending`.
 */
export const CHECK_ANSWER_MS = 45_000;

/** What direct_stream_sync_subtitle calls on the daemon (SubtitleCheckService); tests pass a fake. */
export interface SubtitleCheckApi {
  onScreen(): { sessionId: string; ref: StreamRef } | null;
  check(target: CheckTarget, waitMs: number): Promise<CheckResult | PendingCheck>;
}

export interface SubtitleCheckToolDeps {
  /** The direct-stream tools' lookup (titles, movie ids, TMDB). */
  lookup: DirectStreamToolDeps;
  check: SubtitleCheckApi;
}

/** The tool deps of a running daemon, or null when direct streaming is off or Whisper is not installed. */
export function subtitleCheckToolDeps(deps: AppDeps): SubtitleCheckToolDeps | null {
  const lookup = directStreamToolDeps(deps);
  const check = deps.subtitleCheck ?? null;
  return lookup === null || check === null ? null : { lookup, check };
}

export const SUBTITLE_CHECK_OFF =
  'subtitle_check_off: the subtitle check is not available on this machine. It needs direct streaming on and Whisper installed (scripts/install.sh installs it; NOTESD_TORRENT_WHISPER=off turns it off).';

const DESCRIPTION =
  'Check the English subtitle of a directly streamed film or episode against the film\'s own audio, and fix it: /sync-subtitle. ' +
  'The daemon cuts a minute of audio at six places spread over the film, Whisper writes down what is said there, and the subtitle is judged against those lines twice: is it the right text (another episode\'s file shares almost no line), and does each line come when it is said (within 0.6 s at the start and the end of the film). ' +
  'A right subtitle that is late, early or drifting is re-timed; a wrong one, or one cut for another edit, is replaced by the first of the subtitle services\' other files that passes both checks (re-timed when that is all it lacks). Nothing is changed unless a subtitle passed both. ' +
  'Name what to check in one of three ways: session (a stream session id, or the player page\'s address http://localhost:7317/stream/<id>); title (a movie id such as M-23T4, where an episode\'s id names its season and episode, a title key, or a name with year, season and episode); or nothing at all for the stream on screen. ' +
  'When a stream of the title is on screen (live), the new subtitle is put on that session and the open page shows it within about 5 seconds, without touching the film. With none open (idle), this machine\'s finished torrent download of the title is checked, else a cloud source resolved out of sight (nothing plays), and the choice is kept for the next play. source "torrent" or "cloud" says which to check when idle. ' +
  'Answers { verdict, changed, title, mode live | idle, source, provider, heard { lines, windows }, current, tried, chosen, notes, took_s }. verdict ok: the subtitle shown is right and in step, nothing changed. retimed: the same subtitle, moved (chosen.shift_s, chosen.stretch). replaced: another file (chosen.from, chosen.name). ' +
  'none_fits: the subtitle shown is wrong or out of step and no other file passed; unsure: too little matched to say (a film not in English is heard through a translation), or the subtitle shown is a growing track that cannot be read as a file; unheard: too little speech was heard. In those three nothing changed. ' +
  'current and each of tried carry text (correct, wrong, unsure) with text_share (the share of heard lines found in it), timing (in_step, off, scattered, unknown) with off_start_s and off_end_s (subtitle minus speech, seconds), and grade. ' +
  'A check that outlasts 45 s answers pending true with stage: it goes on in the daemon, and the same call again joins it. Errors: unknown_session, no_audio (idle, torrent asked, and no finished download here), no_source (no cloud provider could stream the title), subtitle_check_off.';

function ok(value: unknown): CallToolResult {
  return jsonResult(value, true);
}

function failJson(value: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(value) }] };
}

/** A session id from the id itself or from the player page's address (`.../stream/<id>`). */
export function sessionIdOf(text: string): string | null {
  const last = text.trim().replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop() ?? '';
  return /^[A-Za-z0-9_-]{16,64}$/.test(last) ? last : null;
}

/** What to tell the owner, by verdict. */
export function nextFor(out: CheckResult): string {
  const where = out.mode === 'live' ? 'The open player shows it within about 5 seconds; the film was not touched.' : 'Nothing is playing it now: the next play of it on this machine starts with it.';
  switch (out.verdict) {
    case 'ok':
      return 'The subtitle shown is the right one and in step: say so in one line with the evidence (heard.lines lines heard, current.text_share of them found in it, off by current.off_start_s s at the start and current.off_end_s s at the end). Nothing was changed.';
    case 'retimed':
      return 'The subtitle was the right text at the wrong time: it was moved by chosen.shift_s seconds (and stretched by chosen.stretch when that is not 1) and kept. Say so with current.off_start_s and current.off_end_s as it was. ' + where;
    case 'replaced':
      return 'The subtitle shown was ' + (out.current === null ? 'missing' : 'wrong or could not be re-timed (current.text, current.timing)') + ': it was replaced by chosen.from / chosen.name' + (out.chosen?.retimed === true ? ', re-timed to the audio' : '') + ', which passed both checks. Say what was wrong and what is shown now. ' + where;
    case 'none_fits':
      return 'The subtitle shown did not pass (current.text, current.timing) and none of the files tried did either: list tried in one short line each (name, text, timing). Nothing was changed. Offer the player\'s G and H keys for a plain delay, or another source of the title (a torrent with its own subtitle file, another cloud provider).';
    case 'unsure':
      return 'Too little matched to say whether the subtitle is right, and nothing was changed: give the reason from notes and current.';
    case 'unheard':
      return 'Too little speech was heard to judge anything (heard.windows says what each stretch gave; a window with a problem could not be cut, for instance a torrent not downloaded that far). Nothing was changed. Say so, and that it can be asked again once more of the film is downloaded.';
  }
}

export function registerSubtitleCheckTools(server: McpServer, deps: Pick<ToolDeps, 'subtitleCheck' | 'wallUrl'>): void {
  const wall = (deps.wallUrl ?? DEFAULT_WALL_URL).replace(/\/+$/, '');
  server.registerTool(
    SYNC_SUBTITLE,
    {
      title: 'Check a stream\'s subtitle against its audio, and fix it',
      description: DESCRIPTION,
      inputSchema: {
        title: z.string().trim().min(1).max(200).optional().describe('The film or series: a movie id (M-23T4; an episode\'s id names its season and episode), a title key (movie-550), or its name without the year. Leave out, with session too, for the stream on screen.'),
        year: z.number().int().min(1880).max(2100).optional().describe('The release year, when a name was given and it is known.'),
        kind: z.enum(['movie', 'tv']).optional().describe('"movie" or "tv" (a series), when the owner said which.'),
        season: z.number().int().min(0).max(1000).optional().describe('A series only: the season of the episode.'),
        episode: z.number().int().min(0).max(100000).optional().describe('A series only: the episode number within that season. A series named without one means the episode on screen.'),
        session: z.string().trim().min(1).max(400).optional().describe('A live stream session instead of a title: its id, or the player page\'s address (http://localhost:7317/stream/<id>).'),
        source: z.enum(['torrent', 'cloud']).optional().describe('Only with no stream of it on screen: check this machine\'s torrent download of the title ("torrent": TM, TS) or a cloud source ("cloud": NTM, NTS). Default: the download when there is a finished one, else a cloud source.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ title, year, kind, season, episode, session, source }): Promise<CallToolResult> => {
      const d = deps.subtitleCheck;
      if (!d) return { isError: true, content: [{ type: 'text', text: SUBTITLE_CHECK_OFF }] };
      try {
        let target: CheckTarget;
        let named: unknown = null;
        if (session !== undefined) {
          const id = sessionIdOf(session);
          if (id === null) return failJson({ error: 'invalid_input', message: 'session is neither a stream session id nor a player page address (http://localhost:7317/stream/<id>).' });
          target = { session: id };
        } else if (title === undefined) {
          const on = d.check.onScreen();
          if (on === null) return ok({ skipped: 'nothing_playing', next: 'No stream is on screen, so there is nothing to check without a title. Ask which film or episode.' });
          target = { session: on.sessionId };
        } else {
          const result = await lookupTitle(parseTitleRequest(title, year ?? null, kind ?? null), d.lookup);
          if (result.status === 'none') {
            return ok({ skipped: 'no_match', did_you_mean: result.nearMisses.map((c) => candidateView(c, wall)), next: 'No title has that name or id. Show did_you_mean with years and ask which is meant; then call again with its title_key.' });
          }
          if (result.status === 'several') {
            return ok({ skipped: 'several_matches', candidates: result.candidates.map((c) => candidateView(c, wall)), next: 'List the candidates with their years and ask which one; then call again with its movie_id or title_key.' });
          }
          const c = result.candidate;
          named = candidateView(c, wall);
          const picked = targetFor(c, result.episode, season, episode);
          const on = d.check.onScreen();
          if (picked !== null) target = { ref: toStreamRef(picked), ...(source === undefined ? {} : { source }) };
          else if (on !== null && on.ref.kind === 'tv' && on.ref.tmdbId === c.tmdbId) target = { session: on.sessionId };
          else {
            return ok({ skipped: 'needs_episode', title: named, next: 'A series has a subtitle per episode and none of its episodes is on screen: call again with season and episode (movies_get gives last_play.season and last_play.episode for "the one I watched").' });
          }
        }
        const out = await d.check.check(target, CHECK_ANSWER_MS);
        if ('pending' in out) {
          return ok({
            ...out,
            ...(named === null ? {} : { title: named }),
            next: 'Not done yet, and not failed: the check goes on in the daemon (stage says what it is doing). Tell the owner in one line, then call direct_stream_sync_subtitle again with exactly the same arguments: that joins this check and answers its outcome, or pending again.',
          });
        }
        return ok({ ...out, ...(named === null ? {} : { named }), next: nextFor(out) });
      } catch (err) {
        if (err instanceof CheckError) {
          return failJson({
            error: err.code,
            message: err.message,
            next:
              err.code === 'unknown_session'
                ? 'That session has ended. Ask for the title, or check the stream on screen by calling with no arguments.'
                : err.code === 'no_audio'
                  ? 'Nothing was checked. Say why (message), and offer to check a cloud source instead (source "cloud") or to play it first.'
                  : 'Nothing was checked. Say why (message).',
          });
        }
        if (err instanceof DirectStreamError) {
          return failJson({
            error: err.code,
            reason: err.reason,
            attempts: err.attempts,
            message: err.message,
            next: 'Nothing was checked: with no stream of it on screen and no torrent download here, a cloud source was looked for and none could stream it. Say so, and that the subtitle can be checked while the title plays.',
          });
        }
        return movieErrorResult(err);
      }
    },
  );
}
