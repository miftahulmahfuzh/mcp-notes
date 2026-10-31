#!/usr/bin/env node
/**
 * Opt-in live check, never part of npm test / test:int: does Claude Code run the notes-prompt
 * UserPromptSubmit hook for a `/n` prompt that carries a pasted image, and does the model then see
 * that image's chat image id in its context?
 *
 *   npm run verify:prompt-hook -- [--port 7400] [--model sonnet] [--claude claude]
 *
 * Needs a running notesd built from this checkout on --port (default NOTESD_PORT, else 7317; a
 * demo daemon is fine: NOTESD_PORT=7400 NOTES_DATA_DIR=/tmp/notes-demo npm start), and the claude
 * CLI logged in. Runs one short headless session (`claude -p --input-format stream-json`) with a
 * throwaway --settings file that registers only this repo's prompt hook, with a temp state dir
 * (no memo from earlier runs, and a prompt.log this script can show), and --strict-mcp-config with
 * no MCP servers, so the model can only answer from its context. Bills one small model call and
 * leaves one transcript under ~/.claude/projects (cwd is a temp dir). The pasted image lands in
 * chat_images (source claude_code). If the installed hooks are also in ~/.claude/settings.json,
 * Claude Code runs those too; this check only reads its own hook's marker and log.
 *
 * Exit 0: the model named a pasted-image id the daemon knows (GET /api/chat/images/<id>).
 * 1: the hook ran but no id reached the model: within the hook's 2.5 s wait the transcript's last
 *    human prompt never carried the current prompt's [Image #1] (the hook's prompt.log is printed,
 *    with its "[Image #1] not in the transcript" line). Images pasted in earlier turns
 *    still resolve; the follow-up for same-turn pastes is a PreToolUse rewrite of create_image.
 * 2: could not run (daemon down, claude missing or timed out, or Claude Code never ran the hook).
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(REPO, 'claude', 'hooks', 'notes-prompt.mjs');
const RED_PNG_16 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWO4o6FBEmIY1aAxGkp3hmvSAAAyBCwQ7wckpgAAAABJRU5ErkJggg==';
const TIMEOUT_MS = 180_000;
const HOOK_TIMEOUT_S = 20;
const CHAT_ID = /\b[0-9A-Z]-[0-9A-Z]{3}\b/g;

function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => (block && block.type === 'text' ? block.text : '')).join('\n');
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function knownChatImage(port, id) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat/images/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      port: { type: 'string' },
      model: { type: 'string', default: 'sonnet' },
      claude: { type: 'string', default: 'claude' },
    },
  });
  const port = values.port ?? process.env.NOTESD_PORT ?? '7317';
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
  } catch (err) {
    console.error(`notesd is not answering on 127.0.0.1:${port}: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'verify-prompt-hook-'));
  try {
    const settingsFile = path.join(tmp, 'settings.json');
    const mcpFile = path.join(tmp, 'mcp.json');
    const stateHome = path.join(tmp, 'state');
    const marker = path.join(tmp, 'hook-ran');
    const logFile = path.join(stateHome, 'notes-capture', 'prompt.log');
    const command =
      `touch ${quote(marker)}; ` +
      `NOTESD_PORT=${quote(port)} XDG_STATE_HOME=${quote(stateHome)} ${quote(process.execPath)} ${quote(HOOK)}`;
    await writeFile(
      settingsFile,
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S }] }] } }),
    );
    await writeFile(mcpFile, JSON.stringify({ mcpServers: {} }));

    const prompt =
      '/n [Image #1] Do not call any tool. If your context lists pasted image ids, reply with only the id ' +
      'it marks as the latest pasted image (ids look like G-0NC). Otherwise reply with only NONE.';
    const message = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_PNG_16 } },
        ],
      },
    };
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--settings', settingsFile,
      '--mcp-config', mcpFile,
      '--strict-mcp-config',
      '--model', values.model,
    ];
    console.log(`running: ${values.claude} ${args.join(' ')}  (port ${port})`);
    let lines;
    try {
      lines = await new Promise((resolve, reject) => {
        const child = spawn(values.claude, args, { cwd: tmp, stdio: ['pipe', 'pipe', 'inherit'] });
        let out = '';
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error(`claude did not finish within ${TIMEOUT_MS / 1000}s`));
        }, TIMEOUT_MS);
        child.stdout.on('data', (chunk) => {
          out += chunk.toString('utf8');
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on('close', () => {
          clearTimeout(timer);
          resolve(out.split('\n').filter((line) => line.trim() !== ''));
        });
        child.stdin.end(`${JSON.stringify(message)}\n`);
      });
    } catch (err) {
      console.error(`could not run claude: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }

    let answer = '';
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event?.type === 'result' && typeof event.result === 'string') answer = event.result;
      else if (event?.type === 'assistant' && answer === '') answer = textOf(event?.message?.content);
    }
    console.log(`model answered: ${answer.slice(0, 200)}`);

    for (const id of answer.match(CHAT_ID) ?? []) {
      if (await knownChatImage(port, id)) {
        console.log(`PASS: the /n prompt's context named pasted image ${id}`);
        return 0;
      }
    }
    if (!(await exists(marker))) {
      console.error('Claude Code never ran the UserPromptSubmit hook; inconclusive');
      return 2;
    }
    console.log("FAIL: the hook ran but no pasted-image id reached the model (the transcript did not hold the current prompt's [Image #1] in time?)");
    try {
      const log = await readFile(logFile, 'utf8');
      console.log(`prompt.log:\n${log.split('\n').slice(-20).join('\n')}`);
    } catch {
      console.log('prompt.log: (empty)');
    }
    return 1;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  },
);
