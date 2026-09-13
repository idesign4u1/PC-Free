"""Portfolio state, exposure maths and broker reconciliation."""

from __future__ import annotations

import numpy as np
import pytest

from algotrader.market_data.series import BarSeries
from algotrader.portfolio import PortfolioManager, PortfolioState, Position
from algotrader.utils.timeutils import utc_now
from tests.conftest import make_quote
from tests.fakes import FakeBroker, synthetic_bars


def test_position_pnl_and_r_multiple():
    position = Position(
        symbol="AAPL", quantity=100, average_price=100.0, current_price=110.0,
        stop_price=95.0, risk_per_share=5.0
    )
    assert position.market_value == pytest.approx(11_000.0)
    assert position.unrealized_pnl == pytest.approx(1_000.0)
    assert position.r_multiple == pytest.approx(2.0)
    assert position.open_risk == pytest.approx(1_500.0)


def test_position_open_risk_after_stop_moves_into_profit():
    position = Position(
        symbol="AAPL", quantity=100, average_price=100.0, current_price=120.0,
        stop_price=105.0, risk_per_share=5.0
    )
    # Risk is now measured to the raised stop, not to the entry.
    assert position.open_risk == pytest.approx(1_500.0)


def test_portfolio_exposure_and_drawdown():
    state = PortfolioState(
        equity=90_000.0,
        cash=40_000.0,
        buying_power=40_000.0,
        positions={
            "AAPL": Position(symbol="AAPL", quantity=100, average_price=100.0, current_price=100.0,
                             sector="technology"),
            "XOM": Position(symbol="XOM", quantity=200, average_price=100.0, current_price=100.0,
                            sector="energy"),
        },
        high_water_mark=100_000.0,
        day_start_equity=95_000.0,
        week_start_equity=100_000.0,
        sector_map={"AAPL": "technology", "XOM": "energy"},
    )
    assert state.gross_exposure == pytest.approx(30_000.0)
    assert state.exposure_pct == pytest.approx(1 / 3)
    assert state.drawdown == pytest.approx(0.10)
    assert state.daily_pnl_pct == pytest.approx(-5_000 / 95_000)
    assert state.sector_exposure("technology") == pytest.approx(10_000 / 90_000)
    assert sorted(state.sector_exposures()) == ["energy", "technology"]


def test_high_water_mark_only_rises():
    state = PortfolioState(equity=100_000.0, cash=0.0, buying_power=0.0, high_water_mark=120_000.0)
    assert state.high_water_mark == 120_000.0
    assert state.drawdown == pytest.approx(1 / 6)


async def test_refresh_merges_broker_truth_with_local_metadata(config):
    broker = FakeBroker(quotes={"AAPL": make_quote("AAPL", 110.0)})
    broker.set_position("AAPL", 100, 100.0)
    manager = PortfolioManager(broker, config.universe)
    manager.track(
        Position(
            symbol="AAPL", quantity=100, average_price=100.0, stop_price=95.0,
            risk_per_share=5.0, strategy="ensemble", trade_id=7,
        )
    )
    state = await manager.refresh(broker.quotes)
    position = state.positions["AAPL"]
    assert position.quantity == 100                      # broker is the source of truth
    assert position.stop_price == 95.0                   # metadata survives
    assert position.trade_id == 7
    assert position.current_price == pytest.approx(110.0)
    assert position.sector == config.universe.sector_of("AAPL")


async def test_reconciliation_detects_unexpected_positions(config):
    broker = FakeBroker()
    broker.set_position("TSLA", 50, 200.0)
    manager = PortfolioManager(broker, config.universe)
    result = await manager.reconcile()
    assert result.unexpected_positions == ["TSLA"]
    assert not result.is_consistent
    assert "TSLA" in result.describe()


async def test_reconciliation_detects_quantity_mismatch(config):
    broker = FakeBroker()
    broker.set_position("AAPL", 50, 100.0)
    manager = PortfolioManager(broker, config.universe)
    manager.track(Position(symbol="AAPL", quantity=100, average_price=100.0))
    result = await manager.reconcile()
    assert "AAPL" in result.quantity_mismatches


async def test_reconciliation_clean_state(config):
    broker = FakeBroker()
    broker.set_position("AAPL", 100, 100.0)
    manager = PortfolioManager(broker, config.universe)
    manager.track(Position(symbol="AAPL", quantity=100, average_price=100.0))
    assert (await manager.reconcile()).is_consistent


async def test_correlated_exposure(config):
    base = list(100 * np.exp(np.cumsum(np.random.default_rng(1).normal(0.0005, 0.01, 200))))
    correlated = [p * 1.5 for p in base]
    independent = list(50 + np.random.default_rng(9).normal(0, 1, 200).cumsum() * 0.2)
    series = {
        "AAA": BarSeries.from_bars("AAA", synthetic_bars("AAA", base)),
        "BBB": BarSeries.from_bars("BBB", synthetic_bars("BBB", correlated)),
        "CCC": BarSeries.from_bars("CCC", synthetic_bars("CCC", independent)),
    }
    broker = FakeBroker()
    manager = PortfolioManager(broker, config.universe)
    manager.state = PortfolioState(
        equity=100_000.0,
        cash=0.0,
        buying_power=0.0,
        positions={
            "BBB": Position(symbol="BBB", quantity=100, average_price=100.0, current_price=100.0),
            "CCC": Position(symbol="CCC", quantity=100, average_price=50.0, current_price=50.0),
        },
    )
    exposure, correlations = manager.correlated_exposure("AAA", series, threshold=0.7, lookback=90)
    assert correlations["BBB"] > 0.9
    assert exposure == pytest.approx(0.10)     # only the correlated name counts


async def test_register_fill_and_close_tracks_streaks(config):
    manager = PortfolioManager(FakeBroker(), config.universe)
    manager.state = PortfolioState(equity=100_000.0, cash=100_000.0, buying_power=100_000.0)
    manager.register_fill(
        Position(symbol="AAPL", quantity=10, average_price=100.0, current_price=100.0), risk_amount=500.0
    )
    assert manager.state.risk_opened_today == 500.0
    manager.register_close("AAPL", -200.0)
    assert manager.state.consecutive_losses == 1
    manager.register_close("MSFT", 300.0)
    assert manager.state.consecutive_losses == 0
