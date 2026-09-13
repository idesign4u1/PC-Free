"""API surface: read endpoints, auth on mutations, and the live-trading lock."""

from __future__ import annotations

import numpy as np
import pytest
from httpx import ASGITransport, AsyncClient

from algotrader.api.app import create_app
from algotrader.database import Database
from algotrader.enums import BrokerEnvironment, KillSwitchReason, SystemMode
from algotrader.trading import TradingSystem
from tests.conftest import make_quote
from tests.fakes import FakeBroker, synthetic_bars

STRONG = list(100 * np.exp(np.linspace(0, 0.55, 320)))
BENCH = list(400 * np.exp(np.linspace(0, 0.12, 320)))
TOKEN = {"X-API-Token": "test-api-token"}


@pytest.fixture()
async def system(config, settings):
    universe = config.universe.model_copy(
        update={
            "symbols": ["AAPL"],
            "sectors": {"AAPL": "technology", "SPY": "index"},
            "benchmark": "SPY",
        }
    )
    system_cfg = config.system.model_copy(update={"skip_first_minutes": 0, "skip_last_minutes": 0})
    loop_config = config.model_copy(update={"universe": universe, "system": system_cfg})
    broker = FakeBroker(
        quotes={"AAPL": make_quote("AAPL", float(STRONG[-1])), "SPY": make_quote("SPY", float(BENCH[-1]))},
        bars={"AAPL": synthetic_bars("AAPL", STRONG), "SPY": synthetic_bars("SPY", BENCH)},
    )
    database = Database("sqlite+aiosqlite:///:memory:")
    trading = TradingSystem(loop_config, settings, broker, database, BrokerEnvironment.PAPER)
    await trading.startup()
    await trading.run_cycle()
    yield trading
    await database.close()


@pytest.fixture()
async def client(system):
    app = create_app(system=system, run_trading_loop=False)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http


async def test_health(client):
    response = await client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["mode"] == str(SystemMode.PAPER_MODE)
    assert body["environment"] == "PAPER"


async def test_dashboard_renders(client):
    response = await client.get("/")
    assert response.status_code == 200 and "algotrader" in response.text


@pytest.mark.parametrize(
    "path",
    [
        "/api/status",
        "/api/portfolio",
        "/api/positions",
        "/api/orders",
        "/api/trades",
        "/api/pnl",
        "/api/risk",
        "/api/regime",
        "/api/signals",
        "/api/events",
        "/api/config",
        "/api/strategies",
        "/api/execution-quality",
        "/api/live-gate",
    ],
)
async def test_read_endpoints_respond(client, path):
    response = await client.get(path)
    assert response.status_code == 200, response.text
    assert isinstance(response.json(), dict)


async def test_status_contains_risk_state(client):
    body = (await client.get("/api/status")).json()
    assert body["portfolio"]["equity"] > 0
    assert body["risk"]["kill_switch"]["tripped"] is False
    assert body["regime"]["regime"]


async def test_config_endpoint_redacts_secrets(client):
    body = (await client.get("/api/config")).json()
    assert body["settings"]["tradier_paper_token"] == "***redacted***"
    assert body["settings"]["database_url"] == "***redacted***"
    assert "***redacted***" not in str(body["config"])   # trading config holds no secrets


async def test_trade_detail_exposes_full_reasoning(client):
    trades = (await client.get("/api/trades")).json()["trades"]
    assert trades
    detail = (await client.get(f"/api/trades/{trades[0]['id']}")).json()
    assert detail["why_entered"] and detail["why_this_size"] and detail["why_this_stop"]
    assert detail["risk_state"]["checks"]


async def test_mutations_require_a_token(client):
    response = await client.post("/api/kill-switch/trip", json={"reason": "MANUAL"})
    assert response.status_code == 401


async def test_kill_switch_can_be_tripped_and_cleared(client, system):
    tripped = await client.post(
        "/api/kill-switch/trip", json={"reason": "MANUAL", "note": "halt"}, headers=TOKEN
    )
    assert tripped.status_code == 200 and tripped.json()["tripped"] is True
    assert KillSwitchReason.MANUAL in system.risk.kill_switch.reasons
    cleared = await client.post(
        "/api/kill-switch/clear", json={"reason": "ALL", "note": "resume"}, headers=TOKEN
    )
    assert cleared.json()["tripped"] is False


async def test_live_mode_cannot_be_enabled_over_the_api(client, system):
    response = await client.post("/api/mode", json={"mode": "LIVE_MODE"}, headers=TOKEN)
    assert response.status_code == 403
    assert "cannot be enabled over the API" in response.json()["detail"]
    assert system.mode is not SystemMode.LIVE_MODE


async def test_safe_mode_can_be_set(client, system):
    response = await client.post("/api/mode", json={"mode": "SAFE_MODE"}, headers=TOKEN)
    assert response.status_code == 200
    assert system.risk.mode is SystemMode.SAFE_MODE


async def test_live_gate_blocks_without_a_track_record(client):
    body = (await client.get("/api/live-gate")).json()
    assert body["eligible_for_live"] is False
    assert body["live_trading_enabled"] is False
    assert "minimum_paper_trades" in body["blocking"]
    assert "ENABLE_LIVE_TRADING" in " ".join(body["blocking"])


async def test_run_cycle_endpoint(client):
    response = await client.post("/api/trading/cycle", headers=TOKEN)
    assert response.status_code == 200
    assert "regime" in response.json()


async def test_flatten_closes_positions(client, system):
    assert system.portfolio.state.positions
    response = await client.post("/api/trading/flatten", headers=TOKEN)
    assert response.status_code == 200
    assert response.json()["exits"]


async def test_backtest_endpoint(client):
    response = await client.post(
        "/api/backtest",
        json={"symbols": ["AAPL"], "days": 320, "include_trades": False},
        headers=TOKEN,
    )
    assert response.status_code == 200
    assert "metrics" in response.json()
