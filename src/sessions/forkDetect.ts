/**
 * Fork detection for one transcript read from byte 0, composed from the src/sessions/fork.ts
 * primitives. The tail ingester runs it before every read from byte 0 (ingest.ts readFile, through
 * `scanForkSafely`), and the one-time fork backfill (Phase 3) runs it the same way.
 *
 * Evidence, best first:
 * 1. A background job's `<claudeHome>/jobs/<short>/state.json` names the parent (`jobStateFor`).
 *    The copy is the uuids of the job's parent snapshot (else of the parent row's own transcript)
 *    together with the job's `forkBoundaryAt` when it has one: `job`. The boundary alone when no
 *    uuid set is readable: `time`. With neither, the fork is linked with nothing cut.
 * 2. No job: the rows of this host whose transcript begins with the same uuid
 *    (`IngestStore.forkCandidates`, which already leaves out this session's descendants and rows
 *    created after it), ranked by the longest copied prefix (`rankForkCandidates`). The winner's
 *    uuid set gives the cut: `uuid`. A fork of a fork thus goes to the fork it was copied from.
 * A file with no uuid record yet, or no candidate sharing its head, is not a fork. Anything that
 * throws after the head uuid was read comes back as `error` with `fork: null`.
 */
import { findForkCut, headUuid as readHeadUuid, jobStateFor, rankForkCandidates, readUuidSet, type CopiedEvidence, type ForkJobState } from './fork.js';
import type { ForkCandidateRow, ForkDetectedBy, ForkInfo } from './types.js';

/** What a scan of one transcript found. `fork` null: not a fork, or not determinable (`error` says which). */
export interface ForkScan {
  /** uuid of the file's first record that has one; null when it has none yet. */
  headUuid: string | null;
  fork: ForkInfo | null;
  /** Why detection gave up after reading the head uuid; null when it did not. */
  error: string | null;
}

export interface ForkScanDeps {
  /** `config.sessions.claudeHome`: job records are under `<claudeHome>/jobs`. */
  claudeHome: string;
  /** This machine (`os.hostname()`): candidates are rows of this host only. */
  host: string;
  /** SessionsRepo.forkCandidates. Absent: only job state can find a fork. */
  forkCandidates?: (host: string, headUuid: string, excludeSessionId: string) => Promise<ForkCandidateRow[]>;
}

/**
 * True while a fork's cut is not final: the read (or the stored offset) reaches no further than
 * the cut, so no record of the fork's own has been read past it. Such a fork is read from byte 0
 * again on its next change.
 */
export function isPendingCut(cutOffset: number, readTo: number): boolean {
  return readTo <= cutOffset;
}

/** Fork detection for `file`, the transcript of `sessionId`. Throws only if reading the head uuid throws. */
export async function scanFork(file: string, sessionId: string, deps: ForkScanDeps): Promise<ForkScan> {
  const head = await readHeadUuid(file);
  if (head === null) return { headUuid: null, fork: null, error: null };
  try {
    const candidates = deps.forkCandidates === undefined ? [] : await deps.forkCandidates(deps.host, head, sessionId);
    const job = await jobStateFor(deps.claudeHome, sessionId);
    const fork =
      job !== null && job.parentSessionId.toLowerCase() !== sessionId
        ? await jobFork(file, job, candidates)
        : await uuidFork(file, candidates);
    return { headUuid: head, fork, error: null };
  } catch (err) {
    return { headUuid: head, fork: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** A background fork: the job names the parent; the copy is the parent's uuids, the boundary, or both. */
async function jobFork(file: string, job: ForkJobState, candidates: readonly ForkCandidateRow[]): Promise<ForkInfo> {
  const parentSessionId = job.parentSessionId.toLowerCase();
  const parentFile = job.parentTranscript ?? candidates.find((c) => c.sessionId === parentSessionId)?.transcriptPath ?? null;
  const uuids = parentFile === null ? null : await readUuidSet(parentFile);
  let evidence: CopiedEvidence;
  let detectedBy: ForkDetectedBy = 'job';
  if (job.boundaryAt !== null) {
    evidence = uuids === null ? { boundaryAt: job.boundaryAt } : { boundaryAt: job.boundaryAt, uuids };
    if (uuids === null) detectedBy = 'time';
  } else {
    // No boundary and no readable parent: nothing is known to be copied, so nothing is cut.
    evidence = uuids ?? new Set<string>();
  }
  const cut = await findForkCut(file, evidence);
  return {
    parentSessionId,
    detectedBy,
    cutOffset: cut.cutOffset,
    final: cut.final,
    forkedAt: job.boundaryAt ?? cut.forkedAt,
    promptCount: cut.promptCount,
  };
}

/** No job: the candidate sharing the longest copied prefix is the parent. Null when none shares anything. */
async function uuidFork(file: string, candidates: readonly ForkCandidateRow[]): Promise<ForkInfo | null> {
  if (candidates.length === 0) return null;
  const ranked = await rankForkCandidates(
    file,
    candidates.map((c) => ({ sessionId: c.sessionId, transcriptPath: c.transcriptPath, startedAt: c.startedAt, isFork: c.forkDetectedBy !== null })),
  );
  const best = ranked[0];
  if (best === undefined) return null;
  const copied = await readUuidSet(best.transcriptPath);
  if (copied === null) return null;
  const cut = await findForkCut(file, copied);
  if (cut.copiedRecords === 0) return null;
  return {
    parentSessionId: best.sessionId,
    detectedBy: 'uuid',
    cutOffset: cut.cutOffset,
    final: cut.final,
    forkedAt: cut.forkedAt,
    promptCount: cut.promptCount,
  };
}
