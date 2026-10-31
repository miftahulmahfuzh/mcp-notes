// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { Bubble } from './Bubble';
import { makeMessage } from '../testing/chatFixtures';

afterEach(cleanup);

const NOW = new Date('2026-10-31T05:00:00.000Z');

function renderBubble(over: Parameters<typeof makeMessage>[1]) {
  const msg = makeMessage('K7F2', { thread_id: 'T-HR1', ...over });
  const onOpenImages = vi.fn();
  const view = render(
    <ol>
      <Bubble item={{ key: msg.id, msg, local: null }} now={NOW} focused={false} onOpenImages={onOpenImages} />
    </ol>,
  );
  return { ...view, onOpenImages };
}

describe('Bubble pictures', () => {
  it('shows a note image attached with "chat about this image" as a clickable thumbnail, with no redundant pill', () => {
    const { container, onOpenImages } = renderBubble({
      role: 'user',
      text: 'move this',
      attachments: [{ kind: 'note_image', id: '9-TD6', url: '/api/images/9-TD6/display', thumb_url: '/api/images/9-TD6/thumb' }],
    });
    const thumb = container.querySelector('.bubble-thumb') as HTMLButtonElement;
    expect(thumb.querySelector('img')!.getAttribute('src')).toBe('/api/images/9-TD6/thumb');
    expect(thumb.getAttribute('data-tip')).toBe('img:9-TD6');
    expect(container.querySelector('.bubble-chip')).toBeNull();
    fireEvent.click(thumb);
    expect(onOpenImages).toHaveBeenCalledWith([{ id: '9-TD6', src: '/api/images/9-TD6/display', label: 'img:9-TD6' }], 0);
  });

  it('keeps a pill for a note file', () => {
    const { container } = renderBubble({
      role: 'user',
      text: 'x',
      attachments: [{ kind: 'note_file', id: 'F-123', url: '/api/files/F-123/download', thumb_url: null }],
    });
    expect(container.querySelector('.bubble-chip')!.textContent).toBe('file F-123');
  });

  it('turns img:ID and upload:ID in the text into buttons that open that picture, and leaves a bare id alone', () => {
    const { container, onOpenImages } = renderBubble({ role: 'assistant', text: 'Moved img:9-TD6 out of 9-TD6; the paste was upload:g-0nc.', brain: 'claude' });
    const tokens = [...container.querySelectorAll('[data-img-token]')] as HTMLButtonElement[];
    expect(tokens.map((t) => t.getAttribute('data-img-token'))).toEqual(['img:9-TD6', 'upload:G-0NC']);
    fireEvent.click(tokens[0]!);
    expect(onOpenImages).toHaveBeenLastCalledWith([{ id: '9-TD6', src: '/api/images/9-TD6/display', label: 'img:9-TD6' }], 0);
    fireEvent.click(tokens[1]!);
    expect(onOpenImages.mock.calls[1]![0][0].src).toContain('/G-0NC/');
  });
});
