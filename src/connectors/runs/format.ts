/**
 * Pure unit helpers for the run-insights curated tools.
 *
 * run-insights stores integers in the smallest sensible unit (metres, seconds, sec/km, bpm). The
 * tools return those raw integers unchanged and add a human-readable companion next to each, so
 * Claude can quote "5.23 km at 5:44 /km" without doing arithmetic and still compare raw numbers.
 *
 * These are re-implementations, not imports: run-insights is a separate project and its code is
 * never imported here.
 */

/** Coerces a driver value (number, numeric/int8 string, bigint) to a finite number, else null. */
export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** A driver value as a string, else null. */
export function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : String(value);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 5230 -> 5.23. Two decimals, which is what the app shows. */
export function metresToKm(metres: number | null): number | null {
  if (metres === null) return null;
  return Math.round(metres / 10) / 100;
}

/** 1800 -> "0:30:00", 3725 -> "1:02:05". Always h:mm:ss, so it never reads as a pace. */
export function formatDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const s = Math.max(0, Math.round(seconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  return `${hours}:${pad2(minutes)}:${pad2(s % 60)}`;
}

/** 344 -> "5:44 /km". Null for a missing or non-positive pace. */
export function formatPace(secPerKm: number | null): string | null {
  if (secPerKm === null || !Number.isFinite(secPerKm) || secPerKm <= 0) return null;
  const s = Math.round(secPerKm);
  return `${Math.floor(s / 60)}:${pad2(s % 60)} /km`;
}

/**
 * Whole-period pace: summed duration over summed distance, rounded to whole seconds per km. This
 * is the app's own rule for week and month averages (a distance-weighted pace), not a mean of
 * per-run paces. Null when there is no distance (the app shows 0; null is clearer to Claude).
 */
export function avgPaceSecPerKm(distanceM: number, durationSec: number): number | null {
  if (!(distanceM > 0)) return null;
  return Math.round(durationSec / (distanceM / 1000));
}

/** Heart-rate drop in the first minute after the run (end HR minus HR one minute later). Bigger is better. */
export function hrDrop1Min(endHr: number | null, oneMinHr: number | null): number | null {
  if (endHr === null || oneMinHr === null) return null;
  return endHr - oneMinHr;
}

/** Zone bounds as Apple prints them: zone 1 has no floor, zone 5 has no ceiling. */
export function formatZoneRange(minBpm: number | null, maxBpm: number | null): string | null {
  if (minBpm === null && maxBpm === null) return null;
  if (minBpm === null) return `< ${maxBpm} bpm`;
  if (maxBpm === null) return `> ${minBpm} bpm`;
  return `${minBpm}-${maxBpm} bpm`;
}

/** part/whole as a percentage with one decimal; null when whole is 0. */
export function percentOf(part: number, whole: number): number | null {
  if (!(whole > 0)) return null;
  return Math.round((part / whole) * 1000) / 10;
}
