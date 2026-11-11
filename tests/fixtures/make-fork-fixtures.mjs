#!/usr/bin/env node
// Writes tests/fixtures/claude-home-forks: a parent session and its forks, shaped like Claude Code
// 2.1.3xx forks as measured on 2026-11-11 (fork JM-UJ of DM-OV): a fork's transcript starts with
// records written for it without a uuid (ai-title, agent-name, mode), then a copy of the parent's
// conversation (same uuid, parentUuid, timestamp, message.id and usage; sessionId rewritten), then
// its own records. A background fork also has <home>/jobs/<first 8 of its id>/state.json and
// parent-transcript.jsonl. Deterministic: rerun it and `git diff` shows nothing. Constants are
// mirrored in tests/helpers/forkFixtures.ts.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-home-forks');
const DIR = '-home-u-mcp-notes';
const CWD = '/home/u/mcp-notes';
const SID = {
  parent: 'f0a0a001-0000-4000-8000-000000000001',
  job: 'f0b0b001-0000-4000-8000-000000000002',
  terminal: 'f0c0c001-0000-4000-8000-000000000003',
  forkOfFork: 'f0d0d001-0000-4000-8000-000000000004',
  pending: 'f0f0f001-0000-4000-8000-000000000005',
  unrelated: 'f0e0e001-0000-4000-8000-000000000006',
};
const BOUNDARY = '2026-11-01T01:05:05.000Z';
const PARENT_MODEL = 'claude-haiku-4-5';
const FORK_MODEL = 'claude-opus-5-5';
const PLAN = '/home/u/mcp-notes/docs/plans/fork-plan.md';

const uuid = (series, n) => `${series}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const usage = (input, output, cacheRead = 0, cacheWrite = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
});

function prompt(id, parent, at, text) {
  return { type: 'user', uuid: id, parentUuid: parent, timestamp: at, message: { role: 'user', content: text } };
}
function reply(id, parent, at, msgId, model, text, use, before = []) {
  return {
    type: 'assistant',
    uuid: id,
    parentUuid: parent,
    timestamp: at,
    message: { id: msgId, type: 'message', model, role: 'assistant', content: [...before, { type: 'text', text }], usage: use },
  };
}
function commitCall(id, parent, at, msgId, model, toolId, use) {
  return {
    type: 'assistant',
    uuid: id,
    parentUuid: parent,
    timestamp: at,
    message: {
      id: msgId,
      type: 'message',
      model,
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command: 'git commit -m "x"' } }],
      usage: use,
    },
  };
}
function commitResult(id, parent, at, toolId, sha, subject) {
  const out = `[main ${sha}] ${subject}\n 1 file changed, 1 insertion(+)`;
  return {
    type: 'user',
    uuid: id,
    parentUuid: parent,
    timestamp: at,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: out }] },
    toolUseResult: { stdout: out, stderr: '', interrupted: false },
  };
}

const P = 'a1';
const parentBefore = [
  prompt(uuid(P, 1), null, '2026-11-01T01:00:00.000Z', 'parent prompt one: build the fork fixture'),
  commitCall(uuid(P, 2), uuid(P, 1), '2026-11-01T01:00:05.000Z', 'msg_p1', PARENT_MODEL, 'toolu_p1', usage(100, 10, 1000, 50)),
  commitResult(uuid(P, 3), uuid(P, 2), '2026-11-01T01:00:06.000Z', 'toolu_p1', 'a1b2c3d', 'feat: parent work before the fork'),
  reply(uuid(P, 4), uuid(P, 3), '2026-11-01T01:00:10.000Z', 'msg_p2', PARENT_MODEL, 'Parent reply one.', usage(200, 20, 2000, 0), [
    { type: 'tool_use', id: 'toolu_p2', name: 'Edit', input: { file_path: PLAN, old_string: 'a', new_string: 'b' } },
  ]),
  prompt(uuid(P, 5), uuid(P, 4), '2026-11-01T01:05:00.000Z', 'parent prompt two: wrap up'),
  reply(uuid(P, 6), uuid(P, 5), BOUNDARY, 'msg_p3', PARENT_MODEL, 'Parent reply two.', usage(300, 30)),
];
const parentAfter = [
  prompt(uuid(P, 7), uuid(P, 6), '2026-11-01T02:00:00.000Z', 'parent prompt three: after the fork'),
  reply(uuid(P, 8), uuid(P, 7), '2026-11-01T02:00:05.000Z', 'msg_p4', PARENT_MODEL, 'Parent reply three.', usage(400, 40)),
];
const jobOwn = [
  prompt(uuid('b2', 1), uuid(P, 6), '2026-11-01T01:20:00.000Z', 'job fork prompt: try the other approach'),
  commitCall(uuid('b2', 2), uuid('b2', 1), '2026-11-01T01:20:05.000Z', 'msg_j1', FORK_MODEL, 'toolu_j1', usage(60, 6)),
  commitResult(uuid('b2', 3), uuid('b2', 2), '2026-11-01T01:20:06.000Z', 'toolu_j1', '0d0e0f1', 'fix: job fork work'),
  reply(uuid('b2', 4), uuid('b2', 3), '2026-11-01T01:20:10.000Z', 'msg_j2', FORK_MODEL, 'Job fork reply.', usage(70, 7)),
];
const terminalOwn = [
  prompt(uuid('c3', 1), uuid(P, 6), '2026-11-01T01:30:00.000Z', 'terminal fork prompt: compare the two'),
  reply(uuid('c3', 2), uuid('c3', 1), '2026-11-01T01:30:05.000Z', 'msg_t1', FORK_MODEL, 'Terminal fork reply.', usage(50, 5)),
];
const forkOfForkOwn = [
  prompt(uuid('d4', 1), uuid('c3', 2), '2026-11-01T01:40:00.000Z', 'fork of a fork prompt: go deeper'),
  reply(uuid('d4', 2), uuid('d4', 1), '2026-11-01T01:40:05.000Z', 'msg_ff1', FORK_MODEL, 'Fork of a fork reply.', usage(7, 7)),
];
const pendingOwn = [
  prompt(uuid('e5', 1), uuid(P, 6), '2026-11-01T01:50:00.000Z', 'pending fork prompt: now it has its own work'),
  reply(uuid('e5', 2), uuid('e5', 1), '2026-11-01T01:50:05.000Z', 'msg_e1', FORK_MODEL, 'Pending fork reply.', usage(11, 1)),
];
const unrelated = [
  prompt(uuid('f6', 1), null, '2026-11-01T03:00:00.000Z', 'unrelated session prompt'),
  reply(uuid('f6', 2), uuid('f6', 1), '2026-11-01T03:00:05.000Z', 'msg_u1', FORK_MODEL, 'Unrelated reply.', usage(9, 9)),
];

const envelope = (sessionId, record) => ({
  parentUuid: null,
  isSidechain: false,
  userType: 'external',
  cwd: CWD,
  sessionId,
  version: '2.1.311',
  gitBranch: 'main',
  entrypoint: 'cli',
  ...record,
});
const stamp = (sessionId, chain) => chain.map((record) => envelope(sessionId, record));
const lines = (records) => records.map((r) => `${JSON.stringify(r)}\n`).join('');
const forkHead = (sessionId) => [
  { type: 'ai-title', aiTitle: 'fork-parent ⑂', sessionId },
  { type: 'agent-name', agentName: 'fork-parent ⑂', sessionId },
  { type: 'mode', mode: 'normal', sessionId },
];
const parentTitle = { type: 'custom-title', customTitle: 'fork-parent', sessionId: SID.parent };

function write(rel, text) {
  const file = path.join(ROOT, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}
const transcript = (sid) => `projects/${DIR}/${sid}.jsonl`;

rmSync(ROOT, { recursive: true, force: true });
write(transcript(SID.parent), lines([parentTitle, ...stamp(SID.parent, [...parentBefore, ...parentAfter])]));
write(transcript(SID.job), lines([...forkHead(SID.job), ...stamp(SID.job, [...parentBefore, ...jobOwn])]));
write(transcript(SID.terminal), lines(stamp(SID.terminal, [...parentBefore, ...terminalOwn])));
write(transcript(SID.forkOfFork), lines(stamp(SID.forkOfFork, [...parentBefore, ...terminalOwn, ...forkOfForkOwn])));
write(transcript(SID.pending), lines([...forkHead(SID.pending), ...stamp(SID.pending, parentBefore)]));
write(transcript(SID.unrelated), lines(stamp(SID.unrelated, unrelated)));
// Not under projects/: tests and the verify drive append it to the pending fork's transcript.
write(`appends/${SID.pending}.own.jsonl`, lines(stamp(SID.pending, pendingOwn)));

const jobState = (sid) => ({
  state: 'working',
  template: 'bg',
  forkSourceAlive: true,
  forkBoundaryAt: BOUNDARY,
  forkSessionId: sid,
  forkParentSessionId: SID.parent,
  interactiveLineage: true,
  intent: '(forked)',
  name: 'fork-parent ⑂',
  nameSource: 'auto',
  sessionId: sid,
  resumeSessionId: sid,
  daemonShort: sid.slice(0, 8),
  cwd: CWD,
  createdAt: '2026-11-01T01:10:00.000Z',
  updatedAt: '2026-11-01T01:10:01.000Z',
  backend: 'daemon',
});
for (const sid of [SID.job, SID.pending]) {
  write(`jobs/${sid.slice(0, 8)}/state.json`, `${JSON.stringify(jobState(sid), null, 2)}\n`);
  write(`jobs/${sid.slice(0, 8)}/parent-transcript.jsonl`, lines([parentTitle, ...stamp(SID.parent, parentBefore)]));
}
// A job record Claude Code was in the middle of rewriting: unreadable, so not evidence of anything.
write(`jobs/${SID.unrelated.slice(0, 8)}/state.json`, '{"state": "work\n');
