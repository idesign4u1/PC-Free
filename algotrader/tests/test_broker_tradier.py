"""Tradier adapter tests. Every HTTP call is mocked - no network, ever."""

from __future__ import annotations

from datetime import timedelta

import httpx
import pytest
import respx

from algotrader.broker.base import (
    BrokerAuthError,
    BrokerUnavailable,
    OrderRequest,
)
from algotrader.broker.tradier import TradierBroker
from algotrader.enums import BrokerEnvironment, OrderClass, OrderSide, OrderStatus, OrderType
from algotrader.utils.ids import order_tag
from algotrader.utils.timeutils import utc_now

BASE = "https://sandbox.tradier.com"
ACCOUNT = "VA000001"


def make_broker(**kwargs) -> TradierBroker:
    return TradierBroker(
        base_url=BASE,
        token="dummy-token",
        account_id=ACCOUNT,
        environment=BrokerEnvironment.PAPER,
        max_retries=2,
        **kwargs,
    )


def test_missing_credentials_raise():
    with pytest.raises(BrokerAuthError):
        TradierBroker(base_url=BASE, token="", account_id="", environment=BrokerEnvironment.PAPER)


@respx.mock
async def test_get_quotes_parses_single_and_multiple():
    respx.get(f"{BASE}/v1/markets/quotes").mock(
        return_value=httpx.Response(
            200,
            json={
                "quotes": {
                    "quote": [
                        {
                            "symbol": "AAPL",
                            "bid": 189.5,
                            "ask": 189.6,
                            "last": 189.55,
                            "volume": 40_000_000,
                            "average_volume": 55_000_000,
                            "trade_date": 1_757_000_000_000,
                            "bidsize": 3,
                            "asksize": 5,
                        }
                    ]
                }
            },
        )
    )
    broker = make_broker()
    quotes = await broker.get_quotes(["aapl"])
    await broker.close()
    assert quotes["AAPL"].mid == pytest.approx(189.55, abs=0.01)
    assert quotes["AAPL"].spread_bps == pytest.approx(5.28, abs=0.2)
    assert not quotes["AAPL"].is_crossed


@respx.mock
async def test_empty_collections_return_empty_lists():
    respx.get(f"{BASE}/v1/accounts/{ACCOUNT}/positions").mock(
        return_value=httpx.Response(200, json={"positions": "null"})
    )
    respx.get(f"{BASE}/v1/accounts/{ACCOUNT}/orders").mock(
        return_value=httpx.Response(200, json={"orders": "null"})
    )
    broker = make_broker()
    assert await broker.get_positions() == []
    assert await broker.get_orders() == []
    await broker.close()


@respx.mock
async def test_get_history_sorted_and_typed():
    respx.get(f"{BASE}/v1/markets/history").mock(
        return_value=httpx.Response(
            200,
            json={
                "history": {
                    "day": [
                        {"date": "2026-01-03", "open": 2, "high": 3, "low": 1, "close": 2.5, "volume": 10},
                        {"date": "2026-01-02", "open": 1, "high": 2, "low": 0.5, "close": 1.5, "volume": 20},
                    ]
                }
            },
        )
    )
    broker = make_broker()
    bars = await broker.get_history("AAPL", utc_now() - timedelta(days=5), utc_now())
    await broker.close()
    assert [b.close for b in bars] == [1.5, 2.5]


@respx.mock
async def test_place_order_verifies_acknowledgement():
    respx.get(f"{BASE}/v1/accounts/{ACCOUNT}/orders").mock(
        return_value=httpx.Response(200, json={"orders": "null"})
    )
    route = respx.post(f"{BASE}/v1/accounts/{ACCOUNT}/orders").mock(
        return_value=httpx.Response(200, json={"order": {"id": 987, "status": "ok"}})
    )
    respx.get(f"{BASE}/v1/accounts/{ACCOUNT}/orders/987").mock(
        return_value=httpx.Response(
            200,
            json={
                "order": {
                    "id": 987,
                    "symbol": "AAPL",
                    "side": "buy",
                    "quantity": 10,
                    "status": "open",
                    "type": "limit",
                    "price": 100.0,
                    "exec_quantity": 0,
                    "tag": order_tag("cid-1"),
                }
            },
        )
    )
    broker = make_broker()
    result = await broker.place_order(
        OrderRequest(
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=10,
            order_type=OrderType.LIMIT,
            limit_price=100.0,
            client_order_id="cid-1",
        )
    )
    await broker.close()
    assert result.accepted and result.order_id == "987" and result.status is OrderStatus.OPEN
    body = dict(httpx.QueryParams(route.calls[0].request.content.decode()))
    assert body["class"] == "equity" and body["type"] == "limit" and body["tag"] == order_tag("cid-1")


@respx.mock
async def test_place_order_detects_downstream_rejection_behind_http_200():
    """Tradier can answer 200/ok and still refuse the order downstream."""
    respx.get(f"{BASE}/v1/accounts/{ACCOUNT}/orders").mock(
        return_value=httpx.Response(200, json={"orders": "null"})
    )
    respx.post(f"{BASE}/v1/accounts/{ACCOUNT}/orders").mock(
        return_value=httpx.Response(200, json={"order": {"id": 55, "status": "ok"}})
    )
    respx.get(f"{BASE}/v1/accounts/{ACCOUNT}/orders/55").mock(
        return_value=httpx.Response(
            200,
            json={
                "order": {
                    "id": 55,
                    "symbol": "AAPL",
                    "side": "buy",
                    "quantity": 10,
                    "status": "rejected",
                    "reason_description": "Insufficient buying power",
                }
            },
        )
    )
    broker = make_broker()
    result = await broker.place_order(
        OrderRequest(symbol="AAPL", side=OrderSide.BUY, quantity=10, client_order_id="cid-2")
    )
    await broker.close()
    assert not result.accepted
    assert result.status is OrderStatus.REJECTED
    assert "Insufficient buying power" in result.message


@respx.mock
async def test_duplicate_client_order_id_is_suppressed():
    respx.get(f"{BASE}/v1/accounts/{ACCOUNT}/orders").mock(
        return_value=httpx.Response(
            200,
            json={
                "orders": {
                    "order": {
                        "id": 42,
                        "symbol": "AAPL",
                        "side": "buy",
                        "quantity": 10,
                        "status": "open",
                        "tag": order_tag("cid-dup"),
                    }
                }
            },
        )
    )
    post_route = respx.post(f"{BASE}/v1/accounts/{ACCOUNT}/orders")
    broker = make_broker()
    result = await broker.place_order(
        OrderRequest(symbol="AAPL", side=OrderSide.BUY, quantity=10, client_order_id="cid-dup")
    )
    await broker.close()
    assert result.duplicate and result.order_id == "42"
    assert not post_route.called, "a duplicate intent must never reach the broker twice"


@respx.mock
async def test_timeout_on_submit_reconciles_by_tag_instead_of_resending():
    respx.post(f"{BASE}/v1/accounts/{ACCOUNT}/orders").mock(
        side_effect=httpx.ReadTimeout("timed out")
    )
    orders_route = respx.get(f"{BASE}/v1/accounts/{ACCOUNT}/orders")
    orders_route.side_effect = [
        httpx.Response(200, json={"orders": "null"}),  # pre-submit idempotency probe
        httpx.Response(  # post-timeout reconciliation: the order did land
            200,
            json={
                "orders": {
                    "order": {
                        "id": 77,
                        "symbol": "AAPL",
                        "side": "buy",
                        "quantity": 5,
                        "status": "open",
                        "tag": order_tag("cid-timeout"),
                    }
                }
            },
        ),
    ]
    broker = make_broker()
    result = await broker.place_order(
        OrderRequest(symbol="AAPL", side=OrderSide.BUY, quantity=5, client_order_id="cid-timeout")
    )
    await broker.close()
    assert result.accepted and result.order_id == "77"
    assert "reconciliation" in result.message


@respx.mock
async def test_otoco_bracket_payload_matches_tradier_contract():
    respx.get(f"{BASE}/v1/accounts/{ACCOUNT}/orders").mock(
        return_value=httpx.Response(200, json={"orders": "null"})
    )
    route = respx.post(f"{BASE}/v1/accounts/{ACCOUNT}/orders").mock(
        return_value=httpx.Response(200, json={"order": {"id": 101, "status": "ok"}})
    )
    respx.get(f"{BASE}/v1/accounts/{ACCOUNT}/orders/101").mock(
        return_value=httpx.Response(
            200,
            json={"order": {"id": 101, "symbol": "AAPL", "side": "buy", "quantity": 10, "status": "open"}},
        )
    )
    broker = make_broker()
    result = await broker.place_order(
        OrderRequest(
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=10,
            order_type=OrderType.LIMIT,
            limit_price=100.0,
            order_class=OrderClass.OTOCO,
            take_profit_price=110.0,
            stop_loss_price=95.0,
            client_order_id="cid-otoco",
        )
    )
    await broker.close()
    assert result.accepted
    body = dict(httpx.QueryParams(route.calls[0].request.content.decode()))
    assert body["class"] == "otoco"
    assert body["side[0]"] == "buy" and body["price[0]"] == "100.00"
    assert body["side[1]"] == "sell" and body["type[1]"] == "limit" and body["price[1]"] == "110.00"
    assert body["side[2]"] == "sell" and body["type[2]"] == "stop" and body["stop[2]"] == "95.00"
    # Tradier requires the two OCO legs to use different order types.
    assert body["type[1]"] != body["type[2]"]


@respx.mock
async def test_auth_failure_is_not_retried():
    route = respx.get(f"{BASE}/v1/user/profile").mock(return_value=httpx.Response(401, json={}))
    broker = make_broker()
    assert await broker.health_check() is False
    await broker.close()
    assert route.call_count == 1


@respx.mock
async def test_server_errors_are_retried_then_raise():
    route = respx.get(f"{BASE}/v1/markets/quotes").mock(return_value=httpx.Response(503, text="down"))
    broker = make_broker()
    with pytest.raises(BrokerUnavailable):
        await broker.get_quotes(["AAPL"])
    await broker.close()
    assert route.call_count == 2  # max_retries=2


@respx.mock
async def test_rate_limit_headers_are_recorded():
    respx.get(f"{BASE}/v1/markets/clock").mock(
        return_value=httpx.Response(
            200,
            json={"clock": {"state": "open", "timestamp": 1_757_000_000, "description": "Market is open"}},
            headers={"X-Ratelimit-Allowed": "120", "X-Ratelimit-Used": "3", "X-Ratelimit-Available": "117"},
        )
    )
    broker = make_broker()
    clock = await broker.get_clock()
    await broker.close()
    assert clock.is_open
    assert broker.last_rate_limit["available"] == 117
