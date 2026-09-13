"""Shared pytest fixtures."""

from __future__ import annotations

import os
import sys
from datetime import timedelta
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "src"))

# Tests must never pick up a developer's real .env file.
os.environ.setdefault("ALGOTRADER_ENV_FILE", str(PROJECT_ROOT / "tests" / "nonexistent.env"))
os.environ["TRADIER_PAPER_TOKEN"] = "test-paper-token"
os.environ["TRADIER_PAPER_ACCOUNT_ID"] = "TEST123"
os.environ["ENABLE_LIVE_TRADING"] = "false"
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["API_TOKEN"] = "test-api-token"

from algotrader.broker.base import Bar, Quote  # noqa: E402
from algotrader.config import load_config, reset_caches  # noqa: E402
from algotrader.utils.timeutils import utc_now  # noqa: E402


@pytest.fixture(scope="session")
def config_path() -> Path:
    return PROJECT_ROOT / "config" / "config.yaml"


@pytest.fixture()
def config(config_path: Path):
    reset_caches()
    return load_config(config_path)


@pytest.fixture()
def settings():
    reset_caches()
    from algotrader.config import get_settings

    return get_settings()


def make_bars(
    symbol: str,
    closes: list[float],
    *,
    volume: float = 5_000_000.0,
    start_days_ago: int | None = None,
    high_mult: float = 1.01,
    low_mult: float = 0.99,
) -> list[Bar]:
    """Build a daily bar series ending today from a list of closes."""
    n = len(closes)
    start = start_days_ago if start_days_ago is not None else n
    base = utc_now() - timedelta(days=start)
    bars: list[Bar] = []
    previous = closes[0]
    for i, close in enumerate(closes):
        high = max(close, previous) * high_mult
        low = min(close, previous) * low_mult
        bars.append(
            Bar(
                symbol=symbol,
                timestamp=base + timedelta(days=i),
                open=previous,
                high=high,
                low=low,
                close=close,
                volume=volume,
            )
        )
        previous = close
    return bars


def make_quote(symbol: str, price: float, spread_bps: float = 5.0, volume: int = 5_000_000) -> Quote:
    half = price * (spread_bps / 10_000.0) / 2.0
    return Quote(
        symbol=symbol,
        bid=round(price - half, 4),
        ask=round(price + half, 4),
        last=price,
        bid_size=500,
        ask_size=500,
        volume=volume,
        average_volume=volume,
        timestamp=utc_now(),
    )


@pytest.fixture()
def bars_factory():
    return make_bars


@pytest.fixture()
def quote_factory():
    return make_quote
