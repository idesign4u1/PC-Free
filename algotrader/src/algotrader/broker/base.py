"""Broker-neutral domain types and the :class:`BrokerAdapter` interface.

Strategy, risk and execution code depends only on this module. Replacing
Tradier with IBKR/Alpaca means writing one new adapter - nothing above the
broker layer changes.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from ..enums import OrderClass, OrderDuration, OrderSide, OrderStatus, OrderType
from ..utils.timeutils import utc_now


# --------------------------------------------------------------------------- #
# Market data
# --------------------------------------------------------------------------- #
@dataclass(frozen=True, slots=True)
class Quote:
    symbol: str
    bid: float | None
    ask: float | None
    last: float | None
    bid_size: int = 0
    ask_size: int = 0
    volume: int = 0
    average_volume: int = 0
    timestamp: datetime = field(default_factory=utc_now)
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def mid(self) -> float | None:
        if self.bid and self.ask and self.bid > 0 and self.ask > 0:
            return (self.bid + self.ask) / 2.0
        return self.last

    @property
    def spread(self) -> float | None:
        if self.bid and self.ask and self.ask >= self.bid > 0:
            return self.ask - self.bid
        return None

    @property
    def spread_bps(self) -> float | None:
        spread, mid = self.spread, self.mid
        if spread is None or not mid:
            return None
        return (spread / mid) * 10_000.0

    @property
    def is_crossed(self) -> bool:
        return bool(self.bid and self.ask and self.bid > self.ask)

    def age_seconds(self, now: datetime | None = None) -> float:
        return ((now or utc_now()) - self.timestamp).total_seconds()


@dataclass(frozen=True, slots=True)
class Bar:
    symbol: str
    timestamp: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float

    @property
    def typical_price(self) -> float:
        return (self.high + self.low + self.close) / 3.0

    @property
    def dollar_volume(self) -> float:
        return self.typical_price * self.volume


@dataclass(frozen=True, slots=True)
class MarketClock:
    state: str                     # open | closed | premarket | postmarket
    timestamp: datetime
    next_change: str | None = None
    description: str = ""

    @property
    def is_open(self) -> bool:
        return self.state.lower() == "open"


# --------------------------------------------------------------------------- #
# Account / orders
# --------------------------------------------------------------------------- #
@dataclass(frozen=True, slots=True)
class AccountBalances:
    account_id: str
    total_equity: float
    total_cash: float
    buying_power: float
    long_market_value: float = 0.0
    short_market_value: float = 0.0
    pending_cash: float = 0.0
    account_type: str = "unknown"
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class BrokerPosition:
    symbol: str
    quantity: float
    cost_basis: float
    acquired: datetime | None = None
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def is_long(self) -> bool:
        return self.quantity > 0

    @property
    def average_price(self) -> float:
        return abs(self.cost_basis / self.quantity) if self.quantity else 0.0


@dataclass(frozen=True, slots=True)
class OrderRequest:
    """One trading intent, broker-neutral.

    ``client_order_id`` makes the request idempotent: it is persisted before
    submission and forwarded to the broker as a tag for reconciliation.
    """

    symbol: str
    side: OrderSide
    quantity: int
    order_type: OrderType = OrderType.MARKET
    duration: OrderDuration = OrderDuration.DAY
    limit_price: float | None = None
    stop_price: float | None = None
    order_class: OrderClass = OrderClass.EQUITY
    client_order_id: str = ""
    # Optional protective legs (bracket / OTOCO).
    take_profit_price: float | None = None
    stop_loss_price: float | None = None
    stop_loss_limit_price: float | None = None
    preview: bool = False

    def validate(self) -> None:
        if self.quantity <= 0:
            raise ValueError("order quantity must be positive")
        if self.order_type in (OrderType.LIMIT, OrderType.STOP_LIMIT) and not self.limit_price:
            raise ValueError(f"{self.order_type} order requires a limit price")
        if self.order_type in (OrderType.STOP, OrderType.STOP_LIMIT) and not self.stop_price:
            raise ValueError(f"{self.order_type} order requires a stop price")
        if self.order_class is OrderClass.OTOCO:
            if not self.take_profit_price or not self.stop_loss_price:
                raise ValueError("OTOCO requires both a take-profit and a stop-loss price")


@dataclass(frozen=True, slots=True)
class Fill:
    order_id: str
    symbol: str
    quantity: float
    price: float
    timestamp: datetime
    side: OrderSide | None = None
    commission: float = 0.0


@dataclass(frozen=True, slots=True)
class BrokerOrder:
    order_id: str
    symbol: str
    side: OrderSide | str
    quantity: float
    status: OrderStatus
    order_type: OrderType | str = OrderType.MARKET
    duration: OrderDuration | str = OrderDuration.DAY
    filled_quantity: float = 0.0
    average_fill_price: float | None = None
    limit_price: float | None = None
    stop_price: float | None = None
    tag: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    error: str | None = None
    legs: list["BrokerOrder"] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def remaining_quantity(self) -> float:
        return max(0.0, float(self.quantity) - float(self.filled_quantity))

    @property
    def is_partial(self) -> bool:
        return 0 < self.filled_quantity < self.quantity


@dataclass(frozen=True, slots=True)
class OrderResult:
    """Outcome of a submission attempt."""

    accepted: bool
    order_id: str | None
    status: OrderStatus
    client_order_id: str = ""
    message: str = ""
    duplicate: bool = False
    raw: dict[str, Any] = field(default_factory=dict)


class BrokerError(RuntimeError):
    """Base class for broker failures."""


class BrokerUnavailable(BrokerError):
    """Connectivity/5xx/timeout - the broker cannot be reached right now."""


class BrokerAuthError(BrokerError):
    """Credentials rejected (401/403). Never retried."""


class BrokerRejected(BrokerError):
    """The broker understood the request and refused it."""


class BrokerRateLimited(BrokerUnavailable):
    """429 or local rate-limiter refusal."""


# --------------------------------------------------------------------------- #
# Adapter interface
# --------------------------------------------------------------------------- #
class BrokerAdapter(abc.ABC):
    """Everything the platform needs from a broker, and nothing more."""

    name: str = "abstract"

    # --- lifecycle ---
    async def connect(self) -> None:  # pragma: no cover - trivial default
        return None

    async def close(self) -> None:  # pragma: no cover - trivial default
        return None

    # --- market data ---
    @abc.abstractmethod
    async def get_quotes(self, symbols: list[str]) -> dict[str, Quote]: ...

    @abc.abstractmethod
    async def get_history(
        self,
        symbol: str,
        start: datetime,
        end: datetime,
        interval: str = "daily",
    ) -> list[Bar]: ...

    @abc.abstractmethod
    async def get_clock(self) -> MarketClock: ...

    # --- account ---
    @abc.abstractmethod
    async def get_balances(self) -> AccountBalances: ...

    @abc.abstractmethod
    async def get_positions(self) -> list[BrokerPosition]: ...

    @abc.abstractmethod
    async def get_orders(self) -> list[BrokerOrder]: ...

    @abc.abstractmethod
    async def get_order(self, order_id: str) -> BrokerOrder | None: ...

    # --- trading ---
    @abc.abstractmethod
    async def place_order(self, request: OrderRequest) -> OrderResult: ...

    @abc.abstractmethod
    async def cancel_order(self, order_id: str) -> bool: ...

    # --- health ---
    @abc.abstractmethod
    async def health_check(self) -> bool: ...

    # --- capabilities ---
    @property
    def supports_bracket_orders(self) -> bool:
        return False

    @property
    def supports_trailing_stop(self) -> bool:
        return False
