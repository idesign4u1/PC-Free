"""Cross-sectional style momentum: 12-1 style return, skipping the last days."""

from __future__ import annotations

from ..market_data.indicators import atr, clamp, last_valid, realized_volatility, scale_to_unit
from ..market_data.series import BarSeries
from .base import Signal, Strategy, StrategyContext


class MomentumStrategy(Strategy):
    name = "momentum"
    default_params = {
        "lookback": 63,
        "skip_recent": 5,
        "confirm_lookback": 21,
        "min_bars": 120,
        "return_saturation": 0.25,
        "vol_penalty_threshold": 0.60,
    }

    def _evaluate(self, series: BarSeries, context: StrategyContext) -> Signal | None:
        p = self.params
        closes = series.closes
        lookback, skip = int(p["lookback"]), int(p["skip_recent"])
        if closes.size < lookback + skip + 2:
            return None

        recent = float(closes[-1 - skip])
        past = float(closes[-1 - skip - lookback])
        if past <= 0:
            return None
        momentum = recent / past - 1.0

        confirm_n = int(p["confirm_lookback"])
        confirm_past = float(closes[-1 - confirm_n]) if closes.size > confirm_n else past
        confirm = (float(closes[-1]) / confirm_past - 1.0) if confirm_past > 0 else 0.0

        value = clamp(scale_to_unit(momentum, float(p["return_saturation"])))
        agreement = 1.0 if (momentum > 0) == (confirm > 0) else 0.0
        confidence = 100.0 * (0.5 * agreement + 0.5 * min(1.0, abs(value) / 0.6))

        vol = last_valid(realized_volatility(closes, 20)) or 0.0
        if vol > float(p["vol_penalty_threshold"]):
            # Momentum measured through noise is not momentum.
            confidence *= 0.6
        atr_value = last_valid(atr(series.highs, series.lows, closes, 14))
        return self._signal(
            series,
            value,
            confidence,
            {
                f"return_{lookback}d_skip_{skip}": round(momentum, 4),
                f"confirm_return_{confirm_n}d": round(confirm, 4),
                "realized_vol": round(vol, 4),
                "explanation": "trade in the direction of medium-term price momentum",
            },
            atr_value,
        )
