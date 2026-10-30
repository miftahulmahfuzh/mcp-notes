import { createConnector, type ConnectorOptions } from '../connector.js';
import type { Connector, SystemAbout } from '../types.js';

export const EXPENSES_ABOUT: SystemAbout = {
  summary: "the owner's spending in rupiah, parsed from pasted text, with categories and receipt photos",
  db:
    'expense_groups is one purchase or receipt: occurred_on is the calendar day in Asia/Jakarta (WIB), plus title, note and raw_text (the pasted text). ' +
    'expense_items are its line items: amount_idr is whole rupiah (bigint, never negative), category is one of 17 slugs (meals, jajan, dining, snacks, drinks, transport, fuel, parking, bills, internet, utilities, housing, entertainment, cinema, health, grooming, other), sort_order orders them. ' +
    'expense_photos are receipt photos (blob_url, width, height). Totals are never stored: sum expense_items.amount_idr. ' +
    "A month is [YYYY-MM-01, next month's 01) on occurred_on. expense_insights holds the app's cached written summaries (week_text, month_text, two_month_text, generated_at). " +
    'Every table is scoped by user_id; the app has one owner. user, account, session, verificationToken and the share-link tables carry no spending data.',
};

export function createExpensesConnector(options: ConnectorOptions = {}): Connector {
  return createConnector('expenses', options);
}
