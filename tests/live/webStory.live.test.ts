import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWebStoryWriter, SEARCH_RESULTS_CARRY_URLS } from '../../src/movies/webStory.js';

/**
 * One real, billed web story run (npm run test:live:webStory): the owner's claude login, WebSearch as the one tool.
 * It proves Step 0's answer on the installed SDK: under SEARCH_RESULTS_CARRY_URLS as set, a well-covered episode comes
 * back told, with at least one source. Were the constant wrong, every section would come back `found: false`.
 */
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'notesd-web-story-live-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe(`a real web story run (SEARCH_RESULTS_CARRY_URLS = ${SEARCH_RESULTS_CARRY_URLS})`, () => {
  it('tells a well-covered episode from a page it found, and names that page', async () => {
    const lines: string[] = [];
    const writer = createWebStoryWriter({ claudeBin: 'claude', cwd: dir, model: 'sonnet', log: (line) => void lines.push(line) });
    if (writer === null) throw new Error('no claude binary on PATH');
    const story = await writer.write({
      title: 'Breaking Bad (2008)',
      originalTitle: null,
      overview: null,
      scope: 'episode',
      season: 1,
      episodes: [{ episode: 1, name: 'Pilot', airDate: '2008-01-20' }],
    });
    expect(story.sections[0]?.found).toBe(true);
    expect(story.sources.length).toBeGreaterThan(0);
    expect(story.sources.every((s) => /^https?:\/\//.test(s.url))).toBe(true);
    expect(lines.some((l) => l.includes('could not be cross-checked'))).toBe(!SEARCH_RESULTS_CARRY_URLS);
  });
});
