"""Strategy package and registry."""

from __future__ import annotations

from typing import Any

from .base import Signal, Strategy, StrategyContext
from .breakout import BreakoutStrategy
from .mean_reversion import MeanReversionStrategy
from .momentum import MomentumStrategy
from .relative_strength import RelativeStrengthStrategy
from .trend_following import TrendFollowingStrategy

STRATEGY_REGISTRY: dict[str, type[Strategy]] = {
    TrendFollowingStrategy.name: TrendFollowingStrategy,
    MomentumStrategy.name: MomentumStrategy,
    BreakoutStrategy.name: BreakoutStrategy,
    MeanReversionStrategy.name: MeanReversionStrategy,
    RelativeStrengthStrategy.name: RelativeStrengthStrategy,
}


def build_strategies(params_by_name: dict[str, dict[str, Any]] | None = None) -> list[Strategy]:
    """Instantiate every registered strategy with its configured parameters."""
    params_by_name = params_by_name or {}
    return [cls(params_by_name.get(name)) for name, cls in STRATEGY_REGISTRY.items()]


__all__ = [
    "Signal",
    "Strategy",
    "StrategyContext",
    "STRATEGY_REGISTRY",
    "build_strategies",
    "TrendFollowingStrategy",
    "MomentumStrategy",
    "BreakoutStrategy",
    "MeanReversionStrategy",
    "RelativeStrengthStrategy",
]
