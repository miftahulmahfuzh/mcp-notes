import { randomUUID } from 'node:crypto';

/** Shapes copied from real Claude Code 2.1.314 transcripts (values made up). */
export const SESSION = '0ef363d6-0bdd-4a15-aff7-71f0821bd6ee';
export const CWD = '/tmp/notes-demo';
/** A valid 16x16 red PNG (sharp-generated). */
export const RED_PNG_16 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWO4o6FBEmIY1aAxGkp3hmvSAAAyBCwQ7wckpgAAAABJRU5ErkJggg==';
export const BLUE_DATA = 'Ymx1ZS1pbWFnZS1ieXRlcw==';

type Entry = Record<string, unknown>;

let clock = Date.parse('2026-10-30T11:53:23.611Z');
function ts(): string {
  clock += 1000;
  return new Date(clock).toISOString();
}

function base(overrides: Entry): Entry {
  return {
    parentUuid: randomUUID(),
    isSidechain: false,
    uuid: randomUUID(),
    timestamp: ts(),
    userType: 'external',
    entrypoint: 'cli',
    cwd: CWD,
    sessionId: SESSION,
    version: '2.1.314',
    gitBranch: 'HEAD',
    ...overrides,
  };
}

/** `/n args` as Claude Code writes a typed slash command (string content). */
export function commandEntry(args: string, overrides: Entry = {}): Entry {
  return base({
    promptId: randomUUID(),
    type: 'user',
    message: {
      role: 'user',
      content: `<command-message>n</command-message>\n<command-name>/n</command-name>\n<command-args>${args}</command-args>`,
    },
    origin: { kind: 'human' },
    turnOrigin: 'human',
    ...overrides,
  });
}

/** The skill body Claude Code injects after a slash command (isMeta). */
export function skillBodyEntry(): Entry {
  return base({
    type: 'user',
    isMeta: true,
    message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /home/u/.claude/skills/n\n\n# /n — mcp-notes' }] },
  });
}

/** A typed prompt with pasted images (array content, imagePasteIds). */
export function imagePromptEntry(
  text: string,
  images: { media_type: string; data: string }[],
  pasteIds: number[] | null = images.map((_, i) => i + 1),
  overrides: Entry = {},
): Entry {
  return base({
    promptId: randomUUID(),
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text },
        ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } })),
      ],
    },
    ...(pasteIds !== null ? { imagePasteIds: pasteIds } : {}),
    origin: { kind: 'human' },
    promptSource: 'typed',
    ...overrides,
  });
}

/** A plain typed prompt (string content). */
export function plainPromptEntry(text: string, overrides: Entry = {}): Entry {
  return base({ promptId: randomUUID(), type: 'user', message: { role: 'user', content: text }, origin: { kind: 'human' }, ...overrides });
}

export function assistantText(text: string, overrides: Entry = {}): Entry {
  return base({
    type: 'assistant',
    message: { id: `msg_${randomUUID()}`, role: 'assistant', content: [{ type: 'text', text }] },
    ...overrides,
  });
}

export function assistantToolUse(id: string, name: string, input: Record<string, unknown>): Entry {
  return base({
    type: 'assistant',
    message: { id: `msg_${randomUUID()}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  });
}

/** A tool result: also a `type: 'user'` entry. */
export function toolResultEntry(toolUseId: string, text: string): Entry {
  return base({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text }] }] },
    toolUseResult: [{ type: 'text', text }],
  });
}

/** What `/clear` leaves: a meta caveat and a command entry without origin. */
export function localCommandEntries(): Entry[] {
  return [
    base({ type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>The command below was run directly in Claude Code…</local-command-caveat>' } }),
    base({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>' } }),
  ];
}

export function attachmentEntry(): Entry {
  return { type: 'attachment', uuid: randomUUID(), timestamp: ts() };
}

export function jsonl(entries: Entry[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}
