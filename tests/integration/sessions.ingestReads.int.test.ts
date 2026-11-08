import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { SessionsRepo } from '../../src/sessions/repo.js'
import type { TranscriptPatch } from '../../src/sessions/types.js'
import { closeTestDb, openTestDb, truncateAll } from './setup.js'

const HOST = 'host-a'

function patch(over: Partial<TranscriptPatch> = {}): TranscriptPatch {
  return { sessionId: 's-1', host: HOST, transcriptPath: '/p/s-1.jsonl', fromOffset: 0, toOffset: 100, size: 100, ...over }
}

type Seen = { text: string; rows: number }

/** Records every statement's text and row count that goes through pg.Client.query. */
function spyOnQueries(): { seen: Seen[]; stop: () => void } {
  const seen: Seen[] = []
  const proto = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown }
  const original = proto.query
  proto.query = function (this: unknown, ...args: unknown[]) {
    const first = args[0]
    const text = typeof first === 'string' ? first : ((first as { text?: string })?.text ?? '')
    const out = original.apply(this, args) as Promise<{ rowCount: number | null }> | undefined
    if (out && typeof out.then === 'function') {
      return out.then((res) => {
        seen.push({ text, rows: res?.rowCount ?? 0 })
        return res
      })
    }
    return out
  }
  return { seen, stop: () => void (proto.query = original) }
}

/** A statement that hands back the heavy `prompts` column of a cc_sessions row. */
const readsPrompts = (s: Seen) => {
  if (!/"cc_sessions"/.test(s.text)) return false
  const returned = /^\s*select/i.test(s.text) ? s.text : (s.text.split(/returning/i)[1] ?? '')
  return /"prompts"/.test(returned)
}

describe('ingest write path reads', () => {
  let db: Db
  let repo: SessionsRepo
  let spy: ReturnType<typeof spyOnQueries> | null = null

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
  afterEach(() => spy?.stop())

  it('an append reads the full session row once (the lock), and returns a light ref', async () => {
    await repo.upsertFromTranscript(patch({ tokens: { inputTokens: 10 }, prompts: [{ text: 'hello', at: null }] }))
    spy = spyOnQueries()
    const res = await repo.upsertFromTranscript(
      patch({ fromOffset: 100, toOffset: 150, size: 150, tokens: { inputTokens: 3 }, prompts: [{ text: 'second', at: null }] }),
    )
    spy.stop()
    expect(res.applied).toBe(true)
    expect(Object.keys(res.row).sort()).toEqual(['host', 'nodeId', 'sessionId', 'transcriptOffset', 'transcriptSize'])
    expect(spy.seen.filter(readsPrompts)).toHaveLength(1)

    const stored = (await repo.getBySessionId('s-1'))!
    expect(stored.inputTokens).toBe(13)
    expect(stored.prompts.map((p) => p.text)).toEqual(['hello', 'second'])
    expect(stored.transcriptOffset).toBe(150)
  })

  it('a subagent append updates the parent totals and commits', async () => {
    await repo.upsertFromTranscript(patch({ tokens: { inputTokens: 10 }, commits: [{ sha: 'aaa1111', subject: 'a', at: null }] }))
    const res = await repo.upsertFromSubagentTranscript({
      sessionId: 's-1',
      agentId: 'a1',
      host: HOST,
      transcriptPath: '/p/s-1/subagents/agent-a1.jsonl',
      fromOffset: 0,
      toOffset: 50,
      size: 50,
      tokens: { inputTokens: 5 },
      commits: [{ sha: 'bbb2222', subject: 'b', at: null }],
    })
    expect(res.applied).toBe(true)
    const stored = (await repo.getBySessionId('s-1'))!
    expect(stored.inputTokens).toBe(15)
    expect(stored.commits.map((c) => c.sha).sort()).toEqual(['aaa1111', 'bbb2222'])
  })
})
