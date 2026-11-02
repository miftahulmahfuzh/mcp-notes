// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Play } from '@phosphor-icons/react';
import { ConfirmDialog } from './ConfirmDialog';

afterEach(cleanup);

describe('ConfirmDialog', () => {
  it('defaults to the trash "Delete anyway" button', () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog message="Delete it?" onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete anyway' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('takes another label and icon for a non-delete question', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog message="Resume anyway?" confirmLabel="Try anyway" confirmIcon={<Play weight="duotone" />} onConfirm={onConfirm} onCancel={onCancel} />,
    );
    expect(screen.queryByRole('button', { name: 'Delete anyway' })).toBeNull();
    const yes = screen.getByRole('button', { name: 'Try anyway' });
    expect(yes.getAttribute('data-tip')).toBe('Try anyway');
    fireEvent.click(yes);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
