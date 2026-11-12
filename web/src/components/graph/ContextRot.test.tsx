// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { HandoffEstimate, SessionContext } from '../../sessionDetailApi';
import { ContextBars, ContextRot } from './ContextRot';

const ctx = (over: Partial<SessionContext> = {}): SessionContext => ({
  tokens: 390_000,
  window: 1_000_000,
  percent: 39,
  band: 'green',
  model: 'claude-opus-5-5',
  at: '2026-11-12T02:00:00.000Z',
  window_source: 'model',
  peak_tokens: 390_000,
  ...over,
});

const EST: HandoffEstimate = {
  node_id: 'A0-3G',
  tokens: 120_000,
  window: 1_000_000,
  percent: 12,
  baseline: 48_000,
  exchanges_included: 40,
  exchanges_total: 40,
  truncated: false,
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const meter = () => screen.getByRole('meter', { name: 'Current context' });
const fill = () => meter().querySelector('.cr-fill') as HTMLElement;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ContextBars', () => {
  it.each([
    [390_000, 39, 'green', '390k / 1M · 39%'],
    [400_000, 40, 'amber', '400k / 1M · 40%'],
    [690_000, 69, 'amber', '690k / 1M · 69%'],
    [700_000, 70, 'red', '700k / 1M · 70%'],
  ] as const)('%i tokens at %i%% is %s', (tokens, percent, band, text) => {
    render(<ContextBars context={ctx({ tokens, percent, band })} estimate={null} />);
    expect(screen.getByText(text)).toBeTruthy();
    expect(meter().getAttribute('data-band')).toBe(band);
    expect(meter().getAttribute('aria-valuenow')).toBe(String(percent));
    expect(fill().className).toBe(`cr-fill cr-${band}`);
    expect(fill().style.width).toBe(`${percent}%`);
  });

  it('rounds the label down, so 39.9 % in green never reads 40 %', () => {
    render(<ContextBars context={ctx({ tokens: 399_000, percent: 39.9, band: 'green' })} estimate={null} />);
    expect(screen.getByText('399k / 1M · 39%')).toBeTruthy();
  });

  it('clamps the fill to the track', () => {
    render(<ContextBars context={ctx({ tokens: 260_000, window: 200_000, percent: 130, band: 'red' })} estimate={null} />);
    expect(screen.getByText('260k / 200k · 130%')).toBeTruthy();
    expect(fill().style.width).toBe('100%');
    expect(meter().getAttribute('aria-valuenow')).toBe('100');
  });

  it('shows Unknown, not 0 %, when there is no context', () => {
    const { container } = render(<ContextBars context={null} estimate={null} />);
    expect(screen.getByText('Unknown')).toBeTruthy();
    expect(screen.queryByRole('meter', { name: 'Current context' })).toBeNull();
    expect(container.querySelector('.cr-fill')).toBeNull();
    expect(container.textContent).not.toContain('%');
  });

  it('names the model and says when the window is assumed', () => {
    render(<ContextBars context={ctx({ tokens: 6_335, window: 200_000, percent: 3.1675, model: 'glm-5.3', window_source: 'default' })} estimate={null} />);
    expect(screen.getByText('6.3k / 200k · 3%')).toBeTruthy();
    expect(screen.getByText('glm-5.3')).toBeTruthy();
    expect(screen.getByText('window assumed')).toBeTruthy();
  });

  it('says nothing about the window when it came from the model table', () => {
    render(<ContextBars context={ctx()} estimate={null} />);
    expect(screen.getByText('claude-opus-5-5')).toBeTruthy();
    expect(screen.queryByText('window assumed')).toBeNull();
  });

  it('shows where a fresh session would start and how many exchanges it carries', () => {
    render(<ContextBars context={ctx()} estimate={EST} />);
    expect(screen.getByRole('meter', { name: 'Fresh session estimate' }).getAttribute('aria-valuenow')).toBe('12');
    expect(screen.getByText('Fresh session would start at ~12%')).toBeTruthy();
    expect(screen.getByText('carries 40 of 40 exchanges')).toBeTruthy();
    expect(screen.queryByText('older ones left out')).toBeNull();
  });

  it('says when the estimate leaves older exchanges out', () => {
    render(<ContextBars context={ctx()} estimate={{ ...EST, percent: 49.6, exchanges_included: 31, exchanges_total: 212, truncated: true }} />);
    expect(screen.getByText('Fresh session would start at ~50%')).toBeTruthy();
    expect(screen.getByText('carries 31 of 212 exchanges')).toBeTruthy();
    expect(screen.getByText('older ones left out')).toBeTruthy();
  });

  it('shows the estimate under an unknown context too', () => {
    render(<ContextBars context={null} estimate={EST} />);
    expect(screen.getByText('Unknown')).toBeTruthy();
    expect(screen.getByText('carries 40 of 40 exchanges')).toBeTruthy();
  });

  it('has no second bar without an estimate', () => {
    render(<ContextBars context={ctx()} estimate={null} />);
    expect(screen.queryByText(/Fresh session/)).toBeNull();
    expect(screen.queryByRole('meter', { name: 'Fresh session estimate' })).toBeNull();
  });
});

describe('ContextRot', () => {
  it('loads the estimate from the handoff route', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return json(200, EST);
      }),
    );
    render(<ContextRot nodeId="A0-3G" live={false} available={true} initial={ctx()} />);
    expect(await screen.findByText('carries 40 of 40 exchanges')).toBeTruthy();
    expect(calls).toEqual(['/api/sessions/A0-3G/handoff']);
  });

  it('hides the estimate quietly when the handoff route fails', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return json(500, { error: 'boom' });
      }),
    );
    render(<ContextRot nodeId="A0-3G" live={false} available={true} initial={ctx()} />);
    await waitFor(() => expect(calls).toEqual(['/api/sessions/A0-3G/handoff']));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText('390k / 1M · 39%')).toBeTruthy();
    expect(screen.queryByText(/Fresh session/)).toBeNull();
    expect(screen.queryByText(/boom/)).toBeNull();
  });
});
