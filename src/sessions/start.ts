import { join } from 'node:path';
import type { Config } from '../config.js';
import { SUMMARIES_SUBDIR, createAgentSummarizer, type AgentSummarizerOptions, type Summarizer } from './summarize.js';

export interface SessionSummarizerIo {
  create?: (opts: AgentSummarizerOptions) => Summarizer | null;
  log?: (line: string) => void;
}

/**
 * The session summarizer startBackground hands the summary worker: the Agent SDK's Haiku, run in
 * `<dataDir>/session-summaries`. Null with NOTESD_SESSIONS=off, or when no claude binary is found (said once in the log).
 */
export function buildSessionSummarizer(config: Pick<Config, 'sessions' | 'chat' | 'dataDir'>, io: SessionSummarizerIo = {}): Summarizer | null {
  if (!config.sessions.enabled) return null;
  const summarizer = (io.create ?? createAgentSummarizer)({
    claudeBin: config.chat.claudeBin,
    cwd: join(config.dataDir, SUMMARIES_SUBDIR),
  });
  if (summarizer === null) {
    (io.log ?? ((line: string) => console.log(line)))(`[notesd] session summaries off: claude binary "${config.chat.claudeBin}" not found (set NOTESD_CLAUDE_BIN)`);
  }
  return summarizer;
}
