#!/usr/bin/env node
/**
 * Opt-in live check, never part of npm test / test:int: does Claude Code honour the notes-paste
 * PreToolUse hook for the MCP tool mcp__notes__similar_images?
 *
 *   npm run verify:paste-hook -- [--port 7400] [--strategy updatedInput|deny] [--model sonnet] [--claude claude]
 *
 * Needs a running notesd built from this checkout on --port (default NOTESD_PORT, else 7317; a
 * demo daemon is fine: NOTESD_PORT=7400 NOTES_DATA_DIR=/tmp/notes-demo npm start), and the claude
 * CLI logged in. Runs one short headless session (`claude -p --input-format stream-json`) with a
 * throwaway --settings file that registers only this repo's paste hook, and --strict-mcp-config
 * pointing at that daemon. Bills one small model call and leaves one transcript under
 * ~/.claude/projects (cwd is a temp dir). The upload lands in chat_images (source claude_code).
 *
 * Exit 0: the tool received an upload_id (the strategy works). 1: it did not (with
 * updatedInput: flip DEFAULT_STRATEGY in claude/hooks/notes-paste.mjs to 'deny', or reinstall with
 * NOTES_PASTE_STRATEGY=deny scripts/install.sh, and re-run this with --strategy deny). 2: could not run.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(REPO, 'claude', 'hooks', 'notes-paste.mjs');
const TOOL = 'mcp__notes__similar_images';
const UNRESOLVED = 'pasted_image could not be resolved';
const RED_PNG_16 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWO4o6FBEmIY1aAxGkp3hmvSAAAyBCwQ7wckpgAAAABJRU5ErkJggg==';
const TIMEOUT_MS = 180_000;

function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => (block && block.type === 'text' ? block.text : '')).join('\n');
}

async function main() {
  const { values } = parseArgs({
    options: {
      port: { type: 'string' },
      strategy: { type: 'string', default: 'updatedInput' },
      model: { type: 'string', default: 'sonnet' },
      claude: { type: 'string', default: 'claude' },
    },
  });
  const port = values.port ?? process.env.NOTESD_PORT ?? '7317';
  const strategy = values.strategy === 'deny' ? 'deny' : 'updatedInput';
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
  } catch (err) {
    console.error(`notesd is not answering on 127.0.0.1:${port}: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'verify-paste-hook-'));
  try {
    const settingsFile = path.join(tmp, 'settings.json');
    const mcpFile = path.join(tmp, 'mcp.json');
    const command = `NOTESD_PORT=${quote(port)} NOTES_PASTE_STRATEGY=${quote(strategy)} ${quote(process.execPath)} ${quote(HOOK)}`;
    await writeFile(
      settingsFile,
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: TOOL, hooks: [{ type: 'command', command, timeout: 30 }] }] } }),
    );
    await writeFile(mcpFile, JSON.stringify({ mcpServers: { notes: { type: 'http', url: `http://127.0.0.1:${port}/mcp` } } }));

    const prompt =
      `[Image #1]\nCall the tool ${TOOL} with exactly the arguments {"pasted_image": 1, "limit": 3}. ` +
      'If the call is denied with instructions, follow them once. Then reply with only the first 300 characters of the last tool result.';
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
      '--allowedTools', TOOL,
      '--model', values.model,
    ];
    console.log(`running: ${values.claude} ${args.join(' ')}  (strategy ${strategy}, port ${port})`);
    const lines = await new Promise((resolve, reject) => {
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

    const calls = new Map();
    const results = [];
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const content = event?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === 'tool_use' && block.name === TOOL) calls.set(block.id, block.input);
        if (block?.type === 'tool_result' && calls.has(block.tool_use_id)) {
          results.push({ input: calls.get(block.tool_use_id), text: textOf(block.content), isError: block.is_error === true });
        }
      }
    }
    if (results.length === 0) {
      console.error('the model never called the tool; inconclusive');
      return 2;
    }
    for (const r of results) console.log(`call ${JSON.stringify(r.input)} -> ${r.isError ? 'error' : 'ok'}: ${r.text.slice(0, 200)}`);
    const reached = results.some((r) => !r.text.includes(UNRESOLVED) && !/permission|denied/i.test(r.text) && !r.text.includes('pasted_image'));
    console.log(reached ? `PASS: similar_images received an upload_id (${strategy})` : `FAIL: the ${strategy} strategy did not reach the tool with an upload_id`);
    return reached ? 0 : 1;
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
