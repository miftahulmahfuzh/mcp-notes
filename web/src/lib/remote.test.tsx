import { describe, expect, it } from 'vitest';
import { hostsLabel, remoteDeleteQuestion, remoteFilesOf } from './remote';
import { makeFile, makeImage, makeNote } from '../testing/fixtures';

const away = { host: 'GPD', available: false };

describe('remote files', () => {
  it('counts images and files not on this machine, hosts in first-seen order', () => {
    const n = {
      ...makeNote('A-B32', 'x'),
      images: [makeImage('I-001', away), makeImage('I-002'), makeImage('I-003', { host: 'K-NES', available: false })],
      files: [makeFile('F-001', away)],
    };
    expect(remoteFilesOf(n)).toEqual({ count: 3, hosts: ['GPD', 'K-NES'] });
    expect(remoteDeleteQuestion(n)).toBe('A-B32 has 3 files on GPD and K-NES. Delete it anyway?');
  });
  it('asks nothing when everything is local', () => {
    const n = { ...makeNote('A-B32', 'x'), images: [makeImage('I-001')] };
    expect(remoteFilesOf(n).count).toBe(0);
    expect(remoteDeleteQuestion(n)).toBeNull();
  });
  it('labels hosts', () => {
    expect(hostsLabel([])).toBe('another device');
    expect(hostsLabel(['GPD'])).toBe('GPD');
    expect(hostsLabel(['A', 'B', 'C'])).toBe('A, B and C');
  });
});
