import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  HTTP_API_FILE,
  MCP_TOOLS_FILE,
  envVarProblems,
  httpRouteProblems,
  linkProblems,
  listHttpRoutes,
  listMcpTools,
  renderHttpApi,
  renderMcpTools,
} from '../../../scripts/docs/reference.js';

// The docs under docs/guide are checked against the code, so they cannot drift quietly.
// A failure here is fixed with `npm run docs:gen`, or by editing the file the message names.
describe('docs reference', () => {
  it('mcp-tools.md lists the tools the server registers', async () => {
    expect(readFileSync(MCP_TOOLS_FILE, 'utf8')).toBe(renderMcpTools(await listMcpTools()));
  });

  it('every HTTP route is described, and nothing else is', () => {
    expect(httpRouteProblems(listHttpRoutes())).toEqual([]);
  });

  it('http-api.md matches the described routes', () => {
    expect(readFileSync(HTTP_API_FILE, 'utf8')).toBe(renderHttpApi());
  });

  it('configuration.md documents every environment variable the code reads', () => {
    expect(envVarProblems()).toEqual([]);
  });

  it('README, CLAUDE.md and the guide have no broken links or orphaned pictures', () => {
    expect(linkProblems()).toEqual([]);
  });
});
