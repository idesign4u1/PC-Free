"""Trend following: price above a rising moving-average structure."""

from __future__ import annotations

import numpy as np

from ..market_data.indicators import atr, clamp, ema, last_valid, linreg_slope, scale_to_unit
from ..market_data.series import BarSeries
from .base import Signal, Strategy, StrategyContext


class TrendFollowingStrategy(Strategy):
    name = "trend_following"
    default_params = {
        "fast_ma": 20,
        "slow_ma": 100,
        "atr_period": 14,
        "slope_lookback": 20,
        "min_bars": 120,
        "spread_saturation": 0.05,
        "slope_saturation": 0.40,
        "distance_saturation": 0.10,
    }

    def _evaluate(self, series: BarSeries, context: StrategyContext) -> Signal | None:
        p = self.params
        closes = series.closes
        fast = last_valid(ema(closes, int(p["fast_ma"])))
        slow = last_valid(ema(closes, int(p["slow_ma"])))
        slope = last_valid(linreg_slope(closes, int(p["slope_lookback"])))
        atr_value = last_valid(atr(series.highs, series.lows, closes, int(p["atr_period"])))
        if fast is None or slow is None or slope is None or slow <= 0:
            return None

        price = float(closes[-1])
        ma_spread = (fast - slow) / slow
        distance = (price - slow) / slow

        components = {
            "ma_spread": scale_to_unit(ma_spread, float(p["spread_saturation"])),
            "slope": scale_to_unit(slope, float(p["slope_saturation"])),
            "distance_from_slow": scale_to_unit(distance, float(p["distance_saturation"])),
        }
        value = clamp(float(np.mean(list(components.values()))))

        signs = [np.sign(v) for v in components.values() if v != 0]
        agreement = abs(sum(signs)) / len(signs) if signs else 0.0
        confidence = 100.0 * (0.55 * agreement + 0.45 * min(1.0, abs(value) / 0.6))
        # An overextended move is a worse entry, not a better one.
        if atr_value and atr_value > 0:
            stretch = abs(price - slow) / atr_value
            if stretch > 6.0:
                confidence *= 0.7
        return self._signal(
            series,
            value,
            confidence,
            {
                "price": round(price, 4),
                "fast_ema": round(fast, 4),
                "slow_ema": round(slow, 4),
                "annualised_slope": round(slope, 4),
                "components": {k: round(v, 4) for k, v in components.items()},
                "explanation": "long when price leads a rising fast/slow EMA structure",
            },
            atr_value,
        )
