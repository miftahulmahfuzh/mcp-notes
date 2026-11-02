import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { EMBEDDING_DIMENSIONS } from '../../src/embeddings/constants.js'
import { NODE_ID_PATTERN } from '../../src/sessions/ids.js'
import { SessionsRepo } from '../../src/sessions/repo.js'
import { SELECTED_PROJECT_KEY, type TranscriptPatch } from '../../src/sessions/types.js'
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
      expect(second.row).toMatchObject({
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
      expect(second.row.prompts.map((p) => p.text)).toEqual(['hello', 'second'])
      expect(second.row.models['claude-opus']?.inputTokens).toBe(13)

      const replay = await repo.upsertFromTranscript(append)
      expect(replay).toMatchObject({ applied: false, reason: 'offset_mismatch', storedOffset: 250 })
      expect((await repo.getBySessionId('s-1'))?.inputTokens).toBe(13)
    })

    it('a patch from offset 0 replaces the accumulators', async () => {
      await repo.upsertFromTranscript(patch('s-1', { tokens: { inputTokens: 50 }, prompts: [{ text: 'a', at: null }] }))
      const again = await repo.upsertFromTranscript(patch('s-1', { tokens: { inputTokens: 50 }, prompts: [{ text: 'a', at: null }] }))
      expect(again.applied).toBe(true)
      expect(again.row.inputTokens).toBe(50)
      expect(again.row.prompts).toHaveLength(1)
    })

    it('keeps the hook-reported name and tmux when the transcript has none', async () => {
      await repo.upsertFromHook({ sessionId: 's-1', host: HOST, name: 'impl-x-p1', tmux: 'note:@0.%7', cwd: '/w' })
      const r = await repo.upsertFromTranscript(patch('s-1', { name: null, cwd: '/w', entrypoint: 'cli' }))
      expect(r.row).toMatchObject({ name: 'impl-x-p1', tmux: 'note:@0.%7', cwd: '/w' })
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
      expect(await repo.saveEmbedding('s-1', { sha: 'h1', model: 'm', embedding: v })).toBe(true)
      expect(await repo.saveEmbedding('missing', { sha: 'h1', model: 'm', embedding: v })).toBe(false)
      await expect(repo.saveEmbedding('s-1', { sha: 'h1', model: 'm', embedding: [1, 2] })).rejects.toThrow(/dimensions/)

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
})
