"""Strategy behaviour: direction, normalisation and refusal to over-claim."""

from __future__ import annotations

import numpy as np
import pytest

from algotrader.enums import Regime, VolatilityRegime
from algotrader.market_data.series import BarSeries
from algotrader.regime.classifier import RegimeState
from algotrader.strategy import build_strategies
from algotrader.strategy.base import StrategyContext
from algotrader.strategy.breakout import BreakoutStrategy
from algotrader.strategy.mean_reversion import MeanReversionStrategy
from algotrader.strategy.momentum import MomentumStrategy
from algotrader.strategy.relative_strength import RelativeStrengthStrategy
from algotrader.strategy.trend_following import TrendFollowingStrategy
from tests.conftest import make_bars


def series_from(closes, symbol="TEST", volume=5_000_000.0):
    return BarSeries.from_bars(symbol, make_bars(symbol, list(closes), volume=volume))


def neutral_regime(regime=Regime.BULL_TREND, vol=VolatilityRegime.NORMAL):
    return RegimeState(
        regime=regime,
        volatility_regime=vol,
        trend_regime=Regime.BULL_TREND,
        confidence=80.0,
        trend_strength=0.5,
        realized_vol=0.15,
        long_run_vol=0.15,
        benchmark_drawdown=0.01,
        atr_pct=0.015,
        symbol="SPY",
    )


def context(benchmark=None, regime=None):
    return StrategyContext(regime=regime or neutral_regime(), benchmark=benchmark)


UPTREND = list(100 * np.exp(np.linspace(0, 0.45, 300)))
DOWNTREND = list(100 * np.exp(np.linspace(0.45, 0, 300)))
FLAT = list(100 + np.sin(np.linspace(0, 30, 300)) * 0.5)


def test_all_strategies_return_normalised_signals():
    strategies = build_strategies()
    bench = series_from(UPTREND, "SPY")
    for strategy in strategies:
        signal = strategy.generate(series_from(UPTREND), context(benchmark=bench))
        if signal is None:
            continue
        assert -1.0 <= signal.value <= 1.0
        assert 0.0 <= signal.confidence <= 100.0
        assert signal.rationale, f"{strategy.name} must explain itself"


def test_strategies_refuse_when_history_is_too_short():
    short = series_from([100.0] * 30)
    for strategy in build_strategies():
        assert strategy.generate(short, context()) is None


def test_trend_following_direction():
    strategy = TrendFollowingStrategy()
    assert strategy.generate(series_from(UPTREND), context()).value > 0.3
    assert strategy.generate(series_from(DOWNTREND), context()).value < -0.3


def test_trend_following_is_muted_in_flat_market():
    signal = TrendFollowingStrategy().generate(series_from(FLAT), context())
    assert abs(signal.value) < 0.2


def test_momentum_direction_and_confirmation():
    strategy = MomentumStrategy()
    assert strategy.generate(series_from(UPTREND), context()).value > 0.3
    assert strategy.generate(series_from(DOWNTREND), context()).value < -0.3


def test_breakout_requires_an_actual_breakout():
    strategy = BreakoutStrategy()
    inside = strategy.generate(series_from(FLAT), context())
    assert inside.value == 0.0 and inside.confidence < 25
    breaking_out = list(FLAT[:-1]) + [130.0]
    signal = strategy.generate(series_from(breaking_out), context())
    assert signal.value > 0 and signal.rationale["state"] == "upside_breakout"


def test_breakout_volume_confirmation_raises_confidence():
    closes = list(FLAT[:-1]) + [130.0]
    low_volume = series_from(closes, volume=1_000_000.0)
    bars = list(low_volume.bars)
    strategy = BreakoutStrategy()
    unconfirmed = strategy.generate(BarSeries.from_bars("TEST", bars), context())
    # Same prices, final bar with 5x volume.
    from dataclasses import replace

    bars[-1] = replace(bars[-1], volume=5_000_000.0)
    confirmed = strategy.generate(BarSeries.from_bars("TEST", bars), context())
    assert confirmed.confidence > unconfirmed.confidence
    assert confirmed.rationale["volume_confirmed"] is True


def test_mean_reversion_will_not_catch_a_falling_knife():
    """An oversold reading below the long-term trend must not produce a buy."""
    closes = list(np.linspace(200, 100, 300))  # relentless downtrend, deeply oversold
    signal = MeanReversionStrategy().generate(series_from(closes), context())
    assert signal.value <= 0.0
    assert signal.rationale["state"] in {
        "oversold_but_below_trend_filter",
        "neutral",
    }


def test_mean_reversion_buys_a_dip_inside_an_uptrend():
    closes = list(100 * np.exp(np.linspace(0, 0.6, 295)))
    closes += [closes[-1] * m for m in (0.94, 0.90, 0.87, 0.85, 0.83)]
    signal = MeanReversionStrategy().generate(series_from(closes), context())
    assert signal.value > 0
    assert signal.rationale["state"] == "oversold_pullback_in_uptrend"


def test_relative_strength_compares_against_benchmark():
    strong = series_from(list(100 * np.exp(np.linspace(0, 0.6, 300))), "STRONG")
    weak = series_from(list(100 * np.exp(np.linspace(0, 0.05, 300))), "WEAK")
    bench = series_from(list(100 * np.exp(np.linspace(0, 0.3, 300))), "SPY")
    strategy = RelativeStrengthStrategy()
    assert strategy.generate(strong, context(benchmark=bench)).value > 0
    assert strategy.generate(weak, context(benchmark=bench)).value < 0


def test_relative_strength_needs_a_benchmark():
    assert RelativeStrengthStrategy().generate(series_from(UPTREND), context()) is None


def test_strategy_exceptions_are_contained():
    class Exploding(TrendFollowingStrategy):
        def _evaluate(self, series, context):
            raise ValueError("boom")

    assert Exploding().generate(series_from(UPTREND), context()) is None
