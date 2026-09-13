"""Bar series container with cached numpy views."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from functools import cached_property

import numpy as np

from ..broker.base import Bar


@dataclass(frozen=True)
class BarSeries:
    symbol: str
    bars: tuple[Bar, ...]

    @classmethod
    def from_bars(cls, symbol: str, bars: list[Bar]) -> "BarSeries":
        ordered = tuple(sorted(bars, key=lambda b: b.timestamp))
        return cls(symbol=symbol.upper(), bars=ordered)

    def __len__(self) -> int:
        return len(self.bars)

    @cached_property
    def closes(self) -> np.ndarray:
        return np.array([b.close for b in self.bars], dtype=float)

    @cached_property
    def opens(self) -> np.ndarray:
        return np.array([b.open for b in self.bars], dtype=float)

    @cached_property
    def highs(self) -> np.ndarray:
        return np.array([b.high for b in self.bars], dtype=float)

    @cached_property
    def lows(self) -> np.ndarray:
        return np.array([b.low for b in self.bars], dtype=float)

    @cached_property
    def volumes(self) -> np.ndarray:
        return np.array([b.volume for b in self.bars], dtype=float)

    @cached_property
    def timestamps(self) -> tuple[datetime, ...]:
        return tuple(b.timestamp for b in self.bars)

    @property
    def last_bar(self) -> Bar | None:
        return self.bars[-1] if self.bars else None

    @property
    def last_close(self) -> float | None:
        return float(self.closes[-1]) if len(self.bars) else None

    @property
    def last_timestamp(self) -> datetime | None:
        return self.bars[-1].timestamp if self.bars else None

    def slice_until(self, index: int) -> "BarSeries":
        """Bars ``[0 .. index]`` inclusive - the backtester's look-ahead guard."""
        return BarSeries(symbol=self.symbol, bars=self.bars[: index + 1])

    def tail(self, n: int) -> "BarSeries":
        return BarSeries(symbol=self.symbol, bars=self.bars[-n:] if n > 0 else ())
