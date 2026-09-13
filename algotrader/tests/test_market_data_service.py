"""Market data validation: bad data must be rejected, not tolerated."""

from __future__ import annotations

from datetime import timedelta

import pytest

from algotrader.broker.base import Quote
from algotrader.market_data.series import BarSeries
from algotrader.market_data.service import MarketDataService
from algotrader.utils.timeutils import utc_now
from tests.conftest import make_bars, make_quote


class _StubBroker:
    def __init__(self, quotes=None, bars=None, fail_history=False):
        self._quotes = quotes or {}
        self._bars = bars or {}
        self.fail_history = fail_history
        self.quote_calls = 0

    async def get_quotes(self, symbols):
        self.quote_calls += 1
        return {s: self._quotes[s] for s in symbols if s in self._quotes}

    async def get_history(self, symbol, start, end, interval="daily"):
        if self.fail_history:
            raise RuntimeError("history unavailable")
        return self._bars.get(symbol, [])


def make_service(config, broker):
    return MarketDataService(broker, config.market_data, config.risk)


async def test_good_data_passes(config):
    bars = make_bars("AAPL", [100 + i * 0.1 for i in range(200)])
    broker = _StubBroker({"AAPL": make_quote("AAPL", 120.0)}, {"AAPL": bars})
    snap = await make_service(config, broker).snapshot(["AAPL"])
    assert snap.quality["AAPL"].ok, snap.quality["AAPL"].issues
    assert snap.tradable_symbols() == ["AAPL"]


async def test_wide_spread_is_rejected(config):
    broker = _StubBroker(
        {"AAPL": make_quote("AAPL", 120.0, spread_bps=400.0)},
        {"AAPL": make_bars("AAPL", [100.0] * 200)},
    )
    snap = await make_service(config, broker).snapshot(["AAPL"])
    assert not snap.quality["AAPL"].ok
    assert any("spread" in issue for issue in snap.quality["AAPL"].issues)


async def test_stale_quote_is_rejected(config):
    stale = Quote(
        symbol="AAPL",
        bid=99.9,
        ask=100.1,
        last=100.0,
        timestamp=utc_now() - timedelta(hours=3),
        volume=10_000_000,
    )
    broker = _StubBroker({"AAPL": stale}, {"AAPL": make_bars("AAPL", [100.0] * 200)})
    snap = await make_service(config, broker).snapshot(["AAPL"])
    assert any("stale quote" in issue for issue in snap.quality["AAPL"].issues)


async def test_crossed_market_is_rejected(config):
    crossed = Quote(symbol="AAPL", bid=101.0, ask=100.0, last=100.5, volume=10_000_000)
    broker = _StubBroker({"AAPL": crossed}, {"AAPL": make_bars("AAPL", [100.0] * 200)})
    snap = await make_service(config, broker).snapshot(["AAPL"])
    assert any("crossed" in issue for issue in snap.quality["AAPL"].issues)


async def test_illiquid_symbol_is_rejected(config):
    bars = make_bars("TINY", [10.0] * 200, volume=1_000.0)
    broker = _StubBroker({"TINY": make_quote("TINY", 10.0)}, {"TINY": bars})
    snap = await make_service(config, broker).snapshot(["TINY"])
    assert any("illiquid" in issue for issue in snap.quality["TINY"].issues)


async def test_insufficient_history_is_rejected(config):
    broker = _StubBroker({"AAPL": make_quote("AAPL", 100.0)}, {"AAPL": make_bars("AAPL", [100.0] * 30)})
    snap = await make_service(config, broker).snapshot(["AAPL"])
    assert any("insufficient history" in issue for issue in snap.quality["AAPL"].issues)


async def test_broker_failure_is_captured_not_raised(config):
    broker = _StubBroker({"AAPL": make_quote("AAPL", 100.0)}, fail_history=True)
    snap = await make_service(config, broker).snapshot(["AAPL"])
    assert snap.errors and not snap.quality["AAPL"].ok


async def test_quote_cache_limits_broker_calls(config):
    broker = _StubBroker({"AAPL": make_quote("AAPL", 100.0)}, {"AAPL": make_bars("AAPL", [100.0] * 200)})
    service = make_service(config, broker)
    await service.get_quotes(["AAPL"])
    await service.get_quotes(["AAPL"])
    assert broker.quote_calls == 1


def test_series_slice_until_has_no_future_bars():
    bars = make_bars("AAPL", [float(i) for i in range(50)])
    series = BarSeries.from_bars("AAPL", bars)
    sliced = series.slice_until(9)
    assert len(sliced) == 10
    assert sliced.last_close == pytest.approx(9.0)
