import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { ccSessionPromptImages, ccSessionPrompts, chatImages } from '../../src/db/schema.js'
import { EMBEDDING_DIMENSIONS } from '../../src/embeddings/constants.js'
import { NODE_ID_PATTERN } from '../../src/sessions/ids.js'
import { SessionsRepo } from '../../src/sessions/repo.js'
import { PROMPTS_VERSION, SELECTED_PROJECT_KEY, type SubagentTranscriptPatch, type TranscriptPatch } from '../../src/sessions/types.js'
import { makeImage } from './imageHarness.js'
import { closeTestDb, openTestDb, truncateAll } from './setup.js'

const HOST = 'host-a'
const T0 = new Date('2026-11-01T10:00:00.000Z')

function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * 60_000)
}

function cycle(values: number[]): (max: number) => number {
  let i = 0
  return () => values[i++ % values.length]!
}

function patch(sessionId: string, over: Partial<TranscriptPatch> = {}): TranscriptPatch {
  return {
    sessionId,
    host: HOST,
    transcriptPath: `/home/u/.claude/projects/p/${sessionId}.jsonl`,
    fromOffset: 0,
    toOffset: 100,
    size: 100,
    ...over,
  }
}

function subPatch(over: Partial<SubagentTranscriptPatch> = {}): SubagentTranscriptPatch {
  return {
    sessionId: 's-1',
    agentId: 'a1',
    host: HOST,
    transcriptPath: '/home/u/.claude/projects/p/s-1/subagents/agent-a1.jsonl',
    fromOffset: 0,
    toOffset: 50,
    size: 50,
    ...over,
  }
}

describe('SessionsRepo', () => {
  let db: Db
  let repo: SessionsRepo

  beforeAll(() => {
    db = openTestDb()
  })
  afterAll(async () => {
    await closeTestDb(db)
  })
  beforeEach(async () => {
    await truncateAll(db)
    repo = new SessionsRepo(db)
  })

  describe('node ids', () => {
    it('assigns a node id once and keeps it', async () => {
      const a = await repo.ensureSession('s-1', HOST)
      expect(a.nodeId).toMatch(NODE_ID_PATTERN)
      const b = await repo.ensureSession('s-1', 'other-host')
      expect(b.nodeId).toBe(a.nodeId)
      expect(b.host).toBe(HOST)
    })

    it('redraws on a node id clash', async () => {
      const first = new SessionsRepo(db, { random: () => 10 })
      expect((await first.ensureSession('s-1', HOST)).nodeId).toBe('AA-AA')
      const second = new SessionsRepo(db, { random: cycle([10, 10, 10, 10, 11, 11, 11, 11]) })
      expect((await second.ensureSession('s-2', HOST)).nodeId).toBe('BB-BB')
    })

    it('gives up when every draw clashes', async () => {
      const stuck = new SessionsRepo(db, { random: () => 10 })
      await stuck.ensureSession('s-1', HOST)
      await expect(stuck.ensureSession('s-2', HOST)).rejects.toThrow(/free node id/)
    })

    it('rejects a blank session id', async () => {
      await expect(repo.ensureSession('', HOST)).rejects.toThrow(TypeError)
    })

    it('finds rows by node id in any case, with or without the dash', async () => {
      const fixed = new SessionsRepo(db, { random: cycle([10, 0, 3, 16]) })
      await fixed.ensureSession('s-1', HOST)
      expect((await repo.getByNodeId('a03g'))?.sessionId).toBe('s-1')
      expect((await repo.getByNodeId('A0-3G'))?.sessionId).toBe('s-1')
      expect(await repo.getByNodeId('ZZ-ZZ')).toBeNull()
      expect(await repo.getByNodeId('not an id')).toBeNull()
      const many = await repo.getManyByNodeIds(['a0-3g', 'ZZ-ZZ', 'A03G', 'junk'])
      expect(many.map((r) => r.sessionId)).toEqual(['s-1'])
    })
  })

  describe('transcript upserts', () => {
    it('creates the row, applies an append once, and ignores a replay', async () => {
      const first = await repo.upsertFromTranscript(
        patch('s-1', {
          cwd: '/home/u/mcp-notes',
          repo: 'mcp-notes',
          branch: 'main',
          entrypoint: 'cli',
          version: '2.1.0',
          startedAt: at(0),
          lastActiveAt: at(1),
          firstPrompt: 'hello',
          lastPrompt: 'hello',
          tokens: { inputTokens: 10, outputTokens: 5 },
          models: { 'claude-opus': { inputTokens: 10, outputTokens: 5 } },
          prompts: [{ text: 'hello', at: at(0).toISOString() }],
          filesEdited: ['src/a.ts'],
        }),
      )
      expect(first.applied).toBe(true)
      expect(first.row.nodeId).toMatch(NODE_ID_PATTERN)
      expect(first.row.transcriptOffset).toBe(100)

      const append = patch('s-1', {
        fromOffset: 100,
        toOffset: 250,
        size: 250,
        lastActiveAt: at(5),
        firstPrompt: 'second',
        lastPrompt: 'second',
        tokens: { inputTokens: 3 },
        models: { 'claude-opus': { inputTokens: 3 } },
        prompts: [{ text: 'second', at: null }],
        filesEdited: ['src/a.ts', 'src/b.ts'],
        commits: [{ sha: 'abc1234', subject: 'feat: x', at: null }],
        costUsd: 0.42,
      })
      const second = await repo.upsertFromTranscript(append)
      expect(second.applied).toBe(true)
      expect(second.row).toMatchObject({ transcriptOffset: 250, transcriptSize: 250 })
      const stored = (await repo.getBySessionId('s-1'))!
      expect(stored).toMatchObject({
        transcriptOffset: 250,
        transcriptSize: 250,
        inputTokens: 13,
        outputTokens: 5,
        firstPrompt: 'hello',
        lastPrompt: 'second',
        filesEdited: ['src/a.ts', 'src/b.ts'],
        commits: [{ sha: 'abc1234', subject: 'feat: x', at: null }],
        startedAt: at(0),
        lastActiveAt: at(5),
        costUsd: 0.42,
      })
      expect(stored.prompts.map((p) => p.text)).toEqual(['hello', 'second'])
      expect(stored.models['claude-opus']?.inputTokens).toBe(13)

      const replay = await repo.upsertFromTranscript(append)
      expect(replay).toMatchObject({ applied: false, reason: 'offset_mismatch', storedOffset: 250 })
      expect((await repo.getBySessionId('s-1'))?.inputTokens).toBe(13)
    })

    it('a patch from offset 0 replaces the accumulators', async () => {
      await repo.upsertFromTranscript(patch('s-1', { tokens: { inputTokens: 50 }, prompts: [{ text: 'a', at: null }] }))
      const again = await repo.upsertFromTranscript(patch('s-1', { tokens: { inputTokens: 50 }, prompts: [{ text: 'a', at: null }] }))
      expect(again.applied).toBe(true)
      const stored = (await repo.getBySessionId('s-1'))!
      expect(stored.inputTokens).toBe(50)
      expect(stored.prompts).toHaveLength(1)
    })

    it('keeps the hook-reported name and tmux when the transcript has none', async () => {
      await repo.upsertFromHook({ sessionId: 's-1', host: HOST, name: 'impl-x-p1', tmux: 'note:@0.%7', cwd: '/w' })
      await repo.upsertFromTranscript(patch('s-1', { name: null, cwd: '/w', entrypoint: 'cli' }))
      expect(await repo.getBySessionId('s-1')).toMatchObject({ name: 'impl-x-p1', tmux: 'note:@0.%7', cwd: '/w' })
    })

    it('refuses a patch for a row held by another host', async () => {
      await repo.ensureSession('s-1', 'host-b')
      const r = await repo.upsertFromTranscript(patch('s-1'))
      expect(r).toMatchObject({ applied: false, reason: 'other_host' })
    })

    it('rejects inconsistent offsets', async () => {
      await expect(repo.upsertFromTranscript(patch('s-1', { fromOffset: 50, toOffset: 10 }))).rejects.toThrow(RangeError)
      await expect(repo.upsertFromTranscript(patch('s-1', { fromOffset: -1 }))).rejects.toThrow(RangeError)
    })

    it('lists offsets for one host only', async () => {
      await repo.upsertFromTranscript(patch('s-1', { toOffset: 40, size: 40 }))
      await repo.upsertFromTranscript(patch('s-2', { host: 'host-b' }))
      const offsets = await repo.offsets(HOST)
      expect([...offsets.keys()]).toEqual(['s-1'])
      expect(offsets.get('s-1')).toEqual({ offset: 40, size: 40, path: '/home/u/.claude/projects/p/s-1.jsonl' })
    })
  })

  describe('subagent transcripts', () => {
    const commit = (sha: string, minute: number) => ({ sha, subject: `c ${sha}`, at: at(minute).toISOString() })

    it('adds a subagent read to its parent, with its own offset and compare-and-set', async () => {
      expect(await repo.upsertFromSubagentTranscript(subPatch())).toMatchObject({ applied: false, reason: 'no_session' })
      await repo.upsertFromTranscript(patch('s-1', { tokens: { inputTokens: 10, outputTokens: 20 }, commits: [commit('aaa1111', 0)] }))
      const r = await repo.upsertFromSubagentTranscript(
        subPatch({
          tokens: { outputTokens: 5, cacheReadTokens: 100 },
          models: { 'claude-haiku-5-5': { outputTokens: 5, cacheReadTokens: 100 } },
          commits: [commit('bbb2222', 3)],
          lastActiveAt: at(30),
        }),
      )
      expect(r).toEqual({ applied: true })
      const row = await repo.getBySessionId('s-1')
      expect(row).toMatchObject({ inputTokens: 10, outputTokens: 25, cacheReadTokens: 100 })
      expect(row?.commits.map((c) => c.sha)).toEqual(['aaa1111', 'bbb2222'])
      expect(row?.models['claude-haiku-5-5']).toEqual({ inputTokens: 0, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0 })
      expect(row?.lastActiveAt?.toISOString()).toBe(at(30).toISOString())
      expect(await repo.subagentOffsets(HOST)).toEqual(new Map([[subPatch().transcriptPath, 50]]))

      // A stale replay changes nothing; the right offset applies.
      expect(await repo.upsertFromSubagentTranscript(subPatch({ fromOffset: 10, toOffset: 60 }))).toMatchObject({ reason: 'offset_mismatch', storedOffset: 50 })
      await repo.upsertFromSubagentTranscript(subPatch({ fromOffset: 50, toOffset: 80, size: 80, tokens: { outputTokens: 1 } }))
      expect((await repo.getBySessionId('s-1'))?.outputTokens).toBe(26)
    })

    it('a subagent re-read from 0 takes its old share out of the parent first', async () => {
      await repo.upsertFromTranscript(patch('s-1', { tokens: { outputTokens: 20 } }))
      await repo.upsertFromSubagentTranscript(subPatch({ tokens: { outputTokens: 5 }, models: { m: { outputTokens: 5 } } }))
      await repo.upsertFromSubagentTranscript(subPatch({ toOffset: 30, size: 30, tokens: { outputTokens: 2 }, models: { m: { outputTokens: 2 } } }))
      const row = await repo.getBySessionId('s-1')
      expect(row?.outputTokens).toBe(22)
      expect(row?.models.m?.outputTokens).toBe(2)
    })

    it("the main transcript re-read from 0 keeps the subagents' share", async () => {
      await repo.upsertFromTranscript(patch('s-1', { tokens: { outputTokens: 20 }, commits: [commit('aaa1111', 0)] }))
      await repo.upsertFromSubagentTranscript(subPatch({ tokens: { outputTokens: 5 }, commits: [commit('bbb2222', 3)] }))
      await repo.upsertFromTranscript(patch('s-1', { tokens: { outputTokens: 21 }, commits: [commit('aaa1111', 0)] }))
      const row = await repo.getBySessionId('s-1')
      expect(row?.outputTokens).toBe(26)
      expect(row?.commits.map((c) => c.sha)).toEqual(['aaa1111', 'bbb2222'])
    })

    it("refuses another host's session", async () => {
      await repo.upsertFromTranscript(patch('s-1', { host: 'host-b' }))
      expect(await repo.upsertFromSubagentTranscript(subPatch())).toMatchObject({ applied: false, reason: 'other_host' })
    })
  })

  describe('parent links', () => {
    it('honours env > hook > heuristic', async () => {
      for (const id of ['c', 'p1', 'p2', 'p3']) await repo.ensureSession(id, HOST)
      expect(await repo.setParent('c', 'p1', 'heuristic')).toBe('set')
      expect(await repo.setParent('c', 'p2', 'hook')).toBe('set')
      expect(await repo.setParent('c', 'p3', 'heuristic')).toBe('kept')
      expect(await repo.setParent('c', 'p3', 'env')).toBe('set')
      expect(await repo.setParent('c', 'p1', 'hook')).toBe('kept')
      expect(await repo.getBySessionId('c')).toMatchObject({ parentSessionId: 'p3', parentLinkSource: 'env' })
    })

    it('ranks fork above env, hook and heuristic', async () => {
      for (const id of ['c', 'p1', 'p2', 'p3']) await repo.ensureSession(id, HOST)
      expect(await repo.setParent('c', 'p1', 'env')).toBe('set')
      expect(await repo.setParent('c', 'p2', 'fork')).toBe('set')
      for (const source of ['env', 'hook', 'heuristic'] as const) {
        expect(await repo.setParent('c', 'p3', source), source).toBe('kept')
      }
      expect(await repo.getBySessionId('c')).toMatchObject({ parentSessionId: 'p2', parentLinkSource: 'fork' })
    })

    it('a fork link replaces a hook or heuristic link, and a later fork link refines it', async () => {
      for (const id of ['c1', 'c2', 'p1', 'p2', 'p3']) await repo.ensureSession(id, HOST)
      await repo.setParent('c1', 'p1', 'hook')
      await repo.setParent('c2', 'p1', 'heuristic')
      expect(await repo.setParent('c1', 'p2', 'fork')).toBe('set')
      expect(await repo.setParent('c2', 'p2', 'fork')).toBe('set')
      expect(await repo.setParent('c1', 'p3', 'fork')).toBe('set')
      expect(await repo.getBySessionId('c1')).toMatchObject({ parentSessionId: 'p3', parentLinkSource: 'fork' })
      expect(await repo.getBySessionId('c2')).toMatchObject({ parentSessionId: 'p2', parentLinkSource: 'fork' })
    })

    it('the SessionStart hook keeps a fork link', async () => {
      for (const id of ['c', 'p1']) await repo.ensureSession(id, HOST)
      await repo.setParent('c', 'p1', 'fork')
      const res = await repo.upsertFromHook({ sessionId: 'c', host: HOST, parentSessionId: 'p2' })
      expect(res.parentLink).toBe('kept')
      expect(res.session).toMatchObject({ parentSessionId: 'p1', parentLinkSource: 'fork' })
    })

    it('lets an equal-rank heuristic link be refined', async () => {
      for (const id of ['c', 'p1', 'p2']) await repo.ensureSession(id, HOST)
      await repo.setParent('c', 'p1', 'heuristic')
      expect(await repo.setParent('c', 'p2', 'heuristic')).toBe('set')
    })

    it('refuses self links, cycles and missing children', async () => {
      await repo.ensureSession('a', HOST)
      await repo.ensureSession('b', HOST)
      expect(await repo.setParent('b', 'a', 'env')).toBe('set')
      expect(await repo.setParent('a', 'b', 'env')).toBe('cycle')
      expect(await repo.setParent('a', 'a', 'env')).toBe('self')
      expect(await repo.setParent('nope', 'a', 'env')).toBe('missing')
    })

    it('upsertFromHook links an env parent and returns both rows', async () => {
      const res = await repo.upsertFromHook({
        sessionId: 'child',
        host: HOST,
        cwd: '/w',
        name: 'impl-x-p2',
        tmux: 'note:@1.%2',
        startedAt: at(0),
        parentSessionId: 'parent',
      })
      expect(res.parentLink).toBe('set')
      expect(res.parent?.nodeId).toMatch(NODE_ID_PATTERN)
      expect(res.session).toMatchObject({ parentSessionId: 'parent', parentLinkSource: 'env', name: 'impl-x-p2', startedAt: at(0) })
      expect((await repo.listChildren('parent')).map((c) => c.sessionId)).toEqual(['child'])
    })

    it('upsertFromHook without a parent leaves the link alone', async () => {
      const res = await repo.upsertFromHook({ sessionId: 's-1', host: HOST })
      expect(res).toMatchObject({ parent: null, parentLink: null })
      expect(res.session.parentSessionId).toBeNull()
    })
  })

  describe('pending spawns', () => {
    it('a child claims a matching spawn once, within the window', async () => {
      await repo.ensureSession('parent', HOST)
      await repo.recordPendingSpawn({ parentSessionId: 'parent', host: HOST, cwd: '/w/repo/', name: 'helper', createdAt: at(0) })
      expect(await repo.claimPendingSpawn({ childSessionId: 'other', host: HOST, cwd: '/elsewhere', at: at(0.1) })).toBeNull()
      expect(await repo.claimPendingSpawn({ childSessionId: 'other', host: 'host-b', cwd: '/w/repo', at: at(0.1) })).toBeNull()
      const claim = await repo.claimPendingSpawn({ childSessionId: 'child', host: HOST, cwd: '/w/repo', name: 'helper', at: at(0.2) })
      expect(claim?.spawn.claimedBy).toBe('child')
      expect(claim?.parentLink).toBe('set')
      expect(await repo.getBySessionId('child')).toMatchObject({ parentSessionId: 'parent', parentLinkSource: 'hook' })
      expect(await repo.claimPendingSpawn({ childSessionId: 'child2', host: HOST, cwd: '/w/repo', at: at(0.3) })).toBeNull()
    })

    it('ignores a spawn older than the window', async () => {
      await repo.recordPendingSpawn({ parentSessionId: 'parent', host: HOST, cwd: '/w', createdAt: at(0) })
      expect(await repo.claimPendingSpawn({ childSessionId: 'child', host: HOST, cwd: '/w', at: at(1) })).toBeNull()
    })

    it('prefers the spawn whose name matches', async () => {
      await repo.recordPendingSpawn({ parentSessionId: 'p-named', host: HOST, cwd: '/w', name: 'helper', createdAt: at(0) })
      await repo.recordPendingSpawn({ parentSessionId: 'p-anon', host: HOST, cwd: '/w', createdAt: at(0.05) })
      const claim = await repo.claimPendingSpawn({ childSessionId: 'child', host: HOST, cwd: '/w', name: 'helper', at: at(0.1) })
      expect(claim?.spawn.parentSessionId).toBe('p-named')
    })

    it('a hook claim does not replace an env link', async () => {
      await repo.upsertFromHook({ sessionId: 'child', host: HOST, parentSessionId: 'env-parent' })
      await repo.recordPendingSpawn({ parentSessionId: 'other', host: HOST, cwd: '/w', createdAt: at(0) })
      const claim = await repo.claimPendingSpawn({ childSessionId: 'child', host: HOST, cwd: '/w', at: at(0.1) })
      expect(claim?.parentLink).toBe('kept')
      expect((await repo.getBySessionId('child'))?.parentSessionId).toBe('env-parent')
    })

    it('prunes old spawns', async () => {
      await repo.recordPendingSpawn({ parentSessionId: 'p', host: HOST, cwd: '/w', createdAt: at(0) })
      await repo.recordPendingSpawn({ parentSessionId: 'p', host: HOST, cwd: '/w', createdAt: at(60) })
      expect(await repo.prunePendingSpawns(at(30))).toBe(1)
    })
  })

  describe('listings', () => {
    it('lists projects and sessions newest first, terminal sessions only', async () => {
      await repo.upsertFromTranscript(patch('s1', { repo: 'mcp-notes', entrypoint: 'cli', startedAt: at(0) }))
      await repo.upsertFromTranscript(patch('s2', { host: 'host-b', repo: 'mcp-notes', entrypoint: 'cli', startedAt: at(10) }))
      await repo.upsertFromTranscript(patch('s3', { repo: 'seer', entrypoint: 'cli', startedAt: at(5) }))
      await repo.upsertFromTranscript(patch('s4', { repo: 'mcp-notes', entrypoint: 'sdk-ts', startedAt: at(20) }))

      const projects = await repo.listProjects()
      expect(projects).toEqual([
        { repo: 'mcp-notes', sessionCount: 2, lastActiveAt: at(10), hosts: ['host-a', 'host-b'] },
        { repo: 'seer', sessionCount: 1, lastActiveAt: at(5), hosts: ['host-a'] },
      ])
      expect((await repo.listForRepo('mcp-notes')).map((s) => s.sessionId)).toEqual(['s2', 's1'])
      expect((await repo.listForRepo('mcp-notes', { limit: 1 })).map((s) => s.sessionId)).toEqual(['s2'])
      expect((await repo.listForRepo('mcp-notes', { before: at(10) })).map((s) => s.sessionId)).toEqual(['s1'])
    })

    it('finds sessions by name within a time range', async () => {
      await repo.upsertFromTranscript(patch('old', { name: 'impl-x-p1', entrypoint: 'cli', startedAt: at(0) }))
      await repo.upsertFromTranscript(patch('new', { name: 'impl-x-p1', entrypoint: 'cli', startedAt: at(120) }))
      expect((await repo.listByName('impl-x-p1')).map((s) => s.sessionId)).toEqual(['old', 'new'])
      expect((await repo.listByName('impl-x-p1', { from: at(60), to: at(180) })).map((s) => s.sessionId)).toEqual(['new'])
    })
  })

  describe('summaries and embeddings', () => {
    it('setSummary stores the summary and feeds full text', async () => {
      await repo.ensureSession('s-1', HOST)
      expect(await repo.setSummary('s-1', { summary: 'Fixed the wall photo delete bug', sha: 'abc', at: at(3) })).toBe(true)
      expect(await repo.setSummary('missing', { summary: 'x', sha: 'y' })).toBe(false)
      expect(await repo.getBySessionId('s-1')).toMatchObject({ summary: 'Fixed the wall photo delete bug', summarySha: 'abc', summarizedAt: at(3) })
      const hit = await db.execute<{ session_id: string }>(
        sql`select session_id from cc_sessions where search_tsv @@ plainto_tsquery('simple', 'photo delete')`,
      )
      expect(hit.rows.map((r) => r.session_id)).toEqual(['s-1'])
    })

    it('saves vectors and records failures with backoff', async () => {
      await repo.ensureSession('s-1', HOST)
      const v = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0))
      expect(await repo.saveEmbedding('s-1', { sha: 'h1', model: 'm', embedding: v, textVersion: 1 })).toBe(true)
      expect(
        (await db.execute<{ text_version: number }>(sql`select text_version from cc_session_embeddings where session_id = 's-1'`)).rows[0],
      ).toEqual({ text_version: 1 })
      expect(await repo.saveEmbedding('missing', { sha: 'h1', model: 'm', embedding: v, textVersion: 1 })).toBe(false)
      await expect(repo.saveEmbedding('s-1', { sha: 'h1', model: 'm', embedding: [1, 2], textVersion: 1 })).rejects.toThrow(/dimensions/)

      await repo.recordEmbeddingFailure('s-1', { sha: 'h1', model: 'm', error: 'boom' })
      let row = await db.execute<{ sha: string; attempts: number; has_vector: boolean }>(
        sql`select sha, attempts, embedding is not null as has_vector from cc_session_embeddings where session_id = 's-1'`,
      )
      expect(row.rows[0]).toEqual({ sha: 'h1', attempts: 0, has_vector: true })

      await repo.recordEmbeddingFailure('s-1', { sha: 'h2', model: 'm', error: 'boom' })
      await repo.recordEmbeddingFailure('s-1', { sha: 'h2', model: 'm', error: 'boom again' })
      row = await db.execute<{ sha: string; attempts: number; has_vector: boolean }>(
        sql`select sha, attempts, embedding is not null as has_vector from cc_session_embeddings where session_id = 's-1'`,
      )
      expect(row.rows[0]).toEqual({ sha: 'h2', attempts: 2, has_vector: false })
    })
  })

  describe('summary requests', () => {
    function clockedRepo(start: Date): { repo: SessionsRepo; set: (d: Date) => void } {
      let clock = start
      return { repo: new SessionsRepo(db, { now: () => clock }), set: (d) => { clock = d } }
    }

    it('records the first request time and keeps it on repeat requests', async () => {
      const c = clockedRepo(at(0))
      await c.repo.ensureSession('s-1', HOST)
      c.set(at(5))
      expect(await c.repo.requestSummary('s-1')).toEqual({ requestedAt: at(5) })
      c.set(at(9))
      expect(await c.repo.requestSummary('s-1')).toEqual({ requestedAt: at(5) })
      const row = await c.repo.getBySessionId('s-1')
      expect(row?.summaryRequestedAt).toEqual(at(5))
      expect(row?.updatedAt).toEqual(at(5))
    })

    it('returns null for a session with no row and creates none', async () => {
      expect(await repo.requestSummary('missing')).toBeNull()
      expect(await repo.getBySessionId('missing')).toBeNull()
    })

    it('changes nothing but the request columns', async () => {
      const c = clockedRepo(at(0))
      await c.repo.upsertFromTranscript(
        patch('s-1', { repo: 'mcp-notes', entrypoint: 'cli', firstPrompt: 'why does resume break', tokens: { inputTokens: 40 }, lastActiveAt: at(1) }),
      )
      await c.repo.setSummary('s-1', { summary: 'Fixed resume', sha: 'h1', at: at(2) })
      const before = await c.repo.getBySessionId('s-1')
      c.set(at(7))
      await c.repo.requestSummary('s-1')
      const after = await c.repo.getBySessionId('s-1')
      expect(after).toEqual({ ...before, summaryRequestedAt: at(7), updatedAt: at(7) })
      // The byte-0 upsert marked the prompts current (phase 3); the request leaves the version alone.
      expect(after?.promptsVersion).toBe(PROMPTS_VERSION)
    })

    it('setSummary clears a pending request', async () => {
      const c = clockedRepo(at(0))
      await c.repo.ensureSession('s-1', HOST)
      await c.repo.requestSummary('s-1')
      c.set(at(3))
      expect(await c.repo.setSummary('s-1', { summary: 'Summary so far', sha: 'h2' })).toBe(true)
      expect(await c.repo.getBySessionId('s-1')).toMatchObject({ summary: 'Summary so far', summarizedAt: at(3), summaryRequestedAt: null })
    })

    it('clearSummaryRequest drops a pending request and reports whether there was one', async () => {
      const c = clockedRepo(at(0))
      await c.repo.ensureSession('s-1', HOST)
      expect(await c.repo.clearSummaryRequest('s-1')).toBe(false)
      await c.repo.requestSummary('s-1')
      c.set(at(4))
      expect(await c.repo.clearSummaryRequest('s-1')).toBe(true)
      const row = await c.repo.getBySessionId('s-1')
      expect(row?.summaryRequestedAt).toBeNull()
      expect(row?.updatedAt).toEqual(at(4))
      expect(await c.repo.clearSummaryRequest('s-1')).toBe(false)
      expect(await c.repo.clearSummaryRequest('missing')).toBe(false)
      c.set(at(6))
      expect(await c.repo.requestSummary('s-1')).toEqual({ requestedAt: at(6) })
    })

    it('a request on another host\'s session is stored as is (the owning host serves it)', async () => {
      await repo.ensureSession('s-gpd', 'GPD')
      const req = await repo.requestSummary('s-gpd')
      expect(req?.requestedAt).toBeInstanceOf(Date)
      expect((await repo.getBySessionId('s-gpd'))?.host).toBe('GPD')
    })
  })

  describe('settings', () => {
    it('stores, reads and clears values', async () => {
      expect(await repo.getSelectedProject()).toBeNull()
      await repo.setSelectedProject('mcp-notes')
      expect(await repo.getSelectedProject()).toBe('mcp-notes')
      expect(await repo.getSetting(SELECTED_PROJECT_KEY)).toBe('mcp-notes')
      await repo.putSetting('x', { a: 1 })
      expect(await repo.getSetting('x')).toEqual({ a: 1 })
      await repo.setSelectedProject(null)
      expect(await repo.getSelectedProject()).toBeNull()
      await repo.putSetting('x', null)
      expect(await repo.getSetting('x')).toBeNull()
    })
  })

  describe('pasted-image prompts', () => {
    let dataDir: string
    let imageRepo: SessionsRepo

    beforeEach(async () => {
      dataDir = await mkdtemp(path.join(os.tmpdir(), 'notes-session-images-'))
      imageRepo = new SessionsRepo(db, { dataDir, hostname: () => HOST })
    })
    afterEach(async () => {
      await rm(dataDir, { recursive: true, force: true })
    })

    async function png(rgb: { r: number; g: number; b: number }): Promise<string> {
      return (await makeImage('png', 4, 4, rgb)).toString('base64')
    }

    it('stores a pasted image as a chat_images row and links it to its prompt', async () => {
      const data = await png({ r: 10, g: 20, b: 30 })
      await imageRepo.upsertFromTranscript(
        patch('s-img', { prompts: [{ text: 'look at this', at: null, images: [{ mediaType: 'image/png', dataBase64: data, pasteId: 1 }] }] }),
      )
      const links = await db.select().from(ccSessionPromptImages).where(eq(ccSessionPromptImages.sessionId, 's-img'))
      expect(links).toHaveLength(1)
      expect(links[0]).toMatchObject({ promptSeq: 1, position: 0, pasteId: 1 })
      const [image] = await db.select().from(chatImages).where(eq(chatImages.id, links[0]!.imageId))
      expect(image).toMatchObject({ source: 'claude_code', host: HOST, mime: 'image/png', width: 4, height: 4 })
    })

    it('dedupes identical bytes pasted into two different prompts, by sha256', async () => {
      const data = await png({ r: 1, g: 2, b: 3 })
      await imageRepo.upsertFromTranscript(patch('s-img-a', { prompts: [{ text: 'first', at: null, images: [{ mediaType: 'image/png', dataBase64: data, pasteId: 1 }] }] }))
      await imageRepo.upsertFromTranscript(patch('s-img-b', { prompts: [{ text: 'second', at: null, images: [{ mediaType: 'image/png', dataBase64: data, pasteId: 1 }] }] }))
      const a = await db.select().from(ccSessionPromptImages).where(eq(ccSessionPromptImages.sessionId, 's-img-a'))
      const b = await db.select().from(ccSessionPromptImages).where(eq(ccSessionPromptImages.sessionId, 's-img-b'))
      expect(a[0]!.imageId).toBe(b[0]!.imageId)
      expect(await db.select().from(chatImages)).toHaveLength(1)
    })

    it('relinks (not duplicates) an image when a from-byte-0 replace rewrites the same prompt', async () => {
      const data = await png({ r: 4, g: 5, b: 6 })
      const prompts = [{ text: 'again', at: null, images: [{ mediaType: 'image/png', dataBase64: data, pasteId: 1 }] }]
      await imageRepo.upsertFromTranscript(patch('s-img-replace', { prompts }))
      await imageRepo.upsertFromTranscript(patch('s-img-replace', { fromOffset: 0, prompts }))
      const links = await db.select().from(ccSessionPromptImages).where(eq(ccSessionPromptImages.sessionId, 's-img-replace'))
      expect(links).toHaveLength(1)
      expect(await db.select().from(chatImages)).toHaveLength(1)
    })

    it('drops a corrupt pasted image but keeps the prompt text', async () => {
      await imageRepo.upsertFromTranscript(
        patch('s-img-bad', { prompts: [{ text: 'broken paste', at: null, images: [{ mediaType: 'image/png', dataBase64: 'not-an-image', pasteId: 1 }] }] }),
      )
      expect(await db.select().from(ccSessionPromptImages).where(eq(ccSessionPromptImages.sessionId, 's-img-bad'))).toEqual([])
      const rows = await db.select().from(ccSessionPrompts).where(eq(ccSessionPrompts.sessionId, 's-img-bad'))
      expect(rows[0]?.text).toBe('broken paste')
    })

    it('a SessionsRepo with no dataDir drops images silently (text still stored)', async () => {
      const data = await png({ r: 7, g: 8, b: 9 })
      await repo.upsertFromTranscript(patch('s-img-nodeps', { prompts: [{ text: 'no deps', at: null, images: [{ mediaType: 'image/png', dataBase64: data, pasteId: 1 }] }] }))
      expect(await db.select().from(ccSessionPromptImages).where(eq(ccSessionPromptImages.sessionId, 's-img-nodeps'))).toEqual([])
      const rows = await db.select().from(ccSessionPrompts).where(eq(ccSessionPrompts.sessionId, 's-img-nodeps'))
      expect(rows[0]?.text).toBe('no deps')
    })
  })
})
