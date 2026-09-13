"""Regime classification."""

from __future__ import annotations

import numpy as np

from algotrader.enums import Regime, VolatilityRegime
from algotrader.market_data.series import BarSeries
from algotrader.regime import RegimeClassifier
from tests.conftest import make_bars


def series(closes, symbol="SPY"):
    return BarSeries.from_bars(symbol, make_bars(symbol, list(closes)))


def test_bull_trend(config):
    closes = 100 * np.exp(np.linspace(0, 0.35, 400))
    state = RegimeClassifier(config.regime).classify(series(closes))
    assert state.regime is Regime.BULL_TREND
    assert state.trend_strength > 0
    assert state.confidence > 40


def test_bear_trend(config):
    closes = 100 * np.exp(np.linspace(0.35, 0, 400))
    state = RegimeClassifier(config.regime).classify(series(closes))
    assert state.regime in (Regime.BEAR_TREND, Regime.RISK_OFF)
    assert state.trend_strength < 0


def test_sideways_low_volatility(config):
    rng = np.random.default_rng(7)
    closes = 100 + rng.normal(0, 0.15, 400).cumsum() * 0.1
    state = RegimeClassifier(config.regime).classify(series(closes))
    assert state.regime in (Regime.SIDEWAYS, Regime.LOW_VOLATILITY)
    assert state.volatility_regime in (VolatilityRegime.LOW, VolatilityRegime.NORMAL)


def test_crash_is_risk_off(config):
    calm = list(100 + np.linspace(0, 10, 350))
    crash = [calm[-1] * m for m in np.linspace(0.98, 0.72, 50)]
    state = RegimeClassifier(config.regime).classify(series(calm + crash))
    assert state.regime is Regime.RISK_OFF
    assert state.benchmark_drawdown > config.regime.risk_off_drawdown


def test_high_volatility_regime(config):
    rng = np.random.default_rng(3)
    closes = 100 * np.exp(np.cumsum(rng.normal(0.0006, 0.035, 400)))
    state = RegimeClassifier(config.regime).classify(series(closes))
    assert state.volatility_regime in (VolatilityRegime.HIGH, VolatilityRegime.EXTREME)
    assert state.regime in (Regime.HIGH_VOLATILITY, Regime.RISK_OFF)


def test_insufficient_history_defaults_to_defensive(config):
    state = RegimeClassifier(config.regime).classify(series([100.0] * 50))
    assert state.sufficient_data is False
    assert state.regime is Regime.HIGH_VOLATILITY
    assert state.confidence == 0.0
