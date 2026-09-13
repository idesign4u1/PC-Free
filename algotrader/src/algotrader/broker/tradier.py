"""Tradier brokerage adapter.

Endpoints used (v1):
    GET  /v1/markets/quotes            - real-time (delayed in sandbox) quotes
    GET  /v1/markets/history           - daily OHLCV history
    GET  /v1/markets/clock             - market state
    GET  /v1/user/profile              - connectivity / auth probe
    GET  /v1/accounts/{id}/balances    - equity, cash, buying power
    GET  /v1/accounts/{id}/positions   - open positions
    GET  /v1/accounts/{id}/orders      - orders (with ?includeTags=true)
    GET  /v1/accounts/{id}/orders/{oid}
    POST /v1/accounts/{id}/orders      - place equity / OTOCO order (form-encoded)
    DELETE /v1/accounts/{id}/orders/{oid}

Two Tradier behaviours drive the defensive code below:

1. The place-order endpoint can return HTTP 200 while the order was rejected
   downstream; the failure then shows up on the order object (``status`` or an
   ``errors`` property). Every submission is therefore verified with a follow-up
   GET before it is treated as accepted.
2. Requests are rate limited per rolling minute with ``X-Ratelimit-*`` headers,
   so the client throttles itself and never blind-retries a POST: after a
   timeout it reconciles by the order ``tag`` (our client order id).
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any, Iterable

import httpx

from ..enums import BrokerEnvironment, OrderClass, OrderDuration, OrderSide, OrderStatus, OrderType
from ..logging_setup import get_logger
from ..utils.ids import order_tag
from ..utils.timeutils import to_utc, utc_now
from .base import (
    AccountBalances,
    Bar,
    BrokerAdapter,
    BrokerAuthError,
    BrokerOrder,
    BrokerPosition,
    BrokerRateLimited,
    BrokerRejected,
    BrokerUnavailable,
    MarketClock,
    OrderRequest,
    OrderResult,
    Quote,
)

log = get_logger(__name__)

_STATUS_MAP = {
    "open": OrderStatus.OPEN,
    "pending": OrderStatus.OPEN,
    "partially_filled": OrderStatus.PARTIALLY_FILLED,
    "filled": OrderStatus.FILLED,
    "canceled": OrderStatus.CANCELED,
    "cancelled": OrderStatus.CANCELED,
    "expired": OrderStatus.EXPIRED,
    "rejected": OrderStatus.REJECTED,
    "error": OrderStatus.ERROR,
    "held": OrderStatus.OPEN,
    "calculated": OrderStatus.OPEN,
    "accepted_for_bidding": OrderStatus.OPEN,
}

# Conservative client-side ceilings (Tradier: ~120/min production, ~60/min sandbox).
_RATE_LIMITS = {BrokerEnvironment.LIVE: 110, BrokerEnvironment.PAPER: 55}


def _as_list(payload: Any, key: str) -> list[dict[str, Any]]:
    """Tradier collapses single-element collections and returns "null" for empty."""
    if not payload or payload in ("null", "NULL"):
        return []
    if isinstance(payload, dict):
        inner = payload.get(key)
        if inner in (None, "null"):
            return []
        if isinstance(inner, list):
            return [x for x in inner if isinstance(x, dict)]
        if isinstance(inner, dict):
            return [inner]
    if isinstance(payload, list):
        return [x for x in payload if isinstance(x, dict)]
    return []


def _f(value: Any) -> float | None:
    try:
        if value in (None, "", "null"):
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _epoch_ms_to_dt(value: Any) -> datetime | None:
    raw = _f(value)
    if not raw:
        return None
    try:
        return datetime.fromtimestamp(raw / 1000.0, tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None


def _parse_date(value: Any) -> datetime | None:
    if not value or not isinstance(value, str):
        return None
    text = value.replace("Z", "+00:00")
    try:
        return to_utc(datetime.fromisoformat(text))
    except ValueError:
        try:
            return to_utc(datetime.strptime(value, "%Y-%m-%d"))
        except ValueError:
            return None


class TradierBroker(BrokerAdapter):
    """Async Tradier adapter. One instance per environment."""

    name = "tradier"

    def __init__(
        self,
        base_url: str,
        token: str,
        account_id: str,
        environment: BrokerEnvironment = BrokerEnvironment.PAPER,
        timeout: float = 15.0,
        max_retries: int = 3,
        client: httpx.AsyncClient | None = None,
        rate_limit_per_minute: int | None = None,
    ) -> None:
        if not token or not account_id:
            raise BrokerAuthError(
                f"missing Tradier credentials for {environment} environment "
                "(set the token and account id environment variables)"
            )
        self.environment = environment
        self.account_id = account_id
        self.base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._max_retries = max_retries
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            base_url=self.base_url,
            timeout=timeout,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
            },
        )
        from .rate_limit import RateLimiter  # local import keeps module import cheap

        limit = rate_limit_per_minute or _RATE_LIMITS.get(environment, 55)
        self._limiter = RateLimiter(max_calls=limit, period_seconds=60.0)
        self.last_rate_limit: dict[str, int] = {}
        self.last_error: str | None = None
        self.last_success_at: datetime | None = None

    # ------------------------------------------------------------------ #
    # plumbing
    # ------------------------------------------------------------------ #
    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        data: dict[str, Any] | None = None,
        retry: bool = True,
    ) -> dict[str, Any]:
        attempts = self._max_retries if retry else 1
        delay = 0.5
        last_exc: Exception | None = None
        for attempt in range(1, attempts + 1):
            await self._limiter.acquire()
            try:
                response = await self._client.request(method, path, params=params, data=data)
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                last_exc = BrokerUnavailable(f"{method} {path} transport failure: {exc!s}")
                self.last_error = str(last_exc)
                if attempt < attempts:
                    await asyncio.sleep(delay)
                    delay *= 2
                    continue
                raise last_exc from exc

            self.last_rate_limit = self._limiter.observe_headers(dict(response.headers))

            if response.status_code in (401, 403):
                self.last_error = "authentication rejected"
                raise BrokerAuthError(f"{method} {path} rejected credentials ({response.status_code})")
            if response.status_code == 429:
                self.last_error = "rate limited"
                if attempt < attempts:
                    await asyncio.sleep(max(delay, 2.0))
                    delay *= 2
                    continue
                raise BrokerRateLimited(f"{method} {path} rate limited")
            if response.status_code >= 500:
                self.last_error = f"broker {response.status_code}"
                if attempt < attempts:
                    await asyncio.sleep(delay)
                    delay *= 2
                    continue
                raise BrokerUnavailable(f"{method} {path} failed with {response.status_code}")
            if response.status_code >= 400:
                detail = response.text[:400]
                self.last_error = f"broker {response.status_code}"
                raise BrokerRejected(f"{method} {path} rejected ({response.status_code}): {detail}")

            try:
                payload = response.json()
            except ValueError as exc:
                raise BrokerUnavailable(f"{method} {path} returned non-JSON payload") from exc
            if not isinstance(payload, dict):
                raise BrokerUnavailable(f"{method} {path} returned unexpected payload type")

            errors = payload.get("errors")
            if errors:
                messages = errors.get("error") if isinstance(errors, dict) else errors
                if isinstance(messages, str):
                    messages = [messages]
                raise BrokerRejected(f"{method} {path}: {'; '.join(map(str, messages or []))}")

            self.last_error = None
            self.last_success_at = utc_now()
            return payload
        raise last_exc or BrokerUnavailable(f"{method} {path} failed")

    def _account_path(self, suffix: str = "") -> str:
        return f"/v1/accounts/{self.account_id}/{suffix}".rstrip("/")

    # ------------------------------------------------------------------ #
    # market data
    # ------------------------------------------------------------------ #
    async def get_quotes(self, symbols: list[str]) -> dict[str, Quote]:
        if not symbols:
            return {}
        payload = await self._request(
            "GET",
            "/v1/markets/quotes",
            params={"symbols": ",".join(sorted({s.upper() for s in symbols})), "greeks": "false"},
        )
        quotes: dict[str, Quote] = {}
        for row in _as_list(payload.get("quotes"), "quote"):
            symbol = str(row.get("symbol", "")).upper()
            if not symbol:
                continue
            timestamp = (
                _epoch_ms_to_dt(row.get("trade_date"))
                or _epoch_ms_to_dt(row.get("ask_date"))
                or _epoch_ms_to_dt(row.get("bid_date"))
                or utc_now()
            )
            quotes[symbol] = Quote(
                symbol=symbol,
                bid=_f(row.get("bid")),
                ask=_f(row.get("ask")),
                last=_f(row.get("last")) or _f(row.get("close")),
                bid_size=int(_f(row.get("bidsize")) or 0),
                ask_size=int(_f(row.get("asksize")) or 0),
                volume=int(_f(row.get("volume")) or 0),
                average_volume=int(_f(row.get("average_volume")) or 0),
                timestamp=timestamp,
                raw=row,
            )
        return quotes

    async def get_history(
        self,
        symbol: str,
        start: datetime,
        end: datetime,
        interval: str = "daily",
    ) -> list[Bar]:
        payload = await self._request(
            "GET",
            "/v1/markets/history",
            params={
                "symbol": symbol.upper(),
                "interval": interval,
                "start": start.date().isoformat(),
                "end": end.date().isoformat(),
                "session_filter": "open",
            },
        )
        bars: list[Bar] = []
        for row in _as_list(payload.get("history"), "day"):
            timestamp = _parse_date(row.get("date"))
            close = _f(row.get("close"))
            if timestamp is None or close is None:
                continue
            bars.append(
                Bar(
                    symbol=symbol.upper(),
                    timestamp=timestamp,
                    open=_f(row.get("open")) or close,
                    high=_f(row.get("high")) or close,
                    low=_f(row.get("low")) or close,
                    close=close,
                    volume=_f(row.get("volume")) or 0.0,
                )
            )
        bars.sort(key=lambda b: b.timestamp)
        return bars

    async def get_clock(self) -> MarketClock:
        payload = await self._request("GET", "/v1/markets/clock", params={"delayed": "false"})
        clock = payload.get("clock") or {}
        epoch_seconds = _f(clock.get("timestamp"))
        timestamp = _epoch_ms_to_dt(epoch_seconds * 1000) if epoch_seconds else None
        return MarketClock(
            state=str(clock.get("state", "unknown")),
            timestamp=timestamp or utc_now(),
            next_change=clock.get("next_change"),
            description=str(clock.get("description", "")),
        )

    # ------------------------------------------------------------------ #
    # account
    # ------------------------------------------------------------------ #
    async def get_balances(self) -> AccountBalances:
        payload = await self._request("GET", self._account_path("balances"))
        balances = payload.get("balances") or {}
        cash_block = balances.get("cash") if isinstance(balances.get("cash"), dict) else {}
        margin_block = balances.get("margin") if isinstance(balances.get("margin"), dict) else {}
        pdt_block = balances.get("pdt") if isinstance(balances.get("pdt"), dict) else {}
        buying_power = (
            _f(margin_block.get("stock_buying_power"))
            or _f(pdt_block.get("stock_buying_power"))
            or _f(cash_block.get("cash_available"))
            or _f(balances.get("total_cash"))
            or 0.0
        )
        return AccountBalances(
            account_id=str(balances.get("account_number", self.account_id)),
            total_equity=_f(balances.get("total_equity")) or 0.0,
            total_cash=_f(balances.get("total_cash")) or 0.0,
            buying_power=buying_power,
            long_market_value=_f(balances.get("long_market_value")) or 0.0,
            short_market_value=_f(balances.get("short_market_value")) or 0.0,
            pending_cash=_f(balances.get("pending_cash")) or 0.0,
            account_type=str(balances.get("account_type", "unknown")),
            raw=balances,
        )

    async def get_positions(self) -> list[BrokerPosition]:
        payload = await self._request("GET", self._account_path("positions"))
        positions: list[BrokerPosition] = []
        for row in _as_list(payload.get("positions"), "position"):
            quantity = _f(row.get("quantity")) or 0.0
            if quantity == 0:
                continue
            positions.append(
                BrokerPosition(
                    symbol=str(row.get("symbol", "")).upper(),
                    quantity=quantity,
                    cost_basis=_f(row.get("cost_basis")) or 0.0,
                    acquired=_parse_date(row.get("date_acquired")),
                    raw=row,
                )
            )
        return positions

    def _parse_order(self, row: dict[str, Any]) -> BrokerOrder:
        status_text = str(row.get("status", "unknown")).lower()
        status = _STATUS_MAP.get(status_text, OrderStatus.UNKNOWN)
        quantity = _f(row.get("quantity")) or 0.0
        filled = _f(row.get("exec_quantity")) or 0.0
        if status is OrderStatus.OPEN and 0 < filled < quantity:
            status = OrderStatus.PARTIALLY_FILLED
        legs = [self._parse_order(leg) for leg in _as_list(row, "leg")]
        error = row.get("reason_description") or row.get("error")
        return BrokerOrder(
            order_id=str(row.get("id", "")),
            symbol=str(row.get("symbol", "")).upper(),
            side=str(row.get("side", "")),
            quantity=quantity,
            status=status,
            order_type=str(row.get("type", "")),
            duration=str(row.get("duration", "")),
            filled_quantity=filled,
            average_fill_price=_f(row.get("avg_fill_price")),
            limit_price=_f(row.get("price")),
            stop_price=_f(row.get("stop_price")),
            tag=row.get("tag"),
            created_at=_parse_date(row.get("create_date")),
            updated_at=_parse_date(row.get("transaction_date")),
            error=str(error) if error else None,
            legs=legs,
            raw=row,
        )

    async def get_orders(self) -> list[BrokerOrder]:
        payload = await self._request(
            "GET", self._account_path("orders"), params={"includeTags": "true"}
        )
        return [self._parse_order(row) for row in _as_list(payload.get("orders"), "order")]

    async def get_order(self, order_id: str) -> BrokerOrder | None:
        try:
            payload = await self._request(
                "GET",
                self._account_path(f"orders/{order_id}"),
                params={"includeTags": "true"},
            )
        except BrokerRejected:
            return None
        block = payload.get("order")
        if isinstance(block, dict):
            rows = [block]
        elif isinstance(block, list):
            rows = [row for row in block if isinstance(row, dict)]
        else:
            rows = _as_list(payload.get("orders"), "order")
        return self._parse_order(rows[0]) if rows else None

    async def find_order_by_tag(self, tag: str) -> BrokerOrder | None:
        """Reconciliation hook: did an earlier (possibly timed-out) submit land?"""
        for order in await self.get_orders():
            if order.tag and order.tag == tag:
                return order
        return None

    # ------------------------------------------------------------------ #
    # trading
    # ------------------------------------------------------------------ #
    def _equity_payload(self, request: OrderRequest) -> dict[str, Any]:
        data: dict[str, Any] = {
            "class": OrderClass.EQUITY.value,
            "symbol": request.symbol.upper(),
            "side": request.side.value,
            "quantity": str(int(request.quantity)),
            "type": request.order_type.value,
            "duration": request.duration.value,
        }
        if request.limit_price is not None:
            data["price"] = f"{request.limit_price:.2f}"
        if request.stop_price is not None:
            data["stop"] = f"{request.stop_price:.2f}"
        if request.client_order_id:
            data["tag"] = order_tag(request.client_order_id)
        if request.preview:
            data["preview"] = "true"
        return data

    def _otoco_payload(self, request: OrderRequest) -> dict[str, Any]:
        """Entry + take-profit + protective stop in one OTOCO order.

        Tradier constraints honoured here: only the first leg may be a market
        order, the two OCO legs must use different order types, and all legs
        must reference the same symbol.
        """
        exit_side = OrderSide.SELL if request.side is OrderSide.BUY else OrderSide.BUY
        symbol = request.symbol.upper()
        quantity = str(int(request.quantity))
        duration = request.duration.value
        data: dict[str, Any] = {
            "class": OrderClass.OTOCO.value,
            "duration": duration,
            # leg 0 - entry
            "symbol[0]": symbol,
            "quantity[0]": quantity,
            "side[0]": request.side.value,
            "type[0]": request.order_type.value,
            "duration[0]": duration,
            # leg 1 - take profit (limit)
            "symbol[1]": symbol,
            "quantity[1]": quantity,
            "side[1]": exit_side.value,
            "type[1]": OrderType.LIMIT.value,
            "duration[1]": duration,
            "price[1]": f"{request.take_profit_price:.2f}",
            # leg 2 - protective stop
            "symbol[2]": symbol,
            "quantity[2]": quantity,
            "side[2]": exit_side.value,
            "duration[2]": duration,
        }
        if request.order_type in (OrderType.LIMIT, OrderType.STOP_LIMIT) and request.limit_price:
            data["price[0]"] = f"{request.limit_price:.2f}"
        if request.stop_loss_limit_price:
            data["type[2]"] = OrderType.STOP_LIMIT.value
            data["stop[2]"] = f"{request.stop_loss_price:.2f}"
            data["price[2]"] = f"{request.stop_loss_limit_price:.2f}"
        else:
            data["type[2]"] = OrderType.STOP.value
            data["stop[2]"] = f"{request.stop_loss_price:.2f}"
        if request.client_order_id:
            data["tag"] = order_tag(request.client_order_id)
        if request.preview:
            data["preview"] = "true"
        return data

    async def place_order(self, request: OrderRequest) -> OrderResult:
        """Submit an order. Never blind-retries; reconciles by tag instead."""
        request.validate()
        tag = order_tag(request.client_order_id) if request.client_order_id else None

        # 1. Idempotency: has this exact intent already reached the broker?
        if tag:
            existing = await self.find_order_by_tag(tag)
            if existing is not None:
                return OrderResult(
                    accepted=existing.status is not OrderStatus.REJECTED,
                    order_id=existing.order_id,
                    status=existing.status,
                    client_order_id=request.client_order_id,
                    message="duplicate suppressed: broker already holds this client order id",
                    duplicate=True,
                    raw=existing.raw,
                )

        data = (
            self._otoco_payload(request)
            if request.order_class is OrderClass.OTOCO
            else self._equity_payload(request)
        )

        try:
            payload = await self._request("POST", self._account_path("orders"), data=data, retry=False)
        except BrokerUnavailable as exc:
            # The order may or may not have landed. Reconcile, never re-send blindly.
            if tag:
                await asyncio.sleep(1.0)
                landed = await self.find_order_by_tag(tag)
                if landed is not None:
                    return OrderResult(
                        accepted=True,
                        order_id=landed.order_id,
                        status=landed.status,
                        client_order_id=request.client_order_id,
                        message="recovered after transport failure via tag reconciliation",
                        raw=landed.raw,
                    )
            raise exc
        except BrokerRejected as exc:
            return OrderResult(
                accepted=False,
                order_id=None,
                status=OrderStatus.REJECTED,
                client_order_id=request.client_order_id,
                message=str(exc),
            )

        order_block = payload.get("order") or payload.get("orders") or {}
        if isinstance(order_block, list):
            order_block = order_block[0] if order_block else {}
        order_id = order_block.get("id")
        ack_status = str(order_block.get("status", "")).lower()

        if request.preview:
            return OrderResult(
                accepted=True,
                order_id=None,
                status=OrderStatus.UNKNOWN,
                client_order_id=request.client_order_id,
                message="preview",
                raw=payload,
            )

        if order_id is None:
            return OrderResult(
                accepted=False,
                order_id=None,
                status=OrderStatus.ERROR,
                client_order_id=request.client_order_id,
                message=f"broker acknowledgement carried no order id: {payload}",
                raw=payload,
            )

        # 2. Tradier can answer 200/ok and still reject downstream - verify.
        verified = await self.get_order(str(order_id))
        status = verified.status if verified else OrderStatus.UNKNOWN
        if verified and verified.error:
            return OrderResult(
                accepted=False,
                order_id=str(order_id),
                status=OrderStatus.REJECTED,
                client_order_id=request.client_order_id,
                message=verified.error,
                raw=verified.raw,
            )
        if status is OrderStatus.REJECTED:
            return OrderResult(
                accepted=False,
                order_id=str(order_id),
                status=status,
                client_order_id=request.client_order_id,
                message="rejected by broker after acknowledgement",
                raw=verified.raw if verified else payload,
            )
        return OrderResult(
            accepted=True,
            order_id=str(order_id),
            status=status if verified else (_STATUS_MAP.get(ack_status, OrderStatus.OPEN)),
            client_order_id=request.client_order_id,
            message="accepted",
            raw=verified.raw if verified else payload,
        )

    async def cancel_order(self, order_id: str) -> bool:
        try:
            payload = await self._request("DELETE", self._account_path(f"orders/{order_id}"))
        except BrokerRejected as exc:
            log.warning("cancel_rejected", order_id=order_id, error=str(exc))
            return False
        block = payload.get("order") or {}
        return str(block.get("status", "")).lower() in {"ok", "canceled", "cancelled"}

    # ------------------------------------------------------------------ #
    # health / capabilities
    # ------------------------------------------------------------------ #
    async def health_check(self) -> bool:
        try:
            await self._request("GET", "/v1/user/profile", retry=False)
            return True
        except (BrokerUnavailable, BrokerRejected, BrokerAuthError) as exc:
            log.warning("broker_health_check_failed", error=str(exc), environment=str(self.environment))
            return False

    @property
    def supports_bracket_orders(self) -> bool:
        return True

    @property
    def supports_trailing_stop(self) -> bool:
        # Tradier has no native trailing stop for equities; the platform
        # maintains trailing stops itself and amends the resting stop order.
        return False


def build_tradier_broker(settings: Any, environment: BrokerEnvironment) -> TradierBroker:
    base_url, token, account_id = settings.broker_credentials(environment)
    return TradierBroker(
        base_url=base_url,
        token=token,
        account_id=account_id,
        environment=environment,
    )


def symbols_chunks(symbols: Iterable[str], size: int = 50) -> list[list[str]]:
    """Tradier accepts comma-separated symbol batches; keep requests bounded."""
    items = [s.upper() for s in symbols]
    return [items[i : i + size] for i in range(0, len(items), size)]
