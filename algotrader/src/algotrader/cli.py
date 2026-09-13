"""Command line interface.

    algotrader check          validate configuration and broker connectivity
    algotrader init-db        create the database schema
    algotrader paper          run the trading loop (paper by default) + API
    algotrader trade          run the trading loop only
    algotrader api            serve the dashboard/API only (never trades)
    algotrader backtest       run a backtest or a walk-forward analysis
    algotrader live-gate      report on readiness for live trading

Nothing here can enable live trading: that needs configuration changes plus an
environment flag plus a restart.
"""

from __future__ import annotations

import asyncio
import json
from datetime import timedelta
from typing import Optional

import typer

from .config import BrokerEnvironment, SystemMode, get_settings, load_config
from .logging_setup import configure_logging, get_logger
from .utils.timeutils import utc_now

app = typer.Typer(add_completion=False, help="Risk-first autonomous trading platform (Tradier).")
log = get_logger(__name__)


def _echo(payload: object) -> None:
    typer.echo(json.dumps(payload, indent=2, default=str))


@app.command()
def check(config_path: Optional[str] = typer.Option(None, "--config")) -> None:
    """Validate configuration, credentials and broker connectivity. Sends no orders."""

    async def run() -> None:
        settings = get_settings()
        config = load_config(config_path or settings.config_path)
        configure_logging(settings.log_level, json_output=False)
        environment = config.resolve_broker_environment(settings)
        mode = config.effective_mode(settings)
        report = {
            "config_path": config_path or settings.config_path,
            "config_hash": config.config_hash(),
            "configured_mode": str(config.system.mode),
            "effective_mode": str(mode),
            "broker_environment": str(environment),
            "live_trading_enabled": environment is BrokerEnvironment.LIVE,
            "paper_credentials_present": settings.has_credentials(BrokerEnvironment.PAPER),
            "live_credentials_present": settings.has_credentials(BrokerEnvironment.LIVE),
            "universe_size": len(config.universe.symbols),
            "database": settings.database_url.split("://", 1)[0],
        }
        if not settings.has_credentials(environment):
            report["broker_connectivity"] = "skipped: credentials are not configured"
            _echo(report)
            raise typer.Exit(code=1)

        from .broker.tradier import build_tradier_broker

        broker = build_tradier_broker(settings, environment)
        try:
            report["broker_connectivity"] = "ok" if await broker.health_check() else "failed"
            clock = await broker.get_clock()
            report["market_state"] = clock.state
            balances = await broker.get_balances()
            report["account_equity"] = balances.total_equity
            report["buying_power"] = balances.buying_power
        except Exception as exc:  # surfaced to the operator, not swallowed
            report["broker_connectivity"] = f"failed: {exc!s}"
        finally:
            await broker.close()
        _echo(report)

    asyncio.run(run())


@app.command("init-db")
def init_db() -> None:
    """Create the database schema."""

    async def run() -> None:
        from .database.base import Database

        settings = get_settings()
        configure_logging(settings.log_level, json_output=False)
        database = Database(settings.database_url)
        await database.create_all()
        await database.close()
        typer.echo("database schema created")

    asyncio.run(run())


def _serve(run_loop: bool, host: str, port: int, config_path: str | None) -> None:
    import uvicorn

    from .api.app import create_app

    settings = get_settings()
    config = load_config(config_path or settings.config_path)
    environment = config.resolve_broker_environment(settings)
    if environment is BrokerEnvironment.LIVE:
        typer.secho(
            "LIVE TRADING IS ENABLED - real money orders will be sent.", fg=typer.colors.RED, bold=True
        )
    else:
        typer.secho(
            f"PAPER mode ({config.effective_mode(settings)}): orders go to the Tradier sandbox.",
            fg=typer.colors.GREEN,
        )
    uvicorn.run(
        create_app(run_trading_loop=run_loop, config=config, settings=settings),
        host=host or settings.api_host,
        port=port or settings.api_port,
        log_config=None,
    )


@app.command()
def paper(
    host: str = typer.Option("", "--host"),
    port: int = typer.Option(0, "--port"),
    config_path: Optional[str] = typer.Option(None, "--config"),
) -> None:
    """Run the trading loop *and* the dashboard/API (paper unless live is explicitly enabled)."""
    _serve(run_loop=True, host=host, port=port, config_path=config_path)


@app.command()
def api(
    host: str = typer.Option("", "--host"),
    port: int = typer.Option(0, "--port"),
    config_path: Optional[str] = typer.Option(None, "--config"),
) -> None:
    """Serve the dashboard/API only. The trading loop stays stopped."""
    _serve(run_loop=False, host=host, port=port, config_path=config_path)


@app.command()
def trade(
    cycles: Optional[int] = typer.Option(None, "--cycles", help="stop after N cycles"),
    config_path: Optional[str] = typer.Option(None, "--config"),
) -> None:
    """Run the trading loop without the API."""

    async def run() -> None:
        from .trading.loop import TradingSystem

        settings = get_settings()
        config = load_config(config_path or settings.config_path)
        system = await TradingSystem.create(config, settings)
        await system.startup()
        typer.echo(f"running: mode={system.mode} environment={system.environment}")
        try:
            await system.run_forever(max_cycles=cycles)
        finally:
            await system.shutdown()

    asyncio.run(run())


@app.command()
def backtest(
    symbols: Optional[str] = typer.Option(None, "--symbols", help="comma separated; default: universe"),
    days: int = typer.Option(750, "--days"),
    walk_forward_test: bool = typer.Option(False, "--walk-forward"),
    train_days: int = typer.Option(365, "--train-days"),
    test_days: int = typer.Option(90, "--test-days"),
    output: Optional[str] = typer.Option(None, "--output", help="write the full result to this file"),
    config_path: Optional[str] = typer.Option(None, "--config"),
) -> None:
    """Backtest the live strategy and risk rules on Tradier history."""

    async def run() -> None:
        from .backtest.engine import BacktestEngine
        from .backtest.walkforward import walk_forward
        from .broker.tradier import build_tradier_broker

        settings = get_settings()
        config = load_config(config_path or settings.config_path)
        configure_logging("WARNING", json_output=False)
        environment = config.resolve_broker_environment(settings)
        chosen = [s.strip().upper() for s in symbols.split(",")] if symbols else list(
            config.universe.symbols
        )
        benchmark = config.universe.benchmark.upper()
        broker = build_tradier_broker(settings, environment)
        end = utc_now()
        start = end - timedelta(days=days)
        bars = {}
        try:
            for symbol in sorted(set(chosen) | {benchmark}):
                bars[symbol] = await broker.get_history(symbol, start, end, "daily")
                typer.echo(f"fetched {len(bars[symbol]):>5} bars for {symbol}", err=True)
        finally:
            await broker.close()

        universe = config.universe.model_copy(update={"symbols": chosen})
        config = config.model_copy(update={"universe": universe})
        if walk_forward_test:
            result = walk_forward(config, bars, benchmark, train_days, test_days).to_dict()
        else:
            result = BacktestEngine(config, bars, benchmark=benchmark).run().to_dict(
                include_trades=bool(output)
            )
        if output:
            with open(output, "w", encoding="utf-8") as handle:
                json.dump(result, handle, indent=2, default=str)
            typer.echo(f"full result written to {output}", err=True)
            result.pop("trades", None)
            result.pop("equity_curve", None)
        else:
            result.pop("equity_curve", None)
        _echo(result)

    asyncio.run(run())


@app.command("live-gate")
def live_gate(config_path: Optional[str] = typer.Option(None, "--config")) -> None:
    """Report whether the paper record justifies enabling live trading."""

    async def run() -> None:
        from .database.base import Database
        from .database.repository import Repository
        from .risk.live_gate import evaluate_live_gate

        settings = get_settings()
        config = load_config(config_path or settings.config_path)
        configure_logging("WARNING", json_output=False)
        database = Database(settings.database_url)
        await database.create_all()
        repo = Repository(database)
        statistics = await repo.trading_statistics(str(BrokerEnvironment.PAPER))
        await database.close()
        report = evaluate_live_gate(config, settings, statistics)
        _echo({"statistics": statistics} | report.to_dict())

    asyncio.run(run())


@app.command()
def config_dump(config_path: Optional[str] = typer.Option(None, "--config")) -> None:
    """Print the effective configuration (secrets redacted)."""
    settings = get_settings()
    config = load_config(config_path or settings.config_path)
    _echo(
        {
            "config_hash": config.config_hash(),
            "effective_mode": str(config.effective_mode(settings)),
            "broker_environment": str(config.resolve_broker_environment(settings)),
            "config": config.model_dump(mode="json"),
            "settings": settings.safe_dump(),
        }
    )


def main() -> None:
    app()


if __name__ == "__main__":
    main()
