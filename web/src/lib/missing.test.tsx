import { describe, expect, it, vi } from 'vitest';
import { missingReason, remoteCaption } from './missing';

const res = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });

describe('missingReason', () => {
  it('reads not_on_this_machine with its host', async () => {
    expect(await missingReason('/x', vi.fn(res(404, { error: 'not_on_this_machine', host: 'GPD' })))).toEqual({ kind: 'remote', host: 'GPD' });
    expect(await missingReason('/x', vi.fn(res(404, { error: 'not_on_this_machine', host: null })))).toEqual({ kind: 'remote', host: null });
  });
  it('anything else is broken', async () => {
    expect(await missingReason('/x', vi.fn(res(404, { error: 'not_found' })))).toEqual({ kind: 'broken' });
    expect(await missingReason('/x', vi.fn(res(500, {})))).toEqual({ kind: 'broken' });
    expect(await missingReason('/x', vi.fn(async () => { throw new Error('offline'); }))).toEqual({ kind: 'broken' });
  });
  it('captions the host', () => {
    expect(remoteCaption('GPD')).toBe('uploaded on GPD');
    expect(remoteCaption(null)).toBe('uploaded on another device');
  });
});
