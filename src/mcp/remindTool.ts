import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DAY_MS, MAX_REMINDER_BODY, MAX_REMINDER_REPO, RemindersRepo } from '../reminders/repo.js';
import { run, type ToolDeps } from './tools.js';

/** Claude Code only: not in allowedChatTools() (reminders are shown by the SessionStart hook, never on the wall). */
export const REMIND_TOOL_NAME = 'remind';
/** The furthest `in_days` reaches: ten years. */
export const MAX_IN_DAYS = 3650;

const DUE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DUE_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const REMINDER_ID = /^#?([1-9]\d{0,14})$/;

const DESCRIPTION =
  "Reminders for the owner. A reminder is shown by the notes-session hook at the start of a fresh Claude Code session (startup or /clear) once it is due, " +
  'in the repository it names (or in every repository), at most once every 20 hours, until it is marked done. ' +
  'action add: body (plain text the owner reads), and exactly one of due (an ISO date "2026-12-04", meaning midnight on this machine, or a datetime with its offset "2026-12-04T09:00:00+07:00") ' +
  'and in_days (days from now; 0 is now), and repo (optional: a repository key such as "mcp-notes"; omitted, every repository). Answers {reminder}. ' +
  'action list: every reminder not done, soonest first, each with id, body, repo, due_at and last_shown_at. Answers {reminders}. ' +
  'action done: id (the number, 12 or "#12") marks it done so it is never shown again. Answers {reminder, changed}; changed is false when it was already done. ' +
  'When a session starts with a reminder in its context, tell the owner at the start of your first reply; call done only after the owner says it is handled, and add only when the owner asks to be reminded.';

/** What the tool receives, before validation. */
export interface RemindArgs {
  action: 'add' | 'list' | 'done';
  body?: string;
  due?: string;
  in_days?: number;
  repo?: string;
  id?: number | string;
}

/** A validated request: each action carries exactly what it needs. */
export type RemindRequest =
  | { action: 'add'; body: string; dueAt: Date; repo: string | null }
  | { action: 'list' }
  | { action: 'done'; id: number };

function invalid(message: string): Error {
  return new Error(`invalid_input: ${message}`);
}

/** `due` as a time: a date is midnight on this machine, a datetime needs its offset. */
export function dueFrom(text: string): Date {
  const day = DUE_DATE.exec(text);
  if (day !== null) {
    const year = Number(day[1]);
    const month = Number(day[2]);
    const date = Number(day[3]);
    const at = new Date(year, month - 1, date);
    if (at.getFullYear() !== year || at.getMonth() !== month - 1 || at.getDate() !== date) throw invalid(`due ${text} is not a date`);
    return at;
  }
  const instant = DUE_INSTANT.exec(text);
  if (instant !== null && !Number.isNaN(Date.parse(text))) {
    // Date.parse rolls an impossible day or hour over (02-30 is 03-02, 24:00 the next day): refused, as a date is.
    const [year, month, date, hour, minute, second] = instant.slice(1, 7).map((n) => (n === undefined ? 0 : Number(n))) as [number, number, number, number, number, number];
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (month < 1 || month > 12 || date < 1 || date > days || hour > 23 || minute > 59 || second > 59) throw invalid(`due ${text} is not a date`);
    return new Date(text);
  }
  throw invalid('due must be an ISO date (2026-12-04) or a datetime with its offset (2026-12-04T09:00:00+07:00)');
}

/** Validates and normalizes the tool's arguments once, here at the boundary. Throws `invalid_input: ...`. */
export function parseRemindArgs(args: RemindArgs, now: Date): RemindRequest {
  if (args.action === 'list') return { action: 'list' };
  if (args.action === 'done') {
    const raw = typeof args.id === 'number' ? String(args.id) : (args.id ?? '').trim();
    const match = REMINDER_ID.exec(raw);
    if (match === null) throw invalid('done needs id, the reminder number (12 or "#12")');
    return { action: 'done', id: Number(match[1]) };
  }
  const body = (args.body ?? '').trim();
  if (body === '') throw invalid('add needs body, the text the owner reads');
  if (body.length > MAX_REMINDER_BODY) throw invalid(`body is longer than ${MAX_REMINDER_BODY} characters`);
  const due = (args.due ?? '').trim();
  const hasDue = due !== '';
  const hasDays = args.in_days !== undefined;
  if (hasDue === hasDays) throw invalid('add needs exactly one of due and in_days');
  let dueAt: Date;
  if (hasDue) {
    dueAt = dueFrom(due);
    // A due time more than a day ago is a typo (a wrong year): it would only show at once.
    if (dueAt.getTime() < now.getTime() - DAY_MS) throw invalid(`due ${due} is in the past`);
  } else {
    const days = args.in_days as number;
    if (!Number.isFinite(days) || days < 0 || days > MAX_IN_DAYS) throw invalid(`in_days must be between 0 and ${MAX_IN_DAYS}`);
    dueAt = new Date(now.getTime() + days * DAY_MS);
  }
  const repo = (args.repo ?? '').trim();
  if (repo.length > MAX_REMINDER_REPO) throw invalid(`repo is longer than ${MAX_REMINDER_REPO} characters`);
  return { action: 'add', body, dueAt, repo: repo === '' ? null : repo };
}

/** `remind`: add | list | done, through RemindersRepo on `deps.db`. Nothing is read or written at registration. */
export function registerRemindTool(server: McpServer, deps: Pick<ToolDeps, 'db'>, options: { now?: () => Date } = {}): void {
  const now = options.now ?? (() => new Date());
  server.registerTool(
    REMIND_TOOL_NAME,
    {
      title: 'Reminders: add, list, done',
      description: DESCRIPTION,
      inputSchema: {
        action: z.enum(['add', 'list', 'done']).describe('add a reminder, list the open ones, or mark one done.'),
        body: z.string().optional().describe('add: the reminder, plain text the owner reads (at most 2000 characters).'),
        due: z.string().optional().describe('add: when it is due, "2026-12-04" (midnight on this machine) or "2026-12-04T09:00:00+07:00". Not with in_days.'),
        in_days: z.number().optional().describe('add: days from now until it is due (0 is now; fractions allowed). Not with due.'),
        repo: z.string().optional().describe('add: the repository key it is shown in, such as "mcp-notes". Omitted: every repository.'),
        id: z.union([z.number(), z.string()]).optional().describe('done: the reminder number, 12 or "#12".'),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args) =>
      run(async () => {
        const at = now();
        const request = parseRemindArgs(args as RemindArgs, at);
        const repo = new RemindersRepo(deps.db, now);
        if (request.action === 'add') return { reminder: await repo.add({ body: request.body, dueAt: request.dueAt, repo: request.repo }) };
        if (request.action === 'list') return { reminders: await repo.listOpen() };
        const done = await repo.done(request.id);
        if (done === null) throw new Error(`not_found: no reminder #${request.id}`);
        return done;
      }),
  );
}
