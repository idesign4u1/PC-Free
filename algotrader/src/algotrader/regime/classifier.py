"""Market regime classification.

The benchmark (SPY by default) is classified continuously into a primary
regime plus an explicit volatility regime. Downstream, the regime does two
things: it re-weights the strategy ensemble, and it tightens risk. It never
*loosens* a risk limit.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import numpy as np

from ..config import RegimeConfig
from ..enums import Regime, VolatilityRegime
from ..market_data.indicators import (
    atr,
    last_valid,
    linreg_slope,
    realized_volatility,
    sma,
)
from ..market_data.series import BarSeries
from ..utils.timeutils import utc_now


@dataclass(frozen=True)
class RegimeState:
    regime: Regime
    volatility_regime: VolatilityRegime
    trend_regime: Regime
    confidence: float                 # 0-100
    trend_strength: float             # -1..+1
    realized_vol: float
    long_run_vol: float
    benchmark_drawdown: float
    atr_pct: float
    as_of: datetime = field(default_factory=utc_now)
    symbol: str = ""
    details: dict[str, Any] = field(default_factory=dict)
    sufficient_data: bool = True

    @property
    def is_risk_off(self) -> bool:
        return self.regime is Regime.RISK_OFF

    @property
    def is_high_volatility(self) -> bool:
        return self.volatility_regime in (VolatilityRegime.HIGH, VolatilityRegime.EXTREME)

    def to_dict(self) -> dict[str, Any]:
        return {
            "regime": str(self.regime),
            "volatility_regime": str(self.volatility_regime),
            "trend_regime": str(self.trend_regime),
            "confidence": round(self.confidence, 2),
            "trend_strength": round(self.trend_strength, 4),
            "realized_vol": round(self.realized_vol, 4),
            "long_run_vol": round(self.long_run_vol, 4),
            "benchmark_drawdown": round(self.benchmark_drawdown, 4),
            "atr_pct": round(self.atr_pct, 4),
            "sufficient_data": self.sufficient_data,
            "as_of": self.as_of.isoformat(),
            "symbol": self.symbol,
            "details": self.details,
        }


class RegimeClassifier:
    def __init__(self, config: RegimeConfig) -> None:
        self.config = config

    def classify(self, series: BarSeries) -> RegimeState:
        cfg = self.config
        if len(series) < cfg.min_bars:
            # Not enough evidence: assume the defensive case, not the benign one.
            return RegimeState(
                regime=Regime.HIGH_VOLATILITY,
                volatility_regime=VolatilityRegime.HIGH,
                trend_regime=Regime.SIDEWAYS,
                confidence=0.0,
                trend_strength=0.0,
                realized_vol=0.0,
                long_run_vol=0.0,
                benchmark_drawdown=0.0,
                atr_pct=0.0,
                symbol=series.symbol,
                sufficient_data=False,
                details={"reason": f"insufficient history ({len(series)} < {cfg.min_bars} bars)"},
            )

        closes = series.closes
        price = float(closes[-1])
        fast = last_valid(sma(closes, cfg.fast_ma)) or price
        slow = last_valid(sma(closes, cfg.slow_ma)) or price
        slope = last_valid(linreg_slope(closes, cfg.slope_lookback)) or 0.0
        vol = last_valid(realized_volatility(closes, cfg.realized_vol_window)) or 0.0
        long_vol = last_valid(realized_volatility(closes, cfg.realized_vol_long_window)) or vol
        atr_value = last_valid(atr(series.highs, series.lows, closes, cfg.atr_period)) or 0.0
        atr_pct = atr_value / price if price else 0.0

        window = closes[-252:] if closes.size >= 252 else closes
        peak = float(np.nanmax(window))
        drawdown = (peak - price) / peak if peak > 0 else 0.0

        vol_regime = self._volatility_regime(vol, long_vol)
        trend_regime, trend_strength = self._trend(price, fast, slow, slope)

        vol_spike = long_vol > 0 and vol >= long_vol * cfg.risk_off_vol_spike_ratio
        risk_off = drawdown >= cfg.risk_off_drawdown or (vol_spike and vol > cfg.high_vol_threshold)

        if risk_off:
            regime = Regime.RISK_OFF
        elif vol_regime in (VolatilityRegime.HIGH, VolatilityRegime.EXTREME):
            regime = Regime.HIGH_VOLATILITY
        elif vol_regime is VolatilityRegime.LOW and trend_regime is Regime.SIDEWAYS:
            regime = Regime.LOW_VOLATILITY
        else:
            regime = trend_regime

        return RegimeState(
            regime=regime,
            volatility_regime=vol_regime,
            trend_regime=trend_regime,
            confidence=self._confidence(price, fast, slow, slope, vol, trend_regime),
            trend_strength=float(np.clip(trend_strength, -1.0, 1.0)),
            realized_vol=vol,
            long_run_vol=long_vol,
            benchmark_drawdown=drawdown,
            atr_pct=atr_pct,
            symbol=series.symbol,
            details={
                "price": round(price, 4),
                "fast_ma": round(fast, 4),
                "slow_ma": round(slow, 4),
                "annualised_slope": round(slope, 4),
                "vol_spike": bool(vol_spike),
                "peak_252d": round(peak, 4),
            },
        )

    # ------------------------------------------------------------------ #
    def _volatility_regime(self, vol: float, long_vol: float) -> VolatilityRegime:
        cfg = self.config
        if vol >= cfg.high_vol_threshold * 1.75:
            return VolatilityRegime.EXTREME
        if vol >= cfg.high_vol_threshold:
            return VolatilityRegime.HIGH
        if vol <= cfg.low_vol_threshold:
            return VolatilityRegime.LOW
        return VolatilityRegime.NORMAL

    def _trend(self, price: float, fast: float, slow: float, slope: float) -> tuple[Regime, float]:
        cfg = self.config
        threshold = cfg.sideways_slope_threshold
        separation = (fast - slow) / slow if slow else 0.0
        # Trend strength blends MA separation with the regression slope.
        strength = float(np.clip(separation / 0.05, -1.0, 1.0)) * 0.5 + float(
            np.clip(slope / 0.40, -1.0, 1.0)
        ) * 0.5

        bullish = price > fast and fast > slow and slope > threshold
        bearish = price < fast and fast < slow and slope < -threshold
        if bullish:
            return Regime.BULL_TREND, abs(strength)
        if bearish:
            return Regime.BEAR_TREND, -abs(strength)
        if abs(slope) < threshold:
            return Regime.SIDEWAYS, strength
        return (Regime.BULL_TREND, abs(strength)) if slope > 0 else (Regime.BEAR_TREND, -abs(strength))

    def _confidence(
        self,
        price: float,
        fast: float,
        slow: float,
        slope: float,
        vol: float,
        trend_regime: Regime,
    ) -> float:
        """Confidence rises with agreement between price, MAs and slope."""
        separation = abs(fast - slow) / slow if slow else 0.0
        slope_strength = min(1.0, abs(slope) / 0.40)
        agreement = 0.0
        if trend_regime is Regime.BULL_TREND:
            agreement = sum([price > fast, fast > slow, slope > 0]) / 3.0
        elif trend_regime is Regime.BEAR_TREND:
            agreement = sum([price < fast, fast < slow, slope < 0]) / 3.0
        else:
            agreement = 1.0 - min(1.0, abs(slope) / self.config.sideways_slope_threshold / 2.0)
        raw = 40.0 * agreement + 35.0 * min(1.0, separation / 0.05) + 25.0 * slope_strength
        # Violent markets are inherently less classifiable.
        if vol > self.config.high_vol_threshold:
            raw *= 0.8
        return float(np.clip(raw, 0.0, 100.0))
