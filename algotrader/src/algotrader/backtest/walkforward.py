"""Walk-forward and out-of-sample validation.

A single backtest over one period proves very little. Walk-forward analysis
repeatedly selects a configuration on an in-sample window and then measures it
on the *following*, untouched window. Only the out-of-sample results are
aggregated - that is the number worth quoting.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Sequence

from ..broker.base import Bar
from ..config import AppConfig
from ..logging_setup import get_logger
from .engine import BacktestEngine, BacktestResult
from .metrics import PerformanceMetrics, compute_metrics

log = get_logger(__name__)


@dataclass
class Fold:
    index: int
    train_start: datetime
    train_end: datetime
    test_start: datetime
    test_end: datetime
    selected_weights: dict[str, float] = field(default_factory=dict)
    in_sample: PerformanceMetrics | None = None
    out_of_sample: PerformanceMetrics | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "train": [self.train_start.isoformat(), self.train_end.isoformat()],
            "test": [self.test_start.isoformat(), self.test_end.isoformat()],
            "selected_weights": self.selected_weights,
            "in_sample": self.in_sample.to_dict() if self.in_sample else None,
            "out_of_sample": self.out_of_sample.to_dict() if self.out_of_sample else None,
        }


@dataclass
class WalkForwardResult:
    folds: list[Fold]
    aggregate_out_of_sample: PerformanceMetrics
    efficiency: float           # OOS return / IS return - below ~0.5 suggests overfitting
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "folds": [fold.to_dict() for fold in self.folds],
            "aggregate_out_of_sample": self.aggregate_out_of_sample.to_dict(),
            "walk_forward_efficiency": round(self.efficiency, 4),
            "notes": self.notes,
        }


def _timeline(bars: dict[str, list[Bar]], benchmark: str) -> list[datetime]:
    series = bars.get(benchmark.upper())
    if series:
        return sorted(bar.timestamp for bar in series)
    stamps: set[datetime] = set()
    for rows in bars.values():
        stamps.update(bar.timestamp for bar in rows)
    return sorted(stamps)


def walk_forward(
    config: AppConfig,
    bars: dict[str, list[Bar]],
    benchmark: str | None = None,
    train_days: int = 365,
    test_days: int = 90,
    candidate_weights: Sequence[dict[str, float]] | None = None,
    min_warmup_days: int = 300,
) -> WalkForwardResult:
    """Roll a train/test window forward, selecting weights in-sample only."""
    benchmark = (benchmark or config.universe.benchmark).upper()
    timeline = _timeline(bars, benchmark)
    if not timeline:
        return WalkForwardResult([], compute_metrics([]), 0.0, ["no data supplied"])

    candidates: list[dict[str, float]] = list(candidate_weights or [dict(config.strategies.weights)])
    start, end = timeline[0], timeline[-1]
    folds: list[Fold] = []
    notes: list[str] = []

    # Every window needs indicator warm-up before its own evaluation period.
    train_start = start
    index = 0
    while True:
        train_end = train_start + timedelta(days=train_days)
        test_start = train_end
        test_end = test_start + timedelta(days=test_days)
        if test_end > end:
            break
        if (train_end - train_start).days < min_warmup_days:
            notes.append("training window shorter than the indicator warm-up period")

        best_weights = candidates[0]
        best_metrics: PerformanceMetrics | None = None
        for weights in candidates:
            engine = BacktestEngine(config, bars, benchmark=benchmark, weight_overrides=weights)
            result = engine.run(start=train_start, end=train_end)
            score = _selection_score(result)
            if best_metrics is None or score > _selection_score_from_metrics(best_metrics):
                best_metrics, best_weights = result.metrics, weights

        # Out-of-sample: the test window is run with data from the start so that
        # indicators are warm, but only the test period is measured.
        oos_engine = BacktestEngine(config, bars, benchmark=benchmark, weight_overrides=best_weights)
        oos_result = oos_engine.run(start=train_start, end=test_end)
        oos_metrics = _metrics_between(oos_result, test_start, test_end)

        folds.append(
            Fold(
                index=index,
                train_start=train_start,
                train_end=train_end,
                test_start=test_start,
                test_end=test_end,
                selected_weights=best_weights,
                in_sample=best_metrics,
                out_of_sample=oos_metrics,
            )
        )
        index += 1
        train_start = train_start + timedelta(days=test_days)

    if not folds:
        return WalkForwardResult(
            [], compute_metrics([]), 0.0, notes + ["not enough history for a single fold"]
        )

    combined_curve: list[tuple[datetime, float]] = []
    equity = config.backtest.initial_equity
    for fold in folds:
        if not fold.out_of_sample:
            continue
        growth = 1.0 + fold.out_of_sample.total_return
        combined_curve.append((fold.test_end, equity * growth))
        equity *= growth
    aggregate = compute_metrics([(folds[0].test_start, config.backtest.initial_equity)] + combined_curve)

    is_return = sum(fold.in_sample.total_return for fold in folds if fold.in_sample)
    oos_return = sum(fold.out_of_sample.total_return for fold in folds if fold.out_of_sample)
    efficiency = (oos_return / is_return) if is_return > 0 else 0.0
    if efficiency < 0.5:
        notes.append(
            "walk-forward efficiency below 0.5: out-of-sample results are materially "
            "worse than in-sample, which is the classic signature of overfitting"
        )
    return WalkForwardResult(folds, aggregate, efficiency, notes)


def _selection_score(result: BacktestResult) -> float:
    return _selection_score_from_metrics(result.metrics)


def _selection_score_from_metrics(metrics: PerformanceMetrics) -> float:
    """Prefer risk-adjusted return; penalise drawdown explicitly."""
    return metrics.sharpe - 2.0 * metrics.max_drawdown


def _metrics_between(result: BacktestResult, start: datetime, end: datetime) -> PerformanceMetrics:
    curve = [(ts, value) for ts, value in result.equity_curve if start <= ts <= end]
    trades = [
        trade
        for trade in result.trades
        if trade.exit_date and start <= trade.exit_date <= end
    ]
    return compute_metrics(curve, trades)
