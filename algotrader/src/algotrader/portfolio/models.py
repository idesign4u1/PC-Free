"""Portfolio and position state."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from ..enums import SignalDirection
from ..utils.timeutils import utc_now


@dataclass
class Position:
    """An open position plus the audit trail that justifies it."""

    symbol: str
    quantity: float
    average_price: float
    opened_at: datetime = field(default_factory=utc_now)
    current_price: float = 0.0
    strategy: str = "ensemble"
    # Protective levels (maintained by the risk engine, not by strategies).
    stop_price: float | None = None
    take_profit_price: float | None = None
    initial_stop_price: float | None = None
    highest_price_since_entry: float = 0.0
    lowest_price_since_entry: float = 0.0
    risk_per_share: float = 0.0
    # Audit
    entry_reason: dict[str, Any] = field(default_factory=dict)
    sizing_reason: dict[str, Any] = field(default_factory=dict)
    stop_reason: dict[str, Any] = field(default_factory=dict)
    regime_at_entry: str = ""
    opportunity_score: float = 0.0
    confidence_at_entry: float = 0.0
    sector: str = "unknown"
    trade_id: int | None = None

    def __post_init__(self) -> None:
        if not self.current_price:
            self.current_price = self.average_price
        if not self.highest_price_since_entry:
            self.highest_price_since_entry = max(self.average_price, self.current_price)
        if not self.lowest_price_since_entry:
            self.lowest_price_since_entry = min(self.average_price, self.current_price)
        if self.initial_stop_price is None:
            self.initial_stop_price = self.stop_price

    @property
    def direction(self) -> SignalDirection:
        return SignalDirection.LONG if self.quantity > 0 else SignalDirection.SHORT

    @property
    def is_long(self) -> bool:
        return self.quantity > 0

    @property
    def market_value(self) -> float:
        return abs(self.quantity) * self.current_price

    @property
    def cost_basis(self) -> float:
        return abs(self.quantity) * self.average_price

    @property
    def unrealized_pnl(self) -> float:
        sign = 1.0 if self.is_long else -1.0
        return sign * (self.current_price - self.average_price) * abs(self.quantity)

    @property
    def unrealized_pnl_pct(self) -> float:
        return self.unrealized_pnl / self.cost_basis if self.cost_basis else 0.0

    @property
    def open_risk(self) -> float:
        """Money still at risk between the current price and the stop."""
        if self.stop_price is None:
            return self.market_value
        if self.is_long:
            return max(0.0, (self.current_price - self.stop_price)) * abs(self.quantity)
        return max(0.0, (self.stop_price - self.current_price)) * abs(self.quantity)

    @property
    def r_multiple(self) -> float:
        """Progress in units of initial risk."""
        if not self.risk_per_share:
            return 0.0
        sign = 1.0 if self.is_long else -1.0
        return sign * (self.current_price - self.average_price) / self.risk_per_share

    def days_held(self, now: datetime | None = None) -> float:
        return ((now or utc_now()) - self.opened_at).total_seconds() / 86400.0

    def mark(self, price: float) -> None:
        if price and price > 0:
            self.current_price = price
            self.highest_price_since_entry = max(self.highest_price_since_entry, price)
            self.lowest_price_since_entry = min(self.lowest_price_since_entry or price, price)

    def to_dict(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "quantity": self.quantity,
            "average_price": round(self.average_price, 4),
            "current_price": round(self.current_price, 4),
            "market_value": round(self.market_value, 2),
            "unrealized_pnl": round(self.unrealized_pnl, 2),
            "unrealized_pnl_pct": round(self.unrealized_pnl_pct, 4),
            "stop_price": round(self.stop_price, 4) if self.stop_price else None,
            "take_profit_price": round(self.take_profit_price, 4) if self.take_profit_price else None,
            "open_risk": round(self.open_risk, 2),
            "r_multiple": round(self.r_multiple, 3),
            "strategy": self.strategy,
            "sector": self.sector,
            "opened_at": self.opened_at.isoformat(),
            "days_held": round(self.days_held(), 2),
            "regime_at_entry": self.regime_at_entry,
        }


@dataclass
class PortfolioState:
    """Point-in-time portfolio snapshot used by every risk check."""

    equity: float
    cash: float
    buying_power: float
    positions: dict[str, Position] = field(default_factory=dict)
    high_water_mark: float = 0.0
    day_start_equity: float = 0.0
    week_start_equity: float = 0.0
    realized_pnl_today: float = 0.0
    risk_opened_today: float = 0.0
    consecutive_losses: int = 0
    as_of: datetime = field(default_factory=utc_now)
    account_id: str = ""
    sector_map: dict[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.high_water_mark = max(self.high_water_mark, self.equity)
        if not self.day_start_equity:
            self.day_start_equity = self.equity
        if not self.week_start_equity:
            self.week_start_equity = self.equity

    # --- exposure ---
    @property
    def gross_exposure(self) -> float:
        return sum(p.market_value for p in self.positions.values())

    @property
    def net_exposure(self) -> float:
        return sum(p.market_value * (1 if p.is_long else -1) for p in self.positions.values())

    @property
    def exposure_pct(self) -> float:
        return self.gross_exposure / self.equity if self.equity > 0 else 0.0

    @property
    def open_risk(self) -> float:
        return sum(p.open_risk for p in self.positions.values())

    @property
    def open_risk_pct(self) -> float:
        return self.open_risk / self.equity if self.equity > 0 else 0.0

    @property
    def open_position_count(self) -> int:
        return len(self.positions)

    # --- pnl / drawdown ---
    @property
    def unrealized_pnl(self) -> float:
        return sum(p.unrealized_pnl for p in self.positions.values())

    @property
    def daily_pnl(self) -> float:
        return self.equity - self.day_start_equity

    @property
    def daily_pnl_pct(self) -> float:
        return self.daily_pnl / self.day_start_equity if self.day_start_equity > 0 else 0.0

    @property
    def weekly_pnl(self) -> float:
        return self.equity - self.week_start_equity

    @property
    def weekly_pnl_pct(self) -> float:
        return self.weekly_pnl / self.week_start_equity if self.week_start_equity > 0 else 0.0

    @property
    def drawdown(self) -> float:
        if self.high_water_mark <= 0:
            return 0.0
        return max(0.0, (self.high_water_mark - self.equity) / self.high_water_mark)

    def sector_exposure(self, sector: str) -> float:
        total = sum(
            p.market_value
            for p in self.positions.values()
            if self.sector_map.get(p.symbol, p.sector) == sector
        )
        return total / self.equity if self.equity > 0 else 0.0

    def sector_exposures(self) -> dict[str, float]:
        out: dict[str, float] = {}
        for position in self.positions.values():
            sector = self.sector_map.get(position.symbol, position.sector)
            out[sector] = out.get(sector, 0.0) + position.market_value
        if self.equity > 0:
            return {k: v / self.equity for k, v in out.items()}
        return {k: 0.0 for k in out}

    def has_position(self, symbol: str) -> bool:
        return symbol.upper() in self.positions

    def get(self, symbol: str) -> Position | None:
        return self.positions.get(symbol.upper())

    def to_dict(self) -> dict[str, Any]:
        return {
            "equity": round(self.equity, 2),
            "cash": round(self.cash, 2),
            "buying_power": round(self.buying_power, 2),
            "gross_exposure": round(self.gross_exposure, 2),
            "exposure_pct": round(self.exposure_pct, 4),
            "net_exposure": round(self.net_exposure, 2),
            "open_risk": round(self.open_risk, 2),
            "open_risk_pct": round(self.open_risk_pct, 4),
            "unrealized_pnl": round(self.unrealized_pnl, 2),
            "daily_pnl": round(self.daily_pnl, 2),
            "daily_pnl_pct": round(self.daily_pnl_pct, 4),
            "weekly_pnl": round(self.weekly_pnl, 2),
            "weekly_pnl_pct": round(self.weekly_pnl_pct, 4),
            "high_water_mark": round(self.high_water_mark, 2),
            "drawdown": round(self.drawdown, 4),
            "open_positions": self.open_position_count,
            "consecutive_losses": self.consecutive_losses,
            "sector_exposures": {k: round(v, 4) for k, v in self.sector_exposures().items()},
            "as_of": self.as_of.isoformat(),
        }
