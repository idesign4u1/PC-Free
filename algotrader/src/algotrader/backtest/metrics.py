"""Performance metrics.

Definitions (all computed from daily marks, risk-free rate assumed 0):

    total return   final / initial - 1
    CAGR           (final / initial) ** (1 / years) - 1
    Sharpe         mean(daily) / std(daily) * sqrt(252)
    Sortino        mean(daily) / std(negative daily) * sqrt(252)
    Calmar         CAGR / max drawdown
    expectancy     average P&L per closed trade (also reported in R)
    profit factor  gross profit / gross loss
    exposure       average gross exposure as a fraction of equity
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Any, Sequence

import numpy as np

TRADING_DAYS = 252


@dataclass
class PerformanceMetrics:
    initial_equity: float = 0.0
    final_equity: float = 0.0
    total_return: float = 0.0
    cagr: float = 0.0
    sharpe: float = 0.0
    sortino: float = 0.0
    calmar: float = 0.0
    max_drawdown: float = 0.0
    volatility: float = 0.0
    trades: int = 0
    wins: int = 0
    losses: int = 0
    win_rate: float = 0.0
    profit_factor: float = 0.0
    expectancy: float = 0.0
    expectancy_r: float = 0.0
    average_win: float = 0.0
    average_loss: float = 0.0
    largest_win: float = 0.0
    largest_loss: float = 0.0
    average_holding_days: float = 0.0
    exposure: float = 0.0
    commission_paid: float = 0.0
    days: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {k: (round(v, 6) if isinstance(v, float) else v) for k, v in asdict(self).items()}


def _daily_returns(equity: Sequence[float]) -> np.ndarray:
    arr = np.asarray(equity, dtype=float)
    if arr.size < 2:
        return np.array([])
    with np.errstate(divide="ignore", invalid="ignore"):
        rets = np.where(arr[:-1] > 0, arr[1:] / arr[:-1] - 1.0, 0.0)
    return rets[np.isfinite(rets)]


def max_drawdown(equity: Sequence[float]) -> float:
    arr = np.asarray(equity, dtype=float)
    if arr.size == 0:
        return 0.0
    peaks = np.maximum.accumulate(arr)
    with np.errstate(divide="ignore", invalid="ignore"):
        drawdowns = np.where(peaks > 0, (peaks - arr) / peaks, 0.0)
    return float(np.nanmax(drawdowns))


def compute_metrics(
    equity_curve: Sequence[tuple[datetime, float]],
    trades: Sequence[Any] = (),
    exposures: Sequence[float] = (),
    commission_paid: float = 0.0,
) -> PerformanceMetrics:
    if not equity_curve:
        return PerformanceMetrics()

    # Plain floats only: these metrics are serialised into JSON responses.
    equity = [float(value) for _, value in equity_curve]
    timestamps = [ts for ts, _ in equity_curve]
    initial, final = equity[0], equity[-1]
    days = max(1, (timestamps[-1] - timestamps[0]).days)
    years = days / 365.25

    returns = _daily_returns(equity)
    volatility = float(returns.std(ddof=1) * np.sqrt(TRADING_DAYS)) if returns.size > 1 else 0.0
    sharpe = 0.0
    if returns.size > 1 and returns.std(ddof=1) > 0:
        sharpe = float(returns.mean() / returns.std(ddof=1) * np.sqrt(TRADING_DAYS))
    downside = returns[returns < 0]
    sortino = 0.0
    if downside.size > 1 and downside.std(ddof=1) > 0:
        sortino = float(returns.mean() / downside.std(ddof=1) * np.sqrt(TRADING_DAYS))

    total_return = (final / initial - 1.0) if initial > 0 else 0.0
    cagr = ((final / initial) ** (1 / years) - 1.0) if initial > 0 and years > 0 and final > 0 else 0.0
    drawdown = max_drawdown(equity)
    calmar = (cagr / drawdown) if drawdown > 0 else 0.0

    pnls = [float(getattr(t, "pnl", 0.0)) for t in trades]
    r_multiples = [
        float(getattr(t, "r_multiple", 0.0)) for t in trades if getattr(t, "r_multiple", None) is not None
    ]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    gross_profit = sum(wins)
    gross_loss = abs(sum(losses))
    holding = [float(getattr(t, "holding_days", 0.0)) for t in trades]

    return PerformanceMetrics(
        initial_equity=initial,
        final_equity=final,
        total_return=float(total_return),
        cagr=float(cagr),
        sharpe=sharpe,
        sortino=sortino,
        calmar=calmar,
        max_drawdown=drawdown,
        volatility=volatility,
        trades=len(pnls),
        wins=len(wins),
        losses=len(losses),
        win_rate=len(wins) / len(pnls) if pnls else 0.0,
        profit_factor=(gross_profit / gross_loss) if gross_loss > 0 else (
            float("inf") if gross_profit > 0 else 0.0
        ),
        expectancy=(sum(pnls) / len(pnls)) if pnls else 0.0,
        expectancy_r=(sum(r_multiples) / len(r_multiples)) if r_multiples else 0.0,
        average_win=(gross_profit / len(wins)) if wins else 0.0,
        average_loss=(-gross_loss / len(losses)) if losses else 0.0,
        largest_win=max(wins) if wins else 0.0,
        largest_loss=min(losses) if losses else 0.0,
        average_holding_days=(sum(holding) / len(holding)) if holding else 0.0,
        exposure=float(np.mean(exposures)) if len(exposures) else 0.0,
        commission_paid=commission_paid,
        days=days,
    )
