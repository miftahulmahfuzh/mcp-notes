import { createConnector, type ConnectorOptions } from '../connector.js';
import type { Connector, SystemAbout } from '../types.js';

export const RUNS_ABOUT: SystemAbout = {
  summary: "the owner's Apple Watch runs (pace, distance, heart rate, splits), weekly and monthly reviews, and the coach Nina",
  db:
    'runs is one run: occurred_on is the calendar day in Asia/Jakarta (WIB), started_at/ended_at are local wall-clock times, distance_m metres, duration_sec seconds, avg_pace_sec seconds per km, avg_hr/max_hr/resting_hr/end_hr_bpm/hr_1min_post_bpm bpm, elevation_m metres, active_kcal/total_kcal, avg_cadence, intent (easy, tempo, long, race, unspecified), note. ' +
    "Only runs with reviewed_at IS NOT NULL count in the app's lists and totals. " +
    'run_splits: one row per km (time_sec, pace_sec, hr, cadence; partial marks the last partial km). run_zones: heart-rate zones 1-5 (duration_sec, min_bpm, max_bpm). ' +
    "insights is the app's own analysis: scope session/week/month, scope_key = run id / YYYY-Www (ISO week, Monday-Sunday) / YYYY-MM, payload jsonb {headline, verdict, whatHappened, observations[{title, detail, metric}], doNext[], questionForRunner}; several rows per key, the newest created_at wins. " +
    'profiles: max_hr, resting_hr, weight_kg. records and badges: personal bests and awards. nina_* tables: the coach Nina (chat sessions, messages with role runner/nina, memory). Every table is scoped by user_id; the app has one owner.',
};

export function createRunsConnector(options: ConnectorOptions = {}): Connector {
  return createConnector('runs', options);
}
