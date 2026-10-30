// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { RevealButton } from './RevealButton';
import { resetCapabilitiesForTests } from '../hooks/useCapabilities';

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;

function stubServer(reveal: boolean, revealStatus = 202) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/capabilities') return json({ reveal });
    if (url.endsWith('/reveal')) return revealStatus === 202 ? json({ ok: true }, 202) : json({ error: 'spawn_failed', message: 'boom' }, revealStatus);
    return json({ error: 'not_found' }, 404);
  });
}

beforeEach(() => {
  resetCapabilitiesForTests();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetCapabilitiesForTests();
});

describe('RevealButton', () => {
  it('renders nothing when the daemon cannot reveal (caps.reveal false)', async () => {
    stubServer(false);
    const { container } = render(<RevealButton image={{ id: 'A-B32', available: true }} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/capabilities'));
    await Promise.resolve();
    expect(container.querySelector('button')).toBeNull();
  });

  it('renders nothing for an image whose original is not on this machine', async () => {
    stubServer(true);
    const { container } = render(<RevealButton image={{ id: 'A-B32', available: false }} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/capabilities'));
    await Promise.resolve();
    expect(container.querySelector('button')).toBeNull();
  });

  it('renders the FolderOpen icon with the tooltip when both hold, no text', async () => {
    stubServer(true);
    const { findByLabelText } = render(<RevealButton image={{ id: 'A-B32', available: true }} />);
    const btn = await findByLabelText('Show in Explorer');
    expect(btn.getAttribute('data-tip')).toBe('Show in Explorer');
    expect(btn.querySelector('svg')).not.toBeNull();
    expect(btn.textContent).toBe('');
    expect(btn.className).toBe('copybtn');
  });

  it('click POSTs /api/images/<id>/reveal and does not reach the parent', async () => {
    stubServer(true);
    const parent = vi.fn();
    const { findByLabelText } = render(
      <div onClick={parent}>
        <RevealButton image={{ id: 'C-D45', available: true }} className="pm-btn" />
      </div>,
    );
    const btn = await findByLabelText('Show in Explorer');
    expect(btn.className).toBe('pm-btn');
    fireEvent.click(btn);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('/api/images/C-D45/reveal');
    expect(init.method).toBe('POST');
    expect(parent).not.toHaveBeenCalled();
  });

  it('a failed reveal only logs a quiet warning', async () => {
    stubServer(true, 500);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { findByLabelText } = render(<RevealButton image={{ id: 'C-D45', available: true }} />);
    fireEvent.click(await findByLabelText('Show in Explorer'));
    await waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(String(warn.mock.calls[0][0])).toContain('C-D45');
    expect(String(warn.mock.calls[0][1])).toBe('spawn_failed');
  });
});
