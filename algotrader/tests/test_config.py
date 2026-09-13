"""Configuration safety: conservative defaults and impossible-to-ignore live switches."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from algotrader.config import AppConfig, RiskConfig, Settings, load_config
from algotrader.enums import BrokerEnvironment, SystemMode


def test_defaults_are_paper_and_conservative(config):
    assert config.system.mode is SystemMode.PAPER_MODE
    assert config.live_gate.enabled is False
    assert config.risk.max_risk_per_trade_pct <= 0.01
    assert config.risk.max_portfolio_exposure_pct <= 1.0
    assert config.signals.long_only is True


def test_live_requires_every_switch(config):
    """Mode alone, or the flag alone, must never produce a live environment."""
    live_config = config.model_copy(
        update={"system": config.system.model_copy(update={"mode": SystemMode.LIVE_MODE})}
    )
    plain = Settings(_env_file=None)
    assert live_config.resolve_broker_environment(plain) is BrokerEnvironment.PAPER
    assert live_config.effective_mode(plain) is SystemMode.PAPER_MODE

    flagged = Settings(_env_file=None, enable_live_trading=True)
    assert live_config.resolve_broker_environment(flagged) is BrokerEnvironment.PAPER  # no gate, no creds

    gated = live_config.model_copy(
        update={"live_gate": live_config.live_gate.model_copy(update={"enabled": True})}
    )
    assert gated.resolve_broker_environment(flagged) is BrokerEnvironment.PAPER  # still no credentials

    credentialed = Settings(
        _env_file=None,
        enable_live_trading=True,
        tradier_live_token="token",
        tradier_live_account_id="ACC",
    )
    assert gated.resolve_broker_environment(credentialed) is BrokerEnvironment.LIVE


def test_paper_mode_ignores_live_credentials(config):
    settings = Settings(
        _env_file=None,
        enable_live_trading=True,
        tradier_live_token="token",
        tradier_live_account_id="ACC",
    )
    assert config.resolve_broker_environment(settings) is BrokerEnvironment.PAPER


def test_drawdown_tiers_must_not_increase_size(config):
    bad = config.risk.model_dump()
    bad["drawdown_tiers"] = [
        {"name": "A", "min_drawdown": 0.0, "size_multiplier": 0.5, "min_confidence": 50.0,
         "allow_new_positions": True},
        {"name": "B", "min_drawdown": 0.05, "size_multiplier": 0.9, "min_confidence": 50.0,
         "allow_new_positions": True},
    ]
    with pytest.raises(ValidationError, match="must not increase size"):
        RiskConfig.model_validate(bad)


def test_drawdown_tiers_must_start_at_zero(config):
    bad = config.risk.model_dump()
    bad["drawdown_tiers"] = [
        {"name": "A", "min_drawdown": 0.02, "size_multiplier": 1.0, "min_confidence": 50.0,
         "allow_new_positions": True}
    ]
    with pytest.raises(ValidationError, match="must start at 0.0"):
        RiskConfig.model_validate(bad)


def test_target_must_exceed_stop(config):
    bad = config.risk.model_dump()
    bad["atr_target_multiple"] = 1.0
    bad["atr_stop_multiple"] = 3.0
    with pytest.raises(ValidationError, match="atr_target_multiple"):
        RiskConfig.model_validate(bad)


def test_unknown_keys_are_rejected():
    with pytest.raises(ValidationError):
        AppConfig.model_validate(
            {"strategies": {"weights": {"trend_following": 1.0}}, "risk": {}, "nonsense": 1}
        )


def test_config_hash_changes_with_configuration(config):
    other = config.model_copy(
        update={"risk": config.risk.model_copy(update={"max_risk_per_trade_pct": 0.004})}
    )
    assert config.config_hash() != other.config_hash()
    assert config.config_hash() == config.model_copy().config_hash()


def test_settings_redaction():
    settings = Settings(_env_file=None, tradier_paper_token="secret", api_token="also-secret")
    dumped = settings.safe_dump()
    assert dumped["tradier_paper_token"] == "***redacted***"
    assert dumped["api_token"] == "***redacted***"
    assert "secret" not in str(dumped)


def test_tier_lookup(config):
    assert config.risk.tier_for_drawdown(0.0).name == "NORMAL"
    assert config.risk.tier_for_drawdown(0.031).name == "CAUTION"
    assert config.risk.tier_for_drawdown(0.99).name == "EMERGENCY"


def test_missing_config_file_raises():
    with pytest.raises(FileNotFoundError):
        load_config("/nonexistent/config.yaml")
