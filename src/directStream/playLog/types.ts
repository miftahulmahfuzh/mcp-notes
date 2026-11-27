import type { StreamPlayAsked, StreamPlayEnd, StreamPlayVia } from '../../db/schema.js';
import type { StreamRef } from '../types.js';

/** An open play's row is written at most this often while its page reports; the first report and the end are written at once. */
export const PLAY_LOG_WRITE_EVERY_MS = 30_000;
/** Characters of a failure's detail kept on the row (as stream_downloads keeps). */
export const PLAY_LOG_DETAIL_MAX = 500;
/** Page loads kept apart per session; older ones are folded into one total (a load never reports after the page that replaced it). */
export const PLAY_LOG_MAX_LOADS = 16;

/** One play ask whose title is known: when it began, which service entry made it, the title, how the source was named. */
export interface PlayAsk {
  at: Date;
  via: StreamPlayVia;
  ref: StreamRef;
  asked: StreamPlayAsked | null;
}

/** The player page's counters since its load (the position report's `stats` key, read once at the route). */
export interface PageStats {
  /** The page load's own random id. */
  load: string;
  /** Page load to first frame; null until there was one. */
  firstFrameMs: number | null;
  playedMs: number;
  stalls: number;
  stalledMs: number;
  /** Torrent waits (`waiting for the torrent`): never counted as stalls. */
  waits: number;
  waitedMs: number;
  errors: number;
}

/** The counters summed over a session's page loads. */
export interface PlayTotals {
  playedMs: number;
  stalls: number;
  stalledMs: number;
  waits: number;
  waitedMs: number;
  errors: number;
}

/** How a page says its play is over: the film ended, or the page closed. */
export type PageEnd = Extract<StreamPlayEnd, 'finished' | 'closed'>;

/** One position report as the play log reads it. `quiet`: a paused page's beat for the stream on screen (memory only). */
export interface PageReport {
  stats: PageStats | null;
  over: PageEnd | null;
  quiet: boolean;
}

/** The outcome word each channel of a failed ask ended with; null: that channel was not asked. */
export interface ChannelFailures {
  cloud: string | null;
  torrent: string | null;
}
