"""Expected vs actual execution.

Paper trading is only useful if it is honest about its own fidelity. Every
fill is compared against the price the system expected when it decided to
trade; the aggregate is what tells you whether the paper results would survive
contact with a real venue.
"""

from __future__ import annotations

from dataclasses import dataclass
from statistics import mean, median
from typing import Any

from ..database.repository import Repository


@dataclass(frozen=True)
class ExecutionQualityReport:
    samples: int
    mean_slippage_bps: float
    median_slippage_bps: float
    worst_slippage_bps: float
    best_slippage_bps: float
    adverse_fills: int
    adverse_rate: float
    estimated_annual_cost_bps: float
    by_symbol: dict[str, float]

    def to_dict(self) -> dict[str, Any]:
        return {
            "samples": self.samples,
            "mean_slippage_bps": round(self.mean_slippage_bps, 2),
            "median_slippage_bps": round(self.median_slippage_bps, 2),
            "worst_slippage_bps": round(self.worst_slippage_bps, 2),
            "best_slippage_bps": round(self.best_slippage_bps, 2),
            "adverse_fills": self.adverse_fills,
            "adverse_rate": round(self.adverse_rate, 4),
            "estimated_round_trip_cost_bps": round(self.estimated_annual_cost_bps, 2),
            "by_symbol": {k: round(v, 2) for k, v in self.by_symbol.items()},
        }


async def build_execution_quality_report(
    repository: Repository, limit: int = 500
) -> ExecutionQualityReport:
    records = await repository.execution_quality(limit=limit)
    if not records:
        return ExecutionQualityReport(0, 0.0, 0.0, 0.0, 0.0, 0, 0.0, 0.0, {})

    slippages = [r.slippage_bps for r in records]
    by_symbol: dict[str, list[float]] = {}
    for record in records:
        by_symbol.setdefault(record.symbol, []).append(record.slippage_bps)
    adverse = [s for s in slippages if s > 0]
    average = mean(slippages)
    return ExecutionQualityReport(
        samples=len(records),
        mean_slippage_bps=average,
        median_slippage_bps=median(slippages),
        worst_slippage_bps=max(slippages),
        best_slippage_bps=min(slippages),
        adverse_fills=len(adverse),
        adverse_rate=len(adverse) / len(slippages),
        # Entry + exit, so a round trip pays the average twice.
        estimated_annual_cost_bps=average * 2.0,
        by_symbol={symbol: mean(values) for symbol, values in by_symbol.items()},
    )
