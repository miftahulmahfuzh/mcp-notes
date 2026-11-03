#!/usr/bin/env node
// Writes the many-prompts fixture transcript into tests/fixtures/claude-home. Deterministic: rerun
// it and `git diff` shows nothing. 106 human prompts (more than the 100-excerpt cap); prompt 50 is a
// multi-line prompt over 2000 chars with indented lines; prompt 60 holds a fake Anthropic key that
// must never be stored. Constants are mirrored in tests/helpers/claudeHome.ts (MANY_PROMPTS).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = '5e55a001-0000-4000-8000-000000000005';
const PROMPTS = 106;
const LONG = 50;
const KEYED = 60;
const FAKE_KEY = 'sk-ant-api03-FAKE-not-a-real-key-0000000000';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'claude-home', 'projects', '-home-u-mcp-notes', `${ID}.jsonl`);
const base = Date.parse('2026-10-20T01:00:00.000Z');
const at = (minute, second = 0) => new Date(base + minute * 60_000 + second * 1_000).toISOString();
const envelope = {
  sessionId: ID,
  cwd: '/home/u/mcp-notes',
  entrypoint: 'cli',
  version: '2.1.311',
  gitBranch: 'main',
  userType: 'external',
  isSidechain: false,
};

function promptText(n) {
  if (n === LONG) {
    const lines = [`fixture prompt ${n}: a long prompt whose layout must survive`];
    for (let i = 1; i <= 40; i += 1) {
      lines.push(`${' '.repeat(2 + (i % 3) * 2)}line ${i}: the quick brown fox jumps over the lazy dog, then naps in the sun`);
    }
    lines.push('end of the long prompt');
    return lines.join('\n');
  }
  if (n === KEYED) return `fixture prompt ${n}: deploy with this key ${FAKE_KEY} then report back\n    keep this indented line exactly as typed`;
  return `fixture prompt ${n}: step ${n} of the long session`;
}

const records = [{ type: 'agent-name', agentName: 'many-prompts-fixture', sessionId: ID }];
for (let n = 1; n <= PROMPTS; n += 1) {
  records.push({
    parentUuid: n === 1 ? null : `mp-a-${n - 1}`,
    ...envelope,
    type: 'user',
    message: { role: 'user', content: promptText(n) },
    uuid: `mp-u-${n}`,
    timestamp: at(n),
  });
  records.push({
    parentUuid: `mp-u-${n}`,
    ...envelope,
    type: 'assistant',
    message: {
      id: `msg_mp_${n}`,
      model: 'claude-opus-5-5',
      role: 'assistant',
      content: [{ type: 'text', text: `Done with step ${n}.` }],
      usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    uuid: `mp-a-${n}`,
    timestamp: at(n, 30),
  });
}
records.push({ type: 'last-prompt', lastPrompt: promptText(PROMPTS), sessionId: ID });
writeFileSync(out, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
console.log(`wrote ${out}`);
