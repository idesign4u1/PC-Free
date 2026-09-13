"""Bounded strategy-weight adaptation.

Realised performance may nudge ensemble weights, but only inside a narrow band
around the configured values, and only when there is enough evidence. The
system never rewrites its own trading logic - it adjusts a small set of
weights, and risk rules stay untouched either way.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..config import AdaptationConfig, StrategiesConfig
from ..database.repository import Repository
from ..logging_setup import get_logger

log = get_logger(__name__)


@dataclass(frozen=True)
class WeightProposal:
    strategy: str
    base_weight: float
    proposed_weight: float
    expectancy_r: float
    trades: int
    reason: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "strategy": self.strategy,
            "base_weight": round(self.base_weight, 4),
            "proposed_weight": round(self.proposed_weight, 4),
            "expectancy_r": round(self.expectancy_r, 4),
            "trades": self.trades,
            "reason": self.reason,
        }


class StrategyAdapter:
    def __init__(
        self,
        strategies_config: StrategiesConfig,
        adaptation_config: AdaptationConfig,
        repository: Repository,
    ) -> None:
        self.strategies = strategies_config
        self.config = adaptation_config
        self.repo = repository

    async def propose_weights(self) -> list[WeightProposal]:
        """Suggest new weights from realised expectancy. Always bounded."""
        if not self.config.enabled:
            return []
        stats = await self.repo.strategy_statistics(self.config.lookback_trades)
        proposals: list[WeightProposal] = []
        for strategy, base_weight in self.strategies.weights.items():
            record = stats.get(strategy)
            if not record or record["trades"] < self.config.min_trades_per_strategy:
                proposals.append(
                    WeightProposal(
                        strategy=strategy,
                        base_weight=base_weight,
                        proposed_weight=base_weight,
                        expectancy_r=record["expectancy_r"] if record else 0.0,
                        trades=record["trades"] if record else 0,
                        reason="insufficient evidence; weight unchanged",
                    )
                )
                continue

            expectancy = float(record["expectancy_r"])
            # Expectancy of +/-0.5R maps to the full permitted adjustment.
            adjustment = max(-1.0, min(1.0, expectancy / 0.5)) * self.config.max_weight_delta
            proposed = base_weight + adjustment
            proposed = max(
                base_weight - self.config.max_weight_delta,
                min(base_weight + self.config.max_weight_delta, proposed),
            )
            proposed = max(self.config.min_weight, min(self.config.max_weight, proposed))
            proposals.append(
                WeightProposal(
                    strategy=strategy,
                    base_weight=base_weight,
                    proposed_weight=round(proposed, 4),
                    expectancy_r=expectancy,
                    trades=int(record["trades"]),
                    reason=(
                        f"expectancy {expectancy:+.2f}R over {record['trades']} trades; "
                        f"bounded to +/-{self.config.max_weight_delta} of the configured weight"
                    ),
                )
            )
        return proposals

    async def apply(self, proposals: list[WeightProposal]) -> dict[str, float]:
        """Persist the applied weights and return the override map."""
        overrides = {p.strategy: p.proposed_weight for p in proposals}
        stats = await self.repo.strategy_statistics(self.config.lookback_trades)
        for proposal in proposals:
            record = stats.get(proposal.strategy, {})
            await self.repo.upsert_strategy_performance(
                proposal.strategy,
                "ALL",
                trades=int(record.get("trades", 0)),
                wins=int(record.get("wins", 0)),
                losses=int(record.get("losses", 0)),
                gross_profit=float(record.get("gross_profit", 0.0)),
                gross_loss=float(record.get("gross_loss", 0.0)),
                expectancy_r=float(record.get("expectancy_r", 0.0)),
                profit_factor=float(record.get("profit_factor", 0.0)),
                avg_r=float(record.get("expectancy_r", 0.0)),
                applied_weight=proposal.proposed_weight,
            )
        log.info("strategy_weights_adapted", weights=overrides)
        return overrides
