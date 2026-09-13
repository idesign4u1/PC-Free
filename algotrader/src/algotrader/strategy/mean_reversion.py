"""Mean reversion - pullbacks *within* a trend, never falling-knife catching."""

from __future__ import annotations

import numpy as np

from ..market_data.indicators import atr, bollinger, clamp, last_valid, rsi, sma
from ..market_data.series import BarSeries
from .base import Signal, Strategy, StrategyContext


class MeanReversionStrategy(Strategy):
    name = "mean_reversion"
    default_params = {
        "rsi_period": 14,
        "rsi_oversold": 25.0,
        "rsi_overbought": 75.0,
        "bb_period": 20,
        "bb_stdev": 2.0,
        "trend_filter_ma": 200,
        "min_bars": 210,
    }

    def _evaluate(self, series: BarSeries, context: StrategyContext) -> Signal | None:
        p = self.params
        closes = series.closes
        rsi_value = last_valid(rsi(closes, int(p["rsi_period"])))
        lower, middle, upper = bollinger(closes, int(p["bb_period"]), float(p["bb_stdev"]))
        trend_ma = last_valid(sma(closes, int(p["trend_filter_ma"])))
        atr_value = last_valid(atr(series.highs, series.lows, closes, 14))
        if rsi_value is None or trend_ma is None or np.isnan(lower[-1]) or np.isnan(upper[-1]):
            return None

        price = float(closes[-1])
        band_width = float(upper[-1] - lower[-1])
        if band_width <= 0:
            return None
        band_position = (price - float(lower[-1])) / band_width  # 0 = lower band, 1 = upper band
        above_trend = price > trend_ma
        oversold = float(p["rsi_oversold"])
        overbought = float(p["rsi_overbought"])

        value = 0.0
        state = "neutral"
        if rsi_value <= oversold and price <= float(lower[-1]):
            # Only buy dips in something that is still structurally healthy.
            if above_trend:
                value = clamp((oversold - rsi_value) / oversold + (1.0 - band_position) * 0.5)
                state = "oversold_pullback_in_uptrend"
            else:
                state = "oversold_but_below_trend_filter"
        elif rsi_value >= overbought and price >= float(upper[-1]):
            value = -clamp((rsi_value - overbought) / (100.0 - overbought) + band_position * 0.5)
            state = "overbought_extension"

        if value == 0.0:
            return self._signal(
                series,
                0.0,
                10.0,
                {
                    "state": state,
                    "rsi": round(rsi_value, 2),
                    "band_position": round(band_position, 3),
                    "above_trend_filter": bool(above_trend),
                    "explanation": "no actionable mean-reversion extreme",
                },
                atr_value,
            )

        stretch = abs(rsi_value - 50.0) / 50.0
        confidence = 100.0 * (0.35 + 0.4 * stretch + (0.25 if above_trend and value > 0 else 0.0))
        # Mean reversion is dangerous in violent markets - discount it there.
        if context.regime.is_high_volatility:
            confidence *= 0.7
        return self._signal(
            series,
            value,
            confidence,
            {
                "state": state,
                "rsi": round(rsi_value, 2),
                "lower_band": round(float(lower[-1]), 4),
                "upper_band": round(float(upper[-1]), 4),
                "band_position": round(band_position, 3),
                "above_trend_filter": bool(above_trend),
                "explanation": "fade a stretched move back towards the mean, trend-filtered",
            },
            atr_value,
        )
