// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AdversaryStore } from '../hooks/useAdversary';
import { METHOD_BOOK, METHOD_DAILY, OVERVIEW, TOGGLE_OFF, TOGGLE_ON } from '../testing/adversaryFixtures';
import { AdversaryPage, type AdversaryPageProps } from './AdversaryPage';

afterEach(cleanup);

const store = (over: Partial<AdversaryStore> = {}): AdversaryStore => ({
  overview: OVERVIEW,
  overviewError: null,
  method: null,
  methodError: null,
  toggle: TOGGLE_ON,
  setAuto: vi.fn(async () => true),
  reviewNow: vi.fn(async () => ({ started: true, reason: null })),
  refresh: vi.fn(),
  ...over,
});

const page = (over: Partial<AdversaryPageProps> = {}) =>
  render(
    <AdversaryPage
      store={store()}
      strategy={null}
      focus={false}
      onToggleFocus={vi.fn()}
      escapeLeavesFocus
      onPickStrategy={vi.fn()}
      onAsk={vi.fn()}
      {...over}
    />,
  );

describe('AdversaryPage toolbar', () => {
  it('auto-runs on: inverted, pressed, and a click pauses', () => {
    const s = store();
    page({ store: s });
    const btn = screen.getByRole('button', { name: 'Auto-runs on (click to pause)' });
    expect(btn.className).toBe('ibtn on');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.textContent).toBe('');
    fireEvent.click(btn);
    expect(s.setAuto).toHaveBeenCalledWith(false);
  });

  it('auto-runs off: dashed ring, not pressed, and a click turns it on', () => {
    const s = store({ toggle: TOGGLE_OFF });
    page({ store: s });
    const btn = screen.getByRole('button', { name: 'Auto-runs off (click to turn on)' });
    expect(btn.className).toBe('ibtn adv-off');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Review now' }).getAttribute('data-tip')).toBe('Review now (runs once, even while auto-runs are off)');
    fireEvent.click(btn);
    expect(s.setAuto).toHaveBeenCalledWith(true);
  });

  it('is disabled until the toggle has loaded', () => {
    page({ store: store({ toggle: null }) });
    expect((screen.getByRole('button', { name: 'Auto-runs on (click to pause)' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Review now asks for the overview or this method, and says what happened', async () => {
    const s = store({ method: METHOD_BOOK });
    page({ store: s, strategy: 'RAW35-FR-GT' });
    fireEvent.click(screen.getByRole('button', { name: 'Review this method now' }));
    await screen.findByText('review started');
    expect(s.reviewNow).toHaveBeenCalledWith('RAW35-FR-GT');
  });

  it('Focus: the button and Alt+Z both toggle; Esc leaves only while allowed', () => {
    const t = vi.fn();
    const { rerender } = page({ onToggleFocus: t });
    fireEvent.click(screen.getByRole('button', { name: 'Focus (Alt+Z)' }));
    expect(t).toHaveBeenCalledTimes(1);
    const e = new KeyboardEvent('keydown', { code: 'KeyZ', key: 'z', altKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(t).toHaveBeenCalledTimes(2);
    const props = { store: store(), strategy: null, onPickStrategy: vi.fn(), onAsk: vi.fn(), onToggleFocus: t };
    rerender(<AdversaryPage {...props} focus escapeLeavesFocus={false} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(t).toHaveBeenCalledTimes(2);
    rerender(<AdversaryPage {...props} focus escapeLeavesFocus />);
    expect(screen.getByRole('button', { name: 'Exit focus (Alt+Z)' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('auto-runs on')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(t).toHaveBeenCalledTimes(3);
  });
});

describe('AdversaryPage content', () => {
  it('picks the method layout for a book and the daily layout when the API sends a three-way', () => {
    const { rerender } = page({ store: store({ method: METHOD_BOOK }), strategy: 'RAW35-FR-GT' });
    expect(screen.getByRole('region', { name: 'Go-live checklist' })).toBeTruthy();
    expect(screen.getByText("can't be run")).toBeTruthy();
    expect(screen.getByText('Claude already knows how the past turned out, so a twin can never be backtested.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'object 1' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('held · sell')).toBeTruthy();
    expect(screen.getByText('weight 2.9% → 0')).toBeTruthy();
    rerender(
      <AdversaryPage store={store({ method: METHOD_DAILY })} strategy="A-GT" focus={false} onToggleFocus={vi.fn()} escapeLeavesFocus onPickStrategy={vi.fn()} onAsk={vi.fn()} />,
    );
    expect(screen.getByRole('region', { name: 'A, C and Claude compared' })).toBeTruthy();
    expect(document.querySelector('.adv-cand[data-symbol="SLB"]')?.getAttribute('data-claude-blocks')).toBe('true');
    expect(screen.getByText('31 of 48')).toBeTruthy();
  });

  it('shows the empty states', () => {
    const { rerender } = page({ store: store({ overview: null, overviewError: 'seer_unavailable' }) });
    expect(screen.getByText("Seer's database can't be reached from this machine, so there is nothing to show.")).toBeTruthy();
    rerender(
      <AdversaryPage
        store={store({ method: { ...METHOD_BOOK, decision: null } })}
        strategy="RAW35-FR-GT"
        focus={false}
        onToggleFocus={vi.fn()}
        escapeLeavesFocus
        onPickStrategy={vi.fn()}
        onAsk={vi.fn()}
      />,
    );
    expect(screen.getByText("No verdicts yet. Claude reviews this method's next decision after Seer's nightly.")).toBeTruthy();
  });

  it('the pill sends the question', async () => {
    const ask = vi.fn();
    page({ onAsk: ask });
    const box = screen.getByPlaceholderText('Ask about Seer Adversarial');
    fireEvent.change(box, { target: { value: 'why ZBRA?' } });
    fireEvent.submit(box.closest('form') as HTMLFormElement);
    await waitFor(() => expect(ask).toHaveBeenCalledWith('why ZBRA?', []));
  });
});
