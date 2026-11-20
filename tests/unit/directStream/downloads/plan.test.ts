import { describe, expect, it } from 'vitest';
import { bandAllows, CLOUD_MAX_HEIGHT, finalFailure, isOffice, planDownload, stepsAfterCloud } from '../../../../src/directStream/downloads/plan.js';
import { parseRelease } from '../../../../src/directStream/torrent/find/index.js';

const HOME = { office: false, torrent: true, cloud: true };
const OFFICE = { office: true, torrent: true, cloud: true };
const H = 'ab'.repeat(20);
const c = (name: string, seeds: number) => ({ seeds, release: parseRelease(name) });

describe('R1.2 planDownload: the order with no source named', () => {
  it('is a 1080p torrent, then the cloud at 1080p or lower, then a torrent below 1080p', () => {
    expect(planDownload({ via: 'auto', infoHash: null }, HOME)).toEqual({
      ok: true,
      steps: [{ kind: 'torrent', band: 'preferred' }, { kind: 'cloud', maxHeight: 1080 }, { kind: 'torrent', band: 'below' }],
    });
    expect(CLOUD_MAX_HEIGHT).toBe(1080);
  });
  it('leaves out a side that is off', () => {
    expect(planDownload({ via: 'auto', infoHash: null }, { ...HOME, torrent: false })).toEqual({ ok: true, steps: [{ kind: 'cloud', maxHeight: 1080 }] });
    expect(planDownload({ via: 'auto', infoHash: null }, { ...HOME, cloud: false })).toEqual({ ok: true, steps: [{ kind: 'torrent', band: 'preferred' }, { kind: 'torrent', band: 'below' }] });
    expect(planDownload({ via: 'auto', infoHash: null }, { office: false, torrent: false, cloud: false })).toMatchObject({ ok: false, error: 'no_source' });
  });
  it('downloads only from the source named', () => {
    expect(planDownload({ via: 'cloud', infoHash: null }, HOME)).toEqual({ ok: true, steps: [{ kind: 'cloud', maxHeight: 1080 }] });
    expect(planDownload({ via: 'torrent', infoHash: null }, HOME)).toEqual({ ok: true, steps: [{ kind: 'torrent', band: 'preferred' }, { kind: 'torrent', band: 'below' }] });
    expect(planDownload({ via: 'torrent', infoHash: H }, HOME)).toEqual({ ok: true, steps: [{ kind: 'hash', infoHash: H }] });
  });
  it('goes on after a failed cache to what follows the cloud', () => {
    const plan = planDownload({ via: 'auto', infoHash: null }, HOME);
    if (!plan.ok) throw new Error('planned');
    expect(stepsAfterCloud(plan.steps)).toEqual([{ kind: 'torrent', band: 'below' }]);
  });
});

describe('R1.2 bandAllows: 1080p with live seeds, then below 1080p', () => {
  it('takes a 1080p release with live seeds into the preferred band, and nothing else', () => {
    expect(bandAllows('preferred', c('Film.2026.1080p.WEB-DL.x264', 12), null)).toBe(true);
    expect(bandAllows('preferred', c('Film.2026.1080p.WEB-DL.x264', 0), null)).toBe(false);
    expect(bandAllows('preferred', c('Film.2026.720p.WEB-DL.x264', 40), null)).toBe(false);
    expect(bandAllows('preferred', c('Film.2026.2160p.WEB-DL.x265', 40), null)).toBe(false);
  });
  it('believes the trackers over the index when they answered', () => {
    expect(bandAllows('preferred', c('Film.2026.1080p.WEB-DL.x264', 40), { seeders: 0, leechers: 3, trackers: 2 })).toBe(false);
    expect(bandAllows('preferred', c('Film.2026.1080p.WEB-DL.x264', 0), { seeders: 4, leechers: 1, trackers: 1 })).toBe(true);
    expect(bandAllows('preferred', c('Film.2026.1080p.WEB-DL.x264', 7), { seeders: 0, leechers: 0, trackers: 0 })).toBe(true);
  });
  it('takes 720p, 480p and an unsaid height below 1080p, never 1080p or 2160p', () => {
    expect(bandAllows('below', c('Film.2026.720p.WEB-DL.x264', 0), null)).toBe(true);
    expect(bandAllows('below', c('Film.2026.480p.DVDRip', 3), null)).toBe(true);
    expect(bandAllows('below', c('Film.2026.WEB-DL', 3), null)).toBe(true);
    expect(bandAllows('below', c('Film.2026.1080p.WEB-DL.x264', 3), null)).toBe(false);
    expect(bandAllows('below', c('Film.2026.2160p.WEB-DL.x265', 3), null)).toBe(false);
  });
});

describe('R1.4 planDownload: the office network', () => {
  it('reads SSID Employee as the office', () => {
    expect(isOffice('Employee')).toBe(true);
    expect(isOffice('kosan_baruu')).toBe(false);
    expect(isOffice(null)).toBe(false);
  });
  it('sends a download with no source named straight to the cloud', () => {
    expect(planDownload({ via: 'auto', infoHash: null }, OFFICE)).toEqual({ ok: true, steps: [{ kind: 'cloud', maxHeight: 1080 }] });
  });
  it('refuses a torrent asked for there with no_peers_here, and names WARP as never switched', () => {
    for (const ask of [{ via: 'torrent' as const, infoHash: null }, { via: 'torrent' as const, infoHash: H }]) {
      const plan = planDownload(ask, OFFICE);
      expect(plan).toMatchObject({ ok: false, error: 'no_peers_here' });
      if (!plan.ok) expect(plan.detail).toContain('WARP is never switched');
    }
    expect(planDownload({ via: 'auto', infoHash: null }, { ...OFFICE, cloud: false })).toMatchObject({ ok: false, error: 'no_peers_here' });
  });
});

describe('R1.11 finalFailure: why a download failed', () => {
  it('keeps one step’s own code, says dubbed when every step found only dubs, else no_source, naming each step', () => {
    expect(finalFailure([{ step: { kind: 'cloud', maxHeight: 1080 }, error: 'download_failed', detail: 'six tries' }])).toEqual({ error: 'download_failed', detail: 'cloud at 1080p or lower: download_failed (six tries)' });
    expect(finalFailure([{ step: { kind: 'torrent', band: 'preferred' }, error: 'dubbed', detail: '' }, { step: { kind: 'torrent', band: 'below' }, error: 'dubbed', detail: '' }]).error).toBe('dubbed');
    const mixed = finalFailure([
      { step: { kind: 'torrent', band: 'preferred' }, error: 'no_source', detail: 'Index: torrentio: no_stream' },
      { step: { kind: 'cloud', maxHeight: 1080 }, error: 'no_source', detail: '' },
      { step: { kind: 'torrent', band: 'below' }, error: 'dubbed', detail: '' },
    ]);
    expect(mixed.error).toBe('no_source');
    expect(mixed.detail).toBe('torrent 1080p: no_source (Index: torrentio: no_stream); cloud at 1080p or lower: no_source; torrent below 1080p: dubbed');
  });
});
