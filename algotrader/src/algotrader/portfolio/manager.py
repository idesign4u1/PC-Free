"""Portfolio manager: the broker is the source of truth, we add the audit trail.

Quantities, cash and equity always come from the broker. Everything the broker
does not know - why a position was opened, where its stop sits, which strategy
asked for it - is held here and persisted separately.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Iterable

import numpy as np

from ..broker.base import BrokerAdapter, Quote
from ..config import UniverseConfig
from ..logging_setup import get_logger
from ..market_data.indicators import correlation, returns
from ..market_data.series import BarSeries
from ..utils.timeutils import is_same_trading_day, utc_now, week_start
from .models import PortfolioState, Position

log = get_logger(__name__)


@dataclass
class Reconciliation:
    """Difference between what we believe and what the broker reports."""

    unexpected_positions: list[str] = field(default_factory=list)
    missing_positions: list[str] = field(default_factory=list)
    quantity_mismatches: dict[str, tuple[float, float]] = field(default_factory=dict)

    @property
    def is_consistent(self) -> bool:
        return not (self.unexpected_positions or self.missing_positions or self.quantity_mismatches)

    def describe(self) -> str:
        parts = []
        if self.unexpected_positions:
            parts.append(f"unexpected positions: {', '.join(self.unexpected_positions)}")
        if self.missing_positions:
            parts.append(f"missing positions: {', '.join(self.missing_positions)}")
        if self.quantity_mismatches:
            details = ", ".join(
                f"{sym} broker={b} tracked={t}" for sym, (b, t) in self.quantity_mismatches.items()
            )
            parts.append(f"quantity mismatches: {details}")
        return "; ".join(parts) or "consistent"


class PortfolioManager:
    """Owns the live :class:`PortfolioState`."""

    def __init__(self, broker: BrokerAdapter, universe: UniverseConfig) -> None:
        self.broker = broker
        self.universe = universe
        self.state = PortfolioState(equity=0.0, cash=0.0, buying_power=0.0)
        self._metadata: dict[str, Position] = {}     # symbol -> tracked position metadata
        self._last_refresh: datetime | None = None
        self._day_anchor: datetime | None = None
        self._week_anchor: datetime | None = None

    # ------------------------------------------------------------------ #
    def restore(
        self,
        *,
        high_water_mark: float = 0.0,
        day_start_equity: float = 0.0,
        week_start_equity: float = 0.0,
        consecutive_losses: int = 0,
        positions: Iterable[Position] = (),
    ) -> None:
        """Rehydrate persisted state after a restart."""
        self.state.high_water_mark = max(self.state.high_water_mark, high_water_mark)
        if day_start_equity:
            self.state.day_start_equity = day_start_equity
        if week_start_equity:
            self.state.week_start_equity = week_start_equity
        self.state.consecutive_losses = consecutive_losses
        for position in positions:
            self._metadata[position.symbol.upper()] = position

    def track(self, position: Position) -> None:
        """Attach (or replace) the audit metadata for a symbol."""
        self._metadata[position.symbol.upper()] = position

    def untrack(self, symbol: str) -> None:
        self._metadata.pop(symbol.upper(), None)

    def tracked(self, symbol: str) -> Position | None:
        return self._metadata.get(symbol.upper())

    # ------------------------------------------------------------------ #
    async def refresh(self, quotes: dict[str, Quote] | None = None) -> PortfolioState:
        """Pull balances + positions from the broker and rebuild the state."""
        balances = await self.broker.get_balances()
        broker_positions = await self.broker.get_positions()
        now = utc_now()
        quotes = quotes or {}

        positions: dict[str, Position] = {}
        for bp in broker_positions:
            symbol = bp.symbol.upper()
            meta = self._metadata.get(symbol)
            quote = quotes.get(symbol)
            price = (quote.mid if quote else None) or (meta.current_price if meta else 0.0)
            position = Position(
                symbol=symbol,
                quantity=bp.quantity,
                average_price=bp.average_price or (meta.average_price if meta else 0.0),
                opened_at=bp.acquired or (meta.opened_at if meta else now),
                current_price=price or bp.average_price,
                strategy=meta.strategy if meta else "unknown",
                stop_price=meta.stop_price if meta else None,
                take_profit_price=meta.take_profit_price if meta else None,
                initial_stop_price=meta.initial_stop_price if meta else None,
                highest_price_since_entry=meta.highest_price_since_entry if meta else 0.0,
                lowest_price_since_entry=meta.lowest_price_since_entry if meta else 0.0,
                risk_per_share=meta.risk_per_share if meta else 0.0,
                entry_reason=meta.entry_reason if meta else {},
                sizing_reason=meta.sizing_reason if meta else {},
                stop_reason=meta.stop_reason if meta else {},
                regime_at_entry=meta.regime_at_entry if meta else "",
                opportunity_score=meta.opportunity_score if meta else 0.0,
                confidence_at_entry=meta.confidence_at_entry if meta else 0.0,
                sector=self.universe.sector_of(symbol),
                trade_id=meta.trade_id if meta else None,
            )
            if quote and quote.mid:
                position.mark(quote.mid)
            positions[symbol] = position
            # Keep metadata marks in sync so trailing stops survive refreshes.
            if meta:
                meta.mark(position.current_price)
                meta.quantity = position.quantity

        previous = self.state
        state = PortfolioState(
            equity=balances.total_equity,
            cash=balances.total_cash,
            buying_power=balances.buying_power,
            positions=positions,
            high_water_mark=max(previous.high_water_mark, balances.total_equity),
            day_start_equity=previous.day_start_equity,
            week_start_equity=previous.week_start_equity,
            realized_pnl_today=previous.realized_pnl_today,
            risk_opened_today=previous.risk_opened_today,
            consecutive_losses=previous.consecutive_losses,
            as_of=now,
            account_id=balances.account_id,
            sector_map=dict(self.universe.sectors),
        )
        self.state = self._roll_periods(state, now)
        self._last_refresh = now
        return self.state

    def _roll_periods(self, state: PortfolioState, now: datetime) -> PortfolioState:
        """Reset the daily/weekly anchors when a new period starts."""
        if self._day_anchor is None or not is_same_trading_day(self._day_anchor, now):
            if self._day_anchor is not None:
                state.day_start_equity = state.equity
                state.realized_pnl_today = 0.0
                state.risk_opened_today = 0.0
            self._day_anchor = now
        current_week = week_start(now)
        if self._week_anchor is None or week_start(self._week_anchor) != current_week:
            if self._week_anchor is not None:
                state.week_start_equity = state.equity
            self._week_anchor = now
        if state.day_start_equity <= 0:
            state.day_start_equity = state.equity
        if state.week_start_equity <= 0:
            state.week_start_equity = state.equity
        return state

    # ------------------------------------------------------------------ #
    def mark_positions(self, quotes: dict[str, Quote]) -> None:
        for symbol, position in self.state.positions.items():
            quote = quotes.get(symbol)
            if quote and quote.mid:
                position.mark(quote.mid)
                meta = self._metadata.get(symbol)
                if meta:
                    meta.mark(quote.mid)

    def register_fill(self, position: Position, risk_amount: float) -> None:
        self.track(position)
        self.state.positions[position.symbol.upper()] = position
        self.state.risk_opened_today += max(0.0, risk_amount)

    def register_close(self, symbol: str, realized_pnl: float) -> None:
        symbol = symbol.upper()
        self.state.positions.pop(symbol, None)
        self.untrack(symbol)
        self.state.realized_pnl_today += realized_pnl
        if realized_pnl < 0:
            self.state.consecutive_losses += 1
        elif realized_pnl > 0:
            self.state.consecutive_losses = 0

    # ------------------------------------------------------------------ #
    async def reconcile(self) -> Reconciliation:
        """Compare broker truth against tracked state. Drives the kill switch."""
        broker_positions = {p.symbol.upper(): p.quantity for p in await self.broker.get_positions()}
        tracked = {s: p.quantity for s, p in self._metadata.items() if p.quantity}
        result = Reconciliation()
        for symbol, quantity in broker_positions.items():
            if symbol not in tracked:
                result.unexpected_positions.append(symbol)
            elif abs(tracked[symbol] - quantity) > 1e-6:
                result.quantity_mismatches[symbol] = (quantity, tracked[symbol])
        for symbol in tracked:
            if symbol not in broker_positions:
                result.missing_positions.append(symbol)
        if not result.is_consistent:
            log.warning("portfolio_reconciliation_mismatch", detail=result.describe())
        return result

    # ------------------------------------------------------------------ #
    def correlated_exposure(
        self,
        candidate: str,
        series_by_symbol: dict[str, BarSeries],
        threshold: float,
        lookback: int,
    ) -> tuple[float, dict[str, float]]:
        """Exposure (fraction of equity) already held in names correlated with `candidate`."""
        candidate = candidate.upper()
        candidate_series = series_by_symbol.get(candidate)
        if candidate_series is None or self.state.equity <= 0:
            return 0.0, {}
        candidate_returns = returns(candidate_series.closes)[-lookback:]
        exposure = 0.0
        correlations: dict[str, float] = {}
        for symbol, position in self.state.positions.items():
            other = series_by_symbol.get(symbol)
            if other is None or symbol == candidate:
                continue
            rho = correlation(candidate_returns, returns(other.closes)[-lookback:])
            correlations[symbol] = round(rho, 3)
            if abs(rho) >= threshold:
                exposure += position.market_value
        return exposure / self.state.equity, correlations

    def correlation_matrix(self, series_by_symbol: dict[str, BarSeries], lookback: int) -> dict[str, dict[str, float]]:
        symbols = sorted(series_by_symbol)
        matrix: dict[str, dict[str, float]] = {}
        cached = {s: returns(series_by_symbol[s].closes)[-lookback:] for s in symbols}
        for a in symbols:
            matrix[a] = {}
            for b in symbols:
                matrix[a][b] = 1.0 if a == b else round(correlation(cached[a], cached[b]), 3)
        return matrix

    def summary(self) -> dict[str, Any]:
        payload = self.state.to_dict()
        payload["positions"] = [p.to_dict() for p in self.state.positions.values()]
        return payload
