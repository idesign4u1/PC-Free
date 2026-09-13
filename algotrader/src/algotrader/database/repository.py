"""Persistence helpers.

One class, one job: turn in-memory domain objects into durable audit rows. All
writes are best-effort from the caller's point of view - a logging failure must
never take down the trading loop - but nothing is silently swallowed: failures
are logged with context.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Iterable, Sequence

from sqlalchemy import delete, func, select

from ..enums import BrokerEnvironment, OrderStatus, RiskEventType, SystemMode
from ..logging_setup import get_logger
from ..utils.timeutils import local_trading_date, utc_now
from .base import Database
from .models import (
    ConfigHistory,
    DailyPnL,
    ExecutionQuality,
    FillRecord,
    MarketObservation,
    OpportunityRecord,
    OrderRecord,
    PortfolioSnapshot,
    PositionSnapshot,
    RegimeRecord,
    RiskEvent,
    SignalRecord,
    StrategyPerformance,
    Symbol,
    SystemEvent,
    TradeRecord,
)

log = get_logger(__name__)


class Repository:
    def __init__(self, database: Database) -> None:
        self.db = database

    # ------------------------------------------------------------------ #
    # system / config
    # ------------------------------------------------------------------ #
    async def record_system_event(
        self, event: str, detail: str = "", level: str = "info", payload: dict | None = None
    ) -> None:
        async with self.db.session() as session:
            session.add(SystemEvent(event=event, detail=detail, level=level, payload=payload))

    async def record_risk_event(
        self,
        event_type: RiskEventType | str,
        detail: str,
        severity: str = "warning",
        symbol: str | None = None,
        payload: dict | None = None,
    ) -> None:
        async with self.db.session() as session:
            session.add(
                RiskEvent(
                    event_type=str(event_type),
                    detail=detail,
                    severity=severity,
                    symbol=symbol,
                    payload=payload,
                )
            )

    async def record_config(
        self,
        config_hash: str,
        config: dict,
        mode: SystemMode | str,
        environment: BrokerEnvironment | str,
        note: str = "",
    ) -> bool:
        """Store a configuration snapshot if this hash has not been seen."""
        async with self.db.session() as session:
            existing = await session.scalar(
                select(ConfigHistory.id).where(ConfigHistory.config_hash == config_hash).limit(1)
            )
            if existing:
                return False
            session.add(
                ConfigHistory(
                    config_hash=config_hash,
                    config=config,
                    mode=str(mode),
                    environment=str(environment),
                    note=note,
                )
            )
            return True

    async def ensure_symbols(self, symbols: dict[str, str]) -> None:
        async with self.db.session() as session:
            known = set(
                (await session.scalars(select(Symbol.symbol).where(Symbol.symbol.in_(symbols)))).all()
            )
            for symbol, sector in symbols.items():
                if symbol not in known:
                    session.add(Symbol(symbol=symbol, sector=sector))

    # ------------------------------------------------------------------ #
    # market data / signals / regime
    # ------------------------------------------------------------------ #
    async def record_market_observations(self, rows: Iterable[dict[str, Any]]) -> None:
        rows = list(rows)
        if not rows:
            return
        async with self.db.session() as session:
            session.add_all([MarketObservation(**row) for row in rows])

    async def record_regime(self, state: dict[str, Any]) -> None:
        async with self.db.session() as session:
            session.add(
                RegimeRecord(
                    symbol=state.get("symbol", "SPY"),
                    regime=state["regime"],
                    volatility_regime=state["volatility_regime"],
                    trend_regime=state["trend_regime"],
                    confidence=state["confidence"],
                    trend_strength=state["trend_strength"],
                    realized_vol=state["realized_vol"],
                    benchmark_drawdown=state["benchmark_drawdown"],
                    details=state.get("details"),
                )
            )

    async def record_signals(self, signals: Sequence[dict[str, Any]], regime: str) -> None:
        if not signals:
            return
        async with self.db.session() as session:
            session.add_all(
                [
                    SignalRecord(
                        symbol=signal["symbol"],
                        strategy=signal["strategy"],
                        value=signal["value"],
                        confidence=signal["confidence"],
                        rationale=signal.get("rationale"),
                        regime=regime,
                    )
                    for signal in signals
                ]
            )

    async def record_opportunity(self, score: dict[str, Any]) -> None:
        async with self.db.session() as session:
            session.add(
                OpportunityRecord(
                    symbol=score["symbol"],
                    score=score["score"],
                    confidence=score["confidence"],
                    direction=score["direction"],
                    actionable=score["actionable"],
                    regime=score["regime"],
                    agreeing=score.get("agreeing", 0),
                    conflicting=score.get("conflicting", 0),
                    rejection_reasons=score.get("rejection_reasons"),
                    contributions=score.get("contributions"),
                )
            )

    # ------------------------------------------------------------------ #
    # orders and fills
    # ------------------------------------------------------------------ #
    async def get_order_by_client_id(self, client_order_id: str) -> OrderRecord | None:
        async with self.db.session() as session:
            return await session.scalar(
                select(OrderRecord).where(OrderRecord.client_order_id == client_order_id)
            )

    async def create_order(self, **fields: Any) -> OrderRecord:
        """Persist the intent *before* it is sent to the broker."""
        async with self.db.session() as session:
            record = OrderRecord(**fields)
            session.add(record)
            await session.flush()
            await session.refresh(record)
            return record

    async def update_order(
        self,
        order_id: int,
        *,
        status: OrderStatus | str | None = None,
        broker_order_id: str | None = None,
        filled_quantity: float | None = None,
        average_fill_price: float | None = None,
        error: str | None = None,
        submitted_at: datetime | None = None,
    ) -> OrderRecord | None:
        async with self.db.session() as session:
            record = await session.get(OrderRecord, order_id)
            if record is None:
                return None
            if status is not None:
                record.status = str(status)
            if broker_order_id is not None:
                record.broker_order_id = broker_order_id
            if filled_quantity is not None:
                record.filled_quantity = filled_quantity
            if average_fill_price is not None:
                record.average_fill_price = average_fill_price
            if error is not None:
                record.error = error
            if submitted_at is not None:
                record.submitted_at = submitted_at
            record.updated_at = utc_now()
            await session.flush()
            return record

    async def add_fill(
        self,
        order_id: int,
        symbol: str,
        side: str,
        quantity: float,
        price: float,
        commission: float = 0.0,
        broker_order_id: str | None = None,
        filled_at: datetime | None = None,
    ) -> None:
        async with self.db.session() as session:
            session.add(
                FillRecord(
                    order_id=order_id,
                    symbol=symbol,
                    side=side,
                    quantity=quantity,
                    price=price,
                    commission=commission,
                    broker_order_id=broker_order_id,
                    filled_at=filled_at or utc_now(),
                )
            )

    async def has_recent_similar_order(
        self, symbol: str, side: str, window_seconds: int, intent: str = "entry"
    ) -> bool:
        """Duplicate-order guard independent of the client order id."""
        if window_seconds <= 0:
            return False
        cutoff = utc_now() - timedelta(seconds=window_seconds)
        async with self.db.session() as session:
            found = await session.scalar(
                select(OrderRecord.id)
                .where(
                    OrderRecord.symbol == symbol.upper(),
                    OrderRecord.side == side,
                    OrderRecord.intent == intent,
                    OrderRecord.created_at >= cutoff,
                    OrderRecord.status.notin_(
                        [str(OrderStatus.REJECTED), str(OrderStatus.ERROR), str(OrderStatus.CANCELED)]
                    ),
                )
                .limit(1)
            )
            return found is not None

    async def working_orders(self) -> list[OrderRecord]:
        working = [str(s) for s in OrderStatus if s.is_working]
        async with self.db.session() as session:
            return list(
                (await session.scalars(select(OrderRecord).where(OrderRecord.status.in_(working)))).all()
            )

    async def recent_orders(self, limit: int = 50) -> list[OrderRecord]:
        async with self.db.session() as session:
            return list(
                (
                    await session.scalars(
                        select(OrderRecord).order_by(OrderRecord.created_at.desc()).limit(limit)
                    )
                ).all()
            )

    # ------------------------------------------------------------------ #
    # trades
    # ------------------------------------------------------------------ #
    async def open_trade(self, **fields: Any) -> TradeRecord:
        async with self.db.session() as session:
            trade = TradeRecord(**fields)
            session.add(trade)
            await session.flush()
            await session.refresh(trade)
            return trade

    async def close_trade(
        self,
        trade_id: int,
        exit_price: float,
        realized_pnl: float,
        exit_reason: str,
        exit_detail: dict | None = None,
        regime_at_exit: str | None = None,
        commission: float = 0.0,
        closed_at: datetime | None = None,
    ) -> TradeRecord | None:
        async with self.db.session() as session:
            trade = await session.get(TradeRecord, trade_id)
            if trade is None:
                return None
            trade.exit_price = exit_price
            trade.realized_pnl = realized_pnl
            trade.exit_reason = exit_reason
            trade.exit_detail = exit_detail
            trade.regime_at_exit = regime_at_exit
            trade.commission = (trade.commission or 0.0) + commission
            trade.closed_at = closed_at or utc_now()
            trade.status = "closed"
            if trade.risk_per_share and trade.quantity:
                risk_total = trade.risk_per_share * abs(trade.quantity)
                trade.r_multiple = realized_pnl / risk_total if risk_total else None
            await session.flush()
            return trade

    async def open_trades(self) -> list[TradeRecord]:
        async with self.db.session() as session:
            return list(
                (await session.scalars(select(TradeRecord).where(TradeRecord.status == "open"))).all()
            )

    async def closed_trades(
        self, limit: int | None = None, environment: str | None = None
    ) -> list[TradeRecord]:
        query = select(TradeRecord).where(TradeRecord.status == "closed").order_by(
            TradeRecord.closed_at.desc()
        )
        if environment:
            query = query.where(TradeRecord.environment == environment)
        if limit:
            query = query.limit(limit)
        async with self.db.session() as session:
            return list((await session.scalars(query)).all())

    async def recent_trades(self, limit: int = 20) -> list[TradeRecord]:
        async with self.db.session() as session:
            return list(
                (
                    await session.scalars(
                        select(TradeRecord).order_by(TradeRecord.opened_at.desc()).limit(limit)
                    )
                ).all()
            )

    # ------------------------------------------------------------------ #
    # portfolio / pnl
    # ------------------------------------------------------------------ #
    async def record_portfolio_snapshot(self, **fields: Any) -> None:
        async with self.db.session() as session:
            session.add(PortfolioSnapshot(**fields))

    async def latest_portfolio_snapshot(self) -> PortfolioSnapshot | None:
        async with self.db.session() as session:
            return await session.scalar(
                select(PortfolioSnapshot).order_by(PortfolioSnapshot.captured_at.desc()).limit(1)
            )

    async def portfolio_snapshots(self, limit: int = 500) -> list[PortfolioSnapshot]:
        async with self.db.session() as session:
            rows = list(
                (
                    await session.scalars(
                        select(PortfolioSnapshot)
                        .order_by(PortfolioSnapshot.captured_at.desc())
                        .limit(limit)
                    )
                ).all()
            )
        return list(reversed(rows))

    async def record_position_snapshots(self, rows: Iterable[dict[str, Any]]) -> None:
        rows = list(rows)
        async with self.db.session() as session:
            await session.execute(
                delete(PositionSnapshot).where(
                    PositionSnapshot.captured_at < utc_now() - timedelta(days=30)
                )
            )
            session.add_all([PositionSnapshot(**row) for row in rows])

    async def upsert_daily_pnl(
        self,
        trade_date: datetime,
        environment: str,
        starting_equity: float,
        ending_equity: float,
        realized_pnl: float,
        unrealized_pnl: float,
        trades_closed: int = 0,
        wins: int = 0,
        losses: int = 0,
        commission: float = 0.0,
    ) -> None:
        async with self.db.session() as session:
            existing = await session.scalar(
                select(DailyPnL).where(
                    func.date(DailyPnL.trade_date) == func.date(trade_date),
                    DailyPnL.environment == environment,
                )
            )
            if existing is None:
                session.add(
                    DailyPnL(
                        trade_date=trade_date,
                        environment=environment,
                        starting_equity=starting_equity,
                        ending_equity=ending_equity,
                        realized_pnl=realized_pnl,
                        unrealized_pnl=unrealized_pnl,
                        trades_closed=trades_closed,
                        wins=wins,
                        losses=losses,
                        commission=commission,
                    )
                )
            else:
                existing.ending_equity = ending_equity
                existing.realized_pnl = realized_pnl
                existing.unrealized_pnl = unrealized_pnl
                existing.trades_closed = trades_closed
                existing.wins = wins
                existing.losses = losses
                existing.commission = commission

    async def daily_pnl_history(self, days: int = 90, environment: str | None = None) -> list[DailyPnL]:
        query = select(DailyPnL).order_by(DailyPnL.trade_date.desc()).limit(days)
        if environment:
            query = query.where(DailyPnL.environment == environment)
        async with self.db.session() as session:
            return list(reversed(list((await session.scalars(query)).all())))

    # ------------------------------------------------------------------ #
    # execution quality / strategy performance
    # ------------------------------------------------------------------ #
    async def record_execution_quality(self, **fields: Any) -> None:
        async with self.db.session() as session:
            session.add(ExecutionQuality(**fields))

    async def execution_quality(self, limit: int = 100) -> list[ExecutionQuality]:
        async with self.db.session() as session:
            return list(
                (
                    await session.scalars(
                        select(ExecutionQuality)
                        .order_by(ExecutionQuality.recorded_at.desc())
                        .limit(limit)
                    )
                ).all()
            )

    async def upsert_strategy_performance(self, strategy: str, regime: str, **stats: Any) -> None:
        async with self.db.session() as session:
            record = await session.scalar(
                select(StrategyPerformance).where(
                    StrategyPerformance.strategy == strategy, StrategyPerformance.regime == regime
                )
            )
            if record is None:
                record = StrategyPerformance(strategy=strategy, regime=regime)
                session.add(record)
            for key, value in stats.items():
                setattr(record, key, value)
            record.updated_at = utc_now()

    async def strategy_performance(self) -> list[StrategyPerformance]:
        async with self.db.session() as session:
            return list((await session.scalars(select(StrategyPerformance))).all())

    async def risk_events(self, limit: int = 50) -> list[RiskEvent]:
        async with self.db.session() as session:
            return list(
                (
                    await session.scalars(
                        select(RiskEvent).order_by(RiskEvent.occurred_at.desc()).limit(limit)
                    )
                ).all()
            )

    async def system_events(self, limit: int = 50) -> list[SystemEvent]:
        async with self.db.session() as session:
            return list(
                (
                    await session.scalars(
                        select(SystemEvent).order_by(SystemEvent.occurred_at.desc()).limit(limit)
                    )
                ).all()
            )

    async def recent_opportunities(self, limit: int = 50) -> list[OpportunityRecord]:
        async with self.db.session() as session:
            return list(
                (
                    await session.scalars(
                        select(OpportunityRecord)
                        .order_by(OpportunityRecord.generated_at.desc())
                        .limit(limit)
                    )
                ).all()
            )

    # ------------------------------------------------------------------ #
    # aggregate statistics (live gate, dashboards, adaptation)
    # ------------------------------------------------------------------ #
    async def trading_statistics(self, environment: str = "PAPER") -> dict[str, Any]:
        trades = await self.closed_trades(environment=environment)
        snapshots = await self.portfolio_snapshots(limit=2000)
        wins = [t for t in trades if (t.realized_pnl or 0) > 0]
        losses = [t for t in trades if (t.realized_pnl or 0) < 0]
        gross_profit = sum(t.realized_pnl or 0.0 for t in wins)
        gross_loss = abs(sum(t.realized_pnl or 0.0 for t in losses))
        r_multiples = [t.r_multiple for t in trades if t.r_multiple is not None]
        first_trade = min((t.opened_at for t in trades), default=None)

        equity_curve = [s.equity for s in snapshots if s.equity]
        max_dd = 0.0
        peak = 0.0
        for equity in equity_curve:
            peak = max(peak, equity)
            if peak > 0:
                max_dd = max(max_dd, (peak - equity) / peak)

        daily = await self.daily_pnl_history(days=365, environment=environment)
        daily_returns = [
            (d.ending_equity - d.starting_equity) / d.starting_equity
            for d in daily
            if d.starting_equity
        ]
        sharpe = 0.0
        if len(daily_returns) > 2:
            mean = sum(daily_returns) / len(daily_returns)
            variance = sum((r - mean) ** 2 for r in daily_returns) / (len(daily_returns) - 1)
            std = variance**0.5
            sharpe = (mean / std) * (252**0.5) if std > 0 else 0.0

        days_live = (utc_now() - first_trade).days if first_trade else 0
        return {
            "environment": environment,
            "trades": len(trades),
            "wins": len(wins),
            "losses": len(losses),
            "win_rate": len(wins) / len(trades) if trades else 0.0,
            "gross_profit": gross_profit,
            "gross_loss": gross_loss,
            "profit_factor": (gross_profit / gross_loss) if gross_loss > 0 else (
                float("inf") if gross_profit > 0 else 0.0
            ),
            "expectancy_r": (sum(r_multiples) / len(r_multiples)) if r_multiples else 0.0,
            "net_pnl": gross_profit - gross_loss,
            "max_drawdown": max_dd,
            "sharpe": sharpe,
            "days_operating": days_live,
            "first_trade_at": first_trade.isoformat() if first_trade else None,
            "snapshots": len(snapshots),
        }

    async def strategy_statistics(self, lookback_trades: int = 100) -> dict[str, dict[str, Any]]:
        """Per-strategy expectancy from the recorded trade attribution."""
        trades = await self.closed_trades(limit=lookback_trades)
        out: dict[str, dict[str, Any]] = {}
        for trade in trades:
            contributions = (trade.strategy_scores or {}).get("contributions", [])
            for contribution in contributions:
                name = contribution.get("strategy")
                weight = float(contribution.get("effective_weight", 0.0))
                if not name or weight <= 0:
                    continue
                stats = out.setdefault(
                    name,
                    {"trades": 0, "wins": 0, "losses": 0, "r_sum": 0.0, "gross_profit": 0.0, "gross_loss": 0.0},
                )
                pnl = trade.realized_pnl or 0.0
                stats["trades"] += 1
                stats["r_sum"] += trade.r_multiple or 0.0
                if pnl > 0:
                    stats["wins"] += 1
                    stats["gross_profit"] += pnl
                elif pnl < 0:
                    stats["losses"] += 1
                    stats["gross_loss"] += abs(pnl)
        for stats in out.values():
            stats["expectancy_r"] = stats["r_sum"] / stats["trades"] if stats["trades"] else 0.0
            stats["profit_factor"] = (
                stats["gross_profit"] / stats["gross_loss"] if stats["gross_loss"] > 0 else 0.0
            )
            stats["win_rate"] = stats["wins"] / stats["trades"] if stats["trades"] else 0.0
        return out

    async def today_pnl_inputs(self, environment: str = "PAPER") -> dict[str, Any]:
        today = local_trading_date()
        trades = await self.closed_trades(environment=environment)
        todays = [t for t in trades if t.closed_at and t.closed_at.date() == today]
        return {
            "trades_closed": len(todays),
            "wins": len([t for t in todays if (t.realized_pnl or 0) > 0]),
            "losses": len([t for t in todays if (t.realized_pnl or 0) < 0]),
            "realized_pnl": sum(t.realized_pnl or 0.0 for t in todays),
            "commission": sum(t.commission or 0.0 for t in todays),
        }
