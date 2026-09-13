"""Execution pipeline: validation, idempotency, fills and failure handling."""

from __future__ import annotations

import pytest

from algotrader.broker.base import BrokerUnavailable
from algotrader.database import Database, Repository
from algotrader.enums import (
    BrokerEnvironment,
    ExitReason,
    KillSwitchReason,
    OrderStatus,
    SignalDirection,
    SystemMode,
)
from algotrader.execution import ExecutionEngine
from algotrader.execution.orders import marketable_limit_price, slippage_bps
from algotrader.enums import OrderSide
from algotrader.portfolio.models import PortfolioState, Position
from algotrader.risk import KillSwitch, RiskEngine
from algotrader.risk.engine import EntryProposal
from algotrader.regime.classifier import RegimeState
from algotrader.enums import Regime, VolatilityRegime
from tests.conftest import make_quote
from tests.fakes import FakeBroker


@pytest.fixture()
async def database():
    db = Database("sqlite+aiosqlite:///:memory:")
    await db.create_all()
    yield db
    await db.close()


@pytest.fixture()
def broker():
    return FakeBroker(quotes={"AAPL": make_quote("AAPL", 100.0)})


@pytest.fixture()
def risk_engine(config):
    return RiskEngine(config, kill_switch=KillSwitch(), mode=SystemMode.PAPER_MODE)


@pytest.fixture()
async def engine(broker, database, config, risk_engine):
    return ExecutionEngine(
        broker=broker,
        repository=Repository(database),
        config=config,
        risk_engine=risk_engine,
        environment=BrokerEnvironment.PAPER,
        account_id="FAKE123",
    )


def regime_state():
    return RegimeState(
        regime=Regime.BULL_TREND,
        volatility_regime=VolatilityRegime.NORMAL,
        trend_regime=Regime.BULL_TREND,
        confidence=80.0,
        trend_strength=0.5,
        realized_vol=0.15,
        long_run_vol=0.15,
        benchmark_drawdown=0.0,
        atr_pct=0.02,
        symbol="SPY",
    )


def make_state(**kwargs) -> PortfolioState:
    defaults = dict(
        equity=100_000.0,
        cash=100_000.0,
        buying_power=100_000.0,
        high_water_mark=100_000.0,
        day_start_equity=100_000.0,
        week_start_equity=100_000.0,
    )
    defaults.update(kwargs)
    return PortfolioState(**defaults)


def approved_decision(risk_engine, state):
    proposal = EntryProposal(
        symbol="AAPL",
        direction=SignalDirection.LONG,
        score=0.6,
        confidence=80.0,
        reference_price=100.0,
        atr=2.0,
        annualised_volatility=0.25,
        average_daily_volume=30_000_000.0,
        average_dollar_volume=3_000_000_000.0,
        spread_bps=5.0,
        sector="technology",
    )
    decision = risk_engine.evaluate_entry(proposal, state, regime_state())
    assert decision.approved, decision.rejection_reasons
    return decision


# --------------------------------------------------------------------------- #
async def test_successful_entry_persists_order_fill_and_trade(engine, broker, risk_engine, database):
    state = make_state()
    decision = approved_decision(risk_engine, state)
    result = await engine.execute_entry(
        decision, broker.quotes["AAPL"], state, regime="BULL_TREND", strategy_scores={"score": 0.6}
    )
    assert result.submitted and result.filled
    assert result.trade_id is not None
    repo = Repository(database)
    order = await repo.get_order_by_client_id(
        (await repo.recent_orders(1))[0].client_order_id
    )
    assert order.status == str(OrderStatus.FILLED)
    assert order.decision["approved"] is True          # full risk audit stored
    assert (await repo.execution_quality())[0].symbol == "AAPL"


async def test_order_is_persisted_before_submission(engine, broker, risk_engine, database):
    """If the broker call explodes, the intent must still be on record."""
    state = make_state()
    decision = approved_decision(risk_engine, state)
    broker.fail_next_place = BrokerUnavailable("network gone")
    result = await engine.execute_entry(decision, broker.quotes["AAPL"], state)
    assert not result.submitted
    orders = await Repository(database).recent_orders(5)
    assert orders and orders[0].symbol == "AAPL"
    assert orders[0].status in (str(OrderStatus.ERROR), str(OrderStatus.PENDING_SUBMIT))


async def test_broker_failure_trips_the_kill_switch(engine, broker, risk_engine):
    state = make_state()
    decision = approved_decision(risk_engine, state)
    broker.fail_next_place = BrokerUnavailable("network gone")
    await engine.execute_entry(decision, broker.quotes["AAPL"], state)
    assert KillSwitchReason.BROKER_UNAVAILABLE in risk_engine.kill_switch.reasons


async def test_repeated_rejections_trip_the_kill_switch(engine, broker, risk_engine):
    broker._supports_brackets = False       # a plain rejection, with no bracket fallback
    state = make_state()
    for attempt in range(3):
        decision = approved_decision(risk_engine, state)
        broker.reject_next_place = "insufficient buying power"
        engine._decision_key = lambda now=None, bucket=attempt: f"bucket-{bucket}"
        result = await engine.execute_entry(decision, broker.quotes["AAPL"], state)
        assert not result.submitted
    assert KillSwitchReason.EXECUTION_ERRORS in risk_engine.kill_switch.reasons


async def test_duplicate_intent_is_suppressed(engine, broker, risk_engine):
    state = make_state()
    decision = approved_decision(risk_engine, state)
    first = await engine.execute_entry(decision, broker.quotes["AAPL"], state)
    second = await engine.execute_entry(decision, broker.quotes["AAPL"], state)
    assert first.submitted
    assert second.duplicate and not second.submitted
    assert len(broker.placed) == 1


async def test_kill_switch_blocks_new_entries(engine, broker, risk_engine):
    state = make_state()
    decision = approved_decision(risk_engine, state)
    risk_engine.kill_switch.trip(KillSwitchReason.DAILY_LOSS_LIMIT, "limit hit")
    result = await engine.execute_entry(decision, broker.quotes["AAPL"], state)
    assert not result.submitted and any("kill switch" in r for r in result.blocked_reasons)
    assert not broker.placed


async def test_kill_switch_does_not_block_exits(engine, broker, risk_engine):
    """Getting out of risk must always be possible."""
    risk_engine.kill_switch.trip(KillSwitchReason.DRAWDOWN_LIMIT, "drawdown")
    broker.set_position("AAPL", 50, 100.0)
    position = Position(symbol="AAPL", quantity=50, average_price=100.0, current_price=99.0)
    result = await engine.execute_exit(position, broker.quotes["AAPL"], ExitReason.STOP_LOSS, "stop hit")
    assert result.submitted


async def test_closed_market_blocks_orders(engine, broker, risk_engine):
    state = make_state()
    decision = approved_decision(risk_engine, state)
    result = await engine.execute_entry(decision, broker.quotes["AAPL"], state, market_open=False)
    assert not result.submitted and "market is closed" in result.message


async def test_stale_quote_blocks_orders(engine, broker, risk_engine):
    from datetime import timedelta

    from algotrader.broker.base import Quote
    from algotrader.utils.timeutils import utc_now

    state = make_state()
    decision = approved_decision(risk_engine, state)
    stale = Quote(
        symbol="AAPL", bid=99.9, ask=100.1, last=100.0, timestamp=utc_now() - timedelta(minutes=10)
    )
    result = await engine.execute_entry(decision, stale, state)
    assert not result.submitted and any("old" in r for r in result.blocked_reasons)


async def test_insufficient_buying_power_blocks(engine, broker, risk_engine):
    state = make_state()
    decision = approved_decision(risk_engine, state)
    poor_state = make_state(buying_power=10.0)
    result = await engine.execute_entry(decision, broker.quotes["AAPL"], poor_state)
    assert not result.submitted and any("buying power" in r for r in result.blocked_reasons)


async def test_existing_position_blocks_entry(engine, broker, risk_engine):
    state = make_state()
    decision = approved_decision(risk_engine, state)
    state.positions["AAPL"] = Position(symbol="AAPL", quantity=10, average_price=100.0)
    result = await engine.execute_entry(decision, broker.quotes["AAPL"], state)
    assert not result.submitted and any("already open" in r for r in result.blocked_reasons)


async def test_unapproved_decision_is_never_submitted(engine, broker, risk_engine):
    state = make_state()
    decision = approved_decision(risk_engine, state)
    rejected = decision.__class__(
        approved=False, symbol="AAPL", direction=SignalDirection.LONG, quantity=10
    )
    result = await engine.execute_entry(rejected, broker.quotes["AAPL"], state)
    assert not result.submitted and not broker.placed


async def test_partial_fill_is_recorded(engine, broker, risk_engine, database):
    state = make_state()
    decision = approved_decision(risk_engine, state)
    broker.fill_mode = "partial"
    result = await engine.execute_entry(decision, broker.quotes["AAPL"], state)
    assert result.submitted
    assert 0 < result.filled_quantity < decision.quantity
    assert result.status is OrderStatus.PARTIALLY_FILLED
    trades = await Repository(database).open_trades()
    assert trades and trades[0].quantity == result.filled_quantity


async def test_bracket_rejection_falls_back_to_plain_order(engine, broker, risk_engine):
    state = make_state()
    decision = approved_decision(risk_engine, state)
    broker.reject_next_place = "OTOCO not supported in sandbox"
    result = await engine.execute_entry(decision, broker.quotes["AAPL"], state)
    assert result.submitted, result.message
    assert broker.placed[-1].order_class.value == "equity"


async def test_exit_closes_the_trade_with_pnl(engine, broker, risk_engine, database):
    state = make_state()
    decision = approved_decision(risk_engine, state)
    entry = await engine.execute_entry(decision, broker.quotes["AAPL"], state)
    position = Position(
        symbol="AAPL",
        quantity=entry.filled_quantity,
        average_price=entry.average_fill_price,
        current_price=110.0,
        trade_id=entry.trade_id,
    )
    broker.quotes["AAPL"] = make_quote("AAPL", 110.0)
    result = await engine.execute_exit(
        position, broker.quotes["AAPL"], ExitReason.TAKE_PROFIT, "target reached"
    )
    assert result.submitted and result.filled
    trades = await Repository(database).closed_trades()
    assert trades and trades[0].realized_pnl > 0
    assert trades[0].exit_reason == str(ExitReason.TAKE_PROFIT)
    assert trades[0].r_multiple is not None


async def test_slippage_is_measured_against_the_expected_price(engine, broker, risk_engine, database):
    state = make_state()
    decision = approved_decision(risk_engine, state)
    broker.fill_price_offset = 0.50        # filled 50c worse than quoted
    result = await engine.execute_entry(decision, broker.quotes["AAPL"], state)
    assert result.slippage_bps > 0
    records = await Repository(database).execution_quality()
    assert records[0].slippage_bps == pytest.approx(result.slippage_bps, rel=0.01)


async def test_working_order_sync_updates_state(engine, broker, risk_engine, database):
    from algotrader.broker.base import BrokerOrder

    state = make_state()
    decision = approved_decision(risk_engine, state)
    broker.fill_mode = "open"
    result = await engine.execute_entry(decision, broker.quotes["AAPL"], state)
    assert result.status is OrderStatus.OPEN
    order_id = result.broker_order_id
    broker.orders[order_id] = BrokerOrder(
        order_id=order_id,
        symbol="AAPL",
        side=OrderSide.BUY,
        quantity=decision.quantity,
        status=OrderStatus.FILLED,
        filled_quantity=decision.quantity,
        average_fill_price=100.2,
    )
    updates = await engine.sync_working_orders()
    assert updates and updates[0]["status"] == str(OrderStatus.FILLED)


# --------------------------------------------------------------------------- #
def test_marketable_limit_prices():
    quote = make_quote("AAPL", 100.0, spread_bps=10.0)
    buy = marketable_limit_price(quote, OrderSide.BUY, 10.0)
    sell = marketable_limit_price(quote, OrderSide.SELL, 10.0)
    assert buy > quote.ask and sell < quote.bid


def test_slippage_sign_convention():
    assert slippage_bps(100.0, 100.5, OrderSide.BUY) == pytest.approx(50.0)
    assert slippage_bps(100.0, 99.5, OrderSide.SELL) == pytest.approx(50.0)
    assert slippage_bps(100.0, 99.5, OrderSide.BUY) == pytest.approx(-50.0)
