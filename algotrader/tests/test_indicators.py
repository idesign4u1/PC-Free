"""Indicator correctness - including the no-look-ahead property."""

from __future__ import annotations

import numpy as np
import pytest

from algotrader.market_data import indicators as ind


def test_sma_matches_manual_mean():
    values = [1, 2, 3, 4, 5, 6]
    out = ind.sma(values, 3)
    assert np.isnan(out[:2]).all()
    assert out[2] == pytest.approx(2.0)
    assert out[-1] == pytest.approx(5.0)


def test_ema_converges_towards_price():
    values = [10.0] * 30 + [20.0] * 30
    out = ind.ema(values, 10)
    assert out[-1] > 19.0


def test_rsi_bounds_and_extremes():
    rising = list(np.linspace(10, 30, 60))
    falling = list(np.linspace(30, 10, 60))
    assert ind.rsi(rising, 14)[-1] > 95
    assert ind.rsi(falling, 14)[-1] < 5
    values = ind.rsi(list(np.random.default_rng(0).normal(100, 2, 200)), 14)
    finite = values[~np.isnan(values)]
    assert finite.min() >= 0 and finite.max() <= 100


def test_atr_is_positive_and_wilder_smoothed():
    high = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26]
    low = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]
    close = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]
    out = ind.atr(high, low, close, 14)
    assert np.isnan(out[12])
    assert out[-1] > 0


def test_donchian_channel_excludes_the_current_bar():
    """A breakout must be measured against *prior* bars only."""
    high = [10, 11, 12, 13, 50]
    low = [9, 10, 11, 12, 49]
    upper, lower = ind.donchian(high, low, 4)
    assert upper[4] == 13  # not 50
    assert lower[4] == 9


def test_linreg_slope_sign_follows_trend():
    up = list(np.exp(np.linspace(0, 0.5, 60)) * 100)
    down = list(np.exp(np.linspace(0.5, 0, 60)) * 100)
    assert ind.linreg_slope(up, 20)[-1] > 0
    assert ind.linreg_slope(down, 20)[-1] < 0


def test_realized_volatility_annualised():
    rng = np.random.default_rng(42)
    daily = rng.normal(0, 0.01, 300)
    prices = 100 * np.exp(np.cumsum(daily))
    vol = ind.realized_volatility(prices, 60)[-1]
    assert 0.10 < vol < 0.22  # ~1% daily -> ~16% annualised


def test_max_drawdown():
    assert ind.max_drawdown([100, 120, 90, 130]) == pytest.approx(0.25)
    assert ind.max_drawdown([100, 101, 102]) == pytest.approx(0.0)


def test_correlation_extremes():
    a = list(range(50))
    b = [x * 2 for x in a]
    c = [-x for x in a]
    assert ind.correlation(a, b) == pytest.approx(1.0)
    assert ind.correlation(a, c) == pytest.approx(-1.0)
    assert ind.correlation([1, 1, 1], [1, 2, 3]) == 0.0


def test_short_inputs_never_raise():
    for fn in (ind.sma, ind.ema, ind.rolling_std):
        assert np.isnan(fn([1.0], 14)).all()
    assert np.isnan(ind.rsi([1.0, 2.0], 14)).all()
    assert ind.average_dollar_volume([1.0], [1.0], 20) == 0.0


def test_scale_to_unit_saturates():
    assert ind.scale_to_unit(10, 2) == 1.0
    assert ind.scale_to_unit(-10, 2) == -1.0
    assert ind.scale_to_unit(1, 2) == pytest.approx(0.5)
