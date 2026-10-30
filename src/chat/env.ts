import { accessSync, constants } from 'node:fs';
import path from 'node:path';

/** The SDK's `options.env` shape. It replaces the child's environment wholesale. */
export type ChildEnv = Record<string, string | undefined>;

export interface GlmTarget {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Never inherited by an SDK child. A Claude run must use the owner's OAuth login, never a key or
 * a redirected base URL (plan invariant 3). The model overrides are dropped so a GLM model name
 * can never reach Anthropic. LLM_API_KEY is dropped in case someone exported it.
 * CLAUDECODE, CLAUDE_PID and CLAUDE_EFFORT are the markers a parent Claude Code session exports
 * to its shell: a daemon started from a Claude Code terminal (`npm run dev`, the live suite)
 * would otherwise hand them to the child, which then believes it is nested in that session.
 */
export const STRIPPED_ENV_KEYS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'LLM_API_KEY',
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
];

/**
 * Every `CLAUDE_CODE_*` key is dropped too: the parent session's markers (CLAUDE_CODE_ENTRYPOINT,
 * CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_CHILD_SESSION, CLAUDE_CODE_EXECPATH, ...), its
 * CLAUDE_CODE_PLUGIN_DIRS (plugins would break invariant 4), and provider switches such as
 * CLAUDE_CODE_USE_BEDROCK (which would bypass the login, invariant 3). CLAUDE_CONFIG_DIR is kept:
 * it is where the login lives when the owner moved it.
 */
export const STRIPPED_ENV_PREFIX = 'CLAUDE_CODE_';

function isStripped(key: string): boolean {
  return STRIPPED_ENV_KEYS.includes(key) || key.startsWith(STRIPPED_ENV_PREFIX);
}

/** Sent in the SDK's User-Agent so these runs are recognisable. */
export const CLIENT_APP = 'mcp-notes-chat/0.1.0';

function baseChildEnv(base: NodeJS.ProcessEnv): ChildEnv {
  const env: ChildEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || isStripped(key)) continue;
    env[key] = value;
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = CLIENT_APP;
  return env;
}

/** Env for a Claude run: the daemon's env (PATH, HOME, ...) minus every key/base-url/model override. */
export function claudeEnv(base: NodeJS.ProcessEnv): ChildEnv {
  return baseChildEnv(base);
}

/** Env for a GLM run: the same code pointed at an Anthropic-compatible endpoint. */
export function glmEnv(base: NodeJS.ProcessEnv, glm: GlmTarget): ChildEnv {
  return {
    ...baseChildEnv(base),
    ANTHROPIC_BASE_URL: glm.baseUrl,
    ANTHROPIC_AUTH_TOKEN: glm.apiKey,
    ANTHROPIC_MODEL: glm.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: glm.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: glm.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: glm.model,
  };
}

/**
 * Absolute path for `bin`. A path containing "/" is resolved against the cwd. A bare name
 * ("claude", the config default) is looked up on `pathEnv`. When nothing is found the name
 * comes back unchanged, and the SDK's own "executable not found" error names it.
 */
export function resolveExecutable(bin: string, pathEnv: string | undefined): string {
  if (bin.includes('/')) return path.resolve(bin);
  for (const dir of (pathEnv ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    const candidate = path.join(dir, bin);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here; try the next PATH entry
    }
  }
  return bin;
}
