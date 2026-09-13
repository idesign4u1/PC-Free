"""The trading system orchestrator.

One cycle runs the documented flow end to end:

    market data -> regime -> strategy ensemble -> signal scoring ->
    portfolio validation -> risk engine -> execution -> position monitoring ->
    performance learning

Position monitoring runs *before* new entries: protecting open capital always
comes before deploying more of it.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from ..broker.base import BrokerAdapter, BrokerError, MarketClock, Quote
from ..broker.tradier import build_tradier_broker
from ..config import AppConfig, Settings, get_settings, load_config
from ..database.base import Database
from ..database.repository import Repository
from ..enums import (
    BrokerEnvironment,
    ExitReason,
    KillSwitchReason,
    RiskEventType,
    SignalDirection,
    SystemMode,
)
from ..execution.engine import ExecutionEngine, ExecutionResult
from ..logging_setup import configure_logging, get_logger
from ..market_data.indicators import (
    atr as atr_indicator,
    average_dollar_volume,
    last_valid,
    realized_volatility,
    sma,
)
from ..market_data.series import BarSeries
from ..market_data.service import MarketDataService, MarketSnapshot
from ..monitoring.adaptation import StrategyAdapter
from ..monitoring.alerts import AlertManager, AlertSeverity
from ..monitoring.health import HealthMonitor
from ..portfolio.manager import PortfolioManager
from ..portfolio.models import Position
from ..regime.classifier import RegimeClassifier, RegimeState
from ..risk.engine import EntryProposal, RiskEngine
from ..risk.kill_switch import KillSwitch
from ..signals.scoring import OpportunityScore, SignalAggregator
from ..strategy import build_strategies
from ..strategy.base import StrategyContext
from ..utils.timeutils import MARKET_TZ, is_same_trading_day, to_utc, utc_now

log = get_logger(__name__)


@dataclass
class CycleReport:
    started_at: datetime
    finished_at: datetime | None = None
    market_open: bool = False
    traded: bool = False
    regime: str = ""
    symbols_evaluated: int = 0
    symbols_tradable: int = 0
    actionable: int = 0
    entries: list[dict[str, Any]] = field(default_factory=list)
    exits: list[dict[str, Any]] = field(default_factory=list)
    blocked: list[dict[str, Any]] = field(default_factory=list)
    order_updates: list[dict[str, Any]] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "started_at": self.started_at.isoformat(),
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
            "duration_seconds": (
                round((self.finished_at - self.started_at).total_seconds(), 3)
                if self.finished_at
                else None
            ),
            "market_open": self.market_open,
            "traded": self.traded,
            "regime": self.regime,
            "symbols_evaluated": self.symbols_evaluated,
            "symbols_tradable": self.symbols_tradable,
            "actionable": self.actionable,
            "entries": self.entries,
            "exits": self.exits,
            "blocked": self.blocked,
            "order_updates": self.order_updates,
            "errors": self.errors,
            "notes": self.notes,
        }


class TradingSystem:
    """Owns every component and runs the decision cycle."""

    def __init__(
        self,
        config: AppConfig,
        settings: Settings,
        broker: BrokerAdapter,
        database: Database,
        environment: BrokerEnvironment,
    ) -> None:
        self.config = config
        self.settings = settings
        self.broker = broker
        self.database = database
        self.environment = environment
        self.mode = config.effective_mode(settings)

        self.repo = Repository(database)
        self.market_data = MarketDataService(broker, config.market_data, config.risk)
        self.regime_classifier = RegimeClassifier(config.regime)
        self.strategies = build_strategies(config.strategies.params)
        self.aggregator = SignalAggregator(config.strategies, config.signals)
        self.portfolio = PortfolioManager(broker, config.universe)
        self.risk = RiskEngine(config, kill_switch=KillSwitch(), mode=self.mode)
        self.execution = ExecutionEngine(
            broker=broker,
            repository=self.repo,
            config=config,
            risk_engine=self.risk,
            environment=environment,
            account_id=getattr(broker, "account_id", ""),
        )
        self.alerts = AlertManager(repository=self.repo, webhook_url=settings.alert_webhook_url)
        self.health = HealthMonitor(broker, database, config.monitoring.heartbeat_timeout_seconds)
        self.adapter = StrategyAdapter(config.strategies, config.adaptation, self.repo)

        self.regime_state: RegimeState | None = None
        self.last_cycle: CycleReport | None = None
        self.last_scores: dict[str, OpportunityScore] = {}
        self.clock: MarketClock | None = None
        self.started_at: datetime | None = None
        self.running = False
        self._last_adaptation: datetime | None = None
        self._last_snapshot: datetime | None = None

    # ------------------------------------------------------------------ #
    # construction
    # ------------------------------------------------------------------ #
    @classmethod
    async def create(
        cls,
        config: AppConfig | None = None,
        settings: Settings | None = None,
        broker: BrokerAdapter | None = None,
        database: Database | None = None,
    ) -> "TradingSystem":
        settings = settings or get_settings()
        config = config or load_config(settings.config_path)
        environment = config.resolve_broker_environment(settings)
        if environment is BrokerEnvironment.LIVE:
            log.warning(
                "live_environment_selected",
                detail="LIVE trading is enabled: real money orders will be sent",
            )
        broker = broker or build_tradier_broker(settings, environment)
        database = database or Database(settings.database_url)
        return cls(config, settings, broker, database, environment)

    async def startup(self) -> None:
        configure_logging(self.settings.log_level, self.settings.log_json)
        await self.database.create_all()
        await self.repo.ensure_symbols(
            {symbol: self.config.universe.sector_of(symbol) for symbol in self.universe_symbols()}
        )
        await self.repo.record_config(
            self.config.config_hash(),
            self.config.model_dump(mode="json"),
            self.mode,
            self.environment,
            note="startup",
        )
        await self._restore_state()
        report = await self.health.check()
        if not report.healthy:
            for component in report.failures:
                if component.name == "broker":
                    self.risk.kill_switch.trip(KillSwitchReason.BROKER_UNAVAILABLE, component.detail)
            await self.alerts.send(
                "startup_health",
                f"degraded components at startup: {[c.name for c in report.failures]}",
                AlertSeverity.CRITICAL,
            )
        self.started_at = utc_now()
        await self.repo.record_system_event(
            "startup",
            f"mode={self.mode} environment={self.environment}",
            payload={"config_hash": self.config.config_hash(), "health": report.to_dict()},
        )
        log.info(
            "system_started",
            mode=str(self.mode),
            environment=str(self.environment),
            symbols=len(self.universe_symbols()),
        )

    async def _restore_state(self) -> None:
        """Rehydrate the high-water mark, daily anchors and open-trade metadata."""
        snapshot = await self.repo.latest_portfolio_snapshot()
        open_trades = await self.repo.open_trades()
        positions = [
            Position(
                symbol=trade.symbol,
                quantity=trade.quantity,
                average_price=trade.entry_price,
                opened_at=to_utc(trade.opened_at),
                current_price=trade.entry_price,
                strategy=trade.strategy,
                stop_price=trade.stop_price,
                take_profit_price=trade.take_profit_price,
                initial_stop_price=trade.stop_price,
                risk_per_share=trade.risk_per_share,
                entry_reason=trade.entry_reason or {},
                sizing_reason=trade.sizing_reason or {},
                stop_reason=trade.stop_reason or {},
                regime_at_entry=trade.regime_at_entry,
                opportunity_score=trade.opportunity_score,
                confidence_at_entry=trade.confidence,
                sector=self.config.universe.sector_of(trade.symbol),
                trade_id=trade.id,
            )
            for trade in open_trades
        ]
        if snapshot is not None:
            same_day = is_same_trading_day(to_utc(snapshot.captured_at), utc_now())
            self.portfolio.restore(
                high_water_mark=snapshot.high_water_mark,
                day_start_equity=snapshot.equity - snapshot.daily_pnl if same_day else 0.0,
                positions=positions,
            )
        else:
            self.portfolio.restore(positions=positions)
        if positions:
            log.info("restored_open_positions", count=len(positions))

    async def shutdown(self) -> None:
        self.running = False
        await self.repo.record_system_event("shutdown", "trading system stopped")
        try:
            await self.broker.close()
        finally:
            await self.database.close()

    # ------------------------------------------------------------------ #
    def universe_symbols(self) -> list[str]:
        symbols = list(self.config.universe.symbols)
        benchmark = self.config.universe.benchmark.upper()
        if benchmark not in symbols:
            symbols.append(benchmark)
        return symbols

    def session_window_ok(self, now: datetime | None = None) -> tuple[bool, str]:
        """Avoid the first and last minutes of the session."""
        now = (now or utc_now()).astimezone(MARKET_TZ)
        minutes_from_open = (now.hour - 9) * 60 + (now.minute - 30)
        minutes_to_close = (16 - now.hour) * 60 - now.minute
        if minutes_from_open < self.config.system.skip_first_minutes:
            return False, f"within the first {self.config.system.skip_first_minutes} minutes of the session"
        if minutes_to_close < self.config.system.skip_last_minutes:
            return False, f"within the last {self.config.system.skip_last_minutes} minutes of the session"
        return True, "inside the trading window"

    # ------------------------------------------------------------------ #
    # the cycle
    # ------------------------------------------------------------------ #
    async def run_cycle(self, now: datetime | None = None) -> CycleReport:
        now = now or utc_now()
        report = CycleReport(started_at=now)
        self.health.heartbeat(now)

        # --- health and connectivity ---------------------------------------
        health = await self.health.check()
        if not health.healthy:
            for component in health.failures:
                if component.name == "broker":
                    if self.risk.kill_switch.trip(KillSwitchReason.BROKER_UNAVAILABLE, component.detail):
                        await self.alerts.send(
                            "broker_unavailable", component.detail, AlertSeverity.CRITICAL
                        )
                report.errors.append(f"{component.name}: {component.detail}")
        elif KillSwitchReason.BROKER_UNAVAILABLE in self.risk.kill_switch.reasons:
            self.risk.kill_switch.clear(KillSwitchReason.BROKER_UNAVAILABLE, note="broker recovered")
            report.notes.append("broker connectivity restored; kill-switch reason cleared")

        # --- market clock ----------------------------------------------------
        try:
            self.clock = await self.broker.get_clock()
            report.market_open = self.clock.is_open
        except BrokerError as exc:
            report.errors.append(f"market clock unavailable: {exc!s}")
            report.market_open = False

        # --- market data ------------------------------------------------------
        symbols = self.universe_symbols()
        snapshot = await self.market_data.snapshot(symbols)
        report.symbols_evaluated = len(symbols)
        report.symbols_tradable = len(snapshot.tradable_symbols())
        report.errors.extend(snapshot.errors)
        if snapshot.errors:
            if self.risk.kill_switch.trip(
                KillSwitchReason.STALE_MARKET_DATA, "; ".join(snapshot.errors[:3])
            ):
                await self.alerts.send(
                    "market_data_degraded", "; ".join(snapshot.errors[:3]), AlertSeverity.CRITICAL
                )
        elif KillSwitchReason.STALE_MARKET_DATA in self.risk.kill_switch.reasons:
            self.risk.kill_switch.clear(KillSwitchReason.STALE_MARKET_DATA, note="market data recovered")

        # --- regime -------------------------------------------------------------
        benchmark_series = snapshot.series.get(self.config.universe.benchmark.upper())
        if benchmark_series is not None:
            self.regime_state = self.regime_classifier.classify(benchmark_series)
            report.regime = str(self.regime_state.regime)
            await self.repo.record_regime(self.regime_state.to_dict())
        if self.regime_state is None:
            report.errors.append("regime could not be determined; no new positions this cycle")

        # --- portfolio ----------------------------------------------------------
        try:
            state = await self.portfolio.refresh(snapshot.quotes)
        except BrokerError as exc:
            report.errors.append(f"portfolio refresh failed: {exc!s}")
            report.finished_at = utc_now()
            self.last_cycle = report
            return report

        await self._reconcile(report)

        for event in self.risk.assess_portfolio(state, now=now):
            report.notes.append(event.get("detail", ""))
            await self.repo.record_risk_event(
                RiskEventType.LIMIT_BREACH, event.get("detail", ""), severity="critical"
            )
            await self.alerts.send(
                f"risk_{event.get('type')}", event.get("detail", ""), AlertSeverity.CRITICAL
            )

        # --- position monitoring (before any new risk) ----------------------------
        await self._manage_positions(snapshot, report)

        # --- scoring and entries --------------------------------------------------
        scores = self._score_universe(snapshot)
        self.last_scores = scores
        report.actionable = sum(1 for score in scores.values() if score.actionable)
        for score in scores.values():
            await self.repo.record_opportunity(score.to_dict())

        tradable_window, window_note = self.session_window_ok(now)
        if not report.market_open and self.config.system.trade_only_when_market_open:
            report.notes.append("market closed: monitoring only")
        elif not tradable_window:
            report.notes.append(window_note)
        else:
            await self._open_positions(scores, snapshot, report, now)

        # --- order maintenance and bookkeeping --------------------------------------
        try:
            report.order_updates = await self.execution.sync_working_orders(now)
        except BrokerError as exc:
            report.errors.append(f"order sync failed: {exc!s}")

        await self._persist_cycle(snapshot, report, now)
        await self._maybe_adapt(now)

        report.traded = bool(report.entries or report.exits)
        report.finished_at = utc_now()
        self.last_cycle = report
        return report

    # ------------------------------------------------------------------ #
    async def _reconcile(self, report: CycleReport) -> None:
        try:
            reconciliation = await self.portfolio.reconcile()
        except BrokerError as exc:
            report.errors.append(f"reconciliation failed: {exc!s}")
            return
        if reconciliation.unexpected_positions or reconciliation.quantity_mismatches:
            detail = reconciliation.describe()
            if self.risk.kill_switch.trip(KillSwitchReason.UNEXPECTED_POSITIONS, detail):
                await self.repo.record_risk_event(
                    RiskEventType.RECONCILIATION, detail, severity="critical"
                )
                await self.alerts.send("unexpected_positions", detail, AlertSeverity.CRITICAL)
            report.errors.append(detail)

    async def _manage_positions(self, snapshot: MarketSnapshot, report: CycleReport) -> None:
        state = self.portfolio.state
        for symbol, position in list(state.positions.items()):
            quote = snapshot.quotes.get(symbol)
            series = snapshot.series.get(symbol)
            price = (quote.mid if quote else None) or position.current_price
            if not price:
                continue
            position.mark(price)

            atr_value = 0.0
            if series is not None and len(series) > self.config.risk.atr_period:
                atr_value = last_valid(
                    atr_indicator(series.highs, series.lows, series.closes, self.config.risk.atr_period)
                ) or 0.0

            # Trailing stop first: it can only ever tighten protection.
            new_stop = self.risk.trailing_stop_price(position, atr_value)
            if new_stop is not None:
                position.stop_price = new_stop
                tracked = self.portfolio.tracked(symbol)
                if tracked:
                    tracked.stop_price = new_stop
                report.notes.append(f"{symbol} trailing stop moved to {new_stop:.2f}")

            score = self.last_scores.get(symbol)
            reversed_signal = bool(
                score
                and score.direction is not SignalDirection.FLAT
                and (
                    (position.is_long and score.score < -self.config.signals.min_abs_score)
                    or (not position.is_long and score.score > self.config.signals.min_abs_score)
                )
            )
            decision = self.risk.evaluate_exit(
                position, price, atr_value, signal_reversed=reversed_signal
            )
            if not decision.should_exit:
                continue
            if quote is None:
                report.errors.append(f"{symbol} exit required but no quote is available")
                continue
            result = await self.execution.execute_exit(
                position,
                quote,
                decision.reason or ExitReason.MANUAL,
                decision.detail,
                regime=str(self.regime_state.regime) if self.regime_state else "",
                market_open=report.market_open,
            )
            report.exits.append(result.to_dict() | {"reason": str(decision.reason)})
            if result.filled:
                realized = float(result.detail.get("realized_pnl", 0.0))
                self.portfolio.register_close(symbol, realized)
                self.risk.record_trade_result(symbol, realized)
                await self.alerts.send(
                    f"exit_{symbol}",
                    f"closed {symbol}: {decision.reason} (P&L {realized:,.2f})",
                    AlertSeverity.INFO if realized >= 0 else AlertSeverity.WARNING,
                    symbol=symbol,
                    force=True,
                )

    def _score_universe(self, snapshot: MarketSnapshot) -> dict[str, OpportunityScore]:
        if self.regime_state is None:
            return {}
        benchmark_symbol = self.config.universe.benchmark.upper()
        benchmark = snapshot.series.get(benchmark_symbol)
        context = StrategyContext(regime=self.regime_state, benchmark=benchmark, as_of=snapshot.taken_at)
        scores: dict[str, OpportunityScore] = {}
        for symbol in self.config.universe.symbols:
            series = snapshot.series.get(symbol)
            if series is None or not snapshot.is_usable(symbol):
                continue
            signals = [
                signal
                for strategy in self.strategies
                if (signal := strategy.generate(series, context)) is not None
            ]
            if not signals:
                continue
            scores[symbol] = self.aggregator.score(symbol, signals, self.regime_state, snapshot.taken_at)
        return scores

    async def _open_positions(
        self,
        scores: dict[str, OpportunityScore],
        snapshot: MarketSnapshot,
        report: CycleReport,
        now: datetime,
    ) -> None:
        if self.regime_state is None:
            return
        state = self.portfolio.state
        opened = 0
        for score in self.aggregator.rank(scores.values()):
            if opened >= self.config.signals.max_new_positions_per_cycle:
                break
            symbol = score.symbol
            series = snapshot.series.get(symbol)
            quote = snapshot.quotes.get(symbol)
            if series is None or quote is None or quote.mid is None:
                continue

            correlated_pct, correlations = self.portfolio.correlated_exposure(
                symbol,
                snapshot.series,
                self.config.risk.correlation_threshold,
                self.config.risk.correlation_lookback,
            )
            quality = snapshot.quality.get(symbol)
            atr_value = last_valid(
                atr_indicator(series.highs, series.lows, series.closes, self.config.risk.atr_period)
            ) or 0.0
            proposal = EntryProposal(
                symbol=symbol,
                direction=score.direction,
                score=score.score,
                confidence=score.confidence,
                reference_price=quote.mid,
                atr=atr_value,
                annualised_volatility=last_valid(realized_volatility(series.closes, 20)) or 0.0,
                average_daily_volume=float(last_valid(sma(series.volumes, 20)) or 0.0),
                average_dollar_volume=average_dollar_volume(series.closes, series.volumes, 20),
                spread_bps=quote.spread_bps,
                data_quality_ok=bool(quality and quality.ok),
                data_quality_detail=quality.reason() if quality else "unknown",
                correlated_exposure_pct=correlated_pct,
                correlations=correlations,
                sector=self.config.universe.sector_of(symbol),
                strategy_contributions=[c.to_dict() for c in score.contributions],
                as_of=snapshot.taken_at,
            )
            decision = self.risk.evaluate_entry(proposal, state, self.regime_state, now=now)
            if not decision.approved:
                report.blocked.append(
                    {"symbol": symbol, "reasons": list(decision.rejection_reasons)[:4]}
                )
                continue

            result = await self.execution.execute_entry(
                decision,
                quote,
                state,
                regime=str(self.regime_state.regime),
                strategy_scores=score.to_dict(),
                market_open=report.market_open,
                now=now,
            )
            report.entries.append(result.to_dict())
            if result.filled and result.average_fill_price:
                position = Position(
                    symbol=symbol,
                    quantity=result.filled_quantity,
                    average_price=result.average_fill_price,
                    opened_at=now,
                    current_price=result.average_fill_price,
                    strategy="ensemble",
                    stop_price=decision.stop_price,
                    take_profit_price=decision.take_profit_price,
                    initial_stop_price=decision.stop_price,
                    risk_per_share=abs(result.average_fill_price - (decision.stop_price or 0.0)),
                    entry_reason=score.to_dict(),
                    sizing_reason=decision.sizing.to_dict() if decision.sizing else {},
                    stop_reason=decision.audit(),
                    regime_at_entry=str(self.regime_state.regime),
                    opportunity_score=score.score,
                    confidence_at_entry=score.confidence,
                    sector=self.config.universe.sector_of(symbol),
                    trade_id=result.trade_id,
                )
                self.portfolio.register_fill(position, decision.risk_amount)
                opened += 1
                await self.alerts.send(
                    f"entry_{symbol}",
                    (
                        f"opened {result.filled_quantity:g} {symbol} @ "
                        f"{result.average_fill_price:.2f}, stop {decision.stop_price:.2f}"
                    ),
                    AlertSeverity.INFO,
                    symbol=symbol,
                    force=True,
                )
            elif result.submitted:
                opened += 1

    # ------------------------------------------------------------------ #
    async def _persist_cycle(
        self, snapshot: MarketSnapshot, report: CycleReport, now: datetime
    ) -> None:
        state = self.portfolio.state
        interval = self.config.monitoring.snapshot_interval_seconds
        due = self._last_snapshot is None or (now - self._last_snapshot).total_seconds() >= interval
        if not due and not report.traded:
            return
        self._last_snapshot = now

        await self.repo.record_portfolio_snapshot(
            captured_at=now,
            equity=state.equity,
            cash=state.cash,
            buying_power=state.buying_power,
            gross_exposure=state.gross_exposure,
            exposure_pct=state.exposure_pct,
            open_positions=state.open_position_count,
            unrealized_pnl=state.unrealized_pnl,
            realized_pnl_today=state.realized_pnl_today,
            daily_pnl=state.daily_pnl,
            daily_pnl_pct=state.daily_pnl_pct,
            weekly_pnl_pct=state.weekly_pnl_pct,
            high_water_mark=state.high_water_mark,
            drawdown=state.drawdown,
            regime=report.regime,
            mode=str(self.mode),
            environment=str(self.environment),
            risk_utilisation=self.risk.risk_utilisation(state),
        )
        await self.repo.record_position_snapshots(
            [
                {
                    "captured_at": now,
                    "symbol": position.symbol,
                    "quantity": position.quantity,
                    "average_price": position.average_price,
                    "current_price": position.current_price,
                    "market_value": position.market_value,
                    "unrealized_pnl": position.unrealized_pnl,
                    "stop_price": position.stop_price,
                    "take_profit_price": position.take_profit_price,
                    "open_risk": position.open_risk,
                    "r_multiple": position.r_multiple,
                    "trade_id": position.trade_id,
                }
                for position in state.positions.values()
            ]
        )
        today = await self.repo.today_pnl_inputs(str(self.environment))
        await self.repo.upsert_daily_pnl(
            trade_date=now,
            environment=str(self.environment),
            starting_equity=state.day_start_equity,
            ending_equity=state.equity,
            realized_pnl=today["realized_pnl"],
            unrealized_pnl=state.unrealized_pnl,
            trades_closed=today["trades_closed"],
            wins=today["wins"],
            losses=today["losses"],
            commission=today["commission"],
        )
        await self.repo.record_market_observations(
            [
                {
                    "symbol": symbol,
                    "observation_type": "quote",
                    "observed_at": now,
                    "close": quote.mid,
                    "bid": quote.bid,
                    "ask": quote.ask,
                    "volume": quote.volume,
                    "spread_bps": quote.spread_bps,
                    "quality_ok": snapshot.is_usable(symbol),
                    "quality_issues": (
                        {"issues": list(snapshot.quality[symbol].issues)}
                        if symbol in snapshot.quality
                        else None
                    ),
                }
                for symbol, quote in snapshot.quotes.items()
            ]
        )
        # Alert thresholds
        if state.daily_pnl_pct <= -self.config.monitoring.alert_daily_loss_pct:
            await self.alerts.send(
                "daily_loss", f"daily P&L {state.daily_pnl_pct:.2%}", AlertSeverity.WARNING
            )
        if state.drawdown >= self.config.monitoring.alert_drawdown_pct:
            await self.alerts.send(
                "drawdown", f"drawdown {state.drawdown:.2%} from high-water mark", AlertSeverity.WARNING
            )

    async def _maybe_adapt(self, now: datetime) -> None:
        if not self.config.adaptation.enabled:
            return
        interval = self.config.adaptation.update_interval_hours * 3600
        if self._last_adaptation and (now - self._last_adaptation).total_seconds() < interval:
            return
        self._last_adaptation = now
        proposals = await self.adapter.propose_weights()
        if not proposals:
            return
        overrides = await self.adapter.apply(proposals)
        self.aggregator.set_weight_overrides(overrides)
        await self.repo.record_system_event(
            "strategy_weights_adapted",
            "bounded weight update applied",
            payload={"proposals": [p.to_dict() for p in proposals]},
        )

    # ------------------------------------------------------------------ #
    async def run_forever(self, max_cycles: int | None = None) -> None:
        self.running = True
        cycles = 0
        interval = self.config.system.loop_interval_seconds
        while self.running:
            cycle_started = utc_now()
            try:
                report = await self.run_cycle(cycle_started)
                log.info(
                    "cycle_complete",
                    regime=report.regime,
                    entries=len(report.entries),
                    exits=len(report.exits),
                    tradable=report.symbols_tradable,
                    errors=len(report.errors),
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # a bad cycle must not kill the process
                log.error("cycle_failed", error=str(exc), exc_info=True)
                await self.repo.record_system_event("cycle_failed", str(exc), level="error")
                await self.alerts.send("cycle_failed", f"trading cycle failed: {exc!s}", AlertSeverity.CRITICAL)
            cycles += 1
            if max_cycles is not None and cycles >= max_cycles:
                break
            elapsed = (utc_now() - cycle_started).total_seconds()
            await asyncio.sleep(max(1.0, interval - elapsed))
        self.running = False

    def status(self) -> dict[str, Any]:
        state = self.portfolio.state
        return {
            "mode": str(self.mode),
            "environment": str(self.environment),
            "broker": self.broker.name,
            "running": self.running,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "market": {
                "state": self.clock.state if self.clock else "unknown",
                "is_open": self.clock.is_open if self.clock else False,
            },
            "regime": self.regime_state.to_dict() if self.regime_state else None,
            "portfolio": state.to_dict(),
            "risk": self.risk.risk_utilisation(state),
            "last_cycle": self.last_cycle.to_dict() if self.last_cycle else None,
            "health": self.health.last_report.to_dict() if self.health.last_report else None,
            "config_hash": self.config.config_hash(),
        }
