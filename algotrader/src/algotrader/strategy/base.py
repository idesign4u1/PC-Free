"""Strategy interface.

A strategy is a pure function of price history plus context. It returns a
normalised opinion - never an order, never a position size. Sizing and risk
belong to the risk engine, which has the final word.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import numpy as np

from ..market_data.series import BarSeries
from ..regime.classifier import RegimeState
from ..utils.timeutils import utc_now


@dataclass(frozen=True)
class StrategyContext:
    """Everything a strategy may look at besides its own symbol's bars."""

    regime: RegimeState
    benchmark: BarSeries | None = None
    as_of: datetime = field(default_factory=utc_now)
    extras: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Signal:
    """Normalised strategy opinion.

    value      -1.0 (max conviction short) .. +1.0 (max conviction long)
    confidence 0 .. 100 - how much the strategy trusts its own reading
    """

    symbol: str
    strategy: str
    value: float
    confidence: float
    rationale: dict[str, Any] = field(default_factory=dict)
    atr: float | None = None
    as_of: datetime = field(default_factory=utc_now)

    def __post_init__(self) -> None:
        object.__setattr__(self, "value", float(np.clip(self.value, -1.0, 1.0)))
        object.__setattr__(self, "confidence", float(np.clip(self.confidence, 0.0, 100.0)))

    @property
    def direction(self) -> int:
        if self.value > 0:
            return 1
        if self.value < 0:
            return -1
        return 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "strategy": self.strategy,
            "value": round(self.value, 4),
            "confidence": round(self.confidence, 2),
            "atr": round(self.atr, 4) if self.atr else None,
            "rationale": self.rationale,
            "as_of": self.as_of.isoformat(),
        }


class Strategy(abc.ABC):
    """Base class. Subclasses only implement :meth:`_evaluate`."""

    name: str = "base"
    default_params: dict[str, Any] = {}

    def __init__(self, params: dict[str, Any] | None = None) -> None:
        merged = dict(self.default_params)
        merged.update(params or {})
        self.params = merged

    @property
    def min_bars(self) -> int:
        return int(self.params.get("min_bars", 120))

    def generate(self, series: BarSeries, context: StrategyContext) -> Signal | None:
        """Return a signal, or ``None`` when the evidence is insufficient."""
        if len(series) < self.min_bars:
            return None
        closes = series.closes
        if closes.size == 0 or not np.isfinite(closes[-1]) or closes[-1] <= 0:
            return None
        try:
            return self._evaluate(series, context)
        except (ValueError, ZeroDivisionError, IndexError):
            # A broken strategy must never take down the trading loop.
            return None

    @abc.abstractmethod
    def _evaluate(self, series: BarSeries, context: StrategyContext) -> Signal | None: ...

    def _signal(
        self,
        series: BarSeries,
        value: float,
        confidence: float,
        rationale: dict[str, Any],
        atr_value: float | None = None,
        as_of: datetime | None = None,
    ) -> Signal:
        return Signal(
            symbol=series.symbol,
            strategy=self.name,
            value=value,
            confidence=confidence,
            rationale=rationale,
            atr=atr_value,
            as_of=as_of or (series.last_timestamp or utc_now()),
        )
