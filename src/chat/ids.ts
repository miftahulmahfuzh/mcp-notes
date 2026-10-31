import { randomInt } from 'node:crypto';
import { ID_ALPHABET } from '../notes/ids.js';

/**
 * Chat message ids: 4 characters from [0-9A-Z], e.g. `K7F2`, always shown as `[msg:K7F2]` so they
 * never read as a note id (`A-B32`) or a chat image id (`upload:A-B32`). 36^4 = 1,679,616 ids;
 * ChatService retries on a primary-key clash.
 */
export const MESSAGE_ID_PATTERN = /^[0-9A-Z]{4}$/;

const LOOSE_MESSAGE_ID = /^(?:\[msg:([0-9A-Z]{4})\]|msg:([0-9A-Z]{4})|([0-9A-Z]{4}))$/i;

/** A random id in canonical form. `random(n)` returns an integer in [0, n); injectable for tests. */
export function generateMessageId(random: (max: number) => number = randomInt): string {
  let id = '';
  for (let i = 0; i < 4; i += 1) {
    const ch = ID_ALPHABET[random(ID_ALPHABET.length)];
    if (ch === undefined) throw new RangeError('generateMessageId: random() returned an out-of-range index');
    id += ch;
  }
  return id;
}

export function isMessageId(value: string): boolean {
  return MESSAGE_ID_PATTERN.test(value);
}

/** `k7f2`, `msg:K7F2`, `[msg:k7f2]`, ` K7F2 ` -> `K7F2`; anything else -> null. */
export function normalizeMessageId(input: string): string | null {
  const m = LOOSE_MESSAGE_ID.exec(input.trim());
  if (m === null) return null;
  const id = m[1] ?? m[2] ?? m[3];
  return id === undefined ? null : id.toUpperCase();
}

/** The form the model and the page see: `[msg:K7F2]`. */
export function messageLabel(id: string): string {
  return `[msg:${id}]`;
}
