import { describe, expect, it } from 'vitest';
import { downloadOn, downloadRef, onColumns } from '../../../../src/directStream/downloads/repo.js';
import { downloadRecordsContract } from '../../../helpers/downloadRecordsContract.js';
import { MemoryDownloadRecords } from '../../../helpers/memoryDownloadRecords.js';

downloadRecordsContract('in memory', async () => new MemoryDownloadRecords());

describe('a download row', () => {
  it('names its title and what it fetches from', () => {
    expect(downloadRef({ kind: 'movie', tmdbId: 550, season: 0, episode: 0 })).toEqual({ kind: 'movie', tmdbId: 550 });
    expect(downloadRef({ kind: 'tv', tmdbId: 1399, season: 2, episode: 3 })).toEqual({ kind: 'tv', tmdbId: 1399, season: 2, episode: 3 });
    expect(downloadOn({ source: null, sourceId: null })).toBeNull();
    expect(downloadOn({ source: 'torrent', sourceId: 'a'.repeat(40) })).toEqual({ source: 'torrent', infoHash: 'a'.repeat(40) });
    expect(downloadOn({ source: 'cloud', sourceId: 'c1' })).toEqual({ source: 'cloud', cacheId: 'c1' });
    expect(onColumns({ source: 'cloud', cacheId: 'c1' })).toEqual({ source: 'cloud', sourceId: 'c1' });
  });

  it('refuses a picked torrent without via torrent, as the CHECK does', async () => {
    await expect(new MemoryDownloadRecords().create('h', { ref: { kind: 'movie', tmdbId: 1 }, via: 'auto', infoHash: 'a'.repeat(40) }, new Date())).rejects.toThrow(/info_hash/);
  });
});
