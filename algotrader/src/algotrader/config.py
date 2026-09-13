"""Configuration: environment secrets (.env) + trading parameters (YAML).

Two distinct layers, deliberately kept apart:

* :class:`Settings` - secrets and deployment wiring, read from environment
  variables only. Credentials never appear in YAML and are never logged.
* :class:`AppConfig` - every trading/risk parameter, read from YAML so that a
  full configuration snapshot (and its hash) can be persisted for audit.

LIVE trading requires *three* independent switches to line up:
``system.mode: LIVE_MODE`` in YAML, ``ENABLE_LIVE_TRADING=true`` in the
environment, and live credentials. Anything less resolves to PAPER.
"""

from __future__ import annotations

import hashlib
import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from .enums import BrokerEnvironment, Regime, SystemMode

__all__ = [
    "AppConfig",
    "BrokerEnvironment",
    "Settings",
    "SystemMode",
    "get_config",
    "get_settings",
    "load_config",
    "reset_caches",
]

PACKAGE_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = PACKAGE_ROOT.parent.parent
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "config" / "config.yaml"

PAPER_BASE_URL = "https://sandbox.tradier.com"
LIVE_BASE_URL = "https://api.tradier.com"


# --------------------------------------------------------------------------- #
# Environment / secrets
# --------------------------------------------------------------------------- #
class Settings(BaseSettings):
    """Secrets and deployment wiring. Environment variables only."""

    model_config = SettingsConfigDict(
        env_file=os.getenv("ALGOTRADER_ENV_FILE", ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # --- broker credentials (kept strictly separate per environment) ---
    tradier_paper_token: str = ""
    tradier_paper_account_id: str = ""
    tradier_live_token: str = ""
    tradier_live_account_id: str = ""

    # --- the live money switch. Must be set deliberately, by a human. ---
    enable_live_trading: bool = False

    # --- infrastructure ---
    database_url: str = "postgresql+asyncpg://algotrader:algotrader@localhost:5432/algotrader"
    redis_url: str = ""
    config_path: str = str(DEFAULT_CONFIG_PATH)

    # --- api ---
    api_host: str = "0.0.0.0"
    api_port: int = 8000
    api_token: str = ""          # required for every mutating endpoint
    log_level: str = "INFO"
    log_json: bool = True

    # --- alerting ---
    alert_webhook_url: str = ""

    def broker_credentials(self, environment: BrokerEnvironment) -> tuple[str, str, str]:
        """Return ``(base_url, token, account_id)`` for an environment."""
        if environment is BrokerEnvironment.LIVE:
            return LIVE_BASE_URL, self.tradier_live_token, self.tradier_live_account_id
        return PAPER_BASE_URL, self.tradier_paper_token, self.tradier_paper_account_id

    def has_credentials(self, environment: BrokerEnvironment) -> bool:
        _, token, account = self.broker_credentials(environment)
        return bool(token and account)

    def safe_dump(self) -> dict[str, Any]:
        """Configuration snapshot with every secret redacted."""
        secret_fields = {
            "tradier_paper_token",
            "tradier_paper_account_id",
            "tradier_live_token",
            "tradier_live_account_id",
            "api_token",
            "database_url",
            "alert_webhook_url",
        }
        out: dict[str, Any] = {}
        for name, value in self.model_dump().items():
            if name in secret_fields and value:
                out[name] = "***redacted***"
            else:
                out[name] = value
        return out


# --------------------------------------------------------------------------- #
# YAML configuration models
# --------------------------------------------------------------------------- #
class _Base(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class SystemConfig(_Base):
    mode: SystemMode = SystemMode.PAPER_MODE
    loop_interval_seconds: int = Field(60, ge=1)
    trade_only_when_market_open: bool = True
    skip_first_minutes: int = Field(5, ge=0)
    skip_last_minutes: int = Field(10, ge=0)
    timezone: str = "America/New_York"


class UniverseConfig(_Base):
    benchmark: str = "SPY"
    symbols: list[str] = Field(default_factory=list)
    sectors: dict[str, str] = Field(default_factory=dict)

    @field_validator("symbols")
    @classmethod
    def _upper(cls, v: list[str]) -> list[str]:
        return [s.strip().upper() for s in v if s.strip()]

    def sector_of(self, symbol: str) -> str:
        return self.sectors.get(symbol.upper(), "unknown")


class MarketDataConfig(_Base):
    history_days: int = Field(400, ge=30)
    min_bars_required: int = Field(120, ge=20)
    quote_staleness_seconds: int = Field(90, ge=1)
    bar_staleness_days: int = Field(5, ge=1)
    cache_ttl_seconds: int = Field(30, ge=0)
    max_quote_age_for_orders_seconds: int = Field(30, ge=1)


class RegimeConfig(_Base):
    fast_ma: int = 50
    slow_ma: int = 200
    slope_lookback: int = 20
    atr_period: int = 14
    realized_vol_window: int = 20
    realized_vol_long_window: int = 120
    high_vol_threshold: float = 0.28
    low_vol_threshold: float = 0.12
    sideways_slope_threshold: float = 0.05
    risk_off_drawdown: float = 0.12
    risk_off_vol_spike_ratio: float = 2.0
    min_bars: int = 210


class StrategiesConfig(_Base):
    weights: dict[str, float] = Field(default_factory=dict)
    regime_weight_multipliers: dict[Regime, dict[str, float]] = Field(default_factory=dict)
    params: dict[str, dict[str, Any]] = Field(default_factory=dict)

    @field_validator("weights")
    @classmethod
    def _non_negative(cls, v: dict[str, float]) -> dict[str, float]:
        for name, weight in v.items():
            if weight < 0:
                raise ValueError(f"strategy weight for {name} must be >= 0")
        if not v or sum(v.values()) <= 0:
            raise ValueError("at least one strategy must carry positive weight")
        return v

    def multipliers_for(self, regime: Regime) -> dict[str, float]:
        return self.regime_weight_multipliers.get(regime, {})

    def params_for(self, strategy: str) -> dict[str, Any]:
        return dict(self.params.get(strategy, {}))


class SignalsConfig(_Base):
    min_abs_score: float = Field(0.28, ge=0.0, le=1.0)
    min_confidence: float = Field(55.0, ge=0.0, le=100.0)
    min_agreeing_strategies: int = Field(2, ge=1)
    max_conflict_ratio: float = Field(0.40, ge=0.0)
    max_signal_dispersion: float = Field(0.75, ge=0.0)
    long_only: bool = True
    max_new_positions_per_cycle: int = Field(2, ge=0)


class DrawdownTier(_Base):
    name: str
    min_drawdown: float = Field(ge=0.0, le=1.0)
    size_multiplier: float = Field(ge=0.0, le=1.0)
    min_confidence: float = Field(ge=0.0, le=100.0)
    allow_new_positions: bool = True


class ConsecutiveLossCooldown(_Base):
    losses_to_trigger: int = Field(3, ge=1)
    cooldown_minutes: int = Field(240, ge=0)


class RiskConfig(_Base):
    # per-trade
    max_risk_per_trade_pct: float = Field(0.005, gt=0.0, le=0.05)
    max_position_pct: float = Field(0.08, gt=0.0, le=1.0)
    min_position_notional: float = Field(500.0, ge=0.0)
    min_shares: int = Field(1, ge=1)
    reward_risk_min: float = Field(1.8, ge=0.0)
    # portfolio
    max_portfolio_exposure_pct: float = Field(0.60, gt=0.0, le=2.0)
    max_sector_exposure_pct: float = Field(0.25, gt=0.0, le=1.0)
    max_correlated_exposure_pct: float = Field(0.30, gt=0.0, le=1.0)
    correlation_threshold: float = Field(0.70, ge=0.0, le=1.0)
    correlation_lookback: int = Field(90, ge=20)
    max_open_positions: int = Field(8, ge=1)
    max_new_risk_per_day_pct: float = Field(0.02, gt=0.0, le=0.25)
    # loss limits
    max_daily_loss_pct: float = Field(0.02, gt=0.0, le=1.0)
    max_weekly_loss_pct: float = Field(0.04, gt=0.0, le=1.0)
    max_drawdown_pct: float = Field(0.12, gt=0.0, le=1.0)
    # liquidity / microstructure
    min_avg_dollar_volume: float = Field(20_000_000.0, ge=0.0)
    max_spread_bps: float = Field(25.0, gt=0.0)
    max_position_pct_of_adv: float = Field(0.02, gt=0.0, le=1.0)
    min_price: float = Field(5.0, ge=0.0)
    max_price: float = Field(100_000.0, gt=0.0)
    # volatility
    max_atr_pct: float = Field(0.08, gt=0.0, le=1.0)
    min_atr_pct: float = Field(0.005, ge=0.0)
    volatility_target_annual: float = Field(0.15, gt=0.0, le=2.0)
    # stops / targets
    atr_period: int = Field(14, ge=2)
    atr_stop_multiple: float = Field(2.5, gt=0.0)
    atr_target_multiple: float = Field(5.0, gt=0.0)
    trailing_stop_atr_multiple: float = Field(3.0, gt=0.0)
    trailing_activate_r: float = Field(1.0, ge=0.0)
    max_stop_distance_pct: float = Field(0.15, gt=0.0, le=1.0)
    time_stop_days: int = Field(40, ge=1)
    # drawdown tiers / cooldowns
    drawdown_tiers: list[DrawdownTier] = Field(default_factory=list)
    consecutive_loss_cooldown: ConsecutiveLossCooldown = ConsecutiveLossCooldown()
    symbol_cooldown_minutes_after_loss: int = Field(1440, ge=0)
    symbol_cooldown_minutes_after_exit: int = Field(60, ge=0)

    @model_validator(mode="after")
    def _validate(self) -> "RiskConfig":
        if not self.drawdown_tiers:
            raise ValueError("at least one drawdown tier must be configured")
        tiers = sorted(self.drawdown_tiers, key=lambda t: t.min_drawdown)
        if tiers[0].min_drawdown != 0.0:
            raise ValueError("the first drawdown tier must start at 0.0")
        # Exposure must be monotonically non-increasing as drawdown deepens.
        for earlier, later in zip(tiers, tiers[1:]):
            if later.size_multiplier > earlier.size_multiplier:
                raise ValueError(
                    "drawdown tiers must not increase size as drawdown grows: "
                    f"{later.name} ({later.size_multiplier}) > {earlier.name} "
                    f"({earlier.size_multiplier})"
                )
        if self.atr_target_multiple < self.atr_stop_multiple:
            raise ValueError("atr_target_multiple must be >= atr_stop_multiple")
        return self

    def sorted_tiers(self) -> list[DrawdownTier]:
        return sorted(self.drawdown_tiers, key=lambda t: t.min_drawdown)

    def tier_for_drawdown(self, drawdown: float) -> DrawdownTier:
        """Return the deepest tier whose threshold has been breached."""
        selected = self.sorted_tiers()[0]
        for tier in self.sorted_tiers():
            if drawdown >= tier.min_drawdown:
                selected = tier
        return selected


class ExecutionConfig(_Base):
    default_duration: Literal["day", "gtc", "pre", "post"] = "day"
    entry_order_type: Literal["market", "limit"] = "limit"
    limit_offset_bps: float = Field(10.0, ge=0.0)
    use_bracket_orders: bool = True
    order_ack_timeout_seconds: int = Field(20, ge=1)
    order_poll_interval_seconds: float = Field(2.0, gt=0.0)
    max_submit_retries: int = Field(2, ge=0, le=5)
    duplicate_order_window_seconds: int = Field(300, ge=0)
    cancel_unfilled_after_seconds: int = Field(300, ge=0)
    slippage_alert_bps: float = Field(30.0, ge=0.0)
    commission_per_share: float = Field(0.0, ge=0.0)
    commission_minimum: float = Field(0.0, ge=0.0)


class BacktestConfig(_Base):
    initial_equity: float = Field(100_000.0, gt=0.0)
    commission_per_share: float = Field(0.0, ge=0.0)
    commission_minimum: float = Field(0.0, ge=0.0)
    slippage_bps: float = Field(5.0, ge=0.0)
    spread_bps: float = Field(4.0, ge=0.0)
    fill_model: Literal["next_open", "close"] = "next_open"
    allow_partial_fills: bool = False
    volume_participation_cap: float = Field(0.05, gt=0.0, le=1.0)


class LiveGateConfig(_Base):
    enabled: bool = False
    min_paper_trades: int = Field(200, ge=0)
    min_paper_days: int = Field(60, ge=0)
    max_paper_drawdown_pct: float = Field(0.10, gt=0.0, le=1.0)
    min_expectancy_r: float = 0.05
    min_profit_factor: float = 1.3
    min_win_rate: float = Field(0.35, ge=0.0, le=1.0)
    min_sharpe: float = 0.8
    require_health_checks: bool = True


class AdaptationConfig(_Base):
    enabled: bool = True
    lookback_trades: int = Field(50, ge=1)
    min_trades_per_strategy: int = Field(20, ge=1)
    max_weight_delta: float = Field(0.10, ge=0.0, le=0.5)
    min_weight: float = Field(0.02, ge=0.0, le=1.0)
    max_weight: float = Field(0.50, gt=0.0, le=1.0)
    update_interval_hours: int = Field(24, ge=1)


class MonitoringConfig(_Base):
    snapshot_interval_seconds: int = Field(300, ge=10)
    alert_daily_loss_pct: float = Field(0.015, gt=0.0)
    alert_drawdown_pct: float = Field(0.05, gt=0.0)
    alert_slippage_bps: float = Field(30.0, ge=0.0)
    heartbeat_timeout_seconds: int = Field(300, ge=10)


class AppConfig(_Base):
    system: SystemConfig = SystemConfig()
    universe: UniverseConfig = UniverseConfig()
    market_data: MarketDataConfig = MarketDataConfig()
    regime: RegimeConfig = RegimeConfig()
    strategies: StrategiesConfig
    signals: SignalsConfig = SignalsConfig()
    risk: RiskConfig
    execution: ExecutionConfig = ExecutionConfig()
    backtest: BacktestConfig = BacktestConfig()
    live_gate: LiveGateConfig = LiveGateConfig()
    adaptation: AdaptationConfig = AdaptationConfig()
    monitoring: MonitoringConfig = MonitoringConfig()

    def config_hash(self) -> str:
        payload = json.dumps(self.model_dump(mode="json"), sort_keys=True, default=str)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def resolve_broker_environment(self, settings: Settings) -> BrokerEnvironment:
        """LIVE only when mode, env flag and credentials all agree. Else PAPER."""
        if (
            self.system.mode is SystemMode.LIVE_MODE
            and settings.enable_live_trading
            and self.live_gate.enabled
            and settings.has_credentials(BrokerEnvironment.LIVE)
        ):
            return BrokerEnvironment.LIVE
        return BrokerEnvironment.PAPER

    def effective_mode(self, settings: Settings) -> SystemMode:
        """Downgrade LIVE_MODE to PAPER_MODE unless every live switch is on."""
        if self.system.mode is SystemMode.LIVE_MODE:
            if self.resolve_broker_environment(settings) is not BrokerEnvironment.LIVE:
                return SystemMode.PAPER_MODE
        return self.system.mode


def load_config(path: str | Path | None = None) -> AppConfig:
    """Load and validate the YAML trading configuration."""
    settings = get_settings()
    config_path = Path(path or settings.config_path)
    if not config_path.exists():
        raise FileNotFoundError(f"configuration file not found: {config_path}")
    with config_path.open("r", encoding="utf-8") as handle:
        raw = yaml.safe_load(handle) or {}
    return AppConfig.model_validate(raw)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


@lru_cache(maxsize=1)
def get_config() -> AppConfig:
    return load_config()


def reset_caches() -> None:
    """Drop cached settings/config (used by tests and the reload endpoint)."""
    get_settings.cache_clear()
    get_config.cache_clear()
