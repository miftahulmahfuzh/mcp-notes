// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { binNoteSelector, flashNote, flashSelector, noteSelector } from './flash';
import { flashNote as reExported } from '../components/DropOverlay';

let animate: ReturnType<typeof vi.fn>;
let scroll: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  animate = vi.fn();
  scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, writable: true, value: animate });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scroll });
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(HTMLElement.prototype, 'animate');
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  document.body.innerHTML = '';
});

const add = (html: string) => document.body.insertAdjacentHTML('beforeend', html);

describe('flash', () => {
  it('flashNote scrolls to and pulses the card after the default 450 ms', () => {
    add('<article data-note="A-B32"></article>');
    flashNote('A-B32');
    vi.advanceTimersByTime(449);
    expect(animate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[0][1]).toEqual({ duration: 1600, easing: 'ease-out' });
  });

  it('DropOverlay still exports the same flashNote', () => {
    expect(reExported).toBe(flashNote);
  });

  it('without waitMs looks once and gives up', () => {
    flashSelector(noteSelector('A-B32'), { delayMs: 10 });
    vi.advanceTimersByTime(10);
    add('<article data-note="A-B32"></article>');
    vi.advanceTimersByTime(1000);
    expect(animate).not.toHaveBeenCalled();
  });

  it('with waitMs keeps looking until the element appears, then pulses once', () => {
    flashSelector(binNoteSelector('G-H19'), { delayMs: 60, waitMs: 1000 });
    vi.advanceTimersByTime(60);
    expect(animate).not.toHaveBeenCalled();
    add('<article data-bin-note="G-H19"></article>');
    vi.advanceTimersByTime(50);
    expect(animate).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it('stops looking after waitMs', () => {
    flashSelector(noteSelector('A-B32'), { delayMs: 0, waitMs: 100 });
    vi.advanceTimersByTime(150);
    add('<article data-note="A-B32"></article>');
    vi.advanceTimersByTime(1000);
    expect(animate).not.toHaveBeenCalled();
  });

  it('the returned function cancels a pending flash', () => {
    add('<article data-note="A-B32"></article>');
    const cancel = flashNote('A-B32', 100);
    cancel();
    vi.advanceTimersByTime(500);
    expect(animate).not.toHaveBeenCalled();
  });

  it('pulses the first match only (gallery tiles share data-note)', () => {
    add('<div data-note="K-F07" id="one"></div><div data-note="K-F07" id="two"></div>');
    flashNote('K-F07', 0);
    vi.advanceTimersByTime(0);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.contexts[0]).toBe(document.getElementById('one'));
  });

  it('quotes the id in the selector', () => {
    expect(noteSelector('A-B32')).toBe('[data-note="A-B32"]');
    expect(noteSelector('a"b\\c')).toBe('[data-note="a\\"b\\\\c"]');
    expect(binNoteSelector('G-H19')).toBe('[data-bin-note="G-H19"]');
  });
});
