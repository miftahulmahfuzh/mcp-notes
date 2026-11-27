import { dbInstruments, type Db } from './client.js';

/** How often the egress line is logged. */
export const EGRESS_LINE_MS = 60 * 60_000;

/** Hourly egress line: which query shapes pulled the most rows/bytes from the database. Returns its stop. */
export function startEgressLine(db: Db, log: (line: string) => void = (line) => console.log(line), everyMs: number = EGRESS_LINE_MS): () => void {
  const meter = dbInstruments(db)?.meter;
  const timer = meter ? setInterval(() => log(meter.summaryLine()), everyMs) : null;
  timer?.unref();
  return () => {
    if (timer) clearInterval(timer);
  };
}
