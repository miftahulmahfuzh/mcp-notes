import { describe, expect, it } from 'vitest';
import { isSameTitle } from '../../../src/directStream/match.js';
// @ts-expect-error -- a plain .mjs module without type declarations
import { pickMatches } from '../../../claude/streaming/match.mjs';

type Case = [query: string, year: number | null, name: string, original: string | null, resultYear: number | null];

const CASES: Case[] = [
  ['saltburn', null, 'Saltburn', 'Saltburn', 2023],
  ['saltburn', null, 'Saltburn 2', null, 2026],
  ['dune', 2021, 'Dune', 'Dune', 2021],
  ['dune', 2021, 'Dune', 'Dune', 1984],
  ['dune', null, 'Dune', 'Dune', 1984],
  ['spider-man: no way home', null, 'Spider-Man: No Way Home', null, 2021],
  ['fast & furious', null, 'Fast and Furious', null, 2009],
  ['amelie', null, 'Amélie', "Le Fabuleux Destin d'Amélie Poulain", 2001],
  ['the host', 2006, 'The Host', '괴물', null],
  ['기생충', null, 'Parasite', '기생충', 2019],
  ['parasite', 2019, 'Parasite', '기생충', 2019],
  ['the lord of the rings: the fellowship of the ring', 2001, 'The Lord of the Rings: The Fellowship of the Ring', null, 2001],
  ['the lord of the rings', null, 'The Lord of the Rings: The Fellowship of the Ring', null, 2001],
];

describe('isSameTitle', () => {
  it.each(CASES)('agrees with claude/streaming/match.mjs for %s (%s) vs %s', (query, year, name, original, resultYear) => {
    const script = pickMatches([{ name, original_name: original, year: resultYear }], { name: query, year }).matches.length === 1;
    expect(isSameTitle({ name, originalName: original, year: resultYear }, { name: query, year })).toBe(script);
  });

  it('keeps a remake apart from its original only when a year is given', () => {
    const dune1984 = { name: 'Dune', originalName: 'Dune', year: 1984 };
    expect(isSameTitle(dune1984, { name: 'dune', year: null })).toBe(true);
    expect(isSameTitle(dune1984, { name: 'dune', year: 2021 })).toBe(false);
  });
});
