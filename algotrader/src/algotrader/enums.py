"""Shared enumerations.

Kept in one module so that database models, broker adapters, strategies and the
API all speak exactly the same vocabulary.
"""

from __future__ import annotations

from enum import StrEnum


class SystemMode(StrEnum):
    """Operating mode of the whole platform.

    SAFE_MODE       - system runs, analyses and records, but never sends orders.
    PAPER_MODE      - full trading against the Tradier sandbox (default).
    LIVE_MODE       - real money. Requires an explicit env flag + live gate.
    EMERGENCY_MODE  - no new risk; only risk-reducing (closing) orders allowed.
    """

    SAFE_MODE = "SAFE_MODE"
    PAPER_MODE = "PAPER_MODE"
    LIVE_MODE = "LIVE_MODE"
    EMERGENCY_MODE = "EMERGENCY_MODE"


class BrokerEnvironment(StrEnum):
    PAPER = "PAPER"
    LIVE = "LIVE"


class Regime(StrEnum):
    BULL_TREND = "BULL_TREND"
    BEAR_TREND = "BEAR_TREND"
    SIDEWAYS = "SIDEWAYS"
    HIGH_VOLATILITY = "HIGH_VOLATILITY"
    LOW_VOLATILITY = "LOW_VOLATILITY"
    RISK_OFF = "RISK_OFF"


class VolatilityRegime(StrEnum):
    LOW = "LOW"
    NORMAL = "NORMAL"
    HIGH = "HIGH"
    EXTREME = "EXTREME"


class OrderSide(StrEnum):
    BUY = "buy"
    SELL = "sell"
    BUY_TO_COVER = "buy_to_cover"
    SELL_SHORT = "sell_short"


class OrderType(StrEnum):
    MARKET = "market"
    LIMIT = "limit"
    STOP = "stop"
    STOP_LIMIT = "stop_limit"


class OrderDuration(StrEnum):
    DAY = "day"
    GTC = "gtc"
    PRE = "pre"
    POST = "post"


class OrderClass(StrEnum):
    EQUITY = "equity"
    OPTION = "option"
    MULTILEG = "multileg"
    COMBO = "combo"
    OTO = "oto"
    OCO = "oco"
    OTOCO = "otoco"


class OrderStatus(StrEnum):
    """Normalised order status (superset of Tradier's vocabulary)."""

    PENDING_SUBMIT = "pending_submit"   # persisted locally, not yet at broker
    OPEN = "open"
    PARTIALLY_FILLED = "partially_filled"
    FILLED = "filled"
    CANCELED = "canceled"
    EXPIRED = "expired"
    REJECTED = "rejected"
    ERROR = "error"
    UNKNOWN = "unknown"

    @property
    def is_terminal(self) -> bool:
        return self in {
            OrderStatus.FILLED,
            OrderStatus.CANCELED,
            OrderStatus.EXPIRED,
            OrderStatus.REJECTED,
            OrderStatus.ERROR,
        }

    @property
    def is_working(self) -> bool:
        return self in {
            OrderStatus.PENDING_SUBMIT,
            OrderStatus.OPEN,
            OrderStatus.PARTIALLY_FILLED,
        }


class SignalDirection(StrEnum):
    LONG = "LONG"
    SHORT = "SHORT"
    FLAT = "FLAT"


class RiskEventType(StrEnum):
    LIMIT_BREACH = "LIMIT_BREACH"
    KILL_SWITCH_TRIPPED = "KILL_SWITCH_TRIPPED"
    KILL_SWITCH_RESET = "KILL_SWITCH_RESET"
    DRAWDOWN_TIER_CHANGE = "DRAWDOWN_TIER_CHANGE"
    COOLDOWN_STARTED = "COOLDOWN_STARTED"
    ORDER_REJECTED = "ORDER_REJECTED"
    DATA_QUALITY = "DATA_QUALITY"
    RECONCILIATION = "RECONCILIATION"
    EMERGENCY = "EMERGENCY"


class KillSwitchReason(StrEnum):
    BROKER_UNAVAILABLE = "BROKER_UNAVAILABLE"
    STALE_MARKET_DATA = "STALE_MARKET_DATA"
    ABNORMAL_SPREAD = "ABNORMAL_SPREAD"
    EXECUTION_ERRORS = "EXECUTION_ERRORS"
    UNEXPECTED_POSITIONS = "UNEXPECTED_POSITIONS"
    DAILY_LOSS_LIMIT = "DAILY_LOSS_LIMIT"
    WEEKLY_LOSS_LIMIT = "WEEKLY_LOSS_LIMIT"
    DRAWDOWN_LIMIT = "DRAWDOWN_LIMIT"
    CONSISTENCY_FAILURE = "CONSISTENCY_FAILURE"
    MANUAL = "MANUAL"


class ExitReason(StrEnum):
    STOP_LOSS = "STOP_LOSS"
    TRAILING_STOP = "TRAILING_STOP"
    TAKE_PROFIT = "TAKE_PROFIT"
    SIGNAL_REVERSAL = "SIGNAL_REVERSAL"
    TIME_STOP = "TIME_STOP"
    RISK_REDUCTION = "RISK_REDUCTION"
    EMERGENCY = "EMERGENCY"
    MANUAL = "MANUAL"
    END_OF_BACKTEST = "END_OF_BACKTEST"
