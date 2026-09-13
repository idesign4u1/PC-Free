"""Backtester: realism, cost handling and metric correctness."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from algotrader.backtest.engine import BacktestEngine
from algotrader.backtest.metrics import compute_metrics, max_drawdown
from algotrader.broker.base import Bar


def bars(symbol: str, closes: list[float], volume: float = 5_000_000.0, start: datetime | None = None):
    start = start or datetime(2023, 1, 2, tzinfo=timezone.utc)
    out: list[Bar] = []
    previous = closes[0]
    for i, close in enumerate(closes):
        out.append(
            Bar(
                symbol=symbol,
                timestamp=start + timedelta(days=i),
                open=previous,
                high=max(close, previous) * 1.004,
                low=min(close, previous) * 0.996,
                close=close,
                volume=volume,
            )
        )
        previous = close
    return out


TREND = list(100 * np.exp(np.linspace(0, 0.9, 600)))
BENCH = list(400 * np.exp(np.linspace(0, 0.25, 600)))


@pytest.fixture()
def backtest_config(config):
    universe = config.universe.model_copy(
        update={
            "symbols": ["AAA", "BBB"],
            "sectors": {"AAA": "technology", "BBB": "energy", "SPY": "index"},
            "benchmark": "SPY",
        }
    )
    return config.model_copy(update={"universe": universe})


def make_engine(backtest_config, **kwargs):
    data = {
        "AAA": bars("AAA", TREND),
        "BBB": bars("BBB", list(np.linspace(80, 60, 600))),
        "SPY": bars("SPY", BENCH),
    }
    return BacktestEngine(backtest_config, data, benchmark="SPY", **kwargs)


def test_backtest_runs_and_produces_metrics(backtest_config):
    result = make_engine(backtest_config).run()
    metrics = result.metrics
    assert metrics.initial_equity == pytest.approx(backtest_config.backtest.initial_equity)
    assert metrics.days > 200
    assert result.equity_curve
    for field in ("cagr", "sharpe", "sortino", "calmar", "max_drawdown", "win_rate", "profit_factor"):
        assert hasattr(metrics, field)


def test_backtest_takes_trades_in_a_trending_market(backtest_config):
    result = make_engine(backtest_config).run()
    assert result.trades, result.rejections
    assert all(trade.symbol == "AAA" for trade in result.trades), "the falling symbol must not be bought"


def test_every_trade_records_its_reasoning(backtest_config):
    result = make_engine(backtest_config).run()
    trade = result.trades[0]
    assert trade.regime_at_entry and trade.strategy_contributions
    assert trade.stop_price and trade.stop_price < trade.entry_price
    assert trade.exit_reason


def test_no_look_ahead_in_entries(backtest_config):
    """Entries fill at the *next* bar's open, never at the signal bar's close."""
    engine = make_engine(backtest_config)
    result = engine.run()
    index = {bar.timestamp: bar for bar in engine.series["AAA"].bars}
    for trade in result.trades:
        entry_bar = index[trade.entry_date]
        # The fill is the open plus costs, so it must sit at or above the open.
        assert trade.entry_price >= entry_bar.open - 1e-6


def test_costs_reduce_returns(backtest_config):
    cheap = backtest_config.model_copy(
        update={
            "backtest": backtest_config.backtest.model_copy(
                update={"slippage_bps": 0.0, "spread_bps": 0.0, "commission_per_share": 0.0}
            )
        }
    )
    expensive = backtest_config.model_copy(
        update={
            "backtest": backtest_config.backtest.model_copy(
                update={"slippage_bps": 50.0, "spread_bps": 20.0, "commission_per_share": 0.05}
            )
        }
    )
    cheap_result = make_engine(cheap).run()
    expensive_result = make_engine(expensive).run()
    assert expensive_result.metrics.final_equity < cheap_result.metrics.final_equity
    assert expensive_result.metrics.commission_paid > cheap_result.metrics.commission_paid


def test_stops_are_respected_on_a_crash(backtest_config):
    closes = list(100 * np.exp(np.linspace(0, 0.5, 400)))
    closes += list(np.linspace(closes[-1], closes[-1] * 0.55, 120))   # sustained collapse
    data = {
        "AAA": bars("AAA", closes),
        "SPY": bars("SPY", BENCH[: len(closes)]),
    }
    config = backtest_config.model_copy(
        update={
            "universe": backtest_config.universe.model_copy(
                update={"symbols": ["AAA"], "sectors": {"AAA": "technology", "SPY": "index"}}
            )
        }
    )
    result = BacktestEngine(config, data, benchmark="SPY").run()
    assert result.trades
    stopped = [t for t in result.trades if "STOP" in t.exit_reason]
    assert stopped, [t.exit_reason for t in result.trades]
    # The risk engine caps per-trade loss; a stopped trade should be near -1R.
    worst = min(t.r_multiple for t in result.trades if t.r_multiple is not None)
    assert worst > -2.5, f"a single trade lost {worst:.2f}R"


def test_risk_limits_bind_in_the_backtest(backtest_config):
    result = make_engine(backtest_config).run()
    equity = backtest_config.backtest.initial_equity
    per_trade_cap = backtest_config.risk.max_risk_per_trade_pct * equity
    for trade in result.trades:
        assert trade.risk_per_share * trade.quantity <= per_trade_cap * 1.35


def test_max_positions_never_exceeded(backtest_config):
    symbols = {f"S{i}": bars(f"S{i}", TREND) for i in range(12)}
    symbols["SPY"] = bars("SPY", BENCH)
    config = backtest_config.model_copy(
        update={
            "universe": backtest_config.universe.model_copy(
                update={
                    "symbols": [f"S{i}" for i in range(12)],
                    "sectors": {f"S{i}": f"sector{i}" for i in range(12)} | {"SPY": "index"},
                }
            )
        }
    )
    result = BacktestEngine(config, symbols, benchmark="SPY").run()
    # Reconstruct concurrent position counts from the trade list.
    events = []
    for trade in result.trades:
        events.append((trade.entry_date, 1))
        if trade.exit_date:
            events.append((trade.exit_date, -1))
    concurrent = peak = 0
    for _, delta in sorted(events, key=lambda e: e[0]):
        concurrent += delta
        peak = max(peak, concurrent)
    assert peak <= config.risk.max_open_positions


def test_empty_data_is_handled(backtest_config):
    result = BacktestEngine(backtest_config, {"SPY": bars("SPY", BENCH[:50])}, benchmark="SPY").run()
    assert result.trades == []
    assert result.metrics.trades == 0


# --------------------------------------------------------------------------- #
def test_metric_maths():
    start = datetime(2024, 1, 1, tzinfo=timezone.utc)
    curve = [(start + timedelta(days=i), 100_000 * (1.0004**i)) for i in range(366)]
    metrics = compute_metrics(curve)
    assert metrics.total_return == pytest.approx(0.1568, abs=0.01)
    assert metrics.cagr == pytest.approx(0.1568, abs=0.02)
    assert metrics.max_drawdown == pytest.approx(0.0, abs=1e-9)
    assert metrics.sharpe > 5     # a perfectly smooth curve


def test_max_drawdown_calculation():
    assert max_drawdown([100, 150, 75, 120]) == pytest.approx(0.5)


def test_metrics_with_trades():
    class T:
        def __init__(self, pnl, r, days):
            self.pnl, self.r_multiple, self.holding_days = pnl, r, days

    start = datetime(2024, 1, 1, tzinfo=timezone.utc)
    curve = [(start + timedelta(days=i), 100_000 + i * 10) for i in range(100)]
    trades = [T(500, 1.5, 5), T(-200, -1.0, 3), T(300, 1.0, 8)]
    metrics = compute_metrics(curve, trades, exposures=[0.3] * 100)
    assert metrics.trades == 3 and metrics.wins == 2 and metrics.losses == 1
    assert metrics.win_rate == pytest.approx(2 / 3)
    assert metrics.profit_factor == pytest.approx(4.0)
    assert metrics.expectancy == pytest.approx(200.0)
    assert metrics.expectancy_r == pytest.approx(0.5)
    assert metrics.exposure == pytest.approx(0.3)
