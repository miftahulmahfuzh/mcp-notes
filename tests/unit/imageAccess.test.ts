import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import type { ChatImageRow } from '../../src/db/schema.js';
import {
  CHAT_IMAGE_ID_HINT,
  etagMatches,
  expandHome,
  ImageInputError,
  oneImageSource,
  resolveChatImageFile,
} from '../../src/http/imageAccess.js';

describe('expandHome', () => {
  it('expands ~ and ~/', () => {
    expect(expandHome('~', '/home/u')).toBe('/home/u');
    expect(expandHome('~/Pictures/a.png', '/home/u')).toBe('/home/u/Pictures/a.png');
  });
  it('leaves other paths alone', () => {
    expect(expandHome('/tmp/a.png', '/home/u')).toBe('/tmp/a.png');
    expect(expandHome('~other/a.png', '/home/u')).toBe('~other/a.png');
    expect(expandHome('rel/a.png', '/home/u')).toBe('rel/a.png');
  });
});

describe('etagMatches', () => {
  it('matches exact, weak, listed and *', () => {
    expect(etagMatches('"abc"', '"abc"')).toBe(true);
    expect(etagMatches('W/"abc"', '"abc"')).toBe(true);
    expect(etagMatches('"x", "abc"', '"abc"')).toBe(true);
    expect(etagMatches('*', '"abc"')).toBe(true);
  });
  it('rejects missing or different tags', () => {
    expect(etagMatches(undefined, '"abc"')).toBe(false);
    expect(etagMatches('"abd"', '"abc"')).toBe(false);
  });
});

/** The ImageInputError a promise or function threw, or a failing assertion. */
async function inputError(fn: () => unknown): Promise<ImageInputError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ImageInputError);
    return err as ImageInputError;
  }
  throw new Error('expected an ImageInputError');
}

describe('oneImageSource', () => {
  it('takes a path alone', () => {
    expect(oneImageSource({ path: '/tmp/a.png' })).toEqual({ kind: 'path', path: '/tmp/a.png' });
    expect(oneImageSource({ path: '/tmp/a.png', image_id: undefined })).toEqual({ kind: 'path', path: '/tmp/a.png' });
  });
  it('takes an image_id alone', () => {
    expect(oneImageSource({ image_id: 'g0nc' })).toEqual({ kind: 'image_id', imageId: 'g0nc' });
  });
  it('refuses both and neither with bad_arguments', async () => {
    for (const args of [{}, { path: undefined, image_id: undefined }, { path: '/tmp/a.png', image_id: 'G-0NC' }]) {
      const err = await inputError(() => oneImageSource(args));
      expect(err.code).toBe('bad_arguments');
      expect(err.message).toBe('give exactly one of path or image_id');
    }
  });
});

/** A Db whose only query (`select().from().where().limit()`) returns `rows`. */
function fakeDb(rows: ChatImageRow[]): Db {
  // Annotated: a self-referencing initializer would otherwise be an implicit-any error (TS7022).
  const q: { from: () => unknown; where: () => unknown; limit: () => Promise<ChatImageRow[]> } = {
    from: () => q,
    where: () => q,
    limit: async () => rows,
  };
  return { select: () => q } as unknown as Db;
}

function chatRow(over: Partial<ChatImageRow> = {}): ChatImageRow {
  return {
    id: 'G-0NC',
    path: 'chat-images/2026/10/G-0NC.png',
    sha256: 'a'.repeat(64),
    mime: 'image/png',
    width: 40,
    height: 30,
    bytes: 123,
    originalName: 'pasted.png',
    host: 'lenovo',
    source: 'wall',
    createdAt: new Date('2026-10-31T01:02:03.000Z'),
    ...over,
  };
}

describe('resolveChatImageFile', () => {
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'mcp-notes-chatfile-'));
  });
  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('refuses a string that cannot be an id as unknown_chat_image, with the hint', async () => {
    const err = await inputError(() => resolveChatImageFile({ db: fakeDb([]), dataDir }, ' not-an-id '));
    expect(err.code).toBe('unknown_chat_image');
    expect(err.message).toBe(`no pasted image not-an-id. ${CHAT_IMAGE_ID_HINT}`);
  });

  it('names an unknown id in canonical form', async () => {
    const err = await inputError(() => resolveChatImageFile({ db: fakeDb([]), dataDir }, 'g0nc'));
    expect(err.code).toBe('unknown_chat_image');
    expect(err.message).toBe(
      'no pasted image G-0NC. Pasted image ids look like G-0NC and appear as [image upload:ID] in chat or in the pasted-images note of a Claude Code /n prompt',
    );
  });

  it('refuses a row whose original is not on this machine, naming its host', async () => {
    const err = await inputError(() =>
      resolveChatImageFile({ db: fakeDb([chatRow({ id: 'H-0ST', path: 'chat-images/2026/10/H-0ST.png', host: 'other-laptop' })]), dataDir }, 'H-0ST'),
    );
    expect(err.code).toBe('not_on_this_machine');
    expect(err.message).toBe('pasted image H-0ST is stored on other-laptop, not on this machine');
  });

  it('says "another machine" when the row has no host', async () => {
    const err = await inputError(() =>
      resolveChatImageFile({ db: fakeDb([chatRow({ id: 'N-0HS', path: 'chat-images/2026/10/N-0HS.png', host: null })]), dataDir }, 'N-0HS'),
    );
    expect(err.message).toBe('pasted image N-0HS is stored on another machine, not on this machine');
  });

  it('returns the original under the data dir when it is here', async () => {
    const rel = 'chat-images/2026/10/G-0NC.png';
    await mkdir(path.join(dataDir, 'chat-images/2026/10'), { recursive: true });
    await writeFile(path.join(dataDir, rel), Buffer.from([1, 2, 3]));
    const file = await resolveChatImageFile({ db: fakeDb([chatRow({ path: rel })]), dataDir }, 'g-0nc');
    expect(file).toEqual({ id: 'G-0NC', absPath: path.join(path.resolve(dataDir), rel), originalName: 'pasted.png' });
  });
});
