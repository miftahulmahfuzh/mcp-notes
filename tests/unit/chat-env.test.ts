import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLIENT_APP, claudeEnv, glmEnv, resolveExecutable } from '../../src/chat/env.js';

const BASE: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/owner',
  ANTHROPIC_API_KEY: 'sk-ant-should-not-leak',
  ANTHROPIC_BASE_URL: 'https://proxy.example',
  ANTHROPIC_AUTH_TOKEN: 'tok-should-not-leak',
  ANTHROPIC_MODEL: 'glm-5.3',
  LLM_API_KEY: 'glm-should-not-leak',
};

const GLM = { baseUrl: 'https://api.z.ai/api/anthropic', apiKey: 'glm-key', model: 'glm-5.3' };

describe('claudeEnv', () => {
  it('keeps PATH and HOME and strips every key, base url and model override', () => {
    const env = claudeEnv(BASE);
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HOME).toBe('/home/owner');
    expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe(CLIENT_APP);
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'LLM_API_KEY']) {
      expect(env).not.toHaveProperty(key);
    }
  });

  it('does not mutate its input', () => {
    claudeEnv(BASE);
    expect(BASE.ANTHROPIC_API_KEY).toBe('sk-ant-should-not-leak');
  });

  it('drops the markers of a parent Claude Code session but keeps CLAUDE_CONFIG_DIR', () => {
    const env = claudeEnv({
      ...BASE,
      CLAUDECODE: '1',
      CLAUDE_PID: '4242',
      CLAUDE_EFFORT: 'high',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SESSION_ID: 'parent-session',
      CLAUDE_CODE_PLUGIN_DIRS: '/home/owner/plugins',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CONFIG_DIR: '/home/owner/.claude',
    });
    for (const key of [
      'CLAUDECODE',
      'CLAUDE_PID',
      'CLAUDE_EFFORT',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_CODE_PLUGIN_DIRS',
      'CLAUDE_CODE_USE_BEDROCK',
    ]) {
      expect(env).not.toHaveProperty(key);
    }
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/owner/.claude');
    expect(glmEnv({ ...BASE, CLAUDECODE: '1' }, GLM)).not.toHaveProperty('CLAUDECODE');
  });
});

describe('glmEnv', () => {
  it('points the child at the GLM endpoint with the GLM token and model', () => {
    const env = glmEnv(BASE, GLM);
    expect(env.ANTHROPIC_BASE_URL).toBe(GLM.baseUrl);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('glm-key');
    expect(env.ANTHROPIC_MODEL).toBe('glm-5.3');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5.3');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5.3');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-5.3');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('LLM_API_KEY');
    expect(env.PATH).toBe('/usr/bin:/bin');
  });
});

describe('resolveExecutable', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('finds a bare name on PATH', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'chat-env-'));
    dirs.push(dir);
    const bin = path.join(dir, 'claude');
    writeFileSync(bin, '#!/bin/sh\n');
    chmodSync(bin, 0o755);
    expect(resolveExecutable('claude', `/nonexistent${path.delimiter}${dir}`)).toBe(bin);
  });

  it('keeps an absolute path', () => {
    expect(resolveExecutable('/opt/claude/bin/claude', '/usr/bin')).toBe('/opt/claude/bin/claude');
  });

  it('returns the bare name when nothing on PATH matches', () => {
    expect(resolveExecutable('claude-not-installed-here', '/nonexistent')).toBe('claude-not-installed-here');
  });
});
