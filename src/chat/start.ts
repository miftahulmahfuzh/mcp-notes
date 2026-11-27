import { join } from 'node:path';
import type { Config } from '../config.js';
import { createAgentChatBackend, type AgentChatBackend, type AgentChatOptions } from './agent.js';
import type { ChatBackend } from './backend.js';

/** `<dataDir>/chat`: the fixed cwd of every chat brain run. Sessions are not persisted there (persistSession: false). */
export const CHAT_SUBDIR = 'chat';

/**
 * The brain behind POST /api/chat: the one a caller injects (tests: the stub or a scripted fake), else the Agent SDK
 * backend built from config.chat. It reaches notes through this daemon's own /mcp, at the port known only after
 * listen. `agent` is the backend this call built (closed by the daemon's stop); null when one was injected.
 */
export function buildChatBackend(
  config: Pick<Config, 'chat' | 'dataDir' | 'host'>,
  injected: ChatBackend | undefined,
  boundPort: () => number | null,
  create: (options: AgentChatOptions) => AgentChatBackend = createAgentChatBackend,
): { chat: ChatBackend; agent: AgentChatBackend | null } {
  if (injected !== undefined) return { chat: injected, agent: null };
  const agent = create({
    chat: config.chat,
    cwd: join(config.dataDir, CHAT_SUBDIR),
    mcpUrl: () => {
      const port = boundPort();
      if (port === null) throw new Error('notesd is not listening yet.');
      return `http://${config.host}:${port}/mcp`;
    },
  });
  return { chat: agent, agent };
}
