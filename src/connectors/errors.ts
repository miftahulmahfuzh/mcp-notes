import { ConnectorError } from './types.js';

/** Secrets shorter than this are not scrubbed (they would mangle ordinary words). */
const MIN_SECRET_LENGTH = 3;
const MAX_REASON_LENGTH = 300;

/** Replaces every occurrence of every secret with ***, longest first. */
export function scrub(text: string, secrets: readonly string[]): string {
  const ordered = [...new Set(secrets.filter((s) => s.length >= MIN_SECRET_LENGTH))].sort(
    (a, b) => b.length - a.length,
  );
  let out = text;
  for (const secret of ordered) out = out.split(secret).join('***');
  return out;
}

/** A one-line reason from any thrown value. Unwraps AggregateError (pg's dual-stack connect). */
export function reasonOf(err: unknown): string {
  if (err instanceof AggregateError && err.errors.length > 0 && !err.message) return reasonOf(err.errors[0]);
  let message = err instanceof Error ? err.message : String(err);
  if (!message && typeof err === 'object' && err !== null && 'code' in err) message = String((err as { code: unknown }).code);
  message = message.replace(/\s+/g, ' ').trim();
  if (message === '') return 'unknown error';
  return message.length > MAX_REASON_LENGTH ? `${message.slice(0, MAX_REASON_LENGTH)}...` : message;
}

export function unreachable(label: string, reason: string, secrets: readonly string[] = []): ConnectorError {
  return new ConnectorError(`${label} is not reachable: ${scrub(reason, secrets)}`);
}

export function queryFailed(label: string, reason: string, secrets: readonly string[] = []): ConnectorError {
  return new ConnectorError(`${label} query failed: ${scrub(reason, secrets)}`);
}
