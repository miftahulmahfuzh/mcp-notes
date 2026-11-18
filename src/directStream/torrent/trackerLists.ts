import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TorrentConfig } from '../../config.js';
import { DEFAULT_TRACKERS } from './find/candidate.js';
import { TORRENT_INDEX_USER_AGENT } from './find/find.js';
import { CONNECT_TIMEOUT_MS, udpConnector, udpTrackerOf, type ConnectTrackers } from './find/scrape.js';
import { TRACKER_BOOK_FILE, TrackerBook, trackerKey } from './origins.js';

/**
 * The public tracker lists (wider-torrent-sources phase 3). Once a day ngosang's `trackers_best` and newtrackon's
 * `stable` are read, each UDP tracker on them that the daemon does not hold already (DEFAULT_TRACKERS, the tracker
 * book) is asked for a BEP 15 connect only (nothing announced, no info hash sent, no peer contacted), and the ones
 * that answer are kept in `<torrent dir>/tracker-lists.json`. TorrentSource adds them to every torrent it opens and
 * every scrape, after the candidate's own trackers and the book's. A refresh that reads no list or hears no tracker
 * keeps the previous file; nothing here runs in a play's path, and reading the file never throws.
 */

export interface TrackerListSource {
  /** Named in the file and in the log. */
  name: string;
  url: string;
}

/** The lists read, in this order: a tracker on both is kept under the first. Constants, not settings. */
export const TRACKER_LIST_SOURCES: readonly TrackerListSource[] = [
  { name: 'ngosang', url: 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt' },
  { name: 'newtrackon', url: 'https://newtrackon.com/api/stable' },
];

/** The file's name inside the torrent folder, beside the tracker book's (trackers.json). */
export const TRACKER_LISTS_FILE = 'tracker-lists.json';
/** Trackers kept at most: each is announced to by every torrent opened. */
export const TRACKER_LISTS_MAX = 20;
/** New trackers asked at most per refresh. */
export const TRACKER_LISTS_ASK_MAX = 60;
/** One list's answer must arrive within this. */
export const TRACKER_LIST_FETCH_TIMEOUT_MS = 15_000;
/** A list longer than this is read only this far. */
export const TRACKER_LIST_MAX_CHARS = 256 * 1024;
/** The first check after the daemon starts: never in the way of a start. */
export const TRACKER_LISTS_INITIAL_DELAY_MS = 60_000;
/** The job looks this often whether the kept trackers are a day old. */
export const TRACKER_LISTS_CHECK_MS = 60 * 60_000;
export const TRACKER_LISTS_EVERY_MS = 24 * 60 * 60_000;
const CLOSE_GRACE_MS = 5_000;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The distinct UDP trackers of a list's text (one address per line, blank lines between), in order. */
export function parseTrackerList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.slice(0, TRACKER_LIST_MAX_CHARS).split(/\r?\n/)) {
    const url = line.trim();
    if (udpTrackerOf(url) === null) continue;
    const key = trackerKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

export interface TrackerListEntry {
  url: string;
  /** The list it was read from (TRACKER_LIST_SOURCES' name). */
  source: string;
}

interface StoredLists {
  fetchedAt: Date | null;
  entries: TrackerListEntry[];
}

/**
 * The kept list trackers: one JSON file per host in the torrent folder, `{ fetched_at, trackers: [{ url, source }] }`.
 * Read once and kept in memory; `save` replaces both. Reading never throws: a missing or broken file is no tracker.
 */
export class TrackerLists {
  private stored: StoredLists | null = null;

  constructor(readonly file: string) {}

  private load(): StoredLists {
    if (this.stored !== null) return this.stored;
    let stored: StoredLists = { fetchedAt: null, entries: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { fetched_at?: unknown; trackers?: unknown };
      const at = typeof parsed.fetched_at === 'string' ? new Date(parsed.fetched_at) : null;
      const entries = Array.isArray(parsed.trackers)
        ? parsed.trackers.filter(
            (e): e is TrackerListEntry =>
              typeof e === 'object' && e !== null && typeof (e as TrackerListEntry).url === 'string' && typeof (e as TrackerListEntry).source === 'string' && udpTrackerOf((e as TrackerListEntry).url) !== null,
          )
        : [];
      stored = { fetchedAt: at !== null && !Number.isNaN(at.getTime()) ? at : null, entries: entries.slice(0, TRACKER_LISTS_MAX) };
    } catch {
      stored = { fetchedAt: null, entries: [] };
    }
    this.stored = stored;
    return stored;
  }

  /** The kept trackers' addresses, in their order. */
  list(): string[] {
    return this.load().entries.map((e) => e.url);
  }

  entries(): TrackerListEntry[] {
    return [...this.load().entries];
  }

  /** When the kept trackers were last saved; null when nothing is kept. */
  fetchedAt(): Date | null {
    return this.load().fetchedAt;
  }

  /** Replaces the kept trackers. Written to a temporary file and renamed, so no reader sees half of it. Throws when the folder cannot be written. */
  save(entries: readonly TrackerListEntry[], fetchedAt: Date): void {
    const kept = entries.slice(0, TRACKER_LISTS_MAX).map((e) => ({ url: e.url, source: e.source }));
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ fetched_at: fetchedAt.toISOString(), trackers: kept }, null, 2)}\n`);
    renameSync(tmp, this.file);
    this.stored = { fetchedAt, entries: kept };
  }
}

/** The part of fetch a refresh uses; tests pass a fake. */
export type TrackerListFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface TrackerListRead {
  source: string;
  /** `error`: no answer, not a 2xx, or no UDP tracker in it. */
  outcome: 'ok' | 'error';
  /** UDP trackers the list holds. */
  listed: number;
  detail: string | null;
}

export interface TrackerListsRefresh {
  /** `saved`: the file now holds the trackers that answered (and, for a list that could not be read, its previous ones); `kept`: the file was left as it was. */
  outcome: 'saved' | 'kept';
  lists: TrackerListRead[];
  /** New trackers asked for a connect. */
  asked: number;
  /** Of those, the ones that answered. */
  answered: number;
  /** Trackers in the file afterwards. */
  kept: number;
  detail: string | null;
}

export interface RefreshDeps {
  store: TrackerLists;
  fetch: TrackerListFetch;
  connect: ConnectTrackers;
  /** The tracker book's trackers now: not asked again. */
  known: () => readonly string[];
  sources?: readonly TrackerListSource[];
  now?: () => Date;
  signal?: AbortSignal;
  fetchTimeoutMs?: number;
  connectTimeoutMs?: number;
}

async function readList(source: TrackerListSource, deps: RefreshDeps, signal: AbortSignal): Promise<{ read: TrackerListRead; urls: string[] }> {
  const failed = (detail: string): { read: TrackerListRead; urls: string[] } => ({ read: { source: source.name, outcome: 'error', listed: 0, detail }, urls: [] });
  try {
    const answer = await deps.fetch(source.url, {
      headers: { 'user-agent': TORRENT_INDEX_USER_AGENT, accept: 'text/plain' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(deps.fetchTimeoutMs ?? TRACKER_LIST_FETCH_TIMEOUT_MS)]),
    });
    if (!answer.ok) return failed(`HTTP ${answer.status}`);
    const urls = parseTrackerList(await answer.text());
    if (urls.length === 0) return failed('no udp tracker in the list');
    return { read: { source: source.name, outcome: 'ok', listed: urls.length, detail: null }, urls };
  } catch (err) {
    return failed(messageOf(err));
  }
}

/**
 * One refresh: read every list, ask the new UDP trackers for a connect, keep the ones that answer (in the lists'
 * order), and carry the previous trackers of a list that could not be read. When no tracker answered, or no list
 * was read, the file is left exactly as it was. Never throws.
 */
export async function refreshTrackerLists(deps: RefreshDeps): Promise<TrackerListsRefresh> {
  const sources = deps.sources ?? TRACKER_LIST_SOURCES;
  const signal = deps.signal ?? new AbortController().signal;
  const now = deps.now ?? ((): Date => new Date());
  const reads = await Promise.all(sources.map((source) => readList(source, deps, signal)));
  const lists = reads.map((r) => r.read);
  let known: readonly string[] = [];
  try {
    known = deps.known();
  } catch {
    known = [];
  }
  const taken = new Set([...DEFAULT_TRACKERS, ...known].map(trackerKey));
  const fresh: TrackerListEntry[] = [];
  for (const { read, urls } of reads) {
    for (const url of urls) {
      const key = trackerKey(url);
      if (taken.has(key) || fresh.length >= TRACKER_LISTS_ASK_MAX) continue;
      taken.add(key);
      fresh.push({ url, source: read.source });
    }
  }
  let answered = new Set<string>();
  if (fresh.length > 0) {
    try {
      answered = await deps.connect(
        fresh.map((e) => e.url),
        { timeoutMs: deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS },
      );
    } catch {
      answered = new Set();
    }
  }
  const verified = fresh.filter((e) => answered.has(e.url));
  const failed = new Set(lists.filter((l) => l.outcome === 'error').map((l) => l.source));
  const base = { lists, asked: fresh.length, answered: verified.length };
  const keep = (detail: string): TrackerListsRefresh => ({ ...base, outcome: 'kept', kept: deps.store.list().length, detail });
  if (signal.aborted) return keep('stopped');
  if (verified.length === 0) return keep(failed.size === lists.length ? 'no list could be read' : 'no tracker answered');
  const carried = deps.store.entries().filter((e) => failed.has(e.source) && !taken.has(trackerKey(e.url)));
  const next = [...verified, ...carried].slice(0, TRACKER_LISTS_MAX);
  try {
    deps.store.save(next, now());
  } catch (err) {
    return keep(`the file could not be written: ${messageOf(err)}`);
  }
  return { ...base, outcome: 'saved', kept: next.length, detail: null };
}

/** The daemon log's line for one refresh. */
export function refreshLine(r: TrackerListsRefresh): string {
  const lists = r.lists.map((l) => (l.outcome === 'ok' ? `${l.source} ${l.listed}` : `${l.source}: ${l.detail ?? 'error'}`)).join(', ');
  return r.outcome === 'saved'
    ? `[notesd] tracker lists: ${r.answered} of ${r.asked} new trackers answered, ${r.kept} kept (${lists})`
    : `[notesd] tracker lists: kept the previous ${r.kept} trackers, ${r.detail ?? 'nothing new'} (${lists})`;
}

/** What startBackground starts and closes. */
export interface TrackerListsHandle {
  readonly enabled: boolean;
  startLine(): string;
  start(): void;
  close(): Promise<void>;
}

export type TrackerListsOffReason = 'setting_off' | 'torrent_off' | 'discovery_off';

const OFF_TEXT: Record<TrackerListsOffReason, string> = {
  setting_off: 'NOTESD_TORRENT_TRACKER_LISTS=off',
  torrent_off: 'torrents are off (NOTESD_TORRENT=off or direct streaming off)',
  discovery_off: 'NOTESD_TORRENT_DISCOVERY=off asks no tracker',
};

/** No list is read and no tracker asked. */
export class DisabledTrackerLists implements TrackerListsHandle {
  readonly enabled = false;

  constructor(readonly reason: TrackerListsOffReason) {}

  startLine(): string {
    return `[notesd] tracker lists off: ${OFF_TEXT[this.reason]}`;
  }

  start(): void {}

  async close(): Promise<void> {}
}

export interface TrackerListsJobOptions {
  store: TrackerLists;
  fetch: TrackerListFetch;
  connect: ConnectTrackers;
  known: () => readonly string[];
  now?: () => Date;
  log?: (line: string) => void;
  /** Default TRACKER_LISTS_INITIAL_DELAY_MS. */
  initialDelayMs?: number;
  /** Default TRACKER_LISTS_CHECK_MS. */
  checkMs?: number;
  /** Default TRACKER_LISTS_EVERY_MS. */
  everyMs?: number;
}

/**
 * The daily loop: a minute after start, then every hour, it refreshes when the kept trackers are a day old (or none
 * are kept). Timers are unref'd; close stops the loop and aborts a running refresh.
 */
export class TrackerListsJob implements TrackerListsHandle {
  readonly enabled = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private closed = false;
  private readonly abort = new AbortController();
  private readonly now: () => Date;
  private readonly log: (line: string) => void;

  constructor(private readonly o: TrackerListsJobOptions) {
    this.now = o.now ?? ((): Date => new Date());
    this.log = o.log ?? ((line: string) => console.log(line));
  }

  startLine(): string {
    return `[notesd] tracker lists on: ${TRACKER_LIST_SOURCES.map((s) => s.name).join(' and ')} read once a day, the UDP trackers that answer kept in ${this.o.store.file}`;
  }

  start(): void {
    this.schedule(this.o.initialDelayMs ?? TRACKER_LISTS_INITIAL_DELAY_MS);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abort.abort();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const running = this.running;
    if (running !== null) await Promise.race([running.catch(() => undefined), new Promise((r) => setTimeout(r, CLOSE_GRACE_MS).unref())]);
  }

  private schedule(ms: number): void {
    if (this.closed) return;
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.closed) return;
    try {
      const at = this.o.store.fetchedAt();
      if (at === null || this.now().getTime() - at.getTime() >= (this.o.everyMs ?? TRACKER_LISTS_EVERY_MS)) {
        this.running = refreshTrackerLists({ store: this.o.store, fetch: this.o.fetch, connect: this.o.connect, known: this.o.known, now: this.now, signal: this.abort.signal }).then((r) => {
          if (!this.closed) this.log(refreshLine(r));
        });
        await this.running;
      }
    } catch (err) {
      this.log(`[notesd] tracker lists: ${messageOf(err)}`);
    } finally {
      this.running = null;
      this.schedule(this.o.checkMs ?? TRACKER_LISTS_CHECK_MS);
    }
  }
}

export interface TrackerListsOverrides {
  fetch?: TrackerListFetch;
  connect?: ConnectTrackers;
  now?: () => Date;
  log?: (line: string) => void;
}

/** Off: no store for TorrentSource and a job that does nothing. On: the store TorrentSource reads and the job that fills it. */
export type TrackerListsBuild = { job: DisabledTrackerLists; lists: null } | { job: TrackerListsJob; lists: TrackerLists };

/**
 * The daemon's tracker lists. The one place the switches are read: NOTESD_TORRENT_TRACKER_LISTS (unset in a Config
 * literal: off), torrents on and built (`torrentsOn`), NOTESD_TORRENT_DISCOVERY.
 */
export function buildTrackerLists(torrent: TorrentConfig | undefined, torrentsOn: boolean, overrides: TrackerListsOverrides = {}): TrackerListsBuild {
  const off = (reason: TrackerListsOffReason): TrackerListsBuild => ({ job: new DisabledTrackerLists(reason), lists: null });
  if (torrent === undefined) return off('torrent_off');
  if (torrent.trackerLists !== true) return off('setting_off');
  if (!torrent.enabled || !torrentsOn) return off('torrent_off');
  if (!torrent.discovery) return off('discovery_off');
  const lists = new TrackerLists(join(torrent.dir, TRACKER_LISTS_FILE));
  const bookFile = join(torrent.dir, TRACKER_BOOK_FILE);
  const job = new TrackerListsJob({
    store: lists,
    fetch: overrides.fetch ?? ((url, init) => fetch(url, init)),
    connect: overrides.connect ?? udpConnector(),
    // Read fresh at each refresh: a tracker learned from a magnet since is not asked again.
    known: () => new TrackerBook(bookFile).list(),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
    ...(overrides.log === undefined ? {} : { log: overrides.log }),
  });
  return { job, lists };
}
