# Phase 2: Seer twin machinery: roster twins, lag stepping, verdict filter, paper_check, promote

**Plan set:** `SEER_ADVERSARIAL_PLAN.md`
**Analysis:** `/home/miftah/.worktrees/mcp-notes/seer-adversarial/.workflows/analyze/20261105-084640-SA7K_code_analyzer.md`
**Satisfies:** R1 (twin roster rows, decide-late twins), R2 (decide-late confirmed in the one-session-lag form, implemented here) -- every eligible Seer method gets a Claude twin that paper-trades its method minus what Claude objected to before the session opened
**Depends on:** Phase 1
**Difficulty:** HARD
**Package:** seer `engine/` (code lives in `/home/miftah/.worktrees/seer/seer-adversarial`, branch `feature/seer-adversarial`)

All paths below are relative to the Seer worktree root `/home/miftah/.worktrees/seer/seer-adversarial`
unless they start with `/`. Line numbers are against Seer `a6322d7` (the worktree base); phase 1 lands
first and may shift them -- find each site by the quoted code, not by the number.

---

## Goal

After this phase, the paper night creates a Claude twin (`<ID>-CX`, `twin_of = <ID>`) for every
active original that is not the benchmark and not C, and retires a twin when its original retires,
in the night's own transaction and in `promote`'s. Twins are stepped one session behind their
originals (Decision D1): a twin decides session S on the night after S closed, from the original's
own method on `view(prev_session(S))`, dropping exactly the symbols whose latest verdict decided
before S's open is `object` (books renormalise pro rata). `paper_check` replays twins through the
same verdict reader and passes; with no verdicts a twin's record is its original's, one session
shorter.

## Interface Contract

**Deletes:** `seer_engine.paper.store.is_twin(conn, strategy_id)` (phase 1) and its test
`test_is_twin_reads_the_column` (`engine/tests/test_paper_candidates.py`, phase 1). Reconciled: one
twin mechanism only. Phase 1 needed a DB read because no entry carried `twin_of` yet; from this phase
on `RosterEntry.twin_of` is the single source (Step 9), and nothing else in the plan set calls
`is_twin` (phases 3-7 never import the engine).

**Renames:** the index's `roster.ensure_twins(conn)` is delivered as **`store.ensure_twins(conn)`**
(impure, `paper/store.py`) plus the pure planner **`roster.plan_twins(rows)`**. `paper/roster.py` must
stay pure (`tests/test_strategy_purity.py` globs it; it may not touch a connection).

**Creates:**
- `seer_engine.strategies.twin` (new module, pure): `FILTER_VERSION = "adversary-v1"`,
  `VERDICTS = ("agree", "object", "unsure")`, `objected_map(rows) -> dict[date, frozenset[str]]`,
  `TwinStrategy` (bracket wrapper: `inner`, `objected`, `with_objected()`), `TwinBook` /
  `MarketAwareTwinBook` (book wrapper: `inner`, `rules`, `objected`, `with_objected()`),
  `twin_book(inner, rules)`, `renormalised(wanted, drop)`.
- `seer_engine.paper.roster`: `TWIN_SUFFIX = "-CX"`, `TWIN_NAME_MARK = "+Claude"`,
  `TWIN_GATE_NOTE` (C2 text, verbatim), `twin_id(original_id)`, `twin_name(name)`,
  `twin_eligible(row)`, `twin_row(original) -> RosterRow`, `TwinPlan(create, retire)`,
  `plan_twins(rows) -> TwinPlan`; field `twin_of: str | None = None` on `Row` (protocol),
  `RosterRow`, `RosterEntry`; spec key `"twin": {"of": <original id>, "filter": "adversary-v1"}`
  present only on twins.
- `seer_engine.paper.store`: field `StrategyRow.twin_of`, `_STRATEGY_SQL` selects `twin_of`;
  `TwinChanges(created, retired, changed)`, `ensure_twins(conn) -> TwinChanges`,
  `objected_between(conn, strategy_id, start, end) -> dict[date, frozenset[str]]` (C3; `strategy_id`
  is the ORIGINAL).
- `seer_engine.commands.paper`: `twin_dates(rd)`, `run_dates_for(e, rd)`, `_read_night(conn, rd, *,
  ensure_twins)`, `_twin_may_start(original_row, erd)`, `_book_allocator(conn, e, first, last)`.
- `.claude/skills/verify-seer/features/steps/twin-world.py` (seeds a verify-seer run's own DB with
  the engine suite's synthetic market and writes a test verdict; the proof lever).

**Signature changes:**
- `paper.execute(conn, *, now, dry_run=False)` -> `paper.execute(conn, *, now, dry_run=False, ensure_twins=True)`.
  The CLI never passes it; `False` only in test worlds that pin their own entries.
- `paper._night(conn, rd, plan, run_id)` -> `paper._night(conn, rd, plan, run_id, *, ensure_twins=True)`.
- `paper._bracket_strategy(conn, e, first, last)`: same signature; now also wraps twins.
- `paper._reviewable(conn, e)` (phase 1) -> `paper._reviewable(e)`: reads `e.twin_of` instead of
  `store.is_twin`; every phase-1 call site (`repick` x2, `_start`, `_step_bracket`, `_step_book`)
  drops the `conn` argument (Step 9).

**Behaviour contract other phases read (C2/C3 as implemented):**
- Twin row: id `<ORIGINAL>-CX`; `name` = original's head + `+Claude` + ` · ` + tail; same `sub`,
  `icon`, `sort`, `engine`, `rules_id`, `object_name`, `registry_id`; `is_champion=false`,
  `is_benchmark=false`, `gate_applicable=false`, `gate_note=TWIN_GATE_NOTE`, `promoted_from=NULL`,
  `params='{}'` until its first night, `status='active'`, `paper_start` NULL until it starts.
- Eligible original: `status='active' AND twin_of IS NULL AND NOT is_benchmark AND engine IN
  ('bracket','book')` and its `object_name` resolves to an object that is not a `NewsVeto`.
  On the migrated roster after phase 1: `A-GT`, `RAW35-FR-GT`, `COSK-FR-GT` (not `C-GT`, not `SPY-GT`).
- A twin starts on the first night where `prev_session`-lagged `session_date` (= that night's
  `data_date`) is `>=` its original's `paper_start`; its `paper_start` is that session. For a brand
  new original (A-GT, a promotion) that is the night after the original starts, with the same
  `paper_start`.
- A twin's `paper_state.last_session` is its original's minus one session; its `pending_session`
  is the session that already closed tonight. Twins have pending orders/targets only for sessions
  that have already traded; they are never tickets.
- Twins write `orders`, `book_targets`, `book_previews`, `equity_snapshots`, `paper_contributions`
  under their own id; they write **no** `strategy_candidates` (phase 1's `_reviewable` returns False
  for them, Step 9). A twin book's preview carries `next_decision_session` exactly as phase 1 writes it
  for every preview (a true fact about its cadence, display only); the reviewer never reads it
  because phase 4 reads previews only for reviewable originals (`twin_of IS NULL`). Index Decision D16.
- Verdict filter: per (original, session S, symbol) the row with the greatest `(decided_at, id)`
  among `decided_at < dates.session_open_utc(S)`; only `object` drops. `superseded_by` is not read.
  Books: applied at rank and kickoff sessions; ignored at resize-only sessions.
- `explain` never explains a twin's entries (no LLM spend on twins).

**Requires (from earlier phases):**
- Phase 1: migration `027_adversary.sql` with `strategies.twin_of` (+ unique active-twin index),
  `adversary_verdicts` with the C1 columns (`strategy_id, session_date, symbol, verdict, reason,
  sources, lens, model, prompt_version, host, started_at, decided_at, superseded_by, id`) and an
  append-only trigger that allows INSERT and `UPDATE superseded_by` NULL -> id.
- Phase 1: `seer_engine.dates.session_open_utc(d: date) -> datetime` (tz-aware UTC; 2026-11-04 ->
  14:30Z, 2026-07-01 -> 13:30Z).
- Phase 1: `A-GT` in `roster.SEED_ROWS` (bracket, `design-v0-gotrade`, `STRATEGY_A`, active) and in
  migration 027; `strategy_candidates` written by `commands/paper.py` for originals.

**Leaves alone (owned by others):** `db/migrations/*` incl. 027 (phase 1); `dates.py` (phase 1);
the `strategy_candidates` / `next_decision_session` writers themselves (phase 1 -- this phase only
adds the twin guard to their call sites); `web/` (phase 3, incl. `web/scripts/seed-demo.mjs` twin
rows); mcp-notes (phases 4-7); `.claude/skills/verify-seer/SKILL.md` roster counts (phase 1).

## Files

| File | Action | What changes |
|---|---|---|
| `engine/src/seer_engine/strategies/twin.py` | create | verdict cutoff rule, bracket and book wrappers |
| `engine/src/seer_engine/paper/roster.py` | modify | `twin_of` on Row/RosterRow/RosterEntry; twin constants/helpers; `from_row` wraps twins; `from_rows` checks twins; `plan_twins`; spec twin marker; docstring |
| `engine/src/seer_engine/paper/store.py` | modify | `StrategyRow.twin_of`, `_STRATEGY_SQL`, `_strategy`; `TwinChanges`, `ensure_twins`; `objected_between`; delete phase 1's `is_twin` |
| `engine/src/seer_engine/commands/paper.py` | modify | docstring; lagged run dates; `execute`/`_read_night`/`plan_night`/`_night`/`_trade`; `_bracket_strategy`, `_book_allocator`; book call sites in `repick`/`_start`/`_step_book` (phase 1's versions); `_reviewable(e)` reads `e.twin_of` (replaces phase 1's `_reviewable(conn, e)`) |
| `engine/src/seer_engine/commands/paper_check.py` | modify | book replay uses `_book_allocator`; docstring |
| `engine/src/seer_engine/commands/promote.py` | modify | `ensure_twins` inside the promotion transaction |
| `engine/src/seer_engine/commands/explain.py` | modify | skip twins in `_STRATEGIES_SQL`; docstring |
| `engine/tests/test_twin.py` | create | pure tests: cutoff, wrappers, roster twin rules, spec |
| `engine/tests/test_paper_twins.py` | create | DB tests: creation, lag, equality, objections, catch-up, retire, replay, explain |
| `engine/tests/test_promote_command.py` | modify | twin created/retired in the promotion transaction |
| `engine/tests/test_paper_command.py` | modify | `ensure_twins=False` in `go` and the two weekend calls |
| `engine/tests/test_paper_check.py` | modify | `ensure_twins=False` in `night` |
| `engine/tests/test_paper_split_cadence.py` | modify | `ensure_twins=False` in `night` |
| `engine/tests/test_paper_c.py` | modify | `ensure_twins=False` in `go` |
| `engine/tests/test_veto_command.py` | modify | `ensure_twins=False` in the two direct `paper.execute` calls |
| `engine/tests/test_paper_candidates.py` | modify | delete phase 1's `test_is_twin_reads_the_column` and the `is_twin` clause of its module docstring (`store.is_twin` is deleted) |
| `docs/runbooks/paper-trading.md` | modify | new section "Claude twins (Seer Adversarial)"; night diagram line |
| `README.md` | modify | one paragraph under "One night, step by step" |
| `.claude/skills/verify-seer/features/engine-night.md` | modify | sub-feature, journeys, gotchas for twins |
| `.claude/skills/verify-seer/features/README.md` | modify | engine-night row mentions Claude twins |
| `.claude/skills/verify-seer/features/steps/twin-world.py` | create | seed script for the twin journeys |

## Implementation Steps

### Step 1: The pure verdict rule and the two wrappers
**File:** `engine/src/seer_engine/strategies/twin.py` (new)
**Change:** New pure module. Every later step uses it.
**Code:**
```python
"""Claude twins: an original's own method, minus what Claude objected to in time (Seer Adversarial).

Plan seer-adversarial phase 2; contracts C2 (twin rows) and C3 (verdict application); owner
decisions 1, 4 and 6 of docs/plans/2026-11-05-seer-adversarial-design.md (mcp-notes repo).

A twin is a roster row ``<ORIGINAL>-CX`` that runs its original's method with exactly one change:
a symbol Claude objected to, before the session it was picked for opened, is not bought. This
module is that change, as two wrappers -- one around a bracket ``Strategy``, one around a book
``Allocator`` -- plus the pure rule that turns stored verdict rows into "what was objected to,
per session".

**Why wrappers and not a new strategy.** Wherever Claude said nothing the twin must be its
original to the last decimal: the same ranking, sizing, fees, deposits and evidence. Wrapping the
original's own object keeps every one of those on the original's code path; the wrapper only ever
removes symbols from what that object returned.

**The cutoff (C3, honesty rule "information cutoff").** A verdict counts for session S only when
its ``decided_at`` is strictly before ``dates.session_open_utc(S)``. Per symbol the latest such row
wins, a tie on ``decided_at`` going to the higher id (the later insert). ``superseded_by`` is
history for people and is never read here: "the latest review before the open" already says which
one stood when the market opened. Only ``object`` drops a symbol. ``agree``, ``unsure``, a late
row and no row at all keep it -- the twin copies the original, which is what "absent" and
"paused" mean (owner decision 4).

**Bracket (TwinStrategy).** ``picks`` is the inner strategy's ranked list minus the symbols
objected to for ``next_session(data_date)``. ``sim.size_picks`` walks that list into the free
slots, so the next-ranked pick takes an objected pick's slot exactly as it does for C (owner
decision 1).

**Book (TwinBook).** On a rank session (a kickoff included) the inner targets minus the objected
symbols, each kept weight scaled by ``total / kept_total`` and rounded DOWN to ``WEIGHT_QUANTUM``,
so the twin is as invested as the original chose to be and never more (pro rata, no
up-weighting: owner decision 1). Every target objected gives ``()``, which is what the original's
own empty decision is, so ``_with_idle`` and the step treat it exactly the same way (plan Decision
D6). A resize-only session (split cadence) ignores objections: its targets only set the exposure
the frozen basket is re-scaled to, and that basket was filtered when it was ranked (Decision D3).
A kickoff that lands on a resize-only session is therefore not filtered -- conservative: it copies
the original, as an absent review would. An objected name the book holds drops out of the targets,
so ``sim.book.step_book`` sells it and the fees count against Claude (owner decision 6).

``TwinBook`` forwards ``prepare_market`` only when its inner allocator is ``MarketAware``
(``MarketAwareTwinBook``): ``isinstance(x, MarketAware)`` is attribute presence, so a wrapper that
always had it would send every plain allocator down the prepared branch and the twin would no
longer be its original's code path.

**The lag (Decision D1)** is not here: ``commands.paper`` steps a twin as if tonight's data date
were the previous session, so every verdict it reads has a cutoff already in the past and a replay
on any later night reads the same set (``paper_check`` stays stable).

Pure, like every ``strategies`` module (tests/test_strategy_purity.py).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from collections.abc import Set as AbstractSet
from dataclasses import dataclass, field, replace
from datetime import date, datetime
from decimal import ROUND_DOWN, Decimal
from types import MappingProxyType
from typing import Any

from seer_engine import dates
from seer_engine.sim import Pick
from seer_engine.sim.book import WEIGHT_QUANTUM, Target
from seer_engine.sim.rules import TradeRules, is_resize_session
from seer_engine.strategies.allocator import Allocator, MarketAware
from seer_engine.strategies.base import History, Strategy

#: The rule this module implements, frozen into every twin's spec (``paper.roster.spec``). A change
#: to what a twin does with a verdict is a change to the strategy: it moves the twin's digest, and
#: ``store.check_digest`` then refuses the twin's next night (a changed strategy needs a new id).
FILTER_VERSION = "adversary-v1"

#: ``adversary_verdicts.verdict``'s CHECK (migration 027), as a Python value.
VERDICTS: tuple[str, ...] = ("agree", "object", "unsure")

Objected = Mapping[date, frozenset[str]]

#: One ``adversary_verdicts`` row as ``store.objected_between`` reads it:
#: ``(session_date, symbol, verdict, decided_at, id)``.
VerdictRow = tuple[date, str, str, datetime, int]


def _day(name: str, d: object) -> date:
    if isinstance(d, datetime) or not isinstance(d, date):
        raise TypeError(f"{name} must be a date, got {type(d).__name__}")
    return d


def _objected(objected: Mapping[date, Iterable[str]]) -> Objected:
    """``objected`` as a read-only ``{session: frozenset(symbols)}``; empty sessions dropped."""
    if not isinstance(objected, Mapping):
        raise TypeError(f"objected must be a Mapping, got {type(objected).__name__}")
    out: dict[date, frozenset[str]] = {}
    for session, symbols in objected.items():
        _day("objected session", session)
        if isinstance(symbols, str):
            raise TypeError(f"objected[{session}] must be a set of symbols, got a str")
        frozen = frozenset(symbols)
        for s in frozen:
            if not isinstance(s, str) or not s:
                raise TypeError(f"objected[{session}] holds a non-symbol {s!r}")
        if frozen:
            out[session] = frozen
    return MappingProxyType(out)


def objected_map(rows: Iterable[VerdictRow]) -> dict[date, frozenset[str]]:
    """``{session: symbols whose standing verdict at the session's open is 'object'}`` (C3).

    For each ``(session, symbol)``, among the rows with ``decided_at < session_open_utc(session)``,
    the one with the greatest ``(decided_at, id)`` stands; the symbol is in the result when that
    row says ``object``. A session nobody objected in is absent: look up with
    ``.get(session, frozenset())``.

    ValueError on a verdict outside :data:`VERDICTS` or a naive ``decided_at``; TypeError on a
    ``session_date`` that is not a date. These are database rows, validated once here, at the edge.
    """
    standing: dict[tuple[date, str], tuple[datetime, int, str]] = {}
    for session, symbol, verdict, decided_at, row_id in rows:
        _day("session_date", session)
        if verdict not in VERDICTS:
            raise ValueError(f"{session} {symbol}: verdict {verdict!r} is not one of {VERDICTS}")
        if not isinstance(decided_at, datetime) or decided_at.utcoffset() is None:
            raise ValueError(f"{session} {symbol}: decided_at must be a tz-aware datetime, got {decided_at!r}")
        if decided_at >= dates.session_open_utc(session):
            continue  # decided at or after the open: late, the twin copies the original
        key = (session, symbol)
        seen = standing.get(key)
        if seen is None or (decided_at, row_id) > (seen[0], seen[1]):
            standing[key] = (decided_at, row_id, verdict)
    out: dict[date, set[str]] = {}
    for (session, symbol), (_, _, verdict) in standing.items():
        if verdict == "object":
            out.setdefault(session, set()).add(symbol)
    return {session: frozenset(symbols) for session, symbols in sorted(out.items())}


def renormalised(wanted: Sequence[Target], drop: AbstractSet[str]) -> tuple[Target, ...]:
    """``wanted`` without the ``drop`` symbols, the rest scaled pro rata to the same total weight.

    Each kept weight is ``weight * total / kept_total`` rounded DOWN to ``WEIGHT_QUANTUM``, so the
    result never weighs more than ``wanted`` did. ``wanted`` itself when nothing is dropped; ``()``
    when everything is. Prices, limits, stops and takes are kept as the allocator set them.
    """
    targets = tuple(wanted)
    kept = tuple(t for t in targets if t.symbol not in drop)
    if len(kept) == len(targets):
        return targets
    if not kept:
        return ()
    total = sum((t.weight for t in targets), Decimal(0))
    kept_total = sum((t.weight for t in kept), Decimal(0))
    out: list[Target] = []
    for t in kept:
        weight = min((t.weight * total / kept_total).quantize(WEIGHT_QUANTUM, rounding=ROUND_DOWN), Decimal(1))
        if weight > 0:
            out.append(replace(t, weight=weight))
    return tuple(out)


@dataclass(frozen=True, eq=False)
class TwinStrategy:
    """A bracket ``Strategy``'s Claude twin: ``inner``'s ranked picks minus the objected symbols.

    ``objected`` maps the session being bought for to the symbols dropped for it; picks for
    ``data_date`` are for ``next_session(data_date)``, so that is the key looked up. The roster
    object carries no objections (it buys exactly what ``inner`` buys); ``commands.paper`` and
    ``paper_check`` hand the engine a copy carrying them (``with_objected``).
    """

    inner: Strategy
    objected: Objected = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not isinstance(self.inner, Strategy):
            raise TypeError(f"inner must be a Strategy, got {type(self.inner).__name__}")
        if isinstance(self.inner, TwinStrategy):
            raise TypeError("a Claude twin wraps an original, never another twin")
        object.__setattr__(self, "objected", _objected(self.objected))

    @property
    def id(self) -> str:
        return self.inner.id

    @property
    def lookback(self) -> int:
        return self.inner.lookback

    def _dropped(self, data_date: date) -> frozenset[str]:
        if not self.objected:
            return frozenset()
        return self.objected.get(dates.next_session(data_date), frozenset())

    def picks(
        self,
        history: Mapping[str, History],
        members: AbstractSet[str],
        data_date: date,
        params: Any,
    ) -> list[Pick]:
        drop = self._dropped(data_date)
        return [p for p in self.inner.picks(history, members, data_date, params) if p.symbol not in drop]

    def prepare(self, history: Mapping[str, History]) -> Any:
        return self.inner.prepare(history)

    def picks_prepared(
        self,
        prepared: Any,
        members: AbstractSet[str],
        data_date: date,
        params: Any,
    ) -> list[Pick]:
        drop = self._dropped(data_date)
        return [p for p in self.inner.picks_prepared(prepared, members, data_date, params) if p.symbol not in drop]

    def with_objected(self, objected: Mapping[date, Iterable[str]]) -> TwinStrategy:
        """This twin carrying ``objected`` (same inner strategy)."""
        return replace(self, objected=objected)


@dataclass(frozen=True, eq=False)
class TwinBook:
    """A book ``Allocator``'s Claude twin: ``inner``'s targets minus the objected symbols, pro rata.

    ``rules`` are the twin's (= its original's) book rules, read only to tell a resize-only session
    from a rank session. ``objected`` is keyed by the session decided, ``next_session(data_date)``.
    """

    inner: Allocator
    rules: TradeRules
    objected: Objected = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not isinstance(self.inner, Allocator):
            raise TypeError(f"inner must be an Allocator, got {type(self.inner).__name__}")
        if isinstance(self.inner, TwinBook):
            raise TypeError("a Claude twin wraps an original, never another twin")
        if not isinstance(self.rules, TradeRules) or self.rules.engine != "book":
            raise ValueError(f"a book twin needs book rules, got {self.rules!r}")
        object.__setattr__(self, "objected", _objected(self.objected))

    @property
    def id(self) -> str:
        return self.inner.id

    def lookback(self, params: Any) -> int:
        return self.inner.lookback(params)

    def symbols(self, params: Any) -> tuple[str, ...]:
        return self.inner.symbols(params)

    def holds(self, params: Any) -> tuple[str, ...]:
        return self.inner.holds(params)

    def uses_members(self, params: Any) -> bool:
        return self.inner.uses_members(params)

    def _filter(self, data_date: date, wanted: Iterable[Target]) -> tuple[Target, ...]:
        targets = tuple(wanted)
        if not self.objected:
            return targets
        session = dates.next_session(data_date)
        drop = self.objected.get(session)
        if not drop or is_resize_session(self.rules, session):
            return targets
        return renormalised(targets, drop)

    def targets(
        self,
        history: Mapping[str, History],
        members: AbstractSet[str],
        data_date: date,
        held: frozenset[str],
        params: Any,
    ) -> tuple[Target, ...]:
        return self._filter(data_date, self.inner.targets(history, members, data_date, held, params))

    def prepare(self, history: Mapping[str, History]) -> Any:
        return self.inner.prepare(history)

    def targets_prepared(
        self,
        prepared: Any,
        members: AbstractSet[str],
        data_date: date,
        held: frozenset[str],
        params: Any,
    ) -> tuple[Target, ...]:
        return self._filter(data_date, self.inner.targets_prepared(prepared, members, data_date, held, params))

    def with_objected(self, objected: Mapping[date, Iterable[str]]) -> TwinBook:
        """This twin carrying ``objected`` (same inner allocator and rules, same class)."""
        return replace(self, objected=objected)


@dataclass(frozen=True, eq=False)
class MarketAwareTwinBook(TwinBook):
    """``TwinBook`` around a ``MarketAware`` allocator (FUNDAMENTAL): forwards ``prepare_market``."""

    def prepare_market(self, market: Any) -> Any:
        return self.inner.prepare_market(market)  # type: ignore[attr-defined]


def twin_book(inner: Allocator, rules: TradeRules) -> TwinBook:
    """The book twin of ``inner`` under ``rules``, MarketAware exactly when ``inner`` is."""
    if isinstance(inner, MarketAware):
        return MarketAwareTwinBook(inner=inner, rules=rules)
    return TwinBook(inner=inner, rules=rules)
```
**Impact:** none until Step 2 wires it in. Covered by `tests/test_strategy_purity.py` automatically (glob).

### Step 2: Roster -- `twin_of` on the row and the entry, twin constants
**File:** `engine/src/seer_engine/paper/roster.py`
**Change:** (a) import, (b) constants after `BASES` (line ~241, before any code that runs at import),
(c) `twin_of` on `RosterEntry` (line 316-363), `Row` (line 934-956), `RosterRow` (line 959-977).
**Code:**

(a) Add after `from seer_engine.strategies.f_index import TIMING` (line 147):
```python
from seer_engine.strategies.twin import FILTER_VERSION as TWIN_FILTER_VERSION
from seer_engine.strategies.twin import TwinStrategy, twin_book
```

(b) Insert after the `BASES` definition (line 241):
```python
#: Seer Adversarial (contract C2): the Claude twin of roster entry ``X`` is the row ``X-CX``.
TWIN_SUFFIX = "-CX"

#: What a twin's display name adds to its original's head (the part before `` · ``).
TWIN_NAME_MARK = "+Claude"

#: Every twin row's ``gate_note`` (C2, verbatim). ``gate_applicable`` is false on every twin: a
#: backtest of a method that asks Claude is impossible, because Claude knows how the past went.
TWIN_GATE_NOTE = "Claude twin: no backtest is possible, Claude already knows how the past turned out."


def twin_id(original_id: str) -> str:
    """The roster id of ``original_id``'s Claude twin: ``RAW35-FR-GT`` -> ``RAW35-FR-GT-CX``."""
    return f"{original_id}{TWIN_SUFFIX}"


def twin_name(name: str) -> str:
    """``name`` with ``+Claude`` on its head: ``RAW35 · Momentum`` -> ``RAW35+Claude · Momentum``.

    A name without `` · `` gets the mark at its end: ``X`` -> ``X+Claude``.
    """
    head, sep, tail = name.partition(" · ")
    return f"{head}{TWIN_NAME_MARK}{sep}{tail}"
```

(c) In `class RosterEntry`, add the field after `lab_provenance: LabProvenance | None = None`, and
add this paragraph at the end of its docstring:
```python
    lab_provenance: LabProvenance | None = None
    twin_of: str | None = None
```
Docstring paragraph (append inside the `RosterEntry` docstring, before the closing quotes):
```text
    ``twin_of`` is the original's id when this entry is a Claude twin (Seer Adversarial, contract
    C2), else ``None``. A twin's ``obj`` is ``strategies.twin.TwinStrategy`` / ``TwinBook`` around
    its original's object, and everything else on the entry equals the original's except id, name,
    the gate fields and lifecycle. It is in :func:`spec` (the ``twin`` key): a twin is a different
    strategy from its original.
```
In `class Row(Protocol)` add after `paper_end: date | None`:
```python
    twin_of: str | None
```
In `class RosterRow` add after `paper_end: date | None = None`:
```python
    twin_of: str | None = None
```
**Impact:** `StrategyRow` must carry `twin_of` too (Step 6) for `Row` conformance. Every existing
`RosterRow(...)` call keeps working (default `None`); `SEED_ROWS` and `ROSTER` unchanged.

### Step 3: Roster -- `from_row` wraps a twin's object
**File:** `engine/src/seer_engine/paper/roster.py:997-1093`
**Change:** Replace `from_row` whole. New lines: the `twin_of` block after the lookback is known,
and `twin_of=twin_of` on the returned entry.
**Code:**
```python
def from_row(row: Row) -> RosterEntry:
    """One ``strategies`` row as a :class:`RosterEntry`, through :data:`RESOLVER`.

    Every failure is a :class:`RosterError` naming the row and what is wrong with it: there is
    no path through this function that returns a usable-looking entry for a row it did not fully
    understand, and no path that returns ``None``.

    A Claude twin (``row.twin_of`` set, contract C2) resolves its ``object_name`` exactly as its
    original does and then wraps the object (``strategies.twin``): ``TwinStrategy`` for a bracket
    row, ``twin_book`` for a book row. A twin of a benchmark or of C (a ``NewsVeto``: itself an
    LLM critic) cannot be built and is a :class:`BadRosterRow`. Whether the twin matches its
    original is a cross-row fact, checked by :func:`from_rows`.
    """
    sid = row.id
    if not isinstance(sid, str) or not sid:
        raise BadRosterRow(f"a roster row needs a non-empty id, got {sid!r}")
    engine = row.engine
    if engine not in ENGINES:
        raise BadRosterRow(f"{sid!r}: engine {engine!r} is not one of {ENGINES}")
    # Every RosterError out of this function names the ROW, not just the bad value: `paper`'s
    # failed-step message is the only place an operator sees it, and "NO_SUCH_OBJECT is not in
    # RESOLVER" without an id does not say which portfolio stopped the night (invariant 9).
    try:
        binding = resolve(row.object_name)
    except UnknownObject as exc:
        raise UnknownObject(f"{sid!r}: {exc}") from exc
    object_name: str = row.object_name  # resolve() accepted it, so it is a str
    try:
        rules = rules_for(row.rules_id)
    except UnknownRules as exc:
        raise UnknownRules(f"{sid!r}: {exc}") from exc
    registry_id = row.registry_id
    if engine == "benchmark":
        if binding.obj is not None or rules is not None or registry_id is not None:
            raise BadRosterRow(
                f"{sid!r}: a benchmark row carries no object, rules_id or registry_id "
                f"(object_name {object_name!r}, rules_id {row.rules_id!r}, registry_id {registry_id!r})"
            )
        obj: Strategy | Allocator | None = None
        params: Any = None
        lookback = 1
    else:
        if rules is None:
            raise BadRosterRow(f"{sid!r}: a {engine} row needs a rules_id")
        if binding.obj is None:
            raise BadRosterRow(
                f"{sid!r}: object {object_name!r} has no object; it can only run the benchmark engine"
            )
        if binding.from_registry:
            if not isinstance(registry_id, str) or not registry_id:
                raise BadRosterRow(
                    f"{sid!r}: object {object_name!r} takes its params from backtest.registry; "
                    f"registry_id is {registry_id!r}"
                )
            obj, params = _registered(registry_id, binding.obj, rules)
        else:
            if registry_id is not None:
                raise BadRosterRow(
                    f"{sid!r}: object {object_name!r} carries its own params; registry_id must be "
                    f"NULL, got {registry_id!r}"
                )
            obj, params = binding.obj, binding.params
        # Strategy.lookback is an int attribute; Allocator.lookback is a method of its params.
        lookback = obj.lookback(params) if engine == "book" else obj.lookback
        lookback = history_need(object_name, lookback)
    twin_of = row.twin_of
    if twin_of is not None:
        if not isinstance(twin_of, str) or not twin_of:
            raise BadRosterRow(f"{sid!r}: twin_of must be a strategy id or NULL, got {twin_of!r}")
        if obj is None:
            raise BadRosterRow(
                f"{sid!r}: a Claude twin of a benchmark cannot exist; the benchmark picks nothing "
                f"Claude could object to (twin_of {twin_of!r})"
            )
        if isinstance(obj, NewsVeto):
            raise BadRosterRow(
                f"{sid!r}: C is itself an LLM critic and gets no Claude twin (object {object_name!r}, "
                f"twin_of {twin_of!r})"
            )
        obj = TwinStrategy(inner=obj) if engine == "bracket" else twin_book(obj, rules)
    gate_note = row.gate_note
    if not isinstance(gate_note, str) or not gate_note:
        raise BadRosterRow(
            f"{sid!r}: gate_note is {gate_note!r}; every roster row states its backtest gate, "
            f"and 'failed' or 'not applicable' is a complete answer"
        )
    status = row.status
    if status not in STATUSES:
        raise BadRosterRow(f"{sid!r}: status {status!r} is not one of {STATUSES}")
    paper_end = row.paper_end
    if paper_end is not None and not isinstance(paper_end, date):
        raise BadRosterRow(f"{sid!r}: paper_end must be a date or None, got {paper_end!r}")
    return RosterEntry(
        id=sid,
        name=row.name,
        sub=row.sub,
        icon=row.icon,
        is_champion=bool(row.is_champion),
        is_benchmark=bool(row.is_benchmark),
        sort=int(row.sort),
        engine=engine,
        rules=rules,
        obj=obj,
        object_name=object_name,
        params=params,
        registry_id=registry_id,
        lookback=int(lookback),
        gate_note=gate_note,
        gate_applicable=bool(row.gate_applicable),
        status=status,
        paper_end=paper_end,
        # Keyed by roster id, not read off the row: the ``strategies`` table has one provenance
        # column (``promoted_from``, the method id) and no room for the rest, and this module may
        # not read ``lab/lab.sqlite`` to fill it in. A row whose id is not in the table gets
        # ``None`` -- correct for SPY, C and A, and caught for anything else by
        # ``tests/test_paper_roster.py``, which pins the set of ids that must carry one.
        lab_provenance=LAB_PROVENANCE.get(sid),
        twin_of=twin_of,
    )
```
**Impact:** a twin entry's `obj` is a wrapper; `obj.id` equals the original object's id, so the
spec's `object_id` is the original's.

### Step 4: Roster -- `from_rows` checks every twin against its original
**File:** `engine/src/seer_engine/paper/roster.py:1096-1106`
**Change:** Replace `from_rows`; add `_check_twins` right after it.
**Code:**
```python
def from_rows(rows: Iterable[Row]) -> tuple[RosterEntry, ...]:
    """Every row as an entry, by ``(sort, id)``. Raises on the FIRST row it cannot build.

    No row is ever dropped: either every row given becomes an entry, or nothing is returned.
    Claude twins are checked against their originals (:func:`_check_twins`).
    """
    entries = tuple(sorted((from_row(r) for r in rows), key=lambda e: (e.sort, e.id)))
    ids = [e.id for e in entries]
    dupes = sorted({i for i in ids if ids.count(i) > 1})
    if dupes:
        raise BadRosterRow(f"the roster rows carry duplicate ids: {dupes}")
    _check_twins(entries)
    return entries


def _check_twins(entries: Sequence[RosterEntry]) -> None:
    """BadRosterRow unless every twin names an original on the roster, is called ``twin_id`` of
    it, and runs its method exactly: the same engine, rules_id, object_name and registry_id.

    Lifecycle is NOT checked here: a twin whose original retired, or a twin of a twin, is still a
    buildable entry, and ``store.ensure_twins`` retires it at the start of the night's transaction.
    Refusing it here would stop the night before the repair could run.
    """
    by_id = {e.id: e for e in entries}
    for e in entries:
        if e.twin_of is None:
            continue
        original = by_id.get(e.twin_of)
        if original is None:
            raise BadRosterRow(f"{e.id!r}: twin_of {e.twin_of!r} is not a roster row")
        if e.id != twin_id(original.id):
            raise BadRosterRow(
                f"{e.id!r}: the Claude twin of {original.id!r} must be called {twin_id(original.id)!r}"
            )
        mine = (e.engine, e.rules_id, e.object_name, e.registry_id)
        theirs = (original.engine, original.rules_id, original.object_name, original.registry_id)
        if mine != theirs:
            raise BadRosterRow(
                f"{e.id!r}: a Claude twin runs its original's method exactly; its (engine, rules_id, "
                f"object_name, registry_id) is {mine}, {original.id!r}'s is {theirs}"
            )
```
**Impact:** `SEED_ROWS` has no twin: `ROSTER` builds as before. `twin_id` is defined in Step 2(b),
above `SEED_ROWS`, so the import-time `from_rows(SEED_ROWS)` never reaches an undefined name.

### Step 5: Roster -- twin planning and the spec marker
**File:** `engine/src/seer_engine/paper/roster.py` -- new block after `news_veto` (line ~1761);
`spec` at line 1793-1842; module docstring (line 1-107).
**Change:** (a) add the eligibility rule and planner; (b) replace `spec`; (c) add a docstring
paragraph to the module docstring, after the `status` paragraph (line ~98).
**Code:**

(a)
```python
# --------------------------------------------------------------------------- Claude twins (C2)


def twin_eligible(row: Row) -> bool:
    """True when ``row`` is an original that must have a Claude twin (contract C2).

    Active, not itself a twin, not the benchmark, a bracket or book engine, and an object the
    resolver knows that is not C's news check (C is already an LLM critic). An ``object_name`` the
    resolver does not know is not eligible here: ``from_rows`` refuses that row by name on the
    night, which is the right place for that error.
    """
    if row.status != "active" or row.twin_of is not None or row.is_benchmark:
        return False
    if row.engine not in ("bracket", "book"):
        return False
    binding = RESOLVER.get(row.object_name) if isinstance(row.object_name, str) else None
    if binding is None or binding.obj is None:
        return False
    return not isinstance(binding.obj, NewsVeto)


def twin_row(original: Row) -> RosterRow:
    """The ``strategies`` row of ``original``'s Claude twin (C2): its method, a twin's display and
    gate fields, active, no paper clock yet."""
    return RosterRow(
        id=twin_id(original.id),
        name=twin_name(original.name),
        sub=original.sub,
        icon=original.icon,
        is_champion=False,
        is_benchmark=False,
        sort=original.sort,
        engine=original.engine,
        rules_id=original.rules_id,
        object_name=original.object_name,
        registry_id=original.registry_id,
        gate_note=TWIN_GATE_NOTE,
        gate_applicable=False,
        status="active",
        paper_end=None,
        twin_of=original.id,
    )


@dataclass(frozen=True, slots=True)
class TwinPlan:
    """What the roster needs so every eligible original has exactly one active twin and no twin
    outlives its original: the twin rows to insert, and the active twin ids to retire."""

    create: tuple[RosterRow, ...] = ()
    retire: tuple[str, ...] = ()

    def empty(self) -> bool:
        return not self.create and not self.retire


def plan_twins(rows: Iterable[Row]) -> TwinPlan:
    """The twins to create and to retire for ``rows`` (every roster row; pure).

    - every ACTIVE twin whose original is missing or no longer eligible (retired, or itself a
      twin) is retired;
    - every eligible original with no active twin gets ``twin_row(original)``, in ``(sort, id)``
      order.

    RosterError when an eligible original has no active twin but its twin id is already taken
    (a twin retired by hand while its original trades on): a twin id is never reused, because its
    history belongs to the clock that wrote it. The message says the two ways out.
    """
    by_id = {r.id: r for r in rows}
    twinned: set[str] = set()
    retire: list[str] = []
    for r in by_id.values():
        if r.twin_of is None or r.status != "active":
            continue
        original = by_id.get(r.twin_of)
        if original is None or not twin_eligible(original):
            retire.append(r.id)
            continue
        twinned.add(original.id)
    create: list[RosterRow] = []
    for r in sorted(by_id.values(), key=lambda x: (x.sort, x.id)):
        if not twin_eligible(r) or r.id in twinned:
            continue
        tid = twin_id(r.id)
        taken = by_id.get(tid)
        if taken is not None:
            raise RosterError(
                f"{r.id!r} is active and has no active Claude twin, but {tid!r} already exists "
                f"(status {taken.status!r}, twin_of {taken.twin_of!r}). A twin id is never reused: "
                f"re-activate it (status 'active', paper_end NULL) and it catches up on the next "
                f"night, or retire {r.id!r} too"
            )
        create.append(twin_row(r))
    return TwinPlan(create=tuple(create), retire=tuple(sorted(retire)))
```

(b)
```python
def spec(e: RosterEntry) -> dict[str, Any]:
    """The frozen spec of ``e`` (contract C2 ``params.spec``): JSON-ready, strings and nulls only.

    Three keys are conditional, and all three are conditional for the same reason the levers in
    ``sim.rules.LEVERS_SINCE_PINS`` are: a fact added after an entry's digest was pinned must not
    move that digest, or ``store.check_digest`` refuses the entry's next paper night.

    - ``funding`` (017) is present for every entry except the thirteen in :data:`PRE_FUNDING_IDS`,
      which were digested before the owner's contribution plan was modelled. Stating the exemption
      rather than the inclusion means a future promoted entry carries its funding plan by default
      and cannot be born without it.
    - a ``benchmark`` entry states what its fills cost: ``cost_rate`` while it is on the old flat
      rate, ``cost_model`` once it is on Gotrade's measured schedule
      (:data:`BENCHMARK_COST_MODEL`). The retired ``SPY`` keeps ``cost_rate``, so its spec text is
      unchanged to the byte.
    - ``twin`` (Seer Adversarial) is present on a Claude twin only: ``{"of": <original id>,
      "filter": strategies.twin.FILTER_VERSION}``. Everything else in a twin's spec is its
      original's (the object id is the wrapped object's), so ``spec(twin)`` is ``spec(original)``
      with the twin's ``id`` and this key added -- and changing what a twin does with a verdict
      moves its digest.
    """
    if e.engine == "benchmark":
        params: dict[str, str] = {
            "symbol": BENCHMARK_SYMBOL,
            "entry": "open",
            "shares": "whole",
            "dividends": "reinvest",
        }
        model = benchmark_cost_model(e.id)
        if model == "flat":
            params["cost_rate"] = str(COST_RATE)
        else:
            params["cost_model"] = model
        object_id = None
    else:
        params = dict(e.params.as_dict())
        object_id = e.obj.id
    registry_digest = None
    if e.registry_id is not None:
        registry_digest = candidate_digest(next(c for c in REGISTRY if c.id == e.registry_id))
    out: dict[str, Any] = {
        "id": e.id,
        "engine": e.engine,
        "object": e.object_name,
        "object_id": object_id,
        "registry_id": e.registry_id,
        "registry_digest": registry_digest,
        "rules_id": e.rules_id,
        "rules": None if e.rules is None else rules_dict(e.rules),
        "params": params,
        "initial_idr": str(PAPER_INITIAL_IDR),
    }
    if e.id not in PRE_FUNDING_IDS:
        out["funding"] = dict(OWNER_FUNDING)
    if e.twin_of is not None:
        out["twin"] = {"of": e.twin_of, "filter": TWIN_FILTER_VERSION}
    return out
```

(c) Module docstring paragraph (insert after the paragraph that starts ``status`` is lifecycle):
```text
**Claude twins (Seer Adversarial, contract C2).** Every active original that is not the
benchmark and not C has one active twin ``<ID>-CX`` (``twin_of = <ID>``): the same method,
wrapped by ``strategies.twin`` so it drops what Claude objected to before the session opened.
Twins are DERIVED rows: none is in :data:`SEED_ROWS` and no migration writes one.
:func:`plan_twins` says which twin rows the roster lacks and which twins outlived their original;
``paper.store.ensure_twins`` applies that inside the paper night's transaction and inside
``promote``'s, so a twin appears and retires with its original and no manual step. This module
stays pure: it plans, the store writes.
```
**Impact:** pinned digests do not move (the `twin` key exists only when `twin_of` is set). The
`news_veto` "exactly one active NewsVeto" rule is untouched: twins are never `NewsVeto`.

### Step 6: Store -- read `twin_of`, write twins, read verdicts
**File:** `engine/src/seer_engine/paper/store.py` -- imports (line 54-63), `StrategyRow`
(147-178), `_STRATEGY_SQL` (181-185), `_strategy` (188-228), new block after `set_paper_end`
(after line 355), new function at the end of the file (after `allowed_between`, line 1674);
module docstring bullet list (line 6-31).
**Change:**
(a) imports: add
```python
from seer_engine.paper import roster
from seer_engine.strategies.twin import objected_map
```
(b) `StrategyRow`: add the field after `gate_applicable: bool = True`, and a sentence to its
docstring ("``twin_of`` (migration 027) is the original's id on a Claude twin, else None."):
```python
    gate_applicable: bool = True
    twin_of: str | None = None
```
(c) replace `_STRATEGY_SQL` and `_strategy`:
```python
_STRATEGY_SQL = (
    "SELECT id, name, sub, icon, engine, rules_id, is_champion, is_benchmark, sort, paper_start, "
    "params, status, paper_end, promoted_from, object_name, registry_id, gate_note, gate_applicable, "
    "twin_of FROM strategies"
)


def _strategy(row: tuple) -> StrategyRow:
    (
        sid,
        name,
        sub,
        icon,
        engine,
        rules_id,
        champion,
        benchmark,
        sort,
        paper_start,
        params,
        status,
        paper_end,
        promoted_from,
        object_name,
        registry_id,
        gate_note,
        gate_applicable,
        twin_of,
    ) = row
    return StrategyRow(
        id=sid,
        name=name,
        sub=sub,
        icon=icon,
        engine=engine,
        rules_id=rules_id,
        is_champion=bool(champion),
        is_benchmark=bool(benchmark),
        sort=int(sort),
        paper_start=paper_start,
        params=params if isinstance(params, dict) else {},
        status=status,
        paper_end=paper_end,
        promoted_from=promoted_from,
        object_name=object_name,
        registry_id=registry_id,
        gate_note=gate_note,
        gate_applicable=bool(gate_applicable),
        twin_of=twin_of,
    )
```
Phase 1 leaves `StrategyRow` and `_STRATEGY_SQL` unchanged (its contract: twin_of is read only through `store.is_twin`, which Step 9 deletes), so (b)/(c) apply as written.

(d) after `set_paper_end`:
```python
# --------------------------------------------------------------------------- Claude twins (C2)


@dataclass(frozen=True)
class TwinChanges:
    """What :func:`ensure_twins` wrote: the twin ids it inserted, and ``(twin id, paper_end)`` for
    every twin it retired (``paper_end`` None when the twin never started)."""

    created: tuple[str, ...] = ()
    retired: tuple[tuple[str, date | None], ...] = ()

    @property
    def changed(self) -> bool:
        return bool(self.created or self.retired)


_TWIN_INSERT_SQL = (
    "INSERT INTO strategies (id, name, sub, icon, is_champion, is_benchmark, sort, engine, rules_id, "
    "object_name, registry_id, gate_note, gate_applicable, status, promoted_from, twin_of, params) "
    "VALUES (%s, %s, %s, %s, false, false, %s, %s, %s, %s, %s, %s, false, 'active', NULL, %s, '{}'::jsonb)"
)


def ensure_twins(conn: psycopg.Connection) -> TwinChanges:
    """Give every eligible active original its Claude twin, and retire every twin that outlived its
    original (contract C2, through ``roster.plan_twins``).

    Retirements first, through :func:`retire` (``paper_end`` = the twin's own last stepped session,
    history kept), then the inserts. Each inserted row is read back and built with
    ``roster.from_row`` inside the same transaction, as ``promote`` does for its own row, so a twin
    the night could not build is never committed. Raises ``roster.RosterError`` when a twin id is
    taken (see ``plan_twins``). The caller's transaction decides: ``paper`` calls this first thing
    in the night's transaction, ``promote`` in the promotion's.
    """
    plan = roster.plan_twins(read_roster_rows(conn))
    retired = tuple((tid, retire(conn, tid)) for tid in plan.retire)
    created: list[str] = []
    for row in plan.create:
        conn.execute(
            _TWIN_INSERT_SQL,
            (
                row.id,
                row.name,
                row.sub,
                row.icon,
                row.sort,
                row.engine,
                row.rules_id,
                row.object_name,
                row.registry_id,
                row.gate_note,
                row.twin_of,
            ),
        )
        written = read_strategy(conn, row.id)
        if written is None:
            raise StoreError(f"twin {row.id!r} was inserted but cannot be read back")
        roster.from_row(written)
        created.append(row.id)
    return TwinChanges(created=tuple(created), retired=retired)
```
(e) at the end of the file:
```python
# --------------------------------------------------------------------------- Claude's verdicts (Seer Adversarial)


def objected_between(
    conn: psycopg.Connection, strategy_id: str, start: date, end: date
) -> dict[date, frozenset[str]]:
    """``{session: symbols Claude objected to in time}`` for the ORIGINAL ``strategy_id``'s
    sessions ``start..end`` inclusive (contract C3), via ``strategies.twin.objected_map``.

    Every ``adversary_verdicts`` row of those sessions is read and the cutoff is applied in
    Python, per session, at ``dates.session_open_utc``: a row decided at or after its session's
    open never counts, whatever ``superseded_by`` says. A session with no standing objection is
    absent; callers look up with ``.get(session, frozenset())``. Empty when ``start > end``.
    """
    _date("start", start)
    _date("end", end)
    rows = conn.execute(
        "SELECT session_date, symbol, verdict, decided_at, id FROM adversary_verdicts "
        "WHERE strategy_id = %s AND session_date BETWEEN %s AND %s "
        "ORDER BY session_date, symbol, decided_at, id",
        (strategy_id, start, end),
    ).fetchall()
    return objected_map(rows)
```
(f) module docstring: add a bullet after the "Strategy C's news check" bullet:
```text
- Claude twins (Seer Adversarial, migration 027): ``ensure_twins`` writes the derived twin rows
  of ``strategies`` (and retires a twin with its original); ``objected_between`` reads
  ``adversary_verdicts`` -- written only by mcp-notes' reviewer -- as each twin's decisions read
  them. Nothing here writes a verdict.
```
**Impact:** `read_strategies` / `read_roster_rows` / `read_strategy` now select `twin_of`
(column exists after 027). `store` imports `roster` (pure); there is no import cycle (`roster`
imports nothing from `store`).

### Step 7: Paper -- lagged run dates, twins in the plan, ensure twins in the night
**File:** `engine/src/seer_engine/commands/paper.py` -- module docstring (line 1-61), `execute`
(178-244), `plan_night` (247-311), `_night` (402-421), `_trade` (424-468); imports (line 63-98).
**Change:** replace `execute`, `plan_night`, `_night`, `_trade` whole; add `twin_dates`,
`run_dates_for`, `_twin_may_start`, `_read_night`; add an import; add a docstring paragraph.
**Code:**

Import (add after `from seer_engine.strategies.base import History, Strategy`):
```python
from seer_engine.strategies.allocator import Allocator
```

Module docstring paragraph (append before the "Trade logic lives in ..." paragraph):
```text
Claude twins (Seer Adversarial, plan seer-adversarial phase 2, Decision D1): a roster row with
``twin_of`` set runs its original's method minus the symbols Claude objected to before the session
opened (``strategies.twin``, ``store.objected_between``). It is planned, started and stepped exactly
like any entry, but on ``twin_dates(rd)`` -- as if tonight's data date were
``prev_session(rd.data_date)``. So it decides session S on the night after S closed, from
``view(prev_session(S))`` with every verdict decided before S's open, and settles S the next night.
Fills come from stored bars, so that equals deciding on time; and because the cutoff is already in
the past, ``paper_check`` reads the same verdicts on any later night. Nothing in the step loops,
``store.write_pending`` or ``paper.replay`` knows about twins: a twin's record is an ordinary record
that ends one session earlier. The night's transaction begins with ``store.ensure_twins``: every
eligible active original gets its twin and a twin whose original retired is retired with it
(contract C2), with no manual step (owner decision 5).
```

New helpers (place directly above `plan_night`):
```python
def twin_dates(rd: dates.RunDates) -> dates.RunDates:
    """The run dates a Claude twin is stepped on tonight (Decision D1): one session behind.

    ``data_date = prev_session(rd.data_date)`` and ``session_date = rd.data_date``: tonight the
    twin settles through the session before the one that just closed and decides the one that just
    closed, whose open -- the verdicts' cutoff -- has passed.
    """
    return dates.RunDates(data_date=dates.prev_session(rd.data_date), session_date=rd.data_date)


def run_dates_for(e: RosterEntry, rd: dates.RunDates) -> dates.RunDates:
    """``rd`` for an original, :func:`twin_dates` of it for a Claude twin."""
    return rd if e.twin_of is None else twin_dates(rd)


def _twin_may_start(original: StrategyRow | None, erd: dates.RunDates) -> bool:
    """True when a twin with no paper state starts tonight (Decision D5): its original is active
    and started, and the session the twin would decide first is on or after the original's
    ``paper_start``. An original that starts tonight has no ``paper_start`` yet, so its twin starts
    the next night, on the same ``paper_start``."""
    return (
        original is not None
        and original.status == "active"
        and original.paper_start is not None
        and erd.session_date >= original.paper_start
    )


def _read_night(
    conn: psycopg.Connection, rd: dates.RunDates, *, ensure_twins: bool
) -> tuple[NightPlan, roster.TwinPlan]:
    """Read the roster and its paper state on ``conn`` and plan tonight; also what the twins need
    (an empty ``TwinPlan`` when ``ensure_twins`` is off). Writes nothing."""
    strategy_rows = store.read_roster_rows(conn)
    # The roster is data (phase 1). An entry whose object cannot be resolved raises here,
    # by name, and the whole night stops (plan invariant 9) -- that is NOT the deliberate
    # skip a retired entry gets below, and the two never share a code path or a log line.
    entries = roster.from_rows(strategy_rows)
    rows = {row.id: row for row in strategy_rows}
    states: dict[str, PaperState] = {}
    for e in entries:
        state = store.read_paper_state(conn, e.id)
        if state is not None:
            states[e.id] = state
    twins = roster.plan_twins(strategy_rows) if ensure_twins else roster.TwinPlan()
    return plan_night(entries, rows, states, rd), twins
```

`execute` (replace whole):
```python
def execute(
    conn: psycopg.Connection, *, now: datetime, dry_run: bool = False, ensure_twins: bool = True
) -> int:
    """Run one paper night against ``conn``. Returns the exit code (0 ok or no-op, 1 failed).

    ``ensure_twins`` (default True; the CLI never changes it) makes the night's transaction begin
    with ``store.ensure_twins`` (contract C2), and a night with nothing to step still runs when a
    twin must be created or retired. False is for test worlds that pin their own set of entries:
    they test the night, not the roster. Twins already in the database are stepped either way.
    """
    demo.purge_demo_if_needed(conn, dry_run)

    rd = dates.run_dates(now)
    log.info("now %s -> data_date %s, session_date %s", now.isoformat(), rd.data_date, rd.session_date)

    try:
        bars_run = runs.real_run(conn, rd.session_date)
    finally:
        conn.rollback()
    if bars_run is None or bars_run.status != "success":
        found = "missing" if bars_run is None else bars_run.status
        log.error(
            "the bars run for session %s is %s; no paper step after a failed or missing bars run",
            rd.session_date,
            found,
        )
        return 1
    run_id = bars_run.id

    try:
        try:
            plan, twins = _read_night(conn, rd, ensure_twins=ensure_twins)
        finally:
            conn.rollback()
        for r in plan.retired:
            log.info(
                "%s: retired; no orders, no equity snapshot, no paper_state step. paper_end %s%s",
                r.entry.id,
                "-" if r.paper_end is None else r.paper_end,
                " (stamped tonight)" if r.stamp else "",
            )
        if plan.empty() and twins.empty():
            log.info(
                "every active roster strategy is stepped through %s; nothing to do", rd.data_date
            )
            return 0

        with db.transaction(conn, dry_run):
            runs.start_paper(conn, run_id)
        with db.transaction(conn, dry_run):
            _night(conn, rd, plan, run_id, ensure_twins=ensure_twins)
    except Exception as e:  # noqa: BLE001 - every failure must become a failed paper step
        message = _error_text(e)
        conn.rollback()
        log.error("paper failed for session %s: %s", rd.session_date, message)
        if dry_run:
            log.info("dry-run: would mark the paper step failed")
            return 1
        with db.transaction(conn, False):
            runs.fail_paper(conn, run_id, message)
        return 1
    if dry_run:
        log.info("dry-run: rolled back; nothing written")
    return 0
```

`plan_night` (replace whole):
```python
def plan_night(
    entries: Sequence[RosterEntry],
    rows: Mapping[str, StrategyRow],
    states: Mapping[str, PaperState],
    rd: dates.RunDates,
) -> NightPlan:
    """Which entries start tonight, which step, and which are retired, after the frozen-spec checks.

    A ``status='retired'`` entry is a **deliberate skip**: it is collected into ``NightPlan.retired``
    and takes no decision, no snapshot and no ``paper_state`` step. It is not an error, and it is
    not the same thing as an entry whose object cannot be resolved -- that one never reaches this
    function, because ``roster.from_rows`` raises before the plan exists and the night stops
    (plan invariant 9).

    A Claude twin (``e.twin_of``, Decision D1) is planned on ``twin_dates(rd)``: stepped through
    ``prev_session(rd.data_date)`` and deciding ``rd.data_date``. A twin with no paper state starts
    only when ``_twin_may_start`` (Decision D5); until then it waits, which is neither an error nor
    a start.

    Raises ``store.SpecMismatch`` when an **active** entry's set ``paper_start`` holds a spec
    digest other than the code's (handover D4: a changed strategy needs a new id). Raises
    PaperError when an entry has no ``strategies`` row, carries a status this night does not
    understand, has ``paper_start`` but no paper state (its clock must be reset first), has paper
    state but no ``paper_start``, or when the stored pending session is not the session after the
    last one stepped.
    """
    start: list[RosterEntry] = []
    step: list[tuple[RosterEntry, PaperState]] = []
    retired: list[Retired] = []
    for e in entries:
        row = rows.get(e.id)
        if row is None:
            raise PaperError(f"strategies row {e.id!r} is missing; run `migrate` (003) first")
        if row.status not in ("active", "retired"):
            raise PaperError(
                f"strategy {e.id!r} has status {row.status!r}; the paper night understands only "
                f"'active' and 'retired'"
            )
        state = states.get(e.id)
        if row.status == "retired":
            last_traded = None if state is None else state.last_session
            retired.append(
                Retired(
                    entry=e,
                    paper_end=row.paper_end if row.paper_end is not None else last_traded,
                    stamp=row.paper_end is None and last_traded is not None,
                )
            )
            continue
        store.check_digest(row, roster.strategy_params(e)["digest"])
        erd = run_dates_for(e, rd)
        if state is None:
            if row.paper_start is not None:
                raise PaperError(
                    f"strategy {e.id!r} has paper_start {row.paper_start} but no paper_state; reset its "
                    f"paper clock (paper runbook) before it can start"
                )
            if e.twin_of is not None and not _twin_may_start(rows.get(e.twin_of), erd):
                continue
            start.append(e)
            continue
        if row.paper_start is None:
            raise PaperError(f"strategy {e.id!r} has paper state but no paper_start")
        if state.last_session >= erd.data_date:
            continue
        expected = dates.next_session(state.last_session)
        if state.pending_session != expected:
            raise PaperError(
                f"strategy {e.id!r}: pending session {state.pending_session} is not the session "
                f"after its last one ({state.last_session} -> {expected})"
            )
        step.append((e, state))
    return NightPlan(start=tuple(start), step=tuple(step), retired=tuple(retired))
```

`_night` (replace whole):
```python
def _night(
    conn: psycopg.Connection, rd: dates.RunDates, plan: NightPlan, run_id: int, *, ensure_twins: bool = True
) -> None:
    """The single paper transaction's body (the caller's db.transaction commits or rolls back).

    With ``ensure_twins`` it begins with ``store.ensure_twins`` (contract C2); when that created or
    retired a twin, tonight is planned again from the rows as they now stand, in this transaction,
    so a twin retired tonight takes no step and a twin created tonight starts if it may.

    Retirements are settled first and cost nothing: a retired strategy keeps every history row it
    ever wrote, and the only column tonight may write for it is ``paper_end`` (invariant 4). The
    market window is loaded only when something actually trades, so an all-retired roster is a
    cheap night, not a crash.
    """
    if ensure_twins:
        changes = store.ensure_twins(conn)
        for tid in changes.created:
            log.info("%s: Claude twin created; it starts once it can decide a session of its original's", tid)
        for tid, end in changes.retired:
            log.info("%s: Claude twin retired with its original; paper_end %s", tid, "-" if end is None else end)
        if changes.changed:
            plan, _ = _read_night(conn, rd, ensure_twins=False)
    for r in plan.retired:
        if not r.stamp or r.paper_end is None:
            continue
        store.set_paper_end(conn, r.entry.id, r.paper_end)
        log.info(
            "%s: paper_end %s, the last session it traded; its history is kept",
            r.entry.id,
            r.paper_end,
        )
    if plan.start or plan.step:
        _trade(conn, rd, plan)
    runs.finish_paper(conn, run_id)
```

`_trade` (replace whole):
```python
def _trade(conn: psycopg.Connection, rd: dates.RunDates, plan: NightPlan) -> None:
    """Start and step every active entry on tonight's bars window. Never called with nothing to do.

    Each entry runs on its own run dates (``run_dates_for``): ``rd`` for an original,
    ``twin_dates(rd)`` for a Claude twin, which therefore starts, settles and decides one session
    behind (Decision D1). The window and tonight's splits/dividends cover both.
    """
    lasts = [state.last_session for _, state in plan.step]
    lasts += [run_dates_for(e, rd).data_date for e in plan.start]
    earliest = min(lasts)
    since = store.market_window_since(earliest)  # earliest - store.MARKET_WINDOW_DAYS (1200) days
    _check_window(since, earliest, list(plan.start) + [e for e, _ in plan.step])

    tonight = _load_tonight(conn, since, earliest, rd.data_date)
    starts = {row.id: row.paper_start for row in store.read_strategies(conn)}
    # A stock added to the not-offered list since a pending decision was taken is re-picked
    # before that decision settles (014, paper.unavailable).
    repick(conn, [e for e, _ in plan.step], starts, tonight)

    for e in plan.start:
        _start(conn, e, run_dates_for(e, rd), tonight)
    starts = {row.id: row.paper_start for row in store.read_strategies(conn)}
    for e, state in plan.step:
        through = run_dates_for(e, rd).data_date
        sessions = dates.sessions(dates.next_session(state.last_session), through)
        # The owner's deposits, recorded once per entry per night before anything steps: every
        # scheduled date (the 25th of each month) whose landing session has arrived by the last
        # session about to be stepped. store.accrue_contributions freezes each at the USD/IDR of
        # its own landing session and leaves an already-recorded one alone, so a backfilled
        # fx_rates can never move a stepped book's history (phase 6, D6a). The three session loops
        # below credit what has landed. `tonight.market` rather than a per-session view: the
        # accrual runs before any loop, and usd_idr_on reads the latest fx row on or before the
        # date asked for, which is the same row either way for every date <= sessions[-1].
        if sessions:
            store.accrue_contributions(
                conn,
                e.id,
                OWNER_MONTHLY.dates_in(starts[e.id], sessions[-1]),
                OWNER_MONTHLY.amount_idr,
                through=sessions[-1],
                usd_idr_on=tonight.market.usd_idr_on,
            )
        if e.engine == "bracket":
            _step_bracket(conn, e, sessions, tonight)
        elif e.engine == "book":
            _step_book(conn, e, sessions, tonight, state, starts[e.id])
        elif e.engine == "benchmark":
            _step_benchmark(conn, e, sessions, tonight)
        else:
            raise PaperError(f"strategy {e.id!r} has unknown engine {e.engine!r}")
```
Phase 1 does not touch `execute`, `plan_night`, `_night` or `_trade` (its Files table lists only
`repick`, `_start`, `_step_bracket`, `_step_book` and new helpers), so these four are replaced whole
against the base as quoted.

**Impact:** `_start` is unchanged in signature: it receives the twin's run dates as `rd`, so its
`paper_start = rd.session_date`, day-0 at `rd.data_date` and USD/IDR on `rd.data_date` are the
twin's. Behaviour for originals is identical (their run dates are `rd`).

### Step 8: Paper -- the verdicts reach a twin's decisions
**File:** `engine/src/seer_engine/commands/paper.py` -- `_bracket_strategy` (621-631), new
`_book_allocator` right after it; the book branch of `repick` (544-573); the book branch of
`_start` (770-794); `_step_book` (839-919).
**Change:** `_bracket_strategy` handles twins; `_book_allocator` is its book twin; every
`decide_book(view, e.obj, ...)` call in `repick`, `_start` and `_step_book` takes the allocator from
`_book_allocator` instead of `e.obj`.
**Code:**
```python
def _bracket_strategy(conn: psycopg.Connection, e: RosterEntry, first: date, last: date) -> Strategy:
    """The strategy object ``decide_bracket`` gets for ``e`` when it decides sessions ``first`` ..
    ``last`` (inclusive).

    A Claude twin (``e.twin_of``): ``e.obj`` (a ``strategies.twin.TwinStrategy``) carrying its
    ORIGINAL's standing objections for those sessions (``store.objected_between``), so an objected
    pick is skipped and the next-ranked one takes its slot. C (a ``NewsVeto``): ``e.obj`` carrying
    the ``allow`` verdicts stored for those sessions (``store.allowed_between``), so a candidate
    with a ``veto`` or ``failed`` verdict, or with no verdict row, is not bought (handover D6, D8).
    Every other bracket entry: ``e.obj`` unchanged.
    """
    if e.twin_of is not None:
        return e.obj.with_objected(store.objected_between(conn, e.twin_of, first, last))
    if not isinstance(e.obj, NewsVeto):
        return e.obj
    return e.obj.with_allowed(store.allowed_between(conn, e.id, first, last))


def _book_allocator(conn: psycopg.Connection, e: RosterEntry, first: date, last: date) -> Allocator:
    """The allocator ``decide_book`` gets for ``e`` when it decides sessions ``first`` .. ``last``.

    ``e.obj`` for an original. For a Claude twin, ``e.obj`` (a ``strategies.twin.TwinBook``)
    carrying its ORIGINAL's standing objections for those sessions: on a rank or kickoff session
    the objected targets drop out and the rest are scaled up pro rata (contract C3).
    """
    if e.twin_of is None:
        return e.obj
    return e.obj.with_objected(store.objected_between(conn, e.twin_of, first, last))
```

`repick`, book branch: insert `alloc = _book_allocator(conn, e, p, p)` as the first line after
`book = store.load_book(conn, e.id, idle_symbol=rules.idle_symbol).book`, and use it in the three
`decide_book` calls. The branch below is phase 1's `repick` book branch (phase-1 plan Step 6
change (d)) with only `alloc` added and Step 9's `_reviewable(e)` applied; every other line is
phase 1's:
```python
        if e.engine == "book":
            if not state.pending_decision:
                continue
            paper_start = starts.get(e.id)
            if paper_start is None:
                raise PaperError(f"strategy {e.id!r} has a pending decision but no paper_start")
            rules = e.rules
            book = store.load_book(conn, e.id, idle_symbol=rules.idle_symbol).book
            alloc = _book_allocator(conn, e, p, p)
            kicked = None if state.kickoff_session == p else state.kickoff_session
            kickoff = needs_kickoff(rules, paper_start, p, kicked)
            if _resize_only(rules, p, kickoff):
                continue
            if rules.resize_cadence is None:
                targets, _ = decide_book(view, alloc, e.params, rules, d, book.held(), force=kickoff)
            else:
                last_rank, marks = _split_inputs(conn, e.id, rules, paper_start, kicked, p, book.positions)
                targets, _ = decide_book(
                    view, alloc, e.params, rules, d, book.held(), force=kickoff, last_rank=last_rank, marks=marks
                )
            old = store.read_book_targets(conn, e.id, p)
            if _book_key(targets) == _book_key(old):
                continue
            facts = None if targets is None else _evidence(e, view, d, (t.symbol for t in targets))
            store.save_book_decision(conn, e.id, p, targets, evidence=facts)
            if targets is not None and _reviewable(e):
                _save_book_candidates(conn, e, p, d, targets, facts)
            preview, preview_facts = targets, facts
            if preview is None:
                preview, _ = decide_book(view, alloc, e.params, rules, d, book.held(), force=True)
                preview_facts = None if preview is None else _evidence(e, view, d, (t.symbol for t in preview))
            store.save_book_preview(
                conn,
                e.id,
                d,
                preview,
                evidence=preview_facts,
                next_decision_session=candidates.next_rank_session(rules, d, kickoff=kickoff),
            )
            before, after = [t.symbol for t in old], [t.symbol for t in targets or ()]
```
(The bracket branch of `repick` already calls `_bracket_strategy(conn, e, p, p)`; its only change is
Step 9's `if _reviewable(e):` in place of phase 1's `if _reviewable(conn, e):`.)

`_start`, book branch: insert `alloc = _book_allocator(conn, e, paper_start, paper_start)` after
`kickoff = needs_kickoff(e.rules, paper_start, paper_start, None)` and replace `e.obj` by `alloc`
in its two `decide_book` calls. Phase 1's `reviewable = _reviewable(conn, e)` near the top of
`_start` becomes `reviewable = _reviewable(e)` (Step 9). The branch, as phase 1 leaves it plus these
edits:
```python
    elif e.engine == "book":
        kickoff = needs_kickoff(e.rules, paper_start, paper_start, None)
        alloc = _book_allocator(conn, e, paper_start, paper_start)
        if e.rules.resize_cadence is None:
            targets, _ = decide_book(view, alloc, e.params, e.rules, rd.data_date, frozenset(), force=kickoff)
        else:
            last_rank, marks = _split_inputs(conn, e.id, e.rules, paper_start, None, paper_start, ())
            targets, _ = decide_book(
                view,
                alloc,
                e.params,
                e.rules,
                rd.data_date,
                frozenset(),
                force=kickoff,
                last_rank=last_rank,
                marks=marks,
            )
        if targets is None or _resize_only(e.rules, paper_start, kickoff):
            facts = None
        else:
            facts = _evidence(e, view, rd.data_date, (t.symbol for t in targets))
        store.save_book_decision(conn, e.id, paper_start, targets, evidence=facts)
        if reviewable and targets is not None and not _resize_only(e.rules, paper_start, kickoff):
            _save_book_candidates(conn, e, paper_start, rd.data_date, targets, facts)
        if kickoff:
            store.write_kickoff(conn, e.id, paper_start)
        store.save_book_preview(
            conn,
            e.id,
            rd.data_date,
            targets,
            evidence=facts,
            next_decision_session=candidates.next_rank_session(e.rules, rd.data_date, kickoff=kickoff),
        )
```
(The bracket branch of `_start` already calls `_bracket_strategy(conn, e, paper_start, paper_start)`
and keeps phase 1's `if reviewable: _save_bracket_candidates(...)` unchanged.)

`_step_book`: insert after `kicked = state.kickoff_session`:
```python
    alloc = (
        _book_allocator(conn, e, dates.next_session(sessions[0]), dates.next_session(sessions[-1]))
        if sessions
        else e.obj
    )
```
and replace `e.obj` by `alloc` in its three `decide_book` calls (the `resize_cadence is None`
branch, the split-cadence branch, and the `force=True` preview). Phase 1's
`reviewable = _reviewable(conn, e)` (right after `kicked = state.kickoff_session`) becomes
`reviewable = _reviewable(e)`; its `_save_book_candidates(conn, e, nxt, s, targets, facts)` and
`save_book_preview(..., next_decision_session=candidates.next_rank_session(rules, s, kickoff=kickoff))`
stay exactly as phase 1 wrote them. Same for `_step_bracket`: only `reviewable = _reviewable(e)`.

**Impact:** for originals `_book_allocator` returns `e.obj`, so their nights are unchanged. A
twin's verdict read is one `SELECT` per twin per night.

### Step 9: Paper -- twins never write review candidates
**Files:** `engine/src/seer_engine/commands/paper.py` (`_reviewable` and its five call sites, module
docstring); `engine/src/seer_engine/paper/store.py` (`is_twin` deleted, docstring mention);
`engine/tests/test_paper_candidates.py` (`test_is_twin_reads_the_column` deleted).
**Change:** phase 1 routes every candidate write through `_reviewable(conn, e)`, which asks the DB
(`store.is_twin`) because no entry carried `twin_of` before this phase. Now `RosterEntry.twin_of` does
(Step 2/3), so the predicate reads the entry and the DB read goes (one mechanism, reconciled). Replace
phase 1's `_reviewable` whole with:
```python
def _reviewable(e: RosterEntry) -> bool:
    """True when the night writes ``e``'s decisions down for Claude's review (027).

    Bracket and book entries that are not benchmarks and not Claude twins (``e.twin_of``: a twin's
    decisions are its original's minus Claude's objections, so listing them would review the
    review). Read from the entry, never from a list of ids: Sera admits and retires methods, and the
    one rule that holds for all of them is the row.
    """
    if e.is_benchmark or e.engine not in ("bracket", "book"):
        return False
    return e.twin_of is None
```
Then change each call `_reviewable(conn, e)` to `_reviewable(e)`: `repick` (book branch
`if targets is not None and _reviewable(e):`, bracket branch `if _reviewable(e):`), `_start`
(`reviewable = _reviewable(e)`), `_step_bracket` and `_step_book` (`reviewable = _reviewable(e)`).
Verify with `grep -n "_reviewable(conn" engine/src/seer_engine/commands/paper.py` (no hits) and
`grep -rn "is_twin" engine/` (no hits).

In the module docstring paragraph phase 1 added ("Candidates (migration 027, ..."), replace
``not a Claude twin (``store.is_twin``)`` with ``not a Claude twin (``e.twin_of``)``.

In `paper/store.py`, delete `is_twin` (phase 1 put it after `read_strategy`) and drop
``and ``is_twin``, the one read of ...`` from the docstring phrase phase 1 added for the 027 section.
In `engine/tests/test_paper_candidates.py`, delete `test_is_twin_reads_the_column` (and any import it
alone used), and in the module docstring phase 1 wrote, change the `paper.store` bullet's last clause
``; ``is_twin`` reads ``strategies.twin_of``.`` to ``.`` so the bullet ends ``read_candidates`` gives it
back.`` (otherwise the `grep -rn "is_twin" engine/` check above has a hit).

`book_previews.next_decision_session` is NOT guarded: phase 1 writes it on every preview, a twin's
included (index Decision D16).
**Impact:** mcp-notes (phase 4) never sees a twin's decision as reviewable; no doubled review cost.
One DB read per entry per call site is gone. `test_paper_twins.py::test_twins_write_no_review_candidates`
(Step 15) proves it on real twins, and phase 1's `test_a_twin_gets_no_list` (hand-made `A-CX` of the
world's `A`) keeps passing: the row passes `_check_twins` (id `twin_id('A')`, same engine, rules_id,
object_name, registry_id), and with `A` starting that night `_twin_may_start` keeps `A-CX` waiting, so
it has no list.

### Step 10: paper_check replays a twin through the same verdict reader
**File:** `engine/src/seer_engine/commands/paper_check.py` -- import (line 38), docstring (line
12-14), `_expected` (254-280).
**Change:** import `_book_allocator`; book replay uses it; docstring sentence.
**Code:**
```python
from seer_engine.commands.paper import _book_allocator, _bracket_strategy
```
Docstring paragraph, after the C paragraph (line 14):
```text
A Claude twin (``twin_of``) is replayed from its ORIGINAL's verdicts (``adversary_verdicts``),
read in the same transaction through the same ``store.objected_between`` the night used, over the
twin's own ``[paper_start, last_session]`` and pending decision. The cutoff of every session it
decided is a market open already in the past, so the replay reads the verdict set the night read.
```
`_expected` (replace whole):
```python
def _expected(
    conn: psycopg.Connection, entry: RosterEntry, head: PaperHead, market: Market, dividends: DividendMap
) -> Records:
    if entry.engine == "bracket":
        # The replay decides paper_start .. next_session(last_session): C carries the verdicts
        # stored for exactly those sessions, a Claude twin its original's standing objections
        # (both read in this read-only transaction).
        strategy = _bracket_strategy(conn, entry, head.paper_start, dates.next_session(head.last_session))
        # The entry's OWN rule set, not a module constant: C replays at DESIGN_V0 and C-GT at the
        # Gotrade bracket preset, so a Gotrade entry is not reconstructed at the flat rate.
        return replay.expected_bracket(
            market, strategy, entry.params, head, rules=entry.rules, contributions=_deposits(conn, entry.id)
        )
    if entry.engine == "book":
        # A Claude twin's allocator carries its original's standing objections for every session
        # the replay decides; an original's is entry.obj unchanged.
        allocator = _book_allocator(conn, entry, head.paper_start, dates.next_session(head.last_session))
        return replay.expected_book(
            market, allocator, entry.params, entry.rules, head, dividends, contributions=_deposits(conn, entry.id)
        )
    if entry.engine == "benchmark":
        # The entry's own cost model, for the same reason the bracket branch above passes its
        # rules: a benchmark has no TradeRules, and SPY-GT pays Gotrade's measured schedule.
        return replay.expected_benchmark(
            market,
            head,
            dividends,
            cost_model=roster.benchmark_cost_model(entry.id),
            contributions=_deposits(conn, entry.id),
        )
    raise ValueError(f"{entry.id}: unknown engine {entry.engine!r}")
```
**Impact:** structural twin invariants are checked by `roster.from_rows` inside `check()` (a
malformed twin is a failed check run, as any unbuildable row is). The coverage invariant ("every
eligible active original has exactly one active twin") is enforced by `ensure_twins` at the start
of every night and asserted in tests, not in `paper_check`: test worlds that pin their own entries
run with twins off and must still pass `paper_check`.

### Step 11: promote creates the twin in the promotion's transaction
**File:** `engine/src/seer_engine/commands/promote.py:555-562` (the `with db.transaction(conn,
args.dry_run):` block in `_run`).
**Change:** call `paper_store.ensure_twins(conn)` after the insert and the retire, inside the same
transaction; print what it wrote.
**Code:**
```python
            retire_end: date | None = None
            with db.transaction(conn, args.dry_run):
                insert = _check_target(conn, p)
                if p.retire_id is not None:
                    retire_end = paper_store.retire(conn, p.retire_id)
                if insert:
                    _insert(conn, p)
                # Seer Adversarial (contract C2): the promoted entry's Claude twin is born in this
                # same transaction, and a retired entry's twin retires with it, so the board never
                # holds an original without its twin or a twin without its original.
                twins = paper_store.ensure_twins(conn)
                print(render_plan(p, retire_end=retire_end, lab_status=lab_status, lab_move=move))
                for tid in twins.created:
                    print(f"strategies INSERT  {tid}  (Claude twin: active, no paper_start)")
                for tid, end in twins.retired:
                    print(f"strategies RETIRE  {tid}  (Claude twin, paper_end {'-' if end is None else end})")
```
Add one sentence to the module docstring's list of what `promote` writes: "the promoted entry's
Claude twin (``paper.store.ensure_twins``), in the same transaction."
**Impact:** a `RosterError` from `plan_twins` (taken twin id) makes `run` exit 2 and the whole
promotion roll back -- `run` already catches `roster.RosterError`.

### Step 12: explain skips twins
**File:** `engine/src/seer_engine/commands/explain.py` -- docstring line 3, `_STRATEGIES_SQL`
(line ~71-77).
**Change:**
```python
_STRATEGIES_SQL = """
SELECT s.id, s.name, s.engine, ps.pending_session
FROM strategies s
JOIN paper_state ps ON ps.strategy_id = s.id
WHERE s.engine IN ('bracket', 'book') AND ps.pending_session IS NOT NULL AND s.twin_of IS NULL
ORDER BY s.sort, s.id
"""
```
Docstring line 3 becomes:
```text
For every roster strategy with a ``paper_state`` row whose ``pending_session`` is set -- a Claude
twin excepted: its picks are its original's, already explained, and its pending session has
already traded (it runs one session behind):
```
**Impact:** no LLM call is spent on a twin.

### Step 13: Tests -- turn twins off in the worlds that pin their own entries
**Files and lines:**
- `engine/tests/test_paper_command.py:159` -> `return paper.execute(conn, now=night_of(d), dry_run=dry_run, ensure_twins=False)`;
  `:390` and `:391` add `, ensure_twins=False` inside each `paper.execute(...)`.
  Add above `IDS` (line 57) the comment:
  `# Every night here runs with ensure_twins=False: this world pins its own entries, so the Claude twins (tests/test_paper_twins.py) are not part of it.`
- `engine/tests/test_paper_check.py:129` -> `assert paper.execute(conn, now=now, ensure_twins=False) == 0, f"paper failed on the night of {d}"`
- `engine/tests/test_paper_split_cadence.py:348` -> same edit as above.
- `engine/tests/test_paper_c.py:181` -> `return paper.execute(conn, now=night_of(d), dry_run=dry_run, ensure_twins=False)`
- `engine/tests/test_veto_command.py:550` and `:568` -> `assert paper.execute(world, now=NOW, ensure_twins=False) == 0`
- Phase 1's new tests (reconciled, they exist when this phase starts): the seven night tests phase 1
  appends to `test_paper_command.py` (`test_a_bracket_night_lists_its_own_ranking_before_any_veto`,
  `test_a_book_lists_its_rank_and_kickoff_targets_and_never_a_resize`,
  `test_every_preview_names_the_next_session_its_book_ranks`, `test_a_twin_gets_no_list`,
  `test_a_failing_list_fails_no_night_and_changes_no_decision`,
  `test_repick_re_takes_the_list_with_the_decision`, `test_a_gt_starts_steps_and_replays_beside_plain_a`)
  all run nights through `night()` -> `go()` (line 159), so the `go` edit above covers them; none calls
  `paper.execute` directly. `test_adversary_schema.py` and `test_paper_candidates.py` run no night.
  `test_paper_evidence.py:73` goes through `test_paper_check.night` (covered by the `:129` edit).
  Confirm with `grep -n "paper.execute(" engine/tests/*.py`: every hit outside `test_paper_twins.py`
  carries `ensure_twins=False`.
- `engine/tests/test_paper_candidates.py`: delete `test_is_twin_reads_the_column` and the docstring's `is_twin` clause (Step 9).
**Impact:** those suites test the night with the entries they choose, as before. The promote test
in `test_paper_split_cadence.py` keeps working: `promote` creates twins, `_only` retires them, and
the night (twins off) never tries to re-create them.

### Step 14: Tests -- the pure rules
**File:** `engine/tests/test_twin.py` (new)
**Code:**
```python
"""Claude twins, pure: the verdict cutoff, the two wrappers and the roster's twin rules.

Plan seer-adversarial phase 2; contracts C2 and C3. No database: every DB-backed claim is in
tests/test_paper_twins.py.
"""

from __future__ import annotations

import dataclasses
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest

from seer_engine import dates
from seer_engine.paper import roster
from seer_engine.paper.bracket import decide_bracket
from seer_engine.paper.roster import ROSTER, SEED_ROWS, active, from_row, from_rows, spec, spec_digest
from seer_engine.sim import Pick, new_portfolio
from seer_engine.sim.book import WEIGHT_QUANTUM, Target
from seer_engine.sim.rules import DESIGN_V0, MONTHLY_HOLD, MONTHLY_RANK_WEEKLY_RESIZE, is_resize_session
from seer_engine.strategies import twin
from seer_engine.strategies.allocator import Allocator, MarketAware
from seer_engine.strategies.base import Strategy
from seer_engine.strategies.c import NewsVeto
from seer_engine.strategies.f_fundamental import FUNDAMENTAL

UTC = timezone.utc
NOV4 = date(2026, 11, 4)
OPEN_NOV4 = datetime(2026, 11, 4, 14, 30, tzinfo=UTC)  # US winter: 09:30 New York = 14:30 UTC
JUL1 = date(2026, 7, 1)
OPEN_JUL1 = datetime(2026, 7, 1, 13, 30, tzinfo=UTC)  # US summer: 09:30 New York = 13:30 UTC


# ---- the cutoff (C3) ---------------------------------------------------------------------------


def test_the_open_is_the_cutoff_and_the_latest_review_before_it_stands():
    rows = [
        (NOV4, "AAA", "object", OPEN_NOV4 - timedelta(seconds=1), 1),  # a second before: counts
        (NOV4, "BBB", "object", OPEN_NOV4, 2),  # at the open: late, ignored
        (NOV4, "CCC", "object", OPEN_NOV4 - timedelta(hours=3), 3),
        (NOV4, "CCC", "agree", OPEN_NOV4 - timedelta(hours=1), 4),  # re-reviewed in time: kept
        (NOV4, "DDD", "agree", OPEN_NOV4 - timedelta(hours=3), 5),
        (NOV4, "DDD", "object", OPEN_NOV4 - timedelta(hours=1), 6),  # re-reviewed in time: dropped
        (NOV4, "EEE", "unsure", OPEN_NOV4 - timedelta(hours=1), 7),  # can't tell = keep
        (NOV4, "FFF", "object", OPEN_NOV4 - timedelta(hours=2), 8),
        (NOV4, "FFF", "agree", OPEN_NOV4 + timedelta(hours=1), 9),  # a late re-review changes nothing
    ]
    assert twin.objected_map(rows) == {NOV4: frozenset({"AAA", "DDD", "FFF"})}


def test_the_cutoff_follows_new_york_daylight_saving():
    rows = [
        (JUL1, "AAA", "object", OPEN_JUL1 - timedelta(minutes=1), 1),
        (JUL1, "BBB", "object", OPEN_JUL1, 2),
    ]
    assert twin.objected_map(rows) == {JUL1: frozenset({"AAA"})}


def test_a_tie_on_decided_at_goes_to_the_later_row_whatever_the_read_order():
    at = OPEN_NOV4 - timedelta(hours=1)
    rows = [(NOV4, "AAA", "object", at, 1), (NOV4, "AAA", "agree", at, 2)]
    assert twin.objected_map(rows) == {}
    assert twin.objected_map(list(reversed(rows))) == {}


def test_a_bad_verdict_row_is_refused_at_the_edge():
    with pytest.raises(ValueError, match="not one of"):
        twin.objected_map([(NOV4, "AAA", "veto", OPEN_NOV4 - timedelta(hours=1), 1)])
    with pytest.raises(ValueError, match="tz-aware"):
        twin.objected_map([(NOV4, "AAA", "object", datetime(2026, 11, 4, 12), 1)])


# ---- the bracket twin --------------------------------------------------------------------------

D = date(2026, 11, 3)  # data date; its picks are for NOV4


def pick(symbol: str) -> Pick:
    return Pick(
        symbol=symbol,
        last_price=Decimal("10.0000"),
        limit_price=Decimal("10.0000"),
        tp_price=Decimal("11.0000"),
        sl_price=Decimal("9.0000"),
    )


@dataclasses.dataclass(frozen=True)
class Fixed:
    """A bracket strategy that ranks the same five picks every night."""

    ranked: tuple[Pick, ...] = tuple(pick(s) for s in ("P1", "P2", "P3", "P4", "P5"))
    id: str = "FIXED"
    lookback: int = 1

    def picks(self, history, members, data_date, params):
        return list(self.ranked)

    def prepare(self, history):
        return None

    def picks_prepared(self, prepared, members, data_date, params):
        return list(self.ranked)


def test_a_bracket_twin_without_objections_is_its_original():
    t = twin.TwinStrategy(inner=Fixed())
    assert isinstance(t, Strategy) and (t.id, t.lookback) == ("FIXED", 1)
    assert t.picks({}, frozenset(), D, None) == Fixed().picks({}, frozenset(), D, None)


def test_an_objected_pick_is_skipped_and_the_next_ranked_takes_its_slot():
    inner = Fixed()
    t = twin.TwinStrategy(inner=inner).with_objected({NOV4: {"P2"}})
    assert [p.symbol for p in t.picks({}, frozenset(), D, None)] == ["P1", "P3", "P4", "P5"]
    assert [p.symbol for p in t.picks_prepared(None, frozenset(), D, None)] == ["P1", "P3", "P4", "P5"]
    # Keyed by the session being bought for: a night deciding another session is untouched.
    assert len(t.picks({}, frozenset(), NOV4, None)) == 5
    orig = decide_bracket(new_portfolio(Decimal("10000")), inner, None, {}, frozenset(), D, rules=DESIGN_V0)
    mine = decide_bracket(new_portfolio(Decimal("10000")), t, None, {}, frozenset(), D, rules=DESIGN_V0)
    assert DESIGN_V0.max_positions == 4
    assert [o.symbol for o in orig.placed] == ["P1", "P2", "P3", "P4"]
    assert [o.symbol for o in mine.placed] == ["P1", "P3", "P4", "P5"]


# ---- the book twin -----------------------------------------------------------------------------

RANK_DATA = date(2026, 10, 30)  # decides 2026-11-02, the first session of November: a rank session
RANK = date(2026, 11, 2)


def target(symbol: str, weight: str) -> Target:
    return Target(symbol=symbol, weight=Decimal(weight), last=Decimal("10.0000"))


BOOK = (target("AAA", "0.300000"), target("BBB", "0.300000"), target("CCC", "0.200000"))  # 0.8 invested


@dataclasses.dataclass(frozen=True)
class Weights:
    """A book allocator that wants the same targets every night."""

    wanted: tuple[Target, ...] = BOOK
    id: str = "WEIGHTS"

    def lookback(self, params):
        return 1

    def symbols(self, params):
        return ()

    def holds(self, params):
        return ()

    def uses_members(self, params):
        return True

    def targets(self, history, members, data_date, held, params):
        return self.wanted

    def prepare(self, history):
        return None

    def targets_prepared(self, prepared, members, data_date, held, params):
        return self.wanted


def test_a_book_objection_drops_the_name_and_spreads_its_weight_pro_rata():
    t = twin.twin_book(Weights(), MONTHLY_HOLD).with_objected({RANK: {"BBB"}})
    got = t.targets({}, frozenset(), RANK_DATA, frozenset(), None)
    # 0.3 and 0.2 of the 0.5 kept, scaled to the original's 0.8: 0.48 and 0.32.
    assert [(x.symbol, x.weight) for x in got] == [("AAA", Decimal("0.480000")), ("CCC", Decimal("0.320000"))]
    assert t.targets_prepared(None, frozenset(), RANK_DATA, frozenset(), None) == got


def test_pro_rata_rounds_down_so_the_twin_is_never_more_invested_than_the_original():
    thirds = (target("AAA", "0.333333"), target("BBB", "0.333333"), target("CCC", "0.333333"))
    got = twin.renormalised(thirds, {"CCC"})
    assert [x.weight for x in got] == [Decimal("0.499999"), Decimal("0.499999")]
    assert sum(x.weight for x in got) <= sum(x.weight for x in thirds)
    assert all(x.weight == x.weight.quantize(WEIGHT_QUANTUM) for x in got)


def test_every_target_objected_is_the_originals_empty_decision():
    t = twin.twin_book(Weights(), MONTHLY_HOLD).with_objected({RANK: {"AAA", "BBB", "CCC"}})
    assert t.targets({}, frozenset(), RANK_DATA, frozenset(), None) == ()


def test_a_book_twin_without_objections_for_the_session_is_its_original():
    t = twin.twin_book(Weights(), MONTHLY_HOLD).with_objected({NOV4: {"AAA"}})
    assert t.targets({}, frozenset(), RANK_DATA, frozenset(), None) == BOOK
    assert isinstance(t, Allocator) and t.id == "WEIGHTS"


def test_a_resize_only_session_ignores_objections():
    resize = date(2026, 11, 9)  # a Monday, not the month's first session
    assert is_resize_session(MONTHLY_RANK_WEEKLY_RESIZE, resize)
    t = twin.twin_book(Weights(), MONTHLY_RANK_WEEKLY_RESIZE).with_objected({resize: {"AAA", "BBB", "CCC"}})
    assert t.targets({}, frozenset(), dates.prev_session(resize), frozenset(), None) == BOOK


def test_a_book_twin_is_market_aware_exactly_when_its_original_is():
    assert isinstance(FUNDAMENTAL, MarketAware)
    assert isinstance(twin.twin_book(FUNDAMENTAL, MONTHLY_HOLD), MarketAware)
    assert not isinstance(twin.twin_book(Weights(), MONTHLY_HOLD), MarketAware)


def test_a_twin_never_wraps_a_twin():
    with pytest.raises(TypeError, match="never another twin"):
        twin.TwinStrategy(inner=twin.TwinStrategy(inner=Fixed()))
    with pytest.raises(TypeError, match="never another twin"):
        twin.twin_book(twin.twin_book(Weights(), MONTHLY_HOLD), MONTHLY_HOLD)


# ---- the roster's twin rules (C2) --------------------------------------------------------------


def seed(sid: str) -> roster.RosterRow:
    return next(r for r in SEED_ROWS if r.id == sid)


def test_twin_ids_and_names():
    assert roster.twin_id("RAW35-FR-GT") == "RAW35-FR-GT-CX"
    assert roster.twin_name("RAW35 · Momentum") == "RAW35+Claude · Momentum"
    assert roster.twin_name("X") == "X+Claude"


def test_every_eligible_active_original_gets_one_twin_and_c_and_the_benchmark_none():
    plan = roster.plan_twins(SEED_ROWS)
    expected = {
        roster.twin_id(e.id)
        for e in active(ROSTER)
        if e.engine != "benchmark" and not isinstance(e.obj, NewsVeto)
    }
    assert {r.id for r in plan.create} == expected == {"A-GT-CX", "RAW35-FR-GT-CX", "COSK-FR-GT-CX"}
    assert plan.retire == ()
    for r in plan.create:
        assert r == roster.twin_row(seed(r.twin_of))
        assert (r.gate_note, r.gate_applicable, r.is_champion, r.is_benchmark) == (
            roster.TWIN_GATE_NOTE, False, False, False,
        )
    # Applying the plan leaves nothing to do, and the result builds.
    rows = (*SEED_ROWS, *plan.create)
    assert roster.plan_twins(rows).empty()
    entries = {e.id: e for e in from_rows(rows)}
    assert isinstance(entries["A-GT-CX"].obj, twin.TwinStrategy)
    assert isinstance(entries["RAW35-FR-GT-CX"].obj, twin.TwinBook)


def test_a_twins_spec_is_its_originals_plus_the_twin_marker():
    original = from_row(seed("RAW35-FR-GT"))
    t = from_row(roster.twin_row(seed("RAW35-FR-GT")))
    assert spec(t) == {
        **spec(original),
        "id": "RAW35-FR-GT-CX",
        "twin": {"of": "RAW35-FR-GT", "filter": twin.FILTER_VERSION},
    }
    assert spec_digest(spec(t)) != spec_digest(spec(original))


def test_a_retired_original_retires_its_twin_and_gets_no_new_one():
    raw = dataclasses.replace(seed("RAW35-FR-GT"), status="retired")
    rows = [raw if r.id == raw.id else r for r in SEED_ROWS] + [roster.twin_row(seed("RAW35-FR-GT"))]
    plan = roster.plan_twins(rows)
    assert plan.retire == ("RAW35-FR-GT-CX",)
    assert "RAW35-FR-GT-CX" not in {r.id for r in plan.create}


def test_an_active_twin_of_a_twin_is_retired():
    cx = roster.twin_row(seed("RAW35-FR-GT"))
    cxcx = dataclasses.replace(roster.twin_row(cx), twin_of=cx.id)
    plan = roster.plan_twins([*SEED_ROWS, cx, cxcx])
    assert plan.retire == ("RAW35-FR-GT-CX-CX",)


def test_a_used_twin_id_is_never_reused():
    retired_twin = dataclasses.replace(roster.twin_row(seed("RAW35-FR-GT")), status="retired")
    with pytest.raises(roster.RosterError, match="already exists"):
        roster.plan_twins([*SEED_ROWS, retired_twin])


def test_the_benchmark_and_c_cannot_have_a_twin():
    spy = seed("SPY-GT")
    spy_twin = dataclasses.replace(spy, id="SPY-GT-CX", twin_of="SPY-GT", is_champion=False, is_benchmark=False)
    with pytest.raises(roster.BadRosterRow, match="benchmark"):
        from_row(spy_twin)
    c_twin = dataclasses.replace(seed("C-GT"), id="C-GT-CX", twin_of="C-GT")
    with pytest.raises(roster.BadRosterRow, match="LLM critic"):
        from_row(c_twin)


def test_a_twin_must_run_its_originals_method_under_its_own_name():
    wrong_method = dataclasses.replace(roster.twin_row(seed("RAW35-FR-GT")), object_name="COSKEW")
    with pytest.raises(roster.BadRosterRow, match="runs its original's method"):
        from_rows([*SEED_ROWS, wrong_method])
    wrong_name = dataclasses.replace(roster.twin_row(seed("RAW35-FR-GT")), id="RAW35-CLAUDE")
    with pytest.raises(roster.BadRosterRow, match="must be called"):
        from_rows([*SEED_ROWS, wrong_name])
    orphan = dataclasses.replace(roster.twin_row(seed("RAW35-FR-GT")), twin_of="NOPE")
    with pytest.raises(roster.BadRosterRow, match="not a roster row"):
        from_rows([*SEED_ROWS, orphan])
```
Notes for the implementer: the `seed("SPY-GT")` row's `rules_id`, `object_name` are the
benchmark's, so `from_row` fails at the benchmark check -- that is the claim. The exact
`SEED_ROWS` ids `A-GT`, `C-GT`, `SPY-GT`, `RAW35-FR-GT`, `COSK-FR-GT` are phase 1's roster; if phase 1
named A-GT differently, use its name.

### Step 15: Tests -- the night, on Postgres
**File:** `engine/tests/test_paper_twins.py` (new)
**Code:**
```python
"""Claude twins on the paper night (plan seer-adversarial phase 2; contracts C2, C3; Decision D1).

The world is test_paper_command's synthetic market (24 random-walk stocks and SPY, bars through
2026-10-09) with a small set of originals active. Every night here runs `paper.execute` with the
twins ON, the CLI's default, so the twins are created, started and stepped as in production: one
session behind their originals. Verdict rows are inserted the way mcp-notes' writer inserts them.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_DOWN
from functools import lru_cache

import pytest
from psycopg.types.json import Jsonb

import test_paper_command as tp
from seer_engine import bars, dates, db, fx
from seer_engine.commands import explain, paper, paper_check
from seer_engine.paper import roster
from seer_engine.paper.capital import PAPER_INITIAL_IDR
from seer_engine.sim import initial_cash_usd, new_portfolio
from seer_engine.sim.book import WEIGHT_QUANTUM
from seer_engine.sim.sizing import size_picks
from seer_engine.strategies.a import STRATEGY_A, STRATEGY_A_PARAMS
from seer_engine.strategies.base import history_from_bars

UTC = timezone.utc
A, A_CX = "A", "A-CX"
RAW, RAW_CX = "RAW-FR", "RAW-FR-CX"
N = tp.NIGHTS  # 2026-09-23 .. 2026-10-01
OCT1, OCT2 = tp.OCT1, tp.OCT2
AUG6, AUG7 = date(2026, 8, 6), date(2026, 8, 7)  # A ranks five candidates on AUG6 (test_veto_command)


# ---- the world ---------------------------------------------------------------------------------


def _world(pg, ids):
    with db.transaction(pg, False):
        pg.execute("UPDATE strategies SET status = 'retired'")
        pg.execute("UPDATE strategies SET status = 'active' WHERE id = ANY(%s)", (list(ids),))
        bars.upsert_bars(pg, tp.synthetic_bars())
        fx.upsert_fx(pg, [(d, tp.fx_rate(d)) for d in tp._sessions()])
        for s in tp.STOCKS:
            pg.execute(
                "INSERT INTO universe (symbol, index_id, start_date, end_date, source_symbol) "
                "VALUES (%s, 'SP500', '2020-01-02', NULL, %s)",
                (s, s),
            )
        pg.execute("INSERT INTO dividends (symbol, ex_date, amount) VALUES ('SPY', %s, %s)", (tp.DIV_DATE, tp.DIV_AMT))
    return pg


@pytest.fixture
def world(pg):
    """A bracket original, a book original and the benchmark."""
    return _world(pg, (A, RAW, "SPY"))


@pytest.fixture
def bracket_world(pg):
    return _world(pg, (A,))


@pytest.fixture
def book_world(pg):
    return _world(pg, (RAW,))


def night(conn, d: date, *, dry_run: bool = False) -> int:
    tp.bars_run(conn, d)
    return paper.execute(conn, now=tp.night_of(d), dry_run=dry_run)  # twins ON: the CLI's default


def nights(conn, ds) -> None:
    for d in ds:
        assert night(conn, d) == 0, f"paper failed on the night of {d}"


def verdict(conn, strategy_id: str, session: date, symbol: str, what: str, decided_at: datetime) -> int:
    """One adversary_verdicts row, shaped as mcp-notes' writer shapes it (migration 027)."""
    sources = [] if what == "unsure" else [{
        "url": "https://example.invalid/news",
        "title": "A test source",
        "publisher": "test",
        "published_at": None,
        "fetched_at": decided_at.isoformat(),
    }]
    with db.transaction(conn, False):
        (vid,) = conn.execute(
            "INSERT INTO adversary_verdicts (strategy_id, session_date, symbol, verdict, reason, sources, "
            "lens, model, prompt_version, host, started_at, decided_at) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
            (
                strategy_id, session, symbol, what, "A test verdict.", Jsonb(sources), "test@1",
                "test-model", "test-v1", "test-host", decided_at - timedelta(minutes=5), decided_at,
            ),
        ).fetchone()
    return vid


def supersede(conn, old: int, new: int) -> None:
    with db.transaction(conn, False):
        conn.execute("UPDATE adversary_verdicts SET superseded_by = %s WHERE id = %s", (new, old))


def state(conn, sid: str):
    return tp.q(conn, "SELECT last_session, pending_session FROM paper_state WHERE strategy_id = %s", (sid,))


def pending(conn, sid: str, session: date) -> list[str]:
    rows = tp.q(conn, "SELECT symbol FROM orders WHERE strategy_id = %s AND session_date = %s", (sid, session))
    return sorted(s for (s,) in rows)


def targets(conn, sid: str, session: date):
    return tp.q(
        conn, "SELECT symbol, weight FROM book_targets WHERE strategy_id = %s AND session_date = %s ORDER BY rank",
        (sid, session),
    )


def held(conn, sid: str) -> set[str]:
    return {s for (s,) in tp.q(conn, "SELECT symbol FROM book_positions WHERE strategy_id = %s", (sid,))}


def checked(conn):
    conn.rollback()
    return {r.strategy_id: r for r in paper_check.check(conn)}


DECISION = "session_date, symbol, shares, last_price, limit_price, tp_price, sl_price"
FILL = "session_date, seq, symbol, side, shares, price, cash_usd, cost_usd, reason"


def decisions(conn, sid: str, through: date):
    return tp.q(
        conn,
        f"SELECT {DECISION} FROM orders WHERE strategy_id = %s AND session_date <= %s ORDER BY session_date, symbol",
        (sid, through),
    )


def book_decisions(conn, sid: str, through: date):
    return tp.q(
        conn,
        "SELECT session_date, rank, symbol, weight FROM book_targets WHERE strategy_id = %s AND session_date <= %s "
        "ORDER BY session_date, rank",
        (sid, through),
    )


def fills(conn, sid: str, through: date):
    return tp.q(
        conn,
        f"SELECT {FILL} FROM book_fills WHERE strategy_id = %s AND session_date <= %s ORDER BY session_date, seq",
        (sid, through),
    )


# ---- creation and the lag ----------------------------------------------------------------------


def test_the_first_night_creates_a_twin_per_eligible_original_and_none_for_the_benchmark(world):
    assert night(world, N[0]) == 0
    rows = tp.q(
        world,
        "SELECT id, name, twin_of, status, paper_start, is_champion, is_benchmark, gate_applicable, gate_note, "
        "sort, engine, rules_id, object_name FROM strategies WHERE twin_of IS NOT NULL ORDER BY id",
    )
    originals = {
        r[0]: r
        for r in tp.q(
            world, "SELECT id, name, sort, engine, rules_id, object_name FROM strategies WHERE id = ANY(%s)", ([A, RAW],)
        )
    }
    assert [r[0] for r in rows] == [A_CX, RAW_CX]
    for r in rows:
        o = originals[r[2]]
        assert r[1] == roster.twin_name(o[1])
        assert r[3:9] == ("active", None, False, False, False, roster.TWIN_GATE_NOTE)
        assert r[9:] == o[2:]


def test_twins_start_one_night_later_and_stay_one_session_behind(world):
    nights(world, N[:2])
    assert tp.q(
        world, "SELECT id, paper_start FROM strategies WHERE id = ANY(%s) ORDER BY id", ([A, A_CX, RAW, RAW_CX],)
    ) == [(A, tp.PAPER_START), (A_CX, tp.PAPER_START), (RAW, tp.PAPER_START), (RAW_CX, tp.PAPER_START)]
    nights(world, N[2:])
    for orig, twin in ((A, A_CX), (RAW, RAW_CX)):
        assert state(world, orig) == [(N[-1], OCT2)]
        assert state(world, twin) == [(dates.prev_session(N[-1]), N[-1])]


def test_a_dry_run_night_creates_no_twin(world):
    assert night(world, N[0], dry_run=True) == 0
    assert tp.q(world, "SELECT count(*) FROM strategies WHERE twin_of IS NOT NULL") == [(0,)]


def test_twins_write_no_review_candidates(world):
    nights(world, N[:3])
    assert tp.q(
        world, "SELECT count(*) FROM strategy_candidates WHERE strategy_id = ANY(%s)", ([A_CX, RAW_CX],)
    ) == [(0,)]


# ---- no verdicts: the twin is its original -----------------------------------------------------


def test_a_twin_with_no_verdicts_trades_exactly_like_its_original(world):
    nights(world, N)
    for orig, twin in ((A, A_CX), (RAW, RAW_CX)):
        [(last, _)] = state(world, twin)
        assert tp.snaps(world, twin) == [s for s in tp.snaps(world, orig) if s[0] <= last]
        assert tp.deposits(world, twin) == tuple(d for d in tp.deposits(world, orig) if d[0] <= last)
    [(_, a_pending)] = state(world, A_CX)
    assert decisions(world, A, a_pending), "A must have decided something for this to compare"
    assert decisions(world, A_CX, a_pending) == decisions(world, A, a_pending)
    [(r_last, r_pending)] = state(world, RAW_CX)
    assert book_decisions(world, RAW_CX, r_pending) == book_decisions(world, RAW, r_pending)
    assert fills(world, RAW_CX, r_last) == fills(world, RAW, r_last)
    found = checked(world)
    assert (found[A_CX].status, found[RAW_CX].status) == ("ok", "ok")


def test_a_twin_catching_up_equals_night_by_night(world):
    nights(world, N)
    by_night = tp.content(world)
    tp.reset(world)
    with db.transaction(world, False):
        world.execute("TRUNCATE strategy_candidates")  # phase 1's table; the second pass writes it again
    nights(world, (N[0], N[1], N[-1]))  # the twins start on N[1] both times, then catch up five sessions
    assert tp.content(world) == by_night


# ---- objections (bracket) ----------------------------------------------------------------------


@lru_cache(maxsize=1)
def ranked_aug7():
    """A's ranked picks for AUG7, computed without the database (the full history cut at AUG6)."""
    by_symbol = defaultdict(list)
    for b in tp.synthetic_bars():
        by_symbol[b.symbol].append(b)
    history = {s: history_from_bars(s, bs).upto(AUG6) for s, bs in by_symbol.items()}
    return tuple(STRATEGY_A.picks(history, frozenset(tp.STOCKS), AUG6, STRATEGY_A_PARAMS))


def sized(picks) -> list[str]:
    """What A's first decision buys from ``picks`` (fresh book, A's own rules)."""
    cash0 = initial_cash_usd(PAPER_INITIAL_IDR, tp.fx_rate(AUG6))
    placed = size_picks(new_portfolio(cash0), list(picks), AUG7, rules=tp.ENTRIES[A].rules).placed
    return sorted(o.symbol for o in placed)


def _first_bought(w) -> str:
    """A starts on AUG6 and decides AUG7; the best-ranked pick it bought."""
    assert night(w, AUG6) == 0
    orig = pending(w, A, AUG7)
    assert orig and orig == sized(ranked_aug7()), "A's own AUG7 decision is its ranked picks, sized"
    return next(p.symbol for p in ranked_aug7() if p.symbol in orig)


def test_an_objection_drops_exactly_that_pick_and_the_next_ranked_takes_its_slot(bracket_world):
    w = bracket_world
    x = _first_bought(w)
    verdict(w, A, AUG7, x, "object", datetime(2026, 8, 7, 12, tzinfo=UTC))  # before the 13:30 UTC open
    assert night(w, AUG7) == 0  # the twin starts and decides AUG7 from AUG6's bars
    twin = pending(w, A_CX, AUG7)
    assert twin == sized(p for p in ranked_aug7() if p.symbol != x)
    assert x not in twin and x in pending(w, A, AUG7)
    assert checked(w)[A_CX].status == "ok"


def test_a_verdict_decided_at_the_open_is_ignored(bracket_world):
    w = bracket_world
    x = _first_bought(w)
    verdict(w, A, AUG7, x, "object", datetime(2026, 8, 7, 13, 30, tzinfo=UTC))  # the open itself: late
    assert night(w, AUG7) == 0
    assert pending(w, A_CX, AUG7) == pending(w, A, AUG7)
    assert checked(w)[A_CX].status == "ok"


@pytest.mark.parametrize(("first", "second", "dropped"), [("object", "agree", False), ("agree", "object", True)])
def test_a_re_review_before_the_open_is_the_one_that_counts(bracket_world, first, second, dropped):
    w = bracket_world
    x = _first_bought(w)
    old = verdict(w, A, AUG7, x, first, datetime(2026, 8, 7, 11, tzinfo=UTC))
    new = verdict(w, A, AUG7, x, second, datetime(2026, 8, 7, 12, tzinfo=UTC))
    supersede(w, old, new)
    assert night(w, AUG7) == 0
    expected = sized(p for p in ranked_aug7() if p.symbol != x) if dropped else pending(w, A, AUG7)
    assert pending(w, A_CX, AUG7) == expected
    assert checked(w)[A_CX].status == "ok"


# ---- objections (book) -------------------------------------------------------------------------


def test_a_book_objection_drops_the_name_renormalises_pro_rata_and_sells_it_with_fees(book_world):
    w = book_world
    nights(w, N[:-1])  # through 2026-09-30: RAW-FR has decided OCT1 (a rank session); its twin has not
    orig = targets(w, RAW, OCT1)
    both = sorted(held(w, RAW) & {s for s, _ in orig})
    assert both, "RAW-FR keeps at least one held name at its October rank"
    h = both[0]
    verdict(w, RAW, OCT1, h, "object", datetime(2026, 10, 1, 12, tzinfo=UTC))  # before the 13:30 UTC open
    nights(w, (OCT1,))  # the twin settles 09-30 and decides OCT1 with the objection
    total = sum(wt for _, wt in orig)
    kept = [(s, wt) for s, wt in orig if s != h]
    kept_total = sum(wt for _, wt in kept)
    twin = targets(w, RAW_CX, OCT1)
    assert twin == [(s, (wt * total / kept_total).quantize(WEIGHT_QUANTUM, rounding=ROUND_DOWN)) for s, wt in kept]
    assert total - len(kept) * WEIGHT_QUANTUM <= sum(wt for _, wt in twin) <= total
    nights(w, (OCT2,))  # the twin settles OCT1: the objected held name is sold, and the sale pays fees
    sold = tp.q(
        w, "SELECT side, cost_usd FROM book_fills WHERE strategy_id = %s AND session_date = %s AND symbol = %s",
        (RAW_CX, OCT1, h),
    )
    assert sold and all(side == "sell" and cost > 0 for side, cost in sold)
    assert h not in held(w, RAW_CX) and h in held(w, RAW)
    assert checked(w)[RAW_CX].status == "ok"


# ---- lifecycle ---------------------------------------------------------------------------------


def test_retiring_an_original_retires_its_twin_on_the_next_night(world):
    nights(world, N[:3])
    [(twin_last, twin_pending)] = state(world, A_CX)
    tp.retire_by_hand(world, A)
    assert night(world, N[3]) == 0
    assert tp.lifecycle(world, A_CX) == ("retired", twin_last)
    assert state(world, A_CX) == [(twin_last, twin_pending)]  # retired before tonight stepped anything
    assert tp.lifecycle(world, RAW_CX)[0] == "active"


def test_a_retired_twin_of_an_active_original_stops_the_night_by_name(world):
    assert night(world, N[0]) == 0
    with db.transaction(world, False):
        world.execute("UPDATE strategies SET status = 'retired' WHERE id = %s", (A_CX,))
    assert night(world, N[1]) == 1
    [(status, error, _)] = tp.paper_run(world, N[1])
    assert status == "failed" and A_CX in error and "already exists" in error


# ---- explain -----------------------------------------------------------------------------------


def test_explain_never_reads_a_twins_decisions(world):
    nights(world, N[:2])  # the twins have just started: RAW-FR-CX holds kickoff targets, unexplained
    assert tp.q(
        world, "SELECT count(*) FROM book_targets WHERE strategy_id = %s AND session_date = %s", (RAW_CX, tp.PAPER_START)
    )[0][0] > 0
    ids = {s.id for s, _ in explain.load_batches(world)}
    world.rollback()
    assert ids.isdisjoint({A_CX, RAW_CX})
```
Notes for the implementer:
- `test_twins_write_no_review_candidates` needs phase 1's `strategy_candidates` writer; it fails
  until Step 9's guard is in place.
- `_first_bought` asserts the synthetic world's AUG7 decision is A's ranked picks, sized. It is
  `test_veto_command`'s night ("A ranks five candidates"); if it does not hold, find the night with
  `ranked_aug7`-style code and move AUG6/AUG7 -- never weaken an assertion.
- `test_a_book_objection_...`: `both` non-empty is a property of this world, checked before
  planning on it is not possible here; if it is empty, pick the first `N` night whose next session
  is a rank session where RAW-FR keeps a name, and say so in the test.

### Step 16: Tests -- promote creates and retires twins in its transaction
**File:** `engine/tests/test_promote_command.py` -- append after
`test_dry_run_prints_the_rows_and_writes_to_neither_database` (line ~361).
**Code:**
```python
# ---- Claude twins (Seer Adversarial, contract C2) ----------------------------------------------


def _seed_resolvable_row(pg, sid: str, *, twin_of: str | None = None) -> None:
    """A roster row the night can build (FUNDAMENTAL, named by this file's resolver fixture)."""
    name = "OLD · old" if twin_of is None else "OLD+Claude · old"
    pg.execute(
        "INSERT INTO strategies (id, name, sub, icon, sort, engine, rules_id, object_name, gate_note, "
        "gate_applicable, twin_of, params) "
        "VALUES (%s, %s, 'old', 'x', 1, 'book', 'monthly-hold', 'FUNDAMENTAL', 'old note', %s, %s, '{}'::jsonb)",
        (sid, name, twin_of is None, twin_of),
    )
    pg.commit()


def test_promote_creates_the_claude_twin_in_the_same_transaction(pg, monkeypatch, lab, tmp_path):
    _wire(monkeypatch, pg=pg, lab=lab)
    assert promote.run(_args(lab_db=tmp_path / "lab.sqlite")) == 0
    row = pg.execute(
        "SELECT name, twin_of, status, paper_start, gate_applicable, gate_note, engine, rules_id, object_name "
        "FROM strategies WHERE id = 'TEST-FND-CX'"
    ).fetchone()
    assert row == (
        "T+Claude · Fundamentals", "TEST-FND", "active", None, False, roster.TWIN_GATE_NOTE,
        "book", "monthly-hold", promote.object_name_of(FUNDAMENTAL),
    )
    assert "TEST-FND-CX" in {e.id for e in roster.from_rows(paper_store.read_roster_rows(pg))}


def test_a_dry_run_promotion_creates_no_twin(pg, monkeypatch, lab, tmp_path):
    _wire(monkeypatch, pg=pg, lab=lab)
    assert promote.run(_args(dry_run=True, lab_db=tmp_path / "lab.sqlite")) == 0
    assert pg.execute("SELECT count(*) FROM strategies WHERE id = 'TEST-FND-CX'").fetchone()[0] == 0


def test_promote_retire_retires_the_retired_entrys_twin_too(pg, monkeypatch, lab, tmp_path):
    _seed_resolvable_row(pg, "OLD")
    _seed_resolvable_row(pg, "OLD-CX", twin_of="OLD")
    _wire(monkeypatch, pg=pg, lab=lab)
    assert promote.run(_args(retire="OLD", lab_db=tmp_path / "lab.sqlite")) == 0
    rows = dict(
        pg.execute(
            "SELECT id, status FROM strategies WHERE id IN ('OLD', 'OLD-CX', 'TEST-FND', 'TEST-FND-CX')"
        ).fetchall()
    )
    assert rows == {"OLD": "retired", "OLD-CX": "retired", "TEST-FND": "active", "TEST-FND-CX": "active"}
```
**Impact:** existing promote tests keep passing: an unresolvable seeded row (`_seed_roster_row`,
no `object_name`) is not eligible, so `ensure_twins` ignores it.

### Step 17: Runbook, README, feature map, seed script
**Files:** `docs/runbooks/paper-trading.md` (new section before `## Strategy C: the news check`,
line 267; one line in the night diagram, line ~152), `README.md` (after the "One night, step by
step" table, line ~390), `.claude/skills/verify-seer/features/engine-night.md`,
`.claude/skills/verify-seer/features/README.md` (the engine-night row),
`.claude/skills/verify-seer/features/steps/twin-world.py` (new).
**Code:**

Runbook: in phase 1's 2026-11-05 roster subsection, replace its last sentence "No twin row is
created by 027; the twins are a later change." with "No twin row is created by 027; the paper night
creates the twins (see "Claude twins (Seer Adversarial)")." Then add the section:
```markdown
## Claude twins (Seer Adversarial)

Every active method on the roster that is not the benchmark and not C has a **Claude twin**: a
row `<ID>-CX` (`twin_of = <ID>`, name `<HEAD>+Claude · <TAIL>`, `gate_applicable = false`) that
runs the same method but does not buy what Claude objected to before the session opened. Claude's
verdicts come from mcp-notes' reviewer, which writes `adversary_verdicts` (migration 027). Seer
never asks Claude anything.

- **Born and retired with no manual step.** The paper night's transaction begins with
  `store.ensure_twins`: an eligible original without an active twin gets one, a twin whose
  original retired is retired (`paper_end` = the twin's last stepped session, history kept).
  `promote` does the same inside the promotion's transaction. No migration writes a twin row.
- **One session behind.** A twin decides session S on the night after S closed, from the bars
  through the session before S, then settles S the next night. So its equity, positions and
  pending orders are always one session behind its original's, and its pending decision is for a
  session that has already traded (twins are never on Today). It starts on the first night it can
  decide a session on or after its original's `paper_start`, with 10,000,000 IDR and the owner's
  deposits from its own `paper_start`.
- **Which verdict counts.** For each (original, session, symbol), the latest verdict with
  `decided_at` before 09:30 New York time on that session (`dates.session_open_utc`). Only
  `object` drops a stock. `agree`, `unsure`, a late verdict and no verdict keep it: the twin copies
  its original. `superseded_by` is history; the engine does not read it.
- **Bracket twins** (A-GT-CX) skip an objected pick; the next-ranked pick takes the slot.
  **Book twins** drop an objected target at a rank or kickoff session and spread its weight pro
  rata over the rest; every target objected = the original's empty decision. An objected stock the
  book holds is sold, and the fees count against Claude.
- **Replay.** `paper_check` replays a twin with the same verdict reader over its own window; it
  must be `ok` like any entry.
- **No review of a twin's own picks.** A twin writes no `strategy_candidates`, and `explain`
  skips it.

**When the night fails with "`<ID>` is active and has no active Claude twin, but `<ID>-CX` already
exists".** Someone retired a twin by hand while its original trades. A twin id is never reused.
Either re-activate it (`UPDATE strategies SET status = 'active', paper_end = NULL WHERE id =
'<ID>-CX'`; the next night catches it up session by session) or retire the original too.
```
Night diagram: under the `├─ Paper` block, after the "decide session_date" lines, add:
```text
│                              Claude twins (*-CX): the same, one session behind (they settle
│                              prev_session(data_date) and decide data_date), dropping what Claude
│                              objected to before that session's open; ensure_twins runs first
```
README paragraph (after the "One night, step by step" table):
```markdown
**Claude twins.** Each method on the roster except the benchmark and C has a paper twin,
`<ID>-CX`, that follows the same rule but drops the stocks Claude objected to before the session
opened (the reviewer lives in mcp-notes and writes `adversary_verdicts`). Twins are created and
retired by the paper night itself, trade one session behind their originals so every verdict they
read was final before the market opened, and are replayed by `paper_check` like everything else.
Details: `docs/runbooks/paper-trading.md`, "Claude twins".
```
`features/README.md`, engine-night row becomes:
```markdown
| The night: migrate, nightly, paper (Claude twins included), paper_check | [engine-night.md](engine-night.md) | engine | `--net` opt-in (free tiers) |
```
`features/engine-night.md` is the file as phase 1 rewrote it (phase-1 plan Step 12; reconciled: edit
that version, never re-create the file). In its `## Sub-features`, replace phase 1's bullet
``- Schema only, written by mcp-notes: `adversary_verdicts` (append-only by trigger), `adversary_marks`,
`adversary_leases`, `strategies.twin_of`.`` with
``- Schema only, written by mcp-notes: `adversary_verdicts` (append-only by trigger), `adversary_marks`,
`adversary_leases`.`` (`twin_of` is now written by the night), and in `## Gotchas` replace phase 1's
"reports `replay mismatch` for all five strategies" with "reports `replay mismatch` for every seeded
paper strategy" (phase 3 adds a demo twin in parallel, so the count is not pinned here).
Then add to `## Sub-features`:
```markdown
- Claude twins (Seer Adversarial): `paper` creates `<ID>-CX` for every active original except the
  benchmark and C, steps it one session behind, and drops what `adversary_verdicts` objected to
  before the session's open; `paper_check` replays twins.
```
add a section after phase 1's pytest journeys block (the fenced `sh` block ending in
`-k "list or preview or twin or a_gt or catch_up or look_ahead"`), before `## Gotchas`:
````markdown
### Claude twins (a real night on a seeded run)

`features/steps/twin-world.py` writes the engine suite's synthetic market (24 random-walk stocks
and SPY through 2026-10-09, `tests/test_paper_command.py`) and a successful bars-run row per night
into the RUN's own database, so `paper` can run for real. It refuses any URL that is not a
verify-seer run database. It also writes one `adversary_verdicts` row, the way mcp-notes' reviewer
does.

```sh
PY=engine/.venv/bin/python; TW=.claude/skills/verify-seer/features/steps/twin-world.py
$V up --no-web --empty                                   # RUN=...
$PY $TW world RUN                                        # "seeded RUN: ... 8 bars runs (2026-09-23..2026-10-02)"
$V engine RUN paper --now 2026-09-23T23:00:00Z           # exit 0; "Claude twin created" x3
$V sql RUN "select id, twin_of, status, paper_start, gate_applicable from strategies where twin_of is not null order by id"
    # A-GT-CX|A-GT, COSK-FR-GT-CX|COSK-FR-GT, RAW35-FR-GT-CX|RAW35-FR-GT; active; paper_start empty; f
for d in 24 25 28 29 30; do $V engine RUN paper --now 2026-09-${d}T23:00:00Z; done   # each exit 0
$V sql RUN "select strategy_id, last_session, pending_session from paper_state order by strategy_id"
    # originals 2026-09-30 | 2026-10-01; every *-CX 2026-09-29 | 2026-09-30
$V sql RUN "select symbol from book_targets where strategy_id = 'RAW35-FR-GT' and session_date = '2026-10-01' order by rank limit 2"
    # two symbols: H1, H2
$PY $TW verdict RUN RAW35-FR-GT 2026-10-01 H1 object 2026-10-01T12:00:00+00:00   # before the 13:30 UTC open
$PY $TW verdict RUN RAW35-FR-GT 2026-10-01 H2 object 2026-10-01T13:30:00+00:00   # at the open: late
$V engine RUN paper --now 2026-10-01T23:00:00Z           # exit 0: the twin decides 2026-10-01
$V sql RUN "select o.symbol, o.weight, t.weight from book_targets o left join book_targets t on t.strategy_id = 'RAW35-FR-GT-CX' and t.session_date = o.session_date and t.symbol = o.symbol where o.strategy_id = 'RAW35-FR-GT' and o.session_date = '2026-10-01' order by o.rank"
    # H1: twin weight empty; H2: twin weight present; every present twin weight >= the original's
$V engine RUN paper --now 2026-10-02T23:00:00Z           # exit 0: the twin settles 2026-10-01
$V sql RUN "select symbol from book_positions where strategy_id = 'RAW35-FR-GT-CX' and symbol = 'H1'"   # 0 rows
$V engine RUN paper_check                                # exit 0; every *-CX line "ok"
$V down RUN
```
````
add to `## Gotchas`:
```markdown
- A twin is always one session behind: a `*-CX` `pending_session` is a session that already
  traded. That is the design (Decision D1), not a stuck night.
- On `up --empty` with no seeding, `paper` never runs (no bars run), so no twin exists and
  `doctor`'s strategy count is the migrated roster's. Twins appear only after a real night.
- If RAW35-FR-GT has no 2026-10-01 targets on the synthetic market, run the verdict journey on
  COSK-FR-GT instead (also a rank on 2026-10-01); mark it `inconclusive` if neither ranks.
````

Seed script `.claude/skills/verify-seer/features/steps/twin-world.py`:
```python
"""Seed a verify-seer run's OWN database so a real `paper` night can run, and file test verdicts.

Usage (from the checkout being verified):
  engine/.venv/bin/python .claude/skills/verify-seer/features/steps/twin-world.py world RUN
  engine/.venv/bin/python .claude/skills/verify-seer/features/steps/twin-world.py verdict RUN ORIGINAL SESSION SYMBOL VERDICT DECIDED_AT

`world` writes the engine suite's synthetic market -- tests/test_paper_command.py: 24 random-walk
stocks and SPY, 2025-01-02..2026-10-09, USD/IDR, an SP500 universe, one SPY dividend -- and the
successful bars-run row `nightly` would write for each night 2026-09-23..2026-10-02. `verdict`
inserts one adversary_verdicts row the way mcp-notes' reviewer does (migration 027).

Why a script and not `verify.sh sql`: `sql` is read-only on purpose, and a real night needs bars
that only a 10-year backfill or this fixture can give. The URL comes from the run's own
engine.env and anything that is not a verify-seer run database (127.0.0.1:55437/v_*) is refused,
so this can never reach Neon.
"""

from __future__ import annotations

import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[5]
sys.path[:0] = [str(ROOT / "engine" / "src"), str(ROOT / "engine" / "tests")]

import psycopg  # noqa: E402
from psycopg.types.json import Jsonb  # noqa: E402

import test_paper_command as tp  # noqa: E402
from seer_engine import bars, dates, fx  # noqa: E402

VERIFY_HOME = Path(os.environ.get("VERIFY_HOME", str(Path.home() / ".local" / "state" / "seer-verify")))
RUN_DB = "postgresql://postgres@127.0.0.1:55437/v_"
NIGHTS = tuple(dates.sessions(date(2026, 9, 23), date(2026, 10, 2)))


def run_url(run: str) -> str:
    env = VERIFY_HOME / run / "engine.env"
    for line in env.read_text(encoding="utf-8").splitlines():
        if line.startswith("DATABASE_URL="):
            url = line.split("=", 1)[1].strip()
            if not url.startswith(RUN_DB):
                sys.exit(f"refusing {url!r}: not a verify-seer run database")
            return url
    sys.exit(f"no DATABASE_URL in {env}")


def world(conn: psycopg.Connection) -> str:
    bars.upsert_bars(conn, tp.synthetic_bars())
    fx.upsert_fx(conn, [(d, tp.fx_rate(d)) for d in tp._sessions()])
    for s in tp.STOCKS:
        conn.execute(
            "INSERT INTO universe (symbol, index_id, start_date, end_date, source_symbol) "
            "VALUES (%s, 'SP500', '2020-01-02', NULL, %s) ON CONFLICT DO NOTHING",
            (s, s),
        )
    conn.execute(
        "INSERT INTO dividends (symbol, ex_date, amount) VALUES ('SPY', %s, %s) ON CONFLICT DO NOTHING",
        (tp.DIV_DATE, tp.DIV_AMT),
    )
    for d in NIGHTS:
        rd = dates.run_dates(datetime(d.year, d.month, d.day, 23, tzinfo=timezone.utc))
        conn.execute(
            "INSERT INTO runs (status, data_date, session_date, is_demo, finished_at) "
            "VALUES ('success', %s, %s, false, now()) ON CONFLICT (session_date) WHERE NOT is_demo DO NOTHING",
            (rd.data_date, rd.session_date),
        )
    return f"{len(tp.STOCKS) + 1} symbols of bars, {len(NIGHTS)} bars runs ({NIGHTS[0]}..{NIGHTS[-1]})"


def verdict(conn: psycopg.Connection, original: str, session: str, symbol: str, what: str, decided: str) -> str:
    decided_at = datetime.fromisoformat(decided)
    if decided_at.utcoffset() is None:
        sys.exit("DECIDED_AT needs a UTC offset, e.g. 2026-10-01T12:00:00+00:00")
    sources = [] if what == "unsure" else [{
        "url": "https://example.invalid/verify-seer",
        "title": "verify-seer fixture",
        "publisher": "verify-seer",
        "published_at": None,
        "fetched_at": decided_at.isoformat(),
    }]
    (vid,) = conn.execute(
        "INSERT INTO adversary_verdicts (strategy_id, session_date, symbol, verdict, reason, sources, lens, "
        "model, prompt_version, host, started_at, decided_at) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
        (
            original, date.fromisoformat(session), symbol, what, "verify-seer fixture verdict.", Jsonb(sources),
            "verify@1", "verify-model", "verify-v1", "verify-seer", decided_at - timedelta(minutes=5), decided_at,
        ),
    ).fetchone()
    return f"adversary_verdicts id {vid}: {original} {session} {symbol} {what}, decided {decided_at.isoformat()}"


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[0] == "world":
        cmd, run, rest = "world", argv[1], argv[2:]
    elif len(argv) == 7 and argv[0] == "verdict":
        cmd, run, rest = "verdict", argv[1], argv[2:]
    else:
        print(__doc__, file=sys.stderr)
        return 2
    with psycopg.connect(run_url(run)) as conn:
        out = world(conn) if cmd == "world" else verdict(conn, *rest)
        conn.commit()
    print(f"seeded {run}: {out}" if cmd == "world" else out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
```
**Impact:** docs and proof only.

## Principles applied

- Laziness protocol: twins reuse the original's object behind a wrapper and the existing step
  loops on lagged run dates; `write_pending`, `paper.replay`, `sim/*` and the step functions'
  shapes are untouched (D1's "no change to the state machine" kept literally).
- Boundary discipline: verdict rows are validated once in `twin.objected_map` (called by
  `store.objected_between`, the DB edge); the wrappers trust the normalised map.
- Make illegal states unrepresentable: a twin row is never hand-built -- `roster.twin_row` derives
  it from the original, `twin_id` fixes its id, and `from_rows` refuses a twin whose method differs
  from its original's; `twin_book` picks the MarketAware class from the inner allocator so a twin
  cannot silently switch code paths.
- Encode lessons in structure: `paper/roster.py` must stay pure (purity test), so the index's
  `roster.ensure_twins(conn)` became `roster.plan_twins` (pure) + `store.ensure_twins` (writes).
- Build the lever: `features/steps/twin-world.py` lets any verifier produce real nights and real
  verdict rows on a throwaway run instead of trusting unit tests.
- Prove it works: Proof drives the real `paper` / `paper_check` CLI through verify-seer and reads
  the rows back with `sql`.
- Test behavior, not implementation: DB tests assert stored rows, `paper_check` results and what
  `explain` would read; the pure tests drive the wrappers only through `decide_bracket` and the
  Allocator protocol.

## Verification

**Build:** `cd /home/miftah/.worktrees/seer/seer-adversarial && engine/.venv/bin/ruff check engine`
**Tests:**
```sh
cd /home/miftah/.worktrees/seer/seer-adversarial
docker start seer-pg 2>/dev/null || docker run -d --name seer-pg -e POSTGRES_PASSWORD=pg -p 55432:5432 postgres:16
export PG_TEST_URL=postgresql://postgres:pg@localhost:55432/postgres
engine/.venv/bin/pytest engine/tests/test_twin.py engine/tests/test_paper_twins.py engine/tests/test_promote_command.py -n0 -q
engine/.venv/bin/pytest engine/tests            # the whole suite, parallel; must not skip DB tests
```
**Proof:**
- Harness: `.claude/skills/verify-seer` (`V=.claude/skills/verify-seer/scripts/verify.sh`), engine
  surface, offline (no `--net`, no `--llm`).
- Feature-map entries: `features/engine-night.md` (updated in Step 17).
- Journeys (each command run from the Seer worktree root; `PY=engine/.venv/bin/python`,
  `TW=.claude/skills/verify-seer/features/steps/twin-world.py`):
  1. **Twins are created by a real night, none for C or the benchmark.** `$V up --no-web --empty`
     (note RUN); `$PY $TW world RUN`; `$V engine RUN paper --now 2026-09-23T23:00:00Z` exits 0;
     `$V sql RUN "select id, twin_of, status, paper_start, gate_applicable, gate_note from strategies where twin_of is not null order by id"`
     returns exactly `A-GT-CX|A-GT`, `COSK-FR-GT-CX|COSK-FR-GT`, `RAW35-FR-GT-CX|RAW35-FR-GT`, each
     `active`, empty `paper_start`, `f`, the C2 gate note; no `C-GT-CX`, no `SPY-GT-CX`.
  2. **Twins run one session behind.** `for d in 24 25 28 29 30; do $V engine RUN paper --now 2026-09-${d}T23:00:00Z; done`
     (each exit 0); `$V sql RUN "select strategy_id, last_session, pending_session from paper_state order by strategy_id"`
     shows every original at `2026-09-30 | 2026-10-01` and every `*-CX` at `2026-09-29 | 2026-09-30`;
     `$V sql RUN "select id, paper_start from strategies where twin_of is not null"` shows
     `2026-09-24` for all three (the night after their originals started).
  3. **An in-time objection drops exactly that name, pro rata; a late one is ignored.**
     `$V sql RUN "select symbol from book_targets where strategy_id='RAW35-FR-GT' and session_date='2026-10-01' order by rank limit 2"`
     gives H1, H2; `$PY $TW verdict RUN RAW35-FR-GT 2026-10-01 <H1> object 2026-10-01T12:00:00+00:00`;
     `$PY $TW verdict RUN RAW35-FR-GT 2026-10-01 <H2> object 2026-10-01T13:30:00+00:00`;
     `$V engine RUN paper --now 2026-10-01T23:00:00Z` exits 0; the join query in engine-night.md
     shows H1 with no twin weight, H2 with a twin weight, and every twin weight `>=` the
     original's; `$V sql RUN "select sum(weight) from book_targets where session_date='2026-10-01' and strategy_id in ('RAW35-FR-GT','RAW35-FR-GT-CX') group by strategy_id"`
     differ by at most `0.0001`.
  4. **The objected name leaves the twin's book; the replay agrees.**
     `$V engine RUN paper --now 2026-10-02T23:00:00Z` exits 0;
     `$V sql RUN "select count(*) from book_positions where strategy_id='RAW35-FR-GT-CX' and symbol='<H1>'"` is `0`;
     `$V engine RUN paper_check` exits 0 and prints `ok` on the `A-GT-CX`, `COSK-FR-GT-CX` and
     `RAW35-FR-GT-CX` lines. `$V note RUN "twins created, lagged, H1 dropped, H2 kept, paper_check ok"`; `$V down RUN`.
- Neighbor check: the originals' own night. In journey 4's `paper_check` output every original
  (`A-GT`, `C-GT`, `RAW35-FR-GT`, `COSK-FR-GT`, `SPY-GT`) is `ok`; and
  `engine/.venv/bin/pytest engine/tests/test_paper_command.py engine/tests/test_paper_check.py engine/tests/test_paper_c.py engine/tests/test_veto_command.py`
  passes unchanged apart from the `ensure_twins=False` edits.
- Cost: none (offline; no LLM, no network).

**Exit criteria:** on a fresh verify-seer run, one real paper night creates `A-GT-CX`,
`RAW35-FR-GT-CX`, `COSK-FR-GT-CX` and nothing for `C-GT` / `SPY-GT`; twins step one session behind;
an in-time objection removes exactly the objected name (book weights renormalised pro rata), a
verdict at or after the open changes nothing; `paper_check` exits 0 with every twin `ok`;
`ruff check engine` clean and `pytest engine/tests` green with `PG_TEST_URL` set.

## Handoffs

- **Phase 1** (R1): the `strategy_candidates` / `next_decision_session` writers are phase 1's;
  this phase switches their predicate to `_reviewable(e)` and deletes `store.is_twin` (Step 9).
  Step 8's code blocks quote phase 1's `repick` / `_start` as phase 1 leaves them (reconciled).
  Phase 1 sets the verify-seer counts to "27 migrations, strategies: 24" (`SKILL.md`,
  `engine-night.md`); twins do not change them on `up --empty` (no migration writes a twin, and no
  paper night runs there). Phase 1's night tests run through `go()`, covered by Step 13.
- **Phase 3** (R3): twins are `strategies` rows with `twin_of` set, `gate_applicable=false`, name
  `<HEAD>+Claude · <TAIL>`, sort equal to the original's; their snapshots end one session before
  the original's, so any comparison must use common sessions (the leaderboard's `compare()` does).
  Demo seed rows for a twin (`web/scripts/seed-demo.mjs`) are phase 3's.
- **Phase 4** (R4): review only originals (`twin_of IS NULL`); twins write no candidates. Verdicts
  must be filed under the ORIGINAL's id; the engine never reads a verdict filed under a `*-CX` id.
- **Phase 5** (R5): coverage "reviewed" matches the engine exactly only with C3's cutoff
  (`decided_at < session_open_utc`); `superseded_by` is display history. Scorecard alignment: a
  twin's last session is its original's minus one.
- **Future (no phase):** `FILTER_VERSION` is in every twin's digest and the twin id scheme
  `<ID>-CX` is fixed, so changing what a twin does with a verdict would need a new id scheme (for
  example `-CX2`) plus a retirement of the old twins. Record that as a dated decision before
  anyone edits `strategies/twin.py` semantics.

## Rollback

Revert this phase's commit on `feature/seer-adversarial` (it is code, tests and docs only; no
migration). On a database where a night with this code already ran, the twin rows stay: they are
ordinary `strategies` rows with history. If the code is reverted while twin rows are active, the
old `from_row` ignores `twin_of` and would trade them as plain copies of their originals -- so ship
the plan index's migration 028 (retire every `*-CX` row) in the same push as the revert, never
after it.
