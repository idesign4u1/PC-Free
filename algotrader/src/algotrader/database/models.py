"""Database schema - the audit trail.

Every decision the platform makes is written here: what the market looked
like, what each strategy said, what the regime was, what risk decided, what was
sent to the broker, what came back, and what the portfolio looked like
afterwards. A trade can be fully reconstructed from these tables alone.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..utils.timeutils import utc_now
from .base import Base


def _ts() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), default=utc_now, index=True)


class Symbol(Base):
    __tablename__ = "symbols"

    id: Mapped[int] = mapped_column(primary_key=True)
    symbol: Mapped[str] = mapped_column(String(20), unique=True, index=True)
    sector: Mapped[str] = mapped_column(String(64), default="unknown")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = _ts()


class MarketObservation(Base):
    """Daily bars and quote snapshots actually used by a decision."""

    __tablename__ = "market_observations"
    __table_args__ = (Index("ix_market_obs_symbol_ts", "symbol", "observed_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    symbol: Mapped[str] = mapped_column(String(20), index=True)
    observation_type: Mapped[str] = mapped_column(String(16), default="bar_daily")
    observed_at: Mapped[datetime] = _ts()
    open: Mapped[float | None] = mapped_column(Float, nullable=True)
    high: Mapped[float | None] = mapped_column(Float, nullable=True)
    low: Mapped[float | None] = mapped_column(Float, nullable=True)
    close: Mapped[float | None] = mapped_column(Float, nullable=True)
    volume: Mapped[float | None] = mapped_column(Float, nullable=True)
    bid: Mapped[float | None] = mapped_column(Float, nullable=True)
    ask: Mapped[float | None] = mapped_column(Float, nullable=True)
    spread_bps: Mapped[float | None] = mapped_column(Float, nullable=True)
    quality_ok: Mapped[bool] = mapped_column(Boolean, default=True)
    quality_issues: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class RegimeRecord(Base):
    __tablename__ = "regime_records"

    id: Mapped[int] = mapped_column(primary_key=True)
    recorded_at: Mapped[datetime] = _ts()
    symbol: Mapped[str] = mapped_column(String(20), default="SPY")
    regime: Mapped[str] = mapped_column(String(32), index=True)
    volatility_regime: Mapped[str] = mapped_column(String(32))
    trend_regime: Mapped[str] = mapped_column(String(32))
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
    trend_strength: Mapped[float] = mapped_column(Float, default=0.0)
    realized_vol: Mapped[float] = mapped_column(Float, default=0.0)
    benchmark_drawdown: Mapped[float] = mapped_column(Float, default=0.0)
    details: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class SignalRecord(Base):
    """One strategy's opinion on one symbol at one moment."""

    __tablename__ = "signals"
    __table_args__ = (Index("ix_signals_symbol_ts", "symbol", "generated_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    generated_at: Mapped[datetime] = _ts()
    symbol: Mapped[str] = mapped_column(String(20), index=True)
    strategy: Mapped[str] = mapped_column(String(64), index=True)
    value: Mapped[float] = mapped_column(Float)
    confidence: Mapped[float] = mapped_column(Float)
    regime: Mapped[str] = mapped_column(String(32), default="")
    rationale: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class OpportunityRecord(Base):
    """The ensemble verdict, including why a trade was *not* taken."""

    __tablename__ = "opportunity_scores"

    id: Mapped[int] = mapped_column(primary_key=True)
    generated_at: Mapped[datetime] = _ts()
    symbol: Mapped[str] = mapped_column(String(20), index=True)
    score: Mapped[float] = mapped_column(Float)
    confidence: Mapped[float] = mapped_column(Float)
    direction: Mapped[str] = mapped_column(String(8))
    actionable: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    regime: Mapped[str] = mapped_column(String(32), default="")
    agreeing: Mapped[int] = mapped_column(Integer, default=0)
    conflicting: Mapped[int] = mapped_column(Integer, default=0)
    rejection_reasons: Mapped[list | None] = mapped_column(JSON, nullable=True)
    contributions: Mapped[list | None] = mapped_column(JSON, nullable=True)


class OrderRecord(Base):
    """Locally authoritative order state. Written *before* submission."""

    __tablename__ = "orders"
    __table_args__ = (
        UniqueConstraint("client_order_id", name="uq_orders_client_order_id"),
        Index("ix_orders_symbol_status", "symbol", "status"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    client_order_id: Mapped[str] = mapped_column(String(64), index=True)
    broker_order_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    tag: Mapped[str | None] = mapped_column(String(255), nullable=True)
    symbol: Mapped[str] = mapped_column(String(20), index=True)
    side: Mapped[str] = mapped_column(String(16))
    quantity: Mapped[float] = mapped_column(Float)
    order_type: Mapped[str] = mapped_column(String(16))
    order_class: Mapped[str] = mapped_column(String(16), default="equity")
    duration: Mapped[str] = mapped_column(String(8), default="day")
    limit_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    stop_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    take_profit_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    status: Mapped[str] = mapped_column(String(24), default="pending_submit", index=True)
    filled_quantity: Mapped[float] = mapped_column(Float, default=0.0)
    average_fill_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    intent: Mapped[str] = mapped_column(String(16), default="entry")   # entry | exit | protective
    environment: Mapped[str] = mapped_column(String(8), default="PAPER")
    mode: Mapped[str] = mapped_column(String(20), default="PAPER_MODE")
    expected_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # The complete risk decision that authorised this order.
    decision: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = _ts()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )
    trade_id: Mapped[int | None] = mapped_column(ForeignKey("trades.id"), nullable=True)

    fills: Mapped[list["FillRecord"]] = relationship(back_populates="order", lazy="selectin")


class FillRecord(Base):
    __tablename__ = "fills"

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    broker_order_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    symbol: Mapped[str] = mapped_column(String(20), index=True)
    side: Mapped[str] = mapped_column(String(16))
    quantity: Mapped[float] = mapped_column(Float)
    price: Mapped[float] = mapped_column(Float)
    commission: Mapped[float] = mapped_column(Float, default=0.0)
    filled_at: Mapped[datetime] = _ts()

    order: Mapped[OrderRecord] = relationship(back_populates="fills")


class TradeRecord(Base):
    """A round trip, with the full 'why' on both ends."""

    __tablename__ = "trades"

    id: Mapped[int] = mapped_column(primary_key=True)
    symbol: Mapped[str] = mapped_column(String(20), index=True)
    direction: Mapped[str] = mapped_column(String(8), default="LONG")
    strategy: Mapped[str] = mapped_column(String(64), default="ensemble")
    quantity: Mapped[float] = mapped_column(Float, default=0.0)
    entry_price: Mapped[float] = mapped_column(Float, default=0.0)
    exit_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    stop_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    take_profit_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    risk_amount: Mapped[float] = mapped_column(Float, default=0.0)
    risk_per_share: Mapped[float] = mapped_column(Float, default=0.0)
    realized_pnl: Mapped[float | None] = mapped_column(Float, nullable=True)
    r_multiple: Mapped[float | None] = mapped_column(Float, nullable=True)
    commission: Mapped[float] = mapped_column(Float, default=0.0)
    opened_at: Mapped[datetime] = _ts()
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="open", index=True)
    regime_at_entry: Mapped[str] = mapped_column(String(32), default="")
    regime_at_exit: Mapped[str | None] = mapped_column(String(32), nullable=True)
    opportunity_score: Mapped[float] = mapped_column(Float, default=0.0)
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
    environment: Mapped[str] = mapped_column(String(8), default="PAPER")
    # --- the audit quartet: why in, why that size, why that stop, why out ---
    entry_reason: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    sizing_reason: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    stop_reason: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    exit_reason: Mapped[str | None] = mapped_column(String(32), nullable=True)
    exit_detail: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    strategy_scores: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    risk_state: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class PositionSnapshot(Base):
    __tablename__ = "position_snapshots"

    id: Mapped[int] = mapped_column(primary_key=True)
    captured_at: Mapped[datetime] = _ts()
    symbol: Mapped[str] = mapped_column(String(20), index=True)
    quantity: Mapped[float] = mapped_column(Float)
    average_price: Mapped[float] = mapped_column(Float)
    current_price: Mapped[float] = mapped_column(Float)
    market_value: Mapped[float] = mapped_column(Float)
    unrealized_pnl: Mapped[float] = mapped_column(Float)
    stop_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    take_profit_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    open_risk: Mapped[float] = mapped_column(Float, default=0.0)
    r_multiple: Mapped[float] = mapped_column(Float, default=0.0)
    trade_id: Mapped[int | None] = mapped_column(ForeignKey("trades.id"), nullable=True)


class PortfolioSnapshot(Base):
    __tablename__ = "portfolio_snapshots"

    id: Mapped[int] = mapped_column(primary_key=True)
    captured_at: Mapped[datetime] = _ts()
    equity: Mapped[float] = mapped_column(Float)
    cash: Mapped[float] = mapped_column(Float)
    buying_power: Mapped[float] = mapped_column(Float, default=0.0)
    gross_exposure: Mapped[float] = mapped_column(Float, default=0.0)
    exposure_pct: Mapped[float] = mapped_column(Float, default=0.0)
    open_positions: Mapped[int] = mapped_column(Integer, default=0)
    unrealized_pnl: Mapped[float] = mapped_column(Float, default=0.0)
    realized_pnl_today: Mapped[float] = mapped_column(Float, default=0.0)
    daily_pnl: Mapped[float] = mapped_column(Float, default=0.0)
    daily_pnl_pct: Mapped[float] = mapped_column(Float, default=0.0)
    weekly_pnl_pct: Mapped[float] = mapped_column(Float, default=0.0)
    high_water_mark: Mapped[float] = mapped_column(Float, default=0.0)
    drawdown: Mapped[float] = mapped_column(Float, default=0.0)
    regime: Mapped[str] = mapped_column(String(32), default="")
    mode: Mapped[str] = mapped_column(String(20), default="PAPER_MODE")
    environment: Mapped[str] = mapped_column(String(8), default="PAPER")
    risk_utilisation: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class DailyPnL(Base):
    __tablename__ = "daily_pnl"
    __table_args__ = (UniqueConstraint("trade_date", "environment", name="uq_daily_pnl_date_env"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    trade_date: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    starting_equity: Mapped[float] = mapped_column(Float, default=0.0)
    ending_equity: Mapped[float] = mapped_column(Float, default=0.0)
    realized_pnl: Mapped[float] = mapped_column(Float, default=0.0)
    unrealized_pnl: Mapped[float] = mapped_column(Float, default=0.0)
    commission: Mapped[float] = mapped_column(Float, default=0.0)
    trades_closed: Mapped[int] = mapped_column(Integer, default=0)
    wins: Mapped[int] = mapped_column(Integer, default=0)
    losses: Mapped[int] = mapped_column(Integer, default=0)
    environment: Mapped[str] = mapped_column(String(8), default="PAPER")


class RiskEvent(Base):
    __tablename__ = "risk_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    occurred_at: Mapped[datetime] = _ts()
    event_type: Mapped[str] = mapped_column(String(48), index=True)
    severity: Mapped[str] = mapped_column(String(16), default="warning")
    symbol: Mapped[str | None] = mapped_column(String(20), nullable=True)
    detail: Mapped[str] = mapped_column(Text, default="")
    payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class StrategyPerformance(Base):
    """Rolling strategy statistics, per regime, used by bounded adaptation."""

    __tablename__ = "strategy_performance"
    __table_args__ = (UniqueConstraint("strategy", "regime", name="uq_strategy_regime"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    strategy: Mapped[str] = mapped_column(String(64), index=True)
    regime: Mapped[str] = mapped_column(String(32), default="ALL")
    trades: Mapped[int] = mapped_column(Integer, default=0)
    wins: Mapped[int] = mapped_column(Integer, default=0)
    losses: Mapped[int] = mapped_column(Integer, default=0)
    gross_profit: Mapped[float] = mapped_column(Float, default=0.0)
    gross_loss: Mapped[float] = mapped_column(Float, default=0.0)
    expectancy_r: Mapped[float] = mapped_column(Float, default=0.0)
    profit_factor: Mapped[float] = mapped_column(Float, default=0.0)
    avg_r: Mapped[float] = mapped_column(Float, default=0.0)
    applied_weight: Mapped[float] = mapped_column(Float, default=0.0)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )


class ExecutionQuality(Base):
    """Expected vs actual execution - the paper-trading fidelity check."""

    __tablename__ = "execution_quality"

    id: Mapped[int] = mapped_column(primary_key=True)
    recorded_at: Mapped[datetime] = _ts()
    order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id"), nullable=True)
    symbol: Mapped[str] = mapped_column(String(20), index=True)
    side: Mapped[str] = mapped_column(String(16), default="")
    expected_price: Mapped[float] = mapped_column(Float, default=0.0)
    actual_price: Mapped[float] = mapped_column(Float, default=0.0)
    quantity: Mapped[float] = mapped_column(Float, default=0.0)
    slippage_bps: Mapped[float] = mapped_column(Float, default=0.0)
    latency_ms: Mapped[float] = mapped_column(Float, default=0.0)
    environment: Mapped[str] = mapped_column(String(8), default="PAPER")
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)


class SystemEvent(Base):
    __tablename__ = "system_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    occurred_at: Mapped[datetime] = _ts()
    level: Mapped[str] = mapped_column(String(16), default="info", index=True)
    event: Mapped[str] = mapped_column(String(64), index=True)
    detail: Mapped[str] = mapped_column(Text, default="")
    payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class ConfigHistory(Base):
    """Every configuration the system has actually run with."""

    __tablename__ = "config_history"

    id: Mapped[int] = mapped_column(primary_key=True)
    recorded_at: Mapped[datetime] = _ts()
    config_hash: Mapped[str] = mapped_column(String(64), index=True)
    mode: Mapped[str] = mapped_column(String(20), default="PAPER_MODE")
    environment: Mapped[str] = mapped_column(String(8), default="PAPER")
    note: Mapped[str] = mapped_column(Text, default="")
    config: Mapped[dict | None] = mapped_column(JSON, nullable=True)
