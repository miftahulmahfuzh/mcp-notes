// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { FileChips } from './FileChips';
import { makeFile } from '../testing/fixtures';
import { resetCapabilitiesForTests } from '../hooks/useCapabilities';

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => json({ ok: true }, 202));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetCapabilitiesForTests();
});

const pdf = makeFile('F-IL1', { note_id: 'A-B32', name: 'contract.pdf', mime: 'application/pdf', bytes: 2048 });
const zip = makeFile('F-IL2', { note_id: 'A-B32', position: 1, name: 'bundle.zip', mime: 'application/zip', bytes: 5 * 1024 * 1024 });
const away = makeFile('F-IL3', { note_id: 'A-B32', position: 2, name: 'far.txt', mime: 'text/plain', bytes: 12, host: 'thinkpad', available: false });

describe('FileChips', () => {
  it('renders nothing without files', () => {
    resetCapabilitiesForTests({ reveal: false });
    expect(render(<FileChips files={[]} />).container.querySelector('.fchips')).toBeNull();
  });

  it('one chip per file in order with name and "size · TYPE", and a download link', () => {
    resetCapabilitiesForTests({ reveal: false });
    const { container } = render(<FileChips files={[pdf, zip]} />);
    const chips = Array.from(container.querySelectorAll('.fchip'));
    expect(chips.map((c) => c.getAttribute('data-file'))).toEqual(['F-IL1', 'F-IL2']);
    expect(chips[0].querySelector('.fchip-name')?.textContent).toBe('contract.pdf');
    expect(chips[0].querySelector('[data-meta]')?.textContent).toBe('2 KB · PDF');
    expect(chips[1].querySelector('[data-meta]')?.textContent).toBe('5 MB · ZIP');
    expect(chips[0].querySelector('svg')).not.toBeNull();
    const a = within(chips[0] as HTMLElement).getByLabelText('Download file') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('/api/files/F-IL1/download');
    expect(a.getAttribute('download')).toBe('contract.pdf');
  });

  it('shows the display name, never the stored (sanitised) name', () => {
    // Phase 4 stores `files/<noteId>/<safeName>`; `name` is the user's name with control characters removed.
    resetCapabilitiesForTests({ reveal: false });
    const odd = makeFile('F-IL4', { note_id: 'A-B32', name: 'Q3 report: final?.pdf', urls: { download: '/api/files/F-IL4/download' } });
    const { container } = render(<FileChips files={[odd]} />);
    const chip = container.querySelector('[data-file="F-IL4"]') as HTMLElement;
    expect(chip.querySelector('.fchip-name')?.textContent).toBe('Q3 report: final?.pdf');
    expect(chip.querySelector('.fchip-name')?.getAttribute('data-tip')).toBe('Q3 report: final?.pdf');
    expect(chip.querySelector('[data-download]')?.getAttribute('download')).toBe('Q3 report: final?.pdf');
  });

  it('a file on another machine is dimmed, says where, and has no download or reveal', () => {
    resetCapabilitiesForTests({ reveal: true });
    const { container } = render(<FileChips files={[away]} />);
    const chip = container.querySelector('[data-file="F-IL3"]') as HTMLElement;
    expect(chip.className).toBe('fchip away');
    expect(chip.querySelector('[data-meta]')?.textContent).toBe('12 B · TXT · on thinkpad');
    expect(chip.querySelector('[data-download]')).toBeNull();
    expect(chip.querySelector('[data-reveal-file]')).toBeNull();
  });

  it('per-file reveal POSTs /api/files/<id>/reveal, only when caps.reveal', async () => {
    resetCapabilitiesForTests({ reveal: false });
    const off = render(<FileChips files={[pdf]} />);
    expect(off.container.querySelector('[data-reveal-file]')).toBeNull();
    off.unmount();

    resetCapabilitiesForTests({ reveal: true });
    const parent = vi.fn();
    const { container } = render(
      <div onClick={parent}>
        <FileChips files={[pdf]} />
      </div>,
    );
    fireEvent.click(container.querySelector('[data-reveal-file="F-IL1"]') as HTMLElement);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/files/F-IL1/reveal');
    expect(init.method).toBe('POST');
    expect(parent).not.toHaveBeenCalled();
  });

  it('remove icon only with onRemove, and hands over that file', () => {
    resetCapabilitiesForTests({ reveal: false });
    const bare = render(<FileChips files={[pdf]} />);
    expect(bare.container.querySelector('[aria-label="Remove file"]')).toBeNull();
    bare.unmount();
    const onRemove = vi.fn();
    const { container } = render(<FileChips files={[pdf, zip]} onRemove={onRemove} />);
    fireEvent.click(within(container.querySelector('[data-file="F-IL2"]') as HTMLElement).getByLabelText('Remove file'));
    expect(onRemove).toHaveBeenCalledWith(zip);
  });
});
