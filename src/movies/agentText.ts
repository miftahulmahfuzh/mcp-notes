import { mkdir } from 'node:fs/promises';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn } from '../chat/agent.js';
import { claudeEnv } from '../chat/env.js';

/**
 * One Agent SDK run of a movies writer (story.ts, guides.ts, webStory.ts): the owner's login, no MCP
 * servers, no settings, thinking off, no persisted session, and exactly the tools named.
 */
export interface AgentTextRun {
  query: QueryFn;
  /** The claude binary findClaudeBin found. */
  claudeBin: string;
  /** Created on first use; nothing is persisted there. */
  cwd: string;
  baseEnv: NodeJS.ProcessEnv;
  model: string;
  /** [] for none; ['WebSearch'] for a writer that searches. Allowed exactly as given. */
  tools: string[];
  maxTurns: number;
  systemPrompt: string;
  timeoutMs: number;
  /** What is being written, named in the timeout error: "no story within 240 s". */
  what: string;
  /** Sees every message of the run, in order (the web story collects what its searches returned). */
  onMessage?: (message: SDKMessage) => void;
}

export function agentOptions(run: AgentTextRun, abortController: AbortController): Options {
  return {
    abortController,
    cwd: run.cwd,
    env: claudeEnv(run.baseEnv),
    model: run.model,
    pathToClaudeCodeExecutable: run.claudeBin,
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    tools: run.tools,
    allowedTools: run.tools,
    permissionMode: 'dontAsk',
    maxTurns: run.maxTurns,
    thinking: { type: 'disabled' },
    systemPrompt: run.systemPrompt,
    persistSession: false,
  };
}

/** The run's answer, trimmed and not empty. Rejects when the run fails, times out or answers nothing. */
export async function runAgentText(run: AgentTextRun, prompt: string): Promise<string> {
  await mkdir(run.cwd, { recursive: true });
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort('timeout');
  }, run.timeoutMs);
  timer.unref();
  let result: string | null = null;
  let failure: string | null = null;
  try {
    for await (const message of run.query({ prompt, options: agentOptions(run, controller) })) {
      run.onMessage?.(message);
      if (message.type !== 'result') continue;
      if (message.subtype === 'success' && !message.is_error) result = message.result;
      else if (message.subtype === 'success') failure = message.result.trim() || 'the model failed without saying why';
      else failure = message.errors.join('; ').trim() || `the model failed (${message.subtype})`;
    }
  } catch (err) {
    // A CLI that exits non-zero after its result still produced that result: trust it.
    if (result === null && failure === null) failure = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }
  const text = (result ?? '').trim();
  if (text !== '') return text;
  throw new Error(timedOut ? `no ${run.what} within ${Math.round(run.timeoutMs / 1000)} s` : (failure ?? 'the model answered nothing'));
}
