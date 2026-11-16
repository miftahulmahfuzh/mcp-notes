import { describe, expect, it } from 'vitest';
import { buildSubtitleTiers } from '../../../../../src/directStream/torrent/subtitles/chain.js';
import type { TorrentStreams } from '../../../../../src/directStream/torrent/service.js';

describe('buildSubtitleTiers', () => {
  const deps = {
    torrentDir: '/tmp/none',
    torrents: { filePath: async () => null } as unknown as TorrentStreams,
    log: () => undefined,
    fetch: async () => new Response(''),
    lend: () => null,
  };
  it('orders kept, files, service, borrow, every one blocking; without a service address the service is left out', () => {
    const tiers = buildSubtitleTiers({ ...deps, subtitleUrl: 'https://subs.fixture' });
    expect(tiers.map((t) => t.name)).toEqual(['kept', 'files', 'service', 'borrow']);
    expect(tiers.every((t) => t.blocks)).toBe(true);
    expect(buildSubtitleTiers({ ...deps, subtitleUrl: null }).map((t) => t.name)).toEqual(['kept', 'files', 'borrow']);
  });
});
