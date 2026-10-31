import { readFile } from 'node:fs/promises';
import {
  query as sdkQuery,
  type Options,
  type SDKAssistantMessageError,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { Config } from '../config.js';
import type { ChatBackend, ChatBrain, ChatEvent, ChatRequest, ChatTurn, ChatTurnEnd } from './backend.js';
import { composeUserTurn, toSdkPrompt, type UserTurn } from './compose.js';
import { claudeEnv, glmEnv, resolveExecutable } from './env.js';
import { buildChatSystemPrompt } from './prompt.js';
import { NOTES_MCP_SERVER, WEB_TOOL_NAMES, allowedChatTools, captionForToolUse } from './status.js';

/** `config.chat` from Phase 1's loadConfig. */
export type AgentChatConfig = Config['chat'];

/** The slice of the SDK's `query` the backend uses. Tests inject a fake. A turn with images passes a one-message stream. */
export type QueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage>;

export interface AgentChatOptions {
  chat: AgentChatConfig;
  /** Fixed cwd of every run (`<dataDir>/chat`), so sessions live in one ~/.claude/projects dir. */
  cwd: string;
  /** The daemon's own MCP endpoint. Read at the start of each run; the port is known only after listen. */
  mcpUrl: () => string;
  /** Default: the SDK's `query`. */
  query?: QueryFn;
  /** Default: `() => new Date()`. */
  now?: () => Date;
  /** Env the child env is derived from. Default: `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
  /** One-line operational log (fallbacks). Default: console.warn. */
  log?: (line: string) => void;
  /** Reads a pasted image's preview file (sent base64 in the prompt). Default: fs.readFile. */
  readPreview?: (absPath: string) => Promise<Uint8Array>;
}

export interface AgentChatBackend extends ChatBackend {
  /** Stops the in-flight run, if any (daemon shutdown). */
  close(): void;
}

/** `SDKAssistantMessage.error` values that mean "this login cannot answer right now". */
export const FALLBACK_ERRORS: ReadonlySet<SDKAssistantMessageError> = new Set<SDKAssistantMessageError>([
  'authentication_failed',
  'oauth_org_not_allowed',
  'billing_error',
  'rate_limit',
]);

/** Error text that names a usage limit or an auth problem. */
export const FALLBACK_TEXT =
  /usage limit|limit reached|rate.?limit|credit balance|billing|not logged in|\/login|authenticat|oauth|invalid api key|unauthori[sz]ed|\b(401|403|429)\b/i;

type StopReason = 'client' | 'superseded' | 'timeout' | 'closed';

class AttemptError extends Error {
  override name = 'AttemptError';
  constructor(
    message: string,
    readonly fallbackable: boolean,
  ) {
    super(message);
  }
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;
}

function stopMessage(reason: StopReason, timeoutMs: number): string {
  switch (reason) {
    case 'client':
      return 'Chat stopped: the request was closed.';
    case 'superseded':
      return 'Chat stopped: a newer message replaced this one.';
    case 'timeout':
      return `Chat stopped: no answer within ${formatDuration(timeoutMs)}.`;
    case 'closed':
      return 'Chat stopped: notesd is shutting down.';
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isFallbackable(text: string, lastError: SDKAssistantMessageError | null): boolean {
  return (lastError !== null && FALLBACK_ERRORS.has(lastError)) || FALLBACK_TEXT.test(text);
}

function resultFailure(
  message: SDKResultMessage,
  lastError: SDKAssistantMessageError | null,
  maxTurns: number,
): AttemptError {
  if (message.subtype === 'error_max_turns') {
    return new AttemptError(
      `Chat stopped: the agent hit its ${maxTurns}-turn cap before finishing. Try a narrower question.`,
      false,
    );
  }
  const text =
    message.subtype === 'success'
      ? message.result.trim() || 'The agent failed without saying why.'
      : message.errors.join('; ').trim() || `The agent failed (${message.subtype}).`;
  return new AttemptError(text, isFallbackable(text, lastError));
}

interface RunDeps {
  chat: AgentChatConfig;
  query: QueryFn;
  log: (line: string) => void;
  optionsFor: (brain: ChatBrain, resume: string | null, abortController: AbortController) => Options;
  readPreview: (absPath: string) => Promise<Uint8Array>;
}

/** One `reply()`: up to two SDK attempts (claude, then glm) behind one event stream. */
class ChatRun {
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly onClientAbort = (): void => this.stop('client');
  private reason: StopReason | null = null;
  private finished = false;
  private outcome: ChatTurnEnd | null = null;
  /** True once any `delta` went out. After that a failure is final (no duplicate output). */
  private emittedText = false;
  /** True when a tool_use came after the last emitted text: the next text starts a new paragraph. */
  private toolSinceText = false;
  /** The caption currently shown by the panel ("" = none). */
  private caption = '';
  /** The composed user turn, built once per run (the GLM retry reuses it). */
  private turnLoad: Promise<UserTurn> | null = null;

  constructor(
    private readonly deps: RunDeps,
    private readonly request: ChatRequest,
  ) {
    this.timer = setTimeout(() => this.stop('timeout'), deps.chat.timeoutMs);
    this.timer.unref();
    if (request.signal.aborted) this.stop('client');
    else request.signal.addEventListener('abort', this.onClientAbort, { once: true });
  }

  get active(): boolean {
    return !this.finished;
  }

  stop(reason: StopReason): void {
    if (this.finished || this.reason !== null) return;
    this.reason = reason;
    this.controller.abort(reason);
  }

  end(): ChatTurnEnd {
    if (this.outcome === null) throw new Error('ChatTurn.end() called before events finished cleanly');
    return this.outcome;
  }

  /** Reads each pasted image's preview once and composes the turn. A missing file fails the turn without a fallback. */
  private userTurn(): Promise<UserTurn> {
    this.turnLoad ??= (async (): Promise<UserTurn> => {
      const previews: string[] = [];
      for (const image of this.request.images) {
        let bytes: Uint8Array;
        try {
          bytes = await this.deps.readPreview(image.previewPath);
        } catch (err) {
          throw new AttemptError(`Could not read pasted image ${image.id}: ${errorText(err)}`, false);
        }
        previews.push(Buffer.from(bytes).toString('base64'));
      }
      return composeUserTurn(this.request, previews);
    })();
    return this.turnLoad;
  }

  async *events(): AsyncGenerator<ChatEvent> {
    try {
      yield* this.runWithFallback();
    } catch (err) {
      if (this.reason !== null) throw new Error(stopMessage(this.reason, this.deps.chat.timeoutMs));
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      this.finish();
    }
  }

  private finish(): void {
    this.finished = true;
    clearTimeout(this.timer);
    this.request.signal.removeEventListener('abort', this.onClientAbort);
  }

  private async *runWithFallback(): AsyncGenerator<ChatEvent> {
    const first = this.deps.chat.brain;
    try {
      yield* this.attempt(first);
      return;
    } catch (err) {
      if (!this.canFallBack(first, err)) throw err;
      this.deps.log(`notesd chat: claude failed before answering (${errorText(err)}); retrying once on glm`);
    }
    if (this.caption !== '') {
      this.caption = '';
      yield { type: 'status', text: '' };
    }
    yield* this.attempt('glm');
  }

  private canFallBack(brain: ChatBrain, err: unknown): boolean {
    return (
      brain === 'claude' &&
      this.deps.chat.glm !== null &&
      err instanceof AttemptError &&
      err.fallbackable &&
      !this.emittedText &&
      this.reason === null
    );
  }

  private async *attempt(brain: ChatBrain): AsyncGenerator<ChatEvent> {
    if (this.reason !== null) throw new Error('stopped');
    const turn = await this.userTurn();
    // A stop during the preview read must not start a run: the relay below would never fire.
    if (this.reason !== null) throw new Error('stopped');
    const controller = new AbortController();
    const relay = (): void => controller.abort(this.controller.signal.reason);
    this.controller.signal.addEventListener('abort', relay, { once: true });

    let lastError: SDKAssistantMessageError | null = null;
    let failure: AttemptError | null = null;
    let succeeded = false;
    let drained = false;
    try {
      const messages = this.deps.query({
        prompt: toSdkPrompt(turn),
        options: this.deps.optionsFor(brain, this.request.threadId, controller),
      });
      for await (const message of messages) {
        if (this.reason !== null) break;
        if (message.type === 'stream_event') {
          if (message.parent_tool_use_id !== null) continue;
          const event = message.event;
          if (event.type !== 'content_block_delta' || event.delta.type !== 'text_delta') continue;
          let text = event.delta.text;
          if (text === '') continue;
          if (this.caption !== '') {
            this.caption = '';
            yield { type: 'status', text: '' };
          }
          if (this.emittedText && this.toolSinceText) text = `\n\n${text.replace(/^\s+/, '')}`;
          this.toolSinceText = false;
          this.emittedText = true;
          yield { type: 'delta', text };
        } else if (message.type === 'assistant') {
          if (message.parent_tool_use_id !== null) continue;
          if (message.error !== undefined) lastError = message.error;
          for (const block of message.message.content) {
            if (block.type !== 'tool_use') continue;
            this.toolSinceText = true;
            const caption = captionForToolUse(block.name, block.input);
            if (caption !== null && caption !== this.caption) {
              this.caption = caption;
              yield { type: 'status', text: caption };
            }
          }
        } else if (message.type === 'result') {
          if (message.subtype === 'success' && !message.is_error) {
            this.outcome = { threadId: message.session_id, brain };
            succeeded = true;
          } else {
            failure = resultFailure(message, lastError, this.deps.chat.maxTurns);
          }
        }
      }
      drained = this.reason === null;
    } catch (err) {
      if (this.reason !== null) throw err;
      // A CLI that exits non-zero after its result still produced that result: trust the result.
      if (!succeeded && failure === null) {
        const text = errorText(err);
        failure = new AttemptError(text, isFallbackable(text, lastError));
      }
    } finally {
      this.controller.signal.removeEventListener('abort', relay);
      if (!drained) controller.abort();
    }
    if (this.reason !== null) throw new Error('stopped');
    if (failure !== null) throw failure;
    if (!succeeded) {
      throw new AttemptError('The agent ended without an answer.', lastError !== null && FALLBACK_ERRORS.has(lastError));
    }
  }
}

/**
 * The real chat brain: one Claude Agent SDK run per message (plan R1-R4).
 * Single user, so at most one run is in flight; a new reply() stops the previous one.
 */
export function createAgentChatBackend(options: AgentChatOptions): AgentChatBackend {
  const { chat, cwd, mcpUrl } = options;
  const query: QueryFn = options.query ?? sdkQuery;
  const now = options.now ?? (() => new Date());
  const baseEnv = options.baseEnv ?? process.env;
  const log = options.log ?? ((line: string) => console.warn(line));
  const readPreview = options.readPreview ?? ((absPath: string): Promise<Uint8Array> => readFile(absPath));
  const claudeBin = resolveExecutable(chat.claudeBin, baseEnv.PATH);
  const allowedTools = allowedChatTools();

  function optionsFor(brain: ChatBrain, resume: string | null, abortController: AbortController): Options {
    const glm = chat.glm;
    if (brain === 'glm' && glm === null) {
      throw new AttemptError('CHAT_BRAIN=glm needs LLM_BASE_URL, LLM_API_KEY and LLM_MODEL.', false);
    }
    return {
      abortController,
      cwd,
      env: brain === 'glm' && glm !== null ? glmEnv(baseEnv, glm) : claudeEnv(baseEnv),
      model: brain === 'glm' && glm !== null ? glm.model : undefined,
      pathToClaudeCodeExecutable: claudeBin,
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: { [NOTES_MCP_SERVER]: { type: 'http', url: mcpUrl(), alwaysLoad: true } },
      tools: [...WEB_TOOL_NAMES],
      allowedTools,
      permissionMode: 'dontAsk',
      includePartialMessages: true,
      maxTurns: chat.maxTurns,
      systemPrompt: buildChatSystemPrompt(now()),
      resume: resume ?? undefined,
    };
  }

  const deps: RunDeps = { chat, query, log, optionsFor, readPreview };
  let current: ChatRun | null = null;

  return {
    async reply(request: ChatRequest): Promise<ChatTurn> {
      if (current !== null && current.active) current.stop('superseded');
      const run = new ChatRun(deps, request);
      current = run;
      return {
        events: run.events(),
        end: () => run.end(),
      };
    },
    close(): void {
      if (current !== null && current.active) current.stop('closed');
    },
  };
}
