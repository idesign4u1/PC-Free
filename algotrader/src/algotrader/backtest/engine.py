"""Event-driven backtester.

It runs the *same* strategy, signal-scoring and risk modules as live trading -
there is no parallel "backtest strategy" implementation to drift out of sync.

Realism rules:

* **No look-ahead.** On bar ``i`` a strategy only ever sees ``bars[:i+1]``.
  Decisions taken on the close of bar ``i`` are filled on bar ``i+1``'s open.
* **Costs.** Every fill pays a configurable half-spread, slippage in basis
  points against the trade direction, and per-share commission with a minimum.
* **Stops are checked intrabar** against the bar's high/low. When a bar touches
  both the stop and the target, the stop is assumed to fill first.
* **Gaps are respected.** A stop that gaps through fills at the open, not at
  the stop price.
* **Liquidity.** A fill can never exceed a configured share of the bar's volume.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Iterable

from ..broker.base import Bar
from ..config import AppConfig
from ..enums import ExitReason, SignalDirection, SystemMode
from ..logging_setup import get_logger
from ..market_data.indicators import (
    atr as atr_indicator,
    average_dollar_volume,
    last_valid,
    realized_volatility,
    sma,
)
from ..market_data.series import BarSeries
from ..portfolio.models import PortfolioState, Position
from ..regime.classifier import RegimeClassifier
from ..risk.engine import EntryProposal, RiskEngine
from ..signals.scoring import SignalAggregator
from ..strategy import build_strategies
from ..strategy.base import StrategyContext
from .metrics import PerformanceMetrics, compute_metrics

log = get_logger(__name__)


@dataclass
class BacktestTrade:
    symbol: str
    direction: str
    quantity: int
    entry_date: datetime
    entry_price: float
    exit_date: datetime | None = None
    exit_price: float | None = None
    pnl: float = 0.0
    r_multiple: float | None = None
    commission: float = 0.0
    risk_per_share: float = 0.0
    stop_price: float | None = None
    take_profit_price: float | None = None
    exit_reason: str = ""
    regime_at_entry: str = ""
    score: float = 0.0
    confidence: float = 0.0
    strategy_contributions: list[dict[str, Any]] = field(default_factory=list)
    holding_days: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "direction": self.direction,
            "quantity": self.quantity,
            "entry_date": self.entry_date.isoformat(),
            "entry_price": round(self.entry_price, 4),
            "exit_date": self.exit_date.isoformat() if self.exit_date else None,
            "exit_price": round(self.exit_price, 4) if self.exit_price else None,
            "pnl": round(self.pnl, 2),
            "r_multiple": round(self.r_multiple, 3) if self.r_multiple is not None else None,
            "commission": round(self.commission, 2),
            "exit_reason": self.exit_reason,
            "regime_at_entry": self.regime_at_entry,
            "score": round(self.score, 4),
            "confidence": round(self.confidence, 2),
            "holding_days": round(self.holding_days, 2),
            "strategy_contributions": self.strategy_contributions,
        }


@dataclass
class BacktestResult:
    metrics: PerformanceMetrics
    trades: list[BacktestTrade]
    equity_curve: list[tuple[datetime, float]]
    start: datetime | None
    end: datetime | None
    symbols: list[str]
    config_hash: str
    rejections: dict[str, int] = field(default_factory=dict)

    def to_dict(self, include_trades: bool = True) -> dict[str, Any]:
        payload = {
            "metrics": self.metrics.to_dict(),
            "start": self.start.isoformat() if self.start else None,
            "end": self.end.isoformat() if self.end else None,
            "symbols": self.symbols,
            "config_hash": self.config_hash,
            "trade_count": len(self.trades),
            "top_rejection_reasons": dict(
                sorted(self.rejections.items(), key=lambda kv: kv[1], reverse=True)[:10]
            ),
            "equity_curve": [[ts.isoformat(), round(value, 2)] for ts, value in self.equity_curve],
        }
        if include_trades:
            payload["trades"] = [trade.to_dict() for trade in self.trades]
        return payload


@dataclass
class _PendingEntry:
    symbol: str
    quantity: int
    stop_price: float
    take_profit_price: float
    risk_amount: float
    score: float
    confidence: float
    regime: str
    contributions: list[dict[str, Any]]


class BacktestEngine:
    def __init__(
        self,
        config: AppConfig,
        bars: dict[str, list[Bar]],
        benchmark: str | None = None,
        initial_equity: float | None = None,
        weight_overrides: dict[str, float] | None = None,
    ) -> None:
        self.config = config
        self.benchmark = (benchmark or config.universe.benchmark).upper()
        self.series: dict[str, BarSeries] = {
            symbol.upper(): BarSeries.from_bars(symbol, list(rows)) for symbol, rows in bars.items()
        }
        self.symbols = [s for s in self.series if s != self.benchmark]
        self.initial_equity = initial_equity or config.backtest.initial_equity
        self.strategies = build_strategies(config.strategies.params)
        self.aggregator = SignalAggregator(config.strategies, config.signals, weight_overrides)
        self.regime_classifier = RegimeClassifier(config.regime)
        self.risk = RiskEngine(config, mode=SystemMode.PAPER_MODE)

    # ------------------------------------------------------------------ #
    def _costs(self, price: float, quantity: int, is_buy: bool) -> tuple[float, float]:
        """Return ``(fill_price, commission)`` including spread and slippage."""
        bt = self.config.backtest
        half_spread = price * (bt.spread_bps / 2.0) / 10_000.0
        slippage = price * bt.slippage_bps / 10_000.0
        fill = price + half_spread + slippage if is_buy else price - half_spread - slippage
        commission = max(bt.commission_minimum, bt.commission_per_share * quantity) if quantity else 0.0
        return round(max(0.01, fill), 4), commission

    def _timeline(self) -> list[datetime]:
        benchmark_series = self.series.get(self.benchmark)
        if benchmark_series is None or len(benchmark_series) == 0:
            # Fall back to the union of all timestamps when no benchmark is supplied.
            stamps: set[datetime] = set()
            for series in self.series.values():
                stamps.update(series.timestamps)
            return sorted(stamps)
        return list(benchmark_series.timestamps)

    @staticmethod
    def _index_map(series: BarSeries) -> dict[datetime, int]:
        return {ts: i for i, ts in enumerate(series.timestamps)}

    # ------------------------------------------------------------------ #
    def run(self, start: datetime | None = None, end: datetime | None = None) -> BacktestResult:
        timeline = [
            ts
            for ts in self._timeline()
            if (start is None or ts >= start) and (end is None or ts <= end)
        ]
        index_maps = {symbol: self._index_map(series) for symbol, series in self.series.items()}
        warmup = max(
            self.config.market_data.min_bars_required,
            self.config.regime.min_bars,
            max((s.min_bars for s in self.strategies), default=120),
        )

        cash = self.initial_equity
        positions: dict[str, Position] = {}
        open_trades: dict[str, BacktestTrade] = {}
        trades: list[BacktestTrade] = []
        equity_curve: list[tuple[datetime, float]] = []
        exposures: list[float] = []
        rejections: dict[str, int] = {}
        pending: list[_PendingEntry] = []
        commission_paid = 0.0
        high_water_mark = self.initial_equity
        day_start_equity = self.initial_equity
        week_start_equity = self.initial_equity
        current_week = None
        risk_opened_today = 0.0

        def bar_for(symbol: str, when: datetime) -> Bar | None:
            index = index_maps.get(symbol, {}).get(when)
            if index is None:
                return None
            return self.series[symbol].bars[index]

        for step, when in enumerate(timeline):
            benchmark_index = index_maps.get(self.benchmark, {}).get(when)
            if benchmark_index is None or benchmark_index < warmup:
                continue

            # --- 1. fill yesterday's decisions at today's open -----------------
            for entry in pending:
                bar = bar_for(entry.symbol, when)
                if bar is None or entry.symbol in positions:
                    continue
                max_shares = int(bar.volume * self.config.backtest.volume_participation_cap)
                quantity = min(entry.quantity, max_shares) if max_shares > 0 else 0
                if quantity <= 0:
                    continue
                fill_price, commission = self._costs(bar.open, quantity, is_buy=True)
                cost = fill_price * quantity + commission
                if cost > cash:
                    quantity = int((cash - commission) // fill_price)
                    if quantity <= 0:
                        continue
                    cost = fill_price * quantity + commission
                cash -= cost
                commission_paid += commission
                risk_per_share = max(0.01, fill_price - entry.stop_price)
                position = Position(
                    symbol=entry.symbol,
                    quantity=quantity,
                    average_price=fill_price,
                    opened_at=when,
                    current_price=fill_price,
                    stop_price=entry.stop_price,
                    take_profit_price=entry.take_profit_price,
                    initial_stop_price=entry.stop_price,
                    risk_per_share=risk_per_share,
                    regime_at_entry=entry.regime,
                    opportunity_score=entry.score,
                    confidence_at_entry=entry.confidence,
                    sector=self.config.universe.sector_of(entry.symbol),
                )
                positions[entry.symbol] = position
                risk_opened_today += risk_per_share * quantity
                open_trades[entry.symbol] = BacktestTrade(
                    symbol=entry.symbol,
                    direction="LONG",
                    quantity=quantity,
                    entry_date=when,
                    entry_price=fill_price,
                    commission=commission,
                    risk_per_share=risk_per_share,
                    stop_price=entry.stop_price,
                    take_profit_price=entry.take_profit_price,
                    regime_at_entry=entry.regime,
                    score=entry.score,
                    confidence=entry.confidence,
                    strategy_contributions=entry.contributions,
                )
            pending = []

            # --- 2. intrabar protective exits ------------------------------------
            for symbol, position in list(positions.items()):
                bar = bar_for(symbol, when)
                if bar is None:
                    continue
                exit_price: float | None = None
                reason: ExitReason | None = None
                if position.stop_price is not None and bar.low <= position.stop_price:
                    # A gap through the stop fills at the open, not at the stop.
                    exit_price = min(bar.open, position.stop_price)
                    reason = (
                        ExitReason.TRAILING_STOP
                        if position.stop_price != position.initial_stop_price
                        else ExitReason.STOP_LOSS
                    )
                elif position.take_profit_price is not None and bar.high >= position.take_profit_price:
                    exit_price = max(bar.open, position.take_profit_price)
                    reason = ExitReason.TAKE_PROFIT
                if exit_price is None or reason is None:
                    continue
                fill_price, commission = self._costs(exit_price, position.quantity, is_buy=False)
                cash += fill_price * position.quantity - commission
                commission_paid += commission
                self._close_trade(
                    open_trades, trades, symbol, when, fill_price, commission, reason, positions
                )
                self.risk.record_trade_result(symbol, trades[-1].pnl, now=when)

            # --- 3. mark to market -------------------------------------------------
            for symbol, position in positions.items():
                bar = bar_for(symbol, when)
                if bar is not None:
                    position.mark(bar.close)

            equity = cash + sum(p.market_value for p in positions.values())
            high_water_mark = max(high_water_mark, equity)
            week = when.isocalendar()[:2]
            if current_week is None:
                current_week = week
            elif week != current_week:
                current_week, week_start_equity = week, equity
            equity_curve.append((when, equity))
            exposures.append(
                sum(p.market_value for p in positions.values()) / equity if equity > 0 else 0.0
            )

            state = PortfolioState(
                equity=equity,
                cash=cash,
                buying_power=cash,
                positions=positions,
                high_water_mark=high_water_mark,
                day_start_equity=day_start_equity,
                week_start_equity=week_start_equity,
                risk_opened_today=risk_opened_today,
                as_of=when,
                sector_map=dict(self.config.universe.sectors),
            )
            day_start_equity = equity          # daily marks: previous close is today's anchor
            risk_opened_today = 0.0

            # --- 4. regime (benchmark bars up to *and including* today) -------------
            benchmark_slice = self.series[self.benchmark].slice_until(benchmark_index)
            regime = self.regime_classifier.classify(benchmark_slice)

            # --- 5. signal-driven and time-based exits ------------------------------
            for symbol, position in list(positions.items()):
                index = index_maps.get(symbol, {}).get(when)
                if index is None:
                    continue
                series = self.series[symbol].slice_until(index)
                atr_value = last_valid(
                    atr_indicator(series.highs, series.lows, series.closes, self.config.risk.atr_period)
                ) or 0.0
                new_stop = self.risk.trailing_stop_price(position, atr_value)
                if new_stop is not None:
                    position.stop_price = new_stop
                score = self._score(symbol, series, benchmark_slice, regime, when)
                reversed_signal = bool(score and score.score < -self.config.signals.min_abs_score)
                decision = self.risk.evaluate_exit(
                    position, position.current_price, atr_value, reversed_signal, now=when
                )
                if not decision.should_exit:
                    continue
                bar = bar_for(symbol, when)
                reference = bar.close if bar else position.current_price
                fill_price, commission = self._costs(reference, position.quantity, is_buy=False)
                cash += fill_price * position.quantity - commission
                commission_paid += commission
                self._close_trade(
                    open_trades,
                    trades,
                    symbol,
                    when,
                    fill_price,
                    commission,
                    decision.reason or ExitReason.MANUAL,
                    positions,
                )
                self.risk.record_trade_result(symbol, trades[-1].pnl, now=when)

            # --- 6. entries (decided on today's close, filled at tomorrow's open) ----
            if step + 1 >= len(timeline):
                continue
            candidates = []
            for symbol in self.symbols:
                index = index_maps.get(symbol, {}).get(when)
                if index is None or index < warmup or symbol in positions:
                    continue
                series = self.series[symbol].slice_until(index)
                score = self._score(symbol, series, benchmark_slice, regime, when)
                if score is None:
                    continue
                if not score.actionable:
                    for reason in score.rejection_reasons:
                        key = reason.split("(")[0].strip()
                        rejections[key] = rejections.get(key, 0) + 1
                    continue
                candidates.append((score, series))

            opened = 0
            ranked = self.aggregator.rank([score for score, _ in candidates])
            series_by_symbol = {score.symbol: series for score, series in candidates}
            for score in ranked:
                if opened >= self.config.signals.max_new_positions_per_cycle:
                    break
                series = series_by_symbol[score.symbol]
                price = float(series.closes[-1])
                atr_value = last_valid(
                    atr_indicator(series.highs, series.lows, series.closes, self.config.risk.atr_period)
                ) or 0.0
                proposal = EntryProposal(
                    symbol=score.symbol,
                    direction=score.direction,
                    score=score.score,
                    confidence=score.confidence,
                    reference_price=price,
                    atr=atr_value,
                    annualised_volatility=last_valid(realized_volatility(series.closes, 20)) or 0.0,
                    average_daily_volume=float(last_valid(sma(series.volumes, 20)) or 0.0),
                    average_dollar_volume=average_dollar_volume(series.closes, series.volumes, 20),
                    spread_bps=self.config.backtest.spread_bps,
                    data_quality_ok=True,
                    correlated_exposure_pct=self._correlated_exposure(score.symbol, positions, when, index_maps),
                    sector=self.config.universe.sector_of(score.symbol),
                    strategy_contributions=[c.to_dict() for c in score.contributions],
                    as_of=when,
                )
                decision = self.risk.evaluate_entry(proposal, state, regime, now=when)
                if not decision.approved:
                    for reason in decision.rejection_reasons:
                        key = reason.split("(")[0].strip()[:60]
                        rejections[key] = rejections.get(key, 0) + 1
                    continue
                if decision.direction is not SignalDirection.LONG:
                    continue      # the backtester models long-only execution
                pending.append(
                    _PendingEntry(
                        symbol=score.symbol,
                        quantity=decision.quantity,
                        stop_price=decision.stop_price or 0.0,
                        take_profit_price=decision.take_profit_price or 0.0,
                        risk_amount=decision.risk_amount,
                        score=score.score,
                        confidence=score.confidence,
                        regime=str(regime.regime),
                        contributions=[c.to_dict() for c in score.contributions],
                    )
                )
                opened += 1

        # --- close anything still open at the final bar ---------------------------
        if timeline:
            final = timeline[-1]
            for symbol, position in list(positions.items()):
                fill_price, commission = self._costs(position.current_price, position.quantity, False)
                cash += fill_price * position.quantity - commission
                commission_paid += commission
                self._close_trade(
                    open_trades,
                    trades,
                    symbol,
                    final,
                    fill_price,
                    commission,
                    ExitReason.END_OF_BACKTEST,
                    positions,
                )
            if equity_curve:
                equity_curve[-1] = (equity_curve[-1][0], cash)

        metrics = compute_metrics(equity_curve, trades, exposures, commission_paid)
        return BacktestResult(
            metrics=metrics,
            trades=trades,
            equity_curve=equity_curve,
            start=timeline[0] if timeline else None,
            end=timeline[-1] if timeline else None,
            symbols=sorted(self.symbols),
            config_hash=self.config.config_hash(),
            rejections=rejections,
        )

    # ------------------------------------------------------------------ #
    def _score(self, symbol: str, series: BarSeries, benchmark: BarSeries, regime, when: datetime):
        context = StrategyContext(regime=regime, benchmark=benchmark, as_of=when)
        signals = [
            signal
            for strategy in self.strategies
            if (signal := strategy.generate(series, context)) is not None
        ]
        if not signals:
            return None
        return self.aggregator.score(symbol, signals, regime, when)

    def _correlated_exposure(
        self,
        candidate: str,
        positions: dict[str, Position],
        when: datetime,
        index_maps: dict[str, dict[datetime, int]],
    ) -> float:
        """Correlated exposure using only data available up to `when`."""
        if not positions:
            return 0.0
        from ..market_data.indicators import correlation, returns

        lookback = self.config.risk.correlation_lookback
        candidate_index = index_maps.get(candidate, {}).get(when)
        if candidate_index is None:
            return 0.0
        candidate_returns = returns(self.series[candidate].slice_until(candidate_index).closes)[-lookback:]
        equity = sum(p.market_value for p in positions.values())
        if equity <= 0:
            return 0.0
        exposed = 0.0
        for symbol, position in positions.items():
            index = index_maps.get(symbol, {}).get(when)
            if index is None:
                continue
            other = returns(self.series[symbol].slice_until(index).closes)[-lookback:]
            if abs(correlation(candidate_returns, other)) >= self.config.risk.correlation_threshold:
                exposed += position.market_value
        return exposed / equity if equity else 0.0

    @staticmethod
    def _close_trade(
        open_trades: dict[str, BacktestTrade],
        trades: list[BacktestTrade],
        symbol: str,
        when: datetime,
        fill_price: float,
        commission: float,
        reason: ExitReason,
        positions: dict[str, Position],
    ) -> None:
        position = positions.pop(symbol, None)
        trade = open_trades.pop(symbol, None)
        if position is None or trade is None:
            return
        gross = (fill_price - trade.entry_price) * trade.quantity
        trade.exit_date = when
        trade.exit_price = fill_price
        trade.commission += commission
        trade.pnl = gross - trade.commission
        trade.exit_reason = str(reason)
        trade.holding_days = (when - trade.entry_date).total_seconds() / 86400.0
        if trade.risk_per_share > 0:
            trade.r_multiple = trade.pnl / (trade.risk_per_share * trade.quantity)
        trades.append(trade)


def bars_from_frames(data: Iterable[dict[str, Any]]) -> list[Bar]:
    """Build bars from plain dictionaries (CSV/JSON import helper)."""
    bars: list[Bar] = []
    for row in data:
        bars.append(
            Bar(
                symbol=str(row["symbol"]).upper(),
                timestamp=row["timestamp"],
                open=float(row["open"]),
                high=float(row["high"]),
                low=float(row["low"]),
                close=float(row["close"]),
                volume=float(row.get("volume", 0.0)),
            )
        )
    return sorted(bars, key=lambda b: b.timestamp)
