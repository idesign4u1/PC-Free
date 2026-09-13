"""End-to-end trading cycle against an in-memory broker and database."""

from __future__ import annotations

import numpy as np
import pytest

from algotrader.database import Database, Repository
from algotrader.enums import BrokerEnvironment, KillSwitchReason, SystemMode
from algotrader.trading import TradingSystem
from tests.conftest import make_quote
from tests.fakes import FakeBroker, synthetic_bars

STRONG = list(100 * np.exp(np.linspace(0, 0.55, 320)))
BENCH = list(400 * np.exp(np.linspace(0, 0.12, 320)))
WEAK = list(50 * np.exp(np.linspace(0.10, 0.0, 320)))


@pytest.fixture()
def loop_config(config):
    universe = config.universe.model_copy(
        update={
            "symbols": ["AAPL", "MSFT"],
            "sectors": {"AAPL": "technology", "MSFT": "technology", "SPY": "index"},
            "benchmark": "SPY",
        }
    )
    system = config.system.model_copy(update={"skip_first_minutes": 0, "skip_last_minutes": 0})
    return config.model_copy(update={"universe": universe, "system": system})


@pytest.fixture()
def broker():
    return FakeBroker(
        quotes={
            "AAPL": make_quote("AAPL", float(STRONG[-1])),
            "MSFT": make_quote("MSFT", float(WEAK[-1])),
            "SPY": make_quote("SPY", float(BENCH[-1])),
        },
        bars={
            "AAPL": synthetic_bars("AAPL", STRONG),
            "MSFT": synthetic_bars("MSFT", WEAK),
            "SPY": synthetic_bars("SPY", BENCH),
        },
        equity=100_000.0,
        cash=100_000.0,
    )


@pytest.fixture()
async def system(loop_config, settings, broker):
    database = Database("sqlite+aiosqlite:///:memory:")
    trading = TradingSystem(loop_config, settings, broker, database, BrokerEnvironment.PAPER)
    await trading.startup()
    yield trading
    await database.close()


async def test_cycle_runs_and_classifies_the_regime(system):
    report = await system.run_cycle()
    assert report.market_open
    assert report.regime
    assert report.symbols_evaluated == 3        # AAPL, MSFT and the benchmark
    assert not report.errors, report.errors


async def test_cycle_opens_a_position_for_the_strongest_symbol(system, broker):
    report = await system.run_cycle()
    assert report.entries, {"blocked": report.blocked, "notes": report.notes}
    entry = report.entries[0]
    assert entry["symbol"] == "AAPL" and entry["submitted"]
    assert system.portfolio.state.has_position("AAPL")


async def test_entry_is_persisted_with_its_full_reasoning(system):
    await system.run_cycle()
    repo = Repository(system.database)
    trades = await repo.open_trades()
    assert trades, "an open trade should have been recorded"
    trade = trades[0]
    assert trade.entry_reason and trade.sizing_reason and trade.risk_state
    assert trade.regime_at_entry
    assert trade.risk_state["checks"], "the risk checks must be part of the audit trail"
    assert trade.stop_price and trade.stop_price < trade.entry_price


async def test_weak_symbol_is_not_traded(system):
    report = await system.run_cycle()
    assert all(entry["symbol"] != "MSFT" for entry in report.entries)


async def test_second_cycle_does_not_add_to_the_position(system, broker):
    await system.run_cycle()
    placed_after_first = len(broker.placed)
    report = await system.run_cycle()
    assert len(broker.placed) == placed_after_first
    assert any("AAPL" in str(item) for item in report.blocked) or not report.entries


async def test_kill_switch_stops_new_entries(system):
    system.risk.kill_switch.trip(KillSwitchReason.MANUAL, "manual halt")
    report = await system.run_cycle()
    assert not any(entry.get("submitted") for entry in report.entries)


async def test_closed_market_monitors_but_does_not_trade(system, broker):
    broker.market_open = False
    report = await system.run_cycle()
    assert not report.market_open
    assert not report.entries
    assert any("market closed" in note for note in report.notes)


async def test_stop_breach_closes_the_position(system, broker):
    await system.run_cycle()
    position = system.portfolio.state.positions["AAPL"]
    stop = position.stop_price
    assert stop
    crashed = float(stop) * 0.95
    broker.quotes["AAPL"] = make_quote("AAPL", crashed)
    broker.bars["AAPL"] = synthetic_bars("AAPL", STRONG + [crashed])
    system.market_data.clear_cache()

    report = await system.run_cycle()
    assert report.exits, report.notes
    assert report.exits[0]["reason"].endswith("STOP_LOSS")
    assert not system.portfolio.state.has_position("AAPL")
    trades = await Repository(system.database).closed_trades()
    assert trades and trades[0].exit_reason.endswith("STOP_LOSS")
    assert trades[0].realized_pnl < 0


async def test_loss_starts_a_cooldown(system, broker):
    await system.run_cycle()
    position = system.portfolio.state.positions["AAPL"]
    broker.quotes["AAPL"] = make_quote("AAPL", float(position.stop_price) * 0.95)
    system.market_data.clear_cache()
    await system.run_cycle()
    assert system.risk.cooldowns.blocked_reason("AAPL") is not None


async def test_unexpected_broker_position_trips_the_kill_switch(system, broker):
    broker.set_position("TSLA", 100, 250.0)
    report = await system.run_cycle()
    assert KillSwitchReason.UNEXPECTED_POSITIONS in system.risk.kill_switch.reasons
    assert any("unexpected" in error for error in report.errors)


async def test_broker_outage_trips_the_kill_switch_and_recovers(system, broker):
    broker.unavailable = True
    await system.run_cycle()
    assert KillSwitchReason.BROKER_UNAVAILABLE in system.risk.kill_switch.reasons
    broker.unavailable = False
    report = await system.run_cycle()
    assert KillSwitchReason.BROKER_UNAVAILABLE not in system.risk.kill_switch.reasons
    assert any("restored" in note for note in report.notes)


async def test_snapshots_and_opportunities_are_recorded(system):
    await system.run_cycle()
    repo = Repository(system.database)
    assert await repo.latest_portfolio_snapshot() is not None
    assert await repo.recent_opportunities()
    assert await repo.daily_pnl_history()


async def test_status_payload_is_dashboard_ready(system):
    await system.run_cycle()
    status = system.status()
    assert status["mode"] == str(SystemMode.PAPER_MODE)
    assert status["environment"] == str(BrokerEnvironment.PAPER)
    assert status["portfolio"]["equity"] > 0
    assert status["risk"]["drawdown_tier"]["tier"] == "NORMAL"
    assert status["last_cycle"]["regime"]


async def test_restart_restores_open_positions_and_high_water_mark(system, broker, loop_config, settings):
    await system.run_cycle()
    hwm = system.portfolio.state.high_water_mark
    restarted = TradingSystem(loop_config, settings, broker, system.database, BrokerEnvironment.PAPER)
    await restarted.startup()
    assert restarted.portfolio.tracked("AAPL") is not None
    assert restarted.portfolio.state.high_water_mark >= hwm * 0.99
