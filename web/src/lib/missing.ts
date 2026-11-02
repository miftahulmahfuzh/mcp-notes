/** Why an image URL did not load: its original lives on another machine, or something actually broke. */
export type MissingReason = { kind: 'remote'; host: string | null } | { kind: 'broken' };

/**
 * Asks the image route itself after an `<img>` error. The note and chat image variant routes both
 * answer 404 `{ error: 'not_on_this_machine', host }` for an image stored on the other laptop.
 */
export async function missingReason(url: string, fetchImpl: typeof fetch = fetch): Promise<MissingReason> {
  try {
    const res = await fetchImpl(url);
    if (res.status !== 404) return { kind: 'broken' };
    const body = (await res.json().catch(() => null)) as { error?: unknown; host?: unknown } | null;
    if (body?.error !== 'not_on_this_machine') return { kind: 'broken' };
    return { kind: 'remote', host: typeof body.host === 'string' && body.host ? body.host : null };
  } catch {
    return { kind: 'broken' };
  }
}

/** "uploaded on GPD", or "uploaded on another device" when the host is unknown. */
export function remoteCaption(host: string | null): string {
  return `uploaded on ${host ?? 'another device'}`;
}
