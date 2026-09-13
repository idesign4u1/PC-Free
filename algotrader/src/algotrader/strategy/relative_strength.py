"""Relative strength versus the benchmark."""

from __future__ import annotations

import numpy as np

from ..market_data.indicators import atr, clamp, last_valid, scale_to_unit
from ..market_data.series import BarSeries
from .base import Signal, Strategy, StrategyContext


class RelativeStrengthStrategy(Strategy):
    name = "relative_strength"
    default_params = {
        "lookback": 63,
        "benchmark": "SPY",
        "min_bars": 120,
        "spread_saturation": 0.10,
    }

    def _evaluate(self, series: BarSeries, context: StrategyContext) -> Signal | None:
        p = self.params
        benchmark = context.benchmark
        lookback = int(p["lookback"])
        closes = series.closes
        if benchmark is None or len(benchmark) < lookback + 2 or closes.size < lookback + 2:
            return None
        if benchmark.symbol.upper() == series.symbol.upper():
            return None

        bench_closes = benchmark.closes
        sym_return = float(closes[-1]) / float(closes[-1 - lookback]) - 1.0
        bench_return = float(bench_closes[-1]) / float(bench_closes[-1 - lookback]) - 1.0
        spread = sym_return - bench_return
        value = clamp(scale_to_unit(spread, float(p["spread_saturation"])))

        # Consistency: how often was the symbol's weekly return above the benchmark's?
        weeks = min(lookback // 5, 12)
        wins = 0
        for w in range(1, weeks + 1):
            sym_week = float(closes[-1 - (w - 1) * 5]) / float(closes[-1 - w * 5]) - 1.0
            bench_week = float(bench_closes[-1 - (w - 1) * 5]) / float(bench_closes[-1 - w * 5]) - 1.0
            wins += int(sym_week > bench_week)
        consistency = wins / weeks if weeks else 0.5
        directional_consistency = consistency if value >= 0 else 1.0 - consistency

        confidence = 100.0 * (0.45 * directional_consistency + 0.55 * min(1.0, abs(value) / 0.6))
        atr_value = last_valid(atr(series.highs, series.lows, closes, 14))
        return self._signal(
            series,
            value,
            confidence,
            {
                "symbol_return": round(sym_return, 4),
                "benchmark": benchmark.symbol,
                "benchmark_return": round(bench_return, 4),
                "spread": round(spread, 4),
                "weekly_win_rate": round(consistency, 3),
                "explanation": f"{lookback}-day return versus {benchmark.symbol}",
            },
            atr_value,
        )
