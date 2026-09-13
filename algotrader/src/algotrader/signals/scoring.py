"""Signal aggregation into an OpportunityScore.

The ensemble is deliberately conservative: it must find *agreement* before it
will act. Silence and disagreement both resolve to "no trade", and the reason
is recorded so the decision can be audited later.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from statistics import pstdev
from typing import Any, Iterable, Sequence

import numpy as np

from ..config import SignalsConfig, StrategiesConfig
from ..enums import Regime, SignalDirection
from ..regime.classifier import RegimeState
from ..strategy.base import Signal
from ..utils.timeutils import utc_now

# A strategy value below this is treated as "no opinion" for agreement counting.
_OPINION_EPSILON = 0.05


@dataclass(frozen=True)
class Contribution:
    strategy: str
    value: float
    confidence: float
    base_weight: float
    regime_multiplier: float
    effective_weight: float
    weighted_value: float
    rationale: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "strategy": self.strategy,
            "value": round(self.value, 4),
            "confidence": round(self.confidence, 2),
            "base_weight": round(self.base_weight, 4),
            "regime_multiplier": round(self.regime_multiplier, 3),
            "effective_weight": round(self.effective_weight, 4),
            "weighted_value": round(self.weighted_value, 4),
            "rationale": self.rationale,
        }


@dataclass(frozen=True)
class OpportunityScore:
    """The ensemble's verdict for one symbol."""

    symbol: str
    score: float
    confidence: float
    direction: SignalDirection
    actionable: bool
    regime: Regime
    agreeing: int = 0
    conflicting: int = 0
    dispersion: float = 0.0
    conflict_ratio: float = 0.0
    atr: float | None = None
    rejection_reasons: tuple[str, ...] = ()
    contributions: tuple[Contribution, ...] = ()
    as_of: datetime = field(default_factory=utc_now)

    def to_dict(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "score": round(self.score, 4),
            "confidence": round(self.confidence, 2),
            "direction": str(self.direction),
            "actionable": self.actionable,
            "regime": str(self.regime),
            "agreeing": self.agreeing,
            "conflicting": self.conflicting,
            "dispersion": round(self.dispersion, 4),
            "conflict_ratio": round(self.conflict_ratio, 4),
            "atr": round(self.atr, 4) if self.atr else None,
            "rejection_reasons": list(self.rejection_reasons),
            "contributions": [c.to_dict() for c in self.contributions],
            "as_of": self.as_of.isoformat(),
        }


class SignalAggregator:
    """Combines strategy signals using configurable, regime-aware weights."""

    def __init__(
        self,
        strategies_config: StrategiesConfig,
        signals_config: SignalsConfig,
        weight_overrides: dict[str, float] | None = None,
    ) -> None:
        self.strategies_config = strategies_config
        self.config = signals_config
        self._weight_overrides = dict(weight_overrides or {})

    # ------------------------------------------------------------------ #
    def set_weight_overrides(self, overrides: dict[str, float]) -> None:
        """Applied by the (bounded) performance-adaptation layer."""
        self._weight_overrides = dict(overrides or {})

    def base_weight(self, strategy: str) -> float:
        if strategy in self._weight_overrides:
            return max(0.0, float(self._weight_overrides[strategy]))
        return max(0.0, float(self.strategies_config.weights.get(strategy, 0.0)))

    def effective_weights(self, regime: Regime) -> dict[str, float]:
        multipliers = self.strategies_config.multipliers_for(regime)
        names = set(self.strategies_config.weights) | set(self._weight_overrides)
        return {name: self.base_weight(name) * float(multipliers.get(name, 1.0)) for name in names}

    # ------------------------------------------------------------------ #
    def score(
        self,
        symbol: str,
        signals: Sequence[Signal],
        regime: RegimeState,
        as_of: datetime | None = None,
    ) -> OpportunityScore:
        as_of = as_of or utc_now()
        multipliers = self.strategies_config.multipliers_for(regime.regime)
        contributions: list[Contribution] = []

        for signal in signals:
            base = self.base_weight(signal.strategy)
            multiplier = float(multipliers.get(signal.strategy, 1.0))
            # Confidence scales a strategy's influence: an unsure strategy is quieter.
            effective = base * multiplier * (signal.confidence / 100.0)
            contributions.append(
                Contribution(
                    strategy=signal.strategy,
                    value=signal.value,
                    confidence=signal.confidence,
                    base_weight=base,
                    regime_multiplier=multiplier,
                    effective_weight=effective,
                    weighted_value=effective * signal.value,
                    rationale=signal.rationale,
                )
            )

        atr_values = [s.atr for s in signals if s.atr]
        atr_value = float(np.median(atr_values)) if atr_values else None

        def reject(reasons: list[str], score: float = 0.0, confidence: float = 0.0) -> OpportunityScore:
            return OpportunityScore(
                symbol=symbol.upper(),
                score=score,
                confidence=confidence,
                direction=SignalDirection.FLAT,
                actionable=False,
                regime=regime.regime,
                atr=atr_value,
                rejection_reasons=tuple(reasons),
                contributions=tuple(contributions),
                as_of=as_of,
            )

        if not contributions:
            return reject(["no strategy produced a signal"])

        total_weight = sum(c.effective_weight for c in contributions)
        if total_weight <= 0:
            return reject(["all strategy weights are zero after regime adjustment"])

        raw_score = float(np.clip(sum(c.weighted_value for c in contributions) / total_weight, -1.0, 1.0))
        direction_sign = 1 if raw_score > 0 else (-1 if raw_score < 0 else 0)

        opinions = [c for c in contributions if abs(c.value) >= _OPINION_EPSILON]
        agreeing = [c for c in opinions if np.sign(c.value) == direction_sign and direction_sign != 0]
        conflicting = [c for c in opinions if np.sign(c.value) == -direction_sign and direction_sign != 0]
        agree_weight = sum(c.effective_weight for c in agreeing)
        conflict_weight = sum(c.effective_weight for c in conflicting)
        conflict_ratio = (conflict_weight / agree_weight) if agree_weight > 0 else float("inf")
        dispersion = pstdev([c.value for c in opinions]) if len(opinions) > 1 else 0.0

        weight_for_confidence = sum(c.base_weight * c.regime_multiplier for c in contributions)
        confidence = (
            sum(c.base_weight * c.regime_multiplier * c.confidence for c in contributions)
            / weight_for_confidence
            if weight_for_confidence > 0
            else 0.0
        )
        # Agreement strength modulates the headline confidence.
        if opinions:
            agreement_ratio = len(agreeing) / len(opinions)
            confidence *= 0.6 + 0.4 * agreement_ratio
        confidence = float(np.clip(confidence, 0.0, 100.0))

        reasons: list[str] = []
        cfg = self.config
        if direction_sign == 0:
            reasons.append("net score is flat")
        if abs(raw_score) < cfg.min_abs_score:
            reasons.append(f"|score| {abs(raw_score):.3f} < min {cfg.min_abs_score:.3f}")
        if confidence < cfg.min_confidence:
            reasons.append(f"confidence {confidence:.1f} < min {cfg.min_confidence:.1f}")
        if len(agreeing) < cfg.min_agreeing_strategies:
            reasons.append(
                f"only {len(agreeing)} strategies agree, {cfg.min_agreeing_strategies} required"
            )
        if conflict_ratio > cfg.max_conflict_ratio:
            reasons.append(
                f"conflicting evidence (opposing/agreeing weight {conflict_ratio:.2f} "
                f"> {cfg.max_conflict_ratio:.2f})"
            )
        if dispersion > cfg.max_signal_dispersion:
            reasons.append(f"signal dispersion {dispersion:.2f} > {cfg.max_signal_dispersion:.2f}")
        if not regime.sufficient_data:
            reasons.append("market regime could not be established")
        if cfg.long_only and direction_sign < 0:
            reasons.append("short signals are disabled (long_only)")

        direction = SignalDirection.FLAT
        if direction_sign > 0:
            direction = SignalDirection.LONG
        elif direction_sign < 0:
            direction = SignalDirection.SHORT

        return OpportunityScore(
            symbol=symbol.upper(),
            score=raw_score,
            confidence=confidence,
            direction=direction if not reasons else SignalDirection.FLAT,
            actionable=not reasons,
            regime=regime.regime,
            agreeing=len(agreeing),
            conflicting=len(conflicting),
            dispersion=float(dispersion),
            conflict_ratio=float(conflict_ratio) if conflict_ratio != float("inf") else 999.0,
            atr=atr_value,
            rejection_reasons=tuple(reasons),
            contributions=tuple(contributions),
            as_of=as_of,
        )

    def rank(self, scores: Iterable[OpportunityScore]) -> list[OpportunityScore]:
        """Best opportunities first: conviction, then confidence."""
        return sorted(
            (s for s in scores if s.actionable),
            key=lambda s: (abs(s.score) * (s.confidence / 100.0), s.confidence),
            reverse=True,
        )
