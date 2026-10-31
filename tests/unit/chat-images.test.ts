import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chatImageCacheId, chatImageRelPath, chatImageUrl, toChatImage } from '../../src/chat/images.js';
import type { ChatImageRow } from '../../src/db/schema.js';
import { cacheDirFor } from '../../src/images/store.js';
import { ID_PATTERN } from '../../src/notes/ids.js';

describe('chat image paths', () => {
  it('stores originals under chat-images/YYYY/MM in local time of the save', () => {
    expect(chatImageRelPath('A-B32', 'png', new Date(2026, 9, 31, 10))).toBe('chat-images/2026/10/A-B32.png');
    expect(chatImageRelPath('A-B32', 'jpg', new Date(2027, 0, 1, 0))).toBe('chat-images/2027/01/A-B32.jpg');
  });
  it('keys derivatives by c_<id>: one path segment that no note image id can equal', () => {
    const key = chatImageCacheId('A-B32');
    expect(key).toBe('c_A-B32');
    expect(path.basename(key)).toBe(key);
    expect(ID_PATTERN.test(key)).toBe(false);
    expect(cacheDirFor('/data', key)).toBe(path.join(path.resolve('/data'), 'cache', 'c_A-B32'));
  });
  it('names the variant urls under /api/chat/images', () => {
    expect(chatImageUrl('A-B32', 'thumb')).toBe('/api/chat/images/A-B32/thumb');
  });
});

describe('toChatImage', () => {
  it('is the wire shape', () => {
    const row: ChatImageRow = {
      id: 'A-B32',
      path: 'chat-images/2026/10/A-B32.png',
      sha256: 'a'.repeat(64),
      mime: 'image/png',
      width: 40,
      height: 30,
      bytes: 123,
      originalName: 'shot.png',
      host: 'lenovo',
      source: 'wall',
      createdAt: new Date('2026-10-31T01:02:03.000Z'),
    };
    expect(toChatImage(row, true)).toEqual({
      id: 'A-B32',
      mime: 'image/png',
      width: 40,
      height: 30,
      bytes: 123,
      original_name: 'shot.png',
      host: 'lenovo',
      source: 'wall',
      created_at: '2026-10-31T01:02:03.000Z',
      available: true,
      urls: {
        original: '/api/chat/images/A-B32/original',
        display: '/api/chat/images/A-B32/display',
        thumb: '/api/chat/images/A-B32/thumb',
        preview: '/api/chat/images/A-B32/preview',
      },
    });
  });
});
