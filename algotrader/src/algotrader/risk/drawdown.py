"""Drawdown control.

The single most important invariant in this system: **as drawdown increases,
exposure decreases**. Tiers come from configuration; the controller only reads
them and enforces monotonicity (validated in :class:`RiskConfig`).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..config import DrawdownTier, RiskConfig


@dataclass(frozen=True)
class DrawdownAssessment:
    drawdown: float
    tier: str
    size_multiplier: float
    min_confidence: float
    allow_new_positions: bool
    next_tier: str | None = None
    distance_to_next: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "drawdown": round(self.drawdown, 4),
            "tier": self.tier,
            "size_multiplier": self.size_multiplier,
            "min_confidence": self.min_confidence,
            "allow_new_positions": self.allow_new_positions,
            "next_tier": self.next_tier,
            "distance_to_next": round(self.distance_to_next, 4) if self.distance_to_next else None,
        }


class DrawdownController:
    def __init__(self, config: RiskConfig) -> None:
        self.config = config
        self._tiers: list[DrawdownTier] = config.sorted_tiers()
        self._last_tier: str | None = None

    @property
    def tiers(self) -> list[DrawdownTier]:
        return list(self._tiers)

    def assess(self, drawdown: float) -> DrawdownAssessment:
        drawdown = max(0.0, float(drawdown))
        current = self._tiers[0]
        next_tier: DrawdownTier | None = None
        for index, tier in enumerate(self._tiers):
            if drawdown >= tier.min_drawdown:
                current = tier
                next_tier = self._tiers[index + 1] if index + 1 < len(self._tiers) else None
        return DrawdownAssessment(
            drawdown=drawdown,
            tier=current.name,
            size_multiplier=current.size_multiplier,
            min_confidence=current.min_confidence,
            allow_new_positions=current.allow_new_positions,
            next_tier=next_tier.name if next_tier else None,
            distance_to_next=(next_tier.min_drawdown - drawdown) if next_tier else None,
        )

    def tier_changed(self, assessment: DrawdownAssessment) -> bool:
        """True the first time a new tier is observed (for alerting)."""
        changed = assessment.tier != self._last_tier
        self._last_tier = assessment.tier
        return changed

    def is_emergency(self, assessment: DrawdownAssessment) -> bool:
        return assessment.drawdown >= self.config.max_drawdown_pct
