import { constants } from 'node:fs';
import { access, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openClaudeWindow, pickTmuxSession, promptArgs, type ClaudeWindowDeps } from '../sessions/resume.js';
import { SESSION_ID_PATTERN } from './sessions.js';

/*
 * The player's report button (STREAM_CACHE_AND_BUG_REPORT phase 4). A click takes phase 1's
 * evidence snapshot at once (sessions live in memory and tokens expire), then opens a new tmux
 * window running Claude Code in the mcp-notes checkout on `/report-stream-bug <snapshot folder>`
 * (phase 3's skill). One report per stream session: remembered in memory and by REPORT_MARKER in
 * the snapshot folder, so a restarted daemon does not make a second. The daemon writes no note;
 * the spawned session does, through the notes MCP server.
 */

/** Written by this module only, into a phase 1 snapshot folder, beside its own files. */
export const REPORT_MARKER = 'report.json';
/** Phase 3's skill. The prompt is exactly `${REPORT_SKILL} <absolute snapshot folder>`. */
export const REPORT_SKILL = '/report-stream-bug';
/**
 * The spawned session runs unattended (a collect script, a network measurement, a notes MCP
 * write): left on the default mode it would stop at its first Bash call and wait for the owner.
 * `auto` rather than `bypassPermissions`: the evidence holds text from third-party stream hosts
 * (error messages, host names, paths), so the permission classifier stays between that text and
 * the shell. Resume passes no mode because a resumed session is the owner's to drive.
 */
export const REPORT_PERMISSION_MODE = 'auto';

/** tmux window name of a report: `stream-bug-<first 6 characters of the session id>`. */
export function reportWindowName(sessionId: string): string {
  return `stream-bug-${sessionId.slice(0, 6)}`.replace(/[\s:.]+/g, '-');
}

/** What phase 1's snapshot answers. */
export interface EvidenceSnapshot {
  dir: string;
  session_id: string | null;
  /** False when the daemon no longer knew the session (its source is missing from the folder). */
  complete: boolean;
}

/** Phase 1's StreamEvidence, as far as the reporter uses it. */
export interface EvidenceSnapshotter {
  snapshot(sessionId: string | null): Promise<EvidenceSnapshot> | EvidenceSnapshot;
}

/** The page's own view of the failure, sent with the click (validated and scrubbed by the route). */
export interface PageReport {
  stage: string;
  error: string | null;
  errors: string[];
  log: string[];
  title: string | null;
  position_s: number | null;
}

/** How the window part ended. `pending`: the marker was written and the daemon stopped before the answer. */
export type MarkerResult =
  | { outcome: 'pending' }
  | { outcome: 'opened'; window: string }
  | { outcome: 'no_tmux' }
  | { outcome: 'spawn_failed'; message: string };

/** `report.json`. */
export interface ReportMarker {
  session_id: string;
  dir: string;
  reported_at: string;
  complete: boolean;
  prompt: string;
  page: PageReport | null;
  result: MarkerResult;
}

export type ReportOutcome =
  | { status: 200; body: { ok: true; dir: string; window: string; complete: boolean } }
  | { status: 409; body: { error: 'already_reported'; dir: string } }
  | { status: 409; body: { error: 'no_tmux'; dir: string; complete: boolean } }
  | { status: 500; body: { error: 'spawn_failed'; dir: string; message: string; complete: boolean } }
  | { status: 500; body: { error: 'snapshot_failed'; message: string } }
  | { status: 403; body: { error: 'unknown_session'; message: string } };

export interface StreamReporterOptions {
  evidence: EvidenceSnapshotter;
  /** True while the daemon knows the session (DirectStreamService.evidenceSource(id) !== null: does not mark it used). */
  isLive(sessionId: string): boolean;
  /** Phase 1's StreamEvidence.reportsDir (`<dataDir>/movies/stream-reports`): scanned once for markers left by an earlier run. */
  reportsDir: string;
  /** Where claude runs: the mcp-notes checkout (REPO_ROOT). */
  cwd: string;
  /** tmux and claude; a factory is called once, on the first window. */
  window: ClaudeWindowDeps | (() => ClaudeWindowDeps);
  /** True when the claude binary can be executed. Default: fs.access with X_OK. */
  canRun?: (bin: string) => Promise<boolean>;
  now?: () => Date;
}

const UNKNOWN: ReportOutcome = {
  status: 403,
  body: { error: 'unknown_session', message: 'That stream session is unknown or has ended, and the page sent no log to report.' },
};

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function executable(bin: string): Promise<boolean> {
  try {
    await access(bin, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

function parsePage(v: unknown): PageReport | null {
  if (!isRecord(v) || typeof v.stage !== 'string') return null;
  return {
    stage: v.stage,
    error: typeof v.error === 'string' ? v.error : null,
    errors: strings(v.errors),
    log: strings(v.log),
    title: typeof v.title === 'string' ? v.title : null,
    position_s: typeof v.position_s === 'number' && Number.isFinite(v.position_s) ? v.position_s : null,
  };
}

function parseResult(v: unknown): MarkerResult | null {
  if (!isRecord(v)) return null;
  switch (v.outcome) {
    case 'pending':
    case 'no_tmux':
      return { outcome: v.outcome };
    case 'opened':
      return { outcome: 'opened', window: typeof v.window === 'string' ? v.window : '' };
    case 'spawn_failed':
      return { outcome: 'spawn_failed', message: typeof v.message === 'string' ? v.message : '' };
    default:
      return null;
  }
}

/** A `report.json` read back from disk, or null when it is not one. */
export function parseMarker(json: unknown): ReportMarker | null {
  if (!isRecord(json)) return null;
  const result = parseResult(json.result);
  if (typeof json.session_id !== 'string' || typeof json.dir !== 'string' || result === null) return null;
  return {
    session_id: json.session_id,
    dir: json.dir,
    reported_at: typeof json.reported_at === 'string' ? json.reported_at : '',
    complete: json.complete === true,
    prompt: typeof json.prompt === 'string' ? json.prompt : `${REPORT_SKILL} ${json.dir}`,
    page: parsePage(json.page),
    result,
  };
}

/** Every marker under `reportsDir`, by session id. A missing folder or a broken marker is skipped. */
export async function readMarkers(reportsDir: string): Promise<Map<string, ReportMarker>> {
  const out = new Map<string, ReportMarker>();
  let entries: string[];
  try {
    entries = (await readdir(reportsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return out;
  }
  for (const name of entries.sort()) {
    let marker: ReportMarker | null;
    try {
      marker = parseMarker(JSON.parse(await readFile(path.join(reportsDir, name, REPORT_MARKER), 'utf8')) as unknown);
    } catch {
      continue;
    }
    if (marker === null) continue;
    const known = out.get(marker.session_id);
    // An opened report wins over one that was only saved.
    if (known === undefined || (known.result.outcome !== 'opened' && marker.result.outcome === 'opened')) out.set(marker.session_id, marker);
  }
  return out;
}

async function writeMarker(marker: ReportMarker): Promise<void> {
  const file = path.join(marker.dir, REPORT_MARKER);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

export class StreamReporter {
  private readonly opts: StreamReporterOptions;
  private markers: Promise<Map<string, ReportMarker>> | null = null;
  private readonly inflight = new Map<string, Promise<ReportOutcome>>();
  private windowDeps: ClaudeWindowDeps | null = null;

  constructor(opts: StreamReporterOptions) {
    this.opts = opts;
  }

  /**
   * One click of the report button for `sessionId`, with the page's own log (null when the caller
   * sent none). A click while another for the same session is running waits for it and answers
   * `already_reported` with its folder (or its failure when it made no folder).
   */
  async report(sessionId: string, page: PageReport | null): Promise<ReportOutcome> {
    if (!SESSION_ID_PATTERN.test(sessionId)) return UNKNOWN;
    const running = this.inflight.get(sessionId);
    if (running !== undefined) {
      const first = await running;
      return 'dir' in first.body ? { status: 409, body: { error: 'already_reported', dir: first.body.dir } } : first;
    }
    const work = this.run(sessionId, page);
    this.inflight.set(sessionId, work);
    try {
      return await work;
    } finally {
      this.inflight.delete(sessionId);
    }
  }

  private loadMarkers(): Promise<Map<string, ReportMarker>> {
    this.markers ??= readMarkers(this.opts.reportsDir);
    return this.markers;
  }

  private deps(): ClaudeWindowDeps {
    this.windowDeps ??= typeof this.opts.window === 'function' ? this.opts.window() : this.opts.window;
    return this.windowDeps;
  }

  private async run(sessionId: string, page: PageReport | null): Promise<ReportOutcome> {
    const markers = await this.loadMarkers();
    const known = markers.get(sessionId);
    if (known !== undefined) {
      if (known.result.outcome === 'opened' || known.result.outcome === 'pending') {
        return { status: 409, body: { error: 'already_reported', dir: known.dir } };
      }
      // Saved but never opened (no tmux, or claude could not start): open it now, on the same folder.
      return this.open(known, markers);
    }
    // An ended session is still reported from the page's own log; with nothing from the page there is nothing to report.
    if (!this.opts.isLive(sessionId) && page === null) return UNKNOWN;
    let snap: EvidenceSnapshot;
    try {
      snap = await this.opts.evidence.snapshot(sessionId);
    } catch (err) {
      return { status: 500, body: { error: 'snapshot_failed', message: messageOf(err) } };
    }
    const marker: ReportMarker = {
      session_id: sessionId,
      dir: snap.dir,
      reported_at: (this.opts.now?.() ?? new Date()).toISOString(),
      complete: snap.complete,
      prompt: `${REPORT_SKILL} ${snap.dir}`,
      page,
      result: { outcome: 'pending' },
    };
    try {
      await writeMarker(marker);
    } catch (err) {
      return { status: 500, body: { error: 'snapshot_failed', message: `the report marker could not be written: ${messageOf(err)}` } };
    }
    markers.set(sessionId, marker);
    return this.open(marker, markers);
  }

  private async open(marker: ReportMarker, markers: Map<string, ReportMarker>): Promise<ReportOutcome> {
    const { dir, complete } = marker;
    const settle = async (result: MarkerResult, outcome: ReportOutcome): Promise<ReportOutcome> => {
      const next: ReportMarker = { ...marker, result };
      markers.set(marker.session_id, next);
      try {
        await writeMarker(next);
      } catch (err) {
        // Remembered in memory either way; only a restart could forget it.
        console.error(`[notesd] stream report: could not update ${path.join(dir, REPORT_MARKER)}: ${messageOf(err)}`);
      }
      return outcome;
    };
    const deps = this.deps();
    const session = await pickTmuxSession(deps);
    if (session === null) return settle({ outcome: 'no_tmux' }, { status: 409, body: { error: 'no_tmux', dir, complete } });
    if (!(await (this.opts.canRun ?? executable)(deps.claudeBin))) {
      const message = `the claude binary "${deps.claudeBin}" cannot be run (NOTESD_CLAUDE_BIN)`;
      return settle({ outcome: 'spawn_failed', message }, { status: 500, body: { error: 'spawn_failed', dir, message, complete } });
    }
    try {
      const created = await openClaudeWindow(deps, session, this.opts.cwd, reportWindowName(marker.session_id), [
        '--permission-mode',
        REPORT_PERMISSION_MODE,
        ...promptArgs(marker.prompt),
      ]);
      return settle({ outcome: 'opened', window: created.window }, { status: 200, body: { ok: true, dir, window: created.window, complete } });
    } catch (err) {
      const message = messageOf(err);
      return settle({ outcome: 'spawn_failed', message }, { status: 500, body: { error: 'spawn_failed', dir, message, complete } });
    }
  }
}
