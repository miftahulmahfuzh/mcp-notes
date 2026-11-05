-- Seer Adversarial phase 5 fixture: a small Seer database AFTER migration 027 (contract C1).
-- Loaded by tests/integration/connectors/adversary.int.test.ts and by phase 5's verify-notesd Proof.
-- Every session it names is in the past, so a reviewer pointed at this database finds nothing due.
-- It empties every public table first (the migrations' own roster rows included).
DO $$
DECLARE t text;
BEGIN
  SELECT string_agg(format('%I.%I', schemaname, tablename), ', ') INTO t FROM pg_tables WHERE schemaname = 'public';
  IF t IS NOT NULL THEN EXECUTE 'TRUNCATE ' || t || ' RESTART IDENTITY CASCADE'; END IF;
END $$;

INSERT INTO strategies (id, name, sub, icon, is_champion, is_benchmark, params, sort, engine, rules_id, status,
                        paper_start, paper_end, object_name, gate_note, gate_applicable, twin_of) VALUES
  ('SPY-GT', 'SPY', 'S&P 500, buy and hold, real Gotrade fees', 'landmark', true, true, '{}', 1, 'benchmark', NULL, 'active',
   '2026-10-01', NULL, NULL, NULL, false, NULL),
  ('C-GT', 'C · News veto', 'A''s picks, a news model can veto them, daily', 'gavel', false, false,
   '{"backtest_gate": {"passed": false, "applicable": false}}', 2, 'bracket', 'design-v0-gotrade', 'active',
   '2026-10-02', NULL, 'STRATEGY_C', NULL, false, NULL),
  ('A-GT', 'A · Dip buy', 'Buys a sharp dip in a rising stock, out within 5 days', 'sigma', false, false,
   '{"backtest_gate": {"passed": false, "applicable": true}}', 3, 'bracket', 'design-v0-gotrade', 'active',
   '2026-10-02', NULL, 'STRATEGY_A', NULL, true, NULL),
  ('RAW35-FR-GT', 'RAW35 · Momentum', 'The 35 stocks that rose most beyond the market, re-picked each month', 'zap', false, false,
   '{"backtest_gate": {"passed": true, "applicable": true}}', 5, 'book', 'monthly-hold-frac-gotrade', 'active',
   '2026-10-01', NULL, 'RESIDMOM35', NULL, true, NULL),
  ('MOM70-FR-GT', 'MOM70 · Momentum beside SPY', '70% in the 30 strongest names, 30% in SPY, monthly', 'trending-up', false, false,
   '{}', 7, 'book', 'monthly-hold-frac-gotrade', 'retired', '2026-09-30', '2026-09-30', 'MOMBLEND70', NULL, true, NULL);

INSERT INTO strategies (id, name, sub, icon, is_champion, is_benchmark, params, sort, engine, rules_id, status,
                        paper_start, paper_end, object_name, gate_note, gate_applicable, twin_of) VALUES
  ('A-GT-CX', 'A+Claude · Dip buy', 'Buys a sharp dip in a rising stock, out within 5 days', 'sigma', false, false, '{}', 4,
   'bracket', 'design-v0-gotrade', 'active', '2026-10-05', NULL, 'STRATEGY_A',
   'Claude twin: no backtest is possible, Claude already knows how the past turned out.', false, 'A-GT'),
  ('RAW35-FR-GT-CX', 'RAW35+Claude · Momentum', 'The 35 stocks that rose most beyond the market, re-picked each month', 'zap',
   false, false, '{}', 6, 'book', 'monthly-hold-frac-gotrade', 'active', '2026-10-02', NULL, 'RESIDMOM35',
   'Claude twin: no backtest is possible, Claude already knows how the past turned out.', false, 'RAW35-FR-GT');

INSERT INTO equity_snapshots (strategy_id, date, cash_usd, equity_usd) VALUES
  ('SPY-GT', '2026-09-30', 0, 606), ('SPY-GT', '2026-10-01', 0, 612), ('SPY-GT', '2026-10-02', 0, 600),
  ('SPY-GT', '2026-10-05', 0, 945), ('SPY-GT', '2026-10-06', 0, 963.9), ('SPY-GT', '2026-10-07', 0, 960),
  ('C-GT', '2026-10-01', 0, 600), ('C-GT', '2026-10-02', 0, 590), ('C-GT', '2026-10-05', 0, 890),
  ('C-GT', '2026-10-06', 0, 880), ('C-GT', '2026-10-07', 0, 870),
  ('A-GT', '2026-10-01', 0, 600), ('A-GT', '2026-10-02', 0, 606), ('A-GT', '2026-10-05', 0, 996.6),
  ('A-GT', '2026-10-06', 0, 896.94), ('A-GT', '2026-10-07', 0, 900),
  ('A-GT-CX', '2026-10-02', 0, 600), ('A-GT-CX', '2026-10-05', 0, 1080), ('A-GT-CX', '2026-10-06', 0, 1080),
  ('RAW35-FR-GT', '2026-09-30', 0, 600), ('RAW35-FR-GT', '2026-10-01', 0, 606), ('RAW35-FR-GT', '2026-10-02', 0, 612),
  ('RAW35-FR-GT', '2026-10-05', 0, 918),
  ('RAW35-FR-GT-CX', '2026-10-01', 0, 600), ('RAW35-FR-GT-CX', '2026-10-02', 0, 603);

-- One owner deposit on 2026-10-05 for every book; the twin of RAW35 has not been credited yet (applied_at NULL).
INSERT INTO paper_contributions (strategy_id, due_date, session_date, amount_idr, usd_idr, amount_usd, applied_at) VALUES
  ('SPY-GT', '2026-10-05', '2026-10-05', 5000000, 16666.6667, 300, '2026-10-06T06:30:00Z'),
  ('C-GT', '2026-10-05', '2026-10-05', 5000000, 16666.6667, 300, '2026-10-06T06:30:00Z'),
  ('A-GT', '2026-10-05', '2026-10-05', 5000000, 16666.6667, 300, '2026-10-06T06:30:00Z'),
  ('A-GT-CX', '2026-10-05', '2026-10-05', 5000000, 16666.6667, 300, '2026-10-07T06:30:00Z'),
  ('RAW35-FR-GT', '2026-10-05', '2026-10-05', 5000000, 16666.6667, 300, '2026-10-06T06:30:00Z'),
  ('RAW35-FR-GT-CX', '2026-10-05', '2026-10-05', 5000000, 16666.6667, 300, NULL);

INSERT INTO paper_state (strategy_id, last_session, cash_usd, equity_usd, initial_cash_usd, usd_idr, pending_session, pending_decision) VALUES
  ('SPY-GT', '2026-10-07', 0, 960, 600, 16666.6667, '2026-10-08', false),
  ('C-GT', '2026-10-07', 870, 870, 600, 16666.6667, '2026-10-08', false),
  ('A-GT', '2026-10-07', 900, 900, 600, 16666.6667, '2026-10-08', false),
  ('A-GT-CX', '2026-10-06', 1080, 1080, 600, 16666.6667, '2026-10-07', false),
  ('RAW35-FR-GT', '2026-10-05', 0, 918, 600, 16666.6667, '2026-10-06', false),
  ('RAW35-FR-GT-CX', '2026-10-02', 0, 603, 600, 16666.6667, '2026-10-05', false);

INSERT INTO orders (strategy_id, session_date, slot, symbol, company, last_price, limit_price, tp_price, sl_price, shares,
                    status, fill_date, fill_price, days_held, exit_date, exit_price, exit_reason, pnl_usd) VALUES
  ('A-GT', '2026-10-02', 1, 'ZZZ', 'Zed Corp', 10, 10, 13, 9, 10, 'closed', '2026-10-02', 10, 2, '2026-10-05', 13, 'tp', 30),
  ('A-GT', '2026-10-05', 1, 'AAA', 'Triple A', 100, 99, 104, 95, 1, 'closed', '2026-10-05', 99, 1, '2026-10-06', 89, 'sl', -10),
  ('A-GT', '2026-10-05', 2, 'BBB', 'Bee Inc', 100, 99, 104, 95, 1, 'open', '2026-10-05', 99, 1, NULL, NULL, NULL, NULL),
  ('C-GT', '2026-10-05', 1, 'AAA', 'Triple A', 100, 99, 104, 95, 1, 'pending', NULL, NULL, 0, NULL, NULL, NULL, NULL),
  ('C-GT', '2026-10-05', 2, 'CCC', 'Sea Co', 100, 99, 104, 95, 1, 'pending', NULL, NULL, 0, NULL, NULL, NULL, NULL),
  ('A-GT-CX', '2026-10-05', 1, 'BBB', 'Bee Inc', 100, 99, 119, 95, 1, 'closed', '2026-10-05', 99, 1, '2026-10-05', 119, 'tp', 20),
  ('A-GT-CX', '2026-10-05', 2, 'CCC', 'Sea Co', 100, 99, 104, 95, 1, 'open', '2026-10-05', 99, 1, NULL, NULL, NULL, NULL);

INSERT INTO book_targets (strategy_id, session_date, rank, symbol, weight, last_price) VALUES
  ('RAW35-FR-GT', '2026-09-29', 1, 'XOM', 1.0, 50),
  ('RAW35-FR-GT', '2026-10-01', 1, 'XOM', 0.5, 50),
  ('RAW35-FR-GT', '2026-10-01', 2, 'NVDA', 0.3, 100),
  ('RAW35-FR-GT', '2026-10-01', 3, 'AMD', 0.2, 100),
  ('RAW35-FR-GT-CX', '2026-10-01', 1, 'NVDA', 0.6, 100),
  ('RAW35-FR-GT-CX', '2026-10-01', 2, 'AMD', 0.4, 100);

INSERT INTO book_fills (strategy_id, session_date, seq, symbol, side, shares, price, cash_usd, cost_usd, reason) VALUES
  ('RAW35-FR-GT', '2026-10-01', 1, 'XOM', 'buy', 6, 50, -300, 0.5, 'entry'),
  ('RAW35-FR-GT', '2026-10-01', 2, 'NVDA', 'buy', 1.8, 100, -180, 0.3, 'entry'),
  ('RAW35-FR-GT', '2026-10-01', 3, 'AMD', 'buy', 1.2, 100, -120, 0.2, 'entry'),
  ('RAW35-FR-GT', '2026-10-02', 1, 'XOM', 'sell', 0.2, 51, 10.2, 0.1, 'trim'),
  ('RAW35-FR-GT-CX', '2026-10-02', 1, 'NVDA', 'buy', 3.6, 100, -360, 0.25, 'entry'),
  ('RAW35-FR-GT-CX', '2026-10-02', 2, 'AMD', 'buy', 2.4, 100, -240, 0.15, 'entry');

INSERT INTO bars (symbol, date, open, high, low, close, volume)
SELECT symbol, date::date, close, close, close, close, 1000 FROM (VALUES
  ('AAA', '2026-10-02', 100), ('AAA', '2026-10-05', 98), ('AAA', '2026-10-06', 96), ('AAA', '2026-10-07', 94),
  ('AAA', '2026-10-08', 92), ('AAA', '2026-10-09', 90), ('AAA', '2026-10-12', 200),
  ('BBB', '2026-10-02', 100), ('BBB', '2026-10-05', 101), ('BBB', '2026-10-06', 102), ('BBB', '2026-10-07', 103),
  ('BBB', '2026-10-08', 103.5), ('BBB', '2026-10-09', 104),
  ('CCC', '2026-10-02', 100), ('CCC', '2026-10-05', 100.5), ('CCC', '2026-10-06', 101), ('CCC', '2026-10-07', 101.5),
  ('CCC', '2026-10-08', 101.8), ('CCC', '2026-10-09', 102),
  ('XOM', '2026-09-30', 50), ('XOM', '2026-10-01', 51), ('XOM', '2026-10-14', 45), ('XOM', '2026-10-15', 99),
  ('NVDA', '2026-09-30', 100), ('NVDA', '2026-10-01', 101), ('NVDA', '2026-10-14', 110),
  ('AMD', '2026-09-30', 100), ('AMD', '2026-10-01', 100), ('AMD', '2026-10-14', 100)
) AS b(symbol, date, close);

INSERT INTO news_vetoes (strategy_id, session_date, rank, symbol, verdict, reason, model, prompt_version, headlines, earnings_date, decided_at) VALUES
  ('C-GT', '2026-10-05', 1, 'AAA', 'allow', 'No company-specific event in the window.', 'glm-5.3', 'c-veto-v1', '[]', NULL, '2026-10-05T06:30:00Z'),
  ('C-GT', '2026-10-05', 2, 'BBB', 'veto', 'Earnings released inside the last 3 days.', 'glm-5.3', 'c-veto-v1', '[]', NULL, '2026-10-05T06:30:00Z'),
  ('C-GT', '2026-10-05', 3, 'CCC', 'allow', 'Routine headlines only.', 'glm-5.3', 'c-veto-v1', '[]', NULL, '2026-10-05T06:30:00Z');

INSERT INTO strategy_candidates (strategy_id, session_date, data_date, kind, rank, symbol, weight, evidence) VALUES
  ('A-GT', '2026-10-05', '2026-10-02', 'bracket', 1, 'AAA', NULL, NULL),
  ('A-GT', '2026-10-05', '2026-10-02', 'bracket', 2, 'BBB', NULL, NULL),
  ('A-GT', '2026-10-05', '2026-10-02', 'bracket', 3, 'CCC', NULL, NULL),
  ('A-GT', '2026-10-06', '2026-10-05', 'bracket', 1, 'AAA', NULL, NULL),
  ('A-GT', '2026-10-06', '2026-10-05', 'bracket', 2, 'DDD', NULL, NULL),
  ('A-GT', '2026-10-07', '2026-10-06', 'bracket', 1, 'EEE', NULL, NULL),
  ('A-GT', '2026-10-08', '2026-10-07', 'bracket', 1, 'FFF', NULL, NULL),
  ('RAW35-FR-GT', '2026-10-01', '2026-09-30', 'book', 1, 'XOM', 0.5, NULL),
  ('RAW35-FR-GT', '2026-10-01', '2026-09-30', 'book', 2, 'NVDA', 0.3, NULL),
  ('RAW35-FR-GT', '2026-10-01', '2026-09-30', 'book', 3, 'AMD', 0.2, NULL),
  ('RAW35-FR-GT', '2026-10-15', '2026-10-14', 'book', 1, 'NVDA', 0.5, NULL),
  ('RAW35-FR-GT', '2026-10-15', '2026-10-14', 'book', 2, 'AMD', 0.5, NULL);

-- Session opens (EDT): 2026-10-01/05/06 open at 13:30Z. Verdict 5 is late (13:45Z on 10-06).
INSERT INTO adversary_verdicts (id, strategy_id, session_date, symbol, verdict, reason, sources, lens, model, prompt_version,
                                host, started_at, decided_at) VALUES
  (1, 'A-GT', '2026-10-05', 'AAA', 'agree', 'A first look found nothing behind the dip.',
   '[{"url": "https://example.com/aaa-first", "title": "AAA note", "publisher": "example.com", "published_at": "2026-10-04T12:00:00Z", "fetched_at": "2026-10-05T11:55:00Z"}]',
   'a-dip@1', 'claude-opus-5-5', 'pv-a1', 'lenovo', '2026-10-05T11:50:00Z', '2026-10-05T12:00:00Z'),
  (2, 'A-GT', '2026-10-05', 'AAA', 'object', 'It fell on a lower forecast. That is a re-pricing, not a dip.',
   '[{"url": "https://www.sec.gov/aaa-8k", "title": "8-K", "publisher": "sec.gov", "published_at": "2026-10-04T21:00:00Z", "fetched_at": "2026-10-05T12:55:00Z"}, {"url": "https://www.benzinga.com/aaa", "title": "AAA cuts outlook", "publisher": "benzinga.com", "published_at": "2026-10-04T22:00:00Z", "fetched_at": "2026-10-05T12:56:00Z"}]',
   'a-dip@1', 'claude-opus-5-5', 'pv-a1', 'lenovo', '2026-10-05T12:50:00Z', '2026-10-05T13:00:00Z'),
  (3, 'A-GT', '2026-10-05', 'BBB', 'agree', 'The dip matches its whole group, the noise this rule buys.',
   '[{"url": "https://example.com/bbb", "title": "Sector recap", "publisher": "example.com", "published_at": null, "fetched_at": "2026-10-05T13:00:00Z"}]',
   'a-dip@1', 'claude-opus-5-5', 'pv-a1', 'lenovo', '2026-10-05T12:55:00Z', '2026-10-05T13:05:00Z'),
  (4, 'A-GT', '2026-10-05', 'CCC', 'unsure', 'I could not find why it dipped, so the pick stands.', '[]',
   'a-dip@1', 'claude-opus-5-5', 'pv-a1', 'lenovo', '2026-10-05T13:00:00Z', '2026-10-05T13:10:00Z'),
  (5, 'A-GT', '2026-10-06', 'DDD', 'object', 'Results are due tomorrow, inside the holding window.',
   '[{"url": "https://example.com/ddd", "title": "Earnings date", "publisher": "example.com", "published_at": null, "fetched_at": "2026-10-06T13:30:00Z"}]',
   'a-dip@2', 'claude-opus-5-5', 'pv-a2', 'gpd', '2026-10-06T13:20:00Z', '2026-10-06T13:45:00Z'),
  (6, 'RAW35-FR-GT', '2026-10-01', 'XOM', 'object', 'Its rise is the oil price''s rise, and that push looks spent for the month.',
   '[{"url": "https://www.eia.gov/petroleum", "title": "Weekly petroleum status", "publisher": "eia.gov", "published_at": "2026-09-30T14:00:00Z", "fetched_at": "2026-09-30T19:55:00Z"}]',
   'raw35@1', 'claude-opus-5-5', 'pv-raw1', 'gpd', '2026-09-30T19:50:00Z', '2026-09-30T20:00:00Z'),
  (7, 'RAW35-FR-GT', '2026-10-01', 'NVDA', 'agree', 'The rise rests on orders that run for quarters.',
   '[{"url": "https://example.com/nvda", "title": "Orders", "publisher": "example.com", "published_at": null, "fetched_at": "2026-09-30T20:00:00Z"}]',
   'raw35@1', 'claude-opus-5-5', 'pv-raw1', 'gpd', '2026-09-30T19:55:00Z', '2026-09-30T20:05:00Z'),
  (8, 'RAW35-FR-GT', '2026-10-01', 'AMD', 'agree', 'Nothing one-off behind the move.',
   '[{"url": "https://example.com/amd", "title": "AMD", "publisher": "example.com", "published_at": null, "fetched_at": "2026-09-30T20:05:00Z"}]',
   'raw35@1', 'claude-opus-5-5', 'pv-raw1', 'gpd', '2026-09-30T20:00:00Z', '2026-09-30T20:10:00Z');
UPDATE adversary_verdicts SET superseded_by = 2 WHERE id = 1;
SELECT setval(pg_get_serial_sequence('adversary_verdicts', 'id'), (SELECT max(id) FROM adversary_verdicts));

INSERT INTO adversary_marks (strategy_id, session_date, mark, host) VALUES ('A-GT', '2026-10-07', 'paused', 'lenovo');
