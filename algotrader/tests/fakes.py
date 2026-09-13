"""In-memory fakes used across the test-suite."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from algotrader.broker.base import (
    AccountBalances,
    Bar,
    BrokerAdapter,
    BrokerOrder,
    BrokerPosition,
    BrokerUnavailable,
    MarketClock,
    OrderRequest,
    OrderResult,
    Quote,
)
from algotrader.enums import OrderSide, OrderStatus
from algotrader.utils.ids import order_tag
from algotrader.utils.timeutils import utc_now


class FakeBroker(BrokerAdapter):
    """Deterministic broker: orders fill instantly at the quoted price by default."""

    name = "fake"

    def __init__(
        self,
        quotes: dict[str, Quote] | None = None,
        bars: dict[str, list[Bar]] | None = None,
        equity: float = 100_000.0,
        cash: float = 100_000.0,
        buying_power: float | None = None,
        market_open: bool = True,
        supports_brackets: bool = True,
    ) -> None:
        self.quotes = quotes or {}
        self.bars = bars or {}
        self.equity = equity
        self.cash = cash
        self.buying_power = buying_power if buying_power is not None else cash
        self.market_open = market_open
        self._supports_brackets = supports_brackets
        self.positions: list[BrokerPosition] = []
        self.orders: dict[str, BrokerOrder] = {}
        self.placed: list[OrderRequest] = []
        self._next_id = 1000
        self.account_id = "FAKE123"
        # Behaviour switches used by individual tests.
        self.fail_next_place: Exception | None = None
        self.reject_next_place: str | None = None
        self.fill_mode = "instant"          # instant | open | partial
        self.partial_ratio = 0.5
        self.fill_price_offset = 0.0
        self.unavailable = False
        self.cancelled: list[str] = []

    # --- market data ---
    async def get_quotes(self, symbols: list[str]) -> dict[str, Quote]:
        if self.unavailable:
            raise BrokerUnavailable("fake broker offline")
        return {s.upper(): self.quotes[s.upper()] for s in symbols if s.upper() in self.quotes}

    async def get_history(self, symbol, start, end, interval="daily") -> list[Bar]:
        if self.unavailable:
            raise BrokerUnavailable("fake broker offline")
        return self.bars.get(symbol.upper(), [])

    async def get_clock(self) -> MarketClock:
        return MarketClock(state="open" if self.market_open else "closed", timestamp=utc_now())

    # --- account ---
    async def get_balances(self) -> AccountBalances:
        if self.unavailable:
            raise BrokerUnavailable("fake broker offline")
        return AccountBalances(
            account_id=self.account_id,
            total_equity=self.equity,
            total_cash=self.cash,
            buying_power=self.buying_power,
            long_market_value=sum(abs(p.cost_basis) for p in self.positions),
        )

    async def get_positions(self) -> list[BrokerPosition]:
        if self.unavailable:
            raise BrokerUnavailable("fake broker offline")
        return list(self.positions)

    async def get_orders(self) -> list[BrokerOrder]:
        return list(self.orders.values())

    async def get_order(self, order_id: str) -> BrokerOrder | None:
        return self.orders.get(str(order_id))

    # --- trading ---
    async def place_order(self, request: OrderRequest) -> OrderResult:
        request.validate()
        if self.fail_next_place is not None:
            error, self.fail_next_place = self.fail_next_place, None
            raise error
        if self.reject_next_place is not None:
            message, self.reject_next_place = self.reject_next_place, None
            return OrderResult(
                accepted=False,
                order_id=None,
                status=OrderStatus.REJECTED,
                client_order_id=request.client_order_id,
                message=message,
            )

        tag = order_tag(request.client_order_id) if request.client_order_id else None
        if tag:
            for order in self.orders.values():
                if order.tag == tag:
                    return OrderResult(
                        accepted=True,
                        order_id=order.order_id,
                        status=order.status,
                        client_order_id=request.client_order_id,
                        message="duplicate suppressed",
                        duplicate=True,
                    )

        self.placed.append(request)
        order_id = str(self._next_id)
        self._next_id += 1
        quote = self.quotes.get(request.symbol.upper())
        reference = request.limit_price or (quote.mid if quote else 100.0) or 100.0
        fill_price = round(reference + self.fill_price_offset, 4)

        if self.fill_mode == "instant":
            status, filled = OrderStatus.FILLED, float(request.quantity)
        elif self.fill_mode == "partial":
            status, filled = OrderStatus.PARTIALLY_FILLED, float(
                int(request.quantity * self.partial_ratio)
            )
        else:
            status, filled = OrderStatus.OPEN, 0.0

        self.orders[order_id] = BrokerOrder(
            order_id=order_id,
            symbol=request.symbol.upper(),
            side=request.side,
            quantity=float(request.quantity),
            status=status,
            order_type=request.order_type,
            duration=request.duration,
            filled_quantity=filled,
            average_fill_price=fill_price if filled else None,
            limit_price=request.limit_price,
            stop_price=request.stop_loss_price or request.stop_price,
            tag=tag,
            created_at=utc_now(),
        )
        if filled:
            self._apply_fill(request.symbol.upper(), request.side, filled, fill_price)
        return OrderResult(
            accepted=True,
            order_id=order_id,
            status=status,
            client_order_id=request.client_order_id,
            message="accepted",
        )

    def _apply_fill(self, symbol: str, side: OrderSide, quantity: float, price: float) -> None:
        direction = 1.0 if side in (OrderSide.BUY, OrderSide.BUY_TO_COVER) else -1.0
        existing = next((p for p in self.positions if p.symbol == symbol), None)
        signed = direction * quantity
        if existing is None:
            if signed:
                self.positions.append(
                    BrokerPosition(
                        symbol=symbol, quantity=signed, cost_basis=signed * price, acquired=utc_now()
                    )
                )
        else:
            new_quantity = existing.quantity + signed
            self.positions = [p for p in self.positions if p.symbol != symbol]
            if abs(new_quantity) > 1e-9:
                self.positions.append(
                    BrokerPosition(
                        symbol=symbol,
                        quantity=new_quantity,
                        cost_basis=new_quantity * price,
                        acquired=existing.acquired,
                    )
                )
        self.cash -= direction * quantity * price
        self.buying_power -= direction * quantity * price

    async def cancel_order(self, order_id: str) -> bool:
        order = self.orders.get(str(order_id))
        if order is None:
            return False
        self.orders[str(order_id)] = BrokerOrder(
            order_id=order.order_id,
            symbol=order.symbol,
            side=order.side,
            quantity=order.quantity,
            status=OrderStatus.CANCELED,
            filled_quantity=order.filled_quantity,
            average_fill_price=order.average_fill_price,
            tag=order.tag,
        )
        self.cancelled.append(str(order_id))
        return True

    async def health_check(self) -> bool:
        return not self.unavailable

    @property
    def supports_bracket_orders(self) -> bool:
        return self._supports_brackets

    # --- helpers for tests ---
    def set_position(self, symbol: str, quantity: float, price: float) -> None:
        self.positions = [p for p in self.positions if p.symbol != symbol.upper()]
        self.positions.append(
            BrokerPosition(
                symbol=symbol.upper(),
                quantity=quantity,
                cost_basis=quantity * price,
                acquired=utc_now() - timedelta(days=1),
            )
        )


def synthetic_bars(symbol: str, closes: list[float], volume: float = 5_000_000.0) -> list[Bar]:
    start = utc_now() - timedelta(days=len(closes))
    bars: list[Bar] = []
    previous = closes[0]
    for i, close in enumerate(closes):
        bars.append(
            Bar(
                symbol=symbol,
                timestamp=start + timedelta(days=i),
                open=previous,
                high=max(close, previous) * 1.005,
                low=min(close, previous) * 0.995,
                close=close,
                volume=volume,
            )
        )
        previous = close
    return bars
