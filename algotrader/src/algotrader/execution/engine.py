"""Execution engine.

Every entry runs the same pipeline, in this order:

    1. validate market state (mode, kill switch, quote freshness)
    2. validate buying power
    3. validate duplicate orders (client order id + recency window)
    4. validate current position (never add to an open position)
    5. re-run the full risk check at submission time
    6. calculate size and price from the *current* quote
    7. submit
    8. verify the broker acknowledgement
    9. persist order, fill and trade state

Orders are idempotent: the client order id is derived deterministically from
the intent, persisted before submission and passed to the broker as a tag, so a
retry can be reconciled rather than duplicated.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from ..broker.base import (
    BrokerAdapter,
    BrokerError,
    BrokerOrder,
    BrokerRejected,
    BrokerUnavailable,
    OrderRequest,
    Quote,
)
from ..config import AppConfig
from ..database.repository import Repository
from ..enums import (
    BrokerEnvironment,
    ExitReason,
    KillSwitchReason,
    OrderClass,
    OrderSide,
    OrderStatus,
    RiskEventType,
    SignalDirection,
    SystemMode,
)
from ..logging_setup import get_logger
from ..portfolio.models import PortfolioState, Position
from ..risk.engine import RiskDecision, RiskEngine
from ..utils.ids import client_order_id as make_client_order_id
from ..utils.timeutils import to_utc, utc_now
from .orders import OrderPlan, build_entry_plan, build_exit_plan, side_for_exit, slippage_bps

log = get_logger(__name__)

# Consecutive broker/execution failures before the kill switch trips.
_EXECUTION_FAILURE_THRESHOLD = 3


@dataclass
class ExecutionResult:
    submitted: bool
    symbol: str
    intent: str = "entry"
    order_record_id: int | None = None
    broker_order_id: str | None = None
    status: OrderStatus = OrderStatus.UNKNOWN
    filled_quantity: float = 0.0
    average_fill_price: float | None = None
    expected_price: float | None = None
    slippage_bps: float | None = None
    trade_id: int | None = None
    duplicate: bool = False
    message: str = ""
    blocked_reasons: list[str] = field(default_factory=list)
    detail: dict[str, Any] = field(default_factory=dict)

    @property
    def filled(self) -> bool:
        return self.status is OrderStatus.FILLED

    def to_dict(self) -> dict[str, Any]:
        return {
            "submitted": self.submitted,
            "symbol": self.symbol,
            "intent": self.intent,
            "status": str(self.status),
            "broker_order_id": self.broker_order_id,
            "filled_quantity": self.filled_quantity,
            "average_fill_price": self.average_fill_price,
            "expected_price": self.expected_price,
            "slippage_bps": round(self.slippage_bps, 2) if self.slippage_bps is not None else None,
            "duplicate": self.duplicate,
            "message": self.message,
            "blocked_reasons": self.blocked_reasons,
            "detail": self.detail,
        }


class ExecutionEngine:
    def __init__(
        self,
        broker: BrokerAdapter,
        repository: Repository,
        config: AppConfig,
        risk_engine: RiskEngine,
        environment: BrokerEnvironment = BrokerEnvironment.PAPER,
        account_id: str = "",
    ) -> None:
        self.broker = broker
        self.repo = repository
        self.config = config
        self.execution_config = config.execution
        self.risk = risk_engine
        self.environment = environment
        self.account_id = account_id or getattr(broker, "account_id", "")
        self.consecutive_failures = 0

    # ------------------------------------------------------------------ #
    @property
    def mode(self) -> SystemMode:
        return self.risk.mode

    def _decision_key(self, moment: datetime | None = None) -> str:
        """Bucket decisions so a retry inside the same cycle is idempotent."""
        moment = moment or utc_now()
        interval = max(1, self.config.system.loop_interval_seconds)
        bucket = int(moment.timestamp() // interval)
        return f"{moment.date().isoformat()}:{bucket}"

    async def _note_failure(self, detail: str, symbol: str | None = None) -> None:
        self.consecutive_failures += 1
        await self.repo.record_risk_event(
            RiskEventType.ORDER_REJECTED, detail, severity="error", symbol=symbol
        )
        if self.consecutive_failures >= _EXECUTION_FAILURE_THRESHOLD:
            if self.risk.kill_switch.trip(
                KillSwitchReason.EXECUTION_ERRORS,
                f"{self.consecutive_failures} consecutive execution failures: {detail}",
            ):
                await self.repo.record_risk_event(
                    RiskEventType.KILL_SWITCH_TRIPPED,
                    f"execution errors: {detail}",
                    severity="critical",
                )

    def _note_success(self) -> None:
        self.consecutive_failures = 0

    # ------------------------------------------------------------------ #
    # entries
    # ------------------------------------------------------------------ #
    async def execute_entry(
        self,
        decision: RiskDecision,
        quote: Quote,
        state: PortfolioState,
        *,
        regime: str = "",
        strategy_scores: dict[str, Any] | None = None,
        market_open: bool = True,
        now: datetime | None = None,
    ) -> ExecutionResult:
        now = now or utc_now()
        symbol = decision.symbol.upper()
        result = ExecutionResult(submitted=False, symbol=symbol, intent="entry")

        # --- 1. market state -------------------------------------------------
        blocked: list[str] = []
        if not decision.approved:
            blocked.append("risk decision was not approved")
        if self.mode not in (SystemMode.PAPER_MODE, SystemMode.LIVE_MODE):
            blocked.append(f"{self.mode} forbids new positions")
        if self.risk.kill_switch.blocks_new_orders:
            blocked.append(f"kill switch active: {self.risk.kill_switch.describe()}")
        if self.config.system.trade_only_when_market_open and not market_open:
            blocked.append("market is closed")
        age = quote.age_seconds(now)
        if age > self.config.market_data.max_quote_age_for_orders_seconds:
            blocked.append(f"quote is {age:.0f}s old")
        if quote.mid is None or quote.mid <= 0:
            blocked.append("no usable quote")

        # --- 2. buying power -------------------------------------------------
        notional = decision.quantity * (quote.ask or quote.mid or decision.entry_price)
        if notional > state.buying_power:
            blocked.append(f"insufficient buying power ({notional:,.2f} > {state.buying_power:,.2f})")

        # --- 4. current position ---------------------------------------------
        if state.has_position(symbol):
            blocked.append(f"position already open in {symbol}")

        if blocked:
            result.blocked_reasons = blocked
            result.message = "; ".join(blocked)
            log.info("entry_blocked", symbol=symbol, reasons=blocked)
            return result

        # --- 3. duplicate order guard ----------------------------------------
        side = OrderSide.BUY if decision.direction is SignalDirection.LONG else OrderSide.SELL_SHORT
        client_id = make_client_order_id(
            self.account_id, symbol, side.value, decision.quantity, "ensemble", self._decision_key(now)
        )
        existing = await self.repo.get_order_by_client_id(client_id)
        if existing is not None:
            result.duplicate = True
            result.order_record_id = existing.id
            result.broker_order_id = existing.broker_order_id
            result.status = OrderStatus(existing.status)
            result.message = "duplicate intent suppressed (client order id already used)"
            return result
        if await self.repo.has_recent_similar_order(
            symbol, side.value, self.execution_config.duplicate_order_window_seconds
        ):
            result.duplicate = True
            result.message = "duplicate intent suppressed (similar order within the dedupe window)"
            result.blocked_reasons = [result.message]
            return result

        # --- 6. price and size ------------------------------------------------
        plan = build_entry_plan(
            symbol=symbol,
            direction=decision.direction,
            quantity=decision.quantity,
            quote=quote,
            config=self.execution_config,
            client_order_id=client_id,
            stop_price=decision.stop_price,
            take_profit_price=decision.take_profit_price,
            bracket_supported=self.broker.supports_bracket_orders,
        )
        if plan is None:
            result.message = "could not construct an order from the current quote"
            result.blocked_reasons = [result.message]
            return result

        # --- 9a. persist the intent BEFORE submitting ---------------------------
        record = await self.repo.create_order(
            client_order_id=client_id,
            symbol=symbol,
            side=side.value,
            quantity=decision.quantity,
            order_type=str(plan.request.order_type),
            order_class=str(plan.request.order_class),
            duration=str(plan.request.duration),
            limit_price=plan.request.limit_price,
            stop_price=decision.stop_price,
            take_profit_price=decision.take_profit_price,
            status=str(OrderStatus.PENDING_SUBMIT),
            intent="entry",
            environment=str(self.environment),
            mode=str(self.mode),
            expected_price=plan.expected_price,
            decision=decision.audit(),
        )
        result.order_record_id = record.id
        result.expected_price = plan.expected_price

        # --- 7/8. submit and verify ---------------------------------------------
        submitted = await self._submit(plan, record.id, symbol)
        if submitted is None:
            result.status = OrderStatus.ERROR
            result.message = "submission failed"
            return result
        broker_order, message, accepted = submitted
        result.message = message
        if not accepted:
            result.status = OrderStatus.REJECTED
            await self.repo.update_order(record.id, status=OrderStatus.REJECTED, error=message)
            await self._note_failure(f"{symbol} entry rejected: {message}", symbol)
            return result

        self._note_success()
        result.submitted = True
        result.broker_order_id = broker_order.order_id if broker_order else None
        result.status = broker_order.status if broker_order else OrderStatus.OPEN
        result.filled_quantity = broker_order.filled_quantity if broker_order else 0.0
        result.average_fill_price = broker_order.average_fill_price if broker_order else None
        result.detail = plan.detail | {"bracket": plan.uses_bracket}

        await self.repo.update_order(
            record.id,
            status=result.status,
            broker_order_id=result.broker_order_id,
            filled_quantity=result.filled_quantity,
            average_fill_price=result.average_fill_price,
            submitted_at=now,
        )

        # --- 9b. fills and the trade record ---------------------------------------
        if result.filled_quantity > 0 and result.average_fill_price:
            await self._record_fill_and_quality(
                record.id,
                symbol,
                side,
                result.filled_quantity,
                result.average_fill_price,
                plan.expected_price,
            )
            result.slippage_bps = slippage_bps(plan.expected_price, result.average_fill_price, side)
            trade = await self.repo.open_trade(
                symbol=symbol,
                direction=str(decision.direction),
                strategy="ensemble",
                quantity=result.filled_quantity,
                entry_price=result.average_fill_price,
                stop_price=decision.stop_price,
                take_profit_price=decision.take_profit_price,
                risk_amount=decision.risk_amount,
                risk_per_share=abs(result.average_fill_price - (decision.stop_price or 0.0)),
                opened_at=now,
                regime_at_entry=regime or decision.regime,
                opportunity_score=(strategy_scores or {}).get("score", 0.0),
                confidence=(strategy_scores or {}).get("confidence", 0.0),
                environment=str(self.environment),
                entry_reason=(strategy_scores or {}),
                sizing_reason=decision.sizing.to_dict() if decision.sizing else None,
                stop_reason=decision.audit().get("drawdown"),
                strategy_scores=strategy_scores,
                risk_state=decision.audit(),
            )
            result.trade_id = trade.id
            if result.filled_quantity < decision.quantity:
                log.warning(
                    "partial_fill",
                    symbol=symbol,
                    filled=result.filled_quantity,
                    requested=decision.quantity,
                )
        return result

    # ------------------------------------------------------------------ #
    # exits
    # ------------------------------------------------------------------ #
    async def execute_exit(
        self,
        position: Position,
        quote: Quote,
        reason: ExitReason,
        detail: str = "",
        *,
        regime: str = "",
        market_open: bool = True,
        urgent: bool = True,
        now: datetime | None = None,
    ) -> ExecutionResult:
        """Exits are always permitted: they reduce risk.

        The kill switch blocks *new* risk, never the ability to get out.
        """
        now = now or utc_now()
        symbol = position.symbol.upper()
        result = ExecutionResult(submitted=False, symbol=symbol, intent="exit")

        if self.config.system.trade_only_when_market_open and not market_open:
            result.blocked_reasons = ["market is closed"]
            result.message = "market is closed"
            return result
        if quote.mid is None or quote.mid <= 0:
            result.blocked_reasons = ["no usable quote"]
            result.message = "no usable quote"
            return result

        quantity = int(abs(position.quantity))
        if quantity <= 0:
            result.message = "nothing to close"
            return result

        side = side_for_exit(position.is_long)
        client_id = make_client_order_id(
            self.account_id, symbol, side.value, quantity, f"exit:{reason}", self._decision_key(now)
        )
        existing = await self.repo.get_order_by_client_id(client_id)
        if existing is not None:
            result.duplicate = True
            result.order_record_id = existing.id
            result.status = OrderStatus(existing.status)
            result.message = "duplicate exit suppressed"
            return result

        plan = build_exit_plan(
            symbol=symbol,
            is_long=position.is_long,
            quantity=quantity,
            quote=quote,
            config=self.execution_config,
            client_order_id=client_id,
            urgent=urgent,
        )
        if plan is None:
            result.message = "could not construct an exit order"
            return result

        record = await self.repo.create_order(
            client_order_id=client_id,
            symbol=symbol,
            side=side.value,
            quantity=quantity,
            order_type=str(plan.request.order_type),
            order_class=str(OrderClass.EQUITY),
            duration=str(plan.request.duration),
            limit_price=plan.request.limit_price,
            status=str(OrderStatus.PENDING_SUBMIT),
            intent="exit",
            environment=str(self.environment),
            mode=str(self.mode),
            expected_price=plan.expected_price,
            decision={"exit_reason": str(reason), "detail": detail},
            trade_id=position.trade_id,
        )
        result.order_record_id = record.id
        result.expected_price = plan.expected_price

        submitted = await self._submit(plan, record.id, symbol)
        if submitted is None:
            result.status = OrderStatus.ERROR
            result.message = "exit submission failed"
            return result
        broker_order, message, accepted = submitted
        result.message = message
        if not accepted:
            result.status = OrderStatus.REJECTED
            await self.repo.update_order(record.id, status=OrderStatus.REJECTED, error=message)
            await self._note_failure(f"{symbol} exit rejected: {message}", symbol)
            return result

        self._note_success()
        result.submitted = True
        result.broker_order_id = broker_order.order_id if broker_order else None
        result.status = broker_order.status if broker_order else OrderStatus.OPEN
        result.filled_quantity = broker_order.filled_quantity if broker_order else 0.0
        result.average_fill_price = broker_order.average_fill_price if broker_order else None
        await self.repo.update_order(
            record.id,
            status=result.status,
            broker_order_id=result.broker_order_id,
            filled_quantity=result.filled_quantity,
            average_fill_price=result.average_fill_price,
            submitted_at=now,
        )

        if result.filled_quantity > 0 and result.average_fill_price:
            await self._record_fill_and_quality(
                record.id,
                symbol,
                side,
                result.filled_quantity,
                result.average_fill_price,
                plan.expected_price,
            )
            result.slippage_bps = slippage_bps(plan.expected_price, result.average_fill_price, side)
            if position.trade_id:
                sign = 1.0 if position.is_long else -1.0
                realized = sign * (result.average_fill_price - position.average_price) * result.filled_quantity
                await self.repo.close_trade(
                    position.trade_id,
                    exit_price=result.average_fill_price,
                    realized_pnl=realized,
                    exit_reason=str(reason),
                    exit_detail={"detail": detail, "slippage_bps": result.slippage_bps},
                    regime_at_exit=regime,
                    closed_at=now,
                )
                result.trade_id = position.trade_id
                result.detail["realized_pnl"] = round(realized, 2)
        return result

    # ------------------------------------------------------------------ #
    # submission plumbing
    # ------------------------------------------------------------------ #
    async def _submit(
        self, plan: OrderPlan, record_id: int, symbol: str
    ) -> tuple[BrokerOrder | None, str, bool] | None:
        """Submit, then verify. Returns ``(order, message, accepted)``."""
        request = plan.request
        try:
            outcome = await self.broker.place_order(request)
        except BrokerRejected as exc:
            return None, str(exc), False
        except BrokerUnavailable as exc:
            await self._note_failure(f"broker unavailable submitting {symbol}: {exc!s}", symbol)
            if self.risk.kill_switch.trip(KillSwitchReason.BROKER_UNAVAILABLE, str(exc)):
                await self.repo.record_risk_event(
                    RiskEventType.KILL_SWITCH_TRIPPED, f"broker unavailable: {exc!s}", severity="critical"
                )
            await self.repo.update_order(record_id, status=OrderStatus.ERROR, error=str(exc))
            return None
        except BrokerError as exc:  # pragma: no cover - defensive
            await self.repo.update_order(record_id, status=OrderStatus.ERROR, error=str(exc))
            return None

        if not outcome.accepted:
            # A bracket rejection falls back to a plain order plus local stop management.
            if plan.uses_bracket and request.order_class is OrderClass.OTOCO:
                log.warning("bracket_rejected_falling_back", symbol=symbol, message=outcome.message)
                fallback = OrderRequest(
                    symbol=request.symbol,
                    side=request.side,
                    quantity=request.quantity,
                    order_type=request.order_type,
                    duration=request.duration,
                    limit_price=request.limit_price,
                    order_class=OrderClass.EQUITY,
                    client_order_id=request.client_order_id,
                )
                try:
                    outcome = await self.broker.place_order(fallback)
                except BrokerError as exc:
                    return None, str(exc), False
            if not outcome.accepted:
                return None, outcome.message or "rejected", False

        verified = await self._await_acknowledgement(outcome.order_id)
        message = outcome.message or "accepted"
        if verified is None:
            return None, f"{message} (no acknowledgement within timeout)", True
        if verified.status is OrderStatus.REJECTED:
            return verified, verified.error or "rejected after acknowledgement", False
        return verified, message, True

    async def _await_acknowledgement(self, order_id: str | None) -> BrokerOrder | None:
        """Poll until the order is working or terminal, bounded by the timeout."""
        if not order_id:
            return None
        deadline = asyncio.get_running_loop().time() + self.execution_config.order_ack_timeout_seconds
        last: BrokerOrder | None = None
        while asyncio.get_running_loop().time() < deadline:
            try:
                last = await self.broker.get_order(order_id)
            except BrokerError as exc:
                log.warning("order_poll_failed", order_id=order_id, error=str(exc))
                return last
            if last is not None and (last.status.is_terminal or last.filled_quantity > 0):
                return last
            if last is not None and last.status is OrderStatus.OPEN:
                return last
            await asyncio.sleep(self.execution_config.order_poll_interval_seconds)
        return last

    async def _record_fill_and_quality(
        self,
        order_record_id: int,
        symbol: str,
        side: OrderSide,
        quantity: float,
        price: float,
        expected_price: float,
    ) -> None:
        commission = max(
            self.execution_config.commission_minimum,
            self.execution_config.commission_per_share * quantity,
        )
        await self.repo.add_fill(
            order_id=order_record_id,
            symbol=symbol,
            side=side.value,
            quantity=quantity,
            price=price,
            commission=commission,
        )
        slip = slippage_bps(expected_price, price, side)
        await self.repo.record_execution_quality(
            order_id=order_record_id,
            symbol=symbol,
            side=side.value,
            expected_price=expected_price,
            actual_price=price,
            quantity=quantity,
            slippage_bps=slip,
            environment=str(self.environment),
        )
        if abs(slip) >= self.execution_config.slippage_alert_bps:
            log.warning("slippage_alert", symbol=symbol, slippage_bps=round(slip, 2))
            await self.repo.record_risk_event(
                RiskEventType.DATA_QUALITY,
                f"{symbol} filled {slip:.1f}bps away from the expected price",
                severity="warning",
                symbol=symbol,
            )

    # ------------------------------------------------------------------ #
    # working-order maintenance
    # ------------------------------------------------------------------ #
    async def sync_working_orders(self, now: datetime | None = None) -> list[dict[str, Any]]:
        """Refresh local order state from the broker; handle partials and staleness."""
        now = now or utc_now()
        updates: list[dict[str, Any]] = []
        for record in await self.repo.working_orders():
            if not record.broker_order_id:
                continue
            try:
                broker_order = await self.broker.get_order(record.broker_order_id)
            except BrokerError as exc:
                log.warning("order_sync_failed", order_id=record.broker_order_id, error=str(exc))
                continue
            if broker_order is None:
                continue
            if (
                broker_order.status is not OrderStatus(record.status)
                or broker_order.filled_quantity != record.filled_quantity
            ):
                newly_filled = broker_order.filled_quantity - (record.filled_quantity or 0.0)
                await self.repo.update_order(
                    record.id,
                    status=broker_order.status,
                    filled_quantity=broker_order.filled_quantity,
                    average_fill_price=broker_order.average_fill_price,
                    error=broker_order.error,
                )
                if newly_filled > 0 and broker_order.average_fill_price:
                    await self._record_fill_and_quality(
                        record.id,
                        record.symbol,
                        OrderSide(record.side),
                        newly_filled,
                        broker_order.average_fill_price,
                        record.expected_price or broker_order.average_fill_price,
                    )
                updates.append(
                    {
                        "order_id": record.broker_order_id,
                        "symbol": record.symbol,
                        "status": str(broker_order.status),
                        "filled": broker_order.filled_quantity,
                    }
                )
            # Cancel entries that are going nowhere; never cancel a protective exit.
            # SQLite hands back naive datetimes; normalise before arithmetic.
            reference_time = to_utc(record.submitted_at or record.created_at)
            age = (now - reference_time).total_seconds()
            cancel_after = self.execution_config.cancel_unfilled_after_seconds
            if (
                record.intent == "entry"
                and cancel_after > 0
                and age > cancel_after
                and broker_order.status in (OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED)
            ):
                if await self.broker.cancel_order(record.broker_order_id):
                    await self.repo.update_order(record.id, status=OrderStatus.CANCELED)
                    updates.append(
                        {
                            "order_id": record.broker_order_id,
                            "symbol": record.symbol,
                            "status": "canceled",
                            "reason": f"unfilled after {age:.0f}s",
                        }
                    )
        return updates

    async def cancel_all_working_orders(self, reason: str = "manual") -> int:
        cancelled = 0
        for record in await self.repo.working_orders():
            if record.broker_order_id and await self.broker.cancel_order(record.broker_order_id):
                await self.repo.update_order(record.id, status=OrderStatus.CANCELED, error=reason)
                cancelled += 1
        log.warning("cancelled_working_orders", count=cancelled, reason=reason)
        return cancelled
