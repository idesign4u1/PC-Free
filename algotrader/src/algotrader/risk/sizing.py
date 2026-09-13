"""Position sizing.

Size is the smallest of several independent caps, so a single mis-estimated
input can only ever make the position *smaller*:

    risk cap        equity x risk-per-trade x conviction x drawdown multiplier
                    divided by the per-share distance to the stop
    volatility cap  keeps a position's annualised volatility contribution
                    inside the portfolio volatility target
    position cap    max % of equity in one name
    exposure cap    remaining room under the gross exposure limit
    sector cap      remaining room in that sector
    correlation cap remaining room in the correlated cluster
    liquidity cap   max % of average daily volume
    buying power    what the account can actually afford

Every cap is reported so the answer to "why this size?" is always on record.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from ..config import RiskConfig
from ..portfolio.models import PortfolioState


@dataclass(frozen=True)
class SizingInputs:
    symbol: str
    entry_price: float
    stop_price: float
    equity: float
    confidence: float               # 0-100
    score: float                    # -1..1
    drawdown_multiplier: float = 1.0
    annualised_volatility: float = 0.0
    average_daily_volume: float = 0.0
    buying_power: float = 0.0
    sector_room_pct: float = 1.0
    correlation_room_pct: float = 1.0
    exposure_room_pct: float = 1.0


@dataclass(frozen=True)
class SizingResult:
    symbol: str
    shares: int
    notional: float
    risk_amount: float
    risk_per_share: float
    risk_pct_of_equity: float
    binding_constraint: str
    caps: dict[str, float] = field(default_factory=dict)
    inputs: dict[str, Any] = field(default_factory=dict)
    rejected_reason: str | None = None

    @property
    def approved(self) -> bool:
        return self.shares > 0 and self.rejected_reason is None

    def to_dict(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "shares": self.shares,
            "notional": round(self.notional, 2),
            "risk_amount": round(self.risk_amount, 2),
            "risk_per_share": round(self.risk_per_share, 4),
            "risk_pct_of_equity": round(self.risk_pct_of_equity, 5),
            "binding_constraint": self.binding_constraint,
            "caps": {k: round(v, 2) for k, v in self.caps.items()},
            "inputs": self.inputs,
            "rejected_reason": self.rejected_reason,
        }


class PositionSizer:
    def __init__(self, config: RiskConfig) -> None:
        self.config = config

    # ------------------------------------------------------------------ #
    def conviction_scalar(self, confidence: float, score: float) -> float:
        """Map conviction onto [0.5, 1.0] - conviction can shrink size, never inflate it."""
        confidence_ratio = max(0.0, min(1.0, confidence / 100.0))
        score_ratio = max(0.0, min(1.0, abs(score)))
        conviction = 0.5 * confidence_ratio + 0.5 * score_ratio
        return 0.5 + 0.5 * conviction

    def calculate(self, inputs: SizingInputs, state: PortfolioState | None = None) -> SizingResult:
        cfg = self.config
        equity = inputs.equity
        entry = inputs.entry_price
        risk_per_share = float(abs(entry - inputs.stop_price))

        base = {
            "symbol": inputs.symbol,
            "entry_price": round(entry, 4),
            "stop_price": round(inputs.stop_price, 4),
            "confidence": round(inputs.confidence, 2),
            "score": round(inputs.score, 4),
            "drawdown_multiplier": round(inputs.drawdown_multiplier, 3),
            "annualised_volatility": round(inputs.annualised_volatility, 4),
        }

        def rejected(reason: str) -> SizingResult:
            return SizingResult(
                symbol=inputs.symbol,
                shares=0,
                notional=0.0,
                risk_amount=0.0,
                risk_per_share=risk_per_share,
                risk_pct_of_equity=0.0,
                binding_constraint=reason,
                inputs=base,
                rejected_reason=reason,
            )

        if equity <= 0:
            return rejected("no equity")
        if entry <= 0:
            return rejected("invalid entry price")
        if risk_per_share <= 0:
            return rejected("stop distance is zero")
        if inputs.drawdown_multiplier <= 0:
            return rejected("drawdown tier forbids new risk")

        conviction = self.conviction_scalar(inputs.confidence, inputs.score)
        risk_budget = equity * cfg.max_risk_per_trade_pct * conviction * inputs.drawdown_multiplier

        caps: dict[str, float] = {"risk_budget": risk_budget / risk_per_share}

        # Volatility targeting: a wild name gets fewer shares for the same risk.
        if inputs.annualised_volatility > 0:
            caps["volatility_target"] = (
                equity * cfg.volatility_target_annual / (entry * inputs.annualised_volatility)
            )

        caps["max_position_pct"] = equity * cfg.max_position_pct / entry
        caps["portfolio_exposure"] = max(0.0, equity * inputs.exposure_room_pct) / entry
        caps["sector_exposure"] = max(0.0, equity * inputs.sector_room_pct) / entry
        caps["correlated_exposure"] = max(0.0, equity * inputs.correlation_room_pct) / entry
        if inputs.average_daily_volume > 0:
            caps["liquidity_adv"] = inputs.average_daily_volume * cfg.max_position_pct_of_adv
        if inputs.buying_power > 0:
            caps["buying_power"] = inputs.buying_power / entry

        # Coerce every cap to a plain float: numpy scalars are not JSON-serialisable
        # and these numbers end up in the audit trail.
        caps = {name: float(value) for name, value in caps.items()}
        binding = min(caps, key=lambda k: caps[k])
        shares = int(math.floor(max(0.0, caps[binding])))

        if shares < cfg.min_shares:
            result = rejected(f"size below minimum after {binding} cap")
            return SizingResult(
                symbol=result.symbol,
                shares=0,
                notional=0.0,
                risk_amount=0.0,
                risk_per_share=risk_per_share,
                risk_pct_of_equity=0.0,
                binding_constraint=binding,
                caps=caps,
                inputs=base,
                rejected_reason=f"sized to {shares} shares; {binding} is the binding constraint",
            )

        notional = float(shares * entry)
        if notional < cfg.min_position_notional:
            return SizingResult(
                symbol=inputs.symbol,
                shares=0,
                notional=notional,
                risk_amount=0.0,
                risk_per_share=risk_per_share,
                risk_pct_of_equity=0.0,
                binding_constraint=binding,
                caps=caps,
                inputs=base,
                rejected_reason=(
                    f"notional {notional:,.0f} below minimum {cfg.min_position_notional:,.0f}"
                ),
            )

        risk_amount = float(shares * risk_per_share)
        return SizingResult(
            symbol=inputs.symbol,
            shares=shares,
            notional=notional,
            risk_amount=risk_amount,
            risk_per_share=risk_per_share,
            risk_pct_of_equity=float(risk_amount / equity),
            binding_constraint=binding,
            caps=caps,
            inputs={**base, "conviction_scalar": round(conviction, 3), "risk_budget": round(risk_budget, 2)},
        )
