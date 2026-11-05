// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { OVERVIEW } from '../../testing/adversaryFixtures';
import { AdversaryOverview } from './AdversaryOverview';

afterEach(cleanup);

describe('AdversaryOverview', () => {
  it('shows the cause tiles in order', () => {
    const { container } = render(<AdversaryOverview overview={OVERVIEW} onPick={vi.fn()} />);
    const tiles = Array.from(container.querySelectorAll('.adv-tile'));
    expect(tiles.map((t) => t.getAttribute('data-tile'))).toEqual(['spy', 'profit', 'drops']);
    expect(tiles[0]?.textContent).toContain('0 of 3 twins');
    expect(tiles[1]?.textContent).toContain('+$38.20');
    expect(tiles[2]?.textContent).toContain('−1.9 pts');
  });

  it('lists one row per method with returns, objections, coverage and both checklists', () => {
    const { container } = render(<AdversaryOverview overview={OVERVIEW} onPick={vi.fn()} />);
    const rows = Array.from(container.querySelectorAll('a.adv-row'));
    expect(rows.map((r) => r.getAttribute('data-strategy'))).toEqual(['A-GT', 'RAW35-FR-GT', 'COSK-FR-GT']);
    const a = rows[0] as HTMLElement;
    expect(a.getAttribute('href')).toBe('/adversary/A-GT');
    expect(a.textContent).toContain('+3.1%');
    expect(a.textContent).toContain('+5.4%');
    expect(a.textContent).toContain('61 / 1,190');
    expect(a.textContent).toContain('39 fell after');
    expect(a.textContent).toContain('78% · 17% · 5%');
    expect(within(a).getByRole('img', { name: 'original: 0 of 5 go-live rules passed' })).toBeTruthy();
    const twinDots = within(a).getByRole('img', { name: 'Claude twin: 2 of 5 go-live rules passed' });
    expect(twinDots.querySelectorAll('.adv-dot.na')).toHaveLength(1);
    expect(rows[1]?.textContent).toContain('7 of 7 rebalances');
    expect(rows[2]?.textContent).toContain('3 of 3 re-picks');
    // COSK's twin is behind its original: not highlighted.
    expect(rows[2]?.querySelectorAll('.adv-num.hi')).toHaveLength(0);
  });

  it('opens a method on a plain click', () => {
    const pick = vi.fn();
    const { container } = render(<AdversaryOverview overview={OVERVIEW} onPick={pick} />);
    fireEvent.click(container.querySelector('a[data-strategy="RAW35-FR-GT"]') as Element);
    expect(pick).toHaveBeenCalledWith('RAW35-FR-GT');
  });

  it('shows the latest objections with their method and sources', () => {
    render(<AdversaryOverview overview={OVERVIEW} onPick={vi.fn()} />);
    const latest = screen.getByRole('region', { name: 'Latest objections' });
    const cards = latest.querySelectorAll('article');
    expect(cards).toHaveLength(3);
    expect(cards[0]?.textContent).toContain('The dip follows oil, not SLB.');
    expect(cards[0]?.textContent).toContain('A · Nov 4');
    expect(within(cards[0] as HTMLElement).getByRole('link', { name: 'benzinga.com' }).getAttribute('href')).toBe('https://www.benzinga.com/slb');
    expect(cards[2]?.textContent).toContain("can't tell");
  });

  it('never shows a sample-data chip, and says so when there are no methods', () => {
    const { container } = render(<AdversaryOverview overview={{ ...OVERVIEW, methods: [], latest: [] }} onPick={vi.fn()} />);
    expect(container.textContent).not.toContain('sample data');
    expect(container.textContent).toContain("No method on Seer's roster has a Claude twin yet.");
    expect(container.textContent).toContain('No objections yet.');
  });
});
