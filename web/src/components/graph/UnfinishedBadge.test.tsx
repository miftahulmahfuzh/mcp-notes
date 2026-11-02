// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { UNFINISHED_TIP, UnfinishedBadgeSvg, UnfinishedPill } from './UnfinishedBadge';

afterEach(() => {
  cleanup();
});

function inSvg(node: React.ReactNode) {
  return render(<svg>{node}</svg>);
}

describe('UnfinishedBadgeSvg', () => {
  it('renders only for unfinished === true', () => {
    for (const value of [null, false, undefined]) {
      inSvg(<UnfinishedBadgeSvg unfinished={value} x={0} y={0} />);
      expect(screen.queryByTestId('unfinished-badge')).toBeNull();
      cleanup();
    }
    inSvg(<UnfinishedBadgeSvg unfinished x={12} y={4} />);
    const badge = screen.getByTestId('unfinished-badge');
    expect(badge.getAttribute('transform')).toBe('translate(12 4)');
    expect(badge.textContent).toContain('unfinished');
    expect(badge.querySelector('title')?.textContent).toBe(UNFINISHED_TIP);
  });
});

describe('UnfinishedPill', () => {
  it('renders only for unfinished === true', () => {
    render(<UnfinishedPill unfinished={null} />);
    expect(screen.queryByTestId('unfinished-pill')).toBeNull();
    cleanup();
    render(<UnfinishedPill unfinished={false} />);
    expect(screen.queryByTestId('unfinished-pill')).toBeNull();
    cleanup();
    render(<UnfinishedPill unfinished />);
    const pill = screen.getByTestId('unfinished-pill');
    expect(pill.textContent).toBe('unfinished');
    expect(pill.getAttribute('data-tip')).toBe(UNFINISHED_TIP);
  });
});
