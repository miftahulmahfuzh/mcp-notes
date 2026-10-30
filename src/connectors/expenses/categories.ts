/**
 * expense-tracking's 17 expense categories, copied as DATA from ~/expense-tracking/lib/categories.ts
 * (CATEGORY_META: id + Indonesian label). Never imported: that repo changes on its own. If it adds a
 * category, add it here too; until then the new slug reads as `other`, which is what the app itself
 * does with an unknown string (toCategory).
 *
 * Order is the app's display order, grouped by family: eating, transport, bills & home, leisure,
 * health, other.
 */
export const EXPENSE_CATEGORIES = [
  'meals',
  'jajan',
  'dining',
  'snacks',
  'drinks',
  'transport',
  'fuel',
  'parking',
  'bills',
  'internet',
  'utilities',
  'housing',
  'entertainment',
  'cinema',
  'health',
  'grooming',
  'other',
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/** Indonesian display labels, verbatim from CATEGORY_META[slug].label. */
export const EXPENSE_CATEGORY_LABELS: Readonly<Record<ExpenseCategory, string>> = {
  meals: 'Makan Harian',
  jajan: 'Jajan',
  dining: 'Fancy Makan Berat',
  snacks: 'Snack',
  drinks: 'Beverage',
  transport: 'Transport',
  fuel: 'Bensin',
  parking: 'Sewa Parkir Motor',
  bills: 'Tagihan',
  internet: 'Internet',
  utilities: 'Listrik & Air Apart',
  housing: 'Tempat Tinggal',
  entertainment: 'Hiburan',
  cinema: 'Bioskop',
  health: 'Kesehatan',
  grooming: 'Pangkas Rambut',
  other: 'Lainnya',
};

/** The eating-and-drinking family, for "all food" questions ('meals' alone is daily meals only). */
export const EATING_CATEGORIES = ['meals', 'jajan', 'dining', 'snacks', 'drinks'] as const satisfies readonly ExpenseCategory[];

export const DEFAULT_EXPENSE_CATEGORY: ExpenseCategory = 'other';

export function isExpenseCategory(value: unknown): value is ExpenseCategory {
  return typeof value === 'string' && (EXPENSE_CATEGORIES as readonly string[]).includes(value);
}

/** Unknown or missing input degrades to `other`, as the app does at its DB read boundary. */
export function toExpenseCategory(value: unknown): ExpenseCategory {
  return isExpenseCategory(value) ? value : DEFAULT_EXPENSE_CATEGORY;
}

export function categoryLabel(value: unknown): string {
  return EXPENSE_CATEGORY_LABELS[toExpenseCategory(value)];
}
