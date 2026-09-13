"""HTTP API.

Read endpoints are open; every state-changing endpoint requires the API token
and is additionally constrained by the platform's own rules - in particular,
**no endpoint can switch the system to live trading**. That requires editing
configuration and restarting the process, by a human.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from ..backtest.engine import BacktestEngine
from ..backtest.walkforward import walk_forward
from ..enums import ExitReason, KillSwitchReason, SystemMode
from ..monitoring.execution_quality import build_execution_quality_report
from ..risk.live_gate import evaluate_live_gate
from ..trading.loop import TradingSystem
from ..utils.timeutils import utc_now
from .dashboard import DASHBOARD_HTML
from .security import require_api_token

router = APIRouter()


def system_of(request: Request) -> TradingSystem:
    system: TradingSystem | None = getattr(request.app.state, "system", None)
    if system is None:
        raise HTTPException(status_code=503, detail="trading system is not initialised")
    return system


# --------------------------------------------------------------------------- #
# dashboard + health
# --------------------------------------------------------------------------- #
@router.get("/", response_class=HTMLResponse, include_in_schema=False)
async def dashboard() -> HTMLResponse:
    return HTMLResponse(DASHBOARD_HTML)


@router.get("/health")
async def health(request: Request) -> dict[str, Any]:
    system = system_of(request)
    report = await system.health.check()
    return {
        "status": "ok" if report.healthy else "degraded",
        "mode": str(system.mode),
        "environment": str(system.environment),
        "kill_switch_tripped": system.risk.kill_switch.is_tripped,
        "components": report.to_dict()["components"],
        "checked_at": report.checked_at.isoformat(),
    }


# --------------------------------------------------------------------------- #
# read endpoints
# --------------------------------------------------------------------------- #
@router.get("/api/status")
async def status(request: Request) -> dict[str, Any]:
    return system_of(request).status()


@router.get("/api/portfolio")
async def portfolio(request: Request) -> dict[str, Any]:
    system = system_of(request)
    return {
        "portfolio": system.portfolio.state.to_dict(),
        "positions": [p.to_dict() for p in system.portfolio.state.positions.values()],
        "risk": system.risk.risk_utilisation(system.portfolio.state),
    }


@router.get("/api/positions")
async def positions(request: Request) -> dict[str, Any]:
    system = system_of(request)
    return {"positions": [p.to_dict() for p in system.portfolio.state.positions.values()]}


@router.get("/api/orders")
async def orders(request: Request, limit: int = Query(50, ge=1, le=500)) -> dict[str, Any]:
    system = system_of(request)
    records = await system.repo.recent_orders(limit)
    return {
        "orders": [
            {
                "client_order_id": r.client_order_id,
                "broker_order_id": r.broker_order_id,
                "symbol": r.symbol,
                "side": r.side,
                "quantity": r.quantity,
                "order_type": r.order_type,
                "status": r.status,
                "filled_quantity": r.filled_quantity,
                "average_fill_price": r.average_fill_price,
                "expected_price": r.expected_price,
                "intent": r.intent,
                "environment": r.environment,
                "error": r.error,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in records
        ]
    }


@router.get("/api/trades")
async def trades(request: Request, limit: int = Query(20, ge=1, le=500)) -> dict[str, Any]:
    system = system_of(request)
    records = await system.repo.recent_trades(limit)
    return {
        "trades": [
            {
                "id": t.id,
                "symbol": t.symbol,
                "direction": t.direction,
                "status": t.status,
                "quantity": t.quantity,
                "entry_price": t.entry_price,
                "exit_price": t.exit_price,
                "stop_price": t.stop_price,
                "take_profit_price": t.take_profit_price,
                "realized_pnl": t.realized_pnl,
                "r_multiple": t.r_multiple,
                "exit_reason": t.exit_reason,
                "regime_at_entry": t.regime_at_entry,
                "opened_at": t.opened_at.isoformat() if t.opened_at else None,
                "closed_at": t.closed_at.isoformat() if t.closed_at else None,
            }
            for t in records
        ]
    }


@router.get("/api/trades/{trade_id}")
async def trade_detail(request: Request, trade_id: int) -> dict[str, Any]:
    """The complete audit trail for one trade: why in, why that size, why out."""
    system = system_of(request)
    for trade in await system.repo.recent_trades(500):
        if trade.id == trade_id:
            return {
                "symbol": trade.symbol,
                "status": trade.status,
                "quantity": trade.quantity,
                "entry_price": trade.entry_price,
                "exit_price": trade.exit_price,
                "realized_pnl": trade.realized_pnl,
                "r_multiple": trade.r_multiple,
                "why_entered": trade.entry_reason,
                "why_this_size": trade.sizing_reason,
                "why_this_stop": trade.stop_reason,
                "why_exited": {"reason": trade.exit_reason, "detail": trade.exit_detail},
                "strategy_scores": trade.strategy_scores,
                "risk_state": trade.risk_state,
                "regime_at_entry": trade.regime_at_entry,
                "regime_at_exit": trade.regime_at_exit,
            }
    raise HTTPException(status_code=404, detail=f"trade {trade_id} not found")


@router.get("/api/pnl")
async def pnl(request: Request, days: int = Query(90, ge=1, le=730)) -> dict[str, Any]:
    system = system_of(request)
    history = await system.repo.daily_pnl_history(days, str(system.environment))
    state = system.portfolio.state
    return {
        "today": {
            "daily_pnl": round(state.daily_pnl, 2),
            "daily_pnl_pct": round(state.daily_pnl_pct, 4),
            "realized_pnl": round(state.realized_pnl_today, 2),
            "unrealized_pnl": round(state.unrealized_pnl, 2),
        },
        "high_water_mark": round(state.high_water_mark, 2),
        "drawdown": round(state.drawdown, 4),
        "history": [
            {
                "date": d.trade_date.isoformat(),
                "starting_equity": d.starting_equity,
                "ending_equity": d.ending_equity,
                "realized_pnl": d.realized_pnl,
                "unrealized_pnl": d.unrealized_pnl,
                "trades_closed": d.trades_closed,
                "wins": d.wins,
                "losses": d.losses,
            }
            for d in history
        ],
        "statistics": await system.repo.trading_statistics(str(system.environment)),
    }


@router.get("/api/risk")
async def risk(request: Request) -> dict[str, Any]:
    system = system_of(request)
    return {
        "utilisation": system.risk.risk_utilisation(system.portfolio.state),
        "limits": system.config.risk.model_dump(mode="json"),
        "kill_switch": system.risk.kill_switch.to_dict(),
        "recent_events": [
            {
                "occurred_at": e.occurred_at.isoformat(),
                "type": e.event_type,
                "severity": e.severity,
                "symbol": e.symbol,
                "detail": e.detail,
            }
            for e in await system.repo.risk_events(50)
        ],
    }


@router.get("/api/regime")
async def regime(request: Request) -> dict[str, Any]:
    system = system_of(request)
    return {
        "current": system.regime_state.to_dict() if system.regime_state else None,
        "weights": system.aggregator.effective_weights(
            system.regime_state.regime if system.regime_state else None
        )
        if system.regime_state
        else {},
    }


@router.get("/api/signals")
async def signals(request: Request) -> dict[str, Any]:
    system = system_of(request)
    return {
        "as_of": utc_now().isoformat(),
        "signals": [score.to_dict() for score in system.last_scores.values()],
    }


@router.get("/api/execution-quality")
async def execution_quality(request: Request) -> dict[str, Any]:
    """Expected vs actual fills - the paper-trading fidelity report."""
    system = system_of(request)
    report = await build_execution_quality_report(system.repo)
    return report.to_dict()


@router.get("/api/live-gate")
async def live_gate(request: Request) -> dict[str, Any]:
    system = system_of(request)
    statistics = await system.repo.trading_statistics(str(system.environment))
    health_report = system.health.last_report or await system.health.check()
    report = evaluate_live_gate(system.config, system.settings, statistics, health_report.healthy)
    return {"statistics": statistics} | report.to_dict()


@router.get("/api/events")
async def events(request: Request, limit: int = Query(50, ge=1, le=500)) -> dict[str, Any]:
    system = system_of(request)
    return {
        "system": [
            {
                "occurred_at": e.occurred_at.isoformat(),
                "level": e.level,
                "event": e.event,
                "detail": e.detail,
            }
            for e in await system.repo.system_events(limit)
        ],
        "alerts": system.alerts.recent(limit),
    }


@router.get("/api/config")
async def configuration(request: Request) -> dict[str, Any]:
    """Trading configuration and redacted deployment settings."""
    system = system_of(request)
    return {
        "config_hash": system.config.config_hash(),
        "config": system.config.model_dump(mode="json"),
        "settings": system.settings.safe_dump(),
        "effective_mode": str(system.mode),
        "effective_environment": str(system.environment),
    }


@router.get("/api/strategies")
async def strategies(request: Request) -> dict[str, Any]:
    system = system_of(request)
    performance = await system.repo.strategy_performance()
    return {
        "configured_weights": system.config.strategies.weights,
        "active_weights": system.aggregator.effective_weights(
            system.regime_state.regime if system.regime_state else None
        )
        if system.regime_state
        else system.config.strategies.weights,
        "performance": [
            {
                "strategy": p.strategy,
                "regime": p.regime,
                "trades": p.trades,
                "wins": p.wins,
                "losses": p.losses,
                "expectancy_r": p.expectancy_r,
                "profit_factor": p.profit_factor,
                "applied_weight": p.applied_weight,
            }
            for p in performance
        ],
    }


# --------------------------------------------------------------------------- #
# mutating endpoints (token required)
# --------------------------------------------------------------------------- #
class KillSwitchRequest(BaseModel):
    reason: str = Field(default="MANUAL")
    note: str = Field(default="", max_length=500)


class ModeRequest(BaseModel):
    mode: str


@router.post("/api/kill-switch/trip", dependencies=[Depends(require_api_token)])
async def trip_kill_switch(request: Request, body: KillSwitchRequest) -> dict[str, Any]:
    system = system_of(request)
    try:
        reason = KillSwitchReason(body.reason)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"unknown kill switch reason: {body.reason}")
    system.risk.kill_switch.trip(reason, body.note or "tripped via API")
    await system.repo.record_risk_event(
        "KILL_SWITCH_TRIPPED", f"{reason}: {body.note}", severity="critical"
    )
    return system.risk.kill_switch.to_dict()


@router.post("/api/kill-switch/clear", dependencies=[Depends(require_api_token)])
async def clear_kill_switch(request: Request, body: KillSwitchRequest) -> dict[str, Any]:
    system = system_of(request)
    if body.reason.upper() == "ALL":
        cleared = system.risk.kill_switch.clear_all(note=body.note or "cleared via API")
        detail = f"cleared {[str(c) for c in cleared]}"
    else:
        try:
            reason = KillSwitchReason(body.reason)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"unknown kill switch reason: {body.reason}")
        system.risk.kill_switch.clear(reason, note=body.note or "cleared via API")
        detail = f"cleared {reason}"
    await system.repo.record_risk_event("KILL_SWITCH_RESET", detail, severity="warning")
    return system.risk.kill_switch.to_dict()


@router.post("/api/mode", dependencies=[Depends(require_api_token)])
async def set_mode(request: Request, body: ModeRequest) -> dict[str, Any]:
    """Switch between SAFE / PAPER / EMERGENCY. LIVE is deliberately not reachable here."""
    system = system_of(request)
    try:
        mode = SystemMode(body.mode.upper())
    except ValueError:
        raise HTTPException(status_code=400, detail=f"unknown mode: {body.mode}")
    if mode is SystemMode.LIVE_MODE:
        raise HTTPException(
            status_code=403,
            detail=(
                "live trading cannot be enabled over the API: set system.mode: LIVE_MODE and "
                "live_gate.enabled: true in config.yaml, export ENABLE_LIVE_TRADING=true with "
                "live credentials, and restart"
            ),
        )
    system.mode = mode
    system.risk.mode = mode
    await system.repo.record_system_event("mode_changed", f"mode set to {mode} via API", level="warning")
    return {"mode": str(mode)}


@router.post("/api/trading/cycle", dependencies=[Depends(require_api_token)])
async def run_cycle(request: Request) -> dict[str, Any]:
    system = system_of(request)
    report = await system.run_cycle()
    return report.to_dict()


@router.post("/api/trading/flatten", dependencies=[Depends(require_api_token)])
async def flatten(request: Request) -> dict[str, Any]:
    """Emergency: cancel working orders and close every open position."""
    system = system_of(request)
    cancelled = await system.execution.cancel_all_working_orders("flatten requested via API")
    results = []
    quotes = await system.market_data.get_quotes(list(system.portfolio.state.positions), use_cache=False)
    for symbol, position in list(system.portfolio.state.positions.items()):
        quote = quotes.get(symbol)
        if quote is None:
            results.append({"symbol": symbol, "submitted": False, "message": "no quote available"})
            continue
        result = await system.execution.execute_exit(
            position, quote, ExitReason.MANUAL, "flatten requested via API"
        )
        results.append(result.to_dict())
    await system.repo.record_risk_event("EMERGENCY", "flatten requested via API", severity="critical")
    return {"cancelled_orders": cancelled, "exits": results}


class BacktestRequest(BaseModel):
    symbols: list[str] = Field(default_factory=list)
    days: int = Field(default=750, ge=120, le=3650)
    walk_forward: bool = False
    train_days: int = Field(default=365, ge=120, le=2000)
    test_days: int = Field(default=90, ge=20, le=730)
    include_trades: bool = True


@router.post("/api/backtest", dependencies=[Depends(require_api_token)])
async def run_backtest(request: Request, body: BacktestRequest) -> dict[str, Any]:
    """Backtest with history pulled from the broker, using the live risk rules."""
    system = system_of(request)
    symbols = [s.upper() for s in (body.symbols or system.config.universe.symbols)]
    benchmark = system.config.universe.benchmark.upper()
    wanted = sorted(set(symbols) | {benchmark})
    end = utc_now()
    start = end - timedelta(days=body.days)

    bars: dict[str, list] = {}
    for symbol in wanted:
        try:
            bars[symbol] = await system.broker.get_history(symbol, start, end, "daily")
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"history unavailable for {symbol}: {exc!s}")
    if not bars.get(benchmark):
        raise HTTPException(status_code=502, detail=f"no benchmark history for {benchmark}")

    universe = system.config.universe.model_copy(update={"symbols": symbols})
    config = system.config.model_copy(update={"universe": universe})

    if body.walk_forward:
        result = await asyncio.to_thread(
            walk_forward, config, bars, benchmark, body.train_days, body.test_days
        )
        return result.to_dict()
    engine = BacktestEngine(config, bars, benchmark=benchmark)
    result = await asyncio.to_thread(engine.run)
    return result.to_dict(include_trades=body.include_trades)
