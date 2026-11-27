import { describe, expect, it } from 'vitest';
import type { FindAnswer } from '../../../../../src/directStream/torrent/source.js';
import { CandidateListings, LISTINGS_KEPT } from '../../../../../src/directStream/torrent/source/listing.js';
import { swarmCounts, trackersOf } from '../../../../../src/directStream/torrent/source/trackers.js';
import type { TrackerBook } from '../../../../../src/directStream/torrent/origins.js';

const book = (urls: string[]) => ({ list: () => urls }) as unknown as TrackerBook;

describe('trackersOf: the candidate\'s, then the book\'s, then the lists\'', () => {
  it('keeps the order and drops a second spelling of one tracker', () => {
    const out = trackersOf({ book: book(['udp://open.tracker:1337/announce', 'udp://b.example:80/announce']), lists: { list: () => ['udp://c.example:6969/announce'] } }, { trackers: ['udp://open.tracker:1337'] });
    expect(out[0]).toBe('udp://open.tracker:1337');
    expect(out).toContain('udp://b.example:80/announce');
    expect(out.at(-1)).toBe('udp://c.example:6969/announce');
    expect(out.filter((t) => t.includes('open.tracker'))).toHaveLength(1);
  });

  it('with no book and no lists, only the candidate\'s', () => {
    expect(trackersOf({}, { trackers: ['udp://a:1'] })).toEqual(['udp://a:1']);
  });
});

describe('swarmCounts: asked before any swarm is joined, never throws', () => {
  const c = { infoHash: 'a'.repeat(40), trackers: ['udp://a:1'] };

  it('asks nobody without a scraper or candidates', async () => {
    expect((await swarmCounts({}, () => undefined, [c])).size).toBe(0);
    let asked = 0;
    const scrape = async () => {
      asked += 1;
      return new Map();
    };
    expect((await swarmCounts({ scrape }, () => undefined, [])).size).toBe(0);
    expect(asked).toBe(0);
  });

  it('a scraper that throws is logged and answers nothing', async () => {
    const lines: string[] = [];
    const scrape = async (): Promise<never> => {
      throw new Error('udp down');
    };
    expect((await swarmCounts({ scrape }, (l) => lines.push(l), [c])).size).toBe(0);
    expect(lines).toEqual(['[notesd] torrent: the trackers could not be asked: udp down']);
  });

  it('passes the timeout only when one is given', async () => {
    const seen: unknown[] = [];
    const scrape = async (_h: readonly string[], _t: readonly string[], o: unknown) => {
      seen.push(o);
      return new Map();
    };
    await swarmCounts({ scrape }, () => undefined, [c]);
    await swarmCounts({ scrape }, () => undefined, [c], 2500);
    expect(seen).toEqual([{}, { timeoutMs: 2500 }]);
  });
});

describe('CandidateListings: the finder\'s last answer per title', () => {
  const found = {} as FindAnswer;

  it('keeps when it was asked, and forgets the oldest past LISTINGS_KEPT titles', () => {
    let t = 0;
    const l = new CandidateListings(() => t);
    for (let i = 0; i <= LISTINGS_KEPT; i += 1) {
      t = i;
      l.keep(`movie:${i}`, found);
    }
    expect(l.get('movie:0')).toBeNull();
    expect(l.get('movie:1')?.at).toBe(1);
    expect(l.get(`movie:${LISTINGS_KEPT}`)?.found).toBe(found);
  });
});
