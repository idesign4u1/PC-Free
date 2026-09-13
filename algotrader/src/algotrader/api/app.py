"""FastAPI application factory."""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI

from ..config import AppConfig, Settings, get_settings, load_config
from ..logging_setup import configure_logging, get_logger
from ..trading.loop import TradingSystem
from .routes import router

log = get_logger(__name__)


def create_app(
    system: TradingSystem | None = None,
    run_trading_loop: bool | None = None,
    config: AppConfig | None = None,
    settings: Settings | None = None,
) -> FastAPI:
    """Build the API.

    ``run_trading_loop`` (or ``ALGOTRADER_RUN_LOOP=true``) also starts the
    trading loop inside this process. It defaults to off, so serving the
    dashboard never starts trading by accident.
    """
    settings = settings or (system.settings if system else get_settings())
    if run_trading_loop is None:
        run_trading_loop = os.getenv("ALGOTRADER_RUN_LOOP", "false").lower() in ("1", "true", "yes")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        configure_logging(settings.log_level, settings.log_json)
        trading = system or await TradingSystem.create(
            config or load_config(settings.config_path), settings
        )
        app.state.system = trading
        app.state.settings = settings
        if system is None:
            await trading.startup()
        task: asyncio.Task | None = None
        if run_trading_loop:
            log.info("starting_trading_loop_in_api_process")
            task = asyncio.create_task(trading.run_forever())
        try:
            yield
        finally:
            trading.running = False
            if task is not None:
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):  # noqa: BLE001 - shutdown path
                    pass
            if system is None:
                await trading.shutdown()

    app = FastAPI(
        title="algotrader",
        version="0.1.0",
        summary="Risk-first autonomous trading platform (Tradier)",
        lifespan=lifespan,
    )
    app.state.settings = settings
    if system is not None:
        # An already-started system is attached immediately so the app can also be
        # mounted without running the lifespan (tests, embedding in another app).
        app.state.system = system
    app.include_router(router)
    return app


app_factory = create_app
