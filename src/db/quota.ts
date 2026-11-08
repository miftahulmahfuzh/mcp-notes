export class QuotaExceededError extends Error {
  readonly code = '53000'
  constructor(readonly until: Date) {
    super(`Neon quota exceeded; notesd is not querying until ${until.toISOString()}`)
    this.name = 'QuotaExceededError'
  }
}

export function isQuotaError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null
  const message = typeof e?.message === 'string' ? e.message : ''
  return (e?.code === '53000' && /exceeded the quota/i.test(message)) || /project has exceeded the quota/i.test(message)
}

export const QUOTA_COOLDOWN_MS = 30 * 60_000

export class QuotaBreaker {
  private until = 0
  constructor(
    private readonly now: () => number = Date.now,
    private readonly cooldownMs = QUOTA_COOLDOWN_MS,
  ) {}
  trip(): void {
    this.until = this.now() + this.cooldownMs
  }
  /** Throws QuotaExceededError while tripped; the first query after the cool-down is the probe. */
  check(): void {
    if (this.now() < this.until) throw new QuotaExceededError(new Date(this.until))
  }
  get tripped(): boolean {
    return this.now() < this.until
  }
  get resumesAt(): string | null {
    return this.tripped ? new Date(this.until).toISOString() : null
  }
}
