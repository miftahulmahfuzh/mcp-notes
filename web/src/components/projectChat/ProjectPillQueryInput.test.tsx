// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ProjectPillQueryInput } from './ProjectPillQueryInput';

afterEach(() => {
  cleanup();
});

function textarea(): HTMLTextAreaElement {
  const el = screen.getByLabelText('Ask about mcp-notes');
  if (!(el instanceof HTMLTextAreaElement)) throw new Error('pill is not a textarea');
  return el;
}

describe('ProjectPillQueryInput', () => {
  it('renders the pill under its test id, named after the repo', () => {
    render(<ProjectPillQueryInput repo="mcp-notes" onSend={vi.fn(() => true)} />);
    const pill = screen.getByTestId('project-pill-query-input');
    expect(pill.getAttribute('data-project')).toBe('mcp-notes');
    expect(textarea().placeholder).toBe('Ask about mcp-notes');
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });

  it('Enter sends the draft and clears it', () => {
    const onSend = vi.fn(() => true);
    render(<ProjectPillQueryInput repo="mcp-notes" onSend={onSend} />);
    fireEvent.change(textarea(), { target: { value: 'what did the orch do?' } });
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('what did the orch do?', [], []);
    expect(textarea().value).toBe('');
  });

  it('keeps the draft when the send is refused, and never sends a blank', () => {
    const onSend = vi.fn(() => false);
    render(<ProjectPillQueryInput repo="mcp-notes" onSend={onSend} />);
    fireEvent.change(textarea(), { target: { value: '   ' } });
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.change(textarea(), { target: { value: 'again' } });
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(textarea().value).toBe('again');
  });
});
