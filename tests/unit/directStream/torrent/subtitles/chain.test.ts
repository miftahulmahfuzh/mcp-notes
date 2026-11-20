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
  it('orders kept, files, service, borrow; files is asked aside, the others block; without a service address the service is left out', () => {
    const tiers = buildSubtitleTiers({ ...deps, subtitleUrl: 'https://subs.fixture' });
    expect(tiers.map((t) => t.name)).toEqual(['kept', 'files', 'service', 'borrow']);
    expect(tiers.map((t) => [t.name, t.blocks, t.aside === true, t.release === true])).toEqual([
      ['kept', true, false, false],
      ['files', false, true, true],
      ['service', true, false, false],
      ['borrow', true, false, false],
    ]);
    expect(buildSubtitleTiers({ ...deps, subtitleUrl: null }).map((t) => t.name)).toEqual(['kept', 'files', 'borrow']);
  });
});
