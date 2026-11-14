// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Poster } from './Poster';

afterEach(cleanup);

describe('Poster', () => {
  it('hotlinks the poster lazily and falls back to a title tile when it fails to load', () => {
    render(<Poster url="https://image.tmdb.org/t/p/w342/x.jpg" title="Oldboy" year={2003} />);
    const img = screen.getByRole('img', { name: 'Oldboy' });
    expect(img.getAttribute('src')).toBe('https://image.tmdb.org/t/p/w342/x.jpg');
    expect(img.getAttribute('loading')).toBe('lazy');
    fireEvent.error(img);
    expect(screen.getByRole('img', { name: 'Oldboy (no poster)' }).textContent).toBe('Oldboy2003');
  });

  it('shows the title tile when TMDB has no poster', () => {
    render(<Poster url={null} title="Pak Bernard" year={null} />);
    expect(screen.getByRole('img', { name: 'Pak Bernard (no poster)' }).textContent).toBe('Pak Bernard');
  });
});
