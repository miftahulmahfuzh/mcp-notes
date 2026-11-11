/**
 * Fork detection primitives: filesystem reads only, no database, nothing written.
 *
 * A Claude Code fork (`claude --resume X --fork-session` in a terminal, or a background job that
 * Claude Code starts with `--fork-session --resume <claudeHome>/jobs/<short>/parent-transcript.jsonl`)
 * gets a new session id and a transcript that begins with a copy of its parent's conversation:
 * the copied records keep their `uuid`, `parentUuid`, `timestamp`, `message.id` and usage, with
 * `sessionId` and `cwd` rewritten. Records without a uuid (`ai-title`, `agent-name`, `mode`, ...)
 * are written for the fork itself and are never part of the copy.
 *
 * `jobStateFor` reads a background fork's parent from its job record. Without one,
 * `rankForkCandidates` picks the parent among sessions that share the fork's `headUuid`.
 * `findForkCut` finds where the copy ends. src/sessions/ingest.ts (Phase 2) composes them. A
 * missing file is a normal answer (null, or the candidate is skipped); any other I/O error is
 * thrown for the caller to degrade to "not a fork".
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { isHumanPrompt, isObject, parseRecord, readJsonlFrom, type TranscriptRecord } from './transcript.js';
import type { ForkInfo } from './types.js';

/** A background job's directory is `<claudeHome>/jobs/<this many leading characters of its session id>`. */
export const JOB_SHORT_ID_CHARS = 8;

/** The session id shape the SessionStart hook route accepts; it also keeps the job path inside `jobs/`. */
const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z-]{7,99}$/;

/** What a background fork's `<claudeHome>/jobs/<short>/state.json` says about where it came from. */
export interface ForkJobState {
  parentSessionId: string;
  /** `forkBoundaryAt`: the timestamp of the last copied record; null when absent or unparsable. */
  boundaryAt: Date | null;
  /** `daemonShort`, else the job directory's name: what `claude attach <jobId>` takes. */
  jobId: string;
  /** `<job dir>/parent-transcript.jsonl`, the parent snapshot the fork was resumed from; null when gone. */
  parentTranscript: string | null;
}

/**
 * Which of a fork's uuid records are copies: those whose uuid is in the set, or those stamped at
 * or before `boundaryAt`, or (both given) either. Pass both when a job gives a boundary: the
 * parent's own transcript can lack a record the snapshot copied (measured on JM-UJ: its last copied
 * record, an away_summary stamped exactly at forkBoundaryAt, is not in DM-OV's transcript).
 */
export type CopiedEvidence = ReadonlySet<string> | { boundaryAt: Date; uuids?: ReadonlySet<string> };

/** Where a fork's copy ends (fields as in ForkInfo). `copiedRecords` 0: the file is not a fork of that evidence. */
export type ForkCut = Pick<ForkInfo, 'cutOffset' | 'final' | 'forkedAt' | 'promptCount'> & { copiedRecords: number };

/** A session that may be a fork's parent: one on the same host with the same head uuid. */
export interface ForkCandidate {
  sessionId: string;
  transcriptPath: string;
  /** The candidate's own start (after its own cut, when it is a fork). Earlier wins a tie. */
  startedAt: Date | null;
  /** The candidate is itself a known fork (its row has fork_detected_by). It loses a tie to one that is not. */
  isFork: boolean;
}

export interface RankedForkCandidate extends ForkCandidate {
  /** How many of the fork's leading uuid records, in file order, the candidate's transcript holds. */
  sharedUuids: number;
}

function isMissing(err: unknown): boolean {
  const code = isObject(err) ? err.code : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function uuidOf(record: TranscriptRecord): string | null {
  return typeof record.uuid === 'string' && record.uuid !== '' ? record.uuid : null;
}

function timeOf(record: TranscriptRecord): number | null {
  if (typeof record.timestamp !== 'string') return null;
  const ms = Date.parse(record.timestamp);
  return Number.isFinite(ms) ? ms : null;
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

/**
 * Reads `file` from byte `start` and hands each parsed record (transcript.ts parseRecord: blank,
 * torn and ignored-type lines are skipped) to `onRecord` with the byte offset its line starts at.
 * Returning 'stop' ends the read. Offsets are readJsonlFrom's raw byte `lineStart`, so a stored
 * `fork_cut_offset` and every reader that compares a record's position with it (`isCopiedRecord`)
 * agree byte for byte, whatever the bytes. Resolves to the offset just past the last complete line
 * read (readJsonlFrom's endOffset). Throws what open/read throw (ENOENT for a missing file).
 */
export async function readRecordsWithOffsets(
  file: string,
  start: number,
  onRecord: (record: TranscriptRecord, offset: number) => 'stop' | void,
): Promise<number> {
  let stopped = false;
  const { endOffset } = await readJsonlFrom(
    file,
    start,
    (line, lineStart) => {
      if (stopped) return;
      const record = parseRecord(line);
      if (record !== null && onRecord(record, lineStart) === 'stop') stopped = true;
    },
    { shouldStop: () => stopped },
  );
  return endOffset;
}

/**
 * The fork record of `sessionId`'s background job, `<claudeHome>/jobs/<first 8 chars>/state.json`,
 * or null when there is none: no job directory, unreadable or partial JSON (Claude Code rewrites
 * the file while the job runs), a state that names another session, or no `forkParentSessionId`
 * (a background job that is not a fork).
 */
export async function jobStateFor(claudeHome: string, sessionId: string): Promise<ForkJobState | null> {
  if (!SESSION_ID.test(sessionId)) return null;
  const dir = path.join(claudeHome, 'jobs', sessionId.slice(0, JOB_SHORT_ID_CHARS));
  let text: string;
  try {
    text = await readFile(path.join(dir, 'state.json'), 'utf8');
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  let state: unknown;
  try {
    state = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(state)) return null;
  if (state.sessionId !== sessionId && state.forkSessionId !== sessionId) return null;
  const parent = state.forkParentSessionId;
  if (typeof parent !== 'string' || !SESSION_ID.test(parent) || parent === sessionId) return null;
  const boundaryMs = typeof state.forkBoundaryAt === 'string' ? Date.parse(state.forkBoundaryAt) : Number.NaN;
  const jobId = typeof state.daemonShort === 'string' && state.daemonShort !== '' ? state.daemonShort : path.basename(dir);
  const snapshot = path.join(dir, 'parent-transcript.jsonl');
  return {
    parentSessionId: parent,
    boundaryAt: Number.isFinite(boundaryMs) ? new Date(boundaryMs) : null,
    jobId,
    parentTranscript: (await isFile(snapshot)) ? snapshot : null,
  };
}

/** The uuid of the transcript's first record that has one; null for a missing file or one without uuids. */
export async function headUuid(file: string): Promise<string | null> {
  let head = null as string | null;
  try {
    await readRecordsWithOffsets(file, 0, (record) => {
      head = uuidOf(record);
      if (head !== null) return 'stop';
    });
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  return head;
}

/** Every record uuid in the transcript, in file order; null when the file is missing. */
async function readUuids(file: string): Promise<string[] | null> {
  const out: string[] = [];
  try {
    await readRecordsWithOffsets(file, 0, (record) => {
      const uuid = uuidOf(record);
      if (uuid !== null) out.push(uuid);
    });
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  return out;
}

/** Every record uuid in the transcript; null when the file is missing. */
export async function readUuidSet(file: string): Promise<Set<string> | null> {
  const uuids = await readUuids(file);
  return uuids === null ? null : new Set(uuids);
}

/**
 * Where the copied prefix of fork transcript `file` ends. Reads from byte 0. The cut is the offset
 * of the first record that has a uuid and is not a copy by `copied`; it is `final`. When every
 * uuid record read is a copy, the cut is the end of the last complete line and not final (the
 * fork has written nothing of its own yet). Records without a uuid never decide the cut.
 * `forkedAt`: the boundary when given, else the latest copied timestamp (copied timestamps are not
 * strictly ordered). `promptCount`: human prompts (transcript.ts isHumanPrompt) among the copies.
 * Throws ENOENT when `file` is missing.
 */
export async function findForkCut(file: string, copied: CopiedEvidence): Promise<ForkCut> {
  let uuids: ReadonlySet<string> | null;
  let boundaryMs: number | null;
  if ('boundaryAt' in copied) {
    uuids = copied.uuids ?? null;
    const ms = copied.boundaryAt.getTime();
    boundaryMs = Number.isFinite(ms) ? ms : null;
  } else {
    uuids = copied;
    boundaryMs = null;
  }
  let cutOffset = null as number | null;
  let lastCopiedMs = null as number | null;
  let copiedRecords = 0;
  let promptCount = 0;
  const endOffset = await readRecordsWithOffsets(file, 0, (record, offset) => {
    const uuid = uuidOf(record);
    if (uuid === null) return;
    const ms = timeOf(record);
    const isCopy = uuids?.has(uuid) === true || (boundaryMs !== null && ms !== null && ms <= boundaryMs);
    if (!isCopy) {
      cutOffset = offset;
      return 'stop';
    }
    copiedRecords += 1;
    if (isHumanPrompt(record)) promptCount += 1;
    if (ms !== null && (lastCopiedMs === null || ms > lastCopiedMs)) lastCopiedMs = ms;
  });
  const forkedMs = boundaryMs ?? lastCopiedMs;
  return {
    cutOffset: cutOffset ?? endOffset,
    final: cutOffset !== null,
    forkedAt: forkedMs === null ? null : new Date(forkedMs),
    promptCount,
    copiedRecords,
  };
}

function compareCandidates(a: RankedForkCandidate, b: RankedForkCandidate): number {
  if (a.sharedUuids !== b.sharedUuids) return b.sharedUuids - a.sharedUuids;
  if (a.isFork !== b.isFork) return a.isFork ? 1 : -1;
  const at = a.startedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bt = b.startedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (at !== bt) return at - bt;
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}

/**
 * Candidate parents of fork transcript `forkFile`, best first: by the number of the fork's leading
 * uuid records (in order, until the first one it lacks) each candidate's transcript holds; on a
 * tie a candidate that is not itself a fork first, then the earliest `startedAt`, then the session
 * id. A fork of a fork thus goes to the fork it was copied from (it holds the uuids the original
 * lacks), and a fork made before its source wrote anything of its own goes to the original.
 * Candidates sharing nothing, with a missing transcript, or whose transcript is `forkFile` itself
 * are left out. Empty when `forkFile` is missing or has no uuid records. Callers must not pass
 * known descendants of the fork: a later fork of this fork holds this fork's own records too and
 * would outrank the real parent.
 */
export async function rankForkCandidates(forkFile: string, candidates: readonly ForkCandidate[]): Promise<RankedForkCandidate[]> {
  const leading = await readUuids(forkFile);
  if (leading === null || leading.length === 0) return [];
  const self = path.resolve(forkFile);
  const ranked: RankedForkCandidate[] = [];
  for (const candidate of candidates) {
    if (path.resolve(candidate.transcriptPath) === self) continue;
    const held = await readUuidSet(candidate.transcriptPath);
    if (held === null) continue;
    let shared = 0;
    while (shared < leading.length && held.has(leading[shared]!)) shared += 1;
    if (shared > 0) ranked.push({ ...candidate, sharedUuids: shared });
  }
  return ranked.sort(compareCandidates);
}
