// What the streaming command's searches returned lately, by address. A play started by its address
// alone (`--play-url`, after "which of these two?") names no title; the address came from a search
// run a moment before, so this is where its name, year and episode are read back for the report to
// the daemon. One small JSON file per user; losing it only leaves such a play unreported.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SEEN_MAX = 400;

/** `<XDG_STATE_HOME or ~/.local/state>/notesd-streaming/seen.json`. */
export function seenFile(env = process.env) {
  const state = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(env.HOME || os.homedir(), '.local', 'state');
  return path.join(state, 'notesd-streaming', 'seen.json');
}

function read(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((e) => e && typeof e.url === 'string' && e.report && typeof e.report === 'object') : [];
  } catch {
    return [];
  }
}

/** Keeps what a search said of each address (`reports`: what `playReport` builds), newest last, SEEN_MAX at most. Never throws. */
export function remember(reports, file = seenFile()) {
  try {
    const fresh = reports.filter((r) => r && typeof r.url === 'string' && r.url !== '');
    if (fresh.length === 0) return;
    const urls = new Set(fresh.map((r) => r.url));
    const kept = read(file).filter((e) => !urls.has(e.url));
    const all = [...kept, ...fresh.map((r) => ({ url: r.url, report: r.report }))].slice(-SEEN_MAX);
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all));
    renameSync(tmp, file);
  } catch {
    // Not being able to keep it only leaves a later --play-url unreported.
  }
}

/** What a search said of this address, or null. */
export function recall(url, file = seenFile()) {
  const hit = read(file).findLast((e) => e.url === url);
  return hit ? hit.report : null;
}
