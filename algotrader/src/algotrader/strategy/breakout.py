"""Donchian channel breakout with a volume confirmation filter."""

from __future__ import annotations

import numpy as np

from ..market_data.indicators import atr, clamp, donchian, last_valid, sma
from ..market_data.series import BarSeries
from .base import Signal, Strategy, StrategyContext


class BreakoutStrategy(Strategy):
    name = "breakout"
    default_params = {
        "channel_lookback": 55,
        "exit_lookback": 20,
        "volume_lookback": 20,
        "volume_confirm_ratio": 1.2,
        "atr_period": 14,
        "min_bars": 120,
        "atr_saturation": 2.0,
    }

    def _evaluate(self, series: BarSeries, context: StrategyContext) -> Signal | None:
        p = self.params
        closes, highs, lows, volumes = series.closes, series.highs, series.lows, series.volumes
        channel = int(p["channel_lookback"])
        if closes.size < channel + 5:
            return None

        upper, lower = donchian(highs, lows, channel)
        upper_now, lower_now = upper[-1], lower[-1]
        atr_value = last_valid(atr(highs, lows, closes, int(p["atr_period"])))
        if np.isnan(upper_now) or np.isnan(lower_now) or not atr_value:
            return None

        price = float(closes[-1])
        avg_volume = last_valid(sma(volumes, int(p["volume_lookback"]))) or 0.0
        volume_ratio = (float(volumes[-1]) / avg_volume) if avg_volume > 0 else 0.0
        confirmed = volume_ratio >= float(p["volume_confirm_ratio"])

        saturation = float(p["atr_saturation"]) * atr_value
        if price > upper_now:
            value = clamp((price - upper_now) / saturation) if saturation else 0.0
            state = "upside_breakout"
        elif price < lower_now:
            value = -clamp((lower_now - price) / saturation) if saturation else 0.0
            state = "downside_breakout"
        else:
            # Inside the channel: no breakout, therefore no opinion worth acting on.
            position = (price - lower_now) / (upper_now - lower_now) if upper_now > lower_now else 0.5
            return self._signal(
                series,
                0.0,
                15.0,
                {
                    "state": "inside_channel",
                    "channel_position": round(position, 4),
                    "upper": round(float(upper_now), 4),
                    "lower": round(float(lower_now), 4),
                    "explanation": "price inside the Donchian channel - no breakout",
                },
                atr_value,
            )

        confidence = 100.0 * (0.45 + 0.35 * min(1.0, abs(value)) + (0.20 if confirmed else 0.0))
        if not confirmed:
            confidence *= 0.75  # unconfirmed breakouts fail more often
        return self._signal(
            series,
            value,
            confidence,
            {
                "state": state,
                "upper": round(float(upper_now), 4),
                "lower": round(float(lower_now), 4),
                "volume_ratio": round(volume_ratio, 3),
                "volume_confirmed": confirmed,
                "atr": round(atr_value, 4),
                "explanation": f"{channel}-bar channel breakout, volume confirmed={confirmed}",
            },
            atr_value,
        )
