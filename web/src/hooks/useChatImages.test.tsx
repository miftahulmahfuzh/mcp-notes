// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ChatImageUpload } from '../api';
import { MAX_CHAT_IMAGES, useChatImages } from './useChatImages';

afterEach(cleanup);

function uploadOf(id: string, created = true): ChatImageUpload {
  return {
    created,
    image: {
      id,
      mime: 'image/png',
      width: 1,
      height: 1,
      bytes: 1,
      original_name: 'a.png',
      host: 'lenovo',
      source: 'wall',
      created_at: '2026-10-31T01:00:00.000Z',
      available: true,
      urls: {
        thumb: `/api/chat/images/${id}/thumb`,
        display: `/api/chat/images/${id}/display`,
        original: `/api/chat/images/${id}/original`,
        preview: `/api/chat/images/${id}/preview`,
      },
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const png = (name = 'a.png') => new File(['png'], name, { type: 'image/png' });

describe('useChatImages', () => {
  it('uploads a pasted file at once: uploading, then ready with its thumb', async () => {
    const d = deferred<ChatImageUpload>();
    const upload = vi.fn(() => d.promise);
    const { result } = renderHook(() => useChatImages(upload));
    act(() => result.current.add([png()]));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(result.current.images).toMatchObject([{ state: 'uploading', label: 'a.png', id: null }]);
    expect(result.current.blocked).toBe(true);
    expect(result.current.readyIds).toEqual([]);
    await act(async () => {
      d.resolve(uploadOf('U-PL1'));
      await d.promise;
    });
    expect(result.current.images).toMatchObject([{ state: 'ready', id: 'U-PL1', thumbUrl: '/api/chat/images/U-PL1/thumb' }]);
    expect(result.current.readyIds).toEqual(['U-PL1']);
    expect(result.current.blocked).toBe(false);
  });

  it('marks a failed upload, which blocks sending until removed', async () => {
    const d = deferred<ChatImageUpload>();
    const { result } = renderHook(() => useChatImages(() => d.promise));
    act(() => result.current.add([png()]));
    await act(async () => {
      d.reject(new Error('too_large'));
      await d.promise.catch(() => undefined);
    });
    expect(result.current.images).toMatchObject([{ state: 'failed', error: 'too_large' }]);
    expect(result.current.blocked).toBe(true);
    act(() => result.current.remove(result.current.images[0]!.key));
    expect(result.current.images).toEqual([]);
    expect(result.current.blocked).toBe(false);
  });

  it(`caps a message at ${MAX_CHAT_IMAGES} images; the rest show as failed and are not uploaded`, () => {
    const upload = vi.fn(() => new Promise<ChatImageUpload>(() => {}));
    const { result } = renderHook(() => useChatImages(upload));
    act(() => result.current.add([png('1.png'), png('2.png'), png('3.png'), png('4.png'), png('5.png')]));
    expect(upload).toHaveBeenCalledTimes(MAX_CHAT_IMAGES);
    expect(result.current.images.map((i) => i.state)).toEqual(['uploading', 'uploading', 'uploading', 'uploading', 'failed']);
    expect(result.current.images[4]?.error).toBe(`at most ${MAX_CHAT_IMAGES} images per message`);
  });

  it('a removed image ignores its late upload result; clear empties the bar', async () => {
    const d = deferred<ChatImageUpload>();
    const { result } = renderHook(() => useChatImages(() => d.promise));
    act(() => result.current.add([png()]));
    act(() => result.current.remove(result.current.images[0]!.key));
    await act(async () => {
      d.resolve(uploadOf('U-PL1'));
      await d.promise;
    });
    expect(result.current.images).toEqual([]);
    act(() => result.current.add([png()]));
    act(() => result.current.clear());
    expect(result.current.images).toEqual([]);
  });

  it('the same bytes pasted twice are sent once', async () => {
    const { result } = renderHook(() => useChatImages(async () => uploadOf('U-PL1', false)));
    act(() => result.current.add([png('a.png'), png('b.png')]));
    await waitFor(() => expect(result.current.images.every((i) => i.state === 'ready')).toBe(true));
    expect(result.current.images).toHaveLength(2);
    expect(result.current.readyIds).toEqual(['U-PL1']);
  });
});
