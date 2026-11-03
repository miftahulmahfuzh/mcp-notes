// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { PromptsModal, isPromptsOpen, promptsCopyText } from './PromptsModal';

// 2026-11-01 11:00 in Jakarta.
const NOW = new Date('2026-11-01T04:00:00Z');
const SPACED = '  indented line\n\n\tcode  block\nkey [redacted] kept  ';
const LONG = 'x'.repeat(2500);
const PAYLOAD = {
  node_id: 'A0-3G',
  host: 'lenovo',
  available: true,
  complete: true,
  incomplete_reason: null,
  prompts: [
    { n: 1, text: 'run the swarm', at: '2026-11-01T01:00:00.000Z', truncated: false },
    { n: 2, text: SPACED, at: '2026-11-01T01:05:00.000Z', truncated: false },
    { n: 3, text: LONG, at: null, truncated: true },
  ],
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let writeText: ReturnType<typeof vi.fn>;

function stub(status: number, body: unknown): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return json(status, body);
    }),
  );
  return urls;
}

function open(): ReturnType<typeof vi.fn> {
  const onClose = vi.fn();
  render(<PromptsModal nodeId="A0-3G" now={NOW} onClose={onClose} />);
  return onClose;
}

async function ready(): Promise<HTMLElement> {
  await screen.findByText('run the swarm');
  return screen.getByRole('dialog', { name: 'Prompts of A0-3G' });
}

beforeEach(() => {
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('PromptsModal', () => {
  it('lists every prompt numbered from 1 with its time, the text exactly as typed', async () => {
    const urls = stub(200, PAYLOAD);
    open();
    const d = await ready();
    expect(urls).toEqual(['/api/sessions/A0-3G/prompts']);
    const items = within(d).getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-n'))).toEqual(['1', '2', '3']);
    expect(items.map((li) => li.querySelector('.prm-n')?.textContent)).toEqual(['1', '2', '3']);
    expect(items[1]!.querySelector('.prm-text')?.textContent).toBe(SPACED);
    expect(items[2]!.querySelector('.prm-text')?.textContent).toBe(LONG);
    expect(within(items[2]!).getByText('truncated')).toBeTruthy();
    expect(within(items[0]!).queryByText('truncated')).toBeNull();
    expect(items[0]!.querySelector('time')?.getAttribute('dateTime')).toBe('2026-11-01T01:00:00.000Z');
    expect(items[2]!.querySelector('time')).toBeNull();
    expect(d.querySelector('.prm-count')?.textContent).toBe('3');
    expect(screen.queryByText(/backfills/)).toBeNull();
    expect(screen.queryByText(/no longer on/)).toBeNull();
  });

  it('"Copy prompt N" copies that prompt exactly as shown, with a brief check mark', async () => {
    stub(200, PAYLOAD);
    open();
    const d = await ready();
    const two = within(d).getByRole('button', { name: 'Copy prompt 2' });
    fireEvent.click(two);
    expect(writeText).toHaveBeenLastCalledWith(SPACED);
    expect(two.getAttribute('data-tip')).toBe('Copied');
    expect(within(d).getByRole('button', { name: 'Copy prompt 1' }).getAttribute('data-tip')).toBe('Copy prompt 1');
  });

  it('"Copy all prompts" joins them as "1. <text>\\n\\n2. <text>…"', async () => {
    stub(200, PAYLOAD);
    open();
    const d = await ready();
    const all = within(d).getByRole('button', { name: 'Copy all prompts' });
    fireEvent.click(all);
    const expected = `1. run the swarm\n\n2. ${SPACED}\n\n3. ${LONG}`;
    expect(writeText).toHaveBeenLastCalledWith(expected);
    expect(promptsCopyText(PAYLOAD.prompts)).toBe(expected);
    expect(all.getAttribute('data-tip')).toBe('Copied');
  });

  it('says the full prompts are still to come while the owning host has not backfilled', async () => {
    stub(200, { ...PAYLOAD, host: 'GPD', available: false, complete: false, incomplete_reason: 'not_backfilled', prompts: [PAYLOAD.prompts[0]] });
    open();
    await ready();
    expect(screen.getByText('Full prompts arrive once GPD backfills')).toBeTruthy();
    expect(screen.queryByText(/no longer on/)).toBeNull();
  });

  it('says older prompts were cut when the transcript was pruned before the backfill', async () => {
    stub(200, { ...PAYLOAD, host: 'GPD', available: false, complete: false, incomplete_reason: 'transcript_pruned', prompts: [PAYLOAD.prompts[0]] });
    open();
    await ready();
    expect(screen.getByText('Older prompts were cut; the full text is no longer on GPD')).toBeTruthy();
    expect(screen.queryByText(/backfills/)).toBeNull();
  });

  it('Esc closes the modal and never reaches the page under it', async () => {
    stub(200, PAYLOAD);
    const page = vi.fn();
    const onDocKey = (e: KeyboardEvent) => {
      if (!e.defaultPrevented && e.key === 'Escape') page();
    };
    document.addEventListener('keydown', onDocKey);
    try {
      const onClose = open();
      const d = await ready();
      expect(isPromptsOpen()).toBe(true);
      fireEvent.keyDown(d, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(page).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', onDocKey);
    }
  });

  it('a backdrop click closes it; a click inside does not', async () => {
    stub(200, PAYLOAD);
    const onClose = open();
    const d = await ready();
    fireEvent.click(within(d).getByText('run the swarm'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector('[data-modal="prompts"]') as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows loading, then a missing node, or the error with copy-all disabled', async () => {
    stub(404, { error: 'not_found' });
    open();
    expect(screen.getByText('Loading prompts')).toBeTruthy();
    expect(await screen.findByText('No session A0-3G')).toBeTruthy();
    cleanup();
    stub(500, { error: 'boom' });
    open();
    expect(await screen.findByText('Could not load prompts: boom')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Copy all prompts' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
