import { describe, expect, it } from 'vitest';
import {
  EATING_CATEGORIES,
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  categoryLabel,
  isExpenseCategory,
  toExpenseCategory,
} from '../../../src/connectors/expenses/categories.js';

describe('expenses categories', () => {
  it('has the 17 slugs of expense-tracking, in display order, each with an Indonesian label', () => {
    expect(EXPENSE_CATEGORIES).toHaveLength(17);
    expect(new Set(EXPENSE_CATEGORIES).size).toBe(17);
    expect(EXPENSE_CATEGORIES[0]).toBe('meals');
    expect(EXPENSE_CATEGORIES[16]).toBe('other');
    for (const slug of EXPENSE_CATEGORIES) expect(EXPENSE_CATEGORY_LABELS[slug].length).toBeGreaterThan(0);
    expect(EXPENSE_CATEGORY_LABELS.meals).toBe('Makan Harian');
    expect(EXPENSE_CATEGORY_LABELS.dining).toBe('Fancy Makan Berat');
    expect(EXPENSE_CATEGORY_LABELS.utilities).toBe('Listrik & Air Apart');
    expect(EXPENSE_CATEGORY_LABELS.other).toBe('Lainnya');
  });

  it('degrades unknown slugs to other, as the app does', () => {
    expect(isExpenseCategory('fuel')).toBe(true);
    expect(isExpenseCategory('food')).toBe(false);
    expect(toExpenseCategory('food')).toBe('other');
    expect(toExpenseCategory(null)).toBe('other');
    expect(categoryLabel('food')).toBe('Lainnya');
    expect(categoryLabel('cinema')).toBe('Bioskop');
  });

  it('lists the eating family', () => {
    expect([...EATING_CATEGORIES]).toEqual(['meals', 'jajan', 'dining', 'snacks', 'drinks']);
  });
});
