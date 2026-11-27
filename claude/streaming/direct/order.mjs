// The order providers are tried in, the one place it lives (decision D1): the provider the owner
// put first (`first`, the daemon's DEFAULT_STREAM_FIRST_PROVIDER) while it keeps working; then a provider that never
// gave a stream on this machine in DEAD_AFTER tries or more goes last of all; then a provider known to
// offer an English subtitle first, unknown next, known without one last; then delivery (a provider
// whose last play on this machine kept stalling goes last); then health; then the best quality;
// then the quickest; then the order of the list.

/** A provider with this many failures in a row and no success ever on this machine is tried after every other. */
export const DEAD_AFTER = 5;

/**
 * 1: the provider never gave a stream here and failed DEAD_AFTER times in a row or more. It is
 * still tried, last: fifteen such providers ahead of a working one cost a play four minutes.
 */
export function deadRank(health) {
  return health && !health.last_success_at && (health.consecutive_failures ?? 0) >= DEAD_AFTER ? 1 : 0;
}

/** How a `no_stream` attempt's detail starts when the provider's own page did not load (resolve.mjs writes it). */
export const UNREACHABLE = 'unreachable: ';
/** The first rest of a provider that keeps failing; each further failure doubles it, up to REST_MAX_MS. */
export const REST_MS = 24 * 3_600_000;
export const REST_MAX_MS = 7 * 24 * 3_600_000;

/**
 * Until when (epoch ms) a provider is not asked at all, or null when it is asked as usual. A provider rests once its
 * last DEAD_AFTER tries or more here each failed with the provider's own answer: no stream (its page did not load,
 * or loaded with nothing to play) or a bot check. An old success does not keep it awake: VidLink gave one stream and
 * then failed 16 times in a row, and every play asked it first. An `error` (the sniffer or Chrome failed on this
 * machine) says nothing of the provider and never starts a rest. It is asked again once the rest is over (a day
 * after its last failure, then two, four, up to a week), so a provider that came back is found without anyone
 * looking, and one stream resets its count; `--only` asks it at any time. The daemon counts a `no_stream` from a
 * page that loaded only for a title known to stream here (src/directStream/repo.ts countsTowardRest).
 */
export function restingUntil(health) {
  if (!health || (health.consecutive_failures ?? 0) < DEAD_AFTER) return null;
  if (health.last_outcome !== 'bot_check' && health.last_outcome !== 'no_stream') return null;
  const failedAt = Date.parse(health.last_failure_at ?? '');
  if (!Number.isFinite(failedAt)) return null;
  const rest = Math.min(REST_MAX_MS, REST_MS * 2 ** Math.min(10, (health.consecutive_failures ?? 0) - DEAD_AFTER));
  return failedAt + rest;
}

/** Why a resting provider rests, as its skipped attempt says it. */
export function restReason(health) {
  if (health?.last_outcome === 'bot_check') return 'it shows a bot check';
  if (String(health?.last_detail ?? '').startsWith(UNREACHABLE)) return 'its page does not load';
  return 'it gave no stream';
}

/**
 * 0: has an English subtitle, 1: not known, 2: has none. What this machine measured beats the
 * seed's, except that a seed's "has one" stands: the measure is the last title's, and one title
 * without a subtitle does not make a provider one without subtitles.
 */
export function englishTier(provider, health) {
  const measured = health?.en_subtitle;
  const known = provider.en_subtitle === true || measured === true ? true : measured === false ? false : provider.en_subtitle;
  if (known === true) return 0;
  if (known === false) return 2;
  return 1;
}

/** 0: worked last time; 1: no verdict yet; 2 and up: failed that many times in a row (capped). */
export function healthRank(health) {
  if (!health) return 1;
  const failures = health.consecutive_failures ?? 0;
  if (failures > 0) return 1 + Math.min(failures, 10);
  return health.last_success_at ? 0 : 1;
}

/**
 * 1: the provider's stream host refused segments or kept the player waiting the last time something
 * played from it here (the daemon reads that from its stream evidence log); 0: it delivered, or
 * nothing played from it lately. Before healthRank: a provider that resolves and then stalls is
 * worse to watch than one that still has to prove it resolves.
 */
export function deliveryRank(health) {
  return health?.delivery === 'bad' ? 1 : 0;
}

/** The provider put first loses its place after this many failures in a row, until it gives a stream again. */
export const FIRST_GIVES_UP_AFTER = 3;

/**
 * 0: the provider the owner put first, while it earns the place: fewer than FIRST_GIVES_UP_AFTER
 * failures in a row and no bad delivery. Otherwise 1, and it is ordered like any other: a
 * provider that went down must not cost every play its 35 seconds.
 */
export function firstRank(provider, health, first) {
  if (first === null || provider.name.toLowerCase() !== first.toLowerCase()) return 1;
  return (health?.consecutive_failures ?? 0) >= FIRST_GIVES_UP_AFTER || deliveryRank(health) === 1 ? 1 : 0;
}

/**
 * The providers in the order a resolve tries them. Does not drop any; the resolver skips.
 * `first`: the name of the provider to try before every other, or null.
 */
export function orderProviders(providers, health = {}, { first = null } = {}) {
  const keyed = providers.map((provider, index) => {
    const h = Object.hasOwn(health, provider.name) ? health[provider.name] : null;
    return {
      provider,
      key: [firstRank(provider, h, first), deadRank(h), englishTier(provider, h), deliveryRank(h), healthRank(h), -(h?.best_height ?? 0), h?.median_s ?? Number.POSITIVE_INFINITY, index],
    };
  });
  keyed.sort((a, b) => {
    for (let i = 0; i < a.key.length; i++) {
      if (a.key[i] !== b.key[i]) return a.key[i] < b.key[i] ? -1 : 1;
    }
    return 0;
  });
  return keyed.map((entry) => entry.provider);
}
