import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findForkCut,
  headUuid,
  jobStateFor,
  rankForkCandidates,
  readRecordsWithOffsets,
  readUuidSet,
  type ForkCandidate,
} from '../../../src/sessions/fork.js';

// Shaped like fork JM-UJ (e3650501-...) of DM-OV (662d31f3-...), measured 2026-11-11.
const PARENT = '662d31f3-8b12-4345-b9d6-f6fd48caa493';
const FORK = 'e3650501-2a9d-432a-b2c0-f2aeff23fdf8';
const FORK2 = 'f2f2f2f2-0000-4000-8000-000000000002';
const FORK3 = 'f3f3f3f3-0000-4000-8000-000000000003';
const BOUNDARY = '2026-11-11T01:37:02.342Z';

type Rec = Record<string, unknown>;

const prompt = (uuid: string, text: string, timestamp: string): Rec => ({
  type: 'user',
  uuid,
  timestamp,
  entrypoint: 'cli',
  message: { role: 'user', content: text },
});
const reply = (uuid: string, id: string, timestamp: string): Rec => ({
  type: 'assistant',
  uuid,
  timestamp,
  message: { id, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 5 } },
});
const toolResult = (uuid: string, timestamp: string): Rec => ({
  type: 'user',
  uuid,
  timestamp,
  toolUseResult: { stdout: 'd1b23dc phase 2' },
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'd1b23dc phase 2' }] },
});
const attachment = (uuid: string, timestamp: string): Rec => ({ type: 'attachment', uuid, timestamp });

/** The parent's chain as the fork copied it. u6/u7 are 1 ms out of order, as measured. */
const CHAIN: Rec[] = [
  attachment('u1', '2026-11-11T01:30:00.264Z'),
  prompt('u2', 'plan phase 2 ⑂ ünïcode', '2026-11-11T01:30:00.443Z'),
  reply('u3', 'm1', '2026-11-11T01:30:05.000Z'),
  toolResult('u4', '2026-11-11T01:30:06.000Z'),
  prompt('u5', 'now commit it', '2026-11-11T01:33:44.184Z'),
  attachment('u6', '2026-11-11T01:33:50.876Z'),
  reply('u7', 'm2', '2026-11-11T01:33:50.875Z'),
];
/** Copied last, stamped at forkBoundaryAt; in the job snapshot and the fork, not in the parent's own file. */
const AWAY: Rec = { type: 'system', subtype: 'away_summary', uuid: 'u8', timestamp: BOUNDARY };
const FORK_HEAD: Rec[] = [
  { type: 'ai-title', aiTitle: 'orch ⑂' },
  { type: 'agent-name', agentName: 'orch-ears ⑂' },
  { type: 'mode', mode: 'normal' },
  { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-11-11T01:53:37.485Z' },
];
const FORK_OWN: Rec[] = [
  attachment('o1', '2026-11-11T01:53:35.583Z'),
  prompt('o2', 'continue from the fork', '2026-11-11T01:53:37.903Z'),
  reply('o3', 'm3', '2026-11-11T01:53:40.000Z'),
];
const PARENT_LATER: Rec[] = [prompt('p1', 'parent goes on', '2026-11-11T01:40:00.000Z'), reply('p2', 'm9', '2026-11-11T01:40:05.000Z')];

const jsonl = (records: Rec[], sessionId: string): string => records.map((r) => `${JSON.stringify({ ...r, sessionId })}\n`).join('');
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');
const at = (iso: string): Date => new Date(iso);
const cand = (sessionId: string, transcriptPath: string, startedAt: string | null, isFork = false): ForkCandidate => ({
  sessionId,
  transcriptPath,
  startedAt: startedAt === null ? null : at(startedAt),
  isFork,
});

describe('fork primitives', () => {
  let home: string;
  let parentFile: string;
  let forkFile: string;
  let snapshotFile: string;
  const forkText = jsonl([...FORK_HEAD, ...CHAIN, AWAY, ...FORK_OWN], FORK);
  const ownStart = bytes(jsonl([...FORK_HEAD, ...CHAIN, AWAY], FORK));
  const awayStart = bytes(jsonl([...FORK_HEAD, ...CHAIN], FORK));

  const write = async (file: string, text: string): Promise<string> => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
    return file;
  };
  const jobState = (over: Rec = {}): string =>
    JSON.stringify({
      state: 'working',
      template: 'bg',
      forkSourceAlive: true,
      forkBoundaryAt: BOUNDARY,
      forkSessionId: FORK,
      forkParentSessionId: PARENT,
      intent: '(forked)',
      name: 'orch-ears-acceptance-criteria ⑂',
      sessionId: FORK,
      resumeSessionId: FORK,
      daemonShort: 'e3650501',
      cwd: '/home/u/claude-commands',
      backend: 'daemon',
      ...over,
    });

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'notes-fork-'));
    parentFile = await write(
      path.join(home, 'projects', '-w-parent', `${PARENT}.jsonl`),
      jsonl([{ type: 'custom-title', customTitle: 'orch' }, ...CHAIN, ...PARENT_LATER], PARENT),
    );
    forkFile = await write(path.join(home, 'projects', '-w-fork', `${FORK}.jsonl`), forkText);
    snapshotFile = await write(path.join(home, 'jobs', 'e3650501', 'parent-transcript.jsonl'), jsonl([...CHAIN, AWAY], PARENT));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  describe('readRecordsWithOffsets', () => {
    it('hands each record with the byte offset its line starts at, multi-byte text included', async () => {
      const seen: Array<[unknown, number]> = [];
      await readRecordsWithOffsets(forkFile, 0, (record, offset) => {
        seen.push([record.uuid ?? record.type, offset]);
      });
      const raw = await readFile(forkFile);
      for (const [, offset] of seen) expect(offset === 0 || raw[offset - 1] === 0x0a).toBe(true);
      expect(seen.find(([id]) => id === 'o1')?.[1]).toBe(ownStart);
    });

    it('stops when asked', async () => {
      const seen: unknown[] = [];
      await readRecordsWithOffsets(forkFile, 0, (record) => {
        seen.push(record.type);
        if (record.type === 'agent-name') return 'stop';
      });
      expect(seen).toEqual(['ai-title', 'agent-name']);
    });
  });

  describe('headUuid', () => {
    it('is shared by a fork and its parent', async () => {
      expect(await headUuid(forkFile)).toBe('u1');
      expect(await headUuid(parentFile)).toBe('u1');
    });

    it('is null for a missing file or one without uuids', async () => {
      expect(await headUuid(path.join(home, 'nope.jsonl'))).toBeNull();
      const bare = await write(path.join(home, 'bare.jsonl'), jsonl(FORK_HEAD, FORK));
      expect(await headUuid(bare)).toBeNull();
    });
  });

  describe('readUuidSet', () => {
    it('holds every uuid of the transcript', async () => {
      expect(await readUuidSet(parentFile)).toEqual(new Set(['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'p1', 'p2']));
    });

    it('is null for a missing file', async () => {
      expect(await readUuidSet(path.join(home, 'nope.jsonl'))).toBeNull();
    });
  });

  describe('findForkCut', () => {
    it("cuts at the fork's first own record with the job snapshot's uuids", async () => {
      const cut = await findForkCut(forkFile, (await readUuidSet(snapshotFile))!);
      expect(cut).toEqual({ cutOffset: ownStart, final: true, forkedAt: at(BOUNDARY), promptCount: 2, copiedRecords: 8 });
      const rest = (await readFile(forkFile)).subarray(cut.cutOffset).toString('utf8');
      expect(rest.startsWith(JSON.stringify({ ...FORK_OWN[0], sessionId: FORK }))).toBe(true);
    });

    it("stops one record early with only the parent's own uuids, and dates the fork by the latest copy", async () => {
      const cut = await findForkCut(forkFile, (await readUuidSet(parentFile))!);
      expect(cut).toEqual({ cutOffset: awayStart, final: true, forkedAt: at('2026-11-11T01:33:50.876Z'), promptCount: 2, copiedRecords: 7 });
    });

    it("the job's boundary closes that gap, with or without a uuid set", async () => {
      const parentUuids = (await readUuidSet(parentFile))!;
      const both = await findForkCut(forkFile, { boundaryAt: at(BOUNDARY), uuids: parentUuids });
      const timeOnly = await findForkCut(forkFile, { boundaryAt: at(BOUNDARY) });
      for (const cut of [both, timeOnly]) {
        expect(cut).toEqual({ cutOffset: ownStart, final: true, forkedAt: at(BOUNDARY), promptCount: 2, copiedRecords: 8 });
      }
    });

    it('is pending while the fork holds only copies, a torn last line included', async () => {
      const copyOnly = jsonl([...FORK_HEAD, ...CHAIN, AWAY], FORK);
      const file = await write(path.join(home, 'projects', '-w-fork', 'pending.jsonl'), `${copyOnly}{"type":"attachment","uuid":"o1`);
      const cut = await findForkCut(file, (await readUuidSet(snapshotFile))!);
      expect(cut).toEqual({ cutOffset: bytes(copyOnly), final: false, forkedAt: at('2026-11-11T01:37:02.342Z'), promptCount: 2, copiedRecords: 8 });
    });

    it('copies nothing for a transcript that shares no uuid', async () => {
      const cut = await findForkCut(forkFile, new Set<string>());
      expect(cut).toMatchObject({ cutOffset: bytes(jsonl(FORK_HEAD, FORK)), final: true, forkedAt: null, promptCount: 0, copiedRecords: 0 });
    });
  });

  describe('jobStateFor', () => {
    const stateFile = (): string => path.join(home, 'jobs', 'e3650501', 'state.json');

    it("reads a background fork's parent, boundary, job id and snapshot", async () => {
      await write(stateFile(), jobState());
      expect(await jobStateFor(home, FORK)).toEqual({
        parentSessionId: PARENT,
        boundaryAt: at(BOUNDARY),
        jobId: 'e3650501',
        parentTranscript: snapshotFile,
      });
    });

    it('reports a gone snapshot and an unreadable boundary as null', async () => {
      await rm(snapshotFile);
      await write(stateFile(), jobState({ forkBoundaryAt: 'not a time' }));
      expect(await jobStateFor(home, FORK)).toMatchObject({ parentSessionId: PARENT, boundaryAt: null, parentTranscript: null });
    });

    it('is null without a job, for another session, for a non-fork job, for torn JSON and for a bad id', async () => {
      expect(await jobStateFor(home, FORK)).toBeNull();
      await write(stateFile(), jobState({ sessionId: FORK2, forkSessionId: FORK2 }));
      expect(await jobStateFor(home, FORK)).toBeNull();
      await write(stateFile(), jobState({ forkParentSessionId: undefined }));
      expect(await jobStateFor(home, FORK)).toBeNull();
      await write(stateFile(), '{"state":"working","forkParentSess');
      expect(await jobStateFor(home, FORK)).toBeNull();
      expect(await jobStateFor(home, '../../etc/passwd')).toBeNull();
    });
  });

  describe('rankForkCandidates', () => {
    it('picks the session holding the longest copied prefix and drops the rest', async () => {
      const unrelated = await write(path.join(home, 'projects', '-w-x', 'x.jsonl'), jsonl([prompt('z1', 'other', '2026-11-11T00:00:00.000Z')], 'x'));
      const ranked = await rankForkCandidates(forkFile, [
        cand('unrelated-0001', unrelated, '2026-11-11T00:00:00.000Z'),
        cand(PARENT, parentFile, '2026-11-11T01:30:00.264Z'),
        cand('gone-00000001', path.join(home, 'gone.jsonl'), null),
        cand(FORK, forkFile, '2026-11-11T01:53:35.583Z', true),
      ]);
      expect(ranked.map((c) => [c.sessionId, c.sharedUuids])).toEqual([[PARENT, 7]]);
    });

    it('links a fork of a fork to the fork it was copied from', async () => {
      const fork2 = await write(
        path.join(home, 'projects', '-w-fork2', `${FORK2}.jsonl`),
        jsonl([...FORK_HEAD, ...CHAIN, AWAY, ...FORK_OWN, prompt('q1', 'fork two', '2026-11-11T02:10:00.000Z')], FORK2),
      );
      const ranked = await rankForkCandidates(fork2, [
        cand(PARENT, parentFile, '2026-11-11T01:30:00.264Z'),
        cand(FORK, forkFile, '2026-11-11T01:53:35.583Z', true),
      ]);
      expect(ranked.map((c) => [c.sessionId, c.sharedUuids])).toEqual([
        [FORK, 11],
        [PARENT, 7],
      ]);
    });

    it('on a tie prefers a candidate that is not a fork, then the earliest start', async () => {
      const fork3 = await write(
        path.join(home, 'projects', '-w-fork3', `${FORK3}.jsonl`),
        jsonl([...FORK_HEAD, ...CHAIN, prompt('q1', 'fork three', '2026-11-11T02:20:00.000Z')], FORK3),
      );
      const byForkFlag = await rankForkCandidates(fork3, [
        cand(FORK, forkFile, '2026-11-11T01:00:00.000Z', true),
        cand(PARENT, parentFile, '2026-11-11T01:30:00.264Z'),
      ]);
      expect(byForkFlag.map((c) => c.sessionId)).toEqual([PARENT, FORK]);
      const byStart = await rankForkCandidates(fork3, [
        cand('later-000001', parentFile, '2026-11-11T01:31:00.000Z'),
        cand('undated-0001', parentFile, null),
        cand('earlier-00001', parentFile, '2026-11-11T01:30:00.000Z'),
      ]);
      expect(byStart.map((c) => c.sessionId)).toEqual(['earlier-00001', 'later-000001', 'undated-0001']);
    });

    it('is empty for a missing fork file', async () => {
      expect(await rankForkCandidates(path.join(home, 'nope.jsonl'), [cand(PARENT, parentFile, null)])).toEqual([]);
    });
  });
});
