import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { REPO_ROOT } from '../config.js';
import type { LabMethod, Lens, RosterRow } from './types.js';

/**
 * The method brief ("lens") Claude judges a pick through, built from data so a new roster method
 * gets a usable lens with no code change (brief §4.2): the roster row (name, sub, engine, rules,
 * gate note), the lab method's hypothesis (promoted_from -> lab.sqlite methods), and an optional
 * hand-written brief `claude/adversary/briefs/<object_name>.md`. Its hash is part of
 * prompt_version, so any change becomes a new dated revision.
 */
export const BRIEFS_DIR = path.join(REPO_ROOT, 'claude', 'adversary', 'briefs');

const BRIEF_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_SUB = 400;
const MAX_GATE_NOTE = 900;
const MAX_HYPOTHESIS = 1_200;
const MAX_BRIEF = 4_000;

const HOW_IT_TRADES: Record<string, string> = {
  bracket:
    'A short trade. Each night it ranks the stocks that qualify; the top ones take its free slots, each bought at a limit price below the last close and sold within a few sessions on a target, a stop or a time limit.',
  book:
    'A basket held until the next rebalance. At each rebalance it re-picks every name and sets target weights. Objecting to a name it already holds means selling it, and the fees count against the objection.',
};

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 3).trimEnd()}...`;
}

/** The override brief for `objectName`, or null when there is none. Names outside [A-Za-z0-9_-] are never read. */
export async function readBrief(objectName: string | null, dir: string = BRIEFS_DIR): Promise<string | null> {
  if (objectName === null || !BRIEF_NAME.test(objectName)) return null;
  try {
    const text = (await readFile(path.join(dir, `${objectName}.md`), 'utf8')).trim();
    return text === '' ? null : clip(text, MAX_BRIEF);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export function lensText(row: RosterRow, lab: LabMethod | null, brief: string | null): string {
  const lines: string[] = [`Method: ${row.name} (${row.id})`, `What it does, in the owner's words: ${clip(row.sub, MAX_SUB)}`];
  const how = row.engine === null ? undefined : HOW_IT_TRADES[row.engine];
  if (how !== undefined) lines.push(`How it trades: ${how}`);
  if (row.rulesId !== null) lines.push(`Rule set: ${row.rulesId}`);
  if (row.gateNote !== null && row.gateNote.trim() !== '') lines.push(`What its record says: ${clip(row.gateNote, MAX_GATE_NOTE)}`);
  if (lab !== null && lab.hypothesis.trim() !== '') {
    lines.push(`The lab's idea behind it (${lab.id}, ${lab.name}): ${clip(lab.hypothesis, MAX_HYPOTHESIS)}`);
  }
  if (brief !== null) lines.push('', "The owner's brief for this method:", brief);
  return lines.join('\n');
}

export function buildLens(row: RosterRow, lab: LabMethod | null, brief: string | null): Lens {
  const text = lensText(row, lab, brief);
  const hash = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
  return { id: `${row.objectName ?? row.id}@${hash}`, text };
}
