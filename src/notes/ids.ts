import { randomInt } from 'node:crypto'

/** Note ids are one char, a dash, three chars, all from [0-9A-Z]: `A-B32`. */
export const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** Canonical form only. Use `normalizeId` for user input. */
export const ID_PATTERN = /^[0-9A-Z]-[0-9A-Z]{3}$/

/** 36^4 = 1,679,616 distinct ids. The service retries on collision. */
export const ID_SPACE = ID_ALPHABET.length ** 4

const LOOSE_ID = /^([0-9A-Z])-?([0-9A-Z]{3})$/

/**
 * A fresh random id in canonical form. `random(n)` must return an integer in [0, n);
 * it defaults to `crypto.randomInt` and is injectable for tests.
 * Uniqueness is the caller's job (insert, retry on primary-key conflict).
 */
export function generateId(random: (max: number) => number = randomInt): string {
  let raw = ''
  for (let i = 0; i < 4; i++) {
    const ch = ID_ALPHABET[random(ID_ALPHABET.length)]
    if (ch === undefined) throw new RangeError('generateId: random() returned an out-of-range index')
    raw += ch
  }
  return `${raw[0]}-${raw.slice(1)}`
}

/** True only for the canonical form (`A-B32`). */
export function isValidId(value: string): boolean {
  return ID_PATTERN.test(value)
}

/**
 * Case-insensitive, dash-tolerant lookup form: `ab32`, `a-b32`, ` A-B32 ` → `A-B32`.
 * Returns null for anything that cannot be an id.
 */
export function normalizeId(input: string): string | null {
  const m = LOOSE_ID.exec(input.trim().toUpperCase())
  if (!m) return null
  return `${m[1]}-${m[2]}`
}

export class InvalidIdError extends Error {
  override name = 'InvalidIdError'
  constructor(readonly input: string) {
    super(`"${input}" is not a note id. Ids look like A-B32 (the dash is optional, case does not matter).`)
  }
}

/** `normalizeId` that throws `InvalidIdError` instead of returning null. */
export function parseId(input: string): string {
  const id = normalizeId(input)
  if (id === null) throw new InvalidIdError(input)
  return id
}
