export interface QueryStat {
  label: string
  calls: number
  rows: number
  bytes: number
  lastAt: number
}

export interface EgressSnapshot {
  since: string
  totalBytes: number
  totalRows: number
  totalCalls: number
  top: QueryStat[]
}

/** Normalises SQL to a stable label: collapse whitespace, cut at 100 chars. Parameters stay as $n, so values never reach the label. */
export function sqlLabel(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 100)
}

/** Counts rows and approximate bytes returned per query shape, in memory, since the daemon started. */
export class EgressMeter {
  private readonly stats = new Map<string, QueryStat>()
  private readonly startedAt = new Date()
  constructor(private readonly now: () => number = Date.now) {}

  record(text: string, rows: readonly unknown[] | undefined): void {
    const label = sqlLabel(text)
    const n = rows?.length ?? 0
    // JSON length approximates the wire payload within ~±30 %; computed only for non-empty results.
    const bytes = n === 0 ? 0 : Buffer.byteLength(JSON.stringify(rows))
    const s = this.stats.get(label) ?? { label, calls: 0, rows: 0, bytes: 0, lastAt: 0 }
    s.calls += 1
    s.rows += n
    s.bytes += bytes
    s.lastAt = this.now()
    this.stats.set(label, s)
  }

  snapshot(limit = 25): EgressSnapshot {
    const all = [...this.stats.values()]
    return {
      since: this.startedAt.toISOString(),
      totalBytes: all.reduce((a, s) => a + s.bytes, 0),
      totalRows: all.reduce((a, s) => a + s.rows, 0),
      totalCalls: all.reduce((a, s) => a + s.calls, 0),
      top: all.sort((a, b) => b.bytes - a.bytes).slice(0, limit),
    }
  }

  /** `[notesd] egress since <iso>: 41.2 MB in 3120 calls; top: <label> 30.1 MB (120 calls); …` */
  summaryLine(top = 5): string {
    const s = this.snapshot(top)
    const mb = (b: number): string => `${(b / 1_048_576).toFixed(1)} MB`
    return `[notesd] egress since ${s.since}: ${mb(s.totalBytes)} in ${s.totalCalls} calls; top: ${s.top.map((t) => `${t.label} ${mb(t.bytes)} (${t.calls} calls)`).join('; ')}`
  }
}
