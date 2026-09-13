"""Order construction helpers."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..broker.base import OrderRequest, Quote
from ..config import ExecutionConfig
from ..enums import OrderClass, OrderDuration, OrderSide, OrderType, SignalDirection


def marketable_limit_price(quote: Quote, side: OrderSide, offset_bps: float) -> float | None:
    """A limit that should fill promptly but caps the price we will accept.

    Buying: ask + offset. Selling: bid - offset. Falls back to the mid when one
    side of the book is missing.
    """
    reference: float | None
    if side in (OrderSide.BUY, OrderSide.BUY_TO_COVER):
        reference = quote.ask or quote.mid
        if reference is None:
            return None
        return round(reference * (1.0 + offset_bps / 10_000.0), 2)
    reference = quote.bid or quote.mid
    if reference is None:
        return None
    return round(reference * (1.0 - offset_bps / 10_000.0), 2)


def side_for_entry(direction: SignalDirection) -> OrderSide:
    return OrderSide.BUY if direction is SignalDirection.LONG else OrderSide.SELL_SHORT


def side_for_exit(is_long: bool) -> OrderSide:
    return OrderSide.SELL if is_long else OrderSide.BUY_TO_COVER


@dataclass(frozen=True)
class OrderPlan:
    """A fully-specified order plus the numbers used to build it."""

    request: OrderRequest
    expected_price: float
    uses_bracket: bool
    detail: dict[str, Any]


def build_entry_plan(
    *,
    symbol: str,
    direction: SignalDirection,
    quantity: int,
    quote: Quote,
    config: ExecutionConfig,
    client_order_id: str,
    stop_price: float | None = None,
    take_profit_price: float | None = None,
    bracket_supported: bool = False,
) -> OrderPlan | None:
    side = side_for_entry(direction)
    limit_price = marketable_limit_price(quote, side, config.limit_offset_bps)
    expected = quote.ask if side is OrderSide.BUY else quote.bid
    expected = expected or quote.mid
    if expected is None:
        return None

    use_limit = config.entry_order_type == "limit"
    if use_limit and limit_price is None:
        return None

    uses_bracket = bool(
        config.use_bracket_orders and bracket_supported and stop_price and take_profit_price
    )
    request = OrderRequest(
        symbol=symbol,
        side=side,
        quantity=quantity,
        order_type=OrderType.LIMIT if use_limit else OrderType.MARKET,
        duration=OrderDuration(config.default_duration),
        limit_price=limit_price if use_limit else None,
        order_class=OrderClass.OTOCO if uses_bracket else OrderClass.EQUITY,
        client_order_id=client_order_id,
        take_profit_price=round(take_profit_price, 2) if uses_bracket else None,
        stop_loss_price=round(stop_price, 2) if uses_bracket else None,
    )
    return OrderPlan(
        request=request,
        expected_price=float(expected),
        uses_bracket=uses_bracket,
        detail={
            "order_type": str(request.order_type),
            "limit_price": limit_price,
            "expected_price": round(float(expected), 4),
            "limit_offset_bps": config.limit_offset_bps,
            "bracket": uses_bracket,
            "quote_bid": quote.bid,
            "quote_ask": quote.ask,
            "quote_age_seconds": round(quote.age_seconds(), 2),
        },
    )


def build_exit_plan(
    *,
    symbol: str,
    is_long: bool,
    quantity: int,
    quote: Quote,
    config: ExecutionConfig,
    client_order_id: str,
    urgent: bool = True,
) -> OrderPlan | None:
    """Exits use market orders by default: getting out matters more than price."""
    side = side_for_exit(is_long)
    expected = (quote.bid if is_long else quote.ask) or quote.mid
    if expected is None:
        return None
    order_type = OrderType.MARKET if urgent else OrderType.LIMIT
    limit_price = None if urgent else marketable_limit_price(quote, side, config.limit_offset_bps)
    if order_type is OrderType.LIMIT and limit_price is None:
        order_type, limit_price = OrderType.MARKET, None
    request = OrderRequest(
        symbol=symbol,
        side=side,
        quantity=quantity,
        order_type=order_type,
        duration=OrderDuration(config.default_duration),
        limit_price=limit_price,
        order_class=OrderClass.EQUITY,
        client_order_id=client_order_id,
    )
    return OrderPlan(
        request=request,
        expected_price=float(expected),
        uses_bracket=False,
        detail={
            "order_type": str(order_type),
            "limit_price": limit_price,
            "expected_price": round(float(expected), 4),
            "urgent": urgent,
        },
    )


def slippage_bps(expected: float, actual: float, side: OrderSide) -> float:
    """Positive = worse than expected (paid more buying / received less selling)."""
    if not expected or not actual:
        return 0.0
    if side in (OrderSide.BUY, OrderSide.BUY_TO_COVER):
        return ((actual - expected) / expected) * 10_000.0
    return ((expected - actual) / expected) * 10_000.0
