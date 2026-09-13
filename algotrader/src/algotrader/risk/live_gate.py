"""The LIVE gate.

Live trading is off until a human turns it on, and this module exists to make
that decision evidence-based rather than hopeful. It only ever *reports*
whether the configured criteria are met - nothing here can switch the system to
live trading.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..config import AppConfig, Settings
from ..enums import BrokerEnvironment, SystemMode


@dataclass(frozen=True)
class GateCriterion:
    name: str
    passed: bool
    actual: float | str
    required: float | str
    detail: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "passed": self.passed,
            "actual": self.actual,
            "required": self.required,
            "detail": self.detail,
        }


@dataclass(frozen=True)
class LiveGateReport:
    eligible: bool
    live_enabled: bool
    active_environment: BrokerEnvironment
    active_mode: SystemMode
    criteria: list[GateCriterion] = field(default_factory=list)
    blocking: list[str] = field(default_factory=list)
    instructions: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "eligible_for_live": self.eligible,
            "live_trading_enabled": self.live_enabled,
            "active_environment": str(self.active_environment),
            "active_mode": str(self.active_mode),
            "criteria": [criterion.to_dict() for criterion in self.criteria],
            "blocking": self.blocking,
            "instructions": self.instructions,
        }


_INSTRUCTIONS = (
    "Live trading requires, in this order: (1) every criterion above passing, "
    "(2) live_gate.enabled: true in config.yaml, (3) system.mode: LIVE_MODE in "
    "config.yaml, (4) ENABLE_LIVE_TRADING=true plus TRADIER_LIVE_TOKEN and "
    "TRADIER_LIVE_ACCOUNT_ID in the environment, and (5) a restart. The system "
    "will not switch itself to live trading under any circumstances."
)


def evaluate_live_gate(
    config: AppConfig,
    settings: Settings,
    statistics: dict[str, Any],
    health_ok: bool = True,
) -> LiveGateReport:
    gate = config.live_gate
    criteria: list[GateCriterion] = []

    trades = int(statistics.get("trades", 0))
    criteria.append(
        GateCriterion(
            "minimum_paper_trades",
            trades >= gate.min_paper_trades,
            trades,
            gate.min_paper_trades,
            "closed paper trades on record",
        )
    )
    days = int(statistics.get("days_operating", 0))
    criteria.append(
        GateCriterion(
            "minimum_operating_period_days",
            days >= gate.min_paper_days,
            days,
            gate.min_paper_days,
            "days since the first paper trade",
        )
    )
    drawdown = float(statistics.get("max_drawdown", 1.0))
    criteria.append(
        GateCriterion(
            "maximum_paper_drawdown",
            drawdown <= gate.max_paper_drawdown_pct,
            round(drawdown, 4),
            gate.max_paper_drawdown_pct,
            "worst peak-to-trough equity decline in paper",
        )
    )
    expectancy = float(statistics.get("expectancy_r", 0.0))
    criteria.append(
        GateCriterion(
            "positive_expectancy",
            expectancy >= gate.min_expectancy_r,
            round(expectancy, 4),
            gate.min_expectancy_r,
            "average R per closed trade",
        )
    )
    profit_factor = float(statistics.get("profit_factor", 0.0))
    criteria.append(
        GateCriterion(
            "minimum_profit_factor",
            profit_factor >= gate.min_profit_factor,
            round(profit_factor, 3) if profit_factor != float("inf") else "inf",
            gate.min_profit_factor,
            "gross profit / gross loss",
        )
    )
    win_rate = float(statistics.get("win_rate", 0.0))
    criteria.append(
        GateCriterion(
            "minimum_win_rate",
            win_rate >= gate.min_win_rate,
            round(win_rate, 4),
            gate.min_win_rate,
        )
    )
    sharpe = float(statistics.get("sharpe", 0.0))
    criteria.append(
        GateCriterion("minimum_sharpe", sharpe >= gate.min_sharpe, round(sharpe, 3), gate.min_sharpe)
    )
    if gate.require_health_checks:
        criteria.append(
            GateCriterion("system_health", health_ok, "healthy" if health_ok else "degraded", "healthy")
        )

    blocking = [criterion.name for criterion in criteria if not criterion.passed]
    if not gate.enabled:
        blocking.append("live_gate.enabled is false in configuration")
    if not settings.enable_live_trading:
        blocking.append("ENABLE_LIVE_TRADING is not set in the environment")
    if not settings.has_credentials(BrokerEnvironment.LIVE):
        blocking.append("live broker credentials are not configured")
    if config.system.mode is not SystemMode.LIVE_MODE:
        blocking.append(f"system.mode is {config.system.mode}, not LIVE_MODE")

    return LiveGateReport(
        eligible=all(criterion.passed for criterion in criteria),
        live_enabled=config.resolve_broker_environment(settings) is BrokerEnvironment.LIVE,
        active_environment=config.resolve_broker_environment(settings),
        active_mode=config.effective_mode(settings),
        criteria=criteria,
        blocking=blocking,
        instructions=_INSTRUCTIONS,
    )
