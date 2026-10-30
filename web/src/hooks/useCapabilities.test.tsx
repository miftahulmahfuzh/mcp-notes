// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { resetCapabilitiesForTests, useCapabilities } from './useCapabilities';

function Probe({ label }: { label: string }) {
  const caps = useCapabilities();
  return <span data-testid={label}>{caps.reveal ? 'yes' : 'no'}</span>;
}

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetCapabilitiesForTests();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetCapabilitiesForTests();
});

describe('useCapabilities', () => {
  it('fetches GET /api/capabilities once for the whole page, however many components ask', async () => {
    fetchMock.mockResolvedValue(json({ reveal: true }));
    const { getByTestId } = render(
      <>
        <Probe label="a" />
        <Probe label="b" />
      </>,
    );
    expect(getByTestId('a').textContent).toBe('no');
    await waitFor(() => expect(getByTestId('a').textContent).toBe('yes'));
    expect(getByTestId('b').textContent).toBe('yes');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/capabilities');

    render(<Probe label="c" />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stays { reveal: false } when the request fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('network down'));
    const { getByTestId } = render(<Probe label="a" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(getByTestId('a').textContent).toBe('no');
  });

  it('stays { reveal: false } on a non-2xx answer or a payload without reveal: true', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'not_found' }, 404));
    const first = render(<Probe label="a" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(first.getByTestId('a').textContent).toBe('no');
    cleanup();

    resetCapabilitiesForTests();
    fetchMock.mockResolvedValueOnce(json({ reveal: 'yes' }));
    const second = render(<Probe label="b" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(second.getByTestId('b').textContent).toBe('no');
  });

  it('a primed store does not fetch', () => {
    resetCapabilitiesForTests({ reveal: true });
    const { getByTestId } = render(<Probe label="a" />);
    expect(getByTestId('a').textContent).toBe('yes');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
