"""The live gate never opens by itself."""

from __future__ import annotations

from algotrader.config import Settings
from algotrader.enums import BrokerEnvironment, SystemMode
from algotrader.risk.live_gate import evaluate_live_gate

GOOD_RECORD = {
    "trades": 250,
    "days_operating": 90,
    "max_drawdown": 0.05,
    "expectancy_r": 0.12,
    "profit_factor": 1.6,
    "win_rate": 0.45,
    "sharpe": 1.1,
}


def test_empty_record_fails_every_criterion(config, settings):
    report = evaluate_live_gate(config, settings, {"trades": 0})
    assert report.eligible is False
    assert len(report.blocking) >= 4
    assert report.active_environment is BrokerEnvironment.PAPER


def test_good_record_is_eligible_but_still_not_live(config, settings):
    report = evaluate_live_gate(config, settings, GOOD_RECORD)
    assert report.eligible is True
    # Eligible is not enabled: configuration and environment switches still block.
    assert report.live_enabled is False
    assert any("live_gate.enabled" in reason for reason in report.blocking)
    assert any("ENABLE_LIVE_TRADING" in reason for reason in report.blocking)


def test_each_criterion_can_block(config, settings):
    for key, value in (
        ("trades", 10),
        ("days_operating", 1),
        ("max_drawdown", 0.5),
        ("expectancy_r", -0.2),
        ("profit_factor", 0.8),
        ("win_rate", 0.1),
        ("sharpe", 0.0),
    ):
        record = GOOD_RECORD | {key: value}
        report = evaluate_live_gate(config, settings, record)
        assert report.eligible is False, key


def test_degraded_health_blocks(config, settings):
    report = evaluate_live_gate(config, settings, GOOD_RECORD, health_ok=False)
    assert report.eligible is False
    assert any(c.name == "system_health" and not c.passed for c in report.criteria)


def test_fully_configured_live_reports_enabled(config):
    live_config = config.model_copy(
        update={
            "system": config.system.model_copy(update={"mode": SystemMode.LIVE_MODE}),
            "live_gate": config.live_gate.model_copy(update={"enabled": True}),
        }
    )
    settings = Settings(
        _env_file=None,
        enable_live_trading=True,
        tradier_live_token="token",
        tradier_live_account_id="ACC",
    )
    report = evaluate_live_gate(live_config, settings, GOOD_RECORD)
    assert report.eligible is True
    assert report.live_enabled is True
    assert report.blocking == []
    assert "will not switch itself" in report.instructions
