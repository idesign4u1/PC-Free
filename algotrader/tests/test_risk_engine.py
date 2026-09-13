"""Risk engine: the rules that protect capital.

These tests are the safety net for the whole platform - if one of them fails,
the system must not trade.
"""

from __future__ import annotations

from datetime import timedelta

import pytest

from algotrader.enums import (
    ExitReason,
    KillSwitchReason,
    Regime,
    SignalDirection,
    SystemMode,
    VolatilityRegime,
)
from algotrader.portfolio.models import PortfolioState, Position
from algotrader.regime.classifier import RegimeState
from algotrader.risk import EntryProposal, KillSwitch, RiskEngine
from algotrader.utils.timeutils import utc_now


@pytest.fixture()
def engine(config):
    return RiskEngine(config, kill_switch=KillSwitch(), mode=SystemMode.PAPER_MODE)


@pytest.fixture()
def regime():
    return RegimeState(
        regime=Regime.BULL_TREND,
        volatility_regime=VolatilityRegime.NORMAL,
        trend_regime=Regime.BULL_TREND,
        confidence=80.0,
        trend_strength=0.5,
        realized_vol=0.15,
        long_run_vol=0.15,
        benchmark_drawdown=0.01,
        atr_pct=0.015,
        symbol="SPY",
    )


def make_state(equity=100_000.0, **kwargs) -> PortfolioState:
    defaults = dict(
        equity=equity,
        cash=equity,
        buying_power=equity * 2,
        high_water_mark=equity,
        day_start_equity=equity,
        week_start_equity=equity,
    )
    defaults.update(kwargs)
    return PortfolioState(**defaults)


def make_proposal(**kwargs) -> EntryProposal:
    defaults = dict(
        symbol="AAPL",
        direction=SignalDirection.LONG,
        score=0.6,
        confidence=75.0,
        reference_price=100.0,
        atr=2.0,
        annualised_volatility=0.25,
        average_daily_volume=30_000_000.0,
        average_dollar_volume=3_000_000_000.0,
        spread_bps=5.0,
        sector="technology",
    )
    defaults.update(kwargs)
    return EntryProposal(**defaults)


def failed(decision) -> list[str]:
    return [c.name for c in decision.failed_checks]


# --------------------------------------------------------------------------- #
# happy path
# --------------------------------------------------------------------------- #
def test_clean_proposal_is_approved(engine, regime):
    decision = engine.evaluate_entry(make_proposal(), make_state(), regime)
    assert decision.approved, decision.rejection_reasons
    assert decision.quantity > 0
    assert decision.stop_price < decision.entry_price < decision.take_profit_price
    assert decision.risk_amount / 100_000.0 <= engine.risk.max_risk_per_trade_pct + 1e-9


def test_decision_is_fully_auditable(engine, regime):
    audit = engine.evaluate_entry(make_proposal(), make_state(), regime).audit()
    assert audit["checks"] and audit["sizing"] and audit["drawdown"]
    assert audit["sizing"]["binding_constraint"]
    assert audit["regime"] == "BULL_TREND"


def test_stop_is_atr_based_and_distance_capped(engine, regime):
    stop, target, why = engine.stop_and_target(100.0, 2.0, SignalDirection.LONG)
    assert stop == pytest.approx(95.0)          # 100 - 2.5 * 2
    assert target == pytest.approx(110.0)       # 100 + 5.0 * 2
    assert why["distance_capped"] is False
    # A huge ATR must be capped by max_stop_distance_pct (15%).
    stop, _, why = engine.stop_and_target(100.0, 40.0, SignalDirection.LONG)
    assert stop == pytest.approx(85.0)
    assert why["distance_capped"] is True


def test_risk_scales_with_confidence(engine, regime):
    low = engine.evaluate_entry(make_proposal(confidence=60.0, score=0.3), make_state(), regime)
    high = engine.evaluate_entry(make_proposal(confidence=95.0, score=0.9), make_state(), regime)
    assert high.quantity > low.quantity


# --------------------------------------------------------------------------- #
# hard prohibitions
# --------------------------------------------------------------------------- #
def test_never_averages_down(engine, regime):
    losing = Position(
        symbol="AAPL", quantity=100, average_price=120.0, current_price=100.0, stop_price=95.0
    )
    state = make_state(positions={"AAPL": losing})
    decision = engine.evaluate_entry(make_proposal(), state, regime)
    assert not decision.approved
    assert "no_averaging_down" in failed(decision)


def test_position_reversal_in_one_step_is_refused(engine, regime):
    long_position = Position(symbol="AAPL", quantity=100, average_price=100.0, current_price=101.0)
    state = make_state(positions={"AAPL": long_position})
    decision = engine.evaluate_entry(make_proposal(direction=SignalDirection.SHORT), state, regime)
    assert not decision.approved
    assert "no_position_flip" in failed(decision)


# --------------------------------------------------------------------------- #
# drawdown response
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "drawdown,expect_tier,expect_new_positions",
    [
        (0.00, "NORMAL", True),
        (0.04, "CAUTION", True),
        (0.07, "DEFENSIVE", True),
        (0.10, "LOCKDOWN", False),
        (0.15, "EMERGENCY", False),
    ],
)
def test_drawdown_tiers(engine, drawdown, expect_tier, expect_new_positions):
    assessment = engine.drawdown_controller.assess(drawdown)
    assert assessment.tier == expect_tier
    assert assessment.allow_new_positions is expect_new_positions


def test_exposure_falls_monotonically_as_drawdown_grows(engine, regime):
    sizes = []
    for drawdown in (0.0, 0.035, 0.065):
        equity = 100_000.0
        hwm = equity / (1 - drawdown)
        state = make_state(equity=equity, high_water_mark=hwm, day_start_equity=equity, week_start_equity=equity)
        decision = engine.evaluate_entry(make_proposal(confidence=90.0), state, regime)
        sizes.append(decision.quantity)
    assert sizes[0] > sizes[1] > sizes[2] > 0, sizes


def test_deep_drawdown_blocks_new_positions(engine, regime):
    equity = 100_000.0
    state = make_state(equity=equity, high_water_mark=equity / (1 - 0.10))
    decision = engine.evaluate_entry(make_proposal(confidence=99.0), state, regime)
    assert not decision.approved
    assert "drawdown_tier_allows_new_positions" in failed(decision)


def test_medium_drawdown_demands_higher_confidence(engine, regime):
    equity = 100_000.0
    state = make_state(equity=equity, high_water_mark=equity / (1 - 0.065))
    mediocre = engine.evaluate_entry(make_proposal(confidence=65.0), state, regime)
    excellent = engine.evaluate_entry(make_proposal(confidence=85.0, score=0.8), state, regime)
    assert not mediocre.approved and "drawdown_tier_confidence" in failed(mediocre)
    assert excellent.approved, excellent.rejection_reasons


def test_max_drawdown_breach_blocks_and_trips_kill_switch(engine, regime):
    equity = 100_000.0
    state = make_state(equity=equity, high_water_mark=equity / (1 - 0.13))
    decision = engine.evaluate_entry(make_proposal(), state, regime)
    assert not decision.approved and "max_drawdown" in failed(decision)
    engine.assess_portfolio(state)
    assert KillSwitchReason.DRAWDOWN_LIMIT in engine.kill_switch.reasons
    assert engine.mode is SystemMode.EMERGENCY_MODE


# --------------------------------------------------------------------------- #
# loss limits and kill switch
# --------------------------------------------------------------------------- #
def test_daily_loss_limit_blocks_entries(engine, regime):
    state = make_state(equity=97_500.0, day_start_equity=100_000.0, week_start_equity=100_000.0,
                       high_water_mark=100_000.0)
    decision = engine.evaluate_entry(make_proposal(), state, regime)
    assert "daily_loss_limit" in failed(decision)


def test_weekly_loss_limit_blocks_entries(engine, regime):
    state = make_state(equity=95_000.0, day_start_equity=95_500.0, week_start_equity=100_000.0,
                       high_water_mark=100_000.0)
    decision = engine.evaluate_entry(make_proposal(), state, regime)
    assert "weekly_loss_limit" in failed(decision)


def test_kill_switch_blocks_new_orders_but_is_explicit_to_clear(engine, regime):
    engine.kill_switch.trip(KillSwitchReason.BROKER_UNAVAILABLE, "broker down")
    decision = engine.evaluate_entry(make_proposal(), make_state(), regime)
    assert not decision.approved and "kill_switch" in failed(decision)
    assert engine.kill_switch.clear(KillSwitchReason.BROKER_UNAVAILABLE, note="restored")
    assert engine.evaluate_entry(make_proposal(), make_state(), regime).approved


def test_safe_mode_blocks_new_positions(config, regime):
    engine = RiskEngine(config, mode=SystemMode.SAFE_MODE)
    decision = engine.evaluate_entry(make_proposal(), make_state(), regime)
    assert not decision.approved and "system_mode" in failed(decision)


# --------------------------------------------------------------------------- #
# portfolio limits
# --------------------------------------------------------------------------- #
def test_max_open_positions(engine, regime):
    positions = {
        f"SYM{i}": Position(symbol=f"SYM{i}", quantity=10, average_price=100.0, current_price=100.0)
        for i in range(engine.risk.max_open_positions)
    }
    decision = engine.evaluate_entry(make_proposal(), make_state(positions=positions), regime)
    assert "max_open_positions" in failed(decision)


def test_sector_exposure_limit(engine, regime):
    positions = {
        "MSFT": Position(
            symbol="MSFT", quantity=250, average_price=100.0, current_price=100.0, sector="technology"
        )
    }
    state = make_state(positions=positions)
    state.sector_map = {"MSFT": "technology", "AAPL": "technology"}
    decision = engine.evaluate_entry(make_proposal(sector="technology"), state, regime)
    assert "sector_exposure_room" in failed(decision)


def test_correlated_exposure_limit(engine, regime):
    decision = engine.evaluate_entry(make_proposal(correlated_exposure_pct=0.35), make_state(), regime)
    assert "correlated_exposure_room" in failed(decision)


def test_gross_exposure_limit(engine, regime):
    positions = {
        "BIG": Position(symbol="BIG", quantity=600, average_price=100.0, current_price=100.0)
    }
    decision = engine.evaluate_entry(make_proposal(), make_state(positions=positions), regime)
    assert "portfolio_exposure_room" in failed(decision)


def test_daily_risk_budget_limit(engine, regime):
    state = make_state(risk_opened_today=2_500.0)  # 2.5% of equity, budget is 2%
    decision = engine.evaluate_entry(make_proposal(), state, regime)
    assert "daily_risk_budget" in failed(decision)


def test_buying_power_caps_size(engine, regime):
    state = make_state(buying_power=1_500.0)
    decision = engine.evaluate_entry(make_proposal(), state, regime)
    assert decision.quantity <= 15
    if decision.approved:
        assert decision.quantity * decision.entry_price <= 1_500.0


# --------------------------------------------------------------------------- #
# market quality filters
# --------------------------------------------------------------------------- #
def test_wide_spread_blocks(engine, regime):
    decision = engine.evaluate_entry(make_proposal(spread_bps=80.0), make_state(), regime)
    assert "max_spread" in failed(decision)


def test_illiquid_symbol_blocks(engine, regime):
    decision = engine.evaluate_entry(make_proposal(average_dollar_volume=1_000.0), make_state(), regime)
    assert "min_liquidity" in failed(decision)


def test_bad_data_blocks(engine, regime):
    decision = engine.evaluate_entry(
        make_proposal(data_quality_ok=False, data_quality_detail="stale quote"), make_state(), regime
    )
    assert "data_quality" in failed(decision)


def test_excessive_volatility_blocks(engine, regime):
    decision = engine.evaluate_entry(make_proposal(atr=12.0), make_state(), regime)
    assert "volatility_filter" in failed(decision)


def test_penny_stock_blocks(engine, regime):
    decision = engine.evaluate_entry(make_proposal(reference_price=2.0), make_state(), regime)
    assert "price_bounds" in failed(decision)


def test_poor_reward_risk_blocks(config, regime):
    config = config.model_copy(update={"risk": config.risk.model_copy(update={"reward_risk_min": 3.0})})
    engine = RiskEngine(config, mode=SystemMode.PAPER_MODE)
    decision = engine.evaluate_entry(make_proposal(), make_state(), regime)
    assert "reward_risk" in failed(decision)


# --------------------------------------------------------------------------- #
# cooldowns
# --------------------------------------------------------------------------- #
def test_cooldown_after_loss_blocks_symbol(engine, regime):
    engine.record_trade_result("AAPL", -500.0)
    decision = engine.evaluate_entry(make_proposal(), make_state(), regime)
    assert "cooldown" in failed(decision)


def test_global_cooldown_after_consecutive_losses(engine, regime):
    for symbol in ("AAA", "BBB", "CCC"):
        engine.record_trade_result(symbol, -100.0)
    decision = engine.evaluate_entry(make_proposal(symbol="ZZZ"), make_state(), regime)
    assert "cooldown" in failed(decision)
    assert engine.cooldowns.global_cooldown is not None


def test_winning_trade_resets_the_loss_streak(engine):
    engine.record_trade_result("AAA", -100.0)
    engine.record_trade_result("BBB", -100.0)
    engine.record_trade_result("CCC", 500.0)
    assert engine.cooldowns.consecutive_losses == 0


# --------------------------------------------------------------------------- #
# exits and trailing stops
# --------------------------------------------------------------------------- #
def position(**kwargs) -> Position:
    defaults = dict(
        symbol="AAPL",
        quantity=100,
        average_price=100.0,
        current_price=100.0,
        stop_price=95.0,
        initial_stop_price=95.0,
        take_profit_price=110.0,
        risk_per_share=5.0,
    )
    defaults.update(kwargs)
    return Position(**defaults)


def test_stop_loss_exit(engine):
    decision = engine.evaluate_exit(position(), price=94.5)
    assert decision.should_exit and decision.reason is ExitReason.STOP_LOSS
    assert decision.urgency == "immediate"


def test_take_profit_exit(engine):
    decision = engine.evaluate_exit(position(), price=111.0)
    assert decision.should_exit and decision.reason is ExitReason.TAKE_PROFIT


def test_time_stop_exit(engine):
    old = position(opened_at=utc_now() - timedelta(days=60))
    decision = engine.evaluate_exit(old, price=101.0)
    assert decision.should_exit and decision.reason is ExitReason.TIME_STOP


def test_signal_reversal_exit(engine):
    decision = engine.evaluate_exit(position(), price=101.0, signal_reversed=True)
    assert decision.should_exit and decision.reason is ExitReason.SIGNAL_REVERSAL


def test_healthy_position_is_held(engine):
    assert not engine.evaluate_exit(position(), price=103.0).should_exit


def test_emergency_mode_exits_everything(config):
    engine = RiskEngine(config, mode=SystemMode.EMERGENCY_MODE)
    decision = engine.evaluate_exit(position(), price=105.0)
    assert decision.should_exit and decision.reason is ExitReason.EMERGENCY


def test_trailing_stop_only_moves_up(engine):
    pos = position()
    pos.mark(108.0)                     # +1.6R, trailing activates at +1R
    new_stop = engine.trailing_stop_price(pos, atr=2.0)
    assert new_stop is not None and new_stop > 95.0
    pos.stop_price = new_stop
    pos.mark(104.0)                     # price falls back
    assert engine.trailing_stop_price(pos, atr=2.0) is None


def test_trailing_stop_waits_for_the_activation_threshold(engine):
    pos = position()
    pos.mark(102.0)                     # +0.4R only
    assert engine.trailing_stop_price(pos, atr=2.0) is None


def test_trailing_stop_exit_is_labelled_as_trailing(engine):
    pos = position(stop_price=103.0, initial_stop_price=95.0)
    decision = engine.evaluate_exit(pos, price=102.0)
    assert decision.should_exit and decision.reason is ExitReason.TRAILING_STOP


# --------------------------------------------------------------------------- #
# monitoring surface
# --------------------------------------------------------------------------- #
def test_risk_utilisation_reports_every_limit(engine):
    state = make_state(equity=98_000.0, day_start_equity=100_000.0, high_water_mark=100_000.0)
    utilisation = engine.risk_utilisation(state)
    assert utilisation["daily_loss"] == pytest.approx(1.0, abs=0.01)
    assert set(utilisation) >= {
        "gross_exposure",
        "open_positions",
        "daily_loss",
        "weekly_loss",
        "drawdown",
        "drawdown_tier",
        "kill_switch",
        "cooldowns",
    }


def test_decision_audit_is_json_serialisable(engine, regime):
    """Audit payloads are written to JSON columns - numpy scalars would break that."""
    import json

    import numpy as np

    decision = engine.evaluate_entry(
        make_proposal(
            atr=float(np.float64(2.0)),
            annualised_volatility=float(np.float64(0.25)),
            average_daily_volume=float(np.float64(30_000_000.0)),
        ),
        make_state(),
        regime,
    )
    payload = json.dumps(decision.audit())
    assert "sizing" in payload
