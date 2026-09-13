"""The risk engine - final authority on every order.

Nothing reaches the broker without an approval from here. Strategies propose;
this module disposes. The engine is deterministic: identical inputs always
produce an identical decision, and every decision carries the full list of
checks that produced it so it can be audited or replayed.

Two rules are hard-coded rather than configurable, because they are the ones
that destroy accounts:

* **never average down** - an entry into a symbol that already holds a losing
  position in the same direction is refused;
* **never increase risk to recover losses** - drawdown can only ever reduce
  size (enforced by :class:`DrawdownController` and validated in config).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Sequence

from ..config import AppConfig, RiskConfig
from ..enums import ExitReason, KillSwitchReason, SignalDirection, SystemMode
from ..logging_setup import get_logger
from ..portfolio.models import PortfolioState, Position
from ..regime.classifier import RegimeState
from ..utils.timeutils import utc_now
from .cooldown import CooldownTracker
from .drawdown import DrawdownAssessment, DrawdownController
from .kill_switch import KillSwitch
from .sizing import PositionSizer, SizingInputs, SizingResult

log = get_logger(__name__)


@dataclass(frozen=True)
class RiskCheck:
    name: str
    passed: bool
    detail: str
    value: float | None = None
    limit: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "passed": self.passed,
            "detail": self.detail,
            "value": round(self.value, 6) if isinstance(self.value, (int, float)) else None,
            "limit": round(self.limit, 6) if isinstance(self.limit, (int, float)) else None,
        }


@dataclass(frozen=True)
class EntryProposal:
    """A candidate trade, already scored by the ensemble."""

    symbol: str
    direction: SignalDirection
    score: float
    confidence: float
    reference_price: float
    atr: float
    annualised_volatility: float = 0.0
    average_daily_volume: float = 0.0
    average_dollar_volume: float = 0.0
    spread_bps: float | None = None
    data_quality_ok: bool = True
    data_quality_detail: str = "ok"
    correlated_exposure_pct: float = 0.0
    correlations: dict[str, float] = field(default_factory=dict)
    sector: str = "unknown"
    strategy_contributions: list[dict[str, Any]] = field(default_factory=list)
    as_of: datetime = field(default_factory=utc_now)


@dataclass(frozen=True)
class RiskDecision:
    approved: bool
    symbol: str
    direction: SignalDirection
    quantity: int = 0
    entry_price: float = 0.0
    stop_price: float | None = None
    take_profit_price: float | None = None
    risk_amount: float = 0.0
    reward_risk: float = 0.0
    checks: tuple[RiskCheck, ...] = ()
    rejection_reasons: tuple[str, ...] = ()
    sizing: SizingResult | None = None
    drawdown: DrawdownAssessment | None = None
    regime: str = ""
    mode: SystemMode = SystemMode.SAFE_MODE
    as_of: datetime = field(default_factory=utc_now)

    @property
    def failed_checks(self) -> list[RiskCheck]:
        return [c for c in self.checks if not c.passed]

    def audit(self) -> dict[str, Any]:
        """The complete 'why' record persisted with every order."""
        return {
            "approved": self.approved,
            "symbol": self.symbol,
            "direction": str(self.direction),
            "quantity": self.quantity,
            "entry_price": round(self.entry_price, 4),
            "stop_price": round(self.stop_price, 4) if self.stop_price else None,
            "take_profit_price": round(self.take_profit_price, 4) if self.take_profit_price else None,
            "risk_amount": round(self.risk_amount, 2),
            "reward_risk": round(self.reward_risk, 3),
            "regime": self.regime,
            "mode": str(self.mode),
            "drawdown": self.drawdown.to_dict() if self.drawdown else None,
            "sizing": self.sizing.to_dict() if self.sizing else None,
            "checks": [c.to_dict() for c in self.checks],
            "rejection_reasons": list(self.rejection_reasons),
            "as_of": self.as_of.isoformat(),
        }


@dataclass(frozen=True)
class ExitDecision:
    should_exit: bool
    reason: ExitReason | None = None
    detail: str = ""
    urgency: str = "normal"          # normal | immediate

    def to_dict(self) -> dict[str, Any]:
        return {
            "should_exit": self.should_exit,
            "reason": str(self.reason) if self.reason else None,
            "detail": self.detail,
            "urgency": self.urgency,
        }


class RiskEngine:
    """Deterministic risk authority."""

    def __init__(
        self,
        config: AppConfig,
        kill_switch: KillSwitch | None = None,
        mode: SystemMode = SystemMode.PAPER_MODE,
    ) -> None:
        self.config = config
        self.risk: RiskConfig = config.risk
        self.mode = mode
        self.kill_switch = kill_switch or KillSwitch()
        self.drawdown_controller = DrawdownController(config.risk)
        self.sizer = PositionSizer(config.risk)
        self.cooldowns = CooldownTracker(config.risk)

    # ------------------------------------------------------------------ #
    # stops and targets
    # ------------------------------------------------------------------ #
    def stop_and_target(
        self,
        entry_price: float,
        atr: float,
        direction: SignalDirection,
    ) -> tuple[float, float, dict[str, Any]]:
        """ATR-based protective stop and take-profit, with a hard distance cap."""
        cfg = self.risk
        raw_distance = atr * cfg.atr_stop_multiple
        max_distance = entry_price * cfg.max_stop_distance_pct
        distance = min(raw_distance, max_distance) if max_distance > 0 else raw_distance
        capped = raw_distance > max_distance > 0
        target_distance = atr * cfg.atr_target_multiple

        if direction is SignalDirection.SHORT:
            stop = float(entry_price + distance)
            target = float(entry_price - target_distance)
        else:
            stop = float(entry_price - distance)
            target = float(entry_price + target_distance)

        reason = {
            "method": "ATR",
            "atr": round(atr, 4),
            "atr_stop_multiple": cfg.atr_stop_multiple,
            "atr_target_multiple": cfg.atr_target_multiple,
            "raw_stop_distance": round(raw_distance, 4),
            "applied_stop_distance": round(distance, 4),
            "max_stop_distance_pct": cfg.max_stop_distance_pct,
            "distance_capped": capped,
            "stop_price": round(stop, 4),
            "take_profit_price": round(target, 4),
        }
        return stop, target, reason

    def trailing_stop_price(self, position: Position, atr: float) -> float | None:
        """New trailing stop, or ``None`` when it should not move yet.

        A trailing stop only ever moves in the profitable direction.
        """
        cfg = self.risk
        if atr <= 0 or position.risk_per_share <= 0:
            return None
        if position.r_multiple < cfg.trailing_activate_r:
            return None
        distance = atr * cfg.trailing_stop_atr_multiple
        if position.is_long:
            candidate = position.highest_price_since_entry - distance
            if position.stop_price is None or candidate > position.stop_price:
                return round(candidate, 2)
            return None
        candidate = position.lowest_price_since_entry + distance
        if position.stop_price is None or candidate < position.stop_price:
            return round(candidate, 2)
        return None

    # ------------------------------------------------------------------ #
    # entry evaluation
    # ------------------------------------------------------------------ #
    def evaluate_entry(
        self,
        proposal: EntryProposal,
        state: PortfolioState,
        regime: RegimeState,
        now: datetime | None = None,
    ) -> RiskDecision:
        now = now or utc_now()
        cfg = self.risk
        checks: list[RiskCheck] = []
        symbol = proposal.symbol.upper()

        def check(name: str, passed: bool, detail: str, value=None, limit=None) -> bool:
            checks.append(RiskCheck(name=name, passed=passed, detail=detail, value=value, limit=limit))
            return passed

        drawdown = self.drawdown_controller.assess(state.drawdown)

        def decision(approved: bool, sizing: SizingResult | None = None, **kwargs) -> RiskDecision:
            reasons = tuple(c.detail for c in checks if not c.passed)
            return RiskDecision(
                approved=approved and not reasons,
                symbol=symbol,
                direction=proposal.direction,
                checks=tuple(checks),
                rejection_reasons=reasons,
                sizing=sizing,
                drawdown=drawdown,
                regime=str(regime.regime),
                mode=self.mode,
                as_of=now,
                **kwargs,
            )

        # --- 1. mode and kill switch ---------------------------------------
        check(
            "system_mode",
            self.mode in (SystemMode.PAPER_MODE, SystemMode.LIVE_MODE),
            f"{self.mode} does not permit opening new positions",
        )
        check(
            "kill_switch",
            not self.kill_switch.blocks_new_orders,
            f"kill switch active: {self.kill_switch.describe()}",
        )

        # --- 2. data quality / microstructure ------------------------------
        check("data_quality", proposal.data_quality_ok, f"data quality: {proposal.data_quality_detail}")
        if proposal.spread_bps is not None:
            check(
                "max_spread",
                proposal.spread_bps <= cfg.max_spread_bps,
                f"spread {proposal.spread_bps:.1f}bps exceeds {cfg.max_spread_bps:.1f}bps",
                proposal.spread_bps,
                cfg.max_spread_bps,
            )
        price = proposal.reference_price
        check(
            "price_bounds",
            cfg.min_price <= price <= cfg.max_price,
            f"price {price:.2f} outside [{cfg.min_price}, {cfg.max_price}]",
            price,
        )
        check(
            "min_liquidity",
            proposal.average_dollar_volume >= cfg.min_avg_dollar_volume,
            (
                f"average dollar volume {proposal.average_dollar_volume:,.0f} below "
                f"{cfg.min_avg_dollar_volume:,.0f}"
            ),
            proposal.average_dollar_volume,
            cfg.min_avg_dollar_volume,
        )

        # --- 3. volatility filter ------------------------------------------
        atr_pct = proposal.atr / price if price > 0 else 0.0
        check(
            "volatility_filter",
            cfg.min_atr_pct <= atr_pct <= cfg.max_atr_pct,
            f"ATR {atr_pct:.2%} of price outside [{cfg.min_atr_pct:.2%}, {cfg.max_atr_pct:.2%}]",
            atr_pct,
            cfg.max_atr_pct,
        )

        # --- 4. direction sanity + never average down ----------------------
        check(
            "direction",
            proposal.direction in (SignalDirection.LONG, SignalDirection.SHORT),
            "no actionable direction",
        )
        existing = state.get(symbol)
        if existing is not None:
            same_direction = (existing.is_long and proposal.direction is SignalDirection.LONG) or (
                not existing.is_long and proposal.direction is SignalDirection.SHORT
            )
            check(
                "no_averaging_down",
                not same_direction,
                (
                    f"already holding {existing.quantity:g} {symbol} "
                    f"(P&L {existing.unrealized_pnl:,.2f}); adding to an existing position "
                    "is prohibited"
                ),
            )
            if not same_direction:
                check("no_position_flip", False, f"cannot reverse an open {symbol} position in one step")

        # --- 5. cooldowns ---------------------------------------------------
        cooldown_reason = self.cooldowns.blocked_reason(symbol, now)
        check("cooldown", cooldown_reason is None, cooldown_reason or "no cooldown active")

        # --- 6. portfolio-level limits --------------------------------------
        check(
            "max_open_positions",
            state.open_position_count < cfg.max_open_positions,
            f"{state.open_position_count} open positions, limit {cfg.max_open_positions}",
            state.open_position_count,
            cfg.max_open_positions,
        )
        check(
            "daily_loss_limit",
            state.daily_pnl_pct > -cfg.max_daily_loss_pct,
            f"daily P&L {state.daily_pnl_pct:.2%} breaches -{cfg.max_daily_loss_pct:.2%}",
            state.daily_pnl_pct,
            -cfg.max_daily_loss_pct,
        )
        check(
            "weekly_loss_limit",
            state.weekly_pnl_pct > -cfg.max_weekly_loss_pct,
            f"weekly P&L {state.weekly_pnl_pct:.2%} breaches -{cfg.max_weekly_loss_pct:.2%}",
            state.weekly_pnl_pct,
            -cfg.max_weekly_loss_pct,
        )
        check(
            "max_drawdown",
            state.drawdown < cfg.max_drawdown_pct,
            f"drawdown {state.drawdown:.2%} at or beyond limit {cfg.max_drawdown_pct:.2%}",
            state.drawdown,
            cfg.max_drawdown_pct,
        )

        # --- 7. drawdown tier ------------------------------------------------
        check(
            "drawdown_tier_allows_new_positions",
            drawdown.allow_new_positions,
            f"drawdown tier {drawdown.tier} ({drawdown.drawdown:.2%}) forbids new positions",
        )
        check(
            "drawdown_tier_confidence",
            proposal.confidence >= drawdown.min_confidence,
            (
                f"confidence {proposal.confidence:.1f} below tier {drawdown.tier} "
                f"minimum {drawdown.min_confidence:.1f}"
            ),
            proposal.confidence,
            drawdown.min_confidence,
        )

        # --- 8. daily new-risk budget ----------------------------------------
        risk_budget_used = state.risk_opened_today / state.equity if state.equity > 0 else 1.0
        check(
            "daily_risk_budget",
            risk_budget_used < cfg.max_new_risk_per_day_pct,
            (
                f"risk opened today {risk_budget_used:.2%} has reached the daily budget "
                f"{cfg.max_new_risk_per_day_pct:.2%}"
            ),
            risk_budget_used,
            cfg.max_new_risk_per_day_pct,
        )

        # --- 9. stop / target / reward-risk ----------------------------------
        if proposal.atr <= 0:
            check("atr_available", False, "no ATR available - cannot place a protective stop")
            return decision(False)
        stop, target, stop_reason = self.stop_and_target(price, proposal.atr, proposal.direction)
        risk_per_share = float(abs(price - stop))
        reward = float(abs(target - price))
        reward_risk = float(reward / risk_per_share) if risk_per_share > 0 else 0.0
        check(
            "reward_risk",
            reward_risk >= cfg.reward_risk_min,
            f"reward/risk {reward_risk:.2f} below minimum {cfg.reward_risk_min:.2f}",
            reward_risk,
            cfg.reward_risk_min,
        )

        # --- 10. exposure room ------------------------------------------------
        exposure_room = max(0.0, cfg.max_portfolio_exposure_pct - state.exposure_pct)
        sector_room = max(0.0, cfg.max_sector_exposure_pct - state.sector_exposure(proposal.sector))
        correlation_room = max(0.0, cfg.max_correlated_exposure_pct - proposal.correlated_exposure_pct)
        check(
            "portfolio_exposure_room",
            exposure_room > 0,
            f"gross exposure {state.exposure_pct:.2%} at limit {cfg.max_portfolio_exposure_pct:.2%}",
            state.exposure_pct,
            cfg.max_portfolio_exposure_pct,
        )
        check(
            "sector_exposure_room",
            sector_room > 0,
            (
                f"sector {proposal.sector} exposure "
                f"{state.sector_exposure(proposal.sector):.2%} at limit "
                f"{cfg.max_sector_exposure_pct:.2%}"
            ),
            state.sector_exposure(proposal.sector),
            cfg.max_sector_exposure_pct,
        )
        check(
            "correlated_exposure_room",
            correlation_room > 0,
            (
                f"correlated exposure {proposal.correlated_exposure_pct:.2%} at limit "
                f"{cfg.max_correlated_exposure_pct:.2%}"
            ),
            proposal.correlated_exposure_pct,
            cfg.max_correlated_exposure_pct,
        )

        # Stop early if anything has already failed: sizing on a rejected trade
        # would only produce misleading numbers.
        if any(not c.passed for c in checks):
            return decision(False)

        # --- 11. sizing --------------------------------------------------------
        sizing = self.sizer.calculate(
            SizingInputs(
                symbol=symbol,
                entry_price=price,
                stop_price=stop,
                equity=state.equity,
                confidence=proposal.confidence,
                score=proposal.score,
                drawdown_multiplier=drawdown.size_multiplier,
                annualised_volatility=proposal.annualised_volatility,
                average_daily_volume=proposal.average_daily_volume,
                buying_power=state.buying_power,
                sector_room_pct=sector_room,
                correlation_room_pct=correlation_room,
                exposure_room_pct=exposure_room,
            ),
            state,
        )
        check("position_size", sizing.approved, sizing.rejected_reason or "sizing ok", float(sizing.shares))
        if not sizing.approved:
            return decision(False, sizing=sizing)

        check(
            "risk_per_trade",
            sizing.risk_pct_of_equity <= cfg.max_risk_per_trade_pct + 1e-9,
            (
                f"trade risk {sizing.risk_pct_of_equity:.3%} exceeds per-trade limit "
                f"{cfg.max_risk_per_trade_pct:.3%}"
            ),
            sizing.risk_pct_of_equity,
            cfg.max_risk_per_trade_pct,
        )
        check(
            "buying_power",
            sizing.notional <= state.buying_power,
            f"notional {sizing.notional:,.2f} exceeds buying power {state.buying_power:,.2f}",
            sizing.notional,
            state.buying_power,
        )
        projected_exposure = (state.gross_exposure + sizing.notional) / state.equity
        check(
            "projected_portfolio_exposure",
            projected_exposure <= cfg.max_portfolio_exposure_pct + 1e-9,
            (
                f"projected exposure {projected_exposure:.2%} exceeds "
                f"{cfg.max_portfolio_exposure_pct:.2%}"
            ),
            projected_exposure,
            cfg.max_portfolio_exposure_pct,
        )

        approved = all(c.passed for c in checks)
        if approved:
            log.info(
                "risk_approved",
                symbol=symbol,
                quantity=sizing.shares,
                risk_pct=round(sizing.risk_pct_of_equity, 5),
                binding_constraint=sizing.binding_constraint,
                tier=drawdown.tier,
            )
        return decision(
            approved,
            sizing=sizing,
            quantity=sizing.shares,
            entry_price=price,
            stop_price=stop,
            take_profit_price=target,
            risk_amount=sizing.risk_amount,
            reward_risk=reward_risk,
        )

    # ------------------------------------------------------------------ #
    # exit evaluation
    # ------------------------------------------------------------------ #
    def evaluate_exit(
        self,
        position: Position,
        price: float,
        atr: float = 0.0,
        signal_reversed: bool = False,
        now: datetime | None = None,
    ) -> ExitDecision:
        now = now or utc_now()
        cfg = self.risk

        if self.mode is SystemMode.EMERGENCY_MODE:
            return ExitDecision(True, ExitReason.EMERGENCY, "emergency mode: flatten risk", "immediate")

        if position.stop_price is not None:
            breached = (
                price <= position.stop_price if position.is_long else price >= position.stop_price
            )
            if breached:
                trailing = (
                    position.initial_stop_price is not None
                    and position.stop_price != position.initial_stop_price
                )
                return ExitDecision(
                    True,
                    ExitReason.TRAILING_STOP if trailing else ExitReason.STOP_LOSS,
                    f"price {price:.2f} breached stop {position.stop_price:.2f}",
                    "immediate",
                )

        if position.take_profit_price is not None:
            hit = (
                price >= position.take_profit_price
                if position.is_long
                else price <= position.take_profit_price
            )
            if hit:
                return ExitDecision(
                    True,
                    ExitReason.TAKE_PROFIT,
                    f"price {price:.2f} reached target {position.take_profit_price:.2f}",
                )

        if signal_reversed:
            return ExitDecision(
                True, ExitReason.SIGNAL_REVERSAL, "ensemble signal reversed against the position"
            )

        if position.days_held(now) >= cfg.time_stop_days:
            return ExitDecision(
                True,
                ExitReason.TIME_STOP,
                f"held {position.days_held(now):.1f} days, time stop {cfg.time_stop_days}d",
            )

        return ExitDecision(False)

    # ------------------------------------------------------------------ #
    # portfolio-level monitoring
    # ------------------------------------------------------------------ #
    def assess_portfolio(self, state: PortfolioState, now: datetime | None = None) -> list[dict[str, Any]]:
        """Check portfolio-wide limits and trip the kill switch when breached."""
        now = now or utc_now()
        cfg = self.risk
        events: list[dict[str, Any]] = []

        def trip(reason: KillSwitchReason, detail: str) -> None:
            if self.kill_switch.trip(reason, detail, now=now):
                events.append({"type": "kill_switch", "reason": str(reason), "detail": detail})

        if state.daily_pnl_pct <= -cfg.max_daily_loss_pct:
            trip(
                KillSwitchReason.DAILY_LOSS_LIMIT,
                f"daily P&L {state.daily_pnl_pct:.2%} breached -{cfg.max_daily_loss_pct:.2%}",
            )
        if state.weekly_pnl_pct <= -cfg.max_weekly_loss_pct:
            trip(
                KillSwitchReason.WEEKLY_LOSS_LIMIT,
                f"weekly P&L {state.weekly_pnl_pct:.2%} breached -{cfg.max_weekly_loss_pct:.2%}",
            )
        if state.drawdown >= cfg.max_drawdown_pct:
            trip(
                KillSwitchReason.DRAWDOWN_LIMIT,
                f"drawdown {state.drawdown:.2%} breached {cfg.max_drawdown_pct:.2%}",
            )

        assessment = self.drawdown_controller.assess(state.drawdown)
        if self.drawdown_controller.tier_changed(assessment):
            events.append(
                {
                    "type": "drawdown_tier_change",
                    "detail": f"drawdown tier is now {assessment.tier} ({assessment.drawdown:.2%})",
                    "tier": assessment.to_dict(),
                }
            )
        if self.drawdown_controller.is_emergency(assessment) and self.mode is not SystemMode.EMERGENCY_MODE:
            events.append(
                {
                    "type": "emergency",
                    "detail": (
                        f"drawdown {assessment.drawdown:.2%} at or beyond the configured maximum "
                        f"{cfg.max_drawdown_pct:.2%}; switching to EMERGENCY_MODE"
                    ),
                }
            )
            self.mode = SystemMode.EMERGENCY_MODE
        return events

    def record_trade_result(self, symbol: str, pnl: float, now: datetime | None = None) -> list[str]:
        return self.cooldowns.record_trade_result(symbol, pnl, now=now)

    # ------------------------------------------------------------------ #
    def risk_utilisation(self, state: PortfolioState) -> dict[str, Any]:
        """How much of each limit is currently consumed (0-1+), for monitoring."""
        cfg = self.risk

        def ratio(value: float, limit: float) -> float:
            return round(value / limit, 4) if limit else 0.0

        drawdown = self.drawdown_controller.assess(state.drawdown)
        return {
            "gross_exposure": ratio(state.exposure_pct, cfg.max_portfolio_exposure_pct),
            "open_positions": ratio(state.open_position_count, cfg.max_open_positions),
            "daily_loss": ratio(max(0.0, -state.daily_pnl_pct), cfg.max_daily_loss_pct),
            "weekly_loss": ratio(max(0.0, -state.weekly_pnl_pct), cfg.max_weekly_loss_pct),
            "drawdown": ratio(state.drawdown, cfg.max_drawdown_pct),
            "daily_risk_budget": ratio(
                state.risk_opened_today / state.equity if state.equity else 0.0,
                cfg.max_new_risk_per_day_pct,
            ),
            "open_risk": ratio(state.open_risk_pct, cfg.max_risk_per_trade_pct * cfg.max_open_positions),
            "sector_exposures": {
                sector: ratio(value, cfg.max_sector_exposure_pct)
                for sector, value in state.sector_exposures().items()
            },
            "drawdown_tier": drawdown.to_dict(),
            "kill_switch": self.kill_switch.to_dict(),
            "cooldowns": self.cooldowns.to_dict(),
            "mode": str(self.mode),
        }

    def summarise_checks(self, checks: Sequence[RiskCheck]) -> str:
        failed = [c.name for c in checks if not c.passed]
        return "all checks passed" if not failed else f"failed: {', '.join(failed)}"
